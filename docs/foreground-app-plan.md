# 前台应用感知（施工说明）

目标：让芯伴知道「他现在前台是哪个应用」，不用猜人在哪儿干活。
只取**进程名**（`Code`、`chrome`、`WindowsTerminal`），**绝不取窗口标题**——标题里有文件名、路径、聊天对象。

## 一、数据结构（src/core/senses.ts）

1. `SensesConfig` 加开关，默认关：

   ```ts
   /** 前台应用：只记进程名，不记窗口标题。 */
   focus: boolean;
   ```

   `defaultSenses` 补 `focus: false`；`normalizeSenses` 的 flag 列表补上。

2. `SensesReading` 加两个字段：

   ```ts
   /** 前台应用进程名；空串表示没读到或没开。 */
   foreground: string;
   /** 最近一次读到前台应用的时间；0 表示从未读到。 */
   foregroundAt: number;
   ```

   `emptyReading()` 补 `foreground: ''`、`foregroundAt: 0`。

3. `senseTuning` 加：

   ```ts
   /** 前台应用轮询间隔。窗口不会一秒换十个，30 秒足够。 */
   focusPollMs: 30_000,
   ```

4. 新增纯函数（便于单测）：

   ```ts
   export function dueForFocusPoll(lastAt: number, now: number): boolean {
     return lastAt <= 0 || now - lastAt >= senseTuning.focusPollMs;
   }
   ```

5. `sensesPrompt()`：`config.focus && reading.foreground !== ''` 时追加一行 `现在前台是 Code。`。开关关着就一个字都不提。

6. `sensesText()`：`config.focus` 时加一行 `前台应用：Code（只记进程名，不记窗口标题）`；没读到写「还没读到」。

## 二、采集（src/desktop/senses.ts）

放在主进程，不要塞进渲染进程——渲染进程拿不到别的应用的窗口，采集失败也不该影响小屏。

1. 新增私有方法 `refreshForeground(now)`：
   - `config.focus` 为假直接 return；
   - `child_process.execFile` 跑一次 PowerShell，`timeout: 3000`；
   - 输出 `trim()` 后只保留 `[A-Za-z0-9._-]`，截断 40 字符；
   - 成功：更新 `foreground` / `foregroundAt` 并 `publish()`；
   - 失败：**保留上一次的值**，不写 `reading.error`（那是耳朵和眼睛的），只走 debug 日志。
2. 轮询：`init()` 完成后 `setInterval(...).unref()`，间隔取 `senseTuning.focusPollMs`；回调先看 `dueForFocusPoll` 再跑。
3. `save()` 里：`focus` 关掉时清空 `foreground`（和现在关掉麦克风清音量的做法一致），打开时立刻 `refreshForeground()` 拉一次。
4. `report()` 不收前台应用——它不来自渲染进程，别让它被 `normalizeReading` 覆盖掉。

命令（无依赖，Windows PowerShell 5.1 可直接跑）：

```powershell
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class W{
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
}"@
$h=[W]::GetForegroundWindow();$p=0
[void][W]::GetWindowThreadProcessId($h,[ref]$p)
(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
```

`execFile` 用 `powershell.exe` 加 `['-NoProfile','-NonInteractive','-Command', script]`。注意这段多行脚本要整体作为一个参数传，不要拆行拼接。

## 三、外壳与面板

- `src/desktop/preload.ts` / `src/core/schema.ts`：如果快照是显式映射的，把 `focus` 和两个新字段补进去，别漏。
- 面板「它的眼睛」下面加一行开关「前台应用」，文案要写清边界：_只记应用名，不记窗口标题，30 秒一次_。
- `src/desktop/tools.ts` 里 `senses` 工具的描述文字补一句「前台应用」。

## 四、验收

- 关着 `focus`：提示词和工具输出里完全没有前台相关字样。
- 打开后 30 秒内 `senses` 能报出进程名；切到另一个应用，下一次轮询就变。
- 拔掉 PowerShell / 沙箱里跑不起来时，芯伴照常说「读不到」，不编应用名。
- `npm run test` 覆盖 `dueForFocusPoll` 和 `sensesPrompt` 的新分支。
