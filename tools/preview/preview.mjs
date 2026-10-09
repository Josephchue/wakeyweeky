// 假数据预览：**真前端产物** + **假的 Tauri IPC 数据**，在一个假数据的世界里截图。
//
// 为什么要有它：目视验证界面时，以前我是把测试数据种进用户的真实库再截图 —— 那既碰了用户数据，
// 又把用户真实的周计划拍进了图里（图会随对话上传）。这个工具让界面验证：
//   · 完全不碰用户数据库（应用根本没启动）
//   · 不抢焦点、不弹通知
//   · 画面里只有下面这份编造的假数据
//
// round25（§5-R）拆文件：注入页面的两段程序各自独立成文件 ——
//   · `tools/preview/fixture.js`：假数据 + 假后端 + 手势小工具（`window.__TAURI_INTERNALS__`）
//   · `tools/preview/checks.js` ：DOM 断言 + 截图前故意留的那个手势
// 以前它们被塞在**模板字符串**里（`const fixture = () => \`...\``），里面出现一个反引号（注释里也算）
// 就会把模板切断 → 整个 `preview.mjs` 解析失败、只报一个看不懂的 TypeError（同类错踩过 4 次）。
// 现在读文件 + `new vm.Script()` 语法预检：报错直接说「哪个文件第几行」。
//
// 用法：
//   npm run build                                  # 先出前端产物
//   node tools/preview/preview.mjs                 # 生成截图（默认写到临时目录 wakeyweeky-verify/）
//   node tools/preview/preview.mjs --out x.png     # 指定输出路径
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const args = process.argv.slice(2);
/** 仓库根（本脚本在 tools/preview/ 下）—— round85 用它读 `appearance.ts` 的 PALETTES 真源 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outArg = args.indexOf("--out");
/** 所有验证产物都收在这一个固定目录里（不再每次新建、不会越堆越多） */
const workDir = path.join(os.tmpdir(), "wakeyweeky-verify");
const out = outArg >= 0 ? args[outArg + 1] : path.join(workDir, "preview.png");
/**
 * round44：窗口宽度可调（默认 1500 = 老用法一字不变）。
 * 为什么需要：用户实测的翻车现场是**窄窗口**（总宽 ≈715px，时间轴面板 ≈400px）——
 * 固定 1500 的验证窗口永远复现不了「周范围被挤成竖排」（round44 用户截图）。
 */
const widthArg = args.indexOf("--width");
const width = widthArg >= 0 ? Number(args[widthArg + 1]) : 1500;
const height = 1040;
/**
 * round44：只跑名字含该子串的断言（例：`--only round44`）。
 * 为什么要它：窄窗口下有些老断言**本来就允许不成立**（如 round42 的「键位提示不被截断」——
 * 窄窗口就是会截断（键位提示条是硬裁 + `title` 全文），拿它们当窄窗口基线必红；所以窄窗口只跑本轮新断言。
 */
const onlyArg = args.indexOf("--only");
/**
 * round87（1.0.0 · 3.3 字体方案）：**字体档一维扫描**（`--font-scan`）—— 5 档 × zh/en × 1500/715 = 20 格。
 * 每格走**真设置路径**切字体族 + 语言，跑 `scanOverflow()`（与全矩阵同一套读类检查）。
 * 它自带 `--only ___none___` 与 `--no-probe` 的效果（不跑断言套件、不跑探针），只做这一维。
 * 为什么单开一维：全矩阵 98 格 × 5 档 = 490 格成本不成比例；字体只影响文字排布（`体-03` 口径）。
 */
const fontScan = args.includes("--font-scan");
let only = onlyArg >= 0 ? (args[onlyArg + 1] ?? "") : "";
if (fontScan) only = "___none___";
/** round52：看界面用 —— 跳过真输入探针（探针的**真双击**会点到复盘面板的遮罩上，
 *  「点空白关闭」是正确行为，但那样就拍不到开着的面板了） */
const noProbe = args.includes("--no-probe") || fontScan;
/** round64（C10）：首次使用（空库）模式 —— 卡片只在启动那一下判定，所以要页加载前就给标志 */
const firstRun = args.includes("--first-run");
/** round73：伪语言压力模式（`?pseudo=1`）—— 界面文案包上【…———】，用来验外置完整性与英文溢出 */
const pseudo = args.includes("--pseudo");
/**
 * round74（3.0b₂）：界面语言（`--locale en`）—— 假后端把 `ui_locale` 回 readonly 成 en，
 * 用来跑「英文真实排版」的溢出扫描（真产品读的是设置里的语言键）。
 */
const localeArg = args.indexOf("--locale");
const locale = localeArg >= 0 ? (args[localeArg + 1] ?? "zh") : "zh";
if (locale !== "zh" && locale !== "en") {
  console.error("--locale 只认 zh / en");
  process.exit(1);
}
/**
 * round76（3.1a）：外观三选（矩阵跑用）—— `--density compact|comfortable|loose` /
 * `--palette warm|cool|sage` / `--theme light|dark`。
 * 前两个由假后端当设置项回给前端（走真代码路径）；主题用 CDP `Emulation.setEmulatedMedia`
 * 固定（与真产品同一条件：CSS 只认 `prefers-color-scheme`）。
 */
const densityArg = args.indexOf("--density");
const density = densityArg >= 0 ? (args[densityArg + 1] ?? "comfortable") : "comfortable";
if (!["compact", "comfortable", "loose"].includes(density)) {
  console.error("--density 只认 compact / comfortable / loose");
  process.exit(1);
}
const paletteArg = args.indexOf("--palette");
const palette = paletteArg >= 0 ? (args[paletteArg + 1] ?? "warm") : "warm";
/** round85（0.31.0）：配色值域**从 `appearance.ts` 读**（一处真源）—— 不再第三次手抄那串 12 个 id */
const PALETTE_IDS = (() => {
  const ts = readFileSync(path.resolve(REPO_ROOT, "src/lib/utils/appearance.ts"), "utf8");
  const block = ts.match(/export const PALETTES = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  return [...block.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
})();
if (PALETTE_IDS.length !== 12) {
  console.error(`读 appearance.ts 的 PALETTES 失败（拿到 ${PALETTE_IDS.length} 个）`);
  process.exit(1);
}
if (!PALETTE_IDS.includes(palette)) {
  console.error(`--palette 只认：${PALETTE_IDS.join(" / ")}`);
  process.exit(1);
}
const themeArg = args.indexOf("--theme");
const theme = themeArg >= 0 ? (args[themeArg + 1] ?? "light") : "light";
if (!["light", "dark"].includes(theme)) {
  console.error("--theme 只认 light / dark");
  process.exit(1);
}
/**
 * round87（1.0.0 · 3.3 字体方案）：界面字体族（`--font default|song|kai|deng|mono`）——
 * 假后端当设置项回给前端（与 `--density` / `--palette` 同一条**真代码路径**：
 * 归一 → `applyAppearance` → `<html data-font>`）；截图与字体档扫描用它。
 */
const fontArg = args.indexOf("--font");
const font = fontArg >= 0 ? (args[fontArg + 1] ?? "default") : "default";
if (!["default", "song", "kai", "deng", "mono"].includes(font)) {
  console.error("--font 只认 default / song / kai / deng / mono");
  process.exit(1);
}

/**
 * round76（3.1a）：**全矩阵模式**（`--matrix`；可跟一个输出目录，默认 `docs/visual/3.1矩阵`）。
 * 72 格 = 3 配色 × 2 主题 × 3 密度 × 2 宽 × 2 语言；每格：改设置（真 UI 路径）→ 读类检查 → 截图（JPEG）。
 * 结果写 `matrix-results.json`，逐格明细打屏；任一格红 → 退出码 1。
 */
const matrix = args.includes("--matrix");
const matrixDirArg = args.indexOf("--matrix-dir");
const matrixDir =
  matrixDirArg >= 0 ? args[matrixDirArg + 1] : path.resolve("docs/visual/3.1矩阵");
/**
 * round76（3.1a）：**组件展示页模式**（`--gallery`）—— 逐档量真实组件的尺寸 + 截图。
 * 与矩阵共用一套「改一格」的实现（matrix.js 的 `setCell`），只是量的是尺寸表而不是扫描。
 */
const gallery = args.includes("--gallery");
const galleryDirArg = args.indexOf("--gallery-dir");
const galleryDir =
  galleryDirArg >= 0 ? args[galleryDirArg + 1] : path.resolve("docs/visual/3.1组件展示");
/** round76（3.1a）：全矩阵的**代表配色**（round85：12 套 → 取 3 套代表 —— 老套 / 直角新套 / 圆角新套；
    12 套逐套的读类扫描由断言组 `round85` 负责） */
const MATRIX_PALETTES = ["warm", "endfield", "north"];
const MATRIX_THEMES = ["light", "dark"];
const MATRIX_DENSITIES = ["compact", "comfortable", "loose"];
const MATRIX_WIDTHS = [1500, 715];
const MATRIX_LOCALES = ["zh", "en"];

/**
 * round57（C8）：**演示截图模式** —— `--shots <目录>` 时只注入 `fixture.js` + `shots.js`，
 * 一萕一张 PNG。断言套件不受影响（那是另一条路：`fixture.js` + `checks.js`）。
 * 为什么单开一道门：演示要的是「一屏一件事」（能截图给人看），断言要的是「快、密、不留手势」。
 */
const shotsArg = args.indexOf("--shots");
const shotsDir = shotsArg >= 0 ? args[shotsArg + 1] : "";
/**
 * round77：`--shots-file <相对 tools/preview 的路径>` —— 自定义场景表（默认 `shots.js`）。
 * 为什么加这个：以前的场景表只有 round61 一份（写死），后面每批要拍“某个状态的截图”都要改它；
 * 现在每批一个文件（`tools/preview/scenes/roundNN.js`），互不干扰。
 */
const shotsFileArg = args.indexOf("--shots-file");
const shotsFile = shotsFileArg >= 0 ? (args[shotsFileArg + 1] ?? "shots.js") : "shots.js";
if (!Number.isFinite(width) || width < 320) {
  console.error("--width 要是个 ≥320 的数字");
  process.exit(1);
}

const distDir = path.resolve("dist");
if (!existsSync(path.join(distDir, "index.html"))) {
  console.error("没有 dist/index.html —— 先跑 `npm run build`");
  process.exit(1);
}

const indexHtml = await readFile(path.join(distDir, "index.html"), "utf8");
const bundle = indexHtml.match(/src="([^"]+\.js)"/)?.[1];
const css = indexHtml.match(/href="([^"]+\.css)"/)?.[1];
if (!bundle) {
  console.error("dist/index.html 里找不到入口 JS");
  process.exit(1);
}

// ---------------------------------------------------------------- 注入脚本（独立文件 + 语法预检）
const INJECT_DIR = path.resolve("tools/preview");
const INJECT_FILES = shotsDir
  ? ["fixture.js", shotsFile]
  : gallery
    ? ["fixture.js", "checks.js", "matrix.js", "gallery.js"]
    : matrix
      ? ["fixture.js", "checks.js", "matrix.js"]
      : ["fixture.js", "checks.js"];

/** 读一份注入脚本并做语法预检 —— 报错要能直接看出「哪个文件第几行」 */
async function loadInject(file) {
  const full = path.join(INJECT_DIR, file);
  const src = await readFile(full, "utf8");
  try {
    new vm.Script(src, { filename: file });
  } catch (err) {
    // vm 的 SyntaxError 带文件名与行号（stack 第一行就是 `fixture.js:12:3`）——直接给出来最省事
    const where = String(err.stack ?? "").split("\n")[0] ?? file;
    console.error(`❌ 注入脚本有语法错误：${file}\n   ${where}\n   ${err.message}`);
    process.exit(1);
  }
  return src;
}

const injectSources = new Map();
for (const file of INJECT_FILES) injectSources.set(file, await loadInject(file));

const page = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>WakeyWeeky 预览（假数据）</title>
    ${css ? `<link rel="stylesheet" href="${css}?v=${Date.now()}" />` : ""}
    <style>body { margin: 0 }</style>
  </head>
  <body>
    <div id="app"></div>
    <script>window.__ONLY = ${JSON.stringify(only)}; window.__FIRST_RUN = ${firstRun}; window.__LOCALE = ${JSON.stringify(locale)}; window.__DENSITY = ${JSON.stringify(density)}; window.__PALETTE = ${JSON.stringify(palette)}; window.__THEME = ${JSON.stringify(theme)}; window.__FONT = ${JSON.stringify(font)};</script>
${INJECT_FILES.map((f) => `    <script src="/${f}"></script>`).join("\n")}
    <!--
      round82（Step 4 挖出来的 harness bug）：入口**不许带查询串**。
      带 ?v= 时，文档里加载的是 /assets/index-XXX.js?v=...，而 bundle 里的
      「侥幸动态 import」（Vite 把没分出去的模块改写成一指向**入口自己**、不带查询串）是
      /assets/index-XXX.js —— 浏览器当成**两个模块** → 入口被求值两次 → main.ts 里的
      mount(App, #app) 跑两遍 → 应用挂两份（两套 Timeline / 两份 window 监听）：
      一次 Ctrl+Z 发两条 undo、一次「归档」发两条、DOM 里 14 个天列…… 后面全线假红。
      （真机上入口永远不带查询串，所以只有预览工具需要这条铁律。）
      防旧 bundle 靠下面响应头的 cache-control: no-store（不靠查询串）。
    -->
    <script type="module" src="${bundle}"></script>
  </body>
</html>
`;

/** 静态文件类型（只需要这几个） */
const TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url === "/" || url === "/preview.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page);
    return;
  }
  if (injectSources.has(url.slice(1))) {
    // 注入脚本也走 no-store：它们是文件，改了要立刻生效
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(injectSources.get(url.slice(1)));
    return;
  }
  try {
    const file = await readFile(path.join(distDir, url));
    const type = TYPES[path.extname(url)] ?? "application/octet-stream";
    // no-store：否则 Edge 的持久 profile 会命中旧 bundle —— 换新构建后会“假绿”✗（我撞过一次）
    res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
    res.end(file);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edge) {
  console.error("找不到 msedge.exe");
  server.close();
  process.exit(1);
}

/**
 * round25：**不再用 `--virtual-time-budget`**。
 * 原因：虚拟时间会被 rAF 循环（自动滚动那个循环就是这么写的）拖着跑，跑到一半就被判「预算用尽」，
 * 表现是「断言跑到一半冻结」——排查它花了半轮时间（并一度误判成产品死循环）。
 * 现在：真时间跑 + CDP 轮询 `document.title`（页面把断言结果写在那里），拿到就截图收工。
 */
const profile = path.join(workDir, "edge-profile");
await mkdir(workDir, { recursive: true }); // Edge 要把截图与 profile 写进这里，必须先建好
/**
 * 调试端口：从 19300 起试几个。
 * 不能固定用常见端口 —— 这台机器上 9xxx 段有被系统保留的（bind 直接 WSAEACCES 0x271D）。
 */
let debugPort = 0;
for (const candidate of [19301, 19313, 19327, 19341, 19357]) {
  try {
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(candidate, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
    debugPort = candidate;
    break;
  } catch {
    /* 这个端口不能用，试下一个 */
  }
}
if (!debugPort) {
  console.error("找不到可用的调试端口");
  server.close();
  process.exit(1);
}
const child = spawn(
  edge,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${debugPort}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
child.stderr?.on("data", (d) => {
  const text = String(d);
  if (text.trim() && !text.includes("QQBrowser") && !text.includes("GetUpdates")) {
    process.stderr.write("[edge] " + text);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 CDP 端点起来，拿页面 target 的 WebSocket 地址 */
async function waitForTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  return null;
}

const wsUrl = await waitForTarget();
if (!wsUrl) {
  console.error("连不上 Edge 的调试端口");
  child.kill();
  server.close();
  process.exit(1);
}

/** 极简 CDP 客户端：够用就行（不需要第三方依赖） */
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let msgId = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  let msg = null;
  try {
    msg = JSON.parse(String(ev.data));
  } catch {
    return; // 不是 JSON 的帧（不该有）——忽略，别把工具炸掉
  }
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.error) {
    waiter.reject(new Error(JSON.stringify(msg.error)));
  } else {
    waiter.resolve(msg.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Runtime.enable");
// round76（3.1a）：把主题固定住（CDP 改的偏好对 `prefers-color-scheme` 生效 —— 与真产品同一条 CSS 路径）
await send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: theme }],
});
await send("Page.navigate", { url: `http://127.0.0.1:${port}/preview.html${pseudo ? "?pseudo=1" : ""}` });

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  return r?.result?.value;
};

/** 等异步表达式（场景的 `run()` 是 Promise）—— 与上面那个的区别只有 `awaitPromise`
 *  round79：**错误不再被吞** —— CDP 把页面里的异常放在 `exceptionDetails`（不是协议错误），
 *  旧写法 `return r?.result?.value` 会静默返回 undefined → 「场景报错」永远不打印（实测：
 *  `--shots` 里故意 throw 也不报）。现在把页面异常的文本抛出来。
 */
const evaluateAsync = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  const ex = r?.exceptionDetails;
  if (ex) {
    throw new Error(
      ex.exception?.description ?? ex.text ?? JSON.stringify(ex).slice(0, 300),
    );
  }
  return r?.result?.value;
};

// ---------------------------------------------------------------- 演示模式：一幕一张图
if (shotsDir) {
  await mkdir(shotsDir, { recursive: true });
  let scenes = null;
  for (let i = 0; i < 150 && !scenes; i++) {
    scenes = await evaluate("JSON.stringify((window.__SHOTS || []).map((s) => s.name))").catch(
      () => null,
    );
    if (!scenes) await sleep(100);
  }
  const names = (() => {
    if (!scenes) return [];
    try {
      return JSON.parse(scenes);
    } catch {
      return [];
    }
  })();
  if (names.length === 0) {
    console.error(`❌ 页面里没有 window.__SHOTS（${shotsFile} 没注入 / 报错了）`);
    ws.close();
    child.kill();
    server.close();
    process.exit(1);
  }
  // round79（工具坑）：第一幕可能在**骨架还没渲染出来**时开拍（`--shots` 实测：
  // `.review-open` 查不到 → 场景静默什么也没发生、图里空空白白）——先等骨架出来（最多 10s）。
  for (let i = 0; i < 100; i++) {
    const ready = await evaluate(`!!document.querySelector(".week-nav")`).catch(() => false);
    if (ready) break;
    await sleep(100);
  }
  for (let i = 0; i < names.length; i++) {
    const failed = await evaluateAsync(`window.__SHOTS[${i}].run()`).then(
      () => null,
      (e) => String(e),
    );
    await sleep(400); // 让 Svelte 把这一帧画完
    const shot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    const file = path.join(shotsDir, `${String(i + 1).padStart(2, "0")}-${names[i]}.png`);
    if (shot?.data) await writeFile(file, Buffer.from(shot.data, "base64"));
    console.log(`${i + 1}/${names.length} ${names[i]} → ${file}${failed ? `（场景报错：${failed}）` : ""}`);
  }
  ws.close();
  child.kill();
  server.close();
  console.log(`演示截图完成：${names.length} 张（窗口 ${width}px）→ ${shotsDir}`);
  process.exit(0);
}

