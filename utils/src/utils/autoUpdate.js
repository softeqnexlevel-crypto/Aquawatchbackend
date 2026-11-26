// src/utils/autoUpdate.js
// Keeps an open website up to date without anyone pressing refresh.
//   1. Every few minutes it checks /version.json. When a newer build has been
//      uploaded, the page reloads itself (only while the tab is hidden or the
//      user has been idle, so nobody is interrupted mid-click).
//   2. When a new build arrives, and at least once a week, it removes old saved
//      data: remembered last-known readings and outdated layout versions.
//      Login details and the current layouts are never touched.

const CHECK_MS = 5 * 60 * 1000;          // how often to look for a new version
const IDLE_MS = 2 * 60 * 1000;           // reload only after this much inactivity
const CLEAN_EVERY_MS = 7 * 24 * 3600 * 1000;
const CLEANED_KEY = 'cache-cleaned-at';

const safe = (fn) => { try { return fn(); } catch { return undefined; } };

function clearOldData() {
  safe(() => {
    const keys = Object.keys(localStorage);

    // Remembered "last known" readings (they are re-created automatically).
    keys.filter((k) => k.startsWith('lastknown:')).forEach((k) => localStorage.removeItem(k));

    // Old versions of saved layouts, e.g. mimic-layout-v9 when v10 exists.
    const families = {};
    keys.forEach((k) => {
      const m = k.match(/^(.*)-v(\d+)$/);
      if (m) (families[m[1]] = families[m[1]] || []).push({ k, v: Number(m[2]) });
    });
    Object.values(families).forEach((list) => {
      const newest = Math.max(...list.map((x) => x.v));
      list.filter((x) => x.v < newest).forEach((x) => localStorage.removeItem(x.k));
    });

    localStorage.setItem(CLEANED_KEY, String(Date.now()));
  });

  // Files kept by the browser's offline cache, if any.
  safe(() => {
    if (window.caches) caches.keys().then((names) => names.forEach((n) => caches.delete(n)));
  });
}

export function startAutoUpdate() {
  if (import.meta.env.DEV) return;                         // not while developing
  if (typeof __BUILD_ID__ === 'undefined') return;

  // Weekly clean-up.
  const last = Number(safe(() => localStorage.getItem(CLEANED_KEY))) || 0;
  if (Date.now() - last > CLEAN_EVERY_MS) clearOldData();

  // Track when the user last did something.
  let lastInput = Date.now();
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((ev) =>
    window.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true })
  );

  let busy = false;
  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { buildId } = await res.json();
      if (!buildId || buildId === __BUILD_ID__) return;

      // Don't interrupt someone who is actively using the page.
      const quiet = document.hidden || Date.now() - lastInput > IDLE_MS;
      if (!quiet) return;                                   // try again at the next check

      // Safety: never reload more than once for the same new version.
      if (safe(() => sessionStorage.getItem('reloaded-for')) === buildId) return;
      safe(() => sessionStorage.setItem('reloaded-for', buildId));

      clearOldData();
      window.location.reload();
    } catch {
      /* offline or server busy: try again later */
    } finally {
      busy = false;
    }
  };

  setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  setTimeout(check, 15000);
}