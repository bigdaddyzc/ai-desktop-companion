import { readFile } from 'node:fs/promises';
import {
  bondPrompt,
  dayKey,
  dayNumber,
  emptyBond,
  normalizeBond,
  petLine,
  recordDelegated,
  recordFocus,
  recordPet,
  recordTodoDone,
  touch,
  type BondMoment,
  type BondState,
} from '../core/bond';
import { momentNudges } from '../core/nudge-sources';
import {
  configure,
  emptyProactive,
  expire,
  normalizeProactive,
  nudgeGroupOf,
  offer,
  respond,
  type Nudge,
  type NudgeEvent,
  type NudgeRecord,
  type ProactiveSnapshot,
  type ProactiveState,
} from '../core/proactive';
import type { PersonaConfig } from '../core/persona';
import { writeJsonAtomic } from './atomic';

/**
 * 主动开口 + 关系账本的服务层。
 *
 * 两个文件，都在 userData：
 * - `proactive-v1.json`：开关与最近 30 条「它说过的话」及你的回应；
 * - `bond-v1.json`：认识第几天、连续几天、摸了几次、划掉几件。
 * 都是本机、原子写、不进导出、不出站。读失败就当第一次见面，不打断启动。
 */
export class ProactiveService {
  private state: ProactiveState = emptyProactive();
  private bond: BondState;
  private pet: { text: string; until: number } | null = null;
  private petTimes: number[] = [];
  private sequence = 0;
  private readonly listeners = new Set<(snapshot: ProactiveSnapshot) => void>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly paths: { config: string; bond: string },
    private readonly persona: () => PersonaConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.bond = emptyBond(now());
  }

  async init(): Promise<void> {
    const now = this.now();
    const config = await readJson(this.paths.config);
    const record =
      typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
    this.state = {
      ...emptyProactive(normalizeProactive(record['config'])),
      history: normalizeHistory(record['history']),
    };
    const bond = await readJson(this.paths.bond);
    this.bond = bond === null ? emptyBond(now) : normalizeBond(bond, now);
  }

  snapshot(): ProactiveSnapshot {
    const now = this.now();
    return {
      config: this.state.config,
      current: this.state.current,
      queued: this.state.queue.length,
      history: this.state.history,
      petLine: this.pet !== null && this.pet.until > now ? this.pet : null,
      bond: {
        dayNumber: dayNumber(this.bond, now),
        daysTogether: this.bond.daysTogether,
        streak: this.bond.streak,
        longestStreak: this.bond.longestStreak,
        pets: this.bond.pets,
        todosDone: this.bond.todosDone,
        focusMinutes: this.bond.focusMinutes,
        today: {
          todosDone: this.bond.today.todosDone,
          focusMinutes: this.bond.today.focusMinutes,
          delegated: this.bond.today.delegated,
          pets: this.bond.today.pets,
        },
      },
    };
  }

  subscribe(listener: (snapshot: ProactiveSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 当前屏上的那张卡。 */
  current(): Nudge | null {
    return this.state.current;
  }

  /** 给 AI 的一行关系背景。 */
  prompt(): string {
    return bondPrompt(this.bond, this.now());
  }

  /** 有件事想跟你说。返回新上屏或排上队的那张卡；被预算挡下时返回 null。 */
  offer(event: NudgeEvent): Nudge | null {
    const now = this.now();
    this.sequence += 1;
    const persona = this.persona();
    const result = offer(this.state, event, {
      now,
      id: `n${now.toString(36)}${this.sequence.toString(36)}`,
      preset: persona.preset,
      nickname: persona.nickname,
    });
    this.state = result.state;
    if (!result.accepted) return null;
    this.publish();
    return result.nudge;
  }

  offerAll(events: readonly NudgeEvent[]): Nudge[] {
    return events.map((event) => this.offer(event)).filter((item): item is Nudge => item !== null);
  }

  /** 你对屏上那张卡的回应。id 对不上（旧卡、已过期）时忽略。 */
  respond(id: unknown, answer: unknown): Nudge | null {
    if (typeof id !== 'string' || (answer !== 'accept' && answer !== 'dismiss')) return null;
    const result = respond(this.state, id, answer, this.now());
    if (result.nudge === null) return null;
    this.state = result.state;
    this.persistConfig();
    this.publish();
    return result.nudge;
  }

  /** 定时推进：过期的卡收起来。 */
  tick(): void {
    const before = this.state;
    const now = this.now();
    this.state = expire(this.state, now);
    const petExpired = this.pet !== null && this.pet.until <= now;
    if (petExpired) this.pet = null;
    if (this.state !== before) this.persistConfig();
    if (this.state !== before || petExpired) this.publish();
  }

  async saveConfig(raw: unknown): Promise<{ ok: boolean; error?: string }> {
    const config = normalizeProactive(raw);
    const previous = this.state;
    this.state = configure(this.state, config);
    const saved = await this.persistConfig();
    if (!saved) {
      this.state = previous;
      return { ok: false, error: '设置没有保存成功，请重试。' };
    }
    this.publish();
    return { ok: true };
  }

  /** 你出现了。早安/收工/久别重逢/纪念日都挂在这里。 */
  touch(openTodos: number): Nudge[] {
    const now = this.now();
    const { bond, moments } = touch(this.bond, now);
    const changed = bond.lastSeenDay !== this.bond.lastSeenDay || moments.length > 0;
    this.bond = bond;
    if (changed) this.persistBond();
    return this.momentsToNudges(moments, openTodos);
  }

  todoDone(openTodos: number): Nudge[] {
    const result = recordTodoDone(this.bond, this.now());
    this.bond = result.bond;
    this.persistBond();
    this.publish();
    return this.momentsToNudges(result.moments, openTodos);
  }

  focusDone(minutes: number): void {
    this.bond = recordFocus(this.bond, minutes, this.now());
    this.persistBond();
    this.publish();
  }

  delegated(): void {
    this.bond = recordDelegated(this.bond, this.now());
    this.persistBond();
  }

  /** 摸摸。返回这一下的反应，并在屏上亮 4 秒。 */
  petted(): string {
    const now = this.now();
    this.petTimes = [...this.petTimes.filter((at) => now - at < 60_000), now];
    this.bond = recordPet(this.bond, now);
    const text = petLine(this.bond, this.petTimes, now);
    this.pet = { text, until: now + 4_000 };
    this.persistBond();
    this.publish();
    return text;
  }

  async settled(): Promise<void> {
    await this.writes;
  }

  private momentsToNudges(moments: readonly BondMoment[], openTodos: number): Nudge[] {
    if (moments.length === 0) return [];
    return this.offerAll(momentNudges(moments, { day: dayKey(this.now()), openTodos }));
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private queue(task: () => Promise<void>): Promise<boolean> {
    const run = this.writes.then(async () => {
      try {
        await task();
        return true;
      } catch {
        return false;
      }
    });
    this.writes = run;
    return run;
  }

  private persistConfig(): Promise<boolean> {
    return this.queue(() =>
      writeJsonAtomic(this.paths.config, {
        version: 1,
        config: this.state.config,
        history: this.state.history,
      }),
    );
  }

  private persistBond(): Promise<boolean> {
    return this.queue(() => writeJsonAtomic(this.paths.bond, this.bond));
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

const outcomes = new Set(['accepted', 'dismissed', 'expired']);

function normalizeHistory(raw: unknown): NudgeRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: NudgeRecord[] = [];
  for (const item of raw.slice(0, 30)) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    if (
      typeof value['id'] === 'string' &&
      typeof value['kind'] === 'string' &&
      Object.hasOwn(nudgeGroupOf, value['kind']) &&
      typeof value['text'] === 'string' &&
      typeof value['at'] === 'number' &&
      typeof value['outcome'] === 'string' &&
      outcomes.has(value['outcome'])
    ) {
      out.push({
        id: value['id'].slice(0, 64),
        kind: value['kind'] as NudgeRecord['kind'],
        text: value['text'].slice(0, 120),
        at: value['at'],
        outcome: value['outcome'] as NudgeRecord['outcome'],
      });
    }
  }
  return out;
}
