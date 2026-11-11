// KLD 学习台（插件页面）：视频库、小红书采集、学习台。Udemy 课时在课程页面的侧边栏里导入和学习。
import DOMPurify from "dompurify";
import { marked } from "marked";
import { chat, request, syncPending } from "./lib/api.js";

const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await request(opts.method || "GET", path, opts.body);
  if (!r.ok) throw new Error(r.data?.detail || `出错了（${r.status}）`);
  return r.data;
};
const fmt = (t) => {
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(s).padStart(2, "0");
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const toast = (msg, ms = 2400) => {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
};
const TOPIC_COLORS = 5;
const tc = (i) => `--tb:var(--t${i % TOPIC_COLORS}b);--tbg:var(--t${i % TOPIC_COLORS});--cb:var(--t${i % TOPIC_COLORS}b);--cbg:var(--t${i % TOPIC_COLORS})`;
const openOptions = () => chrome.runtime.openOptionsPage();

let clip = null;
let settingsCache = null;
let focusTopic = null; // 当前只看的话题下标；null 表示全部
let cueEls = [];
let nowCue = -1;

// ---------------- 路由 ----------------
async function route() {
  const m = location.hash.match(/^#\/clip\/(\w+)/);
  if (m) await openClip(m[1]);
  else showHome();
}
window.addEventListener("hashchange", route);

// ---------------- 首页 ----------------
async function showHome() {
  clip = null;
  $("#video").pause();
  $("#home").hidden = false;
  $("#workspace").hidden = true;
  $("#clipHead").hidden = $("#exportBtn").hidden = $("#previewBtn").hidden = true;
  document.title = "KLD 视频学习台";
  paintSetup();
  const list = await api("/api/clips");
  $("#libCount").textContent = list.length ? `${list.length} 条` : "";
  $("#libGrid").innerHTML = list.length
    ? list.map((c) => `
      <div class="card lib-item" data-id="${c.id}">
        <button class="del" data-del="${c.id}" title="删除">✕</button>
        ${c.course ? `<div class="course">${esc(c.course)}</div>` : ""}
        <h4>${c.course ? `<span class="muted">${c.lecture_index}.</span> ` : ""}${esc(c.title)}</h4>
        <div class="meta">
          <span>${esc(c.course ? c.chapter || "" : c.author || "")}</span><span>${fmt(c.duration)}</span>
          <span class="pill">${c.topics} 个话题</span>
          ${c.frames ? `<span class="pill">${c.frames} 帧</span>` : ""}
          ${c.dirty ? `<span class="pill">未同步</span>` : c.exported ? `<span class="pill ok">已存入</span>` : ""}
        </div>
      </div>`).join("")
    : `<div class="empty">还没有视频。粘贴一条小红书视频链接，或者打开一节 Udemy 课、在右侧 KLD 侧边栏里点「导入这节课」。${settingsCache?.github ? `<br><button class="link" id="restoreBtn2">从 Obsidian 仓库恢复视频库</button>` : ""}</div>`;
}

// 首页顶部的设置提示：还没填 Claude Key / GitHub 时提醒
function paintSetup() {
  const s = settingsCache || {};
  const missing = [!s.ai && "Claude API Key（话题切分、AI 追问）", !s.github && "GitHub 仓库（存入 Obsidian）"].filter(Boolean);
  $("#setupBar").innerHTML = missing.length
    ? `还没配置：${missing.join("、")}。<button class="link small" data-act="options">去设置</button>`
    : `<span class="ok">已连接 ${esc(s.github_repo)} ✓</span> <button class="link small" id="restoreBtn">从仓库恢复视频库</button>`;
}

document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-act=options]")) return openOptions();
  if (e.target.id === "restoreBtn" || e.target.id === "restoreBtn2") {
    toast("正在从仓库读取…", 8000);
    try {
      const r = await api("/api/restore", { method: "POST" });
      toast(`仓库里有 ${r.total} 条，新恢复 ${r.added} 条`);
      showHome();
    } catch (err) { toast("恢复失败：" + err.message); }
  }
});

