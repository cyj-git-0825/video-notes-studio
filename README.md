# KLD 视频学习台

收藏的干货视频别再吃灰。KLD 是一个 Chrome 插件：粘贴一条小红书视频链接，或者打开一节 Udemy 课，它会取来逐字稿并按话题拆开。你边看边追问 AI、截关键帧、写笔记，学完的内容存进你的 Obsidian 知识库。

灵感来自两条小红书笔记：「是脆脆呀」的 LearnClip（视频学习工具），和「栗子的赛博畅想」的 Obsidian + AI 自生长知识库教程。

## 整体结构

不需要服务器，全部功能都在插件里：

```
Chrome 插件
 ├─ Udemy 课时页面：右侧 KLD 侧边栏（用你当前的登录状态读字幕，cookie 不离开浏览器）
 ├─ 学习台页面：小红书采集、视频库
 ├─ 直接调用 Claude API（话题切分、AI 追问）
 └─ 读写 GitHub 上的 Obsidian 仓库
        视频笔记/…md、视频笔记/attachments/*.jpg   给人看的笔记
        .kld/clips/<id>.json                       KLD 的学习数据（换电脑时从这里恢复）
                     ↓
       电脑和手机上的 Obsidian 用 Obsidian Git 拉取
```

学习时的改动先存在本机（插件的 IndexedDB），大约 1 分钟后自动提交到 GitHub；也可以随时点「存入 Obsidian」立即提交。

## 功能

| 功能 | 说明 |
| --- | --- |
| 小红书一键采集 | 支持 xhslink 短链、笔记链接、整段分享文案；逐字稿用小红书自带的字幕；视频直接从小红书在线播放，不下载 |
| Udemy 侧边栏 | 在课时页面点「导入这节课」；点一句字幕视频就跳过去，当前句自动高亮；换课时侧边栏跟着换 |
| 按话题拆分 | Claude 把逐字稿切成 3~10 个话题（英文课程的话题标题也用中文）；没配 Key 时按每 60 秒分段 |
| AI 追问 | AI 读过整份逐字稿、话题和关键帧，回答里带 `[mm:ss]` 时间点，点一下就跳过去 |
| 关键帧 | 小红书视频点「截当前帧」；Udemy 用 Win+Shift+S 截图后 Ctrl+V 粘贴，时间点自动取当前播放位置 |
| 我的笔记 | 自动保存；AI 回答点「加入笔记」会追加进来 |
| AI 整理笔记 | 点「✨ AI 整理笔记」，把逐字稿整理成结构化笔记（总结、分节要点、时间点）追加到笔记里；可以用免费模型（Gemini / Groq / OpenRouter / 本机 Ollama），没配就用 Claude |
| 存入 Obsidian | 小红书视频存为 `视频笔记/标题.md`，课程存为 `视频笔记/课程名/001 课时名.md`，关键帧放在 `attachments/` |

## 安装（一次性设置）

### 1. GitHub：准备 Obsidian 仓库

1. 新建一个**私有**仓库，例如 `obsidian-vault`，勾选 **Add a README**（仓库不能是空的）
2. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token
   - Repository access：只选这一个仓库
   - Permissions → Contents：**Read and write**

### 2. Obsidian：用这个仓库当知识库

1. 把仓库克隆到电脑上（`git clone` 或 GitHub Desktop），在 Obsidian 里「打开文件夹作为仓库」
2. 安装社区插件 **Obsidian Git**，打开定时拉取（Auto pull interval，例如 10 分钟）和启动时拉取
3. 手机上同样装 Obsidian 和 Obsidian Git，拉取同一个仓库

### 3. 安装插件

1. 打开 `chrome://extensions`，打开右上角的**开发者模式**
2. 点**加载已解压的扩展程序**，选择仓库里的 `extension` 文件夹
3. 插件会打开设置页（也可以右键插件图标 → 选项）：填 Claude API Key 和 GitHub 仓库、token，分别点「测试」确认，再保存
   - 想用免费模型整理笔记：在「免费模型」里选服务商。推荐 Google Gemini，去 [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 免费申请 Key

用法：
- **小红书**：点插件图标打开学习台，粘贴链接
- **Udemy**：打开任意一节课，右侧出现 KLD 侧边栏；点插件图标可以显示或隐藏侧边栏
- **换电脑**：装好插件、填好设置后，在学习台首页点「从仓库恢复视频库」

## 开发

插件源码在 `ext/`，用 esbuild 打包到 `extension/`（这个目录是生成的，不要直接改）：

```bash
cd ext
npm install
npm run build     # 或 npm run watch：改动后自动重新打包，再去 chrome://extensions 点刷新
```

```
ext/
  src/bg.js            后台：给侧边栏执行操作、小红书请求改用手机 UA
  src/content.js       Udemy 侧边栏（Shadow DOM，不受页面样式影响）
  src/app.js           学习台页面
  src/options.js       设置页
  src/lib/api.js       插件内的“后端”：视频库、采集、关键帧、对话、同步
  src/lib/github.js    GitHub 仓库读写（一次同步 = 一个 commit）
  src/lib/claude.js    Claude：话题切分（结构化输出）、流式追问
  src/lib/xhs.js       小红书笔记解析
  src/lib/store.js     本机工作副本（IndexedDB）
  static/              manifest.json、页面、样式
```

`backend/` 和 `web/` 是最早的本机 Python 版，现在只用来对照；不再需要运行。

## 已知限制

- Udemy 视频有 DRM，KLD 不下载也不解密，只读取字幕。插件读 Udemy 字幕的方式还没在真实账号上验证过。
- 小红书只支持有平台字幕的视频笔记；小红书改版后解析可能失效。
- Claude Key 和 GitHub token 存在这台电脑的 Chrome 里；换电脑需要重新填写。
- 内容仅供个人学习，请尊重作者版权。
