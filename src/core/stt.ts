/**
 * 语音转文字（纯领域）。
 *
 * 这是整条链路上唯一会把**内容**送出本机的地方，所以边界写死在这里：
 *
 * 1. **只在用户按住按钮时录音**。不做「听到说话就自动上传」——麦克风是常开的，
 *    那等于把房间里的每一句话都送出去。耳朵（`senses.ears`）只算音量，与本文件无关。
 * 2. **录到的音频只存在内存里**，转完即丢，不写磁盘、不进会话历史。
 * 3. 端点、模型、上限都在这里定死，主进程只负责发请求。
 *
 * 走的是硅基流动的 SenseVoiceSmall——官方价格页标价「免费」，中文效果好，
 * 代价是**文件式接口**：必须说完一整段再上传，做不到边说边出字。
 */

/** 开关。真正的可用条件是「打开 且 有 Key」，两者缺一都当没配。 */
export interface SttConfig {
  enabled: boolean;
}

export const defaultStt: SttConfig = { enabled: false };

export const sttDefaults = {
  /**
   * 硅基流动的 OpenAI 兼容端点。**不是** `api.deepseek.com`——
   * DeepSeek 没有语音转写接口，这条链路必须走另一家、另一个 Key。
   */
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'FunAudioLLM/SenseVoiceSmall',
  /** 一次最多按住多久。60 秒够说完一段话，也不会录出传不动的体积。 */
  maxSeconds: 60,
  /** 云端硬限制是 50MB / 1 小时；本地先挡一道，别等传完才收到 413。 */
  maxBytes: 50 * 1024 * 1024,
  /** 低于这个字节数基本是「按错了一下」，传上去也只会换回空字符串。 */
  minBytes: 1_200,
  /** 转写文本上限。语音转出来的东西不该比手打的一段话还长。 */
  maxTextChars: 600,
  /** 上传超时。文件式接口没有流式回包，等太久只能算失败。 */
  timeoutMs: 30_000,
} as const;

/** 生产环境唯一允许的转写主机。测试可注入 loopback 白名单。 */
export const sttAllowedHosts = ['api.siliconflow.cn'] as const;

/** 可用状态。分三档而不是布尔：面板要能说清「差什么」。 */
export type SttStatus = 'off' | 'no-key' | 'ready';

/** 主进程持有的完整状态。**没有 Key 字段**——它连桥都不过。 */
export interface SttSnapshot {
  config: SttConfig;
  status: SttStatus;
  /** 只回模型名，不回 Key，连前几位都不给。 */
  model: string;
  /** 最近一次转出的文字：面板拿它当「真的通了」的证据，也只活到下次转写。 */
  lastText: string;
  /** 最近一次成功的时间；从未成功为 0。 */
  lastAt: number;
  /** 最近一次失败的原因；空串表示最近一次是成功的。 */
  lastError: string;
}

export function emptySttSnapshot(): SttSnapshot {
  return {
    config: { ...defaultStt },
    status: sttStatusOf(defaultStt, false),
    model: sttDefaults.model,
    lastText: '',
    lastAt: 0,
    lastError: '',
  };
}

export function sttStatusOf(config: SttConfig, hasKey: boolean): SttStatus {
  if (!config.enabled) return 'off';
  return hasKey ? 'ready' : 'no-key';
}

/** 收口配置：磁盘被手改、字段类型不对，一律当作没开。 */
export function normalizeStt(raw: unknown): SttConfig {
  if (typeof raw !== 'object' || raw === null) return { ...defaultStt };
  return { enabled: (raw as Record<string, unknown>)['enabled'] === true };
}

/**
 * 拼出转写端点。
 *
 * 用户可能把 baseUrl 写成 `https://api.siliconflow.cn` 或带 `/v1` 两种样子，
 * 而这两种写法在其他平台上都出现过。统一按 origin 拼，避免出现 `/v1/v1/...`。
 */
export function transcribeEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.origin}/v1/audio/transcriptions`;
}

/**
 * 句尾那个情绪表情。
 *
 * 实测 SenseVoice 会**随机**在文本后追加一个表情（三句里两句带 `😊`，一句不带），
 * 那是它给情绪识别留的展示信息。可我们把它当用户说的话填进输入框——用户并没有笑，
 * 而且这段文字紧接着会进提示词。随机的、不属于原话的字符一律不算转写结果。
 */
const emojiPattern = /[\p{Extended_Pictographic}\u{1f3fb}-\u{1f3ff}\ufe0f\u200d\u20e3]/gu;

/**
 * 洗掉 SenseVoice 的前缀标签与情绪表情。
 *
 * 原版模型会在正文前输出 `<|zh|><|NEUTRAL|><|Speech|>` 这类语言/情绪/事件标记。
 * 它们被原样拼进提示词时，模型会以为用户在说乱码；念出来更是噪音。
 */
export function cleanTranscript(raw: string, max: number = sttDefaults.maxTextChars): string {
  return raw
    .replace(/<\|[^|]*\|>/g, '')
    .replace(emojiPattern, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** 从 MIME 推一个文件名。多数服务不挑扩展名，但缺文件名会被某些网关拒掉。 */
export function audioFileName(mime: string): string {
  const type = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  const extension =
    { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3' }[type] ??
    'webm';
  return `speech.${extension}`;
}

/** 把 HTTP 状态翻译成用户能行动的一句话，而不是「转写失败」。 */
export function sttErrorText(status: number): string {
  if (status === 0) return '网络没通，检查一下代理或防火墙。';
  if (status === 401 || status === 403) return 'Key 不对，或者已经在硅基流动后台删掉了。';
  if (status === 413) return '这段音频太大，说短一点。';
  if (status === 429) return '免费模型被限流了，等一分钟再试。';
  if (status === 503 || status === 504) return '对方服务忙，稍等一下再试。';
  return `转写失败（HTTP ${status}）。`;
}

/**
 * 拼进提示词的一行说明。
 *
 * 只在真正能转写时才提。没开还提「他可能在用语音」，模型就会自己编
 * 「我听到你说」——和摄像头那条同一个坑。
 */
export function sttPrompt(config: SttConfig, hasKey: boolean): string {
  if (sttStatusOf(config, hasKey) !== 'ready') return '';
  return [
    '==== 他可能是说出来的 ====',
    '他有时会按住麦克风说话，转成文字再发给你：没有标点，可能有同音错字。',
    '按意思理解，不要纠正他的字词，也不要复述他刚说的话。',
  ].join('\n');
}
