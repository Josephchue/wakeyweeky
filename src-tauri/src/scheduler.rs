//! 任务计划程序兜底（C13；v2 A8 已拍板：**调用系统 `schtasks.exe`，不引入 crate**）。
//!
//! 目的（v5 需求原文）：「应用关闭后 Windows 任务计划程序仍触发提醒」。
//! 唤醒后应用**隐藏启动并留在托盘** —— 因为带 ✓/✗ 按钮的通知需要进程活着（见 `notify/toast.rs`）。
//!
//! spike 实测（2026-09-29 本机，shell **未提权**）：
//! - 非管理员能建/删任务 ✓
//! - 空格路径引用正确：`<Command>"C:\...\ww space test\arglog.exe"</Command>` ✓
//! - 到点在**分钟边界**触发，参数 `--scheduled` 完整送达 ✓
//! - **`<LogonType>InteractiveToken</LogonType>`** → 交互式会话，唤醒的应用能弹通知 ✓
//!
//! 设计要点：
//! - 任务名固定（同一时刻只有一个 ✓，`/F` 覆盖即更新 ✓）
//! - `/SD` 必须配 `/ST`（否则按「今天」算，跨天会排到过去）；`/Z` 跑完自删；`/RL LIMITED` 不提权
//! - 一切失败**只记日志**：兜底手段出问题绝不能影响应用本体
//! - 记住「已经注册到的时刻」，避免每轮扫描（≤60 秒）都去起一个 schtasks 进程

use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use crate::i18n;
use crate::tf;

/// 计划任务名（Task Scheduler 里的文件夹 + 任务）
pub const TASK_NAME: &str = "WakeyWeeky\\Reminder";
/// 被唤醒时带的参数：`lib.rs` 据此**隐藏主窗口**启动
pub const SCHEDULED_FLAG: &str = "--scheduled";

/// 触发时刻
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trigger {
    /// ISO 格式（任务 XML 用；**与系统区域设置无关**）
    pub iso: String,
    /// 日志里给人看的（本地 mm-dd HH:MM）
    pub display: String,
}

/// 把 UTC 时间戳换算成本地触发时刻（纯函数：只依赖入参与本机时区）
pub fn trigger_at(unix_secs: i64) -> Trigger {
    use chrono::{Local, TimeZone};
    let local = Local
        .timestamp_opt(unix_secs, 0)
        .single()
        .unwrap_or_else(|| Local.timestamp_opt(0, 0).unwrap());
    Trigger {
        iso: local.format("%Y-%m-%dT%H:%M:00").to_string(),
        display: local.format("%m-%d %H:%M").to_string(),
    }
}

/// 任务定义 XML。
///
/// **两个踩过的坑**（都由 Windows 自己导出的 XML 当模板纠正，见 docs/plans/round6-c13.md）：
/// 1. 顶层元素顺序是 **`RegistrationInfo → Principals → Settings → Triggers → Actions`** ——
///    XSD 是 `xs:sequence`，顺序错就报「任务 XML 缺少必需的元素或特性」（E2E 实测）。
/// 2. XML 声明写的是 `UTF-16`，**字节就必须是 UTF-16**（见 `write_xml`），否则同样报上面那个错。
///
/// 另外：不用 `schtasks /Create /SD` —— 它要求系统「短日期」格式（本机 zh-CN 只认 `yyyy/mm/dd`，
/// 而英文文档写 `MM/DD/YYYY`），XML 里的 ISO 时间跟区域设置无关。
pub fn task_xml(exe: &str, trigger: &Trigger) -> String {
    tf!(i18n::msg::ERR_SCHEDULER_04, boundary = trigger.iso, exe = xml_escape(exe), flag = SCHEDULED_FLAG)
}

/// 写出任务 XML：**UTF-16LE + BOM**（与声明一致，schtasks 按声明解析）。
fn write_xml(path: &std::path::Path, xml: &str) -> std::io::Result<()> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in xml.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::write(path, bytes)
}

