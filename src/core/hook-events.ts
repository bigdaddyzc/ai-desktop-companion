import { agentSourceLabels } from './agent-logs';
import { autoApprovalText } from './auto-approve';
import {
  clipText,
  parseLines,
  progressWindow,
  statusOf,
  type WorkProgressState,
  type WorkSession,
  type WorkSignal,
} from './progress';

/**
 * 官方通知钩子：Claude Code 的 hooks、Codex 的 notify 主动推来的状态事件。
 *
 * 和「读会话日志」相比，这是对方**公开承诺**的接口：等你确认、这轮做完、会话结束
 * 都由对方亲口说出，不用再从工具名里猜。钩子脚本（xinban-hook.cjs）只往一个
 * NDJSON 收件箱里追加一行，这里把收件箱读成「每个会话此刻处于什么状态」。
 *
 * 记录里刻意没有对话内容：不记用户提问、不记助手回答，只有事件名、会话 id、
 * 工作目录、工具名，以及 Notification 自带的那句系统提示（例如「需要你批准 Bash」）。
 * 所以钩子来的会话即使没开「读日志」，也不会把对话带进给模型的提示词。
 */

export type HookSource = 'claude-code' | 'codex' | 'workbuddy';

/** ready=会话刚开；working=在干活；waiting=等你批准或回答；done=这一轮做完；ended=会话关了。 */
export type HookSignalKind = WorkSignal | 'ended';

export interface HookSignal {
  sessionId: string;
  source: HookSource;
  cwd: string;
  kind: HookSignalKind;
  /** 等的是什么：工具名或系统提示。可能为空。 */
  detail: string;
  /** 进入当前状态的时间：同一状态里的重复事件不刷新它，用来给提醒去重。 */
  since: number;
  /** 最后一次收到这个会话任何事件的时间。 */
  lastAt: number;
  /** 芯伴派出去的活：派活 ID（开工时刻）；用户自己开的会话是空串。 */
  job: string;
}

export const hookLimits = {
  /** 收件箱只读尾部：钩子脚本自己会在 512KB 时轮转。 */
  tailBytes: 128 * 1024,
  /** 等你确认的提醒在多久内算新鲜；更早的等待在启动时不再翻出来。 */
  waitingFreshMs: 15 * 60_000,
  /** 「做完了」只在刚发生时说一次。 */
  doneFreshMs: 2 * 60_000,
} as const;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 一条 Claude Code 事件 → 新状态；返回 null 表示这条不改变状态。 */
function claudeKind(
  event: string,
  type: string,
  current: HookSignalKind | undefined,
  auto = false,
): HookSignalKind | null {
  switch (event) {
    case 'SessionStart':
      // 只在新会话时算「刚开」：Claude Code 恢复/压缩上下文时也会再报一次，
      // CodeBuddy 实测把它排在 UserPromptSubmit 之后——都不该把「在干活」打回「刚开」。
      return current === undefined || current === 'ended' ? 'ready' : null;
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'working';
    case 'PermissionRequest':
      // 芯伴已经替你批了的，对方接着干活，不算在等你。
      return auto ? 'working' : 'waiting';
    case 'RemoteDecision':
      // 你在芯伴上批了/拒了：对方接着干。交回终端、超时：还在等你（去终端点）。
      return type === 'allow' || type === 'deny' ? 'working' : null;
    case 'Stop':
      return 'done';
    case 'SessionEnd':
      return 'ended';
    case 'Notification':
      // 权限提示与对话框提问都是在等你；idle_prompt 是「做完后一分钟你还没回」，
      // 那时 Stop 已经报过「做完了」，不再改状态、也不再提醒一次。
      if (type === 'permission_prompt' || type === 'elicitation_dialog') return 'waiting';
      if (type === '' && current !== 'done') return 'waiting';
      return null;
    default:
      return null;
  }
}

function codexKind(event: string): HookSignalKind | null {
  return event === 'agent-turn-complete' ? 'done' : null;
}

/**
 * 把收件箱读成每个会话的最新状态（按事件先后折叠）。
 * 认不出的行、缺会话 id 的行一律跳过：宁可不知道，不要说错。
 */
