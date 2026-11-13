import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { splitForSpeech, chooseVoice, type VoiceConfig, type VoiceEngine } from '../core/voice';
import { speechText } from '../core/senses';
import { emptyTtsSnapshot, type TtsSnapshot } from '../core/tts';
import { SpeechPipeline } from './speechPipeline';

/**
 * 把回复念出来。
 *
 * 两条通路，一条兜底：
 *
 * 1. **云端**（`ttsSpeak`）：主进程合成 mp3，回复用 AudioContext 连续调度。音色是 CosyVoice2
 *    的真人嗓子，起伏、气口、停顿都有。播放走 `SpeechPipeline`：回复还在流式生成时
 *    就按句切块、并行预合成、按序播放——首句出声不用等整段回复写完。
 * 2. **系统**（`speechSynthesis`）：离线兜底。这条路上踩过三个坑，都在下面按坑修：
 *    - `cancel()` 之后立刻 `speak()` 会被吞掉，只念出一两个字；
 *    - Chromium 会在窗口失焦/不可见时**偷偷暂停**合成，听起来就是「说一半停了」；
 *    - 太长的整段文字会被引擎自己截断。
 *
 * 不管走哪条，行为约束都一样：
 * - 只念**定稿**的回答；工具步之间的进度话术（「我先查一下」）不念；
 * - 用户一开口就停（打断比「说完再听」自然）；
 * - 勿扰模式下一律不念。
 */

let cachedVoices: SpeechSynthesisVoice[] = [];

function refreshVoices(): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  cachedVoices = window.speechSynthesis.getVoices().filter((voice) => voice.localService);
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  refreshVoices();
  // Chromium 首次返回空列表，要等 voiceschanged；只挂一次，不随组件卸载摘。
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** 中文语音排前面：这块列表是给人挑嗓子的，不该先滚过十几种英文。 */
export function listVoices(): SpeechSynthesisVoice[] {
  if (cachedVoices.length === 0) refreshVoices();
  return [...cachedVoices].sort((left, right) => {
    const leftZh = left.lang.toLowerCase().startsWith('zh') ? 0 : 1;
    const rightZh = right.lang.toLowerCase().startsWith('zh') ? 0 : 1;
    if (leftZh !== rightZh) return leftZh - rightZh;
    if (left.localService !== right.localService) return left.localService ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/** 语音列表是异步到达的：面板要能在列表出现后立刻刷新，而不是停在「系统默认」。 */
export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => listVoices());

  useEffect(() => {
    if (!speechSupported()) return;
    const update = (): void => setVoices(listVoices());
    update();
    // 有些环境不发 voiceschanged，只晚一点再看一眼兜底。
    const timer = setTimeout(update, 800);
    window.speechSynthesis.addEventListener?.('voiceschanged', update);
    return () => {
      clearTimeout(timer);
      window.speechSynthesis.removeEventListener?.('voiceschanged', update);
    };
  }, []);

  return voices;
}

/** 统一成 ArrayBuffer：IPC 的结构化克隆会把它还原成 ArrayBuffer 或带 offset 的视图。 */
function toBytes(raw: unknown): ArrayBuffer | null {
  if (raw instanceof ArrayBuffer) return raw;
  if (ArrayBuffer.isView(raw)) {
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  }
  return null;
}

/**
 * 系统语音播放。
 *
 * 这里刻意把 `cancel()` 和 `speak()` 隔开一帧：Chromium 的 cancel 是异步的，
 * 紧挨着 speak 会让新 utterance 直接进回收站——用户听到的就是「说了两个字就没了」。
 *
 * 分块入队而不是整段一次念：整段长文在 Chromium 里会被引擎自己截断，
 * 短块还能让打断的响应更快。`onDone` 只在**最后一块**念完时触发一次。
 */
function speakWithSystem(
  text: string,
  config: VoiceConfig,
  onDone: () => void,
  onError: (message: string) => void = () => undefined,
): { stop: () => void } | null {
  if (!speechSupported() || listVoices().length === 0) return null;
  const clean = speechText(text, 6000);
  if (clean === '') return null;
  const chunks = splitForSpeech(clean);
  const live: SpeechSynthesisUtterance[] = [];
  let stopped = false;
  let finished = false;

  const finish = (): void => {
    if (stopped || finished) return;
    finished = true;
    clearInterval(beat);
    clearTimeout(timer);
    onDone();
  };

  // 心跳：Chromium 会在窗口失焦时把合成挂起，resume 一下能把它拽回来。
  // 只在真的在念的时候跳，停了就不吵。
  const beat = setInterval(() => {
    if (stopped || !window.speechSynthesis.speaking) return;
    window.speechSynthesis.resume();
  }, 4_000);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(beat);
    clearTimeout(timer);
    window.speechSynthesis.cancel();
    live.length = 0;
  };

  window.speechSynthesis.cancel();
  const timer = setTimeout(() => {
    if (stopped) return;
    try {
      chunks.forEach((chunk, index) => {
        const isLast = index === chunks.length - 1;
        const utterance = new SpeechSynthesisUtterance(chunk);
        utterance.lang = 'zh-CN';
        utterance.rate = config.rate;
        utterance.pitch = config.pitch;
        const voice = chooseVoice(listVoices(), config.voiceURI);
        if (voice) utterance.voice = voice;
        // 分块要留引用：被回收的 utterance 会静默不播，而且是一块一块地丢。
        live.push(utterance);
        utterance.onend = () => {
          const at = live.indexOf(utterance);
          if (at >= 0) live.splice(at, 1);
          if (isLast) finish();
        };
        // 失败不能伪装为播完：停止余下队列并显式报告。
        utterance.onerror = () => {
          if (stopped || finished) return;
          onError('系统语音播放失败，未播完的内容请看文字。');
          finish();
          stop();
        };
        window.speechSynthesis.speak(utterance);
      });
    } catch {
      onError('系统语音播放失败，未播完的内容请看文字。');
      finish();
      stop();
    }
  }, 60);

  return { stop };
}

