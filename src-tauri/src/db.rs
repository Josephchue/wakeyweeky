use std::path::Path;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::notify::priority;
use crate::i18n;
use crate::tf;

/// 任务（Backlog 中的待办）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub category: Option<String>,
    pub created_at: i64,
    /// 弹性任务（v2 ⑧B7）：为 1 时其生成的块默认进弹性层
    pub is_elastic: i64,
    pub estimated_minutes: Option<i64>,
    /// 归档时间；非空 = 已归档（替代删除，保留历史痕迹）
    pub archived_at: Option<i64>,
    /// round48：「这条任务不计入理智值」（**任务级** —— 用户 2026-10-03 拍板：由任务决定，不由时间块决定）。
    /// 它的**所有**块都不进每天的占用。
    pub sanity_exempt: bool,
    /// round48：Backlog 的**手动顺序**（越小越靠上）；新建任务 = 当前最小值 − 1（排最上）。
    pub sort_order: i64,
}

/// 任务块（时间轴上的实例）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Block {
    pub id: String,
    pub task_id: String,
    pub start_at: i64,
    pub end_at: i64,
    pub status: String,
    pub last_notified_at: Option<i64>,
    pub created_at: i64,
    /// 两层结构（C1.4）：`required`（必填）/ `elastic`（弹性）；遗留的 `suggested` 由 004 迁移并入 `elastic`
    pub layer: String,
    /// 来自 .ics 的块（只读、灰色、层固定 required）
    pub external_source: Option<String>,
    /// 终态细分：done_overtime / done_short（展示时取 COALESCE(final_status, status)）
    pub final_status: Option<String>,
    /// 漂流后续块：指向「被顺延的那个残影」的 id（软关联，无外键）
    pub postponed_from: Option<String>,
    /// C1.8（R33）临时安排块自己的名字（普通块的 `label` 为 NULL → 显示任务名）
    pub label: Option<String>,
    /// round45（0.8.1）：**不计入理智值**（块上第 5 个图标 `⊘`；默认 false = 计入）
    pub sanity_exempt: bool,
    /// **派生字段（不落库）**：是不是临时安排块（挂在全局隐藏任务上）——
    /// 前端据此显示「临时安排」、斜体、双击改名。round28 #2：以前**没人赋值**（TS 类型里有、
    /// TaskBlock 也在用，Rust 侧却没有）→ 真应用里临时块的名字落到 `taskTitle ?? "?"` ✗。
    pub is_temp: bool,
    /// **派生字段（不落库）**：由 `layer` / `external_source` 算出的提醒优先级（v2 ⑦）
    pub priority: String,
    /// **派生字段（不落库）**：来自哪条每周重复（如「每周三 19:00」；普通块为 `None`）——
    /// round69（B3）时间轴上的 `🔁` 标靠它；只在 `list_blocks` 读路径上补（`attach_repeat_notes`）。
    pub repeat_note: Option<String>,
}

pub(crate) fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// 迁移清单：版本号 + SQL（编译期内嵌，发布后不依赖外部文件）。
/// 读一个任务（不存在返回 None）
pub fn load_task(conn: &Connection, id: &str) -> Result<Option<Task>, String> {
    conn.query_row(
        "SELECT id, title, category, created_at, is_elastic, estimated_minutes, archived_at, sanity_exempt, sort_order \
         FROM tasks WHERE id = ?1",
        [id],
        row_to_task,
    )
    .optional()
    .map_err(|e| tf!(i18n::msg::ERR_DB_01, e = e))
}

/// 改任务属性（v2 ④ 的 `update_task(id, patch)`）：`title` / `category` / `estimated_minutes` / `is_elastic`。
/// （round48 的「不计入理智值」**不在这里** —— 它是独立命令 `set_task_exempt`：撤销提示能说清、
/// 托盘超载态要立刻跟着变。）
///
/// **为什么必须补齐它**：规格 ⑧B7 定的是「`is_elastic=1` → 它拖出来的块默认进弹性层」，
/// 而在此之前**没有任何地方能把这个字段设成 1** —— 那条规则永远走不到弹性分支，
/// README 对用户的「弹性任务」承诺也是空的。这是「实现漏了规格」的一个真缺口。
///
/// 空值约定：`category` 传空串 = 清空；`estimated_minutes` 传 0 或负数 = 清空；未传的字段不动。
pub fn update_task(
    conn: &Connection,
    id: &str,
    title: Option<String>,
    category: Option<String>,
    estimated_minutes: Option<i64>,
    is_elastic: Option<bool>,
) -> Result<Task, String> {
    let before = load_task(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_02).to_string())?;

    let title = match title {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(i18n::t(i18n::msg::ERR_DB_03).to_string());
            }
            if trimmed.chars().count() > MAX_TITLE_CHARS {
                return Err(tf!(i18n::msg::ERR_DB_04, MAX_TITLE_CHARS = MAX_TITLE_CHARS));
            }
            trimmed.to_string()
        }
        None => before.title.clone(),
    };

    let category = match category {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        None => before.category.clone(),
    };

    let estimated_minutes = match estimated_minutes {
        Some(value) if value > 0 => {
            if value > 24 * 60 {
                return Err(i18n::t(i18n::msg::ERR_DB_05).to_string());
            }
            Some(value)
        }
        Some(_) => None, // 0 / 负数 = 清空
        None => before.estimated_minutes,
    };

    let is_elastic = match is_elastic {
        Some(true) => 1i64,
        Some(false) => 0i64,
        None => before.is_elastic,
    };

    conn.execute(
        "UPDATE tasks SET title = ?1, category = ?2, estimated_minutes = ?3, is_elastic = ?4 WHERE id = ?5",
        rusqlite::params![title, category, estimated_minutes, is_elastic, id],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_06, e = e))?;

    load_task(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_07).to_string())
}

/// 归档任务（v2 ④ 的 `archive_task`；⑧B8 拍板「归档与删除都要有」）：写 `archived_at`，
/// **不删数据** —— 残影与周报需要不丢痕迹；归档后不再出现在 Backlog（**由视图按 `archived_at` 过滤**，
/// 而 `list_tasks` 仍会返回它 —— 否则时间轴上归档任务的块会变成「?」，见 round28 #2）。
pub fn archive_task(conn: &Connection, id: &str) -> Result<(), String> {
    let affected = conn
        .execute(
            "UPDATE tasks SET archived_at = ?1 WHERE id = ?2",
            rusqlite::params![now(), id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_08, e = e))?;
    if affected == 0 {
        return Err(i18n::t(i18n::msg::ERR_DB_09).to_string());
    }
    Ok(())
}

/// 取消归档（round38 / 任务面板）：把 `archived_at` 清回 `NULL` —— 归档从此**不是单行道**。
///
/// 为什么必须有它：`archive_task` 只有「进」没有「出」—— 归档之后只能手改数据库才能拿回来，
/// 于是用户**不敢用归档**（分不清它和删除）。任务面板的「已归档（N）→ 恢复」走这里。
/// 不碰任何其它列（块、事件、序列都不动）—— 它只是把那个时间戳抹掉。
pub fn unarchive_task(conn: &Connection, id: &str) -> Result<(), String> {
    let affected = conn
        .execute(
            "UPDATE tasks SET archived_at = NULL WHERE id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_10, e = e))?;
    if affected == 0 {
        return Err(i18n::t(i18n::msg::ERR_DB_11).to_string());
    }
    Ok(())
}

/// 分类改名 / 合并 / 清空（8.1 分类管理）—— 一次处理**整个分类**下的所有任务。
///
/// 为什么一个函数管三件事：它们对数据来说是**同一条 SQL**（把一批任务的 `category` 写成新值）——
/// 「合并」= 新名恰好是另一个已有分类（两条分类自然并成一条），
/// 「清空」= 新名传空串（`NULL` = 未分类）。前端只负责把「会发生什么」讲清楚（几个任务、并到哪）。
///
/// **已归档的任务也一起改**：归档只是收起来，不是改名时漏掉它的理由。
/// 返回**实际改了几条** —— 界面上的撤销提示要说清数字（与 `delete_task` 回报块数同一套口径）。
pub fn rename_category(conn: &Connection, from: &str, to: &str) -> Result<usize, String> {
    let from = from.trim();
    if from.is_empty() {
        return Err(i18n::t(i18n::msg::ERR_DB_12).to_string());
    }
    let to = to.trim();
    if to.chars().count() > MAX_CATEGORY_CHARS {
        return Err(tf!(i18n::msg::ERR_DB_13, MAX_CATEGORY_CHARS = MAX_CATEGORY_CHARS));
    }
    // 原地保存（含「 工作 」这种只差首尾空格的）= 什么都不用做（与 update_task 的 trim 口径一致）
    if to == from {
        return Ok(0);
    }
    let next: Option<&str> = if to.is_empty() { None } else { Some(to) };
    conn.execute(
        "UPDATE tasks SET category = ?1 WHERE category = ?2",
        rusqlite::params![next, from],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_14, e = e))
}

/// round48：任务级「不计入理智值」（用户 2026-10-03 拍板：由任务决定，不由时间块决定）——
/// 只改这一列，它**所有**的块都跟着不算（读的地方在 `sanity.rs`；块级那列从此没有读者）。
/// 走命令层 `record` → `Ctrl+Z` 可撤。
pub fn set_task_exempt(conn: &Connection, id: &str, exempt: bool) -> Result<Task, String> {
    let affected = conn
        .execute(
            "UPDATE tasks SET sanity_exempt = ?1 WHERE id = ?2",
            rusqlite::params![if exempt { 1 } else { 0 }, id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_15, e = e))?;
    if affected == 0 {
        return Err(i18n::t(i18n::msg::ERR_DB_16).to_string());
    }
    load_task(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_17).to_string())
}

/// round49：**临时安排块**自己的「不计入理智值」开关（它没有可挂的任务 —— 挂的是那块全局隐藏任务，
/// Backlog 里看不见，所以只能看它自己）。普通块不显示这个键、也不看它（它们看任务那一行）。
/// 只改这一列 —— 不碰融合、不碰级联（一个开关不该让块搬家）；走命令层 `record` → `Ctrl+Z` 可撤。
pub fn set_block_exempt(conn: &Connection, id: &str, exempt: bool) -> Result<Block, String> {
    let affected = conn
        .execute(
            "UPDATE blocks SET sanity_exempt = ?1 WHERE id = ?2",
            rusqlite::params![if exempt { 1 } else { 0 }, id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_18, e = e))?;
    if affected == 0 {
        return Err(i18n::t(i18n::msg::ERR_DB_19).to_string());
    }
    load_block(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_20).to_string())
}

/// round48：Backlog 的**手动顺序**（用户 2026-10-03 提的需求）—— 按给定顺序把 `sort_order` 写成 0..N-1。
///
/// 为什么「按整个顺序重写」而不是「插到某一项前后」：列表本来就是前端渲染的，拖完它就掌握完整顺序，
/// 一次写清最不容易出错（也不会留下空隙）；**未知 id 直接跳过**（界面可能已经过期）。
/// 返回**实际写了几条**（界面上的提示/断言用得上）。
pub fn reorder_tasks(conn: &Connection, ids: &[String]) -> Result<usize, String> {
    let mut stmt = conn
        .prepare("UPDATE tasks SET sort_order = ?1 WHERE id = ?2")
        .map_err(|e| tf!(i18n::msg::ERR_DB_21, e = e))?;
    let mut changed = 0usize;
    for (index, id) in ids.iter().enumerate() {
        changed += stmt
            .execute(rusqlite::params![index as i64, id])
            .map_err(|e| tf!(i18n::msg::ERR_DB_22, e = e))?;
    }
    Ok(changed)
}

/// 新增迁移时，只需在这里追加 ("004", include_str!("../migrations/004_xxx.sql"))。
/// 本版认识的迁移版本号（round62：备份校验用 —— 备份里出现不认识的版本 = 来自更新的版本）
pub fn migration_versions() -> Vec<&'static str> {
    MIGRATIONS.iter().map(|(version, _)| *version).collect()
}

const MIGRATIONS: &[(&str, &str)] = &[
    ("001", include_str!("../migrations/001_init.sql")),
    ("002", include_str!("../migrations/002_phase2_core.sql")),
    ("003", include_str!("../migrations/003_drift_link.sql")),
    ("004", include_str!("../migrations/004_two_layers.sql")),
    ("005", include_str!("../migrations/005_block_label.sql")),
    ("006", include_str!("../migrations/006_sanity_exempt.sql")),
    ("007", include_str!("../migrations/007_task_flags_and_order.sql")),
    ("008", include_str!("../migrations/008_review_note.sql")),
    ("009", include_str!("../migrations/009_templates.sql")),
    ("010", include_str!("../migrations/010_achievements.sql")),
    ("011", include_str!("../migrations/011_repeats.sql")),
];

/// C1.8（R33）临时安排块挂的那个**全局隐藏任务**的固定 id。
/// 它 `archived_at` 非空 → `list_tasks` 天然不列 → Backlog 里永远看不到；
/// 用它当隐藏任务，比「重建 blocks 表去掉 NOT NULL 外键」安全得多（v2 ② 数据模型只追加）。
pub const TEMP_TASK_ID: &str = "ww-temp-hidden-task";
/// 那块隐藏任务在库里的名字（界面上看不到；临时块自己的名字用 `blocks.label`）
const TEMP_TASK_TITLE: &str = i18n::msg::ERR_DB_23;

/// 任务标题长度上限：防止误粘贴整篇文章把库与界面撑坏（200 字符对周计划足够）
const MAX_TITLE_CHARS: usize = 200;
/// 分类名长度上限（8.1）：与前端分类输入框的 `maxlength="40"` 保持一致 —— 改一处必须改另一处。
const MAX_CATEGORY_CHARS: usize = 40;
/// 单个块的时长上限：**3 天（72 小时）**。
/// round25（用户 2026-10-01 拍板：「放宽到好几天，比如最多 3 天」）：原来 24 小时。
/// 跨天/跨周的长块要能表达，但不能吃掉整周（并排布局与顺延都会看不下去）。
/// 与前端 `MAX_BLOCK_HOURS`（`src/lib/utils/timeline.ts`）保持一致 —— 改一处必须改另一处。
const MAX_BLOCK_SECONDS: i64 = 72 * 60 * 60;
/// 单个块的最小时长：15 分钟（v2 ⑧B「最小 15 分钟步进」；拉伸也只能拉到这么短）
const MIN_BLOCK_SECONDS: i64 = 15 * 60;
/// 时间戳上限：约公元 5000 年（挡住荒唐输入，同时保证后续加减不会溢出）
const MAX_TIMESTAMP: i64 = 95_000_000_000;

/// 时段合法性（创建与移动共用）：非负、顺序正确、不超时长上限、不超时间上限。
/// 先判上限再相减，避免 `end - start` 在极端值上溢出。
fn validate_range(start_at: i64, end_at: i64) -> Result<(), String> {
    if start_at < 0 || end_at < 0 {
        return Err(i18n::t(i18n::msg::ERR_DB_24).to_string());
    }
    if end_at <= start_at {
        return Err(i18n::t(i18n::msg::ERR_DB_25).to_string());
    }
    if start_at > MAX_TIMESTAMP || end_at > MAX_TIMESTAMP {
        return Err(i18n::t(i18n::msg::ERR_DB_26).to_string());
    }
    if end_at - start_at < MIN_BLOCK_SECONDS {
        return Err(i18n::t(i18n::msg::ERR_DB_27).to_string());
    }
    if end_at - start_at > MAX_BLOCK_SECONDS {
        return Err(i18n::t(i18n::msg::ERR_DB_28).to_string());
    }
    Ok(())
}

/// 打开（或创建）数据库文件，开启外键约束，并执行未执行的迁移。
pub fn init(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| tf!(i18n::msg::ERR_DB_29, e = e))?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|e| tf!(i18n::msg::ERR_DB_30, e = e))?;
    // 并发健壮性（两条 PRAGMA，无需新依赖）：
    // - WAL：读不阻写、写不阻读（场景：用户不小心开了两个实例，或外部工具在读库）
    // - busy_timeout：偶发占用时自动等 5 秒，而不是立刻报「数据库被占用」
    // 这两条是**优化项**，失败不应阻止启动（例如库正被另一连接占用时切换 WAL 会失败）
    if let Err(e) = conn.pragma_update(None, "busy_timeout", 5_000) {
        eprintln!("[db] 设置 busy_timeout 失败（忽略，继续启动）：{e}");
    }
    if let Err(e) = conn.pragma_update(None, "journal_mode", "WAL") {
        eprintln!("[db] 开启 WAL 失败（忽略，继续用默认日志模式）：{e}");
    }
    migrate(&conn)?;
    // C3.3：清掉历史遗留的空序列（成员 <2 个）。
    // 成因：删块走外键 CASCADE 清掉成员，但序列本身没人删 → 界面看不见的空壳会一直堆着。
    // 放在启动时做一次，是因为外部工具/旧版本删的块不会再经过我们的删除路径。
    if let Err(e) = prune_short_sequences(&conn) {
        eprintln!("[db] 清理空序列失败（忽略，继续启动）：{e}");
    }
    Ok(conn)
}

/// 按版本号顺序执行未执行的迁移。幂等：重复调用不会重复执行。
pub fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version TEXT PRIMARY KEY,
           applied_at INTEGER NOT NULL
         )",
        [],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_31, e = e))?;

    for (version, sql) in MIGRATIONS {
        let applied = conn
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE version = ?1",
                [version],
                |_| Ok(true),
            )
            .optional()
            .map_err(|e| tf!(i18n::msg::ERR_DB_32, e = e))?
            .unwrap_or(false);

        if applied {
            continue;
        }

        let tx = conn
            .unchecked_transaction()
            .map_err(|e| tf!(i18n::msg::ERR_DB_33, e = e))?;
        // 可观测性（C1.4）：记下这条迁移到底动了多少行 —— 004 这类数据迁移只有日志能对账
        let changed_before = conn.total_changes();
        tx.execute_batch(sql)
            .map_err(|e| tf!(i18n::msg::ERR_DB_34, version = version, e = e))?;
        // 只数**数据改动**：紧跟在迁移 SQL 之后取数，不把下面那条记账 INSERT 算进去
        // （第一版写成在 commit 之后取，于是 004 把 23 行数据报成了 24 —— 实际是 23 + 1 行记账）
        let data_changed = tx.total_changes() - changed_before;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            rusqlite::params![version, chrono::Utc::now().timestamp()],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_35, version = version, e = e))?;
        tx.commit()
            .map_err(|e| tf!(i18n::msg::ERR_DB_36, version = version, e = e))?;
        eprintln!("[db] 迁移 {version} 已应用（数据改动 {data_changed} 行）");
    }

    Ok(())
}

// ---------------------------------------------------------------- 任务（tasks）

/// 按创建时间排序返回全部任务（同一秒创建的按 rowid 稳定排序）。
/// 列出**全部**任务（含已归档）。
///
/// round28 #2：以前这里写 `WHERE archived_at IS NULL` —— 于是「归档过的任务」它的块在时间轴上
/// 查不到任务名，只能显示「?」。现在**返回全部**，由视图层决定藏谁：
/// `Backlog.svelte` 只渲染 `archived_at == null` 的（归档任务照样从 Backlog 消失 ✓），
/// 而时间轴按 `task_id` 查名字时能查到（隐藏的临时任务也在其中 → 临时块的名字/斜体靠它+`is_temp`）。
pub fn list_tasks(conn: &Connection) -> Result<Vec<Task>, String> {
    // round48：顺序 = **手动顺序**（`sort_order`），rowid 只做并列时的稳定兑底；
    // 升级时 007 把 sort_order 回填成旧的 `created_at, rowid` 顺序，所以看起来一模一样。
    let mut stmt = conn
        .prepare("SELECT id, title, category, created_at, is_elastic, estimated_minutes, archived_at, sanity_exempt, sort_order FROM tasks ORDER BY sort_order, rowid")
        .map_err(|e| tf!(i18n::msg::ERR_DB_37, e = e))?;
    let rows = stmt
        .query_map([], row_to_task)
        .map_err(|e| tf!(i18n::msg::ERR_DB_38, e = e))?;

    let mut tasks = Vec::new();
    for row in rows {
        tasks.push(row.map_err(|e| tf!(i18n::msg::ERR_DB_39, e = e))?);
    }
    Ok(tasks)
}

pub fn create_task(conn: &Connection, title: &str, category: Option<&str>) -> Result<Task, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(i18n::t(i18n::msg::ERR_DB_40).to_string());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(tf!(i18n::msg::ERR_DB_41, MAX_TITLE_CHARS = MAX_TITLE_CHARS));
    }

    // round48（用户 2026-10-03 拍板）：**新建任务排在最上**（原来排在最下）。
    // 用「当前最小值 − 1」而不是重排全表：只动一行，撤销也只有一步。
    let sort_order: i64 = conn
        .query_row("SELECT COALESCE(MIN(sort_order), 0) - 1 FROM tasks", [], |r| r.get(0))
        .map_err(|e| tf!(i18n::msg::ERR_DB_42, e = e))?;

    let task = Task {
        id: Uuid::new_v4().to_string(),
        title: title.to_string(),
        category: category.map(|c| c.to_string()),
        created_at: now(),
        // 新列均用数据库默认值（v2 ③ 追加式）
        is_elastic: 0,
        estimated_minutes: None,
        archived_at: None,
        sanity_exempt: false,
        sort_order,
    };

    conn.execute(
        "INSERT INTO tasks (id, title, category, created_at, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![task.id, task.title, task.category, task.created_at, task.sort_order],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_43, e = e))?;

    Ok(task)
}

/// 删除任务；其任务块由 ON DELETE CASCADE 自动删除。不存在时幂等返回 Ok。
pub fn delete_task(conn: &Connection, id: &str) -> Result<i64, String> {
    // round40：先数一下会连带删掉多少个块 —— 界面上的「撤销条」要说清楚「毁掉了什么」
    // （调研结论：恢复路径要指明对象；「已删除 ╳」比「已删除」有用）
    let blocks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM blocks WHERE task_id = ?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_44, e = e))?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", [id])
        .map_err(|e| tf!(i18n::msg::ERR_DB_45, e = e))?;
    Ok(blocks)
}

/// 改任务名。校验规则与创建完全一致（去首尾空格 / 非空 / 最多 MAX_TITLE_CHARS）。
/// 时间轴上的块显示的是 JOIN 出来的任务名，所以改完**不需要**动 blocks 表 —— 但调用方要广播刷新。
/// id 不存在时明确报错（不静默成功）。
pub fn rename_task(conn: &Connection, id: &str, title: &str) -> Result<Task, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(i18n::t(i18n::msg::ERR_DB_46).to_string());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(tf!(i18n::msg::ERR_DB_47, MAX_TITLE_CHARS = MAX_TITLE_CHARS));
    }

    let affected = conn
        .execute("UPDATE tasks SET title = ?1 WHERE id = ?2", rusqlite::params![title, id])
        .map_err(|e| tf!(i18n::msg::ERR_DB_48, e = e))?;
    if affected == 0 {
        return Err(i18n::t(i18n::msg::ERR_DB_49).to_string());
    }

    conn.query_row(
        "SELECT id, title, category, created_at, is_elastic, estimated_minutes, archived_at, sanity_exempt, sort_order \
         FROM tasks WHERE id = ?1",
        [id],
        row_to_task,
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_50, e = e))
}

// ---------------------------------------------------------------- 任务块（blocks）

/// 返回 [from, to) 区间内开始的全部任务块（边界：start_at >= from AND start_at < to）。
pub fn list_blocks(conn: &Connection, from: i64, to: i64) -> Result<Vec<Block>, String> {
    // round25⑤（用户实测：「被延到下周的块，在下周看不到」）：**区间相交**语义 ——
    // 起点在窗口之前、尾巴伸进来的块也算这一周的（旧实现按 `start_at >= from` 过滤，把它整个漏掉了 ✗）。
    // 与前端 `layoutDay`（`end_at > dayStart && start_at < dayEnd`）同一套左闭右开规则。
    // round64.1：关掉漂流时，漂流子块当不存在（时间轴 / 理智曲线 / 总览马赛克都走这条）。
    let filter = drift_filter(conn, "")?;
    let sql = format!(
        "SELECT {BLOCK_COLUMNS} FROM blocks WHERE start_at < ?2 AND end_at > ?1{filter} \
         ORDER BY start_at, rowid"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| tf!(i18n::msg::ERR_DB_51, e = e))?;
    let rows = stmt
        .query_map(rusqlite::params![from, to], row_to_block)
        .map_err(|e| tf!(i18n::msg::ERR_DB_52, e = e))?;

    let mut blocks = Vec::new();
    for row in rows {
        blocks.push(row.map_err(|e| tf!(i18n::msg::ERR_DB_53, e = e))?);
    }
    // round69（B3）：补上「来自哪条每周重复」的展示标记（派生字段，不落库）
    attach_repeat_notes(conn, &mut blocks)?;
    Ok(blocks)
}

/// round69（B3）：给这一批块补 `repeat_note`（时间轴上的 `🔁`）。
///
/// 为什么不在 SELECT 里 JOIN：`row_to_block` 服务好几条读路径，改列清单会连带改它们；
/// 这里只看 `repeat_occurrences.block_id`（生成时写的就是**幸存块**的 id），一条 IN 查询就够。
fn attach_repeat_notes(conn: &Connection, blocks: &mut [Block]) -> Result<(), String> {
    if blocks.is_empty() {
        return Ok(());
    }
    let placeholders = (1..=blocks.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    // round69（B3）/ 6b P2：同一块被两条 occurrence 指到时（两条相邻规则融合成一块），
    // 取**最早那条**规则显示 —— 不加 ORDER BY 的话哪条看扫表顺序，不稳定
    let sql = format!(
        "SELECT ro.block_id, r.weekday, r.start_min
         FROM repeat_occurrences ro JOIN repeats r ON r.id = ro.repeat_id
         WHERE ro.block_id IN ({placeholders})
         ORDER BY r.created_at, r.id"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| tf!(i18n::msg::ERR_DB_54, e = e))?;
    let ids = || blocks.iter().map(|b| b.id.clone());
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| tf!(i18n::msg::ERR_DB_55, e = e))?;
    let mut notes: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for row in rows {
        let (id, weekday, start_min) = row.map_err(|e| tf!(i18n::msg::ERR_DB_56, e = e))?;
        notes.entry(id).or_insert_with(|| crate::repeats::note_text(weekday, start_min));
    }
    for block in blocks.iter_mut() {
        if let Some(note) = notes.get(&block.id) {
            block.repeat_note = Some(note.clone());
        }
    }
    Ok(())
}

/// round64.1（验收 #1）：漂流开关关掉时，「漂流产生的子块」（`postponed_from` 非空）视为**不在场** ——
/// 列表 / 提醒 / 托盘 / 合并 / 顺延都不看它们。**只读判定，一行数据不删**：开关开回来原样。
///
/// 判定只此一处（`features::DRIFT` 默认开）；调用方用 `drift_filter()` 拿 SQL 片段。
pub(crate) fn drift_children_hidden(conn: &Connection) -> Result<bool, String> {
    Ok(!crate::features::enabled(conn, crate::features::DRIFT))
}

/// `drift_children_hidden` 的 SQL 片段（拼在 WHERE 尾巴上）：
/// `alias` 传表别名前缀（如 `"b."`；不用别名传 `""`）。
pub(crate) fn drift_filter(conn: &Connection, alias: &str) -> Result<String, String> {
    Ok(if drift_children_hidden(conn)? {
        format!(" AND {alias}postponed_from IS NULL")
    } else {
        String::new()
    })
}

/// 当下是否有**正在进行**的任务块（托盘状态基线用，v2 ⑪ C5）。
/// 「正在进行」= status 为 planned 且 start_at ≤ now ≤ end_at。
/// 已结束但未标记的块**不算**进行中 —— 逾期由提醒（通知）负责，文档不要求托盘表现逾期。
pub fn has_current_block(conn: &Connection, now: i64) -> Result<bool, String> {
    let filter = drift_filter(conn, "")?;
    let sql = format!(
        "SELECT EXISTS(
             SELECT 1 FROM blocks
             WHERE status = 'planned' AND start_at <= ?1 AND end_at >= ?1{filter}
         )"
    );
    conn.query_row(&sql, rusqlite::params![now], |r| r.get::<_, bool>(0))
        .map_err(|e| tf!(i18n::msg::ERR_DB_57, e = e))
}

/// round62（11 一行提示）：当前进行中的块的**显示名 + 结束时刻**。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentHint {
    /// 显示名：临时块自己的 `label` 优先，否则任务名（与前端 `block.label ?? 任务名` 一致）
    pub title: String,
    pub end_at: i64,
}

/// 取「当前进行中的块」（托盘提示 + 窗口标题用，round62）。
///
/// 判定与 `has_current_block` **同口径**（`planned` 且 `start_at <= now <= end_at`，含端点）。
/// 同时有多块在跑时：**必填优先 → 同层开始更早（先来的）→ rowid 兜底**；
/// 名字 = `COALESCE(NULLIF(TRIM(b.label), ''), t.title)`（空 label 回退任务名）。
pub fn current_block_hint(conn: &Connection, now: i64) -> Result<Option<CurrentHint>, String> {
    let filter = drift_filter(conn, "b.")?;
    let sql = format!(
        "SELECT COALESCE(NULLIF(TRIM(b.label), ''), t.title), b.end_at
           FROM blocks b JOIN tasks t ON t.id = b.task_id
          WHERE b.status = 'planned' AND b.start_at <= ?1 AND b.end_at >= ?1{filter}
          ORDER BY CASE WHEN b.layer = 'required' THEN 0 ELSE 1 END, b.start_at, b.rowid
          LIMIT 1"
    );
    conn.query_row(&sql, rusqlite::params![now], |r| {
        Ok(CurrentHint {
            title: r.get(0)?,
            end_at: r.get(1)?,
        })
    })
    .optional()
    .map_err(|e| tf!(i18n::msg::ERR_DB_58, e = e))
}

// ---------------------------------------------------------------- 设置（settings 表）

/// 读一个设置项；不存在返回 None
pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .map_err(|e| tf!(i18n::msg::ERR_DB_59, e = e))
}

/// 写一个设置项（存在则更新，`updated_at` 刷新）
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, now()],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_60, e = e))?;
    Ok(())
}

/// C1.8（R33）：确保那块全局隐藏任务存在（幂等：`INSERT OR IGNORE`，重复调用不会多出一行）
fn ensure_temp_task(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO tasks (id, title, category, created_at, archived_at)\n         VALUES (?1, ?2, NULL, ?3, ?3)",
        rusqlite::params![TEMP_TASK_ID, i18n::t(TEMP_TASK_TITLE), now()],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_61, e = e))?;
    Ok(())
}

/// C1.8（R33）：建一个**临时安排块**（用户双击时间轴空白格）—— 不登记在 Backlog：
/// 挂隐藏任务（`archived_at` 非空 → **Backlog 视图**不列）、名字默认空（界面显示「临时安排」）、**不参与融合**。
pub fn create_temp_block(conn: &Connection, start_at: i64, end_at: i64) -> Result<Block, String> {
    ensure_temp_task(conn)?;
    // 复用 create_block：它会校验时段、写事件、叫醒提醒线程，也会跑一次融合判定（临时块在判定里被排除）
    create_block(conn, TEMP_TASK_ID, start_at, end_at)
}

/// round64（C10）：模板铺骨架用 —— 建一个**临时安排块**，但层与名字按模板来（`create_temp_block` 恒为弹性/无名）。
/// 与 `create_block_inner` 同一套写法，只是 layer / label 由参数给（不跑融合：临时块本来就不融）。
pub fn create_skeleton_block(
    conn: &Connection,
    start_at: i64,
    end_at: i64,
    layer: &str,
    label: Option<&str>,
) -> Result<Block, String> {
    ensure_temp_task(conn)?;
    validate_range(start_at, end_at)?;
    let layer = if layer == "required" { "required" } else { "elastic" }; // 层只认两层（与后端口径一致）
    let block = Block {
        id: Uuid::new_v4().to_string(),
        is_temp: true,
        task_id: TEMP_TASK_ID.to_string(),
        start_at,
        end_at,
        status: "planned".to_string(),
        last_notified_at: None,
        created_at: now(),
        layer: layer.to_string(),
        external_source: None,
        final_status: None,
        postponed_from: None,
        label: label.map(|s| s.to_string()),
        sanity_exempt: false,
        priority: priority::of(layer, None).as_str().to_string(),
        repeat_note: None,
    };
    conn.execute(
        "INSERT INTO blocks (id, task_id, start_at, end_at, status, last_notified_at, created_at,
                            layer, external_source, final_status, postponed_from, label)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            block.id,
            block.task_id,
            block.start_at,
            block.end_at,
            block.status,
            block.last_notified_at,
            block.created_at,
            block.layer,
            block.external_source,
            block.final_status,
            block.postponed_from,
            block.label,
        ],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_62, e = e))?;
    // 统计口径：套用模板也是「放置」——记一条 create（带 temp 标记，与其它临时块一致）
    record_event(
        conn,
        &block.id,
        "create",
        Some(serde_json::json!({ "temp": true, "template": true }).to_string()),
    )?;
    Ok(block)
}

pub fn create_block(
    conn: &Connection,
    task_id: &str,
    start_at: i64,
    end_at: i64,
) -> Result<Block, String> {
    create_block_inner(conn, task_id, start_at, end_at, "elastic", true, None, false, true)
}

/// round64.1（验收 #2）：模板铺出来的块要能**一次**定型层 ——
/// 不走「先建再改层」（那会多记一条事件，统计页会多一个假的「切换层级」）。
pub fn create_block_with_layer(
    conn: &Connection,
    task_id: &str,
    start_at: i64,
    end_at: i64,
    layer: &str,
    log_create: bool,
) -> Result<Block, String> {
    create_block_inner(conn, task_id, start_at, end_at, layer, log_create, None, false, true)
}

/// round69（B3）：**复制手势**落地的块 —— 任务 / 层 / 时长 / `label` / `⊘` 全照来源，
/// 状态一律 `planned`（`create_block_inner` 本来就是新建语义）；`create` 事件带 `copy` 标记。
/// 复制落地的结果：存活的那一块 + 是不是「就地融合」（true = 没多出新块）。
/// round69.1（D1）：复制落点与原块/同类块相接/重叠 → 就地融合成一块（用已有块当幸存者）。
pub struct CopyResult {
    pub block: Block,
    pub merged: bool,
}

