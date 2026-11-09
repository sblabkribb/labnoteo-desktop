//! Every network request the app makes goes through this module (Rust only;
//! the webview never names a host). See the SP6 plan, decisions D6-D11.

pub mod config;
pub mod error;
pub mod secrets;
pub use error::*;

#[cfg(test)]
pub mod testserver;
