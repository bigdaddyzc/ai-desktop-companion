import { execFile, spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import type { DelegateSnapshot } from '../core/delegate';
import type { WorkProgressState } from '../core/progress';
import {
  buildReview,
  editorProblem,
  openPathProblem,
  parsePorcelain,
  reviewLimits,
  reviewNote,
  type ReviewResult,
} from '../core/review';
import {
  buildWorkbench,
  emptyWorkbench,
  markSeen,
  normalizeSeen,
  type WorkbenchConfig,
  type WorkbenchItem,
  type WorkbenchSeen,
  type WorkbenchSnapshot,
  type WorkbenchState,
} from '../core/workbench';
import { writeJsonAtomic } from './atomic';

export type GitRunner = (
  args: readonly string[],
  cwd: string,
  maxBytes: number,
) => Promise<{ ok: boolean; stdout: string; truncated: boolean }>;

/**
 * 只读 git：固定参数、限时 5 秒、输出限长。
 * 关掉仓库配置里能跑外部程序的入口（fsmonitor、外部 diff、textconv）：
 * 项目目录来自钩子收件箱，看改动不该顺手执行仓库里配的命令。
 */
export const defaultGitRunner: GitRunner = (args, cwd, maxBytes) =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
      {
        cwd,
        timeout: reviewLimits.gitTimeoutMs,
        maxBuffer: maxBytes,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: '' },
      },
      (error, stdout) => {
        const text = typeof stdout === 'string' ? stdout : '';
        if (error === null) {
          resolve({ ok: true, stdout: text, truncated: false });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({ ok: true, stdout: text, truncated: true });
          return;
        }
        resolve({ ok: false, stdout: text, truncated: false });
      },
    );
  });

export type EditorLauncher = (editor: string, dir: string) => Promise<boolean>;