// 等页面把断言结果写进 document.title（页面侧是 setTimeout(700) 起跑）
let title = "(没拿到 title)";
let state = "";
/** 现场状态表达式：轮询时看进度，**截图前再读一次**（否则打印的是起跑前的旧值 —— round52 我拿它扑空过） */
const STATE_EXPR =
  "document.documentElement.dataset.checks + ' / ' + (document.documentElement.dataset.checksRun || '-')" +
  " + ' ｜ 提示=' + (document.querySelector('.gesture-hint')?.textContent?.trim() ?? '-')" +
  " + ' ｜ 块数=' + document.querySelectorAll('[data-block-id]').length" +
  " + ' ｜ 辅助线=' + document.querySelectorAll('.align-line').length" +
  " + ' ｜ 滚动=' + Math.round(document.querySelector('.scroll')?.scrollTop ?? 0)" +
  " + ' ｜ 拖影=' + document.querySelectorAll('body > div[style*=position]').length" +
  " + ' ｜ 复盘面板=' + (() => { const p = document.querySelector('.review-panel'); if (!p) return '无'; const cs = getComputedStyle(p); const r = p.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) + ' op' + cs.opacity + ' vis' + cs.visibility + ' z' + cs.zIndex + ' disp' + cs.display; })()";
/**
 * round86（工具改进）：**卡住时看得见卡在哪一条、页面还活不活**；等待窗可放宽。
 * 为什么加：长套件（386 条）在负载高的机器上会跑不完 90s —— 旧输出只有「没拿到 title」
 * + 一行**最后一次**读到的状态，分不清「某条断言在空转」与「整页冻住」。
 * `WW_PROGRESS=1`：每 2s 打一行（`perf` = 页面自己的时钟；它还在涨 = 事件循环还活着）。
 * `WW_DEADLINE_MS=240000`：放宽等待窗（实测本机负载高时套件要 ~110s）。
 */
const progress = process.env.WW_PROGRESS === "1";
const waitMs = Number(process.env.WW_DEADLINE_MS ?? "") || 90_000;
const waitStart = Date.now();
let lastProgress = 0;
while (Date.now() < waitStart + waitMs) {
  const t = await evaluate("document.title").catch(() => null);
  if (typeof t === "string" && (t.startsWith("ALLOK") || t.startsWith("FAIL"))) {
    title = t;
    break;
  }
  state = (await evaluate(STATE_EXPR).catch(() => null)) ?? state;
  if (progress && Date.now() - lastProgress > 2000) {
    lastProgress = Date.now();
    const perf = await evaluate("Math.round(performance.now())").catch(() => null);
    console.log(`[进度 ${((Date.now() - waitStart) / 1000).toFixed(1)}s · perf=${perf}] ${state.slice(0, 150)}`);
  }
  await sleep(200);
}

// 调试用：`WW_DUMP_DIAG=1` 时把页面里**全部**诊断打印出来（默认标题只带最后 40 条 —— 长套件里
// 靠前那条断言的现场会被挤掉，排查要重新单跑；round77 加这个临时开关，用完即删）。
if (process.env.WW_DUMP_DIAG) {
  const all = await evaluate("JSON.stringify(window.__DIAG ?? [])").catch(() => null);
  if (all) {
    console.log("===== 全量 DIAG =====");
    try {
      for (const line of JSON.parse(all)) console.log(line);
    } catch {
      console.log("（诊断不是合法 JSON，原样打）");
      console.log(all);
    }
    console.log("===== /全量 DIAG =====");
  }
}

/**
 * round48：**真输入探针**（CDP `Input.dispatchMouseEvent`）—— 只有可信输入才复现得出这一类 bug。
 *
 * 用户实测「BACKLOG 里的任务没法改任务名」的根因是**指针捕获**：拖拽引擎以前在 `pointerdown`
 * 就 `setPointerCapture`，浏览器于是把 `click/dblclick` 也发给**捕获元素**（整行），
 * 挂在任务名（行内子元素）上的双击处理函数永远收不到 ✗。合成 `PointerEvent` 不会建立
 * 「活跃指针」→ 捕获那一步在预览里被 try/catch 吞掉 → **老工具一直是绿的**（盲点）。
 * 这里用 CDP 发**真的**鼠标事件（两次 clickCount 递增 = 双击），看改名输入框出不出来。
 */
async function realDoubleClickRenameProbe() {
  // round64.1（CF，用户 2026-10-04 欠债）：先收起可能压在上面的遮罩层
  //（总览 / 说明页留着的 backdrop 会把真点击吃掉 —— 拾到就是它），再挑一个真能点到的任务名。
  await evaluate(`(() => {
    document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click());
    return true;
  })()`).catch(() => {});
  await sleep(120);
  const info = await evaluate(
    `(() => {
       const dbg = [];
       const tryPick = () => {
         const items = [...document.querySelectorAll(".list .item")];         for (let i = 0; i < items.length; i++) {
           const label = items[i].querySelector(".label");
           if (!label) continue;
           const r = label.getBoundingClientRect();
           const x = Math.round(r.left + Math.min(24, r.width / 2));
           const y = Math.round(r.top + r.height / 2);
           const hit = document.elementFromPoint(x, y);
           if (i < 3) {
             dbg.push({
               i,
               r: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
               x,
               y,
               hit: hit ? String(hit.className || "") || hit.tagName : "null",
               isLabel: !!hit && !!hit.closest && hit.closest(".label") === label,
             });
           }
           if (hit && hit.closest(".label") === label) {
             return { x, y, title: label.textContent.trim(), vw: window.innerWidth, vh: window.innerHeight };
           }
         }
         return null;
       };
       let found = tryPick();
       if (!found) {
         const list = document.querySelector(".list");
         if (list) list.scrollTop = 48; // 第一行常在吸顶表头下 → 往下滚一点再看
         found = tryPick();
       }
       return found ?? { debug: dbg.slice(0, 3), vw: window.innerWidth, vh: window.innerHeight };
     })()`,
  ).catch(() => null);
  if (!info || info.x == null) {
    return { ok: false, why: "找不到可点的 Backlog 任务名 " + JSON.stringify(info) };
  }
  const click = async (clickCount) => {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: info.x, y: info.y, button: "left", buttons: 1, clickCount,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: info.x, y: info.y, button: "left", buttons: 0, clickCount,
    });
  };
  await click(1);
  await sleep(40);
  await click(2); // 第二次带上 clickCount=2 → 浏览器自己派发 dblclick
  await sleep(150);
  const opened = await evaluate(`!!document.querySelector(".list .item input.edit")`).catch(() => false);
  // 收尾：Esc 放弃这次编辑（别把后面的截图带脏）
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    }).catch(() => {});
  }
  await sleep(60);
  return {
    ok: !!opened,
    title: info.title,
    // 失败时把落点现场带出来（窄窗口诊断用；成功就不用看了）
    ...(opened
      ? {}
      : {
          why: `x=${info.x} y=${info.y}（视口 ${info.vw}x${info.vh}）`,
        }),
  };
}

/**
 * round61（10.2 多选）：真 **Ctrl+左键** 加选 —— 合成 `PointerEvent` 能带修饰键，但
 * 「真按下 → 修饰键送进 `pointerdown` → 拖动引擎让路 → 动作条出现」这条真浏览器路径只有真输入测得出来。
 * 步骤：真点 m1（单选）→ 真 Ctrl+点 m2（加选）→ 断言动作条出现且「已选 2 块」。
 * m1/m2 不在（跑的是 `--only` 其它组，没种 round61 靶子块）→ 跳过（不算失败）。
 */
async function realCtrlClickMultiSelectProbe() {
  const exists = await evaluate(
    `!!document.querySelector('[data-block-id="m1"]') && !!document.querySelector('[data-block-id="m2"]')`,
  ).catch(() => false);
  if (!exists) return { ok: true, skipped: true };
  // 先把靶子块滚进视野（前面的断言/截图手势可能把时间轴滚到别处了）
  // round61.2：715px 下还要**把横向滚回最左** —— 截图手势（拖到周六）的自动滚屏会把周一列
  // 推到吸左的刻度栏底下（元素量得到、但点在刻度栏上→点不到块）。
  await evaluate(`(() => {
    document.querySelector('.scroll').scrollLeft = 0;
    document.querySelector('[data-block-id="m1"]')?.scrollIntoView({ block: "center" });
    return true;
  })()`).catch(
    () => {},
  );
  await sleep(80);
  // 窄窗口（715px）下块很窄，固定 left+20 可能正落在按钮/把手上（那一下不会选中）→ 扫一个真正的块身点；
  // 而且**每次点之前重新量**（第一次点会让键位提示条出现、板子下移 —— 715px 下这个偏移足以点空）。
  await evaluate(`window.__probeBodyPoint = (id) => {
    const sel = '[data-block-id="' + id + '"]';
    const node = document.querySelector(sel);
    const r = node?.getBoundingClientRect();
    if (!node || !r) return null;
    for (let fy = 0.3; fy <= 0.7; fy += 0.2) {
      for (let fx = 0.5; fx >= 0.15; fx -= 0.05) {
        const x = Math.round(r.left + r.width * fx);
        const y = Math.round(r.top + r.height * fy);
        const t = document.elementFromPoint(x, y);
        if (t && t.closest(sel) === node && !t.closest("button") && !t.closest(".resize")) {
          return { x, y };
        }
      }
    }
    return null;
  }; true`).catch(() => {});
  const clickPoint = (id) =>
    evaluate(`window.__probeBodyPoint ? window.__probeBodyPoint('${id}') : null`).catch(() => null);
  const click = async (pt, modifiers) => {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1, modifiers,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 0, clickCount: 1, modifiers,
    });
  };
  const pa = await clickPoint("m1");
  if (!pa) return { ok: false, why: "量不到 m1 的块身点" };
  await click(pa, 0);
  await sleep(120);
  const afterFirst = await evaluate(`document.querySelectorAll('.block.selected').length`).catch(() => -1);
  const pb = await clickPoint("m2");
  if (!pb) return { ok: false, why: "量不到 m2 的块身点", afterFirst };
  await click(pb, 2); // 2 = Ctrl（CDP 修饰键位图：Alt=1 / Ctrl=2 / Meta=4 / Shift=8）
  await sleep(150);
  const st = await evaluate(`(() => {
    const bar = document.querySelector('.bulk-bar');
    return {
      bar: !!bar,
      count: document.querySelectorAll('.block.selected').length,
      text: bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : '',
    };
  })()`).catch((e) => ({ err: String(e) }));
  // 收尾：保留这次多选给截图看（不动它）
  return { ok: !!st?.bar && st.count === 2 && st.text.includes("已选 2 块"), afterFirst, ...st };
}

/**
 * round67：**细轨恢复入口**的真输入探针（6b P1-1 的机器证据）。
 *
 * 为什么必须有它：① 合成 click **不做命中测试**（谁盖住都照样触发）；② 合成 mouseenter 触发不了 CSS `:hover`。
 * 这条探针用真指针量：**悬停细轨不该弹任何东西、也不该推动时间轴**（round67.1 你实测的「把表挡住」），
 * 点整条窄条必须回到展开。
 * 流程：真点 `«` 收起 → 真 hover 窄条（量时间轴左边缘 + 有没有 peek 类）→ 真点窄条 → 必须回展开。
 */
