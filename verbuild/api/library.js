// /api/library —— 收藏夹与播放记录。
//
// 原 Go 版把收藏/记录存在本地数据目录（library.json）。Vercel 没有文件系统，
// 也没有默认开启的持久化存储，所以网页版改为由前端 localStorage 保存
// （见 public/app.js 里的 store 模块），每个浏览器各自独立、零配置。
//
// 这里保留同形状的端点，避免旧页面或直接调用时报 404：
//   GET  /api/library          返回空结构
//   POST /api/library          接受写入但直接回空结构（真正生效的是前端本地存储）

import { jsonResponse, withHandler } from '../lib/util.js';

const EMPTY = { history: [], favorites: [] };

export default withHandler(async (req, res) => {
  if (req.method === 'POST') {
    jsonResponse(res, { ok: true, data: EMPTY });
    return;
  }
  jsonResponse(res, { ok: true, data: EMPTY });
});