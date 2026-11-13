import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileAccessService } from '../src/desktop/files';
import { captureFile } from '../src/desktop/file-transaction';
import { ToolExecutor, type ToolHost } from '../src/desktop/tools';
import type { Snapshot, CommandResult } from '../src/core/schema';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const fixtures: string[] = [];
const links: string[] = [];
function checked(path: string): string {
  const target = resolve(path);
  if (!fixtures.some((base) => target === base || target.startsWith(base + sep)))
    throw new Error('Outside isolated test fixture');
  return target;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of links.splice(0)) await fs.unlink(checked(path)).catch(() => undefined);
  for (const path of fixtures)
    await fs.rm(checked(path), { recursive: true, force: true, maxRetries: 3 });
  fixtures.length = 0;
});
async function fixture() {
  const base = resolve(await fs.mkdtemp(join(tmpdir(), 'xinban-transactions-')));
  fixtures.push(base);
  const project = join(base, 'project');
  const data = join(base, 'data');
  const sandbox = join(base, 'sandbox');
  await Promise.all([project, data, sandbox].map((path) => fs.mkdir(path)));
  const paths = {
    config: join(data, 'roots.json'),
    changes: join(data, 'changes.json'),
    backups: join(data, 'backups'),
  };
  const forbidden = { home: join(base, 'home'), userData: data, appDir: join(base, 'app') };
  const files = new FileAccessService(paths, forbidden);
  await files.load();
  expect(await files.add(project, true)).toEqual({ ok: true });
  const controller = new AbortController();
  const host: ToolHost = {
    postJson: async () => ({ ok: true, status: 200, data: {} }),
    snapshot: () =>
      ({ state: { todos: [], timer: null }, storageError: null }) as unknown as Snapshot,
    dispatch: async () => ({ ok: true }) as CommandResult,
    memory: {
      remember: async () => ({ ok: true, output: '', note: '' }),
      forget: async () => ({ removed: [], candidates: [] }),
      search: () => [],
    },
    confirm: async () => true,
    files: {
      roots: () => files.roots(),
      revision: () => files.revision(),
      commit: (input, signal) => files.commit(input, signal),
    },
  };
  const executor = new ToolExecutor(host, sandbox, () => 123456789);
  const call = (name: string, args: Record<string, unknown>) =>
    executor.run({ callId: 'test', name, arguments: JSON.stringify(args) }, controller.signal);
  const write = (path = 'note.txt', content = 'assistant update') =>
    call('write_file', { root: 'project', path, content });
  const restart = async () => {
    const next = new FileAccessService(paths, forbidden);
    await next.load();
    return next;
  };
  return {
    base,
    project,
    sandbox,
    files,
    host,
    paths,
    forbidden,
    controller,
    write,
    call,
    restart,
    target: join(project, 'note.txt'),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function afterPrepared(
  f: Fixture,
  effect: (stage: Parameters<FileAccessService['snapshotBefore']>[1]) => Promise<void> | void,
) {
  const original = f.files.snapshotBefore.bind(f.files);
  return vi.spyOn(f.files, 'snapshotBefore').mockImplementation(async (...args) => {
    const record = await original(...args);
    await effect(args[1]);
    return record;
  });
}
function failJournal(f: Fixture, at: number) {
  const original = fs.rename;
  let count = 0;
  return vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === f.paths.changes && ++count === at) throw new Error('simulated disk failure');
    return original(from, to);
  });
}
async function swapParent(f: Fixture) {
  const folder = join(f.project, 'folder');
  const outside = join(f.base, 'outside');
  await fs.mkdir(folder);
  await fs.mkdir(outside);
  await fs.writeFile(join(folder, 'note.txt'), 'original');
  await fs.writeFile(join(outside, 'note.txt'), 'outside');
  return async () => {
    await fs.rename(checked(folder), checked(join(f.project, 'saved-folder')));
    await fs.symlink(outside, folder, 'junction');
    links.push(folder);
  };
}

