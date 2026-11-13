import { afterEach, describe, expect, it, vi } from 'vitest';
import { PcmSpeechAudio } from '../src/renderer/pcmAudio';
afterEach(() => {
  vi.unstubAllGlobals();
});
function audioContext(duration = 1) {
  const sources: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }[] = [];
  const context = {
    currentTime: 3,
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    decodeAudioData: vi.fn().mockResolvedValue({ duration }),
    createBufferSource: () => {
      const source = {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
        onended: null as (() => void) | null,
      };
      sources.push(source);
      return source;
    },
  };
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return context;
      }
    },
  );
  return { context, sources };
}
describe('continuous audio scheduling', () => {
  it('predecodes and schedules adjacent segments on one clock', async () => {
    const { sources } = audioContext();
    const audio = new PcmSpeechAudio();
    const done = vi.fn();
    const prepared = await audio.prepare(new ArrayBuffer(10));
    audio.enqueue(prepared, done, vi.fn());
    audio.enqueue(prepared, done, vi.fn());
    expect(sources[0]!.start).toHaveBeenCalledWith(3.035);
    expect(sources[1]!.start).toHaveBeenCalledWith(4.035);
    sources[0]!.onended!();
    expect(done).toHaveBeenCalledOnce();
    audio.stop();
    expect(sources[1]!.stop).toHaveBeenCalledOnce();
    expect(sources[1]!.onended).toBeNull();
  });
  it('rejects invalid or unbounded decoded audio', async () => {
    audioContext(121);
    const audio = new PcmSpeechAudio();
    await expect(audio.prepare(new ArrayBuffer(1))).rejects.toThrow('Invalid audio');
    audio.stop();
  });
  it('reports output resume failures rather than silently completing', async () => {
    const { context } = audioContext();
    const audio = new PcmSpeechAudio();
    const prepared = await audio.prepare(new ArrayBuffer(1));
    context.resume.mockRejectedValue(new Error());
    const failed = vi.fn();
    audio.enqueue(prepared, vi.fn(), failed);
    await Promise.resolve();
    expect(failed).toHaveBeenCalledOnce();
    audio.stop();
  });
});
