'use strict';
/**
 * 翻译接口连通性探测：在国内网络下挨个打一遍，看到底哪些能用。
 * 用法：node scripts/probe-net.js
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TEXT = 'WorkBuddy, 我帮你';

async function timed(name, fn) {
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`✓ ${name}  (${Date.now() - t}ms)  →  ${JSON.stringify(r).slice(0, 160)}`);
    return true;
  } catch (e) {
    console.log(`✗ ${name}  (${Date.now() - t}ms)  →  ${e.message}`);
    return false;
  }
}

const withTimeout = (ms) => {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(new Error('超时 ' + ms + 'ms')), ms);
  return { signal: ac.signal, done: () => clearTimeout(id) };
};

async function get(url, opt = {}) {
  const t = withTimeout(opt.timeout || 8000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...(opt.headers || {}) }, signal: t.signal, method: opt.method || 'GET', body: opt.body });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 80)}`);
    return text;
  } finally { t.done(); }
}

(async () => {
  console.log('探测翻译接口可用性…\n');

  await timed('必应/Edge auth', async () => {
    const t = await get('https://edge.microsoft.com/translate/auth');
    return t.trim().slice(0, 40) + '…';
  });

  await timed('必应/Edge translate', async () => {
    const token = (await get('https://edge.microsoft.com/translate/auth')).trim();
    const res = await get(
      'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans&textType=plain',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify([{ Text: 'Hello, world!' }]),
      }
    );
    return JSON.parse(res)[0].translations[0].text;
  });

  await timed('有道 aidemo', async () => {
    const body = new URLSearchParams({ q: TEXT, from: 'auto', to: 'zh-CHS' }).toString();
    const res = await get('https://aidemo.youdao.com/trans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return JSON.parse(res).translation;
  });

  await timed('有道 fanyi(html)', async () => {
    const res = await get('https://fanyi.youdao.com/translate?&doctype=json&type=AUTO&i=' + encodeURIComponent(TEXT));
    return JSON.parse(res).translateResult;
  });

  await timed('Google gtx', async () => {
    const res = await get('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' + encodeURIComponent('Hello, world!'));
    return JSON.parse(res)[0].map((x) => x[0]).join('');
  });

  await timed('MyMemory', async () => {
    const res = await get('https://api.mymemory.translated.net/get?q=' + encodeURIComponent('Hello, world!') + '&langpair=en|zh-CN');
    return JSON.parse(res).responseData.translatedText;
  });

  console.log('\n完成。');
  process.exit(0);
})();
