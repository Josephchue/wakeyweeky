// round74（3.0b₂）：生成 `docs/visual/英文对照表.md` —— 人看的**全量 zh → en 对照**
// （机器源 = messages/zh.json + tools/i18n/en-values/*.json + en-overrides.json；
//   3.4 二次审查时重跑这一个脚本即可刷新）
//
// 用法：node tools/i18n/make-en-ledger.mjs
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEn, loadOverrides, loadValues } from "./en-build.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const P = (rel) => path.join(repoRoot, rel);
const readJson = (rel, fallback) => {
  if (!existsSync(P(rel))) return fallback;
  try {
    return JSON.parse(readFileSync(P(rel), "utf8"));
  } catch (e) {
    throw new Error(`读不了 ${rel}：${e.message}`);
  }
};

const zh = readJson("messages/zh.json", {});
const audit = readJson("tools/i18n/audit.json", {});
const { en, missing } = buildEn(zh, loadValues(), loadOverrides());
const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, "\\n");
const plural = (key) => (en[`${key}.one`] !== undefined ? `${en[`${key}.one`]} / ${en[`${key}.other`]}` : undefined);

const DOMAINS = [
  ["sys", "系统 / 通知 / 托盘"],
  ["ui", "界面"],
  ["msg", "提示 / 状态 / 键位表"],
  ["help", "说明页"],
  ["err", "错误 / 事件名"],
  ["ach", "成就（暗章）"],
];

const out = [];
out.push("# 英文对照表（WakeyWeeky 0.23.0 · 3.0b₂）");
out.push("");
out.push("> **机器生成，不要手改** —— 源：`messages/zh.json` + `tools/i18n/en-values/*.json` + `en-overrides.json`；");
out.push("> 重跑：`node tools/i18n/make-en-ledger.mjs`。键顺序 = `messages/zh.json` 的键顺序。");
out.push("");
out.push(`- 中文键 **${Object.keys(zh).length}** · 英文键 **${Object.keys(en).length}**（复数展开成 \`.one\`/\`.other\`）· 缺 **${missing.length}**`);
out.push("- 复数：英文一侧显示 `one / other`；中文没有单复数（调用点走 `tn()`）");
out.push("- 把英文翻错/别扭的地方告诉我：**说 key + 中文 + 你想要的英文**，我改 `en-values` 后 `--emit` 重生成");
out.push("");

// 中文侧顺带改动（片段整句化改过的值）
const changedZh = Object.entries(audit)
  .filter(([, rec]) => rec.rule === "round74片段整句化")
  .map(([id]) => id.replace(/^changed:/, ""));
if (changedZh.length) {
  out.push("## 中文侧顺带改动（片段整句化）");
  out.push("");
  out.push("这些中文在 3.0b₂ 里改过（把「：」续写片段并成整句），是为了英文能说完整句；");
  out.push("逐条看：`docs/visual/文案整改对照表.html` 与 `tools/i18n/audit.json`（`rule=\"round74片段整句化\"`）。");
  out.push("");
  out.push("| key | 现在的中文 | English |");
  out.push("| --- | --- | --- |");
  for (const key of changedZh) {
    if (zh[key] === undefined) continue;
    out.push(`| \`${key}\` | ${esc(zh[key])} | ${esc(plural(key) ?? en[key] ?? "（缺）")} |`);
  }
  out.push("");
}

for (const [domain, title] of DOMAINS) {
  const keys = Object.keys(zh).filter((k) => k.startsWith(`${domain}.`));
  out.push(`## ${title}（\`${domain}.\` · ${keys.length} 键）`);
  out.push("");
  out.push("| key | 中文 | English |");
  out.push("| --- | --- | --- |");
  for (const key of keys) {
    out.push(`| \`${key}\` | ${esc(zh[key])} | ${esc(plural(key) ?? en[key] ?? "（缺）")} |`);
  }
  out.push("");
}

writeFileSync(P("docs/visual/英文对照表.md"), out.join("\n"));
console.log(`已写 docs/visual/英文对照表.md（${out.length} 行，${Object.keys(en).length} 个英文键）`);
