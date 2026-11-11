const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) {
    location.href = "/login";
    throw new Error("需要登录");
  }
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
};
const fmt = (t) => {
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(s).padStart(2, "0");
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const toast = (msg, ms = 2400) => {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
};
const TOPIC_COLORS = 5;
const tc = (i) => `--tb:var(--t${i % TOPIC_COLORS}b);--tbg:var(--t${i % TOPIC_COLORS});--cb:var(--t${i % TOPIC_COLORS}b);--cbg:var(--t${i % TOPIC_COLORS})`;

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
  refreshUdemy();
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
          ${c.exported ? `<span class="pill ok">已存入</span>` : c.has_notes ? `<span class="pill">有笔记</span>` : ""}
        </div>
      </div>`).join("")
    : `<div class="empty">还没有视频。收藏夹里那条「太有用了」的视频，从这里开始消化它。</div>`;
}

$("#libGrid").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    if (!confirm("删除这条视频和它的关键帧、笔记、对话？（已导出到 Obsidian 的不受影响）")) return;
    await api(`/api/clips/${del.dataset.del}`, { method: "DELETE" });
    return showHome();
  }
  const item = e.target.closest(".lib-item");
  if (item) location.hash = `#/clip/${item.dataset.id}`;
});

const STEP_OF = { "解析链接": 0, "下载视频": 1, "生成逐字稿": 2, "本地转写（较慢）": 2, "按话题切分": 3, "完成": 4 };
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
  if (/udemy\.com\/course\//.test(url)) {
    if (settingsCache?.cloud) {
      $("#collectStatus").textContent = "Udemy 课程请在课程页面里用 KLD 插件导入：打开这节课，点右侧 KLD 侧边栏里的「导入这节课」。";
      return;
    }
    return loadCourse(url);
  }
  const btn = $("#collectBtn"), st = $("#collectStatus");
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
      await new Promise((r) => setTimeout(r, 700));
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

// ---------------- Udemy 课程导入 ----------------
let course = null;

