//! Copying the MCP token from Rust (C5): the webview never sees it. The copy
//! is kept out of Win+V history and the cloud clipboard, and cleared 60 s
//! later if the clipboard still holds it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::{McpError, McpErrorKind};

/// The system clipboard, or a fake in tests (never the real one).
pub trait Clipboard: Send + Sync {
    /// Puts a secret on the clipboard, kept out of clipboard history.
    fn set_secret(&self, text: &str) -> Result<(), McpError>;
    /// The clipboard's text, if it holds text.
    fn get(&self) -> Option<String>;
    /// Empties the clipboard.
    fn clear(&self);
}

/// The managed clipboard every command uses.
pub struct ClipState(pub Arc<dyn Clipboard>);

/// The Windows clipboard through `arboard`. Errors never carry arboard's own
/// text, so nothing it might echo reaches the webview.
pub struct ArboardClipboard;

fn clipboard_error() -> McpError {
    McpError::new(McpErrorKind::Clipboard, "the clipboard could not be written")
}

impl Clipboard for ArboardClipboard {
    fn set_secret(&self, text: &str) -> Result<(), McpError> {
        let mut cb = arboard::Clipboard::new().map_err(|_| clipboard_error())?;
        let set = cb.set();
        #[cfg(windows)]
        let set = {
            use arboard::SetExtWindows;
            set.exclude_from_history().exclude_from_cloud()
        };
        set.text(text).map_err(|_| clipboard_error())
    }
    fn get(&self) -> Option<String> {
        arboard::Clipboard::new().ok()?.get_text().ok()
    }
    fn clear(&self) {
        if let Ok(mut cb) = arboard::Clipboard::new() {
            let _ = cb.clear();
        }
    }
}

/// An in-memory clipboard for tests.
#[derive(Default)]
pub struct FakeClipboard(Mutex<Option<String>>);

impl Clipboard for FakeClipboard {
    fn set_secret(&self, text: &str) -> Result<(), McpError> {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(text.to_string());
        Ok(())
    }
    fn get(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn clear(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Waits `after`, then clears the clipboard only if it still holds `token`
/// (something the user copied since is left alone).
pub async fn clear_if_unchanged_after(clip: Arc<dyn Clipboard>, token: String, after: Duration) {
    tokio::time::sleep(after).await;
    if clip.get().as_deref() == Some(token.as_str()) {
        clip.clear();
    }
}

/// Sets the clipboard to `token`, then clears it after `after` if unchanged.
/// A clipboard that cannot be written is left as it was.
pub async fn copy_then_clear(clip: Arc<dyn Clipboard>, token: String, after: Duration) {
    if clip.set_secret(&token).is_ok() {
        clear_if_unchanged_after(clip, token, after).await;
    }
}

/// The longest clipboard text handed out as a labnoteO link.
pub const LINK_MAX: usize = 8192;

/// `text`, trimmed, when it is shaped like a labnoteO link
/// (`obsidian://labnoteo-import|open…` or `labnoteo://import|open…`, no
/// whitespace or control characters, at most `LINK_MAX` bytes); otherwise
/// `None`. The webview parses the link itself: this only keeps any other
/// clipboard text (a copied MCP token, a password) from reaching it.
pub fn labnoteo_link(text: &str) -> Option<String> {
    let link = text.trim();
    if link.is_empty() || link.len() > LINK_MAX || link.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let lower = link.to_ascii_lowercase();
    let rest = ["obsidian://labnoteo-import", "obsidian://labnoteo-open", "labnoteo://import", "labnoteo://open"]
        .iter()
        .find_map(|p| lower.strip_prefix(p))?;
    (rest.is_empty() || rest.starts_with(['/', '?', '#'])).then(|| link.to_string())
}

/// The clipboard's text when it is a labnoteO link (`labnoteo_link`).
pub fn clipboard_link(clip: &dyn Clipboard) -> Option<String> {
    labnoteo_link(&clip.get()?)
}

/// "Open labnoteO link" prefills its prompt from this (SP6 D14). The web
/// clipboard (`navigator.clipboard.readText`) would make WebView2 ask for a
/// permission first, so Rust reads it, and hands out only a link.
#[tauri::command]
pub fn clipboard_labnoteo_link(clip: tauri::State<'_, ClipState>) -> Option<String> {
    clipboard_link(clip.0.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn only_text_shaped_like_a_labnoteo_link_is_handed_out() {
        for (text, want) in [
            ("obsidian://labnoteo-import?type=part&id=1", Some("obsidian://labnoteo-import?type=part&id=1")),
            ("  OBSIDIAN://LABNOTEO-OPEN?file=a.md

", Some("OBSIDIAN://LABNOTEO-OPEN?file=a.md")),
            ("labnoteo://import?x=1", Some("labnoteo://import?x=1")),
            ("labnoteo://open/?file=a.md#L3", Some("labnoteo://open/?file=a.md#L3")),
            ("labnoteo://open", Some("labnoteo://open")),
        ] {
            assert_eq!(labnoteo_link(text).as_deref(), want, "{text}");
        }
        for text in [
            "",
            "a".repeat(48).as_str(),
            "claude mcp add --header \"Authorization: Bearer abc\"",
            "see obsidian://labnoteo-import?type=part",
            "obsidian://labnoteo-import?type=part extra",
            "obsidian://labnoteo-importx?type=part",
            "obsidian://labnoteo-delete?file=a.md",
            "https://example.com/?x=obsidian://labnoteo-open",
            &format!("labnoteo://open?file={}", "a".repeat(LINK_MAX)),
        ] {
            assert_eq!(labnoteo_link(text), None, "{text}");
        }
        let clip = FakeClipboard::default();
        assert_eq!(clipboard_link(&clip), None);
        clip.set_secret(" labnoteo://open?file=a.md ").unwrap();
        assert_eq!(clipboard_link(&clip).as_deref(), Some("labnoteo://open?file=a.md"));
        clip.set_secret(&"f".repeat(48)).unwrap();
        assert_eq!(clipboard_link(&clip), None);
    }

    #[tokio::test(start_paused = true)] async fn copy_sets_clipboard_and_clears_after_60s_only_if_unchanged() {
        let clip: Arc<FakeClipboard> = Arc::default();
        let h = tokio::spawn(copy_then_clear(clip.clone(), "t".repeat(48), Duration::from_secs(60)));
        tokio::task::yield_now().await; assert_eq!(clip.get().as_deref(), Some("t".repeat(48).as_str()));
        tokio::time::advance(Duration::from_secs(59)).await; tokio::task::yield_now().await;
        assert_eq!(clip.get().as_deref(), Some("t".repeat(48).as_str()));
        tokio::time::advance(Duration::from_secs(1)).await; h.await.unwrap(); assert_eq!(clip.get(), None);
        let h = tokio::spawn(copy_then_clear(clip.clone(), "t".repeat(48), Duration::from_secs(60)));
        tokio::task::yield_now().await; clip.set_secret("other").unwrap();
        tokio::time::advance(Duration::from_secs(60)).await; h.await.unwrap(); assert_eq!(clip.get().as_deref(), Some("other"));
    }
}
