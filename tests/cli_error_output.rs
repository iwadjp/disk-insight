//! CLI error output regression tests.
//!
//! `--diag-path` against a drive letter that does not exist fails at the volume-open step with or
//! without administrator rights, so this runs the real binary on a normal (non-elevated) machine.

use std::path::Path;
use std::process::Command;

fn missing_drive_letter() -> Option<char> {
    ('A'..='Z').rev().find(|letter| !Path::new(&format!("{letter}:\\")).exists())
}

#[test]
fn diag_path_error_is_prefixed_with_readable_error_label() {
    let Some(letter) = missing_drive_letter() else {
        eprintln!("skipped: every drive letter is in use");
        return;
    };

    let output = Command::new(env!("CARGO_BIN_EXE_disk-insight"))
        .args(["--diag-path", &format!("{letter}:\\missing")])
        .output()
        .expect("run disk-insight");

    assert!(!output.status.success(), "a missing drive must fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.starts_with("エラー: "),
        "stderr should start with the same error label as the other CLI modes, got: {stderr}"
    );
}
