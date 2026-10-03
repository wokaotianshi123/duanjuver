# 短剧视界 / 全剧视界 · Vercel 部署版（web 服务版）

本目录是从桌面 `guoapp3-main`（Flutter 多端短剧应用）中抽取出来的**纯 web 服务版**，
已精简为只保留后端 Go 服务 + 内置网页播放器，可直接部署到 [Vercel](https://vercel.com)。

原项目（`guoapp3-main`）资源保持不变，本目录是一份独立的工作空间。

## 目录结构

```
verbuild2/
├── api/
│   └── index.go          # Vercel Go Serverless Function 入口（func Handler）
├── server/               # HTTP 服务（package server）
│   ├── server.go         # 路由、接口处理、初始化（由原 main.go 改造）
│   ├── library.go        # 收藏夹 / 播放记录
│   ├── transcode.go      # ffmpeg 转码（Vercel 上无 ffmpeg，自动降级）
│   ├── exec_other.go     # 非 Windows 平台适配
│   ├── exec_windows.go   # Windows 平台适配
│   └── web/              # 内置网页播放器（index.html / app.js / app.css / hls.min.js）
├── core/                 # 核心抓取/解析逻辑（package core，原项目 native/core）
├── go.mod / go.sum       # Go 模块（module duanjuapp/native）
├── vercel.json           # Vercel 配置：rewrite 全部请求到 /api，函数 60s/1024MB
└── .gitignore
```

## 部署步骤（GitHub → Vercel）

1. 把 `verbuild2` 整个目录上传 / 推送到一个 GitHub 仓库（仓库根目录就是 `verbuild2` 的内容）。
   - 可以直接把这个目录作为仓库根；也可以把它放进仓库子目录，部署时在 Vercel 指定根目录。
2. 打开 https://vercel.com ，用 GitHub 登录，点击 **Add New → Project**，选择该仓库。
3. Framework Preset 选 **Other / None**（本配置已写 `"framework": null`）。
4. 直接点击 **Deploy**。Vercel 会自动：
   - 读取根目录 `go.mod` 确定 Go 版本并下载依赖；
   - 把 `api/index.go` 编译成 Serverless Function；
   - 按 `vercel.json` 把 `/web/`、`/api/*` 等所有路径 rewrite 到该 Function。
5. 部署完成后，访问分配的域名（如 `xxx.vercel.app`），会自动跳转到 `/web/` 网页。

> 提示：如果你用 Vercel CLI，可在本目录执行 `npx vercel` 或 `npx vercel --prod`。

## 环境变量（可选）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EDITION_SLUG` | `duanjushijie` | 版本标识：短剧视界 / 全剧视界 |
| `APP_VERSION` | `vercel` | 显示在「关于」里 |
| `DATA_DIR` | `/tmp/<slug>-data` | 收藏夹/缓存目录（见下方限制） |

## 与本地版的差异 & Vercel 上的限制

Vercel 是 Serverless 环境，和本地常驻进程不同，以下功能会受影响：

1. **没有 ffmpeg**：红果等「加密 H.265」站源需要服务端 ffmpeg 解密转码才能在浏览器播放，
   Vercel 上不可用（其余站源不受影响，走直连播放）。页面「关于」里 `ffmpeg` 会显示为空。
2. **数据不持久**：收藏夹/播放记录写到 `DATA_DIR`（默认 `/tmp`）。Vercel 的函数文件系统是临时的，
   实例冷启动后会清空，所以收藏/历史**只在同一个运行实例内有效**，不能跨请求长期保存。
3. **函数超时 / 体积**：单请求最长 60s（Hobby 套餐可能被限制到 10s，超时请升级 Pro 或在 `vercel.json`
   把 `maxDuration` 调小），且函数有体积上限，重依赖（TLS 客户端等）会让冷启动偏慢。
4. **媒体代理**：部分站源在本机由核心起一个本地流服务再经 `/api/media/` 转发；Serverless 下跨请求
   无法保持该本地服务，这类站源可能无法播放（绝大多数站源是直连，不受影响）。

如果你需要 ffmpeg、持久化收藏、局域网访问等完整能力，仍应使用桌面端的本地服务版（`guoapp3-main`
里的 `build_web.py` 构建产物）。

## 本地测试

- 安装 Go 1.25+，在本目录执行 `CGO_ENABLED=0 go build ./...` 进行编译检查。
- 用 `npx vercel dev` 可本地模拟 Vercel 的路由与 Function 行为。
