// Tiny IndexedDB wrapper. Songs keep their reference audio, the target
// contour, and the history of practice takes.

const DB_NAME = 'pitchperfect';
const STORE = 'songs';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export const listSongs = async () => {
  const all = await tx('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
};
export const getSong = (id) => tx('readonly', (s) => s.get(id));
export const saveSong = (song) => tx('readwrite', (s) => s.put(song));
export const deleteSong = (id) => tx('readwrite', (s) => s.delete(id));
