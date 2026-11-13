import { appVersion } from '../core/version';
import { readFile } from 'node:fs/promises';
import {
  defaultDeviceConfig,
  deviceProtocol,
  encodeHostFrame,
  LineBuffer,
  normalizeDeviceConfig,
  parseDeviceFrame,
  signalFor,
  type DeviceConfig,
  type DeviceFrame,
  type DeviceHello,
  type DeviceMode,
  type DevicePort,
  type DeviceSignal,
  type DeviceSnapshot,
  type DeviceStatus,
  type HostFrame,
} from '../core/device-protocol';
import type { DeviceView } from '../core/device-view';
import {
  applyStateFrame,
  checkIotDevice,
  configFrame,
  emptyIotState,
  iotLimits,
  markPending,
  normalizeIotConfig,
  type IotConfig,
  type IotState,
} from '../core/iot';
import {
  initialInputState,
  inputSpec,
  stepInput,
  type ButtonId,
  type Gesture,
  type InputState,
} from '../core/input';
import { writeJsonAtomic } from './atomic';

/**
 * 实体设备接入。
 *
 * 三层：
 * - **连接器**（DeviceConnector）：找到设备并打开一条双向文本通道。串口与模拟设备各一个，
 *   将来的 Wi-Fi WebSocket 只需再实现一个。
 * - **协议**（core/device-protocol）：一行一个 JSON，与传输无关。
 * - **服务**（DeviceService）：握手、心跳、断线重连、把屏幕内容推下去、把按键变成手势。
 *
 * 没接设备、串口库加载不了、设备中途拔掉，都只影响「硬件」这一栏的状态，不影响桌宠。
 */

export interface DeviceTransport {
  readonly label: string;
  write(line: string): void;
  close(): Promise<void>;
  onData(listener: (chunk: string) => void): void;
  onClose(listener: (reason: string) => void): void;
}

export interface DeviceConnector {
  readonly kind: DeviceMode;
  /** 找到并打开设备；没有设备时返回 null，出错时抛出可读原因。 */
  connect(port: string): Promise<DeviceTransport | null>;
  /** 可用端口列表（只给面板看）。 */
  list(): Promise<DevicePort[]>;
}

export type { DeviceConfig, DeviceMode, DevicePort, DeviceSnapshot, DeviceStatus };
export { defaultDeviceConfig, normalizeDeviceConfig };

/** 串口连接器。串口库是原生模块，按需加载；加载失败只让「硬件」不可用。 */
export class SerialConnector implements DeviceConnector {
  readonly kind = 'serial' as const;

  async list(): Promise<DevicePort[]> {
    const lib = await loadSerial();
    const ports = await lib.SerialPort.list();
    return ports.map((port) => {
      const vendor = (port.vendorId ?? '').toLowerCase();
      const likely =
        vendor === deviceProtocol.espressifVendorId ||
        (deviceProtocol.bridgeVendorIds as readonly string[]).includes(vendor);
      return {
        path: port.path,
        label: [port.path, port.manufacturer, port.friendlyName].filter(Boolean).join(' · '),
        likely,
      };
    });
  }

  async connect(preferred: string): Promise<DeviceTransport | null> {
    const ports = await this.list();
    const pick =
      preferred !== ''
        ? ports.find((port) => port.path.toLowerCase() === preferred.toLowerCase())
        : ports.find((port) => port.likely);
    if (!pick) return null;
    const lib = await loadSerial();
    const port = new lib.SerialPort({
      path: pick.path,
      baudRate: deviceProtocol.baudRate,
      autoOpen: false,
      // 关闭时不拉低 DTR：否则部分板子每次断开都会被复位。
      hupcl: false,
    });
    await new Promise<void>((resolve, reject) => {
      port.open((error) =>
        error ? reject(new Error(`打不开 ${pick.path}：${error.message}`)) : resolve(),
      );
    });
    // ESP32-S3 的 USB CDC 需要 DTR 有效才往外发数据；RTS 保持无效，避免触发下载模式。
    await new Promise<void>((resolve) => port.set({ dtr: true, rts: false }, () => resolve()));
    const decoder = new TextDecoder();
    const closeListeners: ((reason: string) => void)[] = [];
    let closed = false;
    const fireClose = (reason: string): void => {
      if (closed) return;
      closed = true;
      for (const listener of closeListeners) listener(reason);
    };
    port.on('close', () => fireClose('设备已断开'));
    port.on('error', (error: Error) => fireClose(`串口出错：${error.message}`));
    return {
      label: pick.label,
      write: (line) => {
        if (!closed) port.write(line);
      },
      close: () =>
        new Promise<void>((resolve) => {
          if (!port.isOpen) {
            resolve();
            return;
          }
          port.close(() => resolve());
        }),
      onData: (listener) => {
        port.on('data', (chunk: Buffer) => listener(decoder.decode(chunk, { stream: true })));
      },
      onClose: (listener) => {
        closeListeners.push(listener);
      },
    };
  }
}

