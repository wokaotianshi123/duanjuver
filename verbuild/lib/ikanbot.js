// 爱看机器人（ikanbot）站源 —— Go 版 native/core/provider_ikanbot.go 的 JavaScript 移植。
//
// 上游页面（实测 2026-10，走国内网络）：
//   GET /hot/index-{kind}-{分类}.html       分类第 1 页（kind: movie / tv）
//   GET /hot/index-{kind}-{分类}-p-{n}.html 分类翻页
//   GET /search?q={关键词}                  搜索（服务端渲染，无翻页）
//   GET /play/{id}                          详情/播放页（含线路与分集所需的令牌）
//   GET /api/getResN?videoId={id}&mtype={1|2}&token={签名}  线路列表（JSON）
//
// 这是纯 HTTPS + 正则解析的站源，返回直链 m3u8，不需要 TLS 指纹伪装，也不需要 ffmpeg，
// 因此可以完整运行在 Cloudflare Workers 运行时里。

import {
  cleanText,
  fetchText,
  firstNonEmpty,
  truncate,
  unescapeHTML,
} from './util.js';

export const SOURCE_ID = 'ikanbot';
export const SOURCE_NAME = '爱看机器人';

const SITE_BASE_URL = 'https://www1.ikanbot.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PAGE_SIZE = 36;
const MAX_LINES = 40;

// 分类 ID 形如 "{kind}-{名称}"，与 /hot/index-{id}.html 一一对应。
export const CATEGORIES = [
  { id: 'movie-热门', name: '热门电影' },
  { id: 'tv-热门', name: '热门剧集' },
  { id: 'tv-国产剧', name: '国产剧' },
  { id: 'tv-日剧', name: '日剧' },
  { id: 'tv-韩剧', name: '韩剧' },
  { id: 'tv-美剧', name: '美剧' },
  { id: 'tv-英剧', name: '英剧' },
  { id: 'tv-港剧', name: '港剧' },
  { id: 'tv-日本动画', name: '日本动画' },
  { id: 'tv-综艺', name: '综艺' },
  { id: 'tv-纪录片', name: '纪录片' },
];

const RE_CARD_LINK = /<a class="item" href="\/play\/(\d+)"/is;
const RE_CARD_LINK_ALL = /<a class="item" href="\/play\/(\d+)"/gis;
const RE_IMG_DATA = /<img[^>]*data-src="([^"]+)"/is;
const RE_IMG_ALT = /<img[^>]*alt="([^"]*)"/is;
const RE_CARD_TEXT = /<p>(.*?)<\/p>/is;
const RE_PAGE_MAX = /-p-(\d+)\.html/gi;

const RE_MEDIA_BLOCK = /<div class="media">(.*?)<\/div>\s*<\/div>/gis;
const RE_MEDIA_HREF = /href="\/play\/(\d+)"/is;
const RE_TITLE_TEXT = /<a href="\/play\/\d+" class="title-text">(.*?)<\/a>/is;
const RE_LINE_LABEL = /<span class="label"[^>]*>\[([^\]]*)\]<\/span>/is;
const RE_SMALL_TEXT = /<span class="small"[^>]*>(.*?)<\/span>/gis;

const RE_CURRENT_ID = /<input type="hidden" id="current_id" value="([^"]*)"\/>/is;
const RE_TOKEN = /<input type="hidden" id="e_token" value="([^"]*)"\/>/is;
const RE_MTYPE = /<input type="hidden" id="mtype" value="([^"]*)"\/>/is;
const RE_TITLE = /<h1 id="video_title"[^>]*>(.*?)<\/h1>/is;
const RE_COVER_IMG = /<img id="\d+"[^>]*class="cover lazy"[^>]*data-src="([^"]+)"/is;
const RE_META_TEXT = /<h3 class="meta">(.*?)<\/h3>/gis;
const RE_TAG_NAME = /<[^>]+>/g;
const RE_EPISODE_NO = /(\d+)/;
const RE_YEAR = /(19|20)\d{2}/;
const RE_FLAG_RES = /(2160|1440|1080|720|480)/;

// 跨线路对齐同一集用到的内存缓存（Workers 单实例内有效，随时可能被回收）。
const lineCache = new Map();
const LINE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 64;

export function numericID(value) {
  const text = String(value == null ? '' : value).trim();
  if (text === '' || text.length > 12) {
    return false;
  }
  return /^\d+$/.test(text) && Number(text) > 0;
}

