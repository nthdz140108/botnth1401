const hosts = {
  'tiktok.com': 'tiktok', 'douyin.com': 'douyin', 'capcut.com': 'capcut',
  'youtube.com': 'youtube', 'youtu.be': 'youtube', 'facebook.com': 'facebook', 'fb.watch': 'facebook',
  'fb.com': 'facebook', 'instagram.com': 'instagram', 'threads.net': 'threads', 'threads.com': 'threads',
  'x.com': 'twitter', 'twitter.com': 'twitter', 'pinterest.com': 'pinterest', 'pin.it': 'pinterest',
  'reddit.com': 'reddit', 'v.redd.it': 'reddit', 'vimeo.com': 'vimeo', 'dailymotion.com': 'dailymotion',
  'bilibili.com': 'bilibili', 'b23.tv': 'bilibili', 'soundcloud.com': 'soundcloud', 'spotify.com': 'spotify',
  'xiaohongshu.com': 'xiaohongshu', 'xhslink.com': 'xiaohongshu', 'weibo.com': 'weibo',
  'espn.com': 'espn', 'imdb.com': 'imdb', 'imgur.com': 'imgur', 'ifunny.co': 'ifunny',
  'izlesene.com': 'izlesene', 'snapchat.com': 'snapchat', 'sharechat.com': 'sharechat', 'likee.video': 'likee',
  'linkedin.com': 'linkedin', 'tumblr.com': 'tumblr', 'hipi.co.in': 'hipi', 't.me': 'telegram', 'telegram.org': 'telegram',
  'getstickerpack.com': 'getstickerpack', 'bitchute.com': 'bitchute', 'febspot.com': 'febspot', '9gag.com': '9gag',
  'rumble.com': 'rumble', 'streamable.com': 'streamable', 'ted.com': 'ted', 'sohu.com': 'sohutv',
  'ixigua.com': 'ixigua', 'sina.com': 'sina', 'miaopai.com': 'miaopai', 'meipai.com': 'meipai',
  'xiaoying.tv': 'xiaoying', 'national.video': 'national', 'yingke.com': 'yingke', 'mixcloud.com': 'mixcloud',
  'deezer.com': 'deezer', 'zingmp3.vn': 'zingmp3', 'bandcamp.com': 'bandcamp', 'kuaishou.com': 'kuaishou',
  'qq.com': 'qq', 'bsky.app': 'bluesky',
  'vk.com': 'vk-vkvideo', 'vk.ru': 'vk-vkvideo', 'vkvideo.ru': 'vk-vkvideo', 'ok.ru': 'oke',
};
export function platformFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return Object.entries(hosts).find(([host]) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))?.[1] || null;
  } catch { return null; }
}
export function messageTextParts(message) {
  const content = message.data?.content;
  return [message.body, typeof content === 'string' ? content : content?.text, content?.title].filter(v => typeof v === 'string' && v.trim());
}
export function hasCommandPrefix(message, prefix) {
  return messageTextParts(message).some(text => {
    for (const mention of [...(message.data?.mentions || [])].sort((a, b) => b.pos - a.pos)) {
      text = text.slice(0, mention.pos) + text.slice(mention.pos + mention.len);
    }
    return text.trim().toLowerCase().startsWith(prefix.toLowerCase());
  });
}
export function readDownloadLink(message) {
  for (const text of [...messageTextParts(message), message.data?.content?.href]) {
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      const url = match[0].replace(/[),.;!?\]}]+$/, '');
      const platform = platformFromUrl(url);
      if (platform) return { url, platform };
    }
  }
  return null;
}
const claimed = new Map();
export function claimDownloadMessage(botId, message) {
  const now = Date.now();
  for (const [key, expires] of claimed) {
    if (expires <= now || claimed.size > 10000) claimed.delete(key); else break;
  }
  const keys = [['message', message.data?.msgId], ['client', message.data?.cliMsgId]]
    .filter(([, id]) => id != null && String(id) !== '0' && String(id) !== '')
    .map(([kind, id]) => JSON.stringify([String(botId), String(message.threadId), kind, String(id)]));
  if (!keys.length) return false;
  const duplicate = keys.some(key => claimed.has(key));
  // Add the new server ID even when the early client ID already claimed the job.
  for (const key of keys) claimed.set(key, now + 10 * 60 * 1000);
  return !duplicate;
}
