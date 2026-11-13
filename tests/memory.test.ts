import { describe, expect, it } from 'vitest';
import {
  addEpisode,
  buildMemoryPrompt,
  emptyMemory,
  forgetFacts,
  inferCategory,
  memoryLimits,
  memoryExtractionPrompt,
  memorySimilarity,
  mergeFact,
  sameSubject,
  sharesSubject,
  newMemoryId,
  normalizeMemoryText,
  parseExtraction,
  searchFacts,
  trimFacts,
  type MemoryFact,
  type MemoryState,
} from '../src/core/memory';

const now = 1_770_000_000_000;
const base = (facts: { text: string; category?: string }[]): MemoryState => {
  let state = emptyMemory();
  for (const fact of facts) {
    state = mergeFact(state, fact, now).state;
  }
  return state;
};

describe('记忆文本规范化', () => {
  it('去掉首尾空白与句末标点，避免同一件事被记两次', () => {
    expect(normalizeMemoryText('  不吃香菜。 ')).toBe('不吃香菜');
    expect(normalizeMemoryText('· 在长沙工作！')).toBe('在长沙工作');
    expect(normalizeMemoryText('连续   空格')).toBe('连续 空格');
  });

  it('相近的短句相似度高，不相关的不高', () => {
    expect(memorySimilarity('在长沙做医院信息化', '在长沙做医院信息化工作')).toBeGreaterThan(0.6);
    expect(memorySimilarity('不吃香菜', '喜欢下雨天')).toBeLessThan(0.2);
  });
});

describe('合并与去重', () => {
  it('新事实被记为 added，重复的算 updated 而不是再来一条', () => {
    const first = mergeFact(emptyMemory(), { text: '不吃香菜', category: 'preference' }, now);
    expect(first.outcome).toBe('added');
    const second = mergeFact(first.state, { text: '不吃香菜。' }, now + 1);
    expect(second.outcome).toBe('updated');
    expect(second.state.facts).toHaveLength(1);
    expect(second.state.facts[0]!.hits).toBe(1);
  });

  it('换语序的同义句也会被合并，不会攒成一堆近似重复', () => {
    const state = base([{ text: '在长沙做医院信息化工作' }]);
    const merged = mergeFact(state, { text: '在长沙做医院信息化' }, now);
    expect(merged.outcome).toBe('updated');
    expect(merged.state.facts).toHaveLength(1);
  });

  it('只差一个字的短句不会被误合并', () => {
    // 「不吃辣」和「不吃甜」有两个字相同，但意思不同，合成一条就是错的。
    const state = base([{ text: '不吃辣' }]);
    const merged = mergeFact(state, { text: '不吃甜' }, now);
    expect(merged.outcome).toBe('added');
    expect(merged.state.facts).toHaveLength(2);
  });

  it('空内容被跳过，不产生空记忆', () => {
    const result = mergeFact(emptyMemory(), { text: '   ' }, now);
    expect(result.outcome).toBe('skipped');
    expect(result.state.facts).toHaveLength(0);
  });

  it('类别缺失时按内容猜一个，而不是全部塞进 context', () => {
    const result = mergeFact(emptyMemory(), { text: '我住在长沙' }, now);
    expect(result.fact?.category).toBe('identity');
    expect(inferCategory('喜欢喝美式')).toBe('preference');
    expect(inferCategory('每天六点起床')).toBe('habit');
  });

  it('超过上限时按重要性淘汰，置顶的永远留下', () => {
    // 直接构造，不走 mergeFact：这批文本刻意相似，合并逻辑会把它们并成一条。
    const facts = Array.from({ length: memoryLimits.maxFacts + 5 }, (_, index) => ({
      id: `f${index}`,
      text: `第${index}条背景信息记录`,
      category: 'context' as const,
      source: 'said' as const,
      createdAt: now + index,
      updatedAt: now + index,
      hits: 0,
      pinned: index === 0,
    }));
    const trimmed = trimFacts({ ...emptyMemory(), facts });
    expect(trimmed.facts).toHaveLength(memoryLimits.maxFacts);
    expect(trimmed.facts.some((fact) => fact.pinned)).toBe(true);
  });
});

describe('检索与遗忘', () => {
  const state = base([
    { text: '不吃香菜', category: 'preference' },
    { text: '在长沙做医院信息化工作', category: 'identity' },
    { text: '正在写医疗服务价格汇编', category: 'goal' },
  ]);

  it('按提问相关度捞事实', () => {
    const result = searchFacts(state, '香菜能吃吗');
    expect(result[0]?.text).toContain('香菜');
  });

  it('没有关键词命中时按重要性兜底，不会返回空', () => {
    const result = searchFacts(state, '你还记得我吗');
    expect(result.length).toBeGreaterThan(0);
  });

  it('忘记支持模糊匹配，用户不必报 id', () => {
    const { state: after, removed } = forgetFacts(state, '香菜');
    expect(removed).toHaveLength(1);
    expect(after.facts).toHaveLength(2);
  });

  it('忘记不匹配的内容时什么都不删', () => {
    const { state: after, removed } = forgetFacts(state, '养了一只猫');
    expect(removed).toHaveLength(0);
    expect(after.facts).toHaveLength(3);
  });
});

