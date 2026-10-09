//! 必填层的「带按钮系统通知」（用户拍板 R11：必填层只走这条路，不再用右下角卡片）。
//!
//! 为什么绕过 `tauri-plugin-notification`：它在桌面端**显式忽略** action 字段 ——
//! 源码原话（`tauri-plugin-notification-2.5.0/src/desktop.rs`）：
//! `Only the title, body, icon and sound of the notification are used on desktop;
//! the scheduling, grouping and action related options are ignored.`
//! 所以我们拿不到 ✓/✗ 按钮，也拿不到点击回调。
//! 这里直接用底层的 `notify-rust` —— 它本来就在依赖树里（上面那个插件的传递依赖），不引入新包。
//!
//! spike 实测（MSI 装的非打包应用 + AUMID `com.wakeyweeky.app`，2026-09-28）：
//! 按钮能显示 ✓、应用名显示为 WakeyWeeky ✓、`Urgency::Critical` 让它常驻到处理 ✓、
//! 点击回传到进程内并带正确标识（`t=5.3s` 收到 `"missed"`）✓、**无需注册 COM 激活器** ✓。

use notify_rust::{Notification, NotificationResponse, Timeout, Urgency};
use rusqlite::Connection;
use crate::i18n;
use crate::tf;

/// 用户对提醒的回答
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    /// 点了「✓ 已完成」
    Done,
    /// 点了「✗ 未完成」
    Missed,
}

/// 用户对通知到底做了什么（三路）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastOutcome {
    /// 点了 ✓ 或 ✗ 按钮
    Answered(Answer),
    /// 点了**通知主体**（不是按钮）→ 应该把应用窗口带到前面（R12 的轻量版：
    /// 不用改安装包、不用注册 AUMID —— 实测这个事件会直接回到我们自己进程）
    BodyClicked,
    /// 被关闭/忽略了
    Dismissed,
}

/// 把 notify-rust 的回执映射成我们的结果（纯函数，可单测）
pub fn outcome_of(response: &NotificationResponse) -> ToastOutcome {
    match response {
        NotificationResponse::Action(action) => match action.as_str() {
            "done" => ToastOutcome::Answered(Answer::Done),
            "missed" => ToastOutcome::Answered(Answer::Missed),
            _ => ToastOutcome::Dismissed,
        },
        NotificationResponse::Default => ToastOutcome::BodyClicked,
        _ => ToastOutcome::Dismissed,
    }
}

/// 发送一条提醒。**不阻塞**：成功时返回一个「等待作答」的闭包 ——
/// 调用方把它丢进独立线程再调（它可能等很久）。
/// 这样写是因为 `notify_rust::NotificationHandle` 在 Windows 上**没有从 crate 根导出**，
/// 我们无法在签名里写出这个类型；把等待包进闭包就绕开了。
///
/// **标题与正文由调用方给**（C3 的合并提醒需要自定义正文：按 ①②③ 列出并标出「当前」那一条）。
///
/// `audible = false` 时保持静默 —— notify-rust 在 Windows 上「不设 `sound_name`」就是静默
/// （源码 `None => None` → `Toast::sound(None)`），所以同一轮里只有第一条显式要声音，
/// 几条同时到点就不会连响。
pub fn send(
    app_id: &str,
    summary: &str,
    body: &str,
    audible: bool,
) -> Result<Box<dyn FnOnce() -> ToastOutcome + Send>, String> {
    let mut notification = Notification::new();
    notification
        .app_id(app_id)
        .summary(summary)
        .body(body)
        .action("done", i18n::t(i18n::msg::SYS_TOAST_01))
        .action("missed", i18n::t(i18n::msg::SYS_TOAST_02))
        .urgency(Urgency::Critical) // → Windows 的 Reminder 场景：不自动消失，留在通知中心
        .timeout(Timeout::Never);
    if audible {
        notification.sound_name("Default");
    }

    let handle = notification
        .show()
        .map_err(|e| tf!(i18n::msg::SYS_TOAST_03, e = format!("{:?}", e)))?;

    Ok(Box::new(move || {
        let mut outcome = ToastOutcome::Dismissed;
        // wait_for_response 给的是完整回执：Action(id) / Default(主体点击) / Closed(...)
        // 用 wait_for_action 不行 —— 它会把「主体点击」和「被关闭」都归成 "__closed"，分不开。
        let _ = handle.wait_for_response(|response: &NotificationResponse| {
            outcome = outcome_of(response);
        });
        outcome
    }))
}

