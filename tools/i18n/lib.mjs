// round73（3.0b₁）i18n 工具库 —— **唯一实现**：抽取（extract）/ 迁移（migrate）/ 检查（check）共用。
//
// 口径（《文案审计》§1.1 + §1.4「文案条数只能来自用户可见串」）：
//   · 只算用户可见串：模板文本节点 · title/placeholder/aria-label/alt · 字符串与模板字面量
//   · 不算注释 / 日志串（`[模块] …`）/ 测试（*.test.ts 与 #[cfg(test)]）/ CSS
//   · 纯 ASCII 文案（Backlog / NEW / ??? …）不进资源层、也不在扫描范围里（round73 定：只外置含中文的用户可见串）
//
// 条目形状（绝对 offset，可直接做替换）：
//   { file, lang, kind, start, end, raw, value, params, line, col }
//   kind: svelte-text | svelte-attr | js-literal | js-template | rs-literal
//   raw   = 源码里那条字面量的**解码值**（文本节点 = 原文）
//   value = 归一后的消息值（模板/format 占位统一成 {name}；空白折叠；实体解码）
//   params = [{ name, expr }]（模板表达式 / format 占位对应的表达式名）

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
export const hasCjk = (s) => CJK_RE.test(s);

// ------------------------------------------------------------------ 位置

export function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

export function lineCol(text, offset) {
  const starts = lineStarts(text);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - starts[lo] + 1 };
}

let _startsCache = { text: "", starts: [0] };
function lineStarts(text) {
  if (_startsCache.text === text) return _startsCache.starts;
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  _startsCache = { text, starts };
  return starts;
}

// ------------------------------------------------------------------ 通用

