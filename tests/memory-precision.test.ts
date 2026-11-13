import { describe, expect, it } from 'vitest';
import {
  buildMemoryInjection,
  emptyMemory,
  mergeFact,
  type MemoryCategory,
  type MemoryState,
} from '../src/core/memory';

const now = 1_800_000_000_000;

function seed(items: [string, MemoryCategory][]): MemoryState {
  let state = emptyMemory();
  for (const [text, category] of items) {
    state = mergeFact(state, { text, category, source: 'said' }, now).state;
  }
  return state;
}

const sample = seed([
  ['在长沙做医院信息化', 'identity'],
  ['不吃香菜', 'preference'],
  ['在做镜架 SIT 价格验证', 'goal'],
  ['芯伴实体硬件还差外壳', 'context'],
]);

describe('P1-4 记忆注入精度', () => {
  it('无关的问题：只带「他这个人」，不带手头的工作', () => {
    const result = buildMemoryInjection(sample, '今天天气怎么样');
    expect(result.text).toContain('不吃香菜');
    expect(result.text).not.toContain('镜架');
    expect(result.text).not.toContain('外壳');
    expect(result.text).not.toContain('手头在忙');
  });

  it('问到相关的事：手头的工作照常带上，并计入命中', () => {
    const result = buildMemoryInjection(sample, '镜架价格验证怎么样了');
    expect(result.text).toContain('镜架 SIT 价格验证');
    expect(result.matched).toBeGreaterThanOrEqual(1);
    expect(result.injected.length).toBeGreaterThanOrEqual(result.matched);
  });

  it('问的就是「我最近在忙什么」：没有字面命中也带上工作', () => {
    const result = buildMemoryInjection(sample, '我最近在忙什么');
    expect(result.text).toContain('手头在忙');
  });

  it('有一条弱命中时，其余「他这个人」仍补满名额', () => {
    const state = seed([
      ['习惯晚上写代码', 'habit'],
      ['不吃香菜', 'preference'],
      ['在长沙做医院信息化', 'identity'],
    ]);
    const result = buildMemoryInjection(state, '晚上点个外卖，有什么要注意的');
    expect(result.text).toContain('晚上写代码');
    expect(result.text).toContain('不吃香菜');
  });

  it('关掉记忆：什么都不注入', () => {
    const result = buildMemoryInjection({ ...sample, enabled: false }, '镜架');
    expect(result).toEqual({ text: '', injected: [], matched: 0 });
  });
});
