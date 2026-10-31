//! qaqh-maint — 安装/卸载 CLI(系统包维护脚本与 updater 的共用入口)。
//!
//! 子命令:
//!   unpack <bundle.zip> <install-root>
//!       应用组件包并提交 install-state;首次安装写入 install-root marker,
//!       已有 marker 则先验证(防错删别的目录)。
//!   system-check --resources <system-resources>
//!       验证 dpkg 管理的系统 CLI 与离线 baseline，不触碰用户数据。
//!
//! 旧 cleanup 命令已禁用：用户目录删除必须经过安装登记、marker、身份与锁校验。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use qaqh_update::{
    ActiveState, activate_snapshot_locked, apply_bundle_zip, begin_snapshot_boot,
    commit_bundle_state, confirm_snapshot, current_snapshot_path, initialize_install_root,
    load_active_state, load_installed_state, lock_install_root, parse_bundle_manifest,
    rollback_snapshot_locked, sha256_reader,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let result = match arguments.as_slice() {
        [command, rest @ ..] => command_result(command, rest),
        [] => Err("missing command".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("qaqh-maint: {error}");
            if arguments.iter().any(|argument| argument == "--json") {
                let code = classify_error(&error);
                let safe_message = if code == 4 {
                    "consent_required"
                } else {
                    "maintenance operation failed"
                };
                println!(
                    "{{\"ok\":false,\"code\":{code},\"message\":{}}}",
                    serde_json::to_string(safe_message).unwrap_or_else(|_| "\"failed\"".into())
                );
            }
            ExitCode::from(classify_error(&error))
        }
    }
}

type Outcome = Result<(), String>;

fn command_result(command: &str, raw: &[String]) -> Outcome {
    if raw.iter().any(|argument| argument == "--json")
        && !matches!(
            command,
            "inspect" | "install" | "repair" | "confirm" | "rollback" | "uninstall" | "begin-boot"
        )
    {
        return Err(format!("--json is not supported for {command}"));
    }
    match command {
        "inspect" => {
            let root = option_path(raw, "--root")?;
            let state = inspect(&root)?;
            let current_path = if std::fs::symlink_metadata(&root).is_ok() {
                current_snapshot_path(&root).map_err(|error| error.to_string())?
            } else {
                None
            };
            let installed = state.current.is_some() && current_path.is_some();
            let actual_component_builds = current_path
                .as_deref()
                .and_then(|generation| {
                    load_installed_state(
                        &generation.join("install-state.json"),
                        &qaqh_update::installation_id_for_path(generation),
                    )
                    .ok()
                    .flatten()
                })
                .map(|installed| {
                    installed
                        .components
                        .into_iter()
                        .map(|(name, component)| {
                            (name, serde_json::Value::String(component.current))
                        })
                        .collect::<serde_json::Map<_, _>>()
                });
            let consent_required = state.current.is_none() || !consent_is_valid(&root);
            let response = serde_json::json!({
                "installed": installed,
                "consentRequired": consent_required,
                "current": state.current,
                "previous": state.previous,
                "pending": state.pending_operation.as_ref().map(|pending| {
                    serde_json::json!({
                        "operationId": pending.operation_id,
                        "old": pending.old,
                        "new": pending.new,
                        "phase": pending.phase,
                        "trigger": pending.trigger,
                    })
                }),
                "actualComponentBuilds": actual_component_builds,
                "blockedBaseline": state.blocked_baseline,
            });
            print_json(true, None, None, Some(&response))?;
            Ok(())
        }
        "install" | "repair" => {
            let root = option_path(raw, "--root")?;
            let baseline = option_path(raw, "--baseline")?;
            let legal = option_value(raw, "--accept-legal");
            if command == "repair" && !consent_is_valid(&root) {
                return Err("consent_required".into());
            }
            let state = deploy(command, &root, &baseline, legal)?;
            print_json(
                true,
                state
                    .pending_operation
                    .as_ref()
                    .map(|pending| pending.operation_id.as_str()),
                None,
                Some(&state),
            )?;
            Ok(())
        }
        "confirm" => {
            let root = option_path(raw, "--root")?;
            let operation = option_value(raw, "--operation").ok_or("missing --operation")?;
            let state = confirm_snapshot(&root, operation).map_err(|error| error.to_string())?;
            print_json(true, None, None, Some(&state))?;
            Ok(())
        }
        "rollback" => {
            let root = option_path(raw, "--root")?;
            let baseline = option_value(raw, "--baseline");
            let canonical =
                qaqh_update::verify_install_root(&root).map_err(|error| error.to_string())?;
            let _lock = lock_install_root(&canonical).map_err(|error| error.to_string())?;
            let state = rollback_snapshot_locked(&canonical, baseline)
                .map_err(|error| error.to_string())?;
            print_json(true, None, None, Some(&state))?;
            Ok(())
        }
        "begin-boot" => {
            let root = option_path(raw, "--root")?;
            let state = begin_snapshot_boot(&root).map_err(|error| error.to_string())?;
            print_json(true, None, None, Some(&state))?;
            Ok(())
        }
        "uninstall" => {
            let root = option_path(raw, "--root")?;
            uninstall(&root)?;
            print_json(
                true,
                None,
                None,
                Some(&serde_json::json!({"uninstalled": true, "dataPreserved": true})),
            )?;
            Ok(())
        }
        "system-check" => {
            let resources = option_path(raw, "--resources")?;
            system_check(&resources)
        }
        "unpack" => match raw {
            [bundle, target] => unpack(Path::new(bundle), Path::new(target)),
            _ => Err("usage: qaqh-maint unpack <bundle.zip> <install-root>".into()),
        },
        "cleanup" => {
            Err("cleanup is disabled; use validated uninstall after it is implemented".into())
        }
        _ => Err(format!("unknown command: {command}")),
    }
}

