import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult, Snapshot } from '../src/core/schema';
import type { ConfirmRequest } from '../src/core/confirm';
import { FileAccessService } from '../src/desktop/files';
import { ToolExecutor, type ToolHost } from '../src/desktop/tools';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-files-'));
  directories.push(directory);
  return directory;
}

const signal = new AbortController().signal;

async function setup(options: { writable?: boolean; allow?: boolean } = {}) {
  const base = await temp();
  const sandbox = join(base, 'sandbox');
  const project = join(base, 'project');
  const data = join(base, 'userData');
  await mkdir(sandbox, { recursive: true });
  await mkdir(project, { recursive: true });
  const files = new FileAccessService(
    {
      config: join(data, 'file-roots-v1.json'),
      changes: join(data, 'file-changes-v1.json'),
      backups: join(data, 'file-backups'),
    },
    { home: join(base, 'home'), userData: data, appDir: join(base, 'app') },
  );
  await files.load();
  expect(await files.add(project, options.writable ?? true)).toEqual({ ok: true });
  const asked: ConfirmRequest[] = [];
  const host: ToolHost = {
    postJson: () => Promise.resolve({ ok: true, status: 200, data: {} }),
    snapshot: () =>
      ({ state: { todos: [], timer: null }, storageError: null }) as unknown as Snapshot,
    dispatch: () => Promise.resolve({ ok: true } as CommandResult),
    memory: {
      remember: () => Promise.resolve({ ok: true, output: '', note: '' }),
      forget: () => Promise.resolve({ removed: [], candidates: [] }),
      search: () => [],
    },
    confirm: (request) => {
      asked.push(request);
      return Promise.resolve(options.allow ?? true);
    },
    files: {
      roots: () => files.roots(),
      revision: () => files.revision(),
      commit: (input, signal) => files.commit(input, signal),
    },
  };
  const executor = new ToolExecutor(host, sandbox);
  const call = (name: string, args: Record<string, unknown>) =>
    executor.run({ callId: 'c', name, arguments: JSON.stringify(args) }, signal);
  return { project, sandbox, files, asked, call };
}