interface SerialPortInstance {
  isOpen: boolean;
  open(callback: (error: Error | null) => void): void;
  close(callback: (error: Error | null) => void): void;
  set(options: { dtr?: boolean; rts?: boolean }, callback: (error: Error | null) => void): void;
  write(data: string): boolean;
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

interface SerialLib {
  SerialPort: {
    new (options: {
      path: string;
      baudRate: number;
      autoOpen: boolean;
      hupcl: boolean;
    }): SerialPortInstance;
    list(): Promise<
      { path: string; manufacturer?: string; vendorId?: string; friendlyName?: string }[]
    >;
  };
}

let serialLib: Promise<SerialLib> | null = null;

function loadSerial(): Promise<SerialLib> {
  serialLib ??= import('serialport').then(
    (module) => module as unknown as SerialLib,
    () => {
      serialLib = null;
      throw new Error('串口模块没有加载成功（可能缺少该平台的预编译库）。');
    },
  );
  return serialLib;
}

/**
 * 模拟设备：没有硬件时跑通整条协议链路。
 * 它像真固件一样回 hello、回 pong、记住最后一帧画面，按键也发原始 down/up。
 */
export interface SimulatedDeviceOptions {
  /** 按 UTF-8 字节分包，覆盖一个汉字被拆开的真实串口情况。 */
  chunkBytes?: number;
  responseDelayMs?: number;
  dropPongs?: boolean;
}

export class SimulatedDevice implements DeviceConnector {
  readonly kind = 'simulated' as const;
  private dataListener: ((chunk: string) => void) | null = null;
  private closeListener: ((reason: string) => void) | null = null;
  private connected = false;
  private millis = 0;
  private input = new LineBuffer();
  private epoch = 0;
  constructor(private readonly options: SimulatedDeviceOptions = {}) {}
  readonly received: HostFrame[] = [];
  /** 模拟中枢里的智能插座：没有硬件也能跑通「登记 → 看状态 → 开关」。 */
  private iot: { id: string; on: boolean }[] = [];

  list(): Promise<DevicePort[]> {
    return Promise.resolve([{ path: 'SIM', label: '模拟设备（不是真硬件）', likely: true }]);
  }

  connect(): Promise<DeviceTransport | null> {
    this.connected = true;
    this.epoch += 1;
    const epoch = this.epoch;
    this.dataListener = null;
    this.closeListener = null;
    this.input = new LineBuffer();
    const decoder = new TextDecoder();
    const transport: DeviceTransport = {
      label: '模拟设备',
      write: (line) => {
        if (!this.connected || epoch !== this.epoch) return;
        for (const chunk of this.chunks(line)) {
          for (const payload of this.input.push(decoder.decode(chunk, { stream: true }))) {
            this.receive(payload);
          }
        }
      },
      close: () => {
        if (epoch === this.epoch) this.connected = false;
        return Promise.resolve();
      },
      onData: (listener) => {
        if (epoch === this.epoch) this.dataListener = listener;
      },
      onClose: (listener) => {
        if (epoch === this.epoch) this.closeListener = listener;
      },
    };
    return Promise.resolve(transport);
  }

  /** 模拟按键。`at` 是设备毫秒，缺省自动递增。 */
  press(button: ButtonId, edge: 'down' | 'up', at?: number): void {
    this.millis = at ?? this.millis + 10;
    this.emit({ t: 'btn', b: button, e: edge, ms: this.millis });
  }

  /** 模拟拔线。 */
  unplug(): void {
    this.connected = false;
    this.closeListener?.('设备已断开');
  }

  lastView(): DeviceView | null {
    for (let index = this.received.length - 1; index >= 0; index -= 1) {
      const frame = this.received[index];
      if (frame?.t === 'view') return frame.view;
    }
    return null;
  }

