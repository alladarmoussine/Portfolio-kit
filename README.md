# Portfolio Site

A one-page portfolio for video, audio, and code work. Plain HTML, CSS, and
JavaScript: no build step, no dependencies. Open `index.html` in a browser to view it.

The site doubles as a template: the name, colours, fonts, work categories, section titles and
order, top-section style and links are all settings in the admin panel, so someone else can make
it theirs without touching code. See [Making a copy for someone else](#making-a-copy-for-someone-else).

## Files

| File | What it holds |
|---|---|
| `index.html` | Page layout. Its `<head>` (title, descriptions, favicon, fonts, theme colours) and the name in the body are rewritten by the admin panel on save |
| `content/site.js` | Editable content: site details, theme, categories, sections, work cards, showreel, About bio and skills, experience, toolkit, links, resume and photo paths. The admin panel rewrites this file |
| `starter/site.js` | A blank version of `content/site.js` for starting someone else's copy |
| `css/style.css` | All styling (colours are variables at the top, in `:root`; the Theme tab overrides them) |
| `js/main.js` | Builds the page from `content/site.js`: theme, name, section order and titles, work categories and filter, links, top-section styles, admin shortcut, mobile menu, project pop-up, contact form, showreel embed, top-section background and timeline, heading animation, mouse effect, About photo reveal |
| `assets/profile.jpg` | Photo in the About section |
| `assets/resume.pdf` | File the Resume button downloads (**placeholder**) |
| `js/i18n.js` | Fixed interface text (menu, buttons, form labels) in English, Dutch and French |
| `js/admin.js`, `css/admin.css` | The hidden admin panel (only loaded when you press the shortcut) |

## Page layout

1. **Top section** (`.hero`): fills the first screen. In the default "editing workspace" style
   it is laid out like an editing program: name, role, intro, availability line, two buttons and
   a Resume link on the left, a preview monitor on the right, and an editing timeline across the
   bottom. The "portrait" style puts a picture beside the name instead, and "centred" puts the
   text in the middle. Sizes and spacing scale with the screen height so it fits on laptop
   screens. Its bottom fades into the first section below.
2. **About** (`#about`): bio and skill tags on the left, photo on the right.
   On phones the photo sits above the text.
3. **Showreel** (`#reel`): embedded YouTube video.
4. **Work & Experience** (`#work`): highlights slider and filterable project grid.
5. **Experience** (`#experience`) and **Toolkit** (`#toolkit`): the timeline and the tools list,
   with small titles so they read as part of Work.
6. **Contact** (`#contact`): message form, email, LinkedIn and social icons.

All sections below the top section can be reordered, renamed, restyled, hidden or removed in the
admin panel's **Page** tab, which can also add Text sections and more Work grids.

## Admin panel

The easiest way to add videos and change content. There is no login button or admin
page: on the live site (or locally), press **Ctrl + Alt + Shift + A** and the panel slides
in over the page. Press it again or click × to close it.

### First time on each computer
1. Create a [fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new):
   - Repository access: **Only select repositories** → this repository
   - Permissions: **Contents → Read and write**
   - Pick an expiry date you're happy with (you'll redo this setup when it expires)
2. Open the panel, paste the token, check the owner/repo/branch, and choose a password
   (10+ characters). Owner and repository are filled in from the Site tab (or guessed from a
   `github.io` address).

**Setup wizard:** on a fresh copy (the name is still empty or "Your Name"), unlocking the panel
opens seven short steps: name and intro, a look, the top-section style, the kinds of work (which
become the categories), contact details and languages. The page behind shows the result as you
go; nothing is published until Save & publish. Each step can be skipped, and the Site tab has
**Run setup again**.

