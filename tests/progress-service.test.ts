import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FsProgressSource,
  ProgressService,
  type ProgressFile,
  type ProgressSource,
} from '../src/desktop/progress';
import { progressWindow } from '../src/core/progress';

const now = 1_800_000_000_000;

interface FakeFile {
  file: ProgressFile;
  head: string;
  tail: string;
}

function jsonlMessage(text: string, at: number, role: 'user' | 'assistant' = 'user'): string {
  return JSON.stringify({
    type: 'message',
    role,
    timestamp: at,
    sessionId: 's',
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  });
}

function fakeSource(files: FakeFile[]): ProgressSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: async () => {
      calls.push('list');
      // 真实文件系统的 mtime 与大小会随内容变；这里用尾巴长度模拟，免得每个用例手改。
      return files.map((entry) => ({ ...entry.file, size: entry.head.length + entry.tail.length }));
    },
    head: async (path, bytes) => {
      calls.push(`head:${bytes}:${path}`);
      return files.find((entry) => entry.file.path === path)?.head ?? '';
    },
    tail: async (path, bytes) => {
      calls.push(`tail:${bytes}:${path}`);
      return files.find((entry) => entry.file.path === path)?.tail ?? '';
    },
  };
}

function makeFile(name: string, mtimeMs: number, text: string): FakeFile {
  return {
    file: { path: `/projects/demo/${name}.jsonl`, sessionId: name, mtimeMs, size: 0 },
    head: JSON.stringify({ type: 'ai-title', aiTitle: `任务 ${name}`, cwd: '/work/demo' }),
    tail: jsonlMessage(text, mtimeMs - 1_000),
  };
}

