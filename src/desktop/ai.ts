import {
  aiAllowedHosts,
  aiChatInputSchema,
  aiConfigInputSchema,
  aiDefaults,
  createSseDecoder,
  describeHttpError,
  describeNetworkFailure,
  describeStreamFailure,
  emptyUsageSummary,
  isAllowedEndpoint,
  type AiActionResult,
  type AiStatus,
  type AiUsage,
} from '../core/ai';
import {
  agentToolSpecs,
  clip,
  describeToolCall,
  stepSignature,
  type AgentCitation,
  type AgentToolTrace,
} from '../core/agent';
import { buildInstructions } from '../core/persona';
import {
  extractionInput,
  memoryExtractionPrompt,
  parseExtraction,
  type MemoryExtraction,
} from '../core/memory';
import { memoryTidyPrompt, tidyLimits } from '../core/memory-tidy';
import { dsmlDeltaFilter, hasDsml, recoverDsmlCalls, visibleText } from '../core/dsml';
import {
  buildResponsesBody,
  historyItems,
  garbledLimit,
  parseResponsesEvent,
  readOutput,
  responsesDefaults,
  responsesEndpoint,
  toolEndpoint,
} from '../core/responses';
import type { AiCredentialStore } from './ai-credentials';
import type { ToolExecution, ToolJsonResult } from './tools';

export interface AiByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}
export interface AiFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** 流式响应体；只声明本服务用到的读取接口，便于注入测试。 */
  body?: { getReader(): AiByteReader } | null;
}
export type AiFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<AiFetchResponse>;

/** 工具执行器的最小接口；由 desktop/tools.ts 实现，主进程注入。 */
export interface AiToolRunner {
  run(
    call: { callId: string; name: string; arguments: string },
    signal: AbortSignal,
  ): Promise<ToolExecution>;
}

export interface AgentHooks {
  /** 正文增量。每一「步」开始时会先收到 onStepStart，之后才是该步的增量。 */
  onDelta(text: string): void;
  onStepStart?(): void;
  /** 工具轨迹全量快照：先推 running，执行完再推终态。 */
  onTrace(traces: readonly AgentToolTrace[]): void;
}

/**
 * 一次运行的外部输入。
 * 分开传是为了让「人格 + 记忆」由会话层决定，AiService 只负责管道与计费。
 */
export interface AgentOptions {
  instructions: string;
  tools: readonly unknown[];
}

export type AgentRunResult =
  | { ok: true; text: string; citations: AgentCitation[]; traces: AgentToolTrace[] }
  | { ok: false; error: string };

interface StepOutcome {
  ok: true;
  text: string;
  output: unknown[];
  usage: AiUsage | null;
  reasoning: boolean;
}

/**
 * 主进程唯一出站通道。
 *
 * 一次只允许一个 Agent 运行，失败不自动重试（避免重复扣费）。
 * Key 只用于构造 Authorization 头，不进入任何日志、错误信息或订阅消息；
 * 工具执行器拿不到 Key，只能通过 postJson 借用主进程的鉴权能力。
 */
export class AiService {
  private busy = false;
  private controller: AbortController | null = null;
  private usage = emptyUsageSummary();
  private toolCallCount = 0;
  private tools: AiToolRunner | null = null;
  /** 后台抽取同一时刻只跑一条：它不占 busy，但也没必要排队叠加。 */
  private extracting = false;
  private tidying = false;

  constructor(
    private readonly store: AiCredentialStore,
    private readonly fetchImpl: AiFetch,
    private readonly allowedHosts: readonly string[] = aiAllowedHosts,
    private readonly timeoutMs: number = aiDefaults.timeoutMs,
    /** 整轮预算；可注入是为了在测试里把 150 秒缩到几十毫秒，逼出「工具跑到一半被掐」。 */
    private readonly runBudgetMs: number = responsesDefaults.runTimeoutMs,
  ) {}

  /** 主进程启动后注入：工具需要调用既有的 store / service，不能在建构造时形成环。 */
  setTools(tools: AiToolRunner): void {
    this.tools = tools;
  }

