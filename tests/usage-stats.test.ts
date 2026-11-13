import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DelegateRecord } from '../src/core/delegate';
import {
  emptyUsage,
  median,
  normalizeUsage,
  recordDelegates,
  recordPermission,
  recordWaiting,
  usageLimits,
  usageView,
  weekOf,
} from '../src/core/usage-stats';
import { UsageService } from '../src/desktop/usage-stats';

// 2026-11-12（周四）本地中午
const now = new Date(2026, 10, 12, 12, 0, 0).getTime();
const day = 24 * 60 * 60_000;

function delegate(at: number, outcome: DelegateRecord['outcome']): DelegateRecord {
  return { at, target: 'WorkBuddy', project: 'p', task: 't', outcome, ms: 1, code: 0, error: '' };
}

const counts = (waiting: number) => ({
  counts: { waiting, error: 0, unseen: 0, working: 0, idle: 0 },
});

describe('usage-stats', () => {
  it('按周一分桶', () => {
    expect(weekOf(now)).toBe('2026-11-09');
    expect(weekOf(new Date(2026, 10, 9, 0, 0, 1).getTime())).toBe('2026-11-09');
    expect(weekOf(new Date(2026, 10, 8, 23, 59).getTime())).toBe('2026-11-02');
  });

  it('接住/交回与响应中位数；cancelled 不计', () => {
    let state = emptyUsage();
    state = recordPermission(state, 'allowed', 4_000, now);
    state = recordPermission(state, 'denied', 10_000, now);
    state = recordPermission(state, 'remembered', 6_000, now);
    state = recordPermission(state, 'deferred', 45_000, now);
    state = recordPermission(state, 'expired', 45_000, now);
    state = recordPermission(state, 'cancelled', 1, now);
    const [week] = usageView(state, now);
    expect(week).toMatchObject({
      caught: 3,
      handedBack: 2,
      caughtRate: 0.6,
      medianResponseMs: 6_000,
    });
  });

  it('派活只计新的，取消不计', () => {
    const history = [
      delegate(now - 1_000, 'ok'),
      delegate(now - 2_000, 'failed'),
      delegate(now - 3_000, 'cancelled'),
    ];
    let state = recordDelegates(emptyUsage(), history);
    expect(usageView(state, now)[0]).toMatchObject({ delegates: 2, delegateOkRate: 0.5 });
    state = recordDelegates(state, history);
    expect(usageView(state, now)[0]!.delegates).toBe(2);
    expect(state.lastDelegateAt).toBe(now - 1_000);
  });

  it('等待时长按人数累加，间隔太长不算', () => {
    let state = recordWaiting(emptyUsage(), counts(2), 30_000, now);
    state = recordWaiting(state, counts(0), 30_000, now);
    state = recordWaiting(state, counts(1), usageLimits.maxGapMs + 1, now);
    expect(usageView(state, now)[0]!.waitingMs).toBe(60_000);
  });

  it('只留 4 周，上周单独一列', () => {
    let state = emptyUsage();
    for (let i = 0; i < 6; i += 1) state = recordPermission(state, 'allowed', 1, now - i * 7 * day);
    expect(state.weeks).toHaveLength(4);
    const view = usageView(state, now);
    expect(view.map((w) => w.week)).toEqual(['2026-11-09', '2026-11-02']);
    expect(view[1]!.caught).toBe(1);
  });

  it('中位数与容错读取', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(normalizeUsage('x')).toEqual(emptyUsage());
    expect(
      normalizeUsage({ weeks: [{ week: 'bad' }, { week: '2026-11-09', caught: -1 }] }).weeks,
    ).toEqual([
      {
        week: '2026-11-09',
        caught: 0,
        handedBack: 0,
        responseMs: [],
        waitingMs: 0,
        delegates: 0,
        delegatesOk: 0,
      },
    ]);
  });
});

describe('UsageService', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('第一次启用不补计旧派活；写盘后重启读得回来', async () => {
    dir = await mkdtemp(join(tmpdir(), 'xinban-usage-'));
    const path = join(dir, 'usage-v1.json');
    const svc = new UsageService(path, () => now, 10);
    await svc.load();
    svc.baseline([delegate(now - 5_000, 'ok')]);
    svc.delegates([delegate(now - 5_000, 'ok')]);
    expect(svc.view()[0]!.delegates).toBe(0);
    svc.delegates([delegate(now - 1_000, 'ok'), delegate(now - 5_000, 'ok')]);
    svc.permission('allowed', 3_000);
    svc.permission('nonsense', 3_000);
    await svc.flush();
    const disk = JSON.parse(await readFile(path, 'utf8'));
    expect(disk.weeks[0]).toMatchObject({ caught: 1, delegates: 1 });
    const again = new UsageService(path, () => now);
    await again.load();
    again.baseline([delegate(now, 'ok')]);
    expect(again.view()[0]).toMatchObject({ caught: 1, delegates: 1 });
  });
});
