// Інтернет-магазин 101matras: каталог з вигрузки Хорошопа, кошик, замовлення в KeyCRM, оплата monobank.
const express = require('express');
const compression = require('compression');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const S = require('./settings');
const { parseFeed, TYPE_NAMES } = require('./feed');
const keycrm = require('./keycrm');
const mono = require('./monobank');
const np = require('./novaposhta');

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
    const total = lines.reduce((s, l) => s + l.v.price * l.qty, 0);

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
      `Доставка: ${deliveryLine}`,
      ...lines.filter((l) => !l.v.av).length ? ['Є позиції «під замовлення» — уточнити термін у постачальника'] : [],
    ].join('\n');

    const shipping = { recipient_full_name: fullName, recipient_phone: phone };
    if (method === 'pickup') Object.assign(shipping, { shipping_service: 'Самовивіз', shipping_receive_point: store });
    else {
      Object.assign(shipping, { shipping_service: 'Нова Пошта', shipping_address_city: city, shipping_address_country: 'Ukraine' });
      if (method === 'np') {
        shipping.shipping_receive_point = warehouse;
        if (d.warehouseRef) shipping.warehouse_ref = clean(d.warehouseRef, 60);
      } else shipping.shipping_secondary_line = address;
    }

    const payload = {
      source_uuid: ref,
      buyer: { full_name: fullName, phone, ...(email ? { email } : {}) },
      buyer_comment: comment || undefined,
      manager_comment: managerComment,
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
      rows.push(row(true, 'KeyCRM', `Подключено.<br><br><b>Источники продаж</b> (ID — название). Сейчас используется: ${S.keycrmSourceId || 'выбирается автоматически'}<br>${srcList || '—'}<br><br><b>Способы оплаты</b>. Сейчас: ${S.keycrmPaymentMethodId || 'не задан (запишется как «monobank»)'}<br>${pmList || '—'}`));
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

  if (np.enabled()) {
    try {
      const c = await np.searchCities('Київ');
      rows.push(row(c.length > 0, 'Нова пошта', c.length ? 'Поиск городов и отделений работает' : 'Ключ задан, но поиск ничего не вернул'));
    } catch (e) { rows.push(row(false, 'Нова пошта', esc(e.message))); }
  } else rows.push(row(null, 'Нова пошта', 'Не задан NP_API_KEY — клиент вводит город и отделение вручную'));

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
// Файли сайту лежать поруч із server.js; віддаємо лише ці три, а не всю папку
const PUBLIC = __dirname;
const STATIC_FILES = { '/app.js': 'application/javascript', '/styles.css': 'text/css', '/favicon.svg': 'image/svg+xml' };
for (const [p, type] of Object.entries(STATIC_FILES)) {
  app.get(p, (req, res) => { res.set('Cache-Control', 'public, max-age=3600'); res.type(type).sendFile(path.join(PUBLIC, p.slice(1))); });
}

const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
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