/// round69.1（#2 / D1）：复制 = **先只插、再就地融合**，且以**已有块**为基石。
///
/// 为什么不直接走 `create_block_inner(merge=true)`：同起点时 `merge_adjacent` 的平局归「被传进去的那一块」——
/// 传副本会把原块 `DELETE` 掉、id 换掉（round69 6b P1 的现场：历史/提醒挂着旧 id）。
/// 复制的语义是「本来那块不动」→ 所以找到了可融的邻居就**拿它当基石**调 `merge_adjacent`。
pub fn create_copy_block(
    conn: &Connection,
    task_id: &str,
    start_at: i64,
    end_at: i64,
    layer: &str,
    label: Option<&str>,
    sanity_exempt: bool,
) -> Result<CopyResult, String> {
    let copy = create_block_inner(conn, task_id, start_at, end_at, layer, false, label, sanity_exempt, false)?;
    for other in merge_candidates(conn, &copy)? {
        if !merge_blockers(conn, &copy, &other)?.is_empty() {
            continue;
        }
        // round69.1（6b P1-2）：以**已有块**为基石融合（`prefer_base`）—— 副本起点更早时也一样，
        // 否则原块那一行会被 DELETE、id 被换掉（历史/提醒挂旧 id）。
        if let Some(survivor) = merge_adjacent_preferring(conn, &other, true)? {
            return Ok(CopyResult {
                block: survivor,
                merged: true,
            });
        }
    }
    record_event(
        conn,
        &copy.id,
        "create",
        Some(serde_json::json!({ "copy": true, "temp": task_id == TEMP_TASK_ID }).to_string()),
    )?;
    Ok(CopyResult {
        block: copy,
        merged: false,
    })
}

/// round69（B3）：**每周重复**生成的块 —— 与 `create_block_with_layer` 同一条路（含融合判定），
/// 只是 `create` 事件带 `repeat` 标记（统计页只数 create；标记留给排查与将来的细分）。
/// 事件记在**返回的块**上（可能已是融合幸存者）—— 生成路径没有历史包袱，记确定存在的那个 id 更干净。
pub fn create_repeat_block(
    conn: &Connection,
    task_id: &str,
    start_at: i64,
    end_at: i64,
    layer: &str,
) -> Result<Block, String> {
    let block = create_block_inner(conn, task_id, start_at, end_at, layer, false, None, false, true)?;
    record_event(
        conn,
        &block.id,
        "create",
        Some(serde_json::json!({ "repeat": true, "temp": task_id == TEMP_TASK_ID }).to_string()),
    )?;
    Ok(block)
}

/// `create_block` 的本体。`log_create`：用户放置路径记一条 `create` 事件（round60 / 10.1 统计页）；
/// **漂流内部建的块不记**（`postpone_block` 传 false —— 用户的动作是「漂移」，别再算一遍「新建」）。
/// round69（B3）：`label` / `sanity_exempt` 只为**复制与生成**路径开的口（放置路径照旧传 None/false）；
/// `merge` = 落库后要不要跑融合 —— 复制路径传 false（先只插，再由 `create_copy_block` 拿**已有块**当基石融）。
#[allow(clippy::too_many_arguments)] // block 的字段本来就这么多；拆结构体只会让调用处更绕
fn create_block_inner(
    conn: &Connection,
    task_id: &str,
    start_at: i64,
    end_at: i64,
    layer: &str,
    log_create: bool,
    label: Option<&str>,
    sanity_exempt: bool,
    merge: bool,
) -> Result<Block, String> {
    validate_range(start_at, end_at)?;

    // 存在性检查（C1.4 起，层的默认值与任务的 is_elastic 无关了）
    conn.query_row("SELECT 1 FROM tasks WHERE id = ?1", [task_id], |_| Ok(()))
        .optional()
        .map_err(|e| tf!(i18n::msg::ERR_DB_63, e = e))?
        .ok_or_else(|| i18n::t(i18n::msg::ERR_DB_64).to_string())?;

    // C1.4（两层）：默认「弹性」；模板带层时照传（只认 required / elastic，其它值回退弹性）
    let layer = if layer == "required" { "required" } else { "elastic" }.to_string();
    let priority = priority::of(&layer, None).as_str().to_string();
    let block = Block {
        id: Uuid::new_v4().to_string(),
        // round28 #2：派生字段（与 row_to_block 同一口径）—— 临时块靠它显示「临时安排」
        is_temp: task_id == TEMP_TASK_ID,
        task_id: task_id.to_string(),
        start_at,
        end_at,
        status: "planned".to_string(),
        last_notified_at: None,
        created_at: now(),
        layer,
        external_source: None,
        final_status: None,
        postponed_from: None,
        label: label.map(str::to_string),
        // round45：新块默认**计入**理智值（复制/生成路径照来源传）
        sanity_exempt,
        priority,
        repeat_note: None,
    };

    conn.execute(
        "INSERT INTO blocks (id, task_id, start_at, end_at, status, last_notified_at, created_at,
                            layer, external_source, final_status, postponed_from, label, sanity_exempt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            block.id,
            block.task_id,
            block.start_at,
            block.end_at,
            block.status,
            block.last_notified_at,
            block.created_at,
            block.layer,
            block.external_source,
            block.final_status,
            block.postponed_from,
            block.label,
            i64::from(block.sanity_exempt),
        ],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_65, e = e))?;

    // round60（10.1 统计页）：放置就是「新建块」——即使下面马上被融合吃掉，这个动作也真发生过
    // （MC 的 `Items Dropped` 同口径）。临时块（隐藏任务）另带一个标记，统计页给子计数。
    if log_create {
        record_event(
            conn,
            &block.id,
            "create",
            Some(serde_json::json!({ "temp": task_id == TEMP_TASK_ID }).to_string()),
        )?;
    }

    // C1.2：落库后立刻看要不要和旁边同任务同层的块融合（返回的可能不是这一行，而是幸存的那一块）
    // round69.1（D1）：复制路径传 `merge=false` —— 它自己的融合在 `create_copy_block` 里做
    // （那里的平局规则不同：**已有块当幸存者**）。
    if merge {
        if let Some(survivor) = merge_adjacent(conn, &block)? {
            return Ok(survivor);
        }
    }

    Ok(block)
}

/// 删除任务块，并**连同它的全部后代**（顺着它漂出来的子分支）一起删除，避免留下孤儿后续块。
/// 返回实际删除的块数（含自身），供界面明确提示「一起删了几个」。
/// 注意：`events` 里已有的行为记录**保留**（那是复盘用的历史痕迹，不随块删除）。
pub fn delete_block(conn: &Connection, id: &str) -> Result<usize, String> {
    delete_blocks(conn, &[id.to_string()])
}

/// round61（10.2 多选）：**批量删除** —— 与单块同一条路（子树级联、空壳序列清理、环号压实），差别两处：
/// ① 多个 id 的子树**并在一起去重**再删（选中的块可能互为漂流子分支；重复 id 不会重复计数）；
/// ② 整批只记**一条** `delete` 事件（`count` = 实际删掉的块数合计）。
pub fn delete_blocks(conn: &Connection, ids: &[String]) -> Result<usize, String> {
    let mut all: Vec<String> = Vec::new();
    for id in ids {
        collect_subtree(conn, id, 0, &mut all)?;
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| tf!(i18n::msg::ERR_DB_66, e = e))?;
    // 用实际受影响行数计数：不存在的 id 应该返回 0，而不是 1（叶子先收集后删的写法容易搞错）
    let mut deleted = 0usize;
    for bid in &all {
        deleted += tx
            .execute("DELETE FROM blocks WHERE id = ?1", [bid])
            .map_err(|e| tf!(i18n::msg::ERR_DB_67, e = e))?;
    }
    tx.commit().map_err(|e| tf!(i18n::msg::ERR_DB_68, e = e))?;

    // round60（10.1 统计页）：删掉的**块数**（含顺着漂流链一起删的后续）；一次动作记一条。
    // `deleted == 0`（重复删 / 不存在的 id）不记 —— 没有动作发生过。
    if deleted > 0 {
        record_event(
            conn,
            &ids[0],
            "delete",
            Some(serde_json::json!({ "count": deleted }).to_string()),
        )?;
    }

    // C3.3：删块会把它的序列成员关系一起 CASCADE 掉 —— 但序列本身没人删，
    // 于是会留下界面看不见的空壳（实测用户库里堆了 3 个）→ 顺手清一清；
    // C3.5：CASCADE 还会留下**号洞**（0..5,7,11..）→ 把剩下的环号压实
    prune_short_sequences(conn)?;
    renumber_all_sequences(conn)?;

    Ok(deleted)
}

// ---------------------------------------------------------------- 任务序列（C3）

/// 序列里的一节：块 id + 它在链上的位置
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SequenceMember {
    pub block_id: String,
    /// 链上第几节（0 起）。**允许两节同号**：残影与它漂出去的新块共享同一个位置（同一环）
    pub order_index: i64,
}

/// 一条序列 + 它的成员（按链上顺序）
///
/// **为什么位置要显式维护**：序列表达的是「顺序依赖」（用户拍板），而漂移会改变时间 ——
/// 若按时间排，漂出去的一节就会跑到链尾（用户实测反馈的 bug）。
/// 所以：创建时按时间给个初始顺序，之后**只按链接顺序**（延长 = 接在末尾、删除 = 后面的往前补位）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sequence {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub members: Vec<SequenceMember>,
    /// C1.6：窗口外（上一周 / 下一周）还有没有成员 —— 界面据此出「周界续接」提示
    pub has_prev_week: bool,
    pub has_next_week: bool,
}

/// 把位置压实成 0..n-1（**同号的仍保持同号** —— 残影与它漂出去的新块共享位置）
fn renumber_members(tx: &Connection, sequence_id: &str) -> Result<(), String> {
    let mut stmt = tx
        .prepare(
            "SELECT m.block_id, m.order_index FROM sequence_members m JOIN blocks b ON b.id = m.block_id
             WHERE m.sequence_id = ?1 ORDER BY m.order_index, b.start_at, m.rowid",
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_69, e = e))?;
    let rows: Vec<(String, i64)> = stmt
        .query_map([sequence_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| tf!(i18n::msg::ERR_DB_70, e = e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| tf!(i18n::msg::ERR_DB_71, e = e))?;
    drop(stmt);

    let mut last_old: Option<i64> = None;
    let mut next_index: i64 = -1;
    for (block_id, old_index) in rows {
        if last_old != Some(old_index) {
            next_index += 1;
            last_old = Some(old_index);
        }
        tx.execute(
            "UPDATE sequence_members SET order_index = ?1 WHERE sequence_id = ?2 AND block_id = ?3",
            rusqlite::params![next_index, sequence_id, block_id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_72, e = e))?;
    }
    Ok(())
}

/// 读一条序列的成员（按链序；同号按时间）
fn load_members(conn: &Connection, sequence_id: &str) -> Result<Vec<SequenceMember>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.block_id, m.order_index FROM sequence_members m JOIN blocks b ON b.id = m.block_id
             WHERE m.sequence_id = ?1 ORDER BY m.order_index, b.start_at, m.rowid",
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_73, e = e))?;
    let members = stmt
        .query_map([sequence_id], |r| {
            Ok(SequenceMember {
                block_id: r.get(0)?,
                order_index: r.get(1)?,
            })
        })
        .map_err(|e| tf!(i18n::msg::ERR_DB_74, e = e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| tf!(i18n::msg::ERR_DB_75, e = e))?;
    Ok(members)
}

/// 读一条序列（含成员）；不存在返回 `None`
pub fn get_sequence(conn: &Connection, id: &str) -> Result<Option<Sequence>, String> {
    let head: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT id, name, created_at FROM sequences WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| tf!(i18n::msg::ERR_DB_76, e = e))?;

    let Some((id, name, created_at)) = head else {
        return Ok(None);
    };
    Ok(Some(Sequence {
        members: load_members(conn, &id)?,
        id,
        name,
        created_at,
            has_prev_week: false,
        has_next_week: false,
    }))
}

/// 这个块属于哪条序列（没有则 `None`）
pub fn sequence_of_block(conn: &Connection, block_id: &str) -> Result<Option<Sequence>, String> {
    let sequence_id: Option<String> = conn
        .query_row(
            "SELECT sequence_id FROM sequence_members WHERE block_id = ?1",
            [block_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| tf!(i18n::msg::ERR_DB_77, e = e))?;

    match sequence_id {
        Some(id) => get_sequence(conn, &id),
        None => Ok(None),
    }
}

/// 这个块在链上的位置（序列 id + 位置）；没有则 `None` —— 漂移时用它**继承父块那一环**
pub fn sequence_position(conn: &Connection, block_id: &str) -> Result<Option<(String, i64)>, String> {
    conn.query_row(
        "SELECT sequence_id, order_index FROM sequence_members WHERE block_id = ?1",
        [block_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| tf!(i18n::msg::ERR_DB_78, e = e))
}

/// 让一个新块**接替**链上某一环（漂移出来的新块用这个：与残影共享同一个位置）
pub fn adopt_into_sequence(
    conn: &Connection,
    sequence_id: &str,
    block_id: &str,
    order_index: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO sequence_members (sequence_id, block_id, order_index) VALUES (?1, ?2, ?3)",
        rusqlite::params![sequence_id, block_id, order_index],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_79, e = e))?;
    Ok(())
}

/// 链上**排在某一环之后**的成员块（按链序、再按时间）—— 漂移越序时要把它们一起顺延
pub fn members_after(
    conn: &Connection,
    sequence_id: &str,
    order_index: i64,
) -> Result<Vec<Block>, String> {
    let sql = format!(
        "SELECT {BLOCK_COLUMNS} FROM blocks b
         WHERE EXISTS (
             SELECT 1 FROM sequence_members m
             WHERE m.sequence_id = ?1 AND m.order_index > ?2 AND m.block_id = b.id
         )
         ORDER BY b.start_at, b.rowid"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| tf!(i18n::msg::ERR_DB_80, e = e))?;
    let rows = stmt
        .query_map(rusqlite::params![sequence_id, order_index], row_to_block)
        .map_err(|e| tf!(i18n::msg::ERR_DB_81, e = e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| tf!(i18n::msg::ERR_DB_82, e = e))?);
    }
    Ok(out)
}

/// 改一个块的时段（漂移越序时**顺延**后续链节用；时间变了要清掉提醒记账）
pub fn move_block(conn: &Connection, id: &str, start_at: i64, end_at: i64) -> Result<Block, String> {
    validate_range(start_at, end_at)?;
    conn.execute(
        "UPDATE blocks SET start_at = ?1, end_at = ?2, last_notified_at = NULL WHERE id = ?3",
        rusqlite::params![start_at, end_at, id],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_83, e = e))?;
    load_block(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_84).to_string())
}

/// 校验一批块可以入链：都存在、且都还没属于别的序列（边界 Q4：已属于别的序列就明确拒绝）
fn assert_blocks_linkable(conn: &Connection, block_ids: &[String]) -> Result<(), String> {
    for block_id in block_ids {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM blocks WHERE id = ?1)",
                [block_id],
                |r| r.get(0),
            )
            .map_err(|e| tf!(i18n::msg::ERR_DB_85, e = e))?;
        if !exists {
            return Err(i18n::t(i18n::msg::ERR_DB_86).to_string());
        }
        let taken: Option<String> = conn
            .query_row(
                "SELECT sequence_id FROM sequence_members WHERE block_id = ?1",
                [block_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| tf!(i18n::msg::ERR_DB_87, e = e))?;
        if taken.is_some() {
            return Err(i18n::t(i18n::msg::ERR_DB_88).to_string());
        }
    }
    Ok(())
}

/// 新建序列（至少 2 个块；**初始顺序按开始时间**；块不能已属于别的序列）
pub fn create_sequence(
    conn: &Connection,
    name: &str,
    block_ids: &[String],
) -> Result<Sequence, String> {
    if block_ids.len() < 2 {
        return Err(i18n::t(i18n::msg::ERR_DB_89).to_string());
    }
    let name = validate_sequence_name(name)?;
    let mut unique: Vec<&String> = block_ids.iter().collect();
    unique.sort();
    unique.dedup();
    if unique.len() != block_ids.len() {
        return Err(i18n::t(i18n::msg::ERR_DB_90).to_string());
    }
    assert_blocks_linkable(conn, block_ids)?;

    // 初始顺序 = 按开始时间（用户是顺着时间点链接的，这样最符合直觉）
    let mut ordered: Vec<(i64, String)> = Vec::new();
    for block_id in block_ids {
        let start_at: i64 = conn
            .query_row("SELECT start_at FROM blocks WHERE id = ?1", [block_id], |r| {
                r.get(0)
            })
            .map_err(|e| tf!(i18n::msg::ERR_DB_91, e = e))?;
        ordered.push((start_at, block_id.clone()));
    }
    ordered.sort();

    let sequence_id = Uuid::new_v4().to_string();
    let created_at = now();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| tf!(i18n::msg::ERR_DB_92, e = e))?;
    tx.execute(
        "INSERT INTO sequences (id, name, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![sequence_id, name, created_at],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_93, e = e))?;
    for (index, (_, block_id)) in ordered.iter().enumerate() {
        tx.execute(
            "INSERT INTO sequence_members (sequence_id, block_id, order_index) VALUES (?1, ?2, ?3)",
            rusqlite::params![sequence_id, block_id, index as i64],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_94, e = e))?;
    }
    tx.commit().map_err(|e| tf!(i18n::msg::ERR_DB_95, e = e))?;

    get_sequence(conn, &sequence_id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_96).to_string())
}

/// 把块 B **接在块 A 后面**（C3.3/C3.4：用户拍板「插在 A 后面 + 时间不对就自动顺延」）。
///
/// 语义：
/// - A 还不在任何链里 → 新建一条序列，顺序就是**点击的先后** `A → B`（不按时间排序 ——
///   「接在 A 后面」是意图，时间由下面的自动顺延负责）
/// - A 已在链里 → B 插在 **A 的后继位置**（原来的后继往后挪一位），不是接在链尾
/// - B 已在**别的**链里 → 明确拒绝（不偷偷搬走）；已在**同一条**链里 → 链内重排
/// - 插入后做**两件事**（顺序无关，缺一不可）：
///   ① B 必须在 A 之后 → 否则把 B 顺延到 A 之后
///   ② **B 后面的环也必须在 B 之后** → 否则一起级联顺延
///   ⚠️ 曾经只在「B 被挪过」时才做 ② —— 于是「B 时间本来就晚于 A、却晚于原先的后继」时
///   老后继不会被顺延，直接留下错序（用户实测发现的 bug）。现在 ② 无条件执行。
///
/// 返回 `MoveOutcome`（B + 被顺延数 + 其中历史数）。
pub fn link_after(
    conn: &Connection,
    after_block_id: &str,
    block_id: &str,
    new_sequence_name: Option<&str>,
) -> Result<MoveOutcome, String> {
    // C3 补漏（第三版）：**已经结束的块（残影 / 已完成）不能再接进序列**。
    // 用户实测：「父块都漂出去"死掉了"，还能发起链接是何意味」—— 死掉的残影只该保留痕迹与链位，
    // 不该再当链接的端点。例外：它**本来就在**这条序列里（那是 C3.1 的链位继承，允许内部重排）。
    let after_block = load_block(conn, after_block_id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_97).to_string())?;
    if after_block.status != "planned" {
        return Err(i18n::t(i18n::msg::ERR_DB_98).into());
    }
    let already_member = sequence_of_block(conn, block_id)?
        .map(|seq| seq.members.iter().any(|m| m.block_id == after_block_id))
        .unwrap_or(false);
    if !already_member {
        let moving = load_block(conn, block_id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_99).to_string())?;
        if moving.status != "planned" {
            return Err(i18n::t(i18n::msg::ERR_DB_100).into());
        }
    }

    // C3 补漏（第二版）：不变量是「**一条序列里不许同时出现同一条漂流链的两个成员**」。
    // 只查「这两块之间」不够 —— 用户实测「父残影 →(中转块)→ 子块」照样能接上，
    // 而且接的时候提示成功、之后被加载时的清理悄悄摘掉（线就消失了）。这里改成查整条序列。
    {
        let mut members: Vec<String> = vec![block_id.to_string(), after_block_id.to_string()];
        for id in [block_id, after_block_id] {
            if let Some(seq) = sequence_of_block(conn, id)? {
                let mut st = conn
                    .prepare("SELECT block_id FROM sequence_members WHERE sequence_id = ?1")
                    .map_err(|e| tf!(i18n::msg::ERR_DB_101, e = e))?;
                let rows = st
                    .query_map([&seq.id], |r| r.get::<_, String>(0))
                    .map_err(|e| tf!(i18n::msg::ERR_DB_102, e = e))?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(|e| tf!(i18n::msg::ERR_DB_103, e = e))?;
                members.extend(rows);
            }
        }
        members.sort();
        members.dedup();
        for i in 0..members.len() {
            for j in (i + 1)..members.len() {
                if members[i] == members[j] {
                    continue;
                }
                if !in_same_drift_chain(conn, &members[i], &members[j])? {
                    continue;
                }
                // 同一条漂流链**允许**同处一条序列 —— 但**必须待在同一环**（C3.1 共享链位）。
                // 环号拿不到（新进链的那一块）或环号不同 → 拒绝。
                let idx = |id: &str| -> Result<Option<i64>, String> {
                    conn.query_row(
                        "SELECT order_index FROM sequence_members WHERE block_id = ?1",
                        [id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| tf!(i18n::msg::ERR_DB_104, e = e))
                };
                let (x, y) = (idx(&members[i])?, idx(&members[j])?);
                if x.is_none() || y.is_none() || x != y {
                    return Err(
                        i18n::t(i18n::msg::ERR_DB_105)
                            .into(),
                    );
                }
            }
        }
    }

    if after_block_id == block_id {
        return Err(i18n::t(i18n::msg::ERR_DB_106).to_string());
    }
    let anchor = load_block(conn, after_block_id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_107).to_string())?;
    let moving = load_block(conn, block_id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_108).to_string())?;

    let anchor_pos = sequence_position(conn, after_block_id)?;
    let moving_pos = sequence_position(conn, block_id)?;
    if let (Some((anchor_seq, _)), Some((moving_seq, _))) = (&anchor_pos, &moving_pos) {
        if anchor_seq != moving_seq {
            return Err(i18n::t(i18n::msg::ERR_DB_109).to_string());
        }
    }

    // 1) 决定属于哪条序列（A 不在链里就新建，顺序 = 点击先后）
    if anchor_pos.is_none() {
        let name = new_sequence_name
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| i18n::t(i18n::msg::ERR_DB_110).to_string())?;
        create_sequence_with_order(conn, name, &[after_block_id, block_id])?;
    } else if let Some((_, moving_ring)) = moving_pos {
        // 同链内重排：先把 B 摘出来，位置交给下面的插入逻辑
        let anchor_ring = anchor_pos.as_ref().map(|(_, ring)| *ring).unwrap_or(0);
        if moving_ring == anchor_ring {
            return Err(i18n::t(i18n::msg::ERR_DB_111).to_string());
        }
        conn.execute(
            "DELETE FROM sequence_members WHERE sequence_id = ?1 AND block_id = ?2",
            rusqlite::params![anchor_pos.as_ref().map(|(id, _)| id.clone()).unwrap_or_default(), block_id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_112, e = e))?;
    }

    if anchor_pos.is_some() {
        // 2) 插在 A 后面：A 之后的环整体 +1，再放入 B
        let sequence_id = sequence_position(conn, after_block_id)?
            .map(|(id, _)| id)
            .ok_or_else(|| i18n::t(i18n::msg::ERR_DB_113).to_string())?;
        let anchor_ring = sequence_position(conn, after_block_id)?
            .map(|(_, ring)| ring)
            .ok_or_else(|| i18n::t(i18n::msg::ERR_DB_114).to_string())?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| tf!(i18n::msg::ERR_DB_115, e = e))?;
        tx.execute(
            "UPDATE sequence_members SET order_index = order_index + 1
             WHERE sequence_id = ?1 AND order_index > ?2",
            rusqlite::params![sequence_id, anchor_ring],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_116, e = e))?;
        tx.execute(
            "INSERT INTO sequence_members (sequence_id, block_id, order_index) VALUES (?1, ?2, ?3)",
            rusqlite::params![sequence_id, block_id, anchor_ring + 1],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_117, e = e))?;
        tx.commit().map_err(|e| tf!(i18n::msg::ERR_DB_118, e = e))?;
    }

    let sequence_id = sequence_position(conn, block_id)?
        .map(|(id, _)| id)
        .ok_or_else(|| i18n::t(i18n::msg::ERR_DB_119).to_string())?;
    let my_ring = sequence_position(conn, block_id)?
        .map(|(_, ring)| ring)
        .ok_or_else(|| i18n::t(i18n::msg::ERR_DB_120).to_string())?;

    // 3) 时间对齐 ①：B 的**起点**不能早于 A 的起点 —— 与拖动用同一条判定（只看 start 序，重叠是允许的）。
    //    C1.6（用户实测）：以前这里按 anchor.**end** 判，于是「B 本来就排在 A 之后、只是压在 A 的时段里」
    //    也会被硬推到 A 结束之后 —— 和拖动的手感对不上（拖动允许重叠）。
    //    真的错序（B 起点早于 A）时，才把它顺延到 A 之后（与级联的落点规则一致）。
    let original_start = moving.start_at;
    let mut block = moving;
    if block.start_at < anchor.start_at {
        let length = block.end_at - block.start_at;
        let start = snap_to_grid(anchor.end_at);
        let end = start
            .checked_add(length)
            .ok_or_else(|| i18n::t(i18n::msg::ERR_DB_121).to_string())?;
        block = move_block(conn, block_id, start, end)?;
    }

    // 4) 时间对齐 ②：**无条件**检查 B 后面的环（它们可能排在 B 之前 —— 不管 B 有没有被挪过）
    let (cascaded, history_moved) =
        cascade_after_ring(conn, &sequence_id, my_ring, &block, "link")?;

    record_event(
        conn,
        block_id,
        "link",
        Some(
            serde_json::json!({ "after": after_block_id, "moved_self": block.start_at != original_start })
                .to_string(),
        ),
    )?;

    // 顺手把环号里的洞压实（删除/插入会留下空号，显示上看不出但数据不干净）
    renumber_members(conn, &sequence_id)?;

    Ok(MoveOutcome {
        block,
        cascaded,
        history_moved,
        merge_hint: None,
        merged: false, // 接链只做顺序对齐，不做融合
    })
}

// round58（0.13.1）：`reviews`（结语）的两条读写函数已销 —— 卡片并进总览、结语整条链删掉。
// 表本身保留（快照/撤销仍要覆盖它，0.13.0 可能已写进真库），等某个维护轮决定去留（对账 §5）。

// ---------------------------------------------------------------- 撤销快照（C1.5）

/// 撤销快照包含的用户数据表（`settings` / `schema_migrations` 是应用状态，**不进快照**）
/// round69（B3）：`repeats` / `repeat_occurrences` 加进来 —— 建规则与生成都要能 Ctrl+Z；
/// 插入顺序按外键（tasks → blocks → repeats → repeat_occurrences），下面 `restore_tables` 照这份顺序插。
pub const SNAPSHOT_TABLES: &[&str] = &[
    "tasks",
    "blocks",
    "sequences",
    "sequence_members",
    "events",
    "external_blocks",
    "reviews",
    "templates",
    "repeats",
    "repeat_occurrences",
];

/// 恢复快照时的**清表顺序**：子表先、父表后（外键关系写在 `002`/`001` 的 DDL 里）。
///
/// ⚠️ **必须与 `SNAPSHOT_TABLES` 一一对应** —— 有单测看守（`test_restore_delete_order_covers_snapshot_tables`）。
/// 少一张表不是「少清一张」那么轻：快照里没那一行时它会被留下（撤销报成功但没撤干净），
/// 快照里有那一行时就撞 UNIQUE / 主键 → 整个恢复事务回滚 → **撤销功能直接坏掉**。
pub const RESTORE_DELETE_ORDER: &[&str] = &[
    "repeat_occurrences",
    "sequence_members",
    "blocks",
    "events",
    "external_blocks",
    "reviews",
    "templates",
    "sequences",
    "repeats",
    "tasks",
];

/// 把快照表拍成 JSON：`{表名: {cols: [...], rows: [[...], ...]}}`。
/// 不用 rusqlite 的 `serde_json` feature（那要改依赖特性）——手写两个 6 行的类型转换就好。
pub fn dump_tables(conn: &Connection) -> Result<String, String> {
    let mut all = serde_json::Map::new();
    for table in SNAPSHOT_TABLES {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table}"))
            .map_err(|e| tf!(i18n::msg::ERR_DB_122, table = table, e = e))?;
        let cols: Vec<String> = stmt.column_names().iter().map(|c| (*c).to_string()).collect();
        let mut rows_out = Vec::new();
        let rows = stmt
            .query_map([], |row| {
                let mut vals = Vec::with_capacity(cols.len());
                for i in 0..cols.len() {
                    let v: rusqlite::types::Value = row.get(i)?;
                    vals.push(value_to_json(v));
                }
                Ok(serde_json::Value::Array(vals))
            })
            .map_err(|e| tf!(i18n::msg::ERR_DB_123, table = table, e = e))?;
        for row in rows {
            rows_out.push(row.map_err(|e| tf!(i18n::msg::ERR_DB_124, table = table, e = e))?);
        }
        all.insert(
            table.to_string(),
            serde_json::json!({ "cols": cols, "rows": rows_out }),
        );
    }
    Ok(serde_json::Value::Object(all).to_string())
}

fn value_to_json(value: rusqlite::types::Value) -> serde_json::Value {
    use rusqlite::types::Value as V;
    match value {
        V::Null => serde_json::Value::Null,
        V::Integer(i) => serde_json::json!(i),
        V::Real(f) => serde_json::json!(f),
        V::Text(t) => serde_json::Value::String(t),
        // 我们这些表里没有 blob（有的话转成十六进制串，至少不丢）
        V::Blob(b) => {
            serde_json::Value::String(b.iter().map(|x| format!("{x:02x}")).collect())
        }
    }
}

fn json_to_value(value: &serde_json::Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as V;
    match value {
        serde_json::Value::Null => V::Null,
        serde_json::Value::Bool(b) => V::Integer(if *b { 1 } else { 0 }),
        serde_json::Value::Number(n) => n
            .as_i64()
            .map(V::Integer)
            .unwrap_or_else(|| V::Real(n.as_f64().unwrap_or(0.0))),
        serde_json::Value::String(s) => V::Text(s.clone()),
        other => V::Text(other.to_string()),
    }
}

/// 用快照整体覆盖这些表：**先删子表再删父表，插入反过来**，全程一个事务。
///
/// ⚠️ 清表清单**必须与 `SNAPSHOT_TABLES` 一一对应**（有单测看守）：少一张表的后果不是「少恢复一张」，
/// 而是**撤销留脏行 + 随后撞 UNIQUE 把整个撤销功能弄坏** —— round57 交付前复核抓到的 `reviews` 就是活例子。
pub fn restore_tables(conn: &Connection, snapshot: &str) -> Result<(), String> {
    let data: serde_json::Value =
        serde_json::from_str(snapshot).map_err(|e| tf!(i18n::msg::ERR_DB_125, e = e))?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| tf!(i18n::msg::ERR_DB_126, e = e))?;

    for table in RESTORE_DELETE_ORDER {
        tx.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|e| tf!(i18n::msg::ERR_DB_127, table = table, e = e))?;
    }

    for table in SNAPSHOT_TABLES {
        let Some(entry) = data.get(table) else { continue };
        let cols: Vec<String> = entry["cols"]
            .as_array()
            .ok_or_else(|| tf!(i18n::msg::ERR_DB_128, table = table))?
            .iter()
            .filter_map(|c| c.as_str().map(|s| s.to_string()))
            .collect();
        let rows = entry["rows"]
            .as_array()
            .ok_or_else(|| tf!(i18n::msg::ERR_DB_129, table = table))?;
        if rows.is_empty() {
            continue;
        }
        let placeholders = (1..=cols.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT INTO {table} ({}) VALUES ({placeholders})",
            cols.join(", ")
        );
        let mut stmt = tx
            .prepare(&sql)
            .map_err(|e| tf!(i18n::msg::ERR_DB_130, table = table, e = e))?;
        for row in rows {
            let vals: Vec<rusqlite::types::Value> = row
                .as_array()
                .ok_or_else(|| tf!(i18n::msg::ERR_DB_131, table = table))?
                .iter()
                .map(json_to_value)
                .collect();
            stmt.execute(rusqlite::params_from_iter(vals))
                .map_err(|e| tf!(i18n::msg::ERR_DB_132, table = table, e = e))?;
        }
    }

    tx.commit().map_err(|e| tf!(i18n::msg::ERR_DB_133, e = e))?;
    Ok(())
}

/// 校验序列名（`create_sequence` 与「接链时新建」共用 —— 两处规则必须一致）
fn validate_sequence_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(i18n::t(i18n::msg::ERR_DB_134).to_string());
    }
    if trimmed.chars().count() > MAX_TITLE_CHARS {
        return Err(tf!(i18n::msg::ERR_DB_135, MAX_TITLE_CHARS = MAX_TITLE_CHARS));
    }
    Ok(trimmed.to_string())
}

/// 按**给定顺序**新建序列（与 `create_sequence` 的区别：**不按时间排序**）。
/// 用于「接在 A 后面」——顺序就是用户点击的先后，时间由自动顺延负责对齐。
fn create_sequence_with_order(
    conn: &Connection,
    name: &str,
    ordered_ids: &[&str],
) -> Result<String, String> {
    let name = validate_sequence_name(name)?;
    let ids: Vec<String> = ordered_ids.iter().map(|id| id.to_string()).collect();
    assert_blocks_linkable(conn, &ids)?;

    let sequence_id = Uuid::new_v4().to_string();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| tf!(i18n::msg::ERR_DB_136, e = e))?;
    tx.execute(
        "INSERT INTO sequences (id, name, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![sequence_id, name, now()],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_137, e = e))?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO sequence_members (sequence_id, block_id, order_index) VALUES (?1, ?2, ?3)",
            rusqlite::params![sequence_id, id, index as i64],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_138, e = e))?;
    }
    tx.commit().map_err(|e| tf!(i18n::msg::ERR_DB_139, e = e))?;
    Ok(sequence_id)
}

