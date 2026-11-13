import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryService, MemoryStore } from '../src/desktop/memory';
import { emptyMemory } from '../src/core/memory';

const now = 1_770_000_000_000;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-memory-'));
  directories.push(directory);
  return directory;
}

describe('记忆文件', () => {
  it('写进去的能在新实例里读回来', async () => {
    const directory = await workspace();
    const path = join(directory, 'memory-v1.json');
    const first = new MemoryService(new MemoryStore(path), () => now);
    await first.init();
    await first.remember('不吃香菜', 'preference');
    await first.applyExtraction({
      facts: [{ text: '在长沙做医院信息化工作', category: 'identity' }],
      episode: '聊了工作',
    });

    const second = new MemoryService(new MemoryStore(path), () => now + 1_000);
    await second.init();
    const state = second.snapshot();
    expect(state.facts).toHaveLength(2);
    expect(state.facts.map((fact) => fact.text)).toContain('不吃香菜');
    expect(state.episodes[0]?.summary).toBe('聊了工作');
  });

  it('文件不存在时给一份空记忆，而不是报错', async () => {
    const directory = await workspace();
    const service = new MemoryService(new MemoryStore(join(directory, 'nope.json')));
    await service.init();
    expect(service.snapshot()).toEqual(emptyMemory());
  });

  it('文件损坏时退化为空记忆，不抛错也不覆盖原文件', async () => {
    const directory = await workspace();
    const path = join(directory, 'memory-v1.json');
    await writeFile(path, '{ 这不是 JSON', 'utf8');
    const service = new MemoryService(new MemoryStore(path), () => now);
    await service.init();
    expect(service.snapshot().facts).toHaveLength(0);
    // 原文件保留：用户还可能手动捞回来。
    expect(await readFile(path, 'utf8')).toBe('{ 这不是 JSON');
  });

  it('保存是原子的，结束后不留临时文件', async () => {
    const directory = await workspace();
    const path = join(directory, 'memory-v1.json');
    const service = new MemoryService(new MemoryStore(path), () => now);
    await service.init();
    await service.remember('喜欢下雨天');
    const files = await readdir(directory);
    expect(files).toEqual(['memory-v1.json']);
    const info = await stat(path);
    expect(info.size).toBeGreaterThan(0);
  });

  it('数据文件里不出现明文 Key 之类的字段，只有记忆本身', async () => {
    const directory = await workspace();
    const path = join(directory, 'memory-v1.json');
    const service = new MemoryService(new MemoryStore(path), () => now);
    await service.init();
    await service.remember('在长沙工作', 'identity');
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('在长沙工作');
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('sk-');
  });
});

describe('记忆服务', () => {
  async function makeService(): Promise<MemoryService> {
    const directory = await workspace();
    const service = new MemoryService(
      new MemoryStore(join(directory, 'memory-v1.json')),
      () => now,
    );
    await service.init();
    return service;
  }

  it('记住之后立即出现在快照里，重复的会被合并', async () => {
    const service = await makeService();
    expect((await service.remember('不吃香菜', 'preference')).ok).toBe(true);
    const again = await service.remember('不吃香菜。');
    expect(again.note).toBe('已更新');
    expect(service.snapshot().facts).toHaveLength(1);
  });

  it('忘记支持模糊匹配，删除只影响指定那条', async () => {
    const service = await makeService();
    await service.remember('不吃香菜', 'preference');
    await service.remember('在长沙工作', 'identity');
    const { removed } = await service.forget('香菜');
    expect(removed).toEqual(['不吃香菜']);
    expect(service.snapshot().facts).toHaveLength(1);
    expect(service.search('长沙')[0]?.text).toBe('在长沙工作');
  });

  it('按 id 删除与整体清空都会落盘', async () => {
    const directory = await workspace();
    const path = join(directory, 'memory-v1.json');
    const service = new MemoryService(new MemoryStore(path), () => now);
    await service.init();
    await service.remember('不吃香菜');
    await service.applyExtraction({ facts: [], episode: '聊了晚饭' });
    const id = service.snapshot().facts[0]!.id;
    expect(await service.remove(id)).toBe(true);
    expect(await service.remove(id)).toBe(false);

    await service.clear();
    const reopened = new MemoryService(new MemoryStore(path), () => now);
    await reopened.init();
    expect(reopened.snapshot().facts).toHaveLength(0);
    expect(reopened.snapshot().episodes).toHaveLength(0);
  });

  it('关闭记忆后不再注入，也不再接收后台抽取', async () => {
    const service = await makeService();
    await service.remember('不吃香菜', 'preference');
    await service.setEnabled(false);
    expect(service.promptFor('晚上吃什么')).toBe('');
    const applied = await service.applyExtraction({
      facts: [{ text: '住在长沙', category: 'identity' }],
      episode: '聊了住哪',
    });
    expect(applied).toEqual({ facts: 0, episode: false });
    // 已有的记忆不删：关掉的是「继续记」和「拿来用」，不是销毁。
    expect(service.snapshot().facts).toHaveLength(1);
  });

  it('重新打开后又能注入，说明开关本身也持久化了', async () => {
    const directory = await workspace();
    const path = join(directory, 'memory-v1.json');
    const service = new MemoryService(new MemoryStore(path), () => now);
    await service.init();
    await service.remember('在长沙工作', 'identity');
    await service.setEnabled(false);

    const reopened = new MemoryService(new MemoryStore(path), () => now);
    await reopened.init();
    expect(reopened.snapshot().enabled).toBe(false);
    await reopened.setEnabled(true);
    expect(reopened.promptFor('在哪工作')).toContain('在长沙工作');
  });

  it('后台抽取写入的事实标记为 inferred，便于区分来源', async () => {
    const service = await makeService();
    await service.applyExtraction({
      facts: [{ text: '正在写医疗服务价格汇编', category: 'goal' }],
      episode: '聊了正在做的汇编',
    });
    expect(service.snapshot().facts[0]!.source).toBe('inferred');
    expect(service.snapshot().facts[0]!.category).toBe('goal');
  });

  it('订阅者能收到每次变化，界面不用手动刷新', async () => {
    const service = await makeService();
    const seen: number[] = [];
    service.subscribe((state) => seen.push(state.facts.length));
    await service.remember('不吃香菜');
    await service.remember('在长沙工作');
    expect(seen).toEqual([1, 2]);
  });
});
