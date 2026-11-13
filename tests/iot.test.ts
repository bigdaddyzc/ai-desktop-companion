import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeHostFrame, parseDeviceFrame } from '../src/core/device-protocol';
import {
  applyStateFrame,
  checkIotDevice,
  configFrame,
  emptyIotState,
  iotDisplay,
  iotLimits,
  isLanHost,
  markPending,
  normalizeIotConfig,
  type IotState,
} from '../src/core/iot';
import { DeviceService, SimulatedDevice, type DeviceConnector } from '../src/desktop/device';

describe('iot config validation', () => {
  it('only accepts LAN hosts', () => {
    for (const host of [
      '192.168.1.23',
      '10.0.0.8',
      '172.16.4.2',
      '172.31.255.1',
      'plug-desk.local',
    ]) {
      expect(isLanHost(host)).toBe(true);
    }
    for (const host of [
      '8.8.8.8',
      '172.32.0.1',
      '192.169.1.1',
      '256.1.1.1',
      'example.com',
      'evil.local.example.com',
      '-bad.local',
      'http://192.168.1.2',
      '192.168.1.2:80',
      '',
    ]) {
      expect(isLanHost(host)).toBe(false);
    }
  });

  it('checks kind, name and channel per device type, with friendly errors', () => {
    expect(checkIotDevice({ name: '台灯', kind: 'tasmota', host: '192.168.1.5' })).toEqual({
      ok: true,
      value: { id: '', name: '台灯', kind: 'tasmota', host: '192.168.1.5', channel: '' },
    });
    const shelly = checkIotDevice({ name: '热水器', kind: 'shelly', host: 'heater.local' });
    expect(shelly.ok && shelly.value.channel).toBe('0');
    const esphome = checkIotDevice({ name: '风扇', kind: 'esphome', host: '10.0.0.9' });
    expect(esphome.ok && esphome.value.channel).toBe('relay');
    expect(checkIotDevice({ name: '', kind: 'tasmota', host: '192.168.1.5' }).ok).toBe(false);
    expect(checkIotDevice({ name: 'x', kind: 'tuya', host: '192.168.1.5' }).ok).toBe(false);
    expect(checkIotDevice({ name: 'x', kind: 'tasmota', host: '1.1.1.1' }).ok).toBe(false);
    expect(
      checkIotDevice({ name: 'x', kind: 'tasmota', host: '192.168.1.5', channel: '9' }).ok,
    ).toBe(false);
    expect(
      checkIotDevice({ name: 'x', kind: 'esphome', host: '192.168.1.5', channel: '../reboot' }).ok,
    ).toBe(false);
    expect(
      checkIotDevice({
        name: '一二三四五六七八九十一二三四五六七',
        kind: 'tasmota',
        host: '192.168.1.5',
      }).ok,
    ).toBe(false);
  });

  it('normalizes: drops bad rows, assigns unique ids, caps the count', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: index < 2 ? 'same' : '',
      name: `插座${index}`,
      kind: 'tasmota',
      host: `192.168.1.${index + 10}`,
    }));
    const config = normalizeIotConfig({ devices: [{ name: 'bad', kind: 'x' }, ...rows] });
    expect(config.devices).toHaveLength(iotLimits.maxDevices);
    expect(new Set(config.devices.map((device) => device.id)).size).toBe(iotLimits.maxDevices);
    expect(config.devices[0]?.id).toBe('same');
    expect(normalizeIotConfig(null)).toEqual({ devices: [] });
  });
});

