//! The GitHub client (spec §7): compile-time endpoints and the allow-listed
//! REST calls in `api`. The webview never names a GitHub host, and the
//! endpoints are never a user setting.
//!
//! - `endpoints()` answers the production constants. Only a build with
//!   `cfg(test)` or the cargo feature `github-test-endpoints` reads the
//!   override env vars (P-R7), and even then only a loopback URL (or a
//!   `file://` URL for `git`) is used; anything else is ignored.

pub mod api;
pub mod auth;
pub mod repos;

pub use auth::GithubState;

use super::config::Url;
#[cfg(any(test, feature = "github-test-endpoints"))]
use super::config::is_loopback;

/// The REST API base.
pub const GITHUB_API: &str = "https://api.github.com/";
/// The web base (device flow).
pub const GITHUB_WEB: &str = "https://github.com/";
/// The base remote URLs are built on (`<git><owner>/<repo>.git`).
pub const GITHUB_GIT: &str = "https://github.com/";

/// The test override of `api` and `web` (P-R7).
pub const TEST_BASE_ENV: &str = "LABNOTEO_GITHUB_TEST_BASE";
/// The test override of `git` (P-R7).
pub const TEST_GIT_BASE_ENV: &str = "LABNOTEO_GITHUB_TEST_GIT_BASE";

/// Where the GitHub client goes. Every base ends in `/`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GithubEndpoints {
    pub api: Url,
    pub web: Url,
    pub git: Url,
}

impl GithubEndpoints {
    /// The production constants.
    pub fn production() -> GithubEndpoints {
        let parse = |s: &str| Url::parse(s).expect("a constant GitHub URL parses");
        GithubEndpoints { api: parse(GITHUB_API), web: parse(GITHUB_WEB), git: parse(GITHUB_GIT) }
    }
}

/// The endpoints the app uses: the constants, except in a test build (see the
/// module doc).
pub fn endpoints() -> GithubEndpoints {
    #[cfg(any(test, feature = "github-test-endpoints"))]
    {
        let base = std::env::var(TEST_BASE_ENV).ok();
        let git = std::env::var(TEST_GIT_BASE_ENV).ok();
        return with_overrides(endpoints_release(), base.as_deref(), git.as_deref());
    }
    #[cfg(not(any(test, feature = "github-test-endpoints")))]
    endpoints_release()
}

/// The release path of `endpoints()`: the constants, never an env var. A
/// release build calls only this; the test wrapper above starts from it.
pub fn endpoints_release() -> GithubEndpoints {
    GithubEndpoints::production()
}

/// A base URL with its path ending in `/`, no query, fragment or userinfo.
#[cfg(any(test, feature = "github-test-endpoints"))]
fn clean_base(raw: &str) -> Option<Url> {
    let mut url = Url::parse(raw.trim()).ok()?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Some(url)
}

/// A loopback `http(s)` base.
#[cfg(any(test, feature = "github-test-endpoints"))]
fn loopback_base(raw: &str) -> Option<Url> {
    clean_base(raw).filter(|u| matches!(u.scheme(), "http" | "https") && is_loopback(u))
}

/// Applies the test overrides to `ep`: `base` (loopback `http(s)` only)
/// replaces `api` and `web`, and `git` too unless `git` is given; `git`
/// (loopback `http(s)` or `file:///`) replaces `git`. Anything else is ignored.
#[cfg(any(test, feature = "github-test-endpoints"))]
pub fn with_overrides(mut ep: GithubEndpoints, base: Option<&str>, git: Option<&str>) -> GithubEndpoints {
    if let Some(b) = base.and_then(loopback_base) {
        ep.api = b.clone();
        ep.web = b.clone();
        ep.git = b;
    }
    let git = git.and_then(|g| {
        let u = clean_base(g)?;
        let file = u.scheme() == "file" && u.host_str().map_or(true, str::is_empty);
        (file || loopback_base(g).is_some()).then_some(u)
    });
    if let Some(g) = git {
        ep.git = g;
    }
    ep
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_constants() {
        let ep = GithubEndpoints::production();
        assert_eq!(ep.api.as_str(), "https://api.github.com/");
        assert_eq!(ep.web.as_str(), "https://github.com/");
        assert_eq!(ep.git.as_str(), "https://github.com/");
    }

    #[test]
    fn a_non_loopback_override_is_ignored() {
        let prod = GithubEndpoints::production();
        for bad in ["https://example.com", "http://10.0.0.1:8080/", "http://user:pw@127.0.0.1:1/", "nope", ""] {
            assert_eq!(with_overrides(prod.clone(), Some(bad), Some(bad)), prod, "{bad}");
        }
        // `file://` is only ever a git base, never the API.
        assert_eq!(with_overrides(prod.clone(), Some("file:///C:/x/"), None), prod);
        // A file URL with a host is not a local path.
        assert_eq!(with_overrides(prod.clone(), None, Some("file://server/share/")).git, prod.git);
    }

    #[test]
    fn a_loopback_override_replaces_the_bases() {
        let ep = with_overrides(GithubEndpoints::production(), Some("http://127.0.0.1:4567/gh"), None);
        assert_eq!(ep.api.as_str(), "http://127.0.0.1:4567/gh/");
        assert_eq!(ep.web.as_str(), "http://127.0.0.1:4567/gh/");
        assert_eq!(ep.git.as_str(), "http://127.0.0.1:4567/gh/");
        let ep = with_overrides(GithubEndpoints::production(), Some("http://localhost:1/"), Some("file:///C:/tmp/remotes"));
        assert_eq!(ep.api.as_str(), "http://localhost:1/");
        assert_eq!(ep.git.as_str(), "file:///C:/tmp/remotes/");
        let ep = with_overrides(GithubEndpoints::production(), None, Some("http://127.0.0.1:9/git/"));
        assert_eq!(ep.api.as_str(), GITHUB_API);
        assert_eq!(ep.git.as_str(), "http://127.0.0.1:9/git/");
    }

    /// The tests that set the override env vars hold this, so they never race.
    pub(super) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn endpoints_reads_the_env_but_only_for_loopback() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var(TEST_BASE_ENV, "https://example.com");
        std::env::set_var(TEST_GIT_BASE_ENV, "https://example.com/git/");
        assert_eq!(endpoints(), GithubEndpoints::production());
        std::env::set_var(TEST_BASE_ENV, "http://127.0.0.1:4000");
        std::env::remove_var(TEST_GIT_BASE_ENV);
        assert_eq!(endpoints().api.as_str(), "http://127.0.0.1:4000/");
        std::env::remove_var(TEST_BASE_ENV);
        assert_eq!(endpoints(), GithubEndpoints::production());
    }
}

