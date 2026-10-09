// round88（开源准备）：**第三方许可清单生成器** —— 从 `package-lock.json` + `cargo metadata` 生成
// `docs/公开仓/THIRD-PARTY.md`（导出后 = 公开仓 `THIRD-PARTY.md`）。
//
// 用法（仓库根跑）：
//   node tools/release/gen-third-party.mjs            # 生成 / 覆盖
//   node tools/release/gen-third-party.mjs --check    # 只对账：与仓库里那份逐字节一致？（进闸门用）
//
// 为什么生成而不是手写：依赖一升级，手写清单立刻过期（本仓的教训：三份 html 长期落后）。
// 顺带做**许可审计**：许可名不在允许集（MIT / Apache-2.0 / BSD / ISC / Zlib / MPL-2.0 / CC0 / Unlicense…）
// 里的依赖会被点名 —— 有 copyleft 混进来应该被人看见，而不是被这份清单掩盖。
//
// ⚠️ 需要一次网络：`cargo metadata` 要索引（--offline 会因缺 android_system_properties 这类
//    目标专属包直接失败）。失败时**不写半截文件**。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(REPO, "docs", "公开仓", "THIRD-PARTY.md");
const check = process.argv.includes("--check");

/** 允许的许可（宽松 + 少数弱 copyleft）；不在里面的会在清单里被点名 */
const PERMISSIVE = [
  "MIT", "MIT-0", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "BSD-2-Clause", "BSD-3-Clause",
  "ISC", "Zlib", "0BSD", "Unlicense", "CC0-1.0", "MPL-2.0", "Unicode-3.0", "Unicode-DFS-2016",
  "BSL-1.0", "CC-BY-4.0", "OpenSSL",
];
/** 拆许可表达式：`MIT/Apache-2.0`（**无空格斜杠**，crates.io 常见写法）/ `A OR B` / `A AND B` 都要吃得下
 *  （实证：不拆无空格写法 → 26 条全宽松的双许可被误报成「需人工确认」） */
/** 许可表达式能不能满足（**多许可时选宽松那一项** —— 这是双/三许可的正规用法）：
 *  · 顶层按 `AND` 拆：每个合取项都得满足；
 *  · 每个合取项里按 `OR`（含无空格斜杠）看**有没有一项**在允许集里；
 *  实例：`MIT OR Apache-2.0 OR LGPL-2.1-or-later` → 选 MIT ✓；`(MIT OR Apache-2.0) AND Unicode-3.0` → 两项都能满足 ✓。 */
const licenseOk = (license) => {
  const s = String(license ?? "").replace(/（license-file）/g, "").trim();
  if (!s) return false;
  return s.split(/\s+AND\s+/i).every((conj) => {
    const options = conj
      .replace(/^\s*\(|\)\s*$/g, "")
      .split(/\s+OR\s+|\s*\/\s*/i)
      .map((x) => x.trim())
      .filter(Boolean);
    return options.some((o) => PERMISSIVE.some((ok) => ok.toLowerCase() === o.toLowerCase()));
  });
};
const needsReview = (license) => !licenseOk(license);

// ---------------------------------------------------------------- npm（直接依赖；版本与许可来自 lock）

/** 读一个仓库里的 JSON；读不了 / 坏了就明确报错退出（不写半截文件） */
function readJson(rel) {
  const p = path.join(REPO, rel);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`✗ 读不了 ${rel}：${e.message}`);
    process.exit(1);
  }
}

const pkgJson = readJson("package.json");
const lock = readJson("package-lock.json");
const lockPkg = (name) => lock.packages?.[`node_modules/${name}`] ?? {};

const npmDirect = [
  ...Object.keys(pkgJson.dependencies ?? {}).map((n) => ({ name: n, kind: "运行时" })),
  ...Object.keys(pkgJson.devDependencies ?? {}).map((n) => ({ name: n, kind: "开发/构建" })),
].map((d) => ({ ...d, version: lockPkg(d.name).version ?? "?", license: lockPkg(d.name).license ?? "?" }));
const npmTotal = Object.keys(lock.packages ?? {}).filter((k) => k.startsWith("node_modules/")).length;

// ---------------------------------------------------------------- cargo（直接依赖；许可来自 cargo metadata）

