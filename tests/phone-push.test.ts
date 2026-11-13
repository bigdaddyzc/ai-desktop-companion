import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { confirmLimits } from '../src/core/confirm';
import {
  chatMessageMaxChars,
  chatMessageProblem,
  chatMessageText,
  defaultPhonePushConfig,
  feishuError,
  pushCandidates,
  pushText,
  pushTitle,
  webhookProblem,
} from '../src/core/phone-push';
import type { WorkbenchItem, WorkbenchSnapshot } from '../src/core/workbench';
import { feishuSign, PhonePushService, type PushFetch } from '../src/desktop/phone-push';

const now = 1_800_000_000_000;
const hook = 'https://open.feishu.cn/open-apis/bot/v2/hook/0a1b2c3d-4e5f-6789-abcd-ef0123456789';

function item(over: Partial<WorkbenchItem>): WorkbenchItem {
  return {
    key: 'Claude Code:s1',
    kind: 'waiting',
    origin: 'session',
    agent: 'Claude Code',
    project: 'xinban',
    cwd: 'D:/xinban',
    title: 'xinban · Claude Code',
    detail: '在等你：Bash rm -rf build',
    at: now - 60_000,
    terminalOnly: false,
    result: '私密结论',
    tests: [],
    task: '',
    ...over,
  };
}

function snapshot(items: WorkbenchItem[]): WorkbenchSnapshot {
  return {
    items,
    counts: { waiting: 0, error: 0, unseen: 0, working: 0, idle: 0 },
    summary: '',
    at: now,
  };
}

const on = { ...defaultPhonePushConfig(), enabled: true };

describe('pushCandidates', () => {
  const base = { config: on, configured: true, sent: {}, now };

  it('空闲不够、没开、没配都不推', () => {
    const snap = snapshot([item({})]);
    expect(pushCandidates({ ...base, snapshot: snap, idleMs: 4 * 60_000 })).toEqual([]);
    expect(
      pushCandidates({
        ...base,
        snapshot: snap,
        idleMs: 6 * 60_000,
        config: defaultPhonePushConfig(),
      }),
    ).toEqual([]);
    expect(
      pushCandidates({ ...base, snapshot: snap, idleMs: 6 * 60_000, configured: false }),
    ).toEqual([]);
    expect(pushCandidates({ ...base, snapshot: snap, idleMs: 6 * 60_000 })).toHaveLength(1);
  });

  it('只推等你/出错/干完，只推离开后（宽限 2 分钟）发生的，10 分钟内不重复', () => {
    const snap = snapshot([
      item({ key: 'a' }),
      item({ key: 'b', kind: 'working' }),
      item({ key: 'c', kind: 'unseen', at: now - 7 * 60_000 }),
      item({ key: 'd', kind: 'error', at: now - 30 * 60_000 }),
      item({ key: 'e', kind: 'unseen' }),
    ]);
    const keys = (sent: Record<string, number>) =>
      pushCandidates({ ...base, snapshot: snap, idleMs: 6 * 60_000, sent }).map((x) => x.key);
    expect(keys({})).toEqual(['a', 'c', 'e']);
    expect(keys({ a: now - 5 * 60_000, e: now - 11 * 60_000 })).toEqual(['c', 'e']);
  });
});

describe('推送文案', () => {
  it('只有 Agent、项目和状态，不带命令、结论', () => {
    const text = pushText([
      item({}),
      item({ kind: 'unseen', agent: 'WorkBuddy', project: 'shop' }),
    ]);
    expect(text).toBe(
      '【芯伴】Claude Code 在 xinban 项目等你批准\nWorkBuddy 在 shop 项目这一轮结束了，结果待看',
    );
    expect(text).not.toContain('rm -rf');
    expect(text).not.toContain('私密');
    expect(pushTitle(item({ agent: 'Codex', terminalOnly: true }))).toContain('回终端');
    expect(pushText(Array.from({ length: 7 }, () => item({})))).toContain('还有 2 个');
  });
});

describe('飞书', () => {
  it('只认官方域名的机器人地址', () => {
    expect(webhookProblem(hook)).toBe('');
    expect(webhookProblem('https://open.larksuite.com/open-apis/bot/v2/hook/abcdefgh12')).toBe('');
    expect(webhookProblem('http://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh12')).not.toBe('');
    expect(
      webhookProblem('https://open.feishu.cn.evil.com/open-apis/bot/v2/hook/abcdefgh12'),
    ).not.toBe('');
    expect(webhookProblem('https://192.168.1.1/open-apis/bot/v2/hook/abcdefgh12')).not.toBe('');
  });

  it('返回码判断', () => {
    expect(feishuError(200, { code: 0, msg: 'success' })).toBe('');
    expect(feishuError(200, { StatusCode: 0 })).toBe('');
    expect(feishuError(200, { code: 19021, msg: 'sign match fail' })).toContain('19021');
    expect(feishuError(500, null)).toContain('500');
  });

  it('签名与官方算法一致（HmacSHA256(ts\\nsecret, "")）', () => {
    expect(feishuSign('1599360473', 'demo')).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(feishuSign('1', 'a')).not.toBe(feishuSign('2', 'a'));
  });
});

