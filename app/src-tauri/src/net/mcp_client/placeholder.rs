//! Placeholder tokens (spec §6.2): example values from a README or a
//! connection snippet, such as `<YOUR_TOKEN>` or `${TOKEN}`. They are never
//! stored in the keychain; the user is asked for the real token instead.
//! Used by `mcp_client_secret_set` and by the JSON import.

/// Whole values that are placeholders (compared without case).
const NAMED: [&str; 5] = ["KBF_SSO_ACCESS_TOKEN", "TOKEN", "API_KEY", "changeme", "..."];

/// `true` when `token`, after a leading `Bearer ` and surrounding blanks are
/// stripped, is empty or looks like an example value rather than a token.
pub fn is_placeholder(token: &str) -> bool {
    let t = strip_bearer(token);
    if t.is_empty() {
        return true;
    }
    let upper = t.to_ascii_uppercase();
    // <YOUR_TOKEN>
    if t.starts_with('<') && t.ends_with('>') && !t[1..t.len() - 1].contains('>') {
        return true;
    }
    // ${TOKEN} anywhere
    if let Some(i) = t.find("${") {
        if t[i + 2..].contains('}') {
            return true;
        }
    }
    // {{token}}
    if t.len() >= 4 && t.starts_with("{{") && t.ends_with("}}") {
        return true;
    }
    // %TOKEN%
    if t.len() >= 3
        && t.starts_with('%')
        && t.ends_with('%')
        && t[1..t.len() - 1].chars().all(|c| c.is_ascii_uppercase() || c == '_')
    {
        return true;
    }
    if upper.contains("YOUR_") || upper.contains("_HERE") {
        return true;
    }
    if NAMED.iter().any(|n| t.eq_ignore_ascii_case(n)) {
        return true;
    }
    // xxx, xxxxxxxx
    if t.chars().count() >= 3 && t.chars().all(|c| c == 'x' || c == 'X') {
        return true;
    }
    // ..., …
    t.chars().all(|c| c == '.' || c == '\u{2026}') && (t.contains('\u{2026}') || t.len() >= 3)
}

/// `token` without surrounding blanks and a leading `Bearer ` (any case).
pub fn strip_bearer(token: &str) -> &str {
    let t = token.trim();
    match t.get(..7) {
        Some(head) if head.eq_ignore_ascii_case("bearer ") => t[7..].trim(),
        _ => {
            if t.eq_ignore_ascii_case("bearer") {
                ""
            } else {
                t
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_are_detected() {
        for p in [
            "<YOUR_TOKEN>",
            "<KBF_SSO_ACCESS_TOKEN>",
            "KBF_SSO_ACCESS_TOKEN",
            "kbf_sso_access_token",
            "${TOKEN}",
            "Bearer ${KBF_TOKEN}",
            "{{token}}",
            "%TOKEN%",
            "YOUR_API_KEY_HERE",
            "paste_here",
            "xxxx",
            "XXX",
            "...",
            "\u{2026}",
            "changeme",
            "TOKEN",
            "API_KEY",
            "",
            "   ",
            "Bearer ",
            "Bearer",
            "bearer <YOUR_TOKEN>",
        ] {
            assert!(is_placeholder(p), "{p:?}");
        }
    }

    #[test]
    fn real_looking_tokens_are_not_placeholders() {
        for t in [
            "test-token-123",
            "Bearer test-token-123",
            "q8ZpL3vN0rT6yW1xK4mB7cD2fH5jS9aE",
            "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl",
            "xx",
            "x1x",
            "<a>b",
            "%lower%",
        ] {
            assert!(!is_placeholder(t), "{t:?}");
        }
    }

    #[test]
    fn bearer_is_stripped_in_any_case() {
        assert_eq!(strip_bearer("  Bearer abc "), "abc");
        assert_eq!(strip_bearer("BEARER abc"), "abc");
        assert_eq!(strip_bearer("bearer   abc"), "abc");
        assert_eq!(strip_bearer("abc"), "abc");
        assert_eq!(strip_bearer("Bearerabc"), "Bearerabc");
    }
}
