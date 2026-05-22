//! MFT（Master File Table）直接読み取りモジュール
//! FSCTL_ENUM_USN_DATA を使用してファイル一覧を取得する。

use anyhow::{bail, Context, Result};
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

/// Phase 1 スキャン結果
pub struct ScanResult {
    pub file_count:  u64,
    pub dir_count:   u64,
    pub total_bytes: u64,
    /// サイズ降順上位100件
    pub top_files:   Vec<FileEntry>,
}

pub struct FileEntry {
    pub name: String,
    pub size: u64,
}

const BUFFER_SIZE: usize = 512 * 1024; // 512KB

pub fn enumerate(drive: char) -> Result<ScanResult> {
    let handle = open_drive(drive)?;

    let mut file_count:  u64 = 0;
    let mut dir_count:   u64 = 0;
    let mut total_bytes: u64 = 0;
    // 上位100件管理: (size, name)
    let mut top: Vec<(u64, String)> = Vec::with_capacity(101);

    // MFT列挙の開始位置
    let mut med = MFT_ENUM_DATA_V0 {
        StartFileReferenceNumber: 0,
        LowUsn: 0,
        HighUsn: i64::MAX,
    };

    let mut buffer = vec![0u8; BUFFER_SIZE];
    let mut bytes_returned: u32 = 0;

    loop {
        // SAFETY: handle は有効、buffer は十分なサイズを確保済み
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

        if ok.is_err() {
            use windows::Win32::Foundation::GetLastError;
            let err = unsafe { GetLastError() };
            // ERROR_HANDLE_EOF = 38, ERROR_NO_MORE_FILES = 259
            if err.0 == 38 || err.0 == 259 {
                break;
            }
            bail!("DeviceIoControl失敗: error code={}", err.0);
        }

        // bytes_returned が 8 以下（次アドレスのみ）なら終了
        if bytes_returned <= 8 {
            break;
        }
        // SAFETY: バッファは u64 アライメント保証済み
        med.StartFileReferenceNumber = unsafe {
            *(buffer.as_ptr() as *const u64)
        };

        // USN_RECORD_V2 を順次パース
        let mut offset = 8usize;
        while offset + std::mem::size_of::<USN_RECORD_V2>() <= bytes_returned as usize {
            // SAFETY: offset はレコード境界に合わせて進める
            let record = unsafe {
                &*(buffer.as_ptr().add(offset) as *const USN_RECORD_V2)
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

            let size: u64 = 0;

            if is_dir {
                dir_count += 1;
            } else {
                file_count += 1;
                total_bytes += size;

                // 上位100件を維持
                if top.len() < 100 || top.last().map_or(true, |l| size > l.0) {
                    top.push((size, name));
                    top.sort_unstable_by(|a, b| b.0.cmp(&a.0));
                    top.truncate(100);
                }
            }

            offset += record.RecordLength as usize;
        }
    }

    unsafe { windows::Win32::Foundation::CloseHandle(handle).ok(); }

    let top_files = top
        .into_iter()
        .map(|(size, name)| FileEntry { name, size })
        .collect();

    Ok(ScanResult { file_count, dir_count, total_bytes, top_files })
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