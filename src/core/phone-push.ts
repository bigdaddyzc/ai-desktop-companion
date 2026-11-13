import type { WorkbenchItem, WorkbenchSnapshot } from './workbench';

/**
 * 离开电脑时推到手机（M5）。先做飞书群机器人，接口留好以后加别的通道。
 *
 * 只推标题（「Claude Code 在 xinban 项目等你批准」），不推命令原文、代码、对话；
 * 不做手机端批准。纯领域层。
 */

export type PushChannel = 'feishu';

export const phonePushLimits = {
  idleChoicesMin: [3, 5, 10, 15, 30] as readonly number[],
  defaultIdleMin: 5,
  /** 同一会话 10 分钟内不重复推。 */
  repeatMs: 10 * 60_000,
  /** 离开前不久发生的也算：刚起身它就开始等你。 */
  graceMs: 2 * 60_000,
  maxLines: 5,
  timeoutMs: 8_000,
} as const;

export interface PhonePushConfig {
  enabled: boolean;
  idleMinutes: number;
  channel: PushChannel;
}

/** 面板看到的：地址和密钥永远不回传，只说配没配。 */
export interface PhonePushView extends PhonePushConfig {
  configured: boolean;
  signed: boolean;
  /** 系统加密不可用时不让存地址。 */
  encryption: boolean;
  lastSentAt: number;
  lastError: string;
}

export interface PhonePushSaveInput {
  enabled: boolean;
  idleMinutes: number;
  /** undefined 不动；空串清除。 */
  webhook?: string;
  secret?: string;
}

export function defaultPhonePushConfig(): PhonePushConfig {
  return { enabled: false, idleMinutes: phonePushLimits.defaultIdleMin, channel: 'feishu' };
}

/**
 * 飞书/Lark 自定义机器人地址。只认官方域名：这是芯伴会自己去请求的地址，
 * 不能变成内网任意地址。
 */
export function webhookProblem(url: string): string {
  const value = url.trim();
  if (value === '') return '地址是空的。';
  if (
    !/^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{8,80}$/.test(
      value,
    )
  ) {
    return '不像飞书机器人地址：应该是 https://open.feishu.cn/open-apis/bot/v2/hook/…';
  }
  return '';
}

export function secretProblem(secret: string): string {
  if (secret === '') return '';
  if (secret.length > 128 || /\s/.test(secret)) return '签名密钥格式不对。';
  return '';
}

export function normalizeIdleMinutes(value: unknown): number {
  return typeof value === 'number' && phonePushLimits.idleChoicesMin.includes(value)
    ? value
    : phonePushLimits.defaultIdleMin;
}

/** 一行标题：只有 Agent、项目和状态。 */
export function pushTitle(
  item: Pick<WorkbenchItem, 'agent' | 'project' | 'kind' | 'terminalOnly'>,
): string {
  const where = item.project ? `在 ${item.project} 项目` : '';
  switch (item.kind) {
    case 'waiting':
      return item.terminalOnly
        ? `${item.agent} ${where}等你回终端批准`
        : `${item.agent} ${where}等你批准`;
    case 'error':
      return `${item.agent} ${where}没干成`;
    default:
      return `${item.agent} ${where}这一轮结束了，结果待看`;
  }
}

/** 记录：key → 上次推的时刻。 */
export type PushSent = Record<string, number>;

/**
 * 该推哪几条：电脑空闲够久、是等你/出错/干完没看、发生在你离开之后（宽限 2 分钟）、
 * 10 分钟内没推过。
 */
export function pushCandidates(input: {
  snapshot: WorkbenchSnapshot;
  config: PhonePushConfig;
  configured: boolean;
  idleMs: number;
  sent: PushSent;
  now: number;
}): WorkbenchItem[] {
  const { config, idleMs, now, sent } = input;
  if (!config.enabled || !input.configured) return [];
  if (idleMs < config.idleMinutes * 60_000) return [];
  const leftAt = now - idleMs - phonePushLimits.graceMs;
  return input.snapshot.items.filter((item) => {
    if (item.kind !== 'waiting' && item.kind !== 'error' && item.kind !== 'unseen') return false;
    if (item.at < leftAt) return false;
    const last = sent[item.key];
    return typeof last !== 'number' || now - last >= phonePushLimits.repeatMs;
  });
}

export function pushText(items: readonly WorkbenchItem[]): string {
  const lines = items.slice(0, phonePushLimits.maxLines).map(pushTitle);
  const more = items.length - lines.length;
  if (more > 0) lines.push(`还有 ${more} 个`);
  return `【芯伴】${lines.join('\n')}`;
}

/**
 * 聊天里让芯伴发一条飞书（send_feishu）。发前原文上确认卡，所以长度受卡片上限约束；
 * 统一加「【芯伴】」前缀：群机器人若设了关键词「芯伴」也能过。
 */
export const chatMessageMaxChars = 500;

export function chatMessageProblem(text: string): string {
  const value = text.trim();
  if (value === '') return '消息是空的。';
  if (value.length > chatMessageMaxChars) {
    return `消息太长（${value.length} 字），飞书消息最多 ${chatMessageMaxChars} 字，精简一下再发。`;
  }
  // 控制字符在卡片上看不见，不让它们混进外发内容。
  for (const char of value) {
    const code = char.charCodeAt(0);
    const visible =
      code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f);
    if (!visible) return '消息里有看不见的控制字符。';
  }
  return '';
}

export function chatMessageText(text: string): string {
  return `【芯伴】${text.trim()}`;
}

/** 去掉太旧的发送记录。 */
export function pruneSent(sent: PushSent, now: number): PushSent {
  return Object.fromEntries(
    Object.entries(sent).filter(([, at]) => now - at < phonePushLimits.repeatMs),
  );
}

/** 飞书文本消息体；有签名时带 timestamp 与 sign（签名在桌面层算）。 */
export function feishuBody(
  text: string,
  signature?: { timestamp: string; sign: string },
): Record<string, unknown> {
  return {
    ...(signature ? { timestamp: signature.timestamp, sign: signature.sign } : {}),
    msg_type: 'text',
    content: { text },
  };
}

/** 飞书返回：新版 {code:0}，旧版 {StatusCode:0}。 */
export function feishuError(status: number, body: unknown): string {
  if (status < 200 || status >= 300) return `飞书返回 HTTP ${status}。`;
  if (typeof body !== 'object' || body === null) return '';
  const record = body as Record<string, unknown>;
  const code = record['code'] ?? record['StatusCode'];
  if (code === undefined || code === 0) return '';
  const msg = typeof record['msg'] === 'string' ? record['msg'].slice(0, 80) : '';
  return `飞书拒了（${String(code)}${msg ? ` ${msg}` : ''}）：检查地址、签名和关键词设置。`;
}
