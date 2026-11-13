import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VisionService, VisionStore } from '../src/desktop/vision';
import type { AiCredentialStore } from '../src/desktop/ai-credentials';
import type { VisionFrame } from '../src/core/vision';
import { defaultVision } from '../src/core/vision';

/** 只实现 `load` 的假凭据：看画面这一侧只读不写。 */
function credentials(value: { baseUrl: string; model: string; apiKey: string } | null) {
  return { load: async () => value } as unknown as AiCredentialStore;
}

const stored = { baseUrl: 'https://api.siliconflow.cn/v1', model: 'x', apiKey: 'sk-test-1234' };

function frame(): VisionFrame {
  return { jpeg: new Uint8Array([1, 2, 3, 4]), width: 1280, height: 800 };
}

function capture(frames: VisionFrame[], cameraFrames: VisionFrame[] = frames) {
  return { screen: async () => frames, camera: async () => cameraFrames };
}

function described(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const directories: string[] = [];

async function tempPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-vision-'));
  directories.push(directory);
  return join(directory, 'vision-v1.json');
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('VisionStore', () => {
  it('第一次读就是「不许看」，不报错', async () => {
    const store = new VisionStore(await tempPath());
    expect(await store.load()).toMatchObject({ allowScreen: false, allowCamera: false });
  });

  it('存下来的开关读得回来，字段写全', async () => {
    const path = await tempPath();
    const store = new VisionStore(path);
    await store.save({
      allowScreen: true,
      allowCamera: true,
      model: 'Qwen/Qwen2.5-VL-7B-Instruct',
    });
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw).toEqual({
      version: 1,
      allowScreen: true,
      allowCamera: true,
      model: 'Qwen/Qwen2.5-VL-7B-Instruct',
    });
    expect(await store.load()).toMatchObject({ allowScreen: true, allowCamera: true });
  });
});

