"""KLD 视频学习台：粘贴小红书链接 → 采集视频 → 话题切分 + 逐字稿 + 关键帧 + AI 追问 → 存入 Obsidian。"""
import asyncio
import base64
import json
import os
import re
import shutil
import time
import traceback
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ai, auth, github_sync, transcript, udemy, udemy_login, xhs

ROOT = Path(__file__).resolve().parent.parent
# 云端部署时数据放在持久卷上（KLD_DATA=/data），本机默认放在项目 data/ 目录
DATA = Path(os.environ.get("KLD_DATA") or ROOT / "data")
CLIPS = DATA / "clips"
SETTINGS_FILE = DATA / "settings.json"
CLIPS.mkdir(parents=True, exist_ok=True)
udemy.COOKIE_FILE = udemy_login.COOKIE_FILE = DATA / "udemy_cookie.txt"
udemy_login.PROFILE = DATA / "udemy_profile"
CLOUD = bool(os.environ.get("KLD_CLOUD"))

app = FastAPI(title="KLD")
app.middleware("http")(auth.middleware)
jobs: dict[str, dict] = {}


# ---------- 设置 ----------

def load_settings() -> dict:
    s = {"vault": str(DATA / "vault"), "folder": "视频笔记", "api_key": "",
         "export_target": "github" if CLOUD else "local",
         "github_repo": os.environ.get("GITHUB_REPO", ""), "github_branch": "main", "github_token": ""}
    if SETTINGS_FILE.exists():
        s.update(json.loads(SETTINGS_FILE.read_text("utf-8")))
    if s["api_key"]:
        os.environ["ANTHROPIC_API_KEY"] = s["api_key"]
    return s


settings = load_settings()


def github_token() -> str:
    # 环境变量（部署平台的 secret）优先，其次是设置页里填的
    return os.environ.get("GITHUB_TOKEN") or settings["github_token"]


def _hint(secret: str) -> str:
    return f"…{secret[-4:]}" if secret else ""


class SettingsIn(BaseModel):
    vault: str | None = None
    folder: str | None = None
    api_key: str | None = None
    export_target: str | None = None
    github_repo: str | None = None
    github_branch: str | None = None
    github_token: str | None = None


@app.get("/api/settings")
def get_settings():
    key = settings["api_key"] or os.environ.get("ANTHROPIC_API_KEY", "")
    return {
        "vault": settings["vault"],
        "folder": settings["folder"],
        "api_key_hint": _hint(key),
        "ai": ai.available(),
        "model": ai.MODEL,
        "export_target": settings["export_target"],
        "github_repo": settings["github_repo"],
        "github_branch": settings["github_branch"],
        "github_token_hint": _hint(github_token()),
        "cloud": CLOUD,
        "auth": auth.enabled(),
    }


@app.post("/api/settings")
def save_settings(body: SettingsIn):
    data = body.model_dump(exclude_none=True)
    if data.get("export_target") not in (None, "local", "github"):
        raise HTTPException(400, "导出位置只能是 local 或 github")
    if CLOUD:
        data.pop("vault", None)  # 云端没有本地 Obsidian 文件夹可写
    for k, v in data.items():
        settings[k] = v.strip()
    SETTINGS_FILE.write_text(json.dumps(settings, ensure_ascii=False, indent=2), "utf-8")
    if settings["api_key"]:
        os.environ["ANTHROPIC_API_KEY"] = settings["api_key"]
        ai._client = None
    return get_settings()


# ---------- 存储 ----------

def clip_dir(cid: str) -> Path:
    if not re.fullmatch(r"[0-9a-zA-Z]+", cid):
        raise HTTPException(400, "bad id")
    return CLIPS / cid


def load_clip(cid: str) -> dict:
    f = clip_dir(cid) / "clip.json"
    if not f.exists():
        raise HTTPException(404, "没有这条视频")
    return json.loads(f.read_text("utf-8"))