async function pollJob(id, onTick) {
  for (;;) {
    const j = await api(`/api/jobs/${id}`);
    onTick(j);
    if (j.error) throw new Error(j.error);
    if (j.done) return j;
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function loadCourse(url) {
  const btn = $("#collectBtn"), st = $("#collectStatus");
  btn.disabled = true;
  st.className = "collect-status";
  st.textContent = "读取 Udemy 课程目录…";
  paintSteps("");
  try {
    const s = await api("/api/udemy/status");
    if (!s.has_auth) {
      st.textContent = "还没登录 Udemy，正在打开登录窗口…";
      return udemyLogin();
    }
    course = { url, ...(await api("/api/udemy/outline", { method: "POST", body: { url } })) };
    st.textContent = "";
    renderCourse();
  } catch (err) {
    st.className = "collect-status err";
    st.textContent = "读取失败：" + err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---- Udemy 登录：后端弹出真实 Chrome 窗口，用户在 Udemy 页面里登录，成功后自动保存 cookie ----
function paintUdemy(s) {
  const el = $("#udemyState"), l = s.login || {};
  if (s.cloud) {
    el.innerHTML = `<span class="muted">课程请在 Udemy 页面里用 KLD 插件导入（侧边栏「导入这节课」）</span>`;
    $("#udemyLogin").hidden = $("#udemyCancel").hidden = true;
    return;
  }
  const busy = l.state === "starting" || l.state === "waiting";
  if (busy) el.innerHTML = `<span class="wait">${esc(l.message || "等待登录…")}</span>`;
  else if (l.state === "error") el.innerHTML = `<span class="err">${esc(l.message)}</span>`;
  else el.innerHTML = s.has_auth ? `<span class="ok">已登录 ✓</span>` : `<span class="muted">未登录</span>`;
  $("#udemyLogin").hidden = busy;
  $("#udemyLogin").textContent = s.has_auth ? "重新登录" : "登录 Udemy";
  $("#udemyCancel").hidden = !busy;
}
async function refreshUdemy() {
  try { paintUdemy(await api("/api/udemy/status")); } catch {}
}

let loginPolling = false;
async function udemyLogin() {
  const url = $("#urlInput").value.trim();
  paintUdemy({ login: await api("/api/udemy/login", { method: "POST", body: { url: /udemy\.com/.test(url) ? url : null } }) });
  if (loginPolling) return;
  loginPolling = true;
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = await api("/api/udemy/status");
      paintUdemy(s);
      if (s.login.state === "ok") {
        toast("Udemy 登录成功");
        const u = $("#urlInput").value.trim();
        if (/udemy\.com\/course\//.test(u)) loadCourse(u);
        else $("#collectStatus").textContent = "";
        return;
      }
      if (s.login.state === "error" || s.login.state === "idle") {
        $("#collectStatus").textContent = "";
        return;
      }
    }
  } finally {
    loginPolling = false;
  }
}
$("#udemyLogin").addEventListener("click", udemyLogin);
$("#udemyCancel").addEventListener("click", async () => paintUdemy({ login: await api("/api/udemy/login", { method: "DELETE" }) }));

function renderCourse() {
  const lecs = course.chapters.flatMap((c) => c.lectures);
  $("#courseTitle").textContent = course.course.title;
  $("#courseCount").textContent = `${course.chapters.length} 章 · ${lecs.length} 节视频课`;
  const langs = [...new Set(lecs.flatMap((l) => l.captions))].sort();
  const pref = langs.find((l) => l.startsWith("zh")) || langs.find((l) => l.startsWith("en")) || langs[0] || "en";
  $("#capLang").innerHTML = langs.map((l) => `<option ${l === pref ? "selected" : ""}>${l}</option>`).join("") || `<option>en_US</option>`;
  // 链接指向某节课时，默认只选这一节；否则默认选未导入的
  const only = course.lecture_id;
  $("#chapters").innerHTML = course.chapters.map((ch) => `
    <details class="chapter" ${!only || ch.lectures.some((l) => l.id === only) ? "open" : ""}>
      <summary>${esc(ch.chapter || "未分章")}<span class="small muted">${ch.lectures.length} 节 · <button class="link small" data-chsel>全选本章</button></span></summary>
      ${ch.lectures.map((l) => `
        <label class="lec ${l.captions.length ? "" : "nocap"}" title="${l.captions.length ? "字幕：" + l.captions.join(", ") : "没有字幕，无法导入"}">
          <input type="checkbox" value="${l.id}" ${!l.captions.length ? "disabled" : (only ? l.id === only : !l.imported) ? "checked" : ""}>
          <span class="lt">${l.index}. ${esc(l.title)}</span>
          <span class="lm">${l.imported ? "已导入 · " : ""}${fmt(l.duration)}</span>
        </label>`).join("")}
    </details>`).join("");
  $("#coursePicker").hidden = false;
  updateImportHint();
  $("#chapters").querySelector("input:checked")?.closest(".lec")?.scrollIntoView({ block: "center" });
}

function updateImportHint() {
  const n = $("#chapters").querySelectorAll("input:checked").length;
  $("#importHint").textContent = n ? `已选 ${n} 节${n > 20 ? "（课时多时 AI 切话题会花些时间和额度）" : ""}` : "";
  $("#importBtn").disabled = !n;
}
$("#chapters").addEventListener("change", updateImportHint);
$("#chapters").addEventListener("click", (e) => {
  if (!e.target.closest("[data-chsel]")) return;
  e.preventDefault();
  e.target.closest(".chapter").querySelectorAll("input:not(:disabled)").forEach((i) => (i.checked = true));
  updateImportHint();
});
document.querySelector(".course-tools").addEventListener("click", (e) => {
  const mode = e.target.dataset.sel;
  if (!mode) return;
  const imported = new Set(course.chapters.flatMap((c) => c.lectures).filter((l) => l.imported).map((l) => String(l.id)));
  $("#chapters").querySelectorAll("input:not(:disabled)").forEach((i) => {
    i.checked = mode === "all" || (mode === "new" && !imported.has(i.value));
  });
  updateImportHint();
});
$("#courseClose").addEventListener("click", () => { $("#coursePicker").hidden = true; });

$("#importBtn").addEventListener("click", async () => {
  const ids = [...$("#chapters").querySelectorAll("input:checked")].map((i) => +i.value);
  const btn = $("#importBtn");
  btn.disabled = true;
  try {
    const { id } = await api("/api/udemy/import", {
      method: "POST", body: { url: course.url, lecture_ids: ids, lang: $("#capLang").value },
    });
    const j = await pollJob(id, (j) => { $("#importHint").textContent = `${j.step} ${Math.round(j.progress * 100)}%`; });
    $("#urlInput").value = "";
    if (j.failed?.length) toast(`导入 ${j.imported} 节，失败 ${j.failed.length} 节：${j.failed[0]}`, 6000);
    else toast(`已导入 ${j.imported} 节`);
    if (j.first) location.hash = `#/clip/${j.first}`;
    else { $("#coursePicker").hidden = true; showHome(); }
  } catch (err) {
    $("#importHint").textContent = "导入失败：" + err.message;
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
// 跳到某个时间：内嵌视频直接跳；Udemy 课时在同一个外部标签页里打开到对应时间
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
  $("#clipMeta").textContent = (clip.course
    ? [clip.course.title, clip.chapter, `第 ${clip.lecture_index} 节`, fmt(clip.duration), clip.caption_lang && `字幕 ${clip.caption_lang}${clip.caption_source === "auto" ? "（自动生成）" : ""}`]
    : [clip.author, "小红书", fmt(clip.duration), clip.likes && `♥ ${clip.likes}`]
  ).concat(clip.exported && `已存入 Obsidian ${clip.exported}`).filter(Boolean).join(" · ");
  const v = $("#video");
  v.hidden = !hasVideo();
  $("#external").hidden = hasVideo();
  $("#captureBtn").hidden = !hasVideo();
  $("#followToggle").parentElement.hidden = !hasVideo();
  $("#captureHint").textContent = hasVideo()
    ? "看到画面里有命令 / 工具名 / 数据图 / 金句卡，点「截当前帧」并补一句它为什么重要。也可以截图后直接 Ctrl+V 粘贴进来。"
    : "在 Udemy 看到值得留的画面（代码、架构图、PPT 页），用 Win+Shift+S 截图，回到这里按 Ctrl+V 粘贴，补一句说明。";
  lastSeek = 0;
  if (hasVideo()) v.src = `/media/${clip.id}/video.mp4`;
  else v.removeAttribute("src");
  focusTopic = null;
  nowCue = -1;
  $("#notes").value = clip.notes || "";
  $("#captureDraft").hidden = true;
  renderChips();
  renderTranscript();
  renderFrames();
  renderChat();
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
  if (!clip) return;
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
  openDraft(v.currentTime, c.toDataURL("image/jpeg", 0.9));
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

// 粘贴截图：Udemy 课时（没有内嵌视频）主要靠这个留关键帧；小红书视频也能用
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
      <img src="/media/${clip.id}/${f.file}" data-time="${f.time}" alt="" loading="lazy">
      <div class="fb">
        <div class="ft"><span>${fmt(f.time)}</span><button data-delf="${f.n}" title="删除">✕</button></div>
        <div class="cap" contenteditable="plaintext-only" data-capn="${f.n}">${esc(f.caption || "")}</div>
      </div>
    </div>`).join("");
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
  $("#notesState").textContent = "已保存";
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
const md = (s) => {
  const html = window.marked ? DOMPurify.sanitize(marked.parse(s)) : esc(s).replace(/\n/g, "<br>");
  return html.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (_, t) => `<span class="tlink" data-ts="${t}">${t}</span>`);
};
const parseTs = (t) => t.split(":").reduce((a, b) => a * 60 + +b, 0);

function renderChat() {
  const list = $("#chatList");
  $("#chatCount").textContent = clip.chat.length ? clip.chat.filter((m) => m.role === "user").length : "";
  if (!clip.chat.length) {
    list.innerHTML = `<div class="chat-empty">${settingsCache?.ai
      ? "哪里没看懂就问。AI 读过整份逐字稿、话题和你截的关键帧，回答会带时间点，点一下就跳过去。"
      : "还没配置 Claude API Key。<br>去右上角 ⚙ 设置里填上，就能基于视频内容追问。"}</div>`;
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
  if (!settingsCache?.ai) { toast("先在设置里填 Claude API Key"); return openSettings(); }
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
    const r = await fetch(`/api/clips/${clip.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: q, focus_topic: focusTopic }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const ev of events) {
        if (!ev.startsWith("data: ")) continue;
        const d = JSON.parse(ev.slice(6));
        if (d.error) throw new Error(d.error);
        if (d.t) { text += d.t; out.innerHTML = md(text); scrollChat(); }
      }
    }
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

// ---- 导出 ----
$("#exportBtn").addEventListener("click", async () => {
  await saveNotes();
  try {
    const r = await api(`/api/clips/${clip.id}/export`, { method: "POST" });
    clip.exported = r.exported;
    toast("已存入：" + r.path, 4000);
    $("#clipMeta").textContent = $("#clipMeta").textContent.replace(/ · 已存入.*$/, "") + ` · 已存入 Obsidian ${r.exported}`;
  } catch (e) { toast("导出失败：" + e.message); }
});
$("#previewBtn").addEventListener("click", async () => {
  await saveNotes();
  const { markdown } = await api(`/api/clips/${clip.id}/markdown`);
  $("#previewBody").textContent = markdown;
  $("#previewDlg").showModal();
});

// ---- 设置 ----
async function loadSettings() {
  settingsCache = await api("/api/settings");
  return settingsCache;
}
async function openSettings() {
  const s = await loadSettings();
  $("#apiKey").value = "";
  $("#keyHint").textContent = s.api_key_hint ? `（已配置 ${s.api_key_hint}，模型 ${s.model}）` : "（未配置）";
  $("#vaultPath").value = s.vault;
  $("#vaultFolder").value = s.folder;
  $("#ghRepo").value = s.github_repo;
  $("#ghBranch").value = s.github_branch;
  $("#ghToken").value = "";
  $("#ghHint").textContent = s.github_token_hint ? `（已配置 ${s.github_token_hint}）` : "（未配置）";
  $("#localOpt").hidden = s.cloud;
  document.querySelector(`input[name=target][value=${s.cloud ? "github" : s.export_target}]`).checked = true;
  $("#logoutBtn").hidden = !s.auth;
  paintTarget();
  $("#settingsDlg").showModal();
}
const exportTarget = () => document.querySelector("input[name=target]:checked")?.value || "local";
function paintTarget() {
  $("#githubFields").hidden = exportTarget() !== "github";
  $("#localFields").hidden = exportTarget() !== "local";
}
$("#targetSeg").addEventListener("change", paintTarget);
$("#logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.href = "/login";
});
$("#settingsBtn").addEventListener("click", openSettings);
$("#settingsForm").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return;
  const body = {
    vault: $("#vaultPath").value, folder: $("#vaultFolder").value || "视频笔记",
    export_target: exportTarget(), github_repo: $("#ghRepo").value, github_branch: $("#ghBranch").value || "main",
  };
  if ($("#apiKey").value.trim()) body.api_key = $("#apiKey").value.trim();
  if ($("#ghToken").value.trim()) body.github_token = $("#ghToken").value.trim();
  settingsCache = await api("/api/settings", { method: "POST", body });
  toast("设置已保存");
  if (clip) { renderChips(); renderChat(); }
});

loadSettings().finally(route);
