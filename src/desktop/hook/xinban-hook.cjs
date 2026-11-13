#!/usr/bin/env node
// xinban-hook v5：芯伴的 agent 钩子。只记状态，不记对话内容；永远 exit 0。
//
// v5（2026-11-12）远程批准：替你确认没命中时，把请求写进 hooks/pending/，
// 等芯伴写 hooks/decisions/（你在桌宠/面板上点的）。超时、芯伴下线、异常一律交回终端。
// 往 stdout 写的只有「批准」与「你在芯伴上拒绝」。
//
// v4（2026-11-10）收紧「替你确认」的判定：变量展开、括号/脚本块、进程替换、
// 前缀环境变量、解释器选项一律算「看不懂」；改 .git/.claude 等目录、读项目外的文件交还给你；
// 记录工具参数指纹，只有「弹窗里的那一条」真的跑了才算你批准过。
//
// 安装时被原样复制到 userData/hooks/xinban-hook.cjs，由 Claude Code / Codex / WorkBuddy 调用。
// 只用 Node 内置模块，不依赖芯伴的安装目录。
//
// 两件事：
// 1. 记状态：事件名、会话 id、目录、工具名、系统提示句、操作类别，追加进收件箱。
//    不记提问、回答、工具参数原文。收件箱超过 512KB 轮转成 .old。
// 2. 替你确认（只在 PermissionRequest）：同一项目里你批过的同类操作，芯伴直接批准；
//    高风险操作永远交还给你。芯伴没开、开关没开、判断不了，一律什么都不输出，
//    对方照常弹窗问你。替你确认只会「批准」；「拒绝」只来自你在芯伴上亲手点的（v5）。
//
// 规则只在这一个文件里：桌面端安装它，测试直接 require 它。
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INBOX_MAX = 512 * 1024;
const STDIN_LIMIT = 256 * 1024;
/** 芯伴主进程每分钟写一次心跳；超过这个时间没写，就当芯伴没开。 */
const ALIVE_MS = 150 * 1000;
/** 脚本版本：芯伴启动时比对，已装的旧副本会被刷成新的。 */
const VERSION = 5;
/** approve.json 的最低规则修订号；低于它的授权不认。 */
const APPROVAL_REV = 2;
/** 远程批准最长等多久；钩子 timeout 在 hook-install.ts 里比它多 5 秒。 */
const REMOTE_MAX_WAIT_MS = 90 * 1000;
const REMOTE_POLL_MS = 200;
/** 与 src/core/confirm.ts 的 maxDetail 一致：更长的不进芯伴，直接交回终端。 */
const REMOTE_MAX_DETAIL = 800;

function clip(value, n) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, n) : '';
}

/* ---------------- 路径 ---------------- */

function isAbsolute(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

/** 统一成小写正斜杠并消掉 . / ..，用来比较「在不在项目里」。 */
function normalizePath(p) {
  const parts = [];
  const slashed = String(p).replace(/\\/g, '/');
  const lead = slashed.startsWith('//') ? '//' : slashed.startsWith('/') ? '/' : '';
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && !/^[a-z]:$/i.test(parts[parts.length - 1])) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return (lead + parts.join('/')).toLowerCase();
}

function resolveIn(cwd, p) {
  return isAbsolute(p) ? p : `${cwd}/${p}`;
}

function inside(project, p) {
  if (!project) return false;
  const root = normalizePath(project);
  const target = normalizePath(resolveIn(project, p));
  return target === root || target.startsWith(`${root}/`);
}

/** 密钥与敏感配置：.env、私钥、云凭据、包管理器令牌、secrets/credentials 文件。 */
const SECRET =
  /(^|[\\/\s"'=])(\.env(\.[\w-]+)?|id_rsa|id_ed25519|id_ecdsa|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials?(\.[\w-]+)?|secrets?\.(json|ya?ml|toml|txt|env))(?=$|[\s"'\\/])|[\\/]\.(ssh|aws|gnupg|kube|azure)([\\/]|$)|\.(pem|key|pfx|p12)(?=$|[\s"'])/i;

