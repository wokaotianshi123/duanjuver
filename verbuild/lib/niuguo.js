// 牛果（niugo）站源 —— Go 版 native/core/provider_duanju_sources.go 里 fetchNiuguo* / resolveNiuguoMedia 的 JS 移植。
//
// 特点：响应是 AES-128-ECB + Base64 加密，密钥=请求 URI 的前 16 字节。
// Node 内置 crypto 完全支持 AES-128-ECB + PKCS7，所以可以完整移植。
// 不需要 TLS 指纹伪装，解析出的播放地址是直链 m3u8，不需要 ffmpeg。
// 实测 2026-10 可达：https://ccc.chaojichaojichanga.com:35620

import crypto from 'node:crypto';
import { buildQuery, csv, dramaID, duanjuCover, episodeNumber as episodeNumberHelper, findInt,
  findList, findMap, findString, makeChapter, sortChapters, stringList } from './duanju-helpers.js';
import { fetchText } from './util.js';

export const SOURCE_ID = 'niuguo';
export const SOURCE_NAME = '牛果';

const BASE_URL = 'https://ccc.chaojichaojichanga.com:35620';
const PARSE_URLS = ['http://ccs.jshh.gzbaoxian.com', 'http://101.42.92.211:5560'];
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const CATEGORIES = [
  { id: '1', name: '短剧' },
  { id: '2', name: '电影' },
  { id: '3', name: '电视剧' },
  { id: '4', name: '动漫' },
  { id: '5', name: '综艺' },
];

// makeEpisode 由 duanju-helpers 导出（下面会加），此处避免循环依赖直接用 makeChapter。

// ---- AES-128-ECB 解密（Go 版 niuguoDecryptResponse） ----

function decryptKey(requestURI) {
  const source = String(requestURI == null ? '' : requestURI);
  const padded = source.padEnd(16, '\0');
  return Buffer.from(padded.slice(0, 16), 'utf8');
}

function pkcs7Unpad(buffer) {
  if (buffer.length === 0) {
    return buffer;
  }
  const pad = buffer[buffer.length - 1];
  if (pad > 0 && pad <= 16 && buffer.slice(-pad).every((byte) => byte === pad)) {
    return buffer.slice(0, buffer.length - pad);
  }
  return buffer;
}

function decryptResponse(payload, requestURI) {
  const encoded = String(payload == null ? '' : payload).trim();
  if (!encoded) {
    throw new Error('牛果返回了空响应');
  }
  let raw;
  try {
    raw = Buffer.from(encoded, 'base64');
  } catch (error) {
    throw new Error('牛果响应不是有效的 Base64 数据');
  }
  if (raw.length === 0 || raw.length % 16 !== 0) {
    throw new Error('牛果响应长度不符合加密块要求');
  }
  const key = decryptKey(requestURI);
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(raw), decipher.final()]);
  const unpadded = pkcs7Unpad(plain);
  return JSON.parse(unpadded.toString('utf8'));
}

function requestURI(address) {
  try {
    const parsed = new URL(address);
    let uri = parsed.pathname;
    if (parsed.search) {
      uri += parsed.search;
    }
    return uri;
  } catch (error) {
    return address;
  }
}

async function fetchNiuguoJSON(path, query) {
  const address = BASE_URL + path + (query ? '?' + query : '');
  const body = await fetchText(address, { referer: BASE_URL + '/', userAgent: USER_AGENT });
  return decryptResponse(body, requestURI(address));
}

// ---- 目录 / 搜索 ----

function dramaFromNode(node, base) {
  const id = findString(node, 'vod_id', 'vodId', 'id');
  if (!id) {
    return null;
  }
  let tags = stringList(node.vod_tag);
  if (tags.length === 0 && findString(node, 'vod_tag')) {
    tags = findString(node, 'vod_tag').split(',');
  }
  return {
    id: dramaID(SOURCE_ID, id),
    source: SOURCE_ID,
    sourceId: id,
    title: findString(node, 'vod_name', 'vodName', 'title'),
    name: findString(node, 'vod_name', 'vodName', 'title'),
    intro: findString(node, 'vod_content', 'vod_blurb', 'vodContent', 'desc'),
    description: findString(node, 'vod_content', 'vod_blurb', 'vodContent', 'desc'),
    cover: duanjuCover(base, node, 'vod_pic', 'vodPic', 'cover'),
    coverUrl: duanjuCover(base, node, 'vod_pic', 'vodPic', 'cover'),
    episodeCount: findInt(node, 'vod_total', 'total', 'episodes'),
    category: findString(node, 'type_name', 'typeName'),
    tags,
    remark: findString(node, 'vod_remarks', 'vodRemarks'),
    channelName: SOURCE_NAME,
  };
}

