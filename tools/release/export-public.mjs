// round88（开源准备）：**公开仓导出器** —— 从 HEAD 导出对外子集 + 套用公开文案 + 隐私扫描 + 建干净初始提交。
//
// 用法（仓库根跑）：
//   node tools/release/export-public.mjs --out <空目录>            # 真导出（例：D:\repos\wakeyweeky-public）
//   node tools/release/export-public.mjs --out <目录> --dry-run                             # 只列清单与统计，不写盘
//   node tools/release/export-public.mjs --out <目录> --no-commit                           # 不建仓（幂等测试用）
//
// 设计（口径见 `docs/plans/round88-open-source-launch.md` §5 · 决定 D1/D2）：
//   · **整个导出物 = HEAD 的内容**（代码走 `git archive`，公开文案走 `git show`）——
//     未提交/未跟踪的东西带不出去；要改公开文案就先提交
//   · 公开文案的**唯一来源** = `docs/公开仓/`（私有仓里保存；导出时映射到公开仓根 / docs/）
//   · **隐私扫描是硬闸门且排在 `git init` 之前**：有命中 → 退出码 1、不建仓
//   · 目标目录非空 → 拒绝（**绝不递归删**；你自己决定怎么处理）
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { scan, loadDenylist } from "./privacy-scan.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** `INCLUDE` 里**不带去公开仓**的子树（逐条列举；公开仓用不上） */
const EXCLUDE_PREFIX = ["tools/i18n/archive/"];

/** 从 HEAD 带走的路径（**逐条列举** —— 白名单，不是黑名单） */
const INCLUDE = [
  "src",
  "src-tauri",
  "messages",
  "tools",
  "index.html",
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "svelte.config.js",
  "tsconfig.json",
  ".editorconfig",
  ".gitattributes",
  "LICENSE",
];

/** `docs/公开仓/` → 公开仓路径的映射（只在这里列 → 别的私有文件不可能溜出去） */
const OVERLAY = [
  ["README.zh.md", "README.md"],
  ["README.en.md", "README.en.md"],
  ["CHANGELOG.md", "CHANGELOG.md"],
  ["CONTRIBUTING.md", "CONTRIBUTING.md"],
  ["SECURITY.md", "SECURITY.md"],
  ["THIRD-PARTY.md", "THIRD-PARTY.md"],
  ["gitignore.txt", ".gitignore"],
  ["使用说明.md", "docs/使用说明.md"],
  ["设计笔记.md", "docs/设计笔记.md"],
  ["images", "docs/images"],
  [".github", ".github"],
];

/** 允许出现在公开仓根部的条目（多一个都要有理由 —— 导出后逐条核） */
const ALLOWED_TOP = new Set([
  "src",
  "src-tauri",
  "messages",
  "tools",
  "docs",
  ".github",
  "index.html",
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "svelte.config.js",
  "tsconfig.json",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  "LICENSE",
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "THIRD-PARTY.md",
]);

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const outDir = getArg("--out");
const dryRun = args.includes("--dry-run");
const noCommit = args.includes("--no-commit");
const verifyOnly = args.includes("--verify");

if (!outDir) {
  console.error("用法：node tools/release/export-public.mjs --out <目录> [--dry-run] [--no-commit]");
  console.error("      node tools/release/export-public.mjs --out <已有的导出目录> --verify   # 只溯源校验");
  process.exit(2);
}
const OUT = path.resolve(outDir);

const git = (...a) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const inHead = (p) => {
  try {
    git("cat-file", "-e", `HEAD:${p}`);
    return true;
  } catch {
    return false;
  }
};

/** 导出目录里的相对路径（一律正斜杠）+ 递归列举（跳过 .git）—— 放最上面，--verify 也要用 */
const rel = (p) => path.relative(OUT, p).split(path.sep).join("/");
function walkAll(root, acc = []) {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git") continue;
      walkAll(p, acc);
    } else acc.push({ rel: rel(p), abs: p });
  }
  return acc;
}

// ---------------------------------------------------------------- 前置检查（P8 / P3 / P1 / P5）

