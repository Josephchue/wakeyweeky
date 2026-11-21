/**
 * round94（#15）：**数据可见性** —— 外部改库的检测 + 手动/自动重载。
 *
 * 背景（`docs/plans/round93-…` §2）：学业OS / 脚本会**直接开 SQLite 写**。App 的写路径都是
 * 「写完整个重拉」，但**别的连接**提交时 App 不知道 —— 界面停在旧数据，直到你翻周/重启。
 *
 * 两条腿（你 2026-11-21 拍板）：
 * - **自动**：每 2.5 秒读一次 `PRAGMA data_version`（Rust `commands::data`）。它只在**外部提交**后变，
 *   App 自己写库不涨 → 不会自激。变了就整周重拉 + 一条提示。
 * - **手动**：头部 `↻` / 局内键 `R` → `reloadAll()`（不等轮询）。
 *
 * 边界（都是踩过的坑换来的）：
 * - 正在改名 / 拖动 / 键盘拿起时**顺延一轮**（重拉会把行换掉，正在编辑的东西就飞了）；
 * - 窗口藏着（最小化 / 托盘）不轮询 —— 回到前台第一次 tick 会把落下的那次补上；
 * - 自动重拉**不跑开周维护**（`maintenance:false`）：外部改动不是「打开这一周」，不替别人写库；
 * - 失败只打日志（`ipc/call` 已经统一弹过 Toast，别叠）。
 */
import { getDataVersionQuiet } from "../ipc/data";
import { t } from "../i18n/i18n.svelte";
import { drag } from "./drag.svelte";
import { reloadWeek } from "./blocks.svelte";
import { reloadSequences } from "./sequences.svelte";
import { selection } from "./selection.svelte";
import { loadTasks } from "./tasks.svelte";
import { editing, toast } from "./ui.svelte";

/** 轮询间隔（毫秒）。2.5s：判据要求「外部写后 ≤3 秒出现」。 */
export const POLL_MS = 2500;

let timer: ReturnType<typeof setInterval> | null = null;
/** 上一次读到的值；`null` = 还没建立基线（第一次 tick 只记不比较） */
let last: number | null = null;
/** 上一轮还在跑（重拉慢时别叠上一层） */
let inFlight = false;

/** 正在编辑 / 拖 / 拿起 → 这一轮先不动（下一轮再看） */
function busy(): boolean {
  return (
    editing.blockId !== null ||
    drag.blockId !== null ||
    drag.taskId !== null ||
    selection.grabbed
  );
}

/**
 * 重拉「你正在看的东西」：任务表 + 这一周的块（连带理智值）+ 序列。
 *
 * 为什么是这三样：外部写库能新建任务、块、序列；Backlog（任务）与时间轴（块）与序列线
 * 三处是同一屏能看到的三层。其它面板（统计/总览）自带「打开时重拉」，不在这里硬刷。
 */
export async function reloadAll(opts: { external?: boolean } = {}): Promise<void> {
  try {
    await loadTasks();
  } catch (err) {
    console.error("[datasync] 重拉任务失败（界面照常）", err);
  }
  try {
    // maintenance:false —— 只读，不替外部调用者补重复块 / 合并（撤销那条也是这么调的）
    await reloadWeek({ maintenance: false });
  } catch (err) {
    console.error("[datasync] 重拉这一周的块失败（界面照常）", err);
  }
  try {
    await reloadSequences();
  } catch (err) {
    console.error("[datasync] 重拉序列失败（界面照常）", err);
  }
  if (opts.external) toast(t("ui.app.10"));
}

/** 一次轮询（导出给单测；产品里由 `startDataWatch` 的定时器调） */
export async function pollDataVersion(): Promise<void> {
  if (inFlight) return;
  if (typeof document !== "undefined" && document.hidden) return;
  inFlight = true;
  try {
    // 用 quiet 版：轮询失败只记日志，不每 2.5 秒弹一条错误（6b P2）
    const now = await getDataVersionQuiet();
    if (last === null) {
      last = now;
      return;
    }
    if (now === last) return;
    if (busy()) return; // 顺延：不动基线，下一轮还会看到「变了」
    // 只认**这一轮读到的**值：重拉期间若又有人写，下一轮还能看见（别用重拉之后的新值覆盖基线）
    last = now;
    await reloadAll({ external: true });
  } catch (err) {
    console.error("[datasync] 读 data_version 失败（忽略这次）", err);
  } finally {
    inFlight = false;
  }
}

/** 启动轮询（`App.svelte` 的 `onMount`；重复调用是空操作） */
export function startDataWatch(): void {
  if (typeof window === "undefined" || timer !== null) return;
  last = null;
  // **立刻建基线**（不等第一次 tick）：否则「启动后 ~2.5s 内别人写的」会被当成基线吞掉 ——
  // 那一刻的首屏加载是**写之前**的快照，之后既没提示也不会重拉（真机 e2e 抓到：插入点在
  // 「页面就绪 +1.2s」时，旧写法永远看不到那一块）。
  void getDataVersionQuiet()
    .then((v) => {
      if (last === null) last = v;
    })
    .catch((err) => console.error("[datasync] 建基线失败（第一次 tick 会重试）", err));
  timer = setInterval(() => void pollDataVersion(), POLL_MS);
}

/** 停轮询（组件卸载 / 测试收尾） */
export function stopDataWatch(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  last = null;
}
