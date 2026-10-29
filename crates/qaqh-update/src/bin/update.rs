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
use std::time::Duration;

use qaqh_update::{
    ApplyStagedOptions, DirectoryUpdateSource, Result, UpdateError, UpdateMode, UpdateSource,
    apply_staged, installation_id_for_path, load_installed_state, plan_update,
    read_staged_operation, rollback_staged, stage_update,
};

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
            ExitCode::FAILURE
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
         inspect --staging <dir>"
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

fn cmd_plan(raw: &[String]) -> qaqh_update::Result<()> {
    let args = Args::parse(raw)?;
    let install_root = PathBuf::from(args.require("install-root")?);
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
    let install_root = PathBuf::from(args.require("install-root")?);
    let staging_root = PathBuf::from(args.require("staging")?);
    let outcome = stage_update(&source_root, &install_root, &staging_root)?;
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
        println!("stage: up to date (release {})", outcome.operation.release_id);
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
    let install_root = PathBuf::from(args.require("install-root")?);
    let wait_pid = args.get("wait-pid").map(str::parse::<u32>).transpose()
        .map_err(|error| UpdateError(format!("invalid --wait-pid: {error}")))?;
    let wait_timeout = args
        .get("wait-timeout")
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|error| UpdateError(format!("invalid --wait-timeout: {error}")))?
        .unwrap_or(600)
        .max(1);
    let operation = apply_staged(ApplyStagedOptions {
        staging_root: &staging_root,
        install_root: &install_root,
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
        install_root.display()
    );
    Ok(())
}

fn cmd_rollback_staged(raw: &[String]) -> qaqh_update::Result<()> {
    let args = Args::parse(raw)?;
    let staging_root = PathBuf::from(args.require("staging")?);
    let install_root = PathBuf::from(args.require("install-root")?);
    let operation = rollback_staged(&staging_root, &install_root)?;
    for artifact in operation.artifacts.iter().rev() {
        println!("rolled back: {} ({})", artifact.id, artifact.kind.as_str());
    }
    println!(
        "rollback-staged: operation {} reverted, state restored to release {}",
        operation.operation_id, operation.release_id
    );
    Ok(())
}

fn cmd_inspect(raw: &[String]) -> qaqh_update::Result<()> {
    let args = Args::parse(raw)?;
    let staging_root = PathBuf::from(args.require("staging")?);
    let operation = read_staged_operation(&staging_root)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&operation).map_err(UpdateError::from)?
    );
    Ok(())
}

fn default_source_dir() -> PathBuf {
    if let Some(source) = std::env::var_os("QAQH_UPDATE_SOURCE") {
        return PathBuf::from(source);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join(".local/share/QAQ-Harness/update-source")
}