try {
  git("rev-parse", "--git-dir");
} catch {
  console.error(`✗ 这里不是 git 仓库：${REPO}`);
  process.exit(1);
}
// `--verify` 只看已有目录（不看 P1/P3/P5）
if (verifyOnly) {
  if (!existsSync(OUT)) {
    console.error(`✗ 目录不存在：${OUT}`);
    process.exit(2);
  }
  verifyAgainstHead();
  process.exit(0);
}
const inside = path.relative(REPO, OUT);
if (inside && !inside.startsWith("..") && !path.isAbsolute(inside)) {
  console.error(`✗ 目标目录在本仓内部：${OUT}（换成仓库外的目录）`);
  process.exit(1);
}
if (existsSync(OUT)) {
  const entries = readdirSync(OUT);
  if (entries.length) {
    console.error(`✗ 目标目录非空：${OUT}`);
    console.error(`  里面有 ${entries.length} 项：${entries.slice(0, 5).join(" / ")}${entries.length > 5 ? " …" : ""}`);
    console.error("  （导出脚本**不会**帮你删任何东西 —— 换一个空目录，或你自己确认后清掉它）");
    process.exit(1);
  }
}
for (const p of INCLUDE) {
  if (!inHead(p)) {
    console.error(`✗ 清单里的路径在 HEAD 里不存在：${p}（清单与仓库漂移了）`);
    process.exit(1);
  }
}
const missing = OVERLAY.filter(([src]) => !inHead(`docs/公开仓/${src}`)).map(([src]) => src);
if (missing.length) {
  console.error(`✗ 公开文案在 HEAD 里缺这些（先提交，或先跑生成器）：`);
  for (const m of missing) console.error(`    docs/公开仓/${m}`);
  if (missing.includes("THIRD-PARTY.md")) console.error("  提示：node tools/release/gen-third-party.mjs");
  process.exit(1);
}

const dirty = git("status", "--porcelain").trim().split(/\r?\n/).filter(Boolean);
const head = git("rev-parse", "--short", "HEAD").trim();
const headSubject = git("log", "-1", "--format=%s").trim();
console.log(`仓库 HEAD：${head} · ${headSubject}`);
if (dirty.length) {
  console.log(`⚠️ 工作区有 ${dirty.length} 处未提交改动 —— 导出的是 **HEAD**，它们不会被带出去（要带就先提交）`);
}

// ---------------------------------------------------------------- 导出（tar 一次 + 覆盖文件逐个从 HEAD 取）

if (!dryRun) mkdirSync(OUT, { recursive: true });

