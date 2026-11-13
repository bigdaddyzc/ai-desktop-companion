import { z } from 'zod';
import { parseLines } from './progress';

/**
 * 替你确认：Claude Code / WorkBuddy / CodeBuddy 弹权限窗时，芯伴替你点「批准」。
 *
 * 规则（用户 2026-11-09 定的）：
 * - 默认问你。你在某个项目里批过一次某类操作，芯伴记下；之后同项目同类操作由芯伴批准。
 * - 删文件、git push / reset --hard / 强制覆盖、装卸软件包、改项目外的文件、碰密钥、
 *   联网上传、芯伴认不出的命令：永远问你。
 * - 芯伴没开或判断不了：什么都不做，对方照常弹窗。
 *
 * 「是不是高风险、算哪一类」的判定在钩子脚本里（src/desktop/hook/xinban-hook.cjs），
 * 因为批准必须在对方的进程里当场给出。这里管的是「你批过什么」：
 * 从收件箱里的事件学会你的批准、撤销、开关。只有主进程写 approve.json。
 */

export type ApprovalSource = 'claude-code' | 'workbuddy';

export interface ApprovalGrant {
  source: ApprovalSource;
  /** 项目目录（钩子报上来的 cwd，原样保存，比较时统一大小写与斜杠）。 */
  project: string;
  /** 同类操作的名字，例如「npm test」「改文件」「打开网页 github.com」。 */
  key: string;
  at: number;
}

export interface ApprovalState {
  v: 1;
  /**
   * 规则修订号。判定规则收紧时加一：旧修订号下学到的授权可能是按旧规则放进来的，
   * 加载时一律清空并关闭，等你重新打开。
   */
  rev: number;
  enabled: boolean;
  grants: ApprovalGrant[];
  /** 已经从收件箱学到哪个时刻：撤销之后不会被旧事件重新学回来。 */
  learnedThrough: number;
}

export const approvalLimits = {
  maxGrants: 300,
  /** 心跳周期；钩子脚本认 150 秒内的心跳为「芯伴开着」。 */
  heartbeatMs: 60_000,
  /** 权限请求之后多久内跑起来，才算「你批准了这一次」。 */
  learnWindowMs: 30 * 60_000,
} as const;

/**
 * 2（2026-11-10）：钩子 v4 堵住了进程替换、前缀变量、PowerShell 子表达式等绕过，
 * 学习改为按参数指纹配对。之前学到的授权不再可信。
 */
export const APPROVAL_REV = 2;

export const defaultApproval: ApprovalState = {
  v: 1,
  rev: APPROVAL_REV,
  enabled: false,
  grants: [],
  learnedThrough: 0,
};

const grantSchema = z.object({
  source: z.enum(['claude-code', 'workbuddy']),
  project: z.string().min(1).max(600),
  key: z.string().min(1).max(80),
  at: z.number().finite(),
});

const stateSchema = z.object({
  v: z.literal(1),
  rev: z.number().int().optional(),
  enabled: z.boolean(),
  grants: z.array(z.unknown()).max(1_000),
  learnedThrough: z.number().finite().optional(),
});

/** 文件坏了、被手改了：一律回到「关着、什么都没批过」。默认值本身就是不替你批。 */
export function normalizeApproval(raw: unknown): ApprovalState {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) return { ...defaultApproval, grants: [] };
  if ((parsed.data.rev ?? 1) < APPROVAL_REV) {
    // 安全重置：关掉、忘掉授权；保留 learnedThrough，旧事件不会被重新学回来。
    return { ...defaultApproval, grants: [], learnedThrough: parsed.data.learnedThrough ?? 0 };
  }
  const grants: ApprovalGrant[] = [];
  for (const item of parsed.data.grants) {
    const grant = grantSchema.safeParse(item);
    if (grant.success && !grants.some((g) => sameGrant(g, grant.data))) grants.push(grant.data);
  }
  return {
    v: 1,
    rev: APPROVAL_REV,
    enabled: parsed.data.enabled,
    grants: grants.slice(-approvalLimits.maxGrants),
    learnedThrough: parsed.data.learnedThrough ?? 0,
  };
}

/** 和钩子脚本同一种比较口径：小写、正斜杠、去掉结尾斜杠。 */
export function projectKey(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function sameGrant(
  a: Pick<ApprovalGrant, 'source' | 'project' | 'key'>,
  b: Pick<ApprovalGrant, 'source' | 'project' | 'key'>,
): boolean {
  return (
    a.source === b.source && a.key === b.key && projectKey(a.project) === projectKey(b.project)
  );
}

export interface ApprovalEvent {
  at: number;
  source: ApprovalSource;
  sessionId: string;
  project: string;
  kind: 'request' | 'used';
  tool: string;
  keys: string[];
  risk: string;
  auto: boolean;
  /** 工具参数指纹（钩子 v4 起才有）；请求与执行指纹一致才算同一条。 */
  fp: string;
}

function sourceOf(src: unknown): ApprovalSource | null {
  if (src === 'claude') return 'claude-code';
  if (src === 'workbuddy') return 'workbuddy';
  return null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '').slice(0, 6)
    : [];
}

