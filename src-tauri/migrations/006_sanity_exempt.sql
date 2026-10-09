-- round45（0.8.1）：理智值的「不计入」开关（块级，默认计入）。
--
-- 为什么用列而不是等级/权重：用户 2026-10-03 验收拍板 —— 「拒绝手工标能耗等级（对），
-- 但得能让用户自己定哪一块不计入理智消耗，用一个默认开的开关代替等级」。
-- 所以是一比特：0 = 计入（默认），1 = 不计入。
--
-- 追加式迁移（v2 ③ 数据模型只追加）：老库 ADD COLUMN 带默认值，平滑升级、可重复执行（IF NOT EXISTS 语义
-- 由 schema_migrations 保证；这条 SQL 本身对已有列会报错，所以**只在没跑过时执行** —— 与其他迁移同一机制）。
ALTER TABLE blocks ADD COLUMN sanity_exempt INTEGER NOT NULL DEFAULT 0;
