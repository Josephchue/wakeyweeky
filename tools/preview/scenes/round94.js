// round94（3.7 修复）· **验收截图场景**（手写；真前端 + 假数据）。
//
// 用法（仓库根跑；先 `npm run build`）：
//   node tools/preview/preview.mjs --shots docs/visual/round94 --shots-file scenes/round94.js
//
// 每幕走的是**产品的真路径**（双击空白建块 / 打开发置 / 点 ⚙ 属性），
// 只有「悬停态」这类**鼠标不在图上**的东西用 inline style 冻住（截图专用，不动产品代码）：
//   `.actions` 平时 `opacity:0; pointer-events:none`（要 hover / 键盘焦点才出）。
// ⚠ 第一幕（#13）需要 1500px 宽（窄窗里今天那列只露出半截，找不到完整空档）—— 窄窗跑时它会跳过并留一行 DIAG。
document.documentElement.dataset.checks = "shots";

const flush = () => new Promise((r) => queueMicrotask(() => queueMicrotask(r)));
const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) await flush();
};
const esc = async () => {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  await settle(20);
};
const closeAll = async () => {
  for (let i = 0; i < 3; i++) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(10);
  }
  document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click());
  await settle(20);
  document.activeElement?.blur?.();
};
/** 今天那一列里找一个空档（从 03:00 起试）并滚过去 */
async function emptySlot(startH = 3) {
  const todayIdx = (new Date().getDay() + 6) % 7; // 0 = 周一
  const scroll = document.querySelector(".scroll");
  for (let h = startH; h < 20; h++) {
    scroll.scrollTop = Math.max(0, yAt(h, 0) - 300);
    await settle(10);
    const p = atDay(todayIdx, h, 0);
    const top = scroll.getBoundingClientRect().top;
    if (p.y < top + 60 || p.y > scroll.getBoundingClientRect().bottom - 60) continue;
    const hit = document.elementFromPoint(p.x, p.y);
    if (!hit || hit.closest("[data-block-id]") || !hit.closest(".day-body")) continue;
    return { h, p, todayIdx };
  }
  return null;
}
/** 双击建一块并按 Esc 退出就地改名 → 返回那块元素 */
async function makeBlockAt(todayIdx, h) {
  dblclickAt(todayIdx, h, 0);
  await settle(40);
  const id = document.activeElement?.closest?.("[data-block-id]")?.getAttribute("data-block-id");
  await esc();
  return id ? document.querySelector(`[data-block-id="${id}"]`) : null;
}
/** 把动作浮层「冻」成 hover 态（截图专用） */
function freezeActions(blk, on = true) {
  const acts = blk?.querySelector(".actions");
  if (!acts) return null;
  acts.style.opacity = on ? "1" : "";
  acts.style.pointerEvents = on ? "auto" : "";
  return acts;
}

