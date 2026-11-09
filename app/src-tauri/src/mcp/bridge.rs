//! The bridge from the MCP server to the webview (C3).
//!
//! Rust answers `initialize`, `ping` and `tools/list` itself; a `tools/call`
//! is emitted to the webview as `mcp://call {callId, name, args, mutates}` and
//! answered by `mcp_reply`. Before it runs a tool the webview must win
//! `mcp_claim`: a call that Rust already ended (its deadline, a client
//! disconnect, a drain or a stop) is no longer pending, so the claim is `false`
//! and nothing is written.
//!
//! - A read call waits at most [`READ_CALL_MS`]. A mutating call has no fixed
//!   cap from arrival (the webview owns the per-question approval timeout and
//!   the queue in front of it); [`MUTATING_CALL_MS`] only covers a dead
//!   webview. A deadline ends only an **unclaimed** call.
//! - Every Rust-side end of a call emits `mcp://cancel {callId}` (drain and
//!   stop excepted: the webview is going away or switching vault and cancels
//!   its own work).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::oneshot;

use super::rpc::{Bridge, CallOutcome, ToolInfo};
use super::server::{bind, serve, ServerCtx};
use super::token::{ensure_token, token_status};
use super::{McpError, McpErrorKind, McpState};
use crate::net::secrets::Secrets;

/// How long a read call may wait for the webview.
pub const READ_CALL_MS: u64 = 55_000;
/// The safety cap on an unclaimed mutating call (a dead webview).
pub const MUTATING_CALL_MS: u64 = 600_000;

/// The event a `tools/call` is forwarded on.
pub const CALL_EVENT: &str = "mcp://call";
/// The event that withdraws a call Rust ended.
pub const CANCEL_EVENT: &str = "mcp://cancel";

/// JSON-RPC error for a call nobody answered in time.
pub const TIMEOUT_CODE: i64 = -32001;
pub const TIMEOUT_MESSAGE: &str = "Approval timed out: the user did not answer in labnoteO";
/// JSON-RPC error for a call failed by a stop, a vault switch or a page load.
pub const DRAINED_CODE: i64 = -32002;
pub const DRAINED_MESSAGE: &str = "labnoteO closed the vault; nothing was written";
/// The same end for a call the webview had already claimed: it may have been
/// writing when the vault closed, so whether anything was written is unknown.
pub const DRAINED_CLAIMED_MESSAGE: &str =
    "labnoteO closed the vault while this call was running; whether it wrote anything is unknown, so check the note before trying again";

/// One call waiting for the webview.
pub(crate) struct Pending {
    tx: oneshot::Sender<CallOutcome>,
    /// Set by `mcp_claim`: the webview is running the tool, so no deadline
    /// ends this call any more.
    claimed: bool,
}

/// Calls waiting for the webview, by `callId`.
pub(crate) type PendingMap = Arc<Mutex<HashMap<String, Pending>>>;

/// A server that is up.
pub(crate) struct Running {
    port: u16,
    shutdown: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

/// `mcp://call`'s payload (pinned in `tests/ipc-events.json`).
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CallEvent {
    pub call_id: String,
    pub name: String,
    pub args: Value,
    pub mutates: bool,
}

/// `mcp://cancel`'s payload (pinned in `tests/ipc-events.json`).
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CancelEvent {
    pub call_id: String,
}

/// The webview's answer to one call.
#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReplyIn {
    /// A `CallToolResult`.
    Result { result: Value },
    /// A JSON-RPC error.
    Error { code: i64, message: String },
    /// Close the client's connection without an answer.
    NoReply,
}

impl From<ReplyIn> for CallOutcome {
    fn from(r: ReplyIn) -> CallOutcome {
        match r {
            ReplyIn::Result { result } => CallOutcome::Result(result),
            ReplyIn::Error { code, message } => CallOutcome::RpcError(code, message),
            ReplyIn::NoReply => CallOutcome::NoReply,
        }
    }
}

