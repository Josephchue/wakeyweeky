import { invoke } from "@tauri-apps/api/core";


/**
 * round94（#15）：读 SQLite 的 `PRAGMA data_version`（**同一连接**上读，只有**别的连接**提交过才变）。
 *
 * 轮询专用：**失败不弹 Toast**（只抛给调用方记日志）。
 *
 * 为什么要单开一条：`call()` 的错误处理是「失败就弹一条」—— 对用户主动的操作是对的，
 * 但轮询是 2.5 秒一次的后台动作，一旦持续失败（库被换掉 / 互斥量中毒）就会**刷屏**且永不收敛。
 */
export function getDataVersionQuiet(): Promise<number> {
  return invoke<number>("data_version");
}
