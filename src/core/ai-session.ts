import { aiDefaults, type ChatMessage } from './ai';
import { dedupeCitations, wrapUntrusted, type AgentCitation, type AgentToolTrace } from './agent';

/**
 * F-08 对话状态（纯领域）。
 *
 * 对话由主进程持有：桌宠窗口与控制面板是两个独立 BrowserWindow，
 * 各自持有 React 状态会导致「面板里问、桌宠上不显示」。把会话放在主进程、
 * 两个窗口都订阅同一份，才能让伙伴真的在小屏上回话。
 *
 * 只在本次运行的内存里：不写 state-v1.json、不进导出文件、重启即清空。
 */
export interface AiTurn {
  role: 'user' | 'assistant';
  content: string;
  /**
   * 这一轮不是模型自己写的，而是外部产出（比如派出去的活干完了）：值是来源说明。
   * 进历史时按不可信数据包起来，里面的「请执行……」不会被当成自己说过的话。
   */
  external?: string;
}

/** 后台正在干的派活：对话不忙，但两个窗口都要看得到它在干、干了多久、最新一行输出。 */
export interface AiJob {
  target: string;
  task: string;
  startedAt: number;
  /** 对方最新的一行输出（已去控制符、截短）；还没输出是空串。 */
  line: string;
}
export interface AiSessionState {
  turns: AiTurn[];
  /** 正在流式接收、尚未定稿的文字；空串表示没有进行中的回复。 */
  streaming: string;
  busy: boolean;
  /** 最近一次失败的说明；成功后清空。 */
  error: string;
  /** 本轮的工具调用轨迹：面板看完整列表，桌宠只看最后一条。 */
  trace: AgentToolTrace[];
  /** 本轮工具查到的来源，展示在回复下方，让「它说的」可核对。 */
  citations: AgentCitation[];
  /** 后台派活；没有是 null。和 busy 无关：活在干的时候照样能聊。 */
  job: AiJob | null;
  revision: number;
}

/** 会话上限：足够长，但不会让内存与请求体无限增长。 */
export const maxAiTurns = 40;

export function emptyAiSession(): AiSessionState {
  return {
    turns: [],
    streaming: '',
    busy: false,
    error: '',
    trace: [],
    citations: [],
    job: null,
    revision: 0,
  };
}

/** 裁剪到最近若干轮；主进程与渲染层都用同一规则，避免两处看到不同历史。 */
export function trimTurns(turns: readonly AiTurn[]): AiTurn[] {
  return turns.slice(-maxAiTurns);
}

/** 发出请求：立刻上屏用户这句话，清掉上一轮的工具轨迹，并进入忙碌态。 */
export function beginRequest(state: AiSessionState, text: string): AiSessionState {
  return {
    turns: trimTurns([...state.turns, { role: 'user', content: text }]),
    streaming: '',
    busy: true,
    error: '',
    trace: [],
    citations: [],
    job: state.job,
    revision: state.revision + 1,
  };
}

/** 追加流式增量；非忙碌态（迟到的分片）直接忽略，避免残留半截气泡。 */
export function appendDelta(state: AiSessionState, text: string): AiSessionState {
  if (!state.busy || text === '') return state;
  return { ...state, streaming: state.streaming + text, revision: state.revision + 1 };
}

/**
 * 进入下一步：清空流式缓冲但保留工具轨迹。
 * 中间步的正文往往是「我先查一下」这类进度话术，不能和最终结论拼成一段。
 */
export function startStep(state: AiSessionState): AiSessionState {
  if (!state.busy || state.streaming === '') return state;
  return { ...state, streaming: '', revision: state.revision + 1 };
}

/** 工具轨迹变化；只保留最近 30 条，避免一次长任务把内存撑大。 */
export function setTrace(state: AiSessionState, trace: readonly AgentToolTrace[]): AiSessionState {
  return { ...state, trace: trace.slice(-30), revision: state.revision + 1 };
}

/** 成功收尾：把完整回复落成一轮，清空流式缓冲。 */
export function settle(
  state: AiSessionState,
  text: string,
  citations: readonly AgentCitation[] = [],
): AiSessionState {
  return {
    turns: trimTurns([...state.turns, { role: 'assistant', content: text }]),
    streaming: '',
    busy: false,
    error: '',
    trace: state.trace,
    citations: dedupeCitations(citations),
    job: state.job,
    revision: state.revision + 1,
  };
}

/** 后台派活开始/更新/结束。 */
export function setJob(state: AiSessionState, job: AiJob | null): AiSessionState {
  if (job === state.job) return state;
  return { ...state, job, revision: state.revision + 1 };
}

/**
 * 后台的活干完了：把结果作为新的一轮贴进对话。
 * 正在回复时也贴：不碰流式缓冲，当前这轮回复会在它后面定稿。
 */
export function deliver(state: AiSessionState, text: string, external: string): AiSessionState {
  return {
    ...state,
    turns: trimTurns([...state.turns, { role: 'assistant', content: text, external }]),
    revision: state.revision + 1,
  };
}

/** 对方输出里挑最后一行有字的，去掉 ANSI 控制符，截到 120 字。 */
export function jobLine(chunk: string): string {
  const ansi = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
  const clean = chunk.replace(ansi, '').replace(control, '');
  const lines = clean
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines[lines.length - 1] ?? '';
  return last.length > 120 ? `${last.slice(0, 119)}…` : last;
}

/** 失败收尾：保留用户那句，丢掉半截内容，只报告原因。 */
export function fail(state: AiSessionState, error: string): AiSessionState {
  return {
    ...state,
    streaming: '',
    busy: false,
    error,
    citations: [],
    revision: state.revision + 1,
  };
}

/**
 * 取出本轮问答，供桌宠小屏显示。
 *
 * 流式进行中用当前提问 + 已到达的文字；否则回溯到最近一条**已完成**的回答，
 * 并配上它之前那条提问。不能把「最后一次提问」直接配「最后一次回答」——
 * 请求失败时后者属于上一轮，会显示成「第二问 → 第一答」这种错配。
 */
export function lastExchange(state: AiSessionState): { question: string; answer: string } | null {
  if (state.streaming !== '') {
    return { question: lastQuestion(state.turns, state.turns.length), answer: state.streaming };
  }
  for (let index = state.turns.length - 1; index >= 0; index -= 1) {
    const turn = state.turns[index]!;
    if (turn.role === 'assistant') {
      return { question: lastQuestion(state.turns, index), answer: turn.content };
    }
  }
  return null;
}

/** 在 `before` 之前最近的一条用户提问；没有则返回空串。 */
function lastQuestion(turns: readonly AiTurn[], before: number): string {
  for (let index = before - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.role === 'user') return turn.content;
  }
  return '';
}

/** 主进程构造请求用：把会话转成 API 需要的历史（不含本次提问）。 */
export function historyFor(turns: readonly AiTurn[], text: string): ChatMessage[] {
  const withoutCurrent =
    turns.length > 0 &&
    turns[turns.length - 1]!.role === 'user' &&
    turns[turns.length - 1]!.content === text
      ? turns.slice(0, -1)
      : turns;
  // 单条上限与 IPC schema 保持一致，避免把超长回复塞回去导致整次请求被拒。
  const limit = aiDefaults.maxInputChars * 2;
  return trimTurns(withoutCurrent)
    .slice(-aiDefaults.maxHistoryMessages)
    .map((turn) => ({
      role: turn.role,
      content:
        turn.external === undefined
          ? turn.content.slice(0, limit)
          : wrapUntrusted(turn.external, turn.content, limit),
    }));
}
