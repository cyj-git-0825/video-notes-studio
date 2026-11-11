// 设置存在 chrome.storage.local：只在这台电脑的这个 Chrome 里，不会同步到别处。
const DEFAULTS = {
  claudeKey: "",
  model: "claude-opus-5-5",
  ghRepo: "",
  ghBranch: "main",
  ghToken: "",
  folder: "视频笔记",
  autosync: true,
};

export async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

export async function saveSettings(patch) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([k, v]) => k in DEFAULTS && v !== undefined));
  await chrome.storage.local.set(clean);
  return getSettings();
}

export const hint = (secret) => (secret ? `…${secret.slice(-4)}` : "");
