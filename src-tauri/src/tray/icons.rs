//! round82（3.1c₂ · `壳-07` 轻量版 · `盘-*`）：托盘四态图标的**运行时绘制**（纯函数，可单测）。
//!
//! 形状不再自造：直接**借本仓已在用的开源图标** —— Lucide `list-checks`（ISC；五套图标的许可全文随
//! `src-tauri/resources/ICONS-LICENSE.md` 打进 MSI）。绘制路线 = **极简光栅器**：把折线用圆笔刷描边、
//! 按 8× 超采样求覆盖率（与样张工具 `tools/visual/lib/tray-raster.mjs` 同一套数学，样张你已拍）。
//!
//! 四态（`盘-18`，你 2026-10-07 两张截图的口径）—— 徽标**统一放右下角**：
//! - 默认：基形**描边**（灰）
//! - 有进行中的任务：基形换**强调色** + 右下**实心点**
//! - 高优先级提醒：基形描边 + 右下**实心警示三角**
//! - 理智值超载：基形描边 + 右下**空心红环**（不再「套住整个图标」）
//!
//! 每个徽标先在本层**挖一圈 1.6px 的透明分离环**（把基形挖断）—— 不这么做，16px 下两个形状会糊成一团。
//! 样张里这圈是任务栏底色；真图标里改成**透明**：在任务栏上看到的颜色一样，但不用猜底色、
//! 也不受任务栏半透明 / 壁纸透出的影响（`盘-18` 的「底色分离环」在实现上 = 挖空）。
//! 亮 / 暗任务栏**两套色**（`盘-05` / `盘-15`）：旧固定色在亮任务栏上四态全部 < WCAG 3:1（实测 1.65–2.99）。
//!
//! 底色本身**不填**：图标保留透明背景（托盘会把自己的底色透出来）——「分离环」用的就是任务栏底色这一猜测值。

use super::TrayState;

/// 图标边长（px）—— 只交付 32×32，系统缩到 16 / 20 / 24（`盘-02`，与现状一致）
pub const SIZE: u32 = 32;
/// 超采样倍率（样张工具同口径 8×）
const SS: u32 = 8;
/// 形状四周留 2px（32px 画布里占 28px）
const INSET: f32 = 2.0;
/// 一个图标单位（viewBox 0–24）等于多少逻辑像素
const UNIT: f32 = (SIZE as f32 - INSET * 2.0) / 24.0;

/// 右下角徽标的几何（样张数值，`盘-18`）
const BADGE_CX: f32 = 23.5;
const BADGE_CY: f32 = 23.5;
/// 提醒三角的参考圆心（比其它两个高半像素）与「外径」
const TRI_CY: f32 = 23.0;
const TRI_R: f32 = 8.5;
/// 实心点半径 / 空心环内外半径
const DOT_R: f32 = 6.5;
const RING_OUTER: f32 = 8.4;
const RING_INNER: f32 = 6.2;
/// 徽标外圈那层「底色分离环」的厚度
const SEP: f32 = 1.6;

/// 一套「墨色」（`盘-15` 实测：每色对任务栏底 ≥3:1）
#[derive(Clone, Copy)]
pub struct Palette {
    /// 基形（无进行中任务时）
    pub base: [u8; 4],
    /// 有进行中任务（基形换它）
    pub accent: [u8; 4],
    /// 高优先级提醒的三角
    pub warn: [u8; 4],
    /// 超载的空心红环
    pub ring: [u8; 4],
}

/// 任务栏底色（Windows 11 亮 / 暗 ≈ `#f3f3f3` / `#202020`）——
/// **只给对比度断言用**：绘制本身**不填底色**（图标保持透明背景，分离环是挖空）。
#[cfg(test)]
const TASKBAR_LIGHT: [u8; 4] = rgb(0xf3, 0xf3, 0xf3);
#[cfg(test)]
const TASKBAR_DARK: [u8; 4] = rgb(0x20, 0x20, 0x20);

const fn rgb(r: u8, g: u8, b: u8) -> [u8; 4] {
    [r, g, b, 0xFF]
}

/// **深墨**：画在**亮**任务栏上（Windows 11 亮模式任务栏 ≈ `#f3f3f3`）
pub const ON_LIGHT_TASKBAR: Palette = Palette {
    base: rgb(0x4a, 0x45, 0x3d),
    accent: rgb(0x0b, 0x60, 0x47),
    warn: rgb(0xb3, 0x3a, 0x09),
    ring: rgb(0xb3, 0x2a, 0x1e),
};
/// **浅墨**：画在**暗**任务栏上（Windows 11 暗模式任务栏 ≈ `#202020`）
pub const ON_DARK_TASKBAR: Palette = Palette {
    base: rgb(0xc3, 0xbd, 0xb2),
    accent: rgb(0x5c, 0xd6, 0xac),
    warn: rgb(0xff, 0xa5, 0x7a),
    ring: rgb(0xff, 0x7a, 0x6b),
};