/** 从表达式里取一个合法的参数名（`a.name` → `name`；`items[i]` → `items`；空 → pN） */
export function paramName(expr, fallback) {
  const cleaned = expr.replace(/["'`]/g, "");
  const ids = cleaned.match(/[A-Za-z_$][\w$]*/g);
  if (!ids || ids.length === 0) return fallback;
  // 取最后一个标识符（属性名 / 变量名），但避开关键字
  const kw = new Set(["true", "false", "null", "undefined", "this"]);
  for (let i = ids.length - 1; i >= 0; i--) if (!kw.has(ids[i])) return ids[i];
  return fallback;
}

const ENTITIES = {
  "&nbsp;": "\u00a0",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&hellip;": "…",
  "&middot;": "·",
};

export function decodeEntities(s) {
  return s.replace(/&(?:nbsp|amp|lt|gt|quot|#39|hellip|middot);/g, (m) => ENTITIES[m] ?? m);
}

/** 文本节点归一：实体解码 + 空白折叠（HTML 本来就折叠，值里也折成单个空格） */
export function normalizeText(s) {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

function addEntry(entries, file, text, e) {
  const { line, col } = lineCol(text, e.start);
  entries.push({ file, line, col, ...e });
}

// ------------------------------------------------------------------ JS / TS

const REGEX_PREV = /[([{,;:=!&|?+\-*%~^<>]$/;

function skipJsComment(text, i, end) {
  if (text[i + 1] === "/") {
    const nl = text.indexOf("\n", i);
    return nl < 0 || nl > end ? end : nl;
  }
  const close = text.indexOf("*/", i + 2);
  return close < 0 || close > end ? end : close + 2;
}

function isRegexStart(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return true;
  return REGEX_PREV.test(text[j]) || text.slice(0, j + 1).endsWith("=>");
}

function skipRegex(text, i, end) {
  let j = i + 1;
  let inClass = false;
  while (j < end) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j + 1;
    else if (c === "\n") return j;
    j++;
  }
  return end;
}

/** 读一个 JS 字符串字面量（i 指向引号），返回结束下标（闭引号后一位）；命中中文则记录 */
function readJsString(text, i, end, file, entries, kind = "js-literal") {
  const quote = text[i];
  let j = i + 1;
  let out = "";
  while (j < end) {
    const c = text[j];
    if (c === "\\") {
      const esc = text[j + 1];
      if (esc === "n") out += "\n";
      else if (esc === "t") out += "\t";
      else if (esc === "r") out += "\r";
      else if (esc === "0") out += "\0";
      else if (esc === "x") { out += String.fromCharCode(parseInt(text.slice(j + 2, j + 4), 16)); j += 4; continue; }
      else if (esc === "u") {
        if (text[j + 2] === "{") {
          const close = text.indexOf("}", j + 3);
          out += String.fromCodePoint(parseInt(text.slice(j + 3, close), 16));
          j = close + 1;
          continue;
        }
        out += String.fromCharCode(parseInt(text.slice(j + 2, j + 6), 16));
        j += 6;
        continue;
      } else out += esc === undefined ? "" : esc;
      j += 2;
      continue;
    }
    if (c === quote || c === "\n") break;
    out += c;
    j++;
  }
  const endIdx = text[j] === quote ? j + 1 : j;
  if (hasCjk(out) && !/^\[[a-z-]+\]/.test(out)) {
    addEntry(entries, file, text, {
      kind,
      start: i,
      end: endIdx,
      raw: out,
      value: out,
      params: [],
      svelteScript: false,
    });
  }
  return endIdx;
}

/** 读模板字面量（i 指向反引号） */
function readJsTemplate(text, i, end, file, entries) {
  let j = i + 1;
  const chunks = [];
  const params = [];
  let cur = "";
  while (j < end) {
    const c = text[j];
    if (c === "\\") {
      const esc = text[j + 1];
      if (esc === "n") cur += "\n";
      else if (esc === "t") cur += "\t";
      else if (esc === "r") cur += "\r";
      else if (esc === "`") cur += "`";
      else if (esc === "$") cur += "$";
      else if (esc === "\\") cur += "\\";
      else cur += esc ?? "";
      j += 2;
      continue;
    }
    if (c === "`") { j++; break; }
    if (c === "$" && text[j + 1] === "{") {
      let depth = 1;
      let k = j + 2;
      while (k < end && depth > 0) {
        const ch = text[k];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        else if (ch === '"' || ch === "'" || ch === "`") {
          // 跳过嵌套字面量
          const q = ch;
          k++;
          while (k < end && text[k] !== q) {
            if (text[k] === "\\") k++;
            k++;
          }
        }
        if (depth > 0) k++;
      }
      const expr = text.slice(j + 2, k).trim();
      // round74（6b P1-1）：插值里可能还藏着中文字面量（如 `${n === 1 ? "次日" : `+${n} 天`}`）——
      // 旧实现只跳过嵌套字面量、不扫它 → 这类串永远进不了任何判据（验收的「0 残留」就是这么假的）。
      scanJs(text, j + 2, k, file, entries);
      let name = paramName(expr, `p${params.length + 1}`);
      while (params.some((p) => p.name === name)) name = `${name}2`;
      params.push({ name, expr });
      chunks.push(cur);
      chunks.push({ name, expr });
      cur = "";
      j = k + 1;
      continue;
    }
    cur += c;
    j++;
  }
  chunks.push(cur);
  const out = chunks.map((c) => (typeof c === "string" ? c : `{${c.name}}`)).join("");
  const rawDump = chunks.map((c) => (typeof c === "string" ? c : `\${${c.expr}}`)).join("");
  if (hasCjk(out) && !/^\[[a-z-]+\]/.test(out)) {
    addEntry(entries, file, text, {
      kind: "js-template",
      start: i,
      end: j,
      raw: rawDump,
      value: out,
      params,
      svelteScript: false,
    });
  }
  return j;
}

/** 扫一段 JS/TS（[start,end) 是绝对区间；跳过注释） */
export function scanJs(text, start, end, file, entries) {
  let i = start;
  while (i < end) {
    const c = text[i];
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) { i = skipJsComment(text, i, end); continue; }
    if (c === '"' || c === "'") { i = readJsString(text, i, end, file, entries); continue; }
    if (c === "`") { i = readJsTemplate(text, i, end, file, entries); continue; }
    if (c === "/" && isRegexStart(text, i)) { i = skipRegex(text, i, end); continue; }
    i++;
  }
}

// ------------------------------------------------------------------ Svelte

const ATTRS = new Set(["title", "placeholder", "aria-label", "alt"]);

function findTagEnd(text, i, end) {
  // i 指向 '<'；返回 '>' 后一位
  let j = i + 1;
  while (j < end) {
    const c = text[j];
    if (c === '"' || c === "'") { const q = c; j++; while (j < end && text[j] !== q) { if (text[j] === "\\") j++; j++; } }
    else if (c === "{") { j = skipBrace(text, j, end); continue; }
    else if (c === ">") return j + 1;
    j++;
  }
  return end;
}

function skipBrace(text, i, end) {
  // i 指向 '{'；返回 '}' 后一位
  let depth = 0;
  let j = i;
  while (j < end) {
    const c = text[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return j + 1; }
    else if (c === '"' || c === "'" || c === "`") {
      const q = c;
      j++;
      while (j < end && text[j] !== q) {
        if (text[j] === "\\") j++;
        j++;
      }
    }
    j++;
  }
  return end;
}

export function extractSvelte(text, file, entries, opts = {}) {
  // 1) script 块：交给 JS 扫描
  const scriptRe = /<script\b[^>]*>/g;
  let m;
  const scriptRanges = [];
  while ((m = scriptRe.exec(text))) {
    const open = m.index + m[0].length;
    const close = text.indexOf("</script>", open);
    if (close < 0) break;
    scriptRanges.push([open, close]);
    scanJs(text, open, close, file, entries);
    scriptRe.lastIndex = close + 9;
  }

  // 2) style 块区间（跳过）
  const styleRanges = [];
  const styleRe = /<style\b[^>]*>/g;
  while ((m = styleRe.exec(text))) {
    const open = m.index + m[0].length;
    const close = text.indexOf("</style>", open);
    if (close < 0) break;
    styleRanges.push([open, close]);
    styleRe.lastIndex = close + 8;
  }
  const inSkip = (off) => scriptRanges.find(([a, b]) => off >= a && off < b) || styleRanges.find(([a, b]) => off >= a && off < b);

  // 3) 标记：标签内 = 属性；标签外 = 文本**串**（文本 + 插值合并成一条消息）
  let i = 0;
  const n = text.length;
  let runStart = 0;
  let runEnd = 0;
  const parts = []; // { kind: 'text'|'expr', start, end, text?, expr?, name? }

  const flushRun = () => {
    const textParts = parts.filter((p) => p.kind === "text");
    if (parts.length > 0 && textParts.some((p) => hasCjk(p.text))) {
      // 修掉首尾空白
      let start = runStart;
      let end = runEnd;
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      const trimmedParts = parts.slice();
      if (trimmedParts.length && trimmedParts[0].kind === "text") {
        trimmedParts[0] = { ...trimmedParts[0], text: trimmedParts[0].text.replace(/^\s+/, "") };
      }
      if (trimmedParts.length && trimmedParts[trimmedParts.length - 1].kind === "text") {
        const last = trimmedParts.length - 1;
        trimmedParts[last] = { ...trimmedParts[last], text: trimmedParts[last].text.replace(/\s+$/, "") };
      }
      const params = [];
      let value = "";
      trimmedParts.forEach((p, idx) => {
        if (p.kind === "text") {
          let s = p.text.replace(/\s+/g, " ");
          if (idx === 0) s = s.replace(/^\s+/, "");
          if (idx === trimmedParts.length - 1) s = s.replace(/\s+$/, "");
          value += s;
        } else {
          let name = paramName(p.expr, `p${params.length + 1}`);
          while (params.some((x) => x.name === name)) name = `${name}2`;
          params.push({ name, expr: p.expr });
          value += `{${name}}`;
        }
      });
      value = value.trim();
      const raw = text.slice(start, end);
      addEntry(entries, file, text, {
        kind: "svelte-text",
        start,
        end,
        raw,
        value,
        params,
      });
    }
    parts.length = 0;
  };

  const openRun = (at) => {
    if (parts.length === 0) runStart = at;
    runEnd = at;
  };

  while (i < n) {
    const skip = inSkip(i);
    if (skip) {
      flushRun();
      i = skip[1];
      continue;
    }
    const c = text[i];
    if (c === "<") {
      flushRun();
      if (text.startsWith("<!--", i)) {
        const close = text.indexOf("-->", i);
        i = close < 0 ? n : close + 3;
        continue;
      }
      const tagEnd = findTagEnd(text, i, n);
      scanAttrs(text, i, tagEnd, file, entries);
      i = tagEnd;
      continue;
    }
    if (c === "{") {
      const marker = text[i + 1];
      const bEnd = skipBrace(text, i, n);
      if (marker === "#" || marker === "/" || marker === ":" || marker === "@") {
        flushRun();
        scanJs(text, i + 1, bEnd - 1, file, entries);
        i = bEnd;
        continue;
      }
      // 插值：进当前文本串
      openRun(i);
      const expr = text.slice(i + 1, bEnd - 1).trim();
      parts.push({ kind: "expr", start: i, end: bEnd, expr });
      runEnd = bEnd;
      // 检查模式：插值表达式里可能还藏着中文字面量（如三元 `{a ? "收起" : "展开"}`）——
      // 迁移时**不**扫它（与外层文本串重叠），收尾检查时扫（scanExpr）
      if (opts.scanExpr) scanJs(text, i + 1, bEnd - 1, file, entries);
      i = bEnd;
      continue;
    }
    // 普通文本
    openRun(i);
    const nextSpecial = (() => {
      for (let j = i; j < n; j++) if (text[j] === "<" || text[j] === "{") return j;
      return n;
    })();
    parts.push({ kind: "text", start: i, end: nextSpecial, text: text.slice(i, nextSpecial) });
    runEnd = nextSpecial;
    i = nextSpecial;
  }
  flushRun();
}

function splitAttrParts(text, start, end) {
  const parts = [];
  let i = start;
  let textStart = start;
  while (i < end) {
    if (text[i] === "{") {
      if (i > textStart) parts.push({ kind: "text", text: text.slice(textStart, i) });
      const bEnd = skipBrace(text, i, end);
      parts.push({ kind: "expr", expr: text.slice(i + 1, bEnd - 1).trim() });
      i = bEnd;
      textStart = bEnd;
      continue;
    }
    i++;
  }
  if (end > textStart) parts.push({ kind: "text", text: text.slice(textStart, end) });
  return parts;
}

function scanAttrs(text, tagStart, tagEnd, file, entries) {
  // 在 <tag ...> 里找 ATTRS 与 title 之类的值
  let i = tagStart + 1;
  // 跳过标签名
  while (i < tagEnd && /[A-Za-z0-9:-]/.test(text[i])) i++;
  while (i < tagEnd) {
    while (i < tagEnd && /\s/.test(text[i])) i++;
    if (i >= tagEnd) break;
    if (text[i] === ">" ) break;
    if (text[i] === "/" && text[i + 1] === ">") break;
    const nameM = /^[A-Za-z_:][-\w:.]*/.exec(text.slice(i, tagEnd));
    if (!nameM) { i++; continue; }
    const name = nameM[0];
    i += name.length;
    while (i < tagEnd && /\s/.test(text[i])) i++;
    if (text[i] === "=") {
      i++;
      while (i < tagEnd && /\s/.test(text[i])) i++;
      if (ATTRS.has(name)) {
        const c = text[i];
        if (c === '"' || c === "'") {
          const q = c;
          const close = text.indexOf(q, i + 1);
          const vEnd = close < 0 ? tagEnd : close;
          const raw = text.slice(i + 1, vEnd);
          // 引号值里可以有 `{expr}` 插值（如 title="{c.count} 个任务在用"）—— 拆成文本/表达式
          if (hasCjk(raw)) {
            const parts = splitAttrParts(text, i + 1, vEnd);
            const params = [];
            let value = "";
            parts.forEach((p, idx) => {
              if (p.kind === "text") {
                let s = decodeEntities(p.text).replace(/\s+/g, " ");
                if (idx === 0) s = s.replace(/^\s+/, "");
                if (idx === parts.length - 1) s = s.replace(/\s+$/, "");
                value += s;
              } else {
                let pn = paramName(p.expr, `p${params.length + 1}`);
                while (params.some((x) => x.name === pn)) pn = `${pn}2`;
                params.push({ name: pn, expr: p.expr });
                value += `{${pn}}`;
              }
            });
            addEntry(entries, file, text, {
              kind: "svelte-attr",
              start: i,
              end: vEnd + 1,
              attrStart: i,
              raw,
              value: value.trim(),
              params,
              attr: name,
            });
          }
          i = vEnd + 1;
          continue;
        }
        if (c === "{") {
          const bEnd = skipBrace(text, i, tagEnd);
          scanJs(text, i + 1, bEnd - 1, file, entries);
          i = bEnd;
          continue;
        }
      } else {
        // 其它属性的值也要跳过（避免把内部中文当标签名）
        const c = text[i];
        if (c === '"' || c === "'") { const q = c; const close = text.indexOf(q, i + 1); i = close < 0 ? tagEnd : close + 1; continue; }
        if (c === "{") { i = skipBrace(text, i, tagEnd); continue; }
      }
    }
  }
}

// ------------------------------------------------------------------ Rust

function skipRustBlockComment(text, i, end) {
  let depth = 1;
  let j = i + 2;
  while (j < end && depth > 0) {
    if (text.startsWith("/*", j)) { depth++; j += 2; continue; }
    if (text.startsWith("*/", j)) { depth--; j += 2; continue; }
    j++;
  }
  return j;
}

function skipRustItemAfterAttr(text, i, end) {
  // i 指向 #[cfg(test)]；跳过它修饰的那一项
  let j = i;
  // 跳过所有 #[...]/#![...] 属性
  while (j < end && text[j] === "#") {
    const open = text.indexOf("[", j);
    if (open < 0 || open > end) return end;
    let depth = 0;
    let k = open;
    while (k < end) {
      if (text[k] === "[") depth++;
      else if (text[k] === "]") { depth--; if (depth === 0) { k++; break; } }
      k++;
    }
    j = k;
    while (j < end && /\s/.test(text[j])) j++;
  }
  // 现在 j 指向 item 开头：跳过到它的 { } 或 ;
  while (j < end) {
    const c = text[j];
    if (c === '"' ) { j = readRustStringRaw(text, j, end); continue; }
    if (c === "{") { j = skipBrace(text, j, end); return j; }
    if (c === ";") return j + 1;
    j++;
  }
  return end;
}

function readRustStringRaw(text, i, end) {
  let j = i + 1;
  while (j < end) {
    if (text[j] === "\\") { j += 2; continue; }
    if (text[j] === '"') return j + 1;
    j++;
  }
  return end;
}

export function matchParen(text, i, end) {
  // i 指向 '('；返回 ')' 后一位
  let depth = 0;
  let j = i;
  while (j < end) {
    const c = text[j];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return j + 1; }
    else if (c === "r" && (text[j + 1] === '"' || text[j + 1] === "#")) {
      // 原始字符串（r"…" / r#"…"#）—— 内部可以带引号（XML/SQL），必须优先跳过
      const m = /^r(#*)"([\s\S]*?)"\1/.exec(text.slice(j));
      if (m) { j += m[0].length; continue; }
      j++;
    }
    else if (c === '"') { j = readRustStringRaw(text, j, end); continue; }
    else if (c === "/" && text[j + 1] === "/") { const nl = text.indexOf("\n", j); j = nl < 0 ? end : nl; continue; }
    else if (c === "/" && text[j + 1] === "*") { j = skipRustBlockComment(text, j, end); continue; }
    j++;
  }
  return end;
}

/** 日志宏（eprintln! 等）的区间 —— 这些串**不进界面**（《文案审计》口径：日志不算文案） */
function rustLogRanges(text) {
  const ranges = [];
  const re = /\b(?:eprintln|println|eprint|print|dbg)\s*!\(/g;
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf("(", m.index);
    const end = matchParen(text, open, text.length);
    ranges.push([m.index, end]);
    re.lastIndex = end;
  }
  return ranges;
}

function readRustString(text, i, end, file, entries, inLog) {
  let j = i + 1;
  let out = "";
  while (j < end) {
    const c = text[j];
    if (c === "\\") {
      const esc = text[j + 1];
      if (esc === "n") out += "\n";
      else if (esc === "t") out += "\t";
      else if (esc === "r") out += "\r";
      else if (esc === "0") out += "\0";
      else if (esc === "x") { out += String.fromCharCode(parseInt(text.slice(j + 2, j + 4), 16)); j += 4; continue; }
      else if (esc === "u") {
        if (text[j + 2] === "{") {
          const close = text.indexOf("}", j + 3);
          out += String.fromCodePoint(parseInt(text.slice(j + 3, close), 16));
          j = close + 1;
          continue;
        }
      } else out += esc ?? "";
      j += 2;
      continue;
    }
    if (c === '"') { j++; break; }
    out += c;
    j++;
  }
  if (hasCjk(out) && !/^\[[a-z-]+\]/.test(out) && !inLog(i)) {
    const { value, params } = normalizeFormat(out);
    addEntry(entries, file, text, {
      kind: "rs-literal",
      start: i,
      end: j,
      raw: out,
      value,
      params,
      formatBraces: /\{\w*:?[^}]*\}/.test(out),
    });
  }
  return j;
}

/** Rust format! 字符串 → 消息值：{name} 保留；{} / {0} 命名 p1..pN；{{ }} 转义 */
export function normalizeFormat(s) {
  const params = [];
  let pos = 0;
  const value = s.replace(/\{\{|\}\}|\{(\w*)(?::[^}]*)?\}/g, (m, name) => {
    if (m === "{{") return "{{";
    if (m === "}}") return "}}";
    const sp = m.includes(":") ? m.slice(m.indexOf(":"), -1) : "";
    if (name === "" || /^\d+$/.test(name)) {
      pos++;
      const n = `p${pos}`;
      params.push({ name: n, expr: null, positional: true, spec: sp });
      return `{${n}}`;
    }
    if (!params.some((p) => p.name === name)) params.push({ name, expr: null, spec: sp });
    return `{${name}}`;
  });
  return { value, params };
}

export function scanRust(text, file, entries) {
  let i = 0;
  const n = text.length;
  const logRanges = rustLogRanges(text);
  const inLog = (off) => logRanges.some(([a, b]) => off >= a && off < b);
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { const nl = text.indexOf("\n", i); i = nl < 0 ? n : nl; continue; }
    if (c === "/" && text[i + 1] === "*") { i = skipRustBlockComment(text, i, n); continue; }
    if (text.startsWith("#[cfg(", i)) {
      const close = text.indexOf("]", i);
      if (close > 0 && /\btest\b/.test(text.slice(i, close))) { i = skipRustItemAfterAttr(text, i, n); continue; }
    }
    if (text.startsWith("#[cfg(test)]", i)) { i = skipRustItemAfterAttr(text, i, n); continue; }
    if (c === "r" && (text[i + 1] === '"' || text[i + 1] === "#")) {
      // 原始字符串 r"..." / r#"..."#
      const m = /^r(#*)"([\s\S]*?)"\1/.exec(text.slice(i));
      if (m) {
        const raw = m[2];
        if (hasCjk(raw) && !/^\[[a-z-]+\]/.test(raw)) {
          const { value, params } = normalizeFormat(raw);
          addEntry(entries, file, text, { kind: "rs-literal", start: i, end: i + m[0].length, raw, value, params, rawString: true });
        }
        i += m[0].length;
        continue;
      }
    }
    if (c === '"') { i = readRustString(text, i, n, file, entries, inLog); continue; }
    if (c === "'") {
      // 字符字面量 'x' / '\n' / 生命周期 'a
      if (text[i + 2] === "'") { i += 3; continue; }
      if (text[i + 1] === "\\") { const close = text.indexOf("'", i + 2); i = close < 0 ? i + 1 : close + 1; continue; }
      i++;
      continue;
    }
    i++;
  }
}

// ------------------------------------------------------------------ 入口

const SKIP_DIR = new Set(["node_modules", "dist", "target", ".git", "paraglide"]);

export function walkSource(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIR.has(name)) continue;
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) visit(full);
      else if (/\.(svelte|ts|rs)$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(full);
    }
  };
  visit(root);
  return out.sort();
}

export function extractFile(fullPath, relPath, opts = {}) {
  const text = readFileSync(fullPath, "utf8");
  const entries = [];
  if (relPath.endsWith(".svelte")) extractSvelte(text, relPath, entries, opts);
  else if (relPath.endsWith(".ts")) scanJs(text, 0, text.length, relPath, entries);
  else if (relPath.endsWith(".rs")) scanRust(text, relPath, entries);
  return { text, entries };
}

export function extractAll(repoRoot, opts = {}) {
  const all = [];
  for (const rel of ["src", "src-tauri/src"]) {
    for (const full of walkSource(path.join(repoRoot, rel))) {
      const relPath = path.relative(repoRoot, full).replace(/\\/g, "/");
      // 资源层自身不迁移（伪语言包装串不是用户文案）
      if (relPath.startsWith("src/lib/i18n/")) continue;
      const { entries } = extractFile(full, relPath, opts);
      for (const e of entries) all.push(e);
    }
  }
  all.sort((a, b) => (a.file === b.file ? a.start - b.start : a.file < b.file ? -1 : 1));
  return all;
}