  private receive(line: string): void {
    if (!this.connected) return;
    let frame: HostFrame;
    try {
      frame = JSON.parse(line) as HostFrame;
    } catch {
      return;
    }
    this.received.push(frame);
    if (this.received.length > 50) this.received.splice(0, this.received.length - 50);
    if (frame.t === 'hello') {
      this.emit({
        t: 'hello',
        proto: deviceProtocol.version,
        fw: 'sim-1.0.0',
        board: 'simulated',
        screen: { w: 240, h: 240 },
        buttons: ['A', 'B'],
        caps: ['led', 'iot'],
      });
    } else if (frame.t === 'ping' && !this.options.dropPongs) {
      this.emit({ t: 'pong', n: frame.n });
      // 真中枢会定时轮询设备；模拟的就跟着心跳报一遍。
      this.reportIot();
    } else if (frame.t === 'iot.config') {
      this.iot = frame.devices.map((device) => ({
        id: device.id,
        on: this.iot.find((item) => item.id === device.id)?.on ?? false,
      }));
      this.emit({ t: 'iot.net', ok: true, ssid: 'SIM-WIFI', ip: '192.168.1.50', rssi: -48 });
      this.reportIot();
    } else if (frame.t === 'iot.set') {
      const device = this.iot.find((item) => item.id === frame.id);
      if (device) {
        device.on = frame.on;
        this.emit({
          t: 'iot.state',
          id: device.id,
          online: true,
          on: device.on,
          w: device.on ? 12.5 : 0,
        });
      }
    }
  }

  private reportIot(): void {
    for (const device of this.iot) {
      this.emit({
        t: 'iot.state',
        id: device.id,
        online: true,
        on: device.on,
        w: device.on ? 12.5 : 0,
      });
    }
  }

  private chunks(text: string): Uint8Array[] {
    const bytes = new TextEncoder().encode(text);
    const size = Math.max(1, Math.floor(this.options.chunkBytes ?? 17));
    const chunks: Uint8Array[] = [];
    for (let start = 0; start < bytes.length; start += size) {
      chunks.push(bytes.slice(start, start + size));
    }
    return chunks;
  }

  private emit(frame: DeviceFrame): void {
    const epoch = this.epoch;
    const deliver = (): void => {
      if (!this.connected || epoch !== this.epoch) return;
      const decoder = new TextDecoder();
      for (const chunk of this.chunks(`${JSON.stringify(frame)}\n`)) {
        this.dataListener?.(decoder.decode(chunk, { stream: true }));
      }
    };
    if ((this.options.responseDelayMs ?? 0) > 0) {
      setTimeout(deliver, this.options.responseDelayMs).unref?.();
    } else {
      queueMicrotask(deliver);
    }
  }
}

export const deviceTiming = {
  /** 没找到设备时多久重试一次。 */
  retryMs: 3_000,
  handshakeMs: 3_000,
} as const;

/**
 * 实体设备服务。主进程把最新的 DeviceView 交给 setView，它负责在连着时推下去；
 * 设备上的按键变成手势后交给 onGesture，由主进程按同一张意图表处理。
 */
export class DeviceService {
  private config: DeviceConfig = defaultDeviceConfig;
  private status: DeviceStatus = 'off';
  private detail = '没有启用';
  private transport: DeviceTransport | null = null;
  private hello: DeviceHello | null = null;
  private lastSeenAt = 0;
  private ports: DevicePort[] = [];
  private logs: string[] = [];
  private view: DeviceView | null = null;
  private sentView = '';
  private sentSignal: DeviceSignal = 'none';
  private lastSentAt = 0;
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private longTimer: ReturnType<typeof setTimeout> | null = null;
  private input: InputState = initialInputState();
  /** 设备毫秒 → 主机时间的偏移，按下时校准，用来推算长按到点时的设备时间。 */
  private clockOffset = 0;
  private pingCount = 0;
  private generation = 0;
  private readonly listeners = new Set<(snapshot: DeviceSnapshot) => void>();
  private gestureListener: ((button: ButtonId, gesture: Gesture) => void) | null = null;
  private iot: IotState = emptyIotState();
  /** 每个物联网设备上次广播的时间：状态没变时也隔一会儿推一次，让界面知道它还新鲜。 */
  private iotPublishedAt = new Map<string, number>();

  constructor(
    private readonly path: string,
    private readonly connectors: Record<DeviceMode, DeviceConnector>,
    private readonly now: () => number = Date.now,
    private readonly timing: { retryMs: number; handshakeMs: number } = deviceTiming,
    /** 物联网设备登记表；不传就不落盘（只在单测里）。 */
    private readonly iotPath: string | null = null,
  ) {}

