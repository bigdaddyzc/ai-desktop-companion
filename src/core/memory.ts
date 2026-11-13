/**
 * 长期记忆的纯领域部分：事实模型、去重合并、相关性排序、提示词块与抽取结果解析。
 *
 * 为什么要有这一层：桌宠只有一块小屏，模型能看到的上下文也有限。
 * 「记得你是谁」不能靠把历史越堆越长——那样既贵又会撑爆窗口，
 * 而是把长期有效的事实压缩成短句，按相关性挑几条随请求带上去。
 *
 * 这里不碰磁盘、不碰网络、不依赖 Electron；持久化在 desktop/memory.ts。
 */

export const memoryCategories = [
  'identity',
  'preference',
  'habit',
  'goal',
  'relation',
  'context',
] as const;
export type MemoryCategory = (typeof memoryCategories)[number];

export const memoryCategoryLabels: Record<MemoryCategory, string> = {
  identity: '关于你',
  preference: '喜好',
  habit: '习惯',
  goal: '在做的事',
  relation: '身边的人',
  context: '背景',
};

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (memoryCategories as readonly string[]).includes(value);
}

export interface MemoryFact {
  id: string;
  /** 一句短陈述，例如「在长沙做医院信息化」。 */
  text: string;
  category: MemoryCategory;
  /** said = 用户明确说过；inferred = 从对话里归纳。 */
  source: 'said' | 'inferred';
  createdAt: number;
  updatedAt: number;
  /** 被重复提到或查到的次数，用于淘汰时保命。 */
  hits: number;
  /** 用户手动置顶：永不自动淘汰。 */
  pinned: boolean;
}

export interface MemoryEpisode {
  id: string;
  at: number;
  /** 一句话纪要，不是全文。 */
  summary: string;
}

export interface MemoryState {
  version: 1;
  /** 总开关：关闭后不注入、不抽取，也不再提供记忆工具。 */
  enabled: boolean;
  facts: MemoryFact[];
  episodes: MemoryEpisode[];
  /** 上次整理的时间与整理后的条数：用来判断「又攒了多少、该不该提醒」。 */
  tidiedAt?: number;
  tidiedCount?: number;
}

export const memoryLimits = {
  /** 事实上限。超过后按「重要性」淘汰，不是按时间硬砍。 */
  maxFacts: 200,
  maxEpisodes: 60,
  factChars: 120,
  episodeChars: 140,
  /** 注入提示词的总字数预算：小屏场景不需要更长的背景。 */
  promptBudget: 800,
  /**
   * 注入条数比过去压得很低（原来两处各 24 条）。
   * 原因不是省 token，而是**条数本身就是一种暗示**：给二十条，模型会尽力全覆盖；
   * 给八条，它必须挑。实测本机十三条已经出现「念清单」的回答，压条数是最直接的解。
   */
  injectProfile: 8,
  injectDoing: 4,
  injectEpisodes: 3,
  /**
   * 进度快照（「还差…」「未生效」）默认**一条都不注入**。
   *
   * 理由不是省字数，而是过时的进度陈述比没有更糟：它会让芯伴说出与事实不符的进展，
   * 而实时进度本来就有 work_status 可查。记忆里该留的是「在做镜架 SIT」这种不变的事实，
   * 不是「在查 76 价格未生效」这种几天就翻篇的现场。
   */
  injectProgress: 0,
  /** 一次抽取最多接受几条，防止模型一口气糊进来二十条。 */
  maxExtracted: 3,
} as const;

export function emptyMemory(): MemoryState {
  return { version: 1, enabled: true, facts: [], episodes: [] };
}

/** 类别权重：自我介绍类信息最值得保留，背景类最容易被淘汰。 */
const categoryWeight: Record<MemoryCategory, number> = {
  identity: 6,
  preference: 5,
  goal: 4,
  habit: 3,
  relation: 3,
  context: 1,
};

let sequence = 0;