async function realRailExpandProbe() {
  const railState = await evaluate(`(() => {
    const b = document.querySelector(".backlog");
    if (!b) return "none";
    return b.classList.contains("rail") ? "rail" : "open";
  })()`).catch(() => "none");
  if (railState === "none") return { ok: true, skipped: true };
  await evaluate(`document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click()); true`).catch(() => {});
  await sleep(60);
  const centerOf = (sel) =>
    evaluate(
      `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null;
         const r = n.getBoundingClientRect();
         return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    ).catch(() => null);
  const clickAt = async (pt) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, buttons: 0 });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 0, clickCount: 1,
    });
  };
  // ① 先收起来（不在细轨态才需要）
  if (railState === "open") {
    const p = await centerOf(".backlog .collapse");
    if (!p) return { ok: false, why: "量不到收起钮", railState };
    await clickAt(p);
    await sleep(180);
  }
  const railOn = await evaluate(`!!document.querySelector(".backlog.rail")`).catch(() => false);
  // ② 指针真移到细轨上（触发 peek），再在 `»` 中心真点一下
  const p2 = await centerOf(".backlog.rail .rail-strip");
  if (!p2) return { ok: false, why: "细轨里量不到窄条", railOn, railState };
  // round67.1：悬停不该弹任何东西、也不该推动时间轴；展开靠**点整条**
  const leftBefore = await evaluate(
    `Math.round(document.querySelector(".timeline").getBoundingClientRect().left)`,
  ).catch(() => -1);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p2.x, y: p2.y, buttons: 0 });
  await sleep(140);
  const peekOn = await evaluate(`!!document.querySelector(".backlog.rail.peek")`).catch(() => false);
  const leftHover = await evaluate(
    `Math.round(document.querySelector(".timeline").getBoundingClientRect().left)`,
  ).catch(() => -1);
  await clickAt(p2);
  await sleep(220);
  const openBack = await evaluate(`(() => {
    const b = document.querySelector(".backlog");
    return !!b && !b.classList.contains("rail");
  })()`).catch(() => false);
  return {
    ok: railOn && !peekOn && leftBefore === leftHover && openBack,
    railOn,
    peekOn,
    leftBefore,
    leftHover,
    openBack,
    railState,
  };
}

/**
 * round70（DA，用户 2026-10-05 验收 round69.1 带回）：**分组开着时，任务 ⚙ 里改分类会被旧值盖回去**。
 *
 * 用户原话：「分组键开着的时候，我在任务的菜单里面修改任务的种类会被阻止，没法编辑」。
 * 根因（上一会话已定位）：`CategoryPicker.pick()` 先 `commit()` 再 `closeList()` —— 列表一关，
 * `shown` 立刻回落到**还没更新的 prop**（旧分类），Svelte 把旧值写回输入框；这一瞬的失焦
 * （分组会把任务搬到另一堆 → 输入框被拆掉/重建）又走 `onblur`「失焦也保存」，把新值盖回去 ✗。
 * 合成指针测不出这一类（焦点/失焦与真指针绑定）→ 必须走 CDP 真输入。
 *
 * 五个场景（各挑一条任务，互不借靶子；每个场景都从假库现挑一条**不等于当前值**的分类）：
 *   ① 前置：打字新建一条「探针甲」（全量收尾时假库可能一条分类不剩，后面两个「拍选已有」没靶子）
 *   A 分组 ON + 拍选一个已有分类 → 只该写一次；库 / 框里 / 所在堆都必须是新分类（这是 bug 现场）
 *   B 分组 OFF + 拍选一个已有分类 → 同上（对照：这条路以前就是好的）
 *   C 分组 ON + 打一个新分类名 + 回车 → 同上（同一条路的另一支）
 *   D 分组 ON + 点「（不设分类）」→ `commit("")` 这条支（`pending = null` / `pending ?? ""` 的兜底）
 * 失败时把「每次 update_task 的参数 + 调用栈」带出来 —— 第二次写是谁发的，一眼看到。
 */
async function realCategoryPickProbe() {
  await evaluate(`document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click()); true`).catch(() => {});
  await sleep(80);
  // 记每次 update_task 的参数与调用栈（第二次写是谁发的，靠它）
  await evaluate(
    `(() => {
       window.__DA_WRITES = [];
       const I = window.__TAURI_INTERNALS__;
       if (!I.__daWrapped) {
         const orig = I.invoke;
         I.invoke = async (cmd, args) => {
           if (cmd === "update_task") {
             window.__DA_WRITES.push({
               arg: JSON.parse(JSON.stringify(args ?? {})),
               stack: String((new Error().stack) || "").split("\\n").slice(1, 6).join(" / "),
             });
           }
           return orig(cmd, args);
         };
         I.__daWrapped = true;
       }
       return true;
     })()`,
  );
  const clickAt = async (pt) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, buttons: 0 });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 0, clickCount: 1,
    });
  };
  const key = async (k, code, vk) => {
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      }).catch(() => {});
    }
  };
  const centerOf = (expr) =>
    evaluate(
      `(() => { const n = ${expr}; if (!n) return null; const r = n.getBoundingClientRect();
         return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    ).catch(() => null);
  /**
   * round76：把一个元素滚进视野，直到「它的中心真的能点到」（返回可点的屏幕坐标）。
   *
   * 为什么需要：真鼠标点不到屏外/被裁掉的坐标 —— 量到的矩形可能落在 Backlog 可视区之外，
   * 那种坐标点下去命中的是**别的行**（实测：点到了另一行的 label），探针就假红了。
   * 行高/字号变大后这一点更容易触发（面板会伸到可视区外）。
   */
  const pointOnElement = async (expr, tries = 6) => {
    for (let i = 0; i < tries; i++) {
      await evaluate(
        `(() => { const n = ${expr}; if (n) n.scrollIntoView({ block: "center" }); })()`,
      ).catch(() => {});
      await sleep(140);
      const hit = await evaluate(
        `(() => { const n = ${expr}; if (!n) return null; const r = n.getBoundingClientRect();
           const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
           const at = document.elementFromPoint(x, y);
           // 点到元素本身 / 它的祖先（label 包着输入框也算数，点 label 会把焦点给控件）
           return at && (at === n || at.contains(n) || n.contains(at)) ? { x, y } : null; })()`,
      ).catch(() => null);
      if (hit) return hit;
    }
    return null;
  };
  const rowOf = (title) =>
    '[...document.querySelectorAll(".list .item")].find((n) => { const l = n.querySelector(".label"); return l && l.textContent.trim() === ' +
    JSON.stringify(title) +
    '; })';
  const groupedNow = () => evaluate('!!document.querySelector(".group-toggle.on")').catch(() => false);
  const setGrouped = async (want) => {
    if ((await groupedNow()) === want) return true;
    const p = await centerOf('document.querySelector(".group-toggle")');
    if (!p) return false;
    await clickAt(p);
    await sleep(220);
    return (await groupedNow()) === want;
  };
  const clearWrites = () => evaluate('(window.__DA_WRITES = [], true)').catch(() => false);
  /** 假库现算：这条任务在不在、当前分类、以及一个**不等于它**的已有分类（列表里点得到） */
  const planFor = (title) =>
    evaluate(`(() => {
       const t = FIX.tasks.find((x) => x.title === ${JSON.stringify(title)});
       if (!t) return { found: false, cur: null, target: null };
       const cur = t.category ?? "";
       const all = [...new Set(FIX.tasks.map((x) => x.category).filter(Boolean))];
       return { found: true, cur, target: all.find((c) => c !== cur) || null };
     })()`).catch(() => null);
  const read = (title) =>
    evaluate(`(() => {
       const row = ${rowOf(title)};
       const t = FIX.tasks.find((x) => x.title === ${JSON.stringify(title)});
       return {
         db: t ? (t.category ?? null) : "任务没了",
         group: row ? row.getAttribute("data-group") : null,
         shown: row ? (row.querySelector("input.cat-input")?.value ?? null) : null,
         writes: (window.__DA_WRITES || []).map((w) => w.arg && w.arg.category),
         stacks: (window.__DA_WRITES || []).map((w) => w.stack),
         events: window.__DA_EV || [],
       };
     })()`).catch((e) => ({ err: String(e) }));
  /** 走一遍真操作：真点 ⚙（若没开）→ 真点分类框 → 拍选 `target`（或打新名字 + 回车） */
  const scenario = async (title, kind, newName) => {
    const plan = await planFor(title);
    if (!plan || !plan.found) return { title, err: "找不到这条任务" };
    // 行可能滚在视野外（全量收尾时列表很长）—— 真鼠标点不到屏外坐标 → 先滚进来
    await evaluate(`${rowOf(title)}?.scrollIntoView({ block: "center" })`).catch(() => {});
    // round76：行高跟密度涨过（28→32）—— 滚完多等一下再量坐标，免得点空（实测偶发一次）
    await sleep(240);
    if (kind === "pick" && plan.target == null) return { title, err: "没有第二条分类可挑" };
    const target = kind === "new" ? newName : kind === "clear" ? "" : plan.target;
    if (kind === "new") {
      const exists = await evaluate(`FIX.tasks.some((x) => x.category === ${JSON.stringify(target)})`).catch(() => true);
      if (exists) return { title, err: "新分类名已存在（假库没重置？）" };
    }
    const hasProps = await evaluate(`!!(${rowOf(title)}?.querySelector(".props"))`).catch(() => false);
    if (!hasProps) {
      const p = await centerOf(`${rowOf(title)}?.querySelector(".props-toggle")`);
      if (!p) return { title, err: "量不到 ⚙" };
      await clickAt(p);
      await sleep(220);
    }
    // round76：面板开了先把它滚进视野再量（行高/字号变大后，面板会伸到 Backlog 可视区之外 ——
    // 那时按「输入框中心」的屏幕坐标点下去，命中的是**别的行**（实测：点到了 label）→ 假红）
    const field = await pointOnElement(`${rowOf(title)}?.querySelector("input.cat-input")`);
    if (!field) {
      // 点不到就把「那一点上到底压着谁」拍下来（行高/字号一改，坐标就可能落在别的元素上）
      const why = await evaluate(
        `(() => { const row = ${rowOf(title)}; const input = row && row.querySelector("input.cat-input");\n` +
          `  if (!input) return "输入框不在 DOM 里";\n` +
          `  const r = input.getBoundingClientRect();\n` +
          `  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);\n` +
          `  const pane = document.querySelector(".pane"); const pr = pane ? pane.getBoundingClientRect() : null;\n` +
          `  const box = input.closest(".props"); const item = input.closest(".item");
` +
          `  const cs = item ? getComputedStyle(item) : null; const cb = box ? getComputedStyle(box) : null;
` +
          `  return "框@" + [r.left, r.top, r.width, r.height].map(Math.round).join(",") + " 行高=" + (item ? item.offsetHeight + "/" + item.getBoundingClientRect().height : "?") + " 行样式=" + (cs ? cs.display + "/" + cs.flexWrap + "/" + cs.height : "?") + " 面板pos=" + (cb ? cb.position + "/" + cb.flexBasis + "/offTop=" + box.offsetTop + "/offH=" + box.offsetHeight : "?") + " 面板可视区=" + (pr ? [pr.top, pr.bottom, pane.scrollTop].map(Math.round).join(",") : "无") + " 叠层=" + document.elementsFromPoint(x, y).slice(0, 5).map((n) => { const b = n.getBoundingClientRect(); return n.tagName + "." + (typeof n.className === "string" ? n.className : "").replace(/svelte-[a-z0-9]+/g, "").trim() + "@" + [b.left, b.top, b.width, b.height].map(Math.round).join(",") + (n.contains(input) ? "⧉" : ""); }).join(" > ");\n` +
          `})()`,
      ).catch(() => "量不到");
      return { title, err: "分类框点不到（" + why + "）" };
    }
    // 事件级取证：输入框上的 blur / focusout / input，以及它被从 DOM 拆掉的那一刻
    //（失败时能看出「第二笔写」是不是失焦造成的，以及当时框里是什么）
    await evaluate(`(() => {
      const row = ${rowOf(title)};
      const input = row && row.querySelector("input.cat-input");
      if (!input) return false;
      window.__DA_EV = [];
      const rec = (what) => window.__DA_EV.push(what + "=" + input.value);
      input.addEventListener("blur", () => rec("blur"));
      input.addEventListener("focusout", () => rec("focusout"));
      input.addEventListener("input", () => rec("input"));
      const obs = new MutationObserver((ms) => {
        for (const m of ms)
          for (const n of m.removedNodes)
            if (n === input || (n.nodeType === 1 && n.contains(input))) rec("removed");
      });
      obs.observe(document.body, { childList: true, subtree: true });
      return true;
    })()`).catch(() => {});
    await clearWrites();
    // 点之前先拍一张：这一刻坐标底下是谁、面板还在不在（失败时才能分清「坐标漂了 / 被盖了 / 面板没了」）
    const pre = await evaluate(
      `(() => {\n` +
        `  const el = document.elementFromPoint(${Math.round(field.x)}, ${Math.round(field.y)});\n` +
        `  const row = ${rowOf(title)};\n` +
        `  const input = row && row.querySelector("input.cat-input");\n` +
        `  const r = input ? input.getBoundingClientRect() : null;\n` +
        `  const rr = row ? row.getBoundingClientRect() : null;\n` +
        `  return "点前底下=" + (el ? el.className || el.tagName : "null") + " 框=" + (r ? [r.left, r.top, r.width, r.height].map(Math.round).join(",") : "无") + " 行=" + (rr ? [rr.left, rr.top, rr.width, rr.height].map(Math.round).join(",") : "无") + " 面板=" + !!${rowOf(title)}?.querySelector(".props") + " 叠层=" + document.elementsFromPoint(${Math.round(field.x)}, ${Math.round(field.y)}).slice(0, 5).map((n) => { const b = n.getBoundingClientRect(); return n.tagName + "." + (typeof n.className === "string" ? n.className : "").replace(/svelte-[a-z0-9]+/g, "").trim() + "@" + [b.left, b.top, b.width, b.height].map(Math.round).join(",") + (input && n.contains(input) ? "⧉含输入框" : "") + (n === input ? "◀就是输入框" : ""); }).join(" > ");\n` +
        `})()`,
    ).catch(() => "量不到");
    await clickAt(field);
    // round76：改成轮询等待（固定 220ms 在「450 块 + 新行高」下偶发不够 → 探针假红）
    let opened = false;
    for (let i = 0; i < 15 && !opened; i++) {
      await sleep(80);
      opened = await evaluate('!!document.querySelector(".cat-pop")').catch(() => false);
    }
    if (!opened) {
      // round76：失败时把「点到了谁」拍下来（行高/密度一改，坐标就可能落在别的元素上）
      const where = await evaluate(
        `(() => { const el = document.elementFromPoint(${Math.round(field.x)}, ${Math.round(field.y)});\n` +
          `  const input = ${rowOf(title)}?.querySelector("input.cat-input");\n` +
          `  const r = input ? input.getBoundingClientRect() : null;\n` +
          `  return "点到了=" + (el ? el.className || el.tagName : "null") + " 框矩形=" + (r ? [r.left, r.top, r.width, r.height].map(Math.round).join(",") : "无") + " 焦点=" + (document.activeElement ? document.activeElement.className || document.activeElement.tagName : "无");\n` +
          `})()`,
      ).catch(() => "量不到");
      return { title, err: "分类列表没展开（" + pre + " ｜ " + where + "）" };
    }
    if (kind === "new") {
      await send("Input.insertText", { text: target }).catch(() => {});
      await sleep(200);
      await key("Enter", "Enter", 13);
    } else if (kind === "clear") {
      // 第一行 = 「（不设分类）」：测 `commit("")` 这条支（分组开着时它同样会把任务搬到「未分类」堆）
      const p = await centerOf('document.querySelector(".cat-pop .row")');
      if (!p) return { title, err: "列表里没有「（不设分类）」" };
      await clickAt(p);
    } else {
      const p = await centerOf(
        `[...document.querySelectorAll(".cat-pop .row")].find((n) => n.querySelector(".nm") && n.querySelector(".nm").textContent.trim() === ${JSON.stringify(target)})`,
      );
      if (!p) return { title, err: "列表里没有「" + target + "」" };
      await clickAt(p);
    }
    await sleep(450);
    return { title, before: plan.cur, target, kind, ...(await read(title)) };
  };

  // 靶子**现场挑**（不写死任务名 —— 走到这一步前，前面几十条断言可能改过名字/分类）：
  // 只从**当前渲染出来**的行里挑（收起的分组不算），三个场景尽量用三条不同的任务。
  await evaluate(`(() => {
    document.querySelectorAll(".ghead-btn[aria-expanded='false']").forEach((b) => b.click());
    return true;
  })()`).catch(() => {});
  await sleep(150);
  const titles = await evaluate(
    `[...document.querySelectorAll(".list .item")].map((n) => n.querySelector(".label")?.textContent?.trim()).filter((x) => !!x)`,
  ).catch(() => []);
  const found = [];
  for (const t of titles || []) {
    const p = await planFor(t);
    if (p && p.found) found.push({ title: t, ...p });
    if (found.length >= 8) break;
  }
  if (!found.length) return { ok: false, skipped: true, why: "Backlog 里一行目标任务都没有" };
  const at = (i) => (found[i] ?? found[0]).title;

  const groupedWas = await groupedNow();
  await setGrouped(true);
  // 前置：先造一条**必有**的分类（全量收尾时假库可能一条分类都不剩 —— round47 会改名 / 并掉它们），
  // 否则后面两个「拍选已有分类」场景没靶子可选。用的就是同一条「打字新建」路径。
  const setup = await scenario(at(0), "new", "探针甲");
  const a = await scenario(at(1), "pick");
  await setGrouped(false);
  const b = await scenario(at(2), "pick");
  await setGrouped(true);
  const c = await scenario(at(3), "new", "探针分类DA");
  const d = await scenario(at(4), "clear");
  // 收尾：面板收起、分组还原（截图里别留下探针的痕迹）
  await key("Escape", "Escape", 27);
  await sleep(120);
  await setGrouped(groupedWas);
  await sleep(120);

  /** 「只有一次写、且写的就是 target；库 / 框里（分组时还有所在堆）都跟上了」
   *  （`null` 与 `""` 归一：清空分类时库/框里是空，未分类堆的 `data-group` 是字符串 `"null"`） */
  const okOf = (r, grouped) => {
    if (!r || r.err) return false;
    const want = r.target ?? "";
    const wantGroup = want === "" ? "null" : want;
    return (
      (r.db ?? "") === want &&
      (r.shown ?? "") === want &&
      (r.writes || []).length === 1 &&
      ((r.writes || [])[0] ?? "") === want &&
      (!grouped || r.group === wantGroup)
    );
  };
  return {
    ok: okOf(setup, true) && okOf(a, true) && okOf(b, false) && okOf(c, true) && okOf(d, true),
    setup,
    a,
    b,
    c,
    d,
    groupedWas,
  };
}

/**
 * round77 收尾（界面审计 §1.3 / L5 / L6）：“**Tab 走查**” —— 三条真键盘检查。
 * 为什么必须真键盘：`:focus-visible` 与 Tab 顺序都跟**交互模态**绑定，程序化 click / focus 测不出来。
 * ① 统计面板开着时，Tab 24 下**不许**落在整屏遮罩（button.overlay-backdrop）上；
 * ② 块聚焦后块上动作条可见（`:focus-within`）；③ 键盘模态下焦点环可见（outline 不为 none）。
 */
async function tabWalkthroughProbe() {
  const sendKey = (type, k) =>
    send("Input.dispatchKeyEvent", {
      type,
      key: k,
      code: k,
      windowsVirtualKeyCode: k === "Tab" ? 9 : 27,
      nativeVirtualKeyCode: k === "Tab" ? 9 : 27,
    });
  const pressTab = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await sendKey("keyDown", "Tab");
      await sendKey("keyUp", "Tab");
      await sleep(35);
    }
  };
  const centerOf = (sel) =>
    evaluate(
      `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null;
         const r = n.getBoundingClientRect();
         return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    ).catch(() => null);
  const clickAt = async (pt) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, buttons: 0 });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: pt.x,
      y: pt.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: pt.x,
      y: pt.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  };
  // 干净起点：关掉可能开着的浮层
  await evaluate(`document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click()); true`).catch(() => {});
  await sleep(140);
  const statsPt = await centerOf(".stats-open");
  if (!statsPt) return { ok: true, skipped: true };
  await clickAt(statsPt);
  await sleep(260);
  const panelOpen = await evaluate(`!!document.querySelector(".stats-panel")`).catch(() => false);
  if (!panelOpen) return { ok: false, why: "统计面板没打开" };
  // ①a 遮罩**不在 Tab 顺序里**：`.overlay-backdrop` 是整屏按钮，但它不该是键盘停靠点
  //    （否则 Tab 到底会停在“点一下关面板”上；关闭有面板自己的 ✕ 与 Esc）。
  //    判据看 `tabIndex` 而不是“Tab 几次能不能碰到”—— 它在 DOM 末尾，多少次都碰不到，那是恒真。
  const backdropTabIndex = await evaluate(
    `(() => { const b = document.querySelector(".stats-panel")?.parentElement?.querySelector("button.overlay-backdrop") ?? document.querySelector("button.overlay-backdrop"); return b ? b.tabIndex : null; })()`,
  ).catch(() => null);
  // ①b 真实键盘扫：先把焦点放到面板里的关闭钮（证明“真在面板里起扫”），再 Tab 24 下
  await evaluate(`document.querySelector(".stats-panel .close")?.focus({ preventScroll: true }); true`).catch(() => {});
  await sleep(80);
  const startInPanel = await evaluate(
    `!!document.activeElement?.closest?.(".stats-panel")`,
  ).catch(() => false);
  let backdropHits = 0;
  let inPanel = 0;
  const seen = [];
  for (let i = 0; i < 24; i++) {
    await pressTab(1);
    const cur = await evaluate(`(() => {
      const a = document.activeElement;
      return {
        cls: (a?.className ?? "").toString().split(" ")[0] || "?",
        bd: !!a?.classList?.contains("backdrop"),
        inp: !!a?.closest?.(".stats-panel"),
      };
    })()`).catch(() => ({ cls: "?", bd: false, inp: false }));
    if (cur.bd) backdropHits += 1;
    if (cur.inp) inPanel += 1;
    if (i < 6) seen.push(cur.cls + (cur.inp ? "(面板内)" : "(面板外)"));
  }
  await evaluate(`document.querySelector(".stats-panel .close")?.click(); true`).catch(() => {});
  await sleep(180);
  // ② 块聚焦 → 浮层**不出现**（round78：聚焦块本身不该盖住块名）；再 Tab 进动作按钮 → 浮层出现（键盘用户仍可达）；③ 焦点环可见
  await pressTab(1);
  await evaluate(
    `(() => { const b = document.querySelector("[data-block-id]"); b?.focus({ preventScroll: true }); })()`,
  ).catch(() => {});
  await sleep(240); // 动作条的 opacity 有 120ms 过渡 —— 聚焦同一拍读会拿到旧值（探针自己踩过）
  const focusState = await evaluate(`(() => {
    const b = document.activeElement;
    if (!b || !b.matches?.("[data-block-id]")) return { err: "焦点不在块上" };
    const acts = b.querySelector(".actions");
    const name = b.querySelector(".name");
    const R = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
    const A = R(acts), N = R(name);
    const overlap = !!A && !!N && A.l < N.r - 0.5 && N.l < A.r - 0.5 && A.t < N.b - 0.5 && N.t < A.b - 0.5;
    const cs = getComputedStyle(b);
    return {
      focused: true,
      actionsOpacity: acts ? Number(getComputedStyle(acts).opacity) : -1,
      overlap,
      outline: cs.outlineStyle + " " + cs.outlineWidth,
    };
  })()`).catch((e) => ({ err: String(e) }));
  // 再 Tab 几步，进到动作按钮上（第一个按钮在色条之后）—— 到那一步浮层应该出现
  let btnFocus = { inActs: false, opacity: -1, steps: 0 };
  for (let i = 0; i < 4; i++) {
    await pressTab(1);
    const st = await evaluate(`(() => {
      const a = document.activeElement;
      const b = a?.closest?.("[data-block-id]");
      const acts = b?.querySelector?.(".actions");
      return { inActs: !!a?.closest?.(".actions"), opacity: acts ? Number(getComputedStyle(acts).opacity) : -1 };
    })()`).catch(() => ({ inActs: false, opacity: -1 }));
    if (st.inActs) {
      await sleep(260); // opacity 有 150ms 过渡 —— 停在按钮上的同一拍读会拿到中间值
      const settled = await evaluate(`(() => {
        const acts = document.activeElement?.closest?.("[data-block-id]")?.querySelector?.(".actions");
        return acts ? Number(getComputedStyle(acts).opacity) : -1;
      })()`).catch(() => -1);
      btnFocus = { inActs: true, opacity: settled, steps: i + 1 };
      break;
    }
  }
  await evaluate(`document.activeElement?.blur?.(); true`).catch(() => {});
  const blockFocusHidden =
    !focusState.err && focusState.actionsOpacity === 0 && !(focusState.overlap && focusState.actionsOpacity > 0.01);
  const btnFocusShown = !!btnFocus.inActs && btnFocus.opacity === 1;
  const actionsOk = blockFocusHidden && btnFocusShown;
  const ringOk = !focusState.err && (focusState.outline ?? "").includes("solid");
  const backdropOk = backdropTabIndex === -1;
  return {
    ok: backdropOk && startInPanel && backdropHits === 0 && actionsOk && ringOk,
    backdropTabIndex,
    backdropOk,
    startInPanel,
    backdropHits,
    inPanel,
    seen,
    focusState,
    blockFocusHidden,
    btnFocusShown,
    btnFocus,
    actionsOk,
    ringOk,
  };
}

/**
 * round78（3.1b₂ · Step 1）：块上动作浮层的**真实鼠标 / 键盘**行为。
 *
 * 验收带回 #1：链两块之后，后来那块（被点 ⛓ 的那块）的浮层一直挂着 —— 旧 CSS 是
 * `.block:focus-within .actions`，真鼠标点完按钮会把焦点留在按钮上。合成事件不会留下真实焦点，
 * 所以只有 CDP 真鼠标能按出来（这也是它一直在断言套件里躲着的原因）。
 * 同时验 #2b：Tab 到块上时浮层不许出现、更不许盖住块名；再 Tab 进按钮时又必须出现。
 */
async function realBlockActionsProbe() {
  const moveTo = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await sleep(60);
  };
  const clickAt = async (pt) => {
    await moveTo(pt.x, pt.y);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1,
    });
    await sleep(30);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 0, clickCount: 1,
    });
    await sleep(90);
  };
  const pressKey = async (k, code, vk) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(70);
  };
  // 干净起点：关掉可能开着的浮层 + 真按 Esc 清选中
  await evaluate(`document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click()); true`).catch(() => {});
  await sleep(120);
  await pressKey("Escape", "Escape", 27);
  // 把 b22 / b24（周三）滚进视野（窄窗下周三本来在视口外）
  // round82（Step 3）补：**中心点得真的落在块上**才能开拍 —— 前面的断言可能把视野留在别的周 / 别的星期，
  // 只靠 `scrollLeft +=` 不足以把块拉回（实测：指针落在左轴 gutter 上 → hover 假红）。
  const ready = await evaluate(`(() => {
    const s = document.querySelector(".scroll");
    const a = document.querySelector('[data-block-id="b22"]');
    const b = document.querySelector('[data-block-id="b24"]');
    if (!s || !a || !b) return false;
    const sb = s.getBoundingClientRect();
    s.scrollLeft += Math.max(0, a.getBoundingClientRect().left - sb.left - 30);
    a.scrollIntoView({ block: "center", inline: "center" });
    const r = a.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return !!hit && !!hit.closest('[data-block-id]');
  })()`).catch(() => false);
  if (!ready) return { ok: true, skipped: true };
  await sleep(200);
  const geo = () => evaluate(`(() => {
    const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
    const body = (id) => box(document.querySelector('[data-block-id="' + id + '"]'));
    const link = (id) => box(document.querySelector('[data-block-id="' + id + '"] .actions button.link'));
    const op = (id) => { const n = document.querySelector('[data-block-id="' + id + '"] .actions'); return n ? Number(getComputedStyle(n).opacity) : -1; };
    return { a: body("b22"), b: body("b24"), la: link("b22"), lb: link("b24"), oa: op("b22"), ob: op("b24"), vw: window.innerWidth, vh: window.innerHeight };
  })()`).catch(() => null);
  let g = await geo();
  if (!g?.a || !g?.b || !g?.la || !g?.lb) return { ok: true, skipped: true };
  const headH = () =>
    evaluate(`(() => { const n = document.querySelector(".timeline .head"); return n ? Math.round(n.getBoundingClientRect().height * 10) / 10 : -1; })()`).catch(() => -1);
  // ① hover 控制组：鼠标在块身上 → 浮层该出现；且**悬停不许动布局**（槽不做悬停预占位 —— 那会让时间轴每次悬停弹一下）
  const hNoHover = await headH();
  await moveTo(Math.round(g.a.x), Math.round(g.a.y));
  await sleep(280);
  const hoverShown = (await geo())?.oa === 1;
  // 失败时把「指针底下到底是谁」拓出来（这行是 Step 3 查旧帐时加的：不拓就只能猜）
  const hoverHit = hoverShown
    ? ""
    : await evaluate(
        `(() => { const el = document.elementFromPoint(${Math.round(g.a.x)}, ${Math.round(g.a.y)}); return el ? (el.className || el.tagName) + "@" + Math.round(el.getBoundingClientRect().width) + "x" + Math.round(el.getBoundingClientRect().height) : "无"; })()`,
      ).catch(() => "?");
  const hHover = await headH();
  const hoverStable = hHover > 0 && hHover === hNoHover;
  // ② 真点 b22 的 ⛓（拿起线头）→ ③ hover b24 → 点它的 ⛓（接上）
  g = await geo();
  await clickAt(g.la);
  g = await geo();
  await moveTo(Math.round(g.b.x), Math.round(g.b.y));
  await sleep(220);
  g = await geo();
  await clickAt(g.lb);
  // ④ 鼠标移开（右上角）→ 两块都不该再亮着（旧实现：b24 被焦点吊住 → 常亮）
  await moveTo((g?.vw ?? 300) - 3, 3);
  await sleep(340);
  g = await geo();
  const afterAway = { a: g?.oa ?? -1, b: g?.ob ?? -1 };
  // ⑤ 真 Tab（设成键盘模态）→ 聚焦一个块：浮层不该出现，更不该盖住块名
  await pressKey("Tab", "Tab", 9);
  const focusedId = await evaluate(`(() => {
    const n = document.querySelector(".block.narrow") ?? document.querySelector("[data-block-id]");
    n?.focus({ preventScroll: true });
    return n?.dataset?.blockId ?? null;
  })()`).catch(() => null);
  await sleep(300);
  const kbState = await evaluate(`(() => {
    const b = document.activeElement;
    if (!b || !b.matches?.("[data-block-id]")) return { err: "焦点不在块上" };
    const acts = b.querySelector(".actions");
    const name = b.querySelector(".name");
    const R = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; };
    const A = R(acts), N = R(name);
    const overlap = !!A && !!N && A.l < N.r - 0.5 && N.l < A.r - 0.5 && A.t < N.b - 0.5 && N.t < A.b - 0.5;
    return { id: b.dataset.blockId, opacity: acts ? Number(getComputedStyle(acts).opacity) : -1, overlap, actions: A, name: N };
  })()`).catch((e) => ({ err: String(e) }));
  // ⑥ 继续 Tab 进动作按钮 → 浮层必须出现（键盘用户仍可达）
  let btn = { inActs: false, opacity: -1, steps: 0 };
  for (let i = 0; i < 5; i++) {
    await pressKey("Tab", "Tab", 9);
    const st = await evaluate(`(() => {
      const a = document.activeElement;
      const b = a?.closest?.("[data-block-id]");
      const acts = b?.querySelector?.(".actions");
      return { inActs: !!a?.closest?.(".actions"), opacity: acts ? Number(getComputedStyle(acts).opacity) : -1 };
    })()`).catch(() => ({ inActs: false, opacity: -1 }));
    if (st.inActs) {
      await sleep(260); // opacity 有 150ms 过渡 —— 停在按钮上的同一拍读会拿到中间值
      const settled = await evaluate(`(() => {
        const acts = document.activeElement?.closest?.("[data-block-id]")?.querySelector?.(".actions");
        return acts ? Number(getComputedStyle(acts).opacity) : -1;
      })()`).catch(() => -1);
      btn = { inActs: true, opacity: settled, steps: i + 1 };
      break;
    }
  }
  // 收尾：把这两块从序列里摘掉（右键 ⛓），别给后面的尺子留脏状态
  await evaluate(`(() => {
    ["b22", "b24"].forEach((id) => {
      document.querySelector('[data-block-id="' + id + '"] .actions button.link')
        ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    document.activeElement?.blur?.();
    return true;
  })()`).catch(() => {});
  await sleep(120);
  const ok =
    hoverShown &&
    hoverStable &&
    afterAway.a === 0 &&
    afterAway.b === 0 &&
    !kbState.err &&
    kbState.opacity === 0 &&
    !(kbState.overlap && kbState.opacity > 0.01) &&
    btn.inActs &&
    btn.opacity === 1;
  return { ok, hoverShown, hoverStable, hNoHover, hHover, afterAway, focusedId, kbState, btn, hoverHit };
}

/**
 * round82（11.2）：真鼠标 / 真键盘 —— 并排块（N=2 / N≫3）的动作浮层三档排布。
 * 为什么必须真输入：`:hover` / `:focus-visible` 都跟交互模态绑定，合成事件测不出来。
 * 判据：① 真 hover → 浮层出来（宽 = 58 / 30，不竖排）；② 移开鼠标 → 收回去；
 *      ③ 真 Tab 进浮层按钮 → 浮层可见（键盘路径）。
 */
async function realNarrowOverlayProbe() {
  const moveTo = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await sleep(80);
  };
  const key = async (vk, k, code) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(70);
  };
  // 干净起点：关浮层 + 真 Esc
  await evaluate(`document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click()); true`).catch(() => {});
  await sleep(120);
  await key(27, "Escape", "Escape");
  const pick = await evaluate(`(() => {
    const s = document.querySelector(".scroll");
    if (!s) return null;
    const cands = [...document.querySelectorAll("[data-cols]")].filter((n) => Number(n.dataset.cols) >= 2 && n.querySelector(".actions button"));
    for (const n of cands) {
      const r0 = n.getBoundingClientRect();
      if (r0.width < 20 || r0.height < 12) continue;
      n.scrollIntoView({ block: "center", inline: "center" });
      const db = n.closest(".day-body")?.getBoundingClientRect();
      const sb = s.getBoundingClientRect();
      if (db && db.left < sb.left) s.scrollLeft += Math.round(db.left - sb.left - 20);
      const rr = n.getBoundingClientRect();
      const cx = Math.round(rr.left + rr.width / 2);
      const cy = Math.round(rr.top + rr.height / 2);
      if (cx < 8 || cy < 80 || cx > innerWidth - 8 || cy > innerHeight - 20) continue;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || !hit.closest("[data-block-id]")) continue;
      return { id: n.dataset.blockId, cols: Number(n.dataset.cols) };
    }
    return null;
  })()`).catch(() => null);
  if (!pick) return { ok: true, skipped: true };
  await sleep(220);
  const read = () => evaluate(`(() => {
    const b = document.querySelector('[data-block-id="${pick.id}"]');
    if (!b) return null;
    const a = b.querySelector(".actions");
    if (!a) return null;
    const ar = a.getBoundingClientRect();
    const btns = [...a.querySelectorAll("button")].map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    const cs = getComputedStyle(a);
    return { opacity: Number(cs.opacity), aw: Math.round(ar.width), ah: Math.round(ar.height), btns,
      wrap: cs.flexWrap, maxW: cs.maxWidth, disp: cs.display, blockW: Math.round(b.getBoundingClientRect().width),
      rows: new Set([...a.querySelectorAll("button")].map((n) => Math.round(n.getBoundingClientRect().top))).size };
  })()`).catch(() => ({ err: "read" }));
  const pt = await evaluate(`(() => { const b = document.querySelector('[data-block-id="${pick.id}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(8, r.width / 2)), y: Math.round(r.top + r.height / 2) }; })()`).catch(() => null);
  if (!pt) return { ok: true, skipped: true };
  // ① 真 hover 块身
  await moveTo(pt.x, pt.y);
  await sleep(320);
  const on = await read();
  // ② 移开
  await moveTo(4, 4);
  await sleep(320);
  const off = await read();
  // ③ 真 Tab 进浮层（先把焦点放到块上，再 Tab 到按钮）
  await evaluate(`document.querySelector('[data-block-id="${pick.id}"]')?.focus({ preventScroll: true }); true`).catch(() => {});
  await sleep(100);
  let steps = 0;
  let kb = null;
  for (let i = 0; i < 6; i++) {
    await key(9, "Tab", "Tab");
    steps += 1;
    kb = await evaluate(`(() => {
      const a = document.querySelector('[data-block-id="${pick.id}"]')?.querySelector(".actions");
      return { inside: !!document.activeElement?.closest?.(".actions"), opacity: a ? Number(getComputedStyle(a).opacity) : -1 };
    })()`).catch(() => null);
    if (kb?.inside) break;
  }
  // `.actions` 有 `transition: opacity 150ms` —— Tab 后立刻读会拿到过渡中间值（0.85）→ 假红；等它走完
  await sleep(320);
  kb = await evaluate(`(() => {
    const a = document.querySelector('[data-block-id="${pick.id}"]')?.querySelector(".actions");
    return { inside: !!document.activeElement?.closest?.(".actions"), opacity: a ? Number(getComputedStyle(a).opacity) : -1 };
  })()`).catch(() => null);
  await key(27, "Escape", "Escape");
  const expectW = pick.cols === 2 ? 58 : 30;
  // round82（11.2 二轮 · 2026-10-07）：「浮层宽度/行数随块宽调整」——
  //   每行能放几枚由**实测的浮层宽**算（aw − padding 4 − border 2 + gap 4 = aw − 2），行数 = ceil(n / 每行)；
  //   硬判据：① 不超出块（不压邻列）② 行数刚好装满 ③ 按钮 24×24
  const perRow = on ? Math.max(1, Math.floor((on.aw - 2) / 28)) : 1;
  const expRows = on ? Math.ceil(on.btns.length / perRow) : 1;
  const expH = expRows * 24 + (expRows - 1) * 4 + 6;
  const geoOk = !!on && on.opacity === 1 && on.aw <= on.blockW - 1 && Math.abs(on.ah - expH) <= 5;
  const btnOk = !!on && on.btns.length > 0 && on.btns.every(([w, h]) => w === 24 && h === 24);
  const awayOk = !!off && off.opacity === 0;
  const kbOk = !!kb && kb.inside && kb.opacity === 1;
  return { ok: geoOk && btnOk && awayOk && kbOk, id: pick.id, cols: pick.cols, on, off, expectW, expH, geoOk, btnOk, awayOk, kb, kbOk, steps };
}

/**
 * round85（0.31.0 · §5-DU）：真鼠标 —— **视图里不够高的块**上，动作浮层贴到块外沿
 * （`data-overlay` = above/below），块身中缝还能拖、下沿还能拉。
 * 三条硬判据：① hover 时浮层与块**不相交**（gap = 0）② 块身中缝真按下 + 真移动 → 起拖（拖影出现，Esc 取消）
 * ③ 下沿真按下 + 真移动 → 拉伸预览（辅助线 / 高度变，Esc 取消）。
 */
async function realShortOverlayProbe() {
  const moveTo = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await sleep(140);
  };
  const key = async (vk, k, code) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(90);
  };
  await evaluate(`document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click()); true`).catch(() => {});
  await sleep(120);
  await key(27, "Escape", "Escape");
  const pick = await evaluate(`(() => {
    const cands = [...document.querySelectorAll("[data-block-id].planned")].filter((n) => {
      const r = n.getBoundingClientRect();
      // round87.1（1.0.1 · 验收回修）：并排窄块的浮层落点现在由**实测**决定（窄块浮层会换行，
      // 高达 142px）—— 凡是「挂在块外沿」的块都该满足：不相交 + 块身能拖 + 下沿能拉。
      // 旧过滤器只看 height < 54 → 窄块被漏掉（你 2026-10-08 的验收图就是它）。
      const outside = n.dataset.overlay && n.dataset.overlay !== "inline";
      const short = r.height > 6 && r.height < 54;
      return outside && (short || n.classList.contains("narrow")) && n.querySelector(".actions button") && n.querySelectorAll(".resize").length === 2;
    });
    for (const n of cands) {
      n.scrollIntoView({ block: "center", inline: "center" });
      const r = n.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      if (cx < 60 || cx > innerWidth - 60) continue;
      const hs = [...n.querySelectorAll(".resize")].map((h) => h.getBoundingClientRect());
      const top = hs.find((x) => x.top < r.top + r.height / 2) ?? null;
      const bot = hs.find((x) => x !== top) ?? null;
      if (!top || !bot || top.height <= 0 || bot.height <= 0) continue;
      const faceTop = Math.max(r.top, top.bottom);
      const faceBottom = Math.min(r.bottom, bot.top);
      const fy = Math.round(faceTop + (faceBottom - faceTop) / 2);
      if (fy < 100 || fy > innerHeight - 60) continue;
      // round87.1：块身中缝 / 下沿那两点必须真能点到（否则就是「被邻居的浮层盖住」——
      // 浮层允许冒出块外（你 2026-10-05 拍的），所以换一个块来探，别把这类情形当成回归）
      const faceHit = document.elementFromPoint(cx, fy);
      if (!faceHit || !faceHit.closest("[data-block-id]")) continue;
      const botHit = document.elementFromPoint(cx, Math.round(bot.top + 1));
      if (!botHit || !botHit.closest(".resize")) continue;
      return { id: n.dataset.blockId, overlay: n.dataset.overlay, h: Math.round(r.height),
        faceH: Math.round((faceBottom - faceTop) * 10) / 10, x: cx, y: fy,
        handles: hs.map((x) => [Math.round(x.top), Math.round(x.height)]),
        botY: Math.round(bot.top + 1) };
    }
    return null;
  })()`).catch(() => null);
  if (!pick) return { ok: true, skipped: true, why: "没有 data-overlay=above/below 的块（矮块或并排窄块）" };
  const read = () =>
    evaluate(`(() => {
      const b = document.querySelector('[data-block-id="${pick.id}"]');
      if (!b) return null;
      const a = b.querySelector(".actions");
      if (!a) return null;
      const br = b.getBoundingClientRect();
      const ar = a.getBoundingClientRect();
      const body = b.closest(".day-body").getBoundingClientRect();
      return { opacity: Number(getComputedStyle(a).opacity), aw: Math.round(ar.width), ah: Math.round(ar.height),
        gap: Math.round(Math.max(0, Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top))),
        inBodyV: ar.top >= body.top - 1 && ar.bottom <= body.bottom + 1, h: Math.round(br.height) };
    })()`).catch(() => null);
  /** 每次输入前**现读**几何 —— 防「先量后滚 / 重排」把坐标量废（探针踩过的坑） */
  const geom = () =>
    evaluate(`(() => {
      const b = document.querySelector('[data-block-id="${pick.id}"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const hs = [...b.querySelectorAll(".resize")].map((h) => h.getBoundingClientRect());
      const top = hs.find((x) => x.top < r.top + r.height / 2) ?? null;
      const bot = hs.find((x) => x !== top) ?? null;
      const faceTop = Math.max(r.top, top ? top.bottom : r.top);
      const faceBottom = Math.min(r.bottom, bot ? bot.top : r.bottom);
      const faceX = Math.round(r.left + r.width / 2);
      const faceY = Math.round(faceTop + (faceBottom - faceTop) / 2);
      const botY = Math.round((bot ? bot.top : r.bottom) + 1);
      const info = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return el
          ? { tag: el.tagName, cls: typeof el.className === "string" ? el.className : el.getAttribute("class") || "(svg)",
              block: el.closest("[data-block-id]")?.dataset.blockId ?? null,
              inActions: !!el.closest(".actions"), inResize: !!el.closest(".resize") }
          : null;
      };
      return { faceX, faceY, botY, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        handles: hs.map((x) => [Math.round(x.top), Math.round(x.height)]), hitFace: info(faceX, faceY), hitBot: info(faceX, botY) };
    })()`).catch(() => null);
  const ghostCount = () =>
    evaluate(
      `[...document.body.children].filter((el) => el.style.position === "fixed" && el.style.zIndex === "9999").length`,
    ).catch(() => -1);
  // 断言跑完会故意留一个「拖到周六」的未收尾手势当截图证据（checks.js 尾部）——先真的 Esc 收掉它；
  // 收不掉（Esc 无效 / 手势泄漏）时把残留拖影**现场清掉**并记账：不然 `makeGhost()` 看已有拖影
  // 会直接 return，我的拖动永远看不到新拖影（假红）。
  const ghostStale = await ghostCount();
  await key(27, "Escape", "Escape");
  await sleep(240);
  let ghostAfterCleanup = await ghostCount();
  if (ghostAfterCleanup > 0) {
    await evaluate(
      `[...document.body.children].filter((el) => el.style.position === "fixed" && el.style.zIndex === "9999").forEach((el) => el.remove()); true`,
    ).catch(() => {});
    ghostAfterCleanup = await ghostCount();
  }
  // ① 真 hover → 浮层出现且与块不相交（坐标每次现读，防滚动/重排后失效）
  await moveTo(pick.x, pick.y);
  await sleep(320);
  const on = await read();
  const g1 = await geom();
  const hoverHit = await evaluate(
    `(() => { const el = document.elementFromPoint(${pick.x}, ${pick.y}); return el ? (el.closest("[data-block-id]")?.dataset.blockId ?? el.tagName) : "null"; })()`,
  ).catch(() => "?");
  const ghostBefore = await ghostCount();
  // ② 真按下块身中缝 + 真移动 → 起拖（拖影）；Esc 取消手势
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: g1.faceX, y: g1.faceY, button: "left", buttons: 1, clickCount: 1 });
  await sleep(60);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: g1.faceX + 6, y: g1.faceY + 30, buttons: 1 });
  await sleep(280);
  const ghostDuring = await ghostCount();
  await key(27, "Escape", "Escape");
  await sleep(220);
  const ghostAfter = await ghostCount();
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: g1.faceX + 6, y: g1.faceY + 30, button: "left", buttons: 0, clickCount: 1 });
  await sleep(140);
  // ③ 真按下下沿 + 真移动 **一整格**（+1 格以上才会出现预览）→ 拉伸预览；Esc 取消
  // round87.1：先在下沿上挑一个**真能点到把手**的 x —— 并排窄块的浮层允许冒出块外（你 2026-10-05 拍的），
  // 邻居的浮层可能盖住这一条边的一部分；三点都盖满就如实标「跳过（被邻居浮层盖住）」而不是假红。
  const g2 = await geom();
  await moveTo(g2.faceX, g2.botY);
  await sleep(140);
  const [bl, , bw] = g2.rect;
  const cands = [...new Set([g2.faceX, Math.round(bl + 3), Math.round(bl + bw - 3)])];
  let resizeX = null;
  let resizeBlocked = null;
  for (const x of cands) {
    const hit = await evaluate(
      `(() => { const el = document.elementFromPoint(${x}, ${g2.botY}); if (!el) return null; return { resize: !!el.closest(".resize"), actions: el.closest(".actions") ? (el.closest("[data-block-id]")?.dataset.blockId ?? "?") : null }; })()`,
    ).catch(() => null);
    if (hit?.resize) {
      resizeX = x;
      break;
    }
    if (hit?.actions && hit.actions !== pick.id) resizeBlocked = `邻居 ${hit.actions} 的浮层`;
  }
  const before = await evaluate(`document.querySelectorAll(".align-line").length`).catch(() => -1);
  let resize = null;
  if (resizeX !== null) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: resizeX, y: g2.botY, button: "left", buttons: 1, clickCount: 1 });
    await sleep(60);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: resizeX, y: g2.botY + 16, buttons: 1 });
    await sleep(320);
    resize = await evaluate(
      `({ lines: document.querySelectorAll(".align-line").length, h: Math.round(document.querySelector('[data-block-id="${pick.id}"]')?.getBoundingClientRect().height ?? -1) })`,
    ).catch(() => null);
  }
  await key(27, "Escape", "Escape");
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: resizeX ?? g2.faceX, y: g2.botY + 16, button: "left", buttons: 0, clickCount: 1 });
  await sleep(160);
    const overlayOk = !!on && on.opacity === 1 && on.gap === 0 && on.inBodyV;
    const dragOk = ghostAfterCleanup === 0 && ghostDuring > ghostBefore && ghostAfter === ghostBefore;
    // 被邻居浮层盖住的那一条边：跳过（行为已验收）；自己的浮层盖住手把则照样判红
    const resizeOk = resizeBlocked ? true : !!resize && (resize.lines >= 1 || resize.h !== pick.h);
    const fmtHit = (h) => {
    if (!h) return "null";
    let zone = "";
    if (h.inResize) zone = "(把手)";
    else if (h.inActions) zone = "(浮层)";
    return `${h.tag}.${String(h.cls).split(" ")[0]}${h.block ? `@${h.block}` : ""}${zone}`;
  };
  return {
    ok: overlayOk && dragOk && resizeOk,
    id: pick.id,
    overlay: pick.overlay,
    faceH: pick.faceH,
    on,
    ghostStale,
    ghostAfterCleanup,
    ghostBefore,
    ghostDuring,
    ghostAfter,
    hitFace: fmtHit(g1?.hitFace),
    hitBot: fmtHit(g2?.hitBot),
    hoverHit,
    g1rect: g1?.rect,
    g1handles: g1?.handles,
    g2rect: g2?.rect,
    resize,
    resizeBlocked,
    before,
    overlayOk,
    dragOk,
    resizeOk,
    title: `矮块浮层探针（${pick.id}/${pick.overlay}）`,
  };
}

