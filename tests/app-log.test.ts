import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expiredLogs, formatLogLine, logFileName, redact } from '../src/core/app-log';
import { isSandboxCwd, parseHookEvents } from '../src/core/hook-events';
import { AppLog } from '../src/desktop/app-log';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const day = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h).getTime();

describe('运行日志', () => {
  it('按本地日期命名', () => {
    expect(logFileName(day(2026, 11, 3))).toBe('app-20261103.log');
  });

  it('密钥与令牌一律遮掉', () => {
    expect(redact('key sk-abcdef1234567890 bad')).toBe('key sk-*** bad');
    expect(redact('Authorization: Bearer abc.def.ghi123456')).toContain('Bearer ***');
    expect(redact('api_key=xyz123')).toBe('api_key=***');
    expect(redact('hash 0123456789abcdef0123456789abcdef')).toBe('hash ***');
  });

  it('一行一条 JSON，长字段截断、非法字段名丢弃', () => {
    const line = formatLogLine({
      at: day(2026, 11, 3),
      level: 'warn',
      event: 'ai-turn',
      fields: { ok: false, ms: 1234.567, error: 'x'.repeat(500), 'bad key': 'v', none: undefined },
    });
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line) as Record<string, string>;
    expect(parsed['lv']).toBe('warn');
    expect(parsed['ok']).toBe('false');
    expect(parsed['ms']).toBe('1234.57');
    expect(parsed['error']!.length).toBeLessThanOrEqual(160);
    expect(parsed).not.toHaveProperty('bad key');
    expect(parsed).not.toHaveProperty('none');
  });

  it('只删自己命名、超过 7 天的日志', () => {
    const now = day(2026, 11, 10);
    expect(
      expiredLogs(
        ['app-20261102.log', 'app-20261103.log', 'app-20261110.log', 'notes.txt', 'app-x.log'],
        now,
      ),
    ).toEqual(['app-20261102.log']);
  });

  it('写盘、清理过期文件、告警计数；健康快照里不带日志以外的东西', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xinban-log-'));
    directories.push(dir);
    await writeFile(join(dir, 'app-20200101.log'), 'old\n');
    await writeFile(join(dir, 'keep.txt'), 'mine\n');
    const now = day(2026, 11, 10);
    const log = new AppLog(dir, '0.3.0', () => now);
    const seen: number[] = [];
    log.subscribe((health) => seen.push(health.errors + health.warnings));
    log.info('app-start', { version: '0.3.0' });
    log.warn('ai-turn', { ok: false, error: '单步超时 sk-abcdef1234567890' });
    log.error('uncaught', { error: 'TypeError: boom' });
    await log.settled();
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(['app-20261110.log', 'keep.txt']);
    const text = await readFile(join(dir, 'app-20261110.log'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(3);
    expect(text).not.toContain('abcdef1234567890');
    const health = log.snapshot();
    expect(health.warnings).toBe(1);
    expect(health.errors).toBe(1);
    expect(health.recent.map((item) => item.event)).toEqual(['uncaught', 'ai-turn']);
    expect(seen).toEqual([1, 2]);
    expect(health.writeFailed).toBe(false);
  });

  it('目录建不了时不抛错，只在健康卡上标出来', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xinban-log-'));
    directories.push(dir);
    const blocker = join(dir, 'file');
    await writeFile(blocker, 'x');
    const log = new AppLog(join(blocker, 'logs'), '0.3.0');
    log.info('app-start');
    await log.settled();
    expect(log.snapshot().writeFailed).toBe(true);
  });
});

describe('测试沙盒里的钩子事件', () => {
  it('认得出 Windows 与 Linux 的临时目录', () => {
    expect(isSandboxCwd('C:\\Users\\me\\AppData\\Local\\Temp\\xinban-eval-abc')).toBe(true);
    expect(isSandboxCwd('/tmp/xinban-ai-stream-1/work')).toBe(true);
    expect(isSandboxCwd('D:\\claude-workspace\\plans')).toBe(false);
    expect(isSandboxCwd('D:\\projects\\xinban-app')).toBe(false);
  });

  it('不进进度，也不提醒「在等你」', () => {
    const at = 1_800_000_000_000;
    const line = (sid: string, cwd: string) =>
      JSON.stringify({ v: 1, src: 'claude', ev: 'PermissionRequest', sid, at, cwd, tool: 'Bash' });
    const signals = parseHookEvents(
      [
        line('real', 'D:\\claude-workspace\\plans'),
        line('test', 'C:\\Users\\me\\AppData\\Local\\Temp\\xinban-smoke-1'),
      ].join('\n'),
    );
    expect(signals.map((signal) => signal.sessionId)).toEqual(['real']);
  });
});
