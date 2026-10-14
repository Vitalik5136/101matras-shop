// 101matras — інтернет-магазин. Увесь сервер і сайт в одному файлі.
// Потрібні лише два файли: server.js і package.json.
'use strict';
const __m = {};
function __req(n) { return __m[n]; }

// ===== settings.js =====
__m['settings'] = (function () { const module = { exports: {} }; const exports = module.exports;
// Усі налаштування магазину. Секретні ключі задаються НЕ тут, а у змінних середовища
// (на Railway: вкладка Variables / «Змінні»). Тут — значення за замовчуванням.

const env = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

module.exports = {
  port: +env('PORT', 3000),
  // Адреса вигрузки Хорошопа (YML/XML)
  feedUrl: env('FEED_URL', 'https://101matras.ua/content/export/bf5ada79a4036e96ecc39bc3173ff7a2.xml'),
  // Як часто оновлювати каталог, хвилин
  feedRefreshMin: +env('FEED_REFRESH_MIN', 180),
  // Публічна адреса магазину (потрібна для повернення з оплати). Якщо не задана — визначається автоматично.
  publicUrl: env('PUBLIC_URL', '').replace(/\/$/, ''),

  // Ціна курʼєрської доставки Новою поштою до дверей, грн (відділення/поштомат — безкоштовно)
  courierPrice: +env('COURIER_PRICE', 700),

  shopName: env('SHOP_NAME', '101matras'),
  shopPhone: env('SHOP_PHONE', ''),
  // Пароль для сторінки перевірки /admin
  adminKey: env('ADMIN_KEY', 'matras2026'),

  // ---- KeyCRM ----
  keycrmToken: env('KEYCRM_API_KEY', ''),
  keycrmSourceId: env('KEYCRM_SOURCE_ID', ''),
  keycrmPaymentMethodId: env('KEYCRM_PAYMENT_METHOD_ID', ''),

  // ---- monobank (plata by mono) ----
  monoToken: env('MONO_TOKEN', ''),

  // ---- Нова пошта ----
  npApiKey: env('NP_API_KEY', ''),

  // ---- Telegram (запасне сповіщення про кожне замовлення, необовʼязково) ----
  tgBotToken: env('TG_BOT_TOKEN', ''),
  tgChatId: env('TG_CHAT_ID', ''),

  // Магазини для самовивозу. Можна перевизначити змінною STORES: назви через «;»
  stores: env('STORES', 'Харків, ТЦ «Маршал»;Харків, ТЦ «Феромон»;Люботин;Львів;Івано-Франківськ')
    .split(';').map((s) => s.trim()).filter(Boolean),
};

return module.exports; })();

// ===== feed.js =====
__m['feed'] = (function () { const module = { exports: {} }; const exports = module.exports;
// Розбір XML-вигрузки Хорошопа (YML) у каталог магазину.
// Кожен <offer> — це окремий розмір; offer-и з однаковим group_id — одна модель.

const TYPE_NAMES = {
  mattresses: 'Матраци',
  toppers: 'Топери',
  kids: 'Дитячі матраци',
  protectors: 'Наматрацники',
  pillows: 'Подушки',
  blankets: 'Ковдри',
  other: 'Інше',
};
const TYPE_ORDER = ['mattresses', 'toppers', 'kids', 'protectors', 'pillows', 'blankets', 'other'];

// Позиції «розмір під замовлення / за м²» не продаємо онлайн — у них ціна за м², а не за штуку.
const CUSTOM_RE = /(під|под)\s*замов|на\s*замовлення|под\s*заказ|(розмір|размер)\s*(під|под)|м2\b|м²/i;
const SIZE_RE = /(\d{2,3})\s*[хХxX×*]\s*(\d{2,3})(\s*(см|cm)\.?)?/;

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attrs(str) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(str))) out[m[1]] = decodeEntities(m[2]);
  return out;
}

function tagText(body, tag) {
  const m = body.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(m[1]).trim() : '';
}
function tagAll(body, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(body))) out.push(decodeEntities(m[1]).trim());
  return out;
}