export function parseHookEvents(
  raw: string,
  /** 测试里的芯伴自己就跑在沙盒里：那时沙盒事件恰恰是要看的，不能滤掉。 */
  options: { dropSandbox?: boolean } = {},
): HookSignal[] {
  const sessions = new Map<string, HookSignal>();
  for (const record of parseLines(raw)) {
    if (record['v'] !== 1) continue;
    const src = str(record['src']);
    const source: HookSource | null =
      src === 'claude'
        ? 'claude-code'
        : src === 'codex'
          ? 'codex'
          : src === 'workbuddy'
            ? 'workbuddy'
            : null;
    if (source === null) continue;
    const sessionId = str(record['sid']).trim();
    const at = num(record['at']);
    if (sessionId === '' || at === 0) continue;
    const key = `${source}:${sessionId}`;
    const prev = sessions.get(key);
    const event = str(record['ev']);
    // WorkBuddy 与 Claude Code 事件同名同义，共用一套映射。
    const auto = event === 'PermissionRequest' && record['auto'] === true;
    const kind =
      source === 'codex'
        ? codexKind(event)
        : claudeKind(event, str(record['type']), prev?.kind, auto);
    const cwd = str(record['cwd']) || prev?.cwd || '';
    const rawJob = str(record['job']);
    const job = /^\d{10,16}$/.test(rawJob) ? rawJob : (prev?.job ?? '');
    if (kind === null) {
      if (prev !== undefined)
        sessions.set(key, { ...prev, cwd, job, lastAt: Math.max(prev.lastAt, at) });
      continue;
    }
    const keys = Array.isArray(record['keys'])
      ? record['keys'].filter((key): key is string => typeof key === 'string')
      : [];
    const detail = auto
      ? clipText(autoApprovalText(keys), 80)
      : kind === 'waiting'
        ? clipText(str(record['tool']) || str(record['msg']), 80)
        : '';
    const changed = prev === undefined || prev.kind !== kind;
    sessions.set(key, {
      sessionId,
      source,
      cwd,
      kind,
      detail: kind === 'waiting' && detail === '' ? (prev?.detail ?? '') : detail,
      since: changed ? at : prev.since,
      lastAt: Math.max(prev?.lastAt ?? 0, at),
      job,
    });
  }
  const all = [...sessions.values()];
  return options.dropSandbox === false ? all : all.filter((signal) => !isSandboxCwd(signal.cwd));
}

/**
 * 测试/评测在临时目录里跑的 Claude Code（`%TEMP%\xinban-*`）也会走真钩子写进收件箱，
 * 它们不是你的工作：不该出现在进度里，更不该提醒你「在等你确认」。
 */
export function isSandboxCwd(cwd: string): boolean {
  return /[\\/](?:te?mp|tmp\w*)[\\/](?:[^\\/]+[\\/])*xinban-[^\\/]*/i.test(cwd);
}

function projectOf(cwd: string): string {
  return (
    cwd
      .split(/[\\/]/)
      .filter((part) => part !== '')
      .pop() ?? ''
  );
}

/** 日志里的会话 id 能否对上钩子里的 id：Claude Code 完全相同，Codex 的文件名以线程 id 结尾。 */
function sameSession(session: WorkSession, signal: HookSignal): boolean {
  // 不同工具的会话 id 可能撞上：来源标签对不上就不是同一个。
  if (session.source !== undefined && session.source !== agentSourceLabels[signal.source]) {
    return false;
  }
  if (session.sessionId === signal.sessionId) return true;
  return signal.source === 'codex' && session.sessionId.endsWith(signal.sessionId);
}

/**
 * 把钩子状态叠到「读日志」得到的进度上。
 *
 * - 对得上的会话：补上 signal，时间取两边较新的；
 * - 对不上的（没开读日志，或日志格式变了）：直接用钩子信息建一条最小会话；
 * - ended：从列表里拿掉。
 */
export function applyHookSignals(
  state: WorkProgressState,
  signals: readonly HookSignal[],
  now: number,
): WorkProgressState {
  if (signals.length === 0) return state;
  let sessions = [...state.sessions];
  for (const signal of signals) {
    if (now - signal.lastAt > progressWindow.forgetMs) continue;
    const index = sessions.findIndex((session) => sameSession(session, signal));
    if (signal.kind === 'ended') {
      if (index >= 0) sessions = sessions.filter((_, i) => i !== index);
      continue;
    }
    const extra = {
      signal: signal.kind as WorkSignal,
      signalDetail: signal.detail,
      signalAt: signal.since,
      ...(signal.job ? { delegateId: signal.job } : {}),
    };
    if (index >= 0) {
      const base = sessions[index]!;
      const updatedAt = Math.max(base.updatedAt, signal.lastAt);
      sessions[index] = { ...base, ...extra, updatedAt, status: statusOf(updatedAt, now) };
      continue;
    }
    const project = projectOf(signal.cwd);
    sessions.push({
      sessionId: signal.sessionId,
      source: agentSourceLabels[signal.source],
      title: project || agentSourceLabels[signal.source],
      project,
      cwd: signal.cwd,
      updatedAt: signal.lastAt,
      status: statusOf(signal.lastAt, now),
      runningTool: '',
      steps: [],
      stepCount: 0,
      lastUserText: '',
      lastAssistantText: '',
      ...extra,
    });
  }
  sessions.sort((a, b) => {
    // 在等你的排最前：那是唯一需要你立刻动手的。
    const wait = Number(b.signal === 'waiting') - Number(a.signal === 'waiting');
    return wait !== 0 ? wait : b.updatedAt - a.updatedAt;
  });
  return { ...state, sessions: sessions.slice(0, progressWindow.maxSessions) };
}
