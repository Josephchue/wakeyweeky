/**
 * C7 复盘（round52 / 0.12.0）：面板要的数据 + 会话内状态。
 *
 * 三件事：
 * - 把 `get_week_mosaic` 拿回来（**防竞态**照 sanity store：只认「还是我在看的那一周」+ 序号守旧）；
 * - 分组只读 `utils/category.ts` 的口径（「按类别」= 同一份数据换一种读法，不另立一套）；
 * - 面板状态（开着/选中哪一天/两种视图/比上周）—— **会话内记住**，重启不存（R48 的「记住视图」归 C18）。
 *
 * 不重算任何规则：结局在 Rust `review.rs` 算，这里只负责分组与画。
 */
import { t, tn } from "../i18n/i18n.svelte";
import { startOfDay } from "date-fns";

import { getWeekMosaic, markReviewSeen, takeReviewNudge } from "../ipc/review";
import { getSanityCurve } from "../ipc/sanity";
import { getSettings, setSetting } from "../ipc/settings";
import type { MosaicBlock, MosaicState, SanityWeek } from "../ipc/types";
import { groupByCategory } from "../utils/category";
import { pastWeeks } from "../utils/weekcard";
import { prepareOpen, registerPanel } from "./panels.svelte";
import { closeStats, stats } from "./stats.svelte";
import { getWeekDays, shiftWeek, weekOf } from "../utils/week";
import { setExempt as setBlockExempt } from "./blocks.svelte";
import { setTaskExempt } from "./tasks.svelte";
import { goToWeekOf, week } from "./week.svelte";
import { featureOn } from "./settings.svelte";
import { maybeHint } from "./guide.svelte";
import { note } from "./achievements.svelte";

/** 结局 → 人话（图例与悬停都用它；颜色不是唯一通道 —— WCAG G111）。
 *  round53：措辞统一成**正式**的那一套（用户 2026-10-03：「没发生 / 还没到」太不正式）：
 *  按时完成 / 超时完成 / 提前完成 / 未完成 / 未执行（时间已过、既没做也没标记）/ 计划中（还没到） */
/** 结局 → 人话（图例与悬停都用它；颜色不是唯一通道 —— WCAG G111）。
 *  round53：措辞统一成**正式**的那一套（用户 2026-10-03：「没发生 / 还没到」太不正式）：
 *  按时完成 / 超时完成 / 提前完成 / 未完成 / 未执行（时间已过、既没做也没标记）/ 计划中（还没到）
 *  round74（3.0b₂）：从常量表改成**函数** —— 不然切语言后这几句不会跟着变。 */
export function mosaicText(state: MosaicState): string {
  switch (state) {
    case "done":
      return t("msg.review.01");
    case "done_overtime":
      return t("msg.review.02");
    case "done_short":
      return t("msg.review.03");
    case "missed":
      return t("msg.review.04");
    case "unused":
      return t("msg.review.05");
    case "planned":
      return t("msg.review.06");
  }
}

/** 图例/统计时的固定顺序（与 Rust 的常量一一对应） */
export const MOSAIC_STATES: MosaicState[] = [
  "done",
  "done_overtime",
  "done_short",
  "missed",
  "unused",
  "planned",
];

export const review = $state<{
  /** 正在看的那一周的方块（还没拉到 → null；一次 fetch 就把这一周拿全，明细用的是同一份） */
  week: MosaicBlock[] | null;
  /** `week` 属于哪一周（本地周一零点）—— 翻周后用它判断要不要重拉 */
  loadedFrom: number;
  /** 上周的方块（「对比：上周」开着才有） */
  lastWeek: MosaicBlock[] | null;
  /** 上周的曲线（同上；round54 的「同一把尺」靠它：占用/事实都要两周各自一份） */
  lastEnergy: SanityWeek | null;
  /** 面板开着吗 */
  open: boolean;
  /** round78（3.1b₂ · 栈-10）：拉数据失败了吗（失败态要有「重试」——不能只留一句“没读出来”） */
  failed: boolean;
  /** `state` = 按状态（默认）；`category` = 按类别 */
  mode: "state" | "category";
  /** 对比基线（**周数**）：0 = 关闭；1 = 上周；2 = 上上周；4 = 4 周前。
   *  round63（C18）：取代原来的 `compare: boolean`（裸开关）—— 对比得是显式的「本周 vs X」。
   *  会话内记忆（与原来的勾选一样，不落设置）。 */
  baselineWeeks: number;
  /** 明细在说哪一天（本地零点；null = 还没选） */
  day: number | null;
}>({
  week: null,
  loadedFrom: 0,
  lastWeek: null,
  lastEnergy: null,
  open: false,
  failed: false,
  mode: "state",
  baselineWeeks: 0,
  day: null,
});

