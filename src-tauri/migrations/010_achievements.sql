-- round68（19.1）：成就（暗章）状态 —— 只存已解锁与进度，定义全在 Rust（`achievements.rs`）。
--   unlocked_at IS NULL = 还没点亮；progress 供列表显示 x/target，以及信号计数（如撤销 5/100 次）。
--   **不进撤销快照**（`SNAPSHOT_TABLES` 里没有它）：成就一旦点亮就不可被 Ctrl+Z 退回（断了不惩罚）；
--   整库备份（VACUUM INTO）天然覆盖它。
CREATE TABLE IF NOT EXISTS achievements (
  id TEXT PRIMARY KEY,
  unlocked_at INTEGER,
  progress INTEGER NOT NULL DEFAULT 0
);
