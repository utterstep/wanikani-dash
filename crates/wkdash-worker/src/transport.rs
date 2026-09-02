//! [`Transport`] over the Workers `fetch`.

use std::time::Duration;

use wkdash_core::{RawResponse, Transport, TransportError};
use worker::{Delay, Fetch, Headers, Method, Request, RequestInit};

#[derive(Debug, Clone, Copy, Default)]
pub struct WorkerTransport;

impl Transport for WorkerTransport {
    async fn get(
        &self,
        url: &str,
        headers: &[(&str, &str)],
    ) -> Result<RawResponse, TransportError> {
        let h = Headers::new();
        for (k, v) in headers {
            h.set(k, v).map_err(|e| TransportError(e.to_string()))?;
        }
        let mut init = RequestInit::new();
        init.with_method(Method::Get).with_headers(h);
        let req = Request::new_with_init(url, &init).map_err(|e| TransportError(e.to_string()))?;
        let mut res = Fetch::Request(req)
            .send()
            .await
            .map_err(|e| TransportError(e.to_string()))?;
        let rate_limit_reset = res
            .headers()
            .get("RateLimit-Reset")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok());
        let body = res
            .text()
            .await
            .map_err(|e| TransportError(e.to_string()))?;
        Ok(RawResponse {
            status: res.status_code(),
            body,
            rate_limit_reset,
        })
    }

    async fn sleep(&self, duration: Duration) {
        Delay::from(duration).await;
    }
}
