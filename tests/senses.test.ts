import { describe, expect, it } from 'vitest';
import {
  channelLabel,
  emptyReading,
  emptySenses,
  normalizeReading,
  normalizeSenses,
  presentFrom,
  readingFresh,
  senseTuning,
  sensesPrompt,
  sensesText,
  speechText,
  speakingFromLevel,
  trackMotion,
  type SensesSnapshot,
} from '../src/core/senses';

const at = (lastMotionAt: number, now = Date.now()): SensesSnapshot => ({
  config: { voice: false, ears: true, eyes: true },
  reading: { ...emptyReading(), mic: 'live', camera: 'live', lastMotionAt, at: now },
});

describe('感官开关', () => {
  it('只有明确的 true 才算打开', () => {
    expect(normalizeSenses({ voice: true, ears: 1, eyes: 'yes' })).toEqual({
      voice: true,
      ears: false,
      eyes: false,
    });
  });

  it('缺字段、乱类型、null 一律当全关——默认不能自己开摄像头', () => {
    for (const raw of [undefined, null, 'ears', [], { ears: null }, {}]) {
      expect(normalizeSenses(raw)).toEqual({ voice: false, ears: false, eyes: false });
    }
  });
});

describe('音量与开口判定', () => {
  it('起说用高阈值，收声用低阈值：边界上不抖', () => {
    expect(speakingFromLevel(0.05, false)).toBe(false);
    expect(speakingFromLevel(0.05, true)).toBe(true);
    expect(speakingFromLevel(0.02, true)).toBe(false);
    expect(speakingFromLevel(0.3, false)).toBe(true);
  });

  it('非法音量不会把人判成在说话', () => {
    expect(speakingFromLevel(Number.NaN, true)).toBe(false);
    expect(speakingFromLevel(Number.POSITIVE_INFINITY, false)).toBe(false);
    // 超界值夹到 0~1，而不是当成无穷大。
    expect(speakingFromLevel(9, false)).toBe(true);
  });
});

describe('有没有人在', () => {
  it('只有超过阈值的帧差才刷新「最后一次动」', () => {
    expect(trackMotion(100, senseTuning.motionPresent / 2, 5_000)).toBe(100);
    expect(trackMotion(100, senseTuning.motionPresent * 2, 5_000)).toBe(5_000);
    // 时间不会倒流：旧时间戳来了也不回退。
    expect(trackMotion(9_000, 0.5, 5_000)).toBe(9_000);
  });

  it('摄像头没开、从没动过，都不算有人', () => {
    expect(presentFrom(1_000, 2_000, false)).toBe(false);
    expect(presentFrom(0, 2_000, true)).toBe(false);
  });

  it('两分钟没动静就算走开', () => {
    const now = 1_000_000;
    expect(presentFrom(now - 30_000, now, true)).toBe(true);
    expect(presentFrom(now - senseTuning.awayAfterMs - 1, now, true)).toBe(false);
  });
});

describe('IPC 边界', () => {
  it('读数夹到合法范围，未知通道回落到 off', () => {
    const reading = normalizeReading(
      {
        mic: 'live',
        camera: 'hacked',
        level: 9,
        speaking: 'yes',
        lastMotionAt: -3,
        error: 'x'.repeat(200),
      },
      123,
    );
    expect(reading.camera).toBe('off');
    expect(reading.level).toBe(1);
    expect(reading.speaking).toBe(false);
    expect(reading.lastMotionAt).toBe(0);
    expect(reading.at).toBe(123);
    expect(reading.error).toHaveLength(80);
  });

  it('不是对象就当没读到', () => {
    expect(normalizeReading(null, 1).at).toBe(1);
    expect(normalizeReading('oops', 1).mic).toBe('off');
  });

  it('太久以前的读数不能当此刻用', () => {
    const now = 100_000;
    expect(readingFresh({ ...emptyReading(), at: now - 1_000 }, now)).toBe(true);
    expect(readingFresh({ ...emptyReading(), at: now - senseTuning.staleAfterMs }, now)).toBe(
      false,
    );
    expect(readingFresh(emptyReading(), now)).toBe(false);
  });

  it('通道说法只有一套', () => {
    expect(channelLabel('denied')).toBe('被系统拒绝');
    expect(channelLabel('live')).toBe('开着');
  });
});

describe('提示词注入', () => {
  it('都没开就不往提示词里塞任何东西', () => {
    expect(sensesPrompt(emptySenses(), Date.now())).toBe('');
  });

  it('只报它真知道的：开着且在说话', () => {
    const snapshot: SensesSnapshot = {
      config: { voice: false, ears: true, eyes: false },
      reading: { ...emptyReading(), mic: 'live', level: 0.4, speaking: true, at: Date.now() },
    };
    const prompt = sensesPrompt(snapshot, Date.now());
    expect(prompt).toContain('正在出声');
    expect(prompt).toContain('不知道内容');
    expect(prompt).not.toContain('摄像头');
  });

  it('摄像头画面过期时说「还没拿到画面」，不能编成看到人', () => {
    const now = Date.now();
    const snapshot = at(now - 60_000, now - senseTuning.staleAfterMs - 1);
    expect(sensesPrompt(snapshot, now)).toContain('还没拿到画面');
  });

  it('有动静就说有人，长时间没动静就说没看到', () => {
    const now = Date.now();
    expect(sensesPrompt(at(now - 1_000, now), now)).toContain('有人在动');
    expect(sensesPrompt(at(now - senseTuning.awayAfterMs - 1, now), now)).toContain('没看到人动');
  });
});

describe('工具输出', () => {
  it('全关时直接说听不见也看不见', () => {
    expect(sensesText(emptySenses(), Date.now())).toContain('听不见也看不见');
  });

  it('开着时反复写明只有音量、没有画面', () => {
    const now = Date.now();
    const text = sensesText(at(now - 500, now), now);
    expect(text).toContain('不转文字');
    expect(text).toContain('不保存');
    expect(text).toContain('画面里有人');
  });

  it('失败原因要说给人看', () => {
    const snapshot: SensesSnapshot = {
      config: { voice: false, ears: true, eyes: false },
      reading: {
        ...emptyReading(),
        mic: 'denied',
        error: '系统拒绝了麦克风权限。',
        at: Date.now(),
      },
    };
    const text = sensesText(snapshot, Date.now());
    expect(text).toContain('被系统拒绝');
    expect(text).toContain('系统拒绝了麦克风权限');
  });
});

describe('念出来的文本', () => {
  it('代码块整段丢掉，链接只留文字', () => {
    const text = speechText('先看这里 [文档](https://example.com/a) 再跑 ```npm test``` 就行');
    expect(text).not.toContain('```');
    expect(text).not.toContain('example.com');
    expect(text).toContain('文档');
    expect(text).toContain('代码略');
  });

  it('去掉 Markdown 标记与裸链接', () => {
    expect(speechText('## 结论\n**别急**，先 https://a.b/c 看看')).toBe('结论 别急，先 看看');
  });

  it('太长就在标点处收住，加省略号', () => {
    const long = `${'这是一句很长的话，'.repeat(20)}结束。`;
    const text = speechText(long);
    expect(text.length).toBeLessThanOrEqual(senseTuning.speechChars + 1);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toContain('，，');
  });

  it('空回复不产出可念内容', () => {
    expect(speechText('   ')).toBe('');
    expect(speechText('```js\nconst a = 1;\n```')).toBe('（代码略）');
  });
});
