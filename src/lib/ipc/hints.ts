import { call } from "./call";

/**
 * round64（C10）：渐进式提示（v2 ④ 新增命令 `take_hint`）。
 *
 * 后端是唯一真相源：`true` 表示「该出现」**且已经记下已看过**（每条一生一次）；
 * 总开关关着时恒 `false` 且不记（重新打开还能看到）。逻辑与白名单在 Rust `src-tauri/src/hints.rs`。
 */
export function takeHint(id: string): Promise<boolean> {
  return call<boolean>("take_hint", { id });
}