describe('ProgressService', () => {
  it('读出最近活跃会话，并只读头尾窗口', async () => {
    const source = fakeSource([makeFile('a', now - 5_000, '看看构建')]);
    const service = new ProgressService(source, () => now);
    const state = await service.scan();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]!.title).toBe('任务 a');
    expect(service.prompt()).toContain('任务 a');
    expect(source.calls).toContain(`head:${progressWindow.headChars}:/projects/demo/a.jsonl`);
    expect(source.calls).toContain(`tail:${progressWindow.tailChars}:/projects/demo/a.jsonl`);
  });

  it('只扫最近几个会话，旧的再活跃也不读', async () => {
    const source = fakeSource([
      makeFile('newest', now - 1_000, '一'),
      makeFile('second', now - 2_000, '二'),
      makeFile('third', now - 3_000, '三'),
      makeFile('fourth', now - 4_000, '四'),
      makeFile('ancient', now - 7 * 60 * 60_000, '五'),
    ]);
    const service = new ProgressService(source, () => now);
    const state = await service.scan();
    expect(state.sessions.map((session) => session.title)).toEqual([
      '任务 newest',
      '任务 second',
      '任务 third',
    ]);
    expect(source.calls).not.toContain('head:65536:/projects/demo/fourth.jsonl');
    expect(source.calls).not.toContain('head:65536:/projects/demo/ancient.jsonl');
  });

  it('内容没变化就不重复广播', async () => {
    const source = fakeSource([makeFile('a', now - 5_000, '继续')]);
    const service = new ProgressService(source, () => now);
    const listener = vi.fn();
    service.subscribe(listener);
    await service.scan();
    await service.scan();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('会话有新增时广播一次', async () => {
    const file = makeFile('a', now - 5_000, '继续');
    const source = fakeSource([file]);
    const service = new ProgressService(source, () => now);
    const listener = vi.fn();
    service.subscribe(listener);
    await service.scan();
    file.tail = jsonlMessage('又有新要求', now - 500);
    await service.scan();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(service.prompt()).toContain('又有新要求');
  });

  it('目录读不到时降级为「不知道」，不抛错', async () => {
    const broken: ProgressSource = {
      list: async () => {
        throw new Error('EACCES');
      },
      head: async () => '',
      tail: async () => '',
    };
    const service = new ProgressService(broken, () => now);
    const state = await service.scan();
    expect(state.sessions).toEqual([]);
    expect(state.error).not.toBe('');
    expect(service.prompt()).toBe('');
    expect(service.toolText()).toContain('读不到');
  });

  it('文件为空或全是坏行时跳过，不影响其他会话', async () => {
    const good = makeFile('good', now - 1_000, '正经内容');
    const broken: FakeFile = {
      file: {
        path: '/projects/demo/broken.jsonl',
        sessionId: 'broken',
        mtimeMs: now - 1_000,
        size: 13,
      },
      head: '',
      tail: 'garbage\n{broken',
    };
    const service = new ProgressService(fakeSource([broken, good]), () => now);
    const state = await service.scan();
    expect(state.sessions.map((session) => session.title)).toEqual(['任务 good']);
  });

  it('扫描还没结束时再次触发，直接返回上一次结果', async () => {
    const gateRef: { release: () => void } = { release: () => undefined };
    const gate = new Promise<void>((resolve) => {
      gateRef.release = resolve;
    });
    const source: ProgressSource = {
      list: async () => {
        await gate;
        return [makeFile('a', now - 1_000, '等等').file];
      },
      head: async () => '{"type":"ai-title","aiTitle":"任务 a","cwd":"/work/demo"}',
      tail: async () => jsonlMessage('等等', now - 1_000),
    };
    const service = new ProgressService(source, () => now);
    const first = service.scan();
    const second = await service.scan();
    expect(second.sessions).toHaveLength(0);
    gateRef.release();
    expect((await first).sessions).toHaveLength(1);
  });

  it('启动后立即扫一次，停止后不再扫', async () => {
    vi.useFakeTimers();
    try {
      const source = fakeSource([makeFile('a', now - 1_000, '干活')]);
      const service = new ProgressService(source, () => now);
      service.start(1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(source.calls.filter((call) => call === 'list')).toHaveLength(1);
      service.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(source.calls.filter((call) => call === 'list')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('文件没变时不重复读盘', async () => {
    const source = fakeSource([makeFile('a', now - 5_000, '第一次')]);
    const service = new ProgressService(source, () => now);
    await service.scan();
    const before = source.calls.length;
    await service.scan();
    // mtime 与大小都没变：只该再列一次目录，头尾一秒都不重读。
    expect(source.calls.slice(before)).toEqual(['list']);
  });

  it('目录监听：写入后不用等轮询就更新', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xinban-watch-'));
    const project = join(root, 'demo');
    await mkdir(project, { recursive: true });
    // 轮询间隔拉到一分钟：这段时间里能更新的，只可能是 watch 触发的。
    const service = new ProgressService(new FsProgressSource(root));
    const seen: string[] = [];
    service.subscribe((state) => {
      for (const session of state.sessions) seen.push(session.lastUserText);
    });
    try {
      service.start(60_000);
      expect(service.watching).toBe(true);
      await writeFile(
        join(project, 'a.jsonl'),
        `${jsonlMessage('盯着我看', Date.now() - 1_000)}\n`,
        'utf8',
      );
      await vi.waitFor(() => expect(seen).toContain('盯着我看'), { timeout: 5_000 });
    } finally {
      service.stop();
      await rm(root, { recursive: true, force: true });
    }
    expect(service.watching).toBe(false);
  }, 15_000);

  it('目录不存在时静默降级为纯轮询', async () => {
    const service = new ProgressService(
      new FsProgressSource(join(tmpdir(), 'xinban-no-such-dir-xyz')),
    );
    service.start(60_000);
    try {
      expect(service.watching).toBe(false);
      // start 自己会先扫一次；那次还没落地时手动 scan 会被并发保护挡回旧状态，
      // 所以这里等它真的报出「没有找到」。
      await vi.waitFor(() => expect(service.snapshot().error).toContain('没有找到'), {
        timeout: 3_000,
      });
      expect(service.snapshot().sessions).toEqual([]);
    } finally {
      service.stop();
    }
  });
});
