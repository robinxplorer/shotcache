// Minimal IndexedDB wrapper. Two object stores:
//   tray    — saved TrayItems (images as Blob + metadata)
//   pending — PendingCapture parked between background capture and the editor page
//
// Why IDB and not chrome.storage.local: storage.local serializes to JSON
// (no Blob) and has practical quota issues for images. IDB stores Blobs
// natively and `unlimitedStorage` lifts the quota.
//
// NOTE: the background service worker, the editor page and the side panel each
// open their own connection — that's fine, IDB handles concurrent readers.

import type { PendingCapture, TrayItem } from './types';

const DB_NAME = 'shotcache';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tray')) {
        db.createObjectStore('tray', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pending')) {
        db.createObjectStore('pending', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function tx<T>(
  store: 'tray' | 'pending',
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`IDB ${mode} on ${store} failed`));
        t.oncomplete = () => db.close();
      }),
  );
}

// --- tray ---

export const putTrayItem = (item: TrayItem) => tx('tray', 'readwrite', (s) => s.put(item));

export const getTrayItem = (id: string) =>
  tx<TrayItem | undefined>('tray', 'readonly', (s) => s.get(id));

export const deleteTrayItem = (id: string) => tx('tray', 'readwrite', (s) => s.delete(id));

export async function listTrayItems(): Promise<TrayItem[]> {
  const items = await tx<TrayItem[]>('tray', 'readonly', (s) => s.getAll());
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

// --- pending capture ---

export const putPending = (p: PendingCapture) => tx('pending', 'readwrite', (s) => s.put(p));

export const getPending = (id: string) =>
  tx<PendingCapture | undefined>('pending', 'readonly', (s) => s.get(id));

export const deletePending = (id: string) => tx('pending', 'readwrite', (s) => s.delete(id));

// --- expiry sweep ---

/**
 * Delete every record in `store` whose createdAt is older than ttlMs.
 * Returns the number of records removed. Both stores' records carry createdAt.
 *
 * Called from the background (startup + alarm, since setTimeout in a service
 * worker dies with the worker) and from the side panel before listing, so the
 * user never sees an expired item even if the alarm hasn't fired yet.
 */
export async function sweepStore(store: 'tray' | 'pending', ttlMs: number): Promise<number> {
  const cutoff = Date.now() - ttlMs;
  const items = await tx<Array<{ id: string; createdAt: number }>>(store, 'readonly', (s) =>
    s.getAll(),
  );
  const stale = items.filter((i) => i.createdAt < cutoff);
  for (const i of stale) {
    await tx(store, 'readwrite', (s) => s.delete(i.id));
  }
  return stale.length;
}