/**
 * 项目里也不替你批的目录：改了就能提权或长期驻留。
 * 例如 .claude/settings.local.json 写一句全部放行，整张清单当场失效；
 * .git/config 里的 core.fsmonitor 让之后每一条 git status 都执行它。
 */
const PROTECTED =
  /(^|\/)(\.git|\.claude|\.codebuddy|\.workbuddy|\.codex|\.vscode|\.idea|\.husky|\.github\/workflows)(\/|$)/;

/* ---------------- 命令拆解 ---------------- */

/**
 * 把一条 shell 命令拆成「段」（&& || ; | & 换行分隔）和每段的词，外加重定向目标。
 * 碰到这些直接标成看不懂（里面能藏任何东西）：
 * - 反引号、任何 `$`（`$(...)`、`${HOME}`、`$env:X`、`$_`）、`%VAR%`——展开后是什么只有运行时知道；
 * - 引号外的 `(` `)` `{` `}`：Bash 的子 shell / 进程替换 `<(...)`、PowerShell 的子表达式与脚本块；
 * - `[类型]::方法`：PowerShell 直接调 .NET。
 * 宁可多问一句，也不替你批一条看不懂的命令。
 */
function splitCommand(command) {
  const segments = [];
  const redirects = [];
  let opaque = false;
  let tokens = [];
  let token = '';
  let hasToken = false;
  let quote = '';
  let redirectNext = false;
  const pushToken = () => {
    if (!hasToken) return;
    if (redirectNext) {
      redirects.push(token);
      redirectNext = false;
    } else tokens.push(token);
    token = '';
    hasToken = false;
  };
  const pushSegment = () => {
    pushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = '';
      else token += c;
      continue;
    }
    if (c === '`' || c === '$') opaque = true;
    if (c === '%' && /^%[A-Za-z_][A-Za-z0-9_]*%/.test(command.slice(i))) opaque = true;
    if (quote === '"') {
      if (c === '"') quote = '';
      else token += c;
      continue;
    }
    if (c === '(' || c === ')' || c === '{' || c === '}') opaque = true;
    if (c === '[' && /^\[[\w.]+\]::/.test(command.slice(i))) opaque = true;
    if (c === '"' || c === "'") {
      quote = c;
      hasToken = true;
      continue;
    }
    if (c === ' ' || c === '\t') {
      pushToken();
      continue;
    }
    if (c === '\n' || c === '\r' || c === ';' || c === '|' || c === '&') {
      // 2>&1 / >&2 这种是重定向到文件描述符，不是分段。
      if (c === '&' && (command[i - 1] === '>' || command[i - 1] === '<')) {
        token += c;
        hasToken = true;
        continue;
      }
      pushSegment();
      if ((c === '&' || c === '|') && next === c) i += 1;
      continue;
    }
    if (c === '>') {
      // 2> / 1> 的数字属于重定向符本身。
      if (/^[0-9]$/.test(token)) {
        token = '';
        hasToken = false;
      } else pushToken();
      if (next === '>') i += 1;
      redirectNext = true;
      continue;
    }
    if (c === '<') {
      pushToken();
      continue;
    }
    token += c;
    hasToken = true;
  }
  if (quote !== '') opaque = true;
  pushSegment();
  return {
    segments,
    redirects: redirects.filter((target) => !target.startsWith('&')),
    opaque,
  };
}

function programOf(token) {
  const base = token.replace(/\\/g, '/').split('/').pop() || '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, '');
}

