//! qaqh-update — 运行时更新 CLI（原 Windows 仓 qaqh-updater 的 Linux 形态）。
//!
//! 子命令：
//!   plan            [--source <dir>] --install-root <dir> [--json]
//!       读 catalog + install-state，输出更新计划（不落任何文件）。
//!   stage           --source <dir> --install-root <dir> --staging <dir> [--json]
//!       校验并暂存选中 artifact，写出 staged-operation.json。
//!   apply-staged    --staging <dir> --install-root <dir>
//!                   [--wait-pid <pid>] [--wait-timeout <secs>] [--relaunch <cmd> <args...>]
//!       等可选 pid 退出后原子应用暂存包；成功后清暂存。
//!   rollback-staged --staging <dir> --install-root <dir>
//!       逆序回滚暂存操作并恢复 install-state 快照。
//!   inspect         --staging <dir>
//!       打印暂存操作内容（排查用）。
//!
//! 壳的典型链路：renderer 确认退出 → 壳 spawn 本命令
//! `apply-staged --wait-pid <electron-pid> --relaunch <electron> <app-dir>` → 壳退出。

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant};

use qaqh_update::{
    ApplyStagedOptions, DirectoryUpdateSource, Result, UpdateError, UpdateMode, UpdateSource,
    apply_staged, current_snapshot_path, installation_id_for_path, load_installed_state,
    lock_install_root, plan_update, read_staged_operation, safe_join_under_root, stage_update,
    verify_install_root,
};
use std::fs;

fn mode_text(mode: &UpdateMode) -> &'static str {
    match mode {
        UpdateMode::Install => "install",
        UpdateMode::Update => "update",
        UpdateMode::Upgrade => "upgrade",
        UpdateMode::Current => "current",
    }
}

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let result = match arguments.first().map(String::as_str) {
        Some("plan") => cmd_plan(&arguments[1..]),
        Some("stage") => cmd_stage(&arguments[1..]),
        Some("apply-staged") => cmd_apply_staged(&arguments[1..]),
        Some("rollback-staged") => cmd_rollback_staged(&arguments[1..]),
        Some("inspect") => cmd_inspect(&arguments[1..]),
        Some("help" | "--help" | "-h") | None => {
            print_usage();
            Ok(())
        }
        Some(other) => Err(UpdateError(format!(
            "unknown command '{other}' (expected plan | stage | apply-staged | rollback-staged | inspect)"
        ))),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("qaqh-update: {error}");
            let message = error.to_string();
            let code = if message.contains("maintenance lock busy") {
                3
            } else if message.contains("invalid install root") || message.contains("install root") {
                5
            } else if message.contains("bundle") || message.contains("payload") {
                6
            } else {
                1
            };
            ExitCode::from(code)
        }
    }
}

fn print_usage() {
    println!(
        "qaqh-update — QAQ-Harness 运行时更新 CLI\n\
         plan [--source <dir>] --install-root <dir> [--json]\n\
         stage --source <dir> --install-root <dir> --staging <dir> [--json]\n\
         apply-staged --staging <dir> --install-root <dir> [--wait-pid <pid>] [--wait-timeout <secs>] [--relaunch <cmd> <args...>]\n\
         rollback-staged --staging <dir> --install-root <dir>\n\
         inspect --staging <dir> --install-root <dir>"
    );
}

/// 简易 `--key value` 参数解析（与 qaqh-pack 同款，无 clap 依赖）。
struct Args {
    pairs: Vec<(String, String)>,
}

