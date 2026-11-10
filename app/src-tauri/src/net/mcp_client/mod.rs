//! The MCP client (spec §4): the app talks to MCP servers the user set up
//! (RAPID, BioModel Portal, custom ones) over streamable HTTP. Everything
//! network-side lives here in Rust so a token never reaches the webview.
//!
//! - `transport`: one HTTP exchange (POST with a JSON or SSE answer, GET
//!   resume, DELETE of a session).

pub mod transport;

#[cfg(test)]
pub mod fake;