$("#libGrid").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    if (!confirm("删除这条视频的学习数据（逐字稿、对话、关键帧）？已经存进 Obsidian 的笔记会保留。")) return;
    await api(`/api/clips/${del.dataset.del}`, { method: "DELETE" });
    return showHome();
  }
  const item = e.target.closest(".lib-item");
  if (item) location.hash = `#/clip/${item.dataset.id}`;
});

const STEP_OF = { "解析链接": 0, "生成逐字稿": 1, "按话题切分": 2, "完成": 3 };
function paintSteps(step) {
  const k = STEP_OF[step] ?? -1;
  document.querySelectorAll(".step").forEach((el) => {
    const i = +el.dataset.k;
    el.classList.toggle("on", i < k);
    el.classList.toggle("run", i === k);
  });
}

$("#collectForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("#urlInput").value.trim();
  if (!url) return;
  const st = $("#collectStatus");
  if (/udemy\.com\/course\//.test(url)) {
    st.className = "collect-status";
    st.textContent = "Udemy 课程请在课程页面里导入：打开这节课，点右侧 KLD 侧边栏里的「导入这节课」。";
    return;
  }
  const btn = $("#collectBtn");
  btn.disabled = true;
  st.className = "collect-status";
  st.textContent = "解析链接…";
  paintSteps("解析链接");
  try {
    const { id } = await api("/api/collect", { method: "POST", body: { url } });
    for (;;) {
      const j = await api(`/api/jobs/${id}`);
      paintSteps(j.step);
      st.textContent = `${j.title ? `《${j.title}》 · ` : ""}${j.step} ${Math.round(j.progress * 100)}%`;
      if (j.error) throw new Error(j.error);
      if (j.done) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    $("#urlInput").value = "";
    location.hash = `#/clip/${id}`;
  } catch (err) {
    st.className = "collect-status err";
    st.textContent = "采集失败：" + err.message;
    paintSteps("");
  } finally {
    btn.disabled = false;
  }
});

// ---------------- 学习台 ----------------
const hasVideo = () => clip && clip.has_video !== false;
const externalUrl = (t) => {
  const u = new URL(clip.source_url);
  if (t) u.searchParams.set("start", Math.floor(t));
  else u.searchParams.delete("start");
  return u.toString();
};
let lastSeek = 0;
// 跳到某个时间：小红书视频直接跳；Udemy 课时在同一个 Udemy 标签页里打开到对应时间
function seek(t, play = true) {
  lastSeek = t;
  if (!hasVideo()) {
    window.open(externalUrl(t), "kld-external");
    return;
  }
  const v = $("#video");
  v.currentTime = t;
  if (play) v.play().catch(() => {});
}

// 小红书视频直链会过期：播放出错时用笔记地址重新取一次
let refreshed = false;
$("#video").addEventListener("error", async () => {
  if (!clip || !hasVideo() || refreshed) return;
  refreshed = true;
  try {
    const { video_url } = await api(`/api/clips/${clip.id}/refresh-video`, { method: "POST" });
    clip.video_url = video_url;
    $("#video").src = video_url;
  } catch (e) { toast("视频地址过期了，重新获取失败：" + e.message, 5000); }
});

async function openClip(id) {
  try {
    clip = await api(`/api/clips/${id}`);
  } catch (e) {
    toast(e.message);
    location.hash = "#/";
    return;
  }
  $("#home").hidden = true;
  $("#workspace").hidden = false;
  $("#clipHead").hidden = $("#exportBtn").hidden = $("#previewBtn").hidden = false;
  document.title = clip.title + " · KLD";
  $("#clipTitle").textContent = clip.title;
  paintMeta();
  const v = $("#video");
  v.hidden = !hasVideo();
  $("#external").hidden = hasVideo();
  $("#captureBtn").hidden = !hasVideo();
  $("#followToggle").parentElement.hidden = !hasVideo();
  $("#captureHint").textContent = hasVideo()
    ? "看到画面里有命令 / 工具名 / 数据图 / 金句卡，点「截当前帧」并补一句它为什么重要。也可以截图后直接 Ctrl+V 粘贴进来。"
    : "这节 Udemy 课更适合在课程页面的 KLD 侧边栏里学：视频和字幕在同一个画面，点一句就跳。这里也可以 Ctrl+V 粘贴截图。";
  lastSeek = 0;
  refreshed = false;
  if (hasVideo()) v.src = clip.video_url;
  else v.removeAttribute("src");
  focusTopic = null;
  nowCue = -1;
  $("#notes").value = clip.notes || "";
  $("#captureDraft").hidden = true;
  renderChips();
  renderTranscript();
  renderFrames();
  renderChat();
  updateFocusTag();
}

