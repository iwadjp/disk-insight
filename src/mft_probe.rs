use anyhow::{bail, Context, Result};
use windows::Win32::Foundation::{HANDLE, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, LookupPrivilegeValueW,
    LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
    TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Ioctl::{
    FSCTL_GET_NTFS_VOLUME_DATA, NTFS_VOLUME_DATA_BUFFER,
};
use windows::Win32::System::IO::DeviceIoControl;
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::core::PCWSTR;

const FSCTL_GET_NTFS_FILE_RECORD: u32 = 0x00090068;

#[repr(C)]
struct NtfsFileRecordInputBuffer {
    file_reference_number: i64,
}

struct MftInfo {
    handle: HANDLE,
    bytes_per_cluster: u64,
    bytes_per_record: u64,
    extents: Vec<(u64, u64, u64)>, // (start_vcn, lcn, length_in_clusters)
    mft_size: u64,
}

fn enable_privilege(name: &str) -> Result<()> {
    let wname: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();

    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
    }.context("OpenProcessToken失敗")?;

    let mut luid = LUID::default();
    unsafe {
        LookupPrivilegeValueW(
            PCWSTR::null(),
            PCWSTR(wname.as_ptr()),
            &mut luid,
        )
    }.context("LookupPrivilegeValue失敗")?;

    let tp = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };

    unsafe {
        AdjustTokenPrivileges(
            token,
            false,
            Some(&tp),
            0,
            None,
            None,
        )
    }.context("AdjustTokenPrivileges失敗")?;

    use windows::Win32::Foundation::GetLastError;
    let err = unsafe { GetLastError() };
    if err.0 == 1300 {
        bail!("特権の割り当てに失敗（権限不足）");
    }

    unsafe { windows::Win32::Foundation::CloseHandle(token).ok(); }
    println!("特権有効化成功: {}", name);
    Ok(())
}

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
        if sector_end + 2 > buf.len() { break; }

        let sector_val = u16::from_le_bytes([
            buf[sector_end],
            buf[sector_end + 1],
        ]);
        if sector_val != usv {
            return None;
        }

        let usa_entry_offset = usa_offset + i * 2;
        buf[sector_end]     = record[usa_entry_offset];
        buf[sector_end + 1] = record[usa_entry_offset + 1];
    }

    Some(buf)
}

fn decode_runlist(runlist: &[u8]) -> Vec<(u64, u64, u64)> {
    // returns (start_vcn, lcn, length_in_clusters)
    let mut extents = Vec::new();
    let mut pos = 0usize;
    let mut current_lcn: i64 = 0;
    let mut current_vcn: u64 = 0;

    while pos < runlist.len() {
        let header = runlist[pos];
        if header == 0x00 { break; }

        let length_bytes = (header & 0x0F) as usize;
        let lcn_bytes    = (header >> 4)   as usize;
        if length_bytes == 0 { break; }
        pos += 1;

        if pos + length_bytes > runlist.len() { break; }
        let mut length: u64 = 0;
        for i in 0..length_bytes {
            length |= (runlist[pos + i] as u64) << (i * 8);
        }
        pos += length_bytes;

        if lcn_bytes > 0 {
            if pos + lcn_bytes > runlist.len() { break; }
            let mut delta: i64 = 0;
            for i in 0..lcn_bytes {
                delta |= (runlist[pos + i] as i64) << (i * 8);
            }
            // 符号拡張
            let shift = 64 - lcn_bytes * 8;
            delta = (delta << shift) >> shift;
            current_lcn += delta;
            pos += lcn_bytes;
        }

        extents.push((current_vcn, current_lcn as u64, length));
        current_vcn += length;
    }

    extents
}

fn get_mft_info(drive: char) -> Result<MftInfo> {
    let path: Vec<u16> = format!("\\\\.\\{}:", drive)
        .encode_utf16().chain(std::iter::once(0)).collect();

    let handle = unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            0x80000000u32,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None, OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0), None,
        )
    }.context("ドライブオープン失敗")?;

    // ボリューム情報取得
    let mut vol_data = NTFS_VOLUME_DATA_BUFFER::default();
    let mut bytes_returned: u32 = 0;
    unsafe {
        DeviceIoControl(
            handle,
            FSCTL_GET_NTFS_VOLUME_DATA,
            None, 0,
            Some(&mut vol_data as *mut _ as *mut _),
            std::mem::size_of::<NTFS_VOLUME_DATA_BUFFER>() as u32,
            Some(&mut bytes_returned),
            None,
        )
    }.context("FSCTL_GET_NTFS_VOLUME_DATA失敗")?;

    let bytes_per_cluster = vol_data.BytesPerCluster as u64;
    let bytes_per_record  = vol_data.BytesPerFileRecordSegment as u64;

    // FRN=0 ($MFT) のレコードを取得
    let out_size = 12 + bytes_per_record as usize;
    let mut out_buf = vec![0u8; out_size];
    let mut bytes_returned: u32 = 0;

    let input = NtfsFileRecordInputBuffer { file_reference_number: 0i64 };
    unsafe {
        DeviceIoControl(
            handle,
            FSCTL_GET_NTFS_FILE_RECORD,
            Some(&input as *const _ as *const _),
            std::mem::size_of::<NtfsFileRecordInputBuffer>() as u32,
            Some(out_buf.as_mut_ptr() as *mut _),
            out_size as u32,
            Some(&mut bytes_returned),
            None,
        )
    }.context("FSCTL_GET_NTFS_FILE_RECORD失敗")?;

    let record = &out_buf[12..12 + bytes_per_record as usize];

    // $DATA属性 (0x80, 非常駐) から runlist を取得
    let attr_offset = u16::from_le_bytes([record[20], record[21]]) as usize;
    let mut pos = attr_offset;

    loop {
        if pos + 8 > record.len() {
            bail!("$DATA属性が見つかりませんでした");
        }
        let attr_type = u32::from_le_bytes(record[pos..pos+4].try_into().unwrap());
        let attr_len  = u32::from_le_bytes(record[pos+4..pos+8].try_into().unwrap()) as usize;

        if attr_type == 0xFFFFFFFF || attr_len == 0 {
            bail!("$DATA属性が見つかりませんでした");
        }

        if attr_type == 0x80 && record[pos + 8] == 1 {
            let runlist_offset = u16::from_le_bytes([record[pos+32], record[pos+33]]) as usize;
            let rl_start = pos + runlist_offset;
            let rl_end   = pos + attr_len;
            if rl_start >= rl_end || rl_end > record.len() {
                bail!("runlistの範囲が不正");
            }

            let extents = decode_runlist(&record[rl_start..rl_end]);
            let total_clusters: u64 = extents.iter().map(|(_, _, len)| len).sum();
            let mft_size = total_clusters * bytes_per_cluster;

            return Ok(MftInfo {
                handle,
                bytes_per_cluster,
                bytes_per_record,
                extents,
                mft_size,
            });
        }

        pos += attr_len;
    }
}

pub fn probe(drive: char, sample_count: u64) -> Result<()> {
    let path: Vec<u16> = format!("\\\\.\\{}:", drive)
        .encode_utf16().chain(std::iter::once(0)).collect();

    let handle = unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            0x80000000u32,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None, OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0), None,
        )
    }.context("ドライブオープン失敗")?;

    let out_size = 16 + 1024usize;
    let mut out_buf = vec![0u8; out_size];
    let mut bytes_returned: u32 = 0;

    let start = std::time::Instant::now();
    let mut success: u64 = 0;
    let mut failed:  u64 = 0;

    for frn in 0..sample_count {
        let input = NtfsFileRecordInputBuffer {
            file_reference_number: frn as i64,
        };

        let ok = unsafe {
            DeviceIoControl(
                handle,
                FSCTL_GET_NTFS_FILE_RECORD,
                Some(&input as *const _ as *const _),
                std::mem::size_of::<NtfsFileRecordInputBuffer>() as u32,
                Some(out_buf.as_mut_ptr() as *mut _),
                out_size as u32,
                Some(&mut bytes_returned),
                None,
            )
        };

        if ok.is_ok() { success += 1; } else { failed += 1; }
    }

    let elapsed = start.elapsed();
    unsafe { windows::Win32::Foundation::CloseHandle(handle).ok(); }

    println!("=== FSCTL_GET_NTFS_FILE_RECORD 速度計測 ===");
    println!("試行件数:     {}", sample_count);
    println!("成功:         {}", success);
    println!("失敗:         {}", failed);
    println!("所要時間:     {:.3}秒", elapsed.as_secs_f64());
    println!("1件あたり:    {:.1}μs", elapsed.as_secs_f64() * 1_000_000.0 / sample_count as f64);
    println!("130万件換算:  {:.1}秒", elapsed.as_secs_f64() * 1_300_000.0 / sample_count as f64);

    Ok(())
}

pub fn probe2(drive: char) -> Result<()> {
    enable_privilege("SeBackupPrivilege")?;
    let _ = enable_privilege("SeRestorePrivilege");

    let path: Vec<u16> = format!("\\\\.\\{}:\\$MFT", drive)
        .encode_utf16().chain(std::iter::once(0)).collect();

    let handle = unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            0x80000000u32,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None, OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0x02000000), // FILE_FLAG_BACKUP_SEMANTICS
            None,
        )
    };

    match handle {
        Ok(h) => {
            println!("★ $MFTオープン成功！ SeBackupPrivilege経由");
            unsafe { windows::Win32::Foundation::CloseHandle(h).ok(); }
        }
        Err(e) => {
            println!("$MFTオープン失敗: 0x{:08X}", e.code().0 as u32);
        }
    }
    Ok(())
}

pub fn probe3(drive: char) -> Result<()> {
    let path: Vec<u16> = format!("\\\\.\\{}:", drive)
        .encode_utf16().chain(std::iter::once(0)).collect();

    let handle = unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            0x80000000u32,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None, OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0), None,
        )
    }.context("ドライブオープン失敗")?;

    // NTFS_FILE_RECORD_OUTPUT_BUFFER:
    //   FileReferenceNumber: i64 (8bytes)
    //   FileRecordLength:    u32 (4bytes)
    //   FileRecordBuffer:    [u8; 1024]  ← offset 12から開始（padding無し）
    let out_size = 8 + 4 + 4 + 1024usize;
    let mut out_buf = vec![0u8; out_size];
    let mut bytes_returned: u32 = 0;

    let input = NtfsFileRecordInputBuffer {
        file_reference_number: 0i64,
    };

    unsafe {
        DeviceIoControl(
            handle,
            FSCTL_GET_NTFS_FILE_RECORD,
            Some(&input as *const _ as *const _),
            std::mem::size_of::<NtfsFileRecordInputBuffer>() as u32,
            Some(out_buf.as_mut_ptr() as *mut _),
            out_size as u32,
            Some(&mut bytes_returned),
            None,
        )
    }.context("FSCTL_GET_NTFS_FILE_RECORD失敗")?;

    println!("bytes_returned: {}", bytes_returned);

    // FSCTL_GET_NTFS_FILE_RECORD はドライバが Fix-up 適用済みで返すため
    // apply_fixup 不要。FileRecordBuffer は offset 12 から始まる
    let record = &out_buf[12..12+1024];
    println!("シグネチャ: {:?}", std::str::from_utf8(&record[0..4]));

    let attr_offset = u16::from_le_bytes([record[20], record[21]]) as usize;
    println!("属性開始オフセット: {}", attr_offset);

    let mut pos = attr_offset;
    loop {
        if pos + 8 > record.len() { break; }

        let attr_type = u32::from_le_bytes(
            record[pos..pos+4].try_into().unwrap()
        );
        let attr_len = u32::from_le_bytes(
            record[pos+4..pos+8].try_into().unwrap()
        ) as usize;

        if attr_type == 0xFFFFFFFF { break; }
        if attr_len == 0 { break; }

        let non_resident = record[pos + 8];

        println!("属性 type=0x{:08X} len={} non_resident={}",
            attr_type, attr_len, non_resident);

        if attr_type == 0x80 && non_resident == 1 {
            println!("  ★ $DATA属性（非常駐）を発見");

            if pos + 56 <= record.len() {
                let runlist_offset = u16::from_le_bytes(
                    [record[pos+32], record[pos+33]]
                ) as usize;
                let allocated = u64::from_le_bytes(
                    record[pos+40..pos+48].try_into().unwrap()
                );
                let real_size = u64::from_le_bytes(
                    record[pos+48..pos+56].try_into().unwrap()
                );

                println!("  AllocatedSize: {} MB", allocated / 1_048_576);
                println!("  RealSize:      {} MB", real_size / 1_048_576);
                println!("  RunlistOffset: {}", runlist_offset);

                let rl_start = pos + runlist_offset;
                if rl_start + 16 <= record.len() {
                    let rl = &record[rl_start..rl_start+16];
                    println!("  Runlist先頭16bytes: {:02X?}", rl);
                }
            }
        }

        pos += attr_len;
    }

    unsafe { windows::Win32::Foundation::CloseHandle(handle).ok(); }
    Ok(())
}

pub fn probe4(drive: char) -> Result<()> {
    let path: Vec<u16> = format!("\\\\.\\{}:", drive)
        .encode_utf16().chain(std::iter::once(0)).collect();

    let handle = unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            0x80000000u32,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None, OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0), None,
        )
    }.context("ドライブオープン失敗")?;

    let mut vol_data = NTFS_VOLUME_DATA_BUFFER::default();
    let mut bytes_returned: u32 = 0;
    unsafe {
        DeviceIoControl(
            handle,
            FSCTL_GET_NTFS_VOLUME_DATA,
            None, 0,
            Some(&mut vol_data as *mut _ as *mut _),
            std::mem::size_of::<NTFS_VOLUME_DATA_BUFFER>() as u32,
            Some(&mut bytes_returned),
            None,
        )
    }.context("FSCTL_GET_NTFS_VOLUME_DATA失敗")?;

    let bytes_per_cluster = vol_data.BytesPerCluster as u64;
    println!("BytesPerCluster: {}", bytes_per_cluster);

    let out_size = 8 + 4 + 1024usize;
    let mut out_buf = vec![0u8; out_size];
    let mut bytes_returned: u32 = 0;

    let input = NtfsFileRecordInputBuffer {
        file_reference_number: 0i64,
    };

    unsafe {
        DeviceIoControl(
            handle,
            FSCTL_GET_NTFS_FILE_RECORD,
            Some(&input as *const _ as *const _),
            std::mem::size_of::<NtfsFileRecordInputBuffer>() as u32,
            Some(out_buf.as_mut_ptr() as *mut _),
            out_size as u32,
            Some(&mut bytes_returned),
            None,
        )
    }.context("FSCTL_GET_NTFS_FILE_RECORD失敗")?;

    let record = &out_buf[12..12+1024];

    let attr_offset = u16::from_le_bytes([record[20], record[21]]) as usize;
    let mut pos = attr_offset;

    loop {
        if pos + 8 > record.len() { break; }
        let attr_type = u32::from_le_bytes(record[pos..pos+4].try_into().unwrap());
        let attr_len  = u32::from_le_bytes(record[pos+4..pos+8].try_into().unwrap()) as usize;

        if attr_type == 0xFFFFFFFF || attr_len == 0 { break; }

        if attr_type == 0x80 && record[pos + 8] == 1 {
            let runlist_offset = u16::from_le_bytes(
                [record[pos+32], record[pos+33]]
            ) as usize;
            let real_size = u64::from_le_bytes(
                record[pos+48..pos+56].try_into().unwrap()
            );

            let rl_start = pos + runlist_offset;
            let rl_end   = pos + attr_len;
            if rl_start < rl_end && rl_end <= record.len() {
                let runlist = &record[rl_start..rl_end];
                let extents = decode_runlist(runlist);

                println!("=== $MFT Runlist ===");
                println!("RealSize: {} MB", real_size / 1_048_576);
                println!("エクステント数: {}", extents.len());

                let mut total_clusters: u64 = 0;
                for (i, (vcn, lcn, len)) in extents.iter().enumerate() {
                    let _byte_offset = lcn * bytes_per_cluster;
                    let size_mb = len * bytes_per_cluster / 1_048_576;
                    println!("  [{:2}] VCN={:8} LCN={:8} clusters={:6} size={}MB",
                        i, vcn, lcn, len, size_mb);
                    total_clusters += len;
                }

                println!("合計クラスタ数: {}", total_clusters);
                println!("合計サイズ: {} MB",
                    total_clusters * bytes_per_cluster / 1_048_576);
            }
            break;
        }

        pos += attr_len;
    }

    unsafe { windows::Win32::Foundation::CloseHandle(handle).ok(); }
    Ok(())
}

pub fn probe5(drive: char) -> Result<()> {
    use windows::Win32::Storage::FileSystem::{ReadFile, SetFilePointerEx, FILE_BEGIN};

    let info = get_mft_info(drive)?;

    println!("$MFT サイズ: {} MB", info.mft_size / 1_048_576);
    println!("エクステント数: {}", info.extents.len());
    println!("BytesPerRecord: {}", info.bytes_per_record);
    println!("メモリ確保・読み込み開始...");

    let mut mft_buf = vec![0u8; info.mft_size as usize];
    let start = std::time::Instant::now();

    for (start_vcn, lcn, length) in &info.extents {
        let disk_offset = lcn  * info.bytes_per_cluster;
        let dst_start   = start_vcn * info.bytes_per_cluster;
        let read_size   = length * info.bytes_per_cluster;
        let dst_end     = dst_start + read_size;

        unsafe {
            SetFilePointerEx(
                info.handle,
                disk_offset as i64,
                None,
                FILE_BEGIN,
            )
        }.context("SetFilePointerEx失敗")?;

        let mut bytes_read: u32 = 0;
        unsafe {
            ReadFile(
                info.handle,
                Some(&mut mft_buf[dst_start as usize..dst_end as usize]),
                Some(&mut bytes_read),
                None,
            )
        }.context("ReadFile失敗")?;
    }

    let io_elapsed = start.elapsed();
    println!("I/O時間: {:.2}秒", io_elapsed.as_secs_f64());

    let record_size = info.bytes_per_record as usize;
    let total_records = info.mft_size as usize / record_size;

    let parse_start = std::time::Instant::now();
    let file_sig_count = mft_buf
        .chunks_exact(record_size)
        .filter(|r| r.len() >= 4 && &r[0..4] == b"FILE")
        .count();
    let parse_elapsed = parse_start.elapsed();

    println!("パース時間: {:.2}秒", parse_elapsed.as_secs_f64());
    println!("総レコード数: {}", total_records);
    println!("FILEシグネチャ: {} ({:.1}%)",
        file_sig_count,
        file_sig_count as f64 * 100.0 / total_records.max(1) as f64);

    unsafe { windows::Win32::Foundation::CloseHandle(info.handle).ok(); }
    Ok(())
}

