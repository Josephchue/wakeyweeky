-- round48（0.10.0）：两条**任务级**属性 —— 「不计入理智值」从块挪到任务 + Backlog 的手动顺序。
--
-- ① `sanity_exempt`：用户 2026-10-03 验收拍板 —— 「记不记入理智消耗是由**任务**决定的，不是由时间块决定的」
--    （round45 当时是块级；用了一轮之后他自己改的口径）。已有数据**折进来**：
--    这条任务只要有任何一块标过 ⊘，整条任务就不计入 —— 与「⊘ 说的是这件事」同一个意思。
--    （`blocks.sanity_exempt` 列留着不动：迁移只追加、不删列；它从此没有读者。）
-- ② `sort_order`：Backlog 的手动顺序（同一轮提的需求）。回填成升级前 `ORDER BY created_at, rowid`
--    的**同一个顺序**（1..N）→ 升级后列表看起来一模一样，之后新任务排在最上（`MIN - 1`）。
ALTER TABLE tasks ADD COLUMN sanity_exempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE tasks
SET sanity_exempt = 1
WHERE id IN (SELECT DISTINCT task_id FROM blocks WHERE sanity_exempt = 1);

-- 回填：与旧的 `ORDER BY created_at, rowid` 逐行等价（行值比较写成两个条件，老 SQLite 也认）
UPDATE tasks AS t
SET sort_order = (
  SELECT COUNT(*) FROM tasks AS o
  WHERE o.created_at < t.created_at OR (o.created_at = t.created_at AND o.rowid <= t.rowid)
);
