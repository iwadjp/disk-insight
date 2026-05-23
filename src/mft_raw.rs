//! MFT RAW読み取りモジュール
//! $MFT のエクステント情報を FSCTL_GET_RETRIEVAL_POINTERS で取得し、
//! ボリュームから直接読み取ってメモリ上でパースする。

use anyhow::{bail, Context, Result};
use rayon::prelude::*;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_BEGIN, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ,
    FILE_SHARE_WRITE, GetFileSizeEx, OPEN_EXISTING, ReadFile, SetFilePointerEx,
};
use windows::Win32::System::Ioctl::{
    FSCTL_GET_NTFS_VOLUME_DATA, FSCTL_GET_RETRIEVAL_POINTERS,
    NTFS_VOLUME_DATA_BUFFER,
};
use windows::Win32::System::IO::DeviceIoControl;
use windows::core::PCWSTR;

const ATTR_FILE_NAME: u32 = 0x30;
const ATTR_END:       u32 = 0xFFFFFFFF;

struct VolumeInfo {
    bytes_per_cluster:     u64,
    bytes_per_file_record: u64,
    mft_start_lcn:         u64,
}

// FSCTL_GET_RETRIEVAL_POINTERS 入力バッファ
#[repr(C)]
struct StartingVcnInputBuffer {
    starting_vcn: i64,
}

// FSCTL_GET_RETRIEVAL_POINTERS 出力バッファのレイアウト（参照用）
// offset  0: ExtentCount (u32)
// offset  4: padding     (u32)
// offset  8: StartingVcn (i64)
// offset 16: Extents[] = { NextVcn(i64), Lcn(i64) } × ExtentCount

pub struct MftExtent {
    pub start_vcn: i64,
    pub next_vcn:  i64,
    pub lcn:       i64,
}

#[allow(dead_code)]
pub struct RawEntry {
    pub name:       String,
    pub fid:        u64,
    pub parent_fid: u64,
    pub size:       u64,
    pub is_dir:     bool,
}

fn get_volume_info(handle: HANDLE) -> Result<VolumeInfo> {
    let mut vol_data = NTFS_VOLUME_DATA_BUFFER::default();
    let mut bytes_returned: u32 = 0;

    unsafe {
        DeviceIoControl(
            handle,
            FSCTL_GET_NTFS_VOLUME_DATA,
            None,
            0,
            Some(&mut vol_data as *mut _ as *mut _),
            std::mem::size_of::<NTFS_VOLUME_DATA_BUFFER>() as u32,
            Some(&mut bytes_returned),
            None,
        )
    }.context("FSCTL_GET_NTFS_VOLUME_DATA失敗")?;

    Ok(VolumeInfo {
        bytes_per_cluster:     vol_data.BytesPerCluster as u64,
        bytes_per_file_record: vol_data.BytesPerFileRecordSegment as u64,
        mft_start_lcn:         vol_data.MftStartLcn as u64,
    })
}

/// MFTレコードのFix-up（Update Sequence Array）を適用する
/// レコードのコピーを返す（元データを変更しない）
fn apply_fixup(record: &[u8]) -> Option<Vec<u8>> {
    if record.len() < 8 {
        return None;
    }

    let usa_offset = u16::from_le_bytes([record[4], record[5]]) as usize;
    let usa_size   = u16::from_le_bytes([record[6], record[7]]) as usize;

    if usa_offset + usa_size * 2 > record.len() {
        return None;
    }

    let usv = u16::from_le_bytes([
        record[usa_offset],
        record[usa_offset + 1],
    ]);

    let mut buf = record.to_vec();

    for i in 1..usa_size {
        let sector_end = i * 512 - 2;
        if sector_end + 2 > buf.len() {
            break;
        }

        let sector_val = u16::from_le_bytes([buf[sector_end], buf[sector_end + 1]]);
        if sector_val != usv {
            return None;
        }

        let usa_entry_offset = usa_offset + i * 2;
        buf[sector_end]     = record[usa_entry_offset];
        buf[sector_end + 1] = record[usa_entry_offset + 1];
    }

    Some(buf)
}

