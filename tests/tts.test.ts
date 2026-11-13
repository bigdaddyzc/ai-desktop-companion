import { describe, expect, it } from 'vitest';
import {
  cloudVoiceIds,
  cloudVoiceLabel,
  cloudVoiceOf,
  cloudVoiceParam,
  cloudVoices,
  defaultCloudVoice,
  normalizeCloudVoice,
  normalizeGain,
  normalizeSpeed,
  speakable,
  ttsDefaults,
  ttsEndpoint,
  ttsErrorText,
  ttsLimits,
} from '../src/core/tts';

describe('云端音色', () => {
  it('八个预置音色，id 不重复，每个都有说明', () => {
    expect(cloudVoices).toHaveLength(8);
    expect(new Set(cloudVoiceIds).size).toBe(8);
    for (const voice of cloudVoices) {
      expect(voice.label).toBe(voice.id);
      expect(voice.desc.length).toBeGreaterThan(4);
    }
  });

  it('默认音色在列表里', () => {
    expect(cloudVoiceIds).toContain(defaultCloudVoice);
  });

  it('认不出来的音色回落默认', () => {
    expect(normalizeCloudVoice('terminator')).toBe(defaultCloudVoice);
    expect(normalizeCloudVoice(null)).toBe(defaultCloudVoice);
    expect(normalizeCloudVoice('alex')).toBe('alex');
    expect(cloudVoiceOf('nobody').id).toBe(cloudVoices[0]!.id);
  });

  it('请求参数是「模型名:音色」，少一段对方会 400', () => {
    expect(cloudVoiceParam('alex')).toBe(`${ttsDefaults.model}:alex`);
  });

  it('标题那行字是音色加语速', () => {
    expect(cloudVoiceLabel('claire', 1.06)).toBe('claire · 1.06×');
  });
});

describe('合成端点', () => {
  it('带没带 /v1 都拼成同一个地址，不会出现 /v1/v1', () => {
    expect(ttsEndpoint('https://api.siliconflow.cn/v1')).toBe(
      'https://api.siliconflow.cn/v1/audio/speech',
    );
    expect(ttsEndpoint('https://api.siliconflow.cn')).toBe(
      'https://api.siliconflow.cn/v1/audio/speech',
    );
  });

  it('地址坏了会抛，交给调用方翻成人话', () => {
    expect(() => ttsEndpoint('not a url')).toThrow();
  });
});

describe('输入收口', () => {
  it('空白折叠、去首尾', () => {
    expect(speakable('  你 好\n世界  ')).toBe('你 好 世界');
  });

  it('超长截断并留一个省略号，不会把半句硬切下去', () => {
    const long = '啊'.repeat(ttsLimits.inputChars + 50);
    const out = speakable(long);
    expect(out.length).toBeLessThanOrEqual(ttsLimits.inputChars);
    expect(out.endsWith('…')).toBe(true);
  });

  it('语速音量夹在可用区间里，NaN 回默认', () => {
    expect(normalizeSpeed(9)).toBe(ttsLimits.speed.max);
    expect(normalizeSpeed(0)).toBe(ttsLimits.speed.min);
    expect(normalizeSpeed(Number.NaN)).toBe(1);
    expect(normalizeGain(99)).toBe(ttsLimits.gain.max);
    expect(normalizeGain(-99)).toBe(ttsLimits.gain.min);
    expect(normalizeGain('loud')).toBe(0);
  });
});

describe('错误文案', () => {
  it('每种失败都说清下一步，而不是「合成失败」', () => {
    expect(ttsErrorText(401)).toContain('Key');
    expect(ttsErrorText(429)).toContain('限流');
    expect(ttsErrorText(0)).toContain('网络');
    expect(ttsErrorText(418)).toContain('418');
  });
});
