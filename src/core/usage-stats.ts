import type { ConfirmOutcome } from './confirm';
import type { DelegateRecord } from './delegate';
import type { WorkbenchSnapshot } from './workbench';

/**
 * 自用两周的四个计数（M7）。只记次数和时长，不记命令、项目、内容。
 * 按周（周一起，本地时间）分桶，留最近 4 周。纯领域层。
 */

export const usageLimits = {
  keepWeeks: 4,
  /** 中位数用的响应时间样本，每周最多留这么多。 */
  maxSamples: 500,
  /** 两次观察间隔超过这个就不累加（睡眠、芯伴没开）。 */
  maxGapMs: 2 * 60_000,
} as const;

export interface UsageWeek {
  /** 周一的本地日期，例如 2026-11-09。 */
  week: string;
  /** 芯伴上答了的（允许/拒绝/以后同类都批）。 */
  caught: number;
  /** 交回终端的（没人理、点了交回、远程批准关着）。 */
  handedBack: number;
  /** 从出卡到你按下的毫秒数。 */
  responseMs: number[];
  /** Agent 在等你的累计毫秒。 */
  waitingMs: number;
  delegates: number;
  delegatesOk: number;
}

export interface UsageState {
  v: 1;
  weeks: UsageWeek[];
  /** 已统计到的最新派活记录时刻，避免重启后重复计。 */
  lastDelegateAt: number;
}

export interface UsageWeekView {
  week: string;
  caught: number;
  handedBack: number;
  /** 芯伴接住占全部权限请求的比例，0–1；没有请求是 null。 */
  caughtRate: number | null;
  medianResponseMs: number | null;
  waitingMs: number;
  delegates: number;
  delegateOkRate: number | null;
}

export function emptyUsage(): UsageState {
  return { v: 1, weeks: [], lastDelegateAt: 0 };
}

const pad = (value: number): string => `${value}`.padStart(2, '0');

export function weekOf(at: number): string {
  const day = new Date(at);
  const offset = (day.getDay() + 6) % 7;
  const monday = new Date(day.getFullYear(), day.getMonth(), day.getDate() - offset);
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

function emptyWeek(week: string): UsageWeek {
  return {
    week,
    caught: 0,
    handedBack: 0,
    responseMs: [],
    waitingMs: 0,
    delegates: 0,
    delegatesOk: 0,
  };
}

/** 取出（没有就建）当周的桶，顺手丢掉太旧的。返回新 state 与桶。 */
function bucket(state: UsageState, at: number): [UsageState, UsageWeek] {
  const week = weekOf(at);
  const found = state.weeks.find((item) => item.week === week);
  if (found) return [state, found];
  const created = emptyWeek(week);
  const weeks = [...state.weeks, created]
    .sort((a, b) => b.week.localeCompare(a.week))
    .slice(0, usageLimits.keepWeeks);
  return [{ ...state, weeks }, created];
}

function update(state: UsageState, at: number, change: (week: UsageWeek) => UsageWeek): UsageState {
  const [next, week] = bucket(state, at);
  const changed = change(week);
  return { ...next, weeks: next.weeks.map((item) => (item.week === week.week ? changed : item)) };
}

/** 远程批准的一次结果。dismissed（对方自己走了）不计。 */
export function recordPermission(
  state: UsageState,
  outcome: ConfirmOutcome,
  ms: number,
  at: number,
): UsageState {
  if (outcome === 'allowed' || outcome === 'denied' || outcome === 'remembered') {
    return update(state, at, (week) => ({
      ...week,
      caught: week.caught + 1,
      responseMs: [...week.responseMs, Math.max(0, Math.round(ms))].slice(-usageLimits.maxSamples),
    }));
  }
  if (outcome === 'deferred' || outcome === 'expired') {
    return update(state, at, (week) => ({ ...week, handedBack: week.handedBack + 1 }));
  }
  return state;
}

/** 派活记录里新增的（比 lastDelegateAt 新的）计一次；取消的不计。 */
export function recordDelegates(state: UsageState, history: readonly DelegateRecord[]): UsageState {
  let next = state;
  const fresh = history.filter((item) => item.at > state.lastDelegateAt);
  for (const item of fresh) {
    if (item.outcome === 'cancelled') continue;
    next = update(next, item.at, (week) => ({
      ...week,
      delegates: week.delegates + 1,
      delegatesOk: week.delegatesOk + (item.outcome === 'ok' ? 1 : 0),
    }));
  }
  if (fresh.length === 0) return state;
  return { ...next, lastDelegateAt: Math.max(...fresh.map((item) => item.at)) };
}

/** 两次观察之间，有几个 Agent 在等你就累加几倍的间隔。 */
export function recordWaiting(
  state: UsageState,
  snapshot: Pick<WorkbenchSnapshot, 'counts'>,
  sinceMs: number,
  at: number,
): UsageState {
  const waiting = snapshot.counts.waiting;
  if (waiting <= 0 || sinceMs <= 0 || sinceMs > usageLimits.maxGapMs) return state;
  return update(state, at, (week) => ({ ...week, waitingMs: week.waitingMs + waiting * sinceMs }));
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function weekView(week: UsageWeek): UsageWeekView {
  const total = week.caught + week.handedBack;
  return {
    week: week.week,
    caught: week.caught,
    handedBack: week.handedBack,
    caughtRate: total === 0 ? null : week.caught / total,
    medianResponseMs: median(week.responseMs),
    waitingMs: week.waitingMs,
    delegates: week.delegates,
    delegateOkRate: week.delegates === 0 ? null : week.delegatesOk / week.delegates,
  };
}

/** 面板看的：本周和上周（没有就是空桶）。 */
export function usageView(state: UsageState, now: number): UsageWeekView[] {
  const thisWeek = weekOf(now);
  const lastWeek = weekOf(now - 7 * 24 * 60 * 60_000);
  return [thisWeek, lastWeek].map((key) =>
    weekView(state.weeks.find((item) => item.week === key) ?? emptyWeek(key)),
  );
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function normalizeUsage(raw: unknown): UsageState {
  if (typeof raw !== 'object' || raw === null) return emptyUsage();
  const record = raw as Record<string, unknown>;
  const weeks = Array.isArray(record['weeks']) ? record['weeks'] : [];
  return {
    v: 1,
    lastDelegateAt: count(record['lastDelegateAt']),
    weeks: weeks
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>)['week'] === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test((item as Record<string, unknown>)['week'] as string),
      )
      .slice(0, usageLimits.keepWeeks)
      .map((item) => ({
        week: item['week'] as string,
        caught: count(item['caught']),
        handedBack: count(item['handedBack']),
        responseMs: (Array.isArray(item['responseMs']) ? item['responseMs'] : [])
          .map(count)
          .slice(-usageLimits.maxSamples),
        waitingMs: count(item['waitingMs']),
        delegates: count(item['delegates']),
        delegatesOk: count(item['delegatesOk']),
      })),
  };
}
