import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyHost,
  inSubnet,
  lanSubnets,
  looksLikeOffice,
  macInfo,
  mdnsByHost,
  mdnsQuery,
  normalizeLanResult,
  parseDnsPacket,
  parseHttpHome,
  parseNeighbors,
  parseShelly,
  parseSsdpResponse,
  parseUpnpDescription,
  safeLocation,
  sortDevices,
  subnetHosts,
} from '../src/core/lan-scan';
import { LanScanService, type LanScanDeps } from '../src/desktop/lan-scan';

const iface = (address: string, netmask = '255.255.255.0') => ({
  address,
  netmask,
  family: 'IPv4',
  internal: false,
});

describe('网段', () => {
  it('只要私有 IPv4，家里 Wi-Fi 排前面，虚拟网卡排后面', () => {
    const list = lanSubnets({
      'vEthernet (WSL)': [iface('172.20.80.1', '255.255.240.0')],
      WLAN: [
        iface('192.168.31.23'),
        { address: 'fe80::1', netmask: 'ffff::', family: 'IPv6', internal: false },
      ],
      Loopback: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
      Public: [iface('8.8.8.8')],
    });
    expect(list.map((item) => item.key)).toEqual(['192.168.31.0/24', '172.20.80.0/24']);
    expect(list[0]!.virtual).toBe(false);
    expect(list[1]).toMatchObject({ virtual: true, narrowed: true, address: '172.20.80.1' });
  });

  it('比 /24 大的网段只扫本机附近那 /24，最多 254 台', () => {
    const [subnet] = lanSubnets({ eth: [iface('10.1.2.3', '255.255.0.0')] });
    expect(subnet!.key).toBe('10.1.2.0/24');
    const hosts = subnetHosts(subnet!);
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe('10.1.2.1');
    expect(hosts.at(-1)).toBe('10.1.2.254');
    expect(inSubnet('10.1.2.255', subnet!)).toBe(false);
    expect(inSubnet('10.1.3.4', subnet!)).toBe(false);
    expect(inSubnet('10.1.2.77', subnet!)).toBe(true);
  });

  it('/30 只有两台', () => {
    expect(subnetHosts({ base: '192.168.1.0', prefix: 30 })).toEqual([
      '192.168.1.1',
      '192.168.1.2',
    ]);
  });
});

describe('邻居表', () => {
  it('解析中文 Windows 的 arp -a，丢掉广播和组播', () => {
    const text = [
      '接口: 192.168.31.23 --- 0x7',
      '  Internet 地址         物理地址              类型',
      '  192.168.31.1          8c-de-f9-11-22-33     动态',
      '  192.168.31.40         24-0a-c4-aa-bb-cc     动态',
      '  192.168.31.255        ff-ff-ff-ff-ff-ff     静态',
      '  224.0.0.22            01-00-5e-00-00-16     静态',
    ].join('\r\n');
    expect(parseNeighbors(text)).toEqual([
      { ip: '192.168.31.1', mac: '8c:de:f9:11:22:33' },
      { ip: '192.168.31.40', mac: '24:0a:c4:aa:bb:cc' },
    ]);
  });

  it('也认 Linux 的 ip neigh', () => {
    expect(parseNeighbors('192.168.1.5 dev wlan0 lladdr b8:27:eb:01:02:03 REACHABLE\n')).toEqual([
      { ip: '192.168.1.5', mac: 'b8:27:eb:01:02:03' },
    ]);
  });

  it('MAC 厂商：乐鑫、树莓派、随机地址', () => {
    expect(macInfo('24:0a:c4:00:00:01')).toMatchObject({ espressif: true, random: false });
    expect(macInfo('b8-27-eb-00-00-01').vendor).toBe('树莓派');
    expect(macInfo('da:a1:19:00:00:01')).toEqual({ vendor: null, random: true, espressif: false });
    expect(macInfo('00:11:22:33:44:55').vendor).toBeNull();
  });
});

