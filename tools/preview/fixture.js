const now = new Date();
const monday = new Date(now);
monday.setHours(0, 0, 0, 0);
monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
const at = (d, h, m) => Math.floor((monday.getTime() + (d * 1440 + h * 60 + m) * 60000) / 1000);
const nowSec = Math.floor(now.getTime() / 1000);

// round48：任务多了两个字段 —— `sanity_exempt`（任务级「不计入理智」）+ `sort_order`（手动顺序）。
// `sort_order` 按数组顺序递增：与真库 007 回填后的效果一致（列表顺序看起来没变）。
let taskSeq = 0;
const T = (id, title, est, category) => ({ id, title, category: category ?? null, estimated_minutes: est ?? null, is_elastic: false, archived_at: null, created_at: nowSec, sanity_exempt: false, sort_order: taskSeq++ });
/** C1.8（R33）：临时安排块挂在**全局隐藏任务**上（它不在 Backlog 里），名字写在自己的 label 上。
 *  round38：这个常量提到前面来 —— 隐藏任务现在也要放进的 `tasks` 表（真后端 `list_tasks` 会给它） */
const TEMP_TASK_ID = "ww-temp-hidden-task";
// round27 #5：t4 带预估 75 分钟 —— 拖出来的块该是 75 分钟（t1 没预估 → 默认 30 分钟）
// round28 #6：t2 带预估 50 分钟 —— 15 分钟步进下应**向上取整**成 60 分钟（以前四舍五入成 45）
// round38：给几条任务**带上分类**（以前清一色 `category: null`，分类下拉根本验不了）——
// 「学习」比「工作」多 → 正好能验「用得多的排前面」（而不是按名字排）
const tasks = [
  T("t1", "写周报", null, "工作"),
  T("t2", "修 bug", 50),
  T("t3", "读书", null, "学习"),
  T("t4", "健身", 75),
];
// round28 #2：一个**已归档**的任务 —— 它不该出现在 Backlog，但它的块必须还有名字（以前显示「?」）
tasks.push(Object.assign(T("t5", "归档过的老任务"), { archived_at: nowSec }));
// round38：那块**全局隐藏任务**也在 `list_tasks` 的返回里（round28 #2 起就是真后端的语义）——
// 「已归档」列表必须把它排掉；标题与 `db.rs` 的 `TEMP_TASK_TITLE` 保持一致
const hiddenTask = Object.assign(T(TEMP_TASK_ID, "临时安排"), { archived_at: nowSec });
tasks.push(hiddenTask);
tasks.push(T("t9", "键盘靶子", null, "学习"));
tasks.push(T("t10", "键盘靶子二", null, "学习")); // round32：另起一条任务，免得与 t9 靶子相接融合
tasks.push(T("t11", "键盘靶子三", null, "学习")); // round33：长跨度块
tasks.push(T("t12", "键盘靶子四")); // round33：鼠标拖动融合
tasks.push(T("t13", "键盘靶子五")); // round34：跨天缩到日界
tasks.push(T("t20", "理智靶子")); // round45：周日 10:00 那块专用（⊘ 不计入 → 那天占用变少）
tasks.push(T("t22", "复制靶子")); // round69（B3）：复制/搬移手势专用（一断言一块，不借别人的靶子；t21 已经被 round61 的种子用了）

const B = (id, task_id, start_at, end_at, layer, status) => ({
  id, task_id, start_at, end_at, layer, status,
  last_notified_at: null, created_at: nowSec, external_source: null,
  final_status: null, postponed_from: null, label: null, is_temp: false,
  // round45：不计入理智值（默认计入）—— 不给这个字段的话，断言里的 ⊘ 行为会假绿
  sanity_exempt: false,
  // round69（B3）：每周重复生成块的展示标（派生字段；普通块 null）
  repeat_note: null,
});
const BT = (id, start_at, end_at, label) =>
  Object.assign(B(id, TEMP_TASK_ID, start_at, end_at, "elastic", "planned"), {
    label: label,
    is_temp: true,
  });

const blocks = [
  B("b1", "t1", at(0, 9, 0), at(0, 9, 30), "suggested", "planned"),
  B("b2", "t2", at(0, 10, 0), at(0, 11, 30), "elastic", "planned"),   // 90 分钟 → 应占 3 格
  B("b3", "t3", at(0, 13, 0), at(0, 14, 0), "required", "planned"),
  B("b4", "t4", at(0, 13, 30), at(0, 14, 30), "suggested", "planned"), // 与 b3 重叠 → 应并排
  B("b5", "t1", at(1, 9, 0), at(1, 10, 0), "required", "done"),
  B("b6", "t2", at(1, 11, 0), at(1, 11, 30), "suggested", "missed"),   // 残影
  B("b7", "t3", at(2, 9, 0), at(2, 10, 0), "required", "planned"),     // 链 ①
  B("b8", "t4", at(3, 9, 0), at(3, 10, 0), "required", "planned"),     // 链 ②
  // C1.4 遗留值：004 迁移前的 suggested —— 应按照**弹性层**渲染（斜纹+虚线）且能拉伸
  B("b9", "t3", at(4, 14, 0), at(4, 15, 0), "suggested", "planned"),
  // C1.3：下一周也有块，用来验「跳周之后数据/序列线跟着换」
  B("b10", "t1", at(7, 9, 0), at(7, 10, 30), "required", "planned"),
  // 0.6.38：**只在两周后**才有的块 —— 专门验「换周时到底有没有人去拉那一周的块」
  // （假数据的 list_blocks 按窗口过滤，所以只有真的去拉了才会出现）
  B("b11", "t2", at(14, 9, 0), at(14, 10, 0), "required", "planned"),
  // round24：周六/周日各一块 —— 验跨天拉伸（周六那块能拉到次日凌晨）、刻度贴线、吸左吸顶
  B("b12", "t3", at(5, 20, 0), at(5, 22, 0), "elastic", "planned"),
  B("b13", "t4", at(6, 21, 0), at(6, 23, 0), "required", "planned"),
  // round25：专供「拖动/落点」那几条断言用的块（不碰别的块，免得前一条断言把后一条的预期改掉）
  B("b14", "t2", at(4, 16, 0), at(4, 17, 0), "elastic", "planned"),
  // round25⑤：起点在**上周日 23:00**、尾巴伸进本周一 05:00 —— 验「跨周块在下周要看得到」
  B("b15", "t3", at(-1, 23, 0), at(0, 5, 0), "elastic", "planned"),
  // round25 C1.8：两个临时安排块（名字写在自己的 label 上；隐藏任务不在 tasks 里）
  BT("b16", at(2, 16, 0), at(2, 17, 0), null), // 没命名 → 显示「临时安排」
  BT("b17", at(3, 16, 0), at(3, 17, 0), "写方案"), // 命名过 → 显示自己的名字
  // round26：四条新断言各自的靶子块（**一断言一块** —— 不借别人的块，免得前一条断言把后一条的预期改掉）
  B("b19", "t3", at(0, 18, 0), at(0, 19, 0), "elastic", "planned"), // 拉伸：周一 → 周四 = 正好 72 小时上限
  B("b20", "t4", at(4, 9, 0), at(4, 10, 0), "elastic", "planned"), // 拖动/手势自愈（周五 09:00）
  B("b21", "t1", at(5, 9, 0), at(5, 10, 0), "elastic", "planned"), // 漂流确认（周六 09:00）
  B("b22", "t2", at(2, 9, 0), at(2, 10, 0), "elastic", "planned"), // 拉伸二维：周三 → 周四（下一列）
  // round27：三条新断言的靶子块（同样一断言一块）
  // round57：b24 的时间改成**贴着同任务的 b22**（周三 09:00–10:00）——
  //   旧值在 22:00，而这个断言会把它拖到「动态找到的同任务块」上；那个块（b14）
  //   会被前面的断言挪到凌晨 00:15 → 落点在可视区外被钳到 00:00 → 什么也碰不到 → 提示弹不出来。
  //   两个块在同一个视野里，手柄才稳（这是修测试现场的脆弱，不是放宽要求）。
  Object.assign(B("b24", "t2", at(2, 9, 30), at(2, 10, 30), "elastic", "planned"), {
    // 「在漂流链上」的块 —— 拖到它旁边时后端会回报 merge_hint="drift"（假后端照真后端语义模拟）
    postponed_from: "b6",
  }),
  B("b25", "t1", at(0, 12, 0), at(0, 13, 0), "elastic", "planned"), // #6：拉伸时预览要伸进下一列
  B("b26", "t4", at(2, 10, 0), at(2, 11, 0), "elastic", "planned"), // #7：小牌（次日 / +2 天 / 前一日）
  B("b27", "t1", at(4, 14, 0), at(4, 15, 0), "elastic", "planned"), // #8：拖出最右边停住翻周
  // round28：已归档任务的一个块 —— 要能看到名字（而不是「?」）
  B("b29", "t5", at(1, 12, 0), at(1, 13, 0), "elastic", "planned"),
  // round28 #8：拉伸跨周的靶子 —— 周五下午起步，+72h 就能伸进下一周（stretchBlock 的上限仍 3 天）
  B("b30", "t3", at(4, 16, 0), at(4, 17, 0), "elastic", "planned"),
  // round29 #5/#6：跨周**拉伸**的靶子 —— 整段都在本周（周日 18:00–19:00），
  // 只有拉进下一周才会「旧范围整段还在本周」→ 正是用户 图1/图2 那个现场
  // （放周日而不是周五：拉完会变成一块横跨到下周一的**长块**，放周五会把整个周末铺满，
  //   后面「漂流建议时段」那类断言就没空档了）
  B("b31", "t1", at(6, 18, 0), at(6, 19, 0), "elastic", "planned"),
  // round29 #5 对照（拖动）：周四 18:00–19:00
  B("b32", "t2", at(3, 18, 0), at(3, 19, 0), "elastic", "planned"),
  // ===== round31（C1.9 键盘操作）：一断言一块（避免前一条的改动搅乱后一条的预期）=====
  // 都挂在新任务 t9 上；彼此隔开（同任务相接 = 融合 —— 那是抓起模式专门处理的事）
  B("b40", "t9", at(0, 8, 0), at(0, 9, 0), "elastic", "planned"), // 未抓起 ↑↓ 修边缘 + 抓起移动（默认视野内，能验「不乱滚」）
  B("b41", "t9", at(0, 14, 0), at(0, 15, 0), "elastic", "planned"), // → 跨天 / WASD
  B("b42", "t9", at(6, 20, 0), at(6, 20, 30), "elastic", "planned"), // 周日 → 下周一：视图翻周
  B("b43", "t9", at(0, 16, 0), at(0, 16, 30), "elastic", "planned"), // 抓起「路过」：与 b44 同任务、隔 30 分钟
  B("b44", "t9", at(0, 17, 0), at(0, 17, 30), "elastic", "planned"),
  B("b45", "t9", at(2, 1, 0), at(2, 2, 0), "elastic", "planned"), // Space 标记完成（周三凌晨：周六 03:00/04:00 被临时块断言占着）
  B("b46", "t9", at(2, 2, 30), at(2, 3, 30), "elastic", "planned"), // X 标记未完成
  B("b47", "t9", at(2, 4, 0), at(2, 5, 0), "elastic", "planned"), // Delete
  B("b48", "t9", at(6, 22, 0), at(6, 23, 0), "elastic", "planned"), // 拉下边缘跨到下一周（周日夜里）
  // round32：新一批靶子（一断言一块；挂在**新任务 t10** 上，且彼此隔开 —— 与 t9 同任务会在拉伸/移动时融合，
  // 把 round31 那批断言带崩；放在周三凌晨 / 周日夜里，避开既有块与既有断言的靶子）
  B("b50", "t10", at(2, 5, 0), at(2, 5, 30), "elastic", "planned"), // #3 拿起跨列预览：原列不许留原位那块
  B("b51", "t10", at(2, 6, 0), at(2, 6, 30), "elastic", "planned"), // #5 拿起中点击 🗑：先放弃拿起再删
  B("b53", "t10", at(2, 7, 0), at(2, 7, 30), "elastic", "planned"), // #4 焦点离开块取消选中 + #2 接链提示
  // round33 #2：长跨度块（跨 4 天）—— 放在**下一周** Tue 20:00 → Fri 12:00，
  // 避开所有「量几何」的既有断言（本轮验：把下边缘往上缩，不留原尾巴的幻影）
  B("b55", "t11", at(8, 20, 0), at(11, 12, 0), "elastic", "planned"),
  // round33 #1：同任务的两块（周一 15:00 / 16:00 各一块，空档）—— 拖后一块压到前一块上 → 融合后选中要转到幸存块
  B("b57", "t12", at(0, 15, 0), at(0, 15, 30), "elastic", "planned"),
  B("b56", "t12", at(0, 16, 0), at(0, 16, 30), "elastic", "planned"),
  // round34：跨天的块（**下周**一 20:00 → 下周二 00:45）—— 验「终点缩到次日 00:00 时相机在前一日 24:00」。
  // 放下一周是为了不打扰既有断言（跨天块合法地占两列；「同一任务没有重复渲染」那条是老断言，
  // 它的「id 全域唯一」假设只在本周没有跨天块时成立）
  B("b58", "t13", at(7, 20, 0), at(8, 0, 45), "elastic", "planned"),
  B("b52", "t10", at(6, 19, 30), at(6, 20, 0), "elastic", "planned"), // #1/#6 拿起跨周：Shift+→ 后还能挪、还能落地
  // round45：周日 10:00–11:00 一块**只有它**的块（别的断言都不碰这个时段）——
  // 专门用来验「⊘ 不计入 → 那天占用变少」
  B("b60", "t20", at(6, 10, 0), at(6, 11, 0), "elastic", "planned"),
  // round69（B3）：复制 / 搬移手势的靶子（周三 / 周四 12:00–12:30；这两个时段没有别的块）
  B("b70", "t22", at(2, 12, 0), at(2, 12, 30), "elastic", "planned"),
  B("b71", "t22", at(3, 12, 0), at(3, 12, 30), "elastic", "planned"),
];

const sequences = [
  {
    id: "s1",
    name: "验证链",
    created_at: nowSec,
    members: [
      { block_id: "b7", order_index: 0 },
      { block_id: "b8", order_index: 1 },
    ],
  },
];

const FIX = { tasks, blocks, sequences, facts: {}, events: [], repeats: [], repeatOcc: {} };
window.__DIAG = [];
// 页面级错误也记进 DIAG：断言外面的**渲染/更新**报错以前只能去 console 里捞（被它坑过一次）
window.addEventListener("error", (e) => {
  window.__DIAG.push("页面错误：" + (e.message ?? e.error ?? "?"));
});
window.addEventListener("unhandledrejection", (e) => {
  window.__DIAG.push("未处理的拒绝：" + (e.reason?.message ?? e.reason ?? "?"));
});

// ===== C7（round52）：复盘的自造数据集（见 `docs/plans/round52-c7-review-mosaic.md` §5.2）=====
// 为什么自造：用户 2026-10-02 评审「汇总统计项我没有足够的数据量，可能得自主完成全部测试了」。
// 为什么**延迟种**（第一条 round52 断言才调 `window.__SEED_ROUND52()`）：
//   前面那些断言对 Backlog 是**按数量写死**的（round40 ⑦ 要求分类列表正好 3 行）——
//   这 20 来个带分类的任务不能在页面加载时就进 `FIX.tasks`，否则平白弄红一票旧断言。
// 为什么放在**过去的周**（-7 ~ -1 周）+ **未来周**（+3 周）：不动本周（几十条旧断言盯着它）；
//   且「已过还是 planned」= `unused` 这个结局只在过去的周真出现，未来周只出 `planned`。

/** 数据集的任务：直接进 Backlog（种得晚，所以不影响旧断言） */
function R52T(id, title, category, archived = false) {
  const t = T(id, title, null, category);
  if (archived) t.archived_at = nowSec;
  FIX.tasks.push(t);
  return t;
}

/** 数据集的块：`status` + `final_status` + 层 + 临时块都能指定 */
function R52B(id, taskId, start, end, opts = {}) {
  const { status = "planned", final = null, layer = "elastic", isTemp = false, label = null } = opts;
  const b = isTemp ? BT(id, start, end, label) : B(id, taskId, start, end, layer, status);
  b.status = status;
  b.layer = layer;
  b.final_status = final;
  return b;
}

