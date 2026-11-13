/**
 * DeepSeek 工具调用标记（DSML）漏进正文时的兜底。
 *
 * 正常情况下，模型写出
 *
 *     <｜DSML｜function_calls>
 *     <｜DSML｜invoke name="delegate_task">
 *     <｜DSML｜parameter name="target" string="true">claude</｜DSML｜parameter>
 *     </｜DSML｜invoke>
 *     </｜DSML｜function_calls>
 *
 * 服务端识别后转成 function_call 条目，客户端看不到这段文字。
 * 但模型偶尔写坏格式（用户截到过 `<｜｜DSML｜｜ calls>`：竖线多一层、`function_calls` 变成 `calls`），
 * 服务端认不出来，就把它当成普通正文发回来。于是用户看到一堆标记，而且派活根本没执行。
 *
 * 这里做两件事：标记一律不给人看；能完整读懂的调用交还给工具循环照常执行。
 * 「完整」是硬要求：参数没闭合的不执行——半截的任务派出去，比不派更糟。
 * 这里只解析，不绕过任何关卡：高风险工具的逐次确认在工具执行层，救回来的调用一样要问。
 */

/** 竖线可能是全角「｜」也可能是半角「|」，可能写一层也可能写两层。 */
const bar = '[\\uFF5C|]{1,3}';
const mark = `${bar}\\s*DSML\\s*${bar}\\s*`;

const markerPattern = new RegExp(`<\\/?\\s*${mark}`, 'u');

export function hasDsml(text: string): boolean {
  return markerPattern.test(text);
}

/** 第一个标记之前的正文：模型常在调工具前先说半句「我让 Claude 去看看。」。 */
export function visibleText(text: string): string {
  const match = markerPattern.exec(text);
  return (match ? text.slice(0, match.index) : text).trim();
}

export interface RecoveredCall {
  name: string;
  arguments: string;
}

export interface DsmlRecovery {
  calls: RecoveredCall[];
  /** 有调用没写完或不认识。只要有一个不完整，整批都不执行。 */
  broken: boolean;
}

function decodeValue(raw: string, isString: boolean): unknown {
  const value = raw.trim();
  if (isString) return raw.replace(/^\n/, '').replace(/\n$/, '');
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * 从漏出的标记里读出工具调用。
 * 只接受本轮声明过的工具名；任何一个参数没闭合、工具名不认识、一个调用都没有，都算 broken。
 */
export function recoverDsmlCalls(text: string, allowed: readonly string[]): DsmlRecovery {
  const invokePattern = new RegExp(`<\\s*${mark}invoke\\s+name\\s*=\\s*"([^"]+)"\\s*>`, 'gu');
  const invokes = [...text.matchAll(invokePattern)];
  if (invokes.length === 0) return { calls: [], broken: true };

  const calls: RecoveredCall[] = [];
  let broken = false;
  invokes.forEach((invoke, index) => {
    const start = invoke.index + invoke[0].length;
    const end = index + 1 < invokes.length ? invokes[index + 1]!.index : text.length;
    const body = text.slice(start, end);
    const name = invoke[1]!.trim();
    if (!allowed.includes(name)) {
      broken = true;
      return;
    }
    const openers = body.match(new RegExp(`<\\s*${mark}parameter\\b`, 'gu')) ?? [];
    const paramPattern = new RegExp(
      `<\\s*${mark}parameter\\s+name\\s*=\\s*"([^"]+)"(?:\\s+string\\s*=\\s*"(true|false)")?\\s*>([\\s\\S]*?)<\\/\\s*${mark}parameter\\s*>`,
      'gu',
    );
    const args: Record<string, unknown> = {};
    let closed = 0;
    for (const param of body.matchAll(paramPattern)) {
      closed += 1;
      args[param[1]!.trim()] = decodeValue(param[3]!, param[2] !== 'false');
    }
    if (closed !== openers.length) {
      broken = true;
      return;
    }
    calls.push({ name, arguments: JSON.stringify(args) });
  });
  if (calls.length === 0) broken = true;
  return { calls: broken ? [] : calls, broken };
}

/**
 * 流式过滤：打字时一旦出现标记就停止往屏幕上送。
 *
 * 增量可能切在标记中间（「<｜」先到、「DSML｜」后到），所以末尾一个可疑的「<…」先压着，
 * 等下一块来了再判断；流结束时 flush 把压着的那点正常文字补上。
 */
export function dsmlDeltaFilter(emit: (text: string) => void): {
  push(text: string): void;
  flush(): void;
} {
  let buffer = '';
  let sent = 0;
  let stopped = false;
  const holdFrom = (): number => {
    const at = buffer.lastIndexOf('<');
    if (at === -1 || at < sent) return buffer.length;
    const tail = buffer.slice(at);
    // 还可能长成标记的尾巴才压着：短、没有「>」、只含标记里会出现的字符。
    return tail.length <= 12 && /^<\/?\s*[｜|]*\s*D?S?M?L?\s*[｜|]*$/u.test(tail)
      ? at
      : buffer.length;
  };
  return {
    push(text) {
      if (stopped || text === '') return;
      buffer += text;
      const match = markerPattern.exec(buffer);
      if (match) {
        stopped = true;
        const visible = buffer.slice(sent, match.index).replace(/\s+$/, '');
        if (visible !== '') emit(visible);
        sent = buffer.length;
        return;
      }
      let until = holdFrom();
      // 末尾的空白也先压着：标记前常有一个换行，提前送出去小屏就多一行空白。
      while (until > sent && /\s/u.test(buffer[until - 1]!)) until -= 1;
      if (until > sent) {
        emit(buffer.slice(sent, until));
        sent = until;
      }
    },
    flush() {
      if (stopped || sent >= buffer.length) return;
      emit(buffer.slice(sent));
      sent = buffer.length;
    },
  };
}
