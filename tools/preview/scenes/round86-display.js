// round86（0.32.0）· **展示字候选样张**（⑤）：北境极夜 / 深海冷光 × 三档（倍率 + 字距）× 亮暗。
//
// 用法（仓库根跑；先 `npm run build`）：
//   node tools/preview/preview.mjs --theme light --shots docs/visual/round86/展示字 --shots-file scenes/round86-display.js
//   node tools/preview/preview.mjs --theme dark  --shots docs/visual/round86/展示字/暗色 --shots-file scenes/round86-display.js
//
// 口径（你 2026-10-08 的批注）：**只放大「受特殊字体影响的那几个字」** ——
//   Backlog 顶栏只放 `BACKLOG` 字样本身（不连「全部 / 田分组 / «」几个按钮）、日头只放日头、面板只放标题。
// 候选值用**行内令牌**注入（`--display-scale` / `--display-tracking` 设在 `:root` 上，不动产品代码）。
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
const setPalette = async (id) => {
  const pop = await openSettings();
  const card = pop?.querySelector(`.ui-palette .palette[data-value="${id}"]`);
  card?.scrollIntoView({ block: "nearest", inline: "nearest" });
  await settle(10);
  card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle(140);
  pop?.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle(60);
};

/** 三档候选（B = 本批出厂值 = §5-DV 建议区间的中档） */
const CANDS = [
  { key: "A", scale: "1.06", tracking: "0.04em" },
  { key: "B", scale: "1.08", tracking: "0.06em" },
  { key: "C", scale: "1.10", tracking: "0.08em" },
];
const PALETTES = ["north", "deepsea"];

window.__SHOTS = [
  ...PALETTES.flatMap((id) =>
    CANDS.map((c) => ({
      name: `${id}-${c.key}-scale${c.scale}-track${c.tracking.replace("em", "")}`,
      run: async () => {
        await closeAll();
        await setPalette(id);
        document.documentElement.style.setProperty("--display-scale", c.scale);
        document.documentElement.style.setProperty("--display-tracking", c.tracking);
        // 只放大那几个字（3×）：Backlog 的 BACKLOG 字样 + 第一列日头
        const t = document.querySelector(".backlog .title");
        if (t) t.style.zoom = "3";
        const d = document.querySelector(".day-head");
        if (d) d.style.zoom = "3";
        await settle(40);
      },
    })),
  ),
  // 面板标题（推荐值 B）：设置面板本身的字号 + 字距
  ...PALETTES.map((id) => ({
    name: `${id}-B-面板标题`,
    run: async () => {
      await closeAll();
      await setPalette(id);
      const pop = await openSettings();
      const b = document.querySelector(".backlog .title");
      if (b) b.style.zoom = "3";
      const t = pop?.querySelector(".pop-title");
      if (t) t.style.zoom = "3";
      await settle(40);
    },
  })),
];
