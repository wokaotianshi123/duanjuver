// maccms 共享解析引擎 —— Go 版 provider_duanju_maccms.go + provider_web.go 的 JS 移植。
//
// 花果 / 发果 / 伍果 / 网果 四个站源共用同一套 HTML 解析模式（maccms 模板），
// 只有 URL 构造、分类 ID、详情候选路径不同。此模块提供共享的 card / episode / detail 解析，
// 以及一个 createMaccmsSource 工厂函数，每个站源只需传入差异化的配置即可。
//
// 不含 TLS 指纹伪装，返回直链 m3u8，不需要 ffmpeg。

import { parse } from 'node-html-parser';
import { fetchText, truncate } from './util.js';
import { dramaID, episodeNumber, makeChapter, sortChapters, firstNonEmpty } from './duanju-helpers.js';
import { duanjuAbsolute, htmlAttr, htmlClass, htmlFirstClass, htmlNodes, htmlText,
  maccmsNormalizePlaybackURL, maccmsPlayerURL } from './html-parser.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const maccmsEpisodeLink = /\/(?:vod\/)?play\/|\/vodplay\/|\/drama-play|episode_id=/i;
const maccmsDetailLink = /\/(?:index\.php\/vod\/)?(?:detail|vod|show|view|movie|drama|zywview|xzyxvd)\//i;
const maccmsDetailPath = /\/(?:voddetail|detail|show|vod|drama|movie|tv)\/([0-9]+)(?:[-./]|$)/i;
const webProviderNumericID = /^[1-9][0-9]{0,17}$/;

const maccmsCardClasses = [
  'col-lg-2', 'col-xl-2', 'module-item', 'module-poster-item', 'public-list-box',
  'videoBox', 'detail-list-item', 'col-md-6', 'col-6', 'listItem', 'FeaturedList_featuredItem',
  'BrowseList_listItem', 'SecondList_secondListItem', 'vodlist__item', 'v_list',
  'entry-wrapper', 'TagBookList_tagItem',
];

const maccmsTitleSuffixes = ['在线观看', '免费观看', '高清完整版', '完整版', '全集', '在线播放', '高清', '免费'];

// ---- HTML 工具函数（Go 版 providerHTML* 的薄封装） ----

function maccmsClassMatcher(name) {
  return (node) => {
    for (const value of String(htmlAttr(node, 'class') || '').split(/\s+/)) {
      if (value === name || value.endsWith('-' + name)) {
        return true;
      }
    }
    return false;
  };
}

// ---- 卡片解析（Go 版 maccmsCardCover / maccmsCardTitle / maccmsCardLink / maccmsCardRemark） ----

function maccmsCardCover(card, pageURL) {
  for (const image of htmlNodes(card, (node) => node.tagName === 'IMG')) {
    for (const attr of ['data-original', 'data-src', 'src']) {
      const address = duanjuAbsolute(pageURL, htmlAttr(image, attr));
      if (address) {
        return address;
      }
    }
  }
  for (const anchor of htmlNodes(card, (node) => node.tagName === 'A')) {
    for (const attr of ['data-original', 'data-src']) {
      const address = duanjuAbsolute(pageURL, htmlAttr(anchor, attr));
      if (address) {
        return address;
      }
    }
  }
  return '';
}

function maccmsCardTitle(card) {
  for (const attr of ['title', 'alt']) {
    for (const node of htmlNodes(card, (n) => n.tagName === 'A' || n.tagName === 'IMG')) {
      const text = String(htmlAttr(node, attr) || '').trim();
      if (text) {
        return text;
      }
    }
  }
  for (const node of htmlNodes(card, (n) => n.tagName === 'A')) {
    const text = htmlText(node);
    if (text) {
      return text;
    }
  }
  return '';
}

function maccmsCardLink(card, base) {
  for (const anchor of htmlNodes(card, (n) => n.tagName === 'A')) {
    const link = htmlAttr(anchor, 'href');
    if (!link || link.includes('javascript:')) {
      continue;
    }
    const address = duanjuAbsolute(base, link);
    if (address) {
      return address;
    }
  }
  return '';
}

function maccmsCardRemark(card) {
  for (const name of ['meta-post-type2', 'imagelabel', 'module-item-note', 'pic-text',
    'lastChapter', 'SecondList_totalChapterNum', 'SecondList_bookType']) {
    const node = htmlFirstClass(card, name);
    if (node) {
      const text = htmlText(node);
      if (text) {
        return text;
      }
    }
  }
  return '';
}

// ---- 卡片收集（Go 版 maccmsCards / maccmsAnchorCards） ----