  async init(): Promise<void> {
    try {
      this.config = normalizeDeviceConfig(JSON.parse(await readFile(this.path, 'utf8')));
    } catch {
      this.config = defaultDeviceConfig;
    }
    if (this.iotPath !== null) {
      try {
        const config = normalizeIotConfig(JSON.parse(await readFile(this.iotPath, 'utf8')));
        this.iot = { ...this.iot, config };
      } catch {
        // 没登记过设备：空表。
      }
    }
    if (this.config.enabled) void this.start();
  }

  /**
   * 保存物联网设备登记表。逐条校验，有一条不对就整体拒绝并说清楚是哪条——
   * 不声不响地丢掉用户刚填的设备比报错更糟。保存后若中枢在线，立即下发。
   */
  async saveIot(raw: unknown): Promise<{ ok: boolean; error?: string }> {
    const list =
      typeof raw === 'object' &&
      raw !== null &&
      Array.isArray((raw as { devices?: unknown }).devices)
        ? (raw as { devices: unknown[] }).devices
        : null;
    if (list === null) return { ok: false, error: '参数无效。' };
    if (list.length > iotLimits.maxDevices) {
      return { ok: false, error: `最多登记 ${iotLimits.maxDevices} 台设备。` };
    }
    for (const [index, item] of list.entries()) {
      const checked = checkIotDevice(item);
      if (!checked.ok) return { ok: false, error: `第 ${index + 1} 台：${checked.error}` };
    }
    const config: IotConfig = normalizeIotConfig({ devices: list });
    if (this.iotPath !== null) {
      try {
        await writeJsonAtomic(this.iotPath, { version: 1, ...config });
      } catch {
        return { ok: false, error: '设备登记表没有保存成功。' };
      }
    }
    const ids = new Set(config.devices.map((device) => device.id));
    this.iot = { ...this.iot, config, live: this.iot.live.filter((item) => ids.has(item.id)) };
    this.sendIotConfig();
    this.publish();
    return { ok: true };
  }

  /** 面板里点开/关。只在中枢在线且设备已登记时下发；结果以中枢回报的状态为准。 */
  iotSet(id: unknown, on: unknown): { ok: boolean; error?: string } {
    if (typeof id !== 'string' || typeof on !== 'boolean')
      return { ok: false, error: '参数无效。' };
    if (!this.iot.config.devices.some((device) => device.id === id)) {
      return { ok: false, error: '没有这台设备。' };
    }
    if (this.status !== 'connected' || this.transport === null || !this.iot.hub) {
      return { ok: false, error: 'ESP32 中枢不在线，没法从电脑上控制。' };
    }
    this.transport.write(encodeHostFrame({ t: 'iot.set', id, on }));
    this.iot = { ...this.iot, live: markPending(this.iot.live, id, this.now()) };
    this.publish();
    return { ok: true };
  }

  private sendIotConfig(): void {
    if (this.status !== 'connected' || this.transport === null || !this.iot.hub) return;
    this.transport.write(encodeHostFrame(configFrame(this.iot.config)));
  }

  snapshot(): DeviceSnapshot {
    return {
      config: this.config,
      status: this.status,
      detail: this.detail,
      transport: this.transport?.label ?? '',
      device: this.hello,
      lastView: this.status === 'connected' ? this.view : null,
      lastSeenAt: this.lastSeenAt,
      ports: this.ports,
      logs: this.logs,
      iot: this.iot,
    };
  }

