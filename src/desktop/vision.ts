import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeJsonAtomic } from './atomic';
import {
  defaultVision,
  normalizeVision,
  parseVision,
  visionAllowed,
  visionBody,
  visionDefaults,
  visionEndpoint,
  visionLimits,
  visionObservation,
  type VisionConfig,
  type VisionFrame,
  type VisionSnapshot,
  type VisionSource,
} from '../core/vision';
import type { AiCredentialStore } from './ai-credentials';

/**
 * 视觉服务的持久化与出站。
 *
 * 分工写死在这里：本模块只把「一帧画面」换成「一段文字」，不做推理、不算结论。
 * 结论交给 DeepSeek——它是纯文本模型，但文字它看得懂。
 *
 * 安全与隐私的落点：
 * - 截图与摄像头帧只在内存里过一趟，编码成 base64 发出去就丢，本机不留副本；
 * - Key 与语音转写、语音合成共用一份（同一个硅基流动账号），这里只读不写；
 * - 出站主机锁死 `api.siliconflow.cn`，换不了；
 * - 两个开关默认关，关了就连截图都不做——不是「截了不发」。
 */

const storedSchema = z
  .object({
    version: z.literal(1),
    allowScreen: z.boolean().optional(),
    allowCamera: z.boolean().optional(),
    model: z.string().max(80).optional(),
  })
  .strict();

const saveSchema = z.object({
  allowScreen: z.boolean(),
  allowCamera: z.boolean(),
  model: z.string().max(80),
});

const lookSchema = z.object({
  source: z.enum(['screen', 'camera', 'file']),
  /** source=file 时的绝对路径；工具层已经按读权限核过。 */
  path: z.string().max(1024).optional(),
  question: z
    .string()
    .max(visionLimits.questionChars * 4)
    .optional(),
});

export class VisionStore {
  constructor(private readonly path: string) {}

  async load(): Promise<VisionConfig> {
    try {
      return normalizeVision(storedSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))));
    } catch {
      // 不存在、损坏、字段被手改都当「不许看」。默认值本身就是拒绝，不该因此报错。
      return { ...defaultVision };
    }
  }

  async save(config: VisionConfig): Promise<void> {
    await writeJsonAtomic(this.path, {
      version: 1,
      allowScreen: config.allowScreen,
      allowCamera: config.allowCamera,
      model: config.model,
    });
  }
}

/** 帧的来源：屏幕由主进程截（一帧），摄像头得请渲染进程配合（连拍几帧）。 */
export interface VisionCapture {
  screen(): Promise<VisionFrame[]>;
  camera(): Promise<VisionFrame[]>;
  /** 读一张图片文件并压成 JPEG；打不开返回空数组。 */
  file?(path: string): Promise<VisionFrame[]>;
}

export type LookResult =
  { ok: true; text: string; note: string; source: VisionSource } | { ok: false; error: string };

/** HTTP 状态翻译成能让人动手的一句话；对方给的原始原因会附在后面。 */
export function visionErrorText(status: number, detail = ''): string {
  const base =
    status === 0
      ? '网络没通，没看到画面。'
      : status === 401 || status === 403
        ? '硅基流动拒绝了这次请求：Key 不对，或者这个模型档位要付费/实名——先去「它的眼睛」里换免费档试试。'
        : status === 402
          ? '硅基流动的额度用完了，去后台充值。'
          : status === 404
            ? '这个视觉模型不存在，去「它的眼睛」里换一个。'
            : status === 400
              ? '这次请求对方不接受，多半是模型名或图片太大。'
              : status === 429
                ? '看得太频繁被限流了，等几秒再看。'
                : status >= 500
                  ? '视觉服务暂时不可用，稍后再看。'
                  : `看画面失败（HTTP ${status}）。`;
  return detail === '' ? base : `${base}（对方说：${detail}）`;
}

/**
 * 对方返回体里的原始报错。Key 的问题十有八九写在这里（「模型需付费」「实名认证」），
 * 只给状态码翻译会让用户朝着错误的方向排查。
 */
export async function responseErrorDetail(response: Response): Promise<string> {
  try {
    const raw = (await response.text()).trim();
    if (raw === '') return '';
    try {
      const data = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
      const message = data.error?.message ?? data.message;
      if (typeof message === 'string' && message.trim() !== '') {
        return message.trim().slice(0, 120);
      }
    } catch {
      // 不是 JSON 就当纯文本摘一段，照样比「HTTP 403」有用。
    }
    return raw.slice(0, 120);
  } catch {
    // body 读不到就算了，状态码翻译还在。
    return '';
  }
}

export class VisionService {
  private config: VisionConfig = { ...defaultVision };
  private hasKey = false;
  private lastText = '';
  private lastError = '';
  private lastAt = 0;
  /** 上一次「看」的时刻，用来做冷却；与「上次成功」分开算。 */
  private lookedAt = 0;
  private busy = false;
  private active: AbortController | null = null;
  private readonly listeners = new Set<(snapshot: VisionSnapshot) => void>();

  constructor(
    private readonly store: VisionStore,
    /** 只读同一份凭据：写入口仍然只有「听懂你说话」那一处。 */
    private readonly credentials: AiCredentialStore,
    private readonly fetchImpl: typeof fetch,
    private readonly capture: VisionCapture,
  ) {}

  async init(): Promise<void> {
    this.config = await this.store.load();
    this.hasKey = (await this.credentials.load()) !== null;
  }