/** 试听是「一次一条」：连点几下不该叠成合唱。 */
let previewSession: { stop: () => void } | null = null;
let previewGeneration = 0;
export function stopPreview(): void {
  previewGeneration++;
  previewSession?.stop();
  previewSession = null;
  void window.companion?.ttsStop();
}

/** 面板里的「试听」：不需要 AI Key 也能试系统嗓子，按**当前草稿**念。 */
export async function speakPreview(
  text: string,
  config: VoiceConfig,
  onError: (message: string) => void = () => undefined,
): Promise<{ ok: boolean; error?: string }> {
  const mine = ++previewGeneration;
  previewSession?.stop();
  await window.companion?.ttsStop();
  if (mine !== previewGeneration) return { ok: false, error: '试听已取消。' };
  previewSession = null;
  // 云端与系统两条路都从「先掐掉上一条」开始。
  if (speechSupported()) window.speechSynthesis.cancel();

  if (config.engine === 'cloud') {
    const result = await window
      .companion!.ttsSpeak({
        text: speechText(text),
        voice: config.cloudVoice,
        speed: config.rate,
        gain: 0,
      })
      .catch(() => ({ ok: false, error: '云端合成没走通。', audio: undefined, mime: undefined }));
    if (mine !== previewGeneration) return { ok: false, error: '试听已取消。' };
    const bytes = result.ok ? toBytes(result.audio) : null;
    if (bytes !== null) {
      const player = playAudio(bytes, result.mime ?? 'audio/mpeg', () => {
        if (mine === previewGeneration) onError('试听播放中断，请检查输出设备。');
      });
      previewSession = player;
      try {
        await player.ready;
        return { ok: true };
      } catch {
        return { ok: false, error: '音频播放失败，请检查输出设备。' };
      }
    }
    // 云端不行就当场用系统嗓子念：试听的意义是「听见」，不是「看见报错」。
    previewSession = speakWithSystem(
      text,
      config,
      () => {
        previewSession = null;
      },
      onError,
    );
    if (previewSession !== null) {
      return { ok: true, error: result.error ?? '云端没合成出来，这段是系统语音。' };
    }
    return { ok: false, error: result.error ?? '这个环境没有可用的语音。' };
  }
  previewSession = speakWithSystem(
    text,
    config,
    () => {
      previewSession = null;
    },
    onError,
  );
  if (previewSession === null) return { ok: false, error: '这个环境没有可用的语音。' };
  return { ok: true };
}

/** 播一段内存里的音频。返回的对象能立刻停，播放器自己负责回收 blob URL。 */
function playAudio(
  bytes: ArrayBuffer,
  mime: string,
  onError: () => void,
): { stop(): void; ready: Promise<void> } {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const audio = new Audio(url);
  const release = (): void => URL.revokeObjectURL(url);
  audio.addEventListener('ended', release, { once: true });
  audio.addEventListener(
    'error',
    () => {
      release();
      onError();
    },
    { once: true },
  );
  const ready = audio.play().catch((error: unknown) => {
    release();
    throw error;
  });
  return {
    ready,
    stop: () => {
      audio.pause();
      release();
    },
  };
}

/** 云端合成的可用性。桌宠与面板都订阅这一份，不再各自猜「有没有 Key」。 */
export function useTtsSnapshot(): TtsSnapshot {
  const [snapshot, setSnapshot] = useState<TtsSnapshot>(() => emptyTtsSnapshot());
  useEffect(() => {
    let live = true;
    void window.companion!.ttsState().then((value) => {
      if (live) setSnapshot(value);
    });
    const off = window.companion!.onTtsState(setSnapshot);
    return () => {
      live = false;
      off();
    };
  }, []);
  return snapshot;
}

export interface Voice {
  /** 整段念一次：试听、或系统嗓子兜底时用。 */
  speak(text: string): Promise<void>;
  /**
   * 流式推文本：传「到目前为止的完整回答」，内部只取新增部分并切句合成。
   * 只有云端嗓子会真的边生成边念；系统嗓子要等 `finish`。
   */
  push(text: string): void;
  /** 本轮结束：传入定稿全文，把尾巴念完。 */
  finish(text: string): void;
  stop(): void;
  speaking: boolean;
  supported: boolean;
  /** 真正选中的语音名；空串表示用的是系统默认。云端返回音色 id。 */
  voiceName: string;
  /** 最近一次实际走了哪条路。云端失败回落时这里是 `system`。 */
  engineUsed: VoiceEngine | null;
  /** 最近一次失败/回落的原因；空串表示一切正常。 */
  error: string;
}

