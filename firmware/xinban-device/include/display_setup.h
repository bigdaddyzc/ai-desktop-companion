#pragma once
// ESP32-S3-DevKitC-1 N16R8 + 240x240 ST7789 SPI, 3.3V logic.
// Compile-time design baseline: verify the purchased module before wiring.
#define ST7789_DRIVER
#define TFT_WIDTH 240
#define TFT_HEIGHT 240
#define TFT_MOSI 17
#define TFT_SCLK 18
#define TFT_CS 16
#define TFT_DC 15
#define TFT_RST 14
#define TFT_BL 13
#define TFT_BACKLIGHT_ON HIGH
#define TFT_MISO -1
#define TFT_RGB_ORDER TFT_RGB
#define SPI_FREQUENCY 20000000
#define LOAD_GLCD
#define LOAD_FONT2
#define LOAD_FONT4
#define SUPPORT_TRANSACTIONS
