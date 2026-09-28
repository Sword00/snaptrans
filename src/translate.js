'use strict';
/**
 * 翻译通道
 *  - free: Edge(必应) / Google / MyMemory 三个免费接口，按顺序自动降级
 *  - llm : 任意 OpenAI 兼容大模型（效果最自然，可复现「WorkBuddy → 工作伙伴」这类意译）
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const LANG_TABLE = {
  'zh-Hans': { bing: 'zh-Hans', google: 'zh-CN', mymemory: 'zh-CN', youdao: 'zh-CHS', name: '简体中文' },
  'zh-Hant': { bing: 'zh-Hant', google: 'zh-TW', mymemory: 'zh-TW', youdao: 'zh-CHT', name: '繁體中文' },
  en: { bing: 'en', google: 'en', mymemory: 'en', youdao: 'en', name: 'English' },
  ja: { bing: 'ja', google: 'ja', mymemory: 'ja', youdao: 'ja', name: '日本語' },
  ko: { bing: 'ko', google: 'ko', mymemory: 'ko', youdao: 'ko', name: '한국어' },
  fr: { bing: 'fr', google: 'fr', mymemory: 'fr', youdao: 'fr', name: 'Français' },
  de: { bing: 'de', google: 'de', mymemory: 'de', youdao: 'de', name: 'Deutsch' },
  es: { bing: 'es', google: 'es', mymemory: 'es', youdao: 'es', name: 'Español' },
  ru: { bing: 'ru', google: 'ru', mymemory: 'ru', youdao: 'ru', name: 'Русский' },
  pt: { bing: 'pt', google: 'pt', mymemory: 'pt', youdao: 'pt', name: 'Português' },
  it: { bing: 'it', google: 'it', mymemory: 'it', youdao: 'it', name: 'Italiano' },
  ar: { bing: 'ar', google: 'ar', mymemory: 'ar', youdao: 'ar', name: 'العربية' },
  th: { bing: 'th', google: 'th', mymemory: 'th', youdao: 'th', name: 'ไทย' },
  vi: { bing: 'vi', google: 'vi', mymemory: 'vi', youdao: 'vi', name: 'Tiếng Việt' },
};

const TARGET_LANGS = Object.keys(LANG_TABLE).map((code) => ({ code, name: LANG_TABLE[code].name }));

function mapLang(code, provider) {
  const e = LANG_TABLE[code];
  if (!e) return code;
  return e[provider] || code;
}

function langName(code) {
  return (LANG_TABLE[code] && LANG_TABLE[code].name) || code;
}

function guessLang(text) {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
  const cjk = (text.match(/[\u2e80-\u9fff]/g) || []).length;
  if (cjk / Math.max(1, text.length) > 0.12) return 'zh-CN';
  return 'en';
}

function withTimeout(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('请求超时')), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

/** 带并发上限的 map，顺序与输入一致 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

/* ---------------- 有道（免 Key，国内快且稳） ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 有道的公开 demo 接口有配额，触发 411 后冷却一段时间，避免每次都白等重试
let youdaoBlockedUntil = 0;
const YOUDAO_COOLDOWN = 10 * 60 * 1000;

async function youdaoOne(text, from, to, attempt) {
  const body = new URLSearchParams({
    q: text.slice(0, 4800),
    from: from && from !== 'auto' ? mapLang(from, 'youdao') : 'auto',
    to: mapLang(to, 'youdao'),
  }).toString();
  const res = await fetch('https://aidemo.youdao.com/trans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body,
  });
  if (!res.ok) throw new Error('有道翻译 HTTP ' + res.status);
  const data = await res.json();
  const code = data.errorCode == null ? '0' : String(data.errorCode);
  if (code !== '0') {
    // 411 = 访问频率/配额受限，短暂退避重试
    if (code === '411' && attempt < 2) {
      await sleep(400 * (attempt + 1));
      return youdaoOne(text, from, to, attempt + 1);
    }
    if (code === '411') youdaoBlockedUntil = Date.now() + YOUDAO_COOLDOWN;
    throw new Error('有道翻译错误码 ' + code);
  }
  const arr = data.translation;
  if (!Array.isArray(arr) || !arr.length) throw new Error('有道翻译返回为空');
  return arr.join('');
}

async function youdaoTranslate(texts, from, to) {
  if (Date.now() < youdaoBlockedUntil) throw new Error('有道翻译额度冷却中，跳过');
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    if (i > 0) await sleep(70); // 串行 + 轻微间隔，规避频率限制
    // eslint-disable-next-line no-await-in-loop
    out.push(await youdaoOne(texts[i], from, to, 0));
  }
  return out;
}

/* ---------------- Edge / 必应（免 Key，部分网络下已失效） ---------------- */
let edgeToken = null;
let edgeTokenAt = 0;

