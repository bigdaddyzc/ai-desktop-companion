import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  defaultPersona,
  normalizePersona,
  personaPresetOrder,
  type PersonaConfig,
} from '../core/persona';
import { writeJsonAtomic } from './atomic';

/**
 * 性格配置的持久化。
 *
 * 只存三样：预设、昵称、屏幕标语。放 `persona-v1.json`，和记忆文件同一层目录，
 * 原子写、0o600。前两样会被拼进每一轮请求的 instructions，改动立刻生效；
 * 标语只影响桌面小屏，不进提示词。
 */

const storedSchema = z
  .object({
    version: z.literal(1),
    preset: z.enum(personaPresetOrder as [string, ...string[]]),
    nickname: z.string().max(64),
    // 旧文件没有这个字段：必须 optional，否则 .strict() 会让整次读取回落成默认，
    // 用户改过的性格会在升级后静默丢失。
    idleLines: z.array(z.string().max(64)).max(8).optional(),
    // 同理：旧文件没有表情偏好。内容由 normalizeFacePrefs 收口。
    face: z
      .object({
        style: z.string().max(20),
        off: z.array(z.string().max(20)).max(20),
        followChat: z.boolean(),
      })
      .partial()
      .optional(),
  })
  .strict();

export class PersonaStore {
  constructor(private readonly path: string) {}

  /** 文件不存在、损坏、字段不认识，一律回落到默认性格，不打扰用户。 */
  async load(): Promise<PersonaConfig> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return { ...defaultPersona };
    }
    try {
      const parsed = storedSchema.parse(JSON.parse(raw));
      return normalizePersona(parsed);
    } catch {
      return { ...defaultPersona };
    }
  }

  async save(config: PersonaConfig): Promise<void> {
    const clean = normalizePersona(config);
    await writeJsonAtomic(this.path, { version: 1, ...clean });
  }
}

export class PersonaService {
  private config: PersonaConfig = { ...defaultPersona };
  private readonly listeners = new Set<(config: PersonaConfig) => void>();

  constructor(private readonly store: PersonaStore) {}

  async init(): Promise<void> {
    this.config = await this.store.load();
  }

  snapshot(): PersonaConfig {
    return this.config;
  }

  subscribe(listener: (config: PersonaConfig) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 保存。**先落盘成功再改内存**：写失败时界面要能显示「没保存上」，
   * 而不是内存里变了、重启就变回去。
   */
  async save(input: unknown): Promise<{ ok: boolean; config: PersonaConfig; error?: string }> {
    // 只改传来的那几项：面板「性格」卡和「表情」卡各存各的，不互相覆盖。
    const patch = typeof input === 'object' && input !== null ? input : {};
    const next = normalizePersona({ ...this.config, ...patch });
    try {
      await this.store.save(next);
    } catch {
      return { ok: false, config: this.config, error: '性格设置没有保存成功，请重试。' };
    }
    this.config = next;
    for (const listener of this.listeners) listener(next);
    return { ok: true, config: next };
  }
}