/// What the webview may know about the server. Never the token.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub token_set: bool,
    pub token_epoch: u64,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A random UUID v4 (from the OS RNG), the `callId`.
pub fn new_call_id() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("the OS random number generator failed");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

fn cancel_payload(call_id: &str) -> Value {
    serde_json::to_value(CancelEvent { call_id: call_id.to_string() }).unwrap_or(Value::Null)
}

/// Forwards `tools/call` to the webview through `emit` (C3).
pub struct EmitBridge<E: Fn(&str, Value) + Send + Sync + 'static> {
    emit: Arc<E>,
    pending: PendingMap,
    attention: Box<dyn Fn() + Send + Sync>,
}

impl<E: Fn(&str, Value) + Send + Sync + 'static> EmitBridge<E> {
    pub(crate) fn new(emit: E, pending: PendingMap, attention: Box<dyn Fn() + Send + Sync>) -> Self {
        EmitBridge { emit: Arc::new(emit), pending, attention }
    }
}

/// Withdraws the call when its request future is dropped before an answer
/// (hyper drops it when the client goes away). A call already answered,
/// drained or timed out is no longer in the map, so nothing is emitted then.
struct CancelOnDrop<E: Fn(&str, Value) + Send + Sync + 'static> {
    call_id: String,
    pending: PendingMap,
    emit: Arc<E>,
}

impl<E: Fn(&str, Value) + Send + Sync + 'static> Drop for CancelOnDrop<E> {
    fn drop(&mut self) {
        let removed = lock(&self.pending).remove(&self.call_id).is_some();
        if removed {
            (self.emit)(CANCEL_EVENT, cancel_payload(&self.call_id));
        }
    }
}

impl<E: Fn(&str, Value) + Send + Sync + 'static> Bridge for EmitBridge<E> {
    fn call(&self, name: String, args: Value, mutates: bool) -> BoxFuture<'static, CallOutcome> {
        let call_id = new_call_id();
        let (tx, mut rx) = oneshot::channel();
        lock(&self.pending).insert(call_id.clone(), Pending { tx, claimed: false });
        let guard = CancelOnDrop { call_id: call_id.clone(), pending: self.pending.clone(), emit: self.emit.clone() };
        if mutates {
            (self.attention)();
        }
        let event = CallEvent { call_id, name, args, mutates };
        (self.emit)(CALL_EVENT, serde_json::to_value(&event).unwrap_or(Value::Null));
        let limit = Duration::from_millis(if mutates { MUTATING_CALL_MS } else { READ_CALL_MS });
        Box::pin(async move {
            let guard = guard;
            let lost = || CallOutcome::RpcError(-32603, "Internal error".to_string());
            match tokio::time::timeout(limit, &mut rx).await {
                Ok(r) => r.unwrap_or_else(|_| lost()),
                Err(_) => {
                    // The deadline ends only a call nobody claimed; a claimed
                    // one waits for its reply (or a drain, or a disconnect).
                    let expired = {
                        let mut map = lock(&guard.pending);
                        match map.get(&guard.call_id) {
                            Some(p) if !p.claimed => map.remove(&guard.call_id).is_some(),
                            _ => false,
                        }
                    };
                    if expired {
                        (guard.emit)(CANCEL_EVENT, cancel_payload(&guard.call_id));
                        return CallOutcome::RpcError(TIMEOUT_CODE, TIMEOUT_MESSAGE.to_string());
                    }
                    rx.await.unwrap_or_else(|_| lost())
                }
            }
        })
    }
}

/// `true`, and the call marked claimed, when it is still pending and nobody
/// claimed it yet; `false` otherwise (ended by Rust, answered, or claimed).
pub(crate) fn claim(pending: &PendingMap, call_id: &str) -> bool {
    match lock(pending).get_mut(call_id) {
        Some(p) if !p.claimed => {
            p.claimed = true;
            true
        }
        _ => false,
    }
}

