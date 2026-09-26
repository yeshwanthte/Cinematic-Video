// Local persistence: project metadata in localStorage, source images in IndexedDB.
const LS_PROJECTS = 'cas.projects.v1';
const LS_SETTINGS = 'cas.settings.v1';
const DB_NAME = 'cinematic-ai-studio';
const STORE = 'images';

function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('localStorage write failed', e);
    return false;
  }
}

export const settingsStore = {
  load(defaults) {
    return { ...defaults, ...lsGet(LS_SETTINGS, {}) };
  },
  save(settings) {
    return lsSet(LS_SETTINGS, settings);
  },
};

export const projectStore = {
  all() {
    return lsGet(LS_PROJECTS, []).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  },
  get(id) {
    return this.all().find((p) => p.id === id) || null;
  },
  save(project) {
    const list = lsGet(LS_PROJECTS, []);
    const i = list.findIndex((p) => p.id === project.id);
    project.updatedAt = new Date().toISOString();
    if (i >= 0) list[i] = project;
    else list.push(project);
    if (!lsSet(LS_PROJECTS, list)) {
      // Storage full: drop thumbnails of the oldest projects and retry once.
      list.sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
      for (const p of list.slice(0, Math.ceil(list.length / 2))) if (p.id !== project.id) p.thumb = null;
      lsSet(LS_PROJECTS, list);
    }
    return project;
  },
  remove(id) {
    lsSet(LS_PROJECTS, lsGet(LS_PROJECTS, []).filter((p) => p.id !== id));
  },
  clear() {
    lsSet(LS_PROJECTS, []);
  },
};

let dbPromise;
function db() {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('IndexedDB unavailable'));
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
function tx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
      })
  );
}

export const imageStore = {
  put: (key, blob) => tx('readwrite', (s) => s.put(blob, key)).catch((e) => console.warn('image store', e)),
  get: (key) => tx('readonly', (s) => s.get(key)).catch(() => null),
  remove: (key) => tx('readwrite', (s) => s.delete(key)).catch(() => null),
  clear: () => tx('readwrite', (s) => s.clear()).catch(() => null),
};

export const uid = (p = 'p') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
