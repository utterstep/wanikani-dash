// Pure SVG chart builders. Each returns an HTML string; colors come from CSS classes.
// Interactivity: marks carry data-tip; attachTooltips() wires one shared tooltip per page.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function niceTicks(max, count = 4, { integer = false } = {}) {
  if (max <= 0) return [0];
  const raw = max / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
  if (integer) step = Math.max(1, Math.round(step));
  const ticks = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(6));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** Rounded-top bar path (square at baseline). Handles negative heights (rounded bottom). */
function barPath(x, y0, w, h, r = 4) {
  if (h === 0) return '';
  r = Math.min(r, w / 2, Math.abs(h));
  if (h > 0) {
    const y = y0 - h;
    return `M${x},${y0} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y0} Z`;
  }
  const y = y0 - h; // below baseline
  return `M${x},${y0} V${y - r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y - r} V${y0} Z`;
}

const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1));

/**
 * Simple column chart.
 * @param {{label:string, value:number, cls?:string, tip?:string, muted?:boolean}[]} data
 * @param {{height?:number, refLine?:{value:number,label:string}, xEvery?:number, title:string}} opts
 */
export function columnChart(data, opts = {}) {
  const H = opts.height ?? 200, padL = 36, padR = 8, padT = 12, padB = 22;
  const W = Math.max(opts.width ?? 640, data.length * 6 + padL + padR);
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(0, ...data.map((d) => d.value), opts.refLine?.value ?? 0);
  const ticks = niceTicks(max, 4, { integer: !!opts.integer });
  const top = ticks[ticks.length - 1] || 1;
  const y = (v) => padT + plotH - (v / top) * plotH;
  const slot = plotW / data.length;
  const bw = Math.min(24, Math.max(2, slot - 2));
  const xEvery = opts.xEvery ?? Math.ceil(data.length / Math.max(4, Math.floor(plotW / 52)));

  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title)}">`;
  for (const t of ticks) {
    s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/>`;
    s += `<text class="tick" x="${padL - 6}" y="${y(t) + 3}" text-anchor="end">${fmt(t)}</text>`;
  }
  data.forEach((d, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const h = (d.value / top) * plotH;
    const cls = `mark ${d.cls ?? ''} ${d.muted ? 'muted' : ''}`;
    s += `<g class="hit" data-tip="${esc(d.tip ?? `${d.label}: ${fmt(d.value)}`)}">`;
    s += `<rect class="hitbox" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}"/>`;
    if (d.gap) s += `<rect class="gap" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}"/>`;
    s += `<path class="${cls}" d="${barPath(x, y(0), bw, h)}"/></g>`;
    if (i % xEvery === 0 || d.forceLabel) s += `<text class="tick" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  if (opts.refLine) {
    const ry = y(opts.refLine.value);
    s += `<line class="ref" x1="${padL}" x2="${W - padR}" y1="${ry}" y2="${ry}"/>`;
    s += `<text class="ref-label" x="${W - padR}" y="${ry - 4}" text-anchor="end">${esc(opts.refLine.label)}</text>`;
  }
  return s + '</svg>';
}

/** Stack segments from baseline y0 in direction dir (+1 up, -1 down); 2px gaps, rounded outer end. */
function stack(parts, x, y0, bw, scale, dir) {
  let out = '', acc = 0;
  parts.forEach((p, i) => {
    const h = p.value * scale;
    const gap = i ? 2 : 0;
    const last = i === parts.length - 1;
    out += `<path class="mark ${p.cls}" d="${barPath(x, y0 - dir * (acc + gap), bw, dir * Math.max(0.5, h - gap), last ? 4 : 0)}"/>`;
    acc += h;
  });
  return out;
}

/**
 * Diverging stacked columns: positive stacks upward, negative downward.
 * @param {{label:string, up:{cls:string,value:number,name:string}[], down:{...}[], gap?:boolean}[]} data
 */
export function divergingChart(data, opts = {}) {
  const H = opts.height ?? 220, padL = 36, padR = 8, padT = 12, padB = 22;
  const W = Math.max(opts.width ?? 640, data.length * 6 + padL + padR);
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const sum = (xs) => xs.reduce((a, b) => a + b.value, 0);
  const maxUp = Math.max(0, ...data.map((d) => sum(d.up)));
  const maxDown = Math.max(0, ...data.map((d) => sum(d.down)));
  const ticksUp = niceTicks(maxUp, 2, { integer: true }), ticksDown = niceTicks(maxDown, 2, { integer: true });
  const topUp = ticksUp[ticksUp.length - 1] || 1, topDown = ticksDown[ticksDown.length - 1] || 1;
  const scale = plotH / (topUp + topDown);
  const y0 = padT + topUp * scale;
  const slot = plotW / data.length;
  const bw = Math.min(24, Math.max(2, slot - 2));
  const xEvery = opts.xEvery ?? Math.ceil(data.length / Math.max(4, Math.floor(plotW / 52)));

  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title)}">`;
  for (const t of ticksUp) { const yy = y0 - t * scale; s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/><text class="tick" x="${padL - 6}" y="${yy + 3}" text-anchor="end">${fmt(t)}</text>`; }
  for (const t of ticksDown) { if (t === 0) continue; const yy = y0 + t * scale; s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/><text class="tick" x="${padL - 6}" y="${yy + 3}" text-anchor="end">−${fmt(t)}</text>`; }
  s += `<line class="axis" x1="${padL}" x2="${W - padR}" y1="${y0}" y2="${y0}"/>`;
  data.forEach((d, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const u = sum(d.up), dn = sum(d.down);
    const tip = `${d.label}: ▲${u} ▼${dn}` + [...d.up, ...d.down].filter((p) => p.value).map((p) => `\n${p.name}: ${p.value}`).join('');
    s += `<g class="hit" data-tip="${esc(tip)}"><rect class="hitbox" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}"/>`;
    if (d.gap) s += `<rect class="gap" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}"/>`;
    s += stack(d.up.filter((p) => p.value), x, y0, bw, scale, 1);
    s += stack(d.down.filter((p) => p.value), x, y0, bw, scale, -1);
    s += '</g>';
    if (i % xEvery === 0) s += `<text class="tick" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  return s + '</svg>';
}

/**
 * Horizontal stacked bars (one row per category), with inline labels where they fit.
 * @param {{label:string, total:number, parts:{cls:string,value:number,name:string}[]}[]} rows
 */
export function stackedBars(rows, opts = {}) {
  const rowH = 28, gap = 10, padL = opts.padL ?? 84, padR = 48, W = Math.min(640, Math.max(360, opts.width ?? 480));
  const H = rows.length * (rowH + gap) - gap + 4;
  const max = Math.max(1, ...rows.map((r) => r.parts.reduce((a, p) => a + p.value, 0)));
  const plotW = W - padL - padR;
  let s = `<svg class="chart stacked" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title)}">`;
  rows.forEach((r, i) => {
    const y = i * (rowH + gap) + 2;
    const total = r.parts.reduce((a, p) => a + p.value, 0);
    s += `<text class="row-label" x="${padL - 10}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(r.label)}</text>`;
    let x = padL;
    for (const p of r.parts) {
      if (!p.value) continue;
      const w = (p.value / max) * plotW;
      const inner = Math.max(0, w - 2);
      s += `<g class="hit" data-tip="${esc(`${r.label} · ${p.name}: ${p.value.toLocaleString()} (${Math.round((p.value / total) * 100)}%)`)}">`;
      s += `<rect class="mark ${p.cls}" x="${x}" y="${y}" width="${inner}" height="${rowH}" rx="3"/>`;
      if (inner > 34) s += `<text class="inner-label" x="${x + inner / 2}" y="${y + rowH / 2 + 4}" text-anchor="middle">${p.value.toLocaleString()}</text>`;
      s += '</g>';
      x += w;
    }
    s += `<text class="tick" x="${x + 6}" y="${y + rowH / 2 + 4}">${total.toLocaleString()}</text>`;
  });
  return s + '</svg>';
}

