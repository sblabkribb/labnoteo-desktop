//! A tiny Git smart-HTTP *receive-pack* stub on `127.0.0.1`, for the push
//! tests only (plan Task 8B). It never parses packs: it answers the ref
//! advertisement of an empty repository, drains the pack, and answers a
//! canned report-status (in side-band 1, with optional canned side-band 2
//! `remote:` lines). Like GitHub, it asks for Basic credentials (401) on any
//! request without an `Authorization` header. Every request is recorded with
//! its `Authorization` header, so tests can prove what was (not) sent.
#![cfg(test)]

use std::sync::{Arc, Mutex};
use std::thread;

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::sync::oneshot;

/// How the stub answers.
#[derive(Clone, Debug, Default)]
pub struct Mode {
    /// Every request gets 401, with or without credentials.
    pub always_unauthorized: bool,
    /// Report `ng <ref> <reason>` instead of `ok <ref>`.
    pub ng: Option<String>,
    /// Lines sent on side-band 2 (what `git` prints as `remote: …`).
    pub sideband: Vec<String>,
    /// Answer every request that arrives for `127.0.0.1` with a 302 to this
    /// host at the stub's own port, same path and query.
    pub redirect_to: Option<String>,
}

impl Mode {
    pub fn always_unauthorized() -> Mode {
        Mode { always_unauthorized: true, ..Mode::default() }
    }
    pub fn ok() -> Mode {
        Mode::default()
    }
    pub fn ng(reason: &str) -> Mode {
        Mode { ng: Some(reason.to_string()), ..Mode::default() }
    }
    pub fn sideband(lines: &[&str], ng: &str) -> Mode {
        Mode { ng: Some(ng.to_string()), sideband: lines.iter().map(|s| s.to_string()).collect(), ..Mode::default() }
    }
    pub fn redirect_to(host: &str) -> Mode {
        Mode { redirect_to: Some(host.to_string()), ..Mode::default() }
    }
}

/// One request as the stub saw it.
#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    /// Path and query.
    pub target: String,
    pub host: Option<String>,
    pub authorization: Option<String>,
    pub body: Vec<u8>,
}

pub struct Stub {
    /// `http://127.0.0.1:<port>/`.
    pub base: String,
    pub port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
    stop: Option<oneshot::Sender<()>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Stub {
    /// Starts the stub on `127.0.0.1:<free port>`. When `also_127_0_0_2` is
    /// set it also listens on `127.0.0.2` at the same port, if Windows lets it.
    pub fn start(mode: Mode, also_127_0_0_2: bool) -> Stub {
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind stub");
        std_listener.set_nonblocking(true).unwrap();
        let port = std_listener.local_addr().unwrap().port();
        let second = if also_127_0_0_2 {
            std::net::TcpListener::bind(("127.0.0.2", port)).ok().inspect(|l| l.set_nonblocking(true).unwrap())
        } else {
            None
        };
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (stop, mut stop_rx) = oneshot::channel::<()>();
        let log = seen.clone();
        let mode = Arc::new(mode);
        let thread = thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async move {
                let first = tokio::net::TcpListener::from_std(std_listener).unwrap();
                let second = second.map(|l| tokio::net::TcpListener::from_std(l).unwrap());
                loop {
                    let accepted = tokio::select! {
                        _ = &mut stop_rx => break,
                        a = first.accept() => a,
                        a = async { match &second { Some(l) => l.accept().await, None => std::future::pending().await } } => a,
                    };
                    let Ok((stream, _)) = accepted else { continue };
                    let log = log.clone();
                    let mode = mode.clone();
                    tokio::spawn(async move {
                        let svc = service_fn(move |req| handle(req, mode.clone(), log.clone(), port));
                        let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
                    });
                }
            });
        });
        Stub { base: format!("http://127.0.0.1:{port}/"), port, seen, stop: Some(stop), thread: Some(thread) }
    }

    /// Every request so far.
    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// The `Authorization` headers that reached the stub.
    pub fn authorizations(&self) -> Vec<String> {
        self.seen().into_iter().filter_map(|s| s.authorization).collect()
    }
}

