// The version index.html loads the code with (?v=…, added by updates): the admin panel's files get the same
const CODE_VERSION = (() => {
  try { return document.currentScript ? new URL(document.currentScript.src).search : ''; } catch { return ''; }
})();

// Mobile nav toggle
const navToggle = document.getElementById('nav-toggle');
const mainNav = document.getElementById('main-nav');

navToggle.addEventListener('click', () => {
  const isOpen = mainNav.classList.toggle('is-open');
  navToggle.setAttribute('aria-expanded', String(isOpen));
});

// Choosing a link closes the phone menu (links are built from the sections, see applySections)
mainNav.addEventListener('click', (e) => {
  if (!e.target.closest('a')) return;
  mainNav.classList.remove('is-open');
  navToggle.setAttribute('aria-expanded', 'false');
});

// Page content comes from content/site.js (edited through the admin panel)
// Icons a work category can use on cards without a cover image (admin: a Work section → Categories)
const CATEGORY_ICONS = {
  play: '<path d="M8 5v14l11-7z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  code: '<path d="M8 18l-6-6 6-6M16 6l6 6-6 6"/>',
  camera: '<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="4"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  pen: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 7l3 3"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-1.2-1-1.4-1-2.6 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  book: '<path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h12"/>',
  cube: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
  shirt: '<path d="M8 3l-5 3 2 4 3-1v12h8V9l3 1 2-4-5-3a4 4 0 0 1-8 0z"/>',
  heart: '<path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
};
window.CATEGORY_ICONS = CATEGORY_ICONS;
const iconSvg = (name) => `<svg viewBox="0 0 24 24" class="thumb-icon${name === 'play' ? ' is-filled' : ''}">${CATEGORY_ICONS[name] || CATEGORY_ICONS.play}</svg>`;

// Content saved before categories were editable used these three
const DEFAULT_CATEGORIES = [{ id: 'video', icon: 'play' }, { id: 'audio', icon: 'music' }, { id: 'code', icon: 'code' }];
// Card tile colours for categories without their own colour, in category order
const TILE_COLORS = [
  'var(--accent-dark)',
  'color-mix(in srgb, var(--accent-orange) 45%, #000)',
  'color-mix(in srgb, var(--surface) 70%, #000)',
  'color-mix(in srgb, var(--text-dim) 35%, #000)',
];
let categories = DEFAULT_CATEGORIES;
const categoryOf = (id) => categories.find((c) => c.id === id) || categories[0] || DEFAULT_CATEGORIES[0];

// Platforms for the contact icons and footer links (admin: Site tab). The first five have
// their icon here; the rest load theirs from the Simple Icons set on jsDelivr.
const SOCIALS = [
  ['instagram', 'Instagram', 'M12 2.2c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23a3.7 3.7 0 0 1-.9 1.38 3.7 3.7 0 0 1-1.38.9c-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.21 15.58 2.2 15.2 2.2 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.21 8.8 2.2 12 2.2zm0 1.8c-3.15 0-3.5.01-4.73.07-.96.04-1.48.2-1.82.34-.46.18-.78.39-1.13.73-.34.35-.55.67-.73 1.13-.14.34-.3.86-.34 1.82C3.19 8.5 3.18 8.85 3.18 12s.01 3.5.07 4.73c.04.96.2 1.48.34 1.82.18.46.39.78.73 1.13.35.34.67.55 1.13.73.34.14.86.3 1.82.34 1.23.06 1.58.07 4.73.07s3.5-.01 4.73-.07c.96-.04 1.48-.2 1.82-.34.46-.18.78-.39 1.13-.73.34-.35.55-.67.73-1.13.14-.34.3-.86.34-1.82.06-1.23.07-1.58.07-4.73s-.01-3.5-.07-4.73c-.04-.96-.2-1.48-.34-1.82a3 3 0 0 0-.73-1.13 3 3 0 0 0-1.13-.73c-.34-.14-.86-.3-1.82-.34C15.5 4.01 15.15 4 12 4zm0 3.05a4.95 4.95 0 1 1 0 9.9 4.95 4.95 0 0 1 0-9.9zm0 8.16a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zm6.3-8.36a1.16 1.16 0 1 1-2.31 0 1.16 1.16 0 0 1 2.31 0z'],
  ['linkedin', 'LinkedIn', 'M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.03-1.85-3.03-1.85 0-2.14 1.45-2.14 2.94v5.66H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45z'],
  ['youtube', 'YouTube', 'M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31.4 31.4 0 0 0 0 12a31.4 31.4 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31.4 31.4 0 0 0 24 12a31.4 31.4 0 0 0-.5-5.8zM9.6 15.6V8.4l6.2 3.6-6.2 3.6z'],
  ['github', 'GitHub', 'M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z'],
  ['facebook', 'Facebook', 'M13.5 21v-7.5h2.5l.5-3h-3V8.5c0-.87.24-1.46 1.5-1.46H16.5V4.35c-.26-.04-1.15-.11-2.19-.11-2.17 0-3.66 1.32-3.66 3.75V10.5H8v3h2.65V21h2.85z'],
  ['tiktok', 'TikTok'],
  ['x', 'X (Twitter)'],
  ['threads', 'Threads'],
  ['bluesky', 'Bluesky'],
  ['behance', 'Behance'],
  ['dribbble', 'Dribbble'],
  ['artstation', 'ArtStation'],
  ['pinterest', 'Pinterest'],
  ['vimeo', 'Vimeo'],
  ['twitch', 'Twitch'],
  ['spotify', 'Spotify'],
  ['soundcloud', 'SoundCloud'],
  ['bandcamp', 'Bandcamp'],
  ['etsy', 'Etsy'],
  ['patreon', 'Patreon'],
  ['substack', 'Substack'],
];
window.SITE_SOCIALS = SOCIALS.map(([key, name]) => ({ key, name }));
const LINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" class="icon-line"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>';

function socialIcon(key) {
  const entry = SOCIALS.find(([k]) => k === key);
  if (entry && entry[2]) return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${entry[2]}"/></svg>`;
  if (entry) return `<span class="icon-mask" aria-hidden="true" style="--icon: url('https://cdn.jsdelivr.net/npm/simple-icons@13/icons/${key}.svg')"></span>`;
  return LINK_ICON;
}

// ---------- Languages ----------
// Which languages the site offers is set in the admin panel (Site tab), stored as
// content.languages = { main, available: [codes], ui: { <code>: { <key>: text } } }.
// main: the language the content is written in. Content in content/site.js can carry translations as
// "i18n": { "nl": { ...same keys... } } on any object; a missing or empty translation shows the main language.
// Interface text (menu, buttons, form labels) comes from js/i18n.js; languages.ui replaces or adds to it.
// Languages that can be added (left to right only: the layout isn't made for right-to-left scripts)
const LANGUAGE_NAMES = {
  en: 'English', nl: 'Nederlands', fr: 'Français', de: 'Deutsch', es: 'Español', it: 'Italiano', pt: 'Português',
  pl: 'Polski', tr: 'Türkçe', ro: 'Română', sv: 'Svenska', da: 'Dansk', no: 'Norsk', fi: 'Suomi', cs: 'Čeština',
  sk: 'Slovenčina', hu: 'Magyar', el: 'Ελληνικά', uk: 'Українська', ru: 'Русский', ja: '日本語', zh: '中文',
  ko: '한국어', id: 'Bahasa Indonesia', vi: 'Tiếng Việt',
};
window.LANGUAGE_NAMES = LANGUAGE_NAMES;
const UI_TEXT = window.SITE_UI_TEXT || {};
const LANG_KEY = 'am-lang';

// The language settings, with what js/i18n.js offers when the content doesn't say
function languageSettings(content) {
  const own = (content && content.languages) || {};
  const builtIn = Object.keys(window.SITE_LANGUAGES || { en: 'English' });
  const known = (code) => Boolean(LANGUAGE_NAMES[code]);
  const main = known(own.main) ? own.main : 'en';
  const available = [...new Set([main, ...(Array.isArray(own.available) ? own.available : builtIn)].filter(known))];
  return { main, available, ui: own.ui || {} };
}

// After saving in the admin panel, the host takes a minute or two to publish, and browsers may keep an
// older copy of content/site.js for a while. The browser that saved keeps its latest save (admin.js,
// rememberLatestSave) and shows that until the live content is at least as new, with a small note.
// Visitors always see the published version.
// Per site: several GitHub Pages sites of one account share an address (<user>.github.io/<repo>/)
const LATEST_SAVE_KEY = `am-latest-save:${window.location.pathname.replace(/[^/]*$/, '')}`;
const LATEST_SAVE_MAX_AGE = 24 * 60 * 60 * 1000;

function latestSave() {
  try {
    const saved = JSON.parse(localStorage.getItem(LATEST_SAVE_KEY) || 'null');
    if (!saved) return null;
    const live = (window.SITE_CONTENT && window.SITE_CONTENT.savedAt) || '';
    const age = Date.now() - Date.parse(saved.savedAt);
    if (!saved.savedAt || !saved.content || saved.savedAt <= live || !(age < LATEST_SAVE_MAX_AGE)) {
      localStorage.removeItem(LATEST_SAVE_KEY);
      return null;
    }
    return { ...saved, age };
  } catch {
    return null;
  }
}

function showSaveNote(age) {
  const minutes = Math.round(age / 60000);
  const when = minutes < 1 ? 'just now' : `${minutes} min ago`;
  showNote(minutes < 10
    ? `Showing your latest save (${when}). The live site is still updating; visitors see it within a few minutes.`
    : `Showing your latest save (${when}), but the live site still has an older version. Check that GitHub Pages is publishing: your repository \u2192 Actions, or Settings \u2192 Pages.`);
}

// A small note at the bottom of the screen, with a button to close it
function showNote(text) {
  const note = el('div', 'save-note');
  note.setAttribute('role', 'status');
  note.appendChild(el('span', null, text));
  const close = el('button', null, '\u00D7');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => note.remove());
  note.appendChild(close);
  document.body.appendChild(note);
}

const pendingSave = latestSave();
if (pendingSave) window.SITE_CONTENT = pendingSave.content;

let langSettings = languageSettings(window.SITE_CONTENT);
const isAvailable = (code) => langSettings.available.includes(code);

function detectLanguage() {
  const supported = (code) => (code && isAvailable(code.slice(0, 2).toLowerCase()) ? code.slice(0, 2).toLowerCase() : '');
  let stored = '';
  try { stored = localStorage.getItem(LANG_KEY) || ''; } catch { /* storage blocked */ }
  return supported(new URLSearchParams(window.location.search).get('lang'))
    || supported(stored)
    || (navigator.languages || [navigator.language]).map(supported).find(Boolean)
    || langSettings.main;
}

let currentLang = detectLanguage();

// Interface text can be replaced from the content (section titles and menu labels, admin: Page tab;
// any interface text per language, admin: Site tab), and may mention the site owner as {name} or {first}
let textOverrides = {};
let siteName = 'Your Name';
let firstName = 'Your';
function uiText(key, lang) {
  const own = langSettings.ui[lang] && langSettings.ui[lang][key];
  return (own && own.trim()) || (UI_TEXT[key] && UI_TEXT[key][lang]) || '';
}
const t = (key) => (textOverrides[key] || uiText(key, currentLang) || uiText(key, langSettings.main) || uiText(key, 'en') || key)
  .replace(/\{name\}/g, siteName).replace(/\{first\}/g, firstName);
const typeLabel = (type) => {
  const cat = categories.find((c) => c.id === type);
  if (cat && cat.label) return cat.label;
  return UI_TEXT[`type.${type}`] ? t(`type.${type}`) : type;
};

// Returns a copy of the content with the current language's translations laid over the main language.
// Lists (bio paragraphs, skills) are overlaid item by item.
function localize(value) {
  if (Array.isArray(value)) return value.map(localize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  Object.entries(value).forEach(([key, v]) => { if (key !== 'i18n') out[key] = localize(v); });
  const tr = currentLang !== langSettings.main && value.i18n && value.i18n[currentLang];
  if (tr) {
    Object.entries(tr).forEach(([key, v]) => {
      if (Array.isArray(v) && Array.isArray(out[key])) out[key] = out[key].map((en, i) => v[i] || en);
      else if (typeof v === 'string' && v) out[key] = v;
    });
  }
  return out;
}

function applyUiText(root) {
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    const text = t(node.dataset.i18n);
    // Re-splitting an unchanged heading would restart its letters for nothing
    if (node.classList.contains('reveal')) { if (node.dataset.raw !== text) setRevealText(node, text); }
    else node.textContent = text;
  });
  root.querySelectorAll('[data-i18n-label]').forEach((node) => node.setAttribute('aria-label', t(node.dataset.i18nLabel)));
  root.querySelectorAll('[data-i18n-alt]').forEach((node) => { node.alt = t(node.dataset.i18nAlt); });
}

const langMenu = document.querySelector('.lang-menu');
const navLangs = document.querySelector('.nav-langs');
const langToggle = document.getElementById('lang-toggle');
const langList = document.getElementById('lang-list');

// The language switch (desktop dropdown and the list in the phone menu), left out with only one language
function buildLangSwitch() {
  const key = langSettings.available.join(',');
  const single = langSettings.available.length < 2;
  langMenu.hidden = single;
  navLangs.hidden = single;
  if (langList.dataset.key !== key) {
    langList.dataset.key = key;
    [langList, navLangs].forEach((box) => {
      box.innerHTML = '';
      langSettings.available.forEach((code) => {
        const link = el('a', null, LANGUAGE_NAMES[code]);
        link.href = `?lang=${code}`;
        link.hreflang = code;
        link.lang = code;
        box.appendChild(link);
      });
    });
  }
  document.querySelectorAll('.lang-list a, .nav-langs a').forEach((link) => link.setAttribute('aria-current', String(link.hreflang === currentLang)));
  langToggle.querySelector('.lang-current').textContent = currentLang.toUpperCase();
}

function applyLanguage() {
  document.documentElement.lang = currentLang;
  applyUiText(document);
  buildLangSwitch();
}

// Switch language without reloading; remembered in this browser and shown in the address (?lang=nl)
function setLanguage(lang) {
  if (!isAvailable(lang) || lang === currentLang) return;
  currentLang = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* storage blocked */ }
  try {
    const url = new URL(window.location.href);
    if (lang === langSettings.main) url.searchParams.delete('lang');
    else url.searchParams.set('lang', lang);
    history.replaceState(history.state, '', url);
  } catch { /* address can't be changed (e.g. some file:// pages) */ }
  applyLanguage();
  renderSite(currentContent);
  document.dispatchEvent(new CustomEvent('site:languagechange', { detail: { lang } }));
}

// The language settings changed (admin preview): rebuild the switch, and leave a language that was taken away
function updateLanguages(content) {
  langSettings = languageSettings(content);
  if (!isAvailable(currentLang)) {
    currentLang = langSettings.main;
    document.documentElement.lang = currentLang;
    document.dispatchEvent(new CustomEvent('site:languagechange', { detail: { lang: currentLang } }));
  }
  buildLangSwitch();
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('.lang-list a, .nav-langs a');
  if (!link) return;
  e.preventDefault();
  closeLangList();
  setLanguage(link.hreflang);
});

// Desktop language dropdown: opens on click, closes on a choice, Esc or a click elsewhere
function closeLangList() {
  langList.hidden = true;
  langToggle.setAttribute('aria-expanded', 'false');
}

langToggle.addEventListener('click', () => {
  const open = langList.hidden;
  langList.hidden = !open;
  langToggle.setAttribute('aria-expanded', String(open));
  if (open) (langList.querySelector('[aria-current="true"]') || langList.querySelector('a')).focus();
});

document.addEventListener('click', (e) => {
  if (!langList.hidden && !e.target.closest('.lang-menu')) closeLangList();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !langList.hidden) {
    closeLangList();
    langToggle.focus();
  }
});

// Used by the admin panel to edit each language
window.SiteI18n = {
  get languages() { return Object.fromEntries(langSettings.available.map((code) => [code, LANGUAGE_NAMES[code]])); },
  get main() { return langSettings.main; },
  get lang() { return currentLang; },
  names: LANGUAGE_NAMES,
  settings: languageSettings,
  setLanguage,
};

// The admin panel previews unsaved uploads by mapping their future path to a local blob URL
const assetUrl = (path) => (window.SITE_ASSET_OVERRIDES && window.SITE_ASSET_OVERRIDES[path]) || path;

