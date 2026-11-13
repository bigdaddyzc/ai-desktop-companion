# 芯伴项目全面评估与测试记录

- 评估日期：2026-11-11（Asia/Shanghai）。
- 基线：Git `ea55baf`，应用版本 `0.3.0`，Windows，Node.js `24.14.1`，npm `11.11.0`。
- 目标（按用户澄清修订）：评估以 ESP32 硬件桌面机器人为终点、先进行桌面模拟的项目；检查宿主工程、模拟链路、安全边界及实机集成准备度。不是修改功能或发布版本。
- 评估开始时工作区干净；没有改动产品源码、依赖、真实用户配置或真实项目数据。

## 1. 结论（按 ESP32 硬件终目标修订）

**这是一个已有较完整电脑宿主端和协议模拟链路、处于实机集成前阶段的 ESP32 桌面机器人项目。** 桌面模拟是有价值的开发阶段，不是一次性演示，更不是做错方向。

上一版把“桌面个人 Agent”当成最终产品，将整个项目概括成“个人内测原型”，判断尺度过宽，现予更正。“项目”与“原型阶段”不是互斥概念；应按子系统描述成熟度，而不是用一个标签概括全部。“参考固件尚未构建验证”与“整个工程只是概念”完全不同。

当前主要资产是电脑宿主的业务、AI、状态管理、安全确认，以及 USB 协议、手势语义与模拟设备。它们符合“电脑处理智能、ESP32 提供实体表现和交互”的架构，不能按“把 Electron 整体搬进 ESP32”来评估。

主要差距是**把宿主能力兑现到真实小屏和按钮的工程闭环尚未完成**：固件构建配置、中文与完整显示、严格协议边界、以及后续实机联调。尚未购买硬件解释了实机测试的空白，但固件可复现编译、显示契约和边界测试现在就可以推进。详见第 10 节。

原有可靠性实测仍有效：文件确认竞态、改动日志失败被吞、撤销冲突及 MCP CRLF 问题不因载体变成机器人而消失。**在修复高优先级文件问题前，不建议向它开放重要目录写权限后长期无人看管。** 没有安装包、签名或复杂商业 UI，不是当前阻止硬件项目推进的主要问题。

## 2. 测试范围与结果

| 检查              | 本次结果                                | 解释                                                |
| ----------------- | --------------------------------------- | --------------------------------------------------- |
| Prettier          | 通过                                    | 使用项目现有格式规则                                |
| ESLint            | 通过                                    | 零警告要求；包含分层依赖限制                        |
| TypeScript        | 通过                                    | strict / noUncheckedIndexedAccess 等配置开启        |
| Vitest 常规套件   | 64 个文件、1,214 条全部通过             | 领域、存储、服务、协议、工具和已登记回归            |
| 生产构建          | 通过                                    | Vite 前端与 esbuild 主进程/preload 构建成功         |
| Electron E2E      | 23 通过、3 跳过，约 2.1 分钟            | 包括开发入口/HMR；跳过的是需要专用 Key 的真实云调用 |
| npm audit         | 0 个已报告漏洞                          | 当前 registry 的已知漏洞结果，不代表没有逻辑漏洞    |
| npm ls --depth=0  | 通过                                    | 顶层依赖齐全，没有报告 invalid/missing              |
| 补充边界探针      | 10 条中 3 通过、7 未满足安全/兼容性预期 | 7 条失败并非 7 个完全独立根因；见下文               |
| 实际 IPC 并发写入 | 100 次新增 + 100 次切换通过             | 并发提交，无丢失；跨窗口与重启后保持一致            |
| 非法动作输入      | 4 类均被拒绝                            | 超长、空文本、未知类型、额外字段                    |
| 窗口权限隔离      | 3 个敏感接口均拒绝桌宠窗口调用          | 添加授权目录、保存 MCP、清除 AI 凭据                |
| 页面运行错误      | 最终运行探针未捕获 pageerror            | 不等于覆盖所有运行路径                              |
| 短时资源采样      | 完成约 30 秒空闲采样                    | 不能替代 24 小时稳定性、泄漏或续航测试              |

### 测试隔离

