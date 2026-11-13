import { z } from 'zod';

/**
 * AI 能力的纯领域部分：交互规格、端点校验、SSE 解码与错误脱敏。
 * 这一层不接触 API Key、不发起网络请求、不依赖 Electron，便于单测。
 *
 * 走的是 Responses API（见 core/responses.ts）。与旧实现相比：
 * 不再构造 chat/completions 请求，也不再解析 choices/delta 结构——
 * 那套协议没有工具调用条目，无法支撑多步 Agent。
 */

export const aiDefaults = {
  /** 用户保存的 base_url；Responses 端点由它推导 origin + /responses。 */
  baseUrl: 'https://api.deepseek.com/v1',
  /** 2026-11 官方模型名，对应 DeepSeek-V4.1-Flash；支持 function 工具。 */
  model: 'deepseek-flash',
  /** 单次模型请求的时限；整次 Agent 运行另有总时限。 */
  timeoutMs: 60_000,
  maxInputChars: 2_000,
  maxHistoryMessages: 12,
} as const;

/** 生产环境唯一允许的出站主机；测试可注入 loopback 白名单。 */
export const aiAllowedHosts = ['api.deepseek.com'] as const;

export const chatMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z
      .string()
      .min(1)
      .max(aiDefaults.maxInputChars * 2),
  })
  .strict();
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const aiConfigInputSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(300),
    model: z.string().trim().min(1).max(80),
    apiKey: z.string().trim().min(1).max(300),
  })
  .strict();
export type AiConfigInput = z.infer<typeof aiConfigInputSchema>;

export const aiChatInputSchema = z
  .object({
    text: z.string().trim().min(1).max(aiDefaults.maxInputChars),
    history: z.array(chatMessageSchema).max(aiDefaults.maxHistoryMessages),
    /** 附件说明（含已包成不可信数据的文本内容），只跟在这一句后面发，不进历史。 */
    attachments: z.string().max(80_000).optional(),
  })
  .strict();
export type AiChatInput = z.infer<typeof aiChatInputSchema>;

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
export interface AiUsageSummary extends AiUsage {
  requests: number;
}
export const emptyUsageSummary = (): AiUsageSummary => ({
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});
export interface AiStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
  busy: boolean;
  /** 本次运行的累计用量，只在内存中，不持久化、不导出。 */
  usage: AiUsageSummary;
  /** 本次运行里工具调用的累计次数；用于让用户知道「它真的动手了」。 */
  toolCalls: number;
}
export interface AiPublicConfig {
  baseUrl: string;
  model: string;
}
export type AiChatResult = { ok: true; text: string } | { ok: false; error: string };
export type AiActionResult = { ok: true } | { ok: false; error: string };

/** 端点白名单校验：只允许 https；loopback 例外仅用于注入测试。 */
export function isAllowedEndpoint(raw: string, allowedHosts: readonly string[]): boolean {
  try {
    const url = new URL(raw);
    if (url.username !== '' || url.password !== '') return false;
    if (!allowedHosts.includes(url.hostname)) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 增量 SSE 解码器。网络分片可能截断在任意位置（甚至一个事件中间），
 * 因此必须缓冲到完整空行才产出一个事件；不假设「一个 chunk = 一条消息」。
 *
 * 只收集 data 行：Responses API 的事件类型在载荷 JSON 的 type 字段里，
 * SSE 的 event: 行对我们没有额外信息。
 */
export function createSseDecoder(): {
  push(chunk: string): string[];
  flush(): string[];
} {
  let buffer = '';
  let dataLines: string[] = [];
  const take = (): string | null => {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join('\n');
    dataLines = [];
    return payload;
  };
  const drain = (final: boolean): string[] => {
    const events: string[] = [];
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        const event = take();
        if (event !== null) events.push(event);
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      newline = buffer.indexOf('\n');
    }
    if (final) {
      const rest = buffer.trim();
      buffer = '';
      if (rest.startsWith('data:')) dataLines.push(rest.slice(5).replace(/^ /, ''));
      const event = take();
      if (event !== null) events.push(event);
    }
    return events;
  };
  return {
    push(chunk) {
      buffer += chunk;
      return drain(false);
    },
    flush() {
      return drain(true);
    },
  };
}

/** 流式中断（取消／超时／连接断开）时明确说明内容不完整，不把半截文字当成完整回复。 */
export function describeStreamFailure(kind: 'timeout' | 'cancelled' | 'network'): string {
  if (kind === 'cancelled') return '已取消本次请求，半截回复已丢弃。';
  if (kind === 'timeout') return '回复超时中断，半截内容已丢弃。';
  return '流式连接中断，半截内容已丢弃。';
}

/**
 * HTTP 错误只给可操作提示，绝不回显响应体或请求头：
 * 响应体可能包含服务端细节，请求头含 API Key。
 */
export function describeHttpError(status: number): string {
  if (status === 400) return '请求参数不被接受，请检查模型名与 Base URL。';
  if (status === 401) return 'API Key 无效或已撤销，请在配置中更新。';
  if (status === 402) return '账户余额不足，请检查 DeepSeek 账户。';
  if (status === 403) return '该 Key 无权访问此模型或端点。';
  if (status === 404) return '找不到接口，请检查 Base URL（应为 https://api.deepseek.com）。';
  if (status === 429) return '请求被限流，请稍后再试。';
  if (status >= 500) return 'DeepSeek 服务暂时不可用，请稍后再试。';
  return `请求失败（HTTP ${status}）。`;
}

/** 网络层异常统一脱敏，不把底层错误文本（可能带 URL）交给界面。 */
export function describeNetworkFailure(kind: 'timeout' | 'cancelled' | 'network'): string {
  if (kind === 'timeout') return '请求超时，已停止等待；没有产生回复。';
  if (kind === 'cancelled') return '已取消本次请求。';
  return '无法连接 DeepSeek 服务，请检查网络后重试。';
}
