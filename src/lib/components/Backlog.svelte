<script lang="ts">
  import Icon from "../icons/Icon.svelte";
  import { t } from "../i18n/i18n.svelte";
import { tick } from "svelte";
import type { BlockLayer, Task } from "../ipc/types";
import { archiveTask, renameCategory, renameTask, removeTask, reorderTasks, setTaskExempt, tasks, unarchiveTask, updateTask } from "../stores/tasks.svelte";
import { beginPointerDrag } from "../stores/drag.svelte";
import { matches as keymapMatches } from "../stores/keymap.svelte";
import { sanity } from "../stores/sanity.svelte";
import { closeTaskPanel, newTaskRequest, requestNewTask, toast, toastUndo, taskPanel } from "../stores/ui.svelte";
import {
  prefs,
  featureOn,
  saveBacklogCollapsed,
  saveBacklogFilter,
  saveBacklogGrouped,
} from "../stores/settings.svelte";
import {
  addRepeat,
  loadRepeats,
  removeRepeat,
  rulesOf,
  toggleRepeat,
} from "../stores/repeats.svelte";
import { filterFromUi, filterToUi } from "../utils/backlog-view";
import { estimateMinutes } from "../utils/duration";
import { layout, saveBacklogPane, toggleBacklogPane } from "../stores/layout.svelte";
import { moveWithinGroup } from "../utils/list-order";
import {
  TEMP_TASK_ID,
  categoryLabel,
  categoryOptions,
  filterByCategory,
  groupByCategory,
  usedCategories,
  type CategoryFilter,
} from "../utils/category";
import CategoryMenu from "./CategoryMenu.svelte";
import CategoryPicker from "./CategoryPicker.svelte";
import NewTaskInput from "./NewTaskInput.svelte";

  /** 正在改名的任务 id（null = 没有）。
   *  规则（边界表 R）：回车保存、Esc 取消、点别处（失焦）也保存；
   *  空名 / 超 200 字由后端拒绝、ipc 层弹 Toast，原名一律不动。 */
  let editingId = $state<string | null>(null);
  let draft = $state("");
  let inputEl = $state<HTMLInputElement | null>(null);

  /** round67：收起任务栏 —— **成功之后**再把属性面板 / 已归档收掉（写失败时界面不动，B1#8 口径）。
   *  round67.1：细轨不再有悬停临时展开（覆层会盖住时间轴 —— 你 2026-10-05 实测否掉）。 */
  async function collapseBacklog() {
    if (await toggleBacklogPane()) closeTaskPanel();
  }

  /** 任务属性面板（v2 ④ 的 `update_task(id, patch)`）：弹性任务 / 预估时长 / 分类。
   *  round38：状态抬到 `stores/ui.svelte.ts` 的 `taskPanel` —— 因为 `Esc`（全局键）要能收起它。 */

  /**
   * round69（B3）：局内键 `C`（快速加任务）—— 收到信号就把 Backlog 露出来并聚焦「添加任务…」。
   * 细轨（rail）时先展开（写设置失败也照样展开界面；BQ 口径：不假装成功，但也不把路堵死）。
   */
  let lastNewTaskSeq = 0;
  $effect(() => {
    const seq = newTaskRequest.seq;
    if (seq === lastNewTaskSeq) return;
    lastNewTaskSeq = seq;
    void focusNewTaskInput();
  });

  async function focusNewTaskInput(): Promise<void> {
    if (layout.backlogPane !== "open") {
      if (!(await saveBacklogPane("open"))) layout.backlogPane = "open" as typeof layout.backlogPane;
    }
    await tick(); // 细轨 → 展开要先渲染出输入框
    const input = document.querySelector<HTMLInputElement>(".new-task .field");
    input?.focus();
    input?.scrollIntoView({ block: "nearest" });
  }

  /** round38：那块**全局隐藏任务**（临时安排块挂在它上面）自己也带着 `archived_at`。
   *  「已归档」列表必须排掉它 —— 否则会多一行没意义的名字，而且它一旦被「恢复」就会跑进 Backlog ✗。
   *  为什么用常量而不是后端派生字段：这里只是过滤一行（`Block.is_temp` 那种派生是给渲染判断用的），
   *  前端本来就已有几处硬编码同一个 id（假数据 + 测试）；常量放在用到它的地方旁边就够。 */
  /** round38：那块**全局隐藏任务**（临时安排块挂在它上面）自己也带着 `archived_at`。
   *  「已归档」列表必须排掉它 —— 否则会多一行没意义的名字，而且它一旦被「恢复」就会跑进 Backlog ✗。
   *  round47：常量搬进 `utils/category.ts`（分类的计数/筛选/分堆都共用它，只能有一份定义）。 */

  /** 8.1（round47）：这个页面的分类口径全在 `utils/category.ts` 里（筛选 / 分堆 / 计数 / 选项顺序）——
   *  C7 的「按类别」视图将来读的就是同一份，别在组件里各排一套。 */

  /** 「已归档」列表：按归档时间**倒序**（最近归档的在最上面） */
  const archivedTasks = $derived(
    tasks
      .filter((t) => t.archived_at != null && t.id !== TEMP_TASK_ID)
      .sort((a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0)),
  );

  /** 分类下拉 / 管理页要认的分类：**你真用过的**（含已归档任务、排除隐藏任务）。
   *  用得多的排前面、同数按名字 —— 不预置任何分类：分类是你自己起的名字。 */
  const allCategories = $derived(usedCategories(tasks));

  /** Backlog 主列表（未归档）—— 筛选/分组都在它上面做。
   *  round28 #2：store 里是**全部**任务（含已归档与那块隐藏的临时任务）—— 因为时间轴上的块
   *  要按 `task_id` 查名字；以前 store 里只有未归档的 → 归档任务的块显示「?」。 */
  const visibleTasks = $derived(tasks.filter((t) => t.archived_at == null));

  /** R48（round63）：**筛选与分组存设置**（重启后还记得）—— `filter` 是从 `prefs` 派生的 UI 值，
   *  点击走 `setFilter` / `setGrouped`（写失败则界面不变 = 等于没生效）。
   *  已归档那一栏**仍是会话内**（R48 原文只说主列表）。 */
  const filter = $derived(filterToUi(prefs.backlogFilter));
  const setFilter = (v: CategoryFilter) => void saveBacklogFilter(filterFromUi(v));
  let archFilter = $state<CategoryFilter>(null);
  const grouped = $derived(prefs.backlogGrouped);
  const setGrouped = (on: boolean) => void saveBacklogGrouped(on);

  /** 幂等守卫（规矩 6 的同类）：筛选值若已**不在这个列表能选的分类**里（比如撤销了那次改名、
   *  或最后一条该类任务被改去了别处）→ 自动回「全部」。不然列表会空白、而且没有任何解释。
   *  用**派生**而不是 `$effect` 去写状态：不改状态、不留旧值，界面永远自洽。 */
  const mainOptions = $derived(new Set(categoryOptions(visibleTasks).map((o) => o.value)));
  const archOptions = $derived(new Set(categoryOptions(archivedTasks).map((o) => o.value)));
  const effFilter = $derived(filter !== null && !mainOptions.has(filter) ? null : filter);
  const effArchFilter = $derived(archFilter !== null && !archOptions.has(archFilter) ? null : archFilter);

  const shownTasks = $derived(filterByCategory(visibleTasks, effFilter));
  /** 分组视图：分堆结果；**不分组时合成「一坨、没有节头」** —— 模板里就只写一遍行渲染 */
  const renderGroups = $derived(
    grouped
      ? groupByCategory(shownTasks).map((g) => ({ ...g, key: String(g.name), head: true }))
      : [{ name: null, tasks: shownTasks, key: "(flat)", head: false }],
  );
  const archShown = $derived(filterByCategory(archivedTasks, effArchFilter));

  /** 恢复一个归档任务（round38）：非破坏性动作，**不要二次确认** */
  async function onUnarchive(task: Task) {
    try {
      await unarchiveTask(task.id);
      toast(t("ui.backlog.01", { title: task.title }));
    } catch {
      // ipc 层已弹 Toast
    }
  }

  /**
   * round40：分类的控件换成自建的**可创建下拉**（`CategoryPicker`）—— 点进来就能打字。
   * 之前两版都不成立：`datalist` 像自动填充的黑框、选完还弹一遍；`<select>` 不能打字、
   * 而且选项文字里做不出「灰色小字右对齐的数量」。调研与取舍见 `docs/plans/round40-category-and-confirm.md`。
   */

  /**
   * round39：**按到面板外面 → 面板自动收起**（你说「打开 ⚙ 面板的时候我拖不动块」）。
   * 两个原因一起解决：
   * ① 面板开着时，从 Backlog 拖**这条任务**出来会被下面那条守卫拦掉（`propsId === task.id` → return）= 真拖不动 ✗；
   * ② 面板占着地方、挡视线，而你正要干别的（拖块、选块、跳周）。
   * 用**捕获**阶段：抢在那条 `li` 的 pointerdown（起拖判定）之前把面板收掉，手势就能照常开始。
   * 面板自己（`.props`）与它的开合按钮（`.props-toggle` / `.arch-toggle` / `.arch-list`）例外。
   */
  $effect(() => {
    const onDown = (e: PointerEvent) => {
      if (!taskPanel.propsId && !taskPanel.archivedOpen) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".props")) return; // 在面板里点：要能改值、能按「归档 / 收起」
      if (t?.closest?.(".props-toggle")) return; // 点它自己的 ⚙：交给 onclick 开关（否则会先关再开）
      if (t?.closest?.(".arch-toggle") || t?.closest?.(".arch-list")) return; // 「已归档」同理
      // round47：分类菜单的开合按钮与两页弹层（筛选/管理）也在这些面板里 —— 别把面板顺手收掉
      if (t?.closest?.(".cat-btn") || t?.closest?.(".cat-pop")) return;
      closeTaskPanel();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  });

  /**
   * 8.1 分类管理：改名 / 合并 / 清空（**一次改掉整个分类**，含已归档任务）。
   * 「合并」= 改成已有名字；清空 = 传空串 → 那些任务回到「未分类」。
   * 事后给一条**可点撤销**的提示（不弹确认框 —— round40 定的口径：能撤销的动作不加确认），
   * 提示里说清「改了几个 / 并给了谁」（与删除任务回报块数同一个口径）。
   */
  async function onRenameCategory(from: string, to: string) {
    const target = to.trim();
    const srcCount = allCategories.find((c) => c.name === from)?.count ?? 0;
    const targetCount =
      target === "" ? 0 : (allCategories.find((c) => c.name === target)?.count ?? 0);
    try {
      const changed = await renameCategory(from, to);
      if (changed === 0) return; // 没什么可改（界面过期）→ 不吹牛
      if (target === "") toastUndo(t("ui.backlog.02", { from: from, changed: changed }));
      else if (targetCount > 0)
        toastUndo(t("ui.backlog.03", { from: from, target: target, targetCount: srcCount + targetCount }));
      else toastUndo(t("ui.backlog.04", { from: from, target: target, changed: changed }));
    } catch {
      // ipc 层已弹 Toast
    }
  }

  /** 分组开着、又没筛选时，新任务会落到**最下面那堆「未分类」**——说一句，免得以为它没进去 */
  function onTaskAdded() {
    if (grouped && effFilter === null) toast(t("ui.backlog.05"));
  }

  async function saveProps(
    task: Task,
    patch: { category?: string; estimatedMinutes?: number; isElastic?: boolean },
  ): Promise<boolean> {
    try {
      await updateTask(task.id, patch);
      return true;
    } catch {
      // ipc 层已弹 Toast
      return false;
    }
  }

  /* ---- round69（B3）：每周重复（在这儿建规则；打开某一周时后端自己排块） ---- */
  /** 周几（周一 = 0）→ 选择表里用的名字；round74：`$derived`（切语言后跟着变） */
  const WEEK_CN = $derived([t("ui.backlog.06"), t("ui.backlog.07"), t("ui.backlog.08"), t("ui.backlog.09"), t("ui.backlog.10"), t("ui.backlog.11"), t("ui.backlog.12")]);
  /** 表单草稿（同一时间只开一个属性面板，一份就够）：默认周三 19:00（与 plan 的例子一致） */
  let repeatWeekday = $state(2);
  let repeatTime = $state("19:00");
  let repeatLayer = $state<BlockLayer>("elastic");

  const repeatRules = $derived(taskPanel.propsId ? rulesOf(taskPanel.propsId) : []);
  /** 面板一打开就把这个任务的规则拉回来（写操作各自重拉） */
  $effect(() => {
    const id = taskPanel.propsId;
    if (id) void loadRepeats(id);
  });

  /** 表单里的时刻 → 相对当天 00:00 的分钟；空 / 非法 = null（添加按钮禁用） */
  const repeatStartMin = $derived.by(() => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(repeatTime.trim());
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return null;
    return hh * 60 + mm;
  });
  /** 生成时长的口径 = 「从 Backlog 拖出来建块」那一套 —— 唯一实现在 `utils/duration.ts` */
  const estMinutes = (task: Task) => estimateMinutes(task.estimated_minutes);
  const fmtMin = (min: number) =>
    `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

  async function addRepeatRule(task: Task) {
    if (repeatStartMin == null) return;
    const ok = await addRepeat(task.id, repeatWeekday, repeatStartMin, repeatLayer);
    if (ok) toast(t("ui.backlog.13", { repeatWeekday: WEEK_CN[repeatWeekday], repeatStartMin: fmtMin(repeatStartMin) }));
  }

  /** 归档（v2 ④ `archive_task`；⑧B8：归档与删除都要有）
   *  round40：**不再二次确认**（你 2026-10-02 拍板）—— 归档有「已归档 → 恢复」这条出口，
   *  数据也不丢，没什么好拦的；直接归档 + 一句能指到恢复入口的提示。 */
  async function onArchive(task: Task) {
    try {
      await archiveTask(task.id);
      taskPanel.propsId = null;
      toast(t("ui.backlog.14", { title: task.title }));
    } catch {
      // ipc 层已弹 Toast
    }
  }

  async function startEdit(task: Task) {
    editingId = task.id;
    draft = task.title;
    await tick(); // 输入框要先渲染出来才能聚焦
    inputEl?.focus();
    inputEl?.select(); // 全选：直接打字即整体替换，改个别字也只需按一下方向键
  }

  function cancelEdit() {
    editingId = null;
    draft = "";
  }

  async function commitEdit(task: Task) {
    // 回车提交后输入框被移除，又会触发一次 blur —— 用 editingId 认领，避免重复提交
    if (editingId !== task.id) return;
    const next = draft.trim();
    editingId = null;
    draft = "";
    if (next === task.title) return; // 名字没变：不写库、不广播（R8）
    try {
      await renameTask(task.id, next);
    } catch {
      // ipc 层已弹 Toast（空名 / 超长 / 任务已被删都在这里兜住）
    }
  }

  /** round25：从 Backlog 拖任务到时间轴 = 建块。原来走 HTML5 的 `dragstart` + MIME，
   *  现在与块拖动共用同一个 pointer 手势引擎（落点只看坐标）。
   *  改名/属性面板展开时不起拖（那时 `li` 里是输入框）。 */
  /** round27（用户实测「预估 75 分钟，拖出来还是 30 分钟」）：新块时长**优先用任务的预估**。
   *  round28（用户实测「预估 50 分钟，块排了 45」）：从**四舍五入**改成**向上取整** ——
   *  宁可多给 15 分钟，也别给少于预估的时间（拉伸步进仍是 15 分钟）。没填预估才用默认 30。
   *  round69（B3）：口径抽到 `utils/duration.ts`（与每周重复生成、Rust 侧同源）。 */
  function dragMinutes(task: Task): number {
    return estimateMinutes(task.estimated_minutes);
  }

  function onPointerDown(e: PointerEvent, task: Task) {
    if (editingId === task.id || taskPanel.propsId === task.id) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button") || target?.closest("input")) return;
    const item = e.currentTarget as HTMLElement;
    const rect = item.getBoundingClientRect();
    beginPointerDrag({
      taskId: task.id,
      durationSeconds: dragMinutes(task) * 60,
      width: rect.width,
      height: rect.height,
      event: e,
    });
  }

  /**
   * round48（用户 2026-10-03 拍板）：`⊘` 是**任务级**的 —— 「记不记入理智由任务决定，不由时间块决定」。
   * 一次切换管它的**所有块**；失败由 ipc 层弹 Toast，界面不假装改成功（round44 BJ 同一个口径）。
   */
  async function onToggleExempt(task: Task) {
    try {
      await setTaskExempt(task.id, !task.sanity_exempt);
    } catch {
      // ipc 层已弹 Toast
    }
  }

  /**
   * round48（用户 2026-10-03）：「分组开着的时候能不能加个收起？」
   * 点节头 = 收起/展开**那一堆**（节头与条数照旧显示，只是下面的行藏起来）。
   * R48（round63）：收起的名单也**存设置**（重启还在）；已归档栏没有分组、不涉及。
   */
  const collapsedGroups = $derived(new Set(prefs.backlogCollapsed));

  function toggleGroup(name: string | null) {
    const key = String(name);
    const next = new Set(collapsedGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    void saveBacklogCollapsed([...next]);
  }

  /** 这一堆现在收着吗（平铺视图没有节头 → 永远"没收"） */
  const groupCollapsed = (name: string | null) => collapsedGroups.has(String(name));

  /**
   * 手动排序：**平铺**时是整张表，**分组**时只在那一堆里挪（round49 —— 用户 2026-10-03：
   * 「分组开了没有组内手动调序」）。仍然要求**不筛选**：筛掉一半时「插到哪」会含糊。
   */
  const canReorder = $derived(effFilter === null);
  /** 拖动中的排序状态；`group` = 被拖那条所在的组（平铺视图用 "null" 这一组表示"整张表"） */
  let reorder = $state<{ id: string; group: string; to: number } | null>(null);

  /** 某一组在列表里的行（靠行上的 `data-group` 认；平铺视图只有一个组 = "null"） */
  function groupRows(group: string): HTMLElement[] {
    return [
      ...document.querySelectorAll<HTMLElement>(`.list .item[data-group="${CSS.escape(group)}"]`),
    ];
  }

  /** 某一组的 id 顺序（界面顺序；落库时用 `moveWithinGroup` 把它填回整表） */
  function groupIdsOf(group: string): string[] {
    const found = renderGroups.find((g) => String(g.name) === group);
    return (found?.tasks ?? []).map((t) => t.id);
  }

  /** 落点 = 「插到**这一组**的第几个之前」（0..组内长度）。拖动中不动 DOM，量中线就够 */
  function dropIndexAt(clientY: number, group: string): number {
    const rows = groupRows(group);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length;
  }

  /** 抓手按下 = 拖动排序（**不冲突**：拖到时间轴那条路走行体，而行体手势会跳过 button） */
  function startReorder(e: PointerEvent, id: string, from: number, group: string) {
    if (e.button !== 0) return;
    reorder = { id, group, to: from };
    const onMove = (ev: PointerEvent) => {
      if (reorder) reorder = { id: reorder.group, group: reorder.group, to: dropIndexAt(ev.clientY, group) };
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      void commitReorder(from, group);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  /**
   * 松手落库：`moveWithinGroup` 的 `to` 与那条插入线**同一个口径**；顺序没变就不写库。
   * 组内挪完之后，把这一组的槽位按新顺序**填回整表**（别的组、组与组的相对位置都不动）。
   */
  async function commitReorder(from: number, group: string) {
    const to = reorder?.to ?? from;
    reorder = null;
    const globalIds = visibleTasks.map((t) => t.id);
    const next = moveWithinGroup(globalIds, groupIdsOf(group), from, to);
    if (next.join("|") === globalIds.join("|")) return;
    try {
      await reorderTasks(next);
    } catch {
      // ipc 层已弹 Toast
    }
  }

  /** 键盘：抓手上的 ↑/↓ = **组内**上下挪一格（够不着拖动的场景也有一条路） */
  async function onGripKey(e: KeyboardEvent, index: number, group: string) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const groupIds = groupIdsOf(group);
    const to = e.key === "ArrowUp" ? index - 1 : index + 2; // 插到前一个之前 / 后一个之后
    const next = moveWithinGroup(visibleTasks.map((t) => t.id), groupIds, index, to);
    if (next.join("|") === visibleTasks.map((t) => t.id).join("|")) return;
    try {
      await reorderTasks(next);
    } catch {
      // ipc 层已弹 Toast
    }
  }

  /** 删任务（round40）：**不再二次确认** —— 直接删 + 右下角一条带「撤销」的提示（`toastUndo`）。
   *  提示条要**说清毁掉了什么**（调研结论）：连带删了几个块也报出来。 */
  async function onDelete(task: Task) {
    try {
      const blocks = await removeTask(task.id);
      toastUndo(
        blocks > 0
          ? t("ui.backlog.15", { title: task.title, blocks: blocks })
          : t("ui.backlog.16", { title: task.title }),
      );
    } catch {
      // ipc 层已弹 Toast
    }
  }
</script>

<!-- round67.1：细轨 = 整条可点的展开入口（**不再有悬停临时展开**：覆层会把时间轴盖住，
     而「从 Backlog 拖任务去时间轴」正是主用法 —— 你 2026-10-05 实测） -->
<section class="backlog" class:rail={layout.backlogPane === "rail"}>
  {#if layout.backlogPane === "rail"}
    <!-- 细轨：整条都是按钮（命中区约 40×N，比原来 24px 的 » 大得多） -->
    <button
      type="button"
      class="rail-strip"
      title={t("ui.backlog.17", { length: visibleTasks.length })}
      aria-label={t("ui.backlog.18", { length: visibleTasks.length })}
      onclick={() => void saveBacklogPane("open")}
    >
      <span class="rail-arrow"><Icon name="chevrons-right" size={16} /></span>
      <span class="rail-count">{visibleTasks.length}</span>
    </button>
  {/if}
  <div class="pane">
  <header class="head">
    <h2 class="title">Backlog</h2>
    <div class="tools">
      <!-- round47（8.1）：一扇门两页 —— 筛选（全部 / 各分类 / 未分类）+「✎ 管理工作…」 -->
      <CategoryMenu
        tasks={visibleTasks}
        {allCategories}
        filter={effFilter}
        onFilter={setFilter}
        onRename={onRenameCategory}
      />
      <button
        type="button"
        class="group-toggle"
        class:on={grouped}
        aria-pressed={grouped}
        title={t("ui.backlog.19")}
        onclick={() => setGrouped(!grouped)}>{t("ui.backlog.59")}</button
      >
      <button
        type="button"
        class="collapse"
        title={t("ui.backlog.20")}
        aria-label={t("ui.backlog.21")}
        onclick={collapseBacklog}><Icon name="chevrons-left" size={16} /></button
      >
    </div>
  </header>

  {#if effFilter !== null}
    <p class="only">
      {t("ui.backlog.22", { effFilter: categoryLabel(effFilter) })}
      <button type="button" title={t("ui.backlog.23")} onclick={() => setFilter(null)}><Icon name="close" size={14} /></button>
    </p>
  {/if}

  <!-- round47：在「只看学习」里新建的任务**直接归到那一类**（筛「未分类」/ 没筛选 → 不设分类） -->
  <NewTaskInput category={effFilter === "" ? null : effFilter} onAdded={onTaskAdded} />

  <ul class="list">
    {#if shownTasks.length === 0}
      <!-- round78（3.1b₂ · 教-01/教-02）：**空库空态** —— 一句话 + 一个直接动作
           （动作 = 聚焦上面那个「添加任务…」输入框；以前这里什么都不显示，一片空白）。
           判据用 `shownTasks.length`：`renderGroups` 在不分组时永远有一个（空）组 —— 拿它判不出空库。 -->
      <li class="empty">
        <p class="empty-text">{t("ui.backlog.63")}</p>
        <button type="button" class="gf empty-add" onclick={() => requestNewTask()}>{t("ui.backlog.64")}</button>
      </li>
    {:else}
      {#each renderGroups as g (g.key)}
      {#if g.head}
        <li class="ghead">
          <button
            type="button"
            class="ghead-btn"
            aria-expanded={!groupCollapsed(g.name)}
            title={groupCollapsed(g.name) ? t("ui.backlog.24") : t("ui.backlog.25")}
            onclick={() => toggleGroup(g.name)}>
            <span class="caret"><Icon name={groupCollapsed(g.name) ? "chevron-right" : "chevron-down"} size={14} /></span>
            {categoryLabel(g.name)} ({g.tasks.length})
          </button>
        </li>
      {/if}
      {#if !g.head || !groupCollapsed(g.name)}
      {#each g.tasks as task, i (task.id)}
        <li
          class="item"
          data-group={String(g.name)}
          class:reordering={reorder?.id === task.id}
          class:drop-before={reorder?.group === String(g.name) && reorder.to === i}
          class:drop-after={reorder?.group === String(g.name) &&
            reorder.to === g.tasks.length &&
            i === g.tasks.length - 1}
          onpointerdown={(e) => onPointerDown(e, task)}
        >
        {#if canReorder}
          <!-- round48：抓手 —— 拖它 = 上下排序；**拖行体仍是「拖到时间轴建块」**（两个手势不打架） -->
          <button
            type="button"
            class="grip"
            title={t("ui.backlog.26")}
            aria-label={t("ui.backlog.27")}
            onpointerdown={(e) => startReorder(e, task.id, i, String(g.name))}
            onkeydown={(e) => void onGripKey(e, i, String(g.name))}><Icon name="grip-vertical" size={16} /></button
          >
        {/if}
        {#if editingId === task.id}
          <input
            class="edit"
            bind:this={inputEl}
            bind:value={draft}
            maxlength="200"
            aria-label={t("ui.backlog.28")}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitEdit(task);
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
            onblur={() => void commitEdit(task)}
          />
        {:else}
          <span
            class="label"
            role="button"
            tabindex="0"
            title={t("ui.backlog.29")}
            ondblclick={() => void startEdit(task)}
            onkeydown={(e) => {
              if (keymapMatches(e, "rename")) {
                e.preventDefault();
                void startEdit(task);
              }
            }}>{task.title}</span
          >
        {/if}
        <span class="acts">
          {#if sanity.enabled}
            <!-- round48（用户 2026-10-03）：⊘ 放在 ⚙ 的**左边**，两个键一起靠右。
                 它是**任务级**开关：管这条任务的**所有块**。功能关掉时它不出现（沿用 round45 的口径） -->
            <button
              type="button"
              class="exempt"
              class:off={task.sanity_exempt}
              title={task.sanity_exempt
                ? t("ui.backlog.30")
                : t("ui.backlog.31")}
              onclick={(e) => {
                e.stopPropagation();
                void onToggleExempt(task);
              }}><Icon name="ban" size={16} /></button
            >
          {/if}
          <button
            class="props-toggle"
            type="button"
            title={t("ui.backlog.32")}
            onclick={() => (taskPanel.propsId = taskPanel.propsId === task.id ? null : task.id)}><Icon name="settings" size={16} /></button
          >
          <button
            class="del"
            type="button"
            title={t("ui.backlog.33")}
            onclick={() => void onDelete(task)}><Icon name="close" size={16} /></button
          >
        </span>
        {#if taskPanel.propsId === task.id}
          <!-- round27：原来的「弹性任务（拖出来的块默认进弹性层）」勾选框已删 —— 用户 2026-10-01 拍板。
               理由：那个字段（`tasks.is_elastic`）全仓没有任何逻辑读它，块层现在一律默认弹性，
               留个勾选只会让人以为它会变什么。（数据库字段先留着，要彻底删得走迁移。） -->
          <div class="props">
            <!-- round78（3.1b₂ · 栈-11）：属性面板按「任务 / 重复 / 操作」分组（与设置同一套行结构） -->
            <h3 class="prop-group">{t("ui.backlog.65")}</h3>
            <label class="prop">
              <span class="prop-label">{t("ui.backlog.34")}</span>
              <span class="prop-line">
                <input
                  class="num"
                  type="number"
                  min="1"
                  max="1440"
                  placeholder={t("ui.backlog.35")}
                  value={task.estimated_minutes ?? ""}
                  onchange={(e) => {
                    // round44（BJ）：保存失败 → 把框拉回原值（否则界面看着像「已改好」，其实库里没动）
                    const el = e.currentTarget;
                    void saveProps(task, { estimatedMinutes: Number(el.value) || 0 }).then((ok) => {
                      if (!ok) el.value = String(task.estimated_minutes ?? "");
                    });
                  }}
                />
                {t("ui.backlog.36")}
              </span>
            </label>
            <label class="prop">
              <span class="prop-label">{t("ui.backlog.37")}</span>
              <span class="prop-line">
                <!-- round40：能直接打字的可创建下拉（灰字数量、回车新建、↑↓/Esc 键盘可达） -->
                <CategoryPicker
                  value={task.category}
                  categories={allCategories}
                  onCommit={(name) => saveProps(task, { category: name })}
                />
                {#if task.category}
                  <button
                    type="button"
                    class="clear-cat"
                    title={t("ui.backlog.38")}
                    onclick={() => void saveProps(task, { category: "" })}><Icon name="close" size={14} /></button
                  >
                {/if}
              </span>
            </label>
            {#if featureOn("repeat_enabled")}
              <div class="prop repeat">
                <div class="repeat-head">
                  {t("ui.backlog.39")}
                  <span class="repeat-note">{t("ui.backlog.40", { task: estMinutes(task) })}</span>
                </div>
                <div class="repeat-form">
                  <select bind:value={repeatWeekday} aria-label={t("ui.backlog.41")}>
                    {#each WEEK_CN as name, i (name)}
                      <option value={i}>{name}</option>
                    {/each}
                  </select>
                  <input class="repeat-time" type="time" bind:value={repeatTime} aria-label={t("ui.backlog.42")} />
                  <button
                    type="button"
                    class="layer-toggle"
                    class:required={repeatLayer === "required"}
                    title={t("ui.backlog.43")}
                    onclick={() =>
                      (repeatLayer = repeatLayer === "required" ? "elastic" : "required")}
                  >{repeatLayer === "required" ? t("ui.backlog.53") : t("ui.backlog.54")}</button>
                  <button
                    type="button"
                    class="repeat-add"
                    disabled={repeatStartMin == null}
                    title={t("ui.backlog.44")}
                    onclick={() => void addRepeatRule(task)}>{t("ui.backlog.60")}</button
                  >
                </div>
                {#each repeatRules as r (r.id)}
                  <div class="repeat-row" class:paused={!r.enabled} data-repeat-id={r.id}>
                    <span class="repeat-when"
                      >{t("ui.backlog.45", { weekday: WEEK_CN[r.weekday], start_min: fmtMin(r.start_min) })}</span
                    >
                    <span class="repeat-layer">{r.layer === "required" ? t("ui.backlog.55") : t("ui.backlog.56")}</span>
                    <button
                      type="button"
                      class="repeat-toggle"
                      title={r.enabled
                        ? t("ui.backlog.46")
                        : t("ui.backlog.47")}
                      onclick={() => void toggleRepeat(task.id, r.id, !r.enabled)}
                      >{r.enabled ? t("ui.backlog.57") : t("ui.backlog.58")}</button
                    >
                    <button
                      type="button"
                      class="repeat-del"
                      title={t("ui.backlog.48")}
                      onclick={() => void removeRepeat(task.id, r.id)}><Icon name="close" size={14} /></button
                    >
                  </div>
                {/each}
              </div>
            {/if}
            <h3 class="prop-group">{t("ui.backlog.66")}</h3>
            <div class="prop-actions">
              <button type="button" class="archive" onclick={() => void onArchive(task)}
                >{t("ui.backlog.49")}</button
              >
              <button type="button" onclick={() => (taskPanel.propsId = null)}>{t("ui.backlog.61")}</button>
            </div>
          </div>
        {/if}
        </li>
      {/each}
      {/if}
      {/each}
    {/if}
  </ul>

  <!-- round38：归档的「出口」——没有出口的归档，用户只会当成删除，于是不敢用它（round26 的原话就是「归档是什么」） -->
  {#if archivedTasks.length > 0}
    <div class="archived">
      <div class="arch-head">
        <button
          type="button"
          class="arch-toggle"
          title={t("ui.backlog.50")}
          onclick={() => (taskPanel.archivedOpen = !taskPanel.archivedOpen)}
          >{t("ui.backlog.51", { length: effArchFilter === null
            ? archivedTasks.length
            : `${archShown.length} / ${archivedTasks.length}` })}<Icon
            name={taskPanel.archivedOpen ? "chevron-down" : "chevron-right"}
            size={14}
          /></button
        >
        <!-- round47：已归档也**按分类筛**（它自己一份筛选，跟主列表互不干扰）。
             只要「筛」不要管理页 —— 改名/合并的入口只在上面那一处，不搞两处重复 -->
        {#if taskPanel.archivedOpen}
          <CategoryMenu
            tasks={archivedTasks}
            {allCategories}
            filter={effArchFilter}
            onFilter={(v) => (archFilter = v)}
            onRename={onRenameCategory}
            manageable={false}
          />
        {/if}
      </div>
      {#if taskPanel.archivedOpen}
        <ul class="arch-list">
          {#each archShown as task (task.id)}
            <li>
              <span class="arch-title" title={task.title}>{task.title}</span>
              {#if task.category}<span class="arch-cat">{task.category}</span>{/if}
              <button
                type="button"
                title={t("ui.backlog.52")}
                onclick={() => void onUnarchive(task)}>{t("ui.backlog.62")}</button
              >
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
  </div>
</section>

<style>
  .backlog {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    flex: 0 0 var(--backlog-width);
    width: var(--backlog-width);
    padding: var(--space-3);
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
  }

  /* round67：面板包装 —— 收进 `.pane` 之后，细轨只改类，内部内容一行不动 */
  .pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    min-height: 0;
  }

  /* round67：细轨 —— 收起来只剩一条窄轨（整条可点 = 展开入口） */
  .backlog.rail {
    flex-basis: var(--backlog-rail-width);
    width: var(--backlog-rail-width);
    padding: var(--space-1) 0;
    align-items: center;
  }

  .backlog.rail .pane {
    display: none;
  }

  /* round67.1：整条细轨是按钮（不再有悬停覆层 —— 你 2026-10-05 实测「把表挡住了」）。
     命中区 40×N，比 24×24 更大；样式与面板头里的收起钮同一套。 */
  .rail-strip {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    width: 100%;
    padding: var(--space-1) 0;
    font: inherit;
    color: var(--text-primary);
    background: none;
    border: none;
    cursor: pointer;
  }

  .rail-strip:hover {
    color: var(--accent);
  }

  .rail-strip:hover .rail-count {
    color: var(--accent);
  }

  .rail-arrow {
    font-size: var(--text-body);
    line-height: 1;
  }

  /* 收起钮（面板头里的 «）—— 24×24，照 WCAG 2.5.8 与 round41 的口径 */
  .collapse {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    min-height: var(--control-height);
    padding: 0 var(--space-1);
    font: inherit;
    font-size: var(--text-body);
    line-height: 1;
    color: var(--text-primary);
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .collapse:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .rail-count {
    font-size: var(--text-meta);
    color: var(--text-secondary);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    /* round86（0.32.0 · ③）：头部装饰两项（值在 palettes.css；没声明 = 今天的样子）
       —— 与时间轴头部同款：inset 线 + 底部 1px 渐隐线（背景画，不吃布局） */
    box-shadow: var(--deco-backlog-head-shadow, none);
    background-image: var(--deco-head-rule, none);
    background-size: 100% 1px;
    background-position: bottom left;
    background-repeat: no-repeat;
  }

  /* round47：头部两个小控件（筛分类 + 分组）—— 栏窄时整体换行，不拆字也不截断 */
  .tools {
    display: flex;
    /* round73：原来是 `flex: none` —— 伪语言/英文拉长时整组会溢出面板头 17px。
       改成可收缩 + 内部换行（装不下时按钮换行，不顶出去）。 */
    flex: 0 1 auto;
    min-width: 0;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .group-toggle {
    display: flex;
    flex: none;
    align-items: center;
    min-height: var(--control-height); /* round41：命中区按 WCAG 2.5.8 抬到 24×24 */
    padding: 0 var(--space-1);
    font: inherit;
    font-size: var(--text-body);
    color: var(--text-primary);
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .group-toggle.on {
    color: var(--accent);
    border-color: var(--accent);
  }

  /* 「只看：X ×」—— 正在筛什么、一键回去 */
  .only {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin: 0;
    font-size: var(--text-meta);
    color: var(--text-secondary);
  }

  .only button {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    min-height: var(--control-height);
    padding: 0;
    font: inherit;
    line-height: 1;
    color: var(--text-secondary);
    background: none;
    border: none;
    cursor: pointer;
  }

  .only button:hover {
    color: var(--warn);
  }

  /* 分组节头（灰底一行：名字 + 条数）—— 用 li 但**不带 `.item`**：
     预览断言是按 `.item` 数任务行的，节头混进去会把数字弄脏 */
  .ghead {
    padding: 0;
    font-size: var(--text-label);
    color: var(--text-secondary);
    letter-spacing: var(--label-tracking);
    border-bottom: 1px solid var(--text-secondary);
  }

  /* round48：节头可点 = 收起/展开这一堆（用户 2026-10-03） */
  .ghead-btn {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    width: 100%;
    min-height: var(--control-height);
    padding: 0 var(--space-1);
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
  }

  .ghead-btn:hover {
    color: var(--text-primary);
  }

  .caret {
    flex: none;
    width: 10px;
  }

  .title {
    margin: 0;
    /* round85（0.31.0）：展示字（北境极夜 / 深海冷光会覆盖这两个 token；默认 = 今天的观感）
       round86（0.32.0 · ⑤）：四个量（倍率 / 字距 / 字重 / 小大写）—— 字距的**回退值是 `--label-tracking`**
       （标题本来就带那一档字距；没有单独指定展示字距的配色不能因为这个钩子丢掉它）。 */
    font-family: var(--font-display);
    font-size: calc(var(--text-title) * var(--display-scale, 1));
    font-weight: var(--display-weight, 700);
    letter-spacing: var(--display-tracking, var(--label-tracking));
    text-transform: var(--display-transform-title);
    font-variant: var(--display-variant, normal);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }

  /* round78（3.1b₂ · 教-01）：空库空态 —— 一句话 + 一个直接动作（不放插画 / 不放动效） */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-2);
  }

  .empty-text {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-body);
    line-height: var(--line-body);
  }

  .empty-add {
    padding: 0 var(--space-2);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--row-height);
    cursor: pointer;
  }

  .empty-add:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-2);
    /* round76：行高跟密度（紧凑 28 / 舒适 32 / 宽松 36）。
       ⚠️ `flex: none` 是必须的：`.list` 是**纵向** flex 容器，而 `min-height` 会顶掉
       flex 条的「自动最小尺寸」（= 内容高度），于是展开属性面板的行会被压回 32px、
       面板从行里溢出去（实测：下一行的名字盖在了分类输入框上、真鼠标点不到）。 */
    flex: none;
    min-height: var(--row-height);
    padding: var(--space-1) var(--space-2);
    background: var(--bg);
    /* round86（0.32.0 · ③）：白瓷的「行底细线」—— 用 1px 背景层画（**不动 border**：
       `border` 被 hover 的 `border-color` 和行高依赖，改它会带出连带改动）。没声明 = transparent（看不见） */
    background-image: linear-gradient(var(--deco-item-line, transparent), var(--deco-item-line, transparent));
    background-size: 100% 1px;
    background-position: bottom left;
    background-repeat: no-repeat;
    border: 1px solid transparent;
    border-radius: var(--radius);
    cursor: grab;
    /* round26 #2/#3（用户截图：卡片、× 被选中，拖拽直接失败）：按下不让浏览器选文本 ——
       原生选文本会顺手发起原生拖拽，而原生拖拽一来 pointerup 就收不到了（手势卡死）。 */
    user-select: none;
  }

  .item:hover {
    border-color: var(--accent);
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* round48：抓手（拖它 = 上下排序；行体拖动仍是「拖到时间轴建块」） */
  .grip {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 16px;
    min-height: var(--control-height);
    padding: 0;
    font-size: var(--text-body);
    line-height: 1;
    color: var(--text-secondary);
    background: none;
    border: none;
    cursor: grab;
  }

  .grip:hover {
    color: var(--accent);
  }

  /* 动作按钮**一组**贴到行右端：⊘ 与 ⚙ 挨着、× 在后（用户 2026-10-03） */
  .acts {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-1);
    margin-left: auto;
  }

  /* 拖动排序时：被拖的那条淡下去，落点画一条线（不额外插元素，免得动 DOM 顺序） */
  .item.reordering {
    opacity: 0.5;
  }

  .item.drop-before {
    box-shadow: inset 0 2px 0 var(--accent);
  }

  .item.drop-after {
    box-shadow: inset 0 -2px 0 var(--accent);
  }

  /* 改名输入框：与行内文字同字号，边框用强调色做「正在编辑」的信号 */
  .edit {
    flex: 1;
    min-width: 0;
    padding: 0 var(--space-1);
    font: inherit;
    color: var(--text-primary);
    background: var(--card);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    outline: none;
  }

  /* round41（0.7.3）：命中区抬到 24×24；
     round77（3.1b）：再抬到 **32×32**（你批「勉强够 = 不够」：目标 32–44）—— 行内三个都是图标按钮，
     图标本体 16px，且**常用项（⚙ 属性）用主色**、其余次级（看不出主次是 L11 那条发现）。 */
  .del,
  .exempt,
  .props-toggle {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    min-height: 32px;
    padding: 0;
    color: var(--text-secondary);
    background: none;
    border: none;
    line-height: 1;
    cursor: pointer;
  }

  .del {
    font-size: var(--text-title);
  }

  /* round48：任务级「不计入理智」—— 计入时是普通灰按钮，排除后沉下去变实心深色（与块上那个记号同一套语义） */
  .exempt {
    font-size: var(--text-body);
  }

  .exempt.off {
    color: var(--text-primary);
    font-weight: 700;
  }

  /* 任务属性面板（v2 ④ update_task / archive_task）—— 命中区已在上面与 `.del` 合并 */
  .props-toggle {
    font-size: var(--text-title);
    /* round77（3.1b）：常用项（打开属性）用主色 —— 与其它两个次级图标拉开一档 */
    color: var(--text-primary);
  }

  .props-toggle:hover {
    color: var(--accent);
  }

  .props {
    flex-basis: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-top: var(--space-1);
    padding: var(--space-2);
    background: var(--card);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    cursor: default;
  }

  /* round78（3.1b₂ · 栈-11）：与设置  同一套行结构 —— 标签行 + 控件行（两段式），
     不 nowrap（窄窗 / 提字号都不溢出） */
  .prop {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    flex: none;
    font-size: var(--text-body);
    color: var(--text-primary);
    white-space: normal;
  }

  /* 分组标题（任务 / 操作）—— 与设置的分区标题同一套层级 */
  .prop-group {
    margin: var(--space-2) 0 0;
    font-size: var(--text-title);
    font-weight: 600;
    color: var(--text-primary);
  }

  .prop-group:first-child {
    margin-top: 0;
  }

  /* 标签行 / 控件行（与设置 `设-03` 同一套） */
  .prop-label {
    color: var(--text-primary);
  }

  .prop-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  .num {
    padding: 0 var(--space-1);
    font: inherit;
    color: var(--text-primary);
    background: var(--bg);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    outline: none;
  }

  .num {
    width: 64px;
  }

  /* round38：分类旁的「清空」（只在有分类时出现）；与输入框等高的一个小 × */
  .clear-cat {
    padding: 0 var(--space-1);
    font: inherit;
    line-height: 1;
    color: var(--text-secondary);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .clear-cat:hover {
    color: var(--warn);
    border-color: var(--warn);
  }

  /* ---- round69（B3）：每周重复（⚙ 面板里的一段）---- */
  .prop.repeat {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-1);
    padding-top: var(--space-1);
    border-top: 1px solid var(--text-secondary);
  }

  .repeat-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-1);
  }

  .repeat-note {
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  .repeat-form {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .repeat-form select,
  .repeat-form input,
  .repeat-form button {
    padding: 0 var(--space-1);
    font: inherit;
    color: var(--text-primary);
    background: var(--bg);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    outline: none;
  }

  .repeat-form input.repeat-time {
    width: 76px;
  }

  .repeat-form .layer-toggle {
    cursor: pointer;
  }

  .repeat-form .layer-toggle.required {
    color: var(--warn);
    border-color: var(--warn);
  }

  .repeat-form .repeat-add {
    cursor: pointer;
  }

  .repeat-form .repeat-add:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .repeat-row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-body);
  }

  .repeat-row.paused .repeat-when {
    color: var(--text-secondary);
    text-decoration: line-through;
  }

  .repeat-row .repeat-layer {
    color: var(--text-secondary);
  }

  .repeat-row .repeat-toggle,
  .repeat-row .repeat-del {
    padding: 0 var(--space-1);
    font: inherit;
    line-height: var(--line-body);
    color: var(--text-secondary);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .repeat-row .repeat-toggle:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .repeat-row .repeat-del {
    margin-left: auto;
  }

  .repeat-row .repeat-del:hover {
    color: var(--warn);
    border-color: var(--warn);
  }

  /* round38：底部的「已归档（N）」+ 展开列表 */
  .archived {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-top: var(--space-2);
    border-top: 1px solid var(--text-secondary);
  }

  /* round47：「已归档（N）」与它自己的分类筛（展开时才出现）同一行 */
  .arch-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .arch-toggle {
    padding: 0;
    font: inherit;
    font-size: var(--text-body);
    color: var(--text-secondary);
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
  }

  .arch-toggle:hover {
    color: var(--text-primary);
  }

  .arch-list {
    margin: 0;
    padding: 0;
    max-height: 160px;
    overflow-y: auto;
    list-style: none;
  }

  .arch-list li {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-body);
    color: var(--text-secondary);
  }

  .arch-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-decoration: line-through; /* 归档 = 已收起来 */
  }

  .arch-cat {
    flex: none;
    padding: 0 var(--space-1);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
  }

  .arch-list button {
    flex: none;
    padding: 0 var(--space-1);
    font: inherit;
    color: var(--text-secondary);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .arch-list button:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .prop-actions {
    display: flex;
    gap: var(--space-1);
    justify-content: flex-end;
  }

  .prop-actions button {
    min-height: var(--control-height);
    padding: 0 var(--space-2);
    font: inherit;
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .prop-actions .archive:hover {
    color: var(--warn);
    border-color: var(--warn);
  }

  .del:hover {
    color: var(--warn);
  }

  /* round77（3.1b）：输入类控件聚焦时给出可见反馈 —— 以前 `outline: none` 之后什么都没有（手批 U1/U12） */
  .edit:focus,
  .num:focus,
  .repeat-form input:focus,
  .repeat-form select:focus,
  .repeat-form button:focus  {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
</style>
