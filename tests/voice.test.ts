import { describe, expect, it } from 'vitest';
import {
  chooseVoice,
  defaultVoice,
  normalizeVoice,
  splitForSpeech,
  takeSpeechSegment,
  voiceLabel,
  voiceLimits,
  voicePackOf,
  voicePacks,
  withEngine,
  withPack,
} from '../src/core/voice';

describe('语音包预设', () => {
  it('每个包都有名字、说明和收在可用区间里的语速', () => {
    expect(voicePacks).toHaveLength(4);
    for (const pack of voicePacks) {
      expect(pack.name.length).toBeGreaterThan(0);
      expect(pack.desc.length).toBeGreaterThan(4);
      expect(pack.rate).toBeGreaterThanOrEqual(voiceLimits.rate.min);
      expect(pack.rate).toBeLessThanOrEqual(voiceLimits.rate.max);
      expect(pack.pitch).toBeGreaterThanOrEqual(voiceLimits.pitch.min);
      expect(pack.pitch).toBeLessThanOrEqual(voiceLimits.pitch.max);
    }
  });

  it('默认就是第一个包，语速音调跟着它', () => {
    const config = defaultVoice();
    expect(config.pack).toBe('clear');
    expect(config.rate).toBe(voicePackOf('clear').rate);
    expect(config.pitch).toBe(voicePackOf('clear').pitch);
    expect(config.voiceURI).toBe('');
  });

  it('换包只改语速音调，不换音色', () => {
    const before = { ...defaultVoice(), voiceURI: 'Microsoft Huihui' };
    const after = withPack(before, 'calm');
    expect(after.pack).toBe('calm');
    expect(after.rate).toBe(voicePackOf('calm').rate);
    expect(after.pitch).toBe(voicePackOf('calm').pitch);
    expect(after.voiceURI).toBe('Microsoft Huihui');
  });
});

describe('语音配置收口', () => {
  it('语速音调被夹在可用区间里', () => {
    expect(normalizeVoice({ pack: 'clear', rate: 9, pitch: 9 })).toMatchObject({
      rate: voiceLimits.rate.max,
      pitch: voiceLimits.pitch.max,
    });
    expect(normalizeVoice({ pack: 'clear', rate: 0.1, pitch: 0 })).toMatchObject({
      rate: voiceLimits.rate.min,
      pitch: voiceLimits.pitch.min,
    });
  });

  it('乱填的数值回到包里的默认值，不是 0', () => {
    const fallback = voicePackOf('warm');
    const config = normalizeVoice({ pack: 'warm', rate: Number.NaN, pitch: '1.4' });
    expect(config.rate).toBe(fallback.rate);
    expect(config.pitch).toBe(fallback.pitch);
  });

  it('不认识的包回落到默认包', () => {
    expect(normalizeVoice({ pack: 'robot' }).pack).toBe('clear');
    expect(normalizeVoice('whatever').pack).toBe('clear');
    expect(normalizeVoice(null).pack).toBe('clear');
  });

  it('音色 URI 去空格并限长', () => {
    expect(normalizeVoice({ pack: 'calm', voiceURI: '  晓晓  ' }).voiceURI).toBe('晓晓');
    expect(
      normalizeVoice({ pack: 'calm', voiceURI: 'x'.repeat(voiceLimits.voiceUriChars + 50) })
        .voiceURI,
    ).toHaveLength(voiceLimits.voiceUriChars);
  });

  it('标题那行字同时说清包名与语速', () => {
    expect(
      voiceLabel({ ...defaultVoice(), engine: 'system', pack: 'lazy', rate: 0.84, pitch: 0.9 }),
    ).toBe('慵懒 · 0.84×');
  });

  it('云端时标题说的是哪把嗓子，而不是包名', () => {
    expect(voiceLabel({ ...defaultVoice(), engine: 'cloud', cloudVoice: 'alex' })).toBe(
      `alex · ${defaultVoice().rate.toFixed(2)}×`,
    );
  });
});

