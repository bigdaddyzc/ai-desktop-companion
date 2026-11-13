import { describe, expect, it, vi } from 'vitest';
import { TtsService } from '../src/desktop/tts';
import type { AiCredentialStore } from '../src/desktop/ai-credentials';

/** 只实现 `load` 的假凭据：合成的这一侧只读不写。 */
function credentials(value: { baseUrl: string; model: string; apiKey: string } | null) {
  return { load: async () => value } as unknown as AiCredentialStore;
}

const stored = { baseUrl: 'https://api.siliconflow.cn/v1', model: 'x', apiKey: 'sk-test-1234' };

function audioResponse(bytes = new Uint8Array([1, 2, 3, 4])): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
}

describe('TtsService', () => {
  it('没有 Key 时不发请求，直接告诉用户先用系统语音', async () => {
    const fetchImpl = vi.fn();
    const service = new TtsService(credentials(null), fetchImpl as unknown as typeof fetch);
    await service.init();
    expect(service.snapshot().status).toBe('no-key');

    const result = await service.synthesize({ text: '你好', voice: 'diana', speed: 1, gain: 0 });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining('Key') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('请求体带上模型、音色、语速与 mp3 格式', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return audioResponse();
    });
    const service = new TtsService(credentials(stored), fetchImpl as unknown as typeof fetch);
    await service.init();
    expect(service.snapshot().status).toBe('ready');

    const result = await service.synthesize({
      text: '  今天  天气不错  ',
      voice: 'alex',
      speed: 1.2,
      gain: 0,
    });
    expect(result.ok).toBe(true);

    const [request] = requests;
    expect(request!.url).toBe('https://api.siliconflow.cn/v1/audio/speech');
    const body = JSON.parse(String(request!.init.body));
    expect(body).toMatchObject({
      voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
      input: '今天 天气不错',
      response_format: 'mp3',
      speed: 1.2,
    });
    expect(request!.init.headers).toMatchObject({ Authorization: 'Bearer sk-test-1234' });
  });

  it('成功时把音频整段带回去，并记下时间', async () => {
    const service = new TtsService(credentials(stored), (async () =>
      audioResponse()) as unknown as typeof fetch);
    await service.init();
    const result = await service.synthesize({ text: '你好', voice: 'diana', speed: 1, gain: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mime).toBe('audio/mpeg');
      expect(result.audio.byteLength).toBe(4);
    }
    expect(service.snapshot().lastAt).toBeGreaterThan(0);
    expect(service.snapshot().lastError).toBe('');
  });

  it('对方回 200 但塞了 JSON，也算失败：那不是音频', async () => {
    const service = new TtsService(
      credentials(stored),
      (async () =>
        new Response(JSON.stringify({ message: 'bad' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    );
    await service.init();
    const result = await service.synthesize({ text: '你好', voice: 'diana', speed: 1, gain: 0 });
    expect(result.ok).toBe(false);
    expect(service.snapshot().lastError).not.toBe('');
  });

  it('401 翻成「Key 不对」而不是「合成失败」', async () => {
    const service = new TtsService(
      credentials(stored),
      (async () => new Response('', { status: 401 })) as unknown as typeof fetch,
    );
    await service.init();
    const result = await service.synthesize({ text: '你好', voice: 'diana', speed: 1, gain: 0 });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Key') });
  });

  it('断网时说清是网络，不是「格式看不懂」', async () => {
    const service = new TtsService(credentials(stored), (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await service.init();
    const result = await service.synthesize({ text: '你好', voice: 'diana', speed: 1, gain: 0 });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('网络') });
  });

  it('空文本不浪费一次请求', async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    const service = new TtsService(credentials(stored), fetchImpl as unknown as typeof fetch);
    await service.init();
    expect((await service.synthesize({ text: '   ', voice: 'diana', speed: 1, gain: 0 })).ok).toBe(
      false,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('字段类型不对时拒绝，不发请求', async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    const service = new TtsService(credentials(stored), fetchImpl as unknown as typeof fetch);
    await service.init();
    expect((await service.synthesize({ text: 1, voice: 'diana' })).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Key 是后填的：refresh 之后状态才变 ready', async () => {
    let value: typeof stored | null = null;
    const store = { load: async () => value } as unknown as AiCredentialStore;
    const service = new TtsService(store, (async () => audioResponse()) as unknown as typeof fetch);
    await service.init();
    expect(service.snapshot().status).toBe('no-key');

    value = stored;
    await service.refresh();
    expect(service.snapshot().status).toBe('ready');
  });

  it('状态变化会广播给订阅者', async () => {
    const service = new TtsService(credentials(stored), (async () =>
      audioResponse()) as unknown as typeof fetch);
    const listener = vi.fn();
    service.subscribe(listener);
    await service.init();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
  });
});
