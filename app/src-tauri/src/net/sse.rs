//! A small Server-Sent Events parser for bfworkflow's note generation stream
//! (`json-to-notes-stream`). It is fed text chunks as they arrive and hands
//! back each complete frame.
//!
//! - `\r\n` is read as `\n`;
//! - a frame ends at a blank line;
//! - lines starting with `:` are comments (keepalives);
//! - several `data:` lines are joined with `\n`;
//! - a frame without `event:` is a `"message"`;
//! - a frame with no `data:` line is not dispatched.

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
}

#[derive(Default)]
pub struct SseParser {
    buf: String,
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
            if let Some(frame) = parse_block(&block[..end]) {
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
}

/// One frame's lines (without the blank line that ended it). `None` when it
/// holds no `data:` line (comments only, say).
fn parse_block(block: &str) -> Option<SseFrame> {
    let mut event: Option<&str> = None;
    let mut data: Option<String> = None;
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
            _ => {}
        }
    }
    let data = data?;
    let event = event.filter(|e| !e.is_empty()).unwrap_or("message").to_string();
    Some(SseFrame { event, data })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_handles_split_chunks_crlf_comments_and_multiline_data() {
        let mut p = SseParser::default();
        assert!(p.push("event: progress\r\nda").is_empty());
        let f = p.push("ta: {\"step\":\"init\"}\r\n\r\n: keepalive\n\nevent: result\ndata: {\"a\":\ndata: 1}\n\n");
        assert_eq!(
            f,
            vec![
                SseFrame { event: "progress".into(), data: "{\"step\":\"init\"}".into() },
                SseFrame { event: "result".into(), data: "{\"a\":\n1}".into() },
            ]
        );
        assert_eq!(p.pending_len(), 0);
    }

    #[test]
    fn crlf_split_across_chunks_and_default_event() {
        let mut p = SseParser::default();
        assert!(p.push("data: a\r").is_empty());
        assert!(p.push("\n\r").is_empty());
        assert_eq!(p.push("\n"), vec![SseFrame { event: "message".into(), data: "a".into() }]);
    }

    #[test]
    fn frames_without_data_are_not_dispatched_and_unfinished_ones_wait() {
        let mut p = SseParser::default();
        assert!(p.push("event: ping\n\n").is_empty());
        assert!(p.push("data:no-space\ndata\n").is_empty());
        assert!(p.pending_len() > 0);
        assert_eq!(p.push("\n"), vec![SseFrame { event: "message".into(), data: "no-space\n".into() }]);
    }

    #[test]
    fn multibyte_text_is_kept() {
        let mut p = SseParser::default();
        assert_eq!(
            p.push("event: progress\ndata: {\"message\":\"노트 작성\"}\n\n"),
            vec![SseFrame { event: "progress".into(), data: "{\"message\":\"노트 작성\"}".into() }]
        );
    }
}
