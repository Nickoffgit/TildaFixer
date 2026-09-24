// server.js
// SEO-анализатор сайтов на Tilda. 24 проверки: детерминированные кодом + ИИ для сложных оценок и инструкций.
// Статика раздаётся из корневой папки проекта (там же, где лежит этот файл).

require('dotenv').config();
const express = require('express');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const YC_API_KEY = process.env.YC_API_KEY;
const YC_FOLDER_ID = process.env.YC_FOLDER_ID;
const YC_MODEL = process.env.YC_MODEL || 'yandexgpt-lite/latest';
const YC_COMPLETION_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 TildaFixerBot/1.0';

app.use(express.json({ limit: '1mb' }));

/* ================= защита служебных файлов ================= */
// Раздаём статику из корня, но закрываем доступ к коду, конфигам и логам.
const SENSITIVE_EXT = ['.js', '.json', '.env', '.log', '.md', '.lock', '.map'];
app.use((req, res, next) => {
  const p = req.path;
  const ext = path.extname(p).toLowerCase();
  if (p === '/.env' || p.includes('.env') || SENSITIVE_EXT.includes(ext)) {
    return res.status(403).send('Forbidden');
  }
  next();
});

app.use(express.static(__dirname));

/* ================= helpers ================= */
const cleanText = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const clip = (v, n) => {
  const s = cleanText(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', '0.0.0.0', '::1', ''].includes(host)) return true;
  if (
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) return true;
  const m = host.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return false;
}

/* ================= реестр 24 проверок (синхронизирован с лендингом) ================= */
const CATS = {
  meta: 'Мета-теги',
  head: 'Заголовки',
  img: 'Изображения',
  speed: 'Скорость',
  index: 'Индексация',
  content: 'Контент',
};

const CHECK_DEFS = [
  { id: 'title',        cat: 'meta',    title: 'Title страницы' },
  { id: 'description',  cat: 'meta',    title: 'Description' },
  { id: 'og',           cat: 'meta',    title: 'OG-разметка' },
  { id: 'canonical',    cat: 'meta',    title: 'Canonical' },
  { id: 'favicon',      cat: 'meta',    title: 'Favicon' },
  { id: 'h1',           cat: 'head',    title: 'Наличие H1' },
  { id: 'h1_unique',    cat: 'head',    title: 'Уникальность H1' },
  { id: 'h_hierarchy',  cat: 'head',    title: 'Иерархия H2–H6' },
  { id: 'head_keys',    cat: 'head',    title: 'Ключи в заголовках', judge: true },
  { id: 'alt',          cat: 'img',     title: 'Alt-тексты картинок' },
  { id: 'img_weight',   cat: 'img',     title: 'Вес изображений' },
  { id: 'webp',         cat: 'img',     title: 'Формат WebP' },
  { id: 'lazy',         cat: 'img',     title: 'Ленивая загрузка' },
  { id: 'ttfb',         cat: 'speed',   title: 'Время загрузки' },
  { id: 'scripts',      cat: 'speed',   title: 'Тяжёлые скрипты' },
  { id: 'cache',        cat: 'speed',   title: 'Кэширование' },
  { id: 'mobile',       cat: 'speed',   title: 'Мобильная версия' },
  { id: 'robots',       cat: 'index',   title: 'robots.txt' },
  { id: 'sitemap',      cat: 'index',   title: 'sitemap.xml' },
  { id: 'page404',      cat: 'index',   title: 'Страница 404' },
  { id: 'https',        cat: 'index',   title: 'HTTPS и зеркала' },
  { id: 'volume',       cat: 'content', title: 'Объём текста' },
  { id: 'spam',         cat: 'content', title: 'Переспам', judge: true },
  { id: 'cta',          cat: 'content', title: 'CTA и контакты' },
];

const DEFS_BY_ID = new Map(CHECK_DEFS.map((d) => [d.id, d]));

const JUDGE_QUESTIONS = {
  head_keys: 'Отражают ли заголовки страницы (H1/H2/H3) её суть и поисковые запросы, по которым клиенты могли бы искать такой сайт?',
  spam: 'Есть ли в тексте страницы переспам ключевыми словами или «вода»?',
};

/* Базовые инструкции (фолбэк, если ИИ недоступен) */
const BASE_FIX = {
  title:       { path: 'Tilda → Настройки страницы → вкладка «Facebook и SEO»', steps: ['Откройте страницу → «Настройки» → вкладка «Facebook и SEO».', 'Замените Title: сначала ключевой запрос, затем суть, 50–60 символов.', 'Сохраните и опубликуйте страницу.'] },
  description: { path: 'Tilda → Настройки страницы → вкладка «Facebook и SEO»', steps: ['Откройте «Настройки страницы» → «Facebook и SEO» → поле Description.', 'Напишите 140–160 символов: что предлагаете + выгода + призыв к действию.', 'Сохраните и опубликуйте страницу.'] },
  og:          { path: 'Tilda → Настройки страницы → вкладка «Facebook и SEO»', steps: ['Заполните «Заголовок» и «Описание» для соцсетей.', 'Загрузите картинку размером 1200×630 пикселей.', 'Проверьте, как ссылка выглядит при отправке в мессенджер.'] },
  canonical:   { path: 'Tilda → Настройки сайта → SEO', steps: ['Откройте «Настройки сайта» → «SEO».', 'Включите канонический адрес страницы.', 'Убедитесь, что основной домен один вариант: с www или без.'] },
  favicon:     { path: 'Tilda → Настройки сайта → Экспорт', steps: ['Откройте «Настройки сайта» → «Экспорт».', 'Загрузите favicon 32×32 или 64×64 пикселя.', 'Опубликуйте сайт целиком.'] },
  h1:          { path: 'Tilda → Zero Block → настройки текста', steps: ['Откройте страницу в Zero Block и кликните на главный текст первого экрана.', 'В настройках элемента найдите поле «Тег» и выберите H1.', 'Сохраните и опубликуйте страницу.'] },
  h1_unique:   { path: 'Tilda → Zero Block → настройки текста', steps: ['Оставьте ровно один H1 на странице — обычно это главный оффер.', 'Остальные крупные заголовки переведите в тег H2 в настройках текста.', 'Опубликуйте страницу.'] },
  h_hierarchy: { path: 'Tilda → настройки текстовых блоков', steps: ['Проверьте порядок: после H1 идут H2, внутри секций — H3.', 'Поменяйте теги в настройках каждого текстового элемента.', 'Опубликуйте страницу.'] },
  head_keys:   { path: 'Tilda → редактирование текстов страницы', steps: ['Подберите 2–3 запроса в Яндекс Вордстат.', 'Вплетите главный запрос в H1 и один из H2 — естественно, без спама.', 'Опубликуйте страницу.'] },
  alt:         { path: 'Tilda → «Контент» блока', steps: ['Откройте «Контент» блока с изображениями.', 'Заполните поле «Альтернативный текст»: что изображено + товар или услуга.', 'Опубликуйте страницу.'] },
  img_weight:  { path: 'Tilda → Контент блока → замена картинок', steps: ['Скачайте тяжёлые изображения и сожмите их до 300–500 КБ (например, через squoosh.app).', 'Загрузите сжатые версии обратно в «Контент» блока.', 'Опубликуйте страницу.'] },
  webp:        { path: 'Tilda → Настройки сайта → Экспорт', steps: ['Откройте «Настройки сайта» → «Экспорт».', 'Включите «Конвертировать изображения в WebP».', 'Опубликуйте сайт целиком.'] },
  lazy:        { path: 'Tilda → Настройки сайта → Экспорт', steps: ['Включите «Ленивая загрузка изображений» в «Настройки сайта → Экспорт».', 'Проверьте, что первый экран по-прежнему выглядит корректно.', 'Опубликуйте сайт.'] },
  ttfb:        { path: 'Tilda → структура страницы', steps: ['Уберите тяжёлые блоки и лишние картинки с первого экрана.', 'Включите сжатие изображений в «Настройки сайта → Экспорт».', 'Опубликуйте сайт и измерьте скорость заново.'] },
  scripts:     { path: 'Tilda → Настройки сайта → Аналитика', steps: ['Удалите счётчики и виджеты, которыми не пользуетесь.', 'Остальные коды перенесите в блок «перед </body>».', 'Опубликуйте сайт.'] },
  cache:       { path: 'Tilda → Настройки сайта → Домен', steps: ['Убедитесь, что сайт опубликован на подключённом домене с HTTPS — Тильда кэширует автоматически.', 'Избегайте большого количества внешних HTML-вставок.', 'Переопубликуйте сайт.'] },
  mobile:      { path: 'Tilda → Zero Block → панель устройств', steps: ['Откройте страницу в Zero Block и переключитесь на мобильную ширину.', 'Исправьте элементы, которые ломаются.', 'Опубликуйте страницу.'] },
  robots:      { path: 'Tilda → Настройки сайта → SEO', steps: ['Откройте «Настройки сайта» → «SEO» → robots.txt.', 'Уберите запрет индексации (Disallow: /) для важных страниц.', 'Опубликуйте сайт.'] },
  sitemap:     { path: 'Tilda → Настройки сайта → Экспорт', steps: ['Включите генерацию sitemap в «Настройки сайта → Экспорт».', 'Добавьте сайт в Яндекс Вебмастер и отправьте карту на переобход.', 'Опубликуйте сайт.'] },
  page404:     { path: 'Tilda → Страницы → страница 404', steps: ['Создайте страницу 404 в настройках Тильды.', 'Добавьте на неё меню, поиск или ссылки на ключевые разделы.', 'Опубликуйте сайт.'] },
  https:       { path: 'Tilda → Настройки сайта → Домен', steps: ['Включите редирект на HTTPS в настройках домена.', 'Дождитесь выпуска SSL-сертификата.', 'Проверьте, что сайт открывается по https.'] },
  volume:      { path: 'Tilda → добавить текстовый блок', steps: ['Добавьте блок с описанием товара или услуги на 1500–2500 знаков.', 'Разбейте текст подзаголовками H2–H3 и списками.', 'Опубликуйте страницу.'] },
  spam:        { path: 'Tilda → редактирование текстов страницы', steps: ['Найдите повторяющиеся ключевые фразы.', 'Замените часть повторов синонимами.', 'Оставьте 2–3 вхождения на страницу: в H1, лиде и одном из H2.'] },
  cta:         { path: 'Tilda → блоки «Кнопка» и «Контакты»', steps: ['Добавьте кнопку с понятным действием («Заказать», «Записаться») на первый экран.', 'Продублируйте телефон и почту в шапке и в конце страницы.', 'Опубликуйте страницу.'] },
};

/* ================= сетевые помощники ================= */
async function fetchProbe(url, { timeout = 8000, method = 'GET' } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { method, redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': UA } });
  } catch (error) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function probeText(url, timeout = 8000) {
  const res = await fetchProbe(url, { timeout });
  if (!res) return { reachable: false };
  const text = await res.text().catch(() => '');
  return { reachable: true, status: res.status, text: text.slice(0, 30000) };
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.8',
      },
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Таймаут загрузки сайта (15 секунд). Сайт может быть недоступен.');
    }
    throw new Error('Не удалось загрузить сайт: ' + error.message);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const friendly =
      response.status === 403 ? ' Сайт блокирует автоматический доступ.' :
      response.status === 429 ? ' Слишком много запросов, попробуйте позже.' : '';
    throw new Error(`Целевой сайт вернул HTTP-статус ${response.status}.${friendly}`);
  }
  const html = await response.text();
  return { response, html, loadMs: Date.now() - started, finalUrl: response.url || url };
}

