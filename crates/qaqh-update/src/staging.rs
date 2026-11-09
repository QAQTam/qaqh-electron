//! 更新编排状态机：stage（校验+暂存）→ apply-staged（等退出+原子应用）→ rollback-staged。
//!
//! 对齐原 Windows 仓 qaqh-updater 的行为面，但只依赖本 crate 的引擎原语：
//! - stage：读 update-source 的 catalog，对照 install-state 规划（plan_update），
//!   把选中 artifact **先校验 sha256 再落暂存区**，写出 staged-operation.json。
//!   暂存是单操作缓冲：每次 stage 重建目录，旧内容一律作废。
//! - apply：等可选的 pid 退出（壳退出流程传 Electron pid）→ 逐 artifact 复核
//!   暂存包摘要 → apply_bundle_zip 原子应用（.previous 备份 + install-state 提交）
//!   → 可选重启命令 → 尽力而为清暂存。
//! - rollback：按逆序 rollback_bundle_zip，并把 install-state 恢复为暂存时快照。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::{
    DirectoryUpdateSource, Result, StagedArtifact, StagedOperation, UpdateError, UpdateSource,
    apply_bundle_zip, installation_id_for_path, load_installed_state, plan_update,
    rollback_bundle_zip, sha256_reader, write_installed_state,
};

pub const STAGED_OPERATION_FILE: &str = "staged-operation.json";
pub const STAGED_BUNDLES_DIR: &str = "bundles";

#[derive(Debug)]
pub struct StageOutcome {
    pub operation: StagedOperation,
    /// true = 计划结果为 Current（已最新）；此时不落暂存，且旧暂存被清除。
    pub up_to_date: bool,
}

pub struct ApplyStagedOptions<'a> {
    pub staging_root: &'a Path,
    pub install_root: &'a Path,
    /// 等待退出的进程（壳退出流程传 Electron pid）；None = 立即应用。
    pub wait_pid: Option<u32>,
    pub wait_timeout: Duration,
    /// 应用成功后拉起的命令（argv）；空 = 不重启。
    pub relaunch: &'a [String],
}

pub fn stage_update(
    source_root: &Path,
    install_root: &Path,
    staging_root: &Path,
) -> Result<StageOutcome> {
    let source = DirectoryUpdateSource::new(source_root)?;
    let catalog = source.catalog()?;
    let state_path = install_root.join("install-state.json");
    let state = load_installed_state(&state_path, &installation_id_for_path(install_root))?;
    let plan = plan_update(state.as_ref(), &catalog)?;
    let mut operation = StagedOperation {
        format_version: 1,
        operation_id: plan.operation_id.clone(),
        release_id: plan.release_id.clone(),
        source: source_root.to_string_lossy().into_owned(),
        plan,
        previous_state: state,
        artifacts: Vec::new(),
    };
    if operation.plan.artifacts.is_empty() {
        // 已最新：不留 staging 痕迹，顺手清掉旧暂存，防止日后误 apply 陈旧操作。
        match fs::symlink_metadata(staging_root) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(UpdateError(
                    "staging root must not be a symbolic link".into(),
                ));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(UpdateError("staging root must be a directory".into()));
            }
            Ok(_) => fs::remove_dir_all(staging_root)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        return Ok(StageOutcome {
            operation,
            up_to_date: true,
        });
    }

    match fs::symlink_metadata(staging_root) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(UpdateError(
                "staging root must not be a symbolic link".into(),
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(UpdateError("staging root must be a directory".into()));
        }
        Ok(_) => fs::remove_dir_all(staging_root)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::create_dir_all(staging_root.join(STAGED_BUNDLES_DIR))?;
    for id in &operation.plan.artifacts {
        let artifact = catalog
            .artifacts
            .iter()
            .find(|candidate| &candidate.id == id)
            .ok_or_else(|| UpdateError(format!("plan artifact '{id}' missing in catalog")))?;
        let file_name = artifact
            .payload
            .path
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                UpdateError(format!(
                    "artifact '{}' payload path has no file name",
                    artifact.id
                ))
            })?;
        let destination = staging_root.join(STAGED_BUNDLES_DIR).join(file_name);
        let input = source.open_artifact(&artifact.payload.path)?;
        copy_verified(
            input,
            &destination,
            artifact.payload.size,
            &artifact.payload.sha256,
        )?;
        operation.artifacts.push(StagedArtifact {
            id: artifact.id.clone(),
            kind: artifact.kind,
            path: format!("{STAGED_BUNDLES_DIR}/{file_name}"),
            size: artifact.payload.size,
            sha256: artifact.payload.sha256.clone(),
        });
    }
    write_staged_operation(staging_root, &operation)?;
    Ok(StageOutcome {
        operation,
        up_to_date: false,
    })
}