  subscribe(listener: (snapshot: DeviceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onGesture(listener: (button: ButtonId, gesture: Gesture) => void): void {
    this.gestureListener = listener;
  }

  async save(raw: unknown): Promise<{ ok: boolean; error?: string }> {
    const next = normalizeDeviceConfig(raw);
    try {
      await writeJsonAtomic(this.path, { version: 1, ...next });
    } catch {
      return { ok: false, error: '硬件设置没有保存成功。' };
    }
    const changed =
      next.enabled !== this.config.enabled ||
      next.mode !== this.config.mode ||
      next.port !== this.config.port;
    this.config = next;
    if (changed) {
      await this.stop();
      if (next.enabled) void this.start();
    }
    this.publish();
    return { ok: true };
  }

  /** 刷新端口列表（面板按钮）。 */
  async refreshPorts(): Promise<DeviceSnapshot> {
    try {
      this.ports = await this.connectors[this.config.mode].list();
    } catch (error) {
      this.ports = [];
      this.detail = error instanceof Error ? error.message : '列不出端口。';
    }
    this.publish();
    return this.snapshot();
  }

  /** 主进程每次状态变化都调；内容不变不发，变了至少间隔 viewMinIntervalMs。 */
  setView(view: DeviceView): void {
    this.view = view;
    this.scheduleView();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.clearTimers();
    const transport = this.transport;
    this.transport = null;
    this.hello = null;
    this.iot = { ...this.iot, hub: false, net: null };
    this.sentView = '';
    this.sentSignal = 'none';
    this.input = initialInputState();
    this.status = 'off';
    this.detail = '没有启用';
    if (transport) await transport.close().catch(() => undefined);
    this.publish();
  }

  private async start(): Promise<void> {
    const generation = this.generation;
    this.status = 'searching';
    this.detail = this.config.mode === 'simulated' ? '正在连接模拟设备' : '正在找设备';
    this.publish();
    const connector = this.connectors[this.config.mode];
    let transport: DeviceTransport | null = null;
    try {
      this.ports = await connector.list();
      transport = await connector.connect(this.config.port);
    } catch (error) {
      if (generation !== this.generation) return;
      this.status = 'error';
      this.detail = error instanceof Error ? error.message : '连接失败。';
      this.publish();
      this.scheduleRetry(generation);
      return;
    }
    if (generation !== this.generation) {
      await transport?.close().catch(() => undefined);
      return;
    }
    if (transport === null) {
      this.status = 'searching';
      this.detail =
        this.config.port !== ''
          ? `没找到 ${this.config.port}，插上后会自动连`
          : '没找到像 ESP32 的设备，插上后会自动连';
      this.publish();
      this.scheduleRetry(generation);
      return;
    }
    this.attach(transport, generation);
  }

  private attach(transport: DeviceTransport, generation: number): void {
    this.transport = transport;
    this.status = 'handshake';
    this.detail = '已打开，等设备报到';
    const buffer = new LineBuffer();
    transport.onData((chunk) => {
      if (generation !== this.generation) return;
      for (const line of buffer.push(chunk)) this.handle(line);
    });
    transport.onClose((reason) => {
      if (generation !== this.generation) return;
      this.lost(reason, generation);
    });
    transport.write(
      encodeHostFrame({ t: 'hello', proto: deviceProtocol.version, host: 'xinban', v: appVersion }),
    );
    this.handshakeTimer = setTimeout(() => {
      if (generation !== this.generation || this.status !== 'handshake') return;
      // 设备没回 hello：可能是别的串口设备，或固件没烧。关掉重试，不往里乱写。
      this.lost('设备没有报到（固件是否已烧录、协议版本是否一致？）', generation);
    }, this.timing.handshakeMs);
    this.publish();
  }

  private handle(line: string): void {
    const frame = parseDeviceFrame(line);
    if (frame === null) return;
    this.lastSeenAt = this.now();
    switch (frame.t) {
      case 'hello':
        if (frame.proto !== deviceProtocol.version) {
          this.status = 'error';
          this.detail = `协议版本不一致：设备 v${frame.proto}，芯伴 v${deviceProtocol.version}`;
          this.publish();
          return;
        }
        this.hello = frame;
        this.status = 'connected';
        this.detail = `已连接 · 固件 ${frame.fw}`;
        if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.startPing();
        this.sentView = '';
        this.scheduleView(true);
        this.iot = { ...this.iot, hub: (frame.caps ?? []).includes('iot'), net: null };
        this.sendIotConfig();
        this.publish();
        return;
      case 'iot.state': {
        if (!this.iot.config.devices.some((device) => device.id === frame.id)) return;
        const before = this.iot.live.find((item) => item.id === frame.id);
        const now = this.now();
        this.iot = { ...this.iot, live: applyStateFrame(this.iot.live, frame, now) };
        const after = this.iot.live.find((item) => item.id === frame.id);
        const changed =
          before === undefined ||
          before.online !== after?.online ||
          before.on !== after?.on ||
          before.watts !== after?.watts ||
          before.pending;
        // 没变也隔 5 秒推一次：界面靠 at 判断「是不是新鲜」，不推就会误判为不确定。
        if (changed || now - (this.iotPublishedAt.get(frame.id) ?? 0) > 5_000) {
          this.iotPublishedAt.set(frame.id, now);
          this.publish();
        }
        return;
      }
      case 'iot.net':
        this.iot = {
          ...this.iot,
          net: {
            ok: frame.ok,
            ssid: frame.ssid ?? '',
            ip: frame.ip ?? '',
            rssi: frame.rssi ?? null,
            portal: frame.portal ?? '',
          },
        };
        this.publish();
        return;
      case 'btn':
        if (this.status === 'connected') this.button(frame.b, frame.e, frame.ms);
        return;
      case 'pong':
        return;
      case 'log':
        this.logs = [`${frame.level ?? 'info'} · ${frame.msg}`, ...this.logs].slice(0, 10);
        this.publish();
        return;
    }
  }

  /** 原始按键 → 手势。去抖、长按与桌面按钮是同一个状态机。 */
  private button(button: ButtonId, edge: 'down' | 'up', ms: number): void {
    if (edge === 'down') {
      this.clockOffset = this.now() - ms;
      const result = stepInput(this.input, { type: 'down', button, at: ms });
      this.input = result.state;
      if (result.outcome === null) {
        if (this.longTimer !== null) clearTimeout(this.longTimer);
        this.longTimer = setTimeout(() => {
          this.longTimer = null;
          const tick = stepInput(this.input, {
            type: 'tick',
            button,
            at: this.now() - this.clockOffset,
          });
          this.input = tick.state;
          if (tick.outcome?.kind === 'gesture') {
            this.gestureListener?.(tick.outcome.button, tick.outcome.gesture);
          }
        }, inputSpec.longPressMs);
      }
      return;
    }
    if (this.longTimer !== null) clearTimeout(this.longTimer);
    this.longTimer = null;
    const result = stepInput(this.input, { type: 'up', button, at: ms });
    this.input = result.state;
    if (result.outcome?.kind === 'gesture') {
      this.gestureListener?.(result.outcome.button, result.outcome.gesture);
    }
  }

  private scheduleView(immediate = false): void {
    if (this.status !== 'connected' || this.transport === null || this.view === null) return;
    if (this.viewTimer !== null) return;
    const wait = immediate
      ? 0
      : Math.max(0, deviceProtocol.viewMinIntervalMs - (this.now() - this.lastSentAt));
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      this.flushView();
    }, wait);
  }

