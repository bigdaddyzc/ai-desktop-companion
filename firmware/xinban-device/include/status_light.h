#pragma once
#include <ArduinoJson.h>
#include <stdint.h>
#include <string.h>

// 板载彩灯：把主机给的画面换成一盏灯，不做业务判断。本机测试与固件共用。
namespace xinban {
struct Rgb {
  uint8_t r, g, b;
  bool operator==(const Rgb &o) const { return r == o.r && g == o.g && b == o.b; }
  bool operator!=(const Rgb &o) const { return !(*this == o); }
};
// 亮度刻意压低：WS2812 满亮度在桌上刺眼。
constexpr Rgb lightOff{0, 0, 0};
constexpr Rgb lightWaiting{6, 6, 6};    // 没连上主机：每 3 秒闪一下
constexpr Rgb lightConfirm{40, 10, 0};  // 等你批准：橙色 1 秒一闪
constexpr Rgb lightQuiet{10, 0, 14};    // 勿扰：暗紫常亮
constexpr Rgb lightNudge{30, 22, 0};    // 有提醒/待看：黄色常亮
constexpr Rgb lightTimer{0, 10, 0};     // 计时中：暗绿常亮
constexpr uint32_t signalFlashMs = 600;

// 优先级：等批准 > 勿扰 > 提醒 > 计时 > 灭。勿扰时确认卡仍闪，因为它在等你回答。
inline Rgb statusLight(JsonObjectConst view, bool hosted, uint32_t now) {
  if (!hosted) return now % 3000 < 150 ? lightWaiting : lightOff;
  JsonObjectConst card = view["card"];
  const char *kind = card["kind"] | "";
  if (!strcmp(kind, "confirm")) return now % 1000 < 500 ? lightConfirm : lightOff;
  if (view["quiet"] == true) return lightQuiet;
  if (!strcmp(kind, "nudge")) return lightNudge;
  if (!view["timer"].isNull()) return lightTimer;
  return lightOff;
}

// 主机 signal 帧：卡片新出现时短闪一次，未知样式不亮。
inline bool signalLight(const char *pattern, Rgb &out) {
  if (!strcmp(pattern, "happy")) out = Rgb{0, 40, 0};
  else if (!strcmp(pattern, "error")) out = Rgb{40, 0, 0};
  else if (!strcmp(pattern, "nudge") || !strcmp(pattern, "confirm")) out = Rgb{30, 30, 30};
  else return false;
  return true;
}
}