/// XML 文本转义（路径里出现 `&`、`<` 等字符时不至于生成非法 XML）
fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `schtasks /Create /XML` 的参数（纯函数，便于单测）
pub fn create_args(xml_path: &str) -> Vec<String> {
    vec![
        "/Create".into(),
        "/TN".into(),
        TASK_NAME.into(),
        "/XML".into(),
        xml_path.into(),
        "/F".into(), // 同名覆盖：注册即更新
    ]
}

/// `schtasks /Delete` 的参数
pub fn delete_args() -> Vec<String> {
    vec!["/Delete".into(), "/TN".into(), TASK_NAME.into(), "/F".into()]
}

/// 已经注册到的触发时刻（`i64::MIN` = 还没注册过；`0` = 已确认为「无任务」状态）
static REGISTERED_AT: AtomicI64 = AtomicI64::new(i64::MIN);
/// 上次**实际调用** schtasks 的时间（秒）
static LAST_ASSERT_AT: AtomicI64 = AtomicI64::new(0);
/// 即使触发时刻没变，也每隔这么久重新确认一次任务还在：
/// 用户可能自己在「任务计划程序」里把它删了 —— S11 实测：不重新确认，任务就永远不会回来。
const REASSERT_SECONDS: i64 = 5 * 60;

/// 纯函数（可单测）：这次要不要真的去跑 schtasks？
/// - 目标变了 → 必须同步
/// - 目标没变，但距上次确认已超过 `REASSERT_SECONDS` → 重新确认一次（S11）
/// - 目标是「无任务」且已经确认过 → 不必反复去删（删不存在的任务毫无意义）
fn needs_sync(registered: i64, want: i64, now: i64, last_assert: i64) -> bool {
    if registered != want {
        return true;
    }
    if want == 0 {
        return false;
    }
    now - last_assert >= REASSERT_SECONDS
}

/// 把计划任务对齐到 `at`：`Some(时刻)` = 注册/更新；`None` = 没有待办 → 删除（不留残留）。
/// 触发时刻与上次相同则**什么都不做**（省掉每分钟一次的进程启动）。
pub fn sync(exe: &str, at: Option<i64>) {
    let want = at.unwrap_or(0);
    let now = crate::db::now();
    if !needs_sync(
        REGISTERED_AT.load(Ordering::SeqCst),
        want,
        now,
        LAST_ASSERT_AT.load(Ordering::SeqCst),
    ) {
        return;
    }

    let reassert = REGISTERED_AT.load(Ordering::SeqCst) == want; // 目标没变，只是到期重新确认

    let ok = match at {
        Some(secs) => {
            let trigger = trigger_at(secs);
            if reassert {
                eprintln!("[scheduler] 重新确认提醒任务还在（每 {} 分钟一次）", REASSERT_SECONDS / 60);
            } else {
                eprintln!(
                    "[scheduler] 注册提醒任务：{}（唤醒后隐藏启动）",
                    trigger.display
                );
            }
            // XML 写进临时目录，交给 schtasks 读取（`/F` 覆盖同名任务）
            let xml_path = std::env::temp_dir().join("wakeyweeky-reminder-task.xml");
            match write_xml(&xml_path, &task_xml(exe, &trigger)) {
                Ok(_) => {
                    let result = run(&create_args(&xml_path.display().to_string()), i18n::t(i18n::msg::ERR_SCHEDULER_01));
                    match &result {
                        // 这个 XML 是一次性的（`schtasks /Create /XML` 读一次就不再需要）→ 成功就删，
                        // 免得在 %TEMP% 常驻（2026-10-01 维护轮发现它一直留着）；
                        // **失败则保留当证据**（下次重试会覆盖它）。
                        Ok(_) => {
                            let _ = std::fs::remove_file(&xml_path);
                        }
                        Err(e) => eprintln!("[scheduler] {e}"),
                    }
                    result.is_ok()
                }
                Err(e) => {
                    eprintln!("[scheduler] 写任务 XML 失败：{e}");
                    false
                }
            }
        }
        None => {
            eprintln!("[scheduler] 没有注册中的任务需要保留 → 清理提醒任务");
            if let Err(e) = run(&delete_args(), i18n::t(i18n::msg::ERR_SCHEDULER_02)) {
                // 任务不存在**也算「已经干净」**：schtasks 会把「找不到」当错误返回，
                // 若不这样处理，每分钟都会重试并刷一条错误日志（E2E 实测踩过）。
                // （任务真被删掉了的旁证：注册→触发→应用清理，链条在 E2E 里验证过 ✓）
                eprintln!("[scheduler] {e} → 任务本来就不在，视为已清理");
            }
            true
        }
    };

    // 只有成功才记住：失败时下一轮会重试（S5）
    if ok {
        REGISTERED_AT.store(want, Ordering::SeqCst);
    }
    LAST_ASSERT_AT.store(now, Ordering::SeqCst);
}

