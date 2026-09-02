//! WaniKani API v2 client over an abstract [`Transport`], with pagination and one
//! retry on 429 (waiting for `RateLimit-Reset`).

use std::time::Duration;

use serde::de::DeserializeOwned;
use url::Url;

use crate::error::WkError;
use crate::model::{Collection, Envelope};

/// A bare HTTP GET. Implemented with `fetch` in the Worker and with fixtures in tests.
#[allow(async_fn_in_trait)] // single-threaded targets only; no Send bound wanted
pub trait Transport {
    async fn get(&self, url: &str, headers: &[(&str, &str)])
    -> Result<RawResponse, TransportError>;
    async fn sleep(&self, duration: Duration);
}

/// Network-level failure (DNS, TLS, timeout). HTTP statuses are not errors here.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct TransportError(pub String);

#[derive(Debug, Clone)]
pub struct RawResponse {
    pub status: u16,
    pub body: String,
    /// Unix seconds from `RateLimit-Reset`, if present.
    pub rate_limit_reset: Option<u64>,
}

pub const WK_REVISION: &str = "20170710";
const RETRY_CAP: Duration = Duration::from_secs(90);

pub struct WkApi<'t, T> {
    transport: &'t T,
    token: String,
    base: String,
    /// Unix milliseconds now, for the 429 wait computation.
    now_ms: u64,
}

impl<'t, T: Transport> WkApi<'t, T> {
    pub fn new(
        transport: &'t T,
        token: impl Into<String>,
        base: impl Into<String>,
        now_ms: u64,
    ) -> Self {
        Self {
            transport,
            token: token.into(),
            base: base.into(),
            now_ms,
        }
    }

    async fn request(&self, url: &str) -> Result<String, WkError> {
        let auth = format!("Bearer {}", self.token);
        let headers = [
            ("Authorization", auth.as_str()),
            ("Wanikani-Revision", WK_REVISION),
        ];
        let mut retried = false;
        loop {
            let res = self
                .transport
                .get(url, &headers)
                .await
                .map_err(|e| WkError::Offline(e.0))?;
            match res.status {
                200..=299 => return Ok(res.body),
                401 => return Err(WkError::Auth),
                429 if !retried => {
                    retried = true;
                    let wait = res
                        .rate_limit_reset
                        .map(|reset| {
                            Duration::from_millis(
                                (reset * 1000).saturating_sub(self.now_ms).max(1000),
                            )
                        })
                        .unwrap_or(Duration::from_secs(60));
                    self.transport.sleep(wait.min(RETRY_CAP)).await;
                }
                status => return Err(WkError::Http(status)),
            }
        }
    }

    /// Single resource, e.g. `/user`.
    pub async fn get_one<D: DeserializeOwned>(&self, path: &str) -> Result<Envelope<D>, WkError> {
        let body = self.request(&format!("{}{path}", self.base)).await?;
        Ok(serde_json::from_str(&body)?)
    }

    /// Whole collection, following `pages.next_url`.
    pub async fn get_all<D: DeserializeOwned>(
        &self,
        path: &str,
        params: &[(&str, &str)],
    ) -> Result<Vec<Envelope<D>>, WkError> {
        let mut url = Url::parse(&format!("{}{path}", self.base))
            .map_err(|e| WkError::Offline(format!("bad URL: {e}")))?;
        if !params.is_empty() {
            url.query_pairs_mut().extend_pairs(params);
        }
        let mut next = Some(url.to_string());
        let mut out = Vec::new();
        while let Some(u) = next {
            let body = self.request(&u).await?;
            let page: Collection<D> = serde_json::from_str(&body)?;
            out.extend(page.data);
            next = page.pages.next_url;
        }
        Ok(out)
    }
}
