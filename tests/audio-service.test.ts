import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyAudioSource, playAudioInputSchema } from '../src/core/audio';
import {
  AudioService,
  type AudioPlayerPort,
  type AudioState,
  type ResolvedSource,
  type TerminalResult,
} from '../src/desktop/audio';

/** 假播放器：play 一直挂起，直到 stop / settle 兑现，方便精确控制并发与终态。 */
class FakePlayer implements AudioPlayerPort {
  readonly starts: { target: ResolvedSource; volume: number }[] = [];
  stops = 0;
  private readonly pending: ((result: TerminalResult) => void)[] = [];

  play(target: ResolvedSource, volume: number): Promise<TerminalResult> {
    this.starts.push({ target, volume });
    return new Promise((resolve) => {
      this.pending.push(resolve);
    });
  }

  stop(): Promise<void> {
    this.stops += 1;
    this.pending.pop()?.({ status: 'stopped' });
    return Promise.resolve();
  }

  /** 模拟最后一路播放自然结束 / 失败。 */
  settle(status: 'ended' | 'failed' = 'ended', error?: string): void {
    const result: TerminalResult = error ? { status, error } : { status };
    this.pending.pop()?.(result);
  }

  activeCount(): number {
    return this.pending.length;
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(() => resolve(), 0));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'xinban-audio-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('play_audio 输入规格（zod）', () => {
  it('http(s) 链接与本地相对路径被正确归类', () => {
    expect(classifyAudioSource('https://example.com/a.mp3')).toEqual({
      ok: true,
      value: { kind: 'url', url: 'https://example.com/a.mp3' },
    });
    expect(classifyAudioSource('sounds/notify.mp3')).toEqual({
      ok: true,
      value: { kind: 'file', relativePath: 'sounds/notify.mp3' },
    });
  });

  it('source 必填、volume 限定 0~1、多余字段一律拒绝', () => {
    expect(playAudioInputSchema.safeParse({ source: 'a.mp3', volume: 0.5 }).success).toBe(true);
    expect(playAudioInputSchema.safeParse({ source: 'a.mp3' }).success).toBe(true);
    expect(playAudioInputSchema.safeParse({ source: 'a.mp3', volume: 2 }).success).toBe(false);
    expect(playAudioInputSchema.safeParse({ source: '', volume: 0.5 }).success).toBe(false);
    expect(playAudioInputSchema.safeParse({ source: 'a.mp3', extra: 1 }).success).toBe(false);
  });
});

describe('AudioService：并发请求只保留一路', () => {
  it('两个请求同时到达时只有一路真正启动，被让位的请求不再播放', async () => {
    const player = new FakePlayer();
    const service = new AudioService(player, [root]);

    const results = await Promise.all([
      service.play({ source: 'a.mp3' }),
      service.play({ source: 'b.mp3' }),
    ]);

    // resolveAudioSource 的真实路径核对是异步的，谁先谁后不固定，
    // 因此这里只断言不变量：恰好一路启动、一路让位，当前只有一路在播。
    expect(player.starts).toHaveLength(1);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map((result) => result.status)).toContain(
      'superseded',
    );
    expect(service.snapshot().status).toBe('playing');
    expect(['a.mp3', 'b.mp3']).toContain(service.snapshot().source);
    expect(player.activeCount()).toBe(1);
  });

  it('先播一路再发新请求：旧路先被停掉，任意时刻只有一路活跃', async () => {
    const player = new FakePlayer();
    const service = new AudioService(player, [root]);

    await service.play({ source: 'a.mp3' });
    expect(player.activeCount()).toBe(1);

    const second = await service.play({ source: 'b.mp3' });

    expect(second).toEqual({ ok: true, status: 'playing', source: 'b.mp3' });
    expect(player.stops).toBe(1); // 新请求先停旧的
    expect(player.activeCount()).toBe(1); // 旧路已兑现、只剩新路
    expect(service.snapshot().source).toBe('b.mp3');
  });
});