  async status(): Promise<AiStatus> {
    const saved = await this.store.load();
    return {
      configured: saved !== null,
      baseUrl: saved?.baseUrl ?? aiDefaults.baseUrl,
      model: saved?.model ?? aiDefaults.model,
      busy: this.busy,
      usage: { ...this.usage },
      toolCalls: this.toolCallCount,
    };
  }

  async configure(raw: unknown): Promise<AiActionResult> {
    const parsed = aiConfigInputSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: '配置格式无效，请检查 Base URL、模型名与 API Key。' };
    }
    if (!isAllowedEndpoint(parsed.data.baseUrl, this.allowedHosts)) {
      return { ok: false, error: '只允许 https://api.deepseek.com 这一出站端点。' };
    }
    if (this.busy) return { ok: false, error: '有请求进行中，请稍后再修改配置。' };
    try {
      await this.store.save(parsed.data);
      return { ok: true };
    } catch {
      // 底层异常可能带路径；不回显，避免泄露本机信息。
      return { ok: false, error: '凭据保存失败，请检查系统加密存储是否可用。' };
    }
  }

  async clear(): Promise<AiActionResult> {
    if (this.busy) return { ok: false, error: '有请求进行中，请稍后再清除配置。' };
    await this.store.clear();
    return { ok: true };
  }

  cancel(): void {
    this.controller?.abort();
  }

  /**
   * 供工具借用鉴权：Search / Fetch 与模型调用共用同一个 Key 与同一条白名单，
   * 但 Key 本身不出这个类——执行器只拿到 JSON 结果。
   */
  async postJson(path: string, body: unknown, signal: AbortSignal): Promise<ToolJsonResult> {
    const saved = await this.store.load();
    if (!saved) return { ok: false, status: 0, data: null };
    if (!isAllowedEndpoint(saved.baseUrl, this.allowedHosts)) {
      return { ok: false, status: 0, data: null };
    }
    let url: string;
    try {
      url = toolEndpoint(saved.baseUrl, path);
    } catch {
      return { ok: false, status: 0, data: null };
    }
    if (!isAllowedEndpoint(url, this.allowedHosts)) return { ok: false, status: 0, data: null };
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${saved.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) return { ok: false, status: response.status, data: null };
      try {
        return { ok: true, status: response.status, data: JSON.parse(await response.text()) };
      } catch {
        return { ok: false, status: response.status, data: null };
      }
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }

  /**
   * 跑一次完整的 Agent 运行：模型 → 工具 → 再喂回模型 → 直到它给出最终答复。
   *
   * 关键取舍：
   * - 历史每步都重传（Responses API 无状态，`previous_response_id` 不支持）；
   * - 中间步的正文视为「进度话术」，只有最后一步的正文作为答案，避免把
   *   「我先查一下」和真正的结论拼成一段；
   * - 同一批工具被原样重复调用时立即停止，防止被搜索结果牵着空转。
   */
  async runAgent(
    raw: unknown,
    hooks: AgentHooks,
    options: AgentOptions = { instructions: buildInstructions(), tools: agentToolSpecs },
  ): Promise<AgentRunResult> {
    const parsed = aiChatInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: '输入为空或超出长度限制。' };
    if (this.busy) return { ok: false, error: '已有请求进行中，请先取消或等待。' };

    const controller = new AbortController();
    this.controller = controller;
    this.busy = true;
    let timedOut = false;
    const onTimeout = (): void => {
      timedOut = true;
      controller.abort();
    };
    let timer = setTimeout(onTimeout, this.runBudgetMs);

    const traces: AgentToolTrace[] = [];
    const citations: AgentCitation[] = [];
    try {
      const saved = await this.store.load();
      if (!saved) return { ok: false, error: '尚未配置 API Key，请先保存凭据。' };
      if (!isAllowedEndpoint(saved.baseUrl, this.allowedHosts)) {
        return { ok: false, error: '保存的端点不在允许列表内，请重新配置。' };
      }
      const endpoint = responsesEndpoint(saved.baseUrl);
      if (!isAllowedEndpoint(endpoint, this.allowedHosts)) {
        return { ok: false, error: '保存的端点不在允许列表内，请重新配置。' };
      }

      let input: unknown[] = [
        ...historyItems(parsed.data.history),
        {
          role: 'user',
          content:
            parsed.data.attachments === undefined || parsed.data.attachments === ''
              ? parsed.data.text
              : `${parsed.data.text}\n\n${parsed.data.attachments}`,
        },
      ];
      let answer = '';
      let finished = false;
      let toolCalls = 0;
      let previousSignature = '';
      const withTools = this.tools !== null && options.tools.length > 0;

      for (let step = 0; step < responsesDefaults.maxSteps && !finished; step += 1) {
        // 每一步重新计时。一次派活可能要一两分钟，整轮共用一个 150 秒预算会被它吃掉，
        // 用户看到的就是「干到一半超时」；总时长仍由步数上限兜着。
        timer.refresh();
        if (step > 0) hooks.onStepStart?.();
        const outcome = await this.requestStep(
          endpoint,
          saved.model,
          input,
          withTools ? options.tools : [],
          options.instructions,
          controller.signal,
          hooks.onDelta,
        );
        if (!outcome.ok) return { ok: false, error: outcome.error };
        if (outcome.usage) this.addUsage(outcome.usage);
        let plan = readOutput(outcome.output);
        let stepOutput: readonly unknown[] = outcome.output;

        // 工具调用写坏了、被当成正文发回来：能完整读懂就照常执行（高风险工具仍要确认），
        // 读不懂就只留标记前的话。任何情况下标记都不给人看。
        const said = plan.text || outcome.text;
        if (plan.calls.length === 0 && hasDsml(said)) {
          const recovered = withTools
            ? recoverDsmlCalls(said, toolNames(options.tools))
            : { calls: [], broken: true };
          const before = visibleText(said);
          if (recovered.broken) {
            if (before === '') return { ok: false, error: brokenToolCallError };
            answer = before;
            finished = true;
            break;
          }
          const calls = recovered.calls.map((call, index) => ({
            callId: `dsml_${step}_${index}_${Date.now().toString(36)}`,
            ...call,
          }));
          plan = { ...plan, text: before, calls };
          // 回传给模型的也换成正规条目：function_call_output 必须对得上一个 function_call。
          stepOutput = [
            ...(before === ''
              ? []
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: before }],
                  },
                ]),
            ...calls.map((call) => ({
              type: 'function_call',
              call_id: call.callId,
              name: call.name,
              arguments: call.arguments,
            })),
          ];
        }
        input = [...input, ...stepOutput];

        if (plan.calls.length === 0) {
          answer = said.trim();
          finished = true;
          break;
        }
        if (this.tools === null) {
          return { ok: false, error: '工具未初始化，无法执行模型请求的操作。' };
        }
        const signature = stepSignature(plan.calls);
        if (signature === previousSignature) {
          return { ok: false, error: '模型重复调用同一批工具，已停止以免空转。' };
        }
        previousSignature = signature;

        for (const call of plan.calls) {
          toolCalls += 1;
          this.toolCallCount += 1;
          if (toolCalls > responsesDefaults.maxToolCalls) {
            return { ok: false, error: '本次工具调用次数超出上限，已停止。' };
          }
          const placeholder: AgentToolTrace = {
            callId: call.callId,
            name: call.name,
            label: describeToolCall(call.name, call.arguments),
            status: 'running',
            note: '',
          };
          traces.push(placeholder);
          hooks.onTrace([...traces]);

          // 派活可能跑好几分钟。整轮 150 秒预算只该约束模型请求，不该在工具
          // 执行期间偷跑到点、用 controller.abort() 把活掐在半路。每个工具自己
          // 有超时（派活由面板配置），所以这里暂停总表，回来重新计时。
          clearTimeout(timer);
          let result: ToolExecution;
          try {
            result = await this.runTool(call, controller.signal, placeholder);
          } finally {
            if (!controller.signal.aborted) timer = setTimeout(onTimeout, this.runBudgetMs);
          }
          traces[traces.length - 1] = result.trace;
          hooks.onTrace([...traces]);
          if (result.trace.citations) citations.push(...result.trace.citations);
          input.push({
            type: 'function_call_output',
            call_id: call.callId,
            output: result.output,
          });
        }
      }

      // 步数用尽仍在调工具：不给工具，再要一次结论，避免用户什么都看不到。
      if (!finished) {
        if (controller.signal.aborted) {
          return {
            ok: false,
            error: timedOut ? describeStreamFailure('timeout') : describeStreamFailure('cancelled'),
          };
        }
        hooks.onStepStart?.();
        const closing = await this.requestStep(
          endpoint,
          saved.model,
          input,
          [],
          options.instructions,
          controller.signal,
          hooks.onDelta,
        );
        if (!closing.ok) return { ok: false, error: closing.error };
        if (closing.usage) this.addUsage(closing.usage);
        // 收尾这步不给工具，它若还想调，也只会写出标记：只留标记前的话。
        answer = visibleText(readOutput(closing.output).text || closing.text);
        if (answer === '' && hasDsml(closing.text)) {
          return { ok: false, error: brokenToolCallError };
        }
      }

      if (answer === '') {
        return { ok: false, error: '模型没有返回可用的答复。' };
      }
      return { ok: true, text: answer, citations, traces };
    } catch {
      if (timedOut) return { ok: false, error: describeStreamFailure('timeout') };
      if (controller.signal.aborted)
        return { ok: false, error: describeStreamFailure('cancelled') };
      return { ok: false, error: describeStreamFailure('network') };
    } finally {
      clearTimeout(timer);
      this.controller = null;
      this.busy = false;
    }
  }

  private async runTool(
    call: { callId: string; name: string; arguments: string },
    signal: AbortSignal,
    placeholder: AgentToolTrace,
  ): Promise<ToolExecution> {
    if (this.tools === null) {
      return {
        output: '工具未初始化。',
        trace: { ...placeholder, status: 'error', note: '工具未初始化' },
      };
    }
    try {
      return await this.tools.run(call, signal);
    } catch {
      // 执行器内部已兜住异常；这里再兜一层，避免单次工具失败打断整轮。
      return {
        output: '工具执行失败。',
        trace: { ...placeholder, status: 'error', note: '执行失败' },
      };
    }
  }

  /**
   * 一次模型往返。正文增量立刻回调给界面，完整结果以 response.completed 的 output 为准：
   * 增量只用于「看得见它在打字」，条目才是可回传给下一轮的权威结构。
   */
  private async requestStep(
    endpoint: string,
    model: string,
    input: readonly unknown[],
    tools: readonly unknown[],
    instructions: string,
    signal: AbortSignal,
    onDelta: (text: string) => void,
  ): Promise<StepOutcome | { ok: false; error: string }> {
    const saved = await this.store.load();
    if (!saved) return { ok: false, error: '尚未配置 API Key，请先保存凭据。' };
    const body = buildResponsesBody({
      model,
      instructions,
      input,
      stream: true,
      ...(tools.length > 0 ? { tools } : {}),
    });
    // 单步时限是「空闲时限」：只要流里还在来数据（正文或推理）就一直续命，
    // 长回答不会在出字时被掐掉；连续 timeoutMs 一点动静都没有才停。
    // 整轮总时长另有 runBudgetMs 兆底。
    const idle = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), this.timeoutMs);
      idleTimer.unref?.();
    };
    const idleError = `单步超时：模型 ${Math.round(this.timeoutMs / 1_000)} 秒没有任何输出，已停止本次回复。`;
    touch();
    const combined = AbortSignal.any([signal, idle.signal]);
    try {
      let response: AiFetchResponse;
      try {
        response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${saved.apiKey}`,
          },
          body,
          signal: combined,
        });
      } catch {
        if (idle.signal.aborted && !signal.aborted) return { ok: false, error: idleError };
        // 已经建立连接后被中断（取消/超时）由 runAgent 统一映射；连接都建不起来则直说。
        if (signal.aborted) throw new Error('aborted');
        return { ok: false, error: describeNetworkFailure('network') };
      }
      if (!response.ok) return { ok: false, error: describeHttpError(response.status) };
      touch();

      // 打字时就把工具标记拦在屏幕外，不等整段结束再替换——小屏上一闪而过的乱码也吓人。
      const visible = dsmlDeltaFilter(onDelta);
      let collected: Awaited<ReturnType<typeof collectStream>>;
      try {
        collected = await collectStream(response, (text) => visible.push(text), touch, combined);
      } catch (error) {
        // 读到一半被空闲计时器掐掉：说清楚是超时，而不是「连接中断」。
        if (idle.signal.aborted && !signal.aborted) return { ok: false, error: idleError };
        throw error;
      }
      visible.flush();
      return this.finishStep(collected);
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    }
  }

  private finishStep(
    collected: Awaited<ReturnType<typeof collectStream>>,
  ): StepOutcome | { ok: false; error: string } {
    if (collected.failure !== '') return { ok: false, error: collected.failure };
    // 没有 completed 事件说明流被截断：不把半截文字当成完整答复。
    if (collected.output === null) return { ok: false, error: describeStreamFailure('network') };
    return {
      ok: true,
      text: collected.text.trim(),
      output: collected.output,
      usage: collected.usage,
      reasoning: collected.reasoning,
    };
  }

  /**
   * 后台记忆抽取。
   *
   * 三个约束：
   * - 不占 busy：用户问完就该立刻能再问，抽取慢一点无所谓；
   * - 不抛错：记忆是增强，失败就当作这轮没什么可记；
   * - 不写日志、不回显原文：抽出来的是用户隐私，只在内存里交给会话层。
   */
  async extract(
    transcript: string,
    known: readonly string[] = [],
  ): Promise<MemoryExtraction | null> {
    if (this.extracting) return null;
    const saved = await this.store.load();
    if (!saved) return null;
    if (!isAllowedEndpoint(saved.baseUrl, this.allowedHosts)) return null;
    let endpoint: string;
    try {
      endpoint = responsesEndpoint(saved.baseUrl);
    } catch {
      return null;
    }
    if (!isAllowedEndpoint(endpoint, this.allowedHosts)) return null;

    this.extracting = true;
    const controller = new AbortController();
    try {
      const body = buildResponsesBody({
        model: saved.model,
        instructions: memoryExtractionPrompt,
        input: [{ role: 'user', content: extractionInput(transcript, known) }],
        stream: true,
        maxOutputTokens: 400,
      });
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${saved.apiKey}`,
        },
        body,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]),
      });
      if (!response.ok) return null;
      const collected = await collectStream(response);
      if (collected.failure !== '' || collected.output === null) return null;
      if (collected.usage) this.addUsage(collected.usage);
      const text = readOutput(collected.output).text || collected.text;
      return parseExtraction(text);
    } catch {
      return null;
    } finally {
      this.extracting = false;
    }
  }

  /**
   * 记忆整理：把全部事实发给模型，拿回一份方案原文。
   *
   * 只在用户点「整理记忆」时调用；不开工具、不占 busy、失败不重试。
   * 方案只是文字，是否落地由用户勾选决定。模型要通读全部条目再想，超时放宽到 3 分钟。
   */
  async tidy(input: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    if (this.tidying) return { ok: false, error: '上一次整理还没结束。' };
    const saved = await this.store.load();
    if (!saved) return { ok: false, error: '还没配置 AI，整理要用它。' };
    let endpoint: string;
    try {
      endpoint = responsesEndpoint(saved.baseUrl);
    } catch {
      return { ok: false, error: 'AI 地址无效。' };
    }
    if (!isAllowedEndpoint(endpoint, this.allowedHosts)) {
      return { ok: false, error: 'AI 地址不在允许范围内。' };
    }

    this.tidying = true;
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${saved.apiKey}`,
        },
        body: buildResponsesBody({
          model: saved.model,
          instructions: memoryTidyPrompt,
          input: [{ role: 'user', content: input }],
          stream: true,
          maxOutputTokens: tidyLimits.maxOutputTokens,
        }),
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, tidyLimits.timeoutMs)),
      });
      if (!response.ok) return { ok: false, error: describeHttpError(response.status) };
      const collected = await collectStream(response);
      if (collected.failure !== '') return { ok: false, error: collected.failure };
      if (collected.output === null) return { ok: false, error: describeStreamFailure('network') };
      if (collected.usage) this.addUsage(collected.usage);
      const text = readOutput(collected.output).text || collected.text;
      if (text.trim() === '') {
        return { ok: false, error: '模型想太久，没来得及写出方案，记忆没动。可以再试一次。' };
      }
      return { ok: true, text };
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      return { ok: false, error: describeNetworkFailure(timeout ? 'timeout' : 'network') };
    } finally {
      this.tidying = false;
    }
  }

  private addUsage(used: AiUsage): void {
    this.usage.requests += 1;
    this.usage.promptTokens += used.promptTokens;
    this.usage.completionTokens += used.completionTokens;
    this.usage.totalTokens += used.totalTokens;
  }
}

/**
 * 读完整段流式响应。
 *
 * 抽出来是因为「回答用户」和「后台记一笔」走的是同一套 SSE 语义：
 * 分片可能截断在任意字节，结尾也没有 `data: [DONE]`，
 * 必须以 response.completed 的 output 作为权威结果。
 */
async function collectStream(
  response: AiFetchResponse,
  onDelta?: (text: string) => void,
  /** 每收到一个分片就调一次：空闲计时器靠它续命。 */
  onActivity?: () => void,
  /** 读的过程中被取消/超时：不等下一个分片，立刻抛出。 */
  signal?: AbortSignal,
): Promise<{
  text: string;
  output: unknown[] | null;
  usage: AiUsage | null;
  failure: string;
  reasoning: boolean;
}> {
  let text = '';
  let output: unknown[] | null = null;
  let usage: AiUsage | null = null;
  let reasoning = false;
  let failure = '';
  let garbled = 0;

  const consume = (payloads: readonly string[]): void => {
    for (const payload of payloads) {
      if (failure !== '') return;
      const event = parseResponsesEvent(payload);
      if (event.kind === 'garbled') {
        garbled += 1;
        if (garbled >= garbledLimit) failure = '模型返回了无法解析的流式内容。';
        continue;
      }
      garbled = 0;
      if (event.kind === 'delta') {
        if (event.text !== '') {
          text += event.text;
          onDelta?.(event.text);
        }
      } else if (event.kind === 'reasoning') {
        reasoning = true;
      } else if (event.kind === 'completed' || event.kind === 'incomplete') {
        output = event.output;
        if (event.usage) usage = event.usage;
      } else if (event.kind === 'failed') {
        failure = event.error;
      }
    }
  };

  const reader = response.body?.getReader();
  if (!reader) {
    // 没有可读流时按整段 SSE 文本处理，而不是假装已经流式成功。
    const decoder = createSseDecoder();
    consume([...decoder.push(await response.text()), ...decoder.flush()]);
  } else {
    const decoder = createSseDecoder();
    const bytes = new TextDecoder();
    let finished = false;
    // 有些实现的 reader 不响应 fetch 的 signal：自己监听，取消时让等待中的 read 立刻失败。
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      const fail = (): void => {
        void reader.cancel().catch(() => undefined);
        reject(new Error('aborted'));
      };
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => undefined);
    while (!finished) {
      const chunk = signal ? await Promise.race([reader.read(), aborted]) : await reader.read();
      finished = chunk.done;
      onActivity?.();
      if (chunk.value && chunk.value.length > 0) {
        consume(decoder.push(bytes.decode(chunk.value, { stream: true })));
        if (failure !== '') {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    if (failure === '') {
      consume(decoder.push(bytes.decode()));
      consume(decoder.flush());
    }
  }
  if (output !== null) reasoning = reasoning || readOutput(output).reasoning;
  return { text, output, usage, failure, reasoning };
}

const brokenToolCallError = '它想调用工具，但指令写坏了，这次没有执行。再说一遍试试。';

/** 本轮声明过的工具名：救回来的调用只认这些，模型编个不存在的工具不执行。 */
function toolNames(tools: readonly unknown[]): string[] {
  return tools.flatMap((tool) => {
    const name = (tool as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? [name] : [];
  });
}

/** 面板展示用：把工具轨迹压成一行，避免小屏被撑爆。 */
export function traceSummary(traces: readonly AgentToolTrace[]): string {
  const last = traces[traces.length - 1];
  if (!last) return '';
  const status = last.status === 'running' ? '进行中' : last.status === 'ok' ? last.note : '失败';
  return clip(`${last.label}${status === '' ? '' : ` · ${status}`}`, 46);
}
