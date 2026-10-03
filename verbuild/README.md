# 短剧视界 · 网页版（Vercel）

这是把原项目的**本地 Web 服务版**抽出来、改造为可部署到 **Vercel** 的工作空间。
上传本目录到 GitHub，在 Vercel 里连接仓库即可完成部署，得到一个可通过 Vercel 域名访问的在线站点。

原 `guoapp3-main` 项目**未做任何改动**，本目录是独立副本。

---

## 一、部署步骤（3 步）

### 1. 上传到 GitHub

```bash
cd verbuild
git init
git add .
git commit -m "init: 短剧视界网页版"
git branch -M main
git remote add origin https://github.com/<你的账号>/<你的仓库>.git
git push -u origin main
```

### 2. 在 Vercel 创建项目

进入 [vercel.com](https://vercel.com) → **Import Git Repository**，选择刚才的仓库。
Vercel 会自动检测配置，若提示手动填写，按下表：

| 配置项 | 填写内容 |
|---|---|
| Framework（框架） | `None`（或「Other」） |
| Build Command（构建命令） | **留空** |
| Output Directory（输出目录） | `public` |
| Root Directory（根目录） | 留空（默认 `/`） |
| Node.js Version | 默认即可（22.x） |

> 本项目是「纯静态前端 + Serverless Functions」，**没有构建步骤**，所以构建命令留空即可。
> Functions 会自动从仓库根目录的 `api/` 读取，`package.json` 只声明 ESM 模式，无依赖。

### 3. 保存并部署

点 **Deploy**，约 1 分钟即可。之后访问 Vercel 分配的
`https://<项目名>.vercel.app` 就能打开站点。之后每次 `git push` 都会自动重新部署。

---

## 二、目录结构

```
verbuild/
├── public/                 # 静态站点（输出目录）
│   ├── index.html          # 页面骨架
│   ├── app.js              # 前端逻辑（含播放器、收藏夹）
│   ├── app.css             # 样式
│   └── hls.min.js          # HLS 播放支持
├── api/                    # Vercel Serverless Functions（每个文件 = 一个 /api/* 路由）
│   ├── request.js          # POST /api/request（目录 / 分类 / 详情）
│   ├── play.js             # POST /api/play（播放解析）
│   ├── media.js            # GET  /api/media（媒体同源代理）
│   ├── cover.js            # GET  /api/cover（封面同源代理）
│   ├── sources.js          # GET  /api/sources（站源列表）
│   ├── info.js             # GET  /api/info（站点信息）
│   └── library.js          # GET/POST /api/library（兼容占位）
├── lib/                    # 共享代码（不在 api/ 下，不会注册成路由）
│   ├── util.js             # 抓取 / 文本清洗 / JSON 响应 / 流式管道
│   ├── sources.js          # 站源注册表
│   ├── ikanbot.js          # 爱看机器人站源实现
│   ├── fanguo.js           # 饭果站源
│   ├── xingguo.js          # 星果站源
│   ├── niuguo.js           # 牛果站源（AES-128-ECB 解密）
│   ├── huaguo.js           # 花果站源（maccms 模板）
│   ├── faguo.js            # 发果站源（maccms 模板）
│   ├── wuguo.js            # 伍果站源（maccms 模板）
│   ├── wangguo.js          # 网果站源（maccms 模板）
│   ├── maccms.js           # maccms 共享解析引擎（花果/发果/伍果/网果共用）
│   ├── duanju-helpers.js   # 短剧家族共享 helper（JSON 查找、封面、分集序号等）
│   └── html-parser.js      # HTML 解析工具（node-html-parser 封装）
├── vercel.json             # Vercel 配置（框架=无、输出目录、安全头）
├── package.json            # 仅声明 ESM 模式，无依赖
└── README.md
```

---

## 三、重要限制（请务必先读）

原版后端是 **28565 行 Go 代码**，而 Vercel 的 Serverless Functions 运行在
**Node.js（V8 + libuv，只能跑 JavaScript）**，两者能力边界差异很大：

| 原版依赖的能力 | Vercel 是否支持 |
|---|---|
| Go 语言与 Go 模块 | ❌ 不支持，只能 JS/TS |
| 文件系统（数据目录、封面缓存） | ❌ 没有 |
| ffmpeg 转码 | ❌ 没有 |
| TLS 指纹伪装（tls-client / utls） | ❌ 没有 |
| `fetch` 抓取网页、解析 HTML/JSON | ✅ 支持 |
| 返回响应、做同源代理 | ✅ 支持 |

因此**不可能把 Go 后端 1:1 搬上来**。本工作空间的做法是：
把能纯用 `fetch + 正则` 复刻的站源，用 JavaScript 重写为 Serverless Functions。

### 当前支持哪些站源

从 guoapp 项目本地 web 服务移植时，尽可能多移植了站源。当前共 **8 个**可用的站源：

| 站源 | ID | 类型 | 实测可达 |
|---|---|---|---|
| 爱看机器人 | `ikanbot` | HTTPS + 正则 + 签名 | ✅ |
| 饭果 | `fanguo` | HTTPS JSON API | ✅ |
| 星果 | `xingguo` | HTTPS JSON API（硬编码 token） | ✅ |
| 牛果 | `niuguo` | HTTPS + AES-128-ECB 解密 | ✅ |
| 网果 | `wangguo` | HTTPS + HTML（maccms 模板） | ✅ |
| 花果 | `huaguo` | HTTPS + HTML（maccms 模板） | ⚠️ 暂不可达 |
| 发果 | `faguo` | HTTPS + HTML（maccms 模板） | ⚠️ 暂不可达 |
| 伍果 | `wuguo` | HTTPS + HTML（maccms 模板） | ⚠️ 暂不可达 |

全部满足：纯 HTTPS 抓取、**不需要 TLS 指纹伪装**、返回直链 m3u8、**不需要 ffmpeg**。

### 哪些站源跑不了

以下站源在 Vercel 上不可用，原因分两类：

1. **加密流 / HEVC**：必须服务端 ffmpeg 解密重编码，Vercel 没有 ffmpeg
   （黄果、黄果视频、黄果AI、云front、帝果等）；
2. **风控 / TLS 指纹**：需要伪装 Chrome TLS 指纹（tls-client/utls）才能访问
   （红果、野果、猫果、皮果、合果等）；
3. **登录态 / 特殊协议**：需要 session 或非 HTTP 协议
   （汉小圈、黄豆、撒拉尼、鬼片等）。

这些源在网页版里会返回「当前网页版不包含此站源」。

---

## 四、与原版的差异

| 项目 | 原本地服务版 | 本网页版 |
|---|---|---|
| 后端语言 | Go（本机进程） | JavaScript（Vercel Functions） |
| 站源数量 | 24 个 | 8 个（爱看机器人 + 7 个短剧家族） |
| 播放记录 / 收藏夹 | 存本机数据目录 `library.json` | 存**浏览器 localStorage**（每台设备独立） |
| 封面缓存 | 本机磁盘 + HEIC 转码 | 内存直传代理（不落盘） |
| 转码 | ffmpeg 转 HLS | 无（全部直链） |
| 访问范围 | 本机 / 局域网 | 公网（Vercel 域名） |

前端绝大部分逻辑（播放器、多线路切换、分集、倍速与全屏保持、自动连播）
与原版一致，可参考原项目 `native/server/web/app.js`。

---

## 五、本地预览（可选）

若装了 Node.js 与 Vercel CLI：

```bash
npm i -g vercel
vercel dev
```

会启动一个本地服务器，`.vercel.app` 的同一套 Functions 会在本地跑起来。
（`vercel dev` 会自动读取 `vercel.json` 与 `api/` 目录。）

---

## 六、如何扩展站源

若要增加新的站源，只需两步：

1. 在 `lib/` 下新增一个模块，导出 `SOURCE_ID`、`SOURCE_NAME`、`CATEGORIES`，
   以及 `fetchCatalogPage`、`fetchDetail`、`resolveMedia` 三个函数
   （可参照 `fanguo.js` / `xingguo.js` / `niuguo.js` 等纯 API 源，
   或 `huaguo.js` / `wangguo.js` 等 maccms 模板源）；
2. 在 `lib/sources.js` 的 `REGISTRY` 数组里注册这个模块。

注意：能否迁移取决于该源是否依赖 ffmpeg 或 TLS 指纹（见上文限制）。

---

## 七、技术备注：与 Cloudflare 版的差异

本目录是同一套代码的 Vercel 移植，与 `cfbuild`（Cloudflare Pages 版）的差异仅在部署层：

| | Cloudflare Pages | Vercel |
|---|---|---|
| 函数目录 | `functions/api/*.js` | `api/*.js` |
| 函数签名 | `onRequestGet/Post(context)` | `export default handler(req, res)` |
| 配置文件 | `wrangler.toml` + `_routes.json` | `vercel.json` + `package.json` |
| 安全头 | `_middleware.js` | `vercel.json` 的 `headers` |
| 共享库 | `functions/_lib/` | `lib/` |

业务逻辑（ikanbot 抓取、签名算法、m3u8 改写、封面 Referer 适配、localStorage 收藏夹）
两版完全一致。Vercel 版额外包含短剧家族站源（饭果/星果/牛果/花果/发果/伍果/网果）
的 JS 移植，以及 maccms 共享 HTML 解析引擎。

---

## 八、免责声明

本站源内容来自第三方公开站点，本项目仅做技术演示与个人学习用途，
不存储任何视频内容，请勿用于商业用途。