/** 对比基线的上限（周）—— 再往前就没意义了（应用全部数据也就这么久）；防止一直点变成天文数字 */
export const MAX_BASELINE_WEEKS = 520;

/** 基线的**相对说法**（1 → 上周；2 → 上上周；再往前就说几周前）——面板对 ≥3 周会用日期代替显示 */
export function baselineLabel(weeks: number): string {
  switch (weeks) {
    case 1:
      return t("msg.review.07");
    case 2:
      return t("msg.review.08");
    default:
      return tn("msg.review.09", weeks, { weeks: weeks });
  }
}

let loadSeq = 0;
let lastWrittenSeq = 0;

/**
 * 把这一周（以及开着对比时的那一周）拉回来。失败只记日志 —— 绝不能连累时间轴本身。
 * round54（9.2）：对比要**同一把尺** → 基线周除了方块，还要它的曲线（占用/事实两边各拉一次）。
 * round63（C18）：基线可以是 N 周前（不再是写死的「上一周」）。
 */
export async function loadMosaic(): Promise<void> {
  const from = week.from;
  const seq = ++loadSeq;
  const baseWeeks = review.baselineWeeks;
  const wantCompare = baseWeeks > 0;
  const baseFrom = shiftWeek(from, -baseWeeks);
  try {
    const [data, prev, prevEnergy] = await Promise.all([
      getWeekMosaic(from),
      wantCompare ? getWeekMosaic(baseFrom) : Promise.resolve(null),
      wantCompare ? getSanityCurve(baseFrom) : Promise.resolve(null),
    ]);
    // 这一份不是当前视图要的 → 丢（翻周时会同时有几个请求在飞）
    if (from !== week.from) return;
    // 窗口对，但还是旧的（更晚发起的那次已经写进去了）→ 丢
    if (seq < lastWrittenSeq) return;
    review.week = data;
    review.loadedFrom = from;
    review.lastWeek = wantCompare ? prev : null;
    review.lastEnergy = wantCompare ? prevEnergy : null;
    review.failed = false;
    lastWrittenSeq = seq;
  } catch (err) {
    console.error("[review] 拉这一周的复盘数据失败（界面照常）", err);
    // round78（3.1b₂ · 栈-10）：失败要说出来（面板里给「重试」），不能永远卡在“正在读…”
    // round79（78-08）：还要**清掉陈旧的那一周** —— 否则旧数据（很可能是**别的周**的）会被当成本周的
    // 马赛克画出来，而且 `review.week !== null` 会让「重试」根本不出现（实测：全量跑时被 `round79 ③` 抳到）。
    review.week = null;
    review.lastWeek = null;
    review.lastEnergy = null;
    review.failed = true;
  }
}

/** 某一周的七个本地零点（与后端 `local_day_start` 同一口径；`getWeekDays` 用日期加法）—— 只在文件内用 */
function dayStartsOf(from: number): number[] {
  return getWeekDays(from).map((d) => Math.floor(d.getTime() / 1000));
}

/** 正在看的那一周的七个本地零点 */
export function dayStarts(): number[] {
  return dayStartsOf(week.from);
}

/** 面板该聚焦哪一天：今天（在本周时）→ 否则周一。`dayStarts()` 每次都按当前周算 */
export function defaultDay(): number {
  const days = dayStarts();
  const today = Math.floor(startOfDay(new Date()).getTime() / 1000);
  return days.includes(today) ? today : days[0];
}

/** 打开面板（可选指定聚焦哪一天：点 ⚠ → 第一个超载天；点日头小条 → 那天）
 *
 *  round53（验收回修）：两处都改了 ——
 *  ① **每次都重拉**（以前「同一周只拉一次」→ 面板关着时拖了块、再打开还是旧快照，用户实测到）；
 *  ② 默认天**每次都归位**（今天在本周就是今天；否则周一）—— 不再默默记住上次看的那一天
 *     （用户问「我没点日头，为什么下面还有某天的块」）。*/
export function openReview(day?: number) {
  // round64（C10）：总览开关关掉 → 不开面板（入口本来就不出现，这是第二道）
  if (!featureOn("review_enabled")) return;
  prepareOpen("review"); // round78（栈-01）：同级开口 → 先把别的同级/子层关掉
  review.open = true;
  review.day = day ?? defaultDay();
  void maybeHint("review"); // round64：第一次打开总览 → 教学提示
  void note("review"); // round68（19.1）：暗章信号
  void markSeen(week.from);
  void loadMosaic();
}

export function closeReview() {
  review.open = false;
  // round82（11.5）：统计若是**作为总览子层**开着的，跟着一起关 —— 子层不能比父层活得久。
  // （从顶栏独立开的统计是同级面板，不归总览管。）
  if (stats.open && stats.asChild) closeStats();
}

// round78（栈-01）：把「怎么开关」注册给面板栈（单向依赖：store → panels，不成环）
registerPanel({ id: "review", kind: "sibling", isOpen: () => review.open, close: () => (closeReview(), true) });