/* 认得的程序。没列在这里的命令，芯伴一律交还给你。 */
const READERS = new Set([
  'ls',
  'dir',
  'cat',
  'type',
  'head',
  'tail',
  'echo',
  'pwd',
  'cd',
  'grep',
  'rg',
  'findstr',
  'wc',
  'diff',
  'which',
  // sort / uniq 能写文件（sort -o、uniq in out），放在 WRITERS，写到哪里要查。
  'where',
  'tree',
  'more',
  'less',
  'stat',
  'file',
  'du',
  'df',
  'date',
  'whoami',
  'hostname',
  'jq',
  'cls',
  'clear',
  'true',
  'false',
  'basename',
  'dirname',
  'realpath',
  'get-childitem',
  'gci',
  'get-content',
  'gc',
  'select-string',
  'sls',
  'test-path',
  'get-location',
  'set-location',
  'write-output',
  'write-host',
  'get-item',
  'get-command',
  'resolve-path',
  'measure-object',
  'select-object',
  'format-table',
  'sort-object',
  'where-object',
  'find',
]);
const WRITERS = new Set([
  'mkdir',
  'md',
  'touch',
  'cp',
  'copy',
  'mv',
  'move',
  'ren',
  'rename',
  'new-item',
  'ni',
  'copy-item',
  'cpi',
  'move-item',
  'mi',
  'rename-item',
  'set-content',
  'add-content',
  'out-file',
  'sed',
  'awk',
  'tee',
  'sort',
  'uniq',
]);
const TOOLS = new Set([
  'tsc',
  'vitest',
  'jest',
  'mocha',
  'eslint',
  'prettier',
  'biome',
  'pytest',
  'make',
  'cmake',
  'ninja',
  'mvn',
  'gradle',
  'gradlew',
  'javac',
  'rustc',
  'gcc',
  'g++',
  'clang',
  'curl',
  'wget',
  'vite',
  'webpack',
  'rollup',
  'esbuild',
  'turbo',
  'nx',
  'electron',
  'electron-builder',
]);
/** 第一个参数就是要跑的脚本：每个脚本单独算一类。 */
const INTERPRETERS = new Set(['node', 'tsx', 'ts-node', 'python', 'python3', 'py', 'java', 'deno']);
/** 带子命令的：git status 和 git push 是两回事。 */
const WITH_SUB = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'cargo',
  'go',
  'dotnet',
  'playwright',
]);
const DELETERS = new Set([
  'rm',
  'del',
  'erase',
  'rmdir',
  'rd',
  'remove-item',
  'ri',
  'rimraf',
  'unlink',
  'shred',
  'trash',
]);
const PACKAGE_MANAGERS = new Set([
  'pip',
  'pip3',
  'uv',
  'poetry',
  'conda',
  'pipx',
  'gem',
  'winget',
  'choco',
  'scoop',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'brew',
  'snap',
  'npx',
  'pnpx',
  'bunx',
]);
/** 自己就能执行任意代码的入口：芯伴看不懂里面要干什么。 */
const OPAQUE = new Set([
  'sudo',
  'runas',
  'eval',
  'exec',
  'source',
  'iex',
  'invoke-expression',
  'start-process',
  'start',
  'call',
  'powershell',
  'pwsh',
  'cmd',
  'bash',
  'sh',
  'zsh',
  'wsl',
  'env',
  'printenv',
  'set',
  'export',
  'xargs',
  'nohup',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'rsync',
  'nc',
  'ncat',
  'telnet',
  'gh',
  'docker',
  'kubectl',
  'reg',
  'regedit',
  'schtasks',
  'sc',
  'net',
  'netsh',
  'icacls',
  'takeown',
  'chmod',
  'chown',
  'format',
  'diskpart',
  'shutdown',
  'taskkill',
  'kill',
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
]);
const INSTALL_SUBS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'uninstall',
  'un',
  'update',
  'up',
  'upgrade',
  'ci',
  'link',
  'unlink',
  'dlx',
  'exec',
  'x',
  'create',
  'publish',
  'unpublish',
  'get',
  'tool',
  'global',
  'dedupe',
  'prune',
  'audit',
]);

function firstArg(args) {
  return args.find((arg) => !arg.startsWith('-')) || '';
}

/**
 * 参数里的路径部分：`--out=/x`、`-o/x`、`-Path=C:\x` 这种和选项连写的也要拎出来，
 * 否则 `curl -o/c/Users/me/.bashrc` 会被当成一个普通选项放过去。
 */
function pathPart(arg) {
  if (arg.includes('=') && !isAbsolute(arg)) return arg.slice(arg.indexOf('=') + 1);
  const attached = /^-[a-zA-Z](.+)$/.exec(arg);
  if (attached && !arg.startsWith('--')) return attached[1];
  return arg;
}

