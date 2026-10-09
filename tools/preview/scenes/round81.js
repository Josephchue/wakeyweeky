/**
 * round81（0.29.0）：本批截图场景表。
 * `node tools/preview/preview.mjs --width 1100 --shots docs/visual/round81/before-1100 --shots-file scenes/round81.js`
 * 暗色再跑一遍（加 `--theme dark`、输出到另一个目录）。
 *
 * 本批重点 = 「挤」bug 的 before/after 对照（迷你周视图 + 主界面窄窗），
 * 每幕除截图外还往 `__DIAG` 里写**机器取证**（裁切/两行阈值）——before/after 数字直接进验收。
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

/** 「挤」的机器取证：日头裁切 / 块内文字裁切 / 两行块的块高 */
const measureMini = (tag) => {
  const mini = document.querySelector("[data-tpl-mini]");
  if (!mini) return window.__DIAG.push(`r81shots ${tag} 迷你预览不在`);
  const heads = [...mini.querySelectorAll(".heads i")];
  const names = new Map();
  const dayClip = heads.map((h) => {
    const r = document.createRange();
    r.selectNodeContents(h);
    const textW = Math.round(r.getBoundingClientRect().width);
    const cellW = Math.round(h.clientWidth);
    names.set(textW, cellW);
    return textW > cellW + 1 ? 1 : 0;
  });
  const blocks = [...mini.querySelectorAll(".blk")];
  let textClip = 0;
  for (const b of blocks) {
    const text = b.querySelector(".text") ?? b;
    if (text.scrollHeight > text.clientHeight + 1) textClip += 1;
  }
  const axis = parseFloat(getComputedStyle(mini).getPropertyValue("--mini-axis")) || 38;
  const colW = Math.round((mini.clientWidth - axis) / 7);
  window.__DIAG.push(
    `r81shots ${tag} 浮窗=${mini.clientWidth} 列宽=${colW} 日头裁切=${dayClip.reduce((a, b) => a + b, 0)}/${heads.length} ` +
      `块=${blocks.length} 文字裁切=${textClip}`,
  );
};

/** 主界面：块内两行 / 名字裁切（窄窗判据） */
const measureTimeline = (tag) => {
  const blocks = [...document.querySelectorAll(".timeline .block")];
  if (!blocks.length) {
    // Timeline 根 class 可能不叫 .timeline —— 退一步量整页的 .block（TaskBlock 只被 Timeline 用）
    return measureBlocks(tag, [...document.querySelectorAll(".block")]);
  }
  return measureBlocks(tag, blocks);
};
const measureBlocks = (tag, blocks) => {
  let nameClip = 0;
  let timeClip = 0;
  let twoLine = 0;
  let twoLineTight = 0;
  for (const b of blocks) {
    const nm = b.querySelector(".name");
    const tm = b.querySelector(".time");
    if (nm && nm.scrollWidth > nm.clientWidth + 1) nameClip += 1;
    if (tm) {
      twoLine += 1;
      if (tm.scrollWidth > tm.clientWidth + 1) timeClip += 1;
      const text = b.querySelector(".text");
      if (text && text.scrollHeight > text.clientHeight + 1) twoLineTight += 1;
    }
  }
  window.__DIAG.push(
    `r81shots ${tag} 块=${blocks.length} 有第二行=${twoLine} 名字裁切=${nameClip} 时段裁切=${timeClip} 两行挤压=${twoLineTight}`,
  );
};

/** 设置 → 时间轴 → 取消「显示周末」 */
const hideWeekend = async () => {
  click(".sanity-gear");
  await settle(60);
  const box = document.querySelector('#settings-group-timeline .row.switch input[type="checkbox"]');
  if (box && box.checked) {
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(60);
  }
  window.__DIAG.push(`r81shots 隐藏周末：勾选框=${!!box} 未勾=${box ? !box.checked : "n/a"}`);
  for (let i = 0; i < 2; i++) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  }
  await settle(40);
};

window.__SHOTS = [
  {
    // 01：迷你周视图（79-02）——「挤」的主现场
    name: "01-迷你周视图",
    run: async () => {
      await closeAll();
      click(".templates-open");
      await settle(240);
      measureMini("01");
    },
  },
  {
    // 02：主界面窄窗 + 隐藏周末（5 列）——「挤」的第二个候选现场
    name: "02-主界面-隐藏周末",
    run: async () => {
      await closeAll();
      await hideWeekend();
      measureTimeline("02");
    },
  },
  {
    // 03：设置 →「时间轴」组的时间 / 日期格式（选项带真实样例）
    name: "03-设置-时间与日期格式",
    run: async () => {
      await closeAll();
      click(".sanity-gear");
      await settle(80);
      click('.sanity-pop .nav-btn[data-group="timeline"]');
      await settle(60);
      const t = document.querySelector('.sanity-pop select.time-format');
      const d = document.querySelector('.sanity-pop select.date-format');
      window.__DIAG.push(
        `r81shots 03 选项=${t ? t.options.length : 0}/${d ? d.options.length : 0} 当前=${t?.selectedOptions?.[0]?.textContent ?? "?"} · ${d?.selectedOptions?.[0]?.textContent ?? "?"}`,
      );
    },
  },
  {
    // 04：12 小时制下的时间轴（刻度栏加宽 + `8:00 AM` 刻度）—— 拍完把格式还原
    name: "04-12小时制-时间轴",
    run: async () => {
      await closeAll();
      click(".sanity-gear");
      await settle(60);
      const t = document.querySelector('.sanity-pop select.time-format');
      if (t) {
        t.value = "h12";
        t.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await settle(80);
      document.querySelector('.sanity-pop .close')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(60);
      window.__DIAG.push(
        `r81shots 04 data12=${document.documentElement.dataset.time12} 刻度=${[...document.querySelectorAll(".timeline .tick")]
          .map((n) => n.textContent)
          .filter(Boolean)
          .slice(0, 3)
          .join("/")}`,
      );
      // 截图在 `run()` 返回之后拍 —— 这里**不还原**，否则拍到的是还原后的样子（首跑实测踩到）
    },
  },
  {
    // 05：把时间格式还原（截图是给下一幕保底的；名字里写清楚它不是功能展示）
    name: "05-还原时间格式（收尾）",
    run: async () => {
      await closeAll();
      click(".sanity-gear");
      await settle(60);
      const t = document.querySelector('.sanity-pop select.time-format');
      if (t && t.value !== "system") {
        t.value = "system";
        t.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(60);
      }
      document.querySelector('.sanity-pop .close')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(30);
    },
  },

  {
    // 06：窄窗 7 列（**round82 图 3 的重放材料**：列 ~46px，高块名字只剩 1 字）
    name: "06-窄窗7列-名字省略",
    run: async () => {
      await closeAll();
      measureTimeline("06");
    },
  },
];