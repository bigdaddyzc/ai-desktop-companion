import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 原子写一个 JSON 文件。
 *
 * 先写临时文件再 rename：写到一半断电、进程被杀、磁盘满，用户看到的都是
 * 「上一次的完整内容」而不是「半个 JSON」。0o600 是因为这些文件都在用户
 * 家里，别的账户不该读。
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, JSON.stringify(value));
}

/** 同上，写任意文本（用户的配置文件、钩子脚本）。 */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
