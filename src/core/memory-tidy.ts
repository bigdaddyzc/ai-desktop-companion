/**
 * 记忆整理：让模型通读全部事实，给出「合并 / 改写 / 删除」方案，用户勾选后才落地。
 *
 * 为什么需要它：抽取是一轮一轮做的，每轮只看到眼前几句话，
 * 于是「做事较真，不肯将就」「做事不肯将就，爱较真」会各记一条——
 * 字面重合度 0.71，卡在合并阈值 0.72 下面。阈值再降就会把「女儿」「儿子」合成一个孩子，
 * 所以去重只能在看得到全局的时候做，而且要由人拍板。
 *
 * 这里只有纯逻辑：组装输入、解析与校验方案、应用方案。不碰磁盘、不碰网络。
 */
import {
  inferCategory,
  isMemoryCategory,
  looksSensitive,
  memoryCategoryLabels,
  memoryLimits,
  newMemoryId,
  normalizeMemoryText,
  type MemoryCategory,
  type MemoryFact,
  type MemoryState,
} from './memory';

export type TidyKind = 'merge' | 'rewrite' | 'drop';

export const tidyKindLabels: Record<TidyKind, string> = {
  merge: '合并',
  rewrite: '改写',
  drop: '删除',
};

export interface TidySource {
  id: string;
  /** 出方案时的原文：应用前比对，文字变了说明期间被改过，这条方案作废。 */
  text: string;
  category: MemoryCategory;
}

export interface TidyAction {
  id: string;
  kind: TidyKind;
  sources: TidySource[];
  /** merge / rewrite 的新文字；drop 为空串。 */
  text: string;
  category: MemoryCategory;
  reason: string;
}

export interface TidyPlan {
  createdAt: number;
  /** 出方案时的事实条数，用于显示「94 → 41」。 */
  before: number;
  actions: TidyAction[];
}

export type TidyPhase = 'idle' | 'thinking' | 'ready' | 'failed';

/** 面板看到的整理状态；由主进程持有。 */
export interface MemoryTidyState {
  phase: TidyPhase;
  plan: TidyPlan | null;
  /** failed 时的原因。 */
  error: string;
  /** 上一步的结果：「整理好了：94 条 → 41 条」。 */
  notice: string;
  /** 记忆又攒了不少，面板该提醒一句。只看本地数字。 */
  suggest: boolean;
  canUndo: boolean;
}

export const tidyLimits = {
  /** 少于这么多条不值得整理：模型调用有成本，几条记忆人自己看一眼就够了。 */
  minFacts: 6,
  maxActions: 80,
  reasonChars: 40,
  /** 自上次整理后新增这么多条，面板就提醒一句「该整理了」。 */
  remindAfterGrowth: 20,
  /** 从没整理过时，攒到这么多条开始提醒。 */
  remindAt: 30,
  /**
   * 要给足：deepseek-flash 会先想再写，思考也算输出。实测 94 条时 6000 全被思考吃光，正文为空。
   */
  maxOutputTokens: 20_000,
  timeoutMs: 180_000,
} as const;

