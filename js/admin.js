// Admin panel. Loaded only when the hidden shortcut is pressed (see the end of the content section in js/main.js).
//
// How it stays private:
// - Changes are saved by committing to the GitHub repo with a personal access token. Without that token,
//   nobody can change anything, even if they open this panel.
// - The token is encrypted with your password (PBKDF2-SHA256 + AES-256-GCM, browser Web Crypto) and only
//   the encrypted version is kept in this browser's localStorage. The password is never stored.
// - The decrypted token only lives in memory, and is dropped when the panel closes or sits idle.
(() => {
  const STORE_KEY = 'am-admin-v1';
  const CONTENT_PATH = 'content/site.js';
  const INDEX_PATH = 'index.html';
  const PBKDF2_ITERATIONS = 600000;
  const IDLE_LOCK_MS = 30 * 60 * 1000;
  const MAX_ATTEMPTS = 5;
  const ATTEMPT_COOLDOWN_MS = 30 * 1000;
  const MB = 1024 * 1024;
  const WARN_BYTES = 25 * MB;
  const MAX_BYTES = 50 * MB;
  const FILE_HEADER = '// Site content. The admin panel rewrites this file when you save, so keep it valid JSON after the "=".\n';

  const state = {
    token: null,
    store: null,
    draft: null,
    savedJson: '',
    remoteSha: null,
    pending: new Map(), // repo path -> File waiting to be uploaded
    offerCleanup: false, // started fresh from a copy: offer to delete unused files after the first save
    tab: 'page',
    openRow: null, // the section open in the Page tab
    openLang: null, // the language whose interface text is open in the Site tab
    openItem: null,
    saving: false,
    failedAttempts: 0,
    cooldownUntil: 0,
    note: '',
  };
  window.SITE_ASSET_OVERRIDES = window.SITE_ASSET_OVERRIDES || {};

  // ---------- Small DOM helper ----------
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value == null || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key in node && key !== 'list') node[key] = value;
      else node.setAttribute(key, value);
    });
    children.flat().forEach((child) => {
      if (child == null || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  // ---------- Encoding ----------
  function bytesToB64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function b64ToBytes(b64) {
    const binary = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  const textToB64 = (text) => bytesToB64(new TextEncoder().encode(text));
  const b64ToText = (b64) => new TextDecoder().decode(b64ToBytes(b64));

  function fileToB64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // ---------- Encryption ----------
  async function deriveKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async function encryptToken(token, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));
    return { iter: PBKDF2_ITERATIONS, salt: bytesToB64(salt), iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
  }

  // AES-GCM is authenticated, so a wrong password makes decrypt throw instead of returning garbage
  async function decryptToken(secret, password) {
    const key = await deriveKey(password, b64ToBytes(secret.salt), secret.iter);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(secret.iv) }, key, b64ToBytes(secret.ct));
    return new TextDecoder().decode(plain);
  }

  // ---------- Device storage (encrypted token + repo settings) ----------
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveStore(store) {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }

  function clearStore() {
    try { localStorage.removeItem(STORE_KEY); } catch { /* nothing stored */ }
  }

  // Repository suggested when setting up a device: the one in the Site tab, else guessed from a
  // GitHub Pages address (<owner>.github.io/<repo>)
  // On GitHub Pages the address comes first: in a copy of someone's site, the content still names
  // the original repository
  function defaultRepo() {
    const own = ((window.SITE_CONTENT || {}).site || {}).repo || {};
    const pages = /^([\w-]+)\.github\.io$/i.exec(window.location.hostname);
    if (pages) {
      const first = window.location.pathname.split('/').filter(Boolean)[0];
      const repo = first && !first.includes('.') ? first : `${pages[1]}.github.io`;
      const branch = own.owner && own.repo && `${own.owner}/${own.repo}`.toLowerCase() === `${pages[1]}/${repo}`.toLowerCase() ? own.branch : '';
      return { owner: pages[1], repo, branch: branch || 'main' };
    }
    if (own.owner && own.repo) return { owner: own.owner, repo: own.repo, branch: own.branch || 'main' };
    return { owner: '', repo: '', branch: 'main' };
  }

  // ---------- GitHub API ----------
  const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

  async function gh(endpoint, options = {}, token = state.token, repo = state.store.repo) {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}${endpoint}`, {
      ...options,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (response.status === 404) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const hint = response.status === 401 ? ' (token invalid or expired)'
        : response.status === 403 ? ' (token lacks permission for this repo)'
          : response.status === 409 ? ' (file changed on GitHub, try again)'
            : response.status === 422 ? ' (GitHub rejected the file, it may be too large)' : '';
      throw new Error(`GitHub: ${data.message || response.statusText}${hint}`);
    }
    return data;
  }

  const getFile = (path) => gh(`/contents/${encodePath(path)}?ref=${encodeURIComponent(state.store.repo.branch)}`);

  // ---------- Content ----------
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const serialize = (content) => `${FILE_HEADER}window.SITE_CONTENT = ${JSON.stringify(content, null, 2)};\n`;

  function parseContent(text) {
    const match = text.match(/window\.SITE_CONTENT\s*=\s*([\s\S]*?);?\s*$/);
    if (!match) throw new Error(`${CONTENT_PATH} is not in the expected format`);
    return JSON.parse(match[1]);
  }

  const DEFAULT_FOOTER_LINKS = ['youtube', 'github', 'linkedin'];

  // Content saved before categories were editable used Video / Audio / Code, translated in js/i18n.js
  function defaultCategories() {
    const ui = window.SITE_UI_TEXT || {};
    return [['video', 'play'], ['audio', 'music'], ['code', 'code']].map(([id, icon]) => {
      const tr = ui[`type.${id}`] || {};
      const i18n = {};
      Object.entries(tr).forEach(([code, label]) => { if (code !== 'en') i18n[code] = { label }; });
      return { id, label: tr.en || id, icon, color: '', i18n };
    });
  }

  function normalize(content) {
    const c = content || {};
    c.site = { name: '', shortName: '', title: '', description: '', initials: '', ...(c.site || {}) };
    c.site.repo = { owner: '', repo: '', branch: 'main', ...(c.site.repo || {}) };
    c.site.favicon = c.site.favicon || '';
    c.site.shareImage = c.site.shareImage || '';
    c.site.url = c.site.url || '';
    const languages = window.SiteI18n.settings(c);
    c.languages = { main: languages.main, available: languages.available, ui: { ...((c.languages || {}).ui || {}) } };
    c.theme = { preset: 'midnight', font: 'Geologica', headingFont: '', radius: 14, ...(c.theme || {}) };
    c.theme.colors = { ...(c.theme.colors || {}) };
    c.theme.cursor = { ...(window.CURSOR_DEFAULTS || {}), ...(c.theme.cursor || {}) };
    c.theme.saved = (Array.isArray(c.theme.saved) ? c.theme.saved : []).map((scheme) => ({ name: '', preset: 'midnight', ...scheme, colors: { ...((scheme && scheme.colors) || {}) } }));
    c.theme.customFonts = (c.theme.customFonts || []).map((f) => ({ name: '', file: '', weight: 'auto', style: 'normal', ...f }));
    c.customSections = (c.customSections || []).map(normalizeSection);
    c.workGrids = (c.workGrids || []).map((grid) => ({ intro: '', ...grid }));
    c.categories = Array.isArray(c.categories) && c.categories.length
      ? c.categories.map((cat) => ({ label: '', icon: 'play', color: '', ...cat }))
      : defaultCategories();
    // Sections: the order on the page, built-in ones taken off it, and each one's settings with the
    // defaults for its kind filled in (see SECTION_LOOK in js/main.js)
    c.sections = c.sections || {};
    c.sections.removed = Array.isArray(c.sections.removed) ? c.sections.removed : [];
    c.sections.order = window.SiteSections.order(c);
    [...window.SiteSections.builtin, ...c.workGrids.map((g) => g.id), ...c.customSections.map((sec) => sec.id)].forEach((id) => {
      // Text sections from before kept their title and menu settings on the section itself
      const legacy = c.customSections.find((sec) => sec.id === id) || {};
      ['title', 'nav', 'inMenu', 'background'].forEach((key) => {
        if (key in legacy && !(c.sections[id] && key in c.sections[id])) c.sections[id] = { ...(c.sections[id] || {}), [key]: legacy[key] };
        delete legacy[key];
      });
      const look = window.SiteSections.settings(c, id);
      c.sections[id] = {
        title: '', nav: '', ...(c.sections[id] || {}),
        inMenu: look.inMenu, background: look.background, titleStyle: look.titleStyle, titleSize: look.titleSize,
      };
      if (look.kind === 'work' || look.kind === 'grid') c.sections[id].categories = c.sections[id].categories || [];
    });
    c.sections.highlights = { title: '', ...(c.sections.highlights || {}) };
    c.reel = c.reel || { youtube: '' };
    c.resume = typeof c.resume === 'string' ? c.resume : '';
    c.about = c.about || {};
    c.about.photo = typeof c.about.photo === 'string' ? c.about.photo : '';
    c.about.paragraphs = c.about.paragraphs || [];
    c.about.skills = c.about.skills || [];
    c.work = (c.work || []).map(normalizeWork);
    c.experience = c.experience || [];
    c.toolkit = c.toolkit || [];
    c.links = c.links || {};
    c.customLinks = (c.customLinks || []).map((link) => ({ label: '', url: '', footer: false, ...link }));
    c.footerLinks = Array.isArray(c.footerLinks) ? c.footerLinks : [...DEFAULT_FOOTER_LINKS];
    c.analytics = c.analytics || { cloudflareToken: '' };
    c.highlights = { autoplay: true, seconds: 6, ...(c.highlights || {}) };
    c.hidden = c.hidden || {};
    // Content saved before these existed: start from what the page currently shows
    document.querySelectorAll('[data-text]').forEach((node) => {
      const [group, key] = node.dataset.text.split('.');
      c[group] = c[group] || {};
      if (typeof c[group][key] !== 'string') c[group][key] = node.textContent.trim().replace(/\s+/g, ' ');
    });
    c.hero.background = c.hero.background || '';
    c.hero.backgroundVideo = c.hero.backgroundVideo || '';
    c.hero.portrait = c.hero.portrait || '';
    c.hero.layout = { ...(window.HERO_DEFAULTS || {}), ...(c.hero.layout || {}) };
    return c;
  }

  // A Text section's content; its title, menu and look are in content.sections like every section's
  const normalizeSection = (sec) => ({
    text: '', image: '', imageAlt: '', imagePlace: 'below',
    ...sec,
    button: { label: '', url: '', ...((sec && sec.button) || {}) },
  });

  // Always two link rows, so the form can bind to them; empty rows are dropped on save
  function normalizeWork(item) {
    const full = {
      type: 'video', title: '', client: '', year: '', role: '', featured: false, teaser: '', desc: '', tools: [], thumb: '', thumbAlt: '', links: [],
      ...item,
    };
    // Content saved before projects could hold several videos: move the single video into the list
    if (!Array.isArray(full.videos)) full.videos = full.video || full.youtube ? [{ video: full.video || '', youtube: full.youtube || '' }] : [];
    delete full.video;
    delete full.youtube;
    full.videos = full.videos.map(normalizeVideo);
    full.images = (Array.isArray(full.images) ? full.images : []).map((img) => ({ src: '', alt: '', ...img }));
    full.links = full.links.slice(0, 2);
    while (full.links.length < 2) full.links.push({ label: '', url: '' });
    return full;
  }

  const normalizeVideo = (clip) => ({ title: '', video: '', youtube: '', thumb: '', ...clip });

  // Accepts a full YouTube link (watch, youtu.be, shorts, embed) or a bare video ID
  function youtubeId(input) {
    const value = (input || '').trim();
    if (/^[\w-]{11}$/.test(value)) return value;
    try {
      const url = new URL(value);
      if (url.hostname.endsWith('youtu.be')) return url.pathname.slice(1, 12);
      if (url.searchParams.get('v')) return url.searchParams.get('v').slice(0, 11);
      const parts = url.pathname.split('/');
      const i = parts.findIndex((p) => ['embed', 'shorts', 'live', 'v'].includes(p));
      if (i >= 0 && parts[i + 1]) return parts[i + 1].slice(0, 11);
    } catch { /* not a URL */ }
    return '';
  }

  const splitList = (text) => text.split(',').map((t) => t.trim()).filter(Boolean);

  function slug(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'file';
  }

  function extension(file) {
    const match = /\.([a-z0-9]{1,5})$/i.exec(file.name);
    return match ? `.${match[1].toLowerCase()}` : '';
  }

  // ---------- Translations ----------
  // Any object can carry "i18n": { nl: {...}, fr: {...} } with the same text keys as its English.
  // While the site shows another language, the text fields below read and write that translation.
  const TRANSLATABLE = new Set(['role', 'intro', 'availability', 'reel', 'work', 'contact', 'paragraphs', 'skills',
    'title', 'teaser', 'desc', 'thumbAlt', 'label', 'date', 'org', 'text', 'monitorLabel', 'nav', 'description']);
  const lang = () => (window.SiteI18n ? window.SiteI18n.lang : 'en');
  // The language the content is written in; other languages are saved as translations of it
  const mainLang = () => (state.draft && state.draft.languages ? state.draft.languages.main : (window.SiteI18n || {}).main || 'en');
  const translating = (key) => lang() !== mainLang() && TRANSLATABLE.has(key);

  function translationOf(obj) {
    obj.i18n = obj.i18n || {};
    obj.i18n[lang()] = obj.i18n[lang()] || {};
    return obj.i18n[lang()];
  }

  // Drops empty translations so opening a form in another language doesn't count as a change
  function compactI18n(i18n) {
    const out = {};
    Object.entries(i18n || {}).forEach(([code, fields]) => {
      const kept = {};
      Object.entries(fields || {}).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          const items = Array.from(value, (v) => (typeof v === 'string' ? v.trim() : ''));
          while (items.length && !items[items.length - 1]) items.pop();
          if (items.length) kept[key] = items;
        } else if (typeof value === 'string' && value.trim()) {
          kept[key] = value.trim();
        }
      });
      if (Object.keys(kept).length) out[code] = kept;
    });
    return Object.keys(out).length ? out : undefined;
  }

  const tidyI18n = (key, value) => (key === 'i18n' || key === 'ui' ? compactI18n(value) : value);
  const snapshot = () => JSON.stringify(state.draft, tidyI18n);

  const isDirty = () => state.draft && (snapshot() !== state.savedJson || state.pending.size > 0);

  // Paths in the content that point at uploadable files
  function referencedPaths(content) {
    const paths = new Set([content.site.favicon, content.site.shareImage, content.resume, content.about.photo, content.hero.background, content.hero.backgroundVideo, content.hero.portrait]);
    content.theme.customFonts.forEach((f) => paths.add(f.file));
    paths.add(content.theme.cursor.image);
    content.customSections.forEach((sec) => paths.add(sec.image));
    content.work.forEach((item) => {
      paths.add(item.thumb);
      item.videos.forEach((clip) => { paths.add(clip.video); paths.add(clip.thumb); });
      item.images.forEach((img) => paths.add(img.src));
    });
    paths.delete('');
    return paths;
  }

  // ---------- Live preview ----------
  let previewTimer = 0;
  function preview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (state.draft) renderPage(state.draft);
      updateStatus();
    }, 120);
  }

  const changed = () => preview();

  // ---------- Editing on the page ----------
  // While a draft is open, every item tagged data-edit-item (in index.html and js/main.js) gets a pencil.
  // Pressing it unlocks that item's text (tagged data-field) for typing on the page, with Done / More… buttons.
  // Items with no text on the page (showreel, photo, links) open their form in the panel instead.
  let activeItem = null;

  function renderPage(content) {
    activeItem = null; // re-rendering replaces the page elements
    window.renderSite(content);
    decoratePage();
    syncPhone();
  }

  // ---------- Phone preview ----------
  // The same page at phone width, in a frame beside the panel. It shows the unsaved draft and follows
  // every change. (Phone layouts depend on the screen width, so it has to be a separate page in a frame.)
  let phone = null;
  const PHONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>';

  function togglePhone() {
    if (phone) closePhone();
    else openPhone();
    labelWindowButtons();
  }

  function openPhone() {
    if (windowState.mode === 'full') setWindowMode('full'); // full screen would cover it: dock the panel
    const frame = h('iframe', { title: 'Phone preview', src: `${window.location.pathname}?preview=phone` });
    frame.addEventListener('load', syncPhone);
    const wrap = h('div', { class: 'adm-phone' },
      h('div', { class: 'adm-phone-frame' }, frame),
      h('button', { class: 'adm-btn', type: 'button', text: 'Close phone preview', onclick: togglePhone }));
    document.body.appendChild(wrap);
    phone = { wrap, frame };
    placePhone();
  }

  function closePhone() {
    if (!phone) return;
    phone.wrap.remove();
    phone = null;
  }

  // Centred in the space left of the docked panel
  function placePhone() {
    if (phone) phone.wrap.classList.toggle('is-beside-panel', windowState.mode === 'docked' && !isMinimised());
  }

  function syncPhone() {
    const win = phone && phone.frame.contentWindow;
    if (!win || !win.renderSite || !state.draft) return;
    win.SITE_ASSET_OVERRIDES = window.SITE_ASSET_OVERRIDES;
    win.renderSite(win.JSON.parse(JSON.stringify(state.draft)));
    if (win.SiteI18n && win.SiteI18n.lang !== lang()) win.SiteI18n.setLanguage(lang());
  }

  const itemFields = (item) => [...(item.matches('[data-field]') ? [item] : []), ...item.querySelectorAll('[data-field]')];

  function decoratePage() {
    document.documentElement.classList.add('adm-editing');
    document.querySelectorAll('[data-edit-item]').forEach((item) => {
      if (item.querySelector(':scope > .adm-pencil')) return;
      const inline = itemFields(item).length > 0;
      const label = inline ? 'Edit on the page' : 'Edit in the admin panel';
      item.appendChild(h('button', {
        class: 'adm-pencil',
        type: 'button',
        title: label,
        'aria-label': label,
        text: '✎',
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation(); // don't open the project pop-up underneath
          if (inline) startInline(item);
          else editFromPage(item.dataset.editItem);
        },
      }));
    });
  }

  function undecoratePage() {
    stopInline();
    document.documentElement.classList.remove('adm-editing');
    document.querySelectorAll('.adm-pencil').forEach((pencil) => pencil.remove());
  }

  function startInline(item) {
    stopInline();
    activeItem = item;
    item.classList.add('adm-active');
    // While editing, clicks and keys inside the item stay there (a work card would otherwise open its pop-up)
    item.addEventListener('click', swallow);
    item.addEventListener('keydown', swallowKey);
    const fields = itemFields(item);
    fields.forEach((node) => {
      node.contentEditable = 'plaintext-only';
      if (node.contentEditable !== 'plaintext-only') node.contentEditable = 'true';
      if (node.dataset.admBound) return;
      node.dataset.admBound = '1';
      node.addEventListener('paste', pastePlainText);
      node.addEventListener('input', onInlineInput);
      node.addEventListener('keydown', onInlineKey);
    });
    const part = item.dataset.part;
    const entry = /^(work|experience|toolkit)\.(\d+)$/.exec(item.dataset.editItem || '');
    item.appendChild(h('div', { class: 'adm-inline-bar' },
      h('button', { class: 'adm-btn adm-btn-primary', type: 'button', text: 'Done', onclick: stopInline }),
      h('button', {
        class: 'adm-btn',
        type: 'button',
        text: 'More…',
        title: 'All options for this item in the admin panel',
        onclick: () => {
          const path = item.dataset.editItem;
          stopInline();
          editFromPage(path);
        },
      }),
      part ? h('button', {
        class: 'adm-btn',
        type: 'button',
        text: 'Hide',
        title: 'Take this off the page (bring it back with the eye or its tick in the Page tab)',
        onclick: () => {
          stopInline();
          state.draft.hidden[part] = true;
          rerenderTab();
        },
      }) : null,
      entry ? h('button', {
        class: 'adm-btn adm-btn-danger',
        type: 'button',
        text: 'Delete',
        title: 'Delete this entry',
        onclick: () => {
          if (!confirm('Delete this entry? This can\u2019t be undone after saving.')) return;
          stopInline();
          state.draft[entry[1]].splice(Number(entry[2]), 1);
          if (entry[1] === 'work') state.openItem = null;
          rerenderTab();
        },
      }) : null));
    placeCaretAtEnd(fields[0]);
  }

  function stopInline() {
    if (!activeItem) return;
    const item = activeItem;
    activeItem = null;
    item.classList.remove('adm-active');
    item.removeEventListener('click', swallow);
    item.removeEventListener('keydown', swallowKey);
    itemFields(item).forEach((node) => node.removeAttribute('contenteditable'));
    const bar = item.querySelector(':scope > .adm-inline-bar');
    if (bar) bar.remove();
    if (document.activeElement && item.contains(document.activeElement)) document.activeElement.blur();
    changed();
  }

  const swallow = (e) => e.stopPropagation();
  const swallowKey = (e) => { if (!(e.ctrlKey && e.altKey)) e.stopPropagation(); }; // let the admin shortcut through

  function placeCaretAtEnd(node) {
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // Clicking elsewhere on the page finishes editing (clicks in the panel don't, so you can check the form)
  document.addEventListener('pointerdown', (e) => {
    if (activeItem && !activeItem.contains(e.target) && !e.target.closest('.adm-root, .adm-edge')) stopInline();
  }, true);

  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const parent = keys.reduce((node, key, i) => {
      if (node[key] == null) node[key] = /^\d+$/.test(keys[i + 1] || last) ? [] : {};
      return node[key];
    }, obj);
    parent[last] = value;
  }

  // "work.2.title" in English, or work[2].i18n.nl.title while editing Dutch:
  // the translation sits on the nearest object the field belongs to
  function setField(path, value) {
    const keys = path.split('.');
    if (!translating(keys.filter((k) => !/^\d+$/.test(k)).pop())) {
      setPath(state.draft, path, value);
      return;
    }
    let owner = state.draft;
    let rest = keys;
    keys.reduce((node, key, i) => {
      const next = node[key];
      if (next && typeof next === 'object' && !Array.isArray(next) && i < keys.length - 1) {
        owner = next;
        rest = keys.slice(i + 1);
      }
      return next;
    }, state.draft);
    setPath(translationOf(owner), rest.join('.'), value);
  }

  function onInlineInput(e) {
    const value = e.currentTarget.textContent.replace(/ /g, ' ').replace(/\n/g, ' ');
    setField(e.currentTarget.dataset.field, value);
    syncPanel();
    updateStatus();
  }

  function onInlineKey(e) {
    // Stop here rather than at the item: Enter ends editing (removing the item's guard) and must not reach the card
    swallowKey(e);
    // Every field is a single line or paragraph, so Enter (and Esc) finish editing
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      stopInline();
    }
  }

  function pastePlainText(e) {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  }

  // Copy what's typed on the page into the open panel form, without rebuilding it (which would steal focus)
  function syncPanel() {
    if (!screen) return;
    screen.querySelectorAll('.adm-bound').forEach((node) => {
      const { obj, key, fallback, format } = node._bind;
      const value = obj[key];
      if (node.matches('input, textarea')) {
        if (node !== document.activeElement) node.value = format ? format() : Array.isArray(value) ? value.join(', ') : value || '';
      } else {
        node.textContent = value || fallback || '';
      }
    });
  }

  // Pencil or More…: open the matching tab and form, and bring it into view
  // Pencil or More…: open the section's row in the Page tab (links: the Site tab) and bring it into view
  const ROW_FOR = { hero: 'hero', about: 'about', photo: 'about', reel: 'reel', experience: 'experience', toolkit: 'toolkit' };

  function editFromPage(path) {
    const c = state.draft;
    const [section, index] = path.split('.');
    let row = null;
    state.tab = 'page';
    if (section === 'links') state.tab = 'site';
    else if (section === 'intros') row = index;
    else if (section === 'work') { row = gridForProject(Number(index)); state.openItem = Number(index); }
    else if (section === 'customSections') row = (c.customSections[Number(index)] || {}).id;
    else if (section === 'workGrids') row = (c.workGrids[Number(index)] || {}).id;
    else row = ROW_FOR[section] || null;
    if (row) state.openRow = row;
    restore();
    if (!state.token) return; // locked: the tab opens after unlocking
    showEditor();
    const open = screen.querySelector(`.adm-outline-row[data-row="${row}"]`);
    const target = state.tab === 'site' ? screen.querySelector('[data-adm-section="links"]')
      : section === 'work' ? screen.querySelector('.adm-row-body .adm-entry.is-open')
        : (section === 'experience' || section === 'toolkit') && index != null && open ? open.querySelectorAll('.adm-row-body .adm-entry')[Number(index)]
          : section === 'photo' ? screen.querySelector('[data-adm-section="photo"]')
            : open;
    if (!target) return;
    target.scrollIntoView({ block: 'start' });
    target.classList.add('adm-flash');
    setTimeout(() => target.classList.remove('adm-flash'), 1200);
    const first = target.querySelector('.adm-row-body input, .adm-row-body textarea, .adm-row-body select') || target.querySelector('input, textarea, select');
    if (first) first.focus({ preventScroll: true });
  }

  // ---------- Files ----------
  // Returns the repo path the file will be saved to, or null if it was refused
  function stageFile(file, path) {
    if (file.size > MAX_BYTES) {
      alert(`${file.name} is ${(file.size / MB).toFixed(0)} MB. The limit here is ${MAX_BYTES / MB} MB.\n\nUpload big videos to YouTube and paste the link instead, or compress the file first.`);
      return null;
    }
    if (file.size > WARN_BYTES && !confirm(`${file.name} is ${(file.size / MB).toFixed(0)} MB. Large files load slowly for visitors and make the repo heavy. A YouTube link is usually better.\n\nUpload it anyway?`)) {
      return null;
    }
    const old = window.SITE_ASSET_OVERRIDES[path];
    if (old) URL.revokeObjectURL(old);
    state.pending.set(path, file);
    window.SITE_ASSET_OVERRIDES[path] = URL.createObjectURL(file);
    return path;
  }

  function clearPending() {
    Object.values(window.SITE_ASSET_OVERRIDES).forEach((url) => URL.revokeObjectURL(url));
    window.SITE_ASSET_OVERRIDES = {};
    state.pending.clear();
  }

  // ---------- Panel shell ----------
  let root = null;
  let screen = null;
  let statusEl = null;
  let edgeTab = null;
  let idleTimer = 0;

  function ensureRoot() {
    if (root) return;
    root = h('aside', { class: 'adm-root', 'aria-label': 'Site admin', hidden: true });
    screen = h('div', { class: 'adm-screen' });
    root.appendChild(screen);
    ['keydown', 'pointerdown', 'input'].forEach((type) => root.addEventListener(type, resetIdle));
    root.addEventListener('pointerdown', startDrag);
    // Shown on the right edge while the panel is minimised; the dot means unsaved changes
    edgeTab = h('button', { class: 'adm-edge', type: 'button', hidden: true, 'aria-label': 'Show admin panel', onclick: restore },
      h('span', { text: 'Admin' }),
      h('span', { class: 'adm-edge-dot', hidden: true }));
    document.body.append(root, edgeTab);
    // A detached window keeps the size it's resized to
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => {
        if (windowState.mode !== 'floating' || root.hidden || isMinimised()) return;
        windowState.w = root.offsetWidth;
        windowState.h = root.offsetHeight;
        saveWindowState();
      }).observe(root);
    }
    applyWindowMode();
  }

  // ---------- Window mode: docked on the right, detached (drag and resize), or full screen ----------
  // Remembered in this browser only.
  const WINDOW_KEY = 'am-admin-window';
  const windowState = (() => {
    const fallback = { mode: 'docked', x: null, y: 40, w: 480, h: Math.round(window.innerHeight * 0.8) };
    try { return { ...fallback, ...JSON.parse(localStorage.getItem(WINDOW_KEY) || '{}') }; } catch { return fallback; }
  })();

  function saveWindowState() {
    try { localStorage.setItem(WINDOW_KEY, JSON.stringify(windowState)); } catch { /* storage blocked */ }
  }

  function setWindowMode(mode) {
    windowState.mode = windowState.mode === mode ? 'docked' : mode;
    saveWindowState();
    applyWindowMode();
  }

  // Keeps at least the title bar on screen, so the window can always be dragged back
  function placeFloating(x, y) {
    const w = Math.min(windowState.w, window.innerWidth);
    windowState.x = Math.min(Math.max(x, 80 - w), window.innerWidth - 80);
    windowState.y = Math.min(Math.max(y, 0), window.innerHeight - 48);
    root.style.left = `${windowState.x}px`;
    root.style.top = `${windowState.y}px`;
  }

  function applyWindowMode() {
    if (!root) return;
    const { mode } = windowState;
    root.classList.toggle('adm-root--floating', mode === 'floating');
    root.classList.toggle('adm-root--full', mode === 'full');
    root.style.cssText = '';
    if (mode === 'floating') {
      root.style.width = `${Math.min(Math.max(windowState.w, 320), window.innerWidth)}px`;
      root.style.height = `${Math.min(Math.max(windowState.h, 240), window.innerHeight)}px`;
      placeFloating(windowState.x == null ? window.innerWidth - windowState.w - 40 : windowState.x, windowState.y);
    }
    labelWindowButtons();
  }

  function labelWindowButtons() {
    const { mode } = windowState;
    root.querySelectorAll('.adm-win-phone').forEach((btn) => {
      btn.innerHTML = PHONE_ICON;
      btn.title = phone ? 'Close the phone preview' : 'Phone preview: see the page at phone width';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', String(Boolean(phone)));
    });
    placePhone();
    root.querySelectorAll('.adm-win-float').forEach((btn) => {
      const on = mode === 'floating';
      btn.textContent = on ? '⇥' : '⧉';
      btn.title = on ? 'Dock to the side' : 'Detach into a window you can move and resize';
      btn.setAttribute('aria-label', btn.title);
    });
    root.querySelectorAll('.adm-win-full').forEach((btn) => {
      const on = mode === 'full';
      btn.textContent = on ? '⤡' : '⤢';
      btn.title = on ? 'Exit full screen' : 'Full screen';
      btn.setAttribute('aria-label', btn.title);
    });
  }

  function windowButtons() {
    return [
      h('button', { class: 'adm-close adm-win-phone', type: 'button', onclick: togglePhone }),
      h('button', { class: 'adm-close adm-win-float', type: 'button', onclick: () => setWindowMode('floating') }),
      h('button', { class: 'adm-close adm-win-full', type: 'button', onclick: () => setWindowMode('full') }),
    ];
  }

  // Detached: drag the window by its title bar
  function startDrag(e) {
    if (windowState.mode !== 'floating' || e.button !== 0) return;
    if (!e.target.closest('.adm-top, .adm-card-head') || e.target.closest('button, input, select, textarea, a')) return;
    e.preventDefault();
    const box = root.getBoundingClientRect();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    root.classList.add('is-dragging');
    const move = (ev) => placeFloating(ev.clientX - dx, ev.clientY - dy);
    const end = () => {
      root.classList.remove('is-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      saveWindowState();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  // A smaller browser window shouldn't leave the detached panel off screen
  window.addEventListener('resize', () => { if (root && windowState.mode === 'floating') applyWindowMode(); });

  // Minimising keeps the token, draft and unsaved changes; it only slides the panel out of the way
  function minimise() {
    root.classList.add('is-min');
    setTimeout(placePhone);
    root.inert = true;
    edgeTab.hidden = false;
    updateEdgeTab();
    edgeTab.focus();
  }

  function restore() {
    root.classList.remove('is-min');
    setTimeout(placePhone);
    root.inert = false;
    edgeTab.hidden = true;
  }

  const isMinimised = () => root && root.classList.contains('is-min');

  function updateEdgeTab() {
    if (!edgeTab) return;
    const dirty = isDirty();
    edgeTab.lastChild.hidden = !dirty;
    edgeTab.title = dirty ? 'Admin: unsaved changes' : 'Admin';
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    if (state.token) idleTimer = setTimeout(lock, IDLE_LOCK_MS);
  }

  function lock() {
    state.token = null;
    clearTimeout(idleTimer);
    if (root && !root.hidden) showUnlock('Locked after 30 minutes idle. Unsaved changes are kept.');
  }

  function open() {
    ensureRoot();
    root.hidden = false;
    if (!window.crypto || !crypto.subtle) {
      setScreen(h('div', { class: 'adm-card' },
        h('h2', { text: 'Admin unavailable' }),
        h('p', { text: 'This browser blocks encryption here. Open the site over https:// (or localhost) and try again.' }),
        h('button', { class: 'adm-btn', type: 'button', text: 'Close', onclick: close })));
      return;
    }
    state.store = loadStore();
    if (state.token && state.draft) showEditor();
    else if (state.store) showUnlock();
    else showSetup();
  }

  // Closing drops the token and the draft; reopening asks for the password and reloads from GitHub
  function close() {
    if (isDirty()) {
      if (!confirm('Discard your unsaved changes?')) return;
      clearPending();
    }
    if (state.draft && window.renderSite) window.renderSite(window.SITE_CONTENT || {});
    closePhone();
    undecoratePage();
    state.draft = null;
    state.token = null;
    clearTimeout(idleTimer);
    restore();
    root.hidden = true;
  }

  function toggle() {
    if (isMinimised()) restore();
    else if (root && !root.hidden) close();
    else open();
  }

  function setScreen(node) {
    screen.innerHTML = '';
    screen.appendChild(node);
    labelWindowButtons();
    const first = screen.querySelector('input, textarea, select');
    if (first) first.focus();
  }

  function errorLine() {
    return h('p', { class: 'adm-error', role: 'alert' });
  }

  // ---------- Setup (first time on a device) ----------
  function showSetup() {
    const repo = (state.store && state.store.repo) || defaultRepo();
    const err = errorLine();
    const token = h('input', { type: 'password', autocomplete: 'off', required: true, placeholder: 'github_pat_…' });
    const owner = h('input', { type: 'text', value: repo.owner, required: true });
    const repoName = h('input', { type: 'text', value: repo.repo, required: true });
    const branch = h('input', { type: 'text', value: repo.branch, required: true });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 10 });
    const pass2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
    const submit = h('button', { class: 'adm-btn adm-btn-primary', type: 'submit', text: 'Encrypt & save on this device' });

    const form = h('form', {
      class: 'adm-card',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (pass.value.length < 10) { err.textContent = 'Use a password of at least 10 characters.'; return; }
        if (pass.value !== pass2.value) { err.textContent = 'The passwords do not match.'; return; }
        submit.disabled = true;
        submit.textContent = 'Checking token…';
        const repoSettings = { owner: owner.value.trim(), repo: repoName.value.trim(), branch: branch.value.trim() };
        try {
          const info = await gh('', {}, token.value.trim(), repoSettings);
          if (!info) throw new Error('Repository not found, or the token cannot see it.');
          submit.textContent = 'Encrypting…';
          const secret = await encryptToken(token.value.trim(), pass.value);
          state.store = { repo: repoSettings, secret };
          saveStore(state.store);
          state.token = token.value.trim();
          token.value = pass.value = pass2.value = '';
          await afterUnlock();
        } catch (error) {
          err.textContent = error.message;
          submit.disabled = false;
          submit.textContent = 'Encrypt & save on this device';
        }
      },
    },
    h('div', { class: 'adm-card-head' }, h('h2', { text: 'Set up admin on this device' }), h('div', { class: 'adm-top-actions' }, windowButtons().slice(1), closeButton())),
    h('p', { class: 'adm-help' },
      'Do this once on each computer. Create a ',
      h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener', text: 'fine-grained GitHub token' }),
      ' with access to only this repository and the permission "Contents: Read and write". It is encrypted with your password before being stored in this browser.'),
    field('GitHub token', token),
    h('div', { class: 'adm-row3' }, field('Owner', owner), field('Repository', repoName), field('Branch', branch)),
    field('Password (10+ characters)', pass),
    field('Confirm password', pass2),
    err,
    submit);
    setScreen(form);
  }

  // ---------- Unlock ----------
  function showUnlock(message) {
    const err = errorLine();
    if (message) err.textContent = message;
    const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const submit = h('button', { class: 'adm-btn adm-btn-primary', type: 'submit', text: 'Unlock' });

    const form = h('form', {
      class: 'adm-card',
      onsubmit: async (e) => {
        e.preventDefault();
        const wait = state.cooldownUntil - Date.now();
        if (wait > 0) { err.textContent = `Too many wrong attempts. Try again in ${Math.ceil(wait / 1000)} s.`; return; }
        submit.disabled = true;
        submit.textContent = 'Unlocking…';
        try {
          state.token = await decryptToken(state.store.secret, pass.value);
          state.failedAttempts = 0;
        } catch {
          state.failedAttempts += 1;
          if (state.failedAttempts >= MAX_ATTEMPTS) {
            state.failedAttempts = 0;
            state.cooldownUntil = Date.now() + ATTEMPT_COOLDOWN_MS;
          }
          err.textContent = 'Wrong password.';
          pass.value = '';
          submit.disabled = false;
          submit.textContent = 'Unlock';
          pass.focus();
          return;
        }
        pass.value = '';
        try {
          await afterUnlock();
        } catch (error) {
          state.token = null;
          err.textContent = error.message;
          submit.disabled = false;
          submit.textContent = 'Unlock';
        }
      },
    },
    h('div', { class: 'adm-card-head' }, h('h2', { text: 'Admin' }), h('div', { class: 'adm-top-actions' }, windowButtons().slice(1), closeButton())),
    field('Password', pass),
    err,
    h('div', { class: 'adm-actions' },
      submit,
      h('button', {
        class: 'adm-link',
        type: 'button',
        text: 'Forget this device',
        onclick: () => {
          if (!confirm('Remove the encrypted token from this browser? You will need to set it up again here.')) return;
          clearStore();
          state.store = null;
          showSetup();
        },
      })));
    setScreen(form);
  }

  async function afterUnlock() {
    resetIdle();
    if (!state.draft) {
      await loadRemote();
      if (isCopy()) { showCopyNotice(); return; }
    }
    if (needsSetup()) showWizard(0);
    else showEditor();
  }

  // ---------- Setup wizard ----------
  // On a fresh copy (the name is still empty or "Your Name"), unlocking opens a few short steps instead of
  // the editor: name, look, top section, kinds of work, contact, languages. Everything changes the draft
  // with the page behind as a preview, so nothing is published until Save & publish. Can be run again
  // from the Site tab.
  const WIZARD_SKIP_KEY = 'am-admin-wizard-skipped';
  const PLACEHOLDER_NAME = 'Your Name';

  function needsSetup() {
    let skipped = false;
    try { skipped = sessionStorage.getItem(WIZARD_SKIP_KEY) === '1'; } catch { /* storage blocked */ }
    const name = state.draft.site.name.trim();
    return !skipped && (!name || name === PLACEHOLDER_NAME);
  }

  function leaveWizard(message) {
    try { sessionStorage.setItem(WIZARD_SKIP_KEY, '1'); } catch { /* storage blocked */ }
    state.tab = 'page';
    state.note = message || '';
    showEditor();
  }

  // Guesses an icon for a kind of work from its name
  const ICON_WORDS = [[/photo|foto|camera/i, 'camera'], [/design|graphic|grafisch|brand/i, 'palette'], [/illustr|draw|teken|art|kunst|paint/i, 'pen'],
    [/video|film|motion|anim/i, 'film'], [/music|muziek|audio|sound|geluid/i, 'music'], [/voice|stem|podcast/i, 'mic'], [/code|web|app|dev/i, 'code'],
    [/fashion|mode|textile|kleding/i, 'shirt'], [/3d|model|sculpt/i, 'cube'], [/writ|schrijf|text|tekst|copy/i, 'book'], [/picture|image|beeld/i, 'image']];
  const guessIcon = (name) => (ICON_WORDS.find(([pattern]) => pattern.test(name)) || [null, 'star'])[1];

  // "Photography, Design" → categories. A name that matches an existing category keeps it (and its
  // projects); otherwise the category in the same place is renamed, or a new one is made.
  function setCategoriesFromNames(text) {
    const c = state.draft;
    const names = text.split(',').map((n) => n.trim()).filter(Boolean);
    if (!names.length) return;
    const lower = names.map((n) => n.toLowerCase());
    const used = new Set();
    const next = names.map((name, i) => {
      let cat = c.categories.find((x) => !used.has(x.id) && (x.label || '').toLowerCase() === lower[i]);
      if (cat) cat = { ...cat, label: name };
      const inPlace = c.categories[i];
      if (!cat && inPlace && !used.has(inPlace.id) && !lower.includes((inPlace.label || '').toLowerCase())) cat = { ...inPlace, label: name, icon: guessIcon(name) };
      if (!cat) cat = { id: `cat-${Date.now().toString(36)}${i}`, label: name, icon: guessIcon(name), color: '' };
      used.add(cat.id);
      return cat;
    });
    c.work.forEach((item) => { if (!used.has(item.type)) item.type = next[0].id; });
    Object.values(c.sections).forEach((set) => { if (set && Array.isArray(set.categories)) set.categories = set.categories.filter((id) => used.has(id)); });
    c.categories = next;
  }

  function wizardChoice(options, current, onPick) {
    return h('div', { class: 'adm-wizard-choices' }, options.map(([value, title, desc]) => h('button', {
      class: `adm-wizard-choice${current === value ? ' is-active' : ''}`,
      type: 'button',
      'aria-pressed': String(current === value),
      onclick: () => onPick(value),
    }, h('strong', { text: title }), desc ? h('span', { text: desc }) : null)));
  }

  const WIZARD_STEPS = [
    {
      title: 'Who is this site for?',
      help: 'Your name goes at the top of the page, in the logo and on the browser tab.',
      body: () => {
        const c = state.draft;
        if (c.site.name.trim() === PLACEHOLDER_NAME) c.site.name = '';
        return h('div', { class: 'adm-form' },
          field('Your full name', text(c.site, 'name', { placeholder: 'e.g. Sam Janssens' })),
          field('What you do', text(c.hero, 'role', { placeholder: 'e.g. Photographer & designer' }), 'One short line under your name.'),
          field('A short introduction', area(c.hero, 'intro', 3), 'A sentence or two. You can change it any time.'));
      },
    },
    {
      title: 'Pick a look',
      help: 'A starting point for the colours. Every colour can be fine-tuned later in the Theme tab.',
      body: (step) => {
        const theme = state.draft.theme;
        const T = window.SiteTheme;
        const swatch = (color) => h('span', { class: 'adm-swatch', style: `background:${color}` });
        return h('div', { class: 'adm-form' },
          h('div', { class: 'adm-presets' }, Object.entries(T.presets).map(([key, preset]) => h('button', {
            class: `adm-preset${theme.preset === key ? ' is-active' : ''}`,
            type: 'button',
            'aria-pressed': String(theme.preset === key),
            onclick: () => { theme.preset = key; theme.colors = {}; changed(); showWizard(step); },
          }, h('span', { class: 'adm-swatches' }, swatch(preset.bg), swatch(preset.surface), swatch(preset.accent), swatch(preset.accent2)), h('span', { text: preset.name })))),
          h('div', { class: 'adm-row2' },
            field('Text font', h('select', { onchange: (e) => { theme.font = e.target.value; changed(); } },
              Object.keys(T.fonts).map((f) => h('option', { value: f, text: f, selected: theme.font === f })))),
            field('Heading font', h('select', { onchange: (e) => { theme.headingFont = e.target.value; changed(); } },
              h('option', { value: '', text: 'Same as the text', selected: !theme.headingFont }),
              Object.keys(T.fonts).map((f) => h('option', { value: f, text: f, selected: theme.headingFont === f }))))));
      },
    },
    {
      title: 'The top of your page',
      help: 'The first thing visitors see.',
      body: (step) => {
        const c = state.draft;
        const set = c.hero.layout;
        return h('div', { class: 'adm-form' },
          wizardChoice([
            ['centered', 'Centred', 'Your name and intro in the middle. Clean and simple.'],
            ['portrait', 'Portrait', 'A picture of you (or your work) beside your name.'],
            ['editor', 'Editing workspace', 'A preview screen and timeline playing your project videos. Best for video makers.'],
          ], set.style || 'editor', (value) => { set.style = value; changed(); showWizard(step); }),
          set.style === 'portrait' ? h('div', { class: 'adm-field' },
            h('span', { class: 'adm-label', text: 'Picture' }),
            currentFile(c.hero.portrait || c.about.photo),
            filePicker('image/*', (file) => {
              const path = stageFile(file, `assets/portrait-${Date.now().toString(36)}${extension(file)}`);
              if (path) { c.hero.portrait = path; changed(); showWizard(step); }
            }),
            h('span', { class: 'adm-hint', text: 'Taller than wide works best.' })) : null);
      },
    },
    {
      title: 'What kind of work do you make?',
      help: 'These become the categories of your projects, and the filter buttons above them.',
      body: () => {
        const names = state.draft.categories.map((cat) => cat.label).filter(Boolean).join(', ');
        const preview = h('div', { class: 'adm-wizard-tags' });
        const showTags = () => {
          preview.innerHTML = '';
          state.draft.categories.forEach((cat) => preview.appendChild(h('span', { class: 'adm-badge', text: cat.label })));
        };
        showTags();
        return h('div', { class: 'adm-form' },
          field('Kinds of work, separated by commas', h('input', {
            type: 'text',
            value: names,
            placeholder: 'e.g. Photography, Graphic design, Illustration',
            onchange: (e) => { setCategoriesFromNames(e.target.value); showTags(); changed(); },
          })),
          preview,
          h('p', { class: 'adm-hint', text: 'Add your projects afterwards in the Work section of the Page tab: a title, a short description, pictures or videos.' }));
      },
    },
    {
      title: 'How can people reach you?',
      help: 'Your email is used by the contact form. Links you fill in get an icon in the contact section.',
      body: () => {
        const links = state.draft.links;
        return h('div', { class: 'adm-form' },
          field('Email address', text(links, 'email', { type: 'email', placeholder: 'you@example.com' })),
          h('div', { class: 'adm-row2' },
            field('Instagram', text(links, 'instagram', { type: 'url', placeholder: 'https://instagram.com/…' })),
            field('LinkedIn', text(links, 'linkedin', { type: 'url', placeholder: 'https://linkedin.com/in/…' }))),
          h('p', { class: 'adm-hint', text: 'TikTok, Behance, Pinterest and 15 more are in the Site tab.' }));
      },
    },
    {
      title: 'Which languages?',
      help: 'The main language is the one you write in. Visitors can switch to the others, and you translate your text in the panel.',
      body: (step) => {
        const L = state.draft.languages;
        const names = window.LANGUAGE_NAMES || {};
        const common = [...new Set([L.main, 'en', 'nl', 'fr', 'de', 'es'])];
        return h('div', { class: 'adm-form' },
          field('Main language', h('select', {
            onchange: (e) => {
              L.main = e.target.value;
              L.available = [...new Set([L.main, ...L.available])];
              renderPage(state.draft);
              showWizard(step);
            },
          }, Object.entries(names).map(([code, label]) => h('option', { value: code, text: label, selected: code === L.main })))),
          h('span', { class: 'adm-label', text: 'Also offer' }),
          h('div', { class: 'adm-checks' }, common.filter((code) => code !== L.main).map((code) => h('label', { class: 'adm-check' },
            h('input', {
              type: 'checkbox',
              checked: L.available.includes(code),
              onchange: (e) => {
                L.available = e.target.checked ? [...L.available, code] : L.available.filter((c) => c !== code);
                renderPage(state.draft);
              },
            }),
            h('span', { text: names[code] })))),
          h('p', { class: 'adm-hint', text: 'Only the main language? Then there’s no language switch. More languages are in the Site tab.' }));
      },
    },
    {
      title: 'All set',
      help: 'The page behind shows your site. Nothing is published yet.',
      body: () => h('div', { class: 'adm-form' },
        h('ul', { class: 'adm-wizard-next' },
          h('li', { text: 'Page tab: add your projects in the Work section, write your About text, add a photo, and add or reorder sections.' }),
          h('li', { text: 'Phone button at the top: see the page at phone width.' }),
          h('li', { text: 'Save & publish puts it all online; the live site updates within a minute or two.' }))),
    },
  ];

  function showWizard(step = 0) {
    const last = WIZARD_STEPS.length - 1;
    const current = WIZARD_STEPS[step];
    setScreen(h('div', { class: 'adm-card adm-wizard' },
      h('div', { class: 'adm-card-head' }, h('h2', { text: 'Set up your site' }), h('div', { class: 'adm-top-actions' }, windowButtons(), closeButton())),
      h('div', { class: 'adm-wizard-progress', 'aria-hidden': 'true' }, WIZARD_STEPS.map((s, i) => h('span', { class: i < step ? 'is-done' : i === step ? 'is-current' : '' }))),
      h('p', { class: 'adm-hint', text: `Step ${step + 1} of ${WIZARD_STEPS.length}` }),
      h('h3', { class: 'adm-wizard-title', text: current.title }),
      h('p', { class: 'adm-help', text: current.help }),
      current.body(step),
      h('div', { class: 'adm-actions' },
        step > 0
          ? h('button', { class: 'adm-btn', type: 'button', text: 'Back', onclick: () => showWizard(step - 1) })
          : h('button', { class: 'adm-link', type: 'button', text: 'Skip setup', onclick: () => leaveWizard() }),
        step < last
          ? h('div', { class: 'adm-inline' },
            step > 0 ? h('button', { class: 'adm-link', type: 'button', text: 'Skip the rest', onclick: () => leaveWizard() }) : null,
            h('button', { class: 'adm-btn adm-btn-primary', type: 'button', text: 'Next', onclick: () => showWizard(step + 1) }))
          : h('button', { class: 'adm-btn adm-btn-primary', type: 'button', text: 'Go to the editor', onclick: () => leaveWizard('Setup done. Check the page, then Save & publish.') }))));
    // The panel opens at the top of each step
    root.scrollTop = 0;
  }


  // Edit the version on GitHub (not the possibly stale page), so PC and laptop stay in sync
  async function loadRemote() {
    const file = await getFile(CONTENT_PATH);
    if (file && file.content) {
      state.draft = normalize(parseContent(b64ToText(file.content)));
      state.remoteSha = file.sha;
      state.note = '';
    } else {
      state.draft = normalize(clone(window.SITE_CONTENT || {}));
      state.remoteSha = null;
      state.note = `${CONTENT_PATH} isn't on GitHub yet. Your first save creates it.`;
    }
    // Content that doesn't say which repository it belongs to yet: this one
    if (!state.draft.site.repo.owner || !state.draft.site.repo.repo) claimRepo();
    state.savedJson = snapshot();
    renderPage(state.draft);
  }

  // ---------- A copy of someone else's site ----------
  // The content remembers which repository it belongs to (Site tab). When the panel is connected to a
  // different one, the site has been copied (cloned, downloaded, forked or made from a template): offer
  // to start from the empty starter content, then run the setup wizard. Nothing is published until saving.
  const STARTER_PATH = 'starter/site.js';
  const sameRepo = (a, b) => `${a.owner}/${a.repo}`.toLowerCase() === `${b.owner}/${b.repo}`.toLowerCase();

  function isCopy() {
    const own = state.draft.site.repo;
    return Boolean(own.owner && own.repo && !sameRepo(own, state.store.repo));
  }

  // The connected repository becomes the site's own (saved with the next save)
  function claimRepo() {
    const { owner, repo, branch } = state.store.repo;
    state.draft.site.repo = { owner, repo, branch };
  }

  async function startFresh() {
    const response = await fetch(`${STARTER_PATH}?${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${STARTER_PATH} wasn't found, so there's no empty content to start from.`);
    state.draft = normalize(parseContent(await response.text()));
    claimRepo();
    // After the first save, offer to delete the previous owner's files that nothing uses any more
    state.offerCleanup = true;
    try { sessionStorage.removeItem(WIZARD_SKIP_KEY); } catch { /* storage blocked */ }
    renderPage(state.draft);
  }

  function showCopyNotice() {
    const err = errorLine();
    const own = state.draft.site.repo;
    const name = state.draft.site.name.trim();
    const fresh = h('button', {
      class: 'adm-btn adm-btn-primary',
      type: 'button',
      text: 'Start with an empty site',
      onclick: async () => {
        fresh.disabled = true;
        try {
          await startFresh();
          showWizard(0);
        } catch (error) {
          err.textContent = error.message;
          fresh.disabled = false;
        }
      },
    });
    setScreen(h('div', { class: 'adm-card' },
      h('div', { class: 'adm-card-head' }, h('h2', { text: 'Your own copy' }), h('div', { class: 'adm-top-actions' }, windowButtons().slice(1), closeButton())),
      h('p', { text: `This site was copied from ${own.owner}/${own.repo}${name ? ` and still shows ${name}’s content` : ''}.` }),
      h('p', { class: 'adm-help', text: 'Start with an empty site to make it yours: the design and all features stay, the text, projects and pictures are cleared, and a few short steps help you fill it in. Nothing changes on the live site until you save.' }),
      err,
      h('div', { class: 'adm-actions' },
        h('button', {
          class: 'adm-link',
          type: 'button',
          text: 'Keep this content',
          title: 'Edit the copied content as it is',
          onclick: () => {
            claimRepo();
            if (needsSetup()) showWizard(0);
            else showEditor();
          },
        }),
        fresh)));
  }

  // ---------- Unused files ----------
  // Files in assets/ that the content doesn't point to (e.g. the previous owner's videos and photos
  // after starting fresh). Listed with sizes and ticks; the ticked ones are deleted in one commit.
  async function findUnusedFiles() {
    const branch = encodeURIComponent(state.store.repo.branch);
    const tree = await gh(`/git/trees/${branch}?recursive=1`);
    if (!tree) throw new Error('Could not read the repository’s files.');
    const used = referencedPaths(state.draft);
    return tree.tree.filter((f) => f.type === 'blob' && f.path.startsWith('assets/') && !used.has(f.path));
  }

  // Writes several files in one commit: entries = [{ path, contentB64 }] to add or replace, [{ path, remove: true }] to delete
  async function commitFiles(entries, message) {
    const branch = encodeURIComponent(state.store.repo.branch);
    const ref = await gh(`/git/ref/heads/${branch}`);
    const head = await gh(`/git/commits/${ref.object.sha}`);
    const tree = [];
    for (const entry of entries) {
      if (entry.remove) {
        tree.push({ path: entry.path, mode: '100644', type: 'blob', sha: null });
      } else {
        const blob = await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: entry.contentB64, encoding: 'base64' }) });
        tree.push({ path: entry.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
    }
    const newTree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree }) });
    const commit = await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [head.sha] }) });
    await gh(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
  }

  const deleteFiles = (paths) => commitFiles(paths.map((path) => ({ path, remove: true })), `Admin: delete ${paths.length} unused file(s)`);

  // ---------- Updates from portfolio-kit ----------
  // kit.json says where the kit lives ("kit"), which site publishes it ("source"), which files are code
  // ("files") and, in a kit copy, its build number and change notes. "Update" copies only those code files
  // from the kit into this site's repository, in one commit: content, uploads and translations stay, and
  // index.html gets this site's title, icon and theme written back into it.
  const KIT_MANIFEST = 'kit.json';
  const repoFrom = (text) => {
    const [owner, repo] = String(text || '').split('/');
    return owner && repo ? { owner, repo, branch: 'main' } : null;
  };
  const readJsonFile = (file) => (file && file.content ? JSON.parse(b64ToText(file.content)) : null);

  async function checkForUpdates() {
    const installed = readJsonFile(await getFile(KIT_MANIFEST)) || {};
    const kitRepo = repoFrom(installed.kit);
    if (!kitRepo) return { status: 'unknown' };
    const source = repoFrom(installed.source);
    if (source && sameRepo(source, state.store.repo)) return { status: 'source', kitRepo };
    const latest = readJsonFile(await gh(`/contents/${KIT_MANIFEST}?ref=main`, {}, state.token, kitRepo));
    if (!latest) return { status: 'unreachable', kitRepo };
    const have = Number(installed.build) || 0;
    const notes = (latest.notes || []).filter((n) => Number(n.build) > have);
    return { status: Number(latest.build) > have ? 'available' : 'current', kitRepo, installed, latest, notes };
  }

  async function installUpdate(kitRepo, latest, progress) {
    const files = [...new Set([...(latest.files || []), KIT_MANIFEST])].filter((path) => path !== CONTENT_PATH);
    const saved = JSON.parse(state.savedJson);
    const entries = [];
    for (let i = 0; i < files.length; i++) {
      progress(`Downloading ${files[i]} (${i + 1}/${files.length})\u2026`);
      const file = await gh(`/contents/${encodePath(files[i])}?ref=main`, {}, state.token, kitRepo);
      if (!file || typeof file.content !== 'string') continue;
      let contentB64 = file.content.replace(/\s/g, '');
      // The kit's index.html is neutral: put this site's name, title, icon and theme back in
      if (files[i] === INDEX_PATH && saved.site && saved.site.name.trim()) contentB64 = textToB64(withSiteDetails(b64ToText(contentB64), saved));
      entries.push({ path: files[i], contentB64 });
    }
    progress('Installing\u2026');
    await commitFiles(entries, `Admin: update to portfolio-kit version ${latest.build}`);
  }

  function updatesBox() {
    const body = h('div', { class: 'adm-form' });
    const show = (...nodes) => { body.innerHTML = ''; nodes.flat().filter(Boolean).forEach((n) => body.appendChild(n)); };
    const versionText = (manifest) => `version ${manifest.build}${manifest.date ? ` (${manifest.date})` : ''}`;
    const check = h('button', {
      class: 'adm-btn',
      type: 'button',
      text: 'Check for updates',
      onclick: async () => {
        show(h('p', { class: 'adm-hint', text: 'Checking\u2026' }));
        let result;
        try {
          result = await checkForUpdates();
        } catch (error) {
          show(h('p', { class: 'adm-error', text: error.message }), check);
          return;
        }
        if (result.status === 'unknown') {
          show(h('p', { class: 'adm-hint', text: `This site has no ${KIT_MANIFEST}, so it doesn\u2019t know where updates come from.` }));
        } else if (result.status === 'source') {
          show(h('p', { class: 'adm-hint', text: `This site is where ${result.kitRepo.owner}/${result.kitRepo.repo} comes from: code you push to main is published there automatically.` }));
        } else if (result.status === 'unreachable') {
          show(h('p', { class: 'adm-error', text: `Couldn\u2019t read ${result.kitRepo.owner}/${result.kitRepo.repo}. Is it public?` }), check);
        } else if (result.status === 'current') {
          show(h('p', { class: 'adm-hint', text: `Up to date: ${versionText(result.latest)}.` }), check);
        } else {
          const err = errorLine();
          const status = h('p', { class: 'adm-hint' });
          const install = h('button', {
            class: 'adm-btn adm-btn-primary',
            type: 'button',
            text: `Update to version ${result.latest.build}`,
            onclick: async () => {
              if (isDirty() && !confirm('You have unsaved changes. The update doesn\u2019t touch them, but save them afterwards. Continue?')) return;
              install.disabled = true;
              try {
                await installUpdate(result.kitRepo, result.latest, (text) => { status.textContent = text; });
                show(h('p', { class: 'adm-status is-ok', text: `Updated to version ${result.latest.build}. The live site updates in a minute or two; reload the page then to use the new version of this panel too.` }));
              } catch (error) {
                err.textContent = error.message;
                status.textContent = '';
                install.disabled = false;
              }
            },
          });
          show(
            h('p', { text: `Version ${result.latest.build} is available${result.installed.build ? ` (you have version ${result.installed.build})` : ''}.` }),
            result.notes.length ? h('ul', { class: 'adm-notes' }, result.notes.map((n) => h('li', null, h('strong', { text: `${n.build}` }), ` ${n.message}`))) : null,
            h('p', { class: 'adm-hint', text: 'Updating replaces the site\u2019s code with the new version. Your content, pictures, files and translations stay as they are.' }),
            status, err, install);
        }
      },
    });
    show(h('p', { class: 'adm-hint', text: 'New features and fixes for the site\u2019s design and this panel.' }), check);
    return h('div', { class: 'adm-form adm-group-box', 'data-adm-section': 'updates' }, h('h3', { class: 'adm-group', text: 'Updates' }), body);
  }

  const formatSize = (bytes) => (bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

  async function showCleanup(intro) {
    setScreen(h('div', { class: 'adm-card' }, h('h2', { text: 'Unused files' }), h('p', { class: 'adm-help', text: 'Looking through the repository…' })));
    let files;
    try {
      files = await findUnusedFiles();
    } catch (error) {
      state.note = error.message;
      showEditor();
      return;
    }
    if (!files.length) {
      state.note = 'No unused files: everything in assets/ is used by the site.';
      showEditor();
      return;
    }
    const picked = new Set(files.map((f) => f.path));
    const total = h('span', { class: 'adm-hint' });
    const updateTotal = () => {
      const bytes = files.filter((f) => picked.has(f.path)).reduce((sum, f) => sum + (f.size || 0), 0);
      total.textContent = `${picked.size} of ${files.length} selected (${formatSize(bytes)})`;
    };
    updateTotal();
    const err = errorLine();
    const del = h('button', {
      class: 'adm-btn adm-btn-danger',
      type: 'button',
      text: 'Delete selected',
      onclick: async () => {
        if (!picked.size) return;
        if (!confirm(`Delete ${picked.size} file(s) from the repository? They stay in GitHub’s history, but they’re gone from the site.`)) return;
        del.disabled = true;
        del.textContent = 'Deleting…';
        try {
          await deleteFiles([...picked]);
          state.note = `Deleted ${picked.size} unused file(s).`;
          showEditor();
        } catch (error) {
          err.textContent = error.message;
          del.disabled = false;
          del.textContent = 'Delete selected';
        }
      },
    });
    setScreen(h('div', { class: 'adm-card' },
      h('div', { class: 'adm-card-head' }, h('h2', { text: 'Unused files' }), h('div', { class: 'adm-top-actions' }, closeButton())),
      h('p', { class: 'adm-help', text: intro || 'These files are in the repository but nothing on the site uses them. Deleting them keeps the site light.' }),
      h('div', { class: 'adm-files' }, files.map((f) => h('label', { class: 'adm-check' },
        h('input', {
          type: 'checkbox',
          checked: true,
          onchange: (e) => { if (e.target.checked) picked.add(f.path); else picked.delete(f.path); updateTotal(); },
        }),
        h('span', { class: 'adm-path', text: f.path }),
        h('span', { class: 'adm-hint', text: formatSize(f.size || 0) })))),
      total,
      err,
      h('div', { class: 'adm-actions' },
        h('button', { class: 'adm-link', type: 'button', text: 'Keep them', onclick: () => showEditor() }),
        del)));
  }

  // ---------- Editor ----------
  const TABS = [
    ['page', 'Page'],
    ['site', 'Site'],
    ['theme', 'Theme'],
  ];

  function showEditor() {
    statusEl = h('p', { class: 'adm-status', 'aria-live': 'polite' });
    const saveBtn = h('button', { class: 'adm-btn adm-btn-primary', type: 'button', text: 'Save & publish', onclick: save });
    const body = h('div', { class: 'adm-body' });
    const tabs = h('div', { class: 'adm-tabs', role: 'tablist' }, TABS.map(([id, label]) => h('button', {
      class: `adm-tab${state.tab === id ? ' is-active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': String(state.tab === id),
      text: label,
      onclick: () => { state.tab = id; showEditor(); },
    })));

    const panel = h('div', { class: 'adm-editor' },
      h('div', { class: 'adm-top' },
        h('h2', { text: 'Admin' }),
        h('div', { class: 'adm-top-actions' },
          saveBtn,
          h('button', { class: 'adm-btn', type: 'button', text: 'Lock', onclick: () => { state.token = null; showUnlock('Locked. Unsaved changes are kept.'); } }),
          windowButtons(),
          h('button', { class: 'adm-close', type: 'button', 'aria-label': 'Minimise admin', title: 'Minimise', text: '–', onclick: minimise }),
          closeButton())),
      statusEl,
      languagePicker(),
      tabs,
      body);
    panel.saveBtn = saveBtn;
    screen.innerHTML = '';
    screen.appendChild(panel);
    labelWindowButtons();
    renderTab(body);
    updateStatus();
  }

  function rerenderTab() {
    const body = screen.querySelector('.adm-body');
    if (body) renderTab(body);
    changed();
  }

  function renderTab(body) {
    body.innerHTML = '';
    const views = { page: pageTab, site: siteTab, theme: themeTab };
    body.appendChild(views[state.tab]());
  }

  function updateStatus(message, kind) {
    updateEdgeTab();
    if (!statusEl) return;
    statusEl.className = `adm-status${kind ? ` is-${kind}` : ''}`;
    if (message) statusEl.textContent = message;
    else if (state.saving) return;
    else if (isDirty()) statusEl.textContent = `Unsaved changes${state.pending.size ? ` · ${state.pending.size} file(s) to upload` : ''}. The page behind shows a preview.`;
    else statusEl.textContent = state.note || 'Everything is saved.';
  }

  // ---------- Form helpers ----------
  function closeButton() {
    return h('button', { class: 'adm-close', type: 'button', 'aria-label': 'Close admin', text: '×', onclick: close });
  }

  function field(label, input, hint) {
    return h('label', { class: 'adm-field' }, h('span', { class: 'adm-label', text: label }), input, hint ? h('span', { class: 'adm-hint', text: hint }) : null);
  }

  // Remembers which value a form element shows, so text typed on the page can be copied in (see syncPanel)
  function bind(node, obj, key, fallback, format) {
    node._bind = { obj, key, fallback, format };
    node.classList.add('adm-bound');
    return node;
  }

  // In another language, text fields edit the translation and show the English as a grey hint
  function text(obj, key, attrs) {
    if (translating(key)) {
      const tr = translationOf(obj);
      return bind(h('input', { type: 'text', ...attrs, value: tr[key] || '', placeholder: obj[key] || (attrs && attrs.placeholder) || '', oninput: (e) => { tr[key] = e.target.value; changed(); } }), tr, key);
    }
    return bind(h('input', { type: 'text', value: obj[key] || '', ...attrs, oninput: (e) => { obj[key] = e.target.value; changed(); } }), obj, key);
  }

  function area(obj, key, rows = 4) {
    if (translating(key)) {
      const tr = translationOf(obj);
      return bind(h('textarea', { rows, value: tr[key] || '', placeholder: obj[key] || '', oninput: (e) => { tr[key] = e.target.value; changed(); } }), tr, key);
    }
    return bind(h('textarea', { rows, value: obj[key] || '', oninput: (e) => { obj[key] = e.target.value; changed(); } }), obj, key);
  }

  function list(obj, key, attrs) {
    if (translating(key)) {
      // Translated item by item: shows the full list, and an item left as the English stays untranslated
      const tr = translationOf(obj);
      const english = () => obj[key] || [];
      const shown = () => english().map((en, i) => (tr[key] && tr[key][i]) || en).join(', ');
      return bind(h('input', {
        type: 'text',
        value: shown(),
        ...attrs,
        oninput: (e) => {
          tr[key] = e.target.value.split(',').map((item) => item.trim()).map((item, i) => (item === english()[i] ? '' : item));
          changed();
        },
      }), tr, key, null, shown);
    }
    return bind(h('input', { type: 'text', value: (obj[key] || []).join(', '), ...attrs, oninput: (e) => { obj[key] = splitList(e.target.value); changed(); } }), obj, key);
  }

  // Switches the whole site's language; the page and the forms follow (see site:languagechange below)
  function languagePicker() {
    const languages = (window.SiteI18n && window.SiteI18n.languages) || { en: 'English' };
    const current = lang();
    return h('div', { class: 'adm-lang' },
      field('Editing language', h('select', { onchange: (e) => window.SiteI18n.setLanguage(e.target.value) },
        Object.entries(languages).map(([code, name]) => h('option', { value: code, text: name, selected: code === current })))),
      current === mainLang() ? null : h('p', { class: 'adm-help', text: `Text you type now is saved as the ${languages[current]} translation. Leave a field empty to show the ${(window.LANGUAGE_NAMES || {})[mainLang()] || 'main language'} (the grey hint). Videos, images, links and the order of items are shared by all languages.` }));
  }

  // Bio paragraphs are a plain list, so their translations are moved and deleted alongside them
  function parallelLists(arr) {
    const about = state.draft.about;
    if (arr !== about.paragraphs || !about.i18n) return [];
    return Object.values(about.i18n).map((tr) => tr.paragraphs).filter(Array.isArray);
  }

  function iconBtn(label, title, onclick, disabled) {
    return h('button', { class: 'adm-icon', type: 'button', text: label, title, 'aria-label': title, disabled, onclick });
  }

  // Up / down / delete controls for any array of entries
  function rowControls(arr, index, what) {
    return h('div', { class: 'adm-row-controls' },
      iconBtn('↑', 'Move up', () => { move(arr, index, -1); }, index === 0),
      iconBtn('↓', 'Move down', () => { move(arr, index, 1); }, index === arr.length - 1),
      iconBtn('✕', `Delete ${what}`, () => {
        if (!confirm(`Delete this ${what}?`)) return;
        arr.splice(index, 1);
        parallelLists(arr).forEach((tr) => tr.splice(index, 1));
        if (arr === state.draft.work) state.openItem = null;
        rerenderTab();
      }));
  }

  function move(arr, index, dir) {
    const target = index + dir;
    [arr[index], arr[target]] = [arr[target], arr[index]];
    parallelLists(arr).forEach((tr) => { [tr[index], tr[target]] = [tr[target], tr[index]]; });
    if (arr === state.draft.work && state.openItem != null) {
      if (state.openItem === index) state.openItem = target;
      else if (state.openItem === target) state.openItem = index;
    }
    rerenderTab();
  }

  function filePicker(accept, onPick) {
    return h('input', {
      type: 'file',
      accept,
      onchange: (e) => {
        const file = e.target.files[0];
        if (file) onPick(file);
        e.target.value = '';
      },
    });
  }

  function currentFile(path) {
    if (!path) return h('span', { class: 'adm-hint', text: 'None' });
    return h('span', { class: 'adm-path' }, path, state.pending.has(path) ? h('em', { text: ' (new, uploads on save)' }) : null);
  }

  // ---------- Site tab ----------
  function siteTab() {
    const site = state.draft.site;
    const name = site.name.trim() || 'Your Name';
    return h('div', { class: 'adm-form' },
      h('div', { class: 'adm-section-head' },
        h('p', { class: 'adm-help', text: 'Who the site belongs to and where it links to. Your name shows in the top section, the logo, the footer and the browser tab.' }),
        h('div', { class: 'adm-inline' },
          h('button', { class: 'adm-btn', type: 'button', text: 'Run setup again', title: 'The first-time steps: name, look, top section, work, contact, languages', onclick: () => showWizard(0) }),
          h('button', { class: 'adm-btn', type: 'button', text: 'Find unused files', title: 'Files in assets/ that nothing on the site uses', onclick: () => showCleanup() }))),
      h('div', { class: 'adm-form adm-group-box', 'data-adm-section': 'site' },
        h('h3', { class: 'adm-group', text: 'You' }),
        h('div', { class: 'adm-row2' },
          field('Full name', text(site, 'name', { placeholder: 'e.g. Sam Janssens' })),
          field('Short name', text(site, 'shortName', { placeholder: name.split(/\s+/)[0] }), 'Used in the contact form note. Empty uses your first name.')),
        h('p', { class: 'adm-hint', text: 'The logo shows the first word of your name in the text colour and the rest in the accent colour.' })),
      h('div', { class: 'adm-form adm-group-box' },
        h('h3', { class: 'adm-group', text: 'Browser tab and link previews' }),
        field('Page title', text(site, 'title', { placeholder: `${name} Portfolio` }), 'Shown on the browser tab and when the link is shared.'),
        field('Description', area(site, 'description', 2), 'One sentence for search engines and link previews. Empty uses \u201C' + name + '\u2019s portfolio.\u201D'),
        faviconField(site, name),
        sharePreviewField(site, name)),
      languagesBox(),
      h('div', { class: 'adm-form adm-group-box' },
        h('h3', { class: 'adm-group', text: 'GitHub repository' }),
        h('p', { class: 'adm-hint', text: 'Where this site lives. Filled in for you when setting up the admin panel on a new computer.' }),
        h('div', { class: 'adm-row3' }, field('Owner', text(site.repo, 'owner')), field('Repository', text(site.repo, 'repo')), field('Branch', text(site.repo, 'branch')))),
      h('div', { class: 'adm-form adm-group-box' }, linksBox()),
      updatesBox(),
      h('div', { class: 'adm-form adm-group-box', 'data-adm-section': 'analytics' },
        h('h3', { class: 'adm-group', text: 'Analytics' }),
        field('Cloudflare Web Analytics token', text(state.draft.analytics, 'cloudflareToken', { placeholder: 'e.g. 1a2b3c4d…' }),
          'In Cloudflare: Web Analytics → Add a site → copy the "token" value from the snippet it shows. Empty turns analytics off.')));
  }

  // Browser-tab icon: letters in the theme colours, or an uploaded image
  function faviconField(site, name) {
    const src = site.favicon ? (window.SITE_ASSET_OVERRIDES[site.favicon] || site.favicon) : window.SiteTheme.favicon(site, state.draft.theme);
    return h('div', { class: 'adm-field' },
      h('span', { class: 'adm-label', text: 'Browser-tab icon' }),
      h('div', { class: 'adm-inline' },
        h('img', { class: 'adm-favicon', src, alt: '' }),
        site.favicon
          ? [currentFile(site.favicon), h('button', { class: 'adm-link', type: 'button', text: 'Use letters instead', onclick: () => { site.favicon = ''; rerenderTab(); } })]
          : text(site, 'initials', { placeholder: name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase(), maxLength: 3, onchange: () => rerenderTab() })),
      filePicker('image/png,image/svg+xml,image/x-icon,image/webp,.ico,.png,.svg,.webp', (file) => {
        const path = stageFile(file, `assets/favicon-${Date.now().toString(36)}${extension(file) || '.png'}`);
        if (path) { site.favicon = path; rerenderTab(); }
      }),
      h('span', { class: 'adm-hint', text: site.favicon
        ? 'Your own icon. A square image of at least 64 \u00D7 64 pixels works best.'
        : 'Up to three letters, drawn in your theme colours. Or upload your own icon: a square PNG or SVG (an .ico works too), at least 64 \u00D7 64 pixels.' }));
  }

  // The site's own address, for link previews: the Site tab's, else the address it's open on (live sites)
  function siteAddress(site) {
    const own = (site.url || '').trim();
    if (own) return own.replace(/\/?$/, '/');
    return window.location.protocol === 'https:' ? `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}` : '';
  }

  // The picture shown when the site's link is shared, with a mock-up of the preview
  function sharePreviewField(site, name) {
    const src = site.shareImage ? (window.SITE_ASSET_OVERRIDES[site.shareImage] || site.shareImage) : '';
    const address = siteAddress(site);
    let host = '';
    try { host = address ? new URL(address).host : ''; } catch { /* not a full address yet */ }
    return h('div', { class: 'adm-form' },
      h('div', { class: 'adm-field' },
        h('span', { class: 'adm-label', text: 'Link preview picture' }),
        h('div', { class: 'adm-share' },
          src ? h('img', { src, alt: '' }) : h('div', { class: 'adm-share-empty', text: 'No picture' }),
          h('div', { class: 'adm-share-text' },
            h('span', { class: 'adm-share-host', text: host || 'your-site' }),
            h('strong', { text: site.title.trim() || `${name} Portfolio` }),
            h('span', { text: site.description.trim() || `${name}\u2019s portfolio.` }))),
        h('div', { class: 'adm-inline' },
          site.shareImage ? currentFile(site.shareImage) : null,
          site.shareImage ? h('button', { class: 'adm-link', type: 'button', text: 'Remove', onclick: () => { site.shareImage = ''; rerenderTab(); } }) : null),
        filePicker('image/jpeg,image/png,image/webp', (file) => {
          const path = stageFile(file, `assets/share-${Date.now().toString(36)}${extension(file) || '.jpg'}`);
          if (path) { site.shareImage = path; rerenderTab(); }
        }),
        h('span', { class: 'adm-hint', text: 'Shown when someone shares your link (WhatsApp, LinkedIn, Facebook\u2026). Use a landscape picture of 1200 \u00D7 630 pixels, with the important part in the middle.' })),
      field('Site address', text(site, 'url', { type: 'url', placeholder: address || 'https://your-name.github.io/your-repo/', onchange: () => rerenderTab() }),
        'The full address of the live site. Link previews need it to find the picture. Empty uses the address the site is open on.'));
  }

  // ---------- Languages (Site tab) ----------
  // Which languages visitors can pick, which one the content is written in, and the interface text
  // (menu, buttons, form labels) in each. The built-in interface text is in js/i18n.js.
  const UI_GROUPS = { meta: 'Search description', lang: 'Language switch', nav: 'Menu', hero: 'Top section', about: 'About', reel: 'Showreel',
    work: 'Work', type: 'Category', experience: 'Experience', toolkit: 'Toolkit', contact: 'Contact' };

  // Changing languages rebuilds the page (the switch) and the panel (the editing-language picker)
  function languagesChanged() {
    renderPage(state.draft);
    showEditor();
  }

  function interfaceTextEditor(code) {
    const L = state.draft.languages;
    const ui = window.SITE_UI_TEXT || {};
    const own = L.ui[code] = L.ui[code] || {};
    return h('div', { class: 'adm-form' },
      h('p', { class: 'adm-hint', text: 'The fixed text around your content. Empty fields use the grey text. {name} and {first} stand for your name and short name; {n} is a number.' }),
      Object.keys(ui).map((key) => {
        const english = ui[key].en || key;
        const label = `${UI_GROUPS[key.split('.')[0]] || key}: ${english.length > 48 ? `${english.slice(0, 45)}\u2026` : english}`;
        return field(label, text(own, key, { placeholder: ui[key][code] || ui[key][L.main] || english }));
      }));
  }

  function languagesBox() {
    const L = state.draft.languages;
    const names = window.LANGUAGE_NAMES || {};
    // Languages that come with interface text (js/i18n.js); others need it typed in
    const hasUiText = (code) => Object.values(window.SITE_UI_TEXT || {}).some((entry) => entry[code]);
    const swap = (i, dir) => { [L.available[i], L.available[i + dir]] = [L.available[i + dir], L.available[i]]; languagesChanged(); };
    return h('div', { class: 'adm-form adm-group-box', 'data-adm-section': 'languages' },
      h('h3', { class: 'adm-group', text: 'Languages' }),
      field('Main language', h('select', {
        onchange: (e) => {
          if (!confirm(`Make ${names[e.target.value]} the main language? Nothing gets translated: the text you have written so far counts as ${names[e.target.value]} from now on, and each other language shows its own translation.`)) {
            e.target.value = L.main;
            return;
          }
          L.main = e.target.value;
          L.available = [...new Set([L.main, ...L.available])];
          languagesChanged();
        },
      }, Object.entries(names).map(([code, label]) => h('option', { value: code, text: label, selected: code === L.main }))),
      'The language you write your content in. Visitors see it unless their browser asks for another language you offer.'),
      h('span', { class: 'adm-label', text: 'Languages visitors can pick' }),
      L.available.map((code, i) => {
        const isOpen = state.openLang === code;
        return h('div', { class: `adm-entry${isOpen ? ' is-open' : ''}` },
          h('div', { class: 'adm-entry-head' },
            h('button', {
              class: 'adm-entry-title',
              type: 'button',
              'aria-expanded': String(isOpen),
              title: 'Interface text in this language',
              onclick: () => { state.openLang = isOpen ? null : code; rerenderTab(); },
            }, h('span', { class: 'adm-badge', text: code.toUpperCase() }), h('span', { text: names[code] }),
            h('span', { class: 'adm-hint', text: code === L.main ? 'main language' : hasUiText(code) ? '' : 'interface text to translate' })),
            h('div', { class: 'adm-row-controls' },
              iconBtn('\u2191', 'Move up', () => swap(i, -1), i === 0),
              iconBtn('\u2193', 'Move down', () => swap(i, 1), i === L.available.length - 1),
              iconBtn('\u2715', code === L.main ? 'The main language stays' : 'Stop offering this language', () => {
                if (!confirm(`Stop offering ${names[code]}? Its translations are kept, so adding it again brings them back.`)) return;
                L.available = L.available.filter((c) => c !== code);
                languagesChanged();
              }, code === L.main))),
          isOpen ? interfaceTextEditor(code) : null);
      }),
      field('Add a language', h('select', {
        onchange: (e) => {
          if (!e.target.value) return;
          L.available.push(e.target.value);
          languagesChanged();
        },
      }, h('option', { value: '', text: 'Choose\u2026' }),
      Object.entries(names).filter(([code]) => !L.available.includes(code)).map(([code, label]) => h('option', { value: code, text: label })))),
      h('p', { class: 'adm-hint', text: 'With one language, the switch is left out. The order here is the order in the switch. Click a language to edit its interface text; to translate your content, pick it as the editing language at the top of this panel. Languages written right to left aren\u2019t supported.' }));
  }

  // ---------- Theme tab ----------
  const COLOR_FIELDS = [
    ['bg', 'Page background'],
    ['bgAlt', 'Second background (About, Work)'],
    ['surface', 'Cards and form fields'],
    ['border', 'Lines and borders'],
    ['text', 'Text'],
    ['textDim', 'Soft text'],
    ['accent', 'Main accent (buttons, links)'],
    ['accent2', 'Second accent (highlights, lines)'],
    ['onAccent', 'Text on accent buttons'],
    ['heroBg', 'Top section background'],
    ['heroText', 'Top section text'],
  ];
  // Colours that change when switching between light and dark (the accents stay)
  const NEUTRAL_COLORS = ['bg', 'bgAlt', 'surface', 'border', 'text', 'textDim', 'heroBg'];

  const isHex = (value) => /^#[0-9a-f]{6}$/i.test(value || '');

  // Light or dark: swap the backgrounds and text for the chosen preset's (or a matching one), keep the accents
  function switchMode(theme, mode) {
    const T = window.SiteTheme;
    const own = T.presets[theme.preset];
    const base = own && (own.mode || 'dark') === mode ? own : T.presets[mode === 'light' ? 'paper' : 'midnight'];
    NEUTRAL_COLORS.forEach((key) => { theme.colors[key] = base[key] || base.bg; });
    delete theme.colors.heroText;
    theme.colors.mode = mode;
  }

  // ---------- Saved colour schemes ----------
  // theme.saved = [{ name, preset, colors }]: colour combinations kept to switch back to, stored with the
  // site's content so they're there on every computer
  const schemeKey = (scheme) => JSON.stringify({ preset: scheme.preset, colors: scheme.colors || {} });
  const currentScheme = (theme) => ({ preset: theme.preset, colors: { ...theme.colors } });

  // Switching away from colours that are in no saved scheme loses them: say so first
  function confirmColourSwitch(theme) {
    const custom = Object.keys(theme.colors).filter((key) => key !== 'mode').length > 0;
    const kept = theme.saved.some((scheme) => schemeKey(scheme) === schemeKey(currentScheme(theme)));
    return !custom || kept || confirm('Switch colours? Your own colour changes aren\u2019t saved as a scheme yet, so they\u2019ll be replaced. (Cancel, then use \u201CSave current colours\u201D to keep them.)');
  }

  function colourSchemesBox(theme, swatch) {
    const saved = theme.saved;
    const active = schemeKey(currentScheme(theme));
    const name = h('input', { type: 'text', placeholder: 'Name, e.g. Summer', maxLength: 40 });
    const saveCurrent = () => {
      const label = name.value.trim() || `Scheme ${saved.length + 1}`;
      const existing = saved.findIndex((scheme) => scheme.name.toLowerCase() === label.toLowerCase());
      if (existing >= 0 && !confirm(`Replace the saved scheme \u201C${saved[existing].name}\u201D with the current colours?`)) return;
      const scheme = { name: label, ...currentScheme(theme) };
      if (existing >= 0) saved[existing] = scheme;
      else saved.push(scheme);
      rerenderTab();
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveCurrent(); } });
    return h('div', { class: 'adm-form adm-group-box' },
      h('h3', { class: 'adm-group', text: 'Your colour schemes' }),
      saved.length
        ? h('div', { class: 'adm-presets' }, saved.map((scheme, i) => {
          const colors = window.SiteTheme.colors(scheme);
          const isActive = schemeKey(scheme) === active;
          return h('div', { class: 'adm-scheme' },
            h('button', {
              class: `adm-preset${isActive ? ' is-active' : ''}`,
              type: 'button',
              'aria-pressed': String(isActive),
              title: 'Use these colours',
              onclick: () => {
                if (isActive || !confirmColourSwitch(theme)) return;
                theme.preset = scheme.preset;
                theme.colors = { ...scheme.colors };
                rerenderTab();
              },
            }, h('span', { class: 'adm-swatches' }, swatch(colors.bg), swatch(colors.surface), swatch(colors.accent), swatch(colors.accent2)), h('span', { text: scheme.name })),
            iconBtn('\u2715', `Delete \u201C${scheme.name}\u201D`, () => {
              if (!confirm(`Delete the saved scheme \u201C${scheme.name}\u201D? The colours you\u2019re using now stay.`)) return;
              saved.splice(i, 1);
              rerenderTab();
            }));
        }))
        : h('p', { class: 'adm-hint', text: 'Save the colours you have now to switch back to them later, or to try several looks. Saved schemes are kept with the site, on every computer.' }),
      h('div', { class: 'adm-scheme-save' },
        name,
        h('button', { class: 'adm-btn', type: 'button', text: 'Save current colours', onclick: saveCurrent })));
  }

  // ---------- Uploaded fonts ----------
  const FONT_WEIGHTS = [['auto', 'All weights'], ['100', 'Thin (100)'], ['200', 'Extra light (200)'], ['300', 'Light (300)'],
    ['400', 'Regular (400)'], ['500', 'Medium (500)'], ['600', 'Semibold (600)'], ['700', 'Bold (700)'], ['800', 'Extra bold (800)'], ['900', 'Black (900)']];
  const WEIGHT_WORDS = [['extralight', '200'], ['ultralight', '200'], ['semibold', '600'], ['demibold', '600'], ['extrabold', '800'],
    ['ultrabold', '800'], ['thin', '100'], ['light', '300'], ['regular', '400'], ['book', '400'], ['medium', '500'],
    ['bold', '700'], ['black', '900'], ['heavy', '900']];

  // "Gilroy-SemiBoldItalic.otf" → { name: "Gilroy", weight: "600", style: "italic" }
  function fontFromFile(fileName) {
    const base = fileName.replace(/\.[a-z0-9]+$/i, '');
    const lower = base.toLowerCase().replace(/[\s_-]/g, '');
    const weight = (WEIGHT_WORDS.find(([word]) => lower.includes(word)) || [null, 'auto'])[1];
    const style = /italic|oblique/.test(lower) ? 'italic' : 'normal';
    const name = base.split(/[-_]/)[0].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s*(variable|vf)$/i, '').trim() || 'My font';
    return { name, weight, style };
  }

  function customFontsBox(theme) {
    const fonts = theme.customFonts;
    const oldNames = fonts.map((f) => f.name);
    return h('div', { class: 'adm-field' },
      h('span', { class: 'adm-label', text: 'Your own font files' }),
      fonts.map((f, i) => h('div', { class: 'adm-entry is-open' },
        h('div', { class: 'adm-entry-head' },
          h('span', { class: 'adm-path' }, f.file, state.pending.has(f.file) ? h('em', { text: ' (new, uploads on save)' }) : null),
          iconBtn('✕', 'Remove font', () => {
            const others = fonts.filter((o, j) => j !== i && o.name === f.name);
            fonts.splice(i, 1);
            // Last file of a family that is in use: fall back to the default font
            if (!others.length) {
              if (theme.font === f.name) theme.font = 'Geologica';
              if (theme.headingFont === f.name) theme.headingFont = '';
            }
            rerenderTab();
          })),
        h('div', { class: 'adm-row3' },
          field('Font name', text(f, 'name', {
            onchange: () => {
              // Keep the family picked as text or heading font when it's renamed
              if (theme.font === oldNames[i]) theme.font = f.name;
              if (theme.headingFont === oldNames[i]) theme.headingFont = f.name;
              rerenderTab();
            },
          })),
          field('Weight', h('select', { onchange: (e) => { f.weight = e.target.value; changed(); } },
            FONT_WEIGHTS.map(([value, label]) => h('option', { value, text: label, selected: String(f.weight) === value })))),
          field('Style', h('select', { onchange: (e) => { f.style = e.target.value; changed(); } },
            h('option', { value: 'normal', text: 'Normal', selected: f.style !== 'italic' }),
            h('option', { value: 'italic', text: 'Italic', selected: f.style === 'italic' })))))),
      filePicker('.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf', (file) => {
        const ext = extension(file);
        if (!['.woff2', '.woff', '.ttf', '.otf'].includes(ext)) { alert('Use a .woff2, .woff, .ttf or .otf font file.'); return; }
        const guess = fontFromFile(file.name);
        const path = stageFile(file, `assets/fonts/${slug(file.name.replace(/\.[a-z0-9]+$/i, ''))}-${Date.now().toString(36)}${ext}`);
        if (!path) return;
        fonts.push({ ...guess, file: path });
        rerenderTab();
      }),
      h('span', { class: 'adm-hint', text: 'Upload a font file (.woff2 is smallest), then pick it by name above. Files with the same name form one family: add a bold or italic file and set its weight and style, or leave a variable font on “All weights”. Make sure the font’s licence allows use on a website.' }));
  }

  function themeTab() {
    const theme = state.draft.theme;
    const T = window.SiteTheme;
    const colors = T.colors(theme);
    // What the top section's text currently is (it follows Text on dark themes, light on light ones)
    const heroText = colors.heroText || (colors.mode === 'light' ? '#f5f6f8' : colors.text);
    const swatch = (color) => h('span', { class: 'adm-swatch', style: `background:${color}` });
    const ownFamilies = [...new Set(theme.customFonts.map((f) => f.name.trim()).filter(Boolean))];
    const fontOptions = (selected, emptyLabel) => [
      emptyLabel ? h('option', { value: '', text: emptyLabel, selected: !selected }) : null,
      ownFamilies.length ? h('optgroup', { label: 'Your fonts' }, ownFamilies.map((f) => h('option', { value: f, text: f, selected: selected === f }))) : null,
      h('optgroup', { label: 'Google Fonts' }, Object.keys(T.fonts).map((f) => h('option', { value: f, text: f, selected: selected === f }))),
    ];
    return h('div', { class: 'adm-form' },
      h('p', { class: 'adm-help', text: 'Colours, fonts and corners for the whole site. Pick a starting point, then fine-tune any colour.' }),
      h('div', { class: 'adm-form adm-group-box' },
        h('h3', { class: 'adm-group', text: 'Starting point' }),
        h('div', { class: 'adm-presets' }, Object.entries(T.presets).map(([key, p]) => h('button', {
          class: `adm-preset${theme.preset === key ? ' is-active' : ''}`,
          type: 'button',
          'aria-pressed': String(theme.preset === key),
          onclick: () => {
            if (!confirmColourSwitch(theme)) return;
            theme.preset = key;
            theme.colors = {};
            rerenderTab();
          },
        }, h('span', { class: 'adm-swatches' }, swatch(p.bg), swatch(p.surface), swatch(p.accent), swatch(p.accent2)), h('span', { text: p.name }))))),
      colourSchemesBox(theme, swatch),
      h('div', { class: 'adm-form adm-group-box' },
        h('h3', { class: 'adm-group', text: 'Colours' }),
        field('Light or dark', h('select', {
          onchange: (e) => { switchMode(theme, e.target.value); rerenderTab(); },
        }, h('option', { value: 'dark', text: 'Dark (light text)', selected: colors.mode !== 'light' }),
        h('option', { value: 'light', text: 'Light (dark text)', selected: colors.mode === 'light' })),
        'Switches the backgrounds and text colours; the accents stay. The top section keeps a dark background either way, so its text reads on photos and video.'),
        h('div', { class: 'adm-colors' }, COLOR_FIELDS.map(([key, label]) => h('label', { class: 'adm-color' },
          h('input', {
            type: 'color',
            value: isHex(colors[key]) ? colors[key] : isHex(heroText) && key === 'heroText' ? heroText : '#000000',
            oninput: (e) => { theme.colors[key] = e.target.value; changed(); },
          }),
          h('span', { text: label })))),
        h('button', { class: 'adm-btn', type: 'button', text: 'Reset colours to the preset', onclick: () => { theme.colors = {}; rerenderTab(); } })),
      h('div', { class: 'adm-form adm-group-box' },
        h('h3', { class: 'adm-group', text: 'Fonts' }),
        h('div', { class: 'adm-row2' },
          field('Text', h('select', { onchange: (e) => { theme.font = e.target.value; changed(); } }, fontOptions(theme.font))),
          field('Headings', h('select', { onchange: (e) => { theme.headingFont = e.target.value; changed(); } }, fontOptions(theme.headingFont, 'Same as the text')))),
        h('p', { class: 'adm-hint', text: 'Headings are your name, the section titles, card titles and the logo.' }),
        customFontsBox(theme)),
      h('div', { class: 'adm-form adm-group-box' },
        h('h3', { class: 'adm-group', text: 'Shape' }),
        slider(theme, 'radius', 'Corner roundness', 0, 28, 2, ' px', 'Cards, the showreel frame and pop-ups.')),
      cursorBox(theme));
  }

  // ---------- Mouse effect (Theme tab) ----------
  const CURSOR_STYLES = [
    ['off', 'Off: the normal pointer'],
    ['dot', 'Dot'],
    ['label', 'Label: a dot that says \u201CView\u201D or \u201CPlay\u201D over projects'],
    ['spotlight', 'Spotlight: a soft glow following the mouse'],
    ['image', 'Your own pointer: an image you upload'],
  ];

  function cursorBox(theme) {
    const cur = theme.cursor;
    const style = cur.style;
    const colour = () => choice(cur, 'color', 'Colour', [['invert', 'Inverted (shows on anything)'], ['accent', 'Main accent'], ['accent2', 'Second accent']]);
    const grow = (label) => check(cur, 'grow', label || 'Grow over links and buttons');
    const preview = cur.image ? (window.SITE_ASSET_OVERRIDES[cur.image] || cur.image) : '';
    return h('div', { class: 'adm-form adm-group-box', 'data-adm-section': 'cursor' },
      h('h3', { class: 'adm-group', text: 'Mouse effect' }),
      field('Style', h('select', {
        onchange: (e) => {
          cur.style = e.target.value;
          // The dot and the picture share the size: give each a sensible size when switching
          if (cur.style === 'image' && cur.size < 16) cur.size = 32;
          if ((cur.style === 'dot' || cur.style === 'label') && cur.size > 30) cur.size = 14;
          rerenderTab();
        },
      },
        CURSOR_STYLES.map(([value, label]) => h('option', { value, text: label, selected: style === value })))),
      style === 'dot' || style === 'label' ? [
        slider(cur, 'size', 'Dot size', 8, 30, 1, ' px'),
        colour(),
        grow(),
        style === 'label' ? h('p', { class: 'adm-hint', text: 'Over a project it becomes a circle saying \u201CView\u201D, or \u201CPlay\u201D when the project has videos. The words follow the site\u2019s language (Site tab \u2192 Languages \u2192 interface text).' }) : null,
      ] : null,
      style === 'spotlight' ? [
        slider(cur, 'glowSize', 'Glow size', 150, 600, 10, ' px'),
        slider(cur, 'glowStrength', 'Glow strength', 5, 40, 1, '%'),
        choice(cur, 'glowColor', 'Glow colour', [['accent', 'Main accent'], ['accent2', 'Second accent']]),
      ] : null,
      style === 'image' ? [
        h('div', { class: 'adm-field' },
          h('span', { class: 'adm-label', text: 'Pointer image' }),
          h('div', { class: 'adm-inline' },
            preview ? h('img', { class: 'adm-cursor-preview', src: preview, alt: '' }) : null,
            currentFile(cur.image),
            cur.image ? h('button', { class: 'adm-link', type: 'button', text: 'Remove', onclick: () => { cur.image = ''; rerenderTab(); } }) : null),
          filePicker('image/png,image/svg+xml,image/gif,image/webp,.png,.svg,.gif,.webp', (file) => {
            const path = stageFile(file, `assets/cursor-${Date.now().toString(36)}${extension(file) || '.png'}`);
            if (path) { cur.image = path; rerenderTab(); }
          }),
          h('span', { class: 'adm-hint', text: 'A PNG or SVG with a transparent background works best. Until there is one, a dot is shown.' })),
        slider(cur, 'size', 'Size', 16, 96, 2, ' px'),
        choice(cur, 'tip', 'Where it points', [['center', 'The middle of the image'], ['top-left', 'The top-left corner (for arrow shapes)']]),
        grow('Grow a little over links and buttons'),
      ] : null,
      check(cur, 'magnetic', 'Magnetic buttons: buttons drift a little toward the mouse'),
      h('p', { class: 'adm-hint', text: 'Only on computers with a mouse or trackpad. Phones and tablets keep their normal touch, and visitors who prefer less motion get the normal pointer.' }));
  }

  // ---------- Page tab: the page as an outline ----------
  // Top section, every section in page order, then the footer. Each row can be dragged (or moved with the
  // arrows), shown or hidden with the eye, and opened to edit it right there.
  const SECTION_NAMES = { about: 'About', reel: 'Showreel', work: 'Work', experience: 'Experience', toolkit: 'Toolkit', contact: 'Contact' };
  const SECTION_KEYS = {
    about: ['about.title', 'nav.about'],
    reel: ['reel.title', 'nav.reel'],
    work: ['work.title', 'nav.work'],
    contact: ['contact.title', 'nav.contact'],
    experience: ['experience.title'],
    toolkit: ['toolkit.title'],
  };
  const KIND_LABELS = { hero: 'Top', about: 'About', reel: 'Video', work: 'Work', grid: 'Work', experience: 'Timeline', toolkit: 'Toolkit', contact: 'Contact', text: 'Text', footer: 'Footer' };

  // The built-in text for a spot, in the language being edited (shown as the placeholder)
  function uiDefault(key) {
    const entry = (window.SITE_UI_TEXT || {})[key];
    return entry ? (entry[lang()] || entry.en) : '';
  }

  const kindOf = (id) => window.SiteSections.kind(state.draft, id);
  const allSectionIds = (c) => [...window.SiteSections.builtin, ...c.workGrids.map((g) => g.id), ...c.customSections.map((s) => s.id)];

  // What a row is called: its title, else the standard title
  function sectionLabel(id) {
    const own = (state.draft.sections[id] || {}).title;
    if (own && own.trim()) return own.trim();
    if (SECTION_KEYS[id]) return uiDefault(SECTION_KEYS[id][0]) || SECTION_NAMES[id];
    return kindOf(id) === 'grid' ? uiDefault('work.title') : '(untitled section)';
  }

  // Ticks for parts of a section that can be taken off the page (index.html marks them with data-part)
  function partToggles(parts) {
    const hidden = state.draft.hidden;
    return h('div', { class: 'adm-form adm-group-box' },
      h('h3', { class: 'adm-group', text: 'Show on the page' }),
      h('div', { class: 'adm-checks' }, parts.map(([key, label]) => h('label', { class: 'adm-check' },
        h('input', {
          type: 'checkbox',
          checked: !hidden[key],
          onchange: (e) => {
            if (e.target.checked) delete hidden[key];
            else hidden[key] = true;
            changed();
          },
        }),
        h('span', { text: label })))));
  }

  // The same first block for every section: title, menu, background and title look
  function sectionBasics(id) {
    const set = state.draft.sections[id];
    const keys = SECTION_KEYS[id];
    const titleHint = keys ? uiDefault(keys[0]) : kindOf(id) === 'grid' ? uiDefault('work.title') : '';
    const navHint = keys && keys[1] ? uiDefault(keys[1]) : set.title || titleHint || 'Same as the title';
    return h('div', { class: 'adm-form adm-group-box' },
      h('h3', { class: 'adm-group', text: 'Section' }),
      h('div', { class: 'adm-row2' },
        field('Title', text(set, 'title', { placeholder: titleHint, onchange: () => rerenderTab() })),
        field('Menu label', text(set, 'nav', { placeholder: navHint }))),
      check(set, 'inMenu', 'Show in the menu'),
      h('div', { class: 'adm-row2' },
        choice(set, 'background', 'Background', [['main', 'Page background'], ['alt', 'Second background']]),
        choice(set, 'titleStyle', 'Title style', [['large', 'Large, with a dot'], ['small', 'Small, with a line']])),
      slider(set, 'titleSize', 'Title size', 40, 200, 5, '%',
        'A small title on the same background as the section above makes it read as part of that section.'));
  }

  function fileField(label, path, accept, onPick, onRemove, hint, section) {
    return h('div', { class: 'adm-field', 'data-adm-section': section },
      h('span', { class: 'adm-label', text: label }),
      h('div', { class: 'adm-inline' },
        currentFile(path),
        path ? h('button', { class: 'adm-link', type: 'button', text: 'Remove', onclick: onRemove }) : null),
      filePicker(accept, onPick),
      hint ? h('span', { class: 'adm-hint', text: hint }) : null);
  }

  // ---------- Each kind of section's editor ----------
  function heroEditor() {
    const c = state.draft;
    return h('div', { class: 'adm-form' },
      heroTab(),
      h('div', { class: 'adm-form adm-group-box' },
        h('h3', { class: 'adm-group', text: 'Resume' }),
        fileField('Resume (PDF)', c.resume, 'application/pdf,.pdf', (file) => {
          const path = stageFile(file, 'assets/resume.pdf');
          if (path) { c.resume = path; rerenderTab(); }
        }, () => { c.resume = ''; rerenderTab(); }, 'The file behind the Resume link. Without one, the link is left out.')));
  }

  function aboutEditor() {
    const c = state.draft;
    return [
      partToggles([['about.photo', 'Photo'], ['about.bio', 'Bio paragraphs'], ['about.skills', 'Skills list']]),
      aboutTab(),
      fileField('Photo', c.about.photo, 'image/*', (file) => {
        const path = stageFile(file, `assets/profile-${Date.now().toString(36)}${extension(file)}`);
        if (path) { c.about.photo = path; rerenderTab(); }
      }, () => { c.about.photo = ''; rerenderTab(); }, 'A square-ish portrait works best. Without one, the text uses the full width.', 'photo'),
    ];
  }

  function reelEditor() {
    return [
      partToggles([['reel.intro', 'Intro line'], ['reel.video', 'Video (or the “coming soon” box)']]),
      field('Intro line', area(state.draft.intros, 'reel', 2)),
      reelTab(),
    ];
  }

  function contactEditor() {
    return [
      partToggles([['contact.intro', 'Intro line'], ['contact.form', 'Message form'], ['contact.linkedin', 'LinkedIn button'],
        ['contact.socials', 'Social icons'], ['contact.email', 'Email address']]),
      field('Intro line', area(state.draft.intros, 'contact', 2)),
      h('p', { class: 'adm-hint', text: 'Your email address and social links are in the Site tab.' }),
    ];
  }

  function textEditor(sec) {
    return h('div', { class: 'adm-form' },
      field('Text', area(sec, 'text', 6), 'Leave an empty line between paragraphs.'),
      fileField('Picture (optional)', sec.image, 'image/*', (file) => {
        const path = stageFile(file, `assets/sections/${slug(state.draft.sections[sec.id].title)}-${Date.now().toString(36)}${extension(file)}`);
        if (path) { sec.image = path; rerenderTab(); }
      }, () => { sec.image = ''; rerenderTab(); }),
      sec.image ? h('div', { class: 'adm-row2' },
        choice(sec, 'imagePlace', 'Picture position', [['below', 'Below the text'], ['side', 'Beside the text']]),
        field('Picture description (for screen readers)', text(sec, 'imageAlt'))) : null,
      h('div', { class: 'adm-field' },
        h('span', { class: 'adm-label', text: 'Button (optional)' }),
        h('div', { class: 'adm-row2' },
          text(sec.button, 'label', { placeholder: 'Label, e.g. See my shop' }),
          text(sec.button, 'url', { type: 'url', placeholder: 'https://… or #contact' }))));
  }

  // Which Work section a project shows up in first (for the ✎ on a card)
  function gridForProject(index) {
    const c = state.draft;
    const item = c.work[index];
    return c.sections.order.find((id) => {
      if (kindOf(id) !== 'work' && kindOf(id) !== 'grid') return false;
      const allowed = c.sections[id].categories || [];
      return !allowed.length || (item && allowed.includes(item.type));
    }) || 'work';
  }

  function workEditor(id) {
    const c = state.draft;
    const set = c.sections[id];
    set.categories = set.categories || [];
    const grid = c.workGrids.find((g) => g.id === id);
    const hl = c.highlights;
    const entries = c.work.map((item, index) => ({ item, index }))
      .filter(({ item }) => !set.categories.length || set.categories.includes(item.type));
    // Categories no Work section on the page shows
    const shown = c.sections.order.filter((sid) => kindOf(sid) === 'work' || kindOf(sid) === 'grid').map((sid) => c.sections[sid].categories || []);
    const missing = shown.some((list) => !list.length) ? [] : c.categories.filter((cat) => !shown.some((list) => list.includes(cat.id)) && c.work.some((w) => w.type === cat.id));

    return [
      partToggles([[`${id}.intro`, 'Intro line'], [`${id}.highlights`, 'Highlights slider'], [`${id}.filters`, 'Filter buttons'], [`${id}.grid`, 'Project cards']]),
      field('Intro line', id === 'work' ? area(c.intros, 'work', 2) : area(grid, 'intro', 2)),
      h('div', { class: 'adm-form adm-group-box' },
        h('h3', { class: 'adm-group', text: 'Projects shown here' }),
        h('div', { class: 'adm-checks' }, c.categories.map((cat) => h('label', { class: 'adm-check' },
          h('input', {
            type: 'checkbox',
            checked: set.categories.includes(cat.id),
            onchange: (e) => {
              set.categories = set.categories.filter((cid) => cid !== cat.id);
              if (e.target.checked) set.categories.push(cat.id);
              rerenderTab();
            },
          }),
          h('span', { text: cat.label || cat.id })))),
        h('p', { class: 'adm-hint', text: set.categories.length ? 'Only projects in the ticked categories.' : 'Nothing ticked: every project.' }),
        missing.length ? h('p', { class: 'adm-error', text: `Not shown in any Work section: ${missing.map((cat) => cat.label || cat.id).join(', ')}.` }) : null),
      categoriesBox(),
      h('div', { class: 'adm-form adm-group-box' },
        h('h3', { class: 'adm-group', text: 'Highlights slider' }),
        h('p', { class: 'adm-hint', text: 'Shows this section’s projects ticked “Featured”, one slide at a time. These settings are shared by all Work sections.' }),
        check(hl, 'autoplay', 'Move to the next project by itself'),
        slider(hl, 'seconds', 'Time per slide', 3, 20, 1, ' s')),
      projectsList(entries, set.categories[0] || (c.categories[0] || {}).id),
    ];
  }

  // The projects in one Work section; moving swaps with the neighbour shown here
  function projectsList(entries, newType) {
    const work = state.draft.work;
    const swap = (a, b) => {
      [work[a], work[b]] = [work[b], work[a]];
      if (state.openItem === a) state.openItem = b;
      else if (state.openItem === b) state.openItem = a;
      rerenderTab();
    };
    return h('div', { class: 'adm-form' },
      h('div', { class: 'adm-section-head' },
        h('span', { class: 'adm-label', text: `Projects (${entries.length})` }),
        h('button', {
          class: 'adm-btn adm-btn-primary',
          type: 'button',
          text: '+ Add project',
          onclick: () => {
            work.unshift(normalizeWork({ type: newType, title: 'New project', teaser: 'One line about it.' }));
            state.openItem = 0;
            rerenderTab();
          },
        })),
      entries.length ? null : h('p', { class: 'adm-hint', text: 'No projects here yet.' }),
      entries.map(({ item, index }, n) => {
        const isOpen = state.openItem === index;
        return h('div', { class: `adm-entry${isOpen ? ' is-open' : ''}` },
          h('div', { class: 'adm-entry-head' },
            h('button', {
              class: 'adm-entry-title',
              type: 'button',
              'aria-expanded': String(isOpen),
              onclick: () => { state.openItem = isOpen ? null : index; rerenderTab(); },
            }, h('span', { class: 'adm-badge', text: item.featured ? `${categoryName(item.type)} · featured` : categoryName(item.type) }), bind(h('span', { text: item.title || '(untitled)' }), item, 'title', '(untitled)')),
            h('div', { class: 'adm-row-controls' },
              iconBtn('↑', 'Move up', () => swap(index, entries[n - 1].index), n === 0),
              iconBtn('↓', 'Move down', () => swap(index, entries[n + 1].index), n === entries.length - 1),
              iconBtn('✕', 'Delete project', () => {
                if (!confirm('Delete this project?')) return;
                work.splice(index, 1);
                state.openItem = null;
                rerenderTab();
              }))),
          isOpen ? workForm(item) : null);
      }));
  }

  function editorFor(id) {
    const kind = id === 'hero' || id === 'footer' ? id : kindOf(id);
    if (kind === 'hero') return heroEditor();
    if (kind === 'footer') {
      return h('div', { class: 'adm-form' },
        partToggles([['footer.links', 'Links']]),
        h('p', { class: 'adm-hint', text: 'Choose which links appear here in the Site tab (“In footer”).' }));
    }
    const body = { about: aboutEditor, reel: reelEditor, work: () => workEditor(id), grid: () => workEditor(id), experience: experienceTab, toolkit: toolkitTab, contact: contactEditor, text: () => textEditor(state.draft.customSections.find((s) => s.id === id)) }[kind]();
    const builtin = window.SiteSections.builtin.includes(id);
    return h('div', { class: 'adm-form' },
      sectionBasics(id),
      body,
      h('div', { class: 'adm-row-foot' },
        h('button', {
          class: 'adm-btn adm-btn-danger',
          type: 'button',
          text: builtin ? 'Remove from the page' : 'Delete section',
          title: builtin ? 'Its content is kept; add it back with “+ Add section”.' : 'Deletes the section and its content',
          onclick: () => removeSection(id),
        })));
  }

  // ---------- Adding, removing and moving sections ----------
  function insertSection(id) {
    const order = state.draft.sections.order;
    const after = { experience: 'work', toolkit: 'experience' }[id];
    const at = after && order.includes(after) ? order.indexOf(after) + 1
      : id !== 'contact' && order.includes('contact') ? order.indexOf('contact') : order.length;
    order.splice(at, 0, id);
    state.openRow = id;
  }

  function addSection(kind) {
    const c = state.draft;
    const id = `${kind === 'grid' ? 'work' : 'section'}-${Date.now().toString(36)}`;
    const look = window.SiteSections.look[kind];
    c.sections[id] = { title: kind === 'grid' ? 'More work' : 'New section', nav: '', inMenu: look.inMenu, background: look.background, titleStyle: look.titleStyle, titleSize: 100 };
    if (kind === 'grid') {
      c.sections[id].categories = [];
      c.workGrids.push({ id, intro: '' });
    } else {
      c.customSections.push(normalizeSection({ id, text: 'Write something about this here.' }));
    }
    insertSection(id);
    rerenderTab();
  }

  function removeSection(id) {
    const c = state.draft;
    const builtin = window.SiteSections.builtin.includes(id);
    if (!confirm(builtin
      ? `Take “${sectionLabel(id)}” off the page? Its content is kept, and you can add it back with “+ Add section”.`
      : `Delete “${sectionLabel(id)}” and its content? This can’t be undone after saving.`)) return;
    c.sections.order = c.sections.order.filter((sid) => sid !== id);
    if (builtin) {
      c.sections.removed.push(id);
    } else {
      c.workGrids = c.workGrids.filter((g) => g.id !== id);
      c.customSections = c.customSections.filter((s) => s.id !== id);
      delete c.sections[id];
      Object.keys(c.hidden).forEach((key) => { if (key === id || key.startsWith(`${id}.`)) delete c.hidden[key]; });
    }
    state.openRow = null;
    rerenderTab();
  }

  function moveSection(from, to) {
    const order = state.draft.sections.order;
    if (to < 0 || to >= order.length || from === to) return;
    const [id] = order.splice(from, 1);
    order.splice(to, 0, id);
    rerenderTab();
  }

  // Opens a row's section on the page behind (scrolls to it)
  function showOnPage(id) {
    const target = id === 'hero' ? document.querySelector('.hero') : id === 'footer' ? document.querySelector('.site-footer') : document.getElementById(id);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const doc = phone && phone.frame.contentDocument;
    const inPhone = doc && (id === 'hero' ? doc.querySelector('.hero') : id === 'footer' ? doc.querySelector('.site-footer') : doc.getElementById(id));
    if (inPhone) inPhone.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  let dragId = null;

  function outlineRow(id, index) {
    const c = state.draft;
    const fixed = id === 'hero' || id === 'footer';
    const kind = fixed ? id : kindOf(id);
    const isOpen = state.openRow === id;
    const isHidden = Boolean(c.hidden[id]);
    const label = id === 'hero' ? 'Top section' : id === 'footer' ? 'Footer' : sectionLabel(id);
    const eye = id === 'hero' ? null : h('button', {
      class: 'adm-icon adm-eye',
      type: 'button',
      title: isHidden ? 'Hidden: click to show it on the page' : 'Shown: click to hide it from the page',
      'aria-pressed': String(!isHidden),
      onclick: () => {
        if (isHidden) delete c.hidden[id];
        else c.hidden[id] = true;
        rerenderTab();
      },
    });
    if (eye) eye.innerHTML = isHidden ? EYE_OFF : EYE;

    const row = h('div', { class: `adm-entry adm-outline-row${isOpen ? ' is-open' : ''}${isHidden ? ' is-hidden' : ''}${fixed ? ' is-fixed' : ''}`, 'data-row': id },
      h('div', { class: 'adm-entry-head' },
        fixed ? h('span', { class: 'adm-handle' }) : h('span', {
          class: 'adm-handle',
          title: 'Drag to move',
          text: '⠿',
          // Only the handle starts a drag, so text in the editor below can still be selected
          onpointerdown: () => { row.draggable = true; },
        }),
        h('button', {
          class: 'adm-entry-title',
          type: 'button',
          'aria-expanded': String(isOpen),
          onclick: () => {
            state.openRow = isOpen ? null : id;
            rerenderTab();
            if (!isOpen) showOnPage(id);
          },
        }, h('span', { class: 'adm-badge', text: KIND_LABELS[kind] }), h('span', { text: label })),
        h('div', { class: 'adm-row-controls' },
          fixed ? null : iconBtn('↑', 'Move up', () => moveSection(index, index - 1), index === 0),
          fixed ? null : iconBtn('↓', 'Move down', () => moveSection(index, index + 1), index === c.sections.order.length - 1),
          eye)),
      isOpen ? h('div', { class: 'adm-row-body' }, editorFor(id)) : null);

    if (!fixed) {
      row.addEventListener('dragstart', (e) => {
        dragId = id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
        row.classList.add('is-dragging');
      });
      row.addEventListener('dragend', () => {
        dragId = null;
        row.draggable = false;
        screen.querySelectorAll('.adm-outline-row').forEach((r) => r.classList.remove('is-dragging', 'drop-before', 'drop-after'));
      });
      row.addEventListener('dragover', (e) => {
        if (!dragId || dragId === id) return;
        e.preventDefault();
        const box = row.getBoundingClientRect();
        const before = e.clientY < box.top + Math.min(box.height / 2, 28);
        row.classList.toggle('drop-before', before);
        row.classList.toggle('drop-after', !before);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
      row.addEventListener('drop', (e) => {
        if (!dragId || dragId === id) return;
        e.preventDefault();
        const order = c.sections.order;
        const before = row.classList.contains('drop-before');
        order.splice(order.indexOf(dragId), 1);
        order.splice(order.indexOf(id) + (before ? 0 : 1), 0, dragId);
        dragId = null;
        rerenderTab();
      });
    }
    return row;
  }

  function pageTab() {
    const c = state.draft;
    const removed = c.sections.removed.filter((id) => window.SiteSections.builtin.includes(id));
    return h('div', { class: 'adm-form adm-outline' },
      h('p', { class: 'adm-help', text: 'Your page from top to bottom. Click a section to edit it, drag ⠿ (or use the arrows) to move it, and use the eye to show or hide it.' }),
      outlineRow('hero'),
      h('div', { class: 'adm-outline-list' }, c.sections.order.map((id, i) => outlineRow(id, i))),
      h('div', { class: 'adm-add' },
        h('span', { class: 'adm-label', text: '+ Add section' }),
        h('div', { class: 'adm-inline' },
          h('button', { class: 'adm-btn', type: 'button', text: 'Text', title: 'A title, text, and optionally a picture and a button', onclick: () => addSection('text') }),
          h('button', { class: 'adm-btn', type: 'button', text: 'Work grid', title: 'Projects from the categories you pick', onclick: () => addSection('grid') }),
          removed.map((id) => h('button', {
            class: 'adm-btn',
            type: 'button',
            text: sectionLabel(id),
            title: 'Put this section back on the page',
            onclick: () => {
              c.sections.removed = c.sections.removed.filter((sid) => sid !== id);
              insertSection(id);
              rerenderTab();
            },
          })))),
      outlineRow('footer'));
  }

  // ---------- Work sections: categories and project forms ----------
  const categoryName = (id) => {
    const cat = state.draft.categories.find((c) => c.id === id);
    return (cat && cat.label) || id;
  };

  // The filter buttons; each project picks one
  function categoriesBox() {
    const cats = state.draft.categories;
    const work = state.draft.work;
    const icons = Object.keys(window.CATEGORY_ICONS || { play: '' });
    return h('div', { class: 'adm-form adm-group-box' },
      h('h3', { class: 'adm-group', text: 'Categories' }),
      h('p', { class: 'adm-hint', text: 'The filter buttons above the cards. A category gets a button once a project uses it; with fewer than two in use, the buttons are left out. The icon and tile colour show on cards without a cover image.' }),
      cats.map((cat, i) => {
        const count = work.filter((item) => item.type === cat.id).length;
        return h('div', { class: 'adm-entry is-open' },
          h('div', { class: 'adm-entry-head' },
            h('span', null, bind(h('strong', { text: cat.label || '(new category)' }), cat, 'label', '(new category)'),
              h('span', { class: 'adm-hint', text: ` \u00B7 ${count} project${count === 1 ? '' : 's'}` })),
            h('div', { class: 'adm-row-controls' },
              iconBtn('\u2191', 'Move up', () => move(cats, i, -1), i === 0),
              iconBtn('\u2193', 'Move down', () => move(cats, i, 1), i === cats.length - 1),
              iconBtn('\u2715', 'Delete category', () => {
                if (cats.length === 1) { alert('Keep at least one category.'); return; }
                const rest = cats.filter((c) => c !== cat);
                if (count && !confirm(`${count} project(s) use this category. They move to \u201C${rest[0].label || rest[0].id}\u201D. Delete it?`)) return;
                if (!count && !confirm('Delete this category?')) return;
                work.forEach((item) => { if (item.type === cat.id) item.type = rest[0].id; });
                cats.splice(i, 1);
                rerenderTab();
              }))),
          h('div', { class: 'adm-row3' },
            field('Name', text(cat, 'label')),
            field('Icon', h('select', { onchange: (e) => { cat.icon = e.target.value; changed(); } },
              icons.map((name) => h('option', { value: name, text: name[0].toUpperCase() + name.slice(1), selected: cat.icon === name })))),
            h('div', { class: 'adm-field' },
              h('span', { class: 'adm-label', text: 'Tile colour' }),
              h('div', { class: 'adm-inline' },
                h('input', { type: 'color', value: isHex(cat.color) ? cat.color : '#2a3140', oninput: (e) => { cat.color = e.target.value; changed(); } }),
                cat.color
                  ? h('button', { class: 'adm-link', type: 'button', text: 'Auto', title: 'Use a colour from the theme', onclick: () => { cat.color = ''; rerenderTab(); } })
                  : h('span', { class: 'adm-hint', text: 'Auto' })))));
      }),
      h('button', {
        class: 'adm-btn',
        type: 'button',
        text: '+ Add category',
        onclick: () => {
          cats.push({ id: `cat-${Date.now().toString(36)}`, label: 'New category', icon: 'star', color: '' });
          rerenderTab();
        },
      }));
  }

  function workForm(item) {
    const typeSelect = h('select', { onchange: (e) => { item.type = e.target.value; rerenderTab(); } },
      state.draft.categories.map((cat) => h('option', { value: cat.id, text: cat.label || cat.id, selected: item.type === cat.id })));
    const firstYoutube = (item.videos[0] || {}).youtube;

    const form = h('div', { class: 'adm-form' },
      h('div', { class: 'adm-row2' }, field('Category', typeSelect), field('Title', text(item, 'title'))),
      h('label', { class: 'adm-check' },
        h('input', { type: 'checkbox', checked: Boolean(item.featured), onchange: (e) => { item.featured = e.target.checked; rerenderTab(); } }),
        h('span', { text: 'Featured: shown in the Highlights slider at the top of Work (and still in the grid)' })),
      h('div', { class: 'adm-row3' },
        field('Client', text(item, 'client', { placeholder: 'e.g. StartupAwards' })),
        field('Year', text(item, 'year', { placeholder: 'e.g. 2025' })),
        field('Your role', text(item, 'role', { placeholder: 'e.g. Editing, sound' }))),
      field('Teaser (shown on the card)', text(item, 'teaser')),
      field('Full description (shown in the pop-up)', area(item, 'desc', 5)),
      field('Tools', list(item, 'tools', { placeholder: 'Premiere Pro, After Effects' }), 'Separate with commas.'),
      videosField(item),
      picturesField(item),
      h('div', { class: 'adm-field' },
        h('span', { class: 'adm-label', text: 'Cover image (shown on the card)' }),
        h('div', { class: 'adm-inline' },
          currentFile(item.thumb),
          item.thumb ? h('button', { class: 'adm-link', type: 'button', text: 'Remove', onclick: () => { item.thumb = ''; rerenderTab(); } }) : null),
        filePicker('image/*', (file) => {
          const path = stageFile(file, `assets/work/${slug(item.title)}-thumb-${Date.now().toString(36)}${extension(file)}`);
          if (path) { item.thumb = path; rerenderTab(); }
        }),
        h('span', { class: 'adm-hint', text: firstYoutube ? 'Optional: without one, the first video\u2019s YouTube thumbnail is used.' : item.images.length ? 'Optional: without one, the first picture is used.' : 'A 16:9 image works best.' })),
      field('Cover description (for screen readers)', text(item, 'thumbAlt')),
      h('div', { class: 'adm-field' },
        h('span', { class: 'adm-label', text: 'Buttons in the pop-up (optional)' }),
        item.links.map((link, n) => h('div', { class: 'adm-row2' },
          text(link, 'label', { placeholder: n === 0 ? 'Main button, e.g. Watch on YouTube' : 'Second button label' }),
          text(link, 'url', { placeholder: 'https://…' })))));
    return form;
  }

  // A project's pictures: a strip of small thumbnails. Clicking one shows its few controls underneath,
  // so a big gallery stays a single tidy row of images.
  let openPicture = null; // the picture whose controls are shown

  function picturesField(item) {
    const pics = item.images;
    const selected = pics.includes(openPicture) ? openPicture : null;
    const index = pics.indexOf(selected);
    const moveTo = (to) => {
      pics.splice(index, 1);
      pics.splice(to, 0, selected);
      rerenderTab();
    };
    const add = h('label', { class: 'adm-btn adm-file-btn' }, '+ Add pictures',
      h('input', {
        type: 'file',
        accept: 'image/*',
        multiple: true,
        onchange: (e) => {
          [...e.target.files].forEach((file, n) => {
            const path = stageFile(file, `assets/work/${slug(item.title)}-pic-${Date.now().toString(36)}${n}${extension(file)}`);
            if (path) pics.push({ src: path, alt: '' });
          });
          e.target.value = '';
          rerenderTab();
        },
      }));
    return h('div', { class: 'adm-field' },
      h('div', { class: 'adm-section-head' }, h('span', { class: 'adm-label', text: pics.length ? `Pictures (${pics.length})` : 'Pictures' }), add),
      pics.length ? h('div', { class: 'adm-pictures' }, pics.map((pic) => h('button', {
        class: `adm-picture${pic === selected ? ' is-selected' : ''}`,
        type: 'button',
        title: pic.alt || 'Click for options',
        'aria-pressed': String(pic === selected),
        onclick: () => { openPicture = pic === selected ? null : pic; rerenderTab(); },
      }, h('img', { src: window.SITE_ASSET_OVERRIDES[pic.src] || pic.src, alt: pic.alt || '' }),
      state.pending.has(pic.src) ? h('span', { class: 'adm-picture-new', title: 'Uploads on save' }) : null)))
        : h('span', { class: 'adm-hint', text: 'Shown in the pop-up after the videos, with arrows and thumbnails. You can pick several files at once.' }),
      selected ? h('div', { class: 'adm-picture-tools' },
        text(selected, 'alt', { placeholder: 'Description (for screen readers)' }),
        h('div', { class: 'adm-row-controls' },
          iconBtn('\u2190', 'Move left', () => moveTo(index - 1), index === 0),
          iconBtn('\u2192', 'Move right', () => moveTo(index + 1), index === pics.length - 1),
          iconBtn('\u2715', 'Remove picture', () => { pics.splice(index, 1); openPicture = null; rerenderTab(); }))) : null);
  }

  // A project's videos: the pop-up plays the first and shows the rest as thumbnails to switch to
  function videosField(item) {
    return h('div', { class: 'adm-field' },
      h('div', { class: 'adm-section-head' },
        h('span', { class: 'adm-label', text: 'Videos' }),
        h('button', {
          class: 'adm-btn',
          type: 'button',
          text: '+ Add video',
          onclick: () => { item.videos.push(normalizeVideo({ _mode: 'youtube' })); rerenderTab(); },
        })),
      item.videos.length ? null : h('span', { class: 'adm-hint', text: 'No videos: the pop-up shows the cover image instead.' }),
      item.videos.map((clip, i) => h('div', { class: 'adm-entry is-open' },
        h('div', { class: 'adm-entry-head' },
          h('strong', { text: clip.title || `Video ${i + 1}` }),
          rowControls(item.videos, i, 'video')),
        videoForm(item, clip, i))));
  }

  function videoForm(item, clip, i) {
    const mode = clip.youtube ? 'youtube' : clip.video ? (/^https?:\/\//i.test(clip.video) ? 'url' : 'file') : 'youtube';
    const videoMode = clip._mode || mode;
    const modeSelect = h('select', {
      onchange: (e) => {
        if (e.target.value !== 'file' && e.target.value !== 'url') clip.video = '';
        if (e.target.value !== 'youtube') clip.youtube = '';
        clip._mode = e.target.value;
        rerenderTab();
      },
    },
    h('option', { value: 'youtube', text: 'YouTube link (recommended)', selected: videoMode === 'youtube' }),
    h('option', { value: 'file', text: 'Upload a video file', selected: videoMode === 'file' }),
    h('option', { value: 'url', text: 'Direct video URL', selected: videoMode === 'url' }));

    let source;
    if (videoMode === 'youtube') {
      const idNote = h('span', { class: 'adm-hint', text: clip.youtube ? `Video ID: ${clip.youtube}` : 'Paste the video link.' });
      source = field('YouTube link', h('input', {
        type: 'url',
        value: clip.youtube ? `https://www.youtube.com/watch?v=${clip.youtube}` : '',
        placeholder: 'https://www.youtube.com/watch?v=…',
        oninput: (e) => {
          clip.youtube = youtubeId(e.target.value);
          idNote.textContent = clip.youtube ? `Video ID: ${clip.youtube}` : e.target.value ? 'That doesn’t look like a YouTube link.' : 'Paste the video link.';
          changed();
        },
      }), null);
      source.appendChild(idNote);
    } else if (videoMode === 'file') {
      source = h('div', { class: 'adm-field' },
        h('span', { class: 'adm-label', text: 'Video file (MP4 recommended)' }),
        currentFile(clip.video),
        filePicker('video/*', (file) => {
          const path = stageFile(file, `assets/work/${slug(clip.title || item.title)}-${Date.now().toString(36)}${extension(file)}`);
          if (path) { clip.video = path; rerenderTab(); }
        }),
        h('span', { class: 'adm-hint', text: `Up to ${MAX_BYTES / MB} MB. Bigger videos belong on YouTube, or on your own storage/CDN using "Direct video URL".` }));
    } else {
      source = field('Direct video URL', h('input', {
        type: 'url',
        value: clip.video || '',
        placeholder: 'https://your-storage.example.com/videos/clip.mp4',
        oninput: (e) => { clip.video = e.target.value.trim(); changed(); },
      }), 'A direct link to the video file itself (ending in .mp4 or similar), hosted on your own storage or CDN. Nothing is uploaded through this panel for this option; make sure the file is already live at that URL.');
    }

    return h('div', { class: 'adm-form' },
      check(clip, 'hideInMonitor', 'Hide from the top-section monitor and timeline'),
      h('div', { class: 'adm-row2' },
        field('Video title', text(clip, 'title', { placeholder: i === 0 ? 'Optional, e.g. a name' : `Video ${i + 1}` })),
        field('Source', modeSelect)),
      source,
      h('div', { class: 'adm-field' },
        h('span', { class: 'adm-label', text: 'Thumbnail (optional)' }),
        h('div', { class: 'adm-inline' },
          currentFile(clip.thumb),
          clip.thumb ? h('button', { class: 'adm-link', type: 'button', text: 'Remove', onclick: () => { clip.thumb = ''; rerenderTab(); } }) : null),
        filePicker('image/*', (file) => {
          const path = stageFile(file, `assets/work/${slug(clip.title || item.title)}-thumb-${Date.now().toString(36)}${extension(file)}`);
          if (path) { clip.thumb = path; rerenderTab(); }
        }),
        h('span', { class: 'adm-hint', text: 'Shown in the picker under the player when a project has several videos.' })));
  }

  // ---------- Top section (Page tab) ----------
  function check(obj, key, label) {
    return h('label', { class: 'adm-check' },
      h('input', { type: 'checkbox', checked: Boolean(obj[key]), onchange: (e) => { obj[key] = e.target.checked; changed(); } }),
      h('span', { text: label }));
  }

  function slider(obj, key, label, min, max, step, unit, hint) {
    const shown = h('span', { class: 'adm-value', text: `${obj[key]}${unit}` });
    return h('label', { class: 'adm-field' },
      h('span', { class: 'adm-label' }, label, ' ', shown),
      h('input', {
        type: 'range', min, max, step, value: obj[key],
        oninput: (e) => { obj[key] = Number(e.target.value); shown.textContent = `${obj[key]}${unit}`; changed(); },
      }),
      hint ? h('span', { class: 'adm-hint', text: hint }) : null);
  }

  function choice(obj, key, label, options, hint) {
    return field(label, h('select', {
      onchange: (e) => {
        const raw = e.target.value;
        obj[key] = typeof options[0][0] === 'number' ? Number(raw) : raw;
        changed();
      },
    }, options.map(([value, text]) => h('option', { value, text, selected: obj[key] === value }))), hint);
  }

  function heroTab() {
    const c = state.draft;
    const set = c.hero.layout;
    const group = (title, ...children) => h('div', { class: 'adm-form adm-group-box' }, h('h3', { class: 'adm-group', text: title }), ...children);
    const style = set.style || 'editor';
    const STYLES = [
      ['editor', 'Editing workspace: preview monitor and timeline playing your videos'],
      ['portrait', 'Portrait: a picture beside your name'],
      ['centered', 'Centred: your name and text in the middle'],
    ];
    return h('div', { class: 'adm-form' },
      h('p', { class: 'adm-help', text: 'Everything at the top of the page. Changes show on the page behind straight away.' }),
      group('Style',
        field('Layout', h('select', { onchange: (e) => { set.style = e.target.value; rerenderTab(); } },
          STYLES.map(([value, label]) => h('option', { value, text: label, selected: style === value }))),
        'Each style can use the background photo or video below.')),
      style === 'portrait' ? group('Portrait',
        h('div', { class: 'adm-field' },
          h('span', { class: 'adm-label', text: 'Picture' }),
          h('div', { class: 'adm-inline' },
            currentFile(c.hero.portrait),
            c.hero.portrait ? h('button', { class: 'adm-link', type: 'button', text: 'Remove', onclick: () => { c.hero.portrait = ''; rerenderTab(); } }) : null),
          filePicker('image/*', (file) => {
            const path = stageFile(file, `assets/portrait-${Date.now().toString(36)}${extension(file)}`);
            if (path) { c.hero.portrait = path; rerenderTab(); }
          }),
          h('span', { class: 'adm-hint', text: 'A portrait (taller than wide) works best. Empty uses the About photo.' })),
        slider(set, 'portraitSize', 'Picture size', 50, 120, 5, '%')) : null,
      h('div', { class: 'adm-form', 'data-adm-section': 'hero' },
        group('Text',
          field('Line under your name', text(c.hero, 'role')),
          field('Intro paragraph', area(c.hero, 'intro', 3)),
          field('Location and availability', text(c.hero, 'availability')))),
      group('Layout',
        check(set, 'nameOneLine', 'Name on one line (across the whole width)'),
        slider(set, 'nameScale', 'Name size', 60, 140, 5, '%', 'It never grows wider than the space it has.'),
        h('div', { class: 'adm-checks' },
          check(set, 'showRole', 'Line under your name'),
          check(set, 'showIntro', 'Intro paragraph'),
          check(set, 'showAvailability', 'Location and availability'),
          check(set, 'showWorkButton', '\u201CSee the work\u201D button'),
          check(set, 'showContactButton', '\u201CGet in touch\u201D button'),
          check(set, 'showResume', 'Resume link'))),
      style !== 'editor' ? null : group('Preview monitor',
        check(set, 'showMonitor', 'Show the monitor'),
        slider(set, 'monitorSize', 'Monitor size', 50, 100, 5, '%'),
        field('Label above the picture', text(set, 'monitorLabel', { placeholder: 'Program' })),
        choice(set, 'monitorStart', 'Where each clip starts', [['random', 'A random point in the video'], ['start', 'The beginning of the video']]),
        choice(set, 'monitorOrder', 'Clip order', [['featured', 'Featured projects first'], ['content', 'Same order as the Work list']]),
        h('p', { class: 'adm-hint', text: 'The monitor plays the uploaded videos of your projects (not YouTube ones). To leave one out, open the project in its Work section and tick \u201CHide from the top-section monitor\u201D.' })),
      style !== 'editor' ? null : group('Timeline',
        check(set, 'showTimeline', 'Show the timeline'),
        slider(set, 'timelineSeconds', 'Loop length', 12, 120, 2, ' s', 'How long the playhead takes to cross the whole timeline.'),
        choice(set, 'timelineFps', 'Timecode frame rate', [[24, '24 fps'], [25, '25 fps'], [30, '30 fps']]),
        h('div', { class: 'adm-checks' },
          check(set, 'showExtraTracks', 'Extra tracks (V2 and A2)'),
          check(set, 'showTrackLabels', 'Track names (V1, A1\u2026)'),
          check(set, 'showTimecode', 'Timecode'),
          check(set, 'allowScrub', 'Visitors can drag to scrub'))),
      group('Background',
        h('div', { class: 'adm-field' },
          h('span', { class: 'adm-label', text: 'Background photo' }),
          h('div', { class: 'adm-inline' },
            currentFile(c.hero.background),
            c.hero.background ? h('button', { class: 'adm-link', type: 'button', text: 'Remove', onclick: () => { c.hero.background = ''; rerenderTab(); } }) : null),
          filePicker('image/*', (file) => {
            const path = stageFile(file, `assets/hero-${Date.now().toString(36)}${extension(file)}`);
            if (path) { c.hero.background = path; rerenderTab(); }
          }),
          h('span', { class: 'adm-hint', text: 'Landscape, at least 1920 px wide. Empty shows the plain dark background.' })),
        field('Background video (optional)', text(c.hero, 'backgroundVideo', { type: 'url', placeholder: 'https://your-storage.example.com/videos/showreel-loop.mp4' }),
          'A direct link to a short MP4 on your own storage. It plays muted on a loop, with the photo shown while it loads. Empty uses the photo.'),
        slider(set, 'overlay', 'Darken photo/video', 0, 100, 5, '%', 'More darkening keeps the text easier to read.'),
        check(set, 'showGlow', 'Soft glow in the accent colour on the plain background')),
      h('button', {
        class: 'adm-btn',
        type: 'button',
        text: 'Reset top section settings to defaults',
        onclick: () => {
          if (!confirm('Reset the layout, monitor, timeline and background settings? Your style, text, photo and video stay.')) return;
          c.hero.layout = { ...(window.HERO_DEFAULTS || {}), style: set.style };
          rerenderTab();
        },
      }));
  }

  function reelTab() {
    const reel = state.draft.reel;
    const note = h('span', { class: 'adm-hint', text: reel.youtube ? `Video ID: ${reel.youtube}` : 'Empty shows “Showreel coming soon”.' });
    return h('div', { class: 'adm-form' },
      h('p', { class: 'adm-help', text: 'The big video in the Showreel section. Paste a YouTube link.' }),
      field('YouTube link', h('input', {
        type: 'url',
        value: reel.youtube ? `https://www.youtube.com/watch?v=${reel.youtube}` : '',
        placeholder: 'https://www.youtube.com/watch?v=…',
        oninput: (e) => {
          reel.youtube = youtubeId(e.target.value);
          note.textContent = reel.youtube ? `Video ID: ${reel.youtube}` : e.target.value ? 'That doesn’t look like a YouTube link.' : 'Empty shows “Showreel coming soon”.';
          changed();
        },
      })),
      note);
  }

  function aboutTab() {
    const about = state.draft.about;
    return h('div', { class: 'adm-form' },
      h('span', { class: 'adm-label', text: 'Bio paragraphs' }),
      about.paragraphs.map((p, i) => h('div', { class: 'adm-entry' },
        h('div', { class: 'adm-entry-head' }, h('span', { class: 'adm-hint', text: `Paragraph ${i + 1}` }), rowControls(about.paragraphs, i, 'paragraph')),
        paragraphInput(about, i))),
      h('button', { class: 'adm-btn', type: 'button', text: '+ Add paragraph', onclick: () => { about.paragraphs.push(''); rerenderTab(); } }),
      field('Skills', list(about, 'skills'), 'Separate with commas.'));
  }

  function paragraphInput(about, i) {
    if (translating('paragraphs')) {
      const tr = translationOf(about);
      tr.paragraphs = tr.paragraphs || [];
      return bind(h('textarea', { rows: 4, value: tr.paragraphs[i] || '', placeholder: about.paragraphs[i], oninput: (e) => { tr.paragraphs[i] = e.target.value; changed(); } }), tr.paragraphs, i);
    }
    return bind(h('textarea', { rows: 4, value: about.paragraphs[i], oninput: (e) => { about.paragraphs[i] = e.target.value; changed(); } }), about.paragraphs, i);
  }

  function experienceTab() {
    const entries = state.draft.experience;
    return h('div', { class: 'adm-form' },
      h('div', { class: 'adm-section-head' },
        h('p', { class: 'adm-help', text: 'Timeline entries, newest first.' }),
        h('button', {
          class: 'adm-btn adm-btn-primary',
          type: 'button',
          text: '+ Add entry',
          onclick: () => { entries.unshift({ date: '', role: '', org: '', text: '' }); rerenderTab(); },
        })),
      entries.map((entry, i) => h('div', { class: 'adm-entry is-open' },
        h('div', { class: 'adm-entry-head' }, bind(h('strong', { text: entry.role || '(new entry)' }), entry, 'role', '(new entry)'), rowControls(entries, i, 'entry')),
        h('div', { class: 'adm-form' },
          h('div', { class: 'adm-row2' }, field('Dates', text(entry, 'date', { placeholder: '2024 – Present' })), field('Role', text(entry, 'role'))),
          field('Company or project', text(entry, 'org')),
          field('What you did', area(entry, 'text', 3))))));
  }

  function toolkitTab() {
    const rows = state.draft.toolkit;
    return h('div', { class: 'adm-form' },
      h('div', { class: 'adm-section-head' },
        h('p', { class: 'adm-help', text: 'One row per discipline. Strongest tool first.' }),
        h('button', { class: 'adm-btn adm-btn-primary', type: 'button', text: '+ Add row', onclick: () => { rows.push({ label: '', tools: [] }); rerenderTab(); } })),
      rows.map((row, i) => h('div', { class: 'adm-entry is-open' },
        h('div', { class: 'adm-entry-head' }, bind(h('strong', { text: row.label || '(new row)' }), row, 'label', '(new row)'), rowControls(rows, i, 'row')),
        h('div', { class: 'adm-row2' }, field('Label', text(row, 'label')), field('Tools (comma separated)', list(row, 'tools'))))));
  }

  // Platforms always listed in the form; the others appear once picked from "Add a platform" or filled in
  const BASIC_PLATFORMS = ['instagram', 'linkedin', 'youtube', 'github', 'facebook'];
  const shownPlatforms = new Set();

  function linksBox() {
    const c = state.draft;
    const platforms = window.SITE_SOCIALS || [];
    const visible = platforms.filter((p) => BASIC_PLATFORMS.includes(p.key) || shownPlatforms.has(p.key) || (c.links[p.key] || '').trim());
    const hidden = platforms.filter((p) => !visible.includes(p));
    const footerBox = (key) => h('label', { class: 'adm-check adm-check-small' },
      h('input', {
        type: 'checkbox',
        checked: c.footerLinks.includes(key),
        onchange: (e) => {
          c.footerLinks = c.footerLinks.filter((k) => k !== key);
          if (e.target.checked) c.footerLinks.push(key);
          changed();
        },
      }),
      h('span', { text: 'In footer' }));

    return h('div', { class: 'adm-form', 'data-adm-section': 'links' },
      h('h3', { class: 'adm-group', text: 'Links' }),
      h('p', { class: 'adm-help', text: 'Every platform with an address gets an icon in the contact section (LinkedIn gets its own button there). Tick “In footer” to also list it at the bottom of the page. Leave one empty to hide it everywhere.' }),
      field('Email address (contact form and email link)', text(c.links, 'email', { type: 'email', placeholder: 'you@example.com' })),
      visible.map((p) => h('div', { class: 'adm-link-row' },
        field(p.name, text(c.links, p.key, { type: 'url', placeholder: 'https://…' })),
        footerBox(p.key))),
      hidden.length ? field('Add a platform', h('select', {
        onchange: (e) => { if (e.target.value) { shownPlatforms.add(e.target.value); rerenderTab(); } },
      }, h('option', { value: '', text: 'Choose…' }), hidden.map((p) => h('option', { value: p.key, text: p.name })))) : null,
      h('div', { class: 'adm-section-head' },
        h('span', { class: 'adm-label', text: 'Other links' }),
        h('button', { class: 'adm-btn', type: 'button', text: '+ Add link', onclick: () => { c.customLinks.push({ label: '', url: '', footer: true }); rerenderTab(); } })),
      c.customLinks.length ? null : h('span', { class: 'adm-hint', text: 'For anything not in the list above, like a personal website or shop. Shown with a globe icon.' }),
      c.customLinks.map((link, i) => h('div', { class: 'adm-entry is-open' },
        h('div', { class: 'adm-entry-head' },
          h('div', { class: 'adm-row2 adm-grow' }, text(link, 'label', { placeholder: 'Label, e.g. My shop' }), text(link, 'url', { type: 'url', placeholder: 'https://…' })),
          rowControls(c.customLinks, i, 'link')),
        check(link, 'footer', 'In footer'))));
  }

  // ---------- Page details in index.html ----------
  const escHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // The content file's address carries the save time (content/site.js?v=…), so a browser that has an
  // older copy stored has to fetch the new one
  function stampContentFile(html, content) {
    const stamp = content.savedAt ? `?v=${encodeURIComponent(content.savedAt)}` : '';
    return html.replace(/(<script src="content\/site\.js)[^"]*(")/, (match, before, after) => before + stamp + after);
  }

  // The latest save, kept in this browser so a reload shows it even before the host has published it
  // (js/main.js shows it, with a note, until the live site catches up)
  // Per site: several GitHub Pages sites of one account share an address (<user>.github.io/<repo>/)
  const LATEST_SAVE_KEY = `am-latest-save:${window.location.pathname.replace(/[^/]*$/, '')}`;
  function rememberLatestSave(content) {
    try { localStorage.setItem(LATEST_SAVE_KEY, JSON.stringify({ savedAt: content.savedAt, content })); } catch { /* storage full or blocked */ }
  }

  // Rewrites the spots index.html marks for this (title, meta tags, favicon, fonts, theme, name)
  function withSiteDetails(html, content) {
    const T = window.SiteTheme;
    const site = content.site;
    const name = site.name.trim();
    const words = name.split(/\s+/);
    const title = site.title.trim() || `${name} Portfolio`;
    const description = site.description.trim() || `${name}'s portfolio.`;
    let out = stampContentFile(html, content);
    const swap = (pattern, value) => { out = out.replace(pattern, (match, before, after) => before + value + after); };
    const meta = (key) => new RegExp(`(<meta[^>]*(?:name|property)="${key}"[^>]*\\scontent=")[^"]*(")`);
    swap(/(<title>)[^<]*(<\/title>)/, escHtml(title));
    ['og:title', 'twitter:title'].forEach((key) => swap(meta(key), escHtml(title)));
    ['description', 'og:description', 'twitter:description'].forEach((key) => swap(meta(key), escHtml(description)));
    swap(/(<link[^>]*id="favicon"[^>]*\shref=")[^"]*(")/, escHtml(T.favicon(site, content.theme, true)));
    swap(/(<link[^>]*id="theme-fonts"[^>]*\shref=")[^"]*(")/, escHtml(T.fontsHref(content.theme)));
    swap(/(<style id="theme-vars">)[^<]*(<\/style>)/, T.css(content.theme, true));
    swap(/(<h1[^>]*data-site="name"[^>]*>)[^<]*(<\/h1>)/, escHtml(name));
    swap(/(<a[^>]*data-site="logo"[^>]*>)[\s\S]*?(<\/a>)/, escHtml(words[0]) + (words.length > 1 ? `<span>${escHtml(words.slice(1).join(' '))}</span>` : ''));
    swap(/(<span data-site="footer">)[^<]*(<\/span>)/, escHtml(name));

    // Link preview picture and address: written fresh after the descriptions each time
    const base = siteAddress(site);
    const absolute = (path) => {
      try { return base ? new URL(path, base).href : path; } catch { return path; }
    };
    out = out.replace(/\n?<meta (?:property="og:image"|name="twitter:image"|property="og:url")[^>]*>/g, '');
    const extra = [
      base ? `<meta property="og:url" content="${escHtml(base)}">` : '',
      site.shareImage ? `<meta property="og:image" content="${escHtml(absolute(site.shareImage))}">` : '',
      site.shareImage ? `<meta name="twitter:image" content="${escHtml(absolute(site.shareImage))}">` : '',
    ].filter(Boolean).join('\n');
    if (extra) out = out.replace(/(<meta name="twitter:description"[^>]*>)/, (match) => `${match}\n${extra}`);
    swap(meta('twitter:card'), site.shareImage ? 'summary_large_image' : 'summary');
    return out;
  }

  // ---------- Save ----------
  async function save() {
    if (state.saving) return;
    if (!state.token) { showUnlock('Unlock to save. Unsaved changes are kept.'); return; }
    if (!isDirty()) { updateStatus('Nothing to save.'); return; }
    const saveBtn = screen.querySelector('.adm-top .adm-btn-primary');
    state.saving = true;
    if (saveBtn) saveBtn.disabled = true;
    try {
      // Someone (e.g. the other computer) may have saved since this panel loaded
      updateStatus('Checking GitHub…');
      const remote = await getFile(CONTENT_PATH);
      const remoteSha = remote ? remote.sha : null;
      if (remoteSha !== state.remoteSha && !confirm('The site content was changed on GitHub after you opened this panel (maybe from your other computer).\n\nOK = overwrite it with your version\nCancel = keep it (close and reopen the panel to load it)')) {
        updateStatus('Save cancelled. Nothing was changed.', 'error');
        return;
      }

      // Strip editor-only fields, stray spaces, and empty link rows and tags before writing
      const content = JSON.parse(JSON.stringify(state.draft, (key, value) => (key === 'i18n' || key === 'ui' ? compactI18n(value) : typeof value === 'string' ? value.trim() : value)));
      content.languages.ui = content.languages.ui || {};
      content.about.skills = content.about.skills.filter(Boolean);
      content.toolkit.forEach((row) => { row.tools = row.tools.filter(Boolean); });
      content.work.forEach((item) => {
        item.tools = item.tools.filter(Boolean);
        item.videos = item.videos.filter((clip) => clip.video || clip.youtube);
        item.images = item.images.filter((img) => img.src);
        item.videos.forEach((clip) => { delete clip._mode; });
        item.links = item.links.filter((l) => l.label && l.url);
      });
      content.customLinks = content.customLinks.filter((l) => l.url);

      // When it was saved: the page compares this with the copy this browser keeps (see main.js)
      content.savedAt = new Date().toISOString();

      // Everything goes in one commit (uploads, content, index.html), so the host publishes once
      const used = referencedPaths(content);
      const uploads = [...state.pending].filter(([path]) => used.has(path));
      const entries = [];
      for (let i = 0; i < uploads.length; i++) {
        const [path, file] = uploads[i];
        updateStatus(`Preparing ${file.name} (${i + 1}/${uploads.length})…`);
        entries.push({ path, contentB64: await fileToB64(file) });
      }
      entries.push({ path: CONTENT_PATH, contentB64: textToB64(serialize(content)) });
      // index.html: title, link previews, icon, fonts and colours (for search engines, previews and the
      // first paint), and a new address for the content file so browsers don't keep showing an old copy
      const index = await getFile(INDEX_PATH);
      if (index && index.content) {
        const html = b64ToText(index.content);
        const next = content.site.name.trim() ? withSiteDetails(html, content) : stampContentFile(html, content);
        if (next !== html) entries.push({ path: INDEX_PATH, contentB64: textToB64(next) });
      }
      updateStatus(uploads.length ? `Uploading ${uploads.length} file(s) and saving…` : 'Saving…');
      await commitFiles(entries, uploads.length ? `Admin: update site content (${uploads.length} new file(s))` : 'Admin: update site content');
      state.pending.clear();
      const saved = await getFile(CONTENT_PATH);
      state.remoteSha = saved ? saved.sha : null;
      rememberLatestSave(content);
      // Saved files stay previewed from their local copies until the host redeploys
      window.SITE_CONTENT = content;
      state.draft.work.forEach((item) => item.videos.forEach((clip) => { delete clip._mode; }));
      state.savedJson = snapshot();
      state.note = '';
      updateStatus('Saved. The live site updates in a minute or two.', 'ok');
      // First save after starting fresh: offer to delete the previous owner's files
      if (state.offerCleanup) {
        state.offerCleanup = false;
        showCleanup('Saved. The site you copied came with files your site doesn’t use, like the previous owner’s videos and photos. Delete them to keep your repository light?');
        return;
      }
      if (state.tab === 'work') rerenderTab();
    } catch (error) {
      updateStatus(`${error.message} Your changes are still here; try saving again.`, 'error');
    } finally {
      state.saving = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // The site's language changed (header switch or the picker above): show the draft in it and rebuild the forms
  document.addEventListener('site:languagechange', () => {
    if (!state.draft || !root || root.hidden) return;
    renderPage(state.draft);
    if (state.token && screen.querySelector('.adm-editor')) showEditor();
  });

  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault();
  });

  window.SiteAdmin = { toggle };
})();
