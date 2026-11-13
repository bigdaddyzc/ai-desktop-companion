import { aiDefaults } from '../core/ai';
import {
  appendDelta,
  beginRequest,
  deliver,
  emptyAiSession,
  fail,
  historyFor,
  jobLine,
  setJob,
  setTrace,
  settle,
  startStep,
  type AiJob,
  type AiSessionState,
  type AiTurn,
} from '../core/ai-session';
import { toolsFor } from '../core/agent';
import { buildInstructions, defaultPersona, type PersonaConfig } from '../core/persona';
import type { AiActionResult } from '../core/ai';
import type { AiService } from './ai';
import type { MemoryService } from './memory';

/**
 * 对话的唯一持有者。桌宠窗口与控制面板都只是订阅者：
 * 任意一处提问，两处都看到同一段对话，桌宠小屏才会真的「回话」。
 *
 * 工具轨迹也在这里：模型调用 web_search 时，两个窗口都能立刻看到「搜索：…」，
 * 而不是干等一段没有进展的空白。
 *
 * 记忆的注入点在 send()：每次提问按相关性挑几条长期记忆塞进 instructions，
 * 回复结束后再异步抽一次「这次有什么值得记」。
 * 会话本身仍然只在内存里——落盘的是记忆，不是聊天记录。
 */
export class AiSessionService {
  private state = emptyAiSession();
  private memoryGeneration = 0;
  /** 清空记忆之前就在的对话内容：抽取时跳过。 */
  private forgotten = new Set<string>();
  private readonly listeners = new Set<(state: AiSessionState) => void>();

  constructor(
    private readonly ai: AiService,
    private readonly memory: MemoryService | null = null,
    /**
     * 环境读数：工作进度与性格。
     * 都用 getter 而不是快照——面板上一改性格，下一句就该是新语气，不必重启。
     */
    private readonly env: {
      prompt(): string;
      persona?(): PersonaConfig;
      /** 感官读数：只在开关打开时非空，和进度一样是环境而不是用户的话。 */
      senses?(): string;
      /** 派活授权：能交给谁、能跑命令吗。空串表示两项都没授权。 */
      delegate?(): string;
      /** 内置工具之外的工具（外接的 MCP）；每轮重取，服务器断了就不再给模型看。 */
      tools?(): readonly unknown[];
    } | null = null,
  ) {}

  snapshot(): AiSessionState {
    return this.state;
  }

