import Anthropic from "@anthropic-ai/sdk";
import { getSettings, hint, saveSettings } from "./lib/settings.js";
import { testConnection } from "./lib/github.js";
import { freeConfig, listModels, PRESETS } from "./lib/freeai.js";

const $ = (id) => document.getElementById(id);
const say = (id, text, ok) => { $(id).textContent = text; $(id).className = "msg " + (ok ? "ok" : "err"); };

for (const [k, p] of Object.entries(PRESETS)) $("freeProvider").add(new Option(p.name, k));

// 切换服务商：显示对应说明；地址和模型换成该服务商的默认值
function showProvider(k, { reset = false } = {}) {
  const p = PRESETS[k];
  $("freeFields").hidden = !p;
  if (!p) return;
  $("freeNote").textContent = p.note;
  $("freeKeyUrl").hidden = !p.keyUrl;
  $("freeKeyUrl").href = p.keyUrl || "#";
  $("freeBase").placeholder = p.base || "https://…/v1";
  $("freeModel").placeholder = p.model || "模型名";
  if (reset) { $("freeBase").value = p.base; $("freeModel").value = p.model; }
}
$("freeProvider").addEventListener("change", (e) => {
  showProvider(e.target.value, { reset: true });
  $("freeModels").innerHTML = "";
  say("freeMsg", "", true);
});

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
  $("freeProvider").value = s.freeProvider;
  showProvider(s.freeProvider);
  $("freeBase").value = s.freeBase || PRESETS[s.freeProvider]?.base || "";
  $("freeModel").value = s.freeModel || PRESETS[s.freeProvider]?.model || "";
  $("freeKey").value = "";
  $("freeHint").textContent = s.freeKey ? `（已配置 ${hint(s.freeKey)}）` : "";
}

async function save() {
  const patch = {
    model: $("model").value.trim() || "claude-opus-5-5",
    ghRepo: $("ghRepo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/$/g, ""),
    ghBranch: $("ghBranch").value.trim() || "main",
    folder: $("folder").value.trim() || "视频笔记",
    autosync: $("autosync").checked,
    freeProvider: $("freeProvider").value,
    freeBase: $("freeBase").value.trim(),
    freeModel: $("freeModel").value.trim(),
  };
  // 换了服务商，旧的 Key 不再适用
  const prev = (await getSettings()).freeProvider;
  if (patch.freeProvider !== prev) patch.freeKey = "";
  if ($("freeKey").value.trim()) patch.freeKey = $("freeKey").value.trim();
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

$("testFree").addEventListener("click", async () => {
  await save();
  const cfg = await freeConfig();
  if (!cfg) return say("freeMsg", "先选服务商，并填好接口地址和模型");
  if (!cfg.key && cfg.provider !== "ollama") return say("freeMsg", "还没填 API Key");
  say("freeMsg", "测试中…", true);
  try {
    // 列模型：不消耗额度，能同时验证地址、Key 和模型名
    const models = await listModels(cfg);
    $("freeModels").innerHTML = models.map((m) => `<option value="${m.replace(/"/g, "&quot;")}">`).join("");
    if (!models.length || models.includes(cfg.model)) say("freeMsg", `可以使用 ✓（${cfg.model}）`, true);
    else say("freeMsg", `连接成功，但没有模型「${cfg.model}」。点模型输入框可以从 ${models.length} 个可用模型里选。`);
  } catch (e) {
    say("freeMsg", e.message);
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
