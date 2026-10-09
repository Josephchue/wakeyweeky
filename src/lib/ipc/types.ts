/** 与后端数据模型（src-tauri/src/db.rs 的 Task / Block）字段一一对应，保持 snake_case。 */

type BlockStatus = "planned" | "done" | "missed";

/** 两层结构（C1.4）：必填 / 弹性；遗留的 suggested 由 004 迁移并入 elastic */
export type BlockLayer = "required" | "elastic";

export type Task = {
  id: string;
  title: string;
  category: string | null;
  created_at: number;
  /** 1 = 弹性任务：其生成的块默认进弹性层 */
  is_elastic: number;
  estimated_minutes: number | null;
  /** 非空 = 已归档（保留痕迹，替代删除） */
  archived_at: number | null;
  /**
   * round48：「这条任务不计入理智值」（**任务级** —— 用户 2026-10-03 拍板：由任务决定，不由时间块决定）。
   * 它的**所有**块都不进每天的占用；块上只显示一个 `⊘` 记号（0.10.0 起块上不再有那个开关）。
   */
  sanity_exempt: boolean;
  /** round48：Backlog 的手动顺序（越小越靠上）；新建任务排在最上 */
  sort_order: number;
};

/** 提醒优先级（后端算好，前端只读 —— v2 ⑦ 的「唯一实现」原则）；C1.4 起两档 */
export type BlockPriority = "high" | "low";

export type Block = {
  id: string;
  task_id: string;
  start_at: number;
  end_at: number;
  status: BlockStatus;
  last_notified_at: number | null;
  created_at: number;
  layer: BlockLayer;
  /** 非空 = 来自 .ics 的外部占用块（只读） */
  external_source: string | null;
  /** 终态细分：done_overtime / done_short */
  final_status: string | null;
  /** 漂流后续块：指向被顺延的那个残影的 id（空 = 普通块） */
  postponed_from: string | null;
  /** C1.8（R33）临时安排块自己的名字（普通块为 null → 显示任务名） */
  label: string | null;
  /** round45：不计入理智值（块上第 5 个图标 ⊘；默认 false = 计入） */
  sanity_exempt: boolean;
  /** C1.8（R33）**派生字段**：是不是临时安排块（挂在全局隐藏任务上；由后端算好，前端不猜） */
  is_temp: boolean;
  /** 派生字段：提醒优先级（由后端根据层与外部来源算出） */
  priority: BlockPriority;
  /**
   * round69（B3）**派生字段**：来自哪条每周重复（如「每周三 19:00」；普通块为 null）——
   * 时间轴上的 `🔁` 标靠它（只在 `list_blocks` 那条读路径上补，不落库）。
   */
  repeat_note: string | null;
};

/** 改块（含时间）的结果：新块 + 被顺延的后续链节数 + 其中历史的个数（C3.2） */
export type MoveOutcome = {
  block: Block;
  cascaded: number;
  history_moved: number;
  /**
   * round27：没融合时后端给的**原因**（`drift` / `sequence` / `cap`，没情况就是 null）。
   * 用户实测「同一个任务的两块拖到一起却没融合」—— 规则该说清楚，不让人猜。
   */
  merge_hint: string | null;
  /** round31（C1.9）：这次操作**真的融合吃掉了一块**（前端据此弹「已合并两块」；后端说了算） */
  merged: boolean;
};

/** 建块的结果（round31）：`create_block` 落库后也会融合（可能返回幸存者，不是刚建的那行） */
export type CreateOutcome = {
  block: Block;
  merged: boolean;
};

/**
 * round69（B3）：**复制手势**要用的一份"新块规格" —— 任务 / 时段 / 层 / 可选的名字与 ⊘。
 * 后端 `create_blocks` 逐块落库（一次 record = 一步撤销）；状态一律从 `planned` 开始。
 */
export type CopySpec = {
  task_id: string;
  start_at: number;
  end_at: number;
  layer: BlockLayer;
  label?: string | null;
  sanity_exempt?: boolean;
};

/** round69.1（#2 / D1）：复制落地的结果（后端 `CopyOutcome`）——
 *  `blocks` = 存活块（就地融合时是原来那一块，已去重）；`merged` > 0 说明有副本没多出来 */
