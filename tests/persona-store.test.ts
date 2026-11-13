import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonaService, PersonaStore } from '../src/desktop/persona';
import { defaultPersona } from '../src/core/persona';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'xinban-persona-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('性格存储', () => {
  it('没有文件时给默认性格，不报错', async () => {
    const store = new PersonaStore(join(root, 'persona-v1.json'));
    expect(await store.load()).toEqual(defaultPersona);
  });

  it('存进去的能原样读回来', async () => {
    const path = join(root, 'persona-v1.json');
    const store = new PersonaStore(path);
    await store.save({ ...defaultPersona, preset: 'dry', nickname: '阿超' });
    expect(await store.load()).toEqual({ ...defaultPersona, preset: 'dry', nickname: '阿超' });
    // 落盘是带版本的 JSON，不是随手一个对象。
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      preset: 'dry',
      nickname: '阿超',
      idleLines: [],
      face: defaultPersona.face,
    });
  });

  it('保存时顺带清洗：超长昵称被截断，空白被压平', async () => {
    const store = new PersonaStore(join(root, 'persona-v1.json'));
    await store.save({ ...defaultPersona, preset: 'warm', nickname: `  ${'长'.repeat(40)}  ` });
    expect((await store.load()).nickname).toHaveLength(12);
  });

  it('文件损坏就回退默认，不让应用起不来', async () => {
    const path = join(root, 'persona-v1.json');
    await writeFile(path, '{ 这不是 JSON', 'utf8');
    expect(await new PersonaStore(path).load()).toEqual(defaultPersona);
  });

  it('字段被手改成不认识的预设也回退默认', async () => {
    const path = join(root, 'persona-v1.json');
    await writeFile(path, JSON.stringify({ version: 1, preset: 'evil', nickname: 'x' }), 'utf8');
    expect(await new PersonaStore(path).load()).toEqual(defaultPersona);
  });

  it('写完之后不留临时文件', async () => {
    const store = new PersonaStore(join(root, 'persona-v1.json'));
    await store.save({ ...defaultPersona, preset: 'chill', nickname: '' });
    const files = await readdir(root);
    expect(files).toEqual(['persona-v1.json']);
  });
});

describe('性格服务', () => {
  it('init 之后快照就是磁盘上的那份', async () => {
    const path = join(root, 'persona-v1.json');
    await new PersonaStore(path).save({ ...defaultPersona, preset: 'chill', nickname: '阿超' });
    const service = new PersonaService(new PersonaStore(path));
    await service.init();
    expect(service.snapshot()).toEqual({ ...defaultPersona, preset: 'chill', nickname: '阿超' });
  });

  it('保存成功会广播，并把非法输入洗干净', async () => {
    const service = new PersonaService(new PersonaStore(join(root, 'persona-v1.json')));
    await service.init();
    const listener = vi.fn();
    service.subscribe(listener);
    const result = await service.save({ preset: 'warm', nickname: '  阿 超  ' });
    expect(result.ok).toBe(true);
    expect(result.config).toEqual({ ...defaultPersona, preset: 'warm', nickname: '阿 超' });
    expect(listener).toHaveBeenCalledWith({ ...defaultPersona, preset: 'warm', nickname: '阿 超' });
  });

  it('落盘失败时内存也不变：界面说没保存上，重启也不会偷偷变回去', async () => {
    // 用一个目录当文件路径，open 必然失败。
    const service = new PersonaService(new PersonaStore(root));
    await service.init();
    const listener = vi.fn();
    service.subscribe(listener);
    const result = await service.save({ preset: 'dry', nickname: '阿超' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有保存成功');
    expect(service.snapshot()).toEqual(defaultPersona);
    expect(listener).not.toHaveBeenCalled();
  });
});
