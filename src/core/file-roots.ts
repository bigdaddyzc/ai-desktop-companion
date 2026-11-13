/**
 * 「授权目录」：除了沙盒工作目录，你在面板里亲手添加的目录，芯伴可以读、（开了写权限的）创建与修改文件。
 *
 * 规则都在代码里，不靠提示词：
 * - 只有你在面板里加的目录算数，模型不能自己添加；
 * - 盘符根、系统目录、你的用户目录本身及其上级、芯伴自己的数据目录都不能加；
 * - 目录里的密钥类文件（.env、私钥、凭据）不读不写：读了就会随请求发给模型；
 * - 工具配置与自动执行的位置（.git、.github/workflows、.claude、可执行脚本…）不写；
 * - 写每次都要你确认，卡上是改动 diff；写前备份到芯伴自己的目录，可以撤销。
 */

export interface FileRoot {
  /** 给模型和你看的短名，唯一。 */
  name: string;
  /** 绝对路径。 */
  path: string;
  /** 关着时只能读和列目录。 */
  writable: boolean;
}

export interface FileRootsConfig {
  version: 1;
  roots: FileRoot[];
}

/** 一次写入的记录：写了哪、原来有没有、备份在哪。撤销靠它。 */
export interface FileChange {
  id: string;
  at: number;
  root: string;
  /** 绝对路径。 */
  path: string;
  /** deleted 只出现在撤销「新建」时。 */
  action: 'created' | 'modified' | 'deleted';
  tool: 'write_file' | 'edit_file';
  /** 原文件备份的文件名（在芯伴自己的备份目录里）；新建的没有。 */
  backup: string | null;
  undone: boolean;
  /** 旧记录或中断后的冲突不能直接撤销。 */
  status?: 'prepared' | 'applied' | 'conflict';
}

export interface FilesSnapshot {
  error?: string | null;
  roots: FileRoot[];
  changes: FileChange[];
}

export type FilesResult = { ok: true } | { ok: false; error: string };

export const fileRootLimits = {
  maxRoots: 12,
  maxName: 24,
  maxPath: 260,
  /** 确认卡上 diff 最多显示多少字；更长的写明「还有 N 行没显示」。 */
  diffChars: 2_400,
  /** 改动记录留几条（每条带一份备份）。 */
  changes: 30,
} as const;

export function emptyFileRoots(): FileRootsConfig {
  return { version: 1, roots: [] };
}

const isWindowsPath = (path: string): boolean => /^[a-zA-Z]:[\\/]/.test(path);

