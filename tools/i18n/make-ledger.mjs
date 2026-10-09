// round73（3.0b₁）：由 `audit.json`（唯一机器台账）生成人看的**文案整改对照表**。
// 用法：node tools/i18n/make-ledger.mjs  →  docs/visual/文案整改对照表.md
//
// 注：本文档正文里含大量反引号；这里**不用模板字符串**拼（pi-lens 会把里面的 markdown 当代码解析 —— 已知误报，
// 但用字符串数组拼也更好读）。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function readJson(rel) {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, rel), "utf8"));
  } catch (e) {
    throw new Error("读不了 " + rel + "：" + e.message);
  }
}

const audit = readJson("tools/i18n/audit.json");

const rows = Object.entries(audit)
  .map(([k, v]) => ({ key: k.replace(/^changed:/, ""), ...v }))
  .sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.key < b.key ? -1 : 1));

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, "↵");

const lines = [
  "# 文案整改对照表（round73 · 3.0b₁）",
  "",
  "> **这份是什么**：本批**改了哪些话**的逐条台账（「改前 → 改后」，含出处规则）。",
  "> 机器源 = `tools/i18n/audit.json`（唯一事实源）；本文件由 `node tools/i18n/make-ledger.mjs` 生成。",
  "> 「留」的口径 = 《文案审计》§4 的「留」行 + 全量严过里**改不出具体理由（哪条 C#）**的条目（不为了显得勤快而滥改）。",
  "> 出处：`docs/visual/文案审计.md`（89 条并集）· `docs/素材库/文案规范调研.md`（C1–C14）· 你 2026-10-05 的两条批注（「得」要改 / 「全量严过，再严一点」）。",
  "",
  "## 0. 一句话",
  "",
  "共改 **" + rows.length + "** 条（一条 = 一个 key；一个审计条目可能覆盖多个 key，例如 D2「任务块不存在」13 处）。",
  "其中：**89 条并集**（A–H 组）+ **全量严过新发现**（编号里带 N / 严过2）+ 三个机器例外（占位重命名）。",
  "",
  "## 1. 逐条对照（按规则编号排序）",
  "",
  "| # | 规则 | key | 改前 | 改后 |",
  "| --- | --- | --- | --- | --- |",
];
rows.forEach((r, i) => {
  lines.push("| " + (i + 1) + " | " + r.rule + " | `" + r.key + "` | " + esc(r.from) + " | " + esc(r.to) + " |");
});
lines.push(
  "",
  "## 2. 不进本表的改动（不是「文案」）",
  "",
  "| 面 | 内容 | 为什么不在表里 |",
  "| --- | --- | --- |",
  "| 渲染（E1） | 成就面板：已点亮只显示描述，**条件行只留给未点亮** | 改的是「什么时候画」，字符串没动 |",
  "| 代码（B5） | 日头从 date-fns `EEE`（英文 `Mon`）改成消息层「周一…周日」（`msg.week.04–10`） | 原来没有可改的字符串（运行时拼的） |",
  "| 日志（16 条） | 前端 `console.error` 的 `[模块] …` 串**还原成源码字面量**（不进资源层） | 日志不是用户文案（《文案审计》口径） |",
  "| 测试期望 | 5 处 Rust + 4 处前端测试跟着新文案更新（断言的就是文案本身） | 测试代码 |",
  "| 布局（2 处） | 伪语言压力下修的溢出：设置 `.row` 的 `nowrap`、Backlog `.tools` 的 `flex: none` | CSS，不是文案 |",
  "",
  "## 3. 数字与例外（可复核）",
  "",
  "- 机器例外（`check.mjs` 的 `INTENTIONAL`）：`ui.review_panel.17/19`、`ui.timeline.11` —— 迁移时**占位重命名**（两个同名 `kind`/`span` 撞车），值随之变化。",
  "- 删除的 key：`msg.i18n.01`（资源层自身的伪语言包装串被误迁）+ `msg.blocks.01/02/03` 等 16 条日志键（还原成字面量）。",
  "- 未改但被机器扫到过的：`err.cmd_settings.14/19` 曾因值是 JSON 片段被判「花括号」违规 → 已在 C3/C6 改成人话（现在 0 违规）。",
  "- **成就分组去重**：98 行 `d(...)` 的组名只留 7 条语义键（`ach.group.*`）；这是外置的语义键设计，不是文案改动。",
  "",
);
writeFileSync(path.join(repoRoot, "docs/visual/文案整改对照表.md"), lines.join("\n"));
console.log("已写 docs/visual/文案整改对照表.md（" + rows.length + " 条）");
