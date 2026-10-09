/**
 * round64（C11）：`.ics` 导出的小工具（纯函数，vitest 覆盖）。
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `WakeyWeeky-2026-10-05.ics`（**本地日期** —— 用户看得懂；不加时分，同一天重导会提示覆盖） */
export function icsFileName(now: Date): string {
  return `WakeyWeeky-${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}.ics`;
}
