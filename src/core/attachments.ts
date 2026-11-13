/**
 * 「拖文件给芯伴」：文件先复制进沙盒的 uploads/，再按种类告诉模型怎么用。
 *
 * - 文本类：内容直接拼进这一句（包成不可信数据——文件里写的「忽略上文」不是用户的话）；
 * - 图片：不转 base64 塞给文本模型，告诉它用 look（source=file）去看；
 * - 其它格式（PDF、Office、压缩包…）：芯伴自己读不了，告诉它可以派给 Agent。
 *
 * 对话历史里只留「📎 文件名」那一行，不留内容：下一轮要再看就 read_file，不让历史越滚越大。
 */

export type AttachmentKind = 'text' | 'image' | 'other';

export interface AttachmentInfo {
  id: string;
  /** 原始文件名（只给人看）。 */
  name: string;
  /** 在沙盒里的相对路径，如 uploads/20261110-142233-a.md。 */
  rel: string;
  size: number;
  kind: AttachmentKind;
}

export const attachmentLimits = {
  maxFiles: 6,
  /** 单个文件上限：再大的也不该拖进聊天窗。 */
  maxBytes: 20 * 1024 * 1024,
  /** 每个文本文件拼进消息的上限；超出部分让模型自己 read_file。 */
  inlineChars: 20_000,
  /** 一条消息里所有文本附件合计上限。 */
  totalInlineChars: 48_000,
  /** uploads/ 里的文件留几天。 */
  keepDays: 7,
} as const;

const textExtensions = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'log',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'properties',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'sql',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'java',
  'kt',
  'go',
  'rs',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'sh',
  'vue',
  'svelte',
  'gradle',
  'srt',
  'vtt',
  'rst',
  'tex',
]);

export const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

export function extensionOf(name: string): string {
  const match = /\.([^.\\/]+)$/.exec(name);
  return match ? match[1]!.toLowerCase() : '';
}

export function kindOf(name: string): AttachmentKind {
  const ext = extensionOf(name);
  if (imageExtensions.has(ext)) return 'image';
  if (textExtensions.has(ext)) return 'text';
  return 'other';
}

/** 落盘用的文件名：去掉路径与控制字符、Windows 不认的字符，限长，前面加时间戳避免重名。 */
export function stagedName(name: string, now: number, sequence: number): string {
  const base =
    name
      .split(/[\\/]/)
      .pop()!
      .replace(/[\u0000-\u001f<>:"|?*]+/g, '-')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(-80) || 'file';
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${stamp}-${sequence}-${base}`;
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 写进对话历史、显示在气泡里的那一行。 */
export function attachmentLine(items: readonly AttachmentInfo[]): string {
  if (items.length === 0) return '';
  return `📎 ${items.map((item) => item.rel).join('、')}`;
}

/**
 * 发给模型的附件说明。texts 是文本附件已经读出来的内容（id → 文字），
 * wrap 由调用方传入（就是 wrapUntrusted），这里不依赖 agent 模块。
 */
export function attachmentPrompt(
  items: readonly AttachmentInfo[],
  texts: ReadonlyMap<string, string>,
  wrap: (label: string, text: string, max: number) => string,
): string {
  if (items.length === 0) return '';
  let budget: number = attachmentLimits.totalInlineChars;
  const parts = [
    `【用户随这句话附上了 ${items.length} 个文件，已复制到你的工作目录（root 不填，path 用下面的路径）】`,
  ];
  for (const item of items) {
    const head = `- ${item.rel}（${item.name}，${sizeText(item.size)}）`;
    if (item.kind === 'image') {
      parts.push(`${head}：图片。要看内容就调用 look，source=file，path=${item.rel}。`);
      continue;
    }
    const text = texts.get(item.id);
    if (item.kind === 'text' && text !== undefined) {
      const limit = Math.min(attachmentLimits.inlineChars, budget);
      if (limit < 200) {
        parts.push(`${head}：文本。这条消息的附件太多，这份没展开，用 read_file 读。`);
        continue;
      }
      budget -= Math.min(text.length, limit);
      const more = text.length > limit ? `（只展开了前 ${limit} 字，其余用 read_file 读）` : '';
      parts.push(`${head}：文本${more}。内容：\n${wrap(`附件 ${item.name}`, text, limit)}`);
      continue;
    }
    parts.push(
      `${head}：${item.kind === 'text' ? '看起来不是纯文本' : '这种格式你读不了'}。需要处理它就用 delegate_task，把这个路径放进 files。`,
    );
  }
  return parts.join('\n');
}