/** 种子伪随机（mulberry32）—— 随机数据集必须可复现（每次跑生成同一份） */
function r52Rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let r52Seeded = false;
/** 六组数据集（正常 / 密集 / 极端 / 空 / 单块 / 分类压力 / 随机 + 未来周）。幂等。 */
function seedRound52() {
  if (r52Seeded) return;
  r52Seeded = true;
  const put = (b, rearranged = 0, skipped = false) => {
    FIX.blocks.push(b);
    if (rearranged || skipped) FIX.facts[b.id] = { rearranged, skipped };
  };

  // —— 任务 ——
  const tSum = R52T("r52t-sum", "写季度总结", "写作");
  const tWord = R52T("r52t-word", "背单词", "阅读");
  const tBalcony = R52T("r52t-balcony", "收拾阳台", "家务");
  const tRun = R52T("r52t-run", "晨跑", null);
  const tOld = R52T("r52t-old", "归档的老项目", "会议", true); // 已归档 → 它的块照样进马赛克
  // 分类压力那一周：12 个分类（名字**不与**「工作 / 学习」重名，免得把旧断言的计数搅了）
  const tCat = ["出行", "会议", "家务", "健康", "阅读", "写作", "理财", "社交", "采购", "维修", "运动", "园艺"]
    .map((name, i) => R52T(`r52t-cat${i}`, `分类压力${i + 1}`, name));

  // ① 正常周（W-1 = 周一 -7 ~ 周日 -1）：五种**已过**结局各 ≥3、周二 7 小时（超载）、
  //    一条临时块、一块挂在**归档任务**上的、几条「挪过 / 没做完」事实
  put(R52B("r52n01", tSum.id, at(-7, 9, 0), at(-7, 10, 30), { status: "done" }));
  put(R52B("r52n02", tWord.id, at(-7, 11, 0), at(-7, 12, 0), { status: "done", final: "done_overtime" }));
  put(R52B("r52n03", tBalcony.id, at(-7, 14, 0), at(-7, 15, 0), { status: "done", final: "done_short" }));
  put(R52B("r52n04", tSum.id, at(-6, 9, 0), at(-6, 12, 0), { status: "done" }), 3);
  put(R52B("r52n05", tWord.id, at(-6, 13, 0), at(-6, 17, 0), { status: "done", final: "done_overtime" }));
  put(R52B("r52n06", tSum.id, at(-5, 10, 0), at(-5, 11, 0), { status: "missed" }), 0, true);
  put(R52B("r52n07", tBalcony.id, at(-5, 15, 0), at(-5, 16, 0), { layer: "required" }));
  put(R52B("r52n08", tRun.id, at(-4, 8, 0), at(-4, 9, 0)));
  put(R52B("r52n09", tWord.id, at(-4, 11, 0), at(-4, 12, 0), { status: "missed" }), 0, true);
  put(R52B("r52n10", tSum.id, at(-4, 16, 0), at(-4, 16, 30), { status: "done", final: "done_short" }), 1);
  put(R52B("r52n11", tBalcony.id, at(-3, 9, 0), at(-3, 10, 0), { status: "done" }));
  put(R52B("r52n12", tSum.id, at(-3, 14, 0), at(-3, 15, 0), { status: "missed" }), 2, true);
  put(R52B("r52n13", tWord.id, at(-3, 18, 0), at(-3, 19, 0), { layer: "required" }));
  put(R52B("r52n14", tBalcony.id, at(-2, 10, 0), at(-2, 11, 0), { status: "done", final: "done_overtime" }));
  put(R52B("r52n15", tSum.id, at(-2, 14, 0), at(-2, 15, 0), { layer: "required" }));
  put(R52B("r52n16", "", at(-2, 20, 0), at(-2, 21, 30), { isTemp: true, label: "修水管" }));
  put(R52B("r52n17", tWord.id, at(-1, 9, 0), at(-1, 10, 0), { status: "done", final: "done_short" }));
  put(R52B("r52n18", tRun.id, at(-1, 11, 0), at(-1, 12, 0), { status: "done" }));
  put(R52B("r52n19", tBalcony.id, at(-1, 15, 0), at(-1, 16, 0), { status: "missed" }));
  put(R52B("r52n20", tOld.id, at(-1, 19, 0), at(-1, 20, 0), { layer: "required" }));

  // ② 密集周（W-2）：七天连排、每天 15 块（每天头两块并排同一时段）→ 105 块
  const denseStates = [
    { status: "done" },
    { status: "done", final: "done_overtime" },
    { status: "missed" },
    { status: "planned" },
    { status: "done", final: "done_short" },
  ];
  const hours = [7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
  const denseTasks = [tSum, tWord, tBalcony, tRun];
  let denseSeq = 0;
  for (let d = -14; d <= -8; d++) {
    for (let k = 0; k < 15; k++) {
      const sameSlot = k < 2; // 头两块并排（同一天同一时段 → 并集只算一次）
      const opts = Object.assign({}, denseStates[denseSeq % denseStates.length], {
        layer: denseSeq % 4 === 0 ? "required" : "elastic",
      });
      put(
        R52B(
          `r52d${String(denseSeq).padStart(3, "0")}`,
          denseTasks[denseSeq % 4].id,
          at(d, sameSlot ? 9 : hours[k], 0),
          at(d, sameSlot ? 10 : hours[k], k % 3 === 0 ? 90 : 60),
          opts,
        ),
      );
      denseSeq += 1;
    }
  }

  // round55（交付前复核指出：事实只存在于 W-1 → 「▼」与「＝」两支根本没数据可验）：
  // 给**密集周（W-2）** 补几条事实，让三支都跑得到 ——
  //   W-1 视图：本周 2/3 vs 上周 3/4 → **▼1**；W-2 视图：本周 3/4 vs 上周 0 → ▲；W-4 视图：两边都 0 → ＝
  ["r52d000", "r52d001", "r52d002"].forEach((id) => {
    FIX.facts[id] = { rearranged: 3, skipped: false };
  });
  ["r52d003", "r52d004", "r52d005", "r52d006"].forEach((id) => {
    FIX.facts[id] = { rearranged: 0, skipped: true };
  });

  // ③ 极端块（W-3）：72 小时 / 15 分钟 / 跨天 / 跨周（周日 22:00 伸进下周一）
  put(R52B("r52x01", tSum.id, at(-21, 8, 0), at(-18, 8, 0), { layer: "required" }));
  put(R52B("r52x02", tWord.id, at(-20, 9, 0), at(-20, 9, 15), { status: "done" }));
  put(R52B("r52x03", tBalcony.id, at(-19, 23, 0), at(-18, 1, 0), { status: "missed" }));
  put(R52B("r52x04", tRun.id, at(-15, 22, 0), at(-14, 1, 0)));

  // ④ W-4（-28 ~ -22）**故意一块没有**（空周）；⑤ W-5 只有一块
  put(R52B("r52s01", tSum.id, at(-32, 10, 0), at(-32, 11, 0), { status: "done" }));

  // ⑥ 分类压力（W-6）：12 个分类各两块 + 两块没分类
  tCat.forEach((t, i) => {
    const d = -42 + (i % 7);
    put(
      R52B(`r52c${i}a`, t.id, at(d, 9 + (i % 5), 0), at(d, 10 + (i % 5), 0), {
        status: i % 3 === 0 ? "missed" : "done",
      }),
    );
    put(R52B(`r52c${i}b`, t.id, at(d, 14 + (i % 4), 0), at(d, 15 + (i % 4), 0)));
  });
  put(R52B("r52c00x", tRun.id, at(-37, 9, 0), at(-37, 10, 0), { status: "done" }));
  put(R52B("r52c01x", tRun.id, at(-36, 9, 0), at(-36, 10, 0)));

  // ⑦ 种子随机（W-7）：200 块（时间 / 时长 / 结局 / 层 / 任务都按固定种子掷）
  const rng = r52Rng(20261003);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  for (let i = 0; i < 200; i++) {
    const day = -49 + Math.floor(rng() * 7);
    const startMin = 6 * 60 + Math.floor(rng() * 20) * 30;
    const durMin = pick([15, 30, 45, 60, 90, 120]);
    const roll = rng();
    const opts =
      roll < 0.15
        ? { status: "missed" }
        : roll < 0.55
          ? { status: "done", final: pick([null, "done_overtime", "done_short"]) }
          : {};
    opts.layer = rng() < 0.3 ? "required" : "elastic";
    put(
      R52B(
        `r52r${String(i).padStart(3, "0")}`,
        pick(denseTasks).id,
        at(day, Math.floor(startMin / 60), startMin % 60),
        at(day, Math.floor((startMin + durMin) / 60), (startMin + durMin) % 60),
        opts,
      ),
    );
  }

  // ⑧ 未来周（W+3）：planned 两种层 + 一块 done（「还没到」的结局只在未来周出现）
  put(R52B("r52f01", tSum.id, at(21, 9, 0), at(21, 10, 0)));
  put(R52B("r52f02", tWord.id, at(22, 9, 0), at(22, 10, 0), { layer: "required" }));
  put(R52B("r52f03", tBalcony.id, at(23, 14, 0), at(23, 15, 30)));
  put(R52B("r52f04", tRun.id, at(24, 8, 0), at(24, 9, 0), { status: "done" }));

  // ⑨ round58（0.13.1）：W+8 只有**还没到**的块 —— 验完成率「分母 0 → —」
  //    （总览常驻行的那个分支要真跑得到，不然「不编 100%」就只是注释里的一句话）
  put(R52B("r57p01", tSum.id, at(56, 9, 0), at(56, 10, 0)));
  put(R52B("r57p02", tWord.id, at(57, 9, 0), at(57, 10, 0), { layer: "required" }));
}
window.__SEED_ROUND52 = seedRound52;

// ===== C1.7：手势辅助线的合成手势工具 =====
// 真前端 + 真事件（dragstart/dragover/dragend、pointerdown/move/up），只有「指针捕获」要被 shim
// —— 合成的 PointerEvent 没有"活跃指针"，setPointerCapture 会抛 NotFoundError（测试侧绕开，不改产品代码）。
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));
const dayBody = (i) => document.querySelectorAll(".day-body")[i];
const alignLines = () => [...document.querySelectorAll(".align-line")];
const alignLabels = () => [...document.querySelectorAll(".gutter .align-label")].map((el) => el.textContent.trim());
/** 一格（30 分钟）的高度（px）—— **从 CSS 读**，不写死：
 *  round76（3.1a）起它被密度驱动（紧凑 26 / 舒适 30 / 宽松 34），硬编码就与真界面漂移。
 *  读不到（真前端未渲染 / 测试早期）时回默认舒适档 30。 */
const slotH = () => {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--slot-height"));
  return Number.isFinite(v) && v > 0 ? v : 30;
};
/** 06:00 起算的时刻 → 列内像素（与前端同一套换算：一格 / 30 分钟；
 *  round24 起时间轴从**00:00** 起算） */
const yAt = (hour, minute) => ((hour * 60 + minute) / 30) * slotH();

/** round25：拖动改 pointer 手势 —— 与真鼠标同一条路径（事件发给「指针底下那个元素」） */
function firePointer(type, x, y) {
  const target = document.elementFromPoint(x, y) || window;
  target.dispatchEvent(ptrEvent(type, x, y));
}
/** 某一列某个时刻的屏幕坐标（取列中线） */
function atDay(dayIndex, hour, minute) {
  const r = dayBody(dayIndex).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + yAt(hour, minute) };
}
function dragStartBlock(id) {
  const src = document.querySelector('[data-block-id="' + id + '"]');
  if (!src) return false;
  const r = src.getBoundingClientRect();
  firePointer("pointerdown", r.left + 18, r.top + r.height / 2);
  return true;
}
function dragStartTask() {
  // round48：行左缘现在是**排序抓手**（`⠿`）→ 抓任务名那一带才还是「拖到时间轴建块」
  const label = document.querySelector(".item .label");
  if (!label) return false;
  const r = label.getBoundingClientRect();
  firePointer("pointerdown", r.left + 8, r.top + r.height / 2);
  return true;
}
function dragToPoint(x, y) {
  firePointer("pointermove", x, y);
}
function dragToDay(dayIndex, hour, minute) {
  const p = atDay(dayIndex, hour, minute);
  dragToPoint(p.x, p.y);
  return p;
}
function dragRelease(x, y) {
  firePointer("pointerup", x, y);
}
/** 松在板子外（Backlog 那一侧）：用不存在的列或负坐标都行 —— 这里用第一行任务的位置 */
function dragReleaseOutside() {
  const r = document.querySelector(".item .label").getBoundingClientRect();
  dragRelease(r.left + 8, r.top + 8);
}
/** C1.8：在某个格子双击（事件派发到指针底下那个元素，跟真鼠标一致） */
function dblclickAt(dayIndex, hour, minute) {
  const p = atDay(dayIndex, hour, minute);
  const target = document.elementFromPoint(p.x, p.y) || dayBody(dayIndex);
  target.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      clientX: p.x,
      clientY: p.y,
    }),
  );
}
/** 停在某个格子上的那个块（没有就 null） */
function blockAt(dayIndex, hour, minute) {
  const p = atDay(dayIndex, hour, minute);
  const hit = document.elementFromPoint(p.x, p.y);
  return hit?.closest("[data-block-id]") ?? null;
}
/** 块在某列里的纵向位置（相对列体顶部，px） */
function topInDay(id, dayIndex) {
  const b = document.querySelector('[data-block-id="' + id + '"]');
  const body = dayBody(dayIndex);
  if (!b || !body) return -1;
  if (!body.contains(b)) return -1;
  return b.getBoundingClientRect().top - body.getBoundingClientRect().top;
}
/** 等真实毫秒（帧推进 + performance.now 判时）—— 「停住一会儿」这类要真时间的断言用它 */
const waitMs = async (ms) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) await new Promise((r) => requestAnimationFrame(() => r()));
};

/** 默认视野：06:00（与产品一致） */
function setScrollHome() {
  document.querySelector(".scroll").scrollTop = 360;
}
/**
 * 把某个「列内 y」滚进视野。
 * 为什么要它：手势坐标一旦落在 .scroll 视口**之外**，自动滚动（round25③ 的产品行为）就会启动，
 * 把落点一路推下去 —— 那是真机上想要的手感，但会把「不想测自动滚动」的断言弄花。
 */
function focusBodyY(y) {
  const s = document.querySelector(".scroll");
  s.scrollTop = Math.max(0, y - 300);
}
/**
 * 断言要「精确落点」时先把视口放高到装得下一整天；这样指针永远不会落在视口边缘 40px 里，
 * 自动滚动（round25③ 的产品行为）就不会插手 —— 那些断言要测的是**落点换算**，不是滚动。
 * 用完必须 `restoreViewport()`（自动滚动本身的断言要用正常视口，否则没得滚）。
 */
function tallViewport() {
  const s = document.querySelector(".scroll");
  s.style.flex = "none";
  s.style.height = "1420px";
}
function restoreViewport() {
  const s = document.querySelector(".scroll");
  s.style.flex = "";
  s.style.height = "";
}
/**
 * round26 #9：把时间轴**收窄**（列排不下 → 出现横向溢出）—— 用来验「横向也能自动滚」。
 * 与 round25① 那条断言同一手法（都是改 `.timeline` 的宽度），只是抽成一对函数给两条断言共用。
 */
function narrowViewport() {
  const t = document.querySelector(".timeline");
  t.dataset.wwFlex = t.style.flex || "";
  t.dataset.wwWidth = t.style.width || "";
  t.style.flex = "none";
  t.style.width = "520px";
}
function restoreTimelineWidth() {
  const t = document.querySelector(".timeline");
  t.style.flex = t.dataset.wwFlex || "";
  t.style.width = t.dataset.wwWidth || "";
}

/**
 * round26 U 债：把「界面上的块」与「假库当前窗口内的块」逐条对齐，返回不一致的描述（空数组 = 一致）。
 *
 * **连状态一起比** —— 幻影行的典型症状就是「库里已经 missed / 被融合删掉，界面上还显示 planned」。
 * 窗口取自假后端最后一次 `list_blocks` 的参数（与真后端同一套区间相交语义）。
 */
/** round40：一级撤销快照（只给预览用）—— `delete_block` / `delete_task` 删之前拍，`undo` 时还原 */
let UNDO_SNAP = null;
let REDO_SNAP = null; // round64.1：镜像真后端的重做栈（一级就够预览验）
/**
 * round61（6b 复核）：新建块的假 id 用**单调计数器**。
 * 旧写法 `FIX.blocks.length + 1`：删过块之后再新建就会**撞上已存在的 id**（假后端自己带 bug ——
 * 重复 id 会让「重复块只渲染一块」这类真实行为失真）。真后端是 uuid，不可能撞。
 */
let fakeBlockSeq = 0;
const nextFakeBlockId = (prefix) => prefix + ++fakeBlockSeq;
/** round69：规则 id 也用单调计数器（删掉后重建不复用 id —— 与真后端 uuid 同形） */
let fakeRuleSeq = 0;
function takeUndoSnapshot() {
  // round47：`tasks` 要**逐条拷贝** —— 改名/合并是就地改 `t.category`，只 `slice()` 的话快照里
  // 存的还是同一批对象，“撤销”还原不出旧分类（假后端自己带 bug ✗ —— round45 那条教训）
  // round64.1：`blocks` 同理（移动/拉伸/标记都是就地改字段）—— 不逐条拷贝，撤销平移回不去
  // round69.1（6b P2-4）：`repeats` / `repeatOcc`（水位线）也是真后端快照的一部分 —— 带上。
  UNDO_SNAP = {
    blocks: FIX.blocks.map((b) => ({ ...b })),
    tasks: FIX.tasks.map((t) => ({ ...t })),
    repeats: FIX.repeats.map((r) => ({ ...r })),
    repeatOcc: { ...FIX.repeatOcc },
  };
  REDO_SNAP = null; // 新操作作废重做分支（与真后端 `push_undo` 一致）
}

/** 把一份快照回灌到假库里（undo / redo 共用；round69.1 / 6b P2-4 加了 repeats 与水位线） */
function restoreSnap(snap) {
  FIX.blocks.length = 0;
  FIX.blocks.push(...snap.blocks);
  FIX.tasks.length = 0;
  FIX.tasks.push(...snap.tasks);
  FIX.repeats.length = 0;
  FIX.repeats.push(...(snap.repeats ?? []));
  for (const k of Object.keys(FIX.repeatOcc)) delete FIX.repeatOcc[k];
  Object.assign(FIX.repeatOcc, snap.repeatOcc ?? {});
}
/** round64.1（验收 #3）：与 Rust `history::focus_between` 同口径 ——
 *  被增 / 删 / 改过的块 id + 视角落点（目标态优先，删除类退回当前态），前端拿去翻周 + 闪一下。 */