  subscribe(listener: (state: AiSessionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(next: AiSessionState): void {
    // 引用不变说明状态没动（例如迟到分片被忽略），不广播，避免无意义的跨窗口 IPC。
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  /**
   * attach：附件。line 进对话历史和气泡（只有路径），prompt 只进这一轮请求（含文本内容）。
   * 记忆抽取只看用户打的字，不把文件内容当成「用户说的话」记下来。
   */
  async send(raw: string, attach?: { line: string; prompt: string }): Promise<AiActionResult> {
    const text = raw.trim();
    if (text === '') return { ok: false, error: '消息不能为空。' };
    if (text.length > aiDefaults.maxInputChars) {
      return { ok: false, error: `消息过长，请控制在 ${aiDefaults.maxInputChars} 字以内。` };
    }
    if (this.state.busy) return { ok: false, error: '上一条还在回复中，请稍候或先取消。' };

    // 历史要在把这句话加进 turns 之前取，避免把本次提问重复进请求。
    const shown = attach && attach.line !== '' ? `${text}\n${attach.line}` : text;
    const history = historyFor(this.state.turns, shown);
    // 记忆抽取只看你和芯伴说的话：派出去的活交回来的产出不算。
    const spoken = historyFor(
      this.state.turns.filter((turn) => turn.external === undefined),
      shown,
    );
    // 记忆被清空/关闭过：那之前的对话不再拿去抽取，否则下一轮就把刚清掉的又记回来。
    const generation = this.memory?.generation() ?? 0;
    if (generation !== this.memoryGeneration) {
      this.memoryGeneration = generation;
      this.forgotten = new Set(spoken.map((turn) => turn.content));
    }
    this.publish(beginRequest(this.state, shown));

    // 合并约 50ms 的增量：逐 token 广播会让两个窗口都频繁重渲染。
    let pending = '';
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      flushTimer = undefined;
      if (pending === '') return;
      const chunk = pending;
      pending = '';
      this.publish(appendDelta(this.state, chunk));
    };
    /** 收尾/失败前把缓冲刷出去：否则最后一小段增量会被丢掉，界面只在最后整段出现。 */
    const flushNow = (): void => {
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flushTimer = undefined;
      flush();
    };
    /** 进入下一步时丢弃上一段的进度话术（不 publish），它们不属于最终答案。 */
    const dropPending = (): void => {
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flushTimer = undefined;
      pending = '';
    };

    try {
      const enabled = this.memory?.snapshot().enabled ?? true;
      const result = await this.ai.runAgent(
        // 用户打的字单独走（有长度上限），附件那行和内容一起跟在后面。
        attach
          ? { text, history, attachments: `${attach.line}\n\n${attach.prompt}`.trim() }
          : { text, history },
        {
          onDelta: (delta) => {
            pending += delta;
            if (flushTimer === undefined) flushTimer = setTimeout(flush, 50);
          },
          onStepStart: () => {
            // 进入下一步：上一段的进度话术不再留在气泡里，轨迹仍然保留。
            dropPending();
            this.publish(startStep(this.state));
          },
          onTrace: (trace) => {
            this.publish(setTrace(this.state, trace));
          },
        },
        {
          instructions: buildInstructions(
            this.memory?.promptFor(text) ?? '',
            Date.now(),
            this.env?.prompt() ?? '',
            this.env?.persona?.() ?? defaultPersona,
            this.env?.senses?.() ?? '',
            this.env?.delegate?.() ?? '',
          ),
          tools: [...toolsFor(enabled), ...(this.env?.tools?.() ?? [])],
        },
      );
      flushNow();
      if (result.ok) {
        this.publish(settle(this.state, result.text, result.citations));
        // 先让用户看到回复，再去后台整理记忆：抽取慢一点也不影响体验。
        void this.learn(spoken, text, result.text, generation);
        return { ok: true };
      }
      this.publish(fail(this.state, result.error));
      return { ok: false, error: result.error };
    } catch {
      dropPending();
      // 半截内容一律丢弃，不把未完成的回复留在桌宠屏幕上。
      this.publish(fail(this.state, '请求未完成，请稍后重试。'));
      return { ok: false, error: '请求未完成，请稍后重试。' };
    }
  }

  cancel(): void {
    this.ai.cancel();
  }

  private jobLineAt = 0;

  /** 后台派活开始（传 job）或结束（传 null）。 */
  startJob(job: Omit<AiJob, 'line'> | null): void {
    this.jobLineAt = 0;
    this.publish(setJob(this.state, job === null ? null : { ...job, line: '' }));
  }

  /** 对方又输出了一段：取最后一行更新状态，每秒最多广播一次。 */
  jobOutput(chunk: string, now = Date.now()): void {
    const job = this.state.job;
    if (job === null) return;
    const line = jobLine(chunk);
    if (line === '' || line === job.line || now - this.jobLineAt < 1_000) return;
    this.jobLineAt = now;
    this.publish(setJob(this.state, { ...job, line }));
  }

  /** 后台的活有结果了：贴进对话；进历史时按外部数据包起来。 */
  deliver(text: string, external: string): void {
    this.publish(deliver(this.state, text, external));
  }

  /**
   * 后台整理记忆。
   *
   * 只取最近几轮 + 本轮，拼成一段短记录交给抽取提示词；
   * 抽取失败、超时、返回垃圾都静默跳过——记不住比报错更不打扰人。
   */
  private async learn(
    history: readonly { role: 'user' | 'assistant'; content: string }[],
    question: string,
    answer: string,
    generation: number,
  ): Promise<void> {
    const memory = this.memory;
    if (!memory || !memory.snapshot().enabled) return;
    if (memory.generation() !== generation) return;
    if (typeof this.ai.extract !== 'function') return;
    const forgotten = this.forgotten;
    const recent = history
      .filter((turn) => !forgotten.has(turn.content))
      .slice(-4)
      .map((turn) => ({
        role: turn.role,
        content: turn.content,
      })) as AiTurn[];
    const transcript = [
      ...recent.map((turn) => `${turn.role === 'user' ? '用户' : '芯伴'}：${turn.content}`),
      `用户：${question}`,
      `芯伴：${answer}`,
    ]
      .join('\n')
      .slice(-3_000);
    try {
      // 带上已经记得的相关几条，抽取时才不会把同一件事换个说法再记一遍。
      const known = memory.search(`${question}\n${answer}`, 10).map((fact) => fact.text);
      const extraction = await this.ai.extract(transcript, known);
      if (!extraction) return;
      if (extraction.facts.length === 0 && extraction.episode === '') return;
      await memory.applyExtraction(extraction, generation);
    } catch {
      // 记忆是增强项：抽取链路的任何异常都不该影响已经完成的对话。
    }
  }
}
