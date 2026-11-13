import { BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AudioPlayerPort, ResolvedSource, TerminalResult } from './audio';

/**
 * 用系统扬声器发声的运行时实现：主进程自建一个隐藏窗口，里面只有一个 <audio>。
 *
 * 为什么在主进程而不是复用界面窗口：放声音要能主动触发，不依赖用户当前有没有开着面板；
 * 隐藏窗口只加载 about:blank 与本地受控的音频，不接触任何外部页面。
 * 本地文件读进内存转成 data: URL，http(s) 链接直接交给 <audio>，都不经过 file:// 权限，
 * 因此不需要关闭 webSecurity，也不新增任何运行时依赖。
 */

const install = `
(() => {
  if (window.__xinbanAudio) return;
  const audio = document.createElement('audio');
  audio.preload = 'auto';
  document.body.appendChild(audio);
  let pending = null;
  const clear = () => { audio.onended = null; audio.onerror = null; };
  const settle = (result) => {
    const resolve = pending;
    pending = null;
    if (resolve) resolve(result);
  };
  window.__xinbanAudio = {
    play(src, volume) {
      clear();
      settle('stopped');
      audio.pause();
      try { audio.currentTime = 0; } catch {}
      audio.volume = volume;
      audio.src = src;
      return new Promise((resolve) => {
        pending = resolve;
        audio.onended = () => { clear(); settle('ended'); };
        audio.onerror = () => { clear(); settle('failed:媒体无法播放或链接失效'); };
        const started = audio.play();
        if (started && typeof started.catch === 'function') {
          started.catch(() => { clear(); settle('failed:无法开始播放'); });
        }
      });
    },
    stop() {
      audio.pause();
      try { audio.currentTime = 0; } catch {}
      clear();
      settle('stopped');
    },
  };
})();
`;

/** 常见音频扩展名 → MIME；认不出来时按 mp3 兜底，由 Chromium 自己嗅探内容。 */
const mimeByExt: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

export class ElectronAudioPlayer implements AudioPlayerPort {
  private window: BrowserWindow | null = null;
  private init: Promise<BrowserWindow> | null = null;

  private ensure(): Promise<BrowserWindow> {
    if (this.init) return this.init;
    this.init = (async () => {
      // 关掉 contextIsolation 是为了让多次 executeJavaScript 共享同一个 window 上的播放器；
      // 该窗口无 preload、无 nodeIntegration、无外部内容，不承载任何不可信脚本。
      const win = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        width: 2,
        height: 2,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: false,
          sandbox: true,
        },
      });
      this.window = win;
      win.on('closed', () => {
        this.window = null;
        this.init = null;
      });
      await win.loadURL('about:blank');
      await win.webContents.executeJavaScript(install);
      return win;
    })();
    return this.init;
  }

  async play(target: ResolvedSource, volume: number): Promise<TerminalResult> {
    const src = target.kind === 'url' ? target.url : await toDataUrl(target.path);
    const win = await this.ensure();
    // userGesture=true：满足 Chromium 自动播放策略，无需用户先点一下。
    const result = await win.webContents.executeJavaScript(
      `window.__xinbanAudio.play(${JSON.stringify(src)}, ${volume})`,
      true,
    );
    return parseTerminal(result);
  }

  async stop(): Promise<void> {
    const win = await this.ensure();
    await win.webContents.executeJavaScript('window.__xinbanAudio.stop()', true);
  }

  /** 退出时释放隐藏窗口；不 destroy 会留下一个窗口挡住 app.quit。 */
  dispose(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.init = null;
  }
}

/** 本地文件读成 data: URL，避免隐藏窗口去请求 file:// 资源。 */
async function toDataUrl(path: string): Promise<string> {
  const bytes = await readFile(path);
  const mime = mimeByExt[extname(path).toLowerCase()] ?? 'audio/mpeg';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function parseTerminal(raw: unknown): TerminalResult {
  if (raw === 'ended') return { status: 'ended' };
  if (raw === 'stopped') return { status: 'stopped' };
  if (typeof raw === 'string' && raw.startsWith('failed:')) {
    return { status: 'failed', error: raw.slice('failed:'.length) || '播放失败。' };
  }
  return { status: 'failed', error: '播放状态无法识别。' };
}
