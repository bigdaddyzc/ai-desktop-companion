import type { PersonaPreset } from './persona';

/**
 * 主动开口：它第一次自己找你说话。
 *
 * 三条硬约束，决定了这一层长什么样：
 * 1. **不出站**：触发源是本机已有的信号（agent 进度、派活结果、计时、待办到期、你来了），
 *    台词是本地模板按性格挑的。想细聊，按 A 才会发起一次 AI 对话——那是你的动作。
 * 2. **有预算**：每小时上限、同类冷却、同一件事只说一次；你按 B 忽略的那类，冷却翻倍。
 * 3. **一次一句**：小屏只亮一张卡，其余排队；没人理就自己收起来。
 *
 * 纯领域层：不碰定时器、不碰窗口，时间与 id 由调用方注入。
 */

export type NudgeKind =
  | 'agent-stopped'
  | 'agent-waiting'
  | 'delegate-done'
  | 'delegate-failed'
  | 'hooks-lost'
  | 'hooks-fixed'
  | 'timer-done'
  | 'todo-due'
  | 'morning'
  | 'evening'
  | 'reunion'
  | 'milestone';

/** 面板上按组开关：工作提醒、时间提醒、日常招呼。 */
export type NudgeGroup = 'work' | 'reminder' | 'ritual';

export const nudgeGroupOf: Record<NudgeKind, NudgeGroup> = {
  'agent-stopped': 'work',
  'agent-waiting': 'work',
  'delegate-done': 'work',
  'delegate-failed': 'work',
  'hooks-lost': 'work',
  'hooks-fixed': 'work',
  'timer-done': 'reminder',
  'todo-due': 'reminder',
  morning: 'ritual',
  evening: 'ritual',
  reunion: 'ritual',
  milestone: 'ritual',
};

export const nudgeGroupLabels: Record<NudgeGroup, string> = {
  work: 'AI 干活的进展（停了、在等你、派的活完成）',
  reminder: '时间提醒（计时结束、待办到点）',
  ritual: '日常招呼（早安、收工、久别重逢、纪念日）',
};

/** 紧急的不受同类冷却约束：agent 在等你、待办到点，晚说一分钟都是损失。 */
const urgentKinds = new Set<NudgeKind>(['agent-waiting', 'todo-due', 'timer-done']);

const priorityOf: Record<NudgeKind, number> = {
  'agent-waiting': 9,
  'todo-due': 8,
  'timer-done': 7,
  'delegate-failed': 6,
  'hooks-lost': 6,
  'delegate-done': 5,
  'hooks-fixed': 3,
  'agent-stopped': 4,
  reunion: 3,
  milestone: 2,
  morning: 1,
  evening: 1,
};

export interface NudgeEvent {
  kind: NudgeKind;
  /** 去重键：同一件事只说一次（例如 `stopped:<会话>:<最后写入时间>`）。 */
  key: string;
  /** 事情的名字：会话标题、待办标题、派的活。 */
  subject?: string;
  /** 来自哪个 agent：WorkBuddy / Claude Code / Codex。 */
  source?: string;
  days?: number;
  streak?: number;
  todos?: number;
  minutes?: number;
  delegated?: number;
}

export type NudgeMood = 'happy' | 'waiting' | 'sad' | 'idle';

export interface Nudge {
  id: string;
  kind: NudgeKind;
  key: string;
  text: string;
  mood: NudgeMood;
  at: number;
  expiresAt: number;
  /** 按 A「细说」时替你发给 AI 的话；空串表示 A 只是「好」。 */
  askPrompt: string;
}

export type NudgeOutcome = 'accepted' | 'dismissed' | 'expired';

export interface NudgeRecord {
  id: string;
  kind: NudgeKind;
  text: string;
  at: number;
  outcome: NudgeOutcome;
}

export interface ProactiveConfig {
  enabled: boolean;
  /** 开口时也念出来（跟随语音设置；勿扰时不念）。 */
  speak: boolean;
  groups: Record<NudgeGroup, boolean>;
}

export const defaultProactive: ProactiveConfig = {
  enabled: true,
  speak: false,
  groups: { work: true, reminder: true, ritual: true },
};

