// round87（1.0.0 · 3.3「对账机制化」）：**手测手册的 `机器✓` ↔ `checks.js` 断言名对账**。
//
// 为什么有它：手册里标 `机器✓` 的行 = 「已被预览断言盖住，你可以跳过」。断言**改名 / 删掉**之后，
// 没人会记得回去改手册（今天靠人记）—— 这条对账把这种漂移变成红灯。
//
// 口径（Step 6c，用户已拍「机制化」，实现时把粒度定成**节级**）：
//   手册末尾附录表 A 逐**节**列出「覆盖该节 `机器✓` 行的断言名前缀」；
//   两条**硬判据**：① 每个含 `机器✓` 行的节在表里有条目；② 表里写的断言前缀**真能在 `checks.js` 里找到**。
//   其余（某条断言没被任何节引用、前缀匹配多条）**只列报告、不硬红** —— 守「自证工具的判据不许比产品需求更严」。
//
// ⚠️ 为什么是**节级**而不是行级（原计划的字面口径）：行级要给 110 行逐条人工推断「是哪条断言盖的」——
// 没有证据支撑 = 假精确（写错还会让工具变成摆设）。节级能抓的是真漂移（断言没了 / 改名了），
// 代价是复查时以节为单位看（工具的 `--list` 会把每节的机器✓行一并列出来，人工一眼扫）。
//
// 用法：
//   node tools/preview/manual-audit.mjs          # 跑两条硬判据（进闸门）
//   node tools/preview/manual-audit.mjs --list   # 把每节的 `机器✓` 行一并列出来（人工复查用）
//   node tools/preview/manual-audit.mjs --only-manual  # 输出「只剩手测」的清单（markdown 表，贴回手册 §B）
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const P = (rel) => path.join(repoRoot, rel);
const MANUAL = "docs/验收/手测手册.md";
const CHECKS = "tools/preview/checks.js";
const list = process.argv.includes("--list");

const manual = readFileSync(P(MANUAL), "utf8");
const checks = readFileSync(P(CHECKS), "utf8");
const onlyManual = process.argv.includes("--only-manual");

