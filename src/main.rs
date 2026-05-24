//! disk-insight Phase 1: MFT列挙CLI
//! 実行には管理者権限が必要です。

mod mft;
mod mft_probe;
mod mft_raw;

use anyhow::Result;

fn main() -> Result<()> {
    // TODO: 引数でドライブ文字を受け取る（暫定でCドライブ固定）
    let drive = 'C';

    let args: Vec<String> = std::env::args().collect();
    let flag = args.iter().skip(1).find(|a| a.starts_with("--")).map(String::as_str);

    match flag {
        Some("--json") => {
            if let Err(e) = mft_probe::print_probe7_json(drive) {
                eprintln!("エラー: {}", e);
            }
        }
        _ => {
            if let Err(e) = mft_probe::print_probe7_human(drive) {
                eprintln!("エラー: {}", e);
            }
        }
    }

    Ok(())
}