fn parse_mft_record(record: &[u8], fid: u64) -> Option<RawEntry> {
    if record.len() < 48 || &record[0..4] != b"FILE" {
        return None;
    }

    let fixed = apply_fixup(record)?;
    let record = fixed.as_slice();

    let flags = u16::from_le_bytes([record[22], record[23]]);
    if flags & 0x01 == 0 {
        return None;
    }
    let is_dir = flags & 0x02 != 0;

    let attr_offset = u16::from_le_bytes([record[20], record[21]]) as usize;

    let mut name = String::new();
    let mut parent_fid: u64 = 0;
    let mut size: u64 = 0;
    let mut best_namespace: u8 = 255;

    let mut pos = attr_offset;
    loop {
        if pos + 4 > record.len() {
            break;
        }

        let attr_type = u32::from_le_bytes(record[pos..pos+4].try_into().ok()?);

        if attr_type == ATTR_END {
            break;
        }

        if pos + 8 > record.len() {
            break;
        }
        let attr_len = u32::from_le_bytes(record[pos+4..pos+8].try_into().ok()?) as usize;

        if attr_len == 0 || pos + attr_len > record.len() {
            break;
        }

        let non_resident = record[pos + 8];

        if non_resident == 0 && pos + 22 <= record.len() {
            let content_offset = u16::from_le_bytes([record[pos+20], record[pos+21]]) as usize;
            let content_start = pos + content_offset;

            if attr_type == ATTR_FILE_NAME && content_start + 66 <= record.len() {
                let pfid = u64::from_le_bytes(
                    record[content_start..content_start+8].try_into().ok()?
                ) & 0x0000_FFFF_FFFF_FFFF;

                let real_size = u64::from_le_bytes(
                    record[content_start+48..content_start+56].try_into().ok()?
                );

                let namespace  = record[content_start + 65];
                let name_len   = record[content_start + 64] as usize;
                let name_start = content_start + 66;
                let name_end   = name_start + name_len * 2;

                if name_end <= record.len() && namespace < best_namespace {
                    let utf16: Vec<u16> = record[name_start..name_end]
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    name = String::from_utf16_lossy(&utf16).to_string();
                    parent_fid = pfid;
                    size = real_size;
                    best_namespace = namespace;
                }
            }
        }

        pos += attr_len;
    }

    if name.is_empty() {
        return None;
    }

    Some(RawEntry { name, fid, parent_fid, size, is_dir })
}

fn open_drive(drive: char) -> Result<HANDLE> {
    let path: Vec<u16> = format!("\\\\.\\{}:", drive)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            0x80000000u32,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    }.context("ドライブオープン失敗")
}

fn open_mft_file(drive: char) -> Result<HANDLE> {
    let candidates = vec![
        (format!("\\\\?\\{}:\\$MFT", drive), 0x02000000u32), // FILE_FLAG_BACKUP_SEMANTICS
        (format!("\\\\?\\{}:\\$MFT", drive), 0x00000000u32), // フラグなし
        (format!("\\\\.\\{}:\\$MFT", drive), 0x02000000u32),
        (format!("\\\\.\\{}:\\$MFT", drive), 0x00000000u32),
        (format!("{}:\\$MFT", drive),         0x02000000u32),
        (format!("{}:\\$MFT", drive),         0x00000000u32),
    ];

    for (path_str, flags) in &candidates {
        let path: Vec<u16> = path_str
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let result = unsafe {
            CreateFileW(
                PCWSTR(path.as_ptr()),
                0x80000000u32,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(*flags),
                None,
            )
        };

        match result {
            Ok(h) => {
                println!("$MFTオープン成功: {} flags=0x{:08X}", path_str, flags);
                return Ok(h);
            }
            Err(e) => {
                println!("$MFTオープン失敗: {} flags=0x{:08X} → code=0x{:08X}",
                    path_str, flags, e.code().0 as u32);
            }
        }
    }

    bail!("全パス形式で$MFTオープン失敗")
}

