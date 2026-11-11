"""小红书笔记采集：解析分享链接 → 笔记元数据、视频直链、平台字幕。"""
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import httpx

MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
URL_RE = re.compile(r"https?://(?:xhslink\.cn|xhslink\.com|www\.xiaohongshu\.com)/[^\s，。]+")


class XhsError(Exception):
    pass


@dataclass
class Note:
    note_id: str
    title: str
    desc: str
    author: str
    tags: list[str]
    cover_url: str
    video_url: str
    duration: float
    subtitle_url: str | None
    source_url: str
    likes: str = ""
    extra: dict = field(default_factory=dict)


def extract_url(text: str) -> str:
    """用户可以粘贴整段分享文案，这里只取出链接。"""
    m = URL_RE.search(text)
    if not m:
        raise XhsError("没有找到小红书链接，请粘贴 xhslink 短链或笔记链接")
    return m.group(0)


def _initial_state(html: str) -> dict:
    m = re.search(r"window\.__INITIAL_STATE__=(.*?)</script>", html, re.S)
    if not m:
        raise XhsError("页面里没有笔记数据，可能需要登录或链接已失效")
    return json.loads(re.sub(r"\bundefined\b", "null", m.group(1)))


def _find_note(state: dict) -> dict:
    # 移动端分享页结构
    note = (((state.get("noteData") or {}).get("data") or {}).get("noteData"))
    if note:
        return note
    # 桌面端页面结构
    for v in ((state.get("note") or {}).get("noteDetailMap") or {}).values():
        if v.get("note"):
            return v["note"]
    raise XhsError("解析不到笔记内容")


def _pick_stream(video: dict) -> tuple[str, float]:
    """优先 h264（浏览器都能放），其次 h265。"""
    streams = ((video.get("media") or {}).get("stream")) or {}
    for codec in ("h264", "h265", "av1"):
        for s in streams.get(codec) or []:
            url = s.get("masterUrl") or s.get("master_url")
            if url:
                return url.replace("http://", "https://", 1), (s.get("duration") or 0) / 1000
    raise XhsError("这条笔记没有可下载的视频流（可能是图文笔记）")


def _pick_subtitle(video: dict) -> str | None:
    raw = video.get("mediaV2")
    if not raw:
        return None
    try:
        subs = json.loads(raw)["video"]["subtitles"]
    except (KeyError, TypeError, json.JSONDecodeError):
        return None
    for lang in ("zh-CN", "source"):
        for s in subs.get(lang) or []:
            if s.get("url"):
                return s["url"]
    return None


async def fetch_note(text: str) -> Note:
    url = extract_url(text)
    async with httpx.AsyncClient(follow_redirects=True, timeout=30, headers={"User-Agent": MOBILE_UA}) as c:
        r = await c.get(url)
        r.raise_for_status()
    note = _find_note(_initial_state(r.text))
    if note.get("type") != "video":
        raise XhsError("目前只支持视频笔记")
    video = note.get("video") or {}
    video_url, duration = _pick_stream(video)
    images = note.get("imageList") or []
    cover = (images[0].get("url") or images[0].get("urlDefault") or "") if images else ""
    user = note.get("user") or {}
    interact = note.get("interactInfo") or {}
    return Note(
        note_id=note.get("noteId") or note.get("id") or "",
        title=note.get("title") or "未命名视频",
        desc=note.get("desc") or "",
        author=user.get("nickName") or user.get("nickname") or "",
        tags=[t.get("name") for t in note.get("tagList") or [] if t.get("name")],
        cover_url=cover.replace("http://", "https://", 1),
        video_url=video_url,
        duration=duration,
        subtitle_url=_pick_subtitle(video),
        source_url=str(r.url).split("?")[0],
        likes=str(interact.get("likedCount") or ""),
    )


async def download(url: str, dest: Path, on_progress=None) -> None:
    headers = {"User-Agent": DESKTOP_UA, "Referer": "https://www.xiaohongshu.com/"}
    tmp = dest.with_suffix(dest.suffix + ".part")
    async with httpx.AsyncClient(follow_redirects=True, timeout=120, headers=headers) as c:
        async with c.stream("GET", url) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length") or 0)
            done = 0
            with open(tmp, "wb") as f:
                async for chunk in r.aiter_bytes(1 << 16):
                    f.write(chunk)
                    done += len(chunk)
                    if on_progress and total:
                        on_progress(done / total)
    tmp.replace(dest)


async def fetch_text(url: str) -> str:
    async with httpx.AsyncClient(follow_redirects=True, timeout=30, headers={"User-Agent": DESKTOP_UA}) as c:
        r = await c.get(url)
        r.raise_for_status()
        return r.content.decode("utf-8-sig", errors="replace")
