// AI 能力：按话题切分逐字稿、基于视频内容追问。插件直接调用 Claude API，Key 只存在这台电脑的浏览器里。
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { getSettings } from "./settings.js";
import { normalizeTopics } from "./subs.js";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class NoKeyError extends Error {
  constructor() { super("还没有配置 Claude API Key：右键插件图标 → 选项"); }
}

export async function client() {
  const s = await getSettings();
  if (!s.claudeKey) throw new NoKeyError();
  // 浏览器里调用需要显式允许；Key 只保存在本机 chrome.storage，请求只发往 Anthropic
  return { c: new Anthropic({ apiKey: s.claudeKey, dangerouslyAllowBrowser: true }), model: s.model };
}

export async function aiAvailable() {
  return !!(await getSettings()).claudeKey;
}

const numbered = (cues) => cues.map((c) => `[${c.i}] (${Math.floor(c.start)}s) ${c.text}`).join("\n");

const TopicPlan = z.object({
  topics: z.array(z.object({
    title: z.string(),
    summary: z.string(),
    start_cue: z.number().int(),
    end_cue: z.number().int(),
  })),
});

export async function splitTopics(title, desc, cues) {
  const { c, model } = await client();
  const prompt =
    `视频标题：${title}\n视频简介：${desc}\n\n` +
    "下面是这条视频带编号的逐字稿（字幕由语音识别生成，可能有同音错字）。\n" +
    "请把它按内容切分成 3~10 个连续的话题段落，覆盖全部字幕、不重叠、按顺序排列。" +
    "即使字幕是英文，标题和摘要也用中文写，专有名词保留英文。" +
    "每个话题给一个不超过 14 个字的标题（形如“接入飞书·随时随地对话”），" +
    "和一句话摘要，并标出起止字幕编号 start_cue / end_cue（含）。\n\n" +
    numbered(cues);
  const resp = await c.messages.parse({
    model,
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(TopicPlan) },
    messages: [{ role: "user", content: prompt }],
  });
  if (!resp.parsed_output) throw new Error("话题切分结果解析失败");
  return normalizeTopics(resp.parsed_output.topics, cues.length);
}

const CHAT_SYSTEM = `你是一个陪用户“读懂一条视频”的学习伙伴。用户正在边看下面这条视频（小红书笔记或在线课程的一节课）边追问。
- 回答要以视频内容为依据；视频没讲到的，可以补充，但要明确说明“视频里没提到，补充一下”。
- 字幕来自语音识别，常有同音错字（例如把 Obsidian 识别成“oppo c店”），请按上下文理解并在回答里写对。
- 引用视频内容时标出时间点，格式为 [mm:ss]，用户点击可跳转。
- 用户用中文提问就用中文回答；视频是英文的，术语保留英文原文并给出中文解释。
- 默认简洁，用 Markdown；用户要求“整理成笔记”时，输出适合放进 Obsidian 的结构化笔记。`;

function contextBlock(clip) {
  const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const frames = clip.frames.map((f) => `- [${mmss(f.time)}] 截图说明：${f.caption || "（无说明）"}`).join("\n");
  const topics = clip.topics.map((t, i) => `${i + 1}. ${t.title}（字幕 ${t.start_cue}-${t.end_cue}）：${t.summary || ""}`).join("\n");
  const head = clip.course
    ? `课程：${clip.course.title}\n章节：${clip.chapter || ""}\n`
    : `作者：${clip.author || ""}\n简介：${clip.desc || ""}\n`;
  return `# 视频：${clip.title}\n${head}\n## 话题\n${topics}\n\n## 用户截取的关键帧\n${frames || "（暂无）"}\n\n## 逐字稿\n${numbered(clip.cues)}`;
}

// 流式输出回复文本。history 为 [{role, content}]，最后一条是用户的新问题
export async function* chatStream(clip, history, focus) {
  const { c, model } = await client();
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  if (focus) messages[messages.length - 1] = { role: "user", content: `（我正在看这一段：${focus}）\n\n${messages.at(-1).content}` };
  const stream = c.beta.messages.stream({
    model,
    max_tokens: 64000,
    output_config: { effort: "medium" },
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    // 视频上下文固定不变，放在 system 里做缓存，多轮追问只付一次全价
    system: [
      { type: "text", text: CHAT_SYSTEM },
      { type: "text", text: contextBlock(clip), cache_control: { type: "ephemeral" } },
    ],
    messages,
  });
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") yield "\n\n（这个问题被模型拒绝回答了，换个问法试试。）";
}
