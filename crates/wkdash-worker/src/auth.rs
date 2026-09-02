//! Token → WaniKani account. The dashboard is keyed by WK's stable user id, so any valid
//! token for the same account (rotation included) lands on the same data. Resolution hits
//! WK `/user` once per token and is cached for an hour in the Cache API.

use sha2::{Digest, Sha256};
use wkdash_core::{Envelope, Transport, User, WkApi, WkError};
use worker::{Cache, Headers, Request, Response};

const TTL_SECONDS: u32 = 3600;

pub fn bearer(req: &Request) -> Option<String> {
    let h = req.headers().get("Authorization").ok().flatten()?;
    let (scheme, token) = h.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty())
        .then(|| token.trim().to_owned())
}

fn cache_key(token: &str) -> String {
    format!(
        "https://wkdash.internal/token/{}",
        hex::encode(Sha256::digest(token.as_bytes()))
    )
}

pub async fn resolve_user<T: Transport>(
    token: &str,
    transport: &T,
    base: &str,
    now_ms: u64,
) -> Result<User, WkError> {
    let cache = Cache::default();
    let key = cache_key(token);
    if let Ok(Some(mut hit)) = cache.get(key.as_str(), false).await
        && let Ok(user) = hit.json::<User>().await
    {
        return Ok(user);
    }
    let user: Envelope<User> = WkApi::new(transport, token, base, now_ms)
        .get_one("/user")
        .await?;
    let user = user.data;
    let headers = Headers::new();
    let _ = headers.set("Cache-Control", &format!("max-age={TTL_SECONDS}"));
    if let Ok(res) = Response::from_json(&user) {
        let _ = cache.put(key.as_str(), res.with_headers(headers)).await; // best effort
    }
    Ok(user)
}