function fakeFocus(before, after) {
  const byId = (list) => new Map(list.map((b) => [b.id, JSON.stringify(b)]));
  const beforeM = byId(before);
  const afterM = byId(after);
  const ids = [];
  for (const [id, row] of afterM) if (beforeM.get(id) !== row) ids.push(id);
  for (const id of beforeM.keys()) if (!afterM.has(id)) ids.push(id);
  if (ids.length === 0) return null;
  const earliest = (m) =>
    Math.min(...ids.filter((id) => m.has(id)).map((id) => JSON.parse(m.get(id)).start_at));
  const start_at = Number.isFinite(earliest(afterM)) ? earliest(afterM) : earliest(beforeM);
  ids.sort();
  return { start_at, ids };
}

function dbViewMismatch() {
  const calls = window.__DBG || [];
  const win = calls.length ? calls[calls.length - 1] : [0, 0];
  const [from, to] = win;
  const inWin = (b) => (from == null || b.end_at > from) && (to == null || b.start_at < to);
  const bad = [];
  const dbIds = new Set();
  for (const b of FIX.blocks.filter(inWin)) {
    dbIds.add(b.id);
    const el = document.querySelector('[data-block-id="' + b.id + '"]');
    if (!el) {
      bad.push(b.id + "(库里 missed/planned=" + b.status + "，界面上没有)");
      continue;
    }
    const shown = el.classList.contains("done")
      ? "done"
      : el.classList.contains("missed")
        ? "missed"
        : "planned";
    if (shown !== b.status) bad.push(b.id + "(库=" + b.status + " 界面=" + shown + ")");
  }
  for (const el of document.querySelectorAll("[data-block-id]")) {
    const id = el.getAttribute("data-block-id");
    if (!dbIds.has(id) && !bad.some((s) => s.startsWith(id + "("))) {
      bad.push(id + "(界面上多出来的幻影行)");
    }
  }
  return bad;
}
/** 把某个块滚进视野（拖动前必须先能看到它，否则 pointerdown 落在别的东西上） */
function focusBlock(id) {
  const b = document.querySelector('[data-block-id="' + id + '"]');
  if (!b) return;
  const body = dayBody(0).getBoundingClientRect();
  focusBodyY(b.getBoundingClientRect().top - body.top);
}
/** 合成指针事件（拖动/拉伸/双击前的按下都靠它；pointerId 固定 1，与 pointerup 对得上） */
const ptrEvent = (type, clientX, clientY, opts = {}) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: clientX,
    clientY: clientY,
    pointerId: 1,
    isPrimary: true,
    pointerType: "mouse",
    buttons: type === "pointerup" ? 0 : 1,
    ...opts, // round61：Ctrl/Shift 修饰键（多选的 Ctrl+点 / Shift+区间）
  });

/** 两个块在时间上叠着/接着 */

/**
 * round30：真后端 `merge_hint` 的镜像 —— 「本该怎么合却没合」时给用户一句话。
 * 与真后端同一个顺序：能找到的、相接或重叠的同任务同层 planned 块里，第一条原因（漂流链/序列/超上限）。
 */
function mergeHintFor(b) {
  if (!b || b.status !== "planned" || b.task_id === TEMP_TASK_ID) return null;
  const inSeq = (id) => FIX.sequences.some((s) => s.members.some((m) => m.block_id === id));
  const driftish = (id) =>
    !!FIX.blocks.find((x) => x.id === id)?.postponed_from || FIX.blocks.some((x) => x.postponed_from === id);
  for (const x of FIX.blocks) {
    if (x.id === b.id || x.task_id !== b.task_id || x.layer !== b.layer) continue;
    if (x.status !== "planned") continue;
    if (x.start_at > b.end_at || x.end_at < b.start_at) continue; // 不挨着 → 谈不上「本该合」
    if (driftish(x.id) || driftish(b.id)) return "drift";
    if (inSeq(x.id) || inSeq(b.id)) return "sequence";
    const union = Math.max(b.end_at, x.end_at) - Math.min(b.start_at, x.start_at);
    if (union > 72 * 3600) return "cap";
    return null; // 能合却没合 → 不该发生
  }
  return null;
}

/**
 * round30：真后端 `db::merge_adjacent` 的简化镜像。
 *
 * 为什么必须补：假后端以前**不做融合** → 「后端合了、界面却还是两块」这类 bug 在这里
 * 永远复现不出来 ✗（用户真库的 `merge` 事件写着合了、库里只剩 1 块，界面却一直两块）。
 * 规则同真后端：同任务 + 同层 + 都 planned + 不是临时块 + 不在漂流链/序列里 + **相接或重叠**；
 * 并集超 3 天则跳过；保留**起点更早**的那个，吃掉另一个。返回幸存者（没合则 null）。
 * `preferExisting`（round69.1 / D1）：复制路径用 —— 以**已有块**为基石（平局归它），
 * 镜像真后端 `create_copy_block` 的「原块当幸存者」。
 */
function mergeNeighbour(b, preferExisting = false) {
  if (!b || b.status !== "planned" || b.task_id === TEMP_TASK_ID) return null;
  const inSeq = (id) => FIX.sequences.some((s) => s.members.some((m) => m.block_id === id));
  const isChild = (id) => !!FIX.blocks.find((x) => x.id === id)?.postponed_from;
  const hasChild = (id) => FIX.blocks.some((x) => x.postponed_from === id);
  const driftish = (id) => isChild(id) || hasChild(id);
  const other = FIX.blocks.find(
    (x) =>
      x.id !== b.id &&
      x.task_id === b.task_id &&
      x.layer === b.layer &&
      x.status === "planned" &&
      !driftish(x.id) &&
      !driftish(b.id) &&
      !inSeq(x.id) &&
      !inSeq(b.id) &&
      x.start_at <= b.end_at &&
      x.end_at >= b.start_at,
  );
  if (!other) return null;
  const start = Math.min(b.start_at, other.start_at);
  const end = Math.max(b.end_at, other.end_at);
  if (end - start > 72 * 3600) return null; // 并集超上限：跳过（真后端同）
  const keep = preferExisting
    ? other.start_at <= b.start_at
      ? other
      : b
    : b.start_at <= other.start_at
      ? b
      : other;
  const eaten = keep === b ? other : b;
  keep.start_at = start;
  keep.end_at = end;
  FIX.blocks.splice(FIX.blocks.indexOf(eaten), 1);
  return keep;
}

/**
 * round69.1（#4 / D2）：某条规则「还没开始」的生成块与它们的水位线一起撤下 ——
 * 镜像真后端 `repeats::drop_unstarted_generated`（暂停 / 删除规则时顺手做的）。
 * 已开始（`start_at <= now`）/ 已标记 / skipped 水位线一律不动。
 */
function dropUnstartedGenerated(repeatId) {
  const now = window.__FAKE_NOW ?? nowSec;
  for (const key of Object.keys(FIX.repeatOcc)) {
    if (!key.startsWith(repeatId + "_")) continue;
    const blockId = FIX.repeatOcc[key];
    const b = FIX.blocks.find((x) => x.id === blockId);
    if (!b || b.status !== "planned" || b.start_at <= now) continue;
    FIX.blocks.splice(FIX.blocks.indexOf(b), 1);
    delete FIX.repeatOcc[key];
  }
}

/**
 * C6（round44 建立）→ round45：理智值的假后端。
 *
 * **真算**：从假库的块现算每天的**并集**分钟（重叠/并排只算一次），跳过标了「不计入」的块 ——
 * 这样点 ⊘ / 改预算 这些交互能端到端跑通；算法本身另有 Rust 单测（这里只是把同一条口径
 * 用 JS 再实现一遍，供 UI 断言用 —— 不这么做就只能返回固定数字，那就是假绿温床）。
 */
/** round64（C10）：二期功能开关（默认全开）—— 与 Rust `features.rs` 同名（假后端要能读写它们） */
const FEATURE_KEYS = [
  "hints_enabled",
  "keyboard_enabled",
  "multi_select_enabled",
  "sequences_enabled",
  "drift_enabled",
  "remnants_enabled",
  "merge_enabled",
  "resize_enabled",
  "temp_block_enabled",
  "templates_enabled",
  "review_enabled",
  "stats_enabled",
  "tray_state_enabled",
  "current_hint_enabled",
  "hotkeys_enabled",
  "repeat_enabled",
];

const sanityState = {
  budget: 360,
  enabled: true,
  backlogWidth: 260,
  // round49：两个提醒开关（默认开；⚙ 弹层里能改）
  remindStart: true,
  remindEnd: true,
  // C7（round52）+ round57（0.13.0）：复盘到点（到点时：open / hint / off）+ 水位线
  reviewAction: "hint",
  reviewRemindAt: "sun 20:00",
  nudgedWeek: null,
  // round63（C18）：免打扰（R41）+ 开始提醒提前（R49）+ 计划任务
  // —— 默认值与真后端一致：静音关 / 明早 08:00 / 到点 / **计划任务默认关**
  quietUntil: 0,
  quietMorning: "08:00",
  remindLead: 0,
  scheduler: false,
  // round63（C18 / R48）：Backlog 视图记忆（存 JSON 字符串，与真后端同一形状）
  backlogFilter: '{"kind":"all"}',
  backlogGrouped: false,
  backlogCollapsed: "[]",
  // round67：外观 / 布局（面板形态 / 隐藏周末 / 键位提示栏；默认与真后端一致。round67.2：删「整栏隐藏」）
  backlogPane: "open",
  weekendHidden: false,
  hintBarMode: "always",
  // round76（3.1a）：外观五件（默认 = 舒适 / 跟随系统 / 暖砂 / 层条上色开 / 分类条关）——
  // 命令行旗标（`--density` / `--palette` / `--theme`）从这里预置，矩阵跑用；设置里改也写回这里
  uiDensity: window.__DENSITY ?? "comfortable",
  uiTheme: window.__THEME ?? "system",
  uiPalette: window.__PALETTE ?? "warm",
  layerBarColor: true,
  categoryBar: false,
  // round80（6b P2）：round77/78/80 的四键也要同形（icon_set / block_second_line / now_line / template_preview）——
  // 以前假后端不认识它们 → 开关在假库里是**静默 no-op**（前端 prefs 变了、落库没验），与 round68 记过的 P1 同类
  iconSet: "lucide",
  blockSecondLine: "time",
  // round87（3.3）：界面字体族（`--font` 旗标从这里预置；设置里改也写回这里）
  uiFont: window.__FONT ?? "default",
  nowLine: true,
  templatePreview: true,
  // round81（3.1c₁）：时间 / 日期格式（默认 system = 跟随系统）
  timeFormat: "system",
  dateFormat: "system",
  // round81（3.1c₁ · 宽-04）：时间刻度（`auto` = 跟密度；手动档 18–64）
  slotHeight: "auto",
  // round82（3.1c₂ · 淡-*）：夜间淡化三键（与真后端同形；渲染层读它们算淡化带）
  nightDim: true,
  nightStart: "22:00",
  nightEnd: "06:00",
  // round82（3.1c₂ · 绑-08）：用户键位覆盖（JSON；缺 = 全默认 —— 与真后端同形）
  keyBindings: "{}",
  // round81（3.1c₁ · 深-03）：界面语言**档位**（`system` = 跟随系统，默认）；
  // `--locale en` 那跑预置成 `en`（矩阵/英文断言靠它）
  uiLocale: window.__LOCALE === "en" ? "en" : "system",
  // round64（C10）：15 个功能开关（默认全开）+ round69 的第 16 个（每周重复）；模板建议存规范 JSON
  features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])),
  templateSuggest: '{"days":7,"done":5,"enabled":true}',
  // round66（C12）：便携模式 / 全局快捷键（假后端只服务界面断言；真逻辑在 Rust 单测里）
  dataPortable: false,
  dataFallback: false,
  dataNote: null,
  dataAdopted: false,
  dataChoice: null,
  hotkeyError: null,
};
// round79（78-01）：「恢复默认设置」要的**默认值快照** —— 建对象时（含 `--density/--palette/--theme`
// 那几个命令行旗标）抓一份，`reset_settings` 用它整份回写（比手抄一份默认表更不会漂）。
const SETTINGS_DEFAULTS = JSON.parse(JSON.stringify(sanityState));

// round63（6b）：把假库的设置状态暴露给断言 —— 「读回来」那条要**在背后改假库**再重读，
// 否则 `loadPrefs` 读失败时 prefs 还留着旧值，界面照样是筛选/分组态（假绿路径）。
window.__SANITY_STATE = sanityState;

// round64（C10）：模板的假库状态（`create/apply/delete` 都真落到这里，断言能量到）
const templateState = { list: [], nextId: 1 };
window.__TEMPLATES = templateState;
// round64：把假库本身也暴露出去 —— 断言要量「真写进去几块」（跨天块在 DOM 里会渲染成两段，不能数元素）
window.__FIX = FIX;
/** 测试可拨的假时钟（C7 提醒判到点靠它）；null = 用真时钟 */
window.__FAKE_NOW = null;