async function getEdgeToken(force) {
  if (!force && edgeToken && Date.now() - edgeTokenAt < 8 * 60 * 1000) return edgeToken;
  const res = await fetch('https://edge.microsoft.com/translate/auth', {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error('获取必应令牌失败 HTTP ' + res.status);
  edgeToken = (await res.text()).trim();
  edgeTokenAt = Date.now();
  return edgeToken;
}

async function edgeTranslate(texts, from, to) {
  const doCall = async (token) => {
    const params = new URLSearchParams({ 'api-version': '3.0', to, textType: 'plain' });
    if (from && from !== 'auto') params.set('from', from);
    const res = await fetch('https://api-edge.cognitive.microsofttranslator.com/translate?' + params, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        'User-Agent': UA,
      },
      body: JSON.stringify(texts.map((t) => ({ Text: t }))),
    });
    if (!res.ok) throw new Error('必应翻译 HTTP ' + res.status);
    const data = await res.json();
    return data.map((d) => (d.translations && d.translations[0] && d.translations[0].text) || '');
  };
  try {
    return await doCall(await getEdgeToken(false));
  } catch (e) {
    edgeToken = null;
    return await doCall(await getEdgeToken(true));
  }
}

/* ---------------- Google（免 Key） ---------------- */
async function googleTranslateOne(text, from, to) {
  const sl = from && from !== 'auto' ? from : 'auto';
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' +
    `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(to)}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('Google 翻译 HTTP ' + res.status);
  const data = await res.json();
  return (data[0] || []).map((seg) => seg[0]).join('');
}

async function googleTranslate(texts, from, to) {
  return mapLimit(texts, 4, (t) => googleTranslateOne(t, from, to));
}

/* ---------------- MyMemory（免 Key） ---------------- */
async function mymemoryOne(t, from, to) {
  const src = from && from !== 'auto' ? from : guessLang(t);
  // 源语言 == 目标语言时 MyMemory 会直接报错，原样返回即可
  if (src.split('-')[0].toLowerCase() === String(to).split('-')[0].toLowerCase()) return t;
  const url =
    'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(t.slice(0, 480)) +
    '&langpair=' +
    encodeURIComponent(src + '|' + to);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('MyMemory HTTP ' + res.status);
  const data = await res.json();
  const txt = data && data.responseData && data.responseData.translatedText;
  if (!txt) throw new Error('MyMemory 返回为空');
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(txt)) throw new Error('MyMemory 额度受限');
  return txt;
}

async function mymemoryTranslate(texts, from, to) {
  return mapLimit(texts, 4, (t) => mymemoryOne(t, from, to));
}

/* ---------------- 免费通道总入口 ---------------- */
const FREE_PROVIDERS = {
  youdao: youdaoTranslate,
  mymemory: mymemoryTranslate,
  edge: edgeTranslate,
  google: googleTranslate,
};

// 按实测可用性排序：国内网络下 有道 最稳最快，其次 MyMemory；
// 必应/Edge 的公开端点已大面积返回 404，Google 在境内不可达，放在最后兜底。
const AUTO_ORDER = ['youdao', 'mymemory', 'edge', 'google'];

async function freeTranslate(texts, from, to, prefer) {
  const order = prefer && prefer !== 'auto' ? [prefer, ...AUTO_ORDER] : AUTO_ORDER;
  const uniq = [...new Set(order)];
  const errors = [];
  for (const name of uniq) {
    const fn = FREE_PROVIDERS[name];
    if (!fn) continue;
    try {
      const mappedFrom = from && from !== 'auto' ? mapLang(from, name) : 'auto';
      const mappedTo = mapLang(to, name);
      const out = await fn(texts, mappedFrom, mappedTo);
      if (Array.isArray(out) && out.length === texts.length && out.some((s) => s && s.trim())) {
        return { provider: name, texts: out };
      }
      errors.push(`${name}: 返回数量不符`);
      console.warn('[translate]', name, '返回数量不符');
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
      console.warn('[translate]', name, '失败：', e.message);
    }
  }
  const err = new Error('免费翻译通道全部失败：' + errors.join(' / '));
  err.details = errors;
  throw err;
}

/* ---------------- LLM 通道 ---------------- */
const LLM_SYSTEM = [
  '你是一个截图文字翻译引擎。用户会给你一个 JSON：{"target":"目标语言","items":["原文1","原文2"]}。',
  '请把 items 中每一项翻译成 target 指定的语言。',
  '硬性要求：',
  '1. 只输出 JSON，格式为 {"translations":["译文1","译文2"]}，不要输出任何解释、不要用 markdown 代码块。',
  '2. 逐项翻译，顺序与数量必须和 items 完全一致，不要合并、不要拆分、不要增删。',
  '3. 如果某项本身已经是目标语言，原样返回该项。',
  '4. 保留原文中的数字、单位、代码、URL、emoji 与标点风格。',
  '5. 译文要口语自然、符合软件界面文案习惯，长度尽量与原文接近，避免明显变长。',
  '6. 品牌名、产品名按目标语言的通用习惯处理（例如英文品牌名在中文语境下可用常见中文称呼）。',
].join('\n');

function pickJSON(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

async function llmTranslate(texts, from, to, cfg) {
  if (!cfg || !cfg.apiKey) throw new Error('未配置大模型 API Key（设置 → 翻译引擎）');
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置大模型接口地址');
  const url = base + '/chat/completions';

  const userPayload = JSON.stringify({ target: langName(to), items: texts });

  const call = async (useJsonMode) => {
    const body = {
      model: cfg.model || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: LLM_SYSTEM },
        { role: 'user', content: userPayload },
      ],
    };
    if (useJsonMode) body.response_format = { type: 'json_object' };

    const t = withTimeout(60000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify(body),
        signal: t.signal,
      });
    } finally {
      t.done();
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`大模型接口 HTTP ${res.status} ${txt.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const json = pickJSON(content);
    if (!json || !Array.isArray(json.translations)) {
      throw new Error('大模型返回格式无法解析：' + String(content || '').slice(0, 200));
    }
    return json.translations.map((s) => String(s == null ? '' : s));
  };

  try {
    return { provider: 'llm', texts: await call(true) };
  } catch (e) {
    // 有些模型不支持 response_format，退回普通模式再试一次
    if (e.status && e.status !== 400 && e.status !== 404 && e.status !== 422) throw e;
    return { provider: 'llm', texts: await call(false) };
  }
}