describe('iot frames and live state', () => {
  it('parses device state frames and rejects bad ones', () => {
    expect(
      parseDeviceFrame('{"t":"iot.state","id":"d1","online":true,"on":true,"w":7.5}'),
    ).toMatchObject({
      t: 'iot.state',
      on: true,
      w: 7.5,
    });
    expect(parseDeviceFrame('{"t":"iot.state","id":"d1","online":"yes"}')).toBeNull();
    expect(parseDeviceFrame('{"t":"iot.net","ok":false,"portal":"Xinban-Setup"}')).toMatchObject({
      ok: false,
      portal: 'Xinban-Setup',
    });
  });

  it('encodes the config frame within the frame budget even at max devices', () => {
    const config = normalizeIotConfig({
      devices: Array.from({ length: iotLimits.maxDevices }, (_, index) => ({
        name: '一二三四五六七八九十一二三四五六',
        kind: 'esphome',
        host: `long-hostname-for-device-number-${index}.local`,
        channel: 'a'.repeat(32),
      })),
    });
    const line = encodeHostFrame(configFrame(config));
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(2048);
  });

  it('never presents stale or hub-less state as current', () => {
    const now = 100_000;
    const config = normalizeIotConfig({
      devices: [{ id: 'd1', name: '台灯', kind: 'tasmota', host: '192.168.1.5' }],
    });
    let state: IotState = { ...emptyIotState(), config, hub: true };
    expect(iotDisplay(state, 'd1', now)).toBe('unknown');
    state = {
      ...state,
      live: applyStateFrame(state.live, { t: 'iot.state', id: 'd1', online: true, on: true }, now),
    };
    expect(iotDisplay(state, 'd1', now + 1_000)).toBe('on');
    expect(iotDisplay(state, 'd1', now + iotLimits.staleMs + 1)).toBe('unknown');
    expect(iotDisplay({ ...state, hub: false }, 'd1', now + 1_000)).toBe('unknown');
    state = { ...state, live: markPending(state.live, 'd1', now + 2_000) };
    expect(iotDisplay(state, 'd1', now + 2_500)).toBe('pending');
    state = {
      ...state,
      live: applyStateFrame(
        state.live,
        { t: 'iot.state', id: 'd1', online: false, on: true },
        now + 3_000,
      ),
    };
    expect(iotDisplay(state, 'd1', now + 3_100)).toBe('offline');
    // 离线时不保留「开着」这种旧值。
    expect(state.live.find((item) => item.id === 'd1')?.on).toBeNull();
  });
});

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe('DeviceService iot with the simulated hub', () => {
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
    dir = await mkdtemp(join(tmpdir(), 'xinban-iot-'));
    sim = new SimulatedDevice();
    clock = 1_000_000;
    service = new DeviceService(
      join(dir, 'device-v1.json'),
      { serial: unavailable, simulated: sim },
      () => clock,
      { retryMs: 1_000, handshakeMs: 500 },
      join(dir, 'iot-v1.json'),
    );
    await service.init();
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  async function settle(): Promise<void> {
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
  }

  it('saves the registry, refuses bad rows, and controls devices through the hub', async () => {
    const bad = await service.saveIot({
      devices: [
        { name: '台灯', kind: 'tasmota', host: '192.168.1.5' },
        { name: '外网', kind: 'tasmota', host: '8.8.8.8' },
      ],
    });
    expect(bad).toEqual({ ok: false, error: expect.stringContaining('第 2 台') });
    expect(service.snapshot().iot.config.devices).toHaveLength(0);

    expect(
      await service.saveIot({ devices: [{ name: '台灯', kind: 'tasmota', host: '192.168.1.5' }] }),
    ).toEqual({ ok: true });
    const saved = JSON.parse(await readFile(join(dir, 'iot-v1.json'), 'utf8')) as {
      devices: { id: string }[];
    };
    expect(saved.devices[0]?.id).toBe('d1');
    // 中枢不在线时不能从电脑控制。
    expect(service.iotSet('d1', true)).toEqual({
      ok: false,
      error: expect.stringContaining('不在线'),
    });

    await service.save({ enabled: true, mode: 'simulated', port: '' });
    await settle();
    const snap = service.snapshot();
    expect(snap.iot.hub).toBe(true);
    // 握手后立即下发登记表。
    expect(sim.received.some((frame) => frame.t === 'iot.config')).toBe(true);
    expect(snap.iot.net).toMatchObject({ ok: true, ssid: 'SIM-WIFI' });
    expect(iotDisplay(snap.iot, 'd1', clock)).toBe('off');

    expect(service.iotSet('d1', true)).toEqual({ ok: true });
    expect(iotDisplay(service.snapshot().iot, 'd1', clock)).toBe('pending');
    await settle();
    expect(iotDisplay(service.snapshot().iot, 'd1', clock)).toBe('on');
    expect(service.snapshot().iot.live[0]?.watts).toBe(12.5);

    expect(service.iotSet('nope', true).ok).toBe(false);
    expect(service.iotSet('d1', 'yes').ok).toBe(false);
  });

  it('ignores state for unregistered ids and drops hub status when unplugged', async () => {
    await service.saveIot({ devices: [{ name: '台灯', kind: 'tasmota', host: '192.168.1.5' }] });
    await service.save({ enabled: true, mode: 'simulated', port: '' });
    await settle();
    expect(service.snapshot().iot.live.map((item) => item.id)).toEqual(['d1']);
    sim.unplug();
    await settle();
    expect(service.snapshot().iot.hub).toBe(false);
    expect(iotDisplay(service.snapshot().iot, 'd1', clock)).toBe('unknown');
  });

  it('reloads the registry from disk on start', async () => {
    await service.saveIot({
      devices: [{ name: '风扇', kind: 'esphome', host: 'fan.local', channel: 'fan_relay' }],
    });
    const again = new DeviceService(
      join(dir, 'device-v1.json'),
      { serial: unavailable, simulated: new SimulatedDevice() },
      () => clock,
      { retryMs: 1_000, handshakeMs: 500 },
      join(dir, 'iot-v1.json'),
    );
    await again.init();
    expect(again.snapshot().iot.config.devices[0]).toMatchObject({
      name: '风扇',
      channel: 'fan_relay',
    });
    await again.stop();
  });
});
