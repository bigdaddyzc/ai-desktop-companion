import { watch, type FSWatcher } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  agentSourceLabels,
  parseClaudeHead,
  parseClaudeTail,
  parseCodexHead,
  parseCodexTail,
  type AgentLogFormat,
} from '../core/agent-logs';
import {
  buildSession,
  emptyProgress,
  parseSessionHead,
  parseSessionTail,
  progressPrompt,
  progressToolText,
  progressWindow,
  type TailSummary,
  type WorkProgressState,
  type WorkSession,
} from '../core/progress';

/**
 * 工作进度观察者。
 *
 * 定位要说清楚：芯伴不是 WorkBuddy 的插件，它只是一个「读痕迹」的旁观者。
 * 对方不推送事件，所以这里做两件事：
 * 1）监听会话目录，写入即触发（延迟从十几秒降到二百毫秒级）；
 * 2）低频轮询兜底——watch 在目录被重建、网络盘、权限变化时会漏事件，不能只靠它。
 * 好处是零配置、不改对方；代价是依赖对方的记录格式。
 *
 * 三条底线：
 * - 永不因为读不到而报错打断对话，失败只让芯伴「不知道」；
 * - 只读头尾窗口，十几 MB 的会话文件不进内存；
 * - 只读，不写、不锁、不碰对方的任何文件。
 */

export interface ProgressFile {
  path: string;
  /** 会话 id，来自文件名，避免多读一次。 */
  sessionId: string;
  mtimeMs: number;
  /**
   * 字节数。和 mtime 一起当缓存指纹：同一毫秒内追加两次时 mtime 可能一模一样，
   * 只看 mtime 会漏读一次更新。
   */
  size: number;
  /** 哪种记录格式；缺省是 WorkBuddy。 */
  format?: AgentLogFormat;
}

export interface ProgressSource {
  list(): Promise<ProgressFile[]>;
  head(path: string, bytes: number): Promise<string>;
  tail(path: string, bytes: number): Promise<string>;
  /** 可以监听的根目录；返回 null 表示这个数据源只能轮询。 */
  watchRoot?(): string | null;
  /** 多个根目录时用它；有就优先于 watchRoot。 */
  watchRoots?(): string[];
}

/** 从文件指定位置读一段；读失败返回空串，把「读不到」变成「不知道」。 */
async function readWindow(path: string, bytes: number, fromEnd: boolean): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    if (length <= 0) return '';
    const start = fromEnd ? size - length : 0;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    // 只有真的从中间切开才丢首行。整个文件都在窗口内时首行就是完整的一行，
    // 丢掉它会让「刚创建、只有一行」的会话被读成空——这里踩过。
    if (fromEnd && start > 0) {
      const cut = text.indexOf('\n');
      text = cut >= 0 ? text.slice(cut + 1) : '';
    }
    return text;
  } catch {
    return '';
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

/**
 * 「项目目录/会话.jsonl」布局的数据源。
 * 默认是 WorkBuddy（`~/.workbuddy/projects`）；Claude Code（`~/.claude/projects`）是同一种布局。
 */
export class FsProgressSource implements ProgressSource {
  constructor(
    private readonly root: string = join(homedir(), '.workbuddy', 'projects'),
    private readonly format: AgentLogFormat = 'workbuddy',
  ) {}

  async list(): Promise<ProgressFile[]> {
    // 根目录读不到要抛出去：那是「没装／没跑过 WorkBuddy」，和「装了但最近没活」
    // 是两件事，界面上要分开说。子目录读不到才吞——项目被删掉是正常的。
    const projects = await readdir(this.root, { withFileTypes: true });
    const out: ProgressFile[] = [];
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = join(this.root, project.name);
      const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const path = join(dir, file.name);
        const info = await stat(path).catch(() => null);
        if (info === null) continue;
        out.push({
          path,
          sessionId: file.name.replace(/\.jsonl$/, ''),
          mtimeMs: info.mtimeMs,
          size: info.size,
          format: this.format,
        });
      }
    }
    return out;
  }

  head(path: string, bytes: number): Promise<string> {
    return readWindow(path, bytes, false);
  }

  tail(path: string, bytes: number): Promise<string> {
    return readWindow(path, bytes, true);
  }

  watchRoot(): string | null {
    return this.root;
  }
}

