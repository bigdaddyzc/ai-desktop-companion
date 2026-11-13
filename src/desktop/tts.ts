import { z } from 'zod';
import { isAllowedEndpoint } from '../core/ai';
import {
  cloudVoiceParam,
  normalizeGain,
  normalizeSpeed,
  speakable,
  ttsAllowedHosts,
  ttsDefaults,
  ttsEndpoint,
  ttsErrorText,
  ttsLimits,
  type TtsSnapshot,
} from '../core/tts';
import { AiCredentialStore } from './ai-credentials';

/**
 * 云端语音合成的发送方。
 *
 * 为什么在主进程：Key 只在主进程解密，渲染进程从头到尾拿不到它；出站白名单也在这里拦。
 * 渲染进程只递一段文字进来，拿一段 mp3 回去，中间的过程它一无所知。
 *
 * **不落盘**：合成出来的音频只在这条 IPC 上过一趟，播完就没了。
 * 想留住它得是另一个功能、另一次明确的同意。
 *
 * Key 与语音转写**共用**同一份：同一个硅基流动账号，用户填过一次就不该填第二次。
 * 这里只读不写——写入口在转写那边，避免两处各存一份、迟早不一致。
 */

const requestSchema = z.object({
  text: z.string().min(1),
  voice: z.string().min(1).max(80),
  speed: z.number(),
  gain: z.number(),
});

export type TtsResult =
  { ok: true; audio: ArrayBuffer; mime: string } | { ok: false; error: string };

export class TtsService {
  private keyed = false;
  private lastError = '';
  private lastAt = 0;
  private readonly listeners = new Set<(snapshot: TtsSnapshot) => void>();

  constructor(
    /** 只读同一份凭据文件；`save`/`clear` 一律不从这里调。 */
    private readonly credentials: AiCredentialStore,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async init(): Promise<void> {
    await this.refresh();
  }

  /**
   * 重探一次「有没有可用 Key」并广播。
   *
   * 不用每次合成都解一次 Key：解出来也没别的地方要用，只用一个布尔就够。
   * 转写那边存完 Key 会喊一声 `refresh`，两边就同步了。
   */
  async refresh(): Promise<void> {
    const stored = await this.credentials.load();
    this.keyed = stored !== null;
    this.publish();
  }

  snapshot(): TtsSnapshot {
    return {
      status: this.keyed ? 'ready' : 'no-key',
      model: ttsDefaults.model,
      lastError: this.lastError,
      lastAt: this.lastAt,
    };
  }

  subscribe(listener: (snapshot: TtsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  /**
   * 把一句话换成一段 mp3。
   *
   * 失败时一律给「下一步怎么办」，因为这条链路的断点都很具体：
   * 没 Key、限流、欠费、断网、文本过长。
   */
  async synthesize(input: unknown): Promise<TtsResult> {
    const fail = (error: string): TtsResult => {
      this.lastError = error;
      this.publish();
      return { ok: false, error };
    };

    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return fail('要念的内容不对。');
    const text = speakable(parsed.data.text);
    if (text === '') return fail('没有可念的内容。');

    const stored = await this.credentials.load();
    if (stored === null) return fail('还没有填硅基流动的 Key，先用系统语音。');
    if (!this.keyed) {
      this.keyed = true;
      this.publish();
    }

    let endpoint: string;
    try {
      endpoint = ttsEndpoint(stored.baseUrl || ttsDefaults.baseUrl);
    } catch {
      return fail('合成地址配置坏了，去「听懂你说话」那栏重填 Key。');
    }
    if (!isAllowedEndpoint(endpoint, ttsAllowedHosts)) {
      return fail('合成地址不在白名单里，已拦下。');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ttsLimits.timeoutMs);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stored.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: ttsDefaults.model,
          voice: cloudVoiceParam(parsed.data.voice),
          input: text,
          response_format: ttsDefaults.responseFormat,
          speed: normalizeSpeed(parsed.data.speed),
          gain: normalizeGain(parsed.data.gain),
        }),
        signal: controller.signal,
      });
      if (!response.ok) return fail(ttsErrorText(response.status));

      const type = response.headers.get('content-type') ?? '';
      // 有些网关出错时仍回 200，只是把 JSON 塞在 body 里。音频请求收到 JSON 就是失败。
      if (type.includes('application/json')) {
        return fail('对方回的是错误说明而不是音频，稍后再试。');
      }
      const audio = await response.arrayBuffer();
      if (audio.byteLength === 0) return fail('合成出来是空的，稍后再试。');

      this.lastError = '';
      this.lastAt = Date.now();
      this.publish();
      return { ok: true, audio, mime: 'audio/mpeg' };
    } catch (error) {
      // abort 与断网在 fetch 里是同一个异常，但对用户是两件事：一个「太慢」，一个「没通」。
      const aborted = (error as { name?: unknown })?.name === 'AbortError';
      return fail(aborted ? '合成等太久了，这次没出来。' : '网络没通，先用系统语音。');
    } finally {
      clearTimeout(timer);
    }
  }
}
