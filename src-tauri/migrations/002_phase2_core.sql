-- WakeyWeeky 二期核心迁移（对应 WakeyWeeky_v2.md ③）
-- 原则：全部追加式 —— 只加列、只加表，不改名、不删除、不动 001 的 CHECK 约束。
-- 关于 blocks.status：SQLite 无法直接修改 CHECK，故新增 final_status 列表达
--   「已完成，但是超时完成(done_overtime) / 提前结束(done_short)」；
--   展示时的终态取 COALESCE(final_status, status)。

-- ---------- 追加列（ADD COLUMN 不需要重建表，老库能平滑升级）----------
ALTER TABLE tasks  ADD COLUMN is_elastic        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks  ADD COLUMN estimated_minutes INTEGER;
ALTER TABLE tasks  ADD COLUMN archived_at       INTEGER;

ALTER TABLE blocks ADD COLUMN layer             TEXT NOT NULL DEFAULT 'suggested';
ALTER TABLE blocks ADD COLUMN external_source   TEXT;
ALTER TABLE blocks ADD COLUMN final_status      TEXT;

-- ---------- 行为事件（理智值反推的唯一数据源；只由 Rust 命令层写入）----------
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  block_id TEXT,
  event_type TEXT NOT NULL,        -- complete | skip | postpone | overtime | short
  payload TEXT,                    -- JSON，例如 {"from": 1730000000, "to": 1730003600}
  created_at INTEGER NOT NULL
);

-- ---------- 任务序列（用户显式链接的块）----------
CREATE TABLE IF NOT EXISTS sequences (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_members (
  sequence_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  PRIMARY KEY (sequence_id, block_id),
  FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE,
  FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
);

-- ---------- 外部日历占用块（.ics 单向导入，只读）----------
CREATE TABLE IF NOT EXISTS external_blocks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  source TEXT NOT NULL,            -- ics
  external_uid TEXT,               -- 同一文件重复导入时按 UID 去重
  imported_at INTEGER NOT NULL
);

-- ---------- 复盘记录（一周一条；缓存马赛克与精力曲线快照）----------
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  week_start INTEGER NOT NULL UNIQUE,
  mosaic_snapshot TEXT,
  sanity_curve TEXT,
  created_at INTEGER NOT NULL
);

-- ---------- 设置（主题 / 音效开关 / 浮窗时长等偏好）----------
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------- 索引 ----------
CREATE INDEX IF NOT EXISTS idx_events_block_id     ON events(block_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at   ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_external_start_at   ON external_blocks(start_at);
CREATE INDEX IF NOT EXISTS idx_seq_members_block   ON sequence_members(block_id);
