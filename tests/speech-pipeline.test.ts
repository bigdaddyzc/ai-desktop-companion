import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeechPipeline } from '../src/renderer/speechPipeline';
import type { SpeechAudio, PreparedAudio } from '../src/renderer/pcmAudio';

/**
 * 播放队列的单测。
 *
 * 这一层是最容易「听起来不对」的地方：切块、并发、顺序、失败回落，任何一处出错
 * 都表现为「念一半停了」或者「句子倒着播」。所以合成与播放都换成可控的假实现，
 * 精确地推一步、验一步。
 */

class FakeAudio implements SpeechAudio {
  static created: { done(): void; fail(): void; audio: PreparedAudio }[] = [];
  async prepare(bytes: ArrayBuffer): Promise<PreparedAudio> {
    return { duration: 1, value: bytes };
  }
  enqueue(audio: PreparedAudio, done: () => void, fail: () => void): void {
    FakeAudio.created.push({ audio, done, fail });
  }
  stop(): void {
    FakeAudio.created = [];
  }
}
beforeEach(() => {
  FakeAudio.created = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface Deferred {
  promise: Promise<{ ok: true; audio: ArrayBuffer } | { ok: false; error: string }>;
  resolve(value: { ok: true; audio: ArrayBuffer } | { ok: false; error: string }): void;
}

function deferred(): Deferred {
  let resolve!: Deferred['resolve'];
  const promise = new Promise<{ ok: true; audio: ArrayBuffer } | { ok: false; error: string }>(
    (done) => {
      resolve = done;
    },
  );
  return { promise, resolve };
}

function build() {
  const requests: { text: string; deferred: Deferred }[] = [];
  const spoken: boolean[] = [];
  const errors: string[] = [];
  const fallbacks: string[] = [];
  const pipeline = new SpeechPipeline(
    {
      synthesize: (text) => {
        const pending = deferred();
        requests.push({ text, deferred: pending });
        return pending.promise;
      },
      onSpeaking: (value) => spoken.push(value),
      onError: (message) => errors.push(message),
      onFallback: (text) => fallbacks.push(text),
    },
    new FakeAudio(),
  );
  const bytes = () => ({ ok: true as const, audio: new ArrayBuffer(4) });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { pipeline, requests, spoken, errors, fallbacks, bytes, flush };
}

describe('SpeechPipeline：切块', () => {
  it('第一块在第一个逗号就切，先出声再管后面', () => {
    const { pipeline, requests } = build();
    pipeline.push('这句话大概有十来个字，后面还有更多内容。');
    // 第一块只有十一个字；第二句已经完整，跟着排队，等第一块念完再接上。
    expect(requests[0]!.text).toBe('这句话大概有十来个字，');
    expect(requests.map((item) => item.text)).toEqual([
      '这句话大概有十来个字，',
      '后面还有更多内容。',
    ]);
  });

  it('不够一句就先攒着，不合成半句话', () => {
    const { pipeline, requests } = build();
    pipeline.push('嗯');
    expect(requests).toHaveLength(0);
    pipeline.push('嗯，好的。');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.text).toBe('嗯，好的。');
  });

  it('定稿时把尾巴补上', () => {
    const { pipeline, requests } = build();
    pipeline.push('还没说完');
    expect(requests).toHaveLength(0);
    pipeline.finish('还没说完');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.text).toBe('还没说完');
  });

  it('定稿比流式时短（去掉了尾部空白）不会从头再念一遍', () => {
    const { pipeline, requests } = build();
    pipeline.push('第一句。第二句  ');
    pipeline.finish('第一句。第二句');
    // 关键是没有出现「第一句。第二句」这种从头的整段：已经念过的不再重来。
    expect(requests.map((item) => item.text)).toEqual(['第一句。', '第二句']);
  });

  it('同时最多两个合成请求在飞，不会把请求堆满', () => {
    const { pipeline, requests } = build();
    pipeline.push('第一句。第二句。第三句。第四句。');
    expect(requests).toHaveLength(2);
  });
});

describe('SpeechPipeline：播放顺序', () => {
  it('后一块先合成完也要等前一块念完', async () => {
    const { pipeline, requests, bytes, flush } = build();
    pipeline.push('第一句。第二句。');
    expect(requests).toHaveLength(2);

    // 第二块先回来：不能插队。
    requests[1]!.deferred.resolve(bytes());
    await flush();
    expect(FakeAudio.created).toHaveLength(0);

    requests[0]!.deferred.resolve(bytes());
    await flush();
    expect(FakeAudio.created).toHaveLength(2); // Both scheduled on the same clock, in order.

    FakeAudio.created[0]!.done();
    await flush();
    expect(FakeAudio.created).toHaveLength(2);
  });

  it('念完最后一块才报「不说了」', async () => {
    const { pipeline, requests, spoken, bytes, flush } = build();
    pipeline.push('就一句。');
    pipeline.finish('就一句。');
    requests[0]!.deferred.resolve(bytes());
    await flush();
    expect(spoken.at(-1)).toBe(true);
    FakeAudio.created[0]!.done();
    await flush();
    expect(spoken.at(-1)).toBe(false);
  });
});