/**
 * Step lines (cumulative counts over days). Each series is drawn as a staircase from its first
 * point to `endX`, with a dot per point.
 * @param {{cls:string, points:{x:number,y:number,tip?:string}[], endX?:number, muted?:boolean}[]} series
 * @param {{title:string, width?:number, height?:number, threshold?:{value:number,label:string}}} opts
 */
export function stepChart(series, opts = {}) {
  const H = opts.height ?? 200, padL = 36, padR = 12, padT = 12, padB = 22;
  const W = opts.width ?? 640;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xs = series.flatMap((s) => [s.endX ?? 0, ...s.points.map((p) => p.x)]);
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  const xMax = Math.max(1, ...xs);
  const xTicks = niceTicks(xMax, 5, { integer: true });
  const xTop = xTicks[xTicks.length - 1] || 1;
  const yTicks = niceTicks(Math.max(0, ...ys, opts.threshold?.value ?? 0), 4, { integer: true });
  const yTop = yTicks[yTicks.length - 1] || 1;
  const x = (v) => padL + (v / xTop) * plotW;
  const y = (v) => padT + plotH - (v / yTop) * plotH;

  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title)}">`;
  for (const t of yTicks) s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${padL - 6}" y="${y(t) + 3}" text-anchor="end">${fmt(t)}</text>`;
  for (const t of xTicks) s += `<text class="tick" x="${x(t)}" y="${H - 6}" text-anchor="middle">${fmt(t)}d</text>`;
  if (opts.threshold) {
    const ry = y(opts.threshold.value);
    s += `<line class="ref" x1="${padL}" x2="${W - padR}" y1="${ry}" y2="${ry}"/><text class="ref-label" x="${W - padR}" y="${ry - 4}" text-anchor="end">${esc(opts.threshold.label)}</text>`;
  }
  // Muted series first so the main one is drawn on top.
  for (const ser of [...series].sort((a, b) => (b.muted ? 1 : 0) - (a.muted ? 1 : 0))) {
    if (!ser.points.length) continue;
    const cls = `${ser.cls ?? ''} ${ser.muted ? 'muted' : ''}`;
    let d = `M${x(ser.points[0].x)},${y(ser.points[0].y)}`;
    for (const p of ser.points.slice(1)) d += ` H${x(p.x)} V${y(p.y)}`;
    d += ` H${x(Math.max(ser.endX ?? 0, ser.points.at(-1).x))}`;
    s += `<path class="line ${cls}" d="${d}"/>`;
    // Dots only on the main series; the reference line stays quiet but keeps its tooltips.
    for (const p of ser.points) {
      if (!p.y) continue;
      s += `<g class="hit" data-tip="${esc(p.tip ?? `${fmt(p.x)}d: ${fmt(p.y)}`)}"><circle class="hitbox" cx="${x(p.x)}" cy="${y(p.y)}" r="8"/>${ser.muted ? '' : `<circle class="dot ${cls}" cx="${x(p.x)}" cy="${y(p.y)}" r="2.5"/>`}</g>`;
    }
  }
  return s + '</svg>';
}

