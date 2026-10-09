//! 提醒优先级：**唯一实现**（v2 ⑦）。前端不重算，只读后端算好的 `priority` 字段。
//!
//! 规则（C1.4 两层结构）：
//! - **高**：`required` 层，或来自外部日历（`external_source` 非空 —— 兜住「层被改脏」的数据）
//! - **低**：`elastic` 层（可长可短，不该来打扰）；调用方已保证只处理 `planned` 的块
//! - **遗留值 `suggested`**：按低处理（004 迁移会把它并入弹性；万一旧版本又写回来，也不能崩）
//! - **未知层值**（手工改库等）：按低处理，并只警告一次 —— 不崩、也不静默丢弃

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    High,
    Low,
}

impl Priority {
    /// 前端契约字符串（TS 侧就是这两个字面量）
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::High => "high",
            Priority::Low => "low",
        }
    }

    /// 优先级高低（用于判断「层级升级了」：升级时要重新提醒一次）
    pub fn rank(self) -> u8 {
        match self {
            Priority::High => 1,
            Priority::Low => 0,
        }
    }
}

/// 判定优先级（纯函数，便于单测与人肉推演）。
///
/// 说明：本函数不接收 `status` —— 调用方（`due_blocks`）已经用 `status = 'planned'` 过滤过，
/// 已标记的块根本不会走到这里（B1-6 由 `due_blocks` 的既有测试覆盖）。
pub fn of(layer: &str, external_source: Option<&str>) -> Priority {
    // 外部日历占用块一律最高优先级（即使它的 layer 被手工改脏）
    if external_source.is_some() {
        return Priority::High;
    }

    match layer {
        "required" => Priority::High,
        // 弹性层；以及 004 之前的遗留值 suggested（同样按「不打扰」处理）
        "elastic" | "suggested" => Priority::Low,
        _ => {
            // 只警告一次：priority 会在每次查询里被算很多遍，逐次打日志会把控制台刷爆
            static WARNED: std::sync::Once = std::sync::Once::new();
            WARNED.call_once(|| {
                eprintln!("[priority] 出现未知的层值 {layer:?}，按「低」处理（疑似手工改库）");
            });
            Priority::Low
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// B1-1：必填层 → 高
    #[test]
    fn test_priority_high_for_required() {
        assert_eq!(of("required", None), Priority::High);
    }

    /// B1-2：外部日历来源 → 高（即使层值脏）
    #[test]
    fn test_priority_high_for_external_source_even_if_layer_is_dirty() {
        assert_eq!(of("required", Some("ics")), Priority::High);
        assert_eq!(of("suggested", Some("ics")), Priority::High);
        assert_eq!(of("elastic", Some("ics")), Priority::High);
        assert_eq!(of("垃圾值", Some("ics")), Priority::High);
    }

    /// C1.4：弹性层 → 低；遗留的 `suggested` 也按低处理（004 迁移前的库/旧版本写回来的库）
    #[test]
    fn test_priority_low_for_elastic_and_legacy_suggested() {
        assert_eq!(of("elastic", None), Priority::Low);
        assert_eq!(
            of("suggested", None),
            Priority::Low,
            "遗留的建议层一律当弹性：不打扰用户"
        );
    }

    /// B1-5：未知层值 → 低（不崩、不丢弃）
    #[test]
    fn test_priority_unknown_layer_falls_back_to_low() {
        assert_eq!(of("urgent", None), Priority::Low);
        assert_eq!(of("", None), Priority::Low);
        assert_eq!(of("REQUIRED", None), Priority::Low, "大小写不匹配也算未知");
    }

    /// 前端契约：字符串必须是这两个字面量；且 rank 顺序必须是 低 < 高
    #[test]
    fn test_priority_as_str_and_rank_contract() {
        assert_eq!(Priority::High.as_str(), "high");
        assert_eq!(Priority::Low.as_str(), "low");
        assert!(Priority::Low.rank() < Priority::High.rank());
    }
}
