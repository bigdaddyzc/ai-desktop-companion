import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  defaultSenses,
  emptyReading,
  normalizeReading,
  normalizeSenses,
  presentFrom,
  senseTuning,
  type SensesConfig,
  type SensesReading,
  type SensesSnapshot,
} from '../core/senses';
import { writeJsonAtomic } from './atomic';

/**
 * 耳朵与眼睛的状态持有者。
 *
 * 分工是刻意的：**配置和读数在主体进程**，**采集在桌宠窗口**。
 * 采集必须发生在有画面的渲染进程里；但两个窗口都要看到同一份「它在听吗」，
 * 模型也要在每次请求前拿到同一份读数——所以读数上报到主进程，再广播回来。
 *
 * 这里没有录像、没有缓冲、没有音频数组：能存的只有三个开关和几个 0~1 的数字。
 */

const storedSchema = z
  .object({
    version: z.literal(1),
    voice: z.boolean().optional(),
    ears: z.boolean().optional(),
    eyes: z.boolean().optional(),
  })
  .strict();

export class SensesStore {
  constructor(private readonly path: string) {}

  /** 文件不存在、损坏、字段不认识，一律当作全关——默认不该自己打开摄像头。 */
  async load(): Promise<SensesConfig> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return { ...defaultSenses };
    }
    try {
      return normalizeSenses(storedSchema.parse(JSON.parse(raw)));
    } catch {
      return { ...defaultSenses };
    }
  }

  async save(config: SensesConfig): Promise<void> {
    const clean = normalizeSenses(config);
    await writeJsonAtomic(this.path, { version: 1, ...clean });
  }
}

export class SensesService {
  private config: SensesConfig = { ...defaultSenses };
  private reading: SensesReading = emptyReading();
  private readonly listeners = new Set<(snapshot: SensesSnapshot) => void>();
  private lastBroadcastAt = 0;

  constructor(private readonly store: SensesStore) {}

  async init(): Promise<void> {
    this.config = await this.store.load();
  }

  snapshot(): SensesSnapshot {
    return { config: this.config, reading: this.reading };
  }

  subscribe(listener: (snapshot: SensesSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  /**
   * 保存开关。**先落盘成功再改内存**：写失败时面板要能说「没保存上」，
   * 而不是界面上打开了、重启又关回去。
   *
   * 关掉某个通道时顺手把它的读数清掉：否则屏幕上会留着「正在听」，
   * 而实际上采集已经停了——这种残留比不给状态更坏。
   */
  async save(input: unknown): Promise<{ ok: boolean; snapshot: SensesSnapshot; error?: string }> {
    const next = normalizeSenses(input);
    try {
      await this.store.save(next);
    } catch {
      return { ok: false, snapshot: this.snapshot(), error: '开关没有保存成功，请重试。' };
    }
    this.config = next;
    this.reading = {
      ...this.reading,
      mic: next.ears ? this.reading.mic : 'off',
      camera: next.eyes ? this.reading.camera : 'off',
      level: next.ears ? this.reading.level : 0,
      speaking: next.ears ? this.reading.speaking : false,
      // 摄像头关了就不该再声称「有人」；lastMotionAt 留着，重新打开时还有用。
      present: next.eyes ? this.reading.present : false,
      // lastMotionAt 保留：重新打开摄像头时，「刚才还看到人」是有效信息。
      error: next.ears || next.eyes ? this.reading.error : '',
    };
    this.lastBroadcastAt = 0;
    this.publish();
    return { ok: true, snapshot: this.snapshot() };
  }

  /**
   * 收到的读数按 800ms 节流广播。
   *
   * 采集端本来就更慢，这里再兜一层是为了防止某个实现每帧都发：
   * 1Hz 的时钟已经在广播快照，再叠一条高频通道，面板会明显掉帧。
   * 但**状态变化必须立刻广播**——「正在说话」慢半秒就失去了打断的意义。
   */
  report(raw: unknown, now: number): void {
    const previous = this.reading;
    const next = normalizeReading(raw, now);
    // 关掉的通道不接受上报：UI 已经关了，还有窗口在发就是不该采。
    const lastMotionAt = this.config.eyes ? next.lastMotionAt : previous.lastMotionAt;
    const reading: SensesReading = {
      ...next,
      mic: this.config.ears ? next.mic : 'off',
      camera: this.config.eyes ? next.camera : 'off',
      level: this.config.ears ? next.level : 0,
      speaking: this.config.ears ? next.speaking : false,
      lastMotionAt,
      // 「有人吗」只在这里算一次：渲染进程也用它自己的同一份时间戳算，
      // 两边规则来自同一个纯函数，不会出现「面板说有人、小屏说没人」。
      present: this.config.eyes ? presentFrom(lastMotionAt, now, true) : false,
    };
    this.reading = reading;
    const changed =
      reading.speaking !== previous.speaking ||
      reading.present !== previous.present ||
      reading.mic !== previous.mic ||
      reading.camera !== previous.camera ||
      reading.error !== previous.error;
    if (!changed && now - this.lastBroadcastAt < senseTuning.reportIntervalMs) return;
    this.lastBroadcastAt = now;
    this.publish();
  }

  /** 采集端关闭时把读数归零，避免面板显示一个再也不会更新的「开着」。 */
  clear(now: number): void {
    this.reading = { ...emptyReading(), at: now };
    this.publish();
  }
}