export interface ProactiveState {
  config: ProactiveConfig;
  current: Nudge | null;
  queue: Nudge[];
  history: NudgeRecord[];
  /** 说过的事（去重键）。 */
  seen: string[];
  lastByKind: Partial<Record<NudgeKind, number>>;
  /** 最近一小时内开口的时刻。 */
  shownAt: number[];
  /** 被忽略的倍数：1 = 正常，每被 B 掉一次翻倍，最多 8 倍。 */
  penalty: Partial<Record<NudgeKind, number>>;
}

export const proactiveLimits = {
  perHour: 4,
  cooldownMs: 10 * 60_000,
  /** 一张卡亮多久没人理就收起来。 */
  showMs: 90_000,
  queue: 3,
  history: 30,
  seen: 300,
  maxPenalty: 8,
} as const;

export function emptyProactive(config: ProactiveConfig = defaultProactive): ProactiveState {
  return {
    config,
    current: null,
    queue: [],
    history: [],
    seen: [],
    lastByKind: {},
    shownAt: [],
    penalty: {},
  };
}

export function normalizeProactive(raw: unknown): ProactiveConfig {
  if (typeof raw !== 'object' || raw === null) return defaultProactive;
  const value = raw as Record<string, unknown>;
  const groups =
    typeof value['groups'] === 'object' && value['groups'] !== null
      ? (value['groups'] as Record<string, unknown>)
      : {};
  const flag = (item: unknown, fallback: boolean): boolean =>
    typeof item === 'boolean' ? item : fallback;
  return {
    enabled: flag(value['enabled'], defaultProactive.enabled),
    speak: flag(value['speak'], defaultProactive.speak),
    groups: {
      work: flag(groups['work'], true),
      reminder: flag(groups['reminder'], true),
      ritual: flag(groups['ritual'], true),
    },
  };
}

type Template = (event: NudgeEvent) => string;

const who = (event: NudgeEvent): string => event.source ?? '那边';
const what = (event: NudgeEvent, max = 14): string => {
  const subject = (event.subject ?? '').replace(/\s+/g, ' ').trim();
  return subject.length > max ? `${subject.slice(0, max - 1)}…` : subject;
};

/**
 * 台词模板：每种性格每类事件几句。
 * 密度规则和 AI 一样：一句话，20 字上下，不开场、不总结、不「您」。
 */
