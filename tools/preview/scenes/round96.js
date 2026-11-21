// round96（面板栈）· **栈深 1/2/3 + 模板两栏** 的实机截图场景（真前端 + 假数据）。
//
// 用法（仓库根跑；先 `npm run build`）：
//   node tools/preview/preview.mjs --width 1500 --shots docs/visual/round96 --shots-file scenes/round96.js
//
// 每一幕都先清干净面板，再从**真入口**一路点进去；不碰用户真实库（fixture 假后端）。
document.documentElement.dataset.checks = "shots";

const flush = () => new Promise((r) => queueMicrotask(() => queueMicrotask(r)));
const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) await flush();
};
const click = (sel) => {
  const n = document.querySelector(sel);
  if (!n) return false;
  n.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
};

/** 把可能开着的面板都收掉（Esc 一层层退 + 兜底点 ✕）；下一幕从干净状态开始 */
const closeAll = async () => {
  for (let i = 0; i < 6; i++) {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await settle(20);
  }
  for (const sel of [
    ".confirm-panel .confirm-cancel",
    ".ach-panel .close",
    ".help-panel .close",
    ".data-panel .close",
    ".keymap-panel .close",
    ".stats-panel .close",
    ".review-panel .close",
    ".sanity-pop .close",
    ".tpl-pop .close",
  ]) {
    document.querySelector(sel)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  await settle(40);
};

/** 设置 → 更多 → 成就 展开（但不点「成就」） */
const openSettingsMore = async () => {
  click(".sanity-gear");
  await settle(40);
  click(".sanity-pop .more-toggle");
  await settle(30);
  click(".sanity-pop .achievements-toggle");
  await settle(30);
};

window.__SHOTS = [
  {
    name: "栈深1-设置",
    run: async () => {
      await closeAll();
      click(".sanity-gear");
      await settle(80);
      window.__DIAG.push("r96shots 01 深=" + (document.querySelector("[data-stack-depth]")?.dataset.stackDepth ?? "-"));
    },
  },
  {
    name: "栈深2-设置+成就",
    run: async () => {
      await closeAll();
      await openSettingsMore();
      click(".sanity-pop .ach-view");
      await settle(100);
      window.__DIAG.push("r96shots 02 深=" + (document.querySelector("[data-stack-depth]")?.dataset.stackDepth ?? "-"));
    },
  },
  {
    name: "栈深3-设置+成就+确认",
    run: async () => {
      await closeAll();
      await openSettingsMore();
      click(".sanity-pop .ach-view");
      await settle(80);
      click(".ach-panel .reset-ach");
      await settle(100);
      window.__DIAG.push(
        "r96shots 03 深=" + (document.querySelector("[data-stack-depth]")?.dataset.stackDepth ?? "-") +
          " 确认=" + !!document.querySelector(".confirm-panel"),
      );
    },
  },
  {
    name: "模板两栏",
    run: async () => {
      await closeAll();
      // 等上一幕的成就短提示自己过期（5s），别把无关的 toast 带进模板图
      await new Promise((r) => setTimeout(r, 5200));
      click(".templates-open");
      await settle(280);
      window.__DIAG.push(
        "r96shots 04 宽=" +
          Math.round(document.querySelector(".tpl-pop")?.getBoundingClientRect().width ?? 0) +
          " 预览在面板内=" +
          !!document.querySelector(".tpl-pop [data-tpl-preview]"),
      );
    },
  },
];