/**
 * Codex：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。按日期分目录且越积越多，
 * 所以只看今天和昨天两个目录——更早的本来也超出 6 小时的「当前进度」窗口了。
 */
export class CodexProgressSource implements ProgressSource {
  constructor(
    private readonly root: string = join(homedir(), '.codex', 'sessions'),
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<ProgressFile[]> {
    // 根目录不存在要抛：说明没装 Codex。
    await stat(this.root);
    const out: ProgressFile[] = [];
    const pad = (value: number): string => `${value}`.padStart(2, '0');
    for (const offset of [0, 1]) {
      const day = new Date(this.now() - offset * 86_400_000);
      const dir = join(
        this.root,
        `${day.getFullYear()}`,
        pad(day.getMonth() + 1),
        pad(day.getDate()),
      );
      const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const path = join(dir, file.name);
        const info = await stat(path).catch(() => null);
        if (info === null) continue;
        out.push({
          path,
          sessionId: file.name.replace(/\.jsonl$/, ''),
          mtimeMs: info.mtimeMs,
          size: info.size,
          format: 'codex',
        });
      }
    }
    return out;
  }

  head(path: string, bytes: number): Promise<string> {
    return readWindow(path, bytes, false);
  }

  tail(path: string, bytes: number): Promise<string> {
    return readWindow(path, bytes, true);
  }

  watchRoot(): string | null {
    return this.root;
  }
}

/**
 * 把几个来源拼成一个。来源列表用 getter 取：面板里开关一变，下一轮扫描就生效。
 * 只有全部来源都读不到时才算「没找到」；任一可读就照常工作。
 */
export class MultiProgressSource implements ProgressSource {
  constructor(private readonly sources: () => readonly ProgressSource[]) {}

  async list(): Promise<ProgressFile[]> {
    const results = await Promise.allSettled(this.sources().map((source) => source.list()));
    const ok = results.filter(
      (item): item is PromiseFulfilledResult<ProgressFile[]> => item.status === 'fulfilled',
    );
    if (ok.length === 0 && results.length > 0) throw new Error('no progress source');
    return ok.flatMap((item) => item.value);
  }

  head(path: string, bytes: number): Promise<string> {
    return readWindow(path, bytes, false);
  }

  tail(path: string, bytes: number): Promise<string> {
    return readWindow(path, bytes, true);
  }

  watchRoots(): string[] {
    return this.sources().flatMap((source) => {
      const roots = source.watchRoots?.() ?? [];
      const root = source.watchRoot?.() ?? null;
      return root === null ? roots : [...roots, root];
    });
  }
}

/**
 * 叠加层：在「读日志」的结果上再叠一层别的信息（目前是官方钩子事件）。
 * refresh 在每轮扫描前调用，apply 必须是纯函数。
 */
export interface ProgressOverlay {
  refresh(): Promise<void>;
  apply(state: WorkProgressState, now: number): WorkProgressState;
  /** 要监听的目录；叠加层的变化也应当立刻触发重扫。 */
  watchRoot?(): string | null;
}

export const progressDefaults = {
  /** 兜底轮询：watch 漏事件时的下限，不再是主要手段。 */
  intervalMs: 15_000,
  /** 写入是一段段的：一次工具调用会连着追加好几行，合并抖动别每一行都重读。 */
  debounceMs: 220,
} as const;