/** 本地唯一即可：不做跨设备同步，不需要 UUID。 */
export function newMemoryId(now: number): string {
  sequence = (sequence + 1) % 100_000;
  return `m${now.toString(36)}${sequence.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 统一空白与全角标点，避免「不吃香菜。」和「不吃香菜」被当成两条。 */
export function normalizeMemoryText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[·•\-—]+ ?/, '')
    .replace(/[。．.!！?？,，;；:：]+$/, '')
    .trim();
}

function bigrams(text: string): Set<string> {
  const clean = text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  const grams = new Set<string>();
  for (let index = 0; index < clean.length - 1; index += 1) {
    grams.add(clean.slice(index, index + 2));
  }
  if (clean.length === 1) grams.add(clean);
  return grams;
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared;
}

/** Jaccard 相似度，用于排序：两句话整体有多像。 */
export function memorySimilarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  const shared = overlap(left, right);
  if (shared === 0) return 0;
  return shared / (left.size + right.size - shared);
}

/**
 * 重合系数（shared / 较短一方），用于判重。
 * 「喜欢猫」与「喜欢猫和狗」Jaccard 只有 0.5，但显然该合并成一条。
 */
function containment(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  const shared = overlap(left, right);
  if (shared === 0) return 0;
  return shared / Math.min(left.size, right.size);
}

/** 全角字符（０１２、ＡＢＣ、全角空格）转半角：敏感信息判定不能被换个字宽绕过。 */
export function toHalfWidth(text: string): string {
  return text
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

const sensitiveKeywords =
  /(密码|口令|验证码|动态码|校验码|身份证|护照号?|社保卡?号|医保卡?号|银行卡|信用卡|卡号|账号密|cvv|cvc|安全码|私钥|助记词|api[\s_-]?key|access[\s_-]?token|secret[\s_-]?key|client[\s_-]?secret|private[\s_-]?key|password|passwd|\bpwd\b|\bpin\b|pin码)/i;

/**
 * 敏感信息硬拦截：任何进记忆的文字（工具写入、后台抽取、情节纪要）都要过这一道。
 *
 * 记忆会写进本地文件，并随之后的请求一起发给模型服务。密码、证件号、卡号一旦进去
 * 就收不回来，所以放在领域层、在 mergeFact / addEpisode 内部强制执行，不靠调用方自觉。
 * 先归一化（全角转半角、数字间的空格与连字符去掉），再匹配。
 */
export function looksSensitive(raw: string): boolean {
  const text = toHalfWidth(raw);
  if (sensitiveKeywords.test(text)) return true;
  const compact = text.replace(/(?<=\d)[\s\-_.·]+(?=\d)/g, '');
  // 连续 12 位以上数字：身份证、银行卡、长串验证码。
  if (/\d{12,}/.test(compact)) return true;
  // 身份证号末位可能是 X。
  if (/\d{17}[xX]/.test(compact)) return true;
  // 大陆手机号。
  if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(compact)) return true;
  // 邮箱。
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text)) return true;
  // 详细门址：小区/楼栋/单元加数字，「1203室」，「XX路 627 号」。
  // 「会议室2点」不算：房号是数字在「室」前面。
  if (/(小区|号楼|栋|单元|门牌)/.test(text) && /\d/.test(text)) return true;
  if (/\d+\s*室/.test(text)) return true;
  if (/[路街道巷弄村]\s*\d+\s*号/.test(text)) return true;
  return false;
}

/** 否定词个数：「喜欢加班」与「不喜欢加班」字面几乎一样，意思相反。 */
function negationCount(text: string): number {
  return (text.match(/不|没|别|未|讨厌/g) ?? []).length;
}

const kinshipTerms = [
  '女儿',
  '儿子',
  '老婆',
  '老公',
  '丈夫',
  '妻子',
  '太太',
  '爸',
  '妈',
  '父亲',
  '母亲',
  '哥',
  '姐',
  '弟',
  '妹',
  '同事',
  '老板',
  '男朋友',
  '女朋友',
  '朋友',
];

function kinshipOf(text: string): string {
  return kinshipTerms
    .filter((term) => text.includes(term))
    .sort()
    .join('|');
}

/**
 * 字面相似但说的是两件事：否定不同，或说的是不同的人。
 * 「女儿在长沙读大学」和「儿子在长沙读大学」重合度 0.78，合并就丢了一个孩子。
 */
function distinctMeaning(a: string, b: string): boolean {
  if (negationCount(a) !== negationCount(b)) return true;
  const left = kinshipOf(a);
  const right = kinshipOf(b);
  return left !== '' && right !== '' && left !== right;
}

function sanitizeText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return normalizeMemoryText(raw).slice(0, memoryLimits.factChars);
}

/** 从文字里猜类别：模型给错或缺类别时兜底，比一律塞进 context 有用。 */
export function inferCategory(text: string): MemoryCategory {
  const rules: [MemoryCategory, RegExp][] = [
    ['identity', /(叫|名字|住在|家在|老家|工作|职业|做的是|岁|生日|公司|单位)/],
    ['preference', /(喜欢|爱吃|讨厌|不吃|受不了|偏好|最爱|不喜欢|习惯喝)/],
    ['habit', /(每天|通常|一般|经常|作息|早起|熬夜|周末|平时)/],
    ['goal', /(计划|准备|目标|想要|打算|正在做|要在|项目|学习|备考)/],
    ['relation', /(老婆|丈夫|太太|爱人|女朋友|男朋友|孩子|儿子|女儿|同事|老板|父母|爸|妈)/],
  ];
  for (const [category, pattern] of rules) {
    if (pattern.test(text)) return category;
  }
  return 'context';
}

export interface IncomingFact {
  text: string;
  category?: string;
  source?: 'said' | 'inferred';
}

export type MergeOutcome = 'added' | 'updated' | 'skipped';

/**
 * 合并一条新事实。
 * 相似判定用重合系数而不是 Jaccard：中文短句换个语序就会掉分，
 * 宁可合并也不要攒出一堆近似重复，那会白白吃掉提示词预算。
 */
export function mergeFact(
  state: MemoryState,
  incoming: IncomingFact,
  now: number,
): { state: MemoryState; outcome: MergeOutcome; fact: MemoryFact | null } {
  const text = sanitizeText(incoming.text);
  if (text.length < 2) return { state, outcome: 'skipped', fact: null };
  if (looksSensitive(text)) return { state, outcome: 'skipped', fact: null };
  const category = isMemoryCategory(incoming.category) ? incoming.category : inferCategory(text);
  const normalized = normalizeMemoryText(text).toLowerCase();

  const existing = state.facts.find((fact) => {
    const other = normalizeMemoryText(fact.text).toLowerCase();
    if (other === normalized) return true;
    // 太短的句子做模糊匹配会误合并（「不吃辣」和「不吃甜」只差一个字）。
    if (other.length < 6 || normalized.length < 6) return false;
    if (distinctMeaning(other, normalized)) return false;
    return containment(other, normalized) >= 0.72;
  });

  if (existing) {
    const facts = state.facts.map((fact) =>
      fact.id === existing.id
        ? {
            ...fact,
            // 保新的说法：同一件事最新的表述最可信；长度已有 factChars 上限兜底。
            text,
            category: fact.category === 'context' ? category : fact.category,
            updatedAt: now,
            hits: fact.hits + 1,
            source: incoming.source ?? fact.source,
          }
        : fact,
    );
    const updated = facts.find((fact) => fact.id === existing.id) ?? null;
    return { state: { ...state, facts }, outcome: 'updated', fact: updated };
  }

  const fact: MemoryFact = {
    id: newMemoryId(now),
    text,
    category,
    source: incoming.source ?? 'said',
    createdAt: now,
    updatedAt: now,
    hits: 0,
    pinned: false,
  };
  return { state: trimFacts({ ...state, facts: [...state.facts, fact] }), outcome: 'added', fact };
}

/** 淘汰：先按重要性排，再截断。置顶的永远留。 */
export function trimFacts(state: MemoryState): MemoryState {
  if (state.facts.length <= memoryLimits.maxFacts) return state;
  const keep = [...state.facts]
    .sort((a, b) => keepScore(b) - keepScore(a))
    .slice(0, memoryLimits.maxFacts);
  const order = new Map(recentOrder(state.facts).map((fact, index) => [fact.id, index]));
  keep.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { ...state, facts: keep };
}

function recentOrder(facts: readonly MemoryFact[]): MemoryFact[] {
  return [...facts].sort((a, b) => a.createdAt - b.createdAt);
}

function keepScore(fact: MemoryFact): number {
  const ageDays = Math.max(0, Date.now() - fact.updatedAt) / 86_400_000;
  return (
    (fact.pinned ? 1_000 : 0) +
    categoryWeight[fact.category] +
    Math.min(fact.hits, 10) +
    Math.max(0, 30 - ageDays) / 30
  );
}

/** 一次「忘掉」最多删几条；再多就先问清楚，而不是把提到「长沙」的全删了。 */
export const forgetLimit = 3;

/**
 * 忘掉与描述相关的记忆。用户说「忘掉香菜」时不该要求他报 id。
 *
 * 关键词太短（一个字）不删；命中超过 forgetLimit 条也不删，把候选交回去让模型问清楚。
 */
export function forgetFacts(
  state: MemoryState,
  query: string,
): { state: MemoryState; removed: MemoryFact[]; candidates: MemoryFact[] } {
  const key = normalizeMemoryText(query).toLowerCase();
  if (key.length < 2) return { state, removed: [], candidates: [] };
  const matched = state.facts.filter((fact) => {
    const text = normalizeMemoryText(fact.text).toLowerCase();
    return text.includes(key) || key.includes(text) || containment(text, key) >= 0.5;
  });
  if (matched.length > forgetLimit) return { state, removed: [], candidates: matched };
  const ids = new Set(matched.map((fact) => fact.id));
  return {
    state: { ...state, facts: state.facts.filter((fact) => !ids.has(fact.id)) },
    removed: matched,
    candidates: [],
  };
}

/**
 * 检索：给一句提问找出最相关的记忆。
 * 没有关键词命中时按重要性兜底，这样「你还记得我吗」也有东西可用。
 */
export function searchFacts(state: MemoryState, query: string, limit = 6): MemoryFact[] {
  const scored = matchFacts(state, query);
  if (scored.length === 0) {
    return [...state.facts].sort((a, b) => keepScore(b) - keepScore(a)).slice(0, limit);
  }
  return scored.slice(0, limit);
}

/** 只返回和提问真有字面关联的记忆（不兜底），按相关度排序。 */
export function matchFacts(state: MemoryState, query: string): MemoryFact[] {
  const key = normalizeMemoryText(query);
  if (key === '') return [];
  return state.facts
    .map((fact) => ({
      fact,
      // 重合系数对小屏短句更宽容：问一句话只命中一个词也该被捞出来。
      score: containment(normalizeMemoryText(fact.text), key) + memorySimilarity(fact.text, key),
    }))
    .filter((entry) => entry.score > 0.12)
    .sort((a, b) => b.score - a.score || keepScore(b.fact) - keepScore(a.fact))
    .map((entry) => entry.fact);
}

/** 问的就是「我在忙什么」这类：手头的事不用字面命中也该拿出来。 */
const askAboutWork =
  /(在忙|在做|忙什么|做什么|干什么|进度|手头|项目|工作|最近|待办|了解|记得|关于我|聊聊我|认识我|对我)/;

function formatDay(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${month}-${day}`;
}

