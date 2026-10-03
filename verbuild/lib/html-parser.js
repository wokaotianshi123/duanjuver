// HTML 解析工具 —— Go 版 golang.org/x/net/html + providerHTML* 的 JS 移植。
//
// 底层用 node-html-parser（API 与 x/net/html 的 Node/Element 对应），
// 对外暴露和 Go 版一致的 BFS 遍历 + class 匹配语义。
//
// 被 maccms 系站源（花果/发果/伍果/网果）共用。

// ---- 节点遍历（Go 版 providerHTMLNodes：栈式 BFS，先匹配再入栈） ----

export function htmlNodes(root, match) {
  const found = [];
  if (!root) {
    return found;
  }
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (match(node)) {
      found.push(node);
    }
    // Go 版从 LastChild 遍历到 FirstChild，这里用 childNodes 逆序模拟。
    const children = node.childNodes || [];
    for (let i = children.length - 1; i >= 0; i--) {
      pending.push(children[i]);
    }
  }
  return found;
}

export function htmlAttr(node, name) {
  if (!node) {
    return '';
  }
  return node.getAttribute ? node.getAttribute(name) || '' : '';
}

export function htmlClass(node, name) {
  const classAttr = htmlAttr(node, 'class');
  if (!classAttr) {
    return false;
  }
  for (const value of classAttr.split(/\s+/)) {
    if (value === name) {
      return true;
    }
  }
  return false;
}

export function htmlFirstClass(root, ...names) {
  for (const name of names) {
    const matches = htmlNodes(root, (node) => htmlClass(node, name));
    if (matches.length > 0) {
      return matches[0];
    }
  }
  return null;
}

// Go 版 providerHTMLText：只收 TextNode，跳过 script/style 子树，字段之间加空格，最后 Fields 归一。
export function htmlText(root) {
  if (!root) {
    return '';
  }
  const parts = [];
  const textNodes = htmlNodes(root, (node) => node.nodeType === 3 /* TextNode */);
  for (const node of textNodes) {
    const parent = node.parentNode;
    if (parent && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE')) {
      continue;
    }
    parts.push(node.textContent || node.rawText || '');
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// ---- 绝对 URL（Go 版 duanjuAbsolute） ----

export function duanjuAbsolute(base, reference) {
  reference = String(reference == null ? '' : reference).trim();
  if (!reference) {
    return '';
  }
  if (reference.startsWith('//')) {
    return 'https:' + reference;
  }
  let address;
  try {
    address = new URL(reference);
  } catch (error) {
    // 相对 URL（如 /vod/123.html），Go 的 url.Parse 不会报错，JS 会。
    // 改为直接尝试用 base 解析。
    address = null;
  }
  if (address && address.origin !== 'null') {
    return address.toString();
  }
  let origin;
  try {
    origin = new URL(base.endsWith('/') ? base : base + '/');
  } catch (error) {
    return '';
  }
  if (!origin.origin || origin.origin === 'null') {
    return '';
  }
  try {
    return new URL(reference, origin.toString()).toString();
  } catch (error) {
    return '';
  }
}

// ---- maccms 播放器 URL 提取（Go 版 maccmsPlayerURL） ----

const maccmsPlayerData = /player_aaaa\s*=\s*(\{.*?\})\s*<\/script>/s;
const maccmsPlayerURLField = /"url"\s*:\s*"([^"]+)"/i;

export function maccmsPlayerURL(body) {
  if (typeof body !== 'string') {
    return '';
  }
  const dataMatch = maccmsPlayerData.exec(body);
  if (dataMatch && dataMatch[1]) {
    const fieldMatch = maccmsPlayerURLField.exec(dataMatch[1]);
    if (fieldMatch && fieldMatch[1]) {
      return fieldMatch[1].replace(/\\\//g, '/');
    }
  }
  const fallbackPatterns = [
    /\$\.\s*url\s*=\s*"([^"]+)"/i,
    /"url"\s*:\s*"([^"]+\.(?:m3u8|mp4)[^"]*)"/i,
    /(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/i,
  ];
  for (const pattern of fallbackPatterns) {
    const match = pattern.exec(body);
    if (match && match[1]) {
      return match[1].replace(/\\\//g, '/');
    }
  }
  return '';
}

// ---- maccms 播放地址归一化（Go 版 maccmsNormalizePlaybackURL） ----

const maccmsUnicodeEscape = /\\?u([0-9a-fA-F]{4})/g;

function maccmsDecodeUnicode(value) {
  return value.replace(maccmsUnicodeEscape, (match) => {
    const hex = match.slice(-4);
    const codePoint = parseInt(hex, 16);
    if (isNaN(codePoint)) {
      return match;
    }
    return String.fromCodePoint(codePoint);
  });
}

export function maccmsNormalizePlaybackURL(raw) {
  raw = String(raw == null ? '' : raw).trim().replace(/\\\//g, '/');
  raw = raw.trim(/[,\\"。，;；]/);
  raw = raw.trim();
  if (!raw) {
    return '';
  }
  if (raw.includes('p.') || raw.includes('c1.')) {
    const parts = raw.split('/');
    if (parts.length >= 3) {
      const base = parts.slice(0, -2).join('/');
      const folder = parts[parts.length - 2];
      const decoded = maccmsDecodeUnicode(folder);
      if (decoded !== folder) {
        return base + '/' + encodeURIComponent(decoded) + '/index.m3u8';
      }
    }
  }
  return raw;
}