function catalogItems(response, base) {
  let rows = findList(response, 'list', 'data');
  if (!rows) {
    rows = findList(findMap(response, 'data'), 'list');
  }
  const items = [];
  for (const entry of rows || []) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const drama = dramaFromNode(entry, base);
    if (drama && drama.id) {
      items.push(drama);
    }
  }
  return items;
}

export async function fetchCatalogPage(page, category, query) {
  const pageNumber = Number(page) || 1;
  if (pageNumber < 1 || pageNumber > 100000) {
    throw new Error('牛果目录页码无效');
  }
  // 牛果 API 的 class 参数实际上不做分类过滤（class=1 返回空，class=空 返回全部），
  // 这里固定发送 class=空，分类选择仅用于前端展示。
  const q = buildQuery({
    class: '',
    order: '最新',
    type_id: '5',
    area: '',
    year: '',
    state: '',
    wd: String(query == null ? '' : query).trim(),
    page: String(pageNumber),
  });
  const response = await fetchNiuguoJSON('/list', q);
  const items = catalogItems(response, BASE_URL);
  return { items, hasMore: items.length > 0 };
}

export async function searchDuanju(query) {
  const keyword = String(query == null ? '' : query).trim();
  if (!keyword || keyword.length > 256) {
    throw new Error('牛果搜索关键词无效');
  }
  const q = buildQuery({
    class: '',
    order: '最新',
    type_id: '5',
    area: '',
    year: '',
    state: '',
    wd: keyword,
    page: '1',
  });
  const response = await fetchNiuguoJSON('/list', q);
  return catalogItems(response, BASE_URL);
}

// ---- 详情 ----

export async function fetchDetail(sourceID) {
  const response = await fetchNiuguoJSON('/detail', buildQuery({ vod_id: String(sourceID) }));
  let node = response;
  const nested = findMap(response, 'data');
  if (nested) {
    node = nested;
  }
  const listed = findList(node, 'list');
  if (listed && listed.length > 0 && listed[0] && typeof listed[0] === 'object') {
    node = listed[0];
  }
  const drama = dramaFromNode(node, BASE_URL);
  drama.id = dramaID(SOURCE_ID, sourceID);
  drama.source = SOURCE_ID;
  drama.sourceId = sourceID;

  const chapters = [];
  const seen = new Set();
  const appendEpisode = (title, link) => {
    const l = String(link == null ? '' : link).trim();
    if (!l) {
      return;
    }
    const number = episodeNumberHelper(title, chapters.length + 1);
    if (seen.has(number)) {
      return;
    }
    seen.add(number);
    chapters.push(makeChapter(SOURCE_ID, sourceID, number, title, l, '', BASE_URL + '/'));
  };

  const sources = findList(node, 'sources') || [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    for (const item of findList(source, 'episodes') || []) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      appendEpisode(findString(item, 'name', 'title'), findString(item, 'url', 'playUrl'));
    }
  }
  if (chapters.length === 0) {
    const vodPlayURL = findString(node, 'vod_play_url');
    if (vodPlayURL) {
      for (const line of vodPlayURL.split('#')) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const dollar = trimmed.indexOf('$');
        if (dollar < 0) {
          continue;
        }
        appendEpisode(trimmed.slice(0, dollar).trim(), trimmed.slice(dollar + 1).trim());
      }
    }
  }
  if (chapters.length === 0) {
    throw new Error('牛果未返回可播放分集');
  }
  sortChapters(chapters);
  drama.episodeCount = chapters.length;
  drama.totalEpisode = chapters.length;
  drama.episodes = chapters.length;
  return { drama, chapters };
}

// ---- 播放解析（走 jx 解析服务） ----

export async function resolveMedia({ dramaId, chapter }) {
  const sourceID = String((chapter && chapter.videoURL) || '').trim();
  if (!sourceID) {
    throw new Error('牛果分集缺少解析 ID，请刷新详情后重试');
  }
  const referer = chapter && chapter.referer ? chapter.referer : BASE_URL + '/';
  let lastError = null;
  for (const base of PARSE_URLS) {
    for (const script of ['qy.php', 'dj.php']) {
      const address = base + '/jx/' + script + '?url=' + encodeURIComponent(sourceID);
      try {
        const body = await fetchText(address, { referer: base + '/', userAgent: USER_AGENT });
        const payload = JSON.parse(body);
        const resolved = findString(payload, 'url');
        if (!resolved) {
          lastError = new Error('牛果解析服务未返回播放地址');
          continue;
        }
        return {
          url: resolved,
          quality: 0,
          variants: [{ url: resolved, referer: base + '/', quality: 0 }],
          routeIndex: 0,
          routeCount: 1,
          referer: base + '/',
        };
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError || new Error('牛果未返回有效播放地址，请刷新章节后重试');
}