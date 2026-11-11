"""Udemy（含 Udemy Business / gale.udemy.com）课程导入：用用户自己的登录 cookie 读取课程目录和字幕。

只取字幕（VTT）和课程结构；视频流有 DRM，不下载。
cookie 放在 data/udemy_cookie.txt：可以是整段 cookie 字符串，也可以是浏览器 DevTools 里 "Copy as cURL" 的整段内容。
"""
import html
import re
import shlex
from pathlib import Path

from curl_cffi.requests import AsyncSession

COOKIE_FILE = Path(__file__).resolve().parent.parent / "data" / "udemy_cookie.txt"
URL_RE = re.compile(r"https?://([\w-]+\.udemy\.com)/course/([\w-]+)(?:/learn/lecture/(\d+))?")
VTT_TIME = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})")


class UdemyError(Exception):
    pass


def is_udemy(text: str) -> bool:
    return bool(URL_RE.search(text))


def parse_url(text: str) -> tuple[str, str, int | None]:
    m = URL_RE.search(text)
    if not m:
        raise UdemyError("不是 Udemy 课程链接")
    return m.group(1), m.group(2), int(m.group(3)) if m.group(3) else None


def _load_auth() -> tuple[str, str | None]:
    """返回 (cookie, user_agent)。"""
    if not COOKIE_FILE.exists():
        raise UdemyError("还没有登录 Udemy：请点「登录 Udemy」")
    raw = COOKIE_FILE.read_text("utf-8").strip()
    ua = None
    if raw.lower().startswith("curl"):
        # cookie 值里常带引号，不能用正则截取，按 shell 参数规则拆开
        args = _split_curl(raw)
        cookie = ""
        for flag, val in zip(args, args[1:]):
            if flag in ("-b", "--cookie"):
                cookie = val
            elif flag in ("-H", "--header"):
                name, _, v = val.partition(":")
                if name.strip().lower() == "cookie":
                    cookie = v.strip()
                elif name.strip().lower() == "user-agent":
                    ua = v.strip()
        if not cookie:
            raise UdemyError("cURL 内容里没找到 cookie，请确认复制的是发往 udemy.com 的请求")
    else:
        cookie = re.sub(r"^cookie:\s*", "", raw, flags=re.I)
    return cookie.strip(), ua


def _split_curl(raw: str) -> list[str]:
    if '^"' in raw:
        # Windows cmd 格式：^" 包裹参数，^ 转义特殊字符，行尾 ^ 续行
        # 参数内部的字面引号写作 \^"，先换成占位符再拆
        raw = re.sub(r"\^\s*\r?\n", " ", raw).replace('\\^"', "\0")
        args = re.findall(r'\^"((?:[^^]|\^.)*?)\^"|(\S+)', raw)
        return [(re.sub(r"\^(.)", r"\1", q) if q else p).replace("\0", '"') for q, p in args]
    return shlex.split(re.sub(r"\\\r?\n", " ", raw))


def has_auth() -> bool:
    return COOKIE_FILE.exists() and COOKIE_FILE.stat().st_size > 20