export type CopyOutcome = {
  blocks: Block[];
  created: number;
  merged: number;
};

/** round61（10.2 多选）：批量动作的汇总结果（后端 `BatchOutcome`）—— 前端据此弹一条汇总提示 */
export type BatchOutcome = {
  /** 真正被改动的块数（跳过与失败的都不算） */
  changed: number;
  /** 整批合计**顺延**的后续链节数 */
  cascaded: number;
  /** 其中「历史（已完成/未完成）」被挪动的个数 */
  history_moved: number;
  /** 触发融合的块数（>0 时弹「已合并」） */
  merged: number;
  /** 没动成的块数（不存在 / 已标记不能挪 / 序列顺序约束等） */
  failed: number;
};

/** 序列里的一节：块 id + 它在链上的位置 */
type SequenceMember = {
  block_id: string;
  /** 链上第几环（0 起）。**两节同号** = 残影与它漂出去的新块共享同一环 */
  order_index: number;
};

/**
 * round69（B3）：一条**每周重复**的规则（任务级；`create_repeat` 的返回）。
 * 时长不在规则里 —— 生成时读任务的「预估」（与拖任务出来建块同一条口径）。
 */
export type Repeat = {
  id: string;
  task_id: string;
  /** 0 = 周一 … 6 = 周日 */
  weekday: number;
  /** 相对当天 00:00 的分钟（0..1439） */
  start_min: number;
  layer: BlockLayer;
  enabled: boolean;
  created_at: number;
};

/** 任务序列（C3）：用户显式接起来的若干块 */
export type Sequence = {
  id: string;
  name: string;
  created_at: number;
  /** 成员（按链上顺序；同环的按时间先后） */
  members: SequenceMember[];
  /** C1.6：窗口外还有成员吗（界面据此出「周界续接」提示） */
  has_prev_week: boolean;
  has_next_week: boolean;
};

/** C6（round44）：某一天的耗能 —— `get_sanity_curve` 的一天 */
export type SanityDay = {
  /** 本地零点（秒） */
  day_start: number;
  /** 占用分钟（**并集**：重叠/并排只算一次，按本地日切分） */
  minutes: number;
  budget: number;
  /** 占预算的百分比（>100 照实给，界面上画的时候再截） */
  energy_pct: number;
  /** 平静 / 接近 / 超载 */
  state: "calm" | "near" | "over";
  blocks: number;

  rearranged: number;
  skipped: number;
};

/** C6（round44）：一周的理智值曲线（算法全在 Rust `sanity.rs`，前端只画） */
export type SanityWeek = {
  week_start: number;
  week_end: number;
  /** 今天在这一周里的下标；-1 = 今天不在这里 */
  today_index: number;
  worst_state: "calm" | "near" | "over";
  budget: number;
  /** 用户在设置里关掉了吗（关掉后界面不画、托盘不进超载） */
  enabled: boolean;
  days: SanityDay[];
};

/** C7（round52）：一块的「结局」（算法在 Rust `review.rs`；这里只负责画） */
export type MosaicState =
  | "done"
  | "done_overtime"
  | "done_short"
  | "missed"
  | "unused"
  | "planned";

/** C7（round52）：马赛克里的一个方块 —— **同时是 R46 明细面板的一行**（同一份数据、两处 UI） */
export type MosaicBlock = {
  id: string;
  task_id: string;
  /** 任务名（临时块 = 隐藏任务的名字「临时安排」） */
  title: string;
  /** 临时块自己的名字 → 显示名 = `label ?? title` */
  label: string | null;
  category: string | null;
  is_temp: boolean;
  start_at: number;
  end_at: number;
  layer: BlockLayer;
  mosaic_state: MosaicState;
  /** 画在**哪一天**（本地零点）：跨周块伸进来的第一段所在那天 */
  day_start: number;
  /** 计入理智值吗（任务级 / 临时块自己的；与曲线同一套判定） */
  exempt: boolean;
  /** 挪过几次（**事实**，不进算术；>=2 才是曲线上那条「挪过」） */
  rearranged: number;
  /** 标过没做完（**事实**） */
  skipped: boolean;
};