/// 按任务栏底色挑一套墨色
pub fn palette(light_taskbar: bool) -> &'static Palette {
    if light_taskbar {
        &ON_LIGHT_TASKBAR
    } else {
        &ON_DARK_TASKBAR
    }
}

/// 按状态取图标像素（未知 / 失败一律回默认图标，不 panic）
pub fn for_state(state: TrayState, light_taskbar: bool) -> Vec<u8> {
    let p = palette(light_taskbar);
    let mut buf = blank();
    // ① 基形：有进行中的任务 → 换成强调色，其余三态都用中性墨色
    let base = if state == TrayState::HasCurrentTask { p.accent } else { p.base };
    paint(&mut buf, glyph_coverage, base);
    // ② 右下角徽标（每个都先铺一圈底色分离环）
    match state {
        TrayState::Default => {}
        TrayState::HasCurrentTask => {
            erase_disc(&mut buf, BADGE_CX, BADGE_CY, DOT_R + SEP);
            paint(&mut buf, |x, y| disc_cov(x, y, BADGE_CX, BADGE_CY, DOT_R), p.accent);
        }
        TrayState::HighPriorityReminder => {
            erase_disc(&mut buf, BADGE_CX, TRI_CY, TRI_R + SEP);
            paint(&mut buf, triangle_cov, p.warn);
        }
        TrayState::SanityOverload => {
            erase_disc(&mut buf, BADGE_CX, BADGE_CY, RING_OUTER + SEP);
            paint(&mut buf, ring_cov, p.ring);
        }
    }
    buf
}

/// 全透明图标（闪烁的「灭帧」）也是托盘空位的合法内容
pub fn blank() -> Vec<u8> {
    vec![0; (SIZE * SIZE * 4) as usize]
}

// ---------------------------------------------------------------- 几何（viewBox 24×24）

/// Lucide `list-checks`（ISC）的折线 —— 3 条横线 + 2 个勾（`d` 里的 m/l/h 命令展平）
const GLYPH: &[&[(f32, f32)]] = &[
    &[(13.0, 5.0), (21.0, 5.0)],
    &[(13.0, 12.0), (21.0, 12.0)],
    &[(13.0, 19.0), (21.0, 19.0)],
    &[(3.0, 17.0), (5.0, 19.0), (9.0, 15.0)],
    &[(3.0, 7.0), (5.0, 9.0), (9.0, 5.0)],
];

/// 描边半径：`stroke-width: 2`（viewBox 单位）的一半 → 逻辑像素
const STROKE_HALF: f32 = UNIT;

/// 基形（描边后的 `list-checks`）在某点的覆盖率
fn glyph_coverage(x: f32, y: f32) -> f32 {
    let mut best: f32 = 0.0;
    for line in GLYPH {
        for w in line.windows(2) {
            let ax = INSET + w[0].0 * UNIT;
            let ay = INSET + w[0].1 * UNIT;
            let bx = INSET + w[1].0 * UNIT;
            let by = INSET + w[1].1 * UNIT;
            let cov = soft(segment_distance(x, y, ax, ay, bx, by), STROKE_HALF);
            if cov > best {
                best = cov;
            }
        }
    }
    best
}

/// 圆在某点的覆盖率（半径已含软边）
fn disc_cov(x: f32, y: f32, cx: f32, cy: f32, r: f32) -> f32 {
    soft(((x - cx).powi(2) + (y - cy).powi(2)).sqrt(), r)
}

/// 空心环：外圆减去内圆（`盘-18` 的「空心红环」——环心必须透）
fn ring_cov(x: f32, y: f32) -> f32 {
    (disc_cov(x, y, BADGE_CX, BADGE_CY, RING_OUTER) - disc_cov(x, y, BADGE_CX, BADGE_CY, RING_INNER))
        .max(0.0)
}

/// 提醒三角（顶点在上）：样张同一组顶点
fn triangle_cov(x: f32, y: f32) -> f32 {
    let cx = BADGE_CX;
    let cy = TRI_CY;
    let r = TRI_R;
    let pts = [
        (cx, cy - 0.92 * r),
        (cx + 0.86 * r, cy + 0.62 * r),
        (cx - 0.86 * r, cy + 0.62 * r),
    ];
    if point_in_triangle(x, y, pts) {
        1.0
    } else {
        0.0
    }
}

