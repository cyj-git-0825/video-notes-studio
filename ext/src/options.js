import Anthropic from "@anthropic-ai/sdk";
import { getSettings, hint, saveSettings } from "./lib/settings.js";
import { testConnection } from "./lib/github.js";

const $ = (id) => document.getElementById(id);
const say = (id, text, ok) => { $(id).textContent = text; $(id).className = "msg " + (ok ? "ok" : "err"); };

async function fill() {
  const s = await getSettings();
  $("claudeKey").value = "";
  $("keyHint").textContent = s.claudeKey ? `（已配置 ${hint(s.claudeKey)}）` : "（未配置）";
  $("model").value = s.model;
  $("ghRepo").value = s.ghRepo;
  $("ghBranch").value = s.ghBranch;
  $("ghToken").value = "";
  $("ghHint").textContent = s.ghToken ? `（已配置 ${hint(s.ghToken)}）` : "（未配置）";
  $("folder").value = s.folder;
  $("autosync").checked = s.autosync;
}

async function save() {
  const patch = {
    model: $("model").value.trim() || "claude-opus-5-5",
    ghRepo: $("ghRepo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/$/g, ""),
    ghBranch: $("ghBranch").value.trim() || "main",
    folder: $("folder").value.trim() || "视频笔记",
    autosync: $("autosync").checked,
  };
  if ($("claudeKey").value.trim()) patch.claudeKey = $("claudeKey").value.trim();
  if ($("ghToken").value.trim()) patch.ghToken = $("ghToken").value.trim();
  await saveSettings(patch);
  await fill();
}

$("save").addEventListener("click", async () => {
  await save();
  say("saveMsg", "已保存", true);
});

$("testClaude").addEventListener("click", async () => {
  await save();
  const s = await getSettings();
  if (!s.claudeKey) return say("claudeMsg", "还没填 API Key");
  say("claudeMsg", "测试中…", true);
  try {
    // 查询模型信息：不产生费用，能同时验证 Key 和模型名
    const c = new Anthropic({ apiKey: s.claudeKey, dangerouslyAllowBrowser: true });
    const m = await c.models.retrieve(s.model);
    say("claudeMsg", `可以使用 ✓（${m.display_name}）`, true);
  } catch (e) {
    say("claudeMsg", e.status === 401 ? "API Key 无效" : e.status === 404 ? `没有这个模型：${s.model}` : `失败：${e.message}`);
  }
});

$("testGh").addEventListener("click", async () => {
  await save();
  say("ghMsg", "测试中…", true);
  try {
    const r = await testConnection();
    say("ghMsg", `连接成功 ✓ ${r.name}${r.private ? "" : "（注意：这是公开仓库，笔记所有人都能看到）"}`, true);
  } catch (e) {
    say("ghMsg", e.message);
  }
});

fill();
