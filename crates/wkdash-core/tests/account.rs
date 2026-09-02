//! The account logic end to end over the in-memory store, with WaniKani played by the
//! shared JSON fixtures (tests/fixtures/synthetic-{a,b}.json, exported from the JS suite).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use futures::executor::block_on;
use serde_json::{Value, json};
use url::Url;
use wkdash_core::*;

const FIXTURE_A: &str = include_str!("../../../tests/fixtures/synthetic-a.json");
const FIXTURE_B: &str = include_str!("../../../tests/fixtures/synthetic-b.json");
const NOW_A: &str = "2026-08-20T10:00:00.000Z";
const NOW_B: &str = "2026-08-22T09:00:00.000Z";
const BASE: &str = "https://api.wanikani.com/v2";

/// Fixture-backed WaniKani: same pagination and token rules as tests/mock-api.js.
#[derive(Clone)]
struct FixtureWk {
    data: Rc<RefCell<Value>>,
    page_size: usize,
    log: Rc<RefCell<Vec<String>>>,
}

impl FixtureWk {
    fn new(scenario: &str) -> Self {
        Self {
            data: Rc::new(RefCell::new(load(scenario))),
            page_size: 500,
            log: Rc::default(),
        }
    }

    fn switch(&self, scenario: &str) {
        *self.data.borrow_mut() = load(scenario);
    }
}

fn load(scenario: &str) -> Value {
    serde_json::from_str(if scenario == "a" {
        FIXTURE_A
    } else {
        FIXTURE_B
    })
    .expect("fixture json")
}

fn text(status: u16, body: Value) -> RawResponse {
    RawResponse {
        status,
        body: body.to_string(),
        rate_limit_reset: None,
    }
}

impl Transport for FixtureWk {
    async fn get(
        &self,
        url: &str,
        headers: &[(&str, &str)],
    ) -> Result<RawResponse, TransportError> {
        self.log.borrow_mut().push(url.to_owned());
        let u = Url::parse(url).expect("fixture url");
        let token = headers
            .iter()
            .find(|(k, _)| *k == "Authorization")
            .map(|(_, v)| v.trim_start_matches("Bearer "))
            .unwrap_or("");
        let path = u.path().trim_start_matches("/v2/").to_owned();
        let valid = token == "test-token"
            || token == "dying-token"
            || (token.len() == 36 && token.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        if !valid || (token == "dying-token" && path != "user") {
            return Ok(text(401, json!({ "error": "Unauthorized", "code": 401 })));
        }
        let data = self.data.borrow();
        if path == "user" {
            return Ok(text(200, data["user"].clone()));
        }
        let Some(rows) = data.get(&path).and_then(Value::as_array) else {
            return Ok(text(404, json!({ "error": "Not Found" })));
        };
        let after = u
            .query_pairs()
            .find(|(k, _)| k == "updated_after")
            .map(|(_, v)| v.to_string());
        let after_id: i64 = u
            .query_pairs()
            .find(|(k, _)| k == "page_after_id")
            .and_then(|(_, v)| v.parse().ok())
            .unwrap_or(-1);
        let mut filtered: Vec<&Value> = rows
            .iter()
            .filter(|r| {
                after
                    .as_deref()
                    .is_none_or(|a| r["data_updated_at"].as_str().unwrap_or("") > a)
            })
            .collect();
        filtered.sort_by_key(|r| r["id"].as_i64());
        let page: Vec<&Value> = filtered
            .iter()
            .copied()
            .filter(|r| r["id"].as_i64().unwrap_or(0) > after_id)
            .take(self.page_size)
            .collect();
        let last = page.last().and_then(|r| r["id"].as_i64());
        let has_more =
            last.is_some_and(|l| filtered.iter().any(|r| r["id"].as_i64().unwrap_or(0) > l));
        let kept: Vec<(String, String)> = u
            .query_pairs()
            .filter(|(k, _)| k != "page_after_id")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let mut next = u.clone();
        next.query_pairs_mut()
            .clear()
            .extend_pairs(kept)
            .append_pair("page_after_id", &last.unwrap_or(0).to_string());
        Ok(text(
            200,
            json!({ "object": "collection", "pages": { "next_url": has_more.then(|| next.to_string()) }, "total_count": filtered.len(), "data": page }),
        ))
    }

    async fn sleep(&self, _: Duration) {}
}

#[derive(Default)]
struct FakeRuntime {
    armed: Cell<bool>,
    destroyed: Cell<bool>,
}

impl Runtime for &FakeRuntime {
    async fn arm(&self, _: Duration) {
        self.armed.set(true);
    }
    async fn disarm(&self) {
        self.armed.set(false);
    }
    async fn destroy(&self) {
        self.destroyed.set(true);
    }
}

fn user() -> User {
    User {
        id: "u-1".into(),
        username: "testuser".into(),
        level: 4,
        started_at: None,
        current_vacation_started_at: None,
        subscription: Value::Null,
    }
}

type TestAccount<'r> = Account<MemStore, &'r FakeRuntime, FixtureWk>;

fn account(rt: &FakeRuntime, wk: FixtureWk) -> TestAccount<'_> {
    Account::new(MemStore::default(), rt, wk, BASE)
}