const templates: Record<PersonaPreset, Record<NudgeKind, readonly Template[]>> = {
  banter: {
    'agent-stopped': [
      (e) => `${who(e)}停手了，「${what(e)}」去瞧一眼？`,
      (e) => `${who(e)}那边没动静了，多半干完了。`,
    ],
    'agent-waiting': [
      (e) => `${who(e)}在等你发话，别让它干等。`,
      (e) => `${who(e)}卡在问你话上了，理理它。`,
    ],
    'delegate-done': [
      (e) => `${who(e)}把活干完了，结论要听不？`,
      (e) => `交给${who(e)}的「${what(e)}」搞定了。`,
    ],
    'delegate-failed': [(e) => `${who(e)}把「${what(e)}」搞砸了，要看看怎么回事吗？`],
    'hooks-lost': [(e) => `${what(e, 30)}的钩子被人拆了，按 A 我重装。`],
    'hooks-fixed': [(e) => `${what(e, 30)}的钩子又被拆了，我已经装回去了。`],
    'timer-done': [() => '时间到，起来动一动，别长在椅子上。', () => '响了响了，这一段收工。'],
    'todo-due': [(e) => `「${what(e)}」到点了，还拖？`, (e) => `提醒你：「${what(e)}」该做了。`],
    morning: [
      (e) => (e.todos ? `早。今天还挂着 ${e.todos} 件事。` : '早，又是搬砖的一天。'),
      (e) => (e.streak && e.streak >= 3 ? `早，连续 ${e.streak} 天了，挺能坚持。` : '早啊，开工。'),
    ],
    evening: [
      (e) => `今天划掉 ${e.todos ?? 0} 件，专注 ${e.minutes ?? 0} 分钟，可以了。`,
      () => '天都黑了，该收工了吧。',
    ],
    reunion: [(e) => `${e.days ?? 3} 天没见，你可算回来了。`, () => '哟，还记得我啊。'],
    milestone: [
      (e) =>
        e.days
          ? `认识第 ${e.days} 天了，你没把我卸了，不容易。`
          : `第 ${e.todos ?? 0} 件待办划掉，行啊你。`,
    ],
  },
  warm: {
    'agent-stopped': [(e) => `${who(e)}那边停下了，「${what(e)}」可以看看结果。`],
    'agent-waiting': [(e) => `${who(e)}在等你回复，有空去看一下。`],
    'delegate-done': [(e) => `${who(e)}把「${what(e)}」做完了。`],
    'delegate-failed': [(e) => `${who(e)}没做成「${what(e)}」，要不要一起看看？`],
    'hooks-lost': [(e) => `${what(e, 30)}的钩子不见了，按 A 重新装上。`],
    'hooks-fixed': [(e) => `${what(e, 30)}的钩子丢了一次，已经装回去了。`],
    'timer-done': [() => '这一段完成了，起来活动一下。'],
    'todo-due': [(e) => `「${what(e)}」到时间了。`],
    morning: [(e) => (e.todos ? `早上好，今天有 ${e.todos} 件事。` : '早上好，慢慢来。')],
    evening: [(e) => `今天做完 ${e.todos ?? 0} 件，辛苦了。`],
    reunion: [(e) => `好久不见，${e.days ?? 3} 天了。`],
    milestone: [
      (e) => (e.days ? `我们认识 ${e.days} 天了。` : `已经一起划掉 ${e.todos ?? 0} 件事了。`),
    ],
  },
  dry: {
    'agent-stopped': [(e) => `${who(e)}停了。`],
    'agent-waiting': [(e) => `${who(e)}在等你。`],
    'delegate-done': [(e) => `${who(e)}干完了。`],
    'delegate-failed': [(e) => `${who(e)}失败了。`],
    'hooks-lost': [(e) => `${what(e, 30)}钩子没了。A 重装。`],
    'hooks-fixed': [(e) => `${what(e, 30)}钩子已重装。`],
    'timer-done': [() => '到点。'],
    'todo-due': [(e) => `该做：${what(e)}`],
    morning: [(e) => (e.todos ? `早。${e.todos} 件。` : '早。')],
    evening: [(e) => `今天 ${e.todos ?? 0} 件。收工。`],
    reunion: [(e) => `${e.days ?? 3} 天了。`],
    milestone: [(e) => (e.days ? `第 ${e.days} 天。` : `第 ${e.todos ?? 0} 件。`)],
  },
  chill: {
    'agent-stopped': [(e) => `${who(e)}好像歇了，你看要不要过去瞥瞥~`],
    'agent-waiting': [(e) => `${who(e)}在那儿等你呢，不急但别忘了。`],
    'delegate-done': [(e) => `${who(e)}那边弄完了，慢慢看。`],
    'delegate-failed': [(e) => `${who(e)}好像没弄成，回头看看也行。`],
    'hooks-lost': [(e) => `${what(e, 30)}的钩子好像被清掉了，按 A 我装回去~`],
    'hooks-fixed': [(e) => `${what(e, 30)}的钩子掉了一下，我装回去啦。`],
    'timer-done': [() => '时间到啦，伸个懒腰。'],
    'todo-due': [(e) => `「${what(e)}」该弄了哦。`],
    morning: [() => '早呀，先喝口水。'],
    evening: [() => '差不多啦，去吃饭吧。'],
    reunion: [() => '你回来啦，我还在。'],
    milestone: [(e) => (e.days ? `不知不觉 ${e.days} 天了。` : '又划掉好多事了。')],
  },
};

const moodOf: Record<NudgeKind, NudgeMood> = {
  'agent-stopped': 'idle',
  'agent-waiting': 'waiting',
  'delegate-done': 'happy',
  'delegate-failed': 'sad',
  'hooks-lost': 'sad',
  'hooks-fixed': 'idle',
  'timer-done': 'happy',
  'todo-due': 'waiting',
  morning: 'happy',
  evening: 'happy',
  reunion: 'happy',
  milestone: 'happy',
};