/* 拼一个 mDNS 回复包（不压缩名字，够测试用）。 */
function name(value: string): Buffer {
  return Buffer.concat([
    ...value
      .split('.')
      .map((label) => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);
}
function rr(owner: string, type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), head, data]);
}
function response(records: Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...records]);
}
function txt(...entries: string[]): Buffer {
  return Buffer.concat(
    entries.map((entry) =>
      Buffer.concat([Buffer.from([Buffer.byteLength(entry)]), Buffer.from(entry)]),
    ),
  );
}
function srv(port: number, target: string): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, name(target)]);
}

describe('mDNS', () => {
  it('查询包问了总目录和关心的服务', () => {
    const query = mdnsQuery();
    expect(query.readUInt16BE(2) & 0x8000).toBe(0);
    expect(query.readUInt16BE(4)).toBeGreaterThan(10);
    expect(query.includes(Buffer.from('_esphomelib'))).toBe(true);
    // 自己发的查询包不当回复解析。
    expect(parseDnsPacket(query)).toEqual([]);
  });

  it('回复包按 A 记录归到对应 IP，带上实例名和 TXT', () => {
    const packet = response([
      rr('_googlecast._tcp.local', 12, name('客厅电视._googlecast._tcp.local')),
      rr('客厅电视._googlecast._tcp.local', 33, srv(8009, 'tv-1.local')),
      rr('客厅电视._googlecast._tcp.local', 16, txt('md=Google TV', 'fn=客厅电视', 'secret=xx')),
      rr('tv-1.local', 1, Buffer.from([192, 168, 31, 50])),
      rr('_services._dns-sd._udp.local', 12, name('_airplay._tcp.local')),
    ]);
    const records = parseDnsPacket(packet);
    expect(records).toHaveLength(5);
    const hosts = mdnsByHost(records, '192.168.31.50');
    expect(hosts.get('192.168.31.50')).toEqual({
      services: ['_googlecast._tcp', '_airplay._tcp'],
      names: ['客厅电视'],
      hostname: 'tv-1',
      txt: { md: 'Google TV', fn: '客厅电视' },
    });
  });

  it('压缩指针能跟，循环指针和截断的包不崩', () => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x8400, 2);
    header.writeUInt16BE(1, 6);
    const loop = Buffer.concat([header, Buffer.from([0xc0, 12]), Buffer.alloc(10)]);
    expect(parseDnsPacket(loop)).toEqual([]);
    const good = response([rr('_wled._tcp.local', 12, name('strip._wled._tcp.local'))]);
    expect(parseDnsPacket(good.subarray(0, good.length - 3))).toEqual([]);
  });
});

describe('SSDP 与网页', () => {
  it('解析 M-SEARCH 回复和设备描述', () => {
    const reply = parseSsdpResponse(
      'HTTP/1.1 200 OK\r\nSERVER: Linux UPnP/1.0 Samsung\r\nLOCATION: http://192.168.31.60:7676/dmr\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n',
    );
    expect(reply).toEqual({
      server: 'Linux UPnP/1.0 Samsung',
      location: 'http://192.168.31.60:7676/dmr',
      st: 'urn:schemas-upnp-org:device:MediaRenderer:1',
    });
    expect(parseSsdpResponse('M-SEARCH * HTTP/1.1\r\n\r\n')).toBeNull();
    expect(
      parseUpnpDescription(
        '<root><device><friendlyName>[TV] 客厅 &amp; 卧室</friendlyName><manufacturer>Samsung</manufacturer><modelName>QA55</modelName><device><friendlyName>子设备</friendlyName></device></device></root>',
      ),
    ).toEqual({ friendlyName: '[TV] 客厅 & 卧室', manufacturer: 'Samsung', model: 'QA55' });
  });

  it('描述地址只去发包那台的局域网 http', () => {
    expect(safeLocation('http://192.168.31.60:7676/dmr', '192.168.31.60')).toBe(
      'http://192.168.31.60:7676/dmr',
    );
    expect(safeLocation('http://192.168.31.61/x', '192.168.31.60')).toBeNull();
    expect(safeLocation('http://example.com/x', '192.168.31.60')).toBeNull();
    expect(safeLocation('file:///c:/x', '192.168.31.60')).toBeNull();
    expect(safeLocation(undefined, '192.168.31.60')).toBeNull();
  });

  it('网页指纹：Tasmota、ESPHome、Shelly 两代', () => {
    expect(parseHttpHome({}, '<html><title>Tasmota</title></html>').tasmota).toBe(true);
    expect(parseHttpHome({ server: 'ESPHome' }, '').esphome).toBe(true);
    expect(parseHttpHome({}, '<title>WLED</title>').wled).toBe(true);
    expect(parseHttpHome({}, '<title>路由器</title>')).toMatchObject({
      tasmota: false,
      esphome: false,
      title: '路由器',
    });
    expect(parseShelly('{"id":"x","gen":2,"model":"SNSW-001P16EU"}')).toEqual({
      gen: 2,
      model: 'SNSW-001P16EU',
    });
    expect(parseShelly('{"type":"SHSW-1","mac":"x"}')).toEqual({ gen: 1, model: 'SHSW-1' });
    expect(parseShelly('<html>')).toBeUndefined();
  });
});

