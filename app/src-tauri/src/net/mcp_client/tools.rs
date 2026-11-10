//! Sanitising what an MCP server says about its tools and what a tool call
//! returns (spec §4.3). All of it is server text, so it is untrusted: every
//! string is capped, the schema is size-checked, and a result keeps only text
//! (images, audio and blobs are replaced by a short marker).

use serde::Serialize;
use serde_json::Value;

/// The longest tool name kept (MCP 2025-11-25: 1 to 128 chars).
pub const MAX_NAME: usize = 128;
/// The longest tool title kept.
pub const MAX_TITLE: usize = 200;
/// The longest tool description kept (to the UI and the model).
pub const MAX_DESCRIPTION: usize = 1000;
/// The largest `inputSchema` (serialised bytes) a tool may have and still be usable.
pub const MAX_SCHEMA: usize = 16 * 1024;
/// The most text of a tool result the model gets.
pub const MAX_RESULT_CHARS: usize = 12_000;

/// One tool as the app shows and uses it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub description: String,
    pub read_only: bool,
    pub destructive: bool,
    pub open_world: bool,
    /// `None` when the schema is too large or not an object schema.
    pub input_schema: Option<Value>,
    /// The tool is listed but cannot be enabled.
    pub too_large: bool,
}

/// A compacted `tools/call` result.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallResult {
    pub text: String,
    pub is_error: bool,
    pub truncated: bool,
    /// How many non-text content items were left out.
    pub omitted: u32,
}

/// The first `max` chars of `s`.
pub fn cap(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// A name the agent can address: 1 to 128 chars of `A-Z a-z 0-9 _ - .`.
fn usable_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_NAME
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn hint(annotations: Option<&Value>, key: &str, default: bool) -> bool {
    annotations.and_then(|a| a.get(key)).and_then(Value::as_bool).unwrap_or(default)
}

/// One entry of a `tools/list` answer, or `None` when it has no usable name.
/// Hints follow the MCP defaults: not read-only, destructive and open-world
/// unless the server says otherwise; a read-only tool is never destructive.
pub fn sanitize_tool(raw: &Value) -> Option<McpToolInfo> {
    let name = raw.get("name")?.as_str()?;
    if !usable_name(name) {
        return None;
    }
    let title = raw
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| raw.pointer("/annotations/title").and_then(Value::as_str))
        .filter(|t| !t.trim().is_empty())
        .map(|t| cap(t, MAX_TITLE));
    let description = cap(raw.get("description").and_then(Value::as_str).unwrap_or(""), MAX_DESCRIPTION);
    let annotations = raw.get("annotations").filter(|a| a.is_object());
    let read_only = hint(annotations, "readOnlyHint", false);
    let destructive = !read_only && hint(annotations, "destructiveHint", true);
    let open_world = hint(annotations, "openWorldHint", true);
    let schema = raw.get("inputSchema");
    let usable = schema.filter(|s| {
        s.is_object()
            && s.get("type").and_then(Value::as_str) == Some("object")
            && serde_json::to_vec(s).map(|b| b.len() <= MAX_SCHEMA).unwrap_or(false)
    });
    Some(McpToolInfo {
        name: name.to_string(),
        title,
        description,
        read_only,
        destructive,
        open_world,
        input_schema: usable.cloned(),
        too_large: usable.is_none(),
    })
}

