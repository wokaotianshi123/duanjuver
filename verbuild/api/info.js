// GET /api/info —— 站点信息。
// 对应原 Go 版 handleInfo。网页版没有 ffmpeg / 数据目录，ffmpeg 字段固定为空，
// 前端据此提示「部分站源需要转码」——这里所有源都是直链，不会触发该提示。

import { jsonResponse, withHandler } from '../lib/util.js';

const DISPLAY_NAME = '短剧视界';

export default withHandler(async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  jsonResponse(res, {
    name: DISPLAY_NAME,
    slug: 'duanjushijie-web',
    version: 'web',
    port: 0,
    // 网页版（Vercel）标记：全部站源都是直链，不需要 ffmpeg 转码，
    // 前端据此跳过"未检测到 ffmpeg"的提示。
    web: true,
    ffmpeg: '',
  });
});