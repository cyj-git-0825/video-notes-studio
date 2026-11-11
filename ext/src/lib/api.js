// 插件内的“后端”：沿用原来 KLD 服务器的接口路径，页面和侧边栏的代码不用大改。
// 数据先存本机 IndexedDB（工作副本），再同步到 GitHub 上的 Obsidian 仓库：
//   视频笔记/…md、视频笔记/attachments/*.jpg  —— 给人看的笔记
//   .kld/clips/<id>.json                     —— KLD 的学习数据（换电脑时从这里恢复）
import { aiAvailable, chatStream, splitTopics } from "./claude.js";
import * as gh from "./github.js";
import { generateNotes, notesAvailable } from "./notesai.js";
import { buildMarkdown, framePath, notePath } from "./markdown.js";
import { getSettings, hint } from "./settings.js";
import * as store from "./store.js";
import { fallbackTopics, parseSubs } from "./subs.js";
import * as xhs from "./xhs.js";

const now = () => new Date().toLocaleString("sv-SE").slice(0, 16); // 2026-10-24 12:30
const jobs = {};
const clipJson = (id) => `.kld/clips/${id}.json`;

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// 长任务期间每 20 秒碰一下扩展 API，防止后台 service worker 被 Chrome 判定空闲而停掉
export async function keepAlive(promise) {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try { return await promise; } finally { clearInterval(t); }
}

// ---------- 读写 ----------

async function load(id) {
  let clip = await store.getClip(id);
  if (!clip && (await gh.configured())) {
    // 本机没有（比如换了电脑），去仓库里找
    const buf = await gh.readFile(clipJson(id));
    if (buf) {
      clip = JSON.parse(new TextDecoder().decode(buf));
      await store.putClip(clip);
    }
  }
  if (!clip) throw new HttpError(404, "没有这条视频");
  return clip;
}

async function save(clip, { sync = true } = {}) {
  clip.updated = now();
  clip.dirty = true;
  await store.putClip(clip);
  if (sync) scheduleSync(clip.id);
}

async function makeClip(id, cues, meta) {
  if (!cues.length) throw new Error("逐字稿是空的");
  let topics = [], topicSource = "ai";
  if (await aiAvailable()) {
    try { topics = await splitTopics(meta.title, meta.desc || "", cues); } catch (e) { console.warn("话题切分失败", e); }
  }
  if (!topics.length) { topics = fallbackTopics(cues); topicSource = "auto"; }
  return {
    id, desc: "", author: "", tags: [], likes: "", cover: "",
    ...meta,
    duration: meta.duration || cues.at(-1).end,
    created: now(),
    cues, topics, topic_source: topicSource,
    frames: [], deleted_frames: [], notes: "", chat: [], exported: null,
  };
}

// ---------- 同步到 GitHub ----------

const timers = {};
export function scheduleSync(id, delay = 60000) {
  clearTimeout(timers[id]);
  timers[id] = setTimeout(async () => {
    const s = await getSettings();
    if (s.autosync && (await gh.configured())) syncClip(id).catch((e) => console.warn("自动同步失败", e));
  }, delay);
}

export async function syncClip(id) {
  clearTimeout(timers[id]);
  const clip = await load(id);
  const { folder } = await getSettings();
  const files = {
    [notePath(clip, folder)]: buildMarkdown(clip, folder),
  };
  for (const f of clip.frames) {
    if (f.synced) continue;
    const blob = await store.getFrame(`${id}-${f.n}`);
    if (blob) files[framePath(clip, f, folder)] = new Uint8Array(await blob.arrayBuffer());
  }
  for (const n of clip.deleted_frames || []) files[`${folder}/attachments/${id}-${n}.jpg`] = null;
  const stamp = now();
  const record = { ...clip, frames: clip.frames.map((f) => ({ ...f, synced: true })), deleted_frames: [], dirty: false, exported: stamp };
  files[clipJson(id)] = JSON.stringify(record, null, 1);
  const url = await gh.push(files, `KLD: ${clip.title}`);
  // 同步期间页面上可能又改了笔记：只更新同步相关的字段
  const latest = (await store.getClip(id)) || clip;
  const synced = new Set(clip.frames.map((f) => f.n));
  latest.frames.forEach((f) => { if (synced.has(f.n)) f.synced = true; });
  latest.deleted_frames = (latest.deleted_frames || []).filter((n) => !(clip.deleted_frames || []).includes(n));
  latest.dirty = latest.updated !== clip.updated;
  latest.exported = stamp;
  await store.putClip(latest);
  return { url, path: `${(await getSettings()).ghRepo}/${notePath(clip, folder)}`, exported: stamp };
}

