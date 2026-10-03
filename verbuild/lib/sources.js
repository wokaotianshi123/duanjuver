// 站源注册表。
//
// 从 guoapp 项目本地 web 服务移植到 Vercel 时，尽量多移植站源。
// 以下 8 个站源均为纯 HTTPS + JSON/HTML 解析，不需要 TLS 指纹伪装，
// 返回直链 m3u8，不需要 ffmpeg 转码，在 Vercel Serverless Functions 上均可运行。
//
// 未移植的站源及原因：
//   - 红果/黄果/黄果视频/黄果AI/野果/猫果/皮果/合果/花果(部分) 等：
//     依赖 Chrome TLS 指纹（tls-client/utls）绕过风控，Workers 无法模拟。
//   - 黄果/黄果视频/黄果AI/云front/帝果 等：加密流 + ffmpeg 转码，Workers 无 ffmpeg。
//   - 皮果：maccms 模板但需要 TLS 指纹。
//   - 汉笑泉/黄豆/撒拉尼/鬼片：需要登录态或特殊协议，暂未移植。
//
// 若需继续扩展，只需在此处与 _lib 下新增同鱼类模块即可。

import * as ikanbot from './ikanbot.js';
import * as fanguo from './fanguo.js';
import * as xingguo from './xingguo.js';
import * as niuguo from './niuguo.js';
import huaguo from './huaguo.js';
import faguo from './faguo.js';
import wuguo from './wuguo.js';
import wangguo from './wangguo.js';

const REGISTRY = [
  ikanbot,
  fanguo,
  xingguo,
  niuguo,
  huaguo,
  faguo,
  wuguo,
  wangguo,
];

export function allSources() {
  return REGISTRY.map((item) => ({ id: item.SOURCE_ID, name: item.SOURCE_NAME }));
}

export function getSource(id) {
  return REGISTRY.find((item) => item.SOURCE_ID === id) || null;
}

export function sourceNames() {
  const map = {};
  for (const item of REGISTRY) {
    map[item.SOURCE_ID] = item.SOURCE_NAME;
  }
  return map;
}

export function unauthorizedSource(id) {
  return new Error('当前网页版不包含此站源' + (id ? '（' + id + '）' : ''));
}