// Only allow web, mail and relative links in content
function safeUrl(url) {
  try {
    const { protocol } = new URL(url, window.location.href);
    return ['http:', 'https:', 'mailto:', 'file:'].includes(protocol) ? url : '';
  } catch {
    return '';
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Tags rendered text with its place in the content (e.g. "work.2.title") so the admin panel can edit it in place
function field(node, path) {
  node.dataset.field = path;
  return node;
}

// A field that may be empty: while editing, it says what goes there (only shown in the admin panel)
function blankable(node, path, placeholder) {
  field(node, path);
  node.dataset.placeholder = placeholder;
  node.classList.toggle('is-empty', !String(node.textContent || '').trim());
  return node;
}

function youtubeEmbed(id, title, autoplay) {
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}${autoplay ? '?autoplay=1' : ''}`;
  iframe.title = title;
  iframe.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen';
  iframe.allowFullscreen = true;
  return iframe;
}

const reelFrame = document.getElementById('reel-frame');
const reelPlaceholder = reelFrame.innerHTML;
let workItems = []; // content.work, for the project pop-up

// A project can hold several videos (item.videos); content saved before that had one video on the item itself
function projectVideos(item) {
  const list = Array.isArray(item.videos) ? item.videos : [{ video: item.video, youtube: item.youtube }];
  return list.filter((clip) => clip && (clip.video || clip.youtube));
}

const youtubeThumb = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;

// Cover: the project's own thumbnail, else the first video's, else YouTube's own thumbnail
function coverImage(item) {
  const first = projectVideos(item)[0] || {};
  if (item.thumb) return assetUrl(item.thumb);
  if (first.thumb) return assetUrl(first.thumb);
  if (first.youtube) return youtubeThumb(first.youtube);
  const picture = projectPictures(item)[0];
  return picture ? assetUrl(picture.src) : '';
}

// A project's pictures (item.images = [{ src, alt }]), shown after its videos in the pop-up
const projectPictures = (item) => (Array.isArray(item.images) ? item.images : []).filter((img) => img && img.src);

function buildThumb(item) {
  const cat = categoryOf(item.type);
  const thumb = el('div', 'card-thumb');
  thumb.style.setProperty('--tile', cat.color || TILE_COLORS[Math.max(categories.indexOf(cat), 0) % TILE_COLORS.length]);
  const image = coverImage(item);
  if (image) {
    thumb.classList.add('has-image');
    const img = el('img');
    img.src = image;
    img.alt = item.thumbAlt || item.title || '';
    img.loading = 'lazy';
    thumb.appendChild(img);
    if (projectVideos(item).length) {
      const play = el('span', 'thumb-play');
      play.setAttribute('aria-hidden', 'true');
      play.innerHTML = `<svg viewBox="0 0 24 24">${CATEGORY_ICONS.play}</svg>`;
      thumb.appendChild(play);
    }
  } else {
    thumb.innerHTML = iconSvg(cat.icon);
  }
  return thumb;
}

// ---------- Work grids ----------
// Each Work section (the first one in index.html, plus copies added in the admin panel) has its own
// highlights slider, filter buttons and cards. All of them show projects from the one content.work list;
// a grid can be limited to some categories (content.sections.<id>.categories, empty = all).
//
// Highlights slider: the grid's projects marked Featured, one big slide at a time. Swipe/scroll, arrows
// or dots move it; it also moves on its own (admin: a Work section), pausing while the pointer is over
// it, after the visitor touches it, while a pop-up is open or when off screen.
const prefersStill = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Muted preview on hover only with a mouse, and not for visitors who reduce motion or save data
const slidePreviews = window.matchMedia('(hover: hover) and (pointer: fine)').matches && !prefersStill
  && !(navigator.connection && navigator.connection.saveData);
const grids = new Map(); // section id -> grid

function attachSlidePreview(slide, thumb, clip) {
  let video = null;
  slide.addEventListener('mouseenter', () => {
    video = document.createElement('video');
    video.className = 'thumb-preview';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.src = assetUrl(clip.video);
    video.addEventListener('loadedmetadata', () => {
      if (video && Number.isFinite(video.duration)) video.currentTime = video.duration * 0.15;
    }, { once: true });
    video.addEventListener('playing', () => video && video.classList.add('is-on'), { once: true });
    thumb.appendChild(video);
    video.play().catch(() => {});
  });
  slide.addEventListener('mouseleave', () => {
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    video = null;
  });
}

// Title, client · year, teaser and "Watch video" for a card or slide
function projectBody(item, index, className, teaserClass) {
  const count = projectVideos(item).length;
  const pictures = projectPictures(item).length;
  const details = [item.client, item.year].filter(Boolean);
  if (count > 1) details.push(t('work.videoCount').replace('{n}', count));
  if (pictures > 1) details.push(t('work.pictureCount').replace('{n}', pictures));
  const body = el('div', className);
  body.append(...[
    el('span', 'card-tag', typeLabel(item.type)),
    field(el('h3', null, item.title), `work.${index}.title`),
    details.length ? el('p', 'card-meta', details.join(' · ')) : null,
    field(formatted(el('p', teaserClass), item.teaser), `work.${index}.teaser`),
    el('span', 'view-more', t(count > 1 ? 'work.watchMany' : count ? 'work.watch' : pictures ? 'work.viewPictures' : 'work.details')),
  ].filter(Boolean));
  return body;
}

// Clicks and Enter/Space on a card or slide open the project pop-up
function opensModal(container, selector) {
  container.addEventListener('click', (e) => {
    const target = e.target.closest(selector);
    if (!target) return;
    target.querySelectorAll('.thumb-preview').forEach((v) => v.pause());
    openProject(Number(target.dataset.index), { card: target });
  });
  container.addEventListener('keydown', (e) => {
    const target = e.target.closest(selector);
    if (target && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openProject(Number(target.dataset.index), { card: target });
    }
  });
}

function createGrid(section) {
  const g = {
    section,
    box: section.querySelector('.featured'),
    track: section.querySelector('.featured-track'),
    dots: section.querySelector('.featured-dots'),
    bar: section.querySelector('.filter-bar'),
    cards: section.querySelector('.work-grid'),
    count: 0,
    index: 0,
    timer: 0,
    holdUntil: 0,
    hover: false,
    onScreen: !('IntersectionObserver' in window),
    filter: 'all',
  };
  // Visitor touched the slider: don't move it on their behalf for a while
  g.hold = () => { g.holdUntil = Date.now() + 12000; };
  section.querySelector('.featured-prev').addEventListener('click', () => { g.hold(); goToSlide(g, g.index - 1); });
  section.querySelector('.featured-next').addEventListener('click', () => { g.hold(); goToSlide(g, g.index + 1); });
  g.box.addEventListener('mouseenter', () => { g.hover = true; });
  g.box.addEventListener('mouseleave', () => { g.hover = false; });
  ['pointerdown', 'wheel', 'touchstart'].forEach((type) => g.track.addEventListener(type, g.hold, { passive: true }));
  // Swiping/scrolling by hand: keep the dots in step
  let frame = 0;
  g.track.addEventListener('scroll', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      g.index = Math.round(g.track.scrollLeft / Math.max(g.track.clientWidth, 1));
      updateDots(g);
    });
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => { g.onScreen = entry.isIntersecting; }, { threshold: 0.4 }).observe(g.box);
  }
  g.bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    g.filter = btn.dataset.filter;
    g.bar.querySelectorAll('.filter-btn').forEach((b) => {
      b.classList.toggle('is-active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    applyFilter(g);
  });
  opensModal(g.track, '.featured-slide');
  opensModal(g.cards, '.work-card');
  return g;
}

// Keep each slider's current slide in place when the window is resized
window.addEventListener('resize', () => grids.forEach((g) => { g.track.scrollLeft = g.index * g.track.clientWidth; }));

function updateDots(g) {
  [...g.dots.children].forEach((dot, i) => dot.setAttribute('aria-current', String(i === g.index)));
}

function goToSlide(g, n) {
  if (!g.count) return;
  g.index = (n + g.count) % g.count;
  g.track.scrollTo({ left: g.index * g.track.clientWidth, behavior: prefersStill ? 'auto' : 'smooth' });
  updateDots(g);
}

function autoAdvance(g) {
  const busy = g.hover || Date.now() < g.holdUntil || !g.onScreen || document.hidden
    || !modal.hidden || g.box.contains(document.activeElement);
  if (!busy) goToSlide(g, g.index + 1);
}

function applyFilter(g) {
  g.cards.querySelectorAll('.work-card').forEach((card) => {
    card.classList.toggle('is-hidden', g.filter !== 'all' && card.dataset.type !== g.filter);
  });
}

// entries: [{ item, index }] for this grid (index = place in content.work, used by the pop-up and editing);
// shown: the categories this grid may show
function renderGrid(g, entries, settings, shown = categories) {
  // Filter buttons: only worth showing with two or more categories in use. While editing, every category
  // the grid may show gets one (empty ones faded), so a project can be added straight into it.
  const used = categories.filter((cat) => entries.some(({ item }) => categoryOf(item.type).id === cat.id));
  const buttons = isEditing() ? shown : used;
  if (g.filter !== 'all' && !buttons.some((cat) => cat.id === g.filter)) g.filter = 'all';
  g.bar.querySelectorAll('.filter-btn').forEach((btn) => btn.remove());
  g.bar.hidden = buttons.length < 2;
  [['all', t('work.all')], ...buttons.map((cat) => [cat.id, typeLabel(cat.id)])].forEach(([id, label]) => {
    const empty = id !== 'all' && !used.some((cat) => cat.id === id);
    const btn = el('button', `filter-btn${id === g.filter ? ' is-active' : ''}${empty ? ' is-empty' : ''}`, label);
    btn.type = 'button';
    btn.dataset.filter = id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(id === g.filter));
    g.bar.appendChild(btn);
  });

  // Every project as an equal card, in content order (featured ones also get a slide above)
  g.cards.innerHTML = '';
  g.cards.dataset.entries = 'work';
  entries.forEach(({ item, index }) => {
    const card = el('article', item.draft ? 'work-card is-draft' : 'work-card');
    card.dataset.type = categoryOf(item.type).id;
    card.dataset.index = index;
    card.dataset.editItem = `work.${index}`;
    card.dataset.entry = `work.${index}`;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-haspopup', 'dialog');
    card.append(buildThumb(item), projectBody(item, index, 'card-body', null));
    g.cards.appendChild(card);
  });
  applyFilter(g);

  const set = { autoplay: true, seconds: 6, ...(settings || {}) };
  g.track.innerHTML = '';
  g.dots.innerHTML = '';
  const featured = entries.filter(({ item }) => item.featured);
  g.count = featured.length;
  g.box.hidden = !g.count;
  g.box.classList.toggle('is-single', g.count < 2);
  featured.forEach(({ item, index }, n) => {
    const slide = el('article', 'featured-slide');
    slide.dataset.index = index;
    slide.dataset.editItem = `work.${index}`;
    slide.tabIndex = 0;
    slide.setAttribute('role', 'button');
    slide.setAttribute('aria-haspopup', 'dialog');
    const thumb = buildThumb(item);
    const clip = projectVideos(item).find((c) => c.video && safeUrl(c.video));
    if (clip && slidePreviews) attachSlidePreview(slide, thumb, clip);
    slide.append(thumb, projectBody(item, index, 'featured-body', 'featured-teaser'));
    g.track.appendChild(slide);

    const dot = el('button', 'featured-dot');
    dot.type = 'button';
    dot.setAttribute('aria-label', t('work.slide').replace('{n}', n + 1));
    dot.addEventListener('click', () => { g.hold(); goToSlide(g, n); });
    g.dots.appendChild(dot);
  });
  g.index = Math.min(g.index, Math.max(g.count - 1, 0));
  g.track.scrollLeft = g.index * g.track.clientWidth;
  updateDots(g);
  clearInterval(g.timer);
  if (set.autoplay && g.count > 1 && !prefersStill) {
    g.timer = setInterval(() => autoAdvance(g), Math.min(Math.max(Number(set.seconds) || 6, 2), 60) * 1000);
  }
}

// The first Work section as it is in index.html, copied for each extra grid
const workTemplate = document.getElementById('work').cloneNode(true);

// Extra grids (content.workGrids = [{ id, intro }]): add, update or remove their sections
function renderExtraGrids(list) {
  const main = document.getElementById('top');
  const ids = list.map((g) => g.id);
  main.querySelectorAll(':scope > section.work-extra').forEach((node) => {
    if (ids.includes(node.id)) return;
    clearInterval((grids.get(node.id) || {}).timer);
    grids.delete(node.id);
    node.remove();
  });
  list.forEach((grid, i) => {
    if (!/^[\w-]+$/.test(grid.id || '')) return;
    let node = document.getElementById(grid.id);
    if (!node) {
      node = workTemplate.cloneNode(true);
      node.id = grid.id;
      node.classList.add('work-extra');
      // Its own keys for hiding parts, its own intro, and a title set from the content
      node.querySelectorAll('[data-part]').forEach((part) => { part.dataset.part = part.dataset.part.replace(/^work(?=\.|$)/, grid.id); });
      node.dataset.part = grid.id;
      node.querySelector('.section-title').removeAttribute('data-i18n');
      main.appendChild(node);
    }
    const intro = node.querySelector('.section-intro');
    intro.dataset.editItem = `workGrids.${i}`;
    intro.querySelector('[data-text]').dataset.text = `workGrids.${i}.intro`;
  });
}

// Draft projects stay off the live site; while the admin panel is open (and not previewing) they show, marked
const isEditing = () => document.documentElement.classList.contains('adm-editing') && !document.documentElement.classList.contains('adm-previewing');
const showDrafts = isEditing;

// All grids on the page get their projects
function renderGrids(content) {
  const work = content.work || [];
  const sections = content.sections || {};
  const entries = work.map((item, index) => ({ item, index })).filter(({ item }) => !item.draft || showDrafts());
  document.querySelectorAll('main > section.work').forEach((section) => {
    if (!grids.has(section.id)) grids.set(section.id, createGrid(section));
    const allowed = ((sections[section.id] || {}).categories || []).filter((id) => categories.some((c) => c.id === id));
    renderGrid(grids.get(section.id), allowed.length ? entries.filter(({ item }) => allowed.includes(categoryOf(item.type).id)) : entries, content.highlights,
      allowed.length ? categories.filter((cat) => allowed.includes(cat.id)) : categories);
  });
}

function renderReel(reel) {
  const id = reel && reel.youtube;
  reelFrame.dataset.editItem = 'reel';
  // Same video as before: keep the player (rebuilding it reloads it, e.g. while editing in the admin panel)
  const key = `${id || ''}|${currentLang}`;
  if (reelFrame.dataset.key === key && reelFrame.querySelector('iframe, .reel-placeholder')) return;
  reelFrame.dataset.key = key;
  reelFrame.innerHTML = '';
  if (id) {
    const iframe = youtubeEmbed(id, t('reel.title'), false);
    iframe.loading = 'lazy';
    reelFrame.appendChild(iframe);
  } else {
    reelFrame.innerHTML = reelPlaceholder;
    applyUiText(reelFrame);
  }
}

function renderAbout(about) {
  const bio = document.getElementById('about-bio');
  bio.parentElement.dataset.editItem = 'about';
  bio.innerHTML = '';
  // Lists the admin panel can change on the page (data-entries; data-axis="y": one under the other)
  Object.assign(bio.dataset, { entries: 'about.paragraphs', axis: 'y' });
  (about.paragraphs || []).forEach((text, i) => {
    // An empty paragraph only shows while editing, to be typed in
    if (!(text && text.trim()) && !isEditing()) return;
    const p = field(formatted(el('p', text && text.trim() ? null : 'is-empty'), text), `about.paragraphs.${i}`);
    p.dataset.entry = `about.paragraphs.${i}`;
    bio.appendChild(p);
  });
  const skills = document.getElementById('about-skills');
  skills.innerHTML = '';
  skills.dataset.entries = 'about.skills';
  (about.skills || []).forEach((skill, i) => {
    const tag = field(el('span', 'skill-tag', skill), `about.skills.${i}`);
    tag.dataset.entry = `about.skills.${i}`;
    skills.appendChild(tag);
  });
  // No photo set: the text takes the full width (same as hiding the photo)
  const photo = document.getElementById('about-photo-img');
  if (about.photo) photo.src = assetUrl(about.photo);
  else photo.closest('.about-photo').classList.add('is-removed');
}

function renderExperience(entries) {
  const timeline = document.getElementById('timeline');
  timeline.innerHTML = '';
  Object.assign(timeline.dataset, { entries: 'experience', axis: 'y' });
  entries.forEach((entry, i) => {
    const li = el('li', 'timeline-item');
    li.dataset.editItem = `experience.${i}`;
    li.dataset.entry = `experience.${i}`;
    const h3 = el('h3');
    h3.appendChild(blankable(formatted(el('span'), entry.role), `experience.${i}.role`, 'Role'));
    if (entry.org || isEditing()) {
      h3.appendChild(document.createTextNode(' '));
      h3.appendChild(blankable(el('span', 'timeline-org', entry.org), `experience.${i}.org`, 'Company or project'));
    }
    // Empty date or description: left out instead of an empty line (while editing: a spot to fill in)
    li.append(...[
      entry.date || isEditing() ? blankable(el('span', 'timeline-date', entry.date), `experience.${i}.date`, 'Dates') : null,
      h3,
      entry.text || isEditing() ? blankable(formatted(el('p'), entry.text), `experience.${i}.text`, 'What you did') : null,
    ].filter(Boolean));
    timeline.appendChild(li);
  });
}

function renderToolkit(rows) {
  const toolkit = document.getElementById('toolkit-list');
  toolkit.innerHTML = '';
  Object.assign(toolkit.dataset, { entries: 'toolkit', axis: 'y' });
  rows.forEach((row, i) => {
    const wrap = el('div', 'toolkit-row');
    wrap.dataset.editItem = `toolkit.${i}`;
    wrap.dataset.entry = `toolkit.${i}`;
    const dd = el('dd');
    (row.tools || []).forEach((tool, j) => dd.appendChild(field(el('span', 'skill-tag', tool), `toolkit.${i}.tools.${j}`)));
    wrap.append(field(el('dt', null, row.label), `toolkit.${i}.label`), dd);
    toolkit.appendChild(wrap);
  });
}

// Fixed spots in index.html marked data-text="hero.intro" etc.; if the content has no value, the HTML text stays
function renderTexts(content) {
  document.querySelectorAll('[data-text]').forEach((node) => {
    const value = node.dataset.text.split('.').reduce((obj, key) => (obj ? obj[key] : undefined), content);
    if (typeof value === 'string') {
      node.textContent = '';
      formatted(node, value);
      // Emptied in the admin panel: take it off the page instead of leaving a gap
      node.classList.toggle('is-empty', !value.trim());
    }
    field(node, node.dataset.text);
  });
}

// Links from content: links = { email, instagram, … } (empty hides it), customLinks = [{ label, url, footer }]
// for anything else, and footerLinks = the platforms also listed in the footer.
// Contact icons show every platform that has an address (LinkedIn has its own button instead).
let contactEmail = '';
const DEFAULT_FOOTER_LINKS = ['youtube', 'github', 'linkedin'];

function externalLink(url, label) {
  const link = el('a');
  link.href = safeUrl(url) || '#';
  link.target = '_blank';
  link.rel = 'noopener';
  if (label) link.setAttribute('aria-label', label);
  return link;
}

function renderLinks(links, customLinks, footerLinks) {
  const value = (key) => (links[key] || '').trim();
  contactEmail = value('email');
  document.querySelectorAll('[data-link="email"]').forEach((link) => {
    link.hidden = !contactEmail;
    link.href = contactEmail ? `mailto:${contactEmail}` : '';
    link.textContent = contactEmail;
  });
  document.querySelectorAll('[data-link="linkedin"]').forEach((link) => {
    link.hidden = !value('linkedin');
    link.href = safeUrl(value('linkedin')) || '#';
  });

  const custom = (customLinks || []).filter((l) => l && l.label && l.url);
  const socials = document.querySelector('.contact-socials');
  socials.querySelectorAll(':scope > a').forEach((a) => a.remove());
  SOCIALS.forEach(([key, name]) => {
    if (key === 'linkedin' || !value(key)) return;
    const link = externalLink(value(key), name);
    link.innerHTML = socialIcon(key);
    socials.appendChild(link);
  });
  custom.forEach((l) => {
    const link = externalLink(l.url, l.label);
    link.innerHTML = LINK_ICON;
    socials.appendChild(link);
  });

  const footer = document.querySelector('.footer-links');
  footer.querySelectorAll(':scope > a').forEach((a) => a.remove());
  const inFooter = Array.isArray(footerLinks) ? footerLinks : DEFAULT_FOOTER_LINKS;
  // In the order they were ticked
  inFooter.forEach((key) => {
    const entry = SOCIALS.find(([k]) => k === key);
    if (entry && value(key)) footer.appendChild(Object.assign(externalLink(value(key)), { textContent: entry[1].replace(/ \(.*\)$/, '') }));
  });
  custom.filter((l) => l.footer).forEach((l) => footer.appendChild(Object.assign(externalLink(l.url), { textContent: l.label })));
}

// Top section background: a looping muted video if set (not for visitors who reduce motion), else a photo
const heroMedia = document.getElementById('hero-media');

function renderHeroMedia(hero) {
  const image = hero.background ? assetUrl(hero.background) : '';
  const videoSrc = hero.backgroundVideo ? safeUrl(assetUrl(hero.backgroundVideo)) : '';
  const key = `${image}|${videoSrc}`;
  if (heroMedia.dataset.key === key) return; // unchanged: don't restart the video
  heroMedia.dataset.key = key;
  heroMedia.innerHTML = '';
  if (videoSrc && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const video = document.createElement('video');
    video.src = videoSrc;
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    if (image) video.poster = image;
    heroMedia.appendChild(video);
  } else if (image) {
    const img = el('img');
    img.src = image;
    img.alt = '';
    heroMedia.appendChild(img);
  }
}

// "Portrait" style: the top section's own picture, else the About photo
const heroPortrait = document.getElementById('hero-portrait');

function renderHeroPortrait(content) {
  const src = (content.hero && content.hero.portrait) || (content.about && content.about.photo) || '';
  const img = heroPortrait.querySelector('img');
  if (src) img.src = assetUrl(src);
  else img.removeAttribute('src');
}

// ---------- Top section: preview monitor + editing timeline ----------
// The V1 track holds one clip per uploaded video in Work. The playhead sweeps across in real time;
// when it enters a clip, the monitor cuts (muted) to that video at a random point. Two players take
// turns so the next clip is already loading before the cut. Other tracks are decoration.
// Settings from the admin panel's "Top section" tab (content: hero.layout). Anything missing uses these.
const HERO_DEFAULTS = {
  // "editor": preview monitor and editing timeline; "portrait": a picture beside the name; "centered": text only, centred
  style: 'editor',
  portraitSize: 100,
  nameOneLine: false,
  nameScale: 100,
  showRole: true,
  showIntro: true,
  showAvailability: true,
  showWorkButton: true,
  showContactButton: true,
  showResume: true,
  showMonitor: true,
  monitorSize: 100,
  monitorLabel: 'Program',
  monitorStart: 'random',
  monitorOrder: 'featured',
  showTimeline: true,
  timelineSeconds: 36,
  timelineFps: 25,
  showExtraTracks: true,
  showTrackLabels: true,
  showTimecode: true,
  allowScrub: true,
  showGlow: true,
  overlay: 90,
};
window.HERO_DEFAULTS = HERO_DEFAULTS;
let heroSettings = { ...HERO_DEFAULTS };
let TIMELINE_SECONDS = HERO_DEFAULTS.timelineSeconds;
let TIMELINE_FPS = HERO_DEFAULTS.timelineFps;
const TIMELINE_DECOR = {
  V2: [[6, 13], [30, 9], [57, 17], [85, 11]],
  A1: [[0, 32.5], [33, 40.5], [74, 26]],
  A2: [[4, 22], [39, 30], [77, 18]],
};
const CLIP_WEIGHTS = [1.2, 0.85, 1, 1.35, 0.9, 1.1, 0.95, 1.25];
const heroTimeline = document.getElementById('hero-timeline');
const heroMonitor = document.getElementById('hero-monitor');
const monitorPlayers = [...heroMonitor.querySelectorAll('video')];
const monitorTitle = document.getElementById('monitor-title');
const monitorTc = document.getElementById('monitor-tc');
// Stills instead of video for visitors who reduce motion, ask to save data or are on a slow connection
const monitorStill = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  || Boolean(navigator.connection && (navigator.connection.saveData || ['slow-2g', '2g', '3g'].includes(navigator.connection.effectiveType)));
let reelSources = [];
let timelineClips = [];
let timelineKey = '';
let playheadEl = null;
let timecodeEl = null;
let currentReel = -1;

// Uploaded videos from Work, featured projects first (YouTube can't play in the monitor). A video's
// lighter copy (clip.preview: smaller, no sound needed) plays here when it has one; the pop-up plays the video.
function reelFromWork(items) {
  const ordered = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.draft);
  if (heroSettings.monitorOrder === 'featured') {
    ordered.sort((a, b) => Number(Boolean(b.item.featured)) - Number(Boolean(a.item.featured)));
  }
  return ordered
    .flatMap(({ item }) => projectVideos(item)
      .filter((clip) => clip.video && safeUrl(clip.video) && !clip.hideInMonitor)
      .map((clip) => ({
        src: assetUrl(clip.preview && safeUrl(clip.preview) ? clip.preview : clip.video),
        poster: clip.thumb ? assetUrl(clip.thumb) : coverImage(item),
        name: clip.title || item.title,
        label: clip.title ? `${item.title} · ${clip.title}` : item.title,
      })));
}

function buildTimeline(sources) {
  const key = `${heroSettings.showExtraTracks}|` + sources.map((s) => `${s.src}#${s.label}`).join('|');
  if (key === timelineKey && heroTimeline.childElementCount) return;
  timelineKey = key;
  reelSources = sources;
  currentReel = -1;
  monitorPlayers.forEach((p) => { delete p.dataset.reel; });

  // V1: one clip per video, widths varied a little so it looks edited
  const weights = sources.map((_, i) => CLIP_WEIGHTS[i % CLIP_WEIGHTS.length]);
  const total = weights.reduce((a, b) => a + b, 0);
  let at = 0;
  const v1 = sources.map((source, i) => {
    const width = (weights[i] / total) * 100;
    const part = [at, width - 0.4, i];
    at += width;
    return part;
  });

  const labels = el('div', 'tl-labels');
  const lanes = el('div', 'tl-lanes');
  timelineClips = [];
  const tracks = heroSettings.showExtraTracks
    ? [['V2', 'video', TIMELINE_DECOR.V2], ['V1', 'video', v1], ['A1', 'audio', TIMELINE_DECOR.A1], ['A2', 'audio', TIMELINE_DECOR.A2]]
    : [['V1', 'video', v1], ['A1', 'audio', TIMELINE_DECOR.A1]];
  tracks.forEach(([name, kind, parts]) => {
      const main = name === 'V1';
      labels.appendChild(el('span', main ? 'is-main' : null, name));
      const lane = el('div', main ? 'tl-lane is-main' : 'tl-lane');
      parts.forEach(([start, width, reel]) => {
        const clip = el('span', `tl-clip tl-${kind}`);
        clip.style.left = `${start}%`;
        clip.style.width = `${width}%`;
        if (reel != null) clip.appendChild(el('span', 'tl-name', sources[reel].name));
        lane.appendChild(clip);
        timelineClips.push({ node: clip, start, end: start + width, reel });
      });
      lanes.appendChild(lane);
    });
  playheadEl = el('div', 'tl-playhead');
  timecodeEl = el('span', 'tl-timecode', '00:00:00:00');
  playheadEl.appendChild(timecodeEl);
  lanes.appendChild(playheadEl);
  heroTimeline.innerHTML = '';
  heroTimeline.append(labels, lanes);
  // Rebuilt (e.g. a setting changed): put the playhead back where it was
  showPlayhead(playheadProgress);
}

// Loads a video into one of the players and seeks to a random point once its length is known
// Jumps to a point (0..1) in the video; if it isn't loaded yet, it jumps there once it is
function seekReel(player, at) {
  if (player.readyState >= 1 && Number.isFinite(player.duration)) player.currentTime = player.duration * at;
  else player.dataset.seek = String(at);
}

// Loads a video into one of the players; it starts at `at` (0..1) or, without one, a random point
function loadReel(player, index, at) {
  const source = reelSources[index];
  player.dataset.reel = String(index);
  player.poster = source.poster || '';
  if (monitorStill) return;
  if (at != null) player.dataset.seek = String(at);
  else delete player.dataset.seek;
  player.src = source.src;
  player.addEventListener('loadedmetadata', () => {
    if (player.dataset.reel !== String(index) || !Number.isFinite(player.duration)) return;
    const fresh = heroSettings.monitorStart === 'start' ? 0 : 0.1 + Math.random() * 0.7;
    const target = player.dataset.seek ? Number(player.dataset.seek) : fresh;
    delete player.dataset.seek;
    player.currentTime = player.duration * target;
  }, { once: true });
}

function cutTo(index, at) {
  currentReel = index;
  monitorTitle.textContent = reelSources[index].label;
  let next = monitorPlayers.find((p) => p.dataset.reel === String(index));
  if (!next) {
    next = monitorPlayers.find((p) => !p.classList.contains('is-on')) || monitorPlayers[0];
    loadReel(next, index, at);
  } else if (at != null && !monitorStill) {
    seekReel(next, at);
  }
  monitorPlayers.forEach((p) => {
    p.classList.toggle('is-on', p === next);
    if (p !== next) p.pause();
  });
  if (!monitorStill && !scrubbing) next.play().catch(() => {});
  // Get the following clip ready in the other player
  const other = monitorPlayers.find((p) => p !== next);
  if (reelSources.length > 1) loadReel(other, (index + 1) % reelSources.length);
}

// progress: 0..1 across the timeline
let playheadProgress = 0;
let scrubbing = false;

function showPlayhead(progress) {
  if (!playheadEl) return;
  playheadProgress = progress;
  const pct = progress * 100;
  playheadEl.style.left = `${pct}%`;
  // Keep the label inside the strip at both ends
  timecodeEl.style.transform = `translateX(${-Math.min(Math.max(pct, 4), 96)}%)`;
  const frames = Math.floor(progress * TIMELINE_SECONDS * TIMELINE_FPS);
  const secs = Math.floor(frames / TIMELINE_FPS);
  const pad = (n) => String(n).padStart(2, '0');
  const tc = `00:${pad(Math.floor(secs / 60))}:${pad(secs % 60)}:${pad(frames % TIMELINE_FPS)}`;
  timecodeEl.textContent = tc;
  monitorTc.textContent = tc;
  let live = null;
  timelineClips.forEach((c) => {
    const on = pct >= c.start && pct < c.end;
    c.node.classList.toggle('is-live', on);
    if (on && c.reel != null) live = c;
  });
  if (!live) return;
  // Where the playhead is inside the clip maps to where the video is (used while scrubbing)
  const within = 0.02 + 0.96 * ((pct - live.start) / (live.end - live.start));
  if (live.reel !== currentReel) cutTo(live.reel, scrubbing ? within : undefined);
  else if (scrubbing && !monitorStill) {
    const on = monitorPlayers.find((p) => p.classList.contains('is-on'));
    if (on) seekReel(on, within);
  }
}

// Scrubbing: drag along the timeline (or click it) to move the playhead, like in an editor.
// The monitor follows; playback carries on from there when you let go.
let timelineStart = performance.now();

function progressAt(clientX) {
  const lanes = heroTimeline.querySelector('.tl-lanes');
  const box = lanes.getBoundingClientRect();
  return Math.min(Math.max((clientX - box.left) / box.width, 0), 0.9999);
}

heroTimeline.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !heroSettings.allowScrub || !heroTimeline.querySelector('.tl-lanes')) return;
  scrubbing = true;
  try { heroTimeline.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  heroTimeline.classList.add('is-scrubbing');
  monitorPlayers.forEach((p) => p.pause());
  showPlayhead(progressAt(e.clientX));
});

