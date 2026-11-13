import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  audioLimits,
  classifyAudioSource,
  playAudioInputSchema,
  type AudioSourceSpec,
} from '../core/audio';

/**
 * 主进程的音频播放服务（能力本体），与「怎么让扬声器出声」分开。
 *
 * 真正发声的是注入进来的 AudioPlayerPort：运行时是 ElectronAudioPlayer（隐藏窗口 + <audio>），
 * 单测里是假播放器。于是路径约束、单路播放、stop 与终态回报都能脱离 Electron／声卡测试。
 */

/** 一路播放的终态；工具与订阅者据此知道「放完了 / 没放成 / 被停了」。 */
export type TerminalStatus = 'ended' | 'failed' | 'stopped';
export interface TerminalResult {
  status: TerminalStatus;
  error?: string;
}

/** 解析后的来源：播放器照着放即可，不再做任何路径判断。 */
export type ResolvedSource =
  { kind: 'url'; url: string; label: string } | { kind: 'file'; path: string; label: string };

/** 播放器端口。play 的 Promise 在 ended / failed / stopped 时兑现。 */
export interface AudioPlayerPort {
  play(target: ResolvedSource, volume: number): Promise<TerminalResult>;
  /** 停掉当前播放，并让上面那个 Promise 以 stopped 兑现。 */
  stop(): Promise<void>;
}

export interface AudioState {
  status: 'idle' | 'playing' | TerminalStatus;
  source: string;
  error: string | null;
  updatedAt: number;
}

export type AudioPlayResult =
  | { ok: true; status: 'playing' | 'stopped'; source: string }
  | { ok: false; status: 'rejected' | 'superseded' | 'failed'; error: string };

/**
 * 把来源解析成可播放对象。
 *
 * 本地路径必须落在 roots（工作目录 + 用户显式指定的目录）之内：先做词法包围判定，
 * 再用 realpath 复核真实路径，挡住目录里的 junction / 符号链接逃逸。
 * 目标还不存在时 realpath 会失败，这种情况按词法路径放行，由播放器读取时兜底报「放不了」。
 */
export async function resolveAudioSource(
  spec: AudioSourceSpec,
  roots: readonly string[],
): Promise<{ ok: true; value: ResolvedSource } | { ok: false; error: string }> {
  if (spec.kind === 'url') {
    return { ok: true, value: { kind: 'url', url: spec.url, label: urlLabel(spec.url) } };
  }
  for (const rawRoot of roots) {
    const root = resolve(rawRoot);
    const target = resolve(root, spec.relativePath);
    if (target !== root && !target.startsWith(root + sep)) continue;
    try {
      const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
        return { ok: false, error: '路径经链接指向了允许目录之外。' };
      }
    } catch {
      // 文件不存在或暂不可读：不在这里假装成功，留给播放器给出明确失败。
    }
    return { ok: true, value: { kind: 'file', path: target, label: spec.relativePath } };
  }
  return { ok: false, error: '路径不在工作目录或用户指定的音频目录之内。' };
}

function urlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export class AudioService {
  private seq = 0;
  private current: { token: number; source: string } | null = null;
  private state: AudioState = { status: 'idle', source: '', error: null, updatedAt: 0 };
  private readonly listeners = new Set<(state: AudioState) => void>();

  constructor(
    private readonly player: AudioPlayerPort,
    private readonly roots: readonly string[],
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): AudioState {
    return { ...this.state };
  }

  /** 播放开始、结束、失败、被停都会推一次状态；这是「回报状态」的出口。 */
  subscribe(listener: (state: AudioState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 开始一路播放。同一时刻只允许一路：新请求先停旧的。
   * 返回只代表「已发起」，播放结束／失败通过 subscribe 回报，不把工具卡到整段音频放完。
   */
  async play(input: unknown): Promise<AudioPlayResult> {
    const parsed = playAudioInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        status: 'rejected',
        error: '参数不合法：source 必填，volume 需在 0~1 之间。',
      };
    }
    const spec = classifyAudioSource(parsed.data.source);
    if (!spec.ok) return { ok: false, status: 'rejected', error: spec.error };
    // 令牌必须在任何 await 之前取：后面的路径核对是异步的，先到的请求可能先核对完，
    // 若那时才取令牌，它会在后到的请求还没登记时就开播，变成「两路都启动过」。
    const token = ++this.seq;
    const resolved = await resolveAudioSource(spec.value, this.roots);
    if (!resolved.ok) return { ok: false, status: 'rejected', error: resolved.error };
    if (token !== this.seq) {
      return { ok: false, status: 'superseded', error: '已有更新的播放请求，这一路不再启动。' };
    }

    // 令牌让并发里的旧请求在让位给新请求后不再启动。
    await this.interrupt();
    if (token !== this.seq) {
      return { ok: false, status: 'superseded', error: '已有更新的播放请求，这一路不再启动。' };
    }

    const { value } = resolved;
    const volume = parsed.data.volume ?? audioLimits.defaultVolume;
    this.current = { token, source: value.label };
    this.publish('playing', value.label, null);

    let done: Promise<TerminalResult>;
    try {
      done = this.player.play(value, volume);
    } catch {
      this.finish(token, value.label, { status: 'failed', error: '播放异常中断。' });
      return { ok: true, status: 'playing', source: value.label };
    }
    void done.then(
      (terminal) => this.finish(token, value.label, terminal),
      () => this.finish(token, value.label, { status: 'failed', error: '播放异常中断。' }),
    );
    return { ok: true, status: 'playing', source: value.label };
  }

  /** 停止当前一路播放；没有播放时是安全的空操作。 */
  async stop(): Promise<AudioPlayResult> {
    this.seq += 1;
    const source = await this.interrupt();
    return { ok: true, status: 'stopped', source };
  }

  /** 停掉当前一路并广播 stopped，返回被停掉那路的来源。 */
  private async interrupt(): Promise<string> {
    const active = this.current;
    if (active === null) return '';
    this.current = null;
    await this.player.stop();
    this.publish('stopped', active.source, null);
    return active.source;
  }

  private finish(token: number, source: string, terminal: TerminalResult): void {
    // 已被 stop() 或更新的一路取代：忽略陈旧终态，别覆盖新播放的状态。
    if (this.current?.token !== token) return;
    this.current = null;
    this.publish(terminal.status, source, terminal.error ?? null);
  }

  private publish(status: AudioState['status'], source: string, error: string | null): void {
    this.state = { status, source, error, updatedAt: this.now() };
    for (const listener of this.listeners) listener({ ...this.state });
  }
}
