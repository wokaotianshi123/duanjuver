// GET /api/cover?id=<剧集 id>&source=<源>&u=<海报地址> —— 封面同源代理。
//
// 上游海报地址是跨域的，浏览器 <img> 加载会受 Referer 防盗链限制。
// 这里做薄代理：拿到上游图片后原样回传，并附上长缓存。
//
// 关键：不同图床对 Referer 的校验不同。实测豆瓣图床（doubanio.com）
//   无 Referer        -> HTTP 418
//   Referer=ikanbot   -> HTTP 403
//   Referer=豆瓣自己   -> HTTP 200
// 所以这里按宿主自己匹配 Referer，而不是统一透传站源页面的 Referer。
//
// 与原 Go 版不同，Vercel 没有文件系统与 HEIC 解码器，因此不做 HEIC 转码——
// ikanbot 的海报本身是 jpg/png，不涉及 HEIC。

import { pipeBody, withHandler } from '../lib/util.js';

const IMAGE_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=86400',
  'Access-Control-Allow-Origin': '*',
};

// 按图床宿主给出合适的 Referer；未命中时回退到站源自身。
const REFERER_BY_HOST = [
  { match: /(^|\.)doubanio\.com$/i, referer: 'https://movie.douban.com/' },
  { match: /(^|\.)douban\.com$/i, referer: 'https://movie.douban.com/' },
  { match: /(^|\.)ikanbot\.com$/i, referer: 'https://www1.ikanbot.com/' },
];

function refererFor(target) {
  try {
    const host = new URL(target).hostname;
    for (const rule of REFERER_BY_HOST) {
      if (rule.match.test(host)) {
        return rule.referer;
      }
    }
    return 'https://' + host + '/';
  } catch (error) {
    return '';
  }
}

export default withHandler(async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const target = url.searchParams.get('u');
  if (!target || !/^https?:\/\//i.test(target)) {
    res.status(400).json({ ok: false, error: '缺少海报地址' });
    return;
  }

  const referer = url.searchParams.get('r') || refererFor(target);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
        Referer: referer,
      },
    });
  } catch (error) {
    // 拿不到图片时回一个 1x1 透明图，避免页面出现破图占位。
    transparentGIF(res);
    return;
  }
  if (!upstream.ok || !upstream.body) {
    transparentGIF(res);
    return;
  }
  res.status(200);
  for (const [key, value] of Object.entries(IMAGE_CACHE_HEADERS)) {
    res.setHeader(key, value);
  }
  const contentType = upstream.headers.get('content-type');
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) {
    res.setHeader('Content-Length', contentLength);
  }
  await pipeBody(upstream, res);
});

// 1x1 透明 GIF 的最小字节序列。
const TRANSPARENT_GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

function transparentGIF(res) {
  res.status(200);
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(Buffer.from(TRANSPARENT_GIF));
}