describe('file transactions: approval and path safety regressions', () => {
  it.each(['deny', 'cancel', 'revoke', 'remove', 'revoke-restore'] as const)(
    'approval %s never commits stale authority',
    async (mode) => {
      const f = await fixture();
      await fs.writeFile(f.target, 'original');
      f.host.confirm = async () => {
        if (mode === 'deny') return false;
        if (mode === 'cancel') f.controller.abort();
        if (mode === 'revoke' || mode === 'revoke-restore')
          await f.files.setWritable('project', false);
        if (mode === 'revoke-restore') await f.files.setWritable('project', true);
        if (mode === 'remove') await f.files.remove('project');
        return true;
      };
      await f.write();
      expect(await fs.readFile(f.target, 'utf8')).toBe('original');
      expect(f.files.snapshot().changes).toHaveLength(0);
    },
  );
  it.each(['edit', 'delete', 'same-content-replacement', 'new-file-appears'] as const)(
    'concurrent %s is never overwritten',
    async (mode) => {
      const f = await fixture();
      if (mode !== 'new-file-appears') await fs.writeFile(f.target, 'original');
      f.host.confirm = async () => {
        if (mode === 'delete') await fs.unlink(f.target);
        else if (mode === 'same-content-replacement') {
          const replacement = join(f.project, 'replacement.txt');
          await fs.writeFile(replacement, 'original');
          await fs.rename(replacement, f.target);
        } else await fs.writeFile(f.target, 'manual edit');
        return true;
      };
      expect((await f.write()).trace.status).toBe('error');
      if (mode === 'delete') await expect(fs.stat(f.target)).rejects.toThrow();
      else
        expect(await fs.readFile(f.target, 'utf8')).toBe(
          mode === 'same-content-replacement' ? 'original' : 'manual edit',
        );
    },
  );
  it.each(['confirm', 'prepared'] as const)(
    'junction substituted at %s cannot redirect a write',
    async (phase) => {
      const f = await fixture();
      const swap = await swapParent(f);
      if (phase === 'confirm')
        f.host.confirm = async () => {
          await swap();
          return true;
        };
      else afterPrepared(f, swap);
      expect((await f.write('folder/note.txt')).trace.status).toBe('error');
      expect(await fs.readFile(join(f.base, 'outside', 'note.txt'), 'utf8')).toBe('outside');
      expect(await fs.readFile(join(f.project, 'saved-folder', 'note.txt'), 'utf8')).toBe(
        'original',
      );
    },
  );
  it.each(['cancel', 'revoke', 'edit', 'tamper-stage', 'delete-stage'] as const)(
    'after backup: %s prevents final replacement',
    async (mode) => {
      const f = await fixture();
      await fs.writeFile(f.target, 'original');
      afterPrepared(f, async (stage) => {
        if (mode === 'cancel') f.controller.abort();
        if (mode === 'revoke') void f.files.setWritable('project', false);
        if (mode === 'edit') await fs.writeFile(f.target, 'manual');
        if (mode === 'tamper-stage') await fs.writeFile(stage!.path, 'tampered');
        if (mode === 'delete-stage') await fs.unlink(stage!.path);
      });
      expect((await f.write()).trace.status).toBe('error');
      await f.files.settled();
      expect(await fs.readFile(f.target, 'utf8')).toBe(mode === 'edit' ? 'manual' : 'original');
      expect(f.files.snapshot().changes).toHaveLength(0);
    },
  );
  it('rejects hard links, invalid UTF8 and binary files without asking', async () => {
    const f = await fixture();
    const ask = vi.fn(async () => true);
    f.host.confirm = ask;
    await fs.writeFile(f.target, 'original');
    await fs.link(f.target, join(f.project, 'link.txt'));
    expect((await f.write()).trace.status).toBe('error');
    await fs.unlink(join(f.project, 'link.txt'));
    for (const bytes of [Buffer.from([0xff, 0xfe, 0x61]), Buffer.from([0x61, 0])]) {
      await fs.writeFile(f.target, bytes);
      expect((await f.write()).trace.status).toBe('error');
      expect(await fs.readFile(f.target)).toEqual(bytes);
    }
    expect(ask).not.toHaveBeenCalled();
  });
  it('UTF8 byte limit rejects oversized Chinese text before approval', async () => {
    const f = await fixture();
    f.host.confirm = vi.fn(async () => true);
    expect((await f.write('note.txt', '汉'.repeat(90000))).trace.status).toBe('error');
    expect(f.host.confirm).not.toHaveBeenCalled();
    expect((await f.write('note.txt', '汉'.repeat(2000))).trace.status).toBe('ok');
  });
  it('edit_file also rejects edits made during diff confirmation', async () => {
    const f = await fixture();
    await fs.writeFile(f.target, 'original');
    f.host.confirm = async () => {
      await fs.writeFile(f.target, 'manual');
      return true;
    };
    const result = await f.call('edit_file', {
      root: 'project',
      path: 'note.txt',
      old_text: 'original',
      new_text: 'changed',
    });
    expect(result.trace.status).toBe('error');
    expect(await fs.readFile(f.target, 'utf8')).toBe('manual');
  });
});

