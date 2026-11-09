use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::{Result, UpdateError, lock_install_root, verify_install_root};

const ACTIVE_FILE: &str = "active.json";
const GENERATIONS_DIR: &str = "generations";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveState {
    pub schema_version: u32,
    pub current: Option<String>,
    pub previous: Option<String>,
    pub pending_operation: Option<PendingOperation>,
    pub blocked_baseline: Option<String>,
}

impl Default for ActiveState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            current: None,
            previous: None,
            pending_operation: None,
            blocked_baseline: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingOperation {
    pub operation_id: String,
    pub old: Option<String>,
    pub new: String,
    pub phase: SnapshotPhase,
    pub trigger: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotPhase {
    Prepared,
    Booting,
}

pub fn activate_snapshot(root: &Path, generation_id: &str, trigger: &str) -> Result<ActiveState> {
    let canonical = verify_install_root(root)?;
    let _lock = lock_install_root(&canonical)?;
    activate_snapshot_locked(&canonical, generation_id, trigger)
}

pub fn activate_snapshot_locked(
    canonical_root: &Path,
    generation_id: &str,
    trigger: &str,
) -> Result<ActiveState> {
    validate_segment(generation_id)?;
    if trigger.trim().is_empty() {
        return Err(UpdateError("snapshot trigger is empty".into()));
    }
    let verified = verify_install_root(canonical_root)?;
    if verified != canonical_root {
        return Err(UpdateError("snapshot root must be canonical".into()));
    }
    let canonical = canonical_root;
    let generation = canonical.join(GENERATIONS_DIR).join(generation_id);
    validate_generation_path(&canonical, generation_id)?;
    if !generation.is_dir() {
        return Err(UpdateError(format!(
            "snapshot generation does not exist: {generation_id}"
        )));
    }
    let mut active = read_active(&canonical)?;
    if active.pending_operation.is_some() {
        return Err(UpdateError(
            "a snapshot operation is already pending".into(),
        ));
    }
    let old = active.current.clone();
    if old.as_deref() == Some(generation_id) {
        return Err(UpdateError("snapshot is already active".into()));
    }
    let operation_id = new_operation_id();
    active.previous = old.clone();
    active.current = Some(generation_id.to_owned());
    active.pending_operation = Some(PendingOperation {
        operation_id,
        old,
        new: generation_id.to_owned(),
        phase: SnapshotPhase::Prepared,
        trigger: trigger.to_owned(),
    });
    write_active(&canonical, &active)?;
    Ok(active)
}

/// Bootstrap calls this before loading the selected application. A prepared
/// pointer is granted one boot attempt; a pointer left booting means that
/// attempt did not confirm and is rolled back.
pub fn begin_snapshot_boot(root: &Path) -> Result<ActiveState> {
    let canonical = verify_install_root(root)?;
    let _lock = lock_install_root(&canonical)?;
    let mut active = read_active(&canonical)?;
    let Some(pending) = active.pending_operation.clone() else {
        return Ok(active);
    };
    match pending.phase {
        SnapshotPhase::Prepared => {
            if active.current.as_deref() != Some(&pending.new) {
                return Err(UpdateError(
                    "prepared snapshot does not match active pointer".into(),
                ));
            }
            active.pending_operation = Some(PendingOperation {
                phase: SnapshotPhase::Booting,
                ..pending
            });
            write_active(&canonical, &active)?;
        }
        SnapshotPhase::Booting => {
            active.current = pending.old.clone();
            active.previous = Some(pending.new);
            active.pending_operation = None;
            write_active(&canonical, &active)?;
        }
    }
    Ok(active)
}

pub fn confirm_snapshot(root: &Path, operation_id: &str) -> Result<ActiveState> {
    let canonical = verify_install_root(root)?;
    let _lock = lock_install_root(&canonical)?;
    let mut active = read_active(&canonical)?;
    let pending = active
        .pending_operation
        .clone()
        .ok_or_else(|| UpdateError("no pending snapshot operation".into()))?;
    if pending.operation_id != operation_id
        || pending.phase != SnapshotPhase::Booting
        || active.current.as_deref() != Some(&pending.new)
    {
        return Err(UpdateError(
            "snapshot confirmation does not match a booting operation".into(),
        ));
    }
    active.pending_operation = None;
    active.previous = pending.old;
    write_active(&canonical, &active)?;
    Ok(active)
}

pub fn rollback_snapshot(root: &Path, blocked_baseline: Option<&str>) -> Result<ActiveState> {
    let canonical = verify_install_root(root)?;
    let _lock = lock_install_root(&canonical)?;
    rollback_snapshot_locked(&canonical, blocked_baseline)
}

pub fn rollback_snapshot_locked(
    canonical_root: &Path,
    blocked_baseline: Option<&str>,
) -> Result<ActiveState> {
    let canonical = verify_install_root(canonical_root)?;
    if canonical != canonical_root {
        return Err(UpdateError("snapshot root must be canonical".into()));
    }
    let mut active = read_active(&canonical)?;
    if let Some(pending) = active.pending_operation.take() {
        active.current = pending.old.clone();
        active.previous = Some(pending.new);
    } else {
        let previous = active
            .previous
            .clone()
            .ok_or_else(|| UpdateError("no previous snapshot to roll back to".into()))?;
        active.previous = active.current.clone();
        active.current = Some(previous);
    }
    active.blocked_baseline = blocked_baseline.map(str::to_owned);
    write_active(&canonical, &active)?;
    Ok(active)
}

pub fn load_active_state(root: &Path) -> Result<ActiveState> {
    let canonical = verify_install_root(root)?;
    let active = read_active(&canonical)?;
    validate_active_generations(&canonical, &active)?;
    Ok(active)
}

pub fn current_snapshot_path(root: &Path) -> Result<Option<PathBuf>> {
    let canonical = verify_install_root(root)?;
    let active = read_active(&canonical)?;
    validate_active_generations(&canonical, &active)?;
    let Some(current) = active.current else {
        return Ok(None);
    };
    let generation = validate_generation_path(&canonical, &current)?;
    if !generation.is_dir() {
        return Err(UpdateError(format!(
            "active generation is missing: {current}"
        )));
    }
    Ok(Some(generation))
}

fn validate_active_generations(root: &Path, active: &ActiveState) -> Result<()> {
    for id in [active.current.as_deref(), active.previous.as_deref()]
        .into_iter()
        .flatten()
    {
        let generation = validate_generation_path(root, id)?;
        if !generation.is_dir() {
            return Err(UpdateError(format!(
                "referenced generation is missing: {id}"
            )));
        }
    }
    Ok(())
}

fn read_active(root: &Path) -> Result<ActiveState> {
    let path = root.join(ACTIVE_FILE);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(UpdateError("active state must be a regular file".into()));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.uid() != unsafe { libc::geteuid() } {
                    return Err(UpdateError(
                        "active state is not owned by current user".into(),
                    ));
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ActiveState::default());
        }
        Err(error) => return Err(error.into()),
    }
    match fs::read(&path) {
        Ok(bytes) => {
            let active: ActiveState = serde_json::from_slice(&bytes)
                .map_err(|error| UpdateError(format!("parse active state: {error}")))?;
            if active.schema_version != 1 {
                return Err(UpdateError("unsupported active state schema".into()));
            }
            for id in [active.current.as_deref(), active.previous.as_deref()]
                .into_iter()
                .flatten()
            {
                validate_segment(id)?;
            }
            if let Some(pending) = &active.pending_operation {
                validate_segment(&pending.new)?;
                if let Some(old) = &pending.old {
                    validate_segment(old)?;
                }
            }
            Ok(active)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ActiveState::default()),
        Err(error) => Err(error.into()),
    }
}

