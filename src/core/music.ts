import { z } from 'zod';

/**
 * 音乐：控制你电脑上已经在用的音乐平台客户端（网易云、QQ 音乐、酷狗、Spotify……）。
 *
 * 为什么不直接接平台接口：国内音乐平台没有给个人开发者的公开播放接口，
 * 民间接口有版权与封号风险。Windows 的系统媒体控制（和键盘上的播放键、音量浮窗是同一套）
 * 是公开的：客户端自己把「正在放什么」报给系统，芯伴从系统读、也通过系统发「下一首」。
 * 你的会员、歌单、推荐都留在客户端里，芯伴只是伸手帮你按一下。
 *
 * 本文件是纯逻辑：解析桥接进程的输出、认客户端、拼一句话。
 */

export type MusicCommand = 'state' | 'toggle' | 'next' | 'prev';

export type PlaybackStatus = 'playing' | 'paused' | 'stopped';

export interface NowPlaying {
  /** 系统给的应用标识（AUMID 或 exe 名）。 */
  app: string;
  /** 认得出的中文名，认不出就用标识里最像名字的一段。 */
  appLabel: string;
  title: string;
  artist: string;
  status: PlaybackStatus;
}

export interface MusicSnapshot {
  /** 系统媒体控制能不能用（非 Windows、PowerShell 缺失时为 false）。 */
  available: boolean;
  nowPlaying: NowPlaying | null;
  error: string;
  updatedAt: number;
}

export const emptyMusic = (available = true): MusicSnapshot => ({
  available,
  nowPlaying: null,
  error: '',
  updatedAt: 0,
});

export const musicLimits = {
  /** 标题、歌手上限：这些是外部内容，进小屏和模型前都要截。 */
  textChars: 80,
  /** 桥接进程单次应答的等待上限。首次启动 PowerShell 要一两秒，给足余量。 */
  replyMs: 8_000,
  /** 正在放时多久刷新一次「正在放什么」。 */
  pollMs: 5_000,
  /** 连续这么久没有任何播放器，就把轮询放慢到 idlePollMs。 */
  idleStopMs: 2 * 60_000,
  idlePollMs: 60_000,
} as const;

/** 常见客户端。匹配的是 AUMID / exe 名里的片段，大小写不敏感。 */
const knownApps: [RegExp, string][] = [
  [/cloudmusic|netease/i, '网易云音乐'],
  [/qqmusic/i, 'QQ 音乐'],
  [/kugou/i, '酷狗音乐'],
  [/kwmusic|kuwo/i, '酷我音乐'],
  [/spotify/i, 'Spotify'],
  [/applemusic|itunes/i, 'Apple Music'],
  [/zunemusic|music\.ui|media\.player/i, 'Windows 媒体播放器'],
  [/foobar/i, 'foobar2000'],
  [/potplayer/i, 'PotPlayer'],
  [/chrome/i, 'Chrome 浏览器'],
  [/msedge/i, 'Edge 浏览器'],
  [/firefox/i, 'Firefox 浏览器'],
];

export function appLabelOf(app: string): string {
  for (const [pattern, label] of knownApps) if (pattern.test(app)) return label;
  const tail =
    app
      .split(/[\\/!]/)
      .filter((part) => part !== '')
      .pop() ?? '';
  return tail.replace(/\.exe$/i, '') || '播放器';
}

function clean(text: string): string {
  // 外部文本：去控制字符、压空白、截断。
  const flat = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= musicLimits.textChars
    ? flat
    : `${flat.slice(0, musicLimits.textChars - 1)}…`;
}

const sessionSchema = z.object({
  app: z.string().max(400),
  status: z.string().max(40),
  title: z.string().max(2_000).nullish(),
  artist: z.string().max(2_000).nullish(),
});

export const bridgeReplySchema = z.object({
  id: z.string().max(40),
  ok: z.boolean(),
  error: z.string().max(400).optional(),
  via: z.enum(['session', 'key']).optional(),
  session: sessionSchema.nullish(),
});
export type BridgeReply = z.infer<typeof bridgeReplySchema>;

/** 系统枚举 Playing/Paused/Stopped/Closed/Opened/Changing → 三态。 */
export function playbackOf(raw: string): PlaybackStatus {
  if (/^playing$/i.test(raw) || raw === '4') return 'playing';
  if (/^paused$/i.test(raw) || raw === '5') return 'paused';
  return 'stopped';
}

export function nowPlayingOf(reply: BridgeReply): NowPlaying | null {
  const session = reply.session;
  if (!session) return null;
  return {
    app: session.app,
    appLabel: appLabelOf(session.app),
    title: clean(session.title ?? ''),
    artist: clean(session.artist ?? ''),
    status: playbackOf(session.status),
  };
}

/** 小屏与提示词共用的一行：♪ 晴天 · 周杰伦。 */
export function musicLine(now: NowPlaying | null): string {
  if (!now || now.title === '') return '';
  return now.artist === '' ? `♪ ${now.title}` : `♪ ${now.title} · ${now.artist}`;
}

export const musicToolInputSchema = z
  .object({ action: z.enum(['play_pause', 'next', 'previous', 'now_playing']) })
  .strict();
export type MusicToolAction = z.infer<typeof musicToolInputSchema>['action'];

export const toolCommand: Record<MusicToolAction, MusicCommand> = {
  play_pause: 'toggle',
  next: 'next',
  previous: 'prev',
  now_playing: 'state',
};

/** 给模型的结果说明（歌名由调用方包一层不可信标记）。 */
export function describeNowPlaying(now: NowPlaying | null): string {
  if (!now) return '电脑上现在没有音乐客户端在报告播放状态。';
  const state = now.status === 'playing' ? '正在放' : now.status === 'paused' ? '暂停在' : '停在';
  const song = now.title === '' ? '（没报歌名）' : musicLine(now).slice(2);
  return `${now.appLabel} ${state}：${song}`;
}