  private flushView(): void {
    const transport = this.transport;
    const view = this.view;
    if (this.status !== 'connected' || transport === null || view === null) return;
    const line = encodeHostFrame({ t: 'view', view });
    if (line !== this.sentView) {
      transport.write(line);
      this.sentView = line;
      this.lastSentAt = this.now();
      this.publish();
    }
    const signal = signalFor(view);
    if (signal !== this.sentSignal) {
      // 只在「新出现」时发：同一张卡亮着不会反复蜂鸣。
      if (signal !== 'none') transport.write(encodeHostFrame({ t: 'signal', pattern: signal }));
      this.sentSignal = signal;
    }
  }

  private startPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    const generation = this.generation;
    this.pingTimer = setInterval(() => {
      if (generation !== this.generation || this.transport === null) return;
      if (this.now() - this.lastSeenAt > deviceProtocol.staleMs) {
        this.lost('设备没有响应', generation);
        return;
      }
      this.pingCount += 1;
      this.transport.write(encodeHostFrame({ t: 'ping', n: this.pingCount }));
    }, deviceProtocol.pingMs);
    this.pingTimer.unref?.();
  }

  private lost(reason: string, generation: number): void {
    const transport = this.transport;
    this.transport = null;
    this.hello = null;
    this.iot = { ...this.iot, hub: false, net: null };
    this.sentView = '';
    this.sentSignal = 'none';
    this.input = initialInputState();
    this.clearTimers();
    this.status = 'searching';
    this.detail = `${reason}，稍后自动重连`;
    void transport?.close().catch(() => undefined);
    this.publish();
    this.scheduleRetry(generation);
  }

  private scheduleRetry(generation: number): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (generation === this.generation && this.config.enabled) void this.start();
    }, this.timing.retryMs);
    this.retryTimer.unref?.();
  }

  private clearTimers(): void {
    for (const timer of [this.viewTimer, this.retryTimer, this.handshakeTimer, this.longTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.viewTimer = null;
    this.retryTimer = null;
    this.handshakeTimer = null;
    this.longTimer = null;
    this.pingTimer = null;
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