impl Drop for Stub {
    fn drop(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// One pkt-line: four hex digits of total length, then `data`.
pub fn pkt(data: &[u8]) -> Vec<u8> {
    let mut out = format!("{:04x}", data.len() + 4).into_bytes();
    out.extend_from_slice(data);
    out
}

const FLUSH: &[u8] = b"0000";
const ZERO_ID: &str = "0000000000000000000000000000000000000000";

/// The advertisement of an empty repository that offers report-status and
/// side-band-64k.
fn advertisement() -> Vec<u8> {
    let mut out = pkt(b"# service=git-receive-pack\n");
    out.extend_from_slice(FLUSH);
    out.extend(pkt(format!("{ZERO_ID} capabilities^{{}}\0report-status side-band-64k\n").as_bytes()));
    out.extend_from_slice(FLUSH);
    out
}

/// The ref named by the first command pkt-line (`<old> <new> <ref>\0caps`),
/// without looking at the pack.
fn first_ref(body: &[u8]) -> String {
    let fallback = || "refs/heads/main".to_string();
    let Some(len) = body.get(..4).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| usize::from_str_radix(h, 16).ok()) else {
        return fallback();
    };
    let Some(line) = body.get(4..len) else { return fallback() };
    let line = line.split(|b| *b == 0 || *b == b'\n').next().unwrap_or_default();
    String::from_utf8_lossy(line).split(' ').nth(2).map(str::to_string).unwrap_or_else(fallback)
}

/// The report-status for `refname`, in side-band 1, after the side-band 2 lines.
fn report(mode: &Mode, refname: &str) -> Vec<u8> {
    let mut inner = pkt(b"unpack ok\n");
    let status = match &mode.ng {
        Some(reason) => format!("ng {refname} {reason}\n"),
        None => format!("ok {refname}\n"),
    };
    inner.extend(pkt(status.as_bytes()));
    inner.extend_from_slice(FLUSH);
    let mut out = Vec::new();
    for line in &mode.sideband {
        let mut band = vec![2u8];
        band.extend_from_slice(line.as_bytes());
        band.push(b'\n');
        out.extend(pkt(&band));
    }
    let mut band = vec![1u8];
    band.extend(inner);
    out.extend(pkt(&band));
    out.extend_from_slice(FLUSH);
    out
}

fn answer(status: u16, headers: &[(&str, String)], body: Vec<u8>) -> Response<Full<Bytes>> {
    let mut r = Response::builder().status(status);
    for (k, v) in headers {
        r = r.header(*k, v.as_str());
    }
    r.body(Full::new(Bytes::from(body))).unwrap()
}

async fn handle(
    req: Request<Incoming>,
    mode: Arc<Mode>,
    log: Arc<Mutex<Vec<Seen>>>,
    port: u16,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let method = req.method().to_string();
    let target = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_default();
    let header = |n: &str| req.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
    let host = header("host");
    let authorization = header("authorization");
    // Drain the body (the pack), whatever its framing.
    let body = req.into_body().collect().await?.to_bytes().to_vec();
    log.lock().unwrap().push(Seen {
        method: method.clone(),
        target: target.clone(),
        host: host.clone(),
        authorization: authorization.clone(),
        body: body.clone(),
    });
    if let Some(to) = &mode.redirect_to {
        if host.as_deref() == Some(format!("127.0.0.1:{port}").as_str()) {
            return Ok(answer(302, &[("Location", format!("http://{to}:{port}{target}"))], Vec::new()));
        }
    }
    if mode.always_unauthorized || authorization.is_none() {
        return Ok(answer(401, &[("WWW-Authenticate", "Basic realm=\"stub\"".to_string())], Vec::new()));
    }
    let path = target.split('?').next().unwrap_or_default();
    if method == "GET" && path.ends_with(".git/info/refs") && target.contains("service=git-receive-pack") {
        let ct = "application/x-git-receive-pack-advertisement".to_string();
        return Ok(answer(200, &[("Content-Type", ct), ("Cache-Control", "no-cache".into())], advertisement()));
    }
    if method == "POST" && path.ends_with(".git/git-receive-pack") {
        let ct = "application/x-git-receive-pack-result".to_string();
        return Ok(answer(200, &[("Content-Type", ct), ("Cache-Control", "no-cache".into())], report(&mode, &first_ref(&body))));
    }
    Ok(answer(404, &[], Vec::new()))
}

/// Standard base64 (with padding), for checking a Basic header.
pub fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in input.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkt_lines_and_base64() {
        assert_eq!(pkt(b"unpack ok\n"), b"000eunpack ok\n");
        assert_eq!(base64(b"x-access-token:abc"), "eC1hY2Nlc3MtdG9rZW46YWJj");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"a"), "YQ==");
        let cmd = pkt(format!("{ZERO_ID} {ZERO_ID} refs/heads/labnoteo/x\0report-status\n").as_bytes());
        assert_eq!(first_ref(&cmd), "refs/heads/labnoteo/x");
        assert_eq!(first_ref(b""), "refs/heads/main");
    }
}