describe('识别', () => {
  it('能接中枢的带上登记信息', () => {
    const tasmota = classifyHost({
      ip: '192.168.31.40',
      mac: '24:0a:c4:aa:bb:cc',
      ports: [80],
      http: { title: 'Tasmota', tasmota: true, esphome: false, wled: false },
    });
    expect(tasmota).toMatchObject({ category: 'hub-ready', iot: { kind: 'tasmota', channel: '' } });
    expect(tasmota.evidence[0]).toContain('Espressif');
    const shelly = classifyHost({
      ip: '192.168.31.41',
      ports: [80],
      http: { tasmota: false, esphome: false, wled: false, shelly: { gen: 2, model: 'SNSW' } },
    });
    expect(shelly).toMatchObject({
      category: 'hub-ready',
      iot: { kind: 'shelly', channel: '0' },
      model: 'SNSW',
    });
    const esphomeNoWeb = classifyHost({
      ip: '192.168.31.42',
      ports: [6053],
      mdns: { services: ['_esphomelib._tcp'], names: ['desk-plug'], txt: {} },
    });
    expect(esphomeNoWeb).toMatchObject({ category: 'hub-ready', iot: null, name: 'desk-plug' });
  });

  it('ESP 芯片、电视、路由器、手机、认不出的', () => {
    expect(
      classifyHost({ ip: '192.168.31.43', mac: '24:0a:c4:00:00:01', ports: [] }).category,
    ).toBe('flashable');
    const tv = classifyHost({
      ip: '192.168.31.50',
      ports: [8008, 8009],
      mdns: {
        services: ['_googlecast._tcp'],
        names: ['x'],
        txt: { fn: '客厅电视', md: 'Google TV' },
      },
    });
    expect(tv).toMatchObject({ category: 'media', name: '客厅电视', model: 'Google TV' });
    expect(classifyHost({ ip: '192.168.31.1', ports: [53, 80] }).category).toBe('router');
    expect(
      classifyHost({ ip: '192.168.31.70', mac: 'da:a1:19:00:00:01', ports: [] }).category,
    ).toBe('phone');
    expect(classifyHost({ ip: '192.168.31.71', ports: [62078] }).category).toBe('phone');
    expect(classifyHost({ ip: '192.168.31.72', ports: [445] }).category).toBe('computer');
    expect(classifyHost({ ip: '192.168.31.73', ports: [554] }).category).toBe('camera');
    expect(classifyHost({ ip: '192.168.31.74', ports: [] }).category).toBe('unknown');
    expect(classifyHost({ ip: '192.168.31.23', ports: [], self: true })).toMatchObject({
      category: 'computer',
      name: '这台电脑',
    });
  });

  it('真实网络里误判过的：电脑不当电视，路由器不当摄像头，错误页不当名字', () => {
    expect(classifyHost({ ip: '10.0.7.24', ports: [445, 3389, 8001] }).category).toBe('computer');
    expect(
      classifyHost({
        ip: '10.0.7.206',
        ports: [22, 80, 445, 3389],
        ssdp: {
          manufacturer: 'Microsoft Corporation',
          model: 'Windows Media Player',
          types: ['urn:schemas-upnp-org:device:MediaRenderer:1'],
        },
      }).category,
    ).toBe('computer');
    expect(
      classifyHost({
        ip: '10.0.7.38',
        ports: [22, 53, 80],
        ssdp: {
          model: 'OpenWRT router',
          types: ['urn:schemas-upnp-org:service:WANIPConnection:1'],
        },
      }).category,
    ).toBe('router');
    expect(
      classifyHost({
        ip: '10.0.7.32',
        ports: [80, 8001],
        http: {
          title: 'RouterOS router configuration page',
          tasmota: false,
          esphome: false,
          wled: false,
        },
      }).category,
    ).toBe('router');
    expect(
      classifyHost({
        ip: '10.0.7.162',
        ports: [445, 9999],
        mdns: { services: ['_smb._tcp'], names: [], txt: {} },
      }).category,
    ).toBe('computer');
    const forbidden = classifyHost({
      ip: '10.0.7.147',
      ports: [80],
      http: { title: '403 Forbidden', tasmota: false, esphome: false, wled: false },
    });
    expect(forbidden.name).toBe('');
  });

  it('电脑很多就提醒这像办公网络', () => {
    const pcs = Array.from({ length: 12 }, (_, index) =>
      classifyHost({ ip: `10.0.7.${index + 2}`, ports: [445] }),
    );
    expect(looksLikeOffice(pcs)).toBe(true);
    expect(looksLikeOffice(pcs.slice(0, 5))).toBe(false);
  });

  it('排序：能玩的在前，本机最后', () => {
    const list = sortDevices([
      classifyHost({ ip: '192.168.31.23', ports: [], self: true }),
      classifyHost({ ip: '192.168.31.74', ports: [] }),
      classifyHost({ ip: '192.168.31.43', mac: '24:0a:c4:00:00:01', ports: [] }),
      classifyHost({ ip: '192.168.31.1', ports: [53, 80] }),
    ]);
    expect(list.map((item) => item.ip)).toEqual([
      '192.168.31.43',
      '192.168.31.1',
      '192.168.31.74',
      '192.168.31.23',
    ]);
  });

  it('存盘的结果坏了就当没有，脱掉不合法的条目', () => {
    expect(normalizeLanResult(null)).toBeNull();
    expect(normalizeLanResult({ at: 1 })).toBeNull();
    const ok = normalizeLanResult({
      at: 1,
      subnet: '192.168.31.0/24',
      devices: [classifyHost({ ip: '192.168.31.74', ports: [] }), { ip: 'x', category: 'evil' }],
      notes: ['a', 3],
    });
    expect(ok?.devices).toHaveLength(1);
    expect(ok?.notes).toEqual(['a']);
  });
});