impl Args {
    fn parse(raw: &[String]) -> Result<Self> {
        let mut pairs = Vec::new();
        let mut iter = raw.iter();
        while let Some(key) = iter.next() {
            if !key.starts_with("--") {
                return Err(UpdateError(format!("expected --flag, got '{key}'")));
            }
            let value = iter
                .next()
                .ok_or_else(|| UpdateError(format!("missing value for {key}")))?
                .clone();
            pairs.push((key.strip_prefix("--").unwrap_or(key).to_string(), value));
        }
        Ok(Self { pairs })
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    fn require(&self, key: &str) -> Result<String> {
        self.get(key)
            .map(str::to_string)
            .ok_or_else(|| UpdateError(format!("missing required --{key}")))
    }

    fn flag(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
}

fn load_state(install_root: &Path) -> qaqh_update::Result<Option<qaqh_update::InstalledState>> {
    load_installed_state(
        &install_root.join("install-state.json"),
        &installation_id_for_path(install_root),
    )
}

fn validate_staging_root(install_root: &Path, staging_root: &Path) -> Result<()> {
    let canonical_install = verify_install_root(install_root)?;
    let expected = canonical_install.join("staging");
    if let Some(parent) = expected.parent() {
        safe_join_under_root(parent, "staging")?;
    }
    if let Some(parent) = staging_root.parent()
        && parent != canonical_install
    {
        return Err(UpdateError(
            "staging path parent must be the installation root".into(),
        ));
    }
    let staging_input = if staging_root.is_absolute() {
        staging_root.to_path_buf()
    } else {
        std::env::current_dir()?.join(staging_root)
    };
    let staging = if staging_input.exists() {
        std::fs::canonicalize(&staging_input)?
    } else {
        staging_input
    };
    if staging != expected {
        return Err(UpdateError(format!(
            "staging root must be the managed directory {}",
            expected.display()
        )));
    }
    // The staging top-level directory itself may be absent, but never follow it.
    match std::fs::symlink_metadata(&expected) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(UpdateError(
                "staging root must not be a symbolic link".into(),
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(UpdateError("staging root must be a directory".into()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
        _ => {}
    }
    Ok(())
}

fn cmd_plan(raw: &[String]) -> qaqh_update::Result<()> {
    let args = Args::parse(raw)?;
    let install_input = PathBuf::from(args.require("install-root")?);
    let install_root = match verify_install_root(&install_input) {
        Ok(root) => current_snapshot_path(&root)?.unwrap_or(root),
        Err(_error) if !install_input.exists() => install_input,
        Err(error) => return Err(error),
    };
    let source_root = PathBuf::from(
        args.get("source")
            .map(str::to_string)
            .unwrap_or_else(|| default_source_dir().to_string_lossy().into_owned()),
    );
    let catalog = DirectoryUpdateSource::new(&source_root)?.catalog()?;
    let plan = plan_update(load_state(&install_root)?.as_ref(), &catalog)?;
    if args.flag("json") {
        println!("{}", serde_json::to_string_pretty(&plan)?);
        return Ok(());
    }
    if plan.artifacts.is_empty() {
        println!("plan: up to date (release {})", plan.release_id);
    } else {
        println!(
            "plan: {} {} -> artifacts [{}]",
            mode_text(&plan.mode),
            plan.release_id,
            plan.artifacts.join(", ")
        );
    }
    Ok(())
}

fn cmd_stage(raw: &[String]) -> qaqh_update::Result<()> {
    let args = Args::parse(raw)?;
    let source_root = PathBuf::from(args.require("source")?);
    let user_root = verify_install_root(Path::new(&args.require("install-root")?))?;
    let staging_root = PathBuf::from(args.require("staging")?);
    let _lock = lock_install_root(&user_root)?;
    validate_staging_root(&user_root, &staging_root)?;
    let active = qaqh_update::load_active_state(&user_root)?;
    if active.pending_operation.is_some() {
        return Err(UpdateError(
            "a snapshot operation is already pending".into(),
        ));
    }
    let target_root = current_snapshot_path(&user_root)?.unwrap_or_else(|| user_root.clone());
    let outcome = stage_update(&source_root, &target_root, &staging_root)?;
    if args.flag("json") {
        let summary = serde_json::json!({
            "upToDate": outcome.up_to_date,
            "operationId": outcome.operation.operation_id,
            "releaseId": outcome.operation.release_id,
            "mode": outcome.operation.plan.mode,
            "artifacts": outcome.operation.artifacts,
        });
        println!("{summary}");
        return Ok(());
    }
    if outcome.up_to_date {
        println!(
            "stage: up to date (release {})",
            outcome.operation.release_id
        );
        return Ok(());
    }
    for artifact in &outcome.operation.artifacts {
        println!(
            "stage: {} ({}) -> {}",
            artifact.id,
            artifact.kind.as_str(),
            artifact.path
        );
    }
    println!(
        "stage: operation {} staged in {}",
        outcome.operation.operation_id,
        staging_root.display()
    );
    Ok(())
}

fn cmd_apply_staged(raw: &[String]) -> qaqh_update::Result<()> {
    // --relaunch 之后全部视为重启命令 argv，不参与 --key value 解析。
    let relaunch_position = raw.iter().position(|item| item == "--relaunch");
    let (flag_range, relaunch): (&[String], &[String]) = match relaunch_position {
        Some(position) => (&raw[..position], &raw[position + 1..]),
        None => (raw, &[]),
    };
    let args = Args::parse(flag_range)?;
    let staging_root = PathBuf::from(args.require("staging")?);
    let user_root = verify_install_root(Path::new(&args.require("install-root")?))?;
    let wait_pid = args
        .get("wait-pid")
        .map(str::parse::<u32>)
        .transpose()
        .map_err(|error| UpdateError(format!("invalid --wait-pid: {error}")))?;
    let wait_timeout = args
        .get("wait-timeout")
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|error| UpdateError(format!("invalid --wait-timeout: {error}")))?
        .unwrap_or(600)
        .max(1);
    let _lock = lock_install_root(&user_root)?;
    validate_staging_root(&user_root, &staging_root)?;
    let Some(old_generation) = current_snapshot_path(&user_root)? else {
        let operation = read_staged_operation(&staging_root)?;
        let current_state = load_installed_state(
            &user_root.join("install-state.json"),
            &installation_id_for_path(&user_root),
        )?;
        let staged_state = operation.previous_state.as_ref();
        if serde_json::to_value(current_state)? != serde_json::to_value(staged_state)? {
            return Err(UpdateError(
                "staged operation was based on a different active generation".into(),
            ));
        }
        let operation = apply_staged(ApplyStagedOptions {
            staging_root: &staging_root,
            install_root: &user_root,
            wait_pid,
            wait_timeout: Duration::from_secs(wait_timeout),
            relaunch,
        })?;
        for artifact in &operation.artifacts {
            println!("applied: {} ({})", artifact.id, artifact.kind.as_str());
        }
        println!(
            "apply-staged: operation {} committed to {}",
            operation.operation_id,
            user_root.display()
        );
        return Ok(());
    };
    let operation = read_staged_operation(&staging_root)?;
    let current_state = load_installed_state(
        &old_generation.join("install-state.json"),
        &installation_id_for_path(&old_generation),
    )?;
    let staged_state = operation.previous_state.as_ref();
    if serde_json::to_value(current_state)? != serde_json::to_value(staged_state)? {
        return Err(UpdateError(
            "staged operation was based on a different active generation".into(),
        ));
    }
    if let Some(pid) = wait_pid {
        wait_for_process_exit(pid, Duration::from_secs(wait_timeout))?;
    }
    let generation_id = format!("update_{}", operation.operation_id.replace('-', "_"));
    let next_generation = user_root.join("generations").join(&generation_id);
    match std::fs::symlink_metadata(&next_generation) {
        Ok(_) => return Err(UpdateError("generation target already exists".into())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if let Err(error) = copy_generation(&old_generation, &next_generation) {
        if next_generation.exists() {
            let _ = fs::remove_dir_all(&next_generation);
        }
        return Err(error);
    }
    let original_state = load_installed_state(
        &old_generation.join("install-state.json"),
        &installation_id_for_path(&old_generation),
    )?;
    let result = apply_staged(ApplyStagedOptions {
        staging_root: &staging_root,
        install_root: &next_generation,
        wait_pid: None,
        wait_timeout: Duration::from_secs(1),
        relaunch: &[],
    });
    let operation = match result {
        Ok(operation) => operation,
        Err(error) => {
            if next_generation.exists() {
                let _ = fs::remove_dir_all(&next_generation);
            }
            return Err(error);
        }
    };
    if let Some(previous) = original_state {
        let state_path = next_generation.join("install-state.json");
        let state_result = (|| -> Result<()> {
            let mut committed: qaqh_update::InstalledState =
                serde_json::from_slice(&fs::read(&state_path)?)?;
            committed.installation_id = previous.installation_id;
            qaqh_update::write_installed_state(&state_path, &committed)
        })();
        if let Err(error) = state_result {
            let _ = fs::remove_dir_all(&next_generation);
            return Err(error);
        }
    }
    if let Err(error) = qaqh_update::activate_snapshot_locked(&user_root, &generation_id, "update")
    {
        let _ = fs::remove_dir_all(&next_generation);
        return Err(error);
    }
    if !relaunch.is_empty() {
        let _child = std::process::Command::new(&relaunch[0])
            .args(&relaunch[1..])
            .spawn()?;
    }
    for artifact in &operation.artifacts {
        println!("applied: {} ({})", artifact.id, artifact.kind.as_str());
    }
    println!(
        "apply-staged: operation {} committed to {}",
        operation.operation_id,
        next_generation.display()
    );
    Ok(())
}

fn cmd_rollback_staged(raw: &[String]) -> qaqh_update::Result<()> {
    let args = Args::parse(raw)?;
    let staging_root = PathBuf::from(args.require("staging")?);
    let install_root = verify_install_root(Path::new(&args.require("install-root")?))?;
    let _lock = lock_install_root(&install_root)?;
    validate_staging_root(&install_root, &staging_root)?;
    let state = qaqh_update::rollback_snapshot_locked(&install_root, None)?;
    if fs::symlink_metadata(&staging_root)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        let _ = fs::remove_dir_all(&staging_root);
    }
    let generation = state
        .current
        .as_deref()
        .ok_or_else(|| UpdateError("rollback produced no active generation".into()))?;
    println!(
        "QAQH_APP_DIR={}",
        install_root
            .join("generations")
            .join(generation)
            .join("app")
            .display()
    );
    println!("{}", serde_json::to_string_pretty(&state)?);
    Ok(())
}

fn cmd_inspect(raw: &[String]) -> qaqh_update::Result<()> {
    let args = Args::parse(raw)?;
    let staging_root = PathBuf::from(args.require("staging")?);
    let install_root = PathBuf::from(args.require("install-root")?);
    validate_staging_root(&install_root, &staging_root)?;
    let operation = read_staged_operation(&staging_root)?;
    let current = current_snapshot_path(&install_root)?.unwrap_or_else(|| install_root.clone());
    let valid_for_active = operation.previous_state.as_ref().is_none_or(|previous| {
        load_installed_state(
            &current.join("install-state.json"),
            &installation_id_for_path(&current),
        )
        .ok()
        .flatten()
        .is_some_and(|state| state.last_committed_operation == previous.last_committed_operation)
    });
    if !valid_for_active {
        return Err(UpdateError(
            "staged operation was based on a different active generation".into(),
        ));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&operation).map_err(UpdateError::from)?
    );
    Ok(())
}

fn copy_generation(source: &Path, destination: &Path) -> Result<()> {
    let source_metadata = fs::symlink_metadata(source)?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err(UpdateError(
            "generation source must be a real directory".into(),
        ));
    }
    fs::create_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            return Err(UpdateError(format!(
                "generation contains a symbolic link: {}",
                entry.path().display()
            )));
        }
        let target = destination.join(entry.file_name());
        if metadata.is_dir() {
            copy_generation(&entry.path(), &target)?;
        } else if metadata.is_file() {
            fs::copy(entry.path(), target)?;
        } else {
            return Err(UpdateError(format!(
                "generation contains a special file: {}",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

fn wait_for_process_exit(pid: u32, timeout: Duration) -> Result<()> {
    #[cfg(unix)]
    let alive = |pid: u32| {
        // SAFETY: signal zero only probes existence/permissions; it sends no signal.
        unsafe {
            libc::kill(pid as libc::pid_t, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
    };
    #[cfg(not(unix))]
    let alive = |_pid: u32| false;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !alive(pid) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    if alive(pid) {
        Err(UpdateError(format!(
            "timed out waiting for pid {pid} to exit"
        )))
    } else {
        Ok(())
    }
}

fn default_source_dir() -> PathBuf {
    if let Some(source) = std::env::var_os("QAQH_UPDATE_SOURCE") {
        return PathBuf::from(source);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join(".local/share/QAQ-Harness/update-source")
}