/**
 * 看起来像路径的词：盘符、~、带 .. 的、多级绝对路径 /x/y（含 Git Bash 的 /c/Users）、UNC。
 * 单级的 /s、/MIR 是 Windows 开关，不算；网址不算。
 */
function looksLikePath(arg) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return false;
  const value = pathPart(arg);
  return (
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^~/.test(value) ||
    /(^|[\\/])\.\.([\\/]|$)/.test(value) ||
    /^\/[^\s]*\//.test(value) ||
    value.startsWith('\\\\')
  );
}

function escapes(project, arg) {
  if (!looksLikePath(arg)) return false;
  const value = pathPart(arg);
  if (/^~/.test(value)) return true;
  return !inside(project, value);
}

function curlUploads(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (/^(-d|--data.*|-F|--form.*|-T|--upload-file|--json)$/.test(arg)) return true;
    if (/^-[a-zA-Z]*[dFT]/.test(arg) && !arg.startsWith('--')) return true;
    // -H @文件、--header=@文件：把文件内容当请求头发出去；-K/--config：从文件读任意参数。
    if (arg.startsWith('@') || /=@/.test(arg)) return true;
    if (/^(-K|--config)/.test(arg)) return true;
    if ((arg === '-X' || arg === '--request') && !/^(get|head)$/i.test(args[i + 1] || ''))
      return true;
    if (/^-X(?!get|head)/i.test(arg) && arg.length > 2) return true;
  }
  return false;
}

/**
 * 一段命令 → { key, risk }。risk 非空就必须问你；key 是「同类操作」的名字，
 * 你批过一次，同一项目里同 key 的就可以由芯伴批准。
 */
