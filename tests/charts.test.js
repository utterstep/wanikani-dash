import { describe, it, assertEqual, assert } from './harness.js';
import { niceTicks, columnChart, divergingChart, stackedBars, legend } from '../public/js/charts.js';

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