describe('AudioService：非法路径被拒', () => {
  it('绝对路径 / .. 逃逸 / 盘符 / 其它协议 / NTFS 流都不进播放器', async () => {
    const player = new FakePlayer();
    const service = new AudioService(player, [root]);
    const bad = [
      'C:/Windows/System32/a.mp3',
      'C:\\Windows\\a.mp3',
      '/etc/passwd',
      '\\\\server\\share\\a.mp3',
      '../secret.mp3',
      'sounds/../../secret.mp3',
      'file:///C:/Windows/a.mp3',
      'ftp://example.com/a.mp3',
      'javascript:alert(1)',
      'a.mp3:$DATA',
      '',
    ];
    for (const source of bad) {
      const result = await service.play({ source });
      expect(result.ok).toBe(false);
    }
    expect(player.starts).toHaveLength(0);
    expect(player.stops).toBe(0);
    expect(service.snapshot().status).toBe('idle');
  });

  it('没有任何允许目录时，连合法相对路径也拒绝', async () => {
    const player = new FakePlayer();
    const service = new AudioService(player, []);
    expect((await service.play({ source: 'a.mp3' })).ok).toBe(false);
    expect(player.starts).toHaveLength(0);
  });

  it('volume 越界或参数带多余字段在本地被 zod 拦下', async () => {
    const player = new FakePlayer();
    const service = new AudioService(player, [root]);
    expect((await service.play({ source: 'a.mp3', volume: 5 })).ok).toBe(false);
    expect((await service.play({ source: 'a.mp3', unexpected: true })).ok).toBe(false);
    expect(player.starts).toHaveLength(0);
  });
});

describe('AudioService：合法来源与状态回报', () => {
  it('本地相对路径与 http(s) 链接都能发起，默认音量为 1', async () => {
    const player = new FakePlayer();
    const service = new AudioService(player, [root]);

    const local = await service.play({ source: 'sounds/notify.mp3' });
    expect(local).toEqual({ ok: true, status: 'playing', source: 'sounds/notify.mp3' });
    expect(player.starts[0]!.target).toMatchObject({ kind: 'file', label: 'sounds/notify.mp3' });
    expect(player.starts[0]!.volume).toBe(1);

    const remote = await service.play({ source: 'https://example.com/sound.mp3', volume: 0.4 });
    expect(remote).toEqual({
      ok: true,
      status: 'playing',
      source: 'example.com/sound.mp3',
    });
    expect(player.starts[1]!.target).toMatchObject({ kind: 'url' });
    expect(player.starts[1]!.volume).toBe(0.4);
  });

  it('播放结束与失败都通过 subscribe 回报终态', async () => {
    const player = new FakePlayer();
    const service = new AudioService(player, [root], () => 1234);
    const seen: AudioState[] = [];
    service.subscribe((state) => seen.push(state));

    await service.play({ source: 'a.mp3' });
    player.settle('ended');
    await flush();
    expect(seen.some((state) => state.status === 'ended' && state.source === 'a.mp3')).toBe(true);
    expect(service.snapshot()).toMatchObject({ status: 'ended', error: null, updatedAt: 1234 });

    await service.play({ source: 'b.mp3' });
    player.settle('failed', '媒体无法播放');
    await flush();
    expect(service.snapshot()).toMatchObject({ status: 'failed', error: '媒体无法播放' });
  });

  it('stop 在没有播放时是空操作，在播放时回报 stopped', async () => {
    const player = new FakePlayer();
    const service = new AudioService(player, [root]);
    const seen: string[] = [];
    service.subscribe((state) => seen.push(state.status));

    expect(await service.stop()).toEqual({ ok: true, status: 'stopped', source: '' });
    expect(player.stops).toBe(0);

    await service.play({ source: 'a.mp3' });
    expect(await service.stop()).toEqual({ ok: true, status: 'stopped', source: 'a.mp3' });
    expect(player.stops).toBe(1);
    expect(seen).toContain('stopped');
    expect(service.snapshot().status).toBe('stopped');
  });
});