function localDayStart(sec) {
  const d = new Date(sec * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** 若干区间的并集长度（分钟）—— 与 Rust `sanity::union_seconds` 同一套语义 */
function unionMinutes(spans) {
  if (!spans.length) return 0;
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = sorted[0];
  for (const [s, e] of sorted.slice(1)) {
    if (s > ce) {
      total += ce - cs;
      cs = s;
      ce = e;
    } else if (e > ce) {
      ce = e;
    }
  }
  total += ce - cs;
  return Math.round(total / 60);
}

/** round64.1（验收 #1）：**当前可见的块** —— 漂流开关关掉时，漂流子块（`postponed_from` 非空）
 *  视为不在场（与 Rust `db::drift_filter` / `list_blocks` 同口径；假后端必须镜像真规则）。
 *  注意：内部数据一行不删，只在「要给界面/曲线的视图」上过滤。 */
function visibleBlocks() {
  return sanityState.features.drift_enabled === false
    ? FIX.blocks.filter((b) => !b.postponed_from)
    : FIX.blocks;
}

function sanityWeek(weekStart) {
  const budget = sanityState.budget;
  const days = [];
  /** round48：标了「不计入理智」的任务 id（一条任务 → 它的所有块都不算） */
  const exemptTasks = new Set(
    FIX.tasks.filter((t) => t.sanity_exempt && t.id !== "ww-temp-hidden-task").map((t) => t.id),
  );
  // 注意：日期窗口必须跟着**请求的那一周**走（以前写死 at(i,0,0) = 本周 →
  // 翻到别的周时会拿着本周的块算，被 round45 ⑤ 那条断言抓了个正着）
  const ws = localDayStart(weekStart);
  for (let i = 0; i < 7; i++) {
    const ds = localDayStart(ws + i * 86400);
    const de = localDayStart(ws + (i + 1) * 86400);
    // round48：不计入看的是**任务的**标记（块级那列已经退休）
    const inDay = visibleBlocks().filter(
      (b) =>
        !exemptTasks.has(b.task_id) &&
        !(b.is_temp && b.sanity_exempt) && // round49：临时块看它自己的块级标记
        b.start_at < de &&
        b.end_at > ds,
    );
    const minutes = unionMinutes(
      inDay.map((b) => [Math.max(b.start_at, ds), Math.min(b.end_at, de)]),
    );
    const pct = budget > 0 ? Math.round((minutes / budget) * 100) : 0;
    days.push({
      day_start: ds,
      minutes,
      budget,
      energy_pct: pct,
      state: pct >= 100 ? "over" : pct >= 80 ? "near" : "calm",
      blocks: inDay.length,
      // C7（round52）：事实改成**从假事实表现算**（与真后端同一口径：挪过 ≥2 才算一块、跳过算一块）
      rearranged: inDay.filter((b) => (FIX.facts[b.id]?.rearranged ?? 0) >= 2).length,
      skipped: inDay.filter((b) => FIX.facts[b.id]?.skipped).length,
    });
  }
  const worst = days.some((d) => d.state === "over")
    ? "over"
    : days.some((d) => d.state === "near")
      ? "near"
      : "calm";
  const isCurrent = weekStart === at(0, 0, 0);
  return {
    week_start: weekStart,
    week_end: weekStart + 7 * 86400,
    today_index: isCurrent ? (new Date().getDay() + 6) % 7 : -1,
    worst_state: worst,
    budget,
    enabled: sanityState.enabled,
    days,
  };
}

/** C7（round52）：一块的**结局**（与 Rust `review.rs` 同一口径 —— 假后端必须做真规则，不能省） */
function mosaicStateOf(b) {
  if (b.status === "done") {
    if (b.final_status === "done_overtime") return "done_overtime";
    if (b.final_status === "done_short") return "done_short";
    return "done";
  }
  if (b.status === "missed") return "missed";
  return b.end_at <= nowSec ? "unused" : "planned";
}

/**
 * C7（round52）：某一周的方块（`get_week_mosaic` 的假实现）。
 * 语义与真后端对齐：**区间相交**（上周伸进来的也算）、`day_start` = 本周第一段那天、
 * 豁免判定（任务级 + 临时块自己的，隐藏任务不算）、事实从 `FIX.facts` 读。
 * `bphantom` 是预览专用的「凭空多出来的下周块」（C1.6 复现用）—— 真库里没有它，复盘要排掉。
 */
function mosaicWeek(weekStart) {
  const ws = localDayStart(weekStart);
  const we = localDayStart(ws + 7 * 86400);
  const exemptTasks = new Set(
    FIX.tasks.filter((t) => t.sanity_exempt && t.id !== "ww-temp-hidden-task").map((t) => t.id),
  );
  const taskById = new Map(FIX.tasks.map((t) => [t.id, t]));
  return visibleBlocks()
    .filter((b) => b.id !== "bphantom" && b.start_at < we && b.end_at > ws)
    .sort((a, b) => a.start_at - b.start_at || String(a.id).localeCompare(String(b.id)))
    .map((b) => {
      const task = taskById.get(b.task_id);
      const facts = FIX.facts[b.id] ?? { rearranged: 0, skipped: false };
      return {
        id: b.id,
        task_id: b.task_id,
        title: task?.title ?? "?",
        label: b.label ?? null,
        category: task?.category ?? null,
        is_temp: !!b.is_temp,
        start_at: b.start_at,
        end_at: b.end_at,
        layer: b.layer,
        mosaic_state: mosaicStateOf(b),
        day_start: localDayStart(Math.max(b.start_at, ws)),
        exempt: exemptTasks.has(b.task_id) || (!!b.is_temp && !!b.sanity_exempt),
        rearranged: facts.rearranged ?? 0,
        skipped: !!facts.skipped,
      };
    });
}

/** C7（round52）+ round57（0.13.0）：周报到点的假实现（与 Rust `review::nudge_week` 同一口径）。
 *  `action` = open / hint / off（off 不提）；返回要复盘的那一周（本地周一零点）；不到点 / 已提过 → null。 */
function fakeNudgeWeek(now, action, atText, nudged) {
  if (action === "off") return null;
  const m = /^(sun|mon) (\d{1,2}):(\d{2})$/.exec(String(atText).trim().toLowerCase());
  const day = !m || m[1] === "sun" ? 6 : 0; // 非法值回退默认（周日）
  const hour = m ? Number(m[2]) : 20;
  const minute = m ? Number(m[3]) : 0;
  const weekStartOfDay = (t) => localDayStart(t - ((new Date(t * 1000).getDay() + 6) % 7) * 86400);
  const today = localDayStart(now);
  for (let back = 0; back <= 7; back++) {
    const d = localDayStart(today - back * 86400);
    if ((new Date(d * 1000).getDay() + 6) % 7 !== day) continue;
    const moment = d + hour * 3600 + minute * 60;
    if (moment > now) continue;
    if (now - moment >= 24 * 3600) return null; // 出了 24 小时窗口
    const target = day === 6 ? weekStartOfDay(d) : weekStartOfDay(d) - 7 * 86400;
    return nudged === target ? null : target;
  }
  return null;
}

// ===== 10.1（round60）：统计页的自造事件集 =====
// 为什么**延迟种**：`FIX.events` 只有 `get_stats` 读它，但如果在页面加载时就把事件摆好，
//   「打开面板 → 标一块 → 重开 +1」这类差分会被前面几百条断言的手势搅得不可预测。
//   所以：第一条 round60 断言打开面板时才种下**固定的 35 条**（跨本周 / 上周 / 上上周）。
// 假后端**真实现**：`get_stats` 不是写死答案，而是照 Rust `stats.rs` 的口径把这些事件算一遍
//   （拖动/拉伸分类、顺延剔除、周桶、完成率四舍五入都各有一份 —— 少做规则 = 假绿温床）。
let statsSeeded = false;

/** round79（78-10）：「重置统计」的时间界（**非破坏** —— 只写这个数，一条事件不删）；
 *  与真后端 `stats::reset_at` 同口径：`0` = 全史（旧行为）。 */
let statsResetAt = 0;

/** 近 12 周的周一起点（本地；与 Rust `sanity::week_start_of` 同一口径） */
function statsWeekStart(sec) {
  const day = localDayStart(sec);
  return localDayStart(day - ((new Date(day * 1000).getDay() + 6) % 7) * 86400);
}

function pushStatsEvent(event_type, block_id, created_at, payload = null) {
  FIX.events.push({ event_type, block_id, payload, created_at });
}

/**
 * 固定的 35 条种子（本周 17 / 上周 11 / 上上周 7）。
 * 数字与 `checks.js` 的 round60 断言一一对应 —— **改这里必须改那里**：
 *   完成 5（4 条带 minutes：20/30/45/60 → 155 分）· 未完成 3 · 完成率 5/8 · 63%
 *   新建 6（临时 2）· 拖动 4 · 拉伸 3 · 漂移 3 · 顺延 3 · 删除 3 块 · 融合 2 · 接进 2 · 取出 1
 *   事件总数 35（含 1 条未知类型）· 用过的天数 10 · 近 12 周表 3 行
 * round82（统-04/07）：完成账还带 delay_minutes + category —— `round82 ⑩` 断言（固定
 *   `__FAKE_NOW` = 本周四 12:00）盯着：按时率 3/4 · 75% · 平均 39 分 · 当前/最长连续 3 天 ·
 *   分类：工作 2 条 65 分 / 学习 1 条 30 分 / 早期数据（无分类）2 条 60 分。
 */
function seedStats() {
  if (statsSeeded) return;
  statsSeeded = true;
  const put = pushStatsEvent;
  // —— 本周（周一 / 周二 / 周三各若干）——
  put("create", "s-c1", at(0, 9, 0), '{"temp":false}');
  put("create", "s-c2", at(0, 9, 30), '{"temp":true}');
  put("create", "s-c3", at(1, 9, 0), '{"temp":false}');
  put("move", "s-c1", at(0, 10, 0), '{"from":100,"to":200,"end_from":300,"end_to":400}');
  put("move", "s-c1", at(0, 10, 5), '{"from":200,"to":250,"end_from":400,"end_to":450}');
  put("move", "s-c2", at(1, 10, 0), '{"from":100,"to":100,"end_from":300,"end_to":500}');
  put("move", "s-c3", at(2, 10, 0), '{"from":1,"to":2,"cascade":true}');
  put("postpone", "s-c4", at(1, 11, 0), '{"from":1,"to":2}');
  put("link", "s-c5", at(2, 11, 0), '{"after":"s-c4","moved_self":false}');
  put("complete", "s-done1", at(0, 12, 0), '{"minutes":20,"delay_minutes":10,"category":"工作"}');
  put("complete", "s-done2", at(1, 12, 0), '{"minutes":30,"delay_minutes":50,"category":"学习"}');
  put("complete", "s-done3", at(2, 12, 0), '{"minutes":45,"delay_minutes":45,"category":"工作"}');
  put("skip", "s-skip1", at(2, 13, 0), null);
  put("merge", "s-m1", at(1, 13, 0), '{"eaten":"s-eaten","start":1,"end":2}');
  put("delete", "s-del1", at(2, 14, 0), '{"count":1}');
  put("unlink", "s-u1", at(2, 14, 30), null);
  put("overtime", "s-x1", at(0, 14, 0), null); // 未知类型 → 只进总数
  // —— 上周 ——
  put("create", "s-c4", at(-7, 9, 0), '{"temp":false}');
  put("create", "s-c5", at(-7, 9, 30), '{"temp":true}');
  put("move", "s-c4", at(-7, 10, 0), '{"from":100,"to":200,"end_from":300,"end_to":400}');
  put("move", "s-c5", at(-6, 10, 0), '{"from":100,"to":100,"end_from":300,"end_to":500}');
  put("postpone", "s-c6", at(-6, 11, 0), '{"from":1,"to":2}');
  put("postpone", "s-c7", at(-6, 11, 30), '{"from":1,"to":2,"cascade":true}');
  put("link", "s-c6", at(-5, 11, 0), '{"after":"s-c4","moved_self":false}');
  put("complete", "stats-gone", at(-5, 12, 0), null); // 块已删且无 minutes → 不计时长
  put("skip", "s-skip2", at(-5, 13, 0), null);
  put("merge", "s-m2", at(-4, 13, 0), '{"eaten":"s-eaten2","start":1,"end":2}');
  put("delete", "s-del2", at(-4, 14, 0), '{"count":2}');
  // —— 上上周 ——
  put("create", "s-c8", at(-14, 9, 0), '{"temp":false}');
  put("move", "s-c8", at(-14, 10, 0), '{"from":100,"to":200,"end_from":300,"end_to":400}');
  put("move", "s-c9", at(-13, 10, 0), '{"from":100,"to":100,"end_from":300,"end_to":500}');
  put("postpone", "s-c9", at(-13, 11, 0), '{"from":1,"to":2}');
  put("link", "s-c9", at(-12, 11, 0), '{"from":1,"to":2,"cascade":true}');
  put("complete", "s-done4", at(-12, 12, 0), '{"minutes":60,"delay_minutes":0}');
  put("skip", "s-skip3", at(-12, 13, 0), null);
}
window.__SEED_STATS = seedStats;

// ===== round61（10.2 多选与批量操作）：延迟种的靶子块 =====
// 为什么延迟种：本周块数 / Backlog 行数被一堆旧断言写死盯着 —— 加载时就进库会平白弄红（同 round52/60）。
// 一个任务（t21）、块之间互不重叠，**批量挪天/挪周后也不撞**（不触融合，断言才稳）。
let r61Seeded = false;
function seedRound61() {
  if (r61Seeded) return;
  r61Seeded = true;
  FIX.tasks.push(T("t21", "多选靶子"));
  const put = (id, start, end, status = "planned") => {
    FIX.blocks.push(B(id, "t21", start, end, "elastic", status));
  };
  // 选择模型 / 动作条（周一 9–11 点）；m4 = Esc 分层（周三）
  put("m1", at(0, 9, 0), at(0, 9, 30));
  put("m2", at(0, 10, 0), at(0, 10, 30));
  put("m3", at(0, 11, 0), at(0, 11, 30));
  put("m4", at(2, 9, 0), at(2, 9, 30));
  // 框选（周四凌晨 —— 断言里把视野滚到顶才框得到）
  put("m5", at(3, 4, 0), at(3, 4, 30));
  put("m6", at(3, 4, 45), at(3, 5, 15));
  // 批量标记（周二 9–12 点）
  put("m7", at(1, 9, 0), at(1, 9, 30));
  put("m8", at(1, 10, 0), at(1, 10, 30));
  put("m9", at(1, 11, 0), at(1, 11, 30));
  put("m10", at(1, 12, 0), at(1, 12, 30));
  // 批量删除 + 一步撤销（周三 10–11 点）
  put("m11", at(2, 10, 0), at(2, 10, 30));
  put("m12", at(2, 11, 0), at(2, 11, 30));
  // 批量挪天（周一 14–15 点 → 周二同一时刻，与上面任何一块都不接）
  put("m13", at(0, 14, 0), at(0, 14, 30));
  put("m14", at(0, 15, 0), at(0, 15, 30));
  // 批量改层（周四 10–11 点）
  put("m16", at(3, 10, 0), at(3, 10, 30));
  put("m17", at(3, 11, 0), at(3, 11, 30));
  // 批量**融合**靶子（6b 复核：融合路径与幽灵 id 收口原先没人测）——
  // ⑩ 挪动：m19 挪 +1 天后与 m18 相接，m18 起点更早 → m18 留下、m19 被吃（选中要收口）
  put("m18", at(3, 13, 45), at(3, 14, 15));
  put("m19", at(2, 14, 0), at(2, 14, 30));
  put("m20", at(2, 15, 0), at(2, 15, 30));
  // ⑪ 改层：m21 已是必填，m22 改成必填后与它相接 → m21 留下、m22 被吃
  FIX.blocks.push(B("m21", "t21", at(3, 16, 0), at(3, 16, 30), "required", "planned"));
  put("m22", at(3, 16, 30), at(3, 17, 0));
  // ===== round61.1（验收回修）：混合选中 / ↑↓ 挪时间 / 交叠带 / 拖动整组 的靶子 =====
  put("m23", at(4, 9, 0), at(4, 9, 30)); // 周五 9:00（计划中）
  put("m24", at(4, 10, 0), at(4, 10, 30), "done"); // 周五 10:00（已标记，不参与移动）
  put("m25", at(5, 9, 0), at(5, 9, 30)); // ↑↓ 挪时间
  put("m26", at(5, 10, 0), at(5, 10, 30));
  // Shift 交叠带：锚点长块 19:15–22:00；m28 更早但与它交叠；m29 目标；m30 完全在带外
  put("m27", at(6, 19, 15), at(6, 22, 0));
  put("m28", at(6, 19, 0), at(6, 20, 30));
  put("m29", at(6, 21, 0), at(6, 21, 30));
  put("m30", at(6, 17, 0), at(6, 18, 0));
  // 拖动整组
  put("m31", at(5, 12, 0), at(5, 12, 30));
  put("m32", at(5, 13, 0), at(5, 13, 30));
  // ⑰ 拿起中按把手/按钮 = 先放弃拿起（独立靶子，不借上一段的块）
  put("m33", at(5, 22, 0), at(5, 22, 30));
  put("m34", at(5, 23, 0), at(5, 23, 30));
  // round61.2 ⑱：跨天靶子（组包络 B2）—— 周四 23:30 → 周五 00:30；与 m16 同任务、隔得远（不融合）
  put("m35", at(3, 23, 30), at(4, 0, 30));
}
window.__SEED_ROUND61 = seedRound61;

/** 空库态：`get_stats` 一次性返回全 0（断言用完即失效，与 `__FAIL_SET_SETTING_ONCE` 同一手法） */
function emptyStats() {
  return {
    first_event_at: null,
    active_days: 0,
    total_events: 0,
    complete: 0,
    skip: 0,
    rate_pct: null,
    created: 0,
    created_temp: 0,
    moved: 0,
    stretched: 0,
    postponed: 0,
    cascaded: 0,
    deleted: 0,
    merged: 0,
    linked: 0,
    unlinked: 0,
    done_minutes: 0,
    done_timed: 0,
    trend: (() => {
      // 与 Rust 同形：空库也摆 14 个 0（面板不因分支而变长）
      const rows = [];
      const today = localDayStart(window.__FAKE_NOW ?? nowSec);
      let cursor = localDayStart(today - 13 * 86400);
      for (let i = 0; i < 14; i++) {
        rows.push({ day: cursor, done: 0 });
        cursor = localDayStart(cursor + 86400);
      }
      return rows;
    })(),
    on_time: 0,
    rated: 0,
    on_time_pct: null,
    avg_minutes: null,
    streak_now: 0,
    streak_best: 0,
    categories: [],
    weeks: [],
  };
}

/** 统计口径（照 Rust `stats.rs`；两边数字对不上就是这俩之一错了） */
function statsSummary() {
  const dayOf = (t) => localDayStart(t);
  const weekOf = (t) => statsWeekStart(t);
  const days = new Set();
  const weekHas = new Set();
  const weekBucket = new Map();
  // round82（统-03/06）：每日完成账本（趋势 + 连续天数共用）
  const dayDone = new Map();
  let total = 0;
  let complete = 0;
  let skip = 0;
  let created = 0;
  let merged = 0;
  let first = null;
  for (const ev of FIX.events) {
    // round79（78-10）：「重置统计」的时间界 —— 线之前的事件一条都不数（但仍留在库里）
    if (ev.created_at < statsResetAt) continue;
    total += 1;
    first = first === null ? ev.created_at : Math.min(first, ev.created_at);
    days.add(dayOf(ev.created_at));
    const wk = weekOf(ev.created_at);
    weekHas.add(wk);
    if (!weekBucket.has(wk)) weekBucket.set(wk, [0, 0, 0]);
    const bucket = weekBucket.get(wk);
    if (ev.event_type === "complete") {
      complete += 1;
      bucket[0] += 1;
      const day = dayOf(ev.created_at);
      dayDone.set(day, (dayDone.get(day) ?? 0) + 1);
    }
    if (ev.event_type === "skip") {
      skip += 1;
      bucket[1] += 1;
    }
    if (ev.event_type === "create") created += 1;
    if (ev.event_type === "merge") merged += 1;
  }
  const livingDone = new Map();
  for (const b of FIX.blocks) {
    if (b.status === "done") livingDone.set(b.id, Math.floor((b.end_at - b.start_at) / 60));
  }
  const json = (s) => {
    try {
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  };
  let createdTemp = 0;
  let moved = 0;
  let stretched = 0;
  let postponed = 0;
  let cascaded = 0;
  let deleted = 0;
  let linked = 0;
  let unlinked = 0;
  let doneMinutes = 0;
  let doneTimed = 0;
  // round82（统-04/07）：按时率分母 / 分子 + 分类分布账本
  let onTime = 0;
  let rated = 0;
  const catMap = new Map();
  for (const ev of FIX.events) {
    // round79（78-10）：与上面那一趟**同一道闸** —— 线之前的整条跳过
    // （否则 `weekBucket.get(...)` 是 undefined，一碰 `bucket[2]` 就 TypeError —— 实测被断言抳到）
    if (ev.created_at < statsResetAt) continue;
    const p = json(ev.payload);
    const bucket = weekBucket.get(weekOf(ev.created_at));
    if (ev.event_type === "create" && p && p.temp === true) createdTemp += 1;
    else if (ev.event_type === "move") {
      if (p && p.cascade === true) cascaded += 1;
      else if (p && p.from === p.to && p.end_from !== p.end_to) stretched += 1;
      else moved += 1;
    } else if (ev.event_type === "postpone") {
      if (p && p.cascade === true) cascaded += 1;
      else {
        postponed += 1;
        bucket[2] += 1;
      }
    } else if (ev.event_type === "complete") {
      const m = p && typeof p.minutes === "number" ? p.minutes : livingDone.get(ev.block_id);
      if (m != null) {
        doneMinutes += m;
        doneTimed += 1;
      }
      // 与 Rust 同口径：**按时率分母只认 payload 里同时有 minutes + delay_minutes 的**（不拿 livingDone 兜底）；
      // `m`（含兜底）只用于完成时长 / 分类分钟
      const ratedM = p && typeof p.minutes === "number" ? p.minutes : null;
      const delay = p && typeof p.delay_minutes === "number" ? p.delay_minutes : null;
      if (ratedM != null && delay != null) {
        rated += 1;
        if (delay <= ratedM + 15) onTime += 1;
      }
      // 分类快照（缺字段 / 空白 = 无分类；不用任务现况反推）
      const cat = p && typeof p.category === "string" ? p.category.trim() : "";
      const bucket2 = catMap.get(cat) ?? { done: 0, minutes: 0 };
      bucket2.done += 1;
      bucket2.minutes += m ?? 0;
      catMap.set(cat, bucket2);
    } else if (ev.event_type === "delete") {
      deleted += p && typeof p.count === "number" ? p.count : 1;
    } else if (ev.event_type === "link") {
      if (p && p.cascade === true) cascaded += 1;
      else linked += 1;
    } else if (ev.event_type === "unlink") unlinked += 1;
  }
  const weeks = [];
  let wk = weekOf(window.__FAKE_NOW ?? nowSec);
  for (let i = 0; i < 12; i++) {
    if (weekHas.has(wk)) {
      const [d, m, po] = weekBucket.get(wk) ?? [0, 0, 0];
      weeks.push({ week_start: wk, done: d, missed: m, postponed: po });
    }
    wk = localDayStart(wk - 7 * 86400);
  }
  // round82（统-03）：近 14 天（含今天；0 值照摆，旧 → 新）
  const trend = [];
  const today = localDayStart(window.__FAKE_NOW ?? nowSec);
  let cursor = localDayStart(today - 13 * 86400);
  for (let i = 0; i < 14; i++) {
    trend.push({ day: cursor, done: dayDone.get(cursor) ?? 0 });
    cursor = localDayStart(cursor + 86400);
  }
  // round82（统-06）：连续自然日（历史最长 + 当前；今天还没完成不算断）
  const doneDays = [...dayDone.keys()].sort((a, b) => a - b);
  let streakBest = 0;
  let run = 0;
  let prev = null;
  for (const d of doneDays) {
    run = prev !== null && localDayStart(prev + 86400) === d ? run + 1 : 1;
    streakBest = Math.max(streakBest, run);
    prev = d;
  }
  let cur = dayDone.has(today) ? today : localDayStart(today - 86400);
  let streakNow = 0;
  while (dayDone.has(cur)) {
    streakNow += 1;
    cur = localDayStart(cur - 86400);
  }
  // round82（统-07）：分类分布（时长降序；无分类永远最后一栏）
  const categories = [...catMap.entries()]
    .filter(([name]) => name !== "")
    .map(([category, v]) => ({ category, done: v.done, minutes: v.minutes }))
    .sort((a, b) => b.minutes - a.minutes || b.done - a.done || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  const untagged = catMap.get("");
  if (untagged) categories.push({ category: "", done: untagged.done, minutes: untagged.minutes });
  const denom = complete + skip;
  return {
    first_event_at: first,
    active_days: days.size,
    total_events: total,
    complete,
    skip,
    rate_pct: denom === 0 ? null : Math.round((complete / denom) * 100),
    created,
    created_temp: createdTemp,
    moved,
    stretched,
    postponed,
    cascaded,
    deleted,
    merged,
    linked,
    unlinked,
    done_minutes: doneMinutes,
    done_timed: doneTimed,
    trend,
    on_time: onTime,
    rated,
    on_time_pct: rated === 0 ? null : Math.round((onTime / rated) * 100),
    avg_minutes: doneTimed === 0 ? null : Math.round(doneMinutes / doneTimed),
    streak_now: streakNow,
    streak_best: streakBest,
    categories,
    weeks,
  };
}

// round68（19.1）：最小事件总线 —— 假 Tauri 只实现 listen/unlisten + 手动 `__emitEvent`
// （真 Tauri 的 `plugin:event|listen` 收一个回调 id；这里就够验「点亮 → 提示 + NEW」那条链）
const eventListeners = {};
window.__emitEvent = (event, payload) => {
  for (const id of eventListeners[event] || []) {
    const cb = window["_" + id];
    if (typeof cb === "function") cb({ event, id, payload });
  }
};

// round68（19.1）：暗章假数据 —— 与真后端同形（未点亮 = "???" + 条件 + 进度；隐藏档过滤）
let achievementPanelOpened = false;
function achievementFixture() {
  const t = nowSec - 3600;
  const rows = [
    { id: "first_block", name: "破土", desc: "第一块任务落上时间轴。", cond: "把第一块任务放到时间轴上", progress: 1, target: 0, unlocked: true, unlocked_at: t, tier: 0, group: "入门", hidden: false },
    { id: "first_done", name: "第一个 ✓", desc: "第一次标下完成。", cond: "标记第一块完成", progress: 1, target: 0, unlocked: true, unlocked_at: t + 60, tier: 0, group: "入门", hidden: false },
    { id: "undo_first", name: "计划有变", desc: "第一次按下撤销。", cond: "撤销一次", progress: 1, target: 0, unlocked: true, unlocked_at: t + 120, tier: 0, group: "彩蛋", hidden: true },
    { id: "done_100", name: "???", desc: "???", cond: "完成 100 次", progress: 12, target: 100, unlocked: false, unlocked_at: null, tier: 1, group: "一点点来", hidden: false },
    // 6b 复核（P0）：同一分类一明一暗 —— 真后端会「已点亮优先 → 时间倒序」，分组不再连续
    { id: "first_template", name: "???", desc: "???", cond: "用一次模板铺骨架", progress: 0, target: 0, unlocked: false, unlocked_at: null, tier: 0, group: "入门", hidden: false },
    { id: "ma_hou_pao", name: "???", desc: "???", cond: "超时完成过一次", progress: 0, target: 0, unlocked: false, unlocked_at: null, tier: 0, group: "彩蛋", hidden: false },
    { id: "panel_first", name: "对暗号的人", desc: "第一次打开暗章面板。", cond: "打开暗章面板", progress: 1, target: 0, unlocked: achievementPanelOpened, unlocked_at: achievementPanelOpened ? nowSec : null, tier: 0, group: "功能探索", hidden: true },
  ];
  // round79（78-11）：点了「重置成就」→ 全部回到未点亮（隐藏档也重新藏起来）——
  // 照真后端的语义：**不是**把行删掉，而是「点亮记录清空 + 计分起点挪到此刻」＝从此刻起重新挣。
  if (window.__ACH_RESET) {
    for (const r of rows) {
      r.unlocked = false;
      r.unlocked_at = null;
      r.name = "???";
      r.desc = "???";
      if (r.target === 0) r.progress = 0;
    }
  }
  // 与真后端同形：已点亮优先 → 时间倒序；未点亮保持定义顺序（稳定排序）
  return rows
    .filter((r) => r.unlocked || !r.hidden)
    .sort((a, b) => Number(b.unlocked) - Number(a.unlocked) || (b.unlocked_at ?? 0) - (a.unlocked_at ?? 0));
}

window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: (cb) => {
    const id = Math.floor(Math.random() * 1e9);
    window["_" + id] = cb;
    return id;
  },
  invoke: async (cmd, args) => {
    // round69.1（诊断）：最近 40 条命令名 —— 断言失败时能看出「到底有没有发出那一条写」
    window.__CALLS = window.__CALLS || [];
    window.__CALLS.push(cmd);
    if (window.__CALLS.length > 40) window.__CALLS.shift();
    // round80（79-03 探针用）：让**匹配的这一次**命令晚 ms 毫秒才回 —— 把「建块→进改名态」的
    // 竞态窗口撑开（假后端太快时那一帧缝隙会被挤没；真机 SQLite + IPC 有这条缝）。用完即失效。
    if (window.__SLOW_CMD_ONCE && window.__SLOW_CMD_ONCE.cmd === cmd) {
      const ms = Number(window.__SLOW_CMD_ONCE.ms) || 0;
      window.__SLOW_CMD_ONCE = null;
      if (ms > 0) await tick(ms);
    }
    // round48：与真后端一致 —— 按**手动顺序**排（rowid 只做并列时兑底）
    if (cmd === "list_tasks") {
      // 空库态：一次性返回空任务表（断言用完即失效，与 `__STATS_EMPTY` 同一手法）——
      // 用来验证 Backlog 的空态；**不用真删任务**（那样会连带删块，收尾很难原样还原）
      if (window.__TASKS_EMPTY) {
        window.__TASKS_EMPTY = false;
        return [];
      }
      return [...FIX.tasks].sort((a, b) => a.sort_order - b.sort_order);
    }
    if (cmd === "list_blocks") {
      // round78（3.1b₂）：一次性空周（验空态与「空周不提醒」）——**不动 FIX.blocks**
      // （以前断言自己 stash/splice 真表，跑完全套会把假库停在种子块上 → 矩阵找不到靶子）
      if (window.__BLOCKS_EMPTY) return []; // 断言用完自己清（常驻开关：翻周两次中间不能把它吃掉）
      // 必须像真后端那样**按窗口过滤** —— 否则"翻页看不到东西"这类 bug 永远复现不出来 ✗
      // round25⑤：语义改成**区间相交**（起点在窗口之前、尾巴伸进来的块也要给）——
      // 与 Rust 侧 list_blocks 的 SQL（`start_at < to AND end_at > from`）保持一致
      const from = args?.from;
      const to = args?.to;
      // 诊断：记录每次请的窗口（跳周到底有没有人去拉那一周，看这个）
      window.__DBG = window.__DBG || [];
      window.__DBG.push([from, to]);
      // C1.6 复现用：凭空多一块「下一周」的（用户报「下一周放了东西，回到上一周什么都看不到」）
      // 还欠债 AK：以前它的 id 就写成 `b9` → 与本周真的 b9 **撞 id**，在「下一周」窗口里
      // `dbViewMismatch()` 会把它报成 `b9(界面上多出来的幻影行)`（假阳性）。现在改成独立 id。
      const first = FIX.blocks[0];
      const all = visibleBlocks().concat(
        first
          ? [
              Object.assign({}, first, {
                id: "bphantom",
                start_at: first.start_at + 7 * 86400,
                end_at: first.end_at + 7 * 86400,
              }),
            ]
          : [],
      );
      return all.filter(
        (b) => (from == null || b.end_at > from) && (to == null || b.start_at < to),
      );
    }
    if (cmd === "list_sequences") return FIX.sequences;
    // round64.1（CG）：序列取出的**写侧**（真后端有、以前这里没有 → 「取出」在预览里不可能被记到）
    if (cmd === "remove_sequence_member") {
      takeUndoSnapshot();
      const seq = FIX.sequences.find((s) => s.id === args?.sequenceId);
      if (!seq) return false;
      const before = seq.members.length;
      seq.members = seq.members.filter((m) => m.block_id !== args?.blockId);
      const removed = seq.members.length < before;
      if (removed && statsSeeded) pushStatsEvent("unlink", args.blockId, nowSec, null);
      return removed;
    }
    if (cmd === "missed_summary") return 0;
    // 让预览页能真的验「标记完成」（双击完成要用）—— 与真后端一样**改库**（不只是返回个改过的副本）：
    // 从 round26 起 markDone 走整周重拉，假后端不落库的话界面会立即被拉回原样（那就成了假断言）
    if (cmd === "mark_block_done" || cmd === "mark_block_missed") {
      // round79（6b 二轮 P1）：真后端这两条走 `record()`（一步可撤销）—— 假后端以前**不拍快照**，
      // 于是「标完 → Ctrl+Z」在本舱里撤不动（`round78 教①` 正是靠这条链，判据因此空转）。
      takeUndoSnapshot();
      const b = FIX.blocks.find((x) => x.id === args?.id);
      if (!b) return null;
      if (b.status !== "planned") return Object.assign({}, b); // 与真后端一样：已标记的不再改（不回退）
      if (cmd === "mark_block_done") {
        // round57（BR）：终态细分由**服务端**按标 ✓ 的时刻算 —— 与 Rust `db::final_status_for` 同一口径
        // （只读复核指出的：这条规则以前只在真后端有，假后端少做 → 「标 ✓ → 终态」在本舱里不可能红）
        const at = window.__FAKE_NOW ?? nowSec;
        const GRACE = 15 * 60;
        b.final_status = at < b.start_at ? "done_short" : at <= b.end_at + GRACE ? null : "done_overtime";
      }
      b.status = cmd === "mark_block_done" ? "done" : "missed";
      // C7（round52）：事实表跟着动（真后端写 events → 复盘明细 / 事实曲线读得到）
      FIX.facts[b.id] = Object.assign({ rearranged: 0, skipped: false }, FIX.facts[b.id]);
      if (cmd === "mark_block_missed") FIX.facts[b.id].skipped = true;
      // 10.1（round60）：种过统计事件后，标记照真后端记一条（「关掉 → 标 → 重开 +1」靠它）
      // round82（统-08）：完成账跟着带 delay_minutes + 分类快照（与 Rust `set_block_status` 同口径）
      if (statsSeeded) {
        let payload = null;
        if (cmd === "mark_block_done") {
          const at = window.__FAKE_NOW ?? nowSec;
          const cat = String(FIX.tasks.find((t) => t.id === b.task_id)?.category ?? "").trim();
          payload = JSON.stringify({
            minutes: Math.round((b.end_at - b.start_at) / 60),
            delay_minutes: Math.max(0, Math.floor((at - b.start_at) / 60)),
            ...(cat ? { category: cat } : {}),
          });
        }
        pushStatsEvent(cmd === "mark_block_done" ? "complete" : "skip", b.id, window.__FAKE_NOW ?? nowSec, payload);
      }
      return Object.assign({}, b);
    }
    // round26 U（漂流）：真后端一步会「残影留下 + 新建/移动链尾那块」，返回的只是**幸存者**。
    // 这里照它的语义改库，好让断言能验「视图与库一致」——旧前端只 upsert 返回的那一块 →
    // 库里已是 missed 的原块在界面上还是 planned（幻影行），下次重拉才“突然”变。
    if (cmd === "postpone_block") {
      const src = FIX.blocks.find((x) => x.id === args?.id);
      if (!src) return null;
      const len = src.end_at - src.start_at;
      src.status = "missed";
      // C7（round52）：漂流 = 一次「挪过」（真后端记 postpone 事件）
      FIX.facts[src.id] = Object.assign({ rearranged: 0, skipped: false }, FIX.facts[src.id]);
      FIX.facts[src.id].rearranged += 1;
      // 10.1（round60）：种过统计事件后，漂流照真后端记一条（非顺延）
      if (statsSeeded) {
        pushStatsEvent(
          "postpone",
          src.id,
          window.__FAKE_NOW ?? nowSec,
          JSON.stringify({ from: src.start_at, to: args.newStartAt }),
        );
      }
      const drift = Object.assign({}, src, {
        id: "drift" + (FIX.blocks.length + 1),
        start_at: args.newStartAt,
        end_at: args.newStartAt + len,
        status: "planned",
        postponed_from: src.id,
      });
      // round29 #3/#7：真后端这一支（链尾已结束 → `create_block` 新建）**会丢块名**，
      // 用户拍板「漂出去的还是同一件事」→ 要继承父块的 label。
      // ⚠️ 红绿对照：这一行写成 `null` 就是旧行为 → 预览那条断言必须红。
      drift.label = src.label ?? null;
      FIX.blocks.push(drift);
      return { block: drift, cascaded: 0, history_moved: 0, merged: false };
    }
    // C1.7 拉伸：要返回**真的** MoveOutcome，否则 store 会在 replaceBlock 前抛错（预览就成了噪音）
    if (cmd === "update_block") {
      takeUndoSnapshot(); // round64.1：与真后端 `record` 一样，会动数据的命令先拍快照
      const b = FIX.blocks.find((x) => x.id === args?.id);
      if (!b) return null;
      // 真后端的语义：只给 startAt → 时长不变、整块平移；给了 endAt → 改终点
      if (args?.startAt != null) {
        const len = b.end_at - b.start_at;
        b.start_at = args.startAt;
        b.end_at = args.startAt + len;
      }
      if (args?.endAt != null) b.end_at = args.endAt;
      if (args?.layer != null) b.layer = args.layer;
      // C1.8 改名：空串 = 清回默认名（真后端语义）
      if (args?.label != null) {
        const trimmed = String(args.label).trim();
        b.label = trimmed === "" ? null : trimmed;
      }
      const survivor = mergeNeighbour(b); // round30：真后端落库后会融合
      return {
        block: Object.assign({}, survivor ?? b),
        cascaded: 0,
        history_moved: 0,
        // round27 #3：真后端在「本该合却没合」时会回报原因（merge_hint）。
        // round30：这里改成与真后端同一套判定（漂流链/序列/超上限）—— 以前是个只认 b24 的替身，
        // 你自己把自己坑了：假后端不做融合时它看着能过，一旦假后端照真语义融合就全部失真 ✗
        merge_hint: survivor ? null : mergeHintFor(b),
        // round31：融合提示靠它（真后端就是 merge_adjacent 认了幸存者 = 合了）
        merged: !!survivor,
      };
    }
    if (cmd === "delete_block") {
      // round40：删之前拍一份快照（一级）—— 界面上的「撤销」要能真拿回来
      takeUndoSnapshot();
      const idx = FIX.blocks.findIndex((x) => x.id === args?.id);
      if (idx >= 0) FIX.blocks.splice(idx, 1);
      // round64.1（CG）：镜像真后端的 delete 记账（只对种过统计数据集的有效）
      if (idx >= 0 && statsSeeded) pushStatsEvent("delete", args.id, nowSec, '{"count":1}');
      return idx >= 0 ? 1 : 0;
    }
    // ===== round61（10.2 多选）：批量命令的假实现（语义照真后端）=====
    // 已知的**有意留白**（真后端有、这里不镜像，因为现有断言不依赖它们）：
    // ① 事件记账（stats 那套 complete/skip/delete）② 序列级联（cascaded/history_moved 恒 0）
    // ③ 漂移子树级联删除（Mv 块里没有漂移链）④ 层升级清 last_notified_at。
    if (cmd === "delete_blocks") {
      takeUndoSnapshot(); // 一条命令 = 一次快照 = **一步撤销**（断言⑤靠它）
      let n = 0;
      const seen = new Set();
      for (const id of args?.ids ?? []) {
        if (seen.has(id)) continue; // 与真后端一致：重复 id 不重复计数
        seen.add(id);
        const idx = FIX.blocks.findIndex((x) => x.id === id);
        if (idx >= 0) {
          FIX.blocks.splice(idx, 1);
          n++;
        }
      }
      // round64.1（CG）：与真后端 `delete_blocks` 同口径 —— 一次动作记一条（含真实删掉的块数）
      if (n > 0 && statsSeeded) pushStatsEvent("delete", args.ids[0], nowSec, JSON.stringify({ count: n }));
      return n;
    }
    if (cmd === "mark_blocks") {
      if (args?.status !== "done" && args?.status !== "missed") {
        throw new Error("状态不合法：只支持 done / missed"); // 与真后端一致
      }
      takeUndoSnapshot(); // round79（6b 二轮 P1）：与真后端 `record()` 同口径（批量标记也是一步）
      let n = 0;
      const at = window.__FAKE_NOW ?? nowSec;
      const GRACE = 15 * 60;
      for (const id of args?.ids ?? []) {
        const b = FIX.blocks.find((x) => x.id === id);
        if (!b || b.status !== "planned") continue; // 与真后端一致：幂等，只动 planned
        if (args?.status === "done") {
          b.final_status = at < b.start_at ? "done_short" : at <= b.end_at + GRACE ? null : "done_overtime";
          b.status = "done";
        } else {
          b.status = "missed";
          FIX.facts[b.id] = Object.assign({ rearranged: 0, skipped: false }, FIX.facts[b.id]);
          FIX.facts[b.id].skipped = true;
        }
        n++;
      }
      return n;
    }
    if (cmd === "move_blocks") {
      takeUndoSnapshot(); // round64.1：批量挪也走真后端的 record（一次命令 = 一步撤销）
      let changed = 0;
      let failed = 0;
      let merged = 0;
      // 与真后端一致：先按平移方向**排序**（往右从最右开始）—— 否则先挪的块会扫过
      // 「还没挪的邻居」触发**假融合**（round61.1）
      const items = (args?.moves ?? []).map(([id, start]) => {
        const b = FIX.blocks.find((x) => x.id === id);
        return { id, start, old: b ? b.start_at : 0 };
      });
      const net = items.reduce((s, it) => s + (it.start - it.old), 0);
      items.sort((a, b) => (net >= 0 ? b.old - a.old : a.old - b.old));
      for (const { id, start } of items) {
        const b = FIX.blocks.find((x) => x.id === id);
        if (!b || b.status !== "planned") {
          failed++; // 与真后端一致：已标记的不挪
          continue;
        }
        if (b.start_at === start) continue; // 与真后端一致：起点没变 = no-op，不算改动也不报失败
        const len = b.end_at - b.start_at;
        b.start_at = start;
        b.end_at = start + len;
        if (mergeNeighbour(b)) merged++; // 与真后端一致：挪完照样会融合
        changed++;
      }
      return { changed, cascaded: 0, history_moved: 0, merged, failed };
    }
    if (cmd === "set_blocks_layer") {
      takeUndoSnapshot(); // round64.1：同上（会动数据的命令先拍快照）
      let changed = 0;
      let failed = 0;
      let merged = 0;
      for (const id of args?.ids ?? []) {
        const b = FIX.blocks.find((x) => x.id === id);
        if (!b) {
          failed++;
          continue;
        }
        if (b.layer === args?.layer) continue;
        b.layer = args.layer;
        if (args?.layer === "required") b.last_notified_at = null; // 与真后端一致：升级清提醒
        if (mergeNeighbour(b)) merged++; // 改层也会触发融合（与真后端同口径）
        changed++;
      }
      return { changed, cascaded: 0, history_moved: 0, merged, failed };
    }
    // round40：撤销（真后端是整表快照栈；假后端只保一级，够验「删除 → 点撤销 → 回来」这条链）
    // ⚠️ 必须**返回 `{ label }`**（真后端的 `HistoryOutcome`）：前端 `sync(outcome.label, …)` 要读它，
    // 返回 null 会在那儿抛 TypeError 并被 catch 吃掉 → sync() 不跑 → 界面看着「撤销没反应」✗
    if (cmd === "undo" || cmd === "redo") {
      if (cmd === "undo" && UNDO_SNAP) {
        // round64.1（验收 #3）：镜像真后端的 focus（快照 diff）—— 前端视角跟踪才测得到真链路
        const before = FIX.blocks.map((b) => ({ ...b }));
        const beforeTasks = FIX.tasks.map((t) => ({ ...t }));
        // 当前态留成重做点（round69.1 / 6b P2-4：repeats 与水位线也是快照的一部分）
        REDO_SNAP = {
          blocks: before,
          tasks: beforeTasks,
          repeats: FIX.repeats.map((r) => ({ ...r })),
          repeatOcc: { ...FIX.repeatOcc },
        };
        restoreSnap(UNDO_SNAP);
        UNDO_SNAP = null;
        return { label: "上一步操作", focus: fakeFocus(before, FIX.blocks) };
      }
      if (cmd === "redo" && REDO_SNAP) {
        const before = FIX.blocks.map((b) => ({ ...b }));
        const redo = REDO_SNAP;
        REDO_SNAP = null;
        UNDO_SNAP = {
          blocks: before,
          tasks: FIX.tasks.map((t) => ({ ...t })),
          repeats: FIX.repeats.map((r) => ({ ...r })),
          repeatOcc: { ...FIX.repeatOcc },
        }; // 撤销还能回来
        restoreSnap(redo);
        return { label: "重做", focus: fakeFocus(before, FIX.blocks) };
      }
      return { label: cmd === "undo" ? "上一步操作" : "重做", focus: null };
    }
    if (cmd === "delete_task") {
      takeUndoSnapshot();
      const id = args?.id;
      const killed = FIX.blocks.filter((b) => b.task_id === id).length;
      // 就地改（不要换成新数组：外面可能还拿着这个引用）
      for (let i = FIX.blocks.length - 1; i >= 0; i--) {
        if (FIX.blocks[i].task_id === id) FIX.blocks.splice(i, 1);
      }
      const ti = FIX.tasks.findIndex((t) => t.id === id);
      if (ti >= 0) FIX.tasks.splice(ti, 1);
      return killed; // round40：回报连带删了几个块（撤销条要说清毁掉了什么）
    }
    if (cmd === "create_temp_block") {
      const b = BT(nextFakeBlockId("tmp"), args?.startAt, args?.endAt, null);
      FIX.blocks.push(b);
      // round64.1（CG）：镜像真后端的 create 记账（临时块带 temp 标记）
      if (statsSeeded) pushStatsEvent("create", b.id, nowSec, '{"temp":true}');
      // round31：建块命令现在返回 { block, merged }（临时块不融合 → merged 恒 false）
      return { block: b, merged: false };
    }
    if (cmd === "create_block") {
      const b = B(nextFakeBlockId("new"), args?.taskId, args?.startAt, args?.endAt, "elastic", "planned");
      FIX.blocks.push(b);
      // round64.1（CG）：同上（普通块）—— 融合吃掉也照样记（与真后端先记 create 再融合一致）
      if (statsSeeded) pushStatsEvent("create", b.id, nowSec, '{"temp":false}');
      // round30：真后端的 `create_block` 落库后也会融合（返回的可能不是刚建的那一块）
      const survivor = mergeNeighbour(b);
      return { block: Object.assign({}, survivor ?? b), merged: !!survivor };
    }
    // round69（B3）：复制手势 —— 批量建（一次调用 = 一步撤销）；返回**幸存块**数组（与 specs 对齐）
    if (cmd === "create_blocks") {
      takeUndoSnapshot();
      // round69.1（D1）：同格/相接复制 → **就地融合**（已有块当幸存者），并如实回报 created/merged；
      // 融合的那一份不再记 create（它没多出来）。
      let created = 0;
      let merged = 0;
      const blocks = [];
      for (const s of args?.blocks ?? []) {
        const b = Object.assign(
          B(nextFakeBlockId("cp"), s.task_id, s.start_at, s.end_at, s.layer, "planned"),
          { label: s.label ?? null, sanity_exempt: !!s.sanity_exempt },
        );
        if (s.task_id === TEMP_TASK_ID) b.is_temp = true;
        FIX.blocks.push(b);
        const survivor = mergeNeighbour(b, true);
        if (survivor) {
          merged += 1;
          if (!blocks.some((x) => x.id === survivor.id)) blocks.push(Object.assign({}, survivor));
        } else {
          created += 1;
          if (statsSeeded) pushStatsEvent("create", b.id, nowSec, '{"copy":true}');
          blocks.push(Object.assign({}, b));
        }
      }
      return { blocks, created, merged };
    }
    // round69（B3）：每周重复 —— 规则表 + 「打开哪一周补哪一周」的生成（镜像真后端口径，供 UI 断言）
    if (cmd === "list_repeats") {
      return FIX.repeats.filter((r) => args?.taskId == null || r.task_id === args.taskId);
    }
    if (cmd === "create_repeat") {
      const t = FIX.tasks.find((x) => x.id === args?.taskId);
      if (!t || t.archived_at) throw new Error("任务不存在或已归档");
      takeUndoSnapshot(); // 真后端：写命令都过 `record`（一步撤销）——假后端也得拍
      const wd = Number(args?.weekday);
      const sm = Number(args?.startMin);
      if (!(wd >= 0 && wd <= 6) || !(sm >= 0 && sm <= 1439)) throw new Error("周几/时刻不合法");
      if (
        FIX.repeats.some(
          (r) => r.task_id === args.taskId && r.weekday === wd && r.start_min === sm,
        )
      ) {
        throw new Error("这个时段已经有重复规则了");
      }
      // 与真后端同形：层只认两层、每个任务上限 20 条（6b P2）
      if (args?.layer !== "required" && args?.layer !== "elastic") throw new Error("层级不合法");
      if (FIX.repeats.filter((r) => r.task_id === args.taskId).length >= 20) {
        throw new Error("一个任务最多 20 条重复规则");
      }
      const rule = {
        // round69 / 6b P2：**单调计数器**（与块 id 同一套）—— 旧写法 `"rp" + (长度+1)`
        // 删掉后重建会**复用同一个 id** → `repeatOcc` 的旧水位线串到新规则上（⑩ 实测抓到的）
        id: "rp" + ++fakeRuleSeq,
        task_id: args.taskId,
        weekday: wd,
        start_min: sm,
        layer: args?.layer === "required" ? "required" : "elastic",
        enabled: true,
        created_at: nowSec,
      };
      FIX.repeats.push(rule);
      return Object.assign({}, rule);
    }
    if (cmd === "set_repeat_enabled") {
      const r = FIX.repeats.find((x) => x.id === args?.id);
      if (!r) throw new Error("重复规则不存在");
      takeUndoSnapshot(); // 同上：暂停/启用是一步可撤销的操作
      r.enabled = !!args?.enabled;
      // round69.1（#4 / D2）：暂停顺手把**未开始**的生成块与水位线一起撤下（镜像真后端）
      if (!r.enabled) dropUnstartedGenerated(r.id);
      return Object.assign({}, r);
    }
    if (cmd === "delete_repeat") {
      const i = FIX.repeats.findIndex((x) => x.id === args?.id);
      if (i < 0) throw new Error("重复规则不存在");
      takeUndoSnapshot(); // 同上
      dropUnstartedGenerated(FIX.repeats[i].id); // 删除同样：未开始的块先撤下
      FIX.repeats.splice(i, 1);
      return null;
    }
    if (cmd === "generate_repeats") {
      const now = window.__FAKE_NOW ?? nowSec;
      const weekStart = localDayStart(Number(args?.weekStart) || now);
      const DAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
      let created = 0;
      for (const r of FIX.repeats) {
        if (!r.enabled) continue;
        const t = FIX.tasks.find((x) => x.id === r.task_id);
        if (!t || t.archived_at) continue;
        const start = weekStart + r.weekday * 86400 + r.start_min * 60;
        const est = t.estimated_minutes ?? 0;
        const minutes = est <= 0 ? 30 : Math.max(15, Math.ceil(est / 15) * 15);
        const end = start + minutes * 60;
        if (end <= now) continue; // ① 已结束不补、不记水位线
        const key = r.id + "_" + weekStart;
        if (FIX.repeatOcc[key]) continue; // ② 水位线（生成过 / 跳过过 / 用户删过都算处理过）
        const clash = FIX.blocks.some((b) => b.start_at < end && b.end_at > start);
        if (clash) {
          FIX.repeatOcc[key] = "skipped"; // ③ 与现有块相交 → 跳过并定案
          continue;
        }
        const b = B(nextFakeBlockId("rep"), r.task_id, start, end, r.layer, "planned");
        b.repeat_note = `每${DAY_CN[r.weekday]} ${String(Math.floor(r.start_min / 60)).padStart(
          2,
          "0",
        )}:${String(r.start_min % 60).padStart(2, "0")}`;
        FIX.blocks.push(b);
        // round69 / 6b P2：与真后端同形 —— 生成后也跑一次融合；水位线记**幸存块**的 id
        const survivor = mergeNeighbour(b);
        if (survivor) survivor.repeat_note = b.repeat_note;
        FIX.repeatOcc[key] = (survivor ?? b).id;
        if (statsSeeded) pushStatsEvent("create", b.id, now, '{"repeat":true}');
        created += 1;
      }
      return created;
    }
    if (cmd === "create_task") {
      // 真后端：新建任务（round30 那条断言照用户步骤「新建一个 1」跑的）
      const t = T("nt" + (FIX.tasks.length + 1), args?.title ?? "新任务", null);
      if (args?.category != null) t.category = args.category;
      // round48：与真后端一致 —— **新建任务排在最上**（当前最小值 − 1）
      t.sort_order = Math.min(0, ...FIX.tasks.map((x) => x.sort_order)) - 1;
      FIX.tasks.push(t);
      return { ...t };
    }
    // round38：改任务属性（分类下拉那几条断言要真写库）—— 空串 = 清空，与真后端 `db::update_task` 一致
    if (cmd === "update_task") {
      // round70 断言用：让**这一次**写晚 ms 毫秒才落库（模拟「写还在路上」）。
      // 用来测：在途提交还没回来时 prop 被外面改（× 清空 / 撤销）→ 输入框不该留着在途值。
      if (window.__SLOW_UPDATE_TASK_ONCE) {
        const ms = Number(window.__SLOW_UPDATE_TASK_ONCE) || 0;
        window.__SLOW_UPDATE_TASK_ONCE = 0;
        if (ms > 0) await tick(ms);
      }
      // round44（BJ 断言用）：让**这一次**调用故意失败（模拟“保存失败”）—— 用完即失效，
      // 这样能真复现「输入框看着像已改好」那一类。harness 侧置位，不改产品代码。
      if (window.__FAIL_UPDATE_TASK_ONCE) {
        window.__FAIL_UPDATE_TASK_ONCE = false;
        throw new Error("假后端：这一次 update_task 故意失败");
      }
      const t = FIX.tasks.find((x) => x.id === args?.id);
      if (!t) return null;
      if (args?.title != null) t.title = String(args.title).trim();
      if (args?.category != null) {
        const c = String(args.category).trim();
        t.category = c === "" ? null : c;
      }
      if (args?.estimatedMinutes != null) {
        t.estimated_minutes = args.estimatedMinutes > 0 ? args.estimatedMinutes : null;
      }
      if (args?.isElastic != null) t.is_elastic = args.isElastic;
      return { ...t };
    }
    // round40：归档（真后端写 archived_at = now）—— 预览里原来没有这个桩，⑯ 那条查库就会假红
    if (cmd === "archive_task") {
      const t = FIX.tasks.find((x) => x.id === args?.id);
      if (!t) return null;
      t.archived_at = nowSec;
      return null;
    }
    // round38：取消归档（真后端写 archived_at = NULL）
    if (cmd === "unarchive_task") {
      const t = FIX.tasks.find((x) => x.id === args?.id);
      if (!t) return null;
      t.archived_at = null;
      return null;
    }
    // round47（8.1）：分类改名 / 合并 / 清空 —— 真语义与 `db::rename_category` 一致：
    // 一次改掉**整个分类**下的所有任务（含已归档），空串 = 回到「未分类」，返回改了几条。
    if (cmd === "rename_category") {
      takeUndoSnapshot(); // 改名也是“会动数据的落库调用” → 界面上的撤销要能真拿回旧分类
      const from = String(args?.from ?? "").trim();
      const to = String(args?.to ?? "").trim();
      let changed = 0;
      for (const t of FIX.tasks) {
        if (t.id === "ww-temp-hidden-task") continue; // 隐藏任务不参与（真后端碰不到它）
        if (t.category === from) {
          t.category = to === "" ? null : to;
          changed += 1;
        }
      }
      window.__CAT_CALLS = (window.__CAT_CALLS || 0) + 1;
      window.__LAST_CAT = [from, to];
      return changed;
    }
    // C6（round44）：理智值曲线 + 设置（真语义：改预算/开关会真的影响下一次曲线）
    if (cmd === "get_sanity_curve") return sanityWeek(args?.weekStart);
    // C7（round52）：复盘面板要的那一周（区间相交 + 结局 + 事实）；顺手记一笔调用，断言好查
    if (cmd === "get_week_mosaic") {
      // round79（78-08）：失败注入 —— **常驻**开关（断言自己关，照 `__TASKS_EMPTY` 的口径）。
      // 为什么不用「一次性」：打开总览会**连着拉两次**（`openReview()` 一次 + `ensureMosaic()` 的
      // effect 一次）—— 一次性的注入会被第二次成功的请求盖掉，失败态根本出不来（本轮实测）。
      if (window.__FAIL_MOSAIC) {
        throw new Error("mock: get_week_mosaic 失败");
      }
      window.__MOSAIC_DBG = window.__MOSAIC_DBG || [];
      window.__MOSAIC_DBG.push(args?.weekStart);
      return mosaicWeek(args?.weekStart);
    }
    // 10.1（round60）：统计页（全时段累计 + 近 12 周）—— 从 `FIX.events` 真聚合，不写死答案
    if (cmd === "get_stats") {
      window.__STATS_CALLS = (window.__STATS_CALLS || 0) + 1;
      // round78（3.1b₂ · 栈-10）：一次性失败注入（验「失败态 + 重试」）
      if (window.__FAIL_STATS_ONCE) {
        window.__FAIL_STATS_ONCE = false;
        throw new Error("mock: get_stats 失败一次");
      }
      if (window.__STATS_EMPTY) {
        window.__STATS_EMPTY = false; // 一次性开关（拍空库态用）
        return emptyStats();
      }
      seedStats();
      return statsSummary();
    }
    // round79（78-01）：恢复默认设置 —— 白名单键回默认（**语言保留**）、数据一行不动；
    // 内部键（这里用 `nudgedWeek` 代 `review_nudged_week`）也不归「设置」，不跟着回。
    if (cmd === "reset_settings") {
      const keepLocale = window.__LOCALE;
      const keepUiLocale = sanityState.uiLocale; // round81：语言**档位**也要保留（真后端只留语言键）
      const nudged = sanityState.nudgedWeek;
      Object.assign(sanityState, JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)));
      sanityState.nudgedWeek = nudged;
      sanityState.uiLocale = keepUiLocale;
      window.__LOCALE = keepLocale;
      window.__SETTINGS_RESET_CALLS = (window.__SETTINGS_RESET_CALLS || 0) + 1;
      return null;
    }
    // round79（78-10）：重置统计 —— **非破坏**（只挪计分起点）—— 返回线之后重新算的数字
    if (cmd === "reset_stats") {
      seedStats();
      statsResetAt = Math.floor(Date.now() / 1000);
      window.__STATS_RESET_AT = statsResetAt;
      // round80（6b P0）：与 settings / achievements 同形的**真计数器** ——
      // 之前只有 `__STATS_RESET_AT`，而 realConfirmProbe 读的是不存在的 `__STATS_RESET_CALLS`
      // → 「Enter/Esc 不写库」两条恒真（0===0）。两个都写，探针两种信号都可用。
      window.__STATS_RESET_CALLS = (window.__STATS_RESET_CALLS || 0) + 1;
      return statsSummary();
    }
    // round66（C12）：便携模式 —— 面板两卡对照（从 `sanityState` 现算，不写死答案）
    if (cmd === "get_data_info") {
      // round79（78-08）：失败注入（**常驻**开关，断言自己关 —— 与总览那条同一口径）
      if (window.__FAIL_DATA_INFO) {
        throw new Error("mock: get_data_info 失败");
      }
      const now = Math.floor(Date.now() / 1000);
      const portable = sanityState.dataPortable;
      const side = (label, dir, current, exists, ageSec, tasks, blocks) => ({
        label,
        dir,
        db: `${dir}\\wakeyweeky.sqlite`,
        current,
        exists,
        modified: exists ? now - ageSec : null,
        bytes: exists ? 1310720 : null,
        tasks: exists ? tasks : null,
        blocks: exists ? blocks : null,
        usable: exists,
        reason: null,
      });
      const currentSide = portable
        ? side("便携（exe\\data\\）", "C:\\WakeyWeeky\\data", true, true, 60, 12, 88)
        : side("默认位置", "C:\\Users\\demo\\AppData\\Roaming\\com.wakeyweeky.app", true, true, 60, 12, 88);
      const otherSide = portable
        ? side("默认位置", "C:\\Users\\demo\\AppData\\Roaming\\com.wakeyweeky.app", false, true, 7200, 11, 80)
        : side("便携（exe\\data\\）", "C:\\WakeyWeeky\\data", false, false, 0, 0, 0);
      return {
        portable,
        fallback: sanityState.dataFallback,
        note: sanityState.dataNote,
        flag: "C:\\WakeyWeeky\\portable.flag",
        adopted: sanityState.dataAdopted,
        current: currentSide,
        other: otherSide,
      };
    }
    if (cmd === "apply_data_choice") {
      // 真后端会复制 + 重启；假后端只记录（断言「取消确认不许调用」用）
      sanityState.dataChoice = args?.pick ?? null;
      return null;
    }
    if (cmd === "hotkey_status") {
      return sanityState.hotkeyError
        ? { active: null, error: sanityState.hotkeyError }
        : { active: "Win+Shift+W", error: null };
    }
    // round82（3.1c₂ · 淡-05）：夜间档跨界 —— 前端节拍调它重刷窗口主题。**不写设置**；
    // 假后端只数调用次数（断言「到点才刷、白天不刷」），真正的解析在 Rust 单测里。
    if (cmd === "refresh_window_theme") {
      window.__REFRESH_THEME_CALLS = (window.__REFRESH_THEME_CALLS || 0) + 1;
      return null;
    }
    if (cmd === "get_settings") {
      return {
        values: {
          sanity_budget_minutes: String(sanityState.budget),
          sanity_enabled: sanityState.enabled ? "1" : "0",
          scheduler_enabled: sanityState.scheduler ? "1" : "0", // round63：默认关（与真后端一致）
          remind_start: sanityState.remindStart ? "1" : "0",
          remind_end: sanityState.remindEnd ? "1" : "0",
          backlog_width: String(sanityState.backlogWidth),
          // C7（round52）+ round57（0.13.0）：周报到点（三选一 + 时刻）
          review_action: sanityState.reviewAction,
          review_remind_at: sanityState.reviewRemindAt,
          // round63（C18）：免打扰 / 开始提醒提前
          quiet_until: String(sanityState.quietUntil),
          quiet_morning_at: sanityState.quietMorning,
          remind_lead_minutes: String(sanityState.remindLead),
          backlog_filter: sanityState.backlogFilter,
          backlog_grouped: sanityState.backlogGrouped ? "1" : "0",
          backlog_collapsed: sanityState.backlogCollapsed,
          // round67：外观 / 布局三键（round67.2：删「整栏隐藏」）
          backlog_pane: sanityState.backlogPane,
          weekend_hidden: sanityState.weekendHidden ? "1" : "0",
          hint_bar_mode: sanityState.hintBarMode,
          // round76（3.1a）：外观五件
          ui_density: sanityState.uiDensity,
          ui_theme: sanityState.uiTheme,
          ui_palette: sanityState.uiPalette,
          layer_bar_color: sanityState.layerBarColor ? "1" : "0",
          category_bar: sanityState.categoryBar ? "1" : "0",
          // round80（6b P2）：补上 round77/78/80 的四键（与真后端同形）
          icon_set: sanityState.iconSet,
          block_second_line: sanityState.blockSecondLine,
          // round87（3.3）：界面字体族（与真后端同形）
          ui_font: sanityState.uiFont,
          now_line: sanityState.nowLine ? "1" : "0",
          template_preview: sanityState.templatePreview ? "1" : "0",
          // round81（3.1c₁）：时间 / 日期格式（与真后端同形）
          time_format: sanityState.timeFormat,
          date_format: sanityState.dateFormat,
          slot_height: sanityState.slotHeight,
          // round82（3.1c₂ · 淡-*）：夜间淡化三键
          night_dim: sanityState.nightDim ? "1" : "0",
          night_start: sanityState.nightStart,
          night_end: sanityState.nightEnd,
          // round82（3.1c₂ · 绑-08）：键位覆盖（假后端只存；结构校验在 Rust 单测）
          key_bindings: sanityState.keyBindings,
          // round64（C10）：15 个功能开关（布尔全开 → "1"）+ 模板建议 JSON
          ...Object.fromEntries(
            Object.entries(sanityState.features).map(([k, on]) => [k, on ? "1" : "0"]),
          ),
          template_suggest: sanityState.templateSuggest,
          // round68（19.1）：成就两键（默认开）
          achievements_enabled: "1",
          achievement_toast: "1",
          // round74（3.0b₂）：界面语言（`--locale en` 时跑英文排版）
          // round81（3.1c₁ · 深-03）：回的是**档位**（system / zh / en）
          ui_locale: sanityState.uiLocale,
        },
      };
    }
    if (cmd === "set_setting") {
      // round54（BQ 断言用）：让**这一次**写设置失败（模拟“保存失败 → 控件该拨回去”）—— 用完即失效；
      // harness 侧置位，不改产品代码（与 __FAIL_UPDATE_TASK_ONCE 同一套）
      if (window.__FAIL_SET_SETTING_ONCE) {
        window.__FAIL_SET_SETTING_ONCE = false;
        throw new Error("假后端：这一次 set_setting 故意失败");
      }
      if (args?.key === "sanity_budget_minutes") {
        const minutes = Number(args?.value);
        if (Number.isFinite(minutes) && minutes > 0) sanityState.budget = minutes;
      }
      if (args?.key === "sanity_enabled") sanityState.enabled = String(args?.value) !== "0";
      if (args?.key === "backlog_width") sanityState.backlogWidth = Number(args?.value);
      // round81（3.1c₁ · 宽-04）：时间刻度（假后端只存，值域校验在 Rust 单测）
      if (args?.key === "slot_height") sanityState.slotHeight = String(args?.value).trim();
      if (args?.key === "remind_start") sanityState.remindStart = String(args?.value) !== "0";
      if (args?.key === "remind_end") sanityState.remindEnd = String(args?.value) !== "0";
      // round63（C18）：免打扰 / 开始提醒提前 / 计划任务
      if (args?.key === "quiet_until") sanityState.quietUntil = Number(args?.value) || 0;
      if (args?.key === "quiet_morning_at") sanityState.quietMorning = String(args?.value).trim();
      if (args?.key === "remind_lead_minutes") sanityState.remindLead = Number(args?.value) || 0;
      // round64（C10）：功能开关（只认 0/1）+ 模板建议（原样存 JSON）
      if (FEATURE_KEYS.includes(args?.key)) sanityState.features[args.key] = String(args?.value) !== "0";
      if (args?.key === "template_suggest") sanityState.templateSuggest = String(args?.value);
      if (args?.key === "scheduler_enabled") sanityState.scheduler = String(args?.value) === "1";
      // round74（3.0b₂）：语言（切完 get_settings 也要回新值，否则重读会拨回去）
      if (args?.key === "ui_locale") {
        const v = String(args?.value).trim();
        // 与真后端同一值域（system / zh / en）；`system` 在假后端里解析成 zh（模拟的系统语言）
        sanityState.uiLocale = v === "en" || v === "zh" ? v : "system";
        window.__LOCALE = sanityState.uiLocale === "en" ? "en" : "zh";
      }
      if (args?.key === "backlog_filter") sanityState.backlogFilter = String(args?.value);
      if (args?.key === "backlog_grouped") sanityState.backlogGrouped = String(args?.value) === "1";
      if (args?.key === "backlog_collapsed") sanityState.backlogCollapsed = String(args?.value);
      // round67：外观 / 布局三键（假后端只存，校验在 Rust 单测）
      if (args?.key === "backlog_pane") sanityState.backlogPane = String(args?.value);
      if (args?.key === "weekend_hidden") sanityState.weekendHidden = String(args?.value) === "1";
      if (args?.key === "hint_bar_mode") sanityState.hintBarMode = String(args?.value);
      // round76（3.1a）：外观五件（假后端只存，值域校验在 Rust 单测）
      if (args?.key === "ui_density") sanityState.uiDensity = String(args?.value).trim();
      if (args?.key === "ui_theme") sanityState.uiTheme = String(args?.value).trim();
      if (args?.key === "ui_palette") sanityState.uiPalette = String(args?.value).trim();
      if (args?.key === "layer_bar_color") sanityState.layerBarColor = String(args?.value) === "1";
      if (args?.key === "category_bar") sanityState.categoryBar = String(args?.value) === "1";
      // round80（6b P2）：round77/78/80 的四键（假后端只存，值域校验在 Rust 单测）
      if (args?.key === "icon_set") sanityState.iconSet = String(args?.value).trim();
      if (args?.key === "block_second_line") sanityState.blockSecondLine = String(args?.value).trim();
      // round87（3.3）：界面字体族（假后端只存，值域校验在 Rust 单测）
      if (args?.key === "ui_font") sanityState.uiFont = String(args?.value).trim();
      if (args?.key === "now_line") sanityState.nowLine = String(args?.value) === "1";
      if (args?.key === "template_preview") sanityState.templatePreview = String(args?.value) === "1";
      // round82（3.1c₂ · 淡-*）：夜间淡化三键（假后端只存，值域校验在 Rust 单测）
      if (args?.key === "night_dim") sanityState.nightDim = String(args?.value) === "1";
      if (args?.key === "night_start") sanityState.nightStart = String(args?.value).trim();
      if (args?.key === "night_end") sanityState.nightEnd = String(args?.value).trim();
      // round82（3.1c₂ · 绑-08）：键位覆盖（假后端只存，结构校验在 Rust 单测）
      if (args?.key === "key_bindings") sanityState.keyBindings = String(args?.value ?? "{}");
      // round81（3.1c₁）：时间 / 日期格式（假后端只存，值域校验在 Rust 单测）
      if (args?.key === "time_format") sanityState.timeFormat = String(args?.value).trim();
      if (args?.key === "date_format") sanityState.dateFormat = String(args?.value).trim();
      if (args?.key === "review_action") {
        const v = String(args?.value).trim();
        if (v !== "open" && v !== "hint" && v !== "off") {
          throw new Error("假后端：review_action 只认 open / hint / off");
        }
        sanityState.reviewAction = v;
      }
      if (args?.key === "review_remind_at") sanityState.reviewRemindAt = String(args?.value).trim().toLowerCase();
      window.__SANITY_WRITES = (window.__SANITY_WRITES || 0) + 1;
      window.__LAST_SETTING = [args?.key, String(args?.value)];
      return null;
    }
    // round48：任务级「不计入理智」（真写假库：日子小条与曲线要跟着变）
    if (cmd === "set_task_exempt") {
      const t = FIX.tasks.find((x) => x.id === args?.id);
      if (!t) return null;
      t.sanity_exempt = !!args?.exempt;
      return { ...t };
    }
    // round49：临时块自己的「不计入理智」（真写假库：曲线要跟着变）
    if (cmd === "set_block_exempt") {
      const b = FIX.blocks.find((x) => x.id === args?.id);
      if (!b) return null;
      b.sanity_exempt = !!args?.exempt;
      return { ...b };
    }
    // round48：Backlog 的手动顺序（真写假库的顺序：断言要能看见列表真的换了位置）
    if (cmd === "reorder_tasks") {
      takeUndoSnapshot();
      const ids = Array.isArray(args?.ids) ? args.ids : [];
      let changed = 0;
      ids.forEach((id, index) => {
        const t = FIX.tasks.find((x) => x.id === id);
        if (!t) return; // 未知 id 跳过（与真后端一致）
        t.sort_order = index;
        changed += 1;
      });
      window.__LAST_ORDER = ids.slice();
      return changed;
    }
    // C7（round52）+ round57：周报到点（到点且未提过 → 推进水位线并返回；一周一次）
    if (cmd === "take_review_nudge") {
      const now = window.__FAKE_NOW ?? nowSec;
      const target = fakeNudgeWeek(
        now,
        sanityState.reviewAction,
        sanityState.reviewRemindAt,
        sanityState.nudgedWeek,
      );
      if (target === null) return null;
      // round78（3.1b₂ · 教-11）：目标周**一块都没有 → 不发，也不推水位线**
      // （与 Rust `review::take_nudge` 同一口径；用 `visibleBlocks()` 镜像 `drift_filter`）
      const weekEnd = target + 7 * 86400;
      const anyInWeek =
        !window.__BLOCKS_EMPTY && visibleBlocks().some((b) => b.start_at < weekEnd && b.end_at > target);
      if (!anyInWeek) return null;
      sanityState.nudgedWeek = target;
      window.__LAST_NUDGE = target;
      return { week_start: target, at: sanityState.reviewRemindAt };
    }
    if (cmd === "mark_review_seen") {
      sanityState.nudgedWeek = localDayStart(args?.weekStart ?? nowSec);
      return null;
    }
    // round64（C10）：模板 —— 预览/存/铺/删都真落到假库（骨架算得跟真后端同一套口径）
    if (cmd === "list_templates") {
      return templateState.list.map((t) => ({
        id: t.id,
        name: t.name,
        block_count: t.rows.length,
        created_at: t.created_at,
      }));
    }
    if (cmd === "preview_week_skeleton") {
      const base = Number(args?.weekStart ?? 0);
      window.__PREVIEW_WEEKS = window.__PREVIEW_WEEKS || [];
      window.__PREVIEW_WEEKS.push(base); // round64⑦：断言「建议条点开时真的拉的是那一周」
      const end = base + 7 * 86_400;
      return visibleBlocks()
        .filter((b) => b.start_at >= base && b.start_at < end && b.status !== "missed")
        .sort((a, b) => a.start_at - b.start_at)
        .flatMap((b) => {
          const start_min = Math.floor((b.start_at - base) / 60);
          const duration_min = Math.min(
            Math.floor((b.end_at - b.start_at) / 60),
            7 * 24 * 60 - start_min,
          );
          // 与真后端同一套规则：太短的行跳过；round64.1（验收 #2）行带「任务名 + 分类」
          if (duration_min < 15) return [];
          const isTemp = b.task_id === TEMP_TASK_ID;
          const blockName = typeof b.label === "string" ? b.label.trim() : "";
          const task = FIX.tasks.find((t) => t.id === b.task_id);
          const taskTitle = task?.title ? String(task.title).trim() : "";
          const title = isTemp
            ? blockName && blockName.length <= 200
              ? blockName
              : null
            : blockName || taskTitle || null;
          return [
            {
              start_min,
              duration_min,
              layer: b.layer === "required" ? "required" : "elastic",
              title,
              category: isTemp ? null : (task?.category ?? null),
              label: null,
            },
          ];
        });
    }
    if (cmd === "create_template") {
      takeUndoSnapshot(); // 会动数据的命令 → 与真后端的 record 一样记一步
      const rows = Array.isArray(args?.rows) ? args.rows : [];
      const info = {
        id: "tpl-" + templateState.nextId++,
        name: String(args?.name ?? "").trim(),
        rows,
        created_at: nowSec,
      };
      templateState.list.push(info);
      return { id: info.id, name: info.name, block_count: rows.length, created_at: info.created_at };
    }
    if (cmd === "apply_template") {
      takeUndoSnapshot(); // 一次套用 = 一步撤销（round64④ 靠它验证）
      const tpl = templateState.list.find((t) => t.id === args?.id);
      if (!tpl) throw new Error("假后端：模板不存在");
      const base = Number(args?.weekStart ?? 0);
      const made = new Map();
      for (const row of tpl.rows) {
        const start = base + row.start_min * 60;
        const end = start + row.duration_min * 60;
        const title = typeof row.title === "string" ? row.title.trim() : "";
        if (title) {
          // round64.1（验收 #2）：按名复用未归档任务；找不到才新建（带分类）；同名多行共用一个
          let id = made.get(title);
          if (!id) {
            const found = FIX.tasks.find((t) => t.title === title && !t.archived_at);
            if (found) id = found.id;
            else {
              const t = T("ntpl" + (FIX.tasks.length + 1), title, null, row.category ?? null);
              FIX.tasks.push(t);
              id = t.id;
            }
            made.set(title, id);
          }
          const b = B(
            nextFakeBlockId("tpl"),
            id,
            start,
            end,
            row.layer === "required" ? "required" : "elastic",
            "planned",
          );
          FIX.blocks.push(b);
          // round64.1（CG）：铺模板＝真任务块的新建 → 同样记 create
          if (statsSeeded) pushStatsEvent("create", b.id, nowSec, '{"temp":false}');
        } else {
          const b = BT(nextFakeBlockId("tpl"), start, end, row.label ?? null);
          b.layer = row.layer === "required" ? "required" : "elastic";
          FIX.blocks.push(b);
          if (statsSeeded) pushStatsEvent("create", b.id, nowSec, '{"temp":true}');
        }
      }
      return { created: tpl.rows.length };
    }
    if (cmd === "delete_template") {
      takeUndoSnapshot();
      const before = templateState.list.length;
      templateState.list = templateState.list.filter((t) => t.id !== args?.id);
      if (templateState.list.length === before) throw new Error("假后端：模板不存在");
      return null;
    }
    if (cmd === "should_show_first_run") {
      // round64⑤：记调用次数 —— 默认跑法（库非空）至少能验「组件真问了后端」
      window.__FIRST_RUN_CALLS = (window.__FIRST_RUN_CALLS || 0) + 1;
      return window.__FIRST_RUN === true;
    }
    if (cmd === "mark_first_run_seen") {
      window.__FIRST_RUN = false;
      window.__FIRST_RUN_SEEN_CALLS = (window.__FIRST_RUN_SEEN_CALLS || 0) + 1;
      return null;
    }
    if (cmd === "take_template_suggestion") return window.__SUGGEST_WEEK ?? null;
    // round81（3.1c₁ · 深-03）：`ui_locale=system` 时前端问的「系统语言解析结果」——
    // 预览里模拟的系统语言 = zh（`--locale en` 只是把档位预置成 en，不代表系统语言）
    if (cmd === "system_locale") {
      window.__SYSTEM_LOCALE_CALLS = (window.__SYSTEM_LOCALE_CALLS || 0) + 1;
      // round82（11.7）：跟断言用的一次性旋钮 —— 模拟「既非中英」的系统语言（默认 zh-CN）
      return window.__SYSTEM_LOCALE ?? "zh-CN"; // 预览里模拟的系统语言标签（BCP-47；`--locale en` 只预置档位，不代表系统语言）
    }
    if (cmd === "take_hint") {
      // round64⑥：默认**不武装** —— 套件里有很多次拉伸，提示条只在那条断言里真出
      //（否则会在别的断言中间冒出来干扰画面）；已看过列表就是假后端这一份
      if (window.__HINTS_ARMED !== true) return false;
      const id = String(args?.id ?? "");
      if (!sanityState.features.hints_enabled) return false;
      window.__HINTS_SEEN = window.__HINTS_SEEN || [];
      if (window.__HINTS_SEEN.includes(id)) return false;
      window.__HINTS_SEEN.push(id);
      return true;
    }
    // round62（C14）：调试用调用记录（检查㉗ 靠它区分「点了没到后端」与「确认被拒」）
    if (
      cmd.startsWith("plugin:dialog|") ||
      cmd === "export_backup" ||
      cmd === "import_backup"
    ) {
      window.__R62_CALLS = window.__R62_CALLS || [];
      window.__R62_CALLS.push(cmd + (args?.path ? "→" + args.path : ""));
    }
    // round62（C14）：备份 —— 系统对话框三个桩（harness 用 window.__DIALOG_* 控制返回值；
    // 真插件在桌面端走的是同样的命令名，这里只接住不弹窗）
    if (cmd === "plugin:dialog|save") {
      window.__DIALOG_LAST_SAVE = args?.options ?? null; // ㉖ 要断言 defaultPath / filters 没丢
      return window.__DIALOG_SAVE_PATH ?? null;
    }
    if (cmd === "plugin:dialog|open") return window.__DIALOG_OPEN_PATH ?? null;
    if (cmd === "plugin:dialog|confirm" || cmd === "plugin:dialog|message") {
      // round66：记一次「确实弹了确认」—— 断言的**正向对照**（否则取消后什么都不写也能绿）
      window.__DIALOG_CONFIRM_CALLS = (window.__DIALOG_CONFIRM_CALLS || 0) + 1;
      // 插件的 confirm() 语义：返回「被点按钮的 label」，不等于 okLabel 就是取消
      //（看 dist-js 的实现：`(await messageCommand(...)) === okLabel`）—— 所以这里回 label 不回布尔
      if (window.__DIALOG_CONFIRM === false) return null;
      // 形状见 dist-js 的 `buttonsToRust`：{OkCancelCustom:[ok,cancel]} / {OkCustom:ok} / 'OkCancel' …
      const b = args?.buttons;
      if (b && typeof b === "object") {
        if (Array.isArray(b.OkCancelCustom)) return b.OkCancelCustom[0];
        if (Array.isArray(b.YesNoCancelCustom)) return b.YesNoCancelCustom[0];
        if (typeof b.OkCustom === "string") return b.OkCustom;
      }
      return "Ok";
    }
    // 两条备份命令：只记录调用（真后端会 VACUUM INTO / staging + 重启，这里不碰文件系统）
    if (cmd === "export_backup") {
      window.__BACKUP_EXPORTED = args?.path ?? null;
      return { path: args?.path ?? "", bytes: 12345 };
    }
    if (cmd === "import_backup") {
      window.__BACKUP_IMPORTED = args?.path ?? null;
      return null;
    }
    // round64（C11）：.ics 导出 —— 同样只记录（真后端写文件）
    if (cmd === "export_ics") {
      window.__ICS_EXPORTED = args?.path ?? null;
      return { path: args?.path ?? "", bytes: 4321, events: 7 };
    }
    // round68（19.1）：暗章 —— 面板数据 + 前端信号（`panel` 照真后端点亮并广播）
    if (cmd === "plugin:event|listen") {
      (eventListeners[args?.event] ||= []).push(args?.handler);
      return args?.handler ?? 0;
    }
    if (cmd === "plugin:event|unlisten") {
      const list = eventListeners[args?.event] || [];
      const i = list.indexOf(args?.eventId);
      if (i >= 0) list.splice(i, 1);
      return null;
    }
    if (cmd === "list_achievements") {
      // round78（3.1b₂ · 栈-10）：一次性失败注入
      if (window.__FAIL_ACH_ONCE) {
        window.__FAIL_ACH_ONCE = false;
        throw new Error("mock: list_achievements 失败一次");
      }
      window.__ACH_CALLS = (window.__ACH_CALLS || 0) + 1;
      const rows = achievementFixture();
      return { unlocked: rows.filter((r) => r.unlocked).length, total: 98, rows };
    }
    // round79（78-11）：重置成就 —— 清空点亮记录 + 计分起点挪到此刻（断言自己关开关）
    if (cmd === "reset_achievements") {
      window.__ACH_RESET = true;
      window.__ACH_RESET_CALLS = (window.__ACH_RESET_CALLS || 0) + 1;
      return null;
    }
    if (cmd === "note_achievement") {
      (window.__ACH_SIGNALS ||= []).push(args?.signal ?? "");
      if (args?.signal === "panel" && !achievementPanelOpened) {
        achievementPanelOpened = true;
        // 照真后端：点亮 panel_first 并广播（App 监听 → 短提示 + 面板挂 NEW + 重拉）
        window.__emitEvent("achievement-unlocked", [
          { id: "panel_first", name: "对暗号的人", unlocked_at: Math.floor(Date.now() / 1000) },
        ]);
      }
      return null;
    }
    if (cmd.startsWith("plugin:event|")) return 0; // listen / unlisten
    return null;
  },
};

/* ============================================================
   round76（3.1a）：共用工具 —— 让断言与「全矩阵」用同一份实现
   ============================================================ */

/** 让 Svelte 把 DOM 更新 flush 掉（微任务；与 checks.js 的 settle 同一套口径） */
const flushMicro = () => new Promise((r) => queueMicrotask(() => queueMicrotask(r)));
const settleMicro = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await flushMicro();
};