describe('file transactions: durable journal and restart recovery', () => {
  it('failed prewrite journal never modifies target or reports success; queue recovers', async () => {
    const f = await fixture();
    await fs.writeFile(f.target, 'original');
    const fault = failJournal(f, 1);
    expect((await f.write()).trace.status).toBe('error');
    fault.mockRestore();
    expect(await fs.readFile(f.target, 'utf8')).toBe('original');
    expect((await f.restart()).snapshot().changes).toHaveLength(0);
    expect(await fs.readdir(f.paths.backups)).toHaveLength(0);
    expect((await f.write()).trace.status).toBe('ok');
  });
  it('backup persistence failure leaves target intact', async () => {
    const f = await fixture();
    await fs.writeFile(f.target, 'original');
    await fs.writeFile(f.paths.backups, 'not a directory');
    expect((await f.write()).trace.status).toBe('error');
    expect(await fs.readFile(f.target, 'utf8')).toBe('original');
    expect(f.files.snapshot().changes).toHaveLength(0);
  });
  it('failed final journal reports partial outcome, blocks more writes and recovers on restart', async () => {
    const f = await fixture();
    await fs.writeFile(f.target, 'original');
    failJournal(f, 2);
    const result = await f.write();
    expect(result.trace.status).toBe('error');
    expect(result.output).toContain('文件已修改');
    expect(await fs.readFile(f.target, 'utf8')).toBe('assistant update');
    expect(f.files.snapshot().error).toContain('禁止后续');
    expect((await f.write('other.txt')).trace.status).toBe('error');
    const restarted = await f.restart();
    expect(restarted.snapshot().error).toBeNull();
    expect(restarted.snapshot().changes[0]?.status).toBe('applied');
    expect(await restarted.undo(restarted.snapshot().changes[0]!.id)).toEqual({ ok: true });
    expect(await fs.readFile(f.target, 'utf8')).toBe('original');
  });
  it.each(['before', 'conflict'] as const)(
    'prepared recovery %s does not write any target',
    async (mode) => {
      const f = await fixture();
      await fs.writeFile(f.target, 'original');
      const original = f.files.snapshotBefore.bind(f.files);
      vi.spyOn(f.files, 'snapshotBefore').mockImplementation(async (...args) => {
        await original(...args);
        throw new Error('simulate interruption after durable prepare');
      });
      expect((await f.write()).trace.status).toBe('error');
      if (mode === 'conflict') await fs.writeFile(f.target, 'manual');
      const restarted = await f.restart();
      if (mode === 'before') expect(restarted.snapshot().changes).toHaveLength(0);
      else {
        const record = restarted.snapshot().changes[0]!;
        expect(record.status).toBe('conflict');
        expect((await restarted.undo(record.id)).ok).toBe(false);
      }
      expect(await fs.readFile(f.target, 'utf8')).toBe(mode === 'before' ? 'original' : 'manual');
    },
  );
  it.each(['invalid-json', 'invalid-record', 'directory'] as const)(
    'unreadable journal %s fails closed and remains untouched',
    async (mode) => {
      const f = await fixture();
      const content = mode === 'invalid-json' ? '{broken' : '{"version":1,"changes":[{}]}';
      if (mode === 'directory') await fs.mkdir(f.paths.changes);
      else await fs.writeFile(f.paths.changes, content);
      const restarted = await f.restart();
      expect(restarted.snapshot().error).toContain('禁止');
      await expect(
        restarted.commit(
          {
            root: 'project',
            expected: captureFile(f.project, f.target),
            after: Buffer.from('x'),
            revision: restarted.revision(),
            tool: 'write_file',
          },
          f.controller.signal,
        ),
      ).rejects.toThrow();
      await expect(fs.stat(f.target)).rejects.toThrow();
      if (mode !== 'directory') expect(await fs.readFile(f.paths.changes, 'utf8')).toBe(content);
    },
  );
  it('legacy records remain visible but cannot overwrite newer data', async () => {
    const f = await fixture();
    await fs.writeFile(f.target, 'manual');
    await fs.writeFile(
      f.paths.changes,
      JSON.stringify({
        version: 1,
        changes: [
          {
            id: 'old',
            at: 1,
            root: 'project',
            path: f.target,
            action: 'created',
            tool: 'write_file',
            backup: null,
            undone: false,
          },
        ],
      }),
    );
    const restarted = await f.restart();
    expect(restarted.snapshot().changes[0]?.status).toBe('conflict');
    expect((await restarted.undo('old')).ok).toBe(false);
    expect(await fs.readFile(f.target, 'utf8')).toBe('manual');
  });
});

