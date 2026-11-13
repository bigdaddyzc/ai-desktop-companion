import { useCallback, useEffect, useRef, useState } from 'react';
import { sttDefaults } from '../core/stt';

/**
 * 按住说话。
 *
 * 三条不可退让的约束：
 *
 * 1. **只在按下期间录**。`getUserMedia` 在按下时开、松开时停，不留常开的录音流。
 * 2. **音频只到内存**：`MediaRecorder` 的 chunk 拼成 Blob → `arrayBuffer` → 过 IPC，
 *    转完即丢。不写文件、不进会话历史、不留副本供下次重试。
 * 3. **松手就停 track**。系统麦克风指示灯跟着灭——用户判断「它是不是真在录」
 *    只看那盏灯，不看界面上的字。
 *
 * 为什么不用「检测到说话就自动录」：麦克风平时就开着算音量（耳朵），
 * 自动录音等于把房间里的每句话都往云端送。这条线不放开。
 */
export interface RecorderHandle {
  recording: boolean;
  /** 已经录了多久。到 `maxSeconds` 自动停，避免录出传不动的体积。 */
  elapsedMs: number;
  start: () => Promise<void>;
  stop: () => void;
}

function pickMime(): string {
  // Chromium 上 webm/opus 是唯一稳的；mp4 给 macOS 万一。
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export function useRecorder(options: {
  /** 开关 + Key 都齐了才允许录，否则按下去只会换回一句「没配好」。 */
  ready: boolean;
  onText: (text: string) => void;
  onError: (message: string) => void;
  /** 按下时先执行：正在念的回复要停掉，否则会被自己录进去。 */
  onBeforeStart?: () => void;
}): RecorderHandle {
  const { ready, onText, onError, onBeforeStart } = options;
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const autoStop = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 松开发生在「还没拿到麦克风」的窗口期里：这次按基本是误触，直接放弃。 */
  const releasedEarly = useRef(false);
  const starting = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const teardown = useCallback((): void => {
    if (timer.current !== undefined) clearInterval(timer.current);
    if (autoStop.current !== undefined) clearTimeout(autoStop.current);
    timer.current = undefined;
    autoStop.current = undefined;
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    recorder.current = null;
    setRecording(false);
    setElapsedMs(0);
  }, []);

  const finish = useCallback(
    async (blob: Blob, mime: string, mine: number): Promise<void> => {
      const valid = (): boolean => alive.current && readyRef.current && mine === generation.current;
      if (!valid()) return;
      if (blob.size === 0) {
        onError('这次没录到声音。');
        return;
      }
      try {
        const buffer = await blob.arrayBuffer();
        if (!valid()) return;
        const result = await window.companion!.sttTranscribe(buffer, mime);
        if (!valid()) return;
        if (!result.ok) {
          onError(result.error ?? '没转出来。');
          return;
        }
        onText(result.text ?? '');
      } catch {
        if (valid()) onError('转写请求没发出去。');
      }
    },
    [onError, onText],
  );

  const stop = useCallback((): void => {
    if (starting.current) {
      // 还没拿到麦克风：标记一下，等 start 回来自己收场。
      releasedEarly.current = true;
      return;
    }
    const active = recorder.current;
    if (!active || active.state === 'inactive') return;
    active.stop();
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    // 状态先落下来，不等 onstop：按钮要立刻回到「按住说话」。
    if (timer.current !== undefined) clearInterval(timer.current);
    if (autoStop.current !== undefined) clearTimeout(autoStop.current);
    timer.current = undefined;
    autoStop.current = undefined;
    setRecording(false);
    setElapsedMs(0);
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (!ready) {
      onError('语音输入还没配好：先打开开关，再填硅基流动的 Key。');
      return;
    }
    if (starting.current || recorder.current !== null) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      onError('这个环境没有可用的麦克风。');
      return;
    }
    const mine = ++generation.current;
    void window.companion?.sttStop();
    releasedEarly.current = false;
    starting.current = true;
    onBeforeStart?.();
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        // 回声消除开着：念回复和听话可能同时发生，能压一点是一点。
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (
        !alive.current ||
        !readyRef.current ||
        mine !== generation.current ||
        releasedEarly.current
      ) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      stream.current = media;
      const chunks: Blob[] = [];
      const mime = pickMime();
      const instance =
        mime === '' ? new MediaRecorder(media) : new MediaRecorder(media, { mimeType: mime });
      recorder.current = instance;
      instance.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      instance.onstop = () => {
        // 先停 track 再处理数据：指示灯早一点灭，比早一点出字重要。
        for (const track of media.getTracks()) track.stop();
        if (stream.current === media) stream.current = null;
        const type = instance.mimeType || mime || 'audio/webm';
        const blob = new Blob(chunks, { type });
        chunks.length = 0;
        if (recorder.current === instance) recorder.current = null;
        void finish(blob, type, mine);
      };
      instance.start();
      startedAt.current = Date.now();
      setRecording(true);
      setElapsedMs(0);
      timer.current = setInterval(() => {
        setElapsedMs(Date.now() - startedAt.current);
      }, 100);
      autoStop.current = setTimeout(() => stop(), sttDefaults.maxSeconds * 1_000);
    } catch (error) {
      teardown();
      if (!alive.current || mine !== generation.current) return;
      const name = (error as { name?: unknown })?.name;
      const denied = name === 'NotAllowedError' || name === 'SecurityError';
      onError(
        denied
          ? '系统没给麦克风权限，去系统设置里允许芯伴使用麦克风。'
          : '麦克风打不开，可能被别的程序占着。',
      );
    } finally {
      starting.current = false;
    }
  }, [finish, onBeforeStart, onError, ready, stop, teardown]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      void window.companion?.sttStop();
      // 卸载时一律停：窗口关了还留着录音流是最坏的情况。
      const active = recorder.current;
      if (active && active.state !== 'inactive') active.stop();
      teardown();
    };
  }, [teardown]);

  useEffect(() => {
    if (ready) return;
    generation.current++;
    releasedEarly.current = true;
    const active = recorder.current;
    if (active && active.state !== 'inactive') active.stop();
    teardown();
    void window.companion?.sttStop();
  }, [ready, teardown]);
  return { recording, elapsedMs, start, stop };
}
