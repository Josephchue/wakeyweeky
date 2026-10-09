/**
 * round76（3.1a）：**一个 60 秒节拍的「现在」**（时间轴的「现在线」用它）。
 *
 * 三条纪律（边界表 #12–#14）：
 * - 只在**页面可见**时跑节拍：窗口最小化 / 切后台就停（不白耗电），回到前台补一次。
 * - 只更新一个时间戳：**不写库、不改任何数据**。
 * - 红线之外不画：看的是别的周时由 Timeline 自己判断（`clock.now` 在不在视野那一周里）。
 */
export const clock = $state<{ now: number }>({ now: Math.floor(Date.now() / 1000) });

let timer: ReturnType<typeof setInterval> | null = null;

const tick = () => {
  clock.now = Math.floor(Date.now() / 1000);
};

function stopTicking() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function startTicking() {
  stopTicking();
  tick();
  timer = setInterval(tick, 60_000);
}

function onVisibilityChange() {
  if (document.hidden) stopTicking();
  else startTicking(); // 回到前台补一次重算（藏着的时候节拍停着）
}

/** 应用启动时调一次（`App.svelte` onMount）；重复调用无副作用 */
let started = false;

/** 应用启动时调一次（`App.svelte` onMount）。**重复调用是空操作** ——
 *  6b 复核提醒：以前每次调都会再挂一个 `visibilitychange` 监听（定时器有兜底，监听器没有）。 */
export function startClock(): void {
  if (typeof document === "undefined" || started) return;
  started = true;
  startTicking();
  document.addEventListener("visibilitychange", onVisibilityChange);
}
