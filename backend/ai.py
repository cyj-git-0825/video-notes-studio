"""AI 能力：按话题切分逐字稿、基于视频内容追问对话、整理成笔记。"""
import os

import anthropic
from pydantic import BaseModel

MODEL = os.environ.get("KLD_MODEL", "claude-opus-5-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"

_client: anthropic.AsyncAnthropic | None = None


def available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic()
    return _client


def numbered_transcript(cues: list[dict]) -> str:
    return "\n".join(f"[{c['i']}] ({int(c['start'])}s) {c['text']}" for c in cues)


class Topic(BaseModel):
    title: str
    summary: str
    start_cue: int
    end_cue: int


class TopicPlan(BaseModel):
    topics: list[Topic]


async def split_topics(title: str, desc: str, cues: list[dict]) -> list[dict]:
    prompt = (
        f"视频标题：{title}\n视频简介：{desc}\n\n"
        "下面是这条视频带编号的逐字稿（字幕由语音识别生成，可能有同音错字）。\n"
        "请把它按内容切分成 3~10 个连续的话题段落，覆盖全部字幕、不重叠、按顺序排列。"
        "即使字幕是英文，标题和摘要也用中文写，专有名词保留英文。"
        "每个话题给一个不超过 14 个字的标题（形如“接入飞书·随时随地对话”），"
        "和一句话摘要，并标出起止字幕编号 start_cue / end_cue（含）。\n\n"
        f"{numbered_transcript(cues)}"
    )
    resp = await client().messages.parse(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": prompt}],
        output_format=TopicPlan,
    )
    topics = [t.model_dump() for t in resp.parsed_output.topics]
    return _normalize(topics, len(cues))


def _normalize(topics: list[dict], n: int) -> list[dict]:
    """让话题首尾相接、覆盖全部字幕，防止模型给出的区间有缝隙或越界。"""
    topics = sorted((t for t in topics if 0 <= t["start_cue"] < n), key=lambda t: t["start_cue"])
    if not topics:
        return []
    topics[0]["start_cue"] = 0
    for a, b in zip(topics, topics[1:]):
        a["end_cue"] = b["start_cue"] - 1
    topics[-1]["end_cue"] = n - 1
    return [t for t in topics if t["end_cue"] >= t["start_cue"]]


CHAT_SYSTEM = """你是一个陪用户“读懂一条视频”的学习伙伴。用户正在边看下面这条视频（小红书笔记或在线课程的一节课）边追问。
- 回答要以视频内容为依据；视频没讲到的，可以补充，但要明确说明“视频里没提到，补充一下”。
- 字幕来自语音识别，常有同音错字（例如把 Obsidian 识别成“oppo c店”），请按上下文理解并在回答里写对。
- 引用视频内容时标出时间点，格式为 [mm:ss]，用户点击可跳转。
- 用户用中文提问就用中文回答；视频是英文的，术语保留英文原文并给出中文解释。
- 默认简洁，用 Markdown；用户要求“整理成笔记”时，输出适合放进 Obsidian 的结构化笔记。"""


def _context_block(clip: dict) -> str:
    frames = "\n".join(
        f"- [{int(f['time']) // 60:02d}:{int(f['time']) % 60:02d}] 截图说明：{f.get('caption') or '（无说明）'}"
        for f in clip.get("frames", [])
    )
    topics = "\n".join(
        f"{i + 1}. {t['title']}（字幕 {t['start_cue']}-{t['end_cue']}）：{t.get('summary', '')}"
        for i, t in enumerate(clip.get("topics", []))
    )
    return (
        f"# 视频：{clip['title']}\n"
        + (f"课程：{clip['course']['title']}\n章节：{clip.get('chapter', '')}\n" if clip.get("course")
           else f"作者：{clip.get('author', '')}\n简介：{clip.get('desc', '')}\n")
        + f"\n## 话题\n{topics}\n\n## 用户截取的关键帧\n{frames or '（暂无）'}\n\n"
        f"## 逐字稿\n{numbered_transcript(clip['cues'])}"
    )


async def chat_stream(clip: dict, history: list[dict], focus: str | None):
    """流式输出回复文本。history 为 [{role, content}]，最后一条是用户的新问题。"""
    messages = [{"role": m["role"], "content": m["content"]} for m in history]
    if focus:
        messages[-1] = {
            "role": "user",
            "content": f"（我正在看这一段：{focus}）\n\n{messages[-1]['content']}",
        }
    async with client().beta.messages.stream(
        model=MODEL,
        max_tokens=64000,
        output_config={"effort": "medium"},
        betas=[FALLBACK_BETA],
        fallbacks="default",
        # 视频上下文固定不变，放在 system 里做缓存，多轮追问只付一次全价
        system=[
            {"type": "text", "text": CHAT_SYSTEM},
            {"type": "text", "text": _context_block(clip), "cache_control": {"type": "ephemeral"}},
        ],
        messages=messages,
    ) as stream:
        async for text in stream.text_stream:
            yield text
        final = await stream.get_final_message()
        if final.stop_reason == "refusal":
            yield "\n\n（这个问题被模型拒绝回答了，换个问法试试。）"
