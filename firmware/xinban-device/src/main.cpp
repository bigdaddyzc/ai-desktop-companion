// 芯伴实体设备固件，协议 v1（含 iot 扩展帧）。
// 固定构建/引脚基准见 platformio.ini 与 include/；实机接线、烧录与运行仍待验。
//
// 两种工作状态：
// - 接着电脑（收得到 ping）：屏幕画主机给的 view，按键只报原始边沿，判断全在主机。
// - 独立运行（电脑关了/没插）：屏幕画物联网设备列表，A 短按选下一台、B 短按开/关。
// 物联网轮询跑在另一个 FreeRTOS 任务里，HTTP 请求再慢也不卡串口和按键。

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <TFT_eSPI.h>
#include <U8g2_for_TFT_eSPI.h>
#include "board_config.h"
#include "line_buffer.h"
#include "device_ui.h"
#include "status_light.h"
#include "touch_bar.h"
#include <WiFi.h>
#include <WiFiManager.h> // tzapu/WiFiManager：首次用手机连热点配网，密码不经过电脑

// 引脚按构建环境取自 board_config.h；见 docs/hardware-baseline.md。
static const int PIN_BTN_A = xinban::buttonA;
static const int PIN_BTN_B = xinban::buttonB;
static const int PIN_BOOT = xinban::bootButton;
static const int PIN_RGB = xinban::rgbLed;
static const int PIN_TOUCH_IRQ = xinban::touchIrq;
static const int SCREEN_H = xinban::screenH;
static const int PIN_BUZZER = xinban::buzzer;
static const char *FW_VERSION = "0.4.0";
static const int PROTO = xinban::protocolVersion;
static const char *PORTAL_NAME = "Xinban-Setup";
static const int MAX_IOT = 8;
static const uint32_t POLL_MS = 3000;
static const uint32_t HOST_STALE_MS = xinban::hostStaleMs;

TFT_eSPI tft;
U8g2_for_TFT_eSPI uiFont;
// 两个口都听：原生 USB（Serial）和板载转串口芯片接的 UART0（Serial0）。
// 谁发来有效 hello 就跟谁说话，另一个口只听 hello。
xinban::LineBuffer usbLines, uartLines;
Stream *host = &Serial;
bool handshaken = false;
bool lastA = false, lastB = false;
char touchKey = 0; // 当前按着的触摸键 'A' / 'B' / 0
std::string barA = "A", barB = "B";
JsonDocument view; // 最后一帧画面
uint32_t lastHostAt = 0;
Preferences prefs;
WiFiManager wifi;

// ---------------- 物联网状态（两个任务共享，用互斥锁保护） ----------------
struct IotDevice {
  char id[17];
  char name[65]; // UTF-8，16 个 Unicode code points（最多 4 字节）
  char kind[8];  // tasmota | shelly | esphome
  char host[64];
  char ch[33];
  bool online;
  int8_t on; // -1 不知道
  float watts; // <0 表示没有计量
  bool dirty; // 状态变了，等主循环报给主机
  uint32_t reportedAt;
};
IotDevice devices[MAX_IOT];
int deviceCount = 0;
int selected = 0;
SemaphoreHandle_t iotLock;
QueueHandle_t commands; // {index, on}
struct Command {
  int index;
  bool on;
};

static void send(JsonDocument &doc) {
  serializeJson(doc, *host);
  host->print('\n');
}

static void sendHello() {
  JsonDocument doc;
  doc["t"] = "hello";
  doc["proto"] = PROTO;
  doc["fw"] = FW_VERSION;
  doc["board"] = xinban::boardName;
  doc["screen"]["w"] = xinban::screenW;
  doc["screen"]["h"] = SCREEN_H;
  doc["buttons"].add("A");
  doc["buttons"].add("B");
  doc["caps"].add("iot");
  if (PIN_BUZZER >= 0) doc["caps"].add("buzzer");
  if (PIN_RGB >= 0) doc["caps"].add("led");
  if (xinban::hasTouchBar(SCREEN_H)) doc["caps"].add("touch");
  send(doc);
}

