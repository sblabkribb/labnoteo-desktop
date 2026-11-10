//! Uploading an experiment folder to GitHub (spec 2026-11-10-github-upload).
//!
//! Everything here is Rust-only state: the webview reaches it through the
//! `github_*` commands, never through `integration_state_*`.

pub mod exif;
#[cfg(test)]
pub mod fixture_tools;
pub mod journal;
pub mod links;
pub mod overlay;
pub mod plan;
pub mod push;
pub mod repo;
pub mod scan;
#[cfg(test)]
pub mod smart_http_stub;
pub mod state;
pub mod upload;
pub mod walk;
