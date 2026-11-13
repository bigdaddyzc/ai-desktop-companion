import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookTarget, HookTargetStatus, HooksStatus } from '../src/core/hook-install';
import { findLost, hookWatchLimits, seedExpected } from '../src/core/hook-watch';
import { HookWatchService, type HookWatchInstaller } from '../src/desktop/hook-watch';
import { HookInstaller } from '../src/desktop/hooks';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-hookwatch-'));
  directories.push(directory);
  return directory;
}

const item = (status: HookTargetStatus['status']): HookTargetStatus => ({
  status,
  path: 'x',
  note: '',
});

function statusOf(map: Partial<Record<HookTarget, HookTargetStatus['status']>>): HooksStatus {
  return {
    claudeCode: item(map['claude-code'] ?? 'absent'),
    codex: item(map.codex ?? 'absent'),
    workbuddy: item(map.workbuddy ?? 'absent'),
    codebuddy: item(map.codebuddy ?? 'absent'),
    node: true,
    lastEventAt: 0,
  };
}

/** 假安装器：状态可以随时被「别的工具」改掉，装一次就变成 installed。 */
function fakeInstaller(initial: Partial<Record<HookTarget, HookTargetStatus['status']>>) {
  const map = { ...initial };
  const installs: HookTarget[] = [];
  const installer: HookWatchInstaller = {
    status: () => Promise.resolve(statusOf(map)),
    apply: (target, action) => {
      if (action === 'install') {
        installs.push(target);
        map[target] = 'installed';
      } else map[target] = 'absent';
      return Promise.resolve({ ok: true });
    },
  };
  return { installer, installs, map };
}

async function watcher(
  installer: HookWatchInstaller,
  inbox = '',
  clock = { now: 1_000_000 },
): Promise<{
  watch: HookWatchService;
  asks: string[];
  repaired: boolean[];
  path: string;
  clock: { now: number };
}> {
  const path = join(await temp(), 'hook-watch-v1.json');
  const asks: string[] = [];
  const repaired: boolean[] = [];
  const watch = new HookWatchService(
    installer,
    path,
    () => Promise.resolve(inbox),
    {
      ask: (_targets, key) => asks.push(key),
      repaired: (record) => repaired.push(record.ok),
    },
    () => clock.now,
  );
  await watch.load();
  return { watch, asks, repaired, path, clock };
}

describe('钩子自检：纯规则', () => {
  it('第一次运行：装着的 + 收件箱里出现过的来源，都算「装过」', () => {
    const status = statusOf({ workbuddy: 'installed' });
    const inbox = '{"v":1,"src":"claude","ev":"Stop"}\n{"v":1,"src":"workbuddy","ev":"Stop"}\n';
    expect(seedExpected(status, inbox)).toEqual(['claude-code', 'workbuddy']);
    expect(seedExpected(statusOf({}), '')).toEqual([]);
  });

  it('分出能修与修不了', () => {
    const status = statusOf({
      'claude-code': 'absent',
      codex: 'conflict',
      workbuddy: 'partial',
      codebuddy: 'installed',
    });
    expect(findLost(status, ['claude-code', 'codex', 'workbuddy', 'codebuddy'])).toEqual({
      lost: ['claude-code', 'workbuddy'],
      blocked: ['codex'],
    });
  });
});

describe('钩子自检：先问、同意后自动', () => {
  it('丢了先问一次（同一次丢失不重复问），不自作主张装', async () => {
    const { installer, installs } = fakeInstaller({ workbuddy: 'installed' });
    const { watch, asks } = await watcher(installer, '{"src":"claude"}');
    await watch.check();
    await watch.check();
    expect(watch.snapshot()).toMatchObject({ lost: ['claude-code'], consent: 'ask' });
    expect(asks).toHaveLength(1);
    expect(installs).toEqual([]);
  });

  it('你同意重装：装回去、改成自动、落盘；之后再丢自动装回并告诉你', async () => {
    const { installer, installs, map } = fakeInstaller({});
    const { watch, repaired, path, clock } = await watcher(installer, '{"src":"claude"}');
    await watch.check();
    const record = await watch.repair();
    expect(record).toMatchObject({ ok: true, targets: ['claude-code'], auto: false });
    expect(watch.snapshot()).toMatchObject({ lost: [], consent: 'auto' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      consent: 'auto',
      expected: ['claude-code'],
    });

    // cc-switch 又还原了一次。
    map['claude-code'] = 'absent';
    clock.now += hookWatchLimits.intervalMs;
    await watch.check();
    expect(installs).toEqual(['claude-code', 'claude-code']);
    expect(repaired).toEqual([true]);
    expect(watch.snapshot().lost).toEqual([]);

    // 刚修完马上又丢：冷却内不拉锯，只报告；冷却过了再修。
    map['claude-code'] = 'absent';
    clock.now += 60_000;
    await watch.check();
    expect(installs).toHaveLength(2);
    expect(watch.snapshot().lost).toEqual(['claude-code']);
    clock.now += hookWatchLimits.repairCooldownMs;
    await watch.check();
    expect(installs).toHaveLength(3);
  });

  it('你卸载的不会被装回去；读不懂的配置不动', async () => {
    const { installer, installs, map } = fakeInstaller({
      'claude-code': 'installed',
      codex: 'installed',
    });
    const { watch } = await watcher(installer);
    await watch.setConsent('auto');
    await watch.check();
    await installer.apply('claude-code', 'uninstall');
    await watch.applied('claude-code', 'uninstall');
    map.codex = 'unreadable';
    await watch.check();
    expect(watch.snapshot()).toMatchObject({ lost: [], blocked: ['codex'], expected: ['codex'] });
    expect(installs).toEqual([]);
  });
});

describe('钩子自检：真安装器', () => {
  it('settings.json 被整个还原（cc-switch）→ 发现 → 同意 → 装回且不动用户的其他配置', async () => {
    const dir = await temp();
    const claudeHome = join(dir, '.claude');
    const installer = new HookInstaller(
      {
        dataDir: join(dir, 'data'),
        claudeHome,
        codexHome: join(dir, '.codex'),
        workbuddyHome: join(dir, '.workbuddy'),
        codebuddyHome: join(dir, '.codebuddy'),
        scriptSource: fileURLToPath(
          new URL('../src/desktop/hook/xinban-hook.cjs', import.meta.url),
        ),
      },
      () => 0,
      async () => true,
    );
    expect(await installer.apply('claude-code', 'install')).toEqual({ ok: true });
    const { watch, asks } = await watcher(installer);
    await watch.check();
    expect(watch.snapshot()).toMatchObject({ expected: ['claude-code'], lost: [] });

    // 另一个工具把文件整个换掉：只剩它自己的字段。
    const settings = join(claudeHome, 'settings.json');
    const restored = { enabledPlugins: { 'x@y': true }, env: { FOO: '1' } };
    await writeFile(settings, JSON.stringify(restored));
    await watch.check();
    expect(watch.snapshot().lost).toEqual(['claude-code']);
    expect(asks).toHaveLength(1);

    expect(await watch.repair()).toMatchObject({ ok: true });
    expect(watch.snapshot().lost).toEqual([]);
    const after = JSON.parse(await readFile(settings, 'utf8'));
    expect(after).toMatchObject(restored);
    expect(JSON.stringify(after.hooks)).toContain('xinban-hook');
  });
});