describe('同一条记忆的几种说法', () => {
  const fact = (text: string, category: 'habit' | 'goal' | 'preference' = 'habit'): MemoryFact => ({
    id: text,
    text,
    category,
    source: 'inferred',
    createdAt: now,
    updatedAt: now,
    hits: 0,
    pinned: false,
  });

  it('共享同一个专名就算同一件事——字面相似度救不了这些', () => {
    // 这一对 similarity 只有 0.41，任何阈值都判不成重复，但它们说的就是一件事。
    expect(
      sameSubject(fact('习惯用 Claude Code 干活'), fact('用 Claude Code 和 ESP32 做开发')),
    ).toBe(true);
    expect(sameSubject(fact('在做镜架 SIT 价格验证'), fact('手上还有镜架 SIT 项目'))).toBe(true);
    expect(sharesSubject('问长沙今天天气和雨何时停', '询问长沙天气会不会下雨')).toBe(true);
  });

  it('只共享一个泛词的两条不算重复，宁可多一条也不能吞掉信息', () => {
    expect(sharesSubject('不吃辣', '不吃甜')).toBe(false);
    expect(sharesSubject('喜欢猫', '喜欢狗')).toBe(false);
    expect(sharesSubject('在长沙', '在武汉')).toBe(false);
    expect(sharesSubject('在长沙', '叫我小芯')).toBe(false);
  });

  it('没有共同特征的完全不相干', () => {
    expect(sharesSubject('不吃香菜', '在做镜架 SIT 价格验证')).toBe(false);
    expect(sharesSubject('', '在长沙')).toBe(false);
  });
});

describe('提示词块', () => {
  it('没有记忆时返回空串，不往请求里塞空标题', () => {
    expect(buildMemoryPrompt(emptyMemory(), '随便')).toBe('');
  });

  it('注入的是印象不是档案：不带类别标签，声明别逐条念', () => {
    const state = base([{ text: '不吃香菜', category: 'preference' }]);
    const block = buildMemoryPrompt(state, '晚上吃什么');
    expect(block).toContain('不吃香菜');
    expect(block).toContain('别逐条念');
    // 旧版每条前面挂 [喜好] [在做的事]，一张带标签的清单最省力的用法就是照着念。
    expect(block).not.toContain('[喜好]');
    expect(block).not.toMatch(/\[关于你\]/);
  });

  it('人和手头的事分两组：混在一起模型就会串着说', () => {
    const state = base([
      { text: '在长沙', category: 'identity' },
      { text: '一忙就忘吃饭', category: 'habit' },
      { text: '在做镜架 SIT 价格验证', category: 'goal' },
    ]);
    const block = buildMemoryPrompt(state, '说说你对我的了解');
    const profileLine = block.split('\n').find((line) => line.startsWith('他这个人：')) ?? '';
    const doingLine = block.split('\n').find((line) => line.startsWith('手头在忙：')) ?? '';
    expect(profileLine).toContain('在长沙');
    expect(profileLine).toContain('一忙就忘吃饭');
    expect(doingLine).toContain('在做镜架 SIT 价格验证');
    expect(profileLine).not.toContain('镜架');
  });

  it('「在长沙」这种被猜成 context 的地点陈述仍算「人」，不算手头的事', () => {
    const state = base([{ text: '在长沙', category: 'context' }]);
    expect(buildMemoryPrompt(state, '聊聊我')).toContain('他这个人：在长沙');
  });

  it('同一件事的几种说法只注入一条', () => {
    const state = base([
      { text: '习惯用 Claude Code 干活', category: 'habit' },
      { text: '用 Claude Code 和 ESP32 做开发', category: 'habit' },
      { text: '在做镜架 SIT 价格验证', category: 'goal' },
      { text: '手上还有镜架 SIT 项目', category: 'goal' },
    ]);
    const block = buildMemoryPrompt(state, '说说你对我的了解');
    // 两条 Claude Code、两条镜架，各只留一条。
    expect(block.split('Claude Code').length - 1).toBe(1);
    expect(block.split('镜架').length - 1).toBe(1);
  });

  it('过期的进度快照不注入：说错进度比说不出更糟', () => {
    const state = base([
      { text: '芯伴还差实体硬件、安装包、自动更新', category: 'context' },
      { text: '在做镜架 SIT 价格验证', category: 'goal' },
    ]);
    const block = buildMemoryPrompt(state, '说说你对我的了解');
    expect(block).not.toContain('还差实体硬件');
    expect(block).toContain('在做镜架 SIT 价格验证');
  });

  it('情节记忆里换个说法的同一件事也只留一条', () => {
    let state = emptyMemory();
    state = addEpisode(state, '问长沙今天天气和雨何时停', now).state;
    state = addEpisode(state, '询问长沙天气会不会下雨', now + 1).state;
    state = addEpisode(state, '讨论打包前清数据', now + 2).state;
    const block = buildMemoryPrompt(state, '今天天气');
    expect(block.split('长沙').length - 1).toBeLessThanOrEqual(2);
    expect(block).toContain('打包');
  });

  it('关闭记忆后不再注入', () => {
    const state = { ...base([{ text: '不吃香菜' }]), enabled: false };
    expect(buildMemoryPrompt(state, 'x')).toBe('');
  });

  it('超出预算就截断，不会把整个记忆库塞进请求', () => {
    const facts = Array.from({ length: 60 }, (_, index) => ({
      id: `f${index}`,
      text: `这是第 ${index} 条很长的背景信息用来占位测试预算`,
      category: 'context' as const,
      source: 'said' as const,
      createdAt: now + index,
      updatedAt: now + index,
      hits: 0,
      pinned: false,
    }));
    const block = buildMemoryPrompt({ ...emptyMemory(), facts }, '随便', 200);
    expect(block.length).toBeLessThanOrEqual(240);
  });

  it('情节记忆只带最近几条，并标出日期', () => {
    let state = base([{ text: '在长沙工作' }]);
    state = addEpisode(state, '聊了把项目改成个人 agent', now).state;
    const block = buildMemoryPrompt(state, '最近在忙什么');
    expect(block).toContain('聊了把项目改成个人 agent');
    expect(block).toMatch(/\d{2}-\d{2}/);
  });
});