def save_clip(clip: dict) -> None:
    f = clip_dir(clip["id"]) / "clip.json"
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(clip, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(f)


# ---------- 采集流程 ----------

class CollectIn(BaseModel):
    url: str


def set_job(cid: str, step: str, progress: float, **kw):
    jobs[cid] = {"id": cid, "step": step, "progress": round(progress, 3), **kw}


async def make_clip(cid: str, cues: list[dict], **meta) -> dict:
    """逐字稿到手后的公共流程：切话题、拼出 clip 记录。"""
    if not cues:
        raise RuntimeError("逐字稿是空的")
    topics, topic_source = [], "ai"
    if ai.available():
        try:
            topics = await ai.split_topics(meta["title"], meta.get("desc", ""), cues)
        except Exception:
            traceback.print_exc()
    if not topics:
        topics, topic_source = transcript.fallback_topics(cues), "auto"
    clip = {
        "id": cid, "desc": "", "author": "", "tags": [], "likes": "", "cover": "",
        **meta,
        "duration": meta.get("duration") or cues[-1]["end"],
        "created": time.strftime("%Y-%m-%d %H:%M"),
        "cues": cues,
        "topics": topics,
        "topic_source": topic_source,
        "frames": [],
        "notes": "",
        "chat": [],
        "exported": None,
    }
    clip_dir(cid).mkdir(parents=True, exist_ok=True)
    return clip


async def run_collect(cid: str, note: xhs.Note):
    d = clip_dir(cid)
    try:
        set_job(cid, "下载视频", 0.05)
        video = d / "video.mp4"
        if not video.exists():
            await xhs.download(note.video_url, video, lambda p: set_job(cid, "下载视频", 0.05 + 0.45 * p))

        set_job(cid, "生成逐字稿", 0.55)
        cues = []
        if note.subtitle_url:
            cues = transcript.parse_srt(await xhs.fetch_text(note.subtitle_url))
        if not cues:
            set_job(cid, "本地转写（较慢）", 0.6)
            cues = await asyncio.to_thread(transcript.transcribe_local, video)

        set_job(cid, "按话题切分", 0.75)
        save_clip(await make_clip(
            cid, cues, title=note.title, desc=note.desc, author=note.author, tags=note.tags,
            likes=note.likes, cover=note.cover_url, source_url=note.source_url,
            duration=note.duration, source="xhs", has_video=True,
        ))
        set_job(cid, "完成", 1.0, done=True)
    except Exception as e:
        traceback.print_exc()
        set_job(cid, "失败", 1.0, error=str(e) or e.__class__.__name__)


@app.post("/api/collect")
async def collect(body: CollectIn):
    try:
        note = await xhs.fetch_note(body.url)
    except xhs.XhsError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"打开链接失败：{e}")
    cid = note.note_id
    d = clip_dir(cid)
    if (d / "clip.json").exists():
        return {"id": cid, "existing": True}
    if jobs.get(cid) and not jobs[cid].get("done") and not jobs[cid].get("error"):
        return {"id": cid}
    d.mkdir(parents=True, exist_ok=True)
    set_job(cid, "解析链接", 0.02, title=note.title)
    asyncio.create_task(run_collect(cid, note))
    return {"id": cid}


@app.get("/api/jobs/{cid}")
def job(cid: str):
    if cid in jobs:
        return jobs[cid]
    if (clip_dir(cid) / "clip.json").exists():
        return {"id": cid, "step": "完成", "progress": 1, "done": True}
    raise HTTPException(404)


# ---------- Udemy 导入 ----------

class UdemyIn(BaseModel):
    url: str


@app.get("/api/udemy/status")
def udemy_status():
    return {"has_auth": udemy.has_auth(), "cookie_file": str(udemy.COOKIE_FILE),
            "login": udemy_login.state, "cloud": CLOUD}


# ---- 给浏览器插件用：插件在 Udemy 页面里读字幕，发过来建课时；cookie 不离开浏览器 ----

class ExtLectureIn(BaseModel):
    url: str
    course: dict  # {id, title, slug, host}
    chapter: str = ""
    lecture: dict  # {id, title, index, duration}
    caption_lang: str = ""
    caption_source: str = ""
    vtt: str


