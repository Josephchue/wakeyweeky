import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 订阅「块有变化」：任何窗口标记/删除后，其他窗口据此刷新 */
export function onBlockUpdated(handler: () => void): Promise<UnlistenFn> {
  return listen("block-updated", () => handler());
}

/** round68（19.1）：一枚刚点亮的暗章（后端 emit `achievement-unlocked` 的载荷） */
export interface AchievementUnlocked {
  id: string;
  name: string;
  unlocked_at: number;
}

/** 订阅「暗章点亮」：窗口开着时弹一条短提示（`achievement_toast` 关掉则不弹） */
export function onAchievementUnlocked(
  handler: (newly: AchievementUnlocked[]) => void,
): Promise<UnlistenFn> {
  return listen<AchievementUnlocked[]>("achievement-unlocked", (event) => handler(event.payload));
}
