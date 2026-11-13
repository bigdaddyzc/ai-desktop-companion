import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  emptyFileRoots,
  fileRootLimits,
  fileRootProblem,
  isNoWritePath,
  isSecretPath,
  normalizeFileRoots,
  normalizeRootPath,
  rootNameFor,
  type FileChange,
  type FileRoot,
  type FileRootsConfig,
  type FilesSnapshot,
  type FilesResult,
} from '../core/file-roots';
import {
  applyStage,
  assertNotCancelled,
  assertUnchanged,
  captureFile,
  discardStage,
  FileTransactionError,
  hashBytes,
  stageFile,
  type FileState,
  type StagedFile,
} from './file-transaction';
export type { FileChange, FilesSnapshot };

const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const changeSchema = z.object({
  id: z.string().max(80),
  at: z.number(),
  root: z.string().max(40),
  path: z.string().max(1024),
  action: z.enum(['created', 'modified', 'deleted']),
  tool: z.enum(['write_file', 'edit_file']),
  backup: z
    .string()
    .regex(/^[a-zA-Z0-9-]+\.bak$/)
    .nullable(),
  undone: z.boolean(),
  status: z.enum(['prepared', 'applied', 'conflict']).optional(),
  base: z.string().optional(),
  beforeHash: digest.optional(),
  afterHash: digest.optional(),
  beforeIdentity: z.string().nullable().optional(),
  afterIdentity: z.string().nullable().optional(),
  parents: z.array(z.object({ path: z.string(), identity: z.string() })).optional(),
  undoOf: z.string().optional(),
});
type StoredChange = z.infer<typeof changeSchema>;
export interface FileWrite {
  root: string;
  expected: FileState;
  after: Buffer | null;
  tool: 'write_file' | 'edit_file';
  revision: number;
}

