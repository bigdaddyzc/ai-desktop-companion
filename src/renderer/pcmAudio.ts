/** One AudioContext clock for the whole response: no per-sentence media-element startup. */
export interface PreparedAudio {
  duration: number;
  value: unknown;
}
export interface SpeechAudio {
  prepare(bytes: ArrayBuffer): Promise<PreparedAudio>;
  enqueue(audio: PreparedAudio, done: () => void, fail: () => void): void;
  stop(): void;
}
export class PcmSpeechAudio implements SpeechAudio {
  private context: AudioContext | null = null;
  private nextAt = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private getContext(): AudioContext {
    return (this.context ??= new AudioContext());
  }
  async prepare(bytes: ArrayBuffer): Promise<PreparedAudio> {
    const context = this.getContext();
    await context.resume();
    const value = await context.decodeAudioData(bytes.slice(0));
    if (!Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 120)
      throw new Error('Invalid audio');
    return { duration: value.duration, value };
  }
  enqueue(audio: PreparedAudio, done: () => void, fail: () => void): void {
    const context = this.getContext();
    try {
      const source = context.createBufferSource();
      source.buffer = audio.value as AudioBuffer;
      source.connect(context.destination);
      const at = Math.max(context.currentTime + 0.035, this.nextAt);
      this.nextAt = at + audio.duration;
      this.sources.add(source);
      source.onended = () => {
        if (!this.sources.delete(source)) return;
        source.disconnect();
        done();
      };
      source.start(at);
      void context.resume().catch(fail);
    } catch {
      fail();
    }
  }
  stop(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      source.disconnect();
    }
    this.sources.clear();
    this.nextAt = 0;
    const context = this.context;
    this.context = null;
    if (context) void context.close().catch(() => undefined);
  }
}
