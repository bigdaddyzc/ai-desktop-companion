import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmService } from '../src/desktop/confirm';
import type { ConfirmRequest } from '../src/core/confirm';

const request: ConfirmRequest = {
  tool: 'run_command',
  title: '想跑一条命令',
  detail: 'git status',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('逐次确认', () => {
  it('允许后返回 true，并记录结果', async () => {
    const service = new ConfirmService(() => 1_000);
    const pending = service.request(request);
    const id = service.snapshot().pending?.id;
    expect(id).toBeTruthy();
    expect(service.answer(id!, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(service.snapshot().pending).toBeNull();
    expect(service.snapshot().recent[0]?.outcome).toBe('allowed');
  });

  it('拒绝返回 false', async () => {
    const service = new ConfirmService(() => 1_000);
    const pending = service.request(request);
    expect(service.answerCurrent(false)).toBe(true);
    await expect(pending).resolves.toBe(false);
    expect(service.snapshot().recent[0]?.outcome).toBe('denied');
  });

  it('没人理就超时拒绝', async () => {
    vi.useFakeTimers();
    const service = new ConfirmService(() => 1_000, 5_000);
    const pending = service.request(request);
    vi.advanceTimersByTime(5_001);
    await expect(pending).resolves.toBe(false);
    expect(service.snapshot().recent[0]?.outcome).toBe('expired');
  });

  it('对话取消时等待一并作废', async () => {
    const service = new ConfirmService(() => 1_000);
    const controller = new AbortController();
    const pending = service.request(request, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBe(false);
    expect(service.snapshot().recent[0]?.outcome).toBe('cancelled');
  });

  it('同一时刻只亮一条，其余排队；旧 id 的回答被忽略', async () => {
    const service = new ConfirmService(() => 1_000);
    const first = service.request(request);
    const second = service.request({ ...request, detail: 'git log' });
    expect(service.snapshot().queued).toBe(1);
    const firstId = service.snapshot().pending!.id;
    service.answer(firstId, true);
    await expect(first).resolves.toBe(true);
    expect(service.answer(firstId, true)).toBe(false);
    expect(service.snapshot().pending?.detail).toBe('git log');
    service.answerCurrent(false);
    await expect(second).resolves.toBe(false);
  });

  it('已取消的信号直接拒绝，不亮卡片', async () => {
    const service = new ConfirmService(() => 1_000);
    const controller = new AbortController();
    controller.abort();
    await expect(service.request(request, controller.signal)).resolves.toBe(false);
    expect(service.snapshot().pending).toBeNull();
  });

  it('参数类型不对的回答被忽略', () => {
    const service = new ConfirmService(() => 1_000);
    void service.request(request);
    expect(service.answer(42 as unknown as string, true)).toBe(false);
    expect(service.snapshot().pending).not.toBeNull();
    service.cancelAll();
    expect(service.snapshot().pending).toBeNull();
  });
});
