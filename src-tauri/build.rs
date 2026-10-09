// round73（3.0b₁）：除了 Tauri 的构建动作，还把文案资源层（`messages/zh.json`，与前端同一份）
// 在**编译期**生成成 Rust 常量与查表（`$OUT_DIR/i18n_generated.rs`，由 `src/i18n.rs` include!）。
// round74（3.0b₂）：同时读 `messages/en.json` 生成 `TABLE_EN`（双语；缺键由 `i18n::t` 回落中文）。
//
// 纪律：
// - 生成 = 唯一实现；手写常量会与前端漂移 ✗。
// - 值必须是 string→string 的扁平 JSON（前端 `t()` 也按同一形状 import）。
// - key 转成常量名（大写 + 非字母数字 → `_`）；**重名 = 构建失败**（撞名说明 key 设计有问题）。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

fn main() {
    tauri_build::build();
    gen_i18n();
}

fn gen_i18n() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let zh = read_table(&Path::new(&manifest).join("../messages/zh.json"));
    let en = read_table(&Path::new(&manifest).join("../messages/en.json"));

    let mut seen = BTreeMap::new();
    for key in zh.keys() {
        let name = const_name(key);
        if let Some(other) = seen.insert(name.clone(), key.clone()) {
            panic!("常量名撞车：{name} ← {other} / {key}");
        }
    }

    let mut code = String::new();
    code.push_str("// round73（3.0b₁）：由 src-tauri/build.rs 从 messages/{zh,en}.json 生成 —— 不要手改。\n");
    code.push_str("pub mod msg {\n");
    for key in zh.keys() {
        code.push_str(&format!("    pub const {}: &str = {:?};\n", const_name(key), key));
    }
    code.push_str("}\n\n");
    push_table(&mut code, "TABLE_ZH", &zh, &zh.keys().cloned().collect());
    push_table(&mut code, "TABLE_EN", &en, &zh.keys().cloned().collect());

    let out = std::env::var("OUT_DIR").expect("OUT_DIR");
    std::fs::write(Path::new(&out).join("i18n_generated.rs"), code).expect("写 i18n_generated.rs");
}

fn read_table(src: &Path) -> BTreeMap<String, String> {
    println!("cargo:rerun-if-changed={}", src.display());
    let text = std::fs::read_to_string(src)
        .unwrap_or_else(|e| panic!("读不到 {}：{e}（文案资源层是构建必需品）", src.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("{} 必须是 string→string 的扁平 JSON：{e}", src.display()))
}

fn push_table(
    code: &mut String,
    name: &str,
    map: &BTreeMap<String, String>,
    zh_keys: &BTreeSet<String>,
) {
    // 中文表里的键全部用 `msg::*` 常量引用（常量因此不会报 dead_code）；
    // 英文表里 `x.one`/`x.other` 这类中文表没有的键（round74 复数扩展）用字符串字面量。
    code.push_str(&format!("pub static {name}: &[(&str, &str)] = &[\n"));
    for (key, value) in map {
        if zh_keys.contains(key) {
            code.push_str(&format!("    (msg::{}, {:?}),\n", const_name(key), value));
        } else {
            code.push_str(&format!("    ({:?}, {:?}),\n", key, value));
        }
    }
    code.push_str("];\n\n");
}

fn const_name(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
        .collect()
}
