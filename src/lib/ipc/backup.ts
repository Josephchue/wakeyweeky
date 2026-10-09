import { call } from "./call";

/**
 * round62（C14）：数据备份的两条命令（v2 ④ 的 `export_backup` / `import_backup`）。
 *
 * 文件名与流程的出处：`docs/plans/round62-backup-and-current-hint.md` §二·补。
 * 这里只是壳：文件操作与校验全在 Rust `src-tauri/src/backup.rs`（唯一实现）。
 */

export interface ExportInfo {
  /** 实际写出的备份文件路径 */
  path: string;
  /** 字节数（Toast 里显示） */
  bytes: number;
}

/** 导出整库备份到指定路径（系统「另存为」给回来的路径） */
export function exportBackup(path: string): Promise<ExportInfo> {
  return call<ExportInfo>("export_backup", { path });
}

/**
 * 从备份恢复：成功后应用会**自动重启**，这个 Promise 可能永远不会 resolve（进程没了）。
 * 失败（源库非法 / 复制不了）时照常抛错，由 `call.ts` 弹 Toast。
 *
 * 为什么是「重启后换库」而不是就地替换：数据库连接被后端持有，热替换要跟锁赛跑；
 * 重启后由 `backup::apply_pending_restore` 在 `db::init` 之前换文件，干净且可测。
 */
export function importBackup(path: string): Promise<void> {
  return call<void>("import_backup", { path });
}
