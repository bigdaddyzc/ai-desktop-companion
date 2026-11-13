/**
 * 云端语音合成（纯领域）。
 *
 * 为什么要有这一层：系统 `speechSynthesis` 在 Windows 上只有那几把老嗓子，
 * 念中文是「一个词一个词往外蹦」，怎么调语速音调都救不回来。更麻烦的是它在
 * Chromium 里会被后台节流——窗口一失焦就念两个字停下，这个坑不在我们手里。
 *
 * 所以真正的「像人说话」走云端：硅基流动的 CosyVoice2，一次请求换回一段 mp3，
 * 用 `<audio>` 播。这条路的好处不只是音色：
 *
 * 1. 播放由我们控制，`ended` 就是真的念完了，不会有「念一半静音」；
 * 2. 长句不会被引擎自己截断，也没有 15 秒上限；
 * 3. 音色、语速、音量都是请求参数，改了立刻生效。
 *
 * 边界照旧：Key 只在主进程解密，文本出本机、音频不落盘。
 * 系统语音保留为**离线兜底**——断网、没填 Key、额度用完时，总得有声音。
 */

/** 一段合成请求的长度上限。太长会让首字延迟变高，也会放大失败重试的代价。 */
export const ttsLimits = {
  inputChars: 600,
  /** 语速。和系统语音那边保持同一个区间，换引擎时手感不会突变。 */
  speed: { min: 0.6, max: 1.8 },
  /** 音量增益，dB。±6 够用了，再多会削波。 */
  gain: { min: -6, max: 6 },
  timeoutMs: 45_000,
} as const;

export const ttsDefaults = {
  /** 和语音转写同一家、同一把 Key：一个账号两件事，用户不用填两次。 */
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'FunAudioLLM/CosyVoice2-0.5B',
  /** 只在局域网/测试里放开；生产白名单见 `ttsAllowedHosts`。 */
  responseFormat: 'mp3',
} as const;

/** 生产环境唯一允许的合成主机。 */
export const ttsAllowedHosts = ['api.siliconflow.cn'] as const;

/**
 * 预置音色。
 *
 * 名字保留英文，是因为它就是要拼进 `voice` 参数的那个 id，
 * 中文名只做说明——把「claire」写成「克莱尔」再让人对着 API 找，
 * 只会多一层翻译错误。
 */
export interface CloudVoice {
  id: string;
  /** 中文说明：这句是给人挑嗓子看的。 */
  label: string;
  /** 说清它听起来是什么样，别堆形容词。 */
  desc: string;
}

export const cloudVoices: readonly CloudVoice[] = [
  { id: 'diana', label: 'diana', desc: '欢快女声，尾音上扬' },
  { id: 'claire', label: 'claire', desc: '温柔女声，气声自然' },
  { id: 'anna', label: 'anna', desc: '沉稳女声，像播报' },
  { id: 'bella', label: 'bella', desc: '热情女声，起伏大' },
  { id: 'alex', label: 'alex', desc: '沉稳男声，句子结尾会落下来' },
  { id: 'benjamin', label: 'benjamin', desc: '低沉男声，慢条斯理' },
  { id: 'charles', label: 'charles', desc: '磁性男声，中低音稳' },
  { id: 'david', label: 'david', desc: '轻快男声，像在聊天' },
];

export const cloudVoiceIds = cloudVoices.map((voice) => voice.id);

/** 默认音色：diana 的起伏最明显，一耳朵就能听出和系统语音的差别。 */
export const defaultCloudVoice = 'diana';

export function cloudVoiceOf(id: string): CloudVoice {
  return cloudVoices.find((voice) => voice.id === id) ?? cloudVoices[0]!;
}

/** 拼成 API 要的 `voice` 字段：模型名 + 冒号 + 音色 id。 */
export function cloudVoiceParam(id: string): string {
  return `${ttsDefaults.model}:${cloudVoiceOf(id).id}`;
}

/** 合成端点。和转写一样按 origin 拼，避免用户填了 `/v1` 变成 `/v1/v1/...`。 */
export function ttsEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.origin}/v1/audio/speech`;
}

/** 可用性只有两档：有 Key 就能用，没有就退回系统语音。 */
export type TtsStatus = 'no-key' | 'ready';

export interface TtsSnapshot {
  status: TtsStatus;
  /** 只回模型名，不回 Key，连前几位都不给。 */
  model: string;
  /** 最近一次失败的原因；空串表示最近一次是成功的。 */
  lastError: string;
  /** 最近一次成功合成的时间；从未成功为 0。 */
  lastAt: number;
}

export function emptyTtsSnapshot(): TtsSnapshot {
  return { status: 'no-key', model: ttsDefaults.model, lastError: '', lastAt: 0 };
}

/** 把文本收成「值得合成的样子」：空白折叠、长度截断。 */
export function speakable(text: string, max: number = ttsLimits.inputChars): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

/**
 * HTTP 状态翻译成用户能行动的一句话。
 *
 * 401/403 要同时提醒「这和填字的是同一把 Key」——用户很容易以为语音是另一套账号。
 */
export function ttsErrorText(status: number): string {
  if (status === 0) return '网络没通，先用系统语音顶着。';
  if (status === 401 || status === 403)
    return '硅基流动的 Key 不对或已失效，去「听懂你说话」那栏重填。';
  if (status === 402) return '额度用完了，去硅基流动后台充值，或切回系统语音。';
  if (status === 429) return '合成太频繁，被限流了，等几秒再试。';
  if (status === 503 || status === 504) return '对方服务忙，先用系统语音。';
  return `合成失败（HTTP ${status}）。`;
}

/** 归一化音色 id：不在列表里的一律回到默认。 */
export function normalizeCloudVoice(raw: unknown): string {
  return typeof raw === 'string' && cloudVoiceIds.includes(raw) ? raw : defaultCloudVoice;
}

/** 归一化语速/音量：越界夹住，NaN 回默认。 */
export function normalizeSpeed(raw: unknown, fallback = 1): number {
  return clampNumber(raw, fallback, ttsLimits.speed.min, ttsLimits.speed.max);
}

export function normalizeGain(raw: unknown, fallback = 0): number {
  return clampNumber(raw, fallback, ttsLimits.gain.min, ttsLimits.gain.max);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100;
}

/** 面板上那行说明：说清现在用的是哪把嗓子。 */
export function cloudVoiceLabel(id: string, speed: number): string {
  return `${cloudVoiceOf(id).label} · ${speed.toFixed(2)}×`;
}