static void sendButton(const char *b, const char *e) {
  JsonDocument doc;
  doc["t"] = "btn";
  doc["b"] = b;
  doc["e"] = e;
  doc["ms"] = millis();
  send(doc);
}

static void sendLog(const char *level, const String &msg) {
  JsonDocument doc;
  doc["t"] = "log";
  doc["level"] = level;
  doc["msg"] = msg.substring(0, 190);
  send(doc);
}

static void sendNet() {
  JsonDocument doc;
  doc["t"] = "iot.net";
  bool ok = WiFi.status() == WL_CONNECTED;
  doc["ok"] = ok;
  if (ok) {
    doc["ssid"] = WiFi.SSID();
    doc["ip"] = WiFi.localIP().toString();
    doc["rssi"] = WiFi.RSSI();
  } else {
    doc["portal"] = PORTAL_NAME;
  }
  send(doc);
}

// ---------------- 登记表：主机下发，存进 NVS，开机读回 ----------------
static void loadDevices(JsonArrayConst list) {
  xSemaphoreTake(iotLock, portMAX_DELAY);
  deviceCount = 0;
  for (JsonObjectConst item : list) {
    if (deviceCount >= MAX_IOT) break;
    IotDevice &d = devices[deviceCount];
    memset(&d, 0, sizeof(d));
    strlcpy(d.id, item["id"] | "", sizeof(d.id));
    strlcpy(d.name, item["name"] | "", sizeof(d.name));
    strlcpy(d.kind, item["kind"] | "", sizeof(d.kind));
    strlcpy(d.host, item["host"] | "", sizeof(d.host));
    strlcpy(d.ch, item["ch"] | "", sizeof(d.ch));
    d.on = -1;
    d.watts = -1;
    d.dirty = true;
    if (d.id[0] && d.host[0]) deviceCount++;
  }
  if (selected >= deviceCount) selected = 0;
  xSemaphoreGive(iotLock);
}

static void saveConfig(JsonArrayConst list) {
  String text;
  serializeJson(list, text);
  prefs.putString("iot", text);
}

static void restoreConfig() {
  String text = prefs.getString("iot", "[]");
  JsonDocument doc;
  if (!deserializeJson(doc, text) && doc.is<JsonArray>()) loadDevices(doc.as<JsonArrayConst>());
}

// ---------------- 三种设备的局域网接口 ----------------
// 只访问登记表里的主机。主机侧已经校验过是局域网地址，这里不再拼接任何外部输入。
static bool httpGet(const String &url, JsonDocument &out, const char *method = "GET") {
  HTTPClient http;
  http.setTimeout(1500);
  http.setConnectTimeout(1500);
  if (!http.begin(url)) return false;
  int code = !strcmp(method, "POST") ? http.POST("") : http.GET();
  bool ok = code >= 200 && code < 300;
  if (ok) {
    String body = http.getString();
    out.clear();
    if (body.length() > 0) deserializeJson(out, body); // 空体（ESPHome POST）也算成功
  }
  http.end();
  return ok;
}

static String tasmotaPowerKey(const IotDevice &d) {
  // Power 或 Power1..8；回包里单路设备可能叫 POWER 也可能叫 POWER1。
  return String("POWER") + d.ch;
}

static void poll(IotDevice &d) {
  JsonDocument doc;
  String base = String("http://") + d.host;
  bool online = false;
  int8_t on = -1;
  float watts = -1;
  if (!strcmp(d.kind, "tasmota")) {
    online = httpGet(base + "/cm?cmnd=Power" + d.ch, doc);
    if (online) {
      const char *v = doc[tasmotaPowerKey(d)] | (doc["POWER1"] | (doc["POWER"] | ""));
      on = !strcmp(v, "ON") ? 1 : !strcmp(v, "OFF") ? 0 : -1;
    }
  } else if (!strcmp(d.kind, "shelly")) {
    online = httpGet(base + "/rpc/Switch.GetStatus?id=" + d.ch, doc);
    if (online) {
      on = doc["output"].is<bool>() ? (doc["output"].as<bool>() ? 1 : 0) : -1;
      if (doc["apower"].is<float>()) watts = doc["apower"].as<float>();
    }
  } else if (!strcmp(d.kind, "esphome")) {
    online = httpGet(base + "/switch/" + d.ch, doc);
    if (online) {
      const char *v = doc["state"] | "";
      on = !strcmp(v, "ON") ? 1 : !strcmp(v, "OFF") ? 0 : -1;
    }
  }
  if (online != d.online || on != d.on || fabsf(watts - d.watts) > 0.5f) d.dirty = true;
  d.online = online;
  d.on = online ? on : -1;
  d.watts = online ? watts : -1;
}

