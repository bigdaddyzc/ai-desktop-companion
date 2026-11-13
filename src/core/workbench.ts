import type { DelegateRecord } from './delegate';
import { hookLimits } from './hook-events';
import type { NudgeEvent } from './proactive';
import {
  clipText,
  progressWindow,
  shortActivity,
  type WorkProgressState,
  type WorkSession,
} from './progress';

/**
 * 工作台：所有 Agent 一张表，一眼看清「谁在等我」。
 *
 * 数据都是已有的：钩子/日志读出的会话（progress）、芯伴自己派出去的活（派活记录）。
 * 这里只合并、分类、排序，并记住你「看过了」哪些干完的活。
 *
 * 排序：等你 → 出错 → 干完没看 → 在干 → 空闲。纯领域层，不碰文件。
 */

export type WorkbenchKind = 'waiting' | 'error' | 'unseen' | 'working' | 'idle';

export const workbenchKinds: readonly WorkbenchKind[] = [
  'waiting',
  'error',
  'unseen',
  'working',
  'idle',
];

export const workbenchKindLabels: Record<WorkbenchKind, string> = {
  waiting: '等你',
  error: '出错',
  unseen: '结果待看',
  working: '在干',
  idle: '空闲',
};

export const workbenchLimits = {
  maxItems: 12,
  /** 等了这么久你还没理，桌宠提醒一次。 */
  longWaitMs: 2 * 60_000,
  /** 「已看」标记保留多久。 */
  seenKeepMs: 7 * 24 * 60 * 60_000,
  maxSeen: 300,
} as const;

export interface WorkbenchItem {
  /** 会话是 `${agent}:${sessionId}`，派活是 `delegate:${at}`。 */
  key: string;
  kind: WorkbenchKind;
  origin: 'session' | 'delegate';
  agent: string;
  project: string;
  /** 项目目录；不知道是空串（那就看不了改动）。 */
  cwd: string;
  /** 「项目名 · Agent」。 */
  title: string;
  /** 一句话：在等什么、在干什么、失败原因、结论开头。 */
  detail: string;
  /** 进入当前状态的时刻。 */
  at: number;
  /** Codex 没有能回传决定的钩子：等你时只能回终端。 */
  terminalOnly: boolean;
  /** 干完/出错时的结论或原因（结果卡用），可能为空。 */
  result: string;
  /** 派活输出里识别出的测试摘要行。 */
  tests: string[];
  /** 派活的任务开头；会话是空串。 */
  task: string;
  /** 派活开工时的工作区：当时已有几个未提交文件。会话、旧记录、非 git 目录没有。 */
  baseline?: { head: string; dirty: number };
}

export interface WorkbenchSnapshot {
  items: WorkbenchItem[];
  counts: Record<WorkbenchKind, number>;
  /** 「2 个等你 · 1 个干完」；没事是空串。 */
  summary: string;
  at: number;
}

export interface WorkbenchConfig {
  /** 「在编辑器打开」用的命令，默认 code（2026-11-12 用户定）。 */
  editor: string;
}

export interface WorkbenchState extends WorkbenchSnapshot {
  config: WorkbenchConfig;
}

export function emptyWorkbenchState(): WorkbenchState {
  return { ...emptyWorkbench(), config: { editor: 'code' } };
}

/** key → 看过的时刻。只要看过的时刻不早于进入状态的时刻，就算看过了。 */
export type WorkbenchSeen = Record<string, number>;

export interface DelegateView {
  busy: boolean;
  current: { at: number; target: string; project: string; cwd: string; task: string } | null;
  history: readonly DelegateRecord[];
}

export function emptyWorkbench(at = 0): WorkbenchSnapshot {
  return { items: [], counts: countsOf([]), summary: '', at };
}

