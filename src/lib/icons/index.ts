/**
 * round77（3.1b）：**五套内联图标**的公共入口。
 *
 * 为什么内联（不装 npm 包、不引字体）：**本项目零额外依赖是硬边界**（`施工方案` §3.2）；
 * 我们只用 40 个图标，装一个上千个图标的包没有意义；内联 SVG 是纯文本、可 diff、分辨率无关。
 *
 * 数据来自 `tools/icons/vendor.mjs`（版本钉死、缺项逐条回退 Lucide）：
 * - `sets/<set>.ts`：该套的 `VIEW_BOX` / 默认 paint / `PATHS`（语义名 → 形状 `d` 列表）
 * - `docs/visual/图标落地对照表.md`：五套的逐条名字与回退（机器生成，别手改）
 * - `src-tauri/resources/ICONS-LICENSE.md`：五家许可与取用清单
 *
 * 语义名与画法分开：`x`（未完成）与 `close`（关闭）**画法相同**但在 DOM 上是两个 `data-icon` ——
 * 一符多义正是这一轮要拆掉的（`图-08`）。
 */
import * as bootstrap from "./sets/bootstrap";
import * as lucide from "./sets/lucide";
import * as material from "./sets/material";
import * as phosphor from "./sets/phosphor";
import * as tabler from "./sets/tabler";
import { ICON_SETS, normalizeIconSet, type IconSet } from "../utils/appearance";

export type IconPath = { d: string; fill?: string; stroke?: string; strokeWidth?: number };
type SetModule = {
  VIEW_BOX: string;
  DEFAULT_FILL: string;
  DEFAULT_STROKE: string;
  STROKE_WIDTH: number;
  PATHS: Record<string, IconPath[]>;
};

const SETS: Record<IconSet, SetModule> = { lucide, tabler, phosphor, bootstrap, material };

/** 40 个语义名（顺序 = vendor 表顺序，也是对照表顺序） */
export const ICON_NAMES = Object.keys(lucide.PATHS);
export type IconName = string;

export type IconData = {
  set: IconSet;
  /** 实际提供形状的那一套（缺项回退时 = "lucide"）—— `data-icon-source` 用它，
   *  让「回退 0」有**运行期可验**的证据（`data-icon-set` 只是回显请求值，验不了回退） */
  source: IconSet;
  viewBox: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  paths: IconPath[];
};

/**
 * 取一个图标在指定套下的画法。
 * `set` 非法 / 缺项 → 回退 Lucide（vendor 阶段已逐条记账；运行时不报错）。
 * `data-icon-source` 会如实报出**形状到底从哪一套来**（缺项时是 lucide）。
 */
export function iconData(set: unknown, name: IconName): IconData {
  const key = normalizeIconSet(set);
  const mod = SETS[key];
  const own = mod.PATHS[name];
  const paths = own ?? SETS.lucide.PATHS[name] ?? [];
  return {
    set: key,
    source: own ? key : "lucide",
    viewBox: mod.VIEW_BOX,
    fill: mod.DEFAULT_FILL,
    stroke: mod.DEFAULT_STROKE,
    strokeWidth: mod.STROKE_WIDTH,
    paths,
  };
}

export { ICON_SETS };
