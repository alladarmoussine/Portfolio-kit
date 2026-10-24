// Fixed interface text (menu, buttons, form labels) in each language.
// Page content (bio, work cards, experience…) is translated in content/site.js instead, through the admin panel.
// index.html marks each spot with data-i18n="key" (text), data-i18n-label (aria-label) or data-i18n-alt (alt).
// {name} is replaced with the name from the admin panel's Site tab, {first} with the short name.
// Section titles and menu labels can also be replaced per site in the admin panel (Page tab).
window.SITE_LANGUAGES = { en: 'English', nl: 'Nederlands', fr: 'Français' };

window.SITE_UI_TEXT = {
  'meta.description': {
    en: "{name}'s portfolio.",
    nl: 'Portfolio van {name}.',
    fr: 'Portfolio de {name}.',
    ro: 'Portofoliu – {name}.',
  },
  'lang.label': { en: 'Language', nl: 'Taal', fr: 'Langue', ro: 'Limbă' },
  'nav.toggle': { en: 'Toggle navigation', nl: 'Menu openen of sluiten', fr: 'Ouvrir ou fermer le menu', ro: 'Deschide sau închide meniul' },
  'nav.about': { en: 'About', nl: 'Over mij', fr: 'À propos', ro: 'Despre mine' },
  'nav.reel': { en: 'Reel', nl: 'Reel', fr: 'Reel', ro: 'Reel' },
  'nav.work': { en: 'Work', nl: 'Werk', fr: 'Projets', ro: 'Proiecte' },
  'nav.contact': { en: 'Contact', nl: 'Contact', fr: 'Contact', ro: 'Contact' },

  'hero.seeWork': { en: 'See the work', nl: 'Bekijk mijn werk', fr: 'Voir les projets', ro: 'Vezi proiectele' },
  'hero.getInTouch': { en: 'Get in touch', nl: 'Neem contact op', fr: 'Me contacter', ro: 'Contactează-mă' },
  'hero.resume': { en: 'Resume', nl: 'CV', fr: 'CV', ro: 'CV' },

  'about.title': { en: 'About', nl: 'Over mij', fr: 'À propos', ro: 'Despre mine' },
  'about.photoAlt': { en: 'Portrait of {name}', nl: 'Portret van {name}', fr: 'Portrait de {name}', ro: 'Portret – {name}' },

  'reel.title': { en: 'Showreel', nl: 'Showreel', fr: 'Showreel', ro: 'Showreel' },
  'reel.soon': { en: 'Showreel coming soon', nl: 'Showreel volgt binnenkort', fr: 'Showreel bientôt disponible', ro: 'Showreel în curând' },

  'work.title': { en: 'Work & Experience', nl: 'Werk & ervaring', fr: 'Projets & expérience', ro: 'Proiecte și experiență' },
  'work.filterLabel': { en: 'Filter work by category', nl: 'Werk filteren op categorie', fr: 'Filtrer les projets par catégorie', ro: 'Filtrează proiectele după categorie' },
  'work.all': { en: 'All', nl: 'Alles', fr: 'Tout', ro: 'Toate' },
  'type.video': { en: 'Video', nl: 'Video', fr: 'Vidéo', ro: 'Video' },
  'type.audio': { en: 'Audio', nl: 'Audio', fr: 'Audio', ro: 'Audio' },
  'type.code': { en: 'Code', nl: 'Code', fr: 'Code', ro: 'Cod' },
  'work.watch': { en: 'Watch video', nl: 'Bekijk video', fr: 'Voir la vidéo', ro: 'Vezi videoclipul' },
  'work.details': { en: 'View details', nl: 'Bekijk details', fr: 'Voir les détails', ro: 'Vezi detalii' },
  'work.highlights': { en: 'Projects', nl: 'Projecten', fr: 'Projets', ro: 'Proiecte' },
  'work.prev': { en: 'Previous project', nl: 'Vorig project', fr: 'Projet précédent', ro: 'Proiectul anterior' },
  'work.next': { en: 'Next project', nl: 'Volgend project', fr: 'Projet suivant', ro: 'Proiectul următor' },
  'work.slide': { en: 'Project {n}', nl: 'Project {n}', fr: 'Projet {n}', ro: 'Proiectul {n}' },
  'work.watchMany': { en: 'Watch videos', nl: "Bekijk video's", fr: 'Voir les vidéos', ro: 'Vezi videoclipurile' },
  'work.videoCount': { en: '{n} videos', nl: "{n} video's", fr: '{n} vidéos', ro: '{n} videoclipuri' },
  'work.videoN': { en: 'Video {n}', nl: 'Video {n}', fr: 'Vidéo {n}', ro: 'Videoclipul {n}' },
  'work.pictureCount': { en: '{n} pictures', nl: "{n} foto's", fr: '{n} images', ro: '{n} imagini' },
  'work.pictureN': { en: 'Picture {n}', nl: 'Foto {n}', fr: 'Image {n}', ro: 'Imaginea {n}' },
  'work.viewPictures': { en: 'View pictures', nl: "Bekijk foto's", fr: 'Voir les images', ro: 'Vezi imaginile' },
  'work.prevMedia': { en: 'Previous', nl: 'Vorige', fr: 'Précédent', ro: 'Anterior' },
  'work.nextMedia': { en: 'Next', nl: 'Volgende', fr: 'Suivant', ro: 'Următor' },
  'work.videosLabel': { en: 'Videos in this project', nl: "Video's in dit project", fr: 'Vidéos de ce projet', ro: 'Videoclipuri din acest proiect' },
  'work.closeDetails': { en: 'Close project details', nl: 'Projectdetails sluiten', fr: 'Fermer les détails du projet', ro: 'Închide detaliile proiectului' },
  'cursor.view': { en: 'View', nl: 'Bekijk', fr: 'Voir', ro: 'Vezi' },
  'cursor.play': { en: 'Play', nl: 'Speel af', fr: 'Lire', ro: 'Redă' },
  'experience.title': { en: 'Experience', nl: 'Ervaring', fr: 'Expérience', ro: 'Experiență' },
  'toolkit.title': { en: 'Toolkit', nl: 'Toolkit', fr: 'Outils', ro: 'Instrumente' },

  'contact.title': { en: 'Contact', nl: 'Contact', fr: 'Contact', ro: 'Contact' },
  'contact.formTitle': { en: 'Send a Message', nl: 'Stuur een bericht', fr: 'Envoyer un message', ro: 'Trimite un mesaj' },
  'contact.name': { en: 'Name', nl: 'Naam', fr: 'Nom', ro: 'Nume' },
  'contact.email': { en: 'Your email', nl: 'Je e-mailadres', fr: 'Votre e-mail', ro: 'E-mailul tău' },
  'contact.subject': { en: 'Subject', nl: 'Onderwerp', fr: 'Objet', ro: 'Subiect' },
  'contact.message': { en: 'Message', nl: 'Bericht', fr: 'Message', ro: 'Mesaj' },
  'contact.send': { en: 'Send message', nl: 'Verstuur bericht', fr: 'Envoyer le message', ro: 'Trimite mesajul' },
  'contact.linkedin': { en: 'Connect on LinkedIn', nl: 'Vind me op LinkedIn', fr: 'Voir mon LinkedIn', ro: 'Conectează-te pe LinkedIn' },
  'contact.note': {
    en: 'Sending opens your email app with the message pre-filled, addressed to {first}.',
    nl: 'Bij verzenden opent je e-mailapp met het bericht al ingevuld, gericht aan {first}.',
    fr: "L'envoi ouvre votre application e-mail avec le message déjà rempli, adressé à {first}.",
    ro: 'La trimitere se deschide aplicația ta de e-mail cu mesajul deja completat, adresat către {first}.',
  },
};
