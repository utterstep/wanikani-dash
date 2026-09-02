//! [`Store`] over a Durable Object's SQLite database. Same tables as the JS version:
//! `meta(key, value)`, keyed tables `(key, sync_id, data)`, event tables
//! `(id, sync_id, dedupe UNIQUE, data)`.

use serde::Deserialize;
use serde_json::Value;
use wkdash_core::{EventRow, KeyedRow, Store, StoreError, Table, with_id};
use worker::{SqlStorage, SqlStorageValue};

pub struct SqlStore {
    sql: SqlStorage,
}

fn backend(e: worker::Error) -> StoreError {
    StoreError::backend(e.to_string())
}

#[derive(Deserialize)]
struct MetaRow {
    value: String,
}

#[derive(Deserialize)]
struct DataRow {
    key: i64,
    data: String,
}

#[derive(Deserialize)]
struct EventDataRow {
    id: u64,
    data: String,
}

#[derive(Deserialize)]
struct Changes {
    n: u64,
}

impl SqlStore {
    pub fn new(sql: SqlStorage) -> Result<Self, StoreError> {
        let store = Self { sql };
        store.init()?;
        Ok(store)
    }

    fn init(&self) -> Result<(), StoreError> {
        self.exec(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            vec![],
        )?;
        for t in Table::ALL {
            let name = t.name();
            if t.is_keyed() {
                self.exec(&format!("CREATE TABLE IF NOT EXISTS {name} (key INTEGER PRIMARY KEY, sync_id INTEGER NOT NULL, data TEXT NOT NULL)"), vec![])?;
            } else {
                self.exec(
                    &format!("CREATE TABLE IF NOT EXISTS {name} (id INTEGER PRIMARY KEY AUTOINCREMENT, sync_id INTEGER NOT NULL, dedupe TEXT UNIQUE, data TEXT NOT NULL)"),
                    vec![],
                )?;
            }
            self.exec(
                &format!("CREATE INDEX IF NOT EXISTS {name}_sync ON {name} (sync_id)"),
                vec![],
            )?;
        }
        Ok(())
    }

    fn exec(
        &self,
        query: &str,
        bindings: Vec<SqlStorageValue>,
    ) -> Result<worker::SqlCursor, StoreError> {
        self.sql.exec(query, bindings).map_err(backend)
    }

    /// Rows changed by the last statement. `rows_written` on the cursor counts index writes too.
    fn changes(&self) -> Result<u64, StoreError> {
        Ok(self
            .exec("SELECT changes() AS n", vec![])?
            .one::<Changes>()
            .map_err(backend)?
            .n)
    }
}

fn int(v: i64) -> SqlStorageValue {
    SqlStorageValue::Integer(v)
}

fn text(v: &str) -> SqlStorageValue {
    SqlStorageValue::String(v.to_owned())
}

impl Store for SqlStore {
    fn get_meta_raw(&self, key: &str) -> Result<Option<String>, StoreError> {
        let rows: Vec<MetaRow> = self
            .exec("SELECT value FROM meta WHERE key = ?", vec![text(key)])?
            .to_array()
            .map_err(backend)?;
        Ok(rows.into_iter().next().map(|r| r.value))
    }

    fn set_meta_raw(&self, key: &str, json: &str) -> Result<(), StoreError> {
        self.exec(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            vec![text(key), text(json)],
        )?;
        Ok(())
    }

    fn get_many(&self, table: Table, keys: &[i64]) -> Result<Vec<Option<String>>, StoreError> {
        let mut found = std::collections::HashMap::with_capacity(keys.len());
        for chunk in keys.chunks(200) {
            let marks = vec!["?"; chunk.len()].join(",");
            let rows: Vec<DataRow> = self
                .exec(
                    &format!(
                        "SELECT key, data FROM {} WHERE key IN ({marks})",
                        table.name()
                    ),
                    chunk.iter().map(|k| int(*k)).collect(),
                )?
                .to_array()
                .map_err(backend)?;
            found.extend(rows.into_iter().map(|r| (r.key, r.data)));
        }
        Ok(keys.iter().map(|k| found.remove(k)).collect())
    }

    fn put_all(&self, table: Table, rows: &[KeyedRow], sync_id: u64) -> Result<(), StoreError> {
        let q = format!(
            "INSERT OR REPLACE INTO {} (key, sync_id, data) VALUES (?, ?, ?)",
            table.name()
        );
        for r in rows {
            self.exec(&q, vec![int(r.key), int(sync_id as i64), text(&r.json)])?;
        }
        Ok(())
    }

    fn add_all(&self, table: Table, rows: &[EventRow], sync_id: u64) -> Result<usize, StoreError> {
        let q = format!(
            "INSERT OR IGNORE INTO {} (sync_id, dedupe, data) VALUES (?, ?, ?)",
            table.name()
        );
        let mut n = 0;
        for r in rows {
            let dedupe = r.dedupe.as_deref().map_or(SqlStorageValue::Null, text);
            self.exec(&q, vec![int(sync_id as i64), dedupe, text(&r.json)])?;
            n += self.changes()? as usize;
        }
        Ok(n)
    }

    fn since(&self, table: Table, sync_id: u64) -> Result<Vec<Value>, StoreError> {
        let name = table.name();
        if table.is_keyed() {
            let rows: Vec<DataRow> = self
                .exec(
                    &format!("SELECT key, data FROM {name} WHERE sync_id > ? ORDER BY key"),
                    vec![int(sync_id as i64)],
                )?
                .to_array()
                .map_err(backend)?;
            rows.into_iter()
                .map(|r| serde_json::from_str(&r.data).map_err(Into::into))
                .collect()
        } else {
            let rows: Vec<EventDataRow> = self
                .exec(
                    &format!("SELECT id, data FROM {name} WHERE sync_id > ? ORDER BY id"),
                    vec![int(sync_id as i64)],
                )?
                .to_array()
                .map_err(backend)?;
            rows.into_iter().map(|r| with_id(&r.data, r.id)).collect()
        }
    }

    fn clear(&self) -> Result<(), StoreError> {
        // The Durable Object wipes its storage wholesale (Runtime::destroy); recreate the schema afterwards.
        self.init()
    }
}
