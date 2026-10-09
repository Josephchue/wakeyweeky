<script lang="ts">
  import { t, tn } from "../i18n/i18n.svelte";
  /**
   * round40：分类的「**能直接打字的下拉**」（可创建 combobox）。
   *
   * 为什么自己画，而不是用原生控件（你 2026-10-02 实测回的两条）：
   * - `datalist`：「像自动填写账号密码那样突然冒出来一个黑框」+ 选完又弹一遍（它是「输入建议」，浮层归浏览器画 ✗）
   * - `<select>`：不能直接打字（你说「新建分类那个键我得追过去按到才能开始输东西」），
   *   而且**选项文字里做不出「灰色小字右对齐的数量」**（原生下拉不给样式控制权）
   *
   * 调研（WAI-ARIA APG 的 editable combobox / shadcn·Entangle·Mobbin 的 creatable combobox）：
   * 通行交互 = **输入框常驻 + 列表跟着过滤 + 回车选中或新建 + Esc 关列表 + 点外面关**。
   *
   * 两个实现要点（都是本仓踩过的坑）：
   * 1. 面板用 `position: fixed` 按输入框的 rect 定位 —— Backlog 列表是 `overflow-y: auto`，
   *    普通绝对定位会被裁掉 ✗（列表一滚就关掉面板，见下面的 scroll 监听）。
   * 2. 候选行用 `pointerdown`（不是 click）提交：click 之前输入框先 blur，列表会被自己关掉 ✗。
   */
  import { untrack } from "svelte";

  let {
    value,
    categories,
    onCommit,
  }: {
    /** 当前分类（null = 不设） */
    value: string | null;
    /** 用过的分类（用得多的在前）；数量只在列表里以**灰色小字**显示 */
    categories: { name: string; count: number }[];
    /** 提交（空串 = 清空）。**返回 Promise 时，失败会把输入框拉回原值**（round44 / BJ） */
    onCommit: (name: string) => Promise<boolean> | void;
  } = $props();

  let open = $state(false);
  let query = $state("");
  let hi = $state(0); // 高亮行（0 = 「不设分类」）；打开列表时设为**当前分类那一行**（见 rowOfCurrent）
  let inputEl = $state<HTMLInputElement | null>(null);
  let rect = $state({ left: 0, top: 0, width: 0 });
  /**
   * round70（DA）：**已经提交出去、还在等 prop 回来**的值（undefined = 没有在途提交）。
   *
   * 你 2026-10-05 验收带回：「分组键开着的时候，我在任务的菜单里面修改任务的种类会被阻止」。
   * 根因：`pick()` 先 `commit()` 再 `closeList()` —— 列表一关，`shown` 回落到**尚未更新的 prop**
   * （旧分类），Svelte 把旧值写回输入框；分组开着时任务会被搬到另一堆（输入框随行一起重建），
   * 那一瞬的失焦又走 `onblur`「失焦也保存」，把旧值写进库 —— 先写对、马上被盖回去 ✗
   * （CDP 真输入探针的现场：`writes=["学习","工作"]` + `blur=工作`）。
   * 在途期间 `shown` 与失焦判据都用它：输入框不回退，也不会把「我们自己刚写出去的值」当成新改动再写一遍。
   */
  let pending: string | null | undefined = $state(undefined);
  /** 上一次看到的 prop —— 区分「我们刚提交的值回来了」与「外面把分类改了」（撤销 / × 清空）
   *  （`untrack`：只要初始快照，不要建立响应式依赖 —— 否则编译告「只捕获了初值」） */
  let lastProp = untrack(() => value);
  $effect(() => {
    if (value !== lastProp) {
      lastProp = value;
      pending = undefined; // prop 变了：不管是不是提交落地，都改认 prop
    }
  });
  /** 列表的 id（`aria-controls` 要它；每实例一个，免得同页两个 picker 撞 id） */
  const popId = "cat-pop-" + Math.random().toString(36).slice(2, 8);

  const q = $derived(query.trim());
  /** 跟着打字过滤（大小写不敏感、包含即算 —— 中文里「作」能匹配到「工作」） */
  const matched = $derived(
    q ? categories.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())) : categories,
  );
  /** 打得字在已有的里面查不到 → 最后多一行「＋ 新建「xxx」」（回车即建） */
  const canCreate = $derived(q !== "" && !categories.some((c) => c.name === q));
  const rowCount = $derived(1 + matched.length + (canCreate ? 1 : 0));
  const hiRow = $derived(Math.max(0, Math.min(hi, rowCount - 1)));
  /** 收起时显示当前分类（有在途提交就先显示它），展开时显示正在打的字 */
  const shown = $derived(
    open ? query : pending !== undefined ? (pending ?? "") : (value ?? ""),
  );

  /**
   * 当前分类在列表里的行号（0 = 「不设分类」；找不到 → 0）。
   * round44（BH）：以前 `openList` 写死高亮第 1 行 —— 打开列表直接回车会**手滑换掉分类**（
   * 用户检查轮登记：分类列表默认高亮第一项）；现在默认停在当前分类上，回车 = 什么都不变。
   * （打字时仍回第 1 行：那是「跟着过滤结果选第一个」的预期）
   */
  function rowOfCurrent(): number {
    if (!value) return 0;
    const i = categories.findIndex((c) => c.name === value);
    return i < 0 ? 0 : i + 1;
  }

  /**
   * round44（BJ）：提交 + **失败回滚**。
   * 以前 `void onCommit(...)` 一丢了事：库里没改，但输入框里还留着你打的字（看着像已改好）✗。
   * 保存失败就把框里的文本拉回当前值；成功则等 store 更新 `value` 后自然刷新。
   */
  function commit(name: string) {
    // round70（DA）：记下在途值 —— prop 回来之前，它才是「输入框里该显示的东西」
    //（round69.1 #6 那句「先把框里的字落定」已被 `shown` 的 pending 分支取代：closeList() 之后框里不会闪空，
    //  也不再需要命令式回写 DOM —— 回写还会把「在途值没撤」这种错处盖住、让断言测不出来）
    pending = name === "" ? null : name;
    const out = onCommit(name);
    if (out && typeof out.then === "function") {
      void out.then((ok) => {
        if (!ok) {
          pending = undefined;
          if (inputEl) inputEl.value = value ?? "";
        }
      });
    }
  }

  function openList() {
    const r = inputEl?.getBoundingClientRect();
    if (r) rect = { left: r.left, top: r.bottom + 2, width: r.width };
    query = ""; // 打开时先列全部（不拿当前值当过滤词）
    hi = rowOfCurrent(); // round44（BH）：高亮当前分类（回车 = 不变），而不是固定第一行
    open = true;
  }

  function closeList() {
    open = false;
    query = "";
  }

  /** 选中第 i 行：0 = 不设分类；1..matched.length = 已有分类；再往后 = 新建 */
  function pick(i: number) {
    if (i === 0) commit("");
    else if (i <= matched.length) commit(matched[i - 1].name);
    else commit(q);
    closeList();
  }

  function onKey(e: KeyboardEvent) {
    // round69.1（#6）：输入法**组词中**的按键一律不接 —— 中文输入法「回车确认候选」的 keydown
    // 带 `isComposing=true`（且**先于** compositionend/input）—— 照旧处理会拿旧拼音去提交
    // （实测：建出拼音分类 `zuoye`、列表被关；最后那次真回车误设成了别的分类）。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const dir = e.key === "ArrowDown" ? 1 : -1;
      hi = Math.max(0, Math.min(hiRow + dir, rowCount - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (open) pick(hiRow);
      else if (q) commit(q); // 没展开时打的字，回车也算数
      else commit(value ?? "");
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        // 第一层：先关列表 —— `stopPropagation` 别让全局 `Esc` 顺手把 ⚙ 面板也收了
        e.preventDefault();
        e.stopPropagation();
        closeList();
      }
      // 列表已经关着 → 交给全局 `Esc`（收面板 + 全清），符合「Esc 一按到底」的既有口径
    }
  }

  // 点外面 / 滚列表 / 改窗口大小 → 关掉（面板是 fixed 定位，滚走就会脱节）
  $effect(() => {
    const onDown = (e: PointerEvent) => {
      if (!open) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".cat-pop") || t === inputEl) return;
      closeList();
    };
    const onScrollOrResize = () => closeList();
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

