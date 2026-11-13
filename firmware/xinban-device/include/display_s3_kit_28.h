#pragma once
// 用户实购套件（2026-11-12）：ESP32-S3 N16R8 双 Type-C 板 + 2.8" SPI 触摸屏。
// 按最常见的 ILI9341 240x320 + XPT2046 触摸预设，竖屏使用；到货后按屏背丝印核对。
// 屏和触摸共用一组 SPI（S3 的 FSPI 默认脚 10~13），引脚表见 docs/hardware-baseline.md 第 8 节。
#define ILI9341_DRIVER
#define TFT_WIDTH 240
#define TFT_HEIGHT 320
#define TFT_MISO 13
#define TFT_MOSI 11
#define TFT_SCLK 12
#define TFT_CS 10
#define TFT_DC 9
#define TFT_RST 8
#define TFT_BL 7
#define TFT_BACKLIGHT_ON HIGH
#define TOUCH_CS 4
// 杜邦线长、无屏蔽，频率保守；实屏稳定后可再提。
#define SPI_FREQUENCY 20000000
#define SPI_READ_FREQUENCY 10000000
#define SPI_TOUCH_FREQUENCY 2500000
#define LOAD_GLCD
#define LOAD_FONT2
#define LOAD_FONT4
#define SUPPORT_TRANSACTIONS
