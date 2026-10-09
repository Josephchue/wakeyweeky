/**
 * round77（3.1b）：本批要给人看的状态截图（`preview.mjs --shots <dir> --shots-file scenes/round77.js`）。
 *
 * 为什么单开一份（不改 `shots.js`）：那份是 round61 多选的演示场景（有状态、顺序有意义），
 * 本批要拍的是**外观状态**（层条开关 / 圆角 / 图标集 / 提示条…），两批互不影响。
 *
 * 场景之间**有状态**（顺序有意义）：先拍默认（层条上色 开），再关掉开关拍第二张。
 */
document.documentElement.dataset.checks = "shots";

const flush = () => new Promise((r) => queueMicrotask(() => queueMicrotask(r)));
const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) await flush();
};

const click = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
};

/** 走真实设置路径：打开设置面板 → 勾/取消「层条上色」 */
const toggleLayerColor = async (on) => {
  if (!document.querySelector(".sanity-pop")) {
    click(".sanity-gear");
    await settle(60);
  }
  const box = document.querySelector(".sanity-pop input.layer-bar-color");
  if (!box) throw new Error("设置面板里没找到 层条上色 开关");
  if (box.checked !== on) box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle(60);
  return box.checked === on;
};

const closeSettings = async () => {
  click(".sanity-pop .close");
  await settle(40);
};

window.__SHOTS = [
  {
    name: "层条-开",
    run: async () => {
      await settle(80);
    },
  },
  {
    name: "层条-关",
    run: async () => {
      const off = await toggleLayerColor(false);
      await closeSettings();
      await settle(80);
      if (!off) throw new Error("层条开关没关掉");
    },
  },
];
