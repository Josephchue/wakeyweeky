<script lang="ts">
  import { t } from "./lib/i18n/i18n.svelte";
  import { onMount } from "svelte";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import Backlog from "./lib/components/Backlog.svelte";
  import DriftCard from "./lib/components/DriftCard.svelte";
  import ReviewPanel from "./lib/components/ReviewPanel.svelte";
  import StatsPanel from "./lib/components/StatsPanel.svelte";  import FirstRun from "./lib/components/FirstRun.svelte";
  import HelpPanel from "./lib/components/HelpPanel.svelte";
  import DataSwitch from "./lib/components/DataSwitch.svelte";
  import AchievementsPanel from "./lib/components/AchievementsPanel.svelte";
  import KeymapPanel from "./lib/components/KeymapPanel.svelte";
  import ConfirmPanel from "./lib/components/ConfirmPanel.svelte";
  import Timeline from "./lib/components/Timeline.svelte";
  import Toast from "./lib/components/Toast.svelte";
  import { missedSummary, onReminded } from "./lib/ipc/notify";
  import { onBlockUpdated, onAchievementUnlocked } from "./lib/ipc/events";
  import { getDataInfo, hotkeyStatus } from "./lib/ipc/portable";
  import { listTasks } from "./lib/ipc/tasks";
  import { reloadWeek } from "./lib/stores/blocks.svelte";
  import { link, linkCursor, linkOnEmptySpace } from "./lib/stores/sequences.svelte";
  import { loadTasks } from "./lib/stores/tasks.svelte";
  import { loadSanitySettings } from "./lib/stores/sanity.svelte";
  import {
    BACKLOG_MAX,
    BACKLOG_MIN,
    backlogDefault,
    clampBacklogWidth,
    layout,
    loadLayoutSettings,
    saveBacklogWidth,
    saveSlotHeight,
    slotHeightEffective,
    SLOT_HEIGHTS,
  } from "./lib/stores/layout.svelte";
  import { toast, toastAchievement, dataSwitch } from "./lib/stores/ui.svelte";
  import { anyPanelOpen } from "./lib/stores/panels.svelte";
  import { selection } from "./lib/stores/selection.svelte";
  import { drag } from "./lib/stores/drag.svelte";
  import { createWheelAccumulator } from "./lib/utils/wheel-zoom";
  import { refreshWeek } from "./lib/stores/week.svelte";
  import { startClock, clock } from "./lib/stores/clock.svelte";
  import { checkNudge, loadRemindSettings } from "./lib/stores/review.svelte";
  import { checkTemplateSuggestion, maybeHint } from "./lib/stores/guide.svelte";
  import { loadPrefs, prefs, syncNightTheme } from "./lib/stores/settings.svelte";
  import {
    achievements,
    initAchievements,
    loadAchievements,
    markNew,
  } from "./lib/stores/achievements.svelte";

  // C3.3：拿起线头之后 —— 线头跟着鼠标走；点空白处 = 取消（若那个块在链上，等于**解除链接**）。
  // 用两次左键而不是按住拖：用户明确说「不想一直按着左键」。
  $effect(() => {
    if (!link.pendingId) return;

    const onMove = (event: PointerEvent) => {
      linkCursor.x = event.clientX;
      linkCursor.y = event.clientY;
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      // 点在块上 → 交给块自己的 ⛓；提示条 / 顶部按钮（跳周、撤销）也不算「点空白」
      // C1.6：拿着线头点 ‹ › 跳周时，这条监听本来会把线头当成「点了空白」直接取消掉 ✗
      if (
        target?.closest("[data-block-id]") ||
        target?.closest(".link-hint") ||
        target?.closest(".week-nav") ||
        target?.closest(".gesture-hint")
      )
        return;
      void linkOnEmptySpace();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("click", onClick);
    };
  });

  $effect(() => {
    void clock.now;
    void syncNightTheme();
  });

  onMount(() => {
    let unlisten: UnlistenFn | undefined;
    let unlistenBlockUpdated: UnlistenFn | undefined;
    let unlistenAchievements: UnlistenFn | undefined;

    // round76（3.1a）：60 秒节拍的「现在」（时间轴的现在线）—— 窗口藏着时自动停
    startClock();

    void (async () => {
      try {
        await loadTasks();
        // C6（round44）：先把预算/开关读回来（⚙ 小弹层要显示当前值；曲线在 reloadWeek 里拉）
        await loadSanitySettings();
        // C7（round52）：周复盘提醒的开关与时刻（默认周日 20:00）
        await loadRemindSettings();
        // C18（round63）：免打扰等新偏好（目前只读不写；面板打开时会再读一次）
        await loadPrefs();
        // round68（19.1）：启动拉一次暗章列表（顺手把数字备好；round85 起唯一版本恒可用）
        void initAchievements();
        // C7：启动就看一眼到点没（一周只会提一次；后端负责水位线）。
        // round57：启动算「回到应用」—— 「直接打开总览」那一档在这一次触发。
        void checkNudge("return");
        // round64（C10）：模板建议也在「回到应用」时看一眼（一周只会提一次）
        void checkTemplateSuggestion();
        // round66（C12）：便携模式的两条启动提示 + 全局快捷键冲突提示（各自只提一次）
        void checkPortable();
        void checkHotkeys();
        // round45：栏宽也是存设置里的
        await loadLayoutSettings();
        await reloadWeek();
        // C13 补充：我不在的时候错过的提醒，给一行交代（后端只提示，不动那些块）
        const missed = await missedSummary();
        if (missed > 0) {
          toast(t("ui.app.01", { missed: missed }));
        }
        // 后端发出提醒时，窗口内也弹一条（系统通知被系统静音时的兜底）
        unlisten = await onReminded();
        // 浮窗里标记/删除后，主窗口据此即时刷新（B4-1）
        unlistenBlockUpdated = await onBlockUpdated(() => {
          void reloadWeek().catch(() => {});
        });
        // round68（19.1）：暗章点亮 → 短提示 + 面板挂 NEW
        unlistenAchievements = await onAchievementUnlocked((newly) => {
          markNew(newly.map((n) => n.id));
          if (prefs.achievementToast) {
            for (const n of newly) toastAchievement(t("ui.app.02", { name: n.name }));
          }
          if (achievements.open) void loadAchievements();
        });
      } catch {
        // ipc 层已弹 Toast
      }
    })();

    // 跨周自检：每分钟看一眼是不是到了新一周（应用可能开着过夜）
    const weekTimer = setInterval(() => {
      if (refreshWeek()) {
        void reloadWeek().catch(() => {
          // ipc 层已弹 Toast
        });
      }
      // C7（round52）：周复盘提醒也跟着分钟走（到点了就冒头）
      void checkNudge();
      void checkTemplateSuggestion(); // round64（C10）：模板建议（后端水位线保证一周一次）
    }, 60_000);

    // C7：从托盘/别处回到窗口时也看一眼（周日晚上关机、周一早上打开的场景靠它补上）
    // round57：这是「回到应用」—— 「直接打开总览」只在这一刻发生（不在干活中途抢屏）
    const onFocus = () => {
      void checkNudge("return");
      void checkTemplateSuggestion();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(weekTimer);
      window.removeEventListener("focus", onFocus);
      unlisten?.();
      unlistenBlockUpdated?.();
      unlistenAchievements?.();
    };
  });

  /**
   * round66（C12）：便携模式的两条启动提示 —— ① 首次便携自动把数据带过来（P3）；
   * ② flag 在但目录不可写、回落到默认位置（P4）。都不是错误，只在真有话要说时弹一条。
   */
  async function checkPortable() {
    try {
      const info = await getDataInfo();
      if (info.adopted) {
        toast(t("ui.app.03"));
      } else if (info.fallback && info.note) {
        toast(t("ui.app.04", { note: info.note }));
      }
    } catch {
      /* ipc 层已弹 Toast */
    }
  }

  /** round66（C12）：两个键位都被别的程序占用 → 提示一次（同一条错误只提醒一次，不每次启动都念）
   *  round66.1：主键被占用、退到了备用键位也要说一声 —— 不然用户按主键没反应、也不知道该按哪个 */
  async function checkHotkeys() {
    try {
      const status = await hotkeyStatus();
      if (status.error) {
        if (!rememberHotkeyNotice(status.error)) return;
        toast(t("ui.app.05", { error: status.error }));
        return;
      }
      if (status.active && status.active !== "Win+Shift+W") {
        const note = t("ui.app.06", { active: status.active });
        if (!rememberHotkeyNotice(note)) return;
        toast(note);
      }
    } catch {
      /* ipc 层已弹 Toast */
    }
  }

  /** 同一条提示只念一次（按提示原文去重；换一条会重新提醒） */
  function rememberHotkeyNotice(text: string): boolean {
    let seen: string | null = null;
    try {
      seen = localStorage.getItem("ww-hotkey-warned");
    } catch {
      /* 存不了就这次照样提 */
    }
    if (seen === text) return false;
    try {
      localStorage.setItem("ww-hotkey-warned", text);
    } catch {
      /* 忽略：下次启动再提一次 */
    }
    return true;
  }

  // 仅供开发期自检：验证 ipc 层 + Toast 链路。本文件后续改动时保留。
  async function debugListTasks() {
    try {
      const data = await listTasks();
      console.log("debug listTasks:", data);
    } catch (e) {
      console.error(e);
    }
    toast(t("ui.app.07"));
  }

  /**
   * round45（0.8.1）：两栏之间的分隔条。
   * 拖动中只改内存（`layout.backlogWidth`），**松手才落库**（一次拖动不要写 N 次设置）；
   * 监听挂在 window 上：指针拖到分隔条外面、甚至松开在别处，也照样收尾（本仓手势的一贯口径）。
   */
  function startResize(e: PointerEvent) {
    const fromX = e.clientX;
    const fromWidth = layout.backlogWidth;
    const move = (ev: PointerEvent) => {
      layout.backlogWidth = clampBacklogWidth(fromWidth + (ev.clientX - fromX));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      void saveBacklogWidth(layout.backlogWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /** 双击 = 回到默认宽度（拖窄了想找回原来那个值；宽-05：随密度 240/260/280） */
  function resetBacklogWidth() {
    const w = backlogDefault();
    layout.backlogWidth = w;
    void saveBacklogWidth(w);
  }

  /** 键盘也能调（接 WCAG：只有拖拽一个入口不够）——←/→ 每次 10px，Shift 加速 40px */
  function onSplitterKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    // round83（验收回修时拓出来的真 bug）：**必须 stopPropagation** ——
    // 不然事件继续冒到 window 的全局键处理器，←/→ 会**同时跳周**（栏宽变 + 周也跳，实测抓到）。
    e.stopPropagation();
    const step = e.shiftKey ? 40 : 10;
    layout.backlogWidth = clampBacklogWidth(
      layout.backlogWidth + (e.key === "ArrowRight" ? step : -step),
    );
    void saveBacklogWidth(layout.backlogWidth);
  }

  // ---------------------------------------------------------------- round81（3.1c₁ · 宽-02/04/09）
  /** Ctrl+滚轮（含触控板捏合）：**只在时间轴上接管**（= 时间刻度）；
   *  其它位置一律不拦（浏览器缩放是无障碍能力，不能全局抢）。浮层开着 / 手势中不接管。
   *  round83（验收回修）：原来「分隔条 = 栏宽」那条**按你要求撤掉** —— 栏宽改回拖动 / 双击复位 / ←→ 三条路。 */
  const wheelScale = createWheelAccumulator();

  /** 一档 → 下一个档位（到两端 18 / 64 就停住，不静默循环） */
  function stepSlotHeight(steps: number) {
    const cur = layout.slotHeight === "auto" ? slotHeightEffective() : layout.slotHeight;
    const idx = (SLOT_HEIGHTS as readonly number[]).indexOf(cur);
    const at = Math.min(SLOT_HEIGHTS.length - 1, Math.max(0, (idx < 0 ? 1 : idx) + steps));
    const next = SLOT_HEIGHTS[at];
    if (next !== cur) void saveSlotHeight(next);
  }

  function onWindowWheel(e: WheelEvent) {
    if (!e.ctrlKey) return; // 触控板捏合在 WebView2 里也是 `wheel` + `ctrlKey`（宽-08 同一条路径）
    if (anyPanelOpen() || dataSwitch.busy || selection.grabbed || drag.blockId || drag.taskId) return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el?.closest(".board")) return; // 其它位置保持浏览器缩放（无障碍）
    e.preventDefault();
    void maybeHint("zoom"); // 宽-09：首次用给一条轻提示（可关可找回）
    // 往上滚（deltaY < 0）= 放大：刻度变高
    const steps = -wheelScale.push(e.deltaY);
    if (!steps) return;
    stepSlotHeight(steps);
  }

  onMount(() => {
    window.addEventListener("wheel", onWindowWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWindowWheel);
  });
</script>

<main class="shell" style="--backlog-width: {layout.backlogWidth}px">
  <Backlog />
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!--
    WAI-ARIA APG 的 **window splitter** 就是「可聚焦的 separator」：`role="separator"` +
    `tabindex=0` + `aria-valuenow` —— svelte-check 不认识这个模式，所以显式忽略那条告警。
  -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  {#if layout.backlogPane === "open"}
    <div
      class="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("ui.app.08")}
      aria-valuenow={layout.backlogWidth}
      aria-valuemin={BACKLOG_MIN}
      aria-valuemax={BACKLOG_MAX}
      tabindex="0"
      title={t("ui.app.09")}
      onpointerdown={startResize}
      ondblclick={resetBacklogWidth}
      onkeydown={onSplitterKey}
    ></div>
  {/if}
  <Timeline />
  {#if import.meta.env.DEV}
    <button class="debug" onclick={debugListTasks}>Debug</button>
  {/if}
</main>

<Toast />
<DriftCard />
<ReviewPanel />
<StatsPanel />
<AchievementsPanel />
<KeymapPanel />
<FirstRun />
<HelpPanel />
<DataSwitch />
<ConfirmPanel />

<style>
  .shell {
    display: flex;
    /* round45：两栏之间的间隔交给分隔条自己占（它 16px 宽、视觉上就是原来那个缝） */
    gap: 0;
    height: 100%;
    padding: var(--space-4);
  }

  /* round45：分隔条 —— 平时看不见（只是一道 16px 的沟），悬停/聚焦时出一条细线 */
  .splitter {
    position: relative;
    flex: none;
    width: var(--space-4);
    cursor: col-resize;
  }

  .splitter::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 2px;
    transform: translateX(-50%);
    border-radius: 1px;
    background: transparent;
  }

  .splitter:hover::before,
  .splitter:focus-visible::before {
    background: var(--accent);
  }

  .debug {
    position: fixed;
    right: var(--space-4);
    bottom: var(--space-4);
    padding: var(--space-1) var(--space-2);
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-meta);
    cursor: pointer;
  }

  .debug:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
