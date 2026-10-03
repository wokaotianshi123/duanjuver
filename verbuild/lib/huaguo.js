// 花果（huaguo）站源 —— Go 版 provider_duanju_maccms.go + provider_duanju_dispatch.go 的 JS 移植。
//
// maccms 模板 HTML 站源，纯 HTTPS 抓取 + HTML 解析，不需要 TLS 指纹伪装，返回直链 m3u8，不需要 ffmpeg。
// 注意：从本环境测试 huaguo（www.zywest263.com）不可达（000），但代码已完整移植，网络恢复后即可使用。

import { createMaccmsSource } from './maccms.js';

const BASE = 'https://www.zywest263.com';

export default createMaccmsSource({
  sourceId: 'huaguo',
  sourceName: '花果',
  base: BASE,
  categories: [{ id: '', name: '全部' }],
  firstCategory: '',
  categoryURL: (base, category, page, firstCategory) => {
    const pageNumber = Number(page) || 1;
    const classID = String(category || '').trim();
    if (pageNumber <= 1 && classID === '') {
      return base + '/';
    }
    const tid = classID || String(firstCategory || '').trim() || '27';
    return base + '/search.html?page=' + pageNumber + '&searchtype=5&tid=' +
      encodeURIComponent(tid) + '&year=';
  },
  searchURL: (base, query) => base + '/search.html?searchword=' + encodeURIComponent(query),
  detailCandidates: (source, base, sourceID) => [
    base + '/zywview/' + sourceID + '.html',
    base + '/zywdetail/' + sourceID + '.html',
    base + '/detail/' + sourceID + '.html',
  ],
});