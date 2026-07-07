/* Draftly Planner service worker — makes the planner installable, usable
 * offline, and delivers gentle reminders.
 *
 * Caching: navigations are network-first (so deploys land) with a cached
 * fallback; hashed build assets + stock photos are cache-first (they never
 * change under the same URL). Bump CACHE to force a clean slate. All paths are
 * scope-relative so the same worker serves a domain root or a sub-path deploy.
 *
 * Reminders: reads the items the app mirrors into IndexedDB (see
 * src/lib/reminders.ts — keep the DB shape in sync) on 'periodicsync' wake-ups
 * and shows one gentle notification per item per day. */

// CACHE version uses build timestamp for automatic cache busting on each deploy
// The SW activate handler automatically deletes old cache versions, ensuring fresh assets
// Format: draftly-planner-v{TIMESTAMP}
const CACHE_VERSION = '20260707202218'; // Replaced by build script (scripts/inject-cache-version.js)
const CACHE = 'draftly-planner-v' + CACHE_VERSION;
const INDEX_URL = new URL('./', self.registration.scope).href;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(INDEX_URL, copy));
          return res;
        })
        .catch(() => caches.match(INDEX_URL)),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

/* ---------- gentle reminders ---------- */

const DB_NAME = 'draftly-planner-reminders';
const STORE = 'kv';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function kvGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function kvSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function checkReminders() {
  try {
    const db = await openDB();
    const items = (await kvGet(db, 'items')) || [];
    const notified = (await kvGet(db, 'notified')) || {};
    const now = new Date();
    const today = isoDate(now);
    const tomorrow = isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    let changed = false;
    for (const item of items) {
      if (item.date !== today && item.date !== tomorrow) continue;
      if (notified[item.id] === today) continue;
      await self.registration.showNotification('Draftly Planner', {
        body: item.text + (item.date === tomorrow ? ' (tomorrow)' : ''),
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: item.id,
      });
      notified[item.id] = today;
      changed = true;
    }
    if (changed) await kvSet(db, 'notified', notified);
  } catch (e) {
    /* reminders must never break the worker */
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'gentle-reminders') event.waitUntil(checkReminders());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => c.url.startsWith(self.registration.scope));
      if (open) return open.focus();
      return self.clients.openWindow(INDEX_URL + '#/tool/bills');
    }),
  );
});
