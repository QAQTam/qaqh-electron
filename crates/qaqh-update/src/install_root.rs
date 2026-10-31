use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{Result, UpdateError, validate_relative_path};

pub const INSTALL_ROOT_MARKER: &str = ".deepx-install-root.json";
pub const MAINTENANCE_LOCK: &str = "maintenance.lock";

pub struct InstallRootLock {
    _file: File,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallRootMarker {
    format_version: u32,
    product: String,
    canonical_root: String,
    root_id: String,
}

pub fn initialize_install_root(root: &Path) -> Result<PathBuf> {
    let canonical = prepare_user_root(root, true)?;
    let _guard = lock_root_directory(&canonical)?;
    if canonical.join(INSTALL_ROOT_MARKER).exists() {
        return verify_install_root(&canonical);
    }
    ensure_root_empty_except_lock(&canonical)?;
    write_marker(&canonical)?;
    drop(_guard);
    verify_install_root(&canonical)
}

fn write_marker(canonical: &Path) -> Result<()> {
    let canonical_root = normalized_root_text(canonical);
    let marker = InstallRootMarker {
        format_version: 1,
        product: "QAQ-Harness".into(),
        root_id: root_id(&canonical_root),
        canonical_root,
    };
    let marker_path = canonical.join(INSTALL_ROOT_MARKER);
    let temporary = canonical.join(".deepx-install-root.json.qaqh-new");
    let mut marker_options = OpenOptions::new();
    marker_options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        marker_options.mode(0o600);
    }
    let mut file = marker_options.open(&temporary)?;
    use std::io::Write;
    file.write_all(&serde_json::to_vec_pretty(&marker)?)?;
    file.sync_all()?;
    fs::rename(&temporary, &marker_path)?;
    File::open(canonical)?.sync_all()?;
    Ok(())
}

pub fn verify_install_root(root: &Path) -> Result<PathBuf> {
    if root.as_os_str().is_empty() {
        return Err(UpdateError("install root is empty".into()));
    }
    reject_root_path_symlink_components(root)?;
    let canonical = fs::canonicalize(root).map_err(|error| {
        UpdateError(format!(
            "canonicalize install root '{}': {error}",
            root.display()
        ))
    })?;
    if canonical.parent().is_none() {
        return Err(UpdateError(
            "filesystem root cannot be an install root".into(),
        ));
    }
    reject_reparse_point(&canonical)?;
    validate_user_root_location(&canonical)?;
    let root_metadata = fs::metadata(&canonical)?;
    ensure_current_user_owner(&root_metadata)?;

    let marker_path = canonical.join(INSTALL_ROOT_MARKER);
    reject_reparse_point(&marker_path)?;
    let marker_metadata = fs::symlink_metadata(&marker_path)?;
    if !marker_metadata.is_file() {
        return Err(UpdateError(
            "install root marker is not a regular file".into(),
        ));
    }
    ensure_current_user_owner(&marker_metadata)?;
    let marker: InstallRootMarker =
        serde_json::from_slice(&fs::read(&marker_path).map_err(|error| {
            UpdateError(format!(
                "read install root marker '{}': {error}",
                marker_path.display()
            ))
        })?)
        .map_err(|error| UpdateError(format!("parse install root marker: {error}")))?;
    let canonical_root = normalized_root_text(&canonical);
    if marker.format_version != 1
        || marker.product != "QAQ-Harness"
        || marker.canonical_root != canonical_root
        || marker.root_id != root_id(&canonical_root)
    {
        return Err(UpdateError(format!(
            "install root marker does not match '{}'",
            canonical.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if root_metadata.mode() & 0o022 != 0 {
            fs::set_permissions(
                &canonical,
                fs::Permissions::from_mode((root_metadata.mode() & 0o777) & !0o022),
            )
            .map_err(|error| {
                UpdateError(format!(
                    "tighten install root permissions '{}': {error}",
                    canonical.display()
                ))
            })?;
        }
        if fs::metadata(&canonical)?.mode() & 0o022 != 0 {
            return Err(UpdateError(
                "install root must not be group/world writable".into(),
            ));
        }
    }
    Ok(canonical)
}

pub fn lock_install_root(root: &Path) -> Result<InstallRootLock> {
    reject_root_if_running_as_root()?;
    let canonical = verify_install_root(root)?;
    let guard = lock_root_directory(&canonical)?;
    verify_install_root(&canonical)?;
    Ok(guard)
}

fn lock_root_directory(root: &Path) -> Result<InstallRootLock> {
    let path = root.join(MAINTENANCE_LOCK);
    reject_reparse_point_if_present(&path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(&path)?;
    let metadata = file.metadata().map_err(UpdateError::from)?;
    if !metadata.is_file() {
        return Err(UpdateError("maintenance lock is not a regular file".into()));
    }
    ensure_current_user_owner(&metadata)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(UpdateError(
                "maintenance lock permissions must be 0600".into(),
            ));
        }
    }
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: flock only observes the live descriptor; File owns it until
        // InstallRootLock is dropped, which releases the advisory lock.
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == ErrorKind::WouldBlock {
                return Err(UpdateError("maintenance lock busy".into()));
            }
            return Err(UpdateError(format!("acquire maintenance lock: {error}")));
        }
    }
    #[cfg(not(unix))]
    {
        return Err(UpdateError(
            "OS advisory install lock is unsupported on this platform".into(),
        ));
    }
    Ok(InstallRootLock { _file: file })
}