heroTimeline.addEventListener('pointermove', (e) => {
  if (scrubbing) showPlayhead(progressAt(e.clientX));
});

const endScrub = () => {
  if (!scrubbing) return;
  scrubbing = false;
  heroTimeline.classList.remove('is-scrubbing');
  timelineStart = performance.now() - playheadProgress * TIMELINE_SECONDS * 1000;
};
heroTimeline.addEventListener('pointerup', endScrub);
heroTimeline.addEventListener('pointercancel', endScrub);

// Shows, hides and sizes the parts of the top section from the settings
function applyHeroLayout() {
  const set = heroSettings;
  const hero = document.querySelector('.hero');
  const inner = hero.querySelector('.hero-inner');
  const text = hero.querySelector('.hero-text');
  const name = hero.querySelector('h1');
  const toggle = (node, on) => { if (node) node.hidden = !on; };

  // Name on one line runs across both columns, so it moves out of the text column
  if (set.nameOneLine && name.parentElement !== inner) inner.insertBefore(name, text);
  if (!set.nameOneLine && name.parentElement !== text) text.insertBefore(name, text.firstChild);
  hero.classList.toggle('hero--one-line', Boolean(set.nameOneLine));

  const filled = (node) => Boolean(node && node.textContent.trim());
  toggle(hero.querySelector('.eyebrow'), set.showRole && filled(hero.querySelector('.eyebrow')));
  toggle(hero.querySelector('.hero-sub'), set.showIntro && filled(hero.querySelector('.hero-sub')));
  toggle(hero.querySelector('.hero-availability'), set.showAvailability && filled(hero.querySelector('.hero-availability')));
  toggle(hero.querySelector('.hero-cta .btn-primary'), set.showWorkButton);
  toggle(hero.querySelector('.hero-cta .btn-ghost'), set.showContactButton);
  toggle(document.getElementById('resume-link'), set.showResume && Boolean(document.getElementById('resume-link').getAttribute('href')));
  toggle(hero.querySelector('.hero-cta'), set.showWorkButton || set.showContactButton || !document.getElementById('resume-link').hidden);

  const style = ['editor', 'portrait', 'centered'].includes(set.style) ? set.style : 'editor';
  hero.dataset.style = style;
  const portraitOn = style === 'portrait' && Boolean(heroPortrait.querySelector('img').getAttribute('src'));
  heroPortrait.hidden = !portraitOn;
  const monitorOn = Boolean(style === 'editor' && set.showMonitor && reelSources.length);
  heroMonitor.hidden = !monitorOn;
  hero.classList.toggle('hero--no-monitor', !monitorOn && !portraitOn);
  heroMonitor.classList.toggle('no-timecode', !set.showTimecode);
  heroMonitor.querySelector('.monitor-rec').textContent = set.monitorLabel || '';
  if (!monitorOn) monitorPlayers.forEach((p) => p.pause());

  toggle(hero.querySelector('.hero-timeline-wrap'), style === 'editor' && set.showTimeline);
  heroTimeline.classList.toggle('tl--no-labels', !set.showTrackLabels);
  heroTimeline.classList.toggle('tl--no-timecode', !set.showTimecode);
  heroTimeline.classList.toggle('tl--no-scrub', !set.allowScrub);

  hero.classList.toggle('hero--no-glow', !set.showGlow);
  hero.style.setProperty('--name-scale', String((Number(set.nameScale) || 100) / 100));
  hero.style.setProperty('--monitor-scale', String((Number(set.monitorSize) || 100) / 100));
  hero.style.setProperty('--portrait-scale', String((Number(set.portraitSize) || 100) / 100));
  hero.style.setProperty('--hero-overlay', String((Number(set.overlay) || 0) / 100));

  // A new loop length keeps the playhead where it is
  const seconds = Math.min(Math.max(Number(set.timelineSeconds) || 36, 6), 300);
  if (seconds !== TIMELINE_SECONDS) {
    timelineStart = performance.now() - playheadProgress * seconds * 1000;
    TIMELINE_SECONDS = seconds;
  }
  TIMELINE_FPS = [24, 25, 30].includes(Number(set.timelineFps)) ? Number(set.timelineFps) : 25;
}

// Parts of the page switched off in the admin panel (content: hidden = { "contact.form": true, ... }).
// Menu links and buttons that point at a removed section go too.
function applyRemovedParts(hidden) {
  const off = hidden || {};
  document.querySelectorAll('[data-part]').forEach((node) => node.classList.toggle('is-removed', Boolean(off[node.dataset.part])));
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    const name = hashName(link.getAttribute('href'));
    const target = name && (document.getElementById(name) || document.getElementById(anchorTargets[name] || ''));
    link.classList.toggle('is-removed', Boolean(target && target.closest('.is-removed')));
  });
}

// ---------- Theme (admin: Theme tab) ----------
// content.theme = { preset, colors: { …overrides }, font, headingFont, radius, customFonts, and the font
// styles: textWeight, boldWeight, textSpacing, textSize, headingWeight, headingBold, headingItalic,
// headingCase ("upper" | "normal"), headingSpacing }. Spacing is in hundredths of an em, size in percent.
// customFonts = [{ name, file, weight, style }]: font files uploaded in the Theme tab (assets/fonts/).
// The colours fill the CSS variables at the top of css/style.css.
const THEME_PRESETS = {
  midnight: { name: 'Midnight blue', mode: 'dark', bg: '#05070a', bgAlt: '#0a0d12', surface: '#10141b', border: '#232a35', text: '#f5f6f8', textDim: '#9aa4b2', accent: '#2f7dfa', accentDark: '#0d2f6b', accent2: '#ff7a33', onAccent: '#ffffff' },
  ember: { name: 'Ember', mode: 'dark', bg: '#0c0907', bgAlt: '#13100c', surface: '#1b1612', border: '#2e2620', text: '#f7f1ea', textDim: '#b3a596', accent: '#ff6b3d', accentDark: '#5a2412', accent2: '#ffc94d', onAccent: '#1a0d05' },
  forest: { name: 'Forest', mode: 'dark', bg: '#070c09', bgAlt: '#0b120e', surface: '#111a15', border: '#213029', text: '#eef5f0', textDim: '#98aa9f', accent: '#3ecf8e', accentDark: '#11402b', accent2: '#f2c14e', onAccent: '#04130b' },
  violet: { name: 'Violet night', mode: 'dark', bg: '#0b0a12', bgAlt: '#100e1a', surface: '#171425', border: '#2a2540', text: '#f3f1fb', textDim: '#a29cbf', accent: '#8b6cff', accentDark: '#2c2160', accent2: '#ff7ac3', onAccent: '#ffffff' },
  rose: { name: 'Rose (light)', mode: 'light', bg: '#fbf7f5', bgAlt: '#f4ece8', surface: '#ffffff', border: '#e6d9d3', text: '#241a1d', textDim: '#6f5f64', accent: '#d6336c', accentDark: '#6e1a38', accent2: '#e8743b', onAccent: '#ffffff', heroBg: '#241a1d' },
  paper: { name: 'Paper (light)', mode: 'light', bg: '#fafaf7', bgAlt: '#f1f0eb', surface: '#ffffff', border: '#deddd5', text: '#1b1b18', textDim: '#66665e', accent: '#2b59ff', accentDark: '#14296e', accent2: '#ff5a36', onAccent: '#ffffff', heroBg: '#15151a' },
};