function maccmsAnchorCards(document) {
  const cards = [];
  const seen = new Set();
  for (const anchor of htmlNodes(document, (n) =>
    n.tagName === 'A' && maccmsDetailLink.test(htmlAttr(n, 'href')))) {
    let parent = anchor.parentNode;
    while (parent && parent.nodeType === 1 /* ElementNode */) {
      if (seen.has(parent)) {
        break;
      }
      if (parent.tagName !== 'LI' && parent.tagName !== 'DIV') {
        parent = parent.parentNode;
        continue;
      }
      seen.add(parent);
      cards.push(parent);
      break;
    }
  }
  return cards;
}

function maccmsCards(document, source, base) {
  const cards = [];
  const seen = new Set();
  for (const name of maccmsCardClasses) {
    for (const node of htmlNodes(document, maccmsClassMatcher(name))) {
      if (!seen.has(node)) {
        seen.add(node);
        cards.push(node);
      }
    }
  }
  if (cards.length === 0) {
    cards.push(...maccmsAnchorCards(document));
  }
  const items = [];
  const ids = new Set();
  for (const card of cards) {
    const link = maccmsCardLink(card, base);
    const title = maccmsCardTitle(card);
    if (!link || !title) {
      continue;
    }
    const sourceID = maccmsSourceIDFromURL(link);
    if (!sourceID || ids.has(sourceID)) {
      continue;
    }
    ids.add(sourceID);
    const remark = maccmsCardRemark(card);
    items.push({
      id: dramaID(source, sourceID),
      source,
      sourceId: sourceID,
      title,
      cover: maccmsCardCover(card, link),
      remark,
      episodeCount: episodeNumber(remark, 0),
      channelName: source,
    });
  }
  return items;
}

// ---- ID 提取（Go 版 maccmsSourceIDFromURL） ----

function maccmsSourceIDFromURL(link) {
  let parsed;
  try {
    parsed = new URL(link);
  } catch (error) {
    return '';
  }
  let path = parsed.pathname;
  if (path.endsWith('.html')) {
    path = path.slice(0, -5);
  }
  const pathWithSlash = path + '/';
  const detailMatch = maccmsDetailPath.exec(pathWithSlash);
  if (detailMatch && detailMatch[1]) {
    return detailMatch[1];
  }
  const cleaned = path.replace(/^\/+|\/+$/g, '');
  const parts = cleaned.split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts[i].replace(/\.html$/, '');
    if (webProviderNumericID.test(candidate)) {
      return candidate;
    }
    const dashIndex = candidate.indexOf('-');
    if (dashIndex >= 0) {
      const tail = candidate.slice(dashIndex + 1);
      if (webProviderNumericID.test(tail)) {
        return tail;
      }
    }
  }
  const idParam = parsed.searchParams.get('id');
  if (idParam && webProviderNumericID.test(idParam)) {
    return idParam;
  }
  return '';
}

// ---- 分集节点收集（Go 版 maccmsEpisodeNodes） ----

function maccmsEpisodeNodes(document) {
  const nodes = [];
  const collect = (match) => {
    for (const list of htmlNodes(document, match)) {
      for (const anchor of htmlNodes(list, (n) => n.tagName === 'A')) {
        nodes.push(anchor);
      }
    }
  };
  for (const name of ['content__playlist', 'playlink', 'pcDrama_catalogItem', 'catalogItem', 'playlist']) {
    collect(maccmsClassMatcher(name));
  }
  if (nodes.length === 0) {
    for (const name of ['tab-pane', 'playlist', 'playList']) {
      collect(maccmsClassMatcher(name));
    }
  }
  if (nodes.length === 0) {
    for (const node of htmlNodes(document, (n) =>
      n.tagName === 'A' && maccmsEpisodeLink.test(htmlAttr(n, 'href')))) {
      nodes.push(node);
    }
  }
  return nodes;
}

// ---- 分集提取（Go 版 maccmsEpisodesFromDocument） ----

function maccmsEpisodesFromDocument(document) {
  const episodes = [];
  const seen = new Set();
  let index = 0;
  for (const anchor of maccmsEpisodeNodes(document)) {
    const link = String(htmlAttr(anchor, 'href') || '').trim();
    const title = htmlText(anchor);
    if (!link) {
      continue;
    }
    if (title.includes('APP') || title.includes('下载')) {
      continue;
    }
    if (seen.has(link)) {
      continue;
    }
    seen.add(link);
    index++;
    episodes.push({ key: String(index), title, url: link, index });
  }
  return episodes;
}

// ---- 详情页解析（Go 版 maccmsDetailTitle / maccmsDetailIntro / maccmsDetailCover / maccmsDetailCategory） ----