export const memoryTidyPrompt = [
  '你在整理自己对一个人的长期记忆。下面每行是一条，格式「#编号 [类别] 内容」。',
  '这些记忆是一轮一轮对话里攒的，所以同一件事常被换个说法记了好几遍。你的任务是把它整理干净。',
  '',
  '只输出一个 JSON 对象，不要解释，不要代码块：',
  '{"actions":[{"kind":"merge|rewrite|drop","ids":[编号...],"text":"...","category":"identity|preference|habit|goal|relation|context","reason":"..."}]}',
  '',
  '三种动作：',
  '- merge：两条及以上说的是同一件事，合成一条。text 是合并后的一句话，要保住各条里不重复的信息。',
  '- rewrite：只有一条，但写得啰嗦、类别错了、或带了「用户」「他说」这种转述壳。text 是改好的一句。',
  '- drop：这条不该留。text 给空串。',
  '',
  '该 drop 的：',
  '- 称呼（谁叫谁什么）：那归面板里的「怎么叫你」管。',
  '- 项目进度、任务状态、还差什么没做、某个问题在查——几天就过期。',
  '- 文件路径、目录名、纯工具名或模型名的陈述，以及一次性的环境状况。',
  '- 被别的条目完全包含、又不适合合并的。',
  '',
  '规矩：',
  '- 每条记忆最多出现在一个动作里。不需要改的不要列出来。',
  '- 拿不准是不是同一件事就别合。尤其不同的人（女儿和伴侣）、意思相反（喜欢和不喜欢）绝不能合。',
  '- 互相矛盾时保留更具体、更新的那条，在 reason 里说明。',
  '- 只能用列表里有的信息，不要补充、不要推测、不要评价。',
  '- text 一句短陈述，30 字以内，不以「用户」开头。',
  '- reason 用 15 字以内说清为什么，例如「同一件事说了三遍」「项目进度，会过期」。',
  '- reason 里不要写编号：用户看不到编号。要提到另一条就直接说它的内容。',
].join('\n');

/**
 * 给模型看的输入：用从 1 开始的短编号代替内部 id。
 * 模型抄长 id 容易抄错，抄错一位就可能删掉另一条记忆；短编号错了会落到不存在的号上，校验能拦住。
 */
export function tidyInput(state: MemoryState): string {
  return state.facts
    .map((fact, index) => `#${index + 1} [${memoryCategoryLabels[fact.category]}] ${fact.text}`)
    .join('\n');
}

function readIndices(raw: unknown, count: number): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const item of raw) {
    const value =
      typeof item === 'number'
        ? item
        : typeof item === 'string'
          ? Number(item.replace(/^#/, ''))
          : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > count) return null;
    if (!out.includes(value - 1)) out.push(value - 1);
  }
  return out;
}

function cleanText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return normalizeMemoryText(raw).replace(/^用户/, '').slice(0, memoryLimits.factChars).trim();
}

/**
 * 解析并校验模型给的方案。
 *
 * 模型的话不能直接执行：编号可能越界、一条记忆可能被两个动作同时处理、
 * 合并后的文字可能带出敏感信息。这些在这里逐条拦掉，坏的那条丢弃，其余照用。
 * 置顶的记忆是用户亲手保的，不接受删除。
 */