// Google Fonts that can be picked, with the weights to load ("" = the system font, nothing to load)
const THEME_FONTS = {
  Geologica: 'wght@300..900',
  Inter: 'wght@300..900',
  Manrope: 'wght@300..800',
  'DM Sans': 'wght@300..900',
  Outfit: 'wght@300..900',
  Sora: 'wght@300..800',
  'Plus Jakarta Sans': 'wght@300..800',
  'Space Grotesk': 'wght@300..700',
  'Bricolage Grotesque': 'wght@300..800',
  Syne: 'wght@400..800',
  Unbounded: 'wght@300..900',
  Nunito: 'wght@300..900',
  Poppins: 'wght@300;400;500;600;700;800;900',
  'Playfair Display': 'wght@400..900',
  Fraunces: 'wght@300..900',
  'Cormorant Garamond': 'wght@300..700',
  'Instrument Serif': '',
  'System font': null,
};

// The ones with italic letters of their own (the others are slanted by the browser)
const THEME_ITALICS = ['Inter', 'DM Sans', 'Plus Jakarta Sans', 'Nunito', 'Poppins', 'Playfair Display', 'Fraunces', 'Cormorant Garamond', 'Instrument Serif'];

// What the font styles are when the Theme tab hasn't changed them (as the site looked before they existed)
const FONT_STYLE_DEFAULTS = { textWeight: 400, boldWeight: 700, textSpacing: 0, textSize: 100, headingWeight: 900, headingBold: 900, headingItalic: false, headingCase: 'upper', headingSpacing: 0 };
const ALL_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

// The weights a font comes in: a Google font's from its list, an uploaded one's from its files
// (a file on "All weights" is a variable font), the system font's from Segoe UI
function fontWeights(theme, name) {
  const family = name || 'Geologica';
  const own = ((theme && theme.customFonts) || []).filter((f) => f && f.file && String(f.name).trim() === family.trim());
  if (own.length) {
    if (own.some((f) => !/^\d{3}$/.test(String(f.weight)))) return ALL_WEIGHTS;
    return [...new Set(own.map((f) => Number(f.weight)))].sort((a, b) => a - b);
  }
  const axes = THEME_FONTS[family];
  if (axes === null) return [300, 400, 600, 700, 900];
  if (axes === undefined) return ALL_WEIGHTS;
  const range = /(\d{3})\.\.(\d{3})/.exec(axes);
  if (range) return ALL_WEIGHTS.filter((w) => w >= Number(range[1]) && w <= Number(range[2]));
  const list = (axes.match(/\d{3}/g) || []).map(Number);
  return list.length ? list : [400];
}

const nearestWeight = (weights, wanted) => weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best));

// The font styles as CSS variables. Weights snap to ones the font has, so nothing is drawn fake-bold;
// bold that the font can't make heavier than the text is left to the browser to thicken, so it still shows.
function fontStyleVars(set) {
  const style = { ...FONT_STYLE_DEFAULTS, ...Object.fromEntries(Object.entries(set).filter(([key, value]) => key in FONT_STYLE_DEFAULTS && value != null && value !== '')) };
  const textFont = set.font || 'Geologica';
  const textWeights = fontWeights(set, textFont);
  const headingWeights = fontWeights(set, set.headingFont || textFont);
  const bold = (weights, base, wanted) => {
    const w = nearestWeight(weights, Number(wanted));
    return w > base ? w : Math.max(Number(wanted), base);
  };
  const body = nearestWeight(textWeights, Number(style.textWeight));
  const heading = nearestWeight(headingWeights, Number(style.headingWeight));
  // Smaller headings (experience entries) are one step lighter than the weight picked
  const lighter = nearestWeight(headingWeights, Math.max(Number(style.headingWeight) - 100, 100));
  const em = (v) => `${(Math.min(Math.max(Number(v) || 0, -20), 50) / 100).toFixed(2)}em`;
  return `--body-weight:${body};--bold-weight:${bold(textWeights, body, style.boldWeight)};--text-spacing:${em(style.textSpacing)};`
    + `--text-size:${Math.min(Math.max(Number(style.textSize) || 100, 80), 140) / 100};`
    + `--heading-weight:${heading};--heading-lighter:${lighter};--heading-bold:${bold(headingWeights, heading, style.headingBold)};`
    + `--heading-style:${style.headingItalic ? 'italic' : 'normal'};--heading-case:${style.headingCase === 'normal' ? 'none' : 'uppercase'};--heading-spacing:${em(style.headingSpacing)};`;
}

// The theme's colours, with the admin's overrides on top of the preset. version "other": the second
// version when visitors can switch between dark and light (theme.switchable): colours made from the first
// (see otherVersion), with theme.other's own changes on top.
function themeColors(theme, version) {
  const set = theme || {};
  const preset = THEME_PRESETS[set.preset] || THEME_PRESETS.midnight;
  const own = set.colors || {};
  const colors = { ...preset, ...own };
  // A new accent without its own dark shade: mix one (used for card tiles)
  if (own.accent && !own.accentDark) colors.accentDark = `color-mix(in srgb, ${own.accent} 32%, #000)`;
  colors.heroBg = own.heroBg || preset.heroBg || colors.bg;
  colors.mode = colors.mode === 'light' ? 'light' : 'dark';
  if (version !== 'other') return colors;
  const mode = colors.mode === 'light' ? 'dark' : 'light';
  const changes = Object.fromEntries(Object.entries(set.other || {}).filter(([, value]) => isHexColor(value)));
  const out = { ...otherVersion(colors, mode), ...changes, mode };
  if (changes.accent) out.accentDark = `color-mix(in srgb, ${changes.accent} 32%, #000)`;
  return out;
}

// ---------- Colour maths (for the second version) ----------
// OKLCH: lightness, colourfulness and hue as the eye sees them, so a colour can be made lighter or darker
// without changing its hue
const isHexColor = (value) => /^#[0-9a-f]{6}$/i.test(value || '');
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function hexToOklch(hex) {
  const [r, g, b] = hexRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, c: Math.hypot(a, bb), h: Math.atan2(bb, a) };
}

// Less colourful until it fits what screens can show
function oklchToHex(L, c, h) {
  for (let k = c; ; k *= 0.9) {
    const a = k * Math.cos(h);
    const b = k * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    if (rgb.every((v) => v >= -0.001 && v <= 1.001) || k < 0.001) {
      return `#${rgb.map((v) => Math.round(fromLinear(Math.min(Math.max(v, 0), 1)) * 255).toString(16).padStart(2, '0')).join('')}`;
    }
  }
}

