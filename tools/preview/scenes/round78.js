/**
 * round78（3.1b₂）：本批 5 条修复的**改前 / 改后对照图**场景表
 * （`preview.mjs --shots <目录> --shots-file scenes/round78.js --width <1500|737|715>`）。
 *
 * 每幕只摆一个状态、不留言外手势；同名场景**改前改后各跑一次** → 两张图能直接对照：
 *   01 动作浮层：链接连上之后，⛓ 按钮保持焦点 → 浮层常亮（改后：鼠标不在就没浮层）
 *   02 键位条：选中一块 → 键位提示那一行（改后：窄窗走紧凑档，不硬裁、不压行）
 *   03 键盘聚焦：Tab 到块上 → 四个动作浮层压在块名上（改后：块聚焦不浮出，名字看得见）
 *   04 顶部空槽：没有选中、没有提示条 → 顶部那条 28px 空槽（改后：槽收起，不留空）
 */
document.documentElement.dataset.checks = "shots";

const flush = () => new Promise((r) => queueMicrotask(() => queueMicrotask(r)));
const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) await flush();
};

const el = (id) => document.querySelector('[data-block-id="' + id + '"]');
const click = (sel) => {
  const n = typeof sel === "string" ? document.querySelector(sel) : sel;
  if (!n) return false;
  n.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
};
/** 与断言里 `selectByClick` 同一条事件路径：按下 → 抬起 → 补焦点 */
const selectBlock = async (id) => {
  const node = el(id);
  if (!node) throw new Error("没有这块：" + id);
  const r = node.getBoundingClientRect();
  const p = { clientX: r.left + 20, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true };
  node.dispatchEvent(new PointerEvent("pointerdown", p));
  node.dispatchEvent(new PointerEvent("pointerup", p));
  node.focus({ preventScroll: true });
  await settle(30);
};
/** 清掉选中（点空白格：与真手势同一条路） */
const clearSel = async () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await settle(20);
  document.activeElement?.blur?.();
  await settle(20);
};
/** 把提示条都关掉（橙 / 绿 / 渐进）—— 幕 04 要的就是「一条都没有」的空槽 */
const dismissBars = async () => {
  for (let i = 0; i < 4; i++) {
    document.querySelectorAll(".hint-slot .sanity-dismiss, .hint-slot .nudge .close, .hint-slot .guide-bar .dismiss").forEach((b) => {
      b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(20);
  }
};
const actionsOpacity = (id) => {
  const a = el(id)?.querySelector(".actions");
  return a ? Number(getComputedStyle(a).opacity) : -1;
};
const slotHeight = () => {
  const n = document.querySelector(".hint-slot");
  return n ? Math.round(n.getBoundingClientRect().height) : -1;
};

window.__SHOTS = [
  {
    // 01：真机上「链两块 → 点后者 ⛓」之后，按钮留着焦点 → 浮层常亮（鼠标早就不在块上了）
    name: "01-动作浮层-链接后常亮",
    run: async () => {
      await settle(60);
      await clearSel();
      const b22 = el("b22")?.querySelector(".actions .link");
      const b24 = el("b24")?.querySelector(".actions .link");
      if (!b22 || !b24) throw new Error("没有 ⛓ 按钮（序列开关关了？）");
      b22.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 拿起线头
      await settle(30);
      b24.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 接上
      await settle(40);
      b24.focus({ preventScroll: true }); // 真鼠标点完就是这个状态（焦点留在按钮上）
      await settle(40);
      window.__DIAG = window.__DIAG ?? [];
      window.__DIAG.push("r78shots 01 链接后 焦点=" + (document.activeElement?.className ?? "") + " b24 浮层 alpha=" + actionsOpacity("b24"));
    },
  },
  {
    // 02：选中一块 → 键位提示条那一行（窄窗复现「贴着周范围 + 右端硬裁」）
    name: "02-键位条-选中一块",
    run: async () => {
      await settle(40);
      await clearSel();
      await selectBlock("b22");
      const kh = document.querySelector(".key-hint");
      const range = document.querySelector(".timeline .range");
      const box = (n) => {
        if (!n) return null;
        const r = n.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      };
      window.__DIAG = window.__DIAG ?? [];
      window.__DIAG.push(
        "r78shots 02 键位条=" +
          JSON.stringify(box(kh)) +
          " 周范围=" +
          JSON.stringify(box(range)) +
          " 内容宽/容器宽=" +
          (kh ? kh.scrollWidth + "/" + kh.clientWidth : "-"),
      );
      await settle(40);
    },
  },
  {
    // 03：键盘聚焦一块（Tab 到块上）→ 四个动作浮层压在块名上
    name: "03-键盘聚焦-浮层压名字",
    run: async () => {
      await settle(40);
      await clearSel();
      const narrow = document.querySelector(".block.narrow") ?? el("b22");
      narrow.focus({ preventScroll: true });
      await settle(60);
      const name = narrow.querySelector(".name");
      const rect = (n) => {
        if (!n) return null;
        const r = n.getBoundingClientRect();
        return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
      };
      const a = rect(narrow.querySelector(".actions"));
      const b = rect(name);
      const hit = a && b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
      window.__DIAG = window.__DIAG ?? [];
      window.__DIAG.push(
        "r78shots 03 聚焦=" + (document.activeElement?.className ?? "") + " 浮层alpha=" + actionsOpacity(narrow.dataset.blockId) +
          " 浮层=" + JSON.stringify(a) + " 名字=" + JSON.stringify(b) + " 相交=" + hit,
      );
      await settle(40);
    },
  },
  {
    // 05：覆盖面板的**新外壳**（round78 栈-04：固定左缘 + 2 档宽度）—— 拍给验收看
    name: "05-面板-统计算新外壳",
    run: async () => {
      await settle(40);
      await clearSel();
      document.querySelector(".stats-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(80);
      const p = document.querySelector(".stats-panel");
      const r = p?.getBoundingClientRect();
      window.__DIAG = window.__DIAG ?? [];
      window.__DIAG.push("r78shots 05 统计面板 rect=" + (r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(",") : "-"));
      await settle(40);
    },
  },
  {
    // 04：没有选中、没有提示条 → 顶部那条空槽
    name: "04-顶部空槽-没有内容",
    run: async () => {
      await settle(40);
      await clearSel();
      await dismissBars();
      window.__DIAG = window.__DIAG ?? [];
      window.__DIAG.push(
        "r78shots 04 槽高=" + slotHeight() + " 槽内子元素=" + (document.querySelector(".hint-slot")?.children.length ?? -1) +
          " 头部高=" + Math.round(document.querySelector(".timeline .head").getBoundingClientRect().height),
      );
      await settle(40);
    },
  },
  // ===== round78（3.1b₂ · 段 1）：设置页 IA 重排（设-01/02/03/05）=====
  {
    // 06：设置 = 覆盖面板 640 + 分区导航 + ① 主题与颜色（配色/深浅色/图标三处预览选择器）
    name: "06-设置-主题与颜色（预览选择器）",
    run: async () => {
      await settle(40);
      await clearSel();
      // 先真键盘关掉可能开着的面板（与 `clearSel` 同一条派发路径；场景表里没有 `press` 帮手）
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await settle(20);
      document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(60);
      const pop = document.querySelector(".sanity-pop");
      const r = pop?.getBoundingClientRect();
      window.__DIAG = window.__DIAG ?? [];
      window.__DIAG.push(
        "r78shots 06 设置 rect=" +
          (r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(",") : "-") +
          " 导航=" + document.querySelectorAll(".sanity-pop .nav-btn").length,
      );
      await settle(40);
    },
  },
  {
    // 07：② 字号与密度（三张小卡）+ ③ 时间轴（含「现在线」新开关）
    name: "07-设置-密度与时间轴",
    run: async () => {
      await settle(40);
      click(".nav-btn[data-group='density']");
      await settle(40);
    },
  },
  {
    // 08：④ 提醒与控制 —— 复盘 / 免打扰 / 键位提示（设置行两段式：标签行 + 控件行）
    name: "08-设置-提醒与控制",
    run: async () => {
      await settle(40);
      click(".nav-btn[data-group='alert']");
      await settle(40);
    },
  },
  {
    // 09：⑤「更多」（低频区默认收起）→ 展开 + 数据 / 功能开关两个子区
    name: "09-设置-更多折叠区展开",
    run: async () => {
      await settle(40);
      click(".nav-btn[data-group='more']");
      await settle(30);
      click(".more-toggle");
      await settle(30);
      click(".data-toggle");
      await settle(30);
      click(".features-toggle");
      await settle(40);
    },
  },
  // ===== round78（3.1b₂ · 段 2）：快捷键 + 空态 =====
  {
    // 10：`?` 快捷键总表（子层：叠在设置上；正文 = KeyTable 共用件）
    name: "10-快捷键总表-叠在设置上",
    run: async () => {
      await settle(40);
      // 先把设置面板收掉，再从时间轴按 ? 打开（叠层另拍：设置 → ?）
      document.querySelectorAll(".overlay-backdrop").forEach((b) => b.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await settle(30);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true, cancelable: true }));
      await settle(60);
      const p = document.querySelector(".keymap-panel");
      const r = p?.getBoundingClientRect();
      window.__DIAG = window.__DIAG ?? [];
      window.__DIAG.push(
        "r78shots 10 快捷键面板 rect=" + (r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(",") : "-") +
          " 行=" + document.querySelectorAll(".keymap-panel .keys tr").length,
      );
      await settle(30);
    },
  },
  {
    // 11：设置 → 更多 → 键位说明（开关 + 「打开快捷键总表」入口），再关掉快捷键面板回设置
    name: "11-设置-键位说明入口",
    run: async () => {
      await settle(30);
      // 关掉快捷键面板 → 开设置 → 更多 → 键位说明
      document.querySelector(".keymap-panel .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(30);
      document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(40);
      click(".nav-btn[data-group='more']");
      await settle(30);
      click(".more-toggle");
      await settle(30);
      click(".keys-toggle");
      await settle(40);
    },
  },
  {
    // 12：Backlog 空库空态（一句话 + 「写第一件事」）；拍完通过 Ctrl+Shift+Z 原样还原
    name: "12-空态-Backlog（空库）",
    run: async () => {
      await settle(30);
      document.querySelectorAll(".overlay-backdrop").forEach((b) => b.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await settle(20);
      // 一步对称的块写入（后面靠撤销/重做触发 loadTasks）
      const blk = document.querySelector('[data-block-id="b22"]');
      if (blk) {
        const r = blk.getBoundingClientRect();
        const p = { clientX: r.left + 20, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true };
        blk.dispatchEvent(new PointerEvent("pointerdown", p));
        blk.dispatchEvent(new PointerEvent("pointerup", p));
        blk.focus({ preventScroll: true });
        await settle(30);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
        await settle(50);
      }
      window.__TASKS_EMPTY = true;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
      await settle(80);
      window.__DIAG = window.__DIAG ?? [];
      window.__DIAG.push("r78shots 12 空态行=" + document.querySelectorAll(".list .item").length + " 文案=[" + (document.querySelector(".list .empty-text")?.textContent ?? "") + "]");
      await settle(30);
    },
  },
  {
    // 12b：收尾还原（重做 → loadTasks 拿回真表）
    name: "12b-空态还原",
    run: async () => {
      await settle(30);
      document.activeElement?.blur?.();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      await settle(80);
      window.__DIAG.push("r78shots 12b 还原行数=" + document.querySelectorAll(".list .item").length);
    },
  },
  {
    // 13：空周指路（整周空才有那一句）；拍完原样还原
    name: "13-空态-空周指路",
    run: async () => {
      await settle(30);
      const stash = [];
      for (let i = FIX.blocks.length - 1; i >= 0; i--) {
        stash.push({ i, b: FIX.blocks[i] });
        FIX.blocks.splice(i, 1);
      }
      window.__R78_STASH = stash;
      // 强制重拉：跳走再回来
      document.querySelector(".next-week")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(60);
      document.querySelector(".prev-week")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(60);
      window.__DIAG.push("r78shots 13 空周提示=" + (!!document.querySelector(".week-empty")) + " 文案=[" + (document.querySelector(".week-empty")?.textContent ?? "") + "]");
      await settle(30);
    },
  },
  {
    // 13b：还原块表 + 重拉（后续场景 / 断言不受影响）
    name: "13b-空周还原",
    run: async () => {
      await settle(30);
      const stash = window.__R78_STASH ?? [];
      stash.sort((a, b) => a.i - b.i);
      for (const { i, b } of stash) FIX.blocks.splice(Math.min(i, FIX.blocks.length), 0, b);
      window.__R78_STASH = null;
      document.querySelector(".next-week")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(60);
      document.querySelector(".prev-week")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(60);
      window.__DIAG.push("r78shots 13b 还原后提示=" + (!!document.querySelector(".week-empty")));
    },
  },
  {
    // 14：统计空态（带直接动作：去时间轴排一块）
    name: "14-空态-统计（带动作）",
    run: async () => {
      await settle(30);
      window.__STATS_EMPTY = true;
      document.querySelector(".stats-open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(80);
      window.__DIAG.push("r78shots 14 空态动作=" + (!!document.querySelector(".stats-panel .empty-action")));
      await settle(30);
    },
  },
];