/** 稳定属性：决定「他是个什么样的人」，不随项目进度变。 */
const profileCategories = new Set<MemoryCategory>(['identity', 'preference', 'habit', 'relation']);

/** 纯地点陈述（「在长沙」「老家湖南」）多半被猜成 context，但它属于底子不属于手头。 */
const placePattern = /^(在|住|老家|来自|常住)/;

/**
 * 这条记忆说的是「他是个什么人」，还是「他手头在忙什么」。
 *
 * 分组不是为了好看：截图里那句「…还管我叫小芯。芯伴那边就差实体硬件…」，
 * 就是把这两类混着说的结果——前面讲人，后半句突然汇报项目状态。
 * 分开注入之后，模型至少知道哪些是底子、哪些是当下的事。
 */
export function isProfileFact(fact: MemoryFact): boolean {
  if (profileCategories.has(fact.category)) return true;
  return fact.category === 'context' && placePattern.test(normalizeMemoryText(fact.text));
}

/**
 * 项目进度快照：几天就过期，不是「人」的一部分。
 * 用户问「你了解我什么」时它不该出场——那等于把任务日志当成性格描述念出来。
 */
const progressPattern = /(还差|没落地|未生效|已完成|正在查|待办|收尾|上线|验收|卡在|待修)/;

export function looksLikeProgress(text: string): boolean {
  return progressPattern.test(text);
}

