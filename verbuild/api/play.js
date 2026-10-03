// POST /api/play —— 播放地址解析。
// 对应原 Go 版 handlePlay：解析出直链后交给前端 <video>/hls.js 播放，
// 跨域资源统一走 /api/media 同源代理。

import { fail, ok, readJSON, withHandler } from '../lib/util.js';
import { getSource } from '../lib/sources.js';

function uniq(values) {
  return Array.from(new Set(values));
}

// 把上游媒体地址包成同源代理路径。
function proxyURL(url, referer) {
  const query = new URLSearchParams({ u: url });
  if (referer) {
    query.set('r', referer);
  }
  return '/api/media?' + query.toString();
}

export default withHandler(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let input;
  try {
    input = await readJSON(req);
  } catch (error) {
    fail(res, '请求不是合法 JSON');
    return;
  }

  const drama = input.drama && typeof input.drama === 'object' ? input.drama : {};
  const chapter = input.chapter && typeof input.chapter === 'object' ? input.chapter : {};
  const dramaID = String(drama.id || input.id || '');
  const index = Number(input.index) || 0;
  const route = Math.max(0, Number(input.route) || 0);
  const sourceID = String(drama.source || (dramaID.includes(':') ? dramaID.split(':')[0] : ''));

  const source = getSource(sourceID);
  if (!source) {
    fail(res, '当前网页版不包含此站源' + (sourceID ? '（' + sourceID + '）' : ''));
    return;
  }

  try {
    const plan = await source.resolveMedia({ dramaId: dramaID, chapter, index });
    const variants = Array.isArray(plan.variants) ? plan.variants : [];
    const requested = variants[route] || variants[0];
    if (!requested) {
      fail(res, '没有可用的播放线路');
      return;
    }
    const proxied = variants.map((item) => ({
      url: proxyURL(item.url, item.referer || plan.referer || ''),
      quality: item.quality || 0,
    }));
    const selected = proxied[route] || proxied[0];
    ok(res, {
      url: selected.url,
      quality: selected.quality,
      qualities: uniq(proxied.map((item) => item.quality).filter((value) => value > 0)).sort((a, b) => b - a),
      routeIndex: variants[route] ? route : 0,
      routeCount: proxied.length,
      encrypted: false,
      hevc: false,
      ffmpeg: false,
      mode: 'direct',
    });
  } catch (error) {
    fail(res, error && error.message ? error.message : '解析播放地址失败');
  }
});