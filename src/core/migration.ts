import { z } from 'zod';
import { persistedSchema, type PersistedState } from './schema';

/**
 * F-13 数据版本迁移框架。
 *
 * 当前只有 v1。关键是区分「文件损坏」与「数据来自更新版本」：
 * 后者绝不能被当成损坏数据覆盖，必须让用户升级应用。
 */
const versionProbe = z.object({ version: z.number().int().positive() });
export const currentDataVersion = 1;

export type MigrationResult = { ok: true; state: PersistedState } | { ok: false; error: string };

export function readPersisted(raw: unknown): MigrationResult {
  const probe = versionProbe.safeParse(raw);
  if (!probe.success) {
    return { ok: false, error: '本地数据格式无法识别：缺少有效的 version 字段。' };
  }
  const version = probe.data.version;
  if (version > currentDataVersion) {
    return {
      ok: false,
      error: `数据版本 v${version} 高于当前应用支持的 v${currentDataVersion}。请升级应用后再打开，原文件已保留。`,
    };
  }
  if (version < currentDataVersion) {
    return { ok: false, error: `不支持的数据版本 v${version}，原文件已保留。` };
  }
  const parsed = persistedSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: '本地数据字段不合法或缺失；原文件已保留，未做猜测性迁移。' };
  }
  return { ok: true, state: parsed.data };
}
