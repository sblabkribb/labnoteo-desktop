//! The floating assistant's Rust side (assistant spec §6.1).
//!
//! Everything here lives under `<app_local_data_dir>/assistant/`, never in a
//! vault: chat history per experiment folder (`history`). Later tasks add the
//! per-PC `assistant.json` (search and gallery URLs).

pub mod history;

use std::path::PathBuf;

use serde::Serialize;

/// `<app_local_data_dir>/assistant`, managed so tests can point it elsewhere.
pub struct AssistantDirs(pub PathBuf);

/// What `AssistantError` puts in `kind` (pinned in `tests/ipc-assistant-errors.json`).
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AssistantErrorKind {
    /// No vault is open.
    NoVault,
    /// The folder is not an existing folder inside the open vault.
    BadFolder,
    /// The history document is over a cap (messages, bytes, label length).
    TooLarge,
    /// The token was read under another vault (or folder): nothing is written.
    VaultChanged,
    /// Disk errors, a malformed document, a store inside the vault.
    Io,
}

/// `{kind, message}`, the same shape as the other error types.
#[derive(Serialize, Debug)]
pub struct AssistantError {
    pub kind: AssistantErrorKind,
    pub message: String,
}

impl AssistantError {
    pub fn new(kind: AssistantErrorKind, message: impl Into<String>) -> AssistantError {
        AssistantError { kind, message: message.into() }
    }
}

impl std::fmt::Display for AssistantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AssistantError {}
