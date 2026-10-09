/**
 * round77（3.1b）：**块内第二行「还剩 X」的文案口径**（`block_second_line = remaining` 那一档）。
 *
 * ⚠️ **这条规则的后端孪生实现在 `src-tauri/src/hint.rs` 的 `format_body()`**（托盘 tooltip / 窗口标题
 * 的「还剩 X 分」）。两边必须同口径，改一处要同时改另一处：
 *   ≤ 60 秒 → `即将结束`；< 1 小时 → `还剩 N 分`（**向上取整**）；< 24 小时 → `还剩 H 小时[ M 分]`；
 *   ≥ 24 小时 → `还剩 D 天[ H 小时]`。
 * 复用系统提示的文案键（`sys.hint.01`…`06`）—— 与托盘那行**同一批字符串**，不另造一套。
 */
import { t } from "../i18n/i18n.svelte";

export function formatRemaining(secs: number): string {
  if (secs <= 60) return t("sys.hint.01");
  const minutes = Math.ceil(secs / 60);
  if (minutes < 60) return t("sys.hint.02", { minutes });
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? t("sys.hint.03", { h }) : t("sys.hint.04", { h, m });
  }
  const d = Math.floor(minutes / (24 * 60));
  const h = Math.floor((minutes % (24 * 60)) / 60);
  return h === 0 ? t("sys.hint.05", { d }) : t("sys.hint.06", { d, h });
}
