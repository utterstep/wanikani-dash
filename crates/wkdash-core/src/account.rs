//! One WaniKani account on the server: the `/api` routes, the poll throttle and the
//! run lock. Runtime concerns (alarms, wiping storage) go through [`Runtime`].

use std::cell::Cell;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use crate::error::{ApiError, SyncError};
use crate::model::{Status, Timestamp, User};
use crate::store::{Store, StoreExt, Table};
use crate::sync::{SeedBody, meta, seed, sync};
use crate::wk::{Transport, WkApi};

pub const THROTTLE: Duration = Duration::from_secs(60);
pub const POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// What the account needs from its host: a timer for the next poll and a way to wipe itself.
#[allow(async_fn_in_trait)]
pub trait Runtime {
    async fn arm(&self, after: Duration);
    async fn disarm(&self);
    async fn destroy(&self);
}

/// An `/api` request after the Worker has authenticated it.
#[derive(Debug)]
pub struct ApiRequest<'a> {
    pub method: &'a str,
    /// Path below `/api`, e.g. `/state`.
    pub path: &'a str,
    /// The `since` query parameter, if any.
    pub since: Option<&'a str>,
    pub body: Option<String>,
}

#[derive(Debug)]
pub struct ApiResponse {
    pub status: u16,
    pub body: Value,
}

impl ApiResponse {
    fn ok(body: impl Serialize) -> Self {
        Self {
            status: 200,
            body: serde_json::to_value(body).unwrap_or(Value::Null),
        }
    }
}