/**
 * 内容特征：英文/数字整词 + 中文 bigram。
 *
 * 为什么不能只靠 `memorySimilarity`：本机那十三条里，
 * 「习惯用 Claude Code 干活」和「用 Claude Code 和 ESP32 做开发」字面相似度只有 0.41，
 * 任何合理阈值都判不成重复——但它们说的就是同一件事，区别只在多提了个 ESP32。
 *
 * 重复的真正信号是**共享同一个专名**。所以把英文词和数字串整词抠出来当特征，
 * 中文则退化为 bigram。两条共享两个及以上特征，就当同一件事，注入时只留一条。
 */
function contentFeatures(text: string): Set<string> {
  const clean = normalizeMemoryText(text).toLowerCase();
  const features = new Set<string>();
  for (const word of clean.match(/[a-z][a-z0-9]+|\d{2,}/g) ?? []) features.add(`w:${word}`);
  for (const run of clean.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(' ')) {
    for (let index = 0; index < run.length - 1; index += 1) {
      features.add(`b:${run.slice(index, index + 2)}`);
    }
  }
  return features;
}

/** 两条文字是不是在说同一件事：共享两个及以上内容特征。 */
export function sharesSubject(left: string, right: string): boolean {
  const a = contentFeatures(left);
  const b = contentFeatures(right);
  let shared = 0;
  for (const feature of a) {
    if (!b.has(feature)) continue;
    shared += 1;
    if (shared >= 2) return true;
  }
  return false;
}

