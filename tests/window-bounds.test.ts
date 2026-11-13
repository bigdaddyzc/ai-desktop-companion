import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WindowBoundsStore,
  boundsOf,
  clampBounds,
  windowBoundsSchema,
  type WorkArea,
} from '../src/desktop/window-bounds';

const primary: WorkArea = { x: 0, y: 0, width: 1920, height: 1080 };
const secondary: WorkArea = { x: 1920, y: -200, width: 1280, height: 1024 };
const fallback = { x: 1600, y: 700, width: 264, height: 330 };
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function fixture(): Promise<{ directory: string; path: string; store: WindowBoundsStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-bounds-'));
  directories.push(directory);
  const path = join(directory, 'window-bounds-v1.json');
  return { directory, path, store: new WindowBoundsStore(path) };
}

describe('窗口位置恢复', () => {
  it('没有保存值时使用默认位置', () => {
    expect(clampBounds(null, [primary], fallback)).toEqual(fallback);
  });

  it('保存的位置可见时恢复 x/y，尺寸仍由代码决定', () => {
    const saved = boundsOf({ x: 100, y: 200, width: 9999, height: 9999 });
    expect(clampBounds(saved, [primary], fallback)).toEqual({
      x: 100,
      y: 200,
      width: 264,
      height: 330,
    });
  });

  it('副显示器上的位置也保留', () => {
    const saved = boundsOf({ x: 2200, y: 100, width: 264, height: 330 });
    expect(clampBounds(saved, [primary, secondary], fallback)).toMatchObject({ x: 2200, y: 100 });
  });

  it('副显示器被移除后回到主显示器默认位置', () => {
    const saved = boundsOf({ x: 2200, y: 100, width: 264, height: 330 });
    expect(clampBounds(saved, [primary], fallback)).toEqual(fallback);
  });

  it('坐标明显越界时回到默认位置', () => {
    const saved = boundsOf({ x: -90000, y: -90000, width: 264, height: 330 });
    expect(clampBounds(saved, [primary], fallback)).toEqual(fallback);
  });

  it('没有可用工作区信息时回到默认位置', () => {
    const saved = boundsOf({ x: 100, y: 100, width: 264, height: 330 });
    expect(clampBounds(saved, [], fallback)).toEqual(fallback);
  });
});

describe('窗口位置数据校验', () => {
  it('拒绝非法或越界数值', () => {
    for (const value of [
      { version: 2, x: 1, y: 2, width: 264, height: 330 },
      { version: 1, x: 1.5, y: 2, width: 264, height: 330 },
      { version: 1, x: 1, y: 2, width: 0, height: 330 },
      { version: 1, x: 999_999, y: 2, width: 264, height: 330 },
      { version: 1, x: 1, y: 2, width: 264, height: 330, extra: true },
    ]) {
      expect(windowBoundsSchema.safeParse(value).success).toBe(false);
    }
  });

  it('接受合法的窗口几何', () => {
    expect(windowBoundsSchema.safeParse(boundsOf(fallback)).success).toBe(true);
  });
});

describe('窗口位置持久化', () => {
  it('保存后可读取，且写的是临时文件再原子替换', async () => {
    const { directory, store, path } = await fixture();
    const value = boundsOf({ x: 321, y: 654, width: 264, height: 330 });
    await store.save(value);
    expect(await store.load()).toEqual(value);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(value);
    expect(await readdir(directory)).toEqual(['window-bounds-v1.json']);
  });

  it('文件损坏时返回 null 且不覆盖原文件', async () => {
    const { store, path } = await fixture();
    const raw = '{broken bounds';
    await writeFile(path, raw, 'utf8');
    expect(await store.load()).toBeNull();
    expect(await readFile(path, 'utf8')).toBe(raw);
  });

  it('文件不存在时返回 null', async () => {
    const { store } = await fixture();
    expect(await store.load()).toBeNull();
  });

  it('版本不兼容时不把旧数据当成可恢复位置', async () => {
    const { store, path } = await fixture();
    await writeFile(
      path,
      JSON.stringify({ version: 99, x: 10, y: 20, width: 264, height: 330 }),
      'utf8',
    );
    expect(await store.load()).toBeNull();
  });
});