@app.get("/api/ext/udemy/{lecture_id}")
def ext_get_lecture(lecture_id: int):
    f = clip_dir(f"u{lecture_id}") / "clip.json"
    if not f.exists():
        raise HTTPException(404, "还没导入")
    return json.loads(f.read_text("utf-8"))


@app.get("/api/ext/frame/{cid}/{n}")
def ext_frame(cid: str, n: int):
    f = clip_dir(cid) / f"frame-{n}.jpg"
    if not f.exists():
        raise HTTPException(404)
    return {"image": "data:image/jpeg;base64," + base64.b64encode(f.read_bytes()).decode()}


@app.post("/api/ext/udemy")
async def ext_import_lecture(body: ExtLectureIn):
    lec, course = body.lecture, body.course
    cid = f"u{int(lec['id'])}"
    if (clip_dir(cid) / "clip.json").exists():
        return load_clip(cid)
    cues = udemy.parse_vtt(body.vtt)
    if not cues:
        raise HTTPException(400, "字幕是空的")
    clip = await make_clip(
        cid, cues,
        title=lec.get("title", ""), author=course.get("title", ""),
        desc=f"{course.get('title', '')} · {body.chapter}",
        source="udemy", has_video=False,
        source_url=udemy.lecture_url(course["host"], course["slug"], int(lec["id"])),
        duration=lec.get("duration") or 0,
        course={k: course.get(k) for k in ("id", "title", "slug", "host")},
        chapter=body.chapter, lecture_index=lec.get("index", 0),
        caption_lang=body.caption_lang, caption_source=body.caption_source,
    )
    save_clip(clip)
    return clip


class LoginIn(BaseModel):
    url: str | None = None


@app.post("/api/udemy/login")
def udemy_login_start(body: LoginIn):
    if CLOUD:
        raise HTTPException(400, "云端没法弹出登录窗口：Udemy 课程请用 KLD 浏览器插件导入")
    host, start_url = "gale.udemy.com", None
    if body.url and udemy.is_udemy(body.url):
        host = udemy.parse_url(body.url)[0]
        start_url = udemy.URL_RE.search(body.url).group(0)
    return udemy_login.start(host, start_url)


@app.delete("/api/udemy/login")
def udemy_login_cancel():
    udemy_login.cancel()
    return udemy_login.state


@app.post("/api/udemy/outline")
async def udemy_outline(body: UdemyIn):
    try:
        host, slug, lecture_id = udemy.parse_url(body.url)
        async with udemy.Client(host) as c:
            course = await c.course(slug)
            chapters = udemy.outline(await c.curriculum(course["id"]))
    except udemy.UdemyError as e:
        raise HTTPException(400, str(e))
    imported = {p.parent.name for p in CLIPS.glob("u*/clip.json")}
    for ch in chapters:
        for lec in ch["lectures"]:
            lec["imported"] = f"u{lec['id']}" in imported
    return {"host": host, "slug": slug, "lecture_id": lecture_id,
            "course": {"id": course["id"], "title": course["title"]}, "chapters": chapters}


class UdemyImportIn(BaseModel):
    url: str
    lecture_ids: list[int]
    lang: str = "en"


