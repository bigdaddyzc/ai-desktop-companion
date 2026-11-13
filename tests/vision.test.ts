import { describe, expect, it } from 'vitest';
import {
  defaultVision,
  emptyVisionSnapshot,
  frameDataUrl,
  lookInstruction,
  normalizeVision,
  parseVision,
  visionAllowed,
  visionBody,
  visionEndpoint,
  visionLabel,
  visionModelOf,
  visionModels,
  visionObservation,
  visionPrompt,
} from '../src/core/vision';

describe('视觉：配置收口', () => {
  it('默认两个开关都关：截屏不能默认打开', () => {
    expect(defaultVision).toMatchObject({ allowScreen: false, allowCamera: false });
    // 默认档必须是免费档：付费模型对免费账号是 403，用户只会看到「Key 不对」。
    expect(visionModels.findIndex((item) => item.id === defaultVision.model)).toBeLessThan(2);
    expect(visionLabel(defaultVision)).toBe('不许看');
    expect(visionAllowed(defaultVision, 'screen')).toBe(false);
    expect(visionAllowed(defaultVision, 'camera')).toBe(false);
  });

  it('手改坏的配置一律当作不许看', () => {
    expect(normalizeVision({ allowScreen: 'yes', allowCamera: 1 })).toMatchObject({
      allowScreen: false,
      allowCamera: false,
    });
    expect(normalizeVision(null)).toEqual(defaultVision);
  });

  it('模型名不在预置里就回到默认的那一档', () => {
    expect(normalizeVision({ model: 'gpt-4o' }).model).toBe(defaultVision.model);
    expect(normalizeVision({ model: visionModels[2]!.id }).model).toBe(visionModels[2]!.id);
    expect(visionModelOf('不存在').id).toBe(visionModels[0]!.id);
  });

  it('标签把开着的通道说清楚', () => {
    expect(visionLabel({ ...defaultVision, allowScreen: true })).toBe('看屏幕');
    expect(visionLabel({ ...defaultVision, allowScreen: true, allowCamera: true })).toBe(
      '看屏幕 · 看摄像头',
    );
  });

  it('空快照是「没 Key + 不许看」', () => {
    expect(emptyVisionSnapshot()).toMatchObject({ status: 'no-key', lastText: '', busy: false });
  });
});

describe('视觉：请求与解析', () => {
  it('端点按 origin 拼，不会变成 /v1/v1', () => {
    expect(visionEndpoint('https://api.siliconflow.cn/v1')).toBe(
      'https://api.siliconflow.cn/v1/chat/completions',
    );
    expect(visionEndpoint('https://api.siliconflow.cn/v1/')).toBe(
      'https://api.siliconflow.cn/v1/chat/completions',
    );
  });

  it('图片走 data URL，不需要先传到别处', () => {
    expect(frameDataUrl('AAA')).toBe('data:image/jpeg;base64,AAA');
  });

  it('没提问题就给一句通用指令', () => {
    expect(lookInstruction('screen', '  ')).toContain('屏幕截图');
    // 摄像头的默认指令要逼着模型描述外观细节，而不是一句「有个人」。
    expect(lookInstruction('camera', '')).toContain('连续画面');
    expect(lookInstruction('camera', '')).toContain('五官');
    expect(lookInstruction('screen', '这个报错什么意思')).toBe('这个报错什么意思');
  });

  it('请求体是 OpenAI 兼容的图 + 文，多帧就是多个 image part', () => {
    const body = visionBody({
      model: 'Qwen/Qwen3-VL-8B-Instruct',
      source: 'screen',
      base64: ['AAA', 'BBB'],
      question: '界面上有什么',
    }) as {
      model: string;
      messages: { role: string; content: unknown }[];
      max_tokens: number;
      stream: boolean;
    };
    expect(body.model).toBe('Qwen/Qwen3-VL-8B-Instruct');
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBeGreaterThan(0);
    const user = body.messages[1]!;
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as { type: string }[];
    expect(parts.map((part) => part.type)).toEqual(['image_url', 'image_url', 'text']);
  });

  it('从 choices 里取描述；结构不对就给空串，不编', () => {
    expect(parseVision({ choices: [{ message: { content: ' 一 个 编辑器 ' } }] })).toBe(
      '一 个 编辑器',
    );
    expect(parseVision({ choices: [] })).toBe('');
    expect(parseVision({ error: 'x' })).toBe('');
    expect(parseVision(null)).toBe('');
  });

  it('描述太长会截断：接不住的内容不如不要', () => {
    const text = 'a'.repeat(2000);
    expect(parseVision({ choices: [{ message: { content: text } }] }).length).toBeLessThanOrEqual(
      900,
    );
  });
});

describe('视觉：交给模型的观测文本', () => {
  it('写清「一帧、静态、几秒前」，防止模型当成实时视频', () => {
    const text = visionObservation({
      source: 'screen',
      text: '一个代码编辑器',
      ageMs: 4_200,
      at: 0,
    });
    expect(text).toContain('屏幕');
    expect(text).toContain('约 4 秒前');
    expect(text).toContain('不是实时视频');
    expect(text).toContain('一个代码编辑器');
  });

  it('刚看完就说刚刚，别写「0 秒前」', () => {
    expect(visionObservation({ source: 'camera', text: 'x', ageMs: 200, at: 0 })).toContain('刚刚');
  });

  it('摄像头连拍时在观测文本里写明帧数', () => {
    const text = visionObservation({
      source: 'camera',
      text: '一个人',
      ageMs: 900,
      at: 0,
      frames: 3,
    });
    expect(text).toContain('连续 3 帧');
    // 屏幕永远是一帧，不该出现「连续」。
    const screen = visionObservation({ source: 'screen', text: 'x', ageMs: 900, at: 0, frames: 1 });
    expect(screen).toContain('一帧静态画面');
  });
});

describe('视觉：提示词', () => {
  it('两个开关都关就不占提示词位置', () => {
    expect(visionPrompt(defaultVision)).toBe('');
  });

  it('打开后要说清「只有调用 look 才有画面」', () => {
    const block = visionPrompt({ ...defaultVision, allowScreen: true });
    expect(block).toContain('look');
    expect(block).toContain('用户可以让你看：屏幕。');
    expect(block).toContain('不要凭猜测');
  });

  it('禁止拿感官的「有动静」冒充看见，失败要如实说', () => {
    const block = visionPrompt({ ...defaultVision, allowCamera: true });
    expect(block).toContain('不是画面');
    expect(block).toContain('冒充');
    expect(block).toContain('失败原因');
  });

  it('两个都开时都写进去', () => {
    const block = visionPrompt({ ...defaultVision, allowScreen: true, allowCamera: true });
    expect(block).toContain('屏幕 和 摄像头');
  });
});