describe('LanScanService', () => {
  function deps(
    overrides: Partial<LanScanDeps> = {},
  ): LanScanDeps & { probed: string[]; fetched: string[] } {
    const probed: string[] = [];
    const fetched: string[] = [];
    let clock = 1_000;
    return {
      probed,
      fetched,
      interfaces: () => ({ WLAN: [{ ...iface('192.168.31.23'), mac: '', cidr: null } as never] }),
      probe: async (ip, port) => {
        probed.push(`${ip}:${port}`);
        if (ip === '192.168.31.40' && port === 80) return 'open';
        if (ip === '192.168.31.1' && (port === 53 || port === 80)) return 'open';
        if (ip === '192.168.31.99') return 'closed';
        return 'silent';
      },
      neighbors: async () =>
        '  192.168.31.1    8c-de-f9-11-22-33  动态\r\n  192.168.31.40   24-0a-c4-aa-bb-cc  动态\r\n  192.168.31.88   da-a1-19-00-00-01  动态\r\n  10.0.0.5  00-11-22-33-44-55 动态\r\n',
      listen: async () => ({
        mdns: new Map([
          ['192.168.31.50', { services: ['_googlecast._tcp'], names: ['客厅电视'], txt: {} }],
        ]),
        ssdp: new Map([
          [
            '192.168.31.1',
            {
              server: 'router',
              location: 'http://192.168.31.1:5000/desc.xml',
              types: ['urn:schemas-upnp-org:device:InternetGatewayDevice:1'],
            },
          ],
        ]),
        notes: [],
      }),
      http: async (url) => {
        fetched.push(url);
        if (url === 'http://192.168.31.40/')
          return { status: 200, headers: {}, body: '<title>Tasmota</title>' };
        if (url === 'http://192.168.31.1:5000/desc.xml') {
          return { status: 200, headers: {}, body: '<friendlyName>小米路由器</friendlyName>' };
        }
        return { status: 404, headers: {}, body: '' };
      },
      reverse: async (ip) => (ip === '192.168.31.88' ? 'Pixel-8.lan' : null),
      now: () => (clock += 500),
      ...overrides,
    };
  }

  it('扫一遍：合并邻居表、广播、端口和网页，只留本网段', async () => {
    const fake = deps();
    const service = new LanScanService(join(tmpdir(), 'never-written.json'), fake);
    const subnet = service.refreshSubnets()[0]!;
    const result = await service.run(subnet);
    const byIp = new Map(result.devices.map((item) => [item.ip, item]));
    expect([...byIp.keys()].sort()).toEqual(
      [
        '192.168.31.1',
        '192.168.31.23',
        '192.168.31.40',
        '192.168.31.50',
        '192.168.31.88',
        '192.168.31.99',
      ].sort(),
    );
    expect(byIp.get('192.168.31.40')).toMatchObject({
      category: 'hub-ready',
      iot: { kind: 'tasmota' },
    });
    expect(byIp.get('192.168.31.1')).toMatchObject({ category: 'router', name: '小米路由器' });
    expect(byIp.get('192.168.31.50')).toMatchObject({ category: 'media', name: '客厅电视' });
    expect(byIp.get('192.168.31.88')).toMatchObject({ category: 'phone', name: 'Pixel-8' });
    expect(byIp.get('192.168.31.23')?.self).toBe(true);
    expect(result.devices.at(-1)?.self).toBe(true);
    expect(result.scanned).toBe(253);
    // 本机不敲；网段外的邻居不收。
    expect(fake.probed).not.toContain('192.168.31.23:80');
    expect(byIp.has('10.0.0.5')).toBe(false);
    // 已经认出 Tasmota 就不再问 /shelly；只 GET，不碰命令接口。
    expect(fake.fetched).not.toContain('http://192.168.31.40/shelly');
    expect(fake.fetched.every((url) => !url.includes('cmnd'))).toBe(true);
  });

  it('start 不重入，结果存盘、重启还在', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lan-scan-'));
    const path = join(dir, 'lan-scan-v1.json');
    const service = new LanScanService(path, deps());
    await service.load();
    const done = new Promise<void>((resolve) =>
      service.subscribe((state) => {
        if (!state.running && state.last) resolve();
      }),
    );
    expect(service.start('')).toEqual({ ok: true });
    expect(service.start('')).toEqual({ ok: false, error: '已经在扫了。' });
    await done;
    // 写盘是结果出来后异步做的：等它落盘（全量测试时机器忙，给足时间）。
    let saved = '';
    for (let i = 0; i < 100 && saved === ''; i += 1) {
      saved = await readFile(path, 'utf8').catch(() => '');
      if (saved === '') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(JSON.parse(saved).subnet).toBe('192.168.31.0/24');
    const again = new LanScanService(path, deps());
    await again.load();
    expect(again.snapshot().last?.devices.length).toBeGreaterThan(3);
  });

  it('没有家庭局域网、网段选错都直接拒绝', () => {
    const none = new LanScanService('x', deps({ interfaces: () => ({}) }));
    expect(none.start('')).toMatchObject({ ok: false });
    const wrong = new LanScanService('x', deps());
    expect(wrong.start('10.9.9.0/24')).toMatchObject({ ok: false });
  });
});