/// 把每条序列的环号压实成 0..n-1。
/// 为什么需要：删块走外键 CASCADE 会直接抽掉成员行，留下号洞（实测用户库里是 0..5,7,11..）——
/// 显示上看不出（序号按「位置名次」算），但数据该干净，以后任何按号遍历的逻辑也不会被洞坑到。
fn renumber_all_sequences(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id FROM sequences")
        .map_err(|e| tf!(i18n::msg::ERR_DB_140, e = e))?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| tf!(i18n::msg::ERR_DB_141, e = e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| tf!(i18n::msg::ERR_DB_142, e = e))?;
    drop(stmt);

    for id in ids {
        renumber_members(conn, &id)?;
    }
    Ok(())
}


/// 清掉「成员不足 2 个」的序列（C3.3 修的残留：删块走外键 CASCADE 清成员，
/// 但序列本身没人删 → 界面看不见的空壳会一直堆着。实测用户库里有 3 个空壳）。
/// 返回清掉的数量。
pub fn prune_short_sequences(conn: &Connection) -> Result<usize, String> {
    let removed = conn
        .execute(
            "DELETE FROM sequences WHERE (
                 SELECT COUNT(*) FROM sequence_members m WHERE m.sequence_id = sequences.id
             ) < 2",
            [],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_143, e = e))?;
    if removed > 0 {
        eprintln!("[db] 清理了 {removed} 条空序列（成员不足 2 个）");
    }
    Ok(removed)
}


/// 把块移出序列（返回序列是否因成员不足 2 个而被自动删除 —— 不留空壳）
pub fn remove_member(
    conn: &Connection,
    sequence_id: &str,
    block_id: &str,
) -> Result<bool, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| tf!(i18n::msg::ERR_DB_144, e = e))?;
    let removed = tx
        .execute(
            "DELETE FROM sequence_members WHERE sequence_id = ?1 AND block_id = ?2",
            rusqlite::params![sequence_id, block_id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_145, e = e))?;
    if removed == 0 {
        return Err(i18n::t(i18n::msg::ERR_DB_146).to_string());
    }

    let left: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM sequence_members WHERE sequence_id = ?1",
            [sequence_id],
            |r| r.get(0),
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_147, e = e))?;
    let pruned = left < 2;
    if pruned {
        tx.execute("DELETE FROM sequences WHERE id = ?1", [sequence_id])
            .map_err(|e| tf!(i18n::msg::ERR_DB_148, e = e))?;
    } else {
        renumber_members(&tx, sequence_id)?;
    }
    // round60（10.1 统计页）：取出 = 一条 unlink（取到剩 1 个、序列自动消失，也还是「取出」这个动作）
    record_event(&tx, block_id, "unlink", None)?;
    tx.commit().map_err(|e| tf!(i18n::msg::ERR_DB_149, e = e))?;
    Ok(pruned)
}

/// 删除序列：**只解链，块一个都不动**（返回实际删除的行数，0 = 本来就不存在）
pub fn delete_sequence(conn: &Connection, id: &str) -> Result<usize, String> {
    conn.execute("DELETE FROM sequences WHERE id = ?1", [id])
        .map_err(|e| tf!(i18n::msg::ERR_DB_150, e = e))
}

/// 列出「在 `[from, to)` 内有成员块」的序列；**成员返回全部**（前端只画窗口内的线，序号徽标照常数）
pub fn list_sequences(conn: &Connection, from: i64, to: i64) -> Result<Vec<Sequence>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT s.id, s.name, s.created_at
             FROM sequences s
             JOIN sequence_members m ON m.sequence_id = s.id
             JOIN blocks b ON b.id = m.block_id
             WHERE b.start_at >= ?1 AND b.start_at < ?2
             ORDER BY s.created_at, s.rowid",
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_151, e = e))?;
    let heads = stmt
        .query_map(rusqlite::params![from, to], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        })
        .map_err(|e| tf!(i18n::msg::ERR_DB_152, e = e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| tf!(i18n::msg::ERR_DB_153, e = e))?;
    drop(stmt);

    let mut out = Vec::new();
    for (id, name, created_at) in heads {
        // C1.6：这一条在本周**之外**还有没有成员（用 start_at 比窗口边界，严格不等 —— 正好落在
        // 窗口末端的块属于本周，不算下周）
        // 只是给界面的一句提示，**出错也不能拖垮整周加载**（宁可没有提示）
        let (min_start, max_start): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT MIN(b.start_at), MAX(b.start_at)
                 FROM sequence_members m JOIN blocks b ON b.id = m.block_id
                 WHERE m.sequence_id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or_else(|e| {
                eprintln!("[db] 查序列跨周信息失败（忽略）：{e}");
                (None, None)
            });
        out.push(Sequence {
            members: load_members(conn, &id)?,
            id,
            name,
            created_at,
            has_prev_week: min_start.map(|t| t < from).unwrap_or(false),
            has_next_week: max_start.map(|t| t >= to).unwrap_or(false),
        });
    }
    Ok(out)
}

/// 标记为「完成」。已完成/已未完成的块不会被覆盖（不回退），重复调用返回当前行。
/// 「标 ✓ 的时刻」取**服务端现在**（前端不传 —— 防伪防漂）；三档终态在这一层定。
pub fn mark_block_done(conn: &Connection, id: &str) -> Result<Block, String> {
    mark_block_done_at(conn, id, now())
}

/// 结束宽限（秒）：块到点后 15 分钟内标 ✓ **仍算「按时完成」**。
///
/// 为什么需要它（round57 / 0.13.0 / 对账 §5-BR 定口径）：结束提醒**是在 `end_at` 那一刻弹的**，
/// 「顺手点 ✓」是最常见的路径 —— 严格按「晚于 `end_at` 即超时」会让这条路径统统变成「超时完成」。
pub const OVERTIME_GRACE_SECONDS: i64 = 15 * 60;

/// 标 ✓ 的那一刻（`at`）这一块算哪种完成（v2 ③3.3 的两个终态）：
/// - 早于计划开始 → `done_short`（**提前完成**）
/// - 计划时段内，或结束后 15 分钟宽限内 → `None`（**按时完成**）
/// - 再晚 → `done_overtime`（**超时完成**）
///
/// 纯函数（`at` 由调用方给 —— 单测别偷看真挂钟；本仓已有两条这种黑历史）。
pub fn final_status_for(start_at: i64, end_at: i64, at: i64) -> Option<&'static str> {
    if at < start_at {
        Some("done_short")
    } else if at <= end_at + OVERTIME_GRACE_SECONDS {
        None
    } else {
        Some("done_overtime")
    }
}

/// 同 `mark_block_done`，但「标 ✓ 的时刻」由调用方给（单测传固定时刻）。
pub fn mark_block_done_at(conn: &Connection, id: &str, at: i64) -> Result<Block, String> {
    set_block_status(conn, id, "done", Some(at))
}

/// 标记为「未完成」。规则同 mark_block_done（终态细分只跟「完成」有关）。
pub fn mark_block_missed(conn: &Connection, id: &str) -> Result<Block, String> {
    set_block_status(conn, id, "missed", None)
}

/// round63（C18 / R41 免打扰）：把块的「已提醒」水位线推到现在。
///
/// 提醒路径（`notify::mark_notified`）与**静音期间的静默记账**共用 —— 静音时把本该提醒的块
/// 记上账，解静音后就不会把 2 小时宽限里攒下的一串一次爆出来（静音语义 = 期间不打扰、也不补发）。
pub fn mark_block_notified(conn: &Connection, id: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE blocks SET last_notified_at = ?1 WHERE id = ?2",
        rusqlite::params![now, id],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_154, e = e))?;
    Ok(())
}

fn set_block_status(
    conn: &Connection,
    id: &str,
    status: &str,
    at: Option<i64>,
) -> Result<Block, String> {
    // round57（BR → 绿）：写终态细分 —— 先读一眼这块的**计划时段**，再按标 ✓ 的时刻判提前/按时/超时。
    // 只在「完成」这条路上算（标「未完成」没有终态细分）。读不到的块会在这里就报「不存在」。
    // round60（10.1 统计页）：顺便取**计划时段时长**（分钟）写进 complete 事件的 payload ——
    // 老事件没有这个字段，统计页只能拿仍留在库里的块兜底。
    let (final_status, complete_minutes, complete_delay, complete_category): (
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
    ) = match (status, at) {
        ("done", Some(at)) => {
            let before =
                load_block(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_155).to_string())?;
            // round82（统-08 · 用户拍的 ①）：完成账的分类快照 = 任务**当前**分类；
            // 临时块 / 没设分类 → None（统计页归入「早期数据（无分类）」）。
            let category = load_task(conn, &before.task_id)?
                .and_then(|t| t.category)
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty());
            (
                final_status_for(before.start_at, before.end_at, at).map(str::to_string),
                Some((before.end_at - before.start_at) / 60),
                // round69.1（#9）：完成**延迟**（分钟，提前完成记 0）——「快不过光速」看它，
                // 不再拿「块多长」充数
                Some((at - before.start_at).max(0) / 60),
                category,
            )
        }
        _ => (None, None, None, None),
    };

    let changed = conn
        .execute(
            "UPDATE blocks SET status = ?1, final_status = ?2 WHERE id = ?3 AND status = 'planned'",
            rusqlite::params![status, final_status, id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_156, e = e))?;

    // C1.5 检查时发现的既有缺口：v2 ③3.4 写明 `events` 是理智值反推的**唯一数据源**，
    // 类型里就有 complete / skip，但标记完成/未完成一直没写 —— C6 的「跳过 30%」权重就靠它。
    // 只有真的改了行才记（已被标记的块 → 0 行受影响 → 不重复记，幂等语义不变）。
    if changed > 0 {
        record_event(
            conn,
            id,
            if status == "done" { "complete" } else { "skip" },
            complete_minutes.map(|m| {
                // round82（统-08）：有分类才写字段 —— 缺字段 / 空 = 无分类，两条路归同一栏
                let mut payload = serde_json::json!({ "minutes": m, "delay_minutes": complete_delay.unwrap_or(0) });
                if let Some(cat) = complete_category.as_deref() {
                    payload["category"] = serde_json::Value::String(cat.to_string());
                }
                payload.to_string()
            }),
        )?;
    }

    // 0 行受影响有两种可能：块不存在（报错），或块已被标记（幂等返回现有行，不回退）
    load_block(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_157).to_string())
}

/// round61（10.2 多选）：**批量标记**（`status` = `done` / `missed`）。与单块逐条同语义：
/// - 只动 `planned` 的块（幂等，已标记的不回退）；不存在的 id 跳过（批量中途可能有块刚被融合吃掉）
/// - 「标 ✓ 的时刻」整批共用同一个 `now()` —— 一次动作 = 一个时刻
/// - 每个真被改动的块各记自己的 `complete`（带分钟）/ `skip` 事件（统计页按块数算）
///
/// 返回真正被标记的块数；整批在一个事务里，半路出错不会留下半截。
pub fn mark_blocks(conn: &Connection, ids: &[String], status: &str) -> Result<usize, String> {
    if !matches!(status, "done" | "missed") {
        return Err(i18n::t(i18n::msg::ERR_DB_158).to_string());
    }
    let at = now();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| tf!(i18n::msg::ERR_DB_159, e = e))?;
    let mut changed = 0usize;
    for id in ids {
        let Some(before) = load_block(&tx, id)? else {
            continue;
        };
        if before.status != "planned" {
            continue;
        }
        set_block_status(&tx, id, status, if status == "done" { Some(at) } else { None })?;
        changed += 1;
    }
    tx.commit().map_err(|e| tf!(i18n::msg::ERR_DB_160, e = e))?;
    Ok(changed)
}

/// 更新任务块的层级（C1.4：两层）。layer 必须是 `required` / `elastic` 之一；不改已标记块的状态（层是规划属性）。
///
/// **层级被「升级」时（低 → 高）会清掉旧的通知标记**，让它在新的优先级下重新提醒一次。
/// 场景（用户实测发现）：块已经提醒过了，这时才把它改成必填 —— 否则必填通知永远不会再发。
pub fn update_block_layer(conn: &Connection, id: &str, layer: &str) -> Result<Block, String> {
    if !matches!(layer, "required" | "elastic") {
        return Err(i18n::t(i18n::msg::ERR_DB_161).to_string());
    }

    let before = load_block(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_162).to_string())?;
    conn.execute(
        "UPDATE blocks SET layer = ?1 WHERE id = ?2",
        rusqlite::params![layer, id],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_163, e = e))?;

    let updated = load_block(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_164).to_string())?;
    let promoted = priority::of(&updated.layer, updated.external_source.as_deref()).rank()
        > priority::of(&before.layer, before.external_source.as_deref()).rank();

    if promoted {
        conn.execute(
            "UPDATE blocks SET last_notified_at = NULL WHERE id = ?1",
            [id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_165, e = e))?;
        return load_block(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_166).to_string());
    }

    Ok(updated)
}

fn record_event(
    conn: &Connection,
    block_id: &str,
    event_type: &str,
    payload: Option<String>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO events (id, block_id, event_type, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            Uuid::new_v4().to_string(),
            block_id,
            event_type,
            payload,
            now()
        ],
    )
    .map_err(|e| tf!(i18n::msg::ERR_DB_167, e = e))?;
    Ok(())
}

/// 块的完整列清单：新增列时**只改这一处**
/// （曾经因为 `load_block` 漏改列导致运行时越界 —— 集中一处就不会再犯；
///   ⚠️ 与 `row_to_block` 的下标**必须同步**：新列一律追加在最后）
const BLOCK_COLUMNS: &str = "id, task_id, start_at, end_at, status, last_notified_at, created_at, \
                             layer, external_source, final_status, postponed_from, label, sanity_exempt";

/// 漂流链的最大深度：超过就当作数据异常（例如手工改库造出环），报错而不是死循环
const MAX_CHAIN_DEPTH: u32 = 64;

/// 取某块的「直接子块」（顺着它漂出来的那一块）
/// C1.2：相邻同任务自动融合（R32 安全子集）。
///
/// 条件（全满足才合）：同任务 + 同层 + 两边都是 `planned` + 都不在序列里 + 都不在漂流链上 +
/// `external_source` 都为 None + **相接或重叠**（前一块结束 ≥ 后一块开始；中间空着不合）。
/// 结果：**保留较早的那一块**（id/状态/层不变），区间取并集，删掉另一块（并留一条 `merge` 事件）。
/// 返回幸存的那一块（None = 没融）。
/// C1.2 补漏（用户实测）：「融合」原本只在**操作某个块时**触发 → 库里**早就存在**的重复块
/// 永远不会自己合 ✗（用户原话：「执行过一次明显的合并操作后自己又会合并起来」）。
/// 这个函数把现存的可合块一次性扫掉，每次加载一周时调用；**幂等**（合完再跑没有可合的）。
/// 返回合并了多少处。规则与 `merge_adjacent` 完全一致（同任务 + 同层 + 都 planned +
/// 无序列/漂流/子块 + 外表来源为空 + 相接或重叠）。
/// C2/C3：两个块是否**在同一条漂流链**上（一个是另一个的祖先或后代）。
/// 用途：禁止把漂流子块和它的父残影接进同一条序列 —— 用户实测「漂流子块链到自己父节点头上了」✗。
pub fn in_same_drift_chain(conn: &Connection, a: &str, b: &str) -> Result<bool, String> {
    let mut cur = a.to_string();
    for _ in 0..64 {
        let parent: Option<Option<String>> = conn
            .query_row("SELECT postponed_from FROM blocks WHERE id = ?1", [&cur], |r| r.get(0))
            .ok();
        match parent.flatten() {
            Some(p) if p == b => return Ok(true),
            Some(p) => cur = p,
            None => break,
        }
    }
    // 反方向：b 是 a 的祖先？
    let mut cur = b.to_string();
    for _ in 0..64 {
        let parent: Option<Option<String>> = conn
            .query_row("SELECT postponed_from FROM blocks WHERE id = ?1", [&cur], |r| r.get(0))
            .ok();
        match parent.flatten() {
            Some(p) if p == a => return Ok(true),
            Some(p) => cur = p,
            None => break,
        }
    }
    Ok(false)
}

/// 修数据：把「同一条漂流链上的两个块被接进同一序列」这种非法成员关系摘掉（返回摘掉几条）
pub fn repair_drift_chain_sequences(conn: &Connection) -> Result<usize, String> {
    let pairs: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT m1.sequence_id, m1.block_id, m2.block_id FROM sequence_members m1
             JOIN sequence_members m2 ON m2.sequence_id = m1.sequence_id AND m2.block_id > m1.block_id",
        )
        .and_then(|mut st| {
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect()
        })
        .map_err(|e| tf!(i18n::msg::ERR_DB_168, e = e))?;
    let mut removed = 0;
    for (seq, a, b) in pairs {
        if !in_same_drift_chain(conn, &a, &b)? {
            continue;
        }
        // 关键：同链**同一环**是合法的（C3.1：残影与它漂出去的新块共享同一个位置）——
        // 我上一版一律当成非法 ✗，把"活着的链尾"摘掉了，造成「死残影攥着线、活块反而自由」✗
        let (ia, ib): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT order_index FROM sequence_members WHERE sequence_id = ?1 AND block_id = ?2),
                        (SELECT order_index FROM sequence_members WHERE sequence_id = ?1 AND block_id = ?3)",
                rusqlite::params![&seq, &a, &b],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| tf!(i18n::msg::ERR_DB_169, e = e))?;
        if ia == ib {
            continue; // 同一环：残影与后续共享链位，合法 ✓
        }
        // 异环才非法：摘掉环号**靠后**的那一个
        let (keep, drop_id) = if ia < ib { (a.clone(), b.clone()) } else { (b.clone(), a.clone()) };
        conn.execute(
            "DELETE FROM sequence_members WHERE sequence_id = ?1 AND block_id = ?2",
            rusqlite::params![&seq, &drop_id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_170, e = e))?;
        record_event(conn, &drop_id, "unlink_drift", Some(serde_json::json!({"kept": keep}).to_string()))?;
        eprintln!("[db] 序列清理：摘掉漂流链内部的非法成员 {drop_id}（保留 {keep}）");
        removed += 1;
    }
    Ok(removed)
}

/// 修数据（补救我 0.6.30/0.6.31 的错误规则）：漂流链的**活链尾**应当接替链在序列上的环位。
/// 历史上被摘掉的活块，这里按环位补回来（幂等）。
pub fn adopt_live_tails_into_sequences(conn: &Connection) -> Result<usize, String> {
    let members: Vec<(String, String, i64)> = conn
        .prepare("SELECT sequence_id, block_id, order_index FROM sequence_members")
        .and_then(|mut st| {
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect()
        })
        .map_err(|e| tf!(i18n::msg::ERR_DB_171, e = e))?;
    let mut added = 0;
    for (seq, block_id, idx) in members {
        let Some(block) = load_block(conn, &block_id)? else {
            continue;
        };
        if block.status == "planned" {
            continue; // 它自己就是活的，不用补
        }
        let tail = chain_tail(conn, &block)?;
        if tail.id == block_id {
            continue;
        }
        let already: Option<i64> = conn
            .query_row(
                "SELECT order_index FROM sequence_members WHERE sequence_id = ?1 AND block_id = ?2",
                rusqlite::params![&seq, &tail.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| tf!(i18n::msg::ERR_DB_172, e = e))?;
        if already.is_some() {
            continue;
        }
        adopt_into_sequence(conn, &seq, &tail.id, idx)?;
        eprintln!("[db] 序列修复：把活链尾 {} 补到环 {idx}（承接残影 {}）", tail.id, block_id);
        added += 1;
    }
    Ok(added)
}

pub fn merge_all_pending(conn: &Connection) -> Result<(usize, usize), String> {
    let mut merged = 0;
    // round64（C10）：融合开关关掉时，加载时的幂等扫描也不再融合（后面的序列修数据照旧）
    if crate::features::enabled(conn, crate::features::MERGE) {
        let ids: Vec<String> = conn
            .prepare(&format!(
                "SELECT id FROM blocks WHERE status = 'planned'{} ORDER BY start_at, rowid",
                drift_filter(conn, "")?
            ))
            .and_then(|mut st| st.query_map([], |r| r.get::<_, String>(0))?.collect())
            .map_err(|e| tf!(i18n::msg::ERR_DB_173, e = e))?;
        for id in ids {
            let Some(block) = load_block(conn, &id)? else {
                continue; // 这一块已经被上一次融合吃掉了
            };
            if merge_adjacent(conn, &block)?.is_some() {
                merged += 1;
            }
        }
        if merged > 0 {
            eprintln!("[db] 融合：加载时扫掉 {merged} 处已存在的重复块");
        }
    }
    // 顺带修数据：① 把活链尾补回它该在的环位（补救我上一版的错）② 摘掉真正异环的非法成员
    let adopted = adopt_live_tails_into_sequences(conn)?;
    let fixed = repair_drift_chain_sequences(conn)?;
    Ok((merged, adopted + fixed))
}

pub fn merge_adjacent(conn: &Connection, block: &Block) -> Result<Option<Block>, String> {
    merge_adjacent_preferring(conn, block, false)
}

/// 同 `merge_adjacent`，但 `prefer_base = true` 时**无条件保留传进来的那一块**（不看起点先后）。
///
/// round69.1（6b P1-2 / 边界表 D1）：复制路径用 —— 「就地融合」的语义是「本来那块不动」，
/// 副本落在原块**左边**（如 11:45–12:15 压 12:00–12:30）时不能让原块那一行被 DELETE、id 被换掉。
pub(crate) fn merge_adjacent_preferring(
    conn: &Connection,
    block: &Block,
    prefer_base: bool,
) -> Result<Option<Block>, String> {
    // round64（C10）：融合开关（默认开）—— 关掉则任何路径都不再自动合并；已合并的块保持原样
    if !crate::features::enabled(conn, crate::features::MERGE) {
        return Ok(None);
    }
    // 自己不是「计划中」就不参与（已经 ✓/✗ 的块不能把旁边计划中的块吃掉）
    if block.status != "planned" {
        return Ok(None);
    }
    // C1.8（R33）：**临时安排块一律不融合** —— 它们全挂在同一个隐藏任务上，
    // 按「同任务」规则会被自动合掉（两个不相干的临时安排本来就不是同一件事）。
    if block.task_id == TEMP_TASK_ID {
        return Ok(None);
    }

    for other in merge_candidates(conn, block)? {
        if !merge_blockers(conn, block, &other)?.is_empty() {
            continue; // 任一条不满足就不合；具体是哪一条由 `merge_hint` 讲给用户
        }
        let start = block.start_at.min(other.start_at);
        let end = block.end_at.max(other.end_at);
        let (keep_id, eaten_id) = if prefer_base || block.start_at <= other.start_at {
            (block.id.as_str(), other.id.as_str())
        } else {
            (other.id.as_str(), block.id.as_str())
        };

        conn.execute(
            "UPDATE blocks SET start_at = ?1, end_at = ?2, last_notified_at = NULL WHERE id = ?3",
            rusqlite::params![start, end, keep_id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_174, e = e))?;
        conn.execute("DELETE FROM blocks WHERE id = ?1", [eaten_id])
            .map_err(|e| tf!(i18n::msg::ERR_DB_175, e = e))?;
        record_event(
            conn,
            keep_id,
            "merge",
            Some(
                serde_json::json!({ "eaten": eaten_id, "start": start, "end": end })
                    .to_string(),
            ),
        )?;
        eprintln!("[db] 融合：合并相邻同任务块（保留 {keep_id}，吃掉 {eaten_id}）");
        return load_block(conn, keep_id);
    }
    Ok(None)
}

/// 融合候选：同任务 + 同层 + 都「计划中」+ 不是自己。
///
/// 层/状态不同本来就不是「重复的两块」（那也算不上「本该合却没合」）—— 所以不在这里解释。
/// 用 `BLOCK_COLUMNS`（别另抄一份列清单 —— round25 加 `label` 时漏了这里，42 个测试直接炸）。
fn merge_candidates(conn: &Connection, block: &Block) -> Result<Vec<Block>, String> {
    // round64.1：关掉漂流时，隐藏的漂流子块不被选作候选（它们当不存在）
    let filter = drift_filter(conn, "")?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {BLOCK_COLUMNS} FROM blocks \
             WHERE task_id = ?1 AND layer = ?2 AND status = 'planned' AND id <> ?3{filter}"
        ))
        .map_err(|e| tf!(i18n::msg::ERR_DB_176, e = e))?;
    let rows = stmt
        .query_map(
            rusqlite::params![&block.task_id, &block.layer, &block.id],
            row_to_block,
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_177, e = e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| tf!(i18n::msg::ERR_DB_178, e = e))?;
    Ok(rows)
}

/// 这一对块**为什么不能合**（空 = 可以合）。
///
/// round27：判定只此一处 —— 融合本身（`merge_adjacent`）与「给用户的解释」（`merge_hint`）共用它。
/// （教训：融合规则曾被抄成两份，加一列就漏一处 → 见 `merge_candidates` 的注释。）
pub(crate) fn merge_blockers(
    conn: &Connection,
    block: &Block,
    other: &Block,
) -> Result<Vec<&'static str>, String> {
    let mut why: Vec<&'static str> = Vec::new();
    // 外部日历块、漂流链上的块都不参与
    if block.external_source.is_some() || other.external_source.is_some() {
        why.push("external");
    }
    if block.postponed_from.is_some() || other.postponed_from.is_some() {
        why.push("drift");
    }
    if child_of(conn, &block.id)?.is_some() || child_of(conn, &other.id)?.is_some() {
        why.push("drift");
    }
    // 在序列里 → 链位与环号不能被动
    if sequence_of_block(conn, &block.id)?.is_some()
        || sequence_of_block(conn, &other.id)?.is_some()
    {
        why.push("sequence");
    }
    // 相接**或重叠**都合 —— 用户实测：同一时间并排的两块也要合（那就是「重复的两块」，R32 的本意）
    if other.start_at > block.end_at || other.end_at < block.start_at {
        why.push("gap");
    } else {
        let start = block.start_at.min(other.start_at);
        let end = block.end_at.max(other.end_at);
        // round25：并集超过时长上限（3 天）时**跳过这次融合**，而不是报错
        if end - start > MAX_BLOCK_SECONDS {
            why.push("cap");
        }
    }
    Ok(why)
}

/// 拖了一块压到另一块上、却没融合时，**给用户一句原因**。
///
/// round27（用户 round26 验收 #3）：他自己撞上的是「同任务 + 同层 + 重叠，但其中一块在漂流链上」——
/// 规则如此（融合会把漂流的来历吃掉），但不能让他猜为什么没合。只挑他会在意的那几条：
/// 漂流链 / 序列 / 并集超过 3 天（「层不同 / 一块已完成 / 中间空着」是显而易见的，不刷屏）。
pub fn merge_hint(conn: &Connection, block: &Block) -> Result<Option<&'static str>, String> {
    if block.status != "planned" || block.task_id == TEMP_TASK_ID {
        return Ok(None);
    }
    for other in merge_candidates(conn, block)? {
        let why = merge_blockers(conn, block, &other)?;
        // 根本不挨着 → 谈不上「本该合却没合」（否则会拿库里老早以前的另一个序列成员来吓人）
        if why.contains(&"gap") {
            continue;
        }
        if let Some(kind) = why.iter().find(|k| matches!(**k, "drift" | "sequence" | "cap")) {
            return Ok(Some(kind));
        }
    }
    Ok(None)
}

fn child_of(conn: &Connection, parent_id: &str) -> Result<Option<Block>, String> {
    let sql = format!(
        "SELECT {BLOCK_COLUMNS} FROM blocks WHERE postponed_from = ?1 \
         ORDER BY created_at DESC, rowid DESC LIMIT 1"
    );
    conn.query_row(&sql, [parent_id], row_to_block)
        .optional()
        .map_err(|e| tf!(i18n::msg::ERR_DB_179, e = e))
}

/// 沿漂流链一路走到**链尾**（最后一个没有后续的块）。
/// 关键：链尾才是「当前真正的意图」所在 —— 链上任意一块都不应该直接派生兄弟块。
fn chain_tail(conn: &Connection, start: &Block) -> Result<Block, String> {
    let mut current = start.clone();
    for _ in 0..MAX_CHAIN_DEPTH {
        match child_of(conn, &current.id)? {
            Some(next) => current = next,
            None => return Ok(current),
        }
    }
    Err(tf!(i18n::msg::ERR_DB_208, MAX_CHAIN_DEPTH = MAX_CHAIN_DEPTH))
}

/// 收集某块及其全部后代（用 `out` 去重防环，保证一定终止）
fn collect_subtree(
    conn: &Connection,
    id: &str,
    depth: u32,
    out: &mut Vec<String>,
) -> Result<(), String> {
    if depth > MAX_CHAIN_DEPTH {
        return Err(tf!(i18n::msg::ERR_DB_209, MAX_CHAIN_DEPTH = MAX_CHAIN_DEPTH));
    }
    if out.iter().any(|x| x == id) {
        return Ok(()); // 环：已经收集过就不再展开
    }
    out.push(id.to_string());

    let sql = format!("SELECT {BLOCK_COLUMNS} FROM blocks WHERE postponed_from = ?1");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| tf!(i18n::msg::ERR_DB_180, e = e))?;
    let rows = stmt
        .query_map([id], row_to_block)
        .map_err(|e| tf!(i18n::msg::ERR_DB_181, e = e))?;

    let mut children: Vec<Block> = Vec::new();
    for row in rows {
        children.push(row.map_err(|e| tf!(i18n::msg::ERR_DB_182, e = e))?);
    }
    for child in children {
        collect_subtree(conn, &child.id, depth + 1, out)?;
    }
    Ok(())
}

/// 漂流：为「没做成」的块安排一次后续。**一条漂流链永远只有一个活跃块（planned）**：
///
/// 1. 先沿链走到**链尾**（链尾才是当前真正的意图所在，而不是链上任意一块）
/// 2. 链尾仍是 `planned` → **移动它**（改时段，链长度不变，不产生兄弟块）
/// 3. 链尾已结束（done/missed）→ 从**链尾**新建一个后续块（parent = 链尾，保持线性不分叉）
///
/// 两种情况都写一条 `postpone` 事件（from = 被点击块的开始时间，to = 新时段）。
/// 改块的结果：新块 + **被顺延的后续链节数** + 其中**历史（已完成/未完成）**的个数
/// （历史被挪动时要在界面上明说 —— 那等于改了「它原本排在哪」）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoveOutcome {
    pub block: Block,
    pub cascaded: usize,
    pub history_moved: usize,
    /// round27：没融合时后端告诉前端的**原因**（`drift` / `sequence` / `cap`）——
    /// 用户实测「同一个任务的两块拖到一起却没融合」，得让他知道是规则在挡、不是坏了。
    pub merge_hint: Option<String>,
    /// round31（C1.9，用户 2026-10-02 拍板「每个操作造成的合并都能弹」）：
    /// 这次操作**真的融合吃掉了一块**——前端据此弹「已合并两块」（round48 起不带括号尾巴）。
    /// 判定就用 `merge_adjacent` 的返回值：它认了幸存者 = 合了。绝不在前端靠 id 差集猜。
    pub merged: bool,
}

/// 建块的结果：块 + 这次是否融合吃掉了别的块（round31 的融合提示用）。
/// 为什么建块单独一个结构：`create_block` 落库后也会融合（它可能返回**幸存者**，不是刚建的那行），
/// 而命令的返回类型原来是裸 `Block`，没法把「合了没」告诉前端。
#[derive(Debug, Clone, Serialize)]
pub struct CreateOutcome {
    pub block: Block,
    pub merged: bool,
}

/// 库里一共多少块（round31：命令层用它判断「这次写操作有没有把谁吃掉」——
/// 融合会 DELETE 行，所以「该涨没涨 / 该不动却变少」就是合了）
pub fn count_blocks(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM blocks", [], |row| row.get(0))
        .map_err(|e| tf!(i18n::msg::ERR_DB_183, e = e))
}

