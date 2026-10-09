/**
 * round82（0.30.0）：本批截图场景表（Step 3 的样张组实现）。
 *
 *   node tools/preview/preview.mjs --width 1500 --shots docs/visual/round82 --shots-file scenes/round82.js
 *   node tools/preview/preview.mjs --width 1500 --theme dark --shots docs/visual/round82/暗色 --shots-file scenes/round82.js
 *   node tools/preview/preview.mjs --width 715  --shots docs/visual/round82/窄窗 --shots-file scenes/round82.js
 *
 * 四幕对应 Step 3 的四条：11.1 迷你并排（案 B）/ 11.3 名字多行 / 11.5 统计入口（案 1 + 子层）/ 11.2 浮层自适应。
 * 每幕除截图外都往 `__DIAG` 写**机器取证**（数字进验收）。
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

/** 迷你周视图：并排块数 / 块宽 / 描了名字的块 / 任意两块是否相交 */
const measureMini = (tag) => {
  const mini = document.querySelector("[data-tpl-mini]");
  if (!mini) return window.__DIAG.push(`r82shots ${tag} 迷你预览不在`);
  const blocks = [...mini.querySelectorAll(".blk")];
  const rects = blocks.map((b) => b.getBoundingClientRect());
  let overlap = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const ix = Math.min(rects[i].right, rects[j].right) - Math.max(rects[i].left, rects[j].left);
      const iy = Math.min(rects[i].bottom, rects[j].bottom) - Math.max(rects[i].top, rects[j].top);
      if (ix > 0.5 && iy > 0.5) overlap += 1;
    }
  }
  const cols = blocks.map((b) => Number(b.dataset.cols) || 1);
  const named = blocks.filter((b) => b.querySelector(".nm")).length;
  const widths = [...new Set(blocks.map((b) => Math.round(b.getBoundingClientRect().width)))].sort((a, b) => a - b);
  window.__DIAG.push(
    `r82shots ${tag} 浮窗=${mini.clientWidth} 块=${blocks.length} 并排块=${cols.filter((c) => c > 1).length} 最大列数=${Math.max(
      1,
      ...cols,
    )} 相交对=${overlap} 画名字=${named} 块宽=[${widths.join(",")}]`,
  );
};

/** 主时间轴：名字行数（`data-label-lines`）与实际渲染行数 / 有无越界 */
const measureLabels = (tag) => {
  const line = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-meta")) || 12) * 1.2;
  const inners = [...document.querySelectorAll("[data-block-id]")];
  let multi = 0;
  let outside = 0;
  const sample = [];
  for (const inner of inners) {
    const host = inner.closest(".block");
    const label = inner.querySelector(".label");
    if (!host || !label) continue;
    const lines = Number(inner.dataset.labelLines) || 1;
    if (lines > 1) multi += 1;
    if (label.getBoundingClientRect().bottom > host.getBoundingClientRect().bottom + 0.5) outside += 1;
    if (sample.length < 6 && lines > 1) {
      sample.push(`h${Math.round(host.getBoundingClientRect().height)}=${lines}行×${inner.dataset.cols}列`);
    }
  }
  window.__DIAG.push(`r82shots ${tag} 块=${inners.length} 多行块=${multi} 越界=${outside} 样本=[${sample.join(" ")}] 行高=${line}`);
};

/** 浮层：并排块每行几枚 / 宽高（截图里用 `opacity:1` 强制显示，只在截图期间生效） */
const measureActions = (tag) => {
  const style = document.createElement("style");
  style.id = "shots-actions";
  style.textContent = ".block .actions{opacity:1 !important;pointer-events:none !important;}";
  document.head.appendChild(style);
  const rows = [...document.querySelectorAll("[data-block-id]")]
    .map((inner) => {
      const acts = inner.querySelector(".actions");
      if (!acts) return null;
      const n = acts.querySelectorAll("button").length;
      const ar = acts.getBoundingClientRect();
      const br = inner.getBoundingClientRect();
      const ys = new Set([...acts.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().top)));
      return { cols: Number(inner.dataset.cols) || 1, n, aw: Math.round(ar.width), ah: Math.round(ar.height), bw: Math.round(br.width), rows: ys.size };
    })
    .filter(Boolean);
  const narrow = rows.filter((r) => r.cols > 1);
  window.__DIAG.push(
    `r82shots ${tag} 浮层=${rows.length}（并排 ${narrow.length}） 并排明细=[${narrow
      .slice(0, 8)
      .map((r) => `${r.cols}列/${r.n}枚→${r.aw}×${r.ah}(块${r.bw},${r.rows}行)`)
      .join(" ")}]`,
  );
};