async def run_udemy_import(job_id: str, body: UdemyImportIn):
    host, slug, _ = udemy.parse_url(body.url)
    wanted, done, failed = set(body.lecture_ids), 0, []
    try:
        set_job(job_id, "读取课程目录", 0.02)
        async with udemy.Client(host) as c:
            course = await c.course(slug)
            # 字幕链接带时效签名，导入时重新取一遍目录，不用前端缓存的
            items = await c.curriculum(course["id"])
            chapter, todo = "", []
            for it in items:
                if it.get("_class") == "chapter":
                    chapter = it.get("title", "")
                elif it.get("_class") == "lecture" and it["id"] in wanted:
                    todo.append((it, chapter))
            sem = asyncio.Semaphore(4)

            async def one(it: dict, chapter: str):
                nonlocal done
                async with sem:
                    lid = it["id"]
                    try:
                        asset = it.get("asset") or {}
                        cap = udemy.pick_caption(asset, body.lang)
                        if not cap:
                            raise RuntimeError("这节课没有字幕")
                        cues = udemy.parse_vtt(await c.get_text(cap["url"]))
                        clip = await make_clip(
                            f"u{lid}", cues,
                            title=it.get("title", ""), author=course["title"],
                            desc=f"{course['title']} · {chapter}",
                            source="udemy", has_video=False,
                            source_url=udemy.lecture_url(host, slug, lid),
                            duration=asset.get("time_estimation") or asset.get("length") or 0,
                            course={"id": course["id"], "title": course["title"], "slug": slug, "host": host},
                            chapter=chapter, lecture_index=it.get("object_index", 0),
                            caption_lang=cap.get("locale_id"), caption_source=cap.get("source"),
                        )
                        save_clip(clip)
                    except Exception as e:
                        traceback.print_exc()
                        failed.append(f"{it.get('title', lid)}：{e}")
                    done += 1
                    set_job(job_id, f"导入课时 {done}/{len(todo)}", 0.05 + 0.95 * done / len(todo))

            await asyncio.gather(*(one(it, ch) for it, ch in todo))
        ok = len(todo) - len(failed)
        if not ok:
            raise RuntimeError("；".join(failed) or "没有可导入的课时")
        set_job(job_id, "完成", 1.0, done=True, imported=ok, failed=failed,
                first=f"u{todo[0][0]['id']}" if len(todo) == 1 else None)
    except Exception as e:
        traceback.print_exc()
        set_job(job_id, "失败", 1.0, error=str(e))


@app.post("/api/udemy/import")
async def udemy_import(body: UdemyImportIn):
    if not body.lecture_ids:
        raise HTTPException(400, "至少选一节课")
    try:
        udemy.parse_url(body.url)
    except udemy.UdemyError as e:
        raise HTTPException(400, str(e))
    job_id = f"udemy{int(time.time() * 1000)}"
    set_job(job_id, "准备导入", 0.01)
    asyncio.create_task(run_udemy_import(job_id, body))
    return {"id": job_id}


# ---------- 视频库 ----------

@app.get("/api/clips")
def list_clips():
    out = []
    for f in CLIPS.glob("*/clip.json"):
        c = json.loads(f.read_text("utf-8"))
        out.append({k: c.get(k) for k in ("id", "title", "author", "duration", "created", "exported", "source", "chapter", "lecture_index")}
                   | {"course": (c.get("course") or {}).get("title"),
                      "topics": len(c["topics"]), "frames": len(c["frames"]), "has_notes": bool(c["notes"])})
    # 新导入的在前；同一门课按课时顺序排
    out.sort(key=lambda c: c.get("lecture_index") or 0)
    return sorted(out, key=lambda c: (c["created"][:13], c.get("course") or ""), reverse=True)


@app.get("/api/clips/{cid}")
def get_clip(cid: str):
    return load_clip(cid)


@app.delete("/api/clips/{cid}")
def delete_clip(cid: str):
    shutil.rmtree(clip_dir(cid), ignore_errors=True)
    jobs.pop(cid, None)
    return {"ok": True}


@app.get("/media/{cid}/{name}")
def media(cid: str, name: str):
    if not re.fullmatch(r"video\.mp4|frame-\d+\.jpg", name):
        raise HTTPException(404)
    f = clip_dir(cid) / name
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f)


class NotesIn(BaseModel):
    notes: str


@app.put("/api/clips/{cid}/notes")
def save_notes(cid: str, body: NotesIn):
    clip = load_clip(cid)
    clip["notes"] = body.notes
    save_clip(clip)
    return {"ok": True}


class TopicsIn(BaseModel):
    topics: list[dict]


@app.post("/api/clips/{cid}/topics/regen")
async def regen_topics(cid: str):
    if not ai.available():
        raise HTTPException(400, "还没有配置 Claude API Key")
    clip = load_clip(cid)
    clip["topics"] = await ai.split_topics(clip["title"], clip["desc"], clip["cues"])
    clip["topic_source"] = "ai"
    save_clip(clip)
    return clip["topics"]


# ---------- 关键帧 ----------

class FrameIn(BaseModel):
    time: float
    image: str  # data:image/jpeg;base64,...
    caption: str = ""


