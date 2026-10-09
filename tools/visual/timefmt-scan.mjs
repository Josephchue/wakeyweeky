#!/usr/bin/env node
/**
 * round81（3.1c₁ · `时-08`）：**时间 / 日期格式的机械扫描**。
 *
 * 规则（唯一实现 = `src/lib/utils/datetime.svelte.ts` + `src-tauri/src/datetime.rs`）：
 * 1. 前端 `import { format } from "date-fns"` 只允许出现在 `utils/datetime.svelte.ts`；
 * 2. 前端不得直接 `toLocaleDateString` / `toLocaleTimeString`（要一律走收口模块）；
 * 3. 前端不得出现裸格式串（`"HH:mm"` / `"yyyy-MM-dd"` / `"MM-dd"` …）—— datetime 模块除外；
 * 4. Rust 侧 `.format("…` 只允许出现在 `datetime.rs`（显示）、`ics.rs`（协议）、`scheduler.rs`（日志展示串）；
 *    其余文件的 `#[cfg(test)]` 之后的代码不扫（本仓测试都在文件尾）。
 *
 * 用法：`node tools/visual/timefmt-scan.mjs`（有违规 → 退出码 1 并逐条打印）。
 * 为什么要有它：round74 登记的「无裸 format」规则，本批兑现（`时-08`）——
 * 以后新加时间 / 日期显示时，忘记走收口模块会被这条守住。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FRONT_ALLOW = ["src/lib/utils/datetime.svelte.ts"];
const RUST_ALLOW = ["src-tauri/src/datetime.rs", "src-tauri/src/ics.rs", "src-tauri/src/scheduler.rs"];

const problems = [];

function walk(dir, exts, hit) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "target" || name === "dist") continue;
      walk(full, exts, hit);
    } else if (exts.some((e) => name.endsWith(e))) {
      hit(full);
    }
  }
}

const rel = (p) => path.relative(ROOT, p).replaceAll("\\", "/");

// ---- 前端 ----
walk(path.join(ROOT, "src"), [".ts", ".svelte"], (file) => {
  const r = rel(file);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const where = `${r}:${i + 1}`;
    if (FRONT_ALLOW.includes(r)) return;
    if (/import\s*\{[^}]*\bformat\b[^}]*\}\s*from\s*"date-fns"/.test(line)) {
      problems.push(`${where} 裸用 date-fns 的 format —— 时间 / 日期请走 utils/datetime.svelte.ts`);
    }
    // round81（6b 复核）：默认导入 / 子路径导入也算裸用
    if (/import\s+format\s+from\s*"date-fns/.test(line) || /from\s*"date-fns\/format"/.test(line)) {
      problems.push(`${where} 以默认 / 子路径方式导入 date-fns format —— 请走 utils/datetime.svelte.ts`);
    }
    if (/\.toLocale(Date|Time)String\(/.test(line)) {
      problems.push(`${where} 直接用 toLocaleDate/TimeString —— 请走 utils/datetime.svelte.ts`);
    }
    if (/new Intl\.DateTimeFormat\(/.test(line)) {
      problems.push(`${where} 直接 new Intl.DateTimeFormat —— 请走 utils/datetime.svelte.ts`);
    }
    // round81（6b 复核）：把固定档 / 片段的常见写法也堵上（原来只认 6 个字面量）
    for (const lit of ['"HH:mm', "'HH:mm", '"yyyy-MM-dd', "'yyyy-MM-dd", '"MM-dd', "'MM-dd", '"MMM d', '"yyyy/MM', "'yyyy/MM", '"MM/dd', "'MM/dd", '"HH:mm:', "'HH:mm:"]) {
      if (line.includes(lit) && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*")) {
        problems.push(`${where} 裸格式串 ${lit}… —— 请走 utils/datetime.svelte.ts`);
      }
    }
  });
});

// ---- Rust ----
walk(path.join(ROOT, "src-tauri/src"), [".rs"], (file) => {
  const r = rel(file);
  if (RUST_ALLOW.includes(r)) return;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lines.slice(0, i).some((l) => l.includes("#[cfg(test)]"))) break; // 测试在文件尾，跳过
    if (/\.format\(\s*"%/.test(line)) {
      problems.push(`${r}:${i + 1} Rust 侧直接 .format("%…") —— 显示请走 crate::datetime`);
    }
  }
});

if (problems.length === 0) {
  console.log("时间 / 日期格式扫描：0 违规（唯一实现 = utils/datetime.svelte.ts + src-tauri/src/datetime.rs）");
  process.exit(0);
}
console.error(`时间 / 日期格式扫描：${problems.length} 条违规`);
for (const p of problems) console.error(`  ✗ ${p}`);
process.exit(1);