describe('授权目录：读写与撤销', () => {
  it('按目录名读文件，也认落在里面的绝对路径', async () => {
    const { project, call } = await setup();
    await writeFile(join(project, 'a.md'), '你好', 'utf8');
    const byName = await call('read_file', { root: 'project', path: 'a.md' });
    expect(byName.output).toContain('你好');
    const byPath = await call('read_file', { path: join(project, 'a.md') });
    expect(byPath.output).toContain('你好');
    const listed = await call('list_files', { root: 'PROJECT' });
    expect(listed.output).toContain('a.md');
  });

  it('不在授权目录里的路径、不存在的目录名都拒绝，并列出能用的', async () => {
    const { call } = await setup();
    const outside = await call('read_file', { path: join(tmpdir(), 'elsewhere.txt') });
    expect(outside.trace.status).toBe('error');
    expect(outside.output).toContain('project');
    const unknown = await call('read_file', { root: 'nope', path: 'a.md' });
    expect(unknown.trace.status).toBe('error');
    const escape = await call('read_file', {
      root: 'project',
      path: '..\\userData\\file-roots-v1.json',
    });
    expect(escape.trace.status).toBe('error');
  });

  it('密钥类文件不读；.git 与可执行文件不写', async () => {
    const { project, call, asked } = await setup();
    await writeFile(join(project, '.env'), 'KEY=secret', 'utf8');
    const secret = await call('read_file', { root: 'project', path: '.env' });
    expect(secret.trace.status).toBe('error');
    expect(secret.output).not.toContain('secret');
    for (const path of ['.git\\config', 'run.ps1']) {
      const result = await call('write_file', { root: 'project', path, content: 'x' });
      expect(result.trace.status, path).toBe('error');
    }
    expect(asked).toHaveLength(0);
  });

  it('新建要确认，卡上有 diff；撤销把新建的删掉', async () => {
    const { project, call, asked, files } = await setup();
    const result = await call('write_file', {
      root: 'project',
      path: 'notes\\b.md',
      content: '第一行\n第二行',
    });
    expect(result.trace.status).toBe('ok');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.tool).toBe('write_file');
    expect(asked[0]!.detail).toContain('+ 第一行');
    expect(await readFile(join(project, 'notes', 'b.md'), 'utf8')).toBe('第一行\n第二行');
    const change = files.snapshot().changes[0]!;
    expect(change.action).toBe('created');
    expect(await files.undo(change.id)).toEqual({ ok: true });
    await expect(stat(join(project, 'notes', 'b.md'))).rejects.toThrow();
  });

  it('edit_file 只换唯一匹配的一段，保留 CRLF；撤销还原原文', async () => {
    const { project, call, asked, files } = await setup();
    const original = 'title\r\nalpha\r\nbeta\r\n';
    await writeFile(join(project, 'c.md'), original, 'utf8');
    const result = await call('edit_file', {
      root: 'project',
      path: 'c.md',
      old_text: 'alpha\nbeta',
      new_text: 'ALPHA\nbeta',
    });
    expect(result.trace.status).toBe('ok');
    expect(await readFile(join(project, 'c.md'), 'utf8')).toBe('title\r\nALPHA\r\nbeta\r\n');
    expect(asked[0]!.detail).toContain('- alpha');
    expect(asked[0]!.detail).toContain('+ ALPHA');
    expect(await files.undo(files.snapshot().changes[0]!.id)).toEqual({ ok: true });
    expect(await readFile(join(project, 'c.md'), 'utf8')).toBe(original);
  });

  it('edit_file 匹配不到或匹配多处时不动文件', async () => {
    const { project, call, asked } = await setup();
    await writeFile(join(project, 'd.md'), 'x\nx\n', 'utf8');
    expect(
      (await call('edit_file', { root: 'project', path: 'd.md', old_text: 'y', new_text: 'z' }))
        .trace.status,
    ).toBe('error');
    expect(
      (await call('edit_file', { root: 'project', path: 'd.md', old_text: 'x', new_text: 'z' }))
        .trace.status,
    ).toBe('error');
    expect(asked).toHaveLength(0);
    const all = await call('edit_file', {
      root: 'project',
      path: 'd.md',
      old_text: 'x',
      new_text: 'z',
      replace_all: true,
    });
    expect(all.trace.status).toBe('ok');
    expect(await readFile(join(project, 'd.md'), 'utf8')).toBe('z\nz\n');
  });

  it('拒绝就不写、不记录；只读目录不问直接拒', async () => {
    const denied = await setup({ allow: false });
    const result = await denied.call('write_file', { root: 'project', path: 'e.md', content: 'x' });
    expect(result.output).toContain('没有允许');
    await expect(stat(join(denied.project, 'e.md'))).rejects.toThrow();
    expect(denied.files.snapshot().changes).toHaveLength(0);

    const readOnly = await setup({ writable: false });
    const blocked = await readOnly.call('write_file', {
      root: 'project',
      path: 'e.md',
      content: 'x',
    });
    expect(blocked.trace.status).toBe('error');
    expect(blocked.output).toContain('只读');
    expect(readOnly.asked).toHaveLength(0);
  });

  it('沙盒里照旧不问；撤销本身也留了备份', async () => {
    const { sandbox, project, call, asked, files } = await setup();
    expect((await call('write_file', { path: 'scratch.md', content: 'hi' })).trace.status).toBe(
      'ok',
    );
    expect(await readFile(join(sandbox, 'scratch.md'), 'utf8')).toBe('hi');
    expect(asked).toHaveLength(0);

    await writeFile(join(project, 'f.md'), 'v1', 'utf8');
    await call('write_file', { root: 'project', path: 'f.md', content: 'v2' });
    const first = files.snapshot().changes[0]!;
    await files.undo(first.id);
    expect(await readFile(join(project, 'f.md'), 'utf8')).toBe('v1');
    // 撤销前的 v2 也备份了：再撤一次就回到 v2。
    const redo = files.snapshot().changes.find((item) => !item.undone)!;
    await files.undo(redo.id);
    expect(await readFile(join(project, 'f.md'), 'utf8')).toBe('v2');
  });

  it('重启后目录和改动记录还在', async () => {
    const { project, call, files } = await setup();
    await call('write_file', { root: 'project', path: 'g.md', content: 'x' });
    await files.settled();
    const again = new FileAccessService(
      {
        config: join(project, '..', 'userData', 'file-roots-v1.json'),
        changes: join(project, '..', 'userData', 'file-changes-v1.json'),
        backups: join(project, '..', 'userData', 'file-backups'),
      },
      { home: 'Z:\\home', userData: 'Z:\\data', appDir: 'Z:\\app' },
    );
    await again.load();
    expect(again.roots().map((root) => root.name)).toEqual(['project']);
    expect(again.snapshot().changes).toHaveLength(1);
  });
});