window.__SHOTS = [
  {
    // #13：现在线的 2px 不许把浮出的动作条切成两半（修前：线压在按钮上）
    name: "13-现在线不再压住动作浮层",
    run: async () => {
      await closeAll();
      const slot = await emptySlot();
      if (!slot) {
        window.__DIAG?.push?.("round94 截图 #13：窄窗找不到空档 → 本幕跳过（用 1500px 跑）");
        return;
      }
      const blk = await makeBlockAt(slot.todayIdx, slot.h);
      if (!blk) throw new Error("临时块没建出来");
      // 给个能读的名字（就地改名里键入 + Enter）
      const input = blk.querySelector("input.name-input");
      if (input) {
        input.value = "现在线靶子";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await settle(30);
      }
      freezeActions(blk, true);
      const line = document.querySelector(".now-line");
      const btn = [...(blk.querySelector(".actions")?.querySelectorAll("button") ?? [])].at(-1);
      if (line && btn) {
        const bodyTop = line.parentElement.getBoundingClientRect().top;
        const b = btn.getBoundingClientRect();
        line.style.top = Math.round(b.top + b.height / 2 - bodyTop) + "px";
      }
      blk.scrollIntoView({ block: "center" });
      await settle(60);
    },
  },
  {
    // #17：重复行的时间输入跟内容走（修前写死 76px，宽松档固有 77 → 内部编辑器被裁）
    name: "17-重复行的时刻输入不再被裁",
    run: async () => {
      await closeAll();
      const row = [...document.querySelectorAll(".item")].find((n) =>
        (n.querySelector(".label")?.textContent ?? "").startsWith("复制靶子"),
      );
      if (!row) throw new Error("找不到「复制靶子」任务行");
      row.querySelector(".props-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(40);
      const sec = row.querySelector(".prop.repeat");
      if (!sec) throw new Error("重复分组没出来");
      sec.scrollIntoView({ block: "center" });
      const time = sec.querySelector("input.repeat-time");
      if (time) {
        time.value = "08:15";
        time.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await settle(40);
      window.__DIAG?.push?.(
        `round94 截图 #17：输入宽 ${Math.round(time?.getBoundingClientRect().width ?? -1)}px`,
      );
    },
  },
  {
    // #8a：计划中块未悬停时也能看到 ✓（以前的浮层要 hover 才出）
    name: "08a-计划中块常显勾",
    run: async () => {
      await closeAll();
      const scroll = document.querySelector(".scroll");
      scroll.scrollTop = Math.max(0, yAt(9, 0) - 140);
      scroll.scrollLeft = 0;
      document.activeElement?.blur?.();
      await settle(60);
      const n = document.querySelectorAll(".quick-done").length;
      window.__DIAG?.push?.(`round94 截图 #8a：常显 ✓ ${n} 颗`);
    },
  },
  {
    // #8a：hover 态（截图里用 inline style 冻住）—— 浮层里 ✓ **在最右**，与常显那颗同一个矩形
    name: "08b-悬停浮层里勾在最右",
    run: async () => {
      await closeAll();
      const scroll = document.querySelector(".scroll");
      scroll.scrollTop = Math.max(0, yAt(9, 0) - 140);
      scroll.scrollLeft = 0;
      await settle(40);
      // 挑一块**计划中、不并排**的块（票子：周一 09:00 的 b1）
      const blk =
        document.querySelector('[data-block-id="b1"]') ??
        [...document.querySelectorAll("[data-block-id]")].find(
          (n) => n.classList.contains("planned") && !n.classList.contains("narrow"),
        );
      if (!blk) throw new Error("找不到计划中的非窄块");
      freezeActions(blk, true);
      const q = blk.querySelector(".quick-done");
      if (q) q.style.opacity = "0"; // 模拟 :hover 时的让位（否则图上会有两颗 ✓）
      blk.scrollIntoView({ block: "center" });
      await settle(60);
    },
  },
  {
    // #8b：临时块浮层里的 `✎`（改名唯一鼠标入口）；**名字上不再接单击**
    name: "08c-临时块浮层里的铅笔",
    run: async () => {
      await closeAll();
      // 要一块**不并排**的临时块（并排块浮层会换行，图上看不清「铅笔在第几位」）
      let blk = null;
      let slot = null;
      for (let h = 3; h < 19 && !blk; h++) {
        slot = await emptySlot(h);
        if (!slot) continue;
        const cand = await makeBlockAt(slot.todayIdx, slot.h);
        if (!cand) continue;
        if (cand.classList.contains("narrow")) {
          cand.querySelector('.actions button[title="删除块"]')?.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          );
          await settle(40);
          continue;
        }
        blk = cand;
      }
      if (!blk) {
        window.__DIAG?.push?.("round94 截图 #8c：找不到不并排的空档 → 本幕跳过（用 1500px 跑）");
        return;
      }
      const input = blk.querySelector("input.name-input");
      if (input) {
        input.value = "带铅笔的临时块";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await settle(30);
      }
      freezeActions(blk, true);
      const q = blk.querySelector(".quick-done");
      if (q) q.style.opacity = "0"; // 模拟 hover 时的让位
      blk.scrollIntoView({ block: "center" });
      await settle(60);
      window.__DIAG?.push?.(
        `round94 截图 #8c：铅笔=${!!blk.querySelector('.actions button.rename')} 浮层按钮=${[...blk.querySelectorAll('.actions button')].length}`,
      );
    },
  },
  {
    // #6：暗章点亮提示带「查看暗章」按钮（修前：只有一句话，没有出口）
    name: "06-暗章提示带查看暗章",
    run: async () => {
      await closeAll();
      window.__emitEvent("achievement-unlocked", [
        { id: "shot06", name: "对暗号的人", unlocked_at: Math.floor(Date.now() / 1000) },
      ]);
      await settle(40);
      const btn = document.querySelector(".toast .act");
      window.__DIAG?.push?.(`round94 截图 #6：按钮=[${(btn?.textContent ?? "").trim()}]`);
    },
  },
  {
    // #15：外部脚本改过库 → 2.5 秒内的自动重拉 + 右下角一条提示（真库副本 e2e 用另一种方式拍，见验收文档）
    name: "15-外部改库后自动重载提示",
    run: async () => {
      await closeAll();
      window.__DATA_VERSION = (window.__DATA_VERSION ?? 1) + 1;
      let found = null;
      for (let i = 0; i < 40 && !found; i++) {
        await new Promise((r) => setTimeout(r, 120));
        found = [...document.querySelectorAll(".toast")].find((n) =>
          (n.textContent ?? "").includes("外部改动"),
        );
      }
      window.__DIAG?.push?.(`round94 截图 #15：提示出现=${!!found}`);
      await settle(20);
    },
  },
  {
    // #15 手动：头部 week-nav 里的 ↻（局内键 R 同效）
    name: "15b-头部重新载入按钮",
    run: async () => {
      await closeAll();
      document.querySelector(".scroll").scrollTop = Math.max(0, yAt(9, 0) - 140);
      await settle(40);
      const btn = document.querySelector(".week-nav .reload");
      window.__DIAG?.push?.(`round94 截图 #15b：↻ 按钮=${!!btn}`);
    },
  },
];
