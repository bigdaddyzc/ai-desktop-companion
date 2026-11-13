import { randomUUID } from 'node:crypto';
import { desktopCapturer, ipcMain, nativeImage, screen, type BrowserWindow } from 'electron';
import type { VisionFrame } from '../core/vision';
import type { VisionCapture } from './vision';

/**
 * 两路取帧。
 *
 * **屏幕**：主进程用 `desktopCapturer` 拿缩略图。不做全屏原生截图、不调外部命令，
 * 缩略图本身就是「够看清界面、又小到传得动」的尺寸，省一步压缩。
 *
 * **摄像头**：主进程没有摄像头权限，也不该有。真正的设备在桌宠窗口里，
 * 所以这里发一个请求过去，等它回一张 JPEG。用超时兜住——窗口被隐藏、驱动卡住时
 * 宁可回「没拿到」，不要让一次工具调用挂死整轮对话。
 *
 * 两路都只在内存里返回字节，不写文件。
 */

/** 截图尺寸：1536 宽对菜单小字和报错行更稳，代价只是几百 KB 的请求体。 */
const screenSize = { width: 1536, height: 960 } as const;

/** 上限覆盖首帧就绪 8.5 秒 + 连拍 5 秒的独立预算，再留 IPC 清理余量。 */
const cameraTimeoutMs = 15_000;

export async function captureScreen(): Promise<VisionFrame[]> {
  try {
    const primary = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: screenSize,
      fetchWindowIcons: false,
    });
    if (sources.length === 0) return [];
    // 多屏时优先主屏：用户说「屏幕上这个」，指的多半是正在用的那块。
    const source = sources.find((item) => item.display_id === String(primary.id)) ?? sources[0]!;
    const image = source.thumbnail;
    if (image.isEmpty()) return [];
    // 缩略图按比例缩过，实际尺寸要按 image 自己报的算，不能假设就是请求的那两个数。
    const size = image.getSize();
    return [
      {
        capturedAt: Date.now(),
        jpeg: image.toJPEG(80),
        width: size.width,
        height: size.height,
      },
    ];
  } catch {
    // 锁屏、远程桌面、驱动异常都会抛；对上层就是「这次没截到」。
    return [];
  }
}

/**
 * 请桌宠窗口连拍几帧。
 *
 * 协议极简：主进程发一个 id，渲染进程拍完用同一个 id 回传帧数组。
 * 连拍而不是单帧：曝光稳定后最多五帧、约三秒，
 * 带时间戳交给模型比较变化。不排队、不重试——上一轮还没回来时再要一轮，
 * 只会让摄像头指示灯闪个不停。
 */
export function createCameraCapture(
  getWindow: () => BrowserWindow | null,
): () => Promise<VisionFrame[]> {
  return async () => {
    const window = getWindow();
    if (window === null || window.isDestroyed()) return [];
    const requestId = randomUUID();
    const frames = await new Promise<VisionFrame[]>((resolve) => {
      let settled = false;
      const finish = (value: VisionFrame[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ipcMain.removeListener('companion:camera-frame', onFrame);
        resolve(value);
      };
      const onFrame = (event: Electron.IpcMainEvent, id: unknown, raw: unknown): void => {
        if (id !== requestId || event.sender !== window.webContents) return;
        // 空数组是渲染进程的「没拍到」：权限被拒、设备被占用、等帧超时都走这里。
        if (!Array.isArray(raw) || raw.length > 5) return finish([]);
        const frames = raw.map(toFrame).filter((frame): frame is VisionFrame => frame !== null);
        finish(frames);
      };
      const timer = setTimeout(() => finish([]), cameraTimeoutMs);
      ipcMain.on('companion:camera-frame', onFrame);
      window.webContents.send('companion:capture-frame', requestId);
    });
    return frames;
  };
}

/** 渲染进程回传的是 ArrayBuffer（结构化克隆），这里统一成帧。 */
function toFrame(raw: unknown): VisionFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as {
    bytes?: unknown;
    width?: unknown;
    height?: unknown;
    capturedAt?: unknown;
  };
  const data = toBytes(record.bytes);
  if (data === null || data.byteLength === 0 || data.byteLength > 4 * 1024 * 1024) return null;
  if (
    typeof record.width !== 'number' ||
    !Number.isInteger(record.width) ||
    record.width < 1 ||
    record.width > 4096 ||
    typeof record.height !== 'number' ||
    !Number.isInteger(record.height) ||
    record.height < 1 ||
    record.height > 4096
  )
    return null;
  if (
    record.capturedAt !== undefined &&
    (typeof record.capturedAt !== 'number' ||
      !Number.isFinite(record.capturedAt) ||
      Math.abs(Date.now() - record.capturedAt) > 15_000)
  )
    return null;
  return {
    capturedAt: typeof record.capturedAt === 'number' ? record.capturedAt : undefined,
    jpeg: data,
    width: typeof record.width === 'number' ? record.width : 0,
    height: typeof record.height === 'number' ? record.height : 0,
  };
}

/** 渲染进程回传的是 ArrayBuffer（结构化克隆），这里统一成 Uint8Array。 */
function toBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

/**
 * 读一张图片文件：宽过 1536 就等比缩小，统一压成 JPEG。
 * nativeImage 认不出来的格式（如部分 webp/gif 动图）返回空，上层说「打不开」。
 */
export async function captureFile(path: string): Promise<VisionFrame[]> {
  try {
    let image = nativeImage.createFromPath(path);
    if (image.isEmpty()) return [];
    if (image.getSize().width > screenSize.width) image = image.resize({ width: screenSize.width });
    const size = image.getSize();
    return [{ jpeg: image.toJPEG(82), width: size.width, height: size.height }];
  } catch {
    return [];
  }
}

export function createVisionCapture(getWindow: () => BrowserWindow | null): VisionCapture {
  const camera = createCameraCapture(getWindow);
  return { screen: captureScreen, camera, file: captureFile };
}
