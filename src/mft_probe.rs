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
                    let byte_offset = lcn * bytes_per_cluster;
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
        record_idx: usize,
        name:       String,
        parent_frn: u64,
        size:       u64,
    }

    // 診断カウンタ
    let file_sig_count    = AtomicUsize::new(0);
    let in_use_count      = AtomicUsize::new(0); // flags bit0=1
    let res_data_count    = AtomicUsize::new(0); // resident $DATA
    let nonres_data_count = AtomicUsize::new(0); // non-resident $DATA
    let fn_fallback_count = AtomicUsize::new(0); // $DATA 未発見 → fn_size 採用
    let size_zero_count   = AtomicUsize::new(0); // size == 0
    let size_1gb_count    = AtomicUsize::new(0); // size > 1GB

    let parse_start = std::time::Instant::now();

    let entries: Vec<ParsedEntry> = mft_buf
        .par_chunks_exact(record_size)
        .enumerate()
        .filter_map(|(i, raw)| {
            let record = apply_fixup(raw)?;

            if record.len() < 4 || &record[0..4] != b"FILE" { return None; }
            file_sig_count.fetch_add(1, Ordering::Relaxed);

            if record.len() < 24 { return None; }

            // offset 22: flags (2 bytes) - bit0=in_use, bit1=directory
            let flags = u16::from_le_bytes([record[22], record[23]]);
            if flags & 0x01 != 0 {
                in_use_count.fetch_add(1, Ordering::Relaxed);
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

                match attr_type {
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
                        // 無名 $DATA のみ・先着1件
                        // ガードをマッチアームから外して内側で判定（ADS 混在時も正しく処理）
                        if record[pos + 9] == 0 && data_size.is_none() {
                            if non_resident == 1 && pos + 56 <= record.len() {
                                // 非常駐: offset+48 = RealSize (offset+40 = AllocatedSize)
                                data_size = Some(u64::from_le_bytes([
                                    record[pos+48], record[pos+49], record[pos+50], record[pos+51],
                                    record[pos+52], record[pos+53], record[pos+54], record[pos+55],
                                ]));
                                found_nonres = true;
                            } else if non_resident == 0 && pos + 20 <= record.len() {
                                // 常駐: offset+16 = ContentLength (u32)
                                data_size = Some(u32::from_le_bytes([
                                    record[pos+16], record[pos+17], record[pos+18], record[pos+19],
                                ]) as u64);
                                found_res = true;
                            }
                        }
                    }
                    _ => {}
                }

                pos += attr_len;
            }

            if name.is_empty() { return None; }

            if found_res    { res_data_count.fetch_add(1, Ordering::Relaxed); }
            if found_nonres { nonres_data_count.fetch_add(1, Ordering::Relaxed); }

            let size = if let Some(ds) = data_size {
                ds
            } else {
                fn_fallback_count.fetch_add(1, Ordering::Relaxed);
                fn_size
            };

            if size == 0        { size_zero_count.fetch_add(1, Ordering::Relaxed); }
            if size > 1_073_741_824 { size_1gb_count.fetch_add(1, Ordering::Relaxed); }

            Some(ParsedEntry { record_idx: i, name, parent_frn, size })
        })
        .collect();

    let parse_elapsed = parse_start.elapsed();
    let total_elapsed = total_start.elapsed();

    let file_sig_total    = file_sig_count.load(Ordering::Relaxed);
    let in_use_total      = in_use_count.load(Ordering::Relaxed);
    let res_data_total    = res_data_count.load(Ordering::Relaxed);
    let nonres_data_total = nonres_data_count.load(Ordering::Relaxed);
    let fn_fallback_total = fn_fallback_count.load(Ordering::Relaxed);
    let size_zero_total   = size_zero_count.load(Ordering::Relaxed);
    let size_1gb_total    = size_1gb_count.load(Ordering::Relaxed);
    let total_size: u64   = entries.iter().map(|e| e.size).sum();

    let mut top20: Vec<&ParsedEntry> = entries.iter()
        .filter(|e| e.size > 0)
        .collect();
    top20.sort_unstable_by(|a, b| b.size.cmp(&a.size));
    top20.truncate(20);

    println!();
    println!("=== probe6 結果 ===");
    println!("total records:            {:>10}", total_records);
    println!("valid FILE records:       {:>10}  (apply_fixup + FILE sig)", file_sig_total);
    println!("  in-use  (flags bit0=1): {:>10}", in_use_total);
    println!("  deleted (flags bit0=0): {:>10}", file_sig_total.saturating_sub(in_use_total));
    println!("parsed file entries:      {:>10}  (FILE sig + $FILE_NAME あり)", entries.len());
    println!("  resident $DATA:         {:>10}", res_data_total);
    println!("  non-resident $DATA:     {:>10}", nonres_data_total);
    println!("  fn_size fallback:       {:>10}  (base record に $DATA なし)", fn_fallback_total);
    println!("  size == 0:              {:>10}", size_zero_total);
    println!("  size > 1GB:             {:>10}", size_1gb_total);
    println!("total size:               {:>6} GB ({} bytes)",
        total_size / 1_073_741_824, total_size);
    println!("parse elapsed:            {:.2}秒", parse_elapsed.as_secs_f64());
    println!("total elapsed:            {:.2}秒", total_elapsed.as_secs_f64());
    println!();
    println!("--- top 20 largest entries ---");
    for (rank, e) in top20.iter().enumerate() {
        println!("{:>3}. {:>10} MB  {}  (parent_frn={}, idx={})",
            rank + 1, e.size / 1_048_576, e.name, e.parent_frn, e.record_idx);
    }

    Ok(())
}