fn option_value<'a>(raw: &'a [String], name: &str) -> Option<&'a str> {
    raw.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].as_str())
}

fn option_path(raw: &[String], name: &str) -> Result<PathBuf, String> {
    option_value(raw, name)
        .map(PathBuf::from)
        .ok_or_else(|| format!("missing {name}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliResult<'a, T> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<T>,
}

fn print_json<T: Serialize>(
    ok: bool,
    operation_id: Option<&str>,
    message: Option<&str>,
    state: Option<&T>,
) -> Outcome {
    let result = CliResult {
        ok,
        operation_id,
        code: None,
        message,
        state,
    };
    println!(
        "{}",
        serde_json::to_string(&result).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn inspect(root: &Path) -> OutcomeResult<ActiveState> {
    match std::fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("invalid install root".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ActiveState::default());
        }
        Err(error) => return Err(error.to_string()),
    }
    load_active_state(root).map_err(|error| error.to_string())
}

type OutcomeResult<T> = std::result::Result<T, String>;

fn deploy(
    command: &str,
    root: &Path,
    baseline: &Path,
    legal: Option<&str>,
) -> OutcomeResult<ActiveState> {
    if command == "install" {
        let accepted = legal
            .ok_or_else(|| "consent_required: install requires explicit acceptance".to_string())?;
        validate_legal_manifest(baseline, accepted)?;
        if current_snapshot_path(root).ok().flatten().is_some() {
            return Err("installation already exists; use repair".into());
        }
    } else if legal.is_some() {
        return Err("--accept-legal is only valid for install".into());
    } else if current_snapshot_path(root).ok().flatten().is_none() {
        return Err("no installed generation to repair".into());
    }
    let canonical = initialize_install_root(root).map_err(|error| error.to_string())?;
    if command == "repair" && !consent_is_valid(&canonical) {
        return Err("consent_required".into());
    }
    let _guard = lock_install_root(&canonical).map_err(|error| error.to_string())?;
    let index: serde_json::Value = serde_json::from_slice(
        &std::fs::read(baseline.join("baseline.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if index
        .get("formatVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return Err("invalid baseline index".into());
    }
    let legal_version = if command == "install" {
        let accepted = legal.ok_or_else(|| "consent_required".to_string())?;
        validate_legal_manifest(baseline, accepted)?;
        Some(accepted.to_owned())
    } else {
        None
    };
    let operation_id = format!(
        "maint-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default()
    );
    let generation_id = operation_id.replace('-', "_");
    let generation_root = canonical.join("generations").join(&generation_id);
    std::fs::create_dir_all(&generation_root).map_err(|e| e.to_string())?;
    let deployment_result = (|| -> OutcomeResult<()> {
        for (name, filename, target) in [
            ("frontend", "app.zip", "app"),
            ("backend", "backend.zip", "backend"),
        ] {
            let metadata = index
                .pointer(&format!("/components/{name}"))
                .ok_or_else(|| format!("baseline missing {name} metadata"))?;
            let expected_hash = metadata
                .get("sha256")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| format!("baseline missing {name} sha256"))?;
            let bundle_path = baseline.join(filename);
            let (size, hash) =
                sha256_reader(std::fs::File::open(&bundle_path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if hash != expected_hash {
                return Err(format!(
                    "baseline checksum mismatch: {filename} ({size} bytes)"
                ));
            }
            let manifest =
                qaqh_update::read_bundle_manifest_zip(&bundle_path).map_err(|e| e.to_string())?;
            if manifest.kind
                != if name == "frontend" {
                    "frontend"
                } else {
                    "backend"
                }
            {
                return Err(format!(
                    "baseline kind mismatch: expected {name} in {filename}"
                ));
            }
            let manifest_build = manifest
                .components
                .get(name)
                .ok_or_else(|| format!("baseline manifest missing component metadata: {name}"))?;
            if metadata.get("buildId").and_then(serde_json::Value::as_str)
                != Some(manifest_build.build_id.as_str())
            {
                return Err(format!("baseline buildId mismatch: {name}"));
            }
            let prefix = format!("{target}/");
            if manifest
                .files
                .iter()
                .any(|file| !file.target.starts_with(&prefix))
            {
                return Err(format!("baseline bundle target escapes {target} component"));
            }
            apply_bundle_zip(&bundle_path, &generation_root, &operation_id)
                .map_err(|error| error.to_string())?;
            let _ = target;
        }
        if !generation_root.join("app/package.json").is_file()
            || !generation_root.join("app/dist/main/index.cjs").is_file()
            || !generation_root.join("app/dist/preload/index.cjs").is_file()
            || !generation_root.join("app/renderer/index.html").is_file()
            || !generation_root.join("backend/qaqh-daemon").is_file()
        {
            return Err(
                "baseline generation missing app/package.json or backend/qaqh-daemon".into(),
            );
        }
        Ok(())
    })();
    if let Err(error) = deployment_result {
        let _ = std::fs::remove_dir_all(&generation_root);
        return Err(error);
    }
    if command == "install" {
        write_legal_consent(
            baseline,
            &canonical,
            legal.ok_or_else(|| "consent_required".to_string())?,
        )?;
    }
    let registration_path = canonical.join("installation.json");
    let mut registration: serde_json::Value = if registration_path.exists() {
        serde_json::from_slice(&std::fs::read(&registration_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        let consent: serde_json::Value = serde_json::from_slice(
            &std::fs::read(canonical.join("legal-consent.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        serde_json::json!({
            "schemaVersion": 1,
            "installationId": qaqh_update::installation_id_for_path(&canonical),
            "uid": current_uid(),
            "legalVersion": legal_version,
            "legalDocumentHashes": consent.get("documents").cloned().unwrap_or(serde_json::Value::Null),
        })
    };
    if command == "install" {
        registration["legalVersion"] = serde_json::Value::String(
            legal
                .ok_or_else(|| "consent_required".to_string())?
                .to_owned(),
        );
    }
    atomic_json(&canonical.join("installation.json"), &mut registration)?;
    match activate_snapshot_locked(&canonical, &generation_id, command) {
        Ok(state) => Ok(state),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&generation_root);
            Err(error.to_string())
        }
    }
}

fn validate_legal_manifest(baseline: &Path, accepted: &str) -> OutcomeResult<()> {
    let baseline_index: serde_json::Value = serde_json::from_slice(
        &std::fs::read(baseline.join("baseline.json"))
            .map_err(|_| "consent_required".to_string())?,
    )
    .map_err(|_| "consent_required".to_string())?;
    let baseline_legal = baseline_index
        .get("legal")
        .ok_or_else(|| "consent_required".to_string())?;
    let legal_version = baseline_index
        .get("legalVersion")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "consent_required".to_string())?;
    if legal_version != accepted {
        return Err("consent_required".into());
    }
    if baseline_legal
        .get("version")
        .and_then(serde_json::Value::as_str)
        != Some(accepted)
    {
        return Err("consent_required".into());
    }
    let legal_dir = baseline.join("legal");
    for document in ["user-agreement", "privacy-policy"] {
        let key = if document == "user-agreement" {
            "userAgreement"
        } else {
            "privacyPolicy"
        };
        let file_name = baseline_legal
            .pointer(&format!("/documents/{key}/file"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "consent_required".to_string())?;
        if Path::new(file_name).components().count() != 1
            || !file_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err("consent_required".into());
        }
        let expected = baseline_legal
            .pointer(&format!("/documents/{key}/sha256"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "consent_required".to_string())?;
        let actual = Sha256::digest(
            std::fs::read(legal_dir.join(file_name)).map_err(|_| "consent_required".to_string())?,
        );
        if hex::encode(actual) != expected {
            return Err("consent_required".into());
        }
        if std::fs::read(legal_dir.join(file_name))
            .map_err(|_| "consent_required".to_string())?
            .windows(5)
            .any(|window| window.eq_ignore_ascii_case(b"draft"))
        {
            return Err("consent_required".into());
        }
    }
    Ok(())
}

fn read_consent_version(root: &Path) -> Option<String> {
    let consent: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("legal-consent.json")).ok()?).ok()?;
    consent
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn required_consent_version(root: &Path) -> Option<String> {
    let registration: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("installation.json")).ok()?).ok()?;
    registration
        .get("legalVersion")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn consent_is_valid(root: &Path) -> bool {
    let Some(version) = required_consent_version(root) else {
        return false;
    };
    let Some(consent) = read_consent_version(root) else {
        return false;
    };
    if version != consent {
        return false;
    }
    let registration: Option<serde_json::Value> =
        std::fs::read(root.join("installation.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let accepted: Option<serde_json::Value> =
        std::fs::read(root.join("legal-consent.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let expected_hashes = registration
        .as_ref()
        .and_then(|value| value.get("legalDocumentHashes"));
    let actual_hashes = accepted
        .as_ref()
        .and_then(|value| value.get("documents"));
    expected_hashes.is_some() && expected_hashes == actual_hashes
}

fn write_legal_consent(baseline: &Path, install_root: &Path, accepted: &str) -> OutcomeResult<()> {
    validate_legal_manifest(baseline, accepted)?;
    let baseline_index: serde_json::Value = serde_json::from_slice(
        &std::fs::read(baseline.join("baseline.json"))
            .map_err(|_| "consent_required".to_string())?,
    )
    .map_err(|_| "consent_required".to_string())?;
    let legal_manifest = baseline_index
        .get("legal")
        .ok_or_else(|| "consent_required".to_string())?;
    let mut hashes = serde_json::Map::new();
    for document in ["user-agreement", "privacy-policy"] {
        let hash = legal_manifest
            .pointer(&format!(
                "/documents/{}",
                if document == "user-agreement" {
                    "userAgreement"
                } else {
                    "privacyPolicy"
                }
            ))
            .and_then(|entry| entry.get("sha256"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "consent_required".to_string())?;
        hashes.insert(document.into(), serde_json::Value::String(hash.into()));
    }
    let mut consent = serde_json::json!({
        "version": accepted,
        "documents": hashes,
        "confirmedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default(),
        "source": "maintenance-ui",
        "uid": current_uid(),
    });
    atomic_json(&install_root.join("legal-consent.json"), &mut consent)?;
    Ok(())
}

fn current_uid() -> u32 {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and returns the current process UID.
        unsafe { libc::geteuid() }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

fn atomic_json(path: &Path, value: &mut serde_json::Value) -> OutcomeResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| "JSON path has no parent".to_string())?;
    let temporary = parent.join(format!(
        ".{}.{}.new",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    use std::io::Write;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn uninstall(root: &Path) -> OutcomeResult<()> {
    let canonical = qaqh_update::verify_install_root(root).map_err(|error| error.to_string())?;
    let _guard = lock_install_root(&canonical).map_err(|error| error.to_string())?;
    let active = load_active_state(&canonical).map_err(|error| error.to_string())?;
    if active.pending_operation.is_some() {
        return Err("cannot uninstall while a snapshot operation is pending".into());
    }
    // Probe every discovery location supported by Electron. A live process in
    // any legacy config directory blocks cleanup; no daemon is ever killed here.
    let mut discovery_paths = Vec::new();
    if let Some(data_dir) = std::env::var_os("QAQH_DATA_DIR") {
        discovery_paths.push(PathBuf::from(data_dir).join("daemon.json"));
    }
    if let Some(config_home) = std::env::var_os("XDG_CONFIG_HOME") {
        discovery_paths.push(PathBuf::from(config_home).join("qaqh/daemon.json"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        discovery_paths.push(PathBuf::from(&home).join(".config/qaqh/daemon.json"));
        discovery_paths.push(PathBuf::from(home).join(".qaqh/daemon.json"));
    }
    discovery_paths.sort();
    discovery_paths.dedup();
    for discovery_path in discovery_paths {
        match std::fs::read(discovery_path) {
            Ok(bytes) => {
                let discovery: serde_json::Value =
                    serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                let pid = discovery
                    .get("pid")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| "daemon discovery has no PID; busy".to_string())?;
                if process_is_alive(pid as i32) {
                    return Err("daemon is still running; busy".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    {
        for entry in [
            "generations",
            "staging",
            "legacy",
            "installation.json",
            "active.json",
            "legal-consent.json",
            "baseline-receipt.json",
        ] {
            let path = canonical.join(entry);
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(format!("refusing symlink during uninstall: {entry}"));
                }
                Ok(metadata) if metadata.is_dir() => {
                    std::fs::remove_dir_all(path).map_err(|e| e.to_string())?
                }
                Ok(_) => std::fs::remove_file(path).map_err(|e| e.to_string())?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(())
    }
}

fn process_is_alive(pid: i32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal zero performs existence/permission checks and sends no signal.
        unsafe {
            libc::kill(pid, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

fn classify_error(error: &str) -> u8 {
    if error.contains("maintenance lock busy") || error.contains(" busy") {
        3
    } else if error.contains("consent_required") {
        4
    } else if error.contains("invalid install root") || error.contains("install root") {
        5
    } else if error.contains("bundle")
        || error.contains("payload")
        || error.contains("baseline")
        || error.contains("manifest")
    {
        6
    } else {
        1
    }
}

fn system_check(resources: &Path) -> Outcome {
    let required = [
        resources.join("bin/qaqh-maint"),
        resources.join("bin/qaqh-update"),
        resources.join("baseline/baseline.json"),
        resources.join("baseline/app.zip"),
        resources.join("baseline/backend.zip"),
    ];
    for path in required {
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("required system payload '{}': {error}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!("invalid system payload: {}", path.display()));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.uid() != 0 {
                return Err(format!(
                    "system payload is not root-owned: {}",
                    path.display()
                ));
            }
            if matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("qaqh-maint" | "qaqh-update")
            ) && metadata.permissions().mode() & 0o111 == 0
            {
                return Err(format!("system CLI is not executable: {}", path.display()));
            }
        }
    }
    let index_path = resources.join("baseline/baseline.json");
    let index: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&index_path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("invalid baseline index: {e}"))?;
    if index
        .get("formatVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return Err("unsupported baseline index format".into());
    }
    for (name, file) in [("frontend", "app.zip"), ("backend", "backend.zip")] {
        let component = index
            .pointer(&format!("/components/{name}"))
            .ok_or_else(|| format!("baseline index missing {name} metadata"))?;
        let expected_hash = component
            .get("sha256")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("baseline index missing {name} sha256"))?;
        let expected_size = component
            .get("size")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| format!("baseline index missing {name} size"))?;
        let bundle_path = resources.join("baseline").join(file);
        let (actual_size, actual_hash) =
            sha256_reader(std::fs::File::open(&bundle_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if actual_size != expected_size || !actual_hash.eq_ignore_ascii_case(expected_hash) {
            return Err(format!("baseline payload verification failed: {file}"));
        }
        let mut archive =
            zip::ZipArchive::new(std::fs::File::open(&bundle_path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("invalid baseline ZIP {file}: {e}"))?;
        let mut manifest_bytes = Vec::new();
        archive
            .by_name("bundle.json")
            .map_err(|e| format!("baseline {file} missing bundle.json: {e}"))?
            .read_to_end(&mut manifest_bytes)
            .map_err(|e| e.to_string())?;
        parse_bundle_manifest(&manifest_bytes).map_err(|e| e.to_string())?;
    }
    println!("{{\"ok\":true,\"state\":\"system-ready\"}}");
    Ok(())
}

fn unpack(bundle: &Path, target: &Path) -> Outcome {
    let canonical = initialize_install_root(target).map_err(|error| error.to_string())?;
    let _lock = lock_install_root(&canonical).map_err(|error| error.to_string())?;
    let manifest =
        qaqh_update::read_bundle_manifest_zip(bundle).map_err(|error| error.to_string())?;
    if manifest.kind == "full" {
        return Err("full bundles cannot be installed into the user component root".into());
    }
    let operation_id = format!(
        "maint-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or_default()
    );
    let manifest =
        apply_bundle_zip(bundle, &canonical, &operation_id).map_err(|error| error.to_string())?;
    commit_bundle_state(&canonical, &manifest, &operation_id).map_err(|error| error.to_string())?;
    println!(
        "unpack: {} ({}) applied, {} files -> {}",
        manifest.kind,
        manifest.build_id,
        manifest.files.len(),
        target.display()
    );
    Ok(())
}