/**
 * round85（0.31.0）：**底纹性能探针** —— 脚本滚动 90 帧，采 `requestAnimationFrame` 间隔：
 * warm（无底纹）vs 两套有底纹的（terminal 扫描线 / endfield 细网格 + 45° 斜纹）。
 * 为什么要有：你 2026-10-08 问「这层 CSS 开销大不大」—— 不靠嘴说，靠帧数字。
 * 判据故意宽：rAF 间隔在真窗口里噪声很大，这里只拦「病态回归」（比如谁把动画/磨砂玻璃搬回来）；
 * 具体数字（p50/p95/max）写进验收文档。
 *
 * round87（Step 6）实测：这个成本**与屏上块数相关**、而且谷地黄在「全量套件跑完（矩阵盘 85 块）」状态下的
 * p50 = 33.3ms（30fps），正好跨在 p95<40 的线上（p95 实测 33.4 ✓ / 50 ✗ 两态都出现过）——
 * A/B 结论：**是两层底纹叠加的绘制成本**（单去 `--surface-image` 或单去 `--surface-image-cols` 都回到 16.7），
 * 块 clip-path 与它无关；终端（扫描线，轴对齐）同状态是 16.7。已登记 `docs/对账.md` §5-DX（含建议方向）。
 * 所以它红/绿会闪：它现在是「谷地黄 45° 纹理在几十块下的陈本」，不是回归信号。
 */