export function sameSubject(left: MemoryFact, right: MemoryFact): boolean {
  return sharesSubject(left.text, right.text);
}

/**
 * 组装注入系统提示词的记忆块。
 *
 * 形态是这里最要紧的决定，不是内容。旧版输出是带分类标签的逐条列表：
 *
 *     关于用户，你记得这些：
 *     · [关于你] 在长沙
 *     · [喜好] 叫我「小芯」
 *     · [在做的事] 在做镜架 SIT 价格验证
 *
 * 一张带标签的清单，最省力的用法就是照着念——用户问「说说你对我的了解」，
 * 模型便逐条翻译出来，于是有了「长沙，手上两条线——…，还管我叫小芯」。
 * **输入的形态决定了输出的形态。**
 *
 * 现在改成两组、组内用「·」连成一行的短句串，外加一句「这是印象不是档案」。
 * 连排会比换行列表更倾向于被当成一段话转述，而不是逐项复述。
 */
export function buildMemoryPrompt(
  state: MemoryState,
  query: string,
  budget: number = memoryLimits.promptBudget,
): string {
  return buildMemoryInjection(state, query, budget).text;
}

export interface MemoryInjection {
  text: string;
  /** 注入了哪些事实。 */
  injected: string[];
  /** 其中和提问字面相关的有几条：精度 = matched / injected。 */
  matched: number;
}

/**
 * 同 buildMemoryPrompt，另外告诉你注入了什么、有几条是真相关的。
 *
 * 精度规则：「他这个人」可以兜底注入（置信度高、说错代价小）；
 * 「手头在忙」只在和提问相关、或问的就是工作时才注入——
 * 否则问一句「今天天气怎样」，模型会顺嘴提一句你那个镜架价格验证。
 */
