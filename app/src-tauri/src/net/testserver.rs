//! A local HTTP/1.1 server on `127.0.0.1` for the network tests, so no test
//! ever reaches a real server. Each connection gets one canned answer and is
//! then closed (`Connection: close`).
#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// One canned answer. Without `chunks` it is framed by `Content-Length`; with
/// `chunks` it has no `Content-Length`, writes `body`, then each chunk after
/// its delay, and closes only after the last chunk (the client reads to EOF).
#[derive(Clone, Debug)]
pub struct Canned {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
    pub chunks: Vec<(Duration, Vec<u8>)>,
}

impl Canned {
    /// A 200 with `Content-Type: application/json`.
    pub fn ok(body: &str) -> Self {
        Canned::status(200).header("Content-Type", "application/json").body(body)
    }

    /// The given status with an empty body.
    pub fn status(code: u16) -> Self {
        Canned { status: code, headers: Vec::new(), body: Vec::new(), chunks: Vec::new() }
    }

    /// Sets a header, replacing one of the same name (case-insensitive).
    pub fn header(mut self, k: &'static str, v: impl Into<String>) -> Self {
        self.headers.retain(|(name, _)| !name.eq_ignore_ascii_case(k));
        self.headers.push((k, v.into()));
        self
    }

    pub fn body(mut self, b: impl Into<Vec<u8>>) -> Self {
        self.body = b.into();
        self
    }

    pub fn chunk(mut self, after: Duration, bytes: &[u8]) -> Self {
        self.chunks.push((after, bytes.to_vec()));
        self
    }
}

#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Recorded {
    /// The value of a request header, by case-insensitive name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

pub struct TestServer {
    /// `http://127.0.0.1:<port>`, no trailing slash.
    pub url: String,
    pub requests: Arc<Mutex<Vec<Recorded>>>,
}

impl TestServer {
    pub fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

fn bind() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
    let url = format!("http://{}", listener.local_addr().unwrap());
    (listener, url)
}

/// Reads one request: the head up to the blank line, then `Content-Length`
/// bytes of body. `None` when the client goes away before a full head.
fn read_request(stream: &mut TcpStream) -> Option<Recorded> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        match stream.read(&mut tmp) {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let method = first.next().unwrap_or("").to_string();
    let path = first.next().unwrap_or("").to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    let len = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        match stream.read(&mut tmp) {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&tmp[..n]),
        }
    }
    body.truncate(len);
    Some(Recorded { method, path, headers, body: String::from_utf8_lossy(&body).into_owned() })
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

fn write_response(stream: &mut TcpStream, canned: &Canned) {
    let mut head = format!("HTTP/1.1 {} {}\r\n", canned.status, reason(canned.status));
    for (k, v) in &canned.headers {
        if k.eq_ignore_ascii_case("content-length") || k.eq_ignore_ascii_case("connection") {
            continue;
        }
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if canned.chunks.is_empty() {
        head.push_str(&format!("Content-Length: {}\r\n", canned.body.len()));
    }
    head.push_str("Connection: close\r\n\r\n");
    if stream.write_all(head.as_bytes()).is_err() || stream.write_all(&canned.body).is_err() {
        return;
    }
    let _ = stream.flush();
    for (after, bytes) in &canned.chunks {
        thread::sleep(*after);
        if stream.write_all(bytes).is_err() || stream.flush().is_err() {
            return;
        }
    }
    let _ = stream.shutdown(std::net::Shutdown::Write);
}

/// Answers each connection with the next `Canned` in order, recording the
/// request, then closes it. After the last one the listener is dropped, so
/// further connections are refused.
pub fn serve(responses: Vec<Canned>) -> TestServer {
    let (listener, url) = bind();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    thread::spawn(move || {
        for canned in responses {
            let Ok((mut stream, _)) = listener.accept() else { return };
            if let Some(r) = read_request(&mut stream) {
                log.lock().unwrap().push(r);
            }
            write_response(&mut stream, &canned);
        }
    });
    TestServer { url, requests }
}

/// Accepts connections and reads the requests, but never answers.
pub fn silent() -> TestServer {
    let (listener, url) = bind();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    thread::spawn(move || {
        let mut open = Vec::new();
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            if let Some(r) = read_request(&mut stream) {
                log.lock().unwrap().push(r);
            }
            // Keep the socket open so the client keeps waiting for an answer.
            open.push(stream);
        }
    });
    TestServer { url, requests }
}

/// Answers every connection with `status` and, as the body, the value of the
/// request header `name` (empty when absent).
pub fn echo_header(name: &'static str, status: u16) -> TestServer {
    let (listener, url) = bind();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let Some(r) = read_request(&mut stream) else { continue };
            let value = r.header(name).unwrap_or("").to_string();
            log.lock().unwrap().push(r);
            let canned = Canned::status(status).header("Content-Type", "text/plain").body(value);
            write_response(&mut stream, &canned);
        }
    });
    TestServer { url, requests }
}

/// The URL of a `127.0.0.1` port that was bound and then released, so a
/// connection to it is refused.
pub fn refused_port() -> String {
    let (listener, url) = bind();
    drop(listener);
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(url: &str, extra: &str) -> String {
        let addr = url.trim_start_matches("http://");
        let mut s = TcpStream::connect(addr).unwrap();
        s.write_all(format!("GET /p?q=1 HTTP/1.1\r\nHost: x\r\n{extra}\r\n").as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn serve_answers_in_order_and_records() {
        let srv = serve(vec![Canned::ok("{\"a\":1}"), Canned::status(404)]);
        let first = get(&srv.url, "X-Test: v\r\n");
        assert!(first.starts_with("HTTP/1.1 200"));
        assert!(first.contains("Content-Length: 7"));
        assert!(first.ends_with("{\"a\":1}"));
        assert!(get(&srv.url, "").starts_with("HTTP/1.1 404"));
        let reqs = srv.requests.lock().unwrap();
        assert_eq!(reqs.len(), 2);
        assert_eq!(reqs[0].method, "GET");
        assert_eq!(reqs[0].path, "/p?q=1");
        assert_eq!(reqs[0].header("x-test"), Some("v"));
    }

    #[test]
    fn chunked_canned_has_no_content_length_and_sends_every_chunk() {
        let srv = serve(vec![Canned::ok("a").chunk(Duration::from_millis(20), b"b").chunk(Duration::ZERO, b"c")]);
        let out = get(&srv.url, "");
        assert!(!out.contains("Content-Length"));
        assert!(out.ends_with("abc"));
    }

    #[test]
    fn header_replaces_same_name() {
        let c = Canned::ok("").header("content-type", "text/html");
        assert_eq!(c.headers, vec![("content-type", "text/html".to_string())]);
    }

    #[test]
    fn echo_header_returns_the_value() {
        let srv = echo_header("X-API-Key", 401);
        let out = get(&srv.url, "X-API-Key: k1\r\n");
        assert!(out.starts_with("HTTP/1.1 401"));
        assert!(out.ends_with("k1"));
    }

    #[test]
    fn refused_port_refuses() {
        let url = refused_port();
        assert!(TcpStream::connect(url.trim_start_matches("http://")).is_err());
    }
}