static void apply(IotDevice &d, bool on) {
  JsonDocument doc;
  String base = String("http://") + d.host;
  if (!strcmp(d.kind, "tasmota")) {
    httpGet(base + "/cm?cmnd=Power" + d.ch + (on ? "%20ON" : "%20OFF"), doc);
  } else if (!strcmp(d.kind, "shelly")) {
    httpGet(base + "/rpc/Switch.Set?id=" + d.ch + (on ? "&on=true" : "&on=false"), doc);
  } else if (!strcmp(d.kind, "esphome")) {
    httpGet(base + "/switch/" + d.ch + (on ? "/turn_on" : "/turn_off"), doc, "POST");
  }
  poll(d); // 以设备实际状态为准，不假设命令一定成功
  d.dirty = true;
}

// 物联网任务：先处理开关命令，再每 3 秒轮询一遍。
static void iotTask(void *) {
  uint32_t lastPoll = 0;
  for (;;) {
    Command cmd;
    if (xQueueReceive(commands, &cmd, pdMS_TO_TICKS(100)) == pdTRUE) {
      if (WiFi.status() == WL_CONNECTED) {
        xSemaphoreTake(iotLock, portMAX_DELAY);
        if (cmd.index >= 0 && cmd.index < deviceCount) {
          IotDevice copy = devices[cmd.index];
          xSemaphoreGive(iotLock);
          apply(copy, cmd.on);
          xSemaphoreTake(iotLock, portMAX_DELAY);
          if (cmd.index < deviceCount && !strcmp(devices[cmd.index].id, copy.id)) devices[cmd.index] = copy;
        }
        xSemaphoreGive(iotLock);
      }
    }
    if (millis() - lastPoll < POLL_MS || WiFi.status() != WL_CONNECTED) continue;
    lastPoll = millis();
    for (int i = 0;; i++) {
      xSemaphoreTake(iotLock, portMAX_DELAY);
      if (i >= deviceCount) {
        xSemaphoreGive(iotLock);
        break;
      }
      IotDevice copy = devices[i]; // 拷贝出来再发请求，不持锁等网络
      xSemaphoreGive(iotLock);
      poll(copy);
      xSemaphoreTake(iotLock, portMAX_DELAY);
      if (i < deviceCount && !strcmp(devices[i].id, copy.id)) devices[i] = copy;
      xSemaphoreGive(iotLock);
    }
  }
}

static int indexOf(const char *id) {
  for (int i = 0; i < deviceCount; i++)
    if (!strcmp(devices[i].id, id)) return i;
  return -1;
}

// 主循环里把变化报给主机；没变也每 10 秒报一次，主机靠它判断「还新鲜」。
static void reportIot() {
  if (millis() - lastHostAt > HOST_STALE_MS) return;
  xSemaphoreTake(iotLock, portMAX_DELAY);
  for (int i = 0; i < deviceCount; i++) {
    IotDevice &d = devices[i];
    if (!d.dirty && millis() - d.reportedAt < 10000) continue;
    JsonDocument doc;
    doc["t"] = "iot.state";
    doc["id"] = d.id;
    doc["online"] = d.online;
    if (d.online && d.on >= 0) doc["on"] = d.on == 1;
    if (d.online && d.watts >= 0) doc["w"] = d.watts;
    send(doc);
    d.dirty = false;
    d.reportedAt = millis();
  }
  xSemaphoreGive(iotLock);
}

