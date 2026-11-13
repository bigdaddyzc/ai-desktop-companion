import { describe, expect, it } from 'vitest';
import {
  aiAllowedHosts,
  aiChatInputSchema,
  aiConfigInputSchema,
  aiDefaults,
  describeHttpError,
  describeNetworkFailure,
  isAllowedEndpoint,
} from '../src/core/ai';

describe('AI 端点白名单', () => {
  it('用户指定的官方端点被允许', () => {
    expect(isAllowedEndpoint(aiDefaults.baseUrl, aiAllowedHosts)).toBe(true);
    expect(aiDefaults.model).toBe('deepseek-flash');
  });

  it('拒绝明文 http、其他主机、内嵌凭据与非法 URL', () => {
    for (const url of [
      'http://api.deepseek.com/v1',
      'https://evil.example.com/v1',
      'https://user:pw@api.deepseek.com/v1',
      'https://api.deepseek.com.evil.com/v1',
      'not a url',
      '',
    ]) {
      expect(isAllowedEndpoint(url, aiAllowedHosts)).toBe(false);
    }
  });

  it('注入测试白名单时允许 loopback', () => {
    expect(isAllowedEndpoint('http://127.0.0.1:9999/v1', ['127.0.0.1'])).toBe(true);
    expect(isAllowedEndpoint('https://127.0.0.1:9999/v1', ['127.0.0.1'])).toBe(true);
    expect(isAllowedEndpoint('http://api.deepseek.com/v1', ['127.0.0.1'])).toBe(false);
  });
});

describe('AI 输入与配置 schema', () => {
  it('配置与输入 schema 拒绝空值、越界和多余字段', () => {
    expect(aiConfigInputSchema.safeParse({ baseUrl: 'x', model: 'm', apiKey: 'k' }).success).toBe(
      true,
    );
    expect(aiConfigInputSchema.safeParse({ baseUrl: 'x', model: '', apiKey: 'k' }).success).toBe(
      false,
    );
    expect(
      aiConfigInputSchema.safeParse({ baseUrl: 'x', model: 'm', apiKey: 'k', extra: 1 }).success,
    ).toBe(false);
    expect(aiChatInputSchema.safeParse({ text: '   ', history: [] }).success).toBe(false);
    expect(aiChatInputSchema.safeParse({ text: 'a'.repeat(2_001), history: [] }).success).toBe(
      false,
    );
    expect(
      aiChatInputSchema.safeParse({ text: 'hi', history: [{ role: 'system', content: 'x' }] })
        .success,
    ).toBe(false);
  });

  it('历史条数有上限，不把无限上下文悄悄发出去', () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: 'user' as const,
      content: `m${index}`,
    }));
    expect(aiChatInputSchema.safeParse({ text: 'hi', history }).success).toBe(false);
  });
});

describe('错误提示脱敏', () => {
  it('HTTP 错误提示可操作且绝不回显 Key 或响应体', () => {
    expect(describeHttpError(401)).toContain('API Key');
    expect(describeHttpError(402)).toContain('余额');
    expect(describeHttpError(429)).toContain('限流');
    for (const status of [400, 401, 402, 403, 404, 429, 500, 503]) {
      const text = describeHttpError(status);
      expect(text).not.toContain('sk-');
      expect(text).not.toContain('Bearer');
    }
  });

  it('网络异常提示不含底层错误文本', () => {
    for (const kind of ['timeout', 'cancelled', 'network'] as const) {
      const text = describeNetworkFailure(kind);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('sk-');
      expect(text).not.toContain('https://');
    }
  });
});