// 打开插件页面时，把上次没来得及同步的补上
export async function syncPending() {
  if (!(await gh.configured())) return;
  for (const c of await store.allClips()) if (c.dirty) scheduleSync(c.id, 3000);
}

// 换电脑后：从仓库的 .kld/clips/ 恢复视频库
export async function restore() {
  const names = await gh.listDir(".kld/clips");
  let added = 0;
  for (const name of names) {
    const id = name.replace(/\.json$/, "");
    if (await store.getClip(id)) continue;
    const buf = await gh.readFile(clipJson(id));
    if (buf) { await store.putClip(JSON.parse(new TextDecoder().decode(buf))); added++; }
  }
  return { added, total: names.length };
}

// ---------- 小红书采集 ----------

function setJob(id, step, progress, extra = {}) {
  jobs[id] = { id, step, progress: Math.round(progress * 1000) / 1000, ...extra };
}

async function runCollect(note) {
  const id = note.id;
  try {
    setJob(id, "生成逐字稿", 0.4, { title: note.title });
    if (!note.subtitleUrl) throw new Error("这条视频没有平台字幕，插件版暂时无法转写");
    const cues = parseSubs(await xhs.fetchText(note.subtitleUrl));
    setJob(id, "按话题切分", 0.7, { title: note.title });
    const clip = await makeClip(id, cues, {
      title: note.title, desc: note.desc, author: note.author, tags: note.tags, likes: note.likes,
      cover: note.cover, source_url: note.sourceUrl, fetch_url: note.fetchUrl, video_url: note.videoUrl,
      duration: note.duration, source: "xhs", has_video: true,
    });
    await save(clip, { sync: false });
    scheduleSync(id, 5000);
    setJob(id, "完成", 1, { done: true });
  } catch (e) {
    setJob(id, "失败", 1, { error: e.message });
  }
}

// ---------- 路由 ----------

const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), fn });

on("GET", "/api/settings", async () => {
  const s = await getSettings();
  return {
    ai: !!s.claudeKey, model: s.model, notes_ai: !!(s.claudeKey || s.freeProvider), folder: s.folder, api_key_hint: hint(s.claudeKey),
    github_repo: s.ghRepo, github_branch: s.ghBranch, github_token_hint: hint(s.ghToken),
    github: !!(s.ghRepo && s.ghToken), autosync: s.autosync, extension: true,
  };
});

on("POST", "/api/collect", async (_, body) => {
  let note;
  try { note = await xhs.fetchNote(body.url); } catch (e) { throw new HttpError(400, e.message); }
  if (await store.getClip(note.id)) return { id: note.id, existing: true };
  if (jobs[note.id] && !jobs[note.id].done && !jobs[note.id].error) return { id: note.id };
  setJob(note.id, "生成逐字稿", 0.3, { title: note.title });
  runCollect(note);
  return { id: note.id };
});

on("GET", "/api/jobs/:id", async ({ id }) => {
  if (jobs[id]) return jobs[id];
  if (await store.getClip(id)) return { id, step: "完成", progress: 1, done: true };
  throw new HttpError(404, "没有这个任务");
});

