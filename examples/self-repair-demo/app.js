// Self-repair demo app: a tiny ledger (add entries, see a running total,
// clear them all). ONE store, ONE planted bug - see README.md in this
// directory for the full self-repair-loop walkthrough this app exists to
// exercise (witness the bug -> patch this file -> verify -> causal-diff).
//
// No framework, no build step - plain IndexedDB, matches this repo's own
// zero-dependency convention.

const DB_NAME = 'self_repair_demo';
const DB_VERSION = 1;
const STORE = 'entries';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

function getAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllKeys(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function addEntry(amount, label) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const keys = await getAllKeys(store);
  const nextId = keys.length ? Math.max(...keys) + 1 : 1; // explicit id - no autoIncrement (not rewindable by a replay)
  store.put({ id: nextId, amount, label: label || '' });
  await txDone(tx);
  db.close();
}

// PLANTED BUG: this loop leaves the LAST row un-deleted (off-by-one -
// `keys.length - 1` should be `keys.length`). "Clear all" should empty the
// store; it silently leaves one entry behind instead. This is the bug the
// self-repair loop's demo walkthrough finds and fixes - see README.md.
async function clearAll() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const keys = await getAllKeys(store);
  for (let i = 0; i < keys.length - 1; i++) {
    store.delete(keys[i]);
  }
  await txDone(tx);
  db.close();
}

async function render() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const rows = await getAll(tx.objectStore(STORE));
  db.close();
  rows.sort((a, b) => a.id - b.id);
  const list = document.getElementById('entryList');
  list.innerHTML = '';
  let total = 0;
  for (const row of rows) {
    total += row.amount;
    const li = document.createElement('li');
    li.textContent = `#${row.id} ${row.label ? `${row.label}: ` : ''}${row.amount}`;
    list.appendChild(li);
  }
  document.getElementById('totalDisplay').textContent = String(total);
  document.getElementById('countDisplay').textContent = String(rows.length);
}

function wire() {
  document.getElementById('addEntryBtn').addEventListener('click', async () => {
    const amountInput = document.getElementById('addAmount');
    const labelInput = document.getElementById('addLabel');
    const amount = parseFloat(amountInput.value);
    if (!Number.isFinite(amount)) return;
    await addEntry(amount, labelInput.value);
    amountInput.value = '';
    labelInput.value = '';
    await render();
  });
  document.getElementById('clearAllBtn').addEventListener('click', async () => {
    await clearAll();
    await render();
  });
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire);
} else {
  wire();
}
