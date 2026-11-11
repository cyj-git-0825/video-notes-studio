"""访问保护：部署到公网时设置环境变量 KLD_PASSWORD。

- 网页：在 /login 输入密码，拿到签名 cookie（30 天有效）
- 浏览器插件：请求头带 `X-KLD-Key: <密码>`（插件的请求从后台发出，带不上网页 cookie）
没设置 KLD_PASSWORD 时（本机运行）不做任何限制。
"""
import hashlib
import hmac
import os
import secrets
import time

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse

COOKIE = "kld_session"
MAX_AGE = 30 * 86400
OPEN_PATHS = ("/login", "/api/login", "/static/", "/healthz")


def password() -> str:
    return os.environ.get("KLD_PASSWORD", "")


def enabled() -> bool:
    return bool(password())


def _sign(ts: str) -> str:
    # 用密码派生签名密钥：改密码后旧 cookie 自动失效
    key = hashlib.sha256(("kld:" + password()).encode()).digest()
    return hmac.new(key, ts.encode(), hashlib.sha256).hexdigest()


def make_cookie() -> str:
    ts = str(int(time.time()))
    return f"{ts}.{_sign(ts)}"


def check_password(pw: str) -> bool:
    return secrets.compare_digest(pw.encode(), password().encode())


def _valid_cookie(v: str | None) -> bool:
    if not v or "." not in v:
        return False
    ts, sig = v.split(".", 1)
    return ts.isdigit() and time.time() - int(ts) < MAX_AGE and secrets.compare_digest(sig, _sign(ts))


def authorized(req: Request) -> bool:
    if not enabled():
        return True
    key = req.headers.get("x-kld-key")
    if key and check_password(key):
        return True
    return _valid_cookie(req.cookies.get(COOKIE))


async def middleware(req: Request, call_next):
    path = req.url.path
    if req.method == "OPTIONS" or path.startswith(OPEN_PATHS) or authorized(req):
        return await call_next(req)
    if path.startswith(("/api/", "/media/")):
        return JSONResponse({"detail": "需要登录"}, status_code=401)
    return RedirectResponse("/login")
