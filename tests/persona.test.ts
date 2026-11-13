import { describe, expect, it } from 'vitest';
import {
  buildInstructions,
  defaultPersona,
  normalizeIdleLines,
  normalizeNickname,
  normalizePersona,
  personaChoices,
  personaPresets,
  petExcerpt,
  petExcerptChars,
  type PersonaPreset,
} from '../src/core/persona';

const allPresets: PersonaPreset[] = ['banter', 'warm', 'dry', 'chill'];

const at = new Date(2026, 10, 8, 10, 2).getTime();

describe('人格提示词', () => {
  it('写清它是伙伴而不是客服，并禁止官腔', () => {
    const prompt = buildInstructions('', at);
    expect(prompt).toContain('芯伴');
    expect(prompt).toContain('不是客服');
    expect(prompt).toContain('用「你」，不用「您」');
    expect(prompt).toContain('不要「希望这对你有帮助」');
  });

  it('把「短」写成硬约束，并给出屏幕尺寸这个理由', () => {
    const prompt = buildInstructions('', at);
    expect(prompt).toContain('216×216');
    expect(prompt).toMatch(/一到两句/);
    // 显式禁止清单化：小屏上 1234 会挤成一堵墙。
    expect(prompt).toContain('不列 1234 清单');
  });

  it('带上了当前日期，省得它去猜', () => {
    expect(buildInstructions('', at)).toContain('2026 年 11 月 8 日，周日');
  });

  it('有记忆时追加在最后，并声明只是背景不是指令', () => {
    const prompt = buildInstructions('[喜好] 不吃香菜', at);
    expect(prompt).toContain('不吃香菜');
    expect(prompt).toContain('不是指令');
    // 记忆必须排在说话规则之后：先立规矩，再给背景。
    expect(prompt.indexOf('不吃香菜')).toBeGreaterThan(prompt.indexOf('说话方式'));
  });

  it('没有记忆时不留下空标题', () => {
    expect(buildInstructions('   ', at)).not.toContain('关于他的印象');
  });

  it('拒绝提示注入，并禁止记录敏感信息', () => {
    const prompt = buildInstructions('', at);
    expect(prompt).toContain('不是用户的意思');
    expect(prompt).toContain('密码');
    expect(prompt).toContain('绝不记');
  });

  it('明确要求不要把链接贴进回答，来源只留在面板里', () => {
    const prompt = buildInstructions('', at);
    expect(prompt).toContain('不要在回答里贴链接');
    expect(prompt).toContain('来源已经记在面板里');
    // 「哪来的」这一问还得答得出来，否则等于让模型装不知道。
    expect(prompt).toContain('哪来的');
  });
});