function paintMeta() {
  $("#clipMeta").textContent = (clip.course
    ? [clip.course.title, clip.chapter, `第 ${clip.lecture_index} 节`, fmt(clip.duration), clip.caption_lang && `字幕 ${clip.caption_lang}${clip.caption_source === "auto" ? "（自动生成）" : ""}`]
    : [clip.author, "小红书", fmt(clip.duration), clip.likes && `♥ ${clip.likes}`]
  ).concat(clip.exported && `已存入 Obsidian ${clip.exported}`).filter(Boolean).join(" · ");
}

function renderChips() {
  const all = `<button class="chip all ${focusTopic === null ? "active" : ""}" data-t="">全部 ${clip.cues.length} 句</button>`;
  $("#chips").innerHTML = all + clip.topics.map((t, i) =>
    `<button class="chip ${focusTopic === i ? "active" : ""}" style="${tc(i)}" data-t="${i}" title="${esc(t.summary || "")}">${i + 1}. ${esc(t.title)}</button>`).join("");
  $("#regenTopics").hidden = !settingsCache?.ai;
}

$("#chips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b) return;
  focusTopic = b.dataset.t === "" ? null : +b.dataset.t;
  renderChips();
  renderTranscript();
  updateFocusTag();
  if (focusTopic !== null) seek(clip.cues[clip.topics[focusTopic].start_cue].start);
});
$("#openExternal").addEventListener("click", () => seek(lastSeek));

$("#regenTopics").addEventListener("click", async () => {
  toast("AI 正在重新切分话题…", 8000);
  try {
    clip.topics = await api(`/api/clips/${clip.id}/topics/regen`, { method: "POST" });
    focusTopic = null;
    renderChips();
    renderTranscript();
    toast("话题已更新");
  } catch (e) { toast(e.message); }
});

function renderTranscript() {
  const topics = focusTopic === null ? clip.topics.map((t, i) => [t, i]) : [[clip.topics[focusTopic], focusTopic]];
  let html = "";
  for (const [t, i] of topics) {
    html += `<div class="topic-block" style="${tc(i)}" id="topic-${i}">
      <div class="topic-title"><span class="num">${i + 1}</span>${esc(t.title)}</div>
      ${t.summary ? `<p class="topic-summary">${esc(t.summary)}</p>` : ""}`;
    // 每 ~25 秒成一段，段首标时间
    let para = [], paraStart = null;
    const flush = () => {
      if (!para.length) return;
      html += `<div class="para"><span class="ts" data-time="${paraStart}">${fmt(paraStart)}</span><div>${para.join("")}</div></div>`;
      para = [];
    };
    for (let k = t.start_cue; k <= t.end_cue; k++) {
      const c = clip.cues[k];
      if (!c) continue;
      if (paraStart === null || c.start - paraStart > 25) { flush(); paraStart = c.start; }
      // 中文字幕句间补逗号，英文字幕句间补空格
      const txt = /[一-鿿]/.test(c.text)
        ? (/[，。？！,.?!]$/.test(c.text) ? c.text : c.text + "，")
        : c.text + " ";
      para.push(`<span class="cue" data-i="${k}">${esc(txt)}</span>`);
    }
    flush();
    html += `</div>`;
  }
  $("#transcriptPane").innerHTML = html;
  cueEls = [];
  document.querySelectorAll("#transcriptPane .cue").forEach((el) => (cueEls[+el.dataset.i] = el));
  nowCue = -1;
  syncCue();
}

