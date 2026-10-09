//! 测试专用的共享小工具（round62：备份测试也要建临时目录 —— 不再各写一份）。
//!
//! 只在 `cargo test` 里编译（`lib.rs` 用 `#[cfg(test)]` 挂着）。

use std::path::{Path, PathBuf};
use crate::i18n;

/// 测试用临时目录：**Drop 时自动删**（断言失败 / panic 也会删）。
///
/// 为什么不裸用 `std::env::temp_dir()`：清理写在测试末尾时，断言一失败就跑不到 →
/// 每跑一次 `cargo test` 都在 `%TEMP%` 留下目录（2026-10-01 维护轮清出 **92 个 / 9.8MB**，
/// 见 `docs/对账.md` §5-P）。只删自己刚建的那个 UUID 目录，不碰任何别的路径。
pub(crate) struct TempDir(PathBuf);

impl TempDir {
    pub(crate) fn new(prefix: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap_or_else(|_| panic!("{}", i18n::t(i18n::msg::ERR_TESTUTIL_01)));
        Self(dir)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }

    pub(crate) fn join(&self, name: impl AsRef<Path>) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
