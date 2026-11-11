"""把导出的笔记提交到 GitHub 私有仓库（Obsidian 仓库），电脑/手机上的 Obsidian 用 Obsidian Git 插件拉取。

一次导出 = 一个 commit（笔记 + 关键帧图片），用 Git Data API，不需要服务器上装 git 或克隆仓库。
需要一个 fine-grained token：只授权这一个仓库，权限 Contents: Read and write。
"""
import base64

import httpx

API = "https://api.github.com"


class SyncError(Exception):
    pass


async def push(repo: str, branch: str, token: str, files: dict[str, bytes], message: str) -> str:
    """files: {仓库内路径: 内容}。返回 commit 的网页地址。"""
    if not (repo and token):
        raise SyncError("还没配置 GitHub 仓库或 token")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    async with httpx.AsyncClient(base_url=f"{API}/repos/{repo}", headers=headers, timeout=60) as c:
        for attempt in range(2):
            ref = await c.get(f"/git/ref/heads/{branch}")
            if ref.status_code == 404:
                raise SyncError(f"找不到仓库 {repo} 或分支 {branch}：检查仓库名，以及 token 是否授权了这个仓库")
            if ref.status_code == 409:
                raise SyncError("仓库是空的：在 GitHub 上先提交一个文件（创建仓库时勾选 Add a README 即可）")
            _check(ref)
            head = ref.json()["object"]["sha"]
            base_tree = _check(await c.get(f"/git/commits/{head}")).json()["tree"]["sha"]

            tree = []
            for path, data in files.items():
                blob = _check(await c.post("/git/blobs", json={
                    "content": base64.b64encode(data).decode(), "encoding": "base64"}))
                tree.append({"path": path, "mode": "100644", "type": "blob", "sha": blob.json()["sha"]})
            new_tree = _check(await c.post("/git/trees", json={"base_tree": base_tree, "tree": tree})).json()["sha"]
            commit = _check(await c.post("/git/commits", json={
                "message": message, "tree": new_tree, "parents": [head]})).json()

            upd = await c.patch(f"/git/refs/heads/{branch}", json={"sha": commit["sha"]})
            if upd.status_code == 422 and attempt == 0:
                continue  # 期间有别的提交（比如手机上的 Obsidian 推送了），基于最新的再来一次
            _check(upd)
            return commit["html_url"]
    raise SyncError("提交冲突，请稍后重试")


def _check(r: httpx.Response) -> httpx.Response:
    if r.status_code == 401:
        raise SyncError("GitHub token 无效或已过期")
    if r.status_code == 403:
        raise SyncError("GitHub token 没有写入权限：需要 Contents: Read and write")
    if r.status_code >= 400:
        raise SyncError(f"GitHub 返回 {r.status_code}：{r.text[:200]}")
    return r