class Client:
    def __init__(self, host: str):
        cookie, ua = _load_auth()
        token = re.search(r"(?:^|;\s*)access_token=([^;]+)", cookie)
        self.base = f"https://{host}"
        self.headers = {
            "Cookie": cookie,
            "Accept": "application/json, text/plain, */*",
            "Referer": self.base + "/",
            "X-Requested-With": "XMLHttpRequest",
        }
        if ua:
            self.headers["User-Agent"] = ua
        if token:
            self.headers["Authorization"] = f"Bearer {token.group(1)}"
            self.headers["X-Udemy-Authorization"] = f"Bearer {token.group(1)}"

    async def __aenter__(self):
        self.s = AsyncSession(impersonate="chrome", timeout=30)
        return self

    async def __aexit__(self, *a):
        await self.s.close()

    async def get(self, path: str, params: dict | None = None) -> dict:
        url = path if path.startswith("http") else self.base + path
        r = await self.s.get(url, params=params, headers=self.headers)
        if r.status_code in (401, 403):
            if "json" not in (r.headers.get("content-type") or ""):
                raise UdemyError("被 Cloudflare 拦截了：cookie 里缺少 cf_clearance，或 User-Agent 对不上，建议改用 Copy as cURL 的整段内容")
            raise UdemyError("登录已失效或没有这门课的权限：请点「登录 Udemy」重新登录")
        if r.status_code >= 400:
            raise UdemyError(f"Udemy 返回 {r.status_code}")
        return r.json()

    async def get_text(self, url: str) -> str:
        # 字幕文件在 CDN 上，链接自带签名，不需要带 cookie
        r = await self.s.get(url)
        r.raise_for_status()
        return r.content.decode("utf-8-sig", errors="replace")

    async def course(self, slug: str) -> dict:
        return await self.get(f"/api-2.0/courses/{slug}/", {"fields[course]": "id,title,url,visible_instructors"})

    async def curriculum(self, course_id: int) -> list[dict]:
        """按顺序返回章节和课时；课时带字幕列表。"""
        params = {
            "page_size": 200,
            "fields[lecture]": "title,object_index,asset,is_published",
            "fields[chapter]": "title,object_index",
            "fields[quiz]": "title",
            "fields[practice]": "title",
            "fields[asset]": "asset_type,time_estimation,length,captions",
            "fields[caption]": "locale_id,url,source,status,video_label,title",
            "caching_intent": "True",
        }
        url, items = f"/api-2.0/courses/{course_id}/subscriber-curriculum-items/", []
        while url:
            data = await self.get(url, params)
            items += data.get("results") or []
            url, params = data.get("next"), None
        return items


def outline(items: list[dict]) -> list[dict]:
    """整理成 [{chapter, lectures:[{id,title,index,duration,captions:[locale..]}]}]，只保留视频课时。"""
    out, cur = [], {"chapter": "", "index": 0, "lectures": []}
    for it in items:
        if it.get("_class") == "chapter":
            if cur["lectures"] or cur["chapter"]:
                out.append(cur)
            cur = {"chapter": it.get("title", ""), "index": it.get("object_index", 0), "lectures": []}
        elif it.get("_class") == "lecture":
            asset = it.get("asset") or {}
            if asset.get("asset_type") not in ("Video", "VideoMashup"):
                continue
            caps = [c for c in asset.get("captions") or [] if c.get("url")]
            cur["lectures"].append({
                "id": it["id"],
                "title": it.get("title", ""),
                "index": it.get("object_index", 0),
                "duration": asset.get("time_estimation") or asset.get("length") or 0,
                "captions": sorted({c["locale_id"] for c in caps}),
            })
    if cur["lectures"]:
        out.append(cur)
    return out


def pick_caption(asset: dict, prefer: str = "en") -> dict | None:
    caps = [c for c in asset.get("captions") or [] if c.get("url")]
    if not caps:
        return None
    # 先选语言匹配的，再优先人工字幕（source=manual）而不是自动生成的
    def score(c):
        loc = (c.get("locale_id") or "").lower()
        return (loc.startswith(prefer.lower()), c.get("source") != "auto", loc == "en_us")
    return max(caps, key=score)


def parse_vtt(text: str) -> list[dict]:
    cues = []
    for block in re.split(r"\r?\n\s*\r?\n", text.strip()):
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        for i, line in enumerate(lines):
            m = VTT_TIME.search(line)
            if not m:
                continue
            g = [x or "0" for x in m.groups()]
            start = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 1000
            end = int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7]) / 1000
            body = html.unescape(re.sub(r"<[^>]+>", "", " ".join(lines[i + 1:]))).strip()
            if body and not (cues and cues[-1]["text"] == body):
                cues.append({"start": start, "end": end, "text": body})
            break
    for i, c in enumerate(cues):
        c["i"] = i
    return cues


def lecture_url(host: str, slug: str, lecture_id: int, start: float | None = None) -> str:
    q = f"?start={int(start)}" if start else ""
    return f"https://{host}/course/{slug}/learn/lecture/{lecture_id}{q}#overview"

