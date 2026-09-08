import { describe, it, assertEqual, assert } from './harness.js';
import { niceTicks, columnChart, divergingChart, stackedBars, stepChart, legend } from '../public/js/charts.js';

const parse = (svg) => new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;

describe('niceTicks', () => {
  it('produces round ticks covering max', () => {
    assertEqual(niceTicks(0), [0]);
    assertEqual(niceTicks(7), [0, 2, 4, 6, 8]);
    assertEqual(niceTicks(100), [0, 25, 50, 75, 100]);
    assert(niceTicks(1234).at(-1) >= 1234);
  });
});

describe('columnChart', () => {
  it('renders one hit group per datum with tooltips and escapes text', () => {
    const svg = parse(columnChart([{ label: 'a', value: 3 }, { label: '<b>', value: 0, gap: true }], { title: 'T' }));
    assertEqual(svg.tagName, 'svg');
    assertEqual(svg.querySelectorAll('.hit').length, 2);
    assertEqual(svg.querySelectorAll('.gap').length, 1);
    assertEqual(svg.querySelectorAll('.hit')[1].getAttribute('data-tip'), '<b>: 0');
    assert(svg.querySelectorAll('path.mark')[0].getAttribute('d').startsWith('M'));
  });
  it('draws reference line', () => {
    const svg = parse(columnChart([{ label: 'a', value: 3 }], { title: 'T', refLine: { value: 2, label: 'med' } }));
    assertEqual(svg.querySelectorAll('.ref').length, 1);
  });
});

describe('divergingChart', () => {
  it('stacks ups above and downs below the axis', () => {
    const svg = parse(divergingChart([{ label: 'd', up: [{ cls: 'x', name: 'X', value: 2 }, { cls: 'y', name: 'Y', value: 1 }], down: [{ cls: 'z', name: 'Z', value: 1 }] }], { title: 'T' }));
    const axisY = Number(svg.querySelector('.axis').getAttribute('y1'));
    const marks = [...svg.querySelectorAll('path.mark')];
    assertEqual(marks.length, 3);
    const ys = marks.map((m) => Number(m.getAttribute('d').match(/M[\d.]+,([\d.]+)/)[1]));
    assert(ys[0] <= axisY && ys[2] >= axisY, 'up starts at/above axis, down at/below');
    assert(svg.querySelector('.hit').getAttribute('data-tip').includes('▲3 ▼1'));
  });
});

describe('stackedBars + legend', () => {
  it('renders rows, totals and legend', () => {
    const svg = parse(stackedBars([{ label: 'Kanji', parts: [{ cls: 'a', name: 'A', value: 10 }, { cls: 'b', name: 'B', value: 0 }] }], { title: 'T' }));
    assertEqual(svg.querySelectorAll('rect.mark').length, 1);
    assert(svg.textContent.includes('10'));
    const ul = new DOMParser().parseFromString(legend([{ cls: 'a', name: 'A & B' }]), 'text/html').querySelector('ul');
    assertEqual(ul.querySelectorAll('li').length, 1);
    assertEqual(ul.textContent, 'A & B');
  });
});

describe('stepChart', () => {
  it('draws a staircase per series, a dot per passed item and the threshold', () => {
    const svg = parse(stepChart([
      { cls: 'level-current', endX: 5, points: [{ x: 0, y: 0 }, { x: 2, y: 1, tip: 'two' }, { x: 3, y: 2 }] },
      { cls: 'level', muted: true, endX: 7, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    ], { title: 'T', threshold: { value: 8, label: '8 to level up' } }));
    assertEqual(svg.querySelectorAll('path.line').length, 2);
    assertEqual(svg.querySelectorAll('.hit').length, 3);
    assert([...svg.querySelectorAll('.hit')].some((h) => h.getAttribute('data-tip') === 'two'));
    assertEqual(svg.querySelectorAll('.ref').length, 1);
    assert(svg.querySelector('path.line.level-current').getAttribute('d').includes(' H'));
    assert(svg.textContent.includes('8 to level up'));
  });
  it('fills bands, dashes reference lines and can drop dots or tooltips', () => {
    const svg = parse(stepChart([
      { cls: 'a', dots: false, endX: 4, points: [{ x: 0, y: 1 }, { x: 2, y: 3 }] },
      { cls: 'm', dashed: true, hits: false, points: [{ x: 0, y: 0 }, { x: 1, y: 2 }] },
    ], { title: 'T', xLabel: (v) => `day ${v}`, bands: [{ cls: 'b', points: [{ x: 0, lo: 0, hi: 1 }, { x: 2, lo: 1, hi: 4 }, { x: 4, lo: 2, hi: 6 }] }] }));
    assertEqual(svg.querySelectorAll('path.band.b').length, 1);
    assert(svg.querySelector('path.band').getAttribute('d').endsWith('Z'));
    assertEqual(svg.querySelectorAll('path.line.dashed').length, 1);
    assertEqual(svg.querySelectorAll('.hit').length, 2);       // series a only
    assertEqual(svg.querySelectorAll('.dot').length, 0);
    assert(svg.textContent.includes('day 0'));
    assert(svg.querySelector('.hit').getAttribute('data-tip').startsWith('day 0'));
    assert(svg.textContent.includes('6'), 'y axis covers the band');
  });
  it('draws bars on a right-hand axis behind the lines', () => {
    const svg = parse(stepChart([{ cls: 'a', dots: false, endX: 3, points: [{ x: 0, y: 10 }, { x: 1, y: 12 }] }],
      { title: 'T', bars: { cls: 'b', points: [{ x: 0, y: 0 }, { x: 1, y: 3 }, { x: 2, y: 7 }, { x: 3, y: 0 }] } }));
    assertEqual(svg.querySelectorAll('rect.bar.b').length, 2, 'zero-height bars are skipped');
    assert(svg.querySelector('text.tick.b') !== null, 'right axis ticks carry the bar class');
    assert([...svg.querySelectorAll('text.tick.b')].some((t) => t.textContent === '6'), 'right axis is scaled to the bars, not the lines');
    const nodes = [...svg.children];
    assert(nodes.findIndex((n) => n.matches('rect.bar')) < nodes.findIndex((n) => n.matches('path.line')), 'bars are behind the line');
    assertEqual(parse(stepChart([], { title: 'T', bars: { points: [] } })).tagName, 'svg');
  });
  it('copes with empty series', () => {
    assertEqual(parse(stepChart([{ cls: 'x', points: [] }], { title: 'T' })).tagName, 'svg');
    assertEqual(parse(stepChart([], { title: 'T' })).tagName, 'svg');
  });
});
