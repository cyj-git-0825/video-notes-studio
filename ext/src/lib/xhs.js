// 小红书笔记采集：分享链接 → 标题/简介/作者/标签、视频直链、平台字幕。
// 小红书对电脑浏览器会跳登录页，所以后台装了一条规则：插件发往小红书的请求改用手机 UA（见 bg.js）。
const URL_RE = /https?:\/\/(?:xhslink\.cn|xhslink\.com|www\.xiaohongshu\.com)\/[^\s，。]+/;

export class XhsError extends Error {}

export function extractUrl(text) {
  const m = text.match(URL_RE);
  if (!m) throw new XhsError("没有找到小红书链接，请粘贴 xhslink 短链或笔记链接");
  return m[0];
}

function initialState(html) {
  const m = html.match(/window\.__INITIAL_STATE__=([\s\S]*?)<\/script>/);
  if (!m) throw new XhsError("页面里没有笔记数据，可能链接已失效");
  return JSON.parse(m[1].replace(/\bundefined\b/g, "null"));
}

function findNote(state) {
  const n = state.noteData?.data?.noteData;
  if (n) return n;
  for (const v of Object.values(state.note?.noteDetailMap || {})) if (v.note) return v.note;
  throw new XhsError("解析不到笔记内容（可能被要求登录或验证）");
}

function pickStream(video) {
  const streams = video.media?.stream || {};
  for (const codec of ["h264", "h265", "av1"]) {
    for (const s of streams[codec] || []) {
      const url = s.masterUrl || s.master_url;
      if (url) return { url: url.replace(/^http:\/\//, "https://"), duration: (s.duration || 0) / 1000 };
    }
  }
  throw new XhsError("这条笔记没有视频（可能是图文笔记）");
}

function pickSubtitle(video) {
  try {
    const subs = JSON.parse(video.mediaV2).video.subtitles;
    for (const lang of ["zh-CN", "source"]) for (const s of subs[lang] || []) if (s.url) return s.url;
  } catch {}
  return null;
}

// fetchUrl：带 xsec_token 的完整笔记地址。视频直链会过期，以后用它重新取
export async function fetchNote(textOrUrl) {
  const r = await fetch(extractUrl(textOrUrl), { credentials: "omit" });
  if (!r.ok) throw new XhsError(`打开链接失败（${r.status}）`);
  const note = findNote(initialState(await r.text()));
  if (note.type !== "video") throw new XhsError("目前只支持视频笔记");
  const video = note.video || {};
  const stream = pickStream(video);
  const img = note.imageList?.[0];
  return {
    id: note.noteId || note.id,
    title: note.title || "未命名视频",
    desc: note.desc || "",
    author: note.user?.nickName || note.user?.nickname || "",
    tags: (note.tagList || []).map((t) => t.name).filter(Boolean),
    likes: String(note.interactInfo?.likedCount || ""),
    cover: (img?.url || img?.urlDefault || "").replace(/^http:\/\//, "https://"),
    videoUrl: stream.url,
    duration: stream.duration,
    subtitleUrl: pickSubtitle(video),
    sourceUrl: r.url.split("?")[0],
    fetchUrl: r.url,
  };
}

export async function fetchText(url) {
  const r = await fetch(url, { credentials: "omit" });
  if (!r.ok) throw new XhsError(`下载字幕失败（${r.status}）`);
  return r.text();
}
