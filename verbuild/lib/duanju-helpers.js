// 短剧家族站源的共享 helper —— Go 版 native/core 里 duanju* / provider* helper 的 JS 移植。
//
// 覆盖：JSON 字段查找、封面地址解析、分集序号、章节构造、排序等。
// 被 fanguo / xingguo / niuguo / maccms 等模块共用。

import { truncate } from './util.js';

// ---- 基础类型转换 ----

export function nativeText(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const text = nativeText(entry);
        if (text) {
          return text;
        }
      }
      return '';
    }
    for (const key of ['url', 'src', 'cover', 'image', 'pic']) {
      const text = nativeText(value[key]);
      if (text) {
        return text;
      }
    }
  }
  return '';
}

// ---- JSON 字段查找 ----

export function findString(node, ...keys) {
  if (!node || typeof node !== 'object') {
    return '';
  }
  for (const key of keys) {
    if (key in node) {
      const text = nativeText(node[key]);
      if (text) {
        return text;
      }
    }
  }
  return '';
}

export function findInt(node, ...keys) {
  if (!node || typeof node !== 'object') {
    return 0;
  }
  for (const key of keys) {
    if (key in node) {
      const value = node[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.trunc(value);
      }
      if (typeof value === 'string') {
        const number = parseDuanjuNumber(value);
        if (number != null) {
          return number;
        }
      }
    }
  }
  return 0;
}

function parseDuanjuNumber(value) {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (/^-?\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) ? n : null;
  }
  const stripped = trimmed.replace(/(集|全集)$/, '').trim();
  if (/^-?\d+$/.test(stripped)) {
    const n = parseInt(stripped, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function findMap(node, ...keys) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  for (const key of keys) {
    if (key in node && node[key] && typeof node[key] === 'object' && !Array.isArray(node[key])) {
      return node[key];
    }
  }
  return null;
}

export function findList(node, ...keys) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  for (const key of keys) {
    if (key in node && Array.isArray(node[key])) {
      return node[key];
    }
  }
  return null;
}

export function mapList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows = [];
  for (const entry of value) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      rows.push(entry);
    }
  }
  return rows;
}

export function stringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const values = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) {
        values.push(text);
      }
    } else if (entry && typeof entry === 'object') {
      const text = findString(entry, 'name', 'title', 'class_name');
      if (text) {
        values.push(text);
      }
    }
  }
  return values;
}

export function csv(values) {
  return Array.isArray(values) ? values.join(', ') : '';
}

// ---- 封面地址 ----

export function validCoverURL(address) {
  try {
    const parsed = new URL(address);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !!parsed.hostname && !parsed.username;
  } catch (error) {
    return false;
  }
}

export function coverAddress(value, pageURL) {
  if (value == null) {
    return '';
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const address = coverAddress(entry, pageURL);
      if (address) {
        return address;
      }
    }
    return '';
  }
  if (value && typeof value === 'object') {
    for (const key of ['url', 'contentUrl', 'thumbnailUrl']) {
      const address = coverAddress(value[key], pageURL);
      if (address) {
        return address;
      }
    }
    return '';
  }
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  let address;
  try {
    address = new URL(trimmed);
  } catch (error) {
    return '';
  }
  if (pageURL) {
    try {
      const base = new URL(pageURL);
      if (base.hostname) {
        address = new URL(address.toString(), base.toString());
      }
    } catch (error) {
      // ignore
    }
  }
  if (!validCoverURL(address.toString())) {
    return '';
  }
  return address.toString();
}

// duanjuCover —— Go 版 duanjuCover(base, node, keys...)：依次取 node[keys[i]] 交给 coverAddress 解析。
export function duanjuCover(base, node, ...keys) {
  if (!node || typeof node !== 'object') {
    return '';
  }
  for (const key of keys) {
    if (key in node) {
      const address = coverAddress(node[key], base);
      if (address) {
        return address;
      }
    }
  }
  return '';
}

// ---- 状态 / 序号 ----

export function releaseStatus(raw, total, current) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  switch (value) {
    case 'over':
    case 'finished':
    case 'completed':
    case '2':
    case '已完结':
    case '完结':
      return 'finished';
    case 'ongoing':
    case 'serializing':
    case '1':
    case '连载中':
    case '更新中':
      return 'ongoing';
  }
  if (total > 0 && current >= total) {
    return 'finished';
  }
  if (current > 0) {
    return 'ongoing';
  }
  return '';
}

const RE_EPISODE_NUMBER = /(?:第\s*0*(\d+)\s*(?:集|话|期)|(?:更新至|共|全)\s*0*(\d+)\s*(?:集|话|期)|(?:episode|ep)\s*#?\s*0*(\d+))/i;

export function episodeNumber(raw, fallback) {
  const text = String(raw == null ? '' : raw).trim();
  const match = RE_EPISODE_NUMBER.exec(text);
  if (match) {
    for (let i = 1; i < match.length; i++) {
      if (match[i] !== '') {
        const n = parseInt(match[i], 10);
        if (Number.isFinite(n) && n > 0) {
          return n;
        }
      }
    }
  }
  if (/^\d+$/.test(text)) {
    const n = parseInt(text, 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  if (fallback > 0) {
    return fallback;
  }
  return 1;
}

// ---- ID 构造 ----

export function dramaID(source, sourceID) {
  return source + ':' + String(sourceID == null ? '' : sourceID).trim();
}

export function chapterID(source, sourceID, chapterKey) {
  return source + ':' + String(sourceID == null ? '' : sourceID).trim() + ':' + String(chapterKey == null ? '' : chapterKey).trim();
}

// ---- 章节构造 ----

export function makeChapter(source, sourceID, number, title, videoURL, pageURL, referer) {
  let n = Number(number);
  if (!Number.isFinite(n) || n <= 0) {
    n = 1;
  }
  let t = title == null ? '' : String(title).trim();
  if (!t) {
    t = '第' + n + '集';
  }
  return {
    id: chapterID(source, sourceID, String(n)),
    source: source,
    title: truncate(t, 256),
    currentEpisode: n,
    videoURL: String(videoURL == null ? '' : videoURL).trim(),
    pageURL: String(pageURL == null ? '' : pageURL).trim(),
    referer: String(referer == null ? '' : referer).trim(),
  };
}

// ---- 排序 ----

export function sortChapters(chapters) {
  return chapters.slice().sort((a, b) => {
    const left = Number(a.currentEpisode);
    const right = Number(b.currentEpisode);
    return left - right;
  });
}

// ---- 请求构造 ----

export function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) {
      continue;
    }
    search.set(key, String(value));
  }
  return search.toString();
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    if (value != null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}