function classifySegment(tokens, project) {
  const words = tokens.slice();
  if (words.length === 0) return { key: '', risk: '' };
  // FOO=bar cmd：前缀变量能改变程序行为（GIT_EXTERNAL_DIFF、NODE_OPTIONS、PAGER…），一律交还。
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return { key: '', risk: '芯伴认不出的命令' };
  const prog = programOf(words[0]);
  const args = words.slice(1);
  const lower = args.map((arg) => arg.toLowerCase());

  for (const arg of words) if (SECRET.test(arg)) return { key: '', risk: '碰密钥或敏感配置' };
  if (DELETERS.has(prog)) return { key: '', risk: '删除文件' };
  if (PACKAGE_MANAGERS.has(prog)) return { key: '', risk: '安装、卸载或下载运行软件包' };
  if (OPAQUE.has(prog)) return { key: '', risk: '芯伴认不出的命令' };

  let key = '';
  if (WITH_SUB.has(prog)) {
    const sub = firstArg(lower);
    if (prog === 'git') {
      if (sub === 'push') return { key: '', risk: '推送到远程（git push）' };
      if (sub === 'reset' && lower.includes('--hard'))
        return { key: '', risk: '丢弃改动（reset --hard）' };
      if (['clean', 'rebase', 'filter-branch', 'filter-repo', 'gc', 'prune'].includes(sub)) {
        return { key: '', risk: `改写或清理仓库（git ${sub}）` };
      }
      if (
        ['checkout', 'restore', 'switch'].includes(sub) &&
        (lower.includes('--') ||
          lower.includes('.') ||
          lower.includes('-f') ||
          lower.includes('--force'))
      ) {
        return { key: '', risk: '丢弃改动' };
      }
      if (sub === 'branch' && lower.some((arg) => /^(-d|-D|--delete|-f|--force)$/i.test(arg))) {
        return { key: '', risk: '删除分支' };
      }
      if (sub === 'stash' && lower.some((arg) => arg === 'drop' || arg === 'clear'))
        return { key: '', risk: '丢弃暂存' };
      if (['tag', 'remote', 'config', 'update-ref', 'submodule'].includes(sub) && args.length > 1) {
        return { key: '', risk: `改仓库设置（git ${sub}）` };
      }
      if (lower.includes('--force') || lower.includes('--force-with-lease'))
        return { key: '', risk: '强制覆盖' };
    } else if (sub === '' && (prog === 'yarn' || prog === 'bun')) {
      return { key: '', risk: '安装、卸载或下载运行软件包' };
    } else if (INSTALL_SUBS.has(sub) || (prog === 'playwright' && sub === 'install')) {
      return { key: '', risk: '安装、卸载或下载运行软件包' };
    }
    if (sub === '') return { key: '', risk: '芯伴认不出的命令' };
    key = `${prog} ${sub}`;
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(prog) && sub === 'run') {
      const script = firstArg(lower.slice(lower.indexOf('run') + 1));
      key = script ? `${prog} run ${script}` : key;
    }
  } else if (INTERPRETERS.has(prog)) {
    // 解释器的任何选项都可能带代码进来（--eval=、--require、--import、-pe…），只认「解释器 脚本 参数」。
    if (lower.length === 0 || lower[0].startsWith('-')) {
      return { key: '', risk: '芯伴认不出的命令' };
    }
    key = `${prog} ${firstArg(args)}`;
  } else if (prog === 'find') {
    if (lower.some((arg) => arg === '-delete')) return { key: '', risk: '删除文件' };
    if (lower.some((arg) => /^-(exec|execdir|ok|okdir)$/.test(arg)))
      return { key: '', risk: '芯伴认不出的命令' };
    key = 'find';
  } else if (prog === 'curl' || prog === 'wget') {
    if (prog === 'curl' && curlUploads(args)) return { key: '', risk: '联网上传' };
    if (prog === 'wget' && lower.some((arg) => /^--(post|method|body)/.test(arg)))
      return { key: '', risk: '联网上传' };
    key = prog;
  } else if (READERS.has(prog) || WRITERS.has(prog) || TOOLS.has(prog)) {
    if (WRITERS.has(prog) && lower.some((arg) => /^(-f|--force|\/y|-force)$/.test(arg))) {
      return { key: '', risk: '强制覆盖' };
    }
    key = prog;
  } else {
    return { key: '', risk: '芯伴认不出的命令' };
  }

  // 只读命令看项目外的单个文件没关系；会写东西的、或者 cd 出去的，都要问。
  if (!READERS.has(prog) || prog === 'cd' || prog === 'set-location') {
    if (words.some((word) => escapes(project, word)))
      return { key: '', risk: '动项目目录以外的文件' };
  } else {
    // 只读命令在项目外用通配符或递归：`cat ~/.ss*/id_*`、`grep -r KEY ~` 能扫出密钥，字面匹配拦不住。
    const wide =
      words.some((word) => /[*?]/.test(word)) ||
      lower.some((arg) => /^(-[a-z]*r[a-z]*|--recursive|-recurse)$/i.test(arg));
    if (wide && words.some((word) => escapes(project, word)))
      return { key: '', risk: '动项目目录以外的文件' };
  }
  return { key: clip(key, 60), risk: '' };
}

function classifyCommand(command, project) {
  if (typeof command !== 'string' || command.trim() === '')
    return { keys: [], risk: '芯伴认不出的命令' };
  const parsed = splitCommand(command);
  if (parsed.opaque) return { keys: [], risk: '芯伴认不出的命令' };
  for (const target of parsed.redirects) {
    if (/^(nul|\/dev\/null|\$null)$/i.test(target)) continue;
    if (SECRET.test(target)) return { keys: [], risk: '碰密钥或敏感配置' };
    if (!inside(project, target) || /^(~|\$home|%)/i.test(target))
      return { keys: [], risk: '动项目目录以外的文件' };
  }
  const keys = [];
  for (const tokens of parsed.segments) {
    const result = classifySegment(tokens, project);
    if (result.risk) return { keys: [], risk: result.risk };
    if (result.key && !keys.includes(result.key)) keys.push(result.key);
  }
  if (keys.length === 0) return { keys: [], risk: '芯伴认不出的命令' };
  return { keys: keys.slice(0, 6), risk: '' };
}

/**
 * 一次权限请求 → { keys, risk }。
 * 工具名 Claude Code 与 CodeBuddy 相同（Bash / Edit / Write / Read / WebFetch ...）。
 */
