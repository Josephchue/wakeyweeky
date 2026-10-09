/**
 * round79（0.27.0）：本批的**截图场景表**
 * （`node tools/preview/preview.mjs --shots docs/visual/round79 --shots-file scenes/round79.js`）。
 *
 * 每幕只摆一个状态；失败态用本批新加的**常驻注入开关**（`__FAIL_MOSAIC` / `__FAIL_DATA_INFO`，
 * 场景自己关）。图直接进验收文档「本批吃掉的调研结论 / 证据」一节。
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
/** 面板都关掉，露一个干净的主界面 */
const closeAll = async () => {
  for (let i = 0; i < 3; i++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click());
  await settle(30);
  document.activeElement?.blur?.();
};

window.__SHOTS = [
  {
    // 01：总览的失败态（本批 78-08 补的机器证据 —— 以前只有手测）
    name: "01-总览-失败态与重试",
    run: async () => {
      try {
        await closeAll();
        window.__FAIL_MOSAIC = true;
        click(".review-open");
        await settle(120);
        const retry = document.querySelector(".review-panel .retry");
        window.__DIAG.push("r79shots 01 重试钮=" + (!!retry) + " 文案=" + (retry?.textContent ?? "").trim());
        await settle(30);
      } finally {
        // round79（6b 二轮 P2）：常驻注入开关要**在 finally 里关** —— 中间任何一步抛错，
        // 否则下一幕会继续演「失败态」（`preview.mjs` 捕获错误后仍会往下拍）。
        window.__FAIL_MOSAIC = false;
      }
    },
  },
  {
    // 02：数据位置的失败态（同上）
    name: "02-数据位置-失败态与重试",
    run: async () => {
      try {
      await closeAll();
      window.__FAIL_DATA_INFO = true;
      document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(40);
      document.querySelector(".sanity-pop .more-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(20);
      document.querySelector(".sanity-pop .data-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(20);
      click(".sanity-pop .portable-open");
      await settle(120);
      const retry = document.querySelector(".switch-panel .retry");
      window.__DIAG.push("r79shots 02 重试钮=" + (!!retry) + " 文案=" + (retry?.textContent ?? "").trim());
      await settle(30);
      } finally {
        window.__FAIL_DATA_INFO = false; // round79（6b 二轮 P2）：同上，异常也要关
      }
    },
  },
  {
    // 03：重置统计（本批 78-10）—— 按钮就长在统计页 footer 上
    name: "03-统计-重置按钮",
    run: async () => {
      await closeAll();
      click(".stats-open");
      await settle(120);
      const btn = document.querySelector(".stats-panel .reset-stats");
      btn?.scrollIntoView({ block: "center" });
      await settle(30);
      window.__DIAG.push("r79shots 03 重置统计钮=" + (!!btn) + " 文案=" + (btn?.textContent ?? "").trim());
      await settle(30);
    },
  },
  {
    // 04：重置成就（本批 78-11）—— 成就页 footer
    name: "04-成就-重置按钮",
    run: async () => {
      await closeAll();
      await settle(20);
      document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(40);
      document.querySelector(".sanity-pop .more-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(20);
      document.querySelector(".sanity-pop .achievements-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(20);
      click(".sanity-pop .ach-view");
      await settle(140);
      const btn = document.querySelector(".ach-panel .reset-ach");
      btn?.scrollIntoView({ block: "center" });
      await settle(30);
      window.__DIAG.push("r79shots 04 重置成就钮=" + (!!btn) + " 文案=" + (btn?.textContent ?? "").trim());
      await settle(30);
    },
  },
  {
    // 05：恢复默认设置（本批 78-01）—— 设置「更多 → 数据」区尾
    name: "05-设置-恢复默认设置",
    run: async () => {
      await closeAll();
      await settle(20);
      document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(40);
      document.querySelector(".sanity-pop .more-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(20);
      document.querySelector(".sanity-pop .data-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(20);
      const btn = document.querySelector(".sanity-pop .reset-settings");
      btn?.scrollIntoView({ block: "center" });
      await settle(30);
      window.__DIAG.push("r79shots 05 恢复默认钮=" + (!!btn) + " 文案=" + (btn?.textContent ?? "").trim());
      await settle(30);
    },
  },
  {
    // 06：设置导航的「每组都能顶到头」（本批 78-05）—— 点「提醒与控制」后的样子
    name: "06-设置-导航顶到头",
    run: async () => {
      await closeAll();
      await settle(20);
      document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(40);
      document.querySelector('.sanity-pop .nav-btn[data-group="alert"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(90);
      const g = document.getElementById("settings-group-alert");
      const b = document.querySelector(".sanity-pop .pop-body");
      const off = g && b ? Math.round(g.getBoundingClientRect().top - b.getBoundingClientRect().top) : null;
      window.__DIAG.push("r79shots 06 提醒与控制 顶到头=" + off + "px（期望 0…8）");
      await settle(30);
    },
  },
];
