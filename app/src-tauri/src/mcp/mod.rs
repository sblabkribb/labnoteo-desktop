//! The MCP server (SP7 Part C): a loopback Streamable-HTTP endpoint that lets
//! external MCP clients call the lab-note tools, with every write approved by
//! the user in the app.
//!
//! The bearer token lives only in Windows Credential Manager (C5, USER RULE):
//! it never crosses IPC, an event, a log or an error. The webview learns only
//! a `set` flag and an `epoch` counter.

pub mod bridge;
pub mod clipboard;
pub mod rpc;
pub mod server;
pub mod token;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use serde::Serialize;

pub use bridge::{drain_pending, page_load_started, McpStatus, ReplyIn};
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
/// `running` is the live server, if any; `pending` holds the `tools/call`s
/// waiting for the webview (C3).
#[derive(Default)]
pub struct McpState {
    pub(crate) token: Arc<RwLock<String>>,
    pub(crate) running: Mutex<Option<bridge::Running>>,
    pub(crate) pending: Arc<Mutex<HashMap<String, bridge::Pending>>>,
}