/**
 * **通用横向溢出扫描**（round74 ① 的实现搬到这里：断言与 matrix.js 共用一份，免得两处漂移）。
 * 范围 = 主屏 + 设置面板 + 四个覆盖式面板（成就 / 说明 / 总览 / 统计）。
 * 判据 = 可见、非滚动、非省略号截断、且有多个子项的容器：`scrollWidth ≤ clientWidth + 2`。
 * 返回违规文字数组（`[]` = 干净）。
 */
async function scanOverflow() {
  const skipTags = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "HTML", "BODY"]);
  // 设计上允许/无关的：块内文字本就按块宽截断；`.gutter` 的溢出来自 `::before` 背景延伸
  // round77（3.1b）：块与它的定位盒 `.box` 一起跳过 —— 块上动作是**悬停才出现的浮层**（你拍板允许
  // 超出块边界），静止时不占布局也不可见（opacity 0 + pointer-events none），但它会让祖先的
  // scrollWidth 变大 → 不算「布局溢出」。名字仍然 `text-overflow: ellipsis` 截断（另有判据）。
  const skipClosest = "[data-block-id], .box";
  // round77 收尾：键位提示条是**不换行 + 截断**的设计（`title` 里有全文，窄窗就是会截）——
  // 与 `.gutter`（背景延伸）同类：设计上允许，不叫布局溢出
  const skipCls = new Set([".gutter", ".key-hint"]);
  const scan = (tagPrefix) => {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      if (skipTags.has(el.tagName)) continue;
      if (el.closest(skipClosest)) continue;
      const cls =
        typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
          : el.tagName.toLowerCase();
      if (skipCls.has(cls.split(".").slice(0, 2).join("."))) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX === "auto" || cs.overflowX === "scroll") continue; // 本来就是滚动容器
      if (cs.textOverflow === "ellipsis") continue; // 设计好的截断（省略号）
      if (el.children.length < 2) continue; // 只看真的装得下多个子项的容器（叶子文字截断不在这里管）
      if (el.clientWidth <= 0 || el.clientHeight <= 0) continue; // 不可见盒
      if (el.scrollWidth > el.clientWidth + 2) {
        const bc = [...el.children].find((c) => c.scrollWidth > c.clientWidth + 2);
        const child = bc
          ? `@${(typeof bc.className === "string" ? bc.className : bc.tagName).split(" ")[0]}:${bc.scrollWidth}>${bc.clientWidth}`
          : "";
        out.push(`${tagPrefix}${cls}:${el.scrollWidth}>${el.clientWidth}${child}`);
      }
    }
    return out;
  };
  // 先关掉可能开着的覆盖层，回到主屏（覆盖层另有 round73p ② 专门量）
  document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click());
  await settleMicro(20);
  const main = scan("主屏:");
  document.querySelector(".sanity-gear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settleMicro(20);
  const pop = scan("设置:");
  const overlays = [];
  const openAndScan = async (clickSel, closeSel, tag) => {
    const btn = document.querySelector(clickSel);
    if (!btn) return;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settleMicro(40);
    overlays.push(...scan(`覆盖(${tag}):`));
    document.querySelector(closeSel)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settleMicro(20);
  };
  await openAndScan(".sanity-pop .ach-view", ".ach-panel .close", "成就");
  await openAndScan(".sanity-pop .help-open", ".help-panel .close", "说明");
  // round82（3.1c₂ · 绑-*）：改键位面板（设置里的子层；行 = 动作名 + 作用域 + 已改/恢复 + 键帽）
  await openAndScan(".sanity-pop .keymap-open", ".keymap-panel .close", "改键位");
  document.querySelector(".sanity-pop .close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settleMicro(20);
  await openAndScan(".templates-open", ".tpl-pop .close", "模板"); // round78（栈-06）：模板弹层也算一屏
  await openAndScan(".review-open", ".review-panel .close", "总览");
  await openAndScan(".stats-open", ".stats-panel .close", "统计");
  return [...main, ...pop, ...overlays];
}

/**
 * round76（3.1a）：密度三档的**期望值**（页面侧唯一一份；断言与全矩阵都读它）。
 * 设计口径来自 `docs/visual/3.1字号密度样张.html`：紧凑 26 / 舒适 30 / 宽松 34（格高）。
 * CSS 里的字面量与 `src/lib/utils/appearance.ts` 的刻度表另有 Node 侧交叉核对
 * （`preview.mjs` 的「刻度三方对齐」）。
 */
const DENSITY_EXPECT = {
  compact: {
    "--text-meta": "12px",
    "--text-body": "12px",
    "--text-title": "13px",
    "--text-label": "12px",
    "--row-height": "28px",
    "--slot-height": "26px",
    "--control-height": "24px",
    "--timeline-col-width": "128px",
  },
  comfortable: {
    "--text-meta": "12px",
    "--text-body": "13px",
    "--text-title": "14px",
    "--text-label": "12px",
    "--row-height": "32px",
    "--slot-height": "30px",
    "--control-height": "28px",
    "--timeline-col-width": "136px",
  },
  loose: {
    "--text-meta": "13px",
    "--text-body": "14px",
    "--text-title": "15px",
    "--text-label": "13px",
    "--row-height": "36px",
    "--slot-height": "34px",
    "--control-height": "32px",
    "--timeline-col-width": "148px",
  },
};

/** 当前密度那一档的期望表（读不到就按舒适） */
function densityExpect(density) {
  return DENSITY_EXPECT[density] ?? DENSITY_EXPECT.comfortable;
}