/// 执行一条 schtasks 命令。成功返回 Ok(())，失败返回错误描述（调用方决定怎么处理）。
fn run(args: &[String], what: &str) -> Result<(), String> {
    let mut command = Command::new("schtasks");
    command.args(args);
    // 应用是 GUI 程序：不加这个标志会在唤醒时闪一下黑框控制台
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match command.output() {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            Err(tf!(i18n::msg::ERR_SCHEDULER_05, what = what, p1 = format!("{:?}", out.status.code()), p2 = stdout.trim(), p3 = stderr.trim()))
        }
        Err(e) => Err(tf!(i18n::msg::ERR_SCHEDULER_03, what = what, e = e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Program Files\WakeyWeeky\wakeyweeky.exe";

    fn trigger_stub() -> Trigger {
        Trigger {
            iso: "2026-09-29T20:42:00".into(),
            display: "09-29 20:42".into(),
        }
    }

    fn contains_pair(args: &[String], key: &str, value: &str) -> bool {
        args.windows(2).any(|w| w[0] == key && w[1] == value)
    }

    /// XML 的关键内容：ISO 时间 / 路径 / 隐藏启动参数 / 交互式身份 / 不提权
    #[test]
    fn test_task_xml_shape() {
        let xml = task_xml(EXE, &trigger_stub());
        assert!(
            xml.contains("<StartBoundary>2026-09-29T20:42:00</StartBoundary>"),
            "用 ISO 时间（跟系统区域设置无关）"
        );
        assert!(
            xml.contains(&format!("<Command>{EXE}</Command>")),
            "exe 路径原样进 XML（不需要引号）"
        );
        assert!(
            xml.contains(&format!("<Arguments>{SCHEDULED_FLAG}</Arguments>")),
            "必须带上隐藏启动参数"
        );
        assert!(
            xml.contains("<LogonType>InteractiveToken</LogonType>"),
            "必须交互式身份，否则唤醒后弹不出通知"
        );
        assert!(
            xml.contains("<RunLevel>LeastPrivilege</RunLevel>"),
            "不提权，避免唤醒时弹 UAC"
        );
        assert!(
            xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"),
            "已在跑时不要重复启动"
        );
        assert!(
            xml.contains("<StartWhenAvailable>true</StartWhenAvailable>"),
            "错过的触发（重启后过期、睡眠错过）要尽快补跑，否则提醒就白排了"
        );
        assert!(
            xml.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"),
            "用电池时也要能唤醒（提醒工具不该在电池上罢工）"
        );
    }

    /// **顺序**：XSD 是 `xs:sequence`，排错就报「缺少必需的元素或特性」（E2E 实测踩过）
    #[test]
    fn test_task_xml_element_order() {
        let xml = task_xml(EXE, &trigger_stub());
        let at = |needle: &str| {
            xml.find(needle)
                .unwrap_or_else(|| panic!("XML 里必须有 {needle}"))
        };
        assert!(at("<RegistrationInfo>") < at("<Principals>"), "RegistrationInfo 在最前");
        assert!(at("<Principals>") < at("<Settings>"), "Principals 在 Settings 之前");
        assert!(at("<Settings>") < at("<Triggers>"), "Settings 在 Triggers 之前");
        assert!(at("<Triggers>") < at("<Actions"), "Triggers 在 Actions 之前");
    }

    /// 写盘必须是 **UTF-16LE + BOM**：声明写 UTF-16，字节就必须是 UTF-16（否则同样报缺元素）
    #[test]
    fn test_write_xml_is_utf16_with_bom() {
        let dir = std::env::temp_dir().join(format!("ww-sched-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        let path = dir.join("task.xml");
        let xml = task_xml(EXE, &trigger_stub());
        write_xml(&path, &xml).expect("写 XML 失败");

        let bytes = std::fs::read(&path).expect("读回失败");
        assert_eq!(&bytes[..2], &[0xFF, 0xFE], "必须有 UTF-16LE BOM");
        assert_eq!(bytes.len() % 2, 0, "UTF-16 的字节数必须是偶数");
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        assert_eq!(
            String::from_utf16(&units).expect("必须是合法 UTF-16"),
            xml,
            "编解码往返必须一致"
        );

        // 清理（只删明确路径，不递归删目录）
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    /// 路径里的 XML 特殊字符必须转义，否则生成的任务定义是非法的
    #[test]
    fn test_task_xml_escapes_special_chars() {
        let xml = task_xml(r"C:\A & B\<weird>\app.exe", &trigger_stub());
        assert!(
            xml.contains("<Command>C:\\A &amp; B\\&lt;weird&gt;\\app.exe</Command>"),
            "& < > 都要转义"
        );
    }

    /// 注册参数：走 XML（不再用 /SD，避开区域设置陷阱），并且同名覆盖
    #[test]
    fn test_create_args_shape() {
        let args = create_args(r"C:\Temp\x.xml");
        assert_eq!(args[0], "/Create");
        assert!(contains_pair(&args, "/TN", TASK_NAME), "任务名固定（同名即更新）");
        assert!(contains_pair(&args, "/XML", r"C:\Temp\x.xml"));
        assert!(args.contains(&"/F".to_string()), "同名覆盖");
        assert!(!args.contains(&"/SD".to_string()), "不再使用 /SD");
    }

    /// 删除参数
    #[test]
    fn test_delete_args_shape() {
        let args = delete_args();
        assert_eq!(args[0], "/Delete");
        assert!(contains_pair(&args, "/TN", TASK_NAME));
        assert!(args.contains(&"/F".to_string()), "删不存在的任务也要当成成功");
    }

    /// 同步节流：目标变了必同步；目标没变则每 5 分钟重新确认一次（S11 实测教训）
    #[test]
    fn test_needs_sync_throttling() {
        let t = 1_000_000i64;
        // 还没注册过（i64::MIN）→ 必须同步
        assert!(needs_sync(i64::MIN, 5_000, t, 0));
        // 目标变了 → 必须同步
        assert!(needs_sync(5_000, 6_000, t, t));
        // 目标没变、刚确认过 → 跳过（省进程）
        assert!(!needs_sync(5_000, 5_000, t, t - 10));
        // 目标没变、但距上次确认 >= 5 分钟 → 重新确认（用户可能自己删了任务）
        assert!(needs_sync(5_000, 5_000, t, t - REASSERT_SECONDS));
        assert!(needs_sync(5_000, 5_000, t, t - REASSERT_SECONDS - 1));
        // 「无任务」状态不需要反复删
        assert!(!needs_sync(0, 0, t, t - 10 * REASSERT_SECONDS));
    }

    /// 触发时刻：ISO 能被解析回同一个「分钟」（结果依赖本机时区，往返必须一致）
    #[test]
    fn test_trigger_at_round_trip() {
        use chrono::{Local, NaiveDateTime, TimeZone};
        let secs = 1_800_000_000i64;
        let trigger = trigger_at(secs);

        let naive = NaiveDateTime::parse_from_str(&trigger.iso, "%Y-%m-%dT%H:%M:%S")
            .expect("生成的 ISO 时间必须能被解析回来");
        let back = Local
            .from_local_datetime(&naive)
            .single()
            .expect("本地时间应唯一")
            .timestamp();
        assert_eq!(back, secs - (secs % 60), "往返后应等于原时间戳（截到分钟）");
        assert!(!trigger.display.is_empty(), "日志用的展示串不能为空");
    }
}