fn prepare_user_root(root: &Path, reject_root: bool) -> Result<PathBuf> {
    if root.as_os_str().is_empty() {
        return Err(UpdateError("install root is empty".into()));
    }
    reject_root_path_symlink_components(root)?;
    if reject_root {
        reject_root_if_running_as_root()?;
    }
    let absolute = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()?.join(root)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::ParentDir => {
                return Err(UpdateError(
                    "parent traversal is not allowed in install root".into(),
                ));
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    let absolute = normalized;
    reject_root_path_symlink_components(&absolute)?;
    let mut ancestor = absolute.clone();
    let mut missing = Vec::new();
    while !ancestor.exists() {
        let name = ancestor
            .file_name()
            .ok_or_else(|| UpdateError("install root has no existing ancestor".into()))?
            .to_os_string();
        missing.push(name);
        ancestor = ancestor
            .parent()
            .ok_or_else(|| UpdateError("install root has no existing ancestor".into()))?
            .to_path_buf();
    }
    let mut candidate = fs::canonicalize(&ancestor)?;
    for component in missing.iter().rev() {
        candidate.push(component);
    }
    validate_user_root_location(&candidate)?;
    if !absolute.exists() {
        let parent = absolute
            .parent()
            .ok_or_else(|| UpdateError("install root has no parent".into()))?;
        fs::create_dir_all(parent)?;
        reject_root_path_symlink_components(&absolute)?;
        fs::create_dir(&absolute)?;
    }
    reject_reparse_point(&absolute)?;
    let canonical = fs::canonicalize(&absolute)?;
    validate_user_root_location(&canonical)?;
    let metadata = fs::metadata(&canonical)?;
    ensure_current_user_owner(&metadata)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.mode() & 0o022 != 0 {
            fs::set_permissions(
                &canonical,
                fs::Permissions::from_mode((metadata.mode() & 0o777) & !0o022),
            )?;
        }
    }
    Ok(canonical)
}

fn validate_user_root_location(root: &Path) -> Result<()> {
    if root.parent().is_none() {
        return Err(UpdateError(
            "filesystem root cannot be an install root".into(),
        ));
    }
    let mut protected = Vec::new();
    for variable in ["HOME", "XDG_DATA_HOME"] {
        if let Some(value) = std::env::var_os(variable)
            && !value.is_empty()
        {
            let path = PathBuf::from(value);
            let canonical = fs::canonicalize(&path).unwrap_or(path);
            protected.push(canonical);
        }
    }
    if std::env::var_os("XDG_DATA_HOME").is_none()
        && let Some(home) = std::env::var_os("HOME")
    {
        protected.push(PathBuf::from(home).join(".local/share"));
    }
    for path in protected {
        if root == path || path.starts_with(root) {
            return Err(UpdateError(format!(
                "install root is a protected location or its ancestor: {}",
                root.display()
            )));
        }
    }
    Ok(())
}

