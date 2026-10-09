// round86（0.32.0）· **窄窗配色选择器的渐隐边**（④）证据：起点 / 中间 / 最右三张。
//
// 用法（仓库根跑；先 `npm run build`）：
//   node tools/preview/preview.mjs --width 715 --theme light --shots docs/visual/round86/窄窗 --shots-file scenes/round86-narrow.js
document.documentElement.dataset.checks = "shots";

const flush = () => new Promise((r) => queueMicrotask(() => queueMicrotask(r)));
const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) await flush();
};
const key = async (k) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  await settle(20);
};
const closeAll = async () => {
  for (let i = 0; i < 3; i++) key("Escape");
  for (const b of document.querySelectorAll(".overlay-backdrop")) b.click();
  await settle(30);
  document.activeElement?.blur?.();
};
const openSettings = async () => {
  if (!document.querySelector(".sanity-pop")) {
    document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(50);
  }
  return document.querySelector(".sanity-pop");
};

const shot = (name, frac) => ({
  name,
  run: async () => {
    await closeAll();
    const pop = await openSettings();
    const wrap = pop?.querySelector(".ui-palette");
    if (!wrap) return;
    const max = wrap.scrollWidth - wrap.clientWidth;
    wrap.scrollLeft = Math.round(max * frac);
    wrap.scrollIntoView({ block: "nearest" });
    await settle(40);
  },
});

window.__SHOTS = [shot("起点-左端不该淡", 0), shot("中间-两端都淡", 0.5), shot("最右-右端不该淡", 1)];