describe('VisionService', () => {
  it('没允许的时候连截图都不做', async () => {
    const fetchImpl = vi.fn();
    const screen = vi.fn();
    const service = new VisionService(
      new VisionStore(await tempPath()),
      credentials(stored),
      fetchImpl as unknown as typeof fetch,
      { screen, camera: screen },
    );
    await service.init();
    const result = await service.look({ source: 'screen' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('还没允许');
    expect(screen).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('允许了但没 Key：说明去哪填，不发请求', async () => {
    const fetchImpl = vi.fn();
    const service = new VisionService(
      new VisionStore(await tempPath()),
      credentials(null),
      fetchImpl as unknown as typeof fetch,
      capture([frame()]),
    );
    await service.init();
    const saved = await service.save({
      allowScreen: true,
      allowCamera: false,
      model: 'Qwen/Qwen3-VL-8B-Instruct',
    });
    expect(saved.ok).toBe(true);
    const result = await service.look({ source: 'screen' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('Key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('截不到画面时明确说没截到，而不是编一段描述', async () => {
    const service = new VisionService(
      new VisionStore(await tempPath()),
      credentials(stored),
      vi.fn() as unknown as typeof fetch,
      capture([]),
    );
    await service.init();
    await service.save({
      allowScreen: true,
      allowCamera: false,
      model: 'Qwen/Qwen3-VL-8B-Instruct',
    });
    const result = await service.look({ source: 'screen' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('没截到');
  });

  it('成功时把 base64 图与问题发出去，回来的描述带时间说明', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return described('一个代码编辑器，中间有一行红色报错。');
    });
    const service = new VisionService(
      new VisionStore(await tempPath()),
      credentials(stored),
      fetchImpl as unknown as typeof fetch,
      capture([frame()]),
    );
    await service.init();
    await service.save({
      allowScreen: true,
      allowCamera: false,
      model: 'Qwen/Qwen3-VL-8B-Instruct',
    });

    const result = await service.look({ source: 'screen', question: '报错说的是什么' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.text).toContain('一帧静态画面');
    expect(result.text).toContain('红色报错');
    expect(result.note).toBe('1280×800');

    const [request] = requests;
    expect(request!.url).toBe('https://api.siliconflow.cn/v1/chat/completions');
    const body = JSON.parse(String(request!.init.body));
    expect(body.model).toBe('Qwen/Qwen3-VL-8B-Instruct');
    expect(JSON.stringify(body)).toContain('data:image/jpeg;base64,AQIDBA==');
    expect(JSON.stringify(body)).toContain('报错说的是什么');
    expect(request!.init.headers).toMatchObject({ Authorization: 'Bearer sk-test-1234' });
    // 描述留在内存里给面板看，不落盘。
    expect(service.snapshot().lastText).toContain('红色报错');
    expect(service.snapshot().status).toBe('ready');
  });

  it('401 时提醒这和填字的是同一把 Key', async () => {
    const service = new VisionService(
      new VisionStore(await tempPath()),
      credentials(stored),
      (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
      capture([frame()]),
    );
    await service.init();
    await service.save({
      allowScreen: true,
      allowCamera: false,
      model: 'Qwen/Qwen3-VL-8B-Instruct',
    });
    const result = await service.look({ source: 'screen' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('Key');
    expect(service.snapshot().lastError).toContain('Key');
  });

  it('403 时把对方给的原始原因带出来，不让用户瞎猜', async () => {
    const service = new VisionService(
      new VisionStore(await tempPath()),
      credentials(stored),
      (async () =>
        new Response(JSON.stringify({ error: { message: '该模型需要付费或实名认证' } }), {
          status: 403,
        })) as unknown as typeof fetch,
      capture([frame()]),
    );
    await service.init();
    await service.save({ allowScreen: true, allowCamera: false, model: defaultVision.model });
    const result = await service.look({ source: 'screen' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('免费档');
    expect(result.error).toContain('该模型需要付费或实名认证');
    expect(service.snapshot().lastError).toContain('该模型需要付费或实名认证');
  });

  it('对方回了但没有描述：当作失败，不把空话当观测', async () => {
    const service = new VisionService(
      new VisionStore(await tempPath()),
      credentials(stored),
      (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
          status: 200,
        })) as unknown as typeof fetch,
      capture([frame()]),
    );
    await service.init();
    await service.save({
      allowScreen: true,
      allowCamera: false,
      model: 'Qwen/Qwen3-VL-8B-Instruct',
    });
    const result = await service.look({ source: 'screen' });
    expect(result.ok).toBe(false);
  });

  it('连看两次会被冷却拦下：画面一秒内不会变，白花钱', async () => {
    const service = new VisionService(
      new VisionStore(await tempPath()),
      credentials(stored),
      (async () => described('桌面')) as unknown as typeof fetch,
      capture([frame()]),
    );
    await service.init();
    await service.save({
      allowScreen: true,
      allowCamera: false,
      model: 'Qwen/Qwen3-VL-8B-Instruct',
    });
    expect((await service.look({ source: 'screen' })).ok).toBe(true);
    const second = await service.look({ source: 'screen' });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error).toContain('刚看过');
  });

  it('保存会广播，开关立刻反映在快照里', async () => {
    const service = new VisionService(
      new VisionStore(await tempPath()),
      credentials(stored),
      vi.fn() as unknown as typeof fetch,
      capture([frame()]),
    );
    await service.init();
    const seen: boolean[] = [];
    const off = service.subscribe((snapshot) => seen.push(snapshot.config.allowCamera));
    await service.save({
      allowScreen: false,
      allowCamera: true,
      model: 'Qwen/Qwen3-VL-8B-Instruct',
    });
    off();
    expect(seen).toContain(true);
    expect(service.snapshot().config.allowCamera).toBe(true);
  });

  it('保存不合规的值直接拒绝，不写盘', async () => {
    const path = await tempPath();
    const service = new VisionService(
      new VisionStore(path),
      credentials(stored),
      vi.fn() as unknown as typeof fetch,
      capture([frame()]),
    );
    await service.init();
    const result = await service.save({ allowScreen: 'true' });
    expect(result.ok).toBe(false);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });
});