// ---------------- 屏幕 ----------------
static uint16_t moodColor(const char *mood) {
  if (!strcmp(mood, "waiting")) return TFT_ORANGE;
  if (!strcmp(mood, "sad")) return TFT_NAVY;
  if (!strcmp(mood, "happy")) return TFT_GREEN;
  if (!strcmp(mood, "sleep")) return TFT_DARKGREY;
  return TFT_DARKGREEN;
}

// Exact same layout/wrapping code is exercised by the native contract runner.
static void drawText(const std::string &text, int x, int y, int width = 216, int lines = 1) {
  const auto wrapped = xinban::wrapText(text, width, lines, [](const std::string &s) {
    return uiFont.getUTF8Width(s.c_str());
  });
  for (size_t i = 0; i < wrapped.size(); ++i) {
    uiFont.setCursor(x, y + 15 + i * 18);
    uiFont.print(wrapped[i].c_str());
  }
}

static void drawFace(const xinban::Face &face, uint16_t color) {
  // Face fits in y=28..72; text never overlaps it.
  for (int side = 0; side < 2; ++side) {
    int x = side ? 147 : 93;
    int y = face.eyes == "side" && side ? 43 : 39;
    if (face.eyes == "closed" || face.eyes == "narrow") tft.fillRoundRect(x-7, y, 14, 3, 1, color);
    else if (face.eyes == "happy") { tft.drawLine(x-7,y+4,x,y-1,color); tft.drawLine(x,y-1,x+7,y+4,color); }
    else if (face.eyes == "wide") tft.drawCircle(x,y+3,7,color);
    else tft.fillRoundRect(x-3,y-2,6,11,3,color);
    if (face.brows == "raised") tft.drawFastHLine(x-7,29,14,color);
    else if (face.brows == "flat") tft.drawFastHLine(x-7,32,14,color);
    else if (face.brows == "sad") tft.drawLine(x-7,side ? 28 : 32,x+7,side ? 32 : 28,color);
    if (face.blush > 0) tft.fillEllipse(x,57,7,2,face.blush > 0.5f ? TFT_PINK : TFT_MAROON);
  }
  if (face.mouth == "o") tft.drawCircle(120,61,5,color);
  else if (face.mouth == "tiny") tft.drawFastHLine(118,61,4,color);
  else if (face.mouth == "flat") tft.drawFastHLine(111,61,18,color);
  else if (face.mouth == "frown") { tft.drawLine(111,64,120,58,color); tft.drawLine(120,58,129,64,color); }
  else { tft.drawLine(111,58,120,64,color); tft.drawLine(120,64,129,58,color); if (face.mouth == "grin") tft.drawFastHLine(111,58,18,color); }
  const char *extra = face.extra == "zzz" ? "zZ" : face.extra == "question" ? "?" :
    face.extra == "sweat" ? "'" : face.extra == "heart" ? "爱" :
    face.extra == "think" ? "..." : face.extra == "note" ? "乐" : "";
  drawText(extra,183,33,40);
}

// 竖屏底部的 A/B 触摸键；240x240 的屏没有这一条。
static void drawTouchBar() {
  if (!xinban::hasTouchBar(SCREEN_H)) return;
  for (char key : {'A', 'B'}) {
    const int x = key == 'A' ? xinban::barAx : xinban::barBx;
    const int h = xinban::barBottom - xinban::barTop;
    tft.fillRoundRect(x, xinban::barTop, xinban::barW, h, 8, touchKey == key ? TFT_DARKGREY : TFT_BLACK);
    tft.drawRoundRect(x, xinban::barTop, xinban::barW, h, 8, TFT_WHITE);
    uiFont.setForegroundColor(TFT_WHITE);
    drawText(key == 'A' ? barA : barB, x + 8, xinban::barTop + 12, xinban::barW - 16, 2);
  }
}

static void render() {
  const xinban::ScreenPlan plan = xinban::planScreen(view.as<JsonObjectConst>());
  tft.fillScreen(TFT_BLACK);
  uiFont.setForegroundColor(TFT_WHITE);
  uiFont.setBackgroundColor(TFT_BLACK);
  drawFace(plan.face, moodColor(plan.mood.c_str()));
  for (const auto &block : plan.blocks) drawText(block.text,block.x,block.y,block.width,block.lines);
  barA = xinban::barLabel(plan, 'A');
  barB = xinban::barLabel(plan, 'B');
  drawTouchBar();
}