$("#transcriptPane").addEventListener("click", (e) => {
  const cue = e.target.closest(".cue"), ts = e.target.closest(".ts");
  if (cue) {
    seek(clip.cues[+cue.dataset.i].start);
    if (!hasVideo()) markCue(+cue.dataset.i);
  } else if (ts) seek(+ts.dataset.time);
});

function cueAt(t) {
  const cues = clip.cues;
  let lo = 0, hi = cues.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function syncCue() {
  if (!clip || !hasVideo()) return;
  const v = $("#video");
  const i = cueAt(v.currentTime + 0.05);
  // 只看某个话题时，播到话题末尾自动暂停
  if (focusTopic !== null && !v.paused) {
    const t = clip.topics[focusTopic];
    if (i > t.end_cue) { v.pause(); toast("这个话题看完了，有疑问去「AI 追问」"); }
  }
  if (i === nowCue) return;
  markCue(i);
  if (cueEls[i] && $("#followToggle").checked && !$("#transcriptPane").hidden) {
    cueEls[i].scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
function markCue(i) {
  cueEls[nowCue]?.classList.remove("now");
  nowCue = i;
  cueEls[i]?.classList.add("now");
}
$("#video").addEventListener("timeupdate", syncCue);
$("#video").addEventListener("seeked", syncCue);

// ---- 关键帧 ----
let draft = null;
$("#captureBtn").addEventListener("click", () => {
  const v = $("#video");
  if (!v.videoWidth) return toast("视频还没加载好");
  v.pause();
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  try {
    openDraft(v.currentTime, c.toDataURL("image/jpeg", 0.9));
  } catch {
    toast("这个视频不允许截图，请用 Win+Shift+S 截图后 Ctrl+V 粘贴", 5000);
  }
});

function openDraft(time, image) {
  draft = { time, image };
  $("#draftImg").src = image;
  $("#draftClock").value = fmt(time);
  showDraftCue();
  $("#draftCaption").value = "";
  $("#captureDraft").hidden = false;
  $("#draftCaption").focus();
}
function showDraftCue() {
  const ci = cueAt(draft.time);
  $("#draftTime").textContent = ci >= 0 ? "此刻在说：" + clip.cues[ci].text : "";
}
$("#draftClock").addEventListener("input", () => {
  if (!draft || !/^\d+(:\d{1,2}){1,2}$/.test($("#draftClock").value.trim())) return;
  draft.time = parseTs($("#draftClock").value.trim());
  showDraftCue();
});

// 粘贴截图
document.addEventListener("paste", (e) => {
  if (!clip || $("#workspace").hidden) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (!item) return;
  e.preventDefault();
  const img = new Image();
  img.onload = () => {
    // 统一转成 JPEG，控制体积
    const c = document.createElement("canvas");
    const scale = Math.min(1, 1920 / img.width);
    c.width = img.width * scale;
    c.height = img.height * scale;
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    if (hasVideo()) $("#video").pause();
    openDraft(hasVideo() ? $("#video").currentTime : lastSeek, c.toDataURL("image/jpeg", 0.9));
  };
  img.src = URL.createObjectURL(item.getAsFile());
});
$("#draftCancel").addEventListener("click", () => { $("#captureDraft").hidden = true; draft = null; });
$("#draftSave").addEventListener("click", async () => {
  if (!draft) return;
  const f = await api(`/api/clips/${clip.id}/frames`, {
    method: "POST", body: { ...draft, caption: $("#draftCaption").value.trim() },
  });
  clip.frames.push(f);
  clip.frames.sort((a, b) => a.time - b.time);
  $("#captureDraft").hidden = true;
  draft = null;
  renderFrames();
  toast("关键帧已保存");
});
$("#draftCaption").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#draftSave").click();
});

function renderFrames() {
  $("#frameCount").textContent = `${clip.frames.length} 帧 · ${fmt($("#video").currentTime || 0)}`;
  $("#frames").innerHTML = clip.frames.map((f) => `
    <div class="frame" data-n="${f.n}">
      <img data-time="${f.time}" data-n="${f.n}" alt="">
      <div class="fb">
        <div class="ft"><span>${fmt(f.time)}</span><button data-delf="${f.n}" title="删除">✕</button></div>
        <div class="cap" contenteditable="plaintext-only" data-capn="${f.n}">${esc(f.caption || "")}</div>
      </div>
    </div>`).join("");
  // 图片存在插件数据库里（本机没有时从仓库取回）
  const id = clip.id;
  document.querySelectorAll("#frames img").forEach(async (img) => {
    try {
      const { image } = await api(`/api/ext/frame/${id}/${img.dataset.n}`);
      img.src = image;
    } catch {}
  });
}
$("#video").addEventListener("timeupdate", () => {
  if (clip) $("#frameCount").textContent = `${clip.frames.length} 帧 · ${fmt($("#video").currentTime)}`;
});
$("#frames").addEventListener("click", async (e) => {
  const img = e.target.closest("img[data-time]");
  if (img) { seek(+img.dataset.time, false); return; }
  const del = e.target.closest("[data-delf]");
  if (del && confirm("删除这一帧？")) {
    await api(`/api/clips/${clip.id}/frames/${del.dataset.delf}`, { method: "DELETE" });
    clip.frames = clip.frames.filter((f) => f.n !== +del.dataset.delf);
    renderFrames();
  }
});
$("#frames").addEventListener("focusout", async (e) => {
  const cap = e.target.closest("[data-capn]");
  if (!cap) return;
  const n = +cap.dataset.capn, caption = cap.textContent.trim();
  const f = clip.frames.find((x) => x.n === n);
  if (!f || f.caption === caption) return;
  f.caption = caption;
  await api(`/api/clips/${clip.id}/frames/${n}`, { method: "PUT", body: { caption } });
  toast("说明已保存");
});

// ---- 笔记（自动保存） ----
let notesTimer;
$("#notes").addEventListener("input", () => {
  $("#notesState").textContent = "编辑中…";
  clearTimeout(notesTimer);
  notesTimer = setTimeout(saveNotes, 800);
});
async function saveNotes() {
  if (!clip) return;
  clip.notes = $("#notes").value;
  await api(`/api/clips/${clip.id}/notes`, { method: "PUT", body: { notes: clip.notes } });
  $("#notesState").textContent = settingsCache?.github && settingsCache?.autosync ? "已保存，稍后自动同步" : "已保存";
}
function appendNote(text) {
  const n = $("#notes");
  n.value = (n.value.trim() ? n.value.trimEnd() + "\n\n" : "") + text.trim();
  saveNotes();
  toast("已加入「我的笔记」");
}

// ---- 标签页 ----
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
  $("#transcriptPane").hidden = b.dataset.tab !== "transcript";
  $("#chatPane").hidden = b.dataset.tab !== "chat";
  if (b.dataset.tab === "chat") { $("#chatInput").focus(); scrollChat(); }
}));