@app.post("/api/clips/{cid}/frames")
def add_frame(cid: str, body: FrameIn):
    clip = load_clip(cid)
    n = max((f["n"] for f in clip["frames"]), default=0) + 1
    raw = base64.b64decode(body.image.split(",", 1)[-1])
    (clip_dir(cid) / f"frame-{n}.jpg").write_bytes(raw)
    frame = {"n": n, "time": body.time, "caption": body.caption, "file": f"frame-{n}.jpg"}
    clip["frames"].append(frame)
    clip["frames"].sort(key=lambda f: f["time"])
    save_clip(clip)
    return frame


class CaptionIn(BaseModel):
    caption: str


@app.put("/api/clips/{cid}/frames/{n}")
def edit_frame(cid: str, n: int, body: CaptionIn):
    clip = load_clip(cid)
    for f in clip["frames"]:
        if f["n"] == n:
            f["caption"] = body.caption
    save_clip(clip)
    return {"ok": True}


@app.delete("/api/clips/{cid}/frames/{n}")
def delete_frame(cid: str, n: int):
    clip = load_clip(cid)
    clip["frames"] = [f for f in clip["frames"] if f["n"] != n]
    (clip_dir(cid) / f"frame-{n}.jpg").unlink(missing_ok=True)
    save_clip(clip)
    return {"ok": True}


# ---------- AI 追问 ----------

class ChatIn(BaseModel):
    message: str
    focus_topic: int | None = None


@app.post("/api/clips/{cid}/chat")
async def chat(cid: str, body: ChatIn):
    if not ai.available():
        raise HTTPException(400, "还没有配置 Claude API Key，去右上角「设置」里填一下")
    clip = load_clip(cid)
    focus = None
    if body.focus_topic is not None and 0 <= body.focus_topic < len(clip["topics"]):
        t = clip["topics"][body.focus_topic]
        focus = f"话题「{t['title']}」，字幕 {t['start_cue']}-{t['end_cue']}"
    history = clip["chat"] + [{"role": "user", "content": body.message}]

    async def gen():
        parts = []
        try:
            async for text in ai.chat_stream(clip, history, focus):
                parts.append(text)
                yield f"data: {json.dumps({'t': text}, ensure_ascii=False)}\n\n"
        except Exception as e:
            traceback.print_exc()
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
            return
        latest = load_clip(cid)  # 期间可能有截帧/笔记写入，重新读一遍再追加
        latest["chat"] = history + [{"role": "assistant", "content": "".join(parts)}]
        save_clip(latest)
        yield "data: {\"done\": true}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.delete("/api/clips/{cid}/chat")
def clear_chat(cid: str):
    clip = load_clip(cid)
    clip["chat"] = []
    save_clip(clip)
    return {"ok": True}


# ---------- 导出到 Obsidian ----------

def safe_name(s: str) -> str:
    return re.sub(r'[\\/:*?"<>|#^\[\]]+', " ", s).strip()[:80] or "未命名"


