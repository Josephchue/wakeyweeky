// round73（3.0b₁）：抽取用户可见文案 → 基线快照（改前的机器底账）。
//
// 用法：
//   node tools/i18n/extract.mjs                       # 打印统计 + 抽样
//   node tools/i18n/extract.mjs --out tools/i18n/baseline-zh.json
//   node tools/i18n/extract.mjs --file src/lib/utils/week.ts
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAll, extractFile } from "./lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const fileArg = args.indexOf("--file");

if (fileArg >= 0) {
  const rel = args[fileArg + 1].replace(/\\/g, "/");
  const { entries } = extractFile(path.join(repoRoot, rel), rel);
  console.log(`${rel}: ${entries.length} 条`);
  for (const e of entries) console.log(`  L${e.line} [${e.kind}] ${JSON.stringify(e.value)}`);
  process.exit(0);
}

const entries = extractAll(repoRoot);
const byLang = {};
for (const e of entries) {
  const lang = e.file.endsWith(".svelte") ? "svelte" : e.file.endsWith(".ts") ? "ts" : "rs";
  byLang[lang] = (byLang[lang] || 0) + 1;
}
const byFile = {};
for (const e of entries) byFile[e.file] = (byFile[e.file] || 0) + 1;

console.log(`总计 ${entries.length} 条`);
console.log(`  分面：`, byLang);
console.log(`  文件：${Object.keys(byFile).length} 个`);
const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 12);
for (const [f, n] of top) console.log(`    ${n}\t${f}`);

if (outArg >= 0) {
  const outPath = path.resolve(repoRoot, args[outArg + 1]);
  writeFileSync(outPath, JSON.stringify({ version: 1, note: "round73 迁移前的用户可见文案基线（extract.mjs）", entries }, null, 1));
  console.log(`已写 ${path.relative(repoRoot, outPath)}`);
} else {
  console.log("（未写文件；加 --out <path>）");
}