describe('换嗓子来源', () => {
  it('切来源不动别的：切回来还是原来那把', () => {
    const before = { ...defaultVoice(), cloudVoice: 'bella', voiceURI: 'Huihui' };
    const system = withEngine(before, 'system');
    expect(system.engine).toBe('system');
    expect(system.cloudVoice).toBe('bella');
    expect(system.voiceURI).toBe('Huihui');
    expect(withEngine(system, 'cloud')).toEqual(before);
  });

  it('认不出来的来源回落默认，不认识的云音色也回落', () => {
    expect(normalizeVoice({ engine: 'telepathy' }).engine).toBe('cloud');
    expect(normalizeVoice({ cloudVoice: 'nobody' }).cloudVoice).toBe('diana');
    expect(normalizeVoice({ cloudVoice: 'claire' }).cloudVoice).toBe('claire');
  });
});

describe('断句', () => {
  it('短句不切', () => {
    expect(splitForSpeech('我在呢。')).toEqual(['我在呢。']);
  });

  it('长文在标点处切开，每块都不超上限', () => {
    const text = `${'今天天气不错。'.repeat(30)}`;
    const chunks = splitForSpeech(text, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(60);
    expect(chunks.join('')).toBe(text);
  });

  it('没有标点就按长度硬切，不会整段不分', () => {
    const chunks = splitForSpeech('啊'.repeat(250), 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });

  it('空文本不产出空块', () => {
    expect(splitForSpeech('   ')).toEqual([]);
  });
});

interface FakeVoice {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
}

const voice = (name: string, lang: string, localService = true): FakeVoice => ({
  voiceURI: name,
  name,
  lang,
  localService,
});

describe('挑音色', () => {
  const voices = [
    voice('David', 'en-US'),
    voice('Huihui', 'zh-CN'),
    voice('Xiaoxiao', 'zh-CN', false),
  ];

  it('只从中文里挑，且优先本地语音', () => {
    expect(chooseVoice(voices, '')?.name).toBe('Huihui');
  });

  it('指定了音色就用指定的那个', () => {
    expect(chooseVoice(voices, 'Xiaoxiao')?.name).toBe('Xiaoxiao');
  });

  it('指定的音色被卸载了就退回自动挑，而不是不出声', () => {
    expect(chooseVoice(voices, 'Microsoft Kangkang')?.name).toBe('Huihui');
  });

  it('没有中文语音时退到任意可用语音', () => {
    expect(chooseVoice([voice('David', 'en-US')], '')?.name).toBe('David');
  });

  it('一个语音都没有就返回 null，交给系统默认嗓子', () => {
    expect(chooseVoice([], '')).toBeNull();
  });
});

describe('流式播报的切块', () => {
  it('不是首块时只认句末标点，逗号不算', () => {
    expect(takeSpeechSegment('前半句，后半句。', false)).toEqual({
      segment: '前半句，后半句。',
      rest: '',
    });
    expect(takeSpeechSegment('前半句，后半句还没完', false)).toBeNull();
  });

  it('首块到第一个逗号就切，够十个字就行', () => {
    const piece = takeSpeechSegment('这句话大概有十来个字，后面继续', true);
    expect(piece?.segment).toBe('这句话大概有十来个字，');
    expect(piece?.rest).toBe('后面继续');
  });

  it('逗号出现太早不动手，免得一开口只有一个字', () => {
    expect(takeSpeechSegment('好，我们开始吧。', true)).toEqual({
      segment: '好，我们开始吧。',
      rest: '',
    });
  });

  it('连续的句末标点留在同一块里', () => {
    expect(takeSpeechSegment('真的吗？！我不信', false)).toEqual({
      segment: '真的吗？！',
      rest: '我不信',
    });
  });

  it('一直没标点就在七十来字处硬切，不至于合成一大坨', () => {
    const long = '字'.repeat(120);
    const piece = takeSpeechSegment(long, false);
    expect(piece).not.toBeNull();
    expect(piece!.segment.length).toBeGreaterThan(60);
    expect(piece!.segment.length).toBeLessThanOrEqual(70);
    expect(piece!.segment.length + piece!.rest.length).toBe(120);
  });

  it('空文本什么都不给', () => {
    expect(takeSpeechSegment('   ', false)).toBeNull();
  });
});