/// 漂流：把某一环（沿链走到链尾）挪到新时段。
///
/// **C3.1（用户实测反馈后修正）**：序列表达的是顺序依赖，所以：
/// - **链上位置不丢**：漂出来的新块**接替**它原来那一环（与残影共享同一个位置 ✓）
/// - **越序就级联**：若新时段落到了后续链节的后面，把被越过的那些**计划中**的链节也一起顺延
///   （已完成/未完成的链节不动 —— 那是历史，不改 ✓）
pub fn postpone_block(
    conn: &Connection,
    id: &str,
    new_start_at: i64,
) -> Result<MoveOutcome, String> {
    let source = load_block(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_184).to_string())?;
    let tail = chain_tail(conn, &source)?;
    let duration = tail.end_at - tail.start_at;
    // 先校验新时段（同时保证下面的加法不溢出），再动数据
    let new_end_at = new_start_at
        .checked_add(duration)
        .ok_or_else(|| i18n::t(i18n::msg::ERR_DB_185).to_string())?;
    validate_range(new_start_at, new_end_at)?;

    let count_before = count_blocks(conn)?;
    let new_block = if tail.status == "planned" {
        // 时间变了 → 清掉旧的通知标记，新时段该重新提醒
        move_block(conn, &tail.id, new_start_at, new_end_at)?
    } else {
        // 链尾已结束：从**链尾**继续（承接链尾的层），不挂回源块以免分叉
        let created = create_block_inner(conn, &source.task_id, new_start_at, new_end_at, "elastic", false, None, false, true)?;
        let linked = if created.layer == tail.layer {
            created
        } else {
            update_block_layer(conn, &created.id, &tail.layer)?
        };
        conn.execute(
            "UPDATE blocks SET postponed_from = ?1 WHERE id = ?2",
            rusqlite::params![tail.id, linked.id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_186, e = e))?;
        // round29 #3/#7（用户拍板：「临时安排漂出去不是要叫『临时安排』，是要跟父块名字一致」）：
        // 漂出去的**还是同一件事** —— 块自己的名字（label，005 迁移）要跟着走。
        // `create_block` 只带任务，名字得从这里补；优先链尾（它才是刚漂的那一块），其次源块。
        // round48：`⊘`（不计入理智）搬到了**任务**上 → 漂出来的块本来就是同一条任务，
        // 不在这里继承任何标记（round47 的 BK 那笔账随语义搬家自然消失）。
        if let Some(label) = tail.label.as_deref().or(source.label.as_deref()) {
            conn.execute(
                "UPDATE blocks SET label = ?1 WHERE id = ?2",
                rusqlite::params![label, linked.id],
            )
            .map_err(|e| tf!(i18n::msg::ERR_DB_187, e = e))?;
        }
        load_block(conn, &linked.id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_188).to_string())?
    };
    // round31：这一支预期「块数不变」（移动）或「+1」（新建）；再少就是融合吃掉了别的块
    let count_after = count_blocks(conn)?;
    let merged = count_after < count_before + if tail.status == "planned" { 0 } else { 1 };

    // C3.1：让新块**接替**链上的位置（源块优先，其次链尾 —— 同一条漂流链共享同一个位置）
    let position = match sequence_position(conn, &source.id)? {
        Some(found) => Some(found),
        None => sequence_position(conn, &tail.id)?,
    };

    let mut cascaded = 0usize;
    let mut history_moved = 0usize;
    if let Some((sequence_id, order_index)) = position {
        if let Err(e) = adopt_into_sequence(conn, &sequence_id, &new_block.id, order_index) {
            // 位置继承失败不该让漂流整个失败（比如恰好又被别的序列占了）→ 只记日志
            eprintln!("[db] {e}");
        }
        // 越序检查（C3.2）：漂到「前面那一环」之前也是错序 → 直接拒绝（用户拍板：顺序依赖）
        if let Some(previous) = previous_ring_block(conn, &sequence_id, order_index)? {
            if new_block.start_at < previous.start_at {
                return Err(
                    i18n::t(i18n::msg::ERR_DB_189)
                        .to_string(),
                );
            }
        }
        let (moved, history) =
            cascade_after_ring(conn, &sequence_id, order_index, &new_block, "postpone")?;
        cascaded = moved;
        history_moved = history;
    }

    record_event(
        conn,
        id,
        "postpone",
        Some(serde_json::json!({ "from": source.start_at, "to": new_start_at }).to_string()),
    )?;

    Ok(MoveOutcome {
        block: new_block,
        cascaded,
        history_moved,
        merge_hint: None,
        merged,
    })
}

/// 链上「前一环」的代表块（优先计划中的那个；整环都是历史则取最新的）——用于「不许排到它前面」的检查
fn previous_ring_block(
    conn: &Connection,
    sequence_id: &str,
    ring: i64,
) -> Result<Option<Block>, String> {
    let previous: Option<i64> = conn
        .query_row(
            "SELECT MAX(order_index) FROM sequence_members WHERE sequence_id = ?1 AND order_index < ?2",
            rusqlite::params![sequence_id, ring],
            |r| r.get(0),
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_190, e = e))?;
    let Some(previous) = previous else {
        return Ok(None);
    };

    let sql = format!(
        "SELECT {BLOCK_COLUMNS} FROM blocks b
         WHERE EXISTS (
             SELECT 1 FROM sequence_members m
             WHERE m.sequence_id = ?1 AND m.order_index = ?2 AND m.block_id = b.id
         )
         ORDER BY b.start_at, b.rowid"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| tf!(i18n::msg::ERR_DB_191, e = e))?;
    let members: Vec<Block> = stmt
        .query_map(rusqlite::params![sequence_id, previous], row_to_block)
        .map_err(|e| tf!(i18n::msg::ERR_DB_192, e = e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| tf!(i18n::msg::ERR_DB_193, e = e))?;

    Ok(members
        .iter()
        .find(|b| b.status == "planned")
        .cloned()
        .or_else(|| members.last().cloned()))
}

/// 越序级联（C3.2，用户拍板 R23 的细化）：
/// 把链上**排在 `ring` 之后**、且开始时间早于 `anchor` 的那些环往后顺延。
///
/// 每一环的规则：
/// - 有**计划中**的块 → 只顺延它们（残影留在原位，作为「我原本排在这儿」的历史）
/// - 整环**全是历史**（已完成/未完成、且没有活跃块）→ **连历史块也一起顺延**
///   （否则链会永远错序 —— 用户实测就是这个情况：② 已完成，① 却漂到了它后面）
///   —— 这一部分单独计数，好在界面上明说「其中有 N 个历史链节也被挪了」
///
/// 落点从 `anchor.end_at` 起依次往后排，并用 `snap_to_grid` 夹回时间轴格子。
/// 返回 `(顺延总数, 其中历史块数)`。
fn cascade_after_ring(
    conn: &Connection,
    sequence_id: &str,
    ring: i64,
    anchor: &Block,
    event_type: &str,
) -> Result<(usize, usize), String> {
    let mut cursor = anchor.end_at;
    let mut moved = 0usize;
    let mut history_moved = 0usize;

    // 先按「环」分组（同一环可能是「残影 + 它漂出来的新块」两节），再按环号从小到大处理
    // round64.1：关掉漂流时，隐藏的漂流子块不参与顺延（连「整环都是历史」的兜底也不拿它当代表）
    let hide_drift_children = drift_children_hidden(conn)?;
    let mut by_ring: std::collections::BTreeMap<i64, Vec<Block>> = std::collections::BTreeMap::new();
    for member in members_after(conn, sequence_id, ring)? {
        if hide_drift_children && member.postponed_from.is_some() {
            continue;
        }
        if member.start_at >= anchor.start_at {
            continue; // 本来就在锚点之后 → 不算被越过
        }
        let member_ring = sequence_position(conn, &member.id)?
            .map(|(_, index)| index)
            .unwrap_or(ring);
        by_ring.entry(member_ring).or_default().push(member);
    }

    for members in by_ring.values() {
        let mut targets: Vec<Block> = members
            .iter()
            .filter(|m| m.status == "planned")
            .cloned()
            .collect();
        if targets.is_empty() {
            // 整环都是历史：连历史一起顺延（取最新那一节）
            if let Some(latest) = members.iter().max_by_key(|m| m.start_at).cloned() {
                targets.push(latest);
            }
        }

        for member in targets {
            let length = member.end_at - member.start_at;
            let start = snap_to_grid(cursor);
            let end = start
                .checked_add(length)
                .ok_or_else(|| i18n::t(i18n::msg::ERR_DB_194).to_string())?;
            move_block(conn, &member.id, start, end)?;
            record_event(
                conn,
                &member.id,
                event_type,
                Some(
                    serde_json::json!({ "from": member.start_at, "to": start, "cascade": true })
                        .to_string(),
                ),
            )?;
            if member.status != "planned" {
                history_moved += 1;
            }
            cursor = end;
            moved += 1;
        }
    }

    if moved > 0 {
        eprintln!(
            "[db] 越序级联：顺延 {moved} 个后续链节（其中历史 {history_moved} 个）"
        );
    }
    Ok((moved, history_moved))
}

/// 改块（v2 ①51 的 `update_block(id, patch)`：`start_at` / `end_at` / `layer`）。
///
/// - 只给开始时间 → 保持原时长；只给结束时间 → 往前推开始时间（对称）
/// - **链感知（C3.2）**：不许排到「前面那一环」之前（那会立刻错序）；
///   若排到了后面那些环之后 → 被越过的环一起顺延（历史单独计数）
/// - 时间变了就清掉提醒记账（新时段该重新提醒）
pub fn update_block(
    conn: &Connection,
    id: &str,
    layer: Option<&str>,
    start_at: Option<i64>,
    end_at: Option<i64>,
    label: Option<&str>,
) -> Result<MoveOutcome, String> {
    let before = load_block(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_195).to_string())?;
    let mut block = match layer {
        Some(layer) => update_block_layer(conn, id, layer)?,
        None => before.clone(),
    };

    // C1.8（R33）：临时块的「就地命名」—— 与 layer/start/end 同一套 patch 语义：
    // 不传（None）= 不动；空串 = 清回默认名「临时安排」。
    if let Some(label) = label {
        let trimmed = label.trim();
        if trimmed.chars().count() > MAX_TITLE_CHARS {
            return Err(tf!(i18n::msg::ERR_DB_196, MAX_TITLE_CHARS = MAX_TITLE_CHARS));
        }
        let value = if trimmed.is_empty() { None } else { Some(trimmed) };
        conn.execute(
            "UPDATE blocks SET label = ?1 WHERE id = ?2",
            rusqlite::params![value, id],
        )
        .map_err(|e| tf!(i18n::msg::ERR_DB_197, e = e))?;
        block = load_block(conn, id)?.ok_or_else(|| i18n::t(i18n::msg::ERR_DB_198).to_string())?;
    }

    let duration = before.end_at - before.start_at;
    let new_time = match (start_at, end_at) {
        // 两头都给 = 显式时段（C1.1 拉伸走这条：起点不动、只改终点）
        (Some(start), Some(end)) => Some((start, end)),
        (Some(start), None) => Some((
            start,
            start
                .checked_add(duration)
                .ok_or_else(|| i18n::t(i18n::msg::ERR_DB_199).to_string())?,
        )),
        (None, Some(end)) => Some((
            end.checked_sub(duration)
                .ok_or_else(|| i18n::t(i18n::msg::ERR_DB_200).to_string())?,
            end,
        )),
        (None, None) => None,
    };

    let mut cascaded = 0usize;
    let mut history_moved = 0usize;
    if let Some((start, end)) = new_time {
        if start != before.start_at || end != before.end_at {
            validate_range(start, end)?;

            if let Some((sequence_id, ring)) = sequence_position(conn, id)? {
                if let Some(previous) = previous_ring_block(conn, &sequence_id, ring)? {
                    if start < previous.start_at {
                        return Err(
                            i18n::t(i18n::msg::ERR_DB_201)
                                .to_string(),
                        );
                    }
                }
                block = move_block(conn, id, start, end)?;
                let (moved, history) =
                    cascade_after_ring(conn, &sequence_id, ring, &block, "move")?;
                cascaded = moved;
                history_moved = history;
            } else {
                block = move_block(conn, id, start, end)?;
            }

            record_event(
                conn,
                id,
                "move",
                Some(
                    serde_json::json!({
                        "from": before.start_at,
                        "to": block.start_at,
                        "end_from": before.end_at,
                        "end_to": block.end_at,
                    })
                    .to_string(),
                ),
            )?;
        }
    }

    // C1.2：移动/拉伸之后同样检查一次融合（融合可能把它吃掉，那就换成幸存的那一块）
    let mut hint: Option<String> = None;
    let mut merged = false;
    if let Some(survivor) = merge_adjacent(conn, &block)? {
        block = survivor;
        merged = true;
    } else if let Some(kind) = merge_hint(conn, &block)? {
        // round27：没合上 → 顺手查一次「为什么」，让前端能给用户一句话（规则不散落在前端）
        hint = Some(kind.to_string());
    }

    Ok(MoveOutcome {
        block,
        cascaded,
        history_moved,
        merge_hint: hint,
        merged,
    })
}

/// 批量动作的汇总结果（round61 / 10.2）：前端据此弹一条提示（「已移动 N 块」等）。
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct BatchOutcome {
    /// 真正被改动的块数（跳过与失败的都不算）
    pub changed: usize,
    /// 整批合计**顺延**的后续链节数
    pub cascaded: usize,
    /// 其中「历史（已完成/未完成）」被挪动的个数
    pub history_moved: usize,
    /// 整批合计触发融合的块数（>0 时前端弹「已合并」）
    pub merged: usize,
    /// 没动成的块数（不存在 / 已标记不能挪 / 序列顺序约束 / 越界等）
    pub failed: usize,
}

/// round61（10.2 多选）：**批量平移** —— 逐块复用 `update_block`（含序列级联、融合、`move` 事件），
/// 一块失败不拖累其余（计入 `failed`）。`moves` = (块 id, 新起点)：起点由前端按**本地日历**算好
/// （与键盘单块移动同一套 `addLocalDays`，跨月/夏令时不错位）。
pub fn move_blocks(conn: &Connection, moves: &[(String, i64)]) -> Result<BatchOutcome, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| tf!(i18n::msg::ERR_DB_202, e = e))?;

    // round61.1（你验收实测「批量挪时间时两块被合了」）：先查清方向再**排序** ——
    // 逐块调用 `update_block`（内部会做融合检查）；若按原顺序，往右挪的第一块会扫过
    // **还没挪的邻居**的真位置 → 触发一次最终布局里不存在的**假融合**。
    // 修法：往右挪 → 从最右往左处理；往左挪 → 从最左往右（平移保序，相邻关系不会变）。
    let mut out = BatchOutcome::default();
    // 预扫描：把存在的块收进 items（缺失的当场记失败）；方向 = 各块位移之和
    let mut items: Vec<(String, i64, i64)> = Vec::with_capacity(moves.len());
    for (id, start_at) in moves {
        let Some(before) = load_block(&tx, id)? else {
            out.failed += 1;
            continue;
        };
        items.push((id.clone(), *start_at, before.start_at));
    }
    let net: i64 = items.iter().map(|(_, new, old)| new - old).sum();
    if net >= 0 {
        items.sort_by_key(|it| std::cmp::Reverse(it.2));
    } else {
        items.sort_by_key(|it| it.2);
    }

    for (id, start_at, _old) in &items {
        let Some(before) = load_block(&tx, id)? else {
            out.failed += 1; // 不存在（可能刚被别的块融合吃掉）
            continue;
        };
        if before.status != "planned" {
            out.failed += 1; // 已标记的块不能移动（与单块键盘/拖动同一条边界）
            continue;
        }
        if before.start_at == *start_at {
            continue; // 起点没变：不算改动，也不用写库
        }
        match update_block(&tx, id, None, Some(*start_at), None, None) {
            Ok(o) => {
                out.changed += 1;
                out.cascaded += o.cascaded;
                out.history_moved += o.history_moved;
                if o.merged {
                    out.merged += 1;
                }
            }
            Err(_) => out.failed += 1,
        }
    }
    tx.commit().map_err(|e| tf!(i18n::msg::ERR_DB_203, e = e))?;
    Ok(out)
}

/// round61（10.2 多选）：**批量改层** —— 逐块复用 `update_block`（改层同样走融合检查）。
/// 已标记的块也能改层（层是规划属性，与单块一致）；本来就该层的块跳过。
pub fn set_blocks_layer(
    conn: &Connection,
    ids: &[String],
    layer: &str,
) -> Result<BatchOutcome, String> {
    if !matches!(layer, "required" | "elastic") {
        return Err(i18n::t(i18n::msg::ERR_DB_204).to_string());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| tf!(i18n::msg::ERR_DB_205, e = e))?;
    let mut out = BatchOutcome::default();
    for id in ids {
        let Some(before) = load_block(&tx, id)? else {
            out.failed += 1;
            continue;
        };
        if before.layer == layer {
            continue; // 已经在这一层：不算改动
        }
        match update_block(&tx, id, Some(layer), None, None, None) {
            Ok(o) => {
                out.changed += 1;
                out.cascaded += o.cascaded;
                out.history_moved += o.history_moved;
                if o.merged {
                    out.merged += 1;
                }
            }
            Err(_) => out.failed += 1,
        }
    }
    tx.commit().map_err(|e| tf!(i18n::msg::ERR_DB_206, e = e))?;
    Ok(out)
}

/// 顺延用：把时刻夹回时间轴的格子（**00:00–24:00**、30 分钟一格；跨过 24:00 就挪到次日 00:00）
/// —— 否则顺延到 00:15 这种时刻会从界面上消失。
/// （2026-10-01 前这里是「06:00–24:00 的 18 小时窗」；用户拍板把时间轴改成整天，这里跟着改）
fn snap_to_grid(start_at: i64) -> i64 {
    use chrono::{Local, TimeZone};
    const DAY_START_HOUR: u32 = 0;
    const SLOT: i64 = 30 * 60;

    let Some(local) = Local.timestamp_opt(start_at, 0).single() else {
        return start_at;
    };
    let Some(day_start) = local
        .date_naive()
        .and_hms_opt(DAY_START_HOUR, 0, 0)
        .and_then(|naive| Local.from_local_datetime(&naive).single())
        .map(|dt| dt.timestamp())
    else {
        return start_at;
    };
    let day_end = day_start + 24 * 3600; // 00:00 → 次日 00:00

    let mut candidate = start_at.max(day_start);
    let offset = candidate - day_start;
    let remainder = offset % SLOT;
    if remainder != 0 {
        candidate += SLOT - remainder;
    }
    if candidate >= day_end {
        candidate = day_start + 24 * 3600; // 次日 00:00
    }
    candidate
}

fn load_block(conn: &Connection, id: &str) -> Result<Option<Block>, String> {
    let sql = format!("SELECT {BLOCK_COLUMNS} FROM blocks WHERE id = ?1");
    conn.query_row(&sql, [id], row_to_block)
        .optional()
        .map_err(|e| tf!(i18n::msg::ERR_DB_207, e = e))
}

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        category: row.get(2)?,
        created_at: row.get(3)?,
        is_elastic: row.get(4)?,
        estimated_minutes: row.get(5)?,
        archived_at: row.get(6)?,
        sanity_exempt: row.get::<_, i64>(7)? != 0,
        sort_order: row.get(8)?,
    })
}

fn row_to_block(row: &rusqlite::Row<'_>) -> rusqlite::Result<Block> {
    let layer: String = row.get(7)?;
    let external_source: Option<String> = row.get(8)?;
    let task_id: String = row.get(1)?;
    Ok(Block {
        id: row.get(0)?,
        // round28 #2：派生字段（与 `priority` 同一套做法）—— 前端不再猜任务 id
        is_temp: task_id == TEMP_TASK_ID,
        task_id,
        start_at: row.get(2)?,
        end_at: row.get(3)?,
        status: row.get(4)?,
        last_notified_at: row.get(5)?,
        created_at: row.get(6)?,
        priority: priority::of(&layer, external_source.as_deref())
            .as_str()
            .to_string(),
        layer,
        external_source,
        final_status: row.get(9)?,
        postponed_from: row.get(10)?,
        label: row.get(11)?,
        // round45：SQLite 的 0/1 → bool（与 `is_temp` 一样是展示层关心的东西，但这一列是**落库**的）
        sanity_exempt: row.get::<_, i64>(12)? != 0,
        // round69（B3）：不在 SELECT 里 —— 由 `list_blocks` 的 `attach_repeat_notes` 补
        repeat_note: None,
    })
}

