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
