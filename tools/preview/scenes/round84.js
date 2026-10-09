/**
 * round84（0.31.0）：Step 1 三条小修的截图场景（用户报的）。
 *
 *   node tools/preview/preview.mjs --width 1500 --shots docs/visual/round84 --shots-file scenes/round84.js
 *   node tools/preview/preview.mjs --width 1500 --theme dark --shots docs/visual/round84/暗色 --shots-file scenes/round84.js
 *
 * 01 提醒与控制：行标签成句（「块开始时提醒我」）+「提前 [0 分钟]」（旧文案「到点」）
 * 02 更多 → 精力区：用户可见文案「理智」→「精力」（旧文案「理智值」）
 * （暗色下拉弹层的「真机」复验由你手测 —— 原生弹层截图抓不到，机器侧由 round84 ① 的 option 计算样式覆盖）
 */
document.documentElement.dataset.checks = "shots";

const flush = () => new Promise((r) => queueMicrotask(() => queueMicrotask(r)));
const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) await flush();
};
const click = (sel) => {
  const n = typeof sel === "string" ? document.querySelector(sel) : sel;
  if (!n) return false;
  n.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
};
const key = (k, extra = {}) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
const closeAll = async () => {
  for (let i = 0; i < 3; i++) key("Escape");
  document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click());
  await settle(30);
  document.activeElement?.blur?.();
};
const openSettings = async () => {
  if (!document.querySelector(".sanity-pop")) {
    click(".sanity-gear");
    await settle(60);
  }
};

window.__SHOTS = [
  {
    // 01：提醒与控制 —— 行标签 + 「提前 [0 分钟]」（旧：块开始时提醒 / 到点）
    name: "01-提醒行与提前0分钟",
    run: async () => {
      await closeAll();
      await openSettings();
      document
        .querySelector('.sanity-pop .pop-nav .nav-btn[data-group="alert"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(80);
      const alert = document.querySelector(".sanity-pop #settings-group-alert");
      const lead = alert?.querySelector(".lead");
      const opts = lead ? [...lead.querySelectorAll("option")].map((o) => (o.textContent ?? "").trim()) : [];
      window.__DIAG.push(
        `r84shots① 提醒组：${(alert?.textContent ?? "").replace(/\s+/g, " ").slice(0, 90)} ｜ 档位=[${opts.join("|")}]`,
      );
    },
  },
  {
    // 02：更多 → 精力区 —— 用户可见文案「精力」（旧：理智）
    name: "02-精力区文案",
    run: async () => {
      await closeAll();
      await openSettings();
      const more = document.querySelector(".sanity-pop .more-toggle");
      if (more && more.getAttribute("aria-expanded") !== "true") {
        click(more);
        await settle(20);
      }
      const sanity = document.querySelector(".sanity-pop .sanity-toggle");
      if (sanity && sanity.getAttribute("aria-expanded") !== "true") {
        click(sanity);
        await settle(60);
      }
      document.querySelector(".sanity-pop .sanity-toggle")?.scrollIntoView({ block: "center" });
      await settle(40);
      const pop = document.querySelector(".sanity-pop");
      const text = (pop?.textContent ?? "").replace(/\s+/g, " ");
      window.__DIAG.push(`r84shots② 精力区：${text.slice(0, 140)} ｜ 含理智=${text.includes("理智")}`);
    },
  },
];
