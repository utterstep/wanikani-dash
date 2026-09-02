//! Pure snapshot diffing: previous rows vs freshly fetched rows → events.
//! Mirrors the browser's original `diff.js` so history stays comparable.

use std::collections::HashMap;

use crate::model::{Assignment, ReviewEvent, ReviewStat, SrsEvent, SubjectId, Timestamp};

/// One event per assignment whose SRS stage changed. Rows never seen before produce
/// nothing: there is no history to compare against.
pub fn diff_assignments(
    prev: &HashMap<SubjectId, Assignment>,
    next: &[Assignment],
    seen_at: &Timestamp,
) -> Vec<SrsEvent> {
    next.iter()
        .filter_map(|a| {
            let p = prev.get(&a.data.subject_id)?;
            (p.data.srs_stage != a.data.srs_stage).then(|| SrsEvent {
                subject_id: a.data.subject_id,
                subject_type: a.data.subject_type.clone(),
                from: p.data.srs_stage,
                to: a.data.srs_stage,
                at: a.data_updated_at.clone().unwrap_or_else(|| seen_at.clone()),
                seen_at: seen_at.clone(),
            })
        })
        .collect()
}

/// Sum review-counter deltas across changed statistics. A review on WaniKani answers
/// meaning and (where it exists) reading, so reviews per item ≈ max of the two deltas.
pub fn diff_stats(
    prev: &HashMap<SubjectId, ReviewStat>,
    next: &[ReviewStat],
    at: &Timestamp,
) -> Option<ReviewEvent> {
    let mut ev = ReviewEvent {
        at: at.clone(),
        reviews: 0,
        items: 0,
        meaning_correct_d: 0,
        meaning_incorrect_d: 0,
        reading_correct_d: 0,
        reading_incorrect_d: 0,
    };
    for s in next {
        let Some(p) = prev.get(&s.data.subject_id) else {
            continue;
        };
        let d = |now: u32, before: u32| now.saturating_sub(before);
        let mc = d(s.data.meaning_correct, p.data.meaning_correct);
        let mi = d(s.data.meaning_incorrect, p.data.meaning_incorrect);
        let rc = d(s.data.reading_correct, p.data.reading_correct);
        let ri = d(s.data.reading_incorrect, p.data.reading_incorrect);
        let readable = s.data.has_reading();
        let r = if readable { rc + ri } else { 0 };
        let n = (mc + mi).max(r);
        if n == 0 {
            continue;
        }
        ev.reviews += n;
        ev.items += 1;
        ev.meaning_correct_d += mc;
        ev.meaning_incorrect_d += mi;
        if readable {
            ev.reading_correct_d += rc;
            ev.reading_incorrect_d += ri;
        }
    }
    (ev.reviews > 0).then_some(ev)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AssignmentData, ReviewStatData};

    fn asg(id: u64, stage: u8, upd: Option<&str>) -> Assignment {
        Assignment {
            data: AssignmentData {
                subject_id: SubjectId::new(id),
                subject_type: "kanji".into(),
                srs_stage: stage,
                unlocked_at: None,
                started_at: None,
                passed_at: None,
                burned_at: None,
                available_at: None,
                hidden: false,
            },
            data_updated_at: upd.map(Timestamp::from),
        }
    }

    fn stat(id: u64, ty: &str, mc: u32, mi: u32, rc: u32, ri: u32) -> ReviewStat {
        ReviewStat {
            data: ReviewStatData {
                subject_id: SubjectId::new(id),
                subject_type: ty.into(),
                meaning_correct: mc,
                meaning_incorrect: mi,
                reading_correct: rc,
                reading_incorrect: ri,
                meaning_current_streak: 0,
                reading_current_streak: 0,
                meaning_max_streak: 0,
                reading_max_streak: 0,
                percentage_correct: 0,
                hidden: false,
            },
            data_updated_at: None,
        }
    }

    #[test]
    fn stage_changes_become_events_dated_by_wanikani() {
        let seen = Timestamp::from("2026-08-22T09:00:00.000Z");
        let prev = HashMap::from([
            (SubjectId::new(1), asg(1, 4, None)),
            (SubjectId::new(2), asg(2, 5, None)),
        ]);
        let next = vec![
            asg(1, 5, Some("2026-08-21T13:00:00.000Z")),
            asg(2, 5, None),
            asg(3, 1, None),
        ];
        let events = diff_assignments(&prev, &next, &seen);
        assert_eq!(events.len(), 1);
        assert_eq!((events[0].from, events[0].to), (4, 5));
        assert_eq!(events[0].at.as_str(), "2026-08-21T13:00:00.000Z");
        assert_eq!(events[0].dedupe_key(), "1|2026-08-21T13:00:00.000Z|5");
    }

    #[test]
    fn review_counts_take_the_larger_side_and_ignore_radical_readings() {
        let at = Timestamp::from("2026-08-22T09:00:00.000Z");
        let prev = HashMap::from([
            (SubjectId::new(1), stat(1, "kanji", 10, 2, 9, 3)),
            (SubjectId::new(2), stat(2, "radical", 5, 0, 0, 0)),
            (SubjectId::new(3), stat(3, "vocabulary", 1, 1, 1, 1)),
        ]);
        let next = vec![
            stat(1, "kanji", 11, 2, 9, 4),     // meaning 1, reading 1 → 1 review
            stat(2, "radical", 6, 1, 0, 0),    // meaning 2 → 2 reviews
            stat(3, "vocabulary", 1, 1, 1, 1), // unchanged
            stat(9, "kanji", 3, 3, 3, 3),      // unseen
        ];
        let ev = diff_stats(&prev, &next, &at).expect("some reviews");
        assert_eq!(ev.reviews, 3);
        assert_eq!(ev.items, 2);
        assert_eq!((ev.meaning_correct_d, ev.meaning_incorrect_d), (2, 1));
        assert_eq!((ev.reading_correct_d, ev.reading_incorrect_d), (0, 1));
        assert!(diff_stats(&prev, &prev.values().cloned().collect::<Vec<_>>(), &at).is_none());
    }
}