async function realPaintProbe() {
  /** 切一套配色；**返回真正生效的 id**（6b P2：切换失败时四次测量的会是同一套 → 假绿） */
  const pickPalette = (id) =>
    evaluateAsync(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      if (!document.querySelector(".sanity-pop")) {
        document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await wait(80);
      }
      document.querySelector('.sanity-pop .ui-palette .palette[data-value="${id}"]')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await wait(200);
      document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await wait(80);
      return document.documentElement.dataset.palette;
    })()`).catch(() => null);
  const measure = () =>
    evaluateAsync(`(async () => {
      const scroll = document.querySelector(".scroll");
      const frames = [];
      let last = performance.now();
      const start = scroll ? scroll.scrollTop : 0;
      await new Promise((resolve) => {
        let i = 0;
        const tick = (t) => {
          if (i > 6) frames.push(t - last);
          last = t;
          if (scroll) scroll.scrollTop = start + (i % 30) * 14;
          i += 1;
          if (i < 96) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      const sorted = [...frames].sort((a, b) => a - b);
      const at = (q) => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0) * 100) / 100;
      return {
        n: sorted.length,
        p50: at(0.5),
        p95: at(0.95),
        max: Math.round((sorted.at(-1) ?? 0) * 100) / 100,
        // round87（Step 6）：把「量的时候页面上有多少块」一并带上 ——
        // 底纹成本与同时上屏的块数正相关（全量套件跑完周里可能有几十块，单独跑时只有十几块）。
        blocks: document.querySelectorAll("[data-block-id]").length,
      };
    })()`).catch(() => null);
  const gotWarm = await pickPalette("warm");
  const warm = await measure();
  const gotTerminal = await pickPalette("terminal");
  const terminal = await measure();
  const gotEndfield = await pickPalette("endfield");
  const endfield = await measure();
  const gotWarm2 = await pickPalette("warm");
  const warm2 = await measure();
  // 6b P2：先证「四段真的量了不同的配色」——否则「底纹几乎不花钱」这句话是无根据的
  const switched =
    gotWarm === "warm" && gotTerminal === "terminal" && gotEndfield === "endfield" && gotWarm2 === "warm";
  if (!switched) {
    return { ok: false, why: `配色没切上：warm=${gotWarm} terminal=${gotTerminal} endfield=${gotEndfield} 回warm=${gotWarm2}`, title: "底纹性能探针（滚动 90 帧 · rAF 间隔）" };
  }
  const base = Math.min(warm?.p95 ?? 99, warm2?.p95 ?? 99);
  const worst = Math.max(terminal?.p95 ?? 0, endfield?.p95 ?? 0);
  const sane = (m) => !!m && Number.isFinite(m.p95) && m.p95 < 40;
  const ok = switched && sane(warm) && sane(warm2) && sane(terminal) && sane(endfield);
  return {
    ok,
    switched,
    warm,
    terminal,
    endfield,
    warm2,
    delta: Math.round((worst - base) * 100) / 100,
    title: "底纹性能探针（滚动 90 帧 · rAF 间隔）",
  };
}

/**
 * round79（78-09）：真鼠标 —— 双击空白格建临时块、就地命名，**鼠标停在块上时**
 * 动作浮层不该压在命名输入框上（旧实现：`.block:hover .actions` 直接盖住 `.name-input`）。
 * 对照组：非改名态的块 hover 后浮层必须出现（防「整个浮层被一刀切掉」式假绿）。
 */
async function realRenameOverlayProbe() {
  const moveTo = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await sleep(60);
  };
  const clickAt = async (pt, clickCount) => {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount,
    });
    await sleep(24);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 0, clickCount,
    });
    await sleep(60);
  };
  // 干净起点：关遮罩 → 关**没有遮罩的面板**（它们会盖住时间轴）→ 回本周
  // （round79 6b 二轮自查：全量跑里前面几百条断言可能留下面板 / 停在别的周 → 探针点了半天没反应）
  await evaluate(`document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click()); true`).catch(() => {});
  await evaluate(
    `document.querySelectorAll(".sanity-pop .close, .ach-panel .close, .review-panel .close, .stats-panel .close, .tpl-pop .close, .switch-panel .close, .help-panel .close").forEach((b) => b.click()); true`,
  ).catch(() => {});
  await sleep(160);
  await evaluate(`document.querySelector(".week-nav .now")?.click(); true`).catch(() => {});
  await sleep(240);
  // 找空格的小工具（页面里定义一次，能反复调 —— 布局变了要重新找）
  await evaluate(`window.__findEmptySpot = () => {
    const s = document.querySelector(".scroll");
    if (!s) return null;
    // 候选格：7 天 × 凌晨 1–6 点（全量跑里假库"到处都是块"，候选给宽一点才找得到空格）
    const cands = [];
    for (const h of [3, 2, 4, 1, 5, 6]) for (const d of [5, 6, 4, 0, 1, 2, 3]) cands.push([d, h]);
    for (const [d, h] of cands) {
      const day = document.querySelectorAll(".day")[d];
      if (!day) continue;
      const sb = s.getBoundingClientRect();
      let db = day.getBoundingClientRect();
      if (db.left < sb.left || db.right > sb.right) {
        s.scrollLeft += Math.round(db.left - sb.left - 24);
        db = day.getBoundingClientRect();
        if (db.left < sb.left || db.right > sb.right) continue;
      }
      const p = atDay(d, h, 0);
      if (p.x < 8 || p.y < 8 || p.x > window.innerWidth - 8 || p.y > window.innerHeight - 8) continue;
      const hit = document.elementFromPoint(p.x, p.y);
      if (!hit || !hit.closest || !hit.closest(".day-body")) continue; // 必须真落在时间轴格子上
      if (hit.closest("[data-block-id]")) continue;                     // 有块 → 换下一格
      return { x: Math.round(p.x), y: Math.round(p.y), day: d, hour: h };
    }
    return null;
  }; true`).catch(() => {});
  let spot = await evaluate(`window.__findEmptySpot()`).catch(() => null);
  if (!spot) return { ok: true, skipped: true };
  // **预热一次**：第一次点击可能让「选中 → 提示条」这类东西出现，把时间轴整体挪一截；
  // 那一挪会让「双击」的第二下落在不同坐标 → 浏览器不合成 `dblclick`（实测：全量跑里点了个空，
  // `--only round79` 里却好好的）。所以先点一下让布局稳定，再重量坐标、连点两下。
  await clickAt(spot, 1);
  await sleep(320);
  spot = await evaluate(`window.__findEmptySpot()`).catch(() => null);
  if (!spot) return { ok: true, skipped: true };
  const before = await evaluate(`document.querySelectorAll("[data-block-id]").length`).catch(() => -1);
  if (before < 0) return { ok: true, skipped: true };
  // round80（79-03）：**逐帧采样** —— 双击建块到进改名态之间，块上动作浮层不许出现（旧实现会闪一帧）。
  // 采样信号 = 所有 `.actions` 的最大 computed opacity（元素本身恒在 DOM 里，opacity 才是有无）；
  // 停采样：进改名态（input 出现）后再多记 4 帧，或最多 300 帧（≈5s 兜底）。
  await evaluate(`(() => {
    window.__FRAMES = [];
    if (window.__frameRaf) cancelAnimationFrame(window.__frameRaf);
    // 79-03：把「loadBlocks 写入 → startEditing」之间的缝隙撑开（假后端太快；真机有这条缝）——
    // 只影响探针这一次；产品代码不知道这个旋钮存在。
    window.__SLOW_CMD_ONCE = { cmd: "generate_repeats", ms: 500 };
    const rec = () => {
      let max = 0;
      for (const e of document.querySelectorAll(".actions")) {
        const o = Number(getComputedStyle(e).opacity) || 0;
        if (o > max) max = o;
      }
      const input = !!document.querySelector("input.name-input");
      window.__FRAMES.push({ o: Math.round(max * 100) / 100, input });
      const seen = window.__FRAMES.filter((f) => f.input).length;
      // 进改名后**再多记 40 帧（≈660ms）** —— 覆盖探针故意撑开的 500ms 延迟窗口（别提前停）。
      const done = window.__FRAMES.length >= 300 || seen >= 40;
      window.__frameRaf = done ? 0 : requestAnimationFrame(rec);
    };
    window.__frameRaf = requestAnimationFrame(rec);
    return true;
  })()`).catch(() => {});
  await clickAt(spot, 1);
  await sleep(40);
  await clickAt(spot, 2);
  // 等进改名态（最长 2.5s）：探针把 `generate_repeats` 撑了 500ms，旧实现下这段正是浮层闪现的窗口 ——
  // 固定 `sleep(280)` 会在改名态出现前就去读现场 → 假红「没进改名态」。
  for (let i = 0; i < 50; i += 1) {
    const up = await evaluate(`!!document.querySelector("input.name-input")`).catch(() => false);
    if (up) break;
    await sleep(50);
  }
  await sleep(80);
  // 等采样器自己停（进改名后还要多记 40 帧）——不然读到的是半份采样
  for (let i = 0; i < 60; i += 1) {
    const done = await evaluate(`(window.__frameRaf || 0) === 0 || (window.__FRAMES || []).length >= 300`).catch(() => true);
    if (done) break;
    await sleep(50);
  }
  const flash = await evaluate(`(() => {
    const fs = window.__FRAMES || [];
    const hot = fs.filter((f) => f.o > 0.01);
    return {
      frames: fs.length,
      hot: hot.length,
      max: Math.round(fs.reduce((m, f) => Math.max(m, f.o), 0) * 100) / 100,
      firstHot: hot[0] ?? null,
      inputSeen: fs.some((f) => f.input),
    };
  })()`).catch(() => ({ frames: -1, hot: -1, max: -1, firstHot: null, inputSeen: false }));
  const geo = () => evaluate(`(() => {
    const R = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
    const input = document.querySelector("input.name-input");
    const block = input?.closest?.("[data-block-id]") ?? null;
    const acts = block?.querySelector(".actions") ?? null;
    const other = (() => {
      const all = [...document.querySelectorAll("[data-block-id]")].filter((n) => n !== block);
      const vis = all.filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 4 && r.top > 60 && r.bottom < innerHeight - 20 && r.left >= 0 && r.right <= innerWidth;
      });
      return vis[0] ?? all[0] ?? null;
    })();
    const otherActs = other?.querySelector(".actions") ?? null;
    return {
      count: document.querySelectorAll("[data-block-id]").length,
      id: block?.dataset.blockId ?? null,
      input: R(input),
      acts: acts ? R(acts) : null,
      actsOpacity: acts ? Number(getComputedStyle(acts).opacity) : -1,
      otherId: other?.dataset.blockId ?? null,
      otherBox: R(other),
      otherOpacity: otherActs ? Number(getComputedStyle(otherActs).opacity) : -1,
    };
  })()`).catch((e) => ({ err: String(e) }));
  const st = await geo();
  if (st.err || !st.input || !st.id || !st.otherBox) {
    const calls = await evaluate(`JSON.stringify((window.__CALLS || []).slice(-6))`).catch(() => "?");
    return { ok: false, why: "没进改名态：" + JSON.stringify({ ...st, spot, before }) + " calls=" + calls };
  }
  // ① 真鼠标停在**改名中的块**上（= 旧实现里浮层出现的条件）
  await moveTo(st.input.x, st.input.y);
  await sleep(340);
  const onInput = await geo();
  const overlap = (a, b) =>
    !!a && !!b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
  const covers = !!onInput.acts && overlap(onInput.acts, onInput.input);
  // ② 对照组：真鼠标停在**别的块**上 → 浮层必须出现（证明 hover 通道本身是好的）。
  // 靶子要「滚进视野 + 命中测试到它自己」——旧写法拿「DOM 里第一块」，它在屏外/被理智条盖住时
  // 真鼠标悬不上去 → 假红（round70 真鼠标教训 + round80 实测）。
  let ctl = null;
  for (let i = 0; i < 24 && !ctl; i += 1) {
    ctl = await evaluate(`(() => {
      const all = [...document.querySelectorAll("[data-block-id]")].filter((n) => n.dataset.blockId !== "${st.id}");
      const c = all[${i}] ?? null;
      if (!c) return null;
      c.scrollIntoView({ block: "center" });
      const r = c.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === c || c.contains(hit))) return null;
      return { id: c.dataset.blockId, x, y };
    })()`).catch(() => null);
  }
  if (!ctl) {
    return { ok: false, why: "对照组找不到可悬停的块", flash, before, after: before, covers };
  }
  await moveTo(ctl.x, ctl.y);
  await sleep(340);
  const onOther = await evaluate(`(() => {
    const n = document.querySelector('[data-block-id="${ctl.id}"]');
    const a = n?.querySelector(".actions") ?? null;
    return {
      otherId: n?.dataset.blockId ?? null,
      otherOpacity: a ? Number(getComputedStyle(a).opacity) : -1,
      hovered: n ? n.matches(":hover") : false,
    };
  })()`).catch(() => ({ otherId: null, otherOpacity: -1, hovered: false }));
  // 收尾：Esc 退出改名（既有路径）→ 删掉刚建的那块
  await evaluate(`(() => {
    document.querySelector("input.name-input")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return true;
  })()`).catch(() => {});
  await sleep(140);
  await evaluate(`(() => {
    document.querySelector('[data-block-id="${st.id}"] .actions button[title="删除块"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.activeElement?.blur?.();
    return true;
  })()`).catch(() => {});
  await sleep(220);
  const after = await evaluate(`document.querySelectorAll("[data-block-id]").length`).catch(() => -1);
  const ok = onInput.acts === null && !covers && onOther.otherOpacity === 1 && after === before && flash.hot === 0 && flash.inputSeen;
  return {
    ok,
    created: st.count === before + 1,
    id: st.id,
    covers,
    actsOpacity: onInput.actsOpacity,
    controlOpacity: onOther.otherOpacity,
    controlId: onOther.otherId,
    controlHovered: onOther.hovered,
    flash,
    before,
    after,
  };
}

/**
 * round80（79-01）：真键盘，应用内危险确认面板 —— 初始焦点在「取消」；真 Enter = 取消（不写库）；
 * 真 Tab 移到危险动作（只聚焦，不按）；真 Esc 关掉。面板用真鼠标点开。
 */
async function realConfirmProbe() {
  const moveTo = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await sleep(60);
  };
  const clickAt = async (x, y) => {
    await moveTo(x, y);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await sleep(24);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(90);
  };
  const key = async (vk, k, code) => {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: k,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      // Enter 要带 `text` 才会触发焦点按钮的默认激活（`rawKeyDown` 不会）—— 与真实按键一致
      text: k === "Enter" ? "\r" : undefined,
      unmodifiedText: k === "Enter" ? "\r" : undefined,
    });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(80);
  };
  /** 把「重置统计」滚进视野并返回**命中测试通过**的中心点（屏外/被盖住就 null） */
  const buttonPoint = async () => {
    await evaluate(`(() => { document.querySelector(".stats-panel .reset-stats")?.scrollIntoView({ block: "center" }); return true; })()`).catch(() => {});
    await sleep(140);
    return await evaluate(`(() => {
      const b = document.querySelector(".stats-panel .reset-stats");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === b || b.contains(hit))) return null;
      return { x, y };
    })()`).catch(() => null);
  };
  // 干净起点：关所有覆盖层 + 打开统计
  await evaluate(`document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click()); true`).catch(() => {});
  await evaluate(
    `document.querySelectorAll(".stats-panel .close, .sanity-pop .close, .review-panel .close, .ach-panel .close").forEach((b) => b.click()); true`,
  ).catch(() => {});
  await sleep(160);
  await evaluate(`document.querySelector(".stats-open")?.click(); true`).catch(() => {});
  await sleep(240);
  const btn = await buttonPoint();
  if (!btn) return { ok: true, skipped: true };
  // round80（6b P0）：读 `__STATS_RESET_AT`（**只有真重置才写**）—— 旧写法读的计数器当时不存在 → 0===0 恒真
  const before = await evaluate(`window.__STATS_RESET_AT || 0`).catch(() => -1);
  // ① 真鼠标点「重置统计」→ 面板出现、焦点在取消
  await clickAt(btn.x, btn.y);
  await sleep(260);
  const focus = await evaluate(`(() => ({ up: !!document.querySelector(".confirm-panel"), active: (document.activeElement?.className || document.activeElement?.tagName || "?") + "", isCancel: document.activeElement === document.querySelector(".confirm-cancel") }))()`).catch(() => ({}));
  // ② 真 Enter（焦点在取消）→ 关 + 不写
  // （灵敏度对照：临时在 Enter 前插一个真 Tab → Enter 落到危险动作 → `写入` 变非 0 → 探针红，已实测。）
  await key(13, "Enter", "Enter");
  await sleep(220);
  const afterEnter = await evaluate(`(() => ({ up: !!document.querySelector(".confirm-panel"), resets: window.__STATS_RESET_AT || 0 }))()`).catch(() => ({}));
  // ③ 再开 → 真 Tab（落到危险动作上；只聚焦不按）
  const btn2 = await buttonPoint();
  if (!btn2) return { ok: false, why: "第二次找不到/点不到「重置统计」", focus, afterEnter };
  await clickAt(btn2.x, btn2.y);
  await sleep(260);
  await key(9, "Tab", "Tab");
  await sleep(160);
  const afterTab = await evaluate(`(() => ({ onDanger: document.activeElement === document.querySelector(".confirm-danger"), active: (document.activeElement?.className || "?") + "" }))()`).catch(() => ({}));
  // ④ 真 Esc → 关
  await key(27, "Escape", "Escape");
  await sleep(220);
  const afterEsc = await evaluate(`(() => ({ up: !!document.querySelector(".confirm-panel"), resets: window.__STATS_RESET_AT || 0 }))()`).catch(() => ({}));
  // 收尾：关统计
  await evaluate(`document.querySelector(".stats-panel .close")?.click(); true`).catch(() => {});
  await sleep(140);
  const ok =
    focus.up &&
    focus.isCancel &&
    !afterEnter.up &&
    afterEnter.resets === before &&
    afterTab.onDanger &&
    !afterEsc.up &&
    afterEsc.resets === before;
  return { ok, focus, afterEnter, afterTab, afterEsc, before };
}

/**
 * round82（3.1c₂ · Step 7 / C6）：**真 CDP 组合键** —— 改键位面板里录一条 `Ctrl+Shift+G`，
 * 真鼠标点键帽 → 真组合键落定 → 键帽显示同串 + 「已改」；再点行尾「恢复默认」回到 `T`。
 * 边界（诚实）：跑的是 Edge（**不是 WebView2**）→ 只自证「前端捕获 + 规范化 + 落库 + 恢复」这条链。
 */
async function realKeymapComboProbe() {
  const clickAt = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await sleep(40);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await sleep(24);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(100);
  };
  const comboKey = async () => {
    // Ctrl(2) + Shift(8) = 10；主键 G（**不用 Ctrl+Alt**：Windows 上有可能被当 AltGr，我们的规范化会拒绝）
    const base = { key: "G", code: "KeyG", windowsVirtualKeyCode: 71, nativeVirtualKeyCode: 71, modifiers: 10 };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await sleep(40);
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(180);
  };
  const rowExpr = (label) =>
    `[...document.querySelectorAll(".keymap-panel .rows tr")].find((tr) => (tr.querySelector(".nm")?.textContent ?? "").trim().startsWith(${JSON.stringify(label)}))`;
  const setBarHidden = async (hidden) =>
    evaluate(`(() => {
      const bars = [...document.body.children].filter(
        (n) => n.tagName === "DIV" && /z-index:\\s*9999/.test(n.getAttribute("style") || ""),
      );
      for (const b of bars) b.style.display = ${hidden ? '"none"' : '""'};
      return bars.length;
    })()`).catch(() => 0);
  // 干净起点 → 设置 → 改键位
  await evaluate(`document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click()); true`).catch(() => {});
  await evaluate(`document.querySelectorAll(".sanity-pop .close, .stats-panel .close, .review-panel .close, .keymap-panel .close").forEach((b) => b.click()); true`).catch(() => {});
  await sleep(160);
  await evaluate(`document.querySelector(".sanity-gear")?.click(); true`).catch(() => {});
  await sleep(200);
  await evaluate(`document.querySelector(".sanity-pop .keymap-open")?.click(); true`).catch(() => {});
  await sleep(240);
  // 预览的断言结果条（position:fixed + z-index:9999）盖住屏幕上半 —— 它在，键帽/行尾按钮的真鼠标会被它吃掉；
  // 截图早已拍完，这里临时隐藏（结束恢复）
  await setBarHidden(true);
  const capPoint = await evaluate(`(() => {
    const b = ${rowExpr("回到本周")}?.querySelector(".kbd");
    if (!b) return null;
    b.scrollIntoView({ block: "center" });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`).catch(() => null);
  if (!capPoint) return { ok: true, skipped: true };
  await clickAt(capPoint.x, capPoint.y);
  await sleep(140);
  const recording = await evaluate(`!!document.querySelector(".keymap-panel .kbd.on")`).catch(() => false);
  await comboKey();
  const after = await evaluate(`(() => {
    const row = ${rowExpr("回到本周")};
    return { cap: (row?.querySelector(".kbd")?.textContent ?? "").trim(), marked: !!row?.querySelector(".done") };
  })()`).catch(() => ({}));
  // 真鼠标点行尾「恢复默认」
  const resetPoint = await evaluate(`(() => {
    const b = ${rowExpr("回到本周")}?.querySelector(".reset");
    if (!b) return null;
    b.scrollIntoView({ block: "center" });
    const r = b.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    const chain = (() => {
      const out = [];
      for (let n = hit; n && out.length < 5; n = n.parentElement) out.push((n.className || n.tagName) + "");
      return out;
    })();
    return { x, y, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], hit: hit ? (hit.className || hit.tagName) + "" : "none", chain, isBtn: hit === b || !!b.contains(hit) };
  })()`).catch(() => null);
  if (resetPoint?.isBtn) {
    await clickAt(resetPoint.x, resetPoint.y);
    await sleep(220);
  }
  const back = await evaluate(`(() => {
    const row = ${rowExpr("回到本周")};
    return { cap: (row?.querySelector(".kbd")?.textContent ?? "").trim(), marked: !!row?.querySelector(".done") };
  })()`).catch(() => ({}));
  // 收尾：全部恢复默认（幂等）+ 关面板
  await evaluate(`document.querySelector(".keymap-panel .reset-all")?.click(); true`).catch(() => {});
  await sleep(160);
  await evaluate(`document.querySelector(".keymap-panel .close")?.click(); document.querySelector(".sanity-pop .close")?.click(); true`).catch(() => {});
  await sleep(160);
  await setBarHidden(false);
  return { ok: recording && after.cap === "Ctrl+Shift+G" && after.marked && back.cap === "T" && !back.marked, recording, after, back, reset: resetPoint };
}

/**
 * round83（§8.3）：**全局快捷键之后的焦点环** —— 真鼠标点过周导航 `›` 后真按 `T`，
 * 那颗按钮不该还带着 `:focus-visible`（看着像「被选中」）；而**键盘 Tab 过去的焦点不许被夺走**。
 * 为什么要真输入：`:focus-visible` 与交互模态绑定，程序化 click / focus 复现不出来。
 */
async function realFocusRingProbe() {
  const centerOf = (sel) =>
    evaluate(
      `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null;
         const r = n.getBoundingClientRect();
         return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    ).catch(() => null);
  const clickAt = async (pt) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, buttons: 0 });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: pt.x,
      y: pt.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: pt.x,
      y: pt.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  };
  const realChar = async (ch) => {
    const code = `Key${ch.toUpperCase()}`;
    const vk = ch.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: ch,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      text: ch,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: ch,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
  };
  /** 方向键（6b 复核 P2：←/→ 分支也得放掉指针焦点 —— 与 `T` 同一类） */
  const realArrow = async (key) => {
    const vk = key === "ArrowLeft" ? 37 : 39;
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: key,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: key,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
  };
  const realTab = async () => {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });
  };
  const read = () =>
    evaluate(`(() => {
      const a = document.activeElement;
      const nav = document.querySelector(".week-nav button[title^='下一周']");
      return {
        onNav: !!a?.closest?.(".week-nav"),
        active: a ? (a.className || a.tagName) + "" : "none",
        navFv: !!nav?.matches(":focus-visible"),
        navFocused: !!nav && a === nav,
      };
    })()`).catch(() => ({}));
  // 干净起点：关掉可能开着的浮层、放掉焦点
  await evaluate(
    `document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click()); document.activeElement?.blur?.(); true`,
  ).catch(() => {});
  await sleep(200);
  const pt = await centerOf(".week-nav button[title^='下一周']");
  if (!pt) return { ok: true, skipped: true };
  // ① 真鼠标点「下一周」→ 真按 T：那颗按钮不该再有焦点 / 焦点环
  await clickAt(pt);
  await sleep(180);
  const afterClick = await read();
  // 诊断（round83 现场）：在**捕捉阶段**（早于应用的 bubble 处理器）记一眼 `:focus-visible` ——
  // 它到底是「按键之前就已经翻成 true」还是「应用处理完才翻」决定了守卫生不生效。
  await evaluate(
    `(() => { const nav = document.querySelector(".week-nav button[title^='下一周']");
       window.__RING_AT_CAPTURE = null;
       window.addEventListener("keydown", () => { window.__RING_AT_CAPTURE = !!nav?.matches(":focus-visible"); }, { capture: true, once: true });
       return true; })()`,
  ).catch(() => {});
  await realChar("t");
  await sleep(220);
  const ringAtCapture = await evaluate(`window.__RING_AT_CAPTURE`).catch(() => null);
  const afterKey = await read();
  // ② 灵敏度对照（守卫生效）：真 Tab 建立**键盘模态** → 聚焦同一颗按钮（= 键盘焦点）
  //    → 真按 T → 焦点与焦点环都要**留着**（不被守卫误伤）
  await evaluate(`document.activeElement?.blur?.(); true`).catch(() => {});
  await realTab();
  await sleep(60);
  await evaluate(
    `document.querySelector(".week-nav button[title^='下一周']")?.focus({ preventScroll: true }); true`,
  ).catch(() => {});
  await sleep(120);
  const keyboardFocus = await read();
  await realChar("t");
  await sleep(220);
  const afterKeyKeyboard = await read();
  // ③ 6b 复核 P2：**方向键**（← 跳周）也得放掉指针焦点 —— 同一类 bug 的另一条分支
  await evaluate(`document.activeElement?.blur?.(); true`).catch(() => {});
  await clickAt(pt);
  await sleep(180);
  const arrowBefore = await read();
  await realArrow("ArrowLeft");
  await sleep(220);
  const arrowAfter = await read();
  const ok =
    !!afterClick.onNav &&
    !afterKey.navFocused &&
    !afterKey.navFv &&
    !!keyboardFocus.navFocused &&
    !!keyboardFocus.navFv &&
    !!afterKeyKeyboard.navFocused &&
    !!afterKeyKeyboard.navFv &&
    !!arrowBefore.onNav &&
    !arrowAfter.navFocused &&
    !arrowAfter.navFv;
  return { ok, afterClick, afterKey, ringAtCapture, keyboardFocus, afterKeyKeyboard, arrowBefore, arrowAfter };
}