/** 收件箱里和「替你确认」有关的两类记录：权限请求、工具已经跑完。 */
export function parseApprovalEvents(raw: string): ApprovalEvent[] {
  const events: ApprovalEvent[] = [];
  for (const record of parseLines(raw)) {
    if (record['v'] !== 1) continue;
    const source = sourceOf(record['src']);
    const ev = record['ev'];
    const at = record['at'];
    const sessionId = record['sid'];
    if (source === null || typeof at !== 'number' || typeof sessionId !== 'string') continue;
    if (ev !== 'PermissionRequest' && ev !== 'PostToolUse') continue;
    events.push({
      at,
      source,
      sessionId,
      project: typeof record['cwd'] === 'string' ? record['cwd'] : '',
      kind: ev === 'PermissionRequest' ? 'request' : 'used',
      tool: typeof record['tool'] === 'string' ? record['tool'] : '',
      keys: strings(record['keys']),
      risk: typeof record['risk'] === 'string' ? record['risk'] : '',
      auto: record['auto'] === true,
      fp: typeof record['fp'] === 'string' ? record['fp'] : '',
    });
  }
  return events.sort((a, b) => a.at - b.at);
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key));
}

/**
 * 从事件里学你的批准：弹了权限窗（且不是芯伴批的、不是高风险），
 * 之后同一会话里同一工具、参数指纹完全一致的那一条真的跑了 → 是你点了批准。
 * 你点了拒绝就不会有「跑了」这一条，自然学不到；它随后跑了别的命令也配不上。
 * 开关关着时不学：只推进 learnedThrough，打开之前的批准不会变成授权。
 *
 * 只学 learnedThrough 之后发生的「跑了」；请求可以稍早（在学习窗口内），
 * 这样请求和执行分两次刷新到达也能配上。
 */
export function learnApprovals(
  state: ApprovalState,
  events: readonly ApprovalEvent[],
): ApprovalState {
  if (events.length === 0) return state;
  const latest = events[events.length - 1]!.at;
  if (latest <= state.learnedThrough) return state;
  if (!state.enabled) return { ...state, learnedThrough: latest };
  const grants = [...state.grants];
  const pending = new Map<string, ApprovalEvent>();
  for (const event of events) {
    if (event.at < state.learnedThrough - approvalLimits.learnWindowMs) continue;
    // 并行的同名工具调用各有各的指纹，互不覆盖。
    const slot = `${event.source}:${event.sessionId}:${event.tool}:${event.fp}`;
    if (event.kind === 'request') {
      if (
        !event.auto &&
        event.risk === '' &&
        event.keys.length > 0 &&
        event.project !== '' &&
        event.fp !== ''
      ) {
        pending.set(slot, event);
      } else pending.delete(slot);
      continue;
    }
    const request = pending.get(slot);
    if (request === undefined) continue;
    if (
      event.at - request.at > approvalLimits.learnWindowMs ||
      event.fp !== request.fp ||
      !sameKeys(request.keys, event.keys)
    ) {
      continue;
    }
    pending.delete(slot);
    if (event.at <= state.learnedThrough) continue;
    for (const key of request.keys) {
      const grant = { source: request.source, project: request.project, key, at: event.at };
      if (!grants.some((g) => sameGrant(g, grant))) grants.push(grant);
    }
  }
  return {
    ...state,
    grants: grants.slice(-approvalLimits.maxGrants),
    learnedThrough: latest,
  };
}

export function revokeApproval(
  state: ApprovalState,
  target: Pick<ApprovalGrant, 'source' | 'project' | 'key'>,
): ApprovalState {
  return { ...state, grants: state.grants.filter((grant) => !sameGrant(grant, target)) };
}

export interface AutoApproval {
  at: number;
  source: ApprovalSource;
  project: string;
  keys: string[];
}

/** 最近几次芯伴替你批的：面板上可查。 */
export function recentAutoApprovals(events: readonly ApprovalEvent[], limit = 8): AutoApproval[] {
  return events
    .filter((event) => event.kind === 'request' && event.auto)
    .slice(-limit)
    .reverse()
    .map(({ at, source, project, keys }) => ({ at, source, project, keys }));
}

/** 面板与桌宠上的一句话。 */
export function autoApprovalText(keys: readonly string[]): string {
  return `已替你批准：${keys.join('、') || '一项操作'}`;
}

export interface ApprovalView {
  enabled: boolean;
  grants: ApprovalGrant[];
  recent: AutoApproval[];
}