on("GET", "/api/clips", async () => {
  const list = (await store.allClips()).map((c) => ({
    id: c.id, title: c.title, author: c.author, duration: c.duration, created: c.created, exported: c.exported,
    source: c.source, chapter: c.chapter, lecture_index: c.lecture_index, course: c.course?.title,
    topics: c.topics.length, frames: c.frames.length, has_notes: !!c.notes, dirty: c.dirty,
  }));
  list.sort((a, b) => (a.lecture_index || 0) - (b.lecture_index || 0));
  return list.sort((a, b) => (b.created.slice(0, 13) + (b.course || "")).localeCompare(a.created.slice(0, 13) + (a.course || "")));
});

on("GET", "/api/clips/:id", async ({ id }) => load(id));

on("DELETE", "/api/clips/:id", async ({ id }) => {
  const clip = await store.getClip(id);
  for (const f of clip?.frames || []) await store.deleteFrame(`${id}-${f.n}`);
  await store.deleteClipLocal(id);
  // 只删 KLD 的学习数据；已经写进 Obsidian 的笔记和图片保留
  if (await gh.configured()) await gh.push({ [clipJson(id)]: null }, `KLD: 删除 ${clip?.title || id} 的学习数据`).catch(() => {});
  return { ok: true };
});

on("POST", "/api/clips/:id/refresh-video", async ({ id }) => {
  // 小红书视频直链会过期：用带 xsec_token 的笔记地址重新取
  const clip = await load(id);
  const note = await xhs.fetchNote(clip.fetch_url || clip.source_url);
  clip.video_url = note.videoUrl;
  await store.putClip(clip);
  return { video_url: clip.video_url };
});

on("PUT", "/api/clips/:id/notes", async ({ id }, body) => {
  const clip = await load(id);
  clip.notes = body.notes;
  await save(clip);
  return { ok: true };
});

on("POST", "/api/clips/:id/ai-notes", async ({ id }) => {
  if (!(await notesAvailable())) throw new HttpError(400, "还没有配置免费模型或 Claude API Key：右键插件图标 → 选项");
  const { text, model } = await keepAlive(generateNotes(await load(id)));
  const latest = await load(id); // 生成期间用户可能又改了笔记
  const block = `## AI 整理笔记\n\n> 由 ${model} 根据逐字稿整理，${now()}\n\n${text}`;
  latest.notes = (latest.notes?.trim() ? latest.notes.trimEnd() + "\n\n" : "") + block;
  await save(latest);
  return { notes: latest.notes, model };
});

on("POST", "/api/clips/:id/topics/regen", async ({ id }) => {
  if (!(await aiAvailable())) throw new HttpError(400, "还没有配置 Claude API Key");
  const clip = await load(id);
  clip.topics = await keepAlive(splitTopics(clip.title, clip.desc, clip.cues));
  clip.topic_source = "ai";
  await save(clip);
  return clip.topics;
});

on("POST", "/api/clips/:id/frames", async ({ id }, body) => {
  const clip = await load(id);
  const n = Math.max(0, ...clip.frames.map((f) => f.n), ...(clip.deleted_frames || [])) + 1;
  await store.putFrame(`${id}-${n}`, await (await fetch(body.image)).blob());
  const frame = { n, time: body.time, caption: body.caption || "", file: `frame-${n}.jpg`, synced: false };
  clip.frames.push(frame);
  clip.frames.sort((a, b) => a.time - b.time);
  await save(clip);
  return frame;
});

on("PUT", "/api/clips/:id/frames/:n", async ({ id, n }, body) => {
  const clip = await load(id);
  const f = clip.frames.find((x) => x.n === +n);
  if (f) f.caption = body.caption;
  await save(clip);
  return { ok: true };
});

on("DELETE", "/api/clips/:id/frames/:n", async ({ id, n }) => {
  const clip = await load(id);
  const f = clip.frames.find((x) => x.n === +n);
  clip.frames = clip.frames.filter((x) => x.n !== +n);
  if (f?.synced) (clip.deleted_frames ||= []).push(+n);
  await store.deleteFrame(`${id}-${n}`);
  await save(clip);
  return { ok: true };
});

