//! The MCP server's loopback HTTP/1.1 listener (C1, C2): hyper on
//! `127.0.0.1` only, bound exclusively, with a bearer token, `Host` and
//! `Origin` checks, a body cap, a header timeout and a connection cap.
//!
//! Request order (C2): auth (401), POST (405), `Host` (403), `Origin` (403),
//! the body under [`MAX_BODY_BYTES`] (400), then JSON-RPC
//! ([`super::rpc::dispatch`]). Any request path is accepted, as in the plugin.
//! No response carries an `Access-Control-*` header.

use std::fmt;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderMap, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, HOST, ORIGIN};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{json, Value};
use tokio::sync::{oneshot, watch, Semaphore};

use super::rpc::{dispatch, is_allowed_host, is_allowed_origin, is_authorized, Bridge, Reply, ToolInfo};
use super::{McpError, McpErrorKind};

/// The plugin's default port.
pub const DEFAULT_PORT: u16 = 3987;
/// The largest request body read; a larger one is a 400.
pub const MAX_BODY_BYTES: usize = 1_000_000;
/// Connections served at once; one over that is closed at once.
pub const MAX_CONNECTIONS: usize = 16;
/// A client must send its whole request header within this time.
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// What every connection shares.
pub struct ServerCtx {
    /// The bound port, which the `Host` check expects.
    pub port: u16,
    /// `McpState.token`: read on every request, so a regenerated token takes
    /// effect from the next request without a restart.
    pub token: Arc<RwLock<String>>,
    pub tools: Arc<Vec<ToolInfo>>,
    pub bridge: Arc<dyn Bridge>,
}

/// Binds `127.0.0.1:<port>` only (never `0.0.0.0` or `localhost`). On Windows
/// the socket is exclusive (`SO_EXCLUSIVEADDRUSE`) before `bind`, so another
/// user's process cannot take the port with `SO_REUSEADDR` and read clients'
/// bearer tokens. Port 0 (any free port) is allowed here for tests; `mcp_start`
/// refuses it. Must be called inside a Tokio runtime.
pub fn bind(port: u16) -> Result<tokio::net::TcpListener, McpError> {
    use socket2::{Domain, Socket, Type};
    let io = |e: std::io::Error| map_bind_error(port, e);
    let socket = Socket::new(Domain::IPV4, Type::STREAM, None).map_err(io)?;
    #[cfg(windows)]
    set_exclusive(&socket).map_err(io)?;
    let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
    socket.bind(&addr.into()).map_err(io)?;
    socket.listen(64).map_err(io)?;
    socket.set_nonblocking(true).map_err(io)?;
    let std_listener: std::net::TcpListener = socket.into();
    tokio::net::TcpListener::from_std(std_listener).map_err(io)
}

#[cfg(windows)]
fn set_exclusive(socket: &socket2::Socket) -> std::io::Result<()> {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::{setsockopt, SOCKET, SOL_SOCKET, SO_EXCLUSIVEADDRUSE};
    let on: i32 = 1;
    // SAFETY: a live socket handle, and a pointer to a 4-byte int that outlives the call.
    let rc = unsafe {
        setsockopt(
            socket.as_raw_socket() as SOCKET,
            SOL_SOCKET,
            SO_EXCLUSIVEADDRUSE,
            (&on as *const i32).cast(),
            std::mem::size_of::<i32>() as i32,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// `AddrInUse`, or `WSAEACCES` from another socket's exclusive bit, is
/// `portInUse`; anything else is `io`.
fn map_bind_error(port: u16, e: std::io::Error) -> McpError {
    const WSAEACCES: i32 = 10013;
    if e.kind() == std::io::ErrorKind::AddrInUse || (cfg!(windows) && e.raw_os_error() == Some(WSAEACCES)) {
        McpError::new(McpErrorKind::PortInUse, format!("MCP server port {port} is already in use."))
    } else {
        McpError::new(McpErrorKind::Io, format!("MCP server error: {e}"))
    }
}

/// Serves until `shutdown` fires (or its sender is dropped). Each accepted
/// connection takes a permit (none free: the stream is dropped at once) and
/// runs on its own task with the header timeout. On shutdown, kept-alive
/// connections finish their in-flight request and close.
pub async fn serve(listener: tokio::net::TcpListener, ctx: Arc<ServerCtx>, mut shutdown: oneshot::Receiver<()>) {
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let (stop_tx, stop_rx) = watch::channel(false);
    loop {
        let accepted = tokio::select! {
            _ = &mut shutdown => break,
            a = listener.accept() => a,
        };
        let Ok((stream, _)) = accepted else {
            // A transient accept error (a reset before accept, no handles):
            // back off briefly instead of spinning.
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let ctx = ctx.clone();
        let mut stop_rx = stop_rx.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let svc = service_fn(move |req| handle(req, ctx.clone()));
            let mut builder = http1::Builder::new();
            builder.timer(TokioTimer::new()).header_read_timeout(HEADER_READ_TIMEOUT);
            let conn = builder.serve_connection(TokioIo::new(stream), svc);
            tokio::pin!(conn);
            tokio::select! {
                _ = conn.as_mut() => {}
                _ = stop_rx.changed() => {
                    conn.as_mut().graceful_shutdown();
                    let _ = conn.await;
                }
            }
        });
    }
    let _ = stop_tx.send(true);
}

/// Returned by the service to close a connection without a response.
#[derive(Debug)]
struct CloseWithoutReply;

impl fmt::Display for CloseWithoutReply {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("no reply")
    }
}

impl std::error::Error for CloseWithoutReply {}

/// A header's text; a value that is not visible ASCII becomes one that no
/// check accepts (never "absent", which the `Origin` check would allow).
fn header<'a>(h: &'a HeaderMap, name: hyper::header::HeaderName) -> Option<&'a str> {
    h.get(name).map(|v| v.to_str().unwrap_or("\u{0}"))
}

