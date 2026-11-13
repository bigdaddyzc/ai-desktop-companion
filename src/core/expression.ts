/**
 * 表情（纯领域）。
 *
 * 屏幕只有 216px，画不下写实的脸，只能靠「眼型 + 嘴型 + 一个小符号」表达状态。
 * 之前的状态判断散在渲染层的三元表达式里，结果是：开心、睡着、专注三种，
 * 剩下的情绪全靠同一张竖眼脸——用户看到的确实是「只有一种表情」。
 *
 * 这里把它收成一张查表：信号进、脸谱出，渲染层只负责画。
 * 好处有三：优先级只有一处、单测能锁住「它在想事时不该笑」这种规则、
 * 新增情绪不用再动 JSX。
 */

import type { DisplayMood } from './state';

/** 眼型。同一个 mood 在不同情境下也要换眼，所以眼型比 mood 更细。 */
export type EyeShape =
  /** 平时的竖眼 */
  | 'open'
  /** 弯成月牙，笑 */
  | 'happy'
  /** 一条线，睡着或走神 */
  | 'closed'
  /** 压扁，专注 */
  | 'narrow'
  /** 圆睁，惊讶或认真听 */
  | 'wide'
  /** 一高一低，疑惑 */
  | 'side';

export type MouthShape = 'smile' | 'grin' | 'frown' | 'flat' | 'o' | 'tiny';

/** 右上角那个小符号。它是表情的一部分，不是装饰。 */
export type FaceExtra = 'none' | 'zzz' | 'question' | 'sweat' | 'heart' | 'think' | 'note';

/** 眉毛。小屏上只有几像素，但它决定了同一双眼是「专注」还是「生气」。 */
export type BrowShape = 'none' | 'sad' | 'raised' | 'flat';

export interface FaceSpec {
  eyes: EyeShape;
  brows: BrowShape;
  mouth: MouthShape;
  extra: FaceExtra;
  /** 腮红浓度 0–1。用不透明度表达，不额外引入颜色。 */
  blush: number;
  /** 这张脸的一句话说明，给读屏用户。 */
  label: string;
  /** 在表情目录里的名字；面板按它预览、开关。 */
  key: FaceKey;
}

export type FaceKey =
  | 'away'
  | 'sleep'
  | 'speaking'
  | 'listening'
  | 'thinking'
  | 'playing'
  | 'happy'
  | 'waiting'
  | 'sad'
  | 'busy'
  | 'focus'
  | 'idle';

/** 全部表情，顺序即优先级（面板也按这个顺序展示）。 */
export const faceCatalog: Readonly<Record<FaceKey, FaceSpec>> = {
  away: {
    key: 'away',
    eyes: 'closed',
    brows: 'none',
    mouth: 'tiny',
    extra: 'zzz',
    blush: 0,
    label: '走神',
  },
  sleep: {
    key: 'sleep',
    eyes: 'closed',
    brows: 'none',
    mouth: 'tiny',
    extra: 'zzz',
    blush: 0,
    label: '睡着',
  },
  speaking: {
    key: 'speaking',
    eyes: 'happy',
    brows: 'none',
    mouth: 'smile',
    extra: 'none',
    blush: 0.45,
    label: '在说话',
  },
  listening: {
    key: 'listening',
    eyes: 'wide',
    brows: 'none',
    mouth: 'smile',
    extra: 'none',
    blush: 0.5,
    label: '在听你说',
  },
  thinking: {
    key: 'thinking',
    eyes: 'open',
    brows: 'raised',
    mouth: 'tiny',
    extra: 'think',
    blush: 0.2,
    label: '在想办法',
  },
  playing: {
    key: 'playing',
    eyes: 'wide',
    brows: 'raised',
    mouth: 'o',
    extra: 'none',
    blush: 0.3,
    label: '在玩',
  },
  happy: {
    key: 'happy',
    eyes: 'happy',
    brows: 'none',
    mouth: 'grin',
    extra: 'heart',
    blush: 0.75,
    label: '开心',
  },
  waiting: {
    key: 'waiting',
    eyes: 'side',
    brows: 'raised',
    mouth: 'o',
    extra: 'question',
    blush: 0.2,
    label: '在等你',
  },
  sad: {
    key: 'sad',
    eyes: 'open',
    brows: 'sad',
    mouth: 'frown',
    extra: 'sweat',
    blush: 0.1,
    label: '有点担心',
  },
  busy: {
    key: 'busy',
    eyes: 'narrow',
    brows: 'flat',
    mouth: 'flat',
    extra: 'think',
    blush: 0.2,
    label: '忙着',
  },
  // 不给眉毛：内高外低的眉配平嘴会读成「生气」，而专注该是平静的。
  focus: {
    key: 'focus',
    eyes: 'narrow',
    brows: 'none',
    mouth: 'flat',
    extra: 'none',
    blush: 0.25,
    label: '专注',
  },
  idle: {
    key: 'idle',
    eyes: 'open',
    brows: 'none',
    mouth: 'smile',
    extra: 'none',
    blush: 0.3,
    label: '安静',
  },
};

export const faceKeys = Object.keys(faceCatalog) as FaceKey[];

/** 什么时候出现：面板预览下面的小字。 */
export const faceWhen: Readonly<Record<FaceKey, string>> = {
  away: '摄像头开着但看不到你',
  sleep: '连接断开',
  speaking: '它在念回复',
  listening: '你在对它说话',
  thinking: '它在想、在调工具',
  playing: '在玩小游戏',
  happy: '完成、被摸摸、聊得开心、派的活干完',
  waiting: '等你确认、它在问你',
  sad: '任务失败、你不开心、派的活没成',
  busy: '有任务在跑、派的活在干',
  focus: '专注计时中',
  idle: '平时',
};

/** 画风：同一张脸谱的三种画法。 */
export type FaceStyle = 'classic' | 'round' | 'pixel';
export const faceStyles: readonly { value: FaceStyle; label: string }[] = [
  { value: 'classic', label: '经典（竖眼）' },
  { value: 'round', label: '圆眼豆豆' },
  { value: 'pixel', label: '像素屏' },
];

/** 表情偏好：存在性格配置里，两个窗口都读。 */
export interface FacePrefs {
  style: FaceStyle;
  /** 不想看到的表情：本该切到它时停在「安静」。 */
  off: FaceKey[];
  /** 表情跟着聊天情绪走。 */
  followChat: boolean;
}

export const defaultFacePrefs: FacePrefs = { style: 'classic', off: [], followChat: true };

export function normalizeFacePrefs(raw: unknown): FacePrefs {
  if (typeof raw !== 'object' || raw === null) return { ...defaultFacePrefs, off: [] };
  const record = raw as Record<string, unknown>;
  const style = faceStyles.some((item) => item.value === record['style'])
    ? (record['style'] as FaceStyle)
    : defaultFacePrefs.style;
  const off = Array.isArray(record['off'])
    ? [...new Set(record['off'].filter((key): key is FaceKey => faceKeys.includes(key as FaceKey)))]
        // 「安静」是兜底，关不掉。
        .filter((key) => key !== 'idle')
    : [];
  const followChat =
    typeof record['followChat'] === 'boolean' ? record['followChat'] : defaultFacePrefs.followChat;
  return { style, off, followChat };
}

export interface FaceSignals {
  mood: DisplayMood;
  /** 正在想事或正在调工具。它比 mood 更能说明「此刻在干什么」。 */
  thinking?: boolean;
  /** 它在念回复。 */
  speaking?: boolean;
  /** 用户在说话。 */
  listening?: boolean;
  /** 摄像头开着但看不到人。 */
  away?: boolean;
  /** 正在玩游戏。 */
  playing?: boolean;
  /** 后台有派出去的活在干。 */
  working?: boolean;
  /** 刚才那句聊天/刚干完的活带出来的情绪，几秒后过去。 */
  feeling?: ChatFeeling | null;
}

export type ChatFeeling = 'happy' | 'sad' | 'waiting';

/**
 * 信号 → 表情名。
 *
 * 优先级是刻意排的，从上到下依次覆盖：
 * 1. 看不到人 / 睡着：这两种状态下它不该有任何「活着」的表情；
 * 2. 说话 / 听你说：嘴要动，眼睛要看着你；
 * 3. 想事 / 在玩：任务跑着、屏幕却一片平静不行；
 * 4. mood 不是平时（等确认、失败、计时……）时听 mood 的；
 * 5. 平时状态下：刚聊出来的情绪 > 后台派活 > 安静。
 */
export function faceKeyOf(signals: FaceSignals): FaceKey {
  const { mood, thinking, speaking, listening, away, playing, working, feeling } = signals;
  if (away === true) return 'away';
  if (mood === 'sleep') return 'sleep';
  if (speaking === true) return 'speaking';
  if (listening === true) return 'listening';
  if (thinking === true) return 'thinking';
  if (playing === true) return 'playing';
  if (mood !== 'idle') return mood;
  if (feeling) return feeling;
  if (working === true) return 'busy';
  return 'idle';
}

/** 信号 → 脸谱；在「不想看到」里的一律停在「安静」。 */
export function faceOf(signals: FaceSignals, off: readonly FaceKey[] = []): FaceSpec {
  const key = faceKeyOf(signals);
  return faceCatalog[off.includes(key) ? 'idle' : key];
}

const sadWords =
  /难过|伤心|崩溃|好累|太累|烦死|好烦|焦虑|压力大|想哭|哭了|失眠|生病|不舒服|失败了|搞砸|被骂|分手|去世|遗憾|抱歉|心疼|别难过|辛苦了|😭|😢/;
const happyWords =
  /哈哈|太好了|开心|高兴|恭喜|太棒|真棒|搞定了|成功了|通过了|谢谢|喜欢|爱你|厉害|终于|🎉|😄|😂|❤/;

/**
 * 从一问一答里猜情绪：本地关键词，不多花一次模型调用。
 * 你说的话优先（你难过时它就算安慰得很暖也该是担心的脸），再看它的回答；
 * 回答以问号结尾就是在等你接话。猜不出就是 null，保持平时的脸。
 */
export function chatFeeling(question: string, answer: string): ChatFeeling | null {
  if (sadWords.test(question)) return 'sad';
  if (happyWords.test(question)) return 'happy';
  if (sadWords.test(answer)) return 'sad';
  if (happyWords.test(answer)) return 'happy';
  if (/[?？]\s*$/.test(answer.trim())) return 'waiting';
  return null;
}

/** 派出去的活交回来的那条消息 → 情绪。 */
export function jobFeeling(text: string): ChatFeeling | null {
  if (text.startsWith('✅')) return 'happy';
  if (text.startsWith('⚠')) return 'sad';
  return null;
}

/** 情绪挂在脸上多久。 */
export const feelingMs = 12_000;
/**
 * 嘴张多大（0–1）。
 *
 * 听你说：跟着音量走，这是唯一真实的信号；
 * 它在说：没有音量包络可用（音频在 `<audio>` 里，拿不到波形），
 * 给一个固定基准，由 CSS 动画去做开合——比让嘴一动不动强。
 */
export function mouthOpenOf(signals: {
  listening: boolean;
  speaking: boolean;
  level?: number;
}): number {
  if (signals.listening) return Math.max(0.12, Math.min(1, (signals.level ?? 0) * 2.4));
  if (signals.speaking) return 0.34;
  return 0;
}
