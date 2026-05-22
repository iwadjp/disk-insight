//! disk-insight Phase 1: MFT列挙CLI
//! 実行には管理者権限が必要です。

mod mft;

use anyhow::Result;
use std::time::Instant;

fn main() -> Result<()> {
    // TODO: 引数でドライブ文字を受け取る（暫定でCドライブ固定）
    let drive = 'C';

    println!("disk-insight Phase 1: MFT列挙");
    println!("対象ドライブ: {}:\\", drive);
    println!("※ 管理者権限で実行してください");
    println!();

    let start = Instant::now();
    let result = mft::enumerate(drive)?;
    let elapsed = start.elapsed();

    println!("--- 結果 ---");
    println!("ファイル数    : {}", result.file_count);
    println!("ディレクトリ数: {}", result.dir_count);
    println!("総サイズ      : {} GB ({} bytes)",
        result.total_bytes / 1_073_741_824,
        result.total_bytes);
    println!("スキャン時間  : {:.2}秒", elapsed.as_secs_f64());
    println!();
    println!("--- サイズ上位10件（ファイル）---");
    for (i, entry) in result.top_files.iter().enumerate() {
        println!("{:>3}. {:>12} MB  {}",
            i + 1,
            entry.size / 1_048_576,
            entry.name);
    }

    Ok(())
}