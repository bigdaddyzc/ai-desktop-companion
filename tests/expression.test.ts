import { describe, expect, it } from 'vitest';
import { faceOf, mouthOpenOf } from '../src/core/expression';

describe('表情的优先级', () => {
  it('平时是一张安静的脸：竖眼、微笑、没有多余符号', () => {
    expect(faceOf({ mood: 'idle' })).toMatchObject({
      eyes: 'open',
      brows: 'none',
      mouth: 'smile',
      extra: 'none',
    });
  });

  it('看不到人时闭眼，且这不取决于 mood', () => {
    // 摄像头开着却找不到人，屏幕该显得没精神，而不是照样笑。
    expect(faceOf({ mood: 'happy', away: true })).toMatchObject({
      eyes: 'closed',
      extra: 'zzz',
    });
  });

  it('睡着时闭眼，腮红收掉', () => {
    const face = faceOf({ mood: 'sleep' });
    expect(face.eyes).toBe('closed');
    expect(face.extra).toBe('zzz');
    expect(face.blush).toBe(0);
  });

  it('在说话时哪怕同时在推理，也先显示「在说话」', () => {
    // 边生成边念的时候两个信号都成立。嘴在动比头顶冒泡更该被看见。
    const face = faceOf({ mood: 'busy', thinking: true, speaking: true });
    expect(face.label).toBe('在说话');
    expect(face.eyes).toBe('happy');
  });

  it('在听你说话时眼睛睁大，腮红比平时重', () => {
    const listening = faceOf({ mood: 'idle', listening: true });
    expect(listening.eyes).toBe('wide');
    expect(listening.blush).toBeGreaterThan(faceOf({ mood: 'idle' }).blush);
  });

  it('想事时冒气泡，嘴收成一个小点', () => {
    expect(faceOf({ mood: 'idle', thinking: true })).toMatchObject({
      eyes: 'open',
      brows: 'raised',
      mouth: 'tiny',
      extra: 'think',
    });
  });

  it('玩游戏时张嘴、挑眉：输了赢了都得有反应', () => {
    expect(faceOf({ mood: 'idle', playing: true })).toMatchObject({
      eyes: 'wide',
      brows: 'raised',
      mouth: 'o',
    });
  });
});

describe('各种 mood 对应的脸', () => {
  it('开心：弯眼、咧嘴、一颗心', () => {
    expect(faceOf({ mood: 'happy' })).toMatchObject({
      eyes: 'happy',
      mouth: 'grin',
      extra: 'heart',
    });
  });

  it('等你确认：一高一低的眼配问号', () => {
    expect(faceOf({ mood: 'waiting' })).toMatchObject({
      eyes: 'side',
      brows: 'raised',
      mouth: 'o',
      extra: 'question',
    });
  });

  it('担心：八字眉、撇嘴、一滴汗', () => {
    expect(faceOf({ mood: 'sad' })).toMatchObject({
      brows: 'sad',
      mouth: 'frown',
      extra: 'sweat',
    });
  });

  it('专注与忙碌都是压扁的眼，但忙碌会冒气泡', () => {
    expect(faceOf({ mood: 'focus' })).toMatchObject({ eyes: 'narrow', extra: 'none' });
    expect(faceOf({ mood: 'busy' })).toMatchObject({ eyes: 'narrow', extra: 'think' });
  });

  it('每种 mood 都有自己的说明，不会两张脸共用一个词', () => {
    const labels = (['idle', 'focus', 'busy', 'waiting', 'happy', 'sad', 'sleep'] as const).map(
      (mood) => faceOf({ mood }).label,
    );
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('嘴的开合', () => {
  it('听你说话时跟着音量，但留一条缝——全闭着不像在听', () => {
    expect(mouthOpenOf({ listening: true, speaking: false, level: 0 })).toBeCloseTo(0.12);
    expect(mouthOpenOf({ listening: true, speaking: false, level: 0.2 })).toBeCloseTo(0.48);
    // 音量再大也不超过 1：嘴张到最大就该停，不能把整张脸撑破。
    expect(mouthOpenOf({ listening: true, speaking: false, level: 5 })).toBe(1);
  });

  it('它在说话时给一个固定基准，开合交给动画', () => {
    expect(mouthOpenOf({ listening: false, speaking: true })).toBeCloseTo(0.34);
  });

  it('都不说话时嘴闭着', () => {
    expect(mouthOpenOf({ listening: false, speaking: false, level: 0.9 })).toBe(0);
  });

  it('同时听和说时以听为准：用户的音量才是真实信号', () => {
    expect(mouthOpenOf({ listening: true, speaking: true, level: 0.1 })).toBeCloseTo(0.24);
  });
});
