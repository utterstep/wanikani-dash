//! Server-side logic of the WaniKani dashboard, independent of any runtime.
//!
//! One [`Account`] per WaniKani user owns a snapshot of the user's assignments and
//! review statistics plus the history derived from it. Every poll fetches what changed
//! from WaniKani, diffs it against the snapshot ([`diff`]) and appends events ([`sync`]).
//! Storage and I/O are traits ([`Store`], [`Transport`], [`Runtime`]) so the same code
//! runs inside a Cloudflare Durable Object and, with in-memory implementations, in
//! ordinary `cargo nextest` tests:
//!
//! ```no_run
//! # use wkdash_core::*;
//! # async fn demo<T: Transport, R: Runtime>(transport: T, runtime: R, user: User, now: Timestamp) {
//! let account = Account::new(MemStore::default(), runtime, transport, "https://api.wanikani.com/v2");
//! let req = ApiRequest { method: "POST", path: "/sync", since: None, body: None };
//! let res = account.handle(req, &user, "wk-token", now).await;
//! assert_eq!(res.status, 200);
//! # }
//! ```

pub mod account;
pub mod cors;
pub mod diff;
pub mod error;
pub mod model;
pub mod store;
pub mod sync;
pub mod wk;

pub use account::*;
pub use cors::*;
pub use error::*;
pub use model::*;
pub use store::*;
pub use sync::*;
pub use wk::*;