/// 把回答落到数据库（纯函数，可单测）。复用现有的标记函数，不新写状态机。
/// 块已被删 / 已被标记时不会报错（N3：幂等，只是没有实际变化）。
pub fn apply_answer(conn: &Connection, block_id: &str, answer: Answer) -> Result<(), String> {
    // N3：块可能已经被删了（例如用户先在应用里删了它，之后才看到通知）——
    // 那就什么也不做、只留一行日志。注：db 的标记函数对「块不存在」是**报错**的（实测），所以这里先查一下。
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM blocks WHERE id = ?1)",
            [block_id],
            |r| r.get(0),
        )
        .map_err(|e| tf!(i18n::msg::SYS_TOAST_04, e = e))?;
    if !exists {
        eprintln!("[notify] 按钮回答对应的块已不存在（{block_id}）→ 忽略，不改数据");
        return Ok(());
    }

    match answer {
        Answer::Done => crate::db::mark_block_done(conn, block_id).map(|_| ()),
        Answer::Missed => crate::db::mark_block_missed(conn, block_id).map(|_| ()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_block, create_task, list_blocks, test_conn};

    /// 三路回执的映射（N1/N2 + 主体点击）
    #[test]
    fn test_outcome_mapping() {
        assert_eq!(
            outcome_of(&NotificationResponse::Action("done".into())),
            ToastOutcome::Answered(Answer::Done)
        );
        assert_eq!(
            outcome_of(&NotificationResponse::Action("missed".into())),
            ToastOutcome::Answered(Answer::Missed)
        );
        assert_eq!(
            outcome_of(&NotificationResponse::Default),
            ToastOutcome::BodyClicked,
            "点主题是 Default（源码注释：a body-click on Windows）"
        );
        assert_eq!(
            outcome_of(&NotificationResponse::Action("未知按钮".into())),
            ToastOutcome::Dismissed,
            "不认识的按钮标识当没作答，不能乱改数据"
        );
        assert_eq!(
            outcome_of(&NotificationResponse::Closed(notify_rust::CloseReason::Dismissed)),
            ToastOutcome::Dismissed
        );
    }

    /// N1/N2：点哪个按钮就落哪个状态
    #[test]
    fn test_apply_answer_marks_done_and_missed() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let first = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");
        let second = create_block(&conn, &task.id, 3_000, 4_800).expect("建块失败");

        apply_answer(&conn, &first.id, Answer::Done).expect("标记完成失败");
        apply_answer(&conn, &second.id, Answer::Missed).expect("标记未完成失败");

        let blocks = list_blocks(&conn, 0, 10_000).expect("查询失败");
        assert_eq!(blocks[0].status, "done", "点 ✓ 应标记完成");
        assert_eq!(blocks[1].status, "missed", "点 ✗ 应标记未完成");
    }

    /// N3：重复回答、或块已被删 —— 不报错、不改坏数据
    #[test]
    fn test_apply_answer_is_idempotent_and_tolerates_missing_block() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let block = create_block(&conn, &task.id, 1_000, 2_800).expect("建块失败");

        apply_answer(&conn, &block.id, Answer::Done).expect("第一次标记");
        apply_answer(&conn, &block.id, Answer::Done).expect("重复标记同一个块不应报错（N3）");
        apply_answer(&conn, "不存在的块", Answer::Missed).expect("块已被删时不应报错（N3）");

        let blocks = list_blocks(&conn, 0, 10_000).expect("查询失败");
        assert_eq!(blocks[0].status, "done", "重复回答不能把状态改坏");
    }
}
