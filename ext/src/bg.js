// 后台 service worker：替 Udemy 侧边栏执行 KLD 的操作（存储、AI、同步），并转发字幕下载。
import { chat, request, syncPending } from "./lib/api.js";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// 小红书对电脑浏览器会跳登录页：只对“插件自己发出的”小红书请求改用手机 UA，不影响你平时浏览。
// Chrome 还会带上 sec-ch-ua-*（声明自己是 Windows 桌面版），和手机 UA 矛盾会被要求验证，一并去掉
async function installRules() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "user-agent", operation: "set", value: MOBILE_UA },
          { header: "sec-ch-ua", operation: "remove" },
          { header: "sec-ch-ua-mobile", operation: "remove" },
          { header: "sec-ch-ua-platform", operation: "remove" },
        ],
      },
      condition: {
        requestDomains: ["xiaohongshu.com", "xhslink.cn", "xhslink.com"],
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ["xmlhttprequest"],
      },
    }],
  });
}
chrome.runtime.onInstalled.addListener(installRules);
chrome.runtime.onStartup.addListener(() => { installRules(); syncPending(); });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "kld") {
    request(msg.method, msg.path, msg.body).then(reply);
    return true;
  }
  if (msg.type === "text") {
    // Udemy 字幕文件在 udemycdn 上，链接自带签名
    fetch(msg.url, { credentials: "omit" })
      .then(async (r) => reply({ ok: r.ok, text: await r.text() }))
      .catch((e) => reply({ ok: false, text: e.message }));
    return true;
  }
  if (msg.type === "config") {
    request("GET", "/api/settings").then((r) => reply({ configured: true, ...r.data }));
    return true;
  }
  if (msg.type === "options") chrome.runtime.openOptionsPage();
  if (msg.type === "openapp") chrome.tabs.create({ url: chrome.runtime.getURL(`app.html${msg.hash || ""}`) });
});

// AI 追问是流式输出：用长连接把一段段文字转发给侧边栏
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat") return;
  port.onMessage.addListener(async ({ clipId, message, focusTopic }) => {
    try {
      await chat(clipId, message, focusTopic, (t) => port.postMessage({ t }));
      port.postMessage({ done: true });
    } catch (e) {
      port.postMessage({ error: e.message });
    }
  });
});

// 点插件图标：在 Udemy 课时页面上显示 / 隐藏侧边栏；其他页面打开 KLD 学习台
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" });
  } catch {
    chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
  }
});