fn call(
    acc: &TestAccount<'_>,
    method: &str,
    path: &str,
    since: Option<&str>,
    body: Option<Value>,
    token: &str,
    now: &str,
) -> ApiResponse {
    let req = ApiRequest {
        method,
        path,
        since,
        body: body.map(|b| b.to_string()),
    };
    block_on(acc.handle(req, &user(), token, Timestamp::from(now)))
}

#[test]
fn bootstrap_throttle_poll_and_incremental_state() {
    let rt = FakeRuntime::default();
    let wk = FixtureWk::new("a");
    let acc = account(&rt, wk.clone());

    let r = call(&acc, "GET", "/state", Some("0"), None, "test-token", NOW_A);
    assert_eq!(r.body["account"]["status"], "empty");
    assert_eq!(r.body["assignments"], json!([]));
    assert!(!rt.armed.get());

    let r = call(&acc, "POST", "/sync", None, None, "test-token", NOW_A);
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(r.body["ran"], true);
    assert_eq!(r.body["firstRun"], true);
    assert_eq!(r.body["version"], 1);
    assert!(rt.armed.get());
    assert!(
        !wk.log.borrow().iter().any(|u| u.contains("updated_after")),
        "first run is a full fetch"
    );

    let r = call(&acc, "POST", "/sync", None, None, "test-token", NOW_A);
    assert_eq!(r.body["ran"], false, "throttled within a minute");

    let r = call(&acc, "GET", "/state", Some("0"), None, "test-token", NOW_A);
    assert_eq!(r.body["account"]["status"], "active");
    assert_eq!(r.body["account"]["user"]["username"], "testuser");
    assert_eq!(r.body["assignments"].as_array().unwrap().len(), 8);
    assert_eq!(r.body["review_statistics"].as_array().unwrap().len(), 7);
    assert_eq!(r.body["srs_events"], json!([]));
    assert_eq!(r.body["syncs"].as_array().unwrap().len(), 1);
    assert_eq!(r.body["assignments"][0]["subject_id"], 1);
    assert!(r.body["assignments"][0].get("data_updated_at").is_some());

    wk.switch("b");
    let s2 = block_on(acc.run_sync(false, Timestamp::from(NOW_B))).expect("poll");
    let o = s2.outcome.expect("ran");
    assert_eq!((o.srs_events, o.reviews, o.version), (4, 3, 2));
    assert!(
        wk.log
            .borrow()
            .iter()
            .any(|u| u.contains("/assignments?updated_after=")),
        "incremental fetch"
    );

    let r = call(&acc, "GET", "/state", Some("1"), None, "test-token", NOW_B);
    assert_eq!(r.body["since"], 1);
    assert_eq!(r.body["srs_events"].as_array().unwrap().len(), 4);
    assert_eq!(r.body["review_events"].as_array().unwrap().len(), 1);
    assert_eq!(r.body["review_events"][0]["id"], 1);
    assert_eq!(r.body["review_events"][0]["reviews"], 3);
    assert_eq!(r.body["review_events"][0]["at"], NOW_B);
    assert_eq!(
        r.body["assignments"].as_array().unwrap().len(),
        4,
        "only changed assignments"
    );
    assert_eq!(r.body["level_progressions"].as_array().unwrap().len(), 5);

    let r = call(&acc, "GET", "/state", Some("99"), None, "test-token", NOW_B);
    assert_eq!(
        r.body["since"], 0,
        "a since beyond the version restarts from zero"
    );

    // identical data again → nothing new (dedupe + zero deltas)
    let s3 = block_on(acc.run_sync(false, Timestamp::from("2026-08-22T10:00:00.000Z")))
        .expect("poll")
        .outcome
        .unwrap();
    assert_eq!((s3.srs_events, s3.reviews), (0, 0));
    assert_eq!(acc.store().since(Table::SrsEvents, 0).unwrap().len(), 4);

    let r = call(
        &acc,
        "POST",
        "/seed",
        None,
        Some(json!({ "assignments": [] })),
        "test-token",
        NOW_B,
    );
    assert_eq!(r.status, 400);
    let r = call(&acc, "GET", "/nope", None, None, "test-token", NOW_B);
    assert_eq!(r.status, 404);
}

