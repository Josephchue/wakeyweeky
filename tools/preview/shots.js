/**
 * round61（0.15.0）：**演示截图**的场景表 —— 给 `preview.mjs --shots <dir>` 用。
 *
 * 这一批演示的是「10.2 多选与批量操作」：三种选择入口、框选、动作条四类批量动作
 * （完成 / 未完成 / 删除 / 挪天 / 改层）、一步撤销、融合后的选中收口、Ctrl+A 全选。
 *
 * 为什么单独一份（不进断言套件）：断言是给机器看的（快、密、不留手势）；
 * 演示是给人看的（一屏一件事、像发布会）。两者共用的假数据与工具在 `fixture.js`
 * （两个文件注入到同一个页面作用域里，顶层 const/function 互相看得见）。
 *
 * 每幕一个 `run()`（可以是 async）；`preview.mjs` 跑完一幕就拍一张 PNG。
 * 场景之间**有状态** —— 顺序有意义（框选那两幕就是「先拖出矩形、下一幕才落定」）。
 */
document.documentElement.dataset.checks = "shots";

const flush = () => new Promise((r) => queueMicrotask(() => queueMicrotask(r)));
const settle = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) await flush();
};
const click = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
};
const key = async (k, opts = {}) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
  await settle(30);
};

/** 点「真的」跳周按钮（与断言里那个同一套：先回本周再点 N 次，绝对定位） */
const gotoWeek = async (offset) => {
  click(".week-nav .now");
  await settle(20);
  const dir = offset < 0 ? 0 : 1;
  for (let i = 0; i < Math.abs(offset); i++) {
    document.querySelectorAll(".week-nav button")[dir]?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await settle(8);
  }
  await settle(30);
};

/** round61：种靶子块 → 翻去下一周再回来（强制一次真重拉，让新块进 store） */
const seed61 = async () => {
  window.__SEED_ROUND61?.();
  window.__FAKE_NOW = null;
  await gotoWeek(1);
  await gotoWeek(0);
};

const pe = (type, x, y, opts = {}) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId: 1,
    isPrimary: true,
    pointerType: "mouse",
    buttons: type === "pointerup" ? 0 : 1,
    ...opts,
  });
const rectOf = (id) => document.querySelector(`[data-block-id="${id}"]`)?.getBoundingClientRect() ?? null;
/** 把块滚进视野（窄窗口下也要看得见 —— 真项目交付截图靠它） */
const show = async (id) => {
  document.querySelector(`[data-block-id="${id}"]`)?.scrollIntoView({ block: "center", inline: "center" });
  await settle(6);
};
const clickBlock = async (id, opts = {}) => {
  const node = document.querySelector(`[data-block-id="${id}"]`);
  const r = node?.getBoundingClientRect();
  if (!node || !r) return false;
  node.dispatchEvent(pe("pointerdown", r.left + 20, r.top + r.height / 2, opts));
  node.dispatchEvent(pe("pointerup", r.left + 20, r.top + r.height / 2, opts));
  if (!opts.ctrlKey && !opts.shiftKey) node.focus({ preventScroll: true });
  await settle(10);
  return true;
};
const clearSel = async () => {
  await key("Escape");
  await key("Escape");
  const db = dayBody(0);
  db.dispatchEvent(pe("pointerdown", 0, 0));
  db.dispatchEvent(pe("pointerup", 0, 0));
  await settle(10);
};
const barBtn = (label) =>
  [...document.querySelectorAll(".bulk-bar button")].find((b) => b.textContent.trim() === label) ?? null;
const clickBar = async (label) => {
  const btn = barBtn(label);
  btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle(40);
  return !!btn;
};

/** 框选那两幕之间传递的坐标（先拖出矩形、下一幕才落定 —— 中间态要能被人眼看到） */
let marquee = null;

/* ------------------------------------------------------------------ *
 * round64.1（验收 #4 复核）：**教程演示**的场景表 —— `--first-run` 时只挂这一套。
 * 注入早于 bundle → 这里清空假库，界面从第一帧就是空库（首启卡片真的会出现）。
 * ------------------------------------------------------------------ */
const firstRun = window.__FIRST_RUN === true;
if (firstRun) {
  FIX.tasks.length = 0;
  FIX.blocks.length = 0;
  FIX.events.length = 0;
  FIX.sequences.length = 0;
  FIX.facts = {};
}
const todayIndex = (new Date().getDay() + 6) % 7;

