// Local, isolated toolchain. setup/build/test never touch a device; only the
// explicit `flash` and `probe` modes open a serial port.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tools = join(root, '.tools');
const windows = process.platform === 'win32';
const python = join(tools, 'firmware-venv', windows ? 'Scripts/python.exe' : 'bin/python');
const env = {
  ...process.env,
  PYTHONUTF8: '1',
  PLATFORMIO_CORE_DIR: join(tools, 'platformio'),
  ZIG_GLOBAL_CACHE_DIR: join(tools, 'zig-cache'),
};
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const mode = process.argv[2];
const project = join(root, 'firmware/xinban-device');
if (mode === 'setup') {
  mkdirSync(tools, { recursive: true });
  if (!existsSync(python))
    run(process.env.PYTHON ?? 'python', ['-m', 'venv', join(tools, 'firmware-venv')]);
  run(python, ['-m', 'pip', 'install', '-r', join(root, 'firmware/requirements.txt')]);
  run(python, ['-m', 'platformio', 'pkg', 'install', '-d', project]);
  if (windows) run(python, [join(root, 'firmware/bootstrap-native.py')]);
} else if (mode === 'build') {
  if (!existsSync(python)) throw new Error('先运行 npm run firmware:setup');
  run(python, ['-m', 'platformio', 'run', '-d', project, ...process.argv.slice(3)]);
} else if (mode === 'test') {
  const compiler =
    process.env.CXX ?? (windows ? join(tools, 'zig-windows-x86_64-0.13.0/zig.exe') : 'c++');
  const lib = join(project, '.pio/libdeps/esp32-s3-n16r8/ArduinoJson/src');
  if (!existsSync(join(lib, 'ArduinoJson.h'))) throw new Error('先运行 npm run firmware:setup');
  const executable = join(tools, windows ? 'device-contracts.exe' : 'device-contracts');
  run(compiler, [
    ...(windows && !process.env.CXX ? ['c++'] : []),
    '-std=c++11',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-finput-charset=UTF-8',
    '-fexec-charset=UTF-8',
    ...(windows ? ['-static'] : []),
    '-I',
    join(project, 'include'),
    '-I',
    lib,
    join(project, 'test/native/main.cpp'),
    '-o',
    executable,
  ]);
  run(executable, [join(root, 'tests/fixtures/device-contract.json')]);
} else if (mode === 'flash') {
  // 烧录：只在用户明确运行时动板子。默认用户实购套件的配置。
  if (!existsSync(python)) throw new Error('先运行 npm run firmware:setup');
  const flags = parseFlags(process.argv.slice(3));
  const target = flags.env ?? 's3-kit-28';
  const port = flags.port ? ['--upload-port', flags.port] : [];
  run(python, ['-m', 'platformio', 'run', '-d', project, '-e', target, '-t', 'upload', ...port]);
} else if (mode === 'probe') {
  await probe(parseFlags(process.argv.slice(3)));
} else throw new Error('usage: node scripts/firmware.mjs setup|build|test|flash|probe');

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--(env|port|seconds)(?:=(.*))?$/.exec(args[i]);
    if (!m) throw new Error(`看不懂参数：${args[i]}`);
    out[m[1]] = m[2] ?? args[++i];
  }
  return out;
}

// 不开芯伴也能验板子：握手、心跳、画一帧测试画面、闪一下绿灯，然后把板子发来的帧都打出来。
// 芯伴开着并占着串口时会打不开，先在面板里关掉「硬件」。
async function probe(flags) {
  const { SerialPort } = await import('serialport');
  const ports = await SerialPort.list();
  const known = { '303a': 'Espressif 原生 USB', '1a86': 'CH34x', '10c4': 'CP210x', '0403': 'FTDI' };
  for (const p of ports) {
    const vid = (p.vendorId ?? '').toLowerCase();
    console.log(`  ${p.path}  ${known[vid] ?? '-'}  ${p.friendlyName ?? p.manufacturer ?? ''}`);
  }
  const pick =
    flags.port ??
    (
      ports.find((p) => (p.vendorId ?? '').toLowerCase() === '303a') ??
      ports.find((p) => (p.vendorId ?? '').toLowerCase() in known)
    )?.path;
  if (!pick) {
    console.log('没找到像 ESP32 的串口。换根数据线（不是只能充电的那种），或用 --port COMx 指定。');
    process.exit(2);
  }
  const seconds = Number(flags.seconds ?? 10);
  console.log(`打开 ${pick}，听 ${seconds} 秒……期间可以按 BOOT 键或摸屏幕底部的 A/B。`);
  const port = new SerialPort({ path: pick, baudRate: 115200, autoOpen: false, hupcl: false });
  await new Promise((ok, fail) => port.open((e) => (e ? fail(e) : ok())));
  await new Promise((ok) => port.set({ dtr: true, rts: false }, () => ok()));
  const send = (frame) => port.write(`${JSON.stringify(frame)}\n`);
  let pending = '';
  let hello = null;
  port.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at).replace(/\r$/, '');
      pending = pending.slice(at + 1);
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        if (line.trim()) console.log(`  (非协议输出) ${line.slice(0, 120)}`);
        continue;
      }
      console.log(`  ← ${line.slice(0, 200)}`);
      if (frame.t === 'hello' && !hello) {
        hello = frame;
        send({ t: 'ping', n: 1 });
        send({
          t: 'view',
          view: {
            v: 1,
            mood: 'happy',
            face: null,
            title: '芯伴连上了',
            detail: `测试画面 · ${pick}`,
            corner: new Date().toTimeString().slice(0, 5),
            quiet: false,
            card: null,
            timer: null,
            todo: null,
            work: '',
            bubble: '看到这行字，屏幕和串口都通了。',
          },
        });
        send({ t: 'signal', pattern: 'happy' });
      }
    }
  });
  await new Promise((ok) => setTimeout(ok, 300));
  send({ t: 'hello', proto: 1, host: 'xinban-probe', v: 'probe' });
  const keepAlive = setInterval(() => send({ t: 'ping', n: Date.now() % 1e6 }), 5000);
  await new Promise((ok) => setTimeout(ok, seconds * 1000));
  clearInterval(keepAlive);
  await new Promise((ok) => port.close(() => ok()));
  if (!hello) {
    console.log(
      '没收到板子的 hello：确认已烧录芯伴固件；换另一个 Type-C 口试试；或按一下 RST 再跑。',
    );
    process.exit(1);
  }
  console.log(
    `握手成功：fw ${hello.fw} · ${hello.board ?? '?'} · 屏 ${hello.screen?.w}x${hello.screen?.h} · ${(hello.caps ?? []).join(',')}`,
  );
}
