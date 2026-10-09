// round82（Step 5 · `盘-09`）：**真机托盘截图** —— 便携模式起真应用（数据落 %TEMP%，绝不碰真库），
// 用**播种数据库**的方式把托盘切到四个状态，每次只裁屏幕右下角的通知区（不把桌面隐私带出来）。
//
// 为什么不是 CDP 调 `set_tray_state`：真应用的 IPC 会校验 `Origin`（CDP 注入的调用被判 `Origin header
// is not a valid URL`）→ 改走「应用自己的状态来源」：`notify::scan_once` 启动即跑一轮
// （`refresh_baseline` 从库里算 有任务 / 超载；到点提醒则把托盘切到闪烁态）。
//
// ⚠️ **Windows 11 会把新托盘图标放进「溢出区」**（^ 里）—— 直接截任务栏只看到通知区那条，
//    看不到我们的图标。要拿到图标本体的真机截图，先让用户把它**固定出来**：
//    设置 → 个性化 → 任务栏 → 其他系统托盘图标 → 把 WakeyWeeky 打开为「始终显示」，
//    然后重跑本工具（脚本截的是同一条通知区）。脚本的 DIAG 会打印屏幕尺寸与缩放比例
//    （本机 1920×1080 物理 / 1536×864 逻辑 = **125%**，托盘图标按系统缩到 20px）。
//
// 用法：node tools/visual/round82-tray-live.mjs [exe 路径] [输出目录]
//   默认 exe = src-tauri/target/debug/wakeyweeky.exe（先 `cargo build`）
//   默认输出 = docs/visual/round82/托盘-真机/
// 产物：default.png / has_current_task.png / high_priority_reminder.png / sanity_overload.png
//   + 打印 SystemUsesLightTheme / 屏幕 / DPI（LogPixels）—— 进验收文档的「诚实清单」。
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXE_SRC = process.argv[2] ?? path.join(repoRoot, "src-tauri/target/debug/wakeyweeky.exe");
const OUT_DIR = process.argv[3] ?? path.join(repoRoot, "docs/visual/round82/托盘-真机");
if (!existsSync(EXE_SRC)) {
  console.error(`没有 exe：${EXE_SRC}（先 cargo build）`);
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

// 每次跑用一个**新**临时目录：不删旧的（%TEMP% 里那几个目录可手动清）—— 实测对整个目录 `rmSync`
// 会 EPERM（前一个刚被杀掉的进程还占着 exe / db 句柄），而「只删自己建的明确文件」又清不干净。
const DIR = path.join(os.tmpdir(), `ww-tray-live-${Date.now()}`);
const EXE = path.join(DIR, "wakeyweeky.exe");
const DB = path.join(DIR, "data", "wakeyweeky.sqlite"); // 真文件名（`portable::db_path`）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 备好便携目录（exe 副本 + `portable.flag`） */
function clean() {
  mkdirSync(DIR, { recursive: true });
  copyFileSync(EXE_SRC, EXE);
  writeFileSync(path.join(DIR, "portable.flag"), "");
}

async function launch() {
  const app = spawn(EXE, [], { cwd: DIR, stdio: ["ignore", "ignore", "ignore"] });
  // 等数据库落地（首启建库 + 迁移）
  for (let i = 0; i < 60 && !existsSync(DB); i++) await sleep(250);
  return app;
}
async function quit(app) {
  app.kill();
  await sleep(1200);
}
function kill() {
  try {
    execFileSync("taskkill", ["/IM", "wakeyweeky.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* 没在跑 */
  }
}

/** 往库里塞一个任务 + 若干净块（时间戳给 Unix 秒） */
function seedBlocks(spans) {
  const db = new DatabaseSync(DB);
  const now = Math.floor(Date.now() / 1000);
  db.exec(
    `INSERT OR REPLACE INTO tasks (id, title, category, created_at, is_elastic, estimated_minutes, archived_at, sanity_exempt, sort_order)
     VALUES ('tray-task', '真机托盘靶子', NULL, ${now}, 0, NULL, NULL, 0, 0);`,
  );
  let i = 0;
  for (const [from, to] of spans) {
    db.exec(
      `INSERT OR REPLACE INTO blocks (id, task_id, start_at, end_at, status, last_notified_at, created_at, layer, external_source, final_status, postponed_from, label, sanity_exempt)
       VALUES ('tray-b${i++}', 'tray-task', ${Math.round(from)}, ${Math.round(to)}, 'planned', NULL, ${now}, 'required', NULL, NULL, NULL, NULL, 0);`,
    );
  }
  db.close();
}

/** 只截主屏右下角那一小块（通知区）；桌面其它内容一概不入镜 */
const CROP_W = Number(process.env.WW_TRAY_CROP_W ?? 460);
const CROP_H = Number(process.env.WW_TRAY_CROP_H ?? 60);
function shot(file) {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class WWDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[WWDpi]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$w = [Math]::Min(${CROP_W}, $b.Width); $h = [Math]::Min(${CROP_H}, $b.Height)
$x = $b.X + $b.Width - $w; $y = $b.Y + $b.Height - $h
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$bmp.Save('${file.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "$w x $h"
`.trim();
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" }).trim();
}

const ps = (cmd) => execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8" }).trim();
const info = {
  screen: ps("Add-Type -AssemblyName System.Windows.Forms; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class WWDpi2 { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'; [WWDpi2]::SetProcessDPIAware() | Out-Null; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output \"$($b.Width)x$($b.Height)\""),
  systemUsesLightTheme: ps("(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -Name SystemUsesLightTheme -ErrorAction SilentlyContinue).SystemUsesLightTheme"),
  logPixels: ps("(Get-ItemProperty 'HKCU:\\Control Panel\\Desktop' -Name LogPixels -ErrorAction SilentlyContinue).LogPixels"),
};
console.log(
  `屏幕 = ${info.screen} · SystemUsesLightTheme = ${info.systemUsesLightTheme || "(空)"} · LogPixels = ${info.logPixels || "(未设置 = 100%)"}`,
);

const now = Math.floor(Date.now() / 1000);
const H = 3600;
/** 四个状态各自需要的库状态（默认预算 6h / `sanity_enabled` 默认开） */
const SCENES = [
  { name: "default", spans: [] },
  { name: "has_current_task", spans: [[now - 10 * 60, now + 50 * 60]] },
  { name: "sanity_overload", spans: [[now - 3 * H, now + 4 * H]] },
  // 提醒态：块**刚好开始**（`remind_start` 默认开）→ 启动那一轮 scan 就弹提醒 → 托盘闪烁
  { name: "high_priority_reminder", spans: [[now - 60, now + 30 * 60]], waitMs: 6000, blink: true },
];

kill();
for (const scene of SCENES) {
  clean();
  let app = await launch();
  try {
    seedBlocks(scene.spans);
  } catch (e) {
    console.error(`播种失败（${scene.name}）：${e}`);
  }
  await quit(app);
  app = await launch();
  await sleep(scene.waitMs ?? 5000);
  if (scene.blink) {
    // 闪烁：连拍 4 张，留**最大**的那张（灭帧是全透明、PNG 最小）
    let best = null;
    let bestSize = -1;
    for (let i = 0; i < 4; i++) {
      const f = path.join(OUT_DIR, `${scene.name}.png`);
      shot(f);
      const s = statSync(f).size;
      if (s > bestSize) {
        bestSize = s;
        best = f;
      }
      await sleep(260);
    }
    console.log(`✓ ${scene.name} → ${path.basename(best ?? "")}（闪烁连拍里最大的一张 ${bestSize} 字节）`);
  } else {
    const size = shot(path.join(OUT_DIR, `${scene.name}.png`));
    console.log(`✓ ${scene.name} → ${path.join(OUT_DIR, `${scene.name}.png`)}（裁剪 ${size}）`);
  }
  await quit(app);
}
kill();
console.log("产物：", OUT_DIR, "（", readdirSync(OUT_DIR).join(", "), "）");
console.log("便携目录留在", DIR, "（可手动删）");