export function validCategory(category) {
  const value = String(category == null ? '' : category).trim();
  if (value === '') {
    return true;
  }
  if (value.length > 32 || /[|/\\\u0000\r\n]/.test(value)) {
    return false;
  }
  return CATEGORIES.some((entry) => entry.id === value);
}

function kindOf(category) {
  return String(category || '').startsWith('movie-') ? '电影' : '剧集';
}

export function fixURL(raw) {
  let value = String(raw == null ? '' : raw).trim();
  if (value === '') {
    return '';
  }
  if (value.startsWith('//')) {
    value = 'https:' + value;
  } else if (value.startsWith('/')) {
    value = SITE_BASE_URL + value;
  }
  return validHTTPURL(value) ? value : '';
}

function validHTTPURL(raw) {
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !!parsed.hostname;
  } catch (error) {
    return false;
  }
}

function validMediaURL(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (value === '' || !validHTTPURL(value)) {
    return false;
  }
  return /\.(m3u8|mp4)(\?|$)/i.test(value);
}

// 复刻页面混淆脚本里的 get_tks：取影片 ID 末 4 位，每位数字 n 得出步长 k = n%3+1，
// 从令牌串当前位置截取 8 个字符并推进 k+8 位。算错会返回 -401 unauthorized。
export function sign(currentID, eToken) {
  const id = String(currentID == null ? '' : currentID);
  const token = String(eToken == null ? '' : eToken);
  if (id.length < 4 || token.length < 16) {
    return '';
  }
  const tail = id.slice(-4);
  let rest = token;
  let out = '';
  for (const char of tail) {
    if (!/[0-9]/.test(char)) {
      return '';
    }
    const start = (Number(char) % 3) + 1;
    if (start + 8 > rest.length) {
      return '';
    }
    out += rest.slice(start, start + 8);
    rest = rest.slice(start + 8);
  }
  return out;
}

async function ikanbotGet(path, referer) {
  const address = path.startsWith('http') ? path : SITE_BASE_URL + path;
  return fetchText(address, {
    referer: referer || SITE_BASE_URL + '/',
    userAgent: USER_AGENT,
  });
}

function parseCards(body, category) {
  const items = [];
  const seen = new Set();
  RE_CARD_LINK_ALL.lastIndex = 0;
  let match;
  while ((match = RE_CARD_LINK_ALL.exec(body)) !== null) {
    const id = match[1];
    if (!numericID(id) || seen.has(id)) {
      continue;
    }
    let chunk = body.slice(match.index + match[0].length);
    if (chunk.length > 900) {
      chunk = chunk.slice(0, 900);
    }
    let title = '';
    const alt = chunk.match(RE_IMG_ALT);
    if (alt && alt[1]) {
      title = cleanText(alt[1]);
    }
    if (!title) {
      const text = chunk.match(RE_CARD_TEXT);
      if (text && text[1]) {
        title = cleanText(text[1]);
      }
    }
    if (!title) {
      continue;
    }
    let cover = '';
    const image = chunk.match(RE_IMG_DATA);
    if (image && image[1]) {
      cover = fixURL(image[1]);
    }
    seen.add(id);
    items.push({
      id: 'ikanbot:' + id,
      source: SOURCE_ID,
      sourceId: id,
      title: truncate(title, 512),
      name: truncate(title, 512),
      cover,
      coverUrl: cover,
      channelName: SOURCE_NAME,
      categoryName: kindOf(category),
    });
    if (items.length > 500) {
      break;
    }
  }
  return items;
}

function parseSearchCards(body) {
  const items = [];
  const seen = new Set();
  RE_MEDIA_BLOCK.lastIndex = 0;
  let block;
  while ((block = RE_MEDIA_BLOCK.exec(body)) !== null) {
    let chunk = block[1];
    if (chunk.length > 2000) {
      chunk = chunk.slice(0, 2000);
    }
    const href = chunk.match(RE_MEDIA_HREF);
    if (!href || !href[1]) {
      continue;
    }
    const id = href[1];
    if (!numericID(id) || seen.has(id)) {
      continue;
    }
    let title = '';
    const text = chunk.match(RE_TITLE_TEXT);
    if (text && text[1]) {
      title = cleanText(text[1]);
    }
    if (!title) {
      const alt = chunk.match(RE_IMG_ALT);
      if (alt && alt[1]) {
        title = cleanText(alt[1]);
      }
    }
    if (!title) {
      continue;
    }
    let cover = '';
    const image = chunk.match(RE_IMG_DATA);
    if (image && image[1]) {
      cover = fixURL(image[1]);
    }
    let remark = '';
    const label = chunk.match(RE_LINE_LABEL);
    if (label && label[1]) {
      remark = cleanText(label[1]);
    }
    let note = '';
    RE_SMALL_TEXT.lastIndex = 0;
    let small;
    while ((small = RE_SMALL_TEXT.exec(chunk)) !== null) {
      const value = cleanText(small[1]);
      if (value) {
        note = truncate(value, 96);
        break;
      }
    }
    seen.add(id);
    items.push({
      id: 'ikanbot:' + id,
      source: SOURCE_ID,
      sourceId: id,
      title: truncate(title, 512),
      name: truncate(title, 512),
      cover,
      coverUrl: cover,
      channelName: SOURCE_NAME,
      categoryName: '剧集',
      remark: truncate(remark, 64),
      description: truncate(note, 512),
    });
    if (items.length > 100) {
      break;
    }
  }
  return items;
}

