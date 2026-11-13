import { z } from 'zod';
import type { DeviceView } from './device-view';
import {
  emptyIotState,
  iotNetFrameSchema,
  iotStateFrameSchema,
  type IotHostFrame,
  type IotState,
} from './iot';

/**
 * 主机 ↔ 实体设备协议（v1）。
 *
 * 传输无关：USB CDC 串口、将来的 Wi-Fi WebSocket、测试里的模拟设备，走的都是同一种帧：
 * **一行一个 JSON 对象，以 `\n` 结尾，UTF-8，单帧不超过 2048 字节**。
 *
 * 分工是刻意的：
 * - 设备只做「画」和「报」：按主机给的 DeviceView 画屏，按键只上报原始按下/抬起 + 设备毫秒。
 * - 主机做全部判断：去抖、长按、手势 → 动作（确认/提醒/摸摸/勿扰）。
 * 这样固件不用跟着业务变，桌面和实体的「按一下会发生什么」永远一致。
 *
 * 解析策略：设备上行帧按 Zod 校验，但允许多余字段（固件升级后会加东西）；
 * 不认识的帧、坏 JSON、超长行一律丢弃，不影响连接。
 */

export const deviceProtocol = {
  version: 1,
  maxFrameBytes: 2048,
  /** 主机多久发一次心跳；设备多久没回就算断开。 */
  pingMs: 5_000,
  staleMs: 15_000,
  /** 同一内容不重发；内容变化时至少间隔这么久，避免流式回复把串口刷满。 */
  viewMinIntervalMs: 120,
  /** Espressif 原生 USB（ESP32-S3 USB-Serial-JTAG / TinyUSB CDC）。 */
  espressifVendorId: '303a',
  /** 常见 USB 转串口芯片：CP210x、CH340、FTDI。不带原生 USB 的板子走这些。 */
  bridgeVendorIds: ['10c4', '1a86', '0403'],
  baudRate: 115_200,
} as const;

export type DeviceMode = 'serial' | 'simulated';

export interface DevicePort {
  path: string;
  label: string;
  /** 看起来像 ESP32（Espressif 原生 USB 或常见转串口芯片）。 */
  likely: boolean;
}

export interface DeviceConfig {
  enabled: boolean;
  mode: DeviceMode;
  /** 指定端口（如 COM5）；空串表示自动找。 */
  port: string;
}

export const defaultDeviceConfig: DeviceConfig = { enabled: false, mode: 'serial', port: '' };

export type DeviceStatus = 'off' | 'searching' | 'handshake' | 'connected' | 'error';

export interface DeviceSnapshot {
  config: DeviceConfig;
  status: DeviceStatus;
  /** 一句话说明现在的情况（没找到设备、握手超时…）。 */
  detail: string;
  transport: string;
  device: DeviceHello | null;
  /** 最近一次推给设备的画面：面板用它镜像「设备上此刻显示什么」。 */
  lastView: DeviceView | null;
  lastSeenAt: number;
  ports: DevicePort[];
  /** 最近几条设备日志（固件发来的 log 帧）。 */
  logs: string[];
  /** 物联网：登记的设备、中枢网络、各设备实时状态。 */
  iot: IotState;
}

export function emptyDeviceSnapshot(): DeviceSnapshot {
  return {
    config: defaultDeviceConfig,
    status: 'off',
    detail: '没有启用',
    transport: '',
    device: null,
    lastView: null,
    lastSeenAt: 0,
    ports: [],
    logs: [],
    iot: emptyIotState(),
  };
}

export function normalizeDeviceConfig(raw: unknown): DeviceConfig {
  if (typeof raw !== 'object' || raw === null) return defaultDeviceConfig;
  const value = raw as Record<string, unknown>;
  const port = typeof value['port'] === 'string' ? value['port'].trim() : '';
  return {
    enabled: value['enabled'] === true,
    mode: value['mode'] === 'simulated' ? 'simulated' : 'serial',
    // 只接受像端口名的字符串：COM5、/dev/ttyACM0。其余当成自动。
    port: /^(COM\d{1,3}|\/dev\/[\w.-]{1,40})$/i.test(port) ? port : '',
  };
}

/** 闪灯/蜂鸣的有限模式。时长与频率由固件固定，AI 输出不能决定它们。 */
export type DeviceSignal = 'none' | 'nudge' | 'confirm' | 'happy' | 'error';

export type HostFrame =
  | { t: 'hello'; proto: number; host: 'xinban'; v: string }
  | { t: 'view'; view: DeviceView }
  | { t: 'signal'; pattern: DeviceSignal }
  | { t: 'ping'; n: number }
  | IotHostFrame;

const buttonSchema = z.enum(['A', 'B']);

