-- round64（C10）：模板表（v2 ③3.4 原样）——「某一周的骨架」。
-- payload 存 JSON：{"blocks":[{"start_min":540,"duration_min":180,"layer":"required","label":null}]}
--   start_min = 相对周一 00:00 的分钟偏移；label 只保留**临时安排块自己的名字**（不含任务名）。
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