// 独立运行时的画面：设备列表 + 当前选中项。
static void renderStandalone() {
  tft.fillScreen(TFT_BLACK);
  uiFont.setForegroundColor(TFT_WHITE);
  drawText("主机已断开 / 本地设备",12,6);
  bool ok = WiFi.status() == WL_CONNECTED;
  drawText(ok ? WiFi.localIP().toString().c_str() : PORTAL_NAME,12,26);
  xSemaphoreTake(iotLock, portMAX_DELAY);
  // Five visible rows, selected device always in view (up to eight configured).
  int start = selected < 5 ? 0 : selected - 4;
  if (deviceCount == 0) drawText("等待主机连接",12,78);
  for (int i = start; i < deviceCount && i < start + 5; ++i) {
    IotDevice &d = devices[i];
    uiFont.setForegroundColor(!d.online ? TFT_DARKGREY : d.on == 1 ? TFT_GREEN : TFT_WHITE);
    std::string row = std::string(i == selected ? "> " : "  ") + d.name + " " +
      (!d.online ? "--" : d.on == 1 ? "ON" : d.on == 0 ? "OFF" : "?");
    drawText(row,12,52+(i-start)*28);
  }
  xSemaphoreGive(iotLock);
  uiFont.setForegroundColor(TFT_WHITE);
  drawText("A 下一台 / B 开关",12,216);
  barA = "A 下一台";
  barB = "B 开关";
  drawTouchBar();
}

// ---------------- 板载彩灯 ----------------
static uint32_t flashAt = 0;
static xinban::Rgb flashColor = xinban::lightOff;
static xinban::Rgb shownLight{1, 1, 1}; // 开机第一次必写
static void updateLight(bool hosted) {
  if (PIN_RGB < 0) return;
  const uint32_t now = millis();
  const xinban::Rgb c = flashAt && now - flashAt < xinban::signalFlashMs
    ? flashColor : xinban::statusLight(view.as<JsonObjectConst>(), hosted, now);
  if (c == shownLight) return;
  neopixelWrite(PIN_RGB, c.r, c.g, c.b);
  shownLight = c;
}

static void signalPattern(const char *pattern) {
  xinban::Rgb flash;
  if (PIN_RGB >= 0 && xinban::signalLight(pattern, flash)) {
    flashColor = flash;
    flashAt = millis() | 1;
  }
  if (PIN_BUZZER < 0 || !strcmp(pattern, "none")) return;
  if (strcmp(pattern,"nudge") && strcmp(pattern,"confirm") && strcmp(pattern,"happy") && strcmp(pattern,"error")) return;
  tone(PIN_BUZZER, !strcmp(pattern, "error") ? 440 : 1760, !strcmp(pattern, "confirm") ? 120 : 60);
}

// ---------------- 触摸（XPT2046，和屏共用 SPI） ----------------
// 只在 T_IRQ 为低时才读坐标：触摸没接或 MISO 悬空时会读出假按压，
// 而确认卡上的假 A 就是「允许」。T_IRQ 内部上拉，没接就永远不算按下。
#ifdef TOUCH_CS
static uint16_t touchCal[5] = {275, 3620, 264, 3532, 1}; // 常见 2.8" 竖屏近似值，校准后覆盖

static void loadTouchCalibration() {
  if (prefs.getBytesLength("touchcal") == sizeof(touchCal)) prefs.getBytes("touchcal", touchCal, sizeof(touchCal));
  tft.setTouch(touchCal);
}

