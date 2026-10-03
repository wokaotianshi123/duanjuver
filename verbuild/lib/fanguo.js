// 饭果（fanguo）站源 —— Go 版 native/core/provider_duanju_sources.go 里 fetchFanguo* 的 JS 移植。
//
// 纯 HTTPS JSON API，不需要 TLS 指纹伪装，返回直链 m3u8，不需要 ffmpeg。
// 实测 2026-10 可达：https://xifan-api-cn.youlishipin.com

import { buildQuery, csv, dramaID, duanjuCover, findInt, findList, findMap, findString,
  makeChapter, releaseStatus, sortChapters, stringList } from './duanju-helpers.js';
import { fetchText } from './util.js';

export const SOURCE_ID = 'fanguo';
export const SOURCE_NAME = '饭果';

const BASE_URL = 'https://xifan-api-cn.youlishipin.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const CATEGORIES = [
  { id: '都市', name: '都市' },
  { id: '甜宠', name: '甜宠' },
  { id: '逆袭', name: '逆袭' },
  { id: '战神', name: '战神' },
  { id: '古装', name: '古装' },
  { id: '穿越', name: '穿越' },
  { id: '萌宝', name: '萌宝' },
];

function dramaFromNode(node, base) {
  const id = findString(node, 'duanjuId', 'duanju_id', 'id');
  if (!id) {
    return null;
  }
  const source = findString(node, 'source');
  const sourceKey = source ? id + '#' + source : id;
  const tags = stringList(node.categories);
  return {
    id: dramaID(SOURCE_ID, sourceKey),
    source: SOURCE_ID,
    sourceId: sourceKey,
    title: findString(node, 'title', 'name'),
    name: findString(node, 'title', 'name'),
    intro: findString(node, 'description', 'desc', 'intro'),
    description: findString(node, 'description', 'desc', 'intro'),
    cover: duanjuCover(base, node, 'coverImageUrl', 'cover_image_url', 'cover'),
    coverUrl: duanjuCover(base, node, 'coverImageUrl', 'cover_image_url', 'cover'),
    episodeCount: findInt(node, 'total', 'totalEpisodeNum'),
    category: csv(tags),
    tags,
    channelName: SOURCE_NAME,
    releaseStatus: releaseStatus(findString(node, 'updateStatus'), findInt(node, 'total'), findInt(node, 'current')),
  };
}

async function fetchJSON(address, referer) {
  const body = await fetchText(address, { referer: referer || BASE_URL + '/', userAgent: USER_AGENT });
  return JSON.parse(body);
}

export async function fetchCatalogPage(page, category, query) {
  const pageNumber = Number(page) || 1;
  if (pageNumber < 1 || pageNumber > 100000) {
    throw new Error('饭果目录页码无效');
  }
  if (pageNumber > 1) {
    // 饭果搜索/目录不分页。
    return { items: [], hasMore: false };
  }
  const keyword = String(query != null ? query : '').trim() || String(category == null ? '' : category).trim() || '都市';
  const address = BASE_URL + '/xifan/search/getSearchList?' + buildQuery({
    reqType: 'search',
    offset: '0',
    keyword,
    quickEngineVersion: '-1',
    scene: '',
  });
  const response = await fetchJSON(address, BASE_URL + '/');
  const items = [];
  const seen = new Set();
  const elements = findList(findMap(response, 'result'), 'elements') || [];
  for (const block of elements) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const contents = findList(block, 'contents') || [];
    for (const entry of contents) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const drama = dramaFromNode(findMap(entry, 'duanjuVo'), BASE_URL);
      if (!drama || !drama.id || seen.has(drama.id)) {
        continue;
      }
      seen.add(drama.id);
      items.push(drama);
    }
  }
  return { items, hasMore: false };
}

export async function fetchDetail(sourceID) {
  let duanjuID = sourceID;
  let source = '';
  const hashIndex = sourceID.indexOf('#');
  if (hashIndex >= 0) {
    duanjuID = sourceID.slice(0, hashIndex);
    source = sourceID.slice(hashIndex + 1);
  }
  const address = BASE_URL + '/xifan/drama/getDuanjuInfo?' + buildQuery({ duanjuId: duanjuID, source });
  const response = await fetchJSON(address, BASE_URL + '/');
  const data = findMap(response, 'result');
  if (!data) {
    throw new Error('饭果未返回剧集资料');
  }
  const drama = {
    id: dramaID(SOURCE_ID, sourceID),
    source: SOURCE_ID,
    sourceId: sourceID,
    title: findString(data, 'title', 'name'),
    name: findString(data, 'title', 'name'),
    intro: findString(data, 'description', 'desc', 'intro'),
    description: findString(data, 'description', 'desc', 'intro'),
    cover: duanjuCover(BASE_URL, data, 'coverImageUrl', 'cover_image_url', 'cover'),
    coverUrl: duanjuCover(BASE_URL, data, 'coverImageUrl', 'cover_image_url', 'cover'),
    category: csv(stringList(data.categories)),
    tags: stringList(data.categories),
    channelName: SOURCE_NAME,
    releaseStatus: releaseStatus(findString(data, 'updateStatus'), findInt(data, 'total'), findInt(data, 'current')),
  };
  const chapters = [];
  const episodeList = findList(data, 'episodeList') || [];
  for (let index = 0; index < episodeList.length; index++) {
    const node = episodeList[index];
    if (!node || typeof node !== 'object') {
      continue;
    }
    const videoURL = findString(node, 'playUrl', 'play_url', 'videoUrl');
    if (!videoURL) {
      continue;
    }
    let number = findInt(node, 'index', 'episode', 'sort');
    if (number <= 0) {
      number = index + 1;
    }
    chapters.push(makeChapter(SOURCE_ID, sourceID, number, findString(node, 'title', 'name'), videoURL, '', BASE_URL + '/'));
  }
  if (chapters.length === 0) {
    throw new Error('饭果未返回可播放分集');
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
    throw new Error('饭果分集缺少播放地址，请刷新详情后重试');
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