/// A `tools/call` result as text for the model: text items joined by
/// newlines, embedded text resources kept, `resource_link` as name + URI,
/// everything else replaced by `[<kind> omitted]`. With no content,
/// `structuredContent` is used as JSON. Cut at `cap_chars`.
pub fn compact_result(raw: &Value, cap_chars: usize) -> McpCallResult {
    let mut parts: Vec<String> = Vec::new();
    let mut omitted = 0u32;
    let content = raw.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
    for item in &content {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "text" => parts.push(item.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
            "resource_link" => {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("");
                let uri = item.get("uri").and_then(Value::as_str).unwrap_or("");
                parts.push(format!("[link: {} {}]", cap(name, MAX_TITLE), cap(uri, 2048)));
            }
            "resource" => match item.pointer("/resource/text").and_then(Value::as_str) {
                Some(t) => parts.push(t.to_string()),
                None => {
                    omitted += 1;
                    parts.push("[resource omitted]".into());
                }
            },
            "image" | "audio" => {
                omitted += 1;
                parts.push(format!("[{kind} omitted]"));
            }
            _ => {
                omitted += 1;
                parts.push("[content omitted]".into());
            }
        }
    }
    if content.is_empty() {
        if let Some(s) = raw.get("structuredContent").filter(|v| !v.is_null()) {
            parts.push(s.to_string());
        }
    }
    let joined = parts.join("\n");
    let truncated = joined.chars().count() > cap_chars;
    McpCallResult {
        text: if truncated { cap(&joined, cap_chars) } else { joined },
        is_error: raw.get("isError").and_then(Value::as_bool).unwrap_or(false),
        truncated,
        omitted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hints_follow_the_mcp_defaults() {
        let t = sanitize_tool(&json!({"name": "a", "inputSchema": {"type": "object"}})).unwrap();
        assert!(!t.read_only && t.destructive && t.open_world && !t.too_large);
        let t = sanitize_tool(&json!({"name": "b", "inputSchema": {"type": "object"},
            "annotations": {"readOnlyHint": true, "destructiveHint": true, "openWorldHint": false}}))
        .unwrap();
        assert!(t.read_only && !t.destructive && !t.open_world);
        let t = sanitize_tool(&json!({"name": "c", "inputSchema": {"type": "object"},
            "annotations": {"destructiveHint": false}}))
        .unwrap();
        assert!(!t.read_only && !t.destructive);
    }

    #[test]
    fn names_titles_and_descriptions_are_checked_and_capped() {
        assert!(sanitize_tool(&json!({"inputSchema": {"type": "object"}})).is_none());
        assert!(sanitize_tool(&json!({"name": ""})).is_none());
        assert!(sanitize_tool(&json!({"name": "has space"})).is_none());
        assert!(sanitize_tool(&json!({"name": "x".repeat(129)})).is_none());
        assert!(sanitize_tool(&json!({"name": 5})).is_none());
        let t = sanitize_tool(&json!({"name": "get_part.v2-x", "title": "T".repeat(500),
            "description": "d".repeat(5000)}))
        .unwrap();
        assert_eq!(t.title.unwrap().chars().count(), MAX_TITLE);
        assert_eq!(t.description.chars().count(), MAX_DESCRIPTION);
        let t = sanitize_tool(&json!({"name": "a", "annotations": {"title": "From annotations"}})).unwrap();
        assert_eq!(t.title.as_deref(), Some("From annotations"));
    }

    #[test]
    fn schemas_must_be_small_object_schemas() {
        let big = json!({"name": "a", "inputSchema": {"type": "object", "description": "x".repeat(17_000)}});
        let t = sanitize_tool(&big).unwrap();
        assert!(t.too_large && t.input_schema.is_none());
        for schema in [json!({"type": "string"}), json!({}), json!("object"), Value::Null] {
            let t = sanitize_tool(&json!({"name": "a", "inputSchema": schema})).unwrap();
            assert!(t.too_large && t.input_schema.is_none(), "{schema}");
        }
        let t = sanitize_tool(&json!({"name": "a"})).unwrap();
        assert!(t.too_large);
        let schema = json!({"type": "object", "properties": {"q": {"type": "string"}}});
        let t = sanitize_tool(&json!({"name": "a", "inputSchema": schema})).unwrap();
        assert_eq!(t.input_schema, Some(schema));
    }

    #[test]
    fn results_keep_text_and_mark_the_rest() {
        let r = compact_result(
            &json!({"content": [
                {"type": "text", "text": "one"},
                {"type": "image", "data": "AAAA", "mimeType": "image/png"},
                {"type": "audio", "data": "AAAA"},
                {"type": "resource_link", "name": "doc", "uri": "https://x.test/doc"},
                {"type": "resource", "resource": {"uri": "a", "text": "inline"}},
                {"type": "resource", "resource": {"uri": "b", "blob": "AAAA"}},
                {"type": "weird"},
                {"type": "text", "text": "two"}
            ]}),
            MAX_RESULT_CHARS,
        );
        assert_eq!(
            r.text,
            "one\n[image omitted]\n[audio omitted]\n[link: doc https://x.test/doc]\ninline\n[resource omitted]\n[content omitted]\ntwo"
        );
        assert_eq!((r.omitted, r.truncated, r.is_error), (4, false, false));
        assert!(!r.text.contains("AAAA"));
    }

    #[test]
    fn results_are_cut_and_carry_is_error_and_structured_content() {
        let r = compact_result(&json!({"content": [{"type": "text", "text": "é".repeat(50_000)}]}), MAX_RESULT_CHARS);
        assert!(r.truncated);
        assert_eq!(r.text.chars().count(), MAX_RESULT_CHARS);
        let r = compact_result(&json!({"isError": true, "content": [{"type": "text", "text": "bad"}]}), 100);
        assert!(r.is_error);
        assert_eq!(r.text, "bad");
        let r = compact_result(&json!({"structuredContent": {"n": 1}}), 100);
        assert_eq!(r.text, "{\"n\":1}");
        let r = compact_result(&json!({}), 100);
        assert_eq!((r.text.as_str(), r.omitted), ("", 0));
    }
}