// 长按 BOOT 5 秒进入：依次点四个角的箭头。数据不合理就不保存。
static void calibrateTouch() {
  tft.fillScreen(TFT_BLACK);
  uiFont.setForegroundColor(TFT_WHITE);
  drawText("触摸校准：依次点角上的箭头",12,140,216,2);
  uint16_t data[5];
  tft.calibrateTouch(data, TFT_MAGENTA, TFT_BLACK, 15);
  // TFT_eSPI 导出的是 {x0, x 跨度, y0, y 跨度, 方向位}。
  const bool ok = data[1] > 1000 && data[3] > 1000 && data[0] + data[1] < 4096 && data[2] + data[3] < 4096;
  if (ok) {
    memcpy(touchCal, data, sizeof(touchCal));
    prefs.putBytes("touchcal", touchCal, sizeof(touchCal));
  }
  tft.setTouch(touchCal);
  tft.fillScreen(TFT_BLACK);
  drawText(ok ? "校准已保存" : "校准数据不对，没有保存",12,140);
  delay(800);
}

static char readTouch() {
  if (PIN_TOUCH_IRQ < 0 || digitalRead(PIN_TOUCH_IRQ) != LOW) return 0;
  uint16_t x = 0, y = 0;
  if (!tft.getTouch(&x, &y)) return 0;
  return xinban::touchZone(x, y, SCREEN_H);
}
#else
static char readTouch() { return 0; }
#endif

// 每 20ms 读一次：同一键连续 2 次才算按下，连续 3 次没摸到才算松开（按住时偶尔会丢点）。
static void updateTouch() {
  static uint32_t lastRead = 0;
  static char candidate = 0;
  static int candidateCount = 0, releaseCount = 0;
  if (!xinban::hasTouchBar(SCREEN_H) || millis() - lastRead < 20) return;
  lastRead = millis();
  const char zone = readTouch();
  if (zone == touchKey) { candidateCount = releaseCount = 0; return; }
  if (touchKey && !zone) {
    if (++releaseCount < 3) return;
    touchKey = 0;
    releaseCount = 0;
    drawTouchBar();
    return;
  }
  if (zone != candidate) { candidate = zone; candidateCount = 1; return; }
  if (++candidateCount < 2) return;
  touchKey = zone;
  candidateCount = releaseCount = 0;
  drawTouchBar();
}

static void handle(const std::string &text, Stream *from) {
  JsonDocument doc;
  if (deserializeJson(doc, text)) return; // 坏帧直接丢
  const char *t = doc["t"] | "";
  if (!strcmp(t, "hello")) {
    host = from;
    sendHello(); // A version mismatch is visible to the host, never silently accepted.
    handshaken = doc["proto"].is<int>() && doc["proto"].as<int>() == PROTO;
    if (handshaken) { lastHostAt = millis(); sendNet(); }
    return;
  }
  if (from != host) return;
  if (!handshaken || millis() - lastHostAt >= HOST_STALE_MS) return;
  if (!strcmp(t, "ping") && doc["n"].is<unsigned long>()) {
    lastHostAt = millis();
    JsonDocument pong;
    pong["t"] = "pong";
    pong["n"] = doc["n"] | 0;
    send(pong);
  } else if (!strcmp(t, "view") && doc["view"].is<JsonObject>() && doc["view"]["v"] == 1) {
    lastHostAt = millis();
    view.set(doc["view"]);
    render();
  } else if (!strcmp(t, "signal")) {
    signalPattern(doc["pattern"] | "none");
  } else if (!strcmp(t, "iot.config") && doc["devices"].is<JsonArray>()) {
    JsonArrayConst list = doc["devices"].as<JsonArrayConst>();
    saveConfig(list);
    loadDevices(list);
    sendNet();
    sendLog("info", String("iot config: ") + deviceCount + " devices");
  } else if (!strcmp(t, "iot.set") && doc["id"].is<const char *>() && doc["on"].is<bool>()) {
    Command cmd{indexOf(doc["id"] | ""), doc["on"] | false};
    if (cmd.index >= 0) xQueueSend(commands, &cmd, 0);
  }
}

static void pump(Stream &port, xinban::LineBuffer &lines) {
  for (int received = 0; received < 256 && port.available(); ++received) {
    lines.push(static_cast<char>(port.read()), [&port](const std::string &line) { handle(line, &port); });
  }
}