fn json_response(status: u16, body: &Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .header(CACHE_CONTROL, "no-store")
        .body(Full::new(Bytes::from(serde_json::to_vec(body).unwrap_or_default())))
        .expect("a static response is valid")
}

fn empty_response(status: u16) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header(CACHE_CONTROL, "no-store")
        .body(Full::new(Bytes::new()))
        .expect("a static response is valid")
}

async fn handle(req: Request<Incoming>, ctx: Arc<ServerCtx>) -> Result<Response<Full<Bytes>>, CloseWithoutReply> {
    let h = req.headers();
    // 1. Auth first: an unauthenticated caller learns nothing else. The lock
    //    is held only for the compare, never across an await.
    let authorized = {
        let token = ctx.token.read().unwrap_or_else(|e| e.into_inner());
        is_authorized(header(h, AUTHORIZATION), &token)
    };
    if !authorized {
        return Ok(json_response(401, &json!({ "error": "unauthorized" })));
    }
    // 2. Streamable HTTP's GET opens a server-to-client stream; there is
    //    nothing to push, and the spec's answer for that is 405.
    if req.method() != Method::POST {
        return Ok(json_response(405, &json!({ "error": "method not allowed" })));
    }
    // 3. DNS rebinding sends the attacker's name as `Host`.
    if !is_allowed_host(header(h, HOST), ctx.port) {
        return Ok(json_response(403, &json!({ "error": "forbidden host" })));
    }
    // 4. A browser page on another origin.
    if !is_allowed_origin(header(h, ORIGIN)) {
        return Ok(json_response(403, &json!({ "error": "forbidden origin" })));
    }
    // 5. The body, capped while streaming (Content-Length or chunked).
    let body = match Limited::new(req.into_body(), MAX_BODY_BYTES).collect().await {
        Ok(c) => c.to_bytes(),
        Err(_) => return Ok(json_response(400, &json!({ "error": "bad request" }))),
    };
    // 6. JSON-RPC.
    match dispatch(&body, &ctx.tools, ctx.bridge.as_ref()).await {
        Reply::Json(status, v) => Ok(json_response(status, &v)),
        Reply::Accepted => Ok(empty_response(202)),
        Reply::NoReply => Err(CloseWithoutReply),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::rpc::{Bridge, CallOutcome, ToolInfo};
    use futures_util::future::BoxFuture;
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::Mutex;
    use std::thread;

    type Calls = Arc<Mutex<Vec<(String, Value, bool)>>>;

    /// Records each forwarded call and answers with a fixed tool result.
    struct RecordingBridge {
        calls: Calls,
    }

    impl Bridge for RecordingBridge {
        fn call(&self, name: String, args: Value, mutates: bool) -> BoxFuture<'static, CallOutcome> {
            self.calls.lock().unwrap().push((name.clone(), args, mutates));
            Box::pin(async move {
                CallOutcome::Result(json!({"isError": name == "nope", "content": [{"type": "text", "text": name}]}))
            })
        }
    }

    fn catalog() -> Vec<ToolInfo> {
        vec![
            ToolInfo { name: "read_note".into(), description: "Read".into(), input_schema: json!({"type": "object"}), mutates: false },
            ToolInfo { name: "append_note".into(), description: "Append".into(), input_schema: json!({"type": "object"}), mutates: true },
        ]
    }

    /// A server on `bind(0)` in its own runtime thread, stopped on drop.
    struct Harness {
        port: u16,
        token: Arc<RwLock<String>>,
        calls: Calls,
        stop: Option<tokio::sync::oneshot::Sender<()>>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl Harness {
        fn start(token: &str) -> Harness {
            let token = Arc::new(RwLock::new(token.to_string()));
            let calls: Calls = Arc::default();
            let (port_tx, port_rx) = std::sync::mpsc::channel();
            let (stop, stop_rx) = tokio::sync::oneshot::channel();
            let (t, c) = (token.clone(), calls.clone());
            let thread = thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                rt.block_on(async move {
                    let listener = bind(0).unwrap();
                    let port = listener.local_addr().unwrap().port();
                    let ctx = Arc::new(ServerCtx {
                        port,
                        token: t,
                        tools: Arc::new(catalog()),
                        bridge: Arc::new(RecordingBridge { calls: c }),
                    });
                    port_tx.send(port).unwrap();
                    serve(listener, ctx, stop_rx).await;
                });
            });
            let port = port_rx.recv().unwrap();
            Harness { port, token, calls, stop: Some(stop), thread: Some(thread) }
        }

        fn auth(&self) -> String {
            format!("Bearer {}", self.token.read().unwrap())
        }

        fn post(&self, body: &str) -> Resp {
            self.send("POST", "/", &[("Authorization", &self.auth())], body)
        }

        fn send(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Resp {
            let mut raw = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
            if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
                raw.push_str(&format!("Host: 127.0.0.1:{}\r\n", self.port));
            }
            for (k, v) in headers {
                raw.push_str(&format!("{k}: {v}\r\n"));
            }
            raw.push_str("\r\n");
            raw.push_str(body);
            let mut s = connect(self.port);
            s.write_all(raw.as_bytes()).unwrap();
            parse(&read_all(&mut s))
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            if let Some(s) = self.stop.take() {
                let _ = s.send(());
            }
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    struct Resp {
        status: u16,
        headers: Vec<(String, String)>,
        body: String,
    }

    impl Resp {
        fn json(&self) -> Value {
            serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {:?}", self.body))
        }
        fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
        }
    }

    fn connect(port: u16) -> TcpStream {
        let s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
        s
    }

    /// Everything the server sends until it closes (an error after some bytes,
    /// e.g. a reset, ends the read too).
    fn read_all(s: &mut TcpStream) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match s.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => out.extend_from_slice(&buf[..n]),
                Err(e) if out.is_empty() => panic!("no response: {e}"),
                Err(_) => break,
            }
        }
        out
    }

    fn parse(raw: &[u8]) -> Resp {
        let text = String::from_utf8_lossy(raw).into_owned();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or_else(|| panic!("no header end: {text:?}"));
        let mut lines = head.split("\r\n");
        let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
        let headers = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        Resp { status, headers, body: body.to_string() }
    }

    const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;

    #[test]
    fn missing_or_wrong_token_is_401_first() {
        let h = Harness::start(&"t".repeat(48));
        let r = h.send("GET", "/", &[], "");
        assert_eq!(r.status, 401);
        assert_eq!(r.json(), json!({"error": "unauthorized"}));
        let r = h.send("POST", "/", &[("Authorization", "Bearer x")], INIT);
        assert_eq!(r.status, 401);
        // Auth comes before the Host and Origin checks.
        let r = h.send("POST", "/", &[("Host", "evil.example"), ("Origin", "http://evil.example")], INIT);
        assert_eq!(r.status, 401);
    }

    #[test]
    fn get_is_405_after_auth() {
        let h = Harness::start(&"t".repeat(48));
        let r = h.send("GET", "/", &[("Authorization", &h.auth())], "");
        assert_eq!(r.status, 405);
        assert_eq!(r.json(), json!({"error": "method not allowed"}));
    }

    #[test]
    fn wrong_host_header_is_403_even_with_token() {
        let h = Harness::start(&"t".repeat(48));
        let auth = h.auth();
        let evil = format!("evil.example:{}", h.port);
        let r = h.send("POST", "/", &[("Authorization", &auth), ("Host", &evil)], INIT);
        assert_eq!(r.status, 403);
        assert_eq!(r.json(), json!({"error": "forbidden host"}));
        for host in [format!("127.0.0.1:{}", h.port), format!("LOCALHOST:{}", h.port), format!("localhost:{}", h.port)] {
            let r = h.send("POST", "/", &[("Authorization", &auth), ("Host", &host)], INIT);
            assert_eq!(r.status, 200, "{host}");
        }
        let other_port = format!("127.0.0.1:{}", h.port.wrapping_add(1));
        let r = h.send("POST", "/", &[("Authorization", &auth), ("Host", &other_port)], INIT);
        assert_eq!(r.status, 403);
    }

    #[test]
    fn browser_origin_other_than_loopback_is_403() {
        let h = Harness::start(&"t".repeat(48));
        let auth = h.auth();
        let r = h.send("POST", "/", &[("Authorization", &auth), ("Origin", "http://evil.example")], INIT);
        assert_eq!(r.status, 403);
        assert_eq!(r.json(), json!({"error": "forbidden origin"}));
        let r = h.send("POST", "/", &[("Authorization", &auth), ("Origin", "garbage")], INIT);
        assert_eq!(r.status, 403);
        let r = h.send("POST", "/", &[("Authorization", &auth), ("Origin", "http://localhost:5173")], INIT);
        assert_eq!(r.status, 200);
        assert_eq!(h.post(INIT).status, 200);
    }

    /// Streams `head` then `chunks` from another thread (write errors are
    /// expected once the server answers) and returns the server's answer.
    fn oversized(h: &Harness, head: String, chunks: Vec<Vec<u8>>) -> Resp {
        let mut s = connect(h.port);
        let mut w = s.try_clone().unwrap();
        let writer = thread::spawn(move || {
            if w.write_all(head.as_bytes()).is_err() {
                return;
            }
            for c in chunks {
                if w.write_all(&c).is_err() {
                    return;
                }
            }
        });
        let r = parse(&read_all(&mut s));
        drop(s);
        let _ = writer.join();
        r
    }

    #[test]
    fn body_over_cap_is_400() {
        let h = Harness::start(&"t".repeat(48));
        let total = MAX_BODY_BYTES + 1;
        let head = format!(
            "POST / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: {}\r\nConnection: close\r\nContent-Length: {total}\r\n\r\n",
            h.port,
            h.auth()
        );
        let mut chunks = Vec::new();
        let mut left = total;
        while left > 0 {
            let n = left.min(64 * 1024);
            chunks.push(vec![b' '; n]);
            left -= n;
        }
        let r = oversized(&h, head, chunks);
        assert_eq!(r.status, 400);
        assert!(r.body.contains("bad request"), "{}", r.body);

        // Chunked, with no final empty chunk: only the cap can end this body.
        let head = format!(
            "POST / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: {}\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n",
            h.port,
            h.auth()
        );
        let mut chunks = Vec::new();
        let mut left = total;
        while left > 0 {
            let n = left.min(64 * 1024);
            let mut c = format!("{n:x}\r\n").into_bytes();
            c.extend(std::iter::repeat(b' ').take(n));
            c.extend_from_slice(b"\r\n");
            chunks.push(c);
            left -= n;
        }
        let r = oversized(&h, head, chunks);
        assert_eq!(r.status, 400);
        assert!(r.body.contains("bad request"), "{}", r.body);
        assert_eq!(h.calls.lock().unwrap().len(), 0);
    }

    #[test]
    fn a_body_at_the_cap_is_read() {
        let h = Harness::start(&"t".repeat(48));
        let mut body = INIT.to_string();
        body.push_str(&" ".repeat(MAX_BODY_BYTES - body.len()));
        assert_eq!(body.len(), MAX_BODY_BYTES);
        assert_eq!(h.post(&body).status, 200);
    }

    #[test]
    fn no_cors_headers_on_any_response() {
        let h = Harness::start(&"t".repeat(48));
        let auth = h.auth();
        let responses = [
            (200, h.post(INIT)),
            (202, h.post(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)),
            (400, h.post("{")),
            (401, h.send("POST", "/", &[("Origin", "http://localhost")], INIT)),
            (403, h.send("POST", "/", &[("Authorization", &auth), ("Origin", "http://evil.example")], INIT)),
            (405, h.send("OPTIONS", "/", &[("Authorization", &auth), ("Origin", "http://evil.example")], "")),
        ];
        for (want, r) in &responses {
            assert_eq!(r.status, *want);
            assert!(!r.headers.iter().any(|(k, _)| k.starts_with("access-control-")), "{want}: {:?}", r.headers);
            assert_eq!(r.header("cache-control"), Some("no-store"), "{want}");
            if *want != 202 {
                assert_eq!(r.header("content-type"), Some("application/json"), "{want}");
            }
        }
    }

    #[test]
    fn initialize_ping_and_tools_list() {
        let h = Harness::start(&"t".repeat(48));
        let r = h.post(INIT).json();
        assert_eq!(r["jsonrpc"], "2.0");
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(r["result"]["serverInfo"]["name"], "labnoteo");
        let r = h.post(r#"{"jsonrpc":"2.0","id":"p","method":"ping"}"#).json();
        assert_eq!(r, json!({"jsonrpc": "2.0", "id": "p", "result": {}}));
        let r = h.post(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).json();
        assert_eq!(
            r["result"],
            json!({"tools": [
                {"name": "read_note", "description": "Read", "inputSchema": {"type": "object"}},
                {"name": "append_note", "description": "Append", "inputSchema": {"type": "object"}},
            ]})
        );
        assert!(!r.to_string().contains("mutates"));
        assert!(h.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn any_request_path_answers() {
        let h = Harness::start(&"t".repeat(48));
        let auth = h.auth();
        for path in ["/mcp", "/", "/anything/else"] {
            let r = h.send("POST", path, &[("Authorization", &auth)], INIT);
            assert_eq!(r.status, 200, "{path}");
        }
    }

    #[test]
    fn notification_gets_202() {
        let h = Harness::start(&"t".repeat(48));
        let r = h.post(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert_eq!(r.status, 202);
        assert_eq!(r.body, "");
    }

    #[test]
    fn unknown_method_is_32601_and_bad_json_is_32700() {
        let h = Harness::start(&"t".repeat(48));
        let r = h.post(r#"{"method":"x","id":1}"#);
        assert_eq!(r.status, 200);
        let v = r.json();
        assert_eq!(v["error"]["code"], -32601);
        assert_eq!(v["id"], 1);
        let r = h.post("{");
        assert_eq!(r.status, 400);
        let v = r.json();
        assert_eq!(v["error"]["code"], -32700);
        assert_eq!(v["id"], Value::Null);
        // Not an object (a batch, a bare value): an invalid request, never a crash.
        let r = h.post("[1]");
        assert_eq!(r.status, 400);
        assert_eq!(r.json()["error"]["code"], -32600);
    }

    #[test]
    fn unknown_tool_goes_to_the_bridge_as_read() {
        let h = Harness::start(&"t".repeat(48));
        let r = h.post(r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"nope","arguments":{"a":1}}}"#);
        assert_eq!(r.status, 200);
        assert_eq!(
            r.json(),
            json!({"jsonrpc": "2.0", "id": 7, "result": {"isError": true, "content": [{"type": "text", "text": "nope"}]}})
        );
        let r = h.post(r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"append_note"}}"#);
        assert_eq!(r.json()["result"]["isError"], false);
        let calls = h.calls.lock().unwrap().clone();
        assert_eq!(
            calls,
            vec![("nope".to_string(), json!({"a": 1}), false), ("append_note".to_string(), json!({}), true)]
        );
    }

    #[test]
    fn binds_ipv4_loopback_only_and_reports_port_in_use() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let l = bind(0).unwrap();
            let addr = l.local_addr().unwrap();
            assert_eq!(addr.ip(), std::net::IpAddr::from([127, 0, 0, 1]));
            let err = bind(addr.port()).unwrap_err();
            assert_eq!(err.kind, McpErrorKind::PortInUse);
            assert!(err.message.contains(&addr.port().to_string()), "{}", err.message);
        });
    }

    #[cfg(windows)]
    #[test]
    fn a_second_bind_with_so_reuseaddr_fails() {
        use socket2::{Domain, Socket, Type};
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let l = bind(0).unwrap();
            let port = l.local_addr().unwrap().port();
            let s = Socket::new(Domain::IPV4, Type::STREAM, None).unwrap();
            s.set_reuse_address(true).unwrap();
            let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
            assert!(s.bind(&addr.into()).is_err(), "a SO_REUSEADDR socket took the MCP port");
            // A same-user test process may be refused even without the
            // exclusive bit, so the bit itself is checked on the listener too.
            assert_eq!(exclusive_bit(&l), 1, "the MCP listener is not SO_EXCLUSIVEADDRUSE");
        });
    }

    #[cfg(windows)]
    fn exclusive_bit(l: &tokio::net::TcpListener) -> i32 {
        use std::os::windows::io::AsRawSocket;
        use windows_sys::Win32::Networking::WinSock::{getsockopt, SOCKET, SOL_SOCKET, SO_EXCLUSIVEADDRUSE};
        let mut val: i32 = 0;
        let mut len = std::mem::size_of::<i32>() as i32;
        // SAFETY: a live socket handle and a 4-byte out buffer with its length.
        let rc = unsafe {
            getsockopt(l.as_raw_socket() as SOCKET, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (&mut val as *mut i32).cast(), &mut len)
        };
        assert_eq!(rc, 0, "{}", std::io::Error::last_os_error());
        val
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_header_gets_the_connection_closed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = bind(0).unwrap();
        let port = listener.local_addr().unwrap().port();
        let ctx = Arc::new(ServerCtx {
            port,
            token: Arc::new(RwLock::new("t".repeat(48))),
            tools: Arc::new(catalog()),
            bridge: Arc::new(RecordingBridge { calls: Arc::default() }),
        });
        let (_stop, stop_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(serve(listener, ctx, stop_rx));
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(b"POST / HTTP/1.1\r\n").await.unwrap();
        // Let the server accept the connection and start reading its header.
        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::advance(Duration::from_secs(11)).await;
        let mut buf = [0u8; 64];
        let n = tokio::time::timeout(Duration::from_secs(1), s.read(&mut buf))
            .await
            .expect("the connection is still open 11 s into a slow header");
        assert!(matches!(n, Ok(0) | Err(_)), "{n:?}");
    }

    #[test]
    fn connections_over_the_cap_are_closed() {
        let h = Harness::start(&"t".repeat(48));
        let held: Vec<TcpStream> = (0..MAX_CONNECTIONS).map(|_| connect(h.port)).collect();
        thread::sleep(Duration::from_millis(300));
        let mut extra = connect(h.port);
        extra.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut buf = [0u8; 16];
        match extra.read(&mut buf) {
            Ok(0) => {}
            Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted) => {}
            other => panic!("the 17th connection was not closed at once: {other:?}"),
        }
        drop(held);
        thread::sleep(Duration::from_millis(300));
        assert_eq!(h.post(INIT).status, 200);
    }

    #[test]
    fn regenerated_token_takes_effect_without_restart() {
        let h = Harness::start(&"a".repeat(48));
        let a = format!("Bearer {}", "a".repeat(48));
        let b = format!("Bearer {}", "b".repeat(48));
        assert_eq!(h.send("POST", "/", &[("Authorization", &a)], INIT).status, 200);
        *h.token.write().unwrap() = "b".repeat(48);
        assert_eq!(h.send("POST", "/", &[("Authorization", &a)], INIT).status, 401);
        assert_eq!(h.send("POST", "/", &[("Authorization", &b)], INIT).status, 200);
    }

    #[test]
    fn an_empty_token_refuses_every_request() {
        let h = Harness::start("");
        assert_eq!(h.send("POST", "/", &[("Authorization", "Bearer ")], INIT).status, 401);
    }

    #[test]
    fn stopping_closes_kept_alive_connections() {
        let mut h = Harness::start(&"t".repeat(48));
        let mut s = connect(h.port);
        let req = format!(
            "POST / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: {}\r\nContent-Length: {}\r\n\r\n{INIT}",
            h.port,
            h.auth(),
            INIT.len()
        );
        s.write_all(req.as_bytes()).unwrap();
        let mut buf = [0u8; 4096];
        assert!(s.read(&mut buf).unwrap() > 0);
        h.stop.take().unwrap().send(()).unwrap();
        h.thread.take().unwrap().join().unwrap();
        let _ = s.write_all(req.as_bytes());
        match s.read(&mut buf) {
            Ok(0) | Err(_) => {}
            Ok(n) => panic!("a stopped server answered: {:?}", String::from_utf8_lossy(&buf[..n])),
        }
    }
}