/** Legend HTML for a set of classes. */
export function legend(items) {
  return `<ul class="legend">${items.map((i) => `<li><span class="swatch ${i.cls}"></span>${esc(i.name)}</li>`).join('')}</ul>`;
}

/**
 * Wire hover/tap tooltips for every .hit inside root. One tooltip element per page.
 * On touch devices (hover: none) a .hit that is a link needs two taps: the first
 * shows the tooltip, the second follows the link — otherwise inspecting a mark
 * would navigate away.
 */
export function attachTooltips(root = document) {
  let tip = document.getElementById('tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'tooltip';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  const touch = matchMedia('(hover: none)');
  let armed = null; // linked .hit whose next tap is allowed to navigate
  const show = (el, ev) => {
    const hint = touch.matches && el.href ? '\n(tap again to open)' : '';
    tip.textContent = el.dataset.tip + hint;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = ev.clientX + 12, y = ev.clientY - r.height - 12;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 12;
    if (y < 8) y = ev.clientY + 16;
    tip.style.transform = `translate(${Math.max(8, x)}px, ${y}px)`;
  };
  const hide = () => { tip.hidden = true; armed = null; };
  root.addEventListener('pointerover', (ev) => { const h = ev.target.closest('.hit'); if (h) show(h, ev); });
  root.addEventListener('pointermove', (ev) => { const h = ev.target.closest('.hit'); if (h) show(h, ev); });
  // Touch fires pointerout when the finger lifts — keep the tooltip up there,
  // it hides on the next tap elsewhere or on scroll.
  root.addEventListener('pointerout', (ev) => { if (ev.pointerType !== 'touch' && ev.target.closest('.hit') && !ev.relatedTarget?.closest?.('.hit')) hide(); });
  root.addEventListener('pointerdown', (ev) => { const h = ev.target.closest('.hit'); if (h) show(h, ev); else hide(); });
  root.addEventListener('click', (ev) => {
    if (!touch.matches) return;
    const h = ev.target.closest('a.hit');
    if (!h) { armed = null; return; }
    if (armed !== h) { ev.preventDefault(); armed = h; }
    else armed = null;
  });
  document.addEventListener('scroll', hide, { passive: true });
}