describe('抽取结果解析', () => {
  it('能剥掉代码块与前后废话', () => {
    const raw =
      '好的，这是结果：\n```json\n{"facts":[{"text":"不吃香菜","category":"preference"}],"episode":"聊了晚饭"}\n```';
    const result = parseExtraction(raw);
    expect(result.facts).toEqual([{ text: '不吃香菜', category: 'preference' }]);
    expect(result.episode).toBe('聊了晚饭');
  });

  it('非 JSON 或残缺输入返回空结果，不抛错', () => {
    expect(parseExtraction('模型今天不想干活')).toEqual({ facts: [], episode: '' });
    expect(parseExtraction('{"facts":[')).toEqual({ facts: [], episode: '' });
  });

  it('类别非法时按内容推断，不把整条丢掉', () => {
    const result = parseExtraction('{"facts":[{"text":"我住在长沙","category":"乱写的"}]}');
    expect(result.facts[0]?.category).toBe('identity');
  });

  it('一次最多接受 3 条，多的丢掉', () => {
    const facts = Array.from({ length: 8 }, (_, index) => ({ text: `第${index}条事实内容` }));
    const result = parseExtraction(JSON.stringify({ facts }));
    expect(result.facts).toHaveLength(memoryLimits.maxExtracted);
  });

  it('纯字符串数组也能读，兼容模型偷懒的写法', () => {
    const result = parseExtraction('{"facts":["不吃香菜","在长沙工作"]}');
    expect(result.facts.map((fact) => fact.text)).toEqual(['不吃香菜', '在长沙工作']);
  });
});

describe('情节记忆', () => {
  it('同一件事反复聊不重复记', () => {
    const first = addEpisode(emptyMemory(), '聊了医疗服务价格汇编的进度', now);
    expect(first.added).toBe(true);
    const second = addEpisode(first.state, '聊了医疗服务价格汇编的进度', now + 1000);
    expect(second.added).toBe(false);
    expect(second.state.episodes).toHaveLength(1);
  });

  it('太短的纪要不记，避免塞满「嗯」「好的」', () => {
    expect(addEpisode(emptyMemory(), '嗯', now).added).toBe(false);
  });
});

describe('记忆 id', () => {
  it('同一毫秒内连续生成也不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newMemoryId(now)));
    expect(ids.size).toBe(200);
  });
});

describe('抽取提示词', () => {
  it('问的是「这个人什么样」，不是「他今天干了什么」', () => {
    expect(memoryExtractionPrompt).toContain('这个人是什么样的');
    // 旧版只列了称呼/城市/职业/口味/作息，全是档案字段，于是记忆库里只有项目清单。
    expect(memoryExtractionPrompt).toContain('什么脾气');
  });

  it('明确禁掉项目进度、路径与工具名——它们过几天就过期，还最容易挤满预算', () => {
    expect(memoryExtractionPrompt).toContain('项目进度');
    expect(memoryExtractionPrompt).toContain('文件路径');
    expect(memoryExtractionPrompt).toContain('工具名');
  });

  it('称呼归面板管，记忆里不重复记——本机就撞过「叫我小芯」和昵称打架', () => {
    expect(memoryExtractionPrompt).toContain('都归面板');
    expect(memoryExtractionPrompt).not.toContain('硬信息：称呼');
  });

  it('要求这三条讲不同的事，堵住换个说法重复记的源头', () => {
    expect(memoryExtractionPrompt).toContain('必须讲不同的事');
    expect(memoryExtractionPrompt).toContain('别换个说法');
  });
});
