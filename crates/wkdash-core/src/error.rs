//! Typed errors. Each layer has its own enum; [`ApiError`] is the boundary type that
//! becomes an HTTP status and a public message, while the inner variants keep detail.

use thiserror::Error;

/// Failure talking to WaniKani.
#[derive(Debug, Error)]
pub enum WkError {
    #[error("WaniKani rejected the token")]
    Auth,
    #[error("WaniKani unreachable: {0}")]
    Offline(String),
    #[error("WaniKani returned HTTP {0}")]
    Http(u16),
    #[error("WaniKani returned invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
}

/// Failure of the persistence backend.
#[derive(Debug, Error)]
pub enum StoreError {
    #[error("storage backend failed: {0}")]
    Backend(String),
    #[error("stored row is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
}

impl StoreError {
    pub fn backend(msg: impl Into<String>) -> Self {
        Self::Backend(msg.into())
    }
}

/// Failure of a sync run.
#[derive(Debug, Error)]
pub enum SyncError {
    #[error(transparent)]
    Wk(#[from] WkError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// What an `/api` caller sees: a status code and a one-line message.
#[derive(Debug, Error)]
#[error("{message}")]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    pub fn unauthorized() -> Self {
        Self::new(401, "WaniKani rejected the token")
    }

    pub fn not_found() -> Self {
        Self::new(404, "Not found")
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, message)
    }
}

impl From<SyncError> for ApiError {
    fn from(err: SyncError) -> Self {
        match err {
            SyncError::Wk(WkError::Auth) => Self::unauthorized(),
            other => Self::new(502, other.to_string()),
        }
    }
}

impl From<StoreError> for ApiError {
    fn from(err: StoreError) -> Self {
        Self::new(502, err.to_string())
    }
}
