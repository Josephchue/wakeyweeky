import { t } from "../i18n/i18n.svelte";
import { redo as ipcRedo, undo as ipcUndo, type HistoryOutcome } from "../ipc/history";
import { reloadWeek } from "./blocks.svelte";
import { drift } from "./drift.svelte";
import { revealBlocks } from "./selection.svelte";
import { cancelLink, reloadSequences } from "./sequences.svelte";
import { loadTasks } from "./tasks.svelte";
import { loadList as loadTemplateList } from "./templates.svelte";
import { toast } from "./ui.svelte";
import { goToWeekOf, week } from "./week.svelte";
import { weekOf } from "../utils/week";

/**
 * C1.5：撤销 / 重做（用户点名要 Ctrl+Z）。
 *
 * 数据恢复是**后端整表回滚**（`commands/history.rs` 里的快照栈）；这里只负责
 * **前端跟着收拾干净**：整批数据被换过 → 时间轴与序列重拉，待链状态与漂流卡作废
 * （它们引用的块可能已经不存在了 —— 不清理会让界面停在一个不存在的块上）。
 *
 * round27（用户 round26 验收 #1/#2）：**任务表也要重拉**。快照覆盖 7 张表（含 `tasks`），
 * 所以「删任务后 Ctrl+Z」其实把任务滚回来了，但 Backlog 停在旧状态：
 * 表现一 = 任务看着没回来、块名查不到任务只能显示「?」；
 * 表现二 = 撤销「新建任务」后左栏还留着它，一点（拖出来/改名）就报「任务不存在」。
 */
async function sync(outcome: HistoryOutcome, verb: string) {
  cancelLink();
  drift.value = null;
  // round64.1（验收 #3）：被改的块可能在**别的周** —— 先按目标位置翻周，再重拉，
  // 最后把视角滚到那儿并闪一下（窄窗口的横向滚动由 Timeline 的 follow 处理）。
  const focus = outcome.focus ?? null;
  if (focus && weekOf(focus.start_at).from !== week.from) goToWeekOf(focus.start_at);
  // round69.1（#2）：撤销 / 重做的重拉**不跑开周维护** —— 否则撤销结果会被「自动合块 / 自动补重复」
  // 当场改回去，Ctrl+Z 永远卡在同一条（用户实测的「撤不出去」）。
  await reloadWeek({ maintenance: false });
  await reloadSequences();
  await loadTasks();
  await loadTemplateList(); // round64（C10）：模板名单也活在同一批快照里（删/存被 Ctrl+Z 换过）
  if (focus) revealBlocks(focus.start_at, focus.ids);
  toast(t("msg.history.01", { verb: verb, label: outcome.label }));
}

export async function undo() {
  try {
    const outcome = await ipcUndo();
    await sync(outcome, t("msg.history.02"));
  } catch {
    // ipc 层已弹 Toast（例如「没有可撤销的操作」）
  }
}

export async function redo() {
  try {
    const outcome = await ipcRedo();
    await sync(outcome, t("msg.history.03"));
  } catch {
    // ipc 层已弹 Toast（例如「没有可重做的操作」）
  }
}