/// 测试专用：内存数据库 + 已跑迁移 + 已开外键（db.rs 与 notify.rs 共用，I1）
#[cfg(test)]
pub(crate) fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("打开内存数据库失败");
    conn.pragma_update(None, "foreign_keys", true)
        .expect("开启外键约束失败");
    migrate(&conn).expect("迁移失败");
    conn
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::due_blocks;
    use crate::notify::priority::Priority;

    /// 测试用临时目录：**Drop 时自动删**（断言失败 / panic 也会删）。
    /// round62 起抽到 `crate::testutil`，与备份测试共用同一份。
    use crate::testutil::TempDir;

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [name],
            |_| Ok(true),
        )
        .optional()
        .expect("查询 sqlite_master 失败")
        .unwrap_or(false)
    }

    /// C1.4：004 迁移把老库里的「建议层」块转成弹性层 —— 模拟「老数据库 + 新程序」
    /// C1.5：快照 → 大改一通 → 恢复，数据与链关系都得回到原样（“逆操作”写法盖不住的那些也盖住）
    #[test]
    fn test_snapshot_restore_round_trip() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let seq = create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");
        let snap = dump_tables(&conn).expect("拍快照失败");

        // 改一大堆：移动 a、删 b（连带链节）、再新建两块
        update_block(&conn, &a.id, None, Some(2_000), None, None).expect("移动失败");
        delete_block(&conn, &b.id).expect("删除失败");
        create_block(&conn, &task.id, 9_000, 10_800).expect("建块失败");

        restore_tables(&conn, &snap).expect("恢复失败");

        let blocks = list_blocks(&conn, 0, 20_000).expect("查询失败");
        assert_eq!(blocks.len(), 2, "块数回到 2");
        let a_after = load_block(&conn, &a.id).expect("查询失败").expect("块在");
        assert_eq!(a_after.start_at, 1_000, "时间回到原位");
        let b_after = load_block(&conn, &b.id).expect("查询失败").expect("块在");
        assert_eq!(b_after.end_at, 4_800, "被删的块也回来了");
        let seq_after = get_sequence(&conn, &seq.id).expect("查询失败").expect("序列在");
        assert_eq!(ids(&seq_after), vec![a.id.clone(), b.id.clone()], "链节与环序都回来");
        assert_chain_consistent(&conn, &seq.id);
    }

    /// C1.5：恢复会连带把 `events` 一起还原（撤销一次误标的 ✓/✗，统计里不留痕）
    #[test]
    fn test_snapshot_restore_reverts_events_too() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let block = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let snap = dump_tables(&conn).expect("拍快照失败");
        let before = event_count(&conn, &block.id);

        mark_block_done(&conn, &block.id).expect("标记失败");
        assert!(event_count(&conn, &block.id) > before, "标记应写一条事件");

        restore_tables(&conn, &snap).expect("恢复失败");
        assert_eq!(event_count(&conn, &block.id), before, "事件也回到标记前");
        let after = load_block(&conn, &block.id).expect("查询失败").expect("块在");
        assert_eq!(after.status, "planned", "状态回到计划中");
    }

    /// C1.5 顺手补的旧缺口：标记完成/未完成要写 `complete` / `skip` 事件（v2 ③3.4 的事件类型里有它俩，
    /// C6 的「跳过 30%」权重就靠它），而且**已标记的块不再重复写**（幂等语义不变）
    #[test]
    fn test_mark_writes_complete_and_skip_events_once() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");

        let types = |id: &str| -> Vec<String> {
            let mut stmt = conn
                .prepare(
                    "SELECT event_type FROM events WHERE block_id = ?1
                     AND event_type IN ('complete','skip') ORDER BY rowid",
                )
                .expect("准备查询失败");
            let rows = stmt
                .query_map([id], |r| r.get::<_, String>(0))
                .expect("查询失败");
            rows.map(|r| r.expect("读行失败")).collect()
        };

        mark_block_done(&conn, &a.id).expect("标记完成失败");
        mark_block_missed(&conn, &b.id).expect("标记未完成失败");
        assert_eq!(types(&a.id), vec!["complete"]);
        assert_eq!(types(&b.id), vec!["skip"]);

        // 已标记的块再标记：状态不回退、也不该多写事件
        mark_block_done(&conn, &a.id).expect("重复标记应幂等");
        mark_block_missed(&conn, &a.id).expect("重复标记应幂等");
        assert_eq!(types(&a.id), vec!["complete"], "不该再写第二条事件");
    }

    /// round60（10.1 统计页）：标 ✓ 的事件带上计划时段时长（分钟）；标 ✗ 不带
    #[test]
    fn test_mark_complete_event_carries_minutes() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败"); // 30 分钟
        let b = create_block(&conn, &task.id, 4_000, 8_500).expect("建块失败"); // 75 分钟
        // round69.1（#9）：用固定时刻标完成 → 延迟可预知（1_300 − 1_000 = 300 秒 = 5 分钟）
        mark_block_done_at(&conn, &a.id, 1_300).expect("标记完成失败");
        mark_block_missed(&conn, &b.id).expect("标记未完成失败");

        let payload: String = conn
            .query_row(
                "SELECT payload FROM events WHERE block_id = ?1 AND event_type = 'complete'",
                [&a.id],
                |r| r.get(0),
            )
            .expect("complete 事件未记录");
        // `minutes` = 计划时长（统计口径）；`delay_minutes` = 标 ✓ 时刻 − 计划开始（「快不过光速」看它）
        assert_eq!(payload, "{\"delay_minutes\":5,\"minutes\":30}");
        let skip_payload: Option<String> = conn
            .query_row(
                "SELECT payload FROM events WHERE block_id = ?1 AND event_type = 'skip'",
                [&b.id],
                |r| r.get(0),
            )
            .expect("skip 事件未记录");
        assert_eq!(skip_payload, None, "标 ✗ 没有时长可记");
    }

    /// round82（统-08 · 用户拍的 ①）：完成账带上**任务那一刻的分类快照** —— 旧账没有这个字段
    /// （统计页把它们归入「早期数据（无分类）」）；临时块 / 没设分类的任务不写字段。
    #[test]
    fn test_mark_complete_event_carries_category_snapshot() {
        let conn = test_conn();
        let task = create_task(&conn, "写周报", Some("工作")).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let temp = create_temp_block(&conn, 5_000, 6_800).expect("建临时块失败");
        let plain = create_task(&conn, "无分类任务", None).expect("建任务失败");
        let b = create_block(&conn, &plain.id, 7_000, 8_800).expect("建块失败");

        mark_block_done_at(&conn, &a.id, 1_300).expect("标记完成失败");
        mark_block_done_at(&conn, &temp.id, 5_300).expect("标记完成失败");
        mark_block_done_at(&conn, &b.id, 7_300).expect("标记完成失败");

        let payload = |id: &str| -> String {
            conn.query_row(
                "SELECT payload FROM events WHERE block_id = ?1 AND event_type = 'complete'",
                [id],
                |r| r.get(0),
            )
            .expect("complete 事件未记录")
        };
        assert_eq!(
            payload(&a.id),
            r#"{"category":"工作","delay_minutes":5,"minutes":30}"#,
            "有分类 → 快照写进 payload（以后改分类不回改旧账）"
        );
        assert_eq!(
            payload(&temp.id),
            r#"{"delay_minutes":5,"minutes":30}"#,
            "临时块没有分类 → 不写字段（统计归入「早期数据（无分类）」）"
        );
        assert_eq!(
            payload(&b.id),
            r#"{"delay_minutes":5,"minutes":30}"#,
            "任务没设分类 → 同样不写字段"
        );
    }

    /// round61（10.2 多选）：批量删除 —— 子树并集去重、整批只记一条 `delete`（count = 合计）
    #[test]
    fn test_delete_blocks_dedupes_subtrees_and_logs_one_event() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let other = create_task(&conn, "游戏", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &other.id, 4_000, 5_800).expect("建块失败");
        // a 已结束（链尾结束）→ 漂出一个后续块 child（它已会被 a 的子树带走）
        mark_block_missed(&conn, &a.id).expect("预置未完成");
        let child = postpone_block(&conn, &a.id, 7_000)
            .expect("漂移失败")
            .block;

        let deleted = delete_blocks(&conn, &[a.id.clone(), child.id.clone(), b.id.clone()])
            .expect("批量删除失败");
        assert_eq!(deleted, 3, "a + 它的漂流子块 + b；child 不重复计数");
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))
            .expect("统计失败");
        assert_eq!(left, 0);

        let events: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT payload FROM events WHERE event_type = 'delete' ORDER BY rowid")
                .expect("准备失败");
            stmt.query_map([], |r| r.get::<_, String>(0))
                .expect("查询失败")
                .map(|r| r.expect("读行失败"))
                .collect()
        };
        assert_eq!(events.len(), 1, "整批只记一条 delete 事件");
        assert!(events[0].contains("\"count\":3"), "payload 应含 3：{}", events[0]);

        // 全部 id 都不存在时：删 0 个、不记事件（与单块幂等口径一致）
        assert_eq!(
            delete_blocks(&conn, &[a.id.clone(), b.id]).expect("重复删除应幂等"),
            0
        );
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM events WHERE event_type = 'delete'", [], |r| r.get(0))
            .expect("统计失败");
        assert_eq!(n, 1, "没删到东西就不该记账");
    }

    /// round61（10.2 多选）：批量标记 —— 只动 planned、幂等、跳过不存在、非法状态报错
    #[test]
    fn test_mark_blocks_planned_only_and_idempotent() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 4_000, 5_800).expect("建块失败");
        let c = create_block(&conn, &task.id, 7_000, 8_800).expect("建块失败");
        mark_block_missed(&conn, &c.id).expect("预置未完成");

        let n = mark_blocks(&conn, &[a.id.clone(), b.id.clone(), c.id.clone()], "done")
            .expect("批量标 ✓ 失败");
        assert_eq!(n, 2, "只动 planned 的 a / b；已标记的 c 不回退");
        assert_eq!(load_block(&conn, &a.id).unwrap().unwrap().status, "done");
        assert_eq!(load_block(&conn, &b.id).unwrap().unwrap().status, "done");
        assert_eq!(load_block(&conn, &c.id).unwrap().unwrap().status, "missed");
        let completes: i64 = conn
            .query_row("SELECT COUNT(*) FROM events WHERE event_type = 'complete'", [], |r| r.get(0))
            .expect("统计失败");
        assert_eq!(completes, 2, "每块各记一条 complete（统计页按块数算）");

        // 幂等：再来一次 0 块；不存在的 id 跳过；非法状态报错
        assert_eq!(
            mark_blocks(&conn, &[a.id.clone(), "nope".to_string()], "done").expect("幂等"),
            0
        );
        assert!(mark_blocks(&conn, std::slice::from_ref(&b.id), "bogus").is_err());
    }

    /// round61（10.2 多选）：批量平移 —— 逐块挪；已标记/不存在的计入 failed；时长不变
    #[test]
    fn test_move_blocks_skips_done_and_missing() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 4_000, 5_800).expect("建块失败");
        mark_block_done(&conn, &b.id).expect("预置完成");

        let out = move_blocks(
            &conn,
            &[
                (a.id.clone(), 1_000 + 86_400),
                (b.id.clone(), 4_000 + 86_400),
                ("nope".to_string(), 5_000),
            ],
        )
        .expect("批量移动失败");
        assert_eq!(out.changed, 1, "只有 planned 的 a 真的动了");
        assert_eq!(out.failed, 2, "已完成的 b 与不存在的 id 都没动成");

        let moved = load_block(&conn, &a.id)
            .expect("查询失败")
            .expect("块还在");
        assert_eq!(moved.start_at, 1_000 + 86_400);
        assert_eq!(moved.end_at, 2_800 + 86_400, "时长保持");
        let moves: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE event_type = 'move' AND block_id = ?1",
                [&a.id],
                |r| r.get(0),
            )
            .expect("统计失败");
        assert_eq!(moves, 1, "只给真动过的块记 move 事件");
    }

    /// round61.1（你验收实测）：批量平移先按方向排序 ——
    /// 否则「先挪的块」会扫过**还没挪的邻居**，触发最终布局里不存在的假融合
    #[test]
    fn test_move_blocks_orders_by_direction_to_avoid_false_merge() {
        let conn = test_conn();
        let task = create_task(&conn, "多选靶子", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 9 * 3600, 9 * 3600 + 1800).expect("建块失败");
        let b = create_block(&conn, &task.id, 10 * 3600, 10 * 3600 + 1800).expect("建块失败");

        // 两块各 +45 分钟：最终布局 9:45 / 10:45（不相接）——
        // 不排序时会把 a 先挪到 9:45，撞上还没挪的 b（10:00–10:30）→ 假融合
        let out = move_blocks(
            &conn,
            &[
                (a.id.clone(), 9 * 3600 + 2700),
                (b.id.clone(), 10 * 3600 + 2700),
            ],
        )
        .expect("批量移动失败");
        assert_eq!(out.changed, 2);
        assert_eq!(out.merged, 0, "最终布局里两块不相接，不该融合");
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))
            .expect("统计失败");
        assert_eq!(left, 2, "两块都还在");
    }

    /// round61（10.2 多选）：批量改层 —— 逐块设层；本来就在该层/不存在的跳过
    #[test]
    fn test_set_blocks_layer_counts_changes() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 4_000, 5_800).expect("建块失败");
        update_block_layer(&conn, &b.id, "required").expect("预置必填");

        let out =
            set_blocks_layer(&conn, &[a.id.clone(), b.id.clone(), "nope".to_string()], "required")
                .expect("批量改层失败");
        assert_eq!(out.changed, 1, "a 从 elastic 变 required；b 本来就在该层");
        assert_eq!(out.failed, 1, "不存在的 id 计入 failed");
        assert_eq!(load_block(&conn, &a.id).unwrap().unwrap().layer, "required");
        assert!(
            set_blocks_layer(&conn, std::slice::from_ref(&a.id), "bogus").is_err(),
            "非法层要报错"
        );
    }

    /// C1.2 融合（边界 1~3）：**正好相接**才合、保留较早那块、区间取并集（重叠不合）
    #[test]
    fn test_merge_adjacent_combines_touching_neighbours() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        // 相接 → create_block 自己就合了（返回幸存的那一块）
        let after = create_block(&conn, &task.id, 2_800, 6_400).expect("建块失败");
        assert_eq!(after.id, a.id, "保留较早的那一块");
        assert_eq!(after.start_at, 1_000);
        assert_eq!(after.end_at, 6_400, "区间取并集");
        assert_eq!(list_blocks(&conn, 0, 10_000).unwrap().len(), 1, "只剩一行");

        // 完全重叠（用户实测：同一时间并排的两块）→ **也要合**（create_block 返回的是幸存块）
        let _merged = create_block(&conn, &task.id, 5_000, 6_800).expect("建块失败");
        let rows = list_blocks(&conn, 0, 10_000).unwrap();
        assert_eq!(rows.len(), 1, "重叠也要合并");
        assert_eq!(rows[0].id, a.id, "保留较早那块");
        assert_eq!(rows[0].end_at, 6_800, "区间取并集");
    }

    /// C1.2 融合（边界 4~5）：有间隔、不同任务 → 不合并
    #[test]
    fn test_merge_adjacent_skips_gap_and_other_task() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let _a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let gap = create_block(&conn, &task.id, 4_000, 5_800).expect("建块失败");
        assert!(merge_adjacent(&conn, &gap).expect("查询失败").is_none(), "中间空着不合并");

        let other = create_task(&conn, "读书", None).expect("建任务失败");
        let other_block = create_block(&conn, &other.id, 2_800, 4_000).expect("建块失败");
        assert!(merge_adjacent(&conn, &other_block).expect("查询失败").is_none(), "不同任务不合并");
        assert_eq!(list_blocks(&conn, 0, 10_000).unwrap().len(), 3, "一个都没少");
    }

    /// round25 §5-S：两个长块相接、并集超过时长上限（3 天）→ **不融合**，而且**不报错**。
    /// （旧实现直接 `validate_range` → Err：用户只是把块拖到旁边一个长块旁，就看到红字提示 ✗）
    #[test]
    fn test_merge_adjacent_skips_when_union_exceeds_cap() {
        let conn = test_conn();
        let task = create_task(&conn, "长块", None).expect("建任务失败");
        // 两块各 40 小时、首尾相接 → 并集 80 小时 > 72 小时上限
        let a = create_block(&conn, &task.id, 0, 40 * 3_600).expect("建块失败");
        let b = create_block(&conn, &task.id, 40 * 3_600, 80 * 3_600).expect("建块失败");
        assert!(
            merge_adjacent(&conn, &a).expect("不该报错").is_none(),
            "并集超上限时应该跳过融合，而不是报错"
        );
        assert!(
            merge_adjacent(&conn, &b).expect("不该报错").is_none(),
            "从哪一边问都一样：不融合"
        );
        assert_eq!(
            list_blocks(&conn, 0, 1_000_000).expect("查询失败").len(),
            2,
            "两块都还在（一个都没被吃掉）"
        );
    }

    // ---------------------------------------------------------------- C1.8 临时安排块（R33）

    /// C1.8（R33）：临时块挂**全局隐藏任务** —— `list_tasks` 天然不列（Backlog 看不见），
    /// 且确保隐藏任务是幂等的（建两个临时块也只多出一块任务行，不是两块）。
    #[test]
    fn test_create_temp_block_uses_hidden_task() {
        let conn = test_conn();
        let before = list_tasks(&conn).expect("查任务失败");
        let a = create_temp_block(&conn, 1_000, 2_800).expect("建临时块失败");
        let b = create_temp_block(&conn, 4_000, 5_800).expect("建临时块失败");

        assert_eq!(a.task_id, TEMP_TASK_ID, "临时块挂的是那块隐藏任务");
        assert!(a.is_temp, "round28 #2：临时块必须带 is_temp（前端据此显示「临时安排」/斜体）");
        assert_eq!(a.label, None, "没命名时 label 为空（界面显示「临时安排」）");
        assert_ne!(a.id, b.id);
        // round28 #2：隐藏任务现在**会**出现在 list_tasks 里（好让块的标题能解析），
        // 但它是归档的 → Backlog 视图按 archived_at 过滤，用户看不到它。
        let listed = list_tasks(&conn).expect("查任务失败");
        let hidden = listed
            .iter()
            .find(|t| t.id == TEMP_TASK_ID)
            .expect("隐藏任务应该在 list_tasks 里（否则临时块没名字）");
        assert!(hidden.archived_at.is_some(), "隐藏任务是归档的 → Backlog 视图过滤掉它");
        assert_eq!(
            listed.len(),
            before.len() + 1,
            "比起步时只多出那一块隐藏任务（幂等）；Backlog 上看不见它"
        );
        let task_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE id = ?1",
                [TEMP_TASK_ID],
                |r| r.get(0),
            )
            .expect("查隐藏任务失败");
        assert_eq!(task_rows, 1, "隐藏任务只能有一行（INSERT OR IGNORE 幂等）");
    }

    /// C1.8（R33）：两个临时块挨着/重叠也**绝不融合** —— 它们全挂在同一个隐藏任务上，
    /// 按「同任务」规则会被自动合掉（两个不相干的临时安排不是同一件事）。
    /// 也验「删临时块不动隐藏任务」（边界 27）。
    #[test]
    fn test_temp_blocks_never_merge() {
        let conn = test_conn();
        let a = create_temp_block(&conn, 1_000, 2_800).expect("建临时块失败");
        let b = create_temp_block(&conn, 2_800, 4_600).expect("建临时块失败"); // 首尾相接
        assert!(
            merge_adjacent(&conn, &a).expect("不该报错").is_none(),
            "相接的临时块也不融"
        );
        assert!(
            merge_adjacent(&conn, &b).expect("不该报错").is_none(),
            "从哪一边问都一样：不融"
        );
        let (merged, _) = merge_all_pending(&conn).expect("扫描失败");
        assert_eq!(merged, 0, "加载时的幂等扫描也不能合临时块");
        assert_eq!(list_blocks(&conn, 0, 10_000).expect("查询失败").len(), 2, "两块都还在");

        // 删掉其中一块：隐藏任务仍在（只是 Backlog 本来就不显示它）
        delete_block(&conn, &a.id).expect("删除失败");
        assert!(load_block(&conn, &a.id).expect("查询失败").is_none());
        let task_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE id = ?1",
                [TEMP_TASK_ID],
                |r| r.get(0),
            )
            .expect("查隐藏任务失败");
        assert_eq!(task_rows, 1, "删块不该连隐藏任务一起删");
    }

    /// C1.8（R33）：临时块的「就地命名」—— `update_block` 的 label patch：
    /// 不传 = 不动；传值 = 存下来；传空串 = 清回默认名；过长要拦住。
    #[test]
    fn test_update_block_label_patch() {
        let conn = test_conn();
        let block = create_temp_block(&conn, 1_000, 2_800).expect("建临时块失败");

        let named = update_block(&conn, &block.id, None, None, None, Some("  写方案  "))
            .expect("改块名失败")
            .block;
        assert_eq!(named.label.as_deref(), Some("写方案"), "两端空白要去掉");
        assert_eq!(
            load_block(&conn, &block.id).expect("查询失败").expect("块在").label.as_deref(),
            Some("写方案"),
            "真落库了"
        );

        // 不传 label → 名字不变（只挪时间也一样）
        let moved = update_block(&conn, &block.id, None, Some(5_000), None, None)
            .expect("移动失败")
            .block;
        assert_eq!(moved.label.as_deref(), Some("写方案"), "不动别的 patch 时名字不该被清掉");

        let cleared = update_block(&conn, &block.id, None, None, None, Some("   "))
            .expect("清块名失败")
            .block;
        assert_eq!(cleared.label, None, "空白串 = 清回默认名「临时安排」");

        let too_long = "字".repeat(MAX_TITLE_CHARS + 1);
        assert!(
            update_block(&conn, &block.id, None, None, None, Some(&too_long)).is_err(),
            "块名过长要拦住（与任务名同一个上限）"
        );
    }

    /// round30（用户 2026-10-02 的长账，他给的步骤）：同一个任务上下放两块（不重叠）→
    /// 把**下面那块的上边缘**往上拖到上面那块的**上面** → 必须合成一块。
    /// 现场条件：无序列、无漂流、同层（都是从 Backlog 拖出来的弹性块）、都 planned。
    #[test]
    fn test_stretch_top_edge_over_neighbour_merges() {
        let conn = test_conn();
        let task = create_task(&conn, "1", None).expect("建任务失败");
        let top = create_block(&conn, &task.id, 9_000, 10_800).expect("放上面那块失败");
        let bottom = create_block(&conn, &task.id, 12_000, 13_800).expect("放下面那块失败");

        // 拉伸走的就是 update_block(id, startAt, endAt)：起点指到上一块之前，终点不动
        let outcome = update_block(&conn, &bottom.id, None, Some(8_000), Some(13_800), None)
            .expect("拉伸失败");

        let all = list_blocks(&conn, 0, 20_000).expect("查询失败");
        assert_eq!(all.len(), 1, "同任务同层、重叠就该合：{all:#?}");
        assert_eq!(all[0].start_at, 8_000);
        assert_eq!(all[0].end_at, 13_800);
        assert_eq!(outcome.merge_hint, None, "合上了就不该掉「没能合」的解释");
        assert!(outcome.merged, "round31：融合要回报给前端（融合提示）");
        assert_ne!(top.id, bottom.id);
    }

    /// round30：同一个任务上下放两块（不重叠）→ 把**下面那块**整体拖上去压住上面那块 →
    /// 同样必须合（这是拖块体那条路，与拉伸共用 update_block）
    #[test]
    fn test_move_over_neighbour_merges() {
        let conn = test_conn();
        let task = create_task(&conn, "1", None).expect("建任务失败");
        let top = create_block(&conn, &task.id, 9_000, 10_800).expect("放上面那块失败");
        let bottom = create_block(&conn, &task.id, 12_000, 13_800).expect("放下面那块失败");

        // 只给 startAt（拖动 = 平移，时长不变）—— 把它挪到与 top 重叠
        let outcome =
            update_block(&conn, &bottom.id, None, Some(9_500), None, None).expect("拖动失败");

        let all = list_blocks(&conn, 0, 20_000).expect("查询失败");
        assert_eq!(all.len(), 1, "同任务同层、重叠就该合：{all:#?}");
        assert_eq!(all[0].start_at, 9_000, "保留起点更早的那块");
        assert_eq!(all[0].end_at, 11_300, "并集 = 9000..11300");
        assert_eq!(outcome.merge_hint, None);
        assert!(outcome.merged, "round31：拖动压上去融合也要回报");
        assert_ne!(top.id, bottom.id);
    }

    /// C1.2 融合（边界 6~9）：层不同 / 已标记 / 在序列里 / 在漂流链上 → 都不合并
    #[test]
    fn test_merge_adjacent_skips_layer_status_sequence_and_drift() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");

        // 层不同：先把第二块放在远处、改层，再拖到相接位置（移动会走融合检查）
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 50_000, 51_800).expect("建块失败");
        update_block_layer(&conn, &b.id, "required").expect("改层失败");
        let layer_out =
            update_block(&conn, &b.id, None, Some(2_800), None, None).expect("移动失败");
        assert_eq!(list_blocks(&conn, 0, 60_000).unwrap().len(), 2, "层不同不合并");
        // round27：「层不同」是显而易见的原因，不该吐提示（否则拖哪都弹）
        assert_eq!(layer_out.merge_hint, None, "层不同不提示");
        assert!(!layer_out.merged, "round31：没合就别报融合提示");

        // 已标记：放到 a2 右边
        let a2 = create_block(&conn, &task.id, 100_000, 101_800).expect("建块失败");
        let c = create_block(&conn, &task.id, 102_000, 103_800).expect("建块失败");
        mark_block_done(&conn, &c.id).expect("标记失败");
        let done_out =
            update_block(&conn, &c.id, None, Some(101_800), None, None).expect("移动失败");
        assert_eq!(list_blocks(&conn, 90_000, 110_000).unwrap().len(), 2, "已标记不合并");
        assert_eq!(done_out.merge_hint, None, "已标记不提示");

        // 在序列里
        let d = create_block(&conn, &task.id, 200_000, 201_800).expect("建块失败");
        let e = create_block(&conn, &task.id, 202_000, 203_800).expect("建块失败");
        create_sequence(&conn, "链", &[d.id.clone(), e.id.clone()]).expect("建序列失败");
        let seq_out =
            update_block(&conn, &e.id, None, Some(201_800), None, None).expect("移动失败");
        assert_eq!(list_blocks(&conn, 190_000, 210_000).unwrap().len(), 2, "在序列里不合并");
        assert_eq!(
            seq_out.merge_hint.as_deref(),
            Some("sequence"),
            "round27：得能告诉用户「它在序列里，所以没合」"
        );

        // 漂流链上
        let ghost = create_block(&conn, &task.id, 300_000, 301_800).expect("建块失败");
        mark_block_missed(&conn, &ghost.id).expect("标记失败");
        let moved = postpone_block(&conn, &ghost.id, 302_000).expect("漂流失败").block;
        let adjacent = create_block(&conn, &task.id, 303_800, 305_600).expect("建块失败");
        let drift_out =
            update_block(&conn, &adjacent.id, None, Some(303_800), None, None).expect("移动失败");
        // 漂流那条链上共 3 行（残影 + 漂出来的块 + 新块），所以只断言“这两块都还在”
        let m = load_block(&conn, &moved.id).expect("查询失败").expect("漂流块还在");
        assert_eq!(m.start_at, 302_000, "漂流链上的块不该被吃掉");
        let adj = load_block(&conn, &adjacent.id).expect("查询失败").expect("新块还在");
        assert_eq!(adj.start_at, 303_800, "相接也不合（它在漂流链旁边）");
        // round27（用户 round26 验收 #3）：他自己撞上的就是这个 —— 得告诉他原因
        assert_eq!(
            drift_out.merge_hint.as_deref(),
            Some("drift"),
            "拖到漂流链旁边要能说出「它在漂流链上」"
        );
        let _ = (a, a2, d);
    }

    /// C1.2 融合（边界 11）：新建块落在旁边 → 融合，且**返回幸存的那一块**
    #[test]
    fn test_create_block_merges_into_neighbour_and_returns_survivor() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let merged = create_block(&conn, &task.id, 2_800, 4_600).expect("建块失败");
        assert_eq!(merged.id, a.id, "返回的是幸存块（不是刚建的那行）");
        assert_eq!(merged.end_at, 4_600);
        assert_eq!(list_blocks(&conn, 0, 10_000).unwrap().len(), 1, "只剩一行");
    }

    /// C1.2 融合（边界 10）：拉伸到与人相接 → 也融合
    #[test]
    fn test_update_block_merges_after_stretch() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 5_000, 6_800).expect("建块失败");

        let outcome = update_block(&conn, &a.id, None, Some(1_000), Some(5_000), None).expect("拉伸失败");
        assert_eq!(outcome.block.start_at, 1_000, "起点不动");
        assert_eq!(outcome.block.end_at, 6_800, "拉伸到相接 → 融合成一块");
        assert!(load_block(&conn, &b.id).expect("查询失败").is_none(), "被吃掉的那块没了");
        assert_eq!(list_blocks(&conn, 0, 10_000).unwrap().len(), 1);
    }

    #[test]
    fn test_migration_004_converts_legacy_suggested_blocks() {
        let tmp = TempDir::new("wakeyweeky-test");
        let db_path = tmp.join("wakeyweeky.sqlite");

        let conn = init(&db_path).expect("init 失败");
        let task = create_task(&conn, "老数据", None).expect("建任务失败");
        let block = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        // 手动造出「老库里才有」的建议层（**不依赖 create_block 的默认值**：默认值本步之后就会改）
        conn.execute(
            "UPDATE blocks SET layer = 'suggested' WHERE id = ?1",
            [&block.id],
        )
        .expect("造老数据失败");
        // 模拟「这个库还没跑过 004」
        conn.execute("DELETE FROM schema_migrations WHERE version = '004'", [])
            .expect("清 004 记录失败");
        drop(conn);

        let conn = init(&db_path).expect("第二次 init（应应用 004）失败");
        let layer: String = conn
            .query_row("SELECT layer FROM blocks WHERE id = ?1", [&block.id], |r| {
                r.get(0)
            })
            .expect("查询失败");
        assert_eq!(layer, "elastic", "004 应把建议层并入弹性层");
    }

    /// C1.4：004 是幂等的 —— 再跑一次不改数据、也不重复记账
    #[test]
    fn test_migration_004_is_idempotent() {
        let tmp = TempDir::new("wakeyweeky-test");
        let db_path = tmp.join("wakeyweeky.sqlite");

        let conn = init(&db_path).expect("init 失败");
        let task = create_task(&conn, "老数据", None).expect("建任务失败");
        let block = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        conn.execute(
            "UPDATE blocks SET layer = 'suggested' WHERE id = ?1",
            [&block.id],
        )
        .expect("造老数据失败");
        conn.execute("DELETE FROM schema_migrations WHERE version = '004'", [])
            .expect("清 004 记录失败");
        drop(conn);

        let _ = init(&db_path).expect("应用 004 失败");
        let conn = init(&db_path).expect("再 init 一次失败");
        let layer: String = conn
            .query_row("SELECT layer FROM blocks WHERE id = ?1", [&block.id], |r| {
                r.get(0)
            })
            .expect("查询失败");
        assert_eq!(layer, "elastic", "第二次跑不应把值改回去或改坏");
        let recorded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = '004'",
                [],
                |r| r.get(0),
            )
            .expect("统计 004 记录失败");
        assert_eq!(recorded, 1, "004 只该记一次账");
    }

    #[test]
    fn test_migrations_idempotent() {
        let tmp = TempDir::new("wakeyweeky-test");
        let db_path = tmp.join("wakeyweeky.sqlite");

        let conn = init(&db_path).expect("第一次 init 失败");
        let conn2 = init(&db_path).expect("第二次 init 失败");

        // 迁移确实建出了表，而不是「什么都没做也没报错」
        assert!(table_exists(&conn, "tasks"));
        assert!(table_exists(&conn, "blocks"));
        assert!(table_exists(&conn, "schema_migrations"));
        let recorded: i64 = conn2
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .expect("统计迁移记录失败");
        assert_eq!(
            recorded,
            MIGRATIONS.len() as i64,
            "重复 init 不应重复记录迁移：每条迁移只记一次"
        );

        drop(conn);
        drop(conn2);
        // 目录由 TempDir 的 Drop 收拾
    }

    /// round68（19.1）：010 迁移建出 `achievements` 表；
    /// 且它**不在撤销快照里** —— 成就一旦点亮就不可被 Ctrl+Z 退回（断了不惩罚）。
    #[test]
    fn test_migration_010_creates_achievements_and_keeps_it_out_of_snapshot() {
        let conn = test_conn();
        assert!(table_exists(&conn, "achievements"), "010 应建出 achievements 表");

        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(achievements)")
            .expect("准备读表结构失败")
            .query_map([], |r| r.get::<_, String>(1))
            .expect("读表结构失败")
            .collect::<Result<_, _>>()
            .expect("收集列名失败");
        assert_eq!(cols, vec!["id", "unlocked_at", "progress"], "列清单要稳定（id / 解锁时刻 / 进度）");

        assert!(
            !SNAPSHOT_TABLES.contains(&"achievements"),
            "achievements 绝不能进撤销快照：徽章不跟着 Ctrl+Z 回滚"
        );
        assert!(
            !RESTORE_DELETE_ORDER.contains(&"achievements"),
            "清表顺序与快照表一一对应；achievements 不在其中"
        );
    }

    #[test]
    fn test_create_and_list_tasks() {
        let conn = test_conn();

        let a = create_task(&conn, "读书", None).expect("创建任务失败");
        let b = create_task(&conn, "健身", Some("生活")).expect("创建任务失败");
        assert_eq!(a.title, "读书");
        assert_eq!(a.category, None);
        assert_eq!(b.category.as_deref(), Some("生活"));

        let tasks = list_tasks(&conn).expect("查询任务失败");
        // round48（用户 2026-10-03 拍板）：**新建任务排在最上** → 后建的在前
        assert_eq!(tasks, vec![b, a]);

        assert!(create_task(&conn, "   ", None).is_err(), "空标题应报错");
    }

    #[test]
    fn test_delete_task_cascades_blocks() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");
        create_block(&conn, &task.id, 5000, 6800).expect("创建任务块失败");
        assert_eq!(list_blocks(&conn, 0, 10_000).expect("查询失败").len(), 2);

        delete_task(&conn, &task.id).expect("删除任务失败");

        assert!(list_tasks(&conn).expect("查询失败").is_empty());
        assert!(
            list_blocks(&conn, 0, 10_000).expect("查询失败").is_empty(),
            "删除任务应级联删除其任务块"
        );
    }

    #[test]
    fn test_create_block_default_status_planned() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");

        let block = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");
        assert_eq!(block.status, "planned");
        assert_eq!(block.task_id, task.id);
        assert_eq!(block.last_notified_at, None);

        let stored = list_blocks(&conn, 0, 10_000).expect("查询失败");
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].status, "planned");
    }

    #[test]
    fn test_create_block_validates_input() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");

        assert_eq!(
            create_block(&conn, &task.id, 2800, 1000).unwrap_err(),
            "结束时间必须晚于开始时间"
        );
        assert_eq!(
            create_block(&conn, &task.id, 1000, 1000).unwrap_err(),
            "结束时间必须晚于开始时间"
        );
        assert_eq!(
            create_block(&conn, "不存在的任务", 1000, 2800).unwrap_err(),
            "任务不存在"
        );
    }

    /// round25⑤（用户实测：「被延到下周的块，在下周看不到」）：窗口查询用**区间相交**语义 ——
    /// 起点在窗口之前、尾巴伸进窗口的块也算「这一周的」。
    ///
    /// 旧实现是 `start_at >= from AND start_at < to`（按**起点**过滤）→ 跨周那块在下一周整段消失 ✗。
    /// 前端 `layoutDay` 一直是相交语义（`end_at > dayStart && start_at < dayEnd`）—— 数据没送到而已。
    #[test]
    fn test_list_blocks_uses_overlap_semantics() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        // 区间为左闭右开
        // C1.2 起同任务相接/重叠会自动融合 → 这类「只关心区间过滤」的素材各用不同任务
        let t2 = create_task(&conn, "写作", None).expect("创建任务失败");
        let t3 = create_task(&conn, "健身", None).expect("创建任务失败");
        let t4 = create_task(&conn, "写字", None).expect("创建任务失败");
        let t5 = create_task(&conn, "画画", None).expect("创建任务失败");
        let before = create_block(&conn, &t2.id, 400, 2_200).expect("创建失败"); // 起点在窗口前、尾巴伸进来 → 要
        let first = create_block(&conn, &task.id, 1000, 2800).expect("创建失败"); // 起点 == from → 要
        let inside = create_block(&conn, &t3.id, 1900, 3700).expect("创建失败"); // 完全在窗内 → 要
        let after = create_block(&conn, &t4.id, 5000, 6800).expect("创建失败"); // start >= to → 不要
        let before_end = create_block(&conn, &t5.id, 100, 1_000).expect("创建失败"); // 恰好停在 from → 不要

        let got = list_blocks(&conn, 1000, 5000).expect("查询失败");
        assert!(got.contains(&before), "起点在窗口之前但尾巴伸进来的块必须查得到");
        assert!(got.contains(&first));
        assert!(got.contains(&inside));
        assert_eq!(got.len(), 3, "窗口外的两块不该混进来");
        assert!(!got.contains(&after));
        assert!(!got.contains(&before_end), "恰好停在窗口起点的块不算相交");
    }

    #[test]
    fn test_mark_block_done_sets_status_done() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let block = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");

        let done = mark_block_done(&conn, &block.id).expect("标记完成失败");
        assert_eq!(done.status, "done");

        // 不回退：重复标记（done -> missed）应无效
        let again = mark_block_missed(&conn, &block.id).expect("重复标记不应报错");
        assert_eq!(again.status, "done");

        assert_eq!(
            mark_block_done(&conn, "不存在的块").unwrap_err(),
            "这个块已经不在了（可能刚被删掉）"
        );
    }

    /// round57（0.13.0 / BR）：终态判定的纯函数 —— 提前 / 按时 / 超时三档 + 15 分钟宽限的边界
    #[test]
    fn test_final_status_for_rule() {
        let start = 10_000;
        let end = start + 3600; // 一小时的块
        let grace = OVERTIME_GRACE_SECONDS;

        assert_eq!(final_status_for(start, end, start - 1), Some("done_short"), "早一秒 = 提前");
        assert_eq!(final_status_for(start, end, start), None, "正好开始 = 按时");
        assert_eq!(final_status_for(start, end, end - 1), None);
        assert_eq!(final_status_for(start, end, end), None, "正好结束 = 按时");
        assert_eq!(final_status_for(start, end, end + grace), None, "宽限的最后一秒仍算按时");
        assert_eq!(
            final_status_for(start, end, end + grace + 1),
            Some("done_overtime"),
            "超出宽限一秒就是超时"
        );
    }

    /// round57（BR）：标 ✓ 真的把终态写进库 —— 四种时刻 + 重标幂等
    #[test]
    fn test_mark_done_writes_final_status() {
        let conn = test_conn();
        let task = create_task(&conn, "写周报", None).expect("创建任务失败");
        // 每例的时段互相离得远（相邻/重叠的同任务块会被融合吃掉 —— 本仓踩过）
        let mk = |base: i64| create_block(&conn, &task.id, base, base + 3600).expect("建块失败");

        let b1 = mk(10_000);
        let d1 = mark_block_done_at(&conn, &b1.id, 10_000 - 1).expect("标完成失败");
        assert_eq!(d1.final_status.as_deref(), Some("done_short"), "早于开始 = 提前完成");

        let b2 = mk(20_000);
        let d2 = mark_block_done_at(&conn, &b2.id, 20_000 + 60).expect("标完成失败");
        assert_eq!(d2.final_status, None, "时段内 = 按时完成");

        let b3 = mk(30_000);
        let d3 = mark_block_done_at(&conn, &b3.id, 30_000 + 3600 + OVERTIME_GRACE_SECONDS)
            .expect("标完成失败");
        assert_eq!(d3.final_status, None, "结束提醒顺手点 ✓（宽限内）= 按时");

        let b4 = mk(40_000);
        let d4 = mark_block_done_at(
            &conn,
            &b4.id,
            40_000 + 3600 + OVERTIME_GRACE_SECONDS + 1,
        )
        .expect("标完成失败");
        assert_eq!(d4.final_status.as_deref(), Some("done_overtime"), "超出宽限 = 超时完成");

        // 幂等：已标记的块重标不许改终态（哪怕这次算出来的档不一样）
        let again = mark_block_done_at(&conn, &b4.id, 40_000 + 60).expect("重标不应报错");
        assert_eq!(again.status, "done");
        assert_eq!(again.final_status.as_deref(), Some("done_overtime"), "已标记的块不许被改写");
    }

    /// round69.1（#9）：complete 事件补 `delay_minutes`（标 ✓ 时刻 − 计划开始；提前完成记 0）
    /// —— 「快不过光速」靠它判定（旧口径把「块多长」当成了「多快完成」）
    #[test]
    fn test_complete_event_records_delay() {
        let conn = test_conn();
        let task = create_task(&conn, "写周报", None).expect("创建任务失败");
        let start = 40_000;
        let b = create_block(&conn, &task.id, start, start + 3600).expect("建块失败");
        mark_block_done_at(&conn, &b.id, start + 300).expect("标完成失败");
        let payload: String = conn
            .query_row(
                "SELECT payload FROM events WHERE event_type = 'complete' ORDER BY rowid DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("读 complete 事件失败");
        assert!(payload.contains("\"delay_minutes\":5"), "开始 5 分钟后完成：{payload}");

        // 提前完成（at < start）→ 记 0（不出现负数）
        let b2 = create_block(&conn, &task.id, start + 100_000, start + 103_600).expect("建块失败");
        mark_block_done_at(&conn, &b2.id, start + 100_000 - 600).expect("标完成失败");
        let payload2: String = conn
            .query_row(
                "SELECT payload FROM events WHERE event_type = 'complete' ORDER BY rowid DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("读 complete 事件失败");
        assert!(payload2.contains("\"delay_minutes\":0"), "提前完成记 0：{payload2}");
    }

    #[test]
    fn test_mark_block_missed_sets_status_missed() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let block = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");

        let missed = mark_block_missed(&conn, &block.id).expect("标记未完成失败");
        assert_eq!(missed.status, "missed");

        let again = mark_block_done(&conn, &block.id).expect("重复标记不应报错");
        assert_eq!(again.status, "missed", "已标记的块不应被回退或覆盖");
    }

    /// round57：008 迁移把 `reviews` 收敛成结语表（两列死快照列已删、新两列到位）
    #[test]
    fn test_migration_008_shapes_reviews() {
        let conn = test_conn();
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(reviews)")
            .expect("读表结构失败")
            .query_map([], |r| r.get(1))
            .expect("查列失败")
            .collect::<Result<_, _>>()
            .expect("收列名失败");
        assert_eq!(cols, vec!["id", "week_start", "created_at", "note", "updated_at"]);
        assert!(
            !cols.iter().any(|c| c == "mosaic_snapshot" || c == "sanity_curve"),
            "两个从未被写过的快照列已删（round57 决策：卡片实时算，不落快照）"
        );
    }

    /// round57（交付前只读复核抓到的 **P1**）：快照里带了 `reviews`，但 `restore_tables` 的**清表清单漏了它** ——
    /// 写过周报结语之后：① 撤销「写结语」那一步删不掉那一行（快照里它为空 → `continue`），界面却报「已撤销」；
    /// ② 之后任何带那一行的快照（撤销/重做）都会撞 `UNIQUE(week_start)` → 整事务回滚 → **Ctrl+Z 从此不可用**。
    /// 本批之前没人踩到，只是因为 `reviews` 从来没人写过。
    ///
    /// round58：结语链已删、表没有写入方了 —— 但 0.13.0 可能已经在真库里写过行，快照/撤销仍会碰到它，
    /// 所以守卫留着；播种改成**直接 SQL**（不再依赖被删的 `set_review_note`）。
    #[test]
    fn test_restore_tables_clears_reviews() {
        let conn = test_conn();
        let monday = 1_700_000_000;

        let insert = |note: &str| {
            conn.execute(
                "INSERT INTO reviews (id, week_start, note, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 0, 0)
                 ON CONFLICT(week_start) DO UPDATE SET note = excluded.note",
                rusqlite::params![Uuid::new_v4().to_string(), monday, note],
            )
            .expect("播种结语行失败");
        };
        let count_reviews = || -> i64 {
            conn.query_row("SELECT COUNT(*) FROM reviews", [], |r| r.get(0))
                .expect("数 reviews 行失败")
        };

        // ① 拍一份「带结语」的快照
        insert("带结语的快照");
        let with_note = dump_tables(&conn).unwrap();

        // ② 拍一份「空结语」的快照，然后写一条结语，再恢复 → 那一行必须被真的删掉
        conn.execute("DELETE FROM reviews", []).unwrap();
        let empty = dump_tables(&conn).unwrap();
        insert("之后写的");
        restore_tables(&conn, &empty).expect("恢复空结语的快照不该报错");
        assert_eq!(
            count_reviews(),
            0,
            "撤销要真的把那一行删掉（旧代码不清 reviews → 脏行留着）"
        );

        // ③ 库里已经有同一周的行，再去恢复那份「带结语」的快照 → 不许撞 UNIQUE(week_start)
        insert("又写了一条");
        restore_tables(&conn, &with_note).expect("库里已有同一周的行，恢复也不该撞 UNIQUE");
        let note: String = conn
            .query_row("SELECT note FROM reviews WHERE week_start = ?1", [monday], |r| {
                r.get(0)
            })
            .expect("读回结语失败");
        assert_eq!(note, "带结语的快照");
        assert_eq!(count_reviews(), 1);
    }

    /// 守卫：恢复时的清表清单必须与 `SNAPSHOT_TABLES` **一一对应**
    /// （少一张 = 撤销留脏行 / 撞 UNIQUE；多一张 = 删了没拍快照的表）
    /// round69（B3）：011 建出 repeats / repeat_occurrences；两张都在撤销快照里（建规则 / 生成要能 Ctrl+Z）。
    /// 插/清顺序错一处就是 FK 报错 —— 这里把两处顺序钉死。
    #[test]
    fn test_migration_011_creates_repeats_tables_in_snapshot() {
        let conn = test_conn();
        assert!(table_exists(&conn, "repeats"), "011 应建出 repeats 表");
        assert!(table_exists(&conn, "repeat_occurrences"), "011 应建出 repeat_occurrences 表");

        let cols = |table: &str| -> Vec<String> {
            conn.prepare(&format!("PRAGMA table_info({table})"))
                .expect("准备读表结构失败")
                .query_map([], |r| r.get::<_, String>(1))
                .expect("读表结构失败")
                .collect::<Result<_, _>>()
                .expect("收集列名失败")
        };
        assert_eq!(
            cols("repeats"),
            vec!["id", "task_id", "weekday", "start_min", "layer", "enabled", "created_at"],
            "规则列清单要稳定（**没有时长列**：时长读任务的预估）"
        );
        assert_eq!(
            cols("repeat_occurrences"),
            vec!["repeat_id", "week_start", "block_id", "status", "created_at"],
            "水位线列清单要稳定"
        );

        for table in ["repeats", "repeat_occurrences"] {
            assert!(SNAPSHOT_TABLES.contains(&table), "{table} 要进快照（建规则/生成可撤销）");
            assert!(RESTORE_DELETE_ORDER.contains(&table), "{table} 要进清表清单");
        }
        let snap_pos = |t: &str| SNAPSHOT_TABLES.iter().position(|x| *x == t).unwrap();
        let del_pos = |t: &str| RESTORE_DELETE_ORDER.iter().position(|x| *x == t).unwrap();
        assert!(
            snap_pos("tasks") < snap_pos("repeats")
                && snap_pos("repeats") < snap_pos("repeat_occurrences")
                && snap_pos("blocks") < snap_pos("repeat_occurrences"),
            "插入顺序要满足外键：tasks → repeats → 水位线，blocks 也要在水位线之前"
        );
        assert!(
            del_pos("repeat_occurrences") < del_pos("blocks")
                && del_pos("repeat_occurrences") < del_pos("repeats")
                && del_pos("repeats") < del_pos("tasks"),
            "清表顺序：水位线先于 blocks / repeats，规则先于 tasks"
        );
    }

    /// round69（B3）：快照恢复要带上规则与水位线（最易碎的一处：外键顺序）
    #[test]
    fn test_snapshot_round_trip_keeps_repeats() {
        use chrono::{Local, TimeZone};
        let conn = test_conn();
        let ts = |y: i32, m: u32, d: u32| -> i64 {
            Local
                .from_local_datetime(
                    &chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(0, 0, 0).unwrap(),
                )
                .earliest()
                .unwrap()
                .timestamp()
        };
        let week = ts(2031, 1, 13); // 周一
        let task = create_task(&conn, "健身", None).unwrap();
        let repeat = crate::repeats::create_repeat(&conn, &task.id, 2, 19 * 60, "required").unwrap();
        assert_eq!(crate::repeats::generate_week(&conn, week, week).unwrap(), 1);
        let snap = dump_tables(&conn).unwrap();

        // 改一通：删规则（水位线跟着 CASCADE）、删生成的块
        crate::repeats::delete_repeat(&conn, &repeat.id).unwrap();
        let blocks = list_blocks(&conn, week, week + 7 * 86_400).unwrap();
        // round69.1（#4 / D2）：删除规则会顺手把**还没开始**的生成块也撤下 —— 这里就是那个现场
        assert!(blocks.is_empty(), "删规则后未开始的生成块也走了");
        let occ: i64 = conn
            .query_row("SELECT COUNT(*) FROM repeat_occurrences", [], |r| r.get(0))
            .unwrap();
        assert_eq!(occ, 0, "删规则应连带水位线");

        restore_tables(&conn, &snap).unwrap();
        assert_eq!(crate::repeats::list_repeats(&conn, None).unwrap().len(), 1, "规则回来");
        let occ: i64 = conn
            .query_row("SELECT COUNT(*) FROM repeat_occurrences", [], |r| r.get(0))
            .unwrap();
        assert_eq!(occ, 1, "水位线也回来");
        assert_eq!(
            list_blocks(&conn, week, week + 7 * 86_400).unwrap().len(),
            1,
            "生成的块也回来"
        );
    }

    #[test]
    fn test_restore_delete_order_covers_snapshot_tables() {
        let mut del: Vec<&str> = RESTORE_DELETE_ORDER.to_vec();
        let mut snap: Vec<&str> = SNAPSHOT_TABLES.to_vec();
        del.sort_unstable();
        snap.sort_unstable();
        assert_eq!(del, snap, "清表清单与快照表清单必须一致");
    }

    #[test]
    fn test_delete_block_and_task_are_idempotent() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let block = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");

        delete_block(&conn, &block.id).expect("删除任务块失败");
        delete_block(&conn, &block.id).expect("重复删除应幂等");
        delete_task(&conn, &task.id).expect("删除任务失败");
        assert!(
            delete_task(&conn, &task.id).expect("重复删除应幂等") == 0,
            "重复删除没有块可删 → 回报 0（但不报错）"
        );
    }

    /// round60（10.1 统计页）：删除记「删了几个块」；重复删除不记（没动作发生过）
    #[test]
    fn test_delete_block_logs_deleted_count() {
        let conn = test_conn();
        let task = create_task(&conn, "删除靶子", None).expect("创建任务失败");
        let block = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");
        assert_eq!(delete_block(&conn, &block.id).expect("删除失败"), 1);

        let payload: String = conn
            .query_row(
                "SELECT payload FROM events WHERE block_id = ?1 AND event_type = 'delete'",
                [&block.id],
                |r| r.get(0),
            )
            .expect("delete 事件未记录");
        assert!(payload.contains("\"count\":1"), "payload 应含删除块数：{payload}");

        // 再删一次（不存在的 id）→ 不记第二条
        assert_eq!(delete_block(&conn, &block.id).expect("重复删除应幂等"), 0);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM events WHERE event_type = 'delete'", [], |r| r.get(0))
            .expect("统计事件失败");
        assert_eq!(n, 1, "没删到东西就不该记账");
    }

    // ------------------------------------------------ 二期（C0 / C1）

    /// C0：新库插入的数据拿到安全默认值（不靠调用方传参）
    #[test]
    fn test_phase2_columns_have_safe_defaults() {
        let conn = test_conn();

        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        assert_eq!(task.is_elastic, 0);
        assert_eq!(task.estimated_minutes, None);
        assert_eq!(task.archived_at, None);

        let block = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");
        assert_eq!(block.layer, "elastic", "C1.4：新块默认进弹性层");
        assert_eq!(block.external_source, None);
        assert_eq!(block.final_status, None);
    }

    /// C0 关键兼容性测试：只有 001 的老库跑一次 migrate → 002/003/004 生效、老数据不丢、新列拿默认值
    #[test]
    fn test_migration_002_upgrades_existing_db() {
        // 手工造一个「只跑过 001」的库（不能用 test_conn：它直接跑完全部迁移）
        let conn = Connection::open_in_memory().expect("打开内存数据库失败");
        conn.pragma_update(None, "foreign_keys", true)
            .expect("开启外键约束失败");
        conn.execute_batch(include_str!("../migrations/001_init.sql"))
            .expect("执行 001 失败");
        conn.execute_batch(
            "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);\
             INSERT INTO schema_migrations (version, applied_at) VALUES ('001', 0);",
        )
        .expect("造迁移记录失败");

        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO tasks (id, title, category, created_at) VALUES ('t1','老任务',NULL,?1)",
            [now],
        )
        .expect("插入老任务失败");
        conn.execute(
            "INSERT INTO blocks (id, task_id, start_at, end_at, status, last_notified_at, created_at)
             VALUES ('b1','t1',1000,2800,'planned',NULL,?1)",
            [now],
        )
        .expect("插入老块失败");

        migrate(&conn).expect("升级失败");

        let recorded: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .expect("统计迁移记录失败");
        assert_eq!(
            recorded,
            MIGRATIONS.len() as i64,
            "所有迁移都应各记录一次（含 002/003/004）"
        );

        let tasks = list_tasks(&conn).expect("查询任务失败");
        assert_eq!(tasks.len(), 1, "老数据必须保留");
        assert_eq!(tasks[0].title, "老任务");
        assert_eq!(tasks[0].is_elastic, 0, "老任务拿到默认值");
        assert_eq!(tasks[0].estimated_minutes, None);
        assert_eq!(tasks[0].archived_at, None);

        let blocks = list_blocks(&conn, 0, 10_000).expect("查询任务块失败");
        assert_eq!(blocks.len(), 1);
        assert!(
            !blocks[0].sanity_exempt,
            "round45（006）：老库升级后默认「计入理智值」"
        );
        assert_eq!(
            blocks[0].layer, "elastic",
            "C1.4：老块的「建议层」经 004 迁移并入弹性层"
        );
        assert_eq!(blocks[0].external_source, None);
        assert_eq!(blocks[0].final_status, None);

        for t in ["events", "sequences", "sequence_members", "external_blocks", "reviews", "settings"] {
            assert!(table_exists(&conn, t), "002 应建出 {t} 表");
        }
    }

    /// C1.4（两层）：新块一律默认弹性层 —— **与任务的 is_elastic 无关**了
    #[test]
    fn test_create_block_defaults_to_elastic_layer() {
        let conn = test_conn();

        let elastic_task = create_task(&conn, "阅读", None).expect("创建任务失败");
        conn.execute(
            "UPDATE tasks SET is_elastic = 1 WHERE id = ?1",
            [&elastic_task.id],
        )
        .expect("设置弹性失败");
        let elastic_block = create_block(&conn, &elastic_task.id, 1000, 2800).expect("创建块失败");
        assert_eq!(elastic_block.layer, "elastic", "弹性任务的块默认弹性层");

        let normal_task = create_task(&conn, "健身", None).expect("创建任务失败");
        let normal_block = create_block(&conn, &normal_task.id, 1000, 2800).expect("创建块失败");
        assert_eq!(
            normal_block.layer, "elastic",
            "C1.4：普通任务的块也默认弹性层（原「建议层」已并入弹性）"
        );
    }

    /// C1：改层——两层都能来回切，且必须落库
    #[test]
    fn test_update_block_layer() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let block = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");
        assert_eq!(block.layer, "elastic", "C1.4：默认弹性层");

        for layer in ["required", "elastic"] {
            let updated = update_block_layer(&conn, &block.id, layer).expect("改层失败");
            assert_eq!(updated.layer, layer);
            let stored = list_blocks(&conn, 0, 10_000).expect("查询失败");
            assert_eq!(stored[0].layer, layer, "改层必须落库");
        }
    }

    /// C1 修正（用户实测）：层级「升级」时要重新提醒 —— 否则事后改成必填，通知永远不再发
    #[test]
    fn test_promote_layer_re_reminds() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let block = create_block(&conn, &task.id, 1_000, 2_800).expect("创建任务块失败");
        // 模拟「已经提醒过」
        conn.execute(
            "UPDATE blocks SET last_notified_at = ?1 WHERE id = ?2",
            rusqlite::params![block.end_at, block.id],
        )
        .expect("写通知标记失败");
        assert!(due_blocks(&conn, 3_000).expect("查询失败").is_empty());

        let promoted = update_block_layer(&conn, &block.id, "required").expect("改层失败");
        assert_eq!(promoted.priority, "high");
        assert_eq!(promoted.last_notified_at, None, "升级后应清掉旧的提醒标记");
        let due = due_blocks(&conn, 3_000).expect("查询失败");
        assert_eq!(due.len(), 1, "升级后应重新进入提醒候选");
        assert_eq!(due[0].priority, Priority::High);
    }

    /// C1 修正：层级「降级」（高 → 低）不应重新提醒，别打扰用户
    #[test]
    fn test_demote_layer_does_not_re_remind() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let block = create_block(&conn, &task.id, 1_000, 2_800).expect("创建任务块失败");
        update_block_layer(&conn, &block.id, "required").expect("改层失败");
        conn.execute(
            "UPDATE blocks SET last_notified_at = ?1 WHERE id = ?2",
            rusqlite::params![block.end_at, block.id],
        )
        .expect("写通知标记失败");

        let demoted = update_block_layer(&conn, &block.id, "elastic").expect("改层失败");
        assert_eq!(demoted.priority, "low");
        assert_eq!(
            demoted.last_notified_at,
            Some(block.end_at),
            "降级不该重置提醒标记（也不该再弹一次）"
        );
    }

    /// C1：非法层级 / 不存在的块，都要报中文错
    #[test]
    fn test_update_block_layer_rejects_invalid_and_missing() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let block = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");

        assert_eq!(
            update_block_layer(&conn, &block.id, "urgent").unwrap_err(),
            "层只能设成「必填」或「弹性」"
        );
        // C1.4：已废弃的「建议层」现在必须被拒 —— 否则旧客户端会把三层重新写回库里
        assert_eq!(
            update_block_layer(&conn, &block.id, "suggested").unwrap_err(),
            "层只能设成「必填」或「弹性」"
        );
        assert_eq!(
            update_block_layer(&conn, "不存在的块", "required").unwrap_err(),
            "这个块已经不在了（可能刚被删掉）"
        );
    }

    // ------------------------------------------------ 二期（C2）

    /// C2：漂流 = 新建一个块 + 原残影原位保留 + 记一条 postpone 事件
    #[test]
    fn test_postpone_block_creates_new_block_and_keeps_ghost() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let block = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");
        update_block_layer(&conn, &block.id, "required").expect("改层失败");
        mark_block_missed(&conn, &block.id).expect("标记未完成失败");

        let moved = postpone_block(&conn, &block.id, 9000).expect("漂流失败").block;

        // 新块：同任务、同时长、同层、状态回到 planned
        assert_eq!(moved.task_id, task.id);
        assert_eq!(moved.start_at, 9000);
        assert_eq!(moved.end_at, 9000 + 1800, "时长应与原块一致");
        assert_eq!(moved.status, "planned");
        assert_eq!(moved.layer, "required", "应继承原块的层");
        assert_eq!(
            moved.postponed_from.as_deref(),
            Some(block.id.as_str()),
            "新块应记下来自哪个残影"
        );

        // 原残影仍在原位、仍是 missed
        let all = list_blocks(&conn, 0, 20_000).expect("查询失败");
        assert_eq!(all.len(), 2, "应是「残影 + 新块」两个");
        let ghost = all.iter().find(|b| b.id == block.id).expect("残影不见了");
        assert_eq!(ghost.status, "missed");
        assert_eq!(ghost.start_at, 1000);

        // postpone 事件已记录 from/to
        // （C1.5 起「标记未完成」也会写一条 skip —— 这里只查 postpone 那一条）
        let (event_type, payload): (String, String) = conn
            .query_row(
                "SELECT event_type, payload FROM events WHERE block_id = ?1 AND event_type = 'postpone'",
                [&block.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("postpone 事件未记录");
        assert_eq!(event_type, "postpone");
        assert!(payload.contains("1000"), "payload 应含原时间：{payload}");
        assert!(payload.contains("9000"), "payload 应含新时间：{payload}");
    }

    /// C2：对不存在的块漂流 → 中文报错
    #[test]
    fn test_postpone_block_rejects_missing() {
        let conn = test_conn();
        assert_eq!(
            postpone_block(&conn, "不存在的块", 9000).unwrap_err(),
            "这个块已经不在了（可能刚被删掉）"
        );
    }

    /// C2 修正（用户实测发现）：同一残影再次漂移 = 改已有后续块，而不是再加一块
    #[test]
    fn test_postpone_block_reuses_active_follow_up() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let ghost = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");
        mark_block_missed(&conn, &ghost.id).expect("标记未完成失败");

        let first = postpone_block(&conn, &ghost.id, 9000).expect("第一次漂流失败").block;
        assert_eq!(first.postponed_from.as_deref(), Some(ghost.id.as_str()));

        let second = postpone_block(&conn, &ghost.id, 15_000).expect("第二次漂流失败").block;
        assert_eq!(second.id, first.id, "同一残影只应有一个后续块");
        assert_eq!(second.start_at, 15_000);
        assert_eq!(second.end_at, 15_000 + 1800, "时长保持不变");

        let all = list_blocks(&conn, 0, 30_000).expect("查询失败");
        assert_eq!(all.len(), 2, "应该是「残影 + 一个后续块」");

        let events: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE block_id = ?1 AND event_type = 'postpone'",
                [&ghost.id],
                |r| r.get(0),
            )
            .expect("统计事件失败");
        assert_eq!(events, 2, "两次漂移各记一条事件（复盘仍能看出改过几次）");
    }

    /// round60（10.1 统计页）：漂流内部建的块**不算「新建块」** —— 用户的动作是「漂移」（postpone）
    #[test]
    fn test_drift_successor_is_not_a_create_event() {
        let conn = test_conn();
        let task = create_task(&conn, "漂移靶子", None).expect("创建任务失败");
        let ghost = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");
        mark_block_missed(&conn, &ghost.id).expect("标记未完成失败");

        let count_create = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM events WHERE event_type = 'create'",
                [],
                |r| r.get(0),
            )
            .expect("统计事件失败")
        };
        assert_eq!(count_create(&conn), 1, "用户放置 → 一条 create");

        postpone_block(&conn, &ghost.id, 9000).expect("漂流失败");
        assert_eq!(count_create(&conn), 1, "漂流的新块不再记 create");
        let postpones: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE event_type = 'postpone'",
                [],
                |r| r.get(0),
            )
            .expect("统计事件失败");
        assert_eq!(postpones, 1, "用户动作只记在 postpone 上");
    }

    /// C2 修正：若已有后续块已被标记完成，那一轮就结束了 → 新一轮漂流应新建
    #[test]
    fn test_postpone_block_creates_new_when_follow_up_finished() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let ghost = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");
        mark_block_missed(&conn, &ghost.id).expect("标记未完成失败");

        let first = postpone_block(&conn, &ghost.id, 9000).expect("第一次漂流失败").block;
        mark_block_done(&conn, &first.id).expect("标记完成失败");

        let second = postpone_block(&conn, &ghost.id, 15_000).expect("第二次漂流失败").block;
        assert_ne!(second.id, first.id, "上一轮已结束 → 应新建而不是回改它");
        assert_eq!(second.start_at, 15_000);

        let all = list_blocks(&conn, 0, 30_000).expect("查询失败");
        assert_eq!(all.len(), 3, "残影 + 已完成的那块 + 新块");
    }

    /// round29 #3/#7（用户拍板：「临时安排漂出去不是要叫『临时安排』，是要跟父块名字一致」）：
    /// 命名的临时块漂出去，新块要**继承 label**。
    /// 走的是「链尾已结束 → 新建」那条分支（唯一会丢名字的路径；链尾还活着时走 `move_block`，保行保名）。
    #[test]
    fn test_postpone_inherits_label() {
        let conn = test_conn();
        let block = create_temp_block(&conn, 1000, 2800).expect("建临时块失败");
        update_block(&conn, &block.id, None, None, None, Some("浇花")).expect("命名失败");

        let first = postpone_block(&conn, &block.id, 9000).expect("第一次漂流失败").block;
        assert_eq!(
            first.label.as_deref(),
            Some("浇花"),
            "链尾还活着时是移动同一行，名字本来就不该丢"
        );
        mark_block_done(&conn, &first.id).expect("标记完成失败");

        let second = postpone_block(&conn, &block.id, 15_000)
            .expect("第二次漂流失败")
            .block;
        assert_ne!(second.id, first.id, "上一轮已结束 → 应新建");
        assert!(second.is_temp, "临时块漂出去还是临时块（挂的还是那块隐藏任务）");
        assert_eq!(
            second.label.as_deref(),
            Some("浇花"),
            "新块要继承父块的名字（不然界面上从「浇花」掉回「临时安排」）"
        );
    }

    /// round48：口径搬到**任务级**之后，round47 收的那两笔账（BK / BL）**自然消失**：
    /// 漂出来/合出来的块都是**同一条任务**，所以「不计入」本来就跟着走 —— 不需要任何继承代码。
    /// 这条锁住「不需要继承」这件事：把块级列清干净、只标任务，漂出去的新块照样不计入
    /// （真正的占用口径断言在 `sanity.rs::test_exempt_task_ignores_all_its_blocks`）。
    #[test]
    fn test_task_level_exempt_needs_no_block_inheritance() {
        let conn = test_conn();
        let task = create_task(&conn, "通勤", None).expect("创建任务失败");
        let ghost = create_block(&conn, &task.id, 1000, 2800).expect("创建任务块失败");
        mark_block_missed(&conn, &ghost.id).expect("标记未完成失败");
        set_task_exempt(&conn, &task.id, true).expect("标不计入失败");

        let drifted = postpone_block(&conn, &ghost.id, 9000).expect("漂流失败").block;
        assert!(
            !drifted.sanity_exempt,
            "块级列不再被继承（它已经没有读者了）—— 不计入由**任务**决定"
        );
        let stored = load_task(&conn, &task.id).expect("查失败").expect("任务不在");
        assert!(stored.sanity_exempt, "任务上的标记才是唯一真相源");
    }

    // ---------------------------------------------------------------- round48：任务级属性 + 手动顺序

    /// 用户 2026-10-03 拍板：**新建任务排在最上**（原来排在最下）
    #[test]
    fn test_create_task_goes_to_the_top() {
        let conn = test_conn();
        let a = create_task(&conn, "老大", None).expect("建任务失败");
        let b = create_task(&conn, "老二", None).expect("建任务失败");
        let c = create_task(&conn, "老三", None).expect("建任务失败");
        let order: Vec<String> = list_tasks(&conn)
            .expect("查任务失败")
            .into_iter()
            .map(|t| t.title)
            .collect();
        assert_eq!(order, vec!["老三", "老二", "老大"], "新任务排在最上，老的往下沉");
        assert!(
            c.sort_order < b.sort_order && b.sort_order < a.sort_order,
            "越靠上 = sort_order 越小（可以是负数）"
        );
    }

    /// 手动顺序：按给定顺序写 `sort_order`；重复写幂等；未知 id 跳过；空列表不动
    #[test]
    fn test_reorder_tasks_writes_the_given_order() {
        let conn = test_conn();
        let a = create_task(&conn, "A", None).expect("建任务失败");
        let b = create_task(&conn, "B", None).expect("建任务失败");
        let c = create_task(&conn, "C", None).expect("建任务失败");

        let want = vec![c.id.clone(), a.id.clone(), b.id.clone()];
        assert_eq!(reorder_tasks(&conn, &want).expect("排序失败"), 3);
        let titles = |conn: &Connection| -> Vec<String> {
            list_tasks(conn).expect("查任务失败").into_iter().map(|t| t.title).collect()
        };
        assert_eq!(titles(&conn), vec!["C", "A", "B"]);

        reorder_tasks(&conn, &want).expect("再排一次失败");
        assert_eq!(titles(&conn), vec!["C", "A", "B"], "重复写同一个顺序是幂等的");

        // 界面可能已经过期 → 未知 id 跳过；空列表什么都不动
        assert_eq!(reorder_tasks(&conn, &["查无此任务".to_string()]).expect("不该报错"), 0);
        assert_eq!(reorder_tasks(&conn, &[]).expect("不该报错"), 0);
        assert_eq!(titles(&conn), vec!["C", "A", "B"], "跳过的那些不该打乱已有顺序");
    }

    /// 独立的 `set_task_exempt`（round48）：开 / 关 / 幂等 / 任务不存在要报错
    #[test]
    fn test_set_task_exempt_command_shape() {
        let conn = test_conn();
        let task = create_task(&conn, "通勤", None).expect("建任务失败");
        assert!(!task.sanity_exempt, "默认计入");

        assert!(set_task_exempt(&conn, &task.id, true).expect("标不计入失败").sanity_exempt);
        // 再标一次还是 true（幂等，不报错）
        assert!(set_task_exempt(&conn, &task.id, true).expect("重复标失败").sanity_exempt);
        // 改名不碰它（两件事互不干扰）
        let renamed = rename_task(&conn, &task.id, "通勤（早）").expect("改名失败");
        assert!(renamed.sanity_exempt, "改名不该碰「不计入」");

        assert!(!set_task_exempt(&conn, &task.id, false).expect("取消失败").sanity_exempt);
        assert!(set_task_exempt(&conn, "不存在的任务", true).is_err());
    }

    /// round48 迁移 007 的 SQL（只有升级老库时才跑到，所以要单独验一次）：
    /// ① 块级「不计入」折进**任务级** ② `sort_order` 复刻升级前 `created_at, rowid` 的顺序
    #[test]
    fn test_migration_007_folds_block_flags_and_backfills_order() {
        let conn = Connection::open_in_memory().expect("开库失败");
        conn.pragma_update(None, "foreign_keys", true).expect("开外键失败");
        // 造一个「006 状态」的库：只跑 001 / 002 / 006（007 的 SQL 下面单独跑 = 被测对象）
        conn.execute_batch(include_str!("../migrations/001_init.sql")).expect("001 失败");
        conn.execute_batch(include_str!("../migrations/002_phase2_core.sql")).expect("002 失败");
        conn.execute_batch(include_str!("../migrations/006_sanity_exempt.sql")).expect("006 失败");
        // 三条任务：**创建时间故意不按插入顺序**（老列表是按 created_at 排的）
        conn.execute_batch(
            "INSERT INTO tasks (id, title, created_at) VALUES ('t2','老二', 200);
             INSERT INTO tasks (id, title, created_at) VALUES ('t1','老大', 100);
             INSERT INTO tasks (id, title, created_at) VALUES ('t3','老三', 300);
             INSERT INTO blocks (id, task_id, start_at, end_at, created_at) VALUES ('b1','t3', 0, 1, 0);
             UPDATE blocks SET sanity_exempt = 1 WHERE id = 'b1';",
        )
        .expect("造老数据失败");

        conn.execute_batch(include_str!("../migrations/007_task_flags_and_order.sql"))
            .expect("007 失败");

        let order: Vec<String> = {
            let mut stmt = conn.prepare("SELECT title FROM tasks ORDER BY sort_order").expect("prepare");
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).expect("query");
            rows.map(|r| r.expect("row")).collect()
        };
        assert_eq!(order, vec!["老大", "老二", "老三"], "sort_order 要复刻升级前的顺序");

        let flags: Vec<(String, i64)> = {
            let mut stmt = conn
                .prepare("SELECT id, sanity_exempt FROM tasks ORDER BY id")
                .expect("prepare");
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).expect("query");
            rows.map(|r| r.expect("row")).collect()
        };
        assert_eq!(
            flags,
            vec![("t1".to_string(), 0), ("t2".to_string(), 0), ("t3".to_string(), 1)],
            "块级标记折进它那条任务，别的任务不受影响"
        );
    }

    // ------------------------------------------------ 漂流链的边界（修复轮 5）

    /// B1：多级链 A(missed) → B(missed) → C(planned)，再漂移最上层 A → 应移动链尾 C
    #[test]
    fn test_drift_chain_stays_linear_multi_level() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");

        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建 A 失败");
        mark_block_missed(&conn, &a.id).expect("A 标记未完成失败");
        let b = postpone_block(&conn, &a.id, 9_000).expect("A 漂流失败").block;
        assert_eq!(b.postponed_from.as_deref(), Some(a.id.as_str()));

        mark_block_missed(&conn, &b.id).expect("B 标记未完成失败");
        let c = postpone_block(&conn, &b.id, 15_000).expect("B 漂流失败").block;
        assert_eq!(c.postponed_from.as_deref(), Some(b.id.as_str()));

        // 关键：从最上层再漂移，应移动链尾 C，而不是新建兄弟块
        let moved = postpone_block(&conn, &a.id, 21_000).expect("A 再次漂流失败").block;
        assert_eq!(moved.id, c.id, "应移动链尾，而不是新建兄弟块");
        assert_eq!(moved.start_at, 21_000);

        let all = list_blocks(&conn, 0, 30_000).expect("查询失败");
        assert_eq!(all.len(), 3, "链应保持线性：A + B + C");
        assert_eq!(
            all.iter().filter(|b| b.status == "planned").count(),
            1,
            "一条链只应有一个活跃块"
        );
    }

    /// B2：从链中间漂移，同样落到链尾
    #[test]
    fn test_drift_from_middle_moves_tail() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建 A 失败");
        mark_block_missed(&conn, &a.id).expect("A 标记失败");
        let b = postpone_block(&conn, &a.id, 9_000).expect("漂流失败").block;
        mark_block_missed(&conn, &b.id).expect("B 标记失败");
        let c = postpone_block(&conn, &b.id, 15_000).expect("漂流失败").block;

        let moved = postpone_block(&conn, &b.id, 21_000).expect("中间漂移失败").block;
        assert_eq!(moved.id, c.id, "从中间漂移也要落回链尾");
        assert_eq!(list_blocks(&conn, 0, 30_000).expect("查询失败").len(), 3);
    }

    /// B3：链尾已结束时，新块应挂在**链尾**上（保持线性，而不是挂回源块分叉）
    #[test]
    fn test_drift_after_tail_finished_appends_to_tail() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建 A 失败");
        mark_block_missed(&conn, &a.id).expect("A 标记失败");
        let b = postpone_block(&conn, &a.id, 9_000).expect("漂流失败").block;
        mark_block_done(&conn, &b.id).expect("B 标记完成失败");

        let d = postpone_block(&conn, &a.id, 15_000).expect("A 再次漂流失败").block;
        assert_ne!(d.id, b.id, "上一轮已结束 → 新建");
        assert_eq!(
            d.postponed_from.as_deref(),
            Some(b.id.as_str()),
            "新块应挂在链尾 B 上（保持线性，不挂回 A 造成分叉）"
        );
        assert_eq!(list_blocks(&conn, 0, 30_000).expect("查询失败").len(), 3);
    }

    /// B4：删除父块 → 整个子分支一起删，并返回删除数量
    #[test]
    fn test_delete_block_removes_descendants() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建 A 失败");
        mark_block_missed(&conn, &a.id).expect("A 标记失败");
        let b = postpone_block(&conn, &a.id, 9_000).expect("漂流失败").block;
        mark_block_missed(&conn, &b.id).expect("B 标记失败");
        postpone_block(&conn, &b.id, 15_000).expect("漂流失败");

        let deleted = delete_block(&conn, &a.id).expect("删除失败");
        assert_eq!(deleted, 3, "A 及其后代 B、C 都应被删除");
        assert!(
            list_blocks(&conn, 0, 30_000).expect("查询失败").is_empty(),
            "不应留下孤儿后续块"
        );
    }

    /// B5a：删除中间块 → 删它及其后代，前面的保留
    #[test]
    fn test_delete_middle_removes_only_its_subtree() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建 A 失败");
        mark_block_missed(&conn, &a.id).expect("A 标记失败");
        let b = postpone_block(&conn, &a.id, 9_000).expect("漂流失败").block;
        mark_block_missed(&conn, &b.id).expect("B 标记失败");
        postpone_block(&conn, &b.id, 15_000).expect("漂流失败");

        let deleted = delete_block(&conn, &b.id).expect("删除失败");
        assert_eq!(deleted, 2, "B 与它的后代 C");
        let rest = list_blocks(&conn, 0, 30_000).expect("查询失败");
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].id, a.id, "前面的残影应保留");
    }

    /// B5b：删除链尾 → 只删它自己
    #[test]
    fn test_delete_tail_removes_only_itself() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建 A 失败");
        mark_block_missed(&conn, &a.id).expect("A 标记失败");
        let b = postpone_block(&conn, &a.id, 9_000).expect("漂流失败").block;

        assert_eq!(delete_block(&conn, &b.id).expect("删除失败"), 1);
        let rest = list_blocks(&conn, 0, 30_000).expect("查询失败");
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].id, a.id);
    }

    /// B6：手工改库造出环 → 链遍历必须报错终止，不能死循环
    #[test]
    fn test_chain_walk_is_cycle_safe() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建 A 失败");
        let b = create_block(&conn, &task.id, 9_000, 10_800).expect("建 B 失败");
        conn.execute(
            "UPDATE blocks SET postponed_from = ?1 WHERE id = ?2",
            [&b.id, &a.id],
        )
        .expect("造环失败 1");
        conn.execute(
            "UPDATE blocks SET postponed_from = ?1 WHERE id = ?2",
            [&a.id, &b.id],
        )
        .expect("造环失败 2");

        let err = postpone_block(&conn, &a.id, 20_000).unwrap_err();
        assert!(err.contains("漂流链"), "应报链异常：{err}");

        // 删除也必须能终止（不因环而无限递归）
        let deleted = delete_block(&conn, &a.id).expect("删除应能终止");
        assert_eq!(deleted, 2, "环上的两块都应被删除");
    }

    // ------------------------------------------------ 审计修复（边界 / 校验 / 健壮性）

    /// 审计：删除不存在的块应返回 0（曾经「先收集后删」会返回 1）
    #[test]
    fn test_delete_block_returns_zero_for_missing_id() {
        let conn = test_conn();
        assert_eq!(delete_block(&conn, "不存在的块").expect("删除应幂等"), 0);
    }

    /// 审计：换时段后必须清掉旧的通知标记，否则新时段不会再提醒
    #[test]
    fn test_move_clears_last_notified_at() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let ghost = create_block(&conn, &task.id, 1_000, 2_800).expect("创建任务块失败");
        mark_block_missed(&conn, &ghost.id).expect("标记失败");
        let follow = postpone_block(&conn, &ghost.id, 9_000).expect("漂流失败").block;

        // 模拟「已经提醒过一次」
        conn.execute(
            "UPDATE blocks SET last_notified_at = ?1 WHERE id = ?2",
            rusqlite::params![follow.end_at, follow.id],
        )
        .expect("写通知标记失败");

        let moved = postpone_block(&conn, &ghost.id, 20_000).expect("再次漂流失败").block;
        assert_eq!(moved.last_notified_at, None, "换时段后应重新提醒");
        assert_eq!(moved.start_at, 20_000);
    }

    /// 审计：标题长度上限（防误粘贴整篇文章）
    #[test]
    fn test_create_task_rejects_too_long_title() {
        let conn = test_conn();
        let too_long = "字".repeat(MAX_TITLE_CHARS + 1);
        assert_eq!(
            create_task(&conn, &too_long, None).unwrap_err(),
            format!("任务标题过长（最多 {MAX_TITLE_CHARS} 个字符）")
        );
        let just_fits = "字".repeat(MAX_TITLE_CHARS);
        assert!(create_task(&conn, &just_fits, None).is_ok(), "刚好到上限应允许");
    }

    /// 审计：时段的荒唐输入必须被挡住（负数 / 超 24 小时 / 极端值且不能溢出）
    #[test]
    fn test_create_block_rejects_absurd_ranges() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");

        assert_eq!(
            create_block(&conn, &task.id, -10, 1_000).unwrap_err(),
            "时间不能为负数"
        );
        assert_eq!(
            create_block(&conn, &task.id, 0, MAX_BLOCK_SECONDS + 1).unwrap_err(),
            "单个时间块不能超过 3 天"
        );
        // 极端值：必须先判上限再相减，否则 debug 下溢出 panic
        assert_eq!(
            create_block(&conn, &task.id, i64::MAX - 10, i64::MAX).unwrap_err(),
            "时间超出可排范围（最早 1970、最晚 2099，单块最多 3 天）"
        );
        assert!(
            create_block(&conn, &task.id, 0, MAX_BLOCK_SECONDS).is_ok(),
            "恰好 3 天应允许"
        );
    }

    /// 审计：漂流的新时段同样要校验，而且失败时不能把数据弄脏
    #[test]
    fn test_postpone_rejects_out_of_range_start() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let ghost = create_block(&conn, &task.id, 1_000, 2_800).expect("创建任务块失败");
        mark_block_missed(&conn, &ghost.id).expect("标记失败");

        assert_eq!(
            postpone_block(&conn, &ghost.id, -5).unwrap_err(),
            "时间不能为负数"
        );
        assert!(postpone_block(&conn, &ghost.id, i64::MAX).is_err(), "极端值应报错");
        let all = list_blocks(&conn, 0, 30_000).expect("查询失败");
        assert_eq!(all.len(), 1, "失败时不应多出块");
        assert_eq!(all[0].status, "missed");
    }

    /// 审计：init 之后应开启 WAL 与 busy_timeout（多开实例 / 外部读库时的健壮性）
    #[test]
    fn test_init_enables_wal_and_busy_timeout() {
        let tmp = TempDir::new("wakeyweeky-wal");
        let db_path = tmp.join("wakeyweeky.sqlite");

        let conn = init(&db_path).expect("init 失败");
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .expect("读取 journal_mode 失败");
        assert_eq!(mode.to_lowercase(), "wal");
        let busy: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .expect("读取 busy_timeout 失败");
        assert_eq!(busy, 5_000);

        drop(conn);
        // 目录由 TempDir 的 Drop 收拾（断言失败时也不会漏）
    }

    /// 托盘基线：只有「planned 且覆盖当下」的块算进行中（B1-1/B1-3）
    #[test]
    fn test_has_current_block_detects_running_block() {
        let conn = test_conn();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO tasks (id, title, category, created_at) VALUES ('t1','读书',NULL,?1)",
            [now],
        )
        .expect("插入任务失败");

        let insert = |id: &str, start: i64, end: i64| {
            conn.execute(
                "INSERT INTO blocks (id, task_id, start_at, end_at, status, last_notified_at, created_at)
                 VALUES (?1,'t1',?2,?3,'planned',NULL,?4)",
                rusqlite::params![id, start, end, now],
            )
            .expect("插入块失败");
        };

        insert("b-future", now + 600, now + 1200);
        assert!(
            !has_current_block(&conn, now).expect("查询失败"),
            "尚未开始的块不算进行中"
        );

        insert("b-past", now - 1200, now - 600);
        assert!(
            !has_current_block(&conn, now).expect("查询失败"),
            "已结束但未标记的块不算进行中（逾期由通知负责）"        );

        insert("b-now", now - 600, now + 600);
        assert!(
            has_current_block(&conn, now).expect("查询失败"),
            "覆盖当下的 planned 块 → 进行中"
        );

        conn.execute("UPDATE blocks SET status='done' WHERE id='b-now'", [])
            .expect("标记完成失败");
        assert!(
            !has_current_block(&conn, now).expect("查询失败"),
            "已完成的块不算进行中"
        );
    }

    /// 边界：两端点都算进行中（start_at ≤ now ≤ end_at）；missed 同样被排除
    #[test]
    fn test_has_current_block_boundaries() {
        let conn = test_conn();
        let now = 1_700_000_000i64;
        conn.execute(
            "INSERT INTO tasks (id, title, category, created_at) VALUES ('t1','读书',NULL,?1)",
            [now],
        )
        .expect("插入任务失败");
        conn.execute(
            "INSERT INTO blocks (id, task_id, start_at, end_at, status, last_notified_at, created_at)
             VALUES ('b1','t1',?1,?1,'planned',NULL,?1)",
            [now],
        )
        .expect("插入块失败");

        assert!(
            has_current_block(&conn, now).expect("查询失败"),
            "start_at == now == end_at 应算进行中"
        );

        conn.execute(
            "UPDATE blocks SET start_at=?1, end_at=?2 WHERE id='b1'",
            rusqlite::params![now - 10, now - 1],
        )
        .expect("更新块失败");
        assert!(
            !has_current_block(&conn, now).expect("查询失败"),
            "end_at < now → 已结束"
        );

        conn.execute(
            "UPDATE blocks SET start_at=?1, end_at=?2 WHERE id='b1'",
            rusqlite::params![now + 1, now + 100],
        )
        .expect("更新块失败");
        assert!(
            !has_current_block(&conn, now).expect("查询失败"),
            "start_at > now → 未开始"
        );

        conn.execute(
            "UPDATE blocks SET start_at=?1, end_at=?2, status='missed' WHERE id='b1'",
            rusqlite::params![now - 10, now + 10],
        )
        .expect("更新块失败");
        assert!(
            !has_current_block(&conn, now).expect("查询失败"),
            "missed 的块不算进行中"
        );
    }

    /// round62（11 一行提示）：取当前块的名字与结束时刻 —— 判定与 `has_current_block` 同口径
    #[test]
    fn test_current_block_hint_basics() {
        let conn = test_conn();
        let now = 1_700_000_000i64;
        conn.execute(
            "INSERT INTO tasks (id, title, category, created_at) VALUES ('t1','写周报',NULL,?1)",
            [now],
        )
        .expect("插入任务失败");
        conn.execute(
            "INSERT INTO blocks (id, task_id, start_at, end_at, status, last_notified_at, created_at)
             VALUES ('b1','t1',?1,?2,'planned',NULL,?3)",
            rusqlite::params![now - 600, now + 1380, now],
        )
        .expect("插入块失败");

        let hint = current_block_hint(&conn, now)
            .expect("查询失败")
            .expect("应有当前块");
        assert_eq!(hint.title, "写周报");
        assert_eq!(hint.end_at, now + 1380);

        // 端点：start_at == now == end_at 也算（与 has_current_block 一致）
        conn.execute(
            "UPDATE blocks SET start_at=?1, end_at=?1 WHERE id='b1'",
            [now],
        )
        .expect("更新失败");
        assert!(
            current_block_hint(&conn, now).expect("查询失败").is_some(),
            "两端点相同时应算进行中"
        );

        // end_at < now → 已结束，不取
        conn.execute(
            "UPDATE blocks SET start_at=?1, end_at=?2 WHERE id='b1'",
            rusqlite::params![now - 10, now - 1],
        )
        .expect("更新失败");
        assert!(
            current_block_hint(&conn, now).expect("查询失败").is_none(),
            "已结束的块不该被取到"
        );

        // done 不算（同 has_current_block）
        conn.execute(
            "UPDATE blocks SET start_at=?1, end_at=?2, status='done' WHERE id='b1'",
            rusqlite::params![now - 10, now + 10],
        )
        .expect("更新失败");
        assert!(
            current_block_hint(&conn, now).expect("查询失败").is_none(),
            "done 的块不算进行中"
        );
    }

    /// round62：多块同时在跑时的取用顺序 —— **必填 → 同层先开始 → rowid 兜底**
    #[test]
    fn test_current_block_hint_priority() {
        let conn = test_conn();
        let now = 1_700_000_000i64;
        conn.execute(
            "INSERT INTO tasks (id, title, category, created_at)
             VALUES ('t1','甲',NULL,?1),('t2','乙',NULL,?1),('t3','丙',NULL,?1)",
            [now],
        )
        .expect("插入任务失败");
        let insert = |id: &str, task: &str, start: i64, layer: &str| {
            conn.execute(
                "INSERT INTO blocks (id, task_id, start_at, end_at, status, last_notified_at, created_at, layer)
                 VALUES (?1,?2,?3,?4,'planned',NULL,?5,?6)",
                rusqlite::params![id, task, start, now + 600, now, layer],
            )
            .expect("插入块失败");
        };

        // 弹性先开始、必填后开始 → 必填赢
        insert("b-elastic-early", "t1", now - 900, "elastic");
        insert("b-required-late", "t2", now - 60, "required");
        assert_eq!(
            current_block_hint(&conn, now)
                .expect("查询失败")
                .expect("应有当前块")
                .title,
            "乙",
            "必填应优先于更早开始的弹性块"
        );

        // 同为弹性 → 开始更早的（先来的）赢
        conn.execute("DELETE FROM blocks WHERE id='b-required-late'", [])
            .expect("删除失败");
        insert("b-elastic-later", "t3", now - 30, "elastic");
        assert_eq!(
            current_block_hint(&conn, now)
                .expect("查询失败")
                .expect("应有当前块")
                .title,
            "甲",
            "同层取先开始的"
        );
    }

    /// round62：临时块用自己 `label`（与前端 `block.label ?? 任务名` 同名规则一致）
    #[test]
    fn test_current_block_hint_temp_label_wins() {
        let conn = test_conn();
        let now = 1_700_000_000i64;
        let b = create_temp_block(&conn, now - 600, now + 1200).expect("建临时块失败");
        assert_eq!(
            current_block_hint(&conn, now)
                .expect("查询失败")
                .expect("应有当前块")
                .title,
            i18n::t(TEMP_TASK_TITLE),
            "没命名的临时块 → 隐藏任务名（临时安排）"
        );

        conn.execute(
            "UPDATE blocks SET label='浇花' WHERE id=?1",
            [&b.id],
        )
        .expect("改名失败");
        assert_eq!(
            current_block_hint(&conn, now)
                .expect("查询失败")
                .expect("应有当前块")
                .title,
            "浇花",
            "临时块自己的名字优先"
        );
    }

    /// 设置读写（C13 的「提醒计划」开关就存在这里）
    #[test]
    fn test_settings_round_trip() {
        let conn = test_conn();
        assert_eq!(get_setting(&conn, "scheduler_enabled").expect("读失败"), None, "默认没有这一项");

        set_setting(&conn, "scheduler_enabled", "0").expect("写入失败");
        assert_eq!(
            get_setting(&conn, "scheduler_enabled").expect("读失败").as_deref(),
            Some("0")
        );

        set_setting(&conn, "scheduler_enabled", "1").expect("覆盖写入失败");
        assert_eq!(
            get_setting(&conn, "scheduler_enabled").expect("读失败").as_deref(),
            Some("1"),
            "同 key 应覆盖"
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings", [], |r| r.get(0))
            .expect("统计失败");
        assert_eq!(count, 1, "同一个 key 只能有一行");
    }

    /// 测试用：把成员块 id 按链序列出来（`Sequence` 对外只暴露 members，不再提供快捷方法）
    fn ids(sequence: &Sequence) -> Vec<String> {
        sequence.members.iter().map(|m| m.block_id.clone()).collect()
    }

    /// 测试用：某个块记了多少条事件（C1.1 用它断言「没变化就不写事件」）
    fn event_count(conn: &Connection, block_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM events WHERE block_id = ?1",
            [block_id],
            |row| row.get(0),
        )
        .expect("查询事件数失败")
    }

    /// 漂流链的不变量断言（C2 核心）：一条链上**最多只有一个 planned**（线性链，用 child_of 往下走）
    fn assert_single_active_in_chain(conn: &Connection, block_id: &str) {
        let mut ids = vec![block_id.to_string()];

        let mut cursor = load_block(conn, block_id).expect("查询失败").expect("块在");
        while let Some(parent_id) = cursor.postponed_from.clone() {
            ids.push(parent_id.clone());
            cursor = load_block(conn, &parent_id).expect("查询失败").expect("块在");
        }

        let mut frontier = vec![block_id.to_string()];
        while let Some(current) = frontier.pop() {
            if let Some(child) = child_of(conn, &current).expect("查询失败") {
                ids.push(child.id.clone());
                frontier.push(child.id);
            }
        }

        let planned = ids
            .iter()
            .filter(|id| {
                load_block(conn, id)
                    .expect("查询失败")
                    .map(|block| block.status == "planned")
                    .unwrap_or(false)
            })
            .count();
        assert!(planned <= 1, "一条漂流链最多只能有一个活跃块，实际 {planned} 个");
    }

    /// 链的自洽断言（C3.4）：按环序排，块的时间必须**不递减**。
    /// 这正是用户实测报的那类错序（① 在 ② 后面）—— 以后每个涉及链的测试都调它。
    fn assert_chain_consistent(conn: &Connection, sequence_id: &str) {
        let members = get_sequence(conn, sequence_id)
            .expect("查询序列失败")
            .expect("序列应存在");
        let mut times: Vec<(i64, i64)> = Vec::new();
        for member in &members.members {
            let block = load_block(conn, &member.block_id)
                .expect("查询块失败")
                .expect("块应存在");
            times.push((member.order_index, block.start_at));
        }
        for pair in times.windows(2) {
            if pair[0].0 != pair[1].0 {
                assert!(
                    pair[0].1 <= pair[1].1,
                    "链自洽被破坏：环{} 的时间 {} 晚于 环{} 的时间 {}",
                    pair[0].0,
                    pair[0].1,
                    pair[1].0,
                    pair[1].1
                );
            }
        }
    }

    /// 序列：新建时按开始时间排序（哪怕传入顺序是反的）
    #[test]
    fn test_create_sequence_orders_by_start_time() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let later = create_block(&conn, &task.id, 5_000, 6_800).expect("建块失败");
        let earlier = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");

        let seq = create_sequence(&conn, "晨间流程", &[later.id.clone(), earlier.id.clone()])
            .expect("建序列失败");
        assert_eq!(
            ids(&seq),
            vec![earlier.id, later.id],
            "初始顺序按开始时间（用户是顺着时间点链接的）"
        );

        let index_of = |block_id: &str| -> i64 {
            conn.query_row(
                "SELECT order_index FROM sequence_members WHERE block_id = ?1",
                [block_id],
                |r| r.get(0),
            )
            .expect("查 order_index 失败")
        };
        assert_eq!(index_of(&ids(&seq)[0]), 0);
        assert_eq!(index_of(&ids(&seq)[1]), 1);
    }

    /// 序列：异常输入全部拒绝（太少、空名、超长、重复、块不存在、块已属于别的序列）
    #[test]
    fn test_create_sequence_rejects_bad_input() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let c = create_block(&conn, &task.id, 5_000, 6_800).expect("建块失败");

        assert!(
            create_sequence(&conn, "只有一个", std::slice::from_ref(&a.id)).is_err(),
            "<2 个块要拒绝"
        );
        assert!(
            create_sequence(&conn, "   ", &[a.id.clone(), b.id.clone()]).is_err(),
            "空名要拒绝"
        );
        let long = "字".repeat(MAX_TITLE_CHARS + 1);
        assert!(
            create_sequence(&conn, &long, &[a.id.clone(), b.id.clone()]).is_err(),
            "超长要拒绝"
        );
        assert!(
            create_sequence(&conn, "重复", &[a.id.clone(), a.id.clone()]).is_err(),
            "同一个块不能重复"
        );
        assert!(
            create_sequence(&conn, "不存在", &[a.id.clone(), "不存在的块".into()]).is_err(),
            "块不存在要拒绝"
        );

        create_sequence(&conn, "第一链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");
        assert!(
            create_sequence(&conn, "第二链", &[b.id.clone(), c.id.clone()]).is_err(),
            "块已属于别的序列 → 明确拒绝（Q4）"
        );
    }

    /// 序列：延长与自动清理（<2 个成员就不留空壳）
    #[test]
    fn test_add_and_remove_members() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let c = create_block(&conn, &task.id, 5_000, 6_800).expect("建块失败");

        let seq = create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");
        // C3.3：把 C 接在 B（链尾）后面 → 插在它的后继位置（与「两次左键接链」同一条路）
        link_after(&conn, &b.id, &c.id, None).expect("接链失败");
        let after_link = get_sequence(&conn, &seq.id).expect("查询失败").expect("序列在");
        assert_eq!(
            ids(&after_link),
            vec![a.id.clone(), b.id.clone(), c.id.clone()],
            "C 应接在 B 后面"
        );
        assert_eq!(after_link.id, seq.id, "不能新建第二条");
        // 重复接同一条 → 幂等（同链内重排回原位）
        link_after(&conn, &b.id, &c.id, None).expect("重复接链应幂等");
        let again = get_sequence(&conn, &seq.id).expect("查询失败").expect("序列在");
        assert_eq!(ids(&again).len(), 3);

        // 移出一个 → 还剩 2（不删）
        assert!(!remove_member(&conn, &seq.id, &c.id).expect("移出失败"), "还剩 2 个不该删");
        // 再移出一个 → 只剩 1 → 序列自动删除（Q6）
        assert!(remove_member(&conn, &seq.id, &b.id).expect("移出失败"), "剩 1 个应自动删除");
        assert!(get_sequence(&conn, &seq.id).expect("查询失败").is_none(), "空壳不该留下");
        // 不在序列里的块 → 明确报错
        assert!(remove_member(&conn, &seq.id, &a.id).is_err(), "序列已不存在");
    }

    /// round60（10.1 统计页）：从序列取出记一条 unlink（含「取到剩 1 个 → 序列自动消失」那种）
    #[test]
    fn test_remove_member_logs_unlink_event() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1000, 2800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3000, 4800).expect("建块失败");
        let seq = create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");

        remove_member(&conn, &seq.id, &b.id).expect("移出失败");
        let count = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM events WHERE event_type = 'unlink'",
                [],
                |r| r.get(0),
            )
            .expect("统计事件失败")
        };
        assert_eq!(count(&conn), 1);
        // 已被取出的块再取 → 报错，不记第二条
        assert!(remove_member(&conn, &seq.id, &b.id).is_err());
        assert_eq!(count(&conn), 1, "失败的操作不该记账");
    }

    /// 序列：删除序列**不动块**（Q5，关键行为）
    #[test]
    fn test_delete_sequence_keeps_blocks() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let seq = create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");

        assert_eq!(delete_sequence(&conn, &seq.id).expect("删除失败"), 1);
        assert_eq!(delete_sequence(&conn, &seq.id).expect("重复删除"), 0, "幂等：第二次删到 0 行");

        let blocks = list_blocks(&conn, 0, 10_000).expect("查询块失败");
        assert_eq!(blocks.len(), 2, "删序列绝不能删块（Q5）");
        assert_eq!(blocks[0].status, "planned", "块状态也不该被动");
        assert!(sequence_of_block(&conn, &a.id).expect("查询失败").is_none(), "链接应已解除");
    }

    /// 序列：只返回「窗口内有成员」的序列，但成员给全（前端据此只画窗口内的线）
    #[test]
    fn test_list_sequences_window_and_members() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let inside = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let outside = create_block(&conn, &task.id, 9_000, 10_800).expect("建块失败");
        let other_task = create_task(&conn, "写作", None).expect("建任务失败");
        let far1 = create_block(&conn, &other_task.id, 90_000, 91_000).expect("建块失败");
        let far2 = create_block(&conn, &other_task.id, 92_000, 93_000).expect("建块失败");

        create_sequence(&conn, "跨窗口链", &[inside.id.clone(), outside.id.clone()])
            .expect("建序列失败");
        create_sequence(&conn, "完全在窗口外", &[far1.id, far2.id]).expect("建序列失败");

        let found = list_sequences(&conn, 0, 10_000).expect("查询失败");
        assert_eq!(found.len(), 1, "只有一条在窗口内有成员");
        assert_eq!(ids(&found[0]).len(), 2, "成员要给全（含窗口外的那个）");
        assert_eq!(ids(&found[0])[0], inside.id, "顺序按链序");
    }

    /// C3.1：**延长按链接顺序，不按时间** —— 顺序依赖链的关键（用户实测反馈后修正）
    #[test]
    fn test_extend_appends_by_link_order_not_time() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let early = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let late = create_block(&conn, &task.id, 9_000, 10_800).expect("建块失败");
        let middle = create_block(&conn, &task.id, 5_000, 6_800).expect("建块失败");

        let seq = create_sequence(&conn, "链", &[early.id.clone(), late.id.clone()])
            .expect("建序列失败");
        // C3.3：把 middle 接在 late 后面 → 插在它后面；而 middle 的时间(5000)比 late(9000)早
        // → 应**自动顺延**到 late 之后（不再允许接出一个错序的链）
        let outcome = link_after(&conn, &late.id, &middle.id, None).expect("接链失败");
        assert!(
            outcome.block.start_at >= late.end_at,
            "时间不对应自动顺延到 A 之后：{} vs {}",
            outcome.block.start_at,
            late.end_at
        );
        let after = get_sequence(&conn, &seq.id).expect("查询失败").expect("序列在");
        assert_eq!(
            ids(&after),
            vec![early.id.clone(), late.id.clone(), middle.id.clone()],
            "链序按接链的先后（不是按时间）"
        );
    }

    /// C3.1：漂流**不脱链** —— 新块接替原来那一环（与残影共享位置）
    #[test]
    fn test_postpone_keeps_sequence_position() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let seq = create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");

        // 把 A 标为未完成（变残影），再漂到**B 之前**（不越序 → 不该级联）
        mark_block_missed(&conn, &a.id).expect("标记失败");
        let result = postpone_block(&conn, &a.id, 2_900).expect("漂流失败");
        assert_eq!(result.cascaded, 0, "新时段仍在 B 之前 → 不算越序");

        let after = get_sequence(&conn, &seq.id).expect("查询失败").expect("序列不该消失");
        let positions: Vec<(String, i64)> = after
            .members
            .iter()
            .map(|m| (m.block_id.clone(), m.order_index))
            .collect();
        assert!(
            positions.contains(&(a.id.clone(), 0)),
            "残影保留原序号位（Q4）"
        );
        assert!(
            positions.contains(&(result.block.id.clone(), 0)),
            "新块接替同一环（同序号）"
        );
        assert!(
            positions.contains(&(b.id.clone(), 1)),
            "B 仍在第二环（位置不因时间而重排）"
        );
    }

    /// round64.1（验收 #1 复核）：漂流开关关掉 → 漂流产生的子块**不在场**：
    /// 列表/当前块/提示/提醒/融合候选都不看它；**数据一行不删**，开回来原样。
    #[test]
    fn test_drift_children_hidden_when_feature_off() {
        let conn = test_conn();
        let task = create_task(&conn, "数学", None).expect("建任务失败");
        let first = create_block(&conn, &task.id, 10_000, 13_600).expect("建块失败");
        mark_block_missed(&conn, &first.id).expect("标记失败");
        let child = postpone_block(&conn, &first.id, 20_000).expect("漂流失败").block;
        assert!(child.postponed_from.is_some(), "这是漂流产生的子块");
        assert_eq!(
            list_blocks(&conn, 0, 30_000).unwrap().len(),
            2,
            "开着：残影 + 子块都在"
        );
        assert!(
            !crate::notify::due_starts(&conn, child.start_at)
                .unwrap()
                .is_empty(),
            "对照组：开着时开始提醒会看到它（免得下面那条空过）"
        );

        set_setting(&conn, crate::features::DRIFT, "0").unwrap();
        let visible = list_blocks(&conn, 0, 30_000).unwrap();
        assert_eq!(visible.len(), 1, "关掉：只剩残影");
        assert!(visible[0].postponed_from.is_none());
        let inside = child.start_at + 60;
        assert!(
            !has_current_block(&conn, inside).unwrap(),
            "隐藏的块不算「正在进行」"
        );
        assert!(
            current_block_hint(&conn, inside).unwrap().is_none(),
            "托盘/标题不看它"
        );
        assert!(
            crate::notify::due_blocks(&conn, child.end_at + 60)
                .unwrap()
                .is_empty(),
            "隐藏的块不提醒（结束）"
        );
        assert!(
            crate::notify::due_starts(&conn, child.start_at)
                .unwrap()
                .is_empty(),
            "隐藏的块不提醒（开始）"
        );
        assert!(
            merge_candidates(&conn, &visible[0])
                .unwrap()
                .iter()
                .all(|b| b.postponed_from.is_none()),
            "隐藏块不被选作融合候选"
        );

        set_setting(&conn, crate::features::DRIFT, "1").unwrap();
        assert_eq!(
            list_blocks(&conn, 0, 30_000).unwrap().len(),
            2,
            "开回来原样（数据没删）"
        );
    }

    /// round64.1：越序级联（挤压）跳过隐藏的漂流子块 —— 它不能被顺延。
    #[test]
    fn test_cascade_skips_hidden_drift_children_when_drift_off() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 1_900).expect("建块失败");
        let b = create_block(&conn, &task.id, 2_000, 2_900).expect("建块失败");
        create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");
        // b 漂出去 → c 接替 b 的环位（C3.1）；b 变残影
        mark_block_missed(&conn, &b.id).expect("标记失败");
        let c = postpone_block(&conn, &b.id, 20_000).expect("漂流失败").block;
        assert!(c.postponed_from.is_some());

        set_setting(&conn, crate::features::DRIFT, "0").unwrap();
        let before = load_block(&conn, &c.id).unwrap().unwrap().start_at;
        update_block(&conn, &a.id, None, Some(25_000), Some(25_900), None).expect("挪块失败");
        let after = load_block(&conn, &c.id).unwrap().unwrap().start_at;
        assert_eq!(after, before, "关掉漂流：隐藏的子块不参与顺延");

        // 对照组：开着时同一个动作会把它顺延（免得这条断言是恒真的）
        set_setting(&conn, crate::features::DRIFT, "1").unwrap();
        update_block(&conn, &a.id, None, Some(1_000), Some(1_900), None).expect("挪回失败");
        update_block(&conn, &a.id, None, Some(25_000), Some(25_900), None).expect("再挪失败");
        let moved = load_block(&conn, &c.id).unwrap().unwrap().start_at;
        assert!(moved > before, "对照组：开着时会被顺延（{moved} > {before}）");
    }

    /// C3.1：漂到后续链节**之后** → 被越过的计划中链节一起顺延（链序不变、时长不变）
    #[test]
    fn test_postpone_cascades_skipped_members() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let c = create_block(&conn, &task.id, 5_000, 6_800).expect("建块失败");
        let seq = create_sequence(
            &conn,
            "链",
            &[a.id.clone(), b.id.clone(), c.id.clone()],
        )
        .expect("建序列失败");

        mark_block_missed(&conn, &a.id).expect("标记失败");
        let far = 100_000i64;
        let result = postpone_block(&conn, &a.id, far).expect("漂流失败");
        assert_eq!(result.cascaded, 2, "B、C 都被越过 → 都该顺延");
        assert_eq!(result.block.start_at, far);

        let all = list_blocks(&conn, 0, 200_000).expect("查询失败");
        let grab = |id: &str| {
            all.iter()
                .find(|blk| blk.id == id)
                .cloned()
                .expect("块不见了")
        };
        let b_after = grab(&b.id);
        let c_after = grab(&c.id);
        assert!(
            b_after.start_at >= result.block.end_at,
            "B 应排在漂移块之后"
        );
        assert!(c_after.start_at >= b_after.end_at, "C 应排在 B 之后（链序保持）");
        assert_chain_consistent(&conn, &seq.id); // C3.4
        assert_eq!(
            b_after.end_at - b_after.start_at,
            b.end_at - b.start_at,
            "顺延不该改变时长"
        );
        assert_eq!(b_after.status, "planned", "顺延不该改状态");

        let seq_after = get_sequence(&conn, &seq.id).expect("查询失败").expect("序列在");
        // 链上现在有 4 节：残影 A 与新块**共享第 0 环**，B 第 1 环、C 第 2 环（位置不因时间重排）
        assert_eq!(
            ids(&seq_after),
            vec![
                a.id.clone(),
                result.block.id.clone(),
                b.id.clone(),
                c.id.clone()
            ],
            "残影 + 新块 + B + C（同环的按时间先后）"
        );
        let index_of = |block_id: &str| -> i64 {
            conn.query_row(
                "SELECT order_index FROM sequence_members WHERE block_id = ?1",
                [block_id],
                |r| r.get(0),
            )
            .expect("查序号失败")
        };
        assert_eq!(index_of(&a.id), 0);
        assert_eq!(index_of(&result.block.id), 0, "新块与残影同环");
        assert_eq!(index_of(&b.id), 1, "B 的环号不变");
        assert_eq!(index_of(&c.id), 2, "C 的环号不变");
    }

    /// C3.2（用户实测场景）：被越过的环如果**全是历史**（已完成、且没有活跃块）
    /// → **连历史一起顺延**，并单独计数（好在界面提示「历史也被挪了」）
    #[test]
    fn test_cascade_moves_history_when_ring_has_no_planned() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");

        // ② 已经完成（历史），然后把 ① 漂到它后面 → 链必须被拉回顺序
        mark_block_done(&conn, &b.id).expect("标记失败");
        mark_block_missed(&conn, &a.id).expect("标记失败");
        let result = postpone_block(&conn, &a.id, 50_000).expect("漂流失败");
        assert_eq!(result.cascaded, 1, "② 那一环全是历史 → 也要顺延");
        assert_eq!(result.history_moved, 1, "历史被挪要单独计数");

        let b_after = load_block(&conn, &b.id).expect("查询失败").expect("块在");
        assert!(
            b_after.start_at >= result.block.end_at,
            "② 应被挪到 ① 之后（链序恢复）"
        );
        assert_eq!(b_after.status, "done", "状态不变（只是时间被挪）");
        assert_eq!(b_after.end_at - b_after.start_at, 1_800, "时长不变");
    }

    /// C3.2：被越过的环**有活跃块** → 只顺延活跃块，残影留在原位当历史
    #[test]
    fn test_cascade_moves_live_block_and_keeps_ghost_in_place() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");

        // 把 ② 漂出去（成残影 + 同环的新块 b2）
        mark_block_missed(&conn, &b.id).expect("标记失败");
        let b2 = postpone_block(&conn, &b.id, 5_000).expect("漂流失败").block;
        let b_ghost_before = load_block(&conn, &b.id).expect("查询失败").expect("块在");

        // 再把 ① 漂到很后面 → ② 环有活跃块 b2，应只顺延 b2
        mark_block_missed(&conn, &a.id).expect("标记失败");
        let result = postpone_block(&conn, &a.id, 50_000).expect("漂流失败");
        assert_eq!(result.cascaded, 1, "只应顺延一个（那一环的活跃块）");
        assert_eq!(result.history_moved, 0, "有活跃块时不碰历史");

        let b_ghost_after = load_block(&conn, &b.id).expect("查询失败").expect("块在");
        assert_eq!(
            b_ghost_after.start_at, b_ghost_before.start_at,
            "残影留在原位（它是历史）"
        );
        let b2_after = load_block(&conn, &b2.id).expect("查询失败").expect("块在");
        assert!(
            b2_after.start_at >= result.block.end_at,
            "活跃块 b2 被顺延到 ① 之后"
        );
    }

    /// C3.2：`update_block` 只改时间也能移动块，且**链节关系不变**（用户要的「仅时间变化」）
    #[test]
    fn test_update_block_moves_and_keeps_links() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let seq = create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");

        // 把 ① 往后挪一点（但仍在 ② 之前）→ 不算越序、不动别人
        let outcome = update_block(&conn, &a.id, None, Some(2_900), None, None).expect("移动失败");
        assert_eq!(outcome.block.start_at, 2_900);
        assert_eq!(outcome.block.end_at, 2_900 + 1_800, "时长保持");
        assert_eq!(outcome.cascaded, 0, "没越过任何环");

        let after = get_sequence(&conn, &seq.id).expect("查询失败").expect("序列在");
        assert!(
            ids(&after).contains(&a.id),
            "链节关系不能因为移动而丢（这就是用户要的）"
        );
    }

    /// C3.2：把链节排到**前面那一环**之前 → 明确拒绝（顺序依赖的防线）
    #[test]
    fn test_update_block_refuses_moving_before_previous_ring() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 10_000, 11_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 12_000, 13_800).expect("建块失败");
        create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");

        let err = update_block(&conn, &b.id, None, Some(5_000), None, None).unwrap_err();
        assert!(err.contains("前一环"), "拒绝理由要看得懂：{err}");

        let b_after = load_block(&conn, &b.id).expect("查询失败").expect("块在");
        assert_eq!(b_after.start_at, 12_000, "被拒绝时数据不能动");
    }

    /// C3.2：拖到很后面 → 与漂流同一条级联规则
    #[test]
    fn test_update_block_cascades_when_jumping_ahead() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let c = create_block(&conn, &task.id, 5_000, 6_800).expect("建块失败");
        create_sequence(
            &conn,
            "链",
            &[a.id.clone(), b.id.clone(), c.id.clone()],
        )
        .expect("建序列失败");

        let outcome = update_block(&conn, &a.id, None, Some(20_000), None, None).expect("移动失败");
        assert_eq!(outcome.cascaded, 2, "越过了 ② ③ → 都顺延");

        let b_after = load_block(&conn, &b.id).expect("查询失败").expect("块在");
        let c_after = load_block(&conn, &c.id).expect("查询失败").expect("块在");
        assert!(b_after.start_at >= outcome.block.end_at, "② 被挪到 ① 之后");
        assert!(c_after.start_at >= b_after.end_at, "③ 排到 ② 之后（链序）");
    }

    /// C1.1：两个时间都给 = 显式改时段（拉伸走这条）；时长真的会变
    #[test]
    fn test_update_block_explicit_range_changes_duration() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let block = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");

        let outcome =
            update_block(&conn, &block.id, None, Some(1_000), Some(6_400), None).expect("拉伸失败");
        assert_eq!(outcome.block.start_at, 1_000, "起点不动");
        assert_eq!(outcome.block.end_at, 6_400, "终点从 30 分钟拉到 1.5 小时");
        assert_eq!(outcome.cascaded, 0, "没有链，不该顺延任何人");
    }

    /// C1.1 边界：少于 15 分钟的块一律拒绍（v2 ⑧B「最小 15 分钟步进」）
    #[test]
    fn test_block_shorter_than_15_minutes_is_rejected() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");

        create_block(&conn, &task.id, 1_000, 1_900).expect("正好 15 分钟应当允许");

        let err = create_block(&conn, &task.id, 5_000, 5_899).unwrap_err();
        assert!(err.contains("15 分钟"), "拒绍理由要看得懂：{err}");

        let block = create_block(&conn, &task.id, 10_000, 11_800).expect("建块失败");
        let err = update_block(&conn, &block.id, None, Some(10_000), Some(10_899), None).unwrap_err();
        assert!(err.contains("15 分钟"), "拉伸也不能破线：{err}");
        let after = load_block(&conn, &block.id).expect("查询失败").expect("块在");
        assert_eq!(after.end_at, 11_800, "被拒绍时数据不能动");
    }

    /// C1.1 边界：拉长链上的块**不顺延任何后续环** —— 不变量按 start 判，拉长不改 start
    #[test]
    fn test_stretch_does_not_cascade_sequence() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let seq = create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");

        // ① 拉到压过 ② 的起点（重叠允许；start 序没变）
        let outcome = update_block(&conn, &a.id, None, Some(1_000), Some(3_500), None).expect("拉伸失败");
        assert_eq!(outcome.block.end_at, 3_500, "拉长真的生效");
        assert_eq!(outcome.cascaded, 0, "拉长不改 start → 不算越过任何环");

        let b_after = load_block(&conn, &b.id).expect("查询失败").expect("块在");
        assert_eq!(b_after.start_at, 3_000, "② 必须留在原地");
        assert_chain_consistent(&conn, &seq.id);
    }

    /// C1.1 边界：拉长漂流链上的块，漂流关系（`postponed_from`）与链尾规则不受影响
    #[test]
    fn test_stretch_keeps_drift_chain() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let ghost = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        mark_block_missed(&conn, &ghost.id).expect("标记失败");
        let moved = postpone_block(&conn, &ghost.id, 9_000).expect("漂流失败").block;

        let outcome =
            update_block(&conn, &moved.id, None, Some(9_000), Some(18_000), None).expect("拉伸失败");
        assert_eq!(outcome.block.end_at, 18_000, "拉长真的生效");
        assert_eq!(
            outcome.block.postponed_from.as_deref(),
            Some(ghost.id.as_str()),
            "漂流关系必须保留"
        );
        let tail = chain_tail(&conn, &ghost).expect("查链尾失败");
        assert_eq!(tail.id, moved.id, "链尾还是这一块");
        assert_single_active_in_chain(&conn, &ghost.id);
    }

    /// C1.1：事件里要同时记下终点的变化（只记 start 的话纯拉伸会记成 from == to，对 C6 没信息）
    #[test]
    fn test_stretch_records_end_in_event() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let block = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");

        update_block(&conn, &block.id, None, Some(1_000), Some(6_400), None).expect("拉伸失败");

        let payload: String = conn
            .query_row(
                "SELECT payload FROM events WHERE block_id = ?1 ORDER BY rowid DESC LIMIT 1",
                [&block.id],
                |row| row.get(0),
            )
            .expect("查事件失败");
        assert!(
            payload.contains("\"end_from\":2800"),
            "要记下原来的终点：{payload}"
        );
        assert!(payload.contains("\"end_to\":6400"), "要记下新的终点：{payload}");
    }

    /// C1.1 边界：时间没变就不写事件（拖回原位不该污染 C6 的「重排次数」）
    #[test]
    fn test_update_block_same_time_writes_no_event() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let block = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");

        let before = event_count(&conn, &block.id);
        update_block(&conn, &block.id, None, Some(1_000), Some(2_800), None).expect("原样改一次");
        assert_eq!(event_count(&conn, &block.id), before, "没变化就不该记事件");
    }

    /// C3.5：删掉链上某个块后，**环号不能留洞**（以前 CASCADE 清成员会留下 0,1,3,4…）
    #[test]
    fn test_delete_block_leaves_no_ring_gaps() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let c = create_block(&conn, &task.id, 5_000, 6_800).expect("建块失败");
        let d = create_block(&conn, &task.id, 7_000, 8_800).expect("建块失败");
        let seq = create_sequence(
            &conn,
            "链",
            &[a.id.clone(), b.id.clone(), c.id.clone(), d.id.clone()],
        )
        .expect("建序列失败");

        delete_block(&conn, &b.id).expect("删块失败");

        let after = get_sequence(&conn, &seq.id).expect("查询失败").expect("序列在");
        let rings: Vec<i64> = after.members.iter().map(|m| m.order_index).collect();
        assert_eq!(rings, vec![0, 1, 2], "删掉中间一环后环号要压实，不能留洞");
        assert_eq!(ids(&after), vec![a.id.clone(), c.id.clone(), d.id.clone()]);
        assert_chain_consistent(&conn, &seq.id);
    }

    /// C3.5：接链时新建序列也要校验名字（上一轮这个 helper 漏了 —— 两处规则不一致）
    #[test]
    fn test_link_after_validates_new_sequence_name() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");

        let long = "字".repeat(MAX_TITLE_CHARS + 1);
        assert!(
            link_after(&conn, &a.id, &b.id, Some(&long)).is_err(),
            "超长序列名要拒绝"
        );
        assert!(
            link_after(&conn, &a.id, &b.id, Some("   ")).is_err(),
            "空名要拒绝"
        );
        assert!(
            link_after(&conn, &a.id, &b.id, None).is_err(),
            "新建序列必须给名字"
        );
    }

    /// 漂流链不变量：反复漂流后链上始终只有一个活跃块（C2 的核心规则）
    #[test]
    fn test_drift_chain_keeps_single_active_block() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");

        mark_block_missed(&conn, &a.id).expect("标记失败");
        let b = postpone_block(&conn, &a.id, 9_000).expect("第一次漂流").block;
        assert_single_active_in_chain(&conn, &a.id);

        let again = postpone_block(&conn, &a.id, 15_000).expect("第二次漂流").block;
        assert_eq!(again.id, b.id, "链尾还是计划中 → 只改时间，不新建兄弟块");
        assert_single_active_in_chain(&conn, &a.id);

        mark_block_done(&conn, &b.id).expect("标记失败");
        let c = postpone_block(&conn, &a.id, 21_000).expect("第三次漂流").block;
        assert_ne!(c.id, b.id, "链尾已完成 → 应从链尾继续排下一段");
        assert_single_active_in_chain(&conn, &a.id);
    }

    /// C3.4（用户实测 bug）：新块时间**本来就晚于起点**、却晚于原来的后继时，
    /// 老后继也必须被级联顺延 —— 以前只在「新块自己被挪过」时才级联，于是留下错序。
    #[test]
    fn test_link_after_cascades_old_successor_even_when_new_block_is_later() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 10_000, 11_800).expect("建块失败"); // ①
        let s = create_block(&conn, &task.id, 12_000, 13_800).expect("建块失败"); // ②（原后继）
        let n = create_block(&conn, &task.id, 50_000, 51_800).expect("建块失败"); // 新块：时间晚得多
        let seq = create_sequence(&conn, "链", &[a.id.clone(), s.id.clone()]).expect("建序列失败");

        let outcome = link_after(&conn, &a.id, &n.id, None).expect("接链失败");
        assert_eq!(outcome.block.start_at, 50_000, "N 的时间本来就晚于 A → 不需要挪它自己");
        assert_eq!(outcome.cascaded, 1, "但原来的后继必须被顺延（这是那次 bug 的核心）");

        let after = get_sequence(&conn, &seq.id).expect("查询失败").expect("序列在");
        assert_eq!(
            ids(&after),
            vec![a.id.clone(), n.id.clone(), s.id.clone()],
            "N 插在 A 后面，S 排到 N 之后"
        );
        assert_chain_consistent(&conn, &seq.id); // ← 修之前这一行会红
    }

    /// C3.4：新链的顺序是**点击先后**（不按时间排序），时间由自动顺延对齐
    #[test]
    fn test_link_after_uses_click_order_for_new_sequence() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let later = create_block(&conn, &task.id, 50_000, 51_800).expect("建块失败");
        let earlier = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");

        // 先点 later（时间晚的），再点 earlier（时间早的）→ 链序应为 later → earlier
        let outcome = link_after(&conn, &later.id, &earlier.id, Some("新链")).expect("接链失败");
        let sequence_id = sequence_position(&conn, &later.id)
            .expect("查询失败")
            .expect("应在链上")
            .0;
        let after = get_sequence(&conn, &sequence_id).expect("查询失败").expect("序列在");
        assert_eq!(
            ids(&after),
            vec![later.id.clone(), earlier.id.clone()],
            "顺序 = 点击先后"
        );
        assert!(
            outcome.block.start_at >= later.end_at,
            "被接的那块时间不对 → 应被自动顺延到起点之后"
        );
        assert_chain_consistent(&conn, &sequence_id);
    }

    /// C3.3：接链**插在 A 后面**（不是链尾）—— 用户拍板的「方便插入」
    /// C1.6（用户实测反馈）：接链**不该**把已经排好顺序的块硬推下去。
    ///
    /// 用户场景：A 很长（10:00–12:00），B 的起点本来就在 A 之后（12:00），只是压在 A 的时段里。
    /// 拖动是允许这种重叠的（只看 start 序），接链却把它推到 A 结束之后 —— 两条路径两套标准。
    #[test]
    fn test_link_after_keeps_time_when_already_ordered() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        // C1.2 起「同任务重叠」会自动融合 → 这条测的是接链对齐，所以 B 用另一个任务（重叠本身仍是允许的）
        let other_task = create_task(&conn, "读书", None).expect("建任务失败");
        // A：10:00–12:00（长块）；B：起点在 A 之后、A 结束之前
        let a = create_block(&conn, &task.id, 10_000, 17_200).expect("建块失败");
        let b = create_block(&conn, &other_task.id, 12_000, 13_800).expect("建块失败");

        let outcome = link_after(&conn, &a.id, &b.id, Some("链")).expect("接链失败");
        assert_eq!(
            outcome.block.start_at, 12_000,
            "B 的起点本来就不早于 A 的起点 → 接链不该动它的时间"
        );
        assert_eq!(outcome.cascaded, 0, "更不该顺延别人");
    }

    #[test]
    fn test_link_after_inserts_right_behind_anchor() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let c = create_block(&conn, &task.id, 5_000, 6_800).expect("建块失败");
        let d = create_block(&conn, &task.id, 10_000, 11_800).expect("建块失败"); // 新块：时间本来在最后
        let seq = create_sequence(
            &conn,
            "链",
            &[a.id.clone(), b.id.clone(), c.id.clone()],
        )
        .expect("建序列失败");

        // 从 A 接到 D → D 应插在 A 与 B 之间
        link_after(&conn, &a.id, &d.id, None).expect("接链失败");
        let after = get_sequence(&conn, &seq.id).expect("查询失败").expect("序列在");
        assert_eq!(
            ids(&after),
            vec![a.id.clone(), d.id.clone(), b.id.clone(), c.id.clone()],
            "D 应插在 A 后面（不是接在链尾）"
        );
        assert_chain_consistent(&conn, &seq.id); // C3.4：环序必须与时间一致
        // 插入不该丢人：链尾还是 C
        assert_eq!(ids(&after).last().expect("非空"), &c.id);
    }

    /// C3.3：B 属于**别的**链 → 明确拒绝（不偷偷搬走）；已在**同链**里则视为链内重排
    #[test]
    fn test_link_after_rejects_other_chain_and_reorders_same_chain() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let c = create_block(&conn, &task.id, 5_000, 6_800).expect("建块失败");
        // C1.2：两块要留出间隔，否则会被自动融合
        let other_a = create_block(&conn, &task.id, 20_000, 21_800).expect("建块失败");
        let other_b = create_block(&conn, &task.id, 22_000, 23_800).expect("建块失败");

        let seq = create_sequence(
            &conn,
            "链",
            &[a.id.clone(), b.id.clone(), c.id.clone()],
        )
        .expect("建序列失败");
        create_sequence(&conn, "另一条", &[other_a.id.clone(), other_b.id.clone()])
            .expect("建序列失败");

        let err = link_after(&conn, &a.id, &other_b.id, None).unwrap_err();
        assert!(err.contains("另一条序列"), "跨链接应明确拒绝：{err}");

        // 同链内：把 C 接到 A 后面 → C 挪到第二位
        link_after(&conn, &a.id, &c.id, None).expect("链内重排失败");
        let after = get_sequence(&conn, &seq.id).expect("查询失败").expect("序列在");
        assert_eq!(
            ids(&after),
            vec![a.id.clone(), c.id.clone(), b.id.clone()],
            "链内重排：C 挪到 A 后面"
        );
    }

    /// C3.3：删块后不留空壳（外键 CASCADE 只清成员，序列本身要我们清）
    #[test]
    fn test_prune_short_sequences_after_block_delete() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        let seq = create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");

        // 删掉其中一个块 → 成员只剩 1 个 → 序列应自动消失
        delete_block(&conn, &a.id).expect("删块失败");
        assert!(
            get_sequence(&conn, &seq.id).expect("查询失败").is_none(),
            "只剩一个成员的序列不该留下空壳"
        );
        // 另一个块还在（不受影响）
        assert!(load_block(&conn, &b.id).expect("查询失败").is_some());

        // 启动时的兜底清理：手工造一个空壳再清
        conn.execute(
            "INSERT INTO sequences (id, name, created_at) VALUES ('孤儿', '历史遗留', 0)",
            [],
        )
        .expect("造空壳失败");
        assert_eq!(prune_short_sequences(&conn).expect("清理失败"), 1, "应清掉那个空壳");
    }

    /// 顺延落点会夹回时间轴的格子（**00:00–24:00**、30 分钟一格）
    #[test]
    fn test_snap_to_grid_helpers() {
        use chrono::{Local, TimeZone};
        // 凌晨 00:15 → 只向上取到 30 分钟格，**不再**被挪到 06:00（时间轴改成整天之后）
        let midnight = Local
            .with_ymd_and_hms(2026, 3, 1, 0, 15, 0)
            .single()
            .expect("本地时间");
        let snapped = snap_to_grid(midnight.timestamp());
        let local = Local.timestamp_opt(snapped, 0).single().expect("本地时间");
        assert_eq!(
            local.format("%Y-%m-%d %H:%M").to_string(),
            "2026-03-01 00:30",
            "凌晨的时刻不再被挪走，只取到 30 分钟格"
        );

        // 23:50 → 次日 00:00（不越到第三天）
        let late = Local
            .with_ymd_and_hms(2026, 3, 1, 23, 50, 0)
            .single()
            .expect("本地时间");
        let snapped = snap_to_grid(late.timestamp());
        let local = Local.timestamp_opt(snapped, 0).single().expect("本地时间");
        assert_eq!(
            local.format("%Y-%m-%d %H:%M").to_string(),
            "2026-03-02 00:00",
            "跨过 24:00 的时刻抹到次日 0 点"
        );

        let noonish = Local
            .with_ymd_and_hms(2026, 3, 1, 9, 7, 0)
            .single()
            .expect("本地时间");
        let snapped = snap_to_grid(noonish.timestamp());
        let local = Local.timestamp_opt(snapped, 0).single().expect("本地时间");
        assert_eq!(local.format("%H:%M").to_string(), "09:30", "向上取到 30 分钟格");
    }

    /// 规格 ⑧B7：`is_elastic=1` → 它拖出来的块**默认进弹性层**（补上 update_task 后这条才真正可达）
    #[test]
    fn test_elastic_task_defaults_block_layer() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");

        // 补上 update_task 之前：is_elastic 永远是 0，这条规则走不到弹性分支
        let normal = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        assert_eq!(normal.layer, "elastic", "C1.4：普通任务的块也默认弹性层");

        let updated =
            update_task(&conn, &task.id, None, None, None, Some(true)).expect("设为弹性任务失败");
        assert_eq!(updated.is_elastic, 1);

        let elastic = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");
        assert_eq!(elastic.layer, "elastic", "弹性任务拖出来的块应默认进弹性层（B7）");
    }

    /// update_task 的 patch 语义：只改传进来的字段；分类/时长传空值 = 清空
    #[test]
    fn test_update_task_patch_semantics() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", Some("学习")).expect("建任务失败");

        let updated = update_task(
            &conn,
            &task.id,
            Some("  读书一小时  ".into()),
            Some("阅读".into()),
            Some(90),
            None,
        )
        .expect("更新失败");
        assert_eq!(updated.title, "读书一小时", "标题要去首尾空格");
        assert_eq!(updated.category.as_deref(), Some("阅读"));
        assert_eq!(updated.estimated_minutes, Some(90));
        assert_eq!(updated.is_elastic, 0, "没传的字段不动");

        let cleared = update_task(
            &conn,
            &task.id,
            None,
            Some("   ".into()),
            Some(0),
            None,
        )
        .expect("清空失败");
        assert_eq!(cleared.category, None, "空串 = 清空分类");
        assert_eq!(cleared.estimated_minutes, None, "0 = 清空时长");
        assert_eq!(cleared.title, "读书一小时", "标题不受影响");

        // 异常输入
        assert!(
            update_task(&conn, &task.id, Some("  ".into()), None, None, None).is_err(),
            "空标题要拒绝"
        );
        assert!(
            update_task(&conn, &task.id, None, None, Some(24 * 60 + 1), None).is_err(),
            "超过一天的预估要拒绝"
        );
        assert!(update_task(&conn, "不存在的任务", None, None, None, Some(true)).is_err());
    }

    // ---------------------------------------------------------------- 8.1 分类管理

    /// 边界 1：改名把**整个分类**下的任务都带上（含已归档），别的分类与没分类的都不动
    #[test]
    fn test_rename_category_moves_all_tasks_including_archived() {
        let conn = test_conn();
        let a = create_task(&conn, "写周报", Some("工作")).expect("建任务失败");
        let b = create_task(&conn, "开周会", Some("工作")).expect("建任务失败");
        let c = create_task(&conn, "读书", Some("学习")).expect("建任务失败");
        let d = create_task(&conn, "没分类的", None).expect("建任务失败");
        archive_task(&conn, &b.id).expect("归档失败");

        let changed = rename_category(&conn, "  工作  ", "办公").expect("改名失败");
        assert_eq!(changed, 2, "两条「工作」都该跟着改（含归档那条）");
        assert_eq!(load_task(&conn, &a.id).unwrap().unwrap().category.as_deref(), Some("办公"));
        assert_eq!(
            load_task(&conn, &b.id).unwrap().unwrap().category.as_deref(),
            Some("办公"),
            "已归档的任务也要跟着改（否则归档列表里会露出旧名字）"
        );
        assert_eq!(load_task(&conn, &c.id).unwrap().unwrap().category.as_deref(), Some("学习"), "别的分类不动");
        assert_eq!(load_task(&conn, &d.id).unwrap().unwrap().category, None, "没分类的依然没分类");
    }

    /// 边界 2：新名恰好是另一个已有分类 = **合并**（没有单独的 merge 命令，就是这条 SQL）
    #[test]
    fn test_rename_category_into_existing_name_merges() {
        let conn = test_conn();
        let a = create_task(&conn, "写周报", Some("工作")).expect("建任务失败");
        let b = create_task(&conn, "读书", Some("学习")).expect("建任务失败");

        assert_eq!(rename_category(&conn, "工作", "学习").expect("合并失败"), 1);
        assert_eq!(load_task(&conn, &a.id).unwrap().unwrap().category.as_deref(), Some("学习"));
        assert_eq!(load_task(&conn, &b.id).unwrap().unwrap().category.as_deref(), Some("学习"), "目标那条不动");
        let names: Vec<String> = list_tasks(&conn)
            .expect("查任务失败")
            .into_iter()
            .filter_map(|t| t.category)
            .collect();
        assert_eq!(names, vec!["学习".to_string(), "学习".to_string()], "旧名字此后不该再出现");
    }

    /// 边界 3/4/5/6：原地保存（含只差空格）→ 0；旧名不存在 → 平静地 0；
    /// 空来源 / 超长 → 拒绝且**一点都不动**
    #[test]
    fn test_rename_category_noop_unknown_and_guards() {
        let conn = test_conn();
        let t = create_task(&conn, "写周报", Some("工作")).expect("建任务失败");

        assert_eq!(rename_category(&conn, "工作", " 工作 ").expect("不该报错"), 0, "只差首尾空格 = 原地保存");
        assert_eq!(load_task(&conn, &t.id).unwrap().unwrap().category.as_deref(), Some("工作"));

        assert_eq!(
            rename_category(&conn, "查无此类", "随便").expect("旧名不存在不该报错"),
            0,
            "界面可能是过期的——平静地改 0 条，不炸"
        );
        assert!(rename_category(&conn, "   ", "随便").is_err(), "空来源要拒绝");
        assert!(
            rename_category(&conn, "工作", &"字".repeat(MAX_CATEGORY_CHARS + 1)).is_err(),
            "超长要拒绝"
        );
        assert_eq!(load_task(&conn, &t.id).unwrap().unwrap().category.as_deref(), Some("工作"), "被拒绝时库里一点都不动");
    }

    /// 清空：新名传空串（/只有空格）= 这些任务回到「未分类」（8.1 拍板的第 4 条）+ 幂等
    #[test]
    fn test_rename_category_empty_target_clears() {
        let conn = test_conn();
        let t = create_task(&conn, "写周报", Some("工作")).expect("建任务失败");

        assert_eq!(rename_category(&conn, "工作", "   ").expect("清空失败"), 1);
        assert_eq!(load_task(&conn, &t.id).unwrap().unwrap().category, None, "空串 = 回到未分类");
        assert_eq!(rename_category(&conn, "工作", "").expect("再清一次不该报错"), 0, "已经没有了 → 0");
    }

    /// 边界 7/8：大小写不同算**两个**分类（本轮不引入大小写折叠）；隐藏任务碰不到
    #[test]
    fn test_rename_category_is_case_sensitive_and_safe_on_hidden_task() {
        let conn = test_conn();
        let a = create_task(&conn, "写周报", Some("Work")).expect("建任务失败");
        let b = create_task(&conn, "读书", Some("work")).expect("建任务失败");
        create_temp_block(&conn, 1_000, 2_800).expect("建临时块失败"); // 顺带建那块隐藏任务

        assert_eq!(rename_category(&conn, "Work", "work").expect("合并失败"), 1, "「Work」并进「work」");
        assert_eq!(load_task(&conn, &a.id).unwrap().unwrap().category.as_deref(), Some("work"));
        assert_eq!(load_task(&conn, &b.id).unwrap().unwrap().category.as_deref(), Some("work"));
        // 隐藏任务：`category` 恒为 NULL（临时安排块挂它上面）→ 改名的 WHERE 永远碰不到它
        let hidden = list_tasks(&conn)
            .expect("查任务失败")
            .into_iter()
            .find(|t| t.id == TEMP_TASK_ID)
            .expect("隐藏任务应该在 list_tasks 里");
        assert_eq!(hidden.category, None, "隐藏任务永远不带分类（所以改名不可能落到它头上）");
    }

    /// archive_task（⑧B8）：写 archived_at、**不删数据**；任务仍会出现在 `list_tasks`（round28 #2：
    /// 好让它在时间轴上的块还能拿到名字），**由 Backlog 视图**按 `archived_at` 过滤。
    #[test]
    fn test_archive_task_keeps_data_and_listed_with_flag() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let block = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");

        archive_task(&conn, &task.id).expect("归档失败");
        let listed = list_tasks(&conn).expect("查询失败");
        assert_eq!(listed.len(), 1, "归档任务仍要被返回（否则块名会变「?」）");
        assert!(
            listed[0].archived_at.is_some(),
            "带 archived_at → Backlog 视图据此隐藏它"
        );
        assert_eq!(listed[0].title, "读书", "名字还在（时间轴上的块靠它显示）");

        // 数据仍在（能按 id 读回来，且它的块还在）
        let archived = load_task(&conn, &task.id).expect("查询失败").expect("任务应还在");
        assert!(archived.archived_at.is_some(), "archived_at 应被写入");
        assert_eq!(
            list_blocks(&conn, 0, 10_000).expect("查询块失败").len(),
            1,
            "归档不能删块（与删除区分开）"
        );
        let _ = block;

        assert!(archive_task(&conn, "不存在的任务").is_err(), "不存在的任务要报错");
    }

    /// unarchive_task（round38 / 任务面板「恢复」）：把归档撤回 —— 归档从此不是单行道。
    /// 边界：数据与块一条不少；恢复后 `archived_at` 为空（Backlog 视图会重新列它）。
    #[test]
    fn test_unarchive_task_restores_to_backlog() {
        let conn = test_conn();
        let task = create_task(&conn, "旧项目", None).expect("建任务失败");
        let block = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");

        archive_task(&conn, &task.id).expect("归档失败");
        unarchive_task(&conn, &task.id).expect("恢复失败");

        let restored = load_task(&conn, &task.id).expect("查询失败").expect("任务应还在");
        assert!(
            restored.archived_at.is_none(),
            "恢复后 archived_at 置空 → Backlog 视图重新列它"
        );
        assert_eq!(restored.title, "旧项目", "名字不动");
        assert_eq!(
            list_blocks(&conn, 0, 10_000).expect("查询块失败").len(),
            1,
            "恢复只抹时间戳：时间轴上的块一条不少"
        );
        let _ = block;
    }

    /// unarchive_task 的失败路径：不存在的 id 要报错（不能静默成功 —— 前端据此弹提示）
    #[test]
    fn test_unarchive_task_rejects_unknown_id() {
        let conn = test_conn();
        assert!(
            unarchive_task(&conn, "不存在的任务").is_err(),
            "不存在的任务要报错"
        );
    }

    /// 改任务名：去空格 + 存进去（R7）
    #[test]
    fn test_rename_task_trims_and_saves() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");

        let renamed = rename_task(&conn, &task.id, "  读一小时书  ").expect("改名失败");
        assert_eq!(renamed.title, "读一小时书", "首尾空格应被去掉");
        assert_eq!(renamed.id, task.id, "id 不能变");

        let listed = list_tasks(&conn).expect("查询失败");
        assert_eq!(listed[0].title, "读一小时书", "改名要落库");
    }

    /// 改名不碰块表：块还在、关联不变。
    /// 注意：块本身**不存任务名** —— 时间轴上的名字是前端用 task_id 去任务表里取的（TimeSlot.svelte），
    /// 所以后端只要把名字改对，界面自然跟着变（R9）。
    #[test]
    fn test_rename_keeps_blocks_intact() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");

        rename_task(&conn, &task.id, "读一小时书").expect("改名失败");

        let blocks = list_blocks(&conn, 0, 10_000).expect("查询块失败");
        assert_eq!(blocks.len(), 1, "改名不该动块");
        assert_eq!(blocks[0].task_id, task.id, "块与任务的关联不能变");

        let tasks = list_tasks(&conn).expect("查询失败");
        assert_eq!(tasks[0].title, "读一小时书", "任务名已更新（前端据此显示新名字）");
    }

    /// 异常输入全部拒绝：空、纯空格、超长、不存在的 id（R5/R6/R12）
    #[test]
    fn test_rename_task_rejects_bad_input() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");

        assert!(rename_task(&conn, &task.id, "").is_err(), "空名字要拒绝");
        assert!(rename_task(&conn, &task.id, "   ").is_err(), "纯空格要拒绝");
        let too_long = "字".repeat(MAX_TITLE_CHARS + 1);
        assert!(rename_task(&conn, &task.id, &too_long).is_err(), "超长要拒绝");
        assert!(
            rename_task(&conn, "不存在的-id", "新名字").is_err(),
            "不存在的 id 要报错，不能静默成功"
        );

        let listed = list_tasks(&conn).expect("查询失败");
        assert_eq!(listed[0].title, "读书", "被拒绝时原名必须原封不动");
    }

    /// 改名到上限长度是可以的（边界：正好 200 字不算超长）
    #[test]
    fn test_rename_task_accepts_max_length() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let max = "字".repeat(MAX_TITLE_CHARS);
        let renamed = rename_task(&conn, &task.id, &max).expect("正好 200 字应通过");
        assert_eq!(renamed.title.chars().count(), MAX_TITLE_CHARS);
    }

    /// C1.6：跨周序列 —— 本周只看得到本周成员，但要告诉界面「下一周 / 上一周还有」
    #[test]
    fn test_list_sequences_reports_cross_week_flags() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let week = 1_000_000;
        let len = 604_800; // 一周（秒）
        let this_week = create_block(&conn, &task.id, week + 3_600, week + 7_200).expect("建块失败");
        let next_week =
            create_block(&conn, &task.id, week + len, week + len + 3_600).expect("建块失败");
        let seq = create_sequence(&conn, "链", &[this_week.id.clone(), next_week.id.clone()])
            .expect("建序列失败");

        let got = list_sequences(&conn, week, week + len).expect("查序列失败");
        assert_eq!(got.len(), 1, "只返回本周有成员的序列");
        assert_eq!(got[0].id, seq.id);
        assert!(!got[0].has_prev_week, "没有上一周的成员");
        assert!(got[0].has_next_week, "有一个成员在下一周");

        let next = list_sequences(&conn, week + len, week + len * 2).expect("查序列失败");
        assert_eq!(next.len(), 1, "下周看得到");
        assert!(next[0].has_prev_week, "反向：上一周还有");
        assert!(!next[0].has_next_week);
    }

    /// C3 补漏：漂流子块不能和它的父残影接进同一条序列（用户实测的 bug）
    #[test]
    fn test_link_after_rejects_same_drift_chain() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let first = create_block(&conn, &task.id, 10_000, 11_800).expect("建块失败");
        // 用户的现场就是「残影(missed) + 它的后续块(planned)」：先标未完成再漂流
        mark_block_missed(&conn, &first.id).expect("标记未完成失败");
        postpone_block(&conn, &first.id, 40_000).expect("漂流失败");
        let all = list_blocks(&conn, 0, 100_000).unwrap();
        let child = all
            .iter()
            .find(|b| b.postponed_from.is_some())
            .expect("应当有漂流后续块");
        let parent_id = child.postponed_from.clone().expect("有来源");
        // 两端里有一端是残影 → 会被「已经结束的块」拦；若将来规则变，也可能命中「漂流链」——
        // 两种拒绝都是对的，这里只要求**被拒绝且说清原因**
        let err = link_after(&conn, &parent_id, &child.id, Some("链")).expect_err("应当拒绝");
        assert!(
            err.contains("漂流链") || err.contains("已经结束"),
            "错误信息应说明原因，实际：{err}"
        );
        // 反方向也要拦
        let err2 = link_after(&conn, &child.id, &parent_id, Some("链")).expect_err("反向也应拒绝");
        assert!(
            err2.contains("漂流链") || err2.contains("已经结束"),
            "实际：{err2}"
        );
        // 死掉的父残影不能再发起链接（用户实测：「父块都漂出去死掉了，还能发起链接」）
        let third = create_block(&conn, &task.id, 300_000, 301_800).expect("建块失败");
        let err4 = link_after(&conn, &parent_id, &third.id, Some("链")).expect_err("残影不该能接");
        assert!(err4.contains("已经结束"), "实际：{err4}");
        let err5 = link_after(&conn, &third.id, &parent_id, Some("链")).expect_err("残影不该被接");
        assert!(err5.contains("已经结束"), "实际：{err5}");

        // 用户实测的绕法：残影 →(中转块)→ 子块，中间夹一个不相干的块也要拦
        let mid = create_block(&conn, &task.id, 200_000, 201_800).expect("建中间块失败");
        create_sequence(&conn, "链2", &[parent_id.clone(), mid.id.clone()]).expect("建序列失败");
        let err3 = link_after(&conn, &mid.id, &child.id, None).expect_err("经过中转也要拒绝");
        assert!(err3.contains("漂流链"), "实际：{err3}");
    }

    /// 修数据：历史上已经接错的（漂流链内部成员）会被摘掉，且幂等
    #[test]
    fn test_repair_drift_chain_sequences_removes_bad_members() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 10_000, 11_800).expect("建块失败");
        mark_block_missed(&conn, &a.id).expect("标记未完成失败");
        postpone_block(&conn, &a.id, 40_000).expect("漂流失败");
        let all = list_blocks(&conn, 0, 100_000).unwrap();
        let child = all.iter().find(|b| b.postponed_from.is_some()).expect("有后续块");
        let parent_id = child.postponed_from.clone().expect("有来源");
        // 绕过 link_after 直接造出非法成员关系
        let seq = create_sequence(&conn, "链", &[parent_id.clone(), child.id.clone()]).expect("建序列失败");
        assert_eq!(list_sequences(&conn, 0, 100_000).unwrap()[0].members.len(), 2, "先造出现场");
        assert_eq!(repair_drift_chain_sequences(&conn).expect("修失败"), 1, "摘掉 1 条");
        assert_eq!(list_sequences(&conn, 0, 100_000).unwrap()[0].members.len(), 1, "只剩一块");
        assert_eq!(repair_drift_chain_sequences(&conn).expect("再修失败"), 0, "幂等");
        let _ = seq;
    }

    /// C1.2 补漏：库里**已经存在**的重复块，加载时会被扫掉（不是只有"操作它"才会合）
    #[test]
    fn test_merge_all_pending_sweeps_existing_duplicates() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        // 绕过 create_block（它建第二块时就会合），直接用 SQL 造一对相邻的同任务块
        for (id, s, e) in [("dupe-a", 10_000, 11_800), ("dupe-b", 11_800, 13_600)] {
            conn.execute(
                "INSERT INTO blocks (id, task_id, start_at, end_at, status, created_at, layer)
                 VALUES (?1, ?2, ?3, ?4, 'planned', 1, 'elastic')",
                rusqlite::params![id, &task.id, s, e],
            )
            .expect("插入失败");
        }
        assert_eq!(list_blocks(&conn, 0, 100_000).unwrap().len(), 2, "先造出重复");
        assert_eq!(merge_all_pending(&conn).expect("扫描失败").0, 1, "应当合掉 1 处");
        let rows = list_blocks(&conn, 0, 100_000).unwrap();
        assert_eq!(rows.len(), 1, "合完只剩一块");
        assert_eq!((rows[0].start_at, rows[0].end_at), (10_000, 13_600), "区间取并集");
        assert_eq!(merge_all_pending(&conn).expect("再扫一次失败"), (0, 0), "幂等：再扫无事可做");
    }

    /// round64（C10）：融合开关关掉后 —— 新建/拖动路径与加载时扫描都不再自动合并；打开则恢复
    #[test]
    fn test_merge_switch_off_stops_auto_merge() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        set_setting(&conn, crate::features::MERGE, "0").expect("关融合失败");
        let _a = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 2_800, 6_400).expect("建块失败");
        assert_eq!(list_blocks(&conn, 0, 10_000).unwrap().len(), 2, "关掉后相接也不融");
        assert!(merge_adjacent(&conn, &b).expect("查询失败").is_none(), "显式调用也不合");
        assert_eq!(merge_all_pending(&conn).expect("扫描失败").0, 0, "加载扫描不融合");
        assert_eq!(list_blocks(&conn, 0, 10_000).unwrap().len(), 2, "还是两块");
        // 打开 → 下一次扫描就能合
        set_setting(&conn, crate::features::MERGE, "1").expect("开融合失败");
        assert!(merge_adjacent(&conn, &b).expect("查询失败").is_some(), "打开后应当合");
        assert_eq!(list_blocks(&conn, 0, 10_000).unwrap().len(), 1, "只剩一块");
    }

    /// C1.6 边界 5：成员**全在别的周**的序列 → 当前窗口根本不返回它（界面也就不会显示提示）
    #[test]
    fn test_list_sequences_skips_sequences_without_members_in_window() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let week = 1_000_000;
        let len = 604_800;
        let a = create_block(&conn, &task.id, week + len + 3_600, week + len + 7_200).expect("建块失败");
        let b =
            create_block(&conn, &task.id, week + len + 10_800, week + len + 14_400).expect("建块失败");
        create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");
        assert!(
            list_sequences(&conn, week, week + len).expect("查序列失败").is_empty(),
            "本周没有成员的序列不该返回"
        );
    }

    /// C3.1 补救（用户实测「死残影攥着线、活着的子子块完全自由」）：连漂两次，
    /// **活着的链尾也要在序列的同一环位上**，而且我的整理动作不许把它摘掉。
    #[test]
    fn test_drift_twice_keeps_live_tail_on_same_ring() {
        let conn = test_conn();
        let task = create_task(&conn, "写作", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, 10_000, 11_800).expect("建块失败");
        let b = create_block(&conn, &task.id, 100_000, 101_800).expect("建块失败");
        let seq = create_sequence(&conn, "链", &[a.id.clone(), b.id.clone()]).expect("建序列失败");

        mark_block_missed(&conn, &a.id).expect("标记失败");
        let first = postpone_block(&conn, &a.id, 40_000).expect("第一次漂流失败").block;
        mark_block_missed(&conn, &first.id).expect("标记失败");
        let second = postpone_block(&conn, &first.id, 70_000).expect("第二次漂流失败").block;

        let round1 = list_sequences(&conn, 0, 100_000).unwrap();
        let ms: Vec<(String, i64)> = round1[0]
            .members
            .iter()
            .map(|m| (m.block_id.clone(), m.order_index))
            .collect();
        assert!(
            ms.iter().any(|(id, i)| id == &second.id && *i == 0),
            "连漂两次后，活链尾应当还在环 0（共享链位），实际：{ms:?}"
        );

        // 关键回归：整理动作**不许**把同环的活链尾摘掉（我 0.6.30 就是这么把它摘掉的 ✗）
        repair_drift_chain_sequences(&conn).expect("整理失败");
        adopt_live_tails_into_sequences(&conn).expect("补链尾失败");
        let round2 = list_sequences(&conn, 0, 100_000).unwrap();
        assert!(
            round2[0].members.iter().any(|m| m.block_id == second.id),
            "整理之后活链尾必须还在序列里"
        );
        assert_eq!(seq.id, round2[0].id);
    }
}