function pageCount(body, page, count) {
  let maxPage = page;
  RE_PAGE_MAX.lastIndex = 0;
  let match;
  while ((match = RE_PAGE_MAX.exec(body)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > maxPage && value < 100000) {
      maxPage = value;
    }
  }
  if (maxPage > page) {
    return maxPage;
  }
  if (count >= PAGE_SIZE) {
    return page + 1;
  }
  return page;
}

export async function fetchCatalogPage(page, category, query) {
  const pageNumber = Number(page) || 1;
  if (pageNumber < 1 || pageNumber > 100000) {
    throw new Error('爱看机器人目录页码无效');
  }
  if (query) {
    return searchPage(pageNumber, query);
  }
  if (!validCategory(category)) {
    throw new Error('爱看机器人内容分类无效');
  }
  const target = category || CATEGORIES[0].id;
  let path = '/hot/index-' + target + '.html';
  if (pageNumber > 1) {
    path = '/hot/index-' + target + '-p-' + pageNumber + '.html';
  }
  const body = await ikanbotGet(path);
  const items = parseCards(body, target);
  if (items.length === 0) {
    return { items: [], hasMore: false };
  }
  return { items, hasMore: pageNumber < pageCount(body, pageNumber, items.length) };
}

async function searchPage(page, query) {
  const keyword = String(query == null ? '' : query).trim();
  if (!keyword || keyword.length > 256) {
    throw new Error('爱看机器人搜索关键词无效');
  }
  if (page > 1) {
    // 站点搜索结果不分页。
    return { items: [], hasMore: false };
  }
  const body = await ikanbotGet('/search?' + new URLSearchParams({ q: keyword }).toString());
  return { items: parseSearchCards(body), hasMore: false };
}

// 把线路接口返回的原始结构整理成按分集数降序的线路列表，并按全部分集地址去重
// （站点经常把同一份源挂在不同 flag 下）。
function parseLines(payload) {
  const lines = [];
  const seen = new Set();
  const list = (payload && payload.data && payload.data.list) || [];
  for (const item of list) {
    let entries;
    try {
      entries = JSON.parse(item.resData || '[]');
    } catch (error) {
      continue;
    }
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      const episodes = [];
      const orders = new Set();
      let signature = '';
      const pairs = splitEpisodes(entry.url || '');
      pairs.forEach((pair, index) => {
        const address = normalizeMediaURL(pair[1]);
        if (!address) {
          return;
        }
        const name = cleanText(pair[0]);
        let order = index + 1;
        const number = name.match(RE_EPISODE_NO);
        if (number) {
          const parsed = Number(number[1]);
          if (Number.isFinite(parsed) && parsed > 0 && parsed <= 100000) {
            order = parsed;
          }
        }
        if (orders.has(order)) {
          return;
        }
        orders.add(order);
        episodes.push({ name, url: address, order });
        signature += address + '\n';
      });
      if (episodes.length === 0) {
        continue;
      }
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      lines.push({ flag: String(entry.flag || '').trim(), episodes });
    }
  }
  lines.sort((a, b) => b.episodes.length - a.episodes.length);
  return lines.slice(0, MAX_LINES);
}

// 线路名里带分辨率时（如 1080zyk）标出画质，供播放器排序。
function lineQuality(flag) {
  const match = String(flag || '').toLowerCase().match(RE_FLAG_RES);
  if (!match) {
    return 0;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 480 || value > 2160) {
    return 0;
  }
  return value;
}