/** Windows 上 code 是 code.cmd，只能经 cmd 启动；两个参数都已拒绝 cmd 元字符。 */
export const defaultEditorLauncher: EditorLauncher = (editor, dir) =>
  new Promise((resolve) => {
    try {
      const child =
        process.platform === 'win32'
          ? spawn(
              process.env['ComSpec'] ?? 'cmd.exe',
              ['/d', '/s', '/c', `""${editor}" "${dir}""`],
              {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                windowsVerbatimArguments: true,
              },
            )
          : spawn(editor, [dir], { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

/**
 * 派活开工前的工作区：HEAD 和已有几个未提交文件（只读）。
 * 不是 git、空仓库、git 跑不起来都返回 null——只作说明，不证明归属。
 */
export async function gitBaseline(
  cwd: string,
  git: GitRunner = defaultGitRunner,
): Promise<{ head: string; dirty: number } | null> {
  if (!(await isDirectory(cwd))) return null;
  const head = await git(['rev-parse', '--verify', 'HEAD'], cwd, 4_096);
  if (!head.ok || !/^[0-9a-f]{7,64}$/.test(head.stdout.trim())) return null;
  const status = await git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    cwd,
    reviewLimits.statBytes,
  );
  if (!status.ok) return null;
  return { head: head.stdout.trim(), dirty: parsePorcelain(status.stdout).length };
}

async function isDirectory(path: string): Promise<boolean> {
  if (path === '') return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 工作台的桌面侧：合并进度与派活、记住「已看」（workbench-v1.json，重启不丢）、
 * 给结果卡跑只读 git、打开编辑器。渲染进程只能传工作台里已有的 key，换不成任意路径。
 */
export class WorkbenchService {
  private seen: WorkbenchSeen = {};
  private config: WorkbenchConfig = { editor: 'code' };
  private current: WorkbenchSnapshot = emptyWorkbench();
  private readonly listeners = new Set<(state: WorkbenchState) => void>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly progress: () => WorkProgressState,
    private readonly delegate: () => DelegateSnapshot,
    private readonly now: () => number = Date.now,
    private readonly git: GitRunner = defaultGitRunner,
    private readonly launch: EditorLauncher = defaultEditorLauncher,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      this.seen = normalizeSeen(raw['seen']);
      const editor = typeof raw['editor'] === 'string' ? raw['editor'] : '';
      if (editor !== '' && editorProblem(editor) === '') this.config = { editor };
    } catch {
      this.seen = {};
    }
    this.refresh();
  }

  state(): WorkbenchState {
    return { ...this.current, config: { ...this.config } };
  }

  seenMap(): WorkbenchSeen {
    return this.seen;
  }

  subscribe(listener: (state: WorkbenchState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 进度或派活变了、定时器到了：重算，有变化才广播。 */
  refresh(): WorkbenchSnapshot {
    const delegate = this.delegate();
    const next = buildWorkbench({
      progress: this.progress(),
      delegate: { busy: delegate.busy, current: delegate.current, history: delegate.history },
      seen: this.seen,
      now: this.now(),
    });
    const changed =
      JSON.stringify({ ...next, at: 0 }) !== JSON.stringify({ ...this.current, at: 0 });
    this.current = next;
    if (changed) this.publish();
    return next;
  }

  private publish(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }

  private persist(): Promise<void> {
    const value = { v: 1, seen: this.seen, editor: this.config.editor };
    const run = (): Promise<void> => writeJsonAtomic(this.path, value);
    this.writes = this.writes.then(run, run);
    return this.writes;
  }

  find(key: string): WorkbenchItem | undefined {
    return this.current.items.find((item) => item.key === key);
  }

  async markSeen(key: string): Promise<boolean> {
    if (this.find(key) === undefined) return false;
    this.seen = markSeen(this.seen, key, this.now());
    await this.persist().catch(() => undefined);
    this.refresh();
    return true;
  }

  async setEditor(editor: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const problem = editorProblem(editor);
    if (problem !== '') return { ok: false, error: problem };
    this.config = { editor: editor.trim() };
    try {
      await this.persist();
    } catch {
      return { ok: false, error: '没保存上，请重试。' };
    }
    this.publish();
    return { ok: true };
  }

  async review(key: string): Promise<ReviewResult | null> {
    const item = this.find(key);
    if (item === undefined) return null;
    const empty = (status: ReviewResult['status']): ReviewResult => ({
      status,
      files: [],
      added: 0,
      deleted: 0,
      note: reviewNote(status),
      truncated: false,
    });
    if (!(await isDirectory(item.cwd))) return empty('no-dir');
    const inside = await this.git(['rev-parse', '--is-inside-work-tree'], item.cwd, 4_096);
    if (!inside.ok) {
      // 不是仓库时 git 以非零退出；完全跑不起来（没装）时 stdout 也是空的，归到 not-git 不准确。
      const probe = await this.git(['--version'], item.cwd, 4_096);
      return empty(probe.ok ? 'not-git' : 'error');
    }
    if (inside.stdout.trim() !== 'true') return empty('not-git');
    const [status, numstat] = await Promise.all([
      this.git(
        ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
        item.cwd,
        reviewLimits.statBytes,
      ),
      this.git(
        ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', 'HEAD'],
        item.cwd,
        reviewLimits.statBytes,
      ),
    ]);
    if (!status.ok) return empty('error');
    const head = await this.git(['rev-parse', '--verify', 'HEAD'], item.cwd, 4_096);
    // 空仓库没有 HEAD：numstat 失败就只列文件、不列行数。
    return {
      ...buildReview(
        status.stdout,
        numstat.ok ? numstat.stdout : '',
        status.truncated || numstat.truncated,
      ),
      ...(head.ok ? { head: head.stdout.trim() } : {}),
    };
  }

  async diff(
    key: string,
  ): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; error: string }> {
    const item = this.find(key);
    if (item === undefined) return { ok: false, error: '这一项已经不在工作台上了。' };
    if (!(await isDirectory(item.cwd))) return { ok: false, error: reviewNote('no-dir') };
    const result = await this.git(
      ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD'],
      item.cwd,
      reviewLimits.diffBytes,
    );
    if (!result.ok) return { ok: false, error: '取不到 diff（不是 git 项目，或还没有提交过）。' };
    return { ok: true, text: result.stdout, truncated: result.truncated };
  }

  async openEditor(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const item = this.find(key);
    if (item === undefined) return { ok: false, error: '这一项已经不在工作台上了。' };
    const problem = openPathProblem(item.cwd) || editorProblem(this.config.editor);
    if (problem !== '') return { ok: false, error: problem };
    if (!(await isDirectory(item.cwd))) return { ok: false, error: '这个目录已经不在了。' };
    return (await this.launch(this.config.editor, item.cwd))
      ? { ok: true }
      : {
          ok: false,
          error: `打不开 ${this.config.editor}：确认它在 PATH 里，或在工作台里换一个命令。`,
        };
  }
}