window.__SHOTS = [
  {
    // 01：迷你周视图 —— 重叠块并排（11.1 案 B）
    name: "01-迷你-重叠并排",
    run: async () => {
      await closeAll();
      click(".templates-open");
      await settle(240);
      measureMini("01");
    },
  },
  {
    // 02：主时间轴 —— 并排块的名字多行（11.3）
    name: "02-并排块名字多行",
    run: async () => {
      await closeAll();
      // 滚到有并排块的时段（周三 14:00 那一段）
      const s = document.querySelector(".scroll");
      if (s) s.scrollTop = Math.max(0, s.scrollTop + 240);
      await settle(40);
      measureLabels("02");
    },
  },
  {
    // 03：总览顶栏里的统计入口 + 点开后的子层（11.5 案 1）
    name: "03-总览里的统计入口",
    run: async () => {
      await closeAll();
      click(".review-open");
      await settle(240);
      window.__DIAG.push(`r82shots 03 顶栏独立统计按钮=${!!document.querySelector(".head-actions .stats-open")} 总览里的入口=${!!document.querySelector(".review-panel .stats-open")}`);
      click(".review-panel .stats-open");
      await settle(240);
      window.__DIAG.push(
        `r82shots 03 统计面板=${!!document.querySelector(".stats-panel")} 总览还在=${!!document.querySelector(".review-panel")}`,
      );
    },
  },
  {
    // 04：动作浮层自适应（11.2 二轮）—— 截图里强制显示（平时是 hover 才出）
    name: "04-浮层自适应",
    run: async () => {
      await closeAll();
      await settle(40);
      measureActions("04");
    },
  },
  {
    // 05：设置里的夜间三行（深浅色第四档 / 夜间时段 / 淡化开关）—— Step 4
    name: "05-夜间设置",
    run: async () => {
      await closeAll();
      click(".sanity-gear");
      await settle(80);
      const pop = document.querySelector(".sanity-pop");
      const dim = pop?.querySelector("input.night-dim");
      if (dim && !dim.checked) {
        dim.checked = true;
        dim.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(60);
      }
      for (const [sel, v] of [
        ["input.night-start", "22:00"],
        ["input.night-end", "06:00"],
      ]) {
        const inp = pop?.querySelector(sel);
        if (inp && inp.value !== v) {
          inp.value = v;
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          await settle(60);
        }
      }
      window.__DIAG.push(
        `r82shots 05 夜间时段=${pop?.querySelector("input.night-start")?.value}→${pop?.querySelector("input.night-end")?.value}` +
          ` 淡化开=${pop?.querySelector("input.night-dim")?.checked} 第四档在=${!!pop?.querySelector('.ui-theme [data-value="night"]')}`,
      );
    },
  },
  {
    // 06：时间轴上的淡化带（22:00–06:00 两段；滚到 00:00 看上半段）—— Step 4
    name: "06-夜间淡化带",
    run: async () => {
      await closeAll();
      const s = document.querySelector(".scroll");
      if (s) s.scrollTop = 0;
      await settle(40);
      const bands = [...document.querySelectorAll(".day-body .dim-band")];
      const segs = bands[0]
        ? [...bands[0].querySelectorAll("span")].map((x) => `${parseFloat(x.style.top).toFixed(1)}%+${parseFloat(x.style.height).toFixed(1)}%`)
        : [];
      window.__DIAG.push(
        `r82shots 06 带=${bands.length} 首列段=[${segs.join(" ")}] token=${getComputedStyle(document.documentElement).getPropertyValue("--dim-band").trim()}`,
      );
    },
  },
  {
    // 07：统计补齐（统-03…07）—— 五个新指标 + 分类分布（Step 6）
    name: "07-统计补齐",
    run: async () => {
      await closeAll();
      window.__SEED_STATS();
      // 与 `round82 ⑩` 同一条时间线（本周四 12:00）—— 截图里的数字稳定可复现
      window.__FAKE_NOW = at(3, 12, 0);
      click(".stats-open");
      await settle(240);
      const panel = document.querySelector(".stats-panel");
      const rows = [...(panel?.querySelectorAll(".row") ?? [])].map(
        (r) =>
          `${(r.querySelector("dt")?.textContent ?? "").trim()}=${(r.querySelector("dd")?.textContent ?? "").trim()}`,
      );
      const bars = panel?.querySelectorAll(".trend .tbar").length ?? 0;
      window.__DIAG.push(`r82shots 07 统计面板=${!!panel} 行数=${rows.length} 趋势条=${bars} 明细=[${rows.join(" | ")}]`);
    },
  },
  {
    // 08：统计面板的下半页（分类分布三栏 + 口径说明 + 记录组）—— 同一份数据，滚到底
    name: "08-统计-分类分布",
    run: async () => {
      const panel = document.querySelector(".stats-panel");
      if (panel) panel.scrollTop = panel.scrollHeight;
      await settle(60);
      const cats = [...(panel?.querySelectorAll(".group") ?? [])].find(
        (g) => (g.querySelector("h3")?.textContent ?? "").trim() === "分类分布",
      );
      window.__DIAG.push(
        `r82shots 08 面板=${!!panel} 分类行=${cats?.querySelectorAll(".row").length ?? 0} 说明=${!!cats?.querySelector(".empty")} 尾=${panel ? Math.round(panel.scrollTop) + "/" + Math.round(panel.scrollHeight) : "-"}`,
      );
    },
  },
  {
    // 09：改键位面板（设置 → 提醒与控制 → 改键位…）—— Step 7
    name: "09-改键位面板",
    run: async () => {
      await closeAll();
      click(".sanity-gear");
      await settle(80);
      click(".sanity-pop .keymap-open");
      await settle(160);
      const panel = document.querySelector(".keymap-panel");
      const rows = panel?.querySelectorAll(".rows tr").length ?? 0;
      window.__DIAG.push(
        `r82shots 09 面板=${!!panel} 行数=${rows} 键帽首行=[${panel?.querySelector(".rows .kbd")?.textContent?.trim() ?? "-"}] 设置还在=${!!document.querySelector(".sanity-pop")}`,
      );
    },
  },
  {
    // 10：录制态（C1）—— 点键帽 → 只按修饰键（实时预览「已按住 Ctrl…」，主键还没落定）
    name: "10-录键态",
    run: async () => {
      const cap = document.querySelector(".keymap-panel .rows .kbd");
      cap?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(30);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true, cancelable: true }));
      await settle(30);
      const panel = document.querySelector(".keymap-panel");
      window.__DIAG.push(
        `r82shots 10 录制中=${!!panel?.querySelector(".kbd.on")} 播报=[${panel?.querySelector(".live")?.textContent?.trim() ?? "-"}]`,
      );
    },
  },
];