fn ensure_current_user_owner(metadata: &fs::Metadata) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let uid = unsafe { libc::geteuid() };
        if metadata.uid() != uid {
            return Err(UpdateError(
                "install root is not owned by the current user".into(),
            ));
        }
    }
    let _ = metadata;
    Ok(())
}

fn reject_root_if_running_as_root() -> Result<()> {
    #[cfg(unix)]
    if unsafe { libc::geteuid() } == 0 {
        return Err(UpdateError(
            "user install operations must not run as root".into(),
        ));
    }
    Ok(())
}

fn ensure_root_empty_except_lock(root: &Path) -> Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        if name != MAINTENANCE_LOCK && name != INSTALL_ROOT_MARKER {
            return Err(UpdateError(format!(
                "refusing to adopt non-empty unregistered install root '{}'",
                root.display()
            )));
        }
        if name == INSTALL_ROOT_MARKER {
            return Err(UpdateError("invalid existing install root marker".into()));
        }
    }
    Ok(())
}

fn reject_root_path_symlink_components(path: &Path) -> Result<()> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(UpdateError(format!(
                    "symbolic link in install root path: {}",
                    current.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

pub fn safe_join_under_root(root: &Path, relative: &str) -> Result<PathBuf> {
    validate_relative_path(relative)?;
    let first = relative.split('/').next().unwrap_or_default();
    if matches!(
        first,
        INSTALL_ROOT_MARKER
            | MAINTENANCE_LOCK
            | "installation.json"
            | "active.json"
            | "legal-consent.json"
            | "install-state.json"
            | "baseline-receipt.json"
            | "generations"
            | "staging"
            | "legacy"
    ) {
        return Err(UpdateError(format!(
            "bundle target uses reserved installation path: {relative}"
        )));
    }
    reject_reparse_point_if_present(root)?;

    let segments = relative.split('/').collect::<Vec<_>>();
    let mut current = root.to_path_buf();
    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        current.push(segment);
        reject_reparse_point_if_present(&current)?;
    }
    let target = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    reject_reparse_point_if_present(&target)?;
    Ok(target)
}

pub fn is_reparse_or_symlink(path: &Path) -> std::io::Result<bool> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

fn reject_reparse_point(path: &Path) -> Result<()> {
    if is_reparse_or_symlink(path).map_err(UpdateError::from)? {
        return Err(UpdateError(format!(
            "symbolic link or reparse point is not allowed: {}",
            path.display()
        )));
    }
    Ok(())
}

fn reject_reparse_point_if_present(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => reject_reparse_point(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn normalized_root_text(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    let value = if let Some(rest) = value.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else {
        value
            .strip_prefix("//?/")
            .map(str::to_owned)
            .unwrap_or(value)
    };
    if cfg!(windows) {
        value.trim_end_matches('/').to_ascii_lowercase()
    } else {
        value.trim_end_matches('/').to_string()
    }
}

fn root_id(canonical_root: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in canonical_root.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("root-{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn marker_binds_to_its_canonical_directory() {
        let root = test_root("marker");
        let install = root.join("QAQ-Harness");
        fs::create_dir_all(&install).expect("create install root");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&install, fs::Permissions::from_mode(0o700))
                .expect("restrict test root");
        }
        write_marker(&install).expect("write marker");
        assert_eq!(
            verify_install_root(&install).expect("verify marker"),
            fs::canonicalize(&install).expect("canonical install root")
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(unix)]
    #[test]
    fn legacy_readable_marker_remains_valid() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = test_root("legacy-marker");
        let install = root.join("QAQ-Harness");
        fs::create_dir_all(&install).expect("create install root");
        fs::set_permissions(&install, fs::Permissions::from_mode(0o775))
            .expect("simulate umask 0002 group-writable root permissions");
        write_marker(&install).expect("write marker");
        fs::set_permissions(
            install.join(INSTALL_ROOT_MARKER),
            fs::Permissions::from_mode(0o644),
        )
        .expect("simulate legacy marker mode");
        assert!(verify_install_root(&install).is_ok());
        assert_eq!(
            fs::metadata(&install).expect("stat tightened root").mode() & 0o022,
            0
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn copied_marker_cannot_authorize_another_directory() {
        let root = test_root("copied-marker");
        let source = root.join("QAQ-Harness-A");
        let destination = root.join("QAQ-Harness-B");
        fs::create_dir_all(&source).expect("create source install root");
        fs::create_dir_all(&destination).expect("create destination install root");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&source, fs::Permissions::from_mode(0o700))
                .expect("restrict source root");
            fs::set_permissions(&destination, fs::Permissions::from_mode(0o700))
                .expect("restrict destination root");
        }
        write_marker(&source).expect("write source marker");
        fs::copy(
            source.join(INSTALL_ROOT_MARKER),
            destination.join(INSTALL_ROOT_MARKER),
        )
        .expect("copy marker");
        assert!(verify_install_root(&destination).is_err());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn safe_join_rejects_windows_separator_and_parent_escape() {
        let root = Path::new("QAQ-Harness");
        assert!(safe_join_under_root(root, "resources/app.asar").is_ok());
        assert!(safe_join_under_root(root, "../outside").is_err());
        assert!(safe_join_under_root(root, r"resources\..\outside").is_err());
        assert!(safe_join_under_root(root, "maintenance.lock").is_err());
        assert!(safe_join_under_root(root, ".deepx-install-root.json").is_err());
        assert!(safe_join_under_root(root, "install-state.json").is_err());
    }

    #[test]
    fn maintenance_lock_rejects_a_second_writer() {
        let root = test_root("lock");
        fs::create_dir_all(&root).expect("create lock root");
        let first = lock_root_directory(&root).expect("first writer lock");
        let second = lock_root_directory(&root);
        match second {
            Err(error) => assert!(error.to_string().contains("busy")),
            Ok(_guard) => panic!("second writer unexpectedly acquired the lock"),
        }
        drop(first);
        assert!(lock_root_directory(&root).is_ok());
        fs::remove_dir_all(root).expect("remove lock root");
    }

    #[cfg(unix)]
    #[test]
    fn lock_file_must_not_be_a_symlink() {
        use std::os::unix::fs::symlink;
        let root = test_root("lock-symlink");
        fs::create_dir_all(&root).expect("create lock root");
        let external = root.join("external-lock");
        fs::write(&external, b"").expect("create external file");
        symlink(&external, root.join(MAINTENANCE_LOCK)).expect("create lock symlink");
        assert!(lock_root_directory(&root).is_err());
        fs::remove_dir_all(root).expect("remove lock root");
    }

    #[test]
    fn unknown_nonempty_root_is_not_adopted() {
        let root = test_root("unknown");
        fs::create_dir_all(&root).expect("create unknown root");
        fs::write(root.join("user-file"), b"keep").expect("create unknown content");
        assert!(ensure_root_empty_except_lock(&root).is_err());
        assert_eq!(
            fs::read(root.join("user-file")).expect("preserved"),
            b"keep"
        );
        fs::remove_dir_all(root).expect("remove unknown root");
    }

    #[cfg(unix)]
    #[test]
    fn install_root_path_rejects_symlink_components() {
        use std::os::unix::fs::symlink;
        let root = test_root("symlink");
        let actual = root.join("actual");
        let alias = root.join("alias");
        fs::create_dir_all(&actual).expect("create actual root");
        symlink(&actual, &alias).expect("create symlink");
        assert!(reject_root_path_symlink_components(&alias.join("child")).is_err());
        fs::remove_dir_all(root).expect("remove symlink root");
    }

    fn test_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "qaqh-install-root-{label}-{}-{nonce}",
            std::process::id()
        ))
    }
}
