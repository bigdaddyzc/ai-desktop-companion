/**
 * 「你们认识多久了」——关系的形状。
 *
 * 伙伴感不只来自说话的语气，还来自「它记得你们一起走了多远」：
 * 第一次见面是哪天、连续见了几天、你划掉过多少件事、一起专注了多少分钟。
 * 这些数字只存本机，用来让摸摸的反应、早晚的招呼、AI 的语气带上「熟悉度」。
 *
 * 纯领域层：时间由调用方传入，日期按本机时区切分。
 */

export interface BondDay {
  /** 本机日期 YYYY-MM-DD。 */
  day: string;
  todosDone: number;
  focusMinutes: number;
  delegated: number;
  pets: number;
}

export interface BondState {
  version: 1;
  firstMetAt: number;
  lastSeenAt: number;
  lastSeenDay: string;
  /** 见过面的不同日子数。 */
  daysTogether: number;
  streak: number;
  longestStreak: number;
  pets: number;
  todosDone: number;
  focusMinutes: number;
  /** 今天的小账本，收工时用。 */
  today: BondDay;
  /** 今天已打过哪些招呼，避免一天说两遍早安。 */
  greeted: { morning: string; evening: string };
  /** 已经说过的里程碑 key。 */
  milestones: string[];
}

export const bondTuning = {
  /** 多久没见算「久别」。 */
  reunionDays: 3,
  morning: { from: 5, to: 11 },
  evening: { from: 18, to: 24 },
  /** 短时间内猛摸的判定。 */
  petBurst: { windowMs: 10_000, count: 5 },
  dayMilestones: [7, 30, 100, 365],
  todoMilestones: [10, 100, 500],
} as const;

