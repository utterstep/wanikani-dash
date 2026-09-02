//! Persistence behind a small interface. Rows are stored as the JSON the browser
//! expects, tagged with the id of the sync run that wrote them, so clients can pull
//! incrementally (`since=<version>`). Keyed tables upsert by subject/progression id;
//! event tables append (with an optional dedupe key).

use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::StoreError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Table {
    Assignments,
    ReviewStatistics,
    LevelProgressions,
    SrsEvents,
    ReviewEvents,
    Syncs,
}

impl Table {
    pub const ALL: [Table; 6] = [
        Table::Assignments,
        Table::ReviewStatistics,
        Table::LevelProgressions,
        Table::SrsEvents,
        Table::ReviewEvents,
        Table::Syncs,
    ];

    /// Name in SQL and in the `/api/state` response.
    pub fn name(self) -> &'static str {
        match self {
            Table::Assignments => "assignments",
            Table::ReviewStatistics => "review_statistics",
            Table::LevelProgressions => "level_progressions",
            Table::SrsEvents => "srs_events",
            Table::ReviewEvents => "review_events",
            Table::Syncs => "syncs",
        }
    }

    /// Keyed tables upsert by a natural key; the rest append with server-assigned ids.
    pub fn is_keyed(self) -> bool {
        matches!(
            self,
            Table::Assignments | Table::ReviewStatistics | Table::LevelProgressions
        )
    }
}

/// A row of a keyed table.
#[derive(Debug, Clone)]
pub struct KeyedRow {
    pub key: i64,
    pub json: String,
}

/// A row of an event table.
#[derive(Debug, Clone)]
pub struct EventRow {
    pub dedupe: Option<String>,
    pub json: String,
}

pub trait Store {
    fn get_meta_raw(&self, key: &str) -> Result<Option<String>, StoreError>;
    fn set_meta_raw(&self, key: &str, json: &str) -> Result<(), StoreError>;
    /// Rows of a keyed table in the order of `keys`; `None` where absent.
    fn get_many(&self, table: Table, keys: &[i64]) -> Result<Vec<Option<String>>, StoreError>;
    fn put_all(&self, table: Table, rows: &[KeyedRow], sync_id: u64) -> Result<(), StoreError>;
    /// Returns how many rows were actually inserted (dedupe may drop some).
    fn add_all(&self, table: Table, rows: &[EventRow], sync_id: u64) -> Result<usize, StoreError>;
    /// Rows written after `sync_id`. Event rows carry their server `id`.
    fn since(&self, table: Table, sync_id: u64) -> Result<Vec<Value>, StoreError>;
    /// Drop everything.
    fn clear(&self) -> Result<(), StoreError>;
}

/// Typed helpers over the raw string interface.
pub trait StoreExt: Store {
    fn get_meta<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, StoreError> {
        self.get_meta_raw(key)?
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(Into::into)
    }

    fn set_meta<T: Serialize>(&self, key: &str, value: &T) -> Result<(), StoreError> {
        self.set_meta_raw(key, &serde_json::to_string(value)?)
    }

    fn get_many_typed<T: DeserializeOwned>(
        &self,
        table: Table,
        keys: &[i64],
    ) -> Result<Vec<Option<T>>, StoreError> {
        self.get_many(table, keys)?
            .into_iter()
            .map(|s| s.map(|s| serde_json::from_str(&s)).transpose())
            .collect::<Result<_, _>>()
            .map_err(Into::into)
    }

    fn put_typed<T: Serialize>(
        &self,
        table: Table,
        rows: &[T],
        key: impl Fn(&T) -> i64,
        sync_id: u64,
    ) -> Result<(), StoreError> {
        let rows = rows
            .iter()
            .map(|r| {
                Ok(KeyedRow {
                    key: key(r),
                    json: serde_json::to_string(r)?,
                })
            })
            .collect::<Result<Vec<_>, serde_json::Error>>()?;
        self.put_all(table, &rows, sync_id)
    }

    fn add_typed<T: Serialize>(
        &self,
        table: Table,
        rows: &[T],
        dedupe: impl Fn(&T) -> Option<String>,
        sync_id: u64,
    ) -> Result<usize, StoreError> {
        let rows = rows
            .iter()
            .map(|r| {
                Ok(EventRow {
                    dedupe: dedupe(r),
                    json: serde_json::to_string(r)?,
                })
            })
            .collect::<Result<Vec<_>, serde_json::Error>>()?;
        self.add_all(table, &rows, sync_id)
    }
}

impl<S: Store + ?Sized> StoreExt for S {}

/// In-memory store for tests and other single-process uses.
#[derive(Debug, Default)]
pub struct MemStore {
    inner: RefCell<MemInner>,
}

#[derive(Debug, Default)]
struct MemInner {
    meta: BTreeMap<String, String>,
    keyed: BTreeMap<&'static str, BTreeMap<i64, (u64, String)>>,
    events: BTreeMap<&'static str, Vec<(u64, u64, String)>>, // (id, sync_id, json)
    dedupe: HashSet<String>,
}

impl Store for MemStore {
    fn get_meta_raw(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self.inner.borrow().meta.get(key).cloned())
    }

    fn set_meta_raw(&self, key: &str, json: &str) -> Result<(), StoreError> {
        self.inner
            .borrow_mut()
            .meta
            .insert(key.to_owned(), json.to_owned());
        Ok(())
    }

    fn get_many(&self, table: Table, keys: &[i64]) -> Result<Vec<Option<String>>, StoreError> {
        let inner = self.inner.borrow();
        let t = inner.keyed.get(table.name());
        Ok(keys
            .iter()
            .map(|k| t.and_then(|t| t.get(k)).map(|(_, j)| j.clone()))
            .collect())
    }

    fn put_all(&self, table: Table, rows: &[KeyedRow], sync_id: u64) -> Result<(), StoreError> {
        let mut inner = self.inner.borrow_mut();
        let t = inner.keyed.entry(table.name()).or_default();
        for r in rows {
            t.insert(r.key, (sync_id, r.json.clone()));
        }
        Ok(())
    }

    fn add_all(&self, table: Table, rows: &[EventRow], sync_id: u64) -> Result<usize, StoreError> {
        let mut inner = self.inner.borrow_mut();
        let mut n = 0;
        for r in rows {
            if let Some(d) = &r.dedupe
                && !inner.dedupe.insert(format!("{}|{d}", table.name()))
            {
                continue;
            }
            let t = inner.events.entry(table.name()).or_default();
            let id = t.len() as u64 + 1;
            t.push((id, sync_id, r.json.clone()));
            n += 1;
        }
        Ok(n)
    }

    fn since(&self, table: Table, sync_id: u64) -> Result<Vec<Value>, StoreError> {
        let inner = self.inner.borrow();
        if table.is_keyed() {
            let Some(t) = inner.keyed.get(table.name()) else {
                return Ok(vec![]);
            };
            t.values()
                .filter(|(s, _)| *s > sync_id)
                .map(|(_, j)| serde_json::from_str(j).map_err(Into::into))
                .collect()
        } else {
            let Some(t) = inner.events.get(table.name()) else {
                return Ok(vec![]);
            };
            t.iter()
                .filter(|(_, s, _)| *s > sync_id)
                .map(|(id, _, j)| with_id(j, *id))
                .collect()
        }
    }

    fn clear(&self) -> Result<(), StoreError> {
        *self.inner.borrow_mut() = MemInner::default();
        Ok(())
    }
}

/// Parse an event row and prepend its server id.
pub fn with_id(json: &str, id: u64) -> Result<Value, StoreError> {
    let mut v: Value = serde_json::from_str(json)?;
    if let Value::Object(m) = &mut v {
        m.insert("id".into(), Value::from(id));
    }
    Ok(v)
}