/// $MFT のクラスタ配置を FSCTL_GET_RETRIEVAL_POINTERS で取得する
/// ERROR_MORE_DATA(234) の場合は継続して全エクステントを収集する
fn get_mft_extents(mft_handle: HANDLE) -> Result<Vec<MftExtent>> {
    let mut all_extents: Vec<MftExtent> = Vec::new();
    let mut starting_vcn: i64 = 0;

    loop {
        let input = StartingVcnInputBuffer { starting_vcn };
        let buf_size = 65536usize;
        let mut buf = vec![0u8; buf_size];
        let mut bytes_returned: u32 = 0;

        let result = unsafe {
            DeviceIoControl(
                mft_handle,
                FSCTL_GET_RETRIEVAL_POINTERS,
                Some(&input as *const _ as *const _),
                std::mem::size_of::<StartingVcnInputBuffer>() as u32,
                Some(buf.as_mut_ptr() as *mut _),
                buf_size as u32,
                Some(&mut bytes_returned),
                None,
            )
        };

        let more_data = if result.is_err() {
            use windows::Win32::Foundation::GetLastError;
            let err = unsafe { GetLastError() };
            if err.0 != 234 {
                bail!("FSCTL_GET_RETRIEVAL_POINTERS失敗: error={}", err.0);
            }
            true
        } else {
            false
        };

        if bytes_returned < 16 {
            break;
        }

        // バイト列から直接パース（アライメント問題を回避）
        let extent_count    = u32::from_le_bytes(buf[0..4].try_into()?) as usize;
        // buf[4..8] は padding
        let buf_starting_vcn = i64::from_le_bytes(buf[8..16].try_into()?);
        let mut current_vcn  = buf_starting_vcn;

        for i in 0..extent_count {
            let offset = 16 + i * 16;
            if offset + 16 > bytes_returned as usize {
                break;
            }
            let next_vcn = i64::from_le_bytes(buf[offset..offset+8].try_into()?);
            let lcn      = i64::from_le_bytes(buf[offset+8..offset+16].try_into()?);
            all_extents.push(MftExtent { start_vcn: current_vcn, next_vcn, lcn });
            current_vcn = next_vcn;
        }

        if !more_data {
            break;
        }
        match all_extents.last() {
            Some(last) => starting_vcn = last.next_vcn,
            None       => break,
        }
    }

    Ok(all_extents)
}

/// エクステント情報に従いボリュームから $MFT 全体を読み取る
fn read_mft_by_extents(
    volume_handle: HANDLE,
    extents: &[MftExtent],
    bytes_per_cluster: u64,
    mft_size: u64,
) -> Result<Vec<u8>> {
    let mut mft_buf = vec![0u8; mft_size as usize];
    const READ_CHUNK: u64 = 4 * 1024 * 1024; // 4MB

    for extent in extents {
        if extent.lcn < 0 {
            continue; // 疎エクステント(LCN=-1)はスキップ
        }
        let disk_offset    = extent.lcn as u64 * bytes_per_cluster;
        let vcn_start_byte = extent.start_vcn as u64 * bytes_per_cluster;
        let extent_bytes   = (extent.next_vcn - extent.start_vcn) as u64 * bytes_per_cluster;

        if vcn_start_byte >= mft_size {
            continue;
        }
        let max_bytes = extent_bytes.min(mft_size - vcn_start_byte);

        let mut done: u64 = 0;
        while done < max_bytes {
            let to_read  = (max_bytes - done).min(READ_CHUNK) as usize;
            let disk_pos = disk_offset + done;
            let buf_pos  = (vcn_start_byte + done) as usize;

            unsafe {
                SetFilePointerEx(volume_handle, disk_pos as i64, None, FILE_BEGIN)
            }.context("SetFilePointerEx失敗")?;

            let mut bytes_read: u32 = 0;
            unsafe {
                ReadFile(
                    volume_handle,
                    Some(&mut mft_buf[buf_pos..buf_pos + to_read]),
                    Some(&mut bytes_read as *mut u32),
                    None,
                )
            }.context("ReadFile失敗")?;

            if bytes_read == 0 {
                break;
            }
            done += bytes_read as u64;
        }
    }

    Ok(mft_buf)
}

