import { copyFile, mkdir, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { attachmentLimits, kindOf, stagedName, type AttachmentInfo } from '../core/attachments';
import { isSecretPath } from '../core/file-roots';

export type StageResult = { ok: true; items: AttachmentInfo[] } | { ok: false; error: string };

/** 文本附件最多读多少字节去拼消息；再大就只给路径。 */
const readBytes = 1024 * 1024;

/**
 * 附件：把用户拖进来的文件复制到沙盒 uploads/，之后模型只碰副本。
 *
 * 复制而不是引用原路径：原文件可能在任何地方，而工具层只认沙盒和授权目录；
 * 副本也让「它改地方了」不会动到用户的原件。密钥类文件在这一步就拒收。
 */
export class AttachmentService {
  private readonly pending = new Map<string, AttachmentInfo>();
  private sequence = 0;

  constructor(
    private readonly workspaceRoot: string,
    private readonly now: () => number = Date.now,
  ) {}

  private get dir(): string {
    return join(this.workspaceRoot, 'uploads');
  }

  async stage(paths: readonly string[]): Promise<StageResult> {
    if (paths.length === 0) return { ok: false, error: '' };
    if (paths.length > attachmentLimits.maxFiles) {
      return { ok: false, error: `一次最多 ${attachmentLimits.maxFiles} 个文件。` };
    }
    const items: AttachmentInfo[] = [];
    await mkdir(this.dir, { recursive: true });
    for (const path of paths) {
      const name = basename(path);
      if (isSecretPath(path)) {
        return { ok: false, error: `${name} 像是密钥或凭据文件，芯伴不收。` };
      }
      const info = await stat(path).catch(() => null);
      if (!info?.isFile())
        return { ok: false, error: `${name} 不是文件（文件夹请在「授权目录」里加）。` };
      if (info.size > attachmentLimits.maxBytes) {
        return { ok: false, error: `${name} 超过 20 MB，太大了。` };
      }
      this.sequence += 1;
      const staged = stagedName(name, this.now(), this.sequence);
      try {
        await copyFile(path, join(this.dir, staged));
        // Windows 的复制会沿用原件的修改时间；清理按「什么时候拖进来的」算。
        const at = new Date(this.now());
        await utimes(join(this.dir, staged), at, at).catch(() => undefined);
      } catch {
        return { ok: false, error: `${name} 复制失败，可能被占用了。` };
      }
      const item: AttachmentInfo = {
        id: `a${this.now().toString(36)}${this.sequence.toString(36)}`,
        name,
        rel: `uploads/${staged}`,
        size: info.size,
        kind: kindOf(name),
      };
      this.pending.set(item.id, item);
      items.push(item);
    }
    // 只留最近一批：选了又没发的不必一直记着。
    for (const id of [...this.pending.keys()].slice(0, Math.max(0, this.pending.size - 30))) {
      this.pending.delete(id);
    }
    return { ok: true, items };
  }

  /** 发送时按 id 取回；不认识的 id 忽略——id 只可能来自刚才的 stage。 */
  take(ids: readonly string[]): AttachmentInfo[] {
    const items: AttachmentInfo[] = [];
    for (const id of ids.slice(0, attachmentLimits.maxFiles)) {
      const item = this.pending.get(id);
      if (item) items.push(item);
    }
    return items;
  }

  /** 文本附件读出来拼进消息；有 NUL 字节的当二进制、太大的只给路径。 */
  async texts(items: readonly AttachmentInfo[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const item of items) {
      if (item.kind !== 'text' || item.size > readBytes) continue;
      const buffer = await readFile(join(this.workspaceRoot, item.rel)).catch(() => null);
      if (buffer === null || buffer.includes(0)) continue;
      out.set(item.id, buffer.toString('utf8').replace(/^﻿/, ''));
    }
    return out;
  }

  /** 启动时清掉放了太久的副本。 */
  async prune(): Promise<void> {
    const cutoff = this.now() - attachmentLimits.keepDays * 86_400_000;
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      const path = join(this.dir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && info.mtimeMs < cutoff)
        await rm(path, { force: true }).catch(() => undefined);
    }
  }
}
