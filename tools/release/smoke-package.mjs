// round92（R3 出包 / 发布）：**真包冒烟** —— 从 MSI 里取出那一份 exe，在临时便携目录里真跑起来，
// 用 CDP 核对「装的那个包真的能跑、跑的是这一版、DX-1 的固定底纹层在真包里成立」。
//
// 用法（仓库根跑；**先关掉正在运行的 WakeyWeeky** —— 单实例插件会把我们的启动转发给它，冒烟就测不到自己）：
//   node tools/release/smoke-package.mjs
//   node tools/release/smoke-package.mjs --expect-position absolute   # 先证红：故意期望错值 → 必须 FAIL
//   node tools/release/smoke-package.mjs --keep-temp                  # 少打一行「可删」提示（目录本来就不删）
//
// 为什么这么做（docs/plans/round92-出包发布.md §7.3）：
//   ① 跑的是 **MSI 里那份 exe**（与安装包逐字节相同），不是 `target/release` 那份；
//   ② 便携模式 + **预建空库** —— 便携目录里没有库时应用会 `VACUUM INTO` 拷一份**真库**过来（维护 §四），
//      所以必须先放一个空 sqlite；跑完再核对真库没被动过；
//   ③ 断言：页面挂起来 / 无运行时异常 / `body::before` 是 `fixed`（DX-1）/ exe 版本 = 包版本。
//
// 盲点（写清，不当保证）：属性面板的分隔线要有点任务才看得见（空库里没有任务）→ **不在这里断言**，交人眼。
// 退出码：0 = 全过；1 = 有 FAIL；2 = 前置缺件（没有 MSI / 没有 7-Zip / CDP 起不来）。
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SEVEN_ZIP = "C:/Program Files/7-Zip/7z.exe";
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const expectPosition = argOf("--expect-position", "fixed");
const OUT_DIR = path.resolve(REPO, argOf("--out", "docs/visual/round92"));