const luminance = (hex) => {
  const [r, g, b] = hexRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (x, y) => {
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
};

// A colour made lighter (on dark) or darker (on light), keeping its hue, until it reads on the background
function readableOn(hex, bg, min) {
  if (!isHexColor(hex) || !isHexColor(bg)) return hex;
  const { L, c, h } = hexToOklch(hex);
  const up = luminance(bg) < 0.2;
  let out = hex;
  for (let step = 1; step <= 50 && contrast(out, bg) < min; step++) out = oklchToHex(Math.min(Math.max(L + (up ? 0.02 : -0.02) * step, 0), 1), c, h);
  return out;
}

// The other version of a set of colours: backgrounds and text in the same tint, the accents kept but made
// readable on the new background. The top section stays as it is (a dark stage in both).
function otherVersion(c, mode) {
  const base = hexToOklch(isHexColor(c.bg) ? c.bg : '#000000');
  const chroma = Math.min(base.c, 0.03);
  const tone = (L, k = 1) => oklchToHex(L, chroma * k, base.h);
  const neutrals = mode === 'light'
    ? { bg: tone(0.975), bgAlt: tone(0.945), surface: tone(0.995, 0.3), border: tone(0.87), text: tone(0.22), textDim: tone(0.48) }
    : { bg: tone(0.14), bgAlt: tone(0.17), surface: tone(0.205), border: tone(0.29), text: tone(0.96, 0.4), textDim: tone(0.72, 0.6) };
  const accent = readableOn(c.accent, neutrals.bg, 3);
  return {
    ...neutrals,
    accent,
    accent2: readableOn(c.accent2, neutrals.bg, 3),
    accentDark: `color-mix(in srgb, ${accent} 32%, #000)`,
    onAccent: isHexColor(accent) && contrast(accent, '#ffffff') < contrast(accent, '#141414') ? '#141414' : '#ffffff',
    heroBg: c.heroBg,
  };
}

// A section's own background colour in the other version, unless one is set: same hue, light or dark
function otherBackground(hex, mode) {
  if (!isHexColor(hex)) return hex;
  const { c, h } = hexToOklch(hex);
  return oklchToHex(mode === 'light' ? 0.93 : 0.25, c * 0.6, h);
}

// Strips characters that could break out of a quoted CSS string
const cssString = (value) => String(value).replace(/["\\<>\n]/g, '');
const fontStack = (name) => (!name || THEME_FONTS[name] === null ? '"Segoe UI", system-ui, sans-serif' : `"${cssString(name)}", "Segoe UI", system-ui, sans-serif`);

// Only fonts from the list come from Google Fonts; uploaded ones are loaded with @font-face
function themeFontsHref(theme) {
  const set = theme || {};
  const families = [...new Set([set.font || 'Geologica', set.headingFont].filter((f) => f && typeof THEME_FONTS[f] === 'string'))];
  if (!families.length) return '';
  return `https://fonts.googleapis.com/css2?${families.map((f) => {
    const axes = THEME_FONTS[f];
    let spec = axes ? `:${axes}` : '';
    // With its italic too (the browser only downloads it where italic is used): "wght@300..900" becomes
    // "ital,wght@0,300..900;1,300..900"
    if (THEME_ITALICS.includes(f)) {
      const weights = axes ? axes.replace(/^wght@/, '').split(';') : [];
      spec = weights.length ? `:ital,wght@${[0, 1].flatMap((i) => weights.map((w) => `${i},${w}`)).join(';')}` : ':ital@0;1';
    }
    return `family=${encodeURIComponent(f).replace(/%20/g, '+')}${spec}`;
  }).join('&')}&display=swap`;
}

const FONT_FORMATS = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };

// @font-face rules for uploaded fonts. `forFile` keeps the real paths (for writing into index.html);
// otherwise unsaved uploads are previewed from their local copies.
function customFontCss(theme, forFile) {
  return ((theme && theme.customFonts) || []).filter((f) => f && f.name && f.file).map((f) => {
    const ext = (/\.([a-z0-9]+)$/i.exec(f.file) || [])[1] || '';
    const format = FONT_FORMATS[ext.toLowerCase()];
    const src = forFile ? f.file : assetUrl(f.file);
    const weight = /^\d{3}$/.test(String(f.weight)) ? f.weight : '100 900';
    return `@font-face{font-family:"${cssString(f.name)}";src:url("${cssString(src)}")${format ? ` format("${format}")` : ''};`
      + `font-weight:${weight};font-style:${f.style === 'italic' ? 'italic' : 'normal'};font-display:swap}`;
  }).join('');
}

// One version's colours as CSS variables
function colourVars(c, heroText) {
  const dark = c.mode !== 'light';
  // The top section is always a dark stage: on a light theme it gets light text of its own,
  // unless the Theme tab sets one
  const hero = dark
    ? { text: c.text, dim: c.textDim, border: c.border }
    : { text: '#f5f6f8', dim: '#a3a9b3', border: '#2c313a' };
  if (heroText) {
    hero.text = heroText;
    hero.dim = `color-mix(in srgb, ${heroText} 62%, transparent)`;
  }
  return `--bg:${c.bg};--bg-alt:${c.bgAlt};--surface:${c.surface};--border:${c.border};--text:${c.text};--text-dim:${c.textDim};`
    + `--accent:${c.accent};--accent-dark:${c.accentDark};--accent-orange:${c.accent2};--on-accent:${c.onAccent};`
    + `--hero-bg:${c.heroBg};--hero-text:${hero.text};--hero-text-dim:${hero.dim};--hero-border:${hero.border};`
    + `color-scheme:${dark ? 'dark' : 'light'};`;
}

// With both versions, the second applies when the page says so (data-mode, set by the ☾/☀ button or a
// remembered choice), or, before that, when the visitor's device prefers it
function themeCss(theme, forFile) {
  const set = theme || {};
  const main = themeColors(set);
  const own = set.colors || {};
  const radius = Math.min(Math.max(Number(set.radius ?? 14), 0), 32);
  let css = `:root{${colourVars(main, own.heroText)}`
    + `--radius:${radius}px;--title-dot:${set.titleDot === false ? 'none' : '"."'};--font-body:${fontStack(set.font || 'Geologica')};--font-heading:${fontStack(set.headingFont || set.font || 'Geologica')};${fontStyleVars(set)}}`;
  if (set.switchable) {
    const other = themeColors(set, 'other');
    const vars = colourVars(other, (set.other || {}).heroText || own.heroText);
    css += `:root[data-mode="${other.mode}"]{${vars}}@media (prefers-color-scheme: ${other.mode}){:root:not([data-mode="${main.mode}"]){${vars}}}`;
  }
  return css + customFontCss(set, forFile);
}

// Browser-tab icon: an uploaded image (site.favicon), else the initials in the accent colour.
// `forFile` keeps the real path (for index.html); otherwise an unsaved upload is previewed.
function faviconHref(site, theme, forFile) {
  if (site.favicon) return forFile ? site.favicon : assetUrl(site.favicon);
  const c = themeColors(theme);
  const initials = (site.initials || plainText(site.name || 'Y N').split(/\s+/).map((w) => w[0]).join('').slice(0, 2)).toUpperCase().slice(0, 3);
  const esc = (v) => String(v).replace(/[<>&"']/g, '');
  const size = initials.length > 2 ? 22 : 28;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='${esc(c.bg)}'/>`
    + `<text x='32' y='42' font-family='Segoe UI, Arial, sans-serif' font-size='${size}' font-weight='700' fill='${esc(c.accent)}' text-anchor='middle'>${esc(initials)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function applyTheme(theme) {
  document.getElementById('theme-vars').textContent = themeCss(theme);
  const fonts = document.getElementById('theme-fonts');
  const href = themeFontsHref(theme);
  if (fonts.getAttribute('href') !== href) fonts.setAttribute('href', href);
  modeSet = { switchable: Boolean(theme && theme.switchable), main: themeColors(theme).mode, look: (theme && theme.modeButton) || 'icon' };
  showModeOnPage();
}

// ---------- Dark and light for visitors ----------
// theme.switchable: the site has both versions. A visitor first sees the one their device prefers; the
// ☾/☀ button in the menu switches, and this browser remembers it. A line at the top of index.html sets a
// remembered choice before the page shows, so it doesn't flash the other version first.
const MODE_KEY = 'site-mode';
const prefersLight = window.matchMedia('(prefers-color-scheme: light)');
// (an index.html from before the button gets a stand-in, so nothing breaks)
const modeButton = document.getElementById('mode-toggle') || document.createElement('button');
let modeSet = { switchable: false, main: 'dark', look: 'icon' };
const MODE_LOOKS = ['icon', 'label', 'switch']; // the button: a sun or moon, the same with a word, or a sliding switch
let previewMode = ''; // the admin panel showing the version being edited
let lookContent = null; // what the sections' backgrounds were last drawn from

function chosenMode() {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    return mode === 'light' || mode === 'dark' ? mode : '';
  } catch {
    return '';
  }
}

function shownMode() {
  if (!modeSet.switchable) return modeSet.main;
  return previewMode || chosenMode() || (prefersLight.matches ? 'light' : 'dark');
}

// The page's data-mode (which version the colours use) and the button
function showModeOnPage() {
  const root = document.documentElement;
  const mode = shownMode();
  if (modeSet.switchable) root.dataset.mode = mode;
  else delete root.dataset.mode;
  modeButton.hidden = !modeSet.switchable;
  modeButton.dataset.mode = mode;
  MODE_LOOKS.forEach((look) => modeButton.classList.toggle(`is-${look}`, look === (MODE_LOOKS.includes(modeSet.look) ? modeSet.look : 'icon')));
  // With a word: the version it switches to
  const word = modeButton.querySelector('.mode-word');
  if (word) word.textContent = t(mode === 'dark' ? 'mode.light' : 'mode.dark');
  const label = t(mode === 'dark' ? 'mode.toLight' : 'mode.toDark');
  modeButton.setAttribute('aria-label', label);
  modeButton.title = label;
}

// Switching: the version's colours, and the sections' own backgrounds follow. `smooth`: the browser
// cross-fades the whole page as one picture (a view transition), so everything fades together, gradients
// and video too, in one step on the graphics card. Fading each colour by itself would start hundreds of
// fades that repaint the page every frame, and gradients can't fade. Browsers without view transitions,
// and visitors who reduce motion, switch at once; so do the panel's previews.
function switchMode(smooth) {
  const apply = () => {
    showModeOnPage();
    if (lookContent) applySectionLook(lookContent);
    matchHeroFade();
  };
  if (!smooth || prefersStill || !document.startViewTransition) {
    apply();
    return;
  }
  const root = document.documentElement;
  root.classList.add('mode-switching');
  const fade = document.startViewTransition(apply);
  // Clicked again before it ended: the new one takes over (the switch itself still happens)
  fade.ready.catch(() => {});
  fade.finished.finally(() => root.classList.remove('mode-switching'));
}

modeButton.addEventListener('click', () => {
  try { localStorage.setItem(MODE_KEY, shownMode() === 'dark' ? 'light' : 'dark'); } catch { /* storage blocked: this visit only */ }
  previewMode = '';
  switchMode(true);
});
prefersLight.addEventListener('change', () => { if (modeSet.switchable && !chosenMode() && !previewMode) switchMode(true); });

// Used by the admin panel (Theme tab, and writing these into index.html on save)
// apply() restyles the page at once without rebuilding it: colours, corners, fonts and the mouse effect
// (the panel uses it while a colour or a Theme slider is dragged)
window.SiteTheme = {
  presets: THEME_PRESETS, fonts: THEME_FONTS, italics: THEME_ITALICS, fontWeights, fontStyle: FONT_STYLE_DEFAULTS, colors: themeColors, css: themeCss, fontsHref: themeFontsHref, favicon: faviconHref,
  apply: (theme) => { applyTheme(theme); applyCursor(theme && theme.cursor); if (lookContent) applySectionLook(lookContent); matchHeroFade(); },
  // The panel shows one version while it's edited ('' = the visitor's own again)
  showMode: (mode) => { previewMode = mode || ''; switchMode(); },
  shownMode: () => shownMode(),
  otherBackground,
};

// ---------- Mouse effect (admin: Theme tab) ----------
// content.theme.cursor = { style, size, color, grow, image, tip, glowSize, glowStrength, glowColor, magnetic, frames }
// style: "off" (normal pointer), "dot", "label" (a dot that says View / Play over projects), "spotlight"
// (normal pointer with a soft glow following it) or "image" (an uploaded picture as the pointer).
// A pointer from a cursor file (.cur, .ani, Xcursor) is saved as a strip of frames side by side, with
// frames = { count, width, height, delays (ms per frame), hotX, hotY (the pixel that points) }, and
// tip "hotspot" to point with that pixel. The frames play here, at their own speed.
// Only for a mouse or trackpad, and not for visitors who reduce motion: they keep the normal pointer.
const CURSOR_DEFAULTS = {
  style: 'dot', size: 14, color: 'invert', grow: true, image: '', tip: 'center',
  glowSize: 320, glowStrength: 18, glowColor: 'accent', magnetic: false,
};
window.CURSOR_DEFAULTS = CURSOR_DEFAULTS;
const cursorAllowed = window.matchMedia('(hover: hover) and (pointer: fine)').matches
  && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const CURSOR_HOVER = 'a, button, .work-card, .featured-slide, input, textarea, select, .hero-timeline';
const MAGNETIC = '.btn, .featured-arrow, .contact-socials a, .filter-btn, .modal-arrow';
let cursorSet = { ...CURSOR_DEFAULTS };
let cursorEl = null;
let cursorLabel = null;
let glowEl = null;
let magnetTarget = null;
let cursorTimer = 0;

// Dot, label and picture are drawn by the page (the real pointer is hidden); with a picture style
// but no picture yet, it's a dot
const drawsPointer = () => ['dot', 'label', 'image'].includes(cursorSet.style);
const isFullscreen = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);

function releaseMagnet() {
  if (!magnetTarget) return;
  magnetTarget.style.translate = '';
  magnetTarget = null;
}

// Magnetic buttons: the button under the mouse drifts a little toward it
function pullMagnet(e) {
  const target = e.target.closest ? e.target.closest(MAGNETIC) : null;
  if (target !== magnetTarget) releaseMagnet();
  if (!target) return;
  magnetTarget = target;
  const box = target.getBoundingClientRect();
  const dx = (e.clientX - (box.left + box.width / 2)) * 0.25;
  const dy = (e.clientY - (box.top + box.height / 2)) * 0.3;
  target.style.translate = `${Math.max(Math.min(dx, 10), -10)}px ${Math.max(Math.min(dy, 8), -8)}px`;
}

function onCursorMove(e) {
  if (cursorSet.style === 'spotlight') {
    glowEl.style.setProperty('--x', `${e.clientX}px`);
    glowEl.style.setProperty('--y', `${e.clientY}px`);
    glowEl.classList.remove('is-hidden');
  }
  if (drawsPointer()) {
    // `translate` (not `transform`), so growing with `scale` doesn't also move it
    cursorEl.style.translate = `${e.clientX}px ${e.clientY}px`;
    cursorEl.classList.remove('is-hidden');
    const closest = (selector) => (e.target.closest ? e.target.closest(selector) : null);
    const project = cursorSet.style === 'label' ? closest('.work-card, .featured-slide') : null;
    if (project) {
      const item = workItems[Number(project.dataset.index)];
      cursorLabel.textContent = t(item && projectVideos(item).length ? 'cursor.play' : 'cursor.view');
    }
    cursorEl.classList.toggle('is-label', Boolean(project));
    cursorEl.classList.toggle('is-hover', !project && Boolean(cursorSet.grow) && Boolean(closest(CURSOR_HOVER)));
  }
  if (cursorSet.magnetic) pullMagnet(e);
}

function setupCursor() {
  if (cursorEl) return;
  cursorEl = el('div', 'cursor is-hidden');
  cursorEl.setAttribute('aria-hidden', 'true');
  cursorLabel = el('span', 'cursor-label');
  cursorEl.appendChild(cursorLabel);
  glowEl = el('div', 'cursor-glow is-hidden');
  glowEl.setAttribute('aria-hidden', 'true');
  document.body.append(glowEl, cursorEl);
  document.addEventListener('mousemove', onCursorMove);
  // Hide it when the mouse leaves the window or moves over an embedded video, which shows its own pointer
  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget && e.relatedTarget.tagName !== 'IFRAME') return;
    cursorEl.classList.add('is-hidden');
    glowEl.classList.add('is-hidden');
    releaseMagnet();
  });
  // A fullscreen video sits in the browser's top layer, above anything the page draws, so the drawn
  // pointer can't show there: hand the pointer back to the browser and restore it on exit
  const onFullscreenChange = () => {
    document.documentElement.classList.toggle('has-cursor', drawsPointer() && !isFullscreen());
    cursorEl.classList.add('is-hidden');
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
}

function applyCursor(settings) {
  cursorSet = { ...CURSOR_DEFAULTS, ...(settings || {}) };
  if (!['off', 'dot', 'label', 'spotlight', 'image'].includes(cursorSet.style)) cursorSet.style = 'dot';
  const root = document.documentElement;
  if (!cursorAllowed) {
    root.classList.remove('has-cursor', 'has-magnet');
    return;
  }
  setupCursor();
  const picture = cursorSet.style === 'image' && cursorSet.image ? assetUrl(cursorSet.image) : '';
  const shape = cursorSet.style === 'image' && !picture ? 'dot' : cursorSet.style;
  root.classList.toggle('has-cursor', drawsPointer() && !isFullscreen());
  root.classList.toggle('has-magnet', Boolean(cursorSet.magnetic));
  if (!cursorSet.magnetic) releaseMagnet();
  cursorEl.hidden = !drawsPointer();
  glowEl.hidden = cursorSet.style !== 'spotlight';
  cursorEl.dataset.style = shape;
  cursorEl.dataset.color = cursorSet.color;
  cursorEl.dataset.tip = cursorSet.tip;
  const size = Math.min(Math.max(Number(cursorSet.size) || 14, 6), shape === 'image' ? 128 : 40);
  cursorEl.style.setProperty('--cursor-size', `${size}px`);
  cursorEl.style.backgroundImage = picture ? `url("${cssString(picture)}")` : '';
  playCursorFrames(shape === 'image' ? cursorSet.frames : null);
  if (cursorSet.style !== 'label') cursorEl.classList.remove('is-label');
  glowEl.style.setProperty('--glow-size', `${Math.min(Math.max(Number(cursorSet.glowSize) || 320, 100), 800)}px`);
  glowEl.style.setProperty('--glow-strength', `${Math.min(Math.max(Number(cursorSet.glowStrength) || 18, 2), 60)}%`);
  glowEl.style.setProperty('--glow-color', cursorSet.glowColor === 'accent2' ? 'var(--accent-orange)' : 'var(--accent)');
}

// A pointer made of frames: its shape, the pixel that points, and the frames one after another
function playCursorFrames(frames) {
  clearTimeout(cursorTimer);
  const ok = frames && frames.width > 0 && frames.height > 0;
  const count = ok ? Math.min(Math.max(Math.round(Number(frames.count)) || 1, 1), 400) : 1;
  const hot = ok && Number.isFinite(frames.hotX) && Number.isFinite(frames.hotY);
  cursorEl.classList.toggle('is-sprite', ok);
  cursorEl.style.setProperty('--frames', String(count));
  cursorEl.style.setProperty('--cursor-ratio', String(ok ? frames.height / frames.width : 1));
  cursorEl.style.setProperty('--hot-x', String(hot ? frames.hotX / frames.width : 0.5));
  cursorEl.style.setProperty('--hot-y', String(hot ? frames.hotY / frames.height : 0.5));
  if (cursorEl.dataset.tip === 'hotspot' && !hot) cursorEl.dataset.tip = 'center';
  cursorEl.style.setProperty('--frame', '0');
  if (count < 2) return;
  const delays = Array.isArray(frames.delays) ? frames.delays : [];
  let frame = 0;
  const next = () => {
    cursorEl.style.setProperty('--frame', String(frame));
    const wait = Math.min(Math.max(Number(delays[frame]) || 100, 16), 10000);
    frame = (frame + 1) % count;
    cursorTimer = setTimeout(next, wait);
  };
  next();
}

// ---------- Your name and site details (admin: Site tab) ----------
function renderIdentity(site, theme) {
  // The name may have formatting for the big heading; everywhere else it's the words alone
  const name = (site.name || '').trim() || 'Your Name';
  siteName = plainText(name);
  const words = siteName.split(/\s+/);
  firstName = (site.shortName || '').trim() || words[0];
  const heading = document.querySelector('[data-site="name"]');
  if (heading.dataset.raw !== name) setRevealText(heading, name);
  field(heading, 'site.name');
  // Logo: first word plain, the rest in the accent colour
  const logo = document.querySelector('[data-site="logo"]');
  logo.textContent = words[0];
  if (words.length > 1) logo.appendChild(el('span', null, words.slice(1).join(' ')));
  document.querySelector('[data-site="footer"]').textContent = siteName;
  document.title = (site.title || '').trim() || `${siteName} Portfolio`;
  document.getElementById('favicon').href = faviconHref(site, theme);
}

// ---------- Sections: order, titles, menu and look (admin: Page tab) ----------
// content.sections = {
//   order: [ids], removed: [ids of built-in sections taken off the page],
//   <id>: { title, nav, inMenu, background ("main" | "alt" | "custom"), bgColor, bgImage, bgDarken (%),
//           titleStyle ("large" | "small"), titleSize (%), width ("narrow" | "normal" | "wide" | "full"),
//           spacing ("compact" | "normal" | "roomy"), device ("all" | "desktop" | "phone"),
//           anchor (the name in its link, e.g. "services" for #services), categories },
// }
// Sections: the built-in ones below, extra Work grids (content.workGrids) and added sections
// (content.customSections: Text, Gallery, Video and the other types in SECTION_TYPES).
const BUILTIN_SECTIONS = ['about', 'reel', 'work', 'experience', 'toolkit', 'contact'];
const SECTION_TYPES = ['text', 'gallery', 'video', 'quotes', 'logos', 'numbers', 'faq', 'cta'];
// What a section looks like when its settings don't say (Experience and Toolkit sit under Work with small titles)
const SECTION_LOOK = {
  about: { background: 'alt', titleStyle: 'large', inMenu: true },
  reel: { background: 'main', titleStyle: 'large', inMenu: true },
  work: { background: 'alt', titleStyle: 'large', inMenu: true },
  experience: { background: 'alt', titleStyle: 'small', inMenu: false },
  toolkit: { background: 'alt', titleStyle: 'small', inMenu: false },
  contact: { background: 'main', titleStyle: 'large', inMenu: true },
  grid: { background: 'alt', titleStyle: 'large', inMenu: true },
  text: { background: 'main', titleStyle: 'large', inMenu: true },
  gallery: { background: 'alt', titleStyle: 'large', inMenu: true },
  video: { background: 'main', titleStyle: 'large', inMenu: true },
  quotes: { background: 'alt', titleStyle: 'small', inMenu: false },
  logos: { background: 'main', titleStyle: 'small', inMenu: false },
  numbers: { background: 'main', titleStyle: 'small', inMenu: false },
  faq: { background: 'alt', titleStyle: 'large', inMenu: true },
  cta: { background: 'alt', titleStyle: 'small', inMenu: false },
};
const SECTION_CHOICES = {
  width: ['normal', 'narrow', 'wide', 'full'],
  spacing: ['normal', 'compact', 'roomy'],
  device: ['all', 'desktop', 'phone'],
};
// Layouts a section can switch between (content.sections.<id>.layout; the first is the standard one).
// A Text section's picture place is its own setting (imagePlace: below, above, side = right, side-left).
const SECTION_LAYOUTS = {
  about: ['photo-right', 'photo-left', 'photo-above'],
  reel: ['stacked', 'side'],
  video: ['stacked', 'side'],
  contact: ['stacked', 'side'],
  work: ['auto', 'cols-2', 'cols-3', 'cols-4'],
  grid: ['auto', 'cols-2', 'cols-3', 'cols-4'],
  quotes: ['cards', 'large'],
};
window.SECTION_LAYOUTS = SECTION_LAYOUTS;
// content.sections.<name>.title / .nav replace these interface texts (empty keeps the default)
const SECTION_TEXT = {
  about: { title: 'about.title', nav: 'nav.about' },
  reel: { title: 'reel.title', nav: 'nav.reel' },
  work: { title: 'work.title', nav: 'nav.work' },
  contact: { title: 'contact.title', nav: 'nav.contact' },
  highlights: { title: 'work.highlights' },
  experience: { title: 'experience.title' },
  toolkit: { title: 'toolkit.title' },
};

function sectionKind(content, id) {
  if (id === 'hero') return 'hero';
  if (BUILTIN_SECTIONS.includes(id)) return id;
  if ((content.workGrids || []).some((g) => g.id === id)) return 'grid';
  const added = (content.customSections || []).find((s) => s.id === id);
  return added && SECTION_TYPES.includes(added.type) ? added.type : 'text';
}

// A section's settings with the defaults for its kind filled in
function sectionSettings(content, id) {
  const kind = sectionKind(content, id);
  const look = SECTION_LOOK[kind] || SECTION_LOOK.text;
  const own = (content.sections || {})[id] || {};
  const pick = (key) => (SECTION_CHOICES[key].includes(own[key]) ? own[key] : SECTION_CHOICES[key][0]);
  return {
    ...own,
    kind,
    background: ['main', 'alt', 'custom'].includes(own.background) ? own.background : look.background,
    titleStyle: own.titleStyle === 'large' || own.titleStyle === 'small' ? own.titleStyle : look.titleStyle,
    titleSize: Math.min(Math.max(Number(own.titleSize) || 100, 40), 200),
    inMenu: typeof own.inMenu === 'boolean' ? own.inMenu : look.inMenu,
    width: pick('width'),
    spacing: pick('spacing'),
    device: pick('device'),
    bgDarken: Math.min(Math.max(Number.isFinite(Number(own.bgDarken)) ? Number(own.bgDarken) : 50, 0), 90),
    layout: SECTION_LAYOUTS[kind] ? (SECTION_LAYOUTS[kind].includes(own.layout) ? own.layout : SECTION_LAYOUTS[kind][0]) : '',
  };
}

// Custom link names (content.sections.<id>.anchor) -> section id. A name that's taken (by another
// section, or anything else on the page) is ignored, and the section keeps its own id as its link.
let anchorTargets = {};

// "#services" -> "services" (a malformed address stays as it is)
function hashName(hash) {
  const name = String(hash || '').replace(/^#/, '');
  try { return decodeURIComponent(name); } catch { return name; }
}

function sectionLink(content, id) {
  const own = String(sectionSettings(content, id).anchor || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(own) || own === id || document.getElementById(own) || (anchorTargets[own] && anchorTargets[own] !== id)) return id;
  anchorTargets[own] = id;
  return own;
}

// A link to a custom name scrolls to its section (the browser can't: no element has that id)
function scrollToAnchor(name, smooth) {
  const section = anchorTargets[name] && document.getElementById(anchorTargets[name]);
  if (!section) return false;
  section.scrollIntoView({ behavior: smooth ? 'auto' : 'instant', block: 'start' });
  return true;
}

document.addEventListener('click', (e) => {
  const link = e.target.closest && e.target.closest('a[href^="#"]');
  const name = link && hashName(link.getAttribute('href'));
  if (!name || !scrollToAnchor(name, true)) return;
  e.preventDefault();
  history.pushState(null, '', `#${name}`);
});
window.addEventListener('hashchange', () => scrollToAnchor(hashName(window.location.hash), true));

// Sections on the page, top to bottom. Built-in sections that aren't in the saved order (and weren't
// removed) are added where they belong, so content saved before they existed still shows them.
// pageId: '' for the home page (content.sections.order, which also holds the top section, "hero"), else
// the id of one of content.pages, whose sections are in its own order. A section is on one page only.
// Leave it out for the page being shown.
function sectionOrder(content, pageId = currentPageId) {
  const sections = content.sections || {};
  const ids = [...BUILTIN_SECTIONS, ...(content.workGrids || []).map((g) => g.id), ...(content.customSections || []).map((s) => s.id)];
  const removed = Array.isArray(sections.removed) ? sections.removed : [];
  const pages = pagesOf(content);
  if (pageId) {
    const page = pages.find((pg) => pg.id === pageId);
    return page ? [...new Set(page.order.filter((id) => ids.includes(id) && !removed.includes(id)))] : [];
  }
  const elsewhere = new Set(pages.flatMap((pg) => pg.order));
  const order = [...new Set((Array.isArray(sections.order) ? sections.order : []).filter((id) => (id === 'hero' || ids.includes(id)) && !removed.includes(id) && !elsewhere.has(id)))];
  // The top section comes first unless it has been moved
  if (!order.includes('hero')) order.unshift('hero');
  ids.forEach((id) => {
    if (elsewhere.has(id)) return;
    if (order.includes(id) || removed.includes(id)) return;
    const after = { experience: 'work', toolkit: 'experience' }[id];
    if (after && order.includes(after)) order.splice(order.indexOf(after) + 1, 0, id);
    else if (id !== 'contact' && order.includes('contact')) order.splice(order.indexOf('contact'), 0, id);
    else order.push(id);
  });
  return order;
}

// ---------- Pages ----------
// content.pages = [{ id, slug, title, nav, inMenu, order: [section ids] }]: pages besides the home page,
// each with its own sections. A page's address is ?page=<slug> (the same index.html); links between pages
// switch without reloading, and the browser's back button goes back.
let currentPageId = ''; // '' = the home page

function pagesOf(content) {
  return (Array.isArray(content.pages) ? content.pages : [])
    .filter((pg) => pg && /^[\w-]+$/.test(pg.id || '') && /^[a-z0-9-]+$/.test(pg.slug || ''))
    .map((pg) => ({ ...pg, order: Array.isArray(pg.order) ? pg.order : [] }));
}

const homeHref = () => window.location.pathname;
const pageHref = (page) => (page ? `${homeHref()}?page=${encodeURIComponent(page.slug)}` : homeHref());

function pageFromUrl(content) {
  const slug = new URLSearchParams(window.location.search).get('page');
  const page = slug && pagesOf(content).find((pg) => pg.slug === slug);
  return page ? page.id : '';
}

// Shows another page (or the home page, ''): the address changes, the page is drawn again
function showPage(pageId, { push = true, hash = '' } = {}) {
  const page = pagesOf(currentContent).find((pg) => pg.id === pageId) || null;
  if (!modal.hidden) hideModal();
  currentPageId = page ? page.id : '';
  if (push) history.pushState(null, '', pageHref(page) + (hash ? `#${hash}` : ''));
  renderSite(currentContent);
  if (hash && (scrollToAnchor(hash, false) || document.getElementById(hash))) {
    if (document.getElementById(hash)) document.getElementById(hash).scrollIntoView({ behavior: 'instant', block: 'start' });
  } else {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  document.dispatchEvent(new CustomEvent('site:pagechange', { detail: { pageId: currentPageId } }));
}

// Links to a page of this site (?page=…, or the home page with a #section) switch without reloading
document.addEventListener('click', (e) => {
  const link = e.target.closest && e.target.closest('a[data-page]');
  if (!link || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || e.button > 0) return;
  e.preventDefault();
  showPage(link.dataset.page, { hash: link.dataset.hash || '' });
});
window.addEventListener('popstate', () => {
  const pageId = pageFromUrl(currentContent);
  if (pageId !== currentPageId) showPage(pageId, { push: false, hash: hashName(window.location.hash) });
  const project = projectFromUrl();
  if (project >= 0 && project !== openProjectIndex) openProject(project, { push: false });
  else if (project < 0 && openProjectIndex !== null) hideModal();
});

window.SitePages = {
  list: pagesOf,
  current: () => currentPageId,
  show: (pageId) => showPage(pageId),
  href: (pageId) => pageHref(pagesOf(currentContent).find((pg) => pg.id === pageId) || null),
};

// The menu label: its own label, else the standard one, else its title
function sectionNavText(content, id) {
  const set = sectionSettings(content, id);
  if (set.nav && set.nav.trim()) return plainText(set.nav.trim());
  if (SECTION_TEXT[id] && SECTION_TEXT[id].nav) return plainText(t(SECTION_TEXT[id].nav));
  if (SECTION_TEXT[id]) return plainText(t(SECTION_TEXT[id].title));
  if (id === 'hero') return '';
  return plainText((set.title || '').trim()) || (set.kind === 'grid' ? t('work.title') : '');
}

// Used by the admin panel's Page tab
window.SiteSections = { builtin: BUILTIN_SECTIONS, order: sectionOrder, settings: sectionSettings, kind: sectionKind, look: SECTION_LOOK };

let revealReady = false;

// Sets a section heading's text, keeping it when unchanged so its letters don't animate again
function setSectionTitle(heading, text) {
  if (heading.dataset.raw === text) return;
  setRevealText(heading, text);
  if (revealReady) heading.classList.add('is-in');
}

// ---------- Added sections ----------
// content.customSections = [{ id, type, intro, align ("left" | "center"), ... }]; the title, menu label and
// look are in content.sections.<id> like every other section. What each type holds:
//   text:    text, columns (1 | 2), image, imageAlt, imagePlace ("below" | "side"), buttons
//   gallery: images [{ src, alt, caption }], columns (2-5), shape ("square" | "wide" | "natural")
//   video:   youtube (an id), or video (a file or link) with thumb (its cover picture); caption
//   quotes:  items [{ quote, name, role, photo }]
//   logos:   items [{ src, alt, url }], style ("color" | "grey" | "white" | "black")
//   numbers: items [{ value, label }]
//   faq:     items [{ q, a }]
//   cta:     text (one big line), sub, buttons
// buttons = [{ label, url, style ("primary" | "ghost") }]. Text sections from before had one "button".

// Simple formatting in text typed in the admin panel: **bold**, *italic*, [label](link), letter spacing
// as [[tight:words]], [[wide:words]] or [[wider:words]] (these can go inside each other), and blocks whose
// lines all start with "- " become a list. Paragraphs are separated by an empty line. Built as elements,
// never as HTML, so nothing typed can run as code.
const SPACING_MARKS = ['tight', 'wide', 'wider'];

// The text as a tree: strings, and { type: 'strong' | 'em' | 'space' | 'link', name, url, children }.
// A * opens before a letter and closes after one (so "5 * 3" stays as typed); marks left open are text.
function parseInline(text) {
  const root = { children: [] };
  const stack = [root];
  let buf = '';
  const top = () => stack[stack.length - 1];
  const flush = () => { if (buf) top().children.push(buf); buf = ''; };
  const open = (node) => { flush(); top().children.push(node); stack.push(node); };
  // An opener that never closed goes back to being the text it was
  const unwrap = () => {
    const node = stack.pop();
    const parent = top();
    parent.children.splice(parent.children.indexOf(node), 1, node.raw, ...node.children);
  };
  const close = (type) => {
    flush();
    while (top().type !== type) unwrap();
    stack.pop();
  };
  const isOpen = (type) => stack.some((n) => n.type === type);
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const before = text[i - 1] || ' ';
    let m;
    if ((m = /^\[\[(tight|wide|wider):/.exec(rest))) {
      open({ type: 'space', name: m[1], raw: m[0], children: [] });
      i += m[0].length;
    } else if (rest.startsWith(']]') && isOpen('space')) {
      close('space');
      i += 2;
    } else if ((m = /^\[([^\][]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      top().children.push({ type: 'link', url: m[2], children: parseInline(m[1]) });
      i += m[0].length;
    } else if (rest[0] === '*') {
      const double = rest.startsWith('**');
      const canClose = !/\s/.test(before);
      const canOpen = /\S/.test(rest[double ? 2 : 1] || ' ') && !/^\*+$/.test(rest.slice(0, 4));
      if (top().type === 'em' && canClose) { close('em'); i += 1; }
      else if (double && isOpen('strong') && canClose) { close('strong'); i += 2; }
      else if (!double && isOpen('em') && canClose) { close('em'); i += 1; }
      else if (double && canOpen) { open({ type: 'strong', raw: '**', children: [] }); i += 2; }
      else if (canOpen) { open({ type: 'em', raw: '*', children: [] }); i += 1; }
      else { buf += rest[0]; i += 1; }
    } else {
      buf += rest[0];
      i += 1;
    }
  }
  flush();
  while (stack.length > 1) unwrap();
  return root.children;
}

// The element for one mark (a link to an address that isn't allowed is just its words)
function inlineTag(node) {
  if (node.type === 'space') return el('span', `ls-${node.name}`);
  if (node.type !== 'link') return el(node.type);
  const url = safeUrl(node.url);
  if (!url) return el('span');
  const link = el('a', 'text-link');
  link.href = url;
  if (/^https?:/i.test(url)) { link.target = '_blank'; link.rel = 'noopener'; }
  return link;
}

function inlineNodes(parent, nodes) {
  nodes.forEach((node) => {
    if (typeof node === 'string') { if (node) parent.appendChild(document.createTextNode(node)); return; }
    parent.appendChild(inlineNodes(inlineTag(node), node.children));
  });
  return parent;
}

function inlineText(parent, text) {
  return inlineNodes(parent, parseInline(String(text || '')));
}

// The words without the marks: for the menu, the browser tab, link previews and screen readers
function plainText(text) {
  const flat = (nodes) => nodes.map((node) => (typeof node === 'string' ? node : flat(node.children))).join('');
  return flat(parseInline(String(text || '')));
}

// A one-line text with formatting, tagged so the admin panel edits it as such
function formatted(node, text) {
  node.dataset.inline = '';
  return inlineText(node, text);
}

// Used by the admin panel: the formatting marks (see parseInline)
window.SiteText = { parse: parseInline, inline: inlineText, plain: plainText, spacing: SPACING_MARKS };

// path: where the text is in the content, so the admin panel can edit it on the page (as typed, with the **)
function richText(text, className, path) {
  const box = el('div', className ? `rich-text ${className}` : 'rich-text');
  if (path) {
    field(box, path);
    box.dataset.rich = '';
    box.classList.toggle('is-empty', !String(text || '').trim());
  }
  String(text || '').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).forEach((block) => {
    const lines = block.split('\n');
    if (lines.every((line) => /^\s*[-•]\s+/.test(line))) {
      const list = el('ul');
      lines.forEach((line) => list.appendChild(inlineText(el('li'), line.replace(/^\s*[-•]\s+/, ''))));
      box.appendChild(list);
    } else {
      box.appendChild(inlineText(el('p'), block));
    }
  });
  return box;
}

function sectionButtons(sec) {
  const list = Array.isArray(sec.buttons) ? sec.buttons : sec.button ? [sec.button] : [];
  const row = el('div', 'custom-buttons');
  list.forEach((button, n) => {
    const label = button && (button.label || '').trim();
    const url = button && safeUrl((button.url || '').trim());
    if (!label || !url) return;
    const style = button.style === 'ghost' || (!button.style && n > 0) ? 'btn-ghost' : 'btn-primary';
    const link = el('a', `btn ${style}`, label);
    link.href = url;
    if (/^https?:/i.test(url)) { link.target = '_blank'; link.rel = 'noopener'; }
    row.appendChild(link);
  });
  return row.children.length ? row : null;
}

function picture(src, alt, className) {
  const img = el('img', className);
  img.src = assetUrl(src);
  img.alt = alt || '';
  img.loading = 'lazy';
  return img;
}

// What goes under a section's title, per type. path: the section's place in the content, for editing on the page.
const SECTION_BODIES = {
  text(sec, path) {
    return [richText(sec.text, Number(sec.columns) === 2 ? 'is-two-columns' : '', `${path}.text`), sectionButtons(sec)];
  },

  gallery(sec, path, title) {
    const images = (sec.images || []).filter((img) => img && img.src);
    const grid = el('div', `gallery-grid shape-${['wide', 'natural'].includes(sec.shape) ? sec.shape : 'square'}`);
    grid.dataset.entries = `${path}.images`;
    grid.style.setProperty('--cols', String(Math.min(Math.max(Number(sec.columns) || 3, 2), 5)));
    images.forEach((img, n) => {
      const figure = el('figure', 'gallery-item');
      figure.dataset.entry = `${path}.images.${sec.images.indexOf(img)}`;
      const open = el('button', 'gallery-open');
      open.type = 'button';
      open.setAttribute('aria-label', img.alt || img.caption || t('work.pictureN').replace('{n}', n + 1));
      open.appendChild(picture(img.src, img.alt));
      open.addEventListener('click', () => { if (!open.closest('.adm-active')) openPictures(images, n, title, open); });
      figure.appendChild(open);
      const index = sec.images.indexOf(img);
      if (img.caption) figure.appendChild(field(el('figcaption', null, img.caption), `${path}.images.${index}.caption`));
      grid.appendChild(figure);
    });
    return [images.length ? grid : null];
  },

  video(sec, path, title) {
    const frame = el('div', 'reel-frame');
    const file = sec.video && safeUrl(sec.video) ? assetUrl(sec.video) : '';
    if (sec.youtube) {
      const iframe = youtubeEmbed(sec.youtube, title || t('reel.title'), false);
      iframe.loading = 'lazy';
      frame.appendChild(iframe);
    } else if (file) {
      const video = document.createElement('video');
      video.src = file;
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      if (sec.thumb) video.poster = assetUrl(sec.thumb);
      frame.appendChild(video);
    } else {
      frame.innerHTML = reelPlaceholder;
      applyUiText(frame);
    }
    return [frame, sec.caption ? field(formatted(el('p', 'video-caption'), sec.caption), `${path}.caption`) : null];
  },

  quotes(sec, path) {
    const grid = el('div', 'quote-grid');
    grid.dataset.entries = `${path}.items`;
    (sec.items || []).forEach((item, n) => {
      if (!item || !(item.quote || '').trim()) return;
      const card = el('figure', 'quote-card');
      card.dataset.entry = `${path}.items.${n}`;
      const quote = el('blockquote');
      quote.appendChild(richText(item.quote, '', `${path}.items.${n}.quote`));
      const who = el('figcaption', 'quote-person');
      if (item.photo) who.appendChild(picture(item.photo, '', 'quote-photo'));
      const names = el('span', 'quote-names');
      if (item.name || isEditing()) names.appendChild(blankable(el('strong', null, item.name), `${path}.items.${n}.name`, 'Name'));
      if (item.role || isEditing()) names.appendChild(blankable(el('span', null, item.role), `${path}.items.${n}.role`, 'Role or company'));
      who.appendChild(names);
      card.append(quote, who);
      grid.appendChild(card);
    });
    return [grid.children.length ? grid : null];
  },

  logos(sec, path) {
    const style = ['color', 'white', 'black'].includes(sec.style) ? sec.style : 'grey';
    const row = el('div', `logo-row logos-${style}`);
    row.dataset.entries = `${path}.items`;
    (sec.items || []).forEach((item, n) => {
      if (!item || !item.src) return;
      const url = item.url && safeUrl(item.url.trim());
      const wrap = url ? el('a', 'logo-item') : el('span', 'logo-item');
      wrap.dataset.entry = `${path}.items.${n}`;
      if (url) { wrap.href = url; wrap.target = '_blank'; wrap.rel = 'noopener'; }
      wrap.appendChild(picture(item.src, item.alt));
      row.appendChild(wrap);
    });
    return [row.children.length ? row : null];
  },

  numbers(sec, path) {
    const grid = el('div', 'number-grid');
    grid.dataset.entries = `${path}.items`;
    (sec.items || []).forEach((item, n) => {
      if (!item || !((item.value || '').trim() || (item.label || '').trim())) return;
      const box = el('div', 'number-item');
      box.dataset.entry = `${path}.items.${n}`;
      box.append(field(el('strong', 'number-value', item.value), `${path}.items.${n}.value`),
        field(formatted(el('span', 'number-label'), item.label), `${path}.items.${n}.label`));
      grid.appendChild(box);
    });
    return [grid.children.length ? grid : null];
  },

  faq(sec, path) {
    const list = el('div', 'faq-list');
    Object.assign(list.dataset, { entries: `${path}.items`, axis: 'y' });
    (sec.items || []).forEach((item, n) => {
      if (!item || !(item.q || '').trim()) return;
      const entry = el('details', 'faq-item');
      entry.dataset.entry = `${path}.items.${n}`;
      // Open while editing, so the answer can be typed in
      entry.open = isEditing();
      const question = el('summary');
      question.appendChild(field(formatted(el('span'), item.q), `${path}.items.${n}.q`));
      entry.append(question, richText(item.a, 'faq-answer', `${path}.items.${n}.a`));
      list.appendChild(entry);
    });
    return [list.children.length ? list : null];
  },

  cta(sec, path) {
    return [
      sec.text ? field(formatted(el('p', 'cta-line'), sec.text), `${path}.text`) : null,
      sec.sub ? field(formatted(el('p', 'cta-sub'), sec.sub), `${path}.sub`) : null,
      sectionButtons(sec),
    ];
  },
};

// What a part of an added section is called (content.sections.<id>.blockOrder / blockLook use these names)
const BLOCK_CLASSES = [['section-title', 'title'], ['section-sub', 'intro'], ['rich-text', 'text'], ['custom-buttons', 'buttons'],
  ['custom-text', 'heading'], ['gallery-grid', 'gallery'], ['reel-frame', 'video'], ['video-caption', 'caption'], ['quote-grid', 'quotes'],
  ['logo-row', 'logos'], ['number-grid', 'numbers'], ['faq-list', 'faq'], ['cta-line', 'line'], ['cta-sub', 'sub']];
const blockName = (node) => (BLOCK_CLASSES.find(([cls]) => node.classList.contains(cls)) || [null, 'part'])[1];

function renderCustomSections(content) {
  const list = Array.isArray(content.customSections) ? content.customSections : [];
  const main = document.getElementById('top');
  const ids = list.map((s) => s.id);
  main.querySelectorAll(':scope > section.custom-section').forEach((node) => { if (!ids.includes(node.id)) node.remove(); });

  list.forEach((sec, i) => {
    if (!/^[\w-]+$/.test(sec.id || '')) return;
    let node = document.getElementById(sec.id);
    if (!node) {
      node = el('section', 'custom-section');
      node.id = sec.id;
      main.appendChild(node);
    }
    const type = SECTION_TYPES.includes(sec.type) ? sec.type : 'text';
    const path = `customSections.${i}`;
    SECTION_TYPES.forEach((name) => node.classList.toggle(`type-${name}`, name === type));
    const image = type === 'text' && sec.image ? assetUrl(sec.image) : '';
    const place = ['side', 'side-left', 'above'].includes(sec.imagePlace) ? sec.imagePlace : 'below';
    node.classList.toggle('has-side-image', Boolean(image && place.startsWith('side')));
    node.classList.toggle('image-left', Boolean(image && place === 'side-left'));
    node.classList.toggle('image-above', Boolean(image && place === 'above'));
    node.classList.toggle('is-centered', (sec.align || (type === 'cta' ? 'center' : 'left')) === 'center');
    node.dataset.part = sec.id;
    node.dataset.editItem = path;

    const title = (sectionSettings(content, sec.id).title || sec.title || '').trim();
    const heading = node.querySelector('.section-title') || el('h2', 'section-title reveal');
    setSectionTitle(heading, title);
    const intro = sec.intro && sec.intro.trim() ? field(formatted(el('p', 'section-sub'), sec.intro), `${path}.intro`) : null;
    const [first, ...rest] = SECTION_BODIES[type](sec, path, title).filter(Boolean);
    const inner = el('div', 'container custom-inner');
    const head = el('div', 'custom-text');
    // A Text section's text and buttons sit in the same column as its title (beside a side picture)
    head.append(...[title ? heading : null, intro, ...(type === 'text' ? [first, ...rest] : [])].filter(Boolean));
    inner.appendChild(head);
    if (type !== 'text') inner.append(...[first, ...rest].filter(Boolean));
    // The parts that can be moved and adjusted (see applyBlocks): a Text section's are in its text column
    const blocks = type === 'text' ? head : inner;
    blocks.dataset.blocks = '';
    [...blocks.children].forEach((child) => { child.dataset.block = blockName(child); });
    if (image) {
      const figure = el('figure', 'custom-image');
      figure.appendChild(picture(sec.image, sec.imageAlt));
      inner.appendChild(figure);
    }
    // Pencils from the admin panel live on the section itself, so keep them
    node.querySelectorAll(':scope > :not(.adm-pencil)').forEach((child) => child.remove());
    node.prepend(inner);
  });
}

function applySections(content) {
  const sections = content.sections || {};
  textOverrides = {};
  Object.entries(SECTION_TEXT).forEach(([name, keys]) => {
    const own = sections[name] || {};
    Object.entries(keys).forEach(([field, key]) => { if (own[field] && own[field].trim()) textOverrides[key] = own[field].trim(); });
  });
  const description = content.site && content.site.description;
  if (description && description.trim()) textOverrides['meta.description'] = description.trim();
  document.getElementById('meta-description').content = t('meta.description');

  // Extra Work grids take their title from their settings
  (content.workGrids || []).forEach((grid) => {
    const node = document.getElementById(grid.id);
    if (node) setSectionTitle(node.querySelector('.section-title'), (sectionSettings(content, grid.id).title || '').trim() || t('work.title'));
  });

  // Put the sections in order; removed ones stay in the page code but out of sight
  const main = document.getElementById('top');
  const order = sectionOrder(content);
  main.querySelectorAll(':scope > section[id]').forEach((section) => section.classList.toggle('is-off-page', !order.includes(section.id)));
  order.forEach((id) => {
    const section = document.getElementById(id);
    if (section && main.lastElementChild !== section) main.appendChild(section);
  });

  // Section titles can be typed in on the page (admin panel); empty keeps the standard title
  order.forEach((id) => {
    const heading = document.getElementById(id) && document.getElementById(id).querySelector('.section-title');
    if (heading) field(heading, `sections.${id}.title`);
  });
  document.querySelectorAll('.featured .subsection-title').forEach((heading) => field(heading, 'sections.highlights.title'));

  // The menu: one link per section that wants one, in page order (a section shown only on phones or only
  // on computers has its menu link only there too)
  const nav = document.getElementById('main-nav');
  const langs = nav.querySelector('.nav-langs');
  nav.querySelectorAll(':scope > a').forEach((link) => link.remove());
  anchorTargets = {};
  // The home page's sections (from another page they lead back to the home page), then the other pages
  const home = currentPageId ? sectionOrder(content, '') : order;
  if (currentPageId) order.forEach((id) => sectionLink(content, id));
  home.forEach((id) => {
    const name = sectionLink(content, id);
    const text = sectionNavText(content, id);
    const set = sectionSettings(content, id);
    if (!set.inMenu || !text) return;
    const link = el('a', set.device === 'all' ? null : `only-${set.device}`, text);
    link.href = currentPageId ? `${homeHref()}#${name}` : `#${name}`;
    if (currentPageId) Object.assign(link.dataset, { page: '', hash: name });
    nav.insertBefore(link, langs);
  });
  pagesOf(content).forEach((page) => {
    if (page.inMenu === false) return;
    const link = el('a', page.id === currentPageId ? 'is-current' : null, (page.nav || '').trim() || (page.title || '').trim() || page.slug);
    link.href = pageHref(page);
    link.dataset.page = page.id;
    if (page.id === currentPageId) link.setAttribute('aria-current', 'page');
    nav.insertBefore(link, langs);
  });
  // The logo leads home
  const logo = document.querySelector('[data-site="logo"]');
  logo.href = currentPageId ? homeHref() : '#top';
  if (currentPageId) logo.dataset.page = '';
  else delete logo.dataset.page;
}

// ---------- Blocks: the parts of a section ----------
// Each section's parts (title, intro, text, video, list…) can be put in another order and adjusted
// (admin panel: on the page, or Look and layout). content.sections.<id>:
//   blockOrder: ["intro", "title", …] (parts not listed keep their place after these)
//   blockLook: { title: { align: "left" | "center" | "right", space: -2…4 (steps of 20px above), width: "" | "medium" | "narrow" } }
// Added sections name their parts in renderCustomSections; the built-in ones are found here.
const BUILTIN_BLOCKS = {
  about: ['.about-text', { title: '.section-title', bio: '#about-bio', skills: '.skills' }],
  reel: [':scope > .container', { title: '.section-title', intro: '.section-intro', video: '.reel-frame' }],
  work: [':scope > .container', { title: '.section-title', intro: '.section-intro', highlights: '.featured', filters: '.filter-bar', grid: '.work-grid' }],
  experience: [':scope > .container', { title: '.section-title', list: '.timeline' }],
  toolkit: [':scope > .container', { title: '.section-title', list: '.toolkit' }],
  contact: ['.contact-inner', { title: '.section-title', intro: '.section-intro', formtitle: '.subsection-title', form: '.contact-form', alt: '.contact-alt' }],
};
BUILTIN_BLOCKS.grid = BUILTIN_BLOCKS.work;
const BLOCK_SPACE = 20;

function applyBlocks(content) {
  sectionOrder(content).forEach((id) => {
    const section = document.getElementById(id);
    if (!section) return;
    const set = sectionSettings(content, id);
    const builtin = BUILTIN_BLOCKS[set.kind];
    if (builtin && !section.classList.contains('custom-section')) {
      const container = section.querySelector(builtin[0]);
      if (!container) return;
      container.dataset.blocks = '';
      Object.entries(builtin[1]).forEach(([name, selector]) => {
        const node = container.querySelector(`:scope > ${selector}`);
        if (node) node.dataset.block = name;
      });
    }
    const order = Array.isArray(set.blockOrder) ? set.blockOrder : [];
    const looks = set.blockLook && typeof set.blockLook === 'object' ? set.blockLook : {};
    section.querySelectorAll('[data-blocks]').forEach((container) => {
      const blocks = [...container.children].filter((child) => child.dataset.block);
      const names = blocks.map((b) => b.dataset.block);
      const rank = (name) => (order.includes(name) ? order.indexOf(name) : order.length + names.indexOf(name));
      const moved = names.some((name, i) => i > 0 && rank(name) < rank(names[i - 1]));
      const spaced = blocks.some((b) => Number((looks[b.dataset.block] || {}).space));
      // Only rearranged (or spaced) parts become a column of their own; otherwise the page is as it was
      container.classList.toggle('has-blocks', moved || spaced);
      blocks.forEach((block) => {
        const look = looks[block.dataset.block] || {};
        block.style.order = moved ? String(rank(block.dataset.block)) : '';
        ['left', 'center', 'right'].forEach((a) => block.classList.toggle(`align-${a}`, look.align === a));
        ['medium', 'narrow'].forEach((w) => block.classList.toggle(`width-${w}`, look.width === w));
        block.style.marginTop = '';
        const space = Math.min(Math.max(Math.round(Number(look.space) || 0), -2), 4);
        if (space) block.style.marginTop = `${Math.max(parseFloat(getComputedStyle(block).marginTop) + space * BLOCK_SPACE, 0)}px`;
      });
    });
  });
}

// Light or dark text for a background colour ("#rrggbb")
function isLightColor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
}

// Background, title style and size, width, spacing and devices of each section. A small-titled section on
// the same background as the one above sits right under it, like a part of it (Experience and Toolkit under Work).
function applySectionLook(content) {
  lookContent = content;
  let previous = null;
  let first = true;
  sectionOrder(content).forEach((id) => {
    const section = document.getElementById(id);
    if (!section) return;
    // The top section has its own look; the section after it starts fresh (it fades into it)
    if (id === 'hero') {
      previous = null;
      first = true;
      return;
    }
    const set = sectionSettings(content, id);
    const custom = set.background === 'custom';
    // The second version (dark and light for visitors): its own colour (made from the first unless set),
    // its own picture if there is one, and on light a picture can be lightened instead of darkened
    const mode = shownMode();
    const other = modeSet.switchable && mode !== modeSet.main;
    const image = custom && set.bgImage ? assetUrl(other && set.bgImageOther ? set.bgImageOther : set.bgImage) : '';
    const colour = !custom ? '' : !other ? set.bgColor : isHexColor(set.bgColorOther) ? set.bgColorOther : otherBackground(set.bgColor, mode);
    const lighten = Boolean(image) && other && mode === 'light' && set.bgOther === 'light';
    section.classList.toggle('bg-main', set.background === 'main');
    section.classList.toggle('bg-alt', set.background === 'alt');
    section.classList.toggle('bg-custom', custom);
    // Text on a picture is light (the picture is darkened) or dark (lightened); on a colour, whatever reads on it
    section.classList.toggle('tone-light', custom && (image ? !lighten : !isLightColor(colour)));
    section.classList.toggle('tone-dark', custom && (image ? lighten : isLightColor(colour)));
    section.style.backgroundColor = custom && isHexColor(colour) ? colour : '';
    const shade = lighten ? `rgba(255, 255, 255, ${set.bgDarken / 100})` : `rgba(0, 0, 0, ${set.bgDarken / 100})`;
    section.style.backgroundImage = image ? `linear-gradient(${shade}, ${shade}), url("${cssString(image)}")` : '';
    section.classList.toggle('title-small', set.titleStyle === 'small');
    section.style.setProperty('--title-scale', String(set.titleSize / 100));
    SECTION_CHOICES.width.forEach((w) => section.classList.toggle(`width-${w}`, w !== 'normal' && w === set.width));
    SECTION_CHOICES.spacing.forEach((s) => section.classList.toggle(`space-${s}`, s !== 'normal' && s === set.spacing));
    if (set.layout) section.dataset.layout = set.layout;
    else delete section.dataset.layout;
    section.classList.toggle('only-desktop', set.device === 'desktop');
    section.classList.toggle('only-phone', set.device === 'phone');
    if (section.classList.contains('is-removed')) return;
    const sameBackground = previous && previous.background === set.background
      && (!custom || (previous.bgColor === set.bgColor && !previous.bgImage && !set.bgImage));
    section.classList.toggle('is-joined', Boolean(sameBackground && set.titleStyle === 'small'));
    section.classList.toggle('is-first', first);
    first = false;
    previous = set;
  });
}

// The top section fades into whichever section comes after it (or the footer)
function matchHeroFade() {
  const order = sectionOrder(currentContent);
  const after = order.slice(order.indexOf('hero') + 1).map((id) => document.getElementById(id))
    .find((s) => s && !s.classList.contains('is-removed'));
  const hero = document.querySelector('.hero');
  const next = after || document.querySelector('.site-footer');
  if (!next) return;
  // The colour it's set to, not the one it shows: while dark and light fade over, that's still the old one
  const colour = next.classList.contains('bg-main') || next.classList.contains('site-footer') ? 'var(--bg)'
    : next.classList.contains('bg-alt') ? 'var(--bg-alt)'
      : next.style.backgroundColor || getComputedStyle(next).backgroundColor;
  hero.style.setProperty('--after-hero', colour);
}

let currentContent = {};

let pageChecked = false;

// Takes the full content (all languages) and shows it in the current language
function renderSite(fullContent) {
  currentContent = fullContent;
  if (!pageChecked) {
    pageChecked = true;
    currentPageId = pageFromUrl(fullContent);
  }
  // A page that no longer exists (deleted, or undone): back to the home page
  if (currentPageId && !pagesOf(fullContent).some((pg) => pg.id === currentPageId)) currentPageId = '';
  updateLanguages(fullContent);
  const content = localize(fullContent);
  categories = Array.isArray(content.categories) && content.categories.length ? content.categories : DEFAULT_CATEGORIES;
  applyTheme(content.theme);
  applyCursor(content.theme && content.theme.cursor);
  renderIdentity(content.site || {}, content.theme);
  const page = pagesOf(content).find((pg) => pg.id === currentPageId);
  if (page && (page.title || '').trim()) document.title = `${page.title.trim()} · ${document.title}`;
  workItems = content.work || [];
  projectSlugs = slugsFor(workItems);
  projectView = fullContent.projectView === 'page' ? 'page' : 'popup';
  renderCustomSections(content);
  renderExtraGrids(content.workGrids || []);
  applySections(content);
  // How the contact form sends, and the line under it that says so
  formSettings = { service: '', key: '', ...(fullContent.contactForm || {}) };
  document.querySelector('.form-note').dataset.i18n = formService() ? 'contact.noteDirect' : 'contact.note';
  applyUiText(document);
  renderTexts(content);
  renderHeroMedia(content.hero || {});
  renderHeroPortrait(content);
  heroSettings = { ...HERO_DEFAULTS, ...((content.hero && content.hero.layout) || {}) };
  const resume = document.getElementById('resume-link');
  if (content.resume) resume.href = assetUrl(content.resume);
  else resume.removeAttribute('href');
  buildTimeline(reelFromWork(content.work || []));
  applyHeroLayout();
  applyRemovedParts(content.hidden);
  renderLinks(content.links || {}, content.customLinks, content.footerLinks);
  renderAbout(content.about || {});
  renderReel(content.reel);
  renderGrids(content);
  renderExperience(content.experience || []);
  renderToolkit(content.toolkit || []);
  applySectionLook(content);
  applyBlocks(content);
  matchHeroFade();
}

// Exposed so the admin panel can live-preview edits
window.renderSite = renderSite;

// ---------- Contact form ----------
// content.contactForm = { service: "web3forms" | "formspree" | "", key }. With a service, the message is
// sent from the page (the service emails it to you); without one, sending opens the visitor's email app
// with the message filled in (to links.email). If sending fails, the visitor can still send it by email.
// admin: Site tab, Links.
const contactForm = document.getElementById('contact-form');
const formStatus = document.getElementById('form-status');
let formSettings = { service: '', key: '' };

const FORM_SERVICES = {
  web3forms: (key, f) => ['https://api.web3forms.com/submit', {
    access_key: key, name: f.name, email: f.email, subject: f.subject || `${siteName}: new message`, message: f.message, from_name: f.name,
  }],
  formspree: (key, f) => [`https://formspree.io/f/${encodeURIComponent(key)}`, {
    name: f.name, email: f.email, _subject: f.subject || `${siteName}: new message`, message: f.message,
  }],
};

const formService = () => (FORM_SERVICES[formSettings.service] && String(formSettings.key || '').trim() ? formSettings.service : '');

const mailBody = (f) => `${f.message}\n\nFrom: ${f.name} (${f.email})`;

function mailtoFor(f) {
  return `mailto:${contactEmail}?subject=${encodeURIComponent(f.subject)}&body=${encodeURIComponent(mailBody(f))}`;
}

// Mail websites that can open a new email with everything filled in
const WEBMAILS = [
  { name: 'Gmail', domains: /^(gmail|googlemail)\.com$/, url: (to, subject, body) => `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${subject}&body=${body}` },
  { name: 'Outlook', domains: /^(outlook|hotmail|live|msn)\.[a-z.]+$/, url: (to, subject, body) => `https://outlook.live.com/mail/0/deeplink/compose?to=${to}&subject=${subject}&body=${body}` },
  { name: 'Yahoo Mail', domains: /^(yahoo|ymail|rocketmail)\.[a-z.]+$/, url: (to, subject, body) => `https://compose.mail.yahoo.com/?to=${to}&subject=${subject}&body=${body}` },
];

const webmailUrl = (mail, f) => mail.url(encodeURIComponent(contactEmail), encodeURIComponent(f.subject), encodeURIComponent(mailBody(f)));

// The mail website the visitor uses, told by the address they typed (sam@gmail.com: Gmail); null for
// addresses that don't say (a work or school address could be on any of them)
function webmailFor(address) {
  const domain = String(address).split('@')[1] || '';
  return WEBMAILS.find((mail) => mail.domains.test(domain.toLowerCase())) || null;
}

// The ways to send the message: each mail website with it filled in, the email app (withApp), or a copy
// to paste into an email
function emailOptions(f, withApp) {
  const link = (label, href) => {
    const a = el('a', null, label);
    a.href = href;
    if (/^https:/.test(href)) { a.target = '_blank'; a.rel = 'noopener'; }
    return a;
  };
  const copy = el('button', 'form-copy', t('contact.copy'));
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`${contactEmail}\n${f.subject}\n\n${mailBody(f)}`);
      copy.textContent = t('contact.copied').replace('{email}', contactEmail);
    } catch {
      copy.textContent = contactEmail; // no clipboard here: at least the address to write to
    }
  });
  const items = [
    ...WEBMAILS.map((mail) => link(mail.name, webmailUrl(mail, f))),
    withApp ? link(t('contact.emailApp'), mailtoFor(f)) : null,
    copy,
  ].filter(Boolean);
  const list = el('span', 'form-options');
  items.forEach((item, i) => list.append(i ? ' · ' : '', item));
  return list;
}

// `f`: the message, to offer the other ways to send it (`withApp`: the email app among them)
function showFormStatus(text, kind, f, withApp) {
  formStatus.hidden = false;
  formStatus.className = `form-status is-${kind}`;
  formStatus.textContent = text;
  if (f && contactEmail) formStatus.append(' ', emailOptions(f, withApp));
}

// Sends one message through the service set; throws if it doesn't arrive. Used by the admin panel's test too.
async function sendMessage(f, settings = formSettings) {
  const [url, data] = FORM_SERVICES[settings.service](String(settings.key).trim(), f);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false) throw new Error(result.message || (result.errors && result.errors[0] && result.errors[0].message) || response.statusText);
}
window.SiteContact = { send: sendMessage };

contactForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = (id) => document.getElementById(id).value.trim();
  const f = { name: value('name'), email: value('email'), subject: value('subject'), message: value('message') };
  // No service: the visitor's own mail website opens in a new tab with the email written (Gmail for a
  // Gmail address…), ready to send. An address that doesn't say which one gets the choice instead.
  if (!formService()) {
    const mail = webmailFor(f.email);
    const tab = mail ? window.open(webmailUrl(mail, f), '_blank') : null;
    if (tab) {
      tab.opener = null;
      formStatus.hidden = true;
    } else {
      showFormStatus(t('contact.pickMail'), 'busy', f, true);
    }
    return;
  }
  // Filled in by a robot: act as if it was sent
  if (value('website')) {
    contactForm.reset();
    showFormStatus(t('contact.sent'), 'ok');
    return;
  }
  const button = contactForm.querySelector('button[type="submit"]');
  button.disabled = true;
  showFormStatus(t('contact.sending'), 'busy');
  try {
    await sendMessage(f);
    contactForm.reset();
    showFormStatus(t('contact.sent'), 'ok');
  } catch {
    showFormStatus(`${t('contact.failed')} ${t('contact.failedEmail')}:`, 'error', f, true);
  } finally {
    button.disabled = false;
  }
});

