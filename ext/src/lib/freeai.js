// 免费模型：走 OpenAI 兼容的 /chat/completions 接口，Gemini、Groq、OpenRouter、本地 Ollama 都支持。
// Key 和 Claude 的一样，只存在这台电脑的 chrome.storage 里，请求只发往你选的服务商。
import { getSettings } from "./settings.js";

export const PRESETS = {
  gemini: {
    name: "Google Gemini（免费额度，推荐）",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    note: "上下文很长，一整节课的逐字稿一次放得下。免费额度下 Google 可能用你的数据改进模型。",
  },
  groq: {
    name: "Groq（免费额度，速度快）",
    base: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    keyUrl: "https://console.groq.com/keys",
    note: "免费额度每分钟的 token 数有限，太长的逐字稿可能被拒。",
  },
  openrouter: {
    name: "OpenRouter（:free 模型）",
    base: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat-v3-0324:free",
    keyUrl: "https://openrouter.ai/keys",
    note: "免费模型每天有次数限制，可用的模型会变，点「测试」看当前列表。",
  },
  ollama: {
    name: "Ollama（本机运行，完全免费）",
    base: "http://localhost:11434/v1",
    model: "qwen2.5:7b",
    keyUrl: "",
    note: "需要先装 Ollama 并拉取模型，并设置环境变量 OLLAMA_ORIGINS=chrome-extension://* 后重启 Ollama。默认上下文较短，长逐字稿建议调大 num_ctx。",
  },
  custom: { name: "其他 OpenAI 兼容接口", base: "", model: "", keyUrl: "", note: "" },
};

export async function freeConfig() {
  const s = await getSettings();
  if (!s.freeProvider) return null;
  const p = PRESETS[s.freeProvider] || PRESETS.custom;
  const base = (s.freeBase || p.base).replace(/\/+$/, "");
  const model = s.freeModel || p.model;
  if (!base || !model) return null;
  return { provider: s.freeProvider, base, model, key: s.freeKey };
}

const headers = (cfg) => ({ "Content-Type": "application/json", ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) });

async function fail(r) {
  let msg = "";
  try { const d = await r.json(); msg = d.error?.message || d.message || JSON.stringify(d); } catch { msg = await r.text().catch(() => ""); }
  if (r.status === 401 || r.status === 403) return new Error(`免费模型的 Key 无效或没有权限（${r.status}）`);
  if (r.status === 429) return new Error("免费额度用完了或请求太频繁，稍后再试（429）");
  return new Error(`免费模型返回 ${r.status}：${msg.slice(0, 200)}`);
}

export async function complete(cfg, messages) {
  let r;
  try {
    r = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST", headers: headers(cfg),
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3 }),
    });
  } catch (e) {
    throw new Error(cfg.provider === "ollama" ? "连不上本机 Ollama：确认它在运行，并设置了 OLLAMA_ORIGINS" : `连不上免费模型：${e.message}`);
  }
  if (!r.ok) throw await fail(r);
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content;
  if (!text) throw new Error("免费模型没有返回内容");
  return text;
}

/** 列出可用模型，同时验证地址和 Key */
export async function listModels(cfg) {
  let r;
  try { r = await fetch(`${cfg.base}/models`, { headers: headers(cfg) }); }
  catch (e) { throw new Error(cfg.provider === "ollama" ? "连不上本机 Ollama：确认它在运行，并设置了 OLLAMA_ORIGINS" : `连不上：${e.message}`); }
  if (!r.ok) throw await fail(r);
  const d = await r.json();
  return (d.data || []).map((m) => String(m.id).replace(/^models\//, ""));
}
