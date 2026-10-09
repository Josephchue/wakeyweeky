// round74（3.0b₂）：英文工作表工具。
//
// 用法：
//   node tools/i18n/en-worksheet.mjs --dump ui       # 打印 `ui.` 域里**还没翻**的唯一值（JSON 数组）
//   node tools/i18n/en-worksheet.mjs --report        # 覆盖率报告（按域）
//   node tools/i18n/en-worksheet.mjs --emit          # 用工作表重建 messages/en.json
// 数据：tools/i18n/en-values/*.json（按值翻译；同一句只翻一遍）
//       tools/i18n/en-overrides.json（按键例外：复数 one/other、同值不同译）
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEn, loadOverrides, loadValues, loadZh, placeholders } from "./en-build.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const P = (rel) => path.join(repoRoot, rel);

function readJson(rel, fallback) {
  const p = P(rel);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`读不了 ${rel}：${e.message}`);
  }
}

const args = process.argv.slice(2);
const zh = loadZh();

if (args.includes("--dump")) {
  const prefix = args[args.indexOf("--dump") + 1] ?? "";
  const values = loadValues();
  const out = [];
  for (const [key, v] of Object.entries(zh)) {
    if (!key.startsWith(prefix)) continue;
    if (values[v] !== undefined) continue;
    if (out.includes(v)) continue;
    out.push(v);
  }
  console.log(JSON.stringify(out, null, 1));
} else {
  const { en, missing } = buildEn(zh, loadValues(), loadOverrides());
  const domain = (k) => (k.includes(".") ? k.slice(0, k.indexOf(".")) : k);
  const total = {};
  const miss = {};
  for (const k of Object.keys(zh)) {
    total[domain(k)] = (total[domain(k)] ?? 0) + 1;
    if (missing.some((m) => m === k || m.startsWith(`${k}（`))) miss[domain(k)] = (miss[domain(k)] ?? 0) + 1;
  }
  console.log(`en ${Object.keys(en).length} 键 / zh ${Object.keys(zh).length} 键；缺 ${missing.length}`);
  for (const d of Object.keys(total)) console.log(`  ${d}: 缺 ${miss[d] ?? 0} / ${total[d]}`);

  if (args.includes("--emit")) {
    // 复数扩展键的排序：紧跟 base（buildEn 的插入顺序已经是 zh 键序）
    writeFileSync(P("messages/en.json"), JSON.stringify(en, null, 2) + "\n");
    console.log("已写 messages/en.json");
    if (missing.length) {
      console.log(`⚠ 还有 ${missing.length} 条没翻（先补工作表再加 --emit）`);
      process.exitCode = 1;
    }
  } else if (missing.length) {
    console.log(`（前 20 条缺：${missing.slice(0, 20).join(", ")}）`);
  }

  // 占位校验：en 与 zh 的 `{name}` 集合必须一致（复数键比对 base）
  const bad = [];
  for (const [key, v] of Object.entries(en)) {
    const base = key.replace(/\.(one|other)$/, "");
    if (zh[base] === undefined) {
      bad.push(`${key}（没有对应的中文 base）`);
      continue;
    }
    const a = [...placeholders(v)].sort().join(",");
    const b = [...placeholders(zh[base])].sort().join(",");
    if (a !== b) bad.push(`${key}: {${b}} vs en {${a}}`);
  }
  if (bad.length) {
    console.log(`⚠ 占位不一致 ${bad.length} 条：`);
    for (const b of bad.slice(0, 20)) console.log(`    ${b}`);
    process.exitCode = 1;
  }
}
