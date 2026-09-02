import { describe, it, assert, assertEqual } from './harness.js';
import { JOYO_BY_GRADE, JINMEIYO, GRADE_KEYS, gradeOf, isJoyo } from '../public/js/kanji-grades.js';
import { KANKEN_LEVELS, KANJI_STATES, kankenLevel, selectableLevel, kankenCoverage, stateOfStage, kanjiByCharacter, nonJoyoWaniKani } from '../public/js/kanken.js';
import { slimAssignment, slimSubject } from '../public/js/diff.js';
import { fixtures } from './fixtures/synthetic.js';

const fa = fixtures('a');
const subs = fa.subjects.map(slimSubject);
const asgById = new Map(fa.assignments.map(slimAssignment).map((a) => [a.subject_id, a]));
const sizeOf = (k) => [...(k === 'J' ? JINMEIYO : JOYO_BY_GRADE[k])].length;

describe('kanji-grades data', () => {
  it('matches the official 常用漢字表 counts after the 2017 revision', () => {
    assertEqual(GRADE_KEYS.map(sizeOf), [80, 160, 200, 202, 193, 191, 1110]);
    assertEqual(GRADE_KEYS.reduce((n, k) => n + sizeOf(k), 0), 2136);
    assertEqual(['1', '2', '3', '4', '5', '6'].reduce((n, k) => n + sizeOf(k), 0), 1026);
  });

  it('puts the 20 prefecture kanji in grade 4', () => {
    for (const c of '茨媛岡潟岐熊香佐埼崎滋鹿縄井沖栃奈梨阪阜') assertEqual(gradeOf(c), '4', c);
  });

  it('assigns every kanji exactly one grade', () => {
    const seen = new Set();
    for (const k of [...GRADE_KEYS, 'J']) {
      for (const ch of k === 'J' ? JINMEIYO : JOYO_BY_GRADE[k]) {
        assert(!seen.has(ch), `${ch} appears twice`);
        seen.add(ch);
      }
    }
    assertEqual(seen.size, 2136 + sizeOf('J'));
  });

  it('classifies jōyō, jinmeiyō and everything else', () => {
    assertEqual([gradeOf('一'), gradeOf('人'), gradeOf('丼'), gradeOf('伊'), gradeOf('à')], ['1', '1', 'S', 'J', null]);
    assertEqual([isJoyo('一'), isJoyo('丼'), isJoyo('伊'), isJoyo('à')], [true, true, false, false]);
  });
});

describe('KANKEN_LEVELS', () => {
  it('reproduces the published kanji count for every derivable level', () => {
    for (const l of KANKEN_LEVELS.filter((x) => x.grades && !x.approx)) {
      assertEqual(l.grades.reduce((n, g) => n + sizeOf(g), 0), l.official, `${l.label}`);
    }
  });

  it('leaves 4級 / 3級 / 準2級 underivable rather than guessing', () => {
    assertEqual(KANKEN_LEVELS.filter((l) => !l.grades).map((l) => l.key), ['4', '3', 'pre2']);
    assertEqual(KANKEN_LEVELS.filter((l) => !l.grades).map((l) => l.official), [1339, 1623, 1951]);
  });

  it('nests each level inside the next one up', () => {
    const derivable = KANKEN_LEVELS.filter((l) => l.grades);
    for (let i = 1; i < derivable.length; i++) {
      const prev = new Set(derivable[i - 1].grades);
      for (const g of prev) assert(derivable[i].grades.includes(g), `${derivable[i].label} drops ${g}`);
      assert(derivable[i].grades.length > derivable[i - 1].grades.length);
    }
  });

  it('falls back to 5級 for an unknown key', () => {
    assertEqual(kankenLevel('nope').key, '5');
    assertEqual(kankenLevel('10').key, '10');
  });

  it('never lets the UI select an underivable level', () => {
    assertEqual(['10', '4', '3', 'pre2', '2', 'nope', null].map((k) => selectableLevel(k).key),
      ['10', '5', '5', '5', '2', '5', '5']);
  });
});

describe('stateOfStage', () => {
  it('maps SRS stages onto heat-map states', () => {
    assertEqual([0, 1, 4, 5, 6, 7, 8, 9].map(stateOfStage),
      ['lesson', 'apprentice', 'apprentice', 'guru', 'guru', 'master', 'enlightened', 'burned']);
  });
});

describe('kankenCoverage', () => {
  const cov = kankenCoverage('10', subs, asgById);

  it('covers the whole level and only the level', () => {
    assertEqual(cov.total, 80);
    assertEqual(cov.sections.map((s) => s.grade), ['1']);
    assertEqual(cov.sections[0].cells.length, 80);
    assertEqual(Object.values(cov.counts).reduce((a, b) => a + b, 0), 80);
  });

  it('grades each kanji by its WaniKani assignment', () => {
    const state = (ch) => cov.sections[0].cells.find((c) => c.ch === ch).state;
    assertEqual([state('一'), state('人'), state('日'), state('月'), state('花')],
      ['enlightened', 'guru', 'apprentice', 'apprentice', 'absent']);
    assertEqual([cov.onWk, cov.started, cov.passed, cov.burned], [4, 4, 2, 0]);
    assertEqual(cov.counts.absent, 76);
  });

  it('ignores radicals and vocabulary that share a character with a kanji', () => {
    const cell = cov.sections[0].cells.find((c) => c.ch === '一');
    assertEqual(cell.wkLevel, 1);
    assertEqual(cell.meaning, 'One'); // the kanji, not the "Ground" radical
  });

  it('sorts by WaniKani level, unlearnable kanji last', () => {
    const levels = cov.sections[0].cells.map((c) => c.wkLevel);
    assertEqual(levels.slice(0, 4), [1, 2, 3, 4]);
    assert(levels.slice(4).every((l) => l === null));
  });

  it('splits a multi-grade level into one section per grade', () => {
    const five = kankenCoverage('5', subs, asgById);
    assertEqual(five.sections.map((s) => s.grade), ['1', '2', '3', '4', '5', '6']);
    assertEqual(five.total, 1026);
    assertEqual(five.sections.map((s) => s.total), [80, 160, 200, 202, 193, 191]);
  });

  it('reaches the full jōyō list at 2級', () => {
    assertEqual(kankenCoverage('2', subs, asgById).total, 2136);
  });

  it('uses every state key it emits', () => {
    const known = new Set(KANJI_STATES.map((s) => s.key));
    for (const c of cov.sections[0].cells) assert(known.has(c.state), `unknown state ${c.state}`);
  });
});

describe('kanjiByCharacter / nonJoyoWaniKani', () => {
  it('indexes kanji subjects only', () => {
    const map = kanjiByCharacter(subs);
    assertEqual([...map.keys()].sort(), ['一', '人', '日', '月'].sort());
    assertEqual(map.get('人').id, 3); // kanji 人, not vocabulary 人
  });

  it('finds nothing outside the jōyō list in the fixture', () => {
    const out = nonJoyoWaniKani(subs, gradeOf);
    assertEqual([out.jinmeiyo.length, out.other.length], [0, 0]);
  });
});
