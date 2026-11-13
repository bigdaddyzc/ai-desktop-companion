import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  bridgeReplySchema,
  emptyMusic,
  musicLimits,
  nowPlayingOf,
  type BridgeReply,
  type MusicCommand,
  type MusicSnapshot,
} from '../core/music';

/**
 * 音乐控制的桌面侧。
 *
 * 读写 Windows 系统媒体控制（GlobalSystemMediaTransportControls）需要 WinRT，
 * Node 自己碰不到。这里起一个常驻的 Windows PowerShell 5.1 小进程当桥：
 * 一行一条命令进、一行一条 JSON 出，不引入任何原生模块。
 * 没有媒体会话时（有的客户端不向系统报告），退而发一个系统媒体键——和你按键盘上的播放键一样。
 *
 * 桥是懒启动的：第一次用到音乐才起；之后没有播放器时只一分钟看一眼。
 */

export const mediaBridgeScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -Namespace Xinban -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(4000); $t.Result }
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
function Key([byte]$vk) { [Xinban.Keys]::keybd_event($vk, 0, 0, [UIntPtr]::Zero); [Xinban.Keys]::keybd_event($vk, 0, 2, [UIntPtr]::Zero) }
function Current {
  $s = $mgr.GetCurrentSession()
  if ($null -eq $s) { return $null }
  $title = ''; $artist = ''
  try { $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType; $title = $p.Title; $artist = $p.Artist } catch {}
  return @{ app = [string]$s.SourceAppUserModelId; status = [string]$s.GetPlaybackInfo().PlaybackStatus; title = [string]$title; artist = [string]$artist }
}
function Act($name, [byte]$vk) {
  $s = $mgr.GetCurrentSession()
  if ($null -ne $s) {
    $op = switch ($name) { 'toggle' { $s.TryTogglePlayPauseAsync() } 'next' { $s.TrySkipNextAsync() } 'prev' { $s.TrySkipPreviousAsync() } }
    $null = Await $op ([bool])
    return @{ ok = $true; via = 'session' }
  }
  Key $vk
  return @{ ok = $true; via = 'key' }
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split(' ', 2)
  $id = $parts[0]
  $cmd = if ($parts.Count -gt 1) { $parts[1] } else { '' }
  try {
    switch ($cmd) {
      'state' { $r = @{ ok = $true; session = (Current) } }
      'toggle' { $r = Act 'toggle' 0xB3 }
      'next' { $r = Act 'next' 0xB0 }
      'prev' { $r = Act 'prev' 0xB1 }
      default { $r = @{ ok = $false; error = 'unknown command' } }
    }
  } catch { $r = @{ ok = $false; error = [string]$_.Exception.Message } }
  $r.id = $id
  [Console]::Out.WriteLine(($r | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
`;

/** 桥的端口：测试里换成假桥。 */
export interface MediaBridge {
  request(command: MusicCommand): Promise<BridgeReply>;
  dispose(): void;
}

export class PowerShellMediaBridge implements MediaBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (reply: BridgeReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  private start(): ChildProcessWithoutNullStreams {
    if (this.child !== null) return this.child;
    const encoded = Buffer.from(mediaBridgeScript, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.onLine(line));
    child.stderr.resume();
    const fail = (message: string) => {
      if (this.child === child) this.child = null;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(message));
        this.pending.delete(id);
      }
    };
    child.on('error', () => fail('启动不了 PowerShell。'));
    child.on('exit', () => fail('媒体桥退出了。'));
    return child;
  }

  private onLine(line: string): void {
    const text = line.trim();
    if (!text.startsWith('{')) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = bridgeReplySchema.safeParse(value);
    if (!parsed.success) return;
    const entry = this.pending.get(parsed.data.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(parsed.data.id);
    entry.resolve(parsed.data);
  }

  request(command: MusicCommand): Promise<BridgeReply> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.start();
      } catch {
        reject(new Error('启动不了 PowerShell。'));
        return;
      }
      const id = `${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('媒体桥没有应答。'));
      }, musicLimits.replyMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${id} ${command}\n`);
    });
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    if (child !== null) {
      child.stdin.end();
      child.kill();
    }
  }
}

export type MusicResult = { ok: true; snapshot: MusicSnapshot } | { ok: false; error: string };

export class MusicService {
  private state: MusicSnapshot;
  private readonly listeners = new Set<(state: MusicSnapshot) => void>();
  private timer: NodeJS.Timeout | null = null;
  private lastSeenAt = 0;

  constructor(
    private readonly bridge: MediaBridge | null,
    private readonly now: () => number = Date.now,
  ) {
    this.state = emptyMusic(bridge !== null);
  }

  snapshot(): MusicSnapshot {
    return this.state;
  }

  subscribe(listener: (state: MusicSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 读一次「正在放什么」，并开始轻量轮询（没有播放器一段时间后自动停）。 */
  async refresh(): Promise<MusicResult> {
    if (this.bridge === null) return { ok: false, error: '只在 Windows 上支持控制音乐客户端。' };
    try {
      const reply = await this.bridge.request('state');
      if (!reply.ok) return this.fail(reply.error ?? '读不到播放状态。');
      const nowPlaying = nowPlayingOf(reply);
      const at = this.now();
      if (nowPlaying !== null) this.lastSeenAt = at;
      this.publish({ available: true, nowPlaying, error: '', updatedAt: at });
      this.schedule();
      return { ok: true, snapshot: this.state };
    } catch (error) {
      this.schedule();
      return this.fail(error instanceof Error ? error.message : '读不到播放状态。');
    }
  }

  async control(command: Exclude<MusicCommand, 'state'>): Promise<MusicResult> {
    if (this.bridge === null) return { ok: false, error: '只在 Windows 上支持控制音乐客户端。' };
    try {
      const reply = await this.bridge.request(command);
      if (!reply.ok) return this.fail(reply.error ?? '没按成。');
      this.lastSeenAt = this.now();
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : '没按成。');
    }
    // 客户端切歌要一点时间才把新歌名报给系统。
    await new Promise((resolve) => setTimeout(resolve, 600));
    return this.refresh();
  }

  private fail(error: string): MusicResult {
    this.publish({ ...this.state, error, updatedAt: this.now() });
    return { ok: false, error };
  }

  /**
   * 轮询节奏：有播放器时 5 秒一次；两分钟没见到播放器就放慢到一分钟一次。
   * 只有用户用过一次音乐（面板、桌宠、对话里的 music 工具）才会开始。
   */
  private schedule(): void {
    if (this.timer !== null) return;
    const idle = this.now() - this.lastSeenAt > musicLimits.idleStopMs;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.refresh();
      },
      idle ? musicLimits.idlePollMs : musicLimits.pollMs,
    );
    this.timer.unref?.();
  }

  private stopPolling(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stopPolling();
    this.bridge?.dispose();
  }

  private publish(next: MusicSnapshot): void {
    const same =
      next.error === this.state.error &&
      next.available === this.state.available &&
      JSON.stringify(next.nowPlaying) === JSON.stringify(this.state.nowPlaying);
    this.state = next;
    if (same) return;
    for (const listener of this.listeners) listener(next);
  }
}