/** 数据是不是这一周的；不是就重拉 + 把选中的那天拉回本周 */
export function ensureMosaic() {
  const sameWeek = review.loadedFrom === week.from && review.week !== null;
  if (!sameWeek) {
    review.day = defaultDay();
    void loadMosaic();
    return;
  }
  if (review.day === null || !dayStarts().includes(review.day)) review.day = defaultDay();
}

/** 按天分堆（状态视图；一周七天都出现，空的那天也占一行）。
 *  `list` 默认本周；**「比上周」那一排要把 `from` 也换成上周的周一起点** ——
 *  否则拿本周的七天去分组，上周的方块会全部落空（实测抓到，`上周方块=0/106`）。 */
export function mosaicDays(
  list: MosaicBlock[] | null = review.week,
  from: number = week.from,
): { day_start: number; blocks: MosaicBlock[] }[] {
  const all = list ?? [];
  return dayStartsOf(from).map((day_start) => ({
    day_start,
    blocks: all.filter((b) => b.day_start === day_start),
  }));
}

/**
 * 按类别分堆（类别视图）。**直接复用 `utils/category.ts` 的口径** ——
 * `MosaicBlock` 有 `id` + `category`，结构性满足那边的 `Categorized`（那个类型就是为 C7 留的）。
 */
export function mosaicCategories(list: MosaicBlock[] | null = review.week): {
  name: string | null;
  blocks: MosaicBlock[];
}[] {
  return groupByCategory(list ?? []).map((g) => ({ name: g.name, blocks: g.tasks }));
}

/** 某一天的块（明细面板的数据源 —— 与马赛克同一份，不另拉） */
export function blocksOfDay(dayStart: number): MosaicBlock[] {
  return (review.week ?? []).filter((b) => b.day_start === dayStart);
}

/** 「本周未完成」= 残影（标过 ✗ 或漂流留下的）；`unused` 不算（那是「没用上」，两回事） */
export function missedBlocks(): MosaicBlock[] {
  return (review.week ?? []).filter((b) => b.mosaic_state === "missed");
}

/** 这一周**真出现过**的结局（图例只列出现过的，免得列一堆本周没数据的档）
 *  ⚠️ **不能**往 `review.week` 上 push（那是 `$state` 数组）—— 既会改掉 store、又会在派生计算里
 *  报 `state_unsafe_mutation`（实测抓到；`week` 会被上周的块污染）。 */
export function statesPresent(): MosaicState[] {
  const seen = new Set<MosaicState>();
  for (const b of review.week ?? []) seen.add(b.mosaic_state);
  if (review.baselineWeeks > 0) for (const b of review.lastWeek ?? []) seen.add(b.mosaic_state);
  return MOSAIC_STATES.filter((s) => seen.has(s));
}

/** 选对比基线（0 = 关闭；否则 1..=MAX 周前——**不是只有几个预设**，‹ › 可以逐周步进到任意一周） */
export function setBaseline(weeks: number) {
  const valid = weeks >= 1 && weeks <= MAX_BASELINE_WEEKS ? Math.floor(weeks) : 0;
  review.baselineWeeks = valid;
  if (valid > 0) void loadMosaic();
  else {
    review.lastWeek = null;
    review.lastEnergy = null;
  }
}

/** 逐周步进对比基线（`delta` = +1 更早、-1 更近）——最小停在「上周」，关掉走 `setBaseline(0)` */
export function stepBaseline(delta: number) {
  const next = review.baselineWeeks + delta;
  if (next < 1 || next > MAX_BASELINE_WEEKS) return;
  setBaseline(next);
}

/**
 * 明细行里的 `⊘`：**临时块**走它自己的块级开关，**普通块**走任务级开关（round48/49 口径）。
 * 失败返回 false（ipc 层已弹 Toast；界面不许假装成功）。
 */
export async function toggleExempt(block: MosaicBlock): Promise<boolean> {
  try {
    if (block.is_temp) await setBlockExempt(block.id, !block.exempt);
    else await setTaskExempt(block.task_id, !block.exempt);
  } catch {
    return false;
  }
  await loadMosaic(); // 计入与否变了 → 这一周的数据 + 曲线一起刷新
  return true;
}

// ---------------------------------------------------------------- 面板的「往期」（round58 / 0.13.1）

/**
 * 往期列表：**最近 12 周（含本周）**，新 → 旧。
 * 锚点是**今天那一周**（不是你正在看的那一周）—— 这样往前翻过的周也能走回来。
 * 口径在 `utils/weekcard.ts::pastWeeks`（纯函数 + 单测）。
 */
export function pastWeekList(): number[] {
  const today = weekOf(Math.floor(Date.now() / 1000)).from;
  return pastWeeks(today);
}