/* ================= сбор данных со страницы ================= */
function collectScripts($, pageUrl) {
  const pageHost = new URL(pageUrl).hostname;
  let total = 0;
  const thirdParty = new Set();
  $('script[src]').each((_, el) => {
    total += 1;
    const src = $(el).attr('src') || '';
    try {
      const host = new URL(src, pageUrl).hostname;
      if (host && host !== pageHost) thirdParty.add(host);
    } catch (error) { /* игнорируем битые ссылки */ }
  });
  return { total, thirdParty: thirdParty.size };
}

function collectImages($, pageUrl) {
  let total = 0;
  let withAlt = 0;
  let lazy = 0;
  let webp = $('source[type="image/webp"]').length > 0;
  const srcs = [];
  const noAltSrcs = [];
  $('img').each((_, el) => {
    total += 1;
    const alt = cleanText($(el).attr('alt'));
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    const srcset = $(el).attr('srcset') || '';
    if (alt) withAlt += 1;
    else if (noAltSrcs.length < 3 && src) noAltSrcs.push(src);
    if ($(el).attr('loading') === 'lazy' || $(el).attr('data-src')) lazy += 1;
    if (/\.webp/i.test(src) || /\.webp/i.test(srcset)) webp = true;
    if (src) {
      try {
        const abs = new URL(src, pageUrl);
        if (abs.protocol.startsWith('http')) srcs.push(abs.toString());
      } catch (error) { /* пропускаем */ }
    }
  });
  return { total, withAlt, lazy, webp, srcs: [...new Set(srcs)], noAltSrcs };
}

