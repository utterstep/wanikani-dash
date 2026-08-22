import { WkApi, AuthError, OfflineError } from './api.js';
import { openDb, deleteDb } from './db.js';
import { sync, loadModel } from './sync.js';
import { renderAll, setStatus, setProgress } from './render.js';
import { attachTooltips } from './charts.js';
import { initTheme } from './theme.js';

const KEY = 'wk_api_key';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MOCK = params.has('mock');

let db;
let model;
let fetchImpl;

async function boot() {
  initTheme();
  attachTooltips($('dashboard'));
  if (MOCK) {
    const { installMock } = await import('../tests/mock-api.js');
    fetchImpl = await installMock(params.get('mock'));
  }
  db = await openDb();
  wireUi();

  const key = localStorage.getItem(KEY);
  if (!key) { openSettings('Paste your WaniKani API token to get started.'); return; }

  model = await loadModel(db);
  if (model.lastSync) renderAll(model); // show cached immediately
  await refresh();
}

async function refresh() {
  const key = localStorage.getItem(KEY);
  if (!key) return;
  const btn = $('refresh');
  btn.disabled = true;
  setStatus('');
  try {
    const api = new WkApi(key, { fetch: fetchImpl, onProgress: setProgress });
    const r = await sync(api, db);
    setProgress(null);
    model = await loadModel(db);
    renderAll(model);
    if (r.firstRun) setStatus('First sync done. Review history starts today and grows each time you open this page.', 'info');
    else if (r.reviews || r.srsEvents) setStatus(`+${r.reviews} reviews, ${r.srsEvents} SRS changes since last sync.`, 'info');
  } catch (e) {
    setProgress(null);
    if (e instanceof AuthError) {
      openSettings('WaniKani rejected that API token. Check it and save again.');
    } else if (e instanceof OfflineError) {
      setStatus(model?.lastSync ? `Offline — showing data from ${new Date(model.lastSync).toLocaleString()}.` : 'Offline and no cached data yet.', 'warn');
      if (model?.lastSync) renderAll(model);
    } else {
      console.error(e);
      setStatus(`Sync failed: ${e.message}`, 'error');
      if (model?.lastSync) renderAll(model);
    }
  } finally {
    btn.disabled = false;
  }
}

function openSettings(msg = '') {
  $('settings-msg').textContent = msg;
  $('api-key').value = localStorage.getItem(KEY) ?? '';
  $('settings').showModal();
}

function wireUi() {
  $('refresh').addEventListener('click', refresh);
  $('open-settings').addEventListener('click', () => openSettings());
  $('settings-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = $('api-key').value.trim();
    if (!v) return;
    const prev = localStorage.getItem(KEY);
    localStorage.setItem(KEY, v);
    $('settings').close();
    if (prev && prev !== v) await wipeData();
    model = await loadModel(db);
    await refresh();
  });
  $('forget').addEventListener('click', async () => {
    if (!confirm('Forget the API key and delete all locally stored history?')) return;
    localStorage.removeItem(KEY);
    await wipeData();
    $('settings').close();
    $('dashboard').hidden = true;
    openSettings('Data wiped.');
  });
  $('export').addEventListener('click', async () => {
    const m = await loadModel(db);
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), user: m.user, srs_events: m.srsEvents, review_events: m.reviewEvents, syncs: m.syncDates }, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `wkdash-history-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (model?.lastSync) renderAll(model); }, 150); });
  $('days-select').addEventListener('change', (ev) => {
    localStorage.setItem('wk_days', ev.target.value);
    if (model) renderAll(model);
  });
}

async function wipeData() {
  db.close();
  await deleteDb();
  db = await openDb();
}

boot().catch((e) => { console.error(e); setStatus(`Failed to start: ${e.message}`, 'error'); });