const conf = JSON.parse(readFileSync(path.join(REPO, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
// 期望版本单独可改：`--expect-version 1.0.2` 就是一次"版本断言该红"的证红（6b P1-4）
const expectVersion = argOf("--expect-version", version);
const BUNDLE = path.join(REPO, "src-tauri/target/release/bundle");
const MSI = path.join(BUNDLE, "msi", `WakeyWeeky_${version}_x64_en-US.msi`);
const EXE_RELEASE = path.join(REPO, "src-tauri/target/release/wakeyweeky.exe");
const RUN = path.join(os.tmpdir(), `ww92-smoke-${process.pid}`);
const EXTRACT = path.join(os.tmpdir(), `ww92-smoke-msi-${process.pid}`);
const REAL_DB_DIR = path.join(process.env.APPDATA ?? "", "com.wakeyweeky.app");
const REAL_DB = ["wakeyweeky.sqlite", "wakeyweeky.sqlite-wal", "wakeyweeky.sqlite-shm"].map((f) =>
  path.join(REAL_DB_DIR, f),
);

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
let failed = 0;
let skipped = 0;
function check(ok, label, detail = "") {
  rows.push({ ok, label, detail });
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` ｜ ${detail}` : ""}`);
}
/** 前置缺件 → 不算过也不算错，单独计（6b P2-4：以前条件跳过会让报告看起来少了一条） */
function skip(label, why) {
  skipped++;
  console.log(`— ${label}（跳过：${why}）`);
}

// ---------------------------------------------------------------- 前置

for (const [what, p] of [
  ["7-Zip", SEVEN_ZIP],
  ["MSI", MSI],
  ["release exe", EXE_RELEASE],
]) {
  if (!existsSync(p)) {
    console.error(`✗ 缺${what}：${p}${what === "MSI" ? "（先跑 npx tauri build）" : ""}`);
    process.exit(2);
  }
}
const snapshot = (files) =>
  files.map((f) => {
    if (!existsSync(f)) return `${path.basename(f)}: 不存在`;
    const s = statSync(f);
    // **内容**（size + sha256）才是判据：WAL 模式下只读打开会 touch `-shm`（维护 §四 记过这条），mtime 不算数
    return `${path.basename(f)}: ${s.size}B ${sha256(f).slice(0, 16)}`;
  });
const mtimes = (files) =>
  files.map((f) => (existsSync(f) ? `${path.basename(f)} @${new Date(statSync(f).mtimeMs).toISOString().slice(11, 19)}` : `${path.basename(f)} 不存在`));

// ---------------------------------------------------------------- ① 从 MSI 里取 exe

mkdirSync(EXTRACT, { recursive: true });
execFileSync(SEVEN_ZIP, ["x", "-y", `-o${EXTRACT}`, MSI], { stdio: "ignore" });
const extracted = readdirSync(EXTRACT).map((f) => path.join(EXTRACT, f));
const bySize = extracted.map((p) => ({ p, size: statSync(p).size })).sort((a, b) => b.size - a.size);
const msiExe = bySize[0];
const relSize = statSync(EXE_RELEASE).size;
check(
  msiExe && msiExe.size === relSize,
  "① MSI 里的负载里有与 release exe 同尺寸的那一份",
  `最大负载 ${msiExe ? `${msiExe.size}B` : "—"} · release exe ${relSize}B · MSI 共 ${extracted.length} 个文件`,
);
const exeSha = sha256(msiExe.p);

// 与 release exe 的差异只允许是 Tauri 的 bundle 类型戳（≤64 字节，口径同 make-portable）
{
  const a = readFileSync(msiExe.p);
  const b = readFileSync(EXE_RELEASE);
  let diff = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) diff++;
  check(diff <= 64, "①b MSI 里的 exe 与 release exe 只差构建戳（≤64 字节）", `差 ${diff} 字节`);
}

// 若已经打过便携包（Step 6 之后）→ 顺便核 sha256 文本里的那行 exe 值
const shaTxt = path.join(BUNDLE, `WakeyWeeky_${version}_sha256.txt`);
if (existsSync(shaTxt)) {
  const hit = readFileSync(shaTxt, "utf8").split(/\r?\n/).find((l) => l.includes("便携包与安装包里的"));
  check(!!hit && hit.includes(exeSha), "①c sha256 文本里的 exe 值 == 我们从 MSI 里取出的那一份", hit ? hit.slice(0, 80) : "没找到那行");
} else {
  skip("①c sha256 文本里的 exe 值", `还没有 ${path.basename(shaTxt)}（先跑 make-portable，再跑一次本工具就会核）`);
}

// ---------------------------------------------------------------- ② 便携目录（预建空库）

mkdirSync(path.join(RUN, "data"), { recursive: true });
copyFileSync(msiExe.p, path.join(RUN, "wakeyweeky.exe"));
writeFileSync(path.join(RUN, "portable.flag"), "", "utf8");
const RUN_DB = path.join(RUN, "data", "wakeyweeky.sqlite");
{
  const { DatabaseSync } = await import("node:sqlite");
  new DatabaseSync(RUN_DB).close(); // 预建空库：绕过「没库 → VACUUM INTO 拷真库」（维护 §四）
}
const realBefore = snapshot(REAL_DB);
const runDbBefore = statSync(RUN_DB).size;

// ---------------------------------------------------------------- 启动 + CDP

const PORT = 9411;
const app = spawn(path.join(RUN, "wakeyweeky.exe"), [], {
  cwd: RUN,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", "pipe", "pipe"],
});
const logs = [];
const grab = (d) => {
  const s = String(d);
  logs.push(s);
  process.stderr.write(`[app] ${s}`);
};
app.stdout.on("data", grab);
app.stderr.on("data", grab);

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  return null;
}
const wsUrl = await pageTarget();
if (!wsUrl) {
  console.error("✗ CDP 没起来（WebView2 没开调试端口）—— 冒烟无法进行");
  app.kill();
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (m) => {
  let msg;
  try {
    msg = JSON.parse(m.data);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params?.exceptionDetails;
    problems.push(`异常：${d?.exception?.description ?? d?.text ?? "未知"}`.slice(0, 300));
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ");
    problems.push(`console.error：${text}`.slice(0, 300));
  }
  if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
    problems.push(`log error：${msg.params.entry.text}`.slice(0, 300));
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.bringToFront");
await sleep(300);
// 重新加载一次：把「加载期」的异常也抓进 problems（连上去之前的那些就看不到了，如实记在盲点里）
await send("Page.reload", { ignoreCache: true });
let mounted = false;
for (let i = 0; i < 40 && !mounted; i++) {
  await sleep(500);
  try {
    mounted = await evaluate("document.readyState === 'complete' && !!document.querySelector('.timeline')");
  } catch {}
}
const probe = await evaluate(`(() => {
  const app = document.getElementById('app');
  const cs = getComputedStyle(document.body, '::before');
  return {
    appChildren: app ? app.children.length : -1,
    timeline: !!document.querySelector('.timeline'),
    pseudoPosition: cs.position,
    pseudoInset: cs.inset,
    pseudoZ: cs.zIndex,
    pseudoPointer: cs.pointerEvents,
  };
})()`);

check(mounted && probe.appChildren > 0 && probe.timeline, "③ 页面挂起来了（#app 有子节点 + .timeline 在）", `children=${probe.appChildren} · timeline=${probe.timeline}`);
check(problems.length === 0, "③b 加载期没有运行时异常 / console.error", problems.length ? problems.slice(0, 3).join(" / ") : "0 条");
// ④ 四个属性全断（6b P2-3：以前只断 position，验收却写成 inset / z / 不接指针都验了）
const wantPseudo = { position: expectPosition, inset: "0px", zIndex: "-1", pointerEvents: "none" };
const gotPseudo = {
  position: probe.pseudoPosition,
  inset: probe.pseudoInset,
  zIndex: probe.pseudoZ,
  pointerEvents: probe.pseudoPointer,
};
const pseudoBad = Object.entries(wantPseudo).filter(([k, v]) => gotPseudo[k] !== v);
check(
  pseudoBad.length === 0,
  `④ DX-1：body::before 是 ${expectPosition} 的固定层（position / inset / z / pointer-events 四项）`,
  `实际 ${JSON.stringify(gotPseudo)}` + (pseudoBad.length ? ` · 不符 ${pseudoBad.map(([k]) => k).join("/")}` : ""),
);

// ---------------------------------------------------------------- ⑤ 版本（exe 元数据）

let productVersion = "?";
try {
  productVersion = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-Item '${path.join(RUN, "wakeyweeky.exe")}').VersionInfo.ProductVersion`],
    { encoding: "utf8" },
  ).trim();
} catch (e) {
  productVersion = `读不到：${String(e.message).slice(0, 80)}`;
}
check(productVersion === expectVersion, "⑤ exe 的 ProductVersion == 包里声明的版本", `实际 ${productVersion} / 期望 ${expectVersion}`);

