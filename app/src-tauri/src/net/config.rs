//! Service URLs, read from the open vault's stored settings on every call (D8).
//!
//! The webview never names a host: every network command reads the URL for its
//! slot from `vault::settings::read_at`. PartBank and bfworkflow URLs are
//! origins only; an LLM endpoint may carry a short path for a gateway.
//! A missing key falls back to the plugin's default (vendor `settings.ts`); a
//! present but invalid URL is `None`, never the default, so a typo is never
//! silently replaced by another server.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use super::error::{NetError, NetErrorKind};

pub type Url = reqwest::Url;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum PbConnection {
    Desktop,
    Web,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum LlmKind {
    None,
    Ollama,
    Openai,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum BfwConnection {
    Server,
    Desktop,
}

pub const DEFAULT_PARTBANK_DESKTOP: &str = "http://127.0.0.1:47830";
pub const DEFAULT_PARTBANK_WEB: &str = "https://partbank.kbiofoundry.kr";
pub const DEFAULT_LLM_OLLAMA: &str = "http://localhost:11434";
pub const DEFAULT_LLM_OPENAI: &str = "https://api.openai.com";
pub const DEFAULT_BFW_URL: &str = "https://workflow.kbiofoundry.kr";
/// The GitHub OAuth App client ID built in: empty until the maintainer
/// registers the app. The app-wide setting and the build's
/// `LABNOTEO_GITHUB_CLIENT_ID` come first (`gitsync::state::github_client_id`).
pub const DEFAULT_GITHUB_CLIENT_ID: &str = "";

/// Longest path an LLM endpoint may carry (after the leading `/`).
const MAX_LLM_PATH: usize = 64;

#[derive(Clone, Debug, PartialEq)]
pub struct ServiceConfig {
    pub partbank_desktop: Option<Url>,
    pub partbank_web: Option<Url>,
    pub llm_provider: LlmKind,
    pub llm_ollama: Option<Url>,
    pub llm_openai: Option<Url>,
    pub bfw_url: Option<Url>,
    pub bfw_connection: BfwConnection,
    /// `allowHttpOrigins` entries that are `http://` origins, normalized by `origin`.
    pub allow_http: Vec<String>,
    /// `githubReadmeOverlay`: write a GitHub front-page README into the
    /// upload (never into the vault). On unless the setting is `false`.
    pub github_readme_overlay: bool,
}

/// A string setting: missing or `null` gives `default`, anything else is
/// parsed (a non-string or invalid value gives `None`).
fn url_setting(settings: &Value, key: &str, default: &str, parse: fn(&str) -> Option<Url>) -> Option<Url> {
    match settings.get(key) {
        None | Some(Value::Null) => parse(default),
        Some(Value::String(s)) => parse(s),
        Some(_) => None,
    }
}

impl ServiceConfig {
    /// Reads the frontend's settings JSON. Text that is not a JSON object
    /// counts as empty settings, so every key takes its default.
    pub fn from_settings_json(json: &str) -> ServiceConfig {
        let settings = match serde_json::from_str::<Value>(json) {
            Ok(v @ Value::Object(_)) => v,
            _ => Value::Object(Default::default()),
        };
        let llm_provider = match settings.get("llmProvider").and_then(Value::as_str) {
            Some("ollama") => LlmKind::Ollama,
            Some("openai") => LlmKind::Openai,
            _ => LlmKind::None,
        };
        let bfw_connection = match settings.get("bfwConnection").and_then(Value::as_str) {
            Some("desktop") => BfwConnection::Desktop,
            _ => BfwConnection::Server,
        };
        let mut allow_http: Vec<String> = Vec::new();
        if let Some(entries) = settings.get("allowHttpOrigins").and_then(Value::as_array) {
            for entry in entries.iter().filter_map(Value::as_str) {
                if let Some(url) = parse_origin_url(entry).filter(|u| u.scheme() == "http") {
                    let o = origin(&url);
                    if !allow_http.contains(&o) {
                        allow_http.push(o);
                    }
                }
            }
        }
        ServiceConfig {
            partbank_desktop: url_setting(&settings, "partbankDesktopUrl", DEFAULT_PARTBANK_DESKTOP, parse_origin_url),
            partbank_web: url_setting(&settings, "partbankWebUrl", DEFAULT_PARTBANK_WEB, parse_origin_url),
            llm_provider,
            llm_ollama: url_setting(&settings, "llmEndpointOllama", DEFAULT_LLM_OLLAMA, parse_llm_endpoint),
            llm_openai: url_setting(&settings, "llmEndpointOpenai", DEFAULT_LLM_OPENAI, parse_llm_endpoint),
            bfw_url: url_setting(&settings, "bfwUrl", DEFAULT_BFW_URL, parse_origin_url),
            bfw_connection,
            allow_http,
            github_readme_overlay: settings.get("githubReadmeOverlay").and_then(Value::as_bool).unwrap_or(true),
        }
    }

    /// The open vault's stored settings (defaults when none are stored).
    /// With no vault open, `notConfigured`.
    pub fn load(settings_file: &Path, root: Option<&Path>) -> Result<ServiceConfig, NetError> {
        let root = root.ok_or_else(|| NetError::new(NetErrorKind::NotConfigured, "no vault is open"))?;
        let json = crate::vault::settings::read_at(settings_file, root).unwrap_or_else(|| "{}".to_string());
        Ok(ServiceConfig::from_settings_json(&json))
    }
}

/// An `http`/`https` URL with a host and no userinfo, query or fragment. The
/// trailing `/` of a path is trimmed (the root path stays `/`).
pub fn parse_service_url(raw: &str) -> Option<Url> {
    let mut url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if url.host_str().map_or(true, str::is_empty) {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let trimmed = url.path().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        url.set_path("/");
    } else if trimmed != url.path() {
        url.set_path(&trimmed);
    }
    Some(url)
}

/// `parse_service_url` with no path beyond `/`: every PartBank and bfworkflow URL (D8).
pub fn parse_origin_url(raw: &str) -> Option<Url> {
    parse_service_url(raw).filter(|u| u.path().is_empty() || u.path() == "/")
}

enum Host<'a> {
    Domain(&'a str),
    Ip(IpAddr),
}

/// The URL's host as a domain or an IP address (`[::1]` without brackets).
fn host_of(url: &Url) -> Option<Host<'_>> {
    let host = url.host_str()?;
    let bare = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    Some(match bare.parse::<IpAddr>() {
        Ok(ip) => Host::Ip(ip),
        Err(_) => Host::Domain(host),
    })
}

/// `localhost`, an address in `127.0.0.0/8`, or `[::1]`.
pub fn is_loopback(url: &Url) -> bool {
    match host_of(url) {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ip(IpAddr::V4(a))) => a.is_loopback(),
        Some(Host::Ip(IpAddr::V6(a))) => a == Ipv6Addr::LOCALHOST,
        None => false,
    }
}