// 独立运行时自己处理按键（简单 50ms 去抖，只认短按松开）。
static uint32_t downAtA = 0, downAtB = 0;
static void standaloneButton(bool a, bool b) {
  uint32_t now = millis();
  if (a && !lastA) downAtA = now;
  if (b && !lastB) downAtB = now;
  if (!a && lastA && now - downAtA > 50 && deviceCount > 0) {
    selected = (selected + 1) % deviceCount;
    renderStandalone();
  }
  if (!b && lastB && now - downAtB > 50 && deviceCount > 0) {
    xSemaphoreTake(iotLock, portMAX_DELAY);
    Command cmd{selected, devices[selected].on != 1};
    xSemaphoreGive(iotLock);
    xQueueSend(commands, &cmd, 0);
  }
}

static bool pressed(int pin) { return pin >= 0 && digitalRead(pin) == LOW; }

void setup() {
  Serial.begin(115200);
  Serial0.begin(115200);
  if (PIN_BTN_A >= 0) pinMode(PIN_BTN_A, INPUT_PULLUP);
  if (PIN_BTN_B >= 0) pinMode(PIN_BTN_B, INPUT_PULLUP);
  if (PIN_BOOT >= 0) pinMode(PIN_BOOT, INPUT_PULLUP);
  if (PIN_TOUCH_IRQ >= 0) pinMode(PIN_TOUCH_IRQ, INPUT_PULLUP);
  if (PIN_RGB >= 0) neopixelWrite(PIN_RGB, 0, 0, 0);
  tft.init();
  tft.setRotation(0);
  uiFont.begin(tft);
  uiFont.setFont(u8g2_font_wqy16_t_gb2312);
  uiFont.setFontMode(1);
  uiFont.setForegroundColor(TFT_WHITE);
  uiFont.setBackgroundColor(TFT_BLACK);
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE);
  tft.setTextDatum(MC_DATUM);
  drawText("等待主机连接",12,112);

  iotLock = xSemaphoreCreateMutex();
  commands = xQueueCreate(8, sizeof(Command));
  prefs.begin("xinban", false);
  restoreConfig();
#ifdef TOUCH_CS
  loadTouchCalibration();
#endif

  // 非阻塞配网：连不上就开热点「Xinban-Setup」，同时串口和屏幕照常工作。
  WiFi.mode(WIFI_STA);
  wifi.setDebugOutput(false); // Keep the NDJSON serial channel free of library diagnostics.
  wifi.setConfigPortalBlocking(false);
  wifi.autoConnect(PORTAL_NAME);

  xTaskCreatePinnedToCore(iotTask, "iot", 8192, nullptr, 1, nullptr, 0);
  // 不主动发 hello：主机打开端口后先发，设备再回。
}

void loop() {
  wifi.process(); // 配网门户的非阻塞步进
  pump(Serial, usbLines);
  pump(Serial0, uartLines);
  bool hosted = handshaken && millis() - lastHostAt < HOST_STALE_MS;
  if (!hosted) handshaken = false;
  updateTouch();
  const bool boot = pressed(PIN_BOOT);
  bool a = pressed(PIN_BTN_A) || boot || touchKey == 'A';
  bool b = pressed(PIN_BTN_B) || touchKey == 'B';
#ifdef TOUCH_CS
  static uint32_t bootDownAt = 0;
  if (boot && !bootDownAt) bootDownAt = millis() | 1;
  if (!boot) bootDownAt = 0;
  if (bootDownAt && millis() - bootDownAt > 5000) {
    bootDownAt = 0;
    calibrateTouch();
    if (hosted) render(); else renderStandalone();
  }
#endif
  if (hosted) {
    // 只报原始边沿；去抖与长按在主机。
    if (a != lastA) sendButton("A", a ? "down" : "up");
    if (b != lastB) sendButton("B", b ? "down" : "up");
    reportIot();
  } else {
    standaloneButton(a, b);
    static uint32_t lastDraw = 0;
    if (millis() - lastDraw > 1000) {
      lastDraw = millis();
      renderStandalone();
    }
  }
  updateLight(hosted);
  static uint32_t lastNet = 0;
  if (hosted && millis() - lastNet > 10000) {
    lastNet = millis();
    sendNet();
  }
  lastA = a;
  lastB = b;
  delay(5);
}
