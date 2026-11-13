import { describe, expect, it } from 'vitest';
import {
  audioFileName,
  cleanTranscript,
  defaultStt,
  normalizeStt,
  sttDefaults,
  sttErrorText,
  sttPrompt,
  sttStatusOf,
  transcribeEndpoint,
} from '../src/core/stt';

describe('语音转写配置', () => {
  it('默认是关的：这东西一开就会把声音送出去，不能自己打开', () => {
    expect(defaultStt).toEqual({ enabled: false });
  });

  it('只认严格的 true，字符串和 1 都当没开', () => {
    expect(normalizeStt({ enabled: true })).toEqual({ enabled: true });
    expect(normalizeStt({ enabled: 'true' })).toEqual({ enabled: false });
    expect(normalizeStt({ enabled: 1 })).toEqual({ enabled: false });
    expect(normalizeStt(null)).toEqual({ enabled: false });
    expect(normalizeStt(undefined)).toEqual({ enabled: false });
  });

  it('状态分三档：没开、缺 Key、能用', () => {
    expect(sttStatusOf({ enabled: false }, true)).toBe('off');
    expect(sttStatusOf({ enabled: false }, false)).toBe('off');
    // 打开了但没 Key：要让面板说出「缺 Key」，而不是笼统地「没开」。
    expect(sttStatusOf({ enabled: true }, false)).toBe('no-key');
    expect(sttStatusOf({ enabled: true }, true)).toBe('ready');
  });
});

describe('转写端点', () => {
  it('带不带 /v1 都拼成同一个地址', () => {
    expect(transcribeEndpoint('https://api.siliconflow.cn/v1')).toBe(
      'https://api.siliconflow.cn/v1/audio/transcriptions',
    );
    expect(transcribeEndpoint('https://api.siliconflow.cn')).toBe(
      'https://api.siliconflow.cn/v1/audio/transcriptions',
    );
    // 末尾斜杠也不能拼出双斜杠。
    expect(transcribeEndpoint('https://api.siliconflow.cn/v1/')).toBe(
      'https://api.siliconflow.cn/v1/audio/transcriptions',
    );
  });

  it('模型名是 SenseVoiceSmall——DeepSeek 没有转写接口，这条必须走别家', () => {
    expect(sttDefaults.model).toBe('FunAudioLLM/SenseVoiceSmall');
    expect(new URL(sttDefaults.baseUrl).hostname).toBe('api.siliconflow.cn');
  });
});

describe('转写文本清洗', () => {
  it('洗掉语言、情绪、事件标签', () => {
    // SenseVoice 原版会在正文前吐这些标记，原样拼进提示词模型会当成乱码。
    expect(cleanTranscript('<|zh|><|NEUTRAL|><|Speech|><|woitn|>帮我看看这个报错')).toBe(
      '帮我看看这个报错',
    );
  });

  it('把换行和连续空格压成单个空格', () => {
    expect(cleanTranscript('  第一句\n\n第二句   第三句  ')).toBe('第一句 第二句 第三句');
  });

  it('只有标签没有正文时得到空串——上层据此说「没听清」', () => {
    expect(cleanTranscript('<|zh|><|NEUTRAL|>')).toBe('');
    expect(cleanTranscript('')).toBe('');
  });

  // 实测：同一句「明天再说吧，今天太累了。」有时带 😊 有时不带。
  // 它是模型的情绪标记，不是用户说的话，而且会原样进提示词。
  it('抹掉模型追加的情绪表情', () => {
    expect(cleanTranscript('明天再说吧，今天太累了。😊')).toBe('明天再说吧，今天太累了。');
    expect(cleanTranscript('今天下午3点开会。😊')).toBe('今天下午3点开会。');
    // 组合表情（带零宽连接与变体选择符）也要一起清掉。
    expect(cleanTranscript('收到 ✌🏻👨‍💻')).toBe('收到');
    expect(cleanTranscript('好👍🏻的')).toBe('好的');
    // 只剩表情时算没听清，而不是回一句欢迎语。
    expect(cleanTranscript('😊')).toBe('');
  });

  it('超长会被截断，不会把一段话灌满整个提示词', () => {
    const long = '啊'.repeat(sttDefaults.maxTextChars + 50);
    expect(cleanTranscript(long)).toHaveLength(sttDefaults.maxTextChars);
  });
});

describe('上传文件名', () => {
  it('按 MIME 推扩展名', () => {
    expect(audioFileName('audio/webm;codecs=opus')).toBe('speech.webm');
    expect(audioFileName('audio/webm')).toBe('speech.webm');
    expect(audioFileName('audio/mp4')).toBe('speech.m4a');
    expect(audioFileName('audio/mpeg')).toBe('speech.mp3');
  });

  it('不认识的类型回落到 webm，而不是给个空文件名', () => {
    expect(audioFileName('application/octet-stream')).toBe('speech.webm');
    expect(audioFileName('')).toBe('speech.webm');
  });
});

describe('错误翻译', () => {
  it('每种失败都说清下一步干什么', () => {
    expect(sttErrorText(0)).toContain('网络');
    expect(sttErrorText(401)).toContain('Key');
    expect(sttErrorText(403)).toContain('Key');
    expect(sttErrorText(413)).toContain('太大');
    expect(sttErrorText(429)).toContain('限流');
    expect(sttErrorText(503)).toContain('忙');
    // 没覆盖到的状态码也要带上码，方便排查。
    expect(sttErrorText(418)).toContain('418');
  });
});

describe('提示词注入', () => {
  it('不能用的时候一个字都不提', () => {
    // 提了模型就会编「我听到你说」——和摄像头那条同一个坑。
    expect(sttPrompt({ enabled: false }, true)).toBe('');
    expect(sttPrompt({ enabled: true }, false)).toBe('');
  });

  it('能用时只交代「可能是说出来的」，不说内容', () => {
    const block = sttPrompt({ enabled: true }, true);
    expect(block).toContain('按住麦克风');
    expect(block).toContain('同音错字');
    // 不告诉模型「刚才说了什么」：内容在用户消息里，重复注入会诱发复述。
    expect(block).not.toContain('刚才');
  });
});