// ---------------------------------------------------------------- 1 读手册：每节里的 `机器✓` 行
/** @type {{ no: string, title: string, rows: string[] }[]} */
const sections = [];
let cur = null;
for (const line of manual.split(/\r?\n/)) {
  const h = line.match(/^##\s+(\S+)\.?\s*(.*)$/);
  if (h) {
    cur = { no: h[1].replace(/\.$/, ""), title: (h[2] ?? "").trim(), rows: [] };
    sections.push(cur);
    continue;
  }
  if (!cur) continue;
  if (line.includes("机器✓")) {
    const m = line.match(/^\|\s*([0-9]+\.[0-9]+)\s*\|/);
    if (m) cur.rows.push(m[1]);
  }
}

// ---------------------------------------------------------------- 1.5 `--only-manual`：只剩手测的清单
if (onlyManual) {
  const out = [];
  let sec = "";
  let inAppendix = false;
  for (const line of manual.split(/\r?\n/)) {
    const h = line.match(/^##\s+(\S+)\.?\s*(.*)$/);
    if (h) {
      sec = (h[2] ?? "").trim();
      // ⚠️ 必须跳过 §A/§B 自己 —— 不然重跑时会把上一版 §B 的行再收一遍（实测 76 → 154）
      inAppendix = /^[AB]\./.test(h[1]);
      continue;
    }
    if (inAppendix) continue;
    const m = line.match(/^\|\s*([0-9]+\.[0-9]+)\s*\|(.*)\|(.*)\|\s*([^|]*)\|\s*$/);
    if (!m) continue;
    if (m[4].includes("机器✓")) continue;
    out.push(`| ${m[1]} | ${sec} | ${m[2].trim()} | ${m[3].trim()} |`);
  }
  console.log(`| # | 区 | 做什么 | 期望 |`);
  console.log(`| --- | --- | --- | --- |`);
  for (const l of out) console.log(l);
  process.exit(0);
}

// ---------------------------------------------------------------- 2 读附录表：节 → 断言前缀
const APPENDIX_RE = /^##\s+A\.\s*机器✓/m;
const appendix = new Map();
{
  const start = manual.search(APPENDIX_RE);
  if (start < 0) {
    console.error(`❌ 手册里找不到附录 A（标题要以「## A. 机器✓」开头）：${MANUAL}`);
    process.exit(1);
  }
  const rest = manual.slice(start);
  for (const line of rest.split(/\r?\n/)) {
    const cells = line.split("|").map((s) => s.trim());
    // | 节 | 覆盖它的断言前缀 |  →  split 后首尾是空串
    if (cells.length < 4) continue;
    const key = cells[1];
    const value = cells[2];
    if (!/^\d+$/.test(key)) continue;
    appendix.set(key, (value ?? "").split(/[·、,，]/).map((s) => s.trim()).filter(Boolean));
  }
}

// ---------------------------------------------------------------- 3 读 checks.js：断言名
// 两种写法都要认（2026-10-09 · 6b 复核 P1）—— 以前只认 `", async` 一种，14 条**同步**断言
//（`["name", () => …]`）对它不可见 → 硬判据②会对那些节**假红**，漂移监控也失明。
const assertionNames = [
  ...checks.matchAll(/\[\s*"([^"]+)",\s*(?:async\s*)?(?:\(|function|\w+\s*=>)/g),
].map((m) => m[1]);

const failures = [];

// ---------------------------------------------------------------- 4.5 §B「只剩手测」清单新鲜度（6b 复核 P2）
// §B 是 `--only-manual` 的输出粘贴回手册的。手改过行（新标了机器✓ / 删了行）却没重跑 → 清单会静默过期。
// 判据：§B 表里的条目号集合必须与「现算的只剩手测」集合**逐项一致**。
{
  const bStart = manual.search(/^##\s+B\.\s/m);
  const bEnd = manual.search(/^##\s+(?![AB]\.)\S/m);
  const bSection = bStart < 0 ? "" : manual.slice(bStart, bEnd > bStart ? bEnd : undefined);
  const bIds = new Set([...bSection.matchAll(/^\|\s*([0-9]+\.[0-9]+)\s*\|/gm)].map((m) => m[1]));
  const expected = new Set();
  {
    let sec = "";
    for (const line of manual.split(/\r?\n/)) {
      if (/^##\s/.test(line)) {
        sec = line;
        continue;
      }
      if (/^##\s+B\./.test(sec)) continue;
      const m = line.match(/^\|\s*([0-9]+\.[0-9]+)\s*\|(.*)\|(.*)\|\s*([^|]*)\|\s*$/);
      if (!m || m[4].includes("机器✓")) continue;
      expected.add(m[1]);
    }
  }
  if (bStart < 0) {
    console.log("  ℹ 手册里没有 §B（只剩手测清单）—— 跳过新鲜度判据");
  } else {
    const missing = [...expected].filter((x) => !bIds.has(x));
    const extra = [...bIds].filter((x) => !expected.has(x));
    if (missing.length || extra.length) {
      failures.push(`§B 过期：漏了 ${missing.length} 条（${missing.slice(0, 6).join(" ")}）、多了 ${extra.length} 条（${extra.slice(0, 6).join(" ")}）→ 重跑 --only-manual 贴回去`);
    }
  }
}

// ---------------------------------------------------------------- 5 两条硬判据 + 报告
const machineSections = sections.filter((s) => s.rows.length > 0);
// 反向（6b 复核 P1）：附录里写了、手册里**没有这一节** → 也是漂移（曾经：`| 21 | round87 |` 悬者）
for (const key of appendix.keys()) {
  if (!sections.some((s) => s.no === key)) {
    failures.push(`附录 A 里写了节 ${key}，但手册里没有这一节（节号写错？还是节被删了？）`);
  }
}
for (const s of machineSections) {
  if (!appendix.has(s.no)) {
    failures.push(`节 ${s.no}（${s.title.slice(0, 24)}）有 ${s.rows.length} 个机器✓ 行，但附录 A 里没有它的条目`);
    continue;
  }
  for (const prefix of appendix.get(s.no)) {
    if (!assertionNames.some((n) => n.startsWith(prefix))) {
      failures.push(`节 ${s.no} 写的断言前缀「${prefix}」在 checks.js 里找不到任何断言（改名了？删了？）`);
    }
  }
}
// 报告（不硬红）：哪些断言没被任何节引用
const referenced = [...appendix.values()].flat();
const orphan = assertionNames.filter((n) => !referenced.some((p) => n.startsWith(p)));

console.log(`# 手册对账（${MANUAL} ↔ ${CHECKS}）`);
console.log(`  手册：${sections.length} 节 · 含 机器✓ 的节 ${machineSections.length} 个 · 机器✓ 行 ${machineSections.reduce((a, s) => a + s.rows.length, 0)} 个`);
console.log(`  断言：${assertionNames.length} 条 · 附录引用前缀 ${referenced.length} 个 · 没被任何节引用的断言 ${orphan.length} 条（只报告）`);
if (list) {
  for (const s of machineSections) {
    console.log(`  · 节 ${s.no}（${s.title.slice(0, 30)}）：${s.rows.join(" ")} → [${(appendix.get(s.no) ?? []).join(" · ")}]`);
  }
  if (orphan.length) console.log(`  · 未被引用的断言（前 20）：${orphan.slice(0, 20).join(" ｜ ")}`);
}
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.error(`❌ 手册对账有 ${failures.length} 处对不上`);
  process.exit(1);
}
console.log("✓ 对账通过：每个含机器✓的节都有条目、每条前缀都能在 checks.js 找到");