// ---------------------------------------------------------------- ②b 数据落点（便携生效 & 真库没动）

const runDbAfter = existsSync(RUN_DB) ? statSync(RUN_DB).size : -1;
const sidecars = ["wakeyweeky.sqlite-wal", "wakeyweeky.sqlite-shm"].filter((f) => existsSync(path.join(RUN, "data", f)));
// ② 两个证据：库被打开过（sidecar / 尺寸）+ 日志里有迁移行（说明 schema 建在**我们这份空库**里，而不是真库）
const migrated = logs.join("").includes("迁移 001 已应用");
check(
  (runDbAfter > runDbBefore || sidecars.length > 0) && migrated,
  "② 便携目录里的库被这次运行用上（有 sidecar / 变大 + 日志里有迁移行）",
  `库 ${runDbBefore}→${runDbAfter}B · sidecar ${sidecars.length} 个 · 迁移行 ${migrated ? "有" : "无"}`,
);
const realAfter = snapshot(REAL_DB);
// 6b P2-1：真库目录不存在时旧写法三行都是“不存在”→ 恒真。先断存在性，不存在就显式报错。
check(existsSync(REAL_DB_DIR), "②b0 真库目录在（否则“没碰真库”这条无从谈起）", REAL_DB_DIR || "APPDATA 空");
check(
  existsSync(REAL_DB_DIR) && JSON.stringify(realBefore) === JSON.stringify(realAfter),
  "②b 真库内容没变（size + sha256 同；`-shm` 的 mtime 会被只读连接 touch，不算判据）",
  `运行前后 mtime：${mtimes(REAL_DB).join(" · ")}`,
);

// ---------------------------------------------------------------- ⑥ 截图

mkdirSync(OUT_DIR, { recursive: true });
const shotPath = path.join(OUT_DIR, `真包-${version}.png`);
try {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  // 6b P1-4：`check(true, …)` 是白送的绿 → 真断「截出来像一张图」（PNG 头 + 尺寸下限）
  const shotSize = existsSync(shotPath) ? statSync(shotPath).size : 0;
  const head = existsSync(shotPath) ? readFileSync(shotPath).subarray(0, 8) : Buffer.alloc(0);
  const isPng = head.length === 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  check(isPng && shotSize > 20_000, "⑥ 截图落盘且像一张图（PNG 头 + >20KB）", `${path.relative(REPO, shotPath)} · ${(shotSize / 1024).toFixed(0)}KB`);
} catch (e) {
  check(false, "⑥ 截图落盘且像一张图", String(e.message).slice(0, 120));
}

// 6b P1-4：③b 以前只在挂载那一刻判一次 —— 现在在收尾前再判一次（截图 / IPC 回包期间的异常也算）
check(problems.length === 0, "③c 全程没有运行时异常 / console.error（含截图与回包之后）", problems.length ? problems.slice(0, 3).join(" / ") : "0 条");

ws.close();
app.kill();
await sleep(500);
try {
  execFileSync("taskkill", ["/PID", String(app.pid), "/F"], { stdio: "ignore" });
} catch {}

console.log(`\n启动日志（前 400 字）：${logs.join("").slice(0, 400).replace(/\s+/g, " ")}`);
console.log(`临时目录（可删，本工具不删任何东西）：${RUN} · ${EXTRACT}`);
console.log(
  `\n断言：${failed ? `FAIL ${failed} / ${rows.length}` : `ALLOK ${rows.length} 条`}${skipped ? `（跳过 ${skipped} 条，不计入通过）` : ""}`,
);
process.exit(failed ? 1 : 0);
