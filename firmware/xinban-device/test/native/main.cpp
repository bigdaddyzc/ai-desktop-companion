#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include "device_ui.h"
#include "line_buffer.h"
#include "status_light.h"
#include "touch_bar.h"

static void check(bool condition, const std::string &message) {
  if (!condition) throw std::runtime_error(message);
}
int main(int argc, char **argv) {
  try {
    check(argc == 2, "usage: native-contracts fixture.json");
    std::ifstream input(argv[1]);
    check(input.good(), "fixture file unavailable");
    JsonDocument doc;
    check(!deserializeJson(doc, input), "invalid fixtures");
    int screens = 0, streams = 0;
    const auto measure = [](const std::string &s) {
      int width = 0;
      for (const auto &g : xinban::glyphs(s)) width += g.size() == 1 ? 8 : 16;
      return width;
    };
    for (JsonObjectConst test : doc["screens"].as<JsonArrayConst>()) {
      std::string name = xinban::str(test["name"]);
      auto plan = xinban::planScreen(test["view"]);
      check(plan.mode == xinban::str(test["expect"]["mode"]), name + ": mode");
      check(plan.blocks.size() == test["expect"]["roles"].size(), name + ": block count");
      for (size_t i=0; i<plan.blocks.size(); ++i) {
        const auto &b = plan.blocks[i];
        check(b.role == xinban::str(test["expect"]["roles"][i]), name + ": role");
        check(b.x >= 0 && b.x+b.width <= 240 && b.y >= 0 && b.y+b.lines*18 <= 240, name + ": bounds");
        auto lines = xinban::wrapText(b.text,b.width,b.lines,measure);
        check(static_cast<int>(lines.size()) <= b.lines, name + ": line budget");
        for (const auto &line : lines) check(measure(line) <= b.width, name + ": width budget");
        // Short display fields must survive the C++ planner, not merely be received.
        if (b.role == "bubble" || b.role == "work") check(b.text == xinban::str(test["view"][b.role]), name+": content lost");
        if (b.role == "hintA" && plan.mode == "confirm" && test["view"]["card"]["seconds"].as<int>() <= 0)
          check(b.text == "A 已超时",name+": expired approval hint");
        if (b.role == "countdown") check(b.text.find(std::to_string(test["view"]["card"]["seconds"].as<int>())) != std::string::npos,name+": countdown");
      }
      check(plan.face.eyes == xinban::str(test["expect"]["face"]["eyes"]),name+": eyes");
      check(plan.face.mouth == xinban::str(test["expect"]["face"]["mouth"]),name+": mouth");
      check(plan.face.brows == xinban::str(test["expect"]["face"]["brows"]),name+": brows");
      check(plan.face.extra == xinban::str(test["expect"]["face"]["extra"]),name+": extra");
      ++screens;
    }
    for (JsonObjectConst test : doc["streams"].as<JsonArrayConst>()) {
      xinban::LineBuffer buffer;
      std::vector<std::string> lines;
      for (JsonVariantConst chunk : test["chunks"].as<JsonArrayConst>()) {
        for (char c : xinban::str(chunk)) buffer.push(c,[&](const std::string &line){lines.push_back(line);});
      }
      check(lines.size() == test["lines"].size(),xinban::str(test["name"])+": frame count");
      for(size_t i=0;i<lines.size();++i) check(lines[i]==xinban::str(test["lines"][i]),"frame mismatch");
      ++streams;
    }
    auto wrapped = xinban::wrapText("一二三四五六七八九十",32,2,measure);
    check(wrapped.size()==2 && wrapped.back().find("...")!=std::string::npos,"visible overflow");
    check(xinban::printableConfirmation("npm test"),"ASCII confirmation");
    check(!xinban::printableConfirmation("npm\ntest"),"multiline confirmation");
    check(!xinban::printableConfirmation("查看屏幕"),"Unicode confirmation");
    // Status light: confirm blinks and outranks quiet; nothing lights for an idle host view.
    auto light = [](const char *json, bool hosted, uint32_t now) {
      JsonDocument v;
      deserializeJson(v, json);
      return xinban::statusLight(v.as<JsonObjectConst>(), hosted, now);
    };
    const char *confirmQuiet = "{\"quiet\":true,\"card\":{\"kind\":\"confirm\"}}";
    check(light(confirmQuiet,true,100) == xinban::lightConfirm,"confirm light on");
    check(light(confirmQuiet,true,600) == xinban::lightOff,"confirm light blinks");
    check(light("{\"quiet\":true,\"card\":{\"kind\":\"nudge\"}}",true,0) == xinban::lightQuiet,"quiet outranks nudge");
    check(light("{\"card\":{\"kind\":\"nudge\"},\"timer\":{}}",true,0) == xinban::lightNudge,"nudge outranks timer");
    check(light("{\"timer\":{\"label\":\"x\"}}",true,0) == xinban::lightTimer,"timer light");
    check(light("{\"timer\":null,\"card\":null}",true,0) == xinban::lightOff,"idle is dark");
    check(light(confirmQuiet,false,0) == xinban::lightWaiting && light(confirmQuiet,false,1000) == xinban::lightOff,"stale view ignored when host gone");
    xinban::Rgb flash;
    check(xinban::signalLight("error",flash) && flash.r > 0 && flash.g == 0,"error flash");
    check(!xinban::signalLight("rainbow",flash),"unknown signal stays dark");

    // Touch keys: only the bottom bar of a 320-high screen counts; the gap between keys is dead.
    check(xinban::touchZone(60,280,320) == 'A' && xinban::touchZone(180,280,320) == 'B',"touch keys");
    check(xinban::touchZone(120,280,320) == 0,"gap between keys");
    check(xinban::touchZone(60,200,320) == 0 && xinban::touchZone(60,315,320) == 0,"outside bar");
    check(xinban::touchZone(60,280,240) == 0 && !xinban::hasTouchBar(240),"no bar on 240 screen");
    JsonDocument card;
    deserializeJson(card, "{\"v\":1,\"card\":{\"kind\":\"confirm\",\"title\":\"t\",\"detail\":\"删文件\",\"seconds\":30,\"queued\":0,\"hintA\":\"允许\",\"hintB\":\"拒绝\"}}");
    auto cardPlan = xinban::planScreen(card.as<JsonObjectConst>());
    // Non-ASCII detail: the A key must not offer "允许" on the device.
    check(xinban::barLabel(cardPlan,'A') == "A 去桌面看全文" && xinban::barLabel(cardPlan,'B') == "B 拒绝","key labels follow card");
    JsonDocument idle;
    deserializeJson(idle, "{\"v\":1,\"title\":\"hi\"}");
    check(xinban::barLabel(xinban::planScreen(idle.as<JsonObjectConst>()),'A') == "A","plain key label");
    for (const char *label : {"A 去桌面看全文","B 拒绝","A 下一台"})
      check(xinban::wrapText(label,xinban::barW-16,2,measure).back().find("...") == std::string::npos,"key label fits");

    std::cout << "Native firmware contracts passed: " << screens << " screens, " << streams << " streams, wrapping, confirmation, status light and touch key guards\n";
    return 0;
  } catch(const std::exception &e) { std::cerr << e.what() << "\n"; return 1; }
}