pub fn probe6(drive: char) -> Result<()> {
    use rayon::prelude::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use windows::Win32::Storage::FileSystem::{ReadFile, SetFilePointerEx, FILE_BEGIN};

    let info = get_mft_info(drive)?;

    println!("$MFT サイズ: {} MB", info.mft_size / 1_048_576);
    println!("エクステント数: {}", info.extents.len());
    println!("メモリ確保・読み込み開始...");

    let total_start = std::time::Instant::now();
    let mut mft_buf = vec![0u8; info.mft_size as usize];

    let io_start = std::time::Instant::now();
    for (start_vcn, lcn, length) in &info.extents {
        let disk_offset = lcn  * info.bytes_per_cluster;
        let dst_start   = start_vcn * info.bytes_per_cluster;
        let read_size   = length * info.bytes_per_cluster;
        let dst_end     = dst_start + read_size;

        unsafe {
            SetFilePointerEx(info.handle, disk_offset as i64, None, FILE_BEGIN)
        }.context("SetFilePointerEx失敗")?;

        let mut bytes_read: u32 = 0;
        unsafe {
            ReadFile(
                info.handle,
                Some(&mut mft_buf[dst_start as usize..dst_end as usize]),
                Some(&mut bytes_read),
                None,
            )
        }.context("ReadFile失敗")?;
    }
    let io_elapsed = io_start.elapsed();
    println!("I/O時間: {:.2}秒", io_elapsed.as_secs_f64());

    unsafe { windows::Win32::Foundation::CloseHandle(info.handle).ok(); }

    let record_size   = info.bytes_per_record as usize;
    let total_records = info.mft_size as usize / record_size;
    println!("解析開始... 総レコード数: {}", total_records);

    struct ParsedEntry {
        record_idx:    usize,
        name:          String,
        parent_frn:    u64,
        size:          u64,       // RealSize
        alloc_size:    u64,       // AllocatedSize
        is_in_use:     bool,
        has_attr_list: bool,
        data_kind:     u8,        // 0=resident, 1=nonresident, 2=fallback
        file_attrs:    u32,       // from $STANDARD_INFORMATION (0x10)
    }

    struct ExtensionDataEntry {
        record_idx:         usize,
        base_record:        u64,
        file_name:          String,
        named_streams:      Vec<(String, u64, u64)>, // (name, real, alloc)
        unnamed_real:       u64,
        unnamed_alloc:      u64,
        real_size:          u64,   // total = unnamed + named
        alloc_size:         u64,   // total = unnamed + named
        has_unnamed_data:   bool,
        has_named_data:     bool,
        unnamed_data_flags: u16,   // OR of $DATA attr header flags for unnamed streams
    }

    // 診断カウンタ（全体）
    let file_sig_count    = AtomicUsize::new(0);
    let in_use_count      = AtomicUsize::new(0); // flags bit0=1
    let res_data_count    = AtomicUsize::new(0); // resident $DATA (全体)
    let nonres_data_count = AtomicUsize::new(0); // non-resident $DATA (全体)
    let fn_fallback_count = AtomicUsize::new(0); // $DATA 未発見 → fn_size 採用 (全体)
    let size_zero_count   = AtomicUsize::new(0); // size == 0 (全体)
    let size_1gb_count    = AtomicUsize::new(0); // size > 1GB (全体)
    // in-use only カウンタ（deleted = 全体 - in_use で導出）
    let res_data_iu       = AtomicUsize::new(0);
    let nonres_data_iu    = AtomicUsize::new(0);
    let fn_fallback_iu    = AtomicUsize::new(0);
    let size_zero_iu      = AtomicUsize::new(0);
    // $ATTRIBUTE_LIST (0x20) 観測カウンタ
    let attr_list_count        = AtomicUsize::new(0); // 全レコード中の $ATTRIBUTE_LIST 件数
    let attr_list_iu           = AtomicUsize::new(0); // in-use のみ
    let attr_list_iu_fallback  = AtomicUsize::new(0); // in-use + fn_size fallback
    let ext_in_use_count       = AtomicUsize::new(0);
    let ext_deleted_count      = AtomicUsize::new(0);
    let ext_with_file_name_iu  = AtomicUsize::new(0);
    let ext_without_file_name_iu = AtomicUsize::new(0);

    let parse_start = std::time::Instant::now();

    let parsed_records: Vec<(Option<ParsedEntry>, Option<ExtensionDataEntry>)> = mft_buf
        .par_chunks_exact(record_size)
        .enumerate()
        .filter_map(|(i, raw)| {
            let record = apply_fixup(raw)?;

            if record.len() < 4 || &record[0..4] != b"FILE" { return None; }
            file_sig_count.fetch_add(1, Ordering::Relaxed);

            if record.len() < 24 { return None; }

            // offset 22: flags (2 bytes) - bit0=in_use, bit1=directory
            let flags = u16::from_le_bytes([record[22], record[23]]);
            let is_in_use = flags & 0x01 != 0;
            if is_in_use {
                in_use_count.fetch_add(1, Ordering::Relaxed);
            }
            let base_record = if record.len() >= 40 {
                u64::from_le_bytes([
                    record[32], record[33], record[34], record[35],
                    record[36], record[37], record[38], record[39],
                ])
            } else {
                0
            };
            let is_extension = base_record != 0;
            if is_extension {
                if is_in_use {
                    ext_in_use_count.fetch_add(1, Ordering::Relaxed);
                } else {
                    ext_deleted_count.fetch_add(1, Ordering::Relaxed);
                }
            }

            let attr_start = u16::from_le_bytes([record[20], record[21]]) as usize;

            let mut pos              = attr_start;
            let mut name             = String::new();
            let mut parent_frn: u64  = 0;
            let mut fn_size:    u64  = 0;
            let mut data_size: Option<u64> = None;
            let mut best_ns_prio: u8 = 255;
            let mut found_res    = false;
            let mut found_nonres = false;
            let mut has_attr_list = false;
            let mut alloc_data_size: Option<u64> = None;
            let mut ext_real_size: u64 = 0;
            let mut ext_alloc_size: u64 = 0;
            let mut ext_unnamed_real: u64 = 0;
            let mut ext_unnamed_alloc: u64 = 0;
            let mut ext_has_data = false;
            let mut ext_has_unnamed_data = false;
            let mut ext_has_named_data = false;
            let mut ext_named_streams: Vec<(String, u64, u64)> = Vec::new();
            let mut file_attrs: u32 = 0;
            let mut ext_unnamed_data_flags: u16 = 0;

            loop {
                if pos + 8 > record.len() { break; }

                let attr_type = u32::from_le_bytes([
                    record[pos], record[pos+1], record[pos+2], record[pos+3],
                ]);
                let attr_len = u32::from_le_bytes([
                    record[pos+4], record[pos+5], record[pos+6], record[pos+7],
                ]) as usize;

                if attr_type == 0xFFFF_FFFF { break; }
                if attr_len == 0 || pos + attr_len > record.len() { break; }

                let non_resident = record[pos + 8];
                let stream_name_len = record[pos + 9] as usize;
                let stream_name = if stream_name_len > 0 && pos + 12 <= record.len() {
                    let name_off = u16::from_le_bytes([record[pos+10], record[pos+11]]) as usize;
                    let name_start = pos + name_off;
                    let name_end = name_start + stream_name_len * 2;
                    if name_end <= pos + attr_len && name_end <= record.len() {
                        let wide: Vec<u16> = record[name_start..name_end]
                            .chunks_exact(2)
                            .map(|b| u16::from_le_bytes([b[0], b[1]]))
                            .collect();
                        Some(String::from_utf16_lossy(&wide))
                    } else {
                        None
                    }
                } else {
                    None
                };

                match attr_type {
                    0x10 if non_resident == 0 => {
                        // $STANDARD_INFORMATION: file attributes DWORD at content+0x20
                        if pos + 22 <= record.len() {
                            let content_off = u16::from_le_bytes([record[pos+20], record[pos+21]]) as usize;
                            let c = pos + content_off;
                            if c + 0x24 <= record.len() {
                                file_attrs = u32::from_le_bytes([
                                    record[c+0x20], record[c+0x21], record[c+0x22], record[c+0x23],
                                ]);
                            }
                        }
                    }
                    0x30 if non_resident == 0 => {
                        // $FILE_NAME（常に常駐）
                        if pos + 22 > record.len() { pos += attr_len; continue; }
                        let content_off = u16::from_le_bytes([record[pos+20], record[pos+21]]) as usize;
                        let c = pos + content_off;
                        if c + 0x42 > record.len() { pos += attr_len; continue; }

                        let ns = record[c + 0x41];
                        // Win32(1) > Win32&DOS(3) > POSIX(0) > DOS(2)
                        let ns_prio: u8 = match ns { 1 => 0, 3 => 1, 0 => 2, 2 => 3, _ => 4 };

                        if ns_prio < best_ns_prio {
                            best_ns_prio = ns_prio;

                            if c + 8 <= record.len() {
                                let parent_raw = u64::from_le_bytes([
                                    record[c],   record[c+1], record[c+2], record[c+3],
                                    record[c+4], record[c+5], record[c+6], record[c+7],
                                ]);
                                parent_frn = parent_raw & 0x0000_FFFF_FFFF_FFFF;
                            }

                            if c + 0x38 <= record.len() {
                                fn_size = u64::from_le_bytes([
                                    record[c+0x30], record[c+0x31], record[c+0x32], record[c+0x33],
                                    record[c+0x34], record[c+0x35], record[c+0x36], record[c+0x37],
                                ]);
                            }

                            let name_chars = record[c + 0x40] as usize;
                            let name_start = c + 0x42;
                            let name_end   = name_start + name_chars * 2;
                            if name_end <= record.len() {
                                let wide: Vec<u16> = record[name_start..name_end]
                                    .chunks_exact(2)
                                    .map(|b| u16::from_le_bytes([b[0], b[1]]))
                                    .collect();
                                name = String::from_utf16_lossy(&wide);
                            }
                        }
                    }
                    0x80 => {
                        if is_extension {
                            let mut attr_real_size: Option<u64> = None;
                            let mut attr_alloc_size: Option<u64> = None;
                            if non_resident == 1 && pos + 56 <= record.len() {
                                attr_alloc_size = Some(u64::from_le_bytes([
                                    record[pos+40], record[pos+41], record[pos+42], record[pos+43],
                                    record[pos+44], record[pos+45], record[pos+46], record[pos+47],
                                ]));
                                attr_real_size = Some(u64::from_le_bytes([
                                    record[pos+48], record[pos+49], record[pos+50], record[pos+51],
                                    record[pos+52], record[pos+53], record[pos+54], record[pos+55],
                                ]));
                            } else if non_resident == 0 && pos + 20 <= record.len() {
                                let content_len = u32::from_le_bytes([
                                    record[pos+16], record[pos+17], record[pos+18], record[pos+19],
                                ]) as u64;
                                attr_real_size = Some(content_len);
                                attr_alloc_size = Some(content_len);
                            }

                            if let (Some(real), Some(alloc)) = (attr_real_size, attr_alloc_size) {
                                ext_has_data = true;
                                ext_real_size = ext_real_size.saturating_add(real);
                                ext_alloc_size = ext_alloc_size.saturating_add(alloc);
                                if stream_name_len == 0 {
                                    ext_has_unnamed_data = true;
                                    ext_unnamed_real = ext_unnamed_real.saturating_add(real);
                                    ext_unnamed_alloc = ext_unnamed_alloc.saturating_add(alloc);
                                    if pos + 14 <= record.len() {
                                        ext_unnamed_data_flags |= u16::from_le_bytes([record[pos+12], record[pos+13]]);
                                    }
                                } else {
                                    ext_has_named_data = true;
                                    if let Some(sn) = &stream_name {
                                        ext_named_streams.push((sn.clone(), real, alloc));
                                    }
                                }
                            }
                        }

                        // 無名 $DATA のみ・先着1件
                        // ガードをマッチアームから外して内側で判定（ADS 混在時も正しく処理）
                        if record[pos + 9] == 0 && data_size.is_none() {
                            if non_resident == 1 && pos + 56 <= record.len() {
                                // 非常駐: offset+48 = RealSize (offset+40 = AllocatedSize)
                                alloc_data_size = Some(u64::from_le_bytes([
                                    record[pos+40], record[pos+41], record[pos+42], record[pos+43],
                                    record[pos+44], record[pos+45], record[pos+46], record[pos+47],
                                ]));
                                data_size = Some(u64::from_le_bytes([
                                    record[pos+48], record[pos+49], record[pos+50], record[pos+51],
                                    record[pos+52], record[pos+53], record[pos+54], record[pos+55],
                                ]));
                                found_nonres = true;
                            } else if non_resident == 0 && pos + 20 <= record.len() {
                                // 常駐: offset+16 = ContentLength (u32)
                                let content_len = u32::from_le_bytes([
                                    record[pos+16], record[pos+17], record[pos+18], record[pos+19],
                                ]) as u64;
                                data_size       = Some(content_len);
                                alloc_data_size = Some(content_len);
                                found_res = true;
                            }
                        }
                    }
                    0x20 => {
                        has_attr_list = true;
                    }
                    _ => {}
                }

                pos += attr_len;
            }

            if is_extension && is_in_use {
                if name.is_empty() {
                    ext_without_file_name_iu.fetch_add(1, Ordering::Relaxed);
                } else {
                    ext_with_file_name_iu.fetch_add(1, Ordering::Relaxed);
                }
            }

            if has_attr_list {
                attr_list_count.fetch_add(1, Ordering::Relaxed);
                if is_in_use { attr_list_iu.fetch_add(1, Ordering::Relaxed); }
            }

            let ext_data = if is_extension && is_in_use && ext_has_data {
                Some(ExtensionDataEntry {
                    record_idx: i,
                    base_record,
                    file_name: name.clone(),
                    named_streams: ext_named_streams,
                    unnamed_real: ext_unnamed_real,
                    unnamed_alloc: ext_unnamed_alloc,
                    real_size: ext_real_size,
                    alloc_size: ext_alloc_size,
                    has_unnamed_data: ext_has_unnamed_data,
                    has_named_data: ext_has_named_data,
                    unnamed_data_flags: ext_unnamed_data_flags,
                })
            } else {
                None
            };

            if name.is_empty() {
                return Some((None, ext_data));
            }

            if found_res {
                res_data_count.fetch_add(1, Ordering::Relaxed);
                if is_in_use { res_data_iu.fetch_add(1, Ordering::Relaxed); }
            }
            if found_nonres {
                nonres_data_count.fetch_add(1, Ordering::Relaxed);
                if is_in_use { nonres_data_iu.fetch_add(1, Ordering::Relaxed); }
            }

            let (size, alloc_size, data_kind) = if found_res {
                (data_size.unwrap(), alloc_data_size.unwrap(), 0u8)
            } else if found_nonres {
                (data_size.unwrap(), alloc_data_size.unwrap(), 1u8)
            } else {
                fn_fallback_count.fetch_add(1, Ordering::Relaxed);
                if is_in_use {
                    fn_fallback_iu.fetch_add(1, Ordering::Relaxed);
                    if has_attr_list { attr_list_iu_fallback.fetch_add(1, Ordering::Relaxed); }
                }
                (fn_size, fn_size, 2u8)
            };

            if size == 0 {
                size_zero_count.fetch_add(1, Ordering::Relaxed);
                if is_in_use { size_zero_iu.fetch_add(1, Ordering::Relaxed); }
            }
            if size > 1_073_741_824 { size_1gb_count.fetch_add(1, Ordering::Relaxed); }

            Some((Some(ParsedEntry { record_idx: i, name, parent_frn, size, alloc_size, is_in_use, has_attr_list, data_kind, file_attrs }), ext_data))
        })
        .collect();

    let (entries, ext_data_entries): (Vec<_>, Vec<_>) = parsed_records
        .into_iter()
        .fold((Vec::new(), Vec::new()), |mut acc, (entry, ext_data)| {
            if let Some(entry) = entry {
                acc.0.push(entry);
            }
            if let Some(ext_data) = ext_data {
                acc.1.push(ext_data);
            }
            acc
        });

    let parse_elapsed = parse_start.elapsed();
    let total_elapsed = total_start.elapsed();

    // カウンタ読み取り
    let file_sig_total    = file_sig_count.load(Ordering::Relaxed);
    let in_use_sig_total  = in_use_count.load(Ordering::Relaxed);
    let del_sig_total     = file_sig_total.saturating_sub(in_use_sig_total);
    let res_iu            = res_data_iu.load(Ordering::Relaxed);
    let nonres_iu         = nonres_data_iu.load(Ordering::Relaxed);
    let fallback_iu       = fn_fallback_iu.load(Ordering::Relaxed);
    let zero_iu           = size_zero_iu.load(Ordering::Relaxed);
    let res_del           = res_data_count.load(Ordering::Relaxed).saturating_sub(res_iu);
    let nonres_del        = nonres_data_count.load(Ordering::Relaxed).saturating_sub(nonres_iu);
    let fallback_del      = fn_fallback_count.load(Ordering::Relaxed).saturating_sub(fallback_iu);
    let zero_del          = size_zero_count.load(Ordering::Relaxed).saturating_sub(zero_iu);
    let size_1gb_total    = size_1gb_count.load(Ordering::Relaxed);

    // $ATTRIBUTE_LIST カウンタ読み取り
    let al_total          = attr_list_count.load(Ordering::Relaxed);
    let al_iu             = attr_list_iu.load(Ordering::Relaxed);
    let al_del            = al_total.saturating_sub(al_iu);
    let al_iu_fallback    = attr_list_iu_fallback.load(Ordering::Relaxed);
    let al_iu_zero        = entries.iter()
        .filter(|e| e.has_attr_list && e.is_in_use && e.size == 0)
        .count();

    // in-use / deleted のエントリ数・サイズ
    let iu_entries  = entries.iter().filter(|e|  e.is_in_use).count();
    let del_entries = entries.iter().filter(|e| !e.is_in_use).count();
    let total_size_iu:  u64 = entries.iter().filter(|e|  e.is_in_use).map(|e| e.size).sum();
    let total_size_del: u64 = entries.iter().filter(|e| !e.is_in_use).map(|e| e.size).sum();
    let total_alloc_iu: u64 = entries.iter().filter(|e|  e.is_in_use).map(|e| e.alloc_size).sum();
    let total_alloc_del:u64 = entries.iter().filter(|e| !e.is_in_use).map(|e| e.alloc_size).sum();

    // RealSize/AllocatedSize 縺ｮ遞ｮ蛻･蜀・ｨｳ・・n-use 縺ｮ縺ｿ・・
    let res_real_iu:     u64 = entries.iter().filter(|e| e.is_in_use && e.data_kind == 0).map(|e| e.size).sum();
    let res_alloc_iu:    u64 = entries.iter().filter(|e| e.is_in_use && e.data_kind == 0).map(|e| e.alloc_size).sum();
    let nonres_real_iu:  u64 = entries.iter().filter(|e| e.is_in_use && e.data_kind == 1).map(|e| e.size).sum();
    let nonres_alloc_iu: u64 = entries.iter().filter(|e| e.is_in_use && e.data_kind == 1).map(|e| e.alloc_size).sum();
    let fallback_cnt_iu: usize = entries.iter().filter(|e| e.is_in_use && e.data_kind == 2).count();
    let fallback_real_iu: u64 = entries.iter().filter(|e| e.is_in_use && e.data_kind == 2).map(|e| e.size).sum();

    // top 20: in-use のみ
    let mut top20: Vec<&ParsedEntry> = entries.iter()
        .filter(|e| e.is_in_use && e.size > 0)
        .collect();
    top20.sort_unstable_by(|a, b| b.size.cmp(&a.size));
    top20.truncate(20);

    // top 20: $ATTRIBUTE_LIST を持つ in-use のみ
    let mut top20_al: Vec<&ParsedEntry> = entries.iter()
        .filter(|e| e.has_attr_list && e.is_in_use && e.size > 0)
        .collect();
    top20_al.sort_unstable_by(|a, b| b.size.cmp(&a.size));
    top20_al.truncate(20);

    let ext_in_use_total = ext_in_use_count.load(Ordering::Relaxed);
    let ext_deleted_total = ext_deleted_count.load(Ordering::Relaxed);
    let ext_with_data_iu = ext_data_entries.len();
    let ext_with_unnamed_data_iu = ext_data_entries.iter().filter(|e| e.has_unnamed_data).count();
    let ext_with_named_data_iu = ext_data_entries.iter().filter(|e| e.has_named_data).count();
    let ext_real_total_iu: u64 = ext_data_entries.iter().map(|e| e.real_size).sum();
    let ext_alloc_total_iu: u64 = ext_data_entries.iter().map(|e| e.alloc_size).sum();
    let ext_with_file_name_total_iu = ext_with_file_name_iu.load(Ordering::Relaxed);
    let ext_without_file_name_total_iu = ext_without_file_name_iu.load(Ordering::Relaxed);

    let mut top20_ext_data: Vec<&ExtensionDataEntry> = ext_data_entries.iter()
        .filter(|e| e.real_size > 0 || e.alloc_size > 0)
        .collect();
    top20_ext_data.sort_unstable_by(|a, b| {
        b.alloc_size
            .cmp(&a.alloc_size)
            .then_with(|| b.real_size.cmp(&a.real_size))
    });
    top20_ext_data.truncate(20);

    println!();
    println!("=== probe6 結果 ===");
    println!("total records:                  {:>10}", total_records);
    println!("valid FILE records:             {:>10}", file_sig_total);
    println!("  in-use  (flags bit0=1):       {:>10}", in_use_sig_total);
    println!("  deleted (flags bit0=0):       {:>10}", del_sig_total);
    println!();
    println!("parsed file entries (all):      {:>10}", entries.len());
    println!("  in-use:                       {:>10}", iu_entries);
    println!("  deleted:                      {:>10}", del_entries);
    println!();
    println!("$DATA breakdown        (in-use / deleted):");
    println!("  resident $DATA:     {:>10} / {:>10}", res_iu,      res_del);
    println!("  non-resident $DATA: {:>10} / {:>10}", nonres_iu,   nonres_del);
    println!("  fn_size fallback:   {:>10} / {:>10}  ($DATA not in base record)", fallback_iu, fallback_del);
    println!("  size == 0:          {:>10} / {:>10}", zero_iu,     zero_del);
    println!("  size > 1GB (all):   {:>10}", size_1gb_total);
    println!();
    println!("RealSize/AllocatedSize (in-use):");
    println!("  total real  size in-use:  {:>7} GB ({} bytes)", total_size_iu  / 1_073_741_824, total_size_iu);
    println!("  total alloc size in-use:  {:>7} GB ({} bytes)", total_alloc_iu / 1_073_741_824, total_alloc_iu);
    let slack_iu = total_alloc_iu.saturating_sub(total_size_iu);
    let over_iu  = total_size_iu.saturating_sub(total_alloc_iu);
    println!("  alloc - real (slack):     {:>7} GB ({} bytes)", slack_iu / 1_073_741_824, slack_iu);
    println!("  real - alloc (over):      {:>7} GB ({} bytes)", over_iu  / 1_073_741_824, over_iu);
    println!();
    println!("RealSize/AllocatedSize breakdown (in-use):");
    println!("  resident   real / alloc:  {:>7} GB / {:>7} GB", res_real_iu    / 1_073_741_824, res_alloc_iu    / 1_073_741_824);
    println!("  nonresident real / alloc: {:>7} GB / {:>7} GB", nonres_real_iu / 1_073_741_824, nonres_alloc_iu / 1_073_741_824);
    println!("  fallback    count / real: {:>10} / {:>7} GB  (fn_size, alloc==real)", fallback_cnt_iu, fallback_real_iu / 1_073_741_824);
    println!();
    println!("deleted (simplified):");
    println!("  total real  size deleted: {:>7} GB", total_size_del  / 1_073_741_824);
    println!("  total alloc size deleted: {:>7} GB", total_alloc_del / 1_073_741_824);
    println!("parse elapsed:        {:.2}秒", parse_elapsed.as_secs_f64());
    println!("total elapsed:        {:.2}秒", total_elapsed.as_secs_f64());
    println!();
    println!("--- top 20 largest (in-use only, by real size) ---");
    for (rank, e) in top20.iter().enumerate() {
        println!("{:>3}. real={:>8}MB alloc={:>8}MB  {}  (parent_frn={}, idx={})",
            rank + 1, e.size / 1_048_576, e.alloc_size / 1_048_576, e.name, e.parent_frn, e.record_idx);
    }

    println!();
    println!("$ATTRIBUTE_LIST (0x20) 観測:");
    println!("  records with $ATTR_LIST (all):     {:>10}", al_total);
    println!("  records with $ATTR_LIST (in-use):  {:>10}", al_iu);
    println!("  records with $ATTR_LIST (deleted): {:>10}", al_del);
    println!("  $ATTR_LIST + fn_fallback (in-use): {:>10}  (= $DATA in extension record)", al_iu_fallback);
    println!("  $ATTR_LIST + size==0    (in-use):  {:>10}", al_iu_zero);
    println!();
    println!("--- top 20 largest with $ATTR_LIST (in-use only) ---");
    for (rank, e) in top20_al.iter().enumerate() {
        println!("{:>3}. {:>10} MB  {}  (parent_frn={}, idx={})",
            rank + 1, e.size / 1_048_576, e.name, e.parent_frn, e.record_idx);
    }

    println!();
    println!("Extension records (base_record != 0) diagnostics:");
    println!("  in-use extension records:                 {:>10}", ext_in_use_total);
    println!("  deleted extension records:                {:>10}", ext_deleted_total);
    println!("  in-use extension records with $DATA:      {:>10}", ext_with_data_iu);
    println!("  in-use extension records with unnamed $DATA: {:>7}", ext_with_unnamed_data_iu);
    println!("  in-use extension records with named $DATA:   {:>7}", ext_with_named_data_iu);
    println!("  in-use extension $DATA real total:        {:>10} GB ({} bytes)", ext_real_total_iu / 1_073_741_824, ext_real_total_iu);
    println!("  in-use extension $DATA alloc total:       {:>10} GB ({} bytes)", ext_alloc_total_iu / 1_073_741_824, ext_alloc_total_iu);
    println!("  in-use extension records with $FILE_NAME: {:>10}", ext_with_file_name_total_iu);
    println!("  in-use extension records without $FILE_NAME: {:>7}", ext_without_file_name_total_iu);
    println!();
    println!("--- top 20 largest extension records with $DATA (in-use only, by allocated size) ---");
    for (rank, e) in top20_ext_data.iter().enumerate() {
        let streams = if e.named_streams.is_empty() {
            String::from("(unnamed)")
        } else {
            e.named_streams.iter().map(|(n, _, _)| n.as_str()).collect::<Vec<_>>().join(",")
        };
        let file_name = if e.file_name.is_empty() { "(no $FILE_NAME)" } else { e.file_name.as_str() };
        println!("{:>3}. real={:>8}MB alloc={:>8}MB base_record={} idx={} stream={} file={}",
            rank + 1,
            e.real_size / 1_048_576,
            e.alloc_size / 1_048_576,
            e.base_record,
            e.record_idx,
            streams,
            file_name);
    }

    // ── base_record グループ集計 ──────────────────────────────────────────────
    {
        use std::collections::{BTreeSet, HashMap};

        struct BaseGroup {
            base_record_number: u64,
            ext_count:          usize,
            unnamed_data_count: usize,
            named_data_count:   usize,
            unnamed_real:       u64,
            unnamed_alloc:      u64,
            named_alloc:        u64,
            j_alloc:            u64,
            wof_alloc:          u64,
            stream_names:       BTreeSet<String>,
            file_name:          String,
            data_flags:         u16,   // OR of unnamed $DATA attr header flags from ext records
        }

        let mut base_groups: HashMap<u64, BaseGroup> = HashMap::new();
        let mut j_real:      u64 = 0;
        let mut j_alloc:     u64 = 0;
        let mut wof_real:    u64 = 0;
        let mut wof_alloc:   u64 = 0;
        let mut ext_unnamed_real_total:  u64 = 0;
        let mut ext_unnamed_alloc_total: u64 = 0;
        let mut ext_named_real_total:    u64 = 0;
        let mut ext_named_alloc_total:   u64 = 0;

        for e in &ext_data_entries {
            ext_unnamed_real_total  = ext_unnamed_real_total.saturating_add(e.unnamed_real);
            ext_unnamed_alloc_total = ext_unnamed_alloc_total.saturating_add(e.unnamed_alloc);

            let ns_real:  u64 = e.named_streams.iter().map(|(_, r, _)| *r).sum();
            let ns_alloc: u64 = e.named_streams.iter().map(|(_, _, a)| *a).sum();
            ext_named_real_total  = ext_named_real_total.saturating_add(ns_real);
            ext_named_alloc_total = ext_named_alloc_total.saturating_add(ns_alloc);

            for (sname, sreal, salloc) in &e.named_streams {
                if sname == "$J" {
                    j_real  = j_real.saturating_add(*sreal);
                    j_alloc = j_alloc.saturating_add(*salloc);
                }
                if sname == "WofCompressedData" {
                    wof_real  = wof_real.saturating_add(*sreal);
                    wof_alloc = wof_alloc.saturating_add(*salloc);
                }
            }

            let group = base_groups.entry(e.base_record).or_insert_with(|| BaseGroup {
                base_record_number: e.base_record & 0x0000_FFFF_FFFF_FFFF,
                ext_count: 0,
                unnamed_data_count: 0,
                named_data_count: 0,
                unnamed_real: 0,
                unnamed_alloc: 0,
                named_alloc: 0,
                j_alloc: 0,
                wof_alloc: 0,
                stream_names: BTreeSet::new(),
                file_name: String::new(),
                data_flags: 0,
            });
            group.ext_count += 1;
            if e.has_unnamed_data { group.unnamed_data_count += 1; }
            if e.has_named_data   { group.named_data_count   += 1; }
            group.unnamed_real  = group.unnamed_real.saturating_add(e.unnamed_real);
            group.unnamed_alloc = group.unnamed_alloc.saturating_add(e.unnamed_alloc);
            group.named_alloc   = group.named_alloc.saturating_add(ns_alloc);
            for (sname, _, salloc) in &e.named_streams {
                group.stream_names.insert(sname.clone());
                if sname == "$J"                { group.j_alloc   = group.j_alloc.saturating_add(*salloc); }
                if sname == "WofCompressedData" { group.wof_alloc = group.wof_alloc.saturating_add(*salloc); }
            }
            if group.file_name.is_empty() && !e.file_name.is_empty() {
                group.file_name = e.file_name.clone();
            }
            group.data_flags |= e.unnamed_data_flags;
        }

        let base_groups_count = base_groups.len();

        // base entry lookup: record_idx → &ParsedEntry (in-use のみ)
        let base_entry_lookup: std::collections::HashMap<u64, &ParsedEntry> = entries.iter()
            .filter(|e| e.is_in_use)
            .map(|e| (e.record_idx as u64, e))
            .collect();

        // top 30: ext alloc total 降順
        let mut bg_vec: Vec<(u64, &BaseGroup)> = base_groups.iter()
            .map(|(k, v)| (*k, v))
            .collect();
        bg_vec.sort_unstable_by(|a, b| {
            let a_total = a.1.unnamed_alloc + a.1.named_alloc;
            let b_total = b.1.unnamed_alloc + b.1.named_alloc;
            b_total.cmp(&a_total)
        });
        bg_vec.truncate(30);

        // サマリ集計
        let mut base_alloc_zero_with_ext_unnamed: usize = 0;
        let mut total_candidate_recovered: u64 = 0;
        for (_raw, g) in &base_groups {
            let base_alloc = base_entry_lookup
                .get(&g.base_record_number)
                .map(|e| e.alloc_size)
                .unwrap_or(0);
            if base_alloc == 0 && g.unnamed_alloc > 0 {
                base_alloc_zero_with_ext_unnamed += 1;
                total_candidate_recovered = total_candidate_recovered.saturating_add(g.unnamed_alloc);
            }
        }

        println!();
        println!("=== extension base_record grouping diagnostics ===");
        println!("  base groups (distinct base_record):        {:>10}", base_groups_count);
        println!("  ext records with $DATA (in-use):           {:>10}", ext_data_entries.len());
        println!();
        println!("  unnamed ext $DATA real  total:   {:>7} GB ({} bytes)", ext_unnamed_real_total  / 1_073_741_824, ext_unnamed_real_total);
        println!("  unnamed ext $DATA alloc total:   {:>7} GB ({} bytes)", ext_unnamed_alloc_total / 1_073_741_824, ext_unnamed_alloc_total);
        println!("  named   ext $DATA real  total:   {:>7} GB ({} bytes)", ext_named_real_total    / 1_073_741_824, ext_named_real_total);
        println!("  named   ext $DATA alloc total:   {:>7} GB ({} bytes)", ext_named_alloc_total   / 1_073_741_824, ext_named_alloc_total);
        println!();
        println!("  special stream totals:");
        println!("    $J              real={:>6}GB alloc={:>6}GB", j_real   / 1_073_741_824, j_alloc   / 1_073_741_824);
        println!("    WofCompressedData real={:>3}GB alloc={:>6}GB", wof_real / 1_073_741_824, wof_alloc / 1_073_741_824);
        println!();
        println!("--- correlation summary ---");
        println!("  base groups with extension records:              {:>8}", base_groups_count);
        println!("  base alloc==0 AND ext unnamed alloc>0:           {:>8}", base_alloc_zero_with_ext_unnamed);
        println!("  total candidate recovered (ext unnamed, base=0): {:>8} GB ({} bytes)", total_candidate_recovered / 1_073_741_824, total_candidate_recovered);
        println!("  total named ext alloc excluded:                  {:>8} GB", ext_named_alloc_total / 1_073_741_824);
        println!("  total $J alloc excluded:                         {:>8} GB", j_alloc / 1_073_741_824);
        println!("  total WofCompressedData alloc separated:         {:>8} GB", wof_alloc / 1_073_741_824);
        println!();
        println!("--- top 30 base/extension correlation (by ext alloc total) ---");
        println!("  cand = base_alloc if >0, else ext_unnamed_alloc  |  named streams shown separately only");
        for (rank, (_raw_base, g)) in bg_vec.iter().enumerate() {
            let base_entry  = base_entry_lookup.get(&g.base_record_number);
            let base_alloc  = base_entry.map(|e| e.alloc_size).unwrap_or(0);
            let base_kind   = base_entry.map(|e| e.data_kind).unwrap_or(255);
            let base_has_al = base_entry.map(|e| e.has_attr_list).unwrap_or(false);
            let base_name: &str = {
                let from_entry = base_entry.map(|e| e.name.as_str()).unwrap_or("");
                if !from_entry.is_empty()   { from_entry }
                else if !g.file_name.is_empty() { g.file_name.as_str() }
                else                        { "(no name)" }
            };
            let candidate    = if base_alloc == 0 { g.unnamed_alloc } else { base_alloc };
            let total_ext    = g.unnamed_alloc + g.named_alloc;
            let has_j        = g.j_alloc > 0;
            let has_wof      = g.wof_alloc > 0;
            let mut notes: Vec<&str> = Vec::new();
            if base_alloc > 0   { notes.push("base_has_data"); }
            if base_has_al      { notes.push("attr_list"); }
            if base_kind == 2   { notes.push("fn_fallback"); }
            if has_j            { notes.push("has_j"); }
            if has_wof          { notes.push("has_wof"); }
            if g.unnamed_alloc > 0 { notes.push("unnamed_ext"); }
            if g.named_alloc > 0 && !has_j && !has_wof { notes.push("named_only"); }
            println!("{:>3}. rec={:<8} base={:>7}MB uext={:>7}MB nalloc={:>7}MB $J={:>6}MB wof={:>4}MB ext_tot={:>7}MB cand={:>7}MB  {}  [{}]",
                rank + 1,
                g.base_record_number,
                base_alloc        / 1_048_576,
                g.unnamed_alloc   / 1_048_576,
                g.named_alloc     / 1_048_576,
                g.j_alloc         / 1_048_576,
                g.wof_alloc       / 1_048_576,
                total_ext         / 1_048_576,
                candidate         / 1_048_576,
                base_name,
                notes.join(","));
        }

        // ── top-100 candidate classification ─────────────────────────────
        {
            let classify = |name: &str| -> &'static str {
                let lower = name.to_lowercase();
                let s = lower.as_str();
                match s {
                    "hiberfil.sys" | "pagefile.sys" | "swapfile.sys" |
                    "$mft" | "$logfile" | "$usnjrnl" | "$bitmap" | "$volume" |
                    "$attrdef" | "$badclus" | "$secure" | "$boot" | "$extend"
                        => return "system",
                    _ => {}
                }
                if s.starts_with('$') { return "system"; }
                if s.contains("codex") || s.contains("claude") ||
                   s.contains("gemini") || s.contains("vscode-server") { return "ai_tool"; }
                if s.ends_with(".vhd") || s.ends_with(".vhdx") ||
                   s.ends_with(".img") || s.ends_with(".iso")  { return "virtual_disk"; }
                if s.ends_with(".msi") || s.ends_with(".exe")  ||
                   s.ends_with(".esd") || s.ends_with(".wim")  ||
                   s.ends_with(".cab")                          { return "installer"; }
                if s.ends_with(".db")     || s.ends_with(".edb") ||
                   s.ends_with(".sqlite") || s.ends_with(".vc.db") { return "database"; }
                if s.ends_with(".zip") || s.ends_with(".gz")  ||
                   s.ends_with(".tar") || s.ends_with(".zst") ||
                   s.ends_with(".7z")                          { return "archive"; }
                "other"
            };

            // candidates: base_alloc==0 AND ext unnamed alloc>0
            let mut candidates: Vec<&BaseGroup> = base_groups.values()
                .filter(|g| {
                    let ba = base_entry_lookup.get(&g.base_record_number).map(|e| e.alloc_size).unwrap_or(0);
                    ba == 0 && g.unnamed_alloc > 0
                })
                .collect();
            candidates.sort_unstable_by(|a, b| b.unnamed_alloc.cmp(&a.unnamed_alloc));

            let candidate_total_all: u64    = candidates.iter().map(|g| g.unnamed_alloc).sum();
            let candidate_top100_total: u64 = candidates.iter().take(100).map(|g| g.unnamed_alloc).sum();
            let candidate_outside_top100: u64 = candidate_total_all.saturating_sub(candidate_top100_total);

            // category totals over top-100
            let categories = ["system","virtual_disk","installer","database","archive","ai_tool","other"];
            let mut cat_count: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
            let mut cat_alloc: std::collections::HashMap<&str, u64>   = std::collections::HashMap::new();
            for g in candidates.iter().take(100) {
                let from_entry = base_entry_lookup.get(&g.base_record_number).map(|e| e.name.as_str()).unwrap_or("");
                let base_name: &str = if !from_entry.is_empty()       { from_entry }
                                      else if !g.file_name.is_empty() { g.file_name.as_str() }
                                      else                             { "" };
                let cat = classify(base_name);
                *cat_count.entry(cat).or_insert(0) += 1;
                *cat_alloc.entry(cat).or_insert(0) = cat_alloc.get(cat).copied().unwrap_or(0).saturating_add(g.unnamed_alloc);
            }

            println!();
            println!("=== recovered candidate top-100 classification ===");
            println!("  total candidates (base_alloc==0, ext_unnamed>0): {}", candidates.len());
            println!("  candidate_total_all:      {:>8} GB ({} bytes)", candidate_total_all   / 1_073_741_824, candidate_total_all);
            println!("  candidate_top100_total:   {:>8} GB ({} bytes)", candidate_top100_total / 1_073_741_824, candidate_top100_total);
            println!("  candidate_outside_top100: {:>8} GB ({} bytes)", candidate_outside_top100 / 1_073_741_824, candidate_outside_top100);
            println!();
            println!("--- category summary (top-100) ---");
            for c in &categories {
                println!("  {:>12}: {:>5} files  {:>8} GB ({} MB)",
                    c,
                    cat_count.get(c).copied().unwrap_or(0),
                    cat_alloc.get(c).copied().unwrap_or(0) / 1_073_741_824,
                    cat_alloc.get(c).copied().unwrap_or(0) / 1_048_576);
            }
            println!();
            println!("--- top-100 candidates detail ---");
            println!("  note: base_alloc/fn_fb/cur_used are expected to be 0 for all candidates (filter: base_alloc==0)");
            for (rank, g) in candidates.iter().take(100).enumerate() {
                let base_entry       = base_entry_lookup.get(&g.base_record_number);
                let base_has_al      = base_entry.map(|e| e.has_attr_list).unwrap_or(false);
                let parent_frn       = base_entry.map(|e| e.parent_frn).unwrap_or(0);
                let base_alloc_bytes = base_entry.map(|e| e.alloc_size).unwrap_or(0);
                let base_dk          = base_entry.map(|e| e.data_kind).unwrap_or(255);
                // fn_fallback_size: fn_size used as fallback (data_kind==2); 0 for non-fallback
                // For candidates, alloc_size==0, so if data_kind==2 then fn_size==0 too
                let fn_fb_bytes      = if base_dk == 2 { base_entry.map(|e| e.size).unwrap_or(0) } else { 0 };
                let cur_used_bytes   = base_alloc_bytes; // what currently contributes to total_alloc_iu
                let repl_delta: i64  = g.unnamed_alloc as i64 - cur_used_bytes as i64;
                let from_entry  = base_entry.map(|e| e.name.as_str()).unwrap_or("");
                let base_name: &str  = if !from_entry.is_empty()       { from_entry }
                                       else if !g.file_name.is_empty() { g.file_name.as_str() }
                                       else                             { "(no name)" };
                let cat     = classify(base_name);
                let file_attrs_val = base_entry.map(|e| e.file_attrs).unwrap_or(0);
                let data_flags_val = g.data_flags;
                let is_cmp = file_attrs_val & 0x0800 != 0 || data_flags_val & 0x0001 != 0;
                let is_sps = file_attrs_val & 0x0200 != 0 || data_flags_val & 0x8000 != 0;
                let is_rps = file_attrs_val & 0x0400 != 0;
                let is_sys = file_attrs_val & 0x0004 != 0;
                let is_hid = file_attrs_val & 0x0002 != 0;
                let is_off = file_attrs_val & 0x1000 != 0;
                let ext_str: &str = base_name.rfind('.').map(|i| &base_name[i..]).unwrap_or("");
                let streams = if g.stream_names.is_empty() { "-".to_string() }
                              else { g.stream_names.iter().cloned().collect::<Vec<_>>().join(",") };
                println!("{:>4}. alloc={:>7}MB real={:>7}MB rec={:<8} pfn={:<8} ext={} unm={} nam={} al={} wof={} j={} base_alloc={}MB fn_fb={}MB cur_used={}MB repl_delta={:+}MB attrs=0x{:04X} dflags=0x{:04X} cmp={} sps={} rps={} sys={} hid={} off={} streams=[{}] fext=[{}] cat={} name={}",
                    rank + 1,
                    g.unnamed_alloc    / 1_048_576,
                    g.unnamed_real     / 1_048_576,
                    g.base_record_number,
                    parent_frn,
                    g.ext_count,
                    g.unnamed_data_count,
                    g.named_data_count,
                    base_has_al as u8,
                    (g.wof_alloc > 0) as u8,
                    (g.j_alloc > 0) as u8,
                    base_alloc_bytes / 1_048_576,
                    fn_fb_bytes      / 1_048_576,
                    cur_used_bytes   / 1_048_576,
                    repl_delta       / 1_048_576_i64,
                    file_attrs_val,
                    data_flags_val,
                    is_cmp as u8,
                    is_sps as u8,
                    is_rps as u8,
                    is_sys as u8,
                    is_hid as u8,
                    is_off as u8,
                    streams,
                    ext_str,
                    cat,
                    base_name);
            }

            // ── dry-run adjusted allocated total ─────────────────────────
            // formula: adjusted = current_alloc - candidate_entry_size_used_total + candidate_ext_unnamed_alloc_total
            //
            // candidate_entry_size_used = entry.alloc_size for each candidate's base record.
            // Because filter condition is base_alloc==0 (entry.alloc_size==0), this total is
            // always 0 by definition. Candidates contribute NOTHING to the current total_alloc_iu.
            //   - data_kind==2 (fallback): alloc_size = fn_size; fn_size==0 because base_alloc==0
            //   - data_kind==0 (resident): alloc_size = content_len = 0
            //   - data_kind==1 (nonresident): AllocatedSize==0 (no allocated clusters)
            // Therefore adjusted = current_alloc + ext_unnamed_alloc (pure addition).
            // If adjusted > Windows Used, not all 40GB should be added (some is already accounted
            // for elsewhere, or belongs to excluded categories).
            let cand_entry_size_used_total: u64 = candidates.iter()
                .filter_map(|g| base_entry_lookup.get(&g.base_record_number).map(|e| e.alloc_size))
                .sum();
            // sanity check: should be 0 (base_alloc==0 is the filter)
            let cand_nonzero_entry_used = candidates.iter()
                .filter(|g| base_entry_lookup.get(&g.base_record_number).map(|e| e.alloc_size).unwrap_or(0) > 0)
                .count();
            let cand_ext_unnamed_alloc: u64 = candidate_total_all;
            let net_recovered: i64 = cand_ext_unnamed_alloc as i64 - cand_entry_size_used_total as i64;
            let adjusted_alloc: u64 = (total_alloc_iu as i64
                - cand_entry_size_used_total as i64
                + cand_ext_unnamed_alloc as i64).max(0) as u64;
            let windows_used: u64 = (176.28f64 * 1_073_741_824f64) as u64;
            let diff: i64 = windows_used as i64 - adjusted_alloc as i64;

            println!();
            println!("=== dry-run adjusted allocated total ===");
            println!("  formula: adjusted = current_alloc - candidate_entry_size_used + candidate_ext_unnamed_alloc");
            println!();
            println!("  candidate count:                      {:>8}", candidates.len());
            println!("  candidate entry_size_used total:      {:>8} GB  ({} bytes)", cand_entry_size_used_total / 1_073_741_824, cand_entry_size_used_total);
            println!("    (= 0 because filter is base_alloc==0; all candidates have alloc_size==0)");
            println!("    candidates with non-zero entry_alloc (sanity): {}", cand_nonzero_entry_used);
            println!("  candidate ext unnamed alloc total:    {:>8} GB  ({} bytes)", cand_ext_unnamed_alloc / 1_073_741_824, cand_ext_unnamed_alloc);
            println!("  net recovered (ext_unnamed - used):   {:>+8} GB  ({:+} bytes)", net_recovered / 1_073_741_824_i64, net_recovered);
            println!();
            println!("  current allocated total:              {:>8} GB  ({} bytes)", total_alloc_iu / 1_073_741_824, total_alloc_iu);
            println!("  adjusted allocated total:             {:>8} GB  ({} bytes)", adjusted_alloc / 1_073_741_824, adjusted_alloc);
            println!("    (= current + net_recovered, since used==0: effectively current + ext_unnamed)");
            println!();
            println!("  Windows Used (176.28 GB):             {:>8} GB  ({} bytes)", windows_used / 1_073_741_824, windows_used);
            println!("  diff (Windows - adjusted):            {:>+8} GB  ({:+} bytes)", diff / 1_073_741_824_i64, diff);
            println!("  (negative = adjusted exceeds Windows Used; not all 40GB should be added)");

            // ── candidate exclusion rule dry-runs ─────────────────────────
            {
                // compute name + category for ALL 3350 candidates (not just top-100)
                let cand_details: Vec<(u64, String, &'static str, u32, u16, bool)> = candidates.iter()
                    .map(|g| {
                        let entry = base_entry_lookup.get(&g.base_record_number);
                        let from_e = entry.map(|e| e.name.as_str()).unwrap_or("");
                        let name = if !from_e.is_empty()           { from_e.to_string() }
                                   else if !g.file_name.is_empty() { g.file_name.clone() }
                                   else                             { String::new() };
                        let cat = classify(&name);
                        let fa  = entry.map(|e| e.file_attrs).unwrap_or(0);
                        let df  = g.data_flags;
                        let wof = g.wof_alloc > 0;
                        (g.unnamed_alloc, name, cat, fa, df, wof)
                    })
                    .collect();

                // returns (excl_count, excl_alloc, incl_count, incl_alloc, adjusted, diff_from_windows)
                let run_rule = |excl_cats: &[&str], excl_names: &[&str]| -> (usize, u64, usize, u64, u64, i64) {
                    let mut excl_count: usize = 0;
                    let mut excl_alloc: u64   = 0;
                    let mut incl_count: usize = 0;
                    let mut incl_alloc: u64   = 0;
                    for (alloc, name, cat, _fa, _df, _wof) in &cand_details {
                        let lower   = name.to_lowercase();
                        let is_excl = excl_cats.contains(cat)
                            || excl_names.iter().any(|n| *n == lower.as_str());
                        if is_excl {
                            excl_count += 1;
                            excl_alloc  = excl_alloc.saturating_add(*alloc);
                        } else {
                            incl_count += 1;
                            incl_alloc  = incl_alloc.saturating_add(*alloc);
                        }
                    }
                    let adj  = total_alloc_iu + incl_alloc;
                    let diff = windows_used as i64 - adj as i64;
                    (excl_count, excl_alloc, incl_count, incl_alloc, adj, diff)
                };

                let rules: &[(&str, &[&str], &[&str])] = &[
                    ("A: all",                    &[],                                                          &[]),
                    ("B: -hiberfil",              &[],                                                          &["hiberfil.sys"]),
                    ("C: -system",                &["system"],                                                  &[]),
                    ("D: -installer",             &["installer"],                                               &[]),
                    ("E: -ai_tool",               &["ai_tool"],                                                 &[]),
                    ("F: -database",              &["database"],                                                &[]),
                    ("G: -other",                 &["other"],                                                   &[]),
                    ("H: -sys-inst",              &["system","installer"],                                      &[]),
                    ("I: -sys-inst-ai",           &["system","installer","ai_tool"],                           &[]),
                    ("J: -sys-inst-ai-db",        &["system","installer","ai_tool","database"],                &[]),
                    ("K: -sys-inst-ai-db-oth",    &["system","installer","ai_tool","database","other"],        &[]),
                ];

                println!();
                println!("=== candidate exclusion rule dry-runs ===");
                println!("  adjusted = current_alloc ({} GB) + included_candidate_alloc", total_alloc_iu / 1_073_741_824);
                println!("  Windows Used = {} GB ({} bytes)", windows_used / 1_073_741_824, windows_used);
                println!();
                println!("  {:<28} {:>9} {:>9} {:>9} {:>9} {:>8} {:>9}",
                    "rule", "excl_cnt", "excl_GB", "incl_cnt", "incl_GB", "adj_GB", "diff_GB");
                println!("  {}", "-".repeat(86));

                let mut best_rule:     &str = "";
                let mut best_diff_abs: i64  = i64::MAX;

                for (rule_name, excl_cats, excl_names) in rules {
                    let (excl_cnt, excl_alloc, incl_cnt, incl_alloc, adj, diff) =
                        run_rule(excl_cats, excl_names);
                    println!("  {:<28} {:>9} {:>9} {:>9} {:>9} {:>8} {:>+9}",
                        rule_name,
                        excl_cnt,
                        excl_alloc / 1_073_741_824,
                        incl_cnt,
                        incl_alloc / 1_073_741_824,
                        adj / 1_073_741_824,
                        diff / 1_073_741_824_i64);
                    let d_abs = diff.abs();
                    if d_abs < best_diff_abs {
                        best_diff_abs = d_abs;
                        best_rule     = rule_name;
                    }
                }

                println!();
                println!("  best rule (closest to Windows Used): {}  (|diff| ~{} GB)",
                    best_rule, best_diff_abs / 1_073_741_824_i64);

                // ── flag summary ────────────────────────────────────────────
                let flag_names = ["compressed","sparse","reparse","system_attr","hidden","offline","wof","normal"];
                let mut fcnt  = [0usize; 8];
                let mut falloc = [0u64; 8];
                for (alloc, _n, _c, fa, df, wof) in &cand_details {
                    let cmp  = fa & 0x0800 != 0 || df & 0x0001 != 0;
                    let sps  = fa & 0x0200 != 0 || df & 0x8000 != 0;
                    let rps  = fa & 0x0400 != 0;
                    let sys  = fa & 0x0004 != 0;
                    let hid  = fa & 0x0002 != 0;
                    let off  = fa & 0x1000 != 0;
                    let wof_b = *wof;
                    let nrm  = !cmp && !sps && !rps && !sys && !hid && !off && !wof_b;
                    let flags_arr = [cmp, sps, rps, sys, hid, off, wof_b, nrm];
                    for (i, &f) in flags_arr.iter().enumerate() {
                        if f { fcnt[i] += 1; falloc[i] = falloc[i].saturating_add(*alloc); }
                    }
                }
                println!();
                println!("=== candidate attribute flag diagnostics ===");
                println!("--- flag summary (all {} candidates) ---", cand_details.len());
                println!("  {:<14} {:>8} {:>10}", "flag", "count", "alloc_GB");
                for i in 0..8 {
                    println!("  {:<14} {:>8} {:>10}", flag_names[i], fcnt[i], falloc[i] / 1_073_741_824);
                }

                // ── category × flags cross-table ──────────────────────────
                let cat_list = ["system","virtual_disk","installer","database","archive","ai_tool","other"];
                let mut cat_flag_cnt:   std::collections::HashMap<&str, [usize; 8]> = std::collections::HashMap::new();
                let mut cat_flag_alloc: std::collections::HashMap<&str, [u64;   8]> = std::collections::HashMap::new();
                for (alloc, _n, cat, fa, df, wof) in &cand_details {
                    let cmp  = fa & 0x0800 != 0 || df & 0x0001 != 0;
                    let sps  = fa & 0x0200 != 0 || df & 0x8000 != 0;
                    let rps  = fa & 0x0400 != 0;
                    let sys  = fa & 0x0004 != 0;
                    let hid  = fa & 0x0002 != 0;
                    let off  = fa & 0x1000 != 0;
                    let wof_b = *wof;
                    let nrm  = !cmp && !sps && !rps && !sys && !hid && !off && !wof_b;
                    let flags_arr = [cmp, sps, rps, sys, hid, off, wof_b, nrm];
                    let cnt = cat_flag_cnt.entry(cat).or_insert([0usize; 8]);
                    let al  = cat_flag_alloc.entry(cat).or_insert([0u64;   8]);
                    for (i, &f) in flags_arr.iter().enumerate() {
                        if f { cnt[i] += 1; al[i] = al[i].saturating_add(*alloc); }
                    }
                }
                println!();
                println!("--- category × flags cross-table (count/alloc_GB) ---");
                print!("  {:<14}", "category");
                for n in &flag_names { print!(" {:>14}", n); }
                println!();
                for c in &cat_list {
                    let cnt = cat_flag_cnt.get(c).copied().unwrap_or([0; 8]);
                    let al  = cat_flag_alloc.get(c).copied().unwrap_or([0; 8]);
                    print!("  {:<14}", c);
                    for i in 0..8 {
                        print!(" {:>6}/{:>7}", cnt[i], al[i] / 1_073_741_824);
                    }
                    println!();
                }

                // ── flag-based dry-runs ────────────────────────────────────
                let flag_rules: &[(&str, fn(u32, u16, bool) -> bool)] = &[
                    ("all",              |_fa, _df, _wof| false),
                    ("-compressed",      |fa, df, _wof| fa & 0x0800 != 0 || df & 0x0001 != 0),
                    ("-sparse",          |fa, df, _wof| fa & 0x0200 != 0 || df & 0x8000 != 0),
                    ("-cmp+sps",         |fa, df, _wof| fa & 0x0A00 != 0 || df & 0x8001 != 0),
                    ("-reparse",         |fa, _df, _wof| fa & 0x0400 != 0),
                    ("-system_attr",     |fa, _df, _wof| fa & 0x0004 != 0),
                    ("-hidden+system",   |fa, _df, _wof| fa & 0x0006 != 0),
                    ("-wof",             |_fa, _df, wof| wof),
                    ("-cmp+sps+rps+sys", |fa, df, _wof| fa & 0x0E04 != 0 || df & 0x8001 != 0),
                    ("-non-normal",      |fa, df, wof| fa & 0x1E06 != 0 || df & 0x8001 != 0 || wof),
                ];

                let run_flag_rule = |pred: fn(u32, u16, bool) -> bool| -> (usize, u64, usize, u64, u64, i64) {
                    let mut excl_count: usize = 0;
                    let mut excl_alloc: u64   = 0;
                    let mut incl_count: usize = 0;
                    let mut incl_alloc: u64   = 0;
                    for (alloc, _n, _c, fa, df, wof) in &cand_details {
                        if pred(*fa, *df, *wof) {
                            excl_count += 1;
                            excl_alloc  = excl_alloc.saturating_add(*alloc);
                        } else {
                            incl_count += 1;
                            incl_alloc  = incl_alloc.saturating_add(*alloc);
                        }
                    }
                    let adj  = total_alloc_iu + incl_alloc;
                    let diff = windows_used as i64 - adj as i64;
                    (excl_count, excl_alloc, incl_count, incl_alloc, adj, diff)
                };

                println!();
                println!("=== flag-based dry-runs ===");
                println!("  adjusted = current_alloc ({} GB) + included_candidate_alloc", total_alloc_iu / 1_073_741_824);
                println!("  Windows Used = {} GB ({} bytes)", windows_used / 1_073_741_824, windows_used);
                println!();
                println!("  {:<24} {:>9} {:>9} {:>9} {:>9} {:>8} {:>9}",
                    "rule", "excl_cnt", "excl_GB", "incl_cnt", "incl_GB", "adj_GB", "diff_GB");
                println!("  {}", "-".repeat(82));

                let mut best_flag_rule     = "";
                let mut best_flag_diff_abs = i64::MAX;

                for (rule_name, pred) in flag_rules {
                    let (excl_cnt, excl_al, incl_cnt, incl_al, adj, diff) = run_flag_rule(*pred);
                    println!("  {:<24} {:>9} {:>9} {:>9} {:>9} {:>8} {:>+9}",
                        rule_name,
                        excl_cnt,
                        excl_al / 1_073_741_824,
                        incl_cnt,
                        incl_al / 1_073_741_824,
                        adj / 1_073_741_824,
                        diff / 1_073_741_824_i64);
                    let d_abs = diff.abs();
                    if d_abs < best_flag_diff_abs {
                        best_flag_diff_abs = d_abs;
                        best_flag_rule     = rule_name;
                    }
                }
                println!();
                println!("  best flag rule (closest to Windows Used): {}  (|diff| ~{} GB)",
                    best_flag_rule, best_flag_diff_abs / 1_073_741_824_i64);

                // ── normal candidates only top-100 ─────────────────────────
                println!();
                println!("=== normal candidates only ===");
                println!("  filter: cmp=0 sps=0 rps=0 sys_attr=0 hid=0 wof=0");

                let mut normal_cands: Vec<&BaseGroup> = candidates.iter()
                    .copied()
                    .filter(|g| {
                        let fa = base_entry_lookup.get(&g.base_record_number)
                            .map(|e| e.file_attrs).unwrap_or(0);
                        let df = g.data_flags;
                        let cmp = fa & 0x0800 != 0 || df & 0x0001 != 0;
                        let sps = fa & 0x0200 != 0 || df & 0x8000 != 0;
                        let rps = fa & 0x0400 != 0;
                        let sys = fa & 0x0004 != 0;
                        let hid = fa & 0x0002 != 0;
                        let wof_b = g.wof_alloc > 0;
                        !cmp && !sps && !rps && !sys && !hid && !wof_b
                    })
                    .collect();
                normal_cands.sort_unstable_by(|a, b| b.unnamed_alloc.cmp(&a.unnamed_alloc));

                let normal_total: u64 = normal_cands.iter().map(|g| g.unnamed_alloc).sum();
                let normal_adj   = total_alloc_iu + normal_total;
                let normal_diff  = windows_used as i64 - normal_adj as i64;

                println!("  count:       {:>8}", normal_cands.len());
                println!("  total alloc: {:>8} GB ({} bytes)", normal_total / 1_073_741_824, normal_total);
                println!("  adjusted (current + normal_alloc): {:>8} GB  ({} bytes)", normal_adj / 1_073_741_824, normal_adj);
                println!("  diff from Windows Used:            {:>+8} GB", normal_diff / 1_073_741_824_i64);
                println!();

                // category summary for normal candidates
                let mut ncat_cnt:   std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
                let mut ncat_alloc: std::collections::HashMap<&str, u64>   = std::collections::HashMap::new();
                for g in &normal_cands {
                    let from_e = base_entry_lookup.get(&g.base_record_number).map(|e| e.name.as_str()).unwrap_or("");
                    let bname = if !from_e.is_empty() { from_e }
                                else if !g.file_name.is_empty() { g.file_name.as_str() }
                                else { "" };
                    let cat = classify(bname);
                    *ncat_cnt.entry(cat).or_insert(0) += 1;
                    *ncat_alloc.entry(cat).or_insert(0) =
                        ncat_alloc.get(cat).copied().unwrap_or(0).saturating_add(g.unnamed_alloc);
                }
                println!("--- normal candidates category summary ---");
                for c in &["system","virtual_disk","installer","database","archive","ai_tool","other"] {
                    println!("  {:>12}: {:>5} files  {:>6} GB ({} MB)",
                        c,
                        ncat_cnt.get(c).copied().unwrap_or(0),
                        ncat_alloc.get(c).copied().unwrap_or(0) / 1_073_741_824,
                        ncat_alloc.get(c).copied().unwrap_or(0) / 1_048_576);
                }

                println!();
                println!("--- normal candidates top-100 detail ---");
                for (rank, g) in normal_cands.iter().take(100).enumerate() {
                    let base_entry = base_entry_lookup.get(&g.base_record_number);
                    let parent_frn = base_entry.map(|e| e.parent_frn).unwrap_or(0);
                    let from_e = base_entry.map(|e| e.name.as_str()).unwrap_or("");
                    let bname = if !from_e.is_empty() { from_e }
                                else if !g.file_name.is_empty() { g.file_name.as_str() }
                                else { "(no name)" };
                    let cat     = classify(bname);
                    let ext_str = bname.rfind('.').map(|i| &bname[i..]).unwrap_or("");
                    println!("{:>4}. alloc={:>7}MB real={:>7}MB rec={:<8} pfn={:<8} ext_cnt={} cat={} fext=[{}] name={}",
                        rank + 1,
                        g.unnamed_alloc / 1_048_576,
                        g.unnamed_real  / 1_048_576,
                        g.base_record_number,
                        parent_frn,
                        g.ext_count,
                        cat,
                        ext_str,
                        bname);
                }

                // ── final size policy dry-run ──────────────────────────────
                println!();
                println!("=== final size policy dry-run ===");
                println!("  policy: base_alloc>0 -> base; base_alloc==0 && normal ext unnamed -> ext");
                println!("  excluded: named streams / $J / WofCompressedData / cmp / sps / rps / sys+hid");

                let mut cmp_cand_alloc:    u64 = 0;
                let mut sps_cand_alloc:    u64 = 0;
                let mut rps_cand_alloc:    u64 = 0;
                let mut syshid_cand_alloc: u64 = 0;
                let mut wof_cand_alloc:    u64 = 0;
                for (alloc, _n, _c, fa, df, wof) in &cand_details {
                    if fa & 0x0800 != 0 || df & 0x0001 != 0 { cmp_cand_alloc    = cmp_cand_alloc.saturating_add(*alloc);    }
                    if fa & 0x0200 != 0 || df & 0x8000 != 0 { sps_cand_alloc    = sps_cand_alloc.saturating_add(*alloc);    }
                    if fa & 0x0400 != 0                      { rps_cand_alloc    = rps_cand_alloc.saturating_add(*alloc);    }
                    if fa & 0x0006 != 0                      { syshid_cand_alloc = syshid_cand_alloc.saturating_add(*alloc); }
                    if *wof                                  { wof_cand_alloc    = wof_cand_alloc.saturating_add(*alloc);    }
                }

                let final_adj  = total_alloc_iu + normal_total;
                let final_diff = windows_used as i64 - final_adj as i64;

                println!();
                println!("  -- adopted --");
                println!("  current allocated total (base records):   {:>6} GB  ({} bytes)", total_alloc_iu / 1_073_741_824, total_alloc_iu);
                println!("  normal ext unnamed candidate alloc:        {:>6} GB  ({} candidates, {} bytes)", normal_total / 1_073_741_824, normal_cands.len(), normal_total);
                println!("  final adjusted total:                      {:>6} GB  ({} bytes)", final_adj / 1_073_741_824, final_adj);
                println!("  Windows Used (176.28 GB):                  {:>6} GB  ({} bytes)", windows_used / 1_073_741_824, windows_used);
                println!("  diff (Windows - final):                    {:>+6} GB", final_diff / 1_073_741_824_i64);
                println!();
                println!("  -- excluded / separated --");
                println!("  named stream total (all ext):              {:>6} GB  (ADS, excluded)", ext_named_alloc_total / 1_073_741_824);
                println!("  $J stream total:                           {:>6} GB  (NTFS journal, excluded)", j_alloc / 1_073_741_824);
                println!("  WofCompressedData total (all ext):         {:>6} GB  (WOF, separated)", wof_alloc / 1_073_741_824);
                println!("  compressed candidates (cmp=1):             {:>6} GB  (not in normal)", cmp_cand_alloc / 1_073_741_824);
                println!("  sparse candidates (sps=1):                 {:>6} GB  (not in normal)", sps_cand_alloc / 1_073_741_824);
                println!("  reparse candidates (rps=1):                {:>6} GB  (not in normal)", rps_cand_alloc / 1_073_741_824);
                println!("  system/hidden candidates:                  {:>6} GB  (not in normal)", syshid_cand_alloc / 1_073_741_824);
                println!("  wof candidates (wof in unnamed):           {:>6} GB  (not in normal)", wof_cand_alloc / 1_073_741_824);
                println!();
                println!("  -- policy note --");
                println!("  * Windows Used との完全一致は目的外");
                println!("  * file-level deletion decision を優先");
                println!("  * normal extension unnamed $DATA は通常ファイルサイズ候補");
                println!("  * special/named streams は別分類");
            }
        }

        // ── final size calculation ──────────────────────────────────────────
        // policy:
        //   base_alloc > 0  → use base alloc_size
        //   base_alloc == 0 AND normal ext unnamed $DATA → use ext unnamed_alloc
        //   otherwise       → 0 (excluded / not recoverable)
        {
            let windows_used: u64 = (176.28f64 * 1_073_741_824f64) as u64;

            // reverse lookup: base_record_number (FRN) → &BaseGroup
            let base_idx_to_group: std::collections::HashMap<u64, &BaseGroup> =
                base_groups.values().map(|g| (g.base_record_number, g)).collect();

            let mut final_ext_adopted:     u64   = 0;
            let mut final_ext_adopted_cnt: usize = 0;
            let mut excl_cmp:      u64 = 0;
            let mut excl_sps:      u64 = 0;
            let mut excl_rps:      u64 = 0;
            let mut excl_syshid:   u64 = 0;
            let mut excl_wof_cand: u64 = 0;

            let mut final_entries: Vec<(&ParsedEntry, u64)> = Vec::new();

            for e in entries.iter().filter(|e| e.is_in_use) {
                let final_alloc;
                if e.alloc_size > 0 {
                    final_alloc = e.alloc_size;
                } else if let Some(g) = base_idx_to_group.get(&(e.record_idx as u64)) {
                    if g.unnamed_alloc > 0 {
                        let fa    = e.file_attrs;
                        let df    = g.data_flags;
                        let wof_b = g.wof_alloc > 0;
                        let cmp   = fa & 0x0800 != 0 || df & 0x0001 != 0;
                        let sps   = fa & 0x0200 != 0 || df & 0x8000 != 0;
                        let rps   = fa & 0x0400 != 0;
                        let sys   = fa & 0x0004 != 0;
                        let hid   = fa & 0x0002 != 0;
                        if cmp         { excl_cmp     = excl_cmp.saturating_add(g.unnamed_alloc);     }
                        if sps         { excl_sps     = excl_sps.saturating_add(g.unnamed_alloc);     }
                        if rps         { excl_rps     = excl_rps.saturating_add(g.unnamed_alloc);     }
                        if fa & 0x0006 != 0 { excl_syshid = excl_syshid.saturating_add(g.unnamed_alloc); }
                        if wof_b       { excl_wof_cand = excl_wof_cand.saturating_add(g.unnamed_alloc); }
                        if !cmp && !sps && !rps && !sys && !hid && !wof_b {
                            final_alloc = g.unnamed_alloc;
                            final_ext_adopted = final_ext_adopted.saturating_add(g.unnamed_alloc);
                            final_ext_adopted_cnt += 1;
                        } else {
                            final_alloc = 0;
                        }
                    } else {
                        final_alloc = 0;
                    }
                } else {
                    final_alloc = 0;
                }
                final_entries.push((e, final_alloc));
            }

            let final_total = total_alloc_iu.saturating_add(final_ext_adopted);
            let final_diff  = windows_used as i64 - final_total as i64;

            let mut top20_final: Vec<(&ParsedEntry, u64)> = final_entries.iter()
                .filter(|(_, fa)| *fa > 0)
                .copied()
                .collect();
            top20_final.sort_unstable_by(|a, b| b.1.cmp(&a.1));
            top20_final.truncate(20);

            println!();
            println!("=== final size calculation ===");
            println!("  policy: base_alloc>0 -> base; base_alloc==0 && normal ext unnamed -> ext");
            println!();
            println!("  base allocated total (current_alloc_iu): {:>6} GB  ({} bytes)", total_alloc_iu / 1_073_741_824, total_alloc_iu);
            println!("  adopted normal ext unnamed total:         {:>6} GB  ({} files)", final_ext_adopted / 1_073_741_824, final_ext_adopted_cnt);
            println!("  final allocated total:                    {:>6} GB  ({} bytes)", final_total / 1_073_741_824, final_total);
            println!("  Windows Used (176.28 GB):                 {:>6} GB  ({} bytes)", windows_used / 1_073_741_824, windows_used);
            println!("  diff (Windows - final):                   {:>+6} GB", final_diff / 1_073_741_824_i64);
            println!();
            println!("  -- excluded / separated --");
            println!("  named stream total (all ext):             {:>6} GB  (ADS, excluded)", ext_named_alloc_total / 1_073_741_824);
            println!("  $J stream total:                          {:>6} GB  (NTFS journal, excluded)", j_alloc / 1_073_741_824);
            println!("  WofCompressedData total (all ext):        {:>6} GB  (WOF, separated)", wof_alloc / 1_073_741_824);
            println!("  compressed candidates:                    {:>6} GB  (not adopted)", excl_cmp     / 1_073_741_824);
            println!("  sparse candidates:                        {:>6} GB  (not adopted)", excl_sps     / 1_073_741_824);
            println!("  reparse candidates:                       {:>6} GB  (not adopted)", excl_rps     / 1_073_741_824);
            println!("  system/hidden candidates:                 {:>6} GB  (not adopted)", excl_syshid  / 1_073_741_824);
            println!("  wof candidates:                           {:>6} GB  (not adopted)", excl_wof_cand / 1_073_741_824);
            println!();
            println!("--- final top 20 largest files (by final allocated size) ---");
            for (rank, (e, fa)) in top20_final.iter().enumerate() {
                println!("{:>3}. alloc={:>8}MB  {}  (rec={}, pfn={})",
                    rank + 1, fa / 1_048_576, e.name, e.record_idx, e.parent_frn);
            }
        }
    }

    Ok(())
}

