import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { AiPublicConfig } from '../core/ai';

/**
 * F-13 密钥 OS 保护存储。
 *
 * API Key 只在主进程内存中短暂出现，落盘前用 Electron safeStorage（Windows DPAPI）加密。
 * 绝不写入源码、state-v1.json、导出数据、日志或 renderer 可达的任何位置。
 * 系统加密不可用时拒绝保存，不降级为明文。
 */
export interface AiCrypto {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(payload: Buffer): string;
}

const storedSchema = z
  .object({
    version: z.literal(1),
    baseUrl: z.string().min(1).max(300),
    model: z.string().min(1).max(80),
    encryptedKey: z.string().min(1),
  })
  .strict();

export interface StoredCredentials extends AiPublicConfig {
  apiKey: string;
}

export class AiCredentialStore {
  constructor(
    private readonly path: string,
    private readonly crypto: AiCrypto,
  ) {}

  async load(): Promise<StoredCredentials | null> {
    try {
      const parsed = storedSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      return {
        baseUrl: parsed.baseUrl,
        model: parsed.model,
        apiKey: this.crypto.decrypt(Buffer.from(parsed.encryptedKey, 'base64')),
      };
    } catch {
      // 不存在、损坏、版本不兼容或无法解密都视为未配置，不覆盖原文件、不报错弹窗。
      return null;
    }
  }

  async save(value: StoredCredentials): Promise<void> {
    if (!this.crypto.available()) {
      throw new Error('系统加密存储不可用，拒绝以明文保存 API Key。');
    }
    const record = {
      version: 1,
      baseUrl: value.baseUrl,
      model: value.model,
      encryptedKey: this.crypto.encrypt(value.apiKey).toString('base64'),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(record), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /** 用户主动清除凭据：删除独立文件，不影响个人数据。 */
  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
