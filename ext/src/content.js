// KLD 侧边栏：注入 Udemy 课时页面。
// - 字幕：用你当前的 Udemy 登录状态在页面里读（cookie 不离开浏览器），发给 KLD 建课时
// - 播放：直接控制页面里的 <video>：高亮当前句、点一句跳过去（视频本身不下载、不解密）
// - 存储、AI、同步都在插件后台（bg.js）完成，数据最终存进 GitHub 上的 Obsidian 仓库
(() => {
  if (window.__kld) return;
  window.__kld = true;

  const W = 400;
  const S = { open: true, lectureId: null, clip: null, focus: null, tab: "transcript", cueEls: [], now: -1, chatting: false, frameDraft: null };

  // ---------- 小工具 ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmt = (t) => {
    t = Math.max(0, Math.floor(t));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(s).padStart(2, "0");
  };
  const parseTs = (t) => t.split(":").reduce((a, b) => a * 60 + +b, 0);
  const kld = (method, path, body) => chrome.runtime.sendMessage({ type: "kld", method, path, body });
  const video = () => document.querySelector("video");

  // 极简 Markdown：标题、粗体、行内代码、代码块、列表、[mm:ss] 时间点
  function md(src) {
    const blocks = esc(src).split(/```/);
    return blocks.map((b, i) => {
      if (i % 2) return `<pre>${b.replace(/^\w*\n/, "")}</pre>`;
      return b.split(/\n{2,}/).map((p) => {
        p = p.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
        if (/^#{1,4} /.test(p)) return `<h4>${p.replace(/^#{1,4} /, "")}</h4>`;
        if (/^\s*([-*]|\d+\.) /m.test(p) && p.split("\n").every((l) => /^\s*([-*]|\d+\.) /.test(l) || !l.trim())) {
          return "<ul>" + p.split("\n").filter((l) => l.trim()).map((l) => `<li>${l.replace(/^\s*([-*]|\d+\.) /, "")}</li>`).join("") + "</ul>";
        }
        return `<p>${p.replace(/\n/g, "<br>")}</p>`;
      }).join("");
    }).join("").replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (_, t) => `<a class="tl" data-ts="${t}">${t}</a>`);
  }

  // ---------- Udemy 接口（在页面里以你的登录状态请求） ----------
  async function udemy(path) {
    const url = location.origin + path;
    const base = { Accept: "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" };
    let r = await fetch(url, { credentials: "include", headers: base });
    if (r.status === 401 || r.status === 403) {
      // 有些账号还要求带 Bearer 头，Udemy 自己的前端也是这么做的
      const tok = document.cookie.match(/(?:^|;\s*)access_token=([^;]+)/)?.[1];
      if (tok) r = await fetch(url, { credentials: "include", headers: { ...base, Authorization: `Bearer ${tok}`, "X-Udemy-Authorization": `Bearer ${tok}` } });
    }
    if (!r.ok) throw new Error(r.status === 403 ? "Udemy 拒绝访问：确认已登录、并且能正常播放这门课" : `Udemy 返回 ${r.status}`);
    return r.json();
  }

  const curriculumCache = {};
  async function curriculum(courseId) {
    if (curriculumCache[courseId]) return curriculumCache[courseId];
    const q = new URLSearchParams({
      page_size: "200", caching_intent: "True",
      "fields[lecture]": "title,object_index,asset",
      "fields[chapter]": "title,object_index",
      "fields[asset]": "asset_type,time_estimation,length,captions",
      "fields[caption]": "locale_id,url,source,status",
    });
    let path = `/api-2.0/courses/${courseId}/subscriber-curriculum-items/?${q}`, items = [];
    while (path) {
      const d = await udemy(path);
      items = items.concat(d.results || []);
      path = d.next ? d.next.replace(/^https?:\/\/[^/]+/, "") : null;
    }
    return (curriculumCache[courseId] = items);
  }

  function pickCaption(caps) {
    caps = (caps || []).filter((c) => c.url);
    const score = (c) => {
      const l = (c.locale_id || "").toLowerCase();
      return (l.startsWith("zh") ? 4 : l.startsWith("en") ? 2 : 0) + (c.source !== "auto" ? 1 : 0);
    };
    return caps.sort((a, b) => score(b) - score(a))[0];
  }

  function pageLecture() {
    const m = location.pathname.match(/\/course\/([^/]+)\/learn\/lecture\/(\d+)/);
    return m ? { slug: m[1], id: +m[2] } : null;
  }

  async function importLecture() {
    const pl = pageLecture();
    setBody(`<div class="empty">正在读取这节课的字幕…</div>`);
    try {
      const course = await udemy(`/api-2.0/courses/${pl.slug}/?fields[course]=id,title`);
      const items = await curriculum(course.id);
      let chapter = "", lec = null;
      for (const it of items) {
        if (it._class === "chapter") chapter = it.title;
        if (it._class === "lecture" && it.id === pl.id) { lec = it; break; }
      }
      if (!lec) throw new Error("在课程目录里没找到这节课");
      const asset = lec.asset || {};
      const cap = pickCaption(asset.captions);
      if (!cap) throw new Error("这节课没有字幕");
      setBody(`<div class="empty">下载字幕（${esc(cap.locale_id)}），让 KLD 切分话题…</div>`);
      const vtt = await chrome.runtime.sendMessage({ type: "text", url: cap.url });
      if (!vtt.ok) throw new Error("字幕下载失败");
      const r = await kld("POST", "/api/ext/udemy", {
        url: location.href,
        course: { id: course.id, title: course.title, slug: pl.slug, host: location.host },
        chapter,
        lecture: { id: lec.id, title: lec.title, index: lec.object_index, duration: asset.time_estimation || asset.length || 0 },
        caption_lang: cap.locale_id, caption_source: cap.source, vtt: vtt.text,
      });
      if (!r.ok) throw new Error(r.data?.detail || `出错了（${r.status}）`);
      S.clip = r.data;
      render();
    } catch (e) {
      setBody(`<div class="empty err">导入失败：${esc(e.message)}<br><button class="btn" data-act="import">重试</button></div>`);
    }
  }

  // ---------- 界面 ----------
  const host = document.createElement("div");
  host.id = "kld-sidebar-host";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS()}</style>
    <button class="tab-open" data-act="toggle" title="KLD">K</button>
    <aside class="panel">
      <header>
        <div class="brand"><span class="logo">K</span>KLD</div>
        <div class="acts">
          <button class="ghost" data-act="export" title="存入 Obsidian">存入 Obsidian</button>
          <button class="ghost" data-act="openkld" title="在 KLD 打开">↗</button>
          <button class="ghost" data-act="toggle" title="收起">✕</button>
        </div>
      </header>
      <div class="meta"></div>
      <nav>
        <button data-tab="transcript">逐字稿</button>
        <button data-tab="chat">AI 追问</button>
        <button data-tab="notes">笔记 · 关键帧</button>
      </nav>
      <div class="body"></div>
      <div class="toast"></div>
    </aside>`;
  document.documentElement.appendChild(host);
  const $ = (s) => root.querySelector(s);

  function toast(msg, ms = 2400) {
    const t = $(".toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), ms);
  }

  function setOpen(open) {
    S.open = open;
    host.classList.toggle("open", open);
    $(".panel").hidden = !open;
    $(".tab-open").hidden = open;
    chrome.storage.local.set({ sidebarOpen: open });
  }

  function setBody(html) { $(".body").innerHTML = html; }

  async function loadLecture() {
    const pl = pageLecture();
    S.lectureId = pl?.id ?? null;
    S.clip = null; S.focus = null; S.now = -1;
    if (!pl) { $(".meta").textContent = ""; setBody(`<div class="empty">打开一节视频课，就能在这里学习。</div>`); return; }
    const cfg = await chrome.runtime.sendMessage({ type: "config" });
    setBody(`<div class="empty">加载中…</div>`);
    const r = await kld("GET", `/api/ext/udemy/${pl.id}`);
    if (pageLecture()?.id !== pl.id) return; // 加载期间已经切到别的课了
    if (r.ok) { S.clip = r.data; render(); return; }
    $(".meta").textContent = document.title.replace(/\s*\|\s*Udemy.*$/, "");
    if (r.status === 404) setBody(`<div class="empty">这节课还没导入 KLD。<br><button class="btn" data-act="import">导入这节课</button><p class="hint">会读取这节课的字幕（优先中文，其次英文），AI 切分话题。视频不下载。</p>${cfg.ai ? "" : `<p class="hint">还没配置 Claude API Key：话题会按时长粗分，也不能追问。<a class="link" data-act="options">去设置</a></p>`}</div>`);
    else setBody(`<div class="empty err">${esc(r.data?.detail || "出错了")}<br><button class="btn" data-act="reload">重试</button></div>`);
  }

  function render() {
    const c = S.clip;
    $(".meta").innerHTML = `<b>${esc(c.title)}</b><span>${esc(c.chapter || "")} · ${fmt(c.duration)}${c.caption_source === "auto" ? " · 自动字幕" : ""}${c.exported ? " · 已存入" : ""}</span>`;
    root.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
    if (S.tab === "transcript") renderTranscript();
    else if (S.tab === "chat") renderChat();
    else renderNotes();
  }

  function renderTranscript() {
    const c = S.clip;
    const chips = `<div class="chips"><button class="chip ${S.focus === null ? "on" : ""}" data-topic="">全部</button>` +
      c.topics.map((t, i) => `<button class="chip c${i % 5} ${S.focus === i ? "on" : ""}" data-topic="${i}" title="${esc(t.summary)}">${i + 1}. ${esc(t.title)}</button>`).join("") + "</div>";
    const topics = S.focus === null ? c.topics.map((t, i) => [t, i]) : [[c.topics[S.focus], S.focus]];
    let html = chips;
    for (const [t, i] of topics) {
      html += `<section class="topic c${i % 5}"><h4><span>${i + 1}</span>${esc(t.title)}</h4>`;
      let para = [], start = null;
      const flush = () => {
        if (para.length) html += `<div class="para"><a class="ts" data-time="${start}">${fmt(start)}</a><div>${para.join("")}</div></div>`;
        para = [];
      };
      for (let k = t.start_cue; k <= t.end_cue; k++) {
        const q = c.cues[k];
        if (!q) continue;
        if (start === null || q.start - start > 25) { flush(); start = q.start; }
        const sep = /[一-鿿]/.test(q.text) ? (/[，。？！]$/.test(q.text) ? "" : "，") : " ";
        para.push(`<span class="cue" data-i="${k}">${esc(q.text + sep)}</span>`);
      }
      flush();
      html += "</section>";
    }
    setBody(html);
    S.cueEls = [];
    root.querySelectorAll(".cue").forEach((el) => (S.cueEls[+el.dataset.i] = el));
    S.now = -1;
  }

  function renderChat() {
    const c = S.clip;
    const msgs = c.chat.length ? c.chat.map((m, i) => m.role === "user"
      ? `<div class="msg user">${esc(m.content)}</div>`
      : `<div class="msg ai">${md(m.content)}<div class="ops"><button data-addnote="${i}">＋ 加入笔记</button></div></div>`).join("")
      : `<div class="empty">哪里没看懂就问。AI 读过这节课的完整字幕，回答会带时间点，点一下视频就跳过去。</div>`;
    setBody(`<div class="chat"><div class="msgs">${msgs}</div>
      <div class="quick">
        <button data-q="用中文三五句话讲清楚这一段在说什么">总结这一段</button>
        <button data-q="这一段我没太看懂，用中文换个更通俗的说法解释一下，最好举个例子">没看懂，再讲讲</button>
        <button data-q="这节课里提到的工具、命令、代码、链接都列出来，标上时间点">列出工具和命令</button>
        <button data-q="把这节课整理成一篇适合放进 Obsidian 的中文学习笔记：核心概念、步骤、要点、我可以马上动手的事">整理成笔记</button>
      </div>
      ${S.focus !== null ? `<div class="hint">围绕话题 <b>${S.focus + 1}. ${esc(c.topics[S.focus].title)}</b> 提问</div>` : ""}
      <form class="ask"><textarea rows="2" placeholder="继续追问…（Enter 发送）"></textarea><button class="btn">发送</button></form></div>`);
    const m = $(".msgs");
    m.scrollTop = m.scrollHeight;
  }

  function renderNotes() {
    const c = S.clip;
    const frames = c.frames.map((f) => `<div class="frame"><img src="" data-n="${f.n}" alt=""><div><a class="ts" data-time="${f.time}">${fmt(f.time)}</a> ${esc(f.caption || "")}</div></div>`).join("");
    setBody(`<div class="notes">
      <h5>我的笔记 <span class="hint" id="ns">自动保存</span></h5>
      <textarea class="note">${esc(c.notes || "")}</textarea>
      <h5>关键帧</h5>
      <div class="paste" tabindex="0">在 Udemy 里按 <b>Win+Shift+S</b> 截图，点这里再按 <b>Ctrl+V</b> 粘贴。时间点自动取当前播放位置。</div>
      <div class="draft" hidden><img alt=""><input placeholder="这帧为什么重要？"><button class="btn" data-act="saveframe">保存</button><button class="ghost" data-act="dropframe">取消</button></div>
      <div class="frames">${frames || '<div class="hint">还没有关键帧</div>'}</div></div>`);
    // 关键帧图片存在插件的本机数据库（或 GitHub 仓库）里，经后台取成 data URL
    root.querySelectorAll(".frame img").forEach(async (img) => {
      const r = await kld("GET", `/api/ext/frame/${c.id}/${img.dataset.n}`);
      if (r.ok) img.src = r.data.image;
    });
  }

  // ---------- 交互 ----------
  root.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act],[data-tab],[data-topic],[data-addnote],[data-q],.cue,.ts,.tl");
    if (!el) return;
    if (el.classList.contains("cue")) return seek(S.clip.cues[+el.dataset.i].start);
    if (el.classList.contains("ts")) return seek(+el.dataset.time);
    if (el.classList.contains("tl")) return seek(parseTs(el.dataset.ts));
    if (el.dataset.tab) { S.tab = el.dataset.tab; return S.clip && render(); }
    if (el.dataset.topic !== undefined) {
      S.focus = el.dataset.topic === "" ? null : +el.dataset.topic;
      renderTranscript();
      if (S.focus !== null) seek(S.clip.cues[S.clip.topics[S.focus].start_cue].start);
      return;
    }
    if (el.dataset.addnote !== undefined) return addNote(S.clip.chat[+el.dataset.addnote].content);
    if (el.dataset.q) return ask(el.dataset.q);
    switch (el.dataset.act) {
      case "toggle": return setOpen(!S.open);
      case "import": return importLecture();
      case "reload": return loadLecture();
      case "options": return chrome.runtime.sendMessage({ type: "options" });
      case "openkld": return chrome.runtime.sendMessage({ type: "openapp", hash: S.clip ? `#/clip/${S.clip.id}` : "" });
      case "export": {
        if (!S.clip) return toast("先导入这节课");
        await saveNotes();
        const r = await kld("POST", `/api/clips/${S.clip.id}/export`);
        if (r.ok) { S.clip.exported = r.data.exported; toast("已存入：" + r.data.path, 4000); render(); }
        else toast("存入失败：" + (r.data?.detail || r.status), 5000);
        return;
      }
      case "saveframe": return saveFrame();
      case "dropframe": S.frameDraft = null; $(".draft").hidden = true; return;
    }
  });

  function seek(t) {
    const v = video();
    if (!v) return toast("页面上没找到播放器");
    v.currentTime = t;
    v.play().catch(() => {});
  }

  root.addEventListener("submit", (e) => {
    e.preventDefault();
    const ta = $(".ask textarea");
    if (ta.value.trim()) ask(ta.value.trim());
  });
  root.addEventListener("keydown", (e) => {
    // 别让按键冒泡到 Udemy（空格会暂停视频、方向键会快进）
    if (e.target.matches("textarea,input")) {
      e.stopPropagation();
      if (e.target.closest(".ask") && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        $(".ask").requestSubmit();
      }
    }
  }, true);

  let noteTimer;
  root.addEventListener("input", (e) => {
    if (!e.target.classList.contains("note")) return;
    $("#ns").textContent = "编辑中…";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(saveNotes, 800);
  });
  async function saveNotes() {
    const ta = $(".note");
    if (!ta || !S.clip) return;
    S.clip.notes = ta.value;
    const r = await kld("PUT", `/api/clips/${S.clip.id}/notes`, { notes: S.clip.notes });
    const ns = $("#ns");
    if (ns) ns.textContent = r.ok ? "已保存" : "保存失败";
  }
  async function addNote(text) {
    S.clip.notes = (S.clip.notes?.trim() ? S.clip.notes.trimEnd() + "\n\n" : "") + text.trim();
    await kld("PUT", `/api/clips/${S.clip.id}/notes`, { notes: S.clip.notes });
    toast("已加入笔记");
  }

  root.addEventListener("paste", (e) => {
    if (!S.clip) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      const k = Math.min(1, 1920 / img.width);
      cv.width = img.width * k; cv.height = img.height * k;
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      S.frameDraft = { time: video()?.currentTime || 0, image: cv.toDataURL("image/jpeg", 0.9) };
      const d = $(".draft");
      d.hidden = false;
      d.querySelector("img").src = S.frameDraft.image;
      d.querySelector("input").value = "";
      d.querySelector("input").placeholder = `${fmt(S.frameDraft.time)} · 这帧为什么重要？`;
      d.querySelector("input").focus();
    };
    img.src = URL.createObjectURL(item.getAsFile());
  });
  async function saveFrame() {
    if (!S.frameDraft) return;
    const r = await kld("POST", `/api/clips/${S.clip.id}/frames`, { ...S.frameDraft, caption: $(".draft input").value.trim() });
    if (!r.ok) return toast("保存失败：" + (r.data?.detail || r.status));
    S.clip.frames.push(r.data);
    S.clip.frames.sort((a, b) => a.time - b.time);
    S.frameDraft = null;
    renderNotes();
    toast("关键帧已保存");
  }

  function ask(q) {
    if (S.chatting || !S.clip) return;
    S.chatting = true;
    S.clip.chat.push({ role: "user", content: q });
    S.tab = "chat";
    render();
    const m = $(".msgs");
    m.insertAdjacentHTML("beforeend", `<div class="msg ai typing"></div>`);
    const out = m.lastElementChild;
    let text = "";
    const port = chrome.runtime.connect({ name: "chat" });
    port.onMessage.addListener((d) => {
      if (d.t) { text += d.t; out.innerHTML = md(text); m.scrollTop = m.scrollHeight; }
      if (d.error) { out.classList.remove("typing"); out.innerHTML = `<span class="err">出错了：${esc(d.error)}</span>`; S.clip.chat.pop(); finish(); }
      if (d.done) { S.clip.chat.push({ role: "assistant", content: text }); finish(); render(); }
    });
    function finish() { S.chatting = false; port.disconnect(); }
    port.postMessage({ clipId: S.clip.id, message: q, focusTopic: S.focus });
  }

  // ---------- 跟随播放 + 换课检测 ----------
  function cueAt(t) {
    const cues = S.clip.cues;
    let lo = 0, hi = cues.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  setInterval(() => {
    // Udemy 是单页应用：换课时网址变了但页面不刷新
    const pl = pageLecture();
    if ((pl?.id ?? null) !== S.lectureId) loadLecture();
    if (!S.open || !S.clip || S.tab !== "transcript") return;
    const v = video();
    if (!v) return;
    const i = cueAt(v.currentTime + 0.05);
    if (i === S.now) return;
    S.cueEls[S.now]?.classList.remove("now");
    S.now = i;
    const el = S.cueEls[i];
    if (!el) return;
    el.classList.add("now");
    if (!v.paused) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 400);

  chrome.runtime.onMessage.addListener((msg) => { if (msg.type === "toggle") setOpen(!S.open); });
  chrome.storage.local.get("sidebarOpen").then(({ sidebarOpen }) => setOpen(sidebarOpen !== false));
  loadLecture();

  function CSS() {
    return `
:host { all: initial; }
* { box-sizing: border-box; }
.panel { position: fixed; top: 0; right: 0; width: ${W}px; height: 100vh; z-index: 2147483000; display: flex; flex-direction: column;
  background: #fffdfa; color: #2b2522; border-left: 1px solid #ebe5dd; box-shadow: -6px 0 24px rgba(60,40,20,.12);
  font: 13.5px/1.65 -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; }
.panel[hidden] { display: none; }
.tab-open { position: fixed; right: 0; top: 40%; z-index: 2147483000; width: 30px; height: 44px; border: 0; border-radius: 10px 0 0 10px;
  background: #b5321f; color: #fff; font: 800 15px Georgia, serif; cursor: pointer; box-shadow: -2px 2px 10px rgba(0,0,0,.2); }
.tab-open[hidden] { display: none; }
button { font: inherit; cursor: pointer; }
header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #ebe5dd; }
.brand { display: flex; align-items: center; gap: 6px; font: 700 15px Georgia, serif; }
.logo { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; background: #b5321f; color: #fff; font-size: 13px; }
.acts { display: flex; gap: 4px; }
.ghost { background: none; border: 1px solid #ebe5dd; border-radius: 999px; padding: 2px 10px; color: #2b2522; }
.ghost:hover { background: #fbe9e4; }
.link { color: #b5321f; cursor: pointer; text-decoration: underline; }
.btn { background: #b5321f; color: #fff; border: 0; border-radius: 999px; padding: 5px 14px; font-weight: 600; margin-top: 10px; }
.meta { padding: 8px 12px 0; display: flex; flex-direction: column; }
.meta span { color: #8d837b; font-size: 12px; }
nav { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid #ebe5dd; }
nav button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 6px 8px; color: #8d837b; font-weight: 600; }
nav button.on { color: #2b2522; border-color: #b5321f; }
.body { flex: 1; overflow-y: auto; padding: 10px 12px; min-height: 0; }
.empty { text-align: center; color: #8d837b; padding: 40px 10px; }
.err { color: #b5321f; }
.hint { color: #8d837b; font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
.chip { border: 1px solid var(--b, #ebe5dd); background: var(--bg, #fff); border-radius: 999px; padding: 1px 9px; font-size: 12px; color: #2b2522; }
.chip.on { outline: 2px solid var(--b, #b5321f); outline-offset: 1px; }
.c0 { --b: #c9503b; --bg: #fbe4de; } .c1 { --b: #4f9a63; --bg: #e3f1e6; } .c2 { --b: #c09232; --bg: #fbf1d9; }
.c3 { --b: #5479b0; --bg: #e2ebf7; } .c4 { --b: #8a5ba8; --bg: #efe4f5; }
.topic { border-left: 3px solid var(--b); background: var(--bg); border-radius: 0 8px 8px 0; padding: 2px 10px 6px; margin-bottom: 10px; }
.topic h4 { margin: 6px 0 2px; font-size: 13.5px; display: flex; gap: 6px; align-items: center; }
.topic h4 span { display: inline-grid; place-items: center; min-width: 18px; height: 18px; border-radius: 4px; background: #fff; color: var(--b); font-size: 11px; }
.para { display: grid; grid-template-columns: 38px 1fr; gap: 4px; margin: 6px 0; }
.ts, .tl { color: #8d837b; font-size: 11.5px; cursor: pointer; font-variant-numeric: tabular-nums; }
.tl { color: #b5321f; text-decoration: underline dotted; font-size: inherit; }
.ts:hover { color: #b5321f; }
.cue { cursor: pointer; border-radius: 3px; }
.cue:hover { background: #fff3b080; }
.cue.now { background: #fff3b0; }
.chat { display: flex; flex-direction: column; height: 100%; }
.msgs { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; min-height: 120px; }
.msg { padding: 8px 11px; border-radius: 10px; max-width: 94%; }
.msg.user { align-self: flex-end; background: #fbe9e4; white-space: pre-wrap; }
.msg.ai { align-self: flex-start; background: #f6f3ef; border: 1px solid #ebe5dd; }
.msg p, .msg ul, .msg h4 { margin: 4px 0; } .msg ul { padding-left: 18px; }
.msg pre { background: #fff; padding: 6px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; font-size: 12px; }
.msg code { background: #fff; padding: 0 4px; border-radius: 3px; font-size: 12px; }
.ops button { background: none; border: 0; color: #8d837b; font-size: 12px; padding: 0; margin-top: 4px; }
.ops button:hover { color: #b5321f; }
.typing::after { content: "▍"; animation: b 1s steps(2) infinite; } @keyframes b { 50% { opacity: 0; } }
.quick { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 6px; }
.quick button { border: 1px solid #ebe5dd; background: #fff; border-radius: 999px; padding: 0 8px; font-size: 12px; color: #2b2522; }
.quick button:hover { border-color: #b5321f; color: #b5321f; }
.ask { display: flex; gap: 6px; align-items: flex-end; }
.ask .btn { margin: 0; }
textarea, input { font: inherit; color: inherit; width: 100%; border: 1px solid #ebe5dd; border-radius: 8px; padding: 6px 9px; background: #f6f3ef; outline: none; resize: vertical; }
textarea:focus, input:focus { border-color: #b5321f; }
.notes h5 { margin: 6px 0; font-size: 13px; display: flex; justify-content: space-between; }
.note { min-height: 140px; }
.paste { border: 1px dashed #c9b9aa; border-radius: 8px; padding: 10px; color: #8d837b; font-size: 12px; text-align: center; outline: none; }
.paste:focus { border-color: #b5321f; background: #fbe9e4; }
.draft { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
.draft[hidden] { display: none; }
.draft img { width: 100%; border-radius: 6px; }
.draft .btn { margin: 0; }
.frames { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.frame { border: 1px solid #ebe5dd; border-radius: 8px; overflow: hidden; font-size: 12px; background: #f6f3ef; }
.frame img { width: 100%; aspect-ratio: 16/10; object-fit: cover; display: block; background: #ddd; }
.frame div { padding: 4px 6px; }
.toast { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); background: #2b2522; color: #fff; padding: 6px 14px; border-radius: 999px;
  font-size: 12px; opacity: 0; transition: .2s; pointer-events: none; max-width: 90%; }
.toast.show { opacity: 1; }`;
  }
})();