impl From<ApiError> for ApiResponse {
    fn from(e: ApiError) -> Self {
        Self {
            status: e.status,
            body: json!({ "error": e.message }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountInfo {
    pub status: Status,
    pub user: Option<User>,
    pub history_since: Option<Timestamp>,
    pub last_sync: Option<Timestamp>,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    pub ran: bool,
    pub version: u64,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<crate::sync::SyncOutcome>,
}

pub struct Account<S, R, T> {
    store: S,
    runtime: R,
    transport: T,
    base: String,
    throttle: Duration,
    running: Cell<bool>,
}

impl<S: Store, R: Runtime, T: Transport> Account<S, R, T> {
    pub fn new(store: S, runtime: R, transport: T, base: impl Into<String>) -> Self {
        Self {
            store,
            runtime,
            transport,
            base: base.into(),
            throttle: THROTTLE,
            running: Cell::new(false),
        }
    }

    /// Tests and the in-page fake use a zero throttle.
    pub fn with_throttle(mut self, throttle: Duration) -> Self {
        self.throttle = throttle;
        self
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    /// Route one authenticated request. Never panics into the caller; every failure is a JSON error.
    pub async fn handle(
        &self,
        req: ApiRequest<'_>,
        user: &User,
        token: &str,
        now: Timestamp,
    ) -> ApiResponse {
        match self.route(req, user, token, now).await {
            Ok(res) => res,
            Err(e) => e.into(),
        }
    }

    async fn route(
        &self,
        req: ApiRequest<'_>,
        user: &User,
        token: &str,
        now: Timestamp,
    ) -> Result<ApiResponse, ApiError> {
        if req.method == "DELETE" && req.path == "/account" {
            self.destroy().await?;
            return Ok(ApiResponse::ok(json!({ "ok": true })));
        }
        self.ensure_token(token, user).await?;
        match (req.method, req.path) {
            ("GET", "/state") => {
                let since = req.since.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                Ok(ApiResponse::ok(self.state(since)?))
            }
            ("POST", "/sync") => Ok(ApiResponse::ok(self.run_sync(true, now).await?)),
            ("POST", "/seed") => {
                let body: SeedBody = serde_json::from_str(req.body.as_deref().unwrap_or(""))
                    .map_err(|e| ApiError::bad_request(format!("Invalid seed: {e}")))?;
                body.validate()
                    .map_err(|e| ApiError::bad_request(format!("Invalid seed: {e}")))?;
                self.seed(body, now).await
            }
            _ => Err(ApiError::not_found()),
        }
    }

    fn status(&self) -> Result<Status, ApiError> {
        Ok(self.store.get_meta(meta::STATUS)?.unwrap_or(Status::Empty))
    }

    fn version(&self) -> Result<u64, ApiError> {
        Ok(self.store.get_meta(meta::VERSION)?.unwrap_or(0))
    }

    /// Remember the token we poll with; a new token for the same account (rotation) just replaces it.
    async fn ensure_token(&self, token: &str, user: &User) -> Result<(), ApiError> {
        if self.store.get_meta::<String>(meta::TOKEN)?.as_deref() != Some(token) {
            self.store.set_meta(meta::TOKEN, &token)?;
        }
        if self.store.get_meta_raw(meta::USER)?.is_none() {
            self.store.set_meta(meta::USER, user)?;
        }
        if self.status()? == Status::AuthFailed {
            self.store.set_meta(meta::STATUS, &Status::Active)?;
            self.runtime.arm(POLL_INTERVAL).await;
        }
        Ok(())
    }

    pub fn info(&self) -> Result<AccountInfo, ApiError> {
        Ok(AccountInfo {
            status: self.status()?,
            user: self.store.get_meta(meta::USER)?,
            history_since: self.store.get_meta(meta::HISTORY_SINCE)?,
            last_sync: self.store.get_meta(meta::LAST_SYNC)?,
            version: self.version()?,
        })
    }

    /// Everything written after `since` (0 = all). A `since` beyond the current version
    /// means the account was recreated; restart from zero.
    pub fn state(&self, since: u64) -> Result<Value, ApiError> {
        let account = self.info()?;
        let since = if since > account.version { 0 } else { since };
        let mut out = serde_json::Map::new();
        out.insert(
            "account".into(),
            serde_json::to_value(&account).map_err(|e| ApiError::new(502, e.to_string()))?,
        );
        out.insert("since".into(), since.into());
        for t in Table::ALL {
            let rows = if account.status == Status::Empty {
                vec![]
            } else {
                self.store.since(t, since)?
            };
            out.insert(t.name().into(), Value::Array(rows));
        }
        Ok(Value::Object(out))
    }

    /// Poll now. `throttle` skips the run if the last one was less than a minute ago.
    /// A run already in flight is never duplicated: the caller gets `ran: false` and
    /// picks up the result on its next state pull.
    pub async fn run_sync(&self, throttle: bool, now: Timestamp) -> Result<SyncResponse, ApiError> {
        let version = self.version()?;
        let skip = SyncResponse {
            ran: false,
            version,
            outcome: None,
        };
        if self.running.get() {
            return Ok(skip);
        }
        if throttle {
            let last: Option<Timestamp> = self.store.get_meta(meta::LAST_SYNC)?;
            if let (Some(last), Some(now_t)) = (last.and_then(|l| l.parse()), now.parse())
                && (now_t - last).to_std().unwrap_or_default() < self.throttle
            {
                return Ok(skip);
            }
        }
        self.running.set(true);
        let result = self.run_locked(now).await;
        self.running.set(false);
        match result {
            Ok(outcome) => {
                self.runtime.arm(POLL_INTERVAL).await;
                Ok(SyncResponse {
                    ran: true,
                    version: outcome.version,
                    outcome: Some(outcome),
                })
            }
            Err(SyncError::Wk(crate::error::WkError::Auth)) => {
                self.store.set_meta(meta::STATUS, &Status::AuthFailed)?;
                self.runtime.disarm().await;
                Err(ApiError::unauthorized())
            }
            Err(e) => {
                if self.status()? == Status::Active {
                    self.runtime.arm(POLL_INTERVAL).await; // transient failure: keep polling
                }
                Err(e.into())
            }
        }
    }

    async fn run_locked(&self, now: Timestamp) -> Result<crate::sync::SyncOutcome, SyncError> {
        let token: String = self.store.get_meta(meta::TOKEN)?.unwrap_or_default();
        let now_ms = now
            .parse()
            .map(|t| t.timestamp_millis().max(0) as u64)
            .unwrap_or(0);
        let api = WkApi::new(&self.transport, token, self.base.clone(), now_ms);
        sync(&api, &self.store, now).await
    }

    async fn seed(&self, body: SeedBody, now: Timestamp) -> Result<ApiResponse, ApiError> {
        if self.status()? != Status::Empty {
            return Err(ApiError::conflict("Account already has data"));
        }
        let outcome = seed(&self.store, body, now)?;
        self.runtime.arm(POLL_INTERVAL).await;
        let mut body =
            serde_json::to_value(outcome).map_err(|e| ApiError::new(502, e.to_string()))?;
        body["ok"] = Value::Bool(true);
        Ok(ApiResponse { status: 200, body })
    }

    async fn destroy(&self) -> Result<(), ApiError> {
        self.runtime.disarm().await;
        self.runtime.destroy().await;
        self.store.clear()?;
        Ok(())
    }
}
