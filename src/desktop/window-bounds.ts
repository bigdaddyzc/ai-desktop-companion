import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * 桌面伙伴窗口几何。与个人业务数据分开存放：
 * - 不写入 state-v1.json，导出个人数据不含窗口位置；
 * - 文件损坏／版本不兼容时只回退默认位置，不进入个人数据的只读安全模式；
 * - 窗口尺寸始终由代码决定，保存值只用于恢复 x/y，避免旧文件把窗口撑坏。
 */
export const windowBoundsSchema = z
  .object({
    version: z.literal(1),
    x: z.number().int().min(-100_000).max(100_000),
    y: z.number().int().min(-100_000).max(100_000),
    width: z.number().int().positive().max(10_000),
    height: z.number().int().positive().max(10_000),
  })
  .strict();
export type WindowBounds = z.infer<typeof windowBoundsSchema>;

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 显示器被移除、分辨率变化或坐标明显越界时，回到当前主显示器工作区内的默认位置。
 * 判据为窗口中心点是否落在任一工作区；不试图做跨屏吸附或 DPI 补偿。
 */
export function clampBounds(
  saved: WindowBounds | null,
  areas: readonly WorkArea[],
  fallback: Rectangle,
): Rectangle {
  if (!saved) return fallback;
  const centerX = saved.x + fallback.width / 2;
  const centerY = saved.y + fallback.height / 2;
  const visible = areas.some(
    (area) =>
      centerX >= area.x &&
      centerX <= area.x + area.width &&
      centerY >= area.y &&
      centerY <= area.y + area.height,
  );
  return visible
    ? { x: saved.x, y: saved.y, width: fallback.width, height: fallback.height }
    : fallback;
}

export function boundsOf(rectangle: Rectangle): WindowBounds {
  return { version: 1, ...rectangle };
}

export class WindowBoundsStore {
  constructor(private readonly path: string) {}

  async load(): Promise<WindowBounds | null> {
    try {
      return windowBoundsSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch {
      // 不存在、损坏或版本不兼容都只回退默认；不覆盖原文件、不弹错误。
      return null;
    }
  }

  async save(value: WindowBounds): Promise<void> {
    const parsed = windowBoundsSchema.parse(value);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(parsed), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
