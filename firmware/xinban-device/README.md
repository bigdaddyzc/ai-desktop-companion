# 芯伴 ESP32 固件

目标是电脑宿主驱动的硬件桌面机器人，第一阶段基准为 **ESP32-S3-DevKitC-1 N16R8 + ST7789 240×240 + 两键**。准确配置、接线、可复现命令及验收边界见 [硬件设计基准](../../docs/hardware-baseline.md)。功能验证状态统一记录在 [capabilities](../../docs/capabilities.md)，这里不另列“已完成”清单。

从仓库根目录：

```powershell
npm run firmware:setup
npm run firmware:build
npm run firmware:test
```

构建不是烧录，自动化测试不是实机验收。不要将板型相近的 N8/无 PSRAM 模块当成 N16R8；不要在没有核对电压、背光电流和模块引脚前接线。

## 结构

- `platformio.ini` / `boards/`：固定平台、依赖和板型。
- `include/board_config.h` / `display_setup.h`：按键与屏幕引脚。
- `include/line_buffer.h`：有界 NDJSON 接收器，本机测试与固件共用。
- `include/device_ui.h`：显示布局、UTF-8 换行、确认展示，本机测试与固件共用。
- `src/main.cpp`：屏幕/字体适配、串口、按钮、Wi-Fi、NVS、IoT FreeRTOS 任务。
- `test/native/main.cpp`：运行共享 JSON 契约样例，不访问真实硬件。

文字字库随固定版本 U8g2_for_TFT_eSPI 依赖取得，不手工复制字体文件；相关许可见该依赖的 LICENSE 和字库来源说明（文泉驿）。屏幕字体与效果仍需实屏验证。

Wi-Fi 首次配网使用本机热点 `Xinban-Setup`，物联网支持无认证的 Tasmota / Shelly 第二代 / ESPHome 局域网 HTTP 接口。电脑不在线时是本地物联网列表，不是离线 AI。不要把没有对真实设备验证的 HTTP 实现称为已完成物理开关验收。
