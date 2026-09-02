// In-memory implementation of the store interface (tests/reference/sync.js) for the
// browser e2e fake server. Mirrors the SQLite semantics, including srs_events dedupe.

import { KEYED, EVENTS } from './reference/tables.js';

export class MemoryStore {
  constructor() { this.reset(); }

  reset() {
    this.meta = new Map();
    this.keyed = Object.fromEntries(Object.keys(KEYED).map((t) => [t, new Map()]));
    this.events = Object.fromEntries(EVENTS.map((t) => [t, []]));
    this.dedupe = new Set();
    this.nextId = Object.fromEntries(EVENTS.map((t) => [t, 1]));
  }

  init() {}
  getMeta(k) { return this.meta.get(k); }
  setMeta(k, v) { this.meta.set(k, v); }
  getMany(table, keys) { return keys.map((k) => this.keyed[table].get(k)?.data); }
  putAll(table, rows, syncId) { for (const r of rows) this.keyed[table].set(r[KEYED[table]], { sync_id: syncId, data: r }); }
  addAll(table, rows, syncId) {
    let n = 0;
    for (const r of rows) {
      if (table === 'srs_events') {
        const d = `${r.subject_id}|${r.at}|${r.to}`;
        if (this.dedupe.has(d)) continue;
        this.dedupe.add(d);
      }
      this.events[table].push({ id: this.nextId[table]++, sync_id: syncId, data: r });
      n += 1;
    }
    return n;
  }
  since(table, syncId) {
    if (KEYED[table]) return [...this.keyed[table].entries()].filter(([, v]) => v.sync_id > syncId).sort((a, b) => a[0] - b[0]).map(([, v]) => v.data);
    return this.events[table].filter((e) => e.sync_id > syncId).map((e) => ({ id: e.id, ...e.data }));
  }
  count(table) { return KEYED[table] ? this.keyed[table].size : this.events[table].length; }

  dump() {
    return {
      meta: [...this.meta], keyed: Object.fromEntries(Object.entries(this.keyed).map(([t, m]) => [t, [...m]])),
      events: this.events, dedupe: [...this.dedupe], nextId: this.nextId,
    };
  }

  load(d) {
    this.meta = new Map(d.meta);
    this.keyed = Object.fromEntries(Object.entries(d.keyed).map(([t, m]) => [t, new Map(m)]));
    this.events = d.events; this.dedupe = new Set(d.dedupe); this.nextId = d.nextId;
  }
}
