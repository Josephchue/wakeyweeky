// round73（3.0b₁）：**前端外置**（逐字不动）—— 把基线里的用户可见串搬进 messages/zh.json，
// 并把源里的字面量替换成 t("key") / {t("key", {...})}。
//
// 纪律（plan §3.4）：
//   · 这一阶段**不许改任何一个字**（值 = 原文；整改在下一步只改 JSON）。
//   · 键名 = <域>.<单元>.<NN>（域：ui / help / msg；单元 = 文件基名）。
//   · 每个文件改完立刻可 `npm run check`。
//
// 用法：
//   node tools/i18n/migrate-frontend.mjs              # 干跑：打印计划
//   node tools/i18n/migrate-frontend.mjs --apply      # 落地（写源码 + messages/zh.json + map.json）
//   node tools/i18n/migrate-frontend.mjs --apply --only backlog   # 只做文件名含 backlog 的
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAll } from "./lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : "";

// ---------------------------------------------------------------- 键名

function domainOf(file) {
  if (file === "src/App.svelte") return "ui";
  if (file.endsWith("HelpPanel.svelte")) return "help";
  if (file.startsWith("src/lib/components/")) return "ui";
  if (file.startsWith("src/")) return "msg";
  return "sys";
}

function unitOf(file) {
  const base = path.basename(file).replace(/\.(svelte|ts|rs)$/, "");
  if (file === "src/App.svelte") return "app";
  return base
    .replace(/\.svelte$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
}

const entries = extractAll(repoRoot).filter((e) => e.file.startsWith("src/"));
if (only) {
  const before = entries.length;
  for (const e of entries) if (!e.file.includes(only)) e.skip = true;
  console.log(`--only ${only}：${entries.filter((e) => !e.skip).length}/${before} 条`);
}

// 与已有 messages 合并（ui.__selftest 保留）
const msgPath = path.join(repoRoot, "messages/zh.json");
let messages;
try {
  messages = JSON.parse(readFileSync(msgPath, "utf8"));
} catch (e) {
  throw new Error(`读不了或解析不了 ${msgPath}：${e.message}（文案资源层是迁移必需品）`);
}

// 键计数器从已有 messages 续上（支持增量迁移：已经迁过的文件不再产生条目）
const counters = {};
for (const k of Object.keys(messages)) {
  const m = /^(.*)\.(\d+)$/.exec(k);
  if (m) counters[m[1]] = Math.max(counters[m[1]] || 0, Number(m[2]));
}
for (const e of entries) {
  if (e.skip) continue;
  const base = `${domainOf(e.file)}.${unitOf(e.file)}`;
  counters[base] = (counters[base] || 0) + 1;
  e.key = `${base}.${String(counters[base]).padStart(2, "0")}`;
}

for (const e of entries) {
  if (e.skip) continue;
  if (messages[e.key] !== undefined) throw new Error(`key 撞车：${e.key}`);
  messages[e.key] = e.value;
}

// ---------------------------------------------------------------- 改源码

function relImport(file) {
  const from = path.dirname(path.join(repoRoot, file));
  const to = path.join(repoRoot, "src/lib/i18n/i18n.ts");
  let rel = path.relative(from, to).replace(/\\/g, "/").replace(/\.ts$/, "");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

function callExpr(e) {
  const params = (e.params || []).map((p) => `${p.name}: ${p.expr}`).join(", ");
  return `t(${JSON.stringify(e.key)}${params ? `, { ${params} }` : ""})`;
}

function replacementFor(e) {
  switch (e.kind) {
    case "js-literal":
    case "js-template":
      return callExpr(e);
    case "svelte-text":
      return `{${callExpr(e)}}`;
    case "svelte-attr":
      return `{${callExpr(e)}}`;
    default:
      return null;
  }
}

const byFile = new Map();
for (const e of entries) {
  if (e.skip) continue;
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

let changedFiles = 0;
let replaced = 0;
for (const [file, list] of byFile) {
  const full = path.join(repoRoot, file);
  let text = readFileSync(full, "utf8");
  const sorted = [...list].sort((a, b) => b.start - a.start);
  for (const e of sorted) {
    const rep = replacementFor(e);
    if (rep === null) continue;
    text = text.slice(0, e.start) + rep + text.slice(e.end);
    replaced++;
  }
  // 插 import
  if (text.includes("import { t }") || text.includes("import {t}")) {
    // 已有（手改过的文件）→ 不动
  } else if (file.endsWith(".svelte")) {
    const re = /<script\b[^>]*>/g;
    let last = null;
    let m;
    while ((m = re.exec(text))) last = m;
    const imp = `import { t } from "${relImport(file)}";`;
    if (last) {
      const at = last.index + last[0].length;
      text = text.slice(0, at) + "\n  " + imp + text.slice(at);
    } else {
      text = `<script lang="ts">\n  ${imp}\n</script>\n\n` + text;
    }
  } else {
    const imp = `import { t } from "${relImport(file)}";`;
    const firstImport = text.search(/^import\s/m);
    if (firstImport >= 0) text = text.slice(0, firstImport) + imp + "\n" + text.slice(firstImport);
    else {
      // 放在开头注释块之后
      const m = text.match(/^(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\n|\s*\n)*/);
      const at = m ? m[0].length : 0;
      text = text.slice(0, at) + imp + "\n\n" + text.slice(at);
    }
  }
  changedFiles++;
  if (apply) writeFileSync(full, text);
  console.log(`${apply ? "改" : "将改"} ${file}（${list.length} 条）`);
}

if (apply) {
  writeFileSync(msgPath, JSON.stringify(messages, null, 2) + "\n");
  const mapPath = path.join(repoRoot, "tools/i18n/map-frontend.json");
  let prev = [];
  try {
    prev = JSON.parse(readFileSync(mapPath, "utf8"));
  } catch {
    prev = [];
  }
  const updated = new Map(prev.map((r) => [r.key, r]));
  for (const e of entries) {
    if (e.skip) continue;
    updated.set(e.key, { key: e.key, file: e.file, line: e.line, kind: e.kind, raw: e.raw, value: e.value });
  }
  writeFileSync(mapPath, JSON.stringify([...updated.values()], null, 1));
}

console.log(`\n${apply ? "已改" : "计划改"} ${changedFiles} 个文件 / ${replaced} 处；messages 共 ${Object.keys(messages).length} 条`);
if (!apply) console.log("（干跑；加 --apply 落地）");