/// Answers a pending call; `false` when it is unknown (cancelled, drained,
/// already answered or late). An unclaimed call may be answered too: a denied
/// or timed-out approval answers without running a tool.
pub(crate) fn reply(pending: &PendingMap, call_id: &str, r: ReplyIn) -> bool {
    let entry = lock(pending).remove(call_id);
    match entry {
        Some(p) => p.tx.send(r.into()).is_ok(),
        None => false,
    }
}

/// Fails every pending call with `-32002` and empties the map: an unclaimed
/// call with [`DRAINED_MESSAGE`] (nothing ran), a claimed one with
/// [`DRAINED_CLAIMED_MESSAGE`] (the tool may have written already). Emits
/// nothing: the webview is going away or switching vault and cancels its own
/// work.
pub fn drain_pending(state: &McpState) -> u32 {
    let drained: Vec<Pending> = lock(&state.pending).drain().map(|(_, p)| p).collect();
    let n = drained.len() as u32;
    for p in drained {
        let message = if p.claimed { DRAINED_CLAIMED_MESSAGE } else { DRAINED_MESSAGE };
        let _ = p.tx.send(CallOutcome::RpcError(DRAINED_CODE, message.to_string()));
    }
    n
}

/// Signals the server to stop and returns its task, so a caller that needs
/// the port back can wait for the listener to close.
fn stop_running(state: &McpState) -> Option<tokio::task::JoinHandle<()>> {
    let running = lock(&state.running).take()?;
    let _ = running.shutdown.send(());
    Some(running.task)
}

/// The webview started loading a page (reload, navigation, crash recovery):
/// stop the server and fail every pending call, from Rust, because JS cannot
/// reliably invoke during unload. The vault effect starts it again.
pub fn page_load_started(state: &McpState) {
    drop(stop_running(state));
    drain_pending(state);
}

/// Serves `listener` with `bridge` on the current Tokio runtime and records it
/// as running.
pub(crate) fn start_serving(state: &McpState, listener: tokio::net::TcpListener, tools: Vec<ToolInfo>, bridge: Arc<dyn Bridge>) {
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let ctx = Arc::new(ServerCtx { port, token: state.token.clone(), tools: Arc::new(tools), bridge });
    let (shutdown, rx) = oneshot::channel();
    let task = tokio::spawn(serve(listener, ctx, rx));
    *lock(&state.running) = Some(Running { port, shutdown, task });
}

/// `badInput` unless the port is 1024..=65535 (C2).
pub fn check_port(port: u16) -> Result<(), McpError> {
    if port >= 1024 {
        Ok(())
    } else {
        Err(McpError::new(McpErrorKind::BadInput, "the MCP port must be between 1024 and 65535"))
    }
}

fn status_of(state: &McpState, secrets: &Secrets) -> Result<McpStatus, McpError> {
    let port = lock(&state.running).as_ref().map(|r| r.port);
    let t = token_status(secrets.0.as_ref())?;
    Ok(McpStatus { running: port.is_some(), port, token_set: t.set, token_epoch: t.epoch })
}

/// The bridge the app uses: events to the webview, and a taskbar flash for a
/// mutating call while the main window is not focused.
fn app_bridge<R: Runtime>(app: AppHandle<R>, pending: PendingMap) -> Arc<dyn Bridge> {
    let emitter = app.clone();
    let emit = move |name: &str, payload: Value| {
        // A lost event ends as a deadline, never as a silent write.
        let _ = emitter.emit(name, payload);
    };
    let attention = Box::new(move || {
        if let Some(w) = app.get_webview_window("main") {
            if !w.is_focused().unwrap_or(false) {
                let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
            }
        }
    });
    Arc::new(EmitBridge::new(emit, pending, attention))
}

/// Starts the server on `127.0.0.1:<port>` with the webview's tool catalog.
/// Binds, then makes sure a token exists, then serves. Calling it while
/// running restarts (pending calls are drained first).
#[tauri::command]
pub async fn mcp_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, McpState>,
    secrets: State<'_, Secrets>,
    port: u16,
    tools: Vec<ToolInfo>,
) -> Result<McpStatus, McpError> {
    check_port(port)?;
    if let Some(task) = stop_running(&state) {
        drain_pending(&state);
        // The listener is closed once `serve` returns: wait, so the same port
        // can be bound again.
        let _ = task.await;
    }
    let listener = bind(port)?;
    ensure_token(secrets.0.as_ref(), &state.token)?;
    start_serving(&state, listener, tools, app_bridge(app, state.pending.clone()));
    status_of(&state, &secrets)
}