/** C7（round52）：周复盘提醒（`take_review_nudge` 的返回；`null` = 不到点 / 关掉了 / 这周已提过） */
export type ReviewNudge = {
  /** 要复盘的那一周（本地周一零点）—— 周日设的时刻 = 本周；周一设的 = 上一周 */
  week_start: number;
  /** 生效的提醒时刻（规范写法，如 `"sun 20:00"`） */
  at: string;
};

/** 10.1 统计页（round60）：近 12 周的一行 —— **只含有事件的周**（数值可以是 0） */
type StatsWeekRow = {
  week_start: number;
  done: number;
  missed: number;
  postponed: number;
};

/** round82（统-03）：每日完成趋势的一行（本地日 00:00；**旧 → 新**，0 值照摆） */
type StatsDayRow = {
  day: number;
  done: number;
};

/** round82（统-07）：分类分布的一行；`category` 空串 = 「早期数据（无分类）」（永远排最后） */
type StatsCategoryRow = {
  category: string;
  done: number;
  /** 计划时长（分钟；没记录的那几条不进这里） */
  minutes: number;
};

/** 10.1 统计页（round60）：全时段累计（算法全在 Rust `stats.rs`，前端只画） */
export type Stats = {
  /** 最早一条事件的时刻（一条都没有 → null） */
  first_event_at: number | null;
  /** 有事件的本地日数 */
  active_days: number;
  /** 事件总数（含未知类型） */
  total_events: number;
  complete: number;
  skip: number;
  /** 完成率百分比；**分母 0 → null**（显示「—」，不编 0%） */
  rate_pct: number | null;
  created: number;
  /** 其中「临时安排块」 */
  created_temp: number;
  moved: number;
  stretched: number;
  postponed: number;
  /** 序列/漂移把后面的环连带挪走（自动顺延） */
  cascaded: number;
  deleted: number;
  merged: number;
  linked: number;
  unlinked: number;
  done_minutes: number;
  /** 其中**有时长记录**的完成条数（< complete 时界面说明口径） */
  done_timed: number;
  /** round82（统-03）：近 14 天每日完成数（**旧 → 新**，0 值照摆） */
  trend: StatsDayRow[];
  /** round82（统-04）：按时完成条数（`delay_minutes ≤ minutes + 15`，与块上的「超时」同一条线） */
  on_time: number;
  /** 按时率的分母：**同时有** minutes 与 delay_minutes 的完成（老账缺字段 → 不进分母） */
  rated: number;
  /** 按时率百分比；分母 0 → null（显示「—」，不编 0%） */
  on_time_pct: number | null;
  /** round82（统-05）：平均单块（计划）分钟；没有时长记录 → null */
  avg_minutes: number | null;
  /** round82（统-06）：当前连续（到昨天为止；今天还没完成不算断） */
  streak_now: number;
  /** 历史最长连续（自然日；一条完成都没有 → 0） */
  streak_best: number;
  /** round82（统-07）：分类分布（时长降序；无分类永远最后一栏） */
  categories: StatsCategoryRow[];
  /** 近 12 周（**新 → 旧**；只列有事件的周） */
  weeks: StatsWeekRow[];
};

/** v2 ④：设置项（键 → **生效值**；缺省时后端已经把默认值填好了） */
export type Settings = {
  values: Record<string, string>;
};

/** round68（19.1）：一枚暗章 —— 未点亮时后端把 name/desc 换成 `???`（照 MAA） */
export interface AchievementRow {
  id: string;
  name: string;
  desc: string;
  cond: string;
  progress: number;
  target: number;
  unlocked: boolean;
  unlocked_at: number | null;
  /** 0 = 普通；1 = ★ 稀有；2 = ★★ 传说 */
  tier: number;
  group: string;
  hidden: boolean;
}

/** round68（19.1）：暗章面板数据（round85 起：唯一版本恒可用，不再有 Lite 档） */
export interface AchievementList {
  unlocked: number;
  total: number;
  rows: AchievementRow[];
}