/// An LLM endpoint as typed in settings. A missing scheme becomes `http://` for
/// a loopback host and `https://` otherwise (D8), so a bare `api.openai.com`
/// never goes out in clear text. The path is at most 64 chars of
/// `[A-Za-z0-9._~/-]`.
pub fn parse_llm_endpoint(raw: &str) -> Option<Url> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let url = if raw.contains("://") {
        parse_service_url(raw)?
    } else {
        let plain = parse_service_url(&format!("http://{raw}"))?;
        if is_loopback(&plain) {
            plain
        } else {
            parse_service_url(&format!("https://{raw}"))?
        }
    };
    let path = url.path().strip_prefix('/').unwrap_or(url.path());
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '/' | '-');
    if path.chars().count() > MAX_LLM_PATH || !path.chars().all(allowed) {
        return None;
    }
    Some(url)
}

/// `base` without its trailing `/`, plus `path`, appended as a string like the
/// vendor `joinUrl`. Never `Url::join`, which would drop a base path such as
/// `/openai`. `path` comes from a fixed allow-list, so the result parses; if it
/// ever did not, `base` is returned unchanged.
pub fn join_path(base: &Url, path: &str) -> Url {
    let joined = format!("{}{}", base.as_str().trim_end_matches('/'), path);
    Url::parse(&joined).unwrap_or_else(|_| base.clone())
}

