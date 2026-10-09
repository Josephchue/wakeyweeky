/**
 * round68（19.1）成就（暗章）：面板状态 + 信号发送。
 *
 * - 数据在 Rust `achievements.rs`（唯一实现）；这里只拉回来画、把前端动作转成信号。
 * - **默认开**（round85 / 0.31.0：单一版本 —— 以前的 Lite 档 / `available=false` 已取消）。
 * - `newIds` = 本次会话里刚点亮的（面板给它们挂 `NEW`；重启就没了，照 MAA）。
 */
import { listAchievements, noteAchievement, resetAchievements as resetAchievementsIpc } from "../ipc/achievements";
import type { AchievementList } from "../ipc/types";
import { prepareOpen, registerPanel } from "./panels.svelte";

export const achievements = $state<{
  /** 面板开着吗 */
  open: boolean;
  data: AchievementList | null;
  loading: boolean;
  failed: boolean;
  /** 本次会话刚点亮的 id（挂 NEW） */
  newIds: string[];
}>({
  open: false,
  data: null,
  loading: false,
  failed: false,
  newIds: [],
});

let loadSeq = 0;

/** 拉一次列表（启动时 + 每次打开面板；防竞态照 stats store 的序号守旧） */
export async function loadAchievements(): Promise<void> {
  const seq = ++loadSeq;
  achievements.loading = true;
  achievements.failed = false;
  try {
    const data = await listAchievements();
    if (seq !== loadSeq) return;
    achievements.data = data;
  } catch (err) {
    // `call()` 已经统一弹过 Toast；这里只把面板切到失败态
    console.error("[achievements] 读暗章失败", err);
    if (seq === loadSeq) {
      achievements.data = null;
      achievements.failed = true;
    }
  } finally {
    if (seq === loadSeq) achievements.loading = false;
  }
}

/** 启动时拉一次列表（顺手把数字备好）—— round85 起唯一版本恒可用，不再有「这份构建有没有」这一层 */
export async function initAchievements(): Promise<void> {
  await loadAchievements();
}

/** 打开面板：先报 `panel` 信号（「对暗号的人」），再拉最新列表
 *  round78（栈-01）：它是**子层**（从设置里打开）—— 开着它的时候设置面板留在下面，关掉回到设置 */
export async function openAchievements(): Promise<void> {
  prepareOpen("achievements");
  achievements.open = true;
  await note("panel");
  await loadAchievements();
}

export function closeAchievements(): void {
  achievements.open = false;
}

// round78（栈-01）：注册给面板栈（子层）
registerPanel({ id: "achievements", kind: "child", isOpen: () => achievements.open, close: () => (closeAchievements(), true) });

/** 打一个信号（失败只记日志：ipc 层已弹 Toast，但成就不该拦住主流程） */
export async function note(signal: string): Promise<void> {
  try {
    await noteAchievement(signal);
  } catch (err) {
    console.error(`[achievements] 信号 ${signal} 失败（忽略）`, err);
  }
}

/** App 收到点亮事件时登记（面板挂 NEW） */
export function markNew(ids: string[]): void {
  for (const id of ids) {
    if (!achievements.newIds.includes(id)) achievements.newIds.push(id);
  }
}

/**
 * round79（78-11）：**重置成就** —— 先调后端（清空 + 挪计分起点），再重拉一次列表。
 * `newIds` 也清掉：重置之后不该还挂着“刚点亮”的标记。失败返回 false（ipc 层已弹 Toast）。
 */
export async function resetAchievements(): Promise<boolean> {
  try {
    await resetAchievementsIpc();
    achievements.newIds = [];
    await loadAchievements();
    return true;
  } catch (err) {
    console.error("[achievements] 重置失败", err);
    return false;
  }
}