// Project detail modal
const modal = document.getElementById('project-modal');
const modalClose = document.getElementById('modal-close');
const modalThumb = document.getElementById('modal-thumb');
const modalTag = document.getElementById('modal-tag');
const modalTitle = document.getElementById('modal-title');
const modalMeta = document.getElementById('modal-meta');
const modalVideos = document.getElementById('modal-videos');
const modalDesc = document.getElementById('modal-desc');
const modalTools = document.getElementById('modal-tools');
const modalLinks = document.getElementById('modal-links');
let lastFocusedCard = null;
let modalItem = null;

// Everything the pop-up can show for a project: its videos, then its pictures
function projectMedia(item) {
  return [
    ...projectVideos(item).map((clip) => ({ kind: 'video', clip })),
    ...projectPictures(item).map((img) => ({ kind: 'picture', img })),
  ];
}

let mediaIndex = 0;

// Shows one video (uploaded file or YouTube) or picture in the pop-up, with arrows when there are more
function showMedia(index) {
  const media = projectMedia(modalItem);
  if (!media.length) return;
  mediaIndex = (index + media.length) % media.length;
  const entry = media[mediaIndex];
  modalThumb.classList.add('has-media');
  modalThumb.innerHTML = '';
  if (entry.kind === 'picture') {
    const img = el('img', 'modal-picture');
    img.src = assetUrl(entry.img.src);
    img.alt = entry.img.alt || modalItem.title || '';
    modalThumb.appendChild(img);
    if (modalItem.isGallery) {
      modalDesc.textContent = entry.img.caption || '';
      modalDesc.hidden = !modalDesc.textContent;
    }
  } else if (entry.clip.video) {
    const { clip } = entry;
    const video = document.createElement('video');
    video.src = assetUrl(clip.video);
    video.controls = true;
    video.playsInline = true;
    video.preload = 'auto';
    const poster = clip.thumb ? assetUrl(clip.thumb) : mediaIndex === 0 ? coverImage(modalItem) : '';
    if (poster) video.poster = poster;
    modalThumb.appendChild(video);
    // Start playing straight away; opening the pop-up (or picking a video) is a click, so browsers allow sound.
    // If a browser still blocks it, the video just waits for the play button.
    video.play().catch(() => {});
  } else {
    modalThumb.appendChild(youtubeEmbed(entry.clip.youtube, entry.clip.title || modalItem.title, true));
  }
  if (media.length > 1) {
    [['prev', -1, 'M15 6l-6 6 6 6'], ['next', 1, 'M9 6l6 6-6 6']].forEach(([name, step, path]) => {
      const btn = el('button', `modal-arrow modal-${name}`);
      btn.type = 'button';
      btn.setAttribute('aria-label', t(`work.${name}Media`));
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
      btn.addEventListener('click', () => showMedia(mediaIndex + step));
      modalThumb.appendChild(btn);
    });
  }
  modalVideos.querySelectorAll('button').forEach((btn, i) => btn.setAttribute('aria-pressed', String(i === mediaIndex)));
  const active = modalVideos.children[mediaIndex];
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Thumbnails under the viewer to jump between a project's videos and pictures (only with more than one)
function buildMediaPicker(item) {
  const media = projectMedia(item);
  modalVideos.innerHTML = '';
  modalVideos.hidden = media.length < 2;
  modalVideos.classList.toggle('is-pictures', media.every((m) => m.kind === 'picture'));
  if (media.length < 2) return;
  let videoNumber = 0;
  media.forEach((entry, i) => {
    const btn = el('button', 'modal-video');
    btn.type = 'button';
    let image = '';
    let label = '';
    if (entry.kind === 'picture') {
      image = assetUrl(entry.img.src);
      btn.setAttribute('aria-label', entry.img.alt || t('work.pictureN').replace('{n}', i + 1));
    } else {
      const { clip } = entry;
      videoNumber += 1;
      image = clip.thumb ? assetUrl(clip.thumb) : clip.youtube ? youtubeThumb(clip.youtube) : i === 0 ? coverImage(item) : '';
      label = clip.title || t('work.videoN').replace('{n}', videoNumber);
    }
    if (image) {
      const img = el('img');
      img.src = image;
      img.alt = '';
      img.loading = 'lazy';
      btn.appendChild(img);
    } else {
      btn.appendChild(el('span', 'modal-video-blank'));
    }
    if (label) btn.appendChild(el('span', null, label));
    btn.addEventListener('click', () => showMedia(i));
    modalVideos.appendChild(btn);
  });
}

// ---------- Project addresses ----------
// Every project has an address, ?project=<name>: its link name (item.slug) or its title, in lowercase with
// dashes. Opening a project puts it in the address bar, so it can be shared, and the back button closes it.
// content.projectView: "popup" (the default) opens it over the page; "page" shows it as a page of its own,
// with a button back.
let projectSlugs = [];
let projectView = 'popup';
let openProjectIndex = null; // the project shown, by its place in content.work
let projectPushed = false; // its address was added to the history (so closing goes back)
let beforeProject = { scroll: 0, title: '' };

const slugOf = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Two projects with the same name: the second gets -2, and so on
function slugsFor(items) {
  const seen = new Map();
  return items.map((item) => {
    const base = slugOf(item.slug) || slugOf(item.title) || 'project';
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base}-${n}` : base;
  });
}

// Used by the admin panel (a project's link)
window.SiteProjects = {
  slugs: slugsFor,
  link: (slug) => `${window.location.origin}${window.location.pathname}?project=${encodeURIComponent(slug)}`,
};

// The address with ?project=… set (a slug) or taken out (''), keeping the rest
function projectUrl(slug) {
  const params = new URLSearchParams(window.location.search);
  if (slug) params.set('project', slug);
  else params.delete('project');
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ''}${slug ? '' : window.location.hash}`;
}

function projectFromUrl() {
  const slug = new URLSearchParams(window.location.search).get('project');
  const index = slug ? projectSlugs.indexOf(slug) : -1;
  return index >= 0 && workItems[index] && (!workItems[index].draft || showDrafts()) ? index : -1;
}

function openProject(index, { push = true, card = null } = {}) {
  const item = workItems[index];
  if (!item) return;
  if (openProjectIndex === null) beforeProject = { scroll: window.scrollY, title: document.title };
  if (push) {
    history.pushState(null, '', projectUrl(projectSlugs[index]));
    projectPushed = true;
  }
  openProjectIndex = index;
  fillProject(item, card ? card.querySelector('.card-thumb') : buildThumb(item));
  document.title = `${item.title} · ${beforeProject.title}`;
  lastFocusedCard = card || lastFocusedCard;
  const asPage = projectView === 'page';
  document.documentElement.classList.toggle('is-project-page', asPage);
  modal.querySelector('.modal').setAttribute('aria-modal', String(!asPage));
  modalClose.textContent = asPage ? `← ${t('work.back')}` : '×';
  modal.hidden = false;
  if (asPage) window.scrollTo({ top: 0, behavior: 'instant' });
  else document.body.style.overflow = 'hidden';
  modalClose.focus({ preventScroll: true });
}

function fillProject(item, thumbSource) {
  modalThumb.className = 'modal-thumb';
  modalThumb.style.setProperty('--tile', thumbSource.style.getPropertyValue('--tile'));

  // Videos play in the pop-up, with a picker when there are several; others show their thumbnail
  modalItem = item;
  buildMediaPicker(item);
  if (projectMedia(item).length) showMedia(0);
  else modalThumb.innerHTML = thumbSource.innerHTML;

  modal.classList.remove('is-gallery');
  modalTag.hidden = false;
  modalTag.textContent = typeLabel(item.type);
  modalTitle.textContent = item.title;
  modalTitle.hidden = false;
  modalMeta.textContent = [item.client, item.year, item.role].filter(Boolean).join(' · ');
  modalMeta.hidden = !modalMeta.textContent;
  modalDesc.hidden = false;
  modalDesc.textContent = '';
  inlineText(modalDesc, item.desc || item.teaser);

  modalTools.innerHTML = '';
  (item.tools || []).filter(Boolean).forEach((tool) => modalTools.appendChild(el('span', 'skill-tag', tool)));

  modalLinks.innerHTML = '';
  (item.links || []).slice(0, 2).forEach((linkData, n) => {
    const url = safeUrl(linkData.url || '');
    if (!linkData.label || !url) return;
    const link = el('a', n === 0 ? 'btn btn-primary' : 'btn btn-ghost', linkData.label);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    modalLinks.appendChild(link);
  });
}

// A Gallery section's pictures in the same pop-up, with its title and each picture's caption
function openPictures(images, index, title, opener) {
  modalItem = { title, images, videos: [], isGallery: true };
  modalClose.textContent = '\u00D7';
  modal.classList.add('is-gallery');
  modalThumb.className = 'modal-thumb';
  modalTag.hidden = true;
  modalTitle.textContent = title;
  modalTitle.hidden = !title;
  modalMeta.hidden = true;
  modalTools.innerHTML = '';
  modalLinks.innerHTML = '';
  buildMediaPicker(modalItem);
  showMedia(index);
  lastFocusedCard = opener;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  modalClose.focus();
}

// Closing a project also takes it out of the address: back through the history when opening it added
// it there, so the back button doesn't open it again
function closeModal() {
  if (openProjectIndex !== null) {
    if (projectPushed) {
      history.back(); // popstate hides it
      return;
    }
    history.replaceState(null, '', projectUrl(''));
  }
  hideModal();
}

function hideModal() {
  const wasPage = document.documentElement.classList.contains('is-project-page');
  modal.hidden = true;
  modalThumb.innerHTML = ''; // stops any playing video
  document.body.style.overflow = '';
  document.documentElement.classList.remove('is-project-page');
  if (openProjectIndex !== null) {
    document.title = beforeProject.title;
    if (wasPage) window.scrollTo({ top: beforeProject.scroll, behavior: 'instant' });
  }
  openProjectIndex = null;
  projectPushed = false;
  if (lastFocusedCard && lastFocusedCard.isConnected) lastFocusedCard.focus({ preventScroll: wasPage });
}

modalClose.addEventListener('click', closeModal);

// A menu link (#work…) while a project is shown as a page: back to the sections first, then on to it
document.addEventListener('click', (e) => {
  const link = e.target.closest && e.target.closest('a[href^="#"]');
  if (!link || !document.documentElement.classList.contains('is-project-page')) return;
  history.replaceState(null, '', projectUrl(''));
  hideModal();
}, true);

modal.addEventListener('click', (e) => {
  if (e.target === modal && !document.documentElement.classList.contains('is-project-page')) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (modal.hidden) return;
  if (e.key === 'Escape' && !document.documentElement.classList.contains('is-project-page')) closeModal();
  // Arrow keys move through the pictures and videos (not while typing or using a video's own controls)
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target.closest && e.target.closest('video, input, textarea'))) {
    if (projectMedia(modalItem).length > 1) showMedia(mediaIndex + (e.key === 'ArrowLeft' ? -1 : 1));
  }
});

