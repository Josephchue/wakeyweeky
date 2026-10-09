<script lang="ts">
  import { t } from "../i18n/i18n.svelte";
  import Icon from "../icons/Icon.svelte";
  /**
   * 8.1 分类管理：Backlog 头部那个 `[分类 ▾]` —— 一扇门里两页：
   * ① **筛选页**：全部 / 各分类 / 未分类（点一行 = 只看它），底部「✎ 管理工作…」；
   * ② **管理页**：每个分类一行（名字 + 数量 + ✎）→ 就地改名。**改成已有名字 = 合并**、
   *    **清空名字并保存 = 这堆回到「未分类」**（你 2026-10-03 拍板）。
   *
   * 为什么保存前就把影响写在脸上（几个任务、并到哪）：改名是**不可逆的文字替换**，
   * 而「能撤销的动作不弹确认框」是本仓定过的口径（round40）→ 那就把「会发生什么」提前说清，
   * 事后给一条可点的撤销（Backlog 那边弹 `toastUndo`）。
   *
   * 机制照 `CategoryPicker`（round40 踩过的坑都记在那边）：`position: fixed` 按按钮的 rect 定位、
   * 点外面/滚列表/改窗口就收起、行用 `pointerdown` 提交（click 之前输入框先 blur，面板会被自己关掉）。
   * `Esc` 只收自己（`stopPropagation`）—— 别让全局 `Esc` 顺手把块选中/属性面板也清了。
   */
  import { tick } from "svelte";
  import type { Task } from "../ipc/types";
  import {
    categoryLabel,
    categoryOptions,
    usedCategories,
    type CategoryFilter,
  } from "../utils/category";

  let {
    tasks,
    allCategories,
    filter,
    onFilter,
    onRename,
    manageable = true,
  }: {
    /** 这个控件在**筛**的那批任务：主列表传未归档的，已归档那一栏传归档的（计数就看它） */
    tasks: Task[];
    /** 管理页要认的**全部分类**（含已归档任务在用的）+ 数量 —— 一个分类可能只有归档任务在用，
     *  照样得能改名；数字也是「改名会影响几个」（含已归档） */
    allCategories: { name: string; count: number }[];
    filter: CategoryFilter;
    onFilter: (value: CategoryFilter) => void;
    /** 改名 / 合并 / 清空（空串 = 回到未分类）—— 提示与撤销由 Backlog 那边发（这里只管界面） */
    onRename: (from: string, to: string) => Promise<void>;
    /** 已归档那一栏只要「筛」，不要管理页（管理入口只在主列表那头，别两处重复） */
    manageable?: boolean;
  } = $props();

  let open = $state(false);
  let page = $state<"filter" | "manage">("filter");
  let hi = $state(0);
  let editing = $state<string | null>(null);
  let draft = $state("");
  let btnEl = $state<HTMLButtonElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let rect = $state({ left: 0, top: 0, width: 0 });
  const popId = "cat-menu-" + Math.random().toString(36).slice(2, 8);

  const options = $derived(categoryOptions(tasks));
  /** 筛选页的数字：**这个列表里**的条数（选项也只列这个列表里真有的分类 → 不会点出一个空列表） */
  const counts = $derived(new Map(usedCategories(tasks).map((c) => [c.name, c.count])));
  const uncategorized = $derived(tasks.filter((t) => !t.category).length);
  /**
   * round69.1（#8 / D4）：「管理工作…」只在**真有分类可管**时出现 ——
   * 一个分类都没用过时它只是一行噪声（你验收截图：只有「未分类 6」）——
   * 看 `allCategories`（含只有归档任务在用的分类），而不是当前筛选结果。
   */
  const showManage = $derived(manageable && allCategories.length > 0);
  /** 筛选页行数 = 选项数 + 1（最后那行「管理工作…」）；已归档那栏没有管理行 */
  const rowCount = $derived(options.length + (showManage ? 1 : 0));
  /** 管理页输入框下面那句话（**保存前**就说清会发生什么） */
  const hint = $derived.by(() => {
    const from = editing;
    if (!from) return "";
    const to = draft.trim();
    const src = allCategories.find((c) => c.name === from)?.count ?? 0;
    if (to === from) return t("ui.category_menu.01");
    if (to === "") return t("ui.category_menu.02", { src: src });
    const target = allCategories.find((c) => c.name === to);
    if (target) return t("ui.category_menu.03", { to: to, count: src + target.count });
    return t("ui.category_menu.04", { src: src });
  });

  function countFor(value: CategoryFilter): number {
    if (value === null) return 0; // 「全部」不显示数字（它不是某一类）
    if (value === "") return uncategorized;
    return counts.get(value) ?? 0;
  }

  /** 当前筛选在第几行（打开时高亮它 —— 与 round44 BH 同一个教训：回车不该手滑改筛选） */
  function rowOfCurrent(): number {
    const i = options.findIndex((o) => o.value === filter);
    return i < 0 ? 0 : i;
  }

  function openPop() {
    const r = btnEl?.getBoundingClientRect();
    if (r) rect = { left: r.left, top: r.bottom + 2, width: Math.max(r.width, 180) };
    page = "filter";
    editing = null;
    hi = rowOfCurrent();
    open = true;
  }

  function closePop() {
    open = false;
    editing = null;
  }

  function pickFilter(value: CategoryFilter) {
    onFilter(value);
    closePop();
  }

  async function startRename(name: string) {
    editing = name;
    draft = name;
    await tick(); // 输入框要先渲染出来才能聚焦
    inputEl?.focus();
    inputEl?.select();
  }

  /** 保存改名：名字没变就什么都不做（后端也会返回 0）；失败由 ipc 层弹 Toast，
   *  界面回落到旧名字（**不假装已改** —— round44 BJ 同一个口径）。 */
  async function commitRename() {
    const from = editing;
    if (!from) return;
    const to = draft.trim();
    editing = null;
    if (to === from) return;
    await onRename(from, to);
  }

  function onMgrKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename();
      return;
    }
    if (e.key === "Escape") {
      // 第一层：先放弃这次编辑（别让全局 Esc 顺手把块选中也清了）
      e.preventDefault();
      e.stopPropagation();
      editing = null;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (page !== "filter") return;
      const dir = e.key === "ArrowDown" ? 1 : -1;
      hi = Math.max(0, Math.min(hi + dir, rowCount - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (page !== "filter") return;
      if (showManage && hi >= options.length) page = "manage"; // 最后一行 = 「管理工作…」
      else pickFilter(options[Math.min(hi, options.length - 1)].value);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (page === "manage") page = "filter"; // 第一层：从管理页退回筛选页
      else closePop();
    }
  }

  // round69.1（#8）：管理页开着的时候分类被清空 → 退回筛选页（别留一个空壳页）
  $effect(() => {
    if (!showManage && page === "manage") page = "filter";
  });

  // 点外面 / 滚列表 / 改窗口大小 → 收起（与 CategoryPicker 同一套口径）
  $effect(() => {
    const onDown = (e: PointerEvent) => {
      if (!open) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".cat-pop") || t?.closest?.(".cat-btn")) return;
      closePop();
    };
    const onScrollOrResize = () => closePop();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  });