describe('file transactions: undo, concurrency and bounded repeat simulation', () => {
  it.each([
    'manual-edit',
    'same-content-replacement',
    'missing-backup',
    'corrupt-backup',
    'oversized-backup',
    'revoked',
  ] as const)('undo refuses %s without changing target', async (mode) => {
    const f = await fixture();
    await fs.writeFile(f.target, 'original');
    expect((await f.write()).trace.status).toBe('ok');
    const record = f.files.snapshot().changes[0]!;
    if (mode === 'manual-edit') await fs.writeFile(f.target, 'manual');
    if (mode === 'same-content-replacement') {
      await fs.writeFile(join(f.project, 'new.txt'), 'assistant update');
      await fs.rename(join(f.project, 'new.txt'), f.target);
    }
    if (mode === 'missing-backup') await fs.unlink(join(f.paths.backups, record.backup!));
    if (mode === 'corrupt-backup')
      await fs.writeFile(join(f.paths.backups, record.backup!), 'tampered');
    if (mode === 'oversized-backup')
      await fs.writeFile(join(f.paths.backups, record.backup!), Buffer.alloc(256 * 1024 + 1));
    if (mode === 'revoked') await f.files.setWritable('project', false);
    expect((await f.files.undo(record.id)).ok).toBe(false);
    expect(await fs.readFile(f.target, 'utf8')).toBe(
      mode === 'manual-edit' ? 'manual' : 'assistant update',
    );
  });
  it('create / restart / undo / restart / redo preserves content', async () => {
    const f = await fixture();
    expect((await f.write('nested/note.txt', '中文\r\n第二行')).trace.status).toBe('ok');
    let files = await f.restart();
    expect(await files.undo(files.snapshot().changes[0]!.id)).toEqual({ ok: true });
    await expect(fs.stat(join(f.project, 'nested/note.txt'))).rejects.toThrow();
    files = await f.restart();
    expect(await files.undo(files.snapshot().changes[0]!.id)).toEqual({ ok: true });
    expect(await fs.readFile(join(f.project, 'nested/note.txt'), 'utf8')).toBe('中文\r\n第二行');
  });
  it('interrupted undo is reconciled exactly once, including original undone marker', async () => {
    const f = await fixture();
    await fs.writeFile(f.target, 'original');
    await f.write();
    const id = f.files.snapshot().changes[0]!.id;
    failJournal(f, 2);
    expect((await f.files.undo(id)).ok).toBe(false);
    const files = await f.restart();
    expect(files.snapshot().changes.find((c) => c.id === id)?.undone).toBe(true);
    expect((await files.undo(id)).ok).toBe(false);
    expect(await fs.readFile(f.target, 'utf8')).toBe('original');
  });
  it('two concurrent approvals of the same old state commit only once', async () => {
    const f = await fixture();
    await fs.writeFile(f.target, 'original');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let arrivals = 0;
    f.host.confirm = async () => {
      if (++arrivals === 2) release();
      await gate;
      return true;
    };
    const results = await Promise.all([
      f.write('note.txt', 'first'),
      f.write('note.txt', 'second'),
    ]);
    expect(results.map((r) => r.trace.status).sort()).toEqual(['error', 'ok']);
    expect(f.files.snapshot().changes).toHaveLength(1);
  });
  it('concurrent configuration updates do not lose roots or grant changes', async () => {
    const f = await fixture();
    const second = join(f.base, 'second');
    await fs.mkdir(second);
    expect(
      await Promise.all([f.files.add(second, true), f.files.setWritable('project', false)]),
    ).toEqual([{ ok: true }, { ok: true }]);
    expect(f.files.roots()).toMatchObject([
      { name: 'project', writable: false },
      { name: 'second', writable: true },
    ]);
    expect((await f.restart()).roots()).toEqual(f.files.roots());
    f.files.roots()[0]!.writable = true;
    expect(f.files.roots()[0]?.writable).toBe(false);
  });
  it('40 sequential writes and 12 parallel writes survive restart with bounded history and no stage leaks', async () => {
    const f = await fixture();
    f.files.subscribe(() => {
      throw new Error('broken observer');
    });
    for (let i = 0; i < 40; i++)
      expect((await f.write('note.txt', `revision ${i}`)).trace.status).toBe('ok');
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => f.write(`parallel-${i}.txt`, `value ${i}`)),
    );
    expect(results.every((r) => r.trace.status === 'ok')).toBe(true);
    const files = await f.restart();
    expect(files.snapshot().changes).toHaveLength(30);
    expect(await fs.readFile(f.target, 'utf8')).toBe('revision 39');
    for (let i = 0; i < 12; i++)
      expect(await fs.readFile(join(f.project, `parallel-${i}.txt`), 'utf8')).toBe(`value ${i}`);
    expect(
      (await fs.readdir(f.project)).filter((name) => name.startsWith('.xinban-')),
    ).toHaveLength(0);
    expect((await fs.readdir(f.paths.backups)).length).toBeLessThanOrEqual(30);
    expect(
      (await fs.readdir(join(f.base, 'data'))).filter((name) => name.endsWith('.tmp')),
    ).toHaveLength(0);
  });
});

