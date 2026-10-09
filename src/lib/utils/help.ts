/**
 * round64（C10）：说明页「功能开关总表」的行数据（纯函数）—— 从 `FEATURES` 元数据表派生，
 * 保证说明页与设置面板**同一份标签/键名/「关掉后会怎样」**（防漂移，plan H7）。
 */
import type { FeatureMeta } from "./features";

export interface FeatureSummaryRow {
  key: string;
  label: string;
  on: boolean;
  off: string;
}

/** 当前每个功能开着还是关着（布尔读 `features[key]`；模板建议读 `templateSuggest.enabled`） */
export function featuresOnSummary(
  features: FeatureMeta[],
  state: { features: Record<string, boolean>; templateSuggest: { enabled: boolean } },
): FeatureSummaryRow[] {
  return features.map((f) => ({
    key: f.key,
    label: f.label,
    off: f.off,
    on: f.boolean ? state.features[f.key] !== false : state.templateSuggest.enabled,
  }));
}
