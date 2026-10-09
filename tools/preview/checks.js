/**
 * 页面侧自证：DOM 断言 + 截图前故意留的那个手势。
 * （假数据与假后端在 `fixture.js`；两个文件由 `preview.mjs` 当普通脚本先后注入，
 *  顶层 `const`/`function` 在同一个全局词法作用域里，互相能看见。）
 *
 * 进度写在 `document.documentElement.dataset.checks`（loaded / running / done）——
 * 页面根本没跑起来时，node 侧靠这个字段区分「脚本没加载」还是「断言还没跑完」。
 */
document.documentElement.dataset.checks = "loaded";
/**
 * round74（3.0b₂）：伪语言压力跑**整套**断言时的读文本拦截 ——
 * `?pseudo=1` 会把每条译文包成【值———】（长度压到 ~1.3 倍）；文字断言比的是原值。
 * 这里在**harness 页**（不是产品代码）把读到的文本/属性剥掉装饰，文字断言照旧能跑；
 * 布局（rect / scrollWidth）不受影响 —— 装饰仍占位，溢出照抓。
 * （同类做法：合成指针的 `setPointerCapture` shim，都写在自证工具里。）
 */
const PSEUDO_ON = new URLSearchParams(location.search).has("pseudo");
function stripPseudo(s) {
  return s == null ? s : String(s).split("【").join("").split("———】").join("");
}
if (PSEUDO_ON) {
  const desc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  if (desc?.get) {
    Object.defineProperty(Node.prototype, "textContent", {
      ...desc,
      get() {
        return stripPseudo(desc.get.call(this));
      },
      configurable: true,
    });
  }
  const getAttr = Element.prototype.getAttribute;
  Element.prototype.getAttribute = function (name) {
    return stripPseudo(getAttr.call(this, name));
  };
  // 给「验伪语言真的生效」的断言用：读到**带装饰**的原值（别的断言走剥过的）
  window.__RAW_TEXT = (el) => (el && desc?.get ? desc.get.call(el) : "");
  window.__RAW_ATTR = (el, name) => (el ? getAttr.call(el, name) : null);
}
/** 记进度 + 虚拟时钟（测试卡住时靠它判断是「等不到时钟」还是「页面没空闲」） */
/**
 * Svelte 的 DOM 更新在微任务里 flush：手势断言只要等它，不必等时钟。
 * 虚拟时间下如果有个 rAF 循环在跑（自动滚动的循环就是这么设计的），时钟会被拖住 → 用 tick() 会卡住 ✗
 */
/** 让 Svelte 把 DOM 更新 flush 掉（微任务，不依赖时钟） */
const flush = () => new Promise((r) => queueMicrotask(() => queueMicrotask(r)));
/** 等若干微任务轮：异步 IPC（假后端）与随之而来的重渲染都在微任务里完成 */
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await flush();
};
/** 等 n 帧：自动滚动/布局这种要看帧的东西用它（虚拟时间下时钟会被 rAF 拖着走，别用 setTimeout 等） */
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const frames = async (n) => {
  for (let i = 0; i < n; i++) await nextFrame();
};
const mark = (what) => {
  document.documentElement.dataset.checksRun = what + "@" + Math.round(performance.now());
};

function domChecks() {
  const el = (id) => document.querySelector('[data-block-id="' + id + '"]');
  const h = (id) => el(id)?.getBoundingClientRect().height ?? -1;
  const w = (id) => el(id)?.getBoundingClientRect().width ?? -1;
  /** 最后一次 list_blocks 的窗口起点（跳周到底有没有人去拉那一周，看它） */
  const lastWinFrom = () => ((window.__DBG || []).slice(-1)[0] || [])[0] ?? 0;
  /** 回到本周 + 默认视野（翻周会把「跟随现在」关掉，得点顶部那个「回到本周」） */
  async function backToThisWeek() {
    document
      .querySelector(".week-nav .now")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(20);
    setScrollHome();
    await settle();
  }

  // round76（3.1a）：设置面板里的外观控件（打开面板 → 拿控件 → 改 → 必要时关面板）
  async function openAppearance(selector) {
    if (!document.querySelector(".sanity-pop")) {
      document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(20);
    }
    return document.querySelector(`.sanity-pop ${selector}`);
  }

  async function pickAppearance(selector, value) {
    const sel = await openAppearance(selector);
    if (!sel) return false;
    // round78（3.1b₂ · 设-02）：密度 / 配色 / 图标三处换成**预览按钮组**（容器带旧类名）——
    // 查到的是容器而不是 select 时，点 `[data-value="…"]` 那颗，成功判据 = 它变成 `.on`。
    if (sel.tagName !== "SELECT" && sel.tagName !== "INPUT") {
      const btn = sel.querySelector(`[data-value="${value}"]`);
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(30);
      return btn.classList.contains("on");
    }
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(30);
    return sel.value === value;
  }

  async function toggleAppearance(selector, on) {
    const box = await openAppearance(selector);
    if (!box) return false;
    if (box.checked !== on) box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(30);
    return box.checked === on;
  }

  async function closeSettings() {
    document
      .querySelector(".sanity-pop .close")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(20);
  }

  /**
   * round78（3.1b₂ · 设-01）：设置面板现在是「**5 组 + 更多（默认折起）**」。
   * 需要折叠区里的控件时先把它打开（`which` = sanity / scheduler / achievements / data / features / guide / keys）；
   * 传 `undefined` = 只要面板开着（默认展开的四个组直接用）。
   */
  async function openSettingsSub(which) {
    if (!document.querySelector(".sanity-pop")) {
      document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(20);
    }
    const q = (sel) => document.querySelector(`.sanity-pop ${sel}`);
    const more = q(".more-toggle");
    if (more && more.getAttribute("aria-expanded") !== "true") {
      more.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(10);
    }
    if (which) {
      const btn = q(`.${which}-toggle`);
      if (btn && btn.getAttribute("aria-expanded") !== "true") {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
      }
    }
    return document.querySelector(".sanity-pop");
  }
  /**
   * round86（0.32.0 · ③）· 共用手势：在周六 03:00 造一个**独占一列**的 90 分钟「计划中」块。
   * 为什么要自己造：斜切角只挂「非并排 + 浮层 inline」的块，而全量跑时前面的断言可能把整周都塞满
   * （实测：逐时段试 6 个空位全被挤成并排）→ **把挡路的块临时收起来**（`__RESTORE` 里原样放回），
   * 这样判据不再依赖残留状态。返回造出来的那个元素。
   */
  async function seedSoloBlock(id = "r86solo") {
    const start = at(5, 3, 0); // 周六 03:00（假数据的常规块都在 06:00–19:00）
    const end = start + 5400; // 90 分钟 → 高 90px（高 ≥ 54 → 浮层落点 inline）
    const drop = () => {
      const i = FIX.blocks.findIndex((b) => b.id === id);
      if (i >= 0) FIX.blocks.splice(i, 1);
    };
    const jump = async (dir) => {
      document
        .querySelector(dir < 0 ? ".week-nav .now" : ".week-nav button[title^='下一周']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(dir < 0 ? 90 : 60);
    };
    const stash = [];
    for (let i = FIX.blocks.length - 1; i >= 0; i--) {
      const b = FIX.blocks[i];
      if (b.id === id) continue;
      if (b.start_at < end && b.end_at > start) {
        stash.push(b);
        FIX.blocks.splice(i, 1);
      }
    }
    drop();
    FIX.blocks.push(B(id, TEMP_TASK_ID, start, end, "elastic", "planned"));
    UNDO_SNAP = null;
    REDO_SNAP = null;
    window.__RESTORE = window.__RESTORE || [];
    window.__RESTORE.push(async () => {
      drop();
      FIX.blocks.push(...stash);
      await jump(1);
      await jump(-1);
    });
    await jump(1);
    await jump(-1);
    return document.querySelector(`[data-block-id="${id}"]`);
  }

  /**
   * round29：跨周**拉伸**的公共手势 —— 抓 `id` 的**下把手** → 甩出最右边缘停住（→ 翻到下一周）
   * → 把视野滚回 00:00，把指针放到**新一周周一列 02:45**（= 旧范围整段在上一周、拉过去之后的终点）。
   * 收尾由调用方决定（Esc = 取消 / pointerup = 落库）；返回 null = 连把手都没找到。
   */
  async function crossWeekStretch(id) {
    focusBlock(id);
    await settle();
    const handle = document.querySelector('[data-block-id="' + id + '"] .edge-bottom');
    if (!handle) return null;
    // 合成指针没有「活跃指针」→ 捕获会抛（产品自己 try/catch 兜住了，harness 顺手也兜一下）
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    const rb = handle.getBoundingClientRect();
    handle.dispatchEvent(ptrEvent("pointerdown", rb.left + 30, rb.bottom));
    // 甩出日列区右边 → 停住 ~0.6s → 翻周
    const sun = dayBody(6).getBoundingClientRect();
    window.dispatchEvent(ptrEvent("pointermove", sun.right + 40, sun.top + yAt(14, 0)));
    await settle();
    const before = lastWinFrom();
    await waitMs(900);
    const flipped = lastWinFrom() !== before;
    // 翻周后时间轴重建了 DOM；默认视野停在 06:00（凌晨看不见）→ 滚到 00:00 再把指针放到周一 02:45
    const scroller = document.querySelector(".scroll");
    scroller.scrollTop = 0;
    await frames(2);
    const mon = dayBody(0).getBoundingClientRect();
    const px = mon.left + 30;
    const py = mon.top + yAt(2, 45);
    window.dispatchEvent(ptrEvent("pointermove", px, py));
    await frames(3); // 拉伸期间每帧重算预览
    return { flipped, px, py };
  }

  /**
   * round69.1（#3/#4）：**找一周 + 一个「未来且空闲」的时段** —— 本周满了就往后翻（最多 +4 周）。
   * 为什么不能只扫本周：全套断言跑完时，本周可能已经被前面的检查填满（实测 450 块）——
   * 那种周里「加规则不生成」是**正常**的（冲突跳过），断言会误伤。
   */
  const gotoFreeWeekSlot = async () => {
    const t = FIX.tasks.find((x) => x.id === "t22");
    const est = t?.estimated_minutes ?? 0;
    const span = (est <= 0 ? 30 : Math.max(15, Math.ceil(est / 15) * 15)) * 60;
    const now = Math.floor(Date.now() / 1000);
    for (let off = 0; off <= 4; off++) {
      if (off > 0) await gotoWeek(off);
      for (let d = 6; d >= 0; d--) {
        for (let h = 23; h >= 0; h--) {
          const s = at(off * 7 + d, h, 0);
          if (off === 0 && s <= now + 600) continue;
          if (FIX.blocks.some((b) => b.start_at < s + span && b.end_at > s)) continue;
          return { d, h, off, at: s, span };
        }
      }
    }
    return null;
  };

  /**
   * round69.1：把时间轴**横向滚回最左**并把某块带进视野。
   * 为什么需要：715px 下前面的断言（如「拖到周六」）会把表横向滚走 ——
   * 后续按坐标算的落点就会落在视口外 → 手势被当成「点在板外」（本轮 ② 实测）。
   */
  const bringIntoView = async (id) => {
    const s = document.querySelector(".scroll");
    if (s) s.scrollLeft = 0;
    document.querySelector(`[data-block-id="${id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    await frames(2);
  };

  // ---- round31（C1.9）：键盘操作的小工具 ----
  const keydown = (key, opts = {}) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
  const blk = (id) => FIX.blocks.find((b) => b.id === id) ?? null;
  /** 时刻 → 周一 00:00 起算的分钟（断言里好写） */
  const minOf = (ts) => Math.round((ts - at(0, 0, 0)) / 60);
  /** 点一下块（真指针事件路径）→ 选中 */
  const selectByClick = async (id) => {
    const node = el(id);
    if (!node) return false;
    const r = node.getBoundingClientRect();
    node.dispatchEvent(ptrEvent("pointerdown", r.left + 20, r.top + r.height / 2));
    node.dispatchEvent(ptrEvent("pointerup", r.left + 20, r.top + r.height / 2));
    // 合成事件不会触发浏览器「点一下就把焦点给可聚焦元素」的默认行为 → 手动补上（真机上就是这一步）
    node.focus({ preventScroll: true });
    await settle();
    return node.classList.contains("selected");
  };
  const keyHintText = () => document.querySelector(".key-hint")?.textContent?.trim() ?? "";
  /** round77 收尾：头部高度（不变量断言用）—— 手势中途它一变，落点就偏一格 */
  const headHeight = () => {
    const n = document.querySelector(".timeline .head");
    return n ? Math.round(n.getBoundingClientRect().height * 10) / 10 : -1;
  };
  /** round77 收尾（边界 #12–#14）：把「还剩 X」文案反解成分钟数（天/小时/分三档都认） */
  const remainMinutesOf = (text) => {
    let m = text.match(/还剩\s*(\d+)\s*天(?:\s*(\d+)\s*小时)?/);
    if (m) return Number(m[1]) * 1440 + Number(m[2] ?? 0) * 60;
    m = text.match(/还剩\s*(\d+)\s*小时(?:\s*(\d+)\s*分)?/);
    if (m) return Number(m[1]) * 60 + Number(m[2] ?? 0);
    m = text.match(/还剩\s*(\d+)\s*分/);
    if (m) return Number(m[1]);
    return Number.NaN;
  };
  /**
   * round77 收尾：第二行边界断言的「今天清场再种块」—— 目标块必须不与其他块并排（narrow），
   * 断言「放不下 / 还剩」才能归因清楚。第一次调用把**今天所有块**暂存起来，跑完必须
   * `restoreSecondLine()` 原样放回（数据一行不删、只临时换场）。
   */
  const SL_IDS = ["r77sl1", "r77sl2", "r77sl3", "r77sl4", "r77sl5"];
  let slStash = null;
  const slDay = () => {
    const now = Math.floor(Date.now() / 1000);
    const dayStart = at(0, 0, 0) + Math.floor((now - at(0, 0, 0)) / 86400) * 86400;
    return { now, dayStart, dayEnd: dayStart + 86400 };
  };
  const dropSecondLineSeeds = () => {
    for (let i = FIX.blocks.length - 1; i >= 0; i--) {
      if (SL_IDS.includes(FIX.blocks[i].id)) FIX.blocks.splice(i, 1);
    }
  };
  const seedSecondLine = async (seeds) => {
    if (!slStash) {
      // 清场范围 = 今天 ± 1 天（跨天块的昨天/明天两段也要不并排，否则「其余段」没有第二行可验）
      const { dayStart, dayEnd } = slDay();
      slStash = [];
      for (let i = FIX.blocks.length - 1; i >= 0; i--) {
        const b = FIX.blocks[i];
        if (b.end_at > dayStart - 86400 && b.start_at < dayEnd + 86400) {
          slStash.push({ i, b });
          FIX.blocks.splice(i, 1);
        }
      }
    }
    dropSecondLineSeeds();
    FIX.blocks.push(...seeds);
    await gotoWeek(1);
    await gotoWeek(0);
    await settle(30);
  };
  const restoreSecondLine = async () => {
    dropSecondLineSeeds();
    if (slStash) {
      // 按**原下标**插回（新生成的块留在末尾）—— 后续断言里有按 `FIX.blocks` 顺序取块的，
      // 追加到末尾会把它们选到滚出视口的那一块上（实测 r60⑧ 假红）。
      slStash.sort((a, b) => a.i - b.i);
      for (const { i, b } of slStash) FIX.blocks.splice(Math.min(i, FIX.blocks.length), 0, b);
      slStash = null;
    }
    await gotoWeek(1);
    await gotoWeek(0);
    await settle(30);
  };

  /**
   * round78（3.1b₂ · Step 1）：本组断言要的靶子块必须**自己造**。
   * 为什么：前面的断言会删块/挪块（`b22`/`b20` 到全量跑时早就不在了 —— 实测本组第一版
   * 在全量跑里直接 `return false`、连 DIAG 都没打）。写法照 `seedSecondLine`：
   * 把本周的块先收进 stash、种两块自己的（周一/周二 09:00，全宽、在视口里、互不重叠），
   * 跑完按原下标插回。
   */
  // round79（6b 二轮 P1）：种子状态**挂到 `window`** —— 兜底在 `domChecks()` 之外的模块作用域里跑，
  // 那里看不见函数局部的 `r78Stash`（旧写法 `typeof r78Stash !== "undefined"` **恒假** → 兜底是死代码 ✗）。
  const r78 = (window.__R78 = window.__R78 || { stash: null, restore: null });
  const R78_IDS = ["r78a", "r78b"];
  const dropRound78Seeds = () => {
    for (let i = FIX.blocks.length - 1; i >= 0; i--) {
      if (R78_IDS.includes(FIX.blocks[i].id)) FIX.blocks.splice(i, 1);
    }
  };
  const seedRound78 = async () => {
    if (!r78.stash) {
      const ws = weekStartOf(0);
      const we = ws + 7 * 86400;
      r78.stash = [];
      for (let i = FIX.blocks.length - 1; i >= 0; i--) {
        const b = FIX.blocks[i];
        if (b.end_at > ws && b.start_at < we) {
          r78.stash.push({ i, b });
          FIX.blocks.splice(i, 1);
        }
      }
    }
    dropRound78Seeds();
    FIX.blocks.push(BT("r78a", at(0, 9, 0), at(0, 10, 0), "键位靶子"));
    FIX.blocks.push(BT("r78b", at(1, 9, 0), at(1, 10, 0), "槽位靶子"));
    await seedRound78IntoView();
  };
  /**
   * round82（Step 4 踩过的坑）：两个纪律，都是为了「种子真的进到界面、且旧快照作废」：
   *
   * ① **假库 undo/redo 快照要作废** —— 种子是绕过写入路径直接改 `FIX.blocks` 的；
   *    旧快照存活时，用例里任何一次 `Ctrl+Z` 会把「种之前」的整库搬回来（实测：78 块被搬回来一次
   *    → 库里出现重复 id → 渲染的 keyed each 撞 key → **页面崩、后面全线红**）。
   *    真后端不存在「库被外部改过」的情况（一切改动都过命令层）—— 这是**测试侧**的纪律。
   * ② **等种子真的上屏**（DOM 里只该有 r78a / r78b，连续两次取样都成立）—— 换周重拉是异步的，
   *    而迟到的旧 `list_blocks` 响应可能把种子覆盖掉；没上屏就按 S，`findSelected()` 找不到块、
   *    静默不写（实测就是一个真红的来源）。超时再换一周重试一次。
   */
  const seedRound78IntoView = async () => {
    const clearFakeHistory = () => {
      UNDO_SNAP = null;
      REDO_SNAP = null;
    };
    const snapIds = () =>
      [...document.querySelectorAll(".timeline [data-block-id]")].map((n) => n.dataset.blockId);
    const seeded = async (ms = 900) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const ids = snapIds();
        if (ids.length === 2 && ids.includes("r78a") && ids.includes("r78b")) {
          await frames(2);
          const again = snapIds();
          if (again.length === 2 && again.includes("r78a") && again.includes("r78b")) return true;
        }
        await settle(20);
      }
      return false;
    };
    clearFakeHistory();
    await gotoWeek(1);
    await gotoWeek(0);
    await settle(30);
    if (await seeded()) return;
    clearFakeHistory();
    await gotoWeek(1);
    await gotoWeek(0);
    await settle(30);
    await seeded();
  };
  const restoreRound78 = async () => {
    dropRound78Seeds();
    if (r78.stash) {
      r78.stash.sort((a, b) => a.i - b.i);
      for (const { i, b } of r78.stash) FIX.blocks.splice(Math.min(i, FIX.blocks.length), 0, b);
      r78.stash = null;
    }
    // 又直接改了库 → 旧快照同样作废（与 seed 同一套口径）
    UNDO_SNAP = null;
    REDO_SNAP = null;
    await gotoWeek(1);
    await gotoWeek(0);
    await settle(30);
  };
  r78.restore = restoreRound78; // 兜底要跨作用域调用它
  const gestureHintText = () => document.querySelector(".gesture-hint")?.textContent?.trim() ?? "";  const toastText = () => [...document.querySelectorAll(".toast")].map((n) => n.textContent).join("｜");
  const dayIndexOfDom = (id) => [...document.querySelectorAll(".day")].indexOf(el(id)?.closest(".day"));

  // ===== round45（0.8.1）：理智值的量尺（期望值一律**从假库现算**，不写死数字）=====
  const WEEK_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  /**
   * 假库里某一天的**并集**分钟（口径与 Rust `sanity::union_seconds` 一致）。
   * `weekStart` 不给 = 这一周；给了可以算别的周（翻周断言用）。
   */
  const dayUnionMinutes = (db, dayIndex, weekStart) => {
    const ws = weekStart ?? at(0, 0, 0);
    const ds = localDayStart(ws + dayIndex * 86400);
    const de = localDayStart(ws + (dayIndex + 1) * 86400);
    const spans = db.blocks
      .filter((b) => !b.sanity_exempt && b.start_at < de && b.end_at > ds)
      .map((b) => [Math.max(b.start_at, ds), Math.min(b.end_at, de)]);
    return unionMinutes(spans);
  };
  /** 分钟 → 产品的 `formatDuration` 口径（摘要里那两个值就是它渲染的；**独立复算**，不复用产品代码） */
  const durText = (m) =>
    m % 60 === 0
      ? `${Math.floor(m / 60)} 小时`
      : m < 60
        ? `${m} 分钟`
        : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  /** 分钟 → 差值徽标的紧凑写法（`1h30` / `30m`，与产品 `num()` 同口径） */
  const compactDur = (m) => {
    const h = Math.floor(Math.abs(m) / 60);
    const mm = Math.abs(m) % 60;
    return h === 0 ? `${mm}m` : mm === 0 ? `${h}h` : `${h}h${String(mm).padStart(2, "0")}`;
  };
  /** 第 i 天的小条百分比（没画小条 → -1；按「第几个列」取，不受有没有小条影响） */
  const dayBarPct = (dayIndex) => {
    const day = document.querySelectorAll(".day")[dayIndex];
    const bar = day?.querySelector(".day-head .load");
    const track = bar?.getBoundingClientRect().width ?? 0;
    return track > 0
      ? Math.round((bar.querySelector("i").getBoundingClientRect().width / track) * 100)
      : -1;
  };
  const dayBarTitle = (dayIndex) =>
    document.querySelectorAll(".day")[dayIndex]?.querySelector(".day-head .load")?.getAttribute("title") ??
    "";

  /**
   * round45：**独立**算一天的并集 —— 1440 分钟位图（与 fixture 的「排序合并」是两套算法）。
   * 用来交叉验证小条上的数字（同一个错不会两边一起犯）。
   */
  const bitmapDayMinutes = (db, dayIndex) => {
    const ds = at(dayIndex, 0, 0);
    const bits = new Array(1440).fill(false);
    for (const b of db.blocks) {
      if (b.sanity_exempt) continue;
      const from = Math.max(b.start_at, ds);
      const to = Math.min(b.end_at, ds + 86400);
      for (let t = from; t < to; t += 60) bits[Math.floor((t - ds) / 60)] = true;
      if (to > from) bits[Math.min(1439, Math.floor((to - ds - 1) / 60))] = true;
    }
    return bits.filter(Boolean).length;
  };
  /** 小条悬停文本里的「· N 块」；没有小条 → -1 */
  const dayBlocksCount = (dayIndex) => {
    const m = dayBarTitle(dayIndex).match(/· (\d+) 块/);
    return m ? Number(m[1]) : -1;
  };

  /**
   * round48：读 Backlog 一行的**任务名**。
   * 不能再用整行的 `textContent` —— 行首多了排序抓手 `⠿`（还有 ⊘/⚙/×），
   * 以前按整行 `startsWith("任务名")` 找行的写法会全部失效 ✗。
   */
  const rowLabel = (node) => node?.querySelector(".label")?.textContent?.trim() ?? "";

  /** round45：把 Backlog 里某条任务拖到某天某时刻（create_block 那条路径；用来造重叠块） */
  const dragTaskTo = async (titleStart, dayIndex, hour, minute) => {
    const item = [...document.querySelectorAll(".item")].find((n) =>
      rowLabel(n).startsWith(titleStart),
    );
    if (!item) return false;
    // round48：抓**任务名**那一带（行左缘是排序抓手 ⠿，抓那儿会变成排序手势 ✗）
    const r = item.querySelector(".label").getBoundingClientRect();
    firePointer("pointerdown", r.left + 8, r.top + r.height / 2);
    await settle();
    const p = dragToDay(dayIndex, hour, minute);
    await settle();
    firePointer("pointerup", p.x, p.y);
    await settle(40);
    return true;
  };
  /** 按一下键 + 等假 IPC/重渲染跑完（写法与现有断言一致：settle 微任务，不用 setTimeout 等） */
  const press = async (key, opts = {}) => {
    keydown(key, opts);
    await settle(30);
  };
  /** round38：打开某条任务的任务面板（**已开着就不点**，否则又把它关掉） */
  const openPropsOf = async (titleStart) => {
    const row = [...document.querySelectorAll(".item")].find((node) =>
      rowLabel(node).startsWith(titleStart),
    );
    if (!row) return null;
    if (!row.querySelector(".props")) {
      row
        .querySelector(".props-toggle")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    }
    return row;
  };

    // ===== round38/39/40：任务面板（分类 + 归档恢复）=====
    // round40（0.7.2）：分类控件第三次改 —— `datalist`（像自动填充的黑框）→ `<select>`（不能打字、数量没处放）
    // → **自建的可创建下拉**（输入框 + 跟着过滤的列表 + 灰字数量 + 回车新建），见 CategoryPicker.svelte。
    const openCat = async (titleStart) => {
      const row = await openPropsOf(titleStart);
      if (!row) return null;
      const field = row.querySelector(".props input.cat-input");
      if (!field) return null;
      const r = field.getBoundingClientRect();
      field.dispatchEvent(ptrEvent("pointerdown", r.left + 8, r.top + r.height / 2));
      await settle();
      return { row, field };
    };
    const catRows = () =>
      [...document.querySelectorAll(".cat-pop .row")].map((n) => ({
        text: n.textContent.replace(/\s+/g, " ").trim(),
        name: n.querySelector(".nm")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        count: n.querySelector(".ct")?.textContent?.trim() ?? "",
      }));
    const typeCat = async (field, text) => {
      field.value = text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    };
    const enterCat = async (field) => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await settle(20);
    };
    /** round70：把分类框「准备好」—— 归位（收面板 / 回全部 / 展开分组）后挑一条**标题唯一**的未归档任务，
     *  打开它的 ⚙ 与分类列表。返回 null = 一条都没挑到（harness 问题，不是产品问题）。 */
    const prepareCatPicker = async () => {
      await press("Escape"); // 收面板 / 选中（前面可能留着）
      document
        .querySelector(".only button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 有筛选就回「全部」
      document
        .querySelectorAll(".ghead-btn[aria-expanded='false']")
        .forEach((b) => b.dispatchEvent(new MouseEvent("click", { bubbles: true }))); // 收起的分组展开
      await settle(30);
      const cands = FIX.tasks
        .filter((x) => x.archived_at == null && x.id !== "ww-temp-hidden-task")
        .filter((x) => FIX.tasks.filter((y) => y.title === x.title).length === 1);
      for (const c of cands.slice(0, 6)) {
        const b = await openCat(c.title);
        if (!b) continue;
        if (rowLabel(b.row) === c.title) return { box: b, task: c };
      }
      return null;
    };

    // ---- round47（8.1 分类管理）的小工具 ----
    /** 头部的分类菜单按钮（`[分类 ▾]`）；已归档那一栏也有一个 → 靠容器区分 */
    const catBtnEl = (scope = ".tools") => document.querySelector(scope + " .cat-btn");
    /** 读当前弹层的行（名字 / 数量 / 元素）——**已经开着就直接读**，不再点一下（不然反而把它关掉） */
    const catMenuRows = () =>
      [...document.querySelectorAll(".cat-menu .row")].map((n) => ({
        text: n.textContent.replace(/\s+/g, " ").trim(),
        name: n.querySelector(".nm")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        count: n.querySelector(".ct")?.textContent?.trim() ?? "",
        el: n,
      }));
    const openCatMenu = async (scope = ".tools") => {
      const btn = catBtnEl(scope);
      if (!btn) return null;
      const existing = catMenuRows();
      if (existing.length) return existing;
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(20);
      return catMenuRows();
    };
    /** 点外部把弹层收起来（点 body：窗口上的捕获监听会当成“点外面”） */
    const closeCatMenu = async () => {
      document.body.dispatchEvent(ptrEvent("pointerdown", 4, 4));
      await settle(20);
    };
    /** 走真指针路径点一行（与别的断言一致：用 `ptrEvent`） */
    const tapRow = async (row) => {
      if (!row) return false;
      const r = row.el.getBoundingClientRect();
      row.el.dispatchEvent(ptrEvent("pointerdown", r.left + 6, r.top + r.height / 2));
      await settle(20);
      return true;
    };
    /** 主列表里显示的任务名（按 DOM 顺序；改名中的行是 input，不算） */
    const shownTitles = () =>
      [...document.querySelectorAll(".list .item .label")].map((n) => n.textContent.trim());
    /** 假库里某分类下的**未归档**任务名（主列表的口径；隐藏任务不算） */
    const dbTitlesOf = (cat) =>
      FIX.tasks
        .filter((t) => t.archived_at == null && t.id !== "ww-temp-hidden-task")
        .filter((t) => (t.category ?? "") === cat)
        .map((t) => t.title);
    /** 假库里某分类下的**全部**任务条数（管理页/改名提示的口径：含已归档） */
    const dbCountOf = (cat) =>
      FIX.tasks.filter((t) => t.id !== "ww-temp-hidden-task" && (t.category ?? "") === cat)
        .length;
    /** 顶上那句「只看：X」 */
    const onlyText = () => document.querySelector(".only")?.textContent?.replace(/\s+/g, "") ?? "";
    /**
     * 在管理页里把分类 `from` 改成 `to`（开菜单 → 管理工作… → 点 ✎ → 打字 → 回车）。
     * 返回保存前的提示语 + 写库参数 + 保存后界面上的现场（改完顺手把弹层收掉）。
     */
    const renameCat = async (from, to) => {
      const rows = await openCatMenu();
      if (!rows?.length) return null;
      await tapRow(rows[rows.length - 1]); // 最后一行 = 「✎ 管理工作…」
      const row = [...document.querySelectorAll(".cat-menu .mrow")].find(
        (n) => n.querySelector(".mname")?.textContent?.trim() === from,
      );
      const btn = row?.querySelector(".mbtn");
      if (!btn) return null;
      const rb = btn.getBoundingClientRect();
      btn.dispatchEvent(ptrEvent("pointerdown", rb.left + 6, rb.top + rb.height / 2));
      await settle(20);
      const input = document.querySelector(".cat-menu .minput");
      if (!input) return null;
      input.value = to;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(20);
      const hint = document.querySelector(".cat-menu .hint")?.textContent?.trim() ?? "";
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await settle(40);
      await closeCatMenu();
      return { hint, wrote: window.__LAST_CAT };
    };
    /** 展开「已归档」那一栏（已经展开就不动它） */
    const openArchived = async () => {
      const toggle = document.querySelector(".arch-toggle");
      if (!toggle) return null;
      if (!toggle.textContent.includes("▾")) {
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
      }
      return toggle;
    };
  // ---- round52（C7 复盘）的小工具 ----
  /** 种数据集（幂等）：旧断言对 Backlog 条数敏感 → 放到第一条 round52 断言里种（见 fixture.js 注释） */
  const seedR52 = () => window.__SEED_ROUND52?.();
  /** 点**真的**跳周按钮（**绝对定位**：先回本周，再点 N 次）—— 断言之间不用关心上一个停在哪周 */
  async function gotoWeek(offset) {
    document
      .querySelector(".week-nav .now")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(20);
    const dir = offset < 0 ? 0 : 1;
    for (let i = 0; i < Math.abs(offset); i++) {
      document
        .querySelectorAll(".week-nav button")
        [dir]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(8);
    }
    await settle(30);
  }
  const mosaicCalls = () => window.__MOSAIC_DBG || [];
  /** 某一周（相对本周 N 周）的本地周一 00:00 */
  const weekStartOf = (offset) => at(offset * 7, 0, 0);
  /** 某一周在假库里的块（区间相交，排掉预览专用的 bphantom）—— 独立复算用 */
  const weekBlocksOf = (offset) => {
    const ws = weekStartOf(offset);
    const we = at(offset * 7 + 7, 0, 0);
    return FIX.blocks.filter((b) => b.id !== "bphantom" && b.start_at < we && b.end_at > ws);
  };
  /** 独立复算结局（**不调 fixture 里那份** —— 两套实现对照才是交叉验证） */
  const stateOfBlock = (b) => {
    if (b.status === "done") {
      if (b.final_status === "done_overtime") return "done_overtime";
      if (b.final_status === "done_short") return "done_short";
      return "done";
    }
    if (b.status === "missed") return "missed";
    return b.end_at <= nowSec ? "unused" : "planned";
  };
  const panel = () => document.querySelector(".review-panel");
  /** round63（C18）：设置弹层分区后，按**行的文字**找复选框（不再依赖 DOM 顺序 —— 旧断言用 boxes[i]，加一个就错位） */
  const settingBox = (labelText) => {
    const want = labelText.replace(/\s+/g, "");
    const row = [...document.querySelectorAll(".sanity-pop .row")].find((n) =>
      (n.textContent ?? "").replace(/\s+/g, "").includes(want),
    );
    return row?.querySelector('input[type="checkbox"]') ?? null;
  };
  /**
   * round83（§8.1）：按文字开/关一个**功能开关**（走设置弹层的「更多 → 功能开关」区）。
   * 返回 true = 找到那一行、且状态已经是 `on`（找不到 / 点不动 = false）。
   */
  const setFeatureViaGear = async (labelText, on) => {
    await openSettingsSub("features");
    if (!document.querySelector(".feature-row")) {
      document
        .querySelector(".sanity-pop .features-toggle")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(20);
    }
    const box = settingBox(labelText);
    let ok = false;
    if (box) {
      if (box.checked !== on) {
        box.click();
        await settle(60);
      }
      ok = box.checked === on;
    }
    document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(30);
    return ok;
  };
  const openReview = async () => {
    document
      .querySelector(".review-open")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(40);
    return !!panel();
  };
  const panelClosed = () => !panel();
  const mosaicRows = () => [...(panel()?.querySelectorAll(".mosaic .row") ?? [])];
  const mosaicTiles = (scope) => [
    ...((scope ?? panel())?.querySelectorAll(".mosaic .tile") ?? []),
  ];
  const tileState = (el) => el.getAttribute("data-state") ?? "";
  const tileIds = (scope) => mosaicTiles(scope).map((el) => el.getAttribute("data-block-id") ?? "");
  const blockById = (id) => FIX.blocks.find((b) => b.id === id) ?? null;
  const taskById = (id) => FIX.tasks.find((t) => t.id === id) ?? null;
  const categoryOfBlock = (b) => taskById(b.task_id)?.category ?? null;
  const detailRows = () => [...(panel()?.querySelectorAll(".detail [data-block-id]") ?? [])];
  const rowText = (el) => el.textContent.replace(/\s+/g, " ").trim();
  /** 确保面板处于某种视图（状态 / 类别）—— 断言之间会串状态，用前先归一 */
  const ensureMode = async (mode) => {
    if (!panel()) return false;
    const btn = panel().querySelector(`.mode button[data-mode="${mode}"]`);
    if (!btn) return false;
    if (btn.getAttribute("aria-pressed") !== "true") {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(20);
    }
    return true;
  };
  /**
   * 确保对比基线处于「关 / 第 N 周前」。
   * round63（C18）起是显式选择器；**round63.1** 改成 ‹ › 逐周步进（任意周）——
   * 这里先归零再点 ‹ 到目标周（确定、不依赖当前状态）。
   */
  const ensureCompare = async (on, weeks = 1) => {
    if (!panel()) return false;
    const cur = () =>
      Number(panel()?.querySelector("[data-baseline]")?.getAttribute("data-baseline") ?? 0);
    if (cur() > 0) {
      panel()
        ?.querySelector(".compare-off")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(40);
    }
    if (!on) return true;
    panel()
      ?.querySelector(".compare-on")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(40);
    let guard = 0;
    while (cur() < weeks && guard++ < 80) {
      panel()
        ?.querySelector(".compare-prev")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(20);
    }
    await settle(40);
    return cur() === weeks;
  };
  /** 事实小图某一行（rearranged / skipped）的每日计数（`data-count`；取不到 → []） */
  const factCounts = (kind) =>
    [...(panel()?.querySelectorAll(`.facts .row[data-kind="${kind}"] .bar`) ?? [])].map((n) =>
      Number(n.getAttribute("data-count") ?? -1),
    );
  /** 曲线每天的分钟（`data-minutes`）—— 与 `dayUnionMinutes` 对照 */
  const curveMinutes = () =>
    [...(panel()?.querySelectorAll(".curve .bar") ?? [])].map((n) =>
      Number(n.getAttribute("data-minutes") ?? -1),
    );
  /** 关掉可能开着的复盘面板（收尾用；已经关了就不动） */
  const shutReview = async () => {
    if (panel()) await press("Escape");
    await settle(20);
  };
  /** C7：触发一次应用的提醒检查（它听 window 的 `focus` —— 从托盘回来就是这个事件） */
  const checkNudgeViaFocus = async () => {
    window.dispatchEvent(new Event("focus"));
    await settle(40);
  };
  /** round57：在 ⚙ 弹层里改「复盘到点」（三选一 action / 星期 / 时间）—— 走的是真控件与真写库 */
  const setRemindViaGear = async (action, day, time) => {
    if (!document.querySelector(".sanity-pop")) {
      document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(10);
    }
    const act = document.querySelector(".sanity-pop .remind-action");
    const sel = document.querySelector(".sanity-pop .remind-day");
    const inp = document.querySelector(".sanity-pop .remind-time");
    if (!act || !sel || !inp) return false;
    if (act.value !== action) {
      act.value = action;
      act.dispatchEvent(new Event("change", { bubbles: true }));
      await settle(30);
    }
    if (sel.value !== day) {
      sel.value = day;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await settle(30);
    }
    if (inp.value !== time) {
      inp.value = time;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      await settle(30);
    }
    document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(10);
    return true;
  };

  // ---- round58（0.13.1 总览常驻行）的小工具 ----
  /** 总览顶部那一行结局计数（`data-counts`） */
  const panelCounts = () => rowText(panel()?.querySelector("[data-counts]") ?? { textContent: "" });
  /** 完成率（`data-rate`） */
  const panelRate = () => rowText(panel()?.querySelector("[data-rate]") ?? { textContent: "" });
  /** 「往期」里某一周的 chip */
  const pastChip = (weekStart) => panel()?.querySelector(`.chip[data-week="${weekStart}"]`) ?? null;
  /** 面板顶部那行周区间的规范写法（与 `formatWeekRange` 同格式）—— round81 起默认 `date_format=system`（zh-CN = `2026/10/5`） */
  const rangeOf = (from) => {
    const f = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    return `${f(new Date(from * 1000))} ~ ${f(new Date((from + 6 * 86400) * 1000))}`;
  };

  // ---- round60（10.1 统计页）的小工具 ----
  const statsPanel = () => document.querySelector(".stats-panel");
  /**
   * round83（§8.1）：统计入口的口径是**功能开关** ——
   * `review_enabled` 关时顶栏有独立 `.stats-open`；开着时入口只在总览面板里（统计是它的**子层**）。
   * 这条工具按当前形态点**真入口**（测试要走的永远是用户真能走的路）。
   */
  const clickStatsEntry = async () => {
    const bar = document.querySelector(".head-actions .stats-open");
    if (bar) {
      bar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(40);
      return true;
    }
    if (!panel()) await openReview();
    const inReview = document.querySelector(".review-panel .stats-open");
    inReview?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(40);
    return !!inReview;
  };
  /** 打开统计面板（先把可能开着的总览关掉 —— 它的遮罩会抢事件） */
  const openStatsPanel = async () => {
    await shutReview();
    await clickStatsEntry();
    return !!statsPanel();
  };
  const shutStats = async () => {
    // 用 ✕ 关（不用 Escape —— 收尾不该顺带改变选中态；Esc 的真路径由 ⑦ 专测）
    statsPanel()?.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(20);
    // round83（§8.1）：统计可能是**总览的子层**开的 —— 收尾把总览也关掉，恢复「没有面板」
    await shutReview();
  };
  /**
   * 真键盘的派发路径：目标是 `body`（window 的 capture 监听先于 bubble）。
   * 为什么需要它：`press()` 把键直接派发在 **window** 上 —— 在目标阶段，capture/bubble 按
   * **注册顺序** 跑（Timeline 先挂，先清选中）；真按键 target 是 body，面板的 capture 监听
   * 先到并 `stopPropagation` → 全局键处理收不到。测「面板 Esc 不连累选中」必须用这条真路径。
   */
  const pressOnBody = async (key) => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    await settle(30);
  };
  /** 统计面板里某一行（`dt` 以 label 开头）的取值文本；取不到 → "" */
  const statsRow = (label) => {
    for (const row of statsPanel()?.querySelectorAll(".row") ?? []) {
      const dt = row.querySelector("dt");
      if (dt && rowText(dt).startsWith(label)) {
        return rowText(row.querySelector("dd") ?? { textContent: "" });
      }
    }
    return "";
  };

  // ---- round61（10.2 多选与批量操作）：小工具 ----
  /** 种靶子块 → 翻去下一周再回来（强制一次真重拉，让新块进 store） */
  const seedR61 = async () => {
    window.__SEED_ROUND61?.();
    await gotoWeek(1);
    await gotoWeek(0);
  };
  /** 当前选中的块 id（去重：跨天块有两段 DOM） */
  const selectedIds = () => [
    ...new Set(
      [...document.querySelectorAll(".block.selected")].map((n) => n.getAttribute("data-block-id")),
    ),
  ];
  /** 动作条上的按钮（按可见文案精确找 —— "完成" 是 "未完成" 的子串，不能用 includes） */
  const barBtn = (text) =>
    [...document.querySelectorAll(".bulk-bar button")].find((b) => b.textContent.trim() === text) ?? null;
  /**
   * round77（3.1b）：如果橙条（预算超载）正占着那唯一一条提示位，先把它关掉 ——
   * 新的优先级规则是**同屏最多一条：橙 > 绿 > 渐进**（布局重审 L03），
   * 所以「绿条 / 渐进提示」那几条断言要先让位。返回是否点到了关闭钮。
   */
  const dismissOverloadBar = async () => {
    // 轮询：数据是异步来的，橙条可能「还没渲染」→ 一次点不到就白等
    for (let i = 0; i < 15; i++) {
      const btn = document.querySelector(".sanity .sanity-dismiss");
      if (btn) {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        if (!document.querySelector(".sanity")) return true;
      }
      await settle(20);
    }
    return !document.querySelector(".sanity");
  };

  /**
   * round77（3.1b）：绿条（复盘提醒 / 模板建议 / 渐进提示）也占那唯一一条提示位 ——
   * 需要让位时把它也收掉（点它的 ✕ 或「知道了」）。
   */
  const dismissNudgeIfAny = async () => {
    const btn =
      document.querySelector(".nudge .close") ??
      document.querySelector('.guide-bar [data-guide="hint"] .dismiss');
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(20);
    return true;
  };

  /** 点动作条按钮 + 等重拉 */
  const clickBar = async (text) => {
    const btn = barBtn(text);
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(40);
    return !!btn;
  };
  /** Ctrl / Shift + 左键点块（合成指针，带修饰键） */
  const modClick = async (id, mods) => {
    const node = el(id);
    if (!node) return false;
    const r = node.getBoundingClientRect();
    node.dispatchEvent(ptrEvent("pointerdown", r.left + 20, r.top + r.height / 2, mods));
    node.dispatchEvent(ptrEvent("pointerup", r.left + 20, r.top + r.height / 2, mods));
    await settle();
    return true;
  };
  const ctrlClick = (id) => modClick(id, { ctrlKey: true });
  const shiftClick = (id) => modClick(id, { shiftKey: true });
  /** 清掉当前选中（Esc 两次 = 多选→单选→清空；再点一下空白兜底） */
  const clearSel = async () => {
    await press("Escape");
    await press("Escape");
    const db = dayBody(0);
    db.dispatchEvent(ptrEvent("pointerdown", 0, 0));
    db.dispatchEvent(ptrEvent("pointerup", 0, 0));
    await settle();
  };

  return [
    // ===== round38：Esc = 键盘版「点一下别处」（面板 / 接链 / 选中 / 焦点一起放掉）=====

    [

      "round38 ①：点块 → 点 ⛓ → Esc：线头没了、块也不选中、焦点也放掉（0.6.52 只清了线头）",

      async () => {

        await backToThisWeek();

        await selectByClick("b53");

        const linkBtn = document.querySelector('[data-block-id="b53"] .actions button.link');

        if (!linkBtn) return false;

        const r = linkBtn.getBoundingClientRect();

        linkBtn.dispatchEvent(ptrEvent("pointerdown", r.left + 2, r.top + 2));

        linkBtn.dispatchEvent(ptrEvent("pointerup", r.left + 2, r.top + 2));

        linkBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        linkBtn.focus({ preventScroll: true }); // 真机点击会聚焦（合成事件不会）

        await settle();

        const linking = !!document.querySelector(".link-hint");

        const wasSelected = el("b53")?.classList.contains("selected") ?? false;

        const wasFocused = document.activeElement === linkBtn;

        await press("Escape");

        const linkGone = !document.querySelector(".link-hint");

        const cleared = !document.querySelector(".block.selected");

        const dropped = document.activeElement !== linkBtn;

        window.__DIAG.push(

          `r38① 接链中=${linking} 块选中=${wasSelected} 按钮聚焦=${wasFocused} 线头没=${linkGone} 选中清=${cleared} 焦点放=${dropped}`,

        );

        return linking && wasSelected && wasFocused && linkGone && cleared && dropped;

      },

    ],

    [

      "round38 ②：焦点在块内按钮（Tab 到 ✓）上按 Esc：也要全清（以前被 onButton 守卫挡掉、什么都不做）",

      async () => {

        await backToThisWeek();

        await selectByClick("b53");

        const doneBtn = document.querySelector('[data-block-id="b53"] .actions button[title="标记完成"]');

        if (!doneBtn) return false;

        doneBtn.focus({ preventScroll: true }); // 只聚焦，**不点**（点了就标记完成了）

        await settle();

        const stillSelected = el("b53")?.classList.contains("selected") ?? false;

        const onButton = document.activeElement === doneBtn;

        await press("Escape");

        const cleared = !document.querySelector(".block.selected");

        const dropped = document.activeElement !== doneBtn;

        const statusKept = blk("b53")?.status === "planned"; // 别把「按 Esc」当成「按了 ✓」

        window.__DIAG.push(

          `r38② 块内按钮聚焦=${onButton} 选中还在=${stillSelected} 选中清=${cleared} 焦点放=${dropped} 状态没变=${statusKept}`,

        );

        return stillSelected && onButton && cleared && dropped && statusKept;

      },

    ],

    [

      "round38 ③：没选中块、焦点在顶部按钮（‹）上按 Esc：也要放掉焦点",

      async () => {

        await backToThisWeek();

        await selectByClick("b53");

        await press("Escape"); // 先确认已经什么都没选（这一步 0.6.52 就能做到）

        const nav = document.querySelector(".week-nav button");

        if (!nav) return false;

        nav.focus({ preventScroll: true });

        await settle();

        const noSelection = !document.querySelector(".block.selected");

        const navFocused = document.activeElement === nav;

        await press("Escape");

        const dropped = document.activeElement !== nav;

        window.__DIAG.push(`r38③ 无选中=${noSelection} 导航按钮聚焦=${navFocused} 焦点放=${dropped}`);

        return noSelection && navFocused && dropped;

      },

    ],

    [

      "round38 ④（B 案回归）：拿起中第一次 Esc 只放弃拿起、**保持选中**；第二次才全清",

      async () => {

        await backToThisWeek();

        await selectByClick("b53");

        await press("Enter"); // 抓起

        // 拿起中提示走 `.gesture-hint`（预览占着那一行，key-hint 让位）—— 两者取其一

        // round54（BU）：拿起中**不再让位** —— 手势行与键位栏**同时存在**（旧代码二选一），
        // 所以这里把两者拼起来看（这条断言的本意不变：能看见「拿起中」）
        const hint = () => gestureHintText() + keyHintText();

        const grabbedHint = hint().includes("拿起中");

        await press("Escape");

        const keptSelected = el("b53")?.classList.contains("selected") ?? false;

        const grabOff = !hint().includes("拿起中");

        await press("Escape");

        const cleared = !document.querySelector(".block.selected");

        const dropped = document.activeElement !== el("b53");

        window.__DIAG.push(

          `r38④ 拿起中提示=${grabbedHint} 第一次后仍选中=${keptSelected} 拿起已放=${grabOff} 第二次全清=${cleared} 焦点放=${dropped}`,

        );

        return grabbedHint && keptSelected && grabOff && cleared && dropped;

      },

    ],

    [

      "round38 ⑤：漂流卡开着时 Esc = 收起卡片 + 选中/焦点一起放（点 ↻ 开卡片，不写库）",

      async () => {

        await backToThisWeek();

        await selectByClick("b6"); // 残影（missed）的「↻ 重新安排」= 同一张漂流卡

        const again = document.querySelector('[data-block-id="b6"] .actions button');

        if (!again) return false;

        again.focus({ preventScroll: true });

        again.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        await settle(20);

        const card = !!document.querySelector(".drift");

        await press("Escape");

        const closed = !document.querySelector(".drift");

        const cleared = !document.querySelector(".block.selected");

        const dropped = document.activeElement !== again;

        window.__DIAG.push(`r38⑤ 卡片开=${card} 卡片关=${closed} 选中清=${cleared} 焦点放=${dropped}`);

        // 清理：万一这条是红的（卡片还开着），别影响后面的断言与截图

        document

          .querySelector(".drift .dismiss")

          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        await settle();

        return card && closed && cleared && dropped;

      },

    ],

    [

      "round38 ⑥：⚙ 属性面板里（焦点在「预估」框）按 Esc = 收起面板 + 放掉焦点",

      async () => {

        const gear = document.querySelector(

          ".item button.props-toggle",

        );

        if (!gear) return false;

        gear.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        await settle();

        const field = document.querySelector(".props input.num");

        if (!field) return false;

        field.focus({ preventScroll: true });

        await settle();

        const opened = !!document.querySelector(".props");

        const fieldFocused = document.activeElement === field;

        await press("Escape");

        const closed = !document.querySelector(".props");

        const dropped = document.activeElement !== field;

        window.__DIAG.push(

          `r38⑥ 面板开=${opened} 框聚焦=${fieldFocused} 面板关=${closed} 焦点放=${dropped}`,

        );

        // 清理：万一这条是红的（面板还开着），收起来不影响后面

        if (document.querySelector(".props")) {

          gear.dispatchEvent(new MouseEvent("click", { bubbles: true }));

          await settle();

        }

        return opened && fieldFocused && closed && dropped;

      },

    ],

    ["遗留 suggested 块按弹性层渲染", () => el("b9")?.classList.contains("layer-elastic")],
    ["必填块带 layer-required", () => el("b7")?.classList.contains("layer-required")],
    // round76（3.1a）：格高改由密度驱动（舒适 30px）—— 断言改成算出来的，不再写死像素
    ["90 分钟的块高度 ≈ 3 格（减内缩 2px）", () => Math.abs(h("b2") - (3 * slotH() - 2)) < 2],
    ["30 分钟的块高度 = 1 格（减内缩 2px）", () => Math.abs(h("b1") - (slotH() - 2)) < 2],
    ["重叠的两块各占约半宽", () => w("b3") > 0 && w("b3") < w("b1") * 0.7],
    ["任务名没被图标挤没", () => (el("b1")?.textContent ?? "").includes("写周报")],
    ["双击块 = 标记完成（0.6.21）", () => el("b1")?.classList.contains("done")],
    ["色条上的双击不算完成", () => !el("b3")?.classList.contains("done")],
    [
      "C1.3：高块显示起止时间（b2 应为 10:00–11:30）",
      () => (el("b2")?.querySelector(".time")?.textContent ?? "").trim() === "10:00–11:30",
    ],
    ["C1.3：并排窄块不显示时间（不截断）", () => !el("b3")?.querySelector(".time")],
    ["C1.3：有跳周按钮", () => !!document.querySelector(".week-nav button")],
    ["C1.3：在本周时不显示「回到本周」", () => !document.querySelector(".week-nav .now")],
    [
      "C1.6：没有跨周成员时不显示「周界续接」提示",
      () => !document.querySelector(".cross-week"),
    ],
    [
      "C1.6：跳到下一周能看到那一周的块（bphantom）",
      async () => {
        const nav = document.querySelector(".week-nav");
        const next = nav.querySelectorAll("button")[1];
        next.click();
        await new Promise((r) => setTimeout(r, 200));
        return !!el("bphantom");
      },
    ],
    [
      "C1.6：从下一周跳回上一周，原来的块还在（用户报的「什么都看不到」）",
      async () => {
        const nav = document.querySelector(".week-nav");
        const prev = nav.querySelectorAll("button")[0];
        prev.click();
        await new Promise((r) => setTimeout(r, 200));
        return !!el("b1") && !!el("b2");
      },
    ],
    [
      "C1.2：同一任务的块没有重复渲染（融合/upsert 的回归）",
      () => {
        const ids = [...document.querySelectorAll("[data-block-id]")].map((el) =>
          el.getAttribute("data-block-id"),
        );
        return new Set(ids).size === ids.length;
      },
    ],
    // ===== 0.6.38 的机器证据（之前的修复只有人眼看截图，没有可断言的证据）=====
    [
      "0.6.38：连点两次「›」后，必须出现「只在两周后」的那一块（b11）",
      async () => {
        const next = document.querySelector(".week-nav").querySelectorAll("button")[1];
        next.click();
        await settle(20);
        next.click();
        await settle(20);
        return !!el("b11") && !el("b1");
      },
    ],
    [
      "0.6.38：再连点两次「‹」回到本周，本周的块还在（b11 不该混进来）",
      async () => {
        const prev = document.querySelector(".week-nav").querySelectorAll("button")[0];
        prev.click();
        await settle(20);
        prev.click();
        await settle(20);
        return !!el("b1") && !!el("b2") && !el("b11");
      },
    ],
    // ===== C1.7 手势对齐辅助线（用户：「我在周六排任务，就不知道对不对得齐，因为离得太远」）=====
    [
      "C1.7：拖动中画出两条辅助线（起点线 + 终点线）",
      async () => {
        dragStartBlock("b2"); // 90 分钟的块（10:00–11:30）
        dragToDay(5, 13, 0); // 拖到周六 13:00
        await settle();
        return alignLines().length === 2;
      },
    ],
    [
      "C1.7：两个刻度胶囊 = 落点 13:00 与终点 14:30（= 落点 + 该块 90 分钟）",
      async () => alignLabels().join(",") === "13:00,14:30",
    ],
    [
      "C1.7：两条线的间距 = 块时长（90 分钟 = 3 格）",
      async () => {
        const tops = alignLines().map((n) => n.getBoundingClientRect().top);
        return tops.length === 2 && Math.abs(Math.abs(tops[1] - tops[0]) - 3 * slotH()) < 2;
      },
    ],
    [
      "C1.7：线从刻度区右边缘拉到「鼠标所在那一列」的右边缘",
      async () => {
        const gut = document.querySelector(".gutter").getBoundingClientRect();
        const col = dayBody(5).getBoundingClientRect();
        const line = alignLines()[0].getBoundingClientRect();
        return Math.abs(line.left - gut.right) <= 1.5 && Math.abs(line.right - col.right) <= 1.5;
      },
    ],
    [
      "C1.7：指针跳过两列之间的 8px 缝时辅助线不断（round25 起只是普通的跨列移动）",
      async () => {
        dragToDay(6, 13, 0); // 从周六滑到周日
        dragToDay(4, 13, 0); // 再滑回周五
        await settle();
        return alignLines().length === 2;
      },
    ],
    [
      "C1.7：拖到 23:30 的长块 → 本列列底有一条线，胶囊里的时刻是真的（次日，b2 是 90 分钟）",
      async () => {
        tallViewport(); // 深夜坐标必然在正常视口的边缘带里 → 拉高视口让自动滚动不插手
        await settle();
        dragToDay(5, 23, 30);
        await settle();
        const tops = alignLines().map((n) => n.getBoundingClientRect().top);
        const bottom = dayBody(5).getBoundingClientRect().bottom;
        const ok =
          alignLabels().join(",") === "23:30,次日01:00" && tops.some((t) => t >= bottom - 2);
        dragReleaseOutside();
        await settle();
        restoreViewport();
        setScrollHome();
        await settle();
        return ok;
      },
    ],
    [
      "round25②：松在板子外（Backlog）→ 辅助线消失、块**原地不动**",
      async () => {
        setScrollHome();
        await settle();
        const before = document.querySelector('[data-block-id="b2"]').getBoundingClientRect().top;
        dragStartBlock("b2");
        dragToDay(5, 15, 0); // 先拖到周六（真的会落下去的位置）
        await settle();
        dragReleaseOutside();
        await settle();
        const box = document.querySelector('[data-block-id="b2"]');
        return (
          alignLines().length === 0 &&
          alignLabels().length === 0 &&
          !!box &&
          Math.abs(box.getBoundingClientRect().top - before) <= 1
        );
      },
    ],
    [
      "C1.7：从 Backlog 拖任务进来也画辅助线，时长按 30 分钟（15:00 / 15:30）",
      async () => {
        if (!dragStartTask()) return false;
        dragToDay(3, 15, 0);
        await settle();
        const ok = alignLabels().join(",") === "15:00,15:30";
        dragReleaseOutside();
        await settle();
        return ok;
      },
    ],
    [
      "C1.7：拉伸下边缘 → 两条线跟着预览值走，两个胶囊都在（10:00 / 12:00）",
      async () => {
        const handle = document.querySelector('[data-block-id="b2"] .edge-bottom');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const rect = handle.getBoundingClientRect();
        const x = rect.left + 30;
        handle.dispatchEvent(ptrEvent("pointerdown", x, rect.bottom));
        handle.dispatchEvent(ptrEvent("pointermove", x, rect.bottom + slotH())); // +1 格 = +30 分钟
        await settle();
        const lines = alignLines().length;
        const labels = alignLabels().join(",");
        handle.dispatchEvent(ptrEvent("pointerup", x, rect.bottom + slotH()));
        // round69：落库后的 reloadWeek 现在多了一次 IPC 往返（每周重复生成）——
        // 等它真的跑完再进下一条（下一条量的是同一块的上边缘；不等的话它的预览会被晚到的整周重拉清掉）
        await frames(2);
        await settle(20);
        window.__DIAG.push(
          "resize-bottom lines=" + lines + " labels=" + labels + " scroll=" + Math.round(document.querySelector(".scroll").scrollTop) + " b2top=" + Math.round(topInDay("b2", 0)),
        );
        return lines === 2 && labels === "10:00,12:00";
      },
    ],
    [
      "C1.7：拉伸上边缘 → 两个胶囊都在（09:45 / 12:00）",
      async () => {
        const handle = document.querySelector('[data-block-id="b2"] .edge-top');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const rect = handle.getBoundingClientRect();
        const x = rect.left + 30;
        handle.dispatchEvent(ptrEvent("pointerdown", x, rect.top));
        handle.dispatchEvent(ptrEvent("pointermove", x, rect.top - 14)); // -14px = -15 分钟
        await settle();
        const labels = alignLabels().join(",");
        handle.dispatchEvent(ptrEvent("pointerup", x, rect.top - 14));
        await settle();
        window.__DIAG.push("resize-top labels=" + labels + " b2top=" + Math.round(topInDay("b2", 0)));
        return labels === "09:45,12:00";
      },
    ],
    [
      "C1.7：辅助线层不挡鼠标（pointer-events: none）",
      async () => {
        dragStartBlock("b2");
        dragToDay(5, 13, 0);
        await settle();
        const layer = document.querySelector(".guides");
        const label = document.querySelector(".gutter .align-label");
        const ok =
          !!layer &&
          !!label &&
          getComputedStyle(layer).pointerEvents === "none" &&
          getComputedStyle(label).pointerEvents === "none";
        dragReleaseOutside();
        await settle();
        return ok;
      },
    ],
    // ===== round24：整天窗口 / 刻度贴线 / 刻度栏吸左 / 跨天块 =====
    [
      "round24：刻度数字与块的上边缘齐平（半格错位已修）",
      () => {
        // 09:00 = 从 00:00 起第 18 格；b1 就是 09:00 的块。
        // ⚠️ 必须量**文字本身**（Range）——.tick 元素的 rect 不受文字在格里位置影响，
        // 拿它当断言是假绿（红绿对照时抓到过一次）
        const tick = document.querySelectorAll(".tick")[18];
        if (!tick) return false;
        const range = document.createRange();
        range.selectNodeContents(tick);
        return (
          Math.abs(range.getBoundingClientRect().top - el("b1").getBoundingClientRect().top) <= 3
        );
      },
    ],
    [
      "round24：整点淡格线画上了（背景图，零 DOM）",
      () => getComputedStyle(dayBody(0)).backgroundImage.includes("repeating-linear-gradient"),
    ],
    [
      "round24：打开时视野停在 06:00（24 + 12 格 × 28px = 360）",
      () => {
        const top = document.querySelector(".scroll").scrollTop;
        window.__DIAG.push("scrollTop=" + Math.round(top));
        return Math.abs(top - 360) <= 5;
      },
    ],
    [
      "round24：横向滚动时刻度栏**不动**（吸左），列从它下面滑过",
      async () => {
        // 截图窗口 1500px 宽，7 列本来就装得下 → 先把时间轴压窄，才滚得动
        const timeline = document.querySelector(".timeline");
        const scroll = document.querySelector(".scroll");
        const gutter = document.querySelector(".gutter");
        const prevWidth = timeline.style.width;
        const prevFlex = timeline.style.flex;
        timeline.style.flex = "none";
        timeline.style.width = "520px";
        await settle();
        const before = gutter.getBoundingClientRect().left;
        const colBefore = dayBody(0).getBoundingClientRect().left;
        scroll.scrollLeft = 200;
        await settle();
        const after = gutter.getBoundingClientRect().left;
        const colAfter = dayBody(0).getBoundingClientRect().left;
        const scrolled = scroll.scrollLeft;
        timeline.style.width = prevWidth;
        timeline.style.flex = prevFlex;
        scroll.scrollLeft = 0;
        await settle();
        return Math.abs(after - before) <= 1 && scrolled > 100 && colAfter < colBefore - 100;
      },
    ],
    [
      "round24：纵向滚动时日头吸顶（不然看不到「星期几」）",
      async () => {
        const scroll = document.querySelector(".scroll");
        const head = document.querySelector(".day-head");
        const before = head.getBoundingClientRect().top;
        scroll.scrollTop += 300;
        await settle();
        const ok = Math.abs(head.getBoundingClientRect().top - before) <= 1;
        scroll.scrollTop -= 300;
        await settle();
        return ok;
      },
    ],
    [
      "round24：00:00–06:00 那段能放块了（拖到 03:00 → 胶囊 03:00 / 03:30）",
      async () => {
        focusBodyY(yAt(3, 0)); // 凌晨那段先滚进视野，不然指针会落在视口上缘（触发自动滚动）
        await settle();
        if (!dragStartTask()) return false;
        dragToDay(3, 3, 0);
        await settle();
        const ok = alignLabels().join(",") === "03:00,03:30";
        dragReleaseOutside();
        await settle();
        setScrollHome();
        await settle();
        return ok;
      },
    ],
    [
      "round24：下把手拖到**次日那一列** → 终点进次日；次日那一列也有终点线 +「次日 HH:MM」",
      async () => {
        tallViewport(); // 01:00 这种深夜坐标：拉高视口 → 自动滚动不插手，落点可精确断言
        await settle();
        const handle = document.querySelector('[data-block-id="b12"] .edge-bottom');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const x = handle.getBoundingClientRect().left + 30;
        handle.dispatchEvent(ptrEvent("pointerdown", x, handle.getBoundingClientRect().bottom));
        // round26 #4：落点改成二维 —— 要跨天就把指针**拖到次日那一列**（不再靠同一列一路往下拖）
        const sun = dayBody(6).getBoundingClientRect();
        const targetX = sun.left + 30;
        const targetY = sun.top + yAt(1, 0); // 周日 01:00
        handle.dispatchEvent(ptrEvent("pointermove", targetX, targetY));
        await settle();
        const labels = alignLabels().join(",");
        const chips = [...document.querySelectorAll(".align-label.day-chip")]
          .map((n) => n.textContent.trim())
          .join(",");
        const lines = alignLines().length;
        handle.dispatchEvent(ptrEvent("pointerup", targetX, targetY));
        await settle();
        window.__DIAG.push("跨天 labels=" + labels + " chips=" + chips + " lines=" + lines);
        restoreViewport();
        setScrollHome();
        await settle();
        return labels === "20:00,01:00" && chips === "次日 01:00,前一日 20:00" && lines === 2;
      },
    ],
    [
      "round24：跨天块的**把手只画在真边上**（次日那截无上把手；前一天那截无下把手）",
      () => {
        const parts = document.querySelectorAll('[data-block-id="b12"]');
        if (parts.length !== 2) return false;
        const [prev, next] = parts;
        return (
          !!prev.querySelector(".edge-top") &&
          !prev.querySelector(".edge-bottom") &&
          !next.querySelector(".edge-top") &&
          !!next.querySelector(".edge-bottom")
        );
      },
    ],
    [
      "round24：跨天块两段各带标记（前一天那截「续到次日 01:00」；次日那截「上接」）",
      () => {
        const parts = [...document.querySelectorAll('[data-block-id="b12"]')];
        const texts = parts.map(
          (p) => p.parentElement.querySelector(".cont-mark")?.textContent.trim() ?? "",
        );
        return texts[0] === "续到次日 01:00" && texts[1] === "上接";
      },
    ],
    [
      "round24：拉到最短 15 分钟 → **两个**胶囊都在，且自动错开不叠",
      async () => {
        tallViewport(); // 同「跨天」那条：深夜坐标要拉高视口
        await settle();
        const handle = document.querySelector('[data-block-id="b13"] .edge-top'); // 周日 21:00–23:00
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const x = handle.getBoundingClientRect().left + 30;
        handle.dispatchEvent(ptrEvent("pointerdown", x, handle.getBoundingClientRect().top));
        const bodyTop = dayBody(6).getBoundingClientRect().top;
        const targetY = bodyTop + yAt(22, 45); // 起点 21:00 → 22:45（只剩 15 分钟）
        handle.dispatchEvent(ptrEvent("pointermove", x, targetY));
        await settle();
        const pills = [...document.querySelectorAll(".align-label")].map((n) =>
          n.getBoundingClientRect(),
        );
        const texts = alignLabels().join(",");
        handle.dispatchEvent(ptrEvent("pointerup", x, targetY));
        await settle();
        restoreViewport();
        setScrollHome();
        await settle();
        return (
          pills.length === 2 &&
          texts === "22:45,23:00" &&
          Math.abs(pills[1].top - pills[0].top) >= 15
        );
      },
    ],
    // ===== round25：六条验收反馈（①穿模 / ⑥吸顶丢线）=====
    [
      "round25①：半屏横向滚动时，刻度栏那一条命中的必须是 .gutter（不是吸顶日头）",
      async () => {
        const timeline = document.querySelector(".timeline");
        const scroll = document.querySelector(".scroll");
        const prevWidth = timeline.style.width;
        const prevFlex = timeline.style.flex;
        timeline.style.flex = "none";
        timeline.style.width = "520px";
        await settle();
        scroll.scrollLeft = 150;
        await settle();
        const g = document.querySelector(".gutter").getBoundingClientRect();
        const s = scroll.getBoundingClientRect();
        const el = document.elementFromPoint(g.left + 12, s.top + 12);
        const ok = !!el && !!el.closest(".gutter");
        timeline.style.width = prevWidth;
        timeline.style.flex = prevFlex;
        scroll.scrollLeft = 0;
        await settle();
        return ok;
      },
    ],
    [
      "round25⑥：表头上边线长在吸顶日头自己身上（纵向滚动不再丢线/不再上移 1px）",
      async () => {
        const scroll = document.querySelector(".scroll");
        const prevScroll = scroll.scrollTop;
        scroll.scrollTop = 0;
        await settle();
        const head = document.querySelectorAll(".day-head")[0];
        const day = document.querySelectorAll(".day")[0];
        const before = head.getBoundingClientRect().top;
        const headBorder = parseFloat(getComputedStyle(head).borderTopWidth);
        const dayBorder = parseFloat(getComputedStyle(day).borderTopWidth);
        scroll.scrollTop = 40;
        await settle();
        const after = head.getBoundingClientRect().top;
        scroll.scrollTop = prevScroll;
        await settle();
        return Math.abs(after - before) <= 0.5 && headBorder >= 1 && dayBorder === 0;
      },
    ],
    // ===== round25⑤：跨周块的尾巴（用户：「被延到下周的块，在下周看不到」）=====
    [
      "round25⑤：起点在上周、尾巴伸进本周的块 → 本周一列也画得出来（顶部「上接」）",
      async () => {
        focusBlock("b15");
        await settle();
        const box = document.querySelector('[data-block-id="b15"]');
        const top = topInDay("b15", 0);
        const mark = box?.parentElement?.querySelector(".cont-mark")?.textContent?.trim() ?? "";
        return top >= 0 && top <= 3 && mark === "上接";
      },
    ],
    [
      "round25⑤（回归）：同一块在**上周**那一周照旧画前一截 +「续到次日 05:00」",
      async () => {
        const nav = document.querySelector(".week-nav");
        nav.querySelectorAll("button")[0].click(); // 去上一周
        await settle(20);
        const box = document.querySelector('[data-block-id="b15"]');
        const top = topInDay("b15", 6); // 上周日那一列
        const mark = box?.parentElement?.querySelector(".cont-mark")?.textContent?.trim() ?? "";
        const ok = top >= 0 && mark === "续到次日 05:00";
        document.querySelector(".week-nav").querySelectorAll("button")[1].click(); // 回本周
        await settle(20);
        setScrollHome();
        await settle();
        return ok;
      },
    ],
    // ===== round25②：拖动落点（用户：「隔壁列拖不过去，只会留在原列」）=====
    [
      "round25②：拖到隔壁列 → 真的落在隔壁列（不再留在原列）",
      async () => {
        // round26：靶子 b1 → b20（b1 会被 300ms 那次双击标成真 done，done 的块不可拖）
        dragStartBlock("b20"); // b20 = 周五 09:00
        dragToDay(1, 13, 0); // 拖到周二 13:00
        await settle();
        const p = atDay(1, 13, 0);
        dragRelease(p.x, p.y);
        await settle();
        return Math.abs(topInDay("b20", 1) - yAt(13, 0)) <= 20;
      },
    ],
    [
      "round25②：拖到两列之间那条 8px 缝 → 落在近的那一列（周四，不是留在原来的周五）",
      async () => {
        // round77（3.1b）：先清掉多选 —— 当时动作条独占一行、拖动开始又会把选中清掉，头部那一下
        // 会变高矮 → 落点偏一格（实测偏 30 分钟）。round77 收尾已把头部做成不变量（固定槽 +
        // 键位提示不再影响换行，三条不变量断言盘住），这里保留清选中只为把前置状态摆干净。
        await press("Escape");
        await press("Escape");
        // round77（3.1b）：再把目标 y 滚进视野中央 —— 指针一旦落在滚动容器的边缘带里，
        // 自动滚动会插手，落点会被推着走（`focusBodyY` 就是为这个场景准备的）
        setScrollHome();
        focusBodyY(yAt(14, 0));
        await settle();
        dragStartBlock("b14"); // b14 = 周五 16:00
        const wed = dayBody(2).getBoundingClientRect();
        const x = wed.right + 6; // 缝里、靠周四那一侧
        const y = wed.top + yAt(14, 0);
        dragToPoint(x, y);
        await settle();
        dragRelease(x, y);
        await settle();
        return topInDay("b14", 3) >= 0 && Math.abs(topInDay("b14", 3) - yAt(14, 0)) <= 20;
      },
    ],
    [
      "round25②：拖到吸顶日头那一条（列顶部 24px）→ 落该列 00:00",
      async () => {
        dragStartBlock("b14"); // 现在在周四
        const fri = dayBody(4).getBoundingClientRect();
        const x = fri.left + fri.width / 2;
        const y = fri.top - 12; // 在日头带里
        dragToPoint(x, y);
        await settle();
        dragRelease(x, y);
        await settle();
        return topInDay("b14", 4) >= 0 && topInDay("b14", 4) <= 20;
      },
    ],
    [
      "round25②：拖到刻度栏那一条 → 落到第 1 列（周一）",
      async () => {
        focusBlock("b14");
        await settle();
        const src = document.querySelector('[data-block-id="b14"]');
        if (!src) return false;
        const y = src.getBoundingClientRect().top + 8;
        dragStartBlock("b14");
        const gut = document.querySelector(".gutter").getBoundingClientRect();
        dragToPoint(gut.left + 12, y);
        await settle();
        dragRelease(gut.left + 12, y);
        await settle();
        return topInDay("b14", 0) >= 0;
      },
    ],
    [
      "round25③：拖动时把指针贴到面板下缘 → 视图自己往下滚",
      async () => {
        focusBlock("b14");
        await settle();
        const scroll = document.querySelector(".scroll");
        const before = scroll.scrollTop;
        dragStartBlock("b14"); // 现在在周一 16:00
        const r = scroll.getBoundingClientRect();
        const x = dayBody(0).getBoundingClientRect().left + 40;
        for (let i = 0; i < 6; i++) {
          dragToPoint(x, r.bottom - 4);
          await frames(4); // 自动滚动要的是帧：等 4 帧它才滚得动
        }
        const after = scroll.scrollTop;
        dragReleaseOutside();
        await settle();
        setScrollHome();
        await settle();
        return after > before + 20;
      },
    ],
    [
      "round25③：拖动中按 Esc → 取消（块不动、线消失、自动滚动停）",
      async () => {
        const before = topInDay("b14", 0);
        dragStartBlock("b14");
        dragToDay(5, 20, 0);
        await settle();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        return alignLines().length === 0 && Math.abs(topInDay("b14", 0) - before) <= 1;
      },
    ],
    [
      "round25②（回归）：从 Backlog 拖任务到某列 → 新块就落在那一列的那个时刻",
      async () => {
        const countBefore = document.querySelectorAll("[data-block-id]").length;
        if (!dragStartTask()) return false;
        const p = dragToDay(2, 11, 0);
        await settle();
        dragRelease(p.x, p.y);
        await settle();
        const countAfter = document.querySelectorAll("[data-block-id]").length;
        const bodies = [...dayBody(2).querySelectorAll("[data-block-id]")];
        const hit = bodies.some(
          (b) => Math.abs(b.getBoundingClientRect().top - dayBody(2).getBoundingClientRect().top - yAt(11, 0)) <= 20,
        );
        return countAfter === countBefore + 1 && hit;
      },
    ],
    // ===== round25③④：拉伸的自动滚动与「跟手」=====
    [
      "round25③：拉伸时把指针贴到面板下缘 → 视图自己往下滚（以前不动）",
      async () => {
        const scroll = document.querySelector(".scroll");
        setScrollHome();
        focusBlock("b14");
        await settle();
        const handle = document.querySelector('[data-block-id="b14"] .edge-bottom');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const rect = handle.getBoundingClientRect();
        const r = scroll.getBoundingClientRect();
        handle.dispatchEvent(ptrEvent("pointerdown", rect.left + 40, rect.bottom));
        for (let i = 0; i < 6; i++) {
          handle.dispatchEvent(ptrEvent("pointermove", rect.left + 40, r.bottom - 4));
          await frames(4); // 同上：拉伸的自动滚动也要帧
        }
        const after = scroll.scrollTop;
        handle.dispatchEvent(ptrEvent("pointerup", rect.left + 40, r.bottom - 4));
        await settle();
        return after > 20;
      },
    ],
    // ===== round25 §5-S：跨天边界（下边缘最多 3 天 / 上边缘能往回跨天 / 多天块渲染）=====
    [
      "round26#4（重写 §5-S）：下边缘拖到 4 天后的那一列 → 夹在「起点 + 72 小时」（3 天上限）",
      async () => {
        tallViewport(); // 长块的目标坐标很深：拉高视口让自动滚动不插手、坐标稳定
        await settle();
        // round77 收尾：清掉选中只为摆干净前置状态（头部已是不变量，选中/多选不再改高度）
        await press("Escape");
        await press("Escape");
        focusBlock("b19"); // round26 专用靶子：周一 18:00–19:00
        focusBodyY(yAt(18, 0)); // round77：目标 18:00 滚进视野中央（否则边缘带的自动滚动会推落点）
        await settle();
        const handle = document.querySelector('[data-block-id="b19"] .edge-bottom');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const startAt = FIX.blocks.find((b) => b.id === "b19").start_at;
        const x = handle.getBoundingClientRect().left + 30;
        const pressY = handle.getBoundingClientRect().bottom;
        handle.dispatchEvent(ptrEvent("pointerdown", x, pressY));
        // 指针拖到**周五那一列**的 18:00（= 起点 + 96 小时 > 上限 72 小时）
        const fri = dayBody(4).getBoundingClientRect();
        const targetX = fri.left + 30;
        const targetY = fri.top + yAt(18, 0);
        handle.dispatchEvent(ptrEvent("pointermove", targetX, targetY));
        await settle();
        const hint = document.querySelector(".gesture-hint")?.textContent?.trim() ?? "";
        handle.dispatchEvent(ptrEvent("pointerup", targetX, targetY));
        await settle(20);
        restoreViewport();
        setScrollHome();
        await settle();
        const stored = FIX.blocks.find((b) => b.id === "b19");
        const hours = (stored.end_at - stored.start_at) / 3600;
        const parts = [...document.querySelectorAll('[data-block-id="b19"]')];
        const mid = parts.slice(1, -1);
        const midNoHandles = mid.every(
          (p) => !p.querySelector(".edge-top") && !p.querySelector(".edge-bottom"),
        );
        const midBothMarks = mid.every(
          (p) => p.parentElement.querySelectorAll(".cont-mark").length === 2,
        );
        window.__DIAG.push(
          "72h上限 起点动=" + (stored.start_at !== startAt) + " 起点=" + stored.start_at + "/" + startAt +
            " hint=" + hint + " 落库=" + hours + "h parts=" + parts.length +
            " 中段无把手=" + midNoHandles + " 中段两标记=" + midBothMarks +
            " 首段上有把手=" + !!parts[0].querySelector(".edge-top") +
            " 末段下有把手=" + !!parts[3].querySelector(".edge-bottom")
        );
        return (
          hint.includes("72 小时") &&
          stored.end_at - stored.start_at === 72 * 3600 &&
          stored.start_at === startAt &&
          parts.length === 4 &&
          midNoHandles &&
          midBothMarks &&
          !!parts[0].querySelector(".edge-top") &&
          !!parts[3].querySelector(".edge-bottom")
        );
      },
    ],
    [
      "round26#4（重写 §5-S）：上边缘拖到**前一列** = 起点往前一天（想往前拖几天就拖几天）",
      async () => {
        tallViewport();
        await settle();
        // 用 b9（周五 14:00–15:00，短块）：上边缘拖到**周四那一列**的 07:00 → 起点跨到前一天
        focusBlock("b9");
        await settle();
        const handle = document.querySelector('[data-block-id="b9"] .edge-top');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const x = handle.getBoundingClientRect().left + 30;
        handle.dispatchEvent(ptrEvent("pointerdown", x, handle.getBoundingClientRect().top));
        const thu = dayBody(3).getBoundingClientRect();
        const targetX = thu.left + 30;
        const targetY = thu.top + yAt(7, 0); // 周四 07:00
        handle.dispatchEvent(ptrEvent("pointermove", targetX, targetY));
        await settle();
        const hint = document.querySelector(".gesture-hint")?.textContent?.trim() ?? "";
        handle.dispatchEvent(ptrEvent("pointerup", targetX, targetY));
        await settle(20);
        restoreViewport();
        setScrollHome();
        await settle();
        const thuTop = topInDay("b9", 3); // 周四那一列
        window.__DIAG.push(
          "上边缘跨天 hint=" + hint + " 周四段=" + Math.round(thuTop) + " 期望=" + yAt(7, 0),
        );
        return hint.includes("07:00") && Math.abs(thuTop - yAt(7, 0)) <= 3;
      },
    ],
    [
      "round25④：拉伸中滚轮滚一下内容 → 下边缘仍跟着鼠标（不是相对位移）",
      async () => {
        const scroll = document.querySelector(".scroll");
        // 用一块**白天**的块（b9 = 周五 14:00–15:00）：正常视口下它离上下边缘都远，自动滚动不会插手；
        // 视口也不能贴底（要留出滚轮能滚的那一段）
        scroll.scrollTop = 100;
        await settle();
        const handle = document.querySelector('[data-block-id="b9"] .edge-bottom');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const edgeY = handle.getBoundingClientRect().bottom;
        const x = handle.getBoundingClientRect().left + 30;
        const hint = () => document.querySelector(".gesture-hint")?.textContent?.trim() ?? "";
        handle.dispatchEvent(ptrEvent("pointerdown", x, edgeY));
        handle.dispatchEvent(ptrEvent("pointermove", x, edgeY + 2 * slotH())); // +2 格 = 1 小时
        await settle();
        const first = hint();
        scroll.scrollTop += 2 * slotH(); // 相当于滚了一下滚轮（内容上移一小时）
        await settle();
        // 指针回到「下边缘现在所在的位置」→ 跟手的话预览不变；相对位移的旧实现会差 1 小时
        handle.dispatchEvent(ptrEvent("pointermove", x, edgeY));
        await settle();
        const after = hint();
        handle.dispatchEvent(ptrEvent("pointerup", x, edgeY));
        await settle();
        setScrollHome();
        await settle();
        window.__DIAG.push("wheel first=" + first + " after=" + after);
        // 只断言**不变量**：滚动前后同一颗指针位置算出来的区间必须一模一样
        // （相对位移的旧实现会少 1 小时 → 这条会红）。不要写死具体时刻，否则会被前面断言的改动带崩。
        return first.startsWith("正在调整") && after === first;
      },
    ],
    // ===== round25 C1.8（R33）：临时安排块 =====
    [
      "round25C1.8：双击空白格 → 建一个 30 分钟的临时块，并且就地开始命名（输入框已聚焦）",
      async () => {
        focusBodyY(yAt(3, 0)); // 先把凌晨那一段滚进视野（不然双击会落在工具栏上）
        await settle();
        const before = document.querySelectorAll("[data-block-id]").length;
        dblclickAt(5, 3, 0); // 周六 03:00（这一格空着）
        await settle(20);
        const after = document.querySelectorAll("[data-block-id]").length;
        const active = document.activeElement;
        const typing = !!active && active.tagName === "INPUT" && active.placeholder === "临时安排";
        const box = blockAt(5, 3, 15);
        const top = box ? Math.abs(box.getBoundingClientRect().top - dayBody(5).getBoundingClientRect().top - (yAt(3, 0) + 1)) : -1;
        const owner = document.activeElement?.closest?.("[data-block-id]")?.getAttribute("data-block-id") ?? "-";
        const day5 = [...dayBody(5).querySelectorAll("[data-block-id]")]
          .map((b) => b.getAttribute("data-block-id") + "@" + Math.round(b.getBoundingClientRect().top - dayBody(5).getBoundingClientRect().top))
          .join(",");
        window.__DIAG.push(
          "C1.8 新建 块数 " + before + "→" + after + " 聚焦=" + typing + " 落点偏差=" + Math.round(top) +
            " owner=" + owner + " day5=[" + day5 + "]" + " 视口y=" + Math.round(dayBody(5).getBoundingClientRect().top) + " 点y=" + Math.round(atDay(5, 3, 0).y),
        );
        return after === before + 1 && typing && top >= 0 && top <= 3;
      },
    ],
    [
      "round25C1.8：Esc 放弃命名 → 名字保持默认「临时安排」",
      async () => {
        const input = document.activeElement;
        if (!input || input.tagName !== "INPUT") return false;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await settle(20);
        const box = blockAt(5, 3, 15);
        const name = box?.querySelector(".name")?.textContent?.trim() ?? "";
        return name === "临时安排";
      },
    ],
    [
      "round25C1.8：再建一个 + 打字回车 → 名字变成打的那串；Backlog 一个任务都没多",
      async () => {
        const tasksBefore = document.querySelectorAll(".item").length;
        dblclickAt(5, 4, 0);
        await settle(20);
        const input = document.activeElement;
        if (!input || input.tagName !== "INPUT") return false;
        input.value = "临时：修水管";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await settle(20);
        const box = blockAt(5, 4, 15);
        const name = box?.querySelector(".name")?.textContent?.trim() ?? "";
        const tasksAfter = document.querySelectorAll(".item").length;
        window.__DIAG.push("C1.8 改名 name=" + name + " 任务数 " + tasksBefore + "→" + tasksAfter);
        return name === "临时：修水管" && tasksAfter === tasksBefore;
      },
    ],
    [
      "round25C1.8：双击**块**不算空白格（不新建；普通块照旧被标记完成）",
      async () => {
        focusBodyY(yAt(21, 0));
        await settle();
        const before = document.querySelectorAll("[data-block-id]").length;
        dblclickAt(5, 21, 0); // 周六 21:00 有块（b12 被 round24 拉到次日 01:00）
        await settle(20);
        const after = document.querySelectorAll("[data-block-id]").length;
        const marked = document.querySelector('[data-block-id="b12"]')?.classList.contains("done");
        return after === before && !!marked;
      },
    ],
    [
      "round25C1.8：双击**拉伸把手**也不算空白格（不新建）",
      async () => {
        focusBlock("b13");
        await settle();
        const before = document.querySelectorAll("[data-block-id]").length;
        const handle = document.querySelector('[data-block-id="b13"] .edge-top');
        if (!handle) return false;
        const r = handle.getBoundingClientRect();
        handle.dispatchEvent(
          new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 1 }),
        );
        await settle(20);
        return document.querySelectorAll("[data-block-id]").length === before;
      },
    ],
    [
      "round25C1.8：换周再回来 → 临时块与名字都还在（落库了）",
      async () => {
        const nav = document.querySelector(".week-nav");
        nav.querySelectorAll("button")[1].click(); // 下一周
        await settle(20);
        nav.querySelectorAll("button")[0].click(); // 回到本周
        await settle(20);
        focusBodyY(yAt(4, 0));
        await settle();
        const box = blockAt(5, 4, 15);
        const name = box?.querySelector(".name")?.textContent?.trim() ?? "";
        setScrollHome();
        await settle();
        return name === "临时：修水管";
      },
    ],
    [
      "round25C1.8：fixture 里预置的两个临时块按各自的名字渲染（没命名的叫「临时安排」）",
      async () => {
        focusBlock("b16");
        await settle();
        const a = document.querySelector('[data-block-id="b16"] .name')?.textContent?.trim() ?? "";
        const b = document.querySelector('[data-block-id="b17"] .name')?.textContent?.trim() ?? "";
        return a === "临时安排" && b === "写方案";
      },
    ],
    [
      "round25C1.8：临时块的 🗑 能删掉（只是删块，不影响别的）",
      async () => {
        const before = document.querySelectorAll("[data-block-id]").length;
        const btn = document.querySelector('[data-block-id="b16"] button[title="删除块"]');
        if (!btn) return false;
        const confirm = window.confirm;
        window.confirm = () => true; // 界面层是 window.confirm，预览里直接放行
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.confirm = confirm;
        const after = document.querySelectorAll("[data-block-id]").length;
        return after === before - 1 && !document.querySelector('[data-block-id="b16"]');
      },
    ],
    // ===== round26：12 条验收反馈（撤销空步 / 漂流重拉 / 手势自愈 / 二维拉伸 / 观感）=====
    [
      "round26#1：刻度栏顶部那条横线已删（用户说 00:00 头上那线很突兕）",
      () => getComputedStyle(document.querySelector(".gutter"), "::after").content === "none",
    ],
    [
      "round26#2/#3：Backlog 卡片与时间轴上的块都不许被选中（user-select: none）",
      () => {
        const item = document.querySelector(".item");
        const block = document.querySelector('[data-block-id="b20"]');
        return (
          !!item &&
          !!block &&
          getComputedStyle(item).userSelect === "none" &&
          getComputedStyle(block).userSelect === "none"
        );
      },
    ],
    [
      "round26#7：4 个中文字的任务名不被截断（动作区收紧后放得下）",
      () => {
        // 「临时安排」= 4 个字，正是用户截图里被截成「临时…」的那一档（C1.8 建的那个临时块）
        const name = [...document.querySelectorAll("[data-block-id]:not(.narrow) .name")].find(
          (n) => (n.textContent ?? "").trim() === "临时安排",
        );
        if (!name) return false;
        const blk = name.closest("[data-block-id]");
        const acts = blk?.querySelector(".actions");
        window.__DIAG.push(
          "4字名 scrollWidth=" + name.scrollWidth + " clientWidth=" + name.clientWidth +
            " 块宽=" + (blk ? Math.round(blk.getBoundingClientRect().width) : -1) +
            " 名字区宽=" + (name.parentElement ? Math.round(name.parentElement.getBoundingClientRect().width) : -1) +
            " 动作区宽=" + (acts ? Math.round(acts.getBoundingClientRect().width) : -1)
        );
        return name.scrollWidth <= name.clientWidth;
      },
    ],
    [
      "round26#7（回归）：所有整宽块里 ≤4 个字的名字都不被截断",
      () => {
        const bad = [...document.querySelectorAll("[data-block-id]:not(.narrow) .name")]
          .filter((n) => (n.textContent ?? "").trim().length <= 4)
          .filter((n) => n.scrollWidth > n.clientWidth)
          .map((n) => n.textContent.trim());
        window.__DIAG.push("被截断的短名=" + (bad.join("/") || "无"));
        return bad.length === 0;
      },
    ],
    [
      "round26#2：手势中起了原生拖拽（dragstart）→ 手势当场取消（拖影消失、松开不落库）",
      async () => {
        focusBlock("b20");
        await settle();
        const src = document.querySelector('[data-block-id="b20"]');
        if (!src) return false;
        const before = FIX.blocks.find((b) => b.id === "b20").start_at;
        const r = src.getBoundingClientRect();
        firePointer("pointerdown", r.left + 18, r.top + r.height / 2);
        dragToDay(1, 15, 0); // 拖到很远的地方：要是没收尾，松手就会落库
        await settle();
        // 浏览器真发起原生拖拽时就是这个事件（用户现场：选文本 → pointerup 收不到 → 手势卡死）
        window.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
        await settle();
        const ghost = [...document.body.children].some(
          (el) => el.style.position === "fixed" && el.style.zIndex === "9999",
        );
        const p = atDay(1, 15, 0);
        dragRelease(p.x, p.y);
        await settle(20);
        const after = FIX.blocks.find((b) => b.id === "b20").start_at;
        setScrollHome();
        await settle();
        window.__DIAG.push("dragstart取消 拖影还在=" + ghost + " 落库=" + (before !== after));
        return !ghost && before === after;
      },
    ],
    [
      "round26#9：拉伸时指针贴到右缘 → 视图自己往右滚（够到看不见的列）",
      async () => {
        narrowViewport(); // 收窄时间轴 → 列排不下，横向能滚
        await settle();
        const scroll = document.querySelector(".scroll");
        scroll.scrollLeft = 0;
        await settle();
        const handle = document.querySelector('[data-block-id="b19"] .edge-top');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const r = handle.getBoundingClientRect();
        handle.dispatchEvent(ptrEvent("pointerdown", r.left + 20, r.top));
        const sr = scroll.getBoundingClientRect();
        const y = sr.top + sr.height / 2; // 纵向居中 → 只触发横向自动滚
        for (let i = 0; i < 6; i++) {
          handle.dispatchEvent(ptrEvent("pointermove", sr.right - 4, y));
          await frames(4); // 自动滚动要的是帧
        }
        const after = scroll.scrollLeft;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); // 取消，不落库
        await settle();
        restoreTimelineWidth();
        setScrollHome();
        await settle();
        window.__DIAG.push("横向自动滚动 scrollLeft=" + Math.round(after));
        return after > 20;
      },
    ],
    [
      "round26#2：手势自愈 —— 卡着没收尾的手势不挡下一次拖动（旧的默默丢掉、新的照常落库）",
      async () => {
        // ① 在 b20 上按下 —— 故意**不松手**（复现用户报的「手势卡住」）
        focusBlock("b20");
        await settle();
        const a = document.querySelector('[data-block-id="b20"]');
        if (!a) return false;
        const aBefore = FIX.blocks.find((b) => b.id === "b20").start_at;
        const ra = a.getBoundingClientRect();
        firePointer("pointerdown", ra.left + 18, ra.top + ra.height / 2);
        dragToDay(6, 12, 0);
        await settle();
        // ② 手势没收尾，直接又在 b19 上按下并正常拖完 —— 新的必须接管
        const bBefore = FIX.blocks.find((b) => b.id === "b19").start_at;
        focusBlock("b19");
        await settle();
        const b = document.querySelector('[data-block-id="b19"]');
        if (!b) return false;
        const rb = b.getBoundingClientRect();
        firePointer("pointerdown", rb.left + 18, rb.top + Math.min(rb.height / 2, 20));
        const p = dragToDay(6, 12, 0);
        await settle();
        dragRelease(p.x, p.y);
        await settle(20);
        const aAfter = FIX.blocks.find((x) => x.id === "b20").start_at;
        const bAfter = FIX.blocks.find((x) => x.id === "b19").start_at;
        setScrollHome();
        await settle();
        window.__DIAG.push(
          "自愈：旧块 b20 动了=" + (aAfter !== aBefore) + " 新块 b19 动了=" + (bAfter !== bBefore),
        );
        return aAfter === aBefore && bAfter !== bBefore;
      },
    ],
    [
      "round26#4：拉伸二维 —— 下边缘拖到**下一列**（周四 11:00）= 续到次日，且胶囊锚在指针那一列",
      async () => {
        tallViewport();
        await settle();
        focusBlock("b22"); // 周三 09:00–10:00
        focusBodyY(yAt(11, 0)); // round77（3.1b）：落点 11:00 滚进视野中央（边缘带的自动滚动会推落点）
        await settle();
        const handle = document.querySelector('[data-block-id="b22"] .edge-bottom');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const r0 = handle.getBoundingClientRect();
        handle.dispatchEvent(ptrEvent("pointerdown", r0.left + 30, r0.bottom));
        const thu = dayBody(3).getBoundingClientRect();
        const targetX = thu.left + 30;
        const targetY = thu.top + yAt(11, 0); // 周四 11:00
        handle.dispatchEvent(ptrEvent("pointermove", targetX, targetY));
        await settle();
        const hint = document.querySelector(".gesture-hint")?.textContent?.trim() ?? "";
        const pills = [...document.querySelectorAll(".gutter .align-label")].map((n) =>
          n.getBoundingClientRect(),
        );
        // 端点胶囊锚在**指针所在列**（周四）→ 它的**中心**就该落在周四 11:00 那格
        // （胶囊自己有 translateY(-50%) 居中，所以比 top 要把高度算进去）
        const endPill = pills.length ? pills[0].top > pills[1].top ? pills[0] : pills[1] : null;
        const endPillMid = endPill ? endPill.top + endPill.height / 2 : Number.NaN;
        const anchorOff = Math.abs(endPillMid - (thu.top + yAt(11, 0)));
        handle.dispatchEvent(ptrEvent("pointerup", targetX, targetY));
        await settle(20);
        restoreViewport();
        setScrollHome();
        await settle();
        const stored = FIX.blocks.find((b) => b.id === "b22");
        const parts = [...document.querySelectorAll('[data-block-id="b22"]')];
        const thuHeight = parts.length === 2 ? parts[1].getBoundingClientRect().height : -1;
        const hours = (stored.end_at - stored.start_at) / 3600;
        window.__DIAG.push(
          "二维跨天 hint=" + hint + " 段数=" + parts.length + " 周四段高=" + Math.round(thuHeight) +
            " 锚偏差=" + Math.round(anchorOff) + " 落库=" + hours + "h",
        );
        return (
          parts.length === 2 &&
          Math.abs(thuHeight - yAt(11, 0)) <= 3 &&
          Math.abs(stored.end_at - stored.start_at - 26 * 3600) <= 900 &&
          // round77 收尾：≤4 → ≤2 —— 日头高与 JS 的 `DAY_HEAD_PX` 现在一致（实测 0px）；
          // 若只差 DAY_HEAD_PX（24 vs 28）就会恰好偏 4px，这道紧一点刚好把它盘住。
          anchorOff <= 2 &&
          hint.includes("11:00")
        );
      },
    ],
    [
      "round26#6：拉伸中滚动（**不发 pointermove**）→ 预览自己重算（滚轮跟不住已修）",
      async () => {
        const scroll = document.querySelector(".scroll");
        // 视口压矮（预览窗口很高 → 不压矮的话内容矮于视口，scrollTop 根本改不动）
        scroll.style.flex = "none";
        scroll.style.height = "420px";
        await settle();
        // 把要拖的那条边放在视口**中段**（离上下边缘都 >100px）：自动滚动一帧都不会插手 ——
        // 否则它 rAF 的 tick 会顺手重算预览，这条断言即使产品没修也会绿（红绿对照时抳到过 ✗）
        scroll.scrollTop = yAt(15, 0) - 210;
        await settle();
        const sr = scroll.getBoundingClientRect();
        const handle = document.querySelector('[data-block-id="b9"] .edge-bottom');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const r = handle.getBoundingClientRect();
        const x = r.left + 30;
        const edgeY = r.bottom;
        const calm = edgeY - sr.top > 100 && sr.bottom - edgeY > 100; // 指针在「安全区」
        const hint = () => document.querySelector(".gesture-hint")?.textContent?.trim() ?? "";
        handle.dispatchEvent(ptrEvent("pointerdown", x, edgeY));
        handle.dispatchEvent(ptrEvent("pointermove", x, edgeY + slotH())); // +1 格 = 30 分钟
        await settle();
        const before = hint();
        // 滚轮：内容上移 56px（1 小时）。**故意不发 pointermove** —— 只看预览有没有自己重算
        const topBefore = scroll.scrollTop;
        scroll.scrollTop = topBefore + 2 * slotH();
        await frames(2);
        const scrolled = scroll.scrollTop - topBefore;
        const after = hint();
        handle.dispatchEvent(ptrEvent("pointerup", x, edgeY + slotH()));
        await settle(20);
        restoreViewport();
        setScrollHome();
        await settle();
        window.__DIAG.push(
          "滚动重算 安全区=" + calm + " 滚了" + scrolled + "px before=" + before + " after=" + after,
        );
        return (
          calm &&
          Math.abs(scrolled - 2 * slotH()) <= 2 && // 只滚了我要求的那一小时 → 自动滚动没插手
          before.startsWith("正在调整") &&
          after !== "" &&
          after !== before
        );
      },
    ],
    [
      "round26#5：拿着线头翻页 → 从板子靠源块那一侧探出一截线头（不是整条线消失）",
      async () => {
        const linkBtn = document.querySelector('[data-block-id="b21"] button.link');
        if (!linkBtn) return false;
        const obs = [];
        linkBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle();
        obs.push(
          "点⛓后 线头按钮高亮=" +
            linkBtn.classList.contains("linking") +
            " 提示条=" +
            !!document.querySelector(".link-hint"),
        );
        const nav = document.querySelector(".week-nav");
        nav.querySelectorAll("button")[1].click(); // 下一周：源块留在上一周、DOM 里没有它
        await settle(20);
        obs.push(
          "换周后 提示条=" +
            !!document.querySelector(".link-hint") +
            " b21在DOM=" +
            !!document.querySelector('[data-block-id="b21"]') +
            " 窗口=" +
            ((window.__DBG || []).slice(-1)[0] || []).join(".."),
        );
        const first = dayBody(0).getBoundingClientRect();
        dragToPoint(first.left + 60, first.top + 120); // 线头跟着鼠标
        // 线的重新量算在 rAF 里（Sequence 的 effect）→ 必须等**帧**，只等微任务会拿到旧值
        await frames(3);
        const line = document.querySelector(".wires .pending line");
        const rect = line?.getBoundingClientRect();
        const day0Left = document.querySelector(".day-body").getBoundingClientRect().left;
        const atLeftEdge = !!rect && Math.abs(rect.left - day0Left) <= 2;
        nav.querySelectorAll("button")[0].click(); // 回到本周
        await settle(20);
        document
          .querySelector(".link-hint button")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 取消线头
        await settle();
        setScrollHome();
        await settle();
        window.__DIAG.push(
          "线头翻页 " + obs.join(" ｜ ") + " 有线=" + !!line +
            " 线总数=" + document.querySelectorAll(".wires line, .wires path").length +
            " 当前窗口=" + ((window.__DBG || []).slice(-1)[0] || []).join("..") +
            (line
              ? " 属性 x1=" + line.getAttribute("x1") + " x2=" + line.getAttribute("x2") +
                " 屏幕 line.left=" + Math.round(rect.left) +
                " board.left=" + Math.round(document.querySelector(".board").getBoundingClientRect().left) +
                " gutter.left=" + Math.round(document.querySelector(".gutter").getBoundingClientRect().left) +
                " day0.left=" + Math.round(day0Left)
              : ""),
        );
        return !!line && atLeftEdge;
      },
    ],
    [
      "round26 U（护栏，不是证据）：标记未完成 / 漂流之后，界面上的块与假库逐条一致",
      async () => {
        // ⚠️ 诚实说明（红绿对照实测过）：这条**今天不可能红** —— `confirmDrift` 自己也会 `reloadWeek()`，
        // 所以预览层分不出「postpone 整周重拉」与「旧的按 id upsert」。它只当**不变量护栏**用。
        // B 组（规矩 23：会动数据的落库调用一律整周重拉）的真机器证据在 `src/lib/stores/blocks.week.test.ts`。
        focusBlock("b21");
        await settle();
        const box = document.querySelector('[data-block-id="b21"]');
        const miss = box?.querySelector('button[title="标记未完成"]');
        if (!miss) return false;
        miss.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const afterMiss = dbViewMismatch();
        // 漂流卡：有建议时段就把整条链路走完（postpone → 必须整周重拉）
        const slot = document.querySelector(".drift .slots button.slot");
        let drifted = "无建议时段（本周快过完了）";
        if (slot) {
          slot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
          drifted = "走了漂流";
        }
        const bad = dbViewMismatch();
        const driftBlocks = FIX.blocks.filter((b) => b.id.startsWith("drift")).length;
        setScrollHome();
        await settle();
        window.__DIAG.push(
          "U债 " + drifted + " ✗后不一致=" + JSON.stringify(afterMiss) +
            " 最终不一致=" + JSON.stringify(bad) + " 漂流块=" + driftBlocks +
            " 判定=" + String(afterMiss.length === 0 && bad.length === 0 && (drifted === "走了漂流" ? driftBlocks === 1 : true)),
        );
        return (
          afterMiss.length === 0 &&
          bad.length === 0 &&
          (drifted === "走了漂流" ? driftBlocks === 1 : true)
        );
      },
    ],
    // ===== round77 收尾（3.1b）：头部高度是**不变量**（手势中途不许变；一变落点就偏一格）=====
    [
      "round77：拉伸中途头部高度不变（有选中）—— 手势不能推着时间轴上下跳",
      async () => {
        tallViewport();
        await settle();
        if (!(await selectByClick("b22"))) return false; // 选中态 = key-hint 在场
        focusBlock("b22");
        focusBodyY(yAt(11, 0));
        await settle();
        const handle = document.querySelector('[data-block-id="b22"] .edge-bottom');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const hBefore = headHeight();
        const r0 = handle.getBoundingClientRect();
        handle.dispatchEvent(ptrEvent("pointerdown", r0.left + 30, r0.bottom));
        const hDown = headHeight();
        const thu = dayBody(3).getBoundingClientRect();
        handle.dispatchEvent(ptrEvent("pointermove", thu.left + 30, thu.top + yAt(11, 0)));
        await settle();
        const hMove = headHeight();
        handle.dispatchEvent(ptrEvent("pointerup", thu.left + 30, thu.top + yAt(11, 0)));
        await settle(20);
        restoreViewport();
        setScrollHome();
        await settle();
        window.__DIAG.push(
          "头部不变(拉伸) 高(前/按下/移动后)=" + hBefore + "/" + hDown + "/" + hMove,
        );
        return hBefore > 0 && hBefore === hDown && hDown === hMove;
      },
    ],
    [
      "round77：拖动中途头部高度不变（有选中）",
      async () => {
        setScrollHome();
        await settle();
        if (!(await selectByClick("b22"))) return false;
        await settle();
        const hBefore = headHeight();
        const node = el("b22");
        if (!node) return false;
        const r = node.getBoundingClientRect();
        firePointer("pointerdown", r.left + 18, r.top + Math.min(r.height / 2, 18));
        const hDown = headHeight();
        const p = dragToDay(1, 13, 0);
        await settle();
        const hMove = headHeight();
        firePointer("pointercancel", p.x, p.y); // 取消手势：不落库、不留副作用
        await settle();
        window.__DIAG.push("头部不变(拖动) 高(前/按下/移动后)=" + hBefore + "/" + hDown + "/" + hMove);
        return hBefore > 0 && hBefore === hDown && hDown === hMove;
      },
    ],
    [
      "round77：多选动作条不改变头部高度（0 选 / 多选 / 多选拖动中三值相等）",
      async () => {
        setScrollHome();
        await clearSel();
        await settle();
        const h0 = headHeight();
        const slotH = () => {
          const n = document.querySelector(".hint-slot");
          return n ? Math.round(n.getBoundingClientRect().height * 10) / 10 : -1;
        };
        const barH = () => {
          const n = document.querySelector(".bulk-bar");
          return n ? Math.round(n.getBoundingClientRect().height * 10) / 10 : -1;
        };
        const s0 = slotH();
        if (!(await ctrlClick("b20"))) return false;
        if (!(await ctrlClick("b19"))) return false;
        await settle();
        const hMulti = headHeight();
        const sMulti = slotH();
        const bMulti = barH();
        const bar = !!document.querySelector(".bulk-bar");
        const node = el("b20");
        if (!node) return false;
        const r = node.getBoundingClientRect();
        firePointer("pointerdown", r.left + 18, r.top + Math.min(r.height / 2, 18));
        await settle();
        const hDown = headHeight();
        const p = dragToDay(1, 13, 0);
        await settle();
        const hMove = headHeight();
        firePointer("pointercancel", p.x, p.y);
        await settle();
        await clearSel();
        await settle();
        window.__DIAG.push(
          "头部不变(多选) 高(0选/多选/按下/移动后)=" + h0 + "/" + hMulti + "/" + hDown + "/" + hMove +
            " 动作条=" + bar + " 槽(0选/多选)=" + s0 + "/" + sMulti + " 条高=" + bMulti +
            " 宽=" + window.innerWidth,
        );
        // round78（#3）改写：**入口相等**按新语义作废（没内容就收起 —— 没条时 0 选槽高 0；
        // 有其它条占着时槽高不变）。这是你施工单里接受的那次高度变化，换成两条更具体的判据：
        //   ① 多选时槽真的撑开（槽 ≥ strip —— 只差 0.5px 的容差）
        //   ② 0 选时要么本来就是空的（≤ 2），要么已被别的条占着（不许比多选还矮）
        // **手势中途不变**照旧保留（round26#4 的「偏一格」就是这一步丢的）。
        const strip = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--strip-height"),
        );
        const duringOk = hMulti === hDown && hDown === hMove;
        const entryOk = sMulti >= strip - 0.5 && (s0 <= 2 || sMulti >= s0);
        return h0 > 0 && duringOk && entryOk;
      },
    ],
    // ===== round77 收尾（3.1b）：块内第二行（`block_second_line`）—— 边界表 #12–#15 =====
    [
      "round77：块第二行 —— 已开始→「还剩 X」；已完成/未完成/未开始→时间；切档即时、不写库（边界 #12/#15）",
      async () => {
        await clearSel();
        const { now, dayStart } = slDay();
        // 跑着的那块：起点取 15 分钟网格上「现在 - 30 分」（贴日界时收到 00:00），长 1 小时
        const runStart = Math.max(dayStart, Math.floor(now / 900) * 900 - 1800);
        const runEnd = runStart + 3600;
        // 三个静态块放在**不碰 now / 不碰跑块**的整点时段（清场后一定整宽、够高）
        const hours = [];
        for (let h = 0; h < 24; h++) {
          const s = dayStart + h * 3600;
          if (s + 3600 <= runStart || s >= runEnd) hours.push(s);
        }
        // 不够用就用另一边（期望都是「回退成时间」）—— 早于跑块的叫过去、晚于的叫未来
        const [h1, h2, h3, h4] = [...hours.filter((s) => s + 3600 <= runStart), ...hours.filter((s) => s >= runEnd)];
        await seedSecondLine([
          B("r77sl1", "t1", runStart, runEnd, "elastic", "planned"),
          B("r77sl2", "t1", h1 + 600, h1 + 3600, "elastic", "done"),
          B("r77sl3", "t1", h2 + 600, h2 + 3600, "elastic", "missed"),
          B("r77sl4", "t1", h3 + 600, h3 + 3600, "elastic", "planned"), // 已结束的计划块
          B("r77sl5", "t1", h4 + 600, h4 + 3600, "elastic", "planned"), // 未开始
        ]);
        const sl1Json = JSON.stringify(FIX.blocks.find((b) => b.id === "r77sl1"));
        const ok = await pickAppearance(".block-second-line", "remaining");
        await closeSettings();
        await settle(30);
        const textOf = (id) => el(id)?.querySelector(".time")?.textContent?.trim() ?? "";
        // ① 已开始且未结束 → 「还剩 X」（X 按本段终点算；贴日界时会截到 24:00）
        const expected = Math.ceil((Math.min(runEnd, dayStart + 86400) - now) / 60);
        const t1 = textOf("r77sl1");
        const remainOk =
          (expected <= 2 ? /即将结束/.test(t1) : t1.startsWith("还剩")) &&
          (expected <= 2 || Math.abs(remainMinutesOf(t1) - expected) <= 2);
        // ② 已完成 / 未完成 / 未开始的计划块 → 回退成时间（无「还剩」）
        const others = ["r77sl2", "r77sl3", "r77sl4", "r77sl5"].map(textOf);
        const othersOk = others.every((t) => !!t && !t.includes("还剩") && /\d{1,2}:\d{2}/.test(t));
        // ③ 切档即时生效：remaining → time → remaining
        await pickAppearance(".block-second-line", "time");
        await closeSettings();
        await settle(30);
        const tTime = textOf("r77sl1");
        const instantBack = !tTime.includes("还剩") && /\d{1,2}:\d{2}/.test(tTime);
        await pickAppearance(".block-second-line", "remaining");
        await closeSettings();
        await settle(30);
        const tAgain = textOf("r77sl1");
        const instantAgain = tAgain.startsWith("还剩");
        // ④ 不写库：这一块的字段一字未动（文案是派生出来的，不落库）
        const noWrite = JSON.stringify(FIX.blocks.find((b) => b.id === "r77sl1")) === sl1Json;
        await pickAppearance(".block-second-line", "time"); // 收尾：把档位还给后续断言（默认旧行为）
        await closeSettings();
        await restoreSecondLine();
        window.__DIAG.push(
          "r77第二行 档位=" + ok + " 跑块=[" + t1 + "] 期望≈" + expected + "分/" + remainOk +
            " 其余=[" + others.join("|") + "]/" + othersOk + " 切回时间=" + instantBack +
            " 再切只剩=" + instantAgain + " 不写库=" + noWrite,
        );
        return ok && remainOk && othersOk && instantBack && instantAgain && noWrite;
      },
    ],
    [
      "round77：块第二行 —— 跨天按本段算；矮块/并排块不显示；残影回退时间（边界 #12/#13/#14）",
      async () => {
        await clearSel();
        const { now, dayStart, dayEnd } = slDay();
        // 跑块时段（残影用）：起点取 15 分钟网格上「现在 - 30 分」
        const runStart = Math.max(dayStart, Math.floor(now / 900) * 900 - 1800);
        const runEnd = runStart + 3600;
        // ① 跨天块：[昨天 23:00, 明天 06:00] —— now 恒在「今天」那一段；整块剩余比本段多 6 小时
        const cross = B("r77sl1", "t1", dayStart - 3600, dayEnd + 6 * 3600, "elastic", "planned");
        await seedSecondLine([cross]);
        await pickAppearance(".block-second-line", "remaining");
        await closeSettings();
        await settle(30);
        const parts = [...document.querySelectorAll('[data-block-id="r77sl1"]')];
        // 跨天块在整周里有**多段**（昨天/今天/明天…）；「现在」所在的那段要用**今天列**来找
        const dayIdx = Math.floor((now - at(0, 0, 0)) / 86400);
        const todayPart = parts.find((p) => dayBody(dayIdx).contains(p));
        const first = todayPart?.querySelector(".time")?.textContent?.trim() ?? "";
        const expected = Math.ceil((dayEnd - now) / 60);
        const segOk =
          (expected <= 2 ? /即将结束/.test(first) : first.startsWith("还剩")) &&
          (expected <= 2 || Math.abs(remainMinutesOf(first) - expected) <= 2);
        const wholeMin = Math.ceil((cross.end_at - now) / 60);
        // 不按整块算：整块比本段多 6 小时（±1 分钟内算通过）
        const notWhole = expected <= 2 || Math.abs(remainMinutesOf(first) - wholeMin) > 60;
        // 其余段（昨天/明天）一个都不许接「还剩」；且至少有一段真的画了时间（否则判据什么都没验到）
        const otherSegs = parts
          .filter((p) => p !== todayPart)
          .map((p) => p.querySelector(".time")?.textContent?.trim() ?? "");
        const nextSegOk =
          otherSegs.every((t) => !t.includes("还剩")) && otherSegs.some((t) => /\d{1,2}:\d{2}/.test(t));
        // ② 矮块（30 分钟）不显示 + 并排两块（narrow）不显示 + 残影（postponed_from）回退时间
        const free = [];
        for (let h = 0; h < 24; h++) {
          const s = dayStart + h * 3600;
          // round79（测试假红修复）：空档要**留够余量** —— 窄块对从 `hNarrow` 起要占 1h20m，
          // 若它的尾巴压到 `runStart` 起的残影块上，残影那一格就会变成「并排」→ `narrow` → 不画第二行
          // → `残影=[]` 假红（实测：`runStart=22:15` 时，21:00 起的那对尾部 22:20 正好压上去；
          // 这个断言因此**按时钟**时红时绿）。判据改成：要么整段离 runStart 够远，要么排在 runEnd 之后。
          if (s + 5700 <= runStart || s >= runEnd) free.push(s);
        }
        const hShort = free[0];
        const hNarrow = free[free.length - 1];
        await seedSecondLine([
          B("r77sl2", "t1", hShort + 600, hShort + 2400, "elastic", "planned"), // 30 分钟 → 矮
          Object.assign(B("r77sl3", "t1", runStart, runEnd, "elastic", "planned"), {
            postponed_from: "b6", // 残影：跑着也不该接「还剩」（边界 #12 最后一档）
          }),
          B("r77sl4", "t1", hNarrow + 300, hNarrow + 3900, "elastic", "planned"),
          B("r77sl5", "t1", hNarrow + 1200, hNarrow + 4800, "elastic", "planned"),
        ]);
        await settle(30);
        const noTime = (id) => {
          const n = el(id);
          return !!n && !n.querySelector(".time"); // 块在 DOM 里但没有第二行（不是「压根没渲染」的假绿）
        };
        const shortOk = noTime("r77sl2"); // 矮 → 不显示
        const narrowOk = noTime("r77sl4") && noTime("r77sl5"); // 并排（narrow）→ 不显示
        const ghostText = el("r77sl3")?.querySelector(".time")?.textContent?.trim() ?? "";
        const ghostOk = ghostText !== "" && !ghostText.includes("还剩") && /\d{1,2}:\d{2}/.test(ghostText);
        await pickAppearance(".block-second-line", "time"); // 收尾：档位还给后续断言
        await closeSettings();
        await restoreSecondLine();
        window.__DIAG.push(
          "r77第二行·跨天 段数=" + parts.length + " 本段=[" + first + "]/期望≈" + expected + "分/" + segOk +
            " 整块≈" + wholeMin + "分/不按整块=" + notWhole + " 其它段=[" + otherSegs.join("|") + "]/" + nextSegOk +
            " 段明细=" + parts.map((p) => (p.className || "?") + "[" + (p.textContent ?? "").trim().slice(0, 18) + "]").join(" / ") +
            " 矮不显示=" + shortOk + " 并排不显示=" + narrowOk + " 残影=[" + ghostText + "]/" + ghostOk,
        );
        return segOk && notWhole && nextSegOk && shortOk && narrowOk && ghostOk;
      },
    ],
    [
      "round77：头部内容行 ≤2 / 提示条同屏一条 / 块上动作不出时间轴（1500 与 715 都跑）",
      async () => {
        await press("Escape");
        await press("Escape");
        setScrollHome();
        await settle(30);
        const head = document.querySelector(".timeline .head");
        // 只数**内容行**（周范围/跳周/动作组…）—— 提示/键位那条固定槽不算一行；
        // 同一行里元素基线对齐，top 会差几像素 → 按 ±8px 归并成「行」
        const bands = [];
        const kids = [...head.querySelectorAll(":scope > *:not(.hint-slot)")];
        for (const t of kids
          .map((n) => n.getBoundingClientRect().top)
          .sort((a, b) => a - b)) {
          if (!bands.length || t - bands[bands.length - 1] > 8) bands.push(t);
        }
        const contentRows = bands.length;
        const kidLine = kids
          .map((n) => "{" + ((n.className || "?") + "").split(" ")[0] + "@" + Math.round(n.getBoundingClientRect().top) + "x" + Math.round(n.getBoundingClientRect().width) + ":" + getComputedStyle(n).fontSize + "}")
          .join("");
        const headOverflow = head.scrollWidth + ">" + head.clientWidth + " 子:" + kids.map((n) => n.scrollWidth).join(",");
        const kidGeom = [...head.querySelectorAll(":scope > *")]
          .map((n) => ((n.className || "?") + "").split(" ")[0] + ":" + n.offsetLeft + "+" + n.offsetWidth + "/sw" + n.scrollWidth)
          .join(" ");
        const bars = [".sanity", ".nudge", ".guide-bar"].filter((s) => {
          const n = document.querySelector(s);
          return !!n && n.offsetParent !== null && n.getBoundingClientRect().height > 0;
        });
        const scroll = document.querySelector(".scroll").getBoundingClientRect();
        const pane = document.querySelector(".timeline").getBoundingClientRect();
        const btns = [...document.querySelectorAll("[data-block-id] .actions button")];
        const onScreen = btns.filter((b) => {
          const r = b.getBoundingClientRect();
          return r.right > scroll.left && r.left < scroll.right && r.bottom > scroll.top && r.top < scroll.bottom;
        });
        const small = onScreen.filter((b) => {
          const r = b.getBoundingClientRect();
          // round82（11.2）：并排块（2/3+ 列）的浮层按钮是 24×24（WCAG 2.5.8 下限，已验收的例外）；
          // 其余（常规块）仍要求 ≥32
          const narrow = !!b.closest(".block.narrow");
          const min = narrow ? 23.5 : 31.5;
          return r.width < min || r.height < min;
        }).length;
        // 前两列的浮层允许压到刻度栏（左缘）—— 只登记数字，不判红
        const inGutter = onScreen.filter((b) => b.getBoundingClientRect().left < scroll.left).length;
        // 硬判据：按钮的**横向大半截**必须在时间轴面板里 —— 浮层允许超出块/压刻度栏；
        // 竖向不判（块贴在滚动视口的上/下缘时浮层被切一半是正常的，滚一下就到）
        const mostlyOut = onScreen.filter((b) => {
          const r = b.getBoundingClientRect();
          const visW = Math.min(r.right, pane.right) - Math.max(r.left, pane.left);
          return visW < r.width * 0.6;
        }).length;
        // 6b P2：固定槽是**下限** —— 提示条在场时不许比槽高（compact 档曾 28>26，条一出现就把头部顶高 2px）
        const stripNow = () =>
          parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--strip-height"));
        const barNatural = () => {
          const n = document.querySelector(".sanity");
          return n ? Math.round(n.getBoundingClientRect().height * 10) / 10 : -1;
        };
        const comfortSlot = { strip: stripNow(), bar: barNatural() };
        const okComfort = comfortSlot.bar < 0 || comfortSlot.bar <= comfortSlot.strip + 0.5;
        await pickAppearance(".text-density", "compact");
        await closeSettings();
        await settle(30);
        const compactSlot = { strip: stripNow(), bar: barNatural() };
        const okCompact = compactSlot.bar < 0 || compactSlot.bar <= compactSlot.strip + 0.5;
        await pickAppearance(".text-density", "comfortable");
        await closeSettings();
        await settle(30);
        window.__DIAG.push(
          "走查 宽=" + window.innerWidth + " 头部内容行=" + contentRows + " 头高=" + headHeight() +
            " 孩子们=" + kidLine + " headScroll=" + headOverflow + " 几何=" + kidGeom +
            " 提示条=" + bars.length + "[" + bars.join(",") + "] 屏内动作按钮=" + onScreen.length +
            " 小于32=" + small + " 大半出面板=" + mostlyOut + " 压刻度栏=" + inGutter +
            " 槽(舒适/紧凑)=" + comfortSlot.strip + "/" + compactSlot.strip +
            " 条(" + comfortSlot.bar + "/" + compactSlot.bar + ") 槽够=" + okComfort + "/" + okCompact,
        );
        return (
          contentRows <= 2 &&
          bars.length <= 1 &&
          onScreen.length > 0 &&
          small === 0 &&
          mostlyOut === 0 &&
          okComfort &&
          okCompact
        );
      },
    ],
    // ===== round29 #3/#7：临时块漂出去要跟父块名字一致 =====
    // 放在这一组（**本周还被前面的拉伸铺满之前**）跑：漂流的建议时段来自「本周剩余空档」，
    // 而后面的断言会把周五~周一整段铺满 ✗ —— 那时候漂流卡只会说「已经排满了」。
    [
      "round29 #3/#7：命名的临时块漂出去 → 子块继承父块名字（本周没空档时跳过；后端铁证在 cargo）",
      async () => {
        // 周日 08:00 一片空 → 双击建临时块，就地命名「浇花」
        focusBodyY(yAt(8, 0));
        await settle();
        dblclickAt(6, 8, 0);
        await settle(20);
        const input = document.activeElement;
        if (!input || input.tagName !== "INPUT") return false;
        const id = input.closest("[data-block-id]")?.getAttribute("data-block-id") ?? "";
        input.value = "浇花";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
        await settle(20);
        const labeled = FIX.blocks.find((b) => b.id === id)?.label ?? null;
        // 标记未完成 → 漂流卡 → 挑一个建议时段（走真 store 的 postpone 链路）
        const miss = document.querySelector(
          '[data-block-id="' + id + '"] button[title="标记未完成"]',
        );
        if (!miss) return false;
        miss.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const slot = document.querySelector(".drift .slots button.slot");
        const hadSlot = !!slot;
        if (slot) {
          slot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(30);
        }
        const child = FIX.blocks.find((b) => b.postponed_from === id);
        const childName =
          (child &&
            document.querySelector('[data-block-id="' + child.id + '"] .name')?.textContent?.trim()) ??
          "(不在 DOM 里)";
        window.__DIAG.push(
          "漂流继承名字 父label=" + labeled + " 有建议时段=" + hadSlot + " 子块label=" +
            (child?.label ?? "-") + " 子块显示名=" + childName,
        );
        setScrollHome();
        await settle();
        // ⚠️ 诚实标注：**周日晚上 / 本周快过完时，漂流卡本来就给不出建议时段**（那是设计：
        //   只推荐**本周之内**的时间）——那时这条自动跳过（不代表验过了，只是没得验）。
        //   后端语义（新块要继承 label）的铁证在 `src-tauri/src/db.rs` 的
        //   `test_postpone_inherits_label`（真红过 → 修后绿）。
        if (!hadSlot) return true;
        return !!child && child.label === "浇花" && childName === "浇花";
      },
    ],
    // ===== round27：你 round26 验收回的 8 条 =====
    [
      "round27 #4：任务属性面板里那个「弹性任务」勾选框已删（现在只留预估/分类/归档）",
      async () => {
        const gear = document.querySelector(".item button.props-toggle");
        if (!gear) return false;
        gear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle();
        const panel = document.querySelector(".props");
        const hasCheckbox = !!panel?.querySelector('input[type="checkbox"]');
        const hasEstimate = !!panel?.querySelector("input.num");
        const label = panel?.textContent ?? "";
        gear.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 收起面板
        await settle();
        window.__DIAG.push("属性面板 有勾选框=" + hasCheckbox + " 有预估=" + hasEstimate + " 文案=" + label.replace(/\s+/g, "").slice(0, 20));
        return !hasCheckbox && hasEstimate && !label.includes("弹性任务");
      },
    ],
    [
      "round27 #5：从 Backlog 拖出来用**任务预估**时长（t4 预估 75 → 75 分钟；没填的 t1 → 30 分钟）",
      async () => {
        const items = [...document.querySelectorAll(".item")];
        const target = items.find((el) => rowLabel(el).startsWith("健身")); // t4，预估 75
        if (!target) return false;
        const r = target.querySelector(".label").getBoundingClientRect(); // round48：别抓行左缘（那是抓手）
        firePointer("pointerdown", r.left + 8, r.top + r.height / 2);
        const p = dragToDay(2, 15, 0);
        await settle();
        const hint = document.querySelector(".gesture-hint")?.textContent?.trim() ?? "";
        dragRelease(p.x, p.y);
        await settle(20);
        const created = FIX.blocks.find((b) => b.task_id === "t4" && b.start_at === at(2, 15, 0));
        const mins = created ? Math.round((created.end_at - created.start_at) / 60) : -1;
        window.__DIAG.push("预估时长 提示=" + hint + " 落库分钟=" + mins);
        return mins === 75 && hint.includes("16:15") && hint.includes("1 小时 15 分");
      },
    ],
    [
      "round27 #3：把漂流链上的那块拖到别的同任务块上 → 后端回报原因，界面把原因说出来",
      async () => {
        // round30：改成**自带可靠现场** —— 拿漂流链上的 b24 去撞一个同任务、且没在漂流链上的块。
        // （以前是用 b14 去撞 b24；假后端不做融合时看着能过，一旦假后端照真语义融合，
        //  b14 会先被别的同任务邻居吃掉 → 根本到不了 b24 ✗ 这类现场在真机上也一样）
        const driftBlock = FIX.blocks.find((x) => x.id === "b24");
        if (!driftBlock) {
          window.__DIAG.push("融合提示 b24 不在了");
          return false;
        }
        // round57：改成挑**离 b24 最近**的同任务块 —— 旧的「取第一个」会挑到被前面断言挪到凌晨的块，
        // 落点跑出可视区被钳到 00:00 → 什么都碰不到 → 提示根本弹不出来（这是测试现场的脆弱，不是放宽要求）。
        const partner = FIX.blocks
          .filter(
            (x) =>
              x.task_id === "t2" &&
              x.id !== "b24" &&
              x.status === "planned" &&
              // 必须在**本周窗口**里（b11 是两周后的靶子块，拖不过去）
              x.start_at >= at(0, 0, 0) &&
              x.start_at < at(7, 0, 0) &&
              !x.postponed_from &&
              !FIX.blocks.some((y) => y.postponed_from === x.id) &&
              !FIX.sequences.some((s) => s.members.some((m) => m.block_id === x.id)),
          )
          .sort(
            (a, b) =>
              Math.abs(a.start_at - driftBlock.start_at) -
              Math.abs(b.start_at - driftBlock.start_at),
          )[0];
        if (!partner) {
          window.__DIAG.push("融合提示 没找到可拖的 partner");
          return false;
        }
        focusBlock("b24");
        await settle();
        if (!dragStartBlock("b24")) {
          window.__DIAG.push("融合提示 b24 拖不起来");
          return false;
        }
        const dayIdx = Math.floor((partner.start_at - at(0, 0, 0)) / 86400);
        if (dayIdx < 0 || dayIdx > 6) {
          window.__DIAG.push("融合提示 partner 不在本周：dayIdx=" + dayIdx);
          return false;
        }
        const p = dragToDay(
          dayIdx,
          Math.floor((partner.start_at - at(dayIdx, 0, 0)) / 3600),
          Math.round(((partner.start_at - at(dayIdx, 0, 0)) % 3600) / 60),
        );
        await settle();
        dragRelease(p.x, p.y);
        await settle(20);
        const toast = [...document.querySelectorAll(".toast")].map((n) => n.textContent.trim()).join(" | ");
        const b24 = FIX.blocks.find((b) => b.id === "b24");
        window.__DIAG.push(
          "融合提示 拖的是漂流链上的块 → partner=" + partner.id + " b24在=" +
            (b24 ? (b24.start_at - at(dayIdx, 0, 0)) / 1800 + "格" : "没了") +
            " toast=" + toast.slice(-120),
        );
        return toast.includes("漂流链");
        return true;
      },
    ],
    [
      "round27 #6：拉伸时**下一列也跟着长**（松手之前就看得见，不再只长本列）",
      async () => {
        tallViewport();
        await settle();
        focusBlock("b25"); // 周一 12:00–13:00
        await settle();
        const handle = document.querySelector('[data-block-id="b25"] .edge-bottom');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const r0 = handle.getBoundingClientRect();
        handle.dispatchEvent(ptrEvent("pointerdown", r0.left + 30, r0.bottom));
        const tue = dayBody(1).getBoundingClientRect();
        const targetX = tue.left + 30;
        const targetY = tue.top + yAt(9, 0); // 周二 09:00 → 跨天 21 小时
        handle.dispatchEvent(ptrEvent("pointermove", targetX, targetY));
        await settle();
        // **松手之前**就该看到周二那一列的那一截
        const parts = [...document.querySelectorAll('[data-block-id="b25"]')];
        const tueTop = topInDay("b25", 1);
        const tueHeight = parts.length === 2 ? parts[1].getBoundingClientRect().height : -1;
        handle.dispatchEvent(ptrEvent("pointerup", targetX, targetY));
        await settle(20);
        restoreViewport();
        setScrollHome();
        await settle();
        window.__DIAG.push(
          "预览跨列 段数=" + parts.length + " 周二段top=" + Math.round(tueTop) +
            " 周二段高=" + Math.round(tueHeight) + " 期望=" + yAt(9, 0),
        );
        return parts.length === 2 && tueTop <= 4 && Math.abs(tueHeight - yAt(9, 0)) <= 4;
      },
    ],
    [
      "round27 #7：小牌按天数说人话（次日 / 前一日 / +2 天）—— 拉到第 3 天以后也不再消失",
      async () => {
        tallViewport();
        await settle();
        focusBlock("b26"); // 周三 10:00–11:00
        await settle();
        const chips = () =>
          [...document.querySelectorAll(".align-label.day-chip")].map((n) => n.textContent.trim());
        const hint = () => document.querySelector(".gesture-hint")?.textContent?.trim() ?? "";
        // ① 下边缘 → 周四 09:00（跨一天）：应当有「次日」与「前一日」两个牌
        const bottom = document.querySelector('[data-block-id="b26"] .edge-bottom');
        if (!bottom) return false;
        bottom.setPointerCapture = () => {};
        bottom.releasePointerCapture = () => {};
        const rb = bottom.getBoundingClientRect();
        bottom.dispatchEvent(ptrEvent("pointerdown", rb.left + 30, rb.bottom));
        const thu = dayBody(3).getBoundingClientRect();
        bottom.dispatchEvent(ptrEvent("pointermove", thu.left + 30, thu.top + yAt(9, 0)));
        await settle();
        const oneDay = chips();
        bottom.dispatchEvent(ptrEvent("pointerup", thu.left + 30, thu.top + yAt(9, 0)));
        await settle(20);
        // ② 上边缘 → 周二 09:00（回跳到两天前）：小牌要写 +2 天 / 前 2 天
        const top = document.querySelector('[data-block-id="b26"] .edge-top');
        if (!top) return false;
        top.setPointerCapture = () => {};
        top.releasePointerCapture = () => {};
        const rt = top.getBoundingClientRect();
        top.dispatchEvent(ptrEvent("pointerdown", rt.left + 30, rt.top));
        const tue = dayBody(1).getBoundingClientRect();
        top.dispatchEvent(ptrEvent("pointermove", tue.left + 30, tue.top + yAt(9, 0)));
        await settle();
        const twoDays = chips();
        const twoDayHint = hint();
        top.dispatchEvent(ptrEvent("pointerup", tue.left + 30, tue.top + yAt(9, 0)));
        await settle(20);
        restoreViewport();
        setScrollHome();
        await settle();
        window.__DIAG.push(
          "小牌 跨一天=" + oneDay.join("/") + " 跨两天=" + twoDays.join("/") + " 提示=" + twoDayHint,
        );
        return (
          oneDay.join(",") === "次日 09:00,前一日 10:00" &&
          twoDays.join(",") === "+2 天 09:00,前 2 天 09:00"
        );
      },
    ],
    [
      "round27 #8：把块甩出最右边并停住 ~0.6 秒 → 自动翻到下一周（块还在手上，落地在新一周）",
      async () => {
        const weekLabel = () => document.querySelector(".range")?.textContent?.trim() ?? "";
        focusBlock("b27"); // 周五 14:00–15:00
        await settle();
        const src = document.querySelector('[data-block-id="b27"]');
        if (!src) return false;
        const before = weekLabel();
        const r = src.getBoundingClientRect();
        firePointer("pointerdown", r.left + 18, r.top + r.height / 2);
        const sun = dayBody(6).getBoundingClientRect();
        dragToPoint(sun.right + 40, sun.top + yAt(14, 0)); // 甩出日列区右边
        await settle();
        const inHand = [...document.body.children].some(
          (el) => el.style.position === "fixed" && el.style.zIndex === "9999",
        );
        await waitMs(900); // 停住 > 0.6 秒
        const flipped = weekLabel() !== before;
        const p = dragToDay(1, 10, 0); // 新一周的周二 10:00
        await settle();
        dragRelease(p.x, p.y);
        await settle(20);
        const landed = Math.abs(topInDay("b27", 1) - yAt(10, 0)) <= 20;
        const stored = FIX.blocks.find((b) => b.id === "b27");
        const inNextWeek = !!stored && stored.start_at > at(6, 0, 0);
        // 回到本周（翻周会把「跟随现在」关掉 → 用顶部那个「回到本周」按钮）
        document.querySelector(".week-nav .now")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        setScrollHome();
        await settle();
        window.__DIAG.push(
          "翻周 手上=" + inHand + " 翻过去了=" + flipped + " 落点准=" + landed +
            " 落库在新一周=" + inNextWeek + " 周标签=" + before + "→" + weekLabel(),
        );
        return inHand && flipped && landed && inNextWeek;
      },
    ],
    // ===== round28：你 round27 验收回的 8 条 =====
    [
      "round28 #1：跨天块的**每一段只说这一段**（不再两段都写整块区间）",
      () => {
        // b12 由前面 round24 那条拉成了周六 20:00 → 周日 01:00（周六 20:00-24:00 + 周日 00:00-01:00）
        const parts = [...document.querySelectorAll('[data-block-id="b12"]')];
        const dump = parts.map((el) => ({
          time: el.querySelector(".time")?.textContent?.trim() ?? "",
          mark: el.parentElement.querySelector(".cont-mark")?.textContent?.trim() ?? "",
          title: el.getAttribute("title") ?? "",
        }));
        window.__DIAG.push("分段文本 " + JSON.stringify(dump));
        return (
          dump.length === 2 &&
          dump[0].time === "20:00–00:00" && // 24:00 格式化成 00:00（同一天午夜）
          dump[0].mark === "续到次日 01:00" &&
          dump[1].time === "00:00–01:00" &&
          dump[1].mark === "上接" &&
          dump[0].title.includes("20:00–01:00") // 悬停能看到整段
        );
      },
    ],
    [
      "round28 #2：归档任务不出现在 Backlog，但它在时间轴上的块**仍有名字**",
      async () => {
        const listed = [...document.querySelectorAll(".item")].map((el) => rowLabel(el));
        const inBacklog = listed.some((t) => t.startsWith("归档过的老任务"));
        focusBlock("b29");
        await settle();
        const name = document.querySelector('[data-block-id="b29"] .name')?.textContent?.trim() ?? "";
        setScrollHome();
        await settle();
        window.__DIAG.push(
          "归档任务 Backlog里=" + inBacklog + " 块名=[" + name + "] Backlog项=" + listed.join("/"),
        );
        return !inBacklog && name === "归档过的老任务";
      },
    ],
    [
      "round28 #6：预估 50 分钟 → 拖出来 **60** 分钟（向上取整，不再四舍五入成 45）",
      async () => {
        const items = [...document.querySelectorAll(".item")];
        const target = items.find((el) => rowLabel(el).startsWith("修 bug")); // t2：预估 50
        if (!target) return false;
        // round30：假后端现在真的会融合（照真语义）→ 得挑一个 t2 真空着的格子，
        // 否则新块会跟同任务的邻居合掉，「预估 50 → 60 分钟」就量不到了
        // （真机上也会这么合 —— 那不是这条要验的事）
        let slot = null;
        for (let d = 0; d < 7 && !slot; d++) {
          for (let hh = 8; hh <= 20; hh++) {
            const s0 = at(d, hh, 0);
            const e0 = s0 + 3600;
            const clash = FIX.blocks.some(
              (b) => b.task_id === "t2" && b.start_at < e0 && b.end_at > s0,
            );
            if (!clash) {
              slot = [d, hh];
              break;
            }
          }
        }
        if (!slot) return false;
        const r = target.querySelector(".label").getBoundingClientRect(); // round48：别抓行左缘（那是抓手）
        firePointer("pointerdown", r.left + 8, r.top + r.height / 2);
        const p = dragToDay(slot[0], slot[1], 0);
        await settle();
        const hint = document.querySelector(".gesture-hint")?.textContent?.trim() ?? "";
        dragRelease(p.x, p.y);
        await settle(20);
        const created = FIX.blocks.find(
          (b) => b.task_id === "t2" && b.start_at === at(slot[0], slot[1], 0),
        );
        const mins = created ? Math.round((created.end_at - created.start_at) / 60) : -1;
        window.__DIAG.push(
          "预估 50 → 落库分钟=" + mins + " 落点=" + slot[0] + "日" + slot[1] + ":00 提示=" + hint,
        );
        return mins === 60 && hint.includes(slot[1] + ":00") && hint.includes(slot[1] + 1 + ":00");
      },
    ],
    [
      "round28 #7 + round29 #4：停在边上接着翻，但是**两段式**（首屏 600ms、之后每 900ms）",
      async () => {
        const weekFrom = () => {
          const w = (window.__DBG || []).slice(-1)[0] || [];
          return w[0] ?? 0;
        };
        focusBlock("b29"); // 周二 12:00 那块（b27 已被上一条搬到下一周，不在本周 DOM 里）
        await settle();
        const src = document.querySelector('[data-block-id="b29"]');
        if (!src) return false;
        const before = weekFrom();
        const r = src.getBoundingClientRect();
        firePointer("pointerdown", r.left + 18, r.top + r.height / 2);
        const sun = dayBody(6).getBoundingClientRect();
        dragToPoint(sun.right + 40, sun.top + yAt(14, 0));
        await settle();
        // 两段式（round29 #4，你回的那句「稍稍稍稍微快了一点点」）：
        // 1300ms 时**只应翻 1 页**（旧的 600ms 等间隔在这时候已经翻了 2 页 —— 1200ms 那次；
        // 这就是红的地方）；再等到 ~1700ms（600 + 900）才第 2 页。
        await waitMs(1300);
        const onePage = Math.round((weekFrom() - before) / (7 * 86400));
        await waitMs(400);
        const after = weekFrom();
        dragRelease(sun.right - 200, sun.top + yAt(14, 0)); // 松在列里，不落库也无所谓
        await settle(20);
        document.querySelector(".week-nav .now")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        setScrollHome();
        await settle();
        const pages = Math.round((after - before) / (7 * 86400));

        window.__DIAG.push(
          "连续翻页（两段式 600+900） 1300ms=" + onePage + " 页；~1700ms=" + pages + " 页",
        );

        return onePage === 1 && pages === 2;
      },
    ],
    [
      "round28 #8：**拉伸**也能甩出边缘翻周（以前只有拖动可以）",
      async () => {
        const weekFrom = () => ((window.__DBG || []).slice(-1)[0] || [])[0] ?? 0;
        tallViewport();
        await settle();
        focusBlock("b30"); // 周五 16:00–17:00
        await settle();
        const before = weekFrom();
        const handle = document.querySelector('[data-block-id="b30"] .edge-bottom');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const rb = handle.getBoundingClientRect();
        handle.dispatchEvent(ptrEvent("pointerdown", rb.left + 30, rb.bottom));
        const sun = dayBody(6).getBoundingClientRect();
        handle.dispatchEvent(ptrEvent("pointermove", sun.right + 40, sun.top + yAt(16, 0)));
        await settle();
        await waitMs(900); // 停住 ~0.6s → 翻周
        const flipped = weekFrom() !== before;
        const stillResizing =
          (document.querySelector(".gesture-hint")?.textContent ?? "").includes("正在调整");
        // ⚠️ 翻周会重建时间轴 DOM → 原来那个把手元素已经不在文档里（它的事件传不到 window）→
        //    后面的指针事件改从**文档里的活元素**发（window 上的监听是产品真正依赖的那条路）。
        const hint = () => document.querySelector(".gesture-hint")?.textContent?.trim() ?? "(无)";
        // 指针事件**直接发给 window**（产品那条监听就在这里）—— 绕开「DOM 被重建、元素已换人」的问题。
        // 先移回板子里停一下：停在边上会**继续翻**（round28 #7 要的行为），
        // 不移开的话目标列会多翻一周、被 72 小时上限夹住（我第一次就栽在这里）。
        window.dispatchEvent(ptrEvent("pointermove", sun.left + 60, sun.top + yAt(16, 0)));
        await settle();
        const hintBack = hint();
        // 再放到（新一周的）周一 10:00 松手
        const mon = dayBody(0).getBoundingClientRect();
        const tx = mon.left + 30;
        const ty = mon.top + yAt(10, 0);
        window.dispatchEvent(ptrEvent("pointermove", tx, ty));
        await settle();
        const hintAfterMove = hint();
        window.dispatchEvent(ptrEvent("pointerup", tx, ty));
        await settle(20);
        restoreViewport();
        document.querySelector(".week-nav .now")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        setScrollHome();
        await settle();
        const stored = FIX.blocks.find((b) => b.id === "b30");
        const endInNextWeek = !!stored && stored.end_at > before + 7 * 86400;
        window.__DIAG.push(
          "拉伸跨周 翻了=" + flipped + " 手势还在=" + stillResizing +
            " 终点落到下周=" + endInNextWeek + " 时长h=" +
            (stored ? Math.round((stored.end_at - stored.start_at) / 360) / 10 : -1) +
            " 移回后提示=" + hintBack + " 移动后提示=" + hintAfterMove +

            " before=" + before + " stored=" + (stored ? stored.start_at + ".." + stored.end_at : "-")
        );
        return flipped && stillResizing && endInNextWeek;
      },
    ],
    // ===== round29：跨周拉伸（#5 绿条没跟上来 / #6 松手后当场消失）=====
    [
      "round29 #5：跨周拉伸时，绿条（预览的块）要跟着手势画到新的一周",
      async () => {
        const r = await crossWeekStretch("b31");
        if (!r) return false;
        const top = topInDay("b31", 0); // -1 = 新一周根本没画这块
        const box = [...document.querySelectorAll('[data-block-id="b31"]')].find((n) =>
          dayBody(0).contains(n),
        );
        const hh = box?.getBoundingClientRect().height ?? -1;
        window.__DIAG.push(
          "跨周拉伸预览 翻了=" + r.flipped + " 新一周top=" + Math.round(top) + " 高=" + Math.round(hh) +
            " 指针=(" + Math.round(r.px) + "," + Math.round(r.py) + ")",
        );
        // Esc = 取消手势：不落库，下一条断言才能从「原样」重来
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle(20);
        await backToThisWeek();
        return (
          r.flipped && top >= 0 && Math.abs(top - 1) <= 4 && Math.abs(hh - (5.5 * slotH() - 2)) <= 6
        );
      },
    ],
    [
      "round29 #6：跨周拉伸**松手后当场**就能在新一周看到它（不再要翻走再翻回来）",
      async () => {
        const r = await crossWeekStretch("b31");
        if (!r) return false;
        window.dispatchEvent(ptrEvent("pointerup", r.px, r.py));
        await settle(30);
        const top = topInDay("b31", 0);
        const stored = FIX.blocks.find((b) => b.id === "b31");
        const inNextWeek = !!stored && stored.end_at > at(7, 0, 0);
        // 只看 b31 那一条：假数据里那个「凭空多出来的下一周块」和真 b9 撞了 id，
        // 还欠债 AK 已还：注入块改叫 `bphantom`（不再与本周的 `b9` 撞 id）→ **只排除它这一条已知假阳性**，
        // 其余一律算数（以前是按 `b31(` 白名单过滤，等于放过了其他所有不一致）
        const bad = dbViewMismatch().filter((s) => !s.startsWith("bphantom("));
        window.__DIAG.push(
          "跨周拉伸松手 翻了=" + r.flipped + " 落库到下周=" + inNextWeek + " 新一周top=" +
            Math.round(top) + " 视图与库不一致=" + JSON.stringify(bad),
        );
        await backToThisWeek();
        return r.flipped && inNextWeek && top >= 0 && Math.abs(top - 1) <= 4 && bad.length === 0;
      },
    ],
    [
      "round29 #5（对照）：跨周**拖动**时落点指示线不该丢（列填满布局：探针落在末列**右端内侧**）",
      async () => {
        focusBlock("b32");
        await settle();
        const src = document.querySelector('[data-block-id="b32"]');
        if (!src) return false;
        const rb = src.getBoundingClientRect();
        firePointer("pointerdown", rb.left + 18, rb.top + rb.height / 2);
        const sun = dayBody(6).getBoundingClientRect();
        // round81（宽-03）：列改成一有富余就填满 → 末列右边**再没有**“板内空白区”（旧探针的 `+40`
        // 会飞到板外 → 落点合法为 null）。探针改列内右端 3px，验的还是“靠右边缘时指示线不丢”。
        dragToPoint(sun.right - 3, sun.top + yAt(14, 0));
        await settle();
        const before = lastWinFrom();
        await waitMs(900);
        const line = document.querySelector(".drop-line");
        const col = line ? [...document.querySelectorAll(".day-body")].indexOf(line.parentElement) : -1;
        const panel = document.querySelector(".scroll").getBoundingClientRect();
        window.__DIAG.push(
          "跨周拖动 翻了=" + (lastWinFrom() !== before) + " 指示线=" + !!line + " 列=" + col +
            " 指针x=" + Math.round(sun.right - 3) + " 面板right=" + Math.round(panel.right) +
            " 末列right=" + Math.round(sun.right),
        );
        dragReleaseOutside(); // 松在 Backlog 那侧 → 不落库，块原地不动
        await settle(20);
        await backToThisWeek();
        return !!line && col === 6;
      },
    ],
    [
      "round29 #8：跨天块的每一段带段号角标 1/2、2/2",
      () => {
        // b12：前面 round24 那条把它拉成周六 20:00 → 周日 01:00（两段，正好两个角标的靶子）
        // 段内时间文本不在这里验：跑到这一步时 b30 已经横跨周五→周一，把 b12 压成 narrow，
        // narrow 块本来就不显示时间（round28 #1 那条在早先的状态里已经验过 20:00–00:00 / 00:00–01:00 ✓）
        const parts = [...document.querySelectorAll('[data-block-id="b12"]')];
        const badge = (el) => el.querySelector(".seg-index")?.textContent?.trim() ?? "";
        const time = (el) => el.querySelector(".time")?.textContent?.trim() ?? "(窄块不显示)";
        // 角标不许跑到块外面、也不许悬在块下半（免得跟 ✓/✗ 那排按钮抢位置）
        const geom = parts.map((el) => {
          const b = el.querySelector(".seg-index")?.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          if (!b) return { inside: false, topHalf: false };
          return {
            inside: b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1,
            topHalf: b.top - r.top < r.height / 2,
          };
        });
        window.__DIAG.push(
          "段号角标 " + JSON.stringify(parts.map((el) => badge(el) + "@" + time(el))) +
            " 位置=" + JSON.stringify(geom),
        );
        return (
          parts.length === 2 &&
          badge(parts[0]) === "1/2" &&
          badge(parts[1]) === "2/2" &&
          geom.every((g) => g.inside && g.topHalf)
        );
      },
    ],
    [
      "round30（老账）：新建任务 → 上下放两块 → 把下面那块上边缘拉到上面那块上面 → 界面必须只剩一块",
      async () => {
        // ① 新建一个干净的任务（照用户的步骤：「新建了一个 1」）
        const field = document.querySelector(".new-task .field");
        if (!field) return false;
        field.value = "合并测试";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        document
          .querySelector(".new-task")
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await settle(20);
        const task = FIX.tasks.find((t) => t.title === "合并测试");
        if (!task) return false;

        // ② 周日 09:00 / 12:00 各放一块（这一片空着；后面才被别的断言用掉）
        focusBodyY(yAt(11, 0));
        await settle();
        for (const [hh, mm] of [[9, 0], [12, 0]]) {
          const item = [...document.querySelectorAll(".item")].find((el) =>
            rowLabel(el).includes("合并测试"),
          );
          if (!item) return false;
          const ri = item.querySelector(".label").getBoundingClientRect(); // round48：别抓行左缘（那是抓手）
          firePointer("pointerdown", ri.left + 8, ri.top + ri.height / 2);
          const p = dragToDay(6, hh, mm);
          await settle();
          dragRelease(p.x, p.y);
          await settle(20);
        }
        const placed = FIX.blocks.filter((b) => b.task_id === task.id);
        if (placed.length !== 2) return false;
        const lower = placed.reduce((a, b) => (a.start_at > b.start_at ? a : b));

        // ③ 把「下面那块」的**上边缘**往上拖到上面那块的起点之前
        focusBlock(lower.id);
        await settle();
        const handle = document.querySelector('[data-block-id="' + lower.id + '"] .edge-top');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const rb = handle.getBoundingClientRect();
        handle.dispatchEvent(ptrEvent("pointerdown", rb.left + 30, rb.top));
        const up = atDay(6, 8, 30); // 上面那块是 09:00 开始 → 拉到 08:30
        window.dispatchEvent(ptrEvent("pointermove", up.x, up.y));
        await settle();
        window.dispatchEvent(ptrEvent("pointerup", up.x, up.y));
        await settle(30);

        const inDb = FIX.blocks.filter((b) => b.task_id === task.id);
        const inDom = [...document.querySelectorAll("[data-block-id]")].filter((el) =>
          placed.some((b) => b.id === el.getAttribute("data-block-id")),
        );
        window.__DIAG.push(
          "融合（用户步骤） 库里=" + inDb.length + " 块，界面=" + inDom.length + " 块；库里=[" +
            inDb.map((b) => b.id + " " + (b.start_at - at(6, 0, 0)) / 1800 + "格→" + (b.end_at - at(6, 0, 0)) / 1800 + "格").join(",") + "]",
        );
        await backToThisWeek();
        return inDb.length === 1 && inDom.length === 1;
      },
    ],

    // ===== round31（C1.9 / R42）：键盘操作 =====
    [
      "round31 ①：单击块亮框（深色内圈）；点空白取消；提示条写清键位",
      async () => {
        await press("Escape"); // 先清掉前面手势可能留下的选中
        const clicked = await selectByClick("b40");
        const selCount = document.querySelectorAll(".block.selected").length;
        const hint = keyHintText();
        // 点空白：直接打在 .day-body 上（与真鼠标落点同一条事件路径，但不依赖坐标是否在可视区）
        dayBody(2).dispatchEvent(ptrEvent("pointerdown", 0, 0));
        await settle();
        const cleared = !document.querySelector(".block.selected");
        window.__DIAG.push(`①click=${clicked} 选中数=${selCount} 提示=${hint} 点空白后清=${cleared}`);
        return clicked && selCount === 1 && hint.includes("改开始时间") && cleared;
      },
    ],
    [
      "round31 ②：未抓起 ↑ = 上边缘提前 15 分（终点不动；视图不滚、不跳周）",
      async () => {
        await selectByClick("b40");
        const scroll = document.querySelector(".scroll");
        const top0 = scroll.scrollTop;
        const win0 = lastWinFrom();
        await press("ArrowUp");
        const b = blk("b40");
        const top = topInDay("b40", 0);
        window.__DIAG.push(
          `②起点=${minOf(b.start_at)} 终点=${minOf(b.end_at)} top=${Math.round(top)} scroll=${scroll.scrollTop}/${top0} win=${lastWinFrom() === win0}`,
        );
        return (
          minOf(b.start_at) === 8 * 60 - 15 &&
          minOf(b.end_at) === 9 * 60 &&
          Math.abs(top - yAt(7, 45)) <= 2 &&
          scroll.scrollTop === top0 &&
          lastWinFrom() === win0
        );
      },
    ],
    [
      "round31 ③：未抓起 Shift+↓ = 下边缘推后 15 分（起点不动）",
      async () => {
        await selectByClick("b40");
        await press("ArrowDown", { shiftKey: true });
        const b = blk("b40");
        window.__DIAG.push(`③起点=${minOf(b.start_at)} 终点=${minOf(b.end_at)}`);
        return minOf(b.start_at) === 8 * 60 - 15 && minOf(b.end_at) === 9 * 60 + 15;
      },
    ],
    [
      "round31 ④：Enter 抓起 → ↑ 只改预览（库里不动、辅助线跟着走）→ Enter 才落地",
      async () => {
        await selectByClick("b40");
        await press("Enter"); // 抓起
        const grabbedHint = gestureHintText(); // 拿起中先显示 .gesture-hint（key-hint 让位）
        await press("ArrowUp");
        const b = blk("b40");
        // ⚠️ 快照成数字：`blk()` 拿到的是**假库里的活对象**，后面的落地会把它就地改掉
        const during = { start: minOf(b.start_at), end: minOf(b.end_at) };
        const lines = alignLines().length;
        const labels = alignLabels().length;
        const previewTop = topInDay("b40", 0);
        await press("Enter"); // 落地
        const drop = blk("b40");
        window.__DIAG.push(
          `④预览中库=[${during.start},${during.end}] 辅助线=${lines}/${labels} 预览top=${Math.round(previewTop)} 落地=[${minOf(drop.start_at)},${minOf(drop.end_at)}]`,
        );
        return (
          grabbedHint.includes("拿起中") &&
          during.start === 7 * 60 + 45 &&
          during.end === 9 * 60 + 15 &&
          lines === 2 &&
          labels === 2 &&
          Math.abs(previewTop - yAt(7, 30)) <= 2 &&
          minOf(drop.start_at) === 7 * 60 + 30 &&
          minOf(drop.end_at) === 9 * 60
        );
      },
    ],
    [
      "round31 ⑤：抓起中 Shift+↓ = 移动 1 小时（落地才写）",
      async () => {
        await selectByClick("b40");
        await press("Enter");
        await press("ArrowDown", { shiftKey: true });
        const during = minOf(blk("b40").start_at);
        await press("Enter");
        const b = blk("b40");
        window.__DIAG.push(`⑤预览中库=${during} 落地=[${minOf(b.start_at)},${minOf(b.end_at)}]`);
        return during === 7 * 60 + 30 && minOf(b.start_at) === 8 * 60 + 30 && minOf(b.end_at) === 10 * 60;
      },
    ],
    [
      "round31 ⑥：拿起后 → = 挪到后一天（列也跟着换）；← 能回来",
      async () => {
        await selectByClick("b41");
        await press("Enter"); // 拿起（移动统一收进拿起）
        await press("ArrowRight");
        const col = dayIndexOfDom("b41"); // 预览盒子已经落在周二列
        await press("Enter"); // 落地
        const tue = minOf(blk("b41").start_at);
        await press("Enter"); // 再拿起 → 回来
        await press("ArrowLeft");
        await press("Enter");
        const back = minOf(blk("b41").start_at);
        window.__DIAG.push(`⑥周二起点=${tue} 列号=${col} 回来=${back}`);
        return tue === 24 * 60 + 14 * 60 && col === 1 && back === 14 * 60;
      },
    ],
    [
      "round31 ⑦：W/A/S/D 与方向键同效（D 挪一天、A 回来、W 修上边缘）",
      async () => {
        await selectByClick("b41");
        await press("Enter");
        await press("d");
        await press("Enter"); // 落地
        const tue = minOf(blk("b41").start_at);
        await press("Enter");
        await press("a");
        await press("Enter"); // 落地回来
        const mon = minOf(blk("b41").start_at);
        await press("w"); // 未拿起：W = 修上边缘（拉伸仍直接写）
        const b = blk("b41");
        window.__DIAG.push(`⑦D=${tue} A=${mon} W=[${minOf(b.start_at)},${minOf(b.end_at)}]`);
        return (
          tue === 24 * 60 + 14 * 60 &&
          mon === 14 * 60 &&
          minOf(b.start_at) === 14 * 60 - 15 &&
          minOf(b.end_at) === 15 * 60
        );
      },
    ],
    [
      "round31 ⑧：拿起后周日的块按 → 落到下周一 → 视图跟着翻下周（块仍选中）",
      async () => {
        await backToThisWeek();
        await selectByClick("b42");
        const win0 = lastWinFrom();
        await press("Enter");
        await press("ArrowRight");
        const flipped = lastWinFrom() === win0 + 7 * 86400;
        await press("Enter"); // 落地
        const landed = minOf(blk("b42").start_at) === 7 * 24 * 60 + 20 * 60;
        const stillSelected = el("b42")?.classList.contains("selected") ?? false;
        window.__DIAG.push(`⑧翻周=${flipped} 起点=${minOf(blk("b42").start_at)} 仍选中=${stillSelected}`);
        await backToThisWeek();
        return flipped && landed && stillSelected;
      },
    ],
    [
      "round31 ⑨：抓起「路过」不融合（预览不写库）→ 落到邻居上才融合 + 弹提示",
      async () => {
        await backToThisWeek();
        await selectByClick("b43");
        const trace = ["选中时=" + minOf(blk("b43").start_at) + "-" + minOf(blk("b43").end_at)];
        await press("Enter");
        trace.push("拿起后=" + minOf(blk("b43").start_at) + "-" + minOf(blk("b43").end_at) + "/" + (keyHintText() || gestureHintText()));
        for (let i = 0; i < 3; i++) {
          await press("ArrowDown");
          trace.push("↓" + (i + 1) + "=" + minOf(blk("b43").start_at) + "-" + minOf(blk("b43").end_at));
        }
        const b43db = { start: minOf(blk("b43").start_at), end: minOf(blk("b43").end_at) };
        const b44db = { start: minOf(blk("b44").start_at), end: minOf(blk("b44").end_at) };
        const lines = alignLines().length;
        const previewTop = topInDay("b43", 0);
        await press("Enter"); // 落地 → 与 b44 重叠 → 融合
        await settle(20);
        const merged = blk("b43");
        const b44gone = !blk("b44");
        const toast = toastText();
        const selectedAfter = el("b43")?.classList.contains("selected") ?? false;
        window.__DIAG.push(
          `⑨${trace.join(" ")} 预览top=${Math.round(previewTop)} 辅助线=${lines} b44在=${b44db !== null} 融合后=[${merged ? minOf(merged.start_at) : -1},${merged ? minOf(merged.end_at) : -1}] b44没了=${b44gone} 选中=${selectedAfter} 提示=${toast}`,
        );
        return (
          b43db.start === 16 * 60 &&
          b43db.end === 16 * 60 + 30 &&
          b44db !== null &&
          lines === 2 &&
          Math.abs(previewTop - yAt(16, 45)) <= 2 &&
          b44gone &&
          !!merged &&
          minOf(merged.start_at) === 16 * 60 + 45 &&
          minOf(merged.end_at) === 17 * 60 + 30 &&
          toast.includes("已合并") &&
          // round48：只报「做了什么」——不带「（Ctrl+Z 可撤销）」这类括号解释（用户 2026-10-03 截图）
          !toast.includes("（") &&
          !toast.includes("(") &&
          selectedAfter
        );
      },
    ],
    [
      "round31 ⑩：Esc 取消选中后 ← → 照旧跳周（老手感不破）",
      async () => {
        await backToThisWeek();
        await selectByClick("b41");
        await press("Escape");
        const cleared = !document.querySelector(".block.selected") && keyHintText() === "";
        const win0 = lastWinFrom();
        await press("ArrowLeft");
        const flipped = lastWinFrom() === win0 - 7 * 86400;
        window.__DIAG.push(`⑩取消选中=${cleared} ←跳周=${flipped}`);
        await backToThisWeek();
        return cleared && flipped;
      },
    ],
    [
      "round31 ⑪：Space = 标记完成；X = 标记未完成（弹漂流卡）",
      async () => {
        await backToThisWeek();
        await selectByClick("b45");
        await press("Space");
        const done = blk("b45")?.status === "done" && (el("b45")?.classList.contains("done") ?? false);
        await selectByClick("b46");
        await press("x");
        const missed = blk("b46")?.status === "missed";
        const card = !!document.querySelector(".drift");
        document.querySelector(".drift .dismiss")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle();
        window.__DIAG.push(`⑪完成=${done} 未完成=${missed} 漂流卡=${card}`);
        return done && missed && card;
      },
    ],
    [
      "round31 ⑫：Delete = 删块（确认→库里没了、界面没了；走的是 removeBlock）",
      async () => {
        const realConfirm = window.confirm;
        window.confirm = () => true;
        await selectByClick("b47");
        await press("Delete");
        await settle(20);
        const goneDb = !blk("b47");
        const goneDom = !el("b47");
        window.confirm = realConfirm;
        window.__DIAG.push(`⑫库里没=${goneDb} 界面没=${goneDom}`);
        return goneDb && goneDom;
      },
    ],
    [
      "round31 ⑬：焦点在输入框时不劫持（回归）",
      async () => {
        await backToThisWeek();
        await selectByClick("b40");
        const before = blk("b40").start_at;
        const field = document.querySelector(".new-task .field");
        field.focus();
        await settle();
        await press("ArrowUp");
        await press("d");
        const same = blk("b40").start_at === before;
        const focusStays = document.activeElement === field;
        window.__DIAG.push(`⑬块没动=${same} 焦点还在输入框=${focusStays}`);
        field.blur();
        await settle();
        return same && focusStays;
      },
    ],
    [
      "round31 ⑭：未抓起 Shift+↓ 把下边缘拉进下周 → 视图跟着翻（动哪条边看哪一周）",
      async () => {
        await backToThisWeek();
        await selectByClick("b48");
        const win0 = lastWinFrom();
        for (let i = 0; i < 5; i++) await press("ArrowDown", { shiftKey: true });
        const flipped = lastWinFrom() === win0 + 7 * 86400;
        const b = blk("b48");
        const endAt = b ? minOf(b.end_at) : -1;
        window.__DIAG.push(`⑭翻周=${flipped} 起点=${b ? minOf(b.start_at) : -1} 终点=${endAt}`);
        await backToThisWeek();
        return flipped && endAt === 7 * 24 * 60 + 15 && minOf(b.start_at) === 6 * 24 * 60 + 22 * 60;
      },
    ],
    [
      "round32 #1/#6：抓起跨周（Shift+→）后还能继续挪、还能落地",
      async () => {
        await backToThisWeek();
        await selectByClick("b52");
        const win0 = lastWinFrom();
        await press("Enter");
        await press("ArrowRight", { shiftKey: true });
        const flipped = lastWinFrom() === win0 + 7 * 86400;
        await press("ArrowDown"); // 还能继续一步
        await press("Enter"); // 落地
        await settle(20);
        const b = blk("b52");
        const expected = at(6, 19, 45) + 7 * 86400; // 下周日 19:45（19:30 + 15 分）
        const lines = alignLines().length;
        const onScreen = !!el("b52"); // 翻回本周之前量：落地后它就该在新一周的界面上
        window.__DIAG.push(
          `r32跨周 翻周=${flipped} 落地=${b ? b.start_at - at(0, 0, 0) : -1} 期望=${expected - at(0, 0, 0)} 辅助线=${lines} 在界面=${onScreen}`,
        );
        await backToThisWeek();
        return flipped && !!b && b.start_at === expected && lines === 0 && onScreen;
      },
    ],
    [
      "round32 #3：抓起挪到别的列时，原列不留「原位那块」（无幻影）",
      async () => {
        await backToThisWeek();
        await selectByClick("b50");
        await press("Enter");
        await press("ArrowRight"); // 周一 → 周二（跨列预览）
        const nodes = document.querySelectorAll('[data-block-id="b50"]');
        const col =
          nodes.length === 1 ? [...document.querySelectorAll(".day")].indexOf(nodes[0].closest(".day")) : -1;
        const lines = alignLines().length;
        await press("Escape");
        await settle();
        window.__DIAG.push(`r32幻影 元素数=${nodes.length} 列=${col}（期望 3 = 周四）辅助线=${lines}`);
        // b50 在周三（列 2），→ 一天 = 周四（列 3）；关键是**不能**同时出现两个元素（原列 + 预览列）
        return nodes.length === 1 && col === 3 && lines === 2;
      },
    ],
    [
      "round32 #5：抓起中点块的 🗑 → 先放弃抓起再删，不留操作不了的幻影",
      async () => {
        const realConfirm = window.confirm;
        window.confirm = () => true;
        await backToThisWeek();
        await selectByClick("b51");
        await press("Enter"); // 抓起
        const trash = document.querySelector('[data-block-id="b51"] .actions button[title="删除块"]');
        if (!trash) {
          window.confirm = realConfirm;
          return false;
        }
        const r = trash.getBoundingClientRect();
        trash.dispatchEvent(ptrEvent("pointerdown", r.left + 2, r.top + 2));
        trash.dispatchEvent(ptrEvent("pointerup", r.left + 2, r.top + 2));
        trash.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await settle(20);
        const goneDb = !blk("b51");
        const goneDom = !el("b51");
        const lines = alignLines().length;
        window.confirm = realConfirm;
        window.__DIAG.push(`r32删除 库里没=${goneDb} 界面没=${goneDom} 辅助线=${lines}`);
        return goneDb && goneDom && lines === 0;
      },
    ],
    [
      "round32 #4：焦点离开块 → 取消选中；块内按钮不算离开",
      async () => {
        await backToThisWeek();
        await selectByClick("b53");
        // 块内部换焦点（块体 → ✓ 按钮）：不该取消
        const done = document.querySelector('[data-block-id="b53"] .actions button[title="标记完成"]');
        done?.focus({ preventScroll: true });
        await settle();
        const keptInside = el("b53")?.classList.contains("selected") ?? false;
        // 焦点到块外（Backlog 输入框）。
        // ⚠️ 预览环境（调试窗口不受 OS 焦点）**不派发真实的 focusin/focusout**（实测 0 次）→
        //    这里手动补一个「真浏览器会派发的那种」focusin（bubbles、target = 输入框）；
        //    与真机的差异写进验收文档的手测点。
        const field = document.querySelector(".new-task .field");
        field.focus({ preventScroll: true });
        await settle();
        field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        await settle();
        const cleared = !document.querySelector(".block.selected");
        field.blur();
        await settle();
        window.__DIAG.push(`r32焦点 块内保持=${keptInside} 块外清掉=${cleared}`);
        return keptInside && cleared;
      },
    ],
    [
      "round32 #7：焦点在序列键（⛓）上时，块快捷键不生效、改给一句提示",
      async () => {
        await backToThisWeek();
        await selectByClick("b53");
        const before = minOf(blk("b53").start_at);
        const linkBtn = document.querySelector('[data-block-id="b53"] .actions button.link');
        if (!linkBtn) return false;
        linkBtn.focus({ preventScroll: true });
        await settle();
        const focusOk = document.activeElement === linkBtn;
        await press("ArrowUp"); // 想改块（拉伸，未拿起时唯一会动的方向键）→ 应该被拦住 + 给一句提示
        const after = minOf(blk("b53").start_at);
        const toast = toastText();
        // 收尾：点空白取消选中（别影响后面的接链断言）
        dayBody(2).dispatchEvent(ptrEvent("pointerdown", 0, 0));
        await settle();
        window.__DIAG.push(
          `r32序列键 按钮拿到焦点=${focusOk} 起点前=${before} 后=${after} 提示=${toast.slice(0, 70)}`,
        );
        return focusOk && before === after && toast.includes("序列操作");
      },
    ],
    [
      "round32 #2：接链时不再挤一条键位提示，提示里也不再有「取消」按钮",
      async () => {
        await backToThisWeek();
        await selectByClick("b53");
        const before = !!document.querySelector(".key-hint");
        const linkBtn = document.querySelector('[data-block-id="b53"] .actions button.link');
        if (!linkBtn) return false;
        const r = linkBtn.getBoundingClientRect();
        linkBtn.dispatchEvent(ptrEvent("pointerdown", r.left + 2, r.top + 2));
        linkBtn.dispatchEvent(ptrEvent("pointerup", r.left + 2, r.top + 2));
        linkBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await settle();
        const linking = !!document.querySelector(".link-hint");
        const keyHidden = !document.querySelector(".key-hint");
        const noCancel = !document.querySelector(".link-hint button");
        const text = document.querySelector(".link-hint")?.textContent?.trim() ?? "";
        const dupToast = toastText().includes("拿起线头"); // round33 #3：右下角那条重复提示要去掉
        // 点空白取消接链（与真用户一样）
        dayBody(2).dispatchEvent(ptrEvent("pointerdown", 0, 0));
        dayBody(2).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await settle();
        window.__DIAG.push(
          `r32链接 选中提示前=${before} 接链中=${linking} 键位隐藏=${keyHidden} 无取消键=${noCancel} 重复toast=${dupToast} 文案=「${text}」`,
        );
        // 断言「短了」而不是硬编码长度：不含旧文案里的「点顶部」、且点空白取消还写着
        return (
          before &&
          linking &&
          keyHidden &&
          noCancel &&
          text.includes("取消") &&
          !text.includes("点顶部") &&
          text.length <= 44 && // round36 加了「或 Esc」→ 39 字；旧文案是 49 字 + 一个按钮
          !dupToast
        );
      },
    ],
    [
      "round33 #1：鼠标拖动融合后，选中要转到幸存块（不能做完就没选中）",
      async () => {
        await backToThisWeek();
        await selectByClick("b56"); // 后一块（16:00）
        focusBlock("b56"); // 先把这块滚进视野
        await settle();
        // 直接把 pointerdown 打在块**自己**身上（不走 elementFromPoint）：窄块身上大半是按钮，
        // 按坐标打容易落在按钮上（按钮不启拖 —— 产品语义如此）
        const node56 = el("b56");
        if (!node56) return false;
        const r0 = node56.getBoundingClientRect();
        node56.dispatchEvent(ptrEvent("pointerdown", r0.left + 3, r0.top + r0.height / 2));
        dragToDay(0, 15, 15); // 落到 15:30（吸附）→ 与 b57（15:00–15:30）相接 → 融合，**幸存者是 b57**
        await settle();
        const pt = atDay(0, 15, 15);
        dragRelease(pt.x, pt.y);
        await settle(30);
        const survivor = blk("b57");
        const eaten = blk("b56");
        const selected = el("b57")?.classList.contains("selected") ?? false;
        window.__DIAG.push(
          `r33融合选中 b57在=${!!survivor} b56没了=${!eaten} b57选中=${selected} 选中数=${document.querySelectorAll(".block.selected").length}`,
        );
        return !!survivor && !eaten && selected;
      },
    ],
    [
      "round33 #2：长跨度块往上缩下边缘时，原尾巴那一列不留幻影",
      async () => {
        document.querySelectorAll(".week-nav button")[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        focusBlock("b55");
        await settle();
        const handle = document.querySelector('[data-block-id="b55"] .edge-bottom');
        if (!handle) return false;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};
        const rb = handle.getBoundingClientRect();
        handle.dispatchEvent(ptrEvent("pointerdown", rb.left + 30, rb.bottom));
        const to = atDay(2, 12, 0); // 下周三 12:00（把 Thu 整段与 Fri 那段都缩掉）
        window.dispatchEvent(ptrEvent("pointermove", to.x, to.y));
        await frames(3);
        const nodes = document.querySelectorAll('[data-block-id="b55"]');
        const cols = [...nodes].map((n) => [...document.querySelectorAll(".day")].indexOf(n.closest(".day")));
        window.__DIAG.push(`r33缩尾巴 元素=${nodes.length} 列=[${cols.join(",")}]（期望 2：下周二/下周三）`);
        window.dispatchEvent(ptrEvent("pointerup", to.x, to.y));
        await settle(20);
        await backToThisWeek();
        return nodes.length === 2 && cols.includes(1) && cols.includes(2);
      },
    ],
    [
      "round34：跨天块把终点缩到次日 00:00 → 块落到前一列、相机跟到那一列的底（可见）",
      async () => {
        // b58 在下一周（周一 20:00 → 周二 00:45）：先跳过去
        document.querySelectorAll(".week-nav button")[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        await selectByClick("b58");
        // Shift+↑（下边缘）= 一次缩 15 分钟：00:45 → 00:30 → 00:15 → 00:00
        for (let i = 0; i < 3; i++) await press("ArrowUp", { shiftKey: true });
        const node = el("b58");
        const col = node ? [...document.querySelectorAll(".day")].indexOf(node.closest(".day")) : -1;
        const s = document.querySelector(".scroll").getBoundingClientRect();
        const r = node?.getBoundingClientRect();
        const visible = !!r && r.top >= s.top - 2 && r.bottom <= s.bottom + 2 && r.left >= s.left - 2 && r.right <= s.right + 2;
        window.__DIAG.push(
          `r34跨天 列=${col}（期望 0=周一）块底=${r ? Math.round(r.bottom) : -1} 视口=[${Math.round(s.top)},${Math.round(s.bottom)}] 可见=${visible} 标签=${alignLabels().join(",")}`,
        );
        await backToThisWeek();
        return col === 0 && visible;
      },
    ],
    [
      "round36：接链（拿着线头）时按 Esc 能取消 —— 键盘也要有退路",
      async () => {
        await backToThisWeek();
        await selectByClick("b53");
        const linkBtn = document.querySelector('[data-block-id="b53"] .actions button.link');
        if (!linkBtn) return false;
        const r = linkBtn.getBoundingClientRect();
        linkBtn.dispatchEvent(ptrEvent("pointerdown", r.left + 2, r.top + 2));
        linkBtn.dispatchEvent(ptrEvent("pointerup", r.left + 2, r.top + 2));
        linkBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await settle();
        const linking = !!document.querySelector(".link-hint");
        await press("Escape");
        const cancelled = !document.querySelector(".link-hint");
        window.__DIAG.push(`r36Esc 接链中=${linking} Esc后取消=${cancelled}`);
        return linking && cancelled;
      },
    ],
    [
      "round37：Esc 取消接链 / 取消选中之后，焦点也要放掉（不然会留一个 focus 黑圈）",
      async () => {
        await backToThisWeek();
        await selectByClick("b53");
        const linkBtn = document.querySelector('[data-block-id="b53"] .actions button.link');
        if (!linkBtn) return false;
        const r = linkBtn.getBoundingClientRect();
        linkBtn.dispatchEvent(ptrEvent("pointerdown", r.left + 2, r.top + 2));
        linkBtn.dispatchEvent(ptrEvent("pointerup", r.left + 2, r.top + 2));
        linkBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        linkBtn.focus({ preventScroll: true }); // 真机点击会聚焦（合成事件不会）
        await settle();
        const linkFocused = document.activeElement === linkBtn;
        await press("Escape");
        const linkClosed = !document.querySelector(".link-hint");
        const linkBlurred = document.activeElement !== linkBtn;

        await selectByClick("b53");
        const blockFocused = document.activeElement === el("b53");
        await press("Escape");
        const blockBlurred = document.activeElement !== el("b53") && !document.querySelector(".block.selected");
        window.__DIAG.push(
          `r37Esc焦点 接链按钮拿到焦点=${linkFocused} 接链关了=${linkClosed} 按钮放焦点=${linkBlurred} 块拿到焦点=${blockFocused} 块放焦点=${blockBlurred}`,
        );
        return linkFocused && linkClosed && linkBlurred && blockFocused && blockBlurred;
      },
    ],
    [
      "round40 ⑦：分类能**直接打字**；列表第一行「（不设分类）」、分类名右侧是**灰色数量**（不在名字里）",
      async () => {
        const box = await openCat("写周报");
        if (!box) return false;
        const rows = catRows();
        const names = rows.map((r) => r.name);
        const learn = rows.find((r) => r.name.includes("学习"));
        window.__DIAG.push(
          `r40⑦ 是输入框=${box.field.tagName === "INPUT"} 行=[${names.join("|")}] 数量=[${rows.map((r) => r.count).join(",")}] 学习=${learn?.count} 名字里带括号=${names.some((n) => /（\d/.test(n))}`,
        );
        return (
          box.field.tagName === "INPUT" &&
          rows.length === 3 && // 不设 + 学习 + 工作（这时 t2 还没设分类）
          names[0].includes("不设分类") &&
          names[1].startsWith("学习") &&
          learn?.count === "4" &&
          !names.some((n) => /（\d/.test(n))
        );
      },
    ],
    [
      "round40 ⑧：打字就过滤（打「学」只剩「学习」+ 最后一行「＋ 新建」）+ 回车选中 → 写库、列表自己关掉",
      async () => {
        const box = await openCat("修 bug"); // t2
        if (!box) return false;
        await typeCat(box.field, "学");
        const rows = catRows();
        await enterCat(box.field);
        const dbCat = FIX.tasks.find((t) => t.id === "t2")?.category ?? null;
        const shown = box.row.querySelector(".props input.cat-input")?.value ?? "x";
        const closed = !document.querySelector(".cat-pop");
        window.__DIAG.push(
          `r40⑧ 过滤后=[${rows.map((r) => r.text).join("|")}] 库=${dbCat} 框里=${shown} 列表已关=${closed}`,
        );
        return (
          rows.length === 3 && // 不设 + 学习 + ＋新建「学」
          rows[1].name.includes("学习") &&
          rows[2].text.includes("新建") &&
          dbCat === "学习" &&
          shown === "学习" &&
          closed
        );
      },
    ],
    [
      "round40 ⑨：分类旁的 × = 清空（库里变回 null、框里也空了）",
      async () => {
        const box = await openCat("健身"); // t4
        if (!box) return false;
        await typeCat(box.field, "工作");
        await enterCat(box.field);
        const set = FIX.tasks.find((t) => t.id === "t4")?.category ?? null;
        const clear = box.row.querySelector(".props .clear-cat");
        if (!clear) return false;
        clear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const cleared = FIX.tasks.find((t) => t.id === "t4")?.category ?? null;
        const shownEmpty = (box.row.querySelector(".props input.cat-input")?.value ?? "x") === "";
        window.__DIAG.push(`r40⑨ 先设为=${set} 清空后=${cleared} 框空了=${shownEmpty}`);
        return set === "工作" && cleared === null && shownEmpty;
      },
    ],
    [
      "round40 ⑩：「已归档（N）」列表不含隐藏任务；点「恢复」后它真的回到 Backlog",
      async () => {
        const toggle = document.querySelector(".arch-toggle");
        if (!toggle) return false;
        const label = toggle.textContent.replace(/\s+/g, "");
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle();
        const lis = [...document.querySelectorAll(".arch-list li")];
        const rows = lis.map((li) => li.textContent.replace(/\s+/g, ""));
        const hasHidden = rows.some((t) => t.includes("临时安排"));
        const hasT5 = rows.some((t) => t.includes("归档过的老任务"));
        const restore = lis
          .find((li) => li.textContent.includes("归档过的老任务"))
          ?.querySelector("button");
        if (!restore) return false;
        restore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const dbBack = FIX.tasks.find((t) => t.id === "t5")?.archived_at == null;
        const inBacklog = [...document.querySelectorAll(".item")].some((el) =>
          rowLabel(el).startsWith("归档过的老任务"),
        );
        window.__DIAG.push(
          `r40⑩ 按钮=[${label}] 行=[${rows.join("|")}] 隐藏任务在列=${hasHidden} 库已恢复=${dbBack} 回Backlog=${inBacklog}`,
        );
        return !hasHidden && hasT5 && dbBack && inBacklog;
      },
    ],
    [
      "round40 ⑪：打得字查不到 → 列表最后一行「＋ 新建「家务」」，回车就建好并选中（不用追着点）",
      async () => {
        const box = await openCat("读书"); // t3
        if (!box) return false;
        await typeCat(box.field, "家务");
        const rows = catRows();
        await enterCat(box.field);
        const dbCat = FIX.tasks.find((t) => t.id === "t3")?.category ?? null;
        const shown = box.row.querySelector(".props input.cat-input")?.value ?? "x";
        const box2 = await openCat("读书");
        const listHasIt = catRows().some((r) => r.name === "家务");
        box2?.field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await settle();
        window.__DIAG.push(
          `r40⑪ 打「家务」时列表=[${rows.map((r) => r.text).join("|")}] 库=${dbCat} 框里=${shown} 再展开有它=${listHasIt}`,
        );
        return (
          rows.some((r) => r.text.includes("新建") && r.text.includes("家务")) &&
          dbCat === "家务" &&
          shown === "家务" &&
          listHasIt
        );
      },
    ],
    [
      "round40 ⑮：删块**不弹系统确认**了 —— 右下角一条「撤销」，点它块就回来",
      async () => {
        await backToThisWeek();
        const target = FIX.blocks.find((b) => b.task_id === "t4" && b.status === "planned");
        if (!target) return false;
        const id = target.id;
        let confirmCalled = false;
        const realConfirm = window.confirm;
        // 一被调用就露馅，而且返回 false 会把删除拦下来 → 两种错法这条都能抓到
        window.confirm = () => {
          confirmCalled = true;
          return false;
        };
        focusBlock(id);
        await settle();
        const trash = document.querySelector(
          `[data-block-id="${id}"] .actions button[title="删除块"]`,
        );
        if (!trash) {
          window.confirm = realConfirm;
          return false;
        }
        const r = trash.getBoundingClientRect();
        trash.dispatchEvent(ptrEvent("pointerdown", r.left + 2, r.top + 2));
        trash.dispatchEvent(ptrEvent("pointerup", r.left + 2, r.top + 2));
        trash.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await settle(30);
        const gone = !blk(id) && !el(id);
        const undoBtn = [...document.querySelectorAll(".toast .act")].find(
          (b) => b.textContent.trim() === "撤销",
        );
        const toastText = [...document.querySelectorAll(".toast")]
          .map((n) => n.textContent)
          .join("｜");
        undoBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        // round82（Step 4 踩过的坑）：提示里的「撤销」是**异步链**（按钮 → 动态 import history.svelte →
        // IPC）—— 只等微任务（`settle`）会假红（实测：命令根本没发出去）。等**真实帧** + 有界轮询到生效。
        for (let i = 0; i < 40 && !(blk(id) && el(id)); i++) await frames(1);
        const back = !!blk(id) && !!el(id);
        window.confirm = realConfirm;
        window.__DIAG.push(
          `r40⑮ 弹过系统确认=${confirmCalled} 删掉了=${gone} 提示=[${toastText}] 有撤销键=${!!undoBtn} 撤销后回来=${back}`,
        );
        return !confirmCalled && gone && !!undoBtn && back;
      },
    ],
    [
      "round40 ⑯：归档**不弹确认**（有「恢复」这条出口），提示里指得到恢复入口",
      async () => {
        const row = await openPropsOf("键盘靶子四"); // t12：拿它当靶子（归档不影响别的断言）
        if (!row) return false;
        const listBefore = document.querySelectorAll(".item").length;
        let confirmCalled = false;
        const realConfirm = window.confirm;
        window.confirm = () => {
          confirmCalled = true;
          return false;
        };
        row
          .querySelector(".props .archive")
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        // round82（Step 4 踩过的坑）：归档后列表重拉是异步的（IPC → 重拉 → 渲染）—— 只等微任务会假红；
        // 等真实帧 + 有界轮询到「那一行真的从列表消失」（与 ⑮ 的撤销同一条纪律）
        const rowGone = () =>
          ![...document.querySelectorAll(".item")].some((el) => rowLabel(el).startsWith("键盘靶子四"));
        for (let i = 0; i < 40 && !rowGone(); i++) await frames(1);
        const dbArchived = FIX.tasks.find((t) => t.id === "t12")?.archived_at != null;
        const goneFromList = rowGone();
        const toastText = [...document.querySelectorAll(".toast")]
          .map((n) => n.textContent)
          .join("｜");
        window.confirm = realConfirm;
        window.__DIAG.push(
          `r40⑯ 弹过系统确认=${confirmCalled} 库已归档=${dbArchived} 从列表消失=${goneFromList} 列表数 ${listBefore}→${document.querySelectorAll(".item").length} 提示=[${toastText}]`,
        );
        return !confirmCalled && dbArchived && goneFromList && toastText.includes("已归档");
      },
    ],
    // round39（0.7.1）：分类的交互控件从浏览器 `datalist` 换成**原生 `<select>`** ——
    // 你实测：「那个菜单像自动填写账号密码那样突然冒出来一个黑框」+「选定了怎么又跳出来一遍」。
    // 这两条都是 datalist 自带的毛病（它本来就不是下拉框，是“建议列表”）；换 select 就没了。
    [
      "round39 ⑫：⚙ 面板开着时拖块 —— 按下面板就该自动收起，块照旧拖动库",
      async () => {
        await backToThisWeek();
        setScrollHome();
        await settle();
        const row = await openPropsOf("读书");
        if (!row) return false;
        const panelOpen = !!document.querySelector(".props");
        focusBlock("b3"); // 周一 13:00 那块（t3）
        await settle();
        const before = minOf(blk("b3").start_at);
        if (!dragStartBlock("b3")) return false;
        const p = dragToDay(1, 13, 0); // 拖到周二 13:00（t3 在周二空着 → 不会融合）
        await settle();
        dragRelease(p.x, p.y);
        await settle(30);
        const after = minOf(blk("b3").start_at);
        const panelGone = !document.querySelector(".props");
        window.__DIAG.push(
          `r39⑫ 面板开着=${panelOpen} 拖动前=${before} 拖动后=${after} 面板已收起=${panelGone} 期望=${before + 1440}`,
        );
        return panelOpen && after === before + 1440 && panelGone;
      },
    ],
    [
      "round39 ⑬：⚙ 面板开着时从 Backlog 拖那条任务进来 —— 面板先自动收起，再照常建块",
      async () => {
        await backToThisWeek();
        // round77 收尾：清选中只为摆干净前置状态（头部已是不变量）
        await press("Escape");
        await press("Escape");
        setScrollHome();
        focusBodyY(yAt(13, 0)); // round77：落点 13:00 滚进视野中央（否则边缘带的自动滚动会推落点）
        await settle();
        const row = await openPropsOf("读书");
        if (!row) return false;
        const t3Before = FIX.blocks.filter((b) => b.task_id === "t3").length;
        // 按在**标题那一段**（面板占了下半行；压在面板上属于「在面板里点」→ 不该起拖）
        const label = row.querySelector(".label");
        const r = label.getBoundingClientRect();
        firePointer("pointerdown", r.left + 12, r.top + r.height / 2);
        const p = dragToDay(3, 13, 0); // 周四 13:00（t3 在周四空着）
        await settle();
        dragRelease(p.x, p.y);
        await settle(30);
        const t3After = FIX.blocks.filter((b) => b.task_id === "t3").length;
        const made = FIX.blocks.some((b) => b.task_id === "t3" && b.start_at === at(3, 13, 0));
        const landed = FIX.blocks.filter((b) => b.task_id === "t3").map((b) => (b.start_at - at(0, 0, 0)) / 60);
        window.__DIAG.push(
          `r39⑬ 拖动前块数=${t3Before} 拖动后=${t3After} 周四13:00建上了=${made} 落在=${landed.join("/")} 期望=${(at(3,13,0)-at(0,0,0))/60}`,
        );
        return made && t3After === t3Before + 1;
      },
    ],
    [
      "round39 ⑭：面板里改过值（未提交）再拖块 —— 失焦提交不能把拖动打断",
      async () => {
        await backToThisWeek();
        await press("Escape"); // round77 收尾：同上（清前置状态）
        await press("Escape");
        setScrollHome();
        focusBodyY(yAt(13, 0)); // round77：同上
        await settle();
        const row = await openPropsOf("读书"); // t3（它的 planned 块 b3 前面刚被 ⑫ 拖过，还活着）
        if (!row) return false;
        const est = row.querySelector(".props input.num");
        if (!est) return false;
        est.value = "45"; // 改了但没回车（等失焦提交）
        // 注：Chromium 对**脚本赋值**不会在 blur 时补发 change（真人打字才会）——
        // 这里手动补一次，把「失焦提交」的后果原样造出来（下面**不等它跑完**就开始拖动）
        est.dispatchEvent(new Event("change", { bubbles: true }));
        const target = FIX.blocks.find((b) => b.id === "b3") ?? FIX.blocks.find((b) => b.task_id === "t3" && b.status === "planned");
        if (!target) return false;
        focusBlock(target.id);
        await settle();
        const before = minOf(target.start_at);
        if (!dragStartBlock(target.id)) return false;
        const p = dragToDay(3, 13, 0); // 周四 13:00（t3 在周四空着）
        await settle();
        dragRelease(p.x, p.y);
        await settle(30);
        const moved = FIX.blocks.find((b) => b.id === target.id);
        const after = moved ? minOf(moved.start_at) : -1;
        const estSaved = FIX.tasks.find((t) => t.id === "t3")?.estimated_minutes ?? null;
        window.__DIAG.push(
          `r39⑭ 拖的块=${target.id} 前=${before} 后=${after} 目标=${minOf(at(3, 13, 0))} 失焦提交已落库=${estSaved === 45}`,
        );
        return after === minOf(at(3, 13, 0)) && estSaved === 45;
      },
    ],
    // ===== round41（0.7.3）：你验收回的四条（命中区 / 数量层级 / 提示文案 / Backlog 整体偏小）=====
    [
      "round41 ⑰：Backlog 的 ⚙ / × 命中区 ≥ 24×24（WCAG 2.5.8；你实测「⚙ 键稍小了经常点不到」）",
      async () => {
        const row = document.querySelector(".item");
        const gear = row?.querySelector(".props-toggle");
        const del = row?.querySelector(".del");
        const box = (n) => n?.getBoundingClientRect();
        const g = box(gear);
        const d = box(del);
        const sz = (r) => (r ? Math.round(r.width) + "x" + Math.round(r.height) : "?");
        window.__DIAG.push(`r41⑰ ⚙命中区=${sz(g)} ×命中区=${sz(d)}`);
        return (
          !!g && !!d && g.width >= 24 && g.height >= 24 && d.width >= 24 && d.height >= 24
        );
      },
    ],
    [
      "round41 ⑱：分类数量是**次要信息**（更小更淡；round48 起「1」也显示 —— 用户验收打回了「≥2 才显示」）",
      async () => {
        const box = await openCat("写周报");
        if (!box) return false;
        const rows = [...document.querySelectorAll(".cat-pop .row")];
        const rowOf = (name) =>
          rows.find((n) => n.querySelector(".nm")?.textContent?.trim().startsWith(name));
        const learn = rowOf("学习");
        const work = rowOf("工作");
        const nm = learn?.querySelector(".nm");
        const ct = learn?.querySelector(".ct");
        const fs = (n) => (n ? Number(getComputedStyle(n).fontSize.replace("px", "")) : -1);
        const op = (n) => (n ? Number(getComputedStyle(n).opacity) : -1);
        const heights = rows.map((n) => Math.round(n.getBoundingClientRect().height));
        // ⚠️ 先量再关：样式一关就量不到了（节点会被卸载 → computed style 是空的）
        const fName = fs(nm);
        const fCount = fs(ct);
        const oCount = op(ct);
        const learnCount = learn?.querySelector(".ct")?.textContent ?? "无";
        const workCount = work?.querySelector(".ct")?.textContent ?? "无";
        window.__DIAG.push(
          `r41⑱ 名字字号=${fName} 数量字号=${fCount} 数量透明度=${oCount} 学习行数量=${learnCount} 工作行数量=${workCount} 行高=[${heights.join(",")}]`,
        );
        // 顺手收掉列表
        box.field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await settle();
        return (
          !!nm &&
          !!ct &&
          fCount > 0 &&
          fCount < fName &&
          oCount < 1 &&
          // round48（用户 2026-10-03 验收）：「项目分类明明有一个，右边却没有 1」→ 数量一直显示，
          // 包括 1（这边「工作」当时恰好只有 1 个任务，正好当这条的靶子）
          workCount === "1" &&
          heights.every((h) => h >= 24)
        );
      },
    ],
    [
      "round41 ⑲：提示只报「做了什么」—— 不再带括号里的解释（你：「用户自己看界面都知道什么情况」）",
      async () => {
        const row = await openPropsOf("键盘靶子二"); // t10
        if (!row) return false;
        row
          .querySelector(".props .archive")
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const msgs = [...document.querySelectorAll(".toast")].map((n) => n.textContent.trim());
        const archMsgs = msgs.filter((m) => m.includes("已归档"));
        const hasParen = archMsgs.some((m) => m.includes("（") || m.includes("("));
        const noOldExplain = msgs.every(
          (m) => !m.includes("后面的环往前补位") && !m.includes("块没删") && !m.includes("里能恢复"),
        );
        window.__DIAG.push(
          `r41⑲ 归档提示=[${archMsgs.join(" | ")}] 带括号=${hasParen} 旧解释没残留=${noOldExplain}`,
        );
        return (
          archMsgs.some((m) => m.includes("已归档「键盘靶子二」")) && !hasParen && noOldExplain
        );
      },
    ],
    // ===== round42（0.7.4）：提示条文案（黑话 → 人话）+ 紧凑排版（不再被截断）=====
    [
      "round42 ⑳：提示条是人话 —— 「改开始时间 / 改结束时间 / 拿起 / 取消选中」，不再是「修上边缘 / 修时长 / 落地」",
      async () => {
        await backToThisWeek();
        await selectByClick("b53");
        const text = keyHintText();
        const hasPlain =
          text.includes("改开始时间") && text.includes("改结束时间") && text.includes("拿起");
        const noJargon = !["修上边缘", "修时长", "落地", "抓起"].some((w) => text.includes(w));
        const keys = [...document.querySelectorAll(".key-hint .kh-key")].map((n) =>
          n.textContent.trim(),
        );
        const acts = [...document.querySelectorAll(".key-hint .kh-act")].map((n) =>
          n.textContent.trim(),
        );
        // 顺手确认「不列 ✓/✗/Del」这条：块上本来就有按钮
        const noDup = !["完成", "未完成", "删除"].some((w) => text.includes(w));
        window.__DIAG.push(
          `r42⑳ 提示=[${text}] 键帽=[${keys.join(",")}] 动作=[${acts.join(",")}] 人话=${hasPlain} 无黑话=${noJargon} 不重复按钮=${noDup}`,
        );
        await press("Escape");
        return hasPlain && noJargon && noDup && keys.length >= 4 && acts.length >= 4;
      },
    ],
    [
      "round42 ㉑：提示条**不再被截断**（紧凑排版：键帽 + 动作词）",
      async () => {
        await backToThisWeek();
        await selectByClick("b53");
        const box = document.querySelector(".key-hint");
        if (!box) return false;
        const clipped = box.scrollWidth > box.clientWidth + 1;
        const w = Math.round(box.getBoundingClientRect().width);
        window.__DIAG.push(
          `r42㉑ 提示条宽=${w} 内容宽=${box.scrollWidth} 可视宽=${box.clientWidth} 被截断=${clipped}`,
        );
        await press("Escape");
        return !clipped;
      },
    ],
    [
      "round44 ①：周范围在窄窗口下只占一行（不再被挤成竖排）",
      async () => {
        // 复现用户现场的那两个条件：① 窄窗口（用 `--width 715` 跑）；② 选中一个块（顶部有键位提示条，
        // 它跟周范围/跳周按钮抢宽度 —— 用户截图里就是「选中的块 + 提示条」这个状态）。
        await backToThisWeek();
        // 选一块：**从 DOM 里取真的在的那一块**（前面 140 条断言可能删过/挪过 b1/b2，不写死 id）
        const first = document.querySelector("[data-block-id]")?.getAttribute("data-block-id");
        if (first) await selectByClick(first);
        await settle();
        const h = document.querySelector(".range");
        if (!h) return false;
        const box = document.createElement("div");
        const r = document.createRange();
        r.selectNodeContents(h);
        const rect = r.getBoundingClientRect();
        const text = (h.textContent ?? "").trim();
        const shape = /^[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2} ~ [0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}$/.test(text);
        // 量的是**文字本身**的 rect（规矩：量文字不量容器）—— 被挤成竖排时高度会到 5 行（≈75px）
        const oneLine = shape && rect.height <= 24 && rect.width > 100;
        window.__DIAG.push(
          `r44① 周范围="${text}" 高=${Math.round(rect.height)} 宽=${Math.round(rect.width)} 视口=${window.innerWidth} 一行=${oneLine}`,
        );
        box.remove();
        await press("Escape");
        return oneLine;
      },
    ],
    // ===== round45（0.8.1）：理智值口径改成「真实占用」—— 小条 / 顶栏 / ⊘ 开关 / 拖宽 / ⓘ =====
    [
      "round45 ②：日头小条 = 那天真实占用 / 预算（重叠只算一次；对着假库现算，不写死数字）",
      async () => {
        await backToThisWeek();
        await settle(30);
        const budget = 360;
        const rows = [];
        let ok = true;
        for (let i = 0; i < 7; i++) {
          const minutes = dayUnionMinutes(FIX, i);
          const want = Math.min(100, Math.round((minutes / budget) * 100));
          const got = dayBarPct(i);
          if (minutes === 0 ? got !== -1 : Math.abs(got - want) > 2) ok = false;
          rows.push(`${i}:${got}${minutes === 0 ? "/无" : "/" + want}`);
        }
        // 读屏人话（aria-valuetext）与 role=meter：不靠颜色单独表意
        const bar = document.querySelector(".day-head .load");
        const aria = bar?.getAttribute("aria-valuetext") ?? "";
        const meter =
          bar?.getAttribute("role") === "meter" && aria.includes("占用") && aria.includes("预算");
        window.__DIAG.push(`r45② 周一到周日=${rows.join(" ")} 读屏=${meter}`);
        return ok && meter;
      },
    ],
    [
      "round45 ③：重叠的块只占一次（你图2 那个场景）—— 两块拖到同一个格子，那天只涨一块的时间",
      async () => {
        await backToThisWeek();
        setScrollHome();
        await settle(30);
        const day = 3; // 周四下午：假库里这一带平时是空的
        // 从 Backlog 拖两个任务到**同一个格子**（两块完全重叠；不同任务 → 不会被融合）。
        // 为什么不用双击建临时块：双击落点会被吸附，两次未必落在同一格（试过，重叠没造出来）。
        if (!(await dragTaskTo("写周报", day, 14, 0))) return false;
        if (!(await dragTaskTo("读书", day, 14, 0))) return false;
        const fresh = FIX.blocks.filter(
          (b) => b.start_at >= at(day, 13, 0) && b.end_at <= at(day, 15, 0),
        );
        const [a, b] = fresh.slice(-2);
        if (!a || !b) {
          window.__DIAG.push(`r45③ 拖出来的块对不上：[${fresh.map((x) => x.id).join(",")}]`);
          return false;
        }
        const sum =
          Math.round((a.end_at - a.start_at) / 60) + Math.round((b.end_at - b.start_at) / 60);
        const overlap =
          Math.max(0, Math.min(a.end_at, b.end_at) - Math.max(a.start_at, b.start_at)) / 60;
        // 独立算这一天的并集：**1440 分钟位图**（与 fixture 的「排序合并」是两套算法，互相印证）
        const mine = bitmapDayMinutes(FIX, day);
        const dayStart = at(day, 0, 0);
        const dayEnd = at(day + 1, 0, 0);
        const daySum = Math.round(
          FIX.blocks
            .filter((x) => !x.sanity_exempt && x.start_at < dayEnd && x.end_at > dayStart)
            .reduce(
              (acc, x) =>
                acc + (Math.min(x.end_at, dayEnd) - Math.max(x.start_at, dayStart)) / 60,
              0,
            ),
        );
        const barPct = dayBarPct(day);
        const wantPct = Math.min(100, Math.round((mine / 360) * 100));
        window.__DIAG.push(
          `r45③ 新两块=${minOf(a.start_at)}–${minOf(a.end_at)} / ${minOf(b.start_at)}–${minOf(b.end_at)} 重叠=${Math.round(overlap)}分 和=${sum}；这天：位图并集=${mine} 各块时长和=${daySum}（和>并集=${daySum > mine}）小条=${barPct}%/${wantPct}%`,
        );
        return overlap >= 25 && mine > 0 && daySum > mine && Math.abs(barPct - wantPct) <= 2;
      },
    ],
    [
      "round45 ④：顶部那句话 —— 点名超载那天、说人话（不含「重活 / 加成 / 当量」）",
      async () => {
        await backToThisWeek();
        setScrollHome();
        await settle(30);
        const bar = document.querySelector(".sanity");
        const text = bar?.textContent?.trim() ?? "";
        const jargon = ["重活", "加成", "当量", "权重", "重排", "折算"].filter((w) =>
          text.includes(w),
        );
        const overDays = [];
        for (let i = 0; i < 7; i++) {
          if (dayUnionMinutes(FIX, i) >= 360) overDays.push(WEEK_CN[i]);
        }
        const ok =
          !!bar &&
          text.includes("占用") &&
          text.includes("预算") &&
          jargon.length === 0 &&
          (overDays.length === 0 || overDays.some((d) => text.includes(d)));
        window.__DIAG.push(
          `r45④ 条=[${text}] 超载日=[${overDays.join(",")}] 黑话=[${jargon.join(",")}]`,
        );
        return ok;
      },
    ],
    [
      "round45 ⑤：没有块的那些周不出现那句话（警报要稀有）",
      async () => {
        await backToThisWeek();
        await press("Escape"); // 先取消选中，否则 ←/→ 是挪块
        for (let k = 0; k < 3; k++) {
          await press("ArrowRight"); // 翻到三周后（假库里那几周没有块）
          await settle(20);
        }
        const ws = lastWinFrom();
        const empty = [0, 1, 2, 3, 4, 5, 6].every((i) => dayUnionMinutes(FIX, i, ws) === 0);
        const gone = !document.querySelector(".sanity");
        const noBars = document.querySelectorAll(".day-head .load").length === 0;
        await backToThisWeek();
        window.__DIAG.push(
          `r45⑤ 三周后的窗口=${ws ? new Date(ws * 1000).toLocaleDateString() : "-"} 空=${empty} 没那句话=${gone} 没小条=${noBars}`,
        );
        return empty && gone && noBars;
      },
    ],
    [
      "round45 ⑥：⚙ 里改预算 → 数字跟着变（后端真写 + 立刻重算）",
      async () => {
        await backToThisWeek();
        if (!document.querySelector(".sanity-gear")) return false;
        // round78（3.1b₂）：预算挪进了「更多 → 理智值」——先折叠区展开
        await openSettingsSub("sanity");
        const num = document.querySelector(".sanity-pop input.num");
        if (!num) return false;
        const titleNow = () => dayBarTitle(3);
        const before = titleNow();
        const writesBefore = window.__SANITY_WRITES || 0;
        const setHours = (v) => {
          num.value = String(v);
          num.dispatchEvent(new Event("input", { bubbles: true }));
          num.dispatchEvent(new Event("change", { bubbles: true }));
        };
        setHours(1);
        await settle(40);
        const after = titleNow();
        const wrote = (window.__SANITY_WRITES || 0) > writesBefore;
        setHours(6);
        await settle(40);
        const restored = titleNow();
        document
          .querySelector(".sanity-pop .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle();
        window.__DIAG.push(
          `r45⑥ 预算标签：前=[${before.slice(-24)}] 改1小时后=[${after.slice(-24)}] 还原=[${restored.slice(-24)}] 写过设置=${wrote}`,
        );
        // 预算改了，小条/悬停里那句话必须跟着变（不依赖「哪天超载」这种跟别处状态有关的判断）
        return (
          wrote &&
          before.includes("预算 6 小时") &&
          after.includes("预算 1 小时") &&
          restored.includes("预算 6 小时")
        );
      },
    ],
    [
      "round45 ⑦：关掉开关 → 小条 / 那句话 / **块上的 ⊘ 图标**都不出现（你 2026-10-03 点名）",
      async () => {
        await backToThisWeek();
        const gear = document.querySelector(".sanity-gear");
        if (!gear) return false;
        const iconsBefore = document.querySelectorAll(".item button.exempt").length;
        await openSettingsSub("sanity"); // round78：精力区进了「更多」折叠区（round84：文案从「理智」改「精力」）
        const box = settingBox("显示精力预警");
        if (!box) return false;
        box.checked = false;
        box.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(40);
        const noBars = document.querySelectorAll(".day-head .load").length === 0;
        const noStrip = !document.querySelector(".sanity");
        const noIcons = document.querySelectorAll(".item button.exempt").length === 0;
        // 还原
        box.checked = true;
        box.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(40);
        const iconsBack = document.querySelectorAll(".item button.exempt").length;
        document
          .querySelector(".sanity-pop .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle();
        window.__DIAG.push(
          `r45⑦ 关掉后：小条=${noBars ? "无" : "在"} 那句话=${noStrip ? "无" : "在"} ⊘图标=${noIcons ? "无" : "在"}（开前 ${iconsBefore} 个 / 开后 ${iconsBack} 个）`,
        );
        return noBars && noStrip && noIcons && iconsBefore > 0 && iconsBack === iconsBefore;
      },
    ],
    [
      "round45 ⑨：两栏之间的分隔条能拖宽（写进设置；双击复位）",
      async () => {
        await backToThisWeek();
        const splitter = document.querySelector(".splitter");
        const backlog = document.querySelector(".backlog");
        if (!splitter || !backlog) return false;
        const widthBefore = Math.round(backlog.getBoundingClientRect().width);
        const r = splitter.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        splitter.dispatchEvent(ptrEvent("pointerdown", x, y));
        await settle();
        for (const dx of [30, 60, 90]) {
          window.dispatchEvent(ptrEvent("pointermove", x + dx, y));
          await settle();
        }
        window.dispatchEvent(ptrEvent("pointerup", x + 90, y));
        await settle(30);
        const widthAfter = Math.round(backlog.getBoundingClientRect().width);
        const wrote = (window.__LAST_SETTING || [])[0] === "backlog_width";
        splitter.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        await settle(30);
        const widthReset = Math.round(backlog.getBoundingClientRect().width);
        window.__DIAG.push(
          `r45⑨ 宽 ${widthBefore}→${widthAfter}→复位 ${widthReset}；设置=${(window.__LAST_SETTING || []).join("=")}`,
        );
        return widthAfter > widthBefore + 60 && wrote && Math.abs(widthReset - 260) <= 2;
      },
    ],
    [
      "round45 ⑩ / round64：理智值「怎么算的」—— 按反馈 #7 搬进说明页（设置 → ⓘ 说明；面板里不再挤旁批）",
      async () => {
        await backToThisWeek();
        await press("Escape"); // 说明页/设置面板都收起（上一条可能开着）
        if (!document.querySelector(".sanity-pop")) {
          await openSettingsSub("guide"); // round78：「打开说明页」在「更多 → 引导与教程」里
        }
        document.querySelector(".sanity-pop .help-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const panel = document.querySelector(".help-panel");
        const text = panel?.querySelector("#help-sanity")?.textContent ?? "";
        const ok =
          !!panel &&
          text.includes("重叠") &&
          text.includes("预算") &&
          text.includes("不计入") &&
          text.includes("时间");
        // 两层都关掉（不关就会遮住后面的断言 —— 实测踩过）
        panel?.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        document
          .querySelector(".sanity-pop .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const clean = !document.querySelector(".help-panel") && !document.querySelector(".sanity-pop");
        window.__DIAG.push(`r45⑩ 说明=[${text.replace(/\s+/g, " ").slice(0, 70)}…] 齐=${ok} 收尾干净=${clean}`);
        return ok && clean;
      },
    ],
    // ===== round44（0.8.0）：三笔小欠债 BH / BI / BJ（对账 §5，用户 2026-10-02 拍板并进本批）=====
    [
      "round44 ⑧：分类列表打开时高亮**当前分类**那一行（回车不再手滑换分类）",
      async () => {
        // 先用界面把 t1 设成「工作」（不依赖别的断言跑过什么）
        const set = await openCat("写周报");
        if (!set) return false;
        await typeCat(set.field, "工作");
        await enterCat(set.field);
        await settle(20);
        // 再打开一次（这次不打字）→ 高亮行应该是「工作」，直接回车 = 什么都不变
        const box = await openCat("写周报");
        if (!box) return false;
        const rows = [...document.querySelectorAll(".cat-pop .row")];
        const hi = rows.find((n) => n.getAttribute("aria-selected") === "true");
        const hiText = hi?.textContent?.replace(/\s+/g, " ").trim() ?? "(无)";
        const before = FIX.tasks.find((t) => t.id === "t1")?.category ?? null;
        await enterCat(box.field); // 直接回车 = 什么都不该变
        const after = FIX.tasks.find((t) => t.id === "t1")?.category ?? null;
        window.__DIAG.push(`r44⑧ 高亮行=「${hiText}」 回车前=${before} 回车后=${after}`);
        return hiText.includes("工作") && before === "工作" && after === "工作";
      },
    ],
    [
      "round44 ⑨：8 秒内连删两块 → 撤销条**只剩一条**，点它撤的是最新那次",
      async () => {
        await backToThisWeek();
        // 从 DOM 里取两块（去重）—— 不写死 id：前面的断言可能已经删过 b1/b2，
        // 而假后端的撤销只保一级快照（真后端是整表栈，这里只验「同时只有一条撤销条 + LIFO」）。
        const ids = [];
        for (const n of document.querySelectorAll("[data-block-id]")) {
          const id = n.getAttribute("data-block-id");
          if (id && !ids.includes(id)) ids.push(id);
        }
        const a = ids[0];
        const b = ids[1];
        if (!a || !b) return false;
        const gone = (id) => !FIX.blocks.some((x) => x.id === id);
        await selectByClick(a);
        await press("Delete");
        await selectByClick(b);
        await press("Delete");
        const undoButtons = [...document.querySelectorAll(".toast .act")].filter(
          (n) => n.textContent.trim() === "撤销",
        );
        const goneBoth = gone(a) && gone(b);
        undoButtons.slice(-1)[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        // 与 round40 ⑮ 同一套：撤销是异步链（动态 import → IPC）—— 等真实帧 + 有界轮询，别只等微任务
        for (let i = 0; i < 40 && gone(b); i++) await frames(1);
        const backB = !gone(b);
        const stillGoneA = gone(a);
        window.__DIAG.push(
          `r44⑨ 删=[${a},${b}] 撤销条数=${undoButtons.length} 两块都没了=${goneBoth} 撤销后 ${b} 回来=${backB} ${a} 仍删着=${stillGoneA}`,
        );
        return undoButtons.length === 1 && goneBoth && backB && stillGoneA;
      },
    ],
    [
      "round44 ⑩：任务面板里保存失败时，输入框**拉回原值**（不再看着像已改好）",
      async () => {
        const row = await openPropsOf("健身"); // t4
        const num = row?.querySelector(".props input.num");
        if (!num) return false;
        const before = FIX.tasks.find((t) => t.id === "t4")?.estimated_minutes ?? null;
        window.__FAIL_UPDATE_TASK_ONCE = true; // 让这一次 update_task 失败
        num.value = "999";
        num.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(40);
        const after = FIX.tasks.find((t) => t.id === "t4")?.estimated_minutes ?? null;
        const shown = row.querySelector(".props input.num")?.value ?? "x";
        window.__DIAG.push(`r44⑩ 保存前=${before} 库后来=${after} 框里=${shown}`);
        return before === after && shown === String(before);
      },
    ],

    // ===== round51（0.11.1）：BP 修 —— 「自己安排」也要能停在边缘翻周（与拖动/拉伸同一套）=====

    [
      "round51 BP（0.11.1）：「自己安排」中停在最右边缘 ~0.9s → 周真的翻过去（旧代码：只滚内容、不翻周）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        setScrollHome();
        await settle(20);
        const missed = FIX.blocks.find((b) => b.status === "missed" && el(b.id));
        if (!missed) return false;
        // 打开漂流卡 → 点「✎ 自己安排」（与 round49 ⑤ 同一套入口）
        el(missed.id)
          ?.querySelector('button[title="重新安排"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const own = [...document.querySelectorAll(".drift button")].find((b) =>
          b.textContent.includes("自己安排"),
        );
        if (!own) return false;
        own.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        // 甩出日列区最右边 → 停住（首次翻页延迟 0.6s），0.9s 足够看到第一页
        const sun = dayBody(6).getBoundingClientRect();
        const before = lastWinFrom();
        window.dispatchEvent(ptrEvent("pointermove", sun.right + 40, sun.top + yAt(10, 0)));
        await settle();
        await waitMs(900);
        const after = lastWinFrom();
        const flipped = after !== before;
        window.__DIAG.push(`r51 BP 边缘停留：窗口 ${before} → ${after} 翻了=${flipped}`);
        // Esc 取消这次「自己安排」（不落库），再回本周 —— 别给后面的断言留状态
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await settle(30);
        await backToThisWeek();
        return flipped;
      },
    ],

    // ===== round49（0.11.0）：验收回修五条（临时块 ⊘ / 改名 Enter / 提醒开关 / 组内排序 / 自己安排）=====

    [
      "round49 ①：临时块有 ⊘（普通块没有）→ 点它，那一块不再计入理智",
      async () => {
        await press("Escape");
        const tempId = FIX.blocks.find((b) => b.is_temp && el(b.id))?.id;
        const normalId = FIX.blocks.find((b) => !b.is_temp && b.status === "planned" && el(b.id))?.id;
        if (!tempId || !normalId) return false;
        const tempHasKey = !!el(tempId)?.querySelector(".actions button.exempt");
        const normalHasKey = !!el(normalId)?.querySelector(".actions button.exempt");
        const before = FIX.blocks.find((b) => b.id === tempId)?.sanity_exempt;
        el(tempId)
          ?.querySelector(".actions button.exempt")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const after = FIX.blocks.find((b) => b.id === tempId)?.sanity_exempt;
        const markShown = !!el(tempId)?.querySelector(".exempt-mark");
        // 再点一下恢复（别把假库留在标记态）
        el(tempId)
          ?.querySelector(".actions button.exempt")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const back = FIX.blocks.find((b) => b.id === tempId)?.sanity_exempt;
        window.__DIAG.push(
          `r49① 临时块的键=${tempHasKey} 普通块的键=${normalHasKey} 标记 ${before}→${after}→${back} 记号=${markShown}`,
        );
        return tempHasKey && !normalHasKey && !before && after === true && back === false && markShown;
      },
    ],
    [
      "round49 ②：改名输入框里按 Enter —— 只提交名字，**不把块拿起**（旧 bug 的样子：块被抓起来）",
      async () => {
        await press("Escape");
        const id = FIX.blocks.find((b) => b.is_temp && b.status === "planned" && el(b.id))?.id;
        if (!id) return false;
        const clickName = async () => {
          const n = el(id)?.querySelector(".name.label");
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const x = r.left + 8;
          const y = r.top + r.height / 2;
          n.dispatchEvent(ptrEvent("pointerdown", x, y));
          n.dispatchEvent(ptrEvent("pointerup", x, y));
          n.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(30);
          return true;
        };
        if (!(await clickName())) return false;
        if (!(await clickName())) return false; // 第一次只选中，第二次才进改名
        const input = el(id)?.querySelector("input.name-input");
        if (!input) return false;
        const before = blk(id)?.label ?? null;
        input.value = "Enter 靶子";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
        await settle(40);
        const hint = gestureHintText(); // 旧 bug 会留下「拿起中：…」
        const saved = blk(id)?.label ?? null;
        const noInput = !el(id)?.querySelector("input.name-input");
        window.__DIAG.push(
          `r49② 名字 ${before}→${saved}；输入框收起了=${noInput}；手势提示=[${hint}]`,
        );
        return !hint.includes("拿起") && saved === "Enter 靶子" && noInput;
      },
    ],
    [
      "round49 ③：⚙ 里两个提醒开关（开始 / 结束）—— 关掉一个只写那一个的键",
      async () => {
        await press("Escape");
        const gear = document.querySelector(".sanity-gear");
        if (!gear) return false;
        gear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const boxes = [...document.querySelectorAll(".sanity-pop input[type=checkbox]")];
        const labels = [...document.querySelectorAll(".sanity-pop .row")].map((n) =>
          n.textContent.replace(/\s+/g, ""),
        );
        if (boxes.length < 3) return false; // 至少要有理智值 + 开始提醒 + 结束提醒三个
        const start = settingBox("块开始时提醒");
        const end = settingBox("块结束时提醒");
        if (!start || !end) return false;
        start.checked = false;
        start.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(40);
        const wroteStart =
          window.__LAST_SETTING?.[0] === "remind_start" && window.__LAST_SETTING?.[1] === "0";
        const endStillOn = end.checked === true;
        start.checked = true;
        start.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(40);
        const restored = window.__LAST_SETTING?.[1] === "1";
        document
          .querySelector(".sanity-pop .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle();
        window.__DIAG.push(
          `r49③ 行=[${labels.join(" | ")}] 写库=${JSON.stringify(window.__LAST_SETTING)} 结束开关没被动=${endStillOn} 还原=${restored}`,
        );
        return (
          wroteStart &&
          endStillOn &&
          restored &&
          labels.some((l) => l.includes("块开始时提醒")) &&
          labels.some((l) => l.includes("块结束时提醒"))
        );
      },
    ],
    [
      "round49 ④：分组视图里**组内**拖抓手能换位（别的组一个都不动）",
      async () => {
        await press("Escape");
        const toggle = document.querySelector(".tools .group-toggle");
        if (!toggle) return false;
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const withKey = [...new Set([...document.querySelectorAll(".list .item")].map((n) => n.getAttribute("data-group")))];
        const pick = withKey.find(
          (k) => document.querySelectorAll(`.list .item[data-group="${CSS.escape(k)}"]`).length >= 2,
        );
        if (!pick) return false;
        const labelsOf = (groupKey) =>
          [...document.querySelectorAll(`.list .item[data-group="${CSS.escape(groupKey)}"]`)].map(
            (r) => rowLabel(r),
          );
        const others = () =>
          [...document.querySelectorAll(".list .item")]
            .filter((r) => r.getAttribute("data-group") !== pick)
            .map((r) => rowLabel(r));
        const before = labelsOf(pick);
        const othersBefore = others();
        const rows = [...document.querySelectorAll(`.list .item[data-group="${CSS.escape(pick)}"]`)];
        const grip = rows[0].querySelector(".grip");
        const target = rows[1].getBoundingClientRect();
        const gr = grip.getBoundingClientRect();
        grip.dispatchEvent(ptrEvent("pointerdown", gr.left + 8, gr.top + gr.height / 2));
        await settle();
        window.dispatchEvent(ptrEvent("pointermove", gr.left + 8, target.bottom - 4));
        await settle();
        const line = document.querySelectorAll(".list .item.drop-before, .list .item.drop-after").length;
        window.dispatchEvent(ptrEvent("pointerup", gr.left + 8, target.bottom - 4));
        await settle(40);
        const after = labelsOf(pick);
        const othersAfter = others();
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r49④ 组「${pick}」前=[${before.join("|")}] 后=[${after.join("|")}] 别组不变=${othersBefore.join("|") === othersAfter.join("|")} 插入线=${line}`,
        );
        return (
          after.join("|") !== before.join("|") &&
          after.length === before.length &&
          after.slice().sort().join("|") === before.slice().sort().join("|") &&
          othersBefore.join("|") === othersAfter.join("|")
        );
      },
    ],
    [
      "round49 ⑤：「自己安排」—— 预览块跟着鼠标走、左键点一下放下；再开一次用 Esc 取消不落库",
      async () => {
        await press("Escape");
        await backToThisWeek();
        setScrollHome();
        await settle(20);
        const missed = FIX.blocks.find((b) => b.status === "missed" && el(b.id));
        if (!missed) return false;
        const openOwn = async () => {
          el(missed.id)
            ?.querySelector('button[title="重新安排"]')
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(30);
          const own = [...document.querySelectorAll(".drift button")].find((b) =>
            b.textContent.includes("自己安排"),
          );
          if (!own) return false;
          own.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(30);
          return true;
        };
        const day = [...document.querySelectorAll(".day-body")].findIndex((n) => {
          const r = n.getBoundingClientRect();
          return r.left >= 0 && r.right <= window.innerWidth;
        });
        if (day < 0) return false;
        const p = atDay(day, 10, 15);
        // 第一次：左键放下（pointerdown 就是"放下"）
        if (!(await openOwn())) return false;
        const cardGone = !document.querySelector(".drift");
        window.dispatchEvent(ptrEvent("pointermove", p.x, p.y));
        await settle(30);
        const hint = gestureHintText();
        const before = FIX.blocks.length;
        window.dispatchEvent(ptrEvent("pointerdown", p.x, p.y));
        await settle(60);
        const added = FIX.blocks.length - before;
        const ghostGone = document.querySelectorAll("body > div[style*=position]").length === 0;
        // 第二次：Esc 取消 → 不落库、也不留拖影
        if (!(await openOwn())) return false;
        window.dispatchEvent(ptrEvent("pointermove", p.x, p.y));
        await settle(20);
        const before2 = FIX.blocks.length;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await settle(40);
        const noGhost = document.querySelectorAll("body > div[style*=position]").length === 0;
        const unchanged = FIX.blocks.length === before2;
        window.__DIAG.push(
          `r49⑤ 卡片收起=${cardGone} 提示=[${hint}] 放下后新块=${added} 第一次收干净=${ghostGone}；Esc 后不变=${unchanged} 无拖影=${noGhost}`,
        );
        return cardGone && hint.includes("10:15") && added >= 1 && ghostGone && unchanged && noGhost;
      },
    ],

    // ===== round48（0.10.0）：验收回修（改名手势 / 任务级 ⊘ / 手动排序 / 15 分钟颗粒 / 不误翻周）=====

    [
      "round48 ①：临时块改名 = **先选中，再单击名字**；双击块 = 标记完成（两个手势不再打架）",
      async () => {
        await press("Escape");
        // 找一块还在、还没标记的临时块（前面的断言可能动过它们）
        const id = FIX.blocks.find((b) => b.is_temp && b.status === "planned" && el(b.id))?.id;
        if (!id) return false;
        // 「单击名字」= 真的鼠标序列（pointerdown → pointerup → click）：
        // 只发一个裸 click 不走 `onPointerDown`，`selectedBeforePress` 就永远保持 false ✗
        const clickName = async () => {
          const n = el(id)?.querySelector(".name.label");
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const x = r.left + 8;
          const y = r.top + r.height / 2;
          n.dispatchEvent(ptrEvent("pointerdown", x, y));
          n.dispatchEvent(ptrEvent("pointerup", x, y));
          n.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(30);
          return true;
        };
        // ① 未选中时单击名字 → **只选中**，不进改名
        if (!(await clickName())) return false;
        const notOpened = !el(id)?.querySelector("input.name-input");
        // ② 选中之后再单击名字 → 出现改名输入框
        if (!(await clickName())) return false;
        const input = el(id)?.querySelector("input.name-input");
        const opened = !!input;
        input?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await settle(20);
        // ③ 双击整块 → 标记完成（**不是**改名）
        const body = el(id)?.querySelector(".text") ?? el(id);
        body?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        await settle(40);
        const after = blk(id)?.status;
        const noInput = !el(id)?.querySelector("input.name-input");
        window.__DIAG.push(
          `r48① 未选中单击=${notOpened ? "只选中" : "进了改名✗"} 选中后单击=${opened} 双击后状态=${after} 没进改名=${noInput}`,
        );
        return notOpened && opened && after === "done" && noInput;
      },
    ],
    [
      "round48 ②：任务级 ⊘ —— 点 Backlog 行上的 ⊘ → 这条任务的**所有块**都不计入；**普通块**上没有那个键（临时块有自己的，见 round49 ①）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        setScrollHome();
        await settle(20);
        const day = 6; // 周日：「理智靶子」的 b60 在 10:00–11:00（那天可能还有别的块 → 看**块数**最稳）
        const before = dayBlocksCount(day);
        const row = [...document.querySelectorAll(".item")].find((n) =>
          n.textContent.includes("理智靶子"),
        );
        const btn = row?.querySelector("button.exempt");
        if (!btn) return false;
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const marked = FIX.tasks.find((t) => t.id === "t20")?.sanity_exempt === true;
        const after = dayBlocksCount(day);
        const markOnBlock = !!document.querySelector('[data-block-id="b60"] .exempt-mark');
        // round49：临时块合法地有了自己的 ⊘（它没有可挂的任务）→ 这里只要求**普通块**上没有那个键
        const noNormalKey = !document.querySelector('[data-block-id="b60"] .actions button.exempt');
        // 再点一下恢复（别把假库留在标记态）
        document
          .querySelector(".item button.exempt.off")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const restored = FIX.tasks.find((t) => t.id === "t20")?.sanity_exempt === false;
        const back = dayBlocksCount(day);
        window.__DIAG.push(
          `r48② 标记=${marked} 那天块数 ${before}→${after}→${back}；块上记号=${markOnBlock} 普通块没那个键=${noNormalKey} 已还原=${restored}`,
        );
        return marked && markOnBlock && noNormalKey && restored && after < before && back === before;
      },
    ],
    [
      "round48 ③：拖抓手 = 手动排序（顺序真落库、列表真换位）；拖行体仍然是「拖到时间轴建块」",
      async () => {
        await press("Escape");
        const before = shownTitles();
        const rows = [...document.querySelectorAll(".list .item")];
        const grip = rows[0]?.querySelector(".grip");
        if (!grip || rows.length < 3) return false;
        const target = rows[2].getBoundingClientRect();
        const gr = grip.getBoundingClientRect();
        grip.dispatchEvent(ptrEvent("pointerdown", gr.left + 8, gr.top + gr.height / 2));
        await settle();
        window.dispatchEvent(ptrEvent("pointermove", gr.left + 8, target.top + 4));
        await settle();
        const line = document.querySelectorAll(".list .item.drop-before, .list .item.drop-after").length;
        window.dispatchEvent(ptrEvent("pointerup", gr.left + 8, target.top + 4));
        await settle(40);
        const after = shownTitles();
        const wrote = Array.isArray(window.__LAST_ORDER);
        window.__DIAG.push(
          `r48③ 前=[${before.join("|")}] 后=[${after.join("|")}] 插入线=${line} 写库=${wrote}`,
        );
        return (
          wrote &&
          line === 1 &&
          after.join("|") !== before.join("|") &&
          after.length === before.length &&
          after[1] === before[0]
        );
      },
    ],
    [
      "round48 ④：抓手上的 ↑↓ 也能挪一格（键盘路径）",
      async () => {
        await press("Escape");
        const before = shownTitles();
        const grip = document.querySelector(".list .item .grip");
        if (!grip) return false;
        grip.focus();
        grip.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
        );
        await settle(40);
        const after = shownTitles();
        window.__DIAG.push(`r48④ 前=[${before.join("|")}] 后=[${after.join("|")}]`);
        return after.join("|") !== before.join("|") && after[1] === before[0];
      },
    ],
    [
      "round48 ⑤：新建任务排在最上（你选的）",
      async () => {
        await press("Escape");
        const field = document.querySelector(".new-task .field");
        if (!field) return false;
        field.value = "排序靶子";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
        document
          .querySelector(".new-task")
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await settle(40);
        const titles = shownTitles();
        window.__DIAG.push(`r48⑤ 列表第一条=[${titles[0]}]`);
        return titles[0] === "排序靶子";
      },
    ],
    [
      "round48 ⑥：拖动落点是 **15 分钟**颗粒（以前 30 分钟 → 13:15 这种格子落不到）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        setScrollHome();
        await settle(20);
        // round48：走**从 Backlog 拖任务**那条路（与「拖动已有块」同一个落点换算 `resolveDrop`）——
        // 窄窗口下抓已有块会被盖住（实测拖影=0，手势根本没起来）；这条在 715px 也稳。
        if (!dragStartTask()) return false;
        await settle();
        // 读**手势提示里的吸附结果**（不落库 → 窄窗口也不会因为列滚出屏幕而失真，
        // 也不会碰上「同任务相邻融合」那种副作用）。10:20 → 15 分钟颗粒应吸到 **10:15**
        //（旧口径 30 分钟会吸到 10:30 —— 用户实测「拖不到游戏旁边」就是它）
        const day = [...document.querySelectorAll(".day-body")].findIndex((n) => {
          const r = n.getBoundingClientRect();
          return r.left >= 0 && r.right <= window.innerWidth; // 挑一个**整列都在屏幕里**的
        });
        if (day < 0) return false;
        dragToDay(day, 10, 20);
        await settle();
        const hint = gestureHintText();
        await press("Escape"); // 取消这次手势（不落库、也不会建出新块）
        const m = hint.match(/(\d{2}):(\d{2})/);
        window.__DIAG.push(`r48⑥ 手势提示=[${hint}]（10:20 应吸到 10:15）`);
        return !!m && m[1] === "10" && m[2] === "15";
      },
    ],
    [
      "round48 ⑦：拖 Backlog 的行**不再误翻周**（指针停在 Backlog 里 1.2 秒，周一动不动）",
      async () => {
        await press("Escape");
        const rangeBefore = document.querySelector(".range")?.textContent?.trim() ?? "";
        const winBefore = lastWinFrom();
        const label = document.querySelector(".list .item .label");
        if (!label || !rangeBefore) return false;
        const r = label.getBoundingClientRect(); // 抓任务名（行左缘是抓手）
        firePointer("pointerdown", r.left + 8, r.top + r.height / 2);
        await settle();
        firePointer("pointermove", r.left + 18, r.top + r.height / 2);
        await waitMs(1200);
        const rangeAfter = document.querySelector(".range")?.textContent?.trim() ?? "";
        const winAfter = lastWinFrom();
        firePointer("pointerup", r.left + 30, r.top + r.height / 2);
        await settle(30);
        window.__DIAG.push(
          `r48⑦ 周范围 [${rangeBefore}] → [${rangeAfter}]；块窗口 ${winBefore}→${winAfter}`,
        );
        return rangeBefore === rangeAfter && winBefore === winAfter;
      },
    ],
    [
      "round48 ⑧：分类列表里「只有 1 个任务」的分类也显示数量（以前 ≥2 才显示）",
      async () => {
        await press("Escape");
        const count = new Map();
        for (const t of FIX.tasks) {
          if (t.id === "ww-temp-hidden-task" || !t.category) continue;
          count.set(t.category, (count.get(t.category) ?? 0) + 1);
        }
        let only = [...count.entries()].find(([, n]) => n === 1)?.[0];
        let owner = only ? FIX.tasks.find((t) => t.category === only) : null;
        if (!owner) {
          // 没有现成的 → 自己造一个（唯一名字，不会和别的分类撞）：打开某条任务的属性 → 打进去 → 回车
          owner = FIX.tasks.find((t) => t.id !== "ww-temp-hidden-task");
          if (!owner) return false;
          const box = await openCat(owner.title.slice(0, 3));
          if (!box) return false;
          await typeCat(box.field, "独苗分类");
          await enterCat(box.field);
          await settle(40);
          only = FIX.tasks.find((t) => t.id === owner.id)?.category ?? null;
          if (!only) return false;
        }
        const box = await openCat(owner.title.slice(0, 3));
        if (!box) return false;
        const row = catRows().find((r) => r.name === only);
        const shown = row?.count ?? "";
        await press("Escape");
        window.__DIAG.push(`r48⑧ 分类「${only}」数量=[${shown}]（应 1）`);
        return shown === "1";
      },
    ],

    [
      "round48 ⑨：分组开着时，点节头能**收起 / 展开**那一堆（节头与条数照旧显示）",
      async () => {
        await press("Escape");
        const toggle = document.querySelector(".tools .group-toggle");
        if (!toggle) return false;
        // round77（3.1b）：折叠符是 <Icon>（`chevron-down` 展开 / `chevron-right` 收起）——
        // 以前查字形「▸」，现在查图标名（判据更严：名字不对就是错）
        const caretIcon = () =>
          document.querySelector(".list .ghead [data-icon]")?.getAttribute("data-icon") ?? "";
        const groupedOn = () => toggle.getAttribute("aria-pressed") === "true";
        // 断言不假设起始状态：分组开着就先关掉（前一条断言可能留着）
        if (groupedOn()) {
          toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(30);
        }
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 开分组
        await settle(30);
        const heads = [...document.querySelectorAll(".list .ghead")];
        if (heads.length === 0) return false;
        const before = document.querySelectorAll(".list .item").length;
        const caretBefore = caretIcon();
        const headText = heads[0].textContent.replace(/\s+/g, " ").trim();
        heads[0]
          .querySelector(".ghead-btn")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const after = document.querySelectorAll(".list .item").length;
        const headsStill = document.querySelectorAll(".list .ghead").length === heads.length;
        const caretCollapsed = caretIcon(); // 收起那一刻的图标名（分组一关就查不到了）
        const collapsedText =
          document.querySelector(".list .ghead")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        // 再点一次 → 展开回来
        document
          .querySelector(".list .ghead .ghead-btn")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const back = document.querySelectorAll(".list .item").length;
        const caretExpanded = caretIcon();
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 关掉分组（别影响后面的断言）
        await settle(20);
        window.__DIAG.push(
          `r48⑨ 节头=[${headText}] 收起后=[${collapsedText}] 折叠符 ${caretBefore}→${caretCollapsed}→${caretExpanded} 行数 ${before}→${after}→${back} 节头一直在=${headsStill}`,
        );
        return (
          after < before &&
          back === before &&
          headsStill &&
          collapsedText.includes("(") &&
          caretBefore === "chevron-down" &&
          caretCollapsed === "chevron-right" &&
          caretExpanded === "chevron-down"
        );
      },
    ],

    // ===== round47（0.9.0 · 8.1 分类管理）：筛 / 分堆 / 改名·合并·清空 / 已归档筛 / 新建归属 =====

    [
      "round47 ①：按分类筛 —— 选「学习」只剩这一类；顶上「只看：学习」+ × 一键回全部",
      async () => {
        await press("Escape"); // 前面可能留着属性面板 / 选中（顺手验过 Esc 收面板）
        const before = shownTitles().length;
        const rows = await openCatMenu();
        const learn = rows?.find((r) => r.name === "学习");
        if (!learn) return false;
        await tapRow(learn);
        const expected = dbTitlesOf("学习").sort();
        const got = shownTitles().sort();
        const chip = onlyText();
        const label = catBtnEl()?.textContent.replace(/\s+/g, "") ?? "";
        document.querySelector(".only button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const back = shownTitles().length;
        const chipGone = !document.querySelector(".only");
        window.__DIAG.push(
          `r47① 筛前=${before} 行=[${got.join("|")}] 应=[${expected.join("|")}] 只看=[${chip}] 按钮=[${label}] ×后=${back} 提示没了=${chipGone}`,
        );
        return (
          expected.length > 0 &&
          got.length === expected.length &&
          got.join("|") === expected.join("|") &&
          chip.includes("只看：学习") &&
          label.startsWith("学习") &&
          back === before &&
          chipGone
        );
      },
    ],
    [
      "round47 ②：点「⊞ 分组」→ 按分类分堆（名字序、「未分类」在最后、节头带条数）；再点关掉",
      async () => {
        const toggle = document.querySelector(".tools .group-toggle");
        if (!toggle) return false;
        // 期望值**从假库现算**（不写死数字）
        const visible = FIX.tasks.filter(
          (t) => t.archived_at == null && t.id !== "ww-temp-hidden-task",
        );
        const buckets = new Map();
        for (const t of visible) {
          const k = t.category ?? "";
          buckets.set(k, (buckets.get(k) ?? 0) + 1);
        }
        const expected = [...buckets.entries()]
          .sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0])))
          .map(([k, n]) => `${k === "" ? "未分类" : k} (${n})`);

        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        // round48：节头多了折叠箭头（▾/▸）—— 断言只比「名字 (条数)」，箭头归一化掉
        const heads = [...document.querySelectorAll(".list .ghead")].map((n) =>
          n.textContent.replace(/\s+/g, " ").replace(/^[▾▸]\s*/, "").trim(),
        );
        const rows = shownTitles().length;
        const pressed = toggle.getAttribute("aria-pressed") === "true";
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 关掉，别把后面留在分组态
        await settle(30);
        const headsOff = document.querySelectorAll(".list .ghead").length;
        window.__DIAG.push(
          `r47② 节头=[${heads.join(" | ")}] 应=[${expected.join(" | ")}] 行=${rows}/${visible.length} 按下=${pressed} 关掉后节头=${headsOff}`,
        );
        return (
          heads.join("|") === expected.join("|") &&
          heads.length >= 1 &&
          rows === visible.length &&
          pressed &&
          headsOff === 0
        );
      },
    ],
    [
      "round47 ③：管理页里给「工作」改名「办公」—— 保存前先写清影响几条，保存后真写库 + 可撤销提示",
      async () => {
        const count = dbCountOf("工作"); // 管理页的口径：**含已归档**（提示里写的也是它）
        const r = await renameCat("工作", "办公");
        if (!r) return false;
        const moved = FIX.tasks
          .filter((t) => t.category === "办公")
          .map((t) => t.title)
          .sort();
        const wrote = Array.isArray(r.wrote) && r.wrote[0] === "工作" && r.wrote[1] === "办公";
        const toast = toastText();
        window.__DIAG.push(
          `r47③ 提示=[${r.hint}] 写库=${JSON.stringify(r.wrote)} 办公=[${moved.join("|")}] 提示条=[${toast}]`,
        );
        return (
          count > 0 &&
          r.hint.includes(`保存后 ${count} 个任务跟着改`) &&
          wrote &&
          moved.length === count &&
          toast.includes("已改名")
        );
      },
    ],
    [
      "round47 ④：把「办公」改成已有的「学习」→ 就是合并（提示写「共 N 个任务」；旧名字从库里消失）",
      async () => {
        const src = dbCountOf("办公");
        const target = dbCountOf("学习");
        const r = await renameCat("办公", "学习");
        if (!r) return false;
        const gone = !FIX.tasks.some((t) => t.category === "办公");
        const merged = dbCountOf("学习");
        const toast = toastText();
        window.__DIAG.push(
          `r47④ 提示=[${r.hint}] 旧名没了=${gone} 学习=${merged}（应 ${src + target}）提示条=[${toast}]`,
        );
        return (
          src > 0 &&
          r.hint.includes(`共 ${src + target} 个任务`) &&
          gone &&
          merged === src + target &&
          toast.includes("合并进")
        );
      },
    ],
    [
      "round47 ⑤：已归档也能按分类筛（计数变 n / 总数，选项只列归档里真有的分类）",
      async () => {
        // 前置：归档里得有**带分类**的任务 —— `--only round47` 单跑时前面那些归档断言没跑过
        if (!FIX.tasks.some((t) => t.archived_at != null && t.category)) {
          const victim = FIX.tasks.find(
            (t) => t.archived_at == null && t.category && t.id !== "ww-temp-hidden-task",
          );
          if (!victim) return false;
          const row = await openPropsOf(victim.title.slice(0, 3));
          row
            ?.querySelector(".props .archive")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(40);
        }
        const toggle = await openArchived();
        if (!toggle) return false;
        const arch = FIX.tasks.filter(
          (t) => t.archived_at != null && t.id !== "ww-temp-hidden-task",
        );
        const cats = [...new Set(arch.map((t) => t.category).filter(Boolean))].sort((a, b) =>
          a.localeCompare(b),
        );
        const expected = ["全部", ...cats];
        if (arch.some((t) => !t.category)) expected.push("未分类");

        const rows = await openCatMenu(".arch-head");
        if (!rows) return false;
        const names = rows.map((r) => r.name);
        const learn = rows.find((r) => r.name === "学习");
        await tapRow(learn);
        const shownRows = [...document.querySelectorAll(".arch-list li .arch-title")].map((n) =>
          n.textContent.trim(),
        );
        const wantRows = arch.filter((t) => t.category === "学习").map((t) => t.title);
        const label = document.querySelector(".arch-toggle")?.textContent.replace(/\s+/g, "") ?? "";
        // 收尾：清掉归档那栏的筛选，别把后面的断言 / 截图留在筛选态
        await tapRow((await openCatMenu(".arch-head"))?.find((r) => r.name === "全部"));
        const cleared = document.querySelector(".arch-toggle")?.textContent.replace(/\s+/g, "") ?? "";
        window.__DIAG.push(
          `r47⑤ 选项=[${names.join("|")}] 应=[${expected.join("|")}] 归档行=[${shownRows.join("|")}] 应=[${wantRows.join("|")}] 计数=[${label}] 取消后=[${cleared}]`,
        );
        return (
          names.join("|") === expected.join("|") &&
          wantRows.length > 0 &&
          shownRows.join("|") === wantRows.join("|") &&
          label.includes(`${wantRows.length}/${arch.length}`) &&
          !cleared.includes("/")
        );
      },
    ],
    [
      "round47 ⑥：筛「学习」时新建任务 → **直接归到学习**（不用再手动设一遍）",
      async () => {
        const learn = (await openCatMenu())?.find((r) => r.name === "学习");
        if (!learn) return false;
        await tapRow(learn);
        const field = document.querySelector(".new-task .field");
        if (!field) return false;
        field.value = "分类归属靶子";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
        document
          .querySelector(".new-task")
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await settle(40);
        const created = FIX.tasks.find((t) => t.title === "分类归属靶子");
        const visibleInFilter = shownTitles().includes("分类归属靶子");
        document.querySelector(".only button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r47⑥ 新任务的分类=[${created?.category}] 筛选里可见=${visibleInFilter} 库里=学习个数 ${FIX.tasks.filter((t) => t.category === "学习").length}`,
        );
        return created?.category === "学习" && visibleInFilter;
      },
    ],
    [
      "round47 ⑦：改名后 Ctrl+Z —— 界面上的筛选值自动回「全部」（不会停在已不存在的分类上）",
      async () => {
        const learn = (await openCatMenu())?.find((r) => r.name === "学习");
        if (!learn) return false;
        await tapRow(learn);
        const filtered = onlyText().includes("只看：学习");
        const r = await renameCat("学习", "学习X"); // 筛选值指向的分类被改没了
        if (!r) return false;
        const chipAfter = onlyText();
        const labelAfter = catBtnEl()?.textContent.replace(/\s+/g, "") ?? "";
        const rowsAfter = shownTitles().length;
        keydown("z", { ctrlKey: true }); // Ctrl+Z 撤销那次改名
        await settle(60);
        const restored = dbCountOf("学习");
        const backInList = dbTitlesOf("学习").filter((t) => shownTitles().includes(t)).length;
        window.__DIAG.push(
          `r47⑦ 筛上=${filtered} 改名后只看=[${chipAfter}] 按钮=[${labelAfter}] 行数=${rowsAfter} 撤销后库里学习=${restored} 界面认=${backInList}`,
        );
        return (
          filtered &&
          chipAfter === "" &&
          labelAfter.startsWith("全部") &&
          rowsAfter > 0 &&
          restored > 0 &&
          backInList === dbTitlesOf("学习").length
        );
      },
    ],
    [
      "round47 ⑧：清空一个分类 = 这些任务回到「未分类」（未分类那一堆/选项出现；Ctrl+Z 能把分类拿回来）",
      async () => {
        const before = dbCountOf("学习");
        const r = await renameCat("学习", "");
        if (!r) return false;
        const cleared = dbCountOf("学习") === 0;
        const rows = await openCatMenu();
        const hasUncategorized = !!rows?.some((row) => row.name === "未分类");
        const noLearn = !rows?.some((row) => row.name === "学习");
        await closeCatMenu();
        const toast = toastText();
        keydown("z", { ctrlKey: true }); // 收尾：把分类拿回来（截图与后续都不至于一片素）
        await settle(60);
        const restored = dbCountOf("学习");
        window.__DIAG.push(
          `r47⑧ 提示=[${r.hint}] 清空前=${before} 清掉了=${cleared} 出现未分类=${hasUncategorized} 学习没了=${noLearn} 提示条=[${toast}] 撤销后学习=${restored}`,
        );
        return (
          before > 0 &&
          r.hint.includes(`清空 = 这 ${before} 个任务回到「未分类」`) &&
          cleared &&
          hasUncategorized &&
          noLearn &&
          toast.includes("已清空") &&
          restored === before
        );
      },
    ],
    [
      "round47 ⑨：栏拖到最窄（180px）时头部不溢出（两个控件换行、不截断）",
      async () => {
        const splitter = document.querySelector(".splitter");
        const backlog = document.querySelector(".backlog");
        if (!splitter || !backlog) return false;
        const r = splitter.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        splitter.dispatchEvent(ptrEvent("pointerdown", x, y));
        await settle();
        for (const dx of [-40, -80, -120]) {
          window.dispatchEvent(ptrEvent("pointermove", x + dx, y));
          await settle();
        }
        window.dispatchEvent(ptrEvent("pointerup", x - 120, y));
        await settle(30);
        const width = Math.round(backlog.getBoundingClientRect().width);
        const overflow = backlog.scrollWidth - backlog.clientWidth;
        const tools = document.querySelector(".tools .cat-btn") && document.querySelector(".tools .group-toggle");
        const inside = [...document.querySelectorAll(".tools > *")].every(
          (n) => n.getBoundingClientRect().right <= backlog.getBoundingClientRect().right + 1,
        );
        splitter.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); // 复位，别影响截图
        await settle(30);
        const reset = Math.round(backlog.getBoundingClientRect().width);
        window.__DIAG.push(
          `r47⑨ 最窄=${width}px 横向溢出=${overflow} 两个控件=${!!tools} 都在框内=${inside} 复位=${reset}px`,
        );
        return overflow <= 1 && !!tools && inside && Math.abs(reset - 260) <= 2;
      },
    ],

    // ===== round52（C7 复盘 / 0.12.0）：马赛克 + 曲线 + 明细 + 未完成列表 + 提醒 =====
    // 数据集是**延迟种**的（第一条断言 `seedR52()`）；期望值一律从假库现算，不写死数字。
    [
      "round52 ①：点「▦ 复盘」→ 面板打开，且拉的是**正在看的那一周**（W-1）",
      async () => {
        seedR52();
        await gotoWeek(-1);
        const before = mosaicCalls().length;
        const opened = await openReview();
        const call = mosaicCalls()[before];
        const rows = mosaicRows().length;
        const box = panel()?.getBoundingClientRect();
        const visible = !!box && box.width > 200 && box.height > 100;
        const hit = box
          ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          : null;
        const onTop = !!hit?.closest?.(".review-panel");
        window.__DIAG.push(
          `r52① 开了=${opened} 行=${rows} 拉周=${call === weekStartOf(-1) ? "对" : call} 尺寸=${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)} 最上层=${onTop}${onTop ? "" : "（命中=" + (hit?.className ?? "null") + "）"}`,
        );
        return opened && call === weekStartOf(-1) && rows > 0 && visible && onTop;
      },
    ],
    [
      "round52 ②：同一块里三种完成态各拿得到 + **每块结局与独立复算一致**（W-1 全量）",
      async () => {
        seedR52();
        await gotoWeek(-1);
        if (!(await openReview())) return false;
        await ensureMode("state");
        const mondayStates = new Set(mosaicTiles(mosaicRows()[0]).map(tileState));
        const threeOnMonday = ["done", "done_overtime", "done_short"].every((s) => mondayStates.has(s));
        const tiles = mosaicTiles();
        const bad = [];
        for (const el of tiles) {
          const id = el.getAttribute("data-block-id") ?? "";
          const b = blockById(id);
          if (!b) bad.push(id + "?");
          else if (tileState(el) !== stateOfBlock(b)) bad.push(`${id}:${tileState(el)}≠${stateOfBlock(b)}`);
        }
        const countOk = tiles.length === weekBlocksOf(-1).length;
        window.__DIAG.push(
          `r52② 周一=[${[...mondayStates].join(",")}] 方块=${tiles.length}/${weekBlocksOf(-1).length} 不一致=[${bad.slice(0, 6).join(" ")}]`,
        );
        return threeOnMonday && countOk && bad.length === 0;
      },
    ],
    [
      "round52 ③：切「按类别」→ 行头按名字序、**未分类最后**；两种读法块数守恒",
      async () => {
        seedR52();
        await gotoWeek(-1);
        if (!(await openReview())) return false;
        await ensureMode("state");
        const stateCount = mosaicTiles().length;
        if (!(await ensureMode("category"))) return false;
        const heads = mosaicRows().map((r) => rowText(r.querySelector(".head") ?? r));
        // 独立复算：这一周的块 → 分类集合 → 名字序、未分类最后（与 utils/category.ts 同口径）
        const names = [...new Set(weekBlocksOf(-1).map((b) => categoryOfBlock(b)))];
        const want = names.filter((n) => n !== null).sort((a, b) => a.localeCompare(b));
        if (names.includes(null)) want.push(null);
        const wantLabels = want.map((n) => n ?? "未分类");
        const orderOk =
          heads.length === wantLabels.length && heads.every((t, i) => t.startsWith(wantLabels[i]));
        const catCount = mosaicTiles().length;
        window.__DIAG.push(
          `r52③ 行头=[${heads.join("|")}] 期望=[${wantLabels.join("|")}] 块数=${stateCount}→${catCount}`,
        );
        await ensureMode("state");
        return orderOk && catCount === stateCount && heads.length > 2;
      },
    ],
    [
      "round52 ④：点某一天 → 明细行数与库里一致（带时间与任务名）",
      async () => {
        seedR52();
        await gotoWeek(-1);
        if (!(await openReview())) return false;
        await ensureMode("state");
        const target = at(-6, 0, 0); // W-1 周二（超载日：r52n04 / r52n05）
        // round53：整行都是按钮了（以前只有 `.head .pick` 那个小按钮）
        mosaicRows()[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const ids = detailRows().map((n) => n.getAttribute("data-block-id"));
        const want = weekBlocksOf(-1)
          .filter((b) => localDayStart(Math.max(b.start_at, weekStartOf(-1))) === target)
          .map((b) => b.id);
        const same = ids.length === want.length && want.every((id) => ids.includes(id));
        const text = detailRows().map(rowText).join(" ｜ ");
        const hasTime = /09:00–12:00/.test(text) && text.includes("写季度总结");
        window.__DIAG.push(`r52④ 明细=${ids.length}/${want.length} 文本=[${text.slice(0, 70)}]`);
        return same && hasTime;
      },
    ],
    [
      "round52 ⑤：明细点一条 → 面板关 + 时间轴选中那块",
      async () => {
        seedR52();
        await gotoWeek(-1);
        if (!(await openReview())) return false;
        const first = detailRows()[0];
        const id = first?.getAttribute("data-block-id");
        first?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const closed = panelClosed();
        const el2 = id ? document.querySelector(`[data-block-id="${id}"]`) : null;
        const selected = !!el2 && el2.classList.contains("selected");
        window.__DIAG.push(`r52⑤ 关=${closed} 选中=${selected}（${id}）`);
        return closed && selected;
      },
    ],
    [
      "round52 ⑥：明细行里的 ⊘ → 真写库（任务级）+ 日头小条跟着变（用完还原）",
      async () => {
        seedR52();
        await gotoWeek(-1);
        if (!(await openReview())) return false;
        await ensureMode("state");
        // round53：整行都是按钮了
        mosaicRows()[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 周三
        await settle(30);
        const row = detailRows().find((n) => n.getAttribute("data-block-id") === "r52n07");
        const btn = row?.querySelector(".exempt-toggle");
        if (!btn) return false;
        const titleBefore = dayBarTitle(2);
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const wrote = taskById("r52t-balcony")?.sanity_exempt === true;
        const titleAfter = dayBarTitle(2);
        const changed = titleBefore !== titleAfter && titleAfter.includes("占用");
        detailRows()
          .find((n) => n.getAttribute("data-block-id") === "r52n07")
          ?.querySelector(".exempt-toggle")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const restored = taskById("r52t-balcony")?.sanity_exempt === false;
        window.__DIAG.push(
          `r52⑥ 写库=${wrote} 小条变=${changed} 还原=${restored} 前=[${titleBefore.slice(-16)}] 后=[${titleAfter.slice(-16)}]`,
        );
        return wrote && changed && restored;
      },
    ],
    [
      "round52 ⑦：顶部那句 ⚠ 可点开，并聚焦**第一个超载天**（W-1 周二）",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await shutReview();
        const strip = document.querySelector(".sanity");
        // round77（3.1b）：橙条改成「div 容器 + 主按钮（整条可点）+ 关闭钮」→ 点主按钮
        strip?.querySelector(".sanity-main")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const active = rowText(panel()?.querySelector(".mosaic .row.active") ?? { textContent: "" });
        window.__DIAG.push(`r52⑦ 有那句话=${!!strip} 开了=${!!panel()} 聚焦=[${active}]`);
        return !!strip && !!panel() && active.includes("周二");
      },
    ],
    [
      "round52 ⑧：点日头小条 → 面板定位到那一天",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await shutReview();
        document
          .querySelectorAll(".day-head .load")
          [3]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const active = rowText(panel()?.querySelector(".mosaic .row.active") ?? { textContent: "" });
        window.__DIAG.push(`r52⑧ 开了=${!!panel()} 聚焦=[${active}]`);
        return !!panel() && active.includes("周四");
      },
    ],
    [
      "round52 ⑨：Esc 关面板（**先关自己**，不顺手清掉块的选中 —— 台账 #29）",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await selectByClick("r52n04");
        const selectedBefore = document
          .querySelector('[data-block-id="r52n04"]')
          ?.classList.contains("selected");
        await openReview();
        // 真键盘事件的目标是**焦点元素**、再转到 window：所以这里在 body 上派发
        // （直接在 window 上派发时，capture 与 bubble 监听器在 AT_TARGET 阶段只按注册顺序跑 ✗）
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await settle(30);
        const closed = panelClosed();
        const stillSelected = document
          .querySelector('[data-block-id="r52n04"]')
          ?.classList.contains("selected");
        window.__DIAG.push(`r52⑨ 关=${closed} 选中前=${selectedBefore} 选中后=${stillSelected}`);
        return closed && !!selectedBefore && !!stillSelected;
      },
    ],
    [
      "round52 ⑩：空周（W-4）→ 空态一句话，不是白板",
      async () => {
        seedR52();
        await gotoWeek(-4);
        await openReview();
        const empty = rowText(panel()?.querySelector(".empty") ?? { textContent: "" });
        const noTiles = mosaicTiles().length === 0;
        const dbEmpty = weekBlocksOf(-4).length;
        window.__DIAG.push(`r52⑩ 空态=[${empty}] 方块=${noTiles ? 0 : "有"} 库里=${dbEmpty}`);
        await shutReview();
        return noTiles && dbEmpty === 0 && empty.includes("没有安排");
      },
    ],
    [
      "round52 ⑪（round55 重写：两行一天）：对比开着 → 马赛克**一天两行**（上周淡在上、本周实在下，起点相同）；上周空周时写「—」占位",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await openReview();
        const callsBefore = mosaicCalls().length;
        if (!(await ensureCompare(true))) return false;
        await settle(40);
        const callsAfter = mosaicCalls().length;
        const boxNow =
          Number(panel()?.querySelector("[data-baseline]")?.getAttribute("data-baseline") ?? 0) > 0;
        // ① 每一行（除图例外）都该是**两个 `.sub`**：上一个（淡）、下一个（实）；**不再有 `|` 分隔符**
        const rows = mosaicRows();
        const pairs = rows.map((r) => {
          const subs = [...r.querySelectorAll(".sub")];
          return {
            subs: subs.length,
            prev: [...(subs[0]?.querySelectorAll(".tile") ?? [])].map((n) =>
              n.getAttribute("data-block-id"),
            ),
            prevDim: !!subs[0]?.querySelector(".tiles.dim"),
            cur: [...(subs[1]?.querySelectorAll(".tile") ?? [])].map((n) =>
              n.getAttribute("data-block-id"),
            ),
            curNotDim: !!subs[1]?.querySelector(".tiles:not(.dim)"),
            sep: !!r.querySelector(".sep"),
            // 两组的**第一个方块起点要对齐**（或空组用「—」占位）—— 这是「换行对齐」的核心
            x: subs.map((s) =>
              Math.round(
                (s.querySelector(".tile, .none") ?? s).getBoundingClientRect().left,
              ),
            ),
            // 还要等于**方块列自己的左边缘**（否则两个 `.sub` 各自偏移也能凑出「相等」）
            stacksX: Math.round((r.querySelector(".stacks") ?? r).getBoundingClientRect().left),
          };
        });
        const twoSubs = pairs.every((p) => p.subs === 2 && p.prevDim && p.curNotDim);
        const noSep = pairs.every((p) => !p.sep) && !/\uFF5C/.test(panel()?.textContent ?? "");
        const startAligned = pairs.every(
          (p) =>
            p.x.length === 2 &&
            Math.abs(p.x[0] - p.x[1]) <= 1 &&
            p.x.every((v) => Math.abs(v - p.stacksX) <= 1),
        );
        // ② 上周那组的 id 必须正好是**上周自己那一天**的块（按天对齐；不是本周的）
        const wsPrev = weekStartOf(-2);
        const prevIds = weekBlocksOf(-2).map((b) => b.id);
        const gotPrev = pairs.flatMap((p) => p.prev);
        const sameSet =
          gotPrev.length === prevIds.length && prevIds.every((id) => gotPrev.includes(id));
        const dayOf = (b) => localDayStart(Math.max(b.start_at, wsPrev));
        const byDay = pairs.every((p, i) => {
          const want = weekBlocksOf(-2).filter((b) => dayOf(b) === wsPrev + i * 86400).map((b) => b.id);
          return want.length === p.prev.length && want.every((id) => p.prev.includes(id));
        });
        // 图例也应是**两行**（上周 / 本周），不再带 `|`
        const legendLines = [...(panel()?.querySelectorAll(".pair-legend span") ?? [])]
          .map((n) => rowText(n))
          .filter((t) => t === "上周" || t === "这一周");
        // ③ 上周是空周（W-3 的上一周 = W-4 空）→ 每行的上周那格写「—」占位
        await gotoWeek(-3);
        await settle(40);
        const noneMarks = panel()?.querySelectorAll(".sub.prev .none").length ?? 0;
        const noPrevTiles = panel()?.querySelectorAll(".tiles.dim .tile").length === 0;
        const stillPaired = !!panel()?.querySelector(".pair-legend");
        await ensureCompare(false);
        await shutReview();
        window.__DIAG.push(
          `r55⑪ 拉周 ${callsBefore}→${callsAfter} 框=${boxNow} 行=${pairs.length} 两子行=${twoSubs} 无分隔符=${noSep} 起点齐=${startAligned} x=${JSON.stringify(pairs.map((p) => p.x))} 上周方块=${gotPrev.length}/${prevIds.length} 按天=${byDay} 图例两行=[${legendLines.join("/")}] 空周 —=${noneMarks} 并排还在=${stillPaired}`,
        );
        return (
          boxNow === true &&
          callsAfter > callsBefore &&
          twoSubs &&
          noSep &&
          startAligned &&
          sameSet &&
          byDay &&
          legendLines.length === 2 &&
          noPrevTiles &&
          noneMarks === 7 &&
          stillPaired
        );
      },
    ],
    [
      "round52 ⑫：「本周未完成」条数 = 库里 missed 数；点 ↻ → 面板关 + 漂流卡出现",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await openReview();
        const want = weekBlocksOf(-1).filter((b) => stateOfBlock(b) === "missed").map((b) => b.id);
        const listEl = panel()?.querySelector(".missed");
        const listIds = [...(listEl?.querySelectorAll("li[data-block-id]") ?? [])].map((n) =>
          n.getAttribute("data-block-id"),
        );
        const same = listIds.length === want.length && want.every((id) => listIds.includes(id));
        const first = listEl?.querySelector(".reschedule");
        const firstId = first?.getAttribute("data-block-id");
        first?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const closed = panelClosed();
        const drift = !!document.querySelector(".drift");
        await press("Escape"); // 收尾：关掉漂流卡（别把截图带脏）
        await settle(20);
        window.__DIAG.push(`r52⑫ 列表=${listIds.length}/${want.length} ↻=(${firstId}) 关=${closed} 漂流卡=${drift}`);
        return same && closed && drift;
      },
    ],
    [
      "round52 ⑬：面板不横向溢出、方块不越出行（1500 / 715 两种宽度都要过）",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await openReview();
        const p = panel();
        if (!p) return false;
        const overflow = p.scrollWidth - p.clientWidth;
        const box = p.getBoundingClientRect();
        const onScreen = box.width > 200 && box.height > 100 && box.top < innerHeight && box.bottom > 0;
        const rows = mosaicRows();
        const fits = rows.every((r) => {
          const rr = r.getBoundingClientRect();
          return [...r.querySelectorAll(".tile")].every((t) => {
            const tr = t.getBoundingClientRect();
            return tr.width > 0 && tr.right <= rr.right + 1 && tr.left >= rr.left - 1;
          });
        });
        window.__DIAG.push(
          `r52⑬ 溢出=${overflow}px 行内不越界=${fits} 行=${rows.length} 面板=${Math.round(box.width)}x${Math.round(box.height)} 在屏内=${onScreen}`,
        );
        await shutReview();
        return overflow <= 1 && fits && rows.length > 0 && onScreen;
      },
    ],
    [
      "round52 ⑰：不变式 —— 每块恰好一个方块、两种视图块数守恒（密集周 + 随机周）",
      async () => {
        seedR52();
        let ok = true;
        const report = [];
        for (const [offset, label] of [
          [-2, "密集周"],
          [-7, "随机周"],
        ]) {
          await gotoWeek(offset);
          await openReview();
          await ensureMode("state");
          const got = tileIds().sort();
          const want = weekBlocksOf(offset)
            .map((b) => b.id)
            .sort();
          const once = got.length === want.length && got.every((id, i) => id === want[i]);
          const mismatch = mosaicTiles().filter((el) => {
            const b = blockById(el.getAttribute("data-block-id"));
            return !b || tileState(el) !== stateOfBlock(b);
          }).length;
          await ensureMode("category");
          const conserved = tileIds().length === got.length;
          if (!(once && conserved && mismatch === 0)) ok = false;
          report.push(`${label}:${got.length}/${want.length} 守恒=${conserved} 不一致=${mismatch}`);
          await ensureMode("state");
        }
        window.__DIAG.push(`r52⑰ ${report.join(" ")}`);
        await shutReview();
        return ok;
      },
    ],
    [
      "round52 ⑱：曲线与事实小图的数字与假库现算一致（W-1）",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await openReview();
        const gotMinutes = curveMinutes();
        const wantMinutes = Array.from({ length: 7 }, (_, i) => dayUnionMinutes(FIX, i, weekStartOf(-1)));
        const curveOk =
          gotMinutes.length === 7 && gotMinutes.every((v, i) => Math.abs(v - wantMinutes[i]) <= 1);
        const week = weekBlocksOf(-1);
        const onDay = (b, i) => localDayStart(Math.max(b.start_at, weekStartOf(-1))) === at(-7 + i, 0, 0);
        const wantRearr = Array.from(
          { length: 7 },
          (_, i) => week.filter((b) => onDay(b, i) && (FIX.facts[b.id]?.rearranged ?? 0) >= 2).length,
        );
        const wantSkip = Array.from(
          { length: 7 },
          (_, i) => week.filter((b) => onDay(b, i) && FIX.facts[b.id]?.skipped).length,
        );
        const gotRearr = factCounts("rearranged");
        const gotSkip = factCounts("skipped");
        const factsOk =
          JSON.stringify(gotRearr) === JSON.stringify(wantRearr) &&
          JSON.stringify(gotSkip) === JSON.stringify(wantSkip);
        window.__DIAG.push(
          `r52⑱ 分钟=[${gotMinutes}]/${wantMinutes} 挪过=[${gotRearr}]/${wantRearr} 没做完=[${gotSkip}]/${wantSkip}`,
        );
        await shutReview();
        return curveOk && factsOk;
      },
    ],
    [
      "round52 ⑲：未来周只出 planned；极端周的跨周块归到周一且只画一次",
      async () => {
        seedR52();
        await gotoWeek(3);
        await openReview();
        await ensureMode("state");
        const futStates = mosaicTiles()
          .filter((el) => (el.getAttribute("data-block-id") ?? "").startsWith("r52f"))
          .map(tileState)
          .sort();
        await gotoWeek(-3);
        const ids = tileIds();
        const x04 = ids.filter((id) => id === "r52x04").length;
        const x01 = ids.filter((id) => id === "r52x01").length;
        // W-2（下一周）：上周日 22:00 伸进来的那块要归到**周一**，且只画一次
        await gotoWeek(-2);
        const ids2 = tileIds();
        const x04b = ids2.filter((id) => id === "r52x04").length;
        const x04day = panel()?.querySelector('[data-block-id="r52x04"]')?.getAttribute("data-day");
        const dayOk = x04day === String(at(-14, 0, 0));
        window.__DIAG.push(
          `r52⑲ 未来周=[${futStates.join(",")}] W-3：跨周=${x04} 72h=${x01} W-2：跨周=${x04b} 归周一=${dayOk}(${x04day})`,
        );
        await shutReview();
        await gotoWeek(0); // 收尾：回本周（截图用）
        return (
          JSON.stringify(futStates) === JSON.stringify(["done", "planned", "planned", "planned"]) &&
          x04 === 1 &&
          x01 === 1 &&
          x04b === 1 &&
          dayOk
        );
      },
    ],
    [
      "round52 ⑭：到点 → 头部出现提醒 + 按钮小点；✕ 关掉后不再出现（水位线已推进）",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await shutReview();
        window.__FAKE_NOW = at(6, 21, 0); // 本周日 21:00（默认 sun 20:00 的窗口内）
        // round77：同屏最多一条（橙 > 绿）—— 绿条要出现，先让橙条退场
        const clearedOverload = await dismissOverloadBar();
        await checkNudgeViaFocus();
        const line = document.querySelector(".nudge");
        const text = rowText(line ?? { textContent: "" });
        const dot = !!document.querySelector(".review-open.dot");
        line?.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const gone = !document.querySelector(".nudge");
        const watermark = window.__LAST_NUDGE;
        // 再查一次：后端水位线已推进 → 不再出现（等价于「重启也不重复」）
        await checkNudgeViaFocus();
        const notAgain = !document.querySelector(".nudge");
        const noDot = !document.querySelector(".review-open.dot");
        window.__FAKE_NOW = null;
        // 收尾：把水位线抹掉（后面的断言还要用提醒）
        sanityState.nudgedWeek = null;
        window.__DIAG.push(
          `r52⑭ 清橙条=${clearedOverload} 提示=[${text.slice(0, 22)}] 小点=${dot} ✕后=${gone} 水位线=${watermark} 再查=${notAgain} 小点没了=${noDot}`,
        );
        return (
          !!line && text.includes("复盘") && dot && gone && notAgain && noDot && watermark === at(0, 0, 0)
        );
      },
    ],
    [
      "round52 ⑮：点提醒里的「打开总览」→ **总览**开在提醒说的那一周（周一设定 = 上一周）",
      async () => {
        seedR52();
        await gotoWeek(0);
        await shutReview();
        if (!(await setRemindViaGear("hint", "mon", "09:00"))) return false;
        await dismissOverloadBar(); // round77：同上（绿条要出现）
        sanityState.nudgedWeek = null;
        window.__FAKE_NOW = at(7, 10, 0); // 下周一 10:00 → 提醒对象 = 刚过完的那一周（本周）
        await checkNudgeViaFocus();
        const line = document.querySelector(".nudge");
        await gotoWeek(-2); // 故意先站到两周前，验「会切回提醒说的那一周」
        line?.querySelector(".open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const opened = !!panel();
        const noCard = !document.querySelector(".weekcard");
        const lastCall = mosaicCalls().slice(-1)[0];
        const rightWeek = lastCall === at(0, 0, 0);
        const range = rowText(panel()?.querySelector(".range") ?? { textContent: "" });
        window.__FAKE_NOW = null;
        await shutReview();
        await setRemindViaGear("hint", "sun", "20:00"); // 还原默认
        window.__DIAG.push(`r52⑮ 提示=${!!line} 总览=${opened} 无卡片=${noCard} 拉周=${rightWeek}（末次=${lastCall}）周范围=[${range}]`);
        return !!line && opened && noCard && rightWeek && range.length > 0;
      },
    ],
    [
      "round57（0.13.0）：⚙ 里「到点时」三选一（open / hint / off）+ 时刻 —— 两个键真写库；旧的 review_remind 已退役",
      async () => {
        seedR52();
        const ok = await setRemindViaGear("open", "mon", "09:00");
        const wroteAt = sanityState.reviewRemindAt;
        const wroteAction = sanityState.reviewAction;
        const ok2 = await setRemindViaGear("off", "sun", "20:00");
        const off = sanityState.reviewAction === "off";
        const wroteBack = sanityState.reviewRemindAt === "sun 20:00";
        const lastKey = (window.__LAST_SETTING || [])[0];
        window.__DIAG.push(
          `r57⚙ 控件=${ok && ok2} 写库=[${wroteAt}/${wroteAction}] 关掉=${off} 还原=[${sanityState.reviewRemindAt}] 最后一个键=${lastKey}`,
        );
        // 收尾：恢复默认（别影响后面的断言与截图）
        sanityState.reviewAction = "hint";
        sanityState.reviewRemindAt = "sun 20:00";
        return ok && ok2 && wroteAt === "mon 09:00" && wroteAction === "open" && off && wroteBack;
      },
    ],
    // ===== round53（0.12.1）：验收回修五条（面板刷新 / 行任意处可点 / 默认「今天」 / 措辞与可见性 / 名字） =====
    [
      "round53 ①：面板关着时拖了块 → 再打开必须是**最新**的（不能拿旧快照）",
      async () => {
        seedR52();
        await gotoWeek(0);
        await shutReview();
        if (!(await openReview())) return false; // 第一次打开（拉一次，记住 loadedFrom = 本周）
        await shutReview();
        const before = weekBlocksOf(0).length;
        const dragged = await dragTaskTo("写周报", 2, 9, 0); // 面板关着 → 真拖一条到周三 09:00
        const dbAfter = weekBlocksOf(0).length;
        await openReview(); // 再打开 → 必须重拉
        const tiles = tileIds().length;
        window.__DIAG.push(
          `r53① 拖动=${dragged} 拖前库=${before} 拖后库=${dbAfter} 面板方块=${tiles}`,
        );
        return dbAfter === before + 1 && tiles === dbAfter;
      },
    ],
    [
      "round53 ②：点行的**任意位置**（不只是那 74px 的小按钮）→ 明细跟着换天",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await openReview();
        await ensureMode("state");
        const row = mosaicRows()[2]; // 周三
        if (!row) return false;
        const box = row.getBoundingClientRect();
        // 点在行的**右半边空白区** —— 以前只有行头里那个小按钮能点
        row.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            clientX: box.right - 20,
            clientY: box.top + box.height / 2,
          }),
        );
        await settle(30);
        const head = rowText(panel()?.querySelector(".detail .head") ?? { textContent: "" });
        const active = rowText(panel()?.querySelector(".mosaic .row.active") ?? { textContent: "" });
        window.__DIAG.push(`r53② 行宽=${Math.round(box.width)} 明细头=[${head}] 高亮=[${active.slice(0, 10)}]`);
        return head.includes("周三") && active.includes("周三");
      },
    ],
    [
      "round53 ③：打开面板默认聚焦**今天**（今天在本周时），行头与明细都标出来",
      async () => {
        seedR52();
        await gotoWeek(0);
        await shutReview();
        await openReview();
        const activeRow = panel()?.querySelector(".mosaic .row.active");
        const active = rowText(activeRow ?? { textContent: "" });
        const head = rowText(panel()?.querySelector(".detail .head") ?? { textContent: "" });
        // round56（你 2026-10-04 验收：「『今天』标去掉吧，挡东西了」）——**马赛克行头不再有徽标**
        // （它会把方块顶开）；今天只以**文字**出现在明细标题里
        const mosaicBadge = !!activeRow?.querySelector(".today");
        window.__DIAG.push(
          `r53③ 高亮=[${active.slice(0, 16)}] 明细头=[${head}] 马赛克徽标=${mosaicBadge}`,
        );
        return !!activeRow && head.includes("今天") && !mosaicBadge && !active.includes("今天");
      },
    ],
    [
      "round53 ④：「未执行」（时间已过、既没做也没标记）看得见 —— 空心 + 虚线，不再是几乎透明的空气",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await openReview();
        await ensureMode("state");
        const tiles = [...(panel()?.querySelectorAll('.mosaic .tile[data-state="unused"]') ?? [])];
        if (tiles.length < 2) return false;
        const bad = [];
        for (const tile of tiles) {
          const cs = getComputedStyle(tile);
          const box = tile.getBoundingClientRect();
          const dashed = cs.borderTopStyle === "dashed";
          const thick = parseFloat(cs.borderTopWidth) >= 1;
          // 发丝线（alpha < 0.5）就是「看不见」的那种 —— 正是用户上周那块报表里的样子
          const faint = /rgba\([^)]*,\s*0\.[0-4]/.test(cs.borderTopColor);
          if (!dashed || !thick || faint || box.width < 12 || box.height < 12) {
            bad.push(`${cs.borderTopStyle}/${cs.borderTopWidth}/${cs.borderTopColor}`);
          }
        }
        window.__DIAG.push(`r53④ 未执行方块 ${tiles.length} 个，不可见的=${bad.join(" ") || "无"}`);
        return bad.length === 0;
      },
    ],
    [
      "round53 ⑤：图例/悬停用正式措辞（按时·超时·提前完成 / 未完成 / 计划中 / 未执行 —— 不再有「没发生 / 还没到」）",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await openReview();
        const legend = rowText(panel()?.querySelector(".legend") ?? { textContent: "" });
        const informal = ["没发生", "还没到"].filter((w) => legend.includes(w));
        const formal = ["按时完成", "未完成", "未执行"].every((w) => legend.includes(w));
        await gotoWeek(3); // 未来周：验「计划中」这个词
        const planned = panel()?.querySelector('.mosaic .tile[data-state="planned"]');
        const title = planned?.getAttribute("title") ?? "";
        const plannedOk = !!planned && title.includes("计划中");
        window.__DIAG.push(
          `r53⑤ 图例=[${legend}] 不该有=[${informal.join(",")}] 计划中悬停=[${title.slice(0, 20)}]`,
        );
        return formal && informal.length === 0 && plannedOk;
      },
    ],
    [
      "round53 ⑥：入口叫「▦ 总览」（面板是一周总览，不只给周日复盘用）",
      async () => {
        const btn = document.querySelector(".review-open");
        const label = (btn?.textContent ?? "").trim();
        const aria = panel()?.getAttribute("aria-label") ?? "";
        window.__DIAG.push(`r53⑥ 按钮=[${label}] 面板名=[${aria}]`);
        return label.includes("总览") && !label.includes("复盘") && aria.includes("总览");
      },
    ],

    // ===== round54（0.12.2）：9.1-BQ —— 设置写失败时，复选框要拨回原位 =====

    [
      "round54 BQ：设置写失败 → 「块开始时提醒」的勾**拨回原位**（旧代码赋的是同一个值 → Svelte 不重跑效果 → 勾留在新位置）",
      async () => {
        await press("Escape"); // 先清掉可能的选中/浮层
        const gear = document.querySelector(".sanity-gear");
        if (!gear) return false;
        gear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const start = settingBox("块开始时提醒"); // round63 起面板分区块，按行文字找（不再用下标）
        if (!start) return false;
        const before = start.checked;
        window.__FAIL_SET_SETTING_ONCE = true; // 让这一次 set_setting 失败
        start.checked = !before;
        start.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(40);
        const after = start.checked;
        gear.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 收起弹层（不影响后面的截图）
        await settle();
        window.__DIAG.push(`r54-BQ 原来=${before} 写失败后 DOM=${after}（期望回到 ${before}）`);
        return after === before;
      },
    ],

    // ===== round54（0.12.2）：9.1-BU —— 拿起中的键位 / Enter 标签 / Ctrl+Z =====

    [
      "round54 BU：**拿起中**也看得见键位栏（移动 / 快移 / 拿起·放下 / 放弃拿起）—— 旧代码被「拿起中：…」那行整个顶掉",
      async () => {
        await press("Escape");
        await backToThisWeek();
        if (!(await selectByClick("b53"))) return false;
        await press("Enter"); // 抓起
        await settle(20);
        const bar = document.querySelector(".key-hint");
        const txt = keyHintText();
        const acts = [...document.querySelectorAll(".key-hint .kh-act")].map((n) =>
          n.textContent.trim(),
        );
        const gesture = gestureHintText();
        window.__DIAG.push(
          `r54-BU 拿起中 bar=${bar ? "在" : "无"} 手势=[${gesture}] 动作=[${acts.join("/")}]`,
        );
        await press("Escape"); // 放弃拿起
        await press("Escape"); // 清选中
        await settle();
        return (
          !!bar &&
          txt.includes("移动") &&
          txt.includes("快移") &&
          txt.includes("拿起/放下") &&
          txt.includes("放弃拿起") &&
          gesture.includes("拿起中") // 手势行也还在（时间读数不能丢）
        );
      },
    ],

    [
      "round54 BU②（round55 反向）：`Enter` = 拿起/放下；键位栏**不再**列 `Ctrl+Z`（撤销只在 `↶` 的悬停提示里）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        if (!(await selectByClick("b53"))) return false;
        await settle(20);
        const txt = keyHintText();
        const keys = [...document.querySelectorAll(".key-hint .kh-key")].map((n) =>
          n.textContent.trim(),
        );
        const undoBtn = [...document.querySelectorAll("button")].find((b) =>
          (b.getAttribute("title") ?? "").startsWith("撤销"),
        );
        const undoTitle = undoBtn?.getAttribute("title") ?? "";
        window.__DIAG.push(`r54-BU② 键=[${keys.join("/")}] 文本=[${txt}] 撤销按钮=${undoTitle}`);
        await press("Escape");
        await settle();
        // round55（验收回修）：你验收时说「Ctrl+Z 不用补，悬停回退键就能显示」→ 断言**反过来**：
        // 条里**没有**「撤销」/`Ctrl+Z`，而 `↶` 的 title 里写着「撤销（Ctrl+Z）」
        return (
          txt.includes("拿起/放下") &&
          !txt.includes("撤销") &&
          !keys.includes("Ctrl+Z") &&
          undoTitle.includes("撤销") &&
          undoTitle.includes("Ctrl+Z")
        );
      },
    ],

    [
      "round54 BU③（round55 改；round61.1 改为 4 项）：键位栏**不被截断**且**4 项都在**（715px 也要过）—— 不许用「少放几项」换「不溢出」，也不许藏起来",
      async () => {
        await press("Escape");
        await backToThisWeek();
        if (!(await selectByClick("b53"))) return false;
        await settle(20);
        const bar = document.querySelector(".key-hint");
        const over = bar ? bar.scrollWidth - bar.clientWidth : -1;
        const items = [...document.querySelectorAll(".key-hint .kh-key, .key-hint .kh-act")];
        const acts = [...document.querySelectorAll(".key-hint .kh-act")].map((n) =>
          n.textContent.trim(),
        );
        const barRect = bar?.getBoundingClientRect();
        const cs = bar ? getComputedStyle(bar) : null;
        // ① 真的看得见（不是 display:none / 尺寸被压成 0 —— 那些情况下 over 也是 0，旧判据会放过 ✗）
        const visible =
          !!barRect &&
          barRect.width > 0 &&
          barRect.height > 0 &&
          cs?.display !== "none" &&
          cs?.visibility !== "hidden";
        // ② 每一项都**落在条子的盒子里**且有面积（换行允许，被裁掉/藏起来不允许）
        const inside =
          !!barRect &&
          items.every((n) => {
            const r = n.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.height > 0 &&
              r.top >= barRect.top - 1 &&
              r.bottom <= barRect.bottom + 1 &&
              r.left >= barRect.left - 1 &&
              r.right <= barRect.right + 1
            );
          });
        // ③ 条子本身在视口里（没被挤到屏幕外）
        const inViewport = !!barRect && barRect.right <= window.innerWidth + 1 && barRect.left >= -1;
        window.__DIAG.push(
          `r54-BU③ 窗宽=${window.innerWidth} scroll=${bar?.scrollWidth} client=${bar?.clientWidth} 溢出=${over} 项数=${acts.length} 末项=[${acts[acts.length - 1]}] 高=${bar?.clientHeight} 看得见=${visible} 都在盒里=${inside} 在视口=${inViewport}`,
        );
        await press("Escape");
        await settle();
        // 不截断 **且** 四项都在 **且 真的看得见**（不许用「少放几项」换「不溢出」，也不许「藏起来」）
        return (
          over >= 0 &&
          over <= 1 &&
          acts.length === 4 &&
          acts[3] === "取消选中" &&
          items.length >= 4 &&
          visible &&
          inside &&
          inViewport
        );
      },
    ],

    // ===== round54（0.12.2）：9.2「上周对比」重做 —— 同一把尺 =====

    [
      "round54 ⑫：对比基线**显式**（「这一周 vs 上周」）+ 摘要行把两个值 + 差值一起摆出来",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await openReview();
        await ensureCompare(true);
        await settle(40);
        const label = rowText(panel()?.querySelector(".compare-label") ?? { textContent: "" });
        const baseName = rowText(panel()?.querySelector(".baseline-name") ?? { textContent: "" });
        const summary = panel()?.querySelector(".summary");
        const lines = [...(summary?.querySelectorAll(".line") ?? [])].map((n) => rowText(n));
        const deltaEl = summary?.querySelector(".delta");
        const deltaTxt = rowText(deltaEl ?? { textContent: "" });
        // 期望值：从假库现算（不写死数字）—— 本周 W-1 / 上周 W-2
        const sumOf = (offset) =>
          Array.from({ length: 7 }, (_, i) => dayUnionMinutes(FIX, i, weekStartOf(offset))).reduce(
            (a, b) => a + b,
            0,
          );
        const wantDelta = sumOf(-1) - sumOf(-2);
        const gotDelta = Number(deltaEl?.getAttribute("data-delta-minutes"));
        const dirOk =
          (wantDelta > 0 && deltaTxt.startsWith("▲")) ||
          (wantDelta < 0 && deltaTxt.startsWith("▼")) ||
          (wantDelta === 0 && deltaTxt.startsWith("＝"));
        const colorOk = ["up", "down", "same"].some((c) => deltaEl?.classList.contains(c));
        const joined = lines.join(" ｜ ");
        // 结局计数：**两周各自一组**，数字**独立复算**（从假库现算每个块的结局），
        // 且四档都要写对。旧判据只看「出现过这两个词」→ 删掉上周那行 / 写错数字都能过 ✗
        // （round54 交付后的只读复核当场抓到，见验收文档 §9）
        const countsOf = (offset) => {
          const list = weekBlocksOf(offset).map(stateOfBlock);
          const n = (s) => list.filter((x) => x === s).length;
          return `完成 ${n("done") + n("done_overtime") + n("done_short")} · 未完成 ${n("missed")} · 未执行 ${n("unused")} · 计划中 ${n("planned")}`;
        };
        const wantCurCounts = countsOf(-1);
        const wantPrevCounts = countsOf(-2);
        const endLine = lines.find((l) => l.includes("完成")) ?? "";
        const countsOk =
          endLine.includes(wantCurCounts) && endLine.includes(`上周 ${wantPrevCounts}`);
        // 摘要第一行里**摆出来的那两个值**（本周/上周的占用时长）也要读：
        // 只验 `data-delta-minutes` 的话，把两个值写反/写错照样能过（第二跑复核指出的残留缝隙）
        const minsOf = (offset) =>
          Array.from({ length: 7 }, (_, i) => dayUnionMinutes(FIX, i, weekStartOf(offset))).reduce(
            (a, b) => a + b,
            0,
          );
        const wantCurMin = minsOf(-1);
        const wantPrevMin = minsOf(-2);
        const sumLine = lines[0] ?? "";
        const valuesOk =
          sumLine.includes(`这一周 ${durText(wantCurMin)}`) &&
          sumLine.includes(`上周 ${durText(wantPrevMin)}`);
        // 差值徽标的**文字**也要与两个值之差一致（旧的只看箭头/颜色/属性）
        const dMin = wantCurMin - wantPrevMin;
        const wantDeltaTxt = dMin > 0 ? `▲${compactDur(dMin)}` : dMin < 0 ? `▼${compactDur(dMin)}` : "＝ 0";
        const deltaTxtOk = deltaTxt === wantDeltaTxt;
        await ensureCompare(false);
        await shutReview();
        window.__DIAG.push(
          `r54⑫ 标签=[${label}] 摘要=[${joined}] 差值=${gotDelta}/${wantDelta} 文案=${deltaTxt}/${wantDeltaTxt} 两个值=${valuesOk} 方向=${dirOk} 颜色=${colorOk} 计数行=[${endLine}] 期望本周=[${wantCurCounts}] 期望上周=[${wantPrevCounts}]`,
        );
        return (
          label.includes("对比") &&
          baseName === "上周" &&
          !!summary &&
          gotDelta === wantDelta &&
          dirOk &&
          colorOk &&
          countsOk &&
          valuesOk &&
          deltaTxtOk
        );
      },
    ],

    [
      "round54 ⑬：占用图**同一把尺**（两周同一个预算基准）· 上周那一列来自**请求的那一周**（不是拿本周充数）· 每天一个三重冗余差值徽标",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await openReview();
        await ensureCompare(true);
        await settle(40);
        const cur = [...(panel()?.querySelectorAll(".curve .bar") ?? [])].map((n) => ({
          m: Number(n.getAttribute("data-minutes")),
          pct: parseFloat(n.style.getPropertyValue("--pct")),
        }));
        const prev = [...(panel()?.querySelectorAll(".curve .pbar") ?? [])].map((n) => ({
          m: Number(n.getAttribute("data-prev-minutes")),
          pct: parseFloat(n.style.getPropertyValue("--pct")),
        }));
        // 上周的分钟必须等于**W-2** 自己现算的并集分钟（拿错周的话这里会等于本周的数）
        const wantPrev = Array.from({ length: 7 }, (_, i) => dayUnionMinutes(FIX, i, weekStartOf(-2)));
        const weekOk = prev.length === 7 && prev.every((p, i) => p.m === wantPrev[i]);
        const moved = wantPrev.some((m, i) => m !== cur[i].m); // 两周真的不一样（不然这条断言无意义）
        // round69.1（#11）：刻度不再固定为预算 —— 而是 **max(预算, 两周里最高的那一天)**；
        // 预算虚线跟着刻度画（不再是「永远贴顶」——那会让两边都超预算的日子看不出差）。
        const sumLineTxt = rowText(
          panel()?.querySelector(".summary .line") ?? { textContent: "" },
        );
        const bm = sumLineTxt.match(/预算 (\d+) 小时(?: (\d+) 分)?/);
        const budget = bm ? Number(bm[1]) * 60 + Number(bm[2] ?? 0) : 0;
        const wantScale = Math.max(1, budget, ...cur.map((c) => c.m), ...prev.map((p) => p.m));
        const expectPct = (m) => Math.round((m / wantScale) * 100);
        const scaleOk =
          budget > 0 &&
          cur.every((c) => Math.abs(c.pct - expectPct(c.m)) <= 1) &&
          prev.every((p) => Math.abs(p.pct - expectPct(p.m)) <= 1);
        // 预算线画在 `budget / 刻度` 的相对高度上（从柱底量）
        const plotRect = panel()?.querySelector(".curve .plot")?.getBoundingClientRect();
        const lineRect = panel()?.querySelector(".curve .budget-line")?.getBoundingClientRect();
        const wantLineTop =
          plotRect && plotRect.bottom - (budget / wantScale) * plotRect.height;
        const budgetLineOk =
          !!plotRect &&
          !!lineRect &&
          !!wantLineTop &&
          Math.abs(lineRect.top - wantLineTop) <= 3 &&
          lineRect.width > 0;
        // 差值徽标：箭头 + 颜色类 + data 属性三者一致
        const cells = [...(panel()?.querySelectorAll(".curve .under .cell") ?? [])];
        const badges = cells.map((c) => {
          const d = c.querySelector(".delta");
          return {
            n: Number(d?.getAttribute("data-day-delta")),
            txt: rowText(d ?? { textContent: "" }),
            up: !!d?.classList.contains("up"),
            down: !!d?.classList.contains("down"),
            same: !!d?.classList.contains("same"),
          };
        });
        const badgeOk =
          badges.every(
            (b) =>
              (b.n > 0 && b.txt.startsWith("▲") && b.up) ||
              (b.n < 0 && b.txt.startsWith("▼") && b.down) ||
              (b.n === 0 && b.txt.startsWith("＝") && b.same),
          ) &&
          // 数值维度也要对账（第二跑复核：旧写法只验「箭头/颜色/文字自洽」→ 幅值错、符号对也能过）
          badges.every((b, i) => b.n === cur[i].m - prev[i].m) &&
          badges.every((b, i) => {
            const d = cur[i].m - prev[i].m;
            const want = d > 0 ? `▲${compactDur(d)}` : d < 0 ? `▼${compactDur(d)}` : "＝ 0";
            return b.txt === want;
          });
        // 柱子**渲染出来的高度**也要量（只量内联 `--pct` 的话，CSS 里换个比例照样能过）
        const plotEl = panel()?.querySelector(".curve .plot");
        const plotH = plotEl?.clientHeight ?? 0;
        const renderOk =
          plotH > 10 &&
          [...(plotEl?.querySelectorAll(".bar, .pbar") ?? [])].every((n) => {
            const p = parseFloat(n.style.getPropertyValue("--pct"));
            const h = n.getBoundingClientRect().height;
            const want = (plotH * p) / 100;
            return want <= 3 ? h <= 4 : Math.abs(h - want) <= Math.max(1.5, want * 0.05);
          });
        await ensureCompare(false);
        await shutReview();
        window.__DIAG.push(
          `r54⑬ 本周柱=${cur.map((c) => c.m).join(",")} 上周柱=${prev.map((p) => p.m).join(",")} 本周期望=${Array.from(
            { length: 7 },
            (_, i) => dayUnionMinutes(FIX, i, weekStartOf(-1)),
          ).join(",")} 拿对周=${weekOk} 两周不同=${moved} 预算=${budget}分 同刻度=${scaleOk} 预算线=${budgetLineOk} 渲染高=${renderOk} 徽标=${badgeOk ? "✓" : JSON.stringify(badges)}`,
        );
        return (
          weekOk && moved && scaleOk && budgetLineOk && renderOk && badgeOk && badges.length === 7
        );
      },
    ],

    [
      "round54 ⑭（round55 扩）：事实图成对小柱 + **两周共用同一刻度** + 标签两个数（**▲ / ▼ / ＝ 三支都要覆盖**）",
      async () => {
        seedR52();
        await openReview();
        // 期望值：按假事实表独立复算（≥2 次才算「挪过」，与后端口径一致）
        const dayIdx = (b, offset) =>
          Math.round((localDayStart(Math.max(b.start_at, weekStartOf(offset))) - weekStartOf(offset)) / 86400);
        const want = (offset, kind) => {
          const out = Array.from({ length: 7 }, () => 0);
          for (const b of weekBlocksOf(offset)) {
            const i = dayIdx(b, offset);
            if (i < 0 || i > 6) continue;
            if (kind === "rearranged" ? (FIX.facts[b.id]?.rearranged ?? 0) >= 2 : FIX.facts[b.id]?.skipped) out[i] += 1;
          }
          return out;
        };
        /** 一周视图下的共同刻度 = 本周与上周合并后的最大值（与产品同一口径） */
        const maxFactOf = (offset) =>
          Math.max(
            ...[
              ...want(offset, "rearranged"),
              ...want(offset - 1, "rearranged"),
              ...want(offset, "skipped"),
              ...want(offset - 1, "skipped"),
            ],
            1,
          );
        const readInfo = () =>
          [...(panel()?.querySelectorAll(".facts .fact") ?? [])].map((f) => {
            const r = f.querySelector(".row");
            const dim = [...(r?.querySelectorAll(".pbar") ?? [])];
            const bar = [...(r?.querySelectorAll(".bar") ?? [])];
            return {
              kind: r?.getAttribute("data-kind"),
              prevVals: dim.map((n) => Number(n.getAttribute("data-prev-count"))),
              curVals: bar.map((n) => Number(n.getAttribute("data-count"))),
              prevPct: dim.map((n) => parseFloat(n.style.getPropertyValue("--pct"))),
              curPct: bar.map((n) => parseFloat(n.style.getPropertyValue("--pct"))),
              tag: rowText(f.querySelector(".cap") ?? { textContent: "" }),
            };
          });
        // **三支都要跑到**：W-1（本周有、上周没有 → ▲）、W-2（本周没有、上周有 → ▼）、W-4（两周都空 → ＝）
        // —— 交付前复核抓到：只跑 W-1 时 ▼ / ＝ 两支根本没被验过（把 ▼ 也印成 ▲ 照样绿）
        const seen = [];
        let ok = true;
        for (const offset of [-1, -2, -4]) {
          await gotoWeek(offset);
          await ensureCompare(true);
          await settle(40);
          const info = readInfo();
          const mf = maxFactOf(offset);
          const expPct = (v) => Math.round((v / mf) * 100);
          const pairsOk =
            info.length === 2 && info.every((r) => r.curVals.length === 7 && r.prevVals.length === 7);
          const dataOk =
            pairsOk &&
            info.every((r) => {
              const w1 = want(offset, r.kind);
              const w2 = want(offset - 1, r.kind);
              return r.curVals.every((v, i) => v === w1[i]) && r.prevVals.every((v, i) => v === w2[i]);
            });
          const scaleOk =
            pairsOk &&
            info.every(
              (r) =>
                r.curPct.every((p, i) => Math.abs(p - expPct(r.curVals[i])) <= 1) &&
                r.prevPct.every((p, i) => Math.abs(p - expPct(r.prevVals[i])) <= 1),
            );
          const tagOk =
            pairsOk &&
            info.every((r) => {
              const cur = want(offset, r.kind).reduce((a, b) => a + b, 0);
              const prev = want(offset - 1, r.kind).reduce((a, b) => a + b, 0);
              const d = cur - prev;
              // round55（验收回修）：事实的差值是**次数**（不是分钟）—— 旧版印 `▲1m`（把次数当分钟了），已改
              const dl = d > 0 ? `▲${d}` : d < 0 ? `▼${Math.abs(d)}` : "＝ 0";
              seen.push(dl[0]);
              // **整串相等**（旧的 `includes(String(cur))` → `6` 能匹配 `16`）；cur 与差值之间**有一个空格**
              const wantTag = `${r.kind === "rearranged" ? "挪过" : "没做完"} ${cur} ${dl} / 上周 ${prev}`;
              return r.tag === wantTag;
            });
          window.__DIAG.push(
            `r54⑭ wk${offset} maxFact=${mf} 标签=[${info.map((r) => r.tag).join(" ; ")}] 成对=${pairsOk} 值对=${dataOk} 同刻度=${scaleOk} 标签准=${tagOk}`,
          );
          if (!(pairsOk && dataOk && scaleOk && tagOk)) ok = false;
        }
        const branches = new Set(seen);
        const branchOk = branches.has("▲") && branches.has("▼") && branches.has("＝");
        await ensureCompare(false);
        await shutReview();
        return ok && branchOk;
      },
    ],

    // ===== round55（0.12.3）：验收回修 =====

    [
      "round55 ①：事实图与占用图的**天列对齐** —— **两种状态都要**（单周 44px / 对比中 138px）；否则「哪个条是哪天」只能猜",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await openReview();
        const rects = (nodes) =>
          [...nodes].map((n) => {
            const r = n.getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.width)];
          });
        /** 量一次当前状态下两张图的天列：同一 x、同一宽（±1 / ±2px） */
        const measure = () => {
          const charts = panel()?.querySelector(".charts");
          const contentLeft = Math.round(charts?.getBoundingClientRect().left ?? -1);
          const cols = rects(panel()?.querySelectorAll(".curve .plot .col") ?? []);
          const factRows = [...(panel()?.querySelectorAll(".facts .row") ?? [])].map((r) =>
            rects(r.querySelectorAll(".cell")),
          );
          const sameCount = cols.length === 7 && factRows.length === 2 && factRows.every((r) => r.length === 7);
          const aligned =
            sameCount &&
            factRows.every((r) =>
              r.every((c, i) => Math.abs(c[0] - cols[i][0]) <= 1 && Math.abs(c[1] - cols[i][1]) <= 2),
            );
          // 实质判据只有一条：**三张图共用同一条天列网格**（逐列同 x / 同宽）。
          // （曾经还断言过「第一列必须贴容器左边缘」——已撤：那是把一次具体意见升格成了通则，
          //   哪天正当的留白/左轴刻度就会撞上它。对齐这件事本身仍然钉着。）
          return { cols, factRows, contentLeft, aligned: sameCount && aligned };
        };
        // round56：三张图都占满全宽（没有“左栏”这个变量了）—— 只量列与格子的 x / 宽是否一致
        // —— 状态一：单周（默认看到的那个）——
        await ensureCompare(false);
        await settle(40);
        const single = measure();
        const singleDash = panel()?.querySelectorAll(".sub .none").length ?? -1;
        // —— 状态二：对比中（勾选真的生效、类真的在、栏宽真的是 138px）——
        if (!(await ensureCompare(true))) return false;
        await settle(40);
        const boxNow =
          Number(panel()?.querySelector("[data-baseline]")?.getAttribute("data-baseline") ?? 0) > 0;
        const comparingClass = !!panel()?.querySelector(".charts.comparing");
        const cmp = measure();
        window.__DIAG.push(
          `r55① 单周[列=${JSON.stringify(single.cols)} 事实=${JSON.stringify(single.factRows[0])} 对齐=${single.aligned} 「—」=${singleDash}] 对比[列=${JSON.stringify(cmp.cols)} 事实=${JSON.stringify(cmp.factRows[0])} 对齐=${cmp.aligned} 勾=${boxNow} 类=${comparingClass}]`,
        );
        await ensureCompare(false);
        await shutReview();
        // 单周态：对齐 + 44px + **不能有「—」**（那是对比态才有的占位 —— 交付前复核抓到过）
        // 对比态：对齐 + 勾选/类/138px 都真的生效（否则“两边都没偏”会成为假绿）
        return (
          single.aligned &&
          singleDash === 0 &&
          cmp.aligned &&
          boxNow === true &&
          comparingClass
        );
      },
    ],
    // ===== round58（0.13.1）：周报并进总览 —— 常驻结局行 + 完成率 + 序列 + 往期 + 到点落点 =====
    [
      "round58 ①：总览顶部**常驻**一行「结局 + 完成率」（不勾「本周 vs 上周」也有；分母 = 已到点）",
      async () => {
        seedR52();
        await gotoWeek(-1); // 富数据周（五种已过结局 ≥3）
        await shutReview();
        if (!(await openReview())) return false;
        await settle(40);
        // 独立复算（不调 fixture 那一份）—— 与 round52 的断言同一手法
        const states = weekBlocksOf(-1).map(stateOfBlock);
        const done = states.filter((s) => s.startsWith("done")).length;
        const missed = states.filter((s) => s === "missed").length;
        const unused = states.filter((s) => s === "unused").length;
        const planned = states.filter((s) => s === "planned").length;
        const due = done + missed + unused;
        const wantCounts = `完成 ${done} · 未完成 ${missed} · 未执行 ${unused} · 计划中 ${planned}`;
        const wantRate = due === 0 ? "—" : `${done}/${due} · ${Math.round((done / due) * 100)}%`;
        const counts = panelCounts();
        const rate = panelRate();
        // 不勾对比：这一行也得在，且**不许**把「上周」混进来（对比态有它自己的那一段）
        const summaryText = rowText(panel()?.querySelector(".summary") ?? { textContent: "" });
        const noCompare = !summaryText.includes("上周");
        const node = panel();
        const noOverflow = node.scrollWidth <= node.clientWidth + 1;
        window.__DIAG.push(
          `r58① 计数=[${counts}]（望 [${wantCounts}]）率=[${rate}]（望 ${wantRate}）不勾对比=${noCompare} 溢出=${!noOverflow}`,
        );
        await shutReview();
        return due > 0 && counts === wantCounts && rate.includes(wantRate) && noCompare && noOverflow;
      },
    ],
    [
      "round58 ②：完成率的分母是**已到点**（还没到的周 → 分母 0 → 显示「—」，不编 100%）",
      async () => {
        seedR52();
        await gotoWeek(8); // W+8：两块都还没到
        await shutReview();
        if (!(await openReview())) return false;
        await settle(40);
        const counts = panelCounts();
        const rate = panelRate();
        const planned = panel()?.querySelectorAll(".mosaic .tile[data-state=\"planned\"]").length ?? 0;
        window.__DIAG.push(`r58② 计数=[${counts}] 率=[${rate}] 还没到的方块=${planned}`);
        await shutReview();
        return (
          counts === "完成 0 · 未完成 0 · 未执行 0 · 计划中 2" && rate.includes("—") && planned === 2
        );
      },
    ],
    [
      "round58 ③：往期 = **最近 12 周（锚点是今天那一周，不是正在看的那一周）**；点更早的周 → 总览切过去（高亮跟着走）",
      async () => {
        seedR52();
        await gotoWeek(-4); // 故意站在四周前：往期仍要从**今天**那一周往回数
        await shutReview();
        if (!(await openReview())) return false;
        await settle(40);
        const chips = panel()?.querySelectorAll(".history .chip") ?? [];
        const todayChip = pastChip(at(0, 0, 0)); // 今天那一周（不是正在看的那一周）
        const viewedChip = pastChip(at(-28, 0, 0)); // 正在看的那一周（W-4）
        const visible = [...chips].every((c) => c.getBoundingClientRect().width > 20);
        const historyLast = !!panel()?.querySelector(".body")?.lastElementChild?.classList.contains("history");
        const activeBefore = !!viewedChip?.classList.contains("active");
        const target = at(-35, 0, 0); // 五周前（周一对周一；在 12 周窗口里）
        const old = pastChip(target);
        old?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const range = () => rowText(panel()?.querySelector(".range") ?? { textContent: "" });
        for (let i = 0; i < 30 && range() !== rangeOf(target); i++) await frames(4);
        const finalRange = range();
        const fetched = mosaicCalls().slice(-1)[0];
        const activeAfter = !!pastChip(target)?.classList.contains("active");
        const panelStill = !!panel();
        window.__DIAG.push(
          `r58③ 共=${chips.length} 今天chip=${!!todayChip} 看的那周chip=${!!viewedChip} 看的那周高亮=${activeBefore} 可见=${visible} 往期在末尾=${historyLast} 区间=[${finalRange}]（望 ${rangeOf(target)}）拉周=${fetched} 目标高亮=${activeAfter} 面板还在=${panelStill}`,
        );
        await shutReview();
        return (
          chips.length === 12 &&
          !!todayChip &&
          !!viewedChip &&
          activeBefore &&
          visible &&
          historyLast &&
          panelStill &&
          finalRange === rangeOf(target) &&
          fetched === target &&
          activeAfter
        );
      },
    ],
    [
      "round58 ④：序列完成情况真的按**这一周的成员**算（W0 的「验证链」= b7/b8），不是只画个容器",
      async () => {
        seedR52();
        await gotoWeek(0);
        await shutReview();
        if (!(await openReview())) return false;
        await settle(40);
        const week = weekBlocksOf(0);
        const stateOf = (id) => {
          const b = week.find((x) => x.id === id);
          return b ? stateOfBlock(b) : null;
        };
        // 独立复算：所有「这一周里有成员的」序列各一行（跨周成员不算这一周）
        const want = FIX.sequences
          .map((s) => {
            const members = s.members.map((m) => m.block_id).filter((id) => !!stateOf(id));
            if (members.length === 0) return null;
            const done = members.filter((id) => (stateOf(id) ?? "").startsWith("done")).length;
            return `${s.name} ${done}/${members.length}`;
          })
          .filter(Boolean);
        const rows = [...(panel()?.querySelectorAll(".chip-seq") ?? [])].map((n) => rowText(n));
        window.__DIAG.push(
          `r58④ 行=[${rows.join(" | ")}] 期望=[${want.join(" | ")}] 本周块=${week.length}`,
        );
        await shutReview();
        return want.length > 0 && rows.length === want.length && want.every((w) => rows.includes(w));
      },
    ],
    [
      "round58 ⑤：到点三档 —— `直接打开`：回到应用时**总览**自己打开（且不出轻提示）；`什么都不做`：什么也不发生",
      async () => {
        seedR52();
        await gotoWeek(0);
        await shutReview();
        if (!(await setRemindViaGear("open", "sun", "20:00"))) return false;
        sanityState.nudgedWeek = null;
        window.__FAKE_NOW = at(6, 21, 0); // 本周日 21:00（默认 sun 20:00 的窗口内）
        await checkNudgeViaFocus(); // 「回到应用」= window focus
        const opened = !!panel();
        const noCard = !document.querySelector(".weekcard");
        const hint = !!document.querySelector(".nudge");
        const range = rowText(panel()?.querySelector(".range") ?? { textContent: "" });
        await shutReview();
        // 换「什么都不做」档：连水位线都不该动（take 都不调）
        if (!(await setRemindViaGear("off", "sun", "20:00"))) return false;
        sanityState.nudgedWeek = null;
        await checkNudgeViaFocus();
        const nothing = !panel() && !document.querySelector(".nudge");
        const untouched = sanityState.nudgedWeek === null;
        window.__FAKE_NOW = null;
        await setRemindViaGear("hint", "sun", "20:00"); // 还原默认
        window.__DIAG.push(
          `r58⑤ 直接打开：总览=${opened} 无卡片=${noCard} 提示=${hint} 区间=[${range}]（望 ${rangeOf(at(0, 0, 0))}）；什么都不做：静悄悄=${nothing} 水位线未动=${untouched}`,
        );
        return opened && noCard && !hint && range === rangeOf(at(0, 0, 0)) && nothing && untouched;
      },
    ],
    [
      "round58 ⑥：常驻行是**实时**的（不是快照）—— 总览**开着**的时候标一个块，计数就跟着变",
      async () => {
        seedR52();
        await gotoWeek(0);
        await shutReview();
        // 先选一个本周还没标记的块（总览一开就挡住时间轴，之后靠键盘操作）
        const pick = FIX.blocks.find(
          (b) =>
            b.id !== "bphantom" &&
            b.status === "planned" &&
            b.start_at >= at(0, 0, 0) &&
            b.end_at <= at(7, 0, 0) &&
            el(b.id),
        );
        if (!pick) return false;
        if (!(await selectByClick(pick.id))) return false;
        // 从**提醒**里开总览（不走 `.review-open` 那个入口）—— 这样「开着面板时数据变了」靠的是面板
        // 自己的重拉（预览的真实路径），不是开面板那一下顺手拿的新数据
        if (!(await setRemindViaGear("hint", "sun", "20:00"))) return false;
        sanityState.nudgedWeek = null;
        window.__FAKE_NOW = at(6, 21, 0); // 本周日 21:00（sun 20:00 的窗口内）
        await dismissOverloadBar(); // round77（3.1b）：同屏最多一条（橙 > 绿）—— 绿条要出现
        await checkNudgeViaFocus();
        document.querySelector(".nudge .open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        if (!panel()) return false;
        const before = panelCounts();
        const callsBefore = mosaicCalls().length;
        // 总览开着时按 Space = 标记完成（键盘事件到 window）。round78（栈-03）：焦点陷阱会把焦点
        // 放进面板的第一个可聚焦项（可能正是「比上周」那个 checkbox）→ 全局处理器的「输入框守卫」
        // 会放行 Space。真实用户这时是把焦点留在块上按的 → 测试现场照真路径补一次 focus。
        el(pick.id)?.focus({ preventScroll: true });
        await press("Space");
        const marked = blk(pick.id)?.status === "done";
        const num = (text, label) => Number((text.match(new RegExp(label + " (\\d+)")) || [])[1] ?? -1);
        // 等面板**自己重拉**：信号 = 又打了一次 get_week_mosaic（当前周），且常驻行跟着变
        let after = panelCounts();
        for (let i = 0; i < 40 && num(after, "完成") === num(before, "完成"); i++) {
          await frames(4);
          after = panelCounts();
        }
        const reparsed =
          mosaicCalls().length > callsBefore && mosaicCalls().slice(-1)[0] === at(0, 0, 0);
        const grew = num(after, "完成") === num(before, "完成") + 1;
        window.__DIAG.push(
          `r58⑥ 块=${pick.id} 标了=${marked} 拉周数 ${callsBefore}→${mosaicCalls().length} 前=[${before}] 后=[${after}] 完成+1=${grew} 重拉=${reparsed}`,
        );
        window.__FAKE_NOW = null;
        sanityState.nudgedWeek = null;
        await shutReview();
        await setRemindViaGear("hint", "sun", "20:00"); // 还原默认
        return marked && grew && reparsed;
      },
    ],
    // ===== round60（0.14.0 / 10.1）：数据统计页 —— 全时段累计 + 近 12 周 =====
    [
      "round60 ①：`▤ 统计` 打开面板；已知假数据 → 完成/未完成/完成率精确值（分母看得见）",
      async () => {
        window.__SEED_STATS();
        await shutStats();
        if (!(await openStatsPanel())) return false;
        await settle(20);
        const complete = statsRow("标为完成");
        const skip = statsRow("标为未完成");
        const rate = statsRow("完成率");
        const title = rowText(statsPanel()?.querySelector(".title") ?? { textContent: "" });
        window.__DIAG.push(`r60① 标题=[${title}] 完成=[${complete}] 未完成=[${skip}] 率=[${rate}]`);
        await shutStats();
        return title === "统计" && complete === "5 次" && skip === "3 次" && rate === "5/8 · 63%";
      },
    ],
    [
      "round60 ②：拖动与拉伸**分开算**（不是笼统的「移动 N」）",
      async () => {
        if (!(await openStatsPanel())) return false;
        await settle(20);
        const moved = statsRow("移动位置");
        const stretched = statsRow("调整时长");
        window.__DIAG.push(`r60② 移动=[${moved}] 拉伸=[${stretched}]`);
        await shutStats();
        return moved === "4 次" && stretched === "3 次";
      },
    ],
    [
      "round60 ③：带 cascade 的顺延**不混进**移动/漂流/接进序列（三类各归各的）",
      async () => {
        if (!(await openStatsPanel())) return false;
        await settle(20);
        const postponed = statsRow("漂流");
        const cascaded = statsRow("自动顺延");
        const linked = statsRow("接进序列");
        const rows = statsPanel()?.querySelectorAll(".row").length ?? 0; // 面板真的渲染出表格了吗
        window.__DIAG.push(`r60③ 行数=${rows} 漂流=[${postponed}] 顺延=[${cascaded}] 接进=[${linked}]`);
        await shutStats();
        // round82（统-03…07）：行数 16 → 23（+按时率 · 平均单块 · 当前/最长连续 · 分类 3 栏）
        return rows === 23 && postponed === "3 次" && cascaded === "3 次" && linked === "2 次";
      },
    ],
    [
      "round60 ④：新建块的子计数；`◇` 与页脚说明已按验收反馈去掉（round61）",
      async () => {
        if (!(await openStatsPanel())) return false;
        await settle(20);
        const created = statsRow("新建块");
        const foot = rowText(statsPanel()?.querySelector(".foot") ?? { textContent: "" });
        // round61（你 2026-10-04 验收拍板「去掉 ◇ 与页脚说明」）：面板里不该再有任何 .fresh / ◇
        const fresh = statsPanel()?.querySelectorAll(".fresh").length ?? 0;
        const anyMark = (statsPanel()?.textContent ?? "").includes("◇");
        window.__DIAG.push(`r60④ 新建=[${created}] .fresh=${fresh} 有◇=${anyMark} 页脚=[${foot}]`);
        await shutStats();
        return (
          created === "6 次（含临时 2）" &&
          fresh === 0 &&
          !anyMark &&
          !foot.includes("◇") &&
          foot.includes("Ctrl+Z")
        );
      },
    ],
    [
      "round60 ⑤：口径表其余行 + 近 12 周表也照实画（删除 / 取出 / 时长 / 融合 / 记录 / 周表）",
      async () => {
        if (!(await openStatsPanel())) return false;
        await settle(20);
        const deleted = statsRow("删除块");
        const unlinked = statsRow("从序列取出");
        const merged = statsRow("融合");
        const duration = statsRow("完成时长");
        const first = statsRow("记录始于");
        const days = statsRow("用过的天数");
        const total = statsRow("事件总数");
        const d = new Date(at(-14, 9, 0) * 1000);
        // round81：默认 `date_format=system`（zh-CN）→ `2026/9/21`（月日不补零）
        const wantFirst = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
        const weeks = [...(statsPanel()?.querySelectorAll(".weeks tbody tr") ?? [])].map((tr) =>
          [...tr.querySelectorAll("td")].map((td) => rowText(td)),
        );
        // 新 → 旧：本周 3/1/1 · 上周 1/1/1 · 上上周 1/1/1（与 seed 的那 35 条一致）
        const wantWeeks = [
          ["3", "1", "1"],
          ["1", "1", "1"],
          ["1", "1", "1"],
        ];
        const weeksOk =
          weeks.length === 3 &&
          weeks.every(
            (row, i) =>
              row[1] === wantWeeks[i][0] &&
              row[2] === wantWeeks[i][1] &&
              row[3] === wantWeeks[i][2],
          );
        window.__DIAG.push(
          `r60⑤ 删除=[${deleted}] 取出=[${unlinked}] 融合=[${merged}] 时长=[${duration}] 起始=[${first}] 天数=[${days}] 总数=[${total}] 周表=${weeks.length}行 列对=${weeksOk}`,
        );
        await shutStats();
        return (
          deleted === "3 块" &&
          unlinked === "1 次" &&
          merged === "2 块" &&
          duration === "2 小时 35 分（按计划时段累加 · 4/5 次有记录）" &&
          first === wantFirst &&
          days === "10 天" &&
          total === "35 条" &&
          weeksOk
        );
      },
    ],
    // ===== round82（3.1c₂ · Step 6）：统计补齐 —— 新指标 + 分类分布（统-03…07）=====
    // 位置就在 round60 ①-⑤ 后面：此刻事件集**只有那 35 条种子**（round60 ⑥ 会标块、round79 ⑤ 会写
    // 重置线；再往后数字就不确定了）→ 期望值钉得死。`--only round82` 下本舱自己种子，同样成立。
    [
      "round82 ⑩：统计补齐 —— 趋势 14 天 / 按时率 3÷4 / 平均 39 分 / 连续 3 天 / 分类分布（统-03…07）",
      async () => {
        await press("Escape");
        await settle(30);
        window.__SEED_STATS();
        // 固定虚拟时钟 = 本周四 12:00：种子（周一/二/三、上周二）落位确定 ——
        // 14 天窗口与「当前连续」不随跑动那天是星期几漂（周末跑与周一跑结果不同 = 假红温床）
        const realNow = window.__FAKE_NOW ?? null;
        window.__FAKE_NOW = at(3, 12, 0);
        window.__RESTORE = window.__RESTORE || [];
        window.__RESTORE.push(async () => {
          window.__FAKE_NOW = realNow;
        });
        await shutStats();
        if (!(await openStatsPanel())) return false;
        await settle(30);
        const panel = statsPanel();
        const onTime = statsRow("按时率");
        const avg = statsRow("平均单块");
        const streakNow = statsRow("当前连续");
        const streakBest = statsRow("最长连续");
        const work = statsRow("工作");
        const study = statsRow("学习");
        const untagged = statsRow("早期数据（无分类）");
        const bars = [...(panel?.querySelectorAll(".trend .tbar") ?? [])];
        const nonzero = bars.filter((b) => b.querySelector("i")).length;
        // 位置也要钉：假时钟 = 周四 → 窗口自 13 天前（周五）起，种子落位 = 上周三 + 本周一/二/三 → 下标 5,10,11,12
        const lit = bars.map((b, i) => (b.querySelector("i") ? i : -1)).filter((i) => i >= 0);
        // 色点断言不盯具体分类名：全量跑时 round47 会把「工作」并进「学习」（合法副作用）——
        // 只要求「当前库里有这个分类的行带点」+「无分类行不带点」（"学习" 是基础任务 t3 的，哪个模式都在）
        const rowEl = (label) =>
          [...(panel?.querySelectorAll(".row") ?? [])].find((r) =>
            rowText(r.querySelector("dt") ?? { textContent: "" }).startsWith(label),
          );
        const dots = panel?.querySelectorAll(".dot").length ?? 0;
        const dotOk = !!rowEl("学习")?.querySelector(".dot") && !rowEl("早期数据（无分类）")?.querySelector(".dot");
        const measures = panel?.querySelectorAll(".measure").length ?? 0;
        const catGroup = [...(panel?.querySelectorAll(".group") ?? [])].find(
          (g) => rowText(g.querySelector("h3") ?? { textContent: "" }) === "分类分布",
        );
        const noteOk = rowText(catGroup?.querySelector(".empty") ?? { textContent: "" }).includes("不会回改旧账");
        window.__DIAG.push(
          `r82⑩ 趋势=${bars.length}条/非零${nonzero}（亮=${lit.join(",")}） 按时=[${onTime}] 平均=[${avg}] 连续=[${streakNow}/${streakBest}]` +
            ` 分类=[${work} | ${study} | ${untagged}] 点=${dots}（判定=${dotOk}） 条=${measures} 注=${noteOk}`,
        );
        await shutStats();
        return (
          bars.length === 14 &&
          nonzero === 4 &&
          lit.join(",") === "5,10,11,12" &&
          onTime === "3/4 · 75%（4/5 条同时有「时长 + 延迟」记录）" &&
          avg === "39 分" &&
          streakNow === "3 天" &&
          streakBest === "3 天" &&
          work === "1 小时 5 分（2 条）" &&
          study === "30 分（1 条）" &&
          untagged === "1 小时（2 条）" &&
          dotOk &&
          measures === 7 &&
          noteOk
        );
      },
    ],
    [
      "round60 ⑥：打开即重拉（不是快照）—— 关掉 → 标一块 ✓ → 重开，数字真的 +1",
      async () => {
        await shutStats();
        await shutReview();
        await backToThisWeek();
        const pick = FIX.blocks.find(
          (b) =>
            b.id !== "bphantom" &&
            b.status === "planned" &&
            b.start_at >= at(0, 0, 0) &&
            b.end_at <= at(7, 0, 0) &&
            el(b.id),
        );
        if (!pick) {
          window.__DIAG.push("r60⑥ 找不到可标记的 planned 块");
          return false;
        }
        if (!(await selectByClick(pick.id))) return false;
        if (!(await openStatsPanel())) return false;
        await settle(20);
        const before = statsRow("标为完成");
        const callsBefore = window.__STATS_CALLS || 0;
        await shutStats();
        await press("Space"); // 标记完成（键盘路径）
        const marked = blk(pick.id)?.status === "done";
        if (!(await openStatsPanel())) return false;
        await settle(20);
        const after = statsRow("标为完成");
        const calls = (window.__STATS_CALLS || 0) - callsBefore;
        window.__DIAG.push(`r60⑥ 块=${pick.id} 标了=${marked} 再拉次数=${calls} 前=[${before}] 后=[${after}]`);
        await shutStats();
        return marked && calls === 1 && before === "5 次" && after === "6 次";
      },
    ],
    [
      "round60 ⑦：空库 → 空态文案 + 完成率「—」（不编 0%）",
      async () => {
        window.__STATS_EMPTY = true;
        await shutStats();
        if (!(await openStatsPanel())) return false;
        await settle(20);
        const state = rowText(statsPanel()?.querySelector(".state") ?? { textContent: "" });
        const rate = statsRow("完成率");
        // round82：面板里多了「分类分布」组 —— 它的空态与周表空态都是 `.empty`，
        // 得按组名找（否则抓到的是分类那句，判据空转）
        const weeksGroup = [...(statsPanel()?.querySelectorAll(".group") ?? [])].find(
          (g) => rowText(g.querySelector("h3") ?? { textContent: "" }) === "近 12 周",
        );
        const weeks = rowText(weeksGroup?.querySelector(".empty") ?? { textContent: "" });
        window.__DIAG.push(`r60⑦ 空态=[${state}] 率=[${rate}] 周=[${weeks}]`);
        await shutStats();
        return state.includes("还没有记录") && rate === "—" && weeks.includes("还没有记录");
      },
    ],
    [
      "round60 ⑧：Esc / 点外面 / ✕ 三种关法都关得上，且 Esc 不连累块的选中、遮罩真挡住时间轴",
      async () => {
        await shutStats();
        await backToThisWeek();
        const pick = FIX.blocks.find((b) => b.id !== "bphantom" && b.status === "planned" && el(b.id));
        if (!pick) {
          window.__DIAG.push("r60⑧ 找不到可选中的 planned 块");
          return false;
        }
        if (!(await selectByClick(pick.id))) return false;
        // ① Esc（真键盘路径：目标是 body —— capture 在 bubble 之前）
        if (!(await openStatsPanel())) return false;
        // 遮罩真挡住时间轴：块身上那一点用 `elementFromPoint` 命中的必须是遮罩 / 面板（z-40/41）
        const box = el(pick.id)?.getBoundingClientRect();
        const hit = box
          ? document.elementFromPoint(box.left + 20, box.top + box.height / 2)
          : null;
        const backdrop = document.querySelector('button.overlay-backdrop[aria-label="关闭统计"]');
        // round83（§8.1）：统计现在可能是**总览的子层** —— 那会儿命中到的多半是总览遮罩 / 总览面板。
        // 本检查的语义是「遮罩真挡住时间轴」→ 判据 = 那一点**命中不到时间轴**（上面那几层都算挡住）。
        const shielded = !!hit && !hit.closest?.(".board") && !!(backdrop || hit.closest?.(".review-panel"));
        await pressOnBody("Escape");
        const byEsc = !statsPanel();
        const kept = el(pick.id)?.classList.contains("selected") ?? false;
        // ② 点面板外
        if (!(await openStatsPanel())) return false;
        document
          .querySelector('button.overlay-backdrop[aria-label="关闭统计"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const byBackdrop = !statsPanel();
        // ③ ✕
        if (!(await openStatsPanel())) return false;
        statsPanel()?.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const byClose = !statsPanel();
        window.__DIAG.push(`r60⑧ Esc=${byEsc} 选中保留=${kept} 遮罩挡住=${shielded} 点外面=${byBackdrop} ✕=${byClose}`);
        return byEsc && kept && shielded && byBackdrop && byClose;
      },
    ],
    [
      "round60 ⑨：窄窗口（715px 跑本组）→ 入口按钮可见、不把头部挤溢出、面板自身不横向溢出",
      async () => {
        await shutStats();
        await shutReview();
        // round83（§8.1）：顶栏独立统计入口只在**总览功能关**时存在 —— 本检查测的就是那个形态（量完开回来）
        await setFeatureViaGear("一周总览", false);
        const btn = document.querySelector(".head-actions .stats-open");
        const head = document.querySelector(".head");
        if (!btn || !head) {
          await setFeatureViaGear("一周总览", true);
          return false;
        }
        // 6b（round61）复核：flex-wrap 容器上 `scrollWidth <= clientWidth` 恒真（假绿）——
        // 换成量**每个孩子**在视口内（单个超宽的孩子才会碎）
        const headOk = [...head.children].every((c) => {
          const r = c.getBoundingClientRect();
          return r.width === 0 || (r.left >= -1 && r.right <= window.innerWidth + 1);
        });
        const btnRect = btn.getBoundingClientRect();
        // 可见性：量出来是 0×0 的元素（display:none / 被隐藏）不算「在视口内」
        const btnVisible =
          btnRect.width > 0 &&
          btnRect.height > 0 &&
          btn.offsetParent !== null &&
          btnRect.right <= window.innerWidth + 1 &&
          btnRect.left >= -1;
        if (!(await openStatsPanel())) return false;
        await settle(20);
        const node = statsPanel();
        const nodeRect = node.getBoundingClientRect();
        const noOverflow =
          node.scrollWidth <= node.clientWidth + 1 && nodeRect.width > 100 && nodeRect.height > 50;
        const btnText = rowText(btn);
        window.__DIAG.push(
          `r60⑨ 头部不溢出=${headOk} 按钮可见=${btnVisible} 面板不溢出=${noOverflow} 宽/高=${Math.round(nodeRect.width)}/${Math.round(nodeRect.height)} 文案=[${btnText}]`,
        );
        await shutStats();
        await setFeatureViaGear("一周总览", true);
        return headOk && btnVisible && noOverflow && btnText.includes("统计");
      },
    ],
    // ===== round61（10.2 多选与批量操作）=====
    [
      "round61 ①：Ctrl+点加/减、Shift+点区间、动作条随选中出现/消失、Esc 先退多选再清空",
      async () => {
        await seedR61();
        await clearSel();

        await selectByClick("m2");
        const single = selectedIds();
        const barAlone = !!document.querySelector(".bulk-bar");

        await ctrlClick("m3");
        const two = selectedIds().sort();
        const barText = document.querySelector(".bulk-bar")?.textContent?.replace(/\s+/g, " ").trim() ?? "";

        await ctrlClick("m3"); // 再点一次 = 减选
        const back = selectedIds();
        const barGone = !document.querySelector(".bulk-bar");

        await shiftClick("m1"); // 锚点 m2 → m1 的区间（按时间排序）
        const range = selectedIds().sort();

        await press("Escape"); // 多选 → 单选（锚点）
        const esc1 = selectedIds();
        const barGone1 = !document.querySelector(".bulk-bar");
        await press("Escape"); // 再一下 → 清空
        const esc2 = selectedIds();

        window.__DIAG.push(
          `r61① 单选=${single.join(",")}/条${barAlone} 加选=${two.join(",")} 条=[${barText}] 减选=${back.join(",")}/条没了${barGone} 区间=${range.join(",")} Esc1=${esc1.join(",")}/条没了${barGone1} Esc2=${esc2.length}`,
        );
        return (
          single.length === 1 && single[0] === "m2" && !barAlone &&
          two.join(",") === "m2,m3" && barText.includes("已选 2 块") &&
          back.length === 1 && back[0] === "m2" && barGone &&
          // round61.1：区间改成**交叠带**后，带里其它任务的块也会进来 —— 只断言「两端都在 + 锚点没动」
          range.includes("m1") && range.includes("m2") &&
          esc1.length === 1 && esc1[0] === "m2" && barGone1 && esc2.length === 0
        );
      },
    ],
    [
      "round61 ②：空白拖 = 框选（碰到就算；画矩形；**替换**旧选中）",
      async () => {
        await clearSel();
        await selectByClick("m4"); // 先选中远处一块 —— 框选要把它换掉
        const before = selectedIds();

        const scroll = document.querySelector(".scroll");
        scroll.scrollTop = 0; // 周四凌晨那两块滚进视野
        await frames(2);
        // ⚠️ **先按下、等头部落定、再量**：按下空白会取消选中 → 键位提示条行高变化 →
        // 整列会轻微上移（715px 下实测 41px）。先量再按的话，矩形顶边会落在 m5 上方 → 框不到它。
        const body = dayBody(3);
        const bodyRect = body.getBoundingClientRect();
        body.dispatchEvent(ptrEvent("pointerdown", bodyRect.left + 4, bodyRect.top + 4));
        await settle(10);
        const r5 = el("m5")?.getBoundingClientRect();
        const r6 = el("m6")?.getBoundingClientRect();
        if (!r5 || !r6) {
          window.__DIAG.push(`r61② 早退：m5=${!!el("m5")} m6=${!!el("m6")}`);
          return false;
        }
        const x1 = Math.max(r5.right, r6.right) + 6;
        const y1 = Math.max(r5.bottom, r6.bottom) + 6;
        const midX = (bodyRect.left + 4 + x1) / 2;
        const midY = (bodyRect.top + 4 + y1) / 2;
        window.dispatchEvent(ptrEvent("pointermove", midX, midY));
        window.dispatchEvent(ptrEvent("pointermove", x1, y1));
        await frames(2);
        const rectShown = !!document.querySelector(".marquee-rect");
        window.dispatchEvent(ptrEvent("pointerup", x1, y1));
        await settle(30);

        const after = selectedIds();
        const bar = document.querySelector(".bulk-bar")?.textContent?.replace(/\s+/g, " ").trim() ?? "";

        // 边界 #7（6b 补）：框选中 Esc = 撤框 —— 矩形消失、选中不变、之后的 pointerup 不再改任何东西
        const body2 = dayBody(3);
        const br2 = body2.getBoundingClientRect();
        body2.dispatchEvent(ptrEvent("pointerdown", br2.left + 4, br2.top + 4));
        await settle(6);
        window.dispatchEvent(ptrEvent("pointermove", br2.left + 80, br2.top + 120));
        await frames(2);
        const rectDuring = !!document.querySelector(".marquee-rect");
        await press("Escape");
        const rectAfterEsc = !!document.querySelector(".marquee-rect");
        const selAfterEsc = selectedIds();
        window.dispatchEvent(ptrEvent("pointerup", br2.left + 80, br2.top + 120));
        await settle(10);
        const selAfterUp = selectedIds();

        // 边界 #6（6b 补）：框在**空地**上 → 不选中任何东西。
        // 用假库在**全周**找一条 15 分钟空档（历轮断言可能把某天铺满），再线性换算成屏幕坐标
        let blank = null; // { d, y }
        for (let d = 0; d < 7 && !blank; d++) {
          const ds = at(d, 0, 0);
          const rect = dayBody(d).getBoundingClientRect();
          for (let t = ds; t + 900 <= ds + 86400; t += 900) {
            if (!FIX.blocks.some((b) => b.end_at > t && b.start_at < t + 900)) {
              blank = { d, y: rect.top + ((t - ds) / 86400) * rect.height, left: rect.left };
              break;
            }
          }
        }
        if (!blank) {
          window.__DIAG.push("r61② 早退：整周找不到 15 分钟空档");
          return false;
        }
        body2.dispatchEvent(ptrEvent("pointerdown", blank.left + 4, blank.y + 2));
        window.dispatchEvent(ptrEvent("pointermove", blank.left + 30, blank.y + 10));
        await frames(2);
        window.dispatchEvent(ptrEvent("pointerup", blank.left + 30, blank.y + 10));
        await settle(10);
        const selEmpty = selectedIds();
        const noBarEmpty = !document.querySelector(".bulk-bar");

        window.__DIAG.push(
          `r61② 旧选中=${before.join(",")} 矩形=${rectShown} 框后=${after.join(",")} 条=[${bar}] Esc撤框=${rectDuring}→${rectAfterEsc} 选中不动=${selAfterEsc.length}/${selAfterUp.length} 空地框=${selEmpty.length}/条无=${noBarEmpty}`,
        );
        return (
          before.includes("m4") &&
          rectShown &&
          !document.querySelector(".marquee-rect") &&
          after.includes("m5") &&
          after.includes("m6") &&
          !after.includes("m4") &&
          bar.includes(`已选 ${after.length} 块`) &&
          rectDuring &&
          !rectAfterEsc &&
          selAfterEsc.length === 0 &&
          selAfterUp.length === 0 &&
          selEmpty.length === 0 &&
          noBarEmpty
        );
      },
    ],
    [
      "round61 ③：动作条「✓ 完成」整批标记（只动 planned，选中保留、提示带数量）",
      async () => {
        await clearSel();
        await selectByClick("m7");
        await ctrlClick("m8");
        // round77（3.1b）：按钮文本不再带字形（图标是 <Icon>）；顺带钉住图标名
        const doneBtn = barBtn("完成");
        const iconOk = doneBtn?.querySelector('[data-icon="check"]') !== null;
        const clicked = await clickBar("完成");
        const done = ["m7", "m8"].every((id) => blk(id)?.status === "done");
        const kept = selectedIds().length === 2;
        const toast = toastText();
        window.__DIAG.push(`r61③ 点=${clicked} 图标=${iconOk} done=${done} 选中保留=${kept} 提示=[${toast}]`);
        return clicked && iconOk && done && kept && toast.includes("已标记 2 块完成");
      },
    ],
    [
      "round61 ④：动作条「✗ 未完成」整批标记，且**不弹漂流卡**（群魔乱舞的解）",
      async () => {
        await clearSel();
        await selectByClick("m9");
        await ctrlClick("m10");
        const missedBtn = barBtn("未完成");
        const iconOk = missedBtn?.querySelector('[data-icon="x"]') !== null;
        await clickBar("未完成");
        const missed = ["m9", "m10"].every((id) => blk(id)?.status === "missed");
        const noDrift = !document.querySelector(".drift");
        window.__DIAG.push(`r61④ 图标=${iconOk} missed=${missed} 无漂流卡=${noDrift}`);
        return iconOk && missed && noDrift;
      },
    ],
    [
      "round61 ⑤：批量删除不弹确认 + **一步 Ctrl+Z 全回来**",
      async () => {
        await clearSel();
        await selectByClick("m11");
        await ctrlClick("m12");
        await clickBar("Del 删除");
        const gone = !blk("m11") && !blk("m12");
        const toast = toastText();
        await press("z", { ctrlKey: true });
        await settle(40);
        const back = !!blk("m11") && !!blk("m12");
        const undoToast = toastText();
        window.__DIAG.push(`r61⑤ 删了=${gone} 提示=[${toast}] 一次撤销全回=${back} 撤销提示=[${undoToast}]`);
        return gone && toast.includes("已删除 2 个块") && back && undoToast.includes("已撤销");
      },
    ],
    [
      "round61 ⑥：批量挪天（动作条）与挪周（Shift+←→）—— 每块各自 ±N 天",
      async () => {
        await clearSel();
        await selectByClick("m13");
        await ctrlClick("m14");
        const weekFrom0 = at(0, 0, 0); // 绝对时间先存：翻周后 `at()` 会漂
        await clickBar("移一天 →");
        const day = blk("m13")?.start_at === at(1, 14, 0) && blk("m14")?.start_at === at(1, 15, 0);
        const tue14 = at(1, 14, 0);
        const tue15 = at(1, 15, 0);
        // 挪周：未拿起不能移动（round61.1）→ Enter 拿起 → Shift+→ → Enter 落地
        await press("Enter");
        await press("ArrowRight", { shiftKey: true });
        const previewRendered = !!el("m13"); // 组预览在**新一周**也画得出来（快照分支）
        await press("Enter");
        const week =
          blk("m13")?.start_at === tue14 + 7 * 86400 && blk("m14")?.start_at === tue15 + 7 * 86400;
        // round61.1（你实测 #4）：跨周后**视角跟过去**（最后拉的窗口 = 下一周起点）+ 选中留住
        const followed = lastWinFrom() === weekFrom0 + 7 * 86400;
        const stillSelected = selectedIds().length === 2;
        await backToThisWeek();
        // 6b 补：界面真的重拉了（幻影行/滞后的老坑）
        const mismatch = dbViewMismatch().filter((s) => !s.startsWith("bphantom("));
        window.__DIAG.push(
          `r61⑥ 挪天=${day} 挪周=${week} 跟到下周=${followed} 选中留住=${stillSelected} 预览画得出=${previewRendered} 幽灵=${mismatch.join(",")}`,
        );
        return day && week && followed && stillSelected && previewRendered && mismatch.length === 0;
      },
    ],
    [
      "round61 ⑦：动作条「必填 / 弹性」整批改层，按钮可用性跟着变",
      async () => {
        await clearSel();
        await selectByClick("m16");
        await ctrlClick("m17");
        const before = barBtn("必填")?.disabled === false && barBtn("弹性")?.disabled === true;
        await clickBar("必填");
        const layers = blk("m16")?.layer === "required" && blk("m17")?.layer === "required";
        const after = barBtn("必填")?.disabled === true && barBtn("弹性")?.disabled === false;
        const mismatch = dbViewMismatch().filter((s) => !s.startsWith("bphantom("));
        window.__DIAG.push(`r61⑦ 初始可用=${before} 改层=${layers} 改后可用=${after} 幽灵=${mismatch.join(",")}`);
        return before && layers && after && mismatch.length === 0;
      },
    ],
    [
      "round61 ⑧：Ctrl+A 全选本周；Esc 一次回单选、两次清空",
      async () => {
        await clearSel();
        await press("a", { ctrlKey: true });
        const total = new Set(
          [...document.querySelectorAll("[data-block-id]")].map((n) => n.getAttribute("data-block-id")),
        ).size;
        const sel = selectedIds();
        const bar = document.querySelector(".bulk-bar")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        await press("Escape");
        const one = selectedIds();
        await press("Escape");
        const zero = selectedIds().length;
        window.__DIAG.push(`r61⑧ 全选=${sel.length}/${total} 条=[${bar}] Esc后=${one.length} → ${zero}`);
        return sel.length === total && total > 0 && bar.includes(`已选 ${total} 块`) && one.length === 1 && zero === 0;
      },
    ],
    [
      "round61 ⑨：窄窗口（715px 跑本组）→ 动作条不把头部挤溢出、按钮都看得见",
      async () => {
        await clearSel();
        await selectByClick("m1");
        await ctrlClick("m2");
        const bar = document.querySelector(".bulk-bar");
        const head = bar?.closest(".head");
        if (!bar || !head) return false;
        // 6b 复核：`.head` 是 flex-wrap 的，`scrollWidth <= clientWidth` 恒真（假绿）——
        // 改成量**每个按钮真的在视口内**且可见（这才是窄窗口真会碎的形态）
        const btns = [...bar.querySelectorAll("button")];
        const btnsInView = btns.every((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.left >= -1 && r.right <= window.innerWidth + 1;
        });
        const r = bar.getBoundingClientRect();
        const inView = r.left >= -1 && r.right <= window.innerWidth + 1;
        const text = bar.textContent.replace(/\s+/g, " ").trim();
        window.__DIAG.push(`r61⑨ 条在视口=${inView} 按钮都在视口=${btnsInView} 按钮=${btns.length} 文案=[${text}]`);
        await clearSel();
        return inView && btnsInView && btns.length >= 8 && text.includes("已选 2 块");
      },
    ],
    [
      "round61 ⑩：批量挪动触发融合 → 「已合并」提示 + 被吃掉的块不留幽灵选中（6b 补）",
      async () => {
        await clearSel();
        await selectByClick("m19");
        await ctrlClick("m20");
        await clickBar("移一天 →");
        const eaten = !blk("m19"); // m18 起点更早 → m19 被吃
        const survivor =
          blk("m18")?.start_at === at(3, 13, 45) && blk("m18")?.end_at === at(3, 14, 30);
        const toast = toastText();
        // 收口：只剩 m20 一块真块 → 动作条该消失（不能挂着「已选 2 块」的幽灵）
        const rest = selectedIds();
        const noGhost = !document.querySelector(".bulk-bar") && rest.length === 1 && rest[0] === "m20";
        const mismatch = dbViewMismatch().filter((s) => !s.startsWith("bphantom("));
        window.__DIAG.push(
          `r61⑩ 被吃=${eaten} 幸存=${survivor} 提示=[${toast}] 收口=${noGhost} 幽灵=${mismatch.join(",")}`,
        );
        await clearSel();
        return eaten && survivor && toast.includes("已合并") && noGhost && mismatch.length === 0;
      },
    ],
    [
      "round61 ⑪：批量改层触发融合 → 同样「已合并」+ 幽灵收口（6b 补）",
      async () => {
        await clearSel();
        await selectByClick("m20"); // ⑩ 之后它在周四 15:00–15:30
        await ctrlClick("m22");
        await clickBar("必填");
        const eaten = !blk("m22"); // m21 起点更早 → m22 被吃
        const survivor = blk("m21")?.layer === "required" && blk("m21")?.end_at === at(3, 17, 0);
        const toast = toastText();
        const rest = selectedIds();
        const noGhost = !document.querySelector(".bulk-bar") && rest.length === 1 && rest[0] === "m20";
        window.__DIAG.push(`r61⑪ 被吃=${eaten} 幸存=${survivor} 提示=[${toast}] 收口=${noGhost}`);
        await clearSel();
        return eaten && survivor && toast.includes("已合并") && noGhost;
      },
    ],
    [
      "round61.1 ⑫：混合选中——条上写明「几块计划中」；移动跳过已标记的并说清；删除键是 Del（0.15.2 按你图5 改）",
      async () => {
        await seedR61(); // 让本组能单独跑（`--only round61.1`）
        await clearSel();
        await focusBlock("m23");
        await settle(6);
        await selectByClick("m23");
        await ctrlClick("m24");
        const bar = document.querySelector(".bulk-bar");
        const text = bar?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const delBtn = barBtn("Del 删除"); // 0.15.2（你报图5）：用键位 Del 说明，不摆垃圾桶
        await clickBar("← 移一天");
        const plannedMoved = blk("m23")?.start_at === at(3, 9, 0); // 周五 9:00 → 周四 9:00
        const doneStayed = blk("m24")?.start_at === at(4, 10, 0);
        const toast = toastText();
        await clearSel();
        window.__DIAG.push(
          `r61.1⑫ 条=[${text}] 删除键=${!!delBtn} 计划中的动了=${plannedMoved} 已标记没动=${doneStayed} 提示=[${toast}]`,
        );
        return (
          text.includes("1 块计划中") &&
          !!delBtn &&
          !text.includes("🗑") &&
          plannedMoved &&
          doneStayed &&
          toast.includes("1 块已标记")
        );
      },
    ],
    [
      "round61.1 ⑬：Shift+点 = 交叠带（搭到「锚点→目标」的块都选中；更早但不搭的不选）（你实测）",
      async () => {
        await clearSel();
        await focusBlock("m27");
        await settle(6);
        await selectByClick("m27");
        await shiftClick("m29");
        const sel = selectedIds();
        await clearSel();
        window.__DIAG.push(`r61.1⑬ 选中=${sel.slice().sort().join(",")}`);
        return (
          sel.includes("m27") && sel.includes("m28") && sel.includes("m29") && !sel.includes("m30")
        );
      },
    ],
    [
      "round61.1 ⑭：↑↓ = 整批挪 15 分钟、Shift+↑↓ = 1 小时；多选键位栏跟着换（你要求）",
      async () => {
        await clearSel();
        await focusBlock("m25");
        await settle(6);
        await selectByClick("m25");
        await ctrlClick("m26");
        const hint = document.querySelector(".key-hint")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        // 未拿起：↑↓ 不动（移动统一收进拿起）
        await press("ArrowUp");
        const untouched = (blk("m25")?.start_at ?? 0) === at(5, 9, 0);
        // 拿起 → ↑↓/Shift+↑↓ 只改预览 → 落地才写
        await press("Enter");
        const hintGrabbed = document.querySelector(".key-hint")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        await press("ArrowUp");
        await press("ArrowDown", { shiftKey: true });
        const previewOnly = (blk("m25")?.start_at ?? 0) === at(5, 9, 0); // 库里还没动
        await press("Enter");
        const finalM25 = (blk("m25")?.start_at ?? 0) === at(5, 9, 0) - 15 * 60 + 60 * 60;
        const finalM26 = (blk("m26")?.start_at ?? 0) === at(5, 10, 0) - 15 * 60 + 60 * 60;
        await clearSel();
        window.__DIAG.push(
          `r61.1⑭ 未拿起键位=[${hint}] 不动=${untouched} 拿起中键位=[${hintGrabbed}] 预览中库里不动=${previewOnly} 落地上=${finalM25} 下=${finalM26} 值=${minOf(blk("m25")?.start_at ?? 0)},${minOf(blk("m26")?.start_at ?? 0)}`,
        );
        return (
          untouched &&
          previewOnly &&
          hint.includes("拿起") &&
          hintGrabbed.includes("移 15 分钟") &&
          hintGrabbed.includes("落地") &&
          finalM25 &&
          finalM26
        );
      },
    ],
    [
      "round61.1 ⑮：未拿起的拖只收成单块；拿起后拖 = 组预览逐帧跟手 + 「N 块」深色角标（0.15.2 按你图6 改）",
      async () => {
        await clearSel();
        await focusBlock("m31");
        await settle(6);
        await selectByClick("m31");
        await ctrlClick("m32");
        // 单击组内成员（没拖动）= 收成单选（列表惯例）——先验这个，再恢复两块
        await selectByClick("m31");
        const collapsed = selectedIds().length === 1 && selectedIds()[0] === "m31";
        await ctrlClick("m32");

        // 窄块（并排分列）里几乎到处都是按钮（色条/⛓…）——扫描出一个**块身上非按钮**的点再按：
        // 按在按钮上不拖动是产品正确行为（全量状态下 m31 就是窄块）
        const bodyPoint = (id) => {
          const node = document.querySelector(`[data-block-id="${id}"]`);
          const r = node?.getBoundingClientRect();
          if (!node || !r) return null;
          for (let fy = 0.25; fy <= 0.75; fy += 0.25) {
            for (let fx = 0.15; fx <= 0.85; fx += 0.1) {
              const x = r.left + Math.round(r.width * fx);
              const y = r.top + Math.round(r.height * fy);
              const t = document.elementFromPoint(x, y);
              if (t && t.closest(`[data-block-id="${id}"]`) === node && !t.closest("button") && !t.closest(".resize")) {
                return { x, y };
              }
            }
          }
          return null;
        };
        const doDrag = async (hour) => {
          await focusBlock("m31");
          await settle(6);
          const pt = bodyPoint("m31");
          if (!pt) return null;
          document.elementFromPoint(pt.x, pt.y)?.dispatchEvent(ptrEvent("pointerdown", pt.x, pt.y));
          // ⚠️ 按下会让头部重排（收起多选/动作条消失会把板子抬上/召下）→
          // **等重排落定再量落点**；否则用的是按下前的旧坐标 → 落点系统性偏移（窄窗口更明显）
          await settle(8);
          const target = atDay(5, hour, 0);
          dragToPoint(target.x, target.y);
          await settle();
          // 0.15.2（你报图6）：组拖看两样 —— ① 每一块都在跟手 ② 鼠标旁的「N 块」角标（字不能是白的）
          // 单块拖（未拿起）仍看旧拖影（既有主手势，不许改坏）
          const blockGhost = !!document.querySelector('body > div[style*="z-index: 9999"]:not(.drag-count)');
          const badge = document.querySelector("body > .drag-count");
          const badgeWhite = badge ? getComputedStyle(badge).color === "rgb(255, 255, 255)" : false;
          const t31 = el("m31")?.getBoundingClientRect().top ?? 0;
          const t32 = el("m32")?.getBoundingClientRect().top ?? 0;
          dragRelease(target.x, target.y);
          await settle(40);
          return { blockGhost, badge: !!badge, badgeText: badge?.textContent?.trim() ?? "", badgeWhite, t31, t32 };
        };

        // ① 未拿起：拖只会动「收回单选的那一块」（不会把整组拖走）；单块拖的拖影照旧在
        const a0 = blk("m31")?.start_at ?? 0;
        const b0 = blk("m32")?.start_at ?? 0;
        const drag1 = await doDrag(15);
        const aSingle = blk("m31")?.start_at ?? 0;
        const bSingle = blk("m32")?.start_at ?? 0;
        const singleOnly = aSingle !== a0 && bSingle === b0 && selectedIds().length === 1;
        const singleGhost = !!drag1?.blockGhost && !drag1?.badge;

        // ② 拿起整组：拖 = **只改预览**（且预览逐帧跟手）→ Enter 落地才一次批量写
        await ctrlClick("m32");
        await press("Enter");
        const a1 = blk("m31")?.start_at ?? 0;
        const b1 = blk("m32")?.start_at ?? 0;
        const t31a = el("m31")?.getBoundingClientRect().top ?? 0;
        const t32a = el("m32")?.getBoundingClientRect().top ?? 0;
        const drag2 = await doDrag(20);
        const previewOnly = (blk("m31")?.start_at ?? 0) === a1 && (blk("m32")?.start_at ?? 0) === b1;
        const d31 = (drag2?.t31 ?? 0) - t31a;
        const d32 = (drag2?.t32 ?? 0) - t32a;
        const follows = d31 > 20 && Math.abs(d32 - d31) <= 2; // 两块一起走（同一位移）
        const badgeOk = !!drag2?.badge && drag2.badgeText === "2 块" && drag2.badgeWhite === false;
        const noBlockGhost = !drag2?.blockGhost;
        await press("Enter"); // 落地
        const a2 = blk("m31")?.start_at ?? 0;
        const b2 = blk("m32")?.start_at ?? 0;
        const delta = a2 - a1;
        // 严格：落点就是拖到的那一格；两块一起动、位移一致
        const landedAt = a2 === at(5, 20, 0);
        const movedTogether = delta !== 0 && delta % 900 === 0 && b2 - b1 === delta;

        // ③ 混用边界（6b 复核 P1）：键盘先挪 15 分、再用鼠标拖 —— 落点不能少算这 15 分
        await press("Enter"); // 再拿起
        await press("ArrowDown"); // 键盘 +15 分（只改预览）
        const offset2 = b2 - a2; // 两块的相对偏移（整组平移必须保持它）
        const t31b = el("m31")?.getBoundingClientRect().top ?? 0;
        const drag3 = await doDrag(16); // 拖到周六 16:00（避开 m33/m34 的 22:00/23:00——同任务会融合）
        const onTarget = Math.abs((drag3?.t31 ?? 0) - atDay(5, 16, 0).y) <= 2; // 预览就落在指针那一格
        const follows3 = Math.abs((drag3?.t31 ?? 0) - t31b) > 20;
        await press("Enter"); // 落地
        const a3 = blk("m31")?.start_at ?? 0;
        const b3 = blk("m32")?.start_at ?? 0;
        const landed3 = a3 === at(5, 16, 0) && b3 - a3 === offset2;
        const sat21 = FIX.blocks
          .filter((b) => b.task_id === "t21" && b.start_at >= at(5, 0, 0) && b.start_at < at(6, 0, 0))
          .map((b) => b.id + "@" + minOf(b.start_at))
          .join(",");
        await clearSel();
        window.__DIAG.push(
          `r61.1⑮ 收单选=${collapsed} 未拿起拖=单块动(${singleOnly})/单块拖影=${singleGhost} 拿起拖=只预览(${previewOnly})/跟手=${follows}(${Math.round(d31)},${Math.round(d32)}) 角标=[${drag2?.badgeText}]/白字=${drag2?.badgeWhite} 无块影=${noBlockGhost} 落点=${minOf(a2)} 落地同位移=${movedTogether} 混用跟手=${follows3}/落点=${onTarget}/落地=${minOf(a3)},${minOf(b3)} 周六t21=[${sat21}]`,
        );
        return (
          collapsed &&
          singleOnly &&
          singleGhost &&
          previewOnly &&
          follows &&
          badgeOk &&
          noBlockGhost &&
          landedAt &&
          movedTogether &&
          follows3 &&
          onTarget &&
          landed3
        );
      },
    ],
    [
      "round61.1 ⑯：框选拖到边缘会**自动滚屏**（能选到窗口外的东西）（你实测）",
      async () => {
        await clearSel();
        const scroll = document.querySelector(".scroll");
        // 先挪到**可滚动区间**的中段（用 scrollHeight/2 会直接到底部 —— 到底就再也滚不动 → 假红）
        scroll.scrollTop = Math.max(0, Math.round((scroll.scrollHeight - scroll.clientHeight) / 2));
        await frames(2);
        const top0 = scroll.scrollTop;
        const canH = scroll.scrollWidth > scroll.clientWidth + 50;
        const left0 = scroll.scrollLeft;
        const col = dayBody(3).getBoundingClientRect();
        // 从周四列中部按下 → 把指针贴到滚动区下缘（能横滚的话再试右缘）
        dayBody(3).dispatchEvent(ptrEvent("pointerdown", col.left + 4, col.top + 120));
        const sr = scroll.getBoundingClientRect();
        window.dispatchEvent(ptrEvent("pointermove", sr.left + sr.width / 2, sr.bottom - 4));
        await frames(12);
        const afterDown = document.querySelector(".scroll").scrollTop;
        const scrolledDown = afterDown > top0; // 方向：往下滚（只验“变没变”会把反向也算过）
        let scrolledRight = false;
        if (canH) {
          const leftBefore = document.querySelector(".scroll").scrollLeft;
          window.dispatchEvent(ptrEvent("pointermove", sr.right - 4, sr.bottom - 4));
          await frames(12);
          scrolledRight = document.querySelector(".scroll").scrollLeft > leftBefore;
        }
        window.dispatchEvent(ptrEvent("pointerup", sr.right - 4, sr.bottom - 4));
        await settle(30);
        const stopped = !document.querySelector(".marquee-rect");
        // 松手后 rAF 必须停：再等 12 帧滚动位置不能变（6b：只验“矩形没了”不够）
        const afterUp = document.querySelector(".scroll").scrollTop;
        await frames(12);
        const noMoreScroll = document.querySelector(".scroll").scrollTop === afterUp;
        document.querySelector(".scroll").scrollTop = top0;
        document.querySelector(".scroll").scrollLeft = left0;
        await clearSel();
        window.__DIAG.push(
          `r61.1⑯ 下滚=${scrolledDown} 右滚=${scrolledRight}（可横滚=${canH}） 松手后框没了=${stopped} 不再滚=${noMoreScroll}`,
        );
        return scrolledDown && stopped && noMoreScroll && (canH ? scrolledRight : true);
      },
    ],
    [
      "round61.1 ⑰：拿起中按成员的拉伸把手 = 先放弃拿起，不会在拿起里静默写库（6b P1）",
      async () => {
        await clearSel();
        await focusBlock("m33");
        await settle(6);
        await selectByClick("m33");
        await ctrlClick("m34");
        await press("Enter");
        const hintOf = () => document.querySelector(".key-hint")?.textContent ?? "";
        const hintGrabbed = hintOf();
        const before = { s: blk("m33")?.start_at ?? 0, e: blk("m33")?.end_at ?? 0 };
        const idsBefore = selectedIds().length;
        const handle = document.querySelector('[data-block-id="m33"] .edge-bottom');
        let abandoned = false;
        let hintedAfter = "";
        if (handle) {
          const hb = handle.getBoundingClientRect();
          handle.dispatchEvent(ptrEvent("pointerdown", hb.left + 20, hb.bottom));
          await settle(6);
          hintedAfter = hintOf();
          abandoned = hintedAfter.includes("拿起") && !hintedAfter.includes("落地");
          handle.dispatchEvent(ptrEvent("pointerup", hb.left + 20, hb.bottom));
          await settle(30);
        }
        const noWrite = (blk("m33")?.start_at ?? 0) === before.s && (blk("m33")?.end_at ?? 0) === before.e;
        await clearSel();
        window.__DIAG.push(
          `r61.1⑰ 拿起中=[${hintGrabbed}] 选中=${idsBefore} 按把手后=[${hintedAfter}] 放弃=${abandoned} 没写库=${noWrite} 有把手=${!!handle}`,
        );
        return !!handle && idsBefore === 2 && hintGrabbed.includes("落地") && abandoned && noWrite;
      },
    ],

    // ===== round61.2（0.15.2 验收回修）：你报的图1/图2/图4/图6 与框选锚点、Del 键 =====
    [
      "round61.2 ⑱：多选拿起辅助线 = 组的包络（最早起点 + 最晚终点；不计日期）（你报图1）",
      async () => {
        await seedR61();
        await clearSel();
        await selectByClick("m5"); // 周四 04:00–04:30（不是锚点；用周四不用周一，能抓「线画错列」）
        await ctrlClick("m6"); // 锚点 = 周四 04:45–05:15
        await press("Enter"); // 拿起整组
        await settle(6);
        const lines = alignLines().length;
        const labels = alignLabels();
        const dayRight = dayBody(3).getBoundingClientRect().right;
        const inColumn = alignLines().every(
          (l) => Math.abs(l.getBoundingClientRect().right - dayRight) <= 1,
        );
        await press("ArrowDown"); // 整组 +15 分（只改预览）
        await settle(6);
        const labelsMoved = alignLabels();
        await press("Escape");
        await clearSel();
        // ② 跨天包络（B2）：m16（周四 10:00）+ m35（周四 23:30 → 周五 00:30）
        //    → 起点线在周四、终点线画到周五列（+ 周四列底补一条），小牌写「次日 00:30」
        await selectByClick("m16");
        await ctrlClick("m35"); // 锚点 = 跨天那块
        await press("Enter");
        await settle(6);
        const crossLabels = alignLabels();
        const crossLines = alignLines().length;
        const friRight = dayBody(4).getBoundingClientRect().right;
        const endLineInFri = alignLines().some(
          (l) => Math.abs(l.getBoundingClientRect().right - friRight) <= 1,
        );
        const chipText = [...document.querySelectorAll(".day-chip")].map((n) =>
          (n.textContent ?? "").trim(),
        );
        const nextDayChip = chipText.some((t) => t.includes("次日") && t.includes("00:30"));
        const noPrevDayChip = !chipText.some((t) => t.includes("前一日"));
        await press("Escape");
        await clearSel();
        window.__DIAG.push(
          `r61.2⑱ 线=${lines} 在周四列=${inColumn} 拿起=[${labels.join(",")}] 下移=[${labelsMoved.join(",")}] 跨天:线=${crossLines}/终点在周五列=${endLineInFri}/胶囊=[${crossLabels.join(",")}]/小牌=[${chipText.join("|")}]`,
        );
        return (
          lines === 2 &&
          inColumn &&
          labels.join(",") === "04:00,05:15" &&
          labelsMoved.join(",") === "04:15,05:30" &&
          crossLines === 3 &&
          crossLabels.join(",") === "10:00,次日00:30" &&
          endLineInFri &&
          nextDayChip &&
          noPrevDayChip
        );
      },
    ],
    [
      "round61.2 ⑲：组拿起按 →（挪一天）：组里**非锚点**那块越过周界也要翻页（你报图2）",
      async () => {
        await backToThisWeek();
        await clearSel();
        await selectByClick("m27"); // 周日 19:15–22:00（挪一天 = 下周一 → 越界）
        await ctrlClick("m1"); // 锚点 = 周一 9:00（挪一天 = 周二，还在本周）
        await press("Enter");
        const win0 = lastWinFrom();
        await press("ArrowRight"); // 挪一天
        const flipped = lastWinFrom() === win0 + 7 * 86400;
        await settle(10);
        // 翻了还不够：翻过去之后那块得真的在视口里（「翻了周但块没跟过去」也要红）
        const sb = document.querySelector(".scroll").getBoundingClientRect();
        const rb = el("m27")?.getBoundingClientRect();
        const visible = !!rb && rb.top < sb.bottom && rb.bottom > sb.top;
        await press("Escape");
        await clearSel();
        await backToThisWeek();
        window.__DIAG.push(`r61.2⑲ win0=${minOf(win0)} 翻周=${flipped} 块在视口=${visible}`);
        return flipped && visible;
      },
    ],
    [
      "round61.2 ⑳：组拿起按 ↓：跟的是组**下边缘**（超出窗口就滚到下边缘），不是锚点起点（你报图2）",
      async () => {
        await clearSel();
        setScrollHome();
        await settle(4);
        await selectByClick("m30"); // 周日 17:00–18:00（组的上边缘）
        await ctrlClick("m27"); // 锚点 = 周日 19:15–22:00（组的下边缘 22:00）
        await press("Enter");
        await press("ArrowDown"); // 整组 +15 分 → 下边缘 22:15
        await settle(10);
        const scroll = document.querySelector(".scroll");
        const sb = scroll.getBoundingClientRect();
        const rb = el("m27")?.getBoundingClientRect();
        const bottomVisible = !!rb && rb.bottom <= sb.bottom + 1 && rb.bottom > sb.top;
        const topVisible = !!rb && rb.top >= sb.top - 1;
        await press("Escape");
        await clearSel();
        setScrollHome();
        window.__DIAG.push(
          `r61.2⑳ 下边缘可见=${bottomVisible} 上边缘可见=${topVisible} 块底=${Math.round(rb?.bottom ?? -1)}/${Math.round(sb.bottom)}`,
        );
        return bottomVisible && topVisible;
      },
    ],
    [
      "round61.2 ㉑：组拿起按 ↓ 跨过日界：相机跟到相邻那一列（横向也跟）（你报图2）",
      async () => {
        await clearSel();
        narrowViewport(); // 520px：逼出横向溢出，才看得出「横向跟没跟」
        await settle(4);
        const scroll = document.querySelector(".scroll");
        await selectByClick("m34"); // 周六 23:00–23:30（按 4 次 ↓ = 起点跨到周日 00:00）
        await ctrlClick("m33"); // 锚点 = 周六 22:00–22:30（不跨日）
        // 先让周六列在视口里、周日列只露一条边 → 只有真跟过去才看得出
        const d6 = dayBody(6).getBoundingClientRect();
        const s0 = scroll.getBoundingClientRect();
        scroll.scrollLeft += d6.left - s0.right + 8;
        await frames(2);
        await press("Enter");
        for (let i = 0; i < 4; i++) await press("ArrowDown"); // +1 小时 → m34 起点 = 周日 00:00
        await settle(10);
        const day6 = dayBody(6).getBoundingClientRect();
        const sk = scroll.getBoundingClientRect();
        const followed = day6.right <= sk.right + 1 && day6.left >= sk.left - 1;
        await press("Escape");
        await clearSel();
        restoreTimelineWidth();
        scroll.scrollLeft = 0;
        setScrollHome();
        await settle(4);
        window.__DIAG.push(
          `r61.2㉑ 跟到周日列=${followed} day6=[${Math.round(day6.left)},${Math.round(day6.right)}] 视口=[${Math.round(sk.left)},${Math.round(sk.right)}]`,
        );
        return followed;
      },
    ],
    [
      "round61.2 ㉒：拿起跨周后动作条的计数不能谎报成「0 块计划中」（你报图4）",
      async () => {
        await backToThisWeek();
        await clearSel();
        // ⚠️ 不能用 m1/m2：尾部的 CDP 真输入探针要拿它们做真 Ctrl+点（挪走会跳过探针）
        await selectByClick("m16"); // 周四 10:00（前面的断言只改过它的层，仍是计划中）
        await ctrlClick("m17"); // 周四 11:00
        await press("Enter");
        await press("ArrowRight", { shiftKey: true }); // 整组挪一周（跨出本窗口）
        await settle(20);
        const barText = () =>
          document.querySelector(".bulk-bar")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const grabbedText = barText();
        const moveBtn = barBtn("移一天 →");
        const disabledWhileOut = moveBtn?.disabled === true;
        const explained = (moveBtn?.getAttribute("title") ?? "").includes("落地");
        await press("Enter"); // 落地 → 回到块真身所在的这一周
        await settle(30);
        const landedText = barText();
        const enabledAfter = barBtn("移一天 →")?.disabled === false;
        await clearSel();
        await backToThisWeek();
        window.__DIAG.push(
          `r61.2㉒ 拿起跨周条=[${grabbedText}] 按钮禁用=${disabledWhileOut}/说明=${explained} 落地后=[${landedText}] 按钮可用=${enabledAfter}`,
        );
        return (
          grabbedText.includes("已选 2 块") &&
          !grabbedText.includes("0 块计划中") &&
          !grabbedText.includes("已标记") &&
          disabledWhileOut &&
          explained &&
          landedText.includes("已选 2 块") &&
          !landedText.includes("0 块计划中") &&
          enabledAfter
        );
      },
    ],
    [
      "round61.2 ㉓：拿起中按动作条按钮 = 先放弃拿起、再按**真实**位置执行（不静默写预览位置）（规则表钉住）",
      async () => {
        await backToThisWeek();
        await clearSel();
        await selectByClick("m5"); // 周四 04:00–04:30
        await ctrlClick("m6"); // 锚点 = 周四 04:45–05:15
        await press("Enter");
        await press("ArrowDown"); // 预览 +15 分（不落库）
        const previewing = alignLines().length > 0;
        const btn = barBtn("移一天 →");
        const bb = btn?.getBoundingClientRect();
        // 真按下去：window capture 先放弃拿起 → click 再执行（与真鼠标同一条路径；
        // 直接 dispatch click 会绕过 pointerdown，测不到这条规则）
        btn?.dispatchEvent(ptrEvent("pointerdown", (bb?.left ?? 0) + 10, (bb?.top ?? 0) + 10));
        btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const m5 = blk("m5");
        const m6 = blk("m6");
        const realMoved = m5?.start_at === at(4, 4, 0) && m6?.start_at === at(4, 4, 45);
        const grabGone = alignLines().length === 0;
        await clearSel();
        setScrollHome();
        window.__DIAG.push(
          `r61.2㉓ 拿起中有线=${previewing} 真位移=${realMoved}(${minOf(m5?.start_at ?? 0)},${minOf(m6?.start_at ?? 0)}) 拿起已放弃=${grabGone}`,
        );
        return previewing && realMoved && grabGone;
      },
    ],
    [
      "round61.2 ㉔：框选起手锚点固定在**内容坐标**（边缘自动滚屏时框跟内容长，不跟窗口跑）（你实测）",
      async () => {
        await clearSel();
        const scroll = document.querySelector(".scroll");
        const board = document.querySelector(".board");
        scroll.scrollLeft = 0;
        setScrollHome();
        await frames(2);
        const body = dayBody(5); // 周六：11:00 一带是空档
        const br = body.getBoundingClientRect();
        const sr = scroll.getBoundingClientRect();
        const sx = br.left + 30;
        const sy = br.top + yAt(11, 0);
        body.dispatchEvent(ptrEvent("pointerdown", sx, sy));
        await settle(6);
        window.dispatchEvent(ptrEvent("pointermove", sx + 30, sy + 30)); // 过 4px 阈值
        await settle(2);
        const rectEl = () => document.querySelector(".marquee-rect");
        const r0 = rectEl()?.getBoundingClientRect();
        const contentTop0 = (r0?.top ?? 0) - board.getBoundingClientRect().top;
        // 指针贴住滚动区下缘 → 自动滚屏十几帧（内容从它下面扫过去）
        window.dispatchEvent(ptrEvent("pointermove", sr.left + sr.width / 2, sr.bottom - 4));
        await frames(1); // 先让「指针到位」那一帧落定，再取滚屏前的中场值 —— 否则测不出「框随内容长」
        const topMid = scroll.scrollTop;
        const rMid = rectEl()?.getBoundingClientRect();
        const midContentTop = (rMid?.top ?? 0) - board.getBoundingClientRect().top;
        const midContentBottom = (rMid?.bottom ?? 0) - board.getBoundingClientRect().top;
        await frames(15);
        const scrolled = scroll.scrollTop > topMid + 20;
        const r1 = rectEl()?.getBoundingClientRect();
        const contentTop1 = (r1?.top ?? 0) - board.getBoundingClientRect().top;
        const contentBottom1 = (r1?.bottom ?? 0) - board.getBoundingClientRect().top;
        const anchored = Math.abs(contentTop1 - contentTop0) <= 2; // 起点不随滚屏漂
        // 内容滚了 Δ，框的下边缘就该跟着长 Δ（不是「指针一开始推动多少」那种假长）
        const scrollDelta = scroll.scrollTop - topMid;
        const grew = contentBottom1 - contentTop1 - (midContentBottom - midContentTop) >= Math.max(20, scrollDelta - 4);
        window.dispatchEvent(ptrEvent("pointerup", sr.left + sr.width / 2, sr.bottom - 4));
        await settle(20);
        await clearSel();
        setScrollHome();
        window.__DIAG.push(
          `r61.2㉔ 滚了=${scrolled}(${Math.round(scrollDelta)}) 起点内容坐标 ${Math.round(contentTop0)}→${Math.round(contentTop1)}（中场 ${Math.round(midContentTop)}） 高度增=${Math.round(contentBottom1 - contentTop1 - (midContentBottom - midContentTop))}`,
        );
        return scrolled && anchored && grew;
      },
    ],

    // ===== round62（C14）：⚙「备份」区 + 导出 / 恢复走通（假 dialog + 假后端） =====
    [
      "round62 ㉕：⚙ 有「备份」区（导出备份… / 从备份恢复… 两枚按钮）",
      async () => {
        await openSettingsSub("data"); // round78：数据区进了「更多」折叠区
        const labels = [...document.querySelectorAll(".sanity-pop .backup:not(.ics-export):not(.portable-open)")].map(
          (b) => (b.textContent ?? "").replace(/\s+/g, " ").trim(),
        );
        window.__DIAG.push(`r62㉕ 按钮=[${labels.join(" / ")}]`);
        return (
          labels.length === 2 &&
          labels[0].startsWith("导出备份") &&
          labels[1].startsWith("从备份恢复")
        );
      },
    ],
    [
      "round62 ㉖：导出备份走通 —— 假「另存为」给路径 → export_backup 拿到它，Toast 摆出路径",
      async () => {
        const path = "D:\\备份测试\\WakeyWeeky-2026-10-04-1930.db";
        window.__DIALOG_SAVE_PATH = path;
        window.__BACKUP_EXPORTED = null;
        await openSettingsSub("data");
        document.querySelector(".sanity-pop .backup:not(.ics-export)")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const exported = window.__BACKUP_EXPORTED;
        const toastHit = [...document.querySelectorAll(".toast")].some((n) =>
          (n.textContent ?? "").includes(path),
        );
        // 系统对话框的入参也要没丢：默认文件名是时间戳格式、过滤器里有 .db
        const opts = window.__DIALOG_LAST_SAVE ?? {};
        const nameOk = /^WakeyWeeky-\d{4}-\d{2}-\d{2}-\d{4}\.db$/.test(String(opts.defaultPath ?? ""));
        const filterOk = (opts.filters ?? []).some((f) => (f.extensions ?? []).includes("db"));
        window.__DIAG.push(
          `r62㉖ 后端收到=${exported} toast带路径=${toastHit} 默认名合格=${nameOk} 过滤器合格=${filterOk}`,
        );
        return exported === path && toastHit && nameOk && filterOk;
      },
    ],
    [
      "round62 ㉗：恢复 = 选文件 → 确认（取消时不调后端；确认后后端收到路径）",
      async () => {
        const path = "D:\\备份测试\\WakeyWeeky-旧备份.db";
        window.__DIALOG_OPEN_PATH = path;
        await openSettingsSub("data");
        const clickRestore = () => {
          const buttons = [...document.querySelectorAll(".sanity-pop .backup:not(.ics-export)")];
          buttons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        };
        // ① 确认（应用内面板，round80 · 79-01）→ 取消：后端不该被调用（也不走系统框）
        window.__BACKUP_IMPORTED = null;
        const sysCalls = window.__DIALOG_CONFIRM_CALLS || 0;
        clickRestore();
        await settle(120);
        const panelUp = !!document.querySelector(".confirm-panel");
        document.querySelector(".confirm-cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const denied = window.__BACKUP_IMPORTED === null && (window.__DIALOG_CONFIRM_CALLS || 0) === sysCalls;
        // ② 确认 → 后端收到路径
        clickRestore();
        await settle(120);
        document.querySelector(".confirm-danger")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(80);
        const imported = window.__BACKUP_IMPORTED;
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(
          `r62㉗ 面板弹过=${panelUp} 取消时未调=${denied} 确认后收到=${imported} 调用链=[${(window.__R62_CALLS || []).slice(-6).join(" , ")}]`,
        );
        return panelUp && denied && imported === path;
      },
    ],

    // ===== round63（C18）：设置弹层分区 + 免打扰 / 提前档位 / 计划任务 / 键位说明 =====
    [
      "round63 ㉘：设置弹层分区 + 免打扰三档走通（点「1 小时」→ 写 quiet_until + 状态行出现；恢复 → 0）",
      async () => {
        await press("Escape");
        // round78（3.1b₂ · 设-01）：分区标题改成「5 组 + 更多」（导航里那五个名字）
        await openSettingsSub();
        const secs = [...document.querySelectorAll(".sanity-pop .sec")].map((n) =>
          (n.textContent ?? "").trim(),
        );
        const navs = [...document.querySelectorAll(".sanity-pop .nav-btn")].map((n) =>
          (n.textContent ?? "").trim(),
        );
        const groups = ["主题与颜色", "字号与密度", "时间轴", "提醒与控制", "更多"];
        const sectionsOk =
          groups.every((s) => navs.includes(s)) &&
          navs.indexOf("提醒与控制") < navs.indexOf("更多") &&
          secs.includes("提醒与控制") &&
          secs.includes("主题与颜色");
        const btn = document.querySelector(".sanity-pop .quiet-60");
        if (!btn) return false;
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const wrote =
          window.__LAST_SETTING?.[0] === "quiet_until" &&
          Number(window.__LAST_SETTING?.[1]) > Date.now() / 1000;
        const stateText = document.querySelector(".sanity-pop [data-quiet-state]")?.textContent ?? "";
        // 6b 加重：① 写的就是「现在 + 1 小时」；② 状态行里那个时刻**等于库里存的那个**（不是随手印个时间）
        const until = Number(window.__SANITY_STATE?.quietUntil ?? 0);
        const oneHour = until > Date.now() / 1000 + 3500 && until < Date.now() / 1000 + 3700;
        const d = new Date(until * 1000);
        const pad = (n) => String(n).padStart(2, "0");
        // round81：状态行走 `formatQuietUntil` = 日期片段（默认 system → `10/7`）+ 时刻
        const shownWant = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const shows = stateText.includes("已暂停提醒，至") && stateText.includes(shownWant);
        document
          .querySelector(".sanity-pop .quiet-resume")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const cleared =
          window.__LAST_SETTING?.[0] === "quiet_until" && window.__LAST_SETTING?.[1] === "0";
        const gone = !document.querySelector(".sanity-pop [data-quiet-state]");
        window.__DIAG.push(
          `r63㉘ 分区=[${secs.join("/")}] 写=${JSON.stringify(window.__LAST_SETTING)} 一小时=${oneHour} 状态行=[${stateText.trim()}]（望 ${shownWant}）恢复=${cleared} 行消失=${gone}`,
        );
        return sectionsOk && wrote && oneHour && shows && cleared && gone;
      },
    ],
    [
      "round63 ㉙：开始提醒的提前档位（选 10 分钟 → 写 remind_lead_minutes）",
      async () => {
        if (!document.querySelector(".sanity-pop")) {
          document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        }
        const lead = document.querySelector(".sanity-pop .lead");
        if (!lead) return false;
        lead.value = "10";
        lead.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(40);
        const wrote =
          window.__LAST_SETTING?.[0] === "remind_lead_minutes" && window.__LAST_SETTING?.[1] === "10";
        lead.value = "0"; // 还原（免得影响后面的断言）
        lead.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(30);
        window.__DIAG.push(`r63㉙ 写=${JSON.stringify(window.__LAST_SETTING)}`);
        return wrote;
      },
    ],
    [
      "round63 ㉚：计划任务默认关 → 勾上写 1、再勾掉写 0",
      async () => {
        await openSettingsSub("scheduler"); // round78：计划任务进了「更多」折叠区
        const box = document.querySelector(".sanity-pop .scheduler-box");
        if (!box) return false;
        const wasOff = box.checked === false; // 假后端默认 scheduler=false（与真后端一致）
        box.checked = true;
        box.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(40);
        const on =
          window.__LAST_SETTING?.[0] === "scheduler_enabled" && window.__LAST_SETTING?.[1] === "1";
        // 6b 加重：读回来 —— 关掉面板再开一次（loadPrefs）→ 勾必须还在（否则「默认关」靠写死 false 也能绿）
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        await openSettingsSub("scheduler");
        const box2 = document.querySelector(".sanity-pop .scheduler-box");
        const onReadBack = box2?.checked === true;
        box2.checked = false;
        box2.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(40);
        const off =
          window.__LAST_SETTING?.[0] === "scheduler_enabled" && window.__LAST_SETTING?.[1] === "0";
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        await openSettingsSub("scheduler");
        const box3 = document.querySelector(".sanity-pop .scheduler-box");
        const offReadBack = box3?.checked === false;
        window.__DIAG.push(
          `r63㉚ 默认关=${wasOff} 写1=${on} 读回1=${onReadBack} 写0=${off} 读回0=${offReadBack}`,
        );
        return wasOff && on && onReadBack && off && offReadBack;
      },
    ],
    [
      "round63 ㉛：键位说明 —— 设置里的入口打开 `?` 总表（同一份数据）：分组 + 关键条目 + 配对",
      async () => {
        // round78（3.1b₂ · 设-08）：表从设置里搬进 `?` 面板（`KeyTable` 共用件）—— 设置里只剩入口
        await openSettingsSub();
        const entry = document.querySelector(".sanity-pop .keymap-open");
        entry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const panel = document.querySelector(".keymap-panel");
        if (!panel) return false;
        const text = (panel.querySelector(".keys")?.textContent ?? "").replace(/\s+/g, "");
        const groups = [...panel.querySelectorAll(".keys .grp")].map((n) => (n.textContent ?? "").trim());
        // round83 回修：「Ctrl+滚轮（分隔条）→ 调整栏宽」按你要求撤掉了 → 必需条目里去掉它（时间轴那条留着）
        const need = ["Ctrl+Z", "Ctrl+A", "Enter", "F2", "Shift+←→", "Win+Shift+W", "T", "Ctrl+,", "Ctrl+滚轮（时间轴）"];
        const missing = need.filter((n) => !text.includes(n.replace(/\s+/g, "")));
        // 6b 加重：分组名要**完全对**（不只数个数）；挑三行验「按键 ↔ 动作」配对没写反
        const wantGroups = ["浏览", "选中一块", "拿起中", "多选", "撤销", "Backlog", "全局（在别的程序里也管用）", "鼠标"];
        const groupsOk = JSON.stringify(groups) === JSON.stringify(wantGroups);
        const rowOf = (keys) =>
          [...panel.querySelectorAll(".keys tr")].find(
            (tr) => tr.querySelector(".kk")?.textContent?.trim() === keys,
          );
        const pairsOk = [
          ["Shift+←→", "挪一周"],
          ["Ctrl+Z", "撤销上一步"],
          ["↑↓", "改开始时间"],
          ["T", "回到本周"],
          ["Ctrl+滚轮（时间轴）", "调整时间刻度"],
        ].every(([k, word]) => (rowOf(k)?.textContent ?? "").includes(word));
        // 收尾：关面板（`?`）→ 再关设置
        document.querySelector(".keymap-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(
          `r63㉛ 分组=[${groups.join("/")}] 缺=${missing.join(",") || "无"} 分组全对=${groupsOk} 配对=${pairsOk}`,
        );
        return groupsOk && missing.length === 0 && pairsOk;
      },
    ],
    [
      "round63 ㉜：Backlog 视图记忆 —— 筛选 / 分组 / 收起写进设置，且**读得回来**（打开设置面板重读一次）",
      async () => {
        await press("Escape");
        // ① 筛选「学习」→ backlog_filter（JSON 带分类名）
        const rows = await openCatMenu();
        const learn = rows?.find((r) => r.name === "学习");
        if (!learn) return false;
        await tapRow(learn);
        await settle(40);
        const filterWrite =
          window.__LAST_SETTING?.[0] === "backlog_filter" &&
          String(window.__LAST_SETTING?.[1]).includes("学习");
        // ② 分组 → backlog_grouped=1
        document
          .querySelector(".group-toggle")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const groupWrite =
          window.__LAST_SETTING?.[0] === "backlog_grouped" && window.__LAST_SETTING?.[1] === "1";
        // ③ 收起「学习」那一堆 → backlog_collapsed 里带它
        const head = [...document.querySelectorAll(".list .ghead-btn")].find((n) =>
          (n.textContent ?? "").includes("学习"),
        );
        head?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const collapseWrite =
          window.__LAST_SETTING?.[0] === "backlog_collapsed" &&
          String(window.__LAST_SETTING?.[1]).includes("学习");
        const collapsedNow = head?.getAttribute("aria-expanded") === "false";
        // 界面确实跟着写走了（这一步只是「写入生效」的 sanity check；真正的读回验证在下面）
        const stillFiltered = !!document.querySelector(".only");
        const stillGrouped =
          document.querySelector(".group-toggle")?.getAttribute("aria-pressed") === "true";
        // 收尾：把**假库**里的值改回默认（绕过 store）→ 再打开设置面板重读 → 界面必须跟着回「全部 / 不分组」。
        // 6b 指出：只查「界面还筛着」的话，`loadPrefs` 读失败也能绿（读回那半是摆设）—— 这里从**另一头**验证。
        const fake = window.__SANITY_STATE;
        fake.backlogFilter = '{"kind":"all"}';
        fake.backlogGrouped = false;
        document
          .querySelector(".sanity-gear")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const panelReopened = !!document.querySelector(".sanity-pop");
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const readBackApplied =
          !document.querySelector(".only") &&
          document.querySelector(".group-toggle")?.getAttribute("aria-pressed") === "false";
        window.__DIAG.push(
          `r63㉜ 写筛选=${filterWrite} 写分组=${groupWrite} 写收起=${collapseWrite} 收起生效=${collapsedNow} 界面跟着写=${stillFiltered && stillGrouped} 面板重开=${panelReopened} 读回来生效=${readBackApplied}`,
        );
        return (
          filterWrite &&
          groupWrite &&
          collapseWrite &&
          collapsedNow &&
          stillFiltered &&
          stillGrouped &&
          panelReopened &&
          readBackApplied
        );
      },
    ],
    [
      "round63 ㉝：对比基线（‹ › 步进到「上上周」）—— 真拉那一周，文案跟着换",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await shutReview();
        if (!(await openReview())) return false;
        await settle(30);
        const before = mosaicCalls().length;
        if (!(await ensureCompare(true, 2))) return false;
        await settle(60);
        const wantWeek = weekStartOf(-3); // 正在看 W-1，基线 2 周前 → W-3
        const pulled = mosaicCalls().slice(before).includes(wantWeek);
        const summary = rowText(panel()?.querySelector(".summary") ?? { textContent: "" });
        const textOk = summary.includes("上上周");
        const baseAttr = Number(
          panel()?.querySelector("[data-baseline]")?.getAttribute("data-baseline") ?? 0,
        );
        const pulledWeek = mosaicCalls().slice(-1)[0];
        await ensureCompare(false);
        await backToThisWeek(); // 收尾：视图回本周（后面的 CDP 探针/截图都在本周）
        await shutReview();
        window.__DIAG.push(
          `r63㉝ 拉周=${pulledWeek}（望 ${wantWeek}）拉了基线周=${pulled} 文案含上上周=${textOk} 基线值=${baseAttr}`,
        );
        return pulled && textOk && baseAttr === 2;
      },
    ],
    [
      "round63.1 ㉞：‹ › 能步进到**任意周**（第 6 周前 → 标签变日期、真拉那一周；› 退回；关闭关掉）",
      async () => {
        seedR52();
        await gotoWeek(-1);
        await shutReview();
        if (!(await openReview())) return false;
        await settle(30);
        if (!(await ensureCompare(true, 1))) return false;
        const before = mosaicCalls().length;
        for (let i = 0; i < 5; i++) {
          panel()
            ?.querySelector(".compare-prev")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        }
        await settle(60);
        const attr = Number(
          panel()?.querySelector("[data-baseline]")?.getAttribute("data-baseline") ?? 0,
        );
        const nameEl = panel()?.querySelector(".baseline-name");
        const name = rowText(nameEl ?? { textContent: "" });
        const dateLabel = /^\d{1,2}[-/]\d{1,2} 那周$/.test(name); // ≥3 周起用日期（相对词到那儿不好读；默认 system → `8/17`）
        const titleOk = (nameEl?.getAttribute("title") ?? "").length >= 20; // 完整周区间
        const wantWeek = weekStartOf(-1 - 6); // 正在看 W-1，再往前 6 周 → W-7
        const pulled = mosaicCalls().slice(before).includes(wantWeek);
        // › 退回一格
        panel()
          ?.querySelector(".compare-next")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const back = Number(
          panel()?.querySelector("[data-baseline]")?.getAttribute("data-baseline") ?? 0,
        );
        // 关闭
        panel()
          ?.querySelector(".compare-off")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const off = !panel()?.querySelector("[data-baseline]") && !!panel()?.querySelector(".compare-on");
        await backToThisWeek();
        await shutReview();
        window.__DIAG.push(
          `r63.1㉞ 基线值=${attr} 名称=[${name}] 日期式=${dateLabel} 拉了第6周前=${pulled} 退回=${back} 关掉=${off}`,
        );
        return attr === 6 && dateLabel && titleOk && pulled && back === 5 && off;
      },
    ],

    // ===== round64（C11）：.ics 导出（假 dialog + 假后端；真渲染/转义/折行在 Rust 单测里） =====
    [
      "round64 ①：⚙ 数据区「导出日历 (.ics)…」—— 假另存为给路径 → export_ics 收到，默认名/过滤器/Toast 都对",
      async () => {
        await press("Escape"); // 先收掉可能开着的面板，重新开成干净状态
        await openSettingsSub("data"); // round78：数据区进了「更多」折叠区
        const path = "D:\\导出测试\\WakeyWeeky-2026-10-05.ics";
        window.__DIALOG_SAVE_PATH = path;
        window.__ICS_EXPORTED = null;
        window.__DIALOG_LAST_SAVE = null;
        document.querySelector(".sanity-pop .ics-export")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const exported = window.__ICS_EXPORTED;
        const opts = window.__DIALOG_LAST_SAVE ?? {};
        const nameOk = /^WakeyWeeky-\d{4}-\d{2}-\d{2}\.ics$/.test(String(opts.defaultPath ?? ""));
        const filterOk = (opts.filters ?? []).some((f) => (f.extensions ?? []).includes("ics"));
        const toastHit = [...document.querySelectorAll(".toast")].some(
          (n) => (n.textContent ?? "").includes(path) && (n.textContent ?? "").includes("7 项"),
        );
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(
          `r64① 后端收到=${exported} 默认名=${opts.defaultPath} 名合格=${nameOk} 过滤器合格=${filterOk} toast=${toastHit}`,
        );
        return exported === path && nameOk && filterOk && toastHit;
      },
    ],

    // ===== round64（C10）：功能开关（默认全开）—— 区域、默认值、关锁联动 =====
    [
      "round64 ②：⚙「功能开关（默认全开）」区 —— 17 项全开、行尾有后果标签；模板建议展开出门限输入",
      async () => {
        await press("Escape");
        await openSettingsSub("features"); // round78：功能开关进了「更多」折叠区
        if (!document.querySelector(".feature-row")) {
          document
            .querySelector(".sanity-pop .features-toggle")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(10);
        }
        const rows = [...document.querySelectorAll(".sanity-pop .feature-row")];
        const boxes = rows.map((r) => r.querySelector("input"));
        const allOn = rows.length === 17 && boxes.every((c) => c && c.checked);
        const tags = [...document.querySelectorAll(".sanity-pop .feature-row .tag")].map((t) =>
          (t.textContent ?? "").trim(),
        );
        const tagOk = ["会打扰", "会改数据", "纯外观"].every((t) => tags.includes(t));
        const thresholds = !!document.querySelector(".sanity-pop .feature-thresholds");
        const offTexts = rows.map((r) => r.getAttribute("title") ?? "").filter((t) => t.length > 0);
        const titleOk = rows.length > 0 && offTexts.length === rows.length; // 每行悬停都有「关掉后会怎样」（不写死行数，防再漂）
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(
          `r64② 行数=${rows.length} 全开=${allOn} 标签齐=${tagOk} 门限在=${thresholds} 说明齐=${titleOk}`,
        );
        return allOn && tagOk && thresholds && titleOk;
      },
    ],
    [
      "round64 ③：关锁联动 —— 序列/多选/键盘关掉后 ⛓ 不画、键位栏不画、Ctrl+点不叠选；写进设置；再打开恢复",
      async () => {
        await press("Escape");
        const openPanel = async () => {
          // round78（3.1b₂）：功能开关进了「更多」折叠区
          await openSettingsSub("features");
          if (!document.querySelector(".feature-row")) {
            document
              .querySelector(".sanity-pop .features-toggle")
              ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await settle(10);
          }
        };
        const setFeature = async (label, on) => {
          const row = [...document.querySelectorAll(".sanity-pop .feature-row")].find((r) =>
            (r.textContent ?? "").includes(label),
          );
          const box = row?.querySelector("input");
          if (!box) return false;
          if (box.checked !== on) {
            box.click();
            await settle(30);
          }
          return box.checked === on;
        };
        const closePanel = async () => {
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(10);
        };
        await openPanel();
        const offOk =
          (await setFeature("序列", false)) &&
          (await setFeature("多选与批量", false)) &&
          (await setFeature("键盘操作", false));
        const storedOff = window.__SANITY_STATE.features.sequences_enabled === false;
        await closePanel();
        const noLink = document.querySelectorAll(".box .link").length === 0;
        // 选中第一块（与真鼠标同一条路：pointerdown 按在块身上）→ 键盘开关关着，键位栏不该出现
        const firstBlock = document.querySelector(".box .block");
        if (firstBlock) {
          const r = firstBlock.getBoundingClientRect();
          // 直接发给块元素（不靠 elementFromPoint）——目标可能在滚出视口的位置，命中会落空
          firstBlock.dispatchEvent(ptrEvent("pointerdown", r.left + 18, r.top + r.height / 2));
          firstBlock.dispatchEvent(ptrEvent("pointerup", r.left + 18, r.top + r.height / 2));
          await settle(20);
        }
        const hasSelection = !!document.querySelector(".block.selected");
        const noHint = !document.querySelector(".key-hint");
        // Ctrl+点第二块 → 多选关着 → 不该叠选（仍只 1 块 + 无动作条）
        const second = [...document.querySelectorAll(".box .block")].find((b) => b !== firstBlock);
        if (second) {
          const r = second.getBoundingClientRect();
          second.dispatchEvent(ptrEvent("pointerdown", r.left + 18, r.top + r.height / 2, { ctrlKey: true }));
          second.dispatchEvent(ptrEvent("pointerup", r.left + 18, r.top + r.height / 2, { ctrlKey: true }));
          await settle(30);
        }
        const oneSelected = document.querySelectorAll(".block.selected").length === 1;
        const noBulk = !document.querySelector(".bulk-bar");
        // —— 再打开：⛓ 与键位栏都要回来（选择还在，键位栏应立刻重新出来）——
        await openPanel();
        const onOk =
          (await setFeature("序列", true)) &&
          (await setFeature("多选与批量", true)) &&
          (await setFeature("键盘操作", true));
        await closePanel();
        await settle(30);
        const linkBack = document.querySelectorAll(".box .link").length > 0;
        const hintBack = !!document.querySelector(".key-hint");
        window.__DIAG.push(
          `r64③ 关=${offOk} 存回0=${storedOff} ⛓没了=${noLink} 选中=${hasSelection} 键位栏没了=${noHint} 不叠选=${oneSelected && noBulk} 开=${onOk} ⛓回来=${linkBack} 键位栏回来=${hintBack}`,
        );
        return (
          offOk && storedOff && noLink && hasSelection && noHint && oneSelected && noBulk && onOk && linkBack && hintBack
        );
      },
    ],

    // ===== round64（C10）：模板面板（假后端真落库）+ 首次使用卡 =====
    [
      "round64 ④：模板 —— 存这一周（可删行）→ 名单出现 → 铺到本周（假库块 +N）→ 删模板",
      async () => {
        await press("Escape");
        document.querySelector(".templates-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(50);
        const pop = document.querySelector(".tpl-pop");
        if (!pop) return false;
        const rowsBefore = pop.querySelectorAll(".sk-row").length;
        // 「生成后可改」：删掉一行
        pop.querySelector(".sk-row .rm")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const rowsAfter = pop.querySelectorAll(".sk-row").length;
        // 起名 + 保存
        const input = pop.querySelector(".tpl-input");
        input.value = "验收模板";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await settle(10);
        pop.querySelector(".save")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(50);
        const savedList = (window.__TEMPLATES?.list ?? []).length;
        const nameShown = (pop.querySelector(".tpl-name")?.textContent ?? "").includes("验收模板");
        // 铺到本周：假库里真多出「模板行数」那么多块（不数 DOM —— 跨天块会渲染成两段）
        const libBefore = window.__FIX.blocks.length;
        pop.querySelector(".apply")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const libAfter = window.__FIX.blocks.length;
        const grew = libAfter - libBefore === rowsAfter && rowsAfter > 0;
        // 收尾（顺手验证撤销）：点工具栏 ↶ 把这次套用撤掉 —— 块数回原样，后面的探针/截图不被弄脏
        document
          .querySelector('.week-nav button[title^="撤销"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const undone = window.__FIX.blocks.length === libBefore;
        // 删模板 → 名单空
        pop.querySelector(".del")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const deleted = (window.__TEMPLATES?.list ?? []).length === 0;
        document.querySelector(".tpl-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(
          `r64④ 预览行 ${rowsBefore}→${rowsAfter} 存了=${savedList} 名单显示=${nameShown} 铺后库 +${libAfter - libBefore}（应 ${rowsAfter}）撤销回位=${undone} 删空=${deleted}`,
        );
        return (
          rowsBefore > 0 && rowsAfter === rowsBefore - 1 && savedList === 1 && nameShown && grew && undone && deleted
        );
      },
    ],
    [
      "round64 ⑤：首次使用卡 —— 非空库不出现；`--first-run` 模式下出现且「知道了」记一次",
      async () => {
        const card = document.querySelector(".first-run");
        if (window.__FIRST_RUN === true) {
          if (!card) return false;
          const steps = card.querySelectorAll("ol li").length;
          card.querySelector(".ok")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(80);
          const gone = !document.querySelector(".first-run");
          const seen = (window.__FIRST_RUN_SEEN_CALLS || 0) >= 1;
          // round80（Step 7 · 教-05）：「知道了」= 直接动作 —— 焦点要进「添加任务…」输入框
          const focusedInput = document.activeElement === document.querySelector(".new-task .field");
          window.__DIAG.push(
            `r64⑤ 首次模式 步骤=${steps} 点后消失=${gone} 记过=${seen} 焦点在输入框=${focusedInput}`,
          );
          return steps === 3 && gone && seen && focusedInput;
        }
        window.__DIAG.push(`r64⑤ 非首次模式 卡片在=${!!card} 问过后端=${(window.__FIRST_RUN_CALLS || 0) >= 1}`);
        // 库非空（正常跑）不该冒出来；同时至少验证「组件真问了后端」（不然 FirstRun 全坏也绿）
        return card === null && (window.__FIRST_RUN_CALLS || 0) >= 1;
      },
    ],

    // ===== round64（C10）：渐进提示 / 模板建议 / 说明页 =====
    [
      "round64 ⑥：渐进提示 —— 第一次多选后冒一条；「知道了」收掉；再选不再冒",
      async () => {
        await press("Escape"); // 先清掉上一条留下的选中/面板
        await press("Escape");
        // round77（3.1b）：橙条占着那唯一一条提示位时，渐进提示**要让位**（新优先级）；
        // 这里先关掉橙条，断言才在测「该出现时会出现」
        const clearedOverload = await dismissOverloadBar();
        await dismissNudgeIfAny(); // 绿条也让位（同屏最多一条：橙 > 绿 > 渐进）
        window.__HINTS_ARMED = true; // 套件里前面的多选/拉伸不该把提示条提前引出来（默认不武装）
        window.__HINTS_SEEN = [];
        const ctrlClick = (el) => {
          const r = el.getBoundingClientRect();
          el.dispatchEvent(ptrEvent("pointerdown", r.left + 18, r.top + r.height / 2, { ctrlKey: true }));
          el.dispatchEvent(ptrEvent("pointerup", r.left + 18, r.top + r.height / 2, { ctrlKey: true }));
        };
        const blocksEls = [...document.querySelectorAll(".box .block")];
        if (blocksEls.length < 3) return false;
        ctrlClick(blocksEls[0]);
        await settle(20);
        ctrlClick(blocksEls[1]); // 第二次 Ctrl+点 = 真的多选起来 → maybeHint("multi")
        await settle(50);
        const bar = document.querySelector('[data-guide="hint"]');
        const textOk = (bar?.textContent ?? "").includes("多选");
        bar?.querySelector(".dismiss")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const gone = !document.querySelector('[data-guide="hint"]');
        ctrlClick(blocksEls[2]); // 再选一块：同一条提示不应再冒（一次一生）
        await settle(40);
        const again = !document.querySelector('[data-guide="hint"]');
        await press("Escape");
        await press("Escape");
        window.__DIAG.push(
          `r64⑥ 清橙条=${clearedOverload} 冒条=${!!bar} 文案对=${textOk} 知道了收掉=${gone} 再来不冒=${again}` +
            ` 橙色=${!!document.querySelector(".sanity")} 绿=${!!document.querySelector(".nudge")}` +
            ` 建议条=${!!document.querySelector('[data-guide="suggest"]')} 见过=[${(window.__HINTS_SEEN ?? []).join("/")}]`,
        );
        return !!bar && textOk && gone && again;
      },
    ],
    [
      "round64 ⑦：模板建议 —— 到条件冒一条；「存为模板…」拉到建议的那一周；「不再提」关掉建议开关",
      async () => {
        await press("Escape");
        // round77（3.1b）：同屏最多一条（橙 > 绿 > 渐进）—— 建议条要出现，先让橙条与绿条退场
        const clearedOverload = await dismissOverloadBar();
        await dismissNudgeIfAny();
        const suggestWeek = weekStartOf(-1);
        window.__SUGGEST_WEEK = suggestWeek;
        window.__PREVIEW_WEEKS = [];
        window.dispatchEvent(new Event("focus")); // 与启动 / 回到窗口同一条路
        await settle(80);
        const bar = document.querySelector('[data-guide="suggest"]');
        if (!bar) return false;
        bar.querySelector(".suggest-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(80);
        const pop = document.querySelector(".tpl-pop");
        const pulledSuggested = (window.__PREVIEW_WEEKS ?? []).includes(suggestWeek);
        pop?.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        // 「不再提」：再摆一次，点掉 → 写 template_suggest.enabled=false
        window.__SUGGEST_WEEK = suggestWeek;
        window.dispatchEvent(new Event("focus"));
        await settle(80);
        const bar2 = document.querySelector('[data-guide="suggest"]');
        bar2?.querySelector(".off")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(50);
        let stored = {};
        try {
          stored = JSON.parse(window.__SANITY_STATE.templateSuggest || "{}");
        } catch {
          stored = {}; // 假库里的值坏了也只会让断言红，不抛出去
        }
        const offOk = stored.enabled === false;
        const gone = !document.querySelector('[data-guide="suggest"]');
        window.__SUGGEST_WEEK = null;
        window.__DIAG.push(
          `r64⑦ 让位=${clearedOverload} 冒条=${!!bar} 拉建议周=${pulledSuggested} 不再提写关=${offOk} 条消失=${gone}`,
        );
        return !!bar && pulledSuggested && offOk && gone;
      },
    ],
    [
      "round64 ⑧：说明页 —— 设置里「ⓘ 说明」打开；六个分区 + 功能开关总表 17 行；✕ 关闭",
      async () => {
        await press("Escape");
        // round78（设-05）：顶部那个 ⓘ 入口删了 —— 说明页入口统一在「更多 → 引导与教程」
        await openSettingsSub("guide");
        document.querySelector(".sanity-pop .help-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const panel = document.querySelector(".help-panel");
        if (!panel) return false;
        const sections = ["reminders", "sanity", "data", "templates", "hints", "features"].filter(
          (a) => panel.querySelector(`#help-${a}`),
        ).length;
        const rows = panel.querySelectorAll(".features tbody tr").length;
        panel.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const closed = !document.querySelector(".help-panel");
        // 再开一次：`Esc` 也能关（plan H6；6b 复核 #③-a 的收口）
        document.querySelector(".sanity-pop .help-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const reopened = !!document.querySelector(".help-panel");
        await press("Escape");
        const escClosed = !document.querySelector(".help-panel");
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(
          `r64⑧ 分区=${sections} 开关表行数=${rows} ✕关=${closed} Esc重开=${reopened} Esc关=${escClosed}`,
        );
        return sections === 6 && rows === 17 && closed && reopened && escClosed;
      },
    ],
    [
      "round64 ⑨：两把锁的行为级验证 —— 漂流关掉标 ✗ 不弹卡；渐进提示关掉不冒条",
      async () => {
        await press("Escape");
        const openPanel = async () => {
          // round78（3.1b₂）：功能开关进了「更多」折叠区
          await openSettingsSub("features");
          if (!document.querySelector(".feature-row")) {
            document
              .querySelector(".sanity-pop .features-toggle")
              ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await settle(10);
          }
        };
        const setFeature = async (label, on) => {
          await openPanel();
          const row = [...document.querySelectorAll(".sanity-pop .feature-row")].find((r) =>
            (r.textContent ?? "").includes(label),
          );
          const box = row?.querySelector("input");
          if (!box) return false;
          if (box.checked !== on) {
            box.click();
            await settle(30);
          }
          return box.checked === on;
        };
        const closePanel = async () => {
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(10);
        };
        // ① 漂流关掉 → 标 ✗ 不弹卡
        if (!(await setFeature("漂流", false))) return false;
        await closePanel();
        const missedBtn = [...document.querySelectorAll(".box .block")]
          .map((b) => b.querySelector('button[title="标记未完成"]'))
          .find(Boolean);
        if (!missedBtn) return false;
        missedBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(70);
        const noCard = !document.querySelector(".drift");
        // ② 渐进提示关掉 → 多选也不冒条
        if (!(await setFeature("渐进提示", false))) return false;
        await closePanel();
        window.__HINTS_ARMED = true;
        window.__HINTS_SEEN = [];
        const els = [...document.querySelectorAll(".box .block")].slice(0, 2);
        for (const el of els) {
          const r = el.getBoundingClientRect();
          el.dispatchEvent(ptrEvent("pointerdown", r.left + 18, r.top + r.height / 2, { ctrlKey: true }));
          el.dispatchEvent(ptrEvent("pointerup", r.left + 18, r.top + r.height / 2, { ctrlKey: true }));
          await settle(20);
        }
        await settle(40);
        const noBar = !document.querySelector('[data-guide="hint"]');
        // 收尾：两把锁都打开、关掉可能开着的漂流卡/选中
        await setFeature("漂流", true);
        await setFeature("渐进提示", true);
        await closePanel();
        window.__HINTS_ARMED = false;
        await press("Escape");
        await press("Escape");
        window.__DIAG.push(`r64⑨ 关漂流不弹卡=${noCard} 关提示不冒条=${noBar}`);
        return noCard && noBar;
      },
    ],
    [
      "round64 ⑩：其余锁的行为级 —— 残影/临时块/拉伸/模板/总览/统计 关掉真消失、键盘关掉按键不生效；再开恢复",
      async () => {
        await press("Escape");
        const openPanel = async () => {
          // round78（3.1b₂）：功能开关进了「更多」折叠区
          await openSettingsSub("features");
          if (!document.querySelector(".feature-row")) {
            document
              .querySelector(".sanity-pop .features-toggle")
              ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await settle(10);
          }
        };
        const setFeature = async (label, on) => {
          await openPanel();
          const row = [...document.querySelectorAll(".sanity-pop .feature-row")].find((r) =>
            (r.textContent ?? "").includes(label),
          );
          const box = row?.querySelector("input");
          if (!box) return false;
          if (box.checked !== on) {
            box.click();
            await settle(30);
          }
          return box.checked === on;
        };
        const closePanel = async () => {
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(10);
        };
        // 开着时的基线（要有东西可关，后面的「消失」才不是本来就空）
        // round83（§8.1）：顶栏独立统计入口只在「总览」关着时出现 —— 先关总览量它，再开回来
        await setFeature("一周总览", false);
        const baseStatsBar = !!document.querySelector(".head-actions .stats-open");
        await setFeature("一周总览", true);
        const base = {
          templates: !!document.querySelector(".templates-open"),
          review: !!document.querySelector(".review-open"),
          stats: baseStatsBar,
          handles: document.querySelectorAll(".resize").length > 0,
          remnants: document.querySelectorAll(".block.missed").length > 0,
        };
        const offOk =
          (await setFeature("残影", false)) &&
          (await setFeature("拉伸改时间", false)) &&
          (await setFeature("临时安排块", false)) &&
          (await setFeature("模板", false)) &&
          (await setFeature("一周总览", false)) &&
          (await setFeature("数据统计", false)) &&
          (await setFeature("键盘操作", false));
        await closePanel();
        await settle(30);
        const gone = {
          templates: !document.querySelector(".templates-open"),
          review: !document.querySelector(".review-open"),
          stats: !document.querySelector(".head-actions .stats-open"),
          handles: document.querySelectorAll(".resize").length === 0,
          remnants: document.querySelectorAll(".block.missed").length === 0,
        };
        // 临时块：双击空白格不应再建块（假库块数不变）
        const before = window.__FIX.blocks.length;
        dblclickAt(6, 3, 0); // 周日 03:00 一带平时没有块
        await settle(70);
        const noTemp = window.__FIX.blocks.length === before;
        // 键盘行为：选中一块后按 Space 不该标记完成（class 不变）
        const el = document.querySelector(".box .block");
        let keyOk = false;
        if (el) {
          const r = el.getBoundingClientRect();
          el.dispatchEvent(ptrEvent("pointerdown", r.left + 18, r.top + r.height / 2));
          el.dispatchEvent(ptrEvent("pointerup", r.left + 18, r.top + r.height / 2));
          await settle(20);
          const beforeClass = el.className;
          await press("Space");
          await settle(30);
          const id = el.getAttribute("data-block-id");
          const now = document.querySelector(`[data-block-id="${id}"]`);
          keyOk = !!now && now.className === beforeClass;
        }
        // 再开：入口/把手/残影都回来
        const onOk =
          (await setFeature("残影", true)) &&
          (await setFeature("拉伸改时间", true)) &&
          (await setFeature("临时安排块", true)) &&
          (await setFeature("模板", true)) &&
          (await setFeature("一周总览", true)) &&
          (await setFeature("数据统计", true)) &&
          (await setFeature("键盘操作", true));
        // round83（§8.1）：统计入口同样要在「总览关」的形态下量（量完开回来）
        await setFeature("一周总览", false);
        const backStatsBar = !!document.querySelector(".head-actions .stats-open");
        await setFeature("一周总览", true);
        await closePanel();
        await settle(40);
        const back = {
          templates: !!document.querySelector(".templates-open"),
          review: !!document.querySelector(".review-open"),
          stats: backStatsBar,
          handles: document.querySelectorAll(".resize").length > 0,
          remnants: document.querySelectorAll(".block.missed").length > 0,
        };
        await press("Escape");
        const allGone = Object.values(gone).every(Boolean);
        const allBack = Object.values(back).every(Boolean);
        const baseOk = Object.values(base).every(Boolean);
        window.__DIAG.push(
          `r64⑩ 基线齐=${baseOk} 关=${offOk} 消失=${JSON.stringify(gone)} 不建临时块=${noTemp} 按键不生效=${keyOk} 开=${onOk} 回来=${allBack}`,
        );
        return baseOk && offOk && allGone && noTemp && keyOk && onOk && allBack;
      },
    ],
    [
      "round64.1 ①：关掉漂流 → 漂流子块从时间轴隐藏（不删数据）、↻ 入口也收掉；开回来原样",
      async () => {
        await press("Escape");
        await press("Escape");
        const openPanel = async () => {
          // round78（3.1b₂）：功能开关进了「更多」折叠区
          await openSettingsSub("features");
          if (!document.querySelector(".feature-row")) {
            document
              .querySelector(".sanity-pop .features-toggle")
              ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await settle(10);
          }
        };
        const setFeature = async (label, on) => {
          await openPanel();
          const row = [...document.querySelectorAll(".sanity-pop .feature-row")].find((r) =>
            (r.textContent ?? "").includes(label),
          );
          const box = row?.querySelector("input");
          if (!box) return false;
          if (box.checked !== on) {
            box.click();
            await settle(30);
          }
          return box.checked === on;
        };
        const closePanel = async () => {
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(10);
        };
        // 造一条漂流链（假库直改，形状与 Rust `postpone_block` 的结果一致）：
        // 挑一块**还在计划中**的真实块当残影，clone 一个 postponed_from 指向它的子块
        const el = [...document.querySelectorAll(".box .block")].find((n) => {
          const id = n.getAttribute("data-block-id");
          const b = window.__FIX.blocks.find((x) => x.id === id);
          return b && b.status === "planned" && !b.postponed_from;
        });
        const parentId = el?.getAttribute("data-block-id");
        const parent = window.__FIX.blocks.find((b) => b.id === parentId);
        if (!parent) return false;
        const originalStatus = parent.status;
        const child = Object.assign({}, parent, {
          id: "dchild-r641",
          postponed_from: parent.id,
          status: "planned",
          label: null,
        });
        parent.status = "missed";
        window.__FIX.blocks.push(child);
        await gotoWeek(1);
        await gotoWeek(0);
        const childOn = !!document.querySelector('[data-block-id="dchild-r641"]');
        const parentOn = !!document.querySelector(`[data-block-id="${parentId}"]`);
        const revertOn = !!document.querySelector(
          `[data-block-id="${parentId}"] button[title="重新安排"]`,
        );

        if (!(await setFeature("漂流", false))) return false;
        await closePanel();
        await gotoWeek(1);
        await gotoWeek(0);
        const childOff = !document.querySelector('[data-block-id="dchild-r641"]');
        const parentOff = !!document.querySelector(`[data-block-id="${parentId}"]`);
        const revertOff = !document.querySelector(
          `[data-block-id="${parentId}"] button[title="重新安排"]`,
        );

        await setFeature("漂流", true);
        await closePanel();
        await gotoWeek(1);
        await gotoWeek(0);
        const childBack = !!document.querySelector('[data-block-id="dchild-r641"]');

        // 收尾：清掉造的数据、还原它的状态（不影响后面的断言/截图）
        window.__FIX.blocks = window.__FIX.blocks.filter((b) => b.id !== "dchild-r641");
        parent.status = originalStatus;
        window.__DIAG.push(
          `r64.1① 子块在=${childOn} 残影在=${parentOn} ↻在=${revertOn} 关后：子块藏=${childOff} 残影仍在=${parentOff} ↻藏=${revertOff} 开回来=${childBack}`,
        );
        return childOn && parentOn && revertOn && childOff && parentOff && revertOff && childBack;
      },
    ],
    [
      "round64.1 ②：模板预览行看得见任务名；铺出来挂真任务（按名复用），一步撤销回位",
      async () => {
        await press("Escape");
        await press("Escape");
        document.querySelector(".templates-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(50);
        const pop = document.querySelector(".tpl-pop");
        if (!pop) return false;
        const rows = pop.querySelectorAll(".sk-row").length;
        const names = [...pop.querySelectorAll(".sk-row .sk-name")].map((n) => n.textContent.trim());
        const hasName = names.some((n) => n.length > 0);
        // 保存 → 铺开
        const input = pop.querySelector(".tpl-input");
        input.value = "带任务名";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await settle(10);
        pop.querySelector(".save")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(50);
        const blocksBefore = window.__FIX.blocks.length;
        const tasksBefore = window.__FIX.tasks.length;
        pop.querySelector(".apply")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const added = window.__FIX.blocks.slice(-rows);
        const grew = window.__FIX.blocks.length - blocksBefore === rows;
        // 有名字的行＝真任务（或复用已有任务），不再是清一色临时安排
        const realTasks = added.filter((b) => b.task_id !== TEMP_TASK_ID).length;
        const known = added.every(
          (b) => b.task_id === TEMP_TASK_ID || window.__FIX.tasks.some((t) => t.id === b.task_id),
        );
        // 收尾：撤销这次套用（块 + 任务都回位）→ 删模板 → 收起面板
        document
          .querySelector('.week-nav button[title^="撤销"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const undone =
          window.__FIX.blocks.length === blocksBefore && window.__FIX.tasks.length === tasksBefore;
        pop.querySelector(".del")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        document.querySelector(".tpl-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(
          `r64.1② 预览行=${rows} 有名字=${hasName} 铺=${grew ? `+${rows}` : "不对"} 真任务=${realTasks} 任务id有效=${known} 撤销回位=${undone}`,
        );
        return rows > 0 && hasName && grew && realTasks > 0 && known && undone;
      },
    ],
    [
      "round64.1 ③：撤销/重做把视角开在被改的块上（跨周翻回 + 闪一下 + 窄窗口滚到位）",
      async () => {
        await press("Escape");
        await press("Escape");
        // 挑一块**整块都在本周内**的计划中块（跨周伸进来的块起点在上一周 → 会把视角带到上一周）
        const weekBefore = (window.__DBG || []).at(-1)?.[0];
        const pick = [...document.querySelectorAll(".box .block")].find((n) => {
          const id = n.getAttribute("data-block-id");
          const b = window.__FIX.blocks.find((x) => x.id === id);
          return (
            b &&
            b.status === "planned" &&
            !b.postponed_from &&
            weekBefore != null &&
            b.start_at >= weekBefore &&
            b.end_at <= weekBefore + 7 * 86_400
          );
        });
        if (!pick) return false;
        const id = pick.getAttribute("data-block-id");
        if (!(await selectByClick(id))) return false;
        const posBefore = window.__FIX.blocks.find((b) => b.id === id)?.start_at;
        // round61.1：移动统一收进「拿起」—— Enter 拿起 → Shift+→ 只改组预览 → Enter 落地（一次 record）
        await press("Enter");
        await settle(20);
        await press("ArrowRight", { shiftKey: true });
        await settle(30);
        await press("Enter");
        await settle(80);
        const movedAway =
          window.__FIX.blocks.find((b) => b.id === id)?.start_at === posBefore + 7 * 86_400;
        // 把视角放到**块现在那一周**（下一周），再撤销 —— 视角必须跟回来
        await gotoWeek(1);
        const weekLooking = (window.__DBG || []).at(-1)?.[0];

        // Ctrl+Z：视角要跨周翻回来 + 被改的块闪一下
        await press("z", { ctrlKey: true });
        await settle(100);
        const weekBack = (window.__DBG || []).at(-1)?.[0];
        const flashing = document.querySelectorAll(".block.flash").length;
        // 目标块要在滚动容器可视区内（两个轴都量 —— 窄窗口下横向也要到位）
        const sc = document.querySelector(".scroll")?.getBoundingClientRect();
        const blk = document.querySelector(`[data-block-id="${id}"]`)?.getBoundingClientRect();
        const inView =
          !!sc &&
          !!blk &&
          blk.top >= sc.top - 4 &&
          blk.bottom <= sc.bottom + 4 &&
          blk.left >= sc.left - 4 &&
          blk.right <= sc.right + 4;

        // 闪一下会自己消失（1.5 秒）→ 等它真的走
        for (let i = 0; i < 30 && document.querySelector(".block.flash"); i++) await frames(4);
        const flashGone = !document.querySelector(".block.flash");

        // 重做：再翻到下一周、再闪
        await press("z", { ctrlKey: true, shiftKey: true });
        await settle(100);
        const weekRedone = (window.__DBG || []).at(-1)?.[0];
        const redoFlash = document.querySelectorAll(".block.flash").length;

        // 收尾：撤销这道重做，把块放回原处；清选中
        await press("z", { ctrlKey: true });
        await settle(80);
        await press("Escape");
        await press("Escape");
        window.__DIAG.push(
          `r64.1③ 挪走=${movedAway} 看的是下一周=${weekLooking !== weekBefore} 撤后回本周=${weekBack === weekBefore} 闪=${flashing} 块在视口=${inView} 闪会散=${flashGone} 重做周跟=${weekRedone === weekLooking} 重做闪=${redoFlash}` +
            ` 周 d=${[weekBefore, weekLooking, weekBack, weekRedone].map((x) => (x == null ? "?" : Math.round((x - weekBefore) / 86400))).join("/")}`,
        );
        return (
          movedAway &&
          weekLooking !== weekBefore && // 6b：先把「真翻到了下一周」钉住，否则后两条会空过
          weekBack === weekBefore &&
          flashing > 0 &&
          inView &&
          flashGone &&
          weekRedone === weekLooking &&
          redoFlash > 0
        );
      },
    ],
    [
      "round64.1 ④：设置「引导与教程」—— 说明页入口 / 重看新手卡片 / 重新打开渐进提示",
      async () => {
        await press("Escape");
        await press("Escape");
        await openSettingsSub("guide"); // round78：「引导与教程」进了「更多」折叠区
        const pop = document.querySelector(".sanity-pop");
        if (!pop) return false;
        const gfs = () => [...pop.querySelectorAll(".guide-actions .gf")];
        const sectionOk = gfs().length === 3;
        // ① 重看新手卡片：默认库非空不该有卡片 → 点一下出现 → 「知道了」收起
        const cardBefore = !!document.querySelector(".first-run");
        gfs()
          .find((b) => b.textContent.includes("重看新手卡片"))
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const cardAfter = !!document.querySelector(".first-run");
        const okBtn = document.querySelector(".first-run .ok");
        okBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const cardGone = !document.querySelector(".first-run");
        const cardCount = document.querySelectorAll(".first-run").length;
        const seenCalls = window.__FIRST_RUN_SEEN_CALLS || 0;
        // ② 渐进提示：先在功能开关里关掉 → 本区按钮变「重新打开渐进提示」→ 点一下真的再开
        if (!document.querySelector(".sanity-pop .feature-row")) {
          document
            .querySelector(".sanity-pop .features-toggle")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(10);
        }
        const hintRow = [...pop.querySelectorAll(".feature-row")].find((r) =>
          (r.textContent ?? "").includes("渐进提示"),
        );
        hintRow?.querySelector("input")?.click();
        await settle(30);
        const offBtn = gfs().find((b) => b.textContent.includes("重新打开渐进提示"));
        const offState = !!offBtn && !offBtn.disabled;
        offBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const onBtn = gfs().find((b) => b.textContent.includes("渐进提示：开"));
        const onState = !!onBtn && onBtn.disabled;
        // ③ 打开说明页：真的开着，且「提示与教学」里有找回路径
        gfs()
          .find((b) => b.textContent.includes("打开说明页"))
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const helpText = document.querySelector(".help-panel")?.textContent ?? "";
        const helpOk = helpText.includes("提示与教学") && helpText.includes("引导与教程");
        document.querySelector(".help-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(
          `r64.1④ 三键=${sectionOk} 卡片 ${cardBefore}→${cardAfter}→${cardGone} 剩${cardCount} 知道了按钮=${!!okBtn} 记过=${seenCalls} 关后按钮=${offState} 开后按钮=${onState} 说明页带教程路径=${helpOk}`,
        );
        return sectionOk && !cardBefore && cardAfter && cardGone && offState && onState && helpOk;
      },
    ],
    [
      "round64.1 ⑤（CG）：假后端镜像 create/delete/unlink 记账 —— 三条写路径都真的长事件",
      async () => {
        window.__SEED_STATS?.();
        await settle(10);
        const count = (t) => window.__FIX.events.filter((e) => e.event_type === t).length;
        const before = { create: count("create"), delete: count("delete"), unlink: count("unlink") };
        const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
        const task = window.__FIX.tasks[0];
        const seq = window.__FIX.sequences[0];
        const member = seq?.members?.[0];
        const created = await inv("create_block", { taskId: task.id, startAt: 4_000_000, endAt: 4_003_600 });
        const temp = await inv("create_temp_block", { startAt: 4_010_000, endAt: 4_013_600 });
        await inv("delete_block", { id: temp.block.id });
        if (member) await inv("remove_sequence_member", { sequenceId: seq.id, blockId: member.block_id });
        await settle(20);
        const after = { create: count("create"), delete: count("delete"), unlink: count("unlink") };
        const ok =
          after.create === before.create + 2 &&
          after.delete === before.delete + 1 &&
          after.unlink === before.unlink + (member ? 1 : 0);
        // 收尾：把造出来的块清掉、成员放回去
        const createdIds = new Set([created?.block?.id, temp?.block?.id].filter(Boolean));
        window.__FIX.blocks = window.__FIX.blocks.filter((b) => !createdIds.has(b.id));
        if (member && seq) seq.members.unshift(member);
        window.__DIAG.push(
          `r64.1⑤ create ${before.create}→${after.create} delete ${before.delete}→${after.delete} unlink ${before.unlink}→${after.unlink} 有成员=${!!member}`,
        );
        return ok;
      },
    ],

    // ===== round66（C12）：便携模式 —— 数据位置切换面板 + 计划任务置灰 =====
    [
      "round66 ①：⚙ 数据区「便携模式 / 数据位置…」→ 面板两卡对照（默认位置在用 / 另一边还没有数据）",
      async () => {
        await press("Escape");
        await openSettingsSub("data"); // round78：数据区进了「更多」折叠区
        const row = document.querySelector(".sanity-pop .portable-open");
        const stateShown = [...document.querySelectorAll(".sanity-pop .hint")].some((n) =>
          (n.textContent ?? "").includes("默认位置（便携模式：关）"),
        );
        row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const panel = document.querySelector("[data-data-switch]");
        if (!panel) return false;
        const cards = [...panel.querySelectorAll("[data-side]")];
        const labels = cards.map((c) => (c.querySelector(".who")?.textContent ?? "").trim());
        const hereChip = !!cards[0]?.querySelector(".chip.now");
        const otherEmpty = (cards[1]?.querySelector(".meta")?.textContent ?? "").includes("还没有数据");
        const otherDisabled = cards[1]?.querySelector("button.use")?.disabled === true;
        const useButtons = panel.querySelectorAll("button.use").length;
        panel.querySelector(".cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        const closed = !document.querySelector("[data-data-switch]");
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(
          `r66① 行=${!!row} 状态=${stateShown} 卡=${labels.join("/")} 在用=${hereChip} 另一边空=${otherEmpty} 禁用=${otherDisabled} 按钮=${useButtons} 关闭=${closed}`,
        );
        return (
          !!row &&
          stateShown &&
          labels.length === 2 &&
          hereChip &&
          otherEmpty &&
          otherDisabled &&
          useButtons === 2 &&
          closed
        );
      },
    ],
    [
      "round66 ②：切成便携 → 设置显示便携、计划任务置灰 + 说明；面板两边都有数据、「较新」只标一份、取消确认不生效",
      async () => {
        window.__SANITY_STATE.dataPortable = true;
        window.__SANITY_STATE.dataChoice = null;
        await press("Escape");
        await openSettingsSub("data"); // round78：数据区进了「更多」折叠区
        // 关掉重开 = 重读 dataMode（openPop 时拉一次）；round78：每次打开都回默认（折叠要重开）
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        await openSettingsSub("data");
        await openSettingsSub("scheduler");
        const portableShown = [...document.querySelectorAll(".sanity-pop .hint")].some((n) =>
          (n.textContent ?? "").includes("便携（应用文件夹里的 data\\）"),
        );
        const sched = document.querySelector(".sanity-pop .scheduler-box");
        const schedDisabled = sched?.disabled === true;
        const schedHint = [...document.querySelectorAll(".sanity-pop .hint")].some((n) =>
          (n.textContent ?? "").includes("便携模式下不可用"),
        );
        document.querySelector(".sanity-pop .portable-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const panel = document.querySelector("[data-data-switch]");
        const newerCount = panel?.querySelectorAll(".chip.newer").length ?? -1;
        const newerOnCurrent = !!panel?.querySelector('[data-side="current"] .chip.newer');
        const otherUsable = panel?.querySelector('[data-side="other"] button.use')?.disabled === false;
        // 走一遍「二次确认」但**取消**：应用内面板确实弹了（round80 · 79-01）+ 没写 choice
        const confirmBefore = window.__DIALOG_CONFIRM_CALLS || 0;
        panel?.querySelector('[data-side="other"] button.use')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        const asked = !!document.querySelector(".confirm-panel");
        document.querySelector(".confirm-cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const cancelled =
          asked && window.__SANITY_STATE.dataChoice === null && (window.__DIALOG_CONFIRM_CALLS || 0) === confirmBefore;
        panel?.querySelector(".cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__SANITY_STATE.dataPortable = false; // 还原默认态，后面的断言照常
        window.__DIAG.push(
          `r66② 便携文案=${portableShown} 计划禁用=${schedDisabled} 提示=${schedHint} 较新=${newerCount}@在用${newerOnCurrent} 另一边可用=${otherUsable} 确认弹过=${asked} 取消不写=${cancelled}`,
        );
        return (
          portableShown &&
          schedDisabled &&
          schedHint &&
          newerCount === 1 &&
          newerOnCurrent &&
          !!otherUsable &&
          cancelled
        );
      },
    ],
    [
      "round66 ③：说明页数据区有便携解释；功能开关总表 17 行（含全局快捷键）",
      async () => {
        await press("Escape");
        await openSettingsSub("guide"); // round78：说明页入口在「更多 → 引导与教程」
        document.querySelector(".sanity-pop .help-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const panel = document.querySelector(".help-panel");
        if (!panel) return false;
        const dataText = panel.querySelector("#help-data")?.textContent ?? "";
        const explained = dataText.includes("便携模式") && dataText.includes("before-switch");
        const rows = panel.querySelectorAll(".features tbody tr").length;
        const hasHotkeyRow = [...panel.querySelectorAll(".features tbody tr")].some((r) =>
          (r.textContent ?? "").includes("全局快捷键"),
        );
        panel.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(`r66③ 解释=${explained} 行数=${rows} 含全局=${hasHotkeyRow}`);
        return explained && rows === 17 && hasHotkeyRow;
      },
    ],
    [
      "round66 ④：功能开关展开 → 「全局快捷键」状态行显示实际键位；冲突时给原因 + 重试能刷新",
      async () => {
        await press("Escape");
        await openSettingsSub("features"); // round78：功能开关进了「更多」折叠区
        if (!document.querySelector(".feature-row")) {
          document
            .querySelector(".sanity-pop .features-toggle")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(10);
        }
        const stateText = () =>
          (document.querySelector(".sanity-pop [data-hotkey-state]")?.textContent ?? "").replace(/\s+/g, "");
        const ok1 = stateText().includes("当前：Win+Shift+W");
        // 冲突态：置错 → 关掉重开（openPop 重读）→ 应有原因 + 重试按钮
        window.__SANITY_STATE.hotkeyError =
          "Win+Shift+W：已经被别的程序注册了；Ctrl+Alt+W：已经被别的程序注册了；Ctrl+Alt+Shift+W：已经被别的程序注册了";
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        await openSettingsSub("features"); // round78：每次打开都回默认 —— 折叠要重开
        if (!document.querySelector(".feature-row")) {
          document
            .querySelector(".sanity-pop .features-toggle")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(10);
        }
        const retry = [...document.querySelectorAll(".sanity-pop .hotkey-state button")].find((b) =>
          (b.textContent ?? "").includes("重试"),
        );
        const ok2 = stateText().includes("没能注册上") && !!retry;
        // 重试前把假错的错清掉 → 点重试 → 状态刷新为「当前：Win+Shift+W」
        window.__SANITY_STATE.hotkeyError = null;
        retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const ok3 = stateText().includes("当前：Win+Shift+W");
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(`r66④ 默认=${ok1} 冲突态=${ok2} 重试后=${ok3}`);
        return ok1 && ok2 && ok3;
      },
    ],

    // ===== round67：模块化（Backlog 收起 / 隐藏周末 / 键位栏三态） =====
    [
      "round67 ①：Backlog 「«」收起 → 细轨（计数 + 时间轴变宽），写 backlog_pane=rail",
      async () => {
        await press("Escape");
        // 期望行数从假库现算（rail 计数读的是「未归档任务总数」，不受筛选/分组影响）
        const items = (window.__FIX?.tasks ?? []).filter((t) => t.archived_at == null).length;
        const leftBefore = Math.round(document.querySelector(".timeline").getBoundingClientRect().left);
        document
          .querySelector(".backlog .collapse")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const rail = document.querySelector(".backlog");
        const railOn = !!rail?.classList.contains("rail");
        const railW = rail ? Math.round(rail.getBoundingClientRect().width) : -1;
        const count = (rail?.querySelector(".rail-count")?.textContent ?? "").trim();
        const leftAfter = Math.round(document.querySelector(".timeline").getBoundingClientRect().left);
        const noSplitter = !document.querySelector(".splitter"); // B1#11：细轨态不显示分隔条
        const wrote =
          window.__LAST_SETTING?.[0] === "backlog_pane" && window.__LAST_SETTING?.[1] === "rail";
        window.__DIAG.push(
          `r67① 行=${items} 细轨=${railOn} 宽=${railW} 计数=${count} 分隔条无=${noSplitter} 写=${JSON.stringify(window.__LAST_SETTING)} 时间轴左=${leftBefore}→${leftAfter}`,
        );
        return (
          railOn &&
          railW <= 48 &&
          count === String(items) &&
          noSplitter &&
          wrote &&
          leftAfter < leftBefore
        );
      },
    ],
    [
      "round67 ②：细轨悬停不再弹覆层（你 2026-10-05：「临时展开把表挡住了」）",
      async () => {
        const rail = document.querySelector(".backlog.rail");
        if (!rail) return false;
        // 合成事件只能守「JS 又加回 hover 监听」这类回归；CSS `:hover` 回归由 CDP 真指针探针
        // 量「hover 前后时间轴左边缘」（见 preview.mjs 的 realRailExpandProbe）
        const leftBefore = Math.round(document.querySelector(".timeline").getBoundingClientRect().left);
        rail.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        await settle(10);
        const peek = !!document.querySelector(".backlog.rail.peek");
        const pane = document.querySelector(".backlog .pane");
        const paneHidden = !pane || getComputedStyle(pane).display === "none";
        const leftHover = Math.round(document.querySelector(".timeline").getBoundingClientRect().left);
        rail.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
        await settle(10);
        window.__DIAG.push(
          `r67② 悬停peek=${peek} 面板藏=${paneHidden} 时间轴左=${leftBefore}→${leftHover}`,
        );
        return !peek && paneHidden && leftBefore === leftHover;
      },
    ],
    [
      "round67 ③：细轨「»」展开 → 分隔条回来、栏宽恢复，写 backlog_pane=open",
      async () => {
        // round67.1：整条细轨可点（不再只有 24px 的 »）—— 点**条身**也要能展开
        const strip = document.querySelector(".backlog.rail .rail-strip");
        if (!strip) return false;
        strip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const b = document.querySelector(".backlog");
        const open = !!b && !b.classList.contains("rail");
        const width = b ? Math.round(b.getBoundingClientRect().width) : -1;
        const splitter = !!document.querySelector(".splitter");
        const wrote =
          window.__LAST_SETTING?.[0] === "backlog_pane" && window.__LAST_SETTING?.[1] === "open";
        window.__DIAG.push(
          `r67③ 展开=${open} 宽=${width} 分隔条=${splitter} 写=${JSON.stringify(window.__LAST_SETTING)}`,
        );
        return open && width >= 180 && splitter && wrote;
      },
    ],
    [
      "round67 ④：「整栏隐藏」已删（你 2026-10-05）—— 设置里没有这一档、收起后也没有「任务（N）」",
      async () => {
        await press("Escape");
        if (!document.querySelector(".sanity-pop")) {
          document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        }
        const segTexts = [...document.querySelectorAll(".sanity-pop button")].map((n) =>
          (n.textContent ?? "").trim(),
        );
        // 不能查 `.seg`（那个类随功能删了 → 空集 = 恒真）；查面板里**所有按钮**的文案，才有对象
        const noHiddenBtn = !segTexts.some((t) => t.includes("整栏隐藏"));
        const noStyleRow = ![...document.querySelectorAll(".sanity-pop .row")].some((n) =>
          (n.textContent ?? "").includes("任务栏收起样式"),
        );
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        // 收起 → 必须还是细轨（不能再「一整条不见」），且没有头部找回钮
        document
          .querySelector(".backlog .collapse")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const railOn = !!document.querySelector(".backlog.rail");
        const noRestore = !document.querySelector(".backlog-restore");
        const wrote = window.__LAST_SETTING?.[0] === "backlog_pane" && window.__LAST_SETTING?.[1] === "rail";
        // 展开回来（后面几条按 open 走）
        document
          .querySelector(".backlog.rail .rail-strip")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r67④ 无隐藏按钮=${noHiddenBtn} 无样式行=${noStyleRow} 细轨=${railOn} 无找回钮=${noRestore} 写=${JSON.stringify(window.__LAST_SETTING)}`,
        );
        return noHiddenBtn && noStyleRow && railOn && noRestore && wrote;
      },
    ],
    [
      "round67 ⑤：属性面板开着时点「«」→ 面板先关掉（不把浮层留在细轨里）",
      async () => {
        await press("Escape");
        document
          .querySelector(".backlog .props-toggle")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const openBefore = !!document.querySelector(".backlog .props");
        document
          .querySelector(".backlog .collapse")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const propsGone = !document.querySelector(".backlog .props");
        const railOn = !!document.querySelector(".backlog.rail");
        document
          .querySelector(".backlog .rail-strip")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(`r67⑤ 面板开=${openBefore} 关掉=${propsGone} 细轨=${railOn}`);
        return openBefore && propsGone && railOn;
      },
    ],
    [
      "round67 ⑥：关掉「显示周六、周日」→ 5 列 + 头部提示「还有 N 块」",
      async () => {
        await press("Escape");
        // 与时间轴同口径：与「周六 00:00 → 下周一 00:00」相交的块数（本地无夏令时）
        const from = lastWinFrom();
        const weekendStart = from + 5 * 86400;
        const weekendEnd = from + 7 * 86400;
        const expected = (window.__FIX?.blocks ?? []).filter(
          (b) => b.start_at < weekendEnd && b.end_at > weekendStart,
        ).length;
        if (!document.querySelector(".sanity-pop")) {
          document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        }
        const label = [...document.querySelectorAll(".sanity-pop label.row")].find((n) =>
          (n.textContent ?? "").includes("显示周六、周日"),
        );
        label
          ?.querySelector("input[type=checkbox]")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const wrote =
          window.__LAST_SETTING?.[0] === "weekend_hidden" && window.__LAST_SETTING?.[1] === "1";
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const dayCount = document.querySelectorAll(".day").length;
        const note = document.querySelector(".weekend-note");
        const noteText = (note?.textContent ?? "").replace(/\s+/g, "");
        // round67.1（你的第 6 条）：有内容才出现，且不再带「已隐藏周末」前缀
        const noteOk = expected > 0 ? noteText.includes(`周末还有${expected}块`) : !note;
        window.__DIAG.push(`r67⑥ 期望=${expected} 写=${wrote} 列=${dayCount} 提示=[${noteText}]`);
        return wrote && dayCount === 5 && noteOk;
      },
    ],
    [
      "round67 ⑦：隐藏周末时，跨周块在本周周一的尾巴照画（「上接」在），周末那两块不画",
      async () => {
        // 自造靶子块（一断言一块）：
        //  b67x = 上周日 23:00 → 本周一 05:00（跨周尾巴）
        //  b67f = 周五 10:00 → 11:00（纯周五；+1 天后**整块**落在隐藏的周六）
        const mk = (id, s, e) => ({
          id,
          task_id: "t2",
          start_at: s,
          end_at: e,
          layer: "elastic",
          status: "planned",
          last_notified_at: null,
          created_at: 0,
          external_source: null,
          final_status: null,
          postponed_from: null,
          label: null,
          is_temp: false,
          sanity_exempt: false,
        });
        window.__FIX.blocks.push(mk("b67x", at(-1, 23, 0), at(0, 5, 0)));
        window.__FIX.blocks.push(mk("b67f", at(4, 10, 0), at(4, 11, 0)));
        const flip = async (sel) => {
          document.querySelector(sel)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(30);
        };
        await flip(".week-nav button[title^='上一周']");
        await flip(".week-nav .now");
        const tailBox = document.querySelector('[data-block-id="b67x"]');
        const tail = !!tailBox;
        // `.cont-mark` 是 `[data-block-id]` 的**兄弟**（都住在 `.box` 里）—— 从父元素找
        const topMark = !!tailBox?.parentElement?.querySelector(".cont-mark.top");
        const b12 = !!document.querySelector('[data-block-id="b12"]'); // 周六 20:00
        const b13 = !!document.querySelector('[data-block-id="b13"]'); // 周日 21:00
        // 6b（P2-6）：拿起自造的纯周五块 → 挑到隐藏的周六 → 提示必须说「预览落在周末」
        const friCand = document.querySelector('[data-block-id="b67f"]');
        let previewOk = false;
        if (friCand) {
          await selectByClick("b67f");
          await press("Enter");
          await settle(10);
          await press("ArrowRight");
          await settle(20);
          previewOk = (document.querySelector(".weekend-note")?.textContent ?? "")
            .replace(/\s+/g, "")
            .includes("预览落在周末");
          await press("Escape"); // 放弃拿起（不写库）
          await settle(10);
        }
        // 清理：删掉自造块 + 再翻一次让界面与假库一致
        window.__FIX.blocks = window.__FIX.blocks.filter((b) => b.id !== "b67x" && b.id !== "b67f");
        await flip(".week-nav button[title^='上一周']");
        await flip(".week-nav .now");
        window.__DIAG.push(
          `r67⑦ 尾巴=${tail} 上接=${topMark} 周六块=${b12} 周日块=${b13} 周末预览=${previewOk}`,
        );
        return tail && topMark && !b12 && !b13 && !!friCand && previewOk;
      },
    ],
    [
      "round67 ⑧：点头部提示「显示」→ 7 列回来、写 weekend_hidden=0",
      async () => {
        const note = document.querySelector(".weekend-note");
        note?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const dayCount = document.querySelectorAll(".day").length;
        const gone = !document.querySelector(".weekend-note");
        const wrote =
          window.__LAST_SETTING?.[0] === "weekend_hidden" && window.__LAST_SETTING?.[1] === "0";
        window.__DIAG.push(`r67⑧ 列=${dayCount} 提示消失=${gone} 写=${JSON.stringify(window.__LAST_SETTING)}`);
        return dayCount === 7 && gone && wrote;
      },
    ],
    [
      "round67 ⑨：键位栏两档 —— hidden 不画 / always 常显；设置里只有两个选项（按需已删）",
      async () => {
        await press("Escape");
        const setMode = async (mode) => {
          if (!document.querySelector(".sanity-pop")) {
            document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await settle(20);
          }
          const sel = document.querySelector(".sanity-pop .hint-mode");
          if (!sel) return false;
          sel.value = mode;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          await settle(20);
          const wrote =
            window.__LAST_SETTING?.[0] === "hint_bar_mode" && window.__LAST_SETTING?.[1] === mode;
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(10);
          return wrote;
        };
        const barShown = () => {
          const bar = document.querySelector(".key-hint");
          return !!bar && getComputedStyle(bar).display !== "none";
        };
        // ① 选项只有两档（round67.1：你实测否掉「按需」）
        if (!document.querySelector(".sanity-pop")) {
          document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        }
        const options = [...document.querySelectorAll(".sanity-pop .hint-mode option")].map((o) => o.value);
        const twoOptions = options.length === 2 && options.includes("always") && options.includes("hidden");
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        // ② hidden：选中块也不画
        const wHidden = await setMode("hidden");
        const pick = [...document.querySelectorAll("[data-block-id]")].find((n) => {
          const r = n.getBoundingClientRect();
          return r.width > 10 && r.height > 10 && r.top > 64 && r.bottom < window.innerHeight - 8;
        });
        const selected = pick ? await selectByClick(pick.getAttribute("data-block-id")) : false;
        await settle(20);
        const hiddenOk = selected && !barShown();
        // ③ always：选中块 → 立刻常显
        const wAlways = await setMode("always");
        const alwaysOk = barShown();
        window.__DIAG.push(
          `r67⑨ 两档=${twoOptions}(${options.join("/")}) 写=${wHidden}/${wAlways} 选中=${selected} hidden态=${hiddenOk} 常显=${alwaysOk}`,
        );
        return twoOptions && wHidden && wAlways && hiddenOk && alwaysOk;
      },
    ],
    [
      "round67 ⑩：设置里写失败 → 周末开关 / 键位提示下拉拨回原值（BQ 口径）",
      async () => {
        await press("Escape");
        if (!document.querySelector(".sanity-pop")) {
          document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        }
        const label = [...document.querySelectorAll(".sanity-pop label.row")].find((n) =>
          (n.textContent ?? "").includes("显示周六、周日"),
        );
        const box = label?.querySelector("input[type=checkbox]");
        const select = document.querySelector(".sanity-pop .hint-mode");
        if (!box || !select) return false;
        // 勾选写失败 → 拨回原值
        const boxBefore = box.checked;
        window.__FAIL_SET_SETTING_ONCE = true;
        box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const boxBack = box.checked === boxBefore;
        // 下拉写失败 → 拨回原值
        const selectBefore = select.value;
        window.__FAIL_SET_SETTING_ONCE = true;
        select.value = selectBefore === "always" ? "hidden" : "always";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(30);
        const selectBack = select.value === selectBefore;
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(`r67⑩ 勾=${boxBefore}→回=${boxBack} 下拉=${selectBefore}→回=${selectBack}`);
        return boxBack && selectBack;
      },
    ],
    [
      "round67 ⑪：周末没有块时，隐藏周末不再挂任何提示（你 2026-10-05：「这个提示有什么必要吗」）",
      async () => {
        await press("Escape");
        // 前提：⑩ 的失败拨回后「显示周六、周日」仍是勾着的 —— 这里第一下必定是「隐藏」；cols 断言兜底
        const from = lastWinFrom();
        const wStart = from + 5 * 86400;
        const wEnd = from + 7 * 86400;
        const saved = (window.__FIX?.blocks ?? []).filter((b) => b.start_at < wEnd && b.end_at > wStart);
        const savedIds = new Set(saved.map((b) => b.id));
        window.__FIX.blocks = window.__FIX.blocks.filter((b) => !savedIds.has(b.id));
        const flip = async (sel) => {
          document.querySelector(sel)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(30);
        };
        await flip(".week-nav button[title^='上一周']");
        await flip(".week-nav .now");
        // 隐藏周末（设置勾选）
        const toggleWeekends = async () => {
          if (!document.querySelector(".sanity-pop")) {
            document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await settle(20);
          }
          const lab = [...document.querySelectorAll(".sanity-pop label.row")].find((n) =>
            (n.textContent ?? "").includes("显示周六、周日"),
          );
          lab?.querySelector("input[type=checkbox]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        };
        await toggleWeekends();
        const cols = document.querySelectorAll(".day").length;
        const chip = !!document.querySelector(".weekend-note");
        // 恢复：勾回来 + 块放回去 + 重拉
        await toggleWeekends();
        window.__FIX.blocks.push(...saved);
        await flip(".week-nav button[title^='上一周']");
        await flip(".week-nav .now");
        window.__DIAG.push(`r67⑪ 移走=${saved.length} 列=${cols} 提示=${chip}`);
        return saved.length > 0 && cols === 5 && !chip;
      },
    ],

    // ===== round68：成就（暗章）—— 设置区 / MAA 式列表 / 提示与 NEW / 信号 / 写失败 =====
    [
      "round68 ①：⚙ 有「成就（暗章）」区：默认开、已点亮 3/共 98、有「查看暗章」",
      async () => {
        await press("Escape");
        await openSettingsSub("achievements"); // round78：成就进了「更多」折叠区
        const pop = document.querySelector(".sanity-pop");
        if (!pop) return false;
        const row = [...pop.querySelectorAll("label.row")].find((n) =>
          (n.textContent ?? "").includes("启用成就"),
        );
        const text = pop.textContent ?? "";
        const count = text.includes("已点亮 3 / 共 98");
        const countLine = [...pop.querySelectorAll(".row")]
          .map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim())
          .find((t) => t.includes("已点亮"));
        const view = !!pop.querySelector(".ach-view");
        const checked = !!row?.querySelector("input[type=checkbox]")?.checked;
        window.__DIAG.push(`r68① 区=${!!row} 计数=${count} 行=[${countLine}] 按钮=${view} 默认开=${checked}`);
        return !!row && count && view && checked;
      },
    ],
    [
      "round68 ②：MAA 式列表 —— 未点亮 = ??? + 条件 + 12/100 进度条；已点亮（含隐藏档）显示名字",
      async () => {
        await openSettingsSub("achievements"); // round78：成就进了「更多」折叠区
        document.querySelector(".sanity-pop .ach-view")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const rows = [...document.querySelectorAll(".ach-panel .ach")];
        const ten = rows.find((n) => (n.querySelector(".cond")?.textContent ?? "").includes("完成 100 次"));
        const lockedName = (ten?.querySelector(".name")?.textContent ?? "").trim() === "???";
        const countText = (ten?.querySelector(".count")?.textContent ?? "").trim();
        const bar = ten?.querySelector(".progress .bar");
        const track = ten?.querySelector(".progress");
        const ratio =
          bar && track && track.getBoundingClientRect().width > 0
            ? bar.getBoundingClientRect().width / track.getBoundingClientRect().width
            : -1;
        const pctOk = Math.abs(ratio - 0.12) < 0.05;
        const names = rows.map((n) => (n.querySelector(".name")?.textContent ?? "").trim());
        const broke = names.includes("破土");
        const hiddenUnlocked = names.includes("计划有变");
        // B3 #11：面板不溢出（715px 那趟同一组也跑）
        const rect = document.querySelector(".ach-panel")?.getBoundingClientRect();
        const fits = !!rect && rect.left >= 0 && rect.right <= window.innerWidth + 1 && rect.width > 0;
        window.__DIAG.push(`r68② 行=${rows.length} 未点亮=${lockedName} 进度=${countText} 宽比=${ratio.toFixed(2)} 破土=${broke} 隐藏=${hiddenUnlocked} 不溢出=${fits}`);
        return rows.length >= 4 && lockedName && countText === "12/100" && pctOk && broke && hiddenUnlocked && fits;
      },
    ],
    [
      "round68 ③：点亮事件 → 短提示「🏅 暗章点亮」+ 面板 NEW + 新行出现",
      async () => {
        await settle(30);
        const msg = [...document.querySelectorAll(".toast")].some((n) =>
          (n.textContent ?? "").includes("🏅 暗章点亮：对暗号的人"),
        );
        const toastText = [...document.querySelectorAll(".toast")]
          .map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim())
          .join(" | ");
        const newChip = !!document.querySelector(".ach-panel .new");
        const appeared = [...document.querySelectorAll(".ach-panel .name")].some(
          (n) => (n.textContent ?? "").trim() === "对暗号的人",
        );
        window.__DIAG.push(`r68③ 提示=${msg} NEW=${newChip} 行=${appeared} 提示层=[${toastText}]`);
        return msg && newChip && appeared;
      },
    ],
    [
      "round68 ④：信号 —— 统计 / 连翻 4 周 / Ctrl+A / Enter 拿起 都报给后端",
      async () => {
        document.querySelector(".ach-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        await backToThisWeek();
        const signals = () => window.__ACH_SIGNALS || [];
        // 6b 复核（P1）：`__ACH_SIGNALS` 只累加不重置，更早分组可能提前打过同名信号 ——
        // 所以只断言「本次动作之后新增」的那一段，而不是整个数组
        const since = (n0, s) => signals().slice(n0).includes(s);
        let n0 = signals().length;
        await openStatsPanel();
        const stats = since(n0, "stats");
        await shutStats();
        n0 = signals().length;
        for (let i = 0; i < 4; i++) {
          document.querySelector(".week-nav button[title^='下一周']")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(8);
        }
        const jump = since(n0, "jump_weeks");
        await backToThisWeek();
        n0 = signals().length;
        await press("a", { ctrlKey: true });
        const all = since(n0, "select_all");
        n0 = signals().length;
        await selectByClick("b1");
        await press("Enter");
        await press("Escape");
        const grab = since(n0, "kbd_grab");
        window.__DIAG.push(`r68④ 统计=${stats} 翻周=${jump} 全选=${all} 拿起=${grab}`);
        return stats && jump && all && grab;
      },
    ],
    [
      "round68 ⑤：关掉成就 →「查看暗章」消失；写失败拨回（BQ 口径）",
      async () => {
        await openSettingsSub("achievements"); // round78：成就进了「更多」折叠区
        const toggle = () =>
          [...document.querySelectorAll(".sanity-pop label.row")]
            .find((n) => (n.textContent ?? "").includes("启用成就"))
            ?.querySelector("input[type=checkbox]");
        toggle()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const gone = !document.querySelector(".sanity-pop .ach-view");
        window.__FAIL_SET_SETTING_ONCE = true;
        toggle()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const backOff = !toggle()?.checked;
        toggle()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const onAgain = !!toggle()?.checked;
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(10);
        window.__DIAG.push(`r68⑤ 关掉消失=${gone} 写失败拨回=${backOff} 再开=${onAgain}`);
        return gone && backOff && onAgain;
      },
    ],
    // ===== round69（B3）：剪贴板手势（Ctrl+C / Ctrl+X 跟鼠标，左键放下）=====
    [
      "round69 ①：Ctrl+C 复制 —— 预览跟鼠标、左键放下得到新块（原块留着、新块入选中）",
      async () => {
        await backToThisWeek();
        await press("Escape");
        const picked = await selectByClick("b70");
        if (!picked) return false;
        await press("c", { ctrlKey: true });
        const followHint = gestureHintText();
        const p = atDay(1, 13, 0); // 周二 13:00（**窄窗口也在视野内**：715px 时只有周一…周三可见，指针在视口外会触发自动滚屏、落点会漂）
        firePointer("pointermove", p.x, p.y);
        await frames(2);
        firePointer("pointerdown", p.x, p.y); // 左键放下
        firePointer("pointerup", p.x, p.y);
        await settle(40);
        const copies = FIX.blocks.filter(
          (b) => b.task_id === "t22" && b.id !== "b70" && b.id !== "b71",
        );
        const landed = copies.find(
          (b) => b.start_at === at(1, 13, 0) && b.end_at === at(1, 13, 30),
        );
        const srcKept = blk("b70")?.start_at === at(2, 12, 0);
        const selectedAfter = [...document.querySelectorAll(".selected")].map(
          (n) => n.dataset.blockId,
        );
        window.__DIAG.push(
          `r69① 提示=${followHint.slice(0, 5)} 新块=${landed?.id ?? "-"} 源在=${srcKept} 选中=${selectedAfter.join("/")} 提示语=${toastText().slice(0, 12)}`,
        );
        return (
          followHint.includes("复制中") &&
          followHint.includes("左键放下") &&
          !!landed &&
          landed.status === "planned" &&
          landed.label === null &&
          srcKept &&
          copies.length === 1 &&
          selectedAfter.length === 1 &&
          selectedAfter[0] === landed.id &&
          toastText().includes("已复制")
        );
      },
    ],
    [
      "round69 ②：跟鼠标时点在板外不放、Esc 取消不留残影（块原地不动）",
      async () => {
        await press("Escape");
        const picked = await selectByClick("b70");
        if (!picked) return false;
        await press("x", { ctrlKey: true });
        const before = FIX.blocks.length;
        const p = atDay(1, 12, 0);
        firePointer("pointermove", p.x, p.y);
        await frames(2);
        // ① 贴在窗口最左缘（时间轴外、也不在 Backlog 的整行上）按一下：不算放下，继续跟
        firePointer("pointermove", 3, 400);
        await frames(2);
        firePointer("pointerdown", 3, 400);
        firePointer("pointerup", 3, 400);
        await settle(20);
        const stillFollowing = gestureHintText().includes("搬移中");
        // ② Esc（派发到 body —— 真实按键的 target 是 body；window 上的合成事件 capture 不优先，见盲点 ⑩）
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await settle(30);
        const src = blk("b70");
        const total = FIX.blocks.length;
        const noGhost = !document.querySelector(".drag-count");
        const hintGone = !gestureHintText().includes("搬移中");
        window.__DIAG.push(
          `r69② 继续跟=${stillFollowing} 原时=${src?.start_at === at(2, 12, 0)} 块数不变=${total === before} 无残影=${noGhost} 提示回位=${hintGone}`,
        );
        return (
          stillFollowing &&
          src?.start_at === at(2, 12, 0) &&
          total === before &&
          noGhost &&
          hintGone
        );
      },
    ],
    [
      "round69 ③：多选 Ctrl+C —— 整组跟鼠标、相对位置保持；新块成为选中",
      async () => {
        await press("Escape");
        // 锚点 = **最后点的那一块** —— 先选 b71、再 Ctrl+点 b70，让锚点落在 b70（周三）
        const first = await selectByClick("b71");
        const n70 = el("b70");
        if (!first || !n70) return false;
        const r = n70.getBoundingClientRect();
        n70.dispatchEvent(ptrEvent("pointerdown", r.left + 20, r.top + r.height / 2, { ctrlKey: true }));
        n70.dispatchEvent(ptrEvent("pointerup", r.left + 20, r.top + r.height / 2, { ctrlKey: true }));
        await settle(20);
        const bothSelected = document.querySelectorAll(".selected").length === 2;
        await press("c", { ctrlKey: true });
        const p = atDay(1, 14, 0); // 周二 14:00（窄窗口可见）→ 副本落 周二 14:00 + 周三 14:00
        firePointer("pointermove", p.x, p.y);
        await frames(2);
        firePointer("pointerdown", p.x, p.y);
        firePointer("pointerup", p.x, p.y);
        await settle(40);
        const fri = FIX.blocks.find(
          (b) => b.task_id === "t22" && b.start_at === at(1, 14, 0),
        );
        const sat = FIX.blocks.find(
          (b) => b.task_id === "t22" && b.start_at === at(2, 14, 0),
        );
        const names = [...document.querySelectorAll(".selected")].map(
          (n) => n.dataset.blockId,
        );
        window.__DIAG.push(
          `r69③ 双选=${bothSelected} 周二=${fri?.id ?? "-"} 周三=${sat?.id ?? "-"} 选中数=${names.length}`,
        );
        return (
          bothSelected &&
          !!fri &&
          !!sat &&
          fri.end_at - fri.start_at === 30 * 60 &&
          sat.end_at - sat.start_at === 30 * 60 &&
          names.length === 2 &&
          names.includes(fri.id) &&
          names.includes(sat.id)
        );
      },
    ],
    [
      "round69 ④：Ctrl+X 搬移 —— 用 **Enter** 落地（与左键同一条收尾）、块数不变、一步 Ctrl+Z 回退",
      async () => {
        await press("Escape");
        const picked = await selectByClick("b71");
        if (!picked) return false;
        const before = FIX.blocks.length;
        await press("x", { ctrlKey: true });
        const hint = gestureHintText();
        const p = atDay(1, 15, 0); // 周二 15:00（窄窗口可见）
        firePointer("pointermove", p.x, p.y);
        await frames(2);
        // 6b P1：跟鼠标时按 **Enter** = 落地（旧写法里这条路径被 `gestureBusy` 挡住、永远到不了）
        await press("Enter");
        await settle(40);
        const moved = blk("b71");
        const countSame = FIX.blocks.length === before;
        const moveToast = toastText().includes("已移动");
        await press("z", { ctrlKey: true });
        await settle(40);
        const back = blk("b71");
        // 收尾：undo 的视角跟随会滚到被改的块那一带，后面截图那下手势的靶子（b2）可能已在视野外 → 回到本周 + 默认视野
        await backToThisWeek();
        window.__DIAG.push(
          `r69④ 提示=${hint.slice(0, 4)} 落点=${moved?.start_at === at(1, 15, 0)} 块数不变=${countSame} 撤销=${back?.start_at === at(3, 12, 0)}`,
        );
        return (
          hint.includes("搬移中") &&
          moved?.start_at === at(1, 15, 0) &&
          countSame &&
          moveToast &&
          back?.start_at === at(3, 12, 0)
        );
      },
    ],
    [
      "round69 ⑤：Backlog ⚙ 里的重复表单 —— 加一条（周几/时刻/层可点切换）+ 暂停 + 删除",
      async () => {
        await press("Escape");
        await backToThisWeek();
        const row = await openPropsOf("复制靶子");
        if (!row) return false;
        const sec = row.querySelector(".prop.repeat");
        if (!sec) return false;
        const note = sec.querySelector(".repeat-note")?.textContent ?? "";
        // 周几 = 周一；时刻 08:15；层 → 必填（点击切换，不是下拉）
        const sel = sec.querySelector("select");
        sel.value = "0";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        const time = sec.querySelector("input.repeat-time");
        time.value = "08:15";
        time.dispatchEvent(new Event("input", { bubbles: true }));
        await settle(20);
        const layerBtn = sec.querySelector(".layer-toggle");
        // 6b P2：不依赖草稿的偶然初值 —— 先归到「弹性」再点一下，两边都真测到
        if (layerBtn.textContent.trim() !== "弹性") {
          layerBtn.click();
          await settle(10);
        }
        const layerBefore = layerBtn.textContent.trim();
        layerBtn.click();
        await settle(10);
        const layerAfter = layerBtn.textContent.trim();
        sec.querySelector(".repeat-add")?.click();
        await settle(40);
        const rule = FIX.repeats[0];
        const rowShown = sec.querySelector(".repeat-row")?.textContent?.replace(/\s+/g, "") ?? "";
        const wrote = !!rule && rule.weekday === 0 && rule.start_min === 8 * 60 + 15 && rule.layer === "required";
        // 暂停 → 行变 paused、按钮变「启用」
        sec.querySelector(".repeat-row .repeat-toggle")?.click();
        await settle(30);
        const paused = FIX.repeats[0]?.enabled === false;
        const pausedRow = !!sec.querySelector(".repeat-row.paused");
        const toggleText = sec.querySelector(".repeat-row .repeat-toggle")?.textContent?.trim();
        // 删除 → 规则没了
        sec.querySelector(".repeat-row .repeat-del")?.click();
        await settle(30);
        const gone = FIX.repeats.length === 0;
        const rowGone = !sec.querySelector(".repeat-row");
        window.__DIAG.push(
          `r69⑤ 区=${!!sec} 说明=${note.includes("预估")} 层=${layerBefore}→${layerAfter} 写入=${wrote} 行=[${rowShown.slice(0, 10)}] 暂停=${paused}/${pausedRow}/${toggleText} 删=${gone}/${rowGone}`,
        );
        return (
          note.includes("预估") &&
          layerBefore === "弹性" &&
          layerAfter === "必填" &&
          wrote &&
          rowShown.includes("每周一08:15") &&
          rowShown.includes("必填") &&
          paused &&
          pausedRow &&
          toggleText === "启用" &&
          gone &&
          rowGone
        );
      },
    ],
    [
      "round69 ⑥：每周重复生成 —— 打开下周就排上（🔁 标）、幂等；删掉后不再生成",
      async () => {
        await press("Escape");
        await backToThisWeek();
        const row = await openPropsOf("复制靶子");
        if (!row) return false;
        const sec = row.querySelector(".prop.repeat");
        if (!sec) return false;
        const sel = sec.querySelector("select");
        sel.value = "0"; // 每周一
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        const time = sec.querySelector("input.repeat-time");
        time.value = "07:00";
        time.dispatchEvent(new Event("input", { bubbles: true }));
        await settle(20);
        const layerBtn = sec.querySelector(".layer-toggle");
        if (layerBtn.textContent.trim() !== "必填") layerBtn.click();
        await settle(20);
        sec.querySelector(".repeat-add")?.click();
        await settle(40);
        const ruleOk = FIX.repeats.length === 1 && FIX.repeats[0].layer === "required";

        // 翻到**第 4 周** → reloadWeek → 生成（选远一点的周：前面那些组的断言会在下周/下下周挪块，
        // 有冲突时生成会跳过 —— 拿它的空档反而稳定）
        await gotoWeek(4);
        const hit = () => FIX.blocks.filter((b) => b.task_id === "t22" && b.start_at === at(28, 7, 0));
        const first = hit();
        const badge = document.querySelector('[data-repeat-note="每周一 07:00"]');
        const badgeText = badge ? getComputedStyle(badge).display !== "none" : false;
        // 幂等：来回翻两次还只有一块
        await gotoWeek(0);
        await gotoWeek(4);
        const idempotent = hit().length === 1;
        // 删掉生成的块 → 这周不再生成
        const genId = first[0]?.id;
        if (genId) {
          await selectByClick(genId);
          await press("Delete");
        }
        const gone = !FIX.blocks.some((b) => b.id === genId);
        await gotoWeek(0);
        await gotoWeek(4);
        const stayedGone = hit().length === 0;
        // 收尾：回本周、删规则（后面的截图/断言不受影响）
        await gotoWeek(0);
        const row2 = await openPropsOf("复制靶子");
        row2?.querySelector(".repeat-row .repeat-del")?.click();
        await settle(30);
        const cleaned = FIX.repeats.length === 0;
        window.__DIAG.push(
          `r69⑥ 规则=${ruleOk} 生成=${first.length} 标=[${badge?.getAttribute("data-repeat-note") ?? "-"}]/${badgeText} 幂等=${idempotent} 删=${gone} 不再生=${stayedGone} 收尾=${cleaned}`,
        );
        return (
          ruleOk &&
          first.length === 1 &&
          first[0].layer === "required" &&
          first[0].end_at - first[0].start_at === 30 * 60 && // 没填预估 → 30 分钟（与「拖任务出来」同口径）
          first[0].repeat_note === "每周一 07:00" &&
          !!badge &&
          badgeText &&
          idempotent &&
          gone &&
          stayedGone &&
          cleaned
        );
      },
    ],
    [
      "round69 ⑦：类别投入（对比开）—— 只算已完成、两侧并集、本周降序、未分类最后；差值对得上",
      async () => {
        seedR52();
        await gotoWeek(-1);
        if (!(await openReview())) return false;
        if (!(await ensureCompare(true, 1))) return false;
        if (!(await ensureMode("category"))) return false;
        // 对比数据（上周马赛克 + 曲线）是异步拉的 —— 等“并排图例”出现再读（否则 comparing 还是 false，段不渲染）
        for (let i = 0; i < 60 && !panel()?.querySelector(".pair-legend"); i++) await settle(30);
        // 独立复算（不调 store）：done 系状态 → 每类分钟
        const DONE = new Set(["done", "done_overtime", "done_short"]);
        const sumBy = (list, offset) => {
          const ws = weekStartOf(offset);
          const we = ws + 7 * 86400;
          const m = new Map();
          for (const b of list) {
            if (!DONE.has(stateOfBlock(b))) continue;
            const s = Math.max(b.start_at, ws); // 与面板同口径：跨周块只算本周那一段（6b P2）
            const e = Math.min(b.end_at, we);
            if (e <= s) continue;
            const name = categoryOfBlock(b);
            m.set(name, (m.get(name) ?? 0) + Math.round((e - s) / 60));
          }
          return m;
        };
        const cur = sumBy(weekBlocksOf(-1), -1);
        const prev = sumBy(weekBlocksOf(-2), -2);
        const want = [...new Set([...cur.keys(), ...prev.keys()])]
          .map((name) => ({ name, cur: cur.get(name) ?? 0, prev: prev.get(name) ?? 0 }))
          .sort((a, b) => {
            if (a.name === null && b.name !== null) return 1;
            if (b.name === null && a.name !== null) return -1;
            return (
              b.cur - a.cur ||
              b.prev - a.prev ||
              (a.name ?? "").localeCompare(b.name ?? "", "zh")
            );
          });
        const rows = [...panel().querySelectorAll(".cats .cat-row")].map((r) => ({
          name: r.getAttribute("data-category") || null,
          cur: Number(r.querySelector("[data-cur-minutes]")?.getAttribute("data-cur-minutes") ?? -1),
          prev: Number(
            r.querySelector("[data-prev-minutes]")?.getAttribute("data-prev-minutes") ?? -1,
          ),
          delta: Number(r.querySelector(".delta")?.getAttribute("data-delta-minutes") ?? NaN),
        }));
        const sameOrder =
          rows.length === want.length && rows.every((r, i) => r.name === want[i].name);
        const sameNums = rows.every(
          (r, i) => r.cur === want[i].cur && r.prev === want[i].prev && r.delta === want[i].cur - want[i].prev,
        );
        const hasData = rows.some((r) => r.cur > 0) && rows.some((r) => r.prev > 0);
        const name = (n) => n ?? "未分类";
        window.__DIAG.push(
          `r69⑦ 行=${rows.map((r) => `${name(r.name)}:${r.cur}/${r.prev}/${r.delta}`).join("|")} 期望=${want.map((w) => `${name(w.name)}:${w.cur}/${w.prev}`).join("|")}`,
        );
        return sameOrder && sameNums && hasData;
      },
    ],
    [
      "round69 ⑧：马赛克「按类别」对比 —— 按类别 key 配对（两周次序不同也各归各行），缺席侧画「—」",
      async () => {
        seedR52();
        await gotoWeek(-1);
        if (!(await openReview())) return false;
        if (!(await ensureCompare(true, 1))) return false;
        if (!(await ensureMode("category"))) return false;
        for (let i = 0; i < 60 && !panel()?.querySelector(".pair-legend"); i++) await settle(30);
        const countBy = (list) => {
          const m = new Map();
          for (const b of list) m.set(categoryOfBlock(b), (m.get(categoryOfBlock(b)) ?? 0) + 1);
          return m;
        };
        const cur = countBy(weekBlocksOf(-1));
        const prev = countBy(weekBlocksOf(-2));
        const names = [...new Set([...cur.keys(), ...prev.keys()])];
        const dom = mosaicRows().map((r) => ({
          head: rowText(r.querySelector(".head") ?? r).replace(/\s*\(\d+\)$/, ""),
          prev: r.querySelectorAll(".sub.prev .tile").length,
          cur: r.querySelectorAll(".sub.cur .tile").length,
          dashes: r.querySelectorAll(".sub .none").length,
        }));
        const match =
          dom.length === names.length &&
          dom.every((row) => {
            const key = row.head === "未分类" ? null : row.head;
            return (cur.get(key) ?? 0) === row.cur && (prev.get(key) ?? 0) === row.prev;
          });
        // 至少一行「只在其中一侧出现」——这是按 key 配对（不是按行序把上周抄一遍）的证据
        const asymmetric = dom.some(
          (row) => (row.cur === 0 && row.prev > 0) || (row.prev === 0 && row.cur > 0),
        );
        const pairedLegend = !!panel().querySelector(".pair-legend");
        const dashesOk = dom.every((row) => row.dashes === (row.cur === 0 ? 1 : 0) + (row.prev === 0 ? 1 : 0));
        window.__DIAG.push(
          `r69⑧ 行=${dom.map((r) => `${r.head}:${r.prev}/${r.cur}/${r.dashes}`).join("|")} 不对称=${asymmetric} 图例=${pairedLegend} 瓦片=${mosaicTiles().length} 调用=${JSON.stringify(window.__MOSAIC_DBG ?? [])} 库=[${weekBlocksOf(-1).length},${weekBlocksOf(-2).length}] 窗口=${lastWinFrom()}`,
        );
        await ensureMode("state");
        await shutReview();
        await gotoWeek(0); // 回本周收尾（后面的真输入探针/截图默认看本周）
        return match && asymmetric && pairedLegend && dashesOk;
      },
    ],
    [
      "round69 ⑨：局内键 C —— 快速加任务（细轨自动展开 + 光标进输入框；输入框里按 c 不劫持）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        // 先收成细轨（验「会自动展开」）
        if (!document.querySelector(".backlog.rail")) {
          document
            .querySelector(".backlog .collapse")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(40);
        }
        const railed = !!document.querySelector(".backlog.rail");
        // C 键（派发到 body —— 真实按键的 target 是 body，见盲点 ⑩）
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }),
        );
        await settle(50);
        const expanded = !document.querySelector(".backlog.rail");
        const input = document.querySelector(".new-task .field");
        const focused = !!input && document.activeElement === input;
        // 在输入框里按 c：不该被劫持（否则边打字边重聚焦）
        input?.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
        await settle(20);
        const notHijacked = document.activeElement === input;
        input?.blur();
        window.__DIAG.push(`r69⑨ 细轨=${railed} 展开=${expanded} 聚焦=${focused} 框内不劫持=${notHijacked}`);
        return railed && expanded && focused && notHijacked;
      },
    ],
    [
      "round69 ⑩：生成的冲突边界 —— 目标格已有块 → 跳过并记水位线（不叠加、不补）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        // ① 在 +4 周周一 07:00 摆一块（直接进假库：这条边界本来就不该靠 UI 造现场）
        const slot = at(28, 7, 0);
        const blockerTask = FIX.tasks.find((t) => t.title === "键盘靶子") ?? FIX.tasks[0];
        const blocker = B("r69blk", blockerTask.id, slot, slot + 3600, "elastic", "planned");
        FIX.blocks.push(blocker);
        // ② 给「理智靶子」加一条周一 07:00 的规则（与阻挡块重叠）
        const row = await openPropsOf("理智靶子");
        const sec = row?.querySelector(".prop.repeat");
        if (!sec) return false;
        const sel = sec.querySelector("select");
        sel.value = "0";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        const time = sec.querySelector("input.repeat-time");
        time.value = "07:00";
        time.dispatchEvent(new Event("input", { bubbles: true }));
        await settle(20);
        sec.querySelector(".repeat-add")?.click();
        await settle(40);
        const rule = FIX.repeats[0];
        // 只盯**目标那一周（+4）**：整库计数会把「逐步跳周时中间几周正常生成」也误判为叠加
        const beforePlus4 = weekBlocksOf(4).length;
        // ③ 翻过去 → 冲突 → 跳过并记水位线
        await gotoWeek(4);
        const key = rule ? `${rule.id}_${weekStartOf(4)}` : "";
        const skipped = FIX.repeatOcc[key] === "skipped";
        const noNew = weekBlocksOf(4).length === beforePlus4;
        const overlap = FIX.blocks.filter(
          (b) => b.id !== blocker.id && b.start_at < slot + 3600 && b.end_at > slot,
        ).length;
        const noOwnBlock = !FIX.blocks.some(
          (b) => b.task_id === rule?.task_id && b.start_at === slot,
        );
        // 收尾：回本周、删规则、把阻挡块拿走
        await gotoWeek(0);
        const row2 = await openPropsOf("理智靶子");
        row2?.querySelector(".repeat-row .repeat-del")?.click();
        await settle(30);
        FIX.blocks.splice(FIX.blocks.indexOf(blocker), 1);
        window.__DIAG.push(
          `r69⑩ 规则=${!!rule} 水位线=${FIX.repeatOcc[key] ?? "-"} 不新建=${noNew}（+4 周 ${beforePlus4}→${weekBlocksOf(4).length}）无块=${noOwnBlock} 叠加=${overlap}`,
        );
        return !!rule && skipped && noNew && noOwnBlock && overlap === 0;
      },
    ],
    // ===== round69.1（0.21.1 验收回修）：复制手势 / undo 卡死 / 每周重复 / 复盘类别视图 / 分类回车 / 拿起点击 =====
    [
      "round69.1 ①：Ctrl+C 跟鼠标时**原块照画**（预览是新的一份）；Esc 取消不留痕",
      async () => {
        await press("Escape");
        await backToThisWeek();
        await bringIntoView("b70");
        const picked = await selectByClick("b70");
        if (!picked) return false;
        const srcDay = dayIndexOfDom("b70");
        const before = document.querySelectorAll('[data-block-id="b70"]').length;
        const errBefore = (window.__DIAG || []).filter((d) => String(d).startsWith("页面错误")).length;
        await press("c", { ctrlKey: true });
        const p = atDay(5, 14, 0); // b70 在周三；拖到周六 14:00
        firePointer("pointermove", p.x, p.y);
        await frames(3);
        const inSrcDay = [...document.querySelectorAll('[data-block-id="b70"]')].filter(
          (n) => n.closest(".day-body") === dayBody(srcDay),
        ).length;
        const total = document.querySelectorAll('[data-block-id="b70"]').length;
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await settle(20);
        const afterEsc = document.querySelectorAll('[data-block-id="b70"]').length;
        // 6b P0：手势期间**不许**报页面错误 —— 旧写法（base 与预览同 id 两个盒子）会在
        // 按 Ctrl+C 那一下抛 `each_key_duplicate`（同列的 DOM 提交流产、预览画不出来）
        const errors =
          (window.__DIAG || []).filter((d) => String(d).startsWith("页面错误")).length - errBefore;
        window.__DIAG.push(
          `r69.1① 原列=${srcDay} 手势中原列块数=${inSrcDay} 同一 id 总盒数=${total}（前 ${before}）Esc 后=${afterEsc} 页面错误=${errors}`,
        );
        return (
          inSrcDay >= 1 &&
          total >= 2 &&
          afterEsc === before &&
          blk("b70")?.start_at === at(2, 12, 0) &&
          errors === 0
        );
      },
    ],
    [
      "round69.1 ②：复制落在同一格 → **就地融合成一块**（原块 id 不动）+ 提示说真话",
      async () => {
        await press("Escape");
        await backToThisWeek();
        await bringIntoView("b70");
        const origin = blk("b70");
        if (!origin) return false;
        const day = dayIndexOfDom("b70");
        const picked = await selectByClick("b70");
        if (!picked) return false;
        const countBefore = FIX.blocks.length;
        await press("c", { ctrlKey: true });
        const st = new Date(origin.start_at * 1000);
        const p = atDay(day, st.getHours(), st.getMinutes());
        firePointer("pointermove", p.x, p.y);
        await frames(2);
        firePointer("pointerdown", p.x, p.y);
        firePointer("pointerup", p.x, p.y);
        await settle(40);
        const survivor = blk("b70");
        const noNew = FIX.blocks.length === countBefore;
        const rawToast = toastText(); // 在撤销前抓一把（撤销的提示会把这一条挤掉/覆盖时序）
        const honest = rawToast.includes("融合");
        const originIntact = survivor?.start_at === at(2, 12, 0) && survivor?.end_at === at(2, 12, 30);
        // 撤销这次复制：撤得动（假后端的标签是「上一步操作」，只认「已撤销」这个动作）
        await press("z", { ctrlKey: true });
        await settle(30);
        const undone = toastText().includes("已撤销");
        window.__DIAG.push(
          `r69.1② 块数=${countBefore}→${FIX.blocks.length} 原块在=${!!survivor} 区间对=${originIntact} 融合提示=${honest} 撤销=${undone} 提示原文=[${rawToast.slice(0, 30)}]`,
        );
        return noNew && !!survivor && originIntact && honest && undone;
      },
    ],
    [
      "round69.1 ③：在 ⚙ 里加一条「本周还没到点」的规则 → **当周立刻排上**（不用翻走再回来）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        const slot = await gotoFreeWeekSlot();
        if (!slot) {
          window.__DIAG.push(`r69.1③ 四周内都没找到空闲时段（块数=${FIX.blocks.length}）`);
          return false;
        }
        const row = await openPropsOf("复制靶子");
        const sec = row?.querySelector(".prop.repeat");
        if (!sec) {
          window.__DIAG.push(`r69.1③ 重复表单没渲染 row=${!!row}`);
          return false;
        }
        // 先清掉可能残留的规则（前面的断言可能失败在网络中间）
        for (const del of [...sec.querySelectorAll(".repeat-row .repeat-del")]) {
          del.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        }
        const sel = sec.querySelector("select");
        sel.value = String(slot.d);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        const time = sec.querySelector("input.repeat-time");
        time.value = `${String(slot.h).padStart(2, "0")}:00`;
        time.dispatchEvent(new Event("input", { bubbles: true }));
        await settle(20);
        sec.querySelector(".repeat-add")?.click();
        await settle(60);
        await frames(2);
        const made = FIX.blocks.filter(
          (b) => b.task_id === "t22" && b.start_at === slot.at && !!b.repeat_note,
        );
        const badge = document.querySelector("[data-repeat-note]");
        window.__DIAG.push(
          `r69.1③ 周=+${slot.off} 时段=${slot.d}/${slot.h} 规则=${FIX.repeats.length} 生成=${made.length} 标=${badge?.getAttribute("data-repeat-note") ?? "-"}`,
        );
        return made.length === 1 && made[0].status === "planned" && !!badge;
      },
    ],
    [
      "round69.1 ④：暂停规则 → **未开始的生成块撤下**（水位线一起清）；Ctrl+Z → 块与水位线一起回来",
      async () => {
        await press("Escape");
        await backToThisWeek();
        const slot = await gotoFreeWeekSlot();
        if (!slot) {
          window.__DIAG.push(`r69.1④ 四周内都没找到空闲时段（块数=${FIX.blocks.length}）`);
          return false;
        }
        const row = await openPropsOf("复制靶子");
        const sec = row?.querySelector(".prop.repeat");
        if (!sec) {
          window.__DIAG.push(`r69.1④ 重复表单没渲染 row=${!!row}`);
          return false;
        }
        for (const del of [...sec.querySelectorAll(".repeat-row .repeat-del")]) {
          del.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        }
        const sel = sec.querySelector("select");
        sel.value = String(slot.d);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        const time = sec.querySelector("input.repeat-time");
        time.value = `${String(slot.h).padStart(2, "0")}:00`;
        time.dispatchEvent(new Event("input", { bubbles: true }));
        await settle(20);
        sec.querySelector(".repeat-add")?.click();
        await settle(60);
        await frames(2);
        const rule = FIX.repeats.find((r) => r.weekday === slot.d && r.start_min === slot.h * 60);
        const made = FIX.blocks.filter(
          (b) => b.task_id === "t22" && b.start_at === slot.at && !!b.repeat_note,
        );
        const occKey = rule ? `${rule.id}_${weekStartOf(slot.off)}` : "";
        const genOk = made.length === 1 && !!FIX.repeatOcc[occKey];
        // 暂停 → 未开始的块与水位线一起撤下，行变 paused
        sec.querySelector(".repeat-row .repeat-toggle")?.click();
        await settle(40);
        await frames(2);
        const gone = !FIX.blocks.some((b) => b.start_at === slot.at && b.task_id === "t22");
        const occGone = !FIX.repeatOcc[occKey];
        const pausedRow = !!sec.querySelector(".repeat-row.paused");
        // Ctrl+Z → 块与水位线一起回来
        await press("z", { ctrlKey: true });
        await settle(40);
        await frames(2);
        const back = FIX.blocks.some((b) => b.start_at === slot.at && b.task_id === "t22");
        const occBack = !!FIX.repeatOcc[occKey];
        window.__DIAG.push(
          `r69.1④ 生成=${genOk} 水位线=${FIX.repeatOcc[occKey] ?? "-"} 暂停后撤下=${gone}/${occGone}/${pausedRow} 撤销找回=${back}/${occBack}`,
        );
        return genOk && gone && occGone && pausedRow && back && occBack;
      },
    ],
    [
      "round69.1 ⑤：复盘「按类别」+ 对比（跨周块那周）→ 行照渲染、能切回「按状态」、页面 0 错误",
      async () => {
        await press("Escape");
        await backToThisWeek();
        const errBefore = (window.__DIAG || []).filter((d) => String(d).startsWith("页面错误")).length;
        if (!(await openReview())) return false;
        if (!(await ensureCompare(true, 1))) return false;
        const btn = panel().querySelector('.mode button[data-mode="category"]');
        btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const pressed = panel().querySelector('.mode button[aria-pressed="true"]')?.getAttribute("data-mode");
        const heads = mosaicRows().map((r) => rowText(r.querySelector(".head") ?? r));
        const dayHeads = heads.filter((t) => /^周[一二三四五六日]/.test(t)).length;
        const errors =
          (window.__DIAG || []).filter((d) => String(d).startsWith("页面错误")).length - errBefore;
        const back = await ensureMode("state");
        const backHeads = mosaicRows().map((r) => rowText(r.querySelector(".head") ?? r));
        const backOk = back && backHeads.length === 7 && backHeads.every((t) => /^周[一二三四五六日]/.test(t));
        await shutReview();
        window.__DIAG.push(
          `r69.1⑤ 按下=${pressed} 类别行=[${heads.join("|")}] 天行数=${dayHeads} 页面错误=${errors} 切回=${backOk}`,
        );
        return pressed === "category" && heads.length > 0 && dayHeads === 0 && errors === 0 && backOk;
      },
    ],
    [
      "round69.1 ⑥：分类框输入法回车 —— 组词中的回车不提交（不建拼音分类）；确认候选后再回车才建成",
      async () => {
        await press("Escape");
        await backToThisWeek();
        const row = await openPropsOf("写周报");
        if (!row) return false;
        row.querySelector(".props .clear-cat")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const field = row.querySelector(".props input.cat-input");
        if (!field) return false;
        field.focus();
        const r0 = field.getBoundingClientRect();
        field.dispatchEvent(ptrEvent("pointerdown", r0.left + 8, r0.top + r0.height / 2));
        await settle(20);
        const keyEv = (o) =>
          field.dispatchEvent(
            new KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, o)),
          );
        // ① 组词（拼音预编辑）
        field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        field.value = "zuoye";
        field.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: "zuoye", isComposing: true, inputType: "insertCompositionText" }),
        );
        await settle(5);
        // ② 回车确认候选（keydown 先于 compositionend，isComposing=true）
        keyEv({ key: "Enter", code: "Enter", keyCode: 229, which: 229, isComposing: true });
        await settle(5);
        const pinyinCat = FIX.tasks.some((t) => t.category === "zuoye");
        // ③ 输入法提交文本
        field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "作业" }));
        field.value = "作业";
        field.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: "作业", inputType: "insertCompositionText" }),
        );
        await settle(20);
        const shownMid = field.value;
        // ④ 真正的提交回车
        keyEv({ key: "Enter", code: "Enter", keyCode: 13, which: 13 });
        await settle(40);
        const built = FIX.tasks.find((t) => t.title === "写周报")?.category ?? null;
        const shown = field.value;
        row.querySelector(".props .clear-cat")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r69.1⑥ 拼音分类=${pinyinCat} 中途框=[${shownMid}] 建成=[${built}] 框=[${shown}]`,
        );
        return !pinyinCat && built === "作业" && shown === "作业";
      },
    ],
    [
      "round69.1 ⑦：拿起（Enter）中在时间轴上**点一下 = 落地**（落在预览当前的位置，不再「放弃拿起」）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        await bringIntoView("b70");
        const picked = await selectByClick("b70");
        if (!picked) return false;
        const before = blk("b70")?.start_at;
        await press("Enter"); // 拿起
        await press("ArrowUp"); // 预览上移 15 分钟
        await settle(20);
        const hint = gestureHintText();
        const p = atDay(2, 16, 0); // 周三 16:00 的空白（不是预览落点）
        firePointer("pointerdown", p.x, p.y);
        firePointer("pointerup", p.x, p.y);
        await settle(40);
        const now = blk("b70")?.start_at;
        const landedAtPreview = now === at(2, 11, 45);
        // 单块移动本身**不弹提示**（拖到哪就是反馈）——判据改成「手势收干净了」：
        // 预览只剩 1 个盒子 + 键位提示回到「未拿起」那套
        const boxes = document.querySelectorAll('[data-block-id="b70"]').length;
        const hintAfter = gestureHintText();
        window.__DIAG.push(
          `r69.1⑦ 提示=[${hint.slice(0, 3)}] 点前=${before} 点后=${now === at(2, 11, 45) ? "预览位" : (now === before ? "原位" : now)} 盒数=${boxes} 收尾提示=[${hintAfter.slice(0, 6)}]`,
        );
        return (
          hint.includes("拿起中") &&
          landedAtPreview &&
          boxes === 1 &&
          !hintAfter.includes("拿起中")
        );
      },
    ],
    [
      "round69.1 ⑧：一个分类都没有时，筛选菜单里**没有**「管理工作…」那一行（有分类时才有）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        const openMenu = async () => {
          document.querySelector(".cat-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(30);
        };
        await openMenu();
        const hadRow = !!document.querySelector(".cat-pop .row.mgr");
        // 走真实的管理页把每个分类清空（✎ → 空名字 → 回车 = 那堆任务回到「未分类」）
        for (let guard = 0; guard < 40; guard++) {
          // 每次都可能被 toast/滚动关掉 → 重新开并回到管理页
          if (!document.querySelector(".cat-pop")) await openMenu();
          const mgr = document.querySelector(".cat-pop .row.mgr");
          if (mgr && !document.querySelector(".cat-pop .mrow")) {
            mgr.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
            await settle(30);
          }
          const row = document.querySelector(".cat-pop .mrow");
          if (!row) break; // 没有分类可管了
          row.querySelector(".mbtn")?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
          await settle(30);
          const input = document.querySelector(".cat-pop .minput");
          if (!input) break;
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
          );
          await settle(50);
        }
        const mrowsLeft = document.querySelectorAll(".cat-pop .mrow").length;
        // 重开一次菜单：应只剩筛选行、且管理行消失
        if (!document.querySelector(".cat-pop")) await openMenu();
        const rows = [...document.querySelectorAll(".cat-pop .row")].map((n) => rowText(n));
        const noMgr = !document.querySelector(".cat-pop .row.mgr");
        const hasFilterRows = rows.length > 0;
        const noCatOption = rows.length === 2 && rows[0].startsWith("全部") && rows[1].startsWith("未分类");
        document.querySelector(".cat-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r69.1⑧ 有分类时管理行=${hadRow} 清完剩 mrow=${mrowsLeft} 现在行=[${rows.join("|")}] 无管理行=${noMgr}`,
        );
        return hadRow && mrowsLeft === 0 && noMgr && hasFilterRows && noCatOption;
      },
    ],
    [
      "round69.1 ⑨：天明细是周视图的配套 —— 「按类别」里不再出现（切回按状态就回来）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        if (!(await openReview())) return false;
        await ensureMode("state");
        const inState = !!panel()?.querySelector(".detail");
        panel()
          ?.querySelector('.mode button[data-mode="category"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const catMode = panel()?.querySelector('.mode button[aria-pressed="true"]')?.getAttribute("data-mode");
        const inCat = !!panel()?.querySelector(".detail");
        await ensureMode("state");
        await settle(20);
        const back = !!panel()?.querySelector(".detail");
        await shutReview();
        window.__DIAG.push(
          `r69.1⑨ 状态里明细=${inState} 类别里明细=${inCat}（模式=${catMode}）切回=${back}`,
        );
        return inState && catMode === "category" && !inCat && back;
      },
    ],
    [
      "round69.1 ⑩：占用柱按「max(预算, 最高那天)」画 —— 两边都超预算时高度仍能看出差（不再双双顶格）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        if (!(await openReview())) return false;
        // 把预算压到 60 分钟 → 「两边都超预算」必然出现（正是旧写法看不出差的那个现场）
        const savedBudget = sanityState.budget;
        sanityState.budget = 60;
        if (!(await ensureCompare(true, 1))) return false;
        for (let i = 0; i < 60 && !panel()?.querySelector(".pair-legend"); i++) await settle(30);
        const plot = panel()?.querySelector(".curve .plot");
        const rows = [...(plot?.querySelectorAll(".col") ?? [])].map((c) => {
          const cur = c.querySelector(".bar");
          const prev = c.querySelector(".pbar");
          const rc = cur?.getBoundingClientRect();
          const rp = prev?.getBoundingClientRect();
          return {
            cur: Number(cur?.getAttribute("data-minutes") ?? -1),
            prev: Number(prev?.getAttribute("data-prev-minutes") ?? -1),
            hc: rc ? Math.round(rc.height) : -1,
            hp: rp ? Math.round(rp.height) : -1,
          };
        });
        // 判据：两周值不同的那些天，柱高也必须不同（旧写法：都超预算 → 都顶格、高度相等 → 红）
        const capped = rows.filter((r) => r.cur !== r.prev && r.hc > 0 && Math.abs(r.hc - r.hp) < 2);
        const overPairs = rows.filter((r) => Math.max(r.cur, r.prev) > 60).length;
        const line = panel()?.querySelector(".budget-line")?.getBoundingClientRect();
        const plotRect = plot?.getBoundingClientRect();
        const lineBelowTop = !!line && !!plotRect && line.top > plotRect.top + 1;
        sanityState.budget = savedBudget;
        await shutReview();
        window.__DIAG.push(
          `r69.1⑩ 柱=${rows.map((r) => `${r.cur}/${r.prev}→${r.hc}/${r.hp}`).join(" ")} 同值不同高=${capped.length} 超预算对=${overPairs} 虚线离顶=${lineBelowTop}`,
        );
        return capped.length === 0 && overPairs > 0 && lineBelowTop;
      },
    ],
    [
      "round70 ①：分类保存**失败**时，框里回到原值、库里不动（在途值也要跟着撤）",
      async () => {
        // round70（DA 修复的失败面）：`commit()` 新增了 pending（在途值），失败分支要撤掉它并把框拉回。
        const prep = await prepareCatPicker();
        if (!prep) return false;
        const { box, task: t } = prep;
        const before = t.category ?? "";
        window.__FAIL_UPDATE_TASK_ONCE = true; // 让**这一次** update_task 失败（假后端里那个开关）
        await typeCat(box.field, "失败靶子");
        await enterCat(box.field);
        const db = t.category ?? "";
        const closed = !document.querySelector(".cat-pop");
        // 只读 DOM `.value` 测不出「在途值没撤」（失败分支里那句回写会把它盖成原值）——
        // 再开一次列表并关掉：`closeList` 会让 `shown` **重算**（在途值没撤时这里会露出「失败靶子」）。
        const again = await openCat(t.title);
        again?.field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await settle(20);
        const shown = again?.field?.value ?? box.field.value ?? "x";
        window.__DIAG.push(
          `r70① 原=${before || "（空）"} 库=${db || "（空）"} 框里=${shown || "（空）"} 列表已关=${closed} 重开过=${!!again}`,
        );
        // 收尾：关掉面板（别影响后面的截图手势）
        document.body.dispatchEvent(ptrEvent("pointerdown", 4, 4));
        await settle(20);
        return db === before && shown === before && closed && !!again;
      },
    ],
    [
      "round70 ②：在途提交还没落地时 prop 被外面改（点 × 清空）→ 框里不该留着在途值",
      async () => {
        // 覆盖 `$effect`「prop 一变就撤 pending」这条机制（修正：删掉那句全量断言仍全绿 = 零覆盖）。
        const prep = await prepareCatPicker();
        if (!prep) return false;
        let { box } = prep;
        const t = prep.task;
        // ① 先正常落一个分类（`×` 清空按钮只在 task.category 非空时出现）
        await typeCat(box.field, "在途甲");
        await enterCat(box.field);
        if ((t.category ?? "") !== "在途甲") return false;
        // ② 这次让写「在路上」400ms，然后不等它落地就再提交一次别的值
        window.__SLOW_UPDATE_TASK_ONCE = 400;
        box = (await openCat(t.title)) ?? box;
        await typeCat(box.field, "在途乙");
        await enterCat(box.field);
        await settle(20); // 只等微任务：400ms 那次写还没落库
        const inFlight = box.row.querySelector(".props input.cat-input")?.value ?? "x";
        // ③ 在途期间从**外面**把分类改掉（面板上的 × 清空）→ prop 变 null，输入框得跟着变空
        box.row
          .querySelector(".props .clear-cat")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const shown = box.row.querySelector(".props input.cat-input")?.value ?? "x";
        const dbNow = t.category ?? null;
        // 收尾：等那次慢写落地（别留给后面的探针 / 截图）
        await tick(600);
        const dbLast = t.category ?? null;
        window.__DIAG.push(
          `r70② 在途时框里=${inFlight} ×后框里=${shown || "（空）"} ×后库=${dbNow ?? "（空）"} 慢写落地后库=${dbLast ?? "（空）"}`,
        );
        return inFlight === "在途乙" && shown === "" && dbNow === null && dbLast === "在途乙";
      },
    ],
    // ===== round73（3.0b₁）：文案整改 + 外置（新文案上屏 / 旧文案不再出现 / 伪语言压力） =====
    [
      "round73 ①：新文案上屏（设置 title 列全分区 / 日头「周X」/ 把手 tooltip 没星号）",
      async () => {
        const gearTitle = document.querySelector(".sanity-gear")?.getAttribute("title") ?? "";
        // round78（3.1b₂）：设置重排成「5 组 + 更多」—— 齿轮 tooltip 列的是**新**分区名
        const titleOk =
          gearTitle.includes("主题与颜色") && gearTitle.includes("字号与密度") && gearTitle.includes("提醒与控制");
        const dayText = rowText(document.querySelector(".day-head .day-pick") ?? { textContent: "" });
        const dayOk = /周[一二三四五六日]/.test(dayText);
        const handleTitles = [...document.querySelectorAll(".resize.edge-bottom")]
          .map((el) => el.getAttribute("title") ?? "")
          .filter(Boolean);
        const handleOk =
          handleTitles.length > 0 &&
          handleTitles.every((t) => !t.includes("**")) &&
          handleTitles.some((t) => t.includes("下一列"));
        window.__DIAG.push(
          `r73① 设置title=[${gearTitle.slice(0, 30)}] 日头=[${dayText}] 把手×${handleTitles.length}=[${(handleTitles[0] ?? "").slice(0, 30)}]`,
        );
        return titleOk && dayOk && handleOk;
      },
    ],
    [
      "round73 ②：旧文案不再出现（全屏没有「任务栏」「漂移」「按类别」）",
      async () => {
        const text = rowText(document.body);
        const old = ["任务栏", "漂移", "按类别"].filter((w) => text.includes(w));
        window.__DIAG.push(`r73② 旧词残留=[${old.join(",")}]`);
        return old.length === 0;
      },
    ],
    [
      "round73 ③：E1 —— 已点亮的成就只显示描述，条件行只留给未点亮",
      async () => {
        await openSettingsSub("achievements"); // round78：成就进了「更多」折叠区
        document.querySelector(".sanity-pop .ach-view")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const lockedCond = document.querySelectorAll(".ach-panel .ach.locked .cond").length;
        const litCond = document.querySelectorAll(".ach-panel .ach:not(.locked) .cond").length;
        const litDesc = document.querySelectorAll(".ach-panel .ach:not(.locked) .desc").length;
        document.querySelector(".ach-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(`r73③ 未点亮条件行=${lockedCond} 已点亮条件行=${litCond} 已点亮描述行=${litDesc}`);
        return lockedCond > 0 && litCond === 0 && litDesc > 0;
      },
    ],
    [
      "round73p ①：伪语言 —— 界面文案被加工（【…———】）、用户数据不加工",
      async () => {
        if (!PSEUDO_ON) return { skip: true, why: "要 --pseudo 跑" };
        const gear = document.querySelector(".sanity-gear");
        const gearTitle = gear ? (window.__RAW_ATTR(gear, "title") ?? "") : "";
        const pseudoOk = gearTitle.startsWith("【") && gearTitle.endsWith("———】");
        const b1 = document.querySelector('[data-block-id="b1"]');
        const rawBlock = b1 ? window.__RAW_TEXT(b1) : "";
        const dataOk = rawBlock.length > 0 && !rawBlock.includes("【");
        window.__DIAG.push(`r73p① 设置title=[${gearTitle.slice(0, 24)}…${gearTitle.slice(-10)}] len=${gearTitle.length} pseudo=${pseudoOk} 块=[${rawBlock.slice(0, 24)}] len=${rawBlock.length}`);
        return pseudoOk && dataOk;
      },
    ],
    [
      "round73p ②：伪语言下关键容器不溢出（顶栏 / 设置面板 / 根元素）",
      async () => {
        if (!PSEUDO_ON) return { skip: true, why: "要 --pseudo 跑" };
        const over = (el) => (el ? el.scrollWidth - el.clientWidth : -1);
        const head = over(document.querySelector(".head"));
        const headKids = [...(document.querySelector(".head")?.children ?? [])]
          .map((el) => `${el.className || el.tagName}:${over(el)}`)
          .filter((s) => !s.endsWith(":0") && !s.endsWith(":-1"));
        const headEl = document.querySelector(".head");
        const headRight = headEl ? headEl.getBoundingClientRect().right : 0;
        const headBleed = [...(headEl?.children ?? [])]
          .map((el) => `${(el.className || el.tagName).toString().split(" ")[0]}:+${Math.round(el.getBoundingClientRect().right - headRight)}`)
          .filter((s) => !s.endsWith(":+0"));
        document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const pop = over(document.querySelector(".sanity-pop"));
        const root = over(document.documentElement);
        // 临时诊断（定位伪语言 715 的 73px 溢出）：列出右缘超出视口的元素
        const offenders = [...document.querySelectorAll("*")]
          .map((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.right > window.innerWidth + 1
              ? `${el.tagName}.${String(el.className).split(" ")[0]}:+${Math.round(r.right - window.innerWidth)}`
              : null;
          })
          .filter(Boolean)
          .slice(0, 8);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(`r73p② 溢出 顶栏=${head} 设置面板=${pop} 根=${root} 宽=${window.innerWidth} 顶栏子项=[${headKids.join(",")}] 出血=[${headBleed.join(",")}] 越界=[${offenders.join(",")}]`);
        return head >= 0 && head <= 2 && pop >= 0 && pop <= 2 && root <= 2;
      },
    ],
    [
      "round74 ①：通用横向溢出扫描（主屏 + 设置面板 + 四个覆盖面板；全元素 scrollWidth ≤ clientWidth + 2）",
      async () => {
        // 实现搬到了 fixture.js 的 `scanOverflow()`（round76：全矩阵与断言共用一份）
        const offenders = await scanOverflow();
        if (offenders.length) window.__DIAG.push(`r74① 溢出 ${offenders.length} 处：[${offenders.slice(0, 40).join(", ")}]`);
        return offenders.length === 0;
      },
    ],
    [
      "round74 ②：设置里切语言 —— 界面即时变英文（不重启），再切回中文",
      async () => {
        if (window.__LOCALE === "en") return { skip: true, why: "默认（中文）模式才跑" };
        document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click());
        await settle(20);
        document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const sel = document.querySelector(".sanity-pop select.lang");
        if (!sel) return false;
        const before = (document.querySelector(".review-open")?.textContent ?? "").trim();
        const cjk = /[\u4e00-\u9fff]/;
        sel.value = "en";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(30);
        const afterEn = (document.querySelector(".review-open")?.textContent ?? "").trim();
        const langEn = document.documentElement.lang;
        // round74（6b 二轮 P1）：**切语言前就挂载好**的块，tooltip 也得跟着变 ——
        // 模块/实例级 t() 捕获就会在这里露馅（TaskBlock 的 LAYER_LABEL 曾是这样）
        const titles = [...document.querySelectorAll("[data-block-id] .layer-bar[title]")]
          .map((el) => el.getAttribute("title") ?? "");
        const tooltipOk = titles.length > 0 && titles.every((x) => x.length > 0 && !cjk.test(x));
        sel.value = "zh";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(30);
        const afterZh = (document.querySelector(".review-open")?.textContent ?? "").trim();
        const titlesZh = [...document.querySelectorAll("[data-block-id] .layer-bar[title]")]
          .map((el) => el.getAttribute("title") ?? "");
        const tooltipBack = titlesZh.some((x) => cjk.test(x));
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(`r74② 前=[${before}] en=[${afterEn}] lang=${langEn} 回=[${afterZh}] 块tooltip英文=${tooltipOk} 回中文=${tooltipBack} 样本=[${titles[0] ?? ""}]`);
        return before.length > 0 && before === afterZh && afterEn.includes("Review") && langEn === "en" && tooltipOk && tooltipBack;
      },
    ],
    [
      "round74en ①：英文界面 —— 静态区域无中文残留 + 用户数据不被翻译 + html lang=en",
      async () => {
        if (window.__LOCALE !== "en") return { skip: true, why: "要 --locale en 跑" };
        document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click());
        await settle(20);
        document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const cjk = /[\u4e00-\u9fff]/;
        // 静态区域取文字：跳过用户数据（块 / Backlog 任务名 / 表单控件）
        const collect = (sel) => {
          const out = [];
          const walk = (node) => {
            for (const child of node.childNodes) {
              if (child.nodeType === 3) { out.push(child.nodeValue ?? ""); continue; }
              if (child.nodeType !== 1) continue;
              if (child.closest("[data-block-id]") || ["INPUT", "SELECT", "TEXTAREA"].includes(child.tagName)) continue;
              if (child.matches(".item .label, .item .label *")) continue; // Backlog 任务名（用户数据）
              walk(child);
            }
          };
          for (const el of document.querySelectorAll(sel)) walk(el);
          return out.join(" ").replace(/\s+/g, " ");
        };
        const pop = collect(".sanity-pop");
        const head = collect(".head");
        const bad = [];
        if (cjk.test(pop)) bad.push("设置:" + (pop.match(/[\u4e00-\u9fff]+/g) ?? []).slice(0, 3).join(","));
        if (cjk.test(head)) bad.push("顶栏:" + (head.match(/[\u4e00-\u9fff]+/g) ?? []).slice(0, 3).join(","));
        const reviewText = (document.querySelector(".review-open")?.textContent ?? "").trim();
        const lang = document.documentElement.lang;
        const blockText = [...document.querySelectorAll("[data-block-id]")].map((b) => b.textContent ?? "").join(" ");
        const dataKept = cjk.test(blockText);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(`r74en① 设置=[${pop.slice(0, 40)}] 顶栏=[${head.slice(0, 40)}] 总览=[${reviewText}] lang=${lang} 数据中文=${dataKept} 坏=[${bad.join("|")}]`);
        return bad.length === 0 && reviewText.includes("Review") && lang === "en" && dataKept;
      },
    ],

    // ===== round76（3.1a）：外观底座（token 三层 / 密度三档 / 三套配色 / 层条 / 类别条 / 现在线）=====
    [
      "round76 ①：默认档 = 舒适（data-density + 8 个尺寸/字号 token 实算值）",
      async () => {
        const root = document.documentElement;
        const css = (n) => getComputedStyle(root).getPropertyValue(n).trim();
        const want = densityExpect("comfortable");
        const bad = Object.entries(want)
          .filter(([k, v]) => css(k) !== v)
          .map(([k, v]) => `${k}=${css(k)}≠${v}`);
        window.__DIAG.push(`r76① density=${root.dataset.density} palette=${root.dataset.palette} 坏=[${bad.join(" ")}]`);
        return root.dataset.density === "comfortable" && root.dataset.palette === "warm" && bad.length === 0;
      },
    ],
    [
      "round76 ②：密度三档 —— 下拉一改，属性与 token 即时变（三档全对，切回舒适）",
      async () => {
        const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
        const bad = [];
        let before = null;
        for (const d of ["comfortable", "compact", "loose"]) {
          const ok = await pickAppearance(".text-density", d);
          const want = densityExpect(d);
          const got = { "--slot-height": css("--slot-height"), "--row-height": css("--row-height") };
          const live = document.documentElement.dataset.density;
          if (!ok || live !== d) bad.push(`${d}:属性=${live}`);
          for (const [k, v] of Object.entries(got)) if (v !== want[k]) bad.push(`${d}:${k}=${v}≠${want[k]}`);
          if (before === null) before = `${live}/${got["--slot-height"]}/${got["--row-height"]}`;
        }
        const back = await pickAppearance(".text-density", "comfortable");
        const backOk = back && document.documentElement.dataset.density === "comfortable";
        await closeSettings();
        window.__DIAG.push(`r76② 起点=${before} 坏=[${bad.join(" ")}] 回舒适=${backOk}`);
        return backOk && bad.length === 0;
      },
    ],
    [
      "round76 ③：配色三档 —— 属性变、页底颜色整套换，切回暖砂与原来一致",
      async () => {
        const root = document.documentElement;
        const bg = () => getComputedStyle(document.body).backgroundColor;
        const warm = bg();
        const ok1 = await pickAppearance(".ui-palette", "cool");
        const cool = bg();
        const ok2 = await pickAppearance(".ui-palette", "sage");
        const sage = bg();
        const ok3 = await pickAppearance(".ui-palette", "warm");
        const back = bg();
        await closeSettings();
        window.__DIAG.push(
          `r76③ warm=${warm} cool=${cool} sage=${sage} 回=${back} palette=${root.dataset.palette}`,
        );
        return (
          ok1 && ok2 && ok3 &&
          root.dataset.palette === "warm" &&
          cool !== warm && sage !== warm && sage !== cool && back === warm
        );
      },
    ],
    [
      "round76 ④：层条 4px + 弹性虚线；必填没有内描边、弹性块没有 45° 斜纹（重复信号已删）",
      async () => {
        // 只拿**计划中**的块：未完成块的 45° 斜纹是「残影」纹理，按设计保留（对照图 §4）
        const required = document.querySelector(".block.planned.layer-required");
        const elastic = document.querySelector(".block.planned.layer-elastic");
        if (!required || !elastic) return false;
        const bar = elastic.querySelector(".layer-bar");
        const barW = getComputedStyle(bar, "::before").width;
        const elaImg = getComputedStyle(bar, "::before").backgroundImage;
        const reqShadow = getComputedStyle(required).boxShadow;
        const elaFill = getComputedStyle(elastic).backgroundImage;
        window.__DIAG.push(
          `r76④ 条宽=${barW} 弹性条图=${elaImg.slice(0, 46)} 必填阴影=${reqShadow} 弹性底图=${elaFill}`,
        );
        return (
          barW === "4px" &&
          elaImg.includes("repeating-linear-gradient") &&
          reqShadow === "none" &&
          (elaFill === "none" || !elaFill.includes("45deg"))
        );
      },
    ],
    [
      "round76 ⑤：层条上色关掉 —— 那条**看不见**（颜色融入块底）、点它照样能切层（只管颜色不管功能）",
      async () => {
        const bars = () => document.querySelectorAll("[data-block-id] .layer-bar").length;
        const root = document.documentElement;
        const colored = getComputedStyle(root).getPropertyValue("--layer-required-bar").trim();
        const countBefore = bars();
        // **可见性判据**（round77 订正语义）：只看那一像素有没有颜色，不看它是什么色
        const barStyle = (cls) => {
          const b = document.querySelector(`.block.${cls} .layer-bar`);
          if (!b) return null;
          const st = getComputedStyle(b, "::before");
          return { bg: st.backgroundColor, img: st.backgroundImage, w: st.width };
        };
        // `rgba(0, 0, 0, 0)` = 透明；只要还剩任何 `rgb(`（且不是全 0 alpha）就算可见
        const gradVisible = (img) => {
          if (!img || img === "none") return false;
          return /rgba?\(\s*(?!0[\s,])\d/.test(img.replaceAll("rgba(0, 0, 0, 0)", ""));
        };
        const alpha0 = (c) => /^rgba?\(/.test(c) && /,\s*0\s*\)$/.test(c) || c === "transparent";
        const on = await toggleAppearance("input.layer-bar-color", false);
        const reqOff = barStyle("layer-required");
        const elaOff = barStyle("layer-elastic");
        const countOff = bars();
        // 功能不动：点左侧色条 -> 层切换（必填 ⇄ 弹性）
        const blk = document.querySelector(".block.layer-required");
        const id = blk?.dataset.blockId;
        const layerOf = () => {
          // 块根本身就带 data-block-id（不是它的子孙）
          const n = document.querySelector(`[data-block-id="${id}"]`);
          if (!n) return null;
          if (n.classList.contains("layer-elastic")) return "elastic";
          return n.classList.contains("layer-required") ? "required" : "?";
        };
        const layerBefore = layerOf();
        blk.querySelector(".layer-bar").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const layerAfter = layerOf();
        const back = await toggleAppearance("input.layer-bar-color", true);
        // 拨回后应该又有颜色（反向护栏：别把“关”写成永久）
        const reqOn = barStyle("layer-required");
        await closeSettings();
        const invisibleOff =
          !!reqOff && !!elaOff &&
          alpha0(reqOff.bg) && !gradVisible(reqOff.img) &&
          alpha0(elaOff.bg) && !gradVisible(elaOff.img);
        const visibleOn = !!reqOn && !alpha0(reqOn.bg);
        window.__DIAG.push(
          `r76⑤ 开=${on} 有色=${colored} 关·必填=${reqOff?.bg}/${reqOff?.img} 关·弹性=${elaOff?.bg}/${(elaOff?.img ?? "").slice(0, 40)} 条宽=${reqOff?.w} 条数=${countBefore}/${countOff} 层=${layerBefore}→${layerAfter} 拨回=${back} 拨回有色=${reqOn?.bg}`,
        );
        return (
          on && back &&
          countBefore === countOff && countBefore > 0 &&
          invisibleOff && visibleOn &&
          layerBefore === "required" && layerAfter === "elastic"
        );
      },
    ],
    [
      "round76 ⑥：分类底边条 —— 默认不画；打开后 2px 且颜色取自 --cat-N；关掉又不画",
      async () => {
        const bars = () => [...document.querySelectorAll(".cat-bar")];
        const offDefault = bars().length;
        const on = await toggleAppearance("input.category-bar", true);
        const shown = bars();
        const root = document.documentElement;
        const catColors = new Set(
          [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
            getComputedStyle(root).getPropertyValue(`--cat-${i}`).trim().toLowerCase(),
          ),
        );
        const toHex = (rgb) => {
          const m = rgb.match(/\d+/g);
          if (!m) return rgb;
          return "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
        };
        const heights = shown.map((n) => getComputedStyle(n).height);
        const colors = shown.map((n) => toHex(getComputedStyle(n).backgroundColor));
        const badColor = colors.filter((c) => !catColors.has(c));
        const okShape = heights.every((hv) => hv === "2px");
        const off = await toggleAppearance("input.category-bar", false);
        const afterOff = bars().length;
        await closeSettings();
        window.__DIAG.push(
          `r76⑥ 默认=${offDefault} 开=${on} 条数=${shown.length} 高=${heights[0] ?? "-"} 越界色=[${badColor.join(",")}] 关拔=${off} 关后=${afterOff}`,
        );
        return offDefault === 0 && on && shown.length > 0 && okShape && badColor.length === 0 && off && afterOff === 0;
      },
    ],
    [
      "round76 ⑦：块 tooltip 无条件补一行「分类：X」（颜色不是唯一通道）",
      async () => {
        const withCat = [...document.querySelectorAll("[data-block-id]")].find((n) => {
          const t = n.getAttribute("title") ?? "";
          return t.includes("分类：");
        });
        const sample = withCat?.getAttribute("title") ?? "";
        window.__DIAG.push(`r76⑦ title=[${sample.replace(/\n/g, " ⏎ ")}]`);
        return !!withCat && /分类：.+/.test(sample);
      },
    ],
    [
      "round76 ⑧：现在线 —— 今天列里有、位置 = 现在；别的周不画；悬停/点击不被它挡住",
      async () => {
        const line = document.querySelector(".day.today .now-line");
        if (!line) return false;
        const body = line.closest(".day-body");
        const y = line.getBoundingClientRect().top - body.getBoundingClientRect().top;
        const now = new Date();
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
        const secs = now.getTime() / 1000 - midnight;
        const expected = (secs / 1800) * slotH();
        const pe = getComputedStyle(line).pointerEvents;
        const r = line.getBoundingClientRect();
        const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 1));
        const passes = at !== line && !line.contains(at);
        // 别的周：线不画
        await gotoWeek(1);
        const onOtherWeek = !!document.querySelector(".now-line");
        await backToThisWeek();
        const backAgain = !!document.querySelector(".day.today .now-line");
        window.__DIAG.push(
          `r76⑧ y=${Math.round(y)} 期望=${Math.round(expected)} pe=${pe} 穿透=${passes} 别的周=${onOtherWeek} 回来=${backAgain}`,
        );
        return (
          Math.abs(y - expected) <= 3 && pe === "none" && passes && !onOtherWeek && backAgain
        );
      },
    ],
    [
      "round76 ⑨：今天那一列微高光（背景色 = 解析出来的 --today-tint，别的天 = 页底色）",
      async () => {
        // 6b P2：以前只验「今天 ≠ 别的天」——比标题松。现在把 token **解析成具体颜色**（塞进隐藏元素的 color）
        // 再与今天列背景逐字比；其它天应当等于 --bg。
        const probe = document.createElement("div");
        probe.style.position = "absolute";
        probe.style.opacity = "0";
        document.body.appendChild(probe);
        probe.style.color = "var(--today-tint)";
        const tint = getComputedStyle(probe).color;
        probe.style.color = "var(--bg)";
        const bg = getComputedStyle(probe).color;
        probe.remove();
        const today = getComputedStyle(document.querySelector(".day.today .day-body")).backgroundColor;
        const other = getComputedStyle(document.querySelector(".day:not(.today) .day-body")).backgroundColor;
        window.__DIAG.push(`r76⑨ tint=${tint} 今天=${today} ｜ bg=${bg} 其它=${other}`);
        return today === tint && other === bg && today !== other;
      },
    ],
    [
      "round76 ⑩：字下限 —— 块内名字/时间/刻度一律 ≥12px",
      async () => {
        const sizes = [
          ...document.querySelectorAll("[data-block-id] .name"),
          ...document.querySelectorAll("[data-block-id] .time"),
          ...document.querySelectorAll(".tick"),
        ].map((n) => parseFloat(getComputedStyle(n).fontSize));
        const small = sizes.filter((s) => s < 12);
        window.__DIAG.push(`r76⑩ 样本=${sizes.length} 最小=${sizes.length ? Math.min(...sizes) : "-"} 小于 12 的=${small.length}`);
        return sizes.length > 0 && small.length === 0;
      },
    ],
    [
      "round76 ⑪：外观写失败 —— 控件拨回原值（BQ / 边界表 #17 口径）",
      async () => {
        const group = await openAppearance(".text-density"); // round78：密度换成预览按钮组
        if (!group) return false;
        const before = document.documentElement.dataset.density;
        const other = before === "loose" ? "compact" : "loose";
        const btn = group.querySelector(`[data-value="${other}"]`);
        if (!btn) return false;
        window.__FAIL_SET_SETTING_ONCE = true;
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const onNow = group.querySelector(".density.on")?.getAttribute("data-value");
        const density = document.documentElement.dataset.density;
        await closeSettings();
        window.__DIAG.push(`r76⑪ 前=${before} 写失败后=${onNow} data-density=${density}`);
        return onNow === before && density === before;
      },
    ],
    // ===== round78（3.1b₂ · Step 1）：round77 验收带回的 5 条 =====
    [
      "round78 ②a：键位提示条不压头部文字、也不硬裁（715/737 两档都跑）",
      async () => {
        await seedRound78();
        setScrollHome();
        await clearSel();
        await settle();
        if (!(await selectByClick("r78a"))) return false;
        await frames(2);
        const rect = (sel) => {
          const n = document.querySelector(sel);
          if (!n) return null;
          const r = n.getBoundingClientRect();
          return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
        };
        const kh = rect(".key-hint");
        const range = rect(".timeline .range");
        const nav = rect(".week-nav");
        const acts = rect(".head-actions");
        if (!kh || !range) return false;
        const hit = (a, b) => !!a && !!b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
        const hits = [range, nav, acts].filter((x) => hit(kh, x)).length;
        const bar = document.querySelector(".key-hint");
        const clip = bar ? bar.scrollWidth - bar.clientWidth : -1;
        const items = [...document.querySelectorAll(".key-hint .kh-key, .key-hint .kh-act")];
        const inside =
          !!bar &&
          items.every((n) => {
            const r = n.getBoundingClientRect();
            const b = bar.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.left >= b.left - 1 && r.right <= b.right + 1;
          });
        const actsN = document.querySelectorAll(".key-hint .kh-act").length;
        const inView = !!bar && bar.getBoundingClientRect().right <= window.innerWidth + 1;
        window.__DIAG.push(
          "r78②a 宽=" + window.innerWidth +
            " 键位条=[" + [Math.round(kh.l), Math.round(kh.t), Math.round(kh.w), Math.round(kh.h)].join(",") + "]" +
            " 周范围=[" + [Math.round(range.l), Math.round(range.t), Math.round(range.w), Math.round(range.h)].join(",") + "]" +
            " 与头部行相交=" + hits + " 硬裁量=" + clip + " 项数=" + actsN + " 都在盒里=" + inside + " 在视口=" + inView,
        );
        await clearSel();
        await settle();
        const ok = hits === 0 && clip >= 0 && clip <= 1 && actsN >= 4 && inside && inView;
        await restoreRound78();
        // 不压行（不相交）· 不硬裁 · 四项都在 · 在视口内
        return ok;
      },
    ],
    [
      "round78 ③：顶部槽没内容就收起，有内容撑开；起手拖（按未选中的块）也不许挪时间轴",
      async () => {
        await seedRound78();
        setScrollHome();
        await clearSel();
        const dismissAll = async () => {
          for (let i = 0; i < 4; i++) {
            document
              .querySelectorAll(".hint-slot .sanity-dismiss, .hint-slot .nudge .close, .hint-slot .guide-bar .dismiss")
              .forEach((b) => b.dispatchEvent(new MouseEvent("click", { bubbles: true })));
            await settle();
          }
        };
        await dismissAll();
        const slotH = () => {
          const n = document.querySelector(".hint-slot");
          return n ? Math.round(n.getBoundingClientRect().height * 10) / 10 : -1;
        };
        const strip = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--strip-height"),
        );
        const emptySlot = slotH();
        const emptyHead = headHeight();
        // 有内容（选中块 → 键位提示）时应该撑开
        if (!(await selectByClick("r78a"))) return false;
        await frames(2);
        const busySlot = slotH();
        const khShown = !!document.querySelector(".key-hint");
        // ③b 风险路径：没选中的块上直接起手拖 —— 选中发生在 pointerdown，键位提示随之出现，
        //     槽会跟着撑开（**就是你施工单里接受的那一次高度变化**）；硬判据是**按下之后到移动**不许再变。
        //     悬停预占位方案已评估并否掉：那会让时间轴在每次悬停时弹一下（比按下时变一次更扰人），
        //     且窄窗那 2 行键位提示的高度本来也预占不准。
        await clearSel();
        await settle();
        const node = el("r78b");
        if (!node) return false;
        const hBefore = headHeight();
        const r = node.getBoundingClientRect();
        // 直接派发到块上（不用 elementFromPoint：窄窗下靶子块在屏幕外，firePointer 会落到 window 上、选中根本不会发生）
        node.dispatchEvent(ptrEvent("pointerdown", r.left + 18, r.top + Math.min(r.height / 2, 18)));
        await settle();
        await frames(2);
        const hDown = headHeight();
        const hDownKh = !!document.querySelector(".key-hint");
        const hDownSlot = slotH();
        const p = dragToDay(1, 13, 0);
        await settle();
        const hMove = headHeight();
        firePointer("pointercancel", p.x, p.y);
        await settle();
        await clearSel();
        await settle();
        window.__DIAG.push(
          "r78③ 空态槽高=" + emptySlot + " 空态头高=" + emptyHead + " 有内容槽高=" + busySlot +
            " 键位提示=" + khShown + " strip=" + strip +
            " 未选中起手 头高(前/按下/移动后)=" + hBefore + "/" + hDown + "/" + hMove +
            " 按下时键位提示=" + hDownKh + " 槽=" + hDownSlot,
        );
        const ok =
          emptySlot <= 2 &&
          busySlot >= strip - 0.5 &&
          khShown &&
          hBefore > 0 &&
          hDown >= hBefore &&
          hDown === hMove;
        await restoreRound78();
        return ok;
      },
    ],
    [
      "round78 ④：O / S 同键开合；选中块时 S 让位给块操作（不抢「往下」）",
      async () => {
        await seedRound78();
        await clearSel();
        await settle();
        const review = () => !!document.querySelector(".review-panel");
        const stats = () => !!document.querySelector(".stats-panel");
        const closeAll = async () => {
          for (let i = 0; i < 4; i++) {
            document.querySelectorAll(".review-panel .close, .stats-panel .close").forEach((b) =>
              b.dispatchEvent(new MouseEvent("click", { bubbles: true })),
            );
            await settle();
          }
        };
        await closeAll();
        if (review() || stats()) return false; // 前置：一个面板都不开
        // 1 选中块时 `S` = 「往下」(拉伸起点 +15 分钟),不该被统计抢走
        if (!(await selectByClick("r78a"))) return false;
        const b22 = () => FIX.blocks.find((b) => b.id === "r78a");
        const before = b22()?.start_at ?? -1;
        await press("s");
        await settle(20);
        const sHijack = stats();
        const after = b22()?.start_at ?? -1;
        await press("z", { ctrlKey: true }); // 撤销这一步拉伸（别给后面留脏状态）
        await settle(20);
        const undone = (b22()?.start_at ?? -1) === before;
        await clearSel();
        await settle();
        // ② O 同键开 / 关
        await press("o");
        await settle(20);
        const oOpen = review();
        await press("o");
        await settle(20);
        const oClosed = !review();
        // ③ S 同键开 / 关
        await press("s");
        await settle(20);
        const sOpen = stats();
        await press("s");
        await settle(20);
        const sClosed = !stats();
        // ④ round82（11.5 · Q12）：总览开着时 `S` = 开关**统计子层**（总览留住；再按一次只关子层）
        await press("o");
        await settle(30);
        await press("s");
        await settle(60);
        const sChild = stats();
        const oStill = review();
        await press("s");
        await settle(60);
        const sChildClosed = !stats();
        const oStill2 = review();
        await press("o");
        await settle(30);
        const oClosed2 = !review();
        await closeAll();
        window.__DIAG.push(
          "r78④ 选中S开统计=" + sHijack + " 起点位移=" + (after - before) + " 已撤销=" + undone +
            " O开=" + oOpen + " O同键关=" + oClosed + " S开=" + sOpen + " S同键关=" + sClosed +
            " O开着S=子层=" + (sChild && oStill) + " 再S只关子层=" + (sChildClosed && oStill2) +
            " （总览仍可关=" + oClosed2 + "）",
        );
        const ok =
          !sHijack &&
          after - before === 900 &&
          undone &&
          oOpen &&
          oClosed &&
          sOpen &&
          sClosed &&
          sChild &&
          oStill &&
          sChildClosed &&
          oStill2 &&
          oClosed2;
        await restoreRound78();
        return ok;
      },
    ],
    [
      "round78 栈：同级替换（开统计 → 总览自动关）/ 子层叠在设置上（关成就回到设置）/ Esc 一次只关一层",
      async () => {
        await seedRound78();
        const click = (sel) => {
          const n = document.querySelector(sel);
          if (!n) return false;
          n.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return true;
        };
        const open = (sel) => !!document.querySelector(sel);
        // 干净起点：Esc 几下 + 直接点关闭钮（都关不掉的极端情况不该有；关门按钮都在）
        for (let i = 0; i < 4; i++) {
          await press("Escape");
          document
            .querySelectorAll(
              ".review-panel .close, .stats-panel .close, .ach-panel .close, .help-panel .close, .data-panel .close, .sanity-pop .close, .tpl-pop .close",
            )
            .forEach((b) => b.dispatchEvent(new MouseEvent("click", { bubbles: true })));
          await settle();
        }
        // ① 同级替换：**总览功能关**时的顶栏统计（独立入口）→ 开设置 —— 统计必须自己关
        //    （round83 §8.1：独立统计入口只在总览功能关着时存在 —— 同级规则用「统计 ↔ 设置」这对来测）
        await setFeatureViaGear("一周总览", false);
        click(".head-actions .stats-open");
        await settle(30);
        const s1 = open(".stats-panel");
        click(".sanity-gear");
        await settle(30);
        const setOpen = open(".sanity-pop");
        const s2 = open(".stats-panel");
        await press("Escape");
        await settle(30);
        await setFeatureViaGear("一周总览", true);
        // ①b round82（11.5 · 案 C 子层）：总览里的统计入口 → 统计是**子层**（总览留住）→ Esc 只关统计
        await openReview();
        await settle(30);
        document
          .querySelector(".review-panel .stats-open")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const s3 = open(".stats-panel");
        const r2 = open(".review-panel");
        await press("Escape");
        await settle(30);
        const s4 = open(".stats-panel");
        const r3 = open(".review-panel");
        await press("Escape"); // 再把总览关掉（别给后面的用例留面板）
        await settle(30);
        // ③ 子层：设置 → 成就（设置留着）→ Esc 关成就 → 再 Esc 关设置
        await openSettingsSub("achievements"); // round78：成就入口在「更多」折叠区
        const set1 = open(".sanity-pop");
        click(".ach-view");
        await settle(40);
        const ach1 = open(".ach-panel");
        const set2 = open(".sanity-pop");
        await press("Escape");
        await settle(40);
        const ach2 = open(".ach-panel");
        const set3 = open(".sanity-pop");
        await press("Escape");
        await settle(40);
        const set4 = open(".sanity-pop");
        window.__DIAG.push(
          "r78栈 顶栏统计→设置替换=" + (s1 && setOpen && !s2) + "（统计开=" + s1 + " 设置开=" + setOpen + " 统计自动关=" + !s2 + "）" +
            " ｜ 总览里统计=子层=" + (s3 && r2) + " Esc 只关统计=" + (!s4 && r3) +
            " ｜ 设置开=" + set1 + " 成就开=" + ach1 + "（设置留住=" + set2 + "）" +
            " Esc 关成就=" + !ach2 + "（设置还在=" + set3 + "） 再 Esc 关设置=" + !set4,
        );
        const ok = s1 && setOpen && !s2 && s3 && r2 && !s4 && r3 && set1 && ach1 && set2 && !ach2 && set3 && !set4;
        await restoreRound78();
        return ok;
      },
    ],

    // ===== round78（3.1b₂ · 段 1）：设置页 IA 重排（设-01/02/03/05/09/10） =====
    [
      "round78 设-01：设置 = 覆盖面板（role/aria-modal/遮罩）+ 5 组导航；「更多」默认折起（子区不在 DOM）",
      async () => {
        await press("Escape");
        await press("Escape");
        document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const pop = document.querySelector(".sanity-pop");
        if (!pop) return false;
        const dialogOk =
          pop.getAttribute("role") === "dialog" &&
          pop.getAttribute("aria-modal") === "true" &&
          !!pop.getAttribute("aria-labelledby") &&
          !!document.querySelector(".settings-backdrop");
        const navs = [...pop.querySelectorAll(".nav-btn")].map((n) => (n.textContent ?? "").trim());
        const wantGroups = ["主题与颜色", "字号与密度", "时间轴", "提醒与控制", "更多"];
        const groupsOk = JSON.stringify(navs) === JSON.stringify(wantGroups);
        const groupIds = [...pop.querySelectorAll(".group")].map((g) => g.id);
        const idsOk = JSON.stringify(groupIds) ===
          JSON.stringify(["settings-group-theme", "settings-group-density", "settings-group-timeline", "settings-group-alert", "settings-group-more"]);
        // 「更多」默认收起：子区折叠钮和内容都不该在 DOM 里
        const moreOpen = pop.querySelector(".more-toggle")?.getAttribute("aria-expanded") === "true";
        const subClosed = pop.querySelectorAll(".sub-toggle").length === 0 && !pop.querySelector(".feature-row");
        // 默认展开的四个组：控件都在
        const open4 =
          !!pop.querySelector(".ui-palette .palette") &&
          !!pop.querySelector(".text-density .density") &&
          !!pop.querySelector(".block-second-line") &&
          !!pop.querySelector(".remind-action");
        // 导航跳转：点最后一组 → 正文滚下去（不是停在顶部）
        pop.querySelector(".nav-btn[data-group='more']")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const scrolled = (pop.querySelector(".pop-body")?.scrollTop ?? 0) > 0;
        // 展开「更多」→ 子区出现（round80 · 序-05：「更多」六块：数据 / 功能开关 / 计划任务 / 理智值 / 成就 / 引导；键位说明已移出）
        pop.querySelector(".more-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const subs = [...pop.querySelectorAll(".sub-toggle")].map((b) => b.className.replace(/^.*sub-toggle\s*/, "").trim());
        const needSubs = ["sanity-toggle", "scheduler-toggle", "data-toggle", "features-toggle", "guide-toggle"];
        const subsOk = needSubs.every((c) => pop.querySelector(`.${c}`));
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r78设① 弹窗契约=${dialogOk} 导航=[${navs.join("/")}] 组id=${idsOk} 更多默认折=${!moreOpen && subClosed} 四组控件在=${open4} 跳转滚=${scrolled} 子区=${subs.length}[${subs.join(",")}] 齐=${subsOk}`,
        );
        return dialogOk && groupsOk && idsOk && !moreOpen && subClosed && open4 && scrolled && subsOk;
      },
    ],
    [
      "round78 设-05：说明页入口只剩「更多 → 引导与教程」一处（顶部那个 ⓘ 已删）",
      async () => {
        await press("Escape");
        await openSettingsSub(); // 只开面板（不动折叠）
        const pop = document.querySelector(".sanity-pop");
        if (!pop) return false;
        const topGone = !pop.querySelector(".help-open"); // 折叠着 → 整张表里没有这个入口
        await openSettingsSub("guide");
        const inGuide = !!pop.querySelector(".guide-actions .help-open");
        const buttons = [...pop.querySelectorAll(".guide-actions .gf")].map((b) => (b.textContent ?? "").trim());
        const three = buttons.length === 3;
        // 点开说明页 → 面板栈子层（关掉回设置）
        pop.querySelector(".guide-actions .help-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const helped = !!document.querySelector(".help-panel");
        document.querySelector(".help-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const backToSettings = !!document.querySelector(".sanity-pop");
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r78设⑤ 顶部入口已删=${topGone} 引导里有=${inGuide} 三个按钮=${three}[${buttons.join("/")}] 说明页开=${helped} 回来=${backToSettings}`,
        );
        return topGone && inGuide && three && helped && backToSettings;
      },
    ],
    [
      "round78 设-02：三处预览选择器 —— 配色 = 12 份迷你小样（亮/暗各一）/ 图标 5×6 枚真 SVG / 密度三卡行高递增且选中态跟 prefs",
      async () => {
        await press("Escape");
        await openSettingsSub();
        const pop = document.querySelector(".sanity-pop");
        if (!pop) return false;
        const palettes = [...pop.querySelectorAll(".ui-palette .palette")];
        // round80（79-02）：配色不再看「三格色块」，看「迷你界面小样」——每份亮/暗两片、只显当前主题那片
        const thumbOk =
          palettes.length === 12 &&
          palettes.every((b) => b.querySelectorAll(".thumb .art").length === 2) &&
          palettes.every(
            (b) => [...b.querySelectorAll(".thumb .art")].filter((a) => getComputedStyle(a).display !== "none").length === 1,
          );
        // 三套小样的强调色互不相同（不能是同一套抄三遍）
        const sig = (b) => {
          const a = [...b.querySelectorAll(".thumb .art")].find((x) => getComputedStyle(x).display !== "none");
          return getComputedStyle(a.querySelector(".main .blk b")).backgroundColor;
        };
        const sigs = new Set(palettes.map(sig));
        const distinct = sigs.size === 12;
        const paletteOn = palettes.find((b) => b.classList.contains("on"))?.getAttribute("data-value");
        const icons = [...pop.querySelectorAll(".icon-set .icon-set-btn")];
        const iconsOk =
          icons.length === 5 && icons.every((b) => b.querySelectorAll("svg").length === 6);
        const iconOn = icons.find((b) => b.classList.contains("on"))?.getAttribute("data-value");
        const cardH = (v) => pop.querySelector(`.text-density [data-value="${v}"] .dsample`)?.getBoundingClientRect().height ?? -1;
        const hCompact = cardH("compact");
        const hComfort = cardH("comfortable");
        const hLoose = cardH("loose");
        const monotonic = hCompact > 0 && hCompact < hComfort && hComfort < hLoose;
        const densityOn = pop.querySelector(".text-density .density.on")?.getAttribute("data-value");
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r78设② 小样=${palettes.length} 亮/暗两片=${thumbOk} 12 套强调色不同=${distinct} 选中=${paletteOn} 图标=${icons.length}×${icons[0]?.querySelectorAll("svg").length ?? 0} 选中=${iconOn} 密度=${hCompact}/${hComfort}/${hLoose} 递增=${monotonic} 选中=${densityOn}`,
        );
        return thumbOk && distinct && iconsOk && monotonic && !!paletteOn && !!iconOn && !!densityOn;
      },
    ],
    [
      "round78 设-01：现在线开关 —— 关掉今天那条线不见、开回来（默认开 = 旧行为；写键 now_line）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        await settle(30);
        const lineCount = () => document.querySelectorAll(".day.today .now-line").length;
        const before = lineCount();
        await openSettingsSub();
        const box = document.querySelector(".sanity-pop .now-line");
        if (!box) return false;
        const wasOn = box.checked;
        box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const wroteOff = window.__LAST_SETTING?.[0] === "now_line" && window.__LAST_SETTING?.[1] === "0";
        const off = lineCount();
        document.querySelector(".sanity-pop .now-line")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const wroteOn = window.__LAST_SETTING?.[0] === "now_line" && window.__LAST_SETTING?.[1] === "1";
        const back = lineCount();
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r78设④ 默认开=${wasOn} 起点线=${before} 关写=${wroteOff} 关后线=${off} 开写=${wroteOn} 回来线=${back}`,
        );
        return wasOn && before === 1 && wroteOff && off === 0 && wroteOn && back === 1;
      },
    ],

    // ===== round78（3.1b₂ · 段 2）：快捷键（`键-02/03/04/07`） =====
    [
      "round78 键①：? 开合快捷键总表 + 叠在设置上（子层：Esc 一层一层退）；设置里的入口也能开",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const keysOpen = () => !!document.querySelector(".keymap-panel");
        const rows = () => document.querySelectorAll(".keymap-panel .keys tr").length;
        // ① 时间轴上按 ? → 开（表是同一份数据：行数 > 40）
        await press("?");
        await settle(40);
        const open1 = keysOpen();
        const rowCount = rows();
        const inPanel = !!document.activeElement?.closest?.(".keymap-panel");
        // ② 再按一次 ? → 关（同键开合）
        await press("?");
        await settle(30);
        const closed = !keysOpen();
        // ③ 设置 → ? → 子层叠在上面（设置留住）
        await openSettingsSub();
        await press("?");
        await settle(40);
        const both = keysOpen() && !!document.querySelector(".sanity-pop");
        // ④ Esc 关栈顶（?），设置还在；再 Esc 关设置
        await press("Escape");
        await settle(40);
        const afterEsc1 = !keysOpen() && !!document.querySelector(".sanity-pop");
        await press("Escape");
        await settle(30);
        const afterEsc2 = !document.querySelector(".sanity-pop") && !keysOpen();
        // ⑤ 设置里「键位说明」的入口按钮也能开（与 ? 同一份表）
        await openSettingsSub();
        document.querySelector(".sanity-pop .keymap-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const viaButton = keysOpen() && !!document.querySelector(".sanity-pop");
        document.querySelector(".keymap-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r78键① 开=${open1} 行=${rowCount} 焦点在面板=${inPanel} 同键关=${closed} 叠设置=${both} Esc1=${afterEsc1} Esc2=${afterEsc2} 入口钮=${viaButton}`,
        );
        return open1 && rowCount > 40 && inPanel && closed && both && afterEsc1 && afterEsc2 && viaButton;
      },
    ],
    [
      "round78 键②：T 回到本周（有选中块时不抢）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        await settle(30);
        const week = () => document.querySelector(".timeline .range")?.textContent?.trim() ?? "";
        const here = week();
        await gotoWeek(1);
        await settle(30);
        const away = week();
        await press("t");
        await settle(40);
        const jumped = week() === here && away !== here;
        // 选中一块 → T 不抢（既不跳周、也不碰选中）
        const sel = await selectByClick("b22");
        await press("t");
        await settle(30);
        const kept = week() === here && (sel ? !!document.querySelector(".block.selected") : true);
        await clearSel();
        window.__DIAG.push(`r78键② 这一周=[${here}] 别周=[${away}] T 跳回=${jumped} 选中时不抢=${kept}`);
        return jumped && kept;
      },
    ],
    [
      "round78 键③：Ctrl+, 打开设置（平台惯例；面板栈同级）",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(20);
        const before = !!document.querySelector(".sanity-pop");
        await press(",", { ctrlKey: true });
        await settle(40);
        const after = !!document.querySelector(".sanity-pop");
        const nav = document.querySelectorAll(".sanity-pop .nav-btn").length;
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(`r78键③ 前=${before} 后=${after} 导航=${nav}`);
        return !before && after && nav === 5;
      },
    ],
    [
      "round78 键④：关掉「键盘快捷键」→ C/O/S/T/? 全失效（WCAG 2.1.4）；开回来恢复",
      async () => {
        await press("Escape");
        await press("Escape");
        await openSettingsSub();
        const box = document.querySelector(".sanity-pop .keyboard-switch");
        if (!box) return false;
        if (box.checked) box.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 关
        await settle(40);
        const offWrote =
          window.__LAST_SETTING?.[0] === "keyboard_enabled" && window.__LAST_SETTING?.[1] === "0";
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        await backToThisWeek();
        const week = () => document.querySelector(".timeline .range")?.textContent?.trim() ?? "";
        const here = week();
        await press("?");
        const kQ = !document.querySelector(".keymap-panel");
        await press("o");
        const kO = !document.querySelector(".review-panel");
        await press("c");
        await settle(20);
        const kC = document.activeElement?.closest?.(".new-task") == null;
        await gotoWeek(1);
        await settle(30);
        await press("t");
        await settle(30);
        const kT = week() !== here;
        await backToThisWeek();
        // 开回来 → ? 与 O 恢复（至少两例，证明开关是双向的）
        await openSettingsSub();
        document.querySelector(".sanity-pop .keyboard-switch")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const onWrote =
          window.__LAST_SETTING?.[0] === "keyboard_enabled" && window.__LAST_SETTING?.[1] === "1";
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        await press("?");
        await settle(30);
        const backQ = !!document.querySelector(".keymap-panel");
        await press("?");
        await settle(20);
        await press("o");
        await settle(30);
        const backO = !!document.querySelector(".review-panel");
        await press("Escape");
        await settle(20);
        window.__DIAG.push(
          `r78键④ 关写=${offWrote} ?失效=${kQ} O失效=${kO} C失效=${kC} T失效=${kT} 开写=${onWrote} 恢复?=${backQ} 恢复O=${backO}`,
        );
        return offWrote && kQ && kO && kC && kT && onWrote && backQ && backO;
      },
    ],

    // ===== round78（3.1b₂ · 段 2）：空态与教程（`教-01/02/03/11`） =====
    [
      "round78 教①：Backlog 空库空态 —— 一句话 + 「写第一件事」把光标送进输入框（用完完整还原）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        await settle(30);
        const itemCount = () => document.querySelectorAll(".list .item").length;
        /** round79（6b 二轮 P1）：块状态签名 —— 只看 Backlog 行数对「块级变化」不敏感，
         *  收尾必须拿它验「那一刀撤销真的把这次标记撤掉了、没撤到别人的操作上」。 */
        const blockSig = () => FIX.blocks.map((b) => b.id + ":" + b.status).join(",");
        const before = itemCount();
        const sigBefore = blockSig();
        // 自己做一步**对称的块写入**（后面靠 Ctrl+Z / Ctrl+Shift+Z 触发 `loadTasks()`）。
        // ⚠️ 盲点（本轮实测踩到）：必须挑一个**计划中**的块，并且**断言这次写入真的发生了** ——
        // 若选中的块已经是 done（前面几百条断言改过），按 Space 不会产生新的历史条目，
        // 那么随后的 Ctrl+Z 就会撤到**上一条别人的操作**（可能是一大批块）→ 本周的块整批消失，
        // 而所有断言仍然全绿（假库被动过、视图停在旧快照）→ 只有全矩阵会红。
        const targetId = document.querySelector(".block.planned")?.dataset.blockId;
        if (!targetId) return false;
        await selectByClick(targetId);
        await press(" ");
        await settle(60);
        const marked = !!document.querySelector('[data-block-id="' + targetId + '"].done');
        await clearSel();
        if (!marked) return false; // 写入没发生 → 后面 undo/redo 不可靠（宁红不静默）
        // 一次性的空任务表（假后端既有手法：`__STATS_EMPTY` 同款；不真删任务 —— 那样会连带删块）
        window.__TASKS_EMPTY = true;
        await press("z", { ctrlKey: true }); // 撤销 → sync → loadTasks() → 拿到空表
        await settle(80);
        const emptied = itemCount();
        const emptyText = document.querySelector(".list .empty-text")?.textContent?.trim() ?? "";
        const addBtn = document.querySelector(".list .empty-add");
        const addLabel = (addBtn?.textContent ?? "").trim();
        addBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const focused = !!document.activeElement?.closest?.(".new-task");
        // 还原：把光标拿出输入框 → 重做（Ctrl+Shift+Z）→ sync → loadTasks() 拿回真表
        (document.activeElement)?.blur?.();
        await settle(10);
        await press("z", { ctrlKey: true, shiftKey: true });
        await settle(80);
        // 6b P2：重做把「完成」写回去了 —— 再撤一次，别让假库停在一块多出来的 done 上
        (document.activeElement)?.blur?.();
        await press("z", { ctrlKey: true });
        await settle(60);
        const restored = itemCount();
        const sigAfter = blockSig();
        const sigBack = sigAfter === sigBefore;
        window.__DIAG.push(
          `r78教① 起点行数=${before} 空态行数=${emptied} 空态文案=[${emptyText.slice(0, 16)}…] 按钮=[${addLabel}] 光标进输入框=${focused} 还原后行数=${restored} 块状态回位=${sigBack}${
            sigBack ? "" : "（起点=" + sigBefore.slice(0, 80) + " 收尾=" + sigAfter.slice(0, 80) + "）"
          }`,
        );
        return (
          before > 0 &&
          emptied === 0 &&
          emptyText.includes("还没有任务") &&
          addLabel.length > 0 &&
          focused &&
          restored === before &&
          sigBack
        );
      },
    ],
    [
      "round78 教②：空周指路 —— 整周空才有那一句（有块就收，不吃手势）",      async () => {
        await press("Escape");
        await backToThisWeek();
        await settle(30);
        const hint = () => document.querySelector(".week-empty");
        const before = !!hint();
        // 一次性空周（假后端既有手法）→ 重拉 → 整周空；**不动 FIX.blocks**
        window.__BLOCKS_EMPTY = true;
        await gotoWeek(1);
        await gotoWeek(0);
        await settle(40);
        const shown = !!hint();
        const text = (hint()?.textContent ?? "").trim();
        const pe = hint() ? getComputedStyle(hint()).pointerEvents : "-";
        // 还原：先清开关，再重拉（拿到真表）
        window.__BLOCKS_EMPTY = false;
        await gotoWeek(1);
        await gotoWeek(0);
        await settle(40);
        const gone = !hint();
        window.__DIAG.push(
          `r78教② 起点有提示=${before} 空周显示=${shown} 文案=[${text.slice(0, 24)}…] pe=${pe} 还原后收=${gone}`,
        );
        return !before && shown && text.includes("这一周还没有安排") && pe === "none" && gone;
      },
    ],
    [
      "round78 教③：统计空态有直接动作 —— 点了关面板 + 回本周（教-01/02 的「一个动作」）",
      async () => {
        await press("Escape");
        await gotoWeek(1);
        await settle(30);
        window.__STATS_EMPTY = true; // 一次性：`get_stats` 返回全 0（假后端既有开关）
        await openStatsPanel();
        await settle(60);
        const emptied = !!document.querySelector(".stats-panel .empty-action");
        const btn = document.querySelector(".stats-panel .empty-action");
        const label = (btn?.textContent ?? "").trim();
        btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const closed = !document.querySelector(".stats-panel");
        // round83 验收回修（你图 1）：「去时间轴排一块」点了要**真回到时间轴** ——
        // 统计现在可能是**总览的子层**开的，只关子层、总览还挡着 = 没回到时间轴（首跑就这么红过）。
        const noCover = !document.querySelector(".review-panel") && !document.querySelector(".stats-panel");
        const here = !!document.querySelector(".day.today");
        await backToThisWeek();
        window.__DIAG.push(
          `r78教③ 空态动作=${emptied} 文案=[${label}] 关面板=${closed} 无遮挡=${noCover} 回本周=${here}`,
        );
        return emptied && label.length > 0 && closed && noCover && here;
      },
    ],
    [
      "round78 教④：空周不发复盘提醒、也不推水位线（假后端镜像真后端守卫）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        await settle(30);
        window.__SANITY_STATE.reviewAction = "hint";
        window.__SANITY_STATE.reviewRemindAt = "sun 20:00";
        window.__FAKE_NOW = at(6, 21, 0); // 本周日 21:00（默认 sun 20:00 的 24h 窗口内）
        window.__SANITY_STATE.nudgedWeek = null;
        // 空周：一次性空表（提醒对象是本周）—— 不动 FIX.blocks
        window.__BLOCKS_EMPTY = true;
        await gotoWeek(1);
        await gotoWeek(0);
        await settle(30);
        await checkNudgeViaFocus();
        await settle(40);
        const noBar = !document.querySelector(".nudge");
        const levelUntouched = window.__SANITY_STATE.nudgedWeek === null;
        // 还原 → 有块之后同一次触发就该提（正向对照）：清开关 + 重拉拿回真表
        window.__BLOCKS_EMPTY = false;
        await gotoWeek(1);
        await gotoWeek(0);
        await settle(40);
        window.__SANITY_STATE.nudgedWeek = null;
        await checkNudgeViaFocus();
        await settle(60);
        const bar = !!document.querySelector(".nudge");
        const levelMoved = window.__SANITY_STATE.nudgedWeek !== null;
        document.querySelector(".nudge .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__FAKE_NOW = null; // 还原虚拟时钟（后续断言靠真时间）
        window.__DIAG.push(
          `r78教④ 空周无条=${noBar} 水位线未推=${levelUntouched} ｜ 有块出条=${bar} 水位线推了=${levelMoved}`,
        );
        return noBar && levelUntouched && bar && levelMoved;
      },
    ],
    [
      "round78 栈-05：覆盖面板的滚动内容都能被键盘够到（无焦点元素时容器自己进 Tab 顺序）",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(20);
        const FOCUSABLE =
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary, [contenteditable="true"]';
        const check = (root) => {
          if (!root) return { ok: false, why: "面板没开" };
          const scroller =
            root.scrollHeight > root.clientHeight + 1
              ? root
              : [...root.querySelectorAll("*")].find((el) => el.scrollHeight > el.clientHeight + 1) ?? root;
          const hasFocusable = [...scroller.querySelectorAll(FOCUSABLE)].some(
            (n) => n.offsetParent !== null || n === document.activeElement,
          );
          const ti = scroller.getAttribute("tabindex");
          const role = scroller.getAttribute("role");
          const label = scroller.getAttribute("aria-label") ?? "";
          // ACT 规则 `0ssw9k`：滚动内容要么里面有可聚焦元素，要么容器自己可聚焦（且带 role/标签）
          const ok = hasFocusable || (ti === "0" && role === "region" && label.length > 0);
          return { ok, why: `滚动容器=${scroller.className || scroller.tagName} 内有焦点元素=${hasFocusable} tabindex=${ti} role=${role} label=${label ? "有" : "无"}` };
        };
        const results = [];
        // ① 总览 → ② 统计（顶栏）
        document.querySelector(".review-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        results.push(["总览", check(document.querySelector(".review-panel"))]);
        await clickStatsEntry();
        await settle(60);
        results.push(["统计", check(document.querySelector(".stats-panel"))]);
        await press("Escape");
        await settle(30);
        // ③ 说明（设置 → 更多 → 引导与教程）
        await openSettingsSub("guide");
        document.querySelector(".sanity-pop .help-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        results.push(["说明", check(document.querySelector(".help-panel"))]);
        document.querySelector(".help-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        // ④ 成就（设置 → 更多 → 成就）
        await openSettingsSub("achievements");
        document.querySelector(".sanity-pop .ach-view")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(80);
        results.push(["成就", check(document.querySelector(".ach-panel"))]);
        document.querySelector(".ach-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(`r78栈05 ` + results.map(([n, r]) => `${n}:${r.ok ? "✓" : "✗"}(${r.why})`).join(" ｜ "));
        return results.every(([, r]) => r.ok);
      },
    ],
    [
      "round78 栈-10：面板加载失败有「重试」——统计 / 成就（失败注入 → 出现重试 → 点了就恢复）",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(20);
        // ① 统计：注入一次失败
        window.__FAIL_STATS_ONCE = true;
        await openStatsPanel();
        await settle(100);
        const statsRetry = document.querySelector(".stats-panel .empty-action");
        const statsLabel = (statsRetry?.textContent ?? "").trim();
        statsRetry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(100);
        const statsRecovered = !!document.querySelector(".stats-panel .group");
        await shutStats();
        // ② 成就：注入一次失败
        window.__FAIL_ACH_ONCE = true;
        await openSettingsSub("achievements");
        document.querySelector(".sanity-pop .ach-view")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(100);
        const achRetry = document.querySelector(".ach-panel .retry");
        const achLabel = (achRetry?.textContent ?? "").trim();
        achRetry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        const achRecovered = document.querySelectorAll(".ach-panel .ach").length > 0;
        document.querySelector(".ach-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r78栈10 统计重试=[${statsLabel}] 恢复=${statsRecovered} ｜ 成就重试=[${achLabel}] 恢复=${achRecovered}`,
        );
        return (statsLabel === "重试" || statsLabel.includes("重试")) && statsRecovered && (achLabel === "重试" || achLabel.includes("重试")) && achRecovered;
      },
    ],
    [
      "round78 栈-02b：Esc 与面板里的控件焦点 —— 勾选框上按 Esc 也要关面板（文字输入里则不动）",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(20);
        await openSettingsSub();
        const box = document.querySelector(".sanity-pop .keyboard-switch");
        if (!box) return false;
        box.focus();
        await settle(20);
        const focusedBox = document.activeElement === box;
        await press("Escape");
        await settle(40);
        const closedOnCheckbox = !document.querySelector(".sanity-pop");
        // 对照组：焦点在**文字类输入**里时 Esc 不该关面板（那是「取消编辑」的地盘，
        // 由输入框自己处理 —— 与 round38 的口径一致）
        await openSettingsSub("sanity"); // 理智值里有个数字输入框
        const num = document.querySelector(".sanity-pop input.num");
        if (!num) return false;
        num.focus();
        await settle(20);
        await press("Escape");
        await settle(40);
        const keptOnInput = !!document.querySelector(".sanity-pop");
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r78栈02b 勾选框聚焦=${focusedBox} Esc 关面板=${closedOnCheckbox} ｜ 数字输入里 Esc 不动面板=${keptOnInput}`,
        );
        return focusedBox && closedOnCheckbox && keptOnInput;
      },
    ],
    [
      "round78 栈-11：任务 ⚙ 表单 —— 分组标题（任务 / 操作）+ 两段式行 + 不横向溢出",
      async () => {
        await press("Escape");
        await settle(20);
        document.querySelector(".list .item .props-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const props = document.querySelector(".props");
        if (!props) return false;
        const groups = [...props.querySelectorAll(".prop-group")].map((n) => (n.textContent ?? "").trim());
        const row = props.querySelector(".prop");
        const direction = row ? getComputedStyle(row).flexDirection : "-";
        // 两段式：标签（第一个子项）与控件不在同一行 —— 控件的顶 >= 标签的底（允许 1px）
        const label = row?.querySelector(".prop-label");
        const ctrl = row?.querySelector("input, select, button, .picker, .cat-picker");
        const stacked =
          !!label && !!ctrl && ctrl.getBoundingClientRect().top >= label.getBoundingClientRect().bottom - 1;
        const overflow = props.scrollWidth - props.clientWidth;
        document.querySelector(".props-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        return groups.includes("任务") && groups.includes("操作") && direction === "column" && stacked && overflow <= 2;

      },
    ],
    // ===== round79（验收回修 + 三个「重置/恢复」）=====
    [
      "round79 ⑦：恢复默认设置 —— 取消不动 / 确认回默认且**语言保留**（任务与块一行不删）",
      async () => {
        await press("Escape");
        await settle(20);
        // 「恢复默认设置」在「更多 → 数据」折叠区里 —— 要先把那一区展开
        await openSettingsSub("data");
        const btn = document.querySelector(".sanity-pop .reset-settings");
        if (!btn) {
          window.__DIAG.push("r79⑦ 没找到 .reset-settings（面板/折叠区没开？）");
          return false;
        }
        const btnText = (btn.textContent ?? "").trim();
        const state = () => ({
          density: document.documentElement.dataset.density ?? "-",
          palette: document.documentElement.dataset.palette ?? "-",
          lang: document.querySelector(".sanity-pop select.lang")?.value ?? "-",
          layerBar: !!document.querySelector(".sanity-pop input.layer-bar-color")?.checked,
          blocks: FIX.blocks.length,
          tasks: FIX.tasks.length,
        });
        const before = state();
        // 改三项 + 切英文（验「语言保留」）
        const clickPick = async (sel) => {
          const b = document.querySelector(sel);
          if (!b) return false;
          b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(40);
          return true;
        };
        const picked =
          (await clickPick('.sanity-pop .ui-palette [data-value="sage"]')) &&
          (await clickPick('.sanity-pop .text-density [data-value="loose"]'));
        const bar = document.querySelector(".sanity-pop input.layer-bar-color");
        if (bar && bar.checked) {
          bar.click();
          await settle(40);
        }
        const langSel = document.querySelector(".sanity-pop select.lang");
        if (langSel) {
          langSel.value = "en";
          langSel.dispatchEvent(new Event("change", { bubbles: true }));
          await settle(60);
        }
        const changed = state();
        // ① 取消：**应用内确认面板** → 点「取消」；什么都没写，也没走系统对话框（79-01）
        const sysCalls0 = window.__DIALOG_CONFIRM_CALLS || 0;
        document.querySelector(".sanity-pop .reset-settings")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        const panelUp = !!document.querySelector(".confirm-panel[role=\"alertdialog\"]");
        document.querySelector(".confirm-cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(80);
        const cancel = {
          ...state(),
          resets: window.__SETTINGS_RESET_CALLS || 0,
          panelUp,
          sysCalls: (window.__DIALOG_CONFIRM_CALLS || 0) - sysCalls0,
        };
        // ② 确认：面板 → 点危险动作；设置回默认、语言保留、数据一行不删
        document.querySelector(".sanity-pop .reset-settings")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        document.querySelector(".confirm-danger")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(220);
        const after = { ...state(), resets: window.__SETTINGS_RESET_CALLS || 0, htmlLang: document.documentElement.lang };
        // 收尾：把语言拨回中文（别给后面的尺子/矩阵留英文界面）
        const back = document.querySelector(".sanity-pop select.lang");
        if (back) {
          back.value = "zh";
          back.dispatchEvent(new Event("change", { bubbles: true }));
          await settle(60);
        }
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const diag =
          `r79⑦ 按钮=[${btnText}] 起始=${before.density}/${before.palette}/层条${before.layerBar}/${before.lang} ` +
          `改后=${changed.density}/${changed.palette}/层条${changed.layerBar}/${changed.lang} ｜ 取消后=${cancel.density}/${cancel.palette}/层条${cancel.layerBar}/${cancel.lang} 面板弹过=${cancel.panelUp} 系统框调用=${cancel.sysCalls}（期望 0） 重置调用=${cancel.resets}（期望 0） ｜ ` +
          `确认后=${after.density}/${after.palette}/层条${after.layerBar}/${after.lang}（期望保留 en） 调用=${after.resets} 块=${after.blocks}（起始 ${before.blocks}） 任务=${after.tasks}（起始 ${before.tasks}）`;
        window.__DIAG.push(diag);
        return (
          btnText.includes("恢复默认设置") &&
          picked &&
          changed.palette === "sage" &&
          changed.density === "loose" &&
          changed.layerBar === false &&
          changed.lang === "en" &&
          cancel.resets === 0 &&
          cancel.panelUp &&
          cancel.sysCalls === 0 &&
          cancel.palette === changed.palette &&
          cancel.density === changed.density &&
          cancel.lang === "en" &&
          after.palette === before.palette &&
          after.density === before.density &&
          after.layerBar === before.layerBar &&
          after.lang === "en" &&
          after.htmlLang === "en" &&
          after.resets === 1 &&
          after.blocks === before.blocks &&
          after.tasks === before.tasks
        );
      },
    ],
    [
      "round79 ⑥：重置成就 —— 取消不写 / 确认清空点亮 + 隐藏档回 ???（块与事件一条没删）",
      async () => {
        await press("Escape");
        await settle(20);
        // 打开成就面板（设置 → 更多 → 成就 → 查看）
        await openSettingsSub("achievements");
        document
          .querySelector(".sanity-pop .ach-view")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(160);
        const unlockedOf = () => {
          const m = (document.querySelector(".ach-panel .scope")?.textContent ?? "").match(/(\d+)/);
          return m ? Number(m[1]) : -1;
        };
        const unlockedRows = () => document.querySelectorAll(".ach-panel .ach:not(.locked)").length;
        const qmRows = () =>
          [...document.querySelectorAll(".ach-panel .ach .name")].filter(
            (n) => (n.textContent ?? "").trim() === "???",
          ).length;
        const btn = document.querySelector(".ach-panel .reset-ach");
        if (!btn) return false;
        const btnText = (btn.textContent ?? "").trim();
        const before = {
          unlocked: unlockedOf(),
          rows: unlockedRows(),
          blocks: FIX.blocks.length,
          events: FIX.events.length,
        };
        // ① 取消：应用内确认面板 → 点「取消」；什么都没写（79-01）
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        const panelUp = !!document.querySelector(".confirm-panel[role=\"alertdialog\"]");
        document.querySelector(".confirm-cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(80);
        const cancel = {
          unlocked: unlockedOf(),
          resets: window.__ACH_RESET_CALLS || 0,
          panel: !!document.querySelector(".ach-panel"),
          panelUp,
        };
        // ② 确认：点危险动作 → 清空点亮 + 隐藏档回 ???，**块 / 事件一条不删**
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        document.querySelector(".confirm-danger")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(200);
        const after = {
          unlocked: unlockedOf(),
          rows: unlockedRows(),
          qm: qmRows(),
          resets: window.__ACH_RESET_CALLS || 0,
          blocks: FIX.blocks.length,
          events: FIX.events.length,
          toasts: [...document.querySelectorAll(".toast")]
            .map((n) => (n.textContent ?? "").trim())
            .join(" ｜ "),
        };
        window.__ACH_RESET = false; // 还原：别影响后面的断言
        document
          .querySelector(".ach-panel .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        document
          .querySelector(".sanity-pop .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r79⑥ 按钮=[${btnText}] 前 点亮=${before.unlocked}/行=${before.rows}/块=${before.blocks} ｜ 取消后 点亮=${cancel.unlocked} 重置调用=${cancel.resets}（期望 0） 面板在=${cancel.panel} 确认面板弹过=${cancel.panelUp} ｜ 确认后 点亮=${after.unlocked} 行=${after.rows} ???行=${after.qm} 调用=${after.resets} 块=${after.blocks}（期望不变） 事件=${after.events} 提示=[${after.toasts}]`,
        );
        return (
          btnText.includes("重置成就") &&
          before.unlocked > 0 &&
          cancel.unlocked === before.unlocked &&
          cancel.resets === 0 &&
          cancel.panel &&
          cancel.panelUp &&
          after.unlocked === 0 &&
          after.rows === 0 &&
          after.qm > 0 &&
          after.resets === 1 &&
          after.blocks === before.blocks &&
          after.events === before.events
        );
      },
    ],
    [
      "round79 ⑤：重置统计 —— 取消不写 / 确认写时间界（数字从线后重算、事件一条没删）",
      async () => {
        await press("Escape");
        await settle(20);
        // 打开统计（假后端会种下固定的 35 条事件）
        await openStatsPanel();
        await settle(160);
        const num = (label) => {
          const row = [...document.querySelectorAll(".stats-panel .row")].find((r) =>
            (r.querySelector("dt")?.textContent ?? "").trim().startsWith(label),
          );
          const m = (row?.querySelector(".num")?.textContent ?? "").match(/(\d+)/);
          return m ? Number(m[1]) : -1;
        };
        const btn = document.querySelector(".stats-panel .reset-stats");
        if (!btn) return false;
        const btnText = (btn.textContent ?? "").trim();
        const before = { total: num("事件总数"), events: FIX.events.length };
        // ① 取消：应用内确认面板 → 点「取消」；什么都没写（79-01）
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        const panelUp = !!document.querySelector(".confirm-panel[role=\"alertdialog\"]");
        document.querySelector(".confirm-cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(80);
        const cancel = {
          total: num("事件总数"),
          line: window.__STATS_RESET_AT ?? 0,
          panel: !!document.querySelector(".stats-panel"),
          panelUp,
        };
        // ② 确认：点危险动作 → 写时间界 → 数字按过滤后重算，**事件条数不变**（非破坏）
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        document.querySelector(".confirm-danger")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(160);
        const line = window.__STATS_RESET_AT ?? 0;
        const expect = FIX.events.filter((e) => e.created_at >= line).length;
        const ok2 = {
          total: num("事件总数"),
          events: FIX.events.length,
          first: (document.querySelector(".stats-panel .row dt")?.textContent ?? "").trim(),
          toasts: [...document.querySelectorAll(".toast")].map((n) => (n.textContent ?? "").trim()).join(" ｜ "),
          diag: (window.__DIAG || []).slice(-2).join(" ; "),
        };
        document
          .querySelector(".stats-panel .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        await shutReview(); // round83：统计是总览子层开的 —— 收尾把父层也收掉
        window.__DIAG.push(
          `r79⑤ 按钮=[${btnText}] 前 总数=${before.total}/事件=${before.events} ｜ 取消后 总数=${cancel.total} 线=${cancel.line} 面板在=${cancel.panel} 确认面板弹过=${cancel.panelUp} ｜ 确认后 总数=${ok2.total}（期望 ${expect}） 事件=${ok2.events}（期望不变） 线=${line} 提示=[${ok2.toasts}]`,
        );
        return (
          btnText.includes("重置统计") &&
          before.total > 0 &&
          cancel.total === before.total &&
          cancel.line === 0 &&
          cancel.panel &&
          cancel.panelUp &&
          line > 0 &&
          ok2.total === expect &&
          ok2.total < before.total &&
          ok2.events === before.events
        );
      },
    ],
    // ===== round80（设计 + 调研 + 79-03）=====
    [
      "round80 ①：危险确认走应用内 alertdialog —— 形态 / 焦点在取消 / 取消在左 / Esc 与遮罩都取消 / 父面板不关",
      async () => {
        await press("Escape");
        await settle(20);
        await openSettingsSub("data");
        const btn = document.querySelector(".sanity-pop .reset-settings");
        if (!btn) return false;
        const openPanel = async () => {
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(120);
        };
        const panel = () => document.querySelector(".confirm-panel");
        const resets = () => window.__SETTINGS_RESET_CALLS || 0;
        // ① 形态与语义（APG Alert Dialog）
        await openPanel();
        const p = panel();
        const title = document.getElementById("confirm-title");
        const body = document.getElementById("confirm-body");
        const shape =
          !!p &&
          p.getAttribute("role") === "alertdialog" &&
          p.getAttribute("aria-modal") === "true" &&
          p.getAttribute("aria-labelledby") === "confirm-title" &&
          p.getAttribute("aria-describedby") === "confirm-body" &&
          !!title?.textContent?.trim() &&
          !!body?.textContent?.trim();
        // ② 初始焦点在「取消」（→ 真 Enter 就是取消；APG：不可逆 → 焦点放最不破坏的动作）
        const cancelBtn = document.querySelector(".confirm-cancel");
        const dangerBtn = document.querySelector(".confirm-danger");
        const focusOnCancel = document.activeElement === cancelBtn;
        // ③ 取消在 DOM 顺序上先于危险动作（GNOME：cancel before affirmative）
        const orderOk =
          !!cancelBtn &&
          !!dangerBtn &&
          (cancelBtn.compareDocumentPosition(dangerBtn) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        // ④ 取消 → 关 + 不写
        const r0 = resets();
        cancelBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(100);
        const afterCancel = { closed: !panel(), resets: resets() };
        // ⑤ Esc → 关 + 不写（Esc 走面板栈：modal 只是栈顶）。6b P2：先验「又弹出来了」——
        // 否则「面板没起来」也会让 `closed=true` 假绿。
        await openPanel();
        const upEsc = !!panel();
        await press("Escape");
        await settle(100);
        const afterEsc = { closed: !panel(), resets: resets() };
        // ⑥ 点遮罩 → 关 + 不写（同样先验「又弹出来了」）
        await openPanel();
        const upBackdrop = !!panel();
        document.querySelector(".confirm-backdrop")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(100);
        const afterBackdrop = { closed: !panel(), resets: resets() };
        // ⑦ 父面板（设置）不被关掉 —— modal 层语义
        const parentAlive = !!document.querySelector(".sanity-pop");
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        window.__DIAG.push(
          `r80① 形态=${shape} 焦点在取消=${focusOnCancel} 取消在左=${orderOk} ｜ 取消：关=${afterCancel.closed} 写=${afterCancel.resets} ｜ Esc：又弹=${upEsc} 关=${afterEsc.closed} 写=${afterEsc.resets} ｜ 遮罩：又弹=${upBackdrop} 关=${afterBackdrop.closed} 写=${afterBackdrop.resets} ｜ 父面板还在=${parentAlive}`,
        );
        return (
          shape &&
          focusOnCancel &&
          orderOk &&
          afterCancel.closed &&
          afterCancel.resets === r0 &&
          upEsc &&
          afterEsc.closed &&
          afterEsc.resets === r0 &&
          upBackdrop &&
          afterBackdrop.closed &&
          afterBackdrop.resets === r0 &&
          parentAlive
        );
      },
    ],
    [
      "round80 ②：模板迷你周视图 —— 浮窗在面板旁 / 块数=行数 / 双向联动 / 开关关掉不画 / 窄窗隐藏",
      async () => {
        await press("Escape");
        await settle(20);
        document.querySelector(".templates-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(240);
        const pop = document.querySelector(".tpl-pop");
        const mini = document.querySelector("[data-tpl-preview]");
        const rows = [...document.querySelectorAll(".tpl-pop .sk-row")];
        const blks = [...document.querySelectorAll("[data-tpl-mini] .blk")];
        const heads = document.querySelectorAll("[data-tpl-mini] .heads i").length;
        const axis = document.querySelectorAll("[data-tpl-mini] .axis b").length;
        // 窄窗（≤ 860）时浮窗应被媒体查询藏起来（元素还在 DOM，display:none）
        const narrowHidden = window.innerWidth > 860 || getComputedStyle(mini).display === "none";
        const rowIds = new Set(blks.map((b) => b.dataset.row));
        const shape =
          !!pop && !!mini && rows.length > 0 && blks.length >= rows.length && rowIds.size === rows.length && heads === 7 && axis > 0;
        // ① 列表 → 预览：悬停某一行 → 对应块带 .hot（行自己也亮）
        const i0 = Math.min(1, rows.length - 1);
        rows[i0].dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        await settle(40);
        const rowToBlk =
          rows[i0].classList.contains("hot") &&
          document.querySelector(`[data-tpl-mini] .blk[data-row="${i0}"].hot`) !== null;
        rows[i0].dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
        await settle(40);
        const cleared = document.querySelector(`[data-tpl-mini] .blk[data-row="${i0}"].hot`) === null;
        // ② 预览 → 列表（反向）
        const b = document.querySelector(`[data-tpl-mini] .blk[data-row="${i0}"]`);
        b?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        await settle(40);
        const blkToRow = rows[i0].classList.contains("hot");
        b?.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
        await settle(40);
        // round80（6b P1）：把行悬停**留着**就关面板 —— 重开不能留下常亮的行（浏览器不会补发 mouseleave）
        rows[i0].dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        await settle(30);
        const blocksBefore = FIX.blocks.length;
        document.querySelector(".tpl-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(80);
        const closed = !document.querySelector("[data-tpl-preview]");
        document.querySelector(".templates-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(240);
        const noStaleHot = !document.querySelector(".tpl-pop .sk-row.hot");
        document.querySelector(".tpl-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(80);
        // ③ 开关关掉 → 再开面板也没有浮窗；**按进入时的真值还原**（6b P2：注册给运行器兜底，
        //    中途提前 return / 抛异常也不会把开关留在关状态污染后面几百条断言）
        await openSettingsSub();
        const cb = document.querySelector(".sanity-pop input.template-preview");
        const wasOn = cb ? cb.checked : true;
        window.__RESTORE = window.__RESTORE || [];
        window.__RESTORE.push(async () => {
          if (!document.querySelector(".sanity-pop")) {
            document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await settle(40);
          }
          const box = document.querySelector(".sanity-pop input.template-preview");
          if (box && box.checked !== wasOn) {
            box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await settle(60);
          }
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        });
        if (cb?.checked) {
          cb.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(80);
        }
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        document.querySelector(".templates-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(240);
        const offHidden = !document.querySelector("[data-tpl-preview]");
        document.querySelector(".tpl-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        window.__DIAG.push(
          `r80② 形态=${shape}（行=${rows.length} 块=${blks.length} 行号去重=${rowIds.size} 日头=${heads} 刻度=${axis}）列表→预览=${rowToBlk} 移开清=${cleared} 预览→列表=${blkToRow} 关面板不画=${closed} 重开无残留亮行=${noStaleHot} 开关关掉=${offHidden} 窄窗隐藏=${narrowHidden} 块未动=${FIX.blocks.length === blocksBefore}`,
        );
        return (
          shape &&
          rowToBlk &&
          cleared &&
          blkToRow &&
          closed &&
          noStaleHot &&
          offHidden &&
          narrowHidden &&
          FIX.blocks.length === blocksBefore
        );
      },
    ],
    [
      "round80 ③：配色选择器 = 迷你界面小样 —— 每套亮/暗各一份只显当前那份 / 12 套强调色互不相同 / 点选即时生效",
      async () => {
        await press("Escape");
        await settle(20);
        await openSettingsSub();
        const btns = [...document.querySelectorAll(".sanity-pop .ui-palette .palette")];
        const arts = btns.map((b) => [...b.querySelectorAll(".thumb .art")]);
        const visible = arts.map((list) => list.filter((a) => getComputedStyle(a).display !== "none"));
        const shape =
          btns.length === 12 &&
          arts.every((l) => l.length === 2) &&
          visible.every((l) => l.length === 1);
        // 强调色（块左条）12 套互不相同（小样真的画出了差别，而不是几张同色）
        const accents = visible.map(([a]) => getComputedStyle(a.querySelector(".main .blk b")).backgroundColor);
        const accentsDistinct = new Set(accents).size === 12;
        const before = document.documentElement.dataset.palette;
        btns.find((b) => b.dataset.value === "sage")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(140);
        const picked = {
          palette: document.documentElement.dataset.palette,
          checked: btns.find((b) => b.dataset.value === "sage")?.getAttribute("aria-checked"),
          tickOn: !!document.querySelector('.sanity-pop .ui-palette .palette[data-value="sage"] .pname.on'),
        };
        document.querySelector('.sanity-pop .ui-palette .palette[data-value="warm"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(140);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const back = document.documentElement.dataset.palette;
        window.__DIAG.push(
          `r80③ 12 套=${btns.length} 各亮点份=[${visible.map((l) => l.length).join(",")}] 强调色去重=${new Set(accents).size} 原=${before} 点后=${picked.palette}/${picked.checked}/✓${picked.tickOn} 复原=${back}`,
        );
        return shape && accentsDistinct && picked.palette === "sage" && picked.checked === "true" && picked.tickOn && back === before;
      },
    ],
    [
      "round80 ④：78-04/06·07 —— 键盘开关进「提醒与控制」+ 键位说明成链接；「更多」六块按推荐序",
      async () => {
        await press("Escape");
        await settle(20);
        await openSettingsSub();
        const pop = document.querySelector(".sanity-pop");
        if (!pop) return false;
        // ① 键盘开关在「提醒与控制」组里，且不再需要展开「更多」/子区
        const kb = pop.querySelector("#settings-group-alert .keyboard-switch");
        const kbInGroup = !!kb && !kb.closest(".sub-acc");
        // ② 同组有一行「打开快捷键总表…」链接
        const link = pop.querySelector("#settings-group-alert .keymap-open");
        // ③ 「更多」里不再有键位说明块；六块按推荐序（数据 → 功能开关 → 计划任务 → 理智值 → 成就 → 引导）
        // 注意：`openSettingsSub()` 已经把「更多」展开了 —— 再点一下反而会收起（幂等处理）
        const moreBtn = pop.querySelector(".more-toggle");
        if (moreBtn && moreBtn.getAttribute("aria-expanded") !== "true") {
          moreBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(30);
        }
        const more = pop.querySelector("#settings-group-more");
        const noKeys = !more?.querySelector(".keys-toggle");
        const order = [...(more?.querySelectorAll(".sub-toggle") ?? [])].map(
          (b) =>
            (b.className.split(/\s+/).find((c) => c.endsWith("-toggle") && c !== "sub-toggle") ?? "").replace(
              "-toggle",
              "",
            ),
        );
        // round85（0.31.0）：唯一版本 → 成就区恒在（以前 `--ach-lite` 时这里会少一项）
        const want = ["data", "features", "scheduler", "sanity", "achievements", "guide"];
        const orderOk = JSON.stringify(order) === JSON.stringify(want);
        // ④ 链接真的开 `?` 面板
        link?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const opened = !!document.querySelector(".keymap-panel");
        document.querySelector(".keymap-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r80④ 开关在④=${kbInGroup} 链接在④=${!!link} 更多无键位说明=${noKeys} 更多序=[${order.join(",")}] 链接开?=${opened}`,
        );
        return kbInGroup && !!link && noKeys && orderOk && opened;
      },
    ],
    [
      "round79 ③：总览 / 数据位置的失败态都有「重试」——注入一次失败 → 点重试 → 内容回来",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(20);
        // ① 总览（`get_week_mosaic`）—— 失败注入**常驻**，断言自己关（见 fixture 里的注释）
        const panelBefore = !!document.querySelector(".review-panel");
        // ⓐ **先成功加载一次**（6b 二轮 P2）：78-08 的本体是「失败时清掉陈旧的那一周」——
        // 只有 store 里先有本周数据，才能验出「失败后不留旧数据、给重试」；否则 review.week 本来就是 null，
        // 这条判据恒真（无论有没有那句清空都出「重试」）。
        document.querySelector(".review-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(180);
        const loadedOnce = document.querySelectorAll(".review-panel .tile").length > 0;
        const weekWasSet = !!document.querySelector(".review-panel .mosaic, .review-panel .tiles");
        document.querySelector(".review-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const callsBefore = (window.__MOSAIC_DBG || []).length;
        window.__FAIL_MOSAIC = true;
        document.querySelector(".review-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(140);
        const callsAfter = (window.__MOSAIC_DBG || []).length;
        const flagLeft = !!window.__FAIL_MOSAIC;
        const revRetry = document.querySelector(".review-panel .retry");
        const revLabel = (revRetry?.textContent ?? "").trim();
        window.__FAIL_MOSAIC = false; // 原因消失 → 重试该成功
        revRetry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(200);
        const revRecovered =
          !document.querySelector(".review-panel .retry") &&
          document.querySelectorAll(".review-panel .tile").length > 0;
        document
          .querySelector(".review-panel .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        // ② 数据位置（`get_data_info`）
        window.__FAIL_DATA_INFO = true;
        await openSettingsSub("data");
        document
          .querySelector(".sanity-pop .portable-open")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(140);
        const dataRetry = document.querySelector(".switch-panel .retry");
        const dataLabel = (dataRetry?.textContent ?? "").trim();
        window.__FAIL_DATA_INFO = false; // 原因消失 → 重试该成功
        dataRetry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(200);
        const dataRecovered = document.querySelectorAll(".switch-panel .card").length >= 2;
        document
          .querySelector(".switch-panel .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        document
          .querySelector(".sanity-pop .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r79③ 总览：先成功加载=${loadedOnce}/${weekWasSet} 重试=[${revLabel}] 恢复=${revRecovered}（开前=${panelBefore} mosaic 调用 ${callsBefore}→${callsAfter} 注入拦住=${flagLeft}） ｜ 数据位置重试=[${dataLabel}] 恢复=${dataRecovered}`,
        );
        return (
          loadedOnce && // 前置：必须真成功加载过（否则这条判据恒真 —— 6b 二轮 P2）
          weekWasSet &&
          revLabel.includes("重试") &&
          revRecovered &&
          dataLabel.includes("重试") &&
          dataRecovered
        );
      },
    ],
    [
      "round79 ②：设置导航 —— 点哪组那组就贴到正文顶部（含「更多」展开态）；滚到哪组哪个按钮亮（scroll-spy）",
      async () => {
        await press("Escape");
        await settle(20);
        if (!document.querySelector(".sanity-pop")) {
          document
            .querySelector(".sanity-gear")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(40);
        }
        const body = document.querySelector(".sanity-pop .pop-body");
        if (!body) return false;
        const groups = ["theme", "density", "timeline", "alert", "more"];
        const off = (id) => {
          const g = document.getElementById(`settings-group-${id}`);
          const b = document.querySelector(".sanity-pop .pop-body");
          if (!g || !b) return null;
          return Math.round(g.getBoundingClientRect().top - b.getBoundingClientRect().top);
        };
        const navOn = () =>
          document.querySelector(".sanity-pop .nav-btn.on")?.getAttribute("data-group") ?? "-";
        const rows = [];
        for (const id of groups) {
          document
            .querySelector(`.sanity-pop .nav-btn[data-group="${id}"]`)
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(80);
          rows.push({ id, off: off(id), on: navOn() === id, atTop: body.scrollTop });
        }
        // 「更多」展开后尾部变高 → 留白要重算（仍要能顶到头）
        document
          .querySelector('.sanity-pop .nav-btn[data-group="more"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        document
          .querySelector(".sanity-pop .more-toggle")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        const moreOpenOff = off("more");
        // scroll-spy：手动滚到第 3 组（时间轴）→ 该组按钮该亮
        const tl = document.getElementById("settings-group-timeline");
        if (!tl) return false;
        body.scrollTop += Math.round(
          tl.getBoundingClientRect().top - body.getBoundingClientRect().top - 8,
        );
        await frames(3); // 滚动事件在渲染帧里派发 —— `settle()`（微任务）等不到它
        await settle(20);
        const spy = navOn();
        // 收尾：关面板（后续断言从干净态起）
        document
          .querySelector(".sanity-pop .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const detail = rows.map((r) => `${r.id}:${r.off}${r.on ? "✓" : "✗on"}`).join(" ");
        window.__DIAG.push(
          `r79② ${detail} ｜ 更多展开后=${moreOpenOff} ｜ 回顶 scrollTop=${rows[0].atTop} ｜ scroll-spy=${spy}`,
        );
        return (
          rows.every((r) => r.off !== null && r.off >= 0 && r.off <= 8 && r.on) &&
          rows[0].atTop === 0 &&
          moreOpenOff !== null &&
          moreOpenOff >= 0 &&
          moreOpenOff <= 8 &&
          spy === "timeline"
        );
      },
    ],
    [
      "round79 ④：双击建临时块 → 就地命名期间**没有**动作浮层（不再压住输入框；对照组：别的块有）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        focusBodyY(yAt(3, 0)); // 凌晨那一段滚进视野（照 C1.8 的手法）
        await settle();
        const before = document.querySelectorAll("[data-block-id]").length;
        dblclickAt(5, 3, 0); // 周六 03:00 空着
        await settle(30);
        const input = document.activeElement;
        const editing = !!input && input.tagName === "INPUT" && input.classList.contains("name-input");
        const owner = input?.closest?.("[data-block-id]") ?? null;
        const id = owner?.getAttribute("data-block-id") ?? "-";
        const acts = owner?.querySelector(".actions") ?? null;
        // 对照组：别的块（非改名中）的 `.actions` 还在 —— 防「一刀切掉整个浮层」式假绿
        const otherActs = [...document.querySelectorAll("[data-block-id]")].some(
          (n) => n !== owner && !!n.querySelector(".actions"),
        );
        const countWithInput = document.querySelectorAll("input.name-input").length;
        // 收尾：Esc 退出命名（C1.8 的既有路径）→ 删掉这块
        input?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await settle(40);
        document
          .querySelector(`[data-block-id="${id}"] .actions button[title="删除块"]`)
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const after = document.querySelectorAll("[data-block-id]").length;
        window.__DIAG.push(
          `r79④ 块数 ${before}→${after} 改名中=${editing}（输入框 ${countWithInput} 个）｜ 本块浮层=${acts ? "有（opacity " + Number(getComputedStyle(acts).opacity) + "）" : "没有"} ｜ 对照块有浮层=${otherActs}`,
        );
        return editing && !acts && otherActs && after === before;
      },
    ],
    [
      "round79 ①：打字框的 Esc 语义 —— 「添加任务…」清空 + 失焦；设置里的数字输入回真值 + 失焦（都不关面板）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        // —— A 段：Backlog 的「添加任务…」（细轨先展开）
        if (document.querySelector(".backlog.rail")) {
          document
            .querySelector(".backlog.rail .rail-strip")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(40);
        }
        const field = document.querySelector(".new-task .field");
        if (!field) return false;
        field.focus();
        field.value = "半截草稿";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await settle(20);
        const typed = field.value === "半截草稿" && document.activeElement === field;
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await settle(40);
        const cleared = field.value === "";
        const blurred = document.activeElement !== field;
        // —— B 段：设置 → 更多 → 理智值 的小时数（Esc 该回真值 + 失焦，且不关面板）
        await openSettingsSub("sanity");
        const num = document.querySelector(".sanity-pop input.num");
        if (!num) return false;
        const truth = num.value;
        const other = truth === "9" ? "10" : "9";
        num.focus();
        num.value = other;
        num.dispatchEvent(new Event("input", { bubbles: true }));
        await settle(20);
        const typedNum = num.value === other && document.activeElement === num;
        num.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await settle(40);
        const reverted = num.value === truth && document.activeElement !== num;
        const panelKept = !!document.querySelector(".sanity-pop");
        document
          .querySelector(".sanity-pop .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        // —— C 段：模板面板的「模板名」输入（6b 二轮：`TemplatePicker` 那条改动当时没有断言覆盖）
        document.querySelector(".templates-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(70);
        const tplInput = document.querySelector(".tpl-pop .tpl-input");
        if (!tplInput) return false;
        tplInput.focus();
        tplInput.value = "半截模板名";
        tplInput.dispatchEvent(new Event("input", { bubbles: true }));
        await settle(20);
        const tplTyped = tplInput.value === "半截模板名" && document.activeElement === tplInput;
        tplInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await settle(40);
        const tplCleared = tplInput.value === "" && document.activeElement !== tplInput;
        document
          .querySelector(".tpl-pop .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        window.__DIAG.push(
          `r79① 输入态=${typed} Esc后 清空=${cleared} 失焦=${blurred} ｜ 数字 打字=${typedNum} 回真值=${reverted}（${other}→${num.value}/真值${truth}） 面板还在=${panelKept} ｜ 模板名 打字=${tplTyped} 清空+失焦=${tplCleared}`,
        );
        return (
          typed && cleared && blurred && typedNum && reverted && panelKept && tplTyped && tplCleared
        );
      },
    ],

    // ===== round81（3.1c₁：「挤」bug —— 迷你周视图 / 窄列两行）=====
    [
      "round81 ①：迷你周视图不挤 —— 窄档日头不裁切 / 名字按时高 / 两行不挤压 / 列间有呼吸（红→绿）",
      async () => {
        await press("Escape");
        await settle(20);
        if (window.innerWidth <= 860) {
          return { skip: "窄窗（≤860）浮窗本就不显示；1100 那一跑才是它的靶场" };
        }
        document
          .querySelector(".templates-open")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(240);
        const pv = document.querySelector("[data-tpl-preview]");
        if (!pv) return false;
        // round81（6b P2）：先量**真实尺寸**（1500 窗口 = 600 宽 → `showFullDay` 的宽档：整日期标签）——
        // 以前每次都强制 440，宽档分支从来没被断言过
        const realW = Math.round(pv.getBoundingClientRect().width);
        const headClipAt = (m) => {
          const hs = [...m.querySelectorAll(".heads i")];
          return hs.filter((h) => {
            const r = document.createRange();
            r.selectNodeContents(h);
            return r.getBoundingClientRect().width > h.clientWidth + 1;
          }).length;
        };
        const miniReal = document.querySelector("[data-tpl-mini]");
        if (!miniReal) return false;
        const headClipReal = headClipAt(miniReal);
        // 再把浮窗强制到最小档（440×320 = clamp 下限；1100 窗口下真实就是它）——考「窄档」这套阈值
        const prevW = pv.style.width;
        const prevH = pv.style.height;
        pv.style.width = "440px";
        pv.style.height = "320px";
        await frames(4);
        const mini = document.querySelector("[data-tpl-mini]");
        if (!mini) return false;
        // ① 日头：文字宽度 ≤ 单元格宽（不裁切、不压到邻列）
        const heads = [...mini.querySelectorAll(".heads i")];
        const headClip = headClipAt(mini);
        // ② 块内：名字只在放得下时渲染；文字不垂直裁切；**不再有时段行**（6b 复核实测：最宽浮窗也放不下）
        const blocks = [...mini.querySelectorAll(".blk")];
        const grid = mini.querySelector(".grid");
        const gw = grid?.clientWidth ?? 0;
        const gx = grid?.getBoundingClientRect().left ?? 0;
        let nameTooSmall = 0;
        let textClip = 0;
        const clipInfo = [];
        // 阈值跟密度：与组件同一套公式（`--text-meta` 12/12/13 → 行高 ×1.2；一行 + 1px 外边距）
        const metaPx = parseFloat(getComputedStyle(mini).getPropertyValue("--text-meta")) || 12;
        const needName = 3 + metaPx * 1.2;
        const noTimeLine = mini.querySelectorAll(".tm").length === 0;
        const colLeft = Array(7).fill(Infinity);
        const colRight = Array(7).fill(-Infinity);
        for (const b of blocks) {
          const rect = b.getBoundingClientRect();
          const h = rect.height;
          if (b.querySelector(".nm") && h < needName - 1) nameTooSmall += 1;
          // 「文字被裁」= 某个 span 的矩形越过块上下边（量文字本身，不看块自身 scrollHeight ——
          // 跨天块的 `↳` 续行记号是伪元素，会故意伸到边外 1px，不算文字被裁）
          for (const span of b.querySelectorAll("span")) {
            const sr = span.getBoundingClientRect();
            if (sr.bottom > rect.bottom + 0.5 || sr.top < rect.top - 0.5) {
              textClip += 1;
              if (clipInfo.length < 3) {
                clipInfo.push(`${span.className}h${Math.round(h)}(${Math.round(sr.bottom - rect.bottom)})`);
              }
            }
          }
          // round82（11.1）：并排后**每列内部还有列**，用 left 比例猜「第几天」会把半宽块归到隔壁天
          // → 改用组件给的 `data-day`（真实归属；无该属性时退回旧算法）
          const dayAttr = b.dataset.day;
          const day =
            dayAttr === undefined
              ? Math.min(6, Math.max(0, Math.round((rect.left - gx) / (gw / 7))))
              : Math.min(6, Math.max(0, Number(dayAttr)));
          colLeft[day] = Math.min(colLeft[day], rect.left);
          colRight[day] = Math.max(colRight[day], rect.right);
        }
        // ③ 相邻列呼吸：某列最右 → 次列最左 ≥ 3px（block 内缩 2px + 2px = 4）
        let tightCols = 0;
        const gaps = [];
        for (let d = 0; d < 6; d++) {
          if (colRight[d] === -Infinity || colLeft[d + 1] === Infinity) continue;
          gaps.push(Math.round(colLeft[d + 1] - colRight[d]));
          if (colLeft[d + 1] - colRight[d] < 3) tightCols += 1;
        }
        // 读数在还之前拿（6b P2：以前 DIAG 打印的是还完之后的宽度）
        const forcedW = Math.round(pv.getBoundingClientRect().width);
        const colWNow = Math.round(gw / 7);
        pv.style.width = prevW;
        pv.style.height = prevH;
        document
          .querySelector(".tpl-pop .close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        window.__DIAG.push(
          `r81① 真实浮窗=${realW} 其日头裁切=${headClipReal} ｜ 强制浮窗=${forcedW} 列宽=${colWNow} 日头裁切=${headClip}/${heads.length} 名字太小=${nameTooSmall} 无时段行=${noTimeLine} 文字裁切=${textClip}${clipInfo.length ? "（" + clipInfo.join(" ") + "）" : ""} meta=${metaPx} 列太挤=${tightCols} 间隙=[${gaps.join(",")}]`,
        );
        return (
          headClipReal === 0 && headClip === 0 && nameTooSmall === 0 && noTimeLine && textClip === 0 && tightCols === 0
        );
      },
    ],
    [
      "round81 ②：块内两行不挤压 —— 文字不垂直裁切 + 第二行只在够高时出现",
      async () => {
        await press("Escape");
        await settle(30);
        const blocks = [...document.querySelectorAll(".block")];
        if (blocks.length === 0) return false;
        let verticalClip = 0;
        let secondLineTooShort = 0;
        for (const b of blocks) {
          const h = b.getBoundingClientRect().height;
          const text = b.querySelector(".text");
          if (text && text.scrollHeight > text.clientHeight + 1) verticalClip += 1;
          if (b.querySelector(".time") && h < 38) secondLineTooShort += 1;
        }
        window.__DIAG.push(
          `r81② 窗口=${window.innerWidth} 块=${blocks.length} 垂直裁切=${verticalClip} 第二行但块高<38=${secondLineTooShort}`,
        );
        return verticalClip === 0 && secondLineTooShort === 0;
      },
    ],
    [
      "round81 ③：时间 / 日期格式 —— 选项带真实样例 / 切换即时生效（含刻度栏加宽）/ 写失败拨回",
      async () => {
        await press("Escape");
        await settle(30);
        await openSettingsSub();
        const tSel = document.querySelector(".sanity-pop select.time-format");
        const dSel = document.querySelector(".sanity-pop select.date-format");
        if (!tSel || !dSel) return false;
        // 入口真值 + 兜底还原（提前 return / 抛异常都不会把格式留在测试值上）
        const wasT = tSel.value;
        const wasD = dSel.value;
        window.__RESTORE = window.__RESTORE || [];
        window.__RESTORE.push(async () => {
          window.__FAIL_SET_SETTING_ONCE = false;
          await openSettingsSub();
          const t = document.querySelector(".sanity-pop select.time-format");
          const d = document.querySelector(".sanity-pop select.date-format");
          if (t && t.value !== wasT) {
            t.value = wasT;
            t.dispatchEvent(new Event("change", { bubbles: true }));
            await settle(60);
          }
          if (d && d.value !== wasD) {
            d.value = wasD;
            d.dispatchEvent(new Event("change", { bubbles: true }));
            await settle(60);
          }
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        });
        // ① 选项带**真实样例**（非空、互不相同；设-02 口径）
        const tOpts = [...tSel.options].map((o) => (o.textContent ?? "").trim());
        const dOpts = [...dSel.options].map((o) => (o.textContent ?? "").trim());
        const optsOk =
          tOpts.length === 3 &&
          dOpts.length === 4 &&
          tOpts.every((s) => s.length > 2) &&
          dOpts.every((s) => s.length > 2) &&
          new Set(tOpts).size === 3 &&
          new Set(dOpts).size === 4 &&
          tOpts.some((s) => /[:：]/.test(s)) &&
          dOpts.some((s) => s.includes("-")) &&
          dOpts.some((s) => s.includes("/"));
        // ② 切 12 小时 → `data-time12=on` + 刻度栏加宽 + 刻度文字带 AM/PM（或 上午/下午）
        tSel.value = "h12";
        tSel.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(80);
        const t12 = document.documentElement.dataset.time12 === "on";
        const gutter = getComputedStyle(document.documentElement).getPropertyValue("--gutter-width").trim();
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const tick = [...document.querySelectorAll(".timeline .tick")].map((n) => n.textContent).join(" ");
        const tick12 = /AM|PM|上午|下午/.test(tick);
        // ②b（round82 §5-DP）：迷你周视图的刻度**同口径** —— 12 小时档下轴标签也带 AM/PM（或 上午/下午）
        document.querySelector(".templates-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(240);
        const miniTicks = [...document.querySelectorAll("[data-tpl-mini] .axis b")].map((n) => n.textContent).join(" ");
        const miniTicks12 = /AM|PM|上午|下午/.test(miniTicks);
        document.querySelector(".tpl-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        // ③ 极端档（12 小时 + 长式日期）下跑全屏溢出扫描（715 那一跑是靶场）——
        //    `scanOverflow` 自己开关面板，跑完是关着的
        await openSettingsSub();
        const dLong = document.querySelector(".sanity-pop select.date-format");
        dLong.value = "long";
        dLong.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(80);
        const offenders = await scanOverflow();
        // ④ 切 date=dash → 周范围变成 2026-xx-xx
        await openSettingsSub();
        const d2 = document.querySelector(".sanity-pop select.date-format");
        d2.value = "dash";
        d2.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(80);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const rangeText = document.querySelector(".timeline .range")?.textContent ?? "";
        const rangeDash = /\d{4}-\d{2}-\d{2}/.test(rangeText);
        // ⑤ 写失败 → 控件拨回（__FAIL_SET_SETTING_ONCE）
        await openSettingsSub();
        const t3 = document.querySelector(".sanity-pop select.time-format");
        const beforeT = t3.value;
        window.__FAIL_SET_SETTING_ONCE = true;
        t3.value = beforeT === "h24" ? "h12" : "h24";
        t3.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(80);
        const reverted = t3.value === beforeT;
        window.__DIAG.push(
          `r81③ 样例=[${tOpts.join(" | ")}] [${dOpts.join(" | ")}] 选项样例=${optsOk} data12=${t12} gutter=${gutter} 刻度12=${tick12} 迷你刻度12=${miniTicks12} 周范围 dash=${rangeDash}（${rangeText}） 长式溢出=${offenders.length}${offenders.length ? "——" + offenders.slice(0, 3).join(" / ") : ""} 写失败拨回=${reverted}`,
        );
        return optsOk && t12 && gutter === "72px" && tick12 && miniTicks12 && rangeDash && offenders.length === 0 && reverted;
      },
    ],
    [
      "round81 ④：列宽自适应 / 时间刻度 / Ctrl+滚轮分区 / 双击复位 / 复位布局（宽-01…10）",
      async () => {
        await press("Escape");
        await settle(30);
        const slotVar = () => getComputedStyle(document.documentElement).getPropertyValue("--slot-height").trim();
        const widthNow = () => Number(document.querySelector(".splitter")?.getAttribute("aria-valuenow") ?? -1);
        const dayRects = () => [...document.querySelectorAll(".timeline .day")].map((d) => d.getBoundingClientRect());
        const slotList = Array.from({ length: 24 }, (_, i) => 18 + i * 2); // round82（11.6）：18–64
        const densityName = () => document.documentElement.dataset.density ?? "comfortable";
        const densitySlot = () => ({ compact: 26, comfortable: 30, loose: 34 }[densityName()] ?? 30);
        const entrySlot = String(window.__SANITY_STATE?.slotHeight ?? "auto");
        // 兜底：把时间刻度拨回入口值（中途抛错也不留在手动档）
        window.__RESTORE = window.__RESTORE || [];
        window.__RESTORE.push(async () => {
          window.__FAIL_SET_SETTING_ONCE = false;
          await openSettingsSub();
          const sel = document.querySelector(".sanity-pop select.slot-height");
          if (sel && sel.value !== entrySlot) {
            sel.value = entrySlot;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            await settle(60);
          }
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        });
        // 指针事件：合成 `wheel` + `ctrlKey`（真路径由真正的 CDP 探针另行覆盖；这里验分区与累积）
        const fire = (el, deltaY) =>
          el?.dispatchEvent(new WheelEvent("wheel", { deltaY, ctrlKey: true, bubbles: true, cancelable: true }));
        // —— ① 列宽：等宽 / ≥112 / 要么填满右侧、要么横向滚动（宽-03）
        const rects0 = dayRects();
        const widths = rects0.map((r) => Math.round(r.width));
        const board = document.querySelector(".timeline .board");
        const overflow0 = (board?.scrollWidth ?? 0) > (board?.clientWidth ?? 0) + 2;
        const equal = widths.length > 0 && Math.max(...widths) - Math.min(...widths) <= 1;
        const minOk = widths.every((w) => w >= 111);
        const filled =
          overflow0 || (rects0.length > 0 && Math.abs((board?.getBoundingClientRect().right ?? 0) - rects0.at(-1).right) <= 3);
        const cols7 = rects0.length === 7;
        // —— ② 时间刻度：设置里选 26 → CSS 变量与刻度行高都是 26；回 auto 跟密度
        await openSettingsSub();
        const slotSel = document.querySelector(".sanity-pop select.slot-height");
        if (!slotSel) return false;
        const tickH = () => Math.round(document.querySelector(".timeline .tick")?.getBoundingClientRect().height ?? 0);
        slotSel.value = "26";
        slotSel.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(80);
        const slot26 = slotVar() === "26px" && tickH() === 26;
        // —— ③ 密度切换不吃手动值（宽-10）：切 loose → 仍是 26；再回入口密度 → 仍 26；最后回 auto 跟密度
        const entryDensity = densityName();
        document.querySelector('.sanity-pop .density[data-value="loose"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(80);
        const manualKept = slotVar() === "26px";
        if (entryDensity !== "loose") {
          document.querySelector(`.sanity-pop .density[data-value="${entryDensity}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(80);
        }
        slotSel.value = "auto";
        slotSel.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(80);
        const autoFollows = slotVar() === `${densitySlot()}px`;
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        // —— ④ 双击刻度栏复位（先手动 26 → 双击 → 回密度档）
        await openSettingsSub();
        const sel4 = document.querySelector(".sanity-pop select.slot-height");
        sel4.value = "26";
        sel4.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(80);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const manual26 = slotVar() === "26px";
        document
          .querySelector(".timeline .gutter")
          ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        await settle(60);
        const rulerReset = manual26 && slotVar() === `${densitySlot()}px`;
        // —— ⑤ Ctrl+滚轮：**只在时间轴**接管（= 时间刻度；round83 回修按你要求撤掉「分隔条 = 栏宽」）——
        //   分隔条上滚不该再改栏宽（栏宽改回拖动 / 双击复位 / ←→），Backlog 与浮层开着也不接管
        const splitter = document.querySelector(".splitter");
        const w0 = widthNow();
        for (let i = 0; i < 3; i++) {
          fire(splitter, -100);
          await settle(20);
        }
        const widthUntouched = w0 >= 0 && widthNow() === w0;
        // 时间轴：一档一档走（当前是 auto = 密度档 → 上一档）
        const idxOf = (px) => slotList.indexOf(px);
        const before5 = slotVar();
        fire(board, -100);
        await settle(60);
        const step1 = idxOf(parseFloat(slotVar())) - idxOf(parseFloat(before5)) === 1;
        // 触控板：连发 20 × -5 = 100 → 再一档（不是 20 档）
        const mid5 = slotVar();
        for (let i = 0; i < 20; i++) {
          fire(board, -5);
          await settle(5);
        }
        await settle(40);
        const accOk = idxOf(parseFloat(slotVar())) - idxOf(parseFloat(mid5)) === 1;
        // 其它位置（Backlog）不接管 —— 6b P2：以前 `?? document.body` 会在类名变了之后恒真，直接失败更好
        const neutralEl = document.querySelector(".backlog");
        if (!neutralEl) return false;
        const neutralBefore = slotVar();
        fire(neutralEl, -100);
        await settle(40);
        const neutralUntouched = slotVar() === neutralBefore;
        // 浮层开着不接管（总览）—— 6b P2：面板没开时前后相等 = 恒真 → 先确认它真开了
        await openStatsPanel();
        await settle(60);
        if (!document.querySelector(".stats-panel")) return false;
        const panelBefore = slotVar();
        fire(document.querySelector(".timeline .board"), -100);
        await settle(40);
        const panelUntouched = slotVar() === panelBefore;
        await shutStats();
        await settle(40);
        // —— ⑥ 首次用给一条轻提示（宽-09；假后端默认不武装，这里临时武装）
        document.querySelector('[data-guide="hint"] .dismiss')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        window.__HINTS_ARMED = true;
        window.__HINTS_SEEN = (window.__HINTS_SEEN || []).filter((x) => x !== "zoom");
        fire(document.querySelector(".timeline .board"), -100);
        await settle(80);
        const hintShown = /Ctrl\+/.test(document.querySelector(String.raw`[data-guide="hint"] .text`)?.textContent ?? "");
        document.querySelector('[data-guide="hint"] .dismiss')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        window.__HINTS_ARMED = false;
        // 收尾：把刻度拨回 auto（后面的复位布局还要用它当脏值）
        await openSettingsSub();
        const selR = document.querySelector(".sanity-pop select.slot-height");
        selR.value = "auto";
        selR.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(60);
        // —— ⑥b（round82 §5-DP）：写失败 → 控件拨回（`commitSlotHeight`；刻度留在 auto）
        const slotBeforeFail = slotVar();
        const selFailWrite = document.querySelector(".sanity-pop select.slot-height");
        window.__FAIL_SET_SETTING_ONCE = true;
        selFailWrite.value = "64";
        selFailWrite.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(80);
        const slotWriteRevert = selFailWrite.value === "auto" && slotVar() === slotBeforeFail;
        window.__FAIL_SET_SETTING_ONCE = false;
        // —— ⑦ 隐藏周末：5 列均分（不右侧留白）
        const wk = document.querySelector("#settings-group-timeline .row.switch input[type=checkbox]");
        if (wk?.checked) {
          wk.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(80);
        }
        const rects5 = dayRects();
        const board5 = document.querySelector(".timeline .board");
        const overflow5 = (board5?.scrollWidth ?? 0) > (board5?.clientWidth ?? 0) + 2;
        const equal5 =
          rects5.length === 5 && Math.max(...rects5.map((r) => Math.round(r.width))) - Math.min(...rects5.map((r) => Math.round(r.width))) <= 1;
        const filled5 = overflow5 || Math.abs((board5?.getBoundingClientRect().right ?? 0) - rects5.at(-1).right) <= 3;
        // —— ⑧ 复位布局（宽-05）：把刻度 32 / 隐藏周末 / 键位提示隐藏 / 栏宽 +8 全部弄脏 → 一键收回
        const sel8 = document.querySelector(".sanity-pop select.slot-height");
        sel8.value = "32";
        sel8.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(60);
        const hb = document.querySelector(".sanity-pop select.hint-mode");
        if (hb && hb.value !== "hidden") {
          hb.value = "hidden";
          hb.dispatchEvent(new Event("change", { bubbles: true }));
          await settle(60);
        }
        const wMd = widthNow();
        const weekMd = document.querySelector(".timeline .range")?.textContent?.trim() ?? "";
        // 浮层开着时滚轮**不接管**（刚验过）→ 栏宽要在关面板之后再动
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        // round83 回修：分隔条上的 Ctrl+滚轮按你要求撤了 → 改用**键盘**（←/→，保留的通路）把栏宽弄脏
        // （顺带覆盖分隔条的指针外通路：WCAG 要求「只有拖拽一个入口不够」）
        document
          .querySelector(".splitter")
          ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
        await settle(60);
        // round83 回修拓出来的真 bug：分隔条上按 ←/→ 只该改栏宽，**不该顺带跳周**
        const weekAfterSplitter = document.querySelector(".timeline .range")?.textContent?.trim() ?? "";
        const splitterNoWeekJump = weekMd.length > 0 && weekAfterSplitter === weekMd;
        const dirty =
          slotVar() === "32px" && widthNow() === wMd + 10 && window.__SANITY_STATE?.hintBarMode === "hidden";
        const dirtyParts = `脏=${slotVar()}/${wMd}→${widthNow()}/${window.__SANITY_STATE?.hintBarMode} 分隔条不跳周=${splitterNoWeekJump}`;
        await openSettingsSub();
        document.querySelector(".sanity-pop .reset-layout")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        const wantWidth = densityName() === "compact" ? 240 : densityName() === "loose" ? 280 : 260;
        const resetOk =
          slotVar() === `${densitySlot()}px` &&
          widthNow() === wantWidth &&
          // 6b P2：复位最容易错的是「内存改了、库没改」—— 两条也读假库的写入值
          window.__SANITY_STATE?.slotHeight === "auto" &&
          window.__SANITY_STATE?.backlogWidth === wantWidth &&
          window.__SANITY_STATE?.hintBarMode === "always" &&
          window.__SANITY_STATE?.weekendHidden === false &&
          window.__SANITY_STATE?.backlogPane === "open";
        const resetToast = !!document.querySelector(".toast-layer .toast");
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        // —— ⑨ 复位**失败路径**（6b P2）：有一键没写成 → 界面不许说“已复位”，要以库为准拉回来
        await openSettingsSub();
        const selF = document.querySelector(".sanity-pop select.slot-height");
        selF.value = "32";
        selF.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(60);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const widthBeforeFail = widthNow();
        await openSettingsSub();
        window.__FAIL_SET_SETTING_ONCE = true; // 让 5 次写里的**某一次**失败（哪一条不保证 → 就验“不撒谎”这条不变量）
        document.querySelector(".sanity-pop .reset-layout")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(200);
        // 不变量：界面（变量 / aria）永远等于**库里真正生效的值**（哪条失败都不许界面自作主张）
        const dbSlot = window.__SANITY_STATE?.slotHeight;
        const dbWidth = Number(window.__SANITY_STATE?.backlogWidth);
        const failSynced =
          widthNow() === dbWidth &&
          slotVar() === (dbSlot === "auto" ? `${densitySlot()}px` : `${dbSlot}px`);
        const failDiag = `失败路径 栏宽=${widthBeforeFail}→UI${widthNow()}/库${dbWidth} 刻度 UI${slotVar()}/库${dbSlot}`;
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        window.__DIAG.push(
          `r81④ 列宽=[${widths.join(",")}] 等宽=${equal} ≥112=${minOk} 填满=${filled} 溢出=${overflow0} 7列=${cols7} ｜ 刻度26=${slot26} 密度不吃手动值=${manualKept} auto跟密度=${autoFollows} 双击复位=${rulerReset} 写失败拨回=${slotWriteRevert} ｜ 滚轮 分隔条不动锁=${widthUntouched} 上滚一档=${step1} 累积=${accOk} 其它位置不接管=${neutralUntouched} 浮层不接管=${panelUntouched} 提示=${hintShown} ｜ 5列等宽=${equal5} 填满=${filled5} 溢出=${overflow5} ｜ 复位脏=${dirty}（${dirtyParts}）复位=${resetOk} toast=${resetToast} ｜ ${failDiag} 不撒谎=${failSynced}`,
        );
        return (
          equal && minOk && filled && cols7 &&
          slot26 && manualKept && autoFollows && rulerReset && slotWriteRevert &&
          widthUntouched && step1 && accOk && neutralUntouched && panelUntouched && hintShown &&
          equal5 && filled5 && dirty && splitterNoWeekJump && resetOk && resetToast && failSynced
        );
      },
    ],
    [
      "round81 ⑤：语言「跟随系统」—— 默认档 / 选项标解析结果 / 切档即时生效 / 后台校准同源",
      async () => {
        await press("Escape");
        await settle(30);
        await openSettingsSub();
        const sel = document.querySelector(".sanity-pop select.lang");
        if (!sel) return false;
        const was = sel.value;
        window.__RESTORE = window.__RESTORE || [];
        window.__RESTORE.push(async () => {
          await openSettingsSub();
          const s = document.querySelector(".sanity-pop select.lang");
          if (s && s.value !== was) {
            s.value = was;
            s.dispatchEvent(new Event("change", { bubbles: true }));
            await settle(80);
          }
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        });
        const optionText = (v) => [...sel.options].find((o) => o.value === v)?.textContent?.trim() ?? "";
        const navText = () => (document.querySelector('.sanity-pop .nav-btn[data-group="timeline"]')?.textContent ?? "").trim();
        // ① 选项里标出解析结果（入口档位可能被前面的断言改过，不强求是 system —— DIAG 里记）
        const entryOk = was === "system";
        const labelled = /跟随系统|Follow system/.test(optionText("system")) && /中文|Chinese|English/.test(optionText("system"));
        // ② 切 en：`<html lang>` + 界面文案即时变（不重启）
        sel.value = "en";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(140);
        const enApplied = document.documentElement.lang === "en" && /Timeline/.test(navText());
        // ③ 切回 system：前端 navigator + Rust `system_locale`（假后端 = zh-CN）→ 中文；档位也真的落库
        // 6b P2：校准次数要**看增量**（从页面加载起的计数在默认档下启动必调一次，`>=1` 恒真）
        const calls0 = window.__SYSTEM_LOCALE_CALLS || 0;
        sel.value = "system";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(140);
        const sysApplied =
          document.documentElement.lang === "zh-CN" && /时间轴/.test(navText()) && sel.value === "system";
        const wrote = (window.__LAST_SETTING?.[0] ?? "") === "ui_locale" && window.__LAST_SETTING?.[1] === "system";
        const calib = (window.__SYSTEM_LOCALE_CALLS || 0) === calls0 + 1;
        window.__DIAG.push(
          `r81⑤ 入口档=${was}（是否默认档=${entryOk}）选项标解析=${labelled}（${optionText("system")}）切en=${enApplied} 切system=${sysApplied} 写=${JSON.stringify(window.__LAST_SETTING)} 校准调用=${calls0}→${window.__SYSTEM_LOCALE_CALLS || 0}`,
        );
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        return labelled && enApplied && sysApplied && wrote && calib;
      },
    ],
    // ===== round82（3.1c₂）直修组：窄块动作浮层三档排布（11.2）=====
    [
      "round82 ①：迷你周视图重叠块并排 —— 任意两块不相交 / 名字只在块宽 ≥30px 时画（11.1）",
      async () => {
        await press("Escape");
        await settle(20);
        if (window.innerWidth <= 860) {
          return { skip: "窄窗（≤860）浮窗本就不显示；1100 那一跑才是它的靶场" };
        }
        document
          .querySelector(".templates-open")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(240);
        const pv = document.querySelector("[data-tpl-preview]");
        if (!pv) return false;
        const prevW = pv.style.width;
        const prevH = pv.style.height;
        pv.style.width = "440px";
        pv.style.height = "320px";
        await frames(4);
        const mini = document.querySelector("[data-tpl-mini]");
        const blocks = [...(mini?.querySelectorAll(".blk") ?? [])];
        if (blocks.length < 2) return false;
        // ① 任意两块的外接矩形不相交 —— 不同天的块横向本就不重叠，所以全局两两查与「同一列内查」等价
        const rects = blocks.map((b) => b.getBoundingClientRect());
        let overlap = 0;
        const ovInfo = [];
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const ix = Math.min(rects[i].right, rects[j].right) - Math.max(rects[i].left, rects[j].left);
            const iy = Math.min(rects[i].bottom, rects[j].bottom) - Math.max(rects[i].top, rects[j].top);
            if (ix > 0.5 && iy > 0.5) {
              overlap += 1;
              if (ovInfo.length < 3) {
                ovInfo.push(`${blocks[i].dataset.row}/${blocks[j].dataset.row} ${ix.toFixed(1)}×${iy.toFixed(1)}`);
              }
            }
          }
        }
        const cols = blocks.map((b) => Number(b.dataset.cols) || 1);
        const narrow = cols.filter((c) => c > 1).length;
        const maxCols = Math.max(...cols);
        // ② 名字只在宽度够（≥30px）时画 —— 宽档画、窄档不画
        const nameTooNarrow = blocks.filter(
          (b) => b.querySelector(".nm") && b.getBoundingClientRect().width < 30,
        ).length;
        const widths = [...new Set(blocks.map((b) => Math.round(b.getBoundingClientRect().width)))].sort(
          (a, b) => a - b,
        );
        const grid0 = mini.querySelector(".grid");
        const gx0 = grid0.getBoundingClientRect().left;
        const geo = blocks
          .map((b) => {
            const r = b.getBoundingClientRect();
            return `${Math.round(r.left - gx0)}+${Math.round(r.width)}`;
          })
          .join(" ");
        const named = blocks.filter((b) => b.querySelector(".nm")).length;
        pv.style.width = prevW;
        pv.style.height = prevH;
        document.querySelector(".tpl-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        window.__DIAG.push(
          `r82① 块=${blocks.length} 并排块=${narrow} 最大列数=${maxCols} 重叠对=${overlap}${
            ovInfo.length ? "（" + ovInfo.join(" ") + "）" : ""
          } 画名字=${named}/名字越界=${nameTooNarrow} 块宽=[${widths.join(",")}] 坐标=${geo}`,
        );
        return overlap === 0 && narrow > 0 && maxCols >= 2 && nameTooNarrow === 0;
      },
    ],
    [
      "round82 ③：名字按块高多行（不封顶）—— 行数与块高一致 / 不越出块（11.3）",
      async () => {
        await press("Escape");
        await settle(30);
        const metaPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-meta")) || 12;
        const line = metaPx * 1.2;
        const pairs = [...document.querySelectorAll("[data-block-id]")]
          .map((inner) => ({ inner, host: inner.closest(".block") }))
          .filter((x) => x.host && x.inner.querySelector(".label"));
        let checked = 0;
        let multi = 0;
        let budgetBad = 0;
        const info = [];
        // ① 行数预算：data-label-lines 必须 = 按块高 / 行高 / 第二行算出来的值（±1，取整）
        for (const { inner, host } of pairs) {
          const h = host.getBoundingClientRect().height;
          const lines = Number(inner.dataset.labelLines) || 1;
          const hasSecond = inner.querySelector(".time") !== null;
          const expected = Math.max(1, Math.floor((h - 2 - (hasSecond ? metaPx * 1.4 : 0)) / line));
          checked += 1;
          if (lines > 1) multi += 1;
          if (Math.abs(lines - expected) > 1) {
            budgetBad += 1;
            if (info.length < 4) info.push(`预算 h${Math.round(h)} 行${lines} 算${expected}`);
          }
        }
        // ② 真的多行 / 真的钳位：把名字换成一句长话再量（用假数据的长名字容易被块宽逗弄，所以自己造）
        const long = "把这一周的设计稿全部整理一遍再交给同事看一遍并改一遍";
        const probe = async ({ inner, host }) => {
          const label = inner.dataset.labelLines ? inner.querySelector(".label") : null;
          if (!label) return null;
          const prev = label.textContent ?? "";
          label.textContent = long;
          await frames(2);
          const budget = Number(inner.dataset.labelLines) || 1;
          const lr = label.getBoundingClientRect();
          const hr = host.getBoundingClientRect();
          const rendered = Math.max(1, Math.round(lr.height / line));
          const clamped = label.scrollHeight > label.clientHeight + 1;
          const fitsBudget = lr.height <= budget * line + 3;
          const inside = lr.bottom <= hr.bottom + 0.5;
          label.textContent = prev;
          return { budget, rendered, clamped, fitsBudget, inside, h: Math.round(hr.height), lh: Math.round(lr.height) };
        };
        // ②a 高块：长句要能换行（≥2 行）且不超预算
        const tallPick = pairs.find(({ inner }) => (Number(inner.dataset.labelLines) || 1) >= 3);
        const tall = tallPick ? await probe(tallPick) : null;
        const tallOk = !!tall && tall.rendered >= 2 && tall.fitsBudget && tall.inside;
        // ②b 窄块（并排）：多行同样要生效
        const narrowPick = pairs.find(
          ({ inner }) => Number(inner.dataset.cols) >= 2 && (Number(inner.dataset.labelLines) || 1) >= 2,
        );
        const narrow = narrowPick ? await probe(narrowPick) : null;
        const narrowOk = !!narrow && narrow.rendered >= 2 && narrow.fitsBudget && narrow.inside;
        // ②c 预算最小（2 行）的块：长句超过预算时必须真的被钳位（而不是溢出去 / 粗截）
        const tightPick = pairs.find(({ inner }) => (Number(inner.dataset.labelLines) || 1) === 2);
        const tight = tightPick ? await probe(tightPick) : null;
        const clampOk = !!tight && tight.clamped && tight.fitsBudget && tight.inside;
        window.__DIAG.push(
          `r82③ 样本=${checked} 多行块=${multi} 预算违规=${budgetBad}${info.length ? "（" + info.join(" ") + "）" : ""} ｜ 高块=${JSON.stringify(tall)} 窄块=${JSON.stringify(narrow)} 钳位=${JSON.stringify(tight)} 行高=${line}`,
        );
        return budgetBad === 0 && checked > 0 && multi > 0 && tallOk && narrowOk && clampOk;
      },
    ],
    [
      "round82 ②：并排块浮层三档排布 —— 固定宽 / 不竖排 / 命中区 ≥24（11.2 直修）",
      async () => {
        await press("Escape");
        await backToThisWeek();
        await settle(40);
        // `.box` 的内联 width 百分比就是并排档位（100% → 1；50% → 2；33.33% → 3…）
        const rows = [...document.querySelectorAll(".day-body .box")]
          .map((box) => {
            const inner = box.querySelector("[data-block-id]");
            const acts = inner?.querySelector(".actions");
            if (!inner || !acts) return null;
            const pct = Number((String(box.style.width).match(/[\d.]+/) || [0])[0]);
            const cols = Number(inner.dataset.cols) || (pct > 0 ? Math.round(100 / pct) : 1);
            const ar = acts.getBoundingClientRect();
            const br = inner.getBoundingClientRect();
            const btns = [...acts.querySelectorAll("button")].map((b) => {
              const r = b.getBoundingClientRect();
              return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) };
            });
            return {
              id: inner.dataset.blockId,
              cols,
              bw: Math.round(br.width),
              aw: Math.round(ar.width),
              ah: Math.round(ar.height),
              btns,
            };
          })
          .filter(Boolean);
        // 规格（11.2 · 2026-10-07 你二轮改口径：「只要浮层宽度/行数会随着块的宽度调整就好」）：
        //   N=1（常规块）—— 一排四个 32px，跟随内容：n*32 + (n-1)*4 + padding 4 + border 2
        //   窄块（并排）—— **24px 按钮 + flex-wrap**，宽度封在块内（`max-width: calc(100% - 4px)`）：
        //     每行能放几枚 = floor((浮层宽 − padding 4 − border 2 + gap 4) / (24+4))；行数 = ceil(n / 每行)
        //     **不溢出块**（不压邻列）是这轮的硬判据
        const bad = [];
        let nWideRows = 0;
        for (const r of rows) {
          const n = r.btns.length;
          if (r.cols <= 1) {
            const expW = n * 32 + (n - 1) * 4 + 4 + 2;
            const awOk = Math.abs(r.aw - expW) <= 2;
            const btnOk = n > 0 && r.btns.every((b) => b.w === 32 && b.h === 32);
            if (!awOk || !btnOk) bad.push({ ...r, why: "wide", expW });
            else nWideRows += 1;
            continue;
          }
          const perRow = Math.max(1, Math.floor((r.aw - 2) / 28));
          const rowCount = Math.ceil(n / perRow);
          const expH = rowCount * 24 + (rowCount - 1) * 4 + 4 + 2;
          const grouped = new Map();
          for (const b of r.btns) grouped.set(b.y, (grouped.get(b.y) || 0) + 1);
          const rowsSeen = [...grouped.values()].sort((a, b) => b - a);
          const fitOk = r.aw <= r.bw - 1; // 浮层不超出块
          const btnOk = n > 0 && r.btns.every((b) => b.w === 24 && b.h === 24);
          const hOk = Math.abs(r.ah - expH) <= 4;
          const packOk = rowsSeen.length === rowCount && rowsSeen[0] <= perRow;
          if (!fitOk || !btnOk || !hOk || !packOk) {
            bad.push({ ...r, why: "narrow", perRow, rowCount, expH, rowsSeen, fitOk, btnOk, hOk, packOk });
          }
        }
        const kinds = [...new Set(rows.map((r) => (r.cols >= 3 ? 3 : r.cols)))].sort().join("/");
        const nWide = rows.filter((r) => r.cols === 1).length;
        window.__DIAG.push(
          `r82② 样本=${rows.length}（宽档 ${nWide} 合规 ${nWideRows}） 档位=${kinds} 违规=${bad.length} ` +
            JSON.stringify(bad.slice(0, 4)),
        );
        // 全量跑时页面可能已被前面的用例改成「同一时段很密」（宽档样本可能没有）——
        // 三档的完整取样由 `--only round82` 的那一趟负责（验收里写明）；这里要求两个并排档都在 + 零违规
        return bad.length === 0 && kinds.includes("2") && kinds.includes("3");
      },
    ],
    [
      "round82 ④：统计入口四象限（功能开关口径）+ `S` 键新语义（11.5 / round83 修）",
      async () => {
        await press("Escape");
        await settle(20);
        const reviewOpen = () => !!document.querySelector(".review-panel");
        const statsOpen = () => !!document.querySelector(".stats-panel");
        const inReview = () => !!document.querySelector(".review-panel .stats-open");
        const inBar = () => !!document.querySelector(".head-actions .stats-open");
        await backToThisWeek();
        await press("Escape");
        await settle(30);
        // 功能开关两行（走设置页的公共工具；关面板不碍事）—— 保证起手是已知状态
        const featureOk =
          (await setFeatureViaGear("数据统计", true)) && (await setFeatureViaGear("一周总览", true));
        // —— 象限 ①：总览开 + 统计开 ——
        // round83 修的这半：**面板没开时顶栏也不该有**独立按钮（口径 = 功能开关，不是面板）
        const q1Idle = !reviewOpen() && !statsOpen() && !inBar();
        // 面板开着 → 入口在总览面板里（顶栏无）；点它 → 子层；`Esc` 只关子层
        await press("o");
        await settle(220);
        const q1Open = reviewOpen() && inReview() && !inBar();
        document.querySelector(".review-panel .stats-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(220);
        const q1Child = reviewOpen() && statsOpen();
        await press("Escape");
        await settle(140);
        const escChild = reviewOpen() && !statsOpen();
        // `S`：总览开着 → 开子层；再按 → 只关子层（总览还在）
        await press("s");
        await settle(220);
        const sOn = statsOpen() && reviewOpen();
        await press("s");
        await settle(180);
        const sOff = !statsOpen() && reviewOpen();
        await press("Escape");
        await settle(160);
        // `S`（round83 新语义）：总览没开 → **先开总览 + 统计子层**（不再是旧语义的独立面板）
        await press("s");
        await settle(240);
        const sFromClosed = reviewOpen() && statsOpen() && inReview();
        await press("Escape");
        await settle(140);
        await press("Escape");
        await settle(160);
        const sParentOk = !reviewOpen() && !statsOpen();
        // —— 象限 ②：总览开 + 统计关 ——
        await setFeatureViaGear("数据统计", false);
        await press("o");
        await settle(220);
        const q2Open = reviewOpen() && !inReview() && !inBar();
        await press("o");
        await settle(180);
        await press("s");
        await settle(200);
        const q2S = !reviewOpen() && !statsOpen(); // 统计键：统计关 → 不动
        const q2Idle = !inBar();
        // —— 象限 ③：总览关 + 统计开 ——
        await setFeatureViaGear("数据统计", true);
        await setFeatureViaGear("一周总览", false);
        const q3Bar = !reviewOpen() && inBar();
        document.querySelector(".head-actions .stats-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(220);
        const q3Open = statsOpen() && !reviewOpen();
        await press("Escape");
        await settle(140);
        await press("s");
        await settle(220);
        const q3S = statsOpen() && !reviewOpen();
        await press("Escape");
        await settle(140);
        // —— 象限 ④：都关 ——
        await setFeatureViaGear("数据统计", false);
        const q4Bar = !inBar();
        await press("s");
        await settle(200);
        const q4S = !statsOpen() && !reviewOpen();
        // 还原两个开关（默认全开）
        const back1 = await setFeatureViaGear("数据统计", true);
        const back2 = await setFeatureViaGear("一周总览", true);
        window.__DIAG.push(
          `r82④ 开关工具=${featureOk} ①待机无按钮=${q1Idle} ①面板内=${q1Open} 子层=${q1Child} Esc只关子层=${escChild} ` +
            `S开=${sOn} S关=${sOff} S从关起=${sFromClosed} 父关带走子=${sParentOk} ` +
            `②面板内无=${q2Open} ②待机无=${q2Idle} ②S不动=${q2S} ` +
            `③独立按钮=${q3Bar} ③点开=${q3Open} ③S=${q3S} ④无=${q4Bar} ④S不动=${q4S} 还原=${back1}/${back2}`,
        );
        return (
          featureOk &&
          q1Idle &&
          q1Open &&
          q1Child &&
          escChild &&
          sOn &&
          sOff &&
          sFromClosed &&
          sParentOk &&
          q2Open &&
          q2Idle &&
          q2S &&
          q3Bar &&
          q3Open &&
          q3S &&
          q4Bar &&
          q4S &&
          back1 &&
          back2
        );
      },
    ],
    [
      "round82 ⑨：`?` 总表「鼠标」组 · 轻提示与表同源（11.4；round83 回修：栏宽那条撤掉）",
      async () => {
        await closeSettings();
        await press("Escape");
        await settle(20);
        // round82（Step 4 踩过的坑）：下面的 Ctrl+滚轮会把「时间刻度」从 auto 写成手动档（auto 30 → 32）。
        // 不还原 = 后面的全矩阵按密度核 --slot-height 全部假红（实测 74/74 红）。入口值照 ⑦ 的口径存。
        const entrySlot = String(window.__SANITY_STATE?.slotHeight ?? "auto");
        window.__RESTORE = window.__RESTORE || [];
        window.__RESTORE.push(async () => {
          await openSettingsSub();
          const s = document.querySelector(".sanity-pop select.slot-height");
          if (s && s.value !== entrySlot) {
            s.value = entrySlot;
            s.dispatchEvent(new Event("change", { bubbles: true }));
            await settle(60);
          }
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        });
        await press("?");
        await settle(40);
        const panel = document.querySelector(".keymap-panel");
        if (!panel) return false;
        const text = panel.textContent ?? "";
        const groupOk = /鼠标|Mouse/.test(text);
        const paneInText = /调整栏宽|Adjust pane|Resize pane/i.test(text);
        const slotLabel = /调整时间刻度|time scale|Adjust time/i.test(text);
        await press("Escape");
        await settle(30);
        // 轻提示（首次用 Ctrl+滚轮）：提示里的两个动作词必须与表里**实际渲染**出来的那两个一致
        document.querySelector('[data-guide="hint"] .dismiss')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__HINTS_ARMED = true;
        window.__HINTS_SEEN = (window.__HINTS_SEEN || []).filter((x) => x !== "zoom");
        document.querySelector(".timeline .board")?.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }),
        );
        await settle(80);
        const hintText = document.querySelector('[data-guide="hint"] .text')?.textContent ?? "";
        const rows = [...panel.querySelectorAll("tr")].filter((tr) => tr.querySelectorAll("td").length === 2);
        const labels = rows.map((tr) => tr.querySelectorAll("td")[1]?.textContent?.trim() ?? "").filter(Boolean);
        const labelSlot = labels.find((x) => /刻度|scale|time/i.test(x));
        // round83 回修：「分隔条 = 栏宽」撤掉后——表里不该再有「栏宽」这类动作，轻提示也只说时间刻度
        const paneLabel = labels.find((x) => /栏宽|pane width|Resize pane/i.test(x));
        const sameSource = !!labelSlot && hintText.includes(labelSlot);
        document.querySelector('[data-guide="hint"] .dismiss')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        window.__HINTS_ARMED = false;
        window.__DIAG.push(
          `r82④ 组=${groupOk} 刻度=${slotLabel} 文本无栏宽=${!paneInText} 栏宽行=${paneLabel ?? "无"} 同源=${sameSource} 提示="${hintText}"`,
        );
        return groupOk && slotLabel && !paneInText && !paneLabel && sameSource;
      },
    ],
    [
      "round82 ⑦：时间刻度区间 18–64 —— 设置下拉 24 档 / Ctrl+滚轮上下限夹住（11.6 直修）",
      async () => {
        await press("Escape");
        await settle(30);
        const slotVar = () => getComputedStyle(document.documentElement).getPropertyValue("--slot-height").trim();
        const entrySlot = String(window.__SANITY_STATE?.slotHeight ?? "auto");
        window.__RESTORE = window.__RESTORE || [];
        window.__RESTORE.push(async () => {
          await openSettingsSub();
          const s = document.querySelector(".sanity-pop select.slot-height");
          if (s && s.value !== entrySlot) {
            s.value = entrySlot;
            s.dispatchEvent(new Event("change", { bubbles: true }));
            await settle(60);
          }
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        });
        await openSettingsSub();
        const sel = document.querySelector(".sanity-pop select.slot-height");
        if (!sel) return false;
        const nums = [...sel.options].map((o) => o.value).filter((v) => v !== "auto").map(Number);
        const rangeOk = nums.length === 24 && nums[0] === 18 && nums.at(-1) === 64 && nums.every((n, i) => n === 18 + i * 2);
        const fire = (deltaY) =>
          document.querySelector(".timeline .board")?.dispatchEvent(
            new WheelEvent("wheel", { deltaY, ctrlKey: true, bubbles: true, cancelable: true }),
          );
        // 上限：64 再往上滚 → 不动；下限：18 再往下滚 → 不动
        sel.value = "64";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(60);
        fire(-100);
        await settle(40);
        const topClamp = slotVar() === "64px";
        // 极端档溢出扫描（Step 10 口径：18/64 两档都不许横向溢出；scanOverflow 自己开关面板 —— 跑完设置是关的）
        const overflow64 = await scanOverflow();
        await openSettingsSub();
        const sel18 = document.querySelector(".sanity-pop select.slot-height");
        if (!sel18) return false;
        sel18.value = "18";
        sel18.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(60);
        fire(100);
        await settle(40);
        const bottomClamp = slotVar() === "18px";
        const overflow18 = await scanOverflow();
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        // 收尾回 auto
        await openSettingsSub();
        const s2 = document.querySelector(".sanity-pop select.slot-height");
        s2.value = "auto";
        s2.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(60);
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        window.__DIAG.push(`r82⑦ 档位=${nums.length}（${nums[0]}–${nums.at(-1)}） 上限夹=${topClamp} 下限夹=${bottomClamp} 溢出64=${overflow64.length} 溢出18=${overflow18.length}`);
        return rangeOk && topClamp && bottomClamp && overflow64.length === 0 && overflow18.length === 0;
      },
    ],
    [
      "round82 ⑧：第三语言照 VS Code 口径 —— 选项只写解析结果（English），说明页给一句（11.7）",
      async () => {
        const savedTag = window.__SYSTEM_LOCALE;
        window.__SYSTEM_LOCALE = "ja-JP";
        await openSettingsSub();
        const sel = document.querySelector(".sanity-pop select.lang");
        if (!sel) {
          window.__SYSTEM_LOCALE = savedTag;
          return false;
        }
        const before = sel.value;
        window.__RESTORE = window.__RESTORE || [];
        window.__RESTORE.push(async () => {
          window.__SYSTEM_LOCALE = savedTag;
          await openSettingsSub();
          const s = document.querySelector(".sanity-pop select.lang");
          if (s && s.value !== before) {
            s.value = before;
            s.dispatchEvent(new Event("change", { bubbles: true }));
            await settle(80);
          }
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        });
        sel.value = "system";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(180);
        const text = [...sel.options].find((o) => o.value === "system")?.textContent ?? "";
        // round82（11.7 · 你 2026-10-07）：「照 VS Code 的做法来……不支持就直接用英文就好」——
        //  ① 选项里**不再**写「暂不支持」这类解释（旧写法已撕）；
        //  ② 选项仍然标出**解析结果**（中文 / English，round81 口径不变）；
        //  ③ 那句解释搬进**说明页**（说明页就是干这个的）
        const noNote = !/暂不支持|not supported|unavailable/i.test(text);
        const hasResolved = /（(中文|English)）|\((Chinese|English)\)/.test(text);
        const zhText = [...sel.options].find((o) => o.value === "zh")?.textContent ?? "";
        const zhClean = !/暂不支持|not supported/i.test(zhText);
        await openSettingsSub("guide");
        document.querySelector(".sanity-pop .help-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const helpText = document.querySelector(".help-panel #help-display")?.textContent ?? "";
        const helpSays =
          /一律用 English|falls back to English/i.test(helpText) && /中文 \/ English|Chinese \/ English/.test(helpText);
        document.querySelector(".help-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        window.__DIAG.push(
          `r82⑧ system 选项="${text.trim()}" 不解释=${noNote} 带解析结果=${hasResolved} zh 选项干净=${zhClean} 说明页=${helpSays}`,
        );
        return noNote && hasResolved && zhClean && helpSays;
      },
    ],
    [
      "round82 ⑥：夜间淡化 —— 带的位置 / z 序 / 不吃手势 / 迷你同步 / 到点重算（淡-04·05·09·10·12）",
      async () => {
        await press("Escape");
        await settle(30);
        const state = window.__SANITY_STATE ?? {};
        const entry = {
          theme: state.uiTheme ?? "system",
          dim: state.nightDim !== false,
          start: state.nightStart ?? "22:00",
          end: state.nightEnd ?? "06:00",
        };
        window.__RESTORE = window.__RESTORE || [];
        window.__RESTORE.push(async () => {
          await openSettingsSub();
          const pop = document.querySelector(".sanity-pop");
          const tb = pop?.querySelector(`.ui-theme [data-value="${entry.theme}"]`);
          if (tb && !tb.classList.contains("on")) {
            tb.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await settle(80);
          }
          const dim = pop?.querySelector("input.night-dim");
          if (dim && dim.checked !== entry.dim) {
            dim.checked = entry.dim;
            dim.dispatchEvent(new Event("change", { bubbles: true }));
            await settle(80);
          }
          for (const [sel, val] of [
            ["input.night-start", entry.start],
            ["input.night-end", entry.end],
          ]) {
            const inp = pop?.querySelector(sel);
            if (inp && inp.value !== val) {
              inp.value = val;
              inp.dispatchEvent(new Event("change", { bubbles: true }));
              await settle(80);
            }
          }
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
        });

        await openSettingsSub();
        // round82 踩过的坑：设置面板关掉后 `.sanity-pop` 会被销毁 —— 不能抓一个引用用到底，每次**现场查**
        const q = (sel) => document.querySelector(`.sanity-pop ${sel}`);
        if (!q("input.night-dim")) return false;
        // ①a（6b P2）：开关**关**的时候这一层不该渲染
        const dimOff = q("input.night-dim");
        if (dimOff?.checked) {
          dimOff.checked = false;
          dimOff.dispatchEvent(new Event("change", { bubbles: true }));
          await settle(80);
        }
        const bandsWhenOff = document.querySelectorAll(".day-body .dim-band").length;
        // ① 强制：淡化开 + 全天覆盖（00:00–23:59）—— 带必与任何可见块重叠，好量 z 序
        const dimBox = q("input.night-dim");
        if (dimBox && !dimBox.checked) {
          dimBox.checked = true;
          dimBox.dispatchEvent(new Event("change", { bubbles: true }));
          await settle(80);
        }
        const setTime = async (sel, value) => {
          const inp = q(sel);
          if (!inp) return false;
          inp.value = value;
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          await settle(90);
          return true;
        };
        if (!(await setTime("input.night-start", "00:00"))) return false;
        if (!(await setTime("input.night-end", "23:59"))) return false;
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);

        const bands = [...document.querySelectorAll(".day-body .dim-band")];
        const dayBodies = [...document.querySelectorAll(".timeline .day-body")];
        const rects = (b) => [...b.querySelectorAll("span")].map((s) => ({
          top: parseFloat(s.style.top),
          h: parseFloat(s.style.height),
        }));
        const full = bands.map(rects);
        const fullOk =
          bands.length === dayBodies.length &&
          bands.length > 0 &&
          full.every((segs) => segs.length === 1 && segs[0].top === 0 && segs[0].h > 99);
        // ② z 序（淡-09）：带是**第一个子元素**；块（同一列）在它后面；不吃手势
        const domOk = bands.every(
          (b) =>
            b.parentElement?.firstElementChild === b &&
            [...b.parentElement.querySelectorAll(":scope > .box")].every(
              (box) => b.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
        );
        const pointerOk = bands.every((b) => getComputedStyle(b).pointerEvents === "none");
        // ②b 行为量：带盖满整列时，块中心的**命中对象仍是块**（不是带）
        let hitOk = false;
        let hitInfo = "没找到可见块";
        for (const box of document.querySelectorAll(".day-body .box")) {
          const r = box.getBoundingClientRect();
          if (r.width < 20 || r.height < 8) continue;
          if (r.top < 4 || r.bottom > innerHeight - 4 || r.left < 4 || r.right > innerWidth - 4) continue;
          const node = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          hitOk = !!node?.closest(".box") && !node.closest(".dim-band");
          hitInfo = `${Math.round(r.width)}×${Math.round(r.height)} → ${node?.className || node?.tagName}`;
          break;
        }
        // ③ 跨天两段（淡-12）：22:00–06:00 → 每列 91.67–100% / 0–25%
        await openSettingsSub();
        await setTime("input.night-start", "22:00");
        await setTime("input.night-end", "06:00");
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const wrap = [...document.querySelectorAll(".day-body .dim-band")].map(rects);
        const near = (a, b) => Math.abs(a - b) < 0.2;
        const wrapOk =
          wrap.length === dayBodies.length &&
          wrap.every(
            (segs) =>
              segs.length === 2 &&
              near(segs[0].top, (1320 / 1440) * 100) &&
              near(segs[0].h, (120 / 1440) * 100) &&
              segs[1].top === 0 &&
              near(segs[1].h, 25),
          );
        // ④ 迷你周视图同步（淡-10）：同一个 token、线→带→块 的 DOM 顺序
        document.querySelector(".templates-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(240);
        const mini = document.querySelector("[data-tpl-mini]");
        const miniBand = mini?.querySelector(".grid .dim-band ");
        const miniSpans = miniBand ? miniBand.querySelectorAll("i").length : 0;
        const miniBeforeBlocks = !!miniBand &&
          [...mini.querySelectorAll(".blk")].every(
            (blk) => miniBand.compareDocumentPosition(blk) & Node.DOCUMENT_POSITION_FOLLOWING,
          );
        const miniColorOk = !!miniBand &&
          getComputedStyle(miniBand.querySelector("i")).backgroundColor ===
            getComputedStyle(document.querySelector(".day-body .dim-band span")).backgroundColor;
        document.querySelector(".tpl-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        // ⑤ 到点重算（淡-04/05）：切到「按时间」后，窗口包住现在 → 变深色目标；推开 → 再切回 —— 每次**目标变**才刷，重设同一个窗口不刷
        const hhmm = (m) => {
          m = ((m % 1440) + 1440) % 1440;
          return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        };
        const nowM = new Date().getHours() * 60 + new Date().getMinutes();
        // 「包住现在」：`[now-60, now+60)` 无论跨不跨天都包含现在；
        // 「推开现在」：`[now+90, now+150)` 经模运算后**一定不含现在**（试过 now+120/+180：跨天时反过来会包住）
        const around = [hhmm(nowM - 60), hhmm(nowM + 60)];
        const away = [hhmm(nowM + 90), hhmm(nowM + 150)];
        await openSettingsSub();
        const nightBtn = q('.ui-theme [data-value="night"]');
        if (!nightBtn) return false;
        nightBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        const themeOn = document.querySelector('.sanity-pop .ui-theme [data-value="night"]')?.classList.contains("on");
        const refreshCalls = () => window.__REFRESH_THEME_CALLS || 0;
        // 先摆到「推开现在」的窗口（目标 = 亮），再从计数基线开始测三个转变
        await setTime("input.night-start", away[0]);
        await setTime("input.night-end", away[1]);
        const c0 = refreshCalls();
        await setTime("input.night-start", around[0]);
        await setTime("input.night-end", around[1]);
        const c1 = refreshCalls();
        // 重设**同一对**值：目标没变 → 不该再调（节流）
        await setTime("input.night-start", around[0]);
        const c2 = refreshCalls();
        await setTime("input.night-start", away[0]);
        await setTime("input.night-end", away[1]);
        const c3 = refreshCalls();
        document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        window.__DIAG.push(
          `r82⑥ 列=${dayBodies.length} 带=${bands.length} 全天=${fullOk} DOM序=${domOk} 不吃手势=${pointerOk} 命中=${hitOk}（${hitInfo}）` +
            ` 关时带=${bandsWhenOff} 跨天两段=${wrapOk} 迷你带=${miniSpans}段 迷你序=${miniBeforeBlocks} 迷你同色=${miniColorOk}` +
            ` 夜间档=${themeOn} 重算=${c0}→${c1}→${c2}→${c3}`,
        );
        return (
          bandsWhenOff === 0 &&
          fullOk && domOk && pointerOk && hitOk && wrapOk &&
          miniSpans === 2 && miniBeforeBlocks && miniColorOk &&
          themeOn && c1 === c0 + 1 && c2 === c1 && c3 === c2 + 1
        );
      },
    ],
    // ===== round82（3.1c₂ · Step 7）：快捷键自定义（绑-01…20）=====
    [
      "round82 ⑤：快捷键自定义 —— 改键位 / 录制 / 冲突拒 / 锁定拒 / 恢复默认 / 总表同源（绑-17…20）",
      async () => {
        await press("Escape");
        await settle(30);
        const openKeymap = async () => {
          if (!document.querySelector(".sanity-pop")) {
            document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await settle(40);
          }
          document.querySelector(".sanity-pop .keymap-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(80);
          return document.querySelector(".keymap-panel");
        };
        const keyRow = (label) =>
          [...(document.querySelector(".keymap-panel")?.querySelectorAll(".rows tr") ?? [])].find((tr) =>
            rowText(tr.querySelector(".nm") ?? { textContent: "" }).startsWith(label),
          );
        const cap = (label) => rowText(keyRow(label)?.querySelector(".kbd") ?? { textContent: "" });
        // 真按键的路径：目标 = body（window capture 先于一切；直接派在 window 上会按注册顺序跟 Timeline 抢）
        const typeKey = async (key) => {
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
          await settle(30);
        };
        const closeAllPanels = async () => {
          document.querySelector(".keymap-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(20);
          document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click());
          await settle(20);
        };
        // 交代干净：不管本舱怎么退出，都把键位恢复默认（T 等默认键后面还有别的断言在用）
        const restore = async () => {
          await openKeymap();
          const sw = document.querySelector(".sanity-pop input.keyboard-switch");
          if (sw && !sw.checked) {
            sw.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await settle(60);
          }
          document.querySelector(".keymap-panel .reset-all")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(60);
          await closeAllPanels();
        };
        window.__RESTORE = window.__RESTORE || [];
        window.__RESTORE.push(restore);

        const panel = await openKeymap();
        const settingsStill = !!document.querySelector(".sanity-pop");
        if (!panel) return false;
        // A：录制改键（回到本周 → K）—— 保存后键帽变 K + 「已改」标记 + 行尾「恢复默认」
        keyRow("回到本周")?.querySelector(".kbd")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        const recording = !!document.querySelector(".keymap-panel .kbd.on");
        await typeKey("k");
        const savedCap = cap("回到本周");
        const marked = !!keyRow("回到本周")?.querySelector(".done");
        const canReset = !!keyRow("回到本周")?.querySelector(".reset");
        // A2（6b P2）：跨重开持久化 —— 关面板再开（`loadPrefs → initKeymap`）后仍是 K
        await closeAllPanels();
        await openKeymap();
        const capReopened = cap("回到本周");
        // B：录制中 Esc 只取消（面板还在、键帽不变）
        keyRow("回到本周")?.querySelector(".kbd")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        await typeKey("Escape");
        const stillOpen = !!document.querySelector(".keymap-panel");
        const capAfterEsc = cap("回到本周");
        // C：同层冲突拒（按 c = 快速加任务）—— 报错、键帽仍是 K（录制态留着）
        keyRow("回到本周")?.querySelector(".kbd")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        await typeKey("c");
        const conflictText = rowText(document.querySelector(".keymap-panel .err") ?? { textContent: "" });
        const capAfterConflict = cap("回到本周");
        // D：锁定键拒（F5 = 窗口占用；合成事件不会真刷新）
        await typeKey("F5");
        const lockedText = rowText(document.querySelector(".keymap-panel .err") ?? { textContent: "" });
        await closeAllPanels();
        // E：行为 —— 下周 → 按 K 回本周；再到 `?` 总表看同源（那一行也是 K）
        const label = () => document.querySelector(".range")?.textContent?.trim() ?? "";
        await backToThisWeek();
        const home = label();
        await press("ArrowRight");
        const next = label();
        await press("k");
        const back = label();
        await press("?");
        await settle(60);
        const helpRow = [...document.querySelectorAll(".keymap-panel .keys tr")].find((tr) =>
          rowText(tr.querySelector("td:last-child") ?? { textContent: "" }).startsWith("回到本周"),
        );
        const helpCap = rowText(helpRow?.querySelector(".kbd") ?? { textContent: "" });
        document.querySelector(".keymap-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        // F：行尾「恢复默认」→ 回到 T（再整表恢复，收尾）
        await openKeymap();
        keyRow("回到本周")?.querySelector(".reset")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        const capAfterReset = cap("回到本周");
        const markedAfterReset = !!keyRow("回到本周")?.querySelector(".done");
        // G（6b P2 · 绑-15）：命令键改到**裸字符键**后也要受「键盘操作」开关管
        keyRow("打开设置")?.querySelector(".kbd")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(20);
        await typeKey("k");
        const settingsCap = cap("打开设置");
        const sw = document.querySelector(".sanity-pop input.keyboard-switch");
        if (sw?.checked) {
          sw.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(80);
        }
        await closeAllPanels();
        await press("k"); // 开关关着：不该开设置
        const openedWithSwitchOff = !!document.querySelector(".sanity-pop");
        // 开关拨回开（后面的断言 / 别的用例靠它）
        document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(80);
        const swBack = document.querySelector(".sanity-pop input.keyboard-switch");
        if (swBack && !swBack.checked) {
          swBack.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(80);
        }
        await closeAllPanels();
        await restore();
        window.__DIAG.push(
          `r82⑤ 设置还在=${settingsStill} 录制态=${recording} 保存=[${savedCap}] 标记=${marked} 重开=[${capReopened}] Esc=[${stillOpen}/${capAfterEsc}]` +
            ` 冲突=[${conflictText}] 锁=[${lockedText}] 周=[${home}→${next}→${back}] 表=[${helpCap}] 恢复=[${capAfterReset}/${markedAfterReset}]` +
            ` 开关门=[设置=${settingsCap} 关着按k仍开=${openedWithSwitchOff}]`,
        );
        return (
          settingsStill && recording && savedCap === "K" && marked && canReset &&
          capReopened === "K" &&
          stillOpen && capAfterEsc === "K" &&
          conflictText.includes("已经是") && capAfterConflict === "K" &&
          lockedText.includes("窗口") &&
          next !== home && back === home &&
          helpCap === "K" &&
          capAfterReset === "T" && !markedAfterReset &&
          settingsCap === "K" && !openedWithSwitchOff
        );
      },
    ],
    [
      "round83 ①：键位入口合并（§8.2）—— 设置只剩一个入口 / `?` 同一个面板 / 总表+可改行都在 / 面板不横向溢出",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        // ① 设置 → 「提醒与控制」组里只剩**一个**键位入口（旧的两个：只读表 + 编辑器）
        await openSettingsSub();
        let pop = document.querySelector(".sanity-pop");
        const group = pop?.querySelector("#settings-group-alert");
        const entries = [...(group?.querySelectorAll("button") ?? [])].filter((b) =>
          /键位|Keys|Key bindings/.test(b.textContent ?? ""),
        );
        const oneEntry = entries.length === 1 && entries[0].classList.contains("keymap-open");
        // ② 点它 → 合并面板：上面是**全部键位（只读）**（含鼠标组 + 固定键），下面是 10 条可改行
        entries[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(80);
        let panel = document.querySelector(".keymap-panel");
        if (!panel) return false;
        const groups = [...panel.querySelectorAll(".keys .grp")].map((n) => (n.textContent ?? "").trim());
        const tableText = panel.querySelector(".keys")?.textContent ?? "";
        const mouseOk = groups.includes("鼠标");
        const fixedOk = ["Ctrl+Z", "Enter", "Esc", "Shift+←→"].every((k) => tableText.includes(k));
        const rows = [...panel.querySelectorAll(".rows tr")];
        const editOk =
          rows.length === 10 &&
          rows.some((tr) => (tr.querySelector(".kbd")?.textContent ?? "").trim() === "T") &&
          !!panel.querySelector(".rows .kbd");
        const noOverflow = panel.scrollWidth <= panel.clientWidth + 1;
        // ③ 关它（子层）→ 设置还在；再按 `?` → **同一个**面板（总表也在）——`?` 直达总表的路径不退化
        panel.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        const settingsKept = !!document.querySelector(".sanity-pop");
        await press("?");
        await settle(60);
        panel = document.querySelector(".keymap-panel");
        const viaHelp = !!panel && !!panel.querySelector(".keys .grp") && panel.querySelectorAll(".rows tr").length === 10;
        await press("Escape");
        await settle(30);
        await press("Escape");
        await settle(30);
        pop = document.querySelector(".sanity-pop");
        const clean = !pop && !document.querySelector(".keymap-panel");
        window.__DIAG.push(
          `r83① 入口数=${entries.length}（一个=${oneEntry}）表组=[${groups.join("/")}] 鼠标组=${mouseOk} 固定键=${fixedOk} 可改行=${rows.length}/${editOk} 不溢出=${noOverflow} 设置留住=${settingsKept} ?同一面板=${viaHelp} 收尾净=${clean}`,
        );
        return oneEntry && mouseOk && fixedOk && editOk && noOverflow && settingsKept && viaHelp && clean;
      },
    ],
    [
      "round84 ①：提醒文案（§0.5.1）+ 下拉选项自带底色字色（§0.5.2）—— 「块开始时提醒我」/ 档位 0·5·10·15·30 分钟 / option 底色=--card",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        await openSettingsSub();
        const pop = document.querySelector(".sanity-pop");
        if (!pop) return false;
        const alert = pop.querySelector("#settings-group-alert");
        if (!alert) return false;
        // ① 两个行标签都是「句子」（加「我」，消除「快开始提醒」的误读）
        const startLabelOk = (alert.textContent ?? "").includes("块开始时提醒我");
        const endLabelOk = (alert.textContent ?? "").includes("块结束时提醒我");
        // ② 「提前」后面的下拉档位：0 分钟（旧文案是「到点」）+ 5/10/15/30 分钟
        const lead = alert.querySelector(".lead");
        const opts = lead ? [...lead.querySelectorAll("option")].map((o) => (o.textContent ?? "").trim()) : [];
        const optsOk = JSON.stringify(opts) === JSON.stringify(["0 分钟", "5 分钟", "10 分钟", "15 分钟", "30 分钟"]);
        // ③ §0.5.2：原生弹层不跟页面主题 → option 必须自带底色/字色（= --card / --text-primary）
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;opacity:0";
        document.body.append(probe);
        const readVar = (name) => {
          probe.style.color = "";
          probe.style.color = `var(${name})`;
          return getComputedStyle(probe).color;
        };
        const card = readVar("--card");
        const ink = readVar("--text-primary");
        probe.remove();
        const opt = lead?.querySelector("option");
        const optBg = opt ? getComputedStyle(opt).backgroundColor : "";
        const optFg = opt ? getComputedStyle(opt).color : "";
        const parse = (v) =>
          (String(v).match(/rgba?\(([^)]+)\)/)?.[1] ?? "")
            .split(/[,\s/]+/)
            .filter(Boolean)
            .slice(0, 3)
            .join(",");
        const optStyleOk = !!opt && parse(optBg) === parse(card) && parse(optFg) === parse(ink);
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const clean = !document.querySelector(".sanity-pop");
        window.__DIAG.push(
          `r84① 行标签=${startLabelOk}/${endLabelOk} 档位=[${opts.join("|")}] 选项底色=${optBg}（--card=${card}）字色=${optFg}（--text-primary=${ink}）样式=${optStyleOk} 收尾净=${clean}`,
        );
        return startLabelOk && endLabelOk && optsOk && optStyleOk && clean;
      },
    ],
    [
      "round84 ②：用户可见文案「理智」→「精力」（§0.5.3）—— 设置面板里没有「理智」、精力区与预警行在",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const pop = await openSettingsSub("sanity");
        if (!pop) return false;
        const text = pop.textContent ?? "";
        const hasEnergy = text.includes("精力");
        const noSanity = !text.includes("理智");
        const warnRow = [...pop.querySelectorAll("#settings-group-more .row")].some((n) =>
          (n.textContent ?? "").includes("显示精力预警"),
        );
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const clean = !document.querySelector(".sanity-pop");
        window.__DIAG.push(`r84② 精力=${hasEnergy} 无理智=${noSanity} 预警行=${warnRow} 收尾净=${clean}`);
        return hasEnergy && noSanity && warnRow && clean;
      },
    ],
    // ===== round85（0.31.0）：12 套内置配色（选择器横滚 / 直角档）=====
    [
      "round85 ①：12 套内置配色 —— 顺序 / 逐个选中生效 / 横滚到得了最后一张 / 6 套直角",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const pop = await openSettingsSub();
        if (!pop) return false;
        const wrap = pop.querySelector(".ui-palette");
        if (!wrap) return false;
        const cards = [...wrap.querySelectorAll(".palette")];
        const ids = cards.map((c) => c.dataset.value);
        const expect = [
          "warm", "cool", "sage", "endfield", "terminal", "deepsea", "bauhaus", "artdeco",
          "cassette", "north", "brutal", "porcelain",
        ];
        const idsOk = ids.length === 12 && expect.every((x, i) => ids[i] === x);
        // 横滚（round85 你拍的形态）：内容溢出 + 首屏右缘切着某张卡（= 可滚动的天然提示）+ 能滚到最后一张
        const cr = wrap.getBoundingClientRect();
        wrap.scrollLeft = 0;
        await settle(10);
        const overflowOk = wrap.scrollWidth > wrap.clientWidth + 1;
        // 6b P2：程序化 `scrollLeft` 在 `overflow-x: hidden` 下也成立 → 硬判据必须钉「真能滚」
        const scrollable = ["auto", "scroll"].includes(getComputedStyle(wrap).overflowX);
        const peek = cards.some((c) => {
          const r = c.getBoundingClientRect();
          return r.left < cr.right - 1 && r.right > cr.right + 1;
        });
        // 「能不能看出可以滚」：右缘切着某张卡（露边）**或**真的渲染出了横向滚动条
        // （窄窗/整倍宽时可能正好不露边 —— 那就靠滚动条占的那几像素提供提示）
        const scrollbarShown = wrap.offsetHeight - wrap.clientHeight >= 8;
        wrap.scrollLeft = wrap.scrollWidth;
        await settle(10);
        const last = cards[cards.length - 1].getBoundingClientRect();
        const reachOk = last.right <= cr.right + 1 && last.left >= cr.left - 1;
        // 逐个选中：`data-palette` 生效 + aria-checked + ✓ 跟着走 + 底色可读且 12 个互不相同 + 直角档
        const sharp = ["endfield", "terminal", "bauhaus", "artdeco", "brutal", "porcelain"];
        const bgs = [];
        const bad = [];
        for (const id of ids) {
          wrap.querySelector(`.palette[data-value="${id}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(90);
          const csr = getComputedStyle(document.documentElement);
          const bg = csr.getPropertyValue("--bg").trim();
          const radius = csr.getPropertyValue("--radius").trim();
          bgs.push(bg);
          const card = wrap.querySelector(`.palette[data-value="${id}"]`);
          if (document.documentElement.dataset.palette !== id) bad.push(`${id}:dataset`);
          else if (card?.getAttribute("aria-checked") !== "true") bad.push(`${id}:aria`);
          else if (!card?.querySelector(".pname.on")) bad.push(`${id}:✓`);
          else if (!bg || bg === "rgb(0, 0, 0)") bad.push(`${id}:bg=${bg}`);
          else if (sharp.includes(id) ? radius !== "0px" : radius === "0px") bad.push(`${id}:radius=${radius}`);
        }
        const uniq = new Set(bgs).size;
        // 收尾：回暖砂（后面还有断言与截图）
        wrap.querySelector('.palette[data-value="warm"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        window.__DIAG.push(
          `r85① 卡片=${cards.length} 顺序=${idsOk} 溢出=${overflowOk} 可滚=${scrollable} 露边=${peek} 滚动条=${scrollbarShown} 末张可达=${reachOk} 底色去重=${uniq}/12 违规=[${bad.join(" ")}]`,
        );
        // 硬判据 = 横排 + 能滚 + 末张到得了（你 2026-10-08 拍的形态）；
        // 「露边 / 滚动条」只是**观感提示**（宽窗露边、窄窗看系统滚动条 —— 两者随窗口宽变，不进硬判据）
        return idsOk && overflowOk && scrollable && reachOk && uniq === 12 && bad.length === 0;
      },
    ],
    [
      "round85 ②：Samigirian 展示字 —— 北境极夜（萨米·大写）/ 深海冷光（阿戈尔·小写）/ 暖砂老观感不变",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const pop = await openSettingsSub();
        if (!pop) return false;
        const pick = async (id) => {
          pop.querySelector(`.ui-palette .palette[data-value="${id}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(120);
        };
        /** 三个展示字读者：日头（文字在那颗按钮里）/ Backlog 标题 / 面板标题 */
        const read = () => {
          const first = (el) => (el ? getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim() : "");
          const tt = (el) => (el ? getComputedStyle(el).textTransform : "");
          const day = document.querySelector(".day-head .day-pick");
          const title = document.querySelector(".backlog .title");
          const popTitle = document.querySelector(".sanity-pop .pop-title");
          // 展示字换成衬线后字宽会变 —— 顺便量一眼日头文字有没有超出去（715px 窄窗跑时这条最有用）
          let fits = true;
          if (day) {
            const box = day.getBoundingClientRect();
            let textW = 0;
            for (const node of day.childNodes) {
              if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
              const r = document.createRange();
              r.selectNodeContents(node);
              textW += r.getBoundingClientRect().width;
            }
            fits = textW <= box.width + 1;
          }
          return {
            day: first(day), title: first(title), popTitle: first(popTitle),
            dayTt: tt(day), titleTt: tt(title), popTitleTt: tt(popTitle), fits,
          };
        };
        await pick("north");
        const north = read();
        await pick("deepsea");
        const deepsea = read();
        await pick("warm");
        const warm = read();
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        const sami = (r, tt) =>
          r.day === "Samigirian" && r.title === "Samigirian" && r.popTitle === "Samigirian" &&
          r.dayTt === tt && r.titleTt === tt && r.popTitleTt === tt && r.fits;
        const okNorth = sami(north, "uppercase");
        const okDeep = sami(deepsea, "lowercase");
        const okWarm =
          warm.day !== "Samigirian" && warm.title !== "Samigirian" && warm.popTitle !== "Samigirian" &&
          warm.dayTt === "none" && warm.titleTt === "uppercase" && warm.popTitleTt === "none";
        window.__DIAG.push(`r85② north=${JSON.stringify(north)} deepsea=${JSON.stringify(deepsea)} warm=${JSON.stringify(warm)}`);
        return okNorth && okDeep && okWarm;
      },
    ],
    [
      "round85 ③ + round86 ②：底纹层 —— 细密型铺 body + 列底 / 大尺度型（rays / glow）只铺页面；老 3 套与野兽派/白瓷 = 无",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const pop = await openSettingsSub();
        if (!pop) return false;
        // 种子里有底纹的 7 套（brutal / porcelain 的 surface 就是 none）
        const WITH = ["endfield", "terminal", "deepsea", "bauhaus", "artdeco", "cassette", "north"];
        // round86（0.32.0 · ②）：其中只有**细密纹理**那 5 套铺列底（深海 glow / 装饰艺术 rays = 只铺页面）
        const WITH_COLS = ["endfield", "terminal", "bauhaus", "cassette", "north"];
        const ALL = ["warm", "cool", "sage", ...WITH, "brutal", "porcelain"];
        /** 顶层逗号切分（括弧内不算）→ 有几层背景图 */
        const layers = (s) => {
          let d = 0;
          let n = 1;
          for (const ch of s) {
            if (ch === "(") d += 1;
            else if (ch === ")") d -= 1;
            else if (ch === "," && d === 0) n += 1;
          }
          return n;
        };
        // 组件侧的顺序（一次就够）：`.day-body` 的声明必须是「列底底纹第一层、整点格线随后」
        let authored = "";
        for (const sheet of document.styleSheets) {
          let rules = null;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const r of rules ?? []) {
            if (r.selectorText?.includes(".day-body") && String(r.style?.backgroundImage ?? "").includes("surface-image")) {
              authored = String(r.style.backgroundImage);
            }
          }
        }
        const orderOk = authored.startsWith("var(--surface-image-cols") && authored.includes("repeating-linear-gradient");
        const bad = [];
        for (const id of ALL) {
          pop.querySelector(`.ui-palette .palette[data-value="${id}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(90);
          if (document.documentElement.dataset.palette !== id) {
            bad.push(`${id}:没切上`);
            continue;
          }
          const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface-image").trim();
          const cols = getComputedStyle(document.documentElement).getPropertyValue("--surface-image-cols").trim();
          const want = WITH.includes(id);
          const has = !!surface && surface !== "none";
          if (want !== has) bad.push(`${id}:--surface-image=${surface.slice(0, 30) || "(空)"}`);
          const wantCols = WITH_COLS.includes(id);
          const hasCols = !!cols && cols !== "none";
          if (wantCols !== hasCols) bad.push(`${id}:--surface-image-cols=${cols.slice(0, 24) || "(空)"}`);
          const bodyBg = getComputedStyle(document.body).backgroundImage;
          if (want ? !bodyBg.includes("gradient") : bodyBg !== "none") bad.push(`${id}:body=${bodyBg.slice(0, 36)}`);
          const day = document.querySelector(".day-body");
          const dayBg = day ? getComputedStyle(day).backgroundImage : "";
          const n = layers(dayBg);
          // 没底纹时第一层是 `var(..., none)` 占位（Chromium 保留它：computed = `none, repeating-linear-gradient(...)`）
          const firstLayerNone = dayBg.trim().toLowerCase().startsWith("none");
          if (!dayBg.includes("gradient")) bad.push(`${id}:列底无格线`);
          else if (wantCols ? n < 2 || firstLayerNone : !firstLayerNone) {
            bad.push(`${id}:列底层数=${n} 首层=${firstLayerNone ? "none" : "底纹"}（期望 ${wantCols ? "底纹 + 格线" : "只有格线"}）`);
          }
        }
        pop.querySelector('.ui-palette .palette[data-value="warm"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        window.__DIAG.push(`r85③ 顺序=${orderOk} 声明=[${authored.slice(0, 46)}…] 违规=[${bad.join(" ")}]`);
        return orderOk && bad.length === 0;
      },
    ],
    // ===== round86（0.32.0 · ②）：大尺度底纹只铺页面（放射线 / 冷光晕）=====
    // 盯的是**生成物本身**（样式表里每个配色块写了什么），不依赖当前选中的配色 ——
    // 细密型：`--surface-image-cols` 有；大尺度型：**没有**（只有 `--surface-image`）。
    [
      "round86 ②：大尺度底纹（rays / glow）不进列底 —— 5 套细密型有列底、深海/装饰艺术只有页面",
      async () => {
        const decl = new Map();
        for (const sheet of document.styleSheets) {
          let rules = null;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const r of rules ?? []) {
            const sel = String(r.selectorText ?? "");
            if (!sel.includes("[data-palette=")) continue;
            const get = (k) => String(r.style?.getPropertyValue?.(k) ?? "").trim();
            // `tokens.css` 的老 3 套是**选择器表**（`:root, :root[data-palette="warm"]`）→ 逐个 id 记；
            // 只走顶层规则（亮色档），`@media (prefers-color-scheme: dark)` 里的那几块不进来。
            for (const m of sel.matchAll(/\[data-palette="([a-z0-9]+)"\]/g)) {
              decl.set(m[1], { page: get("--surface-image"), cols: get("--surface-image-cols") });
            }
          }
        }
        const bad = [];
        const FINE = ["endfield", "terminal", "bauhaus", "cassette", "north"];
        const BIG = ["deepsea", "artdeco"];
        const NONE = ["warm", "cool", "sage", "brutal", "porcelain"];
        for (const [id, list, wantCols] of [
          ...FINE.map((x) => [x, "细密", true]),
          ...BIG.map((x) => [x, "大尺度", false]),
          ...NONE.map((x) => [x, "无底纹", false]),
        ]) {
          const d = decl.get(id);
          if (!d) {
            bad.push(`${id}:样式表里找不到配色块`);
            continue;
          }
          const hasPage = !!d.page && d.page !== "none";
          const hasCols = !!d.cols && d.cols !== "none";
          if (list === "无底纹" ? hasPage || hasCols : !hasPage) bad.push(`${id}:page=${d.page.slice(0, 20) || "(空)"}`);
          if (hasCols !== wantCols) bad.push(`${id}:cols=${d.cols.slice(0, 20) || "(空)"}`);
          // 「大尺度」的签名：rays = repeating-conic-gradient / glow = 120% 90% at 18% 0% —— 它们**只能**出现在页面那层
          if (list === "大尺度" && /conic|120% 90%/.test(d.cols)) bad.push(`${id}:大尺度形状进了列底`);
        }
        // 反向：细密型里也不该出现放射线签名（防「白名单写反」）
        for (const id of FINE) {
          if (/repeating-conic-gradient/.test(decl.get(id)?.cols ?? "")) bad.push(`${id}:列底出现 conic`);
        }
        window.__DIAG.push(
          `r86② 配色块=${decl.size} 细密有列底=${FINE.filter((x) => decl.get(x)?.cols && decl.get(x).cols !== "none").length}/5 大尺度有列底=${BIG.filter((x) => decl.get(x)?.cols && decl.get(x).cols !== "none").length}/2 违规=[${bad.join(" ")}]`,
        );
        return decl.size >= 9 && bad.length === 0;
      },
    ],
    // ===== round85（0.31.0）：§5-DU —— 视图里不够大的块，浮层不许压块 =====
    [
      "round85 ④：矮块浮层 —— 15/30/45 分钟 + 贴列顶（舒适 / 最小刻度 18）= 8 样本：浮层不压可拖拽面 / 列内 / 面高 ≥2.5px / 落点分支对 / 按浮层缝不起拖",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const ids = ["r85s15", "r85s30", "r85s45", "r85sTop"];
        /** 期望的浮层落点（防止「分支被静默改回 inline」）：贴列顶那块必须落到 below */
        // round87.2（你 2026-10-09 拍）：浮层**优先下面** —— 周六 09:00 那三块下面一天都是空的 → below；
        // 贴列顶的 r85sTop 也走 below（正好同一个方向）
        const wantAnchor = { r85s15: "below", r85s30: "below", r85s45: "below", r85sTop: "below" };
        const dropSeed = () => {
          for (const id of ids) {
            const i = FIX.blocks.findIndex((b) => b.id === id);
            if (i >= 0) FIX.blocks.splice(i, 1);
          }
        };
        const goNext = () =>
          document.querySelector(".week-nav button[title^='下一周']")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const backNow = () =>
          document.querySelector(".week-nav .now")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const reload = async () => {
          await goNext();
          await settle(60);
          backNow();
          await settle(90);
        };
        const entrySlot = String(window.__SANITY_STATE?.slotHeight ?? "auto");
        window.__RESTORE = window.__RESTORE || [];
        window.__RESTORE.push(async () => {
          dropSeed();
          if (String(window.__SANITY_STATE?.slotHeight ?? "auto") !== entrySlot) {
            await openSettingsSub();
            const s = document.querySelector(".sanity-pop select.slot-height");
            if (s) {
              s.value = entrySlot;
              s.dispatchEvent(new Event("change", { bubbles: true }));
              await settle(60);
            }
            document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await settle(20);
          }
          await reload();
        });
        // 种三个短块（临时任务：融合逻辑跳过它）+ 跳周来回强制真重拉；顺手作废撤销快照（直接改假库的纪律）
        dropSeed();
        FIX.blocks.push(
          B("r85s15", TEMP_TASK_ID, at(6, 7, 0), at(6, 7, 0) + 15 * 60, "elastic", "planned"),
          B("r85s30", TEMP_TASK_ID, at(6, 8, 0), at(6, 8, 0) + 30 * 60, "elastic", "planned"),
          B("r85s45", TEMP_TASK_ID, at(6, 9, 0), at(6, 9, 0) + 45 * 60, "elastic", "planned"),
          // 贴列顶的矮块（00:15）—— 浮层必须落**下沿**（above 会被 `.day-body` 的 overflow 裁掉）
          B("r85sTop", TEMP_TASK_ID, at(6, 0, 15), at(6, 0, 15) + 15 * 60, "elastic", "planned"),
        );
        UNDO_SNAP = null;
        REDO_SNAP = null;
        await reload();
        const setSlot = async (v) => {
          await openSettingsSub();
          const s = document.querySelector(".sanity-pop select.slot-height");
          if (!s) return false;
          s.value = v;
          s.dispatchEvent(new Event("change", { bubbles: true }));
          await settle(80);
          document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(40);
          return true;
        };
        const rows = [];
        for (const slot of ["auto", "18"]) {
          if (!(await setSlot(slot))) {
            rows.push({ slot, err: "拿不到刻度下拉" });
            continue;
          }
          for (const id of ids) {
            const el = document.querySelector(`[data-block-id="${id}"]`);
            if (!el) {
              rows.push({ id, slot, err: "块不在 DOM" });
              continue;
            }
            const br = el.getBoundingClientRect();
            const a = el.querySelector(".actions");
            const ar = a?.getBoundingClientRect() ?? null;
            // 用把手的**真实矩形**算可拖拽面（不假设 4px：round85 起极短块会按比例收窄）
            const hs = [...el.querySelectorAll(".resize")].map((h) => h.getBoundingClientRect());
            const topHandle = hs.find((r) => r.top < br.top + br.height / 2) ?? null;
            const botHandle = hs.find((r) => r !== topHandle) ?? null;
            const faceTop = Math.max(br.top, topHandle ? topHandle.bottom : br.top);
            const faceBottom = Math.min(br.bottom, botHandle ? botHandle.top : br.bottom);
            const faceH = Math.round((faceBottom - faceTop) * 10) / 10;
            const overlap = ar ? Math.round(Math.max(0, Math.min(ar.bottom, faceBottom) - Math.max(ar.top, faceTop))) : 0;
            const body = el.closest(".day-body")?.getBoundingClientRect();
            // 纵向必须整条在列内（被 `.day-body` 裁 = 点不到）；横向允许冒出块宽（round82 已验收的
            // 「浮层跟随内容宽度、允许超出块」—— 列边缘的几像素裁剪是既有行为，不归本批）
            const inBodyV =
              !!(ar && body) && ar.top >= body.top - 1 && ar.bottom <= body.bottom + 1;
            const inBodyH = !!(ar && body) && ar.left >= body.left - 1 && ar.right <= body.right + 1;
            // 按在浮层的**按钮缝**上 → 不该起拖（真 bug：以前会冒泡到块的 pointerdown 被选中）
            let gapSel = null;
            let faceGrab = null;
            let faceHit = "-";
            if (a) {
              press("Escape");
              await settle(10);
              const corners = [
                [ar.left + 1, ar.bottom - 1],
                [ar.right - 1, ar.bottom - 1],
              ];
              for (const [x, y] of corners) {
                a.dispatchEvent(ptrEvent("pointerdown", x, y));
                await settle(10);
                window.dispatchEvent(ptrEvent("pointerup", x, y));
                await settle(10);
                gapSel = gapSel === null ? el.classList.contains("selected") : gapSel || el.classList.contains("selected");
                press("Escape");
                await settle(10);
              }
              // 反向对照：按在可拖拽面中间 **应该** 能抓起这块（证明真的有拖动入口）
              const cx = Math.round(br.left + br.width / 2);
              const cy = Math.round((faceTop + faceBottom) / 2);
              const hit = document.elementFromPoint(cx, cy);
              faceHit = hit ? (hit.className || hit.tagName) + "" : "null";
              firePointer("pointerdown", cx, cy);
              await settle(10);
              faceGrab = el.classList.contains("selected");
              window.dispatchEvent(ptrEvent("pointerup", cx, cy));
              press("Escape");
              await settle(10);
            }
            rows.push({
              id, slot, anchor: el.dataset.overlay, want: wantAnchor[id],
              h: Math.round(br.height), faceH, topH: Math.round((topHandle?.height ?? 0) * 10) / 10,
              botH: Math.round((botHandle?.height ?? 0) * 10) / 10,
              aw: ar ? Math.round(ar.width) : 0, ah: ar ? Math.round(ar.height) : 0,
              overlap, inBodyV, inBodyH, gapSel, faceGrab, faceHit,
            });
          }
        }
        // 硬判据（你报的问题：拖不动 / 拉不动）：浮层不压面、面 ≥2.5px、浮层纵向不被裁、按缝不起拖、
        // **落点分支与预期一致**（above / 贴列顶那块必须 below）。
        // `faceGrab` / `faceHit` 只当 DIAG —— 7px 块上「脸中心」落在整数像素上会被四舍五入推进把手
        // （`elementFromPoint` 只吃整数坐标）；**能拖 / 能拉的实机证明交给真鼠标探针**（preview.mjs）。
        const bad = rows.filter((r) =>
          r.err || r.overlap > 0 || r.faceH < 2.5 || r.topH <= 0 || r.botH <= 0 || !r.inBodyV ||
          r.gapSel === true || r.anchor !== r.want,
        );
        window.__DIAG.push(
          `r85④ 样本=${rows.length} 违规=${bad.length} ` +
            JSON.stringify(bad.length ? bad.slice(0, 3) : rows.map((r) => `/${r.id}:${r.slot}:${r.anchor}:h${r.h}:把${r.topH},${r.botH}:面${r.faceH}:叠${r.overlap}`)),
        );
        return rows.length === 8 && bad.length === 0;
      },
    ],
    // ===== round86（0.32.0 · ①）：强调色拆 token —— 时间轴底色暖 / 系统控件冷 =====
    [
      "round86 ①：北境极夜拆 token —— 控件冷（极夜蓝）/ 时间轴底色暖（木色）/ 老 11 套 deco=accent",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const pop = await openSettingsSub();
        if (!pop) return false;
        const wrap = pop.querySelector(".ui-palette");
        if (!wrap) return false;
        /** 色值字符串（#rrggbb / rgb()/rgba() / color(srgb …)）→ [r,g,b]；解不开返回 null
         *  （Chromium 把 `color-mix()` 的 used 值算成 `color(srgb r g b)`（0–1）—— 不匹配就到不了值） */
        const toRgb = (s) => {
          const v = String(s).trim();
          if (/^#[0-9a-f]{6}/i.test(v)) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
          const cm = v.match(/color\(srgb\s+([^)]+)\)/);
          if (cm) return cm[1].split(/\s+/).filter(Boolean).slice(0, 3).map((x) => Math.round(Number(x) * 255));
          const m = v.match(/rgba?\(([^)]+)\)/);
          return m ? m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number) : null;
        };
        const eq = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
        const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        const dark = matchMedia("(prefers-color-scheme: dark)").matches;
        /** 你 2026-10-08 给的极夜蓝 + 木色（亮/暗两档） */
        const WANT = dark
          ? { accent: "#9bb8ff", deco: "#c08a4a" }
          : { accent: "#3f5d99", deco: "#6b4415" };
        /** 块三态 + 层条：**0.31.0 的值**（拆 token 不改它们 —— 你拍的「块底保木」） */
        const KEEP = dark
          ? { fill: "#41372e", linePlanned: "#685137", fillDone: "#564533", lineDone: "#c08a4a", layer: "#c08b4b" }
          : { fill: "#d4d0c8", linePlanned: "#b0a08b", fillDone: "#c4b9ab", lineDone: "#6b4415", layer: "#583811" };
        const bad = [];
        const pick = async (id) => {
          wrap.querySelector(`.palette[data-value="${id}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(90);
        };
        // ① 其他配色抽查五套（3 老 + 2 新）：`--accent-deco` 必须 = `--accent`（= 老观感逐像素不变的依据）
        for (const id of ["warm", "sage", "endfield", "cassette", "porcelain"]) {
          await pick(id);
          const a = cssVar("--accent");
          const d = cssVar("--accent-deco");
          if (!eq(toRgb(a), toRgb(d))) bad.push(`${id}:deco=${d}≠accent=${a}`);
        }
        // ② 北境极夜：两侧分开 + 块三态逐值不变 + 今天列 = 木色 6% 混底
        await pick("north");
        const a = toRgb(cssVar("--accent"));
        const d = toRgb(cssVar("--accent-deco"));
        if (!eq(a, toRgb(WANT.accent))) bad.push(`accent=${cssVar("--accent")}`);
        if (!eq(d, toRgb(WANT.deco))) bad.push(`deco=${cssVar("--accent-deco")}`);
        for (const [k, want] of Object.entries({ "--block-fill-planned": KEEP.fill, "--block-line-planned": KEEP.linePlanned, "--block-fill-done": KEEP.fillDone, "--block-line-done": KEEP.lineDone, "--layer-required-bar": KEEP.layer })) {
          if (!eq(toRgb(cssVar(k)), toRgb(want))) bad.push(`${k}=${cssVar(k)}≠${want}`);
        }
        // 焦点环走 `--accent`（不用 deco —— 这就是你截图里被染成琥珀的那个）
        const ring = cssVar("--focus-ring");
        if (!ring.includes(WANT.accent)) bad.push(`focus-ring=${ring}`);
        // 今天那一列：used 值 = `color-mix(deco 6%, bg)`（两个 token 都是 hex，本测试自己算期望值）
        await backToThisWeek();
        await settle(30);
        const today = document.querySelector(".day.today .day-body");
        let todayOk = null;
        let todaySeen = null;
        if (today) {
          const raw = getComputedStyle(today).backgroundColor;
          const got = toRgb(raw);
          const mix = (x, y, t) => x.map((c, i) => Math.round(c * (1 - t) + y[i] * t));
          // CSS 是 `color-mix(in srgb, var(--accent-deco) 6%, var(--bg))` = 6% deco + 94% bg
          const want = mix(toRgb(cssVar("--bg")) ?? [0, 0, 0], d ?? [0, 0, 0], 0.06);
          todayOk = got && want.every((w, i) => Math.abs(w - got[i]) <= 2);
          todaySeen = raw;
          if (!todayOk) bad.push(`today=${todaySeen}≠mix(${want.join(",")})`);
        } else {
          bad.push("today:没有 .day.today（本周没今天？）");
        }
        // 控件一侧（设置面板里就有的两个真控件）：分段控件选中块 + 配色卡选中环
        const seg = pop.querySelector(".seg-btn.on");
        const segRgb = seg ? toRgb(getComputedStyle(seg).backgroundColor) : null;
        if (!eq(segRgb, toRgb(WANT.accent))) bad.push(`seg=${seg ? getComputedStyle(seg).backgroundColor : "无"}`);
        const onCard = wrap.querySelector(".palette.on");
        const shadow = onCard ? getComputedStyle(onCard).boxShadow : "";
        const shadowRgb = toRgb(shadow);
        if (!eq(shadowRgb, toRgb(WANT.accent))) bad.push(`card-ring=${shadow}`);
        // 收尾：回暖砂（后面还有断言与截图）
        await pick("warm");
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        window.__DIAG.push(
          `r86① 主题=${dark ? "暗" : "亮"} accent=${cssVar("--accent")} deco=${cssVar("--accent-deco")} today=${todaySeen} seg=${segRgb?.join(",")} 违规=[${bad.join(" ")}]`,
        );
        return bad.length === 0;
      },
    ],
    // ===== round86（0.32.0 · ⑤）：展示字的四个量（倍率 / 字距 / 字重 / 小大写）=====
    [
      "round86 ⑤：展示字四个量 —— 三处展示字按参数生效（12 套逐个验）/ 行高不变 / 字不溢出列宽",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const pop = await openSettingsSub();
        if (!pop) return false;
        const wrap = pop.querySelector(".ui-palette");
        if (!wrap) return false;
        const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
        const num = (s, d = 0) => (Number.isFinite(parseFloat(s)) ? parseFloat(s) : d);
        const bad = [];
        const diag = [];
        /** 一个展示字读者现算出来的几件事（字号 / 字距 / 字重 / 小大写 / 行高） */
        const site = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { fs: num(cs.fontSize), ls: cs.letterSpacing, w: cs.fontWeight, v: cs.fontVariant, lh: cs.lineHeight };
        };
        /** 日头文字宽度 ≤ 列宽（展示字放大 / 加字距后最容易溢出的地方） */
        const textFits = () => {
          const day = document.querySelector(".day-head .day-pick");
          if (!day) return null;
          const box = day.getBoundingClientRect();
          let w = 0;
          for (const node of day.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
            const r = document.createRange();
            r.selectNodeContents(node);
            w += r.getBoundingClientRect().width;
          }
          return { textW: Math.round(w), boxW: Math.round(box.width), ok: w <= box.width + 1 };
        };
        const ids = ["warm", "cool", "sage", "endfield", "terminal", "deepsea", "bauhaus", "artdeco", "cassette", "north", "brutal", "porcelain"];
        /** 字体族枚举 → 真字体栈的首项（与 `decor-86.json` 的 `display.font` 对得上） */
        const FONT_FIRST = {
          mono: "Cascadia Mono",
          serif: "Georgia",
          samigirian: "Samigirian",
          // round87（1.0.0 · 3.3）：四款自带展示字（各归一套，值在 `decor-86.json`）
          poiret: "Poiret One",
          jost: "Jost",
          archivo: "Archivo Black",
          marcellus: "Marcellus",
        };
        /** 9 套展示字的**契约**（你拍的口径：三处一起变；值来自 `decor-86.json`，这里钉用户看得见的那几项） */
        const DISPLAY_CONTRACT = {
          endfield: { font: "mono", upper: true, tracking: "0.1em" },
          terminal: { font: "mono", tracking: "0.14em" },
          deepsea: { font: "samigirian", lower: true, tracking: "0.06em" },
          bauhaus: { font: "jost", weight: "700", tracking: "0.02em" },
          artdeco: { font: "poiret", tracking: "0.18em", variant: "small-caps" },
          cassette: { font: "mono", tracking: "0.06em" },
          north: { font: "samigirian", upper: true, tracking: "0.06em" },
          brutal: { font: "archivo", weight: "800", tracking: "0" },
          porcelain: { font: "marcellus", upper: true, tracking: "0.18em" },
        };
        for (const id of ids) {
          wrap.querySelector(`.palette[data-value="${id}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(120);
          if (document.documentElement.dataset.palette !== id) {
            bad.push(`${id}:没切上`);
            continue;
          }
          // 期望值**从令牌现算**（不把 decor-86.json 里的数值抄一份进测试 —— 那样会漂移）
          const scale = num(cssVar("--display-scale"), 1) || 1;
          const size = num(cssVar("--text-title"), 14) * scale;
          const weight = cssVar("--display-weight");
          const variant = cssVar("--display-variant") || "normal";
          const track = cssVar("--display-tracking");
          const labelTrack = cssVar("--label-tracking");
          const wantLs = (v) => {
            if (!v || v === "normal") return null;
            if (v.endsWith("em")) return num(v) * size;
            if (v.endsWith("px")) return num(v);
            return 0;
          };
          const sites = [
            [".day-head", { fs: size, w: weight || "600", v: variant, ls: wantLs(track) }],
            [".backlog .title", { fs: size, w: weight || "700", v: variant, ls: wantLs(track || labelTrack) }],
            [".sanity-pop .pop-title", { fs: size, w: weight || "600", v: variant, ls: wantLs(track) }],
          ];
          for (const [sel, want] of sites) {
            const got = site(sel);
            if (!got) {
              bad.push(`${id}:${sel} 不在`);
              continue;
            }
            if (Math.abs(got.fs - want.fs) > 0.3) bad.push(`${id}${sel}:fs=${got.fs}≠${want.fs.toFixed(2)}`);
            if (got.w !== want.w) bad.push(`${id}${sel}:w=${got.w}≠${want.w}`);
            if (got.v !== want.v) bad.push(`${id}${sel}:variant=${got.v}≠${want.v}`);
            if (want.ls !== null && Math.abs(num(got.ls) - want.ls) > 0.15) bad.push(`${id}${sel}:ls=${got.ls}≠${want.ls.toFixed(2)}px`);
          }
          // 9 套展示字的**契约**（6b 复核：原来只验「令牌→渲染」的接线，参数值写错/漏写不会红）
          const dhEl = document.querySelector(".day-head");
          const dhCs = dhEl ? getComputedStyle(dhEl) : null;
          const c2 = DISPLAY_CONTRACT[id];
          if (c2 && dhCs) {
            const first = dhCs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
            if (c2.font && first !== FONT_FIRST[c2.font]) bad.push(`${id}:日头字体=${first}≠${FONT_FIRST[c2.font]}`);
            if (c2.upper && dhCs.textTransform !== "uppercase") bad.push(`${id}:日头大小写=${dhCs.textTransform}`);
            if (c2.lower && dhCs.textTransform !== "lowercase") bad.push(`${id}:日头大小写=${dhCs.textTransform}`);
            if (c2.weight && dhCs.fontWeight !== c2.weight) bad.push(`${id}:日头字重=${dhCs.fontWeight}≠${c2.weight}`);
            if (c2.variant && dhCs.fontVariant !== c2.variant) bad.push(`${id}:日头 variant=${dhCs.fontVariant}`);
            if (c2.tracking) {
              const wantPx = num(c2.tracking) * num(dhCs.fontSize);
              if (Math.abs(num(dhCs.letterSpacing) - wantPx) > 0.15) {
                bad.push(`${id}:日头字距=${dhCs.letterSpacing}≠${wantPx.toFixed(2)}px`);
              }
            }
          }
          // 行高不变（日头 26px 固定）—— 放大字号不该动日头行高与块位置
          const lh = site(".day-head")?.lh;
          if (Math.abs(num(lh) - 26) > 0.5) bad.push(`${id}:日头行高=${lh}`);
          const fits = textFits();
          if (fits && !fits.ok) bad.push(`${id}:日头文字 ${fits.textW}px > 列 ${fits.boxW}px`);
          if (["north", "deepsea"].includes(id)) {
            // 这两套（Samigirian 衬线）：你 2026-10-08 定稿 = **字号不加**（scale = 1）+ 保留 0.06em 字距
            // → 判据改成：倍率在合理区间（含 1）+ 字距在建议区间（不为 0）
            if (!(scale >= 0.95 && scale <= 1.2)) bad.push(`${id}:scale=${scale}`);
            const t = num(track);
            if (!(t > 0 && t <= 0.12)) bad.push(`${id}:tracking=${track}`);
            diag.push(`${id}:scale=${scale} tracking=${track} 日头=${site(".day-head")?.fs}px`);
          }
        }
        // 收尾：回暖砂
        wrap.querySelector('.palette[data-value="warm"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        window.__DIAG.push(`r86⑤ 12 套逐个验；${diag.join(" ")}；违规=[${bad.join(" ")}]`);
        return bad.length === 0;
      },
    ],
    // ===== round86（0.32.0 · ③）：装饰全套（9 套逐套：契约 + 令牌→渲染的机制）=====
    [
      "round86 ③：装饰逐套 —— 谷地黄斜切角 / 终端 HUD / 深海光晕 / 包豪斯粗边 / 装饰艺术金线 / 卡带暗角 / 北境圆角 / 野兽派硬框 / 白瓷面板与行线",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const pop = await openSettingsSub();
        if (!pop) return false;
        const wrap = pop.querySelector(".ui-palette");
        if (!wrap) return false;
        const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
        const cs = (el, pes) => (el ? getComputedStyle(el, pes) : null);
        const bad = [];
        const diag = [];
        const pick = async (id) => {
          wrap.querySelector(`.palette[data-value="${id}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(120);
        };
        /**
         * 「契约」= 这套**必须存在**的那几项（你 2026-10-08 拍的「按 round84 实机做」逐套清单）。
         * 数值只钉用户会看的那几个（圆角 10/6/8、描边 2px、白瓷条宽 3px）；渐变/阴影的**具体值**
         * 由生成器的 `--check` 盯（不在测试里抄一份）。
         */
        const CONTRACT = {
          endfield: { blockClip: true, cornerMark: true, headShadow: ["timeline", "backlog"] },
          terminal: { blockShadow: true, hud: true, headShadow: ["timeline"] },
          deepsea: { blockRadius: "10px", blockShadow: true, pageOverlay: true },
          bauhaus: { blockBorderWidth: "2px", headShadow: ["timeline", "backlog"] },
          artdeco: { blockShadow: true, headRule: true },
          cassette: { blockRadius: "6px", blockShadow: true, pageOverlay: true },
          north: { blockRadius: "8px", headShadow: ["timeline"] },
          brutal: { blockBorderWidth: "2px", blockShadow: true, headShadow: ["timeline"] },
          porcelain: { blockShadow: true, dayHeadRule: true, headShadow: ["timeline", "backlog"], itemLine: true, panelBorder: true, layerBarWidth: "3px" },
        };
        // 种一个「独占一列 + 浮层 inline」的块（斜切角的判据只用它 —— 全量跑时残留块可能全被挤成并排）
        const soloEl = await seedSoloBlock("r86wide");
        for (const [id, want] of Object.entries(CONTRACT)) {
          await pick(id);
          if (document.documentElement.dataset.palette !== id) {
            bad.push(`${id}:没切上`);
            continue;
          }
          const tok = {
            blockClip: cssVar("--deco-block-clip"),
            blockShadow: cssVar("--deco-block-shadow"),
            blockRadius: cssVar("--deco-block-radius"),
            blockBorderWidth: cssVar("--deco-block-border-width"),
            cornerMark: cssVar("--deco-corner-mark"),
            hudSize: cssVar("--deco-hud-size"),
            pageOverlay: cssVar("--deco-page-overlay"),
            headRule: cssVar("--deco-head-rule"),
            dayHeadRule: cssVar("--deco-day-head-rule"),
            itemLine: cssVar("--deco-item-line"),
            panelBorder: cssVar("--deco-panel-border"),
          };
          // ① 契约：该有的令牌必须在（生成物丢了值 → 这里红）
          for (const k of ["blockClip", "blockShadow", "cornerMark", "pageOverlay", "headRule", "dayHeadRule", "itemLine", "panelBorder"]) {
            if (want[k] && !tok[k]) bad.push(`${id}:缺 ${k}`);
          }
          if (want.hud && !tok.hudSize) bad.push(`${id}:缺 hudSize`);
          if (want.layerBarWidth && cssVar("--layer-bar-width") !== want.layerBarWidth) bad.push(`${id}:--layer-bar-width=${cssVar("--layer-bar-width")}`);
          // ② 机制：令牌 → 真渲染
          // 块外表：`block` = 任意计划中块（圆角/描边/阴影/伪元素都适用）；
          // **斜切角**只挂「非并排」块 → 单独取 `blockWide`（并排块不裁，见 TaskBlock 的注释）
          const block = document.querySelector(".block.planned") ?? document.querySelector(".block");
          const blockWide = soloEl;
          const bcs = cs(block);
          if (!bcs && (want.blockClip || want.blockShadow || want.blockRadius || want.blockBorderWidth || want.cornerMark || want.hud)) {
            bad.push(`${id}:找不到可测的 .block（声明了块外表却没法验）`);
          }
          if (want.blockClip) {
            const clip = blockWide ? cs(blockWide).clipPath : "none";
            if (!blockWide) bad.push(`${id}:找不到非并排的 inline 块（斜切角没法验）`);
            else if (clip === "none") bad.push(`${id}:块 clipPath=${clip}`);
          }
          if (bcs) {
            const shadow = bcs.boxShadow;
            if (want.blockShadow ? shadow === "none" : shadow !== "none") bad.push(`${id}:块 boxShadow=${shadow.slice(0, 30)}`);
            if (want.blockRadius && bcs.borderTopLeftRadius !== want.blockRadius) bad.push(`${id}:块圆角=${bcs.borderTopLeftRadius}`);
            if (want.blockBorderWidth && bcs.borderTopWidth !== want.blockBorderWidth) bad.push(`${id}:块描边=${
              bcs.borderTopWidth}`);
            const after = cs(block, "::after");
            const before = cs(block, "::before");
            if (want.cornerMark && after?.backgroundImage === "none") bad.push(`${id}:角上三角没画`);
            // HUD = 左上（`::before`）+ 右下（`::after`）**两个** L 形（6b 复核：原来只验了右下那一半）
            if (want.hud) {
              if (!after || after.borderRightWidth === "0px") bad.push(`${id}:右下 HUD 角标没画`);
              if (!before || before.borderTopWidth === "0px" || before.borderLeftWidth === "0px") {
                bad.push(`${id}:左上 HUD 角标没画`);
              }
              if (after && tok.hudSize && after.width !== tok.hudSize) {
                bad.push(`${id}:HUD 尺寸=${after.width}≠${tok.hudSize}`);
              }
            }
            // 终端的磷光写明「两层」→ 数一下真有几层（6b 复核：原来只判 !== none）
            if (id === "terminal" && shadow && shadow !== "none") {
              let d = 0;
              let layers = 1;
              for (const ch of shadow) {
                if (ch === "(") d += 1;
                else if (ch === ")") d -= 1;
                else if (ch === "," && d === 0) layers += 1;
              }
              if (layers < 2) bad.push(`terminal:块阴影只有 ${layers} 层（计划写的是 1px 线 + 磷光两层）`);
            }
          }
          // ③ 矮块（浮层挂在块外）**不许被裁** —— clip-path 会连后代一起裁（§5-DU 的冲突）
          const nonInline = [...document.querySelectorAll('.block:not([data-overlay="inline"])')];
          for (const b of nonInline) {
            if (getComputedStyle(b).clipPath !== "none") bad.push(`${id}:矮块被裁（${b.dataset.overlay}）`);
          }
          // ④ 整页叠层（深海光晕 / 卡带暗角）：画了 + 绝不吃手势
          const bodyAfter = cs(document.body, "::after");
          if (want.pageOverlay ? bodyAfter?.backgroundImage === "none" : bodyAfter?.backgroundImage !== "none") {
            bad.push(`${id}:body::after=${String(bodyAfter?.backgroundImage).slice(0, 24)}`);
          }
          if (bodyAfter?.pointerEvents !== "none") bad.push(`${id}:body::after pointer-events=${bodyAfter?.pointerEvents}`);
          // ⑤ 两个头部：inset 线 + 渐隐线（背景画）
          const th = document.querySelector(".timeline .head");
          const bh = document.querySelector(".backlog .head");
          const wantT = !!want.headShadow?.includes("timeline");
          const wantB = !!want.headShadow?.includes("backlog");
          if (th) {
            const c = cs(th);
            if (wantT ? c.boxShadow === "none" : c.boxShadow !== "none") bad.push(`${id}:时间轴头部线 ${c.boxShadow.slice(0, 24)}`);
            if (want.headRule ? c.backgroundImage === "none" : c.backgroundImage !== "none") bad.push(`${id}:头部渐隐线没画`);
          } else if (wantT || want.headRule) {
            bad.push(`${id}:找不到 .timeline .head（声明了头部装饰却没法验）`);
          }
          if (bh) {
            const c = cs(bh);
            if (wantB ? c.boxShadow === "none" : c.boxShadow !== "none") bad.push(`${id}:Backlog 头部线 ${c.boxShadow.slice(0, 24)}`);
          } else if (wantB) {
            bad.push(`${id}:找不到 .backlog .head（声明了头部装饰却没法验）`);
          }
          // ⑥ 日头下细线（白瓷，背景画）
          const dh = cs(document.querySelector(".day-head"));
          if (dh) {
            if (want.dayHeadRule ? dh.backgroundImage === "none" : dh.backgroundImage !== "none") bad.push(`${id}:日头下细线没画`);
          } else if (want.dayHeadRule) {
            bad.push(`${id}:找不到 .day-head（声明了日头下细线却没法验）`);
          }
          // ⑦ Backlog 行底细线（背景画）—— 这一层**总存在**（没声明 token 时是全透明渐变）
          const item = cs(document.querySelector(".backlog .pane .item"));
          if (item) {
            const invisible = /rgba\(0, 0, 0, 0\)|transparent/.test(item.backgroundImage);
            if (want.itemLine ? invisible : !invisible) bad.push(`${id}:行底细线=${item.backgroundImage.slice(0, 30)}`);
          } else if (want.itemLine) {
            bad.push(`${id}:找不到 .backlog .pane .item（声明了行底细线却没法验）`);
          }
          // ⑧ 面板描边（白瓷）：值换了 → 计算色不等于组件的默认 `--text-secondary`
          const panel = cs(document.querySelector(".overlay-panel"));
          if (panel && want.panelBorder) {
            const def = cssVar("--text-secondary");
            const toRgb = (v) => {
              const t = String(v).trim();
              if (/^#[0-9a-f]{6}/i.test(t)) return [1, 3, 5].map((i) => parseInt(t.slice(i, i + 2), 16)).join(",");
              const m = t.match(/rgba?\(([^)]+)\)/);
              return m ? m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number).join(",") : t;
            };
            if (toRgb(panel.borderTopColor) === toRgb(def)) {
              bad.push(`${id}:面板描边仍是默认色 ${panel.borderTopColor}`);
            }
          }
          diag.push(`${id}:clip=${tok.blockClip ? "有" : "-"} 影=${tok.blockShadow ? "有" : "-"} 叠层=${tok.pageOverlay ? "有" : "-"} 头线=${tok.headRule ? "有" : "-"}`);
        }
        // 收尾：回暖砂
        wrap.querySelector('.palette[data-value="warm"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        window.__DIAG.push(`r86③ ${diag.join(" | ")}；违规=[${bad.join(" ")}]`);
        return bad.length === 0;
      },
    ],
    // ===== round86（0.32.0 · ③b）：老 3 套零变化 =====
    [
      "round86 ③b：装饰零变化 —— 老 3 套的块外表 / 整页层 / 头部 / 面板描边 / 日头 = 今天的样子",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const pop = await openSettingsSub();
        if (!pop) return false;
        const wrap = pop.querySelector(".ui-palette");
        if (!wrap) return false;
        const bad = [];
        const toRgb = (v) => {
          const t = String(v).trim();
          if (/^#[0-9a-f]{6}/i.test(t)) return [1, 3, 5].map((i) => parseInt(t.slice(i, i + 2), 16)).join(",");
          const m = t.match(/rgba?\(([^)]+)\)/);
          return m ? m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number).join(",") : t;
        };
        for (const id of ["warm", "cool", "sage"]) {
          wrap.querySelector(`.palette[data-value="${id}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(120);
          const block = document.querySelector(".block");
          const bcs = block ? getComputedStyle(block) : null;
          const radius = bcs?.borderTopLeftRadius;
          if (bcs?.clipPath !== "none") bad.push(`${id}:块 clipPath=${bcs?.clipPath}`);
          if (bcs?.boxShadow !== "none") bad.push(`${id}:块 boxShadow=${bcs?.boxShadow}`);
          if (bcs?.borderTopWidth !== "1px") bad.push(`${id}:块描边=${bcs?.borderTopWidth}`);
          if (radius !== "2px" && radius !== "0px") bad.push(`${id}:块圆角=${radius}`);
          const bodyAfter = getComputedStyle(document.body, "::after");
          if (bodyAfter.backgroundImage !== "none") bad.push(`${id}:body::after=${bodyAfter.backgroundImage.slice(0, 20)}`);
          const th = document.querySelector(".timeline .head");
          if (getComputedStyle(th).boxShadow !== "none") bad.push(`${id}:时间轴头部有装饰线`);
          if (getComputedStyle(th).backgroundImage !== "none") bad.push(`${id}:时间轴头部有渐隐线`);
          const dh = document.querySelector(".day-head");
          if (getComputedStyle(dh).backgroundImage !== "none") bad.push(`${id}:日头有下细线`);
          const item = document.querySelector(".backlog .pane .item");
          if (item) {
            // 那一层本来就存在（透明渐变）→ “没变” = 它仍然全透明
            const invis = /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(item).backgroundImage);
            if (!invis) bad.push(`${id}:Backlog 行多了细线`);
          }
          // 面板：仍是组件默认描边（= `--text-secondary`）
          const panel = document.querySelector(".overlay-panel");
          const def = getComputedStyle(document.documentElement).getPropertyValue("--text-secondary").trim();
          if (panel && toRgb(getComputedStyle(panel).borderTopColor) !== toRgb(def)) {
            bad.push(`${id}:面板描边变了 ${getComputedStyle(panel).borderTopColor} ≠ ${def}`);
          }
          if (getComputedStyle(document.documentElement).getPropertyValue("--layer-bar-width").trim() !== "4px") {
            bad.push(`${id}:层条宽被改`);
          }
          // 今天那一列的微高光：老 3 套里 `--accent-deco` === `--accent` → 必须仍等于 6% accent 混底
          const tokHex = (n) => {
            const t = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
            return /^#[0-9a-f]{6}/i.test(t) ? [1, 3, 5].map((i) => parseInt(t.slice(i, i + 2), 16)) : null;
          };
          const acc = tokHex("--accent");
          const bgc = tokHex("--bg");
          if (acc && bgc && block) {
            const todayEl = document.querySelector(".day.today .day-body");
            if (todayEl) {
              const got = (getComputedStyle(todayEl).backgroundColor.match(/color\(srgb\s+([^)]+)\)|rgba?\(([^)]+)\)/) ?? [])
                .slice(1)
                .find(Boolean);
              const rgb = got
                ? got.split(/[,\s/]+/).filter(Boolean).slice(0, 3).map((x) => Math.round(Number(x) * (x.includes(".") ? 255 : 1)))
                : null;
              // CSS 是 `color-mix(in srgb, var(--accent-deco) 6%, var(--bg))` = 6% accent + 94% bg
              const want = bgc.map((c, i) => Math.round(c * 0.94 + acc[i] * 0.06));
              if (!rgb || want.some((w, i) => Math.abs(w - rgb[i]) > 2)) {
                bad.push(`${id}:今天列=${rgb?.join(",")} ≠ mix(accent,bg,6%)=${want.join(",")}`);
              }
            }
          }
          // 块的两个伪元素：0 尺寸 + 无背景（老 3 套不许有任何装饰几何）
          const after = block ? getComputedStyle(block, "::after") : null;
          const before = block ? getComputedStyle(block, "::before") : null;
          if (after && (after.width !== "0px" || after.backgroundImage !== "none")) {
            bad.push(`${id}:块 ::after 有几何（${after.width} / ${after.backgroundImage.slice(0, 16)}）`);
          }
          if (before && (before.width !== "0px" || before.borderTopWidth !== "0px")) {
            bad.push(`${id}:块 ::before 有几何（${before.width} / ${before.borderTopWidth}）`);
          }
        }
        wrap.querySelector('.palette[data-value="warm"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(120);
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        window.__DIAG.push(`r86③b 违规=[${bad.join(" ")}]`);
        return bad.length === 0;
      },
    ],
    // ===== round86（0.32.0 · ③c）：不吃手势 / 不缩命中区（斜切角那 9px 是已知代价）=====
    [
      "round86 ③c：装饰不吃手势 —— 整页层 pointer-events:none / 斜切角块仍可拖 / 矮块不被裁",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const pop = await openSettingsSub();
        if (!pop) return false;
        const wrap = pop.querySelector(".ui-palette");
        if (!wrap) return false;
        const bad = [];
        /** 切一套配色**并把设置面板关掉** —— 后面要做 elementFromPoint（面板开着会挡住时间轴，命中全落到面板上） */
        const cut = async (id) => {
          const pop2 = await openSettingsSub();
          pop2?.querySelector(`.ui-palette .palette[data-value="${id}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(120);
          pop2?.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(50);
        };
        // 种一个**独占一列**的 90 分钟块（非并排 → 会被斜切角裁；高 90 ≥ 54 → 浮层落点 inline）
        const solo = "r86solo";
        const soloEl = await seedSoloBlock(solo);
        /** 挑一个**看得见**的块（先滚进视口 —— 失效坐标会让 elementFromPoint 返回 null，假红）；
         *  只挑**非并排**块：斜切角只挂 `.block[data-overlay="inline"]:not(.narrow)`（并排窄块的浮层可能比块高）。 */
        const block = async () => {
          const list = [
            soloEl,
            ...document.querySelectorAll('.block.planned[data-overlay="inline"]:not(.narrow)'),
          ].filter(Boolean);
          for (const b of list) {
            b.scrollIntoView({ block: "center", inline: "nearest" });
            await settle(8);
            const r = b.getBoundingClientRect();
            if (r.top >= 76 && r.bottom <= window.innerHeight - 24) return b;
          }
          return list[0] ?? null;
        };
        // 基线（暖砂 = 无装饰）：块中心的命中 + 右上角命中
        await cut("warm");
        const base = await block();
        const hitInfo = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const mid = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
          const corner = document.elementFromPoint(Math.round(r.right - 3), Math.round(r.top + 3));
          return {
            rect: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
            id: el.dataset.blockId,
            mid: !!mid?.closest?.(".block"),
            midEl: mid ? mid.className || mid.tagName : "null",
            corner: !!corner?.closest?.(".block"),
            cornerEl: corner ? corner.className || corner.tagName : "null",
          };
        };
        const baseHit = hitInfo(base);
        if (!baseHit) bad.push("拿不到基线块");
        else if (!baseHit.mid) bad.push("基线：块中心点不到");
        // 谷地黄（斜切角）：中心仍可命中 / 右上角被裁掉（已知的 9×9 代价）
        await cut("endfield");
        const e = await block();
        const eHit = hitInfo(e);
        if (!e) bad.push("endfield：找不到非并排的 inline 块（斜切角没法验）");
        else if (e.dataset.cols !== "1") bad.push(`endfield：样本块不是独占一列（cols=${e.dataset.cols}）—— 判据要重挑时段`);
        if (!e) bad.push("endfield：没有可测的块");
        else {
          if (!eHit.mid) bad.push(`endfield：块中心点不到（${eHit.rect} 命中=${eHit.midEl}）`);
          if (eHit.corner) bad.push(`endfield：斜切角裁掉的那块仍可点（clip-path 没生效？命中=${eHit.cornerEl}）`);
          const handles = [...e.querySelectorAll(".resize")].map((h) => h.getBoundingClientRect().height);
          if (!handles.length || handles.some((h) => h <= 0)) bad.push(`endfield：把手高=${handles.join("/")}`);
        }
        // 并排窄块（`.narrow`）即使浮层落点 = inline 也**不许挂裁切**：窄块浮层会换行（每行 1–2 枚 24px），
        // 最坏 5 行 ≈ 130px，**可能比块还高**（6b 复核抓到的组合）→ 裁了就把按钮裁掉（且裁切区收不到点击）。
        // 手段：种三个**互相重叠**的块（3 列 = 最窄的浮层），再看按钮还能不能被点到。
        const seed = ["r86n1", "r86n2", "r86n3"];
        const dropSeed = () => {
          for (const id of seed) {
            const i = FIX.blocks.findIndex((b) => b.id === id);
            if (i >= 0) FIX.blocks.splice(i, 1);
          }
        };
        const goWeek = async (dir) => {
          const btn = document.querySelector(
            dir < 0 ? ".week-nav .now" : ".week-nav button[title^='下一周']",
          );
          btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(dir < 0 ? 90 : 60);
        };
        dropSeed();
        const base0 = at(1, 9, 0);
        seed.forEach((id, k) => {
          FIX.blocks.push(B(id, TEMP_TASK_ID, base0 + k * 300, base0 + 5400, "elastic", "planned"));
        });
        UNDO_SNAP = null;
        REDO_SNAP = null;
        window.__RESTORE = window.__RESTORE || [];
        window.__RESTORE.push(async () => {
          dropSeed();
          await goWeek(1);
          await goWeek(-1);
        });
        await goWeek(1);
        await goWeek(-1);
        const narrowInfo = seed.map((id) => {
          const b = document.querySelector(`[data-block-id="${id}"]`);
          if (!b) return { id, missing: true };
          const br = b.getBoundingClientRect();
          const a = b.querySelector(".actions");
          const ar = a?.getBoundingClientRect() ?? null;
          const overflowV = ar ? Math.round(Math.max(0, br.top - ar.top) + Math.max(0, ar.bottom - br.bottom)) : 0;
          // 让浮层可命中的开关（只是就地改内联样式，不动产品代码）：正常靠 hover
          if (a) {
            a.style.opacity = "1";
            a.style.pointerEvents = "auto";
          }
          const btn = a?.querySelector("button");
          const bb = btn?.getBoundingClientRect();
          const hit = bb
            ? document.elementFromPoint(Math.round(bb.left + bb.width / 2), Math.round(bb.top + bb.height / 2))
            : null;
          const hitBtn = !!hit && !!hit.closest?.(".actions");
          return {
            id, cols: b.dataset.cols, overlay: b.dataset.overlay, h: Math.round(br.height),
            aH: ar ? Math.round(ar.height) : 0, overflowV, clip: getComputedStyle(b).clipPath, hitBtn,
          };
        });
        for (const n of narrowInfo) {
          if (n.missing) bad.push(`并排样本 ${n.id} 没进 DOM`);
          else if (n.clip !== "none") {
            bad.push(
              `并排窄块被裁（${n.id} ${n.cols} 列 块高 ${n.h} 浮层高 ${n.aH} 纵向冒出 ${n.overflowV}px）——` +
                (n.hitBtn ? "这次按钮还点得到" : "按钮已点不到"),
            );
          } else if (!n.hitBtn) bad.push(`并排窄块按钮点不到（${n.id} ${n.cols} 列 块高 ${n.h} 浮层高 ${n.aH}）`);
        }
        // 整页层：pointer-events: none（所有配色）
        const bodyAfter = getComputedStyle(document.body, "::after");
        if (bodyAfter.pointerEvents !== "none") bad.push(`body::after pointer-events=${bodyAfter.pointerEvents}`);
        // 收尾：回暖砂（切回后把面板留着，交给后面的断言自己收）
        await cut("warm");
        window.__DIAG.push(`r86③c solo=${solo}:cols=${document.querySelector(`[data-block-id="${solo}"]`)?.dataset.cols} 基线=${JSON.stringify(baseHit)} endfield=${JSON.stringify(eHit)} 窄块=${JSON.stringify(narrowInfo.slice(0, 3))} 共${narrowInfo.length} 违规=[${bad.join(" ")}]`);
        return bad.length === 0;
      },
    ],
    // ===== round86（0.32.0 · ④）：窄窗选择器渐隐边（两侧按需隐）=====
    [
      "round86 ④：配色选择器的渐隐边 —— 起始位左端不淡 / 滚到最右右端不淡 / 末张仍到得了",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const pop = await openSettingsSub();
        if (!pop) return false;
        const wrap = pop.querySelector(".ui-palette");
        if (!wrap) return false;
        const bad = [];
        const maskOf = () => {
          const cs = getComputedStyle(wrap);
          return String(cs.maskImage ?? cs.webkitMaskImage ?? "");
        };
        const leftFaded = (m) => /rgba\(0, 0, 0, 0\) 0(px)?[,)]/.test(m);
        const rightFaded = (m) => /rgba\(0, 0, 0, 0\) 100%/.test(m);
        wrap.scrollLeft = 0;
        await frames(3);
        const mStart = maskOf();
        // 中间位置（两端都该淡）
        wrap.scrollLeft = Math.round((wrap.scrollWidth - wrap.clientWidth) * 0.5);
        await frames(3);
        const mMid = maskOf();
        // 最右
        wrap.scrollLeft = wrap.scrollWidth;
        await frames(3);
        const mEnd = maskOf();
        const last = wrap.querySelector(".palette:last-child")?.getBoundingClientRect();
        const cr = wrap.getBoundingClientRect();
        const reach = !!last && last.right <= cr.right + 1 && last.left >= cr.left - 1;
        if (mStart === "none") bad.push("没有 mask");
        if (leftFaded(mStart)) bad.push("起始位左端也在淡");
        if (!rightFaded(mStart)) bad.push("起始位右端没淡");
        if (!leftFaded(mMid) || !rightFaded(mMid)) bad.push(`中间位两端：左=${leftFaded(mMid)} 右=${rightFaded(mMid)}`);
        if (!leftFaded(mEnd)) bad.push("最右时左端没淡");
        if (rightFaded(mEnd)) bad.push("已滚到最右，右端还在淡");
        if (!reach) bad.push("末张到不了");
        wrap.scrollLeft = 0;
        await frames(2);
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        window.__DIAG.push(
          `r86④ 宽=${window.innerWidth} 滚动驱动=${CSS.supports?.("animation-timeline: scroll()")} 起=${mStart.slice(0, 60)} 终=${mEnd.slice(0, 60)} 违规=[${bad.join(" ")}]`,
        );
        return bad.length === 0;
      },
    ],
    // ===== round87（1.0.0 · 3.3 字体方案）：界面字体族五档 =====
    [
      "round87 ①：界面字体族五档 —— 即时生效 / data-font / 特征族名 / 重启记得 / 与展示字解耦 / 不破等宽",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const pop = await openSettingsSub();
        if (!pop) return false;
        const root = document.documentElement;
        const sel = pop.querySelector(".font-family");
        if (!sel) return false;
        /** 每档的**特征族名**（必须出现在 body 的 computed font-family 里）——
         *  default 额外要求**不得**含 mono 的特征族（两档栈里都有微软雅黑 UI，只查 includes 区分不出来）。
         *  `order` = 前两族逐字断言（`体-02`：拉丁先走 Segoe；等宽档是有意例外，不查顺序）。 */
        const MARK = {
          default: { has: ["Microsoft YaHei UI"], not: ["Cascadia Mono"] },
          song: { has: ["SimSun"] },
          kai: { has: ["KaiTi"] },
          deng: { has: ["DengXian"] },
          mono: { has: ["Cascadia Mono"] },
        };
        const bad = [];
        const pickFont = async (v) => {
          sel.value = v;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          await settle(140);
        };
        const pickPalette = async (id) => {
          pop.querySelector(`.ui-palette .palette[data-value="${id}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(140);
        };
        const firstOf = (el) => (el ? getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim() : "");
        const bodyStack = () => getComputedStyle(document.body).fontFamily;
        // 不破等宽：周日范围（`.timeline .head .range`）走 `--font-mono` —— 时间刻度 / 统计那族的前提
        const rangeStack = () => {
          const r = document.querySelector(".timeline .head .range");
          return r ? getComputedStyle(r).fontFamily : "";
        };
        const monoVar = () => getComputedStyle(root).getPropertyValue("--font-mono").trim();
        const before = { mono: monoVar(), range: rangeStack() };
        // UGC 回退（F5）：生僻字 / 假名 / emoji 不许渲染成豆腐块。
        // 判据 = 与「平面 16 私用区码位（无字体覆盖 → 必为 .notdef）」的**栅格**不同；相同就是豆腐。
        const rasterOf = (ch, stack = '20px "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif') => {
          const c = document.createElement("canvas");
          c.width = 32;
          c.height = 32;
          const g = c.getContext("2d");
          g.font = stack;
          g.fillText(ch, 2, 24);
          return c.toDataURL();
        };
        const UGC = ["\u{20BB7}", "あ", "😀"]; // 生僻字（CJK 扩展 B）/ 平假名 / emoji
        for (const v of ["song", "kai", "deng", "mono", "default"]) {
          await pickFont(v);
          const stackStr = bodyStack();
          if (root.dataset.font !== v) bad.push(`${v}: data-font=${root.dataset.font}`);
          for (const m of MARK[v].has) if (!stackStr.includes(m)) bad.push(`${v}: body=${stackStr.slice(0, 80)}（缺 ${m}）`);
          for (const m of MARK[v].not ?? []) if (stackStr.includes(m)) bad.push(`${v}: body 里不该有 ${m}`);
          // `体-02`：四个 CJK 档的前两族必须是 Segoe（拉丁先走 Segoe）—— 只查 includes 会被「顺序颠倒」蒙过
          if (v !== "mono") {
            const head = stackStr.split(",").slice(0, 2).map((s) => s.replace(/["']/g, "").trim()).join("|");
            if (head !== "Segoe UI Variable Text|Segoe UI") bad.push(`${v}: 前两族=${head}（应 Segoe UI Variable Text|Segoe UI）`);
          }
          const stack = `20px ${stackStr}`;
          // 豆腐参考必须用**同一条栈**现算：不同字体的 .notdef 盒子不一样（mono 实测）
          const tofu = rasterOf("\u{10FFFD}", stack);
          // 探针自检（CHECK 规矩 29）：另一个私用区码位**必须**与参考栅格相同 ——
          // 不同就说明参考不是 .notdef 盒子（检测器会失明）→ 这条自检失败要报红。
          if (rasterOf("\u{10FFFE}", stack) !== tofu) bad.push(`${v}: 豆腐块探针自检失败（参考栅格不是 .notdef）`);
          for (const ch of UGC) {
            if (rasterOf(ch, stack) === tofu) bad.push(`${v}: U${ch.codePointAt(0).toString(16)} 是豆腐块`);
          }
        }
        // 写失败要拨回（与时间格式 / 图标集同款口径）：假后端置一次失败 → 控件与 <html> 都不许变
        window.__FAIL_SET_SETTING_ONCE = true;
        const beforeFail = root.dataset.font;
        sel.value = beforeFail === "song" ? "kai" : "song";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await settle(180);
        if (root.dataset.font !== beforeFail) bad.push(`写失败却生效了：${beforeFail} → ${root.dataset.font}`);
        if (sel.value !== beforeFail) bad.push(`写失败控件没拨回：${sel.value} ≠ ${beforeFail}`);
        // 与展示字解耦：换族不改「装了自己展示字」的两套（北境 = Samigirian / 装饰艺术 = Poiret One）
        await pickPalette("north");
        await pickFont("song");
        const northSong = firstOf(pop.querySelector(".pop-title"));
        await pickFont("mono");
        const northMono = firstOf(pop.querySelector(".pop-title"));
        await pickPalette("artdeco");
        const decoSong = firstOf(pop.querySelector(".pop-title"));
        await pickFont("kai");
        const decoKai = firstOf(pop.querySelector(".pop-title"));
        if (northSong !== "Samigirian" || northMono !== "Samigirian") bad.push(`北境展示字被字体族带跑：${northSong}/${northMono}`);
        if (decoSong !== "Poiret One" || decoKai !== "Poiret One") bad.push(`装饰艺术展示字被字体族带跑：${decoSong}/${decoKai}`);
        if (monoVar() !== before.mono) bad.push(`--font-mono 变了：${before.mono} → ${monoVar()}`);
        if (before.range && rangeStack() !== before.range) bad.push(`周范围字体栈变了：${before.range} → ${rangeStack()}`);
        if (!rangeStack()) bad.push("量不到周范围元素（.timeline .head .range）—— 等宽那条判据没牙了");
        // 重启记得（假后端回读）：切成 song → 关面板 → **把假库拨成 kai** → 重开
        // （只查残留没意义 —— 内存里的 appearance.font 本来就是 song；拨成 kai 才能证明**读回**真的走了）
        await pickPalette("warm");
        await pickFont("song");
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        if (window.__SANITY_STATE) window.__SANITY_STATE.uiFont = "kai";
        const pop2 = await openSettingsSub();
        await settle(140);
        const stored = window.__SANITY_STATE?.uiFont;
        const reopened = root.dataset.font === "kai" && bodyStack().includes("KaiTi") && stored === "kai";
        if (!reopened) bad.push(`重启没记得（假库=kai）：假库=${stored} data-font=${root.dataset.font}`);
        const sel2 = pop2.querySelector(".font-family");
        if (sel2) {
          sel2.value = "default";
          sel2.dispatchEvent(new Event("change", { bubbles: true }));
          await settle(120);
        }
        pop2.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        window.__DIAG.push(`r87① ${JSON.stringify({ northSong, northMono, decoSong, decoKai, stored })} 违规=[${bad.join(" ")}]`);
        return bad.length === 0;
      },
    ],
    [
      "round87 ②：四款自带展示字 —— 装饰艺术 Poiret One / 包豪斯 Jost / 野兽派 Archivo Black / 白瓷 Marcellus；老 3 套仍是界面字体",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(30);
        const pop = await openSettingsSub();
        if (!pop) return false;
        // 先把字体族摆回默认档（这条断言要的「老 3 套不变」= 界面字体那套）
        const fsel = pop.querySelector(".font-family");
        if (fsel && fsel.value !== "default") {
          fsel.value = "default";
          fsel.dispatchEvent(new Event("change", { bubbles: true }));
          await settle(140);
        }
        const pick = async (id) => {
          pop.querySelector(`.ui-palette .palette[data-value="${id}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await settle(140);
        };
        const firstOf = (el) => (el ? getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim() : "");
        /** 三处展示字（与 round85 ② 同一组读者：日头 / Backlog 标题 / 面板标题） */
        const read = () => ({
          day: firstOf(document.querySelector(".day-head .day-pick")),
          title: firstOf(document.querySelector(".backlog .title")),
          popTitle: firstOf(pop.querySelector(".pop-title")),
        });
        const WANT = { artdeco: "Poiret One", bauhaus: "Jost", brutal: "Archivo Black", porcelain: "Marcellus" };
        const NEW_FONTS = Object.values(WANT);
        const bad = [];
        const seen = {};
        for (const [id, font] of Object.entries(WANT)) {
          await pick(id);
          const r = read();
          seen[id] = r;
          if (r.day !== font || r.title !== font || r.popTitle !== font) {
            bad.push(`${id}: ${JSON.stringify(r)} ≠ 三处 ${font}`);
          }
        }
        // 真加载（不只是 computed 名 —— 名字写错/字体没落地时 computed 首项照样对）：
        // ⚠️ 不能用 `document.fonts.check()` —— 它对**未声明的族**也返回 true（当成系统字体）；
        // 要的是「FontFaceSet 里真有一条 **loaded** 的同名 @font-face」（6b 复核 P2 补）。
        await document.fonts.ready;
        const loadedFamilies = new Set(
          [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, "")),
        );
        for (const [id, font] of Object.entries(WANT)) {
          if (!loadedFamilies.has(font)) bad.push(`${id}: ${font} 没真加载（document.fonts 里没有 loaded 的 @font-face）`);
        }
        // 老 3 套不受影响：三处仍是界面字体首项（= 旧观感；生成物里这三套没动过）
        for (const id of ["warm", "cool", "sage"]) {
          await pick(id);
          const r = read();
          seen[id] = r;
          if ([r.day, r.title, r.popTitle].some((f) => NEW_FONTS.includes(f))) bad.push(`${id} 串上新字体：${JSON.stringify(r)}`);
          if (r.day !== "Segoe UI Variable Text" || r.title !== "Segoe UI Variable Text" || r.popTitle !== "Segoe UI Variable Text") {
            bad.push(`${id} 展示字首项变了：${JSON.stringify(r)}`);
          }
        }
        await pick("warm");
        pop.querySelector(".close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(30);
        window.__DIAG.push(`r87② ${JSON.stringify(seen)} 违规=[${bad.join(" ")}]`);
        return bad.length === 0;
      },
    ],
    // ===== round87.1（1.0.1 · 验收回修）：动作浮层两态都不许挡拖 =====
    [
      "round87.1 ①：动作浮层 —— inline 块要留 ≥16px 拖拽面 / above·below 块与块身不相交、不冒出列外",
      async () => {
        await press("Escape");
        await press("Escape");
        await settle(40);
        const info = [...document.querySelectorAll("[data-block-id]")].map((n) => {
          const a = n.querySelector(".actions");
          if (!a) return null;
          const br = n.getBoundingClientRect();
          const ar = a.getBoundingClientRect();
          const db = n.closest(".day-body")?.getBoundingClientRect();
          return {
            id: n.dataset.blockId,
            mode: n.dataset.overlay,
            narrow: n.classList.contains("narrow"),
            h: Math.round(br.height),
            ah: Math.round(ar.height),
            gap: Math.round(Math.max(0, Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top))),
            inside: !db || (ar.top >= db.top - 1 && ar.bottom <= db.bottom + 1),
          };
        }).filter(Boolean);
        const bad = [];
        for (const r of info) {
          if (r.mode === "inline") {
            // inline 时浮层垂直居中：上下各留 (h-ah)/2；< 16 就凑不出「4px 把手 + 4px 拖拽面」
            if (r.h - r.ah < 16) bad.push(`${r.id}${r.narrow ? "(窄)" : ""}: inline 浮层 ${r.ah}px 压在 ${r.h}px 的块上（拖拽面 ${r.h - r.ah} < 16）`);
          } else if (r.mode === "above" || r.mode === "below") {
            if (r.gap !== 0) bad.push(`${r.id}: ${r.mode} 浮层与块身相交 ${r.gap}px（应 0）`);
            if (!r.inside) bad.push(`${r.id}: ${r.mode} 浮层冒出列外（会被 overflow 裁掉）`);
          }
        }
        window.__DIAG.push(`r87.1① 块数=${info.length} 违规=${bad.length}${bad.length ? " " + bad.slice(0, 4).join(" | ") : ""}`);
        return bad.length === 0;
      },
    ],
    // ===== round87.2（1.0.2 · 你的两条 UI 要求）：角标进右下角 + 浮层优先往块下面挂 =====
    [
      "round87.2 ①：⊘ 角标跟 🔁 一样在块**右下角**（不再挂名字左边）+ 浮层**优先在块下面**（下面放不下才上面）",
      async () => {
        await press("Escape");
        await press("Escape");
        await backToThisWeek();
        setScrollHome();
        await settle(40);
        const bad = [];
        // ① 造一个 ⊘：把「理智靶子」标成不计入（与 round48 ② 同一条真 UI 路径）
        const row = [...document.querySelectorAll(".item")].find((n) => n.textContent.includes("理智靶子"));
        if (!row?.querySelector("button.exempt")) return false;
        row.querySelector("button.exempt").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(60);
        // ② 角标几何：右下角 + 不吃名字
        const marks = [...document.querySelectorAll(".block .exempt-mark, .block .repeat-mark")];
        for (const m of marks) {
          const block = m.closest("[data-block-id]");
          const id = block?.dataset.blockId ?? "?";
          const cluster = m.closest(".corner-marks");
          if (!cluster) {
            bad.push(`${id}: ${m.className} 不在 .corner-marks 里（旧写法？）`);
            continue;
          }
          const b = block.getBoundingClientRect();
          const c = cluster.getBoundingClientRect();
          const dR = Math.round(b.right - c.right);
          const dB = Math.round(b.bottom - c.bottom);
          if (dR < 0 || dR > 8) bad.push(`${id}: 角标离右边 ${dR}px（期望 0–8）`);
          if (dB < 0 || dB > 8) bad.push(`${id}: 角标离底边 ${dB}px（期望 0–8）`);
          if (block.querySelector(".name .exempt-mark")) bad.push(`${id}: ⊘ 还挂在名字里面`);
        }
        // ③ 浮层偏好：块下面放得下（≥ 浮层高 + 26）→ 必须 below
        for (const n of document.querySelectorAll("[data-block-id]")) {
          const a = n.querySelector(".actions");
          if (!a) continue;
          const mode = n.dataset.overlay;
          if (mode !== "above" && mode !== "below") continue;
          const day = n.closest(".day-body")?.getBoundingClientRect();
          if (!day) continue;
          const b = n.getBoundingClientRect();
          const actH = a.getBoundingClientRect().height;
          const roomBelow = day.bottom - b.bottom;
          if (roomBelow >= actH + 26 && mode !== "below") {
            bad.push(`${n.dataset.blockId}: 下面有 ${Math.round(roomBelow)}px（浮层 ${Math.round(actH)}px）却挂在上面`);
          }
        }
        // 还原（别把假库留在标记态）
        document.querySelector(".item button.exempt.off")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle(40);
        window.__DIAG.push(
          `r87.2① 角标=${marks.length} 外沿块=${document.querySelectorAll('[data-block-id][data-overlay="above"],[data-block-id][data-overlay="below"]').length} 违规=${bad.length}${bad.length ? " " + bad.slice(0, 4).join(" | ") : ""}`,
        );
        return bad.length === 0;
      },
    ],
  ];
}

// C1.7：先合成一次「双击块」（b1）与一次「双击左侧色条」（b3 的），再断言
setTimeout(() => {
  const fire = (target) =>
    target?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  fire(document.querySelector('[data-block-id="b1"] .label'));
  fire(document.querySelector('[data-block-id="b3"] .layer-bar'));
}, 300);

setTimeout(async () => {
  document.documentElement.dataset.checks = "running";
  mark("start");
  const lines = [];
  /** round79（工具改进）：**失败断言自己那几条 DIAG** —— 旧写法只印「最后 40 条」，
   *  一旦失败点比较靠前（后面还有几十条断言推 DIAG）就再也看不到现场（本轮实测：r77 的失败原因被挤掉）。 */
  const failedDiag = [];
  // ⚠️ 必须 await 每一条 —— 断言里有 async 的（跳周那几条），
  // 以前没 await 时 !!Promise 恒为 true → 永远打 ✓（假绿 ✗，2026-10-01 维护轮抓到）
  for (const [name, fn] of domChecks()) {
    // round44：`--only` 只跑名字含该子串的断言（窄窗口下老断言本来就允许不成立，见 preview.mjs 注释）
    if (window.__ONLY && !name.includes(window.__ONLY)) continue;
    let ok = false;
    // round74（6b P2-1a）：断言可以返回 `{skip}` —— 不计入分母、不算失败（以前「没开伪语言就 return true」= 假绿）
    let skip = null;
    // 卡在哪一条要看得见（虚拟时间下 rAF 循环不停会把页面拖成「永不空闲」）
    mark(name);
    const diagMark = (window.__DIAG || []).length;
    try {
      const r = await fn();
      if (r && typeof r === "object" && r.skip) skip = r.why ?? "";
      else ok = !!r;
    } catch (err) {
      // 断言里抛异常 = 失败；把原因写进 DIAG，失败时好定位（不然只剩一个 ✗）
      window.__DIAG.push("ERR " + name.slice(0, 16) + " → " + err);
      // round79：**最后一条异常**单独留一份 —— DIAG 可能被后一条断言推挤，而它才是失败的真因
      window.__LAST_ERR = "ERR " + name.slice(0, 24) + " → " + err;
      ok = false;
    }
    // round78（3.1b₂ · 6b P1）：round78 的种子/还原只在 happy path 上成立 —— 提前 `return` 或抛异常
    // 会让 `r78Stash` 挂着（本周真块留在 stash 里、假库里只剩种子块）→ 后面所有「本周有块吗」的
    // 判据（含全矩阵）都失真。这里统一兜底：任何一条断言跑完，只要 stash 还在就还原。
    if (window.__R78?.stash) {
      try {
        await window.__R78.restore?.();
      } catch (err) {
        window.__DIAG.push("ERR round78 种子兜底还原 → " + err);
      }
    }
    // round80（6b P2）：**通用兜底钩子** —— 断言可以 `window.__RESTORE.push(async () => …)` 注册还原；
    // 无论该条断言是提前 return 还是抛异常，跑完都会走一遍（round80 ② 的 template_preview 开关就用它）。
    if (window.__RESTORE?.length) {
      const restorers = window.__RESTORE;
      window.__RESTORE = [];
      for (const restore of restorers) {
        try {
          await restore();
        } catch (err) {
          window.__DIAG.push("ERR 兜底还原 → " + err);
        }
      }
    }
    if (skip === null && !ok) failedDiag.push(...(window.__DIAG || []).slice(diagMark));
    lines.push(skip !== null ? `— ${name}（跳过：${skip}）` : (ok ? "✓ " : "✗ ") + name);
  }
  // 截图证据：断言跑完再故意留一个「拖到周六」的手势在屏幕上 —— 辅助线要能被人眼看到
  // （09:00 是因为截图窗口只到 ~13:45；俯视验证看这张图就行）
  dragStartBlock("b2");
  dragToDay(5, 9, 0);

  await frames(4);
  const shotLines = [...document.querySelectorAll(".align-line")]
    .map((n) => Math.round(n.getBoundingClientRect().top))
    .join("/");
  const bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;left:0;top:0;right:0;z-index:9999;background:#111;color:#e9e9e9;" +
    "font:12px/1.55 Consolas,monospace;padding:6px 10px;white-space:pre;border-bottom:2px solid #333;" +
    // 条子太长会把时间轴顶出画面（截图就没法看了）→ 限高；机器判读靠 document.title，不靠这张图
    "max-height:38vh;overflow:hidden";
  bar.textContent = lines.join("\n");
  document.body.append(bar);
  document.body.style.paddingTop = bar.getBoundingClientRect().height + "px";
  // 机器可读结果：node 侧用 --dump-dom 把 title 抠出来断言（有 ✗ 就非零退出）
  const ran = lines.filter((l) => !l.startsWith("—"));
  const skippedN = lines.length - ran.length;
  const failed = ran.filter((l) => !l.startsWith("✓"));
  const wins = (window.__DBG || []).length;
  const lastWin = (window.__DBG || [])[wins - 1];
  document.title =
    (failed.length === 0 ? "ALLOK" : "FAIL") +
    " " +
    ran.length +
    " 条" +
    (skippedN ? `（跳过 ${skippedN}）` : "") +
    " ｜ list_blocks 次数=" + +
    wins +
    " 最后一次窗口=" +
    (lastWin ? lastWin[0] + ".." + lastWin[1] : "-") +
    " ｜ 截图时的辅助线 y=" +
    shotLines +
    (failed.length ? " ｜ " + failed.map((l) => l.replace("✗ ", "")).join(" ｜ ") : "") +
    // 调试用：断言可以往 window.__DIAG 里塞现场（失败时才好定位，不靠猜）
    // round79：优先印**失败断言自己那几条**（旧写法只印最后 40 条 —— 失败点靠前时现场会被冲掉）
    (failed.length
      ? " ｜ DIAG " +
        (failedDiag.length ? failedDiag.slice(-12).join(" ; ") : (window.__DIAG || []).slice(-40).join(" ; "))
      : "") +
    (failed.length && window.__LAST_ERR ? " ｜ 最后异常 " + String(window.__LAST_ERR).slice(0, 400) : "");
}, 700);
