import { speechStream, takeSpeechSegment } from '../core/voice';
import { speechText } from '../core/senses';
import { PcmSpeechAudio, type PreparedAudio, type SpeechAudio } from './pcmAudio';

interface Segment {
  text: string;
  state: 'idle' | 'synth' | 'ready' | 'playing';
  audio?: PreparedAudio;
}
export interface PipelineHandlers {
  synthesize(
    text: string,
  ): Promise<{ ok: true; audio: ArrayBuffer } | { ok: false; error: string }>;
  cancel?(): void;
  onSpeaking(speaking: boolean): void;
  onError(message: string): void;
  onFallback(text: string): void;
}
/** Ordered predecode + one playback clock. Failures replay only the unfinished tail, never skip it. */
export class SpeechPipeline {
  private segments: Segment[] = [];
  private pending = '';
  private lastRaw = '';
  private queuedChars = 0;
  private generation = 0;
  private ended = false;
  private fallback = false;
  private fallbackSent = false;
  private truncated = false;
  private speaking = false;
  constructor(
    private readonly handlers: PipelineHandlers,
    private readonly audio: SpeechAudio = new PcmSpeechAudio(),
  ) {}
  push(text: string): void {
    if (this.ended) this.nextRound();
    // Final text often has trim() applied. Normalize before finding the common prefix.
    const next = text.trimStart();
    let common = 0;
    while (
      common < next.length &&
      common < this.lastRaw.length &&
      next[common] === this.lastRaw[common]
    )
      common++;
    const delta = next.slice(common);
    this.lastRaw = next;
    if (!delta) return;
    this.pending += speechText(delta, Number.POSITIVE_INFINITY);
    this.cut();
    this.schedule();
    this.drain();
  }
  finish(text: string): void {
    if (this.ended) this.nextRound();
    this.push(text);
    if (this.pending.trim()) this.enqueue(this.pending);
    this.pending = '';
    this.ended = true;
    this.schedule();
    this.drain();
    this.flushFallback();
  }
  stop(): void {
    this.generation++;
    this.audio.stop();
    this.handlers.cancel?.();
    this.segments = [];
    this.pending = '';
    this.lastRaw = '';
    this.queuedChars = 0;
    this.truncated = false;
    this.ended = false;
    this.fallback = false;
    this.fallbackSent = false;
    this.report(false);
  }
  /** 上一轮已定稿又来新内容（如主动提醒）：开新一轮排在后面，不能吞掉。 */
  private nextRound(): void {
    this.ended = false;
    this.lastRaw = '';
    this.pending = '';
    this.truncated = false;
    this.queuedChars = this.segments.reduce((sum, s) => sum + s.text.length, 0);
    if (this.fallbackSent) {
      this.fallback = false;
      this.fallbackSent = false;
    }
  }
  private cut(): void {
    for (;;) {
      const piece = takeSpeechSegment(this.pending, this.queuedChars === 0);
      if (!piece) return;
      this.pending = piece.rest;
      this.enqueue(piece.segment);
    }
  }
  private enqueue(raw: string): void {
    const text = raw.trim();
    if (!text || this.truncated) return;
    if (this.queuedChars + text.length > speechStream.totalChars) {
      this.truncated = true;
      this.handlers.onError('回复超过 6000 字播报上限，剩余内容请看文字。');
      return;
    }
    this.segments.push({ text, state: 'idle' });
    this.queuedChars += text.length;
    this.report(true);
  }
  private schedule(): void {
    if (this.fallback) return;
    // Bound both synthesis concurrency and ready-audio memory; prefetch only four segments.
    let inflight = this.segments.filter((s) => s.state === 'synth').length;
    for (const segment of this.segments.slice(0, 4)) {
      if (inflight >= speechStream.inflight) break;
      if (segment.state !== 'idle') continue;
      inflight++;
      segment.state = 'synth';
      const mine = this.generation;
      void this.handlers
        .synthesize(segment.text)
        .then(async (result) => {
          if (mine !== this.generation || this.fallback) return;
          if (!result.ok) {
            this.fail(result.error);
            return;
          }
          const prepared = await this.audio.prepare(result.audio);
          if (mine !== this.generation || this.fallback) return;
          segment.audio = prepared;
          segment.state = 'ready';
          this.schedule();
          this.drain();
        })
        .catch(() => {
          if (mine === this.generation && !this.fallback)
            this.fail('合成或音频解码失败，未播完的内容改用系统语音。');
        });
    }
  }
  private fail(message: string): void {
    if (this.fallback) return;
    this.fallback = true;
    this.generation++;
    this.audio.stop();
    this.handlers.cancel?.();
    for (const s of this.segments) delete s.audio;
    this.handlers.onError(message + ' 未播完的内容将在回复结束后用系统语音补读。');
    this.report(false);
    this.flushFallback();
  }
  private flushFallback(): void {
    if (!this.fallback || !this.ended || this.fallbackSent) return;
    this.fallbackSent = true;
    const text = this.segments.map((s) => s.text).join('');
    this.segments = [];
    if (text) this.handlers.onFallback(text);
  }
  private drain(): void {
    if (this.fallback) return;
    if (!this.segments.length && this.ended) {
      this.report(false);
      return;
    }
    for (const segment of this.segments) {
      if (segment.state === 'playing') continue;
      if (segment.state !== 'ready' || !segment.audio) break;
      segment.state = 'playing';
      const mine = this.generation;
      this.audio.enqueue(
        segment.audio,
        () => {
          if (mine !== this.generation) return;
          this.segments = this.segments.filter((s) => s !== segment);
          this.schedule();
          this.drain();
        },
        () => {
          if (mine === this.generation) this.fail('音频播放失败。');
        },
      );
      if (this.fallback) break;
    }
  }
  private report(value: boolean): void {
    if (this.speaking !== value) {
      this.speaking = value;
      this.handlers.onSpeaking(value);
    }
  }
}
