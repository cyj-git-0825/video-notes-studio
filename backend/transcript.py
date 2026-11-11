"""逐字稿：优先用小红书自带字幕；没有字幕时可选用本地 faster-whisper 转写。"""
import re
import shutil
import subprocess
from pathlib import Path

TIME_RE = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)")


def _sec(h, m, s, ms) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def parse_srt(text: str) -> list[dict]:
    cues = []
    for block in re.split(r"\r?\n\s*\r?\n", text.strip()):
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        for i, line in enumerate(lines):
            m = TIME_RE.search(line)
            if m:
                body = " ".join(lines[i + 1:]).strip()
                if body:
                    g = m.groups()
                    cues.append({"start": _sec(*g[:4]), "end": _sec(*g[4:]), "text": body})
                break
    for i, c in enumerate(cues):
        c["i"] = i
    return cues


def transcribe_local(video: Path) -> list[dict]:
    """没有平台字幕时的兜底方案：ffmpeg 抽音频 + faster-whisper。需要额外 pip install faster-whisper。"""
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise RuntimeError("这条视频没有平台字幕；如需本地转写请先 pip install faster-whisper") from e
    if not shutil.which("ffmpeg"):
        raise RuntimeError("本地转写需要 ffmpeg，请先安装并加入 PATH")
    audio = video.with_suffix(".wav")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-ac", "1", "-ar", "16000", str(audio)],
        check=True,
    )
    try:
        import os
        model = WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3-turbo"), device="auto", compute_type="int8")
        segments, _ = model.transcribe(str(audio), language="zh", vad_filter=True)
        cues = [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segments if s.text.strip()]
    finally:
        audio.unlink(missing_ok=True)
    for i, c in enumerate(cues):
        c["i"] = i
    return cues


def fallback_topics(cues: list[dict], span: float = 60.0) -> list[dict]:
    """没有配置 AI 时，按时长粗切分话题。"""
    topics, start = [], 0
    for i, c in enumerate(cues):
        if c["end"] - cues[start]["start"] >= span or i == len(cues) - 1:
            topics.append({
                "title": f"片段 {len(topics) + 1}",
                "summary": cues[start]["text"][:40],
                "start_cue": start,
                "end_cue": i,
            })
            start = i + 1
    return topics


def fmt_time(t: float) -> str:
    t = int(t)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"