/** 在某一周打开总览（到点提醒的「直接打开」档 / 面板底部的往期 chip 都走它）：
 *  先把时间轴切过去（「正在看的那一周」只有一份），再开面板。 */
export function openReviewAt(weekStart: number) {
  if (weekStart !== week.from) {
    goToWeekOf(weekStart);
    review.loadedFrom = 0;
    review.week = null; // 强制重拉
  }
  openReview();
}

// ---------------------------------------------------------------- 周复盘提醒（评审反馈 #1）

/** 提醒状态（`show` = 头部那条轻提示要不要画） */
export const nudge = $state<{ show: boolean; weekStart: number; at: string }>({
  show: false,
  weekStart: 0,
  at: "",
});

/** 提醒设置（`⚙` 里改；对应后端 `review_remind` / `review_remind_at` 两个键） */
export const remindSettings = $state<{
  /** round57（0.13.0）：旧的「提醒开关」换成三选一 —— `open` 直接开总览 / `hint` 只提醒 / `off` 什么都不做 */
  action: "open" | "hint" | "off";
  day: "sun" | "mon";
  time: string;
}>({
  action: "off", // round69.1（#12）：新默认什么都不做（旧默认「只提醒」每周来一次，你说骚扰）
  day: "sun",
  time: "20:00",
});

/**
 * 到点了吗 —— 失败只记日志，绝不影响别的。
 *
 * `trigger`（round57）：
 * - `"tick"` = 分钟轮询（**干活中**）→ 只会出「轻提示」；
 * - `"return"` = 启动 / 窗口重新获得焦点（**回到应用**）→ 「直接打开」档在这一次触发。
 *
 * 为什么这么分：抢屏弹窗会把人从手头的事上拽走（NN/g《Modal & Nonmodal》），
 * 所以「把总览自己打开」只在你回到应用时发生，不在你敲字敲到一半的时候（plan §三-7）。
 */
export type NudgeTrigger = "tick" | "return";

export async function checkNudge(trigger: NudgeTrigger = "tick"): Promise<void> {
  // round64（C10）：总览开关关掉 → 不取水位线、不提、不自动打开（免得推着一条看不见的提醒走）
  if (!featureOn("review_enabled")) return;
  try {
    const action = remindSettings.action;
    if (action === "off") return;
    if (action === "open" && trigger !== "return") return;
    const n = await takeReviewNudge();
    if (!n) return;
    if (action === "open") {
      openReviewAt(n.week_start);
      return;
    }
    nudge.show = true;
    nudge.weekStart = n.week_start;
    nudge.at = n.at;
  } catch (err) {
    console.error("[review] 读复盘提醒失败（界面照常）", err);
  }
}

/** 收掉这条提示（这一周不再提 —— 水位线在后端已经推过了） */
export function dismissNudge() {
  nudge.show = false;
}

/** 看过某一周 → 水位线推过去 + 收掉对应提示 */
async function markSeen(weekStart: number): Promise<void> {
  if (nudge.show && nudge.weekStart === weekStart) nudge.show = false;
  try {
    await markReviewSeen(weekStart);
  } catch (err) {
    console.error("[review] 记「这一周看过了」失败（界面照常）", err);
  }
}

/** 启动时读一次提醒设置（缺省值与后端对齐） */
export async function loadRemindSettings(): Promise<void> {
  try {
    const s = await getSettings();
    const action = (s.values["review_action"] ?? "off").trim();
    // round69.1（6b P2-7）：与后端 `action_setting` 同口径 —— 非法值回退**新默认**（什么都不做），
    // 旧写法回退 "hint" 会把面板显示成与后端相反的一档。
    remindSettings.action = action === "open" || action === "hint" ? action : "off";
    const raw = (s.values["review_remind_at"] ?? "sun 20:00").trim().toLowerCase();
    const [day, time] = raw.split(" ");
    remindSettings.day = day === "mon" ? "mon" : "sun";
    remindSettings.time = /^\d{1,2}:\d{2}$/.test(time ?? "") ? time : "20:00";
  } catch (err) {
    console.error("[review] 读提醒设置失败（用默认值）", err);
  }
}

/** 存提醒设置（两个键一起写；失败返回 false，控件拨回） */
export async function saveRemindSettings(
  action: "open" | "hint" | "off",
  day: "sun" | "mon",
  time: string,
): Promise<boolean> {
  try {
    await setSetting("review_action", action);
    await setSetting("review_remind_at", `${day} ${time}`);
  } catch (err) {
    console.error("[review] 存复盘提醒设置失败（控件拨回）", err);
    return false;
  }
  remindSettings.action = action;
  remindSettings.day = day;
  remindSettings.time = time;
  nudge.show = false;
  void checkNudge(); // 改完重判一次（选「什么都不做」就不出现；改到当下已过点则会冒出来）
  return true;
}
