<script lang="ts">
  import { normalizeLocaleChoice, resolveLocaleChoice, t, type MsgKey } from "../i18n/i18n.svelte";  import Icon from "../icons/Icon.svelte";
  /**
   * C18（round63）：**设置弹层**（原 C6 的「理智值小旋钮」扩成分区面板 —— 文件与类名沿用，
   * 理由见 `docs/plans/round63-c18-settings.md`：精准修改，不做纯改名）。
   *
   * 分区：提醒 / 理智值 / 数据 / 键位说明。**非模态**：点外面或 `Esc` 自动收起（round39 的口径），
   * 调预算时时间轴还看得见（日头小条当场变）。
   *
   * 每个开关 / 输入的写失败都要把控件**拨回原位**（round54 BQ 那套：失败时 store 没变，
   * 而 `checked` / `value` 是单向绑定 → 必须自己去碰 DOM）。
   */
  // round62（C14）：备份的另存为 / 打开走**系统对话框**（文件选择是系统能力）；
  // 二次确认走应用内面板（round80 · 79-01，`confirmDanger`）。
  // 注意：`open` 与下面弹层自己的 `open` 状态重名 → 别名带上 Dialog 后缀。
  import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import {
    reminders,
    sanity,
    saveBudgetHours,
    setReminder,
    setSanityEnabled,
  } from "../stores/sanity.svelte";
  import { loadRemindSettings, remindSettings, saveRemindSettings } from "../stores/review.svelte";
  import {
    REMIND_LEAD_CHOICES,
    QUIET_PRESET_MINUTES,
    clearQuiet,
    featureOn,
    loadPrefs,
    prefs,
    quietForMinutes,
    quietUntilAt,
    quietUntilMorning,
    saveFeature,
    saveQuietMorning,
    saveRemindLead,
    saveSchedulerEnabled,
    saveTemplateSuggest,
    saveAchievementsEnabled,
    saveAchievementToast,
    saveUiLocale,
    saveDensity,
    saveTheme,
    savePalette,
    saveLayerBarColor,
    saveCategoryBar,
    saveIconSet,
    saveBlockSecondLine,
    saveFontFamily,
    saveNowLine,
    saveTemplatePreview,
    saveTimeFormat,
    saveDateFormat,
    saveNightDim,
    saveNightStart,
    saveNightEnd,
  } from "../stores/settings.svelte";
  import {
    normalizeDateFormat,
    normalizeTimeFormat,
    sampleClock,
    sampleDate,
  } from "../utils/datetime.svelte";
  import { exportBackup, importBackup } from "../ipc/backup";
  import { resetSettings } from "../ipc/settings";
  import RichText from "../i18n/RichText.svelte";
  import { exportIcs } from "../ipc/calendar";
  import { backupFileName, formatBytes } from "../utils/backup";
  import { icsFileName } from "../utils/calendar";
  import { FEATURES, FEATURE_TAG_KEY, type FeatureMeta } from "../utils/features";
  import { getDataInfo, hotkeyStatus, type DataInfo, type HotkeyStatus } from "../ipc/portable";
  import { formatQuietUntil, normalizeHHMM } from "../utils/quiet";
  import { confirmDanger, focusTrap, scrollableRegion } from "../utils/modal";
  import { iconData } from "../icons";
  import {
    DENSITIES,
    DENSITY_SCALE,
    FONT_FAMILIES,
    ICON_SETS,
    PALETTES,
    PALETTE_PREVIEW,
    THEMES,
    normalizeFontFamily,
    normalizeSecondLine,
    type Density,
    type FontFamily,
    type IconSet,
    type Palette,
    type Theme,
  } from "../utils/appearance";
  import {
    closeSettingsPanel,
    openDataSwitch,
    openKeymapPanel,
    openSettingsPanel,
    settingsPanel,
    toast,
  } from "../stores/ui.svelte";
  import {
    layout,
    loadLayoutSettings,
    resetLayout,
    saveHintBarMode,
    saveSlotHeight,
    saveWeekendHidden,
    slotHeightEffective,
    SLOT_HEIGHTS,
    type HintBarMode,
    type SlotHeight,
  } from "../stores/layout.svelte";
  import { openHelp, showFirstRunAgain } from "../stores/guide.svelte";
  import { closeDrift } from "../stores/drift.svelte";
  import { achievements, loadAchievements, openAchievements } from "../stores/achievements.svelte";

  /** round78（栈-01）：设置弹层的开关**上提到 `ui.svelte`** —— 面板栈要看得见它
   *  （不然点顶栏「总览」时设置明明开着却不关：同级不替换）。组件里只读。 */
  const open = $derived(settingsPanel.open);
  /** round78（3.1b₂ · 设-01）：**分区导航**高亮 + 「更多」折叠 + 各子区折叠（低频区默认收起） */
  const SETTINGS_GROUPS: { id: string; label: MsgKey }[] = [
    { id: "theme", label: "ui.sanity_settings.140" },
    { id: "density", label: "ui.sanity_settings.141" },
    { id: "timeline", label: "ui.sanity_settings.142" },
    { id: "alert", label: "ui.sanity_settings.143" },
    { id: "more", label: "ui.sanity_settings.144" },
  ];
  let activeGroup = $state("theme");
  let moreOpen = $state(false);
  // round82（11.7 · 你 2026-10-07 拍板「照 VS Code 的做法来」）：系统语言不是中文 / English 时
  // **就用 English**（不改判定、不在选项里加任何说明——要解释去说明页）
  const sysLocaleLabel = $derived(
    resolveLocaleChoice("system") === "en" ? t("ui.sanity_settings.114") : t("ui.sanity_settings.113"),
  );
  let sub = $state<Record<string, boolean>>({});
  const subOpen = (id: string) => !!sub[id];
  function toggleSub(id: string) {
    sub = { ...sub, [id]: !sub[id] };
  }
  /** 导航跳转：滚到那一组（`scrollIntoView` 在 `.pop-body` 这个滚动容器里就位） */
  function jumpTo(id: string) {
    activeGroup = id;
    document.getElementById(`settings-group-${id}`)?.scrollIntoView({ block: "start" });
  }

  // ===== round79（78-05）：正文末尾留白 + 滚动值守 =====

  /**
   * 正文末尾的**动态留白**（px）：高度 = 视口高 − 末组高 − 底内边距 − `scroll-margin`。
   * 为什么需要（你 2026-10-06 的 78-05）：点导航时 `scrollIntoView({block:"start"})` 只能滚到
   * `max scrollTop = scrollHeight − clientHeight`；该组**下方内容不够高**时就被钳住，组标题只能停在半空。
   * 只在正文**真的溢出**时给留白 —— 否则面板会「撑高→重算→再撑高」来回跳。
   */
  const SCROLL_MARGIN = 8; // = `.group { scroll-margin-top: var(--space-2) }`
  /** 滚动值守的判定线（组标题在这个带里就算「顶上那一屏」）—— 比 SCROLL_MARGIN 略宽一点 */
  const SCROLL_SPY_PX = 12;
  let tailPx = $state(0);
  let bodyEl = $state<HTMLElement | null>(null);

  function recomputeTail() {
    const body = bodyEl;
    if (!body) {
      tailPx = 0;
      return;
    }
    const groups = body.querySelectorAll<HTMLElement>(".group");
    const last = groups[groups.length - 1];
    if (!last) {
      tailPx = 0;
      return;
    }
    const contentNoTail = body.scrollHeight - tailPx;
    if (contentNoTail <= body.clientHeight) {
      tailPx = 0; // 整页都看得见 → 不需要留白
      return;
    }
    const padBottom = parseFloat(getComputedStyle(body).paddingBottom) || 0;
    const next = Math.max(
      0,
      Math.round(body.clientHeight - last.offsetHeight - padBottom - SCROLL_MARGIN),
    );
    if (Math.abs(next - tailPx) > 1) tailPx = next;
  }

  /** 滚动值守（scroll-spy）：手动滚到哪一组，导航里那一组就亮（与点击跳转共用 `activeGroup`） */
  function onBodyScroll() {
    const body = bodyEl;
    if (!body) return;
    const top = body.getBoundingClientRect().top;
    let current = "";
    for (const g of body.querySelectorAll<HTMLElement>(".group")) {
      if (g.getBoundingClientRect().top - top <= SCROLL_SPY_PX) current = g.id;
    }
    const id = current.replace("settings-group-", "");
    if (id && id !== activeGroup) activeGroup = id;
  }

  // 面板开着期间：折展状态 / 尺寸一变就重量（子区展开是内部节点变化，靠 `sub` 依赖抓到）
  $effect(() => {
    if (!open) return;
    void bodyEl;
    void moreOpen;
    void sub;
    const body = bodyEl;
    if (!body) return;
    recomputeTail();
    onBodyScroll();
    body.addEventListener("scroll", onBodyScroll, { passive: true });
    const ro = new ResizeObserver(() => recomputeTail());
    ro.observe(body);
    const groups = body.querySelectorAll<HTMLElement>(".group");
    const lastGroup = groups[groups.length - 1];
    if (lastGroup) ro.observe(lastGroup);
    window.addEventListener("resize", recomputeTail);
    return () => {
      body.removeEventListener("scroll", onBodyScroll);
      ro.disconnect();
      window.removeEventListener("resize", recomputeTail);
    };
  });
  /** 选/卡片类控件的文案（真份数据在 i18n；这里只做映射，不复制字） */
  const PALETTE_LABEL: Record<Palette, MsgKey> = {
    warm: "ui.sanity_settings.126",
    cool: "ui.sanity_settings.127",
    sage: "ui.sanity_settings.128",
    // round85（0.31.0）：9 套内置主题（round84 的候选转正）
    endfield: "ui.sanity_settings.178",
    terminal: "ui.sanity_settings.179",
    deepsea: "ui.sanity_settings.180",
    bauhaus: "ui.sanity_settings.181",
    artdeco: "ui.sanity_settings.182",
    cassette: "ui.sanity_settings.183",
    north: "ui.sanity_settings.184",
    brutal: "ui.sanity_settings.185",
    porcelain: "ui.sanity_settings.186",
  };
  const THEME_LABEL: Record<Theme, MsgKey> = {
    system: "ui.sanity_settings.121",
    light: "ui.sanity_settings.122",
    dark: "ui.sanity_settings.123",
    // round82（3.1c₂ · 淡-04）：第四档「按时间」—— 解释（夜间用深色 / 与下面那对时段联动）在行下的 hint 里
    night: "ui.sanity_settings.173",
  };
  const DENSITY_LABEL: Record<Density, MsgKey> = {
    compact: "ui.sanity_settings.116",
    comfortable: "ui.sanity_settings.117",
    loose: "ui.sanity_settings.118",
  };
  /** round87（3.3）：界面字体族五档（与 `FONT_FAMILIES` 同序） */
  const FONT_LABEL: Record<FontFamily, MsgKey> = {
    default: "ui.sanity_settings.188",
    song: "ui.sanity_settings.189",
    kai: "ui.sanity_settings.190",
    deng: "ui.sanity_settings.191",
    mono: "ui.sanity_settings.192",
  };
  /** 图标五套的名字是品牌名（两种语言一样，不进 i18n） */
  const ICON_SET_LABEL: Record<IconSet, string> = {
    lucide: "Lucide",
    tabler: "Tabler",
    phosphor: "Phosphor",
    bootstrap: "Bootstrap",
    material: "Material",
  };
  /** 预览里那六枚图标 = 设置面板自己真的会用到的语义名 */
  const ICON_PREVIEW = ["settings", "check", "calendar-days", "bell", "sun", "database"] as const;
  /** C18：「自定义…」暂停的日期时间输入框露不露出来 */
  let customOpen = $state(false);
  let customValue = $state("");
  /** 输入框里的小时数（打开时与当前值同步；改完 onchange 提交） */
  let hours = $state(6);

  /** round66（C12）：便携模式状态（打开设置时读一次；数据区那行与计划任务开关都要看它） */
  let dataMode = $state<DataInfo | null>(null);
  /** round66：全局快捷键的注册状态（实际生效的键位 / 都占用了的原因） */
  let hotkey = $state<HotkeyStatus | null>(null);

  /** 现在在不在免打扰里（`prefs.quietUntil` 一变就重算；够用 —— 面板是临时开着的） */
  const quiet = $derived(prefs.quietUntil * 1000 > Date.now());

  function openPop() {
    // 0.5 小时步进显示（180 分钟 → 3）
    hours = Math.round((sanity.budgetMinutes / 60) * 2) / 2;
    openSettingsPanel();
    // C18：托盘菜单那边也能改静音 → 每次打开重读一次，面板状态别落后（round53 的教训）
    void loadPrefs();
    void refreshDataMode();
    void refreshHotkeys();
  }

  /**
   * round78（3.1b₂ · 设-01）：**每次打开都回到默认视图** —— 跳回第一组、「更多」折起、子区全收、
   * 「自定义…」收起。与 `栈-08` 同一个口径（不记忆面板位置：打开时看到的东西要可预测）。
   * 用 `$effect` 而不是写在 `openPop()` 里：段 2 的 `Ctrl+,` 快捷入口直接调
   * `openSettingsPanel()`，那条路也要吃到这套重置。
   */
  let prevOpen = false;
  $effect(() => {
    if (open && !prevOpen) {
      activeGroup = "theme";
      moreOpen = false;
      sub = {};
      customOpen = false;
    }
    prevOpen = open;
  });

  /** round66：读全局快捷键状态（失败不闹，ipc 层已弹 Toast） */
  async function refreshHotkeys() {
    try {
      hotkey = await hotkeyStatus();
    } catch {
      /* ipc 层已弹 Toast */
    }
  }

  function hotkeyStatusText(): string {
    if (!hotkey) return t("ui.sanity_settings.01");
    if (hotkey.active) return t("ui.sanity_settings.02", { active: hotkey.active });
    return t("ui.sanity_settings.03", { error: hotkey.error ?? t("ui.sanity_settings.95") });
  }

  /** 重试 = 再写一次开关（后端钩子会立刻重新试注册） + 重读状态 */
  async function retryHotkeys() {
    if (!(await saveFeature("hotkeys_enabled", true))) return;
    await refreshHotkeys();
  }

  /** round66（C12）：读便携模式状态（失败不闹：那一行显示「读取中…」，ipc 层已弹 Toast） */
  async function refreshDataMode() {
    try {
      dataMode = await getDataInfo();
    } catch {
      /* ipc 层已弹 Toast */
    }
  }

  function dataModeLabel(): string {
    if (!dataMode) return t("ui.sanity_settings.04");
    if (dataMode.fallback) return t("ui.sanity_settings.05");
    return dataMode.portable ? t("ui.sanity_settings.06") : t("ui.sanity_settings.07");
  }

  async function commitHours() {
    const ok = await saveBudgetHours(hours);
    if (!ok) hours = Math.round((sanity.budgetMinutes / 60) * 2) / 2; // 失败拉回原值（BJ 同款）
  }

  /**
   * round54（BQ）：写失败时把控件**强制对齐 store 的真值**。
   * 为什么要碰 DOM：失败时 store 没变，而 `checked={…}` 是**单向绑定**——
   * 源值不变 → Svelte 的 effect 不重跑 → 浏览器那一下点击留下的勾会留在新位置，
   * 看着像「已经改好了」（round44 的 BJ 只盖了输入框；这里是同一类）。
   */
  function align(el: HTMLInputElement | null | undefined, truth: boolean) {
    if (el) el.checked = truth;
  }

  /**
   * round79（78-03 顺带）：设置里的**打字类输入**统一吃 `Esc` = 回写真值 + 失焦（不关面板）。
   * 为什么要先回写再 blur：这些输入是 `onchange` 提交 —— 直接 blur 会把半截输入当 `change` 交上去；
   * 先把 DOM 写回真值，就算 blur 触发 `change`，提交的也是真值（与 store 一致 → 等于没改）。
   */
  function escRevert(e: KeyboardEvent, apply: (el: HTMLInputElement) => void) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation(); // 别让面板栈把它当成「关面板」
    const el = e.currentTarget as HTMLInputElement;
    apply(el);
    el.blur();
  }

  /** 理智值小时数的真值（与 `openPop` / `commitHours` 失败回退同一个算式） */
  const hoursTruth = () => Math.round((sanity.budgetMinutes / 60) * 2) / 2;

  /** round49：提醒开关（写失败把开关拨回去 —— ipc 层已弹 Toast） */
  async function toggleReminder(kind: "start" | "end", on: boolean, el: HTMLInputElement) {
    if (await setReminder(kind, on)) return;
    align(el, kind === "start" ? reminders.start : reminders.end);
  }

  /** round81（3.1c₁）：时间 / 日期格式 —— 写失败把控件拨回（与 `commitUiLocale` 同款口径） */
  async function commitTimeFormat(el: HTMLSelectElement) {
    const next = normalizeTimeFormat(el.value);
    if (await saveTimeFormat(next)) return;
    el.value = prefs.timeFormat;
  }

  async function commitDateFormat(el: HTMLSelectElement) {
    const next = normalizeDateFormat(el.value);
    if (await saveDateFormat(next)) return;
    el.value = prefs.dateFormat;
  }

  /** round87（3.3）：界面字体族 —— 写失败把控件拨回（与 `commitTimeFormat` 同款口径） */
  async function commitFontFamily(el: HTMLSelectElement) {
    const next = normalizeFontFamily(el.value);
    if (await saveFontFamily(next)) return;
    el.value = prefs.fontFamily;
  }

  /** round81（3.1c₁ · 宽-04）；round82（11.6）扩到 **18–64**：时间刻度（auto / 18–64 偶数）；写失败把控件拨回 */
  async function commitSlotHeight(el: HTMLSelectElement) {
    const next: SlotHeight = el.value === "auto" ? "auto" : (Number(el.value) as SlotHeight);
    if (await saveSlotHeight(next)) return;
    el.value = String(layout.slotHeight);
  }

  /** round81（3.1c₁ · 宽-05）：**复位布局** —— 无确认（可逆、不删数据；你 2026-10-06 拍）；
   *  成功/失败都给一条 toast（失败时 writeSetting 自己已弹过错误） */
  async function doResetLayout() {
    const ok = await resetLayout();
    if (ok) toast(t("ui.sanity_settings.171"));
  }

  /** C18（R49）：开始提醒的提前档位 */
  async function commitLead(el: HTMLSelectElement) {
    if (await saveRemindLead(Number(el.value))) return;
    el.value = String(prefs.remindLeadMinutes);
  }

  /** round67（6b P2-1）：周末开关 / 键位提示 —— 写失败把控件拨回（BJ / BQ 同款口径） */
  async function saveWeekendVisible(visible: boolean, el: HTMLInputElement) {
    if (await saveWeekendHidden(!visible)) return;
    align(el, !layout.weekendHidden);
  }

  async function commitHintBarMode(el: HTMLSelectElement) {
    const mode = el.value as HintBarMode;
    if (await saveHintBarMode(mode)) return;
    el.value = layout.hintBarMode;
  }

  /** round76（3.1a）：外观五件 —— 写失败一律把控件拨回去（BJ / BQ 同款口径）
   *  round78（3.1b₂）：密度 / 深浅色 / 配色三处换成**预览选择器**（`pick*`），这三条下拉版删了 */
  async function toggleLayerBarColor(on: boolean, el: HTMLInputElement) {
    if (await saveLayerBarColor(on)) return;
    el.checked = prefs.layerBarColor;
  }

  async function toggleCategoryBar(on: boolean, el: HTMLInputElement) {
    if (await saveCategoryBar(on)) return;
    el.checked = prefs.categoryBar;
  }

  /** round78（3.1b₂ · 设-01）：现在线开关（写失败把勾拨回） */
  async function toggleNowLine(on: boolean, el: HTMLInputElement) {
    if (await saveNowLine(on)) return;
    align(el, prefs.nowLine);
  }

  /** round80（79-02）：模板预览开关 —— 与现在线同一套写失败口径（失败把复选框拨回真值） */
  async function toggleTemplatePreview(on: boolean, el: HTMLInputElement) {
    if (await saveTemplatePreview(on)) return;
    align(el, prefs.templatePreview);
  }

  /**
   * 设-02：三处**预览选择器**（真组件渲染）—— 与旧的下拉版 `commit*` 同一套写失败口径：
   * 按钮态由 `prefs.*` 决定（store 没变 = 按钮不变），所以失败无需额外拨回。
   */
  async function pickPalette(next: Palette) {
    await savePalette(next);
  }

  async function pickTheme(next: Theme) {
    await saveTheme(next);
  }

  /** round82（3.1c₂ · 淡-11）：夜间时段 —— 空值 / 非法把控件拨回；写失败也拨回（BJ 同款） */
  async function commitNightTime(which: "start" | "end", el: HTMLInputElement) {
    const fallback = which === "start" ? prefs.nightStart : prefs.nightEnd;
    const text = normalizeHHMM(el.value);
    if (!text) {
      el.value = fallback;
      return;
    }
    const ok = which === "start" ? await saveNightStart(text) : await saveNightEnd(text);
    if (!ok) el.value = fallback;
  }

  /** round82（淡-07）：夜间淡化开关（写失败把勾拨回） */
  async function toggleNightDim(on: boolean, el: HTMLInputElement) {
    if (await saveNightDim(on)) return;
    el.checked = prefs.nightDim;
  }

  async function pickDensity(next: Density) {
    await saveDensity(next);
  }

  async function pickIconSet(next: IconSet) {
    await saveIconSet(next);
  }

  /** round78（3.1b₂ · 设-08/键-04）：键盘总开关（单键全受它管）—— 写失败把勾拨回 */
  async function toggleKeyboard(on: boolean, el: HTMLInputElement) {
    if (await saveFeature("keyboard_enabled", on)) return;
    align(el, featureOn("keyboard_enabled"));
  }

  /** round77（3.1b）：切块内第二行 —— 同上 */
  async function commitBlockSecondLine(el: HTMLSelectElement) {
    const next = normalizeSecondLine(el.value);
    if (await saveBlockSecondLine(next)) return;
    el.value = prefs.blockSecondLine;
  }

  /** round74（3.0b₂）：切语言 —— 写失败把下拉拨回去（控件别讴谎；语言状态由 store 才改） */
  async function commitUiLocale(el: HTMLSelectElement) {
    const next = normalizeLocaleChoice(el.value);
    if (await saveUiLocale(next)) return;
    el.value = prefs.uiLocale;
  }

  /** C18（R41）：暂停提醒（30 分钟 / 1 小时 / 到明早）—— 失败不用拨（按钮没有状态，store 没变就是没生效） */
  async function pauseFor(kind: "30m" | "1h" | "morning") {
    if (kind === "30m") await quietForMinutes(30);
    else if (kind === "1h") await quietForMinutes(60);
    else await quietUntilMorning();
  }

  /** C18（R41）：「自定义…」—— 本机日期时间 → 静音到那一刻 */
  async function commitCustom() {
    const ms = new Date(customValue).getTime();
    if (!Number.isFinite(ms) || ms <= Date.now()) {
      toast(t("ui.sanity_settings.08"));
      return;
    }
    if (await quietUntilAt(ms)) customOpen = false;
  }

  /** C18（R41）：改「到明早」的时刻（写失败把输入框拉回真值） */
  async function commitQuietMorning(el: HTMLInputElement) {
    if (await saveQuietMorning(el.value)) return;
    el.value = prefs.quietMorning;
  }

  /** C18：计划任务开关（写失败把勾拨回） */
  async function toggleScheduler(on: boolean, el: HTMLInputElement) {
    if (await saveSchedulerEnabled(on)) return;
    align(el, prefs.schedulerEnabled);
  }

  /** `datetime-local` 需要本地 `YYYY-MM-DDTHH:MM`（默认给「一小时后」） */
  function localInputValue(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function openCustom() {
    if (!customOpen) customValue = localInputValue(new Date(Date.now() + 3600_000));
    customOpen = !customOpen;
  }

  /** C7（round52）+ round57（0.13.0）：复盘到点的三个键（失败重新读一次设置，并把控件对齐真值） */
  async function commitRemind(
    action: "open" | "hint" | "off",
    day: "sun" | "mon",
    time: string,
    anchor: HTMLElement,
  ) {
    if (await saveRemindSettings(action, day, time)) return;
    await loadRemindSettings();
    const pop = anchor.closest(".sanity-pop");
    if (!pop) return;
    const act = pop.querySelector<HTMLSelectElement>(".remind-action");
    const sel = pop.querySelector<HTMLSelectElement>(".remind-day");
    const inp = pop.querySelector<HTMLInputElement>(".remind-time");
    if (act) act.value = remindSettings.action;
    if (sel) sel.value = remindSettings.day;
    if (inp) inp.value = remindSettings.time;
  }

  /** round62（C14）：导出备份 —— 另存为 → `VACUUM INTO` → Toast 把路径与大小摆出来 */
  async function exportBackupFile() {
    const path = await saveDialog({
      title: t("ui.sanity_settings.09"),
      defaultPath: backupFileName(new Date()),
      filters: [{ name: t("ui.sanity_settings.10"), extensions: ["db"] }],
    });
    if (!path) return; // 用户取消
    try {
      const info = await exportBackup(path);
      toast(t("ui.sanity_settings.11", { bytes: formatBytes(info.bytes), path: info.path }));
    } catch {
      /* 失败已由 ipc/call.ts 弹 Toast */
    }
  }

  /** round64（C11）：导出全部排程为 `.ics` —— 另存为 → 后端写文件 → Toast 把条数与路径摆出来 */
  async function exportIcsFile() {
    const path = await saveDialog({
      title: t("ui.sanity_settings.12"),
      defaultPath: icsFileName(new Date()),
      filters: [{ name: t("ui.sanity_settings.13"), extensions: ["ics"] }],
    });
    if (!path) return; // 用户取消
    try {
      const info = await exportIcs(path);
      toast(t("ui.sanity_settings.14", { events: info.events, bytes: formatBytes(info.bytes), path: info.path }));
    } catch {
      /* 失败已由 ipc/call.ts 弹 Toast */
    }
  }

  /** round62（C14）：从备份恢复 —— 选文件（系统对话框）→ 确认（应用内面板，round80 · 79-01）→ 后端 staging → 应用自动重启。
      （确认必须显式：恢复会覆盖当前数据，没有 Ctrl+Z 能撤） */
  async function restoreFromBackup() {
    const picked = await openDialog({
      title: t("ui.sanity_settings.15"),
      multiple: false,
      directory: false,
      filters: [{ name: t("ui.sanity_settings.16"), extensions: ["db"] }],
    });
    if (typeof picked !== "string") return; // 取消（multiple:false 时不会是数组）
    const ok = await confirmDanger({
      body: t("ui.sanity_settings.17"),
      title: t("ui.sanity_settings.18"),
      ok: t("ui.sanity_settings.19"),
      cancel: t("ui.sanity_settings.20"),
    });
    if (!ok) return;
    try {
      await importBackup(picked); // 成功的话进程会重启，等不到 resolve
    } catch {
      /* 校验失败等已由 ipc/call.ts 弹 Toast */
    }
  }

  /** round79（78-01）：**恢复默认设置** —— 二次确认（应用内确认面板，round80 · 79-01）→ 新命令
   *  （只删设置键、**保留界面语言**、不碰数据；后端顺带回放托盘/快捷键/主题那些副作用）
   *  → 重读三份 store，界面立刻回到默认。不做撤销（你 2026-10-06 拍板：有二次确认就不叠撤销）。 */
  async function resetToDefaults() {
    const ok = await confirmDanger({
      body: t("ui.sanity_settings.151"),
      title: t("ui.sanity_settings.152"),
      ok: t("ui.sanity_settings.153"),
      cancel: t("ui.sanity_settings.154"),
    });
    if (!ok) return;
    try {
      await resetSettings();
    } catch {
      return; // ipc 层已弹 Toast
    }
    // round79（6b 二轮 P2）：**真读回来了才说成功** —— 三份 store 的读失败只在 console 留痕，
    // 若无条件弹「设置已恢复默认值」，界面会留着你刚改的那套而提示说已经回默认（界面在骗人）。
    const reloaded =
      (await loadPrefs()) && (await loadLayoutSettings()) && (await loadRemindSettings());
    void refreshDataMode();
    void loadAchievements(); // 成就开关可能刚被拨回「开」
    if (reloaded) toast(t("ui.sanity_settings.155"));
  }

  async function toggle(on: boolean, el: HTMLInputElement) {
    // round54 BQ：失败时赋同一个值不会让 Svelte 重跑 → 必须强制对齐 DOM
    if (!(await setSanityEnabled(on))) align(el, sanity.enabled);
  }

  /** round64（C10）：功能开关 —— 写失败把勾拨回（与上面 `toggle` 同一套 BQ 口径） */
  async function toggleFeature(f: FeatureMeta, on: boolean, el: HTMLInputElement) {
    if (f.boolean) {
      if (!(await saveFeature(f.key, on))) {
        align(el, featureOn(f.key));
      } else if (f.key === "drift_enabled" && !on) {
        // round64.1：关掉漂流时把开着的漂流卡一并收起（靠按钮隐藏不够 ——
        // 卡片还开着、再开开关会“复活”那张旧卡）
        closeDrift();
      }
    } else if (!(await saveTemplateSuggest({ ...prefs.templateSuggest, enabled: on }))) {
      align(el, prefs.templateSuggest.enabled);
    }
  }

  /** 模板建议的门限（天 / 次数）：非法或写失败就把输入框拨回当前值 */
  async function commitTemplateThreshold(el: HTMLInputElement, which: "days" | "done") {
    const next = { ...prefs.templateSuggest, [which]: Number(el.value) };
    if (!(await saveTemplateSuggest(next))) {
      el.value = String(prefs.templateSuggest[which]);
    }
  }

  /** round68（19.1）：成就两键 —— 写失败把勾拨回（同一套 BQ 口径） */
  async function toggleAchievements(on: boolean, el: HTMLInputElement) {
    if (!(await saveAchievementsEnabled(on))) {
      align(el, prefs.achievementsEnabled);
    } else if (on) {
      void loadAchievements(); // 刚打开 → 把数字刷新一下
    }
  }

  async function toggleAchievementToast(on: boolean, el: HTMLInputElement) {
    if (!(await saveAchievementToast(on))) align(el, prefs.achievementToast);
  }

  /** round64.1（验收 #4 复核）：把渐进提示重新打开（设置 → 引导与教程） */
  async function reopenHints() {
    if (featureOn("hints_enabled")) return;
    await saveFeature("hints_enabled", true);
  }

  // 点外面 / 按 Esc / 窗口尺寸变了 → 收起（与 CategoryPicker 同一套口径）
  $effect(() => {
    const onDown = (e: PointerEvent) => {
      if (!open) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".sanity-pop") || t?.closest?.(".sanity-gear")) return;
      closeSettingsPanel();
    };
    const onResize = () => closeSettingsPanel();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onResize);
    };
  });

  /** C18：键位说明的数据在 `utils/keyboard-help.ts`（组件里的常量单测不到；那边有与
   *  `resolveKey` 的一致性测试） */
