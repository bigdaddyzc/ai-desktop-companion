import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  chatMessageProblem,
  chatMessageText,
  defaultPhonePushConfig,
  feishuBody,
  feishuError,
  normalizeIdleMinutes,
  phonePushLimits,
  pruneSent,
  pushCandidates,
  pushText,
  secretProblem,
  webhookProblem,
  type PhonePushConfig,
  type PhonePushSaveInput,
  type PhonePushView,
  type PushSent,
} from '../core/phone-push';
import type { WorkbenchSnapshot } from '../core/workbench';
import type { AiCrypto } from './ai-credentials';
import { writeJsonAtomic } from './atomic';

export type PushFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** 飞书签名：HmacSHA256(key = `${timestamp}\n${secret}`, 空串)，base64。 */
export function feishuSign(timestamp: string, secret: string): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

/**
 * 推到手机：地址与签名密钥用系统加密存（phone-push-v1.json），永不回传渲染进程、不进日志。
 * 系统加密不可用时拒绝保存，不降级为明文。
 */
export class PhonePushService {
  private config: PhonePushConfig = defaultPhonePushConfig();
  private webhook = '';
  private secret = '';
  private sent: PushSent = {};
  private lastSentAt = 0;
  private lastError = '';
  private sending = false;

  constructor(
    private readonly path: string,
    private readonly crypto: AiCrypto,
    private readonly idleSeconds: () => number,
    private readonly fetchImpl: PushFetch,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      this.config = {
        enabled: raw['enabled'] === true,
        idleMinutes: normalizeIdleMinutes(raw['idleMinutes']),
        channel: 'feishu',
      };
      this.webhook = this.decrypt(raw['webhook']);
      if (webhookProblem(this.webhook) !== '') this.webhook = '';
      this.secret = this.decrypt(raw['secret']);
    } catch {
      this.config = defaultPhonePushConfig();
    }
  }

  private decrypt(value: unknown): string {
    if (typeof value !== 'string' || value === '') return '';
    try {
      return this.crypto.decrypt(Buffer.from(value, 'base64'));
    } catch {
      return '';
    }
  }

  view(): PhonePushView {
    return {
      ...this.config,
      configured: this.webhook !== '',
      signed: this.secret !== '',
      encryption: this.crypto.available(),
      lastSentAt: this.lastSentAt,
      lastError: this.lastError,
    };
  }

  async save(
    input: PhonePushSaveInput,
  ): Promise<{ ok: true; view: PhonePushView } | { ok: false; error: string }> {
    let webhook = this.webhook;
    let secret = this.secret;
    if (typeof input.webhook === 'string') {
      webhook = input.webhook.trim();
      if (webhook !== '') {
        const problem = webhookProblem(webhook);
        if (problem !== '') return { ok: false, error: problem };
      } else secret = '';
    }
    if (typeof input.secret === 'string') {
      secret = input.secret.trim();
      const problem = secretProblem(secret);
      if (problem !== '') return { ok: false, error: problem };
    }
    if ((webhook !== '' || secret !== '') && !this.crypto.available()) {
      return { ok: false, error: '系统加密存储不可用，不以明文保存推送地址。' };
    }
    const config: PhonePushConfig = {
      enabled: input.enabled === true && webhook !== '',
      idleMinutes: normalizeIdleMinutes(input.idleMinutes),
      channel: 'feishu',
    };
    const encrypt = (value: string): string =>
      value === '' ? '' : this.crypto.encrypt(value).toString('base64');
    try {
      await writeJsonAtomic(this.path, {
        v: 1,
        ...config,
        webhook: encrypt(webhook),
        secret: encrypt(secret),
      });
    } catch {
      return { ok: false, error: '没保存上，请重试。' };
    }
    this.config = config;
    this.webhook = webhook;
    this.secret = secret;
    this.lastError = '';
    return { ok: true, view: this.view() };
  }

  /** 发一条测试消息：不看空闲，不看开关。 */
  async test(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.webhook === '') return { ok: false, error: '还没填飞书机器人地址。' };
    const error = await this.send('【芯伴】测试推送：以后离开电脑时，Agent 等你或干完会发到这里。');
    return error === '' ? { ok: true } : { ok: false, error };
  }

  /**
   * 聊天里让芯伴发的一条：不看空闲、不看「离开时推」开关，只要配了地址。
   * 发前的确认在工具层（desktop/tools.ts）。
   */
  async sendMessage(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.webhook === '') {
      return { ok: false, error: '还没配飞书机器人地址：去控制面板「推到手机」里填。' };
    }
    const problem = chatMessageProblem(text);
    if (problem !== '') return { ok: false, error: problem };
    const error = await this.send(chatMessageText(text));
    return error === '' ? { ok: true } : { ok: false, error };
  }

  /** 工作台变了或定时器到了：离开够久就把新的等待/干完推一条。返回推了几项。 */
  async tick(snapshot: WorkbenchSnapshot): Promise<number> {
    if (this.sending) return 0;
    const now = this.now();
    this.sent = pruneSent(this.sent, now);
    const items = pushCandidates({
      snapshot,
      config: this.config,
      configured: this.webhook !== '',
      idleMs: Math.max(0, this.idleSeconds()) * 1_000,
      sent: this.sent,
      now,
    });
    if (items.length === 0) return 0;
    this.sending = true;
    try {
      // 先记上：发失败也不在 10 分钟内反复重试刷屏。
      for (const item of items) this.sent[item.key] = now;
      const error = await this.send(pushText(items));
      return error === '' ? items.length : 0;
    } finally {
      this.sending = false;
    }
  }

  private async send(text: string): Promise<string> {
    let body: Record<string, unknown>;
    if (this.secret !== '') {
      const timestamp = String(Math.floor(this.now() / 1_000));
      body = feishuBody(text, { timestamp, sign: feishuSign(timestamp, this.secret) });
    } else body = feishuBody(text);
    let error = '';
    try {
      const response = await this.fetchImpl(this.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(phonePushLimits.timeoutMs),
      });
      const parsed = await response.json().catch(() => null);
      error = feishuError(response.status, parsed);
    } catch {
      error = '发不出去：网络不通或超时了。';
    }
    this.lastError = error;
    if (error === '') this.lastSentAt = this.now();
    return error;
  }
}