  snapshot(): VisionSnapshot {
    return {
      config: { ...this.config },
      status: this.hasKey ? 'ready' : 'no-key',
      lastText: this.lastText,
      lastError: this.lastError,
      lastAt: this.lastAt,
      busy: this.busy,
    };
  }

  subscribe(listener: (snapshot: VisionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  /** Key 存了或清了，能力跟着变——由主进程在凭据变化时调一次。 */
  async refresh(): Promise<void> {
    this.hasKey = (await this.credentials.load()) !== null;
    this.publish();
  }

  async save(input: unknown): Promise<{ ok: boolean; error?: string }> {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: '眼力设置的值不对。' };
    const next = normalizeVision(parsed.data);
    try {
      await this.store.save(next);
    } catch {
      return { ok: false, error: '眼力设置没有保存成功，请重试。' };
    }
    this.config = next;
    this.active?.abort();
    this.publish();
    return { ok: true };
  }

  /**
   * 看一眼。
   *
   * 失败一律给「下一步怎么办」，因为断点很具体：没允许、没 Key、没人接摄像头、
   * 限流、欠费、模型名不对。含糊成「看不了」只会让人以为功能坏了。
   */
  async look(input: unknown, signal?: AbortSignal): Promise<LookResult> {
    const parsed = lookSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: '要看什么没说清。' };
    const source: VisionSource = parsed.data.source;
    const question = parsed.data.question ?? '';

    if (!visionAllowed(this.config, source)) {
      return {
        ok: false,
        error:
          source === 'screen'
            ? '用户还没允许我看屏幕，去控制面板「它的眼睛」里打开。'
            : '用户还没允许我看摄像头，去控制面板「它的眼睛」里打开。',
      };
    }
    if (this.busy) return { ok: false, error: '上一次还没看完，等一下。' };
    const now = Date.now();
    if (now - this.lookedAt < visionLimits.cooldownMs) {
      return { ok: false, error: '刚看过一眼，隔一秒再看，画面也不会变。' };
    }

    if (signal?.aborted) return { ok: false, error: '已取消。' };
    const stored = await this.credentials.load();
    if (this.busy) return { ok: false, error: '上一次还没看完，等一下。' };
    this.hasKey = stored !== null;
    if (stored === null) {
      return { ok: false, error: '还没填硅基流动的 Key，看不了画面。' };
    }
    let endpoint: string;
    try {
      endpoint = visionEndpoint(stored.baseUrl || visionDefaults.baseUrl);
    } catch {
      return { ok: false, error: '接口地址配置坏了，去「听懂你说话」那栏重填 Key。' };
    }
    const hosts: readonly string[] = visionDefaults.allowedHosts;
    if (!hosts.includes(new URL(endpoint).hostname)) {
      return { ok: false, error: '出站地址不在白名单里，已拦下。' };
    }

    this.busy = true;
    this.lookedAt = now;
    this.publish();
    const controller = new AbortController();
    this.active = controller;
    const timer = setTimeout(() => controller.abort(), visionLimits.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const startedAt = Date.now();
    const fail = (error: string): LookResult => {
      this.lastError = error;
      return { ok: false, error };
    };

    try {
      combined.throwIfAborted();
      if (!visionAllowed(this.config, source)) return fail('权限已关闭。');
      const captured =
        source === 'file'
          ? parsed.data.path && this.capture.file
            ? await this.capture.file(parsed.data.path)
            : []
          : source === 'screen'
            ? await this.capture.screen()
            : await this.capture.camera();
      combined.throwIfAborted();
      if (!visionAllowed(this.config, source)) return fail('权限已关闭。');
      // 屏幕不会动，多给几张只是把同一张图重发；摄像头按上限截断兜底。
      const frames = captured.slice(0, source === 'camera' ? visionLimits.maxFrames : 1);
      if (frames.length === 0) {
        return fail(
          source === 'file'
            ? '这张图片打不开（格式不支持或文件坏了）。'
            : source === 'screen'
              ? '这次没截到屏幕，可能是屏幕正在锁屏或切换。'
              : '这次没拿到摄像头画面，检查一下摄像头有没有被别的程序占着。',
        );
      }
      if (frames.some((frame) => frame.jpeg.byteLength > visionLimits.frameBytes)) {
        return fail('画面太大了，压缩没生效，这次不发了。');
      }

      const body = visionBody({
        model: this.config.model,
        source,
        base64: frames.map((frame) => Buffer.from(frame.jpeg).toString('base64')),
        question,
      });
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stored.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combined,
      });
      if (!response.ok) {
        return fail(visionErrorText(response.status, await responseErrorDetail(response)));
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return fail('对方回的不是能读的内容，稍后再看。');
      }
      combined.throwIfAborted();
      const text = parseVision(data);
      if (text === '') return fail('视觉模型没给出描述，换一帧再看一次。');

      this.lastText = text;
      this.lastError = '';
      this.lastAt = Date.now();
      const first = frames[0]!;
      return {
        ok: true,
        source,
        text: visionObservation({
          source,
          text,
          ageMs: this.lastAt - startedAt,
          at: this.lastAt,
          frames: frames.length,
        }),
        note: `${first.width}×${first.height}${frames.length > 1 ? ` × ${frames.length} 帧` : ''}`,
      };
    } catch (error) {
      const aborted = (error as { name?: unknown })?.name === 'AbortError';
      return fail(aborted ? '看画面等太久了或已取消，这次没看到。' : '网络没通，看不到画面。');
    } finally {
      clearTimeout(timer);
      if (this.active === controller) this.active = null;
      this.busy = false;
      this.publish();
    }
  }
}