describe('file transactions: review fixes (2026-11-11)', () => {
  it('a root reached through a junction (or under a junctioned parent) is writable', async () => {
    const f = await fixture();
    const real = join(f.base, 'real');
    await fs.mkdir(join(real, 'proj'), { recursive: true });
    const via = join(f.base, 'via');
    await fs.symlink(real, via, 'junction');
    links.push(via);
    for (const root of [via, join(via, 'proj')]) {
      const target = join(root, 'a.txt');
      expect(() => captureFile(root, target)).not.toThrow();
    }
    expect(await f.files.add(join(via, 'proj'), true)).toEqual({ ok: true });
    const name = f.files.roots().find((r) => r.path.endsWith('proj'))!.name;
    const result = await f.call('write_file', { root: name, path: 'a.txt', content: 'via link' });
    expect(result.trace.status).toBe('ok');
    expect(await fs.readFile(join(real, 'proj', 'a.txt'), 'utf8')).toBe('via link');
  });
  it('links below the root are still rejected', async () => {
    const f = await fixture();
    const outside = join(f.base, 'outside');
    await fs.mkdir(outside);
    const inner = join(f.project, 'inner');
    await fs.symlink(outside, inner, 'junction');
    links.push(inner);
    expect((await f.write('inner/x.txt')).trace.status).toBe('error');
    await expect(fs.stat(join(outside, 'x.txt'))).rejects.toThrow();
  });
  it('root name + relative path cannot write into a nested read-only root', async () => {
    const f = await fixture();
    const locked = join(f.project, 'locked');
    await fs.mkdir(locked);
    expect(await f.files.add(locked, false)).toEqual({ ok: true });
    expect((await f.write('locked/x.txt')).trace.status).toBe('error');
    await expect(fs.stat(join(locked, 'x.txt'))).rejects.toThrow();
    expect((await f.write('free.txt')).trace.status).toBe('ok');
  });
  it('undoing a created file is recorded as deleted', async () => {
    const f = await fixture();
    expect((await f.write('new.txt', 'x')).trace.status).toBe('ok');
    const created = f.files.snapshot().changes[0]!;
    expect(created.action).toBe('created');
    expect(await f.files.undo(created.id)).toEqual({ ok: true });
    expect(f.files.snapshot().changes[0]?.action).toBe('deleted');
    expect((await f.restart()).snapshot().changes[0]?.action).toBe('deleted');
  });
  it('recovery drops the backup of a prepared record that never replaced the file', async () => {
    const f = await fixture();
    await fs.writeFile(f.target, 'original');
    // Final replacement fails (stage tampered), and the rollback journal write also
    // fails, so the prepared record and its backup stay on disk.
    afterPrepared(f, async (stage) => {
      await fs.writeFile(stage!.path, 'tampered');
    });
    failJournal(f, 2);
    expect((await f.write()).trace.status).toBe('error');
    expect(f.files.snapshot().changes).toHaveLength(0);
    expect(await fs.readdir(f.paths.backups)).toHaveLength(1);
    vi.restoreAllMocks();
    const restarted = await f.restart();
    expect(restarted.snapshot().changes).toHaveLength(0);
    expect(await fs.readdir(f.paths.backups)).toHaveLength(0);
    expect(await fs.readFile(f.target, 'utf8')).toBe('original');
  });
  it('edit_file keeps a CRLF file CRLF even when old_text matches directly', async () => {
    const f = await fixture();
    await fs.writeFile(f.target, 'one\r\ntwo\r\n');
    const result = await f.call('edit_file', {
      root: 'project',
      path: 'note.txt',
      old_text: 'one',
      new_text: 'uno\ndos',
    });
    expect(result.trace.status).toBe('ok');
    expect(await fs.readFile(f.target, 'utf8')).toBe('uno\r\ndos\r\ntwo\r\n');
  });
});

