// 星果（xingguo）站源 —— Go 版 native/core/provider_duanju_sources.go 里 fetchXingguo* 的 JS 移植。
//
// 纯 HTTPS JSON API（带硬编码 token），不需要 TLS 指纹伪装，返回直链 m3u8，不需要 ffmpeg。
// 实测 2026-10 可达：http://read.api.duodutek.com

import { buildQuery, dramaID, duanjuCover, findInt, findList, findMap, findString,
  makeChapter, sortChapters } from './duanju-helpers.js';
import { fetchText } from './util.js';

export const SOURCE_ID = 'xingguo';
export const SOURCE_NAME = '星果';

const BASE_URL = 'http://read.api.duodutek.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PRODUCT_ID = '2a8c14d1-72e7-498b-af23-381028eb47c0';
const VEST_ID = '2be070e0-c824-4d0e-a67a-8f688890cadb';
const TOKEN = '202509271001001446030204698626';

export const CATEGORIES = [
  { id: '1287', name: '推荐一' },
  { id: '1288', name: '推荐二' },
  { id: '1289', name: '推荐三' },
  { id: '1290', name: '推荐四' },
  { id: '1291', name: '推荐五' },
];

function xingguoQuery(resourceID, page, size) {
  return buildQuery({
    productId: PRODUCT_ID,
    vestId: VEST_ID,
    channel: 'oppo19',
    osType: 'android',
    version: '20',
    token: TOKEN,
    resourceId: resourceID,
    pageNum: String(page),
    pageSize: String(size),
  });
}

function dramaFromNode(node, base) {
  const id = findString(node, 'id', 'bookId');
  if (!id) {
    return null;
  }
  let sourceKey = id;
  const intro = findString(node, 'introduction');
  if (intro) {
    sourceKey = id + '@' + intro;
  }
  const heat = findInt(node, 'heat');
  let views = '';
  if (heat > 0) {
    views = heat + '万播放';
  }
  return {
    id: dramaID(SOURCE_ID, sourceKey),
    source: SOURCE_ID,
    sourceId: sourceKey,
    title: findString(node, 'name', 'title'),
    name: findString(node, 'name', 'title'),
    intro: findString(node, 'introduction', 'desc'),
    description: findString(node, 'introduction', 'desc'),
    cover: duanjuCover(base, node, 'icon', 'cover'),
    coverUrl: duanjuCover(base, node, 'icon', 'cover'),
    episodeCount: findInt(node, 'chapterCount', 'total'),
    views,
    channelName: SOURCE_NAME,
  };
}

function episodeURL(node) {
  if (!node || typeof node !== 'object') {
    return '';
  }
  const direct = findString(node, 'shortPlayUrl', 'playUrl', 'url');
  if (direct) {
    return direct;
  }
  for (const listKey of ['shortPlayList', 'chapterShortPlayVoList']) {
    const list = findList(node, listKey);
    if (!list) {
      continue;
    }
    for (const entry of list) {
      const address = episodeURL(entry);
      if (address) {
        return address;
      }
    }
  }
  return '';
}

async function fetchJSON(address) {
  const body = await fetchText(address, { referer: BASE_URL + '/', userAgent: USER_AGENT });
  return JSON.parse(body);
}

export async function fetchCatalogPage(page, category, query) {
  const pageNumber = Number(page) || 1;
  if (pageNumber < 1 || pageNumber > 100000) {
    throw new Error('星果目录页码无效');
  }
  if (query) {
    return searchPage(query);
  }
  let resourceID = String(category == null ? '' : category).trim();
  if (!resourceID) {
    resourceID = CATEGORIES[0].id;
  }
  if (!/^\d+$/.test(resourceID)) {
    throw new Error('星果分类无效');
  }
  const address = BASE_URL + '/novel-api/app/pageModel/getResourceById?' + xingguoQuery(resourceID, pageNumber, '10');
  const response = await fetchJSON(address);
  const data = findMap(response, 'data');
  const items = [];
  for (const entry of findList(data, 'datalist') || []) {
    const drama = dramaFromNode(entry, BASE_URL);
    if (drama && drama.id) {
      items.push(drama);
    }
  }
  return { items, hasMore: items.length >= 10 };
}

async function searchPage(query) {
  const keyword = String(query == null ? '' : query).trim();
  if (!keyword || keyword.length > 256) {
    throw new Error('星果搜索关键词无效');
  }
  const address = BASE_URL + '/novel-api/basedata/book/searchBook?' + buildQuery({
    productId: PRODUCT_ID,
    vestId: VEST_ID,
    channel: 'oppo19',
    osType: 'android',
    version: '20',
    token: TOKEN,
    key: keyword,
    pageNum: '1',
    pageSize: '20',
  });
  const response = await fetchJSON(address);
  const data = findMap(response, 'data');
  const items = [];
  const seen = new Set();
  for (const entry of findList(data, 'datalist') || []) {
    const drama = dramaFromNode(entry, BASE_URL);
    if (!drama || !drama.id || seen.has(drama.id)) {
      continue;
    }
    seen.add(drama.id);
    items.push(drama);
  }
  if (items.length === 0) {
    throw new Error('星果未搜索到相关剧集');
  }
  return { items, hasMore: false };
}

export async function fetchDetail(sourceID) {
  let bookID = sourceID;
  let intro = '';
  const atIndex = sourceID.indexOf('@');
  if (atIndex >= 0) {
    bookID = sourceID.slice(0, atIndex);
    intro = sourceID.slice(atIndex + 1);
  }
  const address = BASE_URL + '/novel-api/basedata/book/getChapterList?' + buildQuery({
    bookId: bookID,
    productId: PRODUCT_ID,
    vestId: VEST_ID,
    channel: 'oppo19',
    osType: 'android',
    version: '20',
    token: TOKEN,
  });
  const response = await fetchJSON(address);
  const drama = {
    id: dramaID(SOURCE_ID, sourceID),
    source: SOURCE_ID,
    sourceId: sourceID,
    intro,
    description: intro,
    channelName: SOURCE_NAME,
  };
  const chapters = [];
  const list = findList(response, 'data') || [];
  for (let index = 0; index < list.length; index++) {
    const node = list[index];
    if (!node || typeof node !== 'object') {
      continue;
    }
    const videoURL = episodeURL(node);
    if (!videoURL) {
      continue;
    }
    let number = findInt(node, 'chapterNum', 'sort', 'index');
    if (number <= 0) {
      number = index + 1;
    }
    chapters.push(makeChapter(SOURCE_ID, sourceID, number, '', videoURL, '', BASE_URL + '/'));
  }
  if (chapters.length === 0) {
    throw new Error('星果未返回可播放分集');
  }
  sortChapters(chapters);
  drama.episodeCount = chapters.length;
  drama.totalEpisode = chapters.length;
  drama.episodes = chapters.length;
  return { drama, chapters };
}

export async function resolveMedia({ dramaId, chapter }) {
  const referer = chapter && chapter.referer ? chapter.referer : BASE_URL + '/';
  const videoURL = String((chapter && chapter.videoURL) || '').trim();
  if (!videoURL) {
    throw new Error('星果分集缺少播放地址，请刷新详情后重试');
  }
  return {
    url: videoURL,
    quality: 0,
    variants: [{ url: videoURL, referer, quality: 0 }],
    routeIndex: 0,
    routeCount: 1,
    referer,
  };
}