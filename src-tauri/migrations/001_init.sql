-- WakeyWeeky MVP 初始迁移（对应 v5 文档「数据模型」章节）
-- 约定：所有语句带 IF NOT EXISTS；schema_migrations 表不在此文件创建，由 db.rs 启动时单独创建；
--       所有时间戳为 Unix 秒级（UTC）整数。

-- 任务（Backlog 中的待办）
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT,
  created_at INTEGER NOT NULL
);

-- 任务块（时间轴上的实例）
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'done', 'missed')),
  last_notified_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blocks_start_at ON blocks(start_at);
CREATE INDEX IF NOT EXISTS idx_blocks_end_at ON blocks(end_at);
