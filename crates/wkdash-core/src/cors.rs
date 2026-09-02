//! CORS for the one cross-origin caller: the old GitHub Pages page uploading history.

/// Response headers to add when `origin` is allowed; `None` otherwise.
pub fn cors_headers(origin: Option<&str>, allowed: &str) -> Option<Vec<(&'static str, String)>> {
    let origin = origin?;
    allowed
        .split(',')
        .map(str::trim)
        .any(|a| !a.is_empty() && a == origin)
        .then(|| {
            vec![
                ("Access-Control-Allow-Origin", origin.to_owned()),
                (
                    "Access-Control-Allow-Methods",
                    "GET, POST, DELETE, OPTIONS".to_owned(),
                ),
                (
                    "Access-Control-Allow-Headers",
                    "Authorization, Content-Type".to_owned(),
                ),
                ("Access-Control-Max-Age", "86400".to_owned()),
                ("Vary", "Origin".to_owned()),
            ]
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_listed_origins() {
        let allowed = "https://utterstep.github.io, https://localhost:8000";
        assert!(cors_headers(Some("https://utterstep.github.io"), allowed).is_some());
        assert!(cors_headers(Some("https://localhost:8000"), allowed).is_some());
        assert!(cors_headers(Some("https://evil.example"), allowed).is_none());
        assert!(cors_headers(None, allowed).is_none());
        assert!(cors_headers(Some(""), "").is_none());
    }
}
