import { describe, expect, it } from 'vitest';
import {
  chatFeeling,
  faceCatalog,
  faceKeyOf,
  faceKeys,
  faceOf,
  jobFeeling,
  normalizeFacePrefs,
} from '../src/core/expression';
import { normalizePersona } from '../src/core/persona';

describe('表情目录与偏好', () => {
  it('12 种表情，key 与目录一致', () => {
    expect(faceKeys).toHaveLength(12);
    for (const key of faceKeys) expect(faceCatalog[key].key).toBe(key);
  });

  it('关掉的表情停在「安静」', () => {
    expect(faceOf({ mood: 'sad' }).key).toBe('sad');
    expect(faceOf({ mood: 'sad' }, ['sad']).key).toBe('idle');
  });

  it('后台派活时是「忙着」，刚聊出的情绪优先，但不压过等确认和说话', () => {
    expect(faceKeyOf({ mood: 'idle', working: true })).toBe('busy');
    expect(faceKeyOf({ mood: 'idle', working: true, feeling: 'happy' })).toBe('happy');
    expect(faceKeyOf({ mood: 'waiting', feeling: 'happy' })).toBe('waiting');
    expect(faceKeyOf({ mood: 'idle', speaking: true, feeling: 'sad' })).toBe('speaking');
  });

  it('偏好收口：未知画风回落、未知表情丢掉、安静关不掉', () => {
    expect(
      normalizeFacePrefs({ style: 'xx', off: ['sad', 'nope', 'idle', 'sad'], followChat: false }),
    ).toEqual({
      style: 'classic',
      off: ['sad'],
      followChat: false,
    });
    expect(normalizeFacePrefs(null)).toEqual({ style: 'classic', off: [], followChat: true });
  });

  it('旧的性格配置没有 face 字段也能读', () => {
    expect(normalizePersona({ preset: 'warm', nickname: '', idleLines: [] }).face.style).toBe(
      'classic',
    );
  });
});

describe('聊天情绪', () => {
  it('你说的话优先', () => {
    expect(chatFeeling('今天好累啊', '哈哈那早点睡')).toBe('sad');
    expect(chatFeeling('项目上线成功了', '好的')).toBe('happy');
  });
  it('它在问你就是在等你', () => {
    expect(chatFeeling('帮我看看', '你说的是哪个项目？')).toBe('waiting');
  });
  it('猜不出就不动', () => {
    expect(chatFeeling('现在几点', '下午三点。')).toBeNull();
  });
  it('派的活：干完开心、没成担心', () => {
    expect(jobFeeling('✅ WorkBuddy 干完了')).toBe('happy');
    expect(jobFeeling('⚠ WorkBuddy 这件活没干成')).toBe('sad');
    expect(jobFeeling('别的')).toBeNull();
  });
});