/** fsync data before atomic rename; errors must reach the caller. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 1), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Serialized file transactions with a durable write-ahead journal. */
export class FileAccessService {
  private config: FileRootsConfig = emptyFileRoots();
  private changes: StoredChange[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  private grantRevision = 0;
  private journalError: string | null = null;
  private readonly listeners = new Set<(snapshot: FilesSnapshot) => void>();
  constructor(
    private readonly paths: { config: string; changes: string; backups: string },
    private readonly forbidden: { home: string; userData: string; appDir: string },
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    try {
      this.config = normalizeFileRoots(JSON.parse(await readFile(this.paths.config, 'utf8')));
    } catch {
      this.config = emptyFileRoots();
    }
    try {
      const raw = JSON.parse(await readFile(this.paths.changes, 'utf8')) as { changes?: unknown };
      const parsed = z.array(changeSchema).safeParse(raw.changes);
      if (!parsed.success) throw new Error('Invalid journal');
      this.changes = parsed.data.slice(0, fileRootLimits.changes + 1);
      this.journalError = null;
    } catch (error) {
      this.changes = [];
      this.journalError =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? null
          : '改动记录无法读取或已损坏，已禁止写入/撤销；请保留原记录并检查磁盘。';
    }
    // No target writes during recovery. Old/ambiguous records fail closed.
    const recovered: StoredChange[] = [];
    for (const change of this.changes) {
      if (!change.status) {
        recovered.push({ ...change, status: 'conflict' });
        continue;
      }
      if (change.status !== 'prepared') {
        recovered.push(change);
        continue;
      }
      try {
        const current = captureFile(change.base!, change.path);
        if (!this.sameParents(change, current)) throw new Error('parent changed');
        if (current.hash === change.afterHash && current.identity === change.afterIdentity)
          recovered.push({ ...change, status: 'applied' });
        else if (current.hash !== change.beforeHash || current.identity !== change.beforeIdentity)
          recovered.push({ ...change, status: 'conflict' });
        // Same before-state: the transaction never replaced the file; omit it
        // and drop its now-unreferenced backup.
        else if (change.backup)
          await rm(join(this.paths.backups, change.backup), { force: true }).catch(() => undefined);
      } catch {
        recovered.push({ ...change, status: 'conflict' });
      }
    }
    for (const change of recovered) {
      if (change.status === 'applied' && change.undoOf) {
        const original = recovered.find((item) => item.id === change.undoOf);
        if (original) original.undone = true;
      }
    }
    this.changes = recovered;
    // Recovery is deterministic from the durable journal; do not hide a load
    // failure by overwriting a broken/unreadable journal with an empty list.
  }
  roots(): readonly FileRoot[] {
    return this.config.roots.map((root) => ({ ...root }));
  }
  revision(): number {
    return this.grantRevision;
  }
  snapshot(): FilesSnapshot {
    return {
      error: this.journalError,
      roots: [...this.roots()],
      changes: this.changes.map(({ id, at, root, path, action, tool, backup, undone, status }) => ({
        id,
        at,
        root,
        path,
        action,
        tool,
        backup,
        undone,
        status,
      })),
    };
  }
  subscribe(listener: (snapshot: FilesSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writes.then(operation);
    this.writes = run.catch(() => undefined);
    return run;
  }
  // grantRevision 在调用时立即递增（不等排队）：正在写的事务也会在最终替换前被作废，宁可误拦。
  async add(rawPath: string, writable: boolean): Promise<FilesResult> {
    this.grantRevision++;
    return this.enqueue(async () => {
      if (this.config.roots.length >= fileRootLimits.maxRoots)
        return { ok: false, error: `最多 ${fileRootLimits.maxRoots} 个目录。` };
      const problem = fileRootProblem(rawPath, this.forbidden);
      if (problem) return { ok: false, error: problem };
      const path = normalizeRootPath(rawPath);
      const info = await stat(path).catch(() => null);
      if (!info?.isDirectory()) return { ok: false, error: '这个目录不存在。' };
      const real = await realpath(path).catch(() => null);
      if (!real) return { ok: false, error: '无法核对目录真实路径。' };
      const realProblem = fileRootProblem(real, this.forbidden);
      if (realProblem) return { ok: false, error: `它实际指向 ${real}：${realProblem}` };
      if (
        this.config.roots.some(
          (root) => normalizeRootPath(root.path).toLowerCase() === path.toLowerCase(),
        )
      )
        return { ok: false, error: '这个目录已经加过了。' };
      const name = rootNameFor(
        path,
        this.config.roots.map((root) => root.name),
      );
      return this.saveConfig({
        ...this.config,
        roots: [...this.config.roots, { name, path, writable }],
      });
    });
  }
  remove(name: string): Promise<FilesResult> {
    this.grantRevision++;
    return this.enqueue(async () => {
      if (!this.config.roots.some((root) => root.name === name))
        return { ok: false, error: '没有这个目录。' };
      return this.saveConfig({
        ...this.config,
        roots: this.config.roots.filter((root) => root.name !== name),
      });
    });
  }
  setWritable(name: string, writable: boolean): Promise<FilesResult> {
    this.grantRevision++;
    return this.enqueue(async () => {
      if (!this.config.roots.some((root) => root.name === name))
        return { ok: false, error: '没有这个目录。' };
      return this.saveConfig({
        ...this.config,
        roots: this.config.roots.map((root) => (root.name === name ? { ...root, writable } : root)),
      });
    });
  }
  private validate(input: FileWrite, signal: AbortSignal): void {
    assertNotCancelled(signal);
    if (this.journalError) throw new FileTransactionError(this.journalError);
    const root = this.config.roots.find((r) => r.name === input.root);
    if (
      this.grantRevision !== input.revision ||
      !root?.writable ||
      resolve(root.path) !== input.expected.base
    )
      throw new FileTransactionError('目录授权已变化或是只读的，请重新确认；未提交。');
    if (
      fileRootProblem(root.path, this.forbidden) ||
      isSecretPath(input.expected.path) ||
      isNoWritePath(input.expected.path)
    )
      throw new FileTransactionError('目标路径受保护，不能写入。');
  }
  commit(input: FileWrite, signal: AbortSignal): Promise<FileChange> {
    return this.enqueue(() => this.transact(input, signal));
  }
  /** Back up the exact approved bytes, then persist intent BEFORE changing a target. */
  async snapshotBefore(
    input: FileWrite,
    stage: StagedFile | null,
    undoOf?: string,
  ): Promise<StoredChange> {
    const id = randomUUID();
    const backup = input.expected.bytes === null ? null : `${id}.bak`;
    const change: StoredChange = {
      id,
      at: this.now(),
      root: input.root,
      path: input.expected.path,
      base: input.expected.base,
      action:
        input.expected.bytes === null ? 'created' : input.after === null ? 'deleted' : 'modified',
      tool: input.tool,
      backup,
      undone: false,
      status: 'prepared',
      beforeHash: input.expected.hash,
      afterHash: input.after === null ? null : hashBytes(input.after),
      beforeIdentity: input.expected.identity,
      afterIdentity: stage?.identity ?? null,
      parents: captureFile(input.expected.base, input.expected.path).parents,
      ...(undoOf ? { undoOf } : {}),
    };
    try {
      if (backup) {
        await mkdir(this.paths.backups, { recursive: true });
        const handle = await open(join(this.paths.backups, backup), 'wx', 0o600);
        try {
          await handle.writeFile(input.expected.bytes!);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await this.saveChanges([change, ...this.changes]);
    } catch (error) {
      if (backup)
        await rm(join(this.paths.backups, backup), { force: true }).catch(() => undefined);
      throw error;
    }
    return change;
  }
  private async transact(
    input: FileWrite,
    signal: AbortSignal,
    undoOf?: string,
  ): Promise<FileChange> {
    this.validate(input, signal);
    assertUnchanged(input.expected);
    if (input.after && input.after.length > 256 * 1024)
      throw new FileTransactionError('文件太大。');
    let stage: StagedFile | null = null;
    let change: StoredChange | null = null;
    let replaced = false;
    try {
      stage = stageFile(input.expected, input.after);
      change = await this.snapshotBefore(input, stage, undoOf);
      applyStage(input.expected, stage, () => this.validate(input, signal));
      replaced = true;
      const applied: StoredChange = { ...change, status: 'applied' };
      const next = this.changes.map((item) =>
        item.id === change!.id ? applied : item.id === undoOf ? { ...item, undone: true } : item,
      );
      const dropped = next.slice(fileRootLimits.changes);
      await this.saveChanges(next.slice(0, fileRootLimits.changes));
      for (const old of dropped)
        if (old.backup)
          await rm(join(this.paths.backups, old.backup), { force: true }).catch(() => undefined);
      return applied;
    } catch (error) {
      if (replaced) {
        this.journalError =
          '文件已修改，但最终改动记录保存失败；预写记录和备份已保留，已禁止后续写入/撤销，请重启核对，勿重复执行。';
        this.notify();
        throw new FileTransactionError(this.journalError);
      }
      if (change) {
        try {
          await this.saveChanges(this.changes.filter((item) => item.id !== change!.id));
          if (change.backup) await rm(join(this.paths.backups, change.backup), { force: true });
        } catch {
          // Durable prepared record is reconciled on restart; never leave it
          // looking pending in memory for this session.
          this.changes = this.changes.filter((item) => item.id !== change!.id);
          this.notify();
        }
      }
      if (error instanceof FileTransactionError) throw error;
      throw new FileTransactionError(
        '备份、改动记录或写入失败，已放弃提交；请检查磁盘空间和权限。',
      );
    } finally {
      discardStage(stage);
    }
  }
  private sameParents(change: StoredChange, current: FileState): boolean {
    return (
      !!change.parents &&
      change.parents.every((p) =>
        current.parents.some((n) => n.path === p.path && n.identity === p.identity),
      )
    );
  }
  undo(id: string): Promise<FilesResult> {
    const revision = this.grantRevision;
    return this.enqueue(async () => {
      const change = this.changes.find((item) => item.id === id);
      if (!change) return { ok: false, error: '没有这条记录。' };
      if (change.undone) return { ok: false, error: '已经撤销过了。' };
      if (change.status !== 'applied' || !change.base || change.afterHash === undefined)
        return { ok: false, error: '这是旧记录或未完成的提交，需要人工核对；未撤销。' };
      try {
        const expected = captureFile(change.base, change.path);
        if (
          expected.hash !== change.afterHash ||
          expected.identity !== change.afterIdentity ||
          !this.sameParents(change, expected)
        )
          throw new FileTransactionError('文件在改动后又被编辑、替换或移动了，存在冲突；未撤销。');
        const after = change.backup
          ? captureFile(this.paths.backups, join(this.paths.backups, change.backup)).bytes
          : null;
        if ((after === null ? null : hashBytes(after)) !== change.beforeHash)
          throw new FileTransactionError('备份内容校验失败，未撤销。');
        await this.transact(
          { root: change.root, expected, after, tool: change.tool, revision },
          new AbortController().signal,
          id,
        );
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof FileTransactionError ? error.message : '撤销失败：文件或备份不可用。',
        };
      }
    });
  }
  async settled(): Promise<void> {
    await this.writes;
  }
  private async saveConfig(next: FileRootsConfig): Promise<FilesResult> {
    try {
      await writeJson(this.paths.config, next);
    } catch {
      return { ok: false, error: '保存失败。' };
    }
    this.config = next;
    this.notify();
    return { ok: true };
  }
  private async saveChanges(next: StoredChange[]): Promise<void> {
    await writeJson(this.paths.changes, { version: 1, changes: next });
    this.changes = next;
    this.notify();
  }
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        /* Observers must not change transaction outcomes. */
      }
    }
  }
}
