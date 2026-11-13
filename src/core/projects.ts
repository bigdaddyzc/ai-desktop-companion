/**
 * 我的项目：派活时「在哪个目录里干」。
 *
 * 用户 2026-11-10 定：登记一个根目录（默认 D:\claude-workspace），其下每个子文件夹就是一个项目。
 * 模型只拿得到项目名，换不成任意路径：名字只在「扫到的一级子目录」里查，永远出不了根。
 * 纯领域层：只有校验、过滤与匹配，扫目录在 desktop/delegate.ts。
 */

export interface ProjectEntry {
  /** 文件夹名，也是模型传进来的 project。 */
  name: string;
  path: string;
}

export const projectLimits = {
  rootChars: 260,
  /** 提示词与面板最多列这么多个。 */
  maxProjects: 80,
  nameChars: 80,
} as const;

export const defaultProjectsRoot = 'D:\\claude-workspace';

/** 根目录必须是绝对路径，不带控制字符。空串合法（表示不登记）。 */
export function rootProblem(root: string): string {
  if (root === '') return '';
  if (root.length > projectLimits.rootChars) return '路径太长了。';
  if (/[\u0000-\u001f"<>|?*]/.test(root)) return '路径里有不能用的字符。';
  if (!/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(root)) return '要填完整路径，比如 D:\\claude-workspace。';
  return '';
}

/** 归一化：去掉结尾斜杠；不合法就回默认。缺省（老配置）也回默认。 */
export function normalizeRoot(raw: unknown): string {
  if (typeof raw !== 'string') return defaultProjectsRoot;
  const root = raw.trim();
  if (rootProblem(root) !== '') return defaultProjectsRoot;
  return /^[a-zA-Z]:[\\/]$/.test(root) ? root : root.replace(/[\\/]+$/, '');
}

/** 哪些子目录不算项目：隐藏/系统目录、临时目录、依赖目录。 */
export function isProjectDir(name: string): boolean {
  if (name === '' || name.length > projectLimits.nameChars) return false;
  // . 和 $ 开头是隐藏/系统目录，_ 开头按习惯是临时目录。
  if (/^[.$_]/.test(name)) return false;
  return !['node_modules', 'System Volume Information'].includes(name);
}

/**
 * 模型说的项目名 → 登记的项目。
 * 先精确（忽略大小写），再允许去掉空格/连字符/下划线后唯一相等；不做模糊包含——
 * 「goods」匹配到「goods-match」就是在别的项目里动手。
 */
export function findProject(
  projects: readonly ProjectEntry[],
  wanted: string,
): ProjectEntry | undefined {
  const target = wanted.trim().toLowerCase();
  if (target === '') return undefined;
  const exact = projects.find((item) => item.name.toLowerCase() === target);
  if (exact) return exact;
  const loose = (text: string): string => text.toLowerCase().replace(/[\s_-]+/g, '');
  const matches = projects.filter((item) => loose(item.name) === loose(target));
  return matches.length === 1 ? matches[0] : undefined;
}

/** 系统提示词里的一段：登记了哪些项目、怎么指定。 */
export function projectsPrompt(root: string, projects: readonly ProjectEntry[]): string[] {
  if (projects.length === 0) return [];
  const names = projects
    .slice(0, projectLimits.maxProjects)
    .map((item) => item.name)
    .join('、');
  return [
    `- 用户的项目（都在 ${root} 下）：${names}。`,
    '- 派活时用 project 参数填项目名（原样照抄上面的名字），对方就在那个目录里干活；不填就在芯伴自己的工作目录。项目名对不上就问用户是哪一个，不要猜。',
  ];
}