let meta;
try {
  meta = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--quiet"], {
      cwd: path.join(REPO, "src-tauri"),
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    }),
  );
} catch (e) {
  console.error("✗ `cargo metadata` 失败（多半是没网 / 索引没缓存）：");
  console.error(String(e.stderr ?? e.message).split("\n").slice(0, 6).join("\n"));
  process.exit(1);
}
const byId = new Map(meta.packages.map((p) => [p.id, p]));

/** 有些 crate 只给 `license-file`（没有 SPDX `license` 字段）—— 读那个文件识别出许可名。
 *  实例：`ical 0.11.0` 只有 license-file，内容是 Apache-2.0（2026-10-09 本批碰到）。
 *  识别不了就返回 null → 进「需人工确认」。 */
function licenseOf(p) {
  if (p.license) return p.license;
  if (!p.license_file) return null;
  const file = path.isAbsolute(p.license_file)
    ? p.license_file
    : path.resolve(path.dirname(p.manifest_path), p.license_file);
  let text = "";
  try {
    text = readFileSync(file, "utf8").slice(0, 4000);
  } catch {
    return null;
  }
  if (/Apache License/i.test(text)) return "Apache-2.0（license-file）";
  if (/ISC License/i.test(text)) return "ISC（license-file）";
  if (/GNU AFFERO/i.test(text)) return "AGPL（license-file）";
  if (/GNU LESSER/i.test(text)) return "LGPL（license-file）";
  if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) return "GPL（license-file）";
  if (/Mozilla Public License/i.test(text)) return "MPL-2.0（license-file）";
  if (/MIT License|Permission is hereby granted, free of charge/i.test(text)) return "MIT（license-file）";
  if (/BSD/i.test(text)) return "BSD（license-file）";
  return null;
}

const root = meta.packages.find((p) => p.name === "wakeyweeky");
if (!root) {
  console.error("✗ cargo metadata 里找不到本地包 wakeyweeky");
  process.exit(1);
}
const rootNode = meta.resolve.nodes.find((n) => n.id === root.id);
/** cargo 的 kind → 人话（公开文档里不写 "normal"） */
const CARGO_KIND = { normal: "运行时", dev: "开发/测试", build: "构建", proc_macro: "过程宏" };
const cargoDirect = (rootNode?.deps ?? [])
  .map((d) => byId.get(d.pkg))
  .filter(Boolean)
  .map((p) => ({ name: p.name, version: p.version, license: licenseOf(p) ?? "?", kind: CARGO_KIND[p.kind] ?? p.kind ?? "运行时" }))
  .sort((a, b) => a.name.localeCompare(b.name));

const registry = meta.packages.filter((p) => p.source && p.source.includes("crates.io"));
const histogram = {};
for (const p of registry) histogram[p.license ?? "(无字段)"] = (histogram[p.license ?? "(无字段)"] ?? 0) + 1;
// 复核 ②-3：「含间接全部为宽松许可」这句必须有代码支撑 —— 所以**全树**（npm lock 全部 + cargo registry 全部）都过一遍审计
const npmAll = Object.entries(lock.packages ?? {})
  .filter(([k]) => k.startsWith("node_modules/"))
  .map(([k, v]) => ({ name: k.slice("node_modules/".length), version: v.version, license: v.license ?? "?" }));
const cargoAll = registry.map((p) => ({ name: p.name, version: p.version, license: licenseOf(p) ?? "?" }));
const suspicious = [
  ...npmAll.filter((d) => needsReview(d.license)).map((d) => `npm:${d.name}@${d.version} (${d.license})`),
  ...cargoAll.filter((d) => needsReview(d.license)).map((d) => `cargo:${d.name}@${d.version} (${d.license})`),
];
const npmHistogram = {};
for (const d of npmAll) npmHistogram[d.license] = (npmHistogram[d.license] ?? 0) + 1;

// ---------------------------------------------------------------- 渲染

