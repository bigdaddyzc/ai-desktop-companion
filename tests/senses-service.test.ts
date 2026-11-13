import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultSenses, emptyReading } from '../src/core/senses';
import { SensesService, SensesStore } from '../src/desktop/senses';

async function tempPath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'xinban-senses-')), name);
}

describe('SensesStore', () => {
  it('文件不存在时全关', async () => {
    const store = new SensesStore(await tempPath('senses-v1.json'));
    expect(await store.load()).toEqual(defaultSenses);
  });

  it('存进去的开关能原样读回来', async () => {
    const path = await tempPath('senses-v1.json');
    const store = new SensesStore(path);
    await store.save({ voice: true, ears: true, eyes: false });
    expect(await store.load()).toEqual({ voice: true, ears: true, eyes: false });
    // 落盘格式要能被人眼核对：版本号 + 三个开关，不多不少。
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      voice: true,
      ears: true,
      eyes: false,
    });
  });

  it('文件被手改坏时回落全关，而不是抛错', async () => {
    const path = await tempPath('senses-v1.json');
    await writeFile(path, '{ not json', 'utf8');
    expect(await new SensesStore(path).load()).toEqual(defaultSenses);
  });

  it('多出来的字段不影响读取', async () => {
    const path = await tempPath('senses-v1.json');
    await writeFile(path, JSON.stringify({ version: 1, ears: true, extra: 1 }), 'utf8');
    // strict schema 不认这个字段：整份回落，但不会崩。
    expect(await new SensesStore(path).load()).toEqual(defaultSenses);
  });
});

describe('SensesService', () => {
  it('没保存成功就不改内存：界面不能显示一个重启就消失的状态', async () => {
    const store = new SensesStore(await tempPath('senses-v1.json'));
    const service = new SensesService(store);
    await service.init();
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('磁盘满'));
    const result = await service.save({ voice: false, ears: true, eyes: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有保存成功');
    expect(service.snapshot().config.ears).toBe(false);
  });

  it('开关保存后会广播给两个窗口', async () => {
    const service = new SensesService(new SensesStore(await tempPath('senses-v1.json')));
    await service.init();
    const listener = vi.fn();
    service.subscribe(listener);
    await service.save({ voice: true, ears: true, eyes: false });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ config: { voice: true, ears: true, eyes: false } }),
    );
  });

  it('关掉的通道不接受上报：采集停了，界面就不能还写着「正在听」', async () => {
    const service = new SensesService(new SensesStore(await tempPath('senses-v1.json')));
    await service.init();
    await service.save({ voice: false, ears: false, eyes: false });
    service.report({ mic: 'live', camera: 'live', level: 0.9, speaking: true, at: 1 }, 2);
    const { reading } = service.snapshot();
    expect(reading.mic).toBe('off');
    expect(reading.camera).toBe('off');
    expect(reading.speaking).toBe(false);
    expect(reading.level).toBe(0);
  });

  it('「有人吗」由主进程按同一套规则算，不信任上报的布尔值', async () => {
    const service = new SensesService(new SensesStore(await tempPath('senses-v1.json')));
    await service.init();
    await service.save({ voice: false, ears: false, eyes: true });
    service.report({ camera: 'live', present: true, lastMotionAt: 1_000, at: 1_000 }, 1_100);
    expect(service.snapshot().reading.present).toBe(true);
    // 三分钟之后再上报一次（画面已经不动的旧时间戳），不能还坚持「有人」。
    service.report({ camera: 'live', present: true, lastMotionAt: 1_000, at: 181_000 }, 181_000);
    expect(service.snapshot().reading.present).toBe(false);
  });

  it('状态翻转立刻广播，纯数值变化按 800ms 节流', async () => {
    const service = new SensesService(new SensesStore(await tempPath('senses-v1.json')));
    await service.init();
    await service.save({ voice: false, ears: true, eyes: false });
    const listener = vi.fn();
    service.subscribe(listener);

    service.report({ mic: 'live', level: 0.2, speaking: false, at: 1_000 }, 1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    // 同样的状态、只过了 100ms：不重复广播。
    service.report({ mic: 'live', level: 0.22, speaking: false, at: 1_100 }, 1_100);
    expect(listener).toHaveBeenCalledTimes(1);
    // 开口了：必须立刻广播，慢半秒就失去打断的意义。
    service.report({ mic: 'live', level: 0.6, speaking: true, at: 1_200 }, 1_200);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('关掉开关时把读数清干净，但保留「最后一次看到人」', async () => {
    const service = new SensesService(new SensesStore(await tempPath('senses-v1.json')));
    await service.init();
    await service.save({ voice: false, ears: true, eyes: true });
    service.report(
      { mic: 'live', camera: 'live', level: 0.5, speaking: true, lastMotionAt: 900, at: 1_000 },
      1_000,
    );
    await service.save({ voice: false, ears: false, eyes: false });
    const { reading } = service.snapshot();
    expect(reading.mic).toBe('off');
    expect(reading.speaking).toBe(false);
    expect(reading.level).toBe(0);
    expect(reading.lastMotionAt).toBe(900);
    expect(reading.present).toBe(false);
  });

  it('采集端关闭后读数归零，不留一个不会更新的「开着」', async () => {
    const service = new SensesService(new SensesStore(await tempPath('senses-v1.json')));
    await service.init();
    service.clear(5_000);
    expect(service.snapshot().reading).toEqual({ ...emptyReading(), at: 5_000 });
  });
});
