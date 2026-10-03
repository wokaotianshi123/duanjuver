// POST /api/request —— 目录、分类、详情等通用请求入口。
// 对应原 Go 版 handleRequest + core.NativeRequest 的 catalog / categories / detail 分支。
//
// Vercel 版与 Cloudflare 版的差异：请求是 Node 的 req，响应是 res，
// 工具函数全部把 res 作为参数显式传入。

import { cleanText, fail, ok, readJSON, withHandler } from '../lib/util.js';
import { allSources, getSource } from '../lib/sources.js';

function sanitizeDrama(raw) {
  const drama = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(drama.id || ''),
    source: String(drama.source || ''),
    title: cleanText(drama.title || ''),
    cover: String(drama.cover || ''),
  };
}

function sourceOf(input, drama) {
  const direct = String((input && input.source) || '').trim();
  if (direct) {
    return direct;
  }
  const id = String((drama && drama.id) || '');
  if (id.includes(':')) {
    return id.split(':')[0];
  }
  return '';
}

export default withHandler(async (req, res) => {
  if (req.method !== 'POST') {
    // GET 用于自检，列出可用站源。
    if (req.method === 'GET') {
      ok(res, { sources: allSources() });
      return;
    }
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
  const action = String(input.action || '');
  const drama = sanitizeDrama(input.drama);
  const sourceID = sourceOf(input, drama);

  try {
    if (action === 'categories') {
      const source = getSource(sourceID);
      if (!source) {
        fail(res, '当前网页版不包含此站源' + (sourceID ? '（' + sourceID + '）' : ''));
        return;
      }
      const items = (source.CATEGORIES || []).map((entry) => ({ id: entry.id, name: entry.name }));
      ok(res, { items });
      return;
    }

    if (action === 'catalog') {
      const source = getSource(sourceID);
      if (!source) {
        fail(res, '当前网页版不包含此站源' + (sourceID ? '（' + sourceID + '）' : ''));
        return;
      }
      const page = Number(input.page) || 1;
      const category = String(input.category || '');
      const query = String(input.query || '');
      const result = await source.fetchCatalogPage(page, category, query);
      ok(res, {
        items: result.items,
        hasMore: !!result.hasMore,
        page,
      });
      return;
    }

    if (action === 'detail') {
      const source = getSource(sourceID);
      if (!source) {
        fail(res, '当前网页版不包含此站源' + (sourceID ? '（' + sourceID + '）' : ''));
        return;
      }
      const id = String(drama.id || '');
      const parts = id.split(':');
      const providerID = parts[1] || '';
      const result = await source.fetchDetail(providerID);
      ok(res, result);
      return;
    }

    if (action === 'sourceStatus') {
      const source = getSource(sourceID);
      ok(res, { available: !!source });
      return;
    }

    fail(res, '不支持的请求类型' + (action ? '：' + action : ''));
  } catch (error) {
    fail(res, error && error.message ? error.message : '站源请求失败');
  }
});