function collectHeadings($) {
  const list = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    list.push({ level: Number(el.tagName.slice(1)), text: cleanText($(el).text()) });
  });
  return list;
}

async function probeImageWeights(srcs) {
  const uniq = srcs.slice(0, 4);
  if (!uniq.length) return { measured: 0, maxKb: null };
  const sizes = await Promise.all(
    uniq.map(async (u) => {
      const res = await fetchProbe(u, { method: 'HEAD', timeout: 6000 });
      if (!res || !res.ok) return null;
      const len = Number(res.headers.get('content-length') || 0);
      return len > 0 ? len : null;
    })
  );
  const known = sizes.filter(Boolean);
  return { measured: known.length, maxKb: known.length ? Math.round(Math.max(...known) / 1024) : null };
}

/* ================= детерминированные проверки ================= */
function runCodeChecks(ctx) {
  const { $, title, description, headings, imgs, scripts, loadMs, cacheHeaders, mobile, textLen, robots, sitemap, probe404, https, weight, cta } = ctx;
  const r = {};

  // 01 Title
  if (!title || title === 'Не указан') {
    r.title = { status: 'crit', description: 'Title не найден — поисковик не понимает, о чём страница.' };
  } else {
    const len = title.length;
    if (len >= 50 && len <= 60) r.title = { status: 'ok', description: `Длина Title — ${len} символов, в идеальном диапазоне 50–60.` };
    else if (len < 30) r.title = { status: 'crit', description: `Title слишком короткий (${len} симв.) — не помещаются ключевые запросы.` };
    else if (len > 70) r.title = { status: 'crit', description: `Title слишком длинный (${len} симв.) — поисковик обрежет его в выдаче.` };
    else r.title = { status: 'warn', description: `Длина Title — ${len} симв. Идеальный диапазон 50–60.` };
  }

  // 02 Description
  if (!description || description === 'Не указан') {
    r.description = { status: 'crit', description: 'Description пустой — в выдачу попадёт случайный текст страницы.' };
  } else {
    const len = description.length;
    if (len >= 120 && len <= 160) r.description = { status: 'ok', description: `Description заполнен, длина ${len} символов — хороший диапазон.` };
    else if (len < 60 || len > 200) r.description = { status: 'crit', description: `Description ${len} символов — слишком ${len < 60 ? 'короткий' : 'длинный'} для сниппета.` };
    else r.description = { status: 'warn', description: `Description ${len} символов. Лучше 120–160, с выгодой и призывом к действию.` };
  }

  // 03 OG
  const ogCount = ['og:title', 'og:description', 'og:image'].filter((p) => $(`meta[property="${p}"]`).attr('content')).length;
  r.og =
    ogCount === 3 ? { status: 'ok', description: 'OG-заголовок, описание и картинка для соцсетей заданы.' } :
    ogCount > 0 ? { status: 'warn', description: `Заполнено только ${ogCount} из 3 OG-тегов — превью ссылки будет неполным.` } :
    { status: 'crit', description: 'OG-тегов нет — ссылка в мессенджерах выглядит «пустой».' };

  // 04 Canonical
  r.canonical = $('link[rel="canonical"]').length
    ? { status: 'ok', description: 'Канонический адрес указан, дубли не страшны.' }
    : { status: 'warn', description: 'Canonical не задан — возможен вес между дублями страницы.' };

  // 05 Favicon
  r.favicon = $('link[rel*="icon"]').length
    ? { status: 'ok', description: 'Иконка сайта загружена.' }
    : { status: 'warn', description: 'Favicon не найден — сниппет и вкладки выглядят беднее.' };

  // 06 Наличие H1
  const h1Count = $('h1').length;
  const h1Text = cleanText($('h1').first().text());
  r.h1 = h1Count >= 1
    ? { status: 'ok', description: 'Главный заголовок H1 на странице есть.' }
    : { status: 'crit', description: 'На странице нет заголовка H1 — поисковик не понимает её тему.' };

  // 07 Уникальность H1
  if (h1Count === 0) r.h1_unique = { status: 'warn', description: 'H1 отсутствует — проверять нечего.' };
  else if (h1Count > 1) r.h1_unique = { status: 'crit', description: `Найдено ${h1Count} заголовков H1 — должен быть ровно один.` };
  else if (h1Text && title && h1Text.toLowerCase() === title.toLowerCase()) r.h1_unique = { status: 'warn', description: 'H1 полностью дублирует Title — лучше их различать.' };
  else r.h1_unique = { status: 'ok', description: 'Ровно один уникальный H1.' };

  // 08 Иерархия
  let skip = false;
  for (let i = 1; i < headings.length; i += 1) {
    if (headings[i].level - headings[i - 1].level > 1) skip = true;
  }
  const hasH2 = headings.some((h) => h.level === 2);
  if (skip) r.h_hierarchy = { status: 'warn', description: 'Уровни заголовков перескакивают (например, после H2 сразу H4).' };
  else if (!hasH2 && textLen > 600) r.h_hierarchy = { status: 'warn', description: 'На странице нет ни одного H2 — структура не читается.' };
  else r.h_hierarchy = { status: 'ok', description: 'Иерархия заголовков логичная.' };

  // 10 Alt
  if (imgs.total === 0) r.alt = { status: 'ok', description: 'Изображений на странице нет.' };
  else {
    const ratio = imgs.withAlt / imgs.total;
    if (ratio >= 0.9) r.alt = { status: 'ok', description: `Alt заполнен у ${imgs.withAlt} из ${imgs.total} изображений.` };
    else if (ratio >= 0.5) r.alt = { status: 'warn', description: `Alt заполнен только у ${imgs.withAlt} из ${imgs.total} изображений.` };
    else r.alt = { status: 'crit', description: `Без alt ${imgs.total - imgs.withAlt} из ${imgs.total} изображений — теряется трафик из картинок.` };
  }

  // 11 Вес изображений (реальные HEAD-запросы)
  if (!imgs.srcs.length) r.img_weight = { status: 'ok', description: 'Изображений для проверки не найдено.' };
  else if (weight.measured === 0) r.img_weight = { status: 'warn', description: 'Не удалось измерить вес: сервер не отдал размеры файлов. Проверьте вручную.' };
  else if (weight.maxKb > 1000) r.img_weight = { status: 'crit', description: `Самое тяжёлое изображение ~${weight.maxKb} КБ — это сильно замедляет страницу.` };
  else if (weight.maxKb > 500) r.img_weight = { status: 'warn', description: `Самое тяжёлое изображение ~${weight.maxKb} КБ — лучше до 500 КБ.` };
  else r.img_weight = { status: 'ok', description: `Изображения лёгкие, максимум ~${weight.maxKb} КБ.` };

  // 12 WebP
  if (imgs.total === 0) r.webp = { status: 'ok', description: 'Изображений нет.' };
  else r.webp = imgs.webp
    ? { status: 'ok', description: 'WebP-версии изображений используются.' }
    : { status: 'warn', description: 'WebP не найден — конвертация снизила бы вес картинок на 30–50%.' };

  // 13 Ленивая загрузка
  r.lazy = imgs.total > 6 && imgs.lazy === 0
    ? { status: 'warn', description: `У ${imgs.total} изображений нет ленивой загрузки — первый экран грузится дольше.` }
    : { status: 'ok', description: 'Ленивая загрузка изображений задействована или картинок немного.' };

  // 14 Время загрузки (ответ сервера)
  const sec = (loadMs / 1000).toFixed(1);
  r.ttfb =
    loadMs < 1200 ? { status: 'ok', description: `Сервер отдал страницу за ${sec} с — быстро.` } :
    loadMs < 3000 ? { status: 'warn', description: `Сервер отвечал ${sec} с — медленнее желательного.` } :
    { status: 'crit', description: `Сервер отвечал ${sec} с — посетители могут не дождаться.` };

  // 15 Скрипты
  if (scripts.total > 12 || scripts.thirdParty > 6) r.scripts = { status: 'crit', description: `Найдено ${scripts.total} скриптов, из них ${scripts.thirdParty} сторонних сервисов — страница тормозит.` };
  else if (scripts.total > 8 || scripts.thirdParty > 4) r.scripts = { status: 'warn', description: `${scripts.total} скриптов (${scripts.thirdParty} сторонних) — стоит почистить неиспользуемые.` };
  else r.scripts = { status: 'ok', description: `Скриптов умеренно: ${scripts.total}, сторонних — ${scripts.thirdParty}.` };

  // 16 Кэш
  r.cache = cacheHeaders
    ? { status: 'ok', description: 'Сервер отдаёт заголовки кэширования.' }
    : { status: 'warn', description: 'Заголовки кэширования не найдены — повторные визиты могли бы быть быстрее.' };

  // 17 Мобильная версия
  r.mobile = mobile
    ? { status: 'ok', description: 'Мета-тег viewport на месте, страница адаптируется под телефон.' }
    : { status: 'crit', description: 'Нет мета-тега viewport — страница не адаптирована под мобильные.' };

  // 18 robots.txt
  if (!robots.reachable) r.robots = { status: 'warn', description: 'Не удалось запросить robots.txt.' };
  else if (robots.status === 404) r.robots = { status: 'warn', description: 'robots.txt не найден — поисковик будет ходить везде.' };
  else {
    let inStar = false;
    let banned = false;
    for (const raw of robots.text.split('\n')) {
      const line = raw.trim();
      if (/^user-agent:/i.test(line)) inStar = /user-agent:\s*\*/i.test(line);
      else if (inStar && /^disallow:\s*\/\s*(#.*)?$/i.test(line)) banned = true;
    }
    r.robots = banned
      ? { status: 'crit', description: 'robots.txt полностью закрывает сайт от индексации (Disallow: /).' }
      : { status: 'ok', description: 'robots.txt доступен, полной блокировки индексации нет.' };
  }

  // 19 sitemap.xml
  if (sitemap.reachable && sitemap.status === 200 && /<urlset|<sitemapindex/i.test(sitemap.text)) {
    r.sitemap = { status: 'ok', description: 'sitemap.xml найдена и выглядит корректной.' };
  } else if (sitemap.reachable && sitemap.status === 200) {
    r.sitemap = { status: 'warn', description: 'Файл sitemap.xml существует, но не похож на карту сайта.' };
  } else {
    r.sitemap = { status: 'crit', description: 'sitemap.xml не найдена — новым страницам сложнее попасть в индекс.' };
  }

  // 20 Страница 404
  if (!probe404) r.page404 = { status: 'warn', description: 'Не удалось проверить обработку несуществующих адресов.' };
  else if (probe404.status === 404) r.page404 = { status: 'ok', description: 'Для несуществующих адресов сервер корректно отдаёт 404.' };
  else r.page404 = { status: 'warn', description: `Несуществующий адрес вернул статус ${probe404.status} — стоит настроить страницу 404.` };

  // 21 HTTPS
  r.https = https
    ? { status: 'ok', description: 'Сайт работает по защищённому HTTPS.' }
    : { status: 'crit', description: 'Сайт открыт по HTTP — поисковики понижают такие страницы.' };

  // 22 Объём текста
  if (textLen >= 1200) r.volume = { status: 'ok', description: `На странице ${textLen} символов текста — достаточно для ранжирования.` };
  else if (textLen >= 500) r.volume = { status: 'warn', description: `Текста всего ${textLen} символов — поисковику мало контекста.` };
  else r.volume = { status: 'crit', description: `Текста почти нет (${textLen} символов) — странице нечего ранжировать.` };

  // 24 CTA и контакты
  if (cta >= 2) r.cta = { status: 'ok', description: 'На странице есть и кнопки действия, и способы связи.' };
  else if (cta === 1) r.cta = { status: 'warn', description: 'Есть только один элемент действия — добавьте контакты или кнопку.' };
  else r.cta = { status: 'crit', description: 'Не найдено ни кнопки действия, ни контактов — посетителю непонятно, что делать.' };

  return r;
}

function naiveSpamFallback(text) {
  const words = String(text).toLowerCase().match(/[а-яёa-z]{5,}/g) || [];
  if (words.length < 60) return { status: 'ok', description: 'Текста мало — переспам анализировать не по чему.' };
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  let top = '';
  let max = 0;
  for (const [w, c] of Object.entries(freq)) {
    if (c > max) { max = c; top = w; }
  }
  if (max / words.length > 0.06) {
    return { status: 'warn', description: `Слово «${top}» повторяется ${max} раз(а) — выглядит как переспам.` };
  }
  return { status: 'ok', description: 'Неестественных повторов ключевых слов не найдено.' };
}

/* ================= YandexGPT: персональные инструкции + оценки ================= */
function buildAiTasks(results) {
  const tasks = [];
  for (const def of CHECK_DEFS) {
    if (def.judge) {
      tasks.push({ id: def.id, kind: 'judge', question: JUDGE_QUESTIONS[def.id] });
    } else {
      const res = results[def.id];
      if (res && res.status !== 'ok') tasks.push({ id: def.id, kind: 'fix', problem: res.description });
    }
  }
  return tasks;
}

function parseAiArray(text) {
  let cleaned = String(text || '').trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) cleaned = fence[1].trim();
  const a = cleaned.indexOf('[');
  const b = cleaned.lastIndexOf(']');
  if (a !== -1 && b > a) cleaned = cleaned.slice(a, b + 1);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    return null;
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.items)) return parsed.items;
  return null;
}

