import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultVoice, voicePackOf } from '../src/core/voice';
import { defaultCloudVoice } from '../src/core/tts';
import { VoiceService, VoiceStore } from '../src/desktop/voice';

async function tempPath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'xinban-voice-')), name);
}

describe('VoiceStore', () => {
  it('文件不存在时用默认嗓子，而不是报错', async () => {
    expect(await new VoiceStore(await tempPath('voice-v1.json')).load()).toEqual(defaultVoice());
  });

  it('存进去的配置能原样读回来，落盘字段固定', async () => {
    const path = await tempPath('voice-v1.json');
    const store = new VoiceStore(path);
    await store.save({
      engine: 'cloud',
      pack: 'calm',
      voiceURI: 'Microsoft Huihui',
      cloudVoice: 'alex',
      rate: 0.9,
      pitch: 0.86,
    });
    expect(await store.load()).toEqual({
      engine: 'cloud',
      pack: 'calm',
      voiceURI: 'Microsoft Huihui',
      cloudVoice: 'alex',
      rate: 0.9,
      pitch: 0.86,
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      engine: 'cloud',
      pack: 'calm',
      voiceURI: 'Microsoft Huihui',
      cloudVoice: 'alex',
      rate: 0.9,
      pitch: 0.86,
    });
  });

  it('文件被手改坏时回落默认嗓子', async () => {
    const path = await tempPath('voice-v1.json');
    await writeFile(path, '{ not json', 'utf8');
    expect(await new VoiceStore(path).load()).toEqual(defaultVoice());
  });

  it('老配置缺字段也能读：缺的补默认，不整份丢掉', async () => {
    const path = await tempPath('voice-v1.json');
    await writeFile(path, JSON.stringify({ version: 1, pack: 'lazy' }), 'utf8');
    const config = await new VoiceStore(path).load();
    expect(config.pack).toBe('lazy');
    expect(config.rate).toBe(voicePackOf('lazy').rate);
    expect(config.pitch).toBe(voicePackOf('lazy').pitch);
    expect(config.voiceURI).toBe('');
    // 语音包刚上线时没有「嗓子来源」这个概念：老文件读完应该落到默认的云端自然音。
    expect(config.engine).toBe('cloud');
    expect(config.cloudVoice).toBe(defaultCloudVoice);
  });

  it('认不出来的云音色回落默认，不会把一把不存在的嗓子存下来', async () => {
    const path = await tempPath('voice-v1.json');
    await writeFile(
      path,
      JSON.stringify({ version: 1, engine: 'cloud', cloudVoice: 'terminator' }),
      'utf8',
    );
    expect((await new VoiceStore(path).load()).cloudVoice).toBe(defaultCloudVoice);
  });

  it('切回系统语音也存得住，读回来还是系统语音', async () => {
    const path = await tempPath('voice-v1.json');
    const store = new VoiceStore(path);
    await store.save({ ...defaultVoice(), engine: 'system' });
    expect((await store.load()).engine).toBe('system');
  });
});

describe('VoiceService', () => {
  it('保存成功后立刻广播，桌宠下一句就用新的', async () => {
    const service = new VoiceService(new VoiceStore(await tempPath('voice-v1.json')));
    await service.init();
    const listener = vi.fn();
    service.subscribe(listener);

    const next = {
      engine: 'cloud' as const,
      pack: 'warm' as const,
      voiceURI: '',
      cloudVoice: 'claire',
      rate: 0.94,
      pitch: 1,
    };
    const result = await service.save(next);
    expect(result.ok).toBe(true);
    expect(service.snapshot()).toMatchObject({ pack: 'warm', rate: 0.94, cloudVoice: 'claire' });
    expect(listener).toHaveBeenCalledWith(next);
  });

  it('数值越界会被夹住，不会存进一份听不清的配置', async () => {
    const service = new VoiceService(new VoiceStore(await tempPath('voice-v1.json')));
    await service.init();
    const result = await service.save({ pack: 'clear', voiceURI: '', rate: 5, pitch: 5 });
    expect(result.ok).toBe(true);
    expect(service.snapshot().rate).toBeLessThan(2);
    expect(service.snapshot().pitch).toBeLessThan(2);
  });

  it('字段类型不对时拒绝保存，内存里保持原样', async () => {
    const service = new VoiceService(new VoiceStore(await tempPath('voice-v1.json')));
    await service.init();
    const before = service.snapshot();
    expect((await service.save({ pack: 'clear', rate: 'fast' })).ok).toBe(false);
    expect(service.snapshot()).toEqual(before);
  });

  it('写盘失败时不能假装保存成功', async () => {
    const store = new VoiceStore(await tempPath('voice-v1.json'));
    const service = new VoiceService(store);
    await service.init();
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('磁盘满'));

    const result = await service.save({ pack: 'calm', voiceURI: '', rate: 0.9, pitch: 0.86 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有保存成功');
    // 内存也要保持原样：显示「已保存」却还是旧嗓子，是最难查的那种不一致。
    expect(service.snapshot().pack).toBe(defaultVoice().pack);
  });

  it('重启后读回上次选的嗓子', async () => {
    const path = await tempPath('voice-v1.json');
    const first = new VoiceService(new VoiceStore(path));
    await first.init();
    await first.save({
      engine: 'system',
      pack: 'lazy',
      voiceURI: 'Xiaoxiao',
      cloudVoice: 'diana',
      rate: 0.84,
      pitch: 0.92,
    });

    const restarted = new VoiceService(new VoiceStore(path));
    await restarted.init();
    expect(restarted.snapshot()).toEqual({
      engine: 'system',
      pack: 'lazy',
      voiceURI: 'Xiaoxiao',
      cloudVoice: 'diana',
      rate: 0.84,
      pitch: 0.92,
    });
  });
});
