//! One poll: fetch what changed from WaniKani, diff against the stored snapshot,
//! persist events then snapshot then cursors (a crash never loses events), and bump
//! the account version. Also the one-time seed from a browser's pre-server history.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::diff::{diff_assignments, diff_stats};
use crate::error::{StoreError, SyncError};
use crate::model::*;
use crate::store::{Store, StoreExt, Table};
use crate::wk::{Transport, WkApi};

pub mod meta {
    pub const TOKEN: &str = "token";
    pub const USER: &str = "user";
    pub const CURSORS: &str = "cursors";
    pub const HISTORY_SINCE: &str = "history_since";
    pub const LAST_SYNC: &str = "last_sync";
    pub const STATUS: &str = "status";
    pub const VERSION: &str = "version";
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub first_run: bool,
    pub srs_events: usize,
    pub reviews: u32,
    pub version: u64,
}

fn key_of_assignment(a: &Assignment) -> i64 {
    a.data.subject_id.as_u64() as i64
}

fn key_of_stat(s: &ReviewStat) -> i64 {
    s.data.subject_id.as_u64() as i64
}

fn latest(rows: &[Envelope<impl Sized>], prev: Option<Timestamp>) -> Option<Timestamp> {
    rows.iter()
        .filter_map(|r| r.data_updated_at.clone())
        .chain(prev)
        .max()
}

pub async fn sync<T: Transport, S: Store>(
    api: &WkApi<'_, T>,
    store: &S,
    now: Timestamp,
) -> Result<SyncOutcome, SyncError> {
    let cursors: Cursors = store.get_meta(meta::CURSORS)?.unwrap_or_default();
    let first_run = store.get_meta_raw(meta::LAST_SYNC)?.is_none();
    let sync_id = store.get_meta::<u64>(meta::VERSION)?.unwrap_or(0) + 1;

    // 1. user (level, vacation)
    let user: Envelope<User> = api.get_one("/user").await?;
    store.set_meta(meta::USER, &user.data)?;

    // 2. level progressions (small: refetch all)
    let progressions: Vec<Progression> = api
        .get_all::<ProgressionData>("/level_progressions", &[])
        .await?
        .into_iter()
        .map(|e| e.slim())
        .collect();
    store.put_typed(
        Table::LevelProgressions,
        &progressions,
        |p| p.id as i64,
        sync_id,
    )?;

    // 3. assignments + review statistics (incremental)
    let asg_params = cursors
        .assignments
        .as_ref()
        .map(|c| [("updated_after", c.as_str())]);
    let stat_params = cursors
        .review_statistics
        .as_ref()
        .map(|c| [("updated_after", c.as_str())]);
    let asg_raw = api
        .get_all::<AssignmentData>(
            "/assignments",
            asg_params.as_ref().map_or(&[][..], |p| &p[..]),
        )
        .await?;
    let stat_raw = api
        .get_all::<ReviewStatData>(
            "/review_statistics",
            stat_params.as_ref().map_or(&[][..], |p| &p[..]),
        )
        .await?;
    let asg_cursor = latest(&asg_raw, cursors.assignments.clone());
    let stat_cursor = latest(&stat_raw, cursors.review_statistics.clone());
    let asg: Vec<Assignment> = asg_raw.into_iter().map(|e| e.slim()).collect();
    let stats: Vec<ReviewStat> = stat_raw.into_iter().map(|e| e.slim()).collect();

    // 4. diff against stored rows
    let prev_asg: HashMap<SubjectId, Assignment> = store
        .get_many_typed::<Assignment>(
            Table::Assignments,
            &asg.iter().map(key_of_assignment).collect::<Vec<_>>(),
        )?
        .into_iter()
        .flatten()
        .map(|a| (a.data.subject_id, a))
        .collect();
    let prev_stats: HashMap<SubjectId, ReviewStat> = store
        .get_many_typed::<ReviewStat>(
            Table::ReviewStatistics,
            &stats.iter().map(key_of_stat).collect::<Vec<_>>(),
        )?
        .into_iter()
        .flatten()
        .map(|s| (s.data.subject_id, s))
        .collect();
    let events = diff_assignments(&prev_asg, &asg, &now);
    let review_event = diff_stats(&prev_stats, &stats, &now);

    // 5. persist: events first, then snapshot, then cursors
    let srs_events =
        store.add_typed(Table::SrsEvents, &events, |e| Some(e.dedupe_key()), sync_id)?;
    if let Some(ev) = &review_event {
        store.add_typed(
            Table::ReviewEvents,
            std::slice::from_ref(ev),
            |_| None,
            sync_id,
        )?;
    }
    store.put_typed(Table::Assignments, &asg, key_of_assignment, sync_id)?;
    store.put_typed(Table::ReviewStatistics, &stats, key_of_stat, sync_id)?;
    let reviews = review_event.as_ref().map_or(0, |e| e.reviews);
    store.add_typed(
        Table::Syncs,
        &[SyncRecord {
            at: now.clone(),
            srs_events,
            reviews,
        }],
        |_| None,
        sync_id,
    )?;

    // Cursor = max data_updated_at seen (safer than "now" against clock skew); keep the old one if nothing came back.
    store.set_meta(
        meta::CURSORS,
        &Cursors {
            assignments: asg_cursor.or_else(|| Some(now.clone())),
            review_statistics: stat_cursor.or_else(|| Some(now.clone())),
        },
    )?;
    if first_run {
        store.set_meta(meta::HISTORY_SINCE, &now)?;
    }
    store.set_meta(meta::LAST_SYNC, &now)?;
    store.set_meta(meta::STATUS, &Status::Active)?;
    store.set_meta(meta::VERSION, &sync_id)?;

    Ok(SyncOutcome {
        first_run,
        srs_events,
        reviews,
        version: sync_id,
    })
}

/// A browser's pre-server history, uploaded once. Rows are passed through as-is
/// (they already have the stored shape); local autoincrement ids are dropped.
#[derive(Debug, Deserialize)]
pub struct SeedBody {
    pub history_since: Timestamp,
    #[serde(default)]
    pub last_sync: Option<Timestamp>,
    pub cursors: SeedCursors,
    pub assignments: Vec<Value>,
    pub stats: Vec<Value>,
    #[serde(default)]
    pub progressions: Vec<Value>,
    pub srs_events: Vec<Value>,
    pub review_events: Vec<Value>,
    pub syncs: Vec<Value>,
}

#[derive(Debug, Deserialize)]
pub struct SeedCursors {
    pub assignments: Timestamp,
    pub review_statistics: Timestamp,
}

#[derive(Debug, Clone, Serialize)]
pub struct SeedOutcome {
    pub version: u64,
    pub srs_events: usize,
    pub review_events: usize,
    pub syncs: usize,
}

impl SeedBody {
    pub fn validate(&self) -> Result<(), String> {
        if self.assignments.is_empty() {
            return Err("assignments is empty".into());
        }
        Ok(())
    }
}

fn value_key(v: &Value, field: &str) -> Option<i64> {
    v.get(field)?.as_i64()
}

fn strip_id(mut v: Value) -> Value {
    if let Value::Object(m) = &mut v {
        m.remove("id");
    }
    v
}

pub fn seed<S: Store>(
    store: &S,
    body: SeedBody,
    now: Timestamp,
) -> Result<SeedOutcome, StoreError> {
    let sync_id = 1;
    let keyed = |rows: &[Value], field: &str| {
        rows.iter()
            .filter_map(|v| Some((value_key(v, field)?, v)))
            .map(|(k, v)| (k, v.clone()))
            .collect::<Vec<_>>()
    };
    let put_values = |table: Table, rows: Vec<(i64, Value)>| -> Result<(), StoreError> {
        let rows = rows
            .into_iter()
            .map(|(key, v)| {
                Ok(crate::store::KeyedRow {
                    key,
                    json: serde_json::to_string(&v)?,
                })
            })
            .collect::<Result<Vec<_>, serde_json::Error>>()?;
        store.put_all(table, &rows, sync_id)
    };
    put_values(Table::Assignments, keyed(&body.assignments, "subject_id"))?;
    put_values(Table::ReviewStatistics, keyed(&body.stats, "subject_id"))?;
    put_values(Table::LevelProgressions, keyed(&body.progressions, "id"))?;
    let dedupe_srs = |v: &Value| -> Option<String> {
        let e: SrsEvent = serde_json::from_value(v.clone()).ok()?;
        Some(e.dedupe_key())
    };
    let stripped = |rows: &[Value]| rows.iter().cloned().map(strip_id).collect::<Vec<_>>();
    let srs_events = store.add_typed(
        Table::SrsEvents,
        &stripped(&body.srs_events),
        dedupe_srs,
        sync_id,
    )?;
    let review_events = store.add_typed(
        Table::ReviewEvents,
        &stripped(&body.review_events),
        |_| None,
        sync_id,
    )?;
    let syncs = store.add_typed(Table::Syncs, &stripped(&body.syncs), |_| None, sync_id)?;
    store.set_meta(
        meta::CURSORS,
        &Cursors {
            assignments: Some(body.cursors.assignments),
            review_statistics: Some(body.cursors.review_statistics),
        },
    )?;
    store.set_meta(meta::HISTORY_SINCE, &body.history_since)?;
    store.set_meta(meta::LAST_SYNC, &body.last_sync.unwrap_or(now))?;
    store.set_meta(meta::STATUS, &Status::Active)?;
    store.set_meta(meta::VERSION, &sync_id)?;
    Ok(SeedOutcome {
        version: sync_id,
        srs_events,
        review_events,
        syncs,
    })
}