function sanitizeAiItem(raw, allowedIds) {
  if (!raw || typeof raw !== 'object' || !allowedIds.has(raw.id)) return null;
  const item = { id: raw.id };
  if (raw.status) {
    const s = String(raw.status).toLowerCase();
    item.status = ['ok', 'warn', 'crit'].includes(s) ? s : 'warn';
  }
  if (raw.description) item.description = clip(raw.description, 220);
  if (raw.path) item.path = clip(raw.path, 90);
  if (Array.isArray(raw.steps)) item.steps = raw.steps.map((s) => clip(s, 220)).filter(Boolean).slice(0, 5);
  if (raw.suggestion) item.suggestion = clip(raw.suggestion, 320);
  return item;
}

async function askYandex(pageSummary, tasks) {
  if (!YC_API_KEY || !YC_FOLDER_ID) throw new Error('Не заданы YC_API_KEY или YC_FOLDER_ID');

  const systemPrompt = `
Ты — опытный SEO-специалист, который отлично знает платформу Tilda.
Сервис уже проверил страницу по 24 параметрам. Твоя работа — две вещи:

1. Для задач с kind "fix" (проблема уже найдена): напиши максимально простую пошаговую инструкцию по исправлению для новичка в Tilda.
   - 2–4 шага, каждый не длиннее 180 символов.
   - Указывай конкретные места интерфейса: "Настройки страницы", "вкладка Facebook и SEO", "Zero Block", "Контент блока", "Настройки сайта → Экспорт", "Настройки сайта → SEO".
   - Если проблема в Title или Description — в поле "suggestion" предложи ГОТОВЫЙ новый текст, опираясь на данные страницы: Title 50–60 символов, Description 140–160 символов.
   - Если проблема в alt — в "suggestion" дай 1–2 примера описания картинок.

2. Для задач с kind "judge": оцени сам. Поставь "status" ("ok", "warn" или "crit"), короткое описание и, если статус не "ok", инструкцию.

Жёсткие правила:
- Пиши по-русски, простым языком, без терминов и без кода.
- Не выдумывай новых проблем — отвечай только на задачи из списка.
- Отвечай СТРОГО валидным JSON-массивом, без markdown и без текста до/после JSON.

Формат элемента:
{ "id": "идентификатор из задачи", "path": "Tilda → куда идти", "steps": ["шаг 1", "шаг 2"], "suggestion": "готовый текст или пусто" }
Для задач "judge" добавляй поле "status" и "description".`.trim();

  const userPrompt = `
Данные страницы:
URL: ${pageSummary.url}
Title: ${pageSummary.title}
Description: ${pageSummary.description}
H1: ${pageSummary.h1}
H2/H3: ${pageSummary.headers}
Картинки без alt: ${pageSummary.noAlt}
Фрагмент текста страницы: ${pageSummary.bodySample}

Задачи:
${JSON.stringify(tasks)}

Верни по одному объекту на каждую задачу. Ответ — только JSON-массив.`.trim();

  const payload = {
    modelUri: `gpt://${YC_FOLDER_ID}/${YC_MODEL}`,
    completionOptions: { stream: false, temperature: 0.2, maxTokens: 3000 },
    messages: [
      { role: 'system', text: systemPrompt },
      { role: 'user', text: userPrompt },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch(YC_COMPLETION_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Api-Key ${YC_API_KEY}`,
        'x-folder-id': YC_FOLDER_ID,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Таймаут ответа Yandex Cloud (45 секунд)');
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Yandex Cloud API ошибка ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const messageText = data?.result?.alternatives?.[0]?.message?.text;
  if (!messageText) throw new Error('Yandex Cloud вернул пустой ответ');
  return messageText;
}

/* ================= маршрут ================= */
app.get('/api/health', (req, res) => {
  res.json({
    ok: Boolean(YC_API_KEY && YC_FOLDER_ID),
    hasApiKey: Boolean(YC_API_KEY),
    hasFolderId: Boolean(YC_FOLDER_ID),
    model: YC_MODEL,
    checks: CHECK_DEFS.length,
  });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const rawUrl = req.body?.url;
    if (!rawUrl) throw new Error('Не передан URL сайта');

    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch (error) {
      throw new Error('Некорректный URL. Пример правильного: https://mysite.tilda.ws');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('URL должен начинаться с http:// или https://');
    }
    if (isPrivateOrLocalHost(parsedUrl.hostname)) {
      throw new Error('Нельзя анализировать локальные или служебные адреса');
    }

    // Фаза 1: страница
    const page = await fetchPage(parsedUrl.toString());
    const finalUrl = page.finalUrl;
    const $ = cheerio.load(page.html);

    const scripts = collectScripts($, finalUrl);
    const imgs = collectImages($, finalUrl);
    const headings = collectHeadings($);

    const title = cleanText($('title').first().text()) || 'Не указан';
    const description =
      cleanText($('meta[name="description"]').attr('content')) ||
      cleanText($('meta[property="og:description"]').attr('content')) ||
      'Не указан';
    const mobile = $('meta[name="viewport"]').length > 0;

    const cacheControl = String(page.response.headers.get('cache-control') || '');
    const cacheHeaders = /max-age=\s*[1-9]/.test(cacheControl) ||
      Boolean(page.response.headers.get('etag')) ||
      Boolean(page.response.headers.get('last-modified'));

    $('script, style, noscript, svg').remove();
    const bodyText = cleanText($('body').text());
    const textLen = bodyText.length;
    const bodySample = bodyText.slice(0, 1500) || 'Текст не найден';

    // Фаза 2: внешние зонды — параллельно
    const origin = new URL(finalUrl).origin;
    const [robots, sitemap, probe404, weight] = await Promise.all([
      probeText(origin + '/robots.txt'),
      probeText(origin + '/sitemap.xml'),
      fetchProbe(origin + '/tildafixer-probe-' + Math.random().toString(36).slice(2), { timeout: 8000 }),
      probeImageWeights(imgs.srcs),
    ]);

    const cta =
      Number($('a[href^="tel:"]').length + $('a[href^="mailto:"]').length > 0) +
      Number($('a[class*="btn"], button, [class*="t-btn"]').length > 0) +
      Number($('form').length > 0);

    // Фаза 3: детерминированные проверки
    const results = runCodeChecks({
      $, title, description, headings, imgs, scripts,
      loadMs: page.loadMs, cacheHeaders, mobile, textLen,
      robots, sitemap, probe404,
      https: new URL(finalUrl).protocol === 'https:',
      weight, cta,
    });

    // Фаза 4: ИИ — персональные инструкции и две «судейские» проверки
    const tasks = buildAiTasks(results);
    const enrich = {};
    let aiUsed = false;

    if (tasks.length) {
      try {
        const pageSummary = {
          url: finalUrl,
          title,
          description,
          h1: cleanText($('h1').first().text()) || 'Не найден',
          headers: headings.filter((h) => h.level <= 3).map((h) => h.text).filter(Boolean).slice(0, 10).join(' | ') || 'Не найдено',
          noAlt: imgs.noAltSrcs.join(' | ') || 'Нет',
          bodySample,
        };
        const raw = await askYandex(pageSummary, tasks);
        const parsed = parseAiArray(raw);
        if (!parsed) throw new Error('Модель вернула не массив');
        const allowed = new Set(tasks.map((t) => t.id));
        for (const rawItem of parsed) {
          const item = sanitizeAiItem(rawItem, allowed);
          if (!item) continue;
          const def = DEFS_BY_ID.get(item.id);
          if (!def) continue;
          if (def.judge) {
            results[item.id] = {
              status: item.status || 'warn',
              description: item.description || 'Оценка выполнена ИИ.',
            };
            if (item.steps && item.steps.length) enrich[item.id] = { path: item.path, steps: item.steps };
          } else if (results[item.id] && results[item.id].status !== 'ok') {
            if (item.steps && item.steps.length) {
              enrich[item.id] = { path: item.path, steps: item.steps, suggestion: item.suggestion };
            } else if (item.suggestion) {
              enrich[item.id] = { ...(BASE_FIX[item.id] || {}), suggestion: item.suggestion };
            }
          }
        }
        aiUsed = true;
      } catch (error) {
        console.warn('[AI FALLBACK]', error.message);
      }
    }

    // Фолбэк для судейских проверок, если ИИ не ответил
    if (!results.head_keys) {
      results.head_keys = { status: 'warn', description: 'Глубокий анализ заголовков временно недоступен. Проверьте сами: заголовки должны отвечать на запросы ваших клиентов.' };
    }
    if (!results.spam) {
      results.spam = naiveSpamFallback(bodyText);
    }

    // Фаза 5: сборка ответа
    let score = 100;
    const counts = { ok: 0, warn: 0, crit: 0 };
    const items = CHECK_DEFS.map((def) => {
      const st = results[def.id] || { status: 'warn', description: 'Нет данных по проверке.' };
      counts[st.status] = (counts[st.status] || 0) + 1;
      if (st.status === 'crit') score -= 8;
      else if (st.status === 'warn') score -= 3;

      const item = {
        id: def.id,
        cat: def.cat,
        title: def.title,
        status: st.status,
        description: st.description,
      };

      if (st.status !== 'ok') {
        const en = enrich[def.id];
        const base = BASE_FIX[def.id];
        item.fix = {
          path: (en && en.path) || (base && base.path) || 'Редактор Tilda',
          steps: en && en.steps && en.steps.length ? en.steps : (base && base.steps) || [],
        };
        if (en && en.suggestion) item.suggestion = en.suggestion;
      }
      return item;
    });

    score = Math.max(12, Math.min(98, score));

    res.json({
      ok: true,
      url: finalUrl,
      score,
      counts,
      aiUsed,
      total: items.length,
      items,
    });
  } catch (error) {
    console.error('[ANALYZE ERROR]', error);
    res.status(500).json({ ok: false, error: error.message || 'Неизвестная ошибка на сервере' });
  }
});

app.listen(PORT, () => {
  console.log(`TildaFixer запущен: http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Проверок в чек-листе: ${CHECK_DEFS.length}`);
});