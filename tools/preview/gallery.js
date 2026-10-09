/**
 * round76（3.1a）：**组件展示页**的页面侧实现 —— 逐档量「真实组件」的尺寸（不是缩略图、不是手画样例）。
 *
 * 由 `preview.mjs --gallery <目录>` 驱动：它负责切密度/配色/主题（走真设置路径 + CDP 固定主题）、
 * 每格截图；这里只负责**量尺寸**并返回一张表。3.1b 量图标命中区时直接复用它。
 */
window.__GALLERY = {
  measure() {
    const root = document.documentElement;
    const css = (n) => getComputedStyle(root).getPropertyValue(n).trim();
    const px = (n) => Math.round(n.getBoundingClientRect().height * 10) / 10;
    const box = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const fontOf = (sel) => {
      const n = document.querySelector(sel);
      return n ? getComputedStyle(n).fontSize : null;
    };
    /** 块上动作按钮的命中区（3.1b 要把它抬到 ≥32；这里先如实记下来） */
    const actionButtons = [...document.querySelectorAll("[data-block-id] .actions button")].map((b) => {
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    /** 块高：按块时长分组量（同一档密度里应当成比例）；时长从假库拿（DOM 上没有）
     *  注意：`FIX` 是 fixture.js 里的脚本级 `const` —— 不是 `window.FIX`。 */
    const blocks = typeof FIX === "undefined" ? [] : (FIX.blocks ?? []);
    const heightsByMinutes = {};
    for (const n of document.querySelectorAll("[data-block-id]")) {
      const b = blocks.find((x) => x.id === n.dataset.blockId);
      if (!b) continue;
      const minutes = Math.round((b.end_at - b.start_at) / 60);
      if (![15, 30, 60, 90, 120].includes(minutes)) continue;
      if (heightsByMinutes[minutes] === undefined) heightsByMinutes[minutes] = px(n);
    }
    /** 本批新增元素的尺寸：层条宽（::before）/ 类别条高 / 现在线 / 「现在」小牌 */
    const layerBar = document.querySelector("[data-block-id] .layer-bar");
    const catBar = document.querySelector(".cat-bar");
    const nowLine = document.querySelector(".now-line");
    /** round77 收尾（`图-13`）：**图标逐套量** —— 命中区（≥32 在组装页判红）/ 本体尺寸 / 空 path / 回退 */
    const actionSvgs = [...document.querySelectorAll("[data-block-id] .actions button")].map((b) => {
      const svg = b.querySelector("svg.icon");
      const r = b.getBoundingClientRect();
      const paths = svg ? [...svg.querySelectorAll("path")] : [];
      return {
        icon: svg?.getAttribute("data-icon") ?? null,
        set: svg?.getAttribute("data-icon-set") ?? null,
        paths: paths.length,
        empty: paths.length === 0 || paths.some((p) => !(p.getAttribute("d") ?? "").trim()),
        w: Math.round(r.width * 10) / 10,
        h: Math.round(r.height * 10) / 10,
        svgW: svg ? Math.round(svg.getBoundingClientRect().width * 10) / 10 : 0,
        svgH: svg ? Math.round(svg.getBoundingClientRect().height * 10) / 10 : 0,
      };
    });
    const allIcons = [...document.querySelectorAll("svg.icon")];
    const iconStats = {
      total: allIcons.length,
      sets: [...new Set(allIcons.map((n) => n.getAttribute("data-icon-set")))].sort(),
      // round77 收尾（6b P1-2）：`data-icon-set` 只是**回显请求值**，验不了回退；
      // `data-icon-source` 才是形状实际来自哪一套 → `withFallback` 才是「回退 0」的证据
      sources: [...new Set(allIcons.map((n) => n.getAttribute("data-icon-source")))].sort(),
      withFallback: allIcons.filter(
        (n) => n.getAttribute("data-icon-set") !== n.getAttribute("data-icon-source"),
      ).length,
      withNoPath: allIcons.filter((n) => n.querySelectorAll("path").length === 0).length,
      withEmptyPath: allIcons.filter((n) =>
        [...n.querySelectorAll("path")].some((p) => !(p.getAttribute("d") ?? "").trim()),
      ).length,
    };
    return {
      density: root.dataset.density,
      palette: root.dataset.palette,
      theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      tokens: {
        rowHeight: css("--row-height"),
        slotHeight: css("--slot-height"),
        controlHeight: css("--control-height"),
        timelineCol: css("--timeline-col-width"),
        // round77 收尾（6b P2）：槽高是**下限** —— 上面那条提示/键位条的天然高不许超过它
        stripHeight: css("--strip-height"),
        textBody: css("--text-body"),
        textMeta: css("--text-meta"),
      },
      measured: {
        backlogRow: box(".list .item"),
        settingsRow: box(".sanity-pop .row"),
        timelineCol: box(".day"),
        blockHeights: heightsByMinutes,
        actionButton: actionButtons[0] ?? null,
        layerBarWidth: layerBar ? getComputedStyle(layerBar, "::before").width : null,
        catBarHeight: catBar ? getComputedStyle(catBar).height : "（关着，没画）",
        nowLineHeight: nowLine ? getComputedStyle(nowLine).height : null,
        // 固定槽与条的天然盒子（6b P2：条的天然高 > 槽高 就会把头部顶高一截）
        hintSlot: box(".hint-slot"),
        sanityBar: box(".sanity"),
        bulkBar: box(".bulk-bar"),
        fontBlockName: fontOf("[data-block-id] .name"),
        fontBlockTime: fontOf("[data-block-id] .time"),
        fontTick: fontOf(".tick"),
        fontDayHead: fontOf(".day-head"),
        // round77 收尾：图标（五套逐套量时由 `preview.mjs --gallery` 逐套取这张表）
        actionSvgs,
        iconStats,
      },
    };
  },
};
