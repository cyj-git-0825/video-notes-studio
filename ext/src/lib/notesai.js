// AI 整理笔记：把逐字稿（加上话题和关键帧说明）整理成一份能直接放进 Obsidian 的笔记。
// 配了免费模型就用免费模型，没配就用 Claude。
import { client, NoKeyError } from "./claude.js";
import { complete, freeConfig } from "./freeai.js";
import { getSettings } from "./settings.js";

const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

const SYSTEM = `你是一个擅长做学习笔记的助手。用户给你一条视频（小红书笔记或在线课程的一节课）的逐字稿，请整理成一份结构化的 Markdown 学习笔记，用户会把它放进 Obsidian。
要求：
- 用中文写；视频是英文的，专有名词和术语保留英文原文，第一次出现时附中文解释。
- 字幕来自语音识别，常有同音错字，请按上下文理解并写对。
- 结构：先用 2~3 句话写「一句话总结」，然后按内容分成若干小节（### 标题），每节用要点列出核心观点、步骤、例子、数字；最后写「要点回顾」和（如果有的话）「可以动手试试」。
- 每个小节标题或关键要点后面标出对应的视频时间点，格式为 [mm:ss]，必须来自逐字稿里真实出现的时间。
- 只根据视频内容写，不要编造视频里没有的信息；视频里没讲清楚的地方可以标注「（视频未展开）」。
- 直接输出笔记正文，不要用 \`\`\` 包裹，不要写开场白。`;

function userPrompt(clip) {
  const head = clip.course
    ? `课程：${clip.course.title}\n章节：${clip.chapter || ""}\n课时：${clip.title}`
    : `标题：${clip.title}\n作者：${clip.author || ""}\n简介：${clip.desc || ""}`;
  const topics = clip.topics?.length
    ? "\n\n已有的话题划分（可参考）：\n" + clip.topics.map((t, i) => `${i + 1}. [${mmss(clip.cues[t.start_cue]?.start || 0)}] ${t.title}：${t.summary || ""}`).join("\n")
    : "";
  const frames = clip.frames?.length
    ? "\n\n用户截取的关键帧（说明这些地方用户觉得重要）：\n" + clip.frames.map((f) => `- [${mmss(f.time)}] ${f.caption || "（无说明）"}`).join("\n")
    : "";
  const cues = clip.cues.map((c) => `[${mmss(c.start)}] ${c.text}`).join("\n");
  return `${head}${topics}${frames}\n\n逐字稿：\n${cues}`;
}

const unfence = (s) => s.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1").trim();

export async function notesAvailable() {
  return !!(await freeConfig()) || !!(await getSettings()).claudeKey;
}

/** 返回 { text, model } */
export async function generateNotes(clip) {
  const free = await freeConfig();
  if (free) {
    const text = await complete(free, [{ role: "system", content: SYSTEM }, { role: "user", content: userPrompt(clip) }]);
    return { text: unfence(text), model: free.model };
  }
  let c, model;
  try { ({ c, model } = await client()); } catch (e) {
    if (e instanceof NoKeyError) throw new Error("还没有配置免费模型或 Claude API Key：右键插件图标 → 选项");
    throw e;
  }
  const stream = c.messages.stream({
    model, max_tokens: 16000, output_config: { effort: "low" },
    system: SYSTEM, messages: [{ role: "user", content: userPrompt(clip) }],
  });
  return { text: unfence(await stream.finalText()), model };
}
