//! A small Server-Sent Events parser for bfworkflow's note generation stream
//! (`json-to-notes-stream`) and the MCP client's streamable-HTTP answers. It
//! is fed text chunks as they arrive and hands back each complete frame.
//!
//! - `\r\n` is read as `\n`;
//! - a frame ends at a blank line;
//! - lines starting with `:` are comments (keepalives);
//! - several `data:` lines are joined with `\n`;
//! - a frame without `event:` is a `"message"`;
//! - a frame with no `data:` line is not dispatched;
//! - an `id:` line sets the last event id even in a frame that is not
//!   dispatched (the MCP "priming" event is an `id` with empty `data`); an id
//!   holding NUL is ignored, as the SSE rules say;
//! - a `retry:` value of ASCII digits only is kept (milliseconds).

use std::time::Duration;

/// How long the stream may stay silent (keepalive comments count as traffic).
pub const SSE_IDLE: Duration = Duration::from_secs(120);
/// How long the whole stream may last.
pub const SSE_TOTAL: Duration = Duration::from_secs(30 * 60);
/// The most an unfinished frame may hold.
pub const SSE_MAX_FRAME: usize = 1 << 20;

#[derive(Debug, PartialEq)]
pub struct SseFrame {
    pub event: String,
    pub data: String,
    /// The frame's own `id:` value, when it had one.
    pub id: Option<String>,
}

#[derive(Default)]
pub struct SseParser {
    buf: String,
    last_event_id: Option<String>,
    retry: Option<u64>,
}

impl SseParser {
    /// Adds a chunk and returns the frames it completed.
    pub fn push(&mut self, chunk: &str) -> Vec<SseFrame> {
        // A `\r\n` split across two chunks: drop the `\r` the last one ended with.
        if self.buf.ends_with('\r') && chunk.starts_with('\n') {
            self.buf.pop();
        }
        // Only the new text can hold a frame end the old text did not, so the
        // search starts at the old text's last byte (an unfinished frame is
        // not scanned again on every chunk).
        let mut from = self.buf.len().saturating_sub(1);
        self.buf.push_str(&chunk.replace("\r\n", "\n"));
        let mut frames = Vec::new();
        while let Some(pos) = self.buf.as_bytes()[from..].windows(2).position(|w| w == b"\n\n") {
            let end = from + pos;
            let block: String = self.buf.drain(..end + 2).collect();
            if let Some(frame) = self.parse_block(&block[..end]) {
                frames.push(frame);
            }
            from = 0;
        }
        frames
    }

    /// Bytes held for a frame that has not ended yet.
    pub fn pending_len(&self) -> usize {
        self.buf.len()
    }

    /// The last `id:` value seen in any completed frame, dispatched or not.
    pub fn last_event_id(&self) -> Option<&str> {
        self.last_event_id.as_deref()
    }

    /// The last `retry:` value seen, in milliseconds.
    pub fn retry(&self) -> Option<u64> {
        self.retry
    }

    /// One frame's lines (without the blank line that ended it). `None` when
    /// it holds no `data:` line (comments only, or an `id` alone).
    fn parse_block(&mut self, block: &str) -> Option<SseFrame> {
        let mut event: Option<&str> = None;
        let mut data: Option<String> = None;
        let mut id: Option<String> = None;
        for line in block.split('\n') {
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line, ""),
            };
            match field {
                "event" => event = Some(value),
                "data" => match &mut data {
                    Some(d) => {
                        d.push('\n');
                        d.push_str(value);
                    }
                    None => data = Some(value.to_string()),
                },
                "id" if !value.contains('\0') => {
                    id = Some(value.to_string());
                    self.last_event_id = Some(value.to_string());
                }
                "retry" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
                    if let Ok(ms) = value.parse() {
                        self.retry = Some(ms);
                    }
                }
                _ => {}
            }
        }
        let data = data?;
        let event = event.filter(|e| !e.is_empty()).unwrap_or("message").to_string();
        Some(SseFrame { event, data, id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(event: &str, data: &str) -> SseFrame {
        SseFrame { event: event.into(), data: data.into(), id: None }
    }

    #[test]
    fn parser_handles_split_chunks_crlf_comments_and_multiline_data() {
        let mut p = SseParser::default();
        assert!(p.push("event: progress\r\nda").is_empty());
        let f = p.push("ta: {\"step\":\"init\"}\r\n\r\n: keepalive\n\nevent: result\ndata: {\"a\":\ndata: 1}\n\n");
        assert_eq!(f, vec![frame("progress", "{\"step\":\"init\"}"), frame("result", "{\"a\":\n1}")]);
        assert_eq!(p.pending_len(), 0);
    }

    #[test]
    fn crlf_split_across_chunks_and_default_event() {
        let mut p = SseParser::default();
        assert!(p.push("data: a\r").is_empty());
        assert!(p.push("\n\r").is_empty());
        assert_eq!(p.push("\n"), vec![frame("message", "a")]);
    }

    #[test]
    fn frames_without_data_are_not_dispatched_and_unfinished_ones_wait() {
        let mut p = SseParser::default();
        assert!(p.push("event: ping\n\n").is_empty());
        assert!(p.push("data:no-space\ndata\n").is_empty());
        assert!(p.pending_len() > 0);
        assert_eq!(p.push("\n"), vec![frame("message", "no-space\n")]);
    }

    #[test]
    fn multibyte_text_is_kept() {
        let mut p = SseParser::default();
        assert_eq!(
            p.push("event: progress\ndata: {\"message\":\"노트 작성\"}\n\n"),
            vec![frame("progress", "{\"message\":\"노트 작성\"}")]
        );
    }

    #[test]
    fn id_lines_set_the_last_event_id_even_without_data() {
        let mut p = SseParser::default();
        assert_eq!(p.last_event_id(), None);
        // The MCP priming event: an id with empty data is dispatched with empty data.
        assert_eq!(
            p.push("id: e1\ndata:\n\n"),
            vec![SseFrame { event: "message".into(), data: "".into(), id: Some("e1".into()) }]
        );
        assert_eq!(p.last_event_id(), Some("e1"));
        // An id alone is not dispatched but still counts.
        assert!(p.push("id: e2\n\n").is_empty());
        assert_eq!(p.last_event_id(), Some("e2"));
        // An id holding NUL is ignored.
        assert!(p.push("id: bad\0x\n\n").is_empty());
        assert_eq!(p.last_event_id(), Some("e2"));
        // A frame without id keeps the last one and has `id: None`.
        assert_eq!(p.push("data: x\n\n")[0].id, None);
        assert_eq!(p.last_event_id(), Some("e2"));
    }

    #[test]
    fn retry_keeps_digit_only_values() {
        let mut p = SseParser::default();
        assert!(p.push("retry: 1500\n\n").is_empty());
        assert_eq!(p.retry(), Some(1500));
        assert!(p.push("retry: 2s\n\nretry:\n\n").is_empty());
        assert_eq!(p.retry(), Some(1500));
        p.push("retry: 30\r\n\r\n");
        assert_eq!(p.retry(), Some(30));
    }
}
