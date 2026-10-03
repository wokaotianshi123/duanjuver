// 伍果（wuguo）站源 —— Go 版 provider_duanju_maccms.go + provider_duanju_dispatch.go 的 JS 移植。
//
// maccms 模板 HTML 站源，纯 HTTPS 抓取 + HTML 解析，不需要 TLS 指纹伪装，返回直链 m3u8，不需要 ffmpeg。
// 注意：从本环境测试 wuguo（www.duanju55.com）不可达（000），但代码已完整移植，网络恢复后即可使用。

import { createMaccmsSource } from './maccms.js';

const BASE = 'https://www.duanju55.com';

export default createMaccmsSource({
  sourceId: 'wuguo',
  sourceName: '伍果',
  base: BASE,
  categories: [{ id: '', name: '全部' }],
  firstCategory: '',
  categoryURL: (base, category, page) => {
    const pageNumber = Number(page) || 1;
    const classID = String(category || '').trim();
    if (classID === '') {
      return base + '/';
    }
    const path = classID.endsWith('.html') ? classID : classID + '.html';
    return base + path.replace(/\.html$/, '') + '/page/' + pageNumber + '.html';
  },
  searchURL: (base, query) => base + '/index.php/vod/search/page/1/wd/' + encodeURIComponent(query) + '.html',
  detailCandidates: (source, base, sourceID) => [
    base + '/index.php/vod/detail/id/' + sourceID + '.html',
    base + '/dramaDetail/' + sourceID + '.html',
    base + '/detail/' + sourceID + '.html',
  ],
});