// 本机工作副本（IndexedDB）：学习时的读写都先落在这里，再同步到 GitHub 上的 Obsidian 仓库。
// 插件的后台和页面同源，共用同一个数据库。
const DB = "kld";
let dbp;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("clips", { keyPath: "id" });
      req.result.createObjectStore("frames"); // key: `${clipId}-${n}` → Blob
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const getClip = (id) => tx("clips", "readonly", (s) => s.get(id));
export const putClip = (clip) => tx("clips", "readwrite", (s) => s.put(clip));
export const allClips = () => tx("clips", "readonly", (s) => s.getAll());
export const deleteClipLocal = (id) => tx("clips", "readwrite", (s) => s.delete(id));

export const getFrame = (key) => tx("frames", "readonly", (s) => s.get(key));
export const putFrame = (key, blob) => tx("frames", "readwrite", (s) => s.put(blob, key));
export const deleteFrame = (key) => tx("frames", "readwrite", (s) => s.delete(key));
