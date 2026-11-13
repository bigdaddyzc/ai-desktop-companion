/**
 * 系统命令的守门人（纯领域）。
 *
 * 为什么要放行 shell：`run_command` 走的是「程序白名单 + 不经 shell」，
 * 安全，但 npm、npx、pnpm 在 Windows 上是 .cmd，必须经 cmd.exe 才跑得起来，
 * 管道和重定向也全都不行。用户想让芯伴「把项目跑起来」，那几条路都是堵死的。
 *
 * 所以这里开了第二条路，但它是**有条件的**：
 * - 面板里单独一个开关，默认关；开了才跑；
 * - 一条命令、有长度上限、有超时、工作目录锁在工作目录内；
 * - 危险命令在**执行前**按规则拦下，并说明理由（模型会照着理由向用户解释）。
 *
 * 必须说清的残留风险：一份正则黑名单不是沙箱。`echo ... > ..\..\x` 这类
 * 绕路它挡不住，`&&` 后面接的东西也只能靠关键词识别。这条路的本质是
 * 「用户授权后，允许 AI 在本人电脑上执行命令」，止损靠的是授权、可见轨迹、
 * 可取消，以及这条命令是模型当场编的、而不是从网页里抄来的。
 */

export const shellLimits = {
  /** 一条命令。再长就该写成脚本，而不是让模型现场拼。 */
  commandChars: 400,
  timeoutMs: 60_000,
  maxOutput: 6_000,
} as const;

interface ShellRule {
  pattern: RegExp;
  reason: string;
}

/**
 * 危险动作清单。理由都要写成「它会怎样、所以不做」，
 * 这样模型能把原因原话转给用户，而不是含糊一句「被拦了」。
 */
export const shellRules: readonly ShellRule[] = [
  {
    pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)*(\/|~|\$HOME|\/\*)\s*$/i,
    reason: '这条会删掉根目录或整个家目录，不给跑。',
  },
  {
    pattern: /\b(rd|rmdir)\s+\/s\s+\/q\s+[a-z]:\\?\s*$/i,
    reason: '这条会清空整个磁盘，不给跑。',
  },
  {
    pattern: /\bdel\s+\/[fsq]|\berase\s+\/[fsq]/i,
    reason: '带 /f /s /q 的删除会成批强删且不进回收站，不给跑。',
  },
  {
    pattern: /\b(rm|del|rd|rmdir)\b[^\n]*(\.\.[\\/]){2,}/i,
    reason: '这条要删工作目录以外的东西，超出授权范围。',
  },
  {
    pattern: /\b(format|mkfs(\.\w+)?|diskpart|fdisk|diskutil\s+erase)\b/i,
    reason: '格式化/分区属于毁盘操作，不给跑。',
  },
  {
    pattern: /\b(bcdedit|bootrec|vssadmin|cipher\s+\/w|wbadmin)\b/i,
    reason: '这条动的是启动项或备份，出问题开不了机，不给跑。',
  },
  {
    pattern: /\breg(\.exe)?\s+(add|delete|import)\b/i,
    reason: '改注册表会影响整个系统，不在授权范围。',
  },
  {
    pattern: /\b(schtasks|crontab)\b/i,
    reason: '这条会留下定时任务（相当于给自己装自启动），不给跑。',
  },
  {
    pattern: /\bsc(\.exe)?\s+(delete|stop|config)\b|\bnet\s+stop\b/i,
    reason: '停止或改系统服务会连带影响别的软件，不给跑。',
  },
  {
    pattern: /\b(shutdown|reboot|restart-computer|stop-computer|logoff)\b/i,
    reason: '关机重启不该由一个桌面宠物决定。',
  },
  {
    pattern: /\bnet1?\s+(user|localgroup)\b/i,
    reason: '改账号和用户组属于系统管理，不给跑。',
  },
  {
    pattern: /\b(takeown|icacls)\b/i,
    reason: '改文件所有权/权限会把系统的安全边界拆掉，不给跑。',
  },
  {
    pattern:
      /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i,
    reason: '「下载一段脚本直接执行」是最典型的投毒方式，不给跑。',
  },
  {
    pattern: /\bpowershell(\.exe)?\b[^\n]*\s-(e|ec|enc|encodedcommand)\b/i,
    reason: 'Base64 编码的命令看不出内容，不给跑。',
  },
  {
    pattern: /\b(iex|invoke-expression)\b/i,
    reason: '把字符串当代码执行，看不出它到底干什么，不给跑。',
  },
  {
    pattern: /\bsudo\b|\brunas\b|\bstart-process\b[^\n]*-verb\s+runas/i,
    reason: '提权执行不在授权范围。',
  },
  {
    pattern: /\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b)/i,
    reason: '强推会覆盖远端历史，别人拉下来的东西就没了。',
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\b[^\n]*-[a-z]*f/i,
    reason: '这条会丢掉还没提交的改动，且不可恢复。',
  },
  {
    pattern: /\bnpm\s+(publish|unpublish)\b|\byarn\s+publish\b/i,
    reason: '发布到公共仓库是对外动作，不该顺手做。',
  },
  {
    pattern: />\s*[a-z]:\\(windows|program files)/i,
    reason: '往系统目录写文件会影响别的软件，不给跑。',
  },
  {
    pattern: /:\s*\(\s*\)\s*\{[^\n]*\}\s*;\s*:/,
    reason: '这是个 fork 炸弹，会直接把机器跑死。',
  },
  {
    pattern: /\\\\\.\\physicaldrive/i,
    reason: '直接写物理磁盘会把分区表写坏。',
  },
];

export interface ShellVerdict {
  ok: boolean;
  /** 校验通过时的规范化命令；不通过时为空串。 */
  command: string;
  /** 不通过的原因，直接给模型转述。 */
  reason: string;
}

/**
 * 执行前校验。
 *
 * 先做结构检查（空、换行、长度），再过规则表——顺序不能反：
 * 一条 10KB 的命令拿去跑正则，比拦住它更费时间。
 */
export function checkShellCommand(raw: string): ShellVerdict {
  const command = raw.replace(/^\uFEFF/, '').trim();
  if (command === '') return { ok: false, command: '', reason: '命令是空的。' };
  if (command.length > shellLimits.commandChars) {
    return {
      ok: false,
      command: '',
      reason: `命令太长了（上限 ${shellLimits.commandChars} 字），拆小一点。`,
    };
  }
  // 多行命令在 cmd 里会变成「先跑第一行，再跑第二行」，看起来像一条、其实是几条，
  // 轨迹里也显示不清。要串联就用 &&，至少能一眼看出是两件事。
  if (/[\r\n]/.test(command)) {
    return { ok: false, command: '', reason: '一次只跑一条命令，多个步骤用 && 串起来。' };
  }
  for (const rule of shellRules) {
    if (rule.pattern.test(command)) return { ok: false, command: '', reason: rule.reason };
  }
  return { ok: true, command, reason: '' };
}

/** 输出裁剪：命令的输出开头通常最有用（报错在前几行），所以砍尾不砍头。 */
export function shellOutput(raw: string, max: number = shellLimits.maxOutput): string {
  const clean = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (clean === '') return '（没有输出）';
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n…（已截断 ${clean.length - max} 字）`;
}
