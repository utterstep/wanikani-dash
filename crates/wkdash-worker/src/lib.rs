//! Worker entry: static assets from `public/` plus `/api/*` routed to the caller's
//! Account Durable Object. Free-plan Workers get 10 ms CPU per request, so this layer
//! only authenticates and forwards; bodies stream through untouched.

mod auth;
mod durable;
mod sql_store;
mod transport;

use wkdash_core::{WkError, cors_headers};
use worker::{Context, Env, Headers, Request, Response, Result, event};

pub use durable::AccountDO;

use crate::transport::WorkerTransport;

fn json_error(message: &str, status: u16) -> Result<Response> {
    Ok(Response::from_json(&serde_json::json!({ "error": message }))?.with_status(status))
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();
    if !req.path().starts_with("/api/") {
        return env.assets("ASSETS")?.fetch_request(req).await;
    }
    let allowed = env
        .var("ALLOWED_ORIGINS")
        .map(|v| v.to_string())
        .unwrap_or_default();
    let cors = cors_headers(req.headers().get("Origin")?.as_deref(), &allowed);
    if req.method() == worker::Method::Options {
        let (status, headers) = match &cors {
            Some(h) => (204, to_headers(h)?),
            None => (403, Headers::new()),
        };
        return Ok(Response::empty()?.with_status(status).with_headers(headers));
    }
    let res = handle_api(req, &env).await?;
    match cors {
        Some(h) => with_cors(res, &h),
        None => Ok(res),
    }
}

/// Responses coming back from the Durable Object are immutable; rebuild around the same body.
fn with_cors(mut res: Response, cors: &[(&'static str, String)]) -> Result<Response> {
    let headers = res.headers().clone();
    for (k, v) in cors {
        headers.set(k, v)?;
    }
    let status = res.status_code();
    let stream = res.stream()?;
    Ok(Response::from_stream(stream)?
        .with_status(status)
        .with_headers(headers))
}

fn to_headers(pairs: &[(&'static str, String)]) -> Result<Headers> {
    let h = Headers::new();
    for (k, v) in pairs {
        h.set(k, v)?;
    }
    Ok(h)
}

async fn handle_api(req: Request, env: &Env) -> Result<Response> {
    let Some(token) = auth::bearer(&req) else {
        return json_error("Missing Authorization: Bearer <WaniKani token>", 401);
    };
    let base = env
        .var("WK_API_BASE")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "https://api.wanikani.com/v2".to_owned());
    let now_ms = worker::Date::now().as_millis();
    let user = match auth::resolve_user(&token, &WorkerTransport, &base, now_ms).await {
        Ok(u) => u,
        Err(WkError::Auth) => return json_error("WaniKani rejected the token", 401),
        Err(e) => {
            worker::console_error!("auth failed: {e}");
            return json_error(&e.to_string(), 502);
        }
    };
    let stub = env
        .durable_object("ACCOUNT")?
        .id_from_name(&user.id)?
        .get_stub()?;
    let fwd = req.clone_mut()?;
    fwd.headers()
        .set(durable::USER_HEADER, &serde_json::to_string(&user)?)?;
    fwd.headers().set(durable::TOKEN_HEADER, &token)?;
    stub.fetch_with_request(fwd).await
}
