/**
 * round88：**公开仓配图**（README / 文档用）的演示截图场景表。
 *
 * 用法（仓库根跑；先 `npm run build`）：
 *   node tools/preview/preview.mjs --shots docs/images --shots-file scenes/docs-shots.js --width 1500
 *   node tools/preview/preview.mjs --shots <英文那套的输出目录> --shots-file scenes/docs-shots.js --width 1500 --locale en
 * （`docs/images` 是公开仓里放配图的目录；私有仓里我先把原图写到 `docs/公开仓/截图*`，再挑好的拷进 `docs/images`。）
 *
 * 与 `checks.js` 那套断言**分开**：断言的世界里块是「一断言一块」的靶子堆（几十块，很挤），
 * 这里要的是**给人看的一周**。所以本文件在**求值时**（早于应用的模块脚本）就把假库换成
 * 手工排好的那一周 —— 应用第一次 `list_tasks` / `list_blocks` 拿到的就是它，不需要换周重拉。
 * 数据仍然是假的（没有任何用户数据）。
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
const key = async (k) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  await settle(20);
};
/** 关掉所有浮层，露一个干净的主界面 */
const closeAll = async () => {
  for (let i = 0; i < 3; i++) await key("Escape");
  document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click());
  await settle(30);
  document.activeElement?.blur?.();
};
/** 有界轮询：等到时间轴上真的出现了这些块（避免截到「还在拉」的空屏） */
const waitBlocks = async (ids) => {
  for (let i = 0; i < 80; i++) {
    const have = ids.filter((id) => document.querySelector(`[data-block-id="${id}"]`)).length;
    if (have >= ids.length) return true;
    await settle(4);
  }
  return false;
};

// ---------------------------------------------------------------- 手工排的一周（只给截图用）

const DOC_TASKS = [
  ["dt1", "写周报", "工作", 60],
  ["dt2", "修 bug", "工作", 90],
  ["dt3", "读书", "学习", 60],
  ["dt4", "健身", null, 60],
  ["dt5", "复习英语", "学习", 30],
  ["dt6", "采购日用品", "生活", 30],
  ["dt7", "整理房间", "生活", 45],
];

/** 与 fixture 的 `T` / `B` 同形（字段一个不少 —— 少一个字段就可能渲染出不真实的样子） */
const docTask = (id, title, category, est, seq) => ({
  id,
  title,
  category: category ?? null,
  estimated_minutes: est ?? null,
  is_elastic: false,
  archived_at: null,
  created_at: nowSec,
  sanity_exempt: false,
  sort_order: seq,
});

const docBlock = (id, task_id, d, h, m, endD, endH, endM, layer, status, extra = {}) =>
  Object.assign(
    {
      id,
      task_id,
      start_at: at(d, h, m),
      end_at: at(endD, endH, endM),
      layer,
      status,
      last_notified_at: null,
      created_at: nowSec,
      external_source: null,
      final_status: null,
      postponed_from: null,
      label: null,
      is_temp: false,
      sanity_exempt: false,
      repeat_note: null,
    },
    extra,
  );

const docTempBlock = (id, d, h, m, endH, endM, label) =>
  Object.assign(docBlock(id, TEMP_TASK_ID, d, h, m, d, endH, endM, "elastic", "planned"), {
    label,
    is_temp: true,
  });

const DOC_BLOCKS = [
  // 周一
  docBlock("d-b1", "dt1", 0, 9, 0, 0, 10, 0, "required", "done"),
  docBlock("d-b2", "dt2", 0, 14, 0, 0, 15, 30, "elastic", "done"),
  // 周二
  docBlock("d-b3", "dt3", 1, 10, 0, 1, 11, 0, "elastic", "done"),
  docBlock("d-b4", "dt4", 1, 19, 0, 1, 20, 0, "required", "missed"),
  // 周三
  docBlock("d-b5", "dt2", 2, 9, 0, 2, 10, 30, "elastic", "planned"),
  docBlock("d-b6", "dt5", 2, 14, 0, 2, 14, 30, "elastic", "planned"),
  docTempBlock("d-b7", 2, 16, 30, 17, 0, "打电话给物业"),
  // 周四：两块连成一条序列（⛓）
  docBlock("d-b8", "dt1", 3, 9, 0, 3, 10, 0, "required", "planned"),
  docBlock("d-b9", "dt2", 3, 10, 0, 3, 11, 0, "required", "planned"),
  docBlock("d-b10", "dt7", 3, 15, 0, 3, 16, 30, "elastic", "planned"),
  // 周五
  docBlock("d-b11", "dt2", 4, 9, 30, 4, 11, 0, "elastic", "planned"),
  docBlock("d-b12", "dt4", 4, 20, 0, 4, 21, 0, "elastic", "planned"),
  // 周六 / 周日
  docBlock("d-b13", "dt6", 5, 10, 0, 5, 11, 0, "elastic", "planned"),
  docBlock("d-b14", "dt3", 6, 19, 0, 6, 20, 0, "elastic", "planned"),
];

const DOC_BLOCK_IDS = DOC_BLOCKS.map((b) => b.id);

// ---------------------------------------------------------------- 求值时就换库（早于应用的模块脚本）

FIX.tasks.length = 0;
DOC_TASKS.forEach(([id, title, cat, est], i) => FIX.tasks.push(docTask(id, title, cat, est, i)));
// 全局隐藏任务（临时安排块挂在它上面）也要在 list_tasks 里
FIX.tasks.push(
  Object.assign(docTask(TEMP_TASK_ID, "临时安排", null, null, 99), { archived_at: nowSec }),
);
FIX.blocks.length = 0;
DOC_BLOCKS.forEach((b) => FIX.blocks.push(b));
FIX.sequences.length = 0;
FIX.sequences.push({
  id: "d-s1",
  name: "上午例行",
  created_at: nowSec,
  members: [
    { block_id: "d-b8", order_index: 0 },
    { block_id: "d-b9", order_index: 1 },
  ],
});
FIX.events.length = 0;
FIX.repeats.length = 0;
FIX.repeatOcc = {};
window.__SEED_STATS?.(); // 统计面板要的 12 周流水（固定种子）

window.__SHOTS = [
  {
    name: "main",
    run: async () => {
      await closeAll();
      await waitBlocks(DOC_BLOCK_IDS);
      await settle(60);
    },
  },
  {
    name: "review",
    run: async () => {
      await closeAll();
      click(".review-open"); // 总览（统计是它里面的子层，这里不进去 —— 总览本身才是「这周怎么样」那张图）
      await settle(260);
    },
  },
  {
    name: "settings",
    run: async () => {
      await closeAll();
      click(".sanity-gear");
      await settle(140);
      document.querySelector("#settings-group-theme")?.scrollIntoView({ block: "start" });
      await settle(120);
    },
  },
];