<!-- 输入框常驻：**点进来就能打字**（不用先去菜单里找一个「新建」项） -->
<input
  class="cat-input"
  bind:this={inputEl}
  value={shown}
  placeholder={t("ui.category_picker.01")}
  maxlength="40"
  spellcheck="false"
  role="combobox"
  aria-label={t("ui.category_picker.02")}
  aria-expanded={open}
  aria-controls={popId}
  aria-autocomplete="list"
  oninput={(e) => {
    query = e.currentTarget.value;
    if (!open) openList();
    hi = 1;
  }}
  onpointerdown={() => {
    if (!open) openList();
  }}
  onkeydown={onKey}
  onblur={() => {
    // 与「改任务名」同一套口径：**失焦也保存**（空 = 清空）；展开时点候选行不会走到这儿（见行上的 pointerdown）
    if (open) return;
    const next = (inputEl?.value ?? "").trim();
    // round70（DA）：在途提交还没回来时，判据是**刚提交出去的值**，不是旧 prop ——
    // 否则 blur（分组搬家会拆输入框）会把旧值再写一遍，把新分类盖回去
    const known = pending !== undefined ? (pending ?? "") : (value ?? "");
    if (next !== known) commit(next);
  }}
/>

{#if open}
  <div
    id={popId}
    class="cat-pop"
    role="listbox"
    style="left: {rect.left}px; top: {rect.top}px; width: {rect.width}px"
  >
    <button
      type="button"
      class="row"
      class:on={hiRow === 0}
      role="option"
      aria-selected={hiRow === 0}
      onpointerdown={(e) => {
        e.preventDefault();
        pick(0);
      }}
    >
      <span class="nm dim">{t("ui.category_picker.03")}</span>
    </button>
    {#each matched as c, i (c.name)}
      <button
        type="button"
        class="row"
        class:on={hiRow === i + 1}
        role="option"
        aria-selected={hiRow === i + 1}
        onpointerdown={(e) => {
          e.preventDefault();
          pick(i + 1);
        }}
      >
        <span class="nm">{c.name}</span>
        <!-- 数量：**灰色小字、靠右**。
             round41 我做成「≥2 才显示」，round48 用户验收实测打回来了：
             「项目分类明明有一个，右边却没有 1」—— 1 也是信息（说明这一类在用），一直显示。 -->
        <span class="ct" title={tn("ui.category_picker.04", c.count, { count: c.count })}>{c.count}</span>
      </button>
    {/each}
    {#if canCreate}
      <button
        type="button"
        class="row"
        class:on={hiRow === matched.length + 1}
        role="option"
        aria-selected={hiRow === matched.length + 1}
        onpointerdown={(e) => {
          e.preventDefault();
          pick(matched.length + 1);
        }}
      >
        <span class="nm">{t("ui.category_picker.05", { q: q })}</span>
      </button>
    {/if}
  </div>
{/if}

<style>
  .cat-input {
    flex: 1;
    min-width: 0;
    padding: 0 var(--space-1);
    font: inherit;
    font-size: var(--text-body);
    color: var(--text-primary);
    background: var(--bg);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    outline: none;
  }

  .cat-input:focus {
    border-color: var(--accent);
  }

  .cat-pop {
    position: fixed;
    z-index: 50;
    max-height: 220px;
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

  /* 高亮行（键盘 ↑↓ / 鼠标悬停都算） */
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

  /* round41（0.7.3）：数量要一眼看出是**次要信息**（用户实测「不知道该看名字还是看数量」）——
     更小（10px）+ 更淡（opacity .7）+ 等宽数字（右对齐好看） */
  .ct {
    flex: none;
    padding-left: var(--space-2);
    font-size: var(--text-meta);
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }

  .row.on .ct {
    color: var(--card);
    opacity: 0.85;
  }
</style>
