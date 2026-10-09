/**
 * round80（0.28.0）：本批截图场景表
 * `node tools/preview/preview.mjs --no-probe --shots <输出目录> --shots-file scenes/round80.js`
 * 暗色再跑一遍（加 `--theme dark`、输出到另一个目录）。
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
  for (let i = 0; i < 3; i++) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  }
  document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click());
  await settle(30);
  document.activeElement?.blur?.();
};

window.__SHOTS = [
  {
    // 01：79-02 之后的配色选择器 —— 三份迷你界面小样（亮/暗各一份，只显当前主题那份）
    name: "配色小样（设置-主题与颜色）",
    run: async () => {
      await closeAll();
      click(".sanity-gear");
      await settle(160);
      window.__DIAG.push("r80shots 01 小样=" + document.querySelectorAll(".ui-palette .palette .thumb").length);
    },
  },
  {
    // 02：79-02 的模板迷你周视图（浮窗在模板面板左侧）
    name: "模板迷你周视图（浮窗）",
    run: async () => {
      await closeAll();
      click(".templates-open");
      await settle(240);
      window.__DIAG.push("r80shots 02 迷你块=" + document.querySelectorAll("[data-tpl-mini] .blk").length);
    },
  },
  {
    // 03：79-01 的应用内确认面板（焦点在「取消」）
    name: "危险确认面板（应用内 alertdialog）",
    run: async () => {
      await closeAll();
      click(".stats-open");
      await settle(200);
      click(".stats-panel .reset-stats");
      await settle(200);
      window.__DIAG.push(
        "r80shots 03 面板=" +
          !!document.querySelector(".confirm-panel") +
          " 焦点在取消=" +
          (document.activeElement === document.querySelector(".confirm-cancel")),
      );
    },
  },
  {
    // 04：确认面板从**成就面板内部**打开 —— modal 层语义：父面板不被关掉
    name: "确认面板叠在成就面板上（父面板还在）",
    run: async () => {
      await closeAll();
      click(".sanity-gear");
      await settle(140);
      click(".sanity-pop .more-toggle");
      await settle(60);
      click(".sanity-pop .achievements-toggle");
      await settle(60);
      click(".sanity-pop .ach-view");
      await settle(200);
      click(".ach-panel .reset-ach");
      await settle(200);
      window.__DIAG.push(
        "r80shots 04 确认=" +
          !!document.querySelector(".confirm-panel") +
          " 父面板还在=" +
          !!document.querySelector(".ach-panel"),
      );
    },
  },
  {
    // 05：78-04 —— 键盘开关进了「提醒与控制」，同组还有「打开快捷键总表…」链接
    name: "设置-提醒与控制（键盘开关 + 总表链接）",
    run: async () => {
      await closeAll();
      click(".sanity-gear");
      await settle(160);
      click('.sanity-pop .nav-btn[data-group="alert"]');
      await settle(160);
      window.__DIAG.push(
        "r80shots 05 开关=" +
          !!document.querySelector("#settings-group-alert .keyboard-switch") +
          " 链接=" +
          !!document.querySelector("#settings-group-alert .keymap-open"),
      );
    },
  },
  {
    // 06：78-06/07 —— 「更多」六块按推荐序（数据 → 功能开关 → 计划任务 → 理智值 → 成就 → 引导）
    name: "设置-更多（六块推荐序）",
    run: async () => {
      await closeAll();
      click(".sanity-gear");
      await settle(160);
      click('.sanity-pop .nav-btn[data-group="more"]');
      await settle(160);
      const btn = document.querySelector(".sanity-pop .more-toggle");
      if (btn && btn.getAttribute("aria-expanded") !== "true") click(btn);
      await settle(160);
      window.__DIAG.push(
        "r80shots 06 子区=" +
          [...document.querySelectorAll("#settings-group-more .sub-toggle")]
            .map(
              (b) =>
                (b.className.split(/\s+/).find((c) => c.endsWith("-toggle") && c !== "sub-toggle") ?? "").replace(
                  "-toggle",
                  "",
                ),
            )
            .join(","),
      );
    },
  },
];
