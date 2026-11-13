import { useEffect } from 'react';
import { visionLimits } from '../core/vision';

/**
 * 摄像头取帧的渲染端。
 *
 * 为什么取帧要绕回渲染进程：主进程没有设备权限，也不该有。摄像头只有桌宠窗口能开，
 * 所以主进程发一个请求过来，这里开一次设备、连拍几帧、立刻关掉，再把帧数组回传。
 *
 * 三条约束：
 * 1. **拍完就关**：不为了一次「看」常开摄像头，指示灯该亮多久就亮多久；
 * 2. **不排队**：上一轮还没拍完时再来请求直接忽略——连续开关设备只会闪灯；
 * 3. **不落盘**：帧只经 canvas 编码后回传，渲染进程不留副本、不出现在 DOM 里。
 *
 * 为什么连拍：摄像头刚出画的前几帧对焦和曝光都没稳住，单帧十有八九是糊的——
 * 用户看到的「脸是糊的」就是这么来的。等取景稳定后连拍五帧交给模型，
 * 保留时序，让模型比较变化；模糊或未拍到的动作仍可能识别失败。
 */

/** 一次「看」连拍几帧、隔多久：和 `visionLimits` 共用同一份，避免两处参数各说各话。 */
const burst = { count: visionLimits.maxFrames, intervalMs: visionLimits.frameIntervalMs } as const;

/**
 * 相邻两帧的平均像素差低于这个值，就当作「画面没动」。
 *
 * 去重不是省流量的小聪明：用户坐着不动时，五帧其实是同一张图，
 * 全发过去只会让请求体积翻五倍、模型还得自己发现它们一样。
 * 走廊里有人走过、抬手、转头这种变化通常更明显，但小动作仍可能漏检。
 */
const motionFloor = 2.5;

/** 指纹用的极小画布：只比明暗分布，足够判断「动没动」，也不值得更精细。 */
const fingerprint = { width: 16, height: 9 } as const;

export function useCameraShot(): void {
  useEffect(() => {
    let shooting = false;
    const controller = new AbortController();
    const off = window.companion?.onCaptureFrame((requestId) => {
      if (shooting) return;
      shooting = true;
      void shoot(requestId, controller.signal).finally(() => {
        shooting = false;
      });
    });
    return () => {
      controller.abort();
      off?.();
    };
  }, []);
}

async function shoot(requestId: string, parentSignal: AbortSignal): Promise<void> {
  const bridge = window.companion;
  if (!bridge) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    bridge.sendCameraFrame(requestId, []);
    return;
  }
  // Camera startup and the three-second burst need separate budgets: a slow first frame must
  // not consume the capture window. Both phases together stay below the main IPC timeout.
  // Pending browser operations are bounded; late device grants are always stopped.
  const deadline = new AbortController();
  const signal = AbortSignal.any([parentSignal, deadline.signal]);
  // 9.5s + 4.5s = 14s，给主进程 15s 兜底留 1s；连拍本身约 2s，启动慢的机器更需要余量。
  let timer = setTimeout(() => deadline.abort(), 9_500);
  let stream: MediaStream | undefined;
  let video: HTMLVideoElement | undefined;
  const stopTracks = (): void => {
    for (const track of stream?.getTracks() ?? []) track.stop();
  };
  try {
    stream = await abortable(
      navigator.mediaDevices.getUserMedia({
        // 只要几帧，不追求高帧率；1280 宽让五官和屏幕文字都有得认。
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15 } },
        audio: false,
      }),
      signal,
      (late) => {
        for (const track of late.getTracks()) track.stop();
      },
    );
    signal.throwIfAborted();
    signal.addEventListener('abort', stopTracks, { once: true });
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;';
    video.srcObject = stream;
    document.body.append(video);
    await abortable(video.play(), signal);
    const ready = await abortable(waitForFrame(video, 2_500), signal);
    if (!ready) {
      bridge.sendCameraFrame(requestId, []);
      return;
    }
    signal.throwIfAborted();
    clearTimeout(timer);
    timer = setTimeout(() => deadline.abort(), 4_500);
    // 给自动对焦和自动曝光留出收敛时间：这一拍等的就是「不再糊」。
    await abortable(new Promise((resolve) => setTimeout(resolve, 600)), signal);

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const scale = Math.min(1, 1280 / Math.max(1, width));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    if (!context) {
      bridge.sendCameraFrame(requestId, []);
      return;
    }

    const small = document.createElement('canvas');
    small.width = fingerprint.width;
    small.height = fingerprint.height;
    const smallContext = small.getContext('2d', { willReadFrequently: true });
    // 参照物只在这一次拍摄内有效：上一次拍摄的最后一帧拿来做基准，
    // 会把「这次的第一帧」误判成没动过。
    let previous: Uint8ClampedArray | null = null;

    const frames: { bytes: ArrayBuffer; width: number; height: number; capturedAt: number }[] = [];
    for (let index = 0; index < burst.count; index += 1) {
      if (index > 0) {
        await abortable(new Promise((resolve) => setTimeout(resolve, burst.intervalMs)), signal);
      }
      signal.throwIfAborted();
      const current = smallContext === null ? null : printOf(smallContext, video);
      const moved =
        previous === null || current === null || difference(previous, current) >= motionFloor;
      previous = current ?? previous;
      // 前两张和最后一张一律留：开头要有参照，结尾要是最新状态。
      const keep = frames.length < 2 || moved || index === burst.count - 1;
      if (!keep) continue;

      const capturedAt = Date.now();
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await abortable(
        new Promise<Blob | null>((resolve) => {
          canvas.toBlob((value) => resolve(value), 'image/jpeg', 0.85);
        }),
        signal,
      );
      if (blob === null) continue;
      frames.push({
        capturedAt,
        bytes: await abortable(blob.arrayBuffer(), signal),
        width: canvas.width,
        height: canvas.height,
      });
    }
    if (!signal.aborted) bridge.sendCameraFrame(requestId, frames);
  } catch {
    // 权限被拒、设备被占用、驱动异常都走这里：回一个空数组，让主进程说「没拍到」。
    if (!parentSignal.aborted) bridge.sendCameraFrame(requestId, []);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stopTracks);
    stopTracks();
    video?.remove();
  }
}

/** 把当前画面缩成极小指纹：只留明暗分布，够判断「动没动」。 */
function printOf(context: CanvasRenderingContext2D, video: HTMLVideoElement): Uint8ClampedArray {
  context.drawImage(video, 0, 0, fingerprint.width, fingerprint.height);
  return new Uint8ClampedArray(
    context.getImageData(0, 0, fingerprint.width, fingerprint.height).data,
  );
}

/** 两张指纹的平均通道差（0–255）。 */
function difference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length) return 255;
  let sum = 0;
  for (let index = 0; index < a.length; index += 4) {
    sum +=
      Math.abs(a[index]! - b[index]!) +
      Math.abs(a[index + 1]! - b[index + 1]!) +
      Math.abs(a[index + 2]! - b[index + 2]!);
  }
  return sum / (a.length / 4) / 3;
}

/** Reject pending browser operations on cancellation; late device grants must be released. */
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) late?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** 等第一帧真的可读。`play()` 返回不代表有画面，`readyState` 才算。 */
function waitForFrame(video: HTMLVideoElement, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = (): void => {
      if (video.readyState >= 2 && video.videoWidth > 0) return resolve(true);
      if (Date.now() - startedAt >= timeoutMs) return resolve(false);
      setTimeout(tick, 60);
    };
    tick();
  });
}
