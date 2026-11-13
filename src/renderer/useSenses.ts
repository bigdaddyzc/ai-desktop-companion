import { useEffect, useRef, useState } from 'react';
import {
  emptyReading,
  presentFrom,
  speakingFromLevel,
  trackMotion,
  type SensesConfig,
  type SensesReading,
} from '../core/senses';

/**
 * 耳朵与眼睛的采集端。
 *
 * 只在桌宠窗口跑：它是唯一常年可见、也唯一被主进程授予媒体权限的窗口。
 * 面板读的是这里上报到主进程、再广播回来的一份读数，自己不开设备。
 *
 * 两条实现上的硬约束：
 *
 * - **音频只有 RMS**：`AnalyserNode.getFloatTimeDomainData` 拿时域波形算均方根，
 *   不接 `MediaRecorder`、不建 `AudioWorklet` 缓冲、不落任何字符串。
 * - **视频只有帧差**：64×48 灰度逐像素差取均值，画布是离屏的，
 *   画完就丢；没有 `toDataURL`、没有 `ImageData` 外传。
 *
 * 关掉开关时立刻 `stop()` 所有 track：麦克风和摄像头的系统指示灯要跟着灭，
 * 这是用户判断「它是不是真停了」的唯一凭据，不能靠界面上的字。
 */
