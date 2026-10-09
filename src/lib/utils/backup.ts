/**
 * round62（C14）：备份文件名 / 大小显示的小工具（纯函数，vitest 覆盖）。
 * 文件名格式按台账 #10：「单个 SQLite 副本 + 时间戳」。
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `WakeyWeeky-2026-10-04-1930.db`（**本地时区** —— 用户看得懂的那个时间） */
export function backupFileName(now: Date): string {
  return `WakeyWeeky-${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}-${pad2(
    now.getHours(),
  )}${pad2(now.getMinutes())}.db`;
}

/** 字节 → 「840 B / 12 KB / 1.3 MB」（导出成功的 Toast 里用） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