The token is encrypted with your password (PBKDF2-SHA256 with 600,000 rounds, then
AES-256-GCM, using the browser's built-in Web Crypto) and only the encrypted version is
kept in that browser. Your password is never stored anywhere. Do this once on your PC and
once on your laptop; after that, the password alone unlocks the panel. If you clear the
browser's site data, just set it up again.

### Using it
- **Tabs:** **Page** (everything on the page), **Site** (who it belongs to and where it links to)
  and **Theme** (colours, fonts, corners).
- **Page:** the page as an outline, from the top section to the footer. Click a row to edit
  that section right there; the page behind scrolls to it. Drag ⠿ (or use the arrows) to change
  the order, and use the eye to show or hide a section. Every section's editor starts with the
  same settings: title, menu label, "show in the menu", background, and title style and size
  (*large* with a dot, or *small* with an accent line). A small-titled section on the same
  background as the one above sits right under it as part of it: that's how Experience and
  Toolkit follow Work. Below that come the section's own content and ticks for its parts
  (e.g. the About photo, or the contact form).
- **Adding sections:** **+ Add section** adds a **Text** section (title, text, picture below or
  beside it, a button) or a **Work grid**. Each Work section shows the projects from the
  categories ticked under "Projects shown here" (nothing ticked: all of them), with its own intro,
  highlights slider and filter buttons; projects are edited inside the Work section they show up
  in. Built-in sections (About, Showreel, Work, Experience, Toolkit, Contact) can be taken off
  with **Remove from the page**; their content is kept and **+ Add section** puts them back.
- **Site:** your name, page title and description, the link preview picture and site address, the browser-tab icon (letters in your theme
  colours, or upload your own square PNG, SVG or .ico), the languages, the GitHub repository, your
  email and social links (and which ones are in the footer), and analytics.
- **Theme:** six presets (four dark, two light) as a starting point, then any colour can be
  changed: backgrounds, cards, borders, text, the two accent colours, text on buttons, and the
  top section's background and text. "Light or dark" swaps the backgrounds and text colours and
  keeps the accents. The top section stays dark on light themes so its text reads on photos and
  video. **Your colour schemes** keeps colour combinations to switch back to: name the current
  colours and press **Save current colours**; click a saved scheme to use it again (stored as
  `theme.saved`, so they're there on every computer). Also the text and heading fonts and corner
  roundness. Fonts come from a Google Fonts list,
  or upload your own font files (.woff2, .woff, .ttf, .otf; saved in `assets/fonts/`): files with
  the same name form one family, each with its weight and style (stored as `theme.customFonts`).
- **Removing things:** the eye hides a whole section, and the ticks in a section's editor hide its
  parts. Nothing is deleted; show it again to bring it back. Menu links pointing to a hidden
  section are hidden too. Stored as `hidden` in `content/site.js`. When editing on the page,
  **Hide** takes that part off and **Delete** removes a project, experience entry or toolkit row.
  An emptied text disappears from the page instead of leaving a gap.
- **Videos:** paste a YouTube link (recommended), upload a video file (up to 50 MB), or
  paste a direct URL to a video hosted on your own storage/CDN for anything bigger or
  that can't go on YouTube (see "Video file size" under Work cards below). YouTube
  cards use YouTube's own thumbnail unless you upload one.
- **Edit on the page:** while the panel is open, hovering an item shows a ✎ button. Press
  it to unlock that item's text and type on the page: the top section, the section intro
  lines, work card titles and teasers, the About bio and skills, experience entries and
  toolkit rows. **Done**, Enter, Esc or clicking elsewhere locks it again; **More…** opens
  all its options in the panel (videos, thumbnails, descriptions, buttons). On the
  showreel, the photo and the social/email links, ✎ goes straight to the panel.
- **Phone preview (📱):** shows the page at phone width in a frame beside the panel, with your
  unsaved changes, following every edit. Opening a section in the Page tab scrolls it there too.
- **Detach (⧉) and full screen (⤢):** the buttons next to – turn the panel into a window you
  can drag by its title bar and resize from its bottom-right corner, or spread it over the whole
  page. Press the same button again to dock it back on the right. Each browser remembers its own
  choice and the window's size and position.
- **Minimise (–):** slides the panel off to the right and leaves an **Admin** tab on the
  edge (with an orange dot if there are unsaved changes). Click the tab, a ✎, or the
  shortcut to bring it back.
- **After saving:** each save is one commit (uploads, content and `index.html` together), and
  `index.html` loads the content as `content/site.js?v=<save time>`, so browsers fetch the new
  version instead of reusing an old copy. The host still needs a minute or two to publish; until
  then, the browser that saved shows its latest save after a reload, with a small note in the
  corner. If the note says the live site still hasn't caught up after 10 minutes, check that
  GitHub Pages is publishing (the repository's Actions tab, or Settings → Pages). Visitors always
  see the published version.
- Edits show on the page behind the panel straight away as a preview. Nothing goes live
  until you click **Save & publish**, which commits the changes (and any uploaded files)
  to GitHub. The host then redeploys, usually within a minute or two.
- The panel re-checks GitHub when you open it, so changes saved on one computer show up
  on the other. If both saved in between, it asks before overwriting.
- It locks itself after 30 minutes idle, and closing it forgets the token until you
  enter the password again. **Forget this device** (on the password screen) deletes the
  encrypted token from that browser.

**Security notes:** anyone can read the site's JavaScript, but that doesn't matter: what
actually allows changes is your GitHub token, which only exists encrypted in your own
browsers. If a computer is lost, revoke the token on GitHub
(Settings → Developer settings → Personal access tokens).

**Keep your local copy in sync:** saves from the panel are commits on GitHub, so run
`git pull` before editing files by hand.

**Changing the shortcut:** edit `isAdminShortcut` near the end of the content section of
`js/main.js`.

## Updating content by hand

Everything below can also be done in the admin panel. To edit by hand, change
`content/site.js` (it must stay valid JSON after the `=`).


### Top section
Everything here is in the **Top section** row of the admin panel's Page tab, with a live preview:

- **Style:** `hero.layout.style` is `editor` (preview monitor and timeline), `portrait` (a
  picture beside the name: `hero.portrait`, else the About photo) or `centered`.
- **Text:** the role line, intro and availability (`hero.role`, `hero.intro`, `hero.availability`).
  Your name is `site.name` (Site tab).
- **Layout:** name on one or two lines and its size; show or hide the role line, intro,
  availability line, each button and the Resume link.
- **Preview monitor:** on/off, size, the label above the picture, whether clips start at a random
  point or the beginning, and the clip order. A single video can be left out with "Hide from the
  top-section monitor" on that video in its Work section (`hideInMonitor`).
- **Timeline:** on/off, loop length, timecode frame rate, extra tracks (V2/A2), track names,
  timecode, and whether visitors can scrub.
- **Background:** photo, video, how much they are darkened, and the soft blue glow.

The settings are stored as `hero.layout` in `content/site.js`; anything missing falls back to
`HERO_DEFAULTS` in `js/main.js`. **Reset top section settings to defaults** in the tab puts
them all back (text, photo and video stay).

The one-line intros under Showreel, Work and Contact are `intros`.

The background can also be set by hand as `hero.background` (a photo) and
`hero.backgroundVideo` (a direct link to a short MP4, e.g. a loop of your showreel) in
`content/site.js`. The video plays muted on a loop, with the photo shown while it loads and for
visitors who turn off motion. With both empty, a plain dark background shows. A landscape
photo at least 1920 px wide works best; its left side is darkened so the text stays readable.

### About
- **Bio and skills:** `about.paragraphs` and `about.skills` in `content/site.js`.
- **Photo:** `about.photo` is the image path. To adjust the crop, change `object-position`
  on `.about-photo img` in `css/style.css`.

### Showreel
Put your video's YouTube ID in `reel.youtube`:

```js
"reel": { "youtube": "dQw4w9WgXcQ" },
```

The ID is the part after `v=` in the video's URL. With it empty, a "Showreel coming soon"
placeholder shows.

### Work projects
Each entry in `work` is one project, shown as a card in the grid in content order. Projects marked
`featured` also get a slide in the **Highlights** slider above the grid (one big slide at a time,
with arrows, dots and swipe; a muted preview of the first video plays while hovering). It moves on
its own unless turned off: `highlights.autoplay` and `highlights.seconds` (any Work section in the admin
panel). It pauses while hovered, after a visitor touches it, while a pop-up is open and when off
screen, and never moves for visitors who reduce motion.

- `type`: the `id` of one of the `categories` (drives the filter buttons)
- `title` and `teaser`: the title and one-line teaser shown on the card
- `client`, `year`, `role`: shown as "Client · Year" on the card and "Client · Year · Role"
  in the pop-up; leave any of them empty to hide it
- `featured`: `true` also puts the project in the Highlights slider (and first in the top-section monitor)
- `desc`: the full write-up shown in the pop-up
- `tools`: list shown in the pop-up
- `thumb` / `thumbAlt`: the cover image on the card and its description
- `videos`: the project's videos, each `{ "title", "video", "youtube", "thumb" }`. `youtube` is a
  YouTube video ID; `video` is a path to a video file OR a full `https://` URL to one hosted
  elsewhere. The pop-up plays the first; with more than one, thumbnails under the player
  (labelled with each `title`) switch between them
- `images`: the project's pictures, each `{ "src", "alt" }`, shown in the pop-up after the videos,
  with arrows, arrow keys and thumbnails. The first picture is the card's cover when there's no
  `thumb` and no video thumbnail. In the admin panel they're a row of small thumbnails under the
  videos: **+ Add pictures** takes several files at once, and clicking one shows its description,
  ← → to reorder and ✕ to remove
- `links`: up to two pop-up buttons, each `{ "label": "...", "url": "..." }`

Project files live in `assets/work/`.

**Video file size:** GitHub warns about files over 50 MB and rejects files over 100 MB, and large files load slowly for
visitors. For most videos, upload them to YouTube and use `youtube` instead, or compress
them first (a 1080p, 1-minute video can usually get under 20 MB).

**If you can't use YouTube** (for example the footage isn't yours to put on a public
video platform, only to show on your own site), host the file yourself on object
storage/a CDN instead of committing it to this repo, then pick **Direct video URL** in
the admin panel's video field (or set `video` to the full URL by hand) and paste the
link to the file. A solid free-tier option for a personal site: a
[Cloudflare R2](https://developers.cloudflare.com/r2/) bucket with public access
turned on, served from your own domain or an `r2.dev` subdomain. It's plain storage
(not a sharing platform), has no egress fees, and supports the byte-range requests
browsers need to let viewers scrub/seek in the video. Backblaze B2, Bunny.net Storage,
or S3 + CloudFront work the same way if you already use one of those.

### Sections
`sections` in `content/site.js` holds the page outline: `order` (section ids, top to bottom),
`removed` (built-in sections taken off the page) and, per section id, `title`, `nav` (menu label),
`inMenu`, `background` (`main` or `alt`), `titleStyle` (`large` or `small`), `titleSize` (percent)
and, for Work sections, `categories` (empty = all). Extra Work grids are listed in `workGrids`
(`{ "id", "intro" }`) and Text sections in `customSections` (`{ "id", "text", "image", "imageAlt",
"imagePlace", "button": { "label", "url" } }`). Anything missing falls back to `SECTION_LOOK` in
`js/main.js`.

### Categories
`categories` lists the work categories, each `{ "id", "label", "icon", "color" }` (a Work section →
Categories in the admin panel). A category gets a filter button once a project uses it; with
fewer than two in use, the filter bar is left out. `icon` (play, music, code, camera, film, mic,
pen, palette, image, book, cube, shirt, heart, star) and `color` show on cards without a cover
image; an empty `color` picks one from the theme. Content without `categories` uses Video, Audio
and Code.

### Experience
Each entry in `experience` is one role: `date`, `role`, `org`, and `text` (one line about
what you did).

### Toolkit
One row per discipline in `toolkit` (`label` and `tools`). Software only; put your strongest
tool first in each row.

### Social links
The addresses are `links` in `content/site.js` (also in the Site tab): `email`, plus one
per platform (Instagram, LinkedIn, YouTube, GitHub, Facebook, TikTok, X, Threads, Bluesky,
Behance, Dribbble, ArtStation, Pinterest, Vimeo, Twitch, Spotify, SoundCloud, Bandcamp, Etsy,
Patreon, Substack). Every platform with an address gets an icon in the contact section (LinkedIn
gets its own button instead); an empty value hides it. `footerLinks` lists the platforms also
shown in the footer, in order. `customLinks` holds anything else, each `{ "label", "url",
"footer" }`, shown with a globe icon. The first five platforms' icons are built in; the others
come from [Simple Icons](https://simpleicons.org) on jsDelivr.

### Resume
Replace `assets/resume.pdf` with your real resume (or upload it in the Top section row of the admin panel).

## Languages

The language switch in the header changes the language without reloading. The choice is
remembered in that browser and shows in the address (`?lang=nl`), so you can send someone a
link in another language. On a first visit the site follows the browser's language when it's
one you offer; otherwise it shows the main language.

- **Choosing languages** (admin panel, Site tab → Languages): the **main language** is the one
  you write your content in. Below it are the languages visitors can pick, in switch order:
  remove one with ✕ (its translations are kept), add one from the list, reorder with the
  arrows. With a single language the switch is left out. Stored as `languages` in
  `content/site.js` (`main`, `available`). Right-to-left languages aren't supported.
- **Page content** (top section, intros, bio, skills, work cards, experience, toolkit labels):
  each item in `content/site.js` can carry an `"i18n": { "nl": {...}, "fr": {...} }` block with
  the same text keys as the main language. Anything not translated, or left empty, shows the
  main language.
- **In the admin panel**, pick the language under **Editing language** (or use the header
  switch). Text you type, on the page or in the forms, is then saved as that translation, with
  the main language shown as a grey hint. Videos, images, links, tools and the order of items are
  shared by all languages, so add, remove and reorder items in any language.
- **Fixed interface text** (menu, buttons, form labels, "Watch video"…) comes with English, Dutch
  and French in `js/i18n.js`. Click a language in Site tab → Languages to change any of it or, for
  an added language, translate it (stored as `languages.ui`). Untranslated text shows in the main
  language.

## Analytics

The site uses [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/): free, no
cookies, so no consent banner is needed. In Cloudflare, open **Web Analytics → Add a site**, enter
the site's address, and copy the `token` value from the snippet it shows. Paste it in the admin
panel (Site tab → Analytics) and save. It only runs on the live `https://` site, so your
own local testing isn't counted. Empty the field to turn it off.

## Contact form

The form doesn't send anything itself. When a visitor clicks **Send message**, it opens
their email app (Outlook, Apple Mail, Gmail app, and so on) with a new email to you,
already filled in with their subject and message. They still have to press send there.

The destination address is `links.email` in `content/site.js` (Site tab), which also
fills the email link under the form.

**Limitation:** visitors who only use webmail in a browser and have no email app set up
will find that nothing happens. To fix that, connect the form to a free form service
such as [Formspree](https://formspree.io): it gives you a URL, the form posts to it, and
the message arrives in your inbox without the visitor needing an email app. Point the
`<form>`'s `action` at the Formspree URL, set `method="POST"`, and remove the submit
handler in `js/main.js`.

## Visual effects

All effects are in `js/main.js`, and all respect the visitor's "reduce motion" setting.

- **Heading animation:** elements with the `reveal` class animate in letter by letter
  when scrolled into view.
- **Mouse effect** (Theme tab, stored as `theme.cursor`): **Off** (the normal pointer), **Dot**
  (size, colour: inverted / main accent / second accent, grow over links), **Label** (the dot
  becomes a circle saying "View", or "Play" for projects with videos; the words are interface
  text, so they're translated), **Spotlight** (the normal pointer with a soft accent glow following
  it; size, strength, colour) or **Your own pointer** (an uploaded PNG/SVG, any size, centred or
  pointing with its top-left corner). **Magnetic buttons** can be added to any of them. Only on
  mouse or trackpad devices; touch devices and visitors who reduce motion keep the normal pointer.
- **Editing timeline and preview monitor:** the strip at the bottom of the top section
  (`#hero-timeline`). Its V1 track has one clip per uploaded video in Work (featured projects
  first; YouTube videos are left out). A playhead sweeps across in real time with a running
  timecode; when it enters a clip, the monitor (`#hero-monitor`) cuts to that video, muted, at a
  random point. The next clip loads in a second player before the cut. It pauses when the top
  section is off screen or a project pop-up is open, and shows still thumbnails for visitors
  who reduce motion or have data saving on. The other tracks are decoration (`TIMELINE_DECOR`).
- **About photo reveal:** the photo fades and slides in when About comes into view.

## Colours and fonts

Set them in the admin panel's **Theme** tab (stored as `theme` in `content/site.js`). They fill
the CSS variables at the top of `css/style.css`: backgrounds (`--bg`, `--bg-alt`), the main accent
(`--accent`), the second accent (`--accent-orange`, orange in the default theme) and so on. The
default font is [Geologica](https://fonts.google.com/specimen/Geologica). On save, the panel also
writes the colours and the font link into `index.html`'s `<head>`, so the page shows the right
theme from the first paint. The presets and font list are `THEME_PRESETS` and `THEME_FONTS` in
`js/main.js`.

## Link previews

When the site's link is shared (WhatsApp, LinkedIn, Facebook…), the preview shows the page title,
the description and a picture. All three are set in the admin panel's Site tab, which shows a
mock-up of the preview. Upload a landscape picture of 1200 × 630 pixels (`site.shareImage`).
Previews need the full address of the picture, so the panel combines it with the **Site address**
(`site.url`; empty uses the address the panel is open on). On save, the panel writes the
`og:image`, `og:url` and `twitter:image` tags into `index.html`.

## Hosting

The admin panel saves by committing to GitHub, so use a host that deploys straight from
this repository. All of these are free:

1. **GitHub Pages (recommended):** no extra account needed. In the repository settings,
   open **Pages** and set the source to the `main` branch, root folder. The site goes live
   at `https://<username>.github.io/<repository-name>/` and rebuilds after every save.
   Custom domains are supported.
2. **Netlify:** sign in with GitHub, "Import from Git", pick this repository, leave the
   build command empty and the publish directory as the root. Redeploys on every save.
3. **Cloudflare Pages:** same idea as Netlify and very fast, but each file must be under
   25 MB, so bigger videos need to go on YouTube or your own storage.

Whichever you choose, use the `https://` address: the admin panel's encryption needs a
secure page (it also works when opening `index.html` locally).

## portfolio-kit and updates

The code of this site is also published as [portfolio-kit](https://github.com/alladarmoussine/portfolio-kit):
the same site without anyone's content, ready to be copied. Sites made from it can install new
versions from their admin panel.

**How it's published.** The site's own repository is the source. Whenever code changes on `main`
(`index.html`, `css/`, `js/`, `starter/`, `README.md`, `kit.json`), the GitHub Action
`.github/workflows/publish-kit.yml` runs `tools/publish_kit.py`, which:

- copies only the files listed in `kit.json` (`files`) into portfolio-kit: no content, no `assets/`
- uses `starter/site.js` as the kit's `content/site.js`
- resets `index.html`'s title, descriptions, icon, theme and name to neutral values
- gives the kit a new version number with the commit message as its change note (in the kit's `kit.json`)
- stops with an error if the site owner's name would end up in the kit

Setting it up (once, on the source repository): create a fine-grained token with **Contents: Read
and write** on portfolio-kit only, and add it as an Actions secret named `KIT_TOKEN`
(Settings → Secrets and variables → Actions). The Action can also be run by hand from the Actions
tab (**Run workflow**).

**How a site updates.** Site tab → **Updates** → **Check for updates** compares the site's
`kit.json` with portfolio-kit's and lists what changed. **Update** copies the code files from the
kit into the site's repository in one commit; the site's content, uploads, translations and
settings stay as they are, and `index.html` gets the site's own title, icon and theme written back
in. Reading the kit needs no extra permission (it's public), and the site's own token is enough
to install. On the source site itself, the box says that it publishes the kit instead.

When adding a new code file, add it to `files` in `kit.json` so it's published and installed too.

## Making a copy for someone else

Nobody needs to edit files. The easiest start is [portfolio-kit](https://github.com/alladarmoussine/portfolio-kit),
which has no one's content in it. Copying this site's repository works too: the admin panel
notices when it's running on a copy of someone's site.

1. Copy portfolio-kit (or this repository) on GitHub, any way you like: fork it, use it as a
   template, or push a clone or download to a new repository.
2. Turn on GitHub Pages for the copy (see [Hosting](#hosting)) and open its live `https://`
   address.
3. Press **Ctrl + Alt + Shift + A** and set up the admin panel with a token for the *new*
   repository (see [First time on each computer](#first-time-on-each-computer)). On a
   `github.io` address, owner and repository are filled in from the address.
4. When copied from a site (not the kit), the panel sees that the content belongs to another
   repository (`site.repo`) and offers
   **Start with an empty site**: the design and features stay, the text, projects and pictures are
   replaced by the empty content in `starter/site.js`. (**Keep this content** edits the copy as it
   is.) Either way, the site is then registered to the new repository.
5. The setup wizard follows: name, look, top section, kinds of work, contact, languages. Then
   fill in the rest of the **Site** tab (link preview picture, more links) and go down the
   **Page** outline. Save & publish. The first save also puts the new name and theme into
   `index.html`.
6. After starting fresh from a copied site, right after the first save, the panel lists the files the new site doesn't use (the previous
   owner's videos, photos and resume) with their sizes. Untick any to keep, and **Delete selected**
   removes the rest in one commit. The same check is in the Site tab as **Find unused files**.

The starter hides the Showreel section (click its eye in the Page tab to bring it back) and uses
the centred top-section style, since the editing workspace needs uploaded videos.
