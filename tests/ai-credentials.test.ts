import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AiCredentialStore, type AiCrypto } from '../src/desktop/ai-credentials';

const fakeKey = 'sk-test-placeholder-not-a-real-key';

/** 可逆的假加密，只用于验证「落盘前必须加密」这一契约。 */
const crypto: AiCrypto = {
  available: () => true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decrypt: (payload) => {
    const text = payload.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('bad payload');
    return text.slice(4);
  },
};
const unavailable: AiCrypto = {
  available: () => false,
  encrypt: () => Buffer.alloc(0),
  decrypt: () => '',
};

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function fixture(implementation: AiCrypto = crypto) {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-ai-'));
  directories.push(directory);
  const path = join(directory, 'ai-credentials-v1.json');
  return { path, store: new AiCredentialStore(path, implementation) };
}

describe('API Key 加密存储', () => {
  it('保存后可解密读取', async () => {
    const { store } = await fixture();
    await store.save({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      apiKey: fakeKey,
    });
    expect(await store.load()).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      apiKey: fakeKey,
    });
  });

  it('落盘内容绝不含明文 Key', async () => {
    const { path, store } = await fixture();
    await store.save({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      apiKey: fakeKey,
    });
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain(fakeKey);
    expect(raw).not.toContain('sk-test');
    expect(JSON.parse(raw)).toHaveProperty('encryptedKey');
  });

  it('系统加密不可用时拒绝保存，且不留下任何文件', async () => {
    const { path, store } = await fixture(unavailable);
    await expect(
      store.save({ baseUrl: 'https://api.deepseek.com/v1', model: 'm', apiKey: fakeKey }),
    ).rejects.toThrow(/明文/);
    expect(await store.load()).toBeNull();
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('文件损坏时视为未配置且不覆盖原文件', async () => {
    const { path, store } = await fixture();
    const raw = '{broken credentials';
    await writeFile(path, raw, 'utf8');
    expect(await store.load()).toBeNull();
    expect(await readFile(path, 'utf8')).toBe(raw);
  });

  it('版本不兼容时不把旧数据当成可用凭据', async () => {
    const { path, store } = await fixture();
    await writeFile(
      path,
      JSON.stringify({ version: 99, baseUrl: 'x', model: 'm', encryptedKey: 'abc' }),
      'utf8',
    );
    expect(await store.load()).toBeNull();
  });

  it('清除后不再可读', async () => {
    const { store } = await fixture();
    await store.save({ baseUrl: 'https://api.deepseek.com/v1', model: 'm', apiKey: fakeKey });
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});