/// Plan Task 15: a release build cannot be pointed at another GitHub, and the
/// GitHub token keeps to its own lane. Runs in the default feature set (CI).
#[cfg(all(test, not(feature = "github-test-endpoints")))]
mod release_inert {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn release_ignores_test_base() {
        let _env = tests::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var(TEST_BASE_ENV, "http://127.0.0.1:1");
        std::env::set_var(TEST_GIT_BASE_ENV, "file:///C:/x/");
        // `endpoints()` itself reads the env under `cfg(test)`; the release
        // build runs `endpoints_release()` alone.
        let ep = endpoints_release();
        std::env::remove_var(TEST_BASE_ENV);
        std::env::remove_var(TEST_GIT_BASE_ENV);
        assert_eq!(ep.api.as_str(), GITHUB_API);
        assert_eq!(ep.web.as_str(), GITHUB_WEB);
        assert_eq!(ep.git.as_str(), GITHUB_GIT);
    }

    fn src() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
    }

    fn read(rel: &str) -> String {
        std::fs::read_to_string(src().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}")).replace("\r\n", "\n")
    }

    /// The body of `enum <name> { … }` in `text` (no nested braces inside).
    fn enum_body<'a>(text: &'a str, name: &str) -> &'a str {
        let at = text.find(&format!("enum {name} {{")).unwrap_or_else(|| panic!("enum {name}"));
        let rest = &text[at..];
        let open = rest.find('{').unwrap() + 1;
        let mut depth = 1;
        for (i, c) in rest[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &rest[open..open + i];
                    }
                }
                _ => {}
            }
        }
        panic!("enum {name} is not closed")
    }

    /// Every variant name in an enum body (lines that start with an
    /// uppercase identifier, doc comments and attributes skipped).
    fn variants(body: &str) -> Vec<String> {
        body.lines()
            .map(str::trim)
            .filter(|l| l.chars().next().is_some_and(|c| c.is_ascii_uppercase()))
            .map(|l| l.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect())
            .collect()
    }

    /// The body of `fn <name>(` up to its closing brace at column 0.
    fn fn_body<'a>(text: &'a str, name: &str) -> &'a str {
        let at = text.find(&format!("fn {name}(")).unwrap_or_else(|| panic!("fn {name}"));
        let rest = &text[at..];
        &rest[..rest.find("\n}\n").unwrap_or_else(|| panic!("fn {name} is not closed"))]
    }

    #[test]
    fn state_name_has_no_github_variant() {
        let names = variants(enum_body(&read("net/store.rs"), "StateName"));
        assert!(!names.is_empty());
        assert!(names.iter().all(|v| !v.to_ascii_lowercase().contains("github")), "{names:?}");
    }

    #[test]
    fn secret_set_and_clear_refuse_the_github_slots() {
        let text = read("net/secrets.rs");
        for f in ["secret_set", "secret_clear"] {
            assert!(fn_body(&text, f).contains("refuse_github(slot)?"), "{f}");
        }
        assert!(fn_body(&text, "refuse_github").contains("slot.is_github()"));
    }

    #[test]
    fn github_call_cannot_delete_or_patch() {
        let names = variants(enum_body(&read("net/github/api.rs"), "GithubCall"));
        assert!(names.contains(&"CreateUserRepo".to_string()), "{names:?}");
        for v in &names {
            let l = v.to_ascii_lowercase();
            assert!(!l.contains("delete") && !l.contains("patch"), "{v}");
        }
    }

    /// Every `.rs` file under `dir`.
    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                rust_files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }

    #[test]
    fn no_force_refspec_literal() {
        // Built at run time so this file does not match itself.
        let needle = format!("\"{}refs", '+');
        let mut files = Vec::new();
        rust_files(&src(), &mut files);
        assert!(files.len() > 10);
        let hits: Vec<_> = files
            .iter()
            .filter(|p| std::fs::read_to_string(p).unwrap().contains(&needle))
            .map(|p| p.display().to_string())
            .collect();
        assert!(hits.is_empty(), "force refspec in {hits:?}");
    }
}
