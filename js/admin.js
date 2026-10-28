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
    offerCleanup: false,
    updateChecked: false, // checked the kit for a newer version this session
    updateInfo: null, // the newer version found, for the notice and the Updates box // started fresh from a copy: offer to delete unused files after the first save
    tab: 'page',
    openRow: null, // the section open in the Page tab
    openLang: null, // the language whose interface text is open in the Site tab
    openItem: null,
    allProjects: false, // the Page tab shows every project instead of the outline
    projectCategory: '', // ...of this category ('' = all)
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
    c.theme = { preset: 'midnight', font: 'Geologica', headingFont: '', radius: 14, ...window.SiteTheme.fontStyle, ...(c.theme || {}) };
    c.theme.colors = { ...(c.theme.colors || {}) };
    c.theme.cursor = { ...(window.CURSOR_DEFAULTS || {}), ...(c.theme.cursor || {}) };
    c.theme.saved = (Array.isArray(c.theme.saved) ? c.theme.saved : []).map((scheme) => ({ name: '', preset: 'midnight', ...scheme, colors: { ...((scheme && scheme.colors) || {}) } }));
    c.theme.titleDot = c.theme.titleDot !== false;
    // Dark and light for visitors: theme.other holds the second version's own changes
    c.theme.switchable = Boolean(c.theme.switchable);
    c.theme.modeButton = ['icon', 'label', 'switch'].includes(c.theme.modeButton) ? c.theme.modeButton : 'icon';
    c.theme.other = c.theme.other && typeof c.theme.other === 'object' ? c.theme.other : {};
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
    // Pages besides the home page, each with its own sections (see "Pages" in js/main.js)
    c.pages = (Array.isArray(c.pages) ? c.pages : []).map((pg) => ({ title: '', nav: '', inMenu: true, ...pg, order: Array.isArray(pg.order) ? pg.order : [] }));
    c.sections.order = window.SiteSections.order(c, '');
    c.pages.forEach((pg) => { pg.order = window.SiteSections.order(c, pg.id); });
    [...window.SiteSections.builtin, ...c.workGrids.map((g) => g.id), ...c.customSections.map((sec) => sec.id)].forEach((id) => {
      // Text sections from before kept their title and menu settings on the section itself
      const legacy = c.customSections.find((sec) => sec.id === id) || {};
      ['title', 'nav', 'inMenu', 'background'].forEach((key) => {
        if (key in legacy && !(c.sections[id] && key in c.sections[id])) c.sections[id] = { ...(c.sections[id] || {}), [key]: legacy[key] };
        delete legacy[key];
      });
      const look = window.SiteSections.settings(c, id);
      c.sections[id] = {
        title: '', nav: '', anchor: '', bgColor: '', bgImage: '', ...(c.sections[id] || {}),
        inMenu: look.inMenu, background: look.background, titleStyle: look.titleStyle, titleSize: look.titleSize,
        width: look.width, spacing: look.spacing, device: look.device, bgDarken: look.bgDarken,
        ...(look.layout ? { layout: look.layout } : {}),
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
    c.contactForm = { service: '', key: '', ...(c.contactForm || {}) };
    c.highlights = { autoplay: true, seconds: 6, ...(c.highlights || {}) };
    c.projectView = c.projectView === 'page' ? 'page' : 'popup';
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

  // An added section's content (see "Added sections" in js/main.js); its title, menu and look are in
  // content.sections like every section's
  const SECTION_FIELDS = {
    text: { text: '', columns: 1, image: '', imageAlt: '', imagePlace: 'below', buttons: [] },
    gallery: { columns: 3, shape: 'square', images: [] },
    video: { youtube: '', video: '', thumb: '', caption: '' },
    quotes: { items: [] },
    logos: { style: 'grey', items: [] },
    numbers: { items: [] },
    faq: { items: [] },
    cta: { text: '', sub: '', buttons: [] },
  };
  const ITEM_FIELDS = {
    quotes: { quote: '', name: '', role: '', photo: '' },
    logos: { src: '', alt: '', url: '' },
    numbers: { value: '', label: '' },
    faq: { q: '', a: '' },
  };

  function normalizeSection(sec) {
    const type = SECTION_FIELDS[sec.type] ? sec.type : 'text';
    const out = { intro: '', align: type === 'cta' ? 'center' : 'left', ...clone(SECTION_FIELDS[type]), ...sec, type };
    // Text sections from before had a single button
    if (sec.button) {
      if (!Array.isArray(sec.buttons) && sec.button.label) out.buttons = [{ ...sec.button, style: 'primary' }];
      delete out.button;
    }
    if (out.buttons) out.buttons = out.buttons.map((b, n) => ({ label: '', url: '', style: n ? 'ghost' : 'primary', ...b }));
    if (out.items) out.items = out.items.map((item) => ({ ...ITEM_FIELDS[type], ...item }));
    if (out.images) out.images = out.images.map((img) => ({ src: '', alt: '', caption: '', ...img }));
    return out;
  }

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
    'title', 'teaser', 'desc', 'thumbAlt', 'label', 'date', 'org', 'text', 'monitorLabel', 'nav', 'description',
    'quote', 'q', 'a', 'caption', 'sub']);
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
    content.customSections.forEach((sec) => {
      [sec.image, sec.video, sec.thumb].forEach((path) => paths.add(path));
      (sec.images || []).forEach((img) => paths.add(img.src));
      (sec.items || []).forEach((item) => { paths.add(item.photo); paths.add(item.src); });
    });
    Object.values(content.sections).forEach((set) => { paths.add(set && set.bgImage); paths.add(set && set.bgImageOther); });
    content.work.forEach((item) => {
      paths.add(item.thumb);
      item.videos.forEach((clip) => { paths.add(clip.video); paths.add(clip.thumb); paths.add(clip.preview); });
      item.images.forEach((img) => paths.add(img.src));
    });
    paths.delete('');
    paths.delete(undefined);
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

  const changed = () => {
    preview();
    scheduleHistory();
  };

  // ---------- Undo / redo ----------
  // Every change to the draft is kept as a step (typing counts as one step per pause; see also
  // rerenderTab), up to 100 back.
  // Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) outside text fields, or the arrows in the top bar. Text fields keep
  // the browser's own undo for what's typed in them.
  const HISTORY_STEPS = 100;
  const history = { past: [], future: [], current: '' };
  let historyTimer = 0;

  function resetHistory() {
    clearTimeout(historyTimer);
    historyTimer = 0;
    history.past = [];
    history.future = [];
    history.current = state.draft ? snapshot() : '';
    updateHistoryButtons();
  }

  function scheduleHistory() {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(recordHistory, 500);
    updateHistoryButtons();
  }

  function recordHistory() {
    clearTimeout(historyTimer);
    historyTimer = 0;
    if (!state.draft) return;
    const now = snapshot();
    if (now === history.current) { updateHistoryButtons(); return; }
    history.past.push(history.current);
    if (history.past.length > HISTORY_STEPS) history.past.shift();
    history.current = now;
    history.future = [];
    updateHistoryButtons();
  }

  function stepHistory(from, to) {
    stopEditing();
    recordHistory(); // a change still waiting to be recorded is the step to undo
    if (!from.length || !state.draft) return;
    to.push(history.current);
    history.current = from.pop();
    state.draft = JSON.parse(history.current);
    // The snapshot leaves out empty interface text; the forms expect the object
    state.draft.languages.ui = state.draft.languages.ui || {};
    openPicture = null;
    renderPage(state.draft);
    if (screen && screen.querySelector('.adm-editor')) {
      const anchor = panelAnchor();
      showEditor();
      restorePanelAnchor(anchor);
    }
    updateStatus();
  }

  const undo = () => stepHistory(history.past, history.future);
  const redo = () => stepHistory(history.future, history.past);

  function updateHistoryButtons() {
    if (!screen) return;
    screen.querySelectorAll('.adm-undo').forEach((btn) => { btn.disabled = !history.past.length && !historyTimer; });
    screen.querySelectorAll('.adm-redo').forEach((btn) => { btn.disabled = !history.future.length; });
  }

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !root || root.hidden || !screen.querySelector('.adm-editor')) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
  });

  // ---------- Editing on the page ----------
  // While the panel is open, the page behind is an editor too (Preview hides all of this):
  // - Any text tagged data-field (index.html, js/main.js) can be clicked and typed in, one at a time. Enter
  //   finishes (in a bio paragraph it starts the next one; in text with formatting it's a new line, and
  //   Ctrl+Enter finishes), Esc puts back what was there, and clicking elsewhere finishes.
  // - Each section gets a bar to move, hide, duplicate, delete it or open it in the panel, and a
  //   "+ Add section" button on its top edge.
  // - Items in lists (data-entries / data-entry: projects, timeline, quotes…) get a small bar to move,
  //   duplicate or delete them, and each list a "+ Add" tile at its end.
  // - Things without text to type (showreel, photo, links) keep a ✎ that opens them in the panel.
  // - Page and panel follow each other: clicking in a section opens its row in the panel, and the row
  //   open in the panel is outlined on the page.
  // The page isn't redrawn while text is being typed in it (that would throw the typing away); it catches
  // up as soon as the typing finishes.
  let editing = null; // { node, path, rich, slot, stored, handlers }
  let previewing = false;

  function renderPage(content) {
    if (editing) return; // stopEditing() redraws
    const anchor = pageAnchor();
    document.documentElement.classList.add('adm-editing'); // before rendering, so draft projects show
    window.renderSite(content);
    decoratePage();
    restorePageAnchor(anchor);
    syncPhone();
  }

  // ---------- Nothing moves under you ----------
  // A redraw rebuilds lists and adds or removes the editing extras (tiles, faded hidden sections, empty
  // texts), and the browser can't keep the view still when what you're looking at is rebuilt. So before a
  // redraw, note what's at the top of the view (by its name in the content, so it can be found again) and
  // afterwards scroll so it's exactly where it was. The panel does the same for what was clicked in it.
  // The names the page keeps whether the panel is open or not
  const PAGE_KEYS = ['data-field', 'data-entry', 'data-block', 'id'];

  function pageAnchor() {
    if (window.scrollY < 2) return null; // at the very top: stay at the top
    const line = Math.min(Math.round(window.innerHeight * 0.3), 280);
    // The smallest named part crossing that line, else the nearest one below it, else its whole section
    const parts = [...document.querySelectorAll('main [data-field], main [data-entry], main [data-block], main > section[id], .site-footer [data-field]')]
      .filter((node) => !node.closest(CHROME) && node.getClientRects().length);
    const boxes = parts.map((node) => [node, node.getBoundingClientRect(), node.matches('main > section')]);
    const across = boxes.filter(([, box, whole]) => !whole && box.top <= line && box.bottom >= line).sort((a, b) => a[1].height - b[1].height)[0];
    const below = boxes.filter(([, box, whole]) => !whole && box.top > line).sort((a, b) => a[1].top - b[1].top)[0];
    const section = boxes.find(([, box, whole]) => whole && box.top <= line && box.bottom >= line);
    const pick = across || below || section;
    if (!pick) return null;
    const [node, box] = pick;
    const key = PAGE_KEYS.find((k) => node.hasAttribute(k));
    const selector = `[${key}="${CSS.escape(node.getAttribute(key))}"]`;
    return { selector, index: [...document.querySelectorAll(selector)].indexOf(node), top: box.top };
  }

  function restorePageAnchor(anchor) {
    if (!anchor) return;
    const node = document.querySelectorAll(anchor.selector)[Math.max(anchor.index, 0)];
    if (!node || !node.getClientRects().length) return;
    const delta = node.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, behavior: 'instant' });
  }

  // What was last clicked or focused in the panel: a redraw of the panel keeps it where it was
  let panelTarget = null;

  function panelInView(node) {
    const box = node.getBoundingClientRect();
    const view = root.getBoundingClientRect();
    const top = (screen.querySelector('.adm-top') || root).getBoundingClientRect().bottom;
    return box.bottom > top && box.top < view.bottom;
  }

  function panelAnchor() {
    if (!screen || !state.draft) return null;
    let node = panelTarget && screen.contains(panelTarget) && panelInView(panelTarget) ? panelTarget : null;
    if (!node) {
      const top = (screen.querySelector('.adm-top') || root).getBoundingClientRect().bottom;
      node = [...screen.querySelectorAll('.adm-body .adm-outline-row, .adm-body .adm-entry, .adm-body .adm-group-box, .adm-body .adm-field')]
        .find((n) => n.getBoundingClientRect().top >= top) || null;
    }
    if (!node) return null;
    // Rows, projects and entries are found again by their names; inside one, by the way down to the node
    const keyed = node.closest('[data-row], [data-index], [data-key]');
    const chain = [];
    for (let n = keyed; n && n !== screen; n = n.parentElement) {
      const key = ['data-row', 'data-index', 'data-key'].find((k) => n.hasAttribute(k));
      if (key) chain.unshift(`[${key}="${CSS.escape(n.getAttribute(key))}"]`);
    }
    const path = [];
    for (let n = node; n && n !== (keyed || screen); n = n.parentElement) path.unshift([...n.parentElement.children].indexOf(n));
    return { chain, path, top: node.getBoundingClientRect().top };
  }

  function restorePanelAnchor(anchor) {
    if (!anchor) return;
    let scope = screen;
    anchor.chain.forEach((selector) => { scope = (scope && scope.querySelector(selector)) || scope; });
    let node = scope;
    anchor.path.forEach((i) => { node = (node && node.children[i]) || node; });
    if (!node || node === screen) return;
    const delta = node.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) root.scrollTop += delta;
  }

  // Redraws straight away (after a click on the page) instead of after the short pause typing gets
  function renderNow() {
    clearTimeout(previewTimer);
    if (state.draft) renderPage(state.draft);
    updateStatus();
  }

  // Moving a section or an entry: the page scrolls along with it, so it stays where it was on screen
  // instead of its neighbour sliding into view. find() returns its element, before and after the move.
  function keepInPlace(find, move) {
    const before = find();
    const top = before ? before.getBoundingClientRect().top : null;
    move();
    renderNow();
    const after = find();
    if (top !== null && after) window.scrollBy({ top: after.getBoundingClientRect().top - top, behavior: 'instant' });
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
    if (!phone) return;
    phone.wrap.classList.toggle('is-beside-panel', windowState.mode === 'docked' && !isMinimised());
    phone.wrap.classList.toggle('is-left', dockedLeft());
  }

  function syncPhone() {
    const win = phone && phone.frame.contentWindow;
    if (!win || !win.renderSite || !state.draft) return;
    win.SITE_ASSET_OVERRIDES = window.SITE_ASSET_OVERRIDES;
    const draft = win.JSON.parse(JSON.stringify(state.draft));
    if (win.SitePages && win.SitePages.current() !== shownPage()) {
      win.renderSite(draft); // so it knows the pages
      win.SitePages.show(shownPage());
    }
    win.renderSite(draft);
    if (win.SiteI18n && win.SiteI18n.lang !== lang()) win.SiteI18n.setLanguage(lang());
  }

  // While typing on the page, the phone preview follows after a short pause
  let phoneTimer = 0;
  const syncPhoneSoon = () => {
    clearTimeout(phoneTimer);
    phoneTimer = setTimeout(syncPhone, 300);
  };

  const itemFields = (item) => [...(item.matches('[data-field]') ? [item] : []), ...item.querySelectorAll('[data-field]')];
  // Everything the panel adds to the page
  const CHROME = '.adm-pencil, .adm-section-bar, .adm-insert, .adm-item-bar, .adm-add-tile, .adm-part-bar, .adm-part-tag';
  const getPath = (path) => path.split('.').reduce((node, key) => (node == null ? node : node[key]), state.draft);
  const sectionOf = (node) => {
    const section = node.closest('[data-adm-row]');
    return section ? section.dataset.admRow : null;
  };

  // A button in the bars on the page; clicks don't reach the page under it (a project would open)
  function barBtn(label, title, onclick, opts = {}) {
    const btn = h('button', {
      class: `adm-bar-btn${opts.danger ? ' is-danger' : ''}`,
      type: 'button',
      title,
      'aria-label': title,
      disabled: opts.disabled,
      'aria-pressed': opts.pressed == null ? null : String(opts.pressed),
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        onclick(e);
      },
    });
    if (opts.html) btn.innerHTML = label;
    else btn.textContent = label;
    return btn;
  }

  function decoratePage() {
    document.documentElement.classList.add('adm-editing');
    document.querySelectorAll(CHROME).forEach((node) => node.remove());
    // ✎ for things without text to type: their form in the panel
    document.querySelectorAll('[data-edit-item]').forEach((item) => {
      if (item.matches('main > section') || itemFields(item).length) return;
      item.appendChild(h('button', {
        class: 'adm-pencil',
        type: 'button',
        title: 'Edit in the admin panel',
        'aria-label': 'Edit in the admin panel',
        text: '✎',
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation(); // don't open the project pop-up underneath
          editFromPage(item.dataset.editItem);
        },
      }));
    });
    // A bar on every section, and "+ Add section" above each one (and below the last)
    const order = pageOrder();
    [...order.map((id) => [id, document.getElementById(id)]), ['footer', document.querySelector('.site-footer')]]
      .forEach(([id, node]) => {
        if (!node) return;
        node.dataset.admRow = id;
        node.appendChild(sectionBar(id));
        const at = order.indexOf(id);
        if (at >= 0) node.appendChild(insertLine(at));
        if (at >= 0 && at === order.length - 1) node.appendChild(insertLine(order.length, true));
      });
    markSelected();
    document.querySelectorAll('[data-entries]').forEach(decorateList);
  }

  function undecoratePage() {
    stopEditing();
    previewing = false;
    document.documentElement.classList.remove('adm-editing', 'adm-previewing');
    window.SiteTheme.showMode(''); // the version this visitor sees, not the one last edited
    document.querySelectorAll(`${CHROME}, .adm-preview-pill`).forEach((node) => node.remove());
    document.querySelectorAll('[data-adm-row]').forEach((node) => {
      node.classList.remove('adm-selected');
      delete node.dataset.admRow;
    });
  }

  // The section open in the panel is outlined on the page
  function markSelected() {
    document.querySelectorAll('[data-adm-row]').forEach((node) => node.classList.toggle('adm-selected', node.dataset.admRow === state.openRow));
    decorateBlocks();
  }

  // ---------- Layouts and parts of a section ----------
  // A layout is a ready-made arrangement of a section (content.sections.<id>.layout, or a Text section's
  // imagePlace); the parts (blocks) are its title, intro, text, video… which can be put in another order
  // and adjusted one by one (blockOrder / blockLook, see applyBlocks in js/main.js).
  const T = 't';
  const P = 'p';
  const B = 'b';
  // Little drawings of the layouts: [x, y, width, height, text line / picture / box] on a 48×32 card
  const DRAWINGS = {
    'photo-right': [[4, 7, 20, 3, T], [4, 13, 22, 2, T], [4, 17, 18, 2, T], [30, 3, 16, 26, P]],
    'photo-left': [[2, 3, 16, 26, P], [24, 7, 20, 3, T], [24, 13, 22, 2, T], [24, 17, 18, 2, T]],
    'photo-above': [[4, 2, 40, 15, P], [4, 20, 20, 3, T], [4, 26, 32, 2, T]],
    'video:stacked': [[4, 3, 20, 3, T], [4, 9, 40, 20, P]],
    'video:side': [[4, 7, 14, 3, T], [4, 13, 12, 2, T], [21, 5, 24, 18, P]],
    'contact:stacked': [[4, 3, 20, 3, T], [4, 9, 40, 4, B], [4, 15, 40, 4, B], [4, 21, 40, 8, B]],
    'contact:side': [[4, 5, 14, 3, T], [4, 11, 12, 2, T], [22, 3, 22, 4, B], [22, 9, 22, 4, B], [22, 15, 22, 12, B]],
    cards: [[3, 6, 20, 20, B], [25, 6, 20, 20, B]],
    large: [[6, 5, 36, 22, B]],
    'text:below': [[4, 3, 20, 3, T], [4, 9, 30, 2, T], [4, 14, 40, 15, P]],
    'text:above': [[4, 2, 40, 15, P], [4, 20, 20, 3, T], [4, 26, 30, 2, T]],
  };
  DRAWINGS['text:side'] = DRAWINGS['photo-right'];
  DRAWINGS['text:side-left'] = DRAWINGS['photo-left'];

  function drawing(kind, value) {
    let parts;
    if (kind === 'work' || kind === 'grid') {
      const n = value === 'auto' ? 3 : Number(value.slice(-1));
      const w = (40 - (n - 1) * 3) / n;
      parts = [0, 1].flatMap((row) => Array.from({ length: n }, (_, i) => [4 + i * (w + 3), 4 + row * 13, w, 11, B]));
    } else {
      const group = { reel: 'video', video: 'video', contact: 'contact', text: 'text' }[kind];
      parts = DRAWINGS[group ? `${group}:${value}` : value] || [];
    }
    return `<svg viewBox="0 0 48 32" aria-hidden="true">${parts.map(([x, y, w, hgt, k]) => `<rect class="is-${k}" x="${x}" y="${y}" width="${w}" height="${hgt}" rx="1"/>`).join('')}</svg>`;
  }

  function layoutLabel(kind, value) {
    if (kind === 'text') return { below: 'Picture below', above: 'Picture above', side: 'Picture right', 'side-left': 'Picture left' }[value];
    if (kind === 'contact') return { stacked: 'Form below', side: 'Form beside' }[value];
    if (kind === 'reel' || kind === 'video') return { stacked: 'Video below', side: 'Video beside' }[value];
    return { 'photo-right': 'Photo right', 'photo-left': 'Photo left', 'photo-above': 'Photo above', auto: 'Fit the screen', 'cols-2': '2 per row',
      'cols-3': '3 per row', 'cols-4': '4 per row', cards: 'Side by side', large: 'One per row, big' }[value] || value;
  }

  // The layouts a section can have: { kind, values, current, pick(value) }, or null
  function layoutOptions(id) {
    const kind = kindOf(id);
    if (kind === 'text') {
      const sec = state.draft.customSections.find((s) => s.id === id);
      if (!sec || !sec.image) return null;
      const values = ['below', 'above', 'side', 'side-left'];
      return { kind, values, current: values.includes(sec.imagePlace) ? sec.imagePlace : 'below', pick: (v) => { sec.imagePlace = v; } };
    }
    const values = (window.SECTION_LAYOUTS || {})[kind];
    if (!values) return null;
    const set = state.draft.sections[id];
    return { kind, values, current: values.includes(set.layout) ? set.layout : values[0], pick: (v) => { set.layout = v; } };
  }

  function layoutPicker(id, options, after) {
    return h('div', { class: 'adm-layouts' }, options.values.map((value) => {
      const btn = h('button', {
        class: `adm-layout${value === options.current ? ' is-active' : ''}`,
        type: 'button',
        'aria-pressed': String(value === options.current),
        onclick: (e) => {
          e.stopPropagation();
          keepInPlace(() => document.getElementById(id), () => {
            options.pick(value);
            if (after) after();
            rerenderTab();
          });
        },
      }, h('span', { text: layoutLabel(options.kind, value) }));
      btn.insertAdjacentHTML('afterbegin', drawing(options.kind, value));
      return btn;
    }));
  }

  const BLOCK_LABELS = {
    title: 'Title', intro: 'Intro line', bio: 'Bio', skills: 'Skills', video: 'Video', highlights: 'Highlights slider', filters: 'Filter buttons',
    grid: 'Project cards', list: 'List', formtitle: 'Form title', form: 'Message form', alt: 'Email address', heading: 'Title and intro', text: 'Text',
    buttons: 'Buttons', gallery: 'Pictures', caption: 'Caption', quotes: 'Quotes', logos: 'Logos', numbers: 'Numbers', faq: 'Questions', line: 'Big line', sub: 'Line under it',
  };

  // The section's parts as the page has them (in their own order), and in the order they show
  function naturalBlocks(id) {
    const section = document.getElementById(id);
    return section ? [...new Set([...section.querySelectorAll('[data-blocks] > [data-block]')].map((b) => b.dataset.block))] : [];
  }

  function shownBlocks(id) {
    const names = naturalBlocks(id);
    const order = state.draft.sections[id].blockOrder || [];
    const rank = (n) => (order.includes(n) ? order.indexOf(n) : order.length + names.indexOf(n));
    return [...names].sort((a, b) => rank(a) - rank(b));
  }

  function setBlockOrder(id, names) {
    const set = state.draft.sections[id];
    if (names.join() === naturalBlocks(id).join()) delete set.blockOrder;
    else set.blockOrder = names;
  }

  const blockLookOf = (id, name) => ((state.draft.sections[id].blockLook || {})[name]) || {};

  // Settings left at "as is" are dropped, so an untouched section stores nothing
  function setBlockLook(id, name, key, value) {
    const set = state.draft.sections[id];
    const looks = { ...(set.blockLook || {}) };
    const look = { ...(looks[name] || {}), [key]: value };
    Object.keys(look).forEach((k) => { if (!look[k]) delete look[k]; });
    if (Object.keys(look).length) looks[name] = look;
    else delete looks[name];
    if (Object.keys(looks).length) set.blockLook = looks;
    else delete set.blockLook;
  }

  // A change to a part; the part stays where it is on screen
  function blockChange(id, name, change) {
    keepInPlace(() => document.querySelector(`#${id} [data-blocks] > [data-block="${name}"]`), () => {
      change();
      rerenderTab();
    });
  }

  function moveBlockBy(id, name, dir) {
    blockChange(id, name, () => {
      const names = shownBlocks(id);
      const i = names.indexOf(name);
      const j = i + dir;
      if (j < 0 || j >= names.length) return;
      [names[i], names[j]] = [names[j], names[i]];
      setBlockOrder(id, names);
    });
  }

  function resetBlocks(id) {
    const set = state.draft.sections[id];
    keepInPlace(() => document.getElementById(id), () => {
      delete set.blockOrder;
      delete set.blockLook;
      rerenderTab();
    });
  }

  const ALIGNS = ['', 'left', 'center', 'right'];
  const SPACES = [[-2, 'Less space above'], [-1, 'A bit less'], [0, 'Space above: as is'], [1, 'A bit more'], [2, 'More'], [3, 'Much more'], [4, 'Most']];

  // Panel (Look and layout): every part with its order, alignment, space above and width
  function partsBox(id) {
    const names = shownBlocks(id);
    if (names.length < 2) return null;
    const set = state.draft.sections[id];
    const select = (name, key, options) => {
      const look = blockLookOf(id, name);
      const current = String(look[key] || (key === 'space' ? 0 : ''));
      return h('select', {
        'aria-label': `${BLOCK_LABELS[name] || name}: ${key}`,
        onchange: (e) => blockChange(id, name, () => setBlockLook(id, name, key, key === 'space' ? Number(e.target.value) : e.target.value)),
      }, options.map(([value, label]) => h('option', { value, text: label, selected: String(value) === current })));
    };
    return h('div', { class: 'adm-field' },
      h('div', { class: 'adm-section-head' },
        h('span', { class: 'adm-label', text: 'Parts' }),
        set.blockOrder || set.blockLook ? h('button', { class: 'adm-link', type: 'button', text: 'Reset parts', onclick: () => resetBlocks(id) }) : null),
      h('p', { class: 'adm-hint', text: 'Their order, alignment, space above and width. On the page, click a part of this section for the same controls above it.' }),
      names.map((name, i) => h('div', { class: 'adm-part-row' },
        h('span', { class: 'adm-part-name', text: BLOCK_LABELS[name] || name }),
        h('div', { class: 'adm-row-controls' },
          iconBtn('↑', 'Move up', () => moveBlockBy(id, name, -1), i === 0),
          iconBtn('↓', 'Move down', () => moveBlockBy(id, name, 1), i === names.length - 1)),
        select(name, 'align', [['', 'Align: as is'], ['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]),
        select(name, 'space', SPACES),
        select(name, 'width', [['', 'Width: as is'], ['medium', 'Medium'], ['narrow', 'Narrow']]))));
  }

  // ---------- Parts on the page ----------
  // In the section open in the panel, hovering a part outlines it with its name. Clicking it (or into its
  // text) selects it: a toolbar above it moves it and sets its alignment, space above and width. The
  // toolbar sits next to the part, not in it, so it stays while the part's text is typed in.
  const ALIGN_ICON = (a) => {
    const x = { left: [4, 4, 4], center: [6, 4, 8], right: [8, 4, 12] }[a] || [4, 4, 4];
    const w = a ? [12, 16, 8] : [16, 16, 16];
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${[7, 12, 17].map((y, i) => `<path d="M${x[i]} ${y}h${w[i]}"/>`).join('')}</svg>`;
  };
  let selectedPart = null; // { id: the section, name: the part }

  function decorateBlocks() {
    document.querySelectorAll('.adm-part-bar, .adm-part-tag').forEach((node) => node.remove());
    document.querySelectorAll('.adm-part-selected').forEach((node) => node.classList.remove('adm-part-selected'));
    const id = state.openRow;
    const section = id && state.draft.sections[id] && document.querySelector(`[data-adm-row="${id}"]`);
    if (!section) return;
    const parts = [...section.querySelectorAll('[data-blocks] > [data-block]')];
    parts.forEach((node) => {
      if (editing && editing.node === node) return; // not inside the text being typed
      node.appendChild(h('span', { class: 'adm-part-tag', 'aria-hidden': 'true', text: BLOCK_LABELS[node.dataset.block] || node.dataset.block }));
    });
    if (!selectedPart || selectedPart.id !== id) return;
    const node = parts.find((n) => n.dataset.block === selectedPart.name);
    if (!node) return;
    node.classList.add('adm-part-selected');
    const bar = partBar(id, selectedPart.name, node);
    node.parentElement.appendChild(bar);
    placePartBar();
    // Its size settles after it's shown (it can wrap at first), and the part can grow: it follows both
    if (partObserver) partObserver.disconnect();
    if ('ResizeObserver' in window) {
      partObserver = new ResizeObserver(() => placePartBar());
      partObserver.observe(bar);
      partObserver.observe(node);
    }
  }

  let partObserver = null;

  // Just above the selected part (its list of parts is the bar's frame)
  function placePartBar() {
    const bar = document.querySelector('.adm-part-bar');
    const node = document.querySelector('.adm-part-selected');
    if (!bar || !node) return;
    bar.style.left = `${node.offsetLeft}px`;
    bar.style.top = `${node.offsetTop - bar.offsetHeight - 10}px`;
  }

  window.addEventListener('resize', placePartBar);

  function partBar(id, name, node) {
    const names = shownBlocks(id);
    const i = names.indexOf(name);
    const label = BLOCK_LABELS[name] || name;
    const look = blockLookOf(id, name);
    const space = Number(look.space) || 0;
    const set = (key, value) => blockChange(id, name, () => setBlockLook(id, name, key, value));
    const group = (title, ...buttons) => h('span', { class: 'adm-part-group' }, h('span', { class: 'adm-part-label', text: title }), ...buttons);
    // One alignment button: each press the next one (as it was, left, centre, right), its icon showing which
    const ALIGN_NAMES = { '': 'as it was', left: 'left', center: 'centre', right: 'right' };
    const align = look.align || '';
    const nextAlign = ALIGNS[(ALIGNS.indexOf(align) + 1) % ALIGNS.length];
    return h('div', { class: 'adm-part-bar', role: 'toolbar', 'aria-label': `${label}: arrange` },
      h('span', { class: 'adm-part-name', text: label }),
      names.length > 1 ? group('',
        barBtn('↑', `Move the ${label.toLowerCase()} up`, () => moveBlockBy(id, name, -1), { disabled: i <= 0 }),
        barBtn('↓', `Move the ${label.toLowerCase()} down`, () => moveBlockBy(id, name, 1), { disabled: i === names.length - 1 })) : null,
      barBtn(ALIGN_ICON(align), `Alignment: ${ALIGN_NAMES[align]} (click for ${ALIGN_NAMES[nextAlign]})`, () => set('align', nextAlign), { html: true, pressed: Boolean(align) }),
      group('Space',
        barBtn('−', 'Less space above', () => set('space', Math.max(space - 1, -2)), { disabled: space <= -2 }),
        h('span', { class: 'adm-part-value', text: space > 0 ? `+${space}` : String(space) }),
        barBtn('+', 'More space above', () => set('space', Math.min(space + 1, 4)), { disabled: space >= 4 })),
      group('Width', ...[['', 'Full'], ['medium', 'Medium'], ['narrow', 'Narrow']].map(([w, text]) => barBtn(text, `Width: ${text.toLowerCase()}`,
        () => set('width', w), { pressed: (look.width || '') === w }))),
      look.align || look.width || space ? barBtn('↺ Reset', 'Put this part back as it was', () => blockChange(id, name, () => {
        ['align', 'space', 'width'].forEach((key) => setBlockLook(id, name, key, ''));
      })) : null,
      barBtn('✕', 'Close', () => {
        selectedPart = null;
        decorateBlocks();
      }));
  }

  // Layouts from the section bar: ▦ opens the same little drawings as in the panel
  function layoutButton(id) {
    const options = layoutOptions(id);
    if (!options) return null;
    const menu = h('div', { class: 'adm-insert-menu adm-layout-menu', hidden: true }, layoutPicker(id, options, () => { menu.hidden = true; }));
    return h('div', { class: 'adm-bar-pop' },
      barBtn('▦', `Layout: ${layoutLabel(options.kind, options.current)}`, () => {
        const open = menu.hidden;
        document.querySelectorAll('.adm-insert-menu').forEach((m) => { m.hidden = true; });
        menu.hidden = !open;
      }),
      menu);
  }

  // ---------- Section bars ----------
  function sectionBar(id) {
    const c = state.draft;
    const order = pageOrder();
    const at = order.indexOf(id);
    const fixed = at < 0; // the footer stays last
    const builtin = window.SiteSections.builtin.includes(id) || id === 'hero'; // can't be deleted or duplicated
    const hidden = Boolean(c.hidden[id]);
    const kind = id === 'hero' || fixed ? id : kindOf(id);
    const label = id === 'hero' ? 'Top section' : id === 'footer' ? 'Footer' : sectionLabel(id);
    const change = (fn) => {
      fn();
      rerenderTab();
      renderNow();
    };
    return h('div', { class: 'adm-section-bar' },
      h('button', {
        class: 'adm-bar-name',
        type: 'button',
        title: 'Open it in the panel',
        onclick: (e) => { e.stopPropagation(); selectSection(id, { reveal: true }); },
      }, h('span', { class: 'adm-badge', text: KIND_LABELS[kind] }), h('span', { text: hidden ? `${label} (hidden)` : label })),
      fixed ? null : barBtn('↑', 'Move up', () => keepInPlace(() => document.getElementById(id), () => change(() => moveTo(order, at, at - 1, true))), { disabled: at === 0 }),
      fixed ? null : barBtn('↓', 'Move down', () => keepInPlace(() => document.getElementById(id), () => change(() => moveTo(order, at, at + 1, false))), { disabled: at === order.length - 1 }),
      id === 'hero' ? null : barBtn(hidden ? EYE_OFF : EYE, hidden ? 'Hidden: click to show it' : 'Hide it (stays here, faded, while you edit)', () => change(() => {
        if (hidden) delete c.hidden[id];
        else c.hidden[id] = true;
      }), { html: true, pressed: !hidden }),
      fixed || id === 'hero' ? null : layoutButton(id),
      fixed || builtin ? null : barBtn('⧉', 'Duplicate section', () => duplicateSection(id)),
      fixed || id === 'hero' ? null : barBtn('✕', builtin ? 'Remove from the page' : 'Delete section', () => removeSection(id), { danger: true }),
      barBtn('⚙', 'Settings: open it in the panel', () => selectSection(id, { reveal: true })));
  }

  // "+ Add section" on a section's top edge (or the last one's bottom edge): new sections go in there
  function insertLine(at, below) {
    const menu = h('div', { class: 'adm-insert-menu', hidden: true }, NEW_SECTIONS.map(([kind, name, desc]) => h('button', {
      class: 'adm-bar-btn',
      type: 'button',
      title: desc,
      text: name,
      onclick: (e) => {
        e.stopPropagation();
        addSection(kind, at);
        renderNow();
      },
    })));
    return h('div', { class: `adm-insert${below ? ' is-below' : ''}` },
      h('button', {
        class: 'adm-insert-btn',
        type: 'button',
        text: '+ Add section',
        onclick: (e) => {
          e.stopPropagation();
          const open = menu.hidden;
          document.querySelectorAll('.adm-insert-menu').forEach((m) => { m.hidden = true; });
          menu.hidden = !open;
        },
      }),
      menu);
  }

  // ---------- Lists on the page ----------
  // What one entry of a list is called
  function entryKind(path) {
    const fixed = { work: 'project', experience: 'entry', toolkit: 'row', 'about.skills': 'skill', 'about.paragraphs': 'paragraph' };
    if (fixed[path]) return fixed[path];
    if (/\.images$/.test(path)) return 'picture';
    const sec = getPath(path.replace(/\.items$/, ''));
    return { quotes: 'quote', logos: 'logo', numbers: 'number', faq: 'question' }[sec && sec.type] || 'item';
  }

  // What a new one starts as (projects, pictures and logos are made in addEntry)
  const NEW_ENTRIES = {
    entry: () => ({ date: '', role: 'New role', org: '', text: '' }),
    row: () => ({ label: 'New', tools: ['A tool'] }),
    skill: () => 'New skill',
    paragraph: () => 'A new paragraph.',
    quote: () => ({ ...ITEM_FIELDS.quotes, quote: 'A new quote.', name: 'Their name' }),
    number: () => ({ value: '10', label: 'something counted' }),
    question: () => ({ q: 'A new question?', a: 'The answer.' }),
  };

  const entryIndex = (node) => Number(node.dataset.entry.split('.').pop());

  function decorateList(list) {
    const path = list.dataset.entries;
    const arr = getPath(path);
    if (!Array.isArray(arr)) return;
    const what = entryKind(path);
    const vertical = list.dataset.axis === 'y';
    const nodes = [...list.querySelectorAll(':scope > [data-entry]')];
    nodes.forEach((node, n) => node.appendChild(itemBar(path, arr, what, nodes, n, vertical)));
    list.appendChild(h(/^(OL|UL)$/.test(list.tagName) ? 'li' : 'div', { class: 'adm-add-tile' },
      h('button', {
        type: 'button',
        text: `+ Add ${what}`,
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          addEntry(path, what, list);
        },
      })));
  }

  // Move, duplicate and delete; the arrows swap with the neighbour shown (a Work grid can skip projects)
  function itemBar(path, arr, what, nodes, n, vertical) {
    const index = entryIndex(nodes[n]);
    const item = arr[index];
    const swapWith = (other) => {
      const j = entryIndex(other);
      keepInPlace(() => document.querySelector(`[data-entry="${path}.${keepAt}"]`), () => {
        keepAt = j;
        changeList(path, (a) => { [a[index], a[j]] = [a[j], a[index]]; });
      });
    };
    let keepAt = index; // where the moved entry is: before the move, then after it
    return h('div', { class: 'adm-item-bar' },
      barBtn(vertical ? '↑' : '←', `Move this ${what} ${vertical ? 'up' : 'left'}`, () => swapWith(nodes[n - 1]), { disabled: n === 0 }),
      barBtn(vertical ? '↓' : '→', `Move this ${what} ${vertical ? 'down' : 'right'}`, () => swapWith(nodes[n + 1]), { disabled: n === nodes.length - 1 }),
      what === 'project' ? barBtn('Draft', item.draft ? 'Draft: only you see it. Click to put it on the live site' : 'Make it a draft (off the live site)', () => changeList(path, () => { item.draft = !item.draft; }), { pressed: Boolean(item.draft) }) : null,
      what === 'project' && state.draft.categories.length > 1 ? categoryPicker(path, item) : null,
      barBtn('⧉', `Duplicate this ${what}`, () => changeList(path, (a, main) => {
        const copy = clone(a[index] === undefined ? '' : a[index]);
        if (main && what === 'project' && copy.title) copy.title = `${copy.title} (copy)`;
        a.splice(index + 1, 0, copy);
      })),
      barBtn('✕', `Delete this ${what}`, () => {
        if (confirm(`Delete this ${what}?`)) changeList(path, (a) => { a.splice(index, 1); });
      }, { danger: true }));
  }

  // A project's category, picked on its card (clicks and keys stay here instead of opening the project)
  function categoryPicker(path, item) {
    const keep = (e) => e.stopPropagation();
    return h('select', {
      class: 'adm-bar-select',
      title: 'Category',
      'aria-label': 'Category',
      onclick: keep,
      onkeydown: keep,
      onchange: (e) => changeList(path, () => { item.type = e.target.value; }),
    }, state.draft.categories.map((cat) => h('option', { value: cat.id, text: cat.label || cat.id, selected: item.type === cat.id })));
  }

  // Changes a list from the page. Lists of plain text (skills, bio paragraphs) are translated item by item,
  // so their translations get the same change. The project open in the panel stays open.
  function changeList(path, change) {
    const arr = getPath(path);
    const work = state.draft.work;
    const open = work[state.openItem];
    const keys = path.split('.');
    const key = keys.pop();
    const owner = keys.length ? getPath(keys.join('.')) : null;
    const translations = arr.some((v) => typeof v === 'string') && owner && owner.i18n
      ? Object.values(owner.i18n).map((tr) => tr[key]).filter(Array.isArray) : [];
    translations.forEach((tr) => { while (tr.length < arr.length) tr.push(''); });
    change(arr, true);
    translations.forEach((tr) => change(tr, false));
    if (open) state.openItem = work.includes(open) ? work.indexOf(open) : null;
    rerenderTab();
    renderNow();
  }

  function addEntry(path, what, list) {
    const arr = getPath(path);
    // Pictures and logos start from a file
    if (what === 'picture' || what === 'logo') {
      const sec = getPath(path.replace(/\.(images|items)$/, ''));
      const input = h('input', { type: 'file', accept: 'image/*', multiple: what === 'picture' });
      input.addEventListener('change', () => {
        [...input.files].forEach((file, n) => {
          const src = stageFile(file, `assets/sections/${slug(sectionLabel(sec.id))}-${what}-${Date.now().toString(36)}${n}${extension(file)}`);
          if (src) arr.push(what === 'picture' ? { src, alt: '', caption: '' } : { ...ITEM_FIELDS.logos, src });
        });
        rerenderTab();
        renderNow();
      });
      input.click();
      return;
    }
    let entry;
    if (what === 'project') {
      // In the category picked in the grid's filter buttons, else the grid's first
      const sectionId = sectionOf(list);
      const allowed = ((state.draft.sections[sectionId] || {}).categories || [])[0];
      const filter = list.closest('section') && list.closest('section').querySelector('.filter-btn.is-active');
      const picked = filter && filter.dataset.filter !== 'all' ? filter.dataset.filter : '';
      entry = normalizeWork({ type: picked || allowed || (state.draft.categories[0] || {}).id, title: 'New project', teaser: 'One line about it.' });
    } else {
      entry = NEW_ENTRIES[what] ? NEW_ENTRIES[what]() : {};
    }
    arr.push(entry);
    if (what === 'project') state.openItem = arr.length - 1;
    rerenderTab();
    renderNow();
    // Straight into typing its first text, all of it selected
    const node = document.querySelector(`[data-entry="${path}.${arr.length - 1}"]`);
    const first = node && (node.matches('[data-field]') ? node : node.querySelector('[data-field]'));
    if (first) startEditing(first, { selectAll: true });
  }

  // ---------- Typing on the page ----------
  // Where a field's text is kept: in the content, or (while another language is shown) in the translation
  // on the nearest object it belongs to, e.g. "work.2.title" → work[2].i18n.nl.title
  function slotIn(obj, path) {
    const keys = path.split('.');
    const last = keys.pop();
    const parent = keys.reduce((node, key, i) => {
      if (node[key] == null) node[key] = /^\d+$/.test(keys[i + 1] || last) ? [] : {};
      return node[key];
    }, obj);
    return { obj: parent, key: last };
  }

  function fieldSlot(path) {
    // "ui:contact.formTitle": interface text, kept as the editing language's own wording (languages.ui)
    if (path.startsWith('ui:')) {
      const L = state.draft.languages;
      const ui = L.ui = L.ui && typeof L.ui === 'object' ? L.ui : {};
      ui[lang()] = ui[lang()] || {};
      return { obj: ui[lang()], key: path.slice(3) };
    }
    const keys = path.split('.');
    if (!translating(keys.filter((k) => !/^\d+$/.test(k)).pop())) return slotIn(state.draft, path);
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
    return slotIn(translationOf(owner), rest.join('.'));
  }

  function startEditing(node, { event, selectAll, atStart } = {}) {
    if (editing && editing.node === node) return;
    stopEditing();
    const path = node.dataset.field;
    const rich = node.hasAttribute('data-rich');
    // Text that can have formatting (bold, italic, links, spacing) is typed as it shows; the rest as plain text
    const marks = rich || node.hasAttribute('data-inline') || node.classList.contains('reveal');
    const slot = fieldSlot(path);
    editing = { node, path, rich, marks, slot, stored: slot.obj[slot.key] };
    node.querySelectorAll(CHROME).forEach((n) => n.remove());
    // A title is typed as one line of text, not letter by letter
    if (node.classList.contains('reveal')) {
      const raw = node.dataset.raw != null ? node.dataset.raw : node.textContent;
      node.textContent = '';
      window.SiteText.inline(node, raw);
    }
    node.classList.add('adm-typing');
    document.documentElement.classList.add('adm-is-typing');
    node.contentEditable = marks ? 'true' : 'plaintext-only';
    if (node.contentEditable !== 'plaintext-only' && node.contentEditable !== 'true') node.contentEditable = 'true';
    editing.handlers = { input: onEditInput, keydown: onEditKey, paste: pastePlainText, drop: (e) => e.preventDefault() };
    Object.entries(editing.handlers).forEach(([type, fn]) => node.addEventListener(type, fn));
    node.focus({ preventScroll: true });
    placeCaret(node, event, selectAll, atStart);
    showTypingHint();
    // The panel opens this text's section (and project)
    const project = node.closest('[data-edit-item^="work."]');
    selectSection(sectionOf(node), { item: project ? Number(project.dataset.editItem.split('.')[1]) : undefined });
  }

  function placeCaret(node, event, selectAll, atStart) {
    let range = event && document.caretRangeFromPoint ? document.caretRangeFromPoint(event.clientX, event.clientY) : null;
    if (!range || !node.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(node);
      if (!selectAll) range.collapse(Boolean(atStart));
    }
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function onEditInput() {
    const { node, rich, marks, slot } = editing;
    const typed = marks ? toMarkup(node, rich) : node.textContent.replace(/\n/g, ' ');
    slot.obj[slot.key] = typed.replace(/ /g, ' ');
    node.classList.remove('is-empty');
    syncPanel();
    updateStatus();
    scheduleHistory();
    syncPhoneSoon();
    showTypingHint();
    placePartBar();
  }

  function onEditKey(e) {
    // Keys stay in the text (a work card would open its pop-up on Enter or Space); the admin shortcut gets through
    if (!(e.ctrlKey && e.altKey)) e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      editing.slot.obj[editing.slot.key] = editing.stored;
      syncPanel();
      stopEditing();
      return;
    }
    // Ctrl+B bold, Ctrl+I italic, Ctrl+K link (and nothing the page can't keep, like underline)
    if (editing.marks && (e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      const run = { b: () => toggleMark('bold'), i: () => toggleMark('italic'), k: toggleLink, u: () => {} }[key];
      if (run) {
        e.preventDefault();
        run();
        return;
      }
    }
    if (e.key !== 'Enter') return;
    if (editing.rich && !(e.ctrlKey || e.metaKey)) return; // a new paragraph (Shift+Enter: a new line in it)
    e.preventDefault();
    if (/^about\.paragraphs\.\d+$/.test(editing.path) && !e.ctrlKey && !e.metaKey && !translating('paragraphs')) splitParagraph();
    else stopEditing();
  }

  // Enter in a bio paragraph: the text after the cursor becomes the next paragraph
  function splitParagraph() {
    const { node, path } = editing;
    const i = Number(path.split('.').pop());
    // What's after the cursor moves out, with its formatting
    const tail = document.createElement('div');
    const selection = window.getSelection();
    if (selection.rangeCount && node.contains(selection.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.setStart(selection.anchorNode, selection.anchorOffset);
      tail.appendChild(range.extractContents());
    }
    const after = toMarkup(tail).trimStart();
    editing.slot.obj[editing.slot.key] = toMarkup(node).trimEnd();
    stopEditing();
    changeList('about.paragraphs', (a, main) => a.splice(i + 1, 0, main ? after : ''));
    const next = document.querySelector(`[data-field="about.paragraphs.${i + 1}"]`);
    if (next) startEditing(next, { atStart: true });
  }

  function stopEditing() {
    if (!editing) return;
    const { node, handlers } = editing;
    editing = null;
    Object.entries(handlers || {}).forEach(([type, fn]) => node.removeEventListener(type, fn));
    node.removeAttribute('contenteditable');
    node.classList.remove('adm-typing');
    document.documentElement.classList.remove('adm-is-typing');
    hideTypingHint();
    if (node.contains(document.activeElement)) document.activeElement.blur();
    changed(); // redraws the page with the text as it shows (formatting, title letters) and records the step
  }

  function pastePlainText(e) {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  }

  // ---------- Formatting typed on the page ----------
  // The text being typed, back to the marks the page reads (see parseInline in js/main.js):
  // **bold**, *italic*, [words](link) and [[wide:words]]. Marks only hold letters: spaces at their
  // edges go outside, and a mark inside the same mark adds nothing.
  const SPACINGS = [['tight', 'Tight'], ['', 'Normal'], ['wide', 'Wide'], ['wider', 'Wider']];
  const SPACING_CLASSES = window.SiteText.spacing.map((name) => `.ls-${name}`).join(', ');
  const spacingOf = (node) => window.SiteText.spacing.find((name) => node.classList.contains(`ls-${name}`)) || '';

  function marksOf(node, inside = {}) {
    let out = '';
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) { out += child.data.replace(/\u00a0/g, ' '); return; }
      if (child.nodeType !== 1 || child.matches(CHROME)) return;
      const tag = child.tagName;
      if (tag === 'BR') { out += '\n'; return; }
      const wrap = (open, close, more) => {
        const [, lead, words, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(marksOf(child, { ...inside, ...more }));
        return words ? `${lead}${open}${words}${close}${trail}` : lead + trail;
      };
      const space = spacingOf(child);
      const href = tag === 'A' ? child.dataset.href || child.getAttribute('href') : '';
      if ((tag === 'STRONG' || tag === 'B') && !inside.bold) out += wrap('**', '**', { bold: true });
      else if ((tag === 'EM' || tag === 'I') && !inside.italic) out += wrap('*', '*', { italic: true });
      else if (space && inside.space !== space) out += wrap(`[[${space}:`, ']]', { space });
      else if (href && !inside.link) out += wrap('[', `](${href.replace(/[\s)]/g, encodeURIComponent)})`, { link: true });
      else out += marksOf(child, inside);
    });
    return out;
  }

  // Marks of the same kind side by side become one (bold "o" + bold "ld" is **old**, not **o****ld**)
  function mergeMarks(node) {
    [...node.children].forEach((child) => {
      mergeMarks(child);
      const link = (n) => n.dataset.href || n.getAttribute('href');
      let next = child.nextSibling;
      while (next && next.nodeType === 1 && /^(STRONG|B|EM|I|SPAN|A)$/.test(child.tagName)
        && next.tagName === child.tagName && next.className === child.className && link(next) === link(child)) {
        child.append(...next.childNodes);
        next.remove();
        next = child.nextSibling;
      }
    });
    return node;
  }

  // A paragraph text (rich): its paragraphs and lists, the way it was typed in the panel
  function toMarkup(typed, rich) {
    const node = mergeMarks(typed.cloneNode(true));
    if (!rich) return marksOf(node).replace(/\s*\n\s*/g, ' ');
    const blocks = [];
    let loose = null; // text typed straight into the box, before there is a paragraph
    node.childNodes.forEach((child) => {
      if (child.nodeType === 1 && /^(UL|OL)$/.test(child.tagName)) {
        loose = null;
        blocks.push([...child.children].map((li) => `- ${marksOf(li).replace(/\s*\n\s*/g, ' ').trim()}`).join('\n'));
      } else if (child.nodeType === 1 && /^(P|DIV|LI|H\d)$/.test(child.tagName)) {
        loose = null;
        blocks.push(marksOf(child));
      } else {
        if (loose === null) { loose = blocks.length; blocks.push(''); }
        const one = document.createElement('div');
        one.appendChild(child.cloneNode(true));
        blocks[loose] += marksOf(one);
      }
    });
    return blocks.map((block) => block.replace(/^\n+|\n+$/g, '')).filter((block) => block.trim()).join('\n\n');
  }

  // The selection, if it's in the text being typed
  function editRange() {
    const selection = window.getSelection();
    if (!editing || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return editing.node.contains(range.commonAncestorContainer) ? range : null;
  }

  // The selection cut per paragraph or list item, so marks never hold more than one
  function blockRanges(range) {
    const blocks = editing.rich ? [...editing.node.querySelectorAll('p, li, div')].filter((b) => !b.querySelector('p, li, div')) : [];
    if (!blocks.length) return [range];
    return blocks.filter((b) => range.intersectsNode(b)).map((b) => {
      const part = document.createRange();
      part.selectNodeContents(b);
      if (b.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset);
      if (b.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
      return part;
    }).filter((part) => !part.collapsed);
  }

  // The text nodes a range has selected letters of
  function textIn(range) {
    const box = range.commonAncestorContainer;
    const nodes = [];
    if (box.nodeType === 3) nodes.push(box);
    else {
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) if (range.intersectsNode(walker.currentNode)) nodes.push(walker.currentNode);
    }
    return nodes.filter((n) => {
      const from = n === range.startContainer ? range.startOffset : 0;
      const to = n === range.endContainer ? range.endOffset : n.data.length;
      return n.data.slice(from, to).trim();
    });
  }

  const markAbove = (n, selector) => {
    const found = (n.nodeType === 1 ? n : n.parentElement).closest(selector);
    return found && found !== editing.node && editing.node.contains(found) ? found : null;
  };

  // Two empty markers keep a range's place while the marks around it are taken apart and put back
  function pin(range) {
    const a = h('span', { class: 'adm-pin' });
    const b = h('span', { class: 'adm-pin' });
    const end = range.cloneRange();
    end.collapse(false);
    end.insertNode(b);
    const start = range.cloneRange();
    start.collapse(true);
    start.insertNode(a);
    return {
      a,
      b,
      range() {
        const r = document.createRange();
        r.setStartAfter(a);
        r.setEndBefore(b);
        return r;
      },
    };
  }

  // Takes a mark off the pinned part: what's before and after it keeps the mark
  function unmark(pinned, selector) {
    for (let guard = 0; guard < 50; guard += 1) {
      const mark = textIn(pinned.range()).map((n) => markAbove(n, selector)).find(Boolean);
      if (!mark) return;
      const head = document.createRange();
      head.setStart(mark, 0);
      if (mark.contains(pinned.a)) head.setEndBefore(pinned.a);
      else head.setEnd(mark, 0);
      const tail = document.createRange();
      tail.setEnd(mark, mark.childNodes.length);
      if (mark.contains(pinned.b)) tail.setStartAfter(pinned.b);
      else tail.setStart(mark, mark.childNodes.length);
      const before = head.extractContents();
      const after = tail.extractContents();
      if (before.textContent) { const copy = mark.cloneNode(false); copy.appendChild(before); mark.before(copy); }
      if (after.textContent) { const copy = mark.cloneNode(false); copy.appendChild(after); mark.after(copy); }
      mark.replaceWith(...mark.childNodes);
    }
  }

  function wrapRange(pinned, make, selector) {
    const range = pinned.range();
    const box = make();
    box.appendChild(range.extractContents());
    box.querySelectorAll(selector).forEach((m) => m.replaceWith(...m.childNodes));
    range.insertNode(box);
  }

  // Runs a change on the selection (each paragraph of it), keeps it selected and saves what's typed
  function onSelection(change, { whole } = {}) {
    let range = editRange();
    if (!range) return;
    if (range.collapsed) {
      if (!whole) return;
      range = document.createRange();
      range.selectNodeContents(editing.node);
    }
    const pins = blockRanges(range).map(pin);
    pins.forEach(change);
    if (pins.length) {
      const all = document.createRange();
      all.setStartAfter(pins[0].a);
      all.setEndBefore(pins[pins.length - 1].b);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(all);
    }
    pins.forEach(({ a, b }) => { a.remove(); b.remove(); });
    editing.node.querySelectorAll(`strong, b, em, i, a, ${SPACING_CLASSES}`).forEach((m) => { if (!m.textContent) m.remove(); });
    editing.node.normalize();
    onEditInput();
  }

  const MARKS = { bold: ['strong, b', () => document.createElement('strong')], italic: ['em, i', () => document.createElement('em')] };
  const isMarked = (range, selector) => {
    const letters = textIn(range);
    return letters.length > 0 && letters.every((n) => markAbove(n, selector));
  };

  function toggleMark(kind) {
    const [selector, make] = MARKS[kind];
    const range = editRange();
    if (!range || range.collapsed) return;
    const on = blockRanges(range).every((part) => isMarked(part, selector));
    onSelection((pinned) => (on ? unmark(pinned, selector) : wrapRange(pinned, make, selector)));
  }

  // Letter spacing for the selection (or, with nothing selected, the whole text); '' is the normal spacing
  function setSpacing(name) {
    onSelection((pinned) => {
      unmark(pinned, SPACING_CLASSES);
      if (name) wrapRange(pinned, () => h('span', { class: `ls-${name}` }), SPACING_CLASSES);
    }, { whole: true });
  }

  // A link on the selection, or off it if it already is one
  function toggleLink() {
    const range = editRange();
    if (!range || range.collapsed) return;
    if (isMarked(range, 'a')) {
      onSelection((pinned) => unmark(pinned, 'a'));
      return;
    }
    const kept = range.cloneRange();
    const url = prompt('Link address (https://…, mailto:… or #contact)');
    if (!editing) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(kept);
    if (!url || !url.trim()) return;
    // The address is kept aside (data-href), so nothing typed runs while editing; the page checks it when drawn
    onSelection((pinned) => wrapRange(pinned, () => h('a', { class: 'text-link', href: '#', 'data-href': url.trim() }), 'a'));
  }

  // What the selection has, for the bar's buttons
  function selectionState() {
    const range = editRange();
    const now = { has: Boolean(range && !range.collapsed), bold: false, italic: false, link: false, spacing: null };
    if (!range) return now;
    const look = range.collapsed ? (() => { const r = document.createRange(); r.selectNodeContents(editing.node); return r; })() : range;
    const letters = textIn(look);
    now.bold = now.has && isMarked(range, MARKS.bold[0]);
    now.italic = now.has && isMarked(range, MARKS.italic[0]);
    now.link = now.has && isMarked(range, 'a');
    const names = new Set(letters.map((n) => { const m = markAbove(n, SPACING_CLASSES); return m ? spacingOf(m) : ''; }));
    now.spacing = names.size === 1 ? [...names][0] : names.size ? null : '';
    return now;
  }

  // The bar over the text being typed: B, I, link and letter spacing (for text that can have them), and
  // which keys do what. It sits above the text (where the section and item bars are, hidden while typing),
  // or below when there's no room under the site's header, and on touch screens, where the phone's own
  // copy and paste menu opens above.
  let typingHint = null;

  function buildTypingHint() {
    const { rich, path, marks } = editing;
    const keys = rich ? 'Enter: new paragraph · Ctrl+Enter: done · Esc: cancel'
      : /^about\.paragraphs\./.test(path) && !translating('paragraphs') ? 'Enter: new paragraph · Click elsewhere: done · Esc: cancel'
        : 'Enter: done · Esc: cancel';
    // mousedown is stopped so the text keeps its selection
    const tool = (name, label, title, run) => h('button', {
      class: 'adm-fmt', type: 'button', 'data-fmt': name, text: label, title, 'aria-label': title,
      onmousedown: (e) => e.preventDefault(), onclick: run,
    });
    const bar = h('div', { class: `adm-typing-hint${marks ? ' adm-format-bar' : ''}`, role: marks ? 'toolbar' : null, 'aria-label': marks ? 'Formatting' : null, 'aria-hidden': marks ? null : 'true' },
      marks ? [
        tool('bold', 'B', 'Bold (Ctrl+B)', () => toggleMark('bold')),
        tool('italic', 'I', 'Italic (Ctrl+I)', () => toggleMark('italic')),
        tool('link', '🔗', 'Link (Ctrl+K)', toggleLink),
        h('span', { class: 'adm-fmt-sep' }),
        h('span', { class: 'adm-fmt-label', text: 'Spacing' }),
        ...SPACINGS.map(([name, label]) => tool(`ls:${name}`, label, name ? `${label} letter spacing (the selection, or all of it)` : 'Normal letter spacing', () => setSpacing(name))),
        h('span', { class: 'adm-fmt-sep' }),
      ] : null,
      h('span', { class: 'adm-fmt-keys', text: keys }));
    document.body.appendChild(bar);
    return bar;
  }

  function showTypingHint() {
    if (!editing) return;
    const { node } = editing;
    if (!typingHint || typingHint._for !== node) {
      hideTypingHint();
      typingHint = buildTypingHint();
      typingHint._for = node;
    }
    if (editing.marks) updateFormatBar();
    const box = node.getBoundingClientRect();
    const header = document.querySelector('.site-header');
    const roof = header ? Math.max(header.getBoundingClientRect().bottom, 0) : 0;
    const height = typingHint.offsetHeight;
    const above = !window.matchMedia('(pointer: coarse)').matches && box.top - height - 10 >= roof + 4;
    const room = document.documentElement.clientWidth - typingHint.offsetWidth - 8;
    typingHint.classList.toggle('is-below', !above);
    typingHint.style.left = `${Math.max(Math.min(box.left, room), 8) + window.scrollX}px`;
    typingHint.style.top = `${(above ? box.top - height - 10 : box.bottom + 10) + window.scrollY}px`;
  }

  function updateFormatBar() {
    if (!typingHint || !editing || !editing.marks) return;
    const now = selectionState();
    typingHint.querySelectorAll('.adm-fmt').forEach((button) => {
      const name = button.dataset.fmt;
      const spacing = name.startsWith('ls:');
      const on = spacing ? now.spacing === name.slice(3) : now[name];
      button.classList.toggle('is-active', Boolean(on));
      button.setAttribute('aria-pressed', String(Boolean(on)));
      // B, I and link need words selected; spacing without a selection is for the whole text
      button.disabled = !spacing && !now.has;
    });
  }

  // It follows the text when the page moves under it (the panel docking, the window resizing)
  document.addEventListener('selectionchange', () => { if (editing && typingHint) showTypingHint(); });
  new ResizeObserver(() => { if (editing && typingHint) showTypingHint(); }).observe(document.body);

  function hideTypingHint() {
    if (typingHint) typingHint.remove();
    typingHint = null;
  }

  const editingPage = () => Boolean(state.draft && root && !root.hidden && !previewing && document.documentElement.classList.contains('adm-editing'));

  // Clicking text starts typing in it; clicking elsewhere in a section opens that section in the panel
  document.addEventListener('click', (e) => {
    if (!editingPage() || !e.target.closest) return;
    if (e.target.closest(`.adm-root, .adm-edge, .adm-phone, .modal-overlay, .adm-typing-hint, ${CHROME}`)) return;
    const part = e.target.closest('[data-blocks] > [data-block]');
    selectedPart = part ? { id: sectionOf(part), name: part.dataset.block } : null;
    const node = e.target.closest('[data-field]');
    if (node) {
      e.preventDefault();
      e.stopPropagation(); // a project card would open its pop-up
      if (!editing || editing.node !== node) startEditing(node, { event: e });
      return;
    }
    selectSection(sectionOf(e.target));
  }, true);

  // Clicking outside the text being typed finishes it (clicks in the panel don't, so you can check the form)
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest) return;
    if (editing && !editing.node.contains(e.target) && !e.target.closest('.adm-root, .adm-edge, .adm-typing-hint')) stopEditing();
    if (!e.target.closest('.adm-insert, .adm-bar-pop')) document.querySelectorAll('.adm-insert-menu').forEach((menu) => { menu.hidden = true; });
    if (!e.target.closest('.adm-more-wrap')) document.querySelectorAll('.adm-menu').forEach((menu) => { menu.hidden = true; });
  }, true);

  // ---------- Page and panel follow each other ----------
  // Opens a section's row in the panel (and a project's form), without taking focus from the page
  function selectSection(id, { item, reveal } = {}) {
    if (!id || !state.draft) return;
    const panelChanges = state.tab !== 'page' || state.allProjects || state.openRow !== id || (item !== undefined && state.openItem !== item);
    state.tab = 'page';
    state.allProjects = false;
    state.openRow = id;
    if (item !== undefined) state.openItem = item;
    markSelected();
    if (!screen || !screen.querySelector('.adm-editor')) return;
    if (reveal && isMinimised()) restore();
    if (panelChanges) showEditor();
    if (!panelChanges && !reveal) return;
    const row = screen.querySelector(`.adm-outline-row[data-row="${id}"]`);
    if (!row) return;
    const target = (item !== undefined && row.querySelector('.adm-row-body .adm-entry-list > .adm-entry.is-open')) || row;
    root.scrollTo({ top: target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 80, behavior: 'smooth' });
  }

  // ---------- Preview ----------
  // The page as visitors see it: no bars, outlines or drafts. The panel slides away; the pill at the
  // bottom (or Esc, or the Admin tab) comes back.
  function setPreviewing(on) {
    if (previewing === on) return;
    stopEditing();
    // Noted before anything changes: hiding the editing extras already moves things
    const anchor = pageAnchor();
    previewing = on;
    document.documentElement.classList.toggle('adm-previewing', on);
    document.querySelectorAll('.adm-preview-pill').forEach((pill) => pill.remove());
    if (on) {
      document.body.appendChild(h('button', { class: 'adm-preview-pill', type: 'button', onclick: () => setPreviewing(false) },
        h('span', { class: 'adm-preview-dot', 'aria-hidden': 'true' }),
        h('span', { text: 'Preview: the page as visitors see it' }),
        h('strong', { text: 'Back to editing' })));
      minimise();
    } else {
      restore();
    }
    renderNow(); // draft projects go and come back
    restorePageAnchor(anchor);
  }

  document.addEventListener('keydown', (e) => {
    if (previewing && e.key === 'Escape') setPreviewing(false);
  });

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
    state.allProjects = false;
    state.rowTab = 'content';
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
    // A big photo is swapped for a smaller copy once it's ready (saving waits for it)
    if (file.type in SHRINK_QUALITY) {
      const job = shrinkPicture(file).catch(() => null).then((smaller) => {
        if (shrinking.get(path) !== job) return;
        shrinking.delete(path);
        if (!smaller || state.pending.get(path) !== file) return;
        state.pending.set(path, smaller);
        window.SITE_ASSET_OVERRIDES[path] = URL.createObjectURL(smaller);
        preview();
      });
      shrinking.set(path, job);
    }
    return path;
  }

  // ---------- Pictures shrink on upload ----------
  // A photo wider or taller than 2400 px, or heavier than 500 KB, is scaled down and saved again in its own
  // format (so its name stays the same) before it's uploaded. That keeps the site quick and drops the
  // camera's hidden details (place, device). GIF, SVG and animated pictures stay as they are, and so does
  // a picture the copy wouldn't make clearly smaller.
  const SHRINK_EDGE = 2400;
  const SHRINK_QUALITY = { 'image/jpeg': 0.85, 'image/webp': 0.85, 'image/png': undefined };
  const shrinking = new Map(); // path -> the job making its smaller copy

  // Animated PNG ("acTL") and WebP ("ANIM") say so near the start of the file
  async function isAnimated(file) {
    const bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    const tag = file.type === 'image/png' ? 'acTL' : file.type === 'image/webp' ? 'ANIM' : '';
    if (!tag) return false;
    const code = [...tag].map((ch) => ch.charCodeAt(0));
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (bytes[i] === code[0] && bytes[i + 1] === code[1] && bytes[i + 2] === code[2] && bytes[i + 3] === code[3]) return true;
    }
    return false;
  }

  async function shrinkPicture(file) {
    if (await isAnimated(file)) return null;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, SHRINK_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 500 * 1024) {
      bitmap.close();
      return null;
    }
    const canvas = h('canvas', { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, file.type, SHRINK_QUALITY[file.type]));
    // Not every browser can write every format (it falls back to PNG): keep the original then
    if (!blob || blob.type !== file.type || blob.size > file.size * 0.9) return null;
    return new File([blob], file.name, { type: file.type, lastModified: Date.now() });
  }

  function clearPending() {
    Object.values(window.SITE_ASSET_OVERRIDES).forEach((url) => URL.revokeObjectURL(url));
    window.SITE_ASSET_OVERRIDES = {};
    state.pending.clear();
    shrinking.clear();
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
    // Also clicks without a pointer (Enter on a button): noted before the click redraws the panel
    ['pointerdown', 'focusin', 'click'].forEach((type) => root.addEventListener(type, (e) => { panelTarget = e.target; }, true));
    // Shown on the right edge while the panel is minimised; the dot means unsaved changes
    edgeTab = h('button', { class: 'adm-edge', type: 'button', hidden: true, 'aria-label': 'Show admin panel', onclick: restore },
      h('span', { text: 'Admin' }),
      h('span', { class: 'adm-edge-dot', hidden: true }));
    document.body.append(root, edgeTab);
    // A detached window keeps the size it's resized to
    applyWindowMode();
  }

  // ---------- Window mode: docked on the right or the left, detached (drag and resize), or full screen ----------
  // Remembered in this browser only.
  const WINDOW_KEY = 'am-admin-window';
  const windowState = (() => {
    const fallback = { mode: 'docked', side: 'right', dockW: 460, x: null, y: 40, w: 480, h: Math.round(window.innerHeight * 0.8) };
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

  // Docked on the left: the panel, its Admin tab and the page's editing bars all swap sides
  const dockedLeft = () => windowState.side === 'left' && windowState.mode === 'docked';

  // Docked, the page makes room: it's narrower, next to the panel, instead of under it. Drag the panel's
  // inner edge to change how wide it is.
  const DOCK_MIN = 340;
  const dockWidth = () => Math.round(Math.min(Math.max(Number(windowState.dockW) || 460, DOCK_MIN), Math.max(window.innerWidth * 0.7, DOCK_MIN)));

  function updateRoom() {
    if (!root) return;
    const html = document.documentElement;
    const on = !root.hidden && !isMinimised() && windowState.mode === 'docked';
    // The page reflows to its new width: keep what's being looked at where it is
    const anchor = pageAnchor();
    html.classList.toggle('adm-docked', on);
    html.classList.toggle('adm-docked-left', on && windowState.side === 'left');
    html.style.setProperty('--adm-w', `${dockWidth()}px`);
    restorePageAnchor(anchor);
  }

  // ---------- Resizing: every edge and corner of the window; docked, its inner edge ----------
  const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  const GRIP = 10;
  let handles = null;

  function placeHandles() {
    if (!root) return;
    if (!handles) {
      handles = EDGES.map((dir) => {
        const handle = h('div', { class: `adm-rz adm-rz-${dir}`, 'aria-hidden': 'true', hidden: true });
        handle.addEventListener('pointerdown', (e) => startResize(e, dir));
        document.body.appendChild(handle);
        return handle;
      });
    }
    const visible = !root.hidden && !isMinimised();
    const box = root.getBoundingClientRect();
    const inner = windowState.side === 'left' ? 'e' : 'w';
    handles.forEach((handle, i) => {
      const dir = EDGES[i];
      const on = visible && (windowState.mode === 'floating' || (windowState.mode === 'docked' && dir === inner));
      handle.hidden = !on;
      if (!on) return;
      const across = dir.length === 2 ? GRIP * 2 : GRIP;
      const x = dir.includes('w') ? box.left - across / 2 : dir.includes('e') ? box.right - across / 2 : box.left + GRIP;
      const y = dir.includes('n') ? box.top - across / 2 : dir.includes('s') ? box.bottom - across / 2 : box.top + (windowState.mode === 'docked' ? 0 : GRIP);
      const width = dir === 'n' || dir === 's' ? box.width - GRIP * 2 : across;
      const height = dir === 'e' || dir === 'w' ? box.height - (windowState.mode === 'docked' ? 0 : GRIP * 2) : across;
      Object.assign(handle.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
    });
  }

  function startResize(e, dir) {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, box: root.getBoundingClientRect() };
    root.classList.add('is-dragging');
    document.documentElement.classList.add('adm-resizing');
    const move = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (windowState.mode === 'docked') {
        windowState.dockW = windowState.side === 'left' ? start.box.width + dx : start.box.width - dx;
        root.style.width = `${dockWidth()}px`;
        document.documentElement.style.setProperty('--adm-w', `${dockWidth()}px`);
      } else {
        let { left, top, width, height } = start.box;
        if (dir.includes('e')) width += dx;
        if (dir.includes('s')) height += dy;
        if (dir.includes('w')) { width -= dx; left += dx; }
        if (dir.includes('n')) { height -= dy; top += dy; }
        // Not smaller than a usable window; a left or top edge stops instead of pushing the window
        if (width < 320) { if (dir.includes('w')) left -= 320 - width; width = 320; }
        if (height < 240) { if (dir.includes('n')) top -= 240 - height; height = 240; }
        width = Math.min(width, window.innerWidth);
        height = Math.min(height, window.innerHeight);
        windowState.w = Math.round(width);
        windowState.h = Math.round(height);
        root.style.width = `${windowState.w}px`;
        root.style.height = `${windowState.h}px`;
        placeFloating(left, top);
      }
      placeHandles();
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      root.classList.remove('is-dragging');
      document.documentElement.classList.remove('adm-resizing');
      saveWindowState();
      updateRoom();
      placeHandles();
      placePhone();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  function switchSide() {
    windowState.side = windowState.side === 'left' ? 'right' : 'left';
    windowState.mode = 'docked';
    saveWindowState();
    applyWindowMode();
  }

  function applyWindowMode() {
    if (!root) return;
    const { mode } = windowState;
    root.classList.toggle('adm-root--floating', mode === 'floating');
    root.classList.toggle('adm-root--full', mode === 'full');
    root.classList.toggle('adm-root--left', dockedLeft());
    if (edgeTab) edgeTab.classList.toggle('is-left', windowState.side === 'left');
    root.style.cssText = '';
    if (mode === 'docked') root.style.width = `${dockWidth()}px`;
    if (mode === 'floating') {
      root.style.width = `${Math.min(Math.max(windowState.w, 320), window.innerWidth)}px`;
      root.style.height = `${Math.min(Math.max(windowState.h, 240), window.innerHeight)}px`;
      placeFloating(windowState.x == null ? (windowState.side === 'left' ? 40 : window.innerWidth - windowState.w - 40) : windowState.x, windowState.y);
    }
    updateRoom();
    labelWindowButtons();
    placeHandles();
  }

  function labelWindowButtons() {
    const { mode } = windowState;
    const label = (btn, sign, title) => {
      btn.title = title;
      btn.setAttribute('aria-label', title);
      if (btn.classList.contains('adm-menu-item')) {
        btn.textContent = '';
        btn.append(h('span', { class: 'adm-menu-sign', text: sign }), h('span', { text: title }));
      } else {
        btn.textContent = sign;
      }
    };
    root.querySelectorAll('.adm-menu-lock').forEach((btn) => label(btn, '\u{1F512}', 'Lock the panel'));
    root.querySelectorAll('.adm-win-phone').forEach((btn) => {
      btn.innerHTML = PHONE_ICON;
      btn.title = phone ? 'Close the phone preview' : 'Phone preview: see the page at phone width';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', String(Boolean(phone)));
    });
    placePhone();
    root.querySelectorAll('.adm-win-float').forEach((btn) => {
      const on = mode === 'floating';
      label(btn, on ? '⇥' : '⧉', on ? 'Dock to the side' : 'Detach into a window you can move and resize');
    });
    root.querySelectorAll('.adm-win-full').forEach((btn) => {
      const on = mode === 'full';
      label(btn, on ? '⤡' : '⤢', on ? 'Exit full screen' : 'Full screen');
    });
    root.querySelectorAll('.adm-win-side').forEach((btn) => {
      label(btn, '\u21C6', dockedLeft() ? 'Dock on the right side' : 'Dock on the left side');
    });
  }

  function previewButton() {
    const btn = h('button', { class: 'adm-close adm-win-preview', type: 'button', title: 'Preview: the page as visitors see it, without editing controls or drafts', 'aria-label': 'Preview', onclick: () => setPreviewing(true) });
    btn.innerHTML = EYE;
    return btn;
  }

  // The panel's less used controls, behind "⋯": which side, a window or full screen, and Lock
  function moreMenu() {
    const item = (cls, onclick) => h('button', {
      class: `adm-menu-item ${cls}`,
      type: 'button',
      role: 'menuitem',
      onclick: () => {
        menu.hidden = true;
        onclick();
      },
    });
    const menu = h('div', { class: 'adm-menu', role: 'menu', hidden: true },
      item('adm-win-side', switchSide),
      item('adm-win-float', () => setWindowMode('floating')),
      item('adm-win-full', () => setWindowMode('full')),
      item('adm-menu-lock', () => { state.token = null; showUnlock('Locked. Unsaved changes are kept.'); }));
    return h('div', { class: 'adm-more-wrap' },
      h('button', {
        class: 'adm-close adm-more-btn',
        type: 'button',
        text: '\u22EF',
        title: 'More: side, window, full screen, lock',
        'aria-label': 'More',
        'aria-haspopup': 'menu',
        onclick: () => { menu.hidden = !menu.hidden; },
      }),
      menu);
  }

  function windowButtons() {
    return [
      h('button', { class: 'adm-close adm-win-phone', type: 'button', onclick: togglePhone }),
      h('button', { class: 'adm-close adm-win-side', type: 'button', onclick: switchSide }),
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
    const move = (ev) => {
      placeFloating(ev.clientX - dx, ev.clientY - dy);
      placeHandles();
    };
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
  window.addEventListener('resize', () => { if (root && !root.hidden) applyWindowMode(); });

  // Minimising keeps the token, draft and unsaved changes; it only slides the panel out of the way
  function minimise() {
    root.classList.add('is-min');
    updateRoom();
    placeHandles();
    setTimeout(placePhone);
    root.inert = true;
    edgeTab.hidden = false;
    updateEdgeTab();
    edgeTab.focus();
  }

  function restore() {
    if (previewing) { setPreviewing(false); return; }
    root.classList.remove('is-min');
    updateRoom();
    setTimeout(placePhone);
    setTimeout(placeHandles, 260); // after it has slid back in
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
    updateRoom();
    placeHandles();
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
    closePhone();
    // Noted before the editing extras go: that already moves things
    const anchor = pageAnchor();
    undecoratePage();
    if (state.draft && window.renderSite) window.renderSite(window.SITE_CONTENT || {});
    restorePageAnchor(anchor);
    state.draft = null;
    state.token = null;
    clearTimeout(idleTimer);
    restore();
    root.hidden = true;
    updateRoom();
    placeHandles();
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
          submit.textContent = 'Making a recovery code…';
          const fresh = await makeRecoveryCode();
          showRecoveryCode(fresh, async () => {
            try {
              await afterUnlock();
            } catch (error) {
              state.token = null;
              showUnlock(error.message);
            }
          });
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

  // ---------- Recovery code ----------
  // A second key to this browser's encrypted token, for a forgotten password. It's shown once, when it's
  // made (at setup, or from the Site tab); with it, the unlock screen lets you choose a new password.
  // Like the password, it only works in the browser that keeps the encrypted token, and it's never stored
  // itself: only a second encrypted copy of the token is (store.recovery).
  const CODE_LETTERS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O or U: easy to read back

  function newRecoveryCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return [...bytes].map((b) => CODE_LETTERS[b & 31]).join('').match(/.{4}/g).join('-'); // 120 random bits
  }

  // Typed back: any case, with or without dashes or spaces, O for 0 and I or L for 1
  const cleanCode = (text) => String(text || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

  async function makeRecoveryCode() {
    const fresh = newRecoveryCode();
    state.store.recovery = await encryptToken(state.token, cleanCode(fresh));
    saveStore(state.store);
    return fresh;
  }

  function showRecoveryCode(fresh, next) {
    const done = h('button', { class: 'adm-btn adm-btn-primary', type: 'button', text: 'Continue', disabled: true, onclick: next });
    const copied = h('span', { class: 'adm-hint' });
    setScreen(h('div', { class: 'adm-card' },
      h('h2', { text: 'Your recovery code' }),
      h('p', { class: 'adm-help', text: 'If you ever forget your password, this code lets you choose a new one on this computer. Write it down or keep it in a password manager: it’s shown only now.' }),
      h('p', { class: 'adm-recovery-code', text: fresh }),
      h('div', { class: 'adm-inline' },
        h('button', {
          class: 'adm-btn',
          type: 'button',
          text: 'Copy',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(fresh);
              copied.textContent = 'Copied.';
            } catch {
              copied.textContent = 'Couldn’t copy: select the code and copy it by hand.';
            }
          },
        }),
        copied),
      h('label', { class: 'adm-check' },
        h('input', { type: 'checkbox', onchange: (e) => { done.disabled = !e.target.checked; } }),
        h('span', { text: 'I’ve kept it somewhere safe' })),
      h('p', { class: 'adm-hint', text: 'Anyone with this code and this computer can open the panel, the same as with your password. Keep it away from the computer itself, e.g. on paper or in your phone’s password manager.' }),
      h('div', { class: 'adm-actions' }, h('span'), done)));
  }

  // Forgot the password: the recovery code and a new password
  function showRecover() {
    const back = h('button', { class: 'adm-link', type: 'button', text: 'Back', onclick: () => showUnlock() });
    if (!state.store.recovery) {
      setScreen(h('div', { class: 'adm-card' },
        h('h2', { text: 'Forgot your password?' }),
        h('p', { text: 'This computer has no recovery code, so the panel has to be set up again here. Nothing on your site is lost: it’s all on GitHub.' }),
        h('ol', { class: 'adm-steps' },
          h('li', null, 'Make a new ', h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener', text: 'GitHub token' }), ' (only this repository, “Contents: Read and write”).'),
          h('li', { text: 'Press “Set up again” below, paste the token and choose a new password.' }),
          h('li', null, 'Delete the old token on ', h('a', { href: 'https://github.com/settings/personal-access-tokens', target: '_blank', rel: 'noopener', text: 'GitHub' }), ', since nothing can unlock it any more.')),
        h('p', { class: 'adm-hint', text: 'Afterwards, make a recovery code in the Site tab, so next time a code is enough.' }),
        h('div', { class: 'adm-actions' },
          back,
          h('button', {
            class: 'adm-btn adm-btn-primary',
            type: 'button',
            text: 'Set up again',
            onclick: () => {
              const repo = state.store.repo;
              clearStore();
              state.store = { repo };
              showSetup();
            },
          }))));
      return;
    }
    const err = errorLine();
    const codeInput = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, required: true, placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX', class: 'adm-code-input' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 10 });
    const pass2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
    const submit = h('button', { class: 'adm-btn adm-btn-primary', type: 'submit', text: 'Set the new password' });
    setScreen(h('form', {
      class: 'adm-card',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const wait = state.cooldownUntil - Date.now();
        if (wait > 0) { err.textContent = `Too many wrong attempts. Try again in ${Math.ceil(wait / 1000)} s.`; return; }
        if (pass.value.length < 10) { err.textContent = 'Use a password of at least 10 characters.'; return; }
        if (pass.value !== pass2.value) { err.textContent = 'The passwords do not match.'; return; }
        submit.disabled = true;
        submit.textContent = 'Checking the code…';
        let token;
        try {
          token = await decryptToken(state.store.recovery, cleanCode(codeInput.value));
        } catch {
          state.failedAttempts += 1;
          if (state.failedAttempts >= MAX_ATTEMPTS) {
            state.failedAttempts = 0;
            state.cooldownUntil = Date.now() + ATTEMPT_COOLDOWN_MS;
          }
          err.textContent = 'That recovery code doesn’t fit this computer.';
          submit.disabled = false;
          submit.textContent = 'Set the new password';
          return;
        }
        state.failedAttempts = 0;
        submit.textContent = 'Encrypting…';
        state.store.secret = await encryptToken(token, pass.value);
        saveStore(state.store);
        state.token = token;
        codeInput.value = pass.value = pass2.value = '';
        state.note = 'New password set. Your recovery code still works.';
        try {
          await afterUnlock();
        } catch (error) {
          state.token = null;
          err.textContent = error.message;
          submit.disabled = false;
          submit.textContent = 'Set the new password';
        }
      },
    },
    h('div', { class: 'adm-card-head' }, h('h2', { text: 'Forgot your password?' }), h('div', { class: 'adm-top-actions' }, closeButton())),
    h('p', { class: 'adm-help', text: 'Type the recovery code you kept when you set up the panel (or made one in the Site tab), then choose a new password.' }),
    field('Recovery code', codeInput),
    field('New password (10+ characters)', pass),
    field('Confirm the new password', pass2),
    err,
    h('div', { class: 'adm-actions' }, back, submit)));
  }

  // Site tab: whether this computer has a recovery code, and making a new one
  function recoveryBox() {
    const has = Boolean(state.store && state.store.recovery);
    return h('div', { class: 'adm-form adm-group-box', 'data-adm-section': 'recovery' },
      h('h3', { class: 'adm-group', text: 'Recovery code' }),
      h('p', { class: has ? 'adm-hint' : 'adm-error', text: has
        ? 'This computer has a recovery code: with it, a forgotten password can be replaced (“Forgot your password?” when unlocking).'
        : 'This computer has no recovery code yet. Make one, so a forgotten password can be replaced without setting everything up again.' }),
      h('button', {
        class: 'adm-btn',
        type: 'button',
        text: has ? 'Make a new recovery code' : 'Make a recovery code',
        onclick: async () => {
          if (has && !confirm('Make a new recovery code? The old one stops working.')) return;
          const fresh = await makeRecoveryCode();
          showRecoveryCode(fresh, () => showEditor());
        },
      }),
      h('p', { class: 'adm-hint', text: 'Each computer has its own; on another computer, make one there too.' }));
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
      h('button', { class: 'adm-link', type: 'button', text: 'Forgot your password?', onclick: showRecover }),
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
    checkUpdatesInBackground();
    // Set up before recovery codes existed: say where to make one
    if (!state.store.recovery && !state.note) state.note = 'Tip: make a recovery code (Site tab) in case you forget your password.';
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
    wizardStep = null;
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
      help: 'Hover a colour scheme to try it on the page, click to keep it, then change any colour or font. All of it stays in the Theme tab.',
      // The same colours and fonts as the Theme tab (with schemes and fonts saved there)
      body: () => {
        const theme = state.draft.theme;
        const current = theme.switchable ? 'both' : window.SiteTheme.colors(theme).mode;
        return h('div', { class: 'adm-form' },
          h('span', { class: 'adm-label', text: 'How should your site look?' }),
          wizardChoice([
            ['dark', '\u263E Dark', 'Dark backgrounds, light text.'],
            ['light', '\u2600 Light', 'Light backgrounds, dark text.'],
            ['both', '\u25D0 Both', 'Follows each visitor\u2019s device, with a \u263E/\u2600 switch in the menu.'],
          ], current, (value) => { setVisitors(theme, value); redraw(); }),
          theme.switchable ? h('p', { class: 'adm-hint', text: 'Use the \u263E/\u2600 button in the menu to see the other version on the page.' }) : null,
          coloursBox(theme, true),
          fontsBox(theme));
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
          h('p', { class: 'adm-hint', text: 'While you edit, each kind has a filter button above the projects (faded until it has one). Click one, then + Add project, and the new project is of that kind. A project’s kind can be changed on its card or in the Work section of the Page tab.' }));
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
        // Languages that come with interface text first, then any other that was picked
        const withText = Object.keys(names).filter((code) => Object.values(window.SITE_UI_TEXT || {}).some((entry) => entry[code]));
        const common = [...new Set([L.main, ...withText, ...L.available])];
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
          field('Another language', h('select', {
            onchange: (e) => {
              if (!e.target.value) return;
              L.available = [...new Set([...L.available, e.target.value])];
              renderPage(state.draft);
              showWizard(step);
            },
          }, h('option', { value: '', text: 'Add a language…' }),
          Object.entries(names).filter(([code]) => !common.includes(code)).map(([code, label]) => h('option', { value: code, text: label })))),
          h('p', { class: 'adm-hint', text: 'Only the main language? Then there’s no language switch. Languages without built-in interface text get it typed in the Site tab (buttons, menu, form labels).' }));
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
    wizardStep = step;
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
    resetHistory();
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
    resetHistory();
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
      if (files[i] === INDEX_PATH) {
        let html = b64ToText(contentB64);
        if (saved.site && saved.site.name.trim()) html = withSiteDetails(html, saved);
        contentB64 = textToB64(stampCodeFiles(html, latest.build));
      }
      entries.push({ path: files[i], contentB64 });
    }
    progress('Installing\u2026');
    await commitFiles(entries, `Admin: update to portfolio-kit version ${latest.build}`);
  }

  function updatesBox() {
    const body = h('div', { class: 'adm-form' });
    const show = (...nodes) => { body.innerHTML = ''; nodes.flat().filter(Boolean).forEach((n) => body.appendChild(n)); };
    const versionText = (manifest) => `version ${manifest.build}${manifest.date ? ` (${manifest.date})` : ''}`;

    function showResult(result) {
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
              state.updateInfo = null;
              const banner = screen.querySelector('.adm-update-banner');
              if (banner) banner.remove();
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
    }

    const check = h('button', {
      class: 'adm-btn',
      type: 'button',
      text: 'Check for updates',
      onclick: async () => {
        show(h('p', { class: 'adm-hint', text: 'Checking\u2026' }));
        try {
          showResult(await checkForUpdates());
        } catch (error) {
          show(h('p', { class: 'adm-error', text: error.message }), check);
        }
      },
    });
    if (state.updateInfo) showResult(state.updateInfo);
    else show(h('p', { class: 'adm-hint', text: 'New features and fixes for the site\u2019s design and this panel.' }), check);
    return h('div', { class: 'adm-form adm-group-box', 'data-adm-section': 'updates' }, h('h3', { class: 'adm-group', text: 'Updates' }), body);
  }

  // ---------- Update notice ----------
  // On unlocking, the panel checks the kit in the background (once per session). A newer version puts a
  // slim bar at the top of the editor; clicking it opens the Site tab at Updates, with the changes listed.
  async function checkUpdatesInBackground() {
    if (state.updateChecked) return;
    state.updateChecked = true;
    try {
      const result = await checkForUpdates();
      if (result.status !== 'available') return;
      state.updateInfo = result;
      const editor = screen && screen.querySelector('.adm-editor');
      if (editor && !editor.querySelector('.adm-update-banner')) editor.appendChild(updateBanner());
    } catch { /* offline or not readable: no notice, nothing else changes */ }
  }

  function updateBanner() {
    const info = state.updateInfo;
    if (!info) return null;
    const changes = info.notes.length;
    return h('button', {
      class: 'adm-update-banner',
      type: 'button',
      onclick: () => {
        state.tab = 'site';
        showEditor();
        const box = screen.querySelector('[data-adm-section="updates"]');
        if (!box) return;
        box.scrollIntoView({ block: 'start' });
        box.classList.add('adm-flash');
        setTimeout(() => box.classList.remove('adm-flash'), 1200);
      },
    },
    h('span', { class: 'adm-update-dot', 'aria-hidden': 'true' }),
    h('span', { text: `Version ${info.latest.build} is available${changes ? `: ${changes} change${changes === 1 ? '' : 's'}` : ''}.` }),
    h('strong', { text: 'See what\u2019s new' }));
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
          h('button', { class: 'adm-close adm-undo', type: 'button', text: '↶', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: undo }),
          h('button', { class: 'adm-close adm-redo', type: 'button', text: '↷', title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', onclick: redo }),
          saveBtn,
          previewButton(),
          h('button', { class: 'adm-close adm-win-phone', type: 'button', onclick: togglePhone }),
          moreMenu(),
          h('button', { class: 'adm-close', type: 'button', 'aria-label': 'Minimise admin', title: 'Minimise', text: '–', onclick: minimise }),
          closeButton())),
      statusEl,
      languagePicker(),
      tabs,
      body,
      updateBanner());
    panel.saveBtn = saveBtn;
    screen.innerHTML = '';
    screen.appendChild(panel);
    labelWindowButtons();
    renderTab(body);
    updateStatus();
    updateHistoryButtons();
  }

  function rerenderTab() {
    // A change from the panel ends typing on the page first (the page isn't redrawn while it's typed in)
    if (editing) stopEditing();
    const body = screen.querySelector('.adm-body');
    const anchor = panelAnchor();
    if (body) renderTab(body);
    restorePanelAnchor(anchor);
    changed();
    recordHistory(); // clicks (adding, moving, deleting…) are a step each; only typing is grouped
  }

  function renderTab(body) {
    body.innerHTML = '';
    const views = { page: pageTab, site: siteTab, theme: themeTab };
    body.appendChild(views[state.tab]());
    compactHelp(body);
  }

  // Help texts longer than a sentence show only their first sentence, with "more" for the rest
  function compactHelp(container) {
    container.querySelectorAll('.adm-hint, .adm-help').forEach((node) => {
      if (node.dataset.compact || node.children.length) return;
      const full = node.textContent.trim();
      const parts = /^(.{24,}?[.!?])\s+(?=[A-Z\u201C"(])([\s\S]+)$/.exec(full);
      if (!parts || full.length < 100) return;
      node.dataset.compact = '1';
      node.textContent = `${parts[1]} `;
      node.appendChild(h('button', {
        class: 'adm-hint-more',
        type: 'button',
        text: 'more',
        title: full,
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          node.textContent = full;
        },
      }));
    });
  }

  function updateStatus(message, kind) {
    updateEdgeTab();
    if (!statusEl) return;
    statusEl.className = `adm-status${kind ? ` is-${kind}` : ''}`;
    if (message) statusEl.textContent = message;
    else if (state.saving) return;
    else if (isDirty()) statusEl.textContent = `Unsaved changes${state.pending.size ? ` · ${state.pending.size} file(s) to upload` : ''}. The page behind shows a preview.`;
    else statusEl.textContent = state.note || 'Everything is saved.';
    statusEl.title = statusEl.textContent; // the line is cut short when it doesn't fit
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

  // ---------- Drag to reorder ----------
  // Rows of one list share a group. Only the ⠿ handle starts a drag, so text in a row can still be
  // selected. onDrop(fromKey, toKey, before) puts the dragged row's entry next to the one it was dropped on.
  let dragging = null;

  function sortable(row, handle, group, key, onDrop, horizontal) {
    handle.addEventListener('pointerdown', () => { row.draggable = true; });
    handle.addEventListener('pointerup', () => { row.draggable = false; });
    const clear = () => document.querySelectorAll('.is-dragging, .drop-before, .drop-after').forEach((r) => r.classList.remove('is-dragging', 'drop-before', 'drop-after'));
    row.addEventListener('dragstart', (e) => {
      if (!row.draggable || e.target !== row) return;
      dragging = { group, key };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(key));
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => {
      dragging = null;
      row.draggable = false;
      clear();
    });
    row.addEventListener('dragover', (e) => {
      if (!dragging || dragging.group !== group || dragging.key === key) return;
      e.preventDefault();
      e.stopPropagation(); // a list inside a section row: the section row doesn't react too
      const box = row.getBoundingClientRect();
      const before = horizontal ? e.clientX < box.left + box.width / 2 : e.clientY < box.top + Math.min(box.height / 2, 28);
      row.classList.toggle('drop-before', before);
      row.classList.toggle('drop-after', !before);
    });
    row.addEventListener('dragleave', (e) => { if (!row.contains(e.relatedTarget)) row.classList.remove('drop-before', 'drop-after'); });
    row.addEventListener('drop', (e) => {
      if (!dragging || dragging.group !== group || dragging.key === key) return;
      e.preventDefault();
      e.stopPropagation();
      const before = row.classList.contains('drop-before');
      const from = dragging.key;
      dragging = null;
      clear();
      onDrop(from, key, before);
    });
    return row;
  }

  // Moves arr[from] to just before or after what is now arr[to]
  function moveTo(arr, from, to, before) {
    const [entry] = arr.splice(from, 1);
    const at = to - (from < to ? 1 : 0);
    arr.splice(at + (before ? 0 : 1), 0, entry);
  }

  // ---------- Lists of entries ----------
  // Quotes, logos, numbers, questions: one line each; click one to open its form. Drag ⠿ or use the
  // arrows to move it, ⧉ to duplicate it, ✕ to delete it.
  let openEntry = null; // the entry whose form is open

  function entryList(arr, { what, label, form, make }) {
    const rows = arr.map((entry, i) => {
      const isOpen = entry === openEntry;
      const handle = h('span', { class: 'adm-handle', title: 'Drag to move', text: '⠿' });
      const row = h('div', { class: `adm-entry${isOpen ? ' is-open' : ''}`, 'data-key': `${what}-${i}` },
        h('div', { class: 'adm-entry-head' },
          handle,
          h('button', {
            class: 'adm-entry-title',
            type: 'button',
            'aria-expanded': String(isOpen),
            onclick: () => { openEntry = isOpen ? null : entry; rerenderTab(); },
          }, h('span', { text: label(entry) || `(new ${what})` })),
          h('div', { class: 'adm-row-controls' },
            iconBtn('↑', 'Move up', () => move(arr, i, -1), i === 0),
            iconBtn('↓', 'Move down', () => move(arr, i, 1), i === arr.length - 1),
            iconBtn('⧉', `Duplicate this ${what}`, () => {
              const copy = clone(entry);
              arr.splice(i + 1, 0, copy);
              openEntry = copy;
              rerenderTab();
            }),
            iconBtn('✕', `Delete this ${what}`, () => {
              if (!confirm(`Delete this ${what}?`)) return;
              arr.splice(i, 1);
              rerenderTab();
            }))),
        isOpen ? h('div', { class: 'adm-form' }, form(entry, i)) : null);
      return sortable(row, handle, `entries-${what}`, i, (from, to, before) => { moveTo(arr, from, to, before); rerenderTab(); });
    });
    return h('div', { class: 'adm-field' },
      rows.length ? h('div', { class: 'adm-entry-list' }, rows) : h('p', { class: 'adm-hint', text: `No ${what}s yet.` }),
      h('div', null, h('button', {
        class: 'adm-btn',
        type: 'button',
        text: `+ Add ${what}`,
        onclick: () => {
          const entry = make();
          arr.push(entry);
          openEntry = entry;
          rerenderTab();
        },
      })));
  }

  // A field that isn't a <label> (clicking its label would otherwise press the first button inside it)
  function block(label, input, hint) {
    return h('div', { class: 'adm-field' }, h('span', { class: 'adm-label', text: label }), input, hint ? h('span', { class: 'adm-hint', text: hint }) : null);
  }

  // A text box with buttons for the simple formatting the page understands (see richText in js/main.js)
  const FORMAT_HINT = 'Leave an empty line between paragraphs. **bold**, *italic*, [link text](https://…), [[wide:words]] for letter spacing, and lines starting with "- " make a list.';

  function richArea(obj, key, rows) {
    const box = area(obj, key, rows);
    return h('div', { class: 'adm-rich' }, formatTools(box, true), box);
  }

  // A one-line text (or short text box) with B, I, link and spacing. The box comes first so a label
  // around it points at the box, not a button; the buttons still show above it.
  function formattable(box) {
    return h('div', { class: 'adm-rich adm-rich-line' }, box, formatTools(box, false));
  }

  function formatTools(box, lists) {
    const typed = () => box.dispatchEvent(new Event('input', { bubbles: true }));
    const wrap = (before, after, placeholder) => {
      const { selectionStart: a, selectionEnd: b, value } = box;
      const inner = value.slice(a, b) || placeholder;
      box.value = value.slice(0, a) + before + inner + after + value.slice(b);
      box.focus();
      box.setSelectionRange(a + before.length, a + before.length + inner.length);
      typed();
    };
    // Every line in the selection becomes a list item (or stops being one)
    const listLines = () => {
      const { value } = box;
      const start = value.lastIndexOf('\n', box.selectionStart - 1) + 1;
      const endAt = value.indexOf('\n', box.selectionEnd);
      const end = endAt < 0 ? value.length : endAt;
      const lines = value.slice(start, end).split('\n');
      const isList = lines.every((line) => /^\s*-\s+/.test(line));
      const next = lines.map((line) => (isList ? line.replace(/^\s*-\s+/, '') : `- ${line}`)).join('\n');
      box.value = value.slice(0, start) + next + value.slice(end);
      box.focus();
      box.setSelectionRange(start, start + next.length);
      typed();
    };
    const link = () => {
      const url = prompt('Link address (https://…, mailto:… or #contact)');
      if (url && url.trim()) wrap('[', `](${url.trim().replace(/\s/g, '%20')})`, 'link text');
    };
    // mousedown is stopped so the text box keeps its selection
    const tool = (label, title, run) => h('button', { class: 'adm-tool', type: 'button', text: label, title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick: run });
    const spacing = h('select', {
      class: 'adm-tool-select',
      title: 'Letter spacing for the selected words',
      'aria-label': 'Letter spacing',
      onchange: (e) => {
        const name = e.target.value;
        e.target.value = '';
        if (name) wrap(`[[${name}:`, ']]', 'spaced words');
      },
    }, h('option', { value: '', text: 'Spacing…' }), SPACINGS.filter(([name]) => name).map(([name, label]) => h('option', { value: name, text: label })));
    return h('div', { class: 'adm-tools' },
      tool('B', 'Bold', () => wrap('**', '**', 'bold text')),
      tool('I', 'Italic', () => wrap('*', '*', 'italic text')),
      tool('Link', 'Link', link),
      lists ? tool('• List', 'List', listLines) : null,
      spacing);
  }

  // Buttons of a Text or Call-to-action section
  function buttonsEditor(buttons) {
    return h('div', { class: 'adm-field' },
      h('div', { class: 'adm-section-head' },
        h('span', { class: 'adm-label', text: 'Buttons' }),
        h('button', {
          class: 'adm-btn',
          type: 'button',
          text: '+ Add button',
          onclick: () => { buttons.push({ label: '', url: '', style: buttons.length ? 'ghost' : 'primary' }); rerenderTab(); },
        })),
      buttons.length ? null : h('span', { class: 'adm-hint', text: 'No buttons. A button needs a label and a link (https://…, or #contact for a section on the page).' }),
      buttons.map((button, i) => h('div', { class: 'adm-button-row' },
        text(button, 'label', { placeholder: 'Label, e.g. See my shop' }),
        text(button, 'url', { placeholder: 'https://… or #contact' }),
        h('select', { 'aria-label': 'Button style', onchange: (e) => { button.style = e.target.value; changed(); } },
          [['primary', 'Filled'], ['ghost', 'Outline']].map(([value, label]) => h('option', { value, text: label, selected: button.style === value }))),
        rowControls(buttons, i, 'button'))));
  }

  // A button that picks one file, like "+ Add pictures" (the browser's own file box would say
  // "Choose file / No file chosen" in the computer's language, and the panel already shows the file)
  function filePicker(accept, onPick) {
    const what = /video/.test(accept) ? 'a video' : /font|woff|ttf|otf/.test(accept) ? 'a font file'
      : /\.cur|\.ani/.test(accept) ? 'a pointer image' : /image/.test(accept) ? 'a picture' : 'a file';
    return h('label', { class: 'adm-btn adm-file-btn' }, `Choose ${what}…`,
      h('input', {
        type: 'file',
        accept,
        onchange: (e) => {
          const file = e.target.files[0];
          if (file) onPick(file);
          e.target.value = '';
        },
      }));
  }

  function currentFile(path) {
    if (!path) return h('span', { class: 'adm-hint', text: 'None' });
    return h('span', { class: 'adm-path' }, path, state.pending.has(path) ? h('em', { text: ' (new, uploads on save)' }) : null);
  }

  // ---------- Site tab ----------
  function siteTab() {
    const site = state.draft.site;
    const name = window.SiteText.plain(site.name.trim()) || 'Your Name';
    return h('div', { class: 'adm-form' },
      h('div', { class: 'adm-section-head' },
        h('p', { class: 'adm-help', text: 'Who the site belongs to and where it links to. Your name shows in the top section, the logo, the footer and the browser tab.' }),
        h('div', { class: 'adm-inline' },
          h('button', { class: 'adm-btn', type: 'button', text: 'Run setup again', title: 'The first-time steps: name, look, top section, work, contact, languages', onclick: () => showWizard(0) }),
          h('button', { class: 'adm-btn', type: 'button', text: 'Find unused files', title: 'Files in assets/ that nothing on the site uses', onclick: () => showCleanup() }))),
      h('div', { class: 'adm-form adm-group-box', 'data-adm-section': 'site' },
        h('h3', { class: 'adm-group', text: 'You' }),
        h('div', { class: 'adm-row2' },
          field('Full name', formattable(text(site, 'name', { placeholder: 'e.g. Sam Janssens' })), 'Formatting shows in the big heading only; the logo, footer and browser tab use the words.'),
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
      recoveryBox(),
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
  // [key, short label, what it colours]: the first four are shown, the rest fold under "More colours"
  const MAIN_COLORS = [
    ['bg', 'Background', 'Page background'],
    ['text', 'Text', 'Text'],
    ['accent', 'Accent', 'Buttons and links'],
    ['accent2', 'Accent 2', 'Highlights and lines'],
  ];
  const MORE_COLORS = [
    ['bgAlt', 'Sections', 'Second background (About, Work)'],
    ['surface', 'Cards', 'Cards and form fields'],
    ['border', 'Lines', 'Lines and borders'],
    ['textDim', 'Soft text', 'Dates, captions and other quieter text'],
    ['onAccent', 'On buttons', 'Text on accent buttons'],
    ['heroBg', 'Top background', 'Top section background'],
    ['heroText', 'Top text', 'Top section text'],
  ];
  const isHex = (value) => /^#[0-9a-f]{6}$/i.test(value || '');
  const otherMode = (mode) => (mode === 'light' ? 'dark' : 'light');
  const MODE_NAMES = { dark: '\u263E Dark', light: '\u2600 Light' };

  // The other version becomes the only one (e.g. "Visitors see: Light" on a dark scheme): its colours,
  // made to match the scheme (see otherVersion in js/main.js) with any changes made to it, become the theme's
  function useOtherVersion(theme) {
    const other = window.SiteTheme.colors(theme, 'other');
    const keys = [...MAIN_COLORS, ...MORE_COLORS].map(([key]) => key).filter((key) => key !== 'heroText' && isHex(other[key]));
    theme.colors = { ...Object.fromEntries(keys.map((key) => [key, other[key]])), mode: other.mode };
    if (theme.other.heroText) theme.colors.heroText = theme.other.heroText;
    theme.other = {};
  }

  // "Visitors see": 'dark', 'light' or 'both'
  function setVisitors(theme, value) {
    const main = window.SiteTheme.colors(theme).mode;
    if (value === 'both') theme.switchable = true;
    else {
      if (value !== main) useOtherVersion(theme);
      theme.switchable = false;
    }
    window.SiteTheme.showMode('');
    window.SiteTheme.apply(theme);
  }

  // Sections with their own background colour or picture, which have a second version to check
  function ownBackgrounds() {
    return [...new Set(allOrders().flat())].filter((id) => (state.draft.sections[id] || {}).background === 'custom');
  }
  let backgroundsNote = null; // after "Both" is picked in the Theme tab: those sections, to look at

  // The colours and fonts are shown in the Theme tab and in the setup wizard: redraw whichever is open
  let wizardStep = null; // the setup step showing, or null
  function redraw() {
    if (wizardStep === null) {
      rerenderTab();
      return;
    }
    changed();
    recordHistory();
    showWizard(wizardStep);
  }

  // ---------- Saved colour schemes ----------
  // theme.saved = [{ name, preset, colors }]: colour combinations kept to switch back to, stored with the
  // site's content so they're there on every computer
  const schemeKey = (scheme) => JSON.stringify({ preset: scheme.preset, colors: scheme.colors || {}, other: scheme.other || {} });
  const currentScheme = (theme) => ({ preset: theme.preset, colors: { ...theme.colors }, other: { ...theme.other } });

  const hasOwnColours = (theme) => Object.keys(theme.colors).some((key) => key !== 'mode') || Object.keys(theme.other).length > 0;
  const isSaved = (theme, scheme) => theme.saved.some((s) => schemeKey(s) === schemeKey(scheme));

  // Hand-made colours that aren't a saved scheme: picking another scheme keeps them here, as the
  // "Your edits" chip, so they're one click away (until the panel is closed)
  let looseEdits = null;
  let namingScheme = false; // the "Save" chip is a name field

  function useScheme(theme, scheme) {
    const now = currentScheme(theme);
    if (hasOwnColours(theme) && !isSaved(theme, now)) looseEdits = now;
    theme.preset = scheme.preset;
    theme.colors = { ...(scheme.colors || {}) };
    theme.other = { ...(scheme.other || {}) };
    window.SiteTheme.apply(theme);
  }

  function saveScheme(theme, label) {
    const saved = theme.saved;
    const existing = saved.findIndex((scheme) => scheme.name.toLowerCase() === label.toLowerCase());
    if (existing >= 0 && !confirm(`Replace the saved scheme \u201C${saved[existing].name}\u201D with the current colours?`)) return;
    const scheme = { name: label, ...currentScheme(theme) };
    if (existing >= 0) saved[existing] = scheme;
    else saved.push(scheme);
    looseEdits = null;
  }

  // Ready-made and saved schemes as one row of chips. Hovering one shows it on the page; a click keeps it.
  // `manage`: saved ones can be deleted and the current colours saved (the Theme tab; the wizard only picks)
  function schemeChips(theme, onPick, manage) {
    const T = window.SiteTheme;
    const now = currentScheme(theme);
    const active = schemeKey(now);
    const custom = hasOwnColours(theme) && !isSaved(theme, now);
    const edits = custom ? now : looseEdits && schemeKey(looseEdits) !== active ? looseEdits : null;
    const chip = (scheme, name, title, remove) => {
      const c = T.colors(scheme);
      const isActive = schemeKey(scheme) === active;
      return h('span', { class: `adm-chip${isActive ? ' is-active' : ''}` },
        h('button', {
          class: 'adm-chip-pick',
          type: 'button',
          title,
          'aria-pressed': String(isActive),
          onmouseenter: () => { if (!isActive) T.apply({ ...theme, preset: scheme.preset, colors: { ...(scheme.colors || {}) }, other: { ...(scheme.other || {}) } }); },
          onmouseleave: () => T.apply(state.draft.theme),
          onclick: () => { if (!isActive) onPick(scheme); },
        },
        h('span', { class: 'adm-chip-dot', style: `background:conic-gradient(${c.accent} 0 25%, ${c.accent2} 0 50%, ${c.bg} 0)` }),
        h('span', { text: name })),
        remove ? h('button', { class: 'adm-chip-x', type: 'button', text: '\u2715', title: `Delete \u201C${name}\u201D`, 'aria-label': `Delete \u201C${name}\u201D`, onclick: remove }) : null);
    };
    let nameField = null;
    if (manage && custom && namingScheme) {
      const finish = (keep) => {
        if (!namingScheme) return;
        namingScheme = false;
        const label = nameField.value.trim();
        if (keep && label) saveScheme(theme, label);
        redraw();
      };
      nameField = h('input', {
        class: 'adm-chip-name',
        type: 'text',
        placeholder: 'Name, then Enter',
        maxLength: 40,
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        },
        onblur: () => finish(true),
      });
    }
    return h('div', { class: 'adm-chips' },
      Object.entries(T.presets).map(([key, p]) => chip({ preset: key, colors: {} }, p.name.replace(/\s*\(.*\)$/, ''), p.name)),
      theme.saved.map((scheme, i) => chip(scheme, scheme.name, 'Your saved scheme', manage ? () => {
        if (!confirm(`Delete the saved scheme \u201C${scheme.name}\u201D? The colours you\u2019re using now stay.`)) return;
        theme.saved.splice(i, 1);
        redraw();
      } : null)),
      // Edits you switched away from can be thrown away; the ones in use stay (↺ goes back to the scheme)
      edits ? chip(edits, 'Your edits', 'Colours you changed by hand (not saved as a scheme)', manage && !custom ? () => {
        if (!confirm('Throw away your edits? The colours you’re using now stay.')) return;
        looseEdits = null;
        redraw();
      } : null) : null,
      nameField || (manage && custom ? h('button', {
        class: 'adm-chip adm-chip-add',
        type: 'button',
        text: '+ Save',
        title: 'Save your edits as a scheme, to switch back to later. Saved schemes are kept with the site.',
        onclick: () => {
          namingScheme = true;
          redraw();
          const field = screen.querySelector('.adm-chip-name');
          if (field) field.focus();
        },
      }) : null));
  }

  // One colour: a round swatch that opens the colour picker. The page follows while it's dragged and
  // is redrawn once it's let go. target: where the change goes (theme.colors, or theme.other for the second
  // version); with both versions, touching one shows its version on the page.
  function colourSwatch(target, colors, [key, label, title], mode) {
    const T = window.SiteTheme;
    const fallback = key === 'heroText' ? colors.heroText || (colors.mode === 'light' ? '#f5f6f8' : colors.text) : '#000000';
    const value = isHex(colors[key]) ? colors[key] : isHex(fallback) ? fallback : '#000000';
    const show = () => { if (state.draft.theme.switchable) T.showMode(mode); };
    return h('label', { class: 'adm-color', title },
      h('input', {
        type: 'color',
        value,
        onclick: show,
        oninput: (e) => { target[key] = e.target.value; show(); T.apply(state.draft.theme); scheduleHistory(); },
        onchange: () => redraw(),
      }),
      h('span', { text: label }));
  }

  // One version's colours: the main four, and the rest folded
  function colourRow(theme, mode, named) {
    const T = window.SiteTheme;
    const isMain = mode === T.colors(theme).mode;
    const colors = T.colors(theme, isMain ? 'main' : 'other');
    const target = isMain ? theme.colors : theme.other;
    const fold = `moreColours-${mode}`;
    return h('div', { class: 'adm-version' },
      named ? h('span', { class: 'adm-version-name', text: MODE_NAMES[mode] }) : null,
      h('div', { class: 'adm-colors' }, MAIN_COLORS.map((spec) => colourSwatch(target, colors, spec, mode))),
      h('details', {
        class: 'adm-more-colours',
        open: Boolean(foldOpen[fold]),
        ontoggle: (e) => { foldOpen[fold] = e.currentTarget.open; },
      },
      h('summary', { text: 'More colours' }),
      h('div', { class: 'adm-colors' }, MORE_COLORS.map((spec) => colourSwatch(target, colors, spec, mode)))));
  }

  // `setup`: in the setup wizard, which asks "Dark, light or both?" with big cards above it instead
  function coloursBox(theme, setup) {
    const T = window.SiteTheme;
    const main = T.colors(theme).mode;
    const visitors = theme.switchable ? 'both' : main;
    const visitorsButton = (value, label) => h('button', {
      class: `adm-seg${visitors === value ? ' is-active' : ''}`,
      type: 'button',
      'aria-pressed': String(visitors === value),
      text: label,
      onclick: () => {
        if (visitors === value) return;
        setVisitors(theme, value);
        backgroundsNote = value === 'both' ? ownBackgrounds() : null;
        redraw();
      },
    });
    const rows = theme.switchable ? ['dark', 'light'].map((mode) => colourRow(theme, mode, true)) : [colourRow(theme, main, false)];
    return h('div', { class: 'adm-form adm-group-box', 'data-adm-section': 'colours' },
      h('div', { class: 'adm-colours-head' },
        h('h3', { class: 'adm-group', text: 'Colours' }),
        hasOwnColours(theme) ? iconBtn('\u21BA', 'Back to the scheme\u2019s own colours', () => {
          useScheme(theme, { preset: theme.preset, colors: {}, other: {} });
          redraw();
        }) : null),
      setup ? null : h('div', { class: 'adm-visitors' },
        h('span', { class: 'adm-label', text: 'Visitors see' }),
        h('div', { class: 'adm-segs', title: 'Both: each visitor first sees the version their device prefers, and a \u263E/\u2600 button in the menu switches. The top section stays dark in both, so its text reads on photos and video.' },
          visitorsButton('dark', MODE_NAMES.dark), visitorsButton('light', MODE_NAMES.light), visitorsButton('both', '\u25D0 Both'))),
      !setup && theme.switchable ? modeButtonLook(theme) : null,
      !setup && theme.switchable && backgroundsNote && backgroundsNote.length ? backgroundsTip(theme) : null,
      schemeChips(theme, (scheme) => { useScheme(theme, scheme); redraw(); }, true),
      ...rows,
      theme.switchable ? h('p', { class: 'adm-hint', text: 'A scheme sets both versions; the second is made to match. Change a colour in either row, and the page shows that version while you do.' }) : null);
  }

  // How the ☾/☀ button in the menu looks: an icon, the icon with a word, or a sliding switch
  function modeButtonLook(theme) {
    const look = (value, label, title) => h('button', {
      class: `adm-seg${theme.modeButton === value ? ' is-active' : ''}`,
      type: 'button',
      'aria-pressed': String(theme.modeButton === value),
      text: label,
      title,
      onclick: () => {
        if (theme.modeButton === value) return;
        theme.modeButton = value;
        window.SiteTheme.apply(theme);
        redraw();
      },
    });
    return h('div', { class: 'adm-visitors' },
      h('span', { class: 'adm-label', text: 'Menu button' }),
      h('div', { class: 'adm-segs' },
        look('icon', '☀', 'A sun or a moon'),
        look('label', '☀ Light', 'The icon with a word: the version it switches to'),
        look('switch', '☾●', 'A sliding switch')));
  }

  // After turning on both versions: sections with their own background, each a click away
  function backgroundsTip(theme) {
    const other = otherMode(window.SiteTheme.colors(theme).mode);
    const names = backgroundsNote.map((id) => h('button', {
      class: 'adm-link',
      type: 'button',
      text: sectionLabel(id),
      onclick: () => {
        // Its row, on the Layout tab (where its background is), with the page showing that version
        backgroundsNote = null;
        window.SiteTheme.showMode(other);
        state.rowTab = 'layout';
        selectSection(id, { reveal: true });
      },
    }));
    return h('div', { class: 'adm-note adm-backgrounds-tip' },
      h('span', { text: `${backgroundsNote.length === 1 ? 'This section has its own background' : 'These sections have their own background'}. Check how ${backgroundsNote.length === 1 ? 'it looks' : 'they look'} in the ${other} version: ` }),
      ...names.flatMap((name, i) => (i ? [', ', name] : [name])),
      h('button', { class: 'adm-icon', type: 'button', text: '\u2715', title: 'Close', 'aria-label': 'Close', onclick: () => { backgroundsNote = null; redraw(); } }));
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
            redraw();
          })),
        h('div', { class: 'adm-row3' },
          field('Font name', text(f, 'name', {
            onchange: () => {
              // Keep the family picked as text or heading font when it's renamed
              if (theme.font === oldNames[i]) theme.font = f.name;
              if (theme.headingFont === oldNames[i]) theme.headingFont = f.name;
              redraw();
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
        redraw();
      }),
      h('span', { class: 'adm-hint', text: 'Upload a font file (.woff2 is smallest), then pick it by name above. Files with the same name form one family: add a bold or italic file and set its weight and style, or leave a variable font on “All weights”. Make sure the font’s licence allows use on a website.' }));
  }

  // ---------- Fonts as samples (Theme tab) ----------
  // Each font is shown written in itself. For the samples, Google Fonts sends only the letters they use.
  let fontSamplesLoaded = false;

  function loadFontSamples() {
    if (fontSamplesLoaded) return;
    fontSamplesLoaded = true;
    const names = Object.keys(window.SiteTheme.fonts).filter((name) => typeof window.SiteTheme.fonts[name] === 'string');
    const letters = [...new Set(`Aa${names.join('')}`.replace(/\s/g, ''))].join('');
    const families = names.map((name) => `family=${encodeURIComponent(name).replace(/%20/g, '+')}`).join('&');
    document.head.appendChild(h('link', { rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?${families}&text=${encodeURIComponent(letters)}&display=swap` }));
  }

  const fontCss = (name) => (!name || name === 'System font' ? '"Segoe UI", system-ui, sans-serif' : `"${name.replace(/["\\]/g, '')}", "Segoe UI", system-ui, sans-serif`);
  let openFontPicker = null; // 'font' or 'headingFont': which list is open

  function fontPicker(theme, key, label, emptyLabel) {
    loadFontSamples();
    const current = theme[key] || '';
    const isOpen = openFontPicker === key;
    const own = [...new Set(theme.customFonts.map((f) => f.name.trim()).filter(Boolean))];
    // "Same as the text" shows the text font
    const sample = (name) => h('span', { class: 'adm-font-sample', style: `font-family:${fontCss(name || theme.font)}`, text: 'Aa' });
    const option = (name, text) => h('button', {
      class: `adm-font${current === name ? ' is-active' : ''}`,
      type: 'button',
      'aria-pressed': String(current === name),
      onclick: () => {
        theme[key] = name;
        openFontPicker = null;
        redraw();
      },
    }, sample(name), h('span', { class: 'adm-font-name', style: name ? `font-family:${fontCss(name)}` : null, text: text || name }));
    return h('div', { class: 'adm-field' },
      h('span', { class: 'adm-label', text: label }),
      h('button', {
        class: `adm-font-current${isOpen ? ' is-open' : ''}`,
        type: 'button',
        'aria-expanded': String(isOpen),
        onclick: () => { openFontPicker = isOpen ? null : key; redraw(); },
      }, sample(current), h('span', { class: 'adm-font-name', text: current || emptyLabel }), h('span', { class: 'adm-hint', text: isOpen ? 'Close' : 'Change' })),
      isOpen ? h('div', { class: 'adm-fonts' },
        emptyLabel ? option('', emptyLabel) : null,
        own.length ? [h('span', { class: 'adm-fonts-group', text: 'Your fonts' }), ...own.map((name) => option(name))] : null,
        h('span', { class: 'adm-fonts-group', text: 'Google Fonts' }),
        Object.keys(window.SiteTheme.fonts).map((name) => option(name))) : null);
  }

  // A group folded to one line saying what it's set to, e.g. "Mouse effect · Dot"; it stays open or
  // closed while you work
  const foldOpen = {};

  function fold(key, title, value, ...children) {
    return h('details', {
      class: 'adm-group-box adm-fold',
      'data-adm-section': key,
      open: Boolean(foldOpen[key]),
      ontoggle: (e) => { foldOpen[key] = e.currentTarget.open; },
    },
    h('summary', null, h('span', { class: 'adm-group', text: title }), h('span', { class: 'adm-fold-value', text: value })),
    h('div', { class: 'adm-form' }, ...children));
  }

  let ownFontsOpen = false;

  // For Theme sliders: the page restyles while one is dragged
  const restyle = (theme) => () => window.SiteTheme.apply(theme);

  // ---------- Font styles (Theme tab) ----------
  // Weights are picked from the ones the font has (see fontWeights in js/main.js)
  const WEIGHT_NAMES = { 100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };
  const nearestOf = (weights, wanted) => weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best));

  function weightSlider(theme, key, label, family) {
    const weights = window.SiteTheme.fontWeights(theme, family);
    const name = (w) => `${WEIGHT_NAMES[w] || w} (${w})`;
    if (weights.length < 2) return field(label, h('span', { class: 'adm-hint', text: `${name(weights[0])}: this font comes in one weight.` }));
    const shown = h('span', { class: 'adm-value', text: name(nearestOf(weights, theme[key])) });
    return h('label', { class: 'adm-field' },
      h('span', { class: 'adm-label' }, label, ' ', shown),
      h('input', {
        type: 'range', min: 0, max: weights.length - 1, step: 1, value: weights.indexOf(nearestOf(weights, theme[key])),
        oninput: (e) => {
          theme[key] = weights[Number(e.target.value)];
          shown.textContent = name(theme[key]);
          window.SiteTheme.apply(theme);
          scheduleHistory();
        },
        onchange: () => changed(),
      }));
  }

  // Two buttons side by side, e.g. Normal / Italic
  function styleSegs(theme, key, label, options) {
    return h('div', { class: 'adm-visitors' },
      h('span', { class: 'adm-label', text: label }),
      h('div', { class: 'adm-segs' }, options.map(([value, text, title]) => h('button', {
        class: `adm-seg${theme[key] === value ? ' is-active' : ''}`,
        type: 'button',
        'aria-pressed': String(theme[key] === value),
        text,
        title,
        onclick: () => {
          if (theme[key] === value) return;
          theme[key] = value;
          window.SiteTheme.apply(theme);
          redraw();
        },
      }))));
  }

  function textStyleBox(theme) {
    return h('div', { class: 'adm-font-styles' },
      weightSlider(theme, 'textWeight', 'Weight', theme.font),
      weightSlider(theme, 'boldWeight', 'Bold text', theme.font),
      slider(theme, 'textSpacing', 'Letter spacing', -5, 20, 1, '', null, restyle(theme)),
      slider(theme, 'textSize', 'Size', 85, 130, 5, '%', 'Paragraphs, intros and card text. Headings and buttons keep their size.', restyle(theme)));
  }

  function headingStyleBox(theme) {
    const family = theme.headingFont || theme.font;
    const ownItalic = window.SiteTheme.italics.includes(family) || theme.customFonts.some((f) => f.name.trim() === family && f.style === 'italic');
    return h('div', { class: 'adm-font-styles' },
      weightSlider(theme, 'headingWeight', 'Weight', family),
      weightSlider(theme, 'headingBold', 'Bold words', family),
      slider(theme, 'headingSpacing', 'Letter spacing', -10, 30, 1, '', null, restyle(theme)),
      h('div', { class: 'adm-inline' },
        styleSegs(theme, 'headingItalic', 'Style', [[false, 'Normal'], [true, 'Italic']]),
        styleSegs(theme, 'headingCase', 'Letters', [['upper', 'AA', 'All capitals'], ['normal', 'Aa', 'As typed']])),
      theme.headingItalic && !ownItalic ? h('p', { class: 'adm-hint', text: 'This font has no italic letters of its own, so the browser slants the normal ones.' }) : null);
  }

  function fontsBox(theme) {
    return h('div', { class: 'adm-form adm-group-box' },
      h('h3', { class: 'adm-group', text: 'Fonts' }),
      fontPicker(theme, 'font', 'Text'),
      textStyleBox(theme),
      fontPicker(theme, 'headingFont', 'Headings', 'Same as the text'),
      headingStyleBox(theme),
      h('p', { class: 'adm-hint', text: 'Headings are your name, the section titles, card titles and the logo. Bold words: the ones you make bold in a heading. Letter spacing 0 is the font’s own.' }),
      check(theme, 'titleDot', 'A full stop in the accent colour after section titles'),
      ownFontsOpen || theme.customFonts.length ? customFontsBox(theme)
        : h('div', null, h('button', { class: 'adm-btn', type: 'button', text: '+ Your own font', onclick: () => { ownFontsOpen = true; redraw(); } })));
  }

  function themeTab() {
    const theme = state.draft.theme;
    return h('div', { class: 'adm-form' },
      h('p', { class: 'adm-help', text: 'Colours, fonts and corners for the whole site. Hover a scheme to try it on the page, click to keep it, then fine-tune any colour.' }),
      coloursBox(theme),
      fontsBox(theme),
      fold('corners', 'Corners', `${theme.radius} px`,
        slider(theme, 'radius', 'Corner roundness', 0, 28, 2, ' px', 'Cards, the showreel frame and pop-ups.', restyle(theme))),
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

  // ---------- Cursor files: .cur / .ico and .ani (Windows), Xcursor (Linux themes) ----------
  // Browsers can't show these, so the panel reads them when they're uploaded and saves the frames as one
  // PNG strip, with each frame's time and the pixel that points (theme.cursor.frames); js/main.js plays it.
  // Each frame: { image (ImageData or ImageBitmap), width, height, hotX, hotY, delay (ms) }
  const ascii = (bytes, at, n = 4) => String.fromCharCode(...bytes.subarray(at, at + n));

  function cursorKind(bytes) {
    if (ascii(bytes, 0) === 'RIFF' && ascii(bytes, 8) === 'ACON') return 'ani';
    if (ascii(bytes, 0) === 'Xcur') return 'xcursor';
    if (bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || bytes[2] === 2) && bytes[3] === 0) return 'cur';
    return '';
  }

  // A bitmap inside a .cur / .ico: colours bottom row first, then a 1-bit mask of the transparent pixels
  function decodeDib(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize = dv.getUint32(0, true);
    const width = dv.getInt32(4, true);
    const height = Math.abs(dv.getInt32(8, true)) / 2; // the colours and the mask are counted together
    const bpp = dv.getUint16(14, true);
    const used = headerSize >= 36 ? dv.getUint32(32, true) : 0;
    const palette = headerSize;
    const xor = palette + (bpp <= 8 ? (used || 1 << bpp) * 4 : 0);
    const xorStride = Math.ceil((width * bpp) / 32) * 4;
    const and = xor + xorStride * height;
    const andStride = Math.ceil(width / 32) * 4;
    const hasMask = and + andStride * height <= bytes.length;
    const out = new ImageData(width, height);
    let anyAlpha = false;
    for (let y = 0; y < height; y++) {
      const row = height - 1 - y;
      for (let x = 0; x < width; x++) {
        let r;
        let g;
        let b;
        let a = 255;
        const p = xor + row * xorStride;
        if (bpp === 32) {
          [b, g, r, a] = [bytes[p + x * 4], bytes[p + x * 4 + 1], bytes[p + x * 4 + 2], bytes[p + x * 4 + 3]];
          if (a) anyAlpha = true;
        } else if (bpp === 24) {
          [b, g, r] = [bytes[p + x * 3], bytes[p + x * 3 + 1], bytes[p + x * 3 + 2]];
        } else {
          const bit = x * bpp;
          const index = (bytes[p + (bit >> 3)] >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
          [b, g, r] = [bytes[palette + index * 4], bytes[palette + index * 4 + 1], bytes[palette + index * 4 + 2]];
        }
        const masked = hasMask && (bytes[and + row * andStride + (x >> 3)] >> (7 - (x & 7))) & 1;
        out.data.set([r, g, b, bpp === 32 ? a : masked ? 0 : 255], (y * width + x) * 4);
      }
    }
    // Old 32-bit cursors leave the alpha empty and use the mask instead
    if (bpp === 32 && !anyAlpha) {
      for (let y = 0; y < height; y++) {
        const row = height - 1 - y;
        for (let x = 0; x < width; x++) {
          const masked = hasMask && (bytes[and + row * andStride + (x >> 3)] >> (7 - (x & 7))) & 1;
          out.data[(y * width + x) * 4 + 3] = masked ? 0 : 255;
        }
      }
    }
    return out;
  }

  // .cur / .ico: a list of pictures in several sizes; the biggest is used. A .cur says where it points.
  async function decodeIconFile(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const isCur = dv.getUint16(2, true) === 2;
    const count = dv.getUint16(4, true);
    let best = null;
    for (let i = 0; i < count; i++) {
      const e = 6 + i * 16;
      if (e + 16 > bytes.length) break;
      const entry = {
        width: bytes[e] || 256,
        height: bytes[e + 1] || 256,
        hotX: isCur ? dv.getUint16(e + 4, true) : null,
        hotY: isCur ? dv.getUint16(e + 6, true) : null,
        size: dv.getUint32(e + 8, true),
        offset: dv.getUint32(e + 12, true),
      };
      if (!best || entry.width > best.width) best = entry;
    }
    if (!best) throw new Error('This cursor file has no pictures in it.');
    const data = bytes.subarray(best.offset, best.offset + best.size);
    let image;
    if (data[0] === 0x89 && ascii(data, 1, 3) === 'PNG') image = await createImageBitmap(new Blob([data], { type: 'image/png' }));
    else image = decodeDib(data);
    return { image, width: image.width, height: image.height, hotX: best.hotX, hotY: best.hotY, delay: 0 };
  }

  // .ani: a RIFF file with its timing ("anih", "rate", "seq ") and its frames, each a .cur / .ico ("LIST fram")
  async function decodeAni(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let rate = 6;
    let rates = null;
    let seq = null;
    const icons = [];
    for (let pos = 12; pos + 8 <= bytes.length;) {
      const id = ascii(bytes, pos);
      const size = dv.getUint32(pos + 4, true);
      const body = pos + 8;
      const words = () => Array.from({ length: Math.floor(size / 4) }, (_, i) => dv.getUint32(body + i * 4, true));
      if (id === 'anih') rate = dv.getUint32(body + 28, true) || 6;
      else if (id === 'rate') rates = words();
      else if (id === 'seq ') seq = words();
      else if (id === 'LIST' && ascii(bytes, body) === 'fram') {
        for (let p = body + 4; p + 8 <= Math.min(body + size, bytes.length);) {
          const chunkSize = dv.getUint32(p + 4, true);
          if (ascii(bytes, p) === 'icon') icons.push(bytes.subarray(p + 8, p + 8 + chunkSize));
          p += 8 + chunkSize + (chunkSize & 1);
        }
      }
      pos = body + size + (size & 1);
    }
    if (!icons.length) throw new Error('This .ani file has no frames in it.');
    const pictures = await Promise.all(icons.map(decodeIconFile));
    const steps = seq && seq.length ? seq.filter((i) => i < pictures.length) : pictures.map((_, i) => i);
    // Times are in 1/60 s ("jiffies")
    return steps.map((index, n) => ({ ...pictures[index], delay: (((rates && rates[n]) || rate) * 1000) / 60 }));
  }

  // Xcursor (a file from a Linux cursor theme): pictures in several sizes, each with its own time; the
  // size closest to 48 px is used, with all of its frames
  function decodeXcursor(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = dv.getUint32(12, true);
    const images = [];
    for (let i = 0; i < count; i++) {
      const t = 16 + i * 12;
      if (t + 12 > bytes.length) break;
      if (dv.getUint32(t, true) !== 0xfffd0002) continue; // pictures (the other kind is comments)
      const pos = dv.getUint32(t + 8, true);
      images.push({
        nominal: dv.getUint32(pos + 8, true),
        width: dv.getUint32(pos + 16, true),
        height: dv.getUint32(pos + 20, true),
        hotX: dv.getUint32(pos + 24, true),
        hotY: dv.getUint32(pos + 28, true),
        delay: dv.getUint32(pos + 32, true),
        pixels: pos + dv.getUint32(pos, true),
      });
    }
    if (!images.length) throw new Error('This cursor file has no pictures in it.');
    const sizes = [...new Set(images.map((img) => img.nominal))];
    const size = sizes.sort((a, b) => Math.abs(a - 48) - Math.abs(b - 48) || b - a)[0];
    return images.filter((img) => img.nominal === size).map((img) => {
      const out = new ImageData(img.width, img.height);
      for (let i = 0; i < img.width * img.height; i++) {
        // ARGB, with the colours already multiplied by the alpha
        const v = dv.getUint32(img.pixels + i * 4, true);
        const a = v >>> 24;
        const un = (c) => (a ? Math.min(255, Math.round((c * 255) / a)) : 0);
        out.data.set([un((v >>> 16) & 255), un((v >>> 8) & 255), un(v & 255), a], i * 4);
      }
      return { image: out, width: img.width, height: img.height, hotX: img.hotX, hotY: img.hotY, delay: img.delay };
    });
  }

  async function readCursorFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = cursorKind(bytes);
    if (kind === 'ani') return decodeAni(bytes);
    if (kind === 'xcursor') return decodeXcursor(bytes);
    if (kind === 'cur') return [await decodeIconFile(bytes)];
    return null; // an ordinary picture
  }

  // All frames side by side in one PNG, each in a box as big as the biggest frame
  async function cursorStrip(frames) {
    const width = Math.max(...frames.map((f) => f.width));
    const height = Math.max(...frames.map((f) => f.height));
    const canvas = h('canvas', { width: width * frames.length, height });
    const ctx = canvas.getContext('2d');
    frames.forEach((f, i) => {
      if (f.image instanceof ImageData) ctx.putImageData(f.image, i * width, 0);
      else ctx.drawImage(f.image, i * width, 0);
    });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('This browser could not turn the cursor into a picture.');
    return { blob, width, height };
  }

  // Uploading a pointer: a cursor file becomes a strip of frames; anything else is used as it is
  async function pickCursor(cur, file) {
    let frames;
    try {
      frames = await readCursorFile(file);
    } catch (error) {
      alert(`${file.name} couldn’t be read as a cursor: ${error.message}`);
      return;
    }
    if (!frames) {
      const path = stageFile(file, `assets/cursor-${Date.now().toString(36)}${extension(file) || '.png'}`);
      if (!path) return;
      cur.image = path;
      delete cur.frames;
      if (cur.tip === 'hotspot') cur.tip = 'center';
      rerenderTab();
      return;
    }
    const { blob, width, height } = await cursorStrip(frames);
    const name = file.name.replace(/\.[^.]*$/, '') || 'cursor';
    const path = stageFile(new File([blob], `${name}.png`, { type: 'image/png' }), `assets/cursor-${slug(name)}-${Date.now().toString(36)}.png`);
    if (!path) return;
    const first = frames[0];
    cur.image = path;
    cur.frames = {
      count: frames.length,
      width,
      height,
      delays: frames.map((f) => Math.round(f.delay) || 100),
      hotX: Number.isFinite(first.hotX) ? first.hotX : null,
      hotY: Number.isFinite(first.hotY) ? first.hotY : null,
    };
    if (cur.frames.hotX !== null) cur.tip = 'hotspot';
    cur.size = Math.min(Math.max(width, 16), 96);
    rerenderTab();
  }

  // The uploaded pointer as it moves: the strip, one frame at a time
  function cursorPreview(cur) {
    const src = cur.image ? (window.SITE_ASSET_OVERRIDES[cur.image] || cur.image) : '';
    if (!src) return null;
    const frames = cur.frames && cur.frames.count > 1 ? cur.frames : null;
    if (!frames) return h('img', { class: 'adm-cursor-preview', src, alt: '' });
    const box = h('span', { class: 'adm-cursor-preview adm-cursor-anim', role: 'img', 'aria-label': `${frames.count} frames` });
    box.style.backgroundImage = `url("${src}")`;
    box.style.setProperty('--frames', frames.count);
    box.style.setProperty('--ratio', frames.height / frames.width);
    box.style.setProperty('--duration', `${frames.delays.reduce((sum, d) => sum + d, 0)}ms`);
    return box;
  }

  function cursorBox(theme) {
    const cur = theme.cursor;
    const style = cur.style;
    const colour = () => choice(cur, 'color', 'Colour', [['invert', 'Inverted (shows on anything)'], ['accent', 'Main accent'], ['accent2', 'Second accent']]);
    const grow = (label) => check(cur, 'grow', label || 'Grow over links and buttons');
    const styleName = { off: 'Off', dot: 'Dot', label: 'Label', spotlight: 'Spotlight', image: cur.frames && cur.frames.count > 1 ? 'Your own pointer, animated' : 'Your own pointer' }[style] || style;
    return fold('cursor', 'Mouse effect', styleName,
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
        slider(cur, 'size', 'Dot size', 8, 30, 1, ' px', null, restyle(theme)),
        colour(),
        grow(),
        style === 'label' ? h('p', { class: 'adm-hint', text: 'Over a project it becomes a circle saying \u201CView\u201D, or \u201CPlay\u201D when the project has videos. The words follow the site\u2019s language (Site tab \u2192 Languages \u2192 interface text).' }) : null,
      ] : null,
      style === 'spotlight' ? [
        slider(cur, 'glowSize', 'Glow size', 150, 600, 10, ' px', null, restyle(theme)),
        slider(cur, 'glowStrength', 'Glow strength', 5, 40, 1, '%', null, restyle(theme)),
        choice(cur, 'glowColor', 'Glow colour', [['accent', 'Main accent'], ['accent2', 'Second accent']]),
      ] : null,
      style === 'image' ? [
        h('div', { class: 'adm-field' },
          h('span', { class: 'adm-label', text: 'Pointer image' }),
          h('div', { class: 'adm-inline' },
            cursorPreview(cur),
            cur.frames ? h('span', { class: 'adm-hint', text: cur.frames.count > 1 ? `Animated, ${cur.frames.count} frames` : 'From a cursor file' }) : currentFile(cur.image),
            cur.image ? h('button', { class: 'adm-link', type: 'button', text: 'Remove', onclick: () => { cur.image = ''; delete cur.frames; if (cur.tip === 'hotspot') cur.tip = 'center'; rerenderTab(); } }) : null),
          filePicker('image/png,image/svg+xml,image/gif,image/webp,.png,.svg,.gif,.webp,.ani,.cur,.ico', (file) => pickCursor(cur, file)),
          h('span', { class: 'adm-hint', text: 'A PNG or SVG with a transparent background, or a cursor file: .cur or animated .ani (Windows), or a file from a Linux cursor theme (Xcursor, e.g. left_ptr from the theme’s cursors folder; choose “All files” to see it). Animations play at their own speed. Until there is one, a dot is shown.' })),
        slider(cur, 'size', 'Size', 16, 96, 2, ' px', null, restyle(theme)),
        choice(cur, 'tip', 'Where it points', [
          ...(cur.frames && cur.frames.hotX !== null ? [['hotspot', 'Where the cursor file says']] : []),
          ['center', 'The middle of the image'], ['top-left', 'The top-left corner (for arrow shapes)']]),
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
  const KIND_LABELS = { hero: 'Top', about: 'About', reel: 'Showreel', work: 'Work', grid: 'Work', experience: 'Timeline', toolkit: 'Toolkit', contact: 'Contact', footer: 'Footer',
    text: 'Text', gallery: 'Gallery', video: 'Video', quotes: 'Quotes', logos: 'Logos', numbers: 'Numbers', faq: 'FAQ', cta: 'Call to action' };
  // What "+ Add section" offers: [kind, button, what it is, title it starts with]
  const NEW_SECTIONS = [
    ['text', 'Text', 'A title, text with formatting, a picture and buttons', 'New section'],
    ['gallery', 'Gallery', 'A grid of pictures that open big', 'Gallery'],
    ['video', 'Video', 'One video, from YouTube or a file', 'Video'],
    ['quotes', 'Testimonials', 'Quotes from clients, with their name and photo', 'Kind words'],
    ['logos', 'Logos', 'A row of client or partner logos', 'Worked with'],
    ['numbers', 'Numbers', 'A few big figures, e.g. 120+ videos edited', 'In numbers'],
    ['faq', 'FAQ', 'Questions that open to show their answer', 'Questions'],
    ['cta', 'Call to action', 'One big line with a button', ''],
    ['grid', 'Work grid', 'Projects from the categories you pick', 'More work'],
  ];

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
    if (own && own.trim()) return window.SiteText.plain(own.trim());
    if (SECTION_KEYS[id]) return uiDefault(SECTION_KEYS[id][0]) || SECTION_NAMES[id];
    const kind = kindOf(id);
    return kind === 'grid' ? uiDefault('work.title') : kind === 'text' ? '(untitled section)' : KIND_LABELS[kind];
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

  // The same first blocks for every section: title, menu and link, then its look and layout
  // Content: the title first
  function titleField(id, set) {
    const keys = SECTION_KEYS[id];
    const titleHint = keys ? uiDefault(keys[0]) : kindOf(id) === 'grid' ? uiDefault('work.title') : '';
    return field('Title', formattable(text(set, 'title', { placeholder: titleHint, onchange: () => rerenderTab() })));
  }

  // Layout: the arrangement, the look and the parts
  function layoutTab(id, set) {
    return [
      kindOf(id) !== 'text' && layoutOptions(id) ? h('div', { class: 'adm-form adm-group-box' },
        h('h3', { class: 'adm-group', text: 'Arrangement' }),
        layoutPicker(id, layoutOptions(id))) : null,
      lookBox(id, set),
    ];
  }

  // Settings: menu, address and page
  function settingsBox(id, set) {
    const keys = SECTION_KEYS[id];
    const titleHint = keys ? uiDefault(keys[0]) : kindOf(id) === 'grid' ? uiDefault('work.title') : '';
    const navHint = keys && keys[1] ? uiDefault(keys[1]) : set.title || titleHint || 'Same as the title';
    return [
      h('div', { class: 'adm-form adm-group-box' },
        field('Menu label', text(set, 'nav', { placeholder: navHint })),
        check(set, 'inMenu', 'Show in the menu'),
        anchorField(id, set),
        state.draft.pages.length ? field('On the page', h('select', { onchange: (e) => moveToPage(id, e.target.value) },
          [['', 'Home'], ...state.draft.pages.map((pg) => [pg.id, pg.title || pg.slug])]
            .map(([value, label]) => h('option', { value, text: label, selected: value === shownPage() }))), 'Moving it takes it off this page.') : null),
    ];
  }

  // The name at the end of the section's address (#services), for links from elsewhere
  const anchorSlug = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 40);

  function anchorField(id, set) {
    const note = h('span', { class: 'adm-hint' });
    const showNote = () => {
      const c = state.draft;
      const name = set.anchor;
      const taken = name && name !== id && (allSectionIds(c).includes(name)
        || Object.entries(c.sections).some(([sid, other]) => sid !== id && other && other.anchor === name)
        || (document.getElementById(name) && !document.getElementById(name).closest(`#${id}`)));
      note.className = taken ? 'adm-error' : 'adm-hint';
      note.textContent = taken
        ? `“${name}” is already used on the page, so the section keeps #${id}.`
        : `Its address: ${siteAddress(c.site) || ''}#${name || id}. Use it in buttons and links, e.g. #${name || id}.`;
    };
    showNote();
    return h('div', { class: 'adm-field' },
      field('Link name', h('input', {
        type: 'text',
        value: set.anchor || '',
        placeholder: id,
        onchange: (e) => {
          set.anchor = anchorSlug(e.target.value);
          e.target.value = set.anchor;
          showNote();
          changed();
        },
      })),
      note);
  }

  // Background, title look, width, spacing and devices, then the parts

  function lookBox(id, set) {
    const background = h('select', {
      onchange: (e) => {
        set.background = e.target.value;
        if (set.background === 'custom' && !isHex(set.bgColor)) set.bgColor = '#1d2633';
        rerenderTab();
      },
    }, [['main', 'Page background'], ['alt', 'Second background'], ['custom', 'Your own colour or picture']]
      .map(([value, label]) => h('option', { value, text: label, selected: set.background === value })));
    return h('div', { class: 'adm-form adm-group-box adm-look' },
      h('h3', { class: 'adm-group', text: 'Look' }),
      h('div', { class: 'adm-form' },
        h('div', { class: 'adm-row2' },
          field('Background', background),
          choice(set, 'titleStyle', 'Title style', [['large', 'Large, with a dot'], ['small', 'Small, with a line']])),
        set.background === 'custom' ? customBackground(id, set) : null,
        slider(set, 'titleSize', 'Title size', 40, 200, 5, '%',
          'A small title on the same background as the section above makes it read as part of that section.'),
        h('div', { class: 'adm-row3' },
          choice(set, 'width', 'Width', [['normal', 'Normal'], ['narrow', 'Narrow'], ['wide', 'Wide'], ['full', 'Full width']]),
          choice(set, 'spacing', 'Space around', [['normal', 'Normal'], ['compact', 'Compact'], ['roomy', 'Roomy']]),
          choice(set, 'device', 'Show on', [['all', 'All screens'], ['desktop', 'Computers only'], ['phone', 'Phones only']])),
        partsBox(id)));
  }

  // With both versions (dark and light for visitors), the colour has one for each, the second made from the
  // first until it's changed; a picture can stay dark in the light version or be lightened, or have its own
  const otherPictureOpen = new Set();

  function customBackground(id, set) {
    const T = window.SiteTheme;
    const theme = state.draft.theme;
    const main = T.colors(theme).mode;
    const other = otherMode(main);
    const colour = isHex(set.bgColor) ? set.bgColor : '#1d2633';
    const circle = (mode) => {
      const isMain = mode === main;
      const value = isMain ? colour : isHex(set.bgColorOther) ? set.bgColorOther : T.otherBackground(colour, other);
      return h('label', { class: 'adm-color', title: `${mode === 'dark' ? 'Dark' : 'Light'} version` },
        h('input', {
          type: 'color',
          value,
          onclick: () => T.showMode(mode),
          oninput: (e) => {
            if (isMain) set.bgColor = e.target.value;
            else set.bgColorOther = e.target.value;
            T.showMode(mode);
            changed();
          },
          onchange: () => rerenderTab(),
        }),
        h('span', { text: MODE_NAMES[mode] }));
    };
    const picture = (file, key) => {
      const path = stageFile(file, `assets/sections/bg-${slug(sectionLabel(id))}-${Date.now().toString(36)}${extension(file)}`);
      if (path) { set[key] = path; rerenderTab(); }
    };
    const lightChoice = theme.switchable && other === 'light' && set.bgImage;
    return h('div', { class: 'adm-form' },
      h('div', { class: 'adm-field' },
        h('span', { class: 'adm-label', text: 'Colour' }),
        theme.switchable
          ? h('div', { class: 'adm-inline adm-bg-versions' }, circle('dark'), circle('light'),
            isHex(set.bgColorOther) ? h('button', { class: 'adm-link', type: 'button', text: `Make the ${other} one match again`, onclick: () => { delete set.bgColorOther; rerenderTab(); } }) : null)
          : h('div', { class: 'adm-inline' },
            h('input', { type: 'color', value: colour, oninput: (e) => { set.bgColor = e.target.value; changed(); } }),
            h('span', { class: 'adm-hint', text: 'The text turns light or dark to read on it.' })),
        theme.switchable ? h('span', { class: 'adm-hint', text: `The ${other} one is made from the ${main} one until you change it. The text turns light or dark to read on each.` }) : null),
      fileField('Picture (optional)', set.bgImage, 'image/*', (file) => picture(file, 'bgImage'),
        () => { set.bgImage = ''; delete set.bgImageOther; rerenderTab(); }, 'Covers the whole section, darkened so light text reads on it.'),
      set.bgImage ? slider(set, 'bgDarken', lightChoice && set.bgOther === 'light' ? 'Darken (or, in light, lighten) the picture' : 'Darken the picture', 0, 90, 5, '%') : null,
      lightChoice ? choice(set, 'bgOther', 'In the light version', [['dark', 'Keep it dark'], ['light', 'Lighten it']],
        'Lightened, the picture gets a white veil and the text turns dark.') : null,
      lightChoice && (set.bgImageOther || otherPictureOpen.has(id))
        ? fileField('Picture for the light version', set.bgImageOther, 'image/*', (file) => picture(file, 'bgImageOther'),
          () => { delete set.bgImageOther; otherPictureOpen.delete(id); rerenderTab(); })
        : lightChoice ? h('div', null, h('button', { class: 'adm-link', type: 'button', text: 'Use a different picture for the light version', onclick: () => { otherPictureOpen.add(id); rerenderTab(); } })) : null);
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
      h('div', { class: 'adm-form adm-group-box', 'data-adm-section': 'resume' },
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
      field('Intro line', formattable(area(state.draft.intros, 'reel', 2))),
      reelTab(),
    ];
  }

  // The title above the message form: interface text, in the editing language (empty = the standard one)
  function formTitleField() {
    const { obj, key } = fieldSlot('ui:contact.formTitle');
    const texts = (window.SITE_UI_TEXT || {})['contact.formTitle'] || {};
    const standard = texts[lang()] || texts.en || '';
    return field('Form title', bind(h('input', {
      type: 'text',
      value: obj[key] || '',
      placeholder: standard,
      oninput: (e) => { obj[key] = e.target.value; changed(); },
    }), obj, key), 'You can also click it on the page and type.');
  }

  function contactEditor() {
    return [
      partToggles([['contact.intro', 'Intro line'], ['contact.form', 'Message form'], ['contact.linkedin', 'LinkedIn button'],
        ['contact.socials', 'Social icons'], ['contact.email', 'Email address']]),
      field('Intro line', formattable(area(state.draft.intros, 'contact', 2))),
      formTitleField(),
      h('p', { class: 'adm-hint', text: 'Your email address, social links and how the form sends messages are in the Site tab.' }),
    ];
  }

  // ---------- Added sections (Text, Gallery, Video, …) ----------
  // Name a new upload after the section, e.g. assets/sections/clients-logo-lx3k9.png
  const sectionFile = (sec, part, file) => stageFile(file, `assets/sections/${slug(sectionLabel(sec.id))}-${part}-${Date.now().toString(36)}${extension(file)}`);

  const alignChoice = (sec) => choice(sec, 'align', 'Alignment', [['left', 'Left'], ['center', 'Centred']]);

  function introField(sec) {
    return h('div', { class: 'adm-row2' }, field('Intro line (optional)', formattable(area(sec, 'intro', 2))), alignChoice(sec));
  }

  function textEditor(sec) {
    return h('div', { class: 'adm-form' },
      block('Text', richArea(sec, 'text', 7), FORMAT_HINT),
      h('div', { class: 'adm-row2' },
        alignChoice(sec),
        choice(sec, 'columns', 'Text in', [[1, 'One column'], [2, 'Two columns']])),
      fileField('Picture (optional)', sec.image, 'image/*', (file) => {
        const path = sectionFile(sec, 'picture', file);
        if (path) { sec.image = path; rerenderTab(); }
      }, () => { sec.image = ''; rerenderTab(); }),
      sec.image ? block('Picture position', layoutPicker(sec.id, layoutOptions(sec.id))) : null,
      sec.image ? field('Picture description (for screen readers)', text(sec, 'imageAlt')) : null,
      buttonsEditor(sec.buttons));
  }

  function galleryEditor(sec) {
    return h('div', { class: 'adm-form' },
      introField(sec),
      h('div', { class: 'adm-row2' },
        choice(sec, 'shape', 'Picture shape', [['square', 'Square'], ['wide', 'Landscape'], ['natural', 'Their own shape']]),
        slider(sec, 'columns', 'Pictures per row', 2, 5, 1, '', 'Phones show two per row.')),
      picturesField(sec.images, sectionLabel(sec.id), {
        captions: true,
        folder: 'sections',
        empty: 'Visitors click a picture to see it big, and go through the others with the arrows. You can pick several files at once.',
      }));
  }

  function videoEditor(sec) {
    const { modeSelect, source } = videoSource(sec, sectionLabel(sec.id), 'sections');
    return h('div', { class: 'adm-form' },
      introField(sec),
      modeSelect,
      source,
      sec.youtube ? null : fileField('Cover picture (optional)', sec.thumb, 'image/*', (file) => {
        const path = sectionFile(sec, 'cover', file);
        if (path) { sec.thumb = path; rerenderTab(); }
      }, () => { sec.thumb = ''; rerenderTab(); }, 'Shown until the video plays.'),
      field('Caption (optional)', formattable(text(sec, 'caption')), 'A line under the video.'));
  }

  function quotesEditor(sec) {
    return h('div', { class: 'adm-form' },
      introField(sec),
      entryList(sec.items, {
        what: 'quote',
        label: (item) => [item.name, item.quote.slice(0, 50)].filter(Boolean).join(': '),
        make: () => ({ ...ITEM_FIELDS.quotes }),
        form: (item) => [
          block('Quote', richArea(item, 'quote', 3)),
          h('div', { class: 'adm-row2' },
            field('Name', text(item, 'name', { placeholder: 'e.g. Sam Janssens' })),
            field('Role or company', text(item, 'role', { placeholder: 'e.g. Producer, StartupAwards' }))),
          fileField('Photo (optional)', item.photo, 'image/*', (file) => {
            const path = sectionFile(sec, 'person', file);
            if (path) { item.photo = path; rerenderTab(); }
          }, () => { item.photo = ''; rerenderTab(); }, 'A small round picture beside the name.'),
        ],
      }));
  }

  function logosEditor(sec) {
    return h('div', { class: 'adm-form' },
      introField(sec),
      choice(sec, 'style', 'Logos shown', [['grey', 'In grey, in colour when pointed at'], ['color', 'In colour'], ['white', 'All white'], ['black', 'All black']],
        'All white or all black makes logos of different colours look like one set. PNG or SVG with a transparent background works best.'),
      entryList(sec.items, {
        what: 'logo',
        label: (item) => item.alt || (item.src ? item.src.split('/').pop() : ''),
        make: () => ({ ...ITEM_FIELDS.logos }),
        form: (item) => [
          fileField('Logo', item.src, 'image/*', (file) => {
            const path = sectionFile(sec, 'logo', file);
            if (path) { item.src = path; rerenderTab(); }
          }, () => { item.src = ''; rerenderTab(); }),
          h('div', { class: 'adm-row2' },
            field('Name (for screen readers)', text(item, 'alt', { placeholder: 'e.g. StartupAwards' })),
            field('Link (optional)', text(item, 'url', { type: 'url', placeholder: 'https://…' }))),
        ],
      }));
  }

  function numbersEditor(sec) {
    return h('div', { class: 'adm-form' },
      introField(sec),
      entryList(sec.items, {
        what: 'number',
        label: (item) => [item.value, item.label].filter(Boolean).join(' '),
        make: () => ({ ...ITEM_FIELDS.numbers }),
        form: (item) => h('div', { class: 'adm-row2' },
          field('Number', text(item, 'value', { placeholder: 'e.g. 120+' })),
          field('What it counts', formattable(text(item, 'label', { placeholder: 'e.g. videos edited' })))),
      }));
  }

  function faqEditor(sec) {
    return h('div', { class: 'adm-form' },
      introField(sec),
      entryList(sec.items, {
        what: 'question',
        label: (item) => item.q,
        make: () => ({ ...ITEM_FIELDS.faq }),
        form: (item) => [
          field('Question', formattable(text(item, 'q', { placeholder: 'e.g. How long does a project take?' }))),
          block('Answer', richArea(item, 'a', 4)),
        ],
      }));
  }

  function ctaEditor(sec) {
    return h('div', { class: 'adm-form' },
      field('Big line', formattable(area(sec, 'text', 2)), 'e.g. Let’s make something together.'),
      field('Line under it (optional)', formattable(area(sec, 'sub', 2))),
      alignChoice(sec),
      buttonsEditor(sec.buttons));
  }

  const SECTION_EDITORS = { text: textEditor, gallery: galleryEditor, video: videoEditor, quotes: quotesEditor, logos: logosEditor, numbers: numbersEditor, faq: faqEditor, cta: ctaEditor };

  // Which Work section a project shows up in first (for the ✎ on a card)
  function gridForProject(index) {
    const c = state.draft;
    const item = c.work[index];
    return allOrders().flat().find((id) => {
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
    const shown = allOrders().flat().filter((sid) => kindOf(sid) === 'work' || kindOf(sid) === 'grid').map((sid) => c.sections[sid].categories || []);
    const missing = shown.some((list) => !list.length) ? [] : c.categories.filter((cat) => !shown.some((list) => list.includes(cat.id)) && c.work.some((w) => w.type === cat.id));

    return [
      partToggles([[`${id}.intro`, 'Intro line'], [`${id}.highlights`, 'Highlights slider'], [`${id}.filters`, 'Filter buttons'], [`${id}.grid`, 'Project cards']]),
      field('Intro line', formattable(id === 'work' ? area(c.intros, 'work', 2) : area(grid, 'intro', 2))),
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
      h('div', { class: 'adm-form adm-group-box' },
        h('h3', { class: 'adm-group', text: 'Opening a project' }),
        choice(c, 'projectView', 'A project opens', [['popup', 'In a pop-up over the page'], ['page', 'As a page of its own']],
          'Either way, each project has its own link to share (open a project below to copy it), and the back button closes it. Shared by all Work sections.')),
      projectsList(entries, set.categories[0] || (c.categories[0] || {}).id),
    ];
  }

  // A list of projects: one Work section's, or all of them. Drag ⠿ to move one, or use the arrows (which
  // swap it with the neighbour shown here); ⧉ duplicates it. The search box filters the list as you type.
  let projectQuery = '';

  function projectsList(entries, newType) {
    const work = state.draft.work;
    // Changes the order, keeping the open project open
    const reorder = (change) => {
      const open = work[state.openItem];
      change();
      state.openItem = open ? work.indexOf(open) : null;
      rerenderTab();
    };
    const swap = (a, b) => reorder(() => { [work[a], work[b]] = [work[b], work[a]]; });
    const add = (atEnd) => {
      const item = normalizeWork({ type: newType, title: 'New project', teaser: 'One line about it.' });
      if (atEnd) work.push(item);
      else work.unshift(item);
      state.openItem = work.indexOf(item);
      projectQuery = '';
      rerenderTab();
    };
    const matches = (item) => {
      const query = projectQuery.trim().toLowerCase();
      return !query || [item.title, item.client, item.year, item.role, item.teaser, categoryName(item.type)].join(' ').toLowerCase().includes(query);
    };

    const list = h('div', { class: 'adm-entry-list' });
    const noMatch = h('p', { class: 'adm-hint', text: 'No projects match.', hidden: true });
    const filter = () => {
      let shown = 0;
      list.querySelectorAll(':scope > .adm-entry').forEach((row) => {
        row.hidden = !matches(work[Number(row.dataset.index)]);
        if (!row.hidden) shown += 1;
      });
      noMatch.hidden = shown > 0 || !entries.length;
    };

    entries.forEach(({ item, index }, n) => {
      const isOpen = state.openItem === index;
      const handle = h('span', { class: 'adm-handle', title: 'Drag to move', text: '⠿' });
      const badge = [categoryName(item.type), item.featured ? 'featured' : '', item.draft ? 'draft' : ''].filter(Boolean).join(' · ');
      const row = h('div', { class: `adm-entry${isOpen ? ' is-open' : ''}${item.draft ? ' is-draft' : ''}`, 'data-index': index },
        h('div', { class: 'adm-entry-head' },
          handle,
          h('button', {
            class: 'adm-entry-title',
            type: 'button',
            'aria-expanded': String(isOpen),
            onclick: () => { state.openItem = isOpen ? null : index; rerenderTab(); },
          }, h('span', { class: 'adm-badge', text: badge }), bind(h('span', { text: item.title || '(untitled)' }), item, 'title', '(untitled)')),
          h('div', { class: 'adm-row-controls' },
            iconBtn('↑', 'Move up', () => swap(index, entries[n - 1].index), n === 0),
            iconBtn('↓', 'Move down', () => swap(index, entries[n + 1].index), n === entries.length - 1),
            iconBtn('⧉', 'Duplicate project', () => {
              const copy = clone(item);
              copy.title = item.title ? `${item.title} (copy)` : '';
              work.splice(index + 1, 0, copy);
              state.openItem = index + 1;
              rerenderTab();
            }),
            iconBtn('✕', 'Delete project', () => {
              if (!confirm('Delete this project?')) return;
              reorder(() => work.splice(index, 1));
            }))),
        isOpen ? workForm(item) : null);
      list.appendChild(sortable(row, handle, 'projects', index, (from, to, before) => reorder(() => moveTo(work, from, to, before))));
    });
    filter();

    return h('div', { class: 'adm-form' },
      h('div', { class: 'adm-section-head' },
        h('span', { class: 'adm-label', text: `Projects (${entries.length})` }),
        h('button', { class: 'adm-btn adm-btn-primary', type: 'button', text: '+ Add project', title: 'Adds it at the top', onclick: () => add(false) })),
      entries.length > 4 ? h('input', {
        type: 'search',
        value: projectQuery,
        placeholder: 'Search by title, client, year…',
        'aria-label': 'Search projects',
        oninput: (e) => { projectQuery = e.target.value; filter(); },
      }) : null,
      entries.length ? null : h('p', { class: 'adm-hint', text: 'No projects here yet.' }),
      list,
      noMatch,
      entries.length ? h('div', null, h('button', { class: 'adm-link', type: 'button', text: '+ Add a project at the end', onclick: () => add(true) })) : null);
  }

  // Every project in one list, whichever Work section shows it, with a category filter
  function allProjectsView() {
    const c = state.draft;
    const cat = c.categories.some((x) => x.id === state.projectCategory) ? state.projectCategory : '';
    const entries = c.work.map((item, index) => ({ item, index })).filter(({ item }) => !cat || item.type === cat);
    return h('div', { class: 'adm-form' },
      h('div', { class: 'adm-section-head' },
        h('button', { class: 'adm-btn', type: 'button', text: '← Page outline', onclick: () => { state.allProjects = false; rerenderTab(); } }),
        h('select', { 'aria-label': 'Category', class: 'adm-narrow', onchange: (e) => { state.projectCategory = e.target.value; rerenderTab(); } },
          [['', 'All categories'], ...c.categories.map((x) => [x.id, x.label || x.id])]
            .map(([value, label]) => h('option', { value, text: label, selected: cat === value })))),
      h('p', { class: 'adm-help', text: 'All your projects, whichever Work section shows them. The order here is their order on the page.' }),
      projectsList(entries, cat || (c.categories[0] || {}).id));
  }

  // An open section shows one of these at a time (the same one for every section, until switched)
  const ROW_TABS = [['content', 'Content'], ['layout', 'Layout'], ['settings', 'Settings']];

  function rowTabs(tabs, current) {
    return h('div', { class: 'adm-row-tabs', role: 'tablist' }, tabs.map(([tab, label]) => h('button', {
      class: `adm-row-tab${tab === current ? ' is-active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': String(tab === current),
      text: label,
      onclick: () => { state.rowTab = tab; rerenderTab(); },
    })));
  }

  function editorFor(id) {
    const kind = id === 'hero' || id === 'footer' ? id : kindOf(id);
    if (kind === 'hero') {
      // The top section: its text and resume, or everything about how it looks
      const tabs = ROW_TABS.slice(0, 2);
      const tab = tabs.some(([t]) => t === state.rowTab) ? state.rowTab : 'content';
      const all = heroEditor();
      const textBox = all.querySelector('[data-adm-section="hero"]');
      const resume = all.querySelector('[data-adm-section="resume"]');
      if (tab === 'content') return h('div', { class: 'adm-form' }, rowTabs(tabs, tab), textBox, resume);
      textBox.remove();
      resume.remove();
      return h('div', { class: 'adm-form' }, rowTabs(tabs, tab), all);
    }
    if (kind === 'footer') {
      return h('div', { class: 'adm-form' },
        partToggles([['footer.links', 'Links']]),
        h('p', { class: 'adm-hint', text: 'Choose which links appear here in the Site tab (“In footer”).' }));
    }
    const builtin = window.SiteSections.builtin.includes(id);
    const added = state.draft.customSections.find((s) => s.id === id);
    const tab = ROW_TABS.some(([t]) => t === state.rowTab) ? state.rowTab : 'content';
    const set = state.draft.sections[id];
    if (tab === 'layout') return h('div', { class: 'adm-form' }, rowTabs(ROW_TABS, tab), layoutTab(id, set));
    if (tab === 'content') {
      const body = added ? SECTION_EDITORS[kind](added)
        : { about: aboutEditor, reel: reelEditor, work: () => workEditor(id), grid: () => workEditor(id), experience: experienceTab, toolkit: toolkitTab, contact: contactEditor }[kind]();
      return h('div', { class: 'adm-form' }, rowTabs(ROW_TABS, tab), titleField(id, set), body);
    }
    return h('div', { class: 'adm-form' },
      rowTabs(ROW_TABS, tab),
      settingsBox(id, set),
      h('div', { class: 'adm-row-foot' },
        builtin ? null : h('button', {
          class: 'adm-btn',
          type: 'button',
          text: 'Duplicate section',
          title: 'A copy right under it, with the same content and look',
          onclick: () => duplicateSection(id),
        }),
        h('button', {
          class: 'adm-btn adm-btn-danger',
          type: 'button',
          text: builtin ? 'Remove from the page' : 'Delete section',
          title: builtin ? 'Its content is kept; add it back with “+ Add section”.' : 'Deletes the section and its content',
          onclick: () => removeSection(id),
        })));
  }

  // ---------- Pages ----------
  // The panel works on the page shown on the screen: its outline, adding and moving sections. Switching
  // pages (here or with the site's menu) shows that page and its sections.
  const shownPage = () => (window.SitePages ? window.SitePages.current() : '');

  // The sections of the page shown, in their order (the array itself, to change)
  function pageOrder() {
    const page = shownPage() && state.draft.pages.find((pg) => pg.id === shownPage());
    return page ? page.order : state.draft.sections.order;
  }

  const allOrders = () => [state.draft.sections.order, ...state.draft.pages.map((pg) => pg.order)];

  // A page's address name: lowercase, unique among the pages
  function pageSlug(text, exceptId) {
    const base = anchorSlug(text) || 'page';
    let slug = base;
    for (let n = 2; state.draft.pages.some((pg) => pg.slug === slug && pg.id !== exceptId); n++) slug = `${base}-${n}`;
    return slug;
  }

  function goToPage(pageId) {
    stopEditing();
    if (pageId === shownPage()) return;
    state.openRow = null;
    window.SitePages.show(pageId);
  }

  // The site switched pages (here, or a link in its menu): the page gets its editing extras, the panel its outline
  document.addEventListener('site:pagechange', () => {
    if (!state.draft || !root || root.hidden) return;
    renderPage(state.draft);
    const body = screen && screen.querySelector('.adm-body');
    if (body && state.tab === 'page') {
      state.allProjects = false;
      renderTab(body);
    }
  });

  function addPage() {
    const c = state.draft;
    const id = `page-${Date.now().toString(36)}`;
    // It starts with a Text section, so there's something to see and change
    const first = newSectionId('text');
    c.sections[first] = newSectionSettings('text', 'New page');
    c.customSections.push(normalizeSection({ id: first, type: 'text', ...clone(SECTION_STARTERS.text) }));
    c.pages.push({ id, slug: pageSlug('new page'), title: 'New page', nav: '', inMenu: true, order: [first] });
    rerenderTab();
    goToPage(id);
  }

  function deletePage(page) {
    const c = state.draft;
    if (!confirm(`Delete the page “${page.title || page.slug}”? Its sections move to the end of the home page, so nothing is lost.`)) return;
    const home = c.sections.order;
    page.order.forEach((id) => {
      if (home.includes('contact')) home.splice(home.indexOf('contact'), 0, id);
      else home.push(id);
    });
    c.pages = c.pages.filter((pg) => pg !== page);
    rerenderTab();
    goToPage('');
  }

  // A section to another page (at its end; on the home page, before Contact)
  function moveToPage(id, pageId) {
    const c = state.draft;
    allOrders().forEach((order) => { if (order.includes(id)) order.splice(order.indexOf(id), 1); });
    const dest = pageId ? c.pages.find((pg) => pg.id === pageId).order : c.sections.order;
    if (!pageId && dest.includes('contact')) dest.splice(dest.indexOf('contact'), 0, id);
    else dest.push(id);
    state.openRow = null;
    rerenderTab();
  }

  // The pages, to switch between, and the settings of the page shown
  function pagesBox() {
    const c = state.draft;
    const current = shownPage();
    const page = c.pages.find((pg) => pg.id === current);
    const pill = (id, label) => h('button', {
      class: `adm-page-pill${id === current ? ' is-active' : ''}`,
      type: 'button',
      'aria-pressed': String(id === current),
      text: label,
      onclick: () => goToPage(id),
    });
    const at = page ? c.pages.indexOf(page) : -1;
    const movePage = (dir) => {
      [c.pages[at], c.pages[at + dir]] = [c.pages[at + dir], c.pages[at]];
      rerenderTab();
    };
    return h('div', { class: 'adm-form adm-group-box adm-pages' },
      h('div', { class: 'adm-page-pills' },
        pill('', 'Home'),
        c.pages.map((pg) => pill(pg.id, pg.title || pg.slug)),
        h('button', { class: 'adm-page-pill adm-page-add', type: 'button', text: '+ New page', onclick: addPage })),
      page ? h('div', { class: 'adm-form' },
        h('div', { class: 'adm-row2' },
          field('Page title', text(page, 'title', { onchange: () => rerenderTab() })),
          field('Menu label', text(page, 'nav', { placeholder: page.title || 'Same as the title' }))),
        check(page, 'inMenu', 'Show in the menu'),
        field('Address', h('input', {
          type: 'text',
          value: page.slug,
          onchange: (e) => {
            page.slug = pageSlug(e.target.value, page.id);
            e.target.value = page.slug;
            window.history.replaceState(null, '', window.SitePages.href(page.id)); // the browser's (`history` here is the undo list)
            rerenderTab();
          },
        }), `${siteAddress(c.site) || ''}?page=${page.slug}`),
        h('div', { class: 'adm-row-foot' },
          iconBtn('←', 'Earlier in the menu', () => movePage(-1), at === 0),
          iconBtn('→', 'Later in the menu', () => movePage(1), at === c.pages.length - 1),
          h('button', { class: 'adm-btn adm-btn-danger', type: 'button', text: 'Delete page', onclick: () => deletePage(page) })))
        : c.pages.length ? null : h('p', { class: 'adm-hint', text: 'One page for now. A new page gets its own address and a link in the menu, and sections you add or move there.' }));
  }

  // ---------- Adding, removing and moving sections ----------
  function insertSection(id) {
    const order = pageOrder();
    const after = { experience: 'work', toolkit: 'experience' }[id];
    const at = after && order.includes(after) ? order.indexOf(after) + 1
      : id !== 'contact' && order.includes('contact') ? order.indexOf('contact') : order.length;
    order.splice(at, 0, id);
    state.openRow = id;
  }

  // What a new section of each kind starts with, so it shows on the page straight away
  const SECTION_STARTERS = {
    text: { text: 'Write something about this here.' },
    quotes: { items: [{ quote: 'What a client said about working with you.', name: 'Their name', role: 'Their role, company' }] },
    numbers: { items: [{ value: '120+', label: 'projects' }, { value: '8', label: 'years' }, { value: '40', label: 'happy clients' }] },
    faq: { items: [{ q: 'A question people often ask?', a: 'The answer.' }] },
    cta: { text: 'Let’s make something together.', buttons: [{ label: 'Get in touch', url: '#contact', style: 'primary' }] },
  };

  const newSectionId = (kind) => `${kind === 'grid' ? 'work' : 'section'}-${Date.now().toString(36)}`;

  // A new section's settings, with the standard look of its kind
  function newSectionSettings(kind, title) {
    const look = window.SiteSections.look[kind];
    return {
      title, nav: '', anchor: '', inMenu: look.inMenu, background: look.background, bgColor: '', bgImage: '', bgDarken: 50,
      titleStyle: look.titleStyle, titleSize: 100, width: 'normal', spacing: 'normal', device: 'all',
    };
  }

  function addSection(kind, at) {
    const c = state.draft;
    const id = newSectionId(kind);
    c.sections[id] = newSectionSettings(kind, (NEW_SECTIONS.find(([k]) => k === kind) || [])[3] || '');
    if (kind === 'grid') {
      c.sections[id].categories = [];
      c.workGrids.push({ id, intro: '' });
    } else {
      c.customSections.push(normalizeSection({ id, type: kind, ...clone(SECTION_STARTERS[kind] || {}) }));
    }
    if (at == null) {
      insertSection(id);
    } else {
      pageOrder().splice(at, 0, id);
      state.openRow = id;
    }
    rerenderTab();
    setTimeout(() => showOnPage(id), 200);
  }

  // A copy of an added section right under it: same content, look and hidden parts
  function duplicateSection(id) {
    const c = state.draft;
    const kind = kindOf(id);
    const copyId = newSectionId(kind);
    const set = clone(c.sections[id]);
    if (set.title) set.title = `${set.title} (copy)`;
    set.anchor = '';
    c.sections[copyId] = set;
    if (kind === 'grid') c.workGrids.push({ ...clone(c.workGrids.find((g) => g.id === id)), id: copyId });
    else c.customSections.push({ ...clone(c.customSections.find((s) => s.id === id)), id: copyId });
    Object.keys(c.hidden).forEach((key) => {
      if (key.startsWith(`${id}.`)) c.hidden[copyId + key.slice(id.length)] = true;
    });
    const order = pageOrder();
    order.splice(order.indexOf(id) + 1, 0, copyId);
    state.openRow = copyId;
    rerenderTab();
    setTimeout(() => showOnPage(copyId), 200); // once the page behind has it
  }

  function removeSection(id) {
    const c = state.draft;
    const builtin = window.SiteSections.builtin.includes(id);
    if (!confirm(builtin
      ? `Take “${sectionLabel(id)}” off the page? Its content is kept, and you can add it back with “+ Add section”.`
      : `Delete “${sectionLabel(id)}” and its content? This can’t be undone after saving.`)) return;
    allOrders().forEach((order) => { if (order.includes(id)) order.splice(order.indexOf(id), 1); });
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
    const order = pageOrder();
    if (to < 0 || to >= order.length || from === to) return;
    const id = order[from];
    keepInPlace(() => document.getElementById(id), () => {
      order.splice(from, 1);
      order.splice(to, 0, id);
      rerenderTab();
    });
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

  function outlineRow(id, index) {
    const c = state.draft;
    const fixed = id === 'footer';
    const kind = id === 'hero' || fixed ? id : kindOf(id);
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
    const handle = fixed ? h('span', { class: 'adm-handle' }) : h('span', { class: 'adm-handle', title: 'Drag to move', text: '⠿' });

    const row = h('div', { class: `adm-entry adm-outline-row${isOpen ? ' is-open' : ''}${isHidden ? ' is-hidden' : ''}${fixed ? ' is-fixed' : ''}`, 'data-row': id },
      h('div', { class: 'adm-entry-head' },
        handle,
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
          fixed ? null : iconBtn('↓', 'Move down', () => moveSection(index, index + 1), index === pageOrder().length - 1),
          eye)),
      isOpen ? h('div', { class: 'adm-row-body' }, editorFor(id)) : null);

    if (fixed) return row;
    return sortable(row, handle, 'sections', id, (from, to, before) => keepInPlace(() => document.getElementById(from), () => {
      const order = pageOrder();
      moveTo(order, order.indexOf(from), order.indexOf(to), before);
      rerenderTab();
    }));
  }

  function pageTab() {
    if (state.allProjects) return allProjectsView();
    const c = state.draft;
    const removed = c.sections.removed.filter((id) => window.SiteSections.builtin.includes(id));
    return h('div', { class: 'adm-form adm-outline' },
      h('div', { class: 'adm-section-head' },
        h('p', { class: 'adm-help', text: 'The page from top to bottom. Click a section to edit it, drag ⠿ (or use the arrows) to move it, and use the eye to show or hide it.' }),
        h('button', {
          class: 'adm-btn',
          type: 'button',
          text: `All projects (${c.work.length})`,
          title: 'Every project in one list, to search, reorder and edit',
          onclick: () => { state.allProjects = true; rerenderTab(); },
        })),
      pagesBox(),
      h('div', { class: 'adm-outline-list' }, pageOrder().map((id, i) => outlineRow(id, i))),
      h('div', { class: 'adm-add' },
        h('button', {
          class: `adm-btn adm-add-toggle${state.addOpen ? ' is-open' : ''}`,
          type: 'button',
          text: state.addOpen ? '\u00D7 Close' : '+ Add section',
          'aria-expanded': String(Boolean(state.addOpen)),
          onclick: () => { state.addOpen = !state.addOpen; rerenderTab(); },
        }),
        state.addOpen ? h('div', { class: 'adm-add-grid' }, NEW_SECTIONS.map(([kind, name, desc]) => h('button', {
          class: 'adm-add-card',
          type: 'button',
          onclick: () => { state.addOpen = false; addSection(kind); },
        }, h('strong', { text: name }), h('span', { text: desc })))) : null,
        removed.length ? h('div', { class: 'adm-inline' },
          h('span', { class: 'adm-hint', text: 'Put back:' }),
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
          }))) : null),
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

  // A project's own address, to share. Its end follows the title unless a link name is set (then a
  // shared link keeps working when the title changes).
  function projectLink(item) {
    const work = state.draft.work;
    const link = () => window.SiteProjects.link(window.SiteProjects.slugs(work)[work.indexOf(item)]);
    const shown = h('span', { class: 'adm-path adm-grow', text: link() });
    const copy = h('button', {
      class: 'adm-btn',
      type: 'button',
      text: 'Copy link',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(link());
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Select and copy it';
        }
        setTimeout(() => { copy.textContent = 'Copy link'; }, 1600);
      },
    });
    return h('div', { class: 'adm-field' },
      h('span', { class: 'adm-label', text: 'Link to this project' }),
      h('div', { class: 'adm-inline' }, shown, copy),
      h('input', {
        type: 'text',
        value: item.slug || '',
        placeholder: 'Link name (optional), e.g. startup-awards',
        'aria-label': 'Link name',
        maxLength: 60,
        oninput: (e) => { item.slug = e.target.value; shown.textContent = link(); changed(); },
      }),
      h('span', { class: 'adm-hint', text: 'Without a link name, the link follows the title. Set one before sharing the link, so it keeps working if you rename the project.' }));
  }

  function workForm(item) {
    const typeSelect = h('select', { onchange: (e) => { item.type = e.target.value; rerenderTab(); } },
      state.draft.categories.map((cat) => h('option', { value: cat.id, text: cat.label || cat.id, selected: item.type === cat.id })));
    const firstYoutube = (item.videos[0] || {}).youtube;

    const form = h('div', { class: 'adm-form' },
      h('div', { class: 'adm-row2' }, field('Category', typeSelect), field('Title', text(item, 'title'))),
      projectLink(item),
      h('label', { class: 'adm-check' },
        h('input', { type: 'checkbox', checked: Boolean(item.featured), onchange: (e) => { item.featured = e.target.checked; rerenderTab(); } }),
        h('span', { text: 'Featured: shown in the Highlights slider at the top of Work (and still in the grid)' })),
      h('label', { class: 'adm-check' },
        h('input', { type: 'checkbox', checked: Boolean(item.draft), onchange: (e) => { item.draft = e.target.checked; rerenderTab(); } }),
        h('span', { text: 'Draft: only shown while this panel is open, not on the live site' })),
      h('div', { class: 'adm-row3' },
        field('Client', text(item, 'client', { placeholder: 'e.g. StartupAwards' })),
        field('Year', text(item, 'year', { placeholder: 'e.g. 2025' })),
        field('Your role', text(item, 'role', { placeholder: 'e.g. Editing, sound' }))),
      field('Teaser (shown on the card)', formattable(text(item, 'teaser'))),
      field('Full description (shown when the project is opened)', formattable(area(item, 'desc', 5))),
      field('Tools', list(item, 'tools', { placeholder: 'Premiere Pro, After Effects' }), 'Separate with commas.'),
      videosField(item),
      picturesField(item.images, item.title, { empty: 'Shown in the pop-up after the videos, with arrows and thumbnails. You can pick several files at once.' }),
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

  // Pictures (a project's, or a Gallery section's): a strip of small thumbnails. Clicking one shows its few
  // controls underneath, so a big gallery stays a single tidy row of images. Drag one to move it.
  let openPicture = null; // the picture whose controls are shown

  function picturesField(pics, name, { captions, empty, folder = 'work' }) {
    const selected = pics.includes(openPicture) ? openPicture : null;
    const index = pics.indexOf(selected);
    const shift = (to) => {
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
            const path = stageFile(file, `assets/${folder}/${slug(name)}-pic-${Date.now().toString(36)}${n}${extension(file)}`);
            if (path) pics.push({ src: path, alt: '', ...(captions ? { caption: '' } : {}) });
          });
          e.target.value = '';
          rerenderTab();
        },
      }));
    return h('div', { class: 'adm-field' },
      h('div', { class: 'adm-section-head' }, h('span', { class: 'adm-label', text: pics.length ? `Pictures (${pics.length})` : 'Pictures' }), add),
      pics.length ? h('div', { class: 'adm-pictures' }, pics.map((pic, n) => {
        const thumb = h('button', {
          class: `adm-picture${pic === selected ? ' is-selected' : ''}`,
          type: 'button',
          title: pic.alt || pic.caption || 'Click for options, drag to move',
          'aria-pressed': String(pic === selected),
          onclick: () => { openPicture = pic === selected ? null : pic; rerenderTab(); },
        }, h('img', { src: window.SITE_ASSET_OVERRIDES[pic.src] || pic.src, alt: pic.alt || '', draggable: false }),
        state.pending.has(pic.src) ? h('span', { class: 'adm-picture-new', title: 'Uploads on save' }) : null);
        return sortable(thumb, thumb, `pictures-${name}`, n, (from, to, before) => { moveTo(pics, from, to, before); rerenderTab(); }, true);
      }))
        : h('span', { class: 'adm-hint', text: empty }),
      selected ? h('div', { class: 'adm-picture-tools' },
        h('div', { class: 'adm-form adm-grow' },
          text(selected, 'alt', { placeholder: 'Description (for screen readers)' }),
          captions ? text(selected, 'caption', { placeholder: 'Caption (optional, shown under it)' }) : null),
        h('div', { class: 'adm-row-controls' },
          iconBtn('←', 'Move left', () => shift(index - 1), index === 0),
          iconBtn('→', 'Move right', () => shift(index + 1), index === pics.length - 1),
          iconBtn('✕', 'Remove picture', () => { pics.splice(index, 1); openPicture = null; rerenderTab(); }))) : null);
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

  // Where a video comes from: a YouTube link, an uploaded file or a direct link (a project's video, or a
  // Video section). Returns the source picker and the field for the chosen source.
  function videoSource(clip, name, folder = 'work') {
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
          const path = stageFile(file, `assets/${folder}/${slug(name)}-${Date.now().toString(36)}${extension(file)}`);
          if (path) { clip.video = path; rerenderTab(); }
        }),
        h('span', { class: 'adm-hint', text: `Up to ${MAX_BYTES / MB} MB. Bigger videos belong on YouTube, or on your own storage/CDN using "Direct video URL".` }),
        videoWeight(clip.video));
    } else {
      source = field('Direct video URL', h('input', {
        type: 'url',
        value: clip.video || '',
        placeholder: 'https://your-storage.example.com/videos/clip.mp4',
        oninput: (e) => { clip.video = e.target.value.trim(); changed(); },
      }), 'A direct link to the video file itself (ending in .mp4 or similar), hosted on your own storage or CDN. Nothing is uploaded through this panel for this option; make sure the file is already live at that URL.');
      source.appendChild(videoWeight(clip.video));
    }
    return { modeSelect: field('Source', modeSelect), source };
  }

  // ---------- How heavy a video is ----------
  // Its picture size and length, and when they can be read, its size and how much it streams per second.
  // An upload's size is known; a linked file's only when its storage lets this site ask (CORS). Above
  // WEB_MBPS it's heavier than a website needs: a 1080p web copy is about 4-6 Mbit/s and looks the same.
  const WEB_MBPS = 8;
  const videoFacts = new Map(); // address -> the job finding them out

  function factsOf(src) {
    if (!videoFacts.has(src)) {
      const file = state.pending.get(src);
      const url = window.SITE_ASSET_OVERRIDES[src] || src;
      videoFacts.set(src, (async () => {
        const meta = await new Promise((resolve) => {
          const video = document.createElement('video');
          const done = (value) => { resolve(value); video.removeAttribute('src'); video.load(); };
          video.preload = 'metadata';
          video.muted = true;
          video.onloadedmetadata = () => done({ width: video.videoWidth, height: video.videoHeight, seconds: video.duration });
          video.onerror = () => done(null);
          setTimeout(() => done(null), 20000);
          video.src = url;
        });
        let bytes = file ? file.size : null;
        if (!file && /^https?:/i.test(src)) {
          try {
            const answer = await fetch(src, { method: 'HEAD' });
            bytes = Number(answer.headers.get('content-length')) || null;
          } catch { /* the storage doesn't allow it */ }
        }
        return { meta, bytes };
      })());
    }
    return videoFacts.get(src);
  }

  function videoWeight(src) {
    const box = h('div', { class: 'adm-video-weight' });
    if (!src) return box;
    const notes = [];
    // Cloudflare's r2.dev addresses are for trying a bucket out: slowed down when a site gets visitors
    let host = '';
    try { host = new URL(src).hostname; } catch { /* a path in the repository */ }
    if (/\.r2\.dev$/i.test(host)) {
      notes.push('This is an r2.dev address: Cloudflare\u2019s test address for a bucket. It\u2019s rate-limited and not meant for a live site. In Cloudflare: R2 \u2192 your bucket \u2192 Settings \u2192 Custom Domains, connect a domain, then use that address here.');
    }
    box.appendChild(h('span', { class: 'adm-hint', text: 'Checking the video\u2026' }));
    factsOf(src).then(({ meta, bytes }) => {
      box.innerHTML = '';
      const time = (secs) => `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}`;
      const facts = [];
      if (meta && meta.width) facts.push(`${meta.width}\u00D7${meta.height}`);
      if (meta && Number.isFinite(meta.seconds)) facts.push(time(meta.seconds));
      if (bytes) facts.push(formatSize(bytes));
      const mbps = bytes && meta && meta.seconds ? (bytes * 8) / meta.seconds / 1e6 : null;
      if (mbps) facts.push(`${mbps.toFixed(1)} Mbit/s`);
      box.appendChild(h('span', { class: 'adm-hint', text: meta ? facts.join(' \u00B7 ') : 'The video couldn\u2019t be opened from here. Check that the link plays in a new tab.' }));
      if (mbps && mbps > WEB_MBPS) {
        const web = (5e6 * meta.seconds) / 8;
        box.appendChild(h('p', { class: 'adm-video-warn', text: `Heavy for a website: visitors stream ${mbps.toFixed(0)} Mbit/s, which stutters on phones and slow Wi-Fi. A web copy at about 5 Mbit/s would be around ${formatSize(web)} and look the same on screen. In HandBrake: preset \u201CFast 1080p30\u201D; in Premiere: H.264, \u201CMatch Source \u2013 Adaptive Medium Bitrate\u201D.` }));
      } else if (!bytes && meta && /^https?:/i.test(src)) {
        box.appendChild(h('span', { class: 'adm-hint', text: 'Its file size can\u2019t be read from here (the storage doesn\u2019t allow it), so the panel can\u2019t tell how heavy it is. Allowing this site in the bucket\u2019s CORS settings lets it check.' }));
      }
      notes.forEach((note) => box.appendChild(h('p', { class: 'adm-video-warn', text: note })));
    });
    return box;
  }

  // A smaller copy for the top-section monitor, which plays small and muted: 720p at about 1.5 Mbit/s,
  // without sound, is plenty there. The project's pop-up keeps playing the video itself.
  function previewField(clip, name) {
    return h('div', { class: 'adm-field' },
      h('span', { class: 'adm-label', text: 'Lighter copy for the top-section monitor (optional)' }),
      h('input', {
        type: 'url',
        value: clip.preview && /^https?:/i.test(clip.preview) ? clip.preview : '',
        placeholder: 'https://\u2026/clip-small.mp4',
        oninput: (e) => { clip.preview = e.target.value.trim(); changed(); },
        onchange: () => rerenderTab(),
      }),
      h('div', { class: 'adm-inline' },
        clip.preview && !/^https?:/i.test(clip.preview) ? currentFile(clip.preview) : null,
        clip.preview ? h('button', { class: 'adm-link', type: 'button', text: 'Remove', onclick: () => { clip.preview = ''; rerenderTab(); } }) : null,
        filePicker('video/*', (file) => {
          const path = stageFile(file, `assets/work/${slug(name)}-small-${Date.now().toString(36)}${extension(file)}`);
          if (path) { clip.preview = path; rerenderTab(); }
        })),
      h('span', { class: 'adm-hint', text: 'The monitor plays this instead of the full video, so the top section loads quickly. Export about 720p at 1.5 Mbit/s with no sound (HandBrake: preset \u201CFast 720p30\u201D, audio track removed); a link or an upload.' }),
      clip.preview ? videoWeight(clip.preview) : null);
  }

  function videoForm(item, clip, i) {
    const { modeSelect, source } = videoSource(clip, clip.title || item.title);
    return h('div', { class: 'adm-form' },
      check(clip, 'hideInMonitor', 'Hide from the top-section monitor and timeline'),
      h('div', { class: 'adm-row2' },
        field('Video title', text(clip, 'title', { placeholder: i === 0 ? 'Optional, e.g. a name' : `Video ${i + 1}` })),
        modeSelect),
      source,
      clip.video && !clip.youtube ? previewField(clip, clip.title || item.title) : null,
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
      h('input', { type: 'checkbox', checked: Boolean(obj[key]), onchange: (e) => { obj[key] = e.target.checked; changed(); recordHistory(); } }),
      h('span', { text: label }));
  }

  // `live`: restyles the page while dragging (instead of redrawing it), which then happens once it's let go
  function slider(obj, key, label, min, max, step, unit, hint, live) {
    const shown = h('span', { class: 'adm-value', text: `${obj[key]}${unit}` });
    return h('label', { class: 'adm-field' },
      h('span', { class: 'adm-label' }, label, ' ', shown),
      h('input', {
        type: 'range', min, max, step, value: obj[key],
        oninput: (e) => {
          obj[key] = Number(e.target.value);
          shown.textContent = `${obj[key]}${unit}`;
          if (live) { live(); scheduleHistory(); } else changed();
        },
        onchange: live ? () => changed() : null,
      }),
      hint ? h('span', { class: 'adm-hint', text: hint }) : null);
  }

  function choice(obj, key, label, options, hint) {
    return field(label, h('select', {
      onchange: (e) => {
        const raw = e.target.value;
        obj[key] = typeof options[0][0] === 'number' ? Number(raw) : raw;
        changed();
        recordHistory();
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
          field('Line under your name', formattable(text(c.hero, 'role'))),
          field('Intro paragraph', formattable(area(c.hero, 'intro', 3))),
          field('Location and availability', formattable(text(c.hero, 'availability'))))),
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
        c.hero.backgroundVideo ? videoWeight(c.hero.backgroundVideo) : null,
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
          h('div', { class: 'adm-row2' }, field('Dates', text(entry, 'date', { placeholder: '2024 – Present' })), field('Role', formattable(text(entry, 'role')))),
          field('Company or project', text(entry, 'org')),
          field('What you did', formattable(area(entry, 'text', 3)))))));
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

  // How the contact form sends (see "Contact form" in js/main.js)
  const FORM_SERVICES = {
    '': ['Opens the visitor’s email app (nothing to set up)', '', ''],
    web3forms: ['Web3Forms: sent from the page (free, 250 a month)', 'Access key',
      'On web3forms.com, type the email address messages should go to: the key arrives in that inbox. No account needed.'],
    formspree: ['Formspree: sent from the page (free, 50 a month)', 'Form ID',
      'On formspree.io, make a form: its address ends in /f/ and then the ID, e.g. xyzabcde.'],
  };

  function contactFormBox() {
    const form = state.draft.contactForm;
    const [, keyLabel, keyHint] = FORM_SERVICES[form.service] || FORM_SERVICES[''];
    const result = h('span', { class: 'adm-hint' });
    const test = h('button', {
      class: 'adm-btn',
      type: 'button',
      text: 'Send a test message',
      onclick: async () => {
        test.disabled = true;
        result.className = 'adm-hint';
        result.textContent = 'Sending…';
        try {
          await window.SiteContact.send({ name: 'Your site’s admin panel', email: state.draft.links.email || 'test@example.com', subject: 'Test message', message: 'This is a test from your portfolio’s admin panel. The contact form works.' }, form);
          result.className = 'adm-status is-ok';
          result.textContent = 'Sent. Check the inbox it goes to (and its spam folder, the first time).';
        } catch (error) {
          result.className = 'adm-error';
          result.textContent = `Not sent: ${error.message || 'the service didn’t accept it'}. Check the ${keyLabel.toLowerCase()}.`;
        }
        test.disabled = false;
      },
    });
    return h('div', { class: 'adm-form adm-group-box', 'data-adm-section': 'contact-form' },
      h('h3', { class: 'adm-group', text: 'Contact form' }),
      field('How messages are sent', h('select', { onchange: (e) => { form.service = e.target.value; rerenderTab(); } },
        Object.entries(FORM_SERVICES).map(([value, [label]]) => h('option', { value, text: label, selected: form.service === value })))),
      form.service ? [
        field(keyLabel, text(form, 'key', { placeholder: form.service === 'formspree' ? 'xyzabcde' : 'e.g. 1a2b3c4d-…', onchange: () => rerenderTab() }), keyHint),
        form.key.trim() ? h('div', { class: 'adm-inline' }, test, result) : null,
        h('p', { class: 'adm-hint', text: 'If sending ever fails, visitors are offered to send it by email instead, so no message is lost. The key is meant to be public: it only lets people send you messages.' }),
      ] : null);
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
      contactFormBox(),
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

  // After an update, index.html loads the code as css/style.css?v=<version>, js/main.js?v=<version>…,
  // so browsers fetch the new code instead of reusing old copies (main.js passes the same version on
  // to the admin panel's own files)
  function stampCodeFiles(html, version) {
    const stamp = version ? `?v=${encodeURIComponent(version)}` : '';
    return html.replace(/((?:src|href)=")((?:css|js)\/[\w-]+\.(?:css|js))(?:\?v=[^"]*)?(")/g, (match, before, path, after) => before + path + stamp + after);
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
    const raw = site.name.trim();
    const name = window.SiteText.plain(raw);
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
        item.videos.forEach((clip) => {
          delete clip._mode;
          if (!clip.preview) delete clip.preview;
        });
        item.links = item.links.filter((l) => l.label && l.url);
        if (!item.draft) delete item.draft;
        if (!item.slug) delete item.slug;
      });
      content.customSections.forEach((sec) => {
        delete sec._mode;
        if (sec.buttons) sec.buttons = sec.buttons.filter((b) => b.label && b.url);
        if (sec.images) sec.images = sec.images.filter((img) => img.src);
        if (sec.items) sec.items = sec.items.filter((item) => Object.entries(item).some(([key, value]) => key !== 'i18n' && typeof value === 'string' && value));
      });
      content.customLinks = content.customLinks.filter((l) => l.url);

      // When it was saved: the page compares this with the copy this browser keeps (see main.js)
      content.savedAt = new Date().toISOString();

      // Everything goes in one commit (uploads, content, index.html), so the host publishes once
      if (shrinking.size) {
        updateStatus('Making pictures smaller…');
        await Promise.all(shrinking.values());
      }
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
    stopEditing();
    renderPage(state.draft);
    if (state.token && screen.querySelector('.adm-editor')) showEditor();
  });

  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault();
  });

  window.SiteAdmin = { toggle };
})();
