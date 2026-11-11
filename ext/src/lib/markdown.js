// 生成写进 Obsidian 的笔记：frontmatter + 我的笔记 + 关键帧 + 话题 + 按话题分段的逐字稿。
import { fmtTime as ft, joinCues } from "./subs.js";

export const safeName = (s) => s.replace(/[\\/:*?"<>|#^[\]]+/g, " ").trim().slice(0, 80) || "未命名";

export function notePath(clip, folder) {
  // 课程笔记按课程建子文件夹，文件名带课时序号，方便在 Obsidian 里按顺序浏览
  return clip.course
    ? `${folder}/${safeName(clip.course.title)}/${String(clip.lecture_index || 0).padStart(3, "0")} ${safeName(clip.title)}.md`
    : `${folder}/${safeName(clip.title)}.md`;
}

export const framePath = (clip, f, folder) => `${folder}/attachments/${clip.id}-${f.n}.jpg`;

export function buildMarkdown(clip, folder) {
  const course = clip.course;
  const q = (s) => JSON.stringify(String(s ?? ""));
  const L = [
    "---",
    `title: ${q(clip.title)}`,
    `source: ${clip.source_url}`,
    `author: ${q(clip.author)}`,
    ...(course ? [`course: ${q(course.title)}`, `chapter: ${q(clip.chapter)}`] : []),
    `duration: "${ft(clip.duration)}"`,
    `collected: ${clip.created.slice(0, 10)}`,
    "type: 视频笔记",
    `tags: [视频笔记${course ? ", 课程笔记" : ""}]`,
    "---",
    "",
    `# ${clip.title}`,
    "",
    course
      ? `> 来源：[${course.title}](${clip.source_url}) · ${clip.chapter || ""}　时长 ${ft(clip.duration)}`
      : `> 来源：[${clip.author} · 小红书](${clip.source_url})　时长 ${ft(clip.duration)}`,
    "",
  ];
  if (clip.notes?.trim()) L.push("## 我的笔记", "", clip.notes.trim(), "");
  if (clip.frames.length) {
    L.push("## 关键帧", "");
    for (const f of clip.frames) {
      L.push(`### ${ft(f.time)} ${(f.caption || "").slice(0, 30)}`.trimEnd(), "", `![[${framePath(clip, f, folder)}]]`, "");
      if (f.caption) L.push(f.caption, "");
    }
  }
  L.push("## 话题", "");
  clip.topics.forEach((t, i) => L.push(`${i + 1}. **${t.title}**（${ft(clip.cues[t.start_cue].start)}）— ${t.summary || ""}`));
  L.push("", "## 逐字稿", "");
  clip.topics.forEach((t, i) => {
    const cues = clip.cues.slice(t.start_cue, t.end_cue + 1);
    L.push(`### ${i + 1}. ${t.title}`, "", `\`${ft(cues[0].start)}\` ` + joinCues(cues).replace(/，$/, "。"), "");
  });
  if (clip.desc && !course) L.push("## 原笔记简介", "", clip.desc, "");
  const tags = (clip.tags || []).map((t) => "#" + t.replace(/\s+/g, "")).join(" ");
  if (tags) L.push(tags, "");
  return L.join("\n");
}
