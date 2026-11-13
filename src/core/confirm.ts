/**
 * 逐次确认：动手之前先问一句。
 *
 * 哪些要问：跑命令（任意代码执行）、看屏幕/摄像头（画面出本机）、派活（外部 Agent 会自己改文件）、
 * 发飞书（消息出本机、发出去撤不回）。
 * 怎么问：小屏亮出一张卡片，A 允许 / B 拒绝；面板里也能点；实体按键同样生效。
 * 没人理：超时视为拒绝——宁可不做，也不替你做主。
 *
 * 纯领域层：只有类型、上限与展示文案，等待与计时在 desktop/confirm.ts。
 */

export type ConfirmTool =
  | 'run_command'
  | 'shell_command'
  | 'look'
  | 'delegate_task'
  | 'write_file'
  | 'edit_file'
  | 'mcp'
  /** 发到用户配好的飞书群机器人：内容出本机、群里的人都看得见。 */
  | 'send_feishu'
  /** 外部 Agent（Claude Code / WorkBuddy）的权限请求，见 agent-permission.ts。 */
  | 'agent_permission';

export interface ConfirmRequest {
  tool: ConfirmTool;
  /** 一句话：它想干什么。小屏只放得下这一句。 */
  title: string;
  /** 具体内容：命令原文、要派的活、要问画面的问题。 */
  detail: string;
  /**
   * 外部 Agent 的请求：超时交回终端而不是拒绝；卡上多「交回终端」，
   * canRemember 时还有「以后同类都批」。
   */
  external?: { canRemember: boolean };
}

export interface PendingConfirm extends ConfirmRequest {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export type ConfirmOutcome =
  | 'allowed'
  | 'denied'
  | 'expired'
  | 'cancelled'
  /** 外部请求：你点了「交回终端」、或没人理、或排队满了。 */
  | 'deferred'
  /** 外部请求：允许，并把同类操作加进替你确认。 */
  | 'remembered';

export interface ConfirmRecord {
  id: string;
  tool: ConfirmTool;
  title: string;
  detail: string;
  outcome: ConfirmOutcome;
  at: number;
}

export interface ConfirmSnapshot {
  /** 正在等你回答的那一条；同一时刻只亮一条。 */
  pending: PendingConfirm | null;
  /** 后面还排着几条。 */
  queued: number;
  /** 最近几次的结果，面板里可以回看。 */
  recent: ConfirmRecord[];
}

export const confirmLimits = {
  /** 等你多久。太短来不及看屏幕，太长对话就一直挂着。 */
  timeoutMs: 60_000,
  recent: 10,
  /** 排队上限：模型一口气要问十次，多出来的直接拒绝。 */
  queue: 4,
  /**
   * 卡片详情的硬上限。详情一律原文展示、绝不截断：截掉的尾巴里可能藏着 `&& rm -rf`。
   * 放不下的请求在问你之前就退回给模型，让它拆小。
   */
  maxDetail: 800,
  /**
   * 实体小屏一帧最多放这么多字的详情（见 device-protocol 的 compactView）。
   * 更长的，小屏上只能拒绝、不能允许——没看全就点头等于替你做主。
   */
  deviceDetail: 24,
} as const;

/** 实体小屏放不下全文：只能在桌面（面板或桌宠）上允许。 */
export function needsFullScreen(request: Pick<ConfirmRequest, 'detail'>): boolean {
  // v1 实体字库不能保证任意 Unicode/控制字符原样可见。只有短的可打印 ASCII
  // 允许在设备上批准；中文/多行/特殊字符仍可预览，但必须到桌面看完整原文。
  return request.detail.length > confirmLimits.deviceDetail || /[^\x20-\x7e]/.test(request.detail);
}

export function emptyConfirm(): ConfirmSnapshot {
  return { pending: null, queued: 0, recent: [] };
}

export const confirmOutcomeLabels: Record<ConfirmOutcome, string> = {
  allowed: '允许了',
  denied: '拒绝了',
  expired: '没回应，已拒绝',
  cancelled: '对话取消了',
  deferred: '交回终端了',
  remembered: '允许了，以后同类都批',
};

/** 剩余秒数，小屏上倒数用。 */
export function secondsLeft(pending: PendingConfirm, now: number): number {
  return Math.max(0, Math.ceil((pending.expiresAt - now) / 1_000));
}