describe('other software regression boundaries', () => {
  it('editing a UTF8 BOM file preserves the BOM and CRLF bytes', async () => {
    const f = await fixture();
    await fs.writeFile(f.target, '\ufefforiginal\r\nsecond');
    expect(
      (
        await f.call('edit_file', {
          root: 'project',
          path: 'note.txt',
          old_text: 'original',
          new_text: 'changed',
        })
      ).trace.status,
    ).toBe('ok');
    expect(await fs.readFile(f.target)).toEqual(Buffer.from('\ufeffchanged\r\nsecond'));
  });
  it('malformed tool JSON returns an error trace and does not reject the entire caller', async () => {
    const f = await fixture();
    const executor = new ToolExecutor(f.host, f.sandbox);
    await expect(
      executor.run(
        { callId: 'bad-json', name: 'write_file', arguments: '{broken' },
        f.controller.signal,
      ),
    ).resolves.toMatchObject({
      trace: { status: 'error' },
      output: expect.stringContaining('不是有效 JSON'),
    });
    expect(await fs.readdir(f.sandbox)).toHaveLength(0);
  });
  it.each(['shell_command', 'delegate_task'] as const)(
    '%s rechecks its switch after confirmation',
    async (name) => {
      const f = await fixture();
      let enabled = true;
      const run = vi.fn(async () => ({ ok: false as const, error: 'must not run' }));
      f.host.delegate = {
        enabled: () => enabled,
        shellAllowed: () => enabled,
        targets: () => [],
        run,
      };
      f.host.confirm = async () => {
        enabled = false;
        return true;
      };
      const result = await f.call(
        name,
        name === 'shell_command' ? { command: 'echo safe-test' } : { task: 'Test only' },
      );
      expect(result.trace.status).toBe('error');
      expect(result.output).toContain('授权已关闭');
      expect(run).not.toHaveBeenCalled();
    },
  );
  it('repeated sandbox writes in the same millisecond retain three distinct backups', async () => {
    const f = await fixture();
    for (let i = 0; i < 8; i++)
      expect(
        (await f.call('write_file', { path: 'note.txt', content: `revision ${i}` })).trace.status,
      ).toBe('ok');
    expect(await fs.readFile(join(f.sandbox, 'note.txt'), 'utf8')).toBe('revision 7');
    expect((await fs.readdir(f.sandbox)).filter((name) => name.includes('.bak-'))).toHaveLength(3);
  });
});
