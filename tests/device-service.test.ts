import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceService, SimulatedDevice, type DeviceConnector } from '../src/desktop/device';
import { buildDeviceView } from '../src/core/device-view';
import { initialState } from '../src/core/state';
import { ProactiveService } from '../src/desktop/proactive';
import { defaultPersona } from '../src/core/persona';
import { deviceProtocol } from '../src/core/device-protocol';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe('DeviceService with the simulated device', () => {
  let dir = '';
  let sim: SimulatedDevice;
  let service: DeviceService;
  let clock = 1_000_000;
  const unavailable: DeviceConnector = {
    kind: 'serial',
    connect: () => Promise.resolve(null),
    list: () => Promise.resolve([]),
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'xinban-device-'));
    sim = new SimulatedDevice();
    clock = 1_000_000;
    service = new DeviceService(
      join(dir, 'device-v1.json'),
      { serial: unavailable, simulated: sim },
      () => clock,
      {
        retryMs: 1_000,
        handshakeMs: 500,
      },
    );
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  async function connect(): Promise<void> {
    await service.save({ enabled: true, mode: 'simulated', port: '' });
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
  }

  it('handshakes, persists config and pushes the current view', async () => {
    service.setView(buildDeviceView({ state: initialState(clock), confirm: null, nudge: null }));
    await connect();
    expect(service.snapshot().status).toBe('connected');
    expect(service.snapshot().device?.fw).toBe('sim-1.0.0');
    expect(sim.received[0]).toMatchObject({ t: 'hello', proto: 1, host: 'xinban' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.lastView()?.v).toBe(1);
    const saved = JSON.parse(await readFile(join(dir, 'device-v1.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(saved).toMatchObject({ enabled: true, mode: 'simulated' });
  });

  it('does not resend an identical view, and signals a new confirm card once', async () => {
    const state = initialState(clock);
    service.setView(buildDeviceView({ state, confirm: null, nudge: null }));
    await connect();
    await vi.advanceTimersByTimeAsync(200);
    const views = () => sim.received.filter((frame) => frame.t === 'view').length;
    const before = views();
    service.setView(buildDeviceView({ state, confirm: null, nudge: null }));
    await vi.advanceTimersByTimeAsync(200);
    expect(views()).toBe(before);
    const pending = {
      id: 'c1',
      tool: 'run_command' as const,
      title: '跑命令',
      detail: 'dir',
      createdAt: clock,
      expiresAt: clock + 60_000,
    };
    service.setView(buildDeviceView({ state, confirm: pending, nudge: null }));
    await vi.advanceTimersByTimeAsync(200);
    service.setView(
      buildDeviceView({ state: { ...state, now: clock + 1 }, confirm: pending, nudge: null }),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(sim.received.filter((frame) => frame.t === 'signal')).toEqual([
      { t: 'signal', pattern: 'confirm' },
    ]);
  });

  it('turns raw button edges into short and long gestures', async () => {
    const gestures: string[] = [];
    service.onGesture((button, gesture) => gestures.push(`${button}:${gesture}`));
    await connect();
    sim.press('A', 'down', 100);
    await flush();
    sim.press('A', 'up', 200);
    await flush();
    sim.press('B', 'down', 1_000);
    await flush();
    clock += 900;
    await vi.advanceTimersByTimeAsync(900);
    sim.press('B', 'up', 1_900);
    await flush();
    expect(gestures).toEqual(['A:short', 'B:long']);
  });

  it('falls back to searching after unplug and reconnects', async () => {
    await connect();
    sim.unplug();
    await flush();
    expect(service.snapshot().status).not.toBe('connected');
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.snapshot().status).toBe('connected');
  });

  it('detects silent heartbeats, reconnects and resends the latest view', async () => {
    sim = new SimulatedDevice({ dropPongs: true, chunkBytes: 1 });
    service = new DeviceService(
      join(dir, 'device-v1.json'),
      { serial: unavailable, simulated: sim },
      () => clock,
      { retryMs: 1_000, handshakeMs: 500 },
    );
    const view = buildDeviceView({ state: initialState(clock), confirm: null, nudge: null });
    service.setView(view);
    await connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.lastView()).toEqual(view);
    clock += deviceProtocol.staleMs + 1;
    await vi.advanceTimersByTimeAsync(deviceProtocol.pingMs);
    expect(service.snapshot().status).toBe('searching');
    const latest = { ...view, title: '重连后的状态' };
    service.setView(latest);
    await vi.advanceTimersByTimeAsync(1_010);
    expect(service.snapshot().status).toBe('connected');
    expect(sim.lastView()).toEqual(latest);
    expect(sim.received.filter((frame) => frame.t === 'hello')).toHaveLength(2);
  });

  it('reports a serial port that never says hello as not found', async () => {
    await service.save({ enabled: true, mode: 'serial', port: '' });
    await flush();
    expect(service.snapshot().status).toBe('searching');
    expect(service.snapshot().detail).toContain('没找到');
  });
});

describe('ProactiveService persistence', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xinban-proactive-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('remembers history and bond across restarts', async () => {
    let clock = new Date(2026, 10, 9, 10).getTime();
    const paths = { config: join(dir, 'proactive-v1.json'), bond: join(dir, 'bond-v1.json') };
    const first = new ProactiveService(
      paths,
      () => defaultPersona,
      () => clock,
    );
    await first.init();
    // 第一次见面在上午：先亮「早安」，待办到点排在它后面。
    expect(first.touch(0).map((item) => item.kind)).toEqual(['morning']);
    const nudge = first.offer({ kind: 'todo-due', key: 'due:a', subject: '交报告' });
    expect(nudge).not.toBeNull();
    expect(first.current()?.kind).toBe('morning');
    first.respond(first.current()!.id, 'dismiss');
    expect(first.current()?.id).toBe(nudge!.id);
    first.respond(nudge!.id, 'accept');
    first.todoDone(0);
    await first.settled();

    clock += 3_600_000;
    const second = new ProactiveService(
      paths,
      () => defaultPersona,
      () => clock,
    );
    await second.init();
    const snapshot = second.snapshot();
    expect(snapshot.history[0]).toMatchObject({ kind: 'todo-due', outcome: 'accepted' });
    expect(snapshot.bond.todosDone).toBe(1);
    expect(snapshot.bond.daysTogether).toBe(1);
    const raw = await readFile(paths.bond, 'utf8');
    expect(raw).not.toMatch(/sk-|apiKey/i);
  });

  it('ignores answers for stale ids and bad payloads', async () => {
    const service = new ProactiveService(
      { config: join(dir, 'p.json'), bond: join(dir, 'b.json') },
      () => defaultPersona,
      () => 1_000,
    );
    await service.init();
    expect(service.respond('nope', 'accept')).toBeNull();
    expect(service.respond(42, 'accept')).toBeNull();
    const nudge = service.offer({ kind: 'timer-done', key: 't' });
    expect(service.respond(nudge!.id, 'maybe')).toBeNull();
    await service.settled();
  });
});
