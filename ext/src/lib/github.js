// GitHub 上的 Obsidian 仓库：笔记、关键帧和 KLD 的学习数据（.kld/ 隐藏目录）都存在这里。
// 一次同步 = 一个 commit，用 Git Data API；读取用 Contents API。
// token 用 fine-grained：只授权这一个仓库，Contents: Read and write。
import { getSettings } from "./settings.js";

const API = "https://api.github.com";

export class SyncError extends Error {}

async function cfg() {
  const s = await getSettings();
  if (!s.ghRepo || !s.ghToken) throw new SyncError("还没配置 GitHub 仓库或 token：右键插件图标 → 选项");
  return s;
}

async function gh(s, method, path, body, accept = "application/vnd.github+json") {
  const r = await fetch(`${API}/repos/${s.ghRepo}${path}`, {
    method,
    headers: { Authorization: `Bearer ${s.ghToken}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw new SyncError("GitHub token 无效或已过期");
  if (r.status === 403) throw new SyncError("GitHub token 没有权限：需要这个仓库的 Contents: Read and write");
  return r;
}

const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** files: {仓库内路径: string | Uint8Array | null}，null 表示删除。返回 commit 网址。 */
export async function push(files, message) {
  const s = await cfg();
  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = await gh(s, "GET", `/git/ref/heads/${s.ghBranch}`);
    if (ref.status === 404) throw new SyncError(`找不到仓库 ${s.ghRepo} 或分支 ${s.ghBranch}：检查仓库名，以及 token 是否授权了这个仓库`);
    if (ref.status === 409) throw new SyncError("仓库是空的：在 GitHub 上先提交一个文件（创建仓库时勾选 Add a README 即可）");
    const head = (await ok(ref).json()).object.sha;
    const baseTree = (await ok(await gh(s, "GET", `/git/commits/${head}`)).json()).tree.sha;

    const tree = [];
    for (const [path, data] of Object.entries(files)) {
      if (data === null) { tree.push({ path, mode: "100644", type: "blob", sha: null }); continue; }
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const blob = await ok(await gh(s, "POST", "/git/blobs", { content: b64(bytes), encoding: "base64" })).json();
      tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const newTree = await gh(s, "POST", "/git/trees", { base_tree: baseTree, tree });
    if (newTree.status === 422 && tree.every((t) => t.sha === null)) return null; // 要删的文件本来就不存在
    const treeSha = (await ok(newTree).json()).sha;
    const commit = await ok(await gh(s, "POST", "/git/commits", { message, tree: treeSha, parents: [head] })).json();
    const upd = await gh(s, "PATCH", `/git/refs/heads/${s.ghBranch}`, { sha: commit.sha });
    if (upd.status === 422 && attempt === 0) continue; // 期间别处（比如手机上的 Obsidian）推送过，基于最新的再来一次
    ok(upd);
    return commit.html_url;
  }
  throw new SyncError("提交冲突，请稍后重试");
}

/** 读仓库里的一个文件，返回 ArrayBuffer；不存在返回 null */
export async function readFile(path) {
  const s = await cfg();
  const r = await gh(s, "GET", `/contents/${encodePath(path)}?ref=${encodeURIComponent(s.ghBranch)}`, null, "application/vnd.github.raw+json");
  if (r.status === 404) return null;
  return ok(r).arrayBuffer();
}

/** 列目录，返回文件名数组；目录不存在返回 [] */
export async function listDir(path) {
  const s = await cfg();
  const r = await gh(s, "GET", `/contents/${encodePath(path)}?ref=${encodeURIComponent(s.ghBranch)}`);
  if (r.status === 404) return [];
  return (await ok(r).json()).filter((f) => f.type === "file").map((f) => f.name);
}

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

function ok(r) {
  if (!r.ok) throw new SyncError(`GitHub 返回 ${r.status}`);
  return r;
}

/** 设置页的“测试”：确认仓库存在、token 能写、分支存在 */
export async function testConnection() {
  const s = await cfg();
  const repo = await gh(s, "GET", "");
  if (repo.status === 404) throw new SyncError(`找不到仓库 ${s.ghRepo}：检查仓库名，以及 token 是否授权了这个仓库`);
  const info = await ok(repo).json();
  if (info.permissions && !info.permissions.push) throw new SyncError("token 只有读权限：Contents 需要设为 Read and write");
  const ref = await gh(s, "GET", `/git/ref/heads/${s.ghBranch}`);
  if (ref.status === 409) throw new SyncError("仓库是空的：在 GitHub 上先提交一个文件（创建仓库时勾选 Add a README 即可）");
  if (ref.status === 404) throw new SyncError(`仓库里没有 ${s.ghBranch} 分支`);
  ok(ref);
  return { private: info.private, name: info.full_name };
}

export async function configured() {
  const s = await getSettings();
  return !!(s.ghRepo && s.ghToken);
}
