// E1 布局实验 · 截图场景（真前端 + 假数据）
//
// 用法（仓库根；先 npm run build）：
//   node tools/preview/preview.mjs --width 1500 --shots docs/visual/E1 --shots-file scenes/e1.js
//   node tools/preview/preview.mjs --width 715  --shots docs/visual/E1/715 --shots-file scenes/e1.js
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
const closeAll = async () => {
  for (let i = 0; i < 6; i++) {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(20);
  }
  for (const sel of [".sanity-pop .close", ".review-panel .close", ".stats-panel .close", ".overlay-backdrop"]) {
    click(sel);
  }
  await settle(40);
};
const openSettings = async () => {
  click(".sanity-gear");
  await settle(60);
};
const closePanel = async () => {
  click(".overlay-backdrop");
  await settle(60);
};
const setPreset = async (id) => {
  click(`.preset-btn[data-preset="${id}"]`);
  await settle(30);
};
const dragBacklog = async (x, y) => {
  const grip = document.querySelector(".backlog .dock-grip");
  if (!grip) return false;
  const r = grip.getBoundingClientRect();
  const px = r.left + r.width / 2;
  const py = r.top + r.height / 2;
  grip.dispatchEvent(ptrEvent("pointerdown", px, py));
  await settle(4);
  firePointer("pointermove", x, y);
  await settle(4);
  firePointer("pointerup", x, y);
  await settle(40);
  return true;
};
const setTopMode = async (mode) => {
  await openSettings();
  click(".sanity-pop .more-toggle");
  await settle(40);
  const sel = document.querySelector(".sanity-pop .backlog-top-mode");
  if (sel) {
    sel.value = mode;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(40);
  }
  await closePanel();
};
const setAutoHide = async (on) => {
  await openSettings();
  const box = document.querySelector(".sanity-pop .backlog-auto-hide");
  if (box && box.checked !== on) {
    box.click();
    await settle(40);
  }
  await closePanel();
};

window.__SHOTS = [
  {
    name: "01-默认",
    run: async () => {
      await closeAll();
      await setPreset("default");
      await setAutoHide(false);
      await dragBacklog(4, Math.round(window.innerHeight / 2));
      await setTopMode("chips");
      await settle(30);
      window.__DIAG.push("e1shots 01 边=" + (document.querySelector("main.shell")?.dataset.backlogEdge ?? "-"));
    },
  },
  {
    name: "02-预设都靠右",
    run: async () => {
      await closeAll();
      await setPreset("right");
      await settle(30);
      window.__DIAG.push("e1shots 02 预设=" + (document.querySelector(".timeline")?.dataset.headerPreset ?? "-"));
    },
  },
  {
    name: "03-吸顶-chips",
    run: async () => {
      await closeAll();
      await setPreset("default");
      await setTopMode("chips");
      await dragBacklog(Math.round(window.innerWidth / 2), 4);
      await settle(60);
      window.__DIAG.push(
        "e1shots 03 边=" + (document.querySelector("main.shell")?.dataset.backlogEdge ?? "-") +
          " chip=" + document.querySelectorAll(".backlog .chip").length,
      );
    },
  },
  {
    name: "04-吸顶-panel",
    run: async () => {
      await closeAll();
      await setTopMode("panel");
      await settle(50);
      window.__DIAG.push(
        "e1shots 04 列表=" + document.querySelectorAll(".backlog .item").length +
          " 两列=" + (getComputedStyle(document.querySelector(".backlog .list") ?? document.body).display === "grid"),
      );
    },
  },
  {
    name: "05-自动收起",
    run: async () => {
      await closeAll();
      await setTopMode("chips");
      await setAutoHide(true);
      firePointer("pointermove", Math.round(window.innerWidth * 0.6), Math.round(window.innerHeight * 0.5));
      await settle(20);
      await new Promise((r) => setTimeout(r, 6400));
      await settle(20);
      window.__DIAG.push("e1shots 05 细轨=" + !!document.querySelector(".backlog.rail"));
      await setAutoHide(false);
      await settle(20);
    },
  },
];