/** 按 A 想细聊时代你问的那句话。只有「背后确实有料可讲」的事件才给。 */
function askPromptOf(event: NudgeEvent): string {
  const subject = what(event, 40);
  switch (event.kind) {
    case 'agent-stopped':
      return `${who(event)} 那边${subject ? `「${subject}」` : ''}停下了，它做到哪了、结论是什么？`;
    case 'agent-waiting':
      return `${who(event)} 在等我回复，它在问什么？`;
    case 'delegate-done':
    case 'delegate-failed':
      return `你刚才交给 ${who(event)} 的活${subject ? `「${subject}」` : ''}，结果怎么样？`;
    default:
      return '';
  }
}

function hash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) >>> 0;
  }
  return value;
}

/** 挑一句台词。按去重键哈希而不是随机：同一件事在桌面与实体屏上说的是同一句。 */
export function lineFor(event: NudgeEvent, preset: PersonaPreset, nickname = ''): string {
  const list = templates[preset][event.kind];
  const text = list[hash(event.key) % list.length]!(event);
  // 称呼偶尔带一下（只在招呼类），每句都带就成了客服腔。
  if (nickname !== '' && nudgeGroupOf[event.kind] === 'ritual' && hash(event.key) % 2 === 0) {
    return `${nickname}，${text}`;
  }
  return text;
}

function prune(state: ProactiveState, now: number): ProactiveState {
  return { ...state, shownAt: state.shownAt.filter((at) => now - at < 3_600_000) };
}

function record(
  state: ProactiveState,
  nudge: Nudge,
  outcome: NudgeOutcome,
  now: number,
): ProactiveState {
  return {
    ...state,
    history: [
      { id: nudge.id, kind: nudge.kind, text: nudge.text, at: now, outcome },
      ...state.history,
    ].slice(0, proactiveLimits.history),
  };
}

/** 把队头推上屏；亮起来的那一刻才开始计时。 */
function promote(state: ProactiveState, now: number): ProactiveState {
  if (state.current !== null || state.queue.length === 0) return state;
  const [head, ...rest] = state.queue;
  if (!head) return state;
  return {
    ...state,
    current: { ...head, at: now, expiresAt: now + proactiveLimits.showMs },
    queue: rest,
    shownAt: [...state.shownAt, now],
    lastByKind: { ...state.lastByKind, [head.kind]: now },
  };
}

export type OfferResult =
  | { accepted: true; state: ProactiveState; nudge: Nudge }
  | {
      accepted: false;
      state: ProactiveState;
      reason: 'disabled' | 'group-off' | 'seen' | 'cooldown' | 'budget' | 'queue-full';
    };

/**
 * 有件事想跟你说。过预算就上屏（或排队），不过就咽回去。
 * 咽回去的也记成「说过了」？不——只有「说过」才进 seen，预算恢复后同类新事件还能说。
 */
export function offer(
  input: ProactiveState,
  event: NudgeEvent,
  context: { now: number; id: string; preset: PersonaPreset; nickname?: string },
): OfferResult {
  const { now } = context;
  const state = prune(input, now);
  if (!state.config.enabled) return { accepted: false, state, reason: 'disabled' };
  if (!state.config.groups[nudgeGroupOf[event.kind]]) {
    return { accepted: false, state, reason: 'group-off' };
  }
  if (state.seen.includes(event.key)) return { accepted: false, state, reason: 'seen' };
  const urgent = urgentKinds.has(event.kind);
  const last = state.lastByKind[event.kind];
  const penalty = state.penalty[event.kind] ?? 1;
  if (!urgent && last !== undefined && now - last < proactiveLimits.cooldownMs * penalty) {
    return { accepted: false, state, reason: 'cooldown' };
  }
  const pendingCount = state.queue.length + (state.current ? 1 : 0);
  if (state.shownAt.length + pendingCount >= proactiveLimits.perHour && !urgent) {
    return { accepted: false, state, reason: 'budget' };
  }
  if (state.queue.length >= proactiveLimits.queue) {
    return { accepted: false, state, reason: 'queue-full' };
  }
  const nudge: Nudge = {
    id: context.id,
    kind: event.kind,
    key: event.key,
    text: lineFor(event, context.preset, context.nickname ?? ''),
    mood: moodOf[event.kind],
    at: now,
    expiresAt: now + proactiveLimits.showMs,
    askPrompt: askPromptOf(event),
  };
  const queue = [...state.queue, nudge].sort((a, b) => priorityOf[b.kind] - priorityOf[a.kind]);
  const next = promote(
    {
      ...state,
      queue,
      seen: [...state.seen, event.key].slice(-proactiveLimits.seen),
    },
    now,
  );
  return {
    accepted: true,
    state: next,
    nudge: next.current?.id === nudge.id ? next.current : nudge,
  };
}