export function useSenses(config: SensesConfig): SensesReading {
  const reading = useRef<SensesReading>(emptyReading());
  /**
   * 界面用的那一份。和上报用的 ref 分开：上报要每个采样点都准，
   * 界面只要「看起来在动」——10Hz 重渲染整块桌宠是没必要的开销，
   * 所以只有音量跨过 5% 或状态翻转时才 setState。
   */
  const [visible, setVisible] = useState<SensesReading>(() => emptyReading());
  const visibleRef = useRef<SensesReading>(reading.current);

  useEffect(() => {
    const report = (patch: Partial<SensesReading>): void => {
      reading.current = { ...reading.current, ...patch, at: Date.now() };
      // fire-and-forget：这条通道是高频遥测，等回包只会拖慢采集。
      window.companion?.sensesReport(reading.current);
      const before = visibleRef.current;
      const after = reading.current;
      if (
        before.mic !== after.mic ||
        before.camera !== after.camera ||
        before.speaking !== after.speaking ||
        before.present !== after.present ||
        before.error !== after.error ||
        Math.abs(before.level - after.level) >= 0.05
      ) {
        visibleRef.current = after;
        setVisible(after);
      }
    };

    if (!config.ears && !config.eyes) {
      report({ ...emptyReading(), at: Date.now() });
      return;
    }
    let disposed = false;
    let audioContext: AudioContext | undefined;
    let audioStream: MediaStream | undefined;
    let videoStream: MediaStream | undefined;
    let audioTimer: ReturnType<typeof setInterval> | undefined;
    let videoTimer: ReturnType<typeof setInterval> | undefined;
    let video: HTMLVideoElement | undefined;
    let speaking = false;
    let lastMotionAt = 0;
    let level = 0;

    /** 上一帧的灰度值；只在本地内存里，作为下一帧的比较基准。 */
    let previousFrame: Uint8ClampedArray | undefined;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext('2d', { willReadFrequently: true });

    // 上报节流：状态一变立刻发（打断要靠它），纯数值变化最多 800ms 一次。
    let lastSentAt = 0;
    let lastSentSignature = '';
    const push = (): void => {
      const now = Date.now();
      const present = presentFrom(lastMotionAt, now, config.eyes);
      const signature = `${speaking}|${present}|${level > 0.3 ? 'loud' : 'quiet'}`;
      if (signature === lastSentSignature && now - lastSentAt < 800) return;
      lastSentSignature = signature;
      lastSentAt = now;
      report({ level, speaking, present, lastMotionAt });
    };

    const fail = (channel: 'mic' | 'camera', error: unknown): void => {
      const name = (error as { name?: unknown })?.name;
      const denied = name === 'NotAllowedError' || name === 'SecurityError';
      const missing = name === 'NotFoundError' || name === 'OverconstrainedError';
      report({
        [channel]: denied ? 'denied' : 'error',
        error: denied
          ? channel === 'mic'
            ? '系统拒绝了麦克风权限，去系统设置里允许芯伴使用麦克风。'
            : '系统拒绝了摄像头权限，去系统设置里允许芯伴使用摄像头。'
          : missing
            ? channel === 'mic'
              ? '没有找到可用的麦克风。'
              : '没有找到可用的摄像头。'
            : '设备打不开，可能是被其他程序占用了。',
      });
    };

    async function startAudio(): Promise<void> {
      if (!config.ears) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        report({ mic: 'error', error: '当前环境不支持采集音频。' });
        return;
      }
      report({ mic: 'starting', error: '' });
      try {
        // 只要音频：同时请求视频会让「只开耳朵」也点亮摄像头指示灯。
        audioStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
          video: false,
        });
      } catch (error) {
        fail('mic', error);
        return;
      }
      if (disposed) {
        for (const track of audioStream.getTracks()) track.stop();
        return;
      }
      const AudioContextClass = window.AudioContext;
      audioContext = new AudioContextClass();
      // 窗口没有用户手势时可能处于 suspended，不 resume 就永远读到 0。
      if (audioContext.state === 'suspended') await audioContext.resume().catch(() => undefined);
      const source = audioContext.createMediaStreamSource(audioStream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      // 必须接一个静音出口：AnalyserNode 不是 sink，没有下游就不会被渲染循环拉动。
      const sink = audioContext.createGain();
      sink.gain.value = 0;
      analyser.connect(sink);
      sink.connect(audioContext.destination);

      const samples = new Float32Array(analyser.fftSize);
      audioTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        // ×8 只是让 0~1 的读数在正常说话时落在 0.2~0.6，方便看，不代表分贝。
        level = Math.min(1, Math.sqrt(sum / samples.length) * 8);
        speaking = speakingFromLevel(level, speaking);
        report({ mic: 'live', level, speaking });
        push();
      }, 100);
    }

    async function startVideo(): Promise<void> {
      if (!config.eyes) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        report({ camera: 'error', error: '当前环境不支持采集画面。' });
        return;
      }
      report({ camera: 'starting', error: '' });
      try {
        videoStream = await navigator.mediaDevices.getUserMedia({
          // 只要 64×48：够算帧差，又小到不可能看清任何东西。
          video: { width: { ideal: 64 }, height: { ideal: 48 }, frameRate: { ideal: 5 } },
          audio: false,
        });
      } catch (error) {
        fail('camera', error);
        return;
      }
      if (disposed) {
        for (const track of videoStream.getTracks()) track.stop();
        return;
      }
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      // 挂在页面里但不可见：离屏 video 在部分平台上不产帧，1×1 是稳的做法。
      video.style.cssText =
        'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;';
      video.srcObject = videoStream;
      document.body.append(video);
      try {
        await video.play();
      } catch {
        // 自动播放被拦时仍可能出帧，交给下面的循环判断。
      }
      if (disposed || !context) return;
      videoTimer = setInterval(() => {
        if (!video || video.readyState < 2) return;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = context.getImageData(0, 0, canvas.width, canvas.height).data;
        if (previousFrame === undefined) {
          previousFrame = new Uint8ClampedArray(frame);
          report({ camera: 'live' });
          return;
        }
        let difference = 0;
        for (let index = 0; index < frame.length; index += 4) {
          const before =
            (previousFrame[index]! * 299 +
              previousFrame[index + 1]! * 587 +
              previousFrame[index + 2]! * 114) /
            1000;
          const after =
            (frame[index]! * 299 + frame[index + 1]! * 587 + frame[index + 2]! * 114) / 1000;
          difference += Math.abs(after - before);
        }
        previousFrame.set(frame);
        const motion = difference / (canvas.width * canvas.height) / 255;
        lastMotionAt = trackMotion(lastMotionAt, motion, Date.now());
        report({ camera: 'live' });
        push();
      }, 450);
    }

    void startAudio();
    void startVideo();

    return () => {
      disposed = true;
      if (audioTimer !== undefined) clearInterval(audioTimer);
      if (videoTimer !== undefined) clearInterval(videoTimer);
      // 先停 track 再关 context：只关 context 时，部分驱动上的指示灯会晚灭几秒。
      for (const track of [
        ...(audioStream?.getTracks() ?? []),
        ...(videoStream?.getTracks() ?? []),
      ])
        track.stop();
      void audioContext?.close().catch(() => undefined);
      video?.remove();
      previousFrame = undefined;
      report({ ...emptyReading(), at: Date.now() });
    };
  }, [config.ears, config.eyes]);

  return visible;
}