def build_markdown(clip: dict, attach_dir: str) -> str:
    ft = transcript.fmt_time
    tags = " ".join(f"#{re.sub(r'\s+', '', t)}" for t in clip["tags"])
    course = clip.get("course")
    lines = [
        "---",
        f"title: \"{clip['title']}\"",
        f"source: {clip['source_url']}",
        f"author: \"{clip['author']}\"",
        *([f"course: \"{course['title']}\"", f"chapter: \"{clip.get('chapter', '')}\""] if course else []),
        f"duration: \"{ft(clip['duration'])}\"",
        f"collected: {clip['created'][:10]}",
        "type: 视频笔记",
        f"tags: [视频笔记{', 课程笔记' if course else ''}]",
        "---",
        "",
        f"# {clip['title']}",
        "",
        (f"> 来源：[{course['title']}]({clip['source_url']}) · {clip.get('chapter', '')}　时长 {ft(clip['duration'])}"
         if course else f"> 来源：[{clip['author']} · 小红书]({clip['source_url']})　时长 {ft(clip['duration'])}"),
        "",
    ]
    if clip["notes"].strip():
        lines += ["## 我的笔记", "", clip["notes"].strip(), ""]
    if clip["frames"]:
        lines += ["## 关键帧", ""]
        for f in clip["frames"]:
            lines += [f"### {ft(f['time'])} {f['caption'][:30]}".rstrip(), "",
                      f"![[{attach_dir}/{clip['id']}-{f['n']}.jpg]]", ""]
            if f["caption"]:
                lines += [f["caption"], ""]
    lines += ["## 话题", ""]
    lines += [f"{i + 1}. **{t['title']}**（{ft(clip['cues'][t['start_cue']]['start'])}）— {t.get('summary', '')}"
              for i, t in enumerate(clip["topics"])]
    lines += ["", "## 逐字稿", ""]
    for i, t in enumerate(clip["topics"]):
        cues = clip["cues"][t["start_cue"]:t["end_cue"] + 1]
        body = "".join(
            (c["text"] if re.search(r"[，。？！,.?!]$", c["text"]) else c["text"] + "，")
            if re.search(r"[一-鿿]", c["text"]) else c["text"] + " "
            for c in cues
        ).strip()
        lines += [f"### {i + 1}. {t['title']}", "", f"`{ft(cues[0]['start'])}` " + re.sub(r"，$", "。", body), ""]
    if clip["desc"]:
        lines += ["## 原笔记简介", "", clip["desc"], ""]
    if tags:
        lines += [tags, ""]
    return "\n".join(lines)


def export_files(clip: dict) -> tuple[str, dict[str, bytes]]:
    """算出要写进 Obsidian 仓库的文件：{仓库内相对路径: 内容}，返回 (笔记路径, 文件表)。"""
    folder = settings["folder"]
    files = {f"{folder}/attachments/{clip['id']}-{f['n']}.jpg": (clip_dir(clip["id"]) / f["file"]).read_bytes()
             for f in clip["frames"]}
    if clip.get("course"):
        # 课程笔记按课程建子文件夹，文件名带课时序号，方便在 Obsidian 里按顺序浏览
        md = f"{folder}/{safe_name(clip['course']['title'])}/{clip.get('lecture_index', 0):03d} {safe_name(clip['title'])}.md"
    else:
        md = f"{folder}/{safe_name(clip['title'])}.md"
    files[md] = build_markdown(clip, f"{folder}/attachments").encode("utf-8")
    return md, files


@app.post("/api/clips/{cid}/export")
async def export(cid: str):
    clip = load_clip(cid)
    md, files = export_files(clip)
    if settings["export_target"] == "github":
        try:
            where = await github_sync.push(
                settings["github_repo"], settings["github_branch"], github_token(), files,
                f"KLD: {clip['title']}",
            )
        except github_sync.SyncError as e:
            raise HTTPException(400, str(e))
        shown = f"GitHub {settings['github_repo']}/{md}"
    else:
        vault = Path(settings["vault"]).expanduser()
        for rel, data in files.items():
            p = vault / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        shown = where = str(vault / md)
    clip["exported"] = time.strftime("%Y-%m-%d %H:%M")
    save_clip(clip)
    return {"path": shown, "url": where, "exported": clip["exported"]}


@app.get("/api/clips/{cid}/markdown")
def markdown_preview(cid: str):
    clip = load_clip(cid)
    return {"markdown": build_markdown(clip, f"{settings['folder']}/attachments")}


# ---------- 前端 ----------

WEB = ROOT / "web"


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


@app.get("/login")
def login_page():
    return FileResponse(WEB / "login.html")


class PasswordIn(BaseModel):
    password: str


@app.post("/api/login")
def login(body: PasswordIn):
    if not auth.enabled():
        return {"ok": True}
    if not auth.check_password(body.password):
        time.sleep(1)  # 拖慢暴力猜密码
        raise HTTPException(401, "密码不对")
    resp = JSONResponse({"ok": True})
    resp.set_cookie(auth.COOKIE, auth.make_cookie(), max_age=auth.MAX_AGE, httponly=True,
                    samesite="lax", secure=CLOUD)
    return resp


@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE)
    return resp


@app.get("/healthz")
def healthz():
    return {"ok": True}


app.mount("/static", StaticFiles(directory=WEB), name="static")