describe('PhonePushService', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });
  const crypto = {
    available: () => true,
    encrypt: (plain: string) => Buffer.from(`enc:${plain}`),
    decrypt: (payload: Buffer) => payload.toString().replace(/^enc:/, ''),
  };

  async function setup(idleSec = 600, status = 200, body: unknown = { code: 0 }) {
    dir = await mkdtemp(join(tmpdir(), 'xinban-push-'));
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl: PushFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return { status, json: async () => body };
    };
    const path = join(dir, 'phone-push-v1.json');
    const svc = new PhonePushService(
      path,
      crypto,
      () => idleSec,
      fetchImpl,
      () => now,
    );
    await svc.load();
    return { svc, calls, path };
  }

  it('地址加密存盘、不回传；重启读得回来', async () => {
    const { svc, path } = await setup();
    expect((await svc.save({ enabled: true, idleMinutes: 5, webhook: 'https://x.com/a' })).ok).toBe(
      false,
    );
    const saved = await svc.save({ enabled: true, idleMinutes: 10, webhook: hook, secret: 'sec' });
    expect(saved.ok).toBe(true);
    const view = svc.view();
    expect(view).toMatchObject({ enabled: true, idleMinutes: 10, configured: true, signed: true });
    expect(JSON.stringify(view)).not.toContain('hook/');
    const disk = await readFile(path, 'utf8');
    expect(disk).not.toContain('open.feishu.cn');
    const again = new PhonePushService(
      path,
      crypto,
      () => 0,
      async () => ({ status: 200, json: async () => ({}) }),
    );
    await again.load();
    expect(again.view()).toMatchObject({ enabled: true, configured: true, signed: true });
  });

  it('没地址不能开；系统加密不可用拒绝保存', async () => {
    const { svc } = await setup();
    expect((await svc.save({ enabled: true, idleMinutes: 5 })).ok && svc.view().enabled).toBe(
      false,
    );
    const plain = new PhonePushService(
      join(dir, 'x.json'),
      { ...crypto, available: () => false },
      () => 0,
      async () => ({ status: 200, json: async () => ({}) }),
    );
    expect((await plain.save({ enabled: true, idleMinutes: 5, webhook: hook })).ok).toBe(false);
  });

  it('tick：离开够久才推，带签名，同一项 10 分钟内不重复', async () => {
    const { svc, calls } = await setup(600);
    await svc.save({ enabled: true, idleMinutes: 5, webhook: hook, secret: 'sec' });
    const snap = snapshot([item({})]);
    expect(await svc.tick(snap)).toBe(1);
    expect(await svc.tick(snap)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(hook);
    expect(calls[0]!.body).toMatchObject({
      msg_type: 'text',
      timestamp: String(Math.floor(now / 1000)),
      sign: feishuSign(String(Math.floor(now / 1000)), 'sec'),
    });
    expect(svc.view().lastSentAt).toBe(now);
  });

  it('在电脑前不推；飞书拒了记下原因', async () => {
    const near = await setup(10);
    await near.svc.save({ enabled: true, idleMinutes: 5, webhook: hook });
    expect(await near.svc.tick(snapshot([item({})]))).toBe(0);
    expect(near.calls).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });

    const bad = await setup(600, 200, { code: 19021, msg: 'sign match fail' });
    await bad.svc.save({ enabled: true, idleMinutes: 5, webhook: hook });
    expect(await bad.svc.tick(snapshot([item({})]))).toBe(0);
    expect(bad.svc.view().lastError).toContain('19021');
    expect((await bad.svc.test()).ok).toBe(false);
  });

  it('聊天里发一条：不看空闲和开关，只要配了地址；带前缀、校长度', async () => {
    const { svc, calls } = await setup(0);
    expect(await svc.sendMessage('三点开会')).toMatchObject({ ok: false });
    await svc.save({ enabled: false, idleMinutes: 5, webhook: hook });
    expect(await svc.sendMessage('  三点开会\n带电脑 ')).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({
      msg_type: 'text',
      content: { text: '【芯伴】三点开会\n带电脑' },
    });
    expect((await svc.sendMessage('')).ok).toBe(false);
    expect((await svc.sendMessage('啊'.repeat(chatMessageMaxChars + 1))).ok).toBe(false);
    expect((await svc.sendMessage('a\u0000b')).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('聊天发飞书的文案', () => {
  it('空、过长、控制字符都拒；换行和中文放行；加上前缀后确认卡放得下', () => {
    expect(chatMessageProblem(' ')).not.toBe('');
    expect(chatMessageProblem('a\u001bb')).not.toBe('');
    expect(chatMessageProblem('第一行\r\n第二行\t完')).toBe('');
    expect(chatMessageText(' hi ')).toBe('【芯伴】hi');
    expect(chatMessageText('啊'.repeat(chatMessageMaxChars)).length).toBeLessThanOrEqual(
      confirmLimits.maxDetail,
    );
  });
});