/// 重心符号法（与样张 `fillPolygon` 同口径）
fn point_in_triangle(px: f32, py: f32, pts: [(f32, f32); 3]) -> bool {
    let sign = |a: (f32, f32), b: (f32, f32), c: (f32, f32)| {
        (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
    };
    let pt = (px, py);
    let d1 = sign(pts[0], pts[1], pt);
    let d2 = sign(pts[1], pts[2], pt);
    let d3 = sign(pts[2], pts[0], pt);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// 覆盖率：距离 `half` 以内为 1、之外为 0，软边 = 半个超采样像素
fn soft(d: f32, half: f32) -> f32 {
    ((half - d) * SS as f32 + 0.5).clamp(0.0, 1.0)
}

/// 点到线段的距离（圆笔刷描边的底座：线段距离天然给出圆头 / 圆角）
fn segment_distance(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let (vx, vy) = (bx - ax, by - ay);
    let (wx, wy) = (px - ax, py - ay);
    let len2 = vx * vx + vy * vy;
    let t = if len2 > 0.0 {
        ((wx * vx + wy * vy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (dx, dy) = (wx - vx * t, wy - vy * t);
    (dx * dx + dy * dy).sqrt()
}

// ---------------------------------------------------------------- 合成

/// 把一层覆盖率贴进缓冲（straight alpha；`SS×SS` 子采样平均）
fn paint<F: Fn(f32, f32) -> f32>(buf: &mut [u8], cov: F, color: [u8; 4]) {
    let step = 1.0 / SS as f32;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut sum = 0.0;
            for sy in 0..SS {
                for sx in 0..SS {
                    sum += cov(x as f32 + (sx as f32 + 0.5) * step, y as f32 + (sy as f32 + 0.5) * step);
                }
            }
            let a = sum / (SS * SS) as f32;
            if a <= 0.0 {
                continue;
            }
            let i = ((y * SIZE + x) * 4) as usize;
            let prev_a = f32::from(buf[i + 3]) / 255.0;
            let out_a = a + prev_a * (1.0 - a);
            if out_a <= 0.0 {
                continue;
            }
            for c in 0..3 {
                let prev = f32::from(buf[i + c]);
                let v = (f32::from(color[c]) * a + prev * prev_a * (1.0 - a)) / out_a;
                buf[i + c] = v.round().clamp(0.0, 255.0) as u8;
            }
            buf[i + 3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
}

/// 把一层覆盖率从缓冲里**挖掉**（透明分离环；只动 alpha，颜色留着不管）
fn erase<F: Fn(f32, f32) -> f32>(buf: &mut [u8], cov: F) {
    let step = 1.0 / SS as f32;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut sum = 0.0;
            for sy in 0..SS {
                for sx in 0..SS {
                    sum += cov(x as f32 + (sx as f32 + 0.5) * step, y as f32 + (sy as f32 + 0.5) * step);
                }
            }
            let a = sum / (SS * SS) as f32;
            if a <= 0.0 {
                continue;
            }
            let i = ((y * SIZE + x) * 4) as usize;
            let next = (f32::from(buf[i + 3]) * (1.0 - a)).round().clamp(0.0, 255.0);
            buf[i + 3] = next as u8;
        }
    }
}

/// 挖掉一枚圆（分离环的底座）
fn erase_disc(buf: &mut [u8], cx: f32, cy: f32, r: f32) {
    erase(buf, |x, y| disc_cov(x, y, cx, cy, r));
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLEAR: [u8; 4] = [0, 0, 0, 0];

    fn px(buf: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * SIZE + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    fn alpha_mask(buf: &[u8]) -> Vec<u8> {
        buf.iter().skip(3).step_by(4).copied().collect()
    }

    fn colored(buf: &[u8]) -> usize {
        alpha_mask(buf).iter().filter(|a| **a > 8).count()
    }

    /// WCAG 相对亮度（与前端 `tools/visual/contrast.mjs` 同一套公式）
    fn luminance(c: [u8; 4]) -> f32 {
        let lin = |v: u8| {
            let s = f32::from(v) / 255.0;
            if s <= 0.04045 {
                s / 12.92
            } else {
                ((s + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
    }

    fn contrast(a: [u8; 4], b: [u8; 4]) -> f32 {
        let (x, y) = {
            let (la, lb) = (luminance(a), luminance(b));
            if la > lb {
                (la, lb)
            } else {
                (lb, la)
            }
        };
        (x + 0.05) / (y + 0.05)
    }

    /// 四态都是 SIZE×SIZE RGBA，且四角必须透明
    /// （否则托盘里会出现一个白底方块 —— 常见低级错误；`盘-08` 保留项）
    #[test]
    fn test_all_icons_are_sized_and_transparent_at_corners() {
        for light in [true, false] {
            for state in [
                TrayState::Default,
                TrayState::HasCurrentTask,
                TrayState::HighPriorityReminder,
                TrayState::SanityOverload,
            ] {
                let buf = for_state(state, light);
                assert_eq!(buf.len(), (SIZE * SIZE * 4) as usize, "尺寸必须是 SIZE×SIZE RGBA");
                assert_eq!(px(&buf, 0, 0), CLEAR, "{state:?} 左上角要透明");
                assert_eq!(px(&buf, SIZE - 1, 0), CLEAR, "{state:?} 右上角要透明");
                assert_eq!(px(&buf, 0, SIZE - 1), CLEAR, "{state:?} 左下角要透明");
                assert_eq!(px(&buf, SIZE - 1, SIZE - 1), CLEAR, "{state:?} 右下角要透明");
            }
        }
    }

    /// 默认态是**描边**：中心透明、左侧勾附近有色（基形真的画上了）
    #[test]
    fn test_default_is_outline_with_ink_color() {
        let buf = for_state(TrayState::Default, true);
        // 描边 ≠ 实心：两条横线之间（x=16, y=11）应当是空的
        //（⚠️ 别拿几何中心 (16,16) 当靶子：`list-checks` 的中间横线正好穿过那里）
        let hollow = px(&buf, 16, 11);
        assert!(hollow[3] < 8, "两条横线之间应当透明，实为 {hollow:?}");
        // 基形至少铺开一片：>120 个可见像素（28px 的描边图形）
        assert!(colored(&buf) > 120, "基形太小：可见像素 {}", colored(&buf));
        // 顶横线正中（viewBox 13–21, y=5 → 逻辑 x≈19.7、y≈7.83）应是墨色
        let ink = px(&buf, 24, 8);
        assert_eq!([ink[0], ink[1], ink[2]], [0x4a, 0x45, 0x3d], "横线上应是基色");
    }

    /// 有任务 = 基形换强调色 + 右下实心点（点心应是强调色，且**不是**分离环的底色）
    #[test]
    fn test_has_current_task_has_accent_dot() {
        let buf = for_state(TrayState::HasCurrentTask, true);
        let dot = px(&buf, 23, 23);
        assert_eq!([dot[0], dot[1], dot[2]], [0x0b, 0x60, 0x47], "右下应是实心强调点");
        // 分离环是**挖空**的（透明）：第三个勾线本来穿过徽标这一带（y≈24、x 16–27），
        // 但点在 r 6.5–8.1 的那圈应当被挖掉 → 取 (16,23)（离徽标圆心 ≈7.3）
        let sep = px(&buf, 16, 23);
        assert!(sep[3] < 8, "徽标外的分离环该是透明的（把基形挖断），实为 {sep:?}");
        // 基形也被换成强调色（左上勾）
        let ink = px(&buf, 5, 21);
        assert_eq!([ink[0], ink[1], ink[2]], [0x0b, 0x60, 0x47], "有任务时基形换强调色");
    }

    /// 提醒 = 右下实心三角（三角内有警示色；三角左上外透明）
    #[test]
    fn test_high_priority_has_warn_triangle() {
        let buf = for_state(TrayState::HighPriorityReminder, true);
        let inside = px(&buf, 23, 27);
        assert_eq!([inside[0], inside[1], inside[2]], [0xb3, 0x3a, 0x09], "三角内部应是警示色");
        assert!(px(&buf, 15, 27)[3] < 8, "三角左侧外应透明");
        // 基形仍是中性墨色（提醒不改基形）
        let ink = px(&buf, 5, 21);
        assert_eq!([ink[0], ink[1], ink[2]], [0x4a, 0x45, 0x3d], "提醒态基形保持墨色");
    }

    /// 超载 = 右下**空心**红环：环上有色、**环心透明**（`盘-18` 的关键）
    #[test]
    fn test_sanity_overload_has_hollow_ring() {
        let buf = for_state(TrayState::SanityOverload, true);
        // 环带中心：圆心 (23.5,23.5)、环带中点 r≈7.3 → (23.5+7.3, 23.5) ≈ (31, 23) 会出画布，
        // 改用「环上偏上」的点：(23.5, 23.5-7.3) ≈ (23, 16)
        let on_ring = px(&buf, 23, 16);
        assert_eq!([on_ring[0], on_ring[1], on_ring[2]], [0xb3, 0x2a, 0x1e], "环带上应是红环色");
        let center = px(&buf, 23, 23);
        assert!(center[3] < 8, "环心必须透明（空心），实为 {center:?}");
    }

    /// `盘-08`：两套色**同一形状的 alpha 掩码逐像素相同**（换色不改形）
    #[test]
    fn test_palettes_share_the_same_alpha_mask() {
        for state in [
            TrayState::Default,
            TrayState::HasCurrentTask,
            TrayState::HighPriorityReminder,
            TrayState::SanityOverload,
        ] {
            assert_eq!(
                alpha_mask(&for_state(state, true)),
                alpha_mask(&for_state(state, false)),
                "{state:?} 的 alpha 掩码不该随配色变"
            );
        }
    }

    /// `盘-08`：16 / 20 / 32 三个尺寸下四态都非空且互不相同
    /// （面积平均降采样 ≈ 系统把 32px 位图缩到 20 / 16px 的那一步）
    #[test]
    fn test_four_states_stay_distinct_at_16_20_32() {
        fn downsample(buf: &[u8], out: u32) -> Vec<u8> {
            let k = SIZE / out;
            let mut dst = vec![0u8; (out * out * 4) as usize];
            for y in 0..out {
                for x in 0..out {
                    let mut acc = [0u32; 4];
                    for sy in 0..k {
                        for sx in 0..k {
                            let i = (((y * k + sy) * SIZE + (x * k + sx)) * 4) as usize;
                            for c in 0..4 {
                                acc[c] += u32::from(buf[i + c]);
                            }
                        }
                    }
                    let n = k * k;
                    let j = ((y * out + x) * 4) as usize;
                    for c in 0..4 {
                        dst[j + c] = (acc[c] / n) as u8;
                    }
                }
            }
            dst
        }
        for size in [16u32, 20, 32] {
            let mut signatures = Vec::new();
            for state in [
                TrayState::Default,
                TrayState::HasCurrentTask,
                TrayState::HighPriorityReminder,
                TrayState::SanityOverload,
            ] {
                let small = downsample(&for_state(state, true), size);
                let visible = small.iter().skip(3).step_by(4).filter(|a| **a > 24).count();
                assert!(visible > (size * size / 20) as usize, "{size}px 的 {state:?} 太稀：{visible} 像素");
                // 签名 = 可见像素数 + alpha 总和（够分辨四态）
                let sum: u32 = small.iter().skip(3).step_by(4).map(|a| u32::from(*a)).sum();
                signatures.push(format!("{state:?}:{visible}:{sum}"));
            }
            let unique: std::collections::HashSet<_> = signatures.iter().collect();
            assert_eq!(unique.len(), 4, "{size}px 下四态应互不相同：{signatures:?}");
        }
    }

    /// `盘-15`：两套墨色对任务栏底色都要 ≥ 3:1（WCAG 1.4.11）—— 把调研表变成断言
    #[test]
    fn test_palette_contrast_against_taskbar() {
        let light = palette(true);
        for (name, c) in [
            ("base", light.base),
            ("accent", light.accent),
            ("warn", light.warn),
            ("ring", light.ring),
        ] {
            let r = contrast(c, TASKBAR_LIGHT);
            assert!(r >= 3.0, "亮任务栏 {name} 只有 {r:.2}:1（要 ≥3）");
        }
        let dark = palette(false);
        for (name, c) in [
            ("base", dark.base),
            ("accent", dark.accent),
            ("warn", dark.warn),
            ("ring", dark.ring),
        ] {
            let r = contrast(c, TASKBAR_DARK);
            assert!(r >= 3.0, "暗任务栏 {name} 只有 {r:.2}:1（要 ≥3）");
        }
    }

    /// 四态都可画（未知状态由 match 穷尽保证，不会走到 panic 分支）
    #[test]
    fn test_for_state_covers_every_state() {
        for light in [true, false] {
            for state in [
                TrayState::Default,
                TrayState::HasCurrentTask,
                TrayState::HighPriorityReminder,
                TrayState::SanityOverload,
            ] {
                assert_eq!(for_state(state, light).len(), (SIZE * SIZE * 4) as usize);
            }
        }
    }
}
