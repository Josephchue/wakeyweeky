// E1 修复批 · 截图场景（真前端 + 假数据）
//
// 用法（仓库根；先 npm run build）：
//   node tools/preview/preview.mjs --width 1500 --shots docs/visual/E1F --shots-file scenes/e1f.js
//   node tools/preview/preview.mjs --width 1024 --shots docs/visual/E1F/1024 --shots-file scenes/e1f.js
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
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(10);
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
/** E1F：预设只在设置里（镜像） */
const setPreset = async (id) => {
  await openSettings();
  const sel = document.querySelector(".sanity-pop .preset-mirror");
  if (sel) {
    sel.value = id;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(40);
  }
  await closePanel();
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

window.__SHOTS = [
  {
    name: "01-头部四组",
    run: async () => {
      await closeAll();
      await setPreset("default");
      await dragBacklog(4, Math.round(window.innerHeight / 2));
      await setTopMode("chips");
      document.activeElement?.blur?.();
      await settle(30);
      window.__DIAG.push(
        "e1f 01 组=" + [...document.querySelectorAll(".head-group")].map((g) => g.dataset.group).join(","),
      );
    },
  },
  {
    name: "02-六点显形",
    run: async () => {
      await closeAll();
      document.querySelector('.head-group[data-group="views"] .group-grip')?.focus();
      await settle(20);
      window.__DIAG.push(
        "e1f 02 手柄透明度=" + getComputedStyle(document.querySelector('.head-group[data-group="views"] .group-grip')).opacity,
      );
    },
  },
  {
    name: "03-跳周面板",
    run: async () => {
      await closeAll();
      document.activeElement?.blur?.();
      click(".week-nav .date-btn");
      await settle(40);
      window.__DIAG.push("e1f 03 面板=" + !!document.querySelector(".week-pop"));
    },
  },
  {
    name: "04-吸顶一行",
    run: async () => {
      await closeAll();
      await dragBacklog(Math.round(window.innerWidth / 2), 4);
      await setTopMode("chips");
      await settle(60);
      window.__DIAG.push(
        "e1f 04 边=" + (document.querySelector("main.shell")?.dataset.backlogEdge ?? "-") +
          " chips=" + document.querySelectorAll(".backlog .chip").length,
      );
    },
  },
  {
    name: "05-任务设置浮层",
    run: async () => {
      await closeAll();
      await setTopMode("panel");
      await settle(40);
      const row = document.querySelector(".backlog.horizontal .list .item");
      row?.querySelector(".props-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(60);
      const rr = (sel) => { const n = document.querySelector(sel); if (!n) return "-"; const r = n.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom), Math.round(r.height)].join(":"); };
      window.__DIAG.push("e1f 05 浮层=" + !!document.querySelector(".props-pop") + " 面板=" + rr(".backlog") + " 头=" + rr(".backlog .head") + " 输入=" + rr(".backlog .new-task") + " 列表=" + rr(".backlog .list") + " 归档=" + rr(".backlog .archived"));
    },
  },
  {
    name: "06-归档浮层",
    run: async () => {
      await closeAll();
      document.querySelector(".backlog .arch-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(60);
      window.__DIAG.push("e1f 06 归档浮层=" + !!document.querySelector(".arch-pop"));
    },
  },
  {
    name: "07-四组六点位置",
    run: async () => {
      await closeAll();
      await setPreset("default");
      await dragBacklog(4, Math.round(window.innerHeight / 2));
      document.querySelectorAll(".group-grip").forEach((g) => {
        g.style.opacity = "1";
      });
      await settle(30);
      window.__DIAG.push("e1f 07 六点=" + document.querySelectorAll(".group-grip").length);
    },
  },
];
