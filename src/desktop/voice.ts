import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeJsonAtomic } from './atomic';
import {
  defaultVoice,
  normalizeVoice,
  voicePackOrder,
  voiceLimits,
  type VoiceConfig,
} from '../core/voice';

/**
 * 语音包的持久化与广播。
 *
 * 只存「怎么念」：包、音色 URI、语速、音调。音色列表在渲染进程里（`speechSynthesis`），
 * 主进程拿不到也不该拿——它不负责发声。这样开关和音色都跟着系统走，不需要额外权限。
 *
 * 写只允许来自控制面板：小屏上错点一下就把嗓子换掉，太容易了。
 */

const storedSchema = z
  .object({
    version: z.literal(1),
    // 'local' 是已删除的本地合成留下的旧值，读入后由 normalizeVoice 迁回云端。
    engine: z.enum(['local', 'cloud', 'system']).optional(),
    pack: z.enum(voicePackOrder as [string, ...string[]]).optional(),
    voiceURI: z.string().max(voiceLimits.voiceUriChars).optional(),
    cloudVoice: z.string().max(40).optional(),
    rate: z.number().optional(),
    pitch: z.number().optional(),
  })
  .strict();

// 这里只查「类型对不对」，不查范围：越界值统一交给 `normalizeVoice` 夹住。
// 两处都查会让策略分叉——文件里能夹、接口里报错，用户只会看到「保存失败」却不知道为什么。
// 引擎与云音色留成可选：老版本存下来的文件里没有这两个字段，缺了就该回默认，而不是拒收。
const saveSchema = z.object({
  engine: z.enum(['cloud', 'system']).optional(),
  pack: z.enum(voicePackOrder as [string, ...string[]]),
  voiceURI: z.string().max(voiceLimits.voiceUriChars),
  cloudVoice: z.string().max(40).optional(),
  rate: z.number(),
  pitch: z.number(),
});

export class VoiceStore {
  constructor(private readonly path: string) {}

  async load(): Promise<VoiceConfig> {
    try {
      return normalizeVoice(storedSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))));
    } catch {
      // 不存在、损坏、字段被手改都当没配。默认值本身是可用的，不该因此报错。
      return defaultVoice();
    }
  }

  async save(config: VoiceConfig): Promise<void> {
    await writeJsonAtomic(this.path, {
      version: 1,
      engine: config.engine,
      pack: config.pack,
      voiceURI: config.voiceURI,
      cloudVoice: config.cloudVoice,
      rate: config.rate,
      pitch: config.pitch,
    });
  }
}

export interface VoiceSaveResult {
  ok: boolean;
  error?: string;
  config?: VoiceConfig;
}

export class VoiceService {
  private config: VoiceConfig = defaultVoice();
  private readonly listeners = new Set<(config: VoiceConfig) => void>();

  constructor(private readonly store: VoiceStore) {}

  async init(): Promise<void> {
    this.config = await this.store.load();
  }

  snapshot(): VoiceConfig {
    return { ...this.config };
  }

  subscribe(listener: (config: VoiceConfig) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    const config = this.snapshot();
    for (const listener of this.listeners) listener(config);
  }

  /** 先落盘成功再改内存：写失败却显示「已保存」，用户下一句就会听到旧嗓子。 */
  async save(input: unknown): Promise<VoiceSaveResult> {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: '语音设置的值不对。' };
    const next = normalizeVoice(parsed.data);
    try {
      await this.store.save(next);
    } catch {
      return { ok: false, error: '语音设置没有保存成功，请重试。' };
    }
    this.config = next;
    this.publish();
    return { ok: true, config: next };
  }
}
