import { call } from "./call";
import type { AchievementList } from "./types";

/** round68（19.1）：暗章面板数据（打开时重拉；未点亮也返回：`???` + 条件 + 进度） */
export function listAchievements(): Promise<AchievementList> {
  return call<AchievementList>("list_achievements");
}

/**
 * 打一个成就信号（前端动作：打开统计 / 总览 / 说明页 / 翻周 / 找回周末 / 全选 / Enter 拿起 / 超载）。
 * 白名单在后端 `achievements::SIGNALS`；未知信号会报中文错误。
 */
export function noteAchievement(signal: string): Promise<void> {
  return call<void>("note_achievement", { signal });
}

/**
 * round79（78-11）：**重置成就** —— 后端清空点亮记录 + 把计分起点挪到此刻（从此刻起重新挣）；
 * 任务 / 块 / 统计一条不删。
 */
export function resetAchievements(): Promise<void> {
  return call<void>("reset_achievements");
}
