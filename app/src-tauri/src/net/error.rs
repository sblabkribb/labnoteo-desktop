//! The error every network command rejects with. It serializes as
//! `{kind, message, status?, body?, location?}`, the same shape as `FsError`,
//! and its `kind` strings are pinned in `tests/ipc-net-errors.json`.
//!
//! No text that left or reached the network is kept without redaction: every
//! constructor that takes response text also takes the key in use, and the
//! key is replaced by `***` on the full text before any cut.

use serde::Serialize;

/// How many chars of a non-2xx response body an error keeps.
pub const BODY_EXCERPT: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NetErrorKind {
    /// No vault, or the slot's URL is empty or invalid.
    NotConfigured,
    KeyMissing,
    InvalidUrl,
    ForbiddenPath,
    /// Connect or DNS failure.
    Offline,
    Timeout,
    Tls,
    /// A 3xx; `location` holds the target origin.
    Redirect,
    /// A non-2xx answer, with `status` and the start of the redacted `body`.
    Status,
    NotJson,
    TooLarge,
    Cancelled,
    Keychain,
    BadInput,
    /// An SSE `event: error` from bfworkflow.
    Remote,
    /// An SSE stream that ended without `event: result`.
    NoResult,
    /// A key would go to a non-loopback `http://` origin that is not allowed.
    Insecure,
    /// A local file failure outside the vault (the scan folder, SP7 B4).
    Io,
    /// An MCP server answered 401 or 403: the token is missing, wrong or expired.
    McpAuth,
    /// An MCP server broke the protocol (content type, session id, version, no answer with our id).
    McpProtocol,
    /// An MCP server speaks only a newer protocol than this client (`-32022` / `-32020` to a POST).
    McpModernOnly,
    /// A JSON-RPC error answer to `tools/call`; the message is server text (redacted, capped).
    McpToolError,
    /// A SearXNG instance answered 403: its `search.formats` does not list `json`.
    JsonDisabled,
    /// A SearXNG instance answered 429.
    RateLimited,
    /// A SearXNG search came back empty because its engines did not answer.
    EnginesDown,
    /// `fetch_page` refused the address: not http/https, userinfo, a port off
    /// the allowlist, or a loopback/private/link-local/reserved address (on
    /// the first request or on any redirect hop).
    Blocked,
    /// `fetch_page` got a `Content-Type` other than HTML or plain text.
    UnsupportedType,
}

/// `Debug` is safe: every constructor that takes response text also takes the
/// secret and redacts it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetError {
    pub kind: NetErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Only on `redirect`: the origin (`scheme://host[:port]`) of `Location`,
    /// never its path or query.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

/// Replaces every occurrence of a non-empty `secret` in `text` with `***`.
pub fn redact_text(text: &str, secret: Option<&str>) -> String {
    match secret {
        Some(s) if !s.is_empty() => text.replace(s, "***"),
        _ => text.to_string(),
    }
}

impl NetError {
    pub fn new(kind: NetErrorKind, message: impl Into<String>) -> NetError {
        NetError { kind, message: message.into(), status: None, body: None, location: None }
    }

    /// A non-2xx answer. The key is redacted from the **full** body first,
    /// then the first `BODY_EXCERPT` chars are kept, so a key straddling the
    /// cut never leaks a prefix.
    pub fn status(code: u16, body: &str, secret: Option<&str>) -> NetError {
        let redacted = redact_text(body, secret);
        let excerpt: String = redacted.chars().take(BODY_EXCERPT).collect();
        NetError {
            kind: NetErrorKind::Status,
            message: format!("HTTP {code}"),
            status: Some(code),
            body: Some(excerpt),
            location: None,
        }
    }

    /// A 3xx answer. `location_origin` is the origin of the `Location` header.
    pub fn redirect(location_origin: Option<String>) -> NetError {
        NetError { location: location_origin, ..NetError::new(NetErrorKind::Redirect, "redirect") }
    }

    /// Applies `redact_text` to `message` and `body`, once more before the
    /// error crosses IPC.
    pub fn redact(mut self, secret: Option<&str>) -> NetError {
        self.message = redact_text(&self.message, secret);
        self.body = self.body.map(|b| redact_text(&b, secret));
        self
    }
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for NetError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_error_keeps_2000_chars_of_body() {
        let e = NetError::status(500, &"x".repeat(5000), None);
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "status");
        assert_eq!(v["status"], 500);
        assert_eq!(v["body"].as_str().unwrap().chars().count(), 2000);
        assert_eq!(v["message"], "HTTP 500");
    }

    #[test]
    fn redact_replaces_every_occurrence() {
        let e = NetError {
            kind: NetErrorKind::Status,
            message: "bad pbk_abc".into(),
            status: Some(401),
            body: Some("pbk_abc and pbk_abc".into()),
            location: None,
        }
        .redact(Some("pbk_abc"));
        assert_eq!(e.message, "bad ***");
        assert_eq!(e.body.as_deref(), Some("*** and ***"));
    }

    #[test]
    fn redact_with_empty_secret_changes_nothing() {
        let e = NetError::new(NetErrorKind::Offline, "x").redact(Some(""));
        assert_eq!(e.message, "x");
    }

    #[test]
    fn key_straddling_the_2000_char_cut_is_fully_redacted() {
        let body = format!("{}{}{}", "x".repeat(1990), "pbk_secret_key", "y".repeat(100));
        let b = NetError::status(500, &body, Some("pbk_secret_key")).body.unwrap();
        assert!(!b.contains("pbk_"));
        assert!(b.starts_with(&format!("{}***", "x".repeat(1990))));
        assert_eq!(b.chars().count(), 2000);
    }

    #[test]
    fn redirect_serializes_location() {
        let v = serde_json::to_value(NetError::redirect(Some("https://pb.example".into()))).unwrap();
        assert_eq!(v["kind"], "redirect");
        assert_eq!(v["location"], "https://pb.example");
    }
}