export function buildMemoryInjection(
  state: MemoryState,
  query: string,
  budget: number = memoryLimits.promptBudget,
): MemoryInjection {
  if (!state.enabled) return { text: '', injected: [], matched: 0 };
  const relevant = matchFacts(state, query);
  const matchedIds = new Set(relevant.map((fact) => fact.id));
  const workQuestion = askAboutWork.test(query);
  // 先放字面相关的，再用「他这个人」里最要紧的补满名额。
  // 以前只要有一条弱命中（「晚上点外卖」撞上「习惯晚上写代码」），
  // 其余底子就全被挤掉——「不吃香菜」恰恰在点外卖时最该在。
  const rest = [...state.facts]
    .filter((fact) => !matchedIds.has(fact.id) && (workQuestion || isProfileFact(fact)))
    .sort((a, b) => keepScore(b) - keepScore(a));
  const ranked = [...relevant, ...rest].slice(
    0,
    memoryLimits.injectProfile + memoryLimits.injectDoing + 8,
  );

  // 先跨组去重再分组：同一件事可能一条被判成「人」一条被判成「手头」，
  // 分完组再去重就会两组各说一遍。
  const picked: MemoryFact[] = [];
  let stale = 0;
  let used = 0;
  for (const fact of ranked) {
    if (picked.some((other) => sameSubject(other, fact))) continue;
    const profileLike = isProfileFact(fact);
    const cap = profileLike ? memoryLimits.injectProfile : memoryLimits.injectDoing;
    if (picked.filter((item) => isProfileFact(item) === profileLike).length >= cap) continue;
    // 进度快照过几天就过期，占一个位置已经是让步，不能再多。
    const staleFact = !profileLike && looksLikeProgress(fact.text);
    if (staleFact && stale >= memoryLimits.injectProgress) continue;
    if (used + fact.text.length + 3 > budget) continue;
    used += fact.text.length + 3;
    if (staleFact) stale += 1;
    picked.push(fact);
  }

  const profile = picked.filter((fact) => isProfileFact(fact));
  const doing = picked.filter((fact) => !isProfileFact(fact));
  const injected = picked.map((fact) => fact.id);
  const matched = picked.filter((fact) => matchedIds.has(fact.id)).length;
  if (picked.length === 0 && state.episodes.length === 0) return { text: '', injected, matched };

  const parts: string[] = [];
  const lines: string[] = [];
  if (profile.length > 0) lines.push(`他这个人：${profile.map((fact) => fact.text).join(' · ')}`);
  if (doing.length > 0) lines.push(`手头在忙：${doing.map((fact) => fact.text).join(' · ')}`);
  if (lines.length > 0) {
    parts.push(
      `关于他，你平时攒下的零碎印象（不是档案，别逐条念，也别从「我记得你」开头）：\n${lines.join('\n')}`,
    );
  }

  const episodes = dedupeEpisodes(state.episodes, memoryLimits.injectEpisodes);
  if (episodes.length > 0) {
    parts.push(
      `最近聊过：${episodes.map((item) => `${formatDay(item.at)} ${item.summary}`).join(' · ')}`,
    );
  }
  return { text: parts.join('\n\n'), injected, matched };
}

/** 情节记忆同样会重复：「问长沙天气」「聊长沙天气」「询问长沙今天天气」是三件事的三种说法。 */
function dedupeEpisodes(episodes: readonly MemoryEpisode[], limit: number): MemoryEpisode[] {
  const out: MemoryEpisode[] = [];
  for (const episode of episodes) {
    if (out.some((kept) => sharesSubject(kept.summary, episode.summary))) continue;
    out.push(episode);
    if (out.length >= limit) break;
  }
  return out;
}

export interface MemoryExtraction {
  facts: { text: string; category: MemoryCategory }[];
  episode: string;
}

/**
 * 解析模型的抽取结果。
 *
 * 模型经常在 JSON 外套一层 ```json 或加一句「好的」，
 * 因此不整段 JSON.parse，而是截取第一个 { 到最后一个 } 再解析；
 * 单条不合规就丢掉那一条，不让整次抽取白费。
 */
export function parseExtraction(raw: string): MemoryExtraction {
  const empty: MemoryExtraction = { facts: [], episode: '' };
  const text = raw.trim();
  if (text === '') return empty;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return empty;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (typeof value !== 'object' || value === null) return empty;
  const list = (value as { facts?: unknown }).facts;
  const facts: MemoryExtraction['facts'] = [];
  const seen = new Set<string>();
  if (Array.isArray(list)) {
    for (const item of list) {
      const source =
        typeof item === 'string'
          ? { text: item, category: undefined }
          : typeof item === 'object' && item !== null
            ? {
                text: (item as { text?: unknown }).text,
                category: (item as { category?: unknown }).category,
              }
            : null;
      if (source === null) continue;
      const factText = sanitizeText(source.text);
      if (factText.length < 2) continue;
      const normalized = normalizeMemoryText(factText).toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      facts.push({
        text: factText,
        category: isMemoryCategory(source.category) ? source.category : inferCategory(factText),
      });
      if (facts.length >= memoryLimits.maxExtracted) break;
    }
  }
  const episodeRaw = (value as { episode?: unknown }).episode;
  const episode =
    typeof episodeRaw === 'string'
      ? normalizeMemoryText(episodeRaw).slice(0, memoryLimits.episodeChars)
      : '';
  return { facts, episode };
}

