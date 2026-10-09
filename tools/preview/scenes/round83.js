/**
 * round83（0.30.1）：本批截图场景表（Step 1a 三条小修的取证）。
 *
 *   node tools/preview/preview.mjs --width 1500 --shots docs/visual/round83 --shots-file scenes/round83.js
 *   node tools/preview/preview.mjs --width 1500 --theme dark --shots docs/visual/round83/暗色 --shots-file scenes/round83.js
 *
 * 第 1 幕～第 4 幕 = **统计入口四象限**（验收 §8.1 修的那条）：
 *   01 总览开 + 统计开 → 面板没开时顶栏**没有**独立按钮（这次修的另一半）；总览开着 → 入口在面板里
 *   02 总览关 + 统计开 → 顶栏独立按钮回来
 *   03 `S` 从关起 → 先开总览 + 统计子层（Q4 拍的新语义）
 *   04 独立统计面板（总览关时点顶栏那个入口）
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

/** 功能开关：走设置弹层的真控件（与预览断言同一套路径） */
const setFeature = async (label, on) => {
  if (!document.querySelector(".sanity-pop")) {
    click(".sanity-gear");
    await settle(40);
  }
  const more = document.querySelector(".sanity-pop .more-toggle");
  if (more && more.getAttribute("aria-expanded") !== "true") {
    click(more);
    await settle(15);
  }
  const feat = document.querySelector(".sanity-pop .features-toggle");
  if (feat && feat.getAttribute("aria-expanded") !== "true") {
    click(feat);
    await settle(15);
  }
  const row = [...document.querySelectorAll(".sanity-pop .feature-row")].find((r) =>
    (r.textContent ?? "").includes(label),
  );
  const box = row?.querySelector("input");
  if (box && box.checked !== on) {
    box.click();
    await settle(80);
  }
  document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle(40);
  return !!box;
};

/** 机器取证：四象限的四条读数进 __DIAG（截图之外的证据） */
const state = (tag) => {
  const bar = !!document.querySelector(".head-actions .stats-open");
  const inReview = !!document.querySelector(".review-panel .stats-open");
  const review = !!document.querySelector(".review-panel");
  const stats = !!document.querySelector(".stats-panel");
  window.__DIAG.push(`r83shots ${tag} 顶栏独立=${bar} 总览内=${inReview} 总览开=${review} 统计开=${stats}`);
};

/** 打开设置弹层的「提醒与控制」组（键位入口所在组 —— 这版设置是**导航滚到该组**，不是折叠） */
const openAlertGroup = async () => {
  if (!document.querySelector(".sanity-pop")) {
    click(".sanity-gear");
    await settle(40);
  }
  document
    .querySelector('.sanity-pop .pop-nav .nav-btn[data-group="alert"]')
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle(60);
};

window.__SHOTS = [
  {
    // 01：总览开 + 统计开 —— 顶栏没有独立按钮；入口在总览面板里（点开是子层）
    name: "01-统计入口-总览面板内",
    run: async () => {
      await closeAll();
      await setFeature("一周总览", true);
      await setFeature("数据统计", true);
      click(".review-open");
      await settle(240);
      state("01");
    },
  },
  {
    // 02：总览关 + 统计开 —— 顶栏独立按钮回来（这是唯一该出现的形态）
    name: "02-统计入口-顶栏独立",
    run: async () => {
      await closeAll();
      await setFeature("一周总览", false);
      await setFeature("数据统计", true);
      await settle(80);
      state("02");
    },
  },
  {
    // 03：`S` 从关起 —— 先开总览 + 统计子层（Q4 新语义）
    name: "03-S键-总览加统计子层",
    run: async () => {
      await closeAll();
      await setFeature("一周总览", true);
      await setFeature("数据统计", true);
      key("s");
      await settle(240);
      state("03");
    },
  },
  {
    // 04：独立统计面板（总览关）—— 收尾把两个开关还原成默认全开
    name: "04-独立统计面板",
    run: async () => {
      await closeAll();
      await setFeature("一周总览", false);
      await setFeature("数据统计", true);
      click(".head-actions .stats-open");
      await settle(240);
      state("04");
      await closeAll();
      await setFeature("一周总览", true);
      await setFeature("数据统计", true);
    },
  },
  {
    // 05：合并后的键位入口 —— 设置「提醒与控制」组里只剩一个「键位…」
    name: "05-键位入口-设置里只剩一个",
    run: async () => {
      await closeAll();
      await openAlertGroup();
      const group = document.querySelector(".sanity-pop #settings-group-alert");
      const n = [...(group?.querySelectorAll("button") ?? [])].filter((b) =>
        /键位|Keys|Key bindings/.test(b.textContent ?? ""),
      ).length;
      window.__DIAG.push(`r83shots 05 键位入口数=${n}`);
    },
  },
  {
    // 06：合并面板全貌 —— 上面全部键位（只读），下面可改键位（收尾把关掉）
    name: "06-键位面板-合并后",
    run: async () => {
      await openAlertGroup();
      document
        .querySelector(".sanity-pop .keymap-open")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(200);
      const panel = document.querySelector(".keymap-panel");
      window.__DIAG.push(
        `r83shots 06 面板=${!!panel} 表行=${panel?.querySelectorAll(".keys tr").length} 可改行=${panel?.querySelectorAll(".rows tr").length}`,
      );
      // ⚠️ 截图在 run() 之后拍 —— 收尾不能放这里（放了就把要拍的面板关掉了）：
      // 下一幕 / 断言舱自己会 closeAll()。
    },
  },
];