describe('SpeechPipeline：失败与打断', () => {
  it('还没出声就失败：剩下的整段交回系统嗓子', async () => {
    const { pipeline, requests, fallbacks, errors, flush } = build();
    pipeline.push('第一句。第二句。');
    requests[0]!.deferred.resolve({ ok: false, error: '云端没合成出来。' });
    await flush();
    expect(errors[0]).toContain('云端没合成出来。');
    expect(fallbacks).toHaveLength(0);
    pipeline.finish('第一句。第二句。第三句也不能丢。');
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toContain('第一句');
    expect(fallbacks[0]).toContain('第二句');
    expect(fallbacks[0]).toContain('第三句也不能丢');
    expect(FakeAudio.created).toHaveLength(0);
  });

  it('已经出过声后再失败：不跳过失败句，补读全部未完成内容', async () => {
    const { pipeline, requests, fallbacks, bytes, flush } = build();
    pipeline.push('第一句。第二句。第三句。');
    requests[0]!.deferred.resolve(bytes());
    await flush();
    FakeAudio.created[0]!.done();

    requests[1]!.deferred.resolve({ ok: false, error: '失败' });
    await flush();
    // 不整轮回退，也不停在这里：第三块接着合成。
    expect(fallbacks).toHaveLength(0);
    pipeline.finish('第一句。第二句。第三句。');
    expect(fallbacks).toEqual(['第二句。第三句。']);
  });

  it('stop 之后晚到的合成结果作废，不会再突然响起来', async () => {
    const { pipeline, requests, bytes, flush } = build();
    pipeline.push('第一句。');
    pipeline.stop();
    requests[0]!.deferred.resolve(bytes());
    await flush();
    expect(FakeAudio.created).toHaveLength(0);
  });

  it('长回复超过旧 170 字限制也完整播报，音频预取有界', async () => {
    const { pipeline, requests, bytes, flush, spoken } = build();
    const long = Array.from({ length: 80 }, (_, i) => `第${i}句。`).join('');
    pipeline.finish(long);
    let resolved = 0;
    let played = 0;
    for (let i = 0; i < 90; i++) {
      while (resolved < requests.length) requests[resolved++]!.deferred.resolve(bytes());
      await flush();
      expect(requests.length - played).toBeLessThanOrEqual(4);
      if (FakeAudio.created[played]) FakeAudio.created[played++]!.done();
    }
    expect(requests.map((r) => r.text).join('')).toBe(long);
    expect(played).toBe(80);
    expect(spoken.at(-1)).toBe(false);
  });
  it('第二块先失败也不能丢掉第一块；后续增量继续被补读', async () => {
    const { pipeline, requests, flush, fallbacks } = build();
    pipeline.push('第一句。第二句。');
    requests[1]!.deferred.resolve({ ok: false, error: '失败' });
    await flush();
    pipeline.push('第一句。第二句。第三句。');
    pipeline.finish('第一句。第二句。第三句。');
    expect(fallbacks).toEqual(['第一句。第二句。第三句。']);
  });
  it('播放器错误不能当成功结束而静默漏句', async () => {
    const { pipeline, requests, bytes, flush, fallbacks } = build();
    pipeline.finish('第一句。第二句。');
    requests[0]!.deferred.resolve(bytes());
    await flush();
    FakeAudio.created[0]!.fail();
    expect(fallbacks).toEqual(['第一句。第二句。']);
  });
  it('stop 后不播旧尾巴，下一轮可重新使用', async () => {
    const { pipeline, requests, flush, bytes, fallbacks } = build();
    pipeline.push('旧句子。');
    requests[0]!.deferred.resolve({ ok: false, error: '失败' });
    await flush();
    pipeline.stop();
    pipeline.finish('新句子。');
    requests[1]!.deferred.resolve(bytes());
    await flush();
    expect(fallbacks).toEqual([]);
    expect(FakeAudio.created).toHaveLength(1);
  });

  it('上一轮定稿后不经 stop 再 finish（主动提醒）也要念，不能被吞', async () => {
    const { pipeline, requests, flush, bytes } = build();
    pipeline.finish('回复完了。');
    requests[0]!.deferred.resolve(bytes());
    await flush();
    FakeAudio.created[0]!.done();
    await flush();
    pipeline.finish('该休息一下了。');
    expect(requests.map((r) => r.text)).toEqual(['回复完了。', '该休息一下了。']);
    requests[1]!.deferred.resolve(bytes());
    await flush();
    expect(FakeAudio.created).toHaveLength(2);
  });
});