const rows = (list, cols) =>
  [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`,
    ...list.map((r) => `| ${cols.map((c) => r[c]).join(" | ")} |`)].join("\n");

const md = `# 第三方组件与许可（THIRD-PARTY）

> 本文件由 \`tools/release/gen-third-party.mjs\` 生成（\`--check\` 可对账：与仓库里这份逐字节一致）。
> 生成源：\`package.json\` + \`package-lock.json\`（npm）与 \`cargo metadata\`（Rust）。
> 本项目自身：**MIT**（见 [LICENSE](LICENSE)）。

## 一、随包分发的素材（许可全文已随安装包）

| 素材 | 许可 | 全文 |
| --- | --- | --- |
| 展示字 Poiret One · Jost · Archivo Black · Marcellus · Samigirian | SIL Open Font License 1.1 | \`src-tauri/resources/*-OFL.txt\` |
| 图标集 lucide · tabler · phosphor · bootstrap · Material Symbols | ISC / MIT / MIT / MIT / Apache-2.0 | \`src-tauri/resources/ICONS-LICENSE.md\` |

## 二、npm 依赖

直接依赖 ${npmDirect.length} 个；\`node_modules\` 里共 ${npmTotal} 个包（含间接，全部为宽松许可）。

${rows(npmDirect.map((d) => ({ 包: `\`${d.name}\``, 版本: d.version, 许可: d.license, 用途: d.kind })), ["包", "版本", "许可", "用途"])}

## 三、Rust 依赖

直接依赖 ${cargoDirect.length} 个；完整依赖树来自 crates.io，共 ${registry.length} 个 crate。

${rows(cargoDirect.map((d) => ({ crate: `\`${d.name}\``, 版本: d.version, 许可: d.license, 用途: d.kind })), ["crate", "版本", "许可", "用途"])}

### 完整依赖树的许可分布

${rows(Object.entries(histogram).sort((a, b) => b[1] - a[1]).map(([lic, n]) => ({ 许可: lic, 数量: String(n) })), ["许可", "数量"])}

## 四、许可审计

**范围 = 全部依赖**（npm ${npmAll.length} 个包 + cargo ${cargoAll.length} 个 crate；不只直接依赖）。

**npm 全树的许可分布**

${rows(Object.entries(npmHistogram).sort((a, b) => b[1] - a[1]).map(([lic, n]) => ({ 许可: lic, 数量: String(n) })), ["许可", "数量"])}

${suspicious.length === 0
    ? `审计结论：**没有**需要人工确认的许可（允许集：${PERMISSIVE.join(" / ")}）。\n> 多许可（A OR B 这种写法）按**宽松那一项**判 —— 例如「MIT OR Apache-2.0 OR LGPL-2.1-or-later」我们选 MIT。`
    : `⚠️ **需要人工确认**（不在允许集里）：\n\n${suspicious.map((s) => `- ${s}`).join("\n")}`}
`;

// ---------------------------------------------------------------- 写 / 对账

if (check) {
  if (!existsSync(OUT)) {
    console.error(`✗ 仓库里没有 ${path.relative(REPO, OUT)} —— 先跑 node tools/release/gen-third-party.mjs`);
    process.exit(1);
  }
  // 审计先查（复核：以前字节一致分支会先 exit 0，审计分支根本轮不到）
  if (suspicious.length) {
    console.error(`✗ 许可审计有 ${suspicious.length} 项需要人工确认（不在允许集里）：`);
    for (const s of suspicious.slice(0, 10)) console.error(`    ${s}`);
    console.error("  确认无问题就把许可名加进 PERMISSIVE（并记一句为什么）；有问题就换依赖。");
    process.exit(1);
  }
  const onDisk = readFileSync(OUT, "utf8");
  if (onDisk === md) {
    console.log(`✓ ${path.relative(REPO, OUT)} 与生成源一致（npm 直接 ${npmDirect.length} / 全树 ${npmAll.length} · cargo 直接 ${cargoDirect.length} / 全树 ${cargoAll.length} · 需人工确认 ${suspicious.length}）`);
    process.exit(0);
  }
  console.error(`✗ ${path.relative(REPO, OUT)} 与生成源不一致（依赖或 TOML 变了，重跑生成器）`);
  process.exit(1);
}
if (suspicious.length) {
  console.error(`✗ 许可审计有 ${suspicious.length} 项需要人工确认（不在允许集里）：`);
  for (const s of suspicious.slice(0, 10)) console.error(`    ${s}`);
  console.error("  确认无问题就把许可名加进 PERMISSIVE（并记一句为什么）；有问题就换依赖。");
  process.exit(1);
}

writeFileSync(OUT, md, "utf8");
console.log(`✓ 已写 ${path.relative(REPO, OUT)}`);
console.log(`  npm 直接 ${npmDirect.length} / 全树 ${npmAll.length} · cargo 直接 ${cargoDirect.length} / 全树 ${cargoAll.length}`);
console.log(`  许可审计（全树）：需人工确认 ${suspicious.length}${suspicious.length ? ` → ${suspicious.slice(0, 5).join(" · ")}` : ""}`);
