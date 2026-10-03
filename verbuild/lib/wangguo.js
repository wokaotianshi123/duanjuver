// 网果（wangguo）站源 —— Go 版 provider_duanju_maccms.go + provider_duanju_dispatch.go 的 JS 移植。
//
// maccms 模板 HTML 站源，纯 HTTPS 抓取 + HTML 解析，不需要 TLS 指纹伪装，返回直链 m3u8，不需要 ffmpeg。
// 实测 2026-10 可达：https://www.duanju2.com

import { createMaccmsSource } from './maccms.js';

const BASE = 'https://www.duanju2.com';

export default createMaccmsSource({
  sourceId: 'wangguo',
  sourceName: '网果',
  base: BASE,
  categories: [{ id: '', name: '全部' }],
  firstCategory: '',
  categoryURL: (base, category, page) => {
    const pageNumber = Number(page) || 1;
    const classID = String(category || '').trim();
    if (classID === '') {
      return base + '/show/duanju-----------.html';
    }
    const prefix = classID.split('---.html', 2)[0];
    return base + prefix + pageNumber + '---.html';
  },
  searchURL: (base, query) => base + '/search/' + encodeURIComponent(query) + '----------1---.html',
  detailCandidates: (source, base, sourceID) => [
    base + '/vod/' + sourceID + '.html',
    base + '/index.php/vod/detail/id/' + sourceID + '.html',
    base + '/detail/' + sourceID + '.html',
  ],
});