//! The MCP server (SP7 Part C): a loopback Streamable-HTTP endpoint that lets
//! external MCP clients call the lab-note tools, with every write approved by
//! the user in the app.
//!
//! The bearer token lives only in Windows Credential Manager (C5, USER RULE):
//! it never crosses IPC, an event, a log or an error. The webview learns only
//! a `set` flag and an `epoch` counter.

pub mod clipboard;
pub mod token;

use std::sync::{Arc, RwLock};

use serde::Serialize;

pub use clipboard::{ArboardClipboard, ClipState, Clipboard, FakeClipboard};
pub use token::{ensure_token, new_token, regenerate, token_status, TokenStatus, MCP_ACCOUNT};

/// What an MCP command rejects with. The `kind` strings are pinned in
/// `tests/ipc-mcp-errors.json`.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum McpErrorKind {
    PortInUse,
    Keychain,
    BadInput,
    Clipboard,
    Io,
    NotRunning,
}

/// `{kind, message}`, the same shape as the other error types. No constructor
/// takes the token, and no message ever holds it.
#[derive(Serialize, Debug)]
pub struct McpError {
    pub kind: McpErrorKind,
    pub message: String,
}

impl McpError {
    pub fn new(kind: McpErrorKind, message: impl Into<String>) -> McpError {
        McpError { kind, message: message.into() }
    }
}

/// The server's shared state. `token` is the in-memory copy requests are
/// compared against: empty until a token is ensured or regenerated.
#[derive(Default)]
pub struct McpState {
    pub(crate) token: Arc<RwLock<String>>,
}