if (!dryRun) {
  // 用 `git checkout-index --work-tree` 而不是 `git archive | tar`：
  // 本机 MSYS 的 tar 会把 `D:\…` 当成 `D\:…`（实测 error 128），而 Windows 的 bsdtar 对
  // 中文文件名的 tar 又有编码偏差 —— checkout-index 由 git 自己写文件，两条坑都绕开。
  const list = git("ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...INCLUDE)
    .split("\0")
    .filter(Boolean)
    .filter((p) => !EXCLUDE_PREFIX.some((x) => p.startsWith(x)));
  const skipped = git("ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...INCLUDE)
    .split("\0")
    .filter((p) => p && EXCLUDE_PREFIX.some((x) => p.startsWith(x))).length;
  if (skipped) console.log(`（按 EXCLUDE_PREFIX 跳过 ${skipped} 个文件：${EXCLUDE_PREFIX.join(" · ")}）`);
  execFileSync("git", ["-C", REPO, `--work-tree=${OUT}`, "checkout-index", "-f", "-z", "--stdin"], {
    input: list.join("\0") + "\0",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** `docs/公开仓/` 在 HEAD 里的文件列表（目录条目递归展开） */
function headFiles(prefix) {
  const out = git("ls-tree", "-r", "--name-only", "-z", "HEAD", "--", `docs/公开仓/${prefix}`)
    .split("\0")
    .filter(Boolean);
  return out;
}

if (!dryRun) {
  for (const [from, to] of OVERLAY) {
    const srcs = headFiles(from);
    if (!srcs.length) {
      console.error(`✗ HEAD 里没有 docs/公开仓/${from}`);
      process.exit(1);
    }
    for (const src of srcs) {
      const suffix = src === `docs/公开仓/${from}` ? "" : src.slice(`docs/公开仓/${from}/`.length);
      const target = suffix ? `${to}/${suffix}` : to;
      const abs = path.join(OUT, target);
      mkdirSync(path.dirname(abs), { recursive: true });
      // 用 cat-file（**Buffer**）而不是 `git show` + utf8：后者会把 PNG 这类二进制写坏
      // （--verify 实测抳到：6 张 docs/images/*.png 的 blob 对不上）
      const blob = execFileSync("git", ["-C", REPO, "cat-file", "blob", `HEAD:${src}`], {
        maxBuffer: 256 * 1024 * 1024,
      });
      writeFileSync(abs, blob);
    }
  }
}

// ---------------------------------------------------------------- 溯源校验（--verify）：导出物里的每个文件都得是 HEAD 里那个 blob

/** `--verify`：拿 git 自己的 blob id 对比（等于逐字节）—— INCLUDE 路径同名，覆盖项按 OVERLAY 映射回源 */
function verifyAgainstHead() {
  /** 期望集合：`rel → HEAD 里的 blob id`（**双向核对**的依据 —— 漏文件也要能看出来） */
  const expect = new Map();
  for (const line of git("ls-tree", "-r", "-z", "HEAD", "--", ...INCLUDE).split("\0")) {
    if (!line) continue;
    const [meta, p] = line.split("\t");
    if (EXCLUDE_PREFIX.some((x) => p.startsWith(x))) continue;
    expect.set(p, meta.split(/\s+/)[2]);
  }
  for (const src of git("ls-tree", "-r", "-z", "--name-only", "HEAD", "--", "docs/公开仓").split("\0").filter(Boolean)) {
    const [meta] = git("ls-tree", "-r", "-z", "HEAD", "--", src).split("\0").filter(Boolean);
    if (!meta) continue;
    const relative = src.slice("docs/公开仓/".length);
    const hit = OVERLAY.find(([from]) => relative === from || relative.startsWith(`${from}/`));
    if (!hit) continue; // 导出源里没被映射的文件（如 便携版使用说明.txt）不进公开仓
    const [from, to] = hit;
    const suffix = relative === from ? "" : relative.slice(from.length + 1);
    expect.set(suffix ? `${to}/${suffix}` : to, meta.split("\t")[0].split(/\s+/)[2]);
  }

  const blobOf = (abs) => git("hash-object", "--no-filters", abs).trim();
  const problems = [];
  const got = new Set(walkAll(OUT).map((f) => f.rel));

  // 方向一：期望的都要在、内容要逐字节一样
  let checked = 0;
  for (const [relPath, blob] of expect) {
    if (!got.has(relPath)) {
      problems.push(`${relPath}（**漏了**：HEAD 里有，导出物里没有）`);
      continue;
    }
    const actual = blobOf(path.join(OUT, relPath));
    checked++;
    if (actual !== blob) problems.push(`${relPath}（blob 不一致：\n    导出 ${actual}\n    HEAD ${blob}）`);
  }
  // 方向二：导出物里不许有期望之外的东西
  for (const relPath of got) {
    if (!expect.has(relPath)) problems.push(`${relPath}（**多了**：不在 HEAD 的导出清单里）`);
  }

  console.log(`\n溯源校验（双向）：HEAD 应出 ${expect.size} 个 · 导出物有 ${got.size} 个 · 逐字节对账 ${checked} 个`);
  for (const m of problems.slice(0, 10)) console.error(`  ✗ ${m}`);
  if (problems.length) {
    console.error(`✗ ${problems.length} 处对不上 —— 导出物不是 HEAD 的忠实拷贝（少一个、多一个、或内容不同都算）`);
    process.exit(1);
  }
  console.log("✓ 数量一致，且每个文件都与 HEAD 里的那个 blob 逐字节一致");
}

// ---------------------------------------------------------------- 核对 + 扫描 + 建仓

if (dryRun) {
  console.log(`\n[dry-run] 清单 ${INCLUDE.length} 条路径 · 覆盖 ${OVERLAY.length} 项 → ${OUT}（没有写盘）`);
  process.exit(0);
}

const files = walkAll(OUT);

const tops = new Set(files.map((f) => f.rel.split("/")[0]));
const extra = [...tops].filter((t) => !ALLOWED_TOP.has(t));
if (extra.length) {
  console.error(`✗ 公开仓根出现了计划外的条目：${extra.join(" · ")}`);
  process.exit(1);
}
// 排除项绝不允许出现在导出物里（防清单/过滤漂移）
const leaked = files.filter((f) => EXCLUDE_PREFIX.some((x) => f.rel.startsWith(x)));
if (leaked.length) {
  console.error(`✗ 排除项漏进导出物：${leaked.slice(0, 3).map((f) => f.rel).join(" · ")}`);
  process.exit(1);
}

const fingerprint = createHash("sha256");
let bytes = 0;
const lines = files
  .map((f) => {
    const buf = readFileSync(f.abs);
    bytes += buf.length;
    return `${f.rel}:${createHash("sha256").update(buf).digest("hex")}`;
  })
  .sort();
for (const l of lines) fingerprint.update(`${l}\n`);
const fp = fingerprint.digest("hex");

console.log(`\n导出：${files.length} 个文件 · ${(bytes / 1048576).toFixed(1)} MiB → ${OUT}`);
console.log(`导出指纹（逐文件 sha256 汇总）：${fp}`);

const res = scan(OUT, { denylist: loadDenylist() }); // 复核 ①-2：导出这道闸门以前没接私有词表
console.log(`\n隐私扫描：硬命中 ${res.hard.length} · 软提醒 ${res.soft.length}`);
for (const h of res.hard.slice(0, 20)) console.log(`  ✗ [${h.rule}] ${h.file}:${h.line} ${h.snippet}`);
for (const s of res.soft.slice(0, 5)) console.log(`  · [${s.rule}] ${s.file}:${s.line} ${s.snippet}`);
if (res.soft.length > 5) console.log(`  · …其余 ${res.soft.length - 5} 条软提醒（代码里的批次编号，不拦）`);
if (res.hard.length) {
  console.error("\n✗ 有硬命中 → **不建仓**。修掉或从清单里排除，然后重跑。");
  process.exit(1);
}

if (noCommit) {
  console.log("\n--no-commit：扫描通过，跳过 git init（幂等测试用）");
  console.log(`FINGERPRINT ${fp}`);
  process.exit(0);
}

execFileSync("git", ["init", "-q", "-b", "main", OUT], { stdio: "inherit" });
execFileSync("git", ["-C", OUT, "add", "-A"], { stdio: "inherit" });
const msgFile = path.join(os.tmpdir(), `ww88-commit-${process.pid}.txt`);
writeFileSync(
  msgFile,
  "WakeyWeeky 1.0.2 — first public commit\n\n从内部开发仓导出的对外子集（源码 + 工具 + 公开文档）。\n不带内部施工记录：验收 / 计划 / 台账 / 交接 / 会话。\n\n安装包见 Releases。\n",
  "utf8",
);
execFileSync("git", ["-C", OUT, "commit", "-q", "-F", msgFile], { stdio: "inherit" });
execFileSync("node", ["-e", `require('fs').rmSync(${JSON.stringify(msgFile)})`]);

const tracked = execFileSync("git", ["-C", OUT, "ls-files"], { encoding: "utf8" }).trim().split(/\r?\n/).length;
const logLine = execFileSync("git", ["-C", OUT, "log", "--oneline", "--stat"], { encoding: "utf8" })
  .trim()
  .split(/\r?\n/);
console.log(`\n✓ 初始提交完成：${tracked} 个已跟踪文件`);
console.log(`  ${logLine[0]}`);
console.log(`  ${logLine[logLine.length - 1]}`);
verifyAgainstHead();
console.log(`\n下一步：照 docs/开源发布手册.md 建仓 / 推送 / 发 Release。`);
console.log(`FINGERPRINT ${fp}`);