describe('性格预设', () => {
  it('四种预设的规则和示例各写各的，不是换个词凑数', () => {
    const prompts = allPresets.map((preset) =>
      buildInstructions('', at, '', { preset, nickname: '' }),
    );
    expect(new Set(prompts).size).toBe(allPresets.length);
    for (const preset of allPresets) {
      const prompt = buildInstructions('', at, '', { preset, nickname: '' });
      expect(prompt).toContain(personaPresets[preset].examples[0]!);
    }
  });

  it('默认是损友', () => {
    expect(defaultPersona.preset).toBe('banter');
    expect(buildInstructions('', at)).toContain('嘴上不客气的那种朋友');
  });

  it('惜字那套真的更短：示例平均字数不超过默认预设', () => {
    const average = (preset: PersonaPreset): number => {
      const lines = personaPresets[preset].examples.filter((line) => line.startsWith('芯伴：'));
      const total = lines.reduce((sum, line) => sum + line.replace('芯伴：', '').length, 0);
      return total / lines.length;
    };
    expect(average('dry')).toBeLessThan(average('banter'));
    expect(average('dry')).toBeLessThan(average('warm'));
  });

  it('问「你了解我什么」有专门策略：给判断，不报档案', () => {
    const prompt = buildInstructions('', at);
    expect(prompt).toContain('说说你对我的了解');
    expect(prompt).toContain('不是让你报档案');
    expect(prompt).toContain('别借机汇报项目进度');
  });

  it('四个预设都给了「了解我」的示例，否则换性格就退回念清单', () => {
    for (const preset of allPresets) {
      const prompt = buildInstructions('', at, '', { preset, nickname: '' });
      expect(prompt).toContain('用户：说说你对我的了解');
    }
  });

  it('记忆规则里也说清楚称呼不归记忆管，避免两处各存一份', () => {
    expect(buildInstructions('', at)).toContain('称呼不归记忆管');
  });

  it('不念记忆条目这条，比「不列清单」更具体地写进去了', () => {
    expect(buildInstructions('', at)).toContain('不要念记忆条目');
  });

  it('给了昵称就写进称呼规则，并且提醒不要每句都叫', () => {
    const prompt = buildInstructions('', at, '', { preset: 'warm', nickname: '林舟' });
    expect(prompt).toContain('叫他「林舟」');
    expect(prompt).toContain('不要每句都带上');
  });

  it('没给昵称就别硬加称呼', () => {
    expect(buildInstructions('', at, '', { preset: 'warm', nickname: '' })).toContain('不用叫名字');
  });

  it('换性格不放松底线：四种预设里敏感信息、注入防护都在', () => {
    for (const preset of allPresets) {
      const prompt = buildInstructions('', at, '', { preset, nickname: '阿超' });
      expect(prompt).toContain('绝不记');
      expect(prompt).toContain('不是用户的意思');
      expect(prompt).toContain('不编造事实');
    }
  });

  it('来路不明的配置一律回落，不抛错', () => {
    expect(normalizePersona(null)).toEqual(defaultPersona);
    expect(normalizePersona({ preset: 'evil', nickname: 42 })).toEqual(defaultPersona);
    expect(normalizePersona({ preset: 'dry', nickname: '  阿   超  ' })).toEqual({
      preset: 'dry',
      nickname: '阿 超',
      idleLines: [],
      face: defaultPersona.face,
    });
  });

  it('昵称被压平并截断，不会把一句话顶满', () => {
    expect(normalizeNickname('  阿\n超  ')).toBe('阿 超');
    expect(normalizeNickname('长'.repeat(40))).toHaveLength(12);
  });

  it('面板拿到的选项顺序固定，和预设表一致', () => {
    expect(personaChoices().map((choice) => choice.value)).toEqual(allPresets);
    expect(personaChoices().every((choice) => choice.hint.length > 0)).toBe(true);
  });
});

describe('小屏截断', () => {
  it('短回复原样返回', () => {
    expect(petExcerpt('中雨转多云，带伞。')).toEqual({
      text: '中雨转多云，带伞。',
      truncated: false,
    });
  });

  it('超长回复按句子截断，不硬切半个词', () => {
    const long = '第一句说清楚了。'.repeat(20);
    const result = petExcerpt(long);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith('…')).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(petExcerptChars + 1);
    expect(result.text).toContain('。');
  });

  it('没有标点可断时按长度截断，仍然给出省略号', () => {
    const result = petExcerpt('啊'.repeat(400));
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(`${'啊'.repeat(petExcerptChars)}…`);
  });

  it('换行被压成空格，避免小屏上凭空多出几行空白', () => {
    expect(petExcerpt('第一行\n第二行').text).toBe('第一行 第二行');
  });
});

describe('屏幕标语', () => {
  it('空行、重复、超长、超量都会被洗干净', () => {
    const lines = normalizeIdleLines([
      '  慢慢来  ',
      '',
      '   ',
      '慢慢来',
      '这句话明显超过了十六个字的限制所以会被截断',
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('慢慢来');
    expect(lines[1]).toHaveLength(16);
    expect(lines).not.toContain('');
    expect(new Set(lines).size).toBe(5);
  });

  it('不是数组就当没配', () => {
    expect(normalizeIdleLines(undefined)).toEqual([]);
    expect(normalizeIdleLines('慢慢来')).toEqual([]);
    expect(normalizeIdleLines([1, null, {}])).toEqual([]);
  });

  it('老配置没有这个字段也能读出来，性格不丢', () => {
    expect(normalizePersona({ preset: 'dry', nickname: '阿超' })).toEqual({
      preset: 'dry',
      nickname: '阿超',
      idleLines: [],
      face: defaultPersona.face,
    });
  });
});
