import { call } from "./call";

/**
 * round66（C12）：便携模式的三条命令（`get_data_info` / `apply_data_choice` / `hotkey_status`）。
 *
 * 后端实现：`src-tauri/src/commands/portable.rs` + `commands/hotkeys.rs`；
 * 设计与边界表：`docs/plans/round66-c12-portable-and-hotkeys.md`。
 */

/** 一份库里能看到的东西（哪份新、哪份大、有没有内容、能不能用） */
export interface DbStats {
  exists: boolean;
  /** 最后修改（Unix 秒；拿不到为 null） */
  modified: number | null;
  bytes: number | null;
  tasks: number | null;
  blocks: number | null;
  /** 能不能拿来当数据用（完整性 + 表齐 + 迁移版本不超前） */
  usable: boolean;
  /** 不能用的原因（给面板显示） */
  reason: string | null;
}

export interface SideInfo extends DbStats {
  /** 「默认位置」/「便携（exe\data\）」 */
  label: string;
  dir: string;
  db: string;
  /** 当前正在用的那一侧 */
  current: boolean;
}

export interface DataInfo {
  portable: boolean;
  /** flag 在、但便携目录不可写 → 回落默认位置 */
  fallback: boolean;
  note: string | null;
  flag: string;
  /** 本次启动是否把默认位置的数据自动带了过来（启动提示一次） */
  adopted: boolean;
  current: SideInfo;
  other: SideInfo;
}

/** 全局快捷键的注册状态（两个键位都被占用时 `error` 有值） */
export interface HotkeyStatus {
  active: string | null;
  error: string | null;
}

export function getDataInfo(): Promise<DataInfo> {
  return call<DataInfo>("get_data_info");
}

/** 选择用哪一份（`"current"` = 正在用的这份 / `"other"` = 另一边）；成功后应用会**自动重启** */
export function applyDataChoice(pick: "current" | "other"): Promise<void> {
  return call<void>("apply_data_choice", { pick });
}

export function hotkeyStatus(): Promise<HotkeyStatus> {
  return call<HotkeyStatus>("hotkey_status");
}