function classify(tool, input, cwd) {
  const data = input && typeof input === 'object' ? input : {};
  const project = typeof cwd === 'string' ? cwd : '';
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return classifyCommand(data.command, project);
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const file = typeof data.file_path === 'string' ? data.file_path : data.notebook_path;
      if (typeof file !== 'string' || file === '')
        return { keys: [], risk: '芯伴认不出要改哪个文件' };
      if (SECRET.test(file)) return { keys: [], risk: '碰密钥或敏感配置' };
      if (!inside(project, file)) return { keys: [], risk: '动项目目录以外的文件' };
      if (PROTECTED.test(normalizePath(resolveIn(project, file)))) {
        return { keys: [], risk: '改工具配置或仓库内部文件' };
      }
      return { keys: ['改文件'], risk: '' };
    }
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS': {
      const fields = [data.file_path, data.path, data.pattern, data.glob].filter(
        (v) => typeof v === 'string' && v !== '',
      );
      if (fields.some((v) => SECRET.test(v))) return { keys: [], risk: '碰密钥或敏感配置' };
      // 读的位置：Read 是 file_path，Grep/Glob/LS 是 path（没给就是项目本身）。
      const where = [data.file_path, data.path].find((v) => typeof v === 'string' && v !== '');
      if (where && !inside(project, where)) return { keys: [], risk: '动项目目录以外的文件' };
      return { keys: ['读文件'], risk: '' };
    }
    case 'WebFetch': {
      let host = '';
      try {
        host = new URL(String(data.url)).hostname.toLowerCase();
      } catch {
        host = '';
      }
      if (!host) return { keys: [], risk: '芯伴认不出要打开的网址' };
      return { keys: [clip(`打开网页 ${host}`, 60)], risk: '' };
    }
    case 'WebSearch':
      return { keys: ['搜索网页'], risk: '' };
    default:
      return { keys: [], risk: clip(`芯伴认不出的工具：${tool || '未知'}`, 40) };
  }
}

/**
 * 该不该替你批准。state 是芯伴写的 approve.json，aliveAt 是心跳时间。
 * 任何一项不满足都返回 false，交给对方照常弹窗。
 */
function decide(source, keys, risk, cwd, state, aliveAt, now) {
  if (risk || keys.length === 0) return false;
  if (!state || state.v !== 1 || state.enabled !== true || !Array.isArray(state.grants))
    return false;
  // 旧规则下学到的授权不认（与 src/core/auto-approve.ts 的 APPROVAL_REV 一致）。
  if (!(typeof state.rev === 'number' && state.rev >= APPROVAL_REV)) return false;
  if (!(now - aliveAt <= ALIVE_MS)) return false;
  const project = normalizePath(cwd || '');
  if (project === '') return false;
  return keys.every((key) =>
    state.grants.some(
      (grant) =>
        grant &&
        grant.source === source &&
        grant.key === key &&
        typeof grant.project === 'string' &&
        normalizePath(grant.project) === project,
    ),
  );
}

/* ---------------- 运行 ---------------- */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function aliveAt(dir) {
  try {
    const at = Number(fs.readFileSync(path.join(dir, 'alive'), 'utf8').trim());
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/**
 * 芯伴自己派出去的活会在环境里带上派活 ID：记进事件，工作台就能把这个会话和派活记录对上，
 * 不会同一件活显示两条。只认纯数字（开工时刻）。
 */
const DELEGATE_ID = /^\d{10,16}$/.test(process.env.XINBAN_DELEGATE_ID || '')
  ? process.env.XINBAN_DELEGATE_ID
  : '';

function write(inbox, record) {
  if (DELEGATE_ID && !record.job) record.job = DELEGATE_ID;
  try {
    const info = fs.statSync(inbox, { throwIfNoEntry: false });
    if (info && info.size > INBOX_MAX) fs.renameSync(inbox, `${inbox}.old`);
    fs.appendFileSync(inbox, `${JSON.stringify(record)}\n`);
  } catch {
    // 记不下就算了：旁观者绝不能影响对方。
  }
}

/** 字段顺序无关的 JSON，用来算指纹。 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * 工具参数指纹：只存哈希前 16 位，不存内容。
 * 弹窗请求和之后的「跑了」指纹一致，才说明你批的就是这一条；
 * 否则你拒了 A、它自己跑了同类的 B（已在你的白名单里），也会被误当成你批过 A。
 */
function fingerprint(tool, input) {
  return crypto
    .createHash('sha256')
    .update(`${tool}\n${stable(input)}`)
    .digest('hex')
    .slice(0, 16);
}

function pick(raw, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]{0,200})"`).exec(raw);
  return m ? m[1] : '';
}