pub fn probe7(drive: char, top_n: usize) -> Result<()> {
    use rayon::prelude::*;
    use std::collections::HashMap;
    use windows::Win32::Storage::FileSystem::{ReadFile, SetFilePointerEx, FILE_BEGIN};

    let info = get_mft_info(drive)?;

    println!("probe7: MFT tree aggregation");
    println!("$MFT: {} MB, {} extents", info.mft_size / 1_048_576, info.extents.len());

    let total_start = std::time::Instant::now();
    let mut mft_buf = vec![0u8; info.mft_size as usize];

    let io_start = std::time::Instant::now();
    for (start_vcn, lcn, length) in &info.extents {
        let disk_offset = lcn  * info.bytes_per_cluster;
        let dst_start   = start_vcn * info.bytes_per_cluster;
        let read_size   = length * info.bytes_per_cluster;
        let dst_end     = dst_start + read_size;
        unsafe {
            SetFilePointerEx(info.handle, disk_offset as i64, None, FILE_BEGIN)
        }.context("SetFilePointerEx失敗")?;
        let mut bytes_read: u32 = 0;
        unsafe {
            ReadFile(
                info.handle,
                Some(&mut mft_buf[dst_start as usize..dst_end as usize]),
                Some(&mut bytes_read),
                None,
            )
        }.context("ReadFile失敗")?;
    }
    let io_elapsed = io_start.elapsed();
    unsafe { windows::Win32::Foundation::CloseHandle(info.handle).ok(); }

    let record_size   = info.bytes_per_record as usize;
    let total_records = info.mft_size as usize / record_size;

    struct FlatEntry {
        record_idx: usize,
        name:       String,
        parent_frn: u64,
        alloc_size: u64,
        is_in_use:  bool,
        is_dir:     bool,
        file_attrs: u32,
    }
    struct ExtEntry7 {
        base_record:   u64,
        unnamed_alloc: u64,
        data_flags:    u16,
        wof_alloc:     u64,
    }

    let parse_start = std::time::Instant::now();

    let raw_parsed: Vec<(Option<FlatEntry>, Option<ExtEntry7>)> = mft_buf
        .par_chunks_exact(record_size)
        .enumerate()
        .filter_map(|(i, raw)| {
            let record = apply_fixup(raw)?;
            if record.len() < 4 || &record[0..4] != b"FILE" { return None; }
            if record.len() < 24 { return None; }

            let flags     = u16::from_le_bytes([record[22], record[23]]);
            let is_in_use = flags & 0x01 != 0;
            let is_dir    = flags & 0x02 != 0;

            let base_record = if record.len() >= 40 {
                u64::from_le_bytes([record[32], record[33], record[34], record[35],
                                    record[36], record[37], record[38], record[39]])
            } else { 0 };
            let is_extension = base_record != 0;

            let attr_start = u16::from_le_bytes([record[20], record[21]]) as usize;
            let mut pos              = attr_start;
            let mut name             = String::new();
            let mut parent_frn: u64  = 0;
            let mut best_ns_prio: u8 = 255;
            let mut fn_alloc: u64    = 0;
            let mut alloc_data: Option<u64> = None;
            let mut found_data       = false;
            let mut file_attrs: u32  = 0;
            let mut ext_unnamed_alloc: u64 = 0;
            let mut ext_data_flags:    u16 = 0;
            let mut ext_wof_alloc:     u64 = 0;
            let mut ext_has_data           = false;

            loop {
                if pos + 8 > record.len() { break; }
                let attr_type = u32::from_le_bytes([record[pos], record[pos+1], record[pos+2], record[pos+3]]);
                let attr_len  = u32::from_le_bytes([record[pos+4], record[pos+5], record[pos+6], record[pos+7]]) as usize;
                if attr_type == 0xFFFF_FFFF { break; }
                if attr_len == 0 || pos + attr_len > record.len() { break; }

                let non_resident    = record[pos + 8];
                let stream_name_len = record[pos + 9] as usize;

                match attr_type {
                    0x10 if non_resident == 0 => {
                        if pos + 22 <= record.len() {
                            let c = pos + u16::from_le_bytes([record[pos+20], record[pos+21]]) as usize;
                            if c + 0x24 <= record.len() {
                                file_attrs = u32::from_le_bytes([record[c+0x20], record[c+0x21], record[c+0x22], record[c+0x23]]);
                            }
                        }
                    }
                    0x30 if non_resident == 0 => {
                        if pos + 22 > record.len() { pos += attr_len; continue; }
                        let c = pos + u16::from_le_bytes([record[pos+20], record[pos+21]]) as usize;
                        if c + 0x42 > record.len() { pos += attr_len; continue; }
                        let ns = record[c + 0x41];
                        let ns_prio: u8 = match ns { 1 => 0, 3 => 1, 0 => 2, 2 => 3, _ => 4 };
                        if ns_prio < best_ns_prio {
                            best_ns_prio = ns_prio;
                            if c + 8 <= record.len() {
                                let pr = u64::from_le_bytes([record[c], record[c+1], record[c+2], record[c+3],
                                                              record[c+4], record[c+5], record[c+6], record[c+7]]);
                                parent_frn = pr & 0x0000_FFFF_FFFF_FFFF;
                            }
                            if c + 0x38 <= record.len() {
                                // RealSize from $FILE_NAME (probe6 fn_size policy)
                                fn_alloc = u64::from_le_bytes([record[c+0x30], record[c+0x31], record[c+0x32], record[c+0x33],
                                                                record[c+0x34], record[c+0x35], record[c+0x36], record[c+0x37]]);
                            }
                            let nc = record[c + 0x40] as usize;
                            let ns_start = c + 0x42;
                            let ns_end   = ns_start + nc * 2;
                            if ns_end <= record.len() {
                                let wide: Vec<u16> = record[ns_start..ns_end]
                                    .chunks_exact(2)
                                    .map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
                                name = String::from_utf16_lossy(&wide).into();
                            }
                        }
                    }
                    0x80 => {
                        if stream_name_len == 0 && !found_data {
                            if non_resident == 1 && pos + 48 <= record.len() {
                                alloc_data = Some(u64::from_le_bytes([
                                    record[pos+40], record[pos+41], record[pos+42], record[pos+43],
                                    record[pos+44], record[pos+45], record[pos+46], record[pos+47]]));
                                found_data = true;
                            } else if non_resident == 0 && pos + 20 <= record.len() {
                                let cl = u32::from_le_bytes([record[pos+16], record[pos+17], record[pos+18], record[pos+19]]) as u64;
                                alloc_data = Some(cl);
                                found_data = true;
                            }
                        }
                        if is_extension && is_in_use {
                            let alloc = if non_resident == 1 && pos + 48 <= record.len() {
                                u64::from_le_bytes([record[pos+40], record[pos+41], record[pos+42], record[pos+43],
                                                    record[pos+44], record[pos+45], record[pos+46], record[pos+47]])
                            } else if non_resident == 0 && pos + 20 <= record.len() {
                                u32::from_le_bytes([record[pos+16], record[pos+17], record[pos+18], record[pos+19]]) as u64
                            } else { 0 };

                            if stream_name_len == 0 {
                                ext_has_data = true;
                                ext_unnamed_alloc = ext_unnamed_alloc.saturating_add(alloc);
                                if pos + 14 <= record.len() {
                                    ext_data_flags |= u16::from_le_bytes([record[pos+12], record[pos+13]]);
                                }
                            } else {
                                // only WofCompressedData needed for normal-detection flag
                                let name_off = u16::from_le_bytes([record[pos+10], record[pos+11]]) as usize;
                                let sn_start = pos + name_off;
                                let sn_end   = sn_start + stream_name_len * 2;
                                if sn_end <= pos + attr_len && sn_end <= record.len() {
                                    let wide: Vec<u16> = record[sn_start..sn_end]
                                        .chunks_exact(2)
                                        .map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
                                    if String::from_utf16_lossy(&wide) == "WofCompressedData" {
                                        ext_wof_alloc = ext_wof_alloc.saturating_add(alloc);
                                        ext_has_data = true;
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
                pos += attr_len;
            }

            let ext_entry = if is_extension && is_in_use && ext_has_data {
                Some(ExtEntry7 {
                    base_record:   base_record & 0x0000_FFFF_FFFF_FFFF,
                    unnamed_alloc: ext_unnamed_alloc,
                    data_flags:    ext_data_flags,
                    wof_alloc:     ext_wof_alloc,
                })
            } else { None };

            if name.is_empty() { return Some((None, ext_entry)); }

            let alloc_size = alloc_data.unwrap_or(fn_alloc);

            Some((Some(FlatEntry { record_idx: i, name, parent_frn, alloc_size, is_in_use, is_dir, file_attrs }), ext_entry))
        })
        .collect();

    let (flat_entries, ext_entries): (Vec<_>, Vec<_>) = raw_parsed
        .into_iter()
        .fold((Vec::new(), Vec::new()), |mut acc, (fe, ee)| {
            if let Some(e) = fe { acc.0.push(e); }
            if let Some(e) = ee { acc.1.push(e); }
            acc
        });

    let parse_elapsed = parse_start.elapsed();

    // ── BaseGroup aggregation (same final_alloc policy as probe6) ─────────
    let tree_start = std::time::Instant::now();

    struct BaseGroup7 {
        unnamed_alloc: u64,
        data_flags:    u16,
        wof_alloc:     u64,
    }

    let mut base_groups: HashMap<u64, BaseGroup7> = HashMap::new();
    for e in &ext_entries {
        let g = base_groups.entry(e.base_record).or_insert(BaseGroup7 {
            unnamed_alloc: 0,
            data_flags:    0,
            wof_alloc:     0,
        });
        g.unnamed_alloc = g.unnamed_alloc.saturating_add(e.unnamed_alloc);
        g.data_flags   |= e.data_flags;
        g.wof_alloc     = g.wof_alloc.saturating_add(e.wof_alloc);
    }

    let base_idx_to_group: HashMap<u64, &BaseGroup7> =
        base_groups.iter().map(|(&k, v)| (k, v)).collect();

    // ── Arena tree build ──────────────────────────────────────────────────
    struct TreeNode {
        frn:          u64,
        parent_frn:   u64,
        name:         String,
        is_dir:       bool,
        final_alloc:  u64,
        subtree_size: u64,
        children:     Vec<usize>,
        is_orphan:    bool,
    }

    let mut arena: Vec<TreeNode> = Vec::with_capacity(flat_entries.len());
    let mut frn_to_idx: HashMap<u64, usize> = HashMap::with_capacity(flat_entries.len());

    for e in flat_entries.iter().filter(|e| e.is_in_use) {
        let frn = e.record_idx as u64;
        let final_alloc = if e.alloc_size > 0 {
            e.alloc_size
        } else if let Some(g) = base_idx_to_group.get(&frn) {
            if g.unnamed_alloc > 0 {
                let fa  = e.file_attrs;
                let df  = g.data_flags;
                let wof = g.wof_alloc > 0;
                let cmp = fa & 0x0800 != 0 || df & 0x0001 != 0;
                let sps = fa & 0x0200 != 0 || df & 0x8000 != 0;
                let rps = fa & 0x0400 != 0;
                let sys = fa & 0x0004 != 0;
                let hid = fa & 0x0002 != 0;
                if !cmp && !sps && !rps && !sys && !hid && !wof { g.unnamed_alloc } else { 0 }
            } else { 0 }
        } else { 0 };

        let idx = arena.len();
        frn_to_idx.insert(frn, idx);
        arena.push(TreeNode {
            frn,
            parent_frn:   e.parent_frn,
            name:         e.name.clone(),
            is_dir:       e.is_dir,
            final_alloc,
            subtree_size: final_alloc,
            children:     Vec::new(),
            is_orphan:    false,
        });
    }

    // Two-pass parent→child linking to avoid borrow conflicts
    let mut child_parent: Vec<(usize, usize)> = Vec::new();
    let mut orphan_flags: Vec<bool>            = vec![false; arena.len()];
    let mut root_indices: Vec<usize>           = Vec::new();
    let mut orphan_count: usize                = 0;

    for i in 0..arena.len() {
        let (frn, pfn) = (arena[i].frn, arena[i].parent_frn);
        if pfn == frn {
            root_indices.push(i);
        } else if let Some(&pi) = frn_to_idx.get(&pfn) {
            child_parent.push((i, pi));
        } else {
            orphan_flags[i] = true;
            orphan_count += 1;
            root_indices.push(i);
        }
    }
    for i in 0..arena.len() {
        if orphan_flags[i] { arena[i].is_orphan = true; }
    }
    for (ci, pi) in child_parent {
        arena[pi].children.push(ci);
    }

    let tree_build_elapsed = tree_start.elapsed();

    // ── Subtree aggregation (iterative post-order DFS) ────────────────────
    let agg_start = std::time::Instant::now();

    let mut order: Vec<usize> = Vec::with_capacity(arena.len());
    {
        let mut stack: Vec<(usize, bool)> = Vec::new();
        for &r in &root_indices { stack.push((r, false)); }
        while let Some((idx, expanded)) = stack.pop() {
            if expanded {
                order.push(idx);
            } else {
                stack.push((idx, true));
                for &child in arena[idx].children.iter().rev() {
                    stack.push((child, false));
                }
            }
        }
    }

    for &idx in &order {
        let (subtree, pfn, frn) = {
            let n = &arena[idx];
            (n.subtree_size, n.parent_frn, n.frn)
        };
        if pfn != frn {
            if let Some(&pi) = frn_to_idx.get(&pfn) {
                arena[pi].subtree_size = arena[pi].subtree_size.saturating_add(subtree);
            }
        }
    }

    let agg_elapsed   = agg_start.elapsed();
    let total_elapsed = total_start.elapsed();

    // ── Statistics ────────────────────────────────────────────────────────
    let total_file_count: usize = arena.iter().filter(|n| !n.is_dir).count();
    let total_dir_count:  usize = arena.iter().filter(|n|  n.is_dir).count();
    let total_final_alloc: u64  = arena.iter().filter(|n| !n.is_dir).map(|n| n.final_alloc).sum();
    let root5_subtree: u64      = frn_to_idx.get(&5).map(|&i| arena[i].subtree_size).unwrap_or(0);

    // ── Top-30 dirs by subtree_size ────────────────────────────────────────
    let mut top_dir_idx: Vec<usize> = arena.iter().enumerate()
        .filter(|(_, n)| n.is_dir && n.subtree_size > 0)
        .map(|(i, _)| i)
        .collect();
    top_dir_idx.sort_unstable_by(|&a, &b| arena[b].subtree_size.cmp(&arena[a].subtree_size));
    top_dir_idx.truncate(top_n);

    // ── Top-N files by final_alloc ────────────────────────────────────────
    let mut top_file_idx: Vec<usize> = arena.iter().enumerate()
        .filter(|(_, n)| !n.is_dir && n.final_alloc > 0)
        .map(|(i, _)| i)
        .collect();
    top_file_idx.sort_unstable_by(|&a, &b| arena[b].final_alloc.cmp(&arena[a].final_alloc));
    top_file_idx.truncate(top_n);

    // ── Path reconstruction (depth-limited, no HashSet) ───────────────────
    let reconstruct_path = |start_idx: usize| -> String {
        let mut parts: Vec<String> = Vec::new();
        let mut cur = start_idx;
        for _ in 0..64 {
            let (name_opt, pfn, frn, is_orphan) = {
                let n = &arena[cur];
                (
                    if n.frn != 5 { Some(n.name.clone()) } else { None },
                    n.parent_frn,
                    n.frn,
                    n.is_orphan,
                )
            };
            if let Some(nm) = name_opt { parts.push(nm); }
            if pfn == frn {
                let mut path = format!("{}:", drive);
                for p in parts.iter().rev() { path.push('\\'); path.push_str(p); }
                return path;
            }
            if is_orphan {
                let mut path = String::from("(orphan)");
                for p in parts.iter().rev() { path.push('\\'); path.push_str(p); }
                return path;
            }
            match frn_to_idx.get(&pfn) {
                Some(&pi) => { cur = pi; }
                None => {
                    let mut path = String::from("(orphan)");
                    for p in parts.iter().rev() { path.push('\\'); path.push_str(p); }
                    return path;
                }
            }
        }
        let mut path = String::from("(deep)");
        for p in parts.iter().rev() { path.push('\\'); path.push_str(p); }
        path
    };

    // ── Output ────────────────────────────────────────────────────────────
    println!();
    println!("=== probe7: MFT tree aggregation ===");
    println!("  total records:        {:>10}", total_records);
    println!("  in-use entries:       {:>10}", arena.len());
    println!("  files:                {:>10}", total_file_count);
    println!("  directories:          {:>10}", total_dir_count);
    println!("  orphans:              {:>10}", orphan_count);
    println!("  root nodes:           {:>10}", root_indices.len());
    println!("  total final_alloc:    {:>6} GB ({} bytes)",
        total_final_alloc / 1_073_741_824, total_final_alloc);
    println!("  root(5) subtree:      {:>6} GB ({} bytes)",
        root5_subtree / 1_073_741_824, root5_subtree);
    println!();
    println!("  timing:");
    println!("    I/O:         {:.2}秒", io_elapsed.as_secs_f64());
    println!("    parse:       {:.2}秒", parse_elapsed.as_secs_f64());
    println!("    tree build:  {:.2}秒", tree_build_elapsed.as_secs_f64());
    println!("    aggregation: {:.2}秒", agg_elapsed.as_secs_f64());
    println!("    total:       {:.2}秒", total_elapsed.as_secs_f64());
    println!();
    println!("--- top {} directories by subtree_size ---", top_n);
    for (rank, &idx) in top_dir_idx.iter().enumerate() {
        let subtree_mb = arena[idx].subtree_size / 1_048_576;
        let path = reconstruct_path(idx);
        println!("{:>3}. {:>8}MB  {}", rank + 1, subtree_mb, path);
    }
    println!();
    println!("--- top {} files by final_allocated_size ---", top_n);
    for (rank, &idx) in top_file_idx.iter().enumerate() {
        let alloc_mb = arena[idx].final_alloc / 1_048_576;
        let path = reconstruct_path(idx);
        println!("{:>3}. {:>8}MB  {}", rank + 1, alloc_mb, path);
    }

    Ok(())
}

// ─── C-1: JSON output types ───────────────────────────────────────────────

// Public JSON contract used by the CLI today and by UI/Tauri callers later.
// Keep these serialized field names stable unless docs/json-output-schema.md is
// intentionally updated with the UI contract change.
#[derive(serde::Serialize)]
pub struct JsonDirEntry {
    pub path:             String,
    pub record_index:     usize,
    pub subtree_size:     u64,
    pub direct_file_size: u64,
    pub child_count:      usize,
}

#[derive(serde::Serialize)]
pub struct JsonFileEntry {
    pub path:                 String,
    pub record_index:         usize,
    pub parent_frn:           u64,
    pub final_allocated_size: u64,
}

#[derive(Clone, serde::Serialize)]
pub struct JsonTreeNode {
    pub name:                String,
    pub path:                String,
    pub record_index:        usize,
    pub parent_record_index: usize,
    pub is_directory:        bool,
    pub subtree_size:        u64,
    pub direct_file_size:    u64,
    pub child_count:         usize,
}

#[derive(serde::Serialize)]
pub struct JsonSummary {
    pub drive:                 String,
    pub total_records:         usize,
    pub in_use_entries:        usize,
    pub files:                 usize,
    pub directories:           usize,
    pub orphans:               usize,
    pub root_nodes:            usize,
    pub total_final_allocated: u64,
    pub read_time_ms:          u64,
    pub parse_time_ms:         u64,
    pub tree_build_time_ms:    u64,
    pub aggregation_time_ms:   u64,
    pub total_time_ms:         u64,
}

#[derive(serde::Serialize)]
pub struct JsonTreeOutput {
    pub summary:         JsonSummary,
    pub top_directories: Vec<JsonDirEntry>,
    pub top_files:       Vec<JsonFileEntry>,
    pub root_children:   Vec<JsonTreeNode>,
}

// Richer model returned to callers (Tauri layer) that need lazy children
// lookups. `output` is what the UI receives as the scan result; `children_map`
// indexes every directory's full child list (sorted by subtree_size desc, name
// asc) so the get_children command can answer without re-scanning the MFT.
pub struct MftTreeModel {
    pub output:       JsonTreeOutput,
    pub children_map: std::collections::HashMap<u64, Vec<JsonTreeNode>>,
}

// Core API boundary:
// - builds structured MFT tree data and returns it to the caller
// - never writes JSON or human output to stdout
// - may write progress/diagnostics to stderr
// - returns anyhow::Result so CLI, Tauri, or future library layers can decide
//   how to present errors
pub fn build_mft_tree_model(drive: char, top_n: usize) -> Result<MftTreeModel> {
    use rayon::prelude::*;
    use std::collections::HashMap;
    use windows::Win32::Storage::FileSystem::{ReadFile, SetFilePointerEx, FILE_BEGIN};

    let info = get_mft_info(drive)?;
    eprintln!("mft_tree_compute: drive={}  $MFT {} MB  {} extents",
        drive, info.mft_size / 1_048_576, info.extents.len());

    let total_start = std::time::Instant::now();
    let mut mft_buf = vec![0u8; info.mft_size as usize];

    let io_start = std::time::Instant::now();
    for (start_vcn, lcn, length) in &info.extents {
        let disk_offset = lcn  * info.bytes_per_cluster;
        let dst_start   = start_vcn * info.bytes_per_cluster;
        let read_size   = length * info.bytes_per_cluster;
        let dst_end     = dst_start + read_size;
        unsafe {
            SetFilePointerEx(info.handle, disk_offset as i64, None, FILE_BEGIN)
        }.context("SetFilePointerEx失敗")?;
        let mut bytes_read: u32 = 0;
        unsafe {
            ReadFile(
                info.handle,
                Some(&mut mft_buf[dst_start as usize..dst_end as usize]),
                Some(&mut bytes_read),
                None,
            )
        }.context("ReadFile失敗")?;
    }
    let io_elapsed = io_start.elapsed();
    unsafe { windows::Win32::Foundation::CloseHandle(info.handle).ok(); }

    let record_size   = info.bytes_per_record as usize;
    let total_records = info.mft_size as usize / record_size;

    struct FlatEntry {
        record_idx: usize,
        name:       String,
        parent_frn: u64,
        alloc_size: u64,
        is_in_use:  bool,
        is_dir:     bool,
        file_attrs: u32,
    }
    struct ExtEntryC {
        base_record:   u64,
        unnamed_alloc: u64,
        data_flags:    u16,
        wof_alloc:     u64,
    }

    let parse_start = std::time::Instant::now();

    let raw_parsed: Vec<(Option<FlatEntry>, Option<ExtEntryC>)> = mft_buf
        .par_chunks_exact(record_size)
        .enumerate()
        .filter_map(|(i, raw)| {
            let record = apply_fixup(raw)?;
            if record.len() < 4 || &record[0..4] != b"FILE" { return None; }
            if record.len() < 24 { return None; }

            let flags     = u16::from_le_bytes([record[22], record[23]]);
            let is_in_use = flags & 0x01 != 0;
            let is_dir    = flags & 0x02 != 0;

            let base_record = if record.len() >= 40 {
                u64::from_le_bytes([record[32], record[33], record[34], record[35],
                                    record[36], record[37], record[38], record[39]])
            } else { 0 };
            let is_extension = base_record != 0;

            let attr_start = u16::from_le_bytes([record[20], record[21]]) as usize;
            let mut pos              = attr_start;
            let mut name             = String::new();
            let mut parent_frn: u64  = 0;
            let mut best_ns_prio: u8 = 255;
            let mut fn_alloc: u64    = 0;
            let mut alloc_data: Option<u64> = None;
            let mut found_data       = false;
            let mut file_attrs: u32  = 0;
            let mut ext_unnamed_alloc: u64 = 0;
            let mut ext_data_flags:    u16 = 0;
            let mut ext_wof_alloc:     u64 = 0;
            let mut ext_has_data           = false;

            loop {
                if pos + 8 > record.len() { break; }
                let attr_type = u32::from_le_bytes([record[pos], record[pos+1], record[pos+2], record[pos+3]]);
                let attr_len  = u32::from_le_bytes([record[pos+4], record[pos+5], record[pos+6], record[pos+7]]) as usize;
                if attr_type == 0xFFFF_FFFF { break; }
                if attr_len == 0 || pos + attr_len > record.len() { break; }

                let non_resident    = record[pos + 8];
                let stream_name_len = record[pos + 9] as usize;

                match attr_type {
                    0x10 if non_resident == 0 => {
                        if pos + 22 <= record.len() {
                            let c = pos + u16::from_le_bytes([record[pos+20], record[pos+21]]) as usize;
                            if c + 0x24 <= record.len() {
                                file_attrs = u32::from_le_bytes([record[c+0x20], record[c+0x21], record[c+0x22], record[c+0x23]]);
                            }
                        }
                    }
                    0x30 if non_resident == 0 => {
                        if pos + 22 > record.len() { pos += attr_len; continue; }
                        let c = pos + u16::from_le_bytes([record[pos+20], record[pos+21]]) as usize;
                        if c + 0x42 > record.len() { pos += attr_len; continue; }
                        let ns = record[c + 0x41];
                        let ns_prio: u8 = match ns { 1 => 0, 3 => 1, 0 => 2, 2 => 3, _ => 4 };
                        if ns_prio < best_ns_prio {
                            best_ns_prio = ns_prio;
                            if c + 8 <= record.len() {
                                let pr = u64::from_le_bytes([record[c], record[c+1], record[c+2], record[c+3],
                                                              record[c+4], record[c+5], record[c+6], record[c+7]]);
                                parent_frn = pr & 0x0000_FFFF_FFFF_FFFF;
                            }
                            if c + 0x38 <= record.len() {
                                fn_alloc = u64::from_le_bytes([record[c+0x30], record[c+0x31], record[c+0x32], record[c+0x33],
                                                                record[c+0x34], record[c+0x35], record[c+0x36], record[c+0x37]]);
                            }
                            let nc = record[c + 0x40] as usize;
                            let ns_start = c + 0x42;
                            let ns_end   = ns_start + nc * 2;
                            if ns_end <= record.len() {
                                let wide: Vec<u16> = record[ns_start..ns_end]
                                    .chunks_exact(2)
                                    .map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
                                name = String::from_utf16_lossy(&wide).into();
                            }
                        }
                    }
                    0x80 => {
                        if stream_name_len == 0 && !found_data {
                            if non_resident == 1 && pos + 48 <= record.len() {
                                alloc_data = Some(u64::from_le_bytes([
                                    record[pos+40], record[pos+41], record[pos+42], record[pos+43],
                                    record[pos+44], record[pos+45], record[pos+46], record[pos+47]]));
                                found_data = true;
                            } else if non_resident == 0 && pos + 20 <= record.len() {
                                let cl = u32::from_le_bytes([record[pos+16], record[pos+17], record[pos+18], record[pos+19]]) as u64;
                                alloc_data = Some(cl);
                                found_data = true;
                            }
                        }
                        if is_extension && is_in_use {
                            let alloc = if non_resident == 1 && pos + 48 <= record.len() {
                                u64::from_le_bytes([record[pos+40], record[pos+41], record[pos+42], record[pos+43],
                                                    record[pos+44], record[pos+45], record[pos+46], record[pos+47]])
                            } else if non_resident == 0 && pos + 20 <= record.len() {
                                u32::from_le_bytes([record[pos+16], record[pos+17], record[pos+18], record[pos+19]]) as u64
                            } else { 0 };
                            if stream_name_len == 0 {
                                ext_has_data = true;
                                ext_unnamed_alloc = ext_unnamed_alloc.saturating_add(alloc);
                                if pos + 14 <= record.len() {
                                    ext_data_flags |= u16::from_le_bytes([record[pos+12], record[pos+13]]);
                                }
                            } else {
                                let name_off = u16::from_le_bytes([record[pos+10], record[pos+11]]) as usize;
                                let sn_start = pos + name_off;
                                let sn_end   = sn_start + stream_name_len * 2;
                                if sn_end <= pos + attr_len && sn_end <= record.len() {
                                    let wide: Vec<u16> = record[sn_start..sn_end]
                                        .chunks_exact(2)
                                        .map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
                                    if String::from_utf16_lossy(&wide) == "WofCompressedData" {
                                        ext_wof_alloc = ext_wof_alloc.saturating_add(alloc);
                                        ext_has_data = true;
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
                pos += attr_len;
            }

            let ext_entry = if is_extension && is_in_use && ext_has_data {
                Some(ExtEntryC {
                    base_record:   base_record & 0x0000_FFFF_FFFF_FFFF,
                    unnamed_alloc: ext_unnamed_alloc,
                    data_flags:    ext_data_flags,
                    wof_alloc:     ext_wof_alloc,
                })
            } else { None };

            if name.is_empty() { return Some((None, ext_entry)); }

            let alloc_size = alloc_data.unwrap_or(fn_alloc);
            Some((Some(FlatEntry { record_idx: i, name, parent_frn, alloc_size, is_in_use, is_dir, file_attrs }), ext_entry))
        })
        .collect();

    let (flat_entries, ext_entries): (Vec<_>, Vec<_>) = raw_parsed
        .into_iter()
        .fold((Vec::new(), Vec::new()), |mut acc, (fe, ee)| {
            if let Some(e) = fe { acc.0.push(e); }
            if let Some(e) = ee { acc.1.push(e); }
            acc
        });

    let parse_elapsed = parse_start.elapsed();

    let tree_start = std::time::Instant::now();

    struct BaseGroupC {
        unnamed_alloc: u64,
        data_flags:    u16,
        wof_alloc:     u64,
    }
    let mut base_groups: HashMap<u64, BaseGroupC> = HashMap::new();
    for e in &ext_entries {
        let g = base_groups.entry(e.base_record).or_insert(BaseGroupC {
            unnamed_alloc: 0, data_flags: 0, wof_alloc: 0,
        });
        g.unnamed_alloc = g.unnamed_alloc.saturating_add(e.unnamed_alloc);
        g.data_flags   |= e.data_flags;
        g.wof_alloc     = g.wof_alloc.saturating_add(e.wof_alloc);
    }
    let base_idx_to_group: HashMap<u64, &BaseGroupC> =
        base_groups.iter().map(|(&k, v)| (k, v)).collect();

    struct TreeNodeC {
        frn:              u64,
        parent_frn:       u64,
        name:             String,
        is_dir:           bool,
        final_alloc:      u64,
        subtree_size:     u64,
        direct_file_size: u64,
        children:         Vec<usize>,
        is_orphan:        bool,
    }

    let mut arena: Vec<TreeNodeC> = Vec::with_capacity(flat_entries.len());
    let mut frn_to_idx: HashMap<u64, usize> = HashMap::with_capacity(flat_entries.len());

    for e in flat_entries.iter().filter(|e| e.is_in_use) {
        let frn = e.record_idx as u64;
        let final_alloc = if e.alloc_size > 0 {
            e.alloc_size
        } else if let Some(g) = base_idx_to_group.get(&frn) {
            if g.unnamed_alloc > 0 {
                let fa  = e.file_attrs;
                let df  = g.data_flags;
                let wof = g.wof_alloc > 0;
                let cmp = fa & 0x0800 != 0 || df & 0x0001 != 0;
                let sps = fa & 0x0200 != 0 || df & 0x8000 != 0;
                let rps = fa & 0x0400 != 0;
                let sys = fa & 0x0004 != 0;
                let hid = fa & 0x0002 != 0;
                if !cmp && !sps && !rps && !sys && !hid && !wof { g.unnamed_alloc } else { 0 }
            } else { 0 }
        } else { 0 };

        let idx = arena.len();
        frn_to_idx.insert(frn, idx);
        arena.push(TreeNodeC {
            frn, parent_frn: e.parent_frn, name: e.name.clone(),
            is_dir: e.is_dir, final_alloc,
            subtree_size: final_alloc, direct_file_size: 0,
            children: Vec::new(), is_orphan: false,
        });
    }

    let mut child_parent: Vec<(usize, usize)> = Vec::new();
    let mut orphan_flags: Vec<bool>            = vec![false; arena.len()];
    let mut root_indices: Vec<usize>           = Vec::new();
    let mut orphan_count: usize                = 0;

    for i in 0..arena.len() {
        let (frn, pfn) = (arena[i].frn, arena[i].parent_frn);
        if pfn == frn {
            root_indices.push(i);
        } else if let Some(&pi) = frn_to_idx.get(&pfn) {
            child_parent.push((i, pi));
        } else {
            orphan_flags[i] = true;
            orphan_count += 1;
            root_indices.push(i);
        }
    }
    for i in 0..arena.len() {
        if orphan_flags[i] { arena[i].is_orphan = true; }
    }
    for (ci, pi) in child_parent {
        arena[pi].children.push(ci);
    }

    let tree_build_elapsed = tree_start.elapsed();

    let agg_start = std::time::Instant::now();

    let mut order: Vec<usize> = Vec::with_capacity(arena.len());
    {
        let mut stack: Vec<(usize, bool)> = Vec::new();
        for &r in &root_indices { stack.push((r, false)); }
        while let Some((idx, expanded)) = stack.pop() {
            if expanded {
                order.push(idx);
            } else {
                stack.push((idx, true));
                for &child in arena[idx].children.iter().rev() {
                    stack.push((child, false));
                }
            }
        }
    }

    for &idx in &order {
        let (subtree, pfn, frn) = {
            let n = &arena[idx];
            (n.subtree_size, n.parent_frn, n.frn)
        };
        if pfn != frn {
            if let Some(&pi) = frn_to_idx.get(&pfn) {
                arena[pi].subtree_size = arena[pi].subtree_size.saturating_add(subtree);
            }
        }
    }

    // Compute direct_file_size for each directory
    let direct_sizes: Vec<(usize, u64)> = (0..arena.len())
        .filter(|&i| arena[i].is_dir)
        .map(|i| {
            let dfs: u64 = arena[i].children.iter()
                .filter(|&&c| !arena[c].is_dir)
                .map(|&c| arena[c].final_alloc)
                .sum();
            (i, dfs)
        })
        .collect();
    for (i, dfs) in direct_sizes {
        arena[i].direct_file_size = dfs;
    }

    let agg_elapsed   = agg_start.elapsed();
    let total_elapsed = total_start.elapsed();

    // Statistics
    let total_file_count: usize = arena.iter().filter(|n| !n.is_dir).count();
    let total_dir_count:  usize = arena.iter().filter(|n|  n.is_dir).count();
    let total_final_alloc: u64  = arena.iter().filter(|n| !n.is_dir).map(|n| n.final_alloc).sum();

    // Path reconstruction (depth-limited, same policy as probe7)
    let reconstruct_path = |start_idx: usize| -> String {
        let mut parts: Vec<String> = Vec::new();
        let mut cur = start_idx;
        for _ in 0..64 {
            let (name_opt, pfn, frn, is_orphan) = {
                let n = &arena[cur];
                (if n.frn != 5 { Some(n.name.clone()) } else { None },
                 n.parent_frn, n.frn, n.is_orphan)
            };
            if let Some(nm) = name_opt { parts.push(nm); }
            if pfn == frn {
                let mut path = format!("{}:", drive);
                for p in parts.iter().rev() { path.push('\\'); path.push_str(p); }
                return path;
            }
            if is_orphan {
                let mut path = String::from("(orphan)");
                for p in parts.iter().rev() { path.push('\\'); path.push_str(p); }
                return path;
            }
            match frn_to_idx.get(&pfn) {
                Some(&pi) => { cur = pi; }
                None => {
                    let mut path = String::from("(orphan)");
                    for p in parts.iter().rev() { path.push('\\'); path.push_str(p); }
                    return path;
                }
            }
        }
        let mut path = String::from("(deep)");
        for p in parts.iter().rev() { path.push('\\'); path.push_str(p); }
        path
    };

    // Top-N dirs
    let mut top_dir_idx: Vec<usize> = arena.iter().enumerate()
        .filter(|(_, n)| n.is_dir && n.subtree_size > 0)
        .map(|(i, _)| i)
        .collect();
    top_dir_idx.sort_unstable_by(|&a, &b| arena[b].subtree_size.cmp(&arena[a].subtree_size));
    top_dir_idx.truncate(top_n);

    // Top-N files
    let mut top_file_idx: Vec<usize> = arena.iter().enumerate()
        .filter(|(_, n)| !n.is_dir && n.final_alloc > 0)
        .map(|(i, _)| i)
        .collect();
    top_file_idx.sort_unstable_by(|&a, &b| arena[b].final_alloc.cmp(&arena[a].final_alloc));
    top_file_idx.truncate(top_n);

    let top_directories: Vec<JsonDirEntry> = top_dir_idx.iter().map(|&idx| {
        JsonDirEntry {
            path:             reconstruct_path(idx),
            record_index:     arena[idx].frn as usize,
            subtree_size:     arena[idx].subtree_size,
            direct_file_size: arena[idx].direct_file_size,
            child_count:      arena[idx].children.len(),
        }
    }).collect();

    let top_files: Vec<JsonFileEntry> = top_file_idx.iter().map(|&idx| {
        JsonFileEntry {
            path:                 reconstruct_path(idx),
            record_index:         arena[idx].frn as usize,
            parent_frn:           arena[idx].parent_frn,
            final_allocated_size: arena[idx].final_alloc,
        }
    }).collect();

    let summary = JsonSummary {
        drive:                 format!("{}:", drive),
        total_records,
        in_use_entries:        arena.len(),
        files:                 total_file_count,
        directories:           total_dir_count,
        orphans:               orphan_count,
        root_nodes:            root_indices.len(),
        total_final_allocated: total_final_alloc,
        read_time_ms:          io_elapsed.as_millis() as u64,
        parse_time_ms:         parse_elapsed.as_millis() as u64,
        tree_build_time_ms:    tree_build_elapsed.as_millis() as u64,
        aggregation_time_ms:   agg_elapsed.as_millis() as u64,
        total_time_ms:         total_elapsed.as_millis() as u64,
    };

    // Build a JsonTreeNode for an arena index, using the shared path closure.
    let make_node = |ci: usize| -> JsonTreeNode {
        JsonTreeNode {
            name:                arena[ci].name.clone(),
            path:                reconstruct_path(ci),
            record_index:        arena[ci].frn as usize,
            parent_record_index: arena[ci].parent_frn as usize,
            is_directory:        arena[ci].is_dir,
            subtree_size:        arena[ci].subtree_size,
            direct_file_size:    arena[ci].direct_file_size,
            child_count:         arena[ci].children.len(),
        }
    };

    // children_map: for every directory in the arena, store all its direct
    // children (files and directories) sorted by subtree_size desc, name asc.
    // Used by the Tauri get_children command to back lazy TreeView expansion.
    let dir_count_hint = arena.iter().filter(|n| n.is_dir).count();
    let mut children_map: HashMap<u64, Vec<JsonTreeNode>> =
        HashMap::with_capacity(dir_count_hint);
    for i in 0..arena.len() {
        if !arena[i].is_dir { continue; }
        let mut children: Vec<JsonTreeNode> = arena[i].children.iter()
            .map(|&ci| make_node(ci))
            .collect();
        children.sort_unstable_by(|a, b| {
            b.subtree_size.cmp(&a.subtree_size).then_with(|| a.name.cmp(&b.name))
        });
        children_map.insert(arena[i].frn, children);
    }

    // Root children: direct children of the NTFS root directory (FRN 5).
    // Reuses the children_map entry; truncated to 200 for the embedded JSON.
    let root_children: Vec<JsonTreeNode> = children_map
        .get(&5)
        .map(|v| v.iter().take(200).cloned().collect())
        .unwrap_or_default();

    let output = JsonTreeOutput { summary, top_directories, top_files, root_children };
    Ok(MftTreeModel { output, children_map })
}

// Thin wrapper for callers (CLI) that only need the JSON-serializable output.
pub fn build_mft_tree_output(drive: char, top_n: usize) -> Result<JsonTreeOutput> {
    Ok(build_mft_tree_model(drive, top_n)?.output)
}

pub fn probe7_json(drive: char) -> Result<()> {
    let output = build_mft_tree_output(drive, 100)?;
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

// CLI layer wrappers. These functions are allowed to print to stdout; callers
// that need structured data should call build_mft_tree_output directly.
pub fn print_probe7_human(drive: char, top_n: usize) -> Result<()> {
    probe7(drive, top_n)
}

pub fn print_probe7_json(drive: char) -> Result<()> {
    probe7_json(drive)
}

pub fn print_probe7_json_top(drive: char, top_n: usize) -> Result<()> {
    let output = build_mft_tree_output(drive, top_n)?;
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

// PFx86-DIAG-1: diagnostic CLI for Program Files (x86) size discrepancy
// investigation. Targets three known-suspect subtrees and reports WOF/reparse,
// compressed/sparse, hardlink/multi-name signals plus per-file attributes.
// Size policy is unchanged — this is observation only, no correction is applied.
pub fn print_diag_pfx86(drive: char) -> Result<()> {
    use rayon::prelude::*;
    use std::collections::HashMap;
    use windows::Win32::Storage::FileSystem::{ReadFile, SetFilePointerEx, FILE_BEGIN};

    let info = get_mft_info(drive)?;
    eprintln!("diag-pfx86: drive={}  $MFT {} MB  {} extents",
        drive, info.mft_size / 1_048_576, info.extents.len());

    let mut mft_buf = vec![0u8; info.mft_size as usize];
    for (start_vcn, lcn, length) in &info.extents {
        let disk_offset = lcn * info.bytes_per_cluster;
        let dst_start = start_vcn * info.bytes_per_cluster;
        let read_size = length * info.bytes_per_cluster;
        let dst_end = dst_start + read_size;
        unsafe {
            SetFilePointerEx(info.handle, disk_offset as i64, None, FILE_BEGIN)
        }.context("SetFilePointerEx失敗")?;
        let mut bytes_read: u32 = 0;
        unsafe {
            ReadFile(
                info.handle,
                Some(&mut mft_buf[dst_start as usize..dst_end as usize]),
                Some(&mut bytes_read),
                None,
            )
        }.context("ReadFile失敗")?;
    }
    unsafe { windows::Win32::Foundation::CloseHandle(info.handle).ok(); }

    let record_size = info.bytes_per_record as usize;

    struct DiagEntry {
        record_idx: usize,
        name: String,
        parent_frn: u64,
        alloc_size: u64,
        is_in_use: bool,
        is_dir: bool,
        file_attrs: u32,
        hard_link_count: u16,
        file_name_attr_count: u16,
        reparse_tag: u32,        // 0 if not present or non-resident
        has_wof_stream: bool,    // WofCompressedData named $DATA in base record
        wof_stream_alloc: u64,
        data_flags: u16,         // OR of unnamed $DATA attr flags in base
    }
    struct ExtDiag {
        base_record: u64,
        unnamed_alloc: u64,
        data_flags: u16,
        wof_stream_alloc: u64,
        has_wof_stream: bool,
    }

    let raw_parsed: Vec<(Option<DiagEntry>, Option<ExtDiag>)> = mft_buf
        .par_chunks_exact(record_size)
        .enumerate()
        .filter_map(|(i, raw)| {
            let record = apply_fixup(raw)?;
            if record.len() < 4 || &record[0..4] != b"FILE" { return None; }
            if record.len() < 0x30 { return None; }

            let hard_link_count = u16::from_le_bytes([record[0x12], record[0x13]]);
            let flags = u16::from_le_bytes([record[22], record[23]]);
            let is_in_use = flags & 0x01 != 0;
            let is_dir = flags & 0x02 != 0;

            let base_record = u64::from_le_bytes([
                record[32], record[33], record[34], record[35],
                record[36], record[37], record[38], record[39],
            ]);
            let is_extension = base_record != 0;

            let attr_start = u16::from_le_bytes([record[20], record[21]]) as usize;
            let mut pos = attr_start;
            let mut name = String::new();
            let mut parent_frn: u64 = 0;
            let mut best_ns_prio: u8 = 255;
            let mut fn_alloc: u64 = 0;
            let mut alloc_data: Option<u64> = None;
            let mut found_data = false;
            let mut file_attrs: u32 = 0;
            let mut file_name_attr_count: u16 = 0;
            let mut reparse_tag: u32 = 0;
            let mut has_wof_stream = false;
            let mut wof_stream_alloc: u64 = 0;
            let mut data_flags: u16 = 0;

            let mut ext_unnamed_alloc: u64 = 0;
            let mut ext_data_flags: u16 = 0;
            let mut ext_wof_alloc: u64 = 0;
            let mut ext_has_wof = false;
            let mut ext_has_data = false;

            loop {
                if pos + 8 > record.len() { break; }
                let attr_type = u32::from_le_bytes([record[pos], record[pos+1], record[pos+2], record[pos+3]]);
                let attr_len  = u32::from_le_bytes([record[pos+4], record[pos+5], record[pos+6], record[pos+7]]) as usize;
                if attr_type == 0xFFFF_FFFF { break; }
                if attr_len == 0 || pos + attr_len > record.len() { break; }

                let non_resident    = record[pos + 8];
                let stream_name_len = record[pos + 9] as usize;

                match attr_type {
                    0x10 if non_resident == 0 => {
                        if pos + 22 <= record.len() {
                            let c = pos + u16::from_le_bytes([record[pos+20], record[pos+21]]) as usize;
                            if c + 0x24 <= record.len() {
                                file_attrs = u32::from_le_bytes([record[c+0x20], record[c+0x21], record[c+0x22], record[c+0x23]]);
                            }
                        }
                    }
                    0x30 if non_resident == 0 => {
                        file_name_attr_count = file_name_attr_count.saturating_add(1);
                        if pos + 22 > record.len() { pos += attr_len; continue; }
                        let c = pos + u16::from_le_bytes([record[pos+20], record[pos+21]]) as usize;
                        if c + 0x42 > record.len() { pos += attr_len; continue; }
                        let ns = record[c + 0x41];
                        let ns_prio: u8 = match ns { 1 => 0, 3 => 1, 0 => 2, 2 => 3, _ => 4 };
                        if ns_prio < best_ns_prio {
                            best_ns_prio = ns_prio;
                            if c + 8 <= record.len() {
                                let pr = u64::from_le_bytes([record[c], record[c+1], record[c+2], record[c+3],
                                                              record[c+4], record[c+5], record[c+6], record[c+7]]);
                                parent_frn = pr & 0x0000_FFFF_FFFF_FFFF;
                            }
                            if c + 0x38 <= record.len() {
                                fn_alloc = u64::from_le_bytes([record[c+0x30], record[c+0x31], record[c+0x32], record[c+0x33],
                                                                record[c+0x34], record[c+0x35], record[c+0x36], record[c+0x37]]);
                            }
                            let nc = record[c + 0x40] as usize;
                            let ns_start = c + 0x42;
                            let ns_end   = ns_start + nc * 2;
                            if ns_end <= record.len() {
                                let wide: Vec<u16> = record[ns_start..ns_end]
                                    .chunks_exact(2)
                                    .map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
                                name = String::from_utf16_lossy(&wide);
                            }
                        }
                    }
                    0x80 => {
                        let alloc = if non_resident == 1 && pos + 48 <= record.len() {
                            u64::from_le_bytes([record[pos+40], record[pos+41], record[pos+42], record[pos+43],
                                                record[pos+44], record[pos+45], record[pos+46], record[pos+47]])
                        } else if non_resident == 0 && pos + 20 <= record.len() {
                            u32::from_le_bytes([record[pos+16], record[pos+17], record[pos+18], record[pos+19]]) as u64
                        } else { 0 };
                        let af = if pos + 14 <= record.len() {
                            u16::from_le_bytes([record[pos+12], record[pos+13]])
                        } else { 0 };

                        if stream_name_len == 0 {
                            if !found_data {
                                alloc_data = Some(alloc);
                                found_data = true;
                            }
                            data_flags |= af;
                            if is_extension && is_in_use {
                                ext_has_data = true;
                                ext_unnamed_alloc = ext_unnamed_alloc.saturating_add(alloc);
                                ext_data_flags |= af;
                            }
                        } else {
                            // Named $DATA stream — check for WofCompressedData
                            let name_off = u16::from_le_bytes([record[pos+10], record[pos+11]]) as usize;
                            let sn_start = pos + name_off;
                            let sn_end   = sn_start + stream_name_len * 2;
                            if sn_end <= pos + attr_len && sn_end <= record.len() {
                                let wide: Vec<u16> = record[sn_start..sn_end]
                                    .chunks_exact(2)
                                    .map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
                                if String::from_utf16_lossy(&wide) == "WofCompressedData" {
                                    if is_extension && is_in_use {
                                        ext_has_wof = true;
                                        ext_has_data = true;
                                        ext_wof_alloc = ext_wof_alloc.saturating_add(alloc);
                                    } else {
                                        has_wof_stream = true;
                                        wof_stream_alloc = wof_stream_alloc.saturating_add(alloc);
                                    }
                                }
                            }
                        }
                    }
                    0xC0 => {
                        // $REPARSE_POINT — read reparse tag if resident
                        if non_resident == 0 && pos + 22 <= record.len() {
                            let content_size = u32::from_le_bytes([record[pos+16], record[pos+17], record[pos+18], record[pos+19]]) as usize;
                            let content_off = u16::from_le_bytes([record[pos+20], record[pos+21]]) as usize;
                            let c = pos + content_off;
                            if content_size >= 4 && c + 4 <= record.len() {
                                reparse_tag = u32::from_le_bytes([record[c], record[c+1], record[c+2], record[c+3]]);
                            }
                        }
                        // Non-resident reparse data: tag is in the data run; leave 0.
                    }
                    _ => {}
                }
                pos += attr_len;
            }

            let ext_entry = if is_extension && is_in_use && ext_has_data {
                Some(ExtDiag {
                    base_record: base_record & 0x0000_FFFF_FFFF_FFFF,
                    unnamed_alloc: ext_unnamed_alloc,
                    data_flags: ext_data_flags,
                    wof_stream_alloc: ext_wof_alloc,
                    has_wof_stream: ext_has_wof,
                })
            } else { None };

            if name.is_empty() { return Some((None, ext_entry)); }

            let alloc_size = alloc_data.unwrap_or(fn_alloc);
            Some((Some(DiagEntry {
                record_idx: i, name, parent_frn, alloc_size,
                is_in_use, is_dir, file_attrs,
                hard_link_count, file_name_attr_count, reparse_tag,
                has_wof_stream, wof_stream_alloc, data_flags,
            }), ext_entry))
        })
        .collect();

    let mut diag_entries: Vec<DiagEntry> = Vec::new();
    let mut ext_entries: Vec<ExtDiag> = Vec::new();
    for (de, ee) in raw_parsed {
        if let Some(d) = de { diag_entries.push(d); }
        if let Some(e) = ee { ext_entries.push(e); }
    }

    // Aggregate extension records per base
    struct BaseExt {
        unnamed_alloc: u64,
        data_flags: u16,
        wof_alloc: u64,
        has_wof: bool,
    }
    let mut base_groups: HashMap<u64, BaseExt> = HashMap::new();
    for e in &ext_entries {
        let g = base_groups.entry(e.base_record).or_insert(BaseExt {
            unnamed_alloc: 0, data_flags: 0, wof_alloc: 0, has_wof: false,
        });
        g.unnamed_alloc = g.unnamed_alloc.saturating_add(e.unnamed_alloc);
        g.data_flags   |= e.data_flags;
        g.wof_alloc     = g.wof_alloc.saturating_add(e.wof_stream_alloc);
        if e.has_wof_stream { g.has_wof = true; }
    }

    struct DNode {
        frn: u64,
        parent_frn: u64,
        name: String,
        is_dir: bool,
        final_alloc: u64,
        subtree_size: u64,
        direct_file_size: u64,
        children: Vec<usize>,
        file_attrs: u32,
        data_flags: u16,
        hard_link_count: u16,
        file_name_attr_count: u16,
        reparse_tag: u32,
        has_wof_stream: bool,
        wof_stream_alloc: u64,
    }

    let mut arena: Vec<DNode> = Vec::with_capacity(diag_entries.len());
    let mut frn_to_idx: HashMap<u64, usize> = HashMap::with_capacity(diag_entries.len());

    for e in diag_entries.iter().filter(|e| e.is_in_use) {
        let frn = e.record_idx as u64;
        // Match the size policy used by build_mft_tree_model (no correction here).
        let final_alloc = if e.alloc_size > 0 {
            e.alloc_size
        } else if let Some(g) = base_groups.get(&frn) {
            if g.unnamed_alloc > 0 {
                let fa  = e.file_attrs;
                let df  = g.data_flags;
                let wof = g.wof_alloc > 0;
                let cmp = fa & 0x0800 != 0 || df & 0x0001 != 0;
                let sps = fa & 0x0200 != 0 || df & 0x8000 != 0;
                let rps = fa & 0x0400 != 0;
                let sys = fa & 0x0004 != 0;
                let hid = fa & 0x0002 != 0;
                if !cmp && !sps && !rps && !sys && !hid && !wof { g.unnamed_alloc } else { 0 }
            } else { 0 }
        } else { 0 };

        let (combined_wof, combined_wof_alloc) = if let Some(g) = base_groups.get(&frn) {
            (e.has_wof_stream || g.has_wof,
             e.wof_stream_alloc.saturating_add(g.wof_alloc))
        } else {
            (e.has_wof_stream, e.wof_stream_alloc)
        };
        let combined_data_flags = if let Some(g) = base_groups.get(&frn) {
            e.data_flags | g.data_flags
        } else { e.data_flags };

        let idx = arena.len();
        frn_to_idx.insert(frn, idx);
        arena.push(DNode {
            frn, parent_frn: e.parent_frn, name: e.name.clone(),
            is_dir: e.is_dir, final_alloc,
            subtree_size: final_alloc, direct_file_size: 0,
            children: Vec::new(),
            file_attrs: e.file_attrs,
            data_flags: combined_data_flags,
            hard_link_count: e.hard_link_count,
            file_name_attr_count: e.file_name_attr_count,
            reparse_tag: e.reparse_tag,
            has_wof_stream: combined_wof,
            wof_stream_alloc: combined_wof_alloc,
        });
    }

    // Build parent-child links
    let mut child_parent: Vec<(usize, usize)> = Vec::new();
    let mut root_indices: Vec<usize> = Vec::new();
    for i in 0..arena.len() {
        let (frn, pfn) = (arena[i].frn, arena[i].parent_frn);
        if pfn == frn {
            root_indices.push(i);
        } else if let Some(&pi) = frn_to_idx.get(&pfn) {
            child_parent.push((i, pi));
        } else {
            root_indices.push(i);
        }
    }
    for (ci, pi) in child_parent {
        arena[pi].children.push(ci);
    }

    // Post-order aggregation of subtree_size
    let mut order: Vec<usize> = Vec::with_capacity(arena.len());
    {
        let mut stack: Vec<(usize, bool)> = Vec::new();
        for &r in &root_indices { stack.push((r, false)); }
        while let Some((idx, expanded)) = stack.pop() {
            if expanded {
                order.push(idx);
            } else {
                stack.push((idx, true));
                for &child in arena[idx].children.iter().rev() {
                    stack.push((child, false));
                }
            }
        }
    }
    for &idx in &order {
        let (subtree, pfn, frn) = {
            let n = &arena[idx];
            (n.subtree_size, n.parent_frn, n.frn)
        };
        if pfn != frn {
            if let Some(&pi) = frn_to_idx.get(&pfn) {
                arena[pi].subtree_size = arena[pi].subtree_size.saturating_add(subtree);
            }
        }
    }

    // Direct file size for each directory
    let direct_sizes: Vec<(usize, u64)> = (0..arena.len())
        .filter(|&i| arena[i].is_dir)
        .map(|i| {
            let dfs: u64 = arena[i].children.iter()
                .filter(|&&c| !arena[c].is_dir)
                .map(|&c| arena[c].final_alloc)
                .sum();
            (i, dfs)
        })
        .collect();
    for (i, dfs) in direct_sizes {
        arena[i].direct_file_size = dfs;
    }

    // Closures over arena/frn_to_idx/drive
    let reconstruct = |start_idx: usize| -> String {
        let mut parts: Vec<String> = Vec::new();
        let mut cur = start_idx;
        for _ in 0..64 {
            let (name_opt, pfn, frn) = {
                let n = &arena[cur];
                (if n.frn != 5 { Some(n.name.clone()) } else { None },
                 n.parent_frn, n.frn)
            };
            if let Some(nm) = name_opt { parts.push(nm); }
            if pfn == frn {
                let mut path = format!("{}:", drive);
                for p in parts.iter().rev() { path.push('\\'); path.push_str(p); }
                return path;
            }
            match frn_to_idx.get(&pfn) {
                Some(&pi) => { cur = pi; }
                None => {
                    let mut path = String::from("(orphan)");
                    for p in parts.iter().rev() { path.push('\\'); path.push_str(p); }
                    return path;
                }
            }
        }
        let mut path = String::from("(deep)");
        for p in parts.iter().rev() { path.push('\\'); path.push_str(p); }
        path
    };

    let find_by_segments = |segments: &[&str]| -> Option<usize> {
        let root_idx = *frn_to_idx.get(&5)?;
        let mut cur = root_idx;
        for seg in segments {
            let mut found: Option<usize> = None;
            for &ci in &arena[cur].children {
                if arena[ci].is_dir && arena[ci].name.eq_ignore_ascii_case(seg) {
                    found = Some(ci);
                    break;
                }
            }
            cur = found?;
        }
        Some(cur)
    };

    let collect_descendants = |start_idx: usize| -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        let mut stack: Vec<usize> = vec![start_idx];
        while let Some(idx) = stack.pop() {
            out.push(idx);
            for &ci in &arena[idx].children {
                stack.push(ci);
            }
        }
        out
    };

    struct DiagTarget {
        display_path: &'static str,
        segments: &'static [&'static str],
        comparison_label: Option<&'static str>,
    }
    struct TargetSummary {
        path: String,
        comparison_label: Option<&'static str>,
        likely_wof: String,
        likely_hl: String,
        current_alloc: Option<u64>,
        wof_adjusted_alloc: Option<u64>,
    }

    let fmt_bytes = |bytes: u64| -> String {
        format!(
            "{} bytes ({} MB / {:.3} GB)",
            bytes,
            bytes / 1_048_576,
            bytes as f64 / 1_073_741_824.0
        )
    };
    let fmt_signed_bytes = |bytes: i128| -> String {
        let sign = if bytes < 0 { "-" } else { "+" };
        let abs = bytes.unsigned_abs() as u64;
        format!("{}{}", sign, fmt_bytes(abs))
    };

    let targets: &[DiagTarget] = &[
        DiagTarget {
            display_path: "C:\\Program Files (x86)\\Microsoft\\EdgeCore",
            segments: &["Program Files (x86)", "Microsoft", "EdgeCore"],
            comparison_label: None,
        },
        DiagTarget {
            display_path: "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16",
            segments: &["Program Files (x86)", "Microsoft Office", "root", "Office16"],
            comparison_label: None,
        },
        DiagTarget {
            display_path: "C:\\Program Files (x86)\\Microsoft Office\\root\\VFS",
            segments: &["Program Files (x86)", "Microsoft Office", "root", "VFS"],
            comparison_label: None,
        },
        DiagTarget {
            display_path: "C:\\Program Files (x86)\\Microsoft",
            segments: &["Program Files (x86)", "Microsoft"],
            comparison_label: Some("Microsoft"),
        },
        DiagTarget {
            display_path: "C:\\Program Files (x86)\\Microsoft Office",
            segments: &["Program Files (x86)", "Microsoft Office"],
            comparison_label: Some("Microsoft Office"),
        },
        DiagTarget {
            display_path: "C:\\Program Files (x86)",
            segments: &["Program Files (x86)"],
            comparison_label: Some("Program Files (x86)"),
        },
    ];

    println!("=== Program Files (x86) diagnostics ===");
    println!("(observation only; size policy unchanged)");
    println!();

    let mut summary_notes: Vec<TargetSummary> = Vec::new();

    for target in targets {
        println!("=== PFx86 diagnostics: {} ===", target.display_path);
        match find_by_segments(target.segments) {
            None => {
                println!("found: no");
                println!();
                summary_notes.push(TargetSummary {
                    path: target.display_path.to_string(),
                    comparison_label: target.comparison_label,
                    likely_wof: "not_found".into(),
                    likely_hl: "not_found".into(),
                    current_alloc: None,
                    wof_adjusted_alloc: None,
                });
                continue;
            }
            Some(idx) => {
                let descendants = collect_descendants(idx);
                let desc_dirs  = descendants.iter().filter(|&&i| arena[i].is_dir).count();
                let desc_files = descendants.iter().filter(|&&i| !arena[i].is_dir).count();
                let (subtree_size, dfs, child_count, frn, pfn);
                {
                    let n = &arena[idx];
                    subtree_size = n.subtree_size;
                    dfs = n.direct_file_size;
                    child_count = n.children.len();
                    frn = n.frn;
                    pfn = n.parent_frn;
                }
                println!("found: yes");
                println!("record_index: {}", frn);
                println!("parent_record_index: {}", pfn);
                println!("subtree_size: {} bytes ({} MB / {:.3} GB)",
                    subtree_size, subtree_size / 1_048_576,
                    subtree_size as f64 / 1_073_741_824.0);
                println!("direct_file_size: {} bytes ({} MB)", dfs, dfs / 1_048_576);
                println!("child_count: {}", child_count);
                println!("descendant_dirs: {}", desc_dirs);
                println!("descendant_files: {}", desc_files);
                println!();

                // Top files with attributes
                let mut files_sorted: Vec<usize> = descendants.iter().copied()
                    .filter(|&i| !arena[i].is_dir && arena[i].final_alloc > 0)
                    .collect();
                files_sorted.sort_unstable_by(|&a, &b|
                    arena[b].final_alloc.cmp(&arena[a].final_alloc));

                println!("--- top files with attributes (top 30) ---");
                for (rank, &i) in files_sorted.iter().take(30).enumerate() {
                    let n = &arena[i];
                    let fa = n.file_attrs;
                    let df = n.data_flags;
                    let cmp = (fa & 0x0800 != 0 || df & 0x0001 != 0) as u8;
                    let sps = (fa & 0x0200 != 0 || df & 0x8000 != 0) as u8;
                    let rps = (fa & 0x0400 != 0) as u8;
                    let sys = (fa & 0x0004 != 0) as u8;
                    let hid = (fa & 0x0002 != 0) as u8;
                    let wof = (n.has_wof_stream || n.reparse_tag == 0x80000017) as u8;
                    println!("{:>3}. alloc={:>6}MB rec={:<8} link={:>2} fn={:>2} cmp={} sps={} rps={} sys={} hid={} wof={} tag=0x{:08X} wof_stream={}KB",
                        rank + 1,
                        n.final_alloc / 1_048_576,
                        n.frn,
                        n.hard_link_count,
                        n.file_name_attr_count,
                        cmp, sps, rps, sys, hid, wof,
                        n.reparse_tag,
                        n.wof_stream_alloc / 1024,
                    );
                    println!("     {}", reconstruct(i));
                }
                println!();

                // WOF / reparse summary
                let reparse_records = descendants.iter().filter(|&&i| arena[i].file_attrs & 0x0400 != 0).count();
                let wof_reparse_records = descendants.iter().filter(|&&i| arena[i].reparse_tag == 0x80000017).count();
                let wof_stream_records = descendants.iter().filter(|&&i| arena[i].has_wof_stream).count();
                let wof_stream_total: u64 = descendants.iter().map(|&i| arena[i].wof_stream_alloc).sum();

                println!("--- WOF / reparse summary ---");
                println!("reparse_records:      {}  (file_attrs has reparse bit 0x400)", reparse_records);
                println!("wof_reparse_records:  {}  (reparse tag 0x80000017)", wof_reparse_records);
                println!("wof_stream_records:   {}  (WofCompressedData named $DATA)", wof_stream_records);
                println!("wof_stream_total:     {} MB", wof_stream_total / 1_048_576);

                let mut wof_suspects: Vec<usize> = descendants.iter().copied()
                    .filter(|&i| !arena[i].is_dir &&
                        (arena[i].reparse_tag == 0x80000017 || arena[i].has_wof_stream))
                    .collect();
                wof_suspects.sort_unstable_by(|&a, &b|
                    arena[b].final_alloc.cmp(&arena[a].final_alloc));
                if !wof_suspects.is_empty() {
                    println!("top wof suspects (10):");
                    for (rank, &i) in wof_suspects.iter().take(10).enumerate() {
                        let n = &arena[i];
                        println!("  {}. alloc={}MB tag=0x{:08X} wof_stream={}KB | {}",
                            rank + 1,
                            n.final_alloc / 1_048_576,
                            n.reparse_tag,
                            n.wof_stream_alloc / 1024,
                            reconstruct(i),
                        );
                    }
                }
                println!();

                let wof_files_for_adjustment: Vec<usize> = descendants.iter().copied()
                    .filter(|&i| !arena[i].is_dir && arena[i].wof_stream_alloc > 0)
                    .collect();
                let current_alloc_of_wof_files: u64 = wof_files_for_adjustment.iter()
                    .map(|&i| arena[i].final_alloc)
                    .sum();
                let wof_stream_alloc_total: u64 = wof_files_for_adjustment.iter()
                    .map(|&i| arena[i].wof_stream_alloc)
                    .sum();
                let wof_delta: i128 =
                    wof_stream_alloc_total as i128 - current_alloc_of_wof_files as i128;
                let adjusted_i128 = subtree_size as i128 + wof_delta;
                let wof_adjusted_subtree_alloc = if adjusted_i128 <= 0 {
                    0
                } else if adjusted_i128 > u64::MAX as i128 {
                    u64::MAX
                } else {
                    adjusted_i128 as u64
                };
                let adjustment_ratio = if subtree_size > 0 {
                    wof_delta as f64 / subtree_size as f64 * 100.0
                } else { 0.0 };
                let adjusted_ratio = if subtree_size > 0 {
                    wof_adjusted_subtree_alloc as f64 / subtree_size as f64 * 100.0
                } else { 0.0 };

                println!("--- WOF adjusted estimate ---");
                println!("current_subtree_alloc:        {}", fmt_bytes(subtree_size));
                println!("wof_files:                    {}", wof_files_for_adjustment.len());
                println!("current_alloc_of_wof_files:   {}", fmt_bytes(current_alloc_of_wof_files));
                println!("wof_stream_alloc_total:       {}", fmt_bytes(wof_stream_alloc_total));
                println!("wof_delta:                    {}", fmt_signed_bytes(wof_delta));
                println!("wof_adjusted_subtree_alloc:   {}", fmt_bytes(wof_adjusted_subtree_alloc));
                println!("adjustment_ratio:             {:+.1}% (adjusted/current: {:.1}%)",
                    adjustment_ratio, adjusted_ratio);
                println!("note: wof_files counts files with WofCompressedData allocated size > 0.");
                println!("note: diagnostic estimate only; final_alloc policy is unchanged.");
                println!();

                // compressed / sparse summary
                let cmp_records: usize = descendants.iter().filter(|&&i| {
                    let fa = arena[i].file_attrs; let df = arena[i].data_flags;
                    fa & 0x0800 != 0 || df & 0x0001 != 0
                }).count();
                let cmp_alloc: u64 = descendants.iter().filter(|&&i| {
                    let fa = arena[i].file_attrs; let df = arena[i].data_flags;
                    fa & 0x0800 != 0 || df & 0x0001 != 0
                }).map(|&i| arena[i].final_alloc).sum();
                let sps_records: usize = descendants.iter().filter(|&&i| {
                    let fa = arena[i].file_attrs; let df = arena[i].data_flags;
                    fa & 0x0200 != 0 || df & 0x8000 != 0
                }).count();
                let sps_alloc: u64 = descendants.iter().filter(|&&i| {
                    let fa = arena[i].file_attrs; let df = arena[i].data_flags;
                    fa & 0x0200 != 0 || df & 0x8000 != 0
                }).map(|&i| arena[i].final_alloc).sum();
                println!("--- compressed / sparse summary ---");
                println!("compressed_records:     {}", cmp_records);
                println!("compressed_alloc_total: {} MB", cmp_alloc / 1_048_576);
                println!("sparse_records:         {}", sps_records);
                println!("sparse_alloc_total:     {} MB", sps_alloc / 1_048_576);
                println!();

                // hardlink / multi-name suspects
                let link_gt1: Vec<usize> = descendants.iter().copied()
                    .filter(|&i| !arena[i].is_dir && arena[i].hard_link_count > 1)
                    .collect();
                let multi_fn: usize = descendants.iter()
                    .filter(|&&i| !arena[i].is_dir && arena[i].file_name_attr_count > 1)
                    .count();
                let suspect_alloc_total: u64 = link_gt1.iter()
                    .map(|&i| arena[i].final_alloc).sum();

                println!("--- hardlink / multi-name suspects ---");
                println!("link_count_gt_1_records:  {}", link_gt1.len());
                println!("multi_file_name_records:  {}  (>=2 $FILE_NAME attrs; may include DOS short names)", multi_fn);
                println!("suspect_alloc_total:      {} MB  ({:.3} GB)",
                    suspect_alloc_total / 1_048_576,
                    suspect_alloc_total as f64 / 1_073_741_824.0);

                let mut hl_sorted = link_gt1.clone();
                hl_sorted.sort_unstable_by(|&a, &b|
                    arena[b].final_alloc.cmp(&arena[a].final_alloc));
                if !hl_sorted.is_empty() {
                    println!("top hardlink suspects (10):");
                    for (rank, &i) in hl_sorted.iter().take(10).enumerate() {
                        let n = &arena[i];
                        println!("  {}. alloc={}MB link={} fn={} | {}",
                            rank + 1,
                            n.final_alloc / 1_048_576,
                            n.hard_link_count,
                            n.file_name_attr_count,
                            reconstruct(i),
                        );
                    }
                }
                println!();

                // Diagnostic notes
                let wof_share = if subtree_size > 0 {
                    wof_stream_total as f64 / subtree_size as f64
                } else { 0.0 };
                let hl_share = if subtree_size > 0 {
                    suspect_alloc_total as f64 / subtree_size as f64
                } else { 0.0 };
                let likely_wof = if wof_reparse_records > 0 || wof_stream_records > 0 {
                    if wof_share > 0.2 || wof_reparse_records > 100 { "yes" } else { "partial" }
                } else { "no" };
                let likely_hl = if hl_share > 0.30 || link_gt1.len() > 200 {
                    "yes"
                } else if !link_gt1.is_empty() {
                    "partial"
                } else { "no" };
                let needs_deeper = (likely_wof == "partial") || (likely_hl == "partial");

                println!("--- diagnostic notes ---");
                println!("likely WOF/compression-heavy: {}  (wof_stream share of subtree: {:.1}%)",
                    likely_wof, wof_share * 100.0);
                println!("likely hardlink-heavy:        {}  (hardlink-suspect share of subtree: {:.1}%)",
                    likely_hl, hl_share * 100.0);
                println!("needs deeper cluster-level check: {}",
                    if needs_deeper { "yes" } else { "no" });
                println!();

                summary_notes.push(TargetSummary {
                    path: target.display_path.to_string(),
                    comparison_label: target.comparison_label,
                    likely_wof: likely_wof.to_string(),
                    likely_hl: likely_hl.to_string(),
                    current_alloc: Some(subtree_size),
                    wof_adjusted_alloc: Some(wof_adjusted_subtree_alloc),
                });
            }
        }
    }

    println!("=== PFx86 diagnostics summary ===");
    for summary in &summary_notes {
        println!("{}:", summary.path);
        println!("  likely WOF/compression: {}", summary.likely_wof);
        println!("  likely hardlink:        {}", summary.likely_hl);
    }
    println!();

    struct WizTreeNote {
        label: &'static str,
        wiztree_text: &'static str,
        wiztree_alloc_gb: f64,
    }
    let wiztree_notes: &[WizTreeNote] = &[
        WizTreeNote { label: "Program Files (x86)", wiztree_text: "7.8 GB", wiztree_alloc_gb: 7.8 },
        WizTreeNote { label: "Microsoft", wiztree_text: "1.3 GB", wiztree_alloc_gb: 1.3 },
        WizTreeNote { label: "Microsoft Office", wiztree_text: "3.2 GB", wiztree_alloc_gb: 3.2 },
        WizTreeNote { label: "Windows Kits", wiztree_text: "2.1 GB", wiztree_alloc_gb: 2.1 },
        WizTreeNote { label: "Google", wiztree_text: "842.9 MB", wiztree_alloc_gb: 842.9 / 1024.0 },
    ];

    println!("=== WOF adjustment comparison notes ===");
    for note in wiztree_notes {
        let wiztree_alloc = (note.wiztree_alloc_gb * 1_073_741_824.0).round() as u64;
        let summary = summary_notes.iter()
            .find(|s| s.comparison_label == Some(note.label));
        println!("{}:", note.label);
        match summary {
            Some(summary) => {
                match summary.current_alloc {
                    Some(current) => {
                        println!("  disk-insight current: {}", fmt_bytes(current));
                        println!("  WizTree allocated:   {} (known reference)", note.wiztree_text);
                        println!("  target delta:        {}", fmt_signed_bytes(wiztree_alloc as i128 - current as i128));
                    }
                    None => {
                        println!("  disk-insight current: unavailable");
                        println!("  WizTree allocated:   {} (known reference)", note.wiztree_text);
                        println!("  target delta:        unavailable");
                    }
                }
                match (summary.wof_adjusted_alloc, summary.current_alloc) {
                    (Some(adjusted), Some(_)) => {
                        println!("  WOF-adjusted estimate: {}", fmt_bytes(adjusted));
                        println!("  remaining delta:        {}", fmt_signed_bytes(wiztree_alloc as i128 - adjusted as i128));
                    }
                    _ => {
                        println!("  WOF-adjusted estimate: unavailable");
                        println!("  remaining delta:        unavailable");
                    }
                }
            }
            None => {
                println!("  disk-insight current: unavailable");
                println!("  WizTree allocated:   {} (known reference)", note.wiztree_text);
                println!("  target delta:        unavailable");
                println!("  WOF-adjusted estimate: unavailable");
                println!("  remaining delta:        unavailable");
            }
        }
    }
    println!();
    println!("notes:");
    println!("- 'cmp/sps/rps/sys/hid' = $STANDARD_INFORMATION file_attributes + unnamed $DATA flag bits.");
    println!("- 'wof' = WOF reparse tag (0x80000017) OR WofCompressedData named $DATA stream present.");
    println!("- 'tag' = reparse tag value from resident $REPARSE_POINT (0 if absent or non-resident).");
    println!("- 'link' = MFT record header hard_link_count (offset 0x12).");
    println!("- 'fn' = number of $FILE_NAME attributes (may include DOS short name pairs).");
    println!("- 'wof_stream' = WofCompressedData stream allocation (base + extension records).");
    println!("- Sizes use the same final_alloc policy as --json output. No size correction applied.");

    Ok(())
}
