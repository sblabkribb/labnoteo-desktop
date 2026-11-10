//! Uploading an experiment folder to GitHub (spec 2026-11-10-github-upload).
//!
//! Everything here is Rust-only state: the webview reaches it through the
//! `github_*` commands, never through `integration_state_*`.

pub mod state;
pub mod walk;