function maccmsCleanTitle(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) {
    return '';
  }
  const dashIdx = text.indexOf(' - ');
  if (dashIdx >= 0) {
    text = text.slice(0, dashIdx).trim();
  }
  const underscoreIdx = text.indexOf(' _ ');
  if (underscoreIdx >= 0) {
    text = text.slice(0, underscoreIdx).trim();
  }
  for (const separator of ['-', '_', '|']) {
    for (;;) {
      const idx = text.indexOf(separator);
      if (idx < 0) {
        break;
      }
      const head = text.slice(0, idx).trim();
      const tail = text.slice(idx + separator.length);
      if (!maccmsTitleTailIsSeo(tail)) {
        break;
      }
      text = head;
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const suffix of maccmsTitleSuffixes) {
      if (text.endsWith(suffix) && text.length > suffix.length) {
        text = text.slice(0, text.length - suffix.length).trim();
        changed = true;
      }
    }
  }
  text = text.trim() || text;
  text = text.replace(/[-_|·— ]/g, '').trim();
  if (!text) {
    return String(raw).trim();
  }
  return text;
}

function maccmsTitleTailIsSeo(tail) {
  tail = String(tail == null ? '' : tail).trim();
  if (!tail) {
    return true;
  }
  for (const marker of ['短剧', '全集', '在线观看', '免费', '高清', '完整版', '视频', '剧场', '影院', '网']) {
    if (tail.includes(marker)) {
      return true;
    }
  }
  return false;
}

function maccmsDetailTitle(document) {
  for (const name of ['module-info-heading', 'detail-title', 'video-info-title', 'page-title']) {
    const node = htmlFirstClass(document, name);
    if (node) {
      const text = htmlText(node);
      if (text) {
        return maccmsCleanTitle(text);
      }
    }
  }
  const titleNodes = htmlNodes(document, (n) => n.tagName === 'TITLE');
  if (titleNodes.length > 0) {
    return maccmsCleanTitle(htmlText(titleNodes[0]));
  }
  return '';
}

function maccmsDetailIntro(document) {
  for (const name of ['module-info-introduction-content', 'detail-content', 'video-info-content',
    'introduction_introEllipsis']) {
    const node = htmlFirstClass(document, name);
    if (node) {
      const text = htmlText(node);
      if (text) {
        return truncate(text, 2000);
      }
    }
  }
  for (const meta of htmlNodes(document, (n) => n.tagName === 'META')) {
    if (String(htmlAttr(meta, 'name') || '').toLowerCase() === 'description') {
      const content = String(htmlAttr(meta, 'content') || '').trim();
      if (content) {
        return truncate(content, 2000);
      }
    }
  }
  return '';
}

function maccmsDetailCover(document, pageURL) {
  for (const name of ['module-item-pic', 'detail-pic', 'video-info-pic', 'pic']) {
    for (const node of htmlNodes(document, (n) => htmlClass(n, name))) {
      const address = maccmsCardCover(node, pageURL);
      if (address) {
        return address;
      }
    }
  }
  for (const image of htmlNodes(document, (n) => n.tagName === 'IMG')) {
    for (const attr of ['data-original', 'data-src', 'src']) {
      const address = duanjuAbsolute(pageURL, htmlAttr(image, attr));
      if (address) {
        return address;
      }
    }
  }
  return '';
}

function maccmsDetailCategory(document) {
  for (const name of ['module-info-tag-link', 'detail-tag', 'video-info-actor']) {
    const nodes = htmlNodes(document, (n) => htmlClass(n, name));
    if (nodes.length > 0) {
      const parts = [];
      for (const anchor of htmlNodes(nodes[0], (n) => n.tagName === 'A')) {
        const text = htmlText(anchor);
        if (text) {
          parts.push(text);
        }
      }
      if (parts.length > 0) {
        return parts.join(', ');
      }
    }
  }
  return '';
}

// ---- 详情候选 URL（Go 版 maccmsDetailCandidates） ----

function maccmsDetailCandidates(source, base, sourceID) {
  switch (source) {
    case 'faguo':
      return [
        base + '/xzyxvd/' + sourceID + '.html',
        base + '/detail/' + sourceID + '.html',
        base + '/voddetail/' + sourceID + '.html',
      ];
    case 'wuguo':
      return [
        base + '/index.php/vod/detail/id/' + sourceID + '.html',
        base + '/dramaDetail/' + sourceID + '.html',
        base + '/detail/' + sourceID + '.html',
      ];
    case 'wangguo':
      return [
        base + '/vod/' + sourceID + '.html',
        base + '/index.php/vod/detail/id/' + sourceID + '.html',
        base + '/detail/' + sourceID + '.html',
      ];
    case 'huaguo':
      return [
        base + '/zywview/' + sourceID + '.html',
        base + '/zywdetail/' + sourceID + '.html',
        base + '/detail/' + sourceID + '.html',
      ];
    default:
      return [];
  }
}

// ---- HTML 解析入口（Go 版 fetchProviderPage 的 html.Parse） ----

function parseHTML(body) {
  return parse(body, { lowerCaseTagName: false, commentTag: false });
}

// ---- fetch + parse helper ----

