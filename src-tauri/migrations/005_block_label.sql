-- 005：块自己的名字（C1.8 临时安排块 / R33）
--
-- 「临时安排块」不登记在 Backlog：它挂在一个**全局隐藏任务**上（`archived_at` 非空 → `list_tasks` 天然不列），
-- 而一个隐藏任务上会有很多互不相干的临时块 → 每块得能写自己的名字。
--
-- `label` 为空 = 用默认名「临时安排」（前端 `label ?? "临时安排"`）。
-- 普通块（挂在真实任务上）的 label 一律为 NULL —— 显示任务名，与以前完全一样。
ALTER TABLE blocks ADD COLUMN label TEXT;