/* ---------------- 统一入口 ---------------- */
async function translate(texts, { from = 'auto', to = 'zh-Hans', engine = 'free', freeProvider = 'auto', llm = {} } = {}) {
  const list = texts.map((t) => String(t == null ? '' : t));
  const idx = [];
  const payload = [];
  list.forEach((t, i) => {
    if (t.trim()) { idx.push(i); payload.push(t); }
  });
  if (!payload.length) return { provider: engine, texts: list };

  let res;
  if (engine === 'llm') {
    res = await llmTranslate(payload, from, to, llm);
  } else {
    res = await freeTranslate(payload, from, to, freeProvider);
  }
  const out = list.slice();
  idx.forEach((origIdx, k) => { out[origIdx] = res.texts[k] || list[origIdx]; });
  return { provider: res.provider, texts: out };
}

/** 连通性自检，用于设置面板 */
async function selfTest({ engine, freeProvider, llm, to }) {
  const sample = ['Hello, world!'];
  const t0 = Date.now();
  const r = await translate(sample, { from: 'auto', to: to || 'zh-Hans', engine, freeProvider, llm });
  return { ok: true, provider: r.provider, sample: r.texts[0], ms: Date.now() - t0 };
}

module.exports = { translate, selfTest, TARGET_LANGS, langName, guessLang, mapLang };
