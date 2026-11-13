import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { isAllowedEndpoint } from '../core/ai';
import {
  audioFileName,
  cleanTranscript,
  defaultStt,
  normalizeStt,
  sttAllowedHosts,
  sttDefaults,
  sttErrorText,
  sttStatusOf,
  transcribeEndpoint,
  type SttConfig,
  type SttSnapshot,
} from '../core/stt';
import { AiCredentialStore } from './ai-credentials';
import { writeJsonAtomic } from './atomic';

/**
 * 语音转写的状态持有者与请求发送方。
 *
 * 为什么发送在主进程而不是渲染进程：
 *
 * - Key 只在主进程里解密，渲染进程从头到尾拿不到它（和对话那条链路同一个原则）；
 * - 出站白名单在这里拦一道，渲染进程就算被注入脚本也换不了目标主机；
 * - 音频是 `ArrayBuffer` 过 IPC，转完即丢，这里不缓存、不落盘。
 *
 * 这里**没有**任何「自动开始录音」的能力：录音只能由渲染进程在用户按住按钮时发起。
 */

const configSchema = z.object({ version: z.literal(1), enabled: z.boolean().optional() }).strict();

const keySchema = z.object({
  apiKey: z.string().trim().min(8).max(300),
});

export class SttConfigStore {
  constructor(private readonly path: string) {}

  async load(): Promise<SttConfig> {
    try {
      return normalizeStt(configSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))));
    } catch {
      return { ...defaultStt };
    }
  }

  async save(config: SttConfig): Promise<void> {
    await writeJsonAtomic(this.path, { version: 1, ...normalizeStt(config) });
  }
}

export type TranscribeResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * IPC 过来的音频不一定是 `ArrayBuffer`：结构化克隆在不同 Electron 版本上
 * 会把它还原成 `ArrayBuffer` 或 `Uint8Array`，甚至带 offset 的视图。
 * 这些都得能接住，否则「录完了没反应」会变成最难查的那种 bug。
 */
export function toAudioBytes(raw: unknown): ArrayBuffer | null {
  if (raw instanceof ArrayBuffer) return raw;
  if (ArrayBuffer.isView(raw)) {
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  }
  return null;
}

export class SttService {
  private config: SttConfig = { ...defaultStt };
  private credentials: { baseUrl: string; model: string; apiKey: string } | null = null;
  private active: AbortController | null = null;
  private lastText = '';
  private lastAt = 0;
  private lastError = '';
  private readonly listeners = new Set<(snapshot: SttSnapshot) => void>();

