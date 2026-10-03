// 共享工具函数：JSON 响应、HTML 实体解码、文本清洗、截断、请求体读取。
//
// 与 Cloudflare 版的差异：运行在 Vercel Serverless Functions（Node 22），
// 请求是 Node 的 IncomingMessage，响应是 ServerResponse —— 不用 Request/Response，
// 而是用 res.status().json() / res.setHeader() 这套 Node 写法。

// 统一异常包装：把未捕获的异常转成 JSON 500，
// 避免 Vercel 默认返回 HTML 错误页导致前端 JSON.parse 失败。
export function withHandler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: (error && error.message) || '服务内部错误' });
      }
    }
  };
}

export function jsonResponse(res, body, status = 200, extraHeaders = {}) {
  resHeaders(res, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, extraHeaders);
  res.status(status).json(body);
}

// 供 jsonResponse 复用：把头写到一个已存在的 res 上。
function resHeaders(res, base, extra) {
  for (const [key, value] of Object.entries(base)) {
    res.setHeader(key, value);
  }
  for (const [key, value] of Object.entries(extra || {})) {
    res.setHeader(key, value);
  }
}

export function ok(res, data) {
  jsonResponse(res, { ok: true, data: data === undefined ? null : data });
}

export function fail(res, message, code) {
  const body = { ok: false, error: message || '请求失败' };
  if (code) {
    body.code = code;
  }
  jsonResponse(res, body);
}

const NAMED_ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

// 解码 HTML 实体（数字与常见命名实体）。
export function unescapeHTML(text) {
  return String(text == null ? '' : text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code) => {
    if (code.charAt(0) === '#') {
      const hex = code.charAt(1) === 'x' || code.charAt(1) === 'X';
      const value = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
        try {
          return String.fromCodePoint(value);
        } catch (error) {
          return match;
        }
      }
      return match;
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, code)) {
      return NAMED_ENTITIES[code];
    }
    return match;
  });
}

export function stripTags(text) {
  return String(text == null ? '' : text).replace(/<[^>]+>/g, '');
}

// 去标签、解实体、压缩空白。
export function cleanText(text) {
  if (!text) {
    return '';
  }
  let out = stripTags(text);
  out = unescapeHTML(out);
  out = out.replace(/\u3000/g, ' ');
  return out.split(/\s+/).filter(Boolean).join(' ');
}

export function truncate(text, limit) {
  const value = String(text == null ? '' : text).trim();
  const chars = Array.from(value);
  if (chars.length <= limit) {
    return value;
  }
  return chars.slice(0, limit).join('') + '...';
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    if (value != null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

// 读取 Node 请求体为字符串。Vercel 默认不解析 body，直接读流；
// 兼容某些中间件已把 body 解析到 req.body 的情况。
export async function readBody(req, limit = 1 << 20) {
  if (req.body) {
    if (typeof req.body === 'string') {
      if (req.body.length > limit) {
        throw new Error('请求体过大');
      }
      return req.body;
    }
    return JSON.stringify(req.body);
  }
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJSON(req, limit = 1 << 20) {
  const text = await readBody(req, limit);
  return JSON.parse(text);
}

// 带超时的抓取，统一设置浏览器式请求头。
export async function fetchText(url, { referer, userAgent, timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: Object.assign(
        {
          'User-Agent':
            userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        referer ? { Referer: referer } : {},
        headers,
      ),
    });
    if (!response.ok) {
      throw new Error(`上游返回 ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// 把上游 Web Response 的 body 流式管道到 Node res（避免大分片被函数内存限制卡住）。
export async function pipeBody(upstream, res, headers = {}) {
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) {
      res.setHeader(key, value);
    }
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  const { Readable } = await import('node:stream');
  const nodeStream = Readable.fromWeb(upstream.body);
  return new Promise((resolve, reject) => {
    nodeStream.on('error', (error) => {
      if (!res.headersSent) {
        res.status(502).end();
      }
      reject(error);
    });
    nodeStream.on('end', resolve);
    nodeStream.pipe(res);
  });
}