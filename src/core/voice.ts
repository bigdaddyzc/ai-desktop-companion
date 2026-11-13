/**
 * 语音包（纯领域）。
 *
 * 这里说的「语音包」不打包音色文件，只打包**怎么念**：用哪把嗓子、多快、多高。
 *
 * 两把嗓子，各管一段场景：
 *
 * - `cloud`：硅基流动的 CosyVoice2，真人在播客里说话那种起伏。需要 Key、需要联网，
 *   延迟多一到两秒，但**这是唯一能听出情绪的路**——系统的 SAPI 嗓子怎么调
 *   都是逐词蹦字，调语速音调只改变蹦得快慢。
 * - `system`：操作系统自带的 `speechSynthesis`。零依赖、离线、不花钱，
 *   代价是音色取决于系统装了什么，且 Chromium 会在窗口失焦时偷偷暂停它。
 *
 * 默认走云端，没有 Key 时由播放器自动回落系统语音——宁可声音差一点，也不能没声。
 *
 * 三条不变的行为约束（和 `useVoice` 一致）：
 * 1. 只念**定稿**的回复，流式中间态不念（否则就是结巴）。
 * 2. 用户一开口就停：语音助手最烦的是「你说话它也在说」。
 * 3. 勿扰模式下不出声。
 */

import { cloudVoiceLabel, defaultCloudVoice, normalizeCloudVoice } from './tts';

export type VoicePackId = 'clear' | 'warm' | 'calm' | 'lazy';

/** 嗓子从哪来。`cloud` 要联网、要 Key；`system` 离线但机械。 */
export type VoiceEngine = 'cloud' | 'system';

export interface VoicePack {
  id: VoicePackId;
  name: string;
  /** 一句话说清它听起来是什么样，不要形容词堆砌。 */
  desc: string;
  rate: number;
  pitch: number;
}

/**
 * 四套预设。数值是实测的：`speechSynthesis` 在 Windows 上
 * 低于 0.8 会拖得像卡带，高于 1.2 又会糊成一团，所以都收在这个区间里。
 */
export const voicePacks: readonly VoicePack[] = [
  { id: 'clear', name: '清亮', desc: '正常语速，尾音略扬', rate: 1.06, pitch: 1.08 },
  { id: 'warm', name: '温柔', desc: '慢半拍，声音放软', rate: 0.94, pitch: 1.0 },
  { id: 'calm', name: '沉稳', desc: '再慢一点，低一点', rate: 0.9, pitch: 0.86 },
  { id: 'lazy', name: '慵懒', desc: '慢吞吞，像刚睡醒', rate: 0.84, pitch: 0.92 },
];

export const voicePackOrder = voicePacks.map((pack) => pack.id) as VoicePackId[];

export function voicePackOf(id: VoicePackId): VoicePack {
  return voicePacks.find((pack) => pack.id === id) ?? voicePacks[0]!;
}

export interface VoiceConfig {
  /** 嗓子从哪来。云端失败时播放器会临时回落系统语音，但配置本身不改。 */
  engine: VoiceEngine;
  /** 选中的语音包。它决定下面的 rate/pitch 初值，改滑杆不回写包。 */
  pack: VoicePackId;
  /** 系统语音的 voiceURI；空串表示「自动挑一个中文语音」。 */
  voiceURI: string;
  /** 云端音色 id（`diana`/`alex` 那一类），只在 `engine === 'cloud'` 时有意义。 */
  cloudVoice: string;
  /**
   * 语速。系统语音走 `utterance.rate`，云端走请求里的 `speed`——
   * 两边区间一致，所以换引擎时手感不会突然变。
   */
  rate: number;
  /** 音调。只有系统语音认这个参数，云端忽略（CosyVoice2 没有音调旋钮）。 */
  pitch: number;
}

/** 语速与音调的硬边界。超出这个范围不是「有个性」，是听不清。 */
export const voiceLimits = {
  rate: { min: 0.6, max: 1.8 },
  pitch: { min: 0.5, max: 1.6 },
  voiceUriChars: 300,
} as const;

export function defaultVoice(): VoiceConfig {
  const pack = voicePacks[0]!;
  return {
    engine: 'cloud',
    pack: pack.id,
    voiceURI: '',
    cloudVoice: defaultCloudVoice,
    rate: pack.rate,
    pitch: pack.pitch,
  };
}

/** 面板点某个包：语速音调跟着走，嗓子不动。 */
export function withPack(config: VoiceConfig, pack: VoicePackId): VoiceConfig {
  const next = voicePackOf(pack);
  return { ...config, pack: next.id, rate: next.rate, pitch: next.pitch };
}

/** 面板切嗓子来源：只换来源，别的都留着，切回来还是原来那把。 */
export function withEngine(config: VoiceConfig, engine: VoiceEngine): VoiceConfig {
  return { ...config, engine };
}

/** 数值收口：NaN、Infinity、字符串一律当没填，回到包里的默认值。 */
function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100;
}

export function normalizeVoice(raw: unknown): VoiceConfig {
  const base = defaultVoice();
  if (typeof raw !== 'object' || raw === null) return base;
  const record = raw as Record<string, unknown>;

  const pack = record['pack'];
  const id =
    typeof pack === 'string' && voicePackOrder.includes(pack as VoicePackId)
      ? (pack as VoicePackId)
      : base.pack;
  const preset = voicePackOf(id);

  const uri = record['voiceURI'];
  return {
    engine: record['engine'] === 'system' ? 'system' : 'cloud',
    pack: id,
    voiceURI:
      typeof uri === 'string' ? uri.trim().slice(0, voiceLimits.voiceUriChars) : base.voiceURI,
    cloudVoice: normalizeCloudVoice(record['cloudVoice']),
    rate: clamp(record['rate'], preset.rate, voiceLimits.rate.min, voiceLimits.rate.max),
    pitch: clamp(record['pitch'], preset.pitch, voiceLimits.pitch.min, voiceLimits.pitch.max),
  };
}