function agentEvent(raw, from, inbox) {
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object') {
    // 工具输出太大被截断时，从开头抠出事件名和会话 id 就够了。
    const head = raw.slice(0, 8192);
    data = {
      hook_event_name: pick(head, 'hook_event_name'),
      session_id: pick(head, 'session_id'),
      cwd: pick(head, 'cwd'),
    };
  }
  const record = {
    v: 1,
    src: from,
    ev: clip(data.hook_event_name, 40),
    sid: clip(data.session_id, 80),
    cwd: clip(data.cwd, 300),
    at: Date.now(),
  };
  if (!record.ev || !record.sid) return;
  if (data.notification_type) record.type = clip(data.notification_type, 40);
  if (record.ev === 'Notification') record.msg = clip(data.message, 160);
  if (data.tool_name) record.tool = clip(data.tool_name, 60);

  if ((record.ev === 'PermissionRequest' || record.ev === 'PostToolUse') && data.tool_name) {
    const verdict = classify(data.tool_name, data.tool_input, data.cwd);
    record.keys = verdict.keys;
    record.fp = fingerprint(data.tool_name, data.tool_input);
    if (record.ev === 'PermissionRequest') {
      record.risk = verdict.risk;
      const dir = __dirname;
      const source = from === 'claude' ? 'claude-code' : from;
      const allow = decide(
        source,
        verdict.keys,
        verdict.risk,
        data.cwd,
        readJson(path.join(dir, 'approve.json')),
        aliveAt(dir),
        record.at,
      );
      if (allow) {
        record.auto = true;
        process.stdout.write(answer('allow'));
      } else {
        // 先记请求：等待期间工作台就能看到「在等你」。
        write(inbox, record);
        const started = Date.now();
        const result = askRemote(dir, {
          src: source,
          tool: record.tool,
          input: data.tool_input,
          cwd: record.cwd,
          fp: record.fp,
          keys: verdict.keys,
          risk: verdict.risk,
        });
        if (result === 'allow' || result === 'deny') process.stdout.write(answer(result));
        if (result !== 'off') {
          write(inbox, {
            v: 1,
            src: from,
            ev: 'RemoteDecision',
            sid: record.sid,
            cwd: record.cwd,
            at: Date.now(),
            tool: record.tool,
            fp: record.fp,
            type: result,
            ms: Date.now() - started,
          });
        }
        return;
      }
    }
  }
  write(inbox, record);
}

/* ---------------- 远程批准（v5） ---------------- */

function answer(behavior) {
  const decision =
    behavior === 'deny'
      ? { behavior: 'deny', message: '你在芯伴上拒绝了这一步。' }
      : { behavior: 'allow' };
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  });
}

/** 卡片上给你看的原文：命令、文件路径、网址。认不出就是整份参数。 */
function detailOf(tool, input) {
  const data = input && typeof input === 'object' ? input : {};
  const first = (...values) => values.find((v) => typeof v === 'string' && v !== '') || '';
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return first(data.command);
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return first(data.file_path, data.notebook_path);
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return [data.pattern, data.file_path, data.path, data.glob]
        .filter((v) => typeof v === 'string' && v !== '')
        .join('  ');
    case 'WebFetch':
      return first(data.url);
    case 'WebSearch':
      return first(data.query);
    default:
      return input === undefined ? '' : stable(input);
  }
}

const SLEEP = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) {
  Atomics.wait(SLEEP, 0, 0, ms);
}