async function fetchPage(address, referer) {
  const body = await fetchText(address, { referer: referer || '/', userAgent: USER_AGENT });
  if (body.length > 4 << 20) {
    throw new Error('站源页面过大');
  }
  return { document: parseHTML(body), finalURL: address };
}

// ---- 工厂：创建一个 maccms 站源模块 ----
//
// profile = {
//   sourceId, sourceName, base,
//   categoryURL: (base, category, page) => string,    // 目录页 URL
//   searchURL:  (base, query) => string,               // 搜索页 URL（可选，不传则无搜索）
//   detailCandidates: (base, sourceID) => string[],     // 详情候选 URL（可选，不传则用内置 maccmsDetailCandidates）
//   firstCategory: string,                              // 默认分类 ID（可选）
//   categories: [{id, name}],                           // 分类列表
// }

export function createMaccmsSource(profile) {
  const { sourceId, sourceName, base, categories, firstCategory = '' } = profile;
  const referer = base + '/';

  async function fetchCatalogPage(page, category, query) {
    const pageNumber = Number(page) || 1;
    if (pageNumber < 1 || pageNumber > 100000) {
      throw new Error(sourceName + '目录页码无效');
    }
    let address;
    if (query) {
      address = profile.searchURL(base, String(query).trim());
      if (!address) {
        throw new Error(sourceName + '不支持在线搜索');
      }
    } else {
      const classID = String(category == null ? '' : category).trim();
      address = profile.categoryURL(base, classID, pageNumber, firstCategory);
    }
    const { document } = await fetchPage(address, referer);
    const items = maccmsCards(document, sourceId, base);
    return { items, hasMore: items.length > 0 };
  }

  async function searchDuanju(query) {
    const keyword = String(query == null ? '' : query).trim();
    if (!keyword || keyword.length > 256) {
      throw new Error(sourceName + '搜索关键词无效');
    }
    const address = profile.searchURL(base, keyword);
    if (!address) {
      throw new Error(sourceName + '不支持在线搜索');
    }
    const { document } = await fetchPage(address, referer);
    return maccmsCards(document, sourceId, base);
  }

  async function fetchDetail(sourceID) {
    const candidates = (profile.detailCandidates || maccmsDetailCandidates)(sourceId, base, sourceID);
    let lastErr = null;
    for (const address of candidates) {
      try {
        const { document, finalURL } = await fetchPage(address, referer);
        const episodes = maccmsEpisodesFromDocument(document);
        if (episodes.length === 0) {
          lastErr = new Error('未解析到分集列表');
          continue;
        }
        const drama = {
          id: dramaID(sourceId, sourceID),
          source: sourceId,
          sourceId,
          title: maccmsDetailTitle(document),
          intro: maccmsDetailIntro(document),
          description: maccmsDetailIntro(document),
          cover: maccmsDetailCover(document, finalURL),
          category: maccmsDetailCategory(document),
          channelName: sourceName,
        };
        const chapters = [];
        for (let idx = 0; idx < episodes.length; idx++) {
          const episode = episodes[idx];
          const number = episodeNumber(firstNonEmpty(episode.title, episode.key), idx + 1);
          const link = duanjuAbsolute(base, episode.url);
          if (!link) {
            continue;
          }
          chapters.push(makeChapter(sourceId, sourceID, number, episode.title, link, link, referer));
        }
        if (chapters.length === 0) {
          lastErr = new Error('未解析到可播放分集');
          continue;
        }
        sortChapters(chapters);
        drama.episodeCount = chapters.length;
        drama.totalEpisode = chapters.length;
        drama.episodes = chapters.length;
        return { drama, chapters };
      } catch (error) {
        lastErr = error;
      }
    }
    throw lastErr || new Error('未找到该剧的详情页');
  }

  async function resolveMedia({ dramaId, chapter }) {
    const pageURL = String((chapter && chapter.videoURL) || '').trim();
    if (!pageURL) {
      throw new Error(sourceName + '分集缺少播放地址，请刷新详情后重试');
    }
    const body = await fetchText(pageURL, { referer: chapter && chapter.referer ? chapter.referer : referer,
      userAgent: USER_AGENT });
    const address = maccmsNormalizePlaybackURL(maccmsPlayerURL(body));
    if (!address) {
      throw new Error(sourceName + '未返回有效播放地址，请刷新章节后重试');
    }
    return {
      url: address,
      quality: 0,
      variants: [{ url: address, referer: chapter && chapter.referer ? chapter.referer : referer, quality: 0 }],
      routeIndex: 0,
      routeCount: 1,
      referer: chapter && chapter.referer ? chapter.referer : referer,
    };
  }

  return {
    SOURCE_ID: sourceId,
    SOURCE_NAME: sourceName,
    CATEGORIES: categories,
    fetchCatalogPage,
    fetchDetail,
    resolveMedia,
    searchDuanju,
  };
}