import { z } from 'zod';
import type { AiUsage } from './ai';
import { visibleText } from './dsml';

/**
 * DeepSeek Responses API 的纯协议层。
 *
 * 与 chat/completions 的关键差异（全部来自官方兼容性明细，不要凭印象假设）：
 * - 端点：base_url + `/responses`，而 base_url 是 `https://api.deepseek.com`（不带 /v1）。
 * - 无状态：`previous_response_id`、`conversation`、`store` 都不支持，`store` 恒为 false。
 *   每一轮必须由调用方把完整 input（含历史与工具结果）重新传回去。
 * - 流式是语义化事件（`type` / `event` 字段 + `sequence_number`），
 *   以 response.completed / incomplete / failed 收尾，**没有** `data: [DONE]`。
 * - 响应里是 `output` 条目数组，而不是 `choices[].message`。
 *
 * 这一层不接触 Key、不发网络请求，便于单测。
 */

/** 单次 Agent 请求的输出上限；工具调用需要留出余量，不沿用对话的 512。 */
export const responsesDefaults = {
  maxOutputTokens: 1_200,
  /** 一次用户提问最多允许的模型往返步数（每步可能包含多个并行工具调用）。 */
  maxSteps: 8,
  /** 一次提问里所有工具调用的总次数上限，防止被搜索结果牵着无限跑。 */
  maxToolCalls: 14,
  /** 整次 Agent 运行（含所有步与所有工具）的总时限。 */
  runTimeoutMs: 150_000,
  /** 单个网页正文塞进上下文的字符上限。 */
  maxPageChars: 6_000,
  /** 单次搜索结果保留条数上限。 */
  maxSearchResults: 5,
} as const;

/**
 * 推导 Responses 端点。
 *
 * 用户面板里保存的 baseUrl 常写成 `https://api.deepseek.com/v1`（chat/completions 的写法），
 * 而 Responses 的 base_url 是 `https://api.deepseek.com`。这里统一按 origin 拼接，
 * 避免出现 `/v1/responses` 这种未在文档中出现的路径。
 */
