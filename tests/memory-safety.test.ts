import { describe, expect, it } from 'vitest';
import {
  addEpisode,
  emptyMemory,
  forgetFacts,
  forgetLimit,
  looksSensitive,
  mergeFact,
  toHalfWidth,
  type MemoryState,
} from '../src/core/memory';

const now = 1_700_000_000_000;

function withFacts(texts: string[]): MemoryState {
  return texts.reduce(
    (state, text, index) => mergeFact(state, { text, category: 'context' }, now + index).state,
    emptyMemory(),
  );
}

describe('敏感信息拦截', () => {
  it.each([
    ['银行卡 6222021234567890123'],
    ['6222 0212 3456 7890 123'],
    ['4302-1119-9001-0112-3X'],
    ['１１０１０５１９９００１０１１２３Ｘ'],
    ['手机 13812345678'],
    ['138 1234 5678'],
    ['邮箱 zhang@example.com'],
    ['my password is hunter2'],
    ['pwd: abc123'],
    ['PIN 4829'],
    ['长沙市岳麓区麓谷大道627号'],
    ['住在 3 栋 1203室'],
    ['密码是 hunter2'],
    ['API_KEY 放在桌面'],
  ])('拦下：%s', (text) => {
    expect(looksSensitive(text)).toBe(true);
  });

  it.each([
    ['会议室2点开会'],
    ['在长沙做医院信息化'],
    ['喜欢吃辣'],
    ['每天 7 点起床'],
    ['养了 2 只猫'],
  ])('不误拦：%s', (text) => {
    expect(looksSensitive(text)).toBe(false);
  });

  it('全角转半角', () => {
    expect(toHalfWidth('ＡＢＣ１２３　')).toBe('ABC123 ');
  });

  it('mergeFact 自己拦：后台抽取走不进敏感信息', () => {
    const result = mergeFact(emptyMemory(), { text: '银行卡 6222021234567890123' }, now);
    expect(result.outcome).toBe('skipped');
    expect(result.state.facts).toHaveLength(0);
  });

  it('情节纪要同样拦', () => {
    const result = addEpisode(emptyMemory(), '他说密码是 hunter2', now);
    expect(result.added).toBe(false);
    expect(result.state.episodes).toHaveLength(0);
  });
});

describe('记忆去重不误合并', () => {
  it('否定不同不合并', () => {
    const state = withFacts(['不喜欢加班到深夜', '喜欢加班到深夜']);
    expect(state.facts.map((fact) => fact.text)).toEqual(['不喜欢加班到深夜', '喜欢加班到深夜']);
  });

  it('说的不是同一个人不合并', () => {
    const state = withFacts(['女儿在长沙岳麓读大学', '儿子在长沙岳麓读大学']);
    expect(state.facts).toHaveLength(2);
  });

  it('同一件事合并时保留最新说法', () => {
    const state = withFacts(['在长沙做医院信息化工作', '在长沙做医院信息化']);
    expect(state.facts).toHaveLength(1);
    expect(state.facts[0]!.text).toBe('在长沙做医院信息化');
  });
});

describe('忘掉不过度删除', () => {
  it('一个字的关键词不删', () => {
    const state = withFacts(['我在长沙', '我喜欢猫']);
    const result = forgetFacts(state, '我');
    expect(result.removed).toHaveLength(0);
    expect(result.state.facts).toHaveLength(2);
  });

  it('命中太多时一条不删，把候选交回去', () => {
    const state = withFacts(['在长沙工作', '长沙人', '爱吃长沙臭豆腐', '家在长沙岳麓']);
    const result = forgetFacts(state, '长沙');
    expect(result.removed).toHaveLength(0);
    expect(result.candidates.length).toBeGreaterThan(forgetLimit);
    expect(result.state.facts).toHaveLength(4);
  });

  it('少量命中照常删除', () => {
    const state = withFacts(['不吃香菜', '在长沙工作']);
    const result = forgetFacts(state, '香菜');
    expect(result.removed.map((fact) => fact.text)).toEqual(['不吃香菜']);
    expect(result.state.facts).toHaveLength(1);
  });
});
