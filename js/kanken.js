// Kanji Kentei (漢検) coverage: which kanji a Kanken level asks for, and where
// each of them sits in your WaniKani SRS. Pure — no DOM, no IO.
//
// Kanken levels 10 through 5 are defined exactly by the 学年別漢字配当表: each
// level adds one school grade of the 教育漢字, so the Jōyō grade data pins them
// down completely. Level 2 is the whole Jōyō list. Levels 4, 3 and 準2 split the
// 1110 secondary-school Jōyō kanji into 313 / 284 / 328 / 185 in a way that is
// published by the 漢字能力検定協会 and cannot be recovered from grades — those
// carry `exact: false` and no grade set, and the UI refuses to guess.

import { JOYO_BY_GRADE, JINMEIYO, GRADE_LABEL } from './kanji-grades.js';

const G6 = ['1', '2', '3', '4', '5', '6'];

/**
 * `grades` lists the kanji sets that make up the level, in teaching order.
 * `official` is the kanji count the 漢検 publishes for that level.
 */
export const KANKEN_LEVELS = [
  { key: '10', label: '10級', sub: '小学1年修了程度', grades: ['1'], official: 80, exact: true },
  { key: '9', label: '9級', sub: '小学2年修了程度', grades: G6.slice(0, 2), official: 240, exact: true },
  { key: '8', label: '8級', sub: '小学3年修了程度', grades: G6.slice(0, 3), official: 440, exact: true },
  { key: '7', label: '7級', sub: '小学4年修了程度', grades: G6.slice(0, 4), official: 642, exact: true },
  { key: '6', label: '6級', sub: '小学5年修了程度', grades: G6.slice(0, 5), official: 835, exact: true },
  { key: '5', label: '5級', sub: '小学6年修了程度', grades: G6, official: 1026, exact: true },
  { key: '4', label: '4級', sub: '中学校在学程度', official: 1339, exact: false },
  { key: '3', label: '3級', sub: '中学校卒業程度', official: 1623, exact: false },
  { key: 'pre2', label: '準2級', sub: '高校在学程度', official: 1951, exact: false },
  { key: '2', label: '2級', sub: '高校卒業・大学・一般程度', grades: [...G6, 'S'], official: 2136, exact: true },
  { key: 'pre1', label: '準1級', sub: '大学・一般程度（約3000字）', grades: [...G6, 'S', 'J'], official: 3000, exact: false, approx: true },
];

export function kankenLevel(key) {
  return KANKEN_LEVELS.find((l) => l.key === key) ?? KANKEN_LEVELS.find((l) => l.key === '5');
}

/** Like kankenLevel, but also refuses the levels whose kanji list we cannot derive. */
export function selectableLevel(key) {
  const l = kankenLevel(key);
  return l.grades ? l : kankenLevel('5');
}

/** Cell states, ordered most-learned first so a stacked bar reads as a progress bar. */
export const KANJI_STATES = [
  { key: 'burned', label: 'Burned' },
  { key: 'enlightened', label: 'Enlightened' },
  { key: 'master', label: 'Master' },
  { key: 'guru', label: 'Guru' },
  { key: 'apprentice', label: 'Apprentice' },
  { key: 'lesson', label: 'In lessons' },
  { key: 'locked', label: 'Locked' },
  { key: 'absent', label: 'Not on WaniKani' },
];

/** SRS stage → state key, for a kanji WaniKani has already unlocked. */
export function stateOfStage(stage) {
  if (stage >= 9) return 'burned';
  if (stage === 8) return 'enlightened';
  if (stage === 7) return 'master';
  if (stage >= 5) return 'guru';
  if (stage >= 1) return 'apprentice';
  return 'lesson';
}

const emptyCounts = () => Object.fromEntries(KANJI_STATES.map((s) => [s.key, 0]));

/** character → slim kanji subject, skipping hidden ones. */
export function kanjiByCharacter(subjects) {
  const map = new Map();
  for (const s of subjects) {
    if (s.object !== 'kanji' || s.hidden_at || !s.characters) continue;
    map.set(s.characters, s);
  }
  return map;
}

/**
 * Every kanji of a Kanken level, grouped by Jōyō grade and tagged with its SRS state.
 *
 * @param {string} levelKey             key from KANKEN_LEVELS
 * @param {object[]} subjects           slim subjects
 * @param {Map<number, object>} assignmentsById  subject_id → slim assignment
 * @returns {{level:object, sections:object[], counts:object, total:number,
 *            onWk:number, started:number, passed:number, burned:number}}
 */
export function kankenCoverage(levelKey, subjects, assignmentsById) {
  const level = kankenLevel(levelKey);
  const byChar = kanjiByCharacter(subjects);
  const counts = emptyCounts();
  const sections = [];
  let total = 0, onWk = 0, started = 0, passed = 0, burned = 0;

  for (const grade of level.grades ?? []) {
    const chars = grade === 'J' ? JINMEIYO : JOYO_BY_GRADE[grade];
    if (!chars) continue;
    const cells = [];
    const gCounts = emptyCounts();
    for (const ch of chars) {
      const sub = byChar.get(ch);
      const asg = sub ? assignmentsById.get(sub.id) : null;
      const stage = asg && !asg.hidden ? asg.srs_stage : null;
      const state = !sub ? 'absent' : stage == null ? 'locked' : stateOfStage(stage);
      cells.push({
        ch,
        grade,
        state,
        wkLevel: sub?.level ?? null,
        srs_stage: stage,
        meaning: sub?.meaning ?? null,
        reading: sub?.reading ?? null,
        url: sub?.document_url ?? null,
      });
      gCounts[state] += 1;
      counts[state] += 1;
      total += 1;
      if (sub) onWk += 1;
      if (stage >= 1) started += 1;
      if (stage >= 5) passed += 1;
      if (stage >= 9) burned += 1;
    }
    // WaniKani order first — the heat map then reads as a front line across the grade.
    cells.sort((a, b) => (a.wkLevel ?? 1e9) - (b.wkLevel ?? 1e9) || a.ch.codePointAt(0) - b.ch.codePointAt(0));
    sections.push({ grade, label: GRADE_LABEL[grade], cells, counts: gCounts, total: cells.length });
  }

  return { level, sections, counts, total, onWk, started, passed, burned };
}

/**
 * Kanji WaniKani teaches that the Jōyō list does not contain, bucketed by source list.
 * Useful counterpart to the heat map: what you learn that Kanken 2級 will not ask for.
 */
export function nonJoyoWaniKani(subjects, gradeOf) {
  const out = { jinmeiyo: [], other: [] };
  for (const s of subjects) {
    if (s.object !== 'kanji' || s.hidden_at || !s.characters) continue;
    const g = gradeOf(s.characters);
    if (g && g !== 'J') continue;
    (g === 'J' ? out.jinmeiyo : out.other).push(s);
  }
  return out;
}
