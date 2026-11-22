/**
 * E1 修复批：布局的**写库小函数**（从 `layout.svelte.ts` 拆出来，避免和状态模块互相拖累）。
 * 只有「写一个键 + 失败只记日志」这一种口径 —— 界面已经生效，不值得为它弹 Toast。
 */
import { setSetting } from "../ipc/settings";
import { clampBacklogHeight } from "./layout.svelte";

/** 上/下档高度落库（拖分隔条松手 / 双击复位后调） */
export async function persistBacklogHeight(px: number): Promise<void> {
  try {
    await setSetting("backlog_height", String(clampBacklogHeight(px)));
  } catch (err) {
    console.error("[layout] 存 Backlog 高度失败（这次会话内仍生效）", err);
  }
}
