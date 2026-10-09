-- round57（0.13.0 / C8）：`reviews` 从「马赛克/曲线快照缓存」收敛成「**一周一条结语**」。
--
-- 为什么：
-- ① 卡片改成**实时算**（与总览同一份数据，永远对得上）→ 不落快照（round52 §2.3 已论证「加一份快照
--    = 第二份真相，比没有更糟」，本批把这个论证贯彻到底）；
-- ② `mosaic_snapshot` / `sanity_curve` 两列从建表（002）起**从来没有任何写入方** ——
--    任何真机库里 `reviews` 都是空表，留着就是死列；
-- ③ 唯一需要落库的是**你写的那一句结语**：它不是数据的函数，算不出来。
--
-- 破例说明：本仓迁移一向「只追加、不删列」（007 的 `blocks.sanity_exempt` 就是明着留的死列）。
-- 这一条**删列**的理由是：两列从未被写过（表恒为空 → 风险 0），删掉之后表才和它唯一的用途对齐。
ALTER TABLE reviews ADD COLUMN note TEXT;
ALTER TABLE reviews ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews DROP COLUMN mosaic_snapshot;
ALTER TABLE reviews DROP COLUMN sanity_curve;