export class ProgressService {
  private state: WorkProgressState = emptyProgress();
  private readonly listeners = new Set<(state: WorkProgressState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private watchers: FSWatcher[] = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private scanning = false;
  /** 扫描期间又来了触发：本轮结束后再扫一次。 */
  private again = false;
  /**
   * 解析结果按「路径 + mtime」缓存。
   * watch 变成亚秒级之后，如果不缓存，磁盘上每追加一行都要把最多三个会话的头尾
   * 共近 1 MB 重读重解析——比原来的十五秒轮询更费。mtime 没变就复用上次的解析。
   * 只缓存解析结果，不缓存 WorkSession：status 依赖 now，必须每轮重算。
   */
  private readonly cache = new Map<string, CachedParse>();

  constructor(
    private readonly source: ProgressSource,
    private readonly now: () => number = Date.now,
    private readonly overlay: ProgressOverlay | null = null,
  ) {}

  snapshot(): WorkProgressState {
    return this.state;
  }

  subscribe(listener: (state: WorkProgressState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 扫一遍。并发调用不另起一轮，但要记下「期间又有变化」：本轮结束后补扫一次。
   * 以前直接跳过，扫描期间到达的钩子事件（比如「等你确认」）要等 15 秒兜底轮询才显示。
   */
  async scan(): Promise<WorkProgressState> {
    if (this.scanning) {
      this.again = true;
      return this.state;
    }
    this.scanning = true;
    try {
      let next = this.state;
      do {
        this.again = false;
        next = await this.scanOnce();
      } while (this.again);
      return next;
    } finally {
      this.scanning = false;
    }
  }

  private async scanOnce(): Promise<WorkProgressState> {
    const collected = await this.collect();
    let next = collected;
    if (this.overlay !== null) {
      // 叠加层出错只等于没有叠加，不能连累日志那一路。
      try {
        await this.overlay.refresh();
        next = this.overlay.apply(collected, collected.scannedAt);
        // 钩子已经报上会话了，就别再说「没找到会话目录」。
        if (next.sessions.length > 0) next = { ...next, error: '' };
      } catch {
        next = collected;
      }
    }
    this.publish(next);
    return next;
  }

  private async collect(): Promise<WorkProgressState> {
    const now = this.now();
    let files: ProgressFile[];
    try {
      files = await this.source.list();
    } catch {
      return { sessions: [], scannedAt: now, error: '没有找到 WorkBuddy 的会话目录' };
    }
    const fresh = files
      .filter((file) => now - file.mtimeMs <= progressWindow.forgetMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, progressWindow.maxSessions);
    if (fresh.length === 0) return { sessions: [], scannedAt: now, error: '' };

    const sessions: WorkSession[] = [];
    const seen = new Set<string>();
    for (const file of fresh) {
      seen.add(file.path);
      const cached = this.cache.get(file.path);
      const hit =
        cached !== undefined && cached.mtimeMs === file.mtimeMs && cached.size === file.size
          ? cached
          : null;
      const parsed = hit ?? (await this.parseFile(file));
      if (parsed === null) continue;
      const session = buildSession(parsed.head, parsed.summary, now);
      if (session === null) continue;
      // WorkBuddy 不写 source：沿用旧行为（界面上缺省就是 WorkBuddy）。
      const format = file.format ?? 'workbuddy';
      sessions.push(
        format === 'workbuddy' ? session : { ...session, source: agentSourceLabels[format] },
      );
    }
    // 会话文件被清理或滑出窗口后，缓存也要跟着瘦，否则内存只涨不落。
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    return { sessions, scannedAt: now, error: '' };
  }

  /** 读一个会话文件的头尾并解析；读不出正文返回 null（不缓存，下次还会重试）。 */
  private async parseFile(file: ProgressFile): Promise<CachedParse | null> {
    const [head, tail] = await Promise.all([
      this.source.head(file.path, progressWindow.headChars),
      this.source.tail(file.path, progressWindow.tailChars),
    ]);
    if (tail === '') return null;
    const format = file.format ?? 'workbuddy';
    const summary =
      format === 'claude-code'
        ? parseClaudeTail(tail)
        : format === 'codex'
          ? parseCodexTail(tail)
          : parseSessionTail(tail);
    if (summary.sessionId === '') summary.sessionId = file.sessionId;
    const parsed: CachedParse = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      head:
        format === 'claude-code'
          ? parseClaudeHead(head)
          : format === 'codex'
            ? parseCodexHead(head)
            : parseSessionHead(head),
      summary,
    };
    this.cache.set(file.path, parsed);
    return parsed;
  }

  private publish(next: WorkProgressState): void {
    if (sameProgress(this.state, next)) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  start(intervalMs: number = progressDefaults.intervalMs): void {
    if (this.timer !== null) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), intervalMs);
    // 不因为观察工作进度而拖住应用退出。
    this.timer.unref?.();
    this.watch();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
    this.unwatch();
  }

  /**
   * 盯住会话目录：写入、改名都算事件，合并后重扫一次。
   *
   * 目录还不存在（没装 WorkBuddy、或第一次运行）时 fs.watch 会直接抛，
   * 这时静默降级为纯轮询——等目录出现，轮询会接手。
   */
  private watch(): void {
    if (this.watchers.length > 0) return;
    const single = this.source.watchRoot?.() ?? null;
    const roots = [...(this.source.watchRoots?.() ?? (single === null ? [] : [single]))];
    const extra = this.overlay?.watchRoot?.() ?? null;
    if (extra !== null) roots.push(extra);
    for (const root of roots) {
      try {
        const watcher = watch(root, { recursive: true }, () => this.kick());
        // 目录被删掉或权限变化后 watch 会报错；这一路降级为轮询，绝不把错误抛给界面。
        watcher.on('error', () => {
          watcher.close();
          this.watchers = this.watchers.filter((item) => item !== watcher);
        });
        this.watchers.push(watcher);
      } catch {
        // 目录还不存在：由轮询接手。
      }
    }
  }

  private unwatch(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  /** 来源变了（面板里开关了某个 agent）：重挂监听并立即重扫。 */
  async reload(): Promise<WorkProgressState> {
    this.unwatch();
    if (this.timer !== null) this.watch();
    this.cache.clear();
    return this.scan();
  }

  private kick(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.scan();
    }, progressDefaults.debounceMs);
    this.debounce.unref?.();
  }

