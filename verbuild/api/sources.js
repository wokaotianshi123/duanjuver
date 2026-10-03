// GET /api/sources —— 可用站源列表。
// 对应原 Go 版 handleSources：逐个探测源可用性，这里直接返回注册表。

import { jsonResponse, withHandler } from '../lib/util.js';
import { allSources } from '../lib/sources.js';

export default withHandler(async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  jsonResponse(res, { items: allSources() });
});