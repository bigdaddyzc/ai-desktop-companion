#pragma once
#include <string>
#include "device_ui.h"

// 竖屏 240x320 时，上方 240x240 沿用原布局，下方是 A/B 两个触摸键。
// 本机测试与固件共用。
namespace xinban {
constexpr int barTop = 248, barBottom = 312;
constexpr int barAx = 8, barBx = 124, barW = 108;

inline bool hasTouchBar(int screenHeight) { return screenHeight >= barBottom; }

// 两键之间留 8px 空隙，压在缝上不算任何键。
inline char touchZone(int x, int y, int screenHeight) {
  if (!hasTouchBar(screenHeight) || y < barTop || y >= barBottom) return 0;
  if (x >= barAx && x < barAx + barW) return 'A';
  if (x >= barBx && x < barBx + barW) return 'B';
  return 0;
}

// 键上的字直接用主机给的卡片提示；没有卡片就只写字母，不在固件里猜业务。
inline std::string barLabel(const ScreenPlan &plan, char key) {
  const std::string role = key == 'A' ? "hintA" : "hintB";
  for (const auto &block : plan.blocks)
    if (block.role == role) return block.text;
  return std::string(1, key);
}
}
