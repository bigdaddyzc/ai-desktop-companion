import { z } from 'zod';
import { hookTargets, isHookTarget, type HookTarget, type HooksStatus } from './hook-install';

/**
 * 钩子自检：装过的钩子被别人改掉了，要知道、要说、（你同意后）要自己修。
 *
 * 为什么需要：cc-switch 这类工具在「异常退出恢复」时会把 ~/.claude/settings.json 整个
 * 还原成它自己备份的版本，芯伴的钩子就没了——之后整整几天收不到任何事件，没人发现。
 *
 * 规则（用户 2026-11-10 定）：第一次发现丢了先问你；你同意重装一次，之后就自动重装。
 * 「该有哪些」只认你亲手装过的：你卸载的不会被装回去。
 * 纯领域层：只有状态、判定与归一化，定时与文件在 desktop/hook-watch.ts。
 */

export type HookRepairConsent = 'ask' | 'auto';

export interface HookWatchState {
  v: 1;
  /** 你装过、该一直在的钩子。 */
  expected: HookTarget[];
  consent: HookRepairConsent;
  /** 第一次运行时从现状与收件箱推断过 expected 了。 */
  seeded: boolean;
}

export interface HookRepairRecord {
  at: number;
  targets: HookTarget[];
  ok: boolean;
  /** 自动重装还是你点的。 */
  auto: boolean;
  error: string;
}

export interface HookWatchSnapshot {
  expected: HookTarget[];
  consent: HookRepairConsent;
  /** 现在丢了的（应在但不在）。 */
  lost: HookTarget[];
  /** 丢了但修不了的：配置文件读不懂、或者有你自己的 notify。 */
  blocked: HookTarget[];
  lastCheckAt: number;
  lastRepair: HookRepairRecord | null;
}

export const hookWatchLimits = {
  /** 自检周期。 */
  intervalMs: 5 * 60_000,
  /** 自动重装之间至少隔这么久：别和一个反复还原配置的工具拉锯。 */
  repairCooldownMs: 10 * 60_000,
} as const;

export const defaultHookWatch: HookWatchState = {
  v: 1,
  expected: [],
  consent: 'ask',
  seeded: false,
};

const stateSchema = z.object({
  v: z.literal(1),
  expected: z.array(z.string()).max(10),
  consent: z.enum(['ask', 'auto']),
  seeded: z.boolean(),
});

export function normalizeHookWatch(raw: unknown): HookWatchState {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) return { ...defaultHookWatch, expected: [] };
  return {
    v: 1,
    expected: hookTargets.filter((target) => parsed.data.expected.includes(target)),
    consent: parsed.data.consent,
    seeded: parsed.data.seeded,
  };
}

const statusKey: Record<HookTarget, keyof Omit<HooksStatus, 'node' | 'lastEventAt'>> = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  workbuddy: 'workbuddy',
  codebuddy: 'codebuddy',
};

export function targetStatus(status: HooksStatus, target: HookTarget) {
  return status[statusKey[target]];
}

/**
 * 第一次运行：哪些钩子「本该在」。
 * 现在装着的算；收件箱里出现过对应来源事件的也算——说明装过、后来丢了（正是要发现的情况）。
 * WorkBuddy 桌面版与 CodeBuddy 命令行共用 workbuddy 来源，分不清，只认现在装着的。
 */
export function seedExpected(status: HooksStatus, inboxText: string): HookTarget[] {
  const seen = new Set<HookTarget>();
  for (const target of hookTargets) {
    if (targetStatus(status, target).status === 'installed') seen.add(target);
  }
  if (/"src":"claude"/.test(inboxText)) seen.add('claude-code');
  if (/"src":"codex"/.test(inboxText)) seen.add('codex');
  return hookTargets.filter((target) => seen.has(target));
}

/** 该在但不在的；分成「能修」与「修不了」。 */
export function findLost(
  status: HooksStatus,
  expected: readonly HookTarget[],
): { lost: HookTarget[]; blocked: HookTarget[] } {
  const lost: HookTarget[] = [];
  const blocked: HookTarget[] = [];
  for (const target of expected) {
    const item = targetStatus(status, target);
    if (item.status === 'installed') continue;
    if (item.status === 'conflict' || item.status === 'unreadable') blocked.push(target);
    else lost.push(target);
  }
  return { lost, blocked };
}

export const hookTargetLabels: Record<HookTarget, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  workbuddy: 'WorkBuddy',
  codebuddy: 'CodeBuddy 命令行',
};

export function lostText(targets: readonly HookTarget[]): string {
  return targets.map((target) => hookTargetLabels[target]).join('、');
}

export function isTargetList(value: unknown): value is HookTarget[] {
  return Array.isArray(value) && value.every(isHookTarget);
}
