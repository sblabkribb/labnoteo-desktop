pub mod fs;
pub mod path;

use std::path::PathBuf;
use std::sync::Mutex;

/// Managed app state: the open vault's root (set by `vault_open`) and the
/// per-path lock map shared by every file command.
#[derive(Default)]
pub struct VaultState {
    root: Mutex<Option<PathBuf>>,
    pub(crate) locks: fs::PathLocks,
}

impl VaultState {
    pub fn set_root(&self, root: Option<PathBuf>) {
        *self.root.lock().unwrap_or_else(|e| e.into_inner()) = root;
    }

    pub(crate) fn root(&self) -> Result<PathBuf, fs::FsError> {
        self.root
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or(fs::FsError::NoVault)
    }
}
