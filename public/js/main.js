import { WkApi, AuthError, OfflineError } from './api.js';
import { ServerApi } from './server.js';
import { openDb, deleteDb } from './db.js';
import { applyState, loadModel } from './pull.js';
import { refreshLocal } from './local.js';
import { renderAll, setStatus, setProgress, KANKEN_KEY } from './render.js';
import { attachTooltips } from './charts.js';
import { initTheme } from './theme.js';

const KEY = 'wk_api_key';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MOCK = params.has('mock');

let db;
let model;
let wkFetch;      // fetch used for api.wanikani.com (mocked in tests)
let serverFetch;  // fetch used for /api (mocked in tests)

async function boot() {
  initTheme();
  attachTooltips($('dashboard'));
  if (MOCK) {
    const { installMock } = await import('../../tests/mock-api.js');
    ({ wk: wkFetch, server: serverFetch } = await installMock(params.get('mock')));
  }
  db = await openDb();
  wireUi();

  const key = localStorage.getItem(KEY);
  if (!key) { openSettings('Paste your WaniKani API token to get started.'); return; }

  model = await loadModel(db);
  if (model.lastSync) renderAll(model); // show cached immediately
  // First contact for this browser goes through connect(); afterwards a plain refresh.
  if ((await db.getMeta('server_version')) === undefined) await connect();
  else await refresh();
}

function apis() {
  const key = localStorage.getItem(KEY);
  return {
    wk: new WkApi(key, { fetch: wkFetch, onProgress: setProgress }),
    server: new ServerApi(key, { fetch: serverFetch }),
  };
}

/**
 * First contact with the server for the current token: which account is it and does it have data.
 * (History collected by the old GitHub Pages version is uploaded by that origin's page, see /index.html.)
 * Then a normal refresh.
 */
async function connect() {
  const { server } = apis();
  const btn = $('refresh');
  btn.disabled = true;
  setStatus('');
  try {
    const st = await server.state(0);
    const localUser = await db.getMeta('user');
    if (localUser?.id && st.account.user?.id && localUser.id !== st.account.user.id) await resetAccountLocal();

    if (st.account.status === 'empty') {
      await db.setMeta('server_version', 0);
      setStatus('First sync on the server — this can take a minute.', 'info');
    } else {
      await applyState(db, st);
    }
  } catch (e) {
    btn.disabled = false;
    return handleError(e);
  }
  await refresh({ keepStatus: true });
}

async function refresh({ keepStatus = false } = {}) {
  const key = localStorage.getItem(KEY);
  if (!key) return;
  const { wk, server } = apis();
  const btn = $('refresh');
  btn.disabled = true;
  if (!keepStatus) setStatus('');
  try {
    const [r] = await Promise.all([server.sync(), refreshLocal(wk, db)]);
    const since = (await db.getMeta('server_version')) ?? 0;
    const st = await server.state(since);
    await applyState(db, st);
    setProgress(null);
    model = await loadModel(db);
    renderAll(model);
    // What's new: the sync we just triggered, or else whatever the server collected since this browser last looked.
    const pulled = { srsEvents: st.srs_events.length, reviews: st.review_events.reduce((n, e) => n + e.reviews, 0) };
    const delta = r.ran ? r : since > 0 && st.since > 0 ? pulled : null;
    if (st.account.status === 'auth_failed') openSettings('WaniKani rejected the token stored on the server. Paste a fresh one to resume collection.');
    else if (r.ran && r.firstRun) setStatus('First sync done. Review history starts today and grows every 15 minutes on the server.', 'info');
    else if (delta && (delta.reviews || delta.srsEvents)) setStatus(`+${delta.reviews} reviews, ${delta.srsEvents} SRS changes since last sync.`, 'info');
    else setStatus('');
  } catch (e) {
    handleError(e);
  } finally {
    setProgress(null);
    btn.disabled = false;
  }
}

function handleError(e) {
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
}

function openSettings(msg = '') {
  $('settings-msg').textContent = msg;
  $('api-key').value = localStorage.getItem(KEY) ?? '';
  $('settings').showModal();
}

function wireUi() {
  $('refresh').addEventListener('click', () => refresh());
  $('open-settings').addEventListener('click', () => openSettings());
  $('settings-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = $('api-key').value.trim();
    if (!v) return;
    localStorage.setItem(KEY, v);
    $('settings').close();
    model = await loadModel(db);
    await connect(); // decides by account id whether local data still applies
  });
  $('forget-local').addEventListener('click', async () => {
    if (!confirm('Forget the API key on this device and clear the local cache? The server keeps your history.')) return;
    localStorage.removeItem(KEY);
    await wipeLocal();
    $('settings').close();
    $('dashboard').hidden = true;
    openSettings('Forgotten on this device.');
  });
  $('delete-server').addEventListener('click', async () => {
    if (!confirm('Delete your account and ALL review history on the server? Every device starts from scratch. This cannot be undone.')) return;
    try {
      await apis().server.deleteAccount();
    } catch (e) {
      $('settings-msg').textContent = `Could not delete on the server: ${e.message}`;
      return;
    }
    localStorage.removeItem(KEY);
    await wipeLocal();
    $('settings').close();
    $('dashboard').hidden = true;
    openSettings('Deleted on the server and on this device.');
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
  $('kanken-select').addEventListener('change', (ev) => {
    localStorage.setItem(KANKEN_KEY, ev.target.value);
    if (model) renderAll(model);
  });
  // The chosen level lives in the <select> itself; it goes back to the current level on reload.
  $('level-select').addEventListener('change', () => { if (model) renderAll(model); });
}

/** Drop everything account-specific but keep the (global) subjects cache. */
async function resetAccountLocal() {
  for (const st of ['assignments', 'review_statistics', 'level_progressions', 'srs_events', 'review_events', 'syncs']) await db.clear(st);
  for (const k of ['user', 'summary', 'history_since', 'last_sync', 'status']) await db.setMeta(k, undefined);
  await db.setMeta('server_version', 0);
  model = await loadModel(db);
}

async function wipeLocal() {
  db.close();
  await deleteDb();
  db = await openDb();
  model = undefined;
}

boot().catch((e) => { console.error(e); setStatus(`Failed to start: ${e.message}`, 'error'); });