/// Stops the server and fails every pending call.
#[tauri::command]
pub async fn mcp_stop(state: State<'_, McpState>) -> Result<(), McpError> {
    let task = stop_running(&state);
    drain_pending(&state);
    if let Some(task) = task {
        let _ = task.await;
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_status(state: State<'_, McpState>, secrets: State<'_, Secrets>) -> Result<McpStatus, McpError> {
    status_of(&state, &secrets)
}

#[tauri::command]
pub fn mcp_claim(state: State<'_, McpState>, call_id: String) -> bool {
    claim(&state.pending, &call_id)
}

#[tauri::command]
pub fn mcp_reply(state: State<'_, McpState>, call_id: String, reply: ReplyIn) -> bool {
    self::reply(&state.pending, &call_id, reply)
}

/// Fails every pending call (vault switch); the server keeps running.
#[tauri::command]
pub fn mcp_drain(state: State<'_, McpState>) -> u32 {
    drain_pending(&state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::rpc::{dispatch, Reply};
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::thread;

    type Events = mpsc::Receiver<(String, Value)>;

    fn catalog() -> Vec<ToolInfo> {
        vec![
            ToolInfo { name: "read_note".into(), description: "Read".into(), input_schema: json!({"type": "object"}), mutates: false },
            ToolInfo { name: "append_note".into(), description: "Append".into(), input_schema: json!({"type": "object"}), mutates: true },
        ]
    }

    /// A bridge over `state.pending` whose events go to a channel and whose
    /// attention calls are counted.
    fn test_bridge(state: &McpState) -> (Arc<dyn Bridge>, Events, Arc<AtomicUsize>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let emit = move |name: &str, payload: Value| {
            let _ = lock(&tx).send((name.to_string(), payload));
        };
        let attention = Box::new(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        (Arc::new(EmitBridge::new(emit, state.pending.clone(), attention)), rx, count)
    }

    fn call_body(id: u32, name: &str) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"{name}","arguments":{{"path":"a.md"}}}}}}"#)
    }

    fn spawn_call(bridge: Arc<dyn Bridge>, name: &str, id: u32) -> tokio::task::JoinHandle<Reply> {
        let body = call_body(id, name);
        tokio::spawn(async move { dispatch(body.as_bytes(), &catalog(), bridge.as_ref()).await })
    }

    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    fn rpc_json(r: Reply) -> Value {
        match r {
            Reply::Json(200, v) => v,
            other => panic!("not an HTTP 200 JSON answer: {other:?}"),
        }
    }

    fn drain_events(events: &Events) -> Vec<(String, Value)> {
        events.try_iter().collect()
    }

    fn call_id_of(ev: &(String, Value)) -> String {
        assert_eq!(ev.0, CALL_EVENT);
        ev.1["callId"].as_str().unwrap().to_string()
    }

    /// A real server on `bind(0)` with the emitting bridge, in its own runtime.
    struct Http {
        port: u16,
        state: Arc<McpState>,
        events: Events,
        stop: Option<tokio::sync::oneshot::Sender<()>>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl Http {
        fn start() -> Http {
            let state = Arc::new(McpState::default());
            *state.token.write().unwrap() = "t".repeat(48);
            let (bridge, events, _) = test_bridge(&state);
            let (port_tx, port_rx) = mpsc::channel();
            let (stop, stop_rx) = tokio::sync::oneshot::channel::<()>();
            let st = state.clone();
            let thread = thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
                rt.block_on(async move {
                    let listener = bind(0).unwrap();
                    port_tx.send(listener.local_addr().unwrap().port()).unwrap();
                    start_serving(&st, listener, catalog(), bridge);
                    let _ = stop_rx.await;
                    drop(stop_running(&st));
                });
            });
            let port = port_rx.recv().unwrap();
            Http { port, state, events, stop: Some(stop), thread: Some(thread) }
        }

        fn request(&self, body: &str) -> String {
            format!(
                "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                self.port,
                "t".repeat(48),
                body.len()
            )
        }

        fn connect(&self) -> TcpStream {
            let s = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
            s
        }

        fn next_event(&self) -> (String, Value) {
            self.events.recv_timeout(Duration::from_secs(5)).expect("an event from the bridge")
        }
    }

    impl Drop for Http {
        fn drop(&mut self) {
            if let Some(s) = self.stop.take() {
                let _ = s.send(());
            }
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    /// Reads one HTTP response (Content-Length framed) and returns status and body.
    fn read_response(s: &mut TcpStream) -> (u16, String) {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = s.read(&mut buf).expect("a response");
            assert!(n > 0, "the server closed without a response: {:?}", String::from_utf8_lossy(&out));
            out.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&out).into_owned();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let len: usize = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                    .unwrap_or(0);
                if body.len() >= len {
                    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
                    return (status, body[..len].to_string());
                }
            }
        }
    }

    #[test]
    fn tools_call_round_trips_through_the_bridge() {
        let h = Http::start();
        let mut s = h.connect();
        s.write_all(h.request(&call_body(9, "append_note")).as_bytes()).unwrap();
        let ev = h.next_event();
        assert_eq!(ev.0, CALL_EVENT);
        assert_eq!(ev.1["name"], "append_note");
        assert_eq!(ev.1["args"], json!({"path": "a.md"}));
        assert_eq!(ev.1["mutates"], true);
        let id = call_id_of(&ev);
        assert!(claim(&h.state.pending, &id));
        assert!(!claim(&h.state.pending, &id), "a call is claimed once");
        assert!(reply(&h.state.pending, &id, ReplyIn::Result { result: json!({"content": []}) }));
        let (status, body) = read_response(&mut s);
        assert_eq!(status, 200);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v, json!({"jsonrpc": "2.0", "id": 9, "result": {"content": []}}));
        assert!(!reply(&h.state.pending, &id, ReplyIn::NoReply), "a second reply finds nothing");
        assert!(h.events.try_recv().is_err(), "an answered call is not cancelled");
    }

    #[test]
    fn client_disconnect_emits_cancel_and_a_late_reply_writes_nothing() {
        let h = Http::start();
        let mut s = h.connect();
        s.write_all(h.request(&call_body(3, "append_note")).as_bytes()).unwrap();
        let id = call_id_of(&h.next_event());
        s.shutdown(Shutdown::Write).unwrap();
        let ev = h.events.recv_timeout(Duration::from_secs(1)).expect("mcp://cancel within 1 s of the disconnect");
        assert_eq!(ev.0, CANCEL_EVENT);
        assert_eq!(ev.1, json!({"callId": id}));
        assert!(!claim(&h.state.pending, &id));
        assert!(!reply(&h.state.pending, &id, ReplyIn::Result { result: json!({"content": []}) }));
        drop(s);
    }

    #[tokio::test(start_paused = true)]
    async fn a_rust_timeout_emits_cancel_and_a_later_claim_is_false() {
        let state = McpState::default();
        let (bridge, events, _) = test_bridge(&state);

        // A read call: ended at READ_CALL_MS.
        let h = spawn_call(bridge.clone(), "read_note", 1);
        settle().await;
        let id = call_id_of(&drain_events(&events)[0]);
        tokio::time::advance(Duration::from_millis(READ_CALL_MS - 1)).await;
        settle().await;
        assert!(!h.is_finished(), "a read call is not ended before READ_CALL_MS");
        tokio::time::advance(Duration::from_millis(1)).await;
        let v = rpc_json(h.await.unwrap());
        assert_eq!(v["error"]["code"], TIMEOUT_CODE);
        assert_eq!(v["error"]["message"], TIMEOUT_MESSAGE);
        assert_eq!(drain_events(&events), vec![(CANCEL_EVENT.to_string(), json!({"callId": id}))]);
        assert!(!claim(&state.pending, &id));

        // A mutating call: three approval windows later it is still pending.
        let h = spawn_call(bridge.clone(), "append_note", 2);
        settle().await;
        let id = call_id_of(&drain_events(&events)[0]);
        tokio::time::advance(Duration::from_secs(150)).await;
        settle().await;
        assert!(!h.is_finished());
        assert!(drain_events(&events).is_empty(), "no cancel before MUTATING_CALL_MS");
        tokio::time::advance(Duration::from_millis(MUTATING_CALL_MS - 150_000)).await;
        let v = rpc_json(h.await.unwrap());
        assert_eq!(v["error"]["code"], TIMEOUT_CODE);
        assert_eq!(drain_events(&events), vec![(CANCEL_EVENT.to_string(), json!({"callId": id}))]);
        assert!(!claim(&state.pending, &id));
        assert!(lock(&state.pending).is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_claimed_call_is_not_ended_by_the_deadline() {
        let state = McpState::default();
        let (bridge, events, _) = test_bridge(&state);
        let h = spawn_call(bridge, "read_note", 4);
        settle().await;
        let id = call_id_of(&drain_events(&events)[0]);
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(claim(&state.pending, &id));
        tokio::time::advance(Duration::from_secs(120)).await;
        settle().await;
        assert!(!h.is_finished(), "a claimed call waits for its reply");
        assert!(drain_events(&events).is_empty(), "no cancel for a claimed call");
        assert!(reply(&state.pending, &id, ReplyIn::Result { result: json!({"content": [{"type": "text", "text": "ok"}]}) }));
        let v = rpc_json(h.await.unwrap());
        assert_eq!(v["result"], json!({"content": [{"type": "text", "text": "ok"}]}));
    }

    #[tokio::test]
    async fn drain_fails_pending_calls_with_32002_and_later_claims_are_false() {
        let state = McpState::default();
        let (bridge, events, _) = test_bridge(&state);
        let a = spawn_call(bridge.clone(), "read_note", 1);
        let b = spawn_call(bridge.clone(), "append_note", 2);
        settle().await;
        let ids: Vec<String> = drain_events(&events).iter().map(call_id_of).collect();
        assert_eq!(ids.len(), 2);
        assert_eq!(drain_pending(&state), 2);
        for h in [a, b] {
            let v = rpc_json(h.await.unwrap());
            assert_eq!(v["error"]["code"], DRAINED_CODE);
            assert_eq!(v["error"]["message"], DRAINED_MESSAGE);
        }
        for id in &ids {
            assert!(!claim(&state.pending, id));
            assert!(!reply(&state.pending, id, ReplyIn::NoReply));
        }
        assert!(drain_events(&events).is_empty(), "a drain emits nothing");
        assert_eq!(drain_pending(&state), 0);
    }

    #[tokio::test]
    async fn drain_tells_a_claimed_call_its_result_is_unknown() {
        let state = McpState::default();
        let (bridge, events, _) = test_bridge(&state);
        let claimed = spawn_call(bridge.clone(), "append_note", 1);
        let waiting = spawn_call(bridge.clone(), "append_note", 2);
        settle().await;
        let ids: Vec<String> = drain_events(&events).iter().map(call_id_of).collect();
        assert_eq!(ids.len(), 2);
        // The webview won the claim for the first call: it may already be writing.
        assert!(claim(&state.pending, &ids[0]));
        assert_eq!(drain_pending(&state), 2);
        let v = rpc_json(claimed.await.unwrap());
        assert_eq!(v["error"]["code"], DRAINED_CODE);
        assert_eq!(v["error"]["message"], DRAINED_CLAIMED_MESSAGE);
        assert!(!DRAINED_CLAIMED_MESSAGE.contains("nothing was written"));
        let v = rpc_json(waiting.await.unwrap());
        assert_eq!(v["error"]["code"], DRAINED_CODE);
        assert_eq!(v["error"]["message"], DRAINED_MESSAGE);
        // A late reply for the claimed call is not delivered twice.
        assert!(!reply(&state.pending, &ids[0], ReplyIn::NoReply));
    }

    #[tokio::test]
    async fn page_load_drain_hook_fails_pending_calls() {
        let state = McpState::default();
        let (bridge, events, _) = test_bridge(&state);
        let listener = bind(0).unwrap();
        let port = listener.local_addr().unwrap().port();
        start_serving(&state, listener, catalog(), bridge.clone());
        assert_eq!(lock(&state.running).as_ref().map(|r| r.port), Some(port));
        let h = spawn_call(bridge, "append_note", 5);
        settle().await;
        assert_eq!(drain_events(&events).len(), 1);
        page_load_started(&state);
        let v = rpc_json(h.await.unwrap());
        assert_eq!(v["error"]["code"], DRAINED_CODE);
        assert!(lock(&state.running).is_none());
        assert!(lock(&state.pending).is_empty());
    }

    #[tokio::test]
    async fn attention_is_requested_only_for_mutating_calls() {
        let state = McpState::default();
        let (bridge, _events, count) = test_bridge(&state);
        let _r = spawn_call(bridge.clone(), "read_note", 1);
        settle().await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
        let _w = spawn_call(bridge.clone(), "append_note", 2);
        settle().await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drain_pending(&state);
    }

    #[tokio::test]
    async fn an_unclaimed_call_can_be_answered_without_running_a_tool() {
        let state = McpState::default();
        let (bridge, events, _) = test_bridge(&state);
        let h = spawn_call(bridge, "append_note", 6);
        settle().await;
        let id = call_id_of(&drain_events(&events)[0]);
        let denied = json!({"isError": true, "content": [{"type": "text", "text": "denied"}]});
        assert!(reply(&state.pending, &id, ReplyIn::Result { result: denied.clone() }));
        assert_eq!(rpc_json(h.await.unwrap())["result"], denied);
        assert!(!claim(&state.pending, &id), "an answered call cannot be claimed");
    }

    #[test]
    fn reply_in_reads_the_three_webview_shapes() {
        let r: ReplyIn = serde_json::from_value(json!({"kind": "result", "result": {"content": []}})).unwrap();
        assert!(matches!(CallOutcome::from(r), CallOutcome::Result(v) if v == json!({"content": []})));
        let r: ReplyIn = serde_json::from_value(json!({"kind": "error", "code": -32603, "message": "m"})).unwrap();
        assert!(matches!(CallOutcome::from(r), CallOutcome::RpcError(-32603, m) if m == "m"));
        let r: ReplyIn = serde_json::from_value(json!({"kind": "noReply"})).unwrap();
        assert!(matches!(CallOutcome::from(r), CallOutcome::NoReply));
        assert!(serde_json::from_value::<ReplyIn>(json!({"kind": "other"})).is_err());
    }

    #[test]
    fn call_ids_are_uuid_v4() {
        let a = new_call_id();
        assert_eq!(a.len(), 36);
        let parts: Vec<&str> = a.split('-').collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12]);
        assert!(parts[2].starts_with('4'));
        assert!(matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'));
        assert!(a.bytes().all(|c| c == b'-' || c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        assert_ne!(a, new_call_id());
    }

    #[test]
    fn mcp_start_accepts_only_unprivileged_ports() {
        for p in [0u16, 1, 80, 1023] {
            assert_eq!(check_port(p).unwrap_err().kind, McpErrorKind::BadInput, "{p}");
        }
        for p in [1024u16, 3987, 65535] {
            assert!(check_port(p).is_ok(), "{p}");
        }
    }

    #[test]
    fn status_never_carries_the_token() {
        let s = McpStatus { running: true, port: Some(3987), token_set: true, token_epoch: 2 };
        assert_eq!(
            serde_json::to_value(s).unwrap(),
            json!({"running": true, "port": 3987, "tokenSet": true, "tokenEpoch": 2})
        );
    }
}
