// round73（3.0b₁）：**Rust 外置**（逐字不动）—— 把基线里的用户可见串搬进 messages/zh.json，
// 并把源里替换成 `i18n::t(i18n::msg::KEY)` / `tf!(i18n::msg::KEY, …)`（format! 的替代）。
//
// 纪律（plan §3.4）：这一阶段**不许改任何一个字**；键名 = <域>.<单元>.<NN>（成就用语义键 ach.<id>.name/.desc/.cond）。
// 用法：node tools/i18n/migrate-rust.mjs [--apply] [--only db]
//
// 踩过的坑（都写在这里，别再踩）：
// · `findTagEnd` 式的括号匹配必须能跳**原始字符串**（r#"…"#；XML 里有引号）—— matchParen 已修；
// · const/static 项里不能调 `t()` → 直接用生成的常量 `i18n::msg::KEY`；
// · crate root（lib.rs）不能 `use crate::i18n;`（与 `mod i18n;` 撞名）→ 用 `crate::tf!` + 模块名直接引用；
// · format! 的冒号格式（{:?} / {:02}）要还原成 `format!("{:?}", expr)`；
// · format! 参数表达式里的**内层**字面量本轮先跳过（外层整段替换后，下一轮自然变成简单字面量）。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAll, matchParen } from "./lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : "";

const GROUP_SLUG = {
  "入门": "intro",
  "一点点来": "steady",
  "功能探索": "explore",
  "日子": "days",
  "彩蛋": "easter",
  "传说": "legend",
  "集章": "stamps",
};

function domainOf(file) {
  if (file === "src-tauri/src/achievements.rs") return "ach";
  if (/src-tauri\/src\/(notify|tray|hint|hints|lib|hotkeys)/.test(file)) return "sys";
  return "err";
}
function unitOf(file) {
  const base = path.basename(file, ".rs");
  if (file.includes("/commands/")) return "cmd_" + base;
  if (file.includes("/notify/")) return "toast";
  if (file.includes("/tray/")) return "tray_" + base;
  return base;
}

const constName = (key) => key.toUpperCase().replace(/[^A-Z0-9]/g, "_");

// ---------------------------------------------------------------- 解析小工具

/** 顶层逗号切分（尊重 () [] {} 与 "…" / r#"…"#）；返回 [{start,end}]（相对 base 的绝对偏移） */
function splitArgs(body, base) {
  const out = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"') {
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "r" && (body[i + 1] === '"' || body[i + 1] === "#")) {
      const m = /^r(#*)"([\s\S]*?)"\1/.exec(body.slice(i));
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push({ start: base + start, end: base + i });
      start = i + 1;
    }
    i++;
  }
  out.push({ start: base + start, end: base + body.length });
  return out;
}

const argText = (text, a) => text.slice(a.start, a.end).trim();

/** 成就表：扫描每个 `d("id", …)` 调用（返回参数范围） */
function parseAchievementRows(text) {
  const out = [];
  let idx = 0;
  while ((idx = text.indexOf('d("', idx)) >= 0) {
    const open = idx + 1;
    const end = matchParen(text, open, text.length);
    const argsList = splitArgs(text.slice(open + 1, end - 1), open + 1);
    const id = argsList[0] ? argText(text, argsList[0]).replace(/^"|"$/g, "") : "";
    if (id && /^[a-z0-9_]+$/.test(id) && argsList.length >= 9) out.push({ start: open, end, args: argsList, id });
    idx = end;
  }
  return out;
}

/** 这条字面量是在 const/static 项里吗？（那就不允许调 t()，要用生成的常量） */
function isConstContext(text, at) {
  let depth = 0;
  let stmtStart = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth > 0) depth--;
      else if (c === "{") {
        stmtStart = i + 1;
        break;
      }
    } else if (c === ";" && depth === 0) {
      stmtStart = i + 1;
      break;
    }
  }
  const cleaned = text
    .slice(stmtStart, at)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return /^\s*(pub(\([^)]*\))?\s+)?(const|static)\b/.test(cleaned);
}

function findEnclosingFormat(text, at) {
  let idx = text.lastIndexOf("format!(", at);
  while (idx >= 0) {
    const open = idx + "format!".length;
    const end = matchParen(text, open, text.length);
    if (at > open && at < end) return { start: idx, open, end };
    idx = text.lastIndexOf("format!(", idx - 1);
  }
  return null;
}