export function useVoicePlayer(enabled: boolean, config: VoiceConfig): Voice {
  const [speaking, setSpeaking] = useState(false);
  const [voiceName, setVoiceName] = useState('');
  const [engineUsed, setEngineUsed] = useState<VoiceEngine | null>(null);
  const [error, setError] = useState('');
  const tts = useTtsSnapshot();
  /** 系统嗓子那边的会话；云端播放由 pipeline 自己管。 */
  const system = useRef<{ stop: () => void } | null>(null);

  // 回调里要读最新配置，又不能让 pipeline 因为配置变化被重建（重建会把队列丢掉）。
  // 所以配置与开关都走 ref：值每次渲染更新，身份永远不变。
  const configRef = useRef(config);
  configRef.current = config;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const cloudReady = config.engine === 'cloud' && tts.status === 'ready';
  const readyRef = useRef(cloudReady);
  readyRef.current = cloudReady;

  const pipeline = useMemo(
    () =>
      new SpeechPipeline({
        cancel: () => {
          void window.companion?.ttsStop();
        },
        synthesize: async (text) => {
          const current = configRef.current;
          try {
            const result = await window.companion!.ttsSpeak({
              text,
              voice: current.cloudVoice,
              speed: current.rate,
              gain: 0,
            });
            const bytes = result.ok ? toBytes(result.audio) : null;
            if (bytes === null) {
              return { ok: false, error: result.error ?? '云端没合成出来。' };
            }
            return { ok: true, audio: bytes };
          } catch {
            return { ok: false, error: '云端合成没走通。' };
          }
        },
        onSpeaking: setSpeaking,
        onError: (message) => setError(message),
        // 还没出声就失败：剩下的整段交给系统嗓子。宁可声音差，不能没声。
        onFallback: (text) => {
          system.current?.stop();
          const session = speakWithSystem(
            text,
            configRef.current,
            () => setSpeaking(false),
            setError,
          );
          system.current = session;
          if (!session) setError('系统未安装可用的本地语音，未播内容请看文字。');
          setEngineUsed('system');
          setSpeaking(session !== null);
        },
      }),
    [],
  );

  const stop = useCallback(() => {
    pipeline.stop();
    system.current?.stop();
    system.current = null;
    if (speechSupported()) window.speechSynthesis.cancel();
    setSpeaking(false);
    setError('');
  }, [pipeline]);

  /** 系统嗓子整段念：只有它需要「等全文」，保持系统引擎队列稳定。 */
  const speakSystem = useCallback((text: string) => {
    system.current?.stop();
    const session = speakWithSystem(
      text,
      configRef.current,
      () => {
        setSpeaking(false);
      },
      setError,
    );
    if (session === null) {
      setSpeaking(false);
      setEngineUsed(null);
      setError('系统里没有可用的语音，去设置里装一个中文语音包。');
      return;
    }
    system.current = session;
    setEngineUsed('system');
    setVoiceName(chooseVoice(listVoices(), configRef.current.voiceURI)?.name ?? '系统默认');
    setSpeaking(true);
  }, []);

  const push = useCallback(
    (text: string) => {
      if (!enabledRef.current || !readyRef.current) return;
      pipeline.push(text);
    },
    [pipeline],
  );

  const finish = useCallback(
    (text: string) => {
      if (!enabledRef.current) return;
      // Keep a preceding synthesis failure visible when finish flushes its system fallback.
      if (readyRef.current) {
        setEngineUsed('cloud');
        setVoiceName(configRef.current.cloudVoice);
        pipeline.finish(text);
        return;
      }
      if (configRef.current.engine === 'cloud') {
        setError('还没有填硅基流动的 Key，现在用系统语音。');
      }
      speakSystem(speechText(text, 6000));
    },
    [pipeline, speakSystem],
  );

  const speak = useCallback(
    async (text: string) => {
      stop();
      finish(text);
    },
    [stop, finish],
  );

  useEffect(() => {
    if (!speechSupported()) return;
    // 语音列表是异步到达的，晚一点再看一眼名字。
    const timer = setTimeout(
      () => setVoiceName(chooseVoice(listVoices(), config.voiceURI)?.name ?? ''),
      600,
    );
    return () => clearTimeout(timer);
  }, [config.voiceURI]);

  // 关掉开关或窗口卸载时立刻住口：留一段声音在后台继续念是最失礼的失败方式。
  useEffect(() => {
    if (!enabled) stop();
    return stop;
  }, [enabled, stop]);

  return {
    speak,
    push,
    finish,
    stop,
    speaking,
    supported: tts.status === 'ready' || speechSupported(),
    voiceName,
    engineUsed,
    error,
  };
}
