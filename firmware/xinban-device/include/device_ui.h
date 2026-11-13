#pragma once
#include <ArduinoJson.h>
#include <algorithm>
#include <string>
#include <vector>

namespace xinban {
struct TextBlock {
  std::string role, text;
  int x, y, width, lines;
};
struct Face {
  std::string eyes = "open", brows = "none", mouth = "smile", extra = "none";
  float blush = 0;
};
struct ScreenPlan {
  std::string mode, mood;
  Face face;
  std::vector<TextBlock> blocks;
};
inline std::string str(JsonVariantConst value) { return value.is<const char *>() ? value.as<const char *>() : ""; }
inline bool printableConfirmation(const std::string &text) {
  if (text.size() > 24) return false;
  for (unsigned char ch : text) if (ch < 32 || ch > 126) return false;
  return true;
}
inline ScreenPlan planScreen(JsonObjectConst view) {
  ScreenPlan out;
  out.mode = "normal";
  out.mood = str(view["mood"]);
  if (view["quiet"] == true) out.mood = "sleep";
  if (out.mood == "sleep") { out.face.eyes = "closed"; out.face.extra = "zzz"; }
  if (out.mood == "happy") { out.face.eyes = "happy"; out.face.mouth = "grin"; }
  if (out.mood == "sad") { out.face.brows = "sad"; out.face.mouth = "frown"; }
  if (out.mood == "focus" || out.mood == "busy") out.face.eyes = "narrow";
  if (out.mood == "waiting") { out.face.eyes = "side"; out.face.extra = "question"; }
  JsonObjectConst face = view["face"];
  if (!face.isNull()) {
    out.face.eyes = str(face["eyes"]); out.face.brows = str(face["brows"]);
    out.face.mouth = str(face["mouth"]); out.face.extra = str(face["extra"]);
    out.face.blush = std::max(0.0f, std::min(1.0f, face["blush"].as<float>()));
  }
  auto add = [&](const char *role, std::string text, int y, int lines = 1) {
    if (!text.empty()) out.blocks.push_back({role, text, 12, y, 216, lines});
  };
  add("corner", view["quiet"] == true ? "勿扰" : str(view["corner"]), 6);
  JsonObjectConst card = view["card"];
  if (!card.isNull()) {
    out.mode = str(card["kind"]);
    bool confirm = out.mode == "confirm";
    add("title", str(confirm ? card["title"] : card["text"]), 78, confirm ? 2 : 4);
    if (confirm) {
      const std::string detail = str(card["detail"]);
      add("detail", detail, 114, 3);
      add("countdown", "剩余 " + std::to_string(std::max(0, card["seconds"].as<int>())) +
          " 秒 / 排队 " + std::to_string(std::max(0, card["queued"].as<int>())), 170);
      // Defense in depth; the host independently applies the same ASCII-only rule.
      add("hintA", card["seconds"].as<int>() <= 0 ? "A 已超时" :
          "A " + (printableConfirmation(detail) ? str(card["hintA"]) : "去桌面看全文"), 192);
    } else add("hintA", "A " + str(card["hintA"]), 192);
    add("hintB", "B " + str(card["hintB"]), 212);
  } else {
    add("title", str(view["title"]), 78);
    add("detail", str(view["detail"]), 96);
    add("work", str(view["work"]), 114);
    add("bubble", str(view["bubble"]), 132, 3);
    JsonObjectConst timer = view["timer"];
    if (!timer.isNull()) add("timer", str(timer["label"]) + " " + str(timer["remaining"]), 188);
    JsonObjectConst todo = view["todo"];
    if (!todo.isNull()) add("todo", str(todo["title"]) + " " + str(todo["due"]) +
        (todo["more"].as<int>() > 0 ? " +" + std::to_string(todo["more"].as<int>()) : ""), 208);
  }
  return out;
}

// UTF-8 scalar boundaries; unsupported 4-byte glyphs use '?', never broken bytes.
inline std::vector<std::string> glyphs(const std::string &text) {
  std::vector<std::string> out;
  for (size_t i = 0; i < text.size();) {
    unsigned char c = text[i];
    size_t n = c < 0x80 ? 1 : (c >= 0xc2 && c < 0xe0) ? 2 : (c < 0xf0 && c >= 0xe0) ? 3 : (c >= 0xf0 && c <= 0xf4) ? 4 : 0;
    bool valid = n && i + n <= text.size();
    for (size_t j = 1; valid && j < n; ++j) valid = (static_cast<unsigned char>(text[i+j]) & 0xc0) == 0x80;
    if (!valid) { out.push_back("?"); ++i; continue; }
    out.push_back(n == 4 ? "?" : text.substr(i, n));
    i += n;
  }
  return out;
}

// Width is measured by the actual U8g2 font on-device. Native tests inject a metric.
// maxLines is a hard bound; truncation is visible, never splits a UTF-8 character.
template <typename Measure>
std::vector<std::string> wrapText(const std::string &text, int width, int maxLines, Measure measure) {
  std::vector<std::string> lines(1);
  bool clipped = false;
  for (const auto &g : glyphs(text)) {
    if (g == "\r") continue;
    const std::string piece = g == "\t" ? " " : g;
    if (piece == "\n" || measure(lines.back() + piece) > width) {
      if (static_cast<int>(lines.size()) >= maxLines) { clipped = true; break; }
      lines.emplace_back();
      if (piece == "\n") continue;
    }
    if (measure(piece) <= width) lines.back() += piece;
  }
  if (clipped) {
    auto parts = glyphs(lines.back());
    while (!parts.empty() && measure(lines.back() + "...") > width) {
      parts.pop_back(); lines.back().clear();
      for (const auto &part : parts) lines.back() += part;
    }
    lines.back() += "...";
  }
  return lines;
}
}
