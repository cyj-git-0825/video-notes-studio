"""在 KLD 里一键登录 Udemy：弹出一个真实的 Chrome 窗口，用户自己在 Udemy 页面里登录，
登录成功后 KLD 读取这个窗口的 cookie，存到 data/udemy_cookie.txt。账号密码只在 Udemy 页面里输入，KLD 不经手。

浏览器用本机已装的 Chrome，登录状态保存在 data/udemy_profile/，下次 cookie 过期时多半能直接通过。
Playwright 放在单独线程里跑（Windows 下 uvicorn 的事件循环不一定支持子进程）。
"""
import shlex
import threading
import time
from pathlib import Path

from curl_cffi import requests as cffi

from .udemy import COOKIE_FILE

PROFILE = COOKIE_FILE.parent / "udemy_profile"
TIMEOUT = 10 * 60

state = {"state": "idle", "message": ""}
_lock = threading.Lock()
_stop = threading.Event()


def _set(s: str, msg: str = ""):
    state.update(state=s, message=msg, at=time.time())


def _verify(host: str, cookie: str, ua: str) -> bool:
    """用拿到的 cookie 调一次 /users/me，确认是真的登录了，而不是只拿到了游客 cookie。"""
    token = next((p.split("=", 1)[1] for p in cookie.split("; ") if p.startswith("access_token=")), None)
    if not token:
        return False
    try:
        r = cffi.get(f"https://{host}/api-2.0/users/me/?fields[user]=id", impersonate="chrome", timeout=15,
                     headers={"Cookie": cookie, "User-Agent": ua, "Authorization": f"Bearer {token}",
                              "Accept": "application/json"})
        return r.status_code == 200 and bool(r.json().get("id"))
    except Exception:
        return False


def _save(host: str, cookie: str, ua: str):
    # 存成 cURL 格式，和手动 Copy as cURL 走同一套解析
    COOKIE_FILE.write_text(
        f"curl {shlex.quote(f'https://{host}/api-2.0/')} \\\n"
        f"  -b {shlex.quote(cookie)} \\\n"
        f"  -H {shlex.quote('user-agent: ' + ua)}\n",
        "utf-8",
    )


def _run(host: str, start_url: str):
    from playwright.sync_api import Error as PwError, sync_playwright

    try:
        with sync_playwright() as p:
            try:
                ctx = p.chromium.launch_persistent_context(
                    str(PROFILE), channel="chrome", headless=False, no_viewport=True,
                    ignore_default_args=["--enable-automation"],
                    args=["--disable-blink-features=AutomationControlled", "--window-size=1100,860"],
                )
            except PwError as e:
                msg = str(e)
                if "ProcessSingleton" in msg or "user data directory is already in use" in msg:
                    raise RuntimeError("上一个登录窗口还开着，请先关掉它") from e
                raise RuntimeError("打不开 Chrome，请确认电脑上装了 Google Chrome") from e
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(start_url, wait_until="domcontentloaded", timeout=60000)
            _set("waiting", "请在弹出的 Chrome 窗口里登录 Udemy（如果出现人机验证，点一下即可）")
            ua = page.evaluate("navigator.userAgent")
            deadline = time.time() + TIMEOUT
            last_check = ""
            while time.time() < deadline and not _stop.is_set():
                try:
                    if not ctx.pages:
                        raise PwError("closed")
                    cookies = ctx.cookies(f"https://{host}")
                except PwError:
                    raise RuntimeError("登录窗口被关掉了，还没登录成功") from None
                cookie = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
                # 只有 cookie 变了才去验证一次，避免频繁请求
                if "access_token=" in cookie and cookie != last_check:
                    last_check = cookie
                    if _verify(host, cookie, ua):
                        _save(host, cookie, ua)
                        _set("ok", "登录成功，已保存登录状态")
                        ctx.close()
                        return
                time.sleep(2)
            ctx.close()
            raise RuntimeError("已取消" if _stop.is_set() else "等了 10 分钟还没登录，已关闭窗口")
    except Exception as e:
        _set("error", str(e))


def start(host: str = "gale.udemy.com", start_url: str | None = None) -> dict:
    with _lock:
        if state["state"] in ("starting", "waiting"):
            return state
        _stop.clear()
        _set("starting", "正在打开 Chrome…")
        threading.Thread(target=_run, args=(host, start_url or f"https://{host}/"), daemon=True).start()
    return state


def cancel():
    _stop.set()
