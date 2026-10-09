// round85（0.31.0）· **12 套内置配色的实机截图场景**（手写；12 套已是真的内置配色，不再注入令牌）。
//
// 用法（仓库根跑；先 `npm run build`）：
//   node tools/preview/preview.mjs --theme light --shots docs/visual/round85 --shots-file scenes/round85.js
//   node tools/preview/preview.mjs --theme dark  --shots docs/visual/round85/暗色 --shots-file scenes/round85.js
//
// 每一幕走**真前端 + 真设置路径**（打开设置 → 点配色小样 → 关面板 → 截图），与用户手里的操作同一条路。
document.documentElement.dataset.checks = "shots";

const flush = () => new Promise((r) => queueMicrotask(() => queueMicrotask(r)));
const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) await flush();
};
const key = async (k) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  await settle(20);
};
const clickSel = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
};
/** 关掉所有浮层（设置 / 总览 / 复盘都不留） */
const closeAll = async () => {
  for (let i = 0; i < 3; i++) key("Escape");
  document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click());
  await settle(30);
  document.activeElement?.blur?.();
};
const openSettings = async () => {
  if (!document.querySelector(".sanity-pop")) {
    clickSel(".sanity-gear");
    await settle(50);
  }
  return document.querySelector(".sanity-pop");
};
/** 选一套配色（真路径：设置面板里的横滚小样 → 点它 → 关掉面板） */
const setPalette = async (id) => {
  const pop = await openSettings();
  if (!pop) return false;
  const card = pop.querySelector(`.ui-palette .palette[data-value="${id}"]`);
  card?.scrollIntoView({ block: "nearest", inline: "nearest" });
  await settle(10);
  card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle(140);
  pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle(60);
  return document.documentElement.dataset.palette === id;
};

const PALETTES = [
  "warm", "cool", "sage", "endfield", "terminal", "deepsea", "bauhaus", "artdeco",
  "cassette", "north", "brutal", "porcelain",
];

window.__SHOTS = [
  {
    // 证据图：12 套选择器（横向一排 + 横滚）在设置里的样子
    name: "00-设置面板-12套配色选择器",
    run: async () => {
      await closeAll();
      const pop = await openSettings();
      const wrap = pop?.querySelector(".ui-palette");
      wrap?.scrollIntoView({ block: "nearest" });
      await settle(80);
    },
  },
  ...PALETTES.map((id, i) => ({
    name: `${String(i + 1).padStart(2, "0")}-${id}-主界面`,
    run: async () => {
      await closeAll();
      const ok = await setPalette(id);
      if (!ok) window.__DIAG?.push?.(`round85 截图：${id} 没切上（data-palette=${document.documentElement.dataset.palette}）`);
      await settle(60);
    },
  })),
];