export function parseTidyPlan(raw: string, state: MemoryState, now: number): TidyPlan | null {
  const text = raw.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = (value as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(list)) return null;

  const facts = state.facts;
  const used = new Set<number>();
  const actions: TidyAction[] = [];
  for (const item of list) {
    if (actions.length >= tidyLimits.maxActions) break;
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const kind = entry['kind'];
    if (kind !== 'merge' && kind !== 'rewrite' && kind !== 'drop') continue;
    const indices = readIndices(entry['ids'], facts.length);
    if (indices === null || indices.length === 0) continue;
    if (indices.some((index) => used.has(index))) continue;
    if (kind === 'merge' && indices.length < 2) continue;
    if (kind === 'rewrite' && indices.length !== 1) continue;
    const sources = indices.map((index) => facts[index]!);
    if (kind === 'drop' && sources.some((fact) => fact.pinned)) continue;

    // 编号只在给模型的输入里有意义，面板上看不到：「与 #70 矛盾」对用户是天书。
    const reason = cleanText(entry['reason'])
      .replace(/\s*#\d+\s*/g, '另一条')
      .slice(0, tidyLimits.reasonChars);
    let newText = '';
    let category: MemoryCategory = sources[0]!.category;
    if (kind !== 'drop') {
      newText = cleanText(entry['text']);
      if (newText.length < 2 || looksSensitive(newText)) continue;
      category = isMemoryCategory(entry['category']) ? entry['category'] : inferCategory(newText);
      // 改写成一模一样的话等于没改，不占用户的注意力。
      if (
        kind === 'rewrite' &&
        normalizeMemoryText(newText) === normalizeMemoryText(sources[0]!.text) &&
        category === sources[0]!.category
      ) {
        continue;
      }
    }
    for (const index of indices) used.add(index);
    actions.push({
      id: `t${actions.length + 1}`,
      kind,
      sources: sources.map((fact) => ({ id: fact.id, text: fact.text, category: fact.category })),
      text: newText,
      category,
      reason: reason === '' ? tidyKindLabels[kind] : reason,
    });
  }
  return { createdAt: now, before: facts.length, actions };
}

/** 方案全部应用后剩几条：合并 n 条变 1 条，删除 n 条变 0 条。 */
export function tidyAfterCount(plan: TidyPlan, actionIds?: readonly string[]): number {
  let after = plan.before;
  for (const action of plan.actions) {
    if (actionIds && !actionIds.includes(action.id)) continue;
    if (action.kind === 'merge') after -= action.sources.length - 1;
    if (action.kind === 'drop') after -= action.sources.length;
  }
  return after;
}

export interface TidyOutcome {
  state: MemoryState;
  applied: number;
  /** 出方案后这几条被改过或删了，方案作废。 */
  stale: number;
}

/**
 * 应用用户勾选的动作。
 *
 * 出方案要几十秒，期间后台抽取可能改了某条记忆：文字对不上的整条跳过，不拿旧方案覆盖新记忆。
 * 合并后的新事实继承最早的创建时间、累计的命中次数和置顶，排在第一条来源原来的位置。
 */
export function applyTidyPlan(
  state: MemoryState,
  plan: TidyPlan,
  actionIds: readonly string[],
  now: number,
): TidyOutcome {
  let facts: MemoryFact[] = [...state.facts];
  let applied = 0;
  let stale = 0;
  for (const action of plan.actions) {
    if (!actionIds.includes(action.id)) continue;
    const current = action.sources.map((source) => facts.find((fact) => fact.id === source.id));
    const intact = current.every(
      (fact, index) => fact !== undefined && fact.text === action.sources[index]!.text,
    );
    if (!intact) {
      stale += 1;
      continue;
    }
    const originals = current as MemoryFact[];
    const ids = new Set(originals.map((fact) => fact.id));
    if (action.kind === 'drop') {
      facts = facts.filter((fact) => !ids.has(fact.id));
    } else if (action.kind === 'rewrite') {
      facts = facts.map((fact) =>
        fact.id === originals[0]!.id
          ? { ...fact, text: action.text, category: action.category, updatedAt: now }
          : fact,
      );
    } else {
      const merged: MemoryFact = {
        id: newMemoryId(now),
        text: action.text,
        category: action.category,
        source: originals.some((fact) => fact.source === 'said') ? 'said' : 'inferred',
        createdAt: Math.min(...originals.map((fact) => fact.createdAt)),
        updatedAt: now,
        hits: originals.reduce((sum, fact) => sum + fact.hits, 0),
        pinned: originals.some((fact) => fact.pinned),
      };
      const at = facts.findIndex((fact) => ids.has(fact.id));
      facts = facts.filter((fact) => !ids.has(fact.id));
      facts.splice(Math.min(at, facts.length), 0, merged);
    }
    applied += 1;
  }
  return { state: { ...state, facts }, applied, stale };
}

/**
 * 该不该提醒整理。只看本地数字，不调模型：
 * 后台自动把记忆发出去整理，违背「出站必须由用户点」这条底线。
 */
export function shouldSuggestTidy(state: MemoryState): boolean {
  if (!state.enabled || state.facts.length < tidyLimits.minFacts) return false;
  if (state.tidiedAt === undefined) return state.facts.length >= tidyLimits.remindAt;
  return state.facts.length - (state.tidiedCount ?? 0) >= tidyLimits.remindAfterGrowth;
}
