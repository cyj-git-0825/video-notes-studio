// 字幕解析（SRT / WebVTT）和无 AI 时的话题粗切分。
const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/;

export function parseSubs(text) {
  const cues = [];
  for (const block of text.replace(/^﻿/, "").trim().split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const i = lines.findIndex((l) => TIME.test(l));
    if (i < 0) continue;
    const g = lines[i].match(TIME).slice(1).map((x) => +(x || 0));
    const body = decode(lines.slice(i + 1).join(" ").replace(/<[^>]+>/g, "")).trim();
    if (body && cues.at(-1)?.text !== body) {
      cues.push({ start: g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000, end: g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000, text: body });
    }
  }
  cues.forEach((c, i) => (c.i = i));
  return cues;
}

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

export function fallbackTopics(cues, span = 60) {
  const topics = [];
  let start = 0;
  cues.forEach((c, i) => {
    if (c.end - cues[start].start >= span || i === cues.length - 1) {
      topics.push({ title: `片段 ${topics.length + 1}`, summary: cues[start].text.slice(0, 40), start_cue: start, end_cue: i });
      start = i + 1;
    }
  });
  return topics;
}

// 让话题首尾相接、覆盖全部字幕，防止模型给出的区间有缝隙或越界
export function normalizeTopics(topics, n) {
  topics = topics.filter((t) => t.start_cue >= 0 && t.start_cue < n).sort((a, b) => a.start_cue - b.start_cue);
  if (!topics.length) return [];
  topics[0].start_cue = 0;
  for (let i = 0; i < topics.length - 1; i++) topics[i].end_cue = topics[i + 1].start_cue - 1;
  topics.at(-1).end_cue = n - 1;
  return topics.filter((t) => t.end_cue >= t.start_cue);
}

export function fmtTime(t) {
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(s).padStart(2, "0");
}

export const isCJK = (s) => /[一-鿿]/.test(s);

// 把一组字幕拼成一段：中文句间补逗号，英文句间补空格
export function joinCues(cues) {
  return cues.map((c) => (isCJK(c.text) ? (/[，。？！,.?!]$/.test(c.text) ? c.text : c.text + "，") : c.text + " ")).join("").trim();
}

// 逐字稿转纯文本（用于复制）：按话题分组，每 ~25 秒一段，段首标 [mm:ss]
// only 为话题下标时只导出这一个话题
export function transcriptText(clip, only = null) {
  const mmss = (t) => {
    t = Math.max(0, Math.floor(t));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m).padStart(2, "0")) + ":" + String(s).padStart(2, "0");
  };
  const topics = clip.topics?.length ? clip.topics : [{ title: "", start_cue: 0, end_cue: clip.cues.length - 1 }];
  const pick = only === null ? topics.map((t, i) => [t, i]) : [[topics[only], only]];
  const out = [];
  for (const [t, i] of pick) {
    if (t.title) out.push(`## ${i + 1}. ${t.title}`);
    let para = "", start = null;
    const flush = () => { if (para.trim()) out.push(`[${mmss(start)}] ${para.trim().replace(/，$/, "。")}`); para = ""; };
    for (let k = t.start_cue; k <= t.end_cue; k++) {
      const c = clip.cues[k];
      if (!c) continue;
      if (start === null || c.start - start > 25) { flush(); start = c.start; }
      para += /[一-鿿]/.test(c.text) ? (/[，。？！,.?!]$/.test(c.text) ? c.text : c.text + "，") : c.text + " ";
    }
    flush();
  }
  return out.join("\n\n");
}