fn seed_body() -> Value {
    json!({
        "history_since": "2026-07-01T00:00:00.000Z", "last_sync": NOW_A,
        "cursors": { "assignments": "2026-08-19T00:00:00.000Z", "review_statistics": "2026-08-19T00:00:00.000Z" },
        "assignments": [{ "subject_id": 3, "subject_type": "kanji", "srs_stage": 5, "data_updated_at": "2026-08-18T00:00:00.000Z" }],
        "stats": [{ "subject_id": 3, "subject_type": "kanji", "meaning_correct": 9, "meaning_incorrect": 4, "reading_correct": 8, "reading_incorrect": 5 }],
        "progressions": [{ "id": 300, "level": 1 }],
        "srs_events": [{ "id": 42, "subject_id": 3, "subject_type": "kanji", "from": 4, "to": 5, "at": "2026-08-15T00:00:00.000Z", "seen_at": "2026-08-15T01:00:00.000Z" }],
        "review_events": [{ "id": 5, "at": "2026-08-15T01:00:00.000Z", "reviews": 12, "items": 10 }],
        "syncs": [{ "id": 1, "at": "2026-08-15T01:00:00.000Z", "srs_events": 1, "reviews": 12 }]
    })
}

/// The JS double behind the browser e2e (tests/reference/) must serve exactly this state for the
/// same scenario. Regenerate after an intentional contract change: `UPDATE_GOLDEN=1 cargo nextest run`.
#[test]
fn state_matches_golden_shared_with_the_js_double() {
    const GOLDEN_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/golden-state.json"
    );
    let rt = FakeRuntime::default();
    let wk = FixtureWk::new("a");
    let acc = account(&rt, wk.clone());
    call(&acc, "POST", "/sync", None, None, "test-token", NOW_A);
    wk.switch("b");
    block_on(acc.run_sync(false, Timestamp::from(NOW_B))).expect("poll");
    let state = call(&acc, "GET", "/state", Some("0"), None, "test-token", NOW_B).body;
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(
            GOLDEN_PATH,
            serde_json::to_string_pretty(&state).unwrap() + "\n",
        )
        .expect("write golden");
    }
    let golden: Value = serde_json::from_str(
        &std::fs::read_to_string(GOLDEN_PATH).expect("golden fixture; run with UPDATE_GOLDEN=1"),
    )
    .unwrap();
    assert_eq!(
        state, golden,
        "state changed; if intended, UPDATE_GOLDEN=1 and port the change to tests/reference/"
    );
}

