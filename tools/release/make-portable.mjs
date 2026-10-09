// round88（开源准备）：**便携版 ZIP 组装器** —— 从已有的 MSI 里取 exe（不重编包），配 `portable.flag`、
// `licenses/`（随包许可）与一页使用说明，打成 `WakeyWeeky-<版本>-portable.zip`。
//
// 用法（仓库根跑）：node tools/release/make-portable.mjs
//   → 产物：src-tauri/target/release/bundle/WakeyWeeky-<版本>-portable.zip
//
// 三条断言（都要过，否则退出码 1 —— 宁可不发也不发一个说不清的包）：
//   ① exe = **MSI 里那一份**（与安装包逐字节相同）；与 `target/release/wakeyweeky.exe` 的差异只**报告**
//      （实测差 3 字节 = Tauri 的 bundle 类型戳 MSI/UNK；差异 >64 字节才当失败）
//   ② 许可负载**看起来齐**：MSI 带的非 exe 负载数 ≥ 源码 `resources/` 份数，且 `resources/` 里每份都是许可类文件
//      （**不是**「MSI 与源码逐字节同步」—— 不重编包时它们本来就可能不同；便携包发当前源码那版）
//   ③ 打完之后用 7z `t` 验一遍压缩包完整性，并列出内容
//
// 依赖：7-Zip（本机 `C:\Program Files\7-Zip\7z.exe`；没有就明确报错，不半途而废）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SEVEN_ZIP = "C:/Program Files/7-Zip/7z.exe";
const tmp = (p) => path.join(os.tmpdir(), p);

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(path.join(REPO, rel), "utf8"));
  } catch (e) {
    console.error(`✗ 读不了 ${rel}：${e.message}`);
    process.exit(1);
  }
}
const conf = readJson("src-tauri/tauri.conf.json");
const version = conf.version;
const MSI = path.join(REPO, "src-tauri", "target", "release", "bundle", "msi", `WakeyWeeky_${version}_x64_en-US.msi`);
const EXE_RELEASE = path.join(REPO, "src-tauri", "target", "release", "wakeyweeky.exe");
const RESOURCES = path.join(REPO, "src-tauri", "resources");
const OUT_ZIP = path.join(REPO, "src-tauri", "target", "release", "bundle", `WakeyWeeky-${version}-portable.zip`);
const STAGE = tmp(`ww88-portable-stage-${process.pid}`);
const EXTRACT = tmp(`ww88-msi-extract-${process.pid}`);
const TOP = `WakeyWeeky-${version}-portable`;

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const run = (bin, args) => execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---------------------------------------------------------------- 前置

if (!existsSync(SEVEN_ZIP)) {
  console.error(`✗ 找不到 7-Zip：${SEVEN_ZIP}`);
  process.exit(1);
}
for (const [what, p] of [["MSI", MSI], ["release exe", EXE_RELEASE]]) {
  if (!existsSync(p)) {
    console.error(`✗ 缺 ${what}：${p}`);
    process.exit(1);
  }
}
if (existsSync(OUT_ZIP)) {
  console.error(`✗ 已存在 ${OUT_ZIP} —— 先把它挪走或删掉（本工具不覆盖已发布的包）`);
  process.exit(1);
}

// ---------------------------------------------------------------- 从 MSI 里取 exe 与许可（不重编包）

mkdirSync(EXTRACT, { recursive: true });
// 7z 对 MSI 会**自动钻进内嵌的 cab**，所以一条 `x` 就能拿到全部负载（实测：8 个文件）
// —— 不用先解 app.cab 再解里面的东西（那样第二次会找不到文件）
run(SEVEN_ZIP, ["x", "-y", `-o${EXTRACT}`, MSI]);
const extracted = readdirSync(EXTRACT).map((f) => path.join(EXTRACT, f));

// MSI 里的文件名是不透明的（`Path` / `PathFile_<hash>`）→ exe 用**尺寸**认（与 release exe 同尺寸）；
// 其余非 exe 负载不再按尺寸去猜哪份对哪个许可（本批改了 ICONS-LICENSE.md 的措辞，尺寸必变）——
// 只做两件可验证的事：① MSI 确实带了许可负载 ② 便携包发**当前源码**里那几份
const sizeOf = (p) => statSync(p).size;
const msiExe = extracted.find((p) => sizeOf(p) === sizeOf(EXE_RELEASE));
if (!msiExe) {
  console.error("✗ MSI 里找不到与 release exe 同尺寸的负载（清单变了？）");
  process.exit(1);
}
const resFiles = readdirSync(RESOURCES).map((f) => path.join(RESOURCES, f));
const nonExe = extracted.filter((p) => p !== msiExe);
const sameSize = nonExe.filter((p) => resFiles.some((r) => sizeOf(r) === sizeOf(p))).length;