// ---- AI 追问 ----
const md = (s) => DOMPurify.sanitize(marked.parse(s))
  .replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (_, t) => `<span class="tlink" data-ts="${t}">${t}</span>`);
const parseTs = (t) => t.split(":").reduce((a, b) => a * 60 + +b, 0);

function renderChat() {
  const list = $("#chatList");
  $("#chatCount").textContent = clip.chat.length ? clip.chat.filter((m) => m.role === "user").length : "";
  if (!clip.chat.length) {
    list.innerHTML = `<div class="chat-empty">${settingsCache?.ai
      ? "哪里没看懂就问。AI 读过整份逐字稿、话题和你截的关键帧，回答会带时间点，点一下就跳过去。"
      : `还没配置 Claude API Key。<br><button class="link" data-act="options">去设置里填上</button>，就能基于视频内容追问。`}</div>`;
    return;
  }
  list.innerHTML = clip.chat.map((m, i) => m.role === "user"
    ? `<div class="msg user">${esc(m.content)}</div>`
    : `<div class="msg assistant">${md(m.content)}<div class="ops"><button data-addnote="${i}">＋ 加入笔记</button><button data-copy="${i}">复制</button></div></div>`
  ).join("") + `<div class="row-end"><button class="link small" id="clearChat">清空对话</button></div>`;
  scrollChat();
}
const scrollChat = () => { const l = $("#chatList"); l.scrollTop = l.scrollHeight; };