export function dayKey(now: number): string {
  const date = new Date(now);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function hourOf(now: number): number {
  return new Date(now).getHours();
}

function freshDay(day: string): BondDay {
  return { day, todosDone: 0, focusMinutes: 0, delegated: 0, pets: 0 };
}

export function emptyBond(now: number): BondState {
  const day = dayKey(now);
  return {
    version: 1,
    firstMetAt: now,
    lastSeenAt: 0,
    lastSeenDay: '',
    daysTogether: 0,
    streak: 0,
    longestStreak: 0,
    pets: 0,
    todosDone: 0,
    focusMinutes: 0,
    today: freshDay(day),
    greeted: { morning: '', evening: '' },
    milestones: [],
  };
}

/** 两个日期相差几天（按日历日，不按 24 小时）。 */
export function daysBetween(fromDay: string, toDay: string): number {
  const parse = (value: string): number => {
    const [y, m, d] = value.split('-').map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  };
  if (fromDay === '' || toDay === '') return 0;
  return Math.round((parse(toDay) - parse(fromDay)) / 86_400_000);
}

/** 认识第几天（第一天算 1）。 */
export function dayNumber(bond: BondState, now: number): number {
  return daysBetween(dayKey(bond.firstMetAt), dayKey(now)) + 1;
}

/** 跨天时把「今天」翻页。 */
function rollDay(bond: BondState, now: number): BondState {
  const day = dayKey(now);
  return bond.today.day === day ? bond : { ...bond, today: freshDay(day) };
}

export type BondMoment =
  | { kind: 'reunion'; days: number }
  | { kind: 'morning'; streak: number }
  | { kind: 'evening'; today: BondDay }
  | { kind: 'milestone'; key: string; days?: number; todos?: number };

/**
 * 用户出现了（有任何一次主动操作）。
 *
 * 招呼挂在「人来了」上而不是挂在时钟上：应用通宵开着时，凌晨五点没人听它说早安。
 */
export function touch(bond: BondState, now: number): { bond: BondState; moments: BondMoment[] } {
  const day = dayKey(now);
  let next = rollDay(bond, now);
  const moments: BondMoment[] = [];
  if (next.lastSeenDay !== day) {
    const gap = next.lastSeenDay === '' ? 0 : daysBetween(next.lastSeenDay, day);
    const streak = gap === 1 ? next.streak + 1 : 1;
    next = {
      ...next,
      daysTogether: next.daysTogether + 1,
      streak,
      longestStreak: Math.max(next.longestStreak, streak),
      lastSeenDay: day,
    };
    if (gap >= bondTuning.reunionDays) moments.push({ kind: 'reunion', days: gap });
    const number = dayNumber(next, now);
    for (const mark of bondTuning.dayMilestones) {
      const key = `day-${mark}`;
      if (number >= mark && !next.milestones.includes(key)) {
        next = { ...next, milestones: [...next.milestones, key] };
        if (number === mark) moments.push({ kind: 'milestone', key, days: mark });
      }
    }
  }
  const hour = hourOf(now);
  const reunion = moments.some((moment) => moment.kind === 'reunion');
  if (
    hour >= bondTuning.morning.from &&
    hour < bondTuning.morning.to &&
    next.greeted.morning !== day
  ) {
    next = { ...next, greeted: { ...next.greeted, morning: day } };
    if (!reunion) moments.push({ kind: 'morning', streak: next.streak });
  }
  if (
    hour >= bondTuning.evening.from &&
    hour < bondTuning.evening.to &&
    next.greeted.evening !== day
  ) {
    next = { ...next, greeted: { ...next.greeted, evening: day } };
    // 一件事都没做的晚上不做「收工小结」，那只会像在点名批评。
    const busy = next.today.todosDone + next.today.focusMinutes + next.today.delegated > 0;
    if (busy && !reunion) moments.push({ kind: 'evening', today: next.today });
  }
  return { bond: { ...next, lastSeenAt: now }, moments };
}

export function recordTodoDone(
  bond: BondState,
  now: number,
): { bond: BondState; moments: BondMoment[] } {
  const rolled = rollDay(bond, now);
  const todos = rolled.todosDone + 1;
  let next: BondState = {
    ...rolled,
    todosDone: todos,
    today: { ...rolled.today, todosDone: rolled.today.todosDone + 1 },
  };
  const moments: BondMoment[] = [];
  for (const mark of bondTuning.todoMilestones) {
    const key = `todo-${mark}`;
    if (todos === mark && !next.milestones.includes(key)) {
      next = { ...next, milestones: [...next.milestones, key] };
      moments.push({ kind: 'milestone', key, todos: mark });
    }
  }
  return { bond: next, moments };
}

export function recordFocus(bond: BondState, minutes: number, now: number): BondState {
  const value = Math.max(0, Math.min(180, Math.round(minutes)));
  if (value === 0) return bond;
  const rolled = rollDay(bond, now);
  return {
    ...rolled,
    focusMinutes: rolled.focusMinutes + value,
    today: { ...rolled.today, focusMinutes: rolled.today.focusMinutes + value },
  };
}

export function recordDelegated(bond: BondState, now: number): BondState {
  const rolled = rollDay(bond, now);
  return { ...rolled, today: { ...rolled.today, delegated: rolled.today.delegated + 1 } };
}

export function recordPet(bond: BondState, now: number): BondState {
  const rolled = rollDay(bond, now);
  return {
    ...rolled,
    pets: rolled.pets + 1,
    today: { ...rolled.today, pets: rolled.today.pets + 1 },
  };
}

/** 熟悉程度：按见面天数和摸摸次数粗分三档。 */
export type Closeness = 'new' | 'familiar' | 'old-friend';

export function closenessOf(bond: BondState): Closeness {
  if (bond.daysTogether >= 30 || bond.pets >= 300) return 'old-friend';
  if (bond.daysTogether >= 4 || bond.pets >= 30) return 'familiar';
  return 'new';
}

const petLines: Record<Closeness, readonly string[]> = {
  new: ['有点痒', '嗯？摸我干嘛', '……谢谢啊'],
  familiar: ['嘿嘿', '再摸一下也行', '收到你的摸摸啦', '今天心情不错？'],
  'old-friend': ['老一套了是吧', '知道你想我了', '行行行，随你摸', '摸完记得干活'],
};

const burstLines: readonly string[] = ['好了好了，毛都秃了', '再摸收费了', '你是不是在摸鱼'];

/**
 * 摸摸的一句反应。连续猛摸会「烦」；越熟话越随便。
 * 按摸摸总数轮换而不是随机：同一时刻两个窗口、实体屏看到的是同一句。
 */
export function petLine(bond: BondState, recentPetTimes: readonly number[], now: number): string {
  const recent = recentPetTimes.filter((at) => now - at <= bondTuning.petBurst.windowMs).length;
  if (recent >= bondTuning.petBurst.count) return burstLines[bond.pets % burstLines.length]!;
  const lines = petLines[closenessOf(bond)];
  return lines[bond.pets % lines.length]!;
}

/**
 * 给 AI 的一行关系背景。只给事实，不给语气要求——语气归人格管。
 * 认识不到两天不说：「你们认识 1 天了」是废话。
 */
export function bondPrompt(bond: BondState, now: number): string {
  const days = dayNumber(bond, now);
  if (bond.daysTogether < 2) return '';
  const parts = [`你们认识第 ${days} 天，见过 ${bond.daysTogether} 天`];
  if (bond.streak >= 3) parts.push(`连续 ${bond.streak} 天都见了面`);
  if (bond.today.todosDone > 0) parts.push(`今天用户划掉了 ${bond.today.todosDone} 件事`);
  if (bond.today.focusMinutes > 0) parts.push(`今天一起专注了 ${bond.today.focusMinutes} 分钟`);
  return `关系背景（事实，别主动播报，用得上再提）：${parts.join('，')}。`;
}

/** 读盘时的宽松校验：字段缺了就补默认，类型不对就丢，不让一个坏字段清空整段关系。 */
export function normalizeBond(raw: unknown, now: number): BondState {
  const base = emptyBond(now);
  if (typeof raw !== 'object' || raw === null) return base;
  const value = raw as Record<string, unknown>;
  const num = (key: string, fallback: number): number => {
    const item = value[key];
    return typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : fallback;
  };
  const str = (item: unknown, fallback: string): string =>
    typeof item === 'string' && item.length <= 32 ? item : fallback;
  const todayRaw =
    typeof value['today'] === 'object' && value['today'] !== null
      ? (value['today'] as Record<string, unknown>)
      : {};
  const greetedRaw =
    typeof value['greeted'] === 'object' && value['greeted'] !== null
      ? (value['greeted'] as Record<string, unknown>)
      : {};
  const count = (item: unknown): number =>
    typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : 0;
  return {
    version: 1,
    firstMetAt: num('firstMetAt', base.firstMetAt),
    lastSeenAt: num('lastSeenAt', 0),
    lastSeenDay: str(value['lastSeenDay'], ''),
    daysTogether: num('daysTogether', 0),
    streak: num('streak', 0),
    longestStreak: num('longestStreak', 0),
    pets: num('pets', 0),
    todosDone: num('todosDone', 0),
    focusMinutes: num('focusMinutes', 0),
    today: {
      day: str(todayRaw['day'], base.today.day),
      todosDone: count(todayRaw['todosDone']),
      focusMinutes: count(todayRaw['focusMinutes']),
      delegated: count(todayRaw['delegated']),
      pets: count(todayRaw['pets']),
    },
    greeted: {
      morning: str(greetedRaw['morning'], ''),
      evening: str(greetedRaw['evening'], ''),
    },
    milestones: Array.isArray(value['milestones'])
      ? value['milestones'].filter((item): item is string => typeof item === 'string').slice(0, 64)
      : [],
  };
}
