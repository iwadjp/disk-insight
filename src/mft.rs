//! MFT（Master File Table）直接読み取りモジュール
//! FSCTL_ENUM_USN_DATA を使用してファイル一覧を取得する。

use anyhow::{bail, Context, Result};
use rayon::prelude::*;
use std::collections::HashMap;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Ioctl::{
    FSCTL_ENUM_USN_DATA, MFT_ENUM_DATA_V0, USN_RECORD_V2,
};
use windows::Win32::System::IO::DeviceIoControl;
use windows::core::PCWSTR;

pub struct ScanResult {
    pub file_count:  u64,
    pub dir_count:   u64,
    pub total_bytes: u64,
    pub top_files:   Vec<FileEntry>,  // 互換用に残す
    pub nodes:       Vec<FileNode>,   // アリーナ型ツリー
    pub root_idx:    Option<usize>,   // ルートノードのインデックス
}

pub struct FileEntry {
    pub name: String,
    pub size: u64,
}

pub struct FileNode {
    pub name:       String,
    pub size:       u64,
    pub total_size: u64,
    pub is_dir:     bool,
    pub parent_idx: Option<usize>,
    pub children:   Vec<usize>,
    fid:            u64,
    parent_fid:     u64,
}

const BUFFER_SIZE: usize = 512 * 1024; // 512KB