/**
 * round86（工具改进）：**断言没跑完就不跑探针**。
 * 为什么加：探针要的是一个「断言跑完、页面安静」的页面。套件超时（长套件在负载高的机器上会超过 90s
 * 等待窗）时页面里还留着未收尾的手势 / 开着的面板 / 滚到一半的视野 —— 探针会报出一堆**假红**，
 * 尤其是「真双击改名没出现」这种（你会去查产品 bug，其实是套件没跑完）。
 * 判据：document.title 只有跑完才会是 `ALLOK…` / `FAIL…`。
 */
const suiteDone = typeof title === "string" && (title.startsWith("ALLOK") || title.startsWith("FAIL"));
const probeSkip = noProbe || !suiteDone;
if (!noProbe && !suiteDone) {
  console.error(
    "⚠️ 断言没跑完（等不到 ALLOK/FAIL）→ 本轮**不跑真输入探针**（避免假红）；先看上面那行的「卡在哪条断言」。",
  );
}
const realInput = probeSkip ? { ok: true, title: "（跳过：断言没跑完 / --no-probe）", skipped: true } : await realDoubleClickRenameProbe();
const realMulti = probeSkip ? { ok: true, skipped: true } : await realCtrlClickMultiSelectProbe();
const realRail = probeSkip ? { ok: true, skipped: true } : await realRailExpandProbe();
const realCat = probeSkip ? { ok: true, skipped: true } : await realCategoryPickProbe();
// round77 收尾（界面审计 §1.3 / L5 / L6 · 6b 任务书“Tab 走查”）：真键盘才验得出 `:focus-visible` 与 Tab 顺序
const realTab = probeSkip ? { ok: true, skipped: true } : await tabWalkthroughProbe();
// round78（3.1b₂ · Step 1）：块上动作浮层的真鼠标 / 真键盘（`#1` 链接后常亮 / `#2b` 聚焦盖名字）
const realActs = probeSkip ? { ok: true, skipped: true } : await realBlockActionsProbe();
// round82（11.2）：真鼠标 / 真键盘 —— 并排块浮层三档排布（固定宽 / 不竖排 / 命中区 24）
const realNarrow = probeSkip ? { ok: true, skipped: true } : await realNarrowOverlayProbe();
// round85（0.31.0 · §5-DU）：真鼠标 —— 矮块浮层贴块外沿 + 块身能拖 + 下沿能拉
const realShort = probeSkip ? { ok: true, skipped: true } : await realShortOverlayProbe();
// round85（0.31.0）：底纹性能探针（你问的「这层 CSS 开销大不大」→ 帧数字说话）
const realPaint = probeSkip ? { ok: true, skipped: true } : await realPaintProbe();
// round79（78-09）：真鼠标停在「就地命名中的块」上 —— 动作浮层不该压住命名输入框
const realRename = probeSkip ? { ok: true, skipped: true } : await realRenameOverlayProbe();
// round80（79-01）：真键盘走应用内危险确认面板（Enter=取消 / Tab 到危险动作 / Esc 关闭）
const realConfirm = probeSkip ? { ok: true, skipped: true } : await realConfirmProbe();
// round82（3.1c₂ · Step 7 / C6）：真 CDP 组合键走改键位面板（录制 / 保存 / 已改 / 恢复默认）
const realKeymap = probeSkip ? { ok: true, skipped: true } : await realKeymapComboProbe();
// round83（§8.3）：真键盘 —— 全局键之后的焦点环（鼠标点的焦点要放掉 / Tab 来的焦点要留住）
const realRing = probeSkip ? { ok: true, skipped: true } : await realFocusRingProbe();
/** 探针报告用：成功时一行摘要（压缩后的调用栈只在失败时才打，不然日志太长） */
const catLine = (r) =>
  !r
    ? "-[无]"
    : r.err
      ? `[${r.title ?? "?"} 错=${r.err}]`
      : `[${r.title} ${r.before ?? "?"}→${r.target ?? "?"}：库=${r.db} 组=${r.group} 框=${r.shown} 写=[${(r.writes || []).join(",")}] 事件=[${(r.events || []).join(",")}]${
          realCat.ok ? "" : " 栈=" + JSON.stringify((r.stacks || []).slice(0, 2))
        }]`;