// ---------- безпечний HTML для опису ----------
const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'h2', 'h3', 'h4', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img', 'span', 'div', 'sup', 'sub']);
function sanitizeHtml(html) {
  if (!html) return '';
  let s = html
    .replace(/<(script|style|iframe|object|embed|form|noscript|svg|video|audio)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (full, tag, rest) => {
    const t = tag.toLowerCase();
    const closing = full.startsWith('</');
    if (!ALLOWED.has(t)) return '';
    if (t === 'h2') return closing ? '</h3>' : '<h3>';
    if (closing) return `</${t}>`;
    if (t === 'img') {
      const a = attrs(rest);
      if (!a.src || !/^https:\/\//i.test(a.src)) return '';
      return `<img src="${a.src.replace(/"/g, '')}" alt="" loading="lazy">`;
    }
    return `<${t}>`;
  });
  s = s
    .replace(/<p>(\s|&nbsp;|<br>)*<\/p>/gi, '')
    .replace(/(<br>\s*){3,}/gi, '<br><br>')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s;
}

function plainText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

// ---------- характеристики з тексту опису ----------
function extractAttrs(text, type) {
  const a = {};
  const t = text.replace(/\n/g, ' ');
  if (type === 'mattresses' || type === 'kids' || type === 'toppers') {
    if (/безпружин|беспружин/i.test(t)) a.spring = 'Безпружинний';
    else if (/пружинн|пружин(ний|ному)\s*бло|pocket|покет|bonnel|боннел|незалежн\S*\s+пружин/i.test(t)) a.spring = 'Пружинний';
    if (type === 'toppers') delete a.spring;
  }
  const th = t.replace(/\((?:допуск)?\s*\+\s*\/?\s*-?\s*\d+\s*(?:мм|см)\)/gi, ' ').replace(/\+\s*\/\s*-\s*\d+\s*(?:мм|см)/gi, ' ');
  let m = th.match(/висот\S*[^\d]{0,45}?(\d{1,2}(?:[.,]\d)?)\s*см/i);
  if (m && type !== 'protectors' && type !== 'blankets') {
    const h = parseFloat(m[1].replace(',', '.'));
    if (h >= 2 && h <= 45) a.height = h;
  }
  m = t.match(/жорсткіст\S*\s*:\s*([^;.\n]{3,50})/i);
  if (m) {
    const f = m[1].replace(/^[\s:–-]+/, '').trim();
    if (f && /м[’'`]?я?к|середн|жорстк|комфорт|тверд/i.test(f)) {
      a.firmness = f.charAt(0).toUpperCase() + f.slice(1);
      const tags = [];
      const g = f.replace(/жорсткост\S*/gi, '');
      if (/м[’'`]?я?кий|м[’'`]?як|м'кий/i.test(g)) tags.push("М'яка");
      if (/середн|комфорт/i.test(g)) tags.push('Середня');
      if (/жорстк|тверд/i.test(g)) tags.push('Жорстка');
      if (tags.length) a.firmTags = tags;
    }
  }
  m = t.match(/навантаження\S*[^\d]{0,30}?(\d{2,3})\s*кг/i);
  if (m) a.load = +m[1];
  else if (/навантаження\S*\s*:?\s*без\s+обмеж/i.test(t)) a.load = 'без обмеження';
  if (/вакуумн|у\s+рулон|в\s+рулон|скрутк/i.test(t)) a.roll = true;
  return a;
}

function detectType(name, categoryId) {
  const n = name.toLowerCase();
  if (/^(топп?ер|міні[\s-]*матра|мини[\s-]*матра)/.test(n)) return 'toppers';
  if (/^(наматра|чохол)/.test(n)) return 'protectors';
  if (/подушк/.test(n) && !/^матра/.test(n)) return 'pillows';
  if (/ковдр|одеял|плед/.test(n)) return 'blankets';
  if (categoryId === '1068' || /дитяч|детск/.test(n)) return 'kids';
  if (/^матра/.test(n)) return 'mattresses';
  return { '1062': 'protectors', '1063': 'blankets', '1064': 'pillows', '1061': 'mattresses' }[categoryId] || 'other';
}

function cleanName(name, sizeMatch) {
  let s = name;
  if (sizeMatch) s = s.replace(sizeMatch[0], ' ');
  return s.replace(/\(\s*\)/g, '').replace(/\s+[-–,]\s*$/, '').replace(/\s{2,}/g, ' ').trim();
}

function num(v) {
  const n = parseFloat(String(v || '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function parseFeed(xml) {
  const offers = [];
  const re = /<offer\b([^>]*)>([\s\S]*?)<\/offer>/g;
  let m;
  while ((m = re.exec(xml))) {
    const at = attrs(m[1]);
    const body = m[2];
    offers.push({
      id: at.id,
      group: at.group_id || at.id,
      available: at.available === 'true',
      url: tagText(body, 'url'),
      price: num(tagText(body, 'price')),
      oldprice: num(tagText(body, 'oldprice')),
      categoryId: tagText(body, 'categoryId'),
      pictures: tagAll(body, 'picture'),
      sku: tagText(body, 'vendorCode'),
      vendor: tagText(body, 'vendor').replace(/\s+/g, ' ').trim(),
      name: tagText(body, 'name').replace(/\s+/g, ' ').trim(),
      description: tagText(body, 'description'),
      warranty: (body.match(/<param[^>]*name="Гарантия"[^>]*>([^<]*)<\/param>/) || [])[1] || '',
    });
  }

  const groups = new Map();
  let skippedCustom = 0;
  for (const o of offers) {
    if (!o.id || !o.price) continue;
    if (CUSTOM_RE.test(o.name)) { skippedCustom++; continue; }
    if (!groups.has(o.group)) groups.set(o.group, []);
    groups.get(o.group).push(o);
  }

  const products = [];
  const descriptions = {};
  const variantIndex = {};
  for (const [gid, list] of groups) {
    const first = list[0];
    const desc = list.find((o) => o.description)?.description || '';
    const type = detectType(first.name, first.categoryId);
    const sm = first.name.match(SIZE_RE);
    const name = cleanName(first.name, sm);
    const groupPics = first.pictures;

    let variants = list.map((o) => {
      const s = o.name.match(SIZE_RE);
      const v = {
        id: o.id,
        label: s ? `${s[1]}×${s[2]}` : '',
        w: s ? +s[1] : 0,
        l: s ? +s[2] : 0,
        price: o.price,
        old: o.oldprice > o.price ? o.oldprice : 0,
        av: o.available,
        sku: o.sku,
      };
      if (o.pictures.length && o.pictures.join() !== groupPics.join()) v.pics = o.pictures;
      return v;
    });
    // однакові підписи (або без розміру) — беремо відмінну частину назви
    const counts = {};
    variants.forEach((v) => (counts[v.label] = (counts[v.label] || 0) + 1));
    const words = list.map((o) => o.name.split(' '));
    let common = 0;
    while (words.every((w) => w[common] !== undefined && w[common] === words[0][common])) common++;
    variants.forEach((v, i) => {
      if (!v.label || counts[v.label] > 1) {
        // відмінна частина назви без розміру — це «варіант» (тканина, тип кріплення, вага ковдри…)
        const rest = words[i].slice(common).join(' ').replace(SIZE_RE, ' ').replace(/\s+см\b/g, ' ').replace(/\s{2,}/g, ' ').trim();
        if (v.label) v.opt = rest || 'Стандарт';
        else v.label = rest || 'Стандарт';
      }
    });
    variants.sort((a, b) => a.w - b.w || a.l - b.l || a.price - b.price);
    const hasOpts = variants.some((v) => v.opt) || (variants.length > 1 && variants.every((v) => !v.w));

    const text = plainText(desc);
    const prices = variants.map((v) => v.price);
    const minPrice = Math.min(...prices);
    const cheapest = variants.find((v) => v.price === minPrice);
    const maxDisc = Math.max(0, ...variants.map((v) => (v.old ? Math.round((1 - v.price / v.old) * 100) : 0)));

    const p = {
      id: gid,
      name: hasOpts && common >= 2 ? words[0].slice(0, common).join(' ') : name,
      brand: first.vendor,
      type,
      pics: groupPics.length ? groupPics : (variants.find((v) => v.pics)?.pics || []),
      minPrice,
      maxPrice: Math.max(...prices),
      oldMin: cheapest.old || 0,
      disc: maxDisc,
      inStock: variants.some((v) => v.av),
      warranty: first.warranty,
      siteUrl: first.url,
      attrs: extractAttrs(text, type),
      variants,
    };
    products.push(p);
    descriptions[gid] = sanitizeHtml(desc);
    for (const v of variants) variantIndex[v.id] = { product: p, variant: v };
  }

  products.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || (b.inStock - a.inStock) || b.disc - a.disc);

  const categories = TYPE_ORDER.map((id) => ({ id, name: TYPE_NAMES[id], count: products.filter((p) => p.type === id).length }))
    .filter((c) => c.count);

  return {
    products,
    descriptions,
    variantIndex,
    categories,
    stats: { offers: offers.length, models: products.length, variants: Object.keys(variantIndex).length, skippedCustom },
  };
}

module.exports = { parseFeed, sanitizeHtml, extractAttrs, TYPE_NAMES };

return module.exports; })();

// ===== keycrm.js =====
__m['keycrm'] = (function () { const module = { exports: {} }; const exports = module.exports;
// Мінімальний клієнт KeyCRM OpenAPI (https://openapi.keycrm.app/v1)
const S = __req('settings');

const BASE = process.env.KEYCRM_BASE_URL || 'https://openapi.keycrm.app/v1';

async function request(method, path, body) {
  if (!S.keycrmToken) throw new Error('KEYCRM_API_KEY не задано');
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${S.keycrmToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`KeyCRM ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const list = async (path) => {
  const d = await request('GET', `${path}${path.includes('?') ? '&' : '?'}limit=50`);
  return Array.isArray(d) ? d : d.data || [];
};

let cachedSourceId = null;
async function resolveSourceId() {
  if (S.keycrmSourceId) return +S.keycrmSourceId;
  if (cachedSourceId) return cachedSourceId;
  // Якщо ID не задано — шукаємо джерело з назвою «сайт / магазин / site / shop»
  const sources = await list('/order/source');
  const found = sources.find((s) => /сайт|site|магазин|shop|web/i.test(`${s.name} ${s.alias || ''}`)) || sources[0];
  cachedSourceId = found ? found.id : null;
  return cachedSourceId;
}

let lastError = null; // остання помилка KeyCRM — показуємо на сторінці /admin

async function createOrder(payload) {
  let source_id = null;
  try { source_id = await resolveSourceId(); } catch (e) { console.error('[keycrm] джерела:', e.message); }
  const body = { ...payload };
  if (source_id) body.source_id = source_id;
  try {
    const r = await request('POST', '/order', body);
    lastError = null;
    return r;
  } catch (e) {
    lastError = { at: new Date().toISOString(), message: e.message };
    // ключ невірний — повторювати немає сенсу
    if (e.status === 401 || e.status === 403) throw e;
    console.error('[keycrm] повне замовлення відхилено, пробую спрощене:', e.message);
    // Спрощене замовлення: лише покупець і товари, усе інше — в коментар менеджеру
    const sh = payload.shipping || {};
    const simple = {
      ...(source_id ? { source_id } : {}),
      source_uuid: payload.source_uuid,
      buyer: payload.buyer,
      manager_comment: [
        payload.manager_comment,
        `Отримувач: ${sh.recipient_full_name || ''} ${sh.recipient_phone || ''}`,
        sh.shipping_address_city ? `Місто: ${sh.shipping_address_city}` : '',
        sh.shipping_receive_point ? `Відділення / магазин: ${sh.shipping_receive_point}` : '',
        sh.shipping_secondary_line ? `Адреса: ${sh.shipping_secondary_line}` : '',
        payload.buyer_comment ? `Коментар покупця: ${payload.buyer_comment}` : '',
      ].filter(Boolean).join('\n'),
      products: (payload.products || []).map((p) => ({ sku: p.sku, name: p.name, price: p.price, quantity: p.quantity })),
    };
    try {
      const r = await request('POST', '/order', simple);
      lastError = { ...lastError, note: 'повне замовлення не пройшло, спрощене — пройшло' };
      return r;
    } catch (e2) {
      lastError = { at: new Date().toISOString(), message: e2.message, first: e.message };
      throw e2;
    }
  }
}

// Позначити замовлення оплаченим
async function addPayment(orderId, { amount, description }) {
  const body = {
    amount,
    status: 'paid',
    description: description || 'Оплата карткою (monobank)',
    payment_date: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  if (S.keycrmPaymentMethodId) body.payment_method_id = +S.keycrmPaymentMethodId;
  else body.payment_method = 'monobank';
  return request('POST', `/order/${orderId}/payment`, body);
}

async function getOrder(orderId) {
  return request('GET', `/order/${orderId}?include=payments`);
}

async function appendManagerComment(orderId, line) {
  try {
    const o = await request('GET', `/order/${orderId}`);
    const prev = o.manager_comment || '';
    return request('PUT', `/order/${orderId}`, { manager_comment: `${prev}${prev ? '\n' : ''}${line}` });
  } catch (e) {
    console.error('[keycrm] comment', e.message);
  }
}

module.exports = {
  lastError: () => lastError,
  request,
  createOrder,
  addPayment,
  getOrder,
  appendManagerComment,
  listSources: () => list('/order/source'),
  listPaymentMethods: () => list('/order/payment-method'),
  listDeliveryServices: () => list('/order/delivery-service'),
};

return module.exports; })();

// ===== monobank.js =====
__m['monobank'] = (function () { const module = { exports: {} }; const exports = module.exports;
// Еквайринг monobank (plata by mono): створення рахунку та перевірка статусу.
const S = __req('settings');

const BASE = process.env.MONO_BASE_URL || 'https://api.monobank.ua';

async function call(method, path, body) {
  if (!S.monoToken) throw new Error('MONO_TOKEN не задано');
  const res = await fetch(BASE + path, {
    method,
    headers: { 'X-Token': S.monoToken, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`monobank ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

// amount — у гривнях; monobank приймає копійки
async function createInvoice({ amount, reference, destination, redirectUrl, webHookUrl }) {
  return call('POST', '/api/merchant/invoice/create', {
    amount: Math.round(amount * 100),
    ccy: 980,
    merchantPaymInfo: { reference: String(reference), destination: destination.slice(0, 280) },
    redirectUrl,
    webHookUrl,
    validity: 60 * 60 * 24,
    paymentType: 'debit',
  });
}

// Статус перевіряємо прямо в банку — тому вебхуку не треба вірити на слово
async function invoiceStatus(invoiceId) {
  return call('GET', `/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`);
}

async function merchantDetails() {
  return call('GET', '/api/merchant/details');
}

module.exports = { createInvoice, invoiceStatus, merchantDetails, enabled: () => !!S.monoToken };

return module.exports; })();

// ===== novaposhta.js =====
__m['novaposhta'] = (function () { const module = { exports: {} }; const exports = module.exports;
// Пошук міст і відділень Нової пошти (для форми оформлення)
const S = __req('settings');

const URL = 'https://api.novaposhta.ua/v2.0/json/';
const cache = new Map();

// Пошук міст і відділень у Нової пошти працює і без ключа.
// Якщо ключ задано, але він прострочений або невірний — повторюємо запит без ключа.
let keyBroken = false;
async function call(apiKey, modelName, calledMethod, methodProperties) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, modelName, calledMethod, methodProperties }),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

async function np(modelName, calledMethod, methodProperties) {
  const key = JSON.stringify([modelName, calledMethod, methodProperties]);
  const hit = cache.get(key);
  if (hit && hit.t > Date.now() - 6 * 3600e3) return hit.v;
  const useKey = S.npApiKey && !keyBroken ? S.npApiKey : '';
  let d = await call(useKey, modelName, calledMethod, methodProperties);
  if (!d.success && useKey && (d.errors || []).some((e) => /api key/i.test(e))) {
    keyBroken = true;
    console.error('[НП] ключ не працює (' + d.errors.join('; ') + ') — шукаю без ключа');
    d = await call('', modelName, calledMethod, methodProperties);
  }
  if (!d.success) throw new Error(`НП ${calledMethod}: ${(d.errors || []).join('; ')}`);
  if (cache.size > 2000) cache.clear();
  cache.set(key, { t: Date.now(), v: d.data });
  return d.data;
}

async function searchCities(q) {
  const data = await np('Address', 'searchSettlements', { CityName: q, Limit: '20', Page: '1' });
  const list = (data[0] && data[0].Addresses) || [];
  return list
    .filter((a) => a.Warehouses > 0 && a.DeliveryCity)
    .map((a) => ({ ref: a.DeliveryCity, name: a.Present }));
}

async function warehouses(cityRef, q = '') {
  const data = await np('Address', 'getWarehouses', { CityRef: cityRef, FindByString: q, Limit: '60', Page: '1', Language: 'UA' });
  return data.map((w) => ({
    ref: w.Ref,
    name: w.Description,
    postomat: /поштомат/i.test(w.CategoryOfWarehouse === 'Postomat' ? 'поштомат' : w.Description),
    maxKg: +w.PlaceMaxWeightAllowed || +w.TotalMaxWeightAllowed || 0,
  }));
}

module.exports = { searchCities, warehouses, enabled: () => process.env.NP_SEARCH !== 'off', keyBroken: () => keyBroken };

return module.exports; })();

// ===== файли сайту =====
const __ASSETS = {"index.html":"<!doctype html>\n<html lang=\"uk\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>101matras</title>\n<!--META-->\n<meta name=\"theme-color\" content=\"#573D79\">\n<link rel=\"icon\" href=\"/favicon.svg\" type=\"image/svg+xml\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Onest:wght@400;500;600&display=swap\" rel=\"stylesheet\">\n<link rel=\"stylesheet\" href=\"/styles.css\">\n</head>\n<body>\n<a class=\"skip\" href=\"#app\">Перейти до вмісту</a>\n<header class=\"top\">\n  <div class=\"top-in wrap\">\n    <a href=\"/\" class=\"logo\" data-link aria-label=\"101matras — на головну\"><span class=\"logo-num\">101</span>matras</a>\n    <form class=\"search\" role=\"search\" data-search>\n      <label class=\"sr\" for=\"q\">Пошук товарів</label>\n      <input id=\"q\" name=\"q\" type=\"search\" placeholder=\"Пошук: матрац, топер, бренд…\" autocomplete=\"off\">\n      <button type=\"submit\" aria-label=\"Шукати\"><svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" aria-hidden=\"true\"><circle cx=\"11\" cy=\"11\" r=\"7\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"m20 20-4.2-4.2\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg></button>\n    </form>\n    <a href=\"/cart\" class=\"cart-btn\" data-link aria-label=\"Кошик\">\n      <svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\" aria-hidden=\"true\"><path d=\"M3 4h2l2.2 11h11l2-8H7\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/><circle cx=\"9\" cy=\"19.5\" r=\"1.5\" fill=\"currentColor\"/><circle cx=\"17\" cy=\"19.5\" r=\"1.5\" fill=\"currentColor\"/></svg>\n      <span class=\"cart-label\">Кошик</span>\n      <span class=\"cart-count\" data-cart-count hidden>0</span>\n    </a>\n  </div>\n  <nav class=\"cats wrap\" aria-label=\"Категорії\" data-cats></nav>\n</header>\n<main id=\"app\" tabindex=\"-1\"><div class=\"loading wrap\">Завантажуємо каталог…</div></main>\n<footer class=\"foot\">\n  <div class=\"wrap foot-in\" data-footer></div>\n</footer>\n<div class=\"toast\" role=\"status\" aria-live=\"polite\" data-toast></div>\n<script src=\"/app.js\"></script>\n</body>\n</html>\n","app.js":"/* 101matras — вітрина: каталог, товар, кошик, оформлення замовлення. Без збірки, чистий JS. */\n(() => {\n  'use strict';\n\n  const DEMO = !!window.__DEMO__; // режим попереднього перегляду (без сервера)\n  const $ = (s, el = document) => el.querySelector(s);\n  const $$ = (s, el = document) => [...el.querySelectorAll(s)];\n  let app = $('#app');\n  function resetApp() { const n = app.cloneNode(false); app.replaceWith(n); app = n; }\n  const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n  const money = (n) => `${Math.round(n).toLocaleString('uk-UA').replace(/,/g, ' ')} грн`;\n  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };\n\n  const state = { config: { stores: [], payOnline: false, npSearch: false, phone: '' }, products: [], byId: {}, variants: {}, categories: [], brands: [], descCache: {} };\n\n  // ------------------------------------------------------------------ API\n  async function api(path, opts = {}) {\n    if (DEMO) return demoApi(path, opts);\n    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });\n    const data = await res.json().catch(() => ({}));\n    if (!res.ok) throw Object.assign(new Error(data.error || 'Помилка зʼєднання'), { data, status: res.status });\n    return data;\n  }\n  function demoApi(path, opts) {\n    const D = window.__DEMO__;\n    if (path === '/api/config') return Promise.resolve(D.config);\n    if (path === '/api/catalog') return Promise.resolve(D.catalog);\n    if (path.startsWith('/api/product/')) {\n      const id = path.split('/').pop();\n      const p = D.catalog.products.find((x) => x.id === id);\n      return Promise.resolve({ ...p, description: D.desc[id] || '' });\n    }\n    if (path === '/api/order') {\n      return new Promise((r) => setTimeout(() => r({ ok: true, ref: 'DEMO1', number: 'ДЕМО', total: JSON.parse(opts.body).items.reduce((s, it) => s + state.variants[it.id].v.price * it.qty, 0), payUrl: null }), 600));\n    }\n    if (path.startsWith('/api/order/')) return Promise.resolve({ found: true, number: 'ДЕМО', paid: false, pay: 'cod' });\n    if (path.startsWith('/api/np/cities')) {\n      const q = decodeURIComponent(path.split('q=')[1] || '').toLowerCase();\n      return Promise.resolve(['Київ', 'Харків', 'Львів', 'Івано-Франківськ', 'Одеса', 'Дніпро'].filter((c) => c.toLowerCase().startsWith(q)).map((c, i) => ({ ref: 'c' + i, name: `м. ${c}` })));\n    }\n    if (path.startsWith('/api/np/warehouses')) return Promise.resolve([1, 2, 3, 4, 5].map((n) => ({ ref: 'w' + n, name: `Відділення №${n}: вул. Центральна, ${n * 7}` })));\n    return Promise.reject(new Error('demo'));\n  }\n\n  // ------------------------------------------------------------------ Кошик\n  const CART_KEY = 'cart101';\n  const store = {\n    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },\n    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },\n  };\n  let cart = store.get(CART_KEY, []);\n  let memCart = null;\n  const getCart = () => memCart || cart;\n  function saveCart(c) { cart = c; memCart = c; store.set(CART_KEY, c); updateCartBadge(); }\n  function addToCart(id, qty = 1) {\n    const c = getCart().slice();\n    const line = c.find((l) => l.id === id);\n    if (line) line.qty = Math.min(20, line.qty + qty); else c.push({ id, qty });\n    saveCart(c);\n  }\n  function cartLines() {\n    return getCart().map((l) => ({ ...l, ...state.variants[l.id] })).filter((l) => l.v);\n  }\n  function updateCartBadge() {\n    const n = cartLines().reduce((s, l) => s + l.qty, 0);\n    const b = $('[data-cart-count]');\n    b.textContent = n;\n    b.hidden = !n;\n  }\n\n  // ------------------------------------------------------------------ Схема ліжка\n  function bedSvg(w, l, size = 34) {\n    if (!w || !l) return '';\n    const max = 220;\n    const bw = Math.max(9, (w / max) * size * 0.95);\n    const bh = Math.max(14, (l / max) * size);\n    const x = (size - bw) / 2;\n    const y = (size - bh) / 2;\n    const pills = w >= 120 ? 2 : 1;\n    const pw = pills === 2 ? (bw - 6) / 2 : Math.min(bw - 4, 12);\n    let p = '';\n    for (let i = 0; i < pills; i++) {\n      const px = pills === 2 ? x + 2 + i * (pw + 2) : x + (bw - pw) / 2;\n      p += `<rect class=\"pillow\" x=\"${px.toFixed(1)}\" y=\"${(y + 2).toFixed(1)}\" width=\"${pw.toFixed(1)}\" height=\"${Math.max(2.5, bh * 0.12).toFixed(1)}\" rx=\"1\"/>`;\n    }\n    return `<svg class=\"bed\" width=\"${size}\" height=\"${size}\" viewBox=\"0 0 ${size} ${size}\" aria-hidden=\"true\"><rect class=\"frame\" x=\"${x.toFixed(1)}\" y=\"${y.toFixed(1)}\" width=\"${bw.toFixed(1)}\" height=\"${bh.toFixed(1)}\" rx=\"2\"/>${p}</svg>`;\n  }\n\n  // ------------------------------------------------------------------ Роутер\n  const routes = [];\n  const route = (re, fn) => routes.push([re, fn]);\n  function currentPath() {\n    if (DEMO) { const h = location.hash.slice(1) || '/'; return h; }\n    return location.pathname + location.search;\n  }\n  function navigate(url, replace = false) {\n    if (DEMO) { if (replace) history.replaceState(null, '', '#' + url); else location.hash = url; if (replace) render(); return; }\n    if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);\n    render();\n  }\n  function render() {\n    const full = currentPath();\n    const [path, qs] = full.split('?');\n    const params = new URLSearchParams(qs || '');\n    resetApp();\n    for (const [re, fn] of routes) {\n      const m = path.match(re);\n      if (m) { fn(m, params); break; }\n    }\n    $$('.cats a').forEach((a) => {\n      const href = a.getAttribute('href').replace(/^#/, '');\n      a.toggleAttribute('aria-current', href === path || (href !== '/' && path.startsWith(href)));\n      if (a.hasAttribute('aria-current')) a.setAttribute('aria-current', 'page');\n    });\n  }\n  const href = (u) => (DEMO ? '#' + u : u);\n  document.addEventListener('click', (e) => {\n    const a = e.target.closest('a[data-link]');\n    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;\n    e.preventDefault();\n    navigate(a.getAttribute('href').replace(/^#/, ''));\n    window.scrollTo(0, 0);\n  });\n  window.addEventListener(DEMO ? 'hashchange' : 'popstate', render);\n\n  function setTitle(t) { document.title = t ? `${t} — 101matras` : '101matras — матраци, топери, подушки, ковдри'; }\n  function toast(html) {\n    const t = $('[data-toast]');\n    t.innerHTML = html;\n    t.classList.add('show');\n    clearTimeout(toast.t);\n    toast.t = setTimeout(() => t.classList.remove('show'), 3800);\n  }\n\n  // ------------------------------------------------------------------ Картка товару\n  function cardHtml(p, sizeSet) {\n    let vs = p.variants;\n    if (sizeSet && sizeSet.size) vs = vs.filter((v) => sizeSet.has(v.label));\n    const min = Math.min(...vs.map((v) => v.price));\n    const cheapest = vs.find((v) => v.price === min);\n    const old = cheapest.old;\n    const inStock = vs.some((v) => v.av);\n    const one = sizeSet && sizeSet.size === 1;\n    const sizeCount = new Set(p.variants.map((v) => v.label)).size;\n    const meta = one ? `Розмір ${esc(cheapest.label)}` : sizeCount > 1 ? `${sizeCount} ${plural(sizeCount, 'розмір', 'розміри', 'розмірів')}` : '';\n    const url = `/p/${p.id}${one ? '?v=' + cheapest.id : ''}`;\n    const disc = old ? Math.round((1 - min / old) * 100) : 0;\n    return `<a class=\"card\" href=\"${href(url)}\" data-link>\n      <div class=\"card-img\">${p.pics[0] ? `<img src=\"${esc(p.pics[0])}\" alt=\"\" loading=\"lazy\">` : ''}${disc >= 5 ? `<span class=\"badge\">−${disc}%</span>` : ''}</div>\n      <div class=\"card-body\">\n        <span class=\"card-brand\">${esc(p.brand)}</span>\n        <span class=\"card-name\">${esc(p.name)}</span>\n        <span class=\"card-meta\">${meta}${meta ? ' · ' : ''}<span class=\"stock${inStock ? ' in' : ''}\">${inStock ? 'В наявності' : 'Під замовлення'}</span></span>\n        <span class=\"price${old ? ' sale' : ''}\"><b>${one || vs.length === 1 ? '' : 'від '}${money(min)}</b>${old ? `<s>${money(old)}</s>` : ''}</span>\n      </div></a>`;\n  }\n\n  // ------------------------------------------------------------------ Головна\n  const POPULAR_SIZES = ['70×190', '80×190', '80×200', '90×190', '90×200', '120×200', '140×190', '140×200', '160×190', '160×200', '180×200', '200×200'];\n  function sizeStats(type) {\n    const m = {};\n    for (const p of state.products) {\n      if (type && p.type !== type) continue;\n      for (const v of p.variants) if (v.w) { (m[v.label] ||= { label: v.label, w: v.w, l: v.l, min: Infinity, n: 0 }); m[v.label].min = Math.min(m[v.label].min, v.price); m[v.label].n++; }\n    }\n    return m;\n  }\n\n  route(/^\\/$/, () => {\n    setTitle('');\n    const cats = state.categories;\n    const sale = state.products.filter((p) => p.disc >= 10).sort((a, b) => b.disc - a.disc).slice(0, 8);\n    const stock = state.products.filter((p) => p.inStock && p.type === 'mattresses').slice(0, 8);\n    let heroType = 'mattresses';\n    app.innerHTML = `\n      <section class=\"hero\"><div class=\"wrap hero-in\">\n        <div>\n          <h1>Матрац під розмір вашого ліжка</h1>\n          <p>${state.products.length} ${plural(state.products.length, 'модель', 'моделі', 'моделей')} матраців, топерів і постільного від українських та європейських виробників. Доставка Новою поштою по всій Україні.</p>\n        </div>\n        <div class=\"hero-pick\">\n          <h2>Який розмір вашого ліжка?</h2>\n          <p class=\"hint\">Оберіть — покажемо все, що підходить, з ціною саме за цей розмір</p>\n          <div class=\"hero-types\" role=\"group\" aria-label=\"Що шукаєте\">\n            ${['mattresses', 'toppers', 'protectors'].filter((t) => cats.some((c) => c.id === t)).map((t) => `<button class=\"chip\" data-ht=\"${t}\" aria-pressed=\"${t === heroType}\">${esc(cats.find((c) => c.id === t).name)}</button>`).join('')}\n          </div>\n          <div class=\"hero-beds\" data-hero-beds></div>\n        </div>\n      </div></section>\n      <div class=\"wrap\">\n        <section class=\"section\">\n          <div class=\"section-head\"><h2>Категорії</h2></div>\n          <div class=\"tiles\">${cats.map((c) => {\n            const p = state.products.find((x) => x.type === c.id && x.pics[0]);\n            return `<a class=\"tile\" href=\"${href('/c/' + c.id)}\" data-link>${p ? `<img src=\"${esc(p.pics[0])}\" alt=\"\" loading=\"lazy\">` : ''}<b>${esc(c.name)}</b><span>${c.count} ${plural(c.count, 'модель', 'моделі', 'моделей')}</span></a>`;\n          }).join('')}</div>\n        </section>\n        ${sale.length ? `<section class=\"section\"><div class=\"section-head\"><h2>Зі знижкою</h2><a href=\"${href('/sale')}\" data-link>Усі знижки</a></div><div class=\"grid wide\">${sale.map((p) => cardHtml(p)).join('')}</div></section>` : ''}\n        ${stock.length ? `<section class=\"section\"><div class=\"section-head\"><h2>Матраци в наявності</h2><a href=\"${href('/c/mattresses?stock=1')}\" data-link>Дивитись усі</a></div><div class=\"grid wide\">${stock.map((p) => cardHtml(p)).join('')}</div></section>` : ''}\n        ${factsHtml()}\n      </div>`;\n    const drawBeds = () => {\n      const st = sizeStats(heroType);\n      const list = POPULAR_SIZES.filter((s) => st[s]).map((s) => st[s]);\n      $('[data-hero-beds]').innerHTML = list.map((s) => `<a class=\"size\" href=\"${href(`/c/${heroType}?size=${encodeURIComponent(s.label)}`)}\" data-link>${bedSvg(s.w, s.l, 40)}<span>${s.label}</span><span class=\"sz-price\">від ${money(s.min)}</span></a>`).join('');\n    };\n    drawBeds();\n    $$('[data-ht]').forEach((b) => b.addEventListener('click', () => {\n      heroType = b.dataset.ht;\n      $$('[data-ht]').forEach((x) => x.setAttribute('aria-pressed', x === b));\n      drawBeds();\n    }));\n  });\n\n  function factsHtml() {\n    const st = state.config.stores;\n    return `<section class=\"facts\">\n      <div><h3>Безкоштовна доставка по Україні</h3><p>Новою поштою у відділення або поштомат — безкоштовно. Курʼєром до дверей — ${money(state.config.courierPrice || 700)}. Матраци в рулоні вміщаються навіть у ліфт.</p></div>\n      <div><h3>Оплата</h3><p>${state.config.payOnline ? 'Карткою онлайн, Apple Pay / Google Pay, ' : ''}${state.config.payOnline ? 'або' : 'Оплата'} при отриманні на пошті. У магазині — готівкою чи карткою.</p></div>\n      <div><h3>Можна полежати перед покупкою</h3><p>${st.length} ${plural(st.length, 'магазин', 'магазини', 'магазинів')}: ${esc(st.join('; '))}. Самовивіз — безкоштовно.</p></div>\n    </section>`;\n  }\n\n  // ------------------------------------------------------------------ Каталог\n  const SORTS = { pop: 'Спочатку популярні', cheap: 'Спочатку дешевші', exp: 'Спочатку дорожчі', disc: 'Найбільша знижка' };\n  const HEIGHTS = [['low', 'до 10 см', (h) => h < 10], ['mid', '10–20 см', (h) => h >= 10 && h <= 20], ['high', 'понад 20 см', (h) => h > 20]];\n\n  function readFilters(params) {\n    const set = (k) => new Set(params.getAll(k).flatMap((x) => x.split(',')).filter(Boolean));\n    return {\n      size: set('size'), brand: set('brand'), spring: set('spring'), firm: set('firm'), height: set('height'),\n      stock: params.get('stock') === '1', min: +params.get('min') || 0, max: +params.get('max') || 0,\n      sort: SORTS[params.get('sort')] ? params.get('sort') : 'pop', q: (params.get('q') || '').trim(),\n    };\n  }\n  function filtersToQs(f) {\n    const p = new URLSearchParams();\n    if (f.q) p.set('q', f.q);\n    for (const k of ['size', 'brand', 'spring', 'firm', 'height']) if (f[k].size) p.set(k, [...f[k]].join(','));\n    if (f.stock) p.set('stock', '1');\n    if (f.min) p.set('min', f.min);\n    if (f.max) p.set('max', f.max);\n    if (f.sort !== 'pop') p.set('sort', f.sort);\n    const s = p.toString();\n    return s ? '?' + s : '';\n  }\n  function matchProduct(p, f, skip) {\n    let vs = p.variants;\n    if (f.size.size && skip !== 'size') { vs = vs.filter((v) => f.size.has(v.label)); if (!vs.length) return null; }\n    if (f.stock) { vs = vs.filter((v) => v.av); if (!vs.length) return null; }\n    if (f.brand.size && skip !== 'brand' && !f.brand.has(p.brand)) return null;\n    if (f.spring.size && skip !== 'spring' && !f.spring.has(p.attrs.spring)) return null;\n    if (f.firm.size && skip !== 'firm' && !(p.attrs.firmTags || []).some((t) => f.firm.has(t))) return null;\n    if (f.height.size && skip !== 'height' && !HEIGHTS.some(([k, , fn]) => f.height.has(k) && p.attrs.height && fn(p.attrs.height))) return null;\n    const price = Math.min(...vs.map((v) => v.price));\n    if (f.min && price < f.min) return null;\n    if (f.max && price > f.max) return null;\n    if (f.q) {\n      const hay = `${p.name} ${p.brand}`.toLowerCase();\n      if (!f.q.toLowerCase().split(/\\s+/).every((w) => hay.includes(w))) return null;\n    }\n    return { p, price, disc: Math.max(0, ...vs.map((v) => (v.old ? 1 - v.price / v.old : 0))) };\n  }\n\n  function catalogPage(base, params, opts) {\n    const f = readFilters(params);\n    const pool = opts.pool;\n    const results = pool.map((p) => matchProduct(p, f)).filter(Boolean);\n    if (f.sort === 'cheap') results.sort((a, b) => a.price - b.price);\n    else if (f.sort === 'exp') results.sort((a, b) => b.price - a.price);\n    else if (f.sort === 'disc') results.sort((a, b) => b.disc - a.disc);\n    setTitle(opts.title);\n\n    const count = (key, val, test) => pool.filter((p) => matchProduct(p, f, key) && test(p)).length;\n    const sizeSt = {};\n    pool.forEach((p) => p.variants.forEach((v) => { if (v.w) sizeSt[v.label] ||= v; }));\n    const sizeList = Object.values(sizeSt).sort((a, b) => a.w - b.w || a.l - b.l);\n    const brands = [...new Set(pool.map((p) => p.brand))].sort((a, b) => a.localeCompare(b));\n    const springs = [...new Set(pool.map((p) => p.attrs.spring).filter(Boolean))];\n    const firms = [\"М'яка\", 'Середня', 'Жорстка'].filter((t) => pool.some((p) => (p.attrs.firmTags || []).includes(t)));\n    const heights = HEIGHTS.filter(([, , fn]) => pool.some((p) => p.attrs.height && fn(p.attrs.height)));\n\n    const checks = (key, items, label = (x) => x, val = (x) => x, test) => items.map((it) => {\n      const v = val(it);\n      const n = count(key, v, (p) => test(p, v));\n      return `<label class=\"check\"><input type=\"checkbox\" data-f=\"${key}\" value=\"${esc(v)}\" ${f[key].has(v) ? 'checked' : ''}>${esc(label(it))}<small>${n}</small></label>`;\n    }).join('');\n\n    const filtersHtml = `\n      ${sizeList.length > 1 ? `<div class=\"fgroup\"><h3>Розмір</h3><div class=\"sizes\">${sizeList.map((v) => `<button type=\"button\" class=\"size\" data-size=\"${esc(v.label)}\" aria-pressed=\"${f.size.has(v.label)}\">${bedSvg(v.w, v.l, 28)}<span>${esc(v.label)}</span></button>`).join('')}</div></div>` : ''}\n      <div class=\"fgroup\"><h3>Ціна, грн</h3><div class=\"range\"><input type=\"number\" inputmode=\"numeric\" placeholder=\"від\" data-min value=\"${f.min || ''}\" aria-label=\"Ціна від\"><span>–</span><input type=\"number\" inputmode=\"numeric\" placeholder=\"до\" data-max value=\"${f.max || ''}\" aria-label=\"Ціна до\"></div></div>\n      <div class=\"fgroup\"><label class=\"check\"><input type=\"checkbox\" data-stock ${f.stock ? 'checked' : ''}>Тільки в наявності</label></div>\n      ${springs.length > 1 ? `<div class=\"fgroup\"><h3>Тип</h3>${checks('spring', springs, (x) => x, (x) => x, (p, v) => p.attrs.spring === v)}</div>` : ''}\n      ${firms.length > 1 ? `<div class=\"fgroup\"><h3>Жорсткість</h3>${checks('firm', firms, (x) => x, (x) => x, (p, v) => (p.attrs.firmTags || []).includes(v))}</div>` : ''}\n      ${heights.length > 1 ? `<div class=\"fgroup\"><h3>Висота</h3>${checks('height', heights, (x) => x[1], (x) => x[0], (p, v) => { const h = HEIGHTS.find((x) => x[0] === v); return p.attrs.height && h[2](p.attrs.height); })}</div>` : ''}\n      ${brands.length > 1 ? `<div class=\"fgroup\"><h3>Бренд</h3>${checks('brand', brands, (x) => x, (x) => x, (p, v) => p.brand === v)}</div>` : ''}`;\n\n    const pills = [];\n    f.size.forEach((v) => pills.push(['size', v, v]));\n    f.brand.forEach((v) => pills.push(['brand', v, v]));\n    f.spring.forEach((v) => pills.push(['spring', v, v]));\n    f.firm.forEach((v) => pills.push(['firm', v, `Жорсткість: ${v.toLowerCase()}`]));\n    f.height.forEach((v) => pills.push(['height', v, `Висота ${HEIGHTS.find((h) => h[0] === v)?.[1] || v}`]));\n    if (f.stock) pills.push(['stock', '1', 'В наявності']);\n    if (f.min || f.max) pills.push(['price', '', `Ціна ${f.min || 0}–${f.max || '…'} грн`]);\n    if (f.q && opts.showQuery) pills.push(['q', f.q, `«${f.q}»`]);\n\n    const LIMIT_STEP = 24;\n    let limit = LIMIT_STEP;\n    app.innerHTML = `<div class=\"wrap\">\n      <div class=\"page-head\"><div class=\"crumbs\"><a href=\"${href('/')}\" data-link>Головна</a> / ${esc(opts.title)}</div><h1>${esc(opts.heading || opts.title)}</h1></div>\n      <div class=\"catalog\">\n        <aside class=\"filters\" aria-label=\"Фільтри\">${filtersHtml}</aside>\n        <div>\n          <div class=\"toolbar\">\n            <span class=\"count\">${results.length} ${plural(results.length, 'товар', 'товари', 'товарів')}</span>\n            <button class=\"btn btn-ghost filters-open\" type=\"button\" data-open-filters>Фільтри${pills.length ? ` (${pills.length})` : ''}</button>\n            <label class=\"sr\" for=\"sort\">Сортування</label>\n            <select id=\"sort\" data-sort>${Object.entries(SORTS).map(([k, v]) => `<option value=\"${k}\" ${f.sort === k ? 'selected' : ''}>${v}</option>`).join('')}</select>\n          </div>\n          ${pills.length ? `<div class=\"active-filters\">${pills.map(([k, v, t]) => `<button class=\"pill\" data-rm=\"${k}\" data-v=\"${esc(v)}\">${esc(t)}</button>`).join('')}${pills.length > 1 ? '<button class=\"link-btn\" data-clear>Скинути все</button>' : ''}</div>` : ''}\n          <div class=\"grid\" data-grid></div>\n          <div style=\"text-align:center;margin-top:28px\" data-more-wrap></div>\n          ${results.length ? '' : `<div class=\"empty\"><h2>Нічого не знайшли</h2><p class=\"muted\">Приберіть частину фільтрів або спробуйте інший розмір.</p>${pills.length ? '<button class=\"btn btn-ghost\" data-clear>Скинути фільтри</button>' : ''}</div>`}\n        </div>\n      </div></div>\n      <dialog class=\"sheet\" data-sheet><div class=\"sheet-in\"><div class=\"sheet-head\"><h2>Фільтри</h2><button class=\"x-btn\" data-close aria-label=\"Закрити\">✕</button></div><div class=\"sheet-body\">${filtersHtml}</div><div class=\"sheet-foot\"><button class=\"btn btn-primary btn-block\" data-close>Показати ${results.length} ${plural(results.length, 'товар', 'товари', 'товарів')}</button></div></div></dialog>`;\n\n    const grid = $('[data-grid]');\n    const drawGrid = () => {\n      grid.innerHTML = results.slice(0, limit).map((r) => cardHtml(r.p, f.size)).join('');\n      const left = results.length - limit;\n      $('[data-more-wrap]').innerHTML = left > 0 ? `<button class=\"btn btn-ghost\" data-more>Показати ще ${Math.min(left, LIMIT_STEP)}</button>` : '';\n    };\n    drawGrid();\n\n    const go = (nf) => navigate(base + filtersToQs(nf), true);\n    const clone = () => ({ ...f, size: new Set(f.size), brand: new Set(f.brand), spring: new Set(f.spring), firm: new Set(f.firm), height: new Set(f.height) });\n    const sheet = $('[data-sheet]');\n    const reopen = sheet.open;\n    app.addEventListener('click', function onClick(e) {\n      const t = e.target;\n      if (t.closest('[data-more]')) { limit += LIMIT_STEP; drawGrid(); return; }\n      const sz = t.closest('[data-size]');\n      if (sz) { const nf = clone(); nf.size.has(sz.dataset.size) ? nf.size.delete(sz.dataset.size) : nf.size.add(sz.dataset.size); keepSheet(); return go(nf); }\n      const rm = t.closest('[data-rm]');\n      if (rm) {\n        const nf = clone(); const k = rm.dataset.rm;\n        if (k === 'stock') nf.stock = false; else if (k === 'price') { nf.min = 0; nf.max = 0; } else if (k === 'q') nf.q = ''; else nf[k].delete(rm.dataset.v);\n        return go(nf);\n      }\n      if (t.closest('[data-clear]')) return go({ ...readFilters(new URLSearchParams()), sort: f.sort, q: opts.showQuery ? '' : f.q });\n      if (t.closest('[data-open-filters]')) { sheet.showModal(); return; }\n      if (t.closest('[data-close]')) { sheet.close(); return; }\n    }, { once: false });\n    app.addEventListener('change', (e) => {\n      const t = e.target;\n      const nf = clone();\n      if (t.dataset.f) { t.checked ? nf[t.dataset.f].add(t.value) : nf[t.dataset.f].delete(t.value); keepSheet(); return go(nf); }\n      if (t.matches('[data-stock]')) { nf.stock = t.checked; keepSheet(); return go(nf); }\n      if (t.matches('[data-sort]')) { nf.sort = t.value; return go(nf); }\n      if (t.matches('[data-min],[data-max]')) {\n        const box = t.closest('.range');\n        nf.min = Math.max(0, +$('[data-min]', box).value || 0);\n        nf.max = Math.max(0, +$('[data-max]', box).value || 0);\n        keepSheet();\n        return go(nf);\n      }\n    });\n    if (window.__keepSheet && window.matchMedia('(max-width: 959px)').matches) { sheet.showModal(); }\n    window.__keepSheet = false;\n    function keepSheet() { window.__keepSheet = sheet.open; }\n    void reopen;\n  }\n\n  route(/^\\/c\\/([a-z]+)$/, (m, params) => {\n    const cat = state.categories.find((c) => c.id === m[1]);\n    if (!cat) return notFound();\n    catalogPage(`/c/${cat.id}`, params, { title: cat.name, pool: state.products.filter((p) => p.type === cat.id) });\n  });\n  route(/^\\/sale$/, (m, params) => {\n    catalogPage('/sale', params, { title: 'Знижки', pool: state.products.filter((p) => p.disc > 0) });\n  });\n  route(/^\\/search$/, (m, params) => {\n    const q = (params.get('q') || '').trim();\n    $('#q').value = q;\n    catalogPage('/search', params, { title: 'Пошук', heading: q ? `Пошук: «${q}»` : 'Пошук', pool: state.products, showQuery: true });\n  });\n\n  // ------------------------------------------------------------------ Товар\n  route(/^\\/p\\/([\\w-]+)$/, async (m, params) => {\n    const p = state.byId[m[1]];\n    if (!p) return notFound();\n    setTitle(p.name);\n    const opts = [...new Set(p.variants.map((v) => v.opt).filter(Boolean))];\n    let v = p.variants.find((x) => x.id === params.get('v')) || p.variants.find((x) => x.av) || p.variants[0];\n    let qty = 1;\n    const catName = state.categories.find((c) => c.id === p.type)?.name || 'Каталог';\n\n    const specs = [];\n    if (p.attrs.spring) specs.push(['Тип', p.attrs.spring]);\n    if (p.attrs.firmness) specs.push(['Жорсткість', p.attrs.firmness]);\n    if (p.attrs.height) specs.push(['Висота', `${String(p.attrs.height).replace('.', ',')} см`]);\n    if (p.attrs.load) specs.push(['Навантаження на спальне місце', typeof p.attrs.load === 'number' ? `до ${p.attrs.load} кг` : p.attrs.load]);\n    if (p.attrs.roll) specs.push(['Упаковка', 'Вакуумна, скручений у рулон']);\n    if (p.warranty) specs.push(['Гарантія', p.warranty.replace('мес.', 'міс.')]);\n    specs.push(['Бренд', p.brand]);\n\n    app.innerHTML = `<div class=\"wrap\">\n      <div class=\"page-head\" style=\"padding-bottom:6px\"><div class=\"crumbs\"><a href=\"${href('/')}\" data-link>Головна</a> / <a href=\"${href('/c/' + p.type)}\" data-link>${esc(catName)}</a></div></div>\n      <div class=\"product\">\n        <div class=\"gallery\" data-gallery></div>\n        <div class=\"p-info\">\n          <div class=\"p-brand\">${esc(p.brand)}</div>\n          <h1>${esc(p.name)}</h1>\n          ${opts.length > 1 ? `<div class=\"p-block\"><h2>Варіант</h2><div class=\"opts\" role=\"radiogroup\" aria-label=\"Варіант\" data-opts></div></div>` : ''}\n          <div class=\"p-block\" data-size-block><h2>Розмір</h2><div class=\"sizes\" role=\"radiogroup\" aria-label=\"Розмір\" data-sizes></div></div>\n          <div class=\"buy\" data-buy></div>\n          ${specs.length ? `<div class=\"p-block\"><h2>Характеристики</h2><table class=\"specs\">${specs.map(([k, val]) => `<tr><th>${esc(k)}</th><td>${esc(val)}</td></tr>`).join('')}</table></div>` : ''}\n        </div>\n      </div>\n      <section class=\"desc\" data-desc></section>\n    </div>`;\n\n    const drawGallery = () => {\n      const pics = (v.pics && v.pics.length ? v.pics : p.pics).slice(0, 12);\n      $('[data-gallery]').innerHTML = `<div class=\"g-main\" data-gmain>${pics.map((u, i) => `<img src=\"${esc(u)}\" alt=\"${esc(p.name)}${i ? ', фото ' + (i + 1) : ''}\" ${i ? 'loading=\"lazy\"' : ''}>`).join('')}</div>\n        ${pics.length > 1 ? `<div class=\"g-thumbs\">${pics.map((u, i) => `<button type=\"button\" data-thumb=\"${i}\" aria-label=\"Фото ${i + 1}\" aria-current=\"${i === 0}\"><img src=\"${esc(u)}\" alt=\"\" loading=\"lazy\"></button>`).join('')}</div>` : ''}`;\n      const main = $('[data-gmain]');\n      $$('[data-thumb]').forEach((b) => b.addEventListener('click', () => {\n        main.scrollTo({ left: main.clientWidth * +b.dataset.thumb, behavior: 'smooth' });\n      }));\n      main.addEventListener('scroll', () => {\n        const i = Math.round(main.scrollLeft / main.clientWidth);\n        $$('[data-thumb]').forEach((b) => b.setAttribute('aria-current', +b.dataset.thumb === i));\n      }, { passive: true });\n    };\n    let galleryKey = '';\n    const draw = () => {\n      const curOpt = v.opt;\n      const pool = opts.length > 1 ? p.variants.filter((x) => x.opt === curOpt) : p.variants;\n      if (opts.length > 1) {\n        $('[data-opts]').innerHTML = opts.map((o) => `<button type=\"button\" class=\"opt\" role=\"radio\" aria-checked=\"${o === curOpt}\" data-opt=\"${esc(o)}\">${esc(o)}</button>`).join('');\n      }\n      const showSizes = pool.length > 1 || (pool[0] && pool[0].w);\n      $('[data-size-block]').hidden = !showSizes || (pool.length === 1 && !pool[0].w);\n      $('[data-sizes]').innerHTML = pool.map((x) => `<button type=\"button\" class=\"size${x.av ? '' : ' out'}\" role=\"radio\" aria-checked=\"${x.id === v.id}\" data-vid=\"${x.id}\">${bedSvg(x.w, x.l, 32)}<span>${esc(x.label)}</span><span class=\"sz-price\">${money(x.price)}</span></button>`).join('');\n      const disc = v.old ? Math.round((1 - v.price / v.old) * 100) : 0;\n      $('[data-buy]').innerHTML = `\n        <div class=\"price${v.old ? ' sale' : ''}\"><b>${money(v.price)}</b>${v.old ? `<s>${money(v.old)}</s> <span class=\"badge\" style=\"position:static\">−${disc}%</span>` : ''}</div>\n        <div class=\"p-row\"><span class=\"stock${v.av ? ' in' : ''}\">${v.av ? 'В наявності' : 'Під замовлення — термін уточнить менеджер'}</span>${v.label && v.label !== 'Стандарт' ? `<span class=\"muted\">Розмір ${esc(v.label)}${v.opt ? ', ' + esc(v.opt) : ''}</span>` : ''}</div>\n        <div class=\"buy-actions\">\n          <div class=\"qty\" aria-label=\"Кількість\"><button type=\"button\" data-q=\"-1\" aria-label=\"Менше\">−</button><input type=\"number\" min=\"1\" max=\"20\" value=\"${qty}\" data-qty aria-label=\"Кількість\"><button type=\"button\" data-q=\"1\" aria-label=\"Більше\">+</button></div>\n          <button class=\"btn btn-primary\" data-add>Додати в кошик</button>\n          <button class=\"btn btn-teal\" data-buynow>Купити зараз</button>\n        </div>\n        <p class=\"note\">Безкоштовна доставка Новою поштою у відділення або самовивіз з магазину. Оплата ${state.config.payOnline ? 'карткою онлайн або ' : ''}при отриманні.</p>`;\n      const key = (v.pics || p.pics).join();\n      if (key !== galleryKey) { galleryKey = key; drawGallery(); }\n    };\n    draw();\n\n    app.addEventListener('click', (e) => {\n      const t = e.target;\n      const o = t.closest('[data-opt]');\n      if (o) {\n        const same = p.variants.filter((x) => x.opt === o.dataset.opt);\n        v = same.find((x) => x.label === v.label) || same.find((x) => x.av) || same[0];\n        draw(); syncUrl(); return;\n      }\n      const s = t.closest('[data-vid]');\n      if (s) { v = p.variants.find((x) => x.id === s.dataset.vid); draw(); syncUrl(); return; }\n      const q = t.closest('[data-q]');\n      if (q) { qty = Math.max(1, Math.min(20, qty + +q.dataset.q)); $('[data-qty]').value = qty; return; }\n      if (t.closest('[data-add]')) {\n        addToCart(v.id, qty);\n        toast(`Додано в кошик: ${esc(p.name)} ${esc(v.label)} <a href=\"${href('/cart')}\" data-link>Відкрити кошик</a>`);\n        return;\n      }\n      if (t.closest('[data-buynow]')) { addToCart(v.id, qty); navigate('/checkout'); window.scrollTo(0, 0); }\n    });\n    app.addEventListener('change', (e) => {\n      if (e.target.matches('[data-qty]')) { qty = Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)); e.target.value = qty; }\n    });\n    const syncUrl = () => { if (!DEMO) history.replaceState(null, '', `/p/${p.id}?v=${v.id}`); };\n\n    // опис\n    try {\n      const full = state.descCache[p.id] || (state.descCache[p.id] = await api(`/api/product/${p.id}`));\n      if (full.description) $('[data-desc]').innerHTML = `<h2>Опис</h2><div class=\"desc-body\">${full.description}</div>`;\n    } catch {}\n  });\n\n  // ------------------------------------------------------------------ Кошик\n  route(/^\\/cart$/, () => {\n    setTitle('Кошик');\n    const draw = () => {\n      const lines = cartLines();\n      const total = lines.reduce((s, l) => s + l.v.price * l.qty, 0);\n      const n = lines.reduce((s, l) => s + l.qty, 0);\n      if (!lines.length) {\n        app.innerHTML = `<div class=\"wrap\"><div class=\"page-head\"><h1>Кошик</h1></div><div class=\"empty\"><h2>У кошику поки порожньо</h2><p class=\"muted\">Почніть з розміру вашого ліжка — так простіше знайти потрібне.</p><a class=\"btn btn-primary\" href=\"${href('/')}\" data-link>Обрати матрац</a></div></div>`;\n        return;\n      }\n      app.innerHTML = `<div class=\"wrap\"><div class=\"page-head\"><h1>Кошик</h1></div>\n        <div class=\"two\"><ul class=\"lines\">${lines.map((l) => `<li class=\"line\">\n          <a class=\"line-img\" href=\"${href(`/p/${l.p.id}?v=${l.v.id}`)}\" data-link>${(l.v.pics || l.p.pics)[0] ? `<img src=\"${esc((l.v.pics || l.p.pics)[0])}\" alt=\"\">` : ''}</a>\n          <div><a class=\"line-name\" href=\"${href(`/p/${l.p.id}?v=${l.v.id}`)}\" data-link>${esc(l.p.name)}</a>\n            <div class=\"line-sub\">${l.v.label !== 'Стандарт' ? 'Розмір ' + esc(l.v.label) : ''}${l.v.opt ? ', ' + esc(l.v.opt) : ''} · ${money(l.v.price)} · <span class=\"stock${l.v.av ? ' in' : ''}\">${l.v.av ? 'В наявності' : 'Під замовлення'}</span></div>\n            <div class=\"line-bottom\">\n              <div class=\"qty\"><button type=\"button\" data-cq=\"-1\" data-id=\"${l.id}\" aria-label=\"Менше\">−</button><input type=\"number\" value=\"${l.qty}\" min=\"1\" max=\"20\" data-cqty=\"${l.id}\" aria-label=\"Кількість\"><button type=\"button\" data-cq=\"1\" data-id=\"${l.id}\" aria-label=\"Більше\">+</button></div>\n              <button class=\"link-btn\" data-del=\"${l.id}\">Видалити</button>\n              <span class=\"line-sum\">${money(l.v.price * l.qty)}</span>\n            </div></div></li>`).join('')}</ul>\n          <aside class=\"summary\"><h2>Разом</h2>\n            <div class=\"sum-row\"><span>${n} ${plural(n, 'товар', 'товари', 'товарів')}</span><span>${money(total)}</span></div>\n            <div class=\"sum-row\"><span>Доставка Новою поштою</span><span>безкоштовно</span></div>\n            <div class=\"sum-row sum-total\"><span>До сплати</span><span>${money(total)}</span></div>\n            <a class=\"btn btn-primary btn-block\" style=\"margin-top:16px\" href=\"${href('/checkout')}\" data-link>Оформити замовлення</a>\n          </aside></div></div>`;\n    };\n    draw();\n    const setQty = (id, q) => { saveCart(getCart().map((l) => (l.id === id ? { ...l, qty: Math.max(1, Math.min(20, q)) } : l))); draw(); };\n    app.addEventListener('click', (e) => {\n      const b = e.target.closest('[data-cq]');\n      if (b) { const l = getCart().find((x) => x.id === b.dataset.id); if (l) setQty(l.id, l.qty + +b.dataset.cq); return; }\n      const d = e.target.closest('[data-del]');\n      if (d) { saveCart(getCart().filter((l) => l.id !== d.dataset.del)); draw(); }\n    });\n    app.addEventListener('change', (e) => { if (e.target.dataset.cqty) setQty(e.target.dataset.cqty, parseInt(e.target.value, 10) || 1); });\n  });\n\n  // ------------------------------------------------------------------ Оформлення\n  function combo(input, { load, onPick, minLen = 2, empty = 'Нічого не знайдено' }) {\n    const box = input.closest('.combo');\n    const list = document.createElement('ul');\n    list.className = 'combo-list';\n    list.setAttribute('role', 'listbox');\n    list.hidden = true;\n    box.appendChild(list);\n    input.setAttribute('role', 'combobox');\n    input.setAttribute('aria-autocomplete', 'list');\n    input.setAttribute('aria-expanded', 'false');\n    let items = [], active = -1, timer, seq = 0;\n    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };\n    const show = () => {\n      list.innerHTML = items.length ? items.map((it, i) => `<li role=\"option\" data-i=\"${i}\" aria-selected=\"${i === active}\">${esc(it.name)}</li>`).join('') : `<li class=\"none\">${empty}</li>`;\n      list.hidden = false;\n      input.setAttribute('aria-expanded', 'true');\n    };\n    const pick = (i) => { const it = items[i]; if (!it) return; input.value = it.name; close(); onPick(it); };\n    input.addEventListener('input', () => {\n      onPick(null);\n      clearTimeout(timer);\n      const q = input.value.trim();\n      if (q.length < minLen) { close(); return; }\n      timer = setTimeout(async () => {\n        const my = ++seq;\n        try { const r = await load(q); if (my !== seq) return; items = r; active = -1; show(); } catch { close(); }\n      }, 250);\n    });\n    input.addEventListener('focus', async () => { if (minLen === 0) { items = await load(input.value.trim()).catch(() => []); active = -1; show(); } });\n    input.addEventListener('keydown', (e) => {\n      if (list.hidden) return;\n      if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); show(); e.preventDefault(); }\n      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); show(); e.preventDefault(); }\n      else if (e.key === 'Enter' && active >= 0) { pick(active); e.preventDefault(); }\n      else if (e.key === 'Escape') close();\n    });\n    list.addEventListener('mousedown', (e) => { const li = e.target.closest('[data-i]'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });\n    input.addEventListener('blur', () => setTimeout(close, 150));\n    return { reset() { items = []; close(); } };\n  }\n\n  route(/^\\/checkout$/, () => {\n    setTitle('Оформлення замовлення');\n    const lines = cartLines();\n    if (!lines.length) { navigate('/cart', true); return; }\n    const cfg = state.config;\n    const total = lines.reduce((s, l) => s + l.v.price * l.qty, 0);\n    const saved = store.get('buyer101', {});\n    const hasOut = lines.some((l) => !l.v.av);\n\n    app.innerHTML = `<div class=\"wrap\"><div class=\"page-head\"><div class=\"crumbs\"><a href=\"${href('/cart')}\" data-link>Кошик</a> / Оформлення</div><h1>Оформлення замовлення</h1></div>\n      <form class=\"two form\" novalidate data-form>\n        <div>\n          <h2>Контакти</h2>\n          <div class=\"fields cols\">\n            <div class=\"field\"><label for=\"ln\">Прізвище</label><input id=\"ln\" name=\"lastName\" autocomplete=\"family-name\" required value=\"${esc(saved.lastName || '')}\"></div>\n            <div class=\"field\"><label for=\"fn\">Імʼя</label><input id=\"fn\" name=\"firstName\" autocomplete=\"given-name\" required value=\"${esc(saved.firstName || '')}\"></div>\n            <div class=\"field\"><label for=\"ph\">Телефон</label><input id=\"ph\" name=\"phone\" type=\"tel\" inputmode=\"tel\" autocomplete=\"tel\" placeholder=\"+380 __ ___ __ __\" required value=\"${esc(saved.phone || '')}\"></div>\n            <div class=\"field\"><label for=\"em\">Email <span class=\"muted\">(необовʼязково)</span></label><input id=\"em\" name=\"email\" type=\"email\" autocomplete=\"email\" value=\"${esc(saved.email || '')}\"></div>\n          </div>\n          <input name=\"website\" tabindex=\"-1\" autocomplete=\"off\" style=\"position:absolute;left:-9999px\" aria-hidden=\"true\">\n\n          <h2>Доставка</h2>\n          <div class=\"choices\">\n            <label class=\"choice\"><input type=\"radio\" name=\"dm\" value=\"np\" checked><span><b>Нова пошта — відділення або поштомат</b><small>Безкоштовно. Великі матраци — у вантажне відділення.</small></span></label>\n            <label class=\"choice\"><input type=\"radio\" name=\"dm\" value=\"np_courier\"><span><b>Курʼєр Нової пошти до дверей</b><small>${money(cfg.courierPrice || 700)}</small></span></label>\n            <label class=\"choice\"><input type=\"radio\" name=\"dm\" value=\"pickup\"><span><b>Самовивіз з магазину</b><small>Безкоштовно</small></span></label>\n          </div>\n          <div class=\"fields\" style=\"margin-top:14px\" data-np>\n            <div class=\"field combo\"><label for=\"city\">Місто</label><input id=\"city\" autocomplete=\"off\" placeholder=\"Почніть вводити назву\" value=\"${esc(saved.cityName || '')}\"></div>\n            <div class=\"field combo\" data-wh-field><label for=\"wh\">Відділення або поштомат</label><input id=\"wh\" autocomplete=\"off\" placeholder=\"${cfg.npSearch ? 'Номер або вулиця' : 'Наприклад: Відділення №12'}\"></div>\n            <div class=\"field\" data-addr-field hidden><label for=\"addr\">Адреса: вулиця, будинок, квартира</label><input id=\"addr\" autocomplete=\"street-address\"></div>\n          </div>\n          <div class=\"fields\" style=\"margin-top:14px\" data-pickup hidden>\n            <div class=\"field\"><label for=\"st\">Магазин</label><select id=\"st\">${cfg.stores.map((s) => `<option>${esc(s)}</option>`).join('')}</select></div>\n          </div>\n\n          <h2>Оплата</h2>\n          <div class=\"choices\" data-pay></div>\n\n          <h2>Коментар</h2>\n          <div class=\"field\"><label for=\"cm\" class=\"sr\">Коментар до замовлення</label><textarea id=\"cm\" rows=\"3\" placeholder=\"Наприклад, зручний час для дзвінка\"></textarea></div>\n        </div>\n        <aside class=\"summary\"><h2>Ваше замовлення</h2>\n          <ul class=\"sum-items\">${lines.map((l) => `<li><span>${esc(l.p.name)}${l.v.label !== 'Стандарт' ? ' ' + esc(l.v.label) : ''}${l.v.opt ? ', ' + esc(l.v.opt) : ''} × ${l.qty}</span><span>${money(l.v.price * l.qty)}</span></li>`).join('')}</ul>\n          <div class=\"sum-row\"><span>Доставка</span><span data-ship>безкоштовно</span></div>\n          <div class=\"sum-row sum-total\"><span>До сплати</span><span data-total>${money(total)}</span></div>\n          ${hasOut ? '<p class=\"note\">Частина товарів під замовлення — менеджер підтвердить термін після дзвінка.</p>' : ''}\n          <button class=\"btn btn-primary btn-block\" style=\"margin-top:16px\" type=\"submit\" data-submit>Підтвердити замовлення</button>\n          <div class=\"form-error\" data-err hidden></div>\n          <p class=\"agree\">Після оформлення менеджер звʼяжеться з вами для підтвердження.</p>\n        </aside>\n      </form></div>`;\n\n    const form = $('[data-form]');\n    let city = saved.cityRef ? { ref: saved.cityRef, name: saved.cityName } : null;\n    let wh = null;\n    const cityIn = $('#city'), whIn = $('#wh');\n    if (cfg.npSearch) {\n      combo(cityIn, { load: (q) => api(`/api/np/cities?q=${encodeURIComponent(q)}`), onPick: (it) => { city = it; if (!it) { wh = null; whIn.value = ''; } else whIn.focus(); } });\n      combo(whIn, { minLen: 0, empty: 'Спочатку оберіть місто', load: (q) => (city ? api(`/api/np/warehouses?city=${city.ref}&q=${encodeURIComponent(q)}`) : Promise.resolve([])), onPick: (it) => { wh = it; } });\n    }\n\n    const drawPay = () => {\n      const dm = form.dm.value;\n      const opts = [];\n      if (cfg.payOnline) opts.push(['online', 'Карткою онлайн', 'Visa, Mastercard, Apple Pay, Google Pay — через monobank']);\n      if (dm === 'pickup') opts.push(['store', 'Оплата в магазині', 'Готівкою або карткою при отриманні']);\n      else opts.push(['cod', 'Накладений платіж', 'Оплата при отриманні на пошті (+ комісія Нової пошти за переказ)']);\n      const cur = form.pay?.value;\n      $('[data-pay]').innerHTML = opts.map(([v, t, s], i) => `<label class=\"choice\"><input type=\"radio\" name=\"pay\" value=\"${v}\" ${(cur ? cur === v : i === 0) ? 'checked' : ''}><span><b>${t}</b><small>${s}</small></span></label>`).join('');\n      if (!form.pay.value || ![...$$('[name=pay]')].some((r) => r.checked)) $$('[name=pay]')[0].checked = true;\n      const ship = form.dm.value === 'np_courier' ? (cfg.courierPrice || 700) : 0;\n      $('[data-ship]').textContent = ship ? money(ship) : 'безкоштовно';\n      $('[data-total]').textContent = money(total + ship);\n      $('[data-submit]').textContent = form.pay.value === 'online' ? `Перейти до оплати ${money(total + ship)}` : 'Підтвердити замовлення';\n    };\n    const drawDelivery = () => {\n      const dm = form.dm.value;\n      $('[data-np]').hidden = dm === 'pickup';\n      $('[data-pickup]').hidden = dm !== 'pickup';\n      $('[data-wh-field]').hidden = dm !== 'np';\n      $('[data-addr-field]').hidden = dm !== 'np_courier';\n      drawPay();\n    };\n    drawDelivery();\n    form.addEventListener('change', (e) => { if (e.target.name === 'dm') drawDelivery(); if (e.target.name === 'pay') drawPay(); });\n\n    const err = $('[data-err]');\n    const fieldErr = (input, msg) => {\n      const f = input.closest('.field');\n      f.classList.add('invalid');\n      let m = $('.err', f);\n      if (!m) { m = document.createElement('div'); m.className = 'err'; f.appendChild(m); }\n      m.textContent = msg;\n    };\n    form.addEventListener('input', (e) => { const f = e.target.closest('.field'); if (f) { f.classList.remove('invalid'); $('.err', f)?.remove(); } });\n\n    form.addEventListener('submit', async (e) => {\n      e.preventDefault();\n      err.hidden = true;\n      $$('.field.invalid', form).forEach((f) => { f.classList.remove('invalid'); $('.err', f)?.remove(); });\n      const dm = form.dm.value;\n      const v = { lastName: form.lastName.value.trim(), firstName: form.firstName.value.trim(), phone: form.phone.value.trim(), email: form.email.value.trim() };\n      const bad = [];\n      if (!v.lastName) bad.push([form.lastName, 'Вкажіть прізвище']);\n      if (!v.firstName) bad.push([form.firstName, 'Вкажіть імʼя']);\n      if (v.phone.replace(/\\D/g, '').length < 9) bad.push([form.phone, 'Вкажіть номер телефону, наприклад 067 123 45 67']);\n      if (v.email && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v.email)) bad.push([form.email, 'Перевірте email']);\n      const cityName = cfg.npSearch ? city?.name : cityIn.value.trim();\n      if (dm !== 'pickup' && !cityName) bad.push([cityIn, cfg.npSearch ? 'Оберіть місто зі списку' : 'Вкажіть місто']);\n      const whName = cfg.npSearch ? wh?.name : whIn.value.trim();\n      if (dm === 'np' && !whName) bad.push([whIn, cfg.npSearch ? 'Оберіть відділення зі списку' : 'Вкажіть відділення']);\n      if (dm === 'np_courier' && !$('#addr').value.trim()) bad.push([$('#addr'), 'Вкажіть адресу']);\n      if (bad.length) { bad.forEach(([i, m]) => fieldErr(i, m)); bad[0][0].focus(); return; }\n\n      store.set('buyer101', { ...v, cityName: cityName || '', cityRef: city?.ref || '' });\n      const btn = $('[data-submit]');\n      btn.disabled = true;\n      const label = btn.textContent;\n      btn.textContent = 'Оформлюємо…';\n      try {\n        const r = await api('/api/order', {\n          method: 'POST',\n          body: JSON.stringify({\n            items: getCart().map((l) => ({ id: l.id, qty: l.qty })),\n            customer: v,\n            delivery: { method: dm, cityName, cityRef: city?.ref, warehouseName: whName, warehouseRef: wh?.ref, address: $('#addr').value.trim(), store: $('#st').value },\n            payment: form.pay.value,\n            comment: $('#cm').value.trim(),\n            website: form.website.value,\n          }),\n        });\n        store.set('lastOrder101', { ref: r.ref, number: r.number, total: r.total, pay: form.pay.value });\n        saveCart([]);\n        if (r.payUrl) { location.href = r.payUrl; return; }\n        navigate(`/order/${r.ref}`);\n        window.scrollTo(0, 0);\n      } catch (ex) {\n        err.textContent = ex.message || 'Не вдалося оформити замовлення';\n        err.hidden = false;\n        btn.disabled = false;\n        btn.textContent = label;\n        if (ex.data && ex.data.staleId) { saveCart(getCart().filter((l) => l.id !== String(ex.data.staleId))); }\n      }\n    });\n  });\n\n  // ------------------------------------------------------------------ Дякуємо\n  route(/^\\/order\\/([\\w]+)$/, async (m) => {\n    setTitle('Замовлення оформлено');\n    const last = store.get('lastOrder101', {});\n    const ref = m[1];\n    const show = (o) => {\n      const num = o.number || last.number || ref;\n      const paid = o.paid;\n      const pendingPay = (o.pay || last.pay) === 'online' && !paid;\n      app.innerHTML = `<div class=\"wrap\"><div class=\"done\">\n        <div class=\"mark\"><svg width=\"30\" height=\"30\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"m5 12.5 4.5 4.5L19 7.5\" fill=\"none\" stroke=\"#fff\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg></div>\n        <h1>${paid ? 'Оплату отримано, дякуємо!' : 'Дякуємо, замовлення прийнято'}</h1>\n        <p>Номер замовлення: <span class=\"num\">${esc(num)}</span></p>\n        <p class=\"muted\">${paid ? 'Ми вже бачимо оплату. ' : ''}Менеджер звʼяжеться з вами найближчим часом, щоб підтвердити деталі${cfgPhone()}.</p>\n        ${pendingPay ? `<div class=\"form-error\" style=\"background:var(--lav);color:var(--ink)\">Оплата ще не надійшла. Якщо ви закрили сторінку банку, можна оплатити ще раз.<div style=\"margin-top:12px\"><button class=\"btn btn-primary\" data-repay>Оплатити замовлення</button></div></div>` : ''}\n        <p style=\"margin-top:28px\"><a class=\"btn btn-ghost\" href=\"${href('/')}\" data-link>Повернутися до каталогу</a></p>\n      </div></div>`;\n      $('[data-repay]')?.addEventListener('click', async (e) => {\n        e.target.disabled = true;\n        try { const r = await api(`/api/order/${ref}/pay`, { method: 'POST' }); location.href = r.payUrl; } catch (ex) { toast(esc(ex.message)); e.target.disabled = false; }\n      });\n    };\n    show({});\n    try { const o = await api(`/api/order/${ref}`); if (o.found) show(o); } catch {}\n  });\n  const cfgPhone = () => (state.config.phone ? `. Телефон магазину: <a href=\"tel:${esc(state.config.phone.replace(/[^\\d+]/g, ''))}\">${esc(state.config.phone)}</a>` : '');\n\n  function notFound() {\n    setTitle('Сторінку не знайдено');\n    app.innerHTML = `<div class=\"wrap\"><div class=\"empty\"><h1 style=\"font-size:28px;margin-bottom:10px\">Такої сторінки немає</h1><p class=\"muted\">Можливо, товар уже зняли з продажу.</p><a class=\"btn btn-primary\" href=\"${href('/')}\" data-link>На головну</a></div></div>`;\n  }\n  route(/.*/, notFound);\n\n  // ------------------------------------------------------------------ Старт\n  function drawChrome() {\n    $('[data-cats]').innerHTML = state.categories.map((c) => `<a href=\"${href('/c/' + c.id)}\" data-link>${esc(c.name)}</a>`).join('') + (state.products.some((p) => p.disc > 0) ? `<a class=\"sale\" href=\"${href('/sale')}\" data-link>Знижки</a>` : '');\n    const cfg = state.config;\n    $('[data-footer]').innerHTML = `\n      <div><a href=\"${href('/')}\" class=\"logo\" data-link><span class=\"logo-num\">101</span>matras</a><p>Матраци, топери, подушки та ковдри. Ціни й наявність оновлюються автоматично.</p>${cfg.phone ? `<p><a href=\"tel:${esc(cfg.phone.replace(/[^\\d+]/g, ''))}\">${esc(cfg.phone)}</a></p>` : ''}</div>\n      <div><h3>Каталог</h3><ul>${state.categories.map((c) => `<li><a href=\"${href('/c/' + c.id)}\" data-link>${esc(c.name)}</a></li>`).join('')}</ul></div>\n      <div><h3>Наші магазини</h3><ul>${cfg.stores.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;\n  }\n\n  $('[data-search]').addEventListener('submit', (e) => {\n    e.preventDefault();\n    const q = $('#q').value.trim();\n    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/');\n    window.scrollTo(0, 0);\n  });\n\n  async function boot() {\n    try {\n      const [config, cat] = await Promise.all([api('/api/config'), api('/api/catalog')]);\n      state.config = config;\n      state.products = cat.products;\n      state.categories = cat.categories;\n      state.brands = cat.brands;\n      for (const p of cat.products) { state.byId[p.id] = p; for (const v of p.variants) state.variants[v.id] = { p, v }; }\n      // прибрати з кошика товари, яких більше немає\n      const c = getCart().filter((l) => state.variants[l.id]);\n      if (c.length !== getCart().length) saveCart(c);\n      if (DEMO) document.body.insertAdjacentHTML('afterbegin', '<div class=\"demo-bar\">Демо-версія з частиною каталогу: замовлення звідси нікуди не відправляються.</div>');\n      drawChrome();\n      updateCartBadge();\n      render();\n    } catch (e) {\n      const msg = e.status === 503 ? 'Каталог оновлюється. Сторінка перезавантажиться автоматично.' : 'Не вдалося завантажити каталог. Перевірте інтернет і оновіть сторінку.';\n      $('#app').innerHTML = `<div class=\"wrap loading\">${msg}</div>`;\n      if (e.status === 503) setTimeout(boot, 8000);\n    }\n  }\n  boot();\n})();\n","styles.css":"/* 101matras — інтернет-магазин. Фірмові кольори: бірюза 101, фіолетовий, лаванда. */\n:root {\n  --ink: #241A38;\n  --ink-2: #5B5470;\n  --plum: #573D79;\n  --violet: #7B35AF;\n  --violet-d: #65289A;\n  --teal: #41ABC2;\n  --teal-d: #2A8197;\n  --lav: #F1EEF7;\n  --lav-2: #DDDBE9;\n  --white: #FFFFFF;\n  --sale: #D2335C;\n  --ok: #1E8E5A;\n  --r: 4px;\n  --r-lg: 10px;\n  --head: 'Montserrat', system-ui, sans-serif;\n  --body: 'Onest', system-ui, -apple-system, 'Segoe UI', sans-serif;\n  --wrap: 1240px;\n}\n\n* { box-sizing: border-box; }\nhtml { -webkit-text-size-adjust: 100%; }\nbody { margin: 0; background: var(--white); color: var(--ink); font: 400 16px/1.55 var(--body); }\nimg { max-width: 100%; display: block; }\na { color: var(--violet); }\nbutton, input, select, textarea { font: inherit; color: inherit; }\nh1, h2, h3 { font-family: var(--head); line-height: 1.2; margin: 0; letter-spacing: -0.01em; }\n:focus-visible { outline: 3px solid var(--teal); outline-offset: 2px; }\n.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }\n.skip { position: absolute; left: -999px; top: 8px; background: var(--white); padding: 8px 12px; z-index: 99; }\n.skip:focus { left: 8px; }\n.wrap { max-width: var(--wrap); margin: 0 auto; padding: 0 16px; }\n@media (min-width: 900px) { .wrap { padding: 0 28px; } }\n.muted { color: var(--ink-2); }\n[hidden] { display: none !important; }\n\n/* ---------- шапка ---------- */\n.top { position: sticky; top: 0; z-index: 20; background: var(--white); border-bottom: 1px solid var(--lav-2); }\n.top-in { display: flex; align-items: center; gap: 14px; height: 64px; }\n.logo { font: 800 24px/1 var(--head); color: var(--plum); text-decoration: none; letter-spacing: -0.03em; white-space: nowrap; }\n.logo-num { color: var(--teal); }\n.search { flex: 1; display: flex; max-width: 560px; margin-left: auto; background: var(--lav); border-radius: var(--r); }\n.search input { flex: 1; min-width: 0; border: 0; background: transparent; padding: 10px 12px; outline: none; }\n.search input::-webkit-search-cancel-button { display: none; }\n.search button { border: 0; background: transparent; color: var(--plum); padding: 0 12px; cursor: pointer; }\n.search:focus-within { box-shadow: 0 0 0 2px var(--teal); }\n.cart-btn { position: relative; display: flex; align-items: center; gap: 8px; color: var(--plum); text-decoration: none; font-weight: 600; padding: 8px 10px; border-radius: var(--r); }\n.cart-btn:hover { background: var(--lav); }\n.cart-count { position: absolute; top: 0; left: 24px; min-width: 20px; height: 20px; border-radius: 10px; background: var(--teal); color: var(--white); font: 700 12px/20px var(--head); text-align: center; padding: 0 5px; }\n@media (max-width: 640px) {\n  .top-in { flex-wrap: wrap; height: auto; padding-top: 10px; padding-bottom: 10px; row-gap: 10px; }\n  .search { order: 3; flex-basis: 100%; max-width: none; }\n  .cart-btn { margin-left: auto; }\n  .cart-label { display: none; }\n}\n.cats { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; padding-bottom: 6px; }\n.cats::-webkit-scrollbar { display: none; }\n.cats a { flex: none; padding: 7px 12px; border-radius: var(--r); color: var(--ink); text-decoration: none; font: 600 14px/1.2 var(--head); }\n.cats a:hover { background: var(--lav); }\n.cats a[aria-current=\"page\"] { background: var(--plum); color: var(--white); }\n.cats a.sale { color: var(--sale); }\n.cats a.sale[aria-current=\"page\"] { background: var(--sale); color: var(--white); }\n\nmain { min-height: 60vh; outline: none; }\n.loading { padding: 80px 16px; color: var(--ink-2); }\n\n/* ---------- кнопки ---------- */\n.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: var(--r); padding: 13px 22px; font: 700 15px/1.2 var(--head); cursor: pointer; text-decoration: none; transition: background .15s; }\n.btn-primary { background: var(--violet); color: var(--white); }\n.btn-primary:hover { background: var(--violet-d); }\n.btn-primary:disabled { background: #B9A9CC; cursor: not-allowed; }\n.btn-ghost { background: var(--lav); color: var(--plum); }\n.btn-ghost:hover { background: var(--lav-2); }\n.btn-teal { background: var(--teal); color: var(--white); }\n.btn-teal:hover { background: var(--teal-d); }\n.btn-block { width: 100%; }\n.link-btn { background: none; border: 0; color: var(--violet); padding: 0; cursor: pointer; text-decoration: underline; }\n\n/* ---------- схема ліжка (розмір) ---------- */\n.bed { display: block; flex: none; }\n.bed .frame { fill: var(--white); stroke: currentColor; stroke-width: 1.6; }\n.bed .pillow { fill: currentColor; opacity: .35; }\n\n.sizes { display: flex; flex-wrap: wrap; gap: 8px; }\n.size {\n  text-decoration: none;\n  display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 6px;\n  min-width: 74px; padding: 10px 8px 8px; border: 1.5px solid var(--lav-2); border-radius: var(--r);\n  background: var(--white); color: var(--plum); cursor: pointer; font: 600 13px/1.1 var(--head);\n}\n.size:hover { border-color: var(--teal); }\n.size[aria-pressed=\"true\"], .size[aria-checked=\"true\"] { border-color: var(--violet); background: var(--lav); color: var(--violet); box-shadow: inset 0 0 0 1px var(--violet); }\n.size .sz-price { font: 500 12px/1 var(--body); color: var(--ink-2); }\n.size.out .sz-price { opacity: .7; }\n.size:not(.out) .sz-price::before { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); margin-right: 4px; vertical-align: 1px; }\n.hero-beds .size .sz-price::before { display: none; }\n.size:disabled { opacity: .35; cursor: not-allowed; }\n\n/* ---------- головна: підбір за розміром ---------- */\n.hero { background: var(--plum); color: var(--white); }\n.hero-in { display: grid; gap: 28px; padding-top: 40px; padding-bottom: 44px; }\n@media (min-width: 960px) { .hero-in { grid-template-columns: minmax(300px, 0.8fr) 1.2fr; align-items: center; padding-top: 56px; padding-bottom: 60px; } }\n.hero h1 { font-size: clamp(30px, 5vw, 50px); font-weight: 800; letter-spacing: -0.03em; }\n.hero p { margin: 14px 0 0; color: #DCD3EA; max-width: 34ch; font-size: 17px; }\n.hero-pick { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); border-radius: var(--r-lg); padding: 18px; }\n.hero-pick h2 { font-size: 16px; font-weight: 700; margin-bottom: 4px; }\n.hero-pick .hint { color: #CBBFDD; font-size: 14px; margin: 0 0 14px; }\n.hero-beds { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }\n.hero-beds .sz-price { white-space: nowrap; }\n.hero-beds .size { background: transparent; border-color: rgba(255,255,255,.22); color: var(--white); min-width: 0; }\n.hero-beds .size:hover { border-color: var(--teal); background: rgba(65,171,194,.12); }\n.hero-beds .bed .frame { fill: transparent; }\n.hero-beds .bed .pillow { fill: var(--teal); opacity: 1; }\n.hero-beds .sz-price { color: #CBBFDD; }\n.hero-types { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }\n.chip { border: 1px solid rgba(255,255,255,.3); background: transparent; color: var(--white); border-radius: 999px; padding: 6px 12px; font: 600 13px/1 var(--head); cursor: pointer; }\n.chip[aria-pressed=\"true\"] { background: var(--white); color: var(--plum); border-color: var(--white); }\n\n.section { padding: 40px 0 8px; }\n.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 18px; }\n.section-head h2 { font-size: clamp(22px, 3vw, 28px); font-weight: 800; }\n.section-head a { font-weight: 600; white-space: nowrap; }\n\n.tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }\n@media (min-width: 720px) { .tiles { grid-template-columns: repeat(3, 1fr); } }\n@media (min-width: 1100px) { .tiles { grid-template-columns: repeat(6, 1fr); } }\n.tile { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: var(--r-lg); background: var(--lav); color: var(--ink); text-decoration: none; }\n.tile:hover { background: var(--lav-2); }\n.tile img { aspect-ratio: 4/3; object-fit: contain; mix-blend-mode: multiply; width: 100%; }\n.tile b { font: 700 16px/1.2 var(--head); }\n.tile span { font-size: 13px; color: var(--ink-2); }\n\n.facts { display: grid; gap: 16px; padding: 28px 0; margin-top: 32px; border-top: 1px solid var(--lav-2); }\n@media (min-width: 800px) { .facts { grid-template-columns: repeat(3, 1fr); gap: 28px; } }\n.facts h3 { font-size: 16px; margin-bottom: 4px; color: var(--plum); }\n.facts p { margin: 0; color: var(--ink-2); font-size: 15px; }\n\n/* ---------- картки товарів ---------- */\n.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 12px; }\n@media (min-width: 760px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 30px 18px; } }\n@media (min-width: 1180px) { .grid.wide { grid-template-columns: repeat(4, minmax(0, 1fr)); } }\n.card { position: relative; display: flex; flex-direction: column; color: var(--ink); text-decoration: none; }\n.card-img { position: relative; aspect-ratio: 1; background: var(--lav); border-radius: var(--r-lg); overflow: hidden; }\n.card-img img { width: 100%; height: 100%; object-fit: contain; mix-blend-mode: multiply; transition: transform .25s; }\n.card:hover .card-img img { transform: scale(1.03); }\n.badge { position: absolute; top: 8px; left: 8px; background: var(--sale); color: var(--white); font: 700 12px/1 var(--head); padding: 5px 7px; border-radius: var(--r); }\n.card-body { padding: 10px 2px 0; display: flex; flex-direction: column; gap: 4px; flex: 1; }\n.card-brand { font-size: 12px; color: var(--ink-2); }\n.card-name { font: 600 15px/1.3 var(--head); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }\n.card:hover .card-name { color: var(--violet); }\n.card-meta { font-size: 13px; color: var(--ink-2); }\n.price { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; margin-top: auto; padding-top: 4px; }\n.price b { font: 800 18px/1.1 var(--head); white-space: nowrap; }\n.price.sale b { color: var(--sale); }\n.price s { color: var(--ink-2); font-size: 14px; white-space: nowrap; }\n.stock { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-2); }\n.stock::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #B8B2C6; }\n.stock.in { color: var(--ok); }\n.stock.in::before { background: var(--ok); }\n\n/* ---------- каталог ---------- */\n.page-head { padding: 26px 0 14px; }\n.page-head h1 { font-size: clamp(26px, 4vw, 36px); font-weight: 800; }\n.crumbs { font-size: 14px; color: var(--ink-2); margin-bottom: 8px; }\n.crumbs a { color: var(--ink-2); }\n.catalog { display: grid; gap: 24px; padding-bottom: 40px; }\n@media (min-width: 960px) { .catalog { grid-template-columns: 260px 1fr; gap: 36px; } }\n.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 18px; }\n.toolbar .count { color: var(--ink-2); font-size: 14px; margin-right: auto; }\n.toolbar select { border: 1px solid var(--lav-2); border-radius: var(--r); padding: 9px 10px; background: var(--white); }\n.filters-open { display: inline-flex; }\n@media (min-width: 960px) { .filters-open { display: none; } }\n.active-filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }\n.pill { display: inline-flex; align-items: center; gap: 6px; background: var(--lav); border: 0; border-radius: 999px; padding: 6px 10px; font-size: 13px; color: var(--plum); cursor: pointer; }\n.pill::after { content: '✕'; font-size: 11px; }\n\n.filters { display: none; }\n@media (min-width: 960px) { .filters { display: block; align-self: start; position: sticky; top: 120px; max-height: calc(100vh - 140px); overflow: auto; padding-right: 6px; } }\n.fgroup { border-bottom: 1px solid var(--lav-2); padding: 14px 0; }\n.fgroup:first-child { padding-top: 0; }\n.fgroup h3 { font-size: 15px; font-weight: 700; margin-bottom: 10px; }\n.fgroup .sizes .size { min-width: 0; flex: 1 0 64px; padding: 8px 4px 6px; }\n.check { display: flex; align-items: center; gap: 10px; padding: 5px 0; cursor: pointer; font-size: 15px; }\n.check input { width: 18px; height: 18px; accent-color: var(--violet); margin: 0; }\n.check small { color: var(--ink-2); margin-left: auto; }\n.range { display: flex; gap: 8px; align-items: center; }\n.range input { width: 100%; border: 1px solid var(--lav-2); border-radius: var(--r); padding: 8px; }\n.more-brands { margin-top: 6px; }\n\ndialog.sheet { border: 0; padding: 0; width: 100%; max-width: 480px; height: 100%; max-height: 100%; margin: 0 0 0 auto; }\ndialog.sheet::backdrop { background: rgba(36,26,56,.45); }\n.sheet-in { display: flex; flex-direction: column; height: 100%; }\n.sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--lav-2); }\n.sheet-head h2 { font-size: 18px; }\n.sheet-body { flex: 1; overflow: auto; padding: 16px; }\n.sheet-foot { padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); border-top: 1px solid var(--lav-2); }\n.x-btn { border: 0; background: var(--lav); width: 36px; height: 36px; border-radius: 50%; cursor: pointer; font-size: 18px; color: var(--plum); }\n\n.empty { padding: 48px 0; }\n.empty h2 { font-size: 20px; margin-bottom: 8px; }\n\n/* ---------- сторінка товару ---------- */\n.product { display: grid; gap: 28px; padding: 6px 0 32px; }\n@media (min-width: 960px) { .product { grid-template-columns: 1.05fr 1fr; gap: 48px; align-items: start; } }\n.gallery { min-width: 0; }\n@media (min-width: 960px) { .gallery { position: sticky; top: 120px; } }\n.g-main { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none; border-radius: var(--r-lg); background: var(--lav); }\n.g-main::-webkit-scrollbar { display: none; }\n.g-main img { flex: none; width: 100%; aspect-ratio: 1; object-fit: contain; scroll-snap-align: center; mix-blend-mode: multiply; }\n.g-thumbs { display: flex; gap: 8px; margin-top: 10px; overflow-x: auto; scrollbar-width: none; }\n.g-thumbs::-webkit-scrollbar { display: none; }\n.g-thumbs button { flex: none; width: 64px; height: 64px; padding: 0; border: 2px solid transparent; border-radius: var(--r); background: var(--lav); cursor: pointer; overflow: hidden; }\n.g-thumbs button[aria-current=\"true\"] { border-color: var(--violet); }\n.g-thumbs img { width: 100%; height: 100%; object-fit: contain; mix-blend-mode: multiply; }\n.p-info h1 { font-size: clamp(24px, 3.4vw, 34px); font-weight: 800; letter-spacing: -0.02em; }\n.p-brand { color: var(--ink-2); margin-bottom: 6px; }\n.p-row { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; margin-top: 12px; }\n.p-block { margin-top: 24px; }\n.p-block h2 { font-size: 15px; font-weight: 700; margin-bottom: 10px; }\n.opts { display: flex; flex-wrap: wrap; gap: 8px; }\n.opt { border: 1.5px solid var(--lav-2); background: var(--white); border-radius: var(--r); padding: 9px 14px; font: 600 14px/1.2 var(--head); color: var(--plum); cursor: pointer; }\n.opt[aria-checked=\"true\"] { border-color: var(--violet); background: var(--lav); color: var(--violet); box-shadow: inset 0 0 0 1px var(--violet); }\n.buy { margin-top: 24px; padding: 18px; border-radius: var(--r-lg); background: var(--lav); }\n.buy .price b { font-size: 30px; }\n.buy .price s { font-size: 17px; }\n.buy-actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }\n.buy-actions .btn { flex: 1 1 180px; }\n.qty { display: inline-flex; align-items: center; border: 1.5px solid var(--lav-2); border-radius: var(--r); background: var(--white); }\n.qty button { width: 40px; height: 44px; border: 0; background: none; font-size: 20px; cursor: pointer; color: var(--plum); }\n.qty input { width: 40px; text-align: center; border: 0; background: none; font-weight: 600; -moz-appearance: textfield; }\n.qty input::-webkit-inner-spin-button { -webkit-appearance: none; }\n.note { font-size: 14px; color: var(--ink-2); margin-top: 12px; }\n.specs { width: 100%; border-collapse: collapse; font-size: 15px; }\n.specs th, .specs td { text-align: left; padding: 9px 0; border-bottom: 1px solid var(--lav-2); vertical-align: top; }\n.specs th { font-weight: 500; color: var(--ink-2); width: 45%; padding-right: 12px; }\n.desc { max-width: 76ch; padding-bottom: 40px; }\n.desc h2 { font-size: 22px; font-weight: 800; margin-bottom: 14px; }\n.desc-body h3 { font-size: 18px; margin: 22px 0 8px; }\n.desc-body p { margin: 0 0 10px; }\n.desc-body img { border-radius: var(--r-lg); margin: 12px 0; height: auto; }\n.desc-body table { border-collapse: collapse; width: 100%; }\n.desc-body td, .desc-body th { border: 1px solid var(--lav-2); padding: 6px 8px; }\n\n/* ---------- кошик і оформлення ---------- */\n.two { display: grid; gap: 28px; padding-bottom: 48px; }\n@media (min-width: 960px) { .two { grid-template-columns: 1fr 360px; gap: 40px; align-items: start; } }\n.lines { list-style: none; margin: 0; padding: 0; }\n.line { display: grid; grid-template-columns: 84px 1fr; gap: 14px; padding: 16px 0; border-bottom: 1px solid var(--lav-2); }\n.line-img { width: 84px; height: 84px; border-radius: var(--r); background: var(--lav); overflow: hidden; }\n.line-img img { width: 100%; height: 100%; object-fit: contain; mix-blend-mode: multiply; }\n.line-name { font: 600 15px/1.3 var(--head); color: var(--ink); text-decoration: none; }\n.line-sub { font-size: 14px; color: var(--ink-2); margin-top: 2px; }\n.line-bottom { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; margin-top: 10px; }\n.line-bottom .qty button { height: 36px; width: 34px; }\n.line-sum { font: 800 17px/1 var(--head); margin-left: auto; }\n.summary { background: var(--lav); border-radius: var(--r-lg); padding: 20px; }\n@media (min-width: 960px) { .summary { position: sticky; top: 120px; } }\n.summary h2 { font-size: 18px; margin-bottom: 12px; }\n.sum-row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 15px; }\n.sum-total { border-top: 1px solid var(--lav-2); margin-top: 8px; padding-top: 12px; font: 800 20px/1.2 var(--head); }\n.sum-items { list-style: none; padding: 0; margin: 0 0 8px; font-size: 14px; }\n.sum-items li { display: flex; justify-content: space-between; gap: 10px; padding: 5px 0; }\n.sum-items span:first-child { color: var(--ink-2); }\n.sum-items span:last-child { white-space: nowrap; }\n\n.form h2 { font-size: 20px; font-weight: 800; margin: 26px 0 14px; }\n.form h2:first-child { margin-top: 0; }\n.fields { display: grid; gap: 12px; }\n@media (min-width: 640px) { .fields.cols { grid-template-columns: 1fr 1fr; } }\n.field label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 5px; }\n.field input, .field textarea, .field select { width: 100%; border: 1.5px solid var(--lav-2); border-radius: var(--r); padding: 11px 12px; background: var(--white); }\n.field input:focus, .field textarea:focus { border-color: var(--violet); outline: none; }\n.field .err { color: var(--sale); font-size: 13px; margin-top: 4px; }\n.field.invalid input { border-color: var(--sale); }\n.choices { display: grid; gap: 8px; }\n.choice { display: flex; gap: 12px; align-items: flex-start; border: 1.5px solid var(--lav-2); border-radius: var(--r); padding: 13px 14px; cursor: pointer; }\n.choice:has(input:checked) { border-color: var(--violet); background: var(--lav); }\n.choice input { margin-top: 3px; accent-color: var(--violet); width: 18px; height: 18px; flex: none; }\n.choice b { font-weight: 600; display: block; }\n.choice small { color: var(--ink-2); font-size: 13px; }\n.combo { position: relative; }\n.combo-list { position: absolute; z-index: 5; top: 100%; left: 0; right: 0; max-height: 280px; overflow: auto; margin: 4px 0 0; padding: 4px; list-style: none; background: var(--white); border: 1px solid var(--lav-2); border-radius: var(--r); box-shadow: 0 8px 24px rgba(36,26,56,.14); }\n.combo-list li { padding: 9px 10px; border-radius: var(--r); cursor: pointer; font-size: 15px; }\n.combo-list li[aria-selected=\"true\"], .combo-list li:hover { background: var(--lav); }\n.combo-list .none { color: var(--ink-2); cursor: default; }\n.form-error { background: #FCE9EE; color: #9B1C3D; border-radius: var(--r); padding: 12px 14px; margin-top: 14px; }\n.agree { font-size: 13px; color: var(--ink-2); margin-top: 10px; }\n\n.done { max-width: 620px; padding: 48px 0 64px; }\n.done .mark { width: 64px; height: 64px; border-radius: 50%; background: var(--teal); display: grid; place-items: center; margin-bottom: 18px; }\n.done h1 { font-size: clamp(26px, 4vw, 34px); font-weight: 800; }\n.done p { font-size: 17px; }\n.done .num { font: 800 22px/1 var(--head); color: var(--plum); }\n\n/* ---------- підвал ---------- */\n.foot { background: var(--ink); color: #CFC8DE; margin-top: 24px; }\n.foot-in { display: grid; gap: 24px; padding-top: 32px; padding-bottom: 40px; font-size: 14px; }\n@media (min-width: 800px) { .foot-in { grid-template-columns: 1.2fr 1fr 1fr; } }\n.foot h3 { color: var(--white); font-size: 15px; margin-bottom: 8px; }\n.foot a { color: #CFC8DE; }\n.foot ul { list-style: none; padding: 0; margin: 0; }\n.foot li { padding: 2px 0; }\n.foot .logo { color: var(--white); }\n\n.toast { position: fixed; left: 50%; bottom: 20px; transform: translate(-50%, 140%); background: var(--ink); color: var(--white); padding: 12px 16px; border-radius: var(--r); display: flex; gap: 14px; align-items: center; z-index: 50; transition: transform .25s, visibility .25s; max-width: calc(100% - 32px); font-size: 15px; visibility: hidden; }\n.toast.show { transform: translate(-50%, 0); visibility: visible; }\n.toast a { color: var(--teal); font-weight: 600; white-space: nowrap; }\n.demo-bar { background: #FFF6D6; color: #6B5300; font-size: 14px; text-align: center; padding: 8px 16px; }\n\n@media (prefers-reduced-motion: reduce) { * { transition: none !important; scroll-behavior: auto !important; } }\n","favicon.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" rx=\"12\" fill=\"#573D79\"/><rect x=\"12\" y=\"20\" width=\"40\" height=\"30\" rx=\"4\" fill=\"#fff\"/><rect x=\"16\" y=\"24\" width=\"14\" height=\"7\" rx=\"2\" fill=\"#41ABC2\"/><rect x=\"34\" y=\"24\" width=\"14\" height=\"7\" rx=\"2\" fill=\"#41ABC2\"/></svg>\n"};

// ===== server.js =====
// Інтернет-магазин 101matras: каталог з вигрузки Хорошопа, кошик, замовлення в KeyCRM, оплата monobank.
const express = require('express');
const compression = require('compression');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const S = __req('settings');
const { parseFeed, TYPE_NAMES } = __req('feed');
const keycrm = __req('keycrm');
const mono = __req('monobank');
const np = __req('novaposhta');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '200kb' }));

// ===================================================================
// Каталог: завантаження й періодичне оновлення
// ===================================================================
const CACHE_FILE = path.join(os.tmpdir(), '101matras-catalog-cache.xml');
let catalog = null; // {products, descriptions, variantIndex, categories, stats}
let catalogInfo = { updatedAt: null, lastError: null, source: null };
let catalogJson = null; // готова відповідь для /api/catalog

function applyFeed(xml, source) {
  const c = parseFeed(xml);
  if (!c.products.length) throw new Error('У вигрузці не знайдено жодного товару');
  catalog = c;
  catalogInfo = { updatedAt: new Date().toISOString(), lastError: null, source };
  const brands = [...new Set(c.products.map((p) => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  catalogJson = JSON.stringify({
    updatedAt: catalogInfo.updatedAt,
    categories: c.categories,
    brands,
    products: c.products.map(({ siteUrl, ...p }) => p),
  });
  console.log(`[feed] ${source}: моделей ${c.stats.models}, розмірів ${c.stats.variants} (пропущено «під замовлення м²»: ${c.stats.skippedCustom})`);
}

async function loadFeed() {
  try {
    let xml;
    if (process.env.FEED_FILE) {
      xml = fs.readFileSync(process.env.FEED_FILE, 'utf8');
    } else {
      const res = await fetch(S.feedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 101matras-shop/1.0)' },
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`Хорошоп відповів ${res.status}`);
      xml = await res.text();
    }
    applyFeed(xml, process.env.FEED_FILE ? 'file' : 'url');
    try { fs.writeFileSync(CACHE_FILE, xml); } catch {}
    return true;
  } catch (e) {
    catalogInfo.lastError = `${new Date().toISOString()} ${e.message}`;
    console.error('[feed] помилка:', e.message);
    if (!catalog && fs.existsSync(CACHE_FILE)) {
      try { applyFeed(fs.readFileSync(CACHE_FILE, 'utf8'), 'cache'); } catch {}
    }
    return false;
  }
}

async function feedLoop() {
  const ok = await loadFeed();
  // якщо не вдалося — пробуємо знову за 2 хв, інакше — за розкладом
  setTimeout(feedLoop, ok ? S.feedRefreshMin * 60e3 : 2 * 60e3);
}

const needCatalog = (req, res, next) =>
  catalog ? next() : res.status(503).json({ error: 'Каталог ще завантажується, спробуйте за хвилину' });

// ===================================================================
// API каталогу
// ===================================================================
app.get('/api/config', (req, res) => {
  res.json({
    shopName: S.shopName,
    phone: S.shopPhone,
    stores: S.stores,
    payOnline: mono.enabled(),
    courierPrice: S.courierPrice,
    npSearch: np.enabled(),
  });
});

app.get('/api/catalog', needCatalog, (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.type('json').send(catalogJson);
});

app.get('/api/product/:id', needCatalog, (req, res) => {
  const p = catalog.products.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Товар не знайдено' });
  const { siteUrl, ...rest } = p;
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ ...rest, description: catalog.descriptions[p.id] || '' });
});

// ===================================================================
// Нова пошта
// ===================================================================
app.get('/api/np/cities', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!np.enabled() || q.length < 2) return res.json([]);
  try { res.json(await np.searchCities(q)); } catch (e) { console.error(e.message); res.json([]); }
});

app.get('/api/np/warehouses', async (req, res) => {
  const city = String(req.query.city || '');
  if (!np.enabled() || !city) return res.json([]);
  try { res.json(await np.warehouses(city, String(req.query.q || ''))); } catch (e) { console.error(e.message); res.json([]); }
});

// ===================================================================
// Замовлення
// ===================================================================
const ORDERS_FILE = path.join(process.env.DATA_DIR || os.tmpdir(), '101matras-orders.jsonl');
const orders = new Map(); // ref -> {ref, keycrmId, total, paid, invoiceId, createdAt}

function saveOrderLog(o) {
  try { fs.appendFileSync(ORDERS_FILE, JSON.stringify(o) + '\n'); } catch {}
}

function normalizePhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (/^380\d{9}$/.test(d)) return '+' + d;
  if (/^0\d{9}$/.test(d)) return '+38' + d;
  if (/^\d{9}$/.test(d)) return '+380' + d;
  return null;
}

const rate = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (rate.get(ip) || []).filter((t) => t > now - 10 * 60e3);
  list.push(now);
  rate.set(ip, list);
  if (rate.size > 5000) rate.clear();
  return list.length > 8;
}

const clean = (s, n = 200) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function baseUrl(req) {
  return S.publicUrl || `${req.protocol}://${req.get('host')}`;
}

async function sendTelegram(text) {
  if (!S.tgBotToken || !S.tgChatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${S.tgBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: S.tgChatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    return r.ok;
  } catch (e) {
    console.error('[tg]', e.message);
    return false;
  }
}

const DELIVERY_NAMES = { np: 'Нова пошта — відділення / поштомат', np_courier: "Нова пошта — кур'єр за адресою", pickup: 'Самовивіз з магазину' };
const PAY_NAMES = { online: 'Оплата карткою онлайн (monobank)', cod: 'Накладений платіж (оплата при отриманні)', store: 'Оплата в магазині' };

app.post('/api/order', needCatalog, async (req, res) => {
  try {
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'Забагато спроб. Спробуйте трохи пізніше або зателефонуйте нам.' });
    const b = req.body || {};
    if (b.website) return res.json({ ok: true, ref: 'x' }); // пастка для ботів

    // --- товари: ціни беремо лише з каталогу ---
    const items = Array.isArray(b.items) ? b.items.slice(0, 50) : [];
    const lines = [];
    for (const it of items) {
      const hit = catalog.variantIndex[String(it.id)];
      const qty = Math.max(1, Math.min(20, parseInt(it.qty, 10) || 1));
      if (!hit) return res.status(400).json({ error: 'Деякий товар у кошику більше недоступний. Оновіть кошик.', staleId: it.id });
      lines.push({ p: hit.product, v: hit.variant, qty });
    }
    if (!lines.length) return res.status(400).json({ error: 'Кошик порожній' });
    const goodsTotal = lines.reduce((s, l) => s + l.v.price * l.qty, 0);

    // --- покупець ---
    const c = b.customer || {};
    const firstName = clean(c.firstName, 60);
    const lastName = clean(c.lastName, 60);
    const phone = normalizePhone(c.phone);
    const email = clean(c.email, 120);
    if (!firstName || !lastName) return res.status(400).json({ error: "Вкажіть ім'я та прізвище" });
    if (!phone) return res.status(400).json({ error: 'Вкажіть коректний номер телефону' });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Перевірте email' });

    // --- доставка ---
    const d = b.delivery || {};
    const method = ['np', 'np_courier', 'pickup'].includes(d.method) ? d.method : null;
    if (!method) return res.status(400).json({ error: 'Оберіть спосіб доставки' });
    const city = clean(d.cityName, 120);
    const warehouse = clean(d.warehouseName, 200);
    const address = clean(d.address, 200);
    const store = S.stores.includes(d.store) ? d.store : null;
    if (method === 'np' && (!city || !warehouse)) return res.status(400).json({ error: 'Вкажіть місто та відділення Нової пошти' });
    if (method === 'np_courier' && (!city || !address)) return res.status(400).json({ error: 'Вкажіть місто та адресу доставки' });
    if (method === 'pickup' && !store) return res.status(400).json({ error: 'Оберіть магазин для самовивозу' });

    // Доставка: відділення / поштомат НП і самовивіз — безкоштовно, курʼєр НП — фіксована ціна
    const shippingPrice = method === 'np_courier' ? S.courierPrice : 0;
    const total = goodsTotal + shippingPrice;

    // --- оплата ---
    let pay = b.payment;
    const allowed = method === 'pickup' ? ['store'] : ['cod'];
    if (mono.enabled()) allowed.unshift('online');
    if (!allowed.includes(pay)) return res.status(400).json({ error: 'Оберіть спосіб оплати' });

    const comment = clean(b.comment, 1000);
    const ref = 'S' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
    const fullName = `${lastName} ${firstName}`;

    const deliveryLine = method === 'pickup' ? `${DELIVERY_NAMES[method]}: ${store}`
      : method === 'np' ? `${DELIVERY_NAMES[method]}: ${city}, ${warehouse}` : `${DELIVERY_NAMES[method]}: ${city}, ${address}`;

    const managerComment = [
      `Замовлення з інтернет-магазину (${ref})`,
      `Оплата: ${PAY_NAMES[pay]}`,
      `Вартість доставки: ${shippingPrice ? shippingPrice + ' грн (курʼєр)' : 'безкоштовно'}`,
      `Доставка: ${deliveryLine}`,
      ...lines.filter((l) => !l.v.av).length ? ['Є позиції «під замовлення» — уточнити термін у постачальника'] : [],
    ].join('\n');

    // «м. Львів, Львівська обл.» → місто «Львів», область «Львівська обл.»
    const cityParts = city.split(',').map((x) => x.trim());
    const cityShort = (cityParts[0] || city).replace(/^(м\.|смт|с\.|селище|село)\s*/i, '').trim();
    const region = cityParts.find((x) => /обл\./i.test(x)) || '';

    const shipping = { recipient_full_name: fullName, recipient_phone: phone };
    if (method === 'pickup') {
      Object.assign(shipping, { shipping_service: 'Самовивіз', shipping_receive_point: store, shipping_address_city: store.split(',')[0] });
    } else {
      // delivery_service_id: служба доставки в KeyCRM (1 = «Новою поштою на Склад», як у сервера Мономаркету).
      // Без неї KeyCRM не показує блок доставки в замовленні.
      Object.assign(shipping, {
        delivery_service_id: +(process.env.KEYCRM_NP_DELIVERY_ID || 1),
        shipping_service: 'Нова Пошта',
        shipping_address_city: cityShort,
        shipping_address_region: region,
        shipping_address_country: 'Україна',
      });
      if (method === 'np') {
        shipping.shipping_receive_point = warehouse;
        if (d.warehouseRef) shipping.warehouse_ref = clean(d.warehouseRef, 60);
      } else {
        shipping.shipping_secondary_line = address;
        if (process.env.KEYCRM_NP_COURIER_ID) shipping.delivery_service_id = +process.env.KEYCRM_NP_COURIER_ID;
      }
    }

    const payload = {
      source_uuid: ref,
      buyer: { full_name: fullName, phone, ...(email ? { email } : {}) },
      buyer_comment: comment || undefined,
      manager_comment: managerComment,
      ...(shippingPrice ? { shipping_price: shippingPrice } : {}),
      shipping,
      products: lines.map((l) => ({
        sku: l.v.sku,
        name: `${l.p.name}${l.v.label && l.v.label !== 'Стандарт' ? ' ' + l.v.label.replace('×', 'х') : ''}${l.v.opt ? ' ' + l.v.opt : ''}`,
        price: l.v.price,
        quantity: l.qty,
        picture: (l.v.pics || l.p.pics || [])[0],
        properties: [
          ...(l.v.label && l.v.label !== 'Стандарт' ? [{ name: 'Розмір', value: l.v.label }] : []),
          ...(l.v.opt ? [{ name: 'Варіант', value: l.v.opt }] : []),
        ],
      })),
    };

    // --- 1) KeyCRM ---
    let keycrmId = null;
    let keycrmError = null;
    if (S.keycrmToken) {
      try {
        const r = await keycrm.createOrder(payload);
        keycrmId = r.id || (r.data && r.data.id) || null;
      } catch (e) {
        keycrmError = e.message;
        console.error('[order] KeyCRM:', e.message);
      }
    } else keycrmError = 'KEYCRM_API_KEY не задано';

    // --- 2) Telegram (копія / запасний канал) ---
    const tgText = [
      `🛒 Нове замовлення ${keycrmId ? '№' + keycrmId : ref}${keycrmError ? ' ⚠️ НЕ потрапило в KeyCRM' : ''}`,
      `${fullName}, ${phone}${email ? ', ' + email : ''}`,
      deliveryLine,
      PAY_NAMES[pay],
      ...lines.map((l) => `• ${l.p.name} ${l.v.label}${l.v.opt ? ' ' + l.v.opt : ''} × ${l.qty} = ${l.v.price * l.qty} грн (арт. ${l.v.sku})`),
      shippingPrice ? `Доставка курʼєром: ${shippingPrice} грн` : 'Доставка: безкоштовно',
      `Разом: ${total} грн`,
      comment ? `Коментар: ${comment}` : '',
    ].filter(Boolean).join('\n');
    const tgOk = await sendTelegram(tgText);

    if (!keycrmId && !tgOk) {
      saveOrderLog({ ref, failed: true, payload, total, at: new Date().toISOString() });
      return res.status(502).json({ error: `Не вдалося оформити замовлення. Будь ласка, зателефонуйте нам${S.shopPhone ? ' ' + S.shopPhone : ''} — ми все оформимо.` });
    }

    const order = { ref, keycrmId, total, paid: false, invoiceId: null, pay, createdAt: new Date().toISOString() };
    orders.set(ref, order);
    saveOrderLog({ ...order, customer: { fullName, phone }, delivery: deliveryLine, items: payload.products.map((p) => [p.sku, p.quantity, p.price]) });

    // --- 3) Оплата онлайн ---
    let payUrl = null;
    if (pay === 'online') {
      try {
        const base = baseUrl(req);
        const inv = await mono.createInvoice({
          amount: total,
          reference: `${keycrmId || 0}|${ref}`,
          destination: `Оплата замовлення ${keycrmId ? '№' + keycrmId : ref} в ${S.shopName}`,
          redirectUrl: `${base}/order/${ref}`,
          webHookUrl: `${base}/api/mono/webhook`,
        });
        order.invoiceId = inv.invoiceId;
        payUrl = inv.pageUrl;
        if (keycrmId) keycrm.appendManagerComment(keycrmId, `monobank рахунок: ${inv.invoiceId} (очікує оплати)`);
      } catch (e) {
        console.error('[order] monobank:', e.message);
        if (keycrmId) keycrm.appendManagerComment(keycrmId, '⚠️ Не вдалося створити рахунок monobank — звʼязатися з клієнтом щодо оплати');
        sendTelegram(`⚠️ Замовлення ${keycrmId || ref}: не вдалося створити рахунок monobank (${e.message})`);
      }
    }

    res.json({ ok: true, ref, number: keycrmId || ref, total, payUrl, payFailed: pay === 'online' && !payUrl });
  } catch (e) {
    console.error('[order] fatal', e);
    res.status(500).json({ error: 'Сталася помилка. Спробуйте ще раз або зателефонуйте нам.' });
  }
});

// Позначити оплату (ідемпотентно)
const paidInvoices = new Set();
async function handlePaidInvoice(st) {
  if (!st || st.status !== 'success' || paidInvoices.has(st.invoiceId)) return;
  paidInvoices.add(st.invoiceId);
  const [kid, ref] = String(st.reference || '').split('|');
  const amount = (st.finalAmount || st.amount || 0) / 100;
  const o = orders.get(ref);
  if (o) o.paid = true;
  const keycrmId = +kid || (o && o.keycrmId);
  if (keycrmId) {
    try {
      const existing = await keycrm.getOrder(keycrmId).catch(() => null);
      const already = existing && (existing.payments || []).some((p) => p.status === 'paid' && String(p.description || '').includes(st.invoiceId));
      if (!already) await keycrm.addPayment(keycrmId, { amount, description: `monobank ${st.invoiceId}` });
    } catch (e) {
      console.error('[pay] KeyCRM payment:', e.message);
      await keycrm.appendManagerComment(keycrmId, `✅ ОПЛАЧЕНО monobank ${amount} грн (рахунок ${st.invoiceId})`);
    }
  }
  sendTelegram(`✅ Оплачено ${amount} грн — замовлення ${keycrmId || ref} (monobank ${st.invoiceId})`);
}

app.post('/api/mono/webhook', async (req, res) => {
  res.sendStatus(200);
  const invoiceId = req.body && req.body.invoiceId;
  if (!invoiceId || !mono.enabled()) return;
  try {
    const st = await mono.invoiceStatus(invoiceId); // перевіряємо в банку, а не віримо тілу запиту
    await handlePaidInvoice(st);
  } catch (e) {
    console.error('[webhook]', e.message);
  }
});

app.get('/api/order/:ref', async (req, res) => {
  const o = orders.get(req.params.ref);
  if (!o) return res.json({ found: false });
  if (o.invoiceId && !o.paid && mono.enabled()) {
    try {
      const st = await mono.invoiceStatus(o.invoiceId);
      o.payStatus = st.status;
      await handlePaidInvoice(st);
    } catch (e) { console.error('[status]', e.message); }
  }
  res.json({ found: true, number: o.keycrmId || o.ref, total: o.total, pay: o.pay, paid: o.paid, payStatus: o.payStatus || null });
});

// Повторна спроба оплати (якщо клієнт закрив сторінку банку)
app.post('/api/order/:ref/pay', async (req, res) => {
  const o = orders.get(req.params.ref);
  if (!o || o.paid || !mono.enabled()) return res.status(400).json({ error: 'Оплата недоступна' });
  try {
    const base = baseUrl(req);
    const inv = await mono.createInvoice({
      amount: o.total,
      reference: `${o.keycrmId || 0}|${o.ref}`,
      destination: `Оплата замовлення ${o.keycrmId ? '№' + o.keycrmId : o.ref} в ${S.shopName}`,
      redirectUrl: `${base}/order/${o.ref}`,
      webHookUrl: `${base}/api/mono/webhook`,
    });
    o.invoiceId = inv.invoiceId;
    res.json({ payUrl: inv.pageUrl });
  } catch (e) {
    res.status(502).json({ error: 'Не вдалося створити оплату, спробуйте пізніше' });
  }
});

// ===================================================================
// Сторінка перевірки налаштувань для власника: /admin?key=...
// ===================================================================
app.get('/admin', async (req, res) => {
  if (!S.adminKey || req.query.key !== S.adminKey) {
    return res.status(403).type('html').send('<meta charset="utf-8"><p style="font:16px sans-serif;padding:24px">Доступ закрыт. Откройте адрес вида <b>/admin?key=ВАШ_ADMIN_KEY</b> (переменная ADMIN_KEY на Railway).</p>');
  }
  const row = (ok, title, text) => `<tr><td>${ok === true ? '✅' : ok === false ? '❌' : '⚪'}</td><td><b>${title}</b></td><td>${text}</td></tr>`;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const rows = [];
  rows.push(row(!!catalog, 'Каталог из Хорошопа', catalog
    ? `Моделей: ${catalog.stats.models}, размеров: ${catalog.stats.variants}. Обновлён: ${catalogInfo.updatedAt}. ${catalogInfo.lastError ? '<br>Последняя ошибка: ' + esc(catalogInfo.lastError) : ''}`
    : `Ещё не загружен. ${esc(catalogInfo.lastError || '')}`));

  if (S.keycrmToken) {
    try {
      const [src, pm] = await Promise.all([keycrm.listSources(), keycrm.listPaymentMethods().catch(() => [])]);
      const srcList = src.map((s) => `${s.id} — ${esc(s.name)}`).join('<br>');
      const pmList = pm.map((s) => `${s.id} — ${esc(s.name)}`).join('<br>');
      const le = keycrm.lastError();
      const leText = le ? `<br><br><b>Последняя ошибка при отправке заказа</b> (${esc(le.at)}): ${esc(le.message)}${le.first ? '<br>Первая попытка: ' + esc(le.first) : ''}${le.note ? '<br>' + esc(le.note) : ''}` : '';
      rows.push(row(true, 'KeyCRM', `Подключено.${leText}<br><br><b>Источники продаж</b> (ID — название). Сейчас используется: ${S.keycrmSourceId || 'выбирается автоматически'}<br>${srcList || '—'}<br><br><b>Способы оплаты</b>. Сейчас: ${S.keycrmPaymentMethodId || 'не задан (запишется как «monobank»)'}<br>${pmList || '—'}`));
    } catch (e) {
      rows.push(row(false, 'KeyCRM', 'Ключ задан, но KeyCRM ответил ошибкой: ' + esc(e.message)));
    }
  } else rows.push(row(false, 'KeyCRM', 'Не задан KEYCRM_API_KEY — заказы в KeyCRM не попадут'));

  if (mono.enabled()) {
    try {
      const d = await mono.merchantDetails();
      rows.push(row(true, 'monobank', `Подключено: ${esc(d.merchantName || d.merchantId || 'мерчант')}`));
    } catch (e) { rows.push(row(false, 'monobank', 'Токен задан, но банк ответил ошибкой: ' + esc(e.message))); }
  } else rows.push(row(null, 'monobank', 'Не подключено — на сайте доступны только наложенный платёж и оплата в магазине'));

  try {
    const c = await np.searchCities('Київ');
    const note = np.keyBroken() ? ' (ключ NP_API_KEY просрочен — работает без ключа, это нормально)' : '';
    rows.push(row(c.length > 0, 'Нова пошта', (c.length ? 'Поиск городов и отделений работает' : 'Поиск ничего не вернул') + note));
  } catch (e) { rows.push(row(false, 'Нова пошта', esc(e.message))); }

  rows.push(row(S.tgBotToken && S.tgChatId ? true : null, 'Telegram-копия заказов', S.tgBotToken && S.tgChatId ? 'Включено' : 'Выключено (необязательно)'));
  rows.push(row(S.publicUrl ? true : null, 'Адрес магазина (PUBLIC_URL)', S.publicUrl || `не задан, определяется автоматически: ${esc(baseUrl(req))}`));

  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Проверка магазина</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#222}td{padding:10px;border-bottom:1px solid #eee;vertical-align:top}h1{font-size:22px}</style>
<h1>Проверка настроек магазина</h1><table>${rows.join('')}</table>
<p><a href="/admin?key=${encodeURIComponent(req.query.key)}&reload=1">Обновить каталог сейчас</a></p>`);
  if (req.query.reload) loadFeed();
});

// ===================================================================
// Сторінки сайту (SPA) з правильними meta-тегами для пошуковиків і соцмереж
// ===================================================================
const STATIC_FILES = { '/app.js': 'application/javascript', '/styles.css': 'text/css', '/favicon.svg': 'image/svg+xml' };
for (const [p, type] of Object.entries(STATIC_FILES)) {
  app.get(p, (req, res) => { res.set('Cache-Control', 'public, max-age=3600'); res.type(type).send(__ASSETS[p.slice(1)]); });
}

const INDEX = __ASSETS['index.html'];
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function renderIndex(req, meta) {
  const m = { title: `${S.shopName} — матраци, топери, подушки та ковдри з доставкою по Україні`, description: 'Інтернет-магазин 101matras: ортопедичні матраци, топери, подушки, ковдри та наматрацники. Доставка Новою поштою по всій Україні, оплата карткою або при отриманні.', image: '', ...meta };
  return INDEX
    .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(m.title)}</title>`)
    .replace('<!--META-->', [
      `<meta name="description" content="${escAttr(m.description)}">`,
      `<meta property="og:title" content="${escAttr(m.title)}">`,
      `<meta property="og:description" content="${escAttr(m.description)}">`,
      m.image ? `<meta property="og:image" content="${escAttr(m.image)}">` : '',
      `<meta property="og:type" content="${m.image ? 'product' : 'website'}">`,
      `<link rel="canonical" href="${escAttr(baseUrl(req) + req.path)}">`,
    ].join('\n'));
}

app.get('/p/:id', (req, res) => {
  const p = catalog && catalog.products.find((x) => x.id === req.params.id);
  if (!p) return res.status(catalog ? 404 : 200).type('html').send(renderIndex(req, {}));
  res.type('html').send(renderIndex(req, {
    title: `${p.name} — від ${p.minPrice} грн | ${S.shopName}`,
    description: `${p.name} (${p.brand}). Розміри: ${p.variants.slice(0, 8).map((v) => v.label).join(', ')}. Ціна від ${p.minPrice} грн. Доставка по Україні.`,
    image: p.pics[0] || '',
  }));
});

app.get('/c/:type', (req, res) => {
  const name = TYPE_NAMES[req.params.type];
  res.type('html').send(renderIndex(req, name ? { title: `${name} — купити в інтернет-магазині ${S.shopName}` } : {}));
});

app.get('/sitemap.xml', (req, res) => {
  const base = baseUrl(req);
  const urls = [base + '/', ...Object.keys(TYPE_NAMES).map((t) => `${base}/c/${t}`), ...(catalog ? catalog.products.map((p) => `${base}/p/${p.id}`) : [])];
  res.type('xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`);
});
app.get('/robots.txt', (req, res) => res.type('text').send(`User-agent: *\nDisallow: /api/\nDisallow: /admin\nDisallow: /cart\nDisallow: /checkout\nSitemap: ${baseUrl(req)}/sitemap.xml\n`));

app.get(['/', '/cart', '/checkout', '/search', '/order/:ref', '/sale'], (req, res) => res.type('html').send(renderIndex(req, {})));
app.use((req, res) => res.status(404).type('html').send(renderIndex(req, { title: 'Сторінку не знайдено' })));

// ===================================================================
app.listen(S.port, () => {
  console.log(`[shop] запущено на порту ${S.port}`);
  console.log(`[shop] KeyCRM: ${S.keycrmToken ? 'так' : 'НІ'}, monobank: ${mono.enabled() ? 'так' : 'ні'}, НП: ${np.enabled() ? 'так' : 'ні'}, Telegram: ${S.tgBotToken ? 'так' : 'ні'}`);
  feedLoop();
});