async function fetchLines(sourceID, meta) {
  let currentID = sourceID;
  let token = '';
  let mType = '1';
  if (meta) {
    currentID = meta.currentId || sourceID;
    token = meta.token || '';
    mType = meta.mType || '1';
  }
  if (!token) {
    const body = await ikanbotGet('/play/' + sourceID);
    const page = parsePlayPage(body, sourceID);
    currentID = page.currentId;
    token = page.token;
    mType = page.mType;
  }
  const signed = sign(currentID, token);
  if (!signed) {
    throw new Error('爱看机器人播放令牌无效，请刷新详情');
  }
  const address =
    SITE_BASE_URL +
    '/api/getResN?' +
    new URLSearchParams({ videoId: currentID, mtype: mType || '1', token: signed }).toString();
  const body = await ikanbotGet(address, SITE_BASE_URL + '/play/' + sourceID);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error('爱看机器人线路返回无法解析');
  }
  if (Number(payload.state) !== 1) {
    throw new Error('爱看机器人线路获取失败：' + (String(payload.message || '').trim() || 'unauthorized'));
  }
  const lines = parseLines(payload);
  if (lines.length === 0) {
    throw new Error('爱看机器人暂无可播放线路');
  }
  return lines;
}

// 带短缓存的线路入口：详情与播放解析共用同一份结果，避免连续切分集反复抓详情页换令牌。
async function getLines(sourceID, meta) {
  const cached = lineCache.get(sourceID);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.lines;
  }
  const lines = await fetchLines(sourceID, meta);
  if (lineCache.size >= MAX_CACHE_ENTRIES) {
    lineCache.clear();
  }
  lineCache.set(sourceID, { lines, expiresAt: Date.now() + LINE_TTL_MS });
  return lines;
}

function lineEpisode(line, order) {
  for (const episode of line.episodes) {
    if (episode.order === order) {
      return episode;
    }
  }
  // 电影各线路只有一集，命名各异（正片 / HD中字 / TC），直接取它。
  if (line.episodes.length === 1 && order === 1) {
    return line.episodes[0];
  }
  return null;
}

// 把各条线路里同一集的地址整理成可切换的线路列表。
export function episodeOptions(lines, order, referer) {
  const options = [];
  const seen = new Set();
  for (const line of lines) {
    const episode = lineEpisode(line, order);
    if (!episode || seen.has(episode.url)) {
      continue;
    }
    seen.add(episode.url);
    options.push({ url: episode.url, referer, quality: lineQuality(line.flag) });
  }
  return options;
}

