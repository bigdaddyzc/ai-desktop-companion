import { describe, expect, it, vi } from 'vitest';
import fixtures from './fixtures/device-contract.json';
import {
  LineBuffer,
  deviceProtocol,
  encodeHostFrame,
  parseDeviceFrame,
} from '../src/core/device-protocol';
import type { DeviceView } from '../src/core/device-view';
import { SimulatedDevice } from '../src/desktop/device';
import { needsFullScreen } from '../src/core/confirm';

// This same JSON corpus is consumed by firmware/test/native/main.cpp.
describe('host / firmware shared contracts', () => {
  for (const test of fixtures.streams) {
    it(`byte budget and resynchronization: ${test.name}`, () => {
      const buffer = new LineBuffer();
      expect(test.chunks.flatMap((chunk) => buffer.push(chunk))).toEqual(test.lines);
    });
  }
  for (const test of fixtures.screens) {
    it(`wire view survives fragmented transport: ${test.name}`, async () => {
      const sim = new SimulatedDevice({ chunkBytes: 1 });
      const transport = await sim.connect();
      const view = test.view as DeviceView;
      const frame = encodeHostFrame({ t: 'view', view });
      expect(Buffer.byteLength(frame.trimEnd())).toBeLessThanOrEqual(deviceProtocol.maxFrameBytes);
      transport?.write(frame);
      expect(sim.lastView()).toEqual(view);
      await transport?.close();
    });
  }
  it('limits UTF-8 bytes before discarding unknown fields, including whitespace', () => {
    expect(
      parseDeviceFrame(JSON.stringify({ t: 'pong', n: 1, extra: '中'.repeat(1000) })),
    ).toBeNull();
    expect(parseDeviceFrame(`${' '.repeat(2048)}{"t":"pong","n":1}`)).toBeNull();
    expect(parseDeviceFrame('{"t":"pong","n":1,"extra":"中"}')).toEqual({ t: 'pong', n: 1 });
  });
  it('does not manufacture a button frame from the tail of a corrupt line', () => {
    const b = new LineBuffer();
    b.push('x'.repeat(4097));
    expect(b.push('{"t":"btn","b":"A","e":"up","ms":100}\n')).toEqual([]);
  });
  it('never splits an emoji while compacting and rejects oversized non-view frames', () => {
    const view = { ...fixtures.screens[0]!.view, bubble: '🙂'.repeat(1000) } as DeviceView;
    const wire = encodeHostFrame({ t: 'view', view });
    const parsed = JSON.parse(wire) as { view: DeviceView };
    expect(parsed.view.bubble).not.toContain('\ufffd');
    expect(/[\uD800-\uDFFF]/u.test(parsed.view.bubble)).toBe(false);
    expect(Buffer.byteLength(wire.trimEnd())).toBeLessThanOrEqual(2048);
    expect(() =>
      encodeHostFrame({ t: 'hello', proto: 1, host: 'xinban', v: 'x'.repeat(2050) }),
    ).toThrow(RangeError);
  });
  it('only allows short single-line printable ASCII confirmations on the physical screen', () => {
    expect(needsFullScreen({ detail: 'npm test' })).toBe(false);
    for (const detail of ['x'.repeat(25), 'npm\ntest', 'npm\ttest', '查看屏幕', '🙂']) {
      expect(needsFullScreen({ detail })).toBe(true);
    }
  });
  it('simulates delayed and byte-fragmented responses without leaking across reconnect', async () => {
    vi.useFakeTimers();
    try {
      const sim = new SimulatedDevice({ chunkBytes: 1, responseDelayMs: 50 });
      const first = await sim.connect();
      const received: string[] = [];
      first?.onData((chunk) => received.push(chunk));
      first?.write(encodeHostFrame({ t: 'hello', proto: 1, host: 'xinban', v: 'test' }));
      expect(received).toEqual([]);
      await first?.close();
      const second = await sim.connect();
      second?.onData((chunk) => received.push(chunk));
      await vi.advanceTimersByTimeAsync(50);
      expect(received).toEqual([]);
      second?.write(encodeHostFrame({ t: 'ping', n: 7 }));
      await vi.advanceTimersByTimeAsync(50);
      expect(received.join('')).toBe('{"t":"pong","n":7}\n');
      await second?.close();
    } finally {
      vi.useRealTimers();
    }
  });
  it('ignores stale transports after a reconnect', async () => {
    const sim = new SimulatedDevice();
    const first = await sim.connect();
    const second = await sim.connect();
    const received: string[] = [];
    second?.onData((chunk) => received.push(chunk));
    first?.onData(() => {
      throw new Error('stale listener');
    });
    await first?.close();
    first?.write(encodeHostFrame({ t: 'ping', n: 1 }));
    second?.write(encodeHostFrame({ t: 'ping', n: 2 }));
    await Promise.resolve();
    expect(received.join('')).toBe('{"t":"pong","n":2}\n');
    expect(sim.received).toEqual([{ t: 'ping', n: 2 }]);
    await second?.close();
  });
  it('simulates lost heartbeats and rejects corrupt host frame tails', async () => {
    const sim = new SimulatedDevice({ dropPongs: true });
    const transport = await sim.connect();
    const reply = vi.fn();
    transport?.onData(reply);
    transport?.write(encodeHostFrame({ t: 'ping', n: 1 }));
    transport?.write('x'.repeat(4097));
    transport?.write('{"t":"hello","proto":1}\n');
    await Promise.resolve();
    expect(reply).not.toHaveBeenCalled();
    expect(sim.received).toEqual([{ t: 'ping', n: 1 }]);
    await transport?.close();
  });
});