pub fn enumerate_raw(drive: char) -> Result<Vec<RawEntry>> {
    // 1. ボリュームハンドル（ボリューム読み取り用）
    let volume_handle   = open_drive(drive)?;
    // 2. $MFT ファイルハンドル（エクステント取得用）
    let mft_file_handle = open_mft_file(drive)?;

    // 3. ボリューム情報取得
    let vol = get_volume_info(volume_handle)?;

    // 4. $MFT サイズ取得
    let mut mft_size_i64: i64 = 0;
    unsafe { GetFileSizeEx(mft_file_handle, &mut mft_size_i64) }
        .context("GetFileSizeEx失敗")?;
    let mft_size = mft_size_i64 as u64;

    // 5. $MFT エクステント一覧取得
    let extents = get_mft_extents(mft_file_handle)?;
    unsafe { windows::Win32::Foundation::CloseHandle(mft_file_handle).ok(); }

    println!("BytesPerCluster: {}", vol.bytes_per_cluster);
    println!("BytesPerFileRecord: {}", vol.bytes_per_file_record);
    println!("MftStartLcn: {}", vol.mft_start_lcn);
    println!("$MFT エクステント数: {}", extents.len());
    for (i, e) in extents.iter().enumerate() {
        println!("  [{}] VCN {}..{} -> LCN {}", i, e.start_vcn, e.next_vcn, e.lcn);
    }
    println!("$MFT サイズ: {} MB", mft_size / 1_048_576);

    // 6. MFT 全体をメモリに読み込む
    let mft_buf = read_mft_by_extents(
        volume_handle, &extents, vol.bytes_per_cluster, mft_size,
    )?;
    unsafe { windows::Win32::Foundation::CloseHandle(volume_handle).ok(); }

    // 7. メモリ上のバッファを rayon で並列パース
    let record_size   = vol.bytes_per_file_record as usize;
    let total_records = mft_buf.len() / record_size;

    // u8: 0=BAAD, 1=ゼロ(未使用), 2=その他非FILE, 3=deleted, 4=no_filename, 5=valid
    // 3要素目: code==2 のとき先頭4バイトサンプル
    let results: Vec<(Option<RawEntry>, u8, Option<[u8; 4]>)> = (0..total_records)
        .into_par_iter()
        .map(|i| {
            let start = i * record_size;
            let end   = start + record_size;
            let slice = &mft_buf[start..end];

            match slice.get(0..4) {
                Some(b"FILE") => {}
                Some(b"BAAD") => return (None, 0u8, None),
                Some([0, 0, 0, 0]) => return (None, 1u8, None),
                Some(other) => {
                    let s: [u8; 4] = other.try_into().unwrap_or([0; 4]);
                    return (None, 2u8, Some(s));
                }
                None => return (None, 2u8, None),
            }

            if slice.len() < 48 {
                return (None, 2u8, None);
            }

            let fixed = match apply_fixup(slice) {
                Some(f) => f,
                None    => return (None, 2u8, None),
            };
            let flags = u16::from_le_bytes([fixed[22], fixed[23]]);
            if flags & 0x01 == 0 {
                return (None, 3u8, None);
            }

            match parse_mft_record(slice, i as u64) {
                Some(entry) => (Some(entry), 5u8, None),
                None        => (None, 4u8, None),
            }
        })
        .collect();

    // 8. 統計集計
    let mut all_entries: Vec<RawEntry> = Vec::with_capacity(1_500_000);
    let mut no_file_signature:  u64 = 0;
    let mut sig_baad:           u64 = 0;
    let mut sig_zero:           u64 = 0;
    let mut sig_other:          u64 = 0;
    let mut other_samples:      Vec<[u8; 4]> = Vec::new();
    let mut deleted_records:    u64 = 0;
    let mut no_filename_attr:   u64 = 0;
    let mut valid_entries:      u64 = 0;

    for (entry, code, sample) in results {
        match code {
            0 => { no_file_signature += 1; sig_baad += 1; }
            1 => { no_file_signature += 1; sig_zero += 1; }
            2 => {
                no_file_signature += 1;
                sig_other += 1;
                if other_samples.len() < 10 {
                    if let Some(s) = sample { other_samples.push(s); }
                }
            }
            3 => deleted_records  += 1,
            4 => no_filename_attr += 1,
            _ => {
                valid_entries += 1;
                if let Some(e) = entry { all_entries.push(e); }
            }
        }
    }

    println!("取得エントリ数: {}", all_entries.len());
    println!("総レコード数:         {}", total_records);
    println!("FILEシグネチャなし:   {}", no_file_signature);
    println!("  うちBAD:            {}", sig_baad);
    println!("  うちゼロ(未使用):   {}", sig_zero);
    println!("  うちその他:         {}", sig_other);
    println!("その他シグネチャサンプル:");
    for s in &other_samples {
        println!("  {:02X} {:02X} {:02X} {:02X}", s[0], s[1], s[2], s[3]);
    }
    println!("削除済みレコード:     {}", deleted_records);
    println!("$FILE_NAME属性なし:   {}", no_filename_attr);
    println!("有効エントリ:         {}", valid_entries);

    Ok(all_entries)
}
