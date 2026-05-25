//! disk-insight - WizTree風高速ディスク分析ツール
//! 実行には管理者権限が必要です。

use anyhow::Result;
use disk_insight::mft_probe::{self, StoragePolicy};

fn print_help() {
    eprintln!("disk-insight - WizTree風高速ディスク分析ツール");
    eprintln!();
    eprintln!("使用法:");
    eprintln!("  disk-insight.exe [オプション]");
    eprintln!();
    eprintln!("オプション:");
    eprintln!("  --drive <letter>   対象ドライブ (例: C  C:  D  d) [デフォルト: C]");
    eprintln!("  --top <number>     上位件数 [デフォルト: human=30 / json=100]");
    eprintln!("  --json             JSON形式で stdout に出力");
    eprintln!("  --perf             フェーズ別タイミングを stderr に出力 (計測用)");
    eprintln!("  --wof-adjusted     Experimental WOF-adjusted allocation policy (no hardlink/component-store dedup)");
    eprintln!("  --diag-pfx86       Program Files (x86) 差分診断 (EdgeCore / Office16 / VFS)");
    eprintln!("  --diag-wof-global  WOF adjusted global simulation (diagnostic only)");
    eprintln!("  --diag-winsxs      WinSxS / Windows component store diagnostics");
    eprintln!("  --help             このヘルプを表示");
    eprintln!();
    eprintln!("使用例:");
    eprintln!("  disk-insight.exe");
    eprintln!("  disk-insight.exe --json");
    eprintln!("  disk-insight.exe --json --top 200");
    eprintln!("  disk-insight.exe --json --top 200 --wof-adjusted");
    eprintln!("  disk-insight.exe --drive C --top 50");
    eprintln!("  disk-insight.exe --drive C --json --top 100");
    eprintln!("  disk-insight.exe --drive C --top 50 --wof-adjusted");
    eprintln!("  disk-insight.exe --diag-pfx86");
    eprintln!("  disk-insight.exe --diag-wof-global");
    eprintln!("  disk-insight.exe --diag-winsxs");
    eprintln!();
    eprintln!("注意:");
    eprintln!("  管理者権限で実行してください (MFTアクセスに必要)。");
    eprintln!();
    eprintln!("JSON保存時の注意:");
    eprintln!("  PowerShell の > は UTF-16LE になる場合があります。");
    eprintln!("  JSON検証用途では以下を推奨:");
    eprintln!("    cmd /c \"disk-insight.exe --json > work\\probe7.json\"");
}

fn parse_drive(s: &str) -> Option<char> {
    let s = s.trim_end_matches(':');
    if s.len() == 1 {
        let c = s.chars().next()?;
        if c.is_ascii_alphabetic() {
            return Some(c.to_ascii_uppercase());
        }
    }
    None
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    let mut json_mode = false;
    let mut perf_mode = false;
    let mut diag_pfx86 = false;
    let mut diag_wof_global = false;
    let mut diag_winsxs = false;
    let mut storage_policy = StoragePolicy::Current;
    let mut drive = 'C';
    let mut top_n: Option<usize> = None;

    let mut i = 1usize;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => {
                json_mode = true;
                i += 1;
            }
            "--perf" => {
                perf_mode = true;
                i += 1;
            }
            "--wof-adjusted" => {
                storage_policy = StoragePolicy::WofAdjusted;
                i += 1;
            }
            "--diag-pfx86" => {
                diag_pfx86 = true;
                i += 1;
            }
            "--diag-wof-global" => {
                diag_wof_global = true;
                i += 1;
            }
            "--diag-winsxs" => {
                diag_winsxs = true;
                i += 1;
            }
            "--help" | "-h" => {
                print_help();
                return Ok(());
            }
            "--drive" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("エラー: missing value for --drive. 例: --drive C");
                    std::process::exit(1);
                }
                match parse_drive(&args[i]) {
                    Some(d) => drive = d,
                    None => {
                        eprintln!(
                            "エラー: invalid drive '{}'. 例: --drive C  --drive D:",
                            &args[i]
                        );
                        std::process::exit(1);
                    }
                }
                i += 1;
            }
            "--top" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("エラー: missing value for --top. 例: --top 50");
                    std::process::exit(1);
                }
                match args[i].parse::<usize>() {
                    Ok(n) if n >= 1 => top_n = Some(n),
                    Ok(_) => {
                        eprintln!(
                            "エラー: invalid top number '{}'. 1以上の整数を指定してください。",
                            &args[i]
                        );
                        std::process::exit(1);
                    }
                    Err(_) => {
                        eprintln!(
                            "エラー: invalid top number '{}'. 整数を指定してください。例: --top 50",
                            &args[i]
                        );
                        std::process::exit(1);
                    }
                }
                i += 1;
            }
            other => {
                eprintln!(
                    "エラー: unknown option '{}'. ヘルプ: disk-insight.exe --help",
                    other
                );
                std::process::exit(1);
            }
        }
    }

    if diag_pfx86 {
        if let Err(e) = mft_probe::print_diag_pfx86(drive) {
            eprintln!("エラー: {}", e);
            std::process::exit(1);
        }
        return Ok(());
    }

    if diag_wof_global {
        if let Err(e) = mft_probe::print_diag_wof_global(drive) {
            eprintln!("エラー: {}", e);
            std::process::exit(1);
        }
        return Ok(());
    }

    if diag_winsxs {
        if let Err(e) = mft_probe::print_diag_winsxs(drive) {
            eprintln!("エラー: {}", e);
            std::process::exit(1);
        }
        return Ok(());
    }

    let top = top_n.unwrap_or(if json_mode { 100 } else { 30 });

    let result = if json_mode {
        mft_probe::print_probe7_json_top_with_policy(drive, top, storage_policy, perf_mode)
    } else {
        mft_probe::print_probe7_human_with_policy(drive, top, storage_policy, perf_mode)
    };

    if let Err(e) = result {
        eprintln!("エラー: {}", e);
        std::process::exit(1);
    }

    Ok(())
}
