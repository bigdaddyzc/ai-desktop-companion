import { z } from 'zod';

/**
 * 主动放声音（play_audio）工具的纯领域部分：输入规格与「来源」判定。
 *
 * 这一层不碰文件系统、Electron 与网络：它只把来源分成本地相对路径或 http(s) 链接，
 * 并挡掉绝对路径、盘符、其它协议等写法。路径是否真的落在允许的目录之内、
 * 真实路径有没有经符号链接／junction 逃逸，由 desktop/audio.ts 结合白名单目录再查一遍。
 */

export const audioLimits = {
  /** source 字符串上限，避免把一大段 base64 或畸形 URL 塞进参数。 */
  maxSourceChars: 2_048,
  /** 默认音量，0~1。 */
  defaultVolume: 1,
} as const;

export const playAudioInputSchema = z
  .object({
    source: z.string().trim().min(1).max(audioLimits.maxSourceChars),
    volume: z.number().min(0).max(1).optional(),
  })
  .strict();
export type PlayAudioInput = z.infer<typeof playAudioInputSchema>;

export type AudioSourceSpec = { kind: 'url'; url: string } | { kind: 'file'; relativePath: string };

/** Windows 保留设备名：拿它当文件名会写到设备上，或生成删不掉的文件。 */
const deviceName = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * 把来源归类并做字符串级校验。
 *
 * - 带 `://` 的一律按链接处理，只认 http / https；
 * - 本地文件只能是相对路径，拒绝盘符、绝对路径、NTFS 流、短名、设备名与 `..`；
 * - 不做「在哪个目录里」的判断，那是 desktop 层的职责。
 */
export function classifyAudioSource(
  raw: string,
): { ok: true; value: AudioSourceSpec } | { ok: false; error: string } {
  const source = raw.trim();
  if (source === '' || source.length > audioLimits.maxSourceChars) {
    return { ok: false, error: '音频来源为空或过长。' };
  }
  if (/[\0-\x1f\x7f]/.test(source)) return { ok: false, error: '来源包含非法控制字符。' };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    if (!/^https?:\/\//i.test(source)) {
      return { ok: false, error: '只支持 http 或 https 音频链接，不接受 file: 等本地协议。' };
    }
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      return { ok: false, error: '音频链接格式不正确。' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: '只支持 http 或 https 音频链接。' };
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return { ok: false, error: '音频链接不能带账号或密码。' };
    }
    if (parsed.hostname === '') return { ok: false, error: '音频链接缺少主机名。' };
    return { ok: true, value: { kind: 'url', url: source } };
  }

  // 没带 :// 却带冒号：盘符 C:、NTFS 流 a.mp3:$DATA、file: 之类，一律拒绝。
  if (source.includes(':')) {
    return { ok: false, error: '本地音频只能用相对路径，不接受盘符或其它协议。' };
  }
  if (source.startsWith('/') || source.startsWith('\\')) {
    return { ok: false, error: '本地音频只能用相对路径，不能用绝对路径。' };
  }
  for (const segment of source.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { ok: false, error: '路径不能包含 .. 逃逸。' };
    if (/~\d/.test(segment)) return { ok: false, error: '不接受短文件名，请写完整名称。' };
    if (deviceName.test(segment)) {
      return { ok: false, error: '这是系统保留的设备名，不能当文件名。' };
    }
    if (/[. ]$/.test(segment)) return { ok: false, error: '文件名不能以点或空格结尾。' };
  }
  return { ok: true, value: { kind: 'file', relativePath: source } };
}