// 把 "第01集$url#第02集$url" 拆成 [名称, 地址] 对。
function splitEpisodes(raw) {
  const pairs = [];
  for (let part of String(raw || '').split('#')) {
    part = part.trim();
    if (!part) {
      continue;
    }
    const index = part.indexOf('$');
    if (index < 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    let address = part.slice(index + 1).trim();
    // 少数线路会在地址后面再挂一个 "$线路名" 标记（实测 yhm3u8 每条都带），
    // 带着尾巴去请求会 500，截掉后正常。
    const tail = address.indexOf('$');
    if (tail >= 0) {
      address = address.slice(0, tail).trim();
    }
    if (!address) {
      continue;
    }
    pairs.push([name, address]);
  }
  return pairs;
}

function normalizeMediaURL(raw) {
  let value = String(raw == null ? '' : raw).trim();
  if (value === '') {
    return '';
  }
  if (value.startsWith('//')) {
    value = 'https:' + value;
  }
  if (!validMediaURL(value)) {
    return '';
  }
  return value;
}

// 从播放页取出线路接口需要的 current_id / e_token / mtype，以及标题、封面与简介。
export function parsePlayPage(body, sourceID) {
  const meta = { currentId: sourceID, token: '', mType: '1', title: '', cover: '', desc: '', year: '', region: '', actors: '' };
  const title = body.match(RE_TITLE);
  if (title && title[1]) {
    meta.title = cleanText(title[1]);
  }
  if (!meta.title) {
    throw new Error('爱看机器人详情缺少视频名称');
  }
  const cover = body.match(RE_COVER_IMG);
  if (cover && cover[1]) {
    meta.cover = fixURL(cover[1]);
  }
  if (!meta.cover) {
    const image = body.match(RE_IMG_DATA);
    if (image && image[1]) {
      meta.cover = fixURL(image[1]);
    }
  }
  const current = body.match(RE_CURRENT_ID);
  if (current && current[1].trim()) {
    meta.currentId = current[1].trim();
  }
  const token = body.match(RE_TOKEN);
  if (token && token[1]) {
    meta.token = token[1].trim();
  }
  const mtype = body.match(RE_MTYPE);
  if (mtype && mtype[1].trim()) {
    meta.mType = mtype[1].trim();
  }
  if (!meta.currentId || !meta.token) {
    throw new Error('爱看机器人缺少播放令牌，请刷新页面重试');
  }
  const texts = [];
  RE_META_TEXT.lastIndex = 0;
  let item;
  while ((item = RE_META_TEXT.exec(body)) !== null) {
    const value = cleanText(item[1]);
    if (value) {
      texts.push(value);
    }
  }
  meta.desc = texts.join(' · ');
  for (const value of texts) {
    const yearMatch = value.match(RE_YEAR);
    if (!meta.year && yearMatch && value.startsWith(yearMatch[0]) && value.length <= 12) {
      meta.year = value;
      continue;
    }
    if (!meta.actors && value.includes('/')) {
      meta.actors = value;
      continue;
    }
    if (!meta.region && !value.includes('/') && value) {
      meta.region = value;
    }
  }
  return meta;
}

export async function fetchDetail(sourceID) {
  if (!numericID(sourceID)) {
    throw new Error('爱看机器人视频 ID 无效');
  }
  const body = await ikanbotGet('/play/' + sourceID);
  const page = parsePlayPage(body, sourceID);

  const lines = await getLines(sourceID, page);
  const primary = lines[0];

  const chapters = [];
  const pageURL = SITE_BASE_URL + '/play/' + sourceID;
  const referer = SITE_BASE_URL + '/';
  for (const episode of primary.episodes) {
    let order = episode.order;
    if (!(order >= 1)) {
      order = chapters.length + 1;
    }
    const chapterTitle = episode.name || '第 ' + order + ' 集';
    chapters.push({
      // 分集 ID 用集号而不是地址：同一集在各线路上地址不同，
      // 播放时再按集号把每条线路的地址取出来供切换。
      id: 'ikanbot:' + sourceID + ':' + order,
      source: SOURCE_ID,
      title: truncate(chapterTitle, 128),
      currentEpisode: order,
      videoUrl: episode.url,
      pageUrl: pageURL,
      referer,
    });
  }
  if (chapters.length === 0) {
    throw new Error('爱看机器人暂无可播放分集');
  }
  chapters.sort((a, b) => a.currentEpisode - b.currentEpisode);

  const tags = [];
  if (page.actors) {
    tags.push(truncate(page.actors, 64));
  }
  if (page.region) {
    tags.push(truncate(page.region, 32));
  }
  const drama = {
    id: 'ikanbot:' + sourceID,
    source: SOURCE_ID,
    sourceId: sourceID,
    title: truncate(page.title, 512),
    name: truncate(page.title, 512),
    description: truncate(page.desc, 12000),
    intro: truncate(page.desc, 12000),
    cover: page.cover,
    coverUrl: page.cover,
    channelName: SOURCE_NAME,
    onlineDate: truncate(page.year, 32),
    episodes: chapters.length,
    episodeCount: chapters.length,
    totalEpisode: chapters.length,
    tags,
  };
  return { drama, chapters };
}

// 把播放解析结果整理成有字段名、带线路列表的统一结构。
export async function resolveMedia({ dramaId, chapter, index }) {
  const sourceID = String(dramaId || '').split(':')[1] || '';
  if (!numericID(sourceID)) {
    throw new Error('爱看机器人播放分集信息无效，请刷新详情');
  }
  const referer = firstNonEmpty(chapter && chapter.referer, SITE_BASE_URL + '/');
  const chapterID = String((chapter && chapter.id) || '');
  const prefix = 'ikanbot:' + sourceID + ':';
  const payload = chapterID.startsWith(prefix) ? chapterID.slice(prefix.length).trim() : '';

  let options = [];
  let lineError = null;
  const order = Number(payload);
  if (Number.isFinite(order) && order > 0 && order <= 100000) {
    try {
      const lines = await getLines(sourceID, null);
      options = episodeOptions(lines, order, referer);
    } catch (error) {
      lineError = error;
    }
  }
  // 兜底：旧格式的分集 ID（直接存地址）或线路接口临时失败时，先用详情里的地址播起来。
  if (options.length === 0) {
    const direct = normalizeMediaURL(payload);
    if (direct) {
      options = [{ url: direct, referer, quality: 0 }];
    } else if (chapter && chapter.videoUrl) {
      const fallback = normalizeMediaURL(chapter.videoUrl);
      if (fallback) {
        options = [{ url: fallback, referer, quality: 0 }];
      }
    }
  }
  if (options.length === 0) {
    throw lineError || new Error('爱看机器人该集没有可用线路，请刷新详情');
  }
  return {
    url: options[0].url,
    quality: options[0].quality || 0,
    variants: options,
    routeIndex: 0,
    routeCount: options.length,
    referer,
  };
}