/**
 * 耳朵与眼睛（纯领域）。
 *
 * 这里定义的是「芯伴能感知到什么」，而不是「它能录制什么」。两条硬约束：
 *
 * 1. **麦克风只算音量**：RMS 包络，不转文字、不录音、不落盘。
 * 2. **摄像头只算帧差**：64×48 降采样后比一帧的差异，画面不出渲染进程内存，
 *    不截图、不写入磁盘、不上传。
 *
 * 因此对外只暴露三样读数：音量、有没有人在动、环境亮不亮。
 * 这不是权限提示词的自我约束，而是数据结构本身就没有承载画面的字段。
 */

/** 三个开关各管一件事：说话、听、看。默认全关，由用户逐个打开。 */
export interface SensesConfig {
  /** 用系统语音把回复念出来。 */
  voice: boolean;
  /** 麦克风：只知道「有没有声音」，不知道说了什么。 */
  ears: boolean;
  /** 摄像头：只知道「画面里有没有人在动」，不知道长什么样。 */
  eyes: boolean;
}

export const defaultSenses: SensesConfig = { voice: false, ears: false, eyes: false };

/** 通道状态。`denied` 与 `error` 要分开：前者要用户去系统设置里改，后者过一会儿重试可能就好。 */
export type SenseChannel = 'off' | 'starting' | 'live' | 'denied' | 'error';

export interface SensesReading {
  mic: SenseChannel;
  camera: SenseChannel;
  /** 0~1 的 RMS 音量，已做压缩；不是分贝，只用于「有没有在说话」。 */
  level: number;
  speaking: boolean;
  /** 摄像头画面里最近有没有动静（走动、招手、抬头）。 */
  present: boolean;
  /** 最近一次读到动静的本机时间；从未读到为 0。 */
  lastMotionAt: number;
  /** 打开失败的原因；空串表示没有错误。 */
  error: string;
  /** 读数时间。过期读数不能拿来回答「我现在在不在」。 */
  at: number;
}

export function emptyReading(): SensesReading {
  return {
    mic: 'off',
    camera: 'off',
    level: 0,
    speaking: false,
    present: false,
    lastMotionAt: 0,
    error: '',
    at: 0,
  };
}

/** 主进程持有的完整状态：配置 + 最近一次读数。 */
export interface SensesSnapshot {
  config: SensesConfig;
  reading: SensesReading;
}

export function emptySenses(): SensesSnapshot {
  return { config: { ...defaultSenses }, reading: emptyReading() };
}

export const senseTuning = {
  /** 开口阈值：超过它算开始说话。 */
  speakOn: 0.08,
  /** 收声阈值比开口低一半：卡在边界上时会一秒抖十次，界面像坏了。 */
  speakOff: 0.035,
  /** 帧差均值（0~1）超过它算「画面里有人动」。 */
  motionPresent: 0.0035,
  /** 多久没有动静算「人不在」。两分钟足够覆盖「坐着不动看屏幕」。 */
  awayAfterMs: 120_000,
  /** 读数多久算过期：超过就不回答「他现在在不在」。 */
  staleAfterMs: 8_000,
  /** 一段回复最多念多少字。念完一屏是朗读，不是聊天。 */
  speechChars: 140,
  /** 渲染进程上报的最小间隔，避免每秒几十条 IPC。 */
  reportIntervalMs: 800,
} as const;

/** 收口配置：磁盘被手改、旧版本缺字段、前端传错类型，一律当作没开。 */
export function normalizeSenses(raw: unknown): SensesConfig {
  if (typeof raw !== 'object' || raw === null) return { ...defaultSenses };
  const record = raw as Record<string, unknown>;
  const flag = (key: keyof SensesConfig): boolean => record[key] === true;
  return { voice: flag('voice'), ears: flag('ears'), eyes: flag('eyes') };
}

/**
 * 开口判定带迟滞：起说用高阈值、收声用低阈值。
 * 没有迟滞的话，普通呼吸声就会让「正在说话」疯狂闪烁。
 */
export function speakingFromLevel(level: number, wasSpeaking: boolean): boolean {
  if (!Number.isFinite(level)) return false;
  const value = Math.min(1, Math.max(0, level));
  return value >= (wasSpeaking ? senseTuning.speakOff : senseTuning.speakOn);
}

/** 更新「最后一次读到动静」的时刻；静止的帧不刷新，人才会真的「走开」。 */
export function trackMotion(lastMotionAt: number, motion: number, at: number): number {
  if (!Number.isFinite(motion) || motion < senseTuning.motionPresent) return lastMotionAt;
  return Math.max(lastMotionAt, at);
}

/** 有人吗？——只在摄像头开着、读数新鲜、且最近有动静时回答「有」。 */
export function presentFrom(
  lastMotionAt: number,
  now: number,
  cameraOn: boolean,
  awayAfterMs: number = senseTuning.awayAfterMs,
): boolean {
  if (!cameraOn || lastMotionAt <= 0) return false;
  return now - lastMotionAt < awayAfterMs;
}

/**
 * 渲染进程上报的读数：不可信输入一律夹到合法范围。
 * 这是 IPC 边界，不能假设对面传的是干净数字。
 */
export function normalizeReading(raw: unknown, now: number): SensesReading {
  if (typeof raw !== 'object' || raw === null) return { ...emptyReading(), at: now };
  const record = raw as Record<string, unknown>;
  const channel = (value: unknown): SenseChannel =>
    value === 'off' ||
    value === 'starting' ||
    value === 'live' ||
    value === 'denied' ||
    value === 'error'
      ? value
      : 'off';
  const number = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const stamp = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  return {
    mic: channel(record['mic']),
    camera: channel(record['camera']),
    level: number(record['level']),
    speaking: record['speaking'] === true,
    present: record['present'] === true,
    lastMotionAt: stamp(record['lastMotionAt']),
    error: typeof record['error'] === 'string' ? record['error'].slice(0, 80) : '',
    at: stamp(record['at']) || now,
  };
}

const channelLabels: Record<SenseChannel, string> = {
  off: '没开',
  starting: '正在打开',
  live: '开着',
  denied: '被系统拒绝',
  error: '打不开',
};

/** 面板与工具输出共用同一套说法，避免「被拒绝」在一处写成「不可用」。 */
export function channelLabel(channel: SenseChannel): string {
  return channelLabels[channel];
}

/** 读数是否还能用来回答问题。太旧的数据只说明「刚才」，不说明「现在」。 */
export function readingFresh(reading: SensesReading, now: number): boolean {
  return reading.at > 0 && now - reading.at < senseTuning.staleAfterMs;
}

/**
 * 拼进提示词的一行环境读数。
 *
 * 只写它真知道的事。没开的通道干脆不提——提了模型就会忍不住编，
 * 「摄像头没开」被写成「我看到你在」是这条链路最坏的失败方式。
 */
export function sensesPrompt(snapshot: SensesSnapshot, now: number): string {
  const { config, reading } = snapshot;
  if (!config.ears && !config.eyes) return '';
  const lines: string[] = [];
  if (config.ears) {
    if (reading.mic === 'live') {
      lines.push(
        reading.speaking
          ? '麦克风开着：他正在出声（你只知道音量，不知道内容）。'
          : '麦克风开着：此刻没有声音。',
      );
    } else {
      lines.push(`麦克风${channelLabels[reading.mic]}。`);
    }
  }
  if (config.eyes) {
    if (reading.camera !== 'live' || !readingFresh(reading, now)) {
      lines.push(
        `摄像头${reading.camera === 'live' ? '还没拿到画面' : channelLabels[reading.camera]}。`,
      );
    } else if (presentFrom(reading.lastMotionAt, now, true)) {
      lines.push('摄像头开着：画面里有人在动。');
    } else if (reading.lastMotionAt > 0) {
      lines.push('摄像头开着：有一阵子没看到人动了。');
    } else {
      lines.push('摄像头开着：画面里很安静。');
    }
  }
  return `==== 你现在能感知到的（本机读数，不是用户说的话）====\n${lines.join('\n')}`;
}

/** 工具 senses 的输出、以及面板上那一行状态。比注入版更细，带上错误原因。 */
export function sensesText(snapshot: SensesSnapshot, now: number): string {
  const { config, reading } = snapshot;
  if (!config.ears && !config.eyes) {
    return '耳朵和眼睛都是关的。你只知道时间、待办和本机工作进度，听不见也看不见。';
  }
  const lines: string[] = [];
  lines.push(
    config.ears
      ? `麦克风：${channelLabels[reading.mic]}${reading.mic === 'live' ? `，音量 ${reading.level.toFixed(2)}，${reading.speaking ? '他正在说话' : '没有声音'}` : ''}（只听音量，不转文字、不录音）`
      : '麦克风：没开',
  );
  if (config.eyes) {
    const head = `摄像头：${channelLabels[reading.camera]}（只看有没有人动，画面不保存、不上传）`;
    if (reading.camera === 'live' && readingFresh(reading, now)) {
      const ago = reading.lastMotionAt > 0 ? Math.round((now - reading.lastMotionAt) / 1000) : -1;
      lines.push(
        `${head}；${presentFrom(reading.lastMotionAt, now, true) ? '画面里有人' : '有一阵子没动静'}${
          ago >= 0 ? `，最近一次动在 ${ago} 秒前` : ''
        }`,
      );
    } else {
      lines.push(head);
    }
  } else {
    lines.push('摄像头：没开');
  }
  if (reading.error !== '') lines.push(`最近一次失败：${reading.error}`);
  if (!readingFresh(reading, now)) lines.push('注意：读数已经过期，别当成此刻的情况。');
  return lines.join('\n');
}

/**
 * 把一段回复变成「念出来顺耳」的口语文本。
 *
 * 屏幕上的排版符号到了语音里全是噪音：星号被念成「星号星号」，
 * 链接会被逐字拼读。代码块整体丢掉——念代码没有意义，念一句「我写了段代码」就够。
 */
export function speechText(answer: string, max: number = senseTuning.speechChars): string {
  let text = answer
    // 代码块整段丢掉，但保留一句交代。
    .replace(/```[\s\S]*?```/g, '（代码略）')
    // 行内代码只留内容，反引号不念。
    .replace(/`([^`]*)`/g, '$1')
    // Markdown 链接留文字、丢地址。
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 裸链接直接删：念出来没人听得懂。
    .replace(/https?:\/\/\S+/g, '')
    // 标题井号、列表符号、引用符号、加粗斜体标记。
    .replace(/^[ \t]*[#>*-]+[ \t]*/gm, '')
    .replace(/[*_]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('；'),
    head.lastIndexOf('，'),
  );
  text = cut >= max / 3 ? head.slice(0, cut + 1) : head;
  return `${text.replace(/[，、；：]$/, '')}…`;
}
