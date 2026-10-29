//! qaqh-maint — 安装/卸载 CLI(系统包维护脚本与 updater 的共用入口)。
//!
//! 子命令:
//!   unpack <bundle.zip> <install-root>
//!       应用组件包并提交 install-state;首次安装写入 install-root marker,
//!       已有 marker 则先验证(防错删别的目录)。
//!   cleanup <install-root>
//!       尽力而为清理用户组件根:只删 updater 管理的已知条目(app/、backend/、
//!       install-state.json、marker、*.previous),绝不碰其他内容。
//!
//! 纪律:unpack 严格校验、失败即非零;cleanup **恒返零** —— 在系统包卸载钩子
//! (deb postrm / rpm %postun / pacman post_remove)里失败会让包卡在半卸载状态,
//! 任何清理失败都只记 stderr。daemon 进程的停止不在这里:那是壳退出流程和
//! 维护脚本(带超时的 pkill)的职责,本命令只管文件域。

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use qaqh_update::{
    apply_bundle_zip, commit_bundle_state, verify_install_root, write_install_root_marker,
    INSTALL_ROOT_MARKER,
};

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let result = match arguments.as_slice() {
        [command, bundle, target] if command == "unpack" => unpack(Path::new(bundle), Path::new(target)),
        [command, target] if command == "cleanup" => {
            cleanup(Path::new(target));
            return ExitCode::SUCCESS;
        }
        _ => {
            eprintln!("usage: qaqh-maint unpack <bundle.zip> <install-root>");
            eprintln!("       qaqh-maint cleanup <install-root>");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("qaqh-maint: {error}");
            ExitCode::FAILURE
        }
    }
}

type Outcome = Result<(), String>;

fn unpack(bundle: &Path, target: &Path) -> Outcome {
    let marker = target.join(INSTALL_ROOT_MARKER);
    if marker.exists() {
        // 既有安装:marker 绑定目录,拷不走;验证失败立即终止,防误写。
        verify_install_root(target).map_err(|error| error.to_string())?;
    }
    let operation_id = format!("maint-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default());
    let manifest = apply_bundle_zip(bundle, target, &operation_id)
        .map_err(|error| error.to_string())?;
    write_install_root_marker(target).map_err(|error| error.to_string())?;
    commit_bundle_state(target, &manifest, &operation_id)
        .map_err(|error| error.to_string())?;
    println!(
        "unpack: {} ({}) applied, {} files -> {}",
        manifest.kind,
        manifest.build_id,
        manifest.files.len(),
        target.display()
    );
    Ok(())
}

/// cleanup 恒返零:每一条独立清理,失败只记 stderr,不互相打断。
fn cleanup(target: &Path) {
    let root = PathBuf::from(target);
    if !root.exists() {
        println!("cleanup: {} does not exist, nothing to do", root.display());
        return;
    }
    for entry in ["app", "backend"] {
        remove_best_effort(&root.join(entry));
    }
    for entry in ["install-state.json", INSTALL_ROOT_MARKER] {
        remove_best_effort(&root.join(entry));
    }
    remove_previous_backups(&root);
    println!("cleanup: {}", root.display());
}

fn remove_best_effort(path: &Path) {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => {
            if let Err(error) = std::fs::remove_dir_all(path) {
                eprintln!("cleanup: skip '{}': {error}", path.display());
            }
        }
        Ok(_) => {
            if let Err(error) = std::fs::remove_file(path) {
                eprintln!("cleanup: skip '{}': {error}", path.display());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => eprintln!("cleanup: skip '{}': {error}", path.display()),
    }
}

fn remove_previous_backups(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(children) = std::fs::read_dir(&path) else {
            continue;
        };
        for child in children.flatten() {
            let name = child.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".previous") {
                remove_best_effort(&child.path());
            }
        }
    }
}