pub fn read_staged_operation(staging_root: &Path) -> Result<StagedOperation> {
    let path = crate::safe_join_under_root(staging_root, STAGED_OPERATION_FILE)?;
    let bytes = fs::read(&path).map_err(|error| {
        UpdateError(format!(
            "read staged operation '{}': {error}",
            path.display()
        ))
    })?;
    let operation: StagedOperation = serde_json::from_slice(&bytes)?;
    Ok(operation)
}

pub fn apply_staged(options: ApplyStagedOptions) -> Result<StagedOperation> {
    let operation = read_staged_operation(options.staging_root)?;
    if let Some(pid) = options.wait_pid {
        wait_process_exit(pid, options.wait_timeout)?;
    }
    for artifact in &operation.artifacts {
        let zip = staged_artifact_path(options.staging_root, &artifact.path)?;
        let (size, sha256) = sha256_reader(fs::File::open(&zip)?)?;
        if size != artifact.size || !sha256.eq_ignore_ascii_case(&artifact.sha256) {
            return Err(UpdateError(format!(
                "staged artifact '{}' verification failed: expected {} bytes/{}, got {} bytes/{}",
                artifact.id, artifact.size, artifact.sha256, size, sha256
            )));
        }
        apply_bundle_zip(&zip, options.install_root, &operation.operation_id)?;
    }
    if !options.relaunch.is_empty() {
        relaunch_detached(options.relaunch)?;
    }
    // 应用成功后清暂存（尽力而为；失败不影响已生效的更新）。
    if fs::symlink_metadata(options.staging_root)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        let _ = fs::remove_dir_all(options.staging_root);
    }
    Ok(operation)
}

pub fn rollback_staged(staging_root: &Path, install_root: &Path) -> Result<StagedOperation> {
    let operation = read_staged_operation(staging_root)?;
    for artifact in operation.artifacts.iter().rev() {
        let zip = staged_artifact_path(staging_root, &artifact.path)?;
        rollback_bundle_zip(&zip, install_root)?;
    }
    if let Some(previous) = &operation.previous_state {
        write_installed_state(&install_root.join("install-state.json"), previous)?;
    }
    if fs::symlink_metadata(staging_root)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        let _ = fs::remove_dir_all(staging_root);
    }
    Ok(operation)
}

fn staged_artifact_path(staging_root: &Path, relative: &str) -> Result<PathBuf> {
    crate::safe_join_under_root(staging_root, relative)
}

fn write_staged_operation(staging_root: &Path, operation: &StagedOperation) -> Result<()> {
    let path = crate::safe_join_under_root(staging_root, STAGED_OPERATION_FILE)?;
    let temporary = staging_root.join(format!(".{STAGED_OPERATION_FILE}.qaqh-new"));
    fs::write(&temporary, serde_json::to_vec_pretty(operation)?)?;
    fs::rename(&temporary, &path)?;
    Ok(())
}