/**
 * 你对屏上那张卡的回应。A = 接（细说/好），B = 知道了。
 * 被 B 掉的那类事件冷却翻倍；接了就恢复正常。
 */
export function respond(
  state: ProactiveState,
  id: string,
  answer: 'accept' | 'dismiss',
  now: number,
): { state: ProactiveState; nudge: Nudge | null } {
  const current = state.current;
  if (!current || current.id !== id) return { state, nudge: null };
  const penalty = state.penalty[current.kind] ?? 1;
  const nextPenalty = answer === 'dismiss' ? Math.min(proactiveLimits.maxPenalty, penalty * 2) : 1;
  const recorded = record(
    { ...state, current: null, penalty: { ...state.penalty, [current.kind]: nextPenalty } },
    current,
    answer === 'accept' ? 'accepted' : 'dismissed',
    now,
  );
  return { state: promote(recorded, now), nudge: current };
}

/**
 * 时间推进：没人理的卡自己收起来，队里下一张顶上。
 * 没人理也是一种回答：和「知道了」一样翻倍这类事件的冷却。
 * 否则人不在座位上时它会按最短冷却一遍遍对着空椅子说话。
 */
export function expire(state: ProactiveState, now: number): ProactiveState {
  const current = state.current;
  // 屏上空着但队里还有（比如刚关掉一组把当前卡清了）：补上。
  if (!current) return promote(state, now);
  if (current.expiresAt > now) return state;
  const penalty = state.penalty[current.kind] ?? 1;
  const nextPenalty = Math.min(proactiveLimits.maxPenalty, penalty * 2);
  return promote(
    record(
      { ...state, current: null, penalty: { ...state.penalty, [current.kind]: nextPenalty } },
      current,
      'expired',
      now,
    ),
    now,
  );
}

/** 关掉主动开口时，屏上与队里的一并清掉。 */
export function configure(state: ProactiveState, config: ProactiveConfig): ProactiveState {
  if (config.enabled) {
    const keep = (nudge: Nudge): boolean => config.groups[nudgeGroupOf[nudge.kind]];
    return {
      ...state,
      config,
      current: state.current && keep(state.current) ? state.current : null,
      queue: state.queue.filter(keep),
    };
  }
  return { ...state, config, current: null, queue: [] };
}

/** 给窗口看的快照：不含 seen / penalty 这类内部账本。 */
export interface ProactiveSnapshot {
  config: ProactiveConfig;
  current: Nudge | null;
  queued: number;
  history: NudgeRecord[];
  /** 摸摸的一句反应，亮到 until。 */
  petLine: { text: string; until: number } | null;
  bond: {
    dayNumber: number;
    daysTogether: number;
    streak: number;
    longestStreak: number;
    pets: number;
    todosDone: number;
    focusMinutes: number;
    today: { todosDone: number; focusMinutes: number; delegated: number; pets: number };
  };
}

/** 接受率：面板上看「它说的话有没有用」。 */
export function acceptance(state: ProactiveState): { shown: number; accepted: number } {
  return {
    shown: state.history.length,
    accepted: state.history.filter((item) => item.outcome === 'accepted').length,
  };
}