/** 统一分隔符、去掉末尾斜杠；Windows 路径比较时不分大小写。 */
export function normalizeRootPath(path: string): string {
  let out = path.trim().replace(/[\\/]+/g, isWindowsPath(path.trim()) ? '\\' : '/');
  while (out.length > 3 && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

function comparable(path: string): string {
  const normal = normalizeRootPath(path);
  return isWindowsPath(normal) ? normal.toLowerCase() : normal;
}

/** a 是不是 b 本身或 b 的上级。 */
export function isSameOrAncestor(a: string, b: string): boolean {
  const left = comparable(a);
  const right = comparable(b);
  if (left === right) return true;
  const sep = isWindowsPath(left) ? '\\' : '/';
  const prefix = left.endsWith(sep) ? left : left + sep;
  return right.startsWith(prefix);
}

/** 系统目录：加了等于让模型碰操作系统。 */
const systemDirs = [
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata(\\|$)/i,
  /^[a-z]:\\\$recycle\.bin(\\|$)/i,
  /^[a-z]:\\system volume information(\\|$)/i,
  /^\/(etc|bin|sbin|usr|var|proc|sys|boot|dev|lib|lib64)(\/|$)/,
];

/**
 * 这个目录能不能授权。返回空串表示可以。
 * forbidden：不能碰的目录（用户目录、芯伴数据目录、应用目录）——授权目录不能是它们本身或上级，
 * 也不能落在芯伴数据目录里（那里有替你确认的授权表和加密的 Key）。
 */
export function fileRootProblem(
  raw: string,
  forbidden: { home: string; userData: string; appDir: string },
): string {
  const path = normalizeRootPath(raw);
  if (path === '') return '路径不能为空。';
  if (path.length > fileRootLimits.maxPath) return '路径太长。';
  if (path.includes('\0') || /[*?"<>|]/.test(path.slice(2))) return '路径里有非法字符。';
  if (!isWindowsPath(path) && !path.startsWith('/')) return '要填完整路径，比如 D:\\docs。';
  if (/^[a-zA-Z]:\\?$/.test(path) || path === '/') return '不能授权整个磁盘。';
  if (/[\\/]\.\.?([\\/]|$)/.test(path)) return '路径里不能有 . 或 ..。';
  if (systemDirs.some((pattern) => pattern.test(path))) return '不能授权系统目录。';
  if (isSameOrAncestor(path, forbidden.home))
    return '不能授权你的整个用户目录（里面有密钥和各种配置），请选具体的子文件夹。';
  for (const dir of [forbidden.userData, forbidden.appDir]) {
    if (isSameOrAncestor(path, dir) || isSameOrAncestor(dir, path)) {
      return '不能授权芯伴自己的程序或数据目录。';
    }
  }
  return '';
}

/** 从路径派生一个不重复的短名。 */
export function rootNameFor(path: string, taken: readonly string[]): string {
  const base =
    normalizeRootPath(path)
      .split(/[\\/]/)
      .filter((part) => part !== '')
      .pop()
      ?.replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, fileRootLimits.maxName) || 'dir';
  const lower = new Set(taken.map((name) => name.toLowerCase()));
  if (!lower.has(base.toLowerCase()) && base.toLowerCase() !== 'workspace') return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base.slice(0, fileRootLimits.maxName - 3)}-${index}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/** 读写都不碰的文件：读了就会随请求发给模型。 */
const secretFiles = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[\\/])\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /(^|[\\/])credentials(\.[^\\/]*)?$/i,
  /(^|[\\/])\.(ssh|aws|gnupg|azure|kube|docker)([\\/]|$)/i,
];

/** 可以读、但不让写的：版本库内部、依赖目录、工具配置、会被自动执行的东西。 */
const noWrite = [
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])node_modules([\\/]|$)/i,
  /(^|[\\/])\.(claude|codex|codebuddy|workbuddy|vscode|idea|husky)([\\/]|$)/i,
  /(^|[\\/])\.github[\\/]workflows([\\/]|$)/i,
  /\.(cmd|bat|ps1|psm1|exe|dll|msi|lnk|vbs|vbe|js[ex]|wsf|scr|reg)$/i,
];

export function isSecretPath(path: string): boolean {
  return secretFiles.some((pattern) => pattern.test(path));
}

export function isNoWritePath(path: string): boolean {
  return noWrite.some((pattern) => pattern.test(path)) || isSecretPath(path);
}

/** 校验并规整读到的配置：认不出的条目丢掉，重名的改名。 */
export function normalizeFileRoots(raw: unknown): FileRootsConfig {
  const roots: FileRoot[] = [];
  const list = (raw as { roots?: unknown })?.roots;
  if (!Array.isArray(list)) return emptyFileRoots();
  for (const item of list.slice(0, fileRootLimits.maxRoots)) {
    const entry = item as Partial<FileRoot>;
    if (typeof entry?.path !== 'string' || entry.path.trim() === '') continue;
    const path = normalizeRootPath(entry.path);
    if (roots.some((root) => comparable(root.path) === comparable(path))) continue;
    const wanted =
      typeof entry.name === 'string' ? entry.name.trim().slice(0, fileRootLimits.maxName) : '';
    const taken = roots.map((root) => root.name);
    const name =
      wanted !== '' &&
      /^[\p{L}\p{N}_-]+$/u.test(wanted) &&
      !taken.some((t) => t.toLowerCase() === wanted.toLowerCase()) &&
      wanted.toLowerCase() !== 'workspace'
        ? wanted
        : rootNameFor(path, taken);
    roots.push({ name, path, writable: entry.writable === true });
  }
  return { version: 1, roots };
}

/** 系统提示里告诉模型有哪些目录、怎么引用。没有授权目录时为空。 */
export function fileRootsPrompt(roots: readonly FileRoot[]): string {
  if (roots.length === 0) return '';
  const lines = roots.map(
    (root) =>
      `- ${root.name}：${root.path}（${root.writable ? '可读写，写之前会问用户' : '只读'}）`,
  );
  return [
    '==== 用户授权的目录 ====',
    'list_files / read_file / write_file / edit_file 的 root 填下面的名字，path 填相对它的路径；也可以直接给落在这些目录里的绝对路径。不填 root 就是芯伴自己的沙盒工作目录。',
    ...lines,
    '- 改已有文件优先用 edit_file 只换掉要改的那一段；整篇重写才用 write_file。要大改代码项目时仍优先 delegate_task。',
  ].join('\n');
}
