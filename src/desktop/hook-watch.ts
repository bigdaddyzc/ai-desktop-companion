import { readFile } from 'node:fs/promises';
import type { HookTarget, HooksStatus } from '../core/hook-install';
import {
  findLost,
  hookWatchLimits,
  lostText,
  normalizeHookWatch,
  seedExpected,
  type HookRepairConsent,
  type HookRepairRecord,
  type HookWatchSnapshot,
  type HookWatchState,
} from '../core/hook-watch';
import { writeJsonAtomic } from './atomic';

/** 自检要用到的安装器能力：HookInstaller 实现它，测试里换成假的。 */
export interface HookWatchInstaller {
  status(): Promise<HooksStatus>;
  apply(
    target: HookTarget,
    action: 'install' | 'uninstall',
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface HookWatchEvents {
  /** 发现丢了、还没得到你同意：桌宠上问一句。key 同一次丢失只问一次。 */
  ask(targets: HookTarget[], key: string): void;
  /** 自动重装了：告诉你一声。 */
  repaired(record: HookRepairRecord): void;
}

/**
 * 钩子自检：启动时一次，之后每 5 分钟一次。
 * 只看「你装过的」是否还在；丢了先问，你同意一次就改成自动。
 */
export class HookWatchService {
  private state: HookWatchState = normalizeHookWatch(undefined);
  private lost: HookTarget[] = [];
  private blocked: HookTarget[] = [];
  private lastCheckAt = 0;
  private lastRepair: HookRepairRecord | null = null;
  private lostSince = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<void> | null = null;
  private readonly listeners = new Set<(snapshot: HookWatchSnapshot) => void>();

  constructor(
    private readonly installer: HookWatchInstaller,
    private readonly path: string,
    /** 收件箱全文：只在第一次运行时用来推断「装过哪些」。 */
    private readonly inbox: () => Promise<string>,
    private readonly events: HookWatchEvents,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    try {
      this.state = normalizeHookWatch(JSON.parse(await readFile(this.path, 'utf8')));
    } catch {
      this.state = normalizeHookWatch(undefined);
    }
  }

  snapshot(): HookWatchSnapshot {
    return {
      expected: [...this.state.expected],
      consent: this.state.consent,
      lost: [...this.lost],
      blocked: [...this.blocked],
      lastCheckAt: this.lastCheckAt,
      lastRepair: this.lastRepair,
    };
  }

  subscribe(listener: (snapshot: HookWatchSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private async save(next: HookWatchState): Promise<void> {
    this.state = next;
    try {
      await writeJsonAtomic(this.path, next);
    } catch {
      // 写不了：下次启动会重新推断。宁可多问一次。
    }
  }

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), hookWatchLimits.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 并发调用合并成一次。 */
  check(): Promise<void> {
    this.checking ??= this.runCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async runCheck(): Promise<void> {
    let status: HooksStatus;
    try {
      status = await this.installer.status();
    } catch {
      return;
    }
    if (!this.state.seeded) {
      const inbox = await this.inbox().catch(() => '');
      await this.save({ ...this.state, expected: seedExpected(status, inbox), seeded: true });
    }
    const found = findLost(status, this.state.expected);
    this.lastCheckAt = this.now();
    this.blocked = found.blocked;
    if (found.lost.length === 0) {
      this.lost = [];
      this.lostSince = 0;
      this.publish();
      return;
    }
    const fresh = this.lost.join() !== found.lost.join() || this.lostSince === 0;
    this.lost = found.lost;
    if (fresh) this.lostSince = this.lastCheckAt;
    if (this.state.consent === 'auto') {
      const since = this.lastRepair?.auto ? this.lastCheckAt - this.lastRepair.at : Infinity;
      // 刚自动修过又丢了：别和反复还原配置的工具拉锯，等冷却过了再修。
      if (since >= hookWatchLimits.repairCooldownMs) {
        await this.install(found.lost, true);
        return;
      }
    } else if (fresh) {
      this.events.ask(found.lost, `hooks-lost:${found.lost.join('+')}:${this.lostSince}`);
    }
    this.publish();
  }

  private async install(targets: HookTarget[], auto: boolean): Promise<HookRepairRecord> {
    const failed: string[] = [];
    for (const target of targets) {
      const result = await this.installer.apply(target, 'install').catch(() => ({
        ok: false as const,
        error: '写入失败。',
      }));
      if (!result.ok) failed.push(`${lostText([target])}：${result.error}`);
    }
    const record: HookRepairRecord = {
      at: this.now(),
      targets,
      ok: failed.length === 0,
      auto,
      error: failed.join('；'),
    };
    this.lastRepair = record;
    // 重新看一眼：修好了就清掉告警。
    try {
      const found = findLost(await this.installer.status(), this.state.expected);
      this.lost = found.lost;
      this.blocked = found.blocked;
      if (found.lost.length === 0) this.lostSince = 0;
    } catch {
      // 保持原状。
    }
    if (auto) this.events.repaired(record);
    this.publish();
    return record;
  }

  /**
   * 你同意重装（桌宠上按 A，或面板上点）。按用户定的规矩，同意一次就改成自动。
   */
  async repair(): Promise<HookRepairRecord> {
    const targets = [...this.lost];
    if (this.state.consent !== 'auto') await this.save({ ...this.state, consent: 'auto' });
    return this.install(targets, false);
  }

  async setConsent(consent: HookRepairConsent): Promise<void> {
    if (this.state.consent === consent) return;
    await this.save({ ...this.state, consent });
    this.publish();
  }

  /** 面板上亲手装/卸：更新「该有哪些」。卸载的不会被自动装回去。 */
  async applied(target: HookTarget, action: 'install' | 'uninstall'): Promise<void> {
    const has = this.state.expected.includes(target);
    if (action === 'install' && !has) {
      await this.save({ ...this.state, expected: [...this.state.expected, target], seeded: true });
    } else if (action === 'uninstall' && has) {
      await this.save({
        ...this.state,
        expected: this.state.expected.filter((item) => item !== target),
        seeded: true,
      });
    }
    await this.check();
  }
}
