import { call } from "./call";

/**
 * round64（C11）：`.ics` 导出（v2 ④ 新增命令 `export_ics`）。
 *
 * 这里只是壳：渲染 / 读库全在 Rust `src-tauri/src/ics.rs`（唯一实现）——
 * UTC 时间、转义、折行、状态映射的口径与证据见它文件头与 `docs/plans/round64-c10-c11.md` §1.4。
 */
export interface IcsExportInfo {
  /** 实际写出的文件路径 */
  path: string;
  /** 字节数 */
  bytes: number;
  /** 导出了多少条排程 */
  events: number;
}

/** 导出全部排程（系统的「另存为」给回来的路径） */
export function exportIcs(path: string): Promise<IcsExportInfo> {
  return call<IcsExportInfo>("export_ics", { path });
}