// 断言①：便携包要用的 exe = **MSI 里的那一份**（发布物本体）；与 `target/release` 那份**报告**差异
// （实测：只差 3 字节 —— 构建戳 `MSI` vs `UNK`，Tauri 的 bundle 类型标记；见下面的报告）
const hMsi = sha256(msiExe);
const hRel = sha256(EXE_RELEASE);
if (hMsi !== hRel) {
  const a = readFileSync(msiExe);
  const b = readFileSync(EXE_RELEASE);
  let diff = 0;
  let first = -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      if (first < 0) first = i;
      diff++;
    }
  }
  const at = first >= 0 ? `${a.slice(first, Math.min(first + 8, a.length)).toString("latin1")} vs ${b.slice(first, Math.min(first + 8, b.length)).toString("latin1")}` : "-";
  console.log(`ℹ MSI 里的 exe 与 target/release 那份不是同一份：${diff} 个字节不同（首个偏移 ${first}："${at}"）`);
  console.log("  —— 这是 Tauri 打包时写进二进制的 **bundle 类型戳**（MSI / UNK），不是构建漂移。");
  console.log("  便携包用 **MSI 里那一份**（与安装包逐字节相同），下面的断言都基于它。");
  if (diff > 64) {
    console.error(`✗ 差异 ${diff} 字节 — 超过「构建戳」量级，当作真不一致，停下`);
    process.exit(1);
  }
}
// 断言②：许可负载齐全且像模像样
// ① MSI 带的非 exe 负载数 ≥ 源码 resources 里的份数（它确实把许可打进去了）
// ② resources 里每份都是许可类文件（-OFL.txt / ICONS-LICENSE.md），免得有人把别的东西放进来
if (nonExe.length < resFiles.length) {
  console.error(`✗ MSI 里只有 ${nonExe.length} 个非 exe 负载，少于源码 resources 的 ${resFiles.length} 份`);
  process.exit(1);
}
const odd = resFiles.filter((p) => !/(-OFL\.txt|ICONS-LICENSE\.md)$/.test(path.basename(p)));
if (odd.length) {
  console.error(`✗ src-tauri/resources 里混进了非许可文件：${odd.map((p) => path.basename(p)).join(" · ")}`);
  process.exit(1);
}
const extras = nonExe.filter((p) => !resFiles.some((r) => sizeOf(r) === sizeOf(p)));
console.log(`ℹ MSI 非 exe 负载 ${nonExe.length} 份（其中 ${sameSize} 份与当前 resources 同尺寸）；` +
  `便携包发**当前源码**里的 ${resFiles.length} 份许可` +
  (extras.length ? `（MSI 里另有 ${extras.length} 份对不上当前源码 —— 打包后改过，下次出包自动一致）` : ""));

// ---------------------------------------------------------------- 组装

mkdirSync(path.join(STAGE, TOP, "licenses"), { recursive: true });
copyFileSync(msiExe, path.join(STAGE, TOP, "WakeyWeeky.exe"));
writeFileSync(path.join(STAGE, TOP, "portable.flag"), "", "utf8");
copyFileSync(path.join(REPO, "docs", "公开仓", "便携版使用说明.txt"), path.join(STAGE, TOP, "使用说明.txt"));
for (const p of resFiles) copyFileSync(p, path.join(STAGE, TOP, "licenses", path.basename(p)));

execFileSync(SEVEN_ZIP, ["a", "-tzip", "-mx=9", OUT_ZIP, TOP], { cwd: STAGE, stdio: "inherit" }); // cwd 决定归档里的路径

// 断言③：压缩包完整性 + 内容清单
const listing = run(SEVEN_ZIP, ["l", OUT_ZIP]);
run(SEVEN_ZIP, ["t", OUT_ZIP]);
const zipHash = sha256(OUT_ZIP);

// Release 资产之一：校验值文本（和两个资产放同一目录）
const shaFile = path.join(path.dirname(OUT_ZIP), `WakeyWeeky_${version}_sha256.txt`);
writeFileSync(
  shaFile,
  [
    `WakeyWeeky ${version} — SHA256 校验值`,
    "",
    `${sha256(MSI)}  WakeyWeeky_${version}_x64_en-US.msi`,
    `${zipHash}  WakeyWeeky-${version}-portable.zip`,
    `${hMsi}  （便携包与安装包里的 WakeyWeeky.exe —— 两者逐字节相同）`,
    "",
    "怎么自己核（Windows cmd 或 PowerShell）：",
    "  certutil -hashfile 文件全名 SHA256",
    "和上面的值逐字符比对即可（大小写无所谓）。",
    "",
  ].join("\r\n"),
  "utf8",
);
const entries = listing.split(/\r?\n/).filter((l) => l.includes(TOP));
console.log(`\n✓ 便携包：${path.relative(REPO, OUT_ZIP)}`);
for (const e of entries) console.log(`  ${e.trim()}`);
console.log(`\n  exe sha256 = ${hMsi}（= MSI 里那一份；ZIP 里就它）`);
console.log(`  zip  sha256 = ${zipHash}`);
console.log(`  校验值文件 = ${path.relative(REPO, shaFile)}`);
console.log(`\n临时目录（可删）：${STAGE} · ${EXTRACT}`);