const deviceHelloSchema = z.object({
  t: z.literal('hello'),
  proto: z.number().int().positive(),
  fw: z.string().max(32),
  board: z.string().max(48).optional(),
  screen: z
    .object({ w: z.number().int().positive().max(2048), h: z.number().int().positive().max(2048) })
    .optional(),
  buttons: z.array(buttonSchema).max(4).optional(),
  caps: z.array(z.string().max(24)).max(16).optional(),
});

const buttonFrameSchema = z.object({
  t: z.literal('btn'),
  b: buttonSchema,
  e: z.enum(['down', 'up']),
  ms: z.number().finite().nonnegative(),
});

const pongSchema = z.object({ t: z.literal('pong'), n: z.number().int().nonnegative() });

const logSchema = z.object({
  t: z.literal('log'),
  level: z.enum(['info', 'warn', 'error']).optional(),
  msg: z.string().max(200),
});

const deviceFrameSchema = z.discriminatedUnion('t', [
  deviceHelloSchema,
  buttonFrameSchema,
  pongSchema,
  logSchema,
  iotStateFrameSchema,
  iotNetFrameSchema,
]);

export type DeviceFrame = z.infer<typeof deviceFrameSchema>;
export type DeviceHello = z.infer<typeof deviceHelloSchema>;

/** 解析设备上行的一行。任何不对的地方都返回 null，调用方直接丢弃。 */
export function parseDeviceFrame(line: string): DeviceFrame | null {
  const payload = line.replace(/\r$/, '');
  const text = payload.trim();
  if (text === '' || byteLength(payload) > deviceProtocol.maxFrameBytes || !text.startsWith('{')) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = deviceFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function clip(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/**
 * 把 DeviceView 压进单帧上限：依次缩短气泡、卡片详情、标题。
 * 小屏本来就放不下长文字，压缩不会丢掉用户看得见的信息。
 */
export function compactView(
  view: DeviceView,
  budget: number = deviceProtocol.maxFrameBytes - 64,
): DeviceView {
  const limits = [
    { text: 96, detail: 80, title: 40 },
    { text: 60, detail: 48, title: 24 },
    { text: 32, detail: 24, title: 16 },
  ];
  for (const limit of limits) {
    const card = view.card
      ? view.card.kind === 'confirm'
        ? {
            ...view.card,
            title: clip(view.card.title, limit.title),
            detail: clip(view.card.detail, limit.detail),
          }
        : { ...view.card, text: clip(view.card.text, limit.text) }
      : null;
    const next: DeviceView = {
      ...view,
      title: clip(view.title, limit.title),
      detail: clip(view.detail, limit.detail),
      bubble: clip(view.bubble, limit.text),
      work: clip(view.work, limit.detail),
      todo: view.todo ? { ...view.todo, title: clip(view.todo.title, limit.title) } : null,
      card,
    };
    if (byteLength(JSON.stringify({ t: 'view', view: next })) <= budget) return next;
  }
  return {
    ...view,
    title: clip(view.title, 8),
    detail: '',
    bubble: '',
    work: '',
    todo: null,
    card: null,
  };
}

/** 编码主机下行帧。view 帧会先压进上限。 */
export function encodeHostFrame(frame: HostFrame): string {
  const value = frame.t === 'view' ? { t: 'view', view: compactView(frame.view) } : frame;
  const payload = JSON.stringify(value);
  if (byteLength(payload) > deviceProtocol.maxFrameBytes) {
    throw new RangeError('设备帧超过 2048 字节');
  }
  return `${payload}\n`;
}

/** 按行切分的缓冲：串口数据会在任意位置断开，超长行整行丢弃。 */
export class LineBuffer {
  private pending = '';
  private bytes = 0;
  private dropping = false;

  /** 输入必须经过流式 UTF-8 解码；字节上限不包含 CR/LF 行结束符。 */
  push(chunk: string): string[] {
    const lines: string[] = [];
    for (const point of chunk) {
      if (point === '\n') {
        const payload = this.pending.replace(/\r$/, '');
        if (!this.dropping && byteLength(payload) <= deviceProtocol.maxFrameBytes) {
          lines.push(payload);
        }
        this.pending = '';
        this.bytes = 0;
        this.dropping = false;
      } else if (!this.dropping) {
        this.bytes += byteLength(point);
        // 仅在尾部为 CR 时多容纳一字节。超长后整行丢弃，不能把尾部当新帧。
        if (this.bytes > deviceProtocol.maxFrameBytes + (point === '\r' ? 1 : 0)) {
          this.pending = '';
          this.dropping = true;
        } else {
          this.pending += point;
        }
      }
    }
    return lines;
  }
}

/** 屏上状态 → 闪灯/蜂鸣模式。只在「新出现」时发一次，由调用方去重。 */
export function signalFor(view: DeviceView): DeviceSignal {
  if (view.quiet) return 'none';
  if (view.card?.kind === 'confirm') return 'confirm';
  if (view.card?.kind === 'nudge') return view.card.mood === 'sad' ? 'error' : 'nudge';
  return 'none';
}