/** 情节记忆只保留最近若干条，旧的纪要比旧事实更不值钱。 */ export function addEpisode(
  state: MemoryState,
  summary: string,
  now: number,
): { state: MemoryState; added: boolean } {
  const text = normalizeMemoryText(summary).slice(0, memoryLimits.episodeChars);
  if (text.length < 4) return { state, added: false };
  if (looksSensitive(text)) return { state, added: false };
  const recent = state.episodes.slice(0, 6);
  // 同一件事反复聊，不重复记纪要。
  if (recent.some((item) => memorySimilarity(item.summary, text) >= 0.7)) {
    return { state, added: false };
  }
  const episode: MemoryEpisode = { id: newMemoryId(now), at: now, summary: text };
  return {
    state: { ...state, episodes: [episode, ...state.episodes].slice(0, memoryLimits.maxEpisodes) },
    added: true,
  };
}

/**
 * 抽取提示词。
 *
 * 这一步是「聊完之后替自己记一笔」，不是回答用户。旧的版本只列了
 * 「称呼、所在城市、职业、口味、作息、正在做的事」——全是档案字段，
 * 于是记忆库里攒了十三条项目名和工具名，没有一条是「人」。
 * 用户让它「说说你对我的了解」，它能说的只有一张项目清单。
 *
 * 所以这里换了问法：记的是「这个人是什么样的」，不是「他今天干了什么」。
 * 同时明确禁掉项目进度、路径、工具名——它们过几天就过期，而且最容易挤满预算。
 */
export const memoryExtractionPrompt = [
  '你在替自己记一笔，像人记住另一个人那样。记的是「这个人是什么样的」，不是「他今天干了什么」。',
  '只输出一个 JSON 对象，不要解释，不要代码块。',
  '',
  '{"facts":[{"text":"...","category":"identity|preference|habit|goal|relation|context"}],"episode":"..."}',
  '',
  '优先记这些（顺序就是价值高低）：',
  '- 他怎么说话、什么脾气：急、拖、爱较真、嘴上不饶人、报喜不报忧、遇事先自己扛。',
  '- 他在意什么、受不了什么：雷区、底线、非要自己动手才放心的事、明显来劲的话题。',
  '- 他反复出现的状态：总熬夜、总说「马上」、一到周日下午就烦。',
  '- 硬信息：城市、职业、口味、家人、重要日子。',
  '',
  '绝对不记：',
  '- 称呼。你怎么称呼他、他怎么称呼你，都归面板里的「怎么叫你」管，记忆里再记一遍只会打架。',
  '- 项目进度、任务状态、谁改了什么、还差什么没做——那是工作现场，过几天就过期。',
  '- 文件路径、目录名、工具名、模型名、库名。它们不是「人」的一部分。',
  '- 一次性的：今天几点、刚问的天气、临时情绪、寒暄、任务执行结果。',
  '- 密码、验证码、证件号、银行卡、详细住址、健康细节、他人隐私。',
  '',
  '写法：',
  '- 一句短陈述，20 字以内。不要以「用户」开头，直接写「在长沙做医院信息化」「一忙就忘了吃饭」。',
  '- 不要评价，不要复述原话，不要加「他说」这种转述壳。',
  '- 最多 3 条，且这 3 条必须讲不同的事；同一件事只记一条，别换个说法再记一遍。',
  '- 没什么值得记的就给空数组，宁缺勿滥。',
  '- episode 用一句话（30 字内）说这段在聊什么；纯寒暄给空串。',
  '- 如果记录后面列了「已经记得」，那些事不要换个说法再记；只记它们没覆盖的新东西。',
].join('\n');

/**
 * 抽取输入：对话记录 + 已经记得的相关几条。
 *
 * 本机记忆里「较真、不肯将就」攒了四条、「看不懂代码要听大白话」攒了五条，
 * 根源是抽取时模型不知道自己已经记过。把相关的几条带上，它就不会换个说法重记。
 * 这些条目平时就会随提问发给同一个模型服务，没有扩大出站范围。
 */
export function extractionInput(transcript: string, known: readonly string[]): string {
  if (known.length === 0) return transcript;
  return `${transcript}\n\n已经记得：\n${known.map((text) => `- ${text}`).join('\n')}`;
}
