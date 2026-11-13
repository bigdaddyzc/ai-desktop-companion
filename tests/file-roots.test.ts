import { describe, expect, it } from 'vitest';
import {
  fileRootProblem,
  fileRootsPrompt,
  isNoWritePath,
  isSameOrAncestor,
  isSecretPath,
  normalizeFileRoots,
  rootNameFor,
} from '../src/core/file-roots';
import { changeDetail, textChange } from '../src/core/text-diff';

const forbidden = {
  home: 'C:\\Users\\me',
  userData: 'C:\\Users\\me\\AppData\\Roaming\\xinban',
  appDir: 'C:\\Program Files\\xinban\\resources\\app.asar',
};

describe('授权目录：哪些能加', () => {
  it('普通项目目录和用户目录下的子文件夹可以加', () => {
    expect(fileRootProblem('D:\\notes', forbidden)).toBe('');
    expect(fileRootProblem('C:\\Users\\me\\Documents\\小说', forbidden)).toBe('');
  });

  it('盘符根、系统目录、用户目录本身及上级、芯伴自己的目录都不行', () => {
    for (const path of [
      'D:\\',
      'D:',
      'C:\\Windows\\System32',
      'c:\\program files\\foo',
      'C:\\Users\\me',
      'c:\\users',
      'C:\\Users\\me\\AppData\\Roaming\\xinban\\file-backups',
      'C:\\Users\\me\\AppData\\Roaming',
      'relative\\dir',
      'D:\\a\\..\\b',
      '',
    ]) {
      expect(fileRootProblem(path, forbidden), path).not.toBe('');
    }
  });

  it('祖先判断不分大小写、不把同前缀兄弟目录当子目录', () => {
    expect(isSameOrAncestor('D:\\Notes', 'd:\\notes\\a.md')).toBe(true);
    expect(isSameOrAncestor('D:\\notes', 'D:\\notes-old\\a.md')).toBe(false);
  });

  it('短名不重复、不占用 workspace', () => {
    expect(rootNameFor('D:\\proj\\notes', [])).toBe('notes');
    expect(rootNameFor('E:\\notes', ['notes'])).toBe('notes-2');
    expect(rootNameFor('D:\\workspace', [])).toBe('workspace-2');
  });

  it('读到坏配置时丢掉认不出的条目，写权限默认关', () => {
    const config = normalizeFileRoots({
      roots: [
        { path: 'D:\\a' },
        { path: 'd:\\A\\' },
        { name: 'x y', path: 'D:\\b', writable: true },
        3,
      ],
    });
    expect(config.roots).toEqual([
      { name: 'a', path: 'D:\\a', writable: false },
      { name: 'b', path: 'D:\\b', writable: true },
    ]);
    expect(normalizeFileRoots(null).roots).toEqual([]);
  });

  it('密钥类不读不写，工具配置与可执行的不写', () => {
    for (const path of [
      'D:\\p\\.env',
      'D:\\p\\.env.local',
      'D:\\p\\id_rsa',
      'D:\\p\\a.pem',
      'D:\\p\\.ssh\\config',
    ]) {
      expect(isSecretPath(path), path).toBe(true);
    }
    expect(isSecretPath('D:\\p\\environment.md')).toBe(false);
    for (const path of [
      'D:\\p\\.git\\config',
      'D:\\p\\.github\\workflows\\ci.yml',
      'D:\\p\\run.ps1',
      'D:\\p\\.claude\\settings.json',
    ]) {
      expect(isNoWritePath(path), path).toBe(true);
    }
    expect(isNoWritePath('D:\\p\\src\\main.ts')).toBe(false);
  });

  it('系统提示列出目录与权限；没有目录时不占位', () => {
    expect(fileRootsPrompt([])).toBe('');
    const prompt = fileRootsPrompt([{ name: 'notes', path: 'D:\\notes', writable: false }]);
    expect(prompt).toContain('notes：D:\\notes（只读）');
    expect(prompt).toContain('edit_file');
  });
});

describe('确认卡上的改动摘要', () => {
  it('只列中间变化的部分，前后各留两行', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const after = ['a', 'b', 'c', 'D!', 'e', 'f', 'g'].join('\r\n');
    const change = textChange(before, after);
    expect(change).toEqual({
      removed: 1,
      added: 1,
      startLine: 4,
      lines: ['  b', '  c', '- d', '+ D!', '  e', '  f'],
    });
    const detail = changeDetail('修改 x.md', change, 2400);
    expect(detail).toContain('第 4 行起：删 1 行、加 1 行');
    expect(detail).toContain('+ D!');
  });

  it('新建文件全是加行；太长时写明还有多少行没显示', () => {
    const after = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');
    const change = textChange('', after);
    expect(change.added).toBe(200);
    const detail = changeDetail('新建 y.md', change, 300);
    expect(detail.length).toBeLessThan(360);
    expect(detail).toMatch(/还有 \d+ 行改动没显示/);
  });
});