</script>

<div class="wrap">
  <button
    type="button"
    class="sanity-gear"
    class:on={open}
    title={t("ui.sanity_settings.21")}
    aria-expanded={open}
    onclick={() => (open ? closeSettingsPanel() : openPop())}><Icon name="settings" size={16} /></button
  >

  {#if open}
    <!-- round78（3.1b₂ · 栈-03/栈-04）：设置从「贴齿轮的非模态弹层」升级成**覆盖面板** ——
         遮罩 + 焦点陷阱 + `Esc` 只关一层（你 2026-10-06 拍板；样张 §A5）。 -->
    <div
      class="settings-backdrop overlay-backdrop"
      tabindex="-1"
      aria-hidden="true"
      onclick={closeSettingsPanel}
    ></div>
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role（`section role="dialog"` 是 ARIA 认可写法，Svelte 的检查器偏严） -->
    <section
      class="sanity-pop overlay-panel mid"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      use:focusTrap={{ active: open }}
    >
      <header class="pop-head">
        <h2 class="pop-title" id="settings-title">{t("ui.sanity_settings.22")}</h2>
        <button
          type="button"
          class="close"
          title={t("ui.sanity_settings.107")}
          onclick={closeSettingsPanel}><Icon name="close" size={16} /></button
        >
      </header>

      <!-- 设-01：分区导航（组名一行、可点跳转；窄窗横排可滚） -->
      <nav class="pop-nav" aria-label={t("ui.sanity_settings.147")}>
        {#each SETTINGS_GROUPS as g (g.id)}
          <button
            type="button"
            class="nav-btn"
            class:on={activeGroup === g.id}
            data-group={g.id}
            onclick={() => jumpTo(g.id)}>{t(g.label)}</button
          >
        {/each}
      </nav>

      <div class="pop-body" bind:this={bodyEl} use:scrollableRegion={{ label: t("ui.sanity_settings.22") }}>
        <!-- ===================== ① 主题与颜色 ===================== -->
        <section class="group" id="settings-group-theme">
          <h3 class="sec">{t("ui.sanity_settings.140")}</h3>

          <!-- 设-02：配色预览（真三色板 —— 值域与 tokens.css 的亮色块由预览断言逐值核对） -->
          <div class="row">
            <span>{t("ui.sanity_settings.125")}</span>
            <div class="palettes ui-palette" role="radiogroup" aria-label={t("ui.sanity_settings.125")}>
              {#each PALETTES as p (p)}
                <button
                  type="button"
                  class="palette"
                  class:on={prefs.uiPalette === p}
                  data-value={p}
                  role="radio"
                  aria-checked={prefs.uiPalette === p}
                  onclick={() => void pickPalette(p)}
                >
                  <!-- round80（79-02）：迷你界面小样（亮/暗各一份，CSS 按当前深浅色只显一份） -->
                  <span class="thumb" aria-hidden="true">
                    {#snippet art(mode: "light" | "dark")}
                      {@const pv = PALETTE_PREVIEW[`${p}-${mode}`]}
                      <span class="art art-{mode}" style="background:{pv.bg}">
                        <span class="side">
                          <i style="background:{pv.accent}"></i>
                          <i style="background:{pv.ink}"></i>
                          <i style="background:{pv.ink}"></i>
                        </span>
                        <span class="main" style="background:{pv.card}">
                          <i class="line" style="background:{pv.ink}"></i>
                          <i class="blk" style="background:{pv.fill};border-color:{pv.line}"
                            ><b style="background:{pv.accent}"></b></i
                          >
                          <i class="blk" style="background:{pv.fill};border-color:{pv.line}"></i>
                        </span>
                      </span>
                    {/snippet}
                    {@render art("light")}
                    {@render art("dark")}
                  </span>
                  <span class="pname" class:on={prefs.uiPalette === p}>{t(PALETTE_LABEL[p])}</span>
                </button>
              {/each}
            </div>
          </div>
          <p class="hint">{t("ui.sanity_settings.129")}</p>

          <!-- 深浅色：三档分段控件 -->
          <div class="row">
            <span>{t("ui.sanity_settings.120")}</span>
            <div class="seg ui-theme" role="radiogroup" aria-label={t("ui.sanity_settings.120")}>
              {#each THEMES as th (th)}
                <button
                  type="button"
                  class="seg-btn"
                  class:on={prefs.uiTheme === th}
                  data-value={th}
                  role="radio"
                  aria-checked={prefs.uiTheme === th}
                  onclick={() => void pickTheme(th)}>{t(THEME_LABEL[th])}</button
                >
              {/each}
            </div>
          </div>
          <p class="hint">{t("ui.sanity_settings.124")}</p>

          <!-- round82（3.1c₂ · 淡-04 / 淡-11）：夜间时段（第四档主题与淡化带共用一对起止；跨天就写 22:00 → 06:00） -->
          <label class="row">
            <span>{t("ui.sanity_settings.174")}</span>
            <span class="night-hours">
              <input
                type="time"
                class="night-start"
                value={prefs.nightStart}
                aria-label={t("ui.sanity_settings.174")}
                onchange={(e) => void commitNightTime("start", e.currentTarget)}
              />
              <span aria-hidden="true">→</span>
              <input
                type="time"
                class="night-end"
                value={prefs.nightEnd}
                aria-label={t("ui.sanity_settings.174")}
                onchange={(e) => void commitNightTime("end", e.currentTarget)}
              />
            </span>
          </label>
          <p class="hint">{t("ui.sanity_settings.175")}</p>
          <label class="row switch">
            <input
              type="checkbox"
              class="night-dim"
              checked={prefs.nightDim}
              onchange={(e) => void toggleNightDim(e.currentTarget.checked, e.currentTarget)}
            />
            <span>{t("ui.sanity_settings.176")}</span>
          </label>
          <p class="hint">{t("ui.sanity_settings.177")}</p>

          <!-- 图标集：五套迷你预览（同一枚语义图标 × 五套，真 SVG） -->
          <div class="row">
            <span>{t("ui.sanity_settings.134")}</span>
            <div class="icon-sets icon-set" role="radiogroup" aria-label={t("ui.sanity_settings.134")}>
              {#each ICON_SETS as s (s)}
                <button
                  type="button"
                  class="icon-set-btn"
                  class:on={prefs.iconSet === s}
                  data-value={s}
                  role="radio"
                  aria-checked={prefs.iconSet === s}
                  title={ICON_SET_LABEL[s]}
                  aria-label={ICON_SET_LABEL[s]}
                  onclick={() => void pickIconSet(s)}
                >
                  <span class="mini" aria-hidden="true">
                    {#each ICON_PREVIEW as n (n)}
                      {@const ic = iconData(s, n)}
                      <svg
                        width="14"
                        height="14"
                        viewBox={ic.viewBox}
                        fill={ic.fill}
                        stroke={ic.stroke}
                        stroke-width={ic.strokeWidth > 0 ? ic.strokeWidth : undefined}
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        >{#each ic.paths as p (p.d)}<path
                            d={p.d}
                            fill={p.fill ?? ic.fill}
                            stroke={p.stroke ?? ic.stroke}
                            stroke-width={p.strokeWidth ?? (ic.strokeWidth > 0 ? ic.strokeWidth : undefined)}
                          />{/each}</svg
                      >
                    {/each}
                  </span>
                  <span class="iname">{ICON_SET_LABEL[s]}</span>
                </button>
              {/each}
            </div>
          </div>
          <p class="hint">{t("ui.sanity_settings.135")}</p>

          <label class="row switch">
            <input
              type="checkbox"
              class="layer-bar-color"
              checked={prefs.layerBarColor}
              onchange={(e) => void toggleLayerBarColor(e.currentTarget.checked, e.currentTarget)}
            />
            <span>{t("ui.sanity_settings.130")}</span>
          </label>
          <p class="hint">{t("ui.sanity_settings.131")}</p>
          <label class="row switch">
            <input
              type="checkbox"
              class="category-bar"
              checked={prefs.categoryBar}
              onchange={(e) => void toggleCategoryBar(e.currentTarget.checked, e.currentTarget)}
            />
            <span>{t("ui.sanity_settings.132")}</span>
          </label>
          <p class="hint">{t("ui.sanity_settings.133")}</p>

          <!-- 语言：放本组末行（你 2026-10-06 拍板；不塞进「更多」） -->
          <label class="row">
            <span>{t("ui.sanity_settings.112")}</span>
            <select class="lang" value={prefs.uiLocale} onchange={(e) => void commitUiLocale(e.currentTarget)}>
              <!-- round81（3.1c₁ · 深-03）：跟随系统（默认）；选项里标出**实际解析**成哪种语言，不让人猜 -->
              <option value="system">{t("ui.sanity_settings.172", { locale: sysLocaleLabel })}</option>
              <option value="zh">{t("ui.sanity_settings.113")}</option>
              <option value="en">{t("ui.sanity_settings.114")}</option>
            </select>
          </label>
        </section>

        <!-- ===================== ② 字号与密度 ===================== -->
        <section class="group" id="settings-group-density">
          <h3 class="sec">{t("ui.sanity_settings.141")}</h3>
          <!-- 设-02：密度预览（三张带样本行的小卡；行高/字号取 DENSITY_SCALE —— 与 tokens.css 由断言核对） -->
          <div class="row">
            <span>{t("ui.sanity_settings.115")}</span>
            <div class="densities text-density" role="radiogroup" aria-label={t("ui.sanity_settings.115")}>
              {#each DENSITIES as d (d)}
                <button
                  type="button"
                  class="density"
                  class:on={prefs.uiDensity === d}
                  data-value={d}
                  role="radio"
                  aria-checked={prefs.uiDensity === d}
                  onclick={() => void pickDensity(d)}
                >
                  <span
                    class="dsample"
                    aria-hidden="true"
                    style="height:{DENSITY_SCALE[d].rowHeight}px"
                    >Aa 123</span
                  >
                  <span class="dname">{t(DENSITY_LABEL[d])}</span>
                  <span class="dmeta">{t("ui.sanity_settings.149", { px: DENSITY_SCALE[d].rowHeight })}</span>
                </button>
              {/each}
            </div>
          </div>
          <p class="hint">{t("ui.sanity_settings.119")}</p>

          <!-- round87（3.3 字体方案）：界面字体族（五档系统字体）—— 拉丁保持 Segoe，只把中文交给所选族 -->
          <label class="row">
            <span>{t("ui.sanity_settings.187")}</span>
            <select
              class="font-family"
              value={prefs.fontFamily}
              onchange={(e) => void commitFontFamily(e.currentTarget)}
            >
              {#each FONT_FAMILIES as f (f)}
                <option value={f}>{t(FONT_LABEL[f])}</option>
              {/each}
            </select>
          </label>
        </section>

        <!-- ===================== ③ 时间轴 ===================== -->
        <section class="group" id="settings-group-timeline">
          <h3 class="sec">{t("ui.sanity_settings.142")}</h3>
          <!-- round81（3.1c₁ · 时-01…11）：时间 / 日期格式 —— 选项文字带**真实样例**（设-02 口径） -->
          <label class="row">
            <span>{t("ui.sanity_settings.158")}</span>
            <select
              class="time-format"
              value={prefs.timeFormat}
              onchange={(e) => void commitTimeFormat(e.currentTarget)}
            >
              <option value="system">{t("ui.sanity_settings.159")} · {sampleClock("system")}</option>
              <option value="h24">{t("ui.sanity_settings.160")} · {sampleClock("h24")}</option>
              <option value="h12">{t("ui.sanity_settings.161")} · {sampleClock("h12")}</option>
            </select>
          </label>
          <label class="row">
            <span>{t("ui.sanity_settings.162")}</span>
            <select
              class="date-format"
              value={prefs.dateFormat}
              onchange={(e) => void commitDateFormat(e.currentTarget)}
            >
              <option value="system">{t("ui.sanity_settings.159")} · {sampleDate("system")}</option>
              <option value="dash">{t("ui.sanity_settings.163")} · {sampleDate("dash")}</option>
              <option value="slash">{t("ui.sanity_settings.164")} · {sampleDate("slash")}</option>
              <option value="long">{t("ui.sanity_settings.165")} · {sampleDate("long")}</option>
            </select>
          </label>
          <p class="hint">{t("ui.sanity_settings.166")}</p>
          <label class="row">
            <span>{t("ui.sanity_settings.136")}</span>
            <select
              class="block-second-line"
              value={prefs.blockSecondLine}
              onchange={(e) => void commitBlockSecondLine(e.currentTarget)}
            >
              <option value="time">{t("ui.sanity_settings.137")}</option>
              <option value="remaining">{t("ui.sanity_settings.138")}</option>
            </select>
          </label>
          <p class="hint">{t("ui.sanity_settings.139")}</p>
          <label class="row switch">
            <input
              type="checkbox"
              checked={!layout.weekendHidden}
              onchange={(e) => void saveWeekendVisible(e.currentTarget.checked, e.currentTarget)}
            />
            <span>{t("ui.sanity_settings.60")}</span>
          </label>
          <p class="hint">{t("ui.sanity_settings.61")}</p>
          <label class="row switch">
            <input
              type="checkbox"
              class="now-line"
              checked={prefs.nowLine}
              onchange={(e) => void toggleNowLine(e.currentTarget.checked, e.currentTarget)}
            />
            <span>{t("ui.sanity_settings.145")}</span>
          </label>
          <p class="hint">{t("ui.sanity_settings.146")}</p>
          <!-- round80（79-02）：模板面板旁的迷你周视图（默认开；关掉 = 旧行为只列列表） -->
          <label class="row switch">
            <input
              type="checkbox"
              class="template-preview"
              checked={prefs.templatePreview}
              onchange={(e) => void toggleTemplatePreview(e.currentTarget.checked, e.currentTarget)}
            />
            <span>{t("ui.sanity_settings.156")}</span>
          </label>
          <p class="hint">{t("ui.sanity_settings.157")}</p>
          <!-- round81（3.1c₁ · 宽-04）：时间刻度档位（auto = 跟密度；手动值优先，宽-10） -->
          <label class="row">
            <span>{t("ui.sanity_settings.167")}</span>
            <select
              class="slot-height"
              value={String(layout.slotHeight)}
              onchange={(e) => void commitSlotHeight(e.currentTarget)}
            >
              <option value="auto">{t("ui.sanity_settings.168")} · {slotHeightEffective()}px</option>
              {#each SLOT_HEIGHTS as px (px)}
                <option value={String(px)}>{px}px</option>
              {/each}
            </select>
          </label>
          <p class="hint">{t("ui.sanity_settings.170")}</p>
          <div class="backup-row">
            <button type="button" class="reset-layout" onclick={() => void doResetLayout()}
              >{t("ui.sanity_settings.169")}</button
            >
          </div>
        </section>

        <!-- ===================== ④ 提醒与控制 ===================== -->
        <section class="group" id="settings-group-alert">
          <h3 class="sec">{t("ui.sanity_settings.143")}</h3>
          <label class="row switch">
            <input
              type="checkbox"
              checked={reminders.start}
              onchange={(e) => void toggleReminder("start", e.currentTarget.checked, e.currentTarget)}
            />
            <span>{t("ui.sanity_settings.31")}</span>
            <span class="sub">{t("ui.sanity_settings.32")}</span>
            <select class="lead" value={String(prefs.remindLeadMinutes)} onchange={(e) => void commitLead(e.currentTarget)}>
              {#each REMIND_LEAD_CHOICES as minutes (minutes)}
                <option value={String(minutes)}>{minutes === 0 ? t("ui.sanity_settings.109") : t("ui.sanity_settings.110", { minutes: minutes })}</option>
              {/each}
            </select>
          </label>
          <label class="row switch">
            <input
              type="checkbox"
              checked={reminders.end}
              onchange={(e) => void toggleReminder("end", e.currentTarget.checked, e.currentTarget)}
            />
            <span>{t("ui.sanity_settings.33")}</span>
          </label>

          <label class="row">
            <span>{t("ui.sanity_settings.34")}</span>
            <div class="ctrl-line">
              <select
                class="remind-day"
                value={remindSettings.day}
                onchange={(e) =>
                  void commitRemind(
                    remindSettings.action,
                    e.currentTarget.value === "mon" ? "mon" : "sun",
                    remindSettings.time,
                    e.currentTarget,
                  )}
              >
                <option value="sun">{t("ui.sanity_settings.35")}</option>
                <option value="mon">{t("ui.sanity_settings.36")}</option>
              </select>
              <input
                class="remind-time"
                type="time"
                value={remindSettings.time}
                onchange={(e) =>
                  void commitRemind(
                    remindSettings.action,
                    remindSettings.day,
                    e.currentTarget.value,
                    e.currentTarget,
                  )}
                onkeydown={(e) => escRevert(e, (el) => (el.value = remindSettings.time))}
              />
              <select
                class="remind-action"
                value={remindSettings.action}
                onchange={(e) =>
                  void commitRemind(
                    e.currentTarget.value === "open"
                      ? "open"
                      : e.currentTarget.value === "off"
                        ? "off"
                        : "hint",
                    remindSettings.day,
                    remindSettings.time,
                    e.currentTarget,
                  )}
              >
                <option value="hint">{t("ui.sanity_settings.38")}</option>
                <option value="open">{t("ui.sanity_settings.39")}</option>
                <option value="off">{t("ui.sanity_settings.40")}</option>
              </select>
            </div>
            <span class="sub">{t("ui.sanity_settings.37")}</span>
          </label>

          <div class="quiet-row">
            <span>{t("ui.sanity_settings.41")}</span>
            <button type="button" class="mini quiet-30" onclick={() => void pauseFor("30m")}
              >{t("ui.sanity_settings.42", { QUIET_PRESET_MINUTES: QUIET_PRESET_MINUTES[0] })}</button
            >
            <button type="button" class="mini quiet-60" onclick={() => void pauseFor("1h")}
              >{t("ui.sanity_settings.43", { QUIET_PRESET_MINUTES: QUIET_PRESET_MINUTES[1] / 60 })}</button
            >
            <button type="button" class="mini quiet-morning-btn" onclick={() => void pauseFor("morning")}
              >{t("ui.sanity_settings.44", { quietMorning: prefs.quietMorning })}</button
            >
            <button type="button" class="mini quiet-custom-btn" onclick={openCustom}>{t("ui.sanity_settings.102")}</button>
          </div>
          {#if customOpen}
            <div class="row">
              <input class="quiet-custom" type="datetime-local" bind:value={customValue} min={localInputValue(new Date())}
                onkeydown={(e) => escRevert(e, () => (customOpen = false))} />
              <button type="button" class="mini" onclick={() => void commitCustom()}>{t("ui.sanity_settings.103")}</button>
            </div>
          {/if}
          {#if quiet}
            <p class="quiet-state" data-quiet-state>
              {t("ui.sanity_settings.45", { quietUntil: formatQuietUntil(prefs.quietUntil * 1000) })}
              <button type="button" class="link quiet-resume" onclick={() => void clearQuiet()}>{t("ui.sanity_settings.104")}</button>
            </p>
          {/if}
          <label class="row">
            <span class="sub">{t("ui.sanity_settings.46")}</span>
            <input
              class="quiet-morning"
              type="time"
              value={prefs.quietMorning}
              onchange={(e) => void commitQuietMorning(e.currentTarget)}
              onkeydown={(e) => escRevert(e, (el) => (el.value = prefs.quietMorning))}
            />
            <span class="sub">{t("ui.sanity_settings.47")}</span>
          </label>

          <label class="row">
            <span>{t("ui.sanity_settings.62")}</span>
            <select
              class="hint-mode"
              value={layout.hintBarMode}
              onchange={(e) => void commitHintBarMode(e.currentTarget)}
            >
              <option value="always">{t("ui.sanity_settings.63")}</option>
              <option value="hidden">{t("ui.sanity_settings.64")}</option>
            </select>
          </label>
          <p class="hint">{t("ui.sanity_settings.65")}</p>
          <!-- round80（78-04）：键盘开关从「更多 → 键位说明」上移到本组（与「键位提示」相邻）；
               round83（§8.2）：原来上下两个入口（`快捷键…` 只读表 + `改键位…` 编辑器）**合并成一个**
               —— 同一个面板：上面是全部键位（只读），下面可改键位（你 2026-10-08 拍 A）。 -->
          <div class="row">
            <button
              type="button"
              class="gf keymap-open"
              title={t("ui.keymap_panel.01")}
              onclick={openKeymapPanel}>{t("ui.keymap_panel.01")}…</button
            >
          </div>
          <label class="row switch">
            <input
              type="checkbox"
              class="keyboard-switch"
              checked={featureOn("keyboard_enabled")}
              onchange={(e) => void toggleKeyboard(e.currentTarget.checked, e.currentTarget)}
            />
            <span>{t("msg.features.25")}</span>
          </label>
          <p class="hint">{t("msg.features.26")}</p>
        </section>

        <!-- ===================== ⑤ 更多（低频区 · 默认收起） ===================== -->
        <section class="group" id="settings-group-more">
          <h3 class="sec">{t("ui.sanity_settings.144")}</h3>
          <button
            type="button"
            class="info more-toggle"
            class:on={moreOpen}
            aria-expanded={moreOpen}
            onclick={() => (moreOpen = !moreOpen)}
            >{moreOpen ? `▾ ${t("ui.sanity_settings.98")}` : `▸ ${t("ui.sanity_settings.99", { n: 6 })}`}</button
          >
          {#if moreOpen}
            <!-- 数据 -->
            <div class="sub-acc">
              <button
                type="button"
                class="info sub-toggle data-toggle"
                class:on={subOpen("data")}
                aria-expanded={subOpen("data")}
                onclick={() => toggleSub("data")}
                >{subOpen("data") ? "▾" : "▸"} {t("ui.sanity_settings.72")}</button
              >
              {#if subOpen("data")}
                <div class="backup-row">
                  <button type="button" class="backup" onclick={() => void exportBackupFile()}
                    >{t("ui.sanity_settings.73")}</button
                  >
                  <button type="button" class="backup" onclick={() => void restoreFromBackup()}
                    >{t("ui.sanity_settings.74")}</button
                  >
                </div>
                <div class="backup-row">
                  <button type="button" class="backup ics-export" onclick={() => void exportIcsFile()}
                    >{t("ui.sanity_settings.75")}</button
                  >
                </div>
                <p class="hint">{t("ui.sanity_settings.76")}<b>{t("ui.sanity_settings.77")}</b>{t("ui.sanity_settings.78")}</p>
                <div class="backup-row">
                  <button type="button" class="backup portable-open" onclick={openDataSwitch}
                    >{t("ui.sanity_settings.79")}</button
                  >
                </div>
                <p class="hint">
                  <RichText k="ui.sanity_settings.80" p={{ mode: dataModeLabel() }} />
                </p>
                {#if dataMode?.note}
                  <p class="hint portable-note">{dataMode.note}</p>
                {/if}
                <!-- round79（78-01）：恢复默认设置 —— 只重置设置键（**语言保留**），数据一行不动 -->
                <div class="backup-row">
                  <button
                    type="button"
                    class="danger-action reset-settings"
                    onclick={() => void resetToDefaults()}>{t("ui.sanity_settings.150")}</button
                  >
                </div>
                <p class="hint">{t("ui.sanity_settings.151")}</p>
              {/if}
            </div>

            <!-- 功能开关（15 项） -->
            <div class="sub-acc">
              <button
                type="button"
                class="info sub-toggle features-toggle"
                class:on={subOpen("features")}
                aria-expanded={subOpen("features")}
                onclick={() => toggleSub("features")}
                >{subOpen("features") ? "▾" : "▸"} {t("ui.sanity_settings.85")}</button
              >
              {#if subOpen("features")}
                {#each FEATURES as f (f.key)}
                  <label class="row switch feature-row" title={f.off}>
                    <input
                      type="checkbox"
                      checked={f.boolean ? featureOn(f.key) : prefs.templateSuggest.enabled}
                      onchange={(e) => void toggleFeature(f, e.currentTarget.checked, e.currentTarget)}
                    />
                    <span>{f.label}</span>
                    <span class="tags"
                      >{#each f.tags as tag (tag)}<span class="tag">{t(FEATURE_TAG_KEY[tag])}</span>{/each}</span
                    >
                  </label>
                  {#if f.key === "hotkeys_enabled" && featureOn("hotkeys_enabled")}
                    <p class="hint hotkey-state" data-hotkey-state>
                      {hotkeyStatusText()}
                      {#if hotkey?.error}
                        <button type="button" class="link" onclick={() => void retryHotkeys()}>{t("ui.sanity_settings.105")}</button>
                      {/if}
                    </p>
                  {/if}
                  {#if f.key === "template_suggest" && prefs.templateSuggest.enabled}
                    <div class="row feature-thresholds">
                      <span class="sub">{t("ui.sanity_settings.87")}</span>
                      <input
                        class="num days"
                        type="number"
                        min="1"
                        max="365"
                        step="1"
                        value={prefs.templateSuggest.days}
                        onchange={(e) => void commitTemplateThreshold(e.currentTarget, "days")}
                        onkeydown={(e) =>
                          escRevert(e, (el) => (el.value = String(prefs.templateSuggest.days)))}
                      />
                      <span class="sub">{t("ui.sanity_settings.88")}</span>
                      <input
                        class="num done"
                        type="number"
                        min="0"
                        max="1000"
                        step="1"
                        value={prefs.templateSuggest.done}
                        onchange={(e) => void commitTemplateThreshold(e.currentTarget, "done")}
                        onkeydown={(e) =>
                          escRevert(e, (el) => (el.value = String(prefs.templateSuggest.done)))}
                      />
                      <span class="sub">{t("ui.sanity_settings.89")}</span>
                    </div>
                  {/if}
                {/each}
                <p class="hint">{t("ui.sanity_settings.90")}<b>{t("ui.sanity_settings.91")}</b>{t("ui.sanity_settings.92")}</p>
              {/if}
            </div>

            <!-- 计划任务 -->
            <div class="sub-acc">
              <button
                type="button"
                class="info sub-toggle scheduler-toggle"
                class:on={subOpen("scheduler")}
                aria-expanded={subOpen("scheduler")}
                onclick={() => toggleSub("scheduler")}
                >{subOpen("scheduler") ? "▾" : "▸"} {t("ui.sanity_settings.148")}</button
              >
              {#if subOpen("scheduler")}
                <label class="row switch">
                  <input
                    class="scheduler-box"
                    type="checkbox"
                    checked={prefs.schedulerEnabled}
                    disabled={dataMode?.portable ?? false}
                    onchange={(e) => void toggleScheduler(e.currentTarget.checked, e.currentTarget)}
                  />
                  <span>{t("ui.sanity_settings.48")}</span>
                </label>
                {#if dataMode?.portable}
                  <p class="hint">
                    <RichText k="ui.sanity_settings.49" />
                  </p>
                {:else}
                  <p class="hint"><RichText k="ui.sanity_settings.51" /></p>
                {/if}
              {/if}
            </div>

            <!-- 理智值 -->
            <div class="sub-acc">
              <button
                type="button"
                class="info sub-toggle sanity-toggle"
                class:on={subOpen("sanity")}
                aria-expanded={subOpen("sanity")}
                onclick={() => toggleSub("sanity")}
                >{subOpen("sanity") ? "▾" : "▸"} {t("ui.sanity_settings.53")}</button
              >
              {#if subOpen("sanity")}
                <label class="row">
                  <span>{t("ui.sanity_settings.54")}</span>
                  <input
                    class="num"
                    type="number"
                    min="1"
                    max="24"
                    step="0.5"
                    bind:value={hours}
                    onchange={() => void commitHours()}
                    onkeydown={(e) =>
                      escRevert(e, (el) => {
                        hours = hoursTruth();
                        el.value = String(hours);
                      })}
                  />
                  <span>{t("ui.sanity_settings.55")}</span>
                </label>
                <label class="row switch">
                  <input
                    type="checkbox"
                    checked={sanity.enabled}
                    onchange={(e) => void toggle(e.currentTarget.checked, e.currentTarget)}
                  />
                  <span>{t("ui.sanity_settings.56")}</span>
                </label>
                <p class="hint">{t("ui.sanity_settings.57")}</p>
              {/if}
            </div>

            <!-- 成就（暗章）—— round85：唯一版本恒可用（以前 `{#if achievements.available}` 是给 Lite 档留的） -->
            {#if achievements.data}
              <div class="sub-acc">
                <button
                  type="button"
                  class="info sub-toggle achievements-toggle"
                  class:on={subOpen("achievements")}
                  aria-expanded={subOpen("achievements")}
                  onclick={() => toggleSub("achievements")}
                  >{subOpen("achievements") ? "▾" : "▸"} {t("ui.sanity_settings.66")}</button
                >
                {#if subOpen("achievements")}
                  <label class="row switch">
                    <input
                      type="checkbox"
                      checked={prefs.achievementsEnabled}
                      onchange={(e) => void toggleAchievements(e.currentTarget.checked, e.currentTarget)}
                    />
                    <span>{t("ui.sanity_settings.67")}</span>
                  </label>
                  {#if prefs.achievementsEnabled}
                    <div class="row">
                      <span>{t("ui.sanity_settings.68", { unlocked: achievements.data?.unlocked ?? 0, total: achievements.data?.total ?? 0 })}</span>
                      <button type="button" class="ach-view" onclick={() => void openAchievements()}
                        >{t("ui.sanity_settings.69")}</button
                      >
                    </div>
                    <label class="row switch">
                      <input
                        type="checkbox"
                        checked={prefs.achievementToast}
                        onchange={(e) => void toggleAchievementToast(e.currentTarget.checked, e.currentTarget)}
                      />
                      <span>{t("ui.sanity_settings.70")}</span>
                    </label>
                    <p class="hint">{t("ui.sanity_settings.71")}</p>
                  {/if}
                {/if}
              </div>
            {/if}

            <!-- 引导与教程（设-05：说明页入口只此一处 —— 顶部那个 ⓘ 已删） -->
            <div class="sub-acc">
              <button
                type="button"
                class="info sub-toggle guide-toggle"
                class:on={subOpen("guide")}
                aria-expanded={subOpen("guide")}
                onclick={() => toggleSub("guide")}
                >{subOpen("guide") ? "▾" : "▸"} {t("ui.sanity_settings.24")}</button
              >
              {#if subOpen("guide")}
                <div class="guide-actions">
                  <button type="button" class="gf help-open" title={t("ui.sanity_settings.23")} onclick={() => openHelp("hints")}
                    >{t("ui.sanity_settings.26")}</button
                  >
                  <button
                    type="button"
                    class="gf"
                    title={t("ui.sanity_settings.27")}
                    onclick={() => showFirstRunAgain()}>{t("ui.sanity_settings.101")}</button
                  >
                  <button
                    type="button"
                    class="gf"
                    disabled={featureOn("hints_enabled")}
                    title={featureOn("hints_enabled")
                      ? t("ui.sanity_settings.28")
                      : t("ui.sanity_settings.29")}
                    onclick={() => void reopenHints()}
                    >{featureOn("hints_enabled") ? t("ui.sanity_settings.96") : t("ui.sanity_settings.97")}</button
                  >
                </div>
              {/if}
            </div>

            <!-- 键位说明块（round80 · 78-04：整块删除 —— 开关已上移到「提醒与控制」，表本体在 `?` 面板，
                 同组只留一个「打开快捷键总表…」链接） -->
          {/if}
        </section>

        <!-- round79（78-05）：正文末尾的**动态留白**，让每一组都能滚到正文顶部（高度由 `recomputeTail()` 算） -->
        <div class="scroll-tail" style="height:{tailPx}px" aria-hidden="true"></div>
      </div>
    </section>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    display: flex;
    flex: none;
    margin-left: var(--space-2);
  }

  /* 与跳周按钮同一套外观 */
  .sanity-gear {
    padding: 0 var(--space-2);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--line-body);
    cursor: pointer;
  }

  .sanity-gear:hover,
  .sanity-gear.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* round78（3.1b₂ · 栈-04/设-01）：设置从「贴齿轮的 380px 弹层」升级成**覆盖面板**（你 2026-10-06 拍板）——
     定位 / 宽度档 / 遮罩 / 窄窗整屏化都走 `styles/overlay.css`（`.overlay-panel.mid` = 640）；
     这里只管内部结构：标题行 + 分区导航 + 可滚的分组正文。 */
  .sanity-pop {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
  }

  /* 标题行：可见标题（`栈-08` —— 屏幕阅读器靠它念出「这是什么面板」）+ 右上关闭钮 */
  .pop-head {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--grid-line);
  }

  .pop-title {
    margin: 0;
    /* round85（0.31.0）：展示字（只有北境极夜 / 深海冷光真的换字体，其余 = 界面字体）
       round86（0.32.0 · ⑤）：四个量（倍率 / 字距 / 字重 / 小大写） */
    font-family: var(--font-display);
    text-transform: var(--display-transform);
    font-size: calc(var(--text-title) * var(--display-scale, 1));
    font-weight: var(--display-weight, 600);
    font-variant: var(--display-variant, normal);
    letter-spacing: var(--display-tracking, normal);
    color: var(--text-primary);
  }

  /* 分区导航（设-01）：组名一行、可点跳转；窄窗横排可滚（不换行枢） */
  .pop-nav {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-4);
    border-bottom: 1px solid var(--grid-line);
    background: var(--bg);
  }

  .nav-btn {
    padding: 0 var(--space-2);
    background: none;
    border: 1px solid transparent;
    border-radius: 999px;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-meta);
    line-height: 22px;
    cursor: pointer;
  }

  .nav-btn:hover {
    color: var(--text-primary);
  }

  .nav-btn.on {
    border-color: var(--text-secondary);
    color: var(--text-primary);
    font-weight: 600;
  }

  /* 正文：唯一滚动容器（`栈-05` 的 `scrollableRegion` 挂在它上面） */
  .pop-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--space-2) var(--space-4) var(--space-4);
  }

  /* 一个分组（设-01/设-04）：标题 + 行；组间 24px */
  .group + .group {
    margin-top: var(--space-5);
  }

  /* round79（78-05）：导航跳转时给标题留一口气（与正文 `padding-top` 同值 —— 第 1 组也停在同一位置） */
  .group {
    scroll-margin-top: var(--space-2);
  }

  /* round79（78-05）：末尾留白（高度由脚本量；不是一整屏，只要「最后一组也能顶到头」） */
  .scroll-tail {
    flex: none;
  }

  /* round64.1（验收 #4 复核）：设置里的「引导与教程」三个入口 */
  .guide-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .gf {
    padding: 0 var(--space-2);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--line-body);
    cursor: pointer;
  }

  .gf:hover:enabled {
    border-color: var(--accent);
    color: var(--accent);
  }

  .gf:disabled {
    opacity: 0.55;
    cursor: default;
  }

  /* 分组标题（设-04）：--text-title + 600 字重（>= 正文）；组内第一行不再加顶部间距 */
  .sec {
    margin: var(--space-3) 0 var(--space-2);
    font-size: var(--text-title);
    font-weight: 600;
    color: var(--text-primary);
  }

  .group > .sec:first-child {
    margin-top: var(--space-1);
  }

  /* 行结构（设-03）：**两段式** = 标签行 + 控件行（左对齐）；
     开关类走 `.row.switch`（标签左 / 控件右的单行，标签长时自动换行）。
     任何新选项都不许把行变成 nowrap（L19 的根因）。 */
  .row {
    display: flex;
    flex-direction: column;
    align-items: flex-start; /* 控件不被拉伸（分段控件 / 色板保持自身宽度） */
    gap: var(--space-1);
    flex: none;
    padding: var(--space-1) 0;
    font-size: var(--text-body);
    white-space: normal;
  }

  .row + .row,
  .row:has(+ .hint) {
    border-bottom: 1px solid var(--grid-line);
  }

  /* 开关 = 单行（你 2026-10-06 拍板）——旧写法是 nowrap 顶满，提字号就溢出 */
  .row.switch {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-3);
    min-height: var(--row-height);
  }

  .row.switch > span:first-of-type {
    flex: 1 1 220px;
  }

  .ctrl-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .num {
    width: 56px;
    padding: 0 var(--space-1);
    background: var(--bg);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
  }

  .hint {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-meta);
    line-height: var(--line-body);
  }

  /* round45：ⓘ 说明（用户要的）—— 换成链接样式的按钮，点开才展开 */
  .info {
    align-self: flex-start;
    padding: 0;
    background: none;
    border: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-meta);
    text-decoration: underline dotted;
    cursor: pointer;
  }

  .info:hover,
  .info.on {
    color: var(--accent);
  }

  /* 「更多」的展开钮 + 子区折叠钮：都是一行、整行可点（命中区 >= 24） */
  .more-toggle,
  .sub-toggle {
    align-self: stretch;
    padding: var(--space-1) 0;
    text-align: left;
    font-size: var(--text-body);
  }

  .sub-acc {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  /* 设-04：子项缩进 1 级 + 左侧细线（亲密性）；子区之间用小间隙分隔 */
  .sub-acc + .sub-acc {
    margin-top: var(--space-2);
  }

  .sub-acc > .row:not(.switch),
  .sub-acc > .hint,
  .sub-acc > .backup-row,
  .sub-acc > .guide-actions,
  .sub-acc > .feature-row,
  .sub-acc > .feature-thresholds,
  .sub-acc > .hotkey-state {
    margin-left: var(--space-3);
    padding-left: var(--space-3);
    border-left: 2px solid var(--grid-line);
  }

  .close {
    display: grid;
    place-items: center;
    flex: none;
    width: 28px;
    height: 28px;
    margin-left: auto;
    padding: 0;
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-meta);
    cursor: pointer;
  }

  .close:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .sub {
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  .remind-day,
  .remind-time,
  .remind-action,
  .lead {
    padding: 0 var(--space-1);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
  }

  /* round82（3.1c₂ · 淡-11）：夜间时段 —— 两个原生 time 输入（键盘可用 / 24 小时值），与提醒那两个同一套观感 */
  .night-hours {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .night-hours input[type="time"] {
    width: 84px;
    padding: 0 var(--space-1);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
  }

  .hint-mode {
    max-width: 150px;
  }

  /* round74（3.0b₂）：「通用 → 语言」下拉 */
  .lang {
    width: 96px;
  }

  .remind-time {
    width: 84px;
  }

  .remind-action {
    max-width: 118px;
  }

  /* C18（R41）：暂停提醒那一行（窄窗口时整体换行，不压字） */
  .quiet-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-body);
  }

  .mini {
    padding: 1px var(--space-1);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-meta);
    line-height: var(--line-body);
    white-space: nowrap;
    cursor: pointer;
  }

  .mini:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .quiet-custom {
    padding: 0 var(--space-1);
    background: var(--bg);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
  }

  .quiet-morning {
    padding: 0 var(--space-1);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    width: 84px;
  }

  .quiet-state {
    margin: 0;
    color: var(--accent);
    font-size: var(--text-meta);
  }

  .link {
    padding: 0;
    background: none;
    border: none;
    color: var(--accent);
    font: inherit;
    font-size: var(--text-body);
    text-decoration: underline;
    cursor: pointer;
  }

  /* round62（C14）：备份的两枚按钮 */
  .backup-row {
    display: flex;
    gap: var(--space-1);
  }

  .backup {
    flex: 1;
    padding: 0 var(--space-1);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--line-body);
    white-space: nowrap;
    cursor: pointer;
  }

  /* round79（78-01）：恢复默认设置 —— **不复用 `.backup` 类**（`.backup` 是 round62 备份断言的
     选择器：抢了会让「两枚按钮」变三枚 → 假红）；样式照 `.backup` 写一份，描边/字色走危险色。
     单独一行、不拉满宽（危险动作低调一点）。 */
  /* 视觉走 `src/lib/styles/actions.css` 的 `.danger-action`（三处危险操作共用一套） */

  .backup:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* round81（3.1c₁ · 宽-05）：复位布局 —— 次要按钮（**不复用 `.backup` 类**：那是 round62 备份断言的选择器） */
  .reset-layout {
    padding: 0 var(--space-2);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--line-body);
    white-space: nowrap;
    cursor: pointer;
  }

  .reset-layout:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* round68（19.1）：成就区的「查看暗章」——**别复用 `.backup` 类**（\`.backup\` 是 round62 */
  /* 备份断言的选择器，抢了会让 `--only round62` 的第一个 .backup 变成它 → 假红）*/
  .ach-view {
    padding: 0 var(--space-2);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--line-body);
    white-space: nowrap;
    cursor: pointer;
  }

  .ach-view:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* round64（C10）：功能开关区的标签（会打扰 / 会改数据 / 纯外观） */
  .feature-row {
    justify-content: flex-start;
  }

  .feature-row > span:first-of-type {
    flex: 1;
  }

  .tags {
    display: flex;
    flex: none;
    gap: var(--space-1);
  }

  .tag {
    padding: 0 var(--space-1);
    border: 1px solid var(--grid-line);
    border-radius: 3px;
    color: var(--text-secondary);
    font-size: var(--text-meta);
    line-height: var(--line-body);
    white-space: nowrap;
  }

  .feature-thresholds {
    justify-content: flex-start;
    padding-left: var(--space-4);
  }

  .feature-thresholds .num {
    width: 56px;
  }

  /* ===================== 设-02：三处预览选择器 ===================== */
  /* 配色：12 套（round85）—— **横向一排 + 横滚**（你 2026-10-08 拍）：
     640px 面板里约 4 张满 + 第 5 张露边（天然的可滚动提示）；`padding-bottom: 2px` 给滚动条留一道缝。
     键盘 Tab 到屏外按钮时浏览器自己会把它滚入视口（无需额外实现）。 */
  .palettes {
    display: flex;
    flex-wrap: nowrap;
    align-self: stretch;
    gap: var(--space-2);
    padding-bottom: 2px; /* 光学微调：给横向滚动条留一道缝（不与卡片底边粘住） */
    overflow-x: auto;
    overscroll-behavior-x: contain;
    /* round86（0.32.0 · ④）：**两端按需渐隐**（你 2026-10-08 拍）——
       兜底：两端各淡 16px；支持滚动驱动动画时用下面的 keyframes 把「已经滚到头的那一侧」恢复成全不透明
       （起始位左端不淡、滚到最右右端不淡）。mask **不影响命中**，但会新建层叠上下文（MDN）
       —— 只挂在这一个横向滚动容器上。 */
    mask-image: linear-gradient(to right, transparent 0px, #000 16px, #000 calc(100% - 16px), transparent 100%);
  }

  @supports (animation-timeline: scroll()) {
    .palettes {
      animation: r86-x-fade linear both;
      animation-timeline: scroll(self inline);
    }
  }

  /* 四帧都是**四个色标**（同结构才能插值）：从「只隐右侧」→「两端都隐」→「只隐左侧」 */
  @keyframes r86-x-fade {
    0% {
      mask-image: linear-gradient(to right, #000 0px, #000 0px, #000 calc(100% - 20px), transparent 100%);
    }
    6%,
    94% {
      mask-image: linear-gradient(to right, transparent 0px, #000 16px, #000 calc(100% - 16px), transparent 100%);
    }
    100% {
      mask-image: linear-gradient(to right, transparent 0px, #000 16px, #000 100%, #000 100%);
    }
  }

  .palettes .palette {
    flex: none; /* 不被压窄（`flex-shrink` 默认 1 会把 132px 的小样压掉） */
  }

  .icon-sets,
  .densities {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .palette,
  .icon-set-btn,
  .density {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: center;
    padding: var(--space-2);
    background: var(--bg);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    cursor: pointer;
  }

  .palette.on,
  .icon-set-btn.on,
  .density.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
  }

  /* round80（79-02）：配色 = 迷你界面小样（不用三色格 —— 卡片同值 / 页底色差 < JND，看不出区别） */
  .palette .thumb {
    position: relative;
    width: 132px;
    height: 74px;
    overflow: hidden;
    border: 1px solid var(--grid-line);
    border-radius: 6px;
  }

  .palette .art {
    position: absolute;
    inset: 0;
    display: flex;
  }

  /* 亮/暗两份小样：只显示与当前主题一致的那一份（与应用同一套 prefers-color-scheme） */
  .palette .art-dark {
    display: none;
  }

  @media (prefers-color-scheme: dark) {
    .palette .art-light {
      display: none;
    }

    .palette .art-dark {
      display: flex;
    }
  }

  .palette .side {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 34px;
    padding: var(--space-1);
  }

  .palette .side i {
    display: block;
    height: 4px;
    border-radius: 2px;
    opacity: 0.65;
  }

  .palette .main {
    flex: 1;
    padding: var(--space-1);
  }

  .palette .main .line {
    display: block;
    width: 70%;
    height: 5px;
    margin-bottom: var(--space-1);
    border-radius: 2px;
    opacity: 0.5;
  }

  .palette .main .blk {
    position: relative;
    display: block;
    height: 18px;
    margin-bottom: var(--space-1);
    border: 1px solid;
    border-radius: 3px;
  }

  .palette .main .blk b {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
  }

  /* 选中不靠颜色单通道：名字前一个 ✓ —— 用 CSS 伪元素（DOM 里不放纯符号元素；
     未选中时占位隐藏，避免换选时整行排动） */
  .palette .pname::before {
    content: "✓ ";
    visibility: hidden;
  }

  .palette .pname.on::before {
    visibility: visible;
  }

  .palette .pname,
  .icon-set-btn .iname,
  .density .dname {
    font-size: var(--text-meta);
    color: var(--text-secondary);
  }

  .palette.on .pname,
  .icon-set-btn.on .iname,
  .density.on .dname {
    color: var(--text-primary);
    font-weight: 600;
  }

  /* 图标：5 个迷你预览（每格 6 枚真 SVG） */
  .icon-set-btn .mini {
    display: grid;
    grid-template-columns: repeat(3, auto);
    gap: 3px;
    color: var(--text-primary);
  }

  /* 深浅色：三档分段控件（与选择器同一种「看得到差别」的表达） */
  .seg {
    display: inline-flex;
    overflow: hidden;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
  }

  .seg-btn {
    padding: 0 var(--space-3);
    background: none;
    border: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--control-height);
    cursor: pointer;
  }

  .seg-btn + .seg-btn {
    border-left: 1px solid var(--text-secondary);
  }

  .seg-btn.on {
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
  }

  /* 密度：3 张带样本行的小卡（行高/字号取 DENSITY_SCALE，与 tokens.css 由断言核对） */
  .density {
    align-items: stretch;
    min-width: 108px;
  }

  .density .dsample {
    display: flex;
    align-items: center;
    padding: 0 var(--space-2);
    overflow: hidden;
    background: var(--block-fill-planned);
    border-radius: 3px;
    color: var(--block-ink-planned);
    white-space: nowrap;
  }

  .density .dmeta {
    font-size: var(--text-meta);
    color: var(--text-tertiary);
  }
</style>