const FIRST_RUN_SCENES = [
  {
    name: "空库首启-卡片",
    run: async () => {
      await settle(30);
    },
  },
  {
    name: "卡片特写",
    run: async () => {
      // 与第 1 幕同一个画面；演示页把这一张裁到左下角（卡片特写，不做假 UI）
      await settle(6);
    },
  },
  {
    name: "写下第一件事",
    run: async () => {
      const input = document.querySelector(".new-task .field");
      if (input) {
        input.value = "写周报";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await settle(10);
      document.querySelector(".new-task .add")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(50);
    },
  },
  {
    name: "拖到今天",
    run: async () => {
      if (dragStartTask()) {
        const p = dragToDay(todayIndex, 10, 0);
        await settle(10);
        dragRelease(p.x, p.y);
        await settle(60);
      }
    },
  },
  {
    name: "做完点勾",
    run: async () => {
      document
        .querySelector('[data-block-id] button[title="标记完成"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(70);
    },
  },
  {
    name: "知道了-卡片收起",
    run: async () => {
      document.querySelector(".first-run .ok")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(40);
    },
  },
  {
    name: "渐进提示条",
    run: async () => {
      window.__HINTS_ARMED = true;
      window.__HINTS_SEEN = [];
      dblclickAt(todayIndex, 11, 0); // 双击空白格 → 建临时块，引来「临时安排块」那条提示
      await settle(70);
    },
  },
  {
    name: "设置-引导与教程",
    run: async () => {
      document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(40);
    },
  },
  {
    name: "说明页",
    run: async () => {
      const btn = [...document.querySelectorAll(".sanity-pop .guide-actions .gf")].find((b) =>
        b.textContent.includes("打开说明页"),
      );
      btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(50);
      document.getElementById("help-hints")?.scrollIntoView({ block: "start" });
      await settle(20);
    },
  },
];

window.__SHOTS = firstRun
  ? FIRST_RUN_SCENES
  : [
  {
    name: "多选-入口",
    run: async () => {
      // Ctrl+左键加选两块 → 顶部冒出动作条（已选 2 块 + 全部动作）
      await seed61();
      await clearSel();
      await show("m2");
      await clickBlock("m2");
      await clickBlock("m3", { ctrlKey: true });
      await settle(10);
    },
  },
  {
    name: "框选-拖出矩形",
    run: async () => {
      // 空白处按住拖：半透明矩形跟着走（这一幕**故意不松手**，把中间态留给截图）
      await clearSel();
      await show("m5");
      const body = dayBody(3);
      const col = body.getBoundingClientRect();
      const r5 = rectOf("m5");
      const r6 = rectOf("m6");
      const x0 = col.left + 4;
      const y0 = col.top + 4;
      const x1 = Math.max(r5?.right ?? 0, r6?.right ?? 0) + 6;
      const y1 = Math.max(r5?.bottom ?? 0, r6?.bottom ?? 0) + 6;
      marquee = { x1, y1 };
      body.dispatchEvent(pe("pointerdown", x0, y0));
      await settle(6);
      window.dispatchEvent(pe("pointermove", (x0 + x1) / 2, (y0 + y1) / 2));
      window.dispatchEvent(pe("pointermove", x1, y1));
      await settle(10);
    },
  },
  {
    name: "框选-落定",
    run: async () => {
      // 松手：碰到的块全部选中（框选**替换**旧的选中）
      window.dispatchEvent(pe("pointerup", marquee?.x1 ?? 0, marquee?.y1 ?? 0));
      await settle(30);
    },
  },
  {
    name: "批量完成",
    run: async () => {
      // 动作条「✓ 完成」：整批标记 + 一条带数量的提示
      await clearSel();
      await show("m7");
      await clickBlock("m7");
      await clickBlock("m8", { ctrlKey: true });
      await clickBar("✓ 完成");
      await settle(20);
    },
  },
  {
    name: "批量删除-一步可撤销",
    run: async () => {
      // 「🗑 删除」：不弹确认，直接删 + 提示条带「撤销」（有撤销就不再加确认框）
      await clearSel();
      await show("m11");
      await clickBlock("m11");
      await clickBlock("m12", { ctrlKey: true });
      await clickBar("🗑 删除");
      await settle(20);
    },
  },
  {
    name: "一步撤销-两块都回来",
    run: async () => {
      // 按一次 Ctrl+Z：整批一起回来（一条命令 = 一步撤销）
      await key("z", { ctrlKey: true });
      await settle(30);
    },
  },
  {
    name: "批量挪天",
    run: async () => {
      // 「移一天 →」：每块各自 +1 天（批量位置变化只走键盘语义，不做拖动）
      await clearSel();
      await show("m13");
      await clickBlock("m13");
      await clickBlock("m14", { ctrlKey: true });
      await clickBar("移一天 →");
      await settle(20);
    },
  },
  {
    name: "批量改层",
    run: async () => {
      // 「必填」：整批切到必填层（左侧色条变绿）+ 一条提示
      await clearSel();
      await show("m16");
      await clickBlock("m16");
      await clickBlock("m17", { ctrlKey: true });
      await clickBar("必填");
      await settle(20);
    },
  },
  {
    name: "融合-自动收口",
    run: async () => {
      // 挪过去撞上同任务块 → 融合成一块；被吃掉的那块**不留幽灵选中**（6b 复核修的）
      await clearSel();
      await show("m19");
      await clickBlock("m19");
      await clickBlock("m20", { ctrlKey: true });
      await clickBar("移一天 →");
      await settle(20);
    },
  },
  {
    name: "Ctrl+A-全选本周",
    run: async () => {
      // Ctrl+A：整周全选（动作条的计数跟着走）；Esc 一次回单选、再一次清空
      await clearSel();
      await key("a", { ctrlKey: true });
      await settle(20);
    },
  },
];
