// round86（0.32.0）· **9 套装饰 + 3 套老配色的实机截图场景**（手写；走的都是真前端 + 真设置路径）。
//
// 用法（仓库根跑；先 `npm run build`）：
//   node tools/preview/preview.mjs --theme light --shots docs/visual/round86 --shots-file scenes/round86.js
//   node tools/preview/preview.mjs --theme dark  --shots docs/visual/round86/暗色 --shots-file scenes/round86.js
//
// 每一幕：打开设置 → 点配色小样 → 关面板 → 截图（与用户手里的操作同一条路）。
// 老 3 套也拍（= 「零变化」的人眼对照）。
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

const OLD = ["warm", "cool", "sage"];
const NEW = ["endfield", "terminal", "deepsea", "bauhaus", "artdeco", "cassette", "north", "brutal", "porcelain"];

window.__SHOTS = [
  {
    name: "00-设置面板-12套配色选择器",
    run: async () => {
      await closeAll();
      const pop = await openSettings();
      pop?.querySelector(".ui-palette")?.scrollIntoView({ block: "nearest" });
      await settle(80);
    },
  },
  // 9 套新配色的装饰逐套对照（亮 / 暗各一排）
  ...NEW.map((id, i) => ({
    name: `${String(i + 1).padStart(2, "0")}-${id}-主界面`,
    run: async () => {
      await closeAll();
      const ok = await setPalette(id);
      if (!ok) window.__DIAG?.push?.(`round86 截图：${id} 没切上（data-palette=${document.documentElement.dataset.palette}）`);
      await settle(60);
    },
  })),
  // 装饰碰面板 / 面板标题的几套：再拍一张设置面板（把**选中的那张小样**滚进视野，才看得出是哪套）
  ...NEW.map((id, i) => ({
    name: `${String(i + 10).padStart(2, "0")}-${id}-设置面板`,
    run: async () => {
      await closeAll();
      await setPalette(id);
      const pop = await openSettings();
      pop?.querySelector(`.ui-palette .palette[data-value="${id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      await settle(60);
    },
  })),
  // 老 3 套（零变化的人眼对照）
  ...OLD.map((id, i) => ({
    name: `${String(i + 19).padStart(2, "0")}-${id}-主界面`,
    run: async () => {
      await closeAll();
      await setPalette(id);
      await settle(60);
    },
  })),
];