/// Lowercase `scheme://host[:port]`, without the scheme's default port.
pub fn origin(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    let text = match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
        None => format!("{}://{}", url.scheme(), host),
    };
    text.to_lowercase()
}

/// The bfworkflow desktop app's base URL from its `runtime.json`
/// (`{schemaVersion:1, baseUrl, desktop:true}`). Only a loopback `http` origin
/// with an explicit port is accepted: `127.0.0.1`, `localhost` or `[::1]`.
pub fn bfw_desktop_base(runtime_json: &Path) -> Option<Url> {
    let text = std::fs::read_to_string(runtime_json).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    if value.get("desktop").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let url = parse_origin_url(value.get("baseUrl")?.as_str()?)?;
    if url.scheme() != "http" || url.port().is_none() {
        return None;
    }
    let host_ok = match host_of(&url) {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ip(IpAddr::V4(a))) => a == Ipv4Addr::LOCALHOST,
        Some(Host::Ip(IpAddr::V6(a))) => a == Ipv6Addr::LOCALHOST,
        None => false,
    };
    host_ok.then_some(url)
}

/// `%USERPROFILE%\.bfworkflow\runtime.json`, or `None` without a profile dir.
pub fn bfw_runtime_path() -> Option<PathBuf> {
    let profile = std::env::var_os("USERPROFILE").filter(|p| !p.is_empty())?;
    Some(PathBuf::from(profile).join(".bfworkflow").join("runtime.json"))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// A fresh scratch dir under the system temp dir (the caller removes it).
    pub fn scratch_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "labnoteo-net-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Writes `json` as the settings of the vault `<dir>/vault` exactly as the
    /// app does (`vault::settings::write_at`), and returns
    /// `(settings_file, vault_root)` for `ServiceConfig::load`.
    pub fn settings_file(dir: &Path, json: &str) -> (PathBuf, PathBuf) {
        std::fs::create_dir_all(dir.join("vault")).unwrap();
        let root = std::fs::canonicalize(dir.join("vault")).unwrap();
        let file = dir.join("config").join("settings.json");
        crate::vault::settings::write_at(&file, &root, json).unwrap();
        (file, root)
    }

    #[test]
    fn service_url_rules() {
        assert_eq!(parse_service_url("https://partbank.kbiofoundry.kr/").unwrap().as_str(), "https://partbank.kbiofoundry.kr/");
        assert!(parse_service_url("ftp://x").is_none());
        assert!(parse_service_url("https://user:pw@x").is_none());
        assert!(parse_service_url("https://x/?a=1").is_none());
        assert!(parse_service_url("https://x/#f").is_none());
        assert!(parse_service_url("").is_none());
        assert!(parse_service_url("javascript:alert(1)").is_none());
    }

    #[test]
    fn service_url_trims_the_trailing_slash_of_a_path() {
        assert_eq!(parse_service_url("https://x/a/b/").unwrap().path(), "/a/b");
        assert!(parse_service_url("https://x/?").is_none());
        assert!(parse_service_url("https://user@x").is_none());
    }

    #[test]
    fn llm_endpoint_scheme_follows_loopback() {
        assert_eq!(origin(&parse_llm_endpoint("localhost:11434").unwrap()), "http://localhost:11434");
        assert_eq!(origin(&parse_llm_endpoint(" 127.0.0.1:11434/ ").unwrap()), "http://127.0.0.1:11434");
        assert_eq!(origin(&parse_llm_endpoint("api.openai.com").unwrap()), "https://api.openai.com");
        assert_eq!(parse_llm_endpoint("https://gw.lab.kr/openai/").unwrap().path(), "/openai");
        assert!(parse_llm_endpoint(&format!("https://gw.lab.kr/{}", "a".repeat(65))).is_none());
    }

    #[test]
    fn llm_endpoint_path_charset() {
        assert!(parse_llm_endpoint(&format!("https://gw.lab.kr/{}", "a".repeat(64))).is_some());
        assert!(parse_llm_endpoint("https://gw.lab.kr/a%20b").is_none());
        assert!(parse_llm_endpoint("https://gw.lab.kr/a b").is_none());
        assert!(parse_llm_endpoint("javascript:alert(1)").is_none());
        assert_eq!(origin(&parse_llm_endpoint("[::1]:8080").unwrap()), "http://[::1]:8080");
    }

    #[test]
    fn origin_urls_refuse_a_path() {
        assert!(parse_origin_url("https://pb.example/").is_some());
        assert!(parse_origin_url("https://pb.example/x").is_none());
    }

    #[test]
    fn join_path_keeps_the_base_path() {
        assert_eq!(join_path(&parse_llm_endpoint("https://gw.lab.kr/openai").unwrap(), "/v1/chat/completions").as_str(), "https://gw.lab.kr/openai/v1/chat/completions");
        assert_eq!(join_path(&parse_llm_endpoint("http://h:1/").unwrap(), "/api/chat").as_str(), "http://h:1/api/chat");
    }

    #[test]
    fn loopback_hosts() {
        for u in ["http://localhost:1", "http://127.0.0.1", "http://127.9.9.9:5", "http://[::1]:3"] {
            assert!(is_loopback(&parse_service_url(u).unwrap()), "{u}");
        }
        for u in ["http://10.0.0.1", "http://localhost.evil.example", "http://[::2]"] {
            assert!(!is_loopback(&parse_service_url(u).unwrap()), "{u}");
        }
    }

    #[test]
    fn allow_http_keeps_only_http_origins() {
        let c = ServiceConfig::from_settings_json(r#"{"allowHttpOrigins":["http://10.0.0.5:8000","https://x","nope"]}"#);
        assert_eq!(c.allow_http, vec!["http://10.0.0.5:8000".to_string()]);
    }

    #[test]
    fn origin_drops_default_port_and_lowercases() {
        assert_eq!(origin(&parse_service_url("HTTPS://PartBank.Example:443/x").unwrap()), "https://partbank.example");
    }

    #[test]
    fn config_reads_settings_and_falls_back_to_defaults() {
        let c = ServiceConfig::from_settings_json(r#"{"partbankWebUrl":"https://pb.example","llmProvider":"openai"}"#);
        assert_eq!(origin(c.partbank_web.as_ref().unwrap()), "https://pb.example");
        assert_eq!(origin(c.partbank_desktop.as_ref().unwrap()), "http://127.0.0.1:47830");
        assert_eq!(c.llm_provider, LlmKind::Openai);
        assert_eq!(origin(c.bfw_url.as_ref().unwrap()), "https://workflow.kbiofoundry.kr");
    }

    #[test]
    fn defaults_for_an_empty_or_unreadable_settings_object() {
        for json in ["{}", "not json"] {
            let c = ServiceConfig::from_settings_json(json);
            assert_eq!(origin(c.partbank_web.as_ref().unwrap()), "https://partbank.kbiofoundry.kr");
            assert_eq!(origin(c.llm_ollama.as_ref().unwrap()), "http://localhost:11434");
            assert_eq!(origin(c.llm_openai.as_ref().unwrap()), "https://api.openai.com");
            assert_eq!(c.llm_provider, LlmKind::None);
            assert_eq!(c.bfw_connection, BfwConnection::Server);
            assert!(c.allow_http.is_empty());
        }
        let c = ServiceConfig::from_settings_json(r#"{"llmProvider":"ollama","bfwConnection":"desktop"}"#);
        assert_eq!(c.llm_provider, LlmKind::Ollama);
        assert_eq!(c.bfw_connection, BfwConnection::Desktop);
    }

    #[test]
    fn github_readme_overlay_defaults_on() {
        assert!(ServiceConfig::from_settings_json("{}").github_readme_overlay);
        assert!(ServiceConfig::from_settings_json("not json").github_readme_overlay);
        assert!(ServiceConfig::from_settings_json(r#"{"githubReadmeOverlay":"no"}"#).github_readme_overlay);
        assert!(!ServiceConfig::from_settings_json(r#"{"githubReadmeOverlay":false}"#).github_readme_overlay);
        assert!(ServiceConfig::from_settings_json(r#"{"githubReadmeOverlay":true}"#).github_readme_overlay);
        // Until the maintainer registers the OAuth App, the built-in client ID is empty.
        assert!(DEFAULT_GITHUB_CLIENT_ID.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.'));
    }

    #[test]
    fn invalid_url_in_settings_is_none_not_default() {
        assert!(ServiceConfig::from_settings_json(r#"{"partbankWebUrl":"nope"}"#).partbank_web.is_none());
        assert!(ServiceConfig::from_settings_json(r#"{"bfwUrl":"https://wf.example/api"}"#).bfw_url.is_none());
    }

    #[test]
    fn no_vault_is_not_configured() {
        assert_eq!(ServiceConfig::load(Path::new("x/settings.json"), None).unwrap_err().kind, NetErrorKind::NotConfigured);
    }

    #[test]
    fn load_reads_the_stored_vault_settings() {
        let dir = scratch_dir("config-load");
        let (file, root) = settings_file(&dir, r#"{"partbankWebUrl":"https://pb.example","llmProvider":"openai"}"#);
        let c = ServiceConfig::load(&file, Some(&root)).unwrap();
        assert_eq!(origin(c.partbank_web.as_ref().unwrap()), "https://pb.example");
        assert_eq!(c.llm_provider, LlmKind::Openai);
        // A vault with no stored settings gets the defaults.
        let other = dir.join("other");
        std::fs::create_dir_all(&other).unwrap();
        let c = ServiceConfig::load(&file, Some(&other)).unwrap();
        assert_eq!(origin(c.partbank_web.as_ref().unwrap()), "https://partbank.kbiofoundry.kr");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn desktop_runtime_is_loopback_only() {
        let dir = scratch_dir("runtime");
        let file = dir.join("runtime.json");
        let base = |text: &str| {
            std::fs::write(&file, text).unwrap();
            bfw_desktop_base(&file).map(|u| origin(&u))
        };
        assert_eq!(base(r#"{"schemaVersion":1,"baseUrl":"http://127.0.0.1:5123","desktop":true}"#).as_deref(), Some("http://127.0.0.1:5123"));
        assert_eq!(base(r#"{"schemaVersion":1,"baseUrl":"http://localhost:5123/","desktop":true}"#).as_deref(), Some("http://localhost:5123"));
        assert_eq!(base(r#"{"schemaVersion":1,"baseUrl":"http://[::1]:5123","desktop":true}"#).as_deref(), Some("http://[::1]:5123"));
        assert_eq!(base(r#"{"schemaVersion":1,"baseUrl":"http://10.0.0.1:5123","desktop":true}"#), None);
        assert_eq!(base(r#"{"schemaVersion":1,"baseUrl":"http://127.0.0.2:5123","desktop":true}"#), None);
        assert_eq!(base(r#"{"schemaVersion":1,"baseUrl":"https://127.0.0.1:5123","desktop":true}"#), None);
        assert_eq!(base(r#"{"schemaVersion":1,"baseUrl":"http://127.0.0.1","desktop":true}"#), None);
        assert_eq!(base(r#"{"schemaVersion":1,"baseUrl":"http://127.0.0.1:5123/x","desktop":true}"#), None);
        assert_eq!(base(r#"{"schemaVersion":2,"baseUrl":"http://127.0.0.1:5123","desktop":true}"#), None);
        assert_eq!(base(r#"{"schemaVersion":1,"baseUrl":"http://127.0.0.1:5123","desktop":false}"#), None);
        assert_eq!(base("not json"), None);
        assert_eq!(bfw_desktop_base(&dir.join("missing.json")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn runtime_path_is_under_the_user_profile() {
        if let Some(p) = bfw_runtime_path() {
            assert!(p.ends_with(Path::new(".bfworkflow").join("runtime.json")));
        }
    }
}