fn write_active(root: &Path, active: &ActiveState) -> Result<()> {
    let path = root.join(ACTIVE_FILE);
    let temporary = root.join(format!(".{ACTIVE_FILE}.{}.new", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(&serde_json::to_vec_pretty(active)?)?;
    file.sync_all()?;
    fs::rename(&temporary, &path)?;
    File::open(root)?.sync_all()?;
    Ok(())
}

fn validate_generation_path(root: &Path, generation_id: &str) -> Result<PathBuf> {
    validate_segment(generation_id)?;
    let generations = root.join(GENERATIONS_DIR);
    match fs::symlink_metadata(&generations) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(UpdateError(
                "generations path must be a real directory".into(),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let generation = generations.join(generation_id);
    match fs::symlink_metadata(&generation) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(UpdateError("generation must be a real directory".into()));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(generation)
}

fn validate_segment(value: &str) -> Result<()> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(UpdateError(format!("invalid snapshot ID: {value}")));
    }
    Ok(())
}

fn new_operation_id() -> String {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("op-{}-{time}", std::process::id())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::initialize_install_root;

    fn root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "qaqh-snapshot-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn install_root(label: &str) -> PathBuf {
        let base = root(label);
        let install = base.join("install");
        fs::create_dir_all(&install).expect("create install root");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&install, fs::Permissions::from_mode(0o700))
                .expect("restrict install root");
        }
        initialize_install_root(&install).expect("initialize install root");
        install
    }

    fn generation(root: &Path, id: &str) {
        fs::create_dir_all(root.join(GENERATIONS_DIR).join(id)).expect("create generation");
    }

    // 快照世代(generations + 链接切换)目前只被 Linux 维护链路使用;NSIS 平根
    // 更新走 apply-staged 的 in-place 分支。Windows 上 symlink 创建需要特权,
    // 这些用例在 Unix 机器上才有意义。
    #[cfg(unix)]
    #[test]
    fn prepared_operation_gets_one_boot_then_unconfirmed_boot_rolls_back() {
        let install = install_root("pending-rollback");
        generation(&install, "old");
        generation(&install, "new");
        activate_snapshot(&install, "old", "install").expect("activate old");
        let old = begin_snapshot_boot(&install).expect("begin old boot");
        let operation_id = old
            .pending_operation
            .as_ref()
            .expect("prepared operation")
            .operation_id
            .clone();
        confirm_snapshot(&install, &operation_id).expect("confirm old");

        activate_snapshot(&install, "new", "update").expect("activate new");
        let prepared = begin_snapshot_boot(&install).expect("begin prepared boot");
        assert_eq!(
            prepared
                .pending_operation
                .as_ref()
                .map(|pending| pending.phase),
            Some(SnapshotPhase::Booting)
        );
        let recovered = begin_snapshot_boot(&install).expect("recover crashed boot");
        assert_eq!(recovered.current.as_deref(), Some("old"));
        assert_eq!(recovered.pending_operation, None);
        assert_eq!(recovered.previous.as_deref(), Some("new"));
        fs::remove_dir_all(install.parent().expect("test parent")).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn confirmation_requires_matching_booting_operation() {
        let install = install_root("confirm");
        generation(&install, "one");
        let active = activate_snapshot(&install, "one", "install").expect("activate");
        let id = active
            .pending_operation
            .as_ref()
            .expect("pending")
            .operation_id
            .clone();
        assert!(confirm_snapshot(&install, &id).is_err());
        begin_snapshot_boot(&install).expect("begin");
        let confirmed = confirm_snapshot(&install, &id).expect("confirm");
        assert!(confirmed.pending_operation.is_none());
        assert_eq!(confirmed.current.as_deref(), Some("one"));
        fs::remove_dir_all(install.parent().expect("test parent")).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn generation_id_and_symlink_are_rejected() {
        let install = install_root("invalid-generation");
        assert!(activate_snapshot(&install, "../outside", "install").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            fs::create_dir_all(install.join(GENERATIONS_DIR)).expect("create generations");
            symlink(".", install.join(GENERATIONS_DIR).join("alias")).expect("link generation");
            assert!(activate_snapshot(&install, "alias", "install").is_err());
        }
        fs::remove_dir_all(install.parent().expect("test parent")).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn confirmed_snapshot_can_be_manually_rolled_back() {
        let install = install_root("manual-rollback");
        generation(&install, "old");
        generation(&install, "new");
        let first = activate_snapshot(&install, "old", "install").expect("activate old");
        begin_snapshot_boot(&install).expect("begin old");
        confirm_snapshot(
            &install,
            &first.pending_operation.expect("old pending").operation_id,
        )
        .expect("confirm old");
        let next = activate_snapshot(&install, "new", "update").expect("activate new");
        begin_snapshot_boot(&install).expect("begin new");
        confirm_snapshot(
            &install,
            &next.pending_operation.expect("new pending").operation_id,
        )
        .expect("confirm new");
        let rolled_back = rollback_snapshot(&install, None).expect("manual rollback");
        assert_eq!(rolled_back.current.as_deref(), Some("old"));
        assert_eq!(rolled_back.previous.as_deref(), Some("new"));
        fs::remove_dir_all(install.parent().expect("test parent")).expect("cleanup");
    }
}
