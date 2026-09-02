//! The Durable Object: one per WaniKani account (named by WK user id). Holds the
//! snapshot and derived history in SQLite and polls WK on a self-re-armed alarm.

use std::rc::Rc;
use std::time::Duration;

use wkdash_core::{Account, ApiRequest, Runtime, Timestamp, User};
use worker::{Date, DurableObject, Env, Request, Response, Result, State, durable_object};

use crate::sql_store::SqlStore;
use crate::transport::WorkerTransport;

pub const USER_HEADER: &str = "X-WK-User";
pub const TOKEN_HEADER: &str = "X-WK-Token";

pub fn now() -> Timestamp {
    let ms = Date::now().as_millis() as i64;
    chrono::DateTime::from_timestamp_millis(ms)
        .map(Timestamp::from_datetime)
        .unwrap_or_else(|| Timestamp::from("1970-01-01T00:00:00.000Z"))
}

/// Alarms and wiping go through the object's own storage.
pub struct DoRuntime {
    state: Rc<State>,
}

impl Runtime for DoRuntime {
    async fn arm(&self, after: Duration) {
        if let Err(e) = self.state.storage().set_alarm(after).await {
            worker::console_error!("set_alarm failed: {e}");
        }
    }

    async fn disarm(&self) {
        if let Err(e) = self.state.storage().delete_alarm().await {
            worker::console_error!("delete_alarm failed: {e}");
        }
    }

    async fn destroy(&self) {
        if let Err(e) = self.state.storage().delete_all().await {
            worker::console_error!("delete_all failed: {e}");
        }
    }
}

#[durable_object]
pub struct AccountDO {
    account: Account<SqlStore, DoRuntime, WorkerTransport>,
}

impl DurableObject for AccountDO {
    fn new(state: State, env: Env) -> Self {
        console_error_panic_hook::set_once();
        let state = Rc::new(state);
        let store = SqlStore::new(state.storage().sql()).expect("create account tables");
        let base = env
            .var("WK_API_BASE")
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "https://api.wanikani.com/v2".to_owned());
        Self {
            account: Account::new(store, DoRuntime { state }, WorkerTransport, base),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let user: User = match req
            .headers()
            .get(USER_HEADER)?
            .and_then(|v| serde_json::from_str(&v).ok())
        {
            Some(u) => u,
            None => return Response::error("missing user", 500),
        };
        let token = req.headers().get(TOKEN_HEADER)?.unwrap_or_default();
        let method = req.method().to_string();
        let url = req.url()?;
        let path = url.path().trim_start_matches("/api").to_owned();
        let since = url
            .query_pairs()
            .find(|(k, _)| k == "since")
            .map(|(_, v)| v.into_owned());
        let body = if method == "POST" {
            Some(req.text().await?)
        } else {
            None
        };
        let api_req = ApiRequest {
            method: &method,
            path: &path,
            since: since.as_deref(),
            body,
        };
        let res = self.account.handle(api_req, &user, &token, now()).await;
        Ok(Response::from_json(&res.body)?.with_status(res.status))
    }

    async fn alarm(&self) -> Result<Response> {
        if let Err(e) = self.account.run_sync(false, now()).await {
            worker::console_error!("poll failed: {e}"); // run_sync re-arms unless the token died
        }
        Response::empty()
    }
}
