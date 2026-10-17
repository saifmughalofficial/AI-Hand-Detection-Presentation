// Recent files, kept in this browser's IndexedDB so a deck reopens with one click.
// Files stay on this PC; nothing is uploaded.
const DB = "ahdp-recent";
const STORE = "files";
const MAX_FILES = 6;
const MAX_BYTES = 80 * 1024 * 1024;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "name" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(result?.result ?? result);
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  }));
}

/** Newest first: [{ name, size, date }]. */
export async function listRecent() {
  const all = await run("readonly", (s) => s.getAll());
  return all.sort((a, b) => b.date - a.date).map(({ name, size, date }) => ({ name, size, date }));
}

export async function getRecent(name) {
  const rec = await run("readonly", (s) => s.get(name));
  return rec ? new File([rec.blob], rec.name, { type: rec.blob.type }) : null;
}

export async function addRecent(file) {
  if (file.size > MAX_BYTES) return;
  const all = await run("readonly", (s) => s.getAll());
  const stale = all.filter((r) => r.name !== file.name).sort((a, b) => b.date - a.date).slice(MAX_FILES - 1);
  await run("readwrite", (s) => {
    for (const r of stale) s.delete(r.name);
    s.put({ name: file.name, size: file.size, date: Date.now(), blob: file });
  });
}

export function removeRecent(name) {
  return run("readwrite", (s) => s.delete(name));
}