  /** watch 是否真的挂上了：给测试和诊断用，界面不显示。 */
  get watching(): boolean {
    return this.watchers.length > 0;
  }

  /** 每轮对话注入的进度块；没有活跃会话时是空串，等于什么都没发生。 */
  prompt(): string {
    return progressPrompt(this.state, this.now());
  }

  toolText(): string {
    return progressToolText(this.state, this.now());
  }
}

/** 一个会话文件的解析结果快照：mtime 没变就能整段复用。 */
interface CachedParse {
  mtimeMs: number;
  size: number;
  head: { title: string; cwd: string };
  summary: TailSummary;
}

/** 只有「内容真的变了」才广播，避免一次写入触发一串无效的跨窗口 IPC。 */
function sameProgress(a: WorkProgressState, b: WorkProgressState): boolean {
  if (a.error !== b.error) return false;
  if (a.sessions.length !== b.sessions.length) return false;
  for (let i = 0; i < a.sessions.length; i += 1) {
    const left = a.sessions[i]!;
    const right = b.sessions[i]!;
    if (
      left.sessionId !== right.sessionId ||
      left.updatedAt !== right.updatedAt ||
      left.status !== right.status ||
      left.runningTool !== right.runningTool ||
      left.steps.length !== right.steps.length ||
      left.lastAssistantText !== right.lastAssistantText ||
      left.title !== right.title ||
      left.signal !== right.signal ||
      left.signalAt !== right.signalAt ||
      left.signalDetail !== right.signalDetail
    ) {
      return false;
    }
  }
  return true;
}
