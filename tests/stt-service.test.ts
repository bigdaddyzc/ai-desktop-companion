import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { aiAllowedHosts } from '../src/core/ai';
import { defaultStt, sttDefaults } from '../src/core/stt';
import { AiCredentialStore, type AiCrypto } from '../src/desktop/ai-credentials';
import { SttConfigStore, SttService, toAudioBytes } from '../src/desktop/stt';

async function tempPath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'xinban-stt-')), name);
}

/** 假加密：只反转字符串，验证「落盘的不是明文」这一点就够了。 */
const fakeCrypto: AiCrypto = {
  available: () => true,
  encrypt: (plain) => Buffer.from([...plain].reverse().join(''), 'utf8'),
  decrypt: (payload) => [...payload.toString('utf8')].reverse().join(''),
};

async function makeService(
  fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch,
): Promise<{ service: SttService; credentialsPath: string; configPath: string }> {
  const credentialsPath = await tempPath('stt-credentials-v1.json');
  const configPath = await tempPath('stt-v1.json');
  const service = new SttService(
    new SttConfigStore(configPath),
    new AiCredentialStore(credentialsPath, fakeCrypto),
    fetchImpl,
  );
  await service.init();
  return { service, credentialsPath, configPath };
}

/** 一段超过最小体积的假音频。 */
function sampleAudio(): ArrayBuffer {
  return new ArrayBuffer(sttDefaults.minBytes + 100);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SttConfigStore', () => {
  it('文件不存在时是关的', async () => {
    const store = new SttConfigStore(await tempPath('stt-v1.json'));
    expect(await store.load()).toEqual(defaultStt);
  });

  it('开关落盘只有一个字段，不多写东西', async () => {
    const path = await tempPath('stt-v1.json');
    const store = new SttConfigStore(path);
    await store.save({ enabled: true });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, enabled: true });
  });

  it('文件被改坏时回落关闭', async () => {
    const path = await tempPath('stt-v1.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ 坏掉了', 'utf8');
    expect(await new SttConfigStore(path).load()).toEqual(defaultStt);
  });
});