on("DELETE", "/api/clips/:id/chat", async ({ id }) => {
  const clip = await load(id);
  clip.chat = [];
  await save(clip);
  return { ok: true };
});

on("POST", "/api/clips/:id/export", async ({ id }) => {
  try { return await syncClip(id); } catch (e) { throw new HttpError(400, e.message); }
});

on("GET", "/api/clips/:id/markdown", async ({ id }) => {
  const clip = await load(id);
  return { markdown: buildMarkdown(clip, (await getSettings()).folder) };
});

// 关键帧图片：本机没有就从仓库的 attachments 里取回来
on("GET", "/api/ext/frame/:id/:n", async ({ id, n }) => {
  let blob = await store.getFrame(`${id}-${n}`);
  if (!blob) {
    const clip = await load(id);
    const f = clip.frames.find((x) => x.n === +n);
    const buf = f && (await gh.configured()) ? await gh.readFile(framePath(clip, f, (await getSettings()).folder)) : null;
    if (!buf) throw new HttpError(404, "找不到这张图");
    blob = new Blob([buf], { type: "image/jpeg" });
    await store.putFrame(`${id}-${n}`, blob);
  }
  const b = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return { image: "data:image/jpeg;base64," + btoa(s) };
});

on("GET", "/api/ext/udemy/:lid", async ({ lid }) => {
  try { return await load(`u${lid}`); } catch (e) {
    if (e.status === 404) throw new HttpError(404, "还没导入");
    throw e;
  }
});

on("POST", "/api/ext/udemy", async (_, body) => {
  const { lecture: lec, course } = body;
  const id = `u${+lec.id}`;
  const existing = await store.getClip(id);
  if (existing) return existing;
  const cues = parseSubs(body.vtt);
  if (!cues.length) throw new HttpError(400, "字幕是空的");
  const clip = await keepAlive(makeClip(id, cues, {
    title: lec.title || "", author: course.title || "", desc: `${course.title || ""} · ${body.chapter}`,
    source: "udemy", has_video: false,
    source_url: `https://${course.host}/course/${course.slug}/learn/lecture/${+lec.id}#overview`,
    duration: lec.duration || 0,
    course: { id: course.id, title: course.title, slug: course.slug, host: course.host },
    chapter: body.chapter, lecture_index: lec.index || 0,
    caption_lang: body.caption_lang, caption_source: body.caption_source,
  }));
  await save(clip, { sync: false });
  scheduleSync(id, 5000);
  return clip;
});

on("POST", "/api/restore", async () => {
  try { return await restore(); } catch (e) { throw new HttpError(400, e.message); }
});

/** 统一入口：返回 {ok, status, data}，和 fetch 的用法对齐 */
export async function request(method, path, body) {
  const p = path.split("?")[0];
  for (const r of routes) {
    const m = r.method === method && p.match(r.re);
    if (!m) continue;
    try {
      return { ok: true, status: 200, data: await r.fn(m.groups || {}, body || {}) };
    } catch (e) {
      console.warn(method, path, e);
      return { ok: false, status: e.status || (e instanceof gh.SyncError ? 400 : 500), data: { detail: e.message } };
    }
  }
  return { ok: false, status: 404, data: { detail: `没有这个接口：${method} ${p}` } };
}

/** AI 追问：边生成边回调 onText，结束后把这一轮存进对话记录 */
export async function chat(id, message, focusTopic, onText) {
  const clip = await load(id);
  let focus = null;
  if (focusTopic !== null && focusTopic !== undefined && clip.topics[focusTopic]) {
    const t = clip.topics[focusTopic];
    focus = `话题「${t.title}」，字幕 ${t.start_cue}-${t.end_cue}`;
  }
  const history = [...clip.chat, { role: "user", content: message }];
  let text = "";
  await keepAlive((async () => {
    for await (const t of chatStream(clip, history, focus)) { text += t; onText(t); }
  })());
  const latest = await load(id); // 期间可能有截帧 / 笔记写入
  latest.chat = [...history, { role: "assistant", content: text }];
  await save(latest);
  return text;
}