pub fn enumerate(drive: char) -> Result<ScanResult> {
    let handle = open_drive(drive)?;

    let mut file_count:  u64 = 0;
    let mut dir_count:   u64 = 0;
    let total_bytes:     u64 = 0;

    // MFT列挙の開始位置
    let mut med = MFT_ENUM_DATA_V0 {
        StartFileReferenceNumber: 0,
        LowUsn: 0,
        HighUsn: i64::MAX,
    };

    let mut buffer = vec![0u8; BUFFER_SIZE];
    let mut bytes_returned: u32 = 0;
    let mut call_count: u64 = 0;
    let mut buffers: Vec<(Vec<u8>, usize)> = Vec::new();
    let mut io_time = std::time::Duration::ZERO;
    let mut parse_time = std::time::Duration::ZERO;

    loop {
        // SAFETY: handle は有効、buffer は十分なサイズを確保済み
        let t = std::time::Instant::now();
        let ok = unsafe {
            DeviceIoControl(
                handle,
                FSCTL_ENUM_USN_DATA,
                Some(&med as *const _ as *const _),
                std::mem::size_of::<MFT_ENUM_DATA_V0>() as u32,
                Some(buffer.as_mut_ptr() as *mut _),
                BUFFER_SIZE as u32,
                Some(&mut bytes_returned),
                None,
            )
        };
        io_time += t.elapsed();

        if ok.is_err() {
            use windows::Win32::Foundation::GetLastError;
            let err = unsafe { GetLastError() };
            // ERROR_HANDLE_EOF = 38, ERROR_NO_MORE_FILES = 259
            if err.0 == 38 || err.0 == 259 {
                break;
            }
            bail!("DeviceIoControl失敗: error code={}", err.0);
        }

        call_count += 1;

        // bytes_returned が 8 以下（次アドレスのみ）なら終了
        if bytes_returned <= 8 {
            break;
        }
        // SAFETY: バッファは u64 アライメント保証済み
        med.StartFileReferenceNumber = unsafe {
            *(buffer.as_ptr() as *const u64)
        };

        buffers.push((buffer[..bytes_returned as usize].to_vec(), bytes_returned as usize));
    }

    println!("DeviceIoControl呼び出し回数: {}", call_count);

    // 並列パース: (name, fid, parent_fid, is_dir) を収集
    let t = std::time::Instant::now();
    let raw_records: Vec<Vec<(String, u64, u64, bool)>> = buffers
        .par_iter()
        .map(|(buf, bytes_ret)| {
            let mut records: Vec<(String, u64, u64, bool)> = Vec::new();

            let mut offset = 8usize;
            while offset + std::mem::size_of::<USN_RECORD_V2>() <= *bytes_ret {
                // SAFETY: offset はレコード境界に合わせて進める
                let record = unsafe {
                    &*(buf.as_ptr().add(offset) as *const USN_RECORD_V2)
                };

                if record.RecordLength == 0 {
                    break;
                }

                let is_dir = (record.FileAttributes
                    & windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY.0) != 0;

                // ファイル名を UTF-16 → String に変換
                // SAFETY: FileName は RecordLength の範囲内にある
                let name = unsafe {
                    let ptr = (record as *const USN_RECORD_V2 as *const u8)
                        .add(record.FileNameOffset as usize) as *const u16;
                    let len = record.FileNameLength as usize / 2;
                    let slice = std::slice::from_raw_parts(ptr, len);
                    String::from_utf16_lossy(slice)
                };

                let fid        = record.FileReferenceNumber as u64;
                let parent_fid = record.ParentFileReferenceNumber as u64;

                records.push((name, fid, parent_fid, is_dir));
                offset += record.RecordLength as usize;
            }
            records
        })
        .collect();
    parse_time += t.elapsed();

    // フラット化
    let all_records: Vec<(String, u64, u64, bool)> =
        raw_records.into_iter().flatten().collect();

    // ファイル数・ディレクトリ数を集計
    for (_, _, _, is_dir) in &all_records {
        if *is_dir { dir_count += 1; } else { file_count += 1; }
    }

    // Step 1: 全ノードを Vec<FileNode> に格納
    let mut nodes: Vec<FileNode> = all_records.iter()
        .map(|(name, fid, parent_fid, is_dir)| FileNode {
            name:       name.clone(),
            size:       0,
            total_size: 0,
            is_dir:     *is_dir,
            parent_idx: None,
            children:   Vec::new(),
            fid:        *fid,
            parent_fid: *parent_fid,
        })
        .collect();

    // Step 2: fid → Vec インデックス の HashMap を作成
    let mut fid_map: HashMap<u64, usize> = HashMap::with_capacity(nodes.len());
    for (i, node) in nodes.iter().enumerate() {
        fid_map.insert(node.fid, i);
    }

    // Step 3: parent_fid を使って parent_idx を設定
    let parent_fids: Vec<u64> = nodes.iter().map(|n| n.parent_fid).collect();
    for (i, &parent_fid) in parent_fids.iter().enumerate() {
        if let Some(&parent_idx) = fid_map.get(&parent_fid) {
            if parent_idx != i {
                nodes[i].parent_idx = Some(parent_idx);
            }
        }
    }

    // children を設定（二重借用を避けるため先にペアを収集）
    let child_parent_pairs: Vec<(usize, usize)> = nodes.iter().enumerate()
        .filter_map(|(i, n)| n.parent_idx.map(|pi| (i, pi)))
        .collect();
    for (child_idx, parent_idx) in child_parent_pairs {
        nodes[parent_idx].children.push(child_idx);
    }

    // Step 4: root（parent_fid が自分自身 or 親が存在しない最初のディレクトリ）を設定
    let root_idx = nodes.iter().position(|n| n.fid == n.parent_fid)
        .or_else(|| nodes.iter().position(|n| n.parent_idx.is_none() && n.is_dir));

    println!("ツリー構築完了: ノード数={}", nodes.len());
    println!("ルートノード: {:?}", root_idx.map(|i| &nodes[i].name));

    // 互換用 top_files（size=0 のため先頭100件）
    let top_files: Vec<FileEntry> = all_records.iter()
        .filter(|(_, _, _, is_dir)| !is_dir)
        .take(100)
        .map(|(name, _, _, _)| FileEntry { name: name.clone(), size: 0 })
        .collect();

    println!("1回あたり平均エントリ数: {}",
        if call_count > 0 { (file_count + dir_count) / call_count } else { 0 });
    println!("I/O時間合計:    {:.2}秒", io_time.as_secs_f64());
    println!("パース時間合計: {:.2}秒", parse_time.as_secs_f64());
    unsafe { windows::Win32::Foundation::CloseHandle(handle).ok(); }

    Ok(ScanResult { file_count, dir_count, total_bytes, top_files, nodes, root_idx })
}

fn open_drive(drive: char) -> Result<HANDLE> {
    // \\.\C: 形式のパスを UTF-16 に変換
    let path: Vec<u16> = format!("\\\\.\\{}:", drive)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let handle = unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            // GENERIC_READ 相当: FILE_READ_DATA は不要、制御コードのみ
            0x80000000u32, // GENERIC_READ
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    }
    .context("ドライブのオープンに失敗しました（管理者権限で実行してください）")?;

    Ok(handle)
}