  constructor(
    private readonly store: SttConfigStore,
    private readonly credentials$: AiCredentialStore,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async init(): Promise<void> {
    this.config = await this.store.load();
    this.credentials = await this.credentials$.load();
  }

  snapshot(): SttSnapshot {
    return {
      config: this.config,
      status: sttStatusOf(this.config, this.credentials !== null),
      model: this.credentials?.model ?? sttDefaults.model,
      lastText: this.lastText,
      lastAt: this.lastAt,
      lastError: this.lastError,
    };
  }

  subscribe(listener: (snapshot: SttSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  /** 开关。先落盘成功再改内存，写失败不能假装打开了。 */
  async saveConfig(input: unknown): Promise<{ ok: boolean; error?: string }> {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(input);
    if (!parsed.success) return { ok: false, error: '开关的值不对。' };
    try {
      await this.store.save({ enabled: parsed.data.enabled });
    } catch {
      return { ok: false, error: '开关没有保存成功，请重试。' };
    }
    this.config = { enabled: parsed.data.enabled };
    if (!this.config.enabled) {
      this.stop();
      this.lastText = '';
    }
    this.publish();
    return { ok: true };
  }

  /**
   * 存 Key。加密交给 `AiCredentialStore`：系统加密不可用时它会抛错，
   * 这里原样转成一句人话，绝不降级成明文。
   */
  async saveKey(raw: unknown): Promise<{ ok: boolean; error?: string }> {
    const parsed = keySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'Key 看起来不完整，检查一下有没有复制全。' };
    try {
      await this.credentials$.save({
        baseUrl: sttDefaults.baseUrl,
        model: sttDefaults.model,
        apiKey: parsed.data.apiKey,
      });
    } catch {
      return { ok: false, error: '系统加密存储不可用，拒绝以明文保存 Key。' };
    }
    this.credentials = {
      baseUrl: sttDefaults.baseUrl,
      model: sttDefaults.model,
      apiKey: parsed.data.apiKey,
    };
    this.lastError = '';
    this.publish();
    return { ok: true };
  }

  async clearKey(): Promise<void> {
    await this.credentials$.clear();
    this.credentials = null;
    this.lastText = '';
    this.lastAt = 0;
    this.lastError = '';
    this.publish();
  }

  /** 关开关、重新按下、退出时丢掉还在飞的那一次转写。 */
  stop(): void {
    this.active?.abort();
    this.active = null;
  }

  /**
   * 把一段音频换成文字。
   *
   * 每一步拒绝都要给出「下一步该干什么」，因为这条链路的失败方式太多：
   * 没开、没 Key、按太短、太大、限流、断网。
   */

  async transcribe(audio: unknown, mime: unknown): Promise<TranscribeResult> {
    const fail = (error: string): TranscribeResult => {
      this.lastError = error;
      this.publish();
      return { ok: false, error };
    };
    if (!this.config.enabled) return fail('语音输入没打开。');
    if (this.active) return { ok: false, error: '上一段还在转写，请稍等。' };
    const credentials = this.credentials;
    if (credentials === null) return fail('还没有填硅基流动的 Key。');
    if (!(audio instanceof ArrayBuffer) && !ArrayBuffer.isView(audio)) {
      return fail('没收到音频。');
    }
    const bytes = toAudioBytes(audio);
    if (bytes === null) return fail('没收到音频。');
    if (bytes.byteLength < sttDefaults.minBytes) return fail('这段太短了，按住多说一会儿。');
    if (bytes.byteLength > sttDefaults.maxBytes) return fail('这段音频太大，说短一点。');

    let endpoint: string;
    try {
      endpoint = transcribeEndpoint(credentials.baseUrl);
    } catch {
      return fail('转写地址配置坏了，重置一下 Key。');
    }
    if (!isAllowedEndpoint(endpoint, sttAllowedHosts)) {
      return fail('转写地址不在白名单里，已拦下。');
    }

    const type = typeof mime === 'string' && mime.startsWith('audio/') ? mime : 'audio/webm';
    const form = new FormData();
    // 第三个参数是文件名：少了它，部分网关会直接 400。
    form.append('file', new Blob([bytes], { type }), audioFileName(type));
    form.append('model', credentials.model);

    const controller = new AbortController();
    this.active = controller;
    // stop() 会把 active 清掉：由此区分「用户取消」和「超时/断网」。
    const cancelled = (): boolean => this.active !== controller;
    const timer = setTimeout(() => controller.abort(), sttDefaults.timeoutMs);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (cancelled()) return { ok: false, error: '已取消转写。' };
      if (!response.ok) return fail(sttErrorText(response.status));
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return fail('对方回的格式看不懂，稍后再试。');
      }
      const raw = (body as { text?: unknown } | null)?.text;
      const text = cleanTranscript(typeof raw === 'string' ? raw : '');
      if (text === '') return fail('没听清，再说一遍？');
      this.lastText = text;
      this.lastAt = Date.now();
      this.lastError = '';
      this.publish();
      return { ok: true, text };
    } catch (error) {
      // abort 与断网在 fetch 里是同一个异常，但对用户是两件事：一个「太慢」，一个「没通」。
      const aborted = (error as { name?: unknown })?.name === 'AbortError';
      if (cancelled()) return { ok: false, error: '已取消转写。' };
      return fail(aborted ? '等太久了，这次没转出来。' : '网络没通，检查一下代理或防火墙。');
    } finally {
      clearTimeout(timer);
      if (this.active === controller) this.active = null;
    }
  }
}
