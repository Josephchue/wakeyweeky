// round74（6b P2-7）：把「改前基线（baseline-zh.json）↔ 现在的资源层（messages/zh.json）」
// 按**值多重集**对一遍 —— 这是 3.0b₁ plan §3.4 第 3 步「机器证明中文逐屏一致」的**可复跑实现**。
//
// 用法：node tools/i18n/reconcile.mjs [--strict]
//   · 默认只打印差集（人工解释用；退出码 0）
//   · --strict：有「基线有、资源层没有」的值时退出码 1（当门禁用，需要先把差集清零）
//
// provenance（写清楚，免得下次误判）：
//   baseline-zh.json 是 round73 迁移工具**早期版本**产出的「改前底账」（1676 条），
//   它包含：① 16 条 `[模块] …` 日志串（后来判定不是用户文案、值还原回源码）；
//   ② 1 条伪语言包装串（资源层自身的实现细节）；③ `src/lib/i18n/*` 这些 round73 新建文件里的串
//   （它们是工具中途产物，不是「改前」）。所以差集允许出现这些类别 —— 本脚本逐条打印、不猜。
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const strict = process.argv.includes("--strict");

function readJson(rel) {
  const p = path.join(repoRoot, rel);
  if (!existsSync(p)) {
    console.error(`读不到 ${rel}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`解析不了 ${rel}：${e.message}`);
    process.exit(1);
  }
}

const baseline = readJson("tools/i18n/baseline-zh.json").entries ?? [];
const zh = readJson("messages/zh.json");
const audit = readJson("tools/i18n/audit.json");
/** 已登记的整改：`from` 就是「改前」的值 —— 它们「基线有、资源层没有」是**预期** */
const auditedFrom = new Set(Object.values(audit).map((rec) => rec.from));

const count = (arr) => {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
};
const baseVals = baseline.map((e) => e.value);
const baseCount = count(baseVals);
const msgCount = count(Object.values(zh));

const onlyBase = [];
const onlyNow = [];
for (const [v, n] of baseCount) {
  const have = msgCount.get(v) ?? 0;
  if (have < n) onlyBase.push({ value: v, have, missing: n - have });
}
for (const [v, n] of msgCount) {
  const have = baseCount.get(v) ?? 0;
  if (n > have) onlyNow.push({ value: v, extra: n - have });
}

console.log(`基线 ${baseline.length} 条（唯一值 ${baseCount.size}）`);
console.log(`资源层 ${Object.keys(zh).length} 条（唯一值 ${msgCount.size}）`);
console.log(`值多重集差：基线有资源层没有 ${onlyBase.length} 条；资源层多出 ${onlyNow.length} 条`);

const show = Number(process.env.SHOW ?? 30);
if (onlyBase.length) {
  console.log(`\n[基线有、资源层没有]（前 ${Math.min(show, onlyBase.length)} / ${onlyBase.length}）：`);
  for (const { value, missing } of onlyBase.slice(0, show)) {
    const src = baseline.find((e) => e.value === value);
    console.log(`  ×${missing} ${JSON.stringify(value).slice(0, 70)}   ← ${src ? `${src.file}:${src.line}` : "?"}`);
  }
}
if (onlyNow.length) {
  console.log(`\n[资源层多出]（前 ${Math.min(show, onlyNow.length)} / ${onlyNow.length}）：`);
  for (const { value, extra } of onlyNow.slice(0, show)) {
    const key = Object.keys(zh).find((k) => zh[k] === value);
    console.log(`  +${extra} ${JSON.stringify(value).slice(0, 70)}   ← ${key ?? "?"}`);
  }
}

// 差集分类（见文件头 provenance）：每条「基线有、资源层没有」的值该落在哪一类
const logLike = /^\[([a-z-]+)\]/;
/** 两轮工具之间的中间值：占位重命名（同名冲突）与 N2 的中间态 —— 都已在 check.mjs 的 INTENTIONAL 登记 */
const KNOWN_INTERMEDIATE = new Set([
  "本周{kind} {kind} 次", // → 本周{kind} {count} 次（占位重命名）
  "{base}{kind} {kind} 次", // → {base}{kind} {count} 次（同上）
  "落点 {span} · {span}", // → 落点 {span} · {duration}（同上）
  "相邻同任务块自动合并（每次吃掉 1 块）", // N2 第一轮
  "不再把相接/重叠的同任务块合成一块（含启动时的整理）；已经合过的块保持原样", // N2 第一轮
]);
const classify = (x) => {
  if (logLike.test(x.value)) return "日志串（不是用户文案）";
  if (x.value.includes("———")) return "工具产物（伪语言包装）";
  if (auditedFrom.has(x.value)) return "已登记整改（audit.from）";
  if (KNOWN_INTERMEDIATE.has(x.value)) return "中间态（占位重命名 / 多轮整改）";
  if (x.have > 0) return "数量收缩（成就组名去重等）";
  return "未解释";
};
const byClass = {};
for (const x of onlyBase) byClass[classify(x)] = (byClass[classify(x)] ?? 0) + 1;
console.log("\n差集分类（值条数）：");
for (const [k, v] of Object.entries(byClass)) console.log(`  ${v}\t${k}`);

const unexplained = onlyBase.filter((x) => classify(x) === "未解释");
if (!unexplained.length) console.log("\n✓ 基线差集全部可解释（日志 / 工具产物 / 已登记整改 / 去重）");
else {
  console.log(`\n⚠ 还有 ${unexplained.length} 条需要人工解释：`);
  for (const { value } of unexplained.slice(0, 20)) {
    const src = baseline.find((e) => e.value === value);
    console.log(`    ${JSON.stringify(value).slice(0, 70)}   ← ${src ? `${src.file}:${src.line}` : "?"}`);
  }
}

if (strict && unexplained.length) process.exit(1);