/** 面板标题旁那一小行字：说清「现在是什么声音」。 */
export function voiceLabel(config: VoiceConfig): string {
  if (config.engine === 'cloud') return cloudVoiceLabel(config.cloudVoice, config.rate);
  return `${voicePackOf(config.pack).name} · ${config.rate.toFixed(2)}×`;
}

/**
 * 系统语音里挑一个能用的。
 *
 * 优先本地语音：云端语音在断网时不出声，用户会以为功能坏了。
 * 空 uri 表示自动挑；挑不到就返回 null，交给系统默认嗓子。
 */
export function chooseVoice<T extends { voiceURI: string; lang: string; localService: boolean }>(
  voices: readonly T[],
  voiceURI: string,
): T | null {
  const chinese = voices.filter((voice) => voice.lang.toLowerCase().startsWith('zh'));
  const pool = chinese.length > 0 ? chinese : voices;
  if (pool.length === 0) return null;
  if (voiceURI !== '') {
    const exact = pool.find((voice) => voice.voiceURI === voiceURI);
    if (exact) return exact;
  }
  return pool.find((voice) => voice.localService) ?? pool[0]!;
}

/**
 * 流式播报的切块参数。
 *
 * 为什么要「首句短切」：合成是按字数算时间的。等一句 60 字的完整句子合成完再开口，
 * 首字延迟就是一两秒；把第一块切到十来个字，开口时间能砍掉一半以上，
 * 后面的句子在播第一块的时候并行合成，播放中间几乎没有缝。
 */
export const speechStream = {
  /** 首块目标长度：到第一个逗号就切，够一开口就行。 */
  firstChars: 10,
  /** 单块上限：太长会让这一块的合成变慢，也拖长打断的响应。 */
  maxChars: 70,
  /** 整轮最多念多少字。念完一屏是朗读，不是聊天。 */
  totalChars: 6000,
  /** 同时最多排几个合成请求。再多只是把请求堆在对方队列里，不会更快。 */
  inflight: 2,
} as const;

/** 强断点：句末标点，念到这里停最自然。 */
const strongBreaks = '。！？!?；;…\n';
/** 弱断点：只在首块或硬切时用，读起来还是半句，但足够开口。 */
const softBreaks = '，,、：:';

/**
 * 从「到目前为止的完整文本」里切出一块可以单独合成的句子。
 *
 * 返回 `null` 表示「还不够一块」——流式过程中这很常见，等下一个增量再来。
 * 返回的 `rest` 是剩下的部分，调用方要留着，不能丢。
 */
export function takeSpeechSegment(
  text: string,
  first: boolean,
): { segment: string; rest: string } | null {
  if (text.trim() === '') return null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (strongBreaks.includes(char)) {
      // 连续的句末标点一起收（「？！」拆成两块，第二块只剩一个感叹号）。
      let end = index + 1;
      while (end < text.length && strongBreaks.includes(text[end]!)) end += 1;
      while (end < text.length && '”’」』）)'.includes(text[end]!)) end += 1;
      const segment = text.slice(0, end).trim();
      if (segment !== '') return { segment, rest: text.slice(end) };
      continue;
    }
    if (first && index + 1 >= speechStream.firstChars && softBreaks.includes(char)) {
      const segment = text.slice(0, index + 1).trim();
      if (segment !== '') return { segment, rest: text.slice(index + 1) };
      continue;
    }
    if (index + 1 >= speechStream.maxChars) {
      // 一直没有句末标点：往回找一个弱断点，找不到就硬切。
      let cut = -1;
      for (let back = index; back >= Math.max(0, index - 24); back -= 1) {
        if (softBreaks.includes(text[back]!)) {
          cut = back;
          break;
        }
      }
      const end = cut >= 0 ? cut + 1 : index + 1;
      const segment = text.slice(0, end).trim();
      if (segment !== '') return { segment, rest: text.slice(end) };
    }
  }
  return null;
}

/** 断句用的标点。念到这里可以停，听感上也不会断在半句中间。 */
const speechBreaks = ['。', '！', '？', '；', '，', '、', '：', '…'] as const;

/**
 * 把一段话切成适合逐块念的几段。
 *
 * 为什么必须切：Chromium 的 `speechSynthesis` 对整段长文会自己截断，
 * 用户听到的就是「念到一半没了」；而切成短块之后，每块结束都有 `onend`，
 * 队列是连续的，打断也能在半秒内生效。
 *
 * 切点优先落在标点上；找不到足够靠前的标点才硬切——宁可断得不漂亮，
 * 也不能把一句话切得太碎导致语调全散。
 */
export function splitForSpeech(text: string, max: number = 110): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '') return [];
  if (clean.length <= max) return [clean];

  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = -1;
    for (const mark of speechBreaks) {
      const index = head.lastIndexOf(mark);
      if (index > cut) cut = index;
    }
    // 断点太靠前会让这一块短得没头没尾，不如直接按长度切。
    const at = cut >= Math.floor(max / 3) ? cut + 1 : max;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest !== '') chunks.push(rest);
  return chunks.filter((chunk) => chunk !== '');
}
