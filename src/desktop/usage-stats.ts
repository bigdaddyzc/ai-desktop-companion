import { readFile } from 'node:fs/promises';
import type { ConfirmOutcome } from '../core/confirm';
import type { DelegateRecord } from '../core/delegate';
import {
  emptyUsage,
  normalizeUsage,
  recordDelegates,
  recordPermission,
  recordWaiting,
  usageView,
  type UsageState,
  type UsageWeekView,
} from '../core/usage-stats';
import type { WorkbenchSnapshot } from '../core/workbench';
import { writeJsonAtomic } from './atomic';

const outcomes: readonly ConfirmOutcome[] = [
  'allowed',
  'denied',
  'expired',
  'cancelled',
  'deferred',
  'remembered',
];

/** 自用计数：存 usage-v1.json，最多一分钟写一次盘（等待时长每 30 秒都在变）。 */
export class UsageService {
  private state: UsageState = emptyUsage();
  private lastObservedAt = 0;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly flushMs = 60_000,
  ) {}

  private fresh = false;

  async load(): Promise<void> {
    try {
      this.state = normalizeUsage(JSON.parse(await readFile(this.path, 'utf8')));
    } catch {
      this.state = emptyUsage();
      this.fresh = true;
    }
  }

  /** 第一次启用计数：已有的派活记录不补计，从现在开始数。 */
  baseline(history: readonly DelegateRecord[]): void {
    if (!this.fresh) return;
    this.fresh = false;
    const latest = history.reduce((max, item) => Math.max(max, item.at), 0);
    this.set({ ...this.state, lastDelegateAt: latest });
  }

  view(): UsageWeekView[] {
    return usageView(this.state, this.now());
  }

  permission(outcome: unknown, ms: unknown): void {
    if (typeof outcome !== 'string' || !outcomes.includes(outcome as ConfirmOutcome)) return;
    const next = recordPermission(
      this.state,
      outcome as ConfirmOutcome,
      typeof ms === 'number' ? ms : 0,
      this.now(),
    );
    this.set(next);
  }

  delegates(history: readonly DelegateRecord[]): void {
    this.set(recordDelegates(this.state, history));
  }

  observe(snapshot: Pick<WorkbenchSnapshot, 'counts'>): void {
    const now = this.now();
    const since = this.lastObservedAt === 0 ? 0 : now - this.lastObservedAt;
    this.lastObservedAt = now;
    this.set(recordWaiting(this.state, snapshot, since, now));
  }

  private set(next: UsageState): void {
    if (next === this.state) return;
    this.state = next;
    this.dirty = true;
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.flushMs);
      this.timer.unref?.();
    }
  }

  flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return this.writes;
    this.dirty = false;
    const value = this.state;
    const run = (): Promise<void> => writeJsonAtomic(this.path, value).catch(() => undefined);
    this.writes = this.writes.then(run, run);
    return this.writes;
  }
}