- E2E 和运行探针使用独立 userData、会话目录和钩子配置目录。
- 不读取真实 Agent 会话，不修改真实工具配置；禁用系统媒体控制。
- 摄像头/麦克风测试使用 Electron 假设备，而非采集真实音视频。
- 文件攻击面测试的授权目录、未授权目录和 junction 都位于同一个测试 fixture 内，结束后清理。
- MCP 兼容性测试只连接本机回环地址的临时假服务器。
- 没有自动读取现有应用密钥来调用云评测；没有修改或执行真实项目任务。

## 3. 主要发现（按优先级）

### A. P1：等待确认之后没有重新检查文件目标与权限

位置：[tools.ts:1046–1087](D:/deepseek-workspace/ai-desktop-companion/src/desktop/tools.ts#L1046)。

`writeTextFile` / `editTextFile` 在确认之前解析目录权限、真实路径并读取原文；`commitWrite` 等待用户允许后直接备份、写入，没有重新核验。

本次重复复现：

1. 确认期间把目录改成只读，返回允许后仍写入成功。
2. 确认期间将目标父目录替换成指向未授权目录的 Windows junction，写入落到了未授权目标。
3. 确认期间由另一编辑者更新文件，原先展示的 diff 已过时，继续确认仍覆盖了新内容。
4. 备份阶段取消请求，备份结束后仍继续写入文件。

对照测试：正常拒绝确认不写文件；普通 `../` 路径逃逸被拒绝。因此不是“所有权限都失效”，而是**检查与真正使用目标之间的时间窗口缺少约束**。junction 场景需要本地目录在此期间发生变更，不能据此声称模型可凭普通路径直接逃逸。

建议：

- 最终写入前重新查询授权目录、可写权限、规范化真实路径和取消状态。
- 给确认内容绑定文件内容哈希及目标身份；内容或目标变化时废弃旧确认，重新展示 diff。
- 将文件提交封装为单一服务，使用按目标串行化、临时文件原子替换和适合 Windows 的链接/文件身份校验。仅再加一次 realpath 并不能彻底消除恶意并发置换竞态。
- 对已进入不可中断提交阶段的操作，UI 应明确“正在完成提交”，不要承诺已取消。

### B. P1：改动日志保存失败仍报告文件写入成功

位置：[files.ts:230–236](D:/deepseek-workspace/ai-desktop-companion/src/desktop/files.ts#L230)，调用方 [tools.ts:1073](D:/deepseek-workspace/ai-desktop-companion/src/desktop/tools.ts#L1073)。

`saveChanges()` 返回 `run.catch(() => undefined)`，把持久化错误转换成正常完成；上层“备份失败不写”的异常处理捕获不到日志保存失败。

故障注入：将改动记录目标设置成不可作为文件写入的目录。实际观察：工具返回 `ok`，目标文件已变成 `assistant update`，服务重新加载后改动记录为 0。界面承诺可撤销，但重启后没有对应索引。该测试使用新建文件，避免把“备份拷贝失败”与“记录落盘失败”混为一谈。

建议：让持久化错误向调用者传播；成功落盘后再发布内存快照。把“准备备份/日志—提交文件—完成记录”设计成可恢复事务，明确启动恢复策略，并覆盖磁盘满、权限错误、rename 失败、写到一半进程退出。

### C. P2：撤销不识别后续编辑冲突

位置：[files.ts:178–207](D:/deepseek-workspace/ai-desktop-companion/src/desktop/files.ts#L178)，UI [FilesCard.tsx:127](D:/deepseek-workspace/ai-desktop-companion/src/renderer/FilesCard.tsx#L127)。

复现：AI 修改文件 → 用户手工再次编辑 → 点击旧改动的撤销，文件被直接恢复为更早版本。当前实现会先备份撤销前内容，所以这里不是“必然永久丢失”，但仍会在无冲突提示的情况下替换用户的新工作。

这是恢复行为的产品安全缺口：记录提交后的哈希，撤销前比较当前内容；发生冲突时展示差异，并提供另存旧版本或用户明确允许的强制恢复。撤销也应再次验证路径边界。

### D. P2：MCP SSE 对 CRLF 长连接不能及时解析

位置：[mcp-client.ts:366](D:/deepseek-workspace/ai-desktop-companion/src/desktop/mcp-client.ts#L366)。

流式读取只通过 `text.lastIndexOf('\n\n')` 判断完整事件边界；下层 `sseMessages` 虽然支持 CRLF，但只有上层决定交付后才运行。

本机 HTTP 复现：相同 JSON-RPC 响应，LF 换行立即成功；换成合法 CRLF、保持 SSE 连接打开，客户端一直等到 750ms 测试超时。若服务端关闭连接，尾部解析可能掩盖此问题；线上长连接则表现为已收到结果却卡住。

建议：使用支持 SSE 标准行结束符的增量解析器，补上 CRLF、跨 chunk 的 CR/LF、多个事件、心跳与长连接测试。

### E. P2：入口安全说明已经落后于实际能力

位置：[AiPanel.tsx:510–520](D:/deepseek-workspace/ai-desktop-companion/src/renderer/AiPanel.tsx#L510)。

页面仍写着“只有主动输入的文字会发送”“屏幕……不会随请求上传”“命令不经过 shell、只允许 node/git/python”。实际已有附件、视觉上传、授权目录、系统 shell 与外部 Agent。截图与代码均确认这些文案仍然展示。

这些能力有各自的授权与确认，不等于静默上传；问题是入口作出了过于绝对、已经不准确的承诺。应统一说明：默认不采集；明确开启并触发后哪些数据发给哪个服务；目录授权约束哪些内置文件工具；命令/外部 Agent 的操作系统权限不是仅凭 cwd 就被沙盒化。

另有低优先级版本展示偏差：[App.tsx:828](D:/deepseek-workspace/ai-desktop-companion/src/renderer/App.tsx#L828) 写死 `0.2.0`，包版本为 `0.3.0`。

## 4. 产品与交互判断

### 做得好的地方

- 视觉风格一致，桌宠与面板共享状态，表情和短回复符合低打扰陪伴的目标。
- 本地优先、默认关闭敏感输入、逐次确认、记忆可查看删除的方向正确。
- 待办/计时/任务反馈使它不只是聊天皮肤；主进程统一管理使小屏、面板和设备有同一事实来源。
- 将“已实测”和“自动化验证”分开记录，比笼统宣称完成更可信。

### 宿主控制台的次要体验问题：聊天与设置混排

按硬件终目标，本节降为控制台易用性改进，不再作为项目核心定位或成熟度的主要判断。配对、连接恢复、小屏反馈和实体确认比聊天页重排更优先。硬件入口本身应保留并突出，而非当作装饰或实验分支移走。

本次生产页面测量：窗口内容高度 793px，“问问伙伴”页面约 6,192px，**真正的消息输入框顶部在约 5,506px**。这是当前配置与窗口大小下的测量，不是所有机器的固定值。

用户进入“问问伙伴”首先看到大面积硬件概念图、能力说明、模型、人格、语音、视觉、派活、授权目录、MCP 等设置；需要滚动多屏才到对话。桌宠有更直接的对话入口，但不能弥补控制面板页面命名与布局的冲突。

建议：

1. 把对话与输入框放到首屏，输入区固定在底部；第一次缺模型时给简短配置引导。
2. 把模型、语音、视觉、权限、MCP 收入独立的“能力与连接”设置页，默认折叠高级选项。
3. 将硬件概念图、连接状态与配对操作组织在清晰的设备入口，区分设备管理和日常对话，勿把实体设备降为边缘功能。
4. 让正在执行的任务、待确认动作和失败恢复路径优先于装饰与长说明。
5. 补键盘导航、可见焦点、缩放、对比度和屏幕阅读器验收。本次进行了截图检查，没有完成 WCAG 定量审计。

## 5. 工程与架构

### 基础较好

- 110 个源码文件，约 31,534 个非空源码行；core / desktop / renderer 分层，并由 ESLint 约束跨层依赖。
- TypeScript 严格模式、Zod IPC 输入校验、Electron sandbox/contextIsolation、禁止远程导航与窗口弹出。
- 状态服务有串行提交机制；本次并发与重启探针确认待办链路工作正常。
- 多个关键模块有注入式依赖与安全回归；没有把全部约束寄托于提示词。

### 开始影响后续速度的地方

- [main.ts](D:/deepseek-workspace/ai-desktop-companion/src/desktop/main.ts) 约 1,782 行，组合根、IPC、安全策略、生命周期与跨功能编排集中。
- [AiPanel.tsx](D:/deepseek-workspace/ai-desktop-companion/src/renderer/AiPanel.tsx) 约 1,514 行，[CompanionPanel.tsx](D:/deepseek-workspace/ai-desktop-companion/src/renderer/CompanionPanel.tsx) 约 1,164 行。
- [tools.ts](D:/deepseek-workspace/ai-desktop-companion/src/desktop/tools.ts) 约 1,301 行，工具路由、文件事务、命令执行等责任较多。
- 不是所有持久化模块都遵守同一成功发布/失败回滚约定；files 模块与较稳健的 StateService/atomic 工具形成明显差异。

推荐渐进拆分，不做全面重写：首先提取文件事务服务，再拆 IPC 注册与窗口生命周期；页面按实际用户任务分区。保留当前清晰的领域层。

### 测试与交付补齐

- 当前没有配置可执行的覆盖率门禁，不能从 1,214 条测试推算覆盖率百分比。
- 应补“等待确认过程中变化”“撤销遇到新编辑”“记录写失败”“流式协议变体”这类性质测试和故障注入，而不是只增加 happy-path 数量。
- 仓库未见 CI 工作流；建议把 check、build、Windows Electron E2E 设为合并门禁。
- build 不是固件构建，也不是安装包。现阶段先补固件可复现构建和当前宿主的真实串口验证；干净机器安装、签名、升级回滚、打包后原生模块验证属于后续分发里程碑，不宜压过硬件主线。

## 6. 性能与稳定性实测

本机生产构建、全新隔离 userData、桌宠可见/控制面板隐藏、无云连接和实体设备：

- 首次窗口可用约 1.03s；同轮重启约 0.96s。启动计时含测试启动器，系统缓存未清理，不能当作严格冷启动或 P95。
- 100 个并发新增请求全部完成约 1.26s；100 次状态切换完成后重启，仍有 100 条已完成待办。
- 30 秒、每 5 秒一次采样，Electron 各进程 privateBytes 合计约 317–339 MiB。
- working set 合计约 553–568 MiB；共享页可能重复计入，**不是独占物理内存**。
- 首个采样后，各进程上报 CPU 百分比合计约 0.41–0.62；这是 Electron 采样口径，不是任务管理器严格等价数值。
- 前端产物约 490.19 kB JS（gzip 154.26 kB），CSS 32.21 kB。

**以上全是电脑宿主端资源，不是 ESP32 的 RAM、Flash 或功耗。** 短时交互与并发状态链路表现良好；对长期驻留的宿主而言，内存仍有优化价值。优先考虑控制面板按需创建/加载、减少隐藏窗口渲染及按需加载能力配置。没有证据据此宣称内存泄漏，也不能用半分钟证明 24 小时稳定。

## 7. 没有完成、不能冒充完成的验证

- 本轮 3 条真实 DeepSeek E2E 因未设置专用 `XINBAN_AI_TEST_KEY` 跳过。
- 没有执行收费的真实模型评测。工作区已有 2026-11-10 的历史评测报告，记录 99/100；它不是本次成绩，且该评测不实际执行工具，不能当作安全验收。
- 真实中文 STT 准确率、云 TTS 听感/首字延迟、屏幕视觉准确率、摄像头真实采集、音乐客户端联动没有重验。
- 没有派真实 Agent 修改真实项目，没有验证第三方 CLI 版本差异、认证状态与外部服务可用性。
- 实体 ESP32、USB 串口、IoT 开关、安全断电没有实测；参考固件没有在本轮编译烧录，引脚/字库等本就标为占位。
- 没有做 24 小时常驻、系统休眠/恢复、多显示器热插拔、不同 DPI、不同 Windows 用户、干净机器安装测试。
- 没有做真实断电或杀进程恢复实验、完整渗透测试、完整无障碍审计或 macOS/Linux 验收。

## 8. 建议的下一步顺序（修订）

### 第一优先级：定义并完成最小硬件闭环

以当前文档的“USB 供电的 ESP32-S3 + 240×240 屏 + 两键”为首版基准，先定板卡模块、屏幕接口和引脚；添加可复现的固件工程、固定工具链与依赖、屏幕配置、字库和构建命令。这里不要求现在采购，也不要求增加电池、舵机或脱离电脑的本地 AI。

先让“主机业务事件 → DeviceView → 固件中文/表情/短回复 → A/B 上报 → 主机状态改变”完整一致。补正常、确认、超时、勿扰、计时、工作状态、AI 短回复、断连等共享样例。模拟器应施加与固件相同的帧长、分包和延迟限制，而不只是完整 JSON 即刻回包。无需为共用渲染而全面重写现有宿主。

### 同期必修：有实际副作用的可靠性

第 3 节 A、B 的文件事务问题与本次发现的协议边界问题要在对应能力验收前修复；不能让硬件按键确认一个已变化的目标。文件能力若暂时关闭，不必因此阻塞先做显示与按键闭环。随后处理撤销冲突、MCP 兼容性和过时说明。

### 第二优先级：买板后的真实验收

验证烧录、USB 枚举/复位、首帧、中文与裁切、两键去抖/长按、拔插与主机重启、状态重送、确认过期及断网回退；接着做供电稳定、屏幕刷新和长时间资源记录。若保留 IoT，在真实设备上验证回执、失败状态与独立模式，不能用模拟开关成功替代物理开关验收。

### 第三优先级：体验打磨与分发

在机器人主线闭环之后，再优化控制台布局、宿主资源、安装包及升级。真实语音、视觉等按首版范围逐项验收；实体音频需另设里程碑，桌面录音/TTS 测试不代表 ESP32 音频链路已经具备。

**个人判断：核心架构可沿用，无需推倒重来。接下来最有价值的投入，是减少宿主能力与设备端兑现之间的差距，而非继续横向扩展 Agent 工具和设置项。**

## 9. 本地证据与复现

以下均为本次工作区内的证据。`test-results` 被 Git 忽略，补充失败探针未加入默认测试套件，避免把评估脚本混入产品基线。

- [工程检查日志](D:/deepseek-workspace/ai-desktop-companion/test-results/audit-check-20261111.log)
- [构建日志](D:/deepseek-workspace/ai-desktop-companion/test-results/audit-build-20261111.log)
- [依赖审计 JSON](D:/deepseek-workspace/ai-desktop-companion/test-results/audit-dependencies-20261111.json)
- [Electron E2E 日志](D:/deepseek-workspace/ai-desktop-companion/test-results/audit-e2e-20261111.log)
- [补充探针源文件](D:/deepseek-workspace/ai-desktop-companion/test-results/audit-probes.test.ts)
- [补充探针结果](D:/deepseek-workspace/ai-desktop-companion/test-results/audit-probes-20261111.log)
- [实际运行/并发/资源探针](D:/deepseek-workspace/ai-desktop-companion/test-results/audit-runtime.mjs)
- [运行结果 JSON](D:/deepseek-workspace/ai-desktop-companion/test-results/audit-runtime-20261111.json)
- [问问伙伴首屏截图](D:/deepseek-workspace/ai-desktop-companion/test-results/audit-ai-panel-viewport.png)

在项目根目录运行（补充探针当前预期非零退出，代表已记录问题尚未修复）：

```powershell
npx vitest run --config D:/deepseek-workspace/ai-desktop-companion/test-results/audit-vitest.config.ts
node D:/deepseek-workspace/ai-desktop-companion/test-results/audit-runtime.mjs
```

## 10. 按硬件终目标的补充评估

### 10.1 判断基准与分层成熟度

用户明确：尚未采购 ESP32，因此先做桌面模拟，最终是硬件桌面机器人。[PRD](D:/deepseek-workspace/ai-desktop-companion/docs/PRD-v1.0.md) 第 0.2、0.3、1.1–1.3 节也规定先软件后实体、不做芯片指令仿真、桌面版并非一次性演示。历史 ADR 标题和包描述中的 prototype 不能单独决定今天整个项目的成熟度。

| 层次             | 当前证据                                                                   | 评价                                                             |
| ---------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 智能与业务宿主   | 状态、待办/计时、工作事件、AI 工具、记忆、确认、持久化、实际 Electron 测试 | 已有实际软件实现，值得保留；部分安全异常路径待修                 |
| 主机设备连接     | SerialConnector、握手、心跳、断连重试、画面去重、模拟 A/B                  | 是真实接入准备，不是只有界面；目前仍以模拟测试为证               |
| 业务和输入一致性 | core 层的 displayState、gesture/input 状态机；DeviceView 定义与主机下发    | 分层方向正确；共享规则不等于两端共享渲染或已经显示一致           |
| 桌面设备模拟     | TypeScript 模拟握手、上行按键、IoT 回包，面板显示主机快照                  | 行为/协议测试替身，不执行 C++ 固件，不验证电气、字体或芯片资源   |
| 固件             | 现有 C++ 参考实现包含屏幕、按钮、USB 帧、Wi-Fi/IoT 任务与 NVS              | 并非“固件完全没写”；但缺可复现构建工程与完整屏幕表现，本次未编译 |
| 实体系统         | 未采购硬件，无实体烧录/串口/屏幕/按键/供电记录                             | 尚未实机集成验收，符合当前阶段，不应虚报完成                     |

电脑/云负责智能、ESP32 做实体交互端是一种合理的机器人架构，并不要求 ESP32 本地跑大模型。当前参考固件离开电脑时实现的是 IoT 控制模式，不是独立 AI 伙伴。是否以后需要独立语音或离线能力应另定需求，不能倒推成首版必须补齐的欠账。

### 10.2 不买硬件也能解决的具体差距

#### H1. 缺少可复现的固件构建入口

检查 `firmware/` 当前只有 [README](D:/deepseek-workspace/ai-desktop-companion/firmware/xinban-device/README.md) 和 [main.cpp](D:/deepseek-workspace/ai-desktop-companion/firmware/xinban-device/src/main.cpp)。没有随仓库保存的 PlatformIO 工程、ESP-IDF 工程或等效完整构建配置。README 列出库的大版本及人工修改 TFT_eSPI 设置的步骤，但还不能从干净环境用一条确定命令复现同一固件。

main.cpp:18–21 明示按键引脚占位，蜂鸣器禁用；屏幕驱动、中文资源也未固化。当前 PATH 未发现 `pio` / `platformio` / `arduino-cli`，本轮未安装工具链，因此**没有得到编译成功或编译失败结论**。缺实体板不妨碍先进行交叉编译、链接与 Flash/RAM 静态占用检查；板上运行另验。

#### H2. “同一份业务内容”尚未转成“同样能在实体屏上看见”

[DeviceView](D:/deepseek-workspace/ai-desktop-companion/src/core/device-view.ts) 包含 `face`、`bubble`、`work`、计时和确认卡等。主机 [main.ts:1702](D:/deepseek-workspace/ai-desktop-companion/src/desktop/main.ts#L1702) 确实构造并下发 AI 短回复与工作文本。

但固件 [render():289–324](D:/deepseek-workspace/ai-desktop-companion/firmware/xinban-device/src/main.cpp#L289) 只按 mood 画简笔脸，再画标题、详情、卡片、计时或待办；**没有读取和绘制 `bubble`、`work`、`face` 的细粒度表情，也没有显示确认卡倒计时**。这些是源码层面可确认的未实现，并非等待买板才能判断的显示效果问题。

例：主机下发一句 AI 回复，模拟设备能收到，面板 [CompanionPanel.tsx:1145](D:/deepseek-workspace/ai-desktop-companion/src/renderer/CompanionPanel.tsx#L1145) 会显示 `view.bubble`；这不能证明当前 C++ 固件会把这句话画出来。固件未接中文字体，仍直接调用 TFT_eSPI 数字内置字体，尚未建立可用的中文排版与溢出处理。

桌面 [Device.tsx](D:/deepseek-workspace/ai-desktop-companion/src/renderer/Device.tsx) 也是独立 React 渲染，复用部分 core 规则，不执行这份 C++。建议先做共享输入/预期屏幕样例与等价性验收，不把“完全共用渲染引擎”当成强制重构前提。

#### H3. 模拟链路没有严格复现协议的异常约束

[SimulatedDevice.receive](D:/deepseek-workspace/ai-desktop-companion/src/desktop/device.ts#L243) 对完整字符串做 JSON.parse、异步回包；没有执行 C++ 接收器、显示器或真实串口缓冲。这种模拟很适合测业务，但不能独自证明硬件兼容。

本轮重跑 3 个相关现有测试文件：**59/59 通过**。随后增加 4 条隔离的协议边界探针：**2 通过、2 失败**，不是烧录测试：

1. [parseDeviceFrame:157–161](D:/deepseek-workspace/ai-desktop-companion/src/core/device-protocol.ts#L157) 按 JS 字符串长度而非 UTF-8 字节数限制帧。含合法 pong 与扩展字段的 3,029 字节帧，长度仅 1,029 个 code unit，被接纳，违反文档 2,048 字节上限。正常扩展字段应允许，但仍应受总字节上限约束。
2. [LineBuffer:232–246](D:/deepseek-workspace/ai-desktop-companion/src/core/device-protocol.ts#L232) 在未见换行的超长数据到达时清空缓冲，却没有保持“丢弃到下一个换行”的状态。分两段输入同一条坏长行，其尾部若刚好是合法 `btn` JSON，会被当作新按键帧。测试只证实解析结果，未声称执行了真实危险动作。固件 [loop:427–438](D:/deepseek-workspace/ai-desktop-companion/firmware/xinban-device/src/main.cpp#L427) 有相似的溢出后清空方式，这是静态风险，尚未运行验证。

正常 CRLF、普通分包、坏长行结束后的下一条合法帧两个对照测试通过。建议按字节限制、保持明确的丢弃状态，并让模拟器注入分包、慢接收、坏帧、重启、心跳丢失与重连。固件循环中的同类边界要一起纳入契约测试。

#### H4. 目标与能力状态文档需要对齐

[CLAUDE.md](D:/deepseek-workspace/ai-desktop-companion/CLAUDE.md) 写“桌面个人 agent”，而用户当前终目标和 PRD 是实体机器人；[capabilities.md:89](D:/deepseek-workspace/ai-desktop-companion/docs/capabilities.md#L89) 仍写“固件未写”，实际已有参考代码。建议后续统一为“已有参考固件、未完成可复现编译和实机验收”，并明确宿主/固件/实体各层状态。此处只记录差异，没有擅自改动项目定位约定或功能状态表。

### 10.3 买到硬件后才能完成的验证

- USB 供电与数据口、CDC 枚举、DTR/RTS 对复位的影响、烧录与启动时间。
- 真实 240×240 屏幕的中文、裁切、对比度、刷新与闪烁；确认内容看不全时转桌面查看，不允许盲确认。
- A/B 机械抖动、长按、同时按、按住时拔插、设备重启与主机睡眠恢复。
- 断线安全回退、重连状态重送、过期确认不得误用；IoT 命令失败不可显示成功。
- 实际 heap/栈、刷新耗时、串口积压、Wi-Fi/屏幕/按键并发与长时间稳定性。不能用 Electron 内存占用替代这些指标。
- 若进入实体音频阶段，再验麦克风/扬声器、I2S、采样传输、回声与音频供电；当前不将这些列作文字版首版的阻塞项。

**建议的首个验收目标：电脑发来待办/工作事件或 AI 短回复，实体屏清晰显示；按 A/B 产生预期反馈；拔插后恢复正确状态且不误执行旧确认。** 达到这条端到端链路，才有证据称“实体机器人基础闭环已完成”，无需先补完整商业分发能力。

### 10.4 本轮补充证据

- [硬件相关现有测试：59 通过](D:/deepseek-workspace/ai-desktop-companion/test-results/audit-hardware-existing-20261111.log)
- [新增协议探针源码](D:/deepseek-workspace/ai-desktop-companion/test-results/audit-hardware-probes.test.ts)
- [新增协议探针结果：2 通过 / 2 失败](D:/deepseek-workspace/ai-desktop-companion/test-results/audit-hardware-probes-20261111.log)

复现（第二条当前预期非零退出；未修产品源码）：

```powershell
npx vitest run tests/device-service.test.ts tests/companion-core.test.ts tests/iot.test.ts
npx vitest run --config test-results/audit-hardware-vitest.config.ts
```