$("#chatList").addEventListener("click", async (e) => {
  const ts = e.target.closest(".tlink");
  if (ts) { seek(parseTs(ts.dataset.ts)); return; }
  const add = e.target.closest("[data-addnote]");
  if (add) return appendNote(clip.chat[+add.dataset.addnote].content);
  const cp = e.target.closest("[data-copy]");
  if (cp) { await navigator.clipboard.writeText(clip.chat[+cp.dataset.copy].content); return toast("已复制"); }
  if (e.target.id === "clearChat" && confirm("清空和 AI 的对话？")) {
    await api(`/api/clips/${clip.id}/chat`, { method: "DELETE" });
    clip.chat = [];
    renderChat();
  }
});

function updateFocusTag() {
  const tag = $("#focusTag");
  tag.hidden = focusTopic === null;
  if (focusTopic !== null) tag.innerHTML = `围绕话题 <b>${focusTopic + 1}. ${esc(clip.topics[focusTopic].title)}</b> 提问 · <button class="link small" id="unfocus">改为全片</button>`;
}
$("#focusTag").addEventListener("click", (e) => {
  if (e.target.id === "unfocus") { focusTopic = null; renderChips(); renderTranscript(); updateFocusTag(); }
});

$("#quick").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-q]");
  if (b) sendChat(b.dataset.q);
});
$("#chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#chatForm").requestSubmit(); }
});
$("#chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#chatInput").value.trim();
  if (q) sendChat(q);
});

let chatting = false;
async function sendChat(q) {
  if (chatting) return;
  if (!settingsCache?.ai) { toast("先在设置里填 Claude API Key"); return openOptions(); }
  chatting = true;
  $("#chatSend").disabled = true;
  $("#chatInput").value = "";
  const list = $("#chatList");
  if (!clip.chat.length) list.innerHTML = "";
  list.querySelector(".row-end")?.remove();
  list.insertAdjacentHTML("beforeend", `<div class="msg user">${esc(q)}</div><div class="msg assistant typing" id="streaming"></div>`);
  scrollChat();
  const out = $("#streaming");
  let text = "";
  try {
    await chat(clip.id, q, focusTopic, (t) => { text += t; out.innerHTML = md(text); scrollChat(); });
    clip.chat.push({ role: "user", content: q }, { role: "assistant", content: text });
    renderChat();
  } catch (err) {
    out.classList.remove("typing");
    out.innerHTML = `<span class="muted">出错了：${esc(err.message)}</span>`;
  } finally {
    chatting = false;
    $("#chatSend").disabled = false;
  }
}

// ---- 存入 Obsidian ----
$("#exportBtn").addEventListener("click", async () => {
  if (!settingsCache?.github) { toast("先在设置里填 GitHub 仓库和 token"); return openOptions(); }
  await saveNotes();
  const btn = $("#exportBtn");
  btn.disabled = true;
  try {
    const r = await api(`/api/clips/${clip.id}/export`, { method: "POST" });
    clip.exported = r.exported;
    toast("已存入：" + r.path, 4000);
    paintMeta();
  } catch (e) {
    toast("存入失败：" + e.message, 5000);
  } finally {
    btn.disabled = false;
  }
});
$("#previewBtn").addEventListener("click", async () => {
  await saveNotes();
  const { markdown } = await api(`/api/clips/${clip.id}/markdown`);
  $("#previewBody").textContent = markdown;
  $("#previewDlg").showModal();
});
$("#previewClose").addEventListener("click", () => $("#previewDlg").close());

// ---- 设置 ----
async function loadSettings() {
  settingsCache = await api("/api/settings");
  return settingsCache;
}
$("#settingsBtn").addEventListener("click", openOptions);
// 在设置页改完回到这里时刷新
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) return;
  await loadSettings();
  if (clip) { renderChips(); renderChat(); } else paintSetup();
});

loadSettings().finally(() => { route(); syncPending(); });
