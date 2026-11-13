import { randomUUID, createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';

export class FileTransactionError extends Error {}
export const hashBytes = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
const identity = (info: BigIntStats): string => `${info.dev}:${info.ino}`;
const version = (info: BigIntStats): string =>
  `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
export interface ParentIdentity {
  path: string;
  identity: string;
}
export interface FileState {
  base: string;
  path: string;
  bytes: Buffer | null;
  hash: string | null;
  identity: string | null;
  version: string | null;
  mode: number;
  parents: ParentIdentity[];
}
function infoAt(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error; // Permission/I/O errors never mean "new file".
  }
}

/** Bounded local-file snapshot. Writes refuse symlinks/junctions and hard links.
 * Node has no portable directory-relative rename/CAS. The final synchronous
 * check + rename removes application await gaps, not hostile OS-process races.
 */
export function captureFile(base: string, path: string): FileState {
  base = resolve(base);
  path = resolve(path);
  const rel = relative(base, path);
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith('..' + sep) ||
    resolve(base, rel) !== path
  )
    throw new FileTransactionError('目标必须是目录内的文件。');
  // 授权目录本身及其上级由用户选定（添加时已按 realpath 核过），允许是 junction/重定向目录；
  // 目录本身按「跟随链接后」的身份记下，确认期间被改指向会对不上。目录以下一律不跟链接。
  const ancestors: string[] = [];
  for (let p = dirname(path); p !== base; p = dirname(p)) ancestors.unshift(p);
  const parents: ParentIdentity[] = [];
  let root: BigIntStats | null = null;
  try {
    root = statSync(base, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!root?.isDirectory()) throw new FileTransactionError('授权目录不存在，已拒绝。');
  parents.push({ path: base, identity: identity(root) });
  for (const p of ancestors) {
    const info = infoAt(p);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new FileTransactionError('写入路径包含链接或非目录，已拒绝。');
    parents.push({ path: p, identity: identity(info) });
  }
  const entry = infoAt(path);
  if (!entry)
    return {
      base,
      path,
      bytes: null,
      hash: null,
      identity: null,
      version: null,
      mode: 0o600,
      parents,
    };
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n)
    throw new FileTransactionError('目标不是普通单链接文件，已拒绝。');
  if (entry.size > 256n * 1024n) throw new FileTransactionError('原文件超过 256KB，不在这里改。');
  const fd = openSync(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const first = fstatSync(fd, { bigint: true });
    if (version(first) !== version(entry))
      throw new FileTransactionError('文件已变化，请重新读取。');
    const bounded = Buffer.alloc(256 * 1024 + 1);
    let count = 0;
    while (count < bounded.length) {
      const n = readSync(fd, bounded, count, bounded.length - count, count);
      if (!n) break;
      count += n;
    }
    if (count > 256 * 1024) throw new FileTransactionError('原文件超过 256KB，不在这里改。');
    const bytes = bounded.subarray(0, count);
    const last = fstatSync(fd, { bigint: true });
    const pathInfo = infoAt(path);
    if (version(first) !== version(last) || !pathInfo || version(pathInfo) !== version(first))
      throw new FileTransactionError('读取期间文件发生变化，请重试。');
    return {
      base,
      path,
      bytes,
      hash: hashBytes(bytes),
      identity: identity(first),
      version: version(first),
      mode: Number(first.mode & 0o777n),
      parents,
    };
  } finally {
    closeSync(fd);
  }
}

export function assertUnchanged(expected: FileState): FileState {
  const current = captureFile(expected.base, expected.path);
  if (
    current.version !== expected.version ||
    current.hash !== expected.hash ||
    expected.parents.some(
      (p) => !current.parents.some((now) => now.path === p.path && now.identity === p.identity),
    )
  )
    throw new FileTransactionError('文件内容、身份或父目录已变化；请重新读取并确认，未覆盖。');
  return current;
}
export function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new FileTransactionError('已取消，未提交文件。');
}
export interface StagedFile {
  path: string;
  identity: string;
  hash: string;
}
export function stageFile(expected: FileState, bytes: Buffer | null): StagedFile | null {
  assertUnchanged(expected);
  mkdirSync(dirname(expected.path), { recursive: true });
  assertUnchanged(expected);
  if (bytes === null) return null;
  const path = join(dirname(expected.path), `.xinban-${randomUUID()}.tmp`);
  const fd = openSync(path, 'wx', expected.mode);
  let staged = false;
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const result = {
      path,
      identity: identity(fstatSync(fd, { bigint: true })),
      hash: hashBytes(bytes),
    };
    staged = true;
    return result;
  } finally {
    // 只关一次：重复 close 可能误关刚被别处复用的同号描述符。清理失败不掩盖原错误。
    closeSync(fd);
    if (!staged) {
      try {
        unlinkSync(path);
      } catch {
        /* cleanup only */
      }
    }
  }
}
export function discardStage(stage: StagedFile | null): void {
  if (!stage) return;
  // Never follow a replaced parent just to clean up a temporary file.
  try {
    if (identity(infoAt(stage.path)!) === stage.identity) unlinkSync(stage.path);
  } catch {
    /* best effort */
  }
}
export function applyStage(
  expected: FileState,
  stage: StagedFile | null,
  validate: () => void,
): void {
  assertUnchanged(expected);
  if (stage) {
    const staged = captureFile(expected.base, stage.path);
    if (staged.identity !== stage.identity || staged.hash !== stage.hash)
      throw new FileTransactionError('临时文件已变化，未提交。');
  }
  validate(); // No await between final app-authority check and replacement.
  if (stage) renameSync(stage.path, expected.path);
  else if (expected.bytes !== null) unlinkSync(expected.path);
}
