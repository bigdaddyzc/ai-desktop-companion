import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appLogLimits,
  expiredLogs,
  formatLogLine,
  logFileName,
  type HealthSnapshot,
  type LogFields,
  type LogLevel,
  type LogRecord,
} from '../core/app-log';

/**
 * 滚动运行日志：`logs/app-YYYYMMDD.log`，留 7 天。
 *
 * 写盘串行、失败静默（只在健康卡上亮一个「日志写不进去」）——日志绝不能反过来影响主流程。
 */
export class AppLog {
  private writes: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | null = null;
  private readonly listeners = new Set<(health: HealthSnapshot) => void>();
  private health: HealthSnapshot;

  constructor(
    private readonly dir: string,
    version: string,
    private readonly now: () => number = Date.now,
  ) {
    this.health = {
      startedAt: now(),
      version,
      logDir: dir,
      warnings: 0,
      errors: 0,
      recent: [],
      writeFailed: false,
    };
  }

  info(event: string, fields: LogFields = {}): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write('error', event, fields);
  }

  snapshot(): HealthSnapshot {
    return this.health;
  }

  subscribe(listener: (health: HealthSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 等排队的写盘完成：退出前和测试里用。 */
  async settled(): Promise<void> {
    await this.writes;
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    const record: LogRecord = { at: this.now(), level, event, fields };
    if (level !== 'info') {
      this.health = {
        ...this.health,
        warnings: this.health.warnings + (level === 'warn' ? 1 : 0),
        errors: this.health.errors + (level === 'error' ? 1 : 0),
        recent: [record, ...this.health.recent].slice(0, appLogLimits.recent),
      };
      this.notify();
    }
    const line = formatLogLine(record);
    this.writes = this.writes
      .then(() => this.prepare())
      .then(() => appendFile(join(this.dir, logFileName(record.at)), line, 'utf8'))
      .catch(() => {
        if (!this.health.writeFailed) {
          this.health = { ...this.health, writeFailed: true };
          this.notify();
        }
      });
  }

  /** 第一次写时建目录、顺手清掉过期的日志。 */
  private prepare(): Promise<void> {
    if (this.ready === null) {
      this.ready = (async () => {
        await mkdir(this.dir, { recursive: true });
        const names = await readdir(this.dir).catch(() => [] as string[]);
        for (const name of expiredLogs(names, this.now())) {
          await rm(join(this.dir, name), { force: true }).catch(() => undefined);
        }
      })().catch((error: unknown) => {
        // 下次再试：目录可能只是暂时建不了。
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.health);
  }
}

/** 把未知异常变成一句短话：只要类型和消息，不要堆栈里的路径与内容。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
