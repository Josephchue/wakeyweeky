/**
 * round76（3.1a）：**全矩阵（72 格）的页面侧实现**。
 *
 * 72 格 = 3 配色 × 2 主题 × 3 密度 × 2 宽（1500 / 715）× 2 语言。
 * 主题与宽度由 `preview.mjs` 用 CDP 改（`Emulation.setEmulatedMedia` / `setDeviceMetricsOverride`）；
 * 这里只负责两件事：
 *   1. `setCell({density, palette, locale})` —— 走**真实设置路径**（设置面板的下拉 + change 事件）
 *      把一格的外观改到位；
 *   2. `scan()` —— 逐格跑一遍**读类**检查（溢出扫描 + 本批新增元素），返回 `{ offenders, fails }`。
 *
 * 为什么逐格只跑读类：手势/写入类断言会把假库改脏，连跑 72 遍必假红（see plan §4.11）。
 */
window.__MATRIX = {  /** 改一格：三个设置项走真 UI（面板里的下拉）；返回没改动成功的原因数组（[] = 全部到位）
   *  round77 收尾：`iconSet` 可选（五套图标逐套量时走同一条真 UI 路径） */
  async setCell({ density, palette, locale, iconSet, night }) {
    const errs = [];
    // round78（3.1b₂）：每格先**回本周** —— 前序断言可能把视图停在别的周，
    // 而这一格的「层条 / 块内字号」判据要量本周的块。
    // （注：整套断言跑完后假库只剩 round78 的种子块是**已知遗留**，见验收文档诚实清单 #1；
    //   矩阵的自备靶子尝试过、没成功 —— 根因待下一批查，不在本轮静默绕过。）
    // round78（3.1b₂）：先「跳走再回来」**强制真重拉**（跳周才会重新拉数据）。
    // 踩过的坑：只点「本周」在已经处于本周时是 no-op → 视图可能停在一份**过时的快照**上
    // （假库是对的、DOM 是旧的）—— 矩阵因此 72 格全红，而断言全绿（盲点：视图与假库之间没有版本号）。
    const navClick = async (i) => {
      document.querySelectorAll(".week-nav button")[i]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settleMicro(90);
    };
    await navClick(1); // 下一周
    await navClick(0); // 回本周
    document.querySelector(".week-nav .now")?.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 清选中/保险
    await settleMicro(60);
    // round78（3.1b₂）：**矩阵自备靶子** —— 层条/字号判据要求「本周有 planned 的必填 + 弹性块」。
    // 整套断言跑下来可能把本周的块改没（见验收文档诚实清单），矩阵不该依赖「前面恰好留下什么」。
    // 注意：必须用**跳周**触发重拉（点「本周」在已处于本周时是 no-op —— 上次就栽在这）。
    if (!window.__MTX_SEEDED) {
      // round80（6b 三轮修）：旧写法按「本周有没有该层的块」决定种不种，却按 **id** 验收 ——
      // 本周本来就有 planned required（b7/b8）时会**跳过种靶子**再去要 `mtx-req` → 恒红
      //（实测 72 格全红，现场：假库本周=[… b7:planned:required b8:planned:required …] DOM 无 mtx-req）。
      // 现在：**按 id 判**（缺哪个补哪个）+ 用**临时任务**（`mergeNeighbour` 明确跳过它 → 不会被融合吃掉 id）
      // + 挑一个真正空闲的小时（防和其它块重叠）。
      const hasId = (id) => FIX.blocks.some((b) => b.id === id);
      const reqAt = hasId("mtx-req") ? "已有" : at(1, 13, 0);
      const elaAt = hasId("mtx-ela") ? "已有" : at(1, 15, 0);
      // 不需要空闲位：**临时任务**的块不会被融合（`mergeNeighbour` 第一行就跳过 `TEMP_TASK_ID`），
      // 跟别人的块重叠也不会被吃掉 —— 检查只量 DOM 里有没有这两个 id。
      // （踩过的坑：为了「不重叠」去搜空闲位 —— 检查跑完的假库本周有 77 块、最长跨 3 天 → 恒找不到。）
      if (!hasId("mtx-req")) {
        FIX.blocks.push(B("mtx-req", TEMP_TASK_ID, reqAt, reqAt + 3600, "required", "planned"));
      }
      if (!hasId("mtx-ela")) {
        FIX.blocks.push(B("mtx-ela", TEMP_TASK_ID, elaAt, elaAt + 1800, "elastic", "planned"));
      }
      await navClick(1);
      await navClick(0);
      await settleMicro(120);
      // round79（6b 二轮 P2）：落地检查按 **id** 判 —— 旧写法只看 `.block.planned.layer-required`，
      // 「别人留下的现场」也能满足它（这条判据就没有牙了）；顺便把旗标放到**检查通过之后**
      // （没种上就下一格重试，而不是一格失败之后永不再试）。
      const seeded =
        !!document.querySelector('[data-block-id="mtx-req"].layer-required') &&
        !!document.querySelector('[data-block-id="mtx-ela"].layer-elastic');
      if (seeded) window.__MTX_SEEDED = true;
      else {
        // round80（6b 三轮）：失败时把现场一同报出来 —— 周范围 / 假库本周的块 / DOM 清单
        const range = document.querySelector(".timeline .range")?.textContent?.trim() ?? "-";
        const ws = at(0, 0, 0);
        const weekHas = FIX.blocks
          .filter((b) => b.end_at > ws && b.start_at < ws + 7 * 86400)
          .map((b) => `${b.id}:${b.status}:${b.layer}`)
          .slice(0, 12)
          .join(" ");
        // round80（6b 三轮）：空闲搜索找不到时，把「周块数 + 最长的几块」一并报出来
        const weekAll = FIX.blocks.filter((b) => b.end_at > ws && b.start_at < ws + 7 * 86400);
        const longest = [...weekAll]
          .sort((a, b) => b.end_at - b.start_at - (a.end_at - a.start_at))
          .slice(0, 3)
          .map((b) => `${b.id}:${Math.round((b.end_at - b.start_at) / 60)}min:${b.status}`)
          .join(" ");
        const census = [...document.querySelectorAll("[data-block-id]")]
          .map(
            (n) =>
              `${n.dataset.blockId}:${[...n.classList]
                .filter((c) => ["planned", "done", "missed", "layer-required", "layer-elastic"].includes(c))
                .join("+")}`,
          )
          .slice(0, 12)
          .join(" ");
        errs.push(
          `矩阵靶子没种上（周=[${range}] 选位=${reqAt || "无空闲"}/${elaAt || "无空闲"} 周块数=${weekAll.length} 最长=[${longest}] 假库本周=[${weekHas}] DOM=[${census}]）`,
        );
      }
    }
    const openPanel = async () => {
      if (document.querySelector(".sanity-pop")) return true;
      document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settleMicro(20);
      return !!document.querySelector(".sanity-pop");
    };
    if (!(await openPanel())) return ["设置面板打不开（量不到 .sanity-gear / .sanity-pop）"];
    const pick = async (selector, value) => {
      const el = document.querySelector(`.sanity-pop ${selector}`);
      if (!el) {
        errs.push(`控件不在：${selector}`);
        return;
      }
      // round78（3.1b₂ · 设-02）：密度 / 配色 / 图标三处换成**预览按钮组**（容器保留旧类名）——
      // 查到容器而不是 select 时，点 `[data-value="…"]` 那颗（与 `checks.js` 的 `pickAppearance` 同一口径）。
      if (el.tagName !== "SELECT") {
        const btn = el.querySelector(`[data-value="${value}"]`);
        if (!btn) {
          errs.push(`按钮不在：${selector}[data-value=${value}]`);
          return;
        }
        if (btn.classList.contains("on")) return;
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settleMicro(40);
        if (!el.querySelector(`[data-value="${value}"]`)?.classList.contains("on")) {
          errs.push(`按钮没选中：${selector}=${value}`);
        }
        return;
      }
      if (el.value === value) return;
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await settleMicro(30);
      if (el.value !== value) errs.push(`下拉没改成功：${selector}=${el.value}（想要 ${value}）`);
    };
    await pick(".text-density", density);
    await pick(".ui-palette", palette);
    await pick("select.lang", locale);
    if (iconSet) await pick(".icon-set", iconSet);
    // round82（3.1c₂ · Step 4）：夜间格 —— 第四档「按时间」+ 一对**包住当前时刻**的时段
    // （带必然可见；两格（亮/暗）由 CDP 的 prefers-color-scheme 区分）
    if (night) {
      await pick(".ui-theme", "night");
      const now = new Date();
      const nowM = now.getHours() * 60 + now.getMinutes();
      const hhmm = (m) => {
        const v = (((m % 1440) + 1440) % 1440);
        return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
      };
      // round87（Step 6 修）：这套窗是「现在 ±60 分钟」——**午夜前后跑时会跨天**，
      // 渲染层按 `nightSegments()` 画 **2 段**；旧扫描写死「1 段」→ 半夜跑必假红（Step 6 实测 2 格）。
      // 现在窗口只算一次，段数期望与渲染层同一条规则，一起交给 scan。
      const ns = hhmm(nowM - 60);
      const ne = hhmm(nowM + 60);
      window.__MTX_NIGHT = { start: ns, end: ne, segs: ns === ne ? 0 : ns < ne ? 1 : 2 };
      for (const [sel, v] of [
        ["input.night-start", ns],
        ["input.night-end", ne],
      ]) {
        const inp = document.querySelector(`.sanity-pop ${sel}`);
        if (!inp) {
          errs.push(`控件不在：${sel}`);
          continue;
        }
        inp.value = v;
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        await settleMicro(60);
      }
    }
    return errs;
  },

  /** 逐格读类检查：溢出扫描（主屏 + 设置面板 + 四个覆盖面板）+ 本批新增元素的形状/取值
   *  `cell` = 这一格自身声明的密度/配色/语言（**逐格核对**：6b P2 —— 以前只拿 DOM 自称的密度去查期望表，
   *  palette 与 locale 一格都没验） */
  async scan(cell) {
    const fails = [];
    const root = document.documentElement;
    const css = (n) => getComputedStyle(root).getPropertyValue(n).trim();

    // ⓪ 这一格的三个属性必须真的到位（否则后面的 token/元素检查会拿到“别的格”的现状）
    if (cell) {
      if (root.dataset.density !== cell.density) fails.push(`data-density=${root.dataset.density}≠${cell.density}`);
      if (root.dataset.palette !== cell.palette) fails.push(`data-palette=${root.dataset.palette}≠${cell.palette}`);
      const lang = root.lang === "en" ? "en" : "zh";
      if (lang !== cell.locale) fails.push(`lang=${root.lang}≠${cell.locale}`);
    }

    // ① 8 个尺寸/字号 token 必须等于该密度档的期望值
    const want = densityExpect(root.dataset.density);
    for (const [k, v] of Object.entries(want)) {
      if (css(k) !== v) fails.push(`token ${k}=${css(k)}≠${v}`);
    }

    // ② 语下限：块内名字 / 时间 / 刻度 ≥12px
    const sizes = [
      ...document.querySelectorAll("[data-block-id] .name"),
      ...document.querySelectorAll("[data-block-id] .time"),
      ...document.querySelectorAll(".tick"),
    ].map((n) => parseFloat(getComputedStyle(n).fontSize));
    const small = sizes.filter((s) => s < 12);
    if (small.length) fails.push(`字号 <12px：${small.length} 处`);

    // ③ 层条：4px；弹性是竖向虚线
    const req = document.querySelector(".block.planned.layer-required .layer-bar");
    const ela = document.querySelector(".block.planned.layer-elastic .layer-bar");
    if (!req || !ela) {
      const census = [...document.querySelectorAll("[data-block-id]")]
        .map((n) => `${n.dataset.blockId}:${[...n.classList].filter((c) => ["planned", "done", "missed", "layer-required", "layer-elastic"].includes(c)).join("+")}`)
        .slice(0, 12)
        .join(" ");
      const range = document.querySelector(".timeline .range")?.textContent?.trim() ?? "-";
      const panel = document.querySelector("[data-block-id]") ? "块在" : "无块";
      fails.push(`找不到计划中的必填/弹性块（周=[${range}] ${panel} 清单=[${census}] 遮罩=${!!document.querySelector(".overlay-backdrop")}）`);
    }
    else {
      // round86（0.32.0 · ③）：白瓷的装饰把层条收窄到 3px（`--layer-bar-width`，值在 decor-86.json）
      const wantBar = document.documentElement.dataset.palette === "porcelain" ? "3px" : "4px";
      if (getComputedStyle(req, "::before").width !== wantBar) {
        fails.push(`层条宽=${getComputedStyle(req, "::before").width}（期望 ${wantBar}）`);
      }
      if (!getComputedStyle(ela, "::before").backgroundImage.includes("repeating-linear-gradient")) {
        fails.push("弹性层条不是虚线");
      }
    }

    // ④ 现在线：今天列里有、不吃指针；今天列底色与别的列不同
    const line = document.querySelector(".day.today .now-line");
    if (!line) fails.push("今天列没有现在线");
    else if (getComputedStyle(line).pointerEvents !== "none") fails.push("现在线挡手势");
    const todayBg = document.querySelector(".day.today .day-body");
    const otherBg = document.querySelector(".day:not(.today) .day-body");
    if (!todayBg || !otherBg) fails.push("量不到天列");
    else if (getComputedStyle(todayBg).backgroundColor === getComputedStyle(otherBg).backgroundColor) {
      fails.push("今天列没有微高光");
    }

    // ⑤ 分类底边条：默认关（这一格没开）→ 一个都不画
    if (document.querySelectorAll(".cat-bar").length !== 0) fails.push("默认关了还画了分类条");

    // ⑤b round82（3.1c₂ · Step 4）：夜间格 —— 第四档 + 包住现在的时段 → 每列淡化带（完整覆盖）。
    // round87（Step 6 修）：段数期望**跟着窗口走**（跨午夜 = 2 段），不写死 1。
    if (cell?.night) {
      const bands = [...document.querySelectorAll(".day-body .dim-band")];
      const days = document.querySelectorAll(".timeline .day-body").length;
      if (!bands.length) fails.push("夜间档没画淡化带");
      else {
        if (bands.length !== days) fails.push(`淡化带 ${bands.length} ≠ 天列 ${days}`);
        const win = window.__MTX_NIGHT ?? { start: "?", end: "?", segs: 1 };
        const segs = [...bands[0].querySelectorAll("span")];
        if (segs.length !== win.segs) {
          fails.push(`时段 ${win.start}→${win.end} 该是 ${win.segs} 段，实为 ${segs.length}`);
        } else if (!segs.every((s) => parseFloat(s.style.height) > 0)) {
          fails.push("淡化带高度有 0 的段");
        }
        if (getComputedStyle(bands[0]).pointerEvents !== "none") fails.push("淡化带挡手势");
      }
    }

    // ⑥ 溢出扫描（主屏 + 设置面板 + 四个覆盖面板）
    const offenders = await scanOverflow();
    return { offenders, fails: [...fails, ...offenders.map((o) => `溢出 ${o}`)] };
  },
};