applyLanguage();
renderSite(window.SITE_CONTENT || {});
if (window.location.hash) scrollToAnchor(hashName(window.location.hash), false);
if (projectFromUrl() >= 0) openProject(projectFromUrl(), { push: false });
else if (new URLSearchParams(window.location.search).has('project')) {
  // An old link (the project was renamed or removed)
  history.replaceState(null, '', projectUrl(''));
  showNote(t('work.missing'));
}
if (pendingSave) showSaveNote(pendingSave.age);
// Sent here by 404.html from an address that doesn't exist: say so, and tidy the address
if (new URLSearchParams(window.location.search).has('missing')) {
  const params = new URLSearchParams(window.location.search);
  params.delete('missing');
  history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`);
  showNote(t('site.missing'));
}
loadAnalytics((window.SITE_CONTENT || {}).analytics);

// Cloudflare Web Analytics: only loads once a token is set (admin panel, Site tab),
// and only on the live https:// site so local testing isn't counted
function loadAnalytics(analytics) {
  const token = analytics && analytics.cloudflareToken;
  // Not for the admin panel's phone preview either (?preview)
  if (!token || window.location.protocol !== 'https:' || new URLSearchParams(window.location.search).has('preview')) return;
  const script = document.createElement('script');
  script.defer = true;
  script.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  script.dataset.cfBeacon = JSON.stringify({ token });
  document.head.appendChild(script);
}

// Admin panel: hidden shortcut, no visible button. The admin code only loads when the shortcut is pressed.
// To change the shortcut, edit this check. It matches the letter typed (e.key), so it works on AZERTY too;
// e.code ('KeyA', the QWERTY position) is a fallback for layouts where Ctrl+Alt changes the typed character.
const isAdminShortcut = (e) => e.ctrlKey && e.altKey && e.shiftKey && ((e.key || '').toLowerCase() === 'a' || e.code === 'KeyA');
let adminLoading = false;

document.addEventListener('keydown', (e) => {
  if (!isAdminShortcut(e)) return;
  e.preventDefault();
  if (window.SiteAdmin) {
    window.SiteAdmin.toggle();
    return;
  }
  if (adminLoading) return;
  adminLoading = true;
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = `css/admin.css${CODE_VERSION}`;
  document.head.appendChild(style);
  const script = document.createElement('script');
  script.src = `js/admin.js${CODE_VERSION}`;
  script.onload = () => window.SiteAdmin.toggle();
  script.onerror = () => { adminLoading = false; };
  document.body.appendChild(script);
});

// Letter-by-letter heading reveal
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const revealHeadings = document.querySelectorAll('.reveal');

// Also used when the language changes (see applyUiText)
// The text may have formatting (bold, italic, spacing): each letter goes inside the marks around it.
// dataset.raw keeps the text as typed, aria-label the words alone.
function setRevealText(heading, text) {
  heading.dataset.raw = text;
  heading.setAttribute('aria-label', plainText(text));
  heading.textContent = '';
  const letters = [];
  const walk = (nodes, marks) => nodes.forEach((node) => {
    if (typeof node === 'string') [...node].forEach((ch) => letters.push({ ch, marks }));
    else walk(node.children, [...marks, node]);
  });
  walk(parseInline(text), []);
  let i = 0;
  let wordEl = null;
  let open = []; // [{ node, box }]: the marks the last letter was in, outermost first
  letters.forEach(({ ch, marks }) => {
    if (ch === ' ') {
      heading.appendChild(document.createTextNode(' '));
      wordEl = null;
      return;
    }
    if (!wordEl) {
      wordEl = el('span', 'reveal-word');
      wordEl.setAttribute('aria-hidden', 'true');
      heading.appendChild(wordEl);
      open = [];
    }
    // Stays in the marks it shares with the letter before, opens the rest
    let same = 0;
    while (same < open.length && same < marks.length && open[same].node === marks[same]) same += 1;
    open = open.slice(0, same);
    marks.slice(same).forEach((node) => {
      const box = inlineTag(node);
      (open.length ? open[open.length - 1].box : wordEl).appendChild(box);
      open.push({ node, box });
    });
    const charEl = el('span', 'reveal-char', ch);
    charEl.style.setProperty('--i', i++);
    (open.length ? open[open.length - 1].box : wordEl).appendChild(charEl);
  });
}

// Headings added after this (new sections in the admin panel) show straight away
revealReady = true;

// Translated headings were already split by applyLanguage()
revealHeadings.forEach((heading) => {
  if (!heading.hasAttribute('aria-label')) setRevealText(heading, heading.textContent.trim());
});

if (reduceMotion || !('IntersectionObserver' in window)) {
  revealHeadings.forEach((h) => h.classList.add('is-in'));
} else {
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-in');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.3 });
  revealHeadings.forEach((h) => revealObserver.observe(h));
}

// Runs the playhead while the top section is on screen; pauses the monitor otherwise
// and while a project pop-up is open. Stands still for visitors who reduce motion.
if (monitorStill) {
  showPlayhead(0.12);
} else {
  let running = false;
  let stoppedAt = null;
  const frame = () => {
    if (!running) return;
    // Same clock as the scrub release, so the playhead carries on from exactly where it was let go
    const now = performance.now();
    if (!scrubbing) showPlayhead((((now - timelineStart) / 1000) % TIMELINE_SECONDS) / TIMELINE_SECONDS);
    const live = monitorPlayers.find((p) => p.classList.contains('is-on'));
    if (live) {
      const shouldPlay = modal.hidden && !scrubbing && !heroMonitor.hidden;
      if (shouldPlay && live.paused) live.play().catch(() => {});
      else if (!shouldPlay && !live.paused) live.pause();
    }
    requestAnimationFrame(frame);
  };
  const start = () => {
    if (running) return;
    running = true;
    // Pick up where it was when the top section scrolled away
    if (stoppedAt != null) timelineStart += performance.now() - stoppedAt;
    requestAnimationFrame(frame);
  };
  const stop = () => {
    if (!running) return;
    running = false;
    stoppedAt = performance.now();
    monitorPlayers.forEach((p) => p.pause());
  };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop())).observe(document.querySelector('.hero'));
  } else {
    start();
  }
}

// About photo: fade and slide in when the section scrolls into view
const aboutPhoto = document.querySelector('.about-photo');

if (aboutPhoto && !reduceMotion && 'IntersectionObserver' in window) {
  aboutPhoto.classList.add('is-pending');
  const photoObserver = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
      aboutPhoto.classList.remove('is-pending');
      photoObserver.disconnect();
    }
  }, { threshold: 0.25 });
  photoObserver.observe(aboutPhoto);
}

// Footer year
document.getElementById('year').textContent = new Date().getFullYear();
