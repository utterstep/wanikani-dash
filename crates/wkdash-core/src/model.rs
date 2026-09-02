//! Wire and storage shapes. The `*Data` structs mirror WaniKani's `data` objects exactly;
//! the slim rows (`Assignment`, `ReviewStat`, …) are what we store and serve, and their
//! JSON must stay identical to what the browser expects (see `public/js/pull.js`).

use std::fmt;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A WaniKani subject id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SubjectId(u64);

impl SubjectId {
    pub fn new(id: u64) -> Self {
        Self(id)
    }

    pub fn as_u64(self) -> u64 {
        self.0
    }
}

/// An ISO-8601 UTC timestamp exactly as WaniKani (and `Date#toISOString`) writes it.
/// Kept as text so comparisons and storage round-trip byte for byte; RFC 3339 `Z`
/// timestamps of equal precision order correctly as strings.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Timestamp(String);

impl Timestamp {
    pub fn from_datetime(t: DateTime<Utc>) -> Self {
        Self(t.to_rfc3339_opts(SecondsFormat::Millis, true))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn parse(&self) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(&self.0)
            .ok()
            .map(|t| t.with_timezone(&Utc))
    }
}

impl From<&str> for Timestamp {
    fn from(s: &str) -> Self {
        Self(s.to_owned())
    }
}

impl From<DateTime<Utc>> for Timestamp {
    fn from(t: DateTime<Utc>) -> Self {
        Self::from_datetime(t)
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// WaniKani resource envelope: `{id, object, data_updated_at, data}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope<T> {
    #[serde(default)]
    pub id: Option<u64>,
    #[serde(default)]
    pub data_updated_at: Option<Timestamp>,
    pub data: T,
}

/// A page of a WaniKani collection.
#[derive(Debug, Clone, Deserialize)]
pub struct Collection<T> {
    pub data: Vec<Envelope<T>>,
    #[serde(default)]
    pub pages: Pages,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Pages {
    pub next_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignmentData {
    pub subject_id: SubjectId,
    pub subject_type: String,
    pub srs_stage: u8,
    pub unlocked_at: Option<Timestamp>,
    pub started_at: Option<Timestamp>,
    pub passed_at: Option<Timestamp>,
    pub burned_at: Option<Timestamp>,
    pub available_at: Option<Timestamp>,
    #[serde(default)]
    pub hidden: bool,
}

/// Stored assignment row: the `data` fields plus the envelope's `data_updated_at`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assignment {
    #[serde(flatten)]
    pub data: AssignmentData,
    pub data_updated_at: Option<Timestamp>,
}

impl Envelope<AssignmentData> {
    pub fn slim(self) -> Assignment {
        Assignment {
            data: self.data,
            data_updated_at: self.data_updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewStatData {
    pub subject_id: SubjectId,
    pub subject_type: String,
    pub meaning_correct: u32,
    pub meaning_incorrect: u32,
    pub reading_correct: u32,
    pub reading_incorrect: u32,
    #[serde(default)]
    pub meaning_current_streak: u32,
    #[serde(default)]
    pub reading_current_streak: u32,
    #[serde(default)]
    pub meaning_max_streak: u32,
    #[serde(default)]
    pub reading_max_streak: u32,
    #[serde(default)]
    pub percentage_correct: u32,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewStat {
    #[serde(flatten)]
    pub data: ReviewStatData,
    pub data_updated_at: Option<Timestamp>,
}

impl Envelope<ReviewStatData> {
    pub fn slim(self) -> ReviewStat {
        ReviewStat {
            data: self.data,
            data_updated_at: self.data_updated_at,
        }
    }
}

impl ReviewStatData {
    /// Kanji and vocabulary have readings; radicals and kana vocabulary do not.
    pub fn has_reading(&self) -> bool {
        self.subject_type == "kanji" || self.subject_type == "vocabulary"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressionData {
    pub level: u8,
    pub unlocked_at: Option<Timestamp>,
    pub started_at: Option<Timestamp>,
    pub passed_at: Option<Timestamp>,
    pub completed_at: Option<Timestamp>,
    pub abandoned_at: Option<Timestamp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Progression {
    pub id: u64,
    #[serde(flatten)]
    pub data: ProgressionData,
}

impl Envelope<ProgressionData> {
    pub fn slim(self) -> Progression {
        Progression {
            id: self.id.unwrap_or_default(),
            data: self.data,
        }
    }
}

/// The part of WaniKani's `/user` we keep. `id` is the stable account id the
/// dashboard is keyed by; tokens come and go.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub username: String,
    pub level: u8,
    #[serde(default)]
    pub started_at: Option<Timestamp>,
    #[serde(default)]
    pub current_vacation_started_at: Option<Timestamp>,
    #[serde(default)]
    pub subscription: Value,
}

/// One SRS stage change of one subject. `at` is WaniKani's own timestamp of the change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SrsEvent {
    pub subject_id: SubjectId,
    pub subject_type: String,
    pub from: u8,
    pub to: u8,
    pub at: Timestamp,
    pub seen_at: Timestamp,
}

impl SrsEvent {
    /// Two polls that both observe the same change produce the same key.
    pub fn dedupe_key(&self) -> String {
        format!("{}|{}|{}", self.subject_id.as_u64(), self.at, self.to)
    }
}

/// Review counters summed over one poll; dated by the poll.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewEvent {
    pub at: Timestamp,
    pub reviews: u32,
    pub items: u32,
    pub meaning_correct_d: u32,
    pub meaning_incorrect_d: u32,
    pub reading_correct_d: u32,
    pub reading_incorrect_d: u32,
}

/// One poll: when, and what it found.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRecord {
    pub at: Timestamp,
    pub srs_events: usize,
    pub reviews: u32,
}

/// `updated_after` cursors per endpoint.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Cursors {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignments: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_statistics: Option<Timestamp>,
}

/// Lifecycle of an account on the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Empty,
    Active,
    AuthFailed,
}