function insertUse(text, decl) {
  // 只认**顶层**（大括号深度 0）的 use —— 测试模块里的 use 在深度 > 0，别插进去（踩过）
  let depth = 0;
  let lastEnd = -1;
  let i = 0;
  let lineStart = true;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      lineStart = true;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
      lineStart = false;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      lineStart = false;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "{") {
      depth++;
      i++;
      lineStart = false;
      continue;
    }
    if (c === "}") {
      depth = Math.max(0, depth - 1);
      i++;
      lineStart = false;
      continue;
    }
    if (lineStart && depth === 0 && /^(pub\s+)?use\b/.test(text.slice(i))) {
      const semi = text.indexOf(";", i);
      if (semi > 0) {
        lastEnd = semi + 1;
        i = semi + 1;
        lineStart = false;
        continue;
      }
    }
    lineStart = false;
    i++;
  }
  if (lastEnd >= 0) return text.slice(0, lastEnd) + "\n" + decl + text.slice(lastEnd);
  const lines = text.split("\n");
  let k = 0;
  while (k < lines.length && (lines[k].startsWith("//!") || lines[k].trim() === "")) k++;
  lines.splice(k, 0, decl, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------- 读取 + 键

const entries = extractAll(repoRoot).filter(
  (e) =>
    e.file.endsWith(".rs") &&
    e.file !== "src-tauri/src/i18n.rs" && // 资源层自身不迁移
    (!only || e.file.includes(only)),
);
if (only) console.log(`--only ${only}：${entries.length} 条`);

const msgPath = path.join(repoRoot, "messages/zh.json");
let messages;
try {
  messages = JSON.parse(readFileSync(msgPath, "utf8"));
} catch (e) {
  throw new Error(`读不了 ${msgPath}：${e.message}`);
}
const counters = {};
for (const k of Object.keys(messages)) {
  const m = /^(.*)\.(\d+)$/.exec(k);
  if (m) counters[m[1]] = Math.max(counters[m[1]] || 0, Number(m[2]));
}

const byFile = new Map();
for (const e of entries) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

let changed = 0;
let replaced = 0;
const map = [];

for (const [file, list] of byFile) {
  const full = path.join(repoRoot, file);
  let text = readFileSync(full, "utf8");
  const isCrateRoot = file === "src-tauri/src/lib.rs";
  const achRows = file.endsWith("achievements.rs") ? parseAchievementRows(text) : [];
  const consumed = [];
  const need = { i18n: false, tf: false };

  const sorted = [...list].sort((a, b) => a.start - b.start);
  const planned = [];
  for (const e of sorted) {
    // 成就表的 4 个文本字段？
    const row = achRows.find((r) => e.start > r.start && e.start < r.end);
    const argIdx = row ? row.args.findIndex((a) => e.start >= a.start && e.start < a.end) : -1;
    if (row && argIdx >= 1) {
      const field = { 1: "name", 2: "desc", 3: "cond", 7: "group" }[argIdx];
      if (field === "group") {
        const slug = GROUP_SLUG[e.value] ?? "misc";
        const key = `ach.group.${slug}`;
        messages[key] = e.value;
        planned.push({ e, key, constName: `ACH_GROUP_${slug.toUpperCase()}`, mode: "const" });
        need.i18n = true;
        continue;
      }
      if (field) {
        const key = `ach.${row.id}.${field}`;
        messages[key] = e.value;
        planned.push({ e, key, constName: `ACH_${constName(row.id)}_${field.toUpperCase()}`, mode: "const" });
        need.i18n = true;
        continue;
      }
    }

    const base = `${domainOf(file)}.${unitOf(file)}`;
    counters[base] = (counters[base] || 0) + 1;
    const key = `${base}.${String(counters[base]).padStart(2, "0")}`;

    if (isConstContext(text, e.start)) {
      messages[key] = e.value;
      planned.push({ e, key, mode: "const" });
      need.i18n = true;
      continue;
    }

    const fmt = findEnclosingFormat(text, e.start);
    if (fmt) {
      const first = splitArgs(text.slice(fmt.open + 1, fmt.end - 1), fmt.open + 1)[0];
      const rawFirst = text.slice(first.start, first.end);
      const firstLitStart = first.start + rawFirst.search(/\S/);
      const isFirstArgEntry = sorted.some((x) => x.start === firstLitStart);
      if (e.start !== firstLitStart && isFirstArgEntry) {
        // 真·内层字面量（在**要换的那个** format! 的参数表达式里）→ 本轮不动
        counters[base] -= 1;
        continue;
      }
      if (e.start === firstLitStart) {
        messages[key] = e.value;
        planned.push({ e, key, mode: "format", fmt });
        need.tf = true;
        need.i18n = true;
        continue;
      }
      // 外层 format! 的第一参数不是我们的条目（如 "{}{}{}"）→ 按普通字面量换（format! 保留）
      messages[key] = e.value;
      planned.push({ e, key, mode: "simple" });
      need.i18n = true;
      continue;
    }
    messages[key] = e.value;
    planned.push({ e, key, mode: "simple" });
    need.i18n = true;
  }

  for (const p of planned.sort((a, b) => b.e.start - a.e.start)) {
    if (consumed.some(([s, en]) => p.e.start >= s && p.e.start < en)) continue;
    if (p.mode === "const") {
      const ref = isCrateRoot ? `i18n::msg::${p.constName ?? constName(p.key)}` : `i18n::msg::${p.constName ?? constName(p.key)}`;
      text = text.slice(0, p.e.start) + ref + text.slice(p.e.end);
      consumed.push([p.e.start, p.e.end]);
    } else if (p.mode === "simple") {
      text = text.slice(0, p.e.start) + `i18n::t(i18n::msg::${constName(p.key)})` + text.slice(p.e.end);
      consumed.push([p.e.start, p.e.end]);
    } else {
      const call = buildTfCall(text, p, isCrateRoot);
      text = text.slice(0, p.fmt.start) + call + text.slice(p.fmt.end);
      consumed.push([p.fmt.start, p.fmt.end]);
    }
    replaced++;
    map.push({ key: p.key, file, line: p.e.line, kind: p.e.kind, raw: p.e.raw, value: p.e.value, mode: p.mode });
  }

  if (need.i18n && !isCrateRoot && !/use crate::i18n;/.test(text)) text = insertUse(text, "use crate::i18n;");
  if (need.tf && !isCrateRoot && !/use crate::tf;/.test(text)) text = insertUse(text, "use crate::tf;");

  changed++;
  if (apply) writeFileSync(full, text);
  console.log(`${apply ? "改" : "将改"} ${file}（${list.length} 条）`);
}

function buildTfCall(text, p, isCrateRoot) {
  const { fmt, e, key } = p;
  const body = text.slice(fmt.open + 1, fmt.end - 1);
  const argList = splitArgs(body, fmt.open + 1).map((a) => argText(text, a));
  const first = argList[0];
  const rest = argList.slice(1);
  const named = {};
  const positional = [];
  for (const a of rest) {
    const m = /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(a);
    if (m) named[m[1]] = m[2];
    else positional.push(a);
  }
  const parts = [];
  for (const param of e.params ?? []) {
    let expr;
    if (param.positional) {
      const n = Number(param.name.slice(1)) - 1;
      expr = positional[n];
      if (!expr) throw new Error(`${e.file}:${e.line} 找不到第 ${n + 1} 个位置参数`);
    } else {
      expr = named[param.name] ?? param.name;
    }
    if (param.spec) expr = `format!("{${param.spec}}", ${expr})`;
    parts.push(`${param.name} = ${expr}`);
  }
  void first;
  const macro = isCrateRoot ? "crate::tf!" : "tf!";
  return `${macro}(i18n::msg::${constName(key)}${parts.length ? ", " + parts.join(", ") : ""})`;
}

if (apply) {
  writeFileSync(msgPath, JSON.stringify(messages, null, 2) + "\n");
  const mapPath = path.join(repoRoot, "tools/i18n/map-rust.json");
  let prev = [];
  try {
    prev = JSON.parse(readFileSync(mapPath, "utf8"));
  } catch {
    prev = [];
  }
  const upd = new Map(prev.map((r) => [r.key, r]));
  for (const r of map) upd.set(r.key, r);
  writeFileSync(mapPath, JSON.stringify([...upd.values()], null, 1));
}

console.log(`\n${apply ? "已改" : "计划改"} ${changed} 个文件 / ${replaced} 处；messages 共 ${Object.keys(messages).length} 条`);
if (!apply) console.log("（干跑；加 --apply 落地）");
