// 发果（faguo）站源 —— Go 版 provider_duanju_maccms.go + provider_duanju_dispatch.go 的 JS 移植。
//
// maccms 模板 HTML 站源，纯 HTTPS 抓取 + HTML 解析，不需要 TLS 指纹伪装，返回直链 m3u8，不需要 ffmpeg。
// 注意：从本环境测试 faguo（www.xzyx168.com）不可达（000），但代码已完整移植，网络恢复后即可使用。

import { createMaccmsSource } from './maccms.js';

const BASE = 'https://www.xzyx168.com';

export default createMaccmsSource({
  sourceId: 'faguo',
  sourceName: '发果',
  base: BASE,
  categories: [{ id: '', name: '全部' }],
  firstCategory: '',
  categoryURL: (base, category, page) => {
    const pageNumber = Number(page) || 1;
    const classID = String(category || '').trim();
    if (classID === '') {
      return base + '/xzyxvt/' + pageNumber + 'zmn.html';
    }
    if (classID.includes('zmn')) {
      const prefix = classID.split('zmn', 2)[0];
      return base + prefix + pageNumber + 'zmn.html';
    }
    throw new Error('发果分类无效');
  },
  searchURL: (base, query) => base + '/xzyxvc/' + encodeURIComponent(query) + '-wdyswzqun1num.html',
  detailCandidates: (source, base, sourceID) => [
    base + '/xzyxvd/' + sourceID + '.html',
    base + '/detail/' + sourceID + '.html',
    base + '/voddetail/' + sourceID + '.html',
  ],
});