</script>

<button
  type="button"
  class="cat-btn"
  class:on={open || filter !== null}
  bind:this={btnEl}
  aria-expanded={open}
  aria-controls={popId}
  aria-haspopup="listbox"
  title={showManage
    ? t("ui.category_menu.05")
    : t("ui.category_menu.06")}
  onkeydown={onKey}
  onclick={() => (open ? closePop() : openPop())}
>
  <span class="btn-label">{filter === null ? t("ui.category_menu.14") : categoryLabel(filter)}</span><Icon name="chevron-down" size={14} />
</button>

{#if open}
  <div
    id={popId}
    class="cat-pop cat-menu"
    style="left: {rect.left}px; top: {rect.top}px; width: {rect.width}px"
  >
    {#if page === "filter"}
      <div role="listbox" aria-label={t("ui.category_menu.07")}>
        {#each options as o, i (String(o.value))}
          <button
            type="button"
            class="row"
            class:on={hi === i}
            role="option"
            aria-selected={hi === i}
            onpointerdown={(e) => {
              e.preventDefault();
              pickFilter(o.value);
            }}
          >
            <span class="nm" class:dim={o.value === null || o.value === ""}>{o.label}</span>
            {#if countFor(o.value) > 0}
              <span class="ct" title={t("ui.category_menu.08", { value: countFor(o.value) })}>{countFor(o.value)}</span>
            {/if}
          </button>
        {/each}
        {#if showManage}
          <!-- 管理入口放在**分类名你正看着的地方**（你 2026-10-03 选的位置）——
               round69.1（#8）：只在真有分类时出现 -->
          <button
            type="button"
            class="row mgr"
            class:on={hi === options.length}
            onpointerdown={(e) => {
              e.preventDefault();
              page = "manage";
            }}
          >
            <span class="nm">{t("ui.category_menu.09")}</span>
          </button>
        {/if}
      </div>
    {:else}
      <div class="mhead">
        <button
          type="button"
          class="back"
          onpointerdown={(e) => {
            e.preventDefault();
            page = "filter";
          }}>{t("ui.category_menu.15")}</button
        >
        <span class="mtitle">{t("ui.category_menu.10")}</span>
      </div>
      {#each allCategories as c (c.name)}
        <div class="mrow">
          {#if editing === c.name}
            <input
              class="minput"
              bind:this={inputEl}
              value={draft}
              maxlength="40"
              spellcheck="false"
              aria-label={t("ui.category_menu.11", { name: c.name })}
              oninput={(e) => (draft = e.currentTarget.value)}
              onkeydown={onMgrKey}
              onblur={() => void commitRename()}
            />
          {:else}
            <span class="mname" title={c.name}>{c.name}</span>
          {/if}
          <span class="mcount">{c.count}</span>
          {#if editing !== c.name}
            <button
              type="button"
              class="mbtn"
              title={t("ui.category_menu.12")}
              onpointerdown={(e) => {
                e.preventDefault();
                // 先收尾上一次没提交的编辑（pointerdown 挡掉了 blur，不然那份草稿会被覆盖）
                if (editing) void commitRename();
                void startRename(c.name);
              }}><Icon name="pencil" size={16} /></button
            >
          {/if}
        </div>
        {#if editing === c.name}
          <p class="hint">{hint}</p>
        {/if}
      {/each}
      <p class="foot">{t("ui.category_menu.13")}</p>
    {/if}
  </div>
{/if}

<style>
  .cat-btn {
    display: flex;
    flex: none;
    align-items: center;
    max-width: 110px;
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

  .cat-btn.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  .btn-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cat-pop {
    position: fixed;
    z-index: 50;
    max-height: 60vh;
    padding: var(--space-1);
    overflow-y: auto;
    background: var(--card);
    border: 1px solid var(--accent);
    border-radius: var(--radius-lg); /* round77：面板/浮层走圆角阶梯的 lg（Fluent：浮层 8px） */
    box-shadow: var(--shadow-drop);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    width: 100%;
    min-height: var(--control-height);
    padding: 2px var(--space-1);
    font: inherit;
    font-size: var(--text-body);
    color: var(--text-primary);
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .row.on {
    background: var(--accent);
    color: var(--card);
  }

  .nm {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dim {
    color: var(--text-secondary);
  }

  .row.on .dim {
    color: var(--card);
    opacity: 0.85;
  }

  /* 数量：次要信息（灰色小字、等宽数字 —— round41 定的层级） */
  .ct,
  .mcount {
    flex: none;
    padding-left: var(--space-2);
    font-size: var(--text-meta);
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    opacity: 0.85;
  }

  .row.on .ct {
    color: var(--card);
  }

  .mgr {
    margin-top: 2px;
    border-top: 1px solid var(--text-secondary);
    border-radius: 0;
  }

  .mhead {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-1) 2px;
  }

  .mtitle {
    font-size: var(--text-label);
    color: var(--text-secondary);
    letter-spacing: var(--label-tracking);
  }

  .back {
    min-height: var(--control-height);
    padding: 0 var(--space-1);
    font: inherit;
    font-size: var(--text-body);
    color: var(--accent);
    background: none;
    border: none;
    cursor: pointer;
  }

  .mrow {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    /* min-height 会顶掉 flex 的「自动最小尺寸」（同类 bug 见 Backlog `.item`）。
       这里父容器（`.mgr`）现在是**块级**，`flex: none` 实际是空操作 —— 留着当保险，
       将来把面板改成纵向 flex 也不会被压扁。 */
    flex: none;
    min-height: var(--row-height);
    padding: 0 var(--space-1);
  }

  .mname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: var(--text-body);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .minput {
    flex: 1;
    min-width: 0;
    padding: 0 var(--space-1);
    font: inherit;
    font-size: var(--text-body);
    color: var(--text-primary);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    outline: none;
  }

  .mbtn {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    min-height: var(--control-height);
    padding: 0;
    font-size: var(--text-body);
    line-height: 1;
    color: var(--text-secondary);
    background: none;
    border: none;
    cursor: pointer;
  }

  .mbtn:hover {
    color: var(--accent);
  }

  .hint,
  .foot {
    margin: 2px 0 2px var(--space-2);
    font-size: var(--text-meta);
    line-height: var(--line-body);
    color: var(--text-secondary);
  }

  .foot {
    padding-top: var(--space-1);
    border-top: 1px solid var(--text-secondary);
  }

  /* round77（3.1b）：输入类控件聚焦时给出可见反馈 —— 以前 `outline: none` 之后什么都没有（手批 U1/U12） */
  .minput:focus  {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
</style>
