#pragma once
#include <stddef.h>
#include <string>
#include "board_config.h"

namespace xinban {
// The same receiver is used in firmware and native contract tests.
class LineBuffer {
  std::string pending;
  bool dropping = false;
public:
  template <typename Emit> void push(char ch, Emit emit) {
    if (ch == '\n') {
      if (!pending.empty() && pending.back() == '\r') pending.pop_back();
      if (!dropping && pending.size() <= maxFrameBytes) emit(pending);
      reset();
    } else if (!dropping) {
      if (pending.size() + 1 > maxFrameBytes + (ch == '\r' ? 1 : 0)) {
        pending.clear();
        dropping = true;
      } else pending += ch;
    }
  }
  void reset() { pending.clear(); dropping = false; }
};
}