function remoteConfig(dir) {
  const raw = readJson(path.join(dir, 'remote.json'));
  if (!raw || raw.v !== 1 || raw.enabled !== true) return null;
  const wait = Number(raw.waitMs);
  if (!Number.isFinite(wait)) return null;
  return { waitMs: Math.min(REMOTE_MAX_WAIT_MS, Math.max(5_000, wait)) };
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 删不掉也无所谓：芯伴启动时会清掉旧文件。
  }
}

/**
 * 把请求交给芯伴，等你在桌宠/面板/实体键上回答。
 * 返回 allow / deny；超时、芯伴下线、你点「交回终端」、任何异常都不替你决定，
 * 返回 timeout / offline / defer / error，对方照常弹窗。off：压根没问（关着或芯伴没开）。
 */
function askRemote(dir, request, clock = { now: Date.now, sleep }) {
  const config = remoteConfig(dir);
  const start = clock.now();
  if (!config || !(start - aliveAt(dir) <= ALIVE_MS)) return 'off';
  const detail = detailOf(request.tool, request.input);
  if (detail === '' || detail.length > REMOTE_MAX_DETAIL) return 'off';
  const id = crypto.randomUUID();
  const pendingFile = path.join(dir, 'pending', `${id}.json`);
  const decisionFile = path.join(dir, 'decisions', `${id}.json`);
  const deadline = start + config.waitMs;
  try {
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    const temporary = `${pendingFile}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({
        v: 1,
        id,
        fp: request.fp,
        src: request.src,
        tool: request.tool,
        cwd: request.cwd,
        detail,
        keys: request.keys,
        risk: request.risk,
        at: start,
        deadline,
        pid: process.pid,
      }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, pendingFile);
  } catch {
    removeQuietly(`${pendingFile}.tmp`);
    return 'error';
  }
  let result = 'timeout';
  try {
    let lastAliveCheck = start;
    while (clock.now() < deadline) {
      const decision = readJson(decisionFile);
      // 对不上 id 与指纹的一律当没看见；半写入的文件解析失败也是没看见。
      if (
        decision &&
        decision.v === 1 &&
        decision.id === id &&
        decision.fp === request.fp &&
        (decision.decision === 'allow' ||
          decision.decision === 'deny' ||
          decision.decision === 'defer')
      ) {
        result = decision.decision;
        break;
      }
      if (clock.now() - lastAliveCheck >= 1_000) {
        lastAliveCheck = clock.now();
        if (!(lastAliveCheck - aliveAt(dir) <= ALIVE_MS)) {
          result = 'offline';
          break;
        }
      }
      clock.sleep(REMOTE_POLL_MS);
    }
  } catch {
    result = 'error';
  }
  removeQuietly(pendingFile);
  removeQuietly(decisionFile);
  return result;
}

function codexEvent(raw, inbox) {
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!data || typeof data !== 'object') return;
  const record = {
    v: 1,
    src: 'codex',
    ev: clip(data.type, 40),
    sid: clip(data['thread-id'], 80),
    cwd: clip(data.cwd, 300),
    at: Date.now(),
  };
  if (record.ev && record.sid) write(inbox, record);
}

function main() {
  const src = process.argv[2];
  const inbox = process.argv[3];
  if (!inbox || (src !== 'claude' && src !== 'codex' && src !== 'workbuddy')) process.exit(0);
  if (src === 'codex') {
    codexEvent(process.argv[4] || '', inbox);
    process.exit(0);
  }
  let buf = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try {
      agentEvent(buf, src, inbox);
    } catch {
      // 永远不让异常冒出去。
    }
    process.exit(0);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (buf.length < STDIN_LIMIT) buf += chunk;
  });
  process.stdin.on('end', finish);
  process.stdin.on('error', () => process.exit(0));
  setTimeout(finish, 5000).unref();
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.exit(0);
  }
} else {
  module.exports = {
    classify,
    classifyCommand,
    splitCommand,
    decide,
    fingerprint,
    normalizePath,
    inside,
    askRemote,
    detailOf,
    ALIVE_MS,
    VERSION,
    REMOTE_MAX_WAIT_MS,
  };
}