const shot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
if (shot?.data) await writeFile(out, Buffer.from(shot.data, "base64"));
// 截图**前**再取一次现场（这才描述的是被拍下来的那一帧 —— 否则打印的是起跑前的旧值）
state =
  (await evaluate(
    "document.documentElement.dataset.checks + ' / ' + (document.documentElement.dataset.checksRun || '-')" +
      " + ' ｜ 块数=' + document.querySelectorAll('[data-block-id]').length" +
      " + ' ｜ 复盘面板=' + (() => { const p = document.querySelector('.review-panel'); if (!p) return '无'; const r = p.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })()" +
      " + ' ｜ 遮罩=' + (document.querySelector('.overlay-backdrop') ? '在' : '无')",
  ).catch((e) => "读取失败：" + e)) ?? state;

/** 收尾：关 CDP / 杀 Edge / 关静态服务器（矩阵还要接着用 CDP，所以不能提前关） */
const cleanup = () => {
  try {
    ws.close();
  } catch {}
  try {
    child.kill();
  } catch {}
  try {
    server.close();
  } catch {}
};

console.log(`截图：${out}（退出码 0）`);
console.log(`断言：${title}`);
if (only) console.log(`只跑断言：${only}（窗口 ${width}px）`);
else console.log(`窗口宽度：${width}px`);
if (state) console.log(`页面状态：${state}`);
console.log(
  `真输入探针（CDP 双击任务名 → 改名输入框）：${realInput.ok ? "✓ 出现" : "✗ 没出现"}` +
    (realInput.why ? `（${realInput.why}）` : realInput.title ? `（「${realInput.title}」）` : "（无任务名）"),
);
console.log(
  `真输入探针（CDP 真 Ctrl+左键 → 多选动作条）：${
    realMulti.skipped ? "（跳过：没种 round61 靶子块）" : realMulti.ok ? "✓ 已选 2 块" : "✗ 没出现"
  }` +
    (realMulti.skipped
      ? ""
      : `（计数=${realMulti.count ?? "?"} 首点选中=${realMulti.afterFirst ?? "?"} 文案=[${realMulti.text ?? ""}]${realMulti.err ? " 错=" + realMulti.err : ""}${realMulti.why ? " 因=" + realMulti.why : ""}）`),
);
console.log(
  `真输入探针（CDP 真 hover 细轨（不该弹）→ 真点窄条 → 展开）：${
    realRail.skipped ? "（跳过：没有细轨形态）" : realRail.ok ? "✓ 回 open" : "✗ 没展开"
  }` +
    (realRail.skipped
      ? ""
      : `（细轨=${realRail.railOn ?? "?"} 悬停弹层=${realRail.peekOn ?? "?"} 时间轴左=${realRail.leftBefore ?? "?"}→${realRail.leftHover ?? "?"} 回open=${realRail.openBack ?? "?"}${realRail.why ? " 因=" + realRail.why : ""}）`),
);
console.log(
  `真输入探针（CDP 真鼠标：分组 ON/OFF 拍选分类 / 打字新建「探针分类DA」）：${
    realCat.skipped
      ? realCat.ok
        ? "（跳过）"
        : "✗ 没跑成：" + (realCat.why || "")
      : realCat.ok
        ? "✓ 四处都留住"
        : "✗ 被旧值盖回"
  }` +
    (realCat.skipped
      ? ""
      : `（${catLine(realCat.setup)} ${catLine(realCat.a)} ${catLine(realCat.b)} ${catLine(realCat.c)} ${catLine(realCat.d)}）`),
);
console.log(
  `真键盘探针（Tab 走查：遮罩不在 Tab 顺序 / 面板内起扫 / 不落遮罩 / 块聚焦不出浮层 / Tab 进按钮才出 / 焦点环）：${
    realTab.skipped
      ? "（跳过）"
      : realTab.ok
        ? `✓ 遮罩 tabIndex=${realTab.backdropTabIndex} · 面板内起扫 ${realTab.startInPanel} · 扫中面板内 ${realTab.inPanel} 下 · 遮罩命中 ${realTab.backdropHits} 次`
        : `✗ 遮罩 tabIndex=${realTab.backdropTabIndex}（期望 -1）· 面板内起扫 ${realTab.startInPanel} · 块聚焦不出浮层 ${realTab.blockFocusHidden} · Tab 进按钮出浮层 ${realTab.btnFocusShown}（${realTab.btnFocus?.steps} 步）· 焦点环 ${realTab.ringOk}（前 6 下：${(realTab.seen ?? []).join(" → ")}）`
  }`,
);
console.log(
  `真输入探针（CDP 真鼠标：链两块后浮层不靠焦点常亮 / hover 才出 / Tab 到块上不盖名字）：${
    realActs.skipped
      ? "（跳过）"
      : realActs.ok
        ? `✓ hover 出浮层（头高 ${realActs.hNoHover}→${realActs.hHover} 不变）· 鼠标移开后两块的 alpha=${realActs.afterAway?.a}/${realActs.afterAway?.b} · Tab 到块（${realActs.focusedId}）不出浮层且不盖名字 · Tab ${realActs.btn?.steps} 步进按钮时浮层出`
        : `✗ hover 出浮层 ${realActs.hoverShown}（指针底下=${realActs.hoverHit ?? "?"}）· 移开后两块 alpha=${realActs.afterAway?.a}/${realActs.afterAway?.b}（期望 0/0）· Tab 到块 opacity=${realActs.kbState?.opacity ?? realActs.kbState?.err} 相交=${realActs.kbState?.overlap} · Tab 进按钮 ${realActs.btn?.inActs}/${realActs.btn?.opacity}`
  }`,
);
console.log(
  `真输入探针（CDP 真鼠标 / 真键盘：并排块浮层三档 —— hover 出 / 移开收 / Tab 进按钮可见）：${
    realNarrow.skipped
      ? "（跳过：没有可点的并排块）"
      : realNarrow.ok
        ? `✓ N=${realNarrow.cols} 每行 ${Math.max(1, Math.floor(((realNarrow.on?.aw ?? 0) - 2) / 28))} 枚 → 宽 ${realNarrow.on?.aw}×${realNarrow.on?.ah}（块宽 ${realNarrow.on?.blockW}）· 按钮 ${JSON.stringify(realNarrow.on?.btns)} · 移开 opacity=${realNarrow.off?.opacity} · Tab ${realNarrow.steps} 步 opacity=${realNarrow.kb?.opacity}`
        : `✗ N=${realNarrow.cols} hover 宽 ${realNarrow.on?.aw}×${realNarrow.on?.ah}（块宽 ${realNarrow.on?.blockW} · 期望高 ${realNarrow.expH}）· 按钮 ${JSON.stringify(realNarrow.on?.btns)} · 移开 opacity=${realNarrow.off?.opacity}（期望 0）· Tab ${realNarrow.steps} 步 inside=${realNarrow.kb?.inside} opacity=${realNarrow.kb?.opacity} · 现场 ${JSON.stringify({ w: realNarrow.on?.wrap, maxW: realNarrow.on?.maxW, blockW: realNarrow.on?.blockW, rows: realNarrow.on?.rows })}`
  }`,
);
console.log(
  `真输入探针（CDP 真鼠标：矮块浮层 —— 贴块外沿不压块 / 块身能拖 / 下沿能拉）：${
    realShort.skipped
      ? `（跳过：${realShort.why ?? "没有够矮的块"}）`
      : realShort.ok
        ? `✓ ${realShort.id}/${realShort.overlay} 块高 ${realShort.on?.h}px 可拖面 ${realShort.faceH}px · 浮层 ${realShort.on?.aw}×${realShort.on?.ah} 与块相交 ${realShort.on?.gap}px（期望 0）列内=${realShort.on?.inBodyV} · 真按块身（${realShort.hitFace}）起拖：拖影 ${
            realShort.ghostBefore
          }→${realShort.ghostDuring}→${realShort.ghostAfter} · 真按下沿（${realShort.hitBot}）起拉：辅助线 ${realShort.before}→${realShort.resize?.lines} 高 ${realShort.on?.h}→${realShort.resize?.h}`
        : `✗ ${realShort.id}/${realShort.overlay} 浮层 opacity=${realShort.on?.opacity} 相交=${realShort.on?.gap}（期望 0）列内=${realShort.on?.inBodyV} · 残影 遗留/清后/前/中/后=${realShort.ghostStale}/${realShort.ghostAfterCleanup}/${realShort.ghostBefore}/${realShort.ghostDuring}/${realShort.ghostAfter} · 拖点=${realShort.hitFace} 拉点=${realShort.hitBot} 辅助线 ${realShort.before}→${realShort.resize?.lines} 高 ${realShort.on?.h}→${realShort.resize?.h} ｜ ${JSON.stringify({ faceH: realShort.faceH, overlayOk: realShort.overlayOk, dragOk: realShort.dragOk, resizeOk: realShort.resizeOk })}`
  }`,
);
console.log(
  `真输入探针（CDP 真鼠标：底纹性能 —— warm（无底纹）vs terminal/endfield（有底纹）滚动 90 帧）：${
    realPaint.skipped
      ? "（跳过）"
      : realPaint.ok
        ? `✓ rAF 间隔 p50/p95/max（ms）warm=${realPaint.warm?.p50}/${realPaint.warm?.p95}/${realPaint.warm?.max} · terminal=${realPaint.terminal?.p50}/${realPaint.terminal?.p95}/${realPaint.terminal?.max} · endfield=${realPaint.endfield?.p50}/${realPaint.endfield?.p95}/${realPaint.endfield?.max} · 回 warm=${realPaint.warm2?.p95} ｜ 最差Δ=${realPaint.delta}ms ｜ 块数=${realPaint.endfield?.blocks}`
        : `✗ ${realPaint.why ?? "帧时长异常"} warm=${JSON.stringify(realPaint.warm)} terminal=${JSON.stringify(realPaint.terminal)} endfield=${JSON.stringify(realPaint.endfield)} warm2=${JSON.stringify(realPaint.warm2)}`
  }`,
);
console.log(
  `真输入探针（CDP 真鼠标：改名中的块上 hover → 动作浮层不能压住输入框）：${
    realRename.skipped
      ? "（跳过：窄窗/靶子不在视口）"
      : realRename.ok
        ? `✓ 改名中浮层不存在（对照组别的块 hover 后 opacity=${realRename.controlOpacity}）· 逐帧零闪现（${realRename.flash?.frames} 帧 / 峰值 opacity=${realRename.flash?.max}）· 块数 ${realRename.before}→${realRename.after}`
        : `✗ 改名中浮层=${realRename.actsOpacity === -1 ? "不存在" : "存在 opacity=" + realRename.actsOpacity} 相交=${realRename.covers} · 逐帧闪现 ${realRename.flash?.hot} 帧（峰值 opacity=${realRename.flash?.max}${realRename.flash?.firstHot ? "，首次=" + JSON.stringify(realRename.flash.firstHot) : ""}）· 对照块 ${realRename.controlId} hovered=${realRename.controlHovered} opacity=${realRename.controlOpacity}（期望 1）· 块数 ${realRename.before}→${realRename.after}（期望相等）${realRename.why ? " · 原因=" + realRename.why : ""}`
  }`,
);
console.log(
  `真输入探针（CDP 真组合键：改键位面板录 Ctrl+Shift+G → 键帽 / 已改 / 恢复默认）：${
    realKeymap.skipped
      ? "（跳过：面板/键帽不在）"
      : realKeymap.ok
        ? `✓ 键帽=${realKeymap.after?.cap} 已改=${realKeymap.after?.marked} → 恢复=${realKeymap.back?.cap}`
        : `✗ 录制=${realKeymap.recording} 键帽=${realKeymap.after?.cap}（期望 Ctrl+Shift+G）已改=${realKeymap.after?.marked} 恢复=${realKeymap.back?.cap}（期望 T） 重置点=${JSON.stringify(realKeymap.reset)}`
  }`,
);
if (!realInput.ok) {
  console.error("❌ 真输入探针失败 —— 用真鼠标双击 Backlog 的任务名应当出现改名输入框");
  cleanup();
  process.exit(1);
}
if (!realMulti.ok) {
  console.error("❌ 真输入探针失败 —— 用真 Ctrl+左键应当加选并冒出多选动作条");
  cleanup();
  process.exit(1);
}
if (!realRail.ok) {
  console.error("❌ 真输入探针失败 —— 真鼠标点细轨窄条应当把任务栏展开回 open（且悬停不该弹层）");
  cleanup();
  process.exit(1);
}
if (!realCat.ok) {
  console.error("❌ 真输入探针失败 —— 分组 ON/OFF 下改任务分类 / 清空 / 打字新建，新值被旧值盖回去了（或探针没跑成，看上一行）");
  cleanup();
  process.exit(1);
}
if (!realTab.ok) {
  console.error("❌ 真键盘探针失败 —— 面板开着时 Tab 落到遮罩 / 块聚焦后浮层盖住名字 / Tab 进按钮浮层不出现 / 焦点环不可见（看上一行）");
  cleanup();
  process.exit(1);
}
if (!realActs.ok) {
  console.error("❌ 真输入探针失败 —— 链两块之后浮层靠焦点常亮 / Tab 到块上浮层盖住块名 / hover 不出浮层（看上一行）");
  cleanup();
  process.exit(1);
}
if (!realRename.ok) {
  console.error("❌ 真输入探针失败 —— 改名期间动作浮层盖住输入框 / hover 通道坏了 / 临时块没清干净（看上一行）");
  cleanup();
  process.exit(1);
}
console.log(
  `真键盘探针（危险确认面板：初始焦点在取消 / 真 Enter=取消 / 真 Tab 到危险动作 / 真 Esc 关）：${
    realConfirm.skipped
      ? "（跳过：没找到「重置统计」靶子）"
      : realConfirm.ok
        ? `✓ 焦点在取消（${realConfirm.focus?.active}）· Enter 后仍在=${realConfirm.afterEnter?.up} 写入=${realConfirm.afterEnter?.resets}（期望 ${realConfirm.before}）· Tab 到危险=${realConfirm.afterTab?.onDanger} · Esc 后仍在=${realConfirm.afterEsc?.up}`
        : `✗ 焦点在取消=${realConfirm.focus?.isCancel}（active=${realConfirm.focus?.active}）· Enter 后仍在=${realConfirm.afterEnter?.up} 写入=${realConfirm.afterEnter?.resets}（期望 ${realConfirm.before}）· Tab 到危险=${realConfirm.afterTab?.onDanger}（active=${realConfirm.afterTab?.active}）· Esc 后仍在=${realConfirm.afterEsc?.up}${realConfirm.why ? " · 原因=" + realConfirm.why : ""}`
  }`,
);
if (!realConfirm.ok) {
  console.error("❌ 真键盘探针失败 —— 危险确认面板：初始焦点不在取消 / Enter 误触发写入 / Tab 到不了危险动作 / Esc 关不掉（看上一行）");
  cleanup();
  process.exit(1);
}
if (!realKeymap.ok) {
  console.error("❌ 真输入探针失败 —— 改键位面板里真组合键应当被录下（Ctrl+Shift+G）并能恢复默认（看上一行）");
  cleanup();
  process.exit(1);
}
console.log(
  `真键盘探针（全局键后的焦点环：鼠标点 › 后按 T 不留环 / Tab 过去的焦点不被夺走）：${
    realRing.skipped
      ? "（跳过：找不到周导航「下一周」）"
      : realRing.ok
        ? `✓ 点后焦点在导航=${realRing.afterClick?.onNav} · 点后环=${realRing.afterClick?.navFv} · 按键捕捉时环=${realRing.ringAtCapture} · 按 T 后仍聚焦=${realRing.afterKey?.navFocused}/环=${realRing.afterKey?.navFv} · 键盘焦点保留=${realRing.afterKeyKeyboard?.navFocused} · 方向键后仍聚焦=${realRing.arrowAfter?.navFocused}/环=${realRing.arrowAfter?.navFv}`
        : `✗ 点后焦点在导航=${realRing.afterClick?.onNav}（active=${realRing.afterClick?.active}）环=${realRing.afterClick?.navFv} · 按键捕捉时环=${realRing.ringAtCapture} · 按 T 后仍聚焦=${realRing.afterKey?.navFocused} 环=${realRing.afterKey?.navFv} · 键盘焦点建立=${realRing.keyboardFocus?.navFocused}/${realRing.keyboardFocus?.navFv} · 按 T 后保留=${realRing.afterKeyKeyboard?.navFocused}/${realRing.afterKeyKeyboard?.navFv} · 方向键后仍聚焦=${realRing.arrowAfter?.navFocused}/${realRing.arrowAfter?.navFv}${realRing.arrowAfter?.active ? "（active=" + realRing.arrowAfter.active + "）" : ""}`
  }`,
);
if (!realRing.ok) {
  console.error("❌ 真键盘探针失败 —— 全局键之后焦点环没治理 / 或者把 Tab 过去的键盘焦点也夺走了（看上一行）");
  cleanup();
  process.exit(1);
}
// round85（0.31.0）：两条新探针也接上退出码（6b P1：以前只打印不拦 → 预览能「ALLOK」与「探针 ✗」同时出现）
if (!realShort.ok) {
  console.error("❌ 真鼠标探针（矮块浮层）失败 —— 浮层压块 / 抓不起 / 拉不动（看上一行）");
  cleanup();
  process.exit(1);
}
if (!realPaint.ok) {
  console.error("❌ 底纹性能探针失败 —— 配色没切上或帧时长病态（看上一行）");
  cleanup();
  process.exit(1);
}
if (!title.startsWith("ALLOK")) {
  console.error("❌ 预览断言有失败项 —— 上面那行就是失败明细（截图顶部也有 ✓/✗ 列表）");
  cleanup();
  process.exit(1);
}

