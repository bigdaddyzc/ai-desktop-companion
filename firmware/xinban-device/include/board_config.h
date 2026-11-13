#pragma once
// Per-env overrides come from platformio.ini build_flags; defaults are the
// DevKitC-1 + ST7789 + two-button design baseline.
#ifndef XINBAN_BUTTON_A
#define XINBAN_BUTTON_A 4
#endif
#ifndef XINBAN_BUTTON_B
#define XINBAN_BUTTON_B 5
#endif
#ifndef XINBAN_BOOT_BUTTON
#define XINBAN_BOOT_BUTTON -1 // GPIO0 BOOT key reported as A; -1 = unused
#endif
#ifndef XINBAN_RGB_PIN
#define XINBAN_RGB_PIN -1 // onboard WS2812 data pin; -1 = never driven
#endif
#ifndef XINBAN_TOUCH_IRQ
#define XINBAN_TOUCH_IRQ -1 // XPT2046 PENIRQ; touch is read only while it is LOW
#endif
#ifndef XINBAN_SCREEN_H
#define XINBAN_SCREEN_H 240
#endif
#ifndef XINBAN_BOARD_NAME
#define XINBAN_BOARD_NAME "esp32-s3-devkitc-1"
#endif

namespace xinban {
constexpr int buttonA = XINBAN_BUTTON_A;
constexpr int buttonB = XINBAN_BUTTON_B;
constexpr int bootButton = XINBAN_BOOT_BUTTON;
constexpr int rgbLed = XINBAN_RGB_PIN;
constexpr int touchIrq = XINBAN_TOUCH_IRQ;
constexpr int screenW = 240;
constexpr int screenH = XINBAN_SCREEN_H;
constexpr const char *boardName = XINBAN_BOARD_NAME;
// No buzzer in any current build. Never drive an unverified pin.
constexpr int buzzer = -1;
constexpr unsigned protocolVersion = 1;
constexpr unsigned maxFrameBytes = 2048; // JSON payload; CR/LF excluded.
constexpr unsigned hostStaleMs = 15000;
}