/// 边拷贝边算摘要：摘要不符时删除半成品并报错，绝不把坏包留在暂存区。
fn copy_verified(
    mut input: Box<dyn Read>,
    destination: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            UpdateError(format!(
                "invalid staging file name: {}",
                destination.display()
            ))
        })?;
    let temporary = destination.with_file_name(format!(".{file_name}.qaqh-new"));
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    let mut output = fs::File::create(&temporary)?;
    let mut hasher = Sha256::new();
    let mut copied = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        std::io::Write::write_all(&mut output, &buffer[..read])?;
        hasher.update(&buffer[..read]);
        copied += read as u64;
    }
    output.sync_all()?;
    drop(output);
    let sha256 = hex::encode(hasher.finalize());
    if copied != expected_size || !sha256.eq_ignore_ascii_case(expected_sha256) {
        let _ = fs::remove_file(&temporary);
        return Err(UpdateError(format!(
            "artifact payload verification failed: expected {} bytes/{}, got {} bytes/{}",
            expected_size, expected_sha256, copied, sha256
        )));
    }
    fs::rename(&temporary, destination)?;
    Ok(())
}

/// 等 pid 死透。zombie（/proc/<pid>/stat state == 'Z'）按已退出处理——
/// 暂存操作与目标进程无父子关系时不会遇到，但测试与被收养场景下更稳。
fn wait_process_exit(pid: u32, timeout: Duration) -> Result<()> {
    #[cfg(unix)]
    {
        let stat_path = PathBuf::from(format!("/proc/{pid}/stat"));
        let deadline = Instant::now() + timeout;
        loop {
            if process_is_dead(&stat_path) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(UpdateError(format!(
                    "timed out waiting for pid {pid} to exit ({}s)",
                    timeout.as_secs()
                )));
            }
            thread::sleep(Duration::from_millis(200));
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // STILL_ACTIVE = STATUS_WAIT_0 + 259;windows-sys 0.59 未导出该常量。
        const STILL_ACTIVE: u32 = 259;
        let deadline = Instant::now() + timeout;
        loop {
            let exited = unsafe {
                // 句柄拿不到(权限/已回收)按"仍存活"处理:宁可超时报错,也不提前写坏包。
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if handle.is_null() {
                    false
                } else {
                    let mut code: u32 = 0;
                    let ok = GetExitCodeProcess(handle, &mut code);
                    CloseHandle(handle);
                    ok != 0 && code != STILL_ACTIVE
                }
            };
            if exited {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(UpdateError(format!(
                    "timed out waiting for pid {pid} to exit ({}s)",
                    timeout.as_secs()
                )));
            }
            thread::sleep(Duration::from_millis(200));
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (pid, timeout);
        Err(UpdateError(
            "--wait-pid is only supported on unix in this build".into(),
        ))
    }
}

#[cfg(unix)]
fn process_is_dead(stat_path: &Path) -> bool {
    let Ok(stat) = fs::read_to_string(stat_path) else {
        return true; // 条目已消失 = 进程已退出并被回收
    };
    // stat 布局: pid (comm) state ... —— comm 可含空格/括号，取最后一个 ')' 之后的首字符。
    let state = stat
        .split(')')
        .nth(1)
        .and_then(|rest| rest.trim_start().chars().next());
    matches!(state, None | Some('Z'))
}

fn relaunch_detached(command: &[String]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::process::{Command, Stdio};
        let (program, args) = command
            .split_first()
            .ok_or_else(|| UpdateError("relaunch command is empty".into()))?;
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| UpdateError(format!("relaunch '{program}': {error}")))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::process::{Command, Stdio};
        let (program, args) = command
            .split_first()
            .ok_or_else(|| UpdateError("relaunch command is empty".into()))?;
        // 更新器自身就是分离进程;GUI 子系统的壳不需要额外 detachment 标志。
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| UpdateError(format!("relaunch '{program}': {error}")))?;
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = command;
        Err(UpdateError(
            "relaunch is only supported on unix in this build".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::time::Duration;

    use serde_json::json;
    use zip::write::SimpleFileOptions;

    use super::*;
    use crate::{ComponentHealth, ComponentState, InstalledState, sha256_reader};

    fn digest(content: &[u8]) -> String {
        hex::encode(Sha256::digest(content))
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qaqh-staging-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 组装一个前端+后端双组件的 update-source（catalog + 两个 bundle zip）。
    fn write_source(source: &Path, frontend_payload: &[u8], daemon_payload: &[u8]) {
        fs::create_dir_all(source.join("bundles")).unwrap();
        write_component_bundle(
            &source.join("bundles/frontend-new.zip"),
            "frontend",
            "frontend-new",
            "app/app.js",
            frontend_payload,
            None,
        );
        write_component_bundle(
            &source.join("bundles/backend-new.zip"),
            "backend",
            "backend-new",
            "backend/qaqh-daemon",
            daemon_payload,
            Some(0o755),
        );
        let catalog = json!({
            "formatVersion": 1,
            "releaseId": "release-2",
            "channel": "local",
            "publishedAt": "2026-10-28T00:00:00Z",
            "components": {
                "frontend": {"buildId": "frontend-new", "version": "2.0.0", "controlProtocol": 1},
                "backend": {"buildId": "backend-new", "version": "2.0.0", "controlProtocol": 1}
            },
            "artifacts": [
                {
                    "id": "frontend", "kind": "frontend", "strategy": "component-full",
                    "targets": {"frontend": "frontend-new"},
                    "requires": {"controlProtocol": 1},
                    "restartPolicy": "electron",
                    "payload": {"path": "bundles/frontend-new.zip", "size": fs::metadata(source.join("bundles/frontend-new.zip")).unwrap().len(), "sha256": sha256_reader(fs::File::open(source.join("bundles/frontend-new.zip")).unwrap()).unwrap().1}
                },
                {
                    "id": "backend", "kind": "backend", "strategy": "component-full",
                    "targets": {"backend": "backend-new"},
                    "requires": {"controlProtocol": 1},
                    "restartPolicy": "daemon",
                    "payload": {"path": "bundles/backend-new.zip", "size": fs::metadata(source.join("bundles/backend-new.zip")).unwrap().len(), "sha256": sha256_reader(fs::File::open(source.join("bundles/backend-new.zip")).unwrap()).unwrap().1}
                }
            ]
        });
        fs::write(
            source.join("catalog.json"),
            serde_json::to_vec_pretty(&catalog).unwrap(),
        )
        .unwrap();
    }

    fn write_component_bundle(
        path: &Path,
        kind: &str,
        build_id: &str,
        target: &str,
        payload: &[u8],
        mode: Option<u32>,
    ) {
        let mut files = json!([{
            "source": format!("files/{target}"),
            "target": target,
            "size": payload.len(),
            "sha256": digest(payload)
        }]);
        if let Some(mode) = mode {
            files.as_array_mut().unwrap()[0]["mode"] = json!(mode);
        }
        let manifest = json!({
            "formatVersion": 1,
            "kind": kind,
            "buildId": build_id,
            "appVersion": "2.0.0",
            "releaseId": "release-2",
            "channel": "local",
            "components": {kind: {"buildId": build_id, "version": "2.0.0", "controlProtocol": 1}},
            "requiresFullInstall": false,
            "files": files
        });
        let file = fs::File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("bundle.json", SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        archive
            .start_file(format!("files/{target}"), SimpleFileOptions::default())
            .unwrap();
        archive.write_all(payload).unwrap();
        archive.finish().unwrap();
    }

    /// 旧版安装态：frontend/backend 都停在 -old，协议 1 与 catalog 对齐。
    fn write_old_state(install_root: &Path) {
        let component = |current: &str| ComponentState {
            current: current.into(),
            previous: None,
            version: "1.9.0".into(),
            protocol: Some(1),
            health: ComponentHealth::Healthy,
        };
        let state = InstalledState {
            format_version: 2,
            installation_id: installation_id_for_path(install_root),
            release_id: "release-1".into(),
            channel: "local".into(),
            components: BTreeMap::from([
                ("frontend".into(), component("frontend-old")),
                ("backend".into(), component("backend-old")),
            ]),
            last_committed_operation: None,
        };
        write_installed_state(&install_root.join("install-state.json"), &state).unwrap();
    }

    #[test]
    fn stage_apply_rollback_round_trip() {
        let root = temp_dir("roundtrip");
        let source = root.join("source");
        let install = root.join("install");
        let staging = root.join("staging");
        fs::create_dir_all(&install).unwrap();
        write_source(&source, b"new-app", b"new-daemon");
        write_old_state(&install);

        // 旧文件就位
        fs::create_dir_all(install.join("app")).unwrap();
        fs::create_dir_all(install.join("backend")).unwrap();
        fs::write(install.join("app/app.js"), b"old-app").unwrap();
        fs::write(install.join("backend/qaqh-daemon"), b"old-daemon").unwrap();

        let outcome = stage_update(&source, &install, &staging).unwrap();
        assert!(!outcome.up_to_date);
        assert_eq!(outcome.operation.plan.artifacts, ["frontend", "backend"]);
        assert_eq!(outcome.operation.artifacts.len(), 2);
        assert!(staging.join(STAGED_OPERATION_FILE).is_file());

        let applied = apply_staged(ApplyStagedOptions {
            staging_root: &staging,
            install_root: &install,
            wait_pid: None,
            wait_timeout: Duration::from_secs(1),
            relaunch: &[],
        })
        .unwrap();
        assert_eq!(applied.operation_id, outcome.operation.operation_id);
        assert_eq!(fs::read(install.join("app/app.js")).unwrap(), b"new-app");
        assert_eq!(
            fs::read(install.join("app/app.js.previous")).unwrap(),
            b"old-app"
        );
        assert_eq!(
            fs::read(install.join("backend/qaqh-daemon")).unwrap(),
            b"new-daemon"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let daemon_mode = fs::metadata(install.join("backend/qaqh-daemon"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(daemon_mode & 0o111, 0o111, "daemon 必须保留执行位");
        }
        // 应用成功后暂存被清空
        assert!(!staging.exists());

        // state 推进到 -new
        let state = load_installed_state(&install.join("install-state.json"), "ignored")
            .unwrap()
            .unwrap();
        assert_eq!(state.components["frontend"].current, "frontend-new");
        assert_eq!(state.components["backend"].current, "backend-new");

        // 已最新：再 stage 得 Current，且不重建暂存
        let again = stage_update(&source, &install, &staging).unwrap();
        assert!(again.up_to_date);
        assert!(!staging.exists());

        // 回滚需要暂存——重建暂存（round trip 已删），此处直接手工重放 stage 前态不可行，
        // 改为独立回滚用例覆盖（见 rollback_restores_previous_files_and_state）。
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rollback_restores_previous_files_and_state() {
        let root = temp_dir("rollback");
        let source = root.join("source");
        let install = root.join("install");
        let staging = root.join("staging");
        fs::create_dir_all(&install).unwrap();
        write_source(&source, b"new-app", b"new-daemon");
        write_old_state(&install);
        fs::create_dir_all(install.join("app")).unwrap();
        fs::write(install.join("app/app.js"), b"old-app").unwrap();
        // 只有 frontend 变化：backend 状态已是 backend-new? 不——write_old_state 都是 old，
        // catalog 两个都会变。为聚焦回滚，先把 backend 状态推进到 -new（模拟之前已更新）。
        let state = load_installed_state(&install.join("install-state.json"), "ignored")
            .unwrap()
            .unwrap();
        let mut advanced = state.clone();
        advanced.components.get_mut("backend").unwrap().current = "backend-new".into();
        write_installed_state(&install.join("install-state.json"), &advanced).unwrap();

        // 只 stage 不 apply_staged（apply 成功会清暂存），手工应用 frontend 包，
        // 再走 rollback_staged 验证文件与状态双复原。
        stage_update(&source, &install, &staging).unwrap();
        let staged = read_staged_operation(&staging).unwrap();
        assert_eq!(
            staged.plan.artifacts,
            ["frontend"],
            "backend 已是目标版本,只该规划 frontend"
        );
        let zip = staging.join("bundles/frontend-new.zip");
        crate::apply_bundle_zip(&zip, &install, "op-manual").unwrap();
        assert_eq!(fs::read(install.join("app/app.js")).unwrap(), b"new-app");

        rollback_staged(&staging, &install).unwrap();
        assert_eq!(fs::read(install.join("app/app.js")).unwrap(), b"old-app");
        assert!(!install.join("app/app.js.previous").exists());
        let state = load_installed_state(&install.join("install-state.json"), "ignored")
            .unwrap()
            .unwrap();
        assert_eq!(state.components["frontend"].current, "frontend-old");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stage_rejects_tampered_payload() {
        let root = temp_dir("tamper");
        let source = root.join("source");
        let install = root.join("install");
        let staging = root.join("staging");
        fs::create_dir_all(&install).unwrap();
        write_source(&source, b"new-app", b"new-daemon");
        write_old_state(&install);
        // 篡改 zip 内容，sha256 不再匹配 catalog
        fs::write(source.join("bundles/frontend-new.zip"), b"tampered").unwrap();
        let error = stage_update(&source, &install, &staging).unwrap_err();
        assert!(error.to_string().contains("verification failed"), "{error}");
        assert!(
            !staging.join(STAGED_OPERATION_FILE).exists(),
            "坏包不得写入暂存"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn apply_waits_for_pid_exit_and_times_out_on_live_pid() {
        let root = temp_dir("waitpid");
        let source = root.join("source");
        let install = root.join("install");
        let staging = root.join("staging");
        fs::create_dir_all(&install).unwrap();
        write_source(&source, b"new-app", b"new-daemon");
        write_old_state(&install);
        fs::create_dir_all(install.join("app")).unwrap();
        fs::write(install.join("app/app.js"), b"old-app").unwrap();
        stage_update(&source, &install, &staging).unwrap();

        // 活 pid：必须在超时后报错，而不是立即应用。
        let live_pid = std::process::id();
        let error = apply_staged(ApplyStagedOptions {
            staging_root: &staging,
            install_root: &install,
            wait_pid: Some(live_pid),
            wait_timeout: Duration::from_millis(600),
            relaunch: &[],
        })
        .unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error}");
        assert_eq!(fs::read(install.join("app/app.js")).unwrap(), b"old-app");

        // 退出中的 pid：子进程 ~1s 后退出，等待后应用成功。
        #[cfg(unix)]
        let mut child = std::process::Command::new("sleep")
            .arg("0.3")
            .spawn()
            .unwrap();
        #[cfg(windows)]
        let mut child = std::process::Command::new("ping")
            .args(["-n", "2", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let child_pid = child.id();
        apply_staged(ApplyStagedOptions {
            staging_root: &staging,
            install_root: &install,
            wait_pid: Some(child_pid),
            wait_timeout: Duration::from_secs(15),
            relaunch: &[],
        })
        .unwrap();
        assert_eq!(fs::read(install.join("app/app.js")).unwrap(), b"new-app");
        child.wait().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relaunch_spawns_detached_command() {
        let root = temp_dir("relaunch");
        let source = root.join("source");
        let install = root.join("install");
        let staging = root.join("staging");
        let probe = root.join("relaunched-probe");
        fs::create_dir_all(&install).unwrap();
        write_source(&source, b"new-app", b"new-daemon");
        write_old_state(&install);
        fs::create_dir_all(install.join("app")).unwrap();
        fs::write(install.join("app/app.js"), b"old-app").unwrap();
        stage_update(&source, &install, &staging).unwrap();

        #[cfg(unix)]
        let relaunch_command = vec![
            "sh".into(),
            "-c".into(),
            format!("echo ok > {}", probe.display()),
        ];
        #[cfg(windows)]
        let relaunch_command = vec![
            "cmd".into(),
            "/C".into(),
            "mkdir".into(),
            // 用 mkdir 做探针;分开传参,不把整条命令塞进一个带重定向的字符串
            // (cmd /C 对含内嵌引号的整串命令有历史遗留的引号剥离规则)。
            probe.display().to_string(),
        ];
        apply_staged(ApplyStagedOptions {
            staging_root: &staging,
            install_root: &install,
            wait_pid: None,
            wait_timeout: Duration::from_secs(1),
            relaunch: &relaunch_command,
        })
        .unwrap();
        // 子进程是异步的，轮询等探针出现。
        let deadline = Instant::now() + Duration::from_secs(5);
        while !probe.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(probe.is_dir(), "relaunch 命令未执行");
        assert_eq!(fs::read(install.join("app/app.js")).unwrap(), b"new-app");
        fs::remove_dir_all(root).unwrap();
    }
}