// ---------------------------------------------------------------- round87：字体档一维（5 档 × zh/en × 1500/715）
if (fontScan) {
  const SCAN_FONTS = ["default", "song", "kai", "deng", "mono"];
  const SCAN_LOCALES = ["zh", "en"];
  const SCAN_WIDTHS = [1500, 715];
  const rows = [];
  const failures = [];
  for (const loc of SCAN_LOCALES) {
    for (const w of SCAN_WIDTHS) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height, deviceScaleFactor: 0.75, mobile: false });
      await sleep(200);
      for (const f of SCAN_FONTS) {
        const res = await evaluateAsync(
          `(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            if (!document.querySelector(".sanity-pop")) {
              document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
              await sleep(600);
            }
            const panel = document.querySelector(".sanity-pop");
            if (!panel) return { fails: ["设置面板没打开"] };
            const fsel = panel.querySelector(".font-family");
            if (!fsel) return { fails: ["没有 .font-family"] };
            fsel.value = ${JSON.stringify(f)};
            fsel.dispatchEvent(new Event("change", { bubbles: true }));
            const lsel = panel.querySelector("select.lang");
            if (lsel) {
              lsel.value = ${JSON.stringify(loc)};
              lsel.dispatchEvent(new Event("change", { bubbles: true }));
            }
            await sleep(700);
            const offenders = await scanOverflow();
            const stack = getComputedStyle(document.body).fontFamily;
            return {
              dataFont: document.documentElement.dataset.font,
              lang: document.documentElement.lang,
              stack,
              theme: document.documentElement.dataset.theme ?? "(无 data-theme)",
              density: document.documentElement.dataset.density,
              blocks: document.querySelectorAll("[data-block-id]").length,
              offenders,
            };
          })()`,
        ).catch((e) => ({ fails: [`evaluate 抛错：${String(e).slice(0, 160)}`] }));
        const fails = [...((res && res.fails) || [])];
        if (res?.dataFont !== f) fails.push(`data-font=${res?.dataFont}≠${f}`);
        // 光看 data-font 不够 —— 它由 `paint()` 无条件写，`[data-font]` 选择器写错/被删也照样对；
        // 所以必须再查 **computed 栈里的特征族**（每档的 CJK 族名，与 round87 ① 同一套口径）。
        const SCAN_MARK = { default: "Microsoft YaHei UI", song: "SimSun", kai: "KaiTi", deng: "DengXian", mono: "Cascadia Mono" };
        if (!String(res?.stack ?? "").includes(SCAN_MARK[f])) {
          fails.push(`computed 栈里没有 ${SCAN_MARK[f]}：${String(res?.stack ?? "").slice(0, 80)}`);
        }
        if (f === "default" && String(res?.stack ?? "").includes("Cascadia Mono")) fails.push("默认档串成了等宽栈");
        if (loc === "en" && res?.lang !== "en") fails.push(`lang=${res?.lang}≠en`);
        const offenders = (res && res.offenders) || [];
        rows.push({ font: f, locale: loc, width: w, theme: res?.theme, density: res?.density, blocks: res?.blocks, offenders: offenders.length, fails });
        if (fails.length) failures.push(`${f}/${loc}/${w} → ${fails.slice(0, 3).join("; ")}`);
        process.stdout.write(
          `\r字体档扫描 ${rows.length}/${SCAN_FONTS.length * SCAN_LOCALES.length * SCAN_WIDTHS.length} 格（失败 ${failures.length}）`,
        );
      }
    }
  }
  process.stdout.write("\n");
  await mkdir(path.resolve("docs/visual/round87"), { recursive: true });
  await writeFile(
    path.resolve("docs/visual/round87/font-scan.json"),
    JSON.stringify(
      {
        note: "round87 字体档一维：5 档 × zh/en × 1500/715 溢出扫描（每格记 computed 栈 / 主题 / 密度 / 块数）",
        cells: rows.length,
        rows,
      },
      null,
      1,
    ),
  );
  console.log(`字体档扫描：${rows.length} 格，失败 ${failures.length} 格 → docs/visual/round87/font-scan.json`);
  for (const f of failures.slice(0, 20)) console.log(`  ✗ ${f}`);
  if (failures.length) {
    console.error("❌ 字体档扫描有失败格");
    cleanup();
    process.exit(1);
  }
  cleanup();
  process.exit(0);
}

// ---------------------------------------------------------------- round76：全矩阵（72 格 + round82 夜间 2 格）
if (matrix) {
  await mkdir(matrixDir, { recursive: true });
  const rows = [];
  let cells = 0;
  const failures = [];
  for (const palette of MATRIX_PALETTES) {
    for (const theme of MATRIX_THEMES) {
      for (const density of MATRIX_DENSITIES) {
        for (const w of MATRIX_WIDTHS) {
          for (const loc of MATRIX_LOCALES) {
            cells += 1;
            // 主题 + 宽度：CDP 改（与真产品同一条件：CSS 只认 prefers-color-scheme；布局只看视口）
            await send("Emulation.setEmulatedMedia", {
              features: [{ name: "prefers-color-scheme", value: theme }],
            });
            await send("Emulation.setDeviceMetricsOverride", {
              width: w,
              height,
              deviceScaleFactor: 0.75, // 0.75 栅格：图小 ~45%（布局不受影响，只是像素密度）
              mobile: false,
            });
            await sleep(180);
            // 一格的外观：走真实设置路径（设置面板的下拉 + change）
            const setErrs = await evaluateAsync(
              `window.__MATRIX.setCell(${JSON.stringify({ density, palette, locale: loc })})`,
            ).catch((e) => [`setCell 抛错：${e}`]);
            await sleep(120);
            const scan = await evaluateAsync(
              `window.__MATRIX.scan(${JSON.stringify({ density, palette, locale: loc })})`,
            ).catch((e) => ({
              offenders: [],
              fails: [`scan 抛错：${e}`],
            }));
            const cellFails = [...(setErrs ?? []), ...((scan && scan.fails) || [])];
            rows.push({ palette, theme, density, width: w, locale: loc, fails: cellFails });
            if (cellFails.length) {
              failures.push(
                `${palette}/${theme}/${density}/${w}/${loc} → ${cellFails.slice(0, 3).join("; ")}`,
              );
            }
            // 每格一张截图（JPEG q80 @0.75 栅格：72 张约 4–5MB；对照图 HTML 全列）
            const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 }).catch(
              () => null,
            );
            if (shot?.data) {
              const name = `${palette}-${theme}-${density}-${w}-${loc}.jpg`;
              await writeFile(path.join(matrixDir, name), Buffer.from(shot.data, "base64"));
            }
            process.stdout.write(
              `\r矩阵 ${cells}/${MATRIX_PALETTES.length * MATRIX_THEMES.length * MATRIX_DENSITIES.length * MATRIX_WIDTHS.length * MATRIX_LOCALES.length + MATRIX_THEMES.length} 格（失败 ${failures.length}）`,
            );
          }
        }
      }
    }
  }
  process.stdout.write("\n");
  // round82（3.1c₂ · Step 4）：**夜间两格** —— 「按时间（亮）/（暗）」：第四档 `night` + 包住现在的时段
  // → 每列一条淡化带；亮/暗两个世界由 CDP 的 `prefers-color-scheme` 区分（与其它格同一套断言/截图）
  for (const theme of MATRIX_THEMES) {
    cells += 1;
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    await send("Emulation.setDeviceMetricsOverride", {
      width: MATRIX_WIDTHS[0],
      height,
      deviceScaleFactor: 0.75,
      mobile: false,
    });
    await sleep(180);
    const cell = { density: "comfortable", palette: "warm", locale: "zh", night: true };
    const setErrs = await evaluateAsync(`window.__MATRIX.setCell(${JSON.stringify(cell)})`).catch((e) => [
      `setCell 抛错：${e}`,
    ]);
    await sleep(120);
    const scan = await evaluateAsync(`window.__MATRIX.scan(${JSON.stringify(cell)})`).catch((e) => ({
      offenders: [],
      fails: [`scan 抛错：${e}`],
    }));
    const cellFails = [...(setErrs ?? []), ...((scan && scan.fails) || [])];
    rows.push({
      palette: "warm",
      theme,
      density: "comfortable",
      width: MATRIX_WIDTHS[0],
      locale: "zh",
      night: true,
      fails: cellFails,
    });
    if (cellFails.length) {
      failures.push(`warm/${theme}/夜间 → ${cellFails.slice(0, 3).join("; ")}`);
    }
    const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 }).catch(() => null);
    if (shot?.data) {
      await writeFile(path.join(matrixDir, `night-${theme}.jpg`), Buffer.from(shot.data, "base64"));
    }
  }
  // round85（0.31.0）：**12 套逐套读类扫描**（亮/暗 = 24 格）—— 全矩阵只取 3 套代表（成本），
  // 覆盖面由这一段接住（只改配色，跑同一套只读检查 + 溢出扫描）。
  for (const theme of MATRIX_THEMES) {
    for (const palette of PALETTE_IDS) {
      cells += 1;
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      await send("Emulation.setDeviceMetricsOverride", {
        width: MATRIX_WIDTHS[0],
        height,
        deviceScaleFactor: 0.75,
        mobile: false,
      });
      await sleep(180);
      const cell = { density: "comfortable", palette, locale: "zh" };
      const setErrs = await evaluateAsync(`window.__MATRIX.setCell(${JSON.stringify(cell)})`).catch((e) => [
        `setCell 抛错：${e}`,
      ]);
      await sleep(120);
      const scan = await evaluateAsync(`window.__MATRIX.scan(${JSON.stringify(cell)})`).catch((e) => ({
        offenders: [],
        fails: [`scan 抛错：${e}`],
      }));
      const cellFails = [...(setErrs ?? []), ...((scan && scan.fails) || [])];
      rows.push({ palette, theme, density: "comfortable", width: MATRIX_WIDTHS[0], locale: "zh", sweep: true, fails: cellFails });
      if (cellFails.length) {
        failures.push(`${palette}/${theme}/配色扫描 → ${cellFails.slice(0, 3).join("; ")}`);
      }
    }
  }
  await writeFile(
    path.join(matrixDir, "matrix-results.json"),
    JSON.stringify(
      {
        note: "round76（3.1a）全矩阵：3 配色代表 × 2 主题 × 3 密度 × 2 宽 × 2 语言 = 72 格 + round82（Step 4）夜间两格（按时间 × 亮/暗）+ round85（0.31.0）**12 套逐套配色读类扫描**（亮/暗 = 24 格；只改配色，跑同一套只读检查 + 溢出扫描）",
        cells: rows.length,
        failed: failures.length,
        rows,
      },
      null,
      1,
    ),
  );
  console.log(`矩阵：${rows.length} 格，失败 ${failures.length} 格 → ${matrixDir}`);
  for (const f of failures.slice(0, 30)) console.log(`  ✗ ${f}`);
  if (failures.length) {
    console.error("❌ 全矩阵有失败格 —— 上面列的就是（明细见 matrix-results.json）");
    cleanup();
    process.exit(1);
  }
}

// ---------------------------------------------------------------- round76：组件展示页（尺寸表）
if (gallery) {
  await mkdir(galleryDir, { recursive: true });
  const combos = [];
  for (const palette of MATRIX_PALETTES) {
    for (const theme of MATRIX_THEMES) {
      for (const density of MATRIX_DENSITIES) combos.push({ palette, theme, density });
    }
  }
  const rows = [];
  const failures = [];
  let done = 0;
  for (const combo of combos) {
    done += 1;
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: combo.theme }],
    });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1500,
      height,
      deviceScaleFactor: 0.75, // 0.75 栅格：图小 ~45%（布局不受影响）
      mobile: false,
    });
    await sleep(160);
    const setErrs = await evaluateAsync(
      `window.__MATRIX.setCell(${JSON.stringify({ density: combo.density, palette: combo.palette, locale: "zh" })})`,
    ).catch((e) => [`setCell 抛错：${e}`]);
    await sleep(160);
    const m = await evaluateAsync("window.__GALLERY.measure()").catch((e) => ({ err: String(e) }));
    if (m && !m.err) rows.push(m);
    else failures.push(`${combo.palette}/${combo.theme}/${combo.density}：${m?.err ?? "量不到"}`);
    // 6b P2：固定槽是下限 —— 提示条的天然高超过它就会把头部顶高（在 compact 上实测过）
    const strip = parseFloat(m?.tokens?.stripHeight ?? "NaN");
    const sanityH = m?.measured?.sanityBar?.h ?? 0;
    if (Number.isFinite(strip) && sanityH > strip + 0.5) {
      failures.push(
        `槽高不够：${combo.palette}/${combo.theme}/${combo.density} 条高 ${sanityH} > --strip-height ${strip}`,
      );
    }
    if ((setErrs ?? []).length) {
      failures.push(`${combo.palette}/${combo.theme}/${combo.density}：${setErrs[0]}`);
    }
    const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 }).catch(
      () => null,
    );
    if (shot?.data) {
      const name = `${combo.density}-${combo.theme}-${combo.palette}.jpg`;
      await writeFile(path.join(galleryDir, name), Buffer.from(shot.data, "base64"));
    }
    process.stdout.write(`\r组件展示页 ${done}/${combos.length}`);
  }
  process.stdout.write("\n");
  // round77 收尾（图-13）：五套图标逐套量 —— 固定 舒适/warm/zh/1500px，亮/暗各一格
  const ICON_SETS = ["lucide", "tabler", "phosphor", "bootstrap", "material"];
  const iconRows = [];
  for (const set of ICON_SETS) {
    for (const theme of MATRIX_THEMES) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      await sleep(120);
      const errs = await evaluateAsync(
        `window.__MATRIX.setCell(${JSON.stringify({ density: "comfortable", palette: "warm", locale: "zh", iconSet: set })})`,
      ).catch((e) => [`setCell 抛错：${e}`]);
      await sleep(160);
      const m = await evaluateAsync("window.__GALLERY.measure()").catch((e) => ({ err: String(e) }));
      const stats = m?.measured?.iconStats;
      const pins = (m?.measured?.actionSvgs ?? []).filter((b) => b.icon);
      if (m && !m.err) {
        const hitMin = pins.length ? Math.min(...pins.map((p) => Math.min(p.w, p.h))) : -1;
        iconRows.push({
          set,
          theme,
          iconSetInDom: stats?.sets ?? [],
          sources: stats?.sources ?? [],
          withFallback: stats?.withFallback ?? -1,
          actions: pins.length,
          hitMin,
          svgSize: pins[0] ? [pins[0].svgW, pins[0].svgH] : null,
          emptyPath: pins.filter((p) => p.empty).length,
          withNoPath: stats?.withNoPath ?? -1,
          iconsTotal: stats?.total ?? -1,
          errs,
        });
        if (hitMin < 32) failures.push(`图标命中区 <32：${set}/${theme} = ${hitMin}`);
        if ((stats?.withNoPath ?? 0) > 0 || (stats?.withEmptyPath ?? 0) > 0) {
          failures.push(
            `空图标：${set}/${theme} noPath=${stats.withNoPath} emptyPath=${stats.withEmptyPath}`,
          );
        }
        // 6b P1-2：真回退证据 = 形状来源（`data-icon-source`）不等于请求的套
        if ((stats?.withFallback ?? 0) > 0) {
          failures.push(`图标回退：${set}/${theme} ${stats.withFallback} 个（set≠source）`);
        }
        if (!(stats?.sets ?? []).includes(set)) {
          failures.push(`data-icon-set 里没有 ${set}：${(stats?.sets ?? []).join(",")}`);
        }
        if (!(stats?.sources ?? []).includes(set)) {
          failures.push(`图标形状来源里没有 ${set}：${(stats?.sources ?? []).join(",")}`);
        }
        if ((errs ?? []).length) failures.push(`图标格设置失败：${set}/${theme}：${errs[0]}`);
      } else {
        failures.push(`图标量不到：${set}/${theme}：${m?.err ?? "?"}`);
      }
      const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 }).catch(
        () => null,
      );
      if (shot?.data) {
        await writeFile(
          path.join(galleryDir, `icons-${set}-${theme}.jpg`),
          Buffer.from(shot.data, "base64"),
        );
      }
      process.stdout.write(`\r图标逐套 ${set}/${theme}（${iconRows.length}）   `);
    }
  }
  await writeFile(
    path.join(galleryDir, "gallery-icons.json"),
    JSON.stringify(
      {
        note: "round77（3.1b）五套图标：固定 舒适/warm/zh/1500px，亮/暗各一格；hitMin 判红线 = 32",
        rows: iconRows,
      },
      null,
      1,
    ),
  );
  process.stdout.write("\n");
  console.log(`图标逐套：${iconRows.length}/10 格 → ${galleryDir}`);
  await writeFile(
    path.join(galleryDir, "gallery.json"),
    JSON.stringify(
      {
        note: "round76（3.1a）组件展示页：3 密度 × 2 主题 × 3 配色（1500px / zh）逐格量尺寸",
        rows,
      },
      null,
      1,
    ),
  );
  console.log(`组件展示页：${rows.length}/${combos.length} 格量到尺寸 → ${galleryDir}`);
  for (const f of failures.slice(0, 10)) console.log(`  ✗ ${f}`);
  if (failures.length) {
    cleanup();
    process.exit(1);
  }
}

cleanup();
