//! A scripted MCP server on `127.0.0.1` for the MCP client tests, so no test
//! ever reaches a real server. Built on `net/testserver.rs`: each connection
//! reads one request, records it (method, path, headers, body) and answers
//! with the next reply of the script, which may look at the request (to echo
//! a header, say, or answer with the request's JSON-RPC id). After the last
//! reply the listener is dropped, so further connections are refused.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::net::testserver::{bind, read_request, write_response, Canned, Recorded};

/// One scripted answer: built from the request it answers.
pub type Reply = Box<dyn Fn(&Recorded) -> Canned + Send>;

pub struct FakeMcp {
    /// `http://127.0.0.1:<port>/mcp`.
    pub url: String,
    pub requests: Arc<Mutex<Vec<Recorded>>>,
}

impl FakeMcp {
    pub fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    pub fn request(&self, i: usize) -> Recorded {
        self.requests.lock().unwrap()[i].clone()
    }
}

/// Serves `script` in order, one reply per connection.
pub fn fake(script: Vec<Reply>) -> FakeMcp {
    let (listener, base) = bind();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    thread::spawn(move || {
        for reply in script {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let Some(r) = read_request(&mut stream) else { continue };
            let canned = reply(&r);
            log.lock().unwrap().push(r);
            write_response(&mut stream, &canned);
        }
    });
    FakeMcp { url: format!("{base}/mcp"), requests }
}

/// A fixed answer, whatever the request.
pub fn fixed(canned: Canned) -> Reply {
    Box::new(move |_| canned.clone())
}

/// A 200 `application/json` answer.
pub fn json_body(v: &Value) -> Canned {
    Canned::status(200).header("Content-Type", "application/json").body(v.to_string())
}

/// `{"jsonrpc":"2.0","id":id,"result":result}`.
pub fn result(id: u64, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// `{"jsonrpc":"2.0","id":id,"error":{code,message}}`.
pub fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// A 200 `text/event-stream` answer written in the given chunks, 15 ms apart,
/// so each arrives as its own read.
pub fn sse(chunks: &[&[u8]]) -> Canned {
    sse_paced(chunks, Duration::from_millis(15))
}

/// `sse` with a chosen pause before each chunk.
pub fn sse_paced(chunks: &[&[u8]], pause: Duration) -> Canned {
    let mut c = Canned::status(200).header("Content-Type", "text/event-stream");
    for chunk in chunks {
        c = c.chunk(pause, chunk);
    }
    c
}

/// One SSE frame `data: <json>\n\n`.
pub fn frame(v: &Value) -> String {
    format!("data: {v}\n\n")
}

/// Answers with `status` and, as a plain-text body, the request's
/// `Authorization` header (the token echoed back, for the leak tests).
pub fn echo_auth(status: u16) -> Reply {
    Box::new(move |r| {
        Canned::status(status).header("Content-Type", "text/plain").body(format!("you sent {}", r.header("authorization").unwrap_or("")))
    })
}