export function responsesEndpoint(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/responses`;
}

/** 官方 Search / Fetch 工具端点；同样只取 origin，路径固定为 /v1/tools/*。 */
export function toolEndpoint(baseUrl: string, path: string): string {
  if (!/^\/v1\/tools\/[a-z]+$/.test(path)) throw new Error('不允许的工具端点。');
  return `${new URL(baseUrl).origin}${path}`;
}

export interface ResponsesBodyInput {
  model: string;
  instructions: string;
  /** 输入条目：message / function_call / function_call_output。 */
  input: readonly unknown[];
  /** 函数工具声明。省略则本次不提供工具（用于收尾时强制给答案）。 */
  tools?: readonly unknown[];
  stream?: boolean;
  maxOutputTokens?: number;
  toolChoice?: 'auto' | 'none' | 'required';
}

/** 构造请求体。Key 不在这里出现，由主进程单独加 Authorization 头。 */
export function buildResponsesBody(body: ResponsesBodyInput): string {
  const payload: Record<string, unknown> = {
    model: body.model,
    instructions: body.instructions,
    input: body.input,
    stream: body.stream ?? true,
    max_output_tokens: body.maxOutputTokens ?? responsesDefaults.maxOutputTokens,
  };
  if (body.tools && body.tools.length > 0) {
    payload.tools = body.tools;
    payload.tool_choice = body.toolChoice ?? 'auto';
  }
  return JSON.stringify(payload);
}

const eventSchema = z.object({
  type: z.string().nullish(),
  event: z.string().nullish(),
  delta: z.string().nullish(),
  response: z.unknown().nullish(),
});

export interface ResponsesOutput {
  text: string;
  calls: AgentCall[];
  /** 是否有思维链输出；只用于提示，不展示、不保存。 */
  reasoning: boolean;
}

export interface AgentCall {
  callId: string;
  name: string;
  arguments: string;
}

export type ResponsesEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'reasoning' }
  | { kind: 'completed'; output: unknown[]; usage: AiUsage | null }
  | { kind: 'incomplete'; output: unknown[]; usage: AiUsage | null }
  | { kind: 'failed'; error: string }
  /** 一块不是 JSON 的数据（代理插的心跳、半截垃圾）。单块跳过，连续多块才算失败。 */
  | { kind: 'garbled' }
  | { kind: 'ignore' };

/** 连续多少块解析不了才判整段失败：一两块噪声不该把已经在打字的回复判死。 */
export const garbledLimit = 3;

/**
 * 解析单条 SSE 数据。
 *
 * 事件类型可能出现在 JSON 的 `type` 里（OpenAI 风格），也可能只在 SSE 的 `event:` 行；
 * 我们的解码器只收集 data，因此以载荷内的 `type` / `event` 为准，两者都读。
 * 结构不认识就跳过这一块，不因为多一个事件类型就中断整段回复。
 */
export function parseResponsesEvent(payload: string): ResponsesEvent {
  const trimmed = payload.trim();
  if (trimmed === '' || trimmed === '[DONE]') return { kind: 'ignore' };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { kind: 'garbled' };
  }
  if (typeof raw !== 'object' || raw === null) return { kind: 'ignore' };
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'ignore' };
  const type = parsed.data.type ?? parsed.data.event ?? '';
  switch (type) {
    case 'response.output_text.delta':
      return { kind: 'delta', text: parsed.data.delta ?? '' };
    case 'response.reasoning_text.delta':
      return { kind: 'reasoning' };
    case 'response.completed':
      return {
        kind: 'completed',
        output: outputOf(parsed.data.response),
        usage: parseResponsesUsage(parsed.data.response),
      };
    case 'response.incomplete':
      return {
        kind: 'incomplete',
        output: outputOf(parsed.data.response),
        usage: parseResponsesUsage(parsed.data.response),
      };
    case 'response.failed':
      return { kind: 'failed', error: describeResponseFailure(parsed.data.response) };
    case 'error':
      return { kind: 'failed', error: '服务端在流式回复中返回了错误。' };
    default:
      // 未知事件（item 开始/结束、参数增量等）对本应用无意义，跳过。
      return { kind: 'ignore' };
  }
}

/** 失败详情只取错误码与简短 message，绝不把整个响应体回显到界面。 */
function describeResponseFailure(response: unknown): string {
  if (typeof response === 'object' && response !== null && 'error' in response) {
    const error = (response as { error?: unknown }).error;
    if (typeof error === 'object' && error !== null) {
      const code = (error as { code?: unknown }).code;
      if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
        return '账户余额不足，请检查 DeepSeek 账户。';
      }
      if (code === 'context_length_exceeded') {
        return '上下文超出模型窗口，请清空对话后重试。';
      }
      if (typeof code === 'string' && code !== '') return `模型返回错误：${code}。`;
    }
  }
  return '模型未能完成本次回复。';
}

function outputOf(response: unknown): unknown[] {
  if (typeof response !== 'object' || response === null) return [];
  const output = (response as { output?: unknown }).output;
  return Array.isArray(output) ? output : [];
}

/**
 * 从 response 对象里取 token 用量。
 * Responses 用的是 input_tokens / output_tokens，而对话接口用 prompt/completion_tokens，
 * 两套字段名必须分开处理，否则会把用量记成 0。
 */
export function parseResponsesUsage(response: unknown): AiUsage | null {
  if (typeof response !== 'object' || response === null) return null;
  const usage = (response as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const fields = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
  };
  const input = numberOrZero(fields.input_tokens);
  const output = numberOrZero(fields.output_tokens);
  if (input === 0 && output === 0) return null;
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: numberOrZero(fields.total_tokens) || input + output,
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * 从 output 条目里取出正文与函数调用。
 * message 的 content 是内容块数组（output_text），function_call 的 arguments 是 JSON 字符串。
 * 两者都可能缺失或带多余字段，因此逐项宽松读取。
 */
export function readOutput(output: readonly unknown[]): ResponsesOutput {
  let text = '';
  const calls: AgentCall[] = [];
  let reasoning = false;
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const kind = (item as { type?: unknown }).type;
    if (kind === 'reasoning') {
      reasoning = true;
      continue;
    }
    if (kind === 'message') {
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (typeof part !== 'object' || part === null) continue;
        const block = part as { type?: unknown; text?: unknown };
        if (
          (block.type === 'output_text' || block.type === 'text') &&
          typeof block.text === 'string'
        ) {
          text += block.text;
        }
      }
      continue;
    }
    if (kind === 'function_call') {
      const call = item as { call_id?: unknown; name?: unknown; arguments?: unknown };
      const callId = typeof call.call_id === 'string' ? call.call_id : '';
      const name = typeof call.name === 'string' ? call.name : '';
      if (callId === '' || name === '') continue;
      const args =
        typeof call.arguments === 'string'
          ? call.arguments
          : call.arguments === undefined
            ? '{}'
            : JSON.stringify(call.arguments);
      calls.push({ callId, name, arguments: args });
    }
  }
  return { text, calls, reasoning };
}

/**
 * 把历史轮次转成 input 条目；Responses 用 message item，而不是 chat 的 messages。
 *
 * 它自己之前的回复里若漏过工具标记，这里洗掉：模型会照着历史里「自己说过的话」学，
 * 写坏的格式留在历史里，下一轮就更可能再写坏一次——越漏越多。
 */
export function historyItems(
  history: readonly { role: 'user' | 'assistant'; content: string }[],
): unknown[] {
  return history.flatMap((turn) => {
    const content = turn.role === 'assistant' ? visibleText(turn.content) : turn.content;
    return content === '' ? [] : [{ role: turn.role, content }];
  });
}