#[test]
fn seed_then_refuse_then_poll_then_delete() {
    let rt = FakeRuntime::default();
    let wk = FixtureWk::new("a");
    let acc = account(&rt, wk.clone());

    let r = call(
        &acc,
        "POST",
        "/seed",
        None,
        Some(seed_body()),
        "test-token",
        NOW_A,
    );
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(r.body["ok"], true);
    assert_eq!(r.body["version"], 1);
    assert_eq!(r.body["srs_events"], 1);
    assert!(rt.armed.get());

    let r = call(&acc, "GET", "/state", Some("0"), None, "test-token", NOW_A);
    assert_eq!(r.body["account"]["status"], "active");
    assert_eq!(
        r.body["account"]["history_since"],
        "2026-07-01T00:00:00.000Z"
    );
    assert_eq!(
        r.body["srs_events"][0]["id"], 1,
        "server assigns its own ids"
    );
    assert_eq!(r.body["srs_events"][0]["to"], 5);
    assert_eq!(r.body["review_events"][0]["reviews"], 12);

    let r = call(
        &acc,
        "POST",
        "/seed",
        None,
        Some(seed_body()),
        "test-token",
        NOW_A,
    );
    assert_eq!(r.status, 409);

    // the next poll diffs against the seeded snapshot: kanji 3 goes 5→6 in scenario b
    wk.switch("b");
    let r = call(&acc, "POST", "/sync", None, None, "test-token", NOW_B);
    assert_eq!(r.body["ran"], true, "{}", r.body);
    let r = call(&acc, "GET", "/state", Some("1"), None, "test-token", NOW_B);
    assert!(
        r.body["srs_events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["subject_id"] == 3 && e["from"] == 5 && e["to"] == 6)
    );

    let r = call(&acc, "DELETE", "/account", None, None, "test-token", NOW_B);
    assert_eq!(r.body["ok"], true);
    assert!(!rt.armed.get());
    assert!(rt.destroyed.get());
    let r = call(&acc, "GET", "/state", Some("0"), None, "test-token", NOW_B);
    assert_eq!(r.body["account"]["status"], "empty");
    assert_eq!(r.body["srs_events"], json!([]));
}

#[test]
fn revoked_token_stops_polling_until_a_working_one_shows_up() {
    let rt = FakeRuntime::default();
    let acc = account(&rt, FixtureWk::new("a"));
    let r = call(&acc, "POST", "/sync", None, None, "dying-token", NOW_A);
    assert_eq!(r.status, 401);
    assert_eq!(
        acc.store().get_meta::<Status>("status").unwrap(),
        Some(Status::AuthFailed)
    );
    assert!(!rt.armed.get());

    let r = call(&acc, "GET", "/state", Some("0"), None, "test-token", NOW_A);
    assert_eq!(r.body["account"]["status"], "active");
    assert!(rt.armed.get(), "re-armed by a request with a working token");
    assert_eq!(
        acc.store().get_meta::<String>("token").unwrap().as_deref(),
        Some("test-token")
    );
}

#[test]
fn rotation_replaces_the_stored_token() {
    let rt = FakeRuntime::default();
    let acc = account(&rt, FixtureWk::new("a"));
    call(&acc, "POST", "/sync", None, None, "test-token", NOW_A);
    let r = call(
        &acc,
        "GET",
        "/state",
        Some("0"),
        None,
        "11111111-1111-1111-1111-111111111111",
        NOW_A,
    );
    assert_eq!(r.body["assignments"].as_array().unwrap().len(), 8);
    assert_eq!(
        acc.store().get_meta::<String>("token").unwrap().as_deref(),
        Some("11111111-1111-1111-1111-111111111111")
    );
}

#[test]
fn pagination_is_followed() {
    let wk = FixtureWk::new("a");
    let big: Vec<Value> = (1..=7).map(|i| json!({ "id": i, "data_updated_at": "2026-01-01T00:00:00.000Z", "data": { "level": 1 } })).collect();
    wk.data.borrow_mut()["level_progressions"] = Value::Array(big);
    let wk = FixtureWk { page_size: 3, ..wk };
    let api = WkApi::new(&wk, "test-token", BASE, 0);
    let rows = block_on(api.get_all::<ProgressionData>("/level_progressions", &[])).expect("pages");
    assert_eq!(rows.len(), 7);
    assert_eq!(
        wk.log
            .borrow()
            .iter()
            .filter(|u| u.contains("/level_progressions"))
            .count(),
        3
    );
}