describe('SttService', () => {
  it('刚装好是没开的，且没有 Key', async () => {
    const { service } = await makeService();
    const snapshot = service.snapshot();
    expect(snapshot.config.enabled).toBe(false);
    expect(snapshot.status).toBe('off');
    // 模型名要给出来，界面才能显示「用的哪个」。
    expect(snapshot.model).toBe(sttDefaults.model);
    // Key 本身绝不出现在快照里。
    expect(JSON.stringify(snapshot)).not.toContain('apiKey');
  });

  it('打开开关后没有 Key 就是「缺 Key」，不是「能用」', async () => {
    const { service } = await makeService();
    expect((await service.saveConfig({ enabled: true })).ok).toBe(true);
    expect(service.snapshot().status).toBe('no-key');
  });

  it('Key 落盘时是加密的，原文读不出来', async () => {
    const { service, credentialsPath } = await makeService();
    await service.saveConfig({ enabled: true });
    const key = 'sk-verysecret-1234567890';
    expect((await service.saveKey({ apiKey: key })).ok).toBe(true);
    const raw = await readFile(credentialsPath, 'utf8');
    expect(raw).not.toContain(key);
    expect(service.snapshot().status).toBe('ready');
    expect(service.snapshot().model).toBe(sttDefaults.model);
  });

  it('太短的 Key 直接拒绝，不去试', async () => {
    const { service } = await makeService();
    const result = await service.saveKey({ apiKey: 'sk-1' });
    expect(result.ok).toBe(false);
    expect(service.snapshot().status).not.toBe('ready');
  });

  it('系统加密不可用时拒绝保存，不降级成明文', async () => {
    const credentialsPath = await tempPath('stt-credentials-v1.json');
    const service = new SttService(
      new SttConfigStore(await tempPath('stt-v1.json')),
      new AiCredentialStore(credentialsPath, { ...fakeCrypto, available: () => false }),
      vi.fn() as unknown as typeof fetch,
    );
    await service.init();
    const result = await service.saveKey({ apiKey: 'sk-abcdefghijklmn' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('加密');
  });

  it('清除 Key 之后又回到「缺 Key」', async () => {
    const { service } = await makeService();
    await service.saveConfig({ enabled: true });
    await service.saveKey({ apiKey: 'sk-abcdefghijklmn' });
    expect(service.snapshot().status).toBe('ready');
    await service.clearKey();
    expect(service.snapshot().status).toBe('no-key');
    expect(service.snapshot().lastText).toBe('');
  });

  it('开关没打开就不发请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { service } = await makeService(fetchImpl);
    await service.saveKey({ apiKey: 'sk-abcdefghijklmn' });
    const result = await service.transcribe(sampleAudio(), 'audio/webm');
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('没 Key 就不发请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { service } = await makeService(fetchImpl);
    await service.saveConfig({ enabled: true });
    const result = await service.transcribe(sampleAudio(), 'audio/webm');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('按一下就松手的那段不浪费一次请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { service } = await makeService(fetchImpl);
    await service.saveConfig({ enabled: true });
    await service.saveKey({ apiKey: 'sk-abcdefghijklmn' });
    const result = await service.transcribe(new ArrayBuffer(64), 'audio/webm');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('太短');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('成功时带回洗掉标签的正文，并记下上次结果', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ text: '<|zh|><|NEUTRAL|><|Speech|>帮我改一下小屏的排版' }),
    ) as unknown as typeof fetch;
    const { service } = await makeService(fetchImpl);
    await service.saveConfig({ enabled: true });
    await service.saveKey({ apiKey: 'sk-abcdefghijklmn' });
    const result = await service.transcribe(sampleAudio(), 'audio/webm');
    expect(result).toEqual({ ok: true, text: '帮我改一下小屏的排版' });
    expect(service.snapshot().lastText).toBe('帮我改一下小屏的排版');
    expect(service.snapshot().lastError).toBe('');
  });

  it('请求带上了 Key、模型和文件名', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ text: '嗯' });
    }) as unknown as typeof fetch;
    const { service } = await makeService(fetchImpl);
    await service.saveConfig({ enabled: true });
    await service.saveKey({ apiKey: 'sk-abcdefghijklmn' });
    await service.transcribe(sampleAudio(), 'audio/webm;codecs=opus');

    expect(seen).not.toBeNull();
    const { url, init } = seen!;
    expect(url).toBe('https://api.siliconflow.cn/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer sk-abcdefghijklmn',
    );
    const form = init.body as FormData;
    expect(form.get('model')).toBe(sttDefaults.model);
    // 缺文件名会被部分网关直接 400。
    expect((form.get('file') as File).name).toBe('speech.webm');
  });

  it('401 / 429 各自翻成人话，不是统一的「失败」', async () => {
    const cases: [number, string][] = [
      [401, 'Key'],
      [429, '限流'],
      [413, '太大'],
    ];
    for (const [status, needle] of cases) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ message: 'nope' }, status),
      ) as unknown as typeof fetch;
      const { service } = await makeService(fetchImpl);
      await service.saveConfig({ enabled: true });
      await service.saveKey({ apiKey: 'sk-abcdefghijklmn' });
      const result = await service.transcribe(sampleAudio(), 'audio/webm');
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain(needle);
      expect(service.snapshot().lastError).toContain(needle);
    }
  });

  it('返回空正文时说「没听清」，不当成成功', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ text: '<|zh|>' }),
    ) as unknown as typeof fetch;
    const { service } = await makeService(fetchImpl);
    await service.saveConfig({ enabled: true });
    await service.saveKey({ apiKey: 'sk-abcdefghijklmn' });
    const result = await service.transcribe(sampleAudio(), 'audio/webm');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('没听清');
    // 空结果不能污染「上次转出」。
    expect(service.snapshot().lastText).toBe('');
  });

  it('断网时给网络的话，而不是抛异常', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const { service } = await makeService(fetchImpl);
    await service.saveConfig({ enabled: true });
    await service.saveKey({ apiKey: 'sk-abcdefghijklmn' });
    const result = await service.transcribe(sampleAudio(), 'audio/webm');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('网络');
  });

  it('超时（AbortError）说的是「等太久」，和断网分开', async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch;
    const { service } = await makeService(fetchImpl);
    await service.saveConfig({ enabled: true });
    await service.saveKey({ apiKey: 'sk-abcdefghijklmn' });
    const result = await service.transcribe(sampleAudio(), 'audio/webm');
    expect(result.ok === false && result.error).toContain('等太久');
  });

  it('DeepSeek 的主机绝不能拿来转写：白名单里没有它', () => {
    expect(aiAllowedHosts).not.toContain('api.siliconflow.cn');
    // 反过来也要成立：两份白名单是各自独立的，加错一边不会互相放行。
    expect(sttDefaults.baseUrl).toContain('api.siliconflow.cn');
  });

  it('订阅者能收到状态变化', async () => {
    const { service } = await makeService();
    const listener = vi.fn();
    service.subscribe(listener);
    await service.saveConfig({ enabled: true });
    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'no-key' });
  });
});

describe('IPC 过来的音频', () => {
  it('ArrayBuffer 原样收下', () => {
    const buffer = new ArrayBuffer(16);
    expect(toAudioBytes(buffer)).toBe(buffer);
  });

  it('Uint8Array 也能收下，且只取自己那一段', () => {
    // 结构化克隆在部分 Electron 版本上会还原成视图，甚至带 offset。
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const view = new Uint8Array(backing.buffer, 2, 3);
    const bytes = toAudioBytes(view);
    expect(bytes).not.toBeNull();
    expect(new Uint8Array(bytes!)).toEqual(new Uint8Array([2, 3, 4]));
  });

  it('别的东西一律不收', () => {
    expect(toAudioBytes('音频')).toBeNull();
    expect(toAudioBytes(null)).toBeNull();
    expect(toAudioBytes({ bank: 1 })).toBeNull();
  });
});
