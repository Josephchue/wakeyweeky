-- round69（B3）：每周重复 —— 任务级规则 + 「某规则某周已处理」的水位线。
--
-- 口径（plan `docs/plans/round69-b3-features.md` §二 B2；唯一实现 `src-tauri/src/repeats.rs`）：
-- - **规则属于任务**（一个任务可多条：周三 / 周五各一条），入口在 Backlog 的 ⚙ 属性面板；
-- - **不存时长**：时长 = 那条任务的「预估」（与「拖任务出来建块」同一条口径；没填 = 30 分钟）——
--   用户 2026-10-05 评审反馈：单独再填一个时长跟「预估」重了；
-- - `weekday` 0 = 周一 … 6 = 周日；`start_min` = 相对当天 00:00 的分钟（跨天用时长表达）；
-- - **occurrences 水位线**：一周围只处理一次（生成过或跳过过都记），
--   用户删掉生成的块 = 这周不再生成（`block_id` 被 ON DELETE SET NULL 置空，行留着）。
-- 两张表都进撤销快照（`db.rs::SNAPSHOT_TABLES`）—— 建规则 / 生成要能 Ctrl+Z。

CREATE TABLE IF NOT EXISTS repeats (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  weekday    INTEGER NOT NULL,
  start_min  INTEGER NOT NULL,
  layer      TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS repeat_occurrences (
  repeat_id  TEXT NOT NULL,
  week_start INTEGER NOT NULL,
  block_id   TEXT,
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repeat_id, week_start),
  FOREIGN KEY (repeat_id) REFERENCES repeats(id) ON DELETE CASCADE,
  FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_repeats_task       ON repeats(task_id);
CREATE INDEX IF NOT EXISTS idx_repeat_occ_block   ON repeat_occurrences(block_id);