function countsOf(items: readonly WorkbenchItem[]): Record<WorkbenchKind, number> {
  const counts = { waiting: 0, error: 0, unseen: 0, working: 0, idle: 0 };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

export function workbenchSummary(counts: Record<WorkbenchKind, number>): string {
  const parts: string[] = [];
  if (counts.waiting > 0) parts.push(`${counts.waiting} 个等你`);
  if (counts.error > 0) parts.push(`${counts.error} 个出错`);
  if (counts.unseen > 0) parts.push(`${counts.unseen} 个待看`);
  if (parts.length === 0 && counts.working > 0) parts.push(`${counts.working} 个在干`);
  return parts.join(' · ');
}

function seenSince(seen: WorkbenchSeen, key: string, at: number): boolean {
  const value = seen[key];
  return typeof value === 'number' && value >= at;
}

function titleOf(project: string, agent: string): string {
  return project ? `${project} · ${agent}` : agent;
}

export function buildWorkbench(input: {
  progress: WorkProgressState;
  delegate: DelegateView;
  seen: WorkbenchSeen;
  now: number;
}): WorkbenchSnapshot {
  const { now, seen } = input;
  const items: WorkbenchItem[] = [];
  const current = input.delegate.busy ? input.delegate.current : null;

  // 芯伴派出去的活也会走钩子：带着派活 ID 的会话并进派活那一条，不单独列、不重复计数。
  // 对不上任何派活记录的（记录已滚出）照常当会话显示。
  const jobs = new Set<string>(input.delegate.history.map((record) => String(record.at)));
  if (current !== null) jobs.add(String(current.at));
  const linkedWaiting = new Map<string, WorkSession>();

  for (const session of input.progress.sessions) {
    if (session.delegateId !== undefined && jobs.has(session.delegateId)) {
      const at = session.signalAt ?? session.updatedAt;
      if (session.signal === 'waiting' && now - at <= hookLimits.waitingFreshMs) {
        linkedWaiting.set(session.delegateId, session);
      }
      continue;
    }
    const agent = session.source ?? 'WorkBuddy';
    const key = `${agent}:${session.sessionId}`;
    const at = session.signalAt ?? session.updatedAt;
    let kind: WorkbenchKind;
    let detail = '';
    let result = '';
    if (session.signal === 'waiting' && now - at <= hookLimits.waitingFreshMs) {
      kind = 'waiting';
      detail = session.signalDetail ? `在等你：${session.signalDetail}` : '在等你';
    } else if (session.signal === 'done') {
      kind = seenSince(seen, key, at) ? 'idle' : 'unseen';
      result = clipText(session.lastAssistantText, 600);
      detail = result ? clipText(result, 60) : '这一轮结束了';
    } else if (session.signal === 'working' || session.status === 'working') {
      kind = 'working';
      detail = shortActivity(session);
    } else {
      kind = 'idle';
      detail = session.lastAssistantText ? clipText(session.lastAssistantText, 60) : '';
    }
    items.push({
      key,
      kind,
      origin: 'session',
      agent,
      project: session.project,
      cwd: session.cwd,
      title: titleOf(session.project, agent),
      detail,
      at,
      terminalOnly: agent === 'Codex',
      result,
      tests: [],
      task: '',
    });
  }

  if (current !== null) {
    // 派出去的活卡在权限请求上：这一条就是「等你」。
    const waiting = linkedWaiting.get(String(current.at));
    items.push({
      key: `delegate:${current.at}`,
      kind: waiting ? 'waiting' : 'working',
      origin: 'delegate',
      agent: current.target,
      project: current.project,
      cwd: current.cwd,
      title: titleOf(current.project, current.target),
      detail: waiting
        ? waiting.signalDetail
          ? `在等你：${waiting.signalDetail}`
          : '在等你'
        : clipText(`派的活：${current.task}`, 60),
      at: waiting ? (waiting.signalAt ?? current.at) : current.at,
      terminalOnly: waiting !== undefined && current.target === 'Codex',
      result: '',
      tests: [],
      task: current.task,
    });
  }
  for (const record of input.delegate.history) {
    if (record.outcome === 'cancelled') continue;
    if (now - record.at > progressWindow.forgetMs) continue;
    const key = `delegate:${record.at}`;
    if (current !== null && key === `delegate:${current.at}`) continue;
    const done = record.at + record.ms;
    if (seenSince(seen, key, done)) continue;
    const failed = record.outcome !== 'ok';
    const result = failed ? record.error : (record.summary ?? '');
    items.push({
      key,
      kind: failed ? 'error' : 'unseen',
      origin: 'delegate',
      agent: record.target,
      project: record.project,
      cwd: record.cwd ?? '',
      title: titleOf(record.project, record.target),
      detail: failed
        ? clipText(record.error || '没干成', 60)
        : clipText(result || `这轮结束了：${record.task}`, 60),
      at: done,
      terminalOnly: false,
      result,
      tests: record.tests ?? [],
      task: record.task,
      ...(record.baseline ? { baseline: { ...record.baseline } } : {}),
    });
  }

  const rank = (kind: WorkbenchKind): number => workbenchKinds.indexOf(kind);
  items.sort((a, b) => rank(a.kind) - rank(b.kind) || b.at - a.at);
  const kept = items.slice(0, workbenchLimits.maxItems);
  const counts = countsOf(items);
  return { items: kept, counts, summary: workbenchSummary(counts), at: now };
}

/** 记一笔「看过了」，顺手丢掉太旧的。 */
export function markSeen(seen: WorkbenchSeen, key: string, now: number): WorkbenchSeen {
  const entries = Object.entries({ ...seen, [key]: now })
    .filter(([, at]) => now - at <= workbenchLimits.seenKeepMs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, workbenchLimits.maxSeen);
  return Object.fromEntries(entries);
}

export function normalizeSeen(raw: unknown): WorkbenchSeen {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: WorkbenchSeen = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length > 200 || typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 等了 2 分钟以上、你还没点开看的：桌宠提醒一次。
 * key 里带进入等待的时刻，同一次等待只提一次；走现有打扰预算，勿扰时不出声。
 */
export function longWaitNudges(
  snapshot: WorkbenchSnapshot,
  seen: WorkbenchSeen,
  now: number,
): NudgeEvent[] {
  return snapshot.items
    .filter(
      (item) =>
        item.kind === 'waiting' &&
        now - item.at >= workbenchLimits.longWaitMs &&
        !seenSince(seen, item.key, item.at),
    )
    .map((item) => ({
      kind: 'agent-waiting' as const,
      key: `waiting-long:${item.key}:${item.at}`,
      subject: item.title,
      source: item.agent,
    }));
}
