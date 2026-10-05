#!/usr/bin/env node
/**
 * Qualiclim Sud — fabrique les parties communes du site et ses pages d'information.
 *
 *   node outils/fabriquer.mjs
 *
 * Lit `configuration.json` (mode aperçu ou production, domaine, identifiant de mesure, balise Search Console,
 * adresse du relais de formulaire) et écrit :
 *   - dans `index.html`, les blocs entre <!-- commun:tete --> et <!-- commun:pied --> (rien d'autre n'est touché) ;
 *   - les pages `mentions-legales/`, `confidentialite/`, `cgv/`, `cgu/` depuis `contenus/*.html` ;
 *   - `404.html`, `sitemap.xml`, `robots.txt`, `_headers`.
 *
 * Standard Belle Devanture (REGLES/STANDARD-SITE.md) :
 *   - le kit de mesure v2 est la COPIE EXACTE de l'extrait de l'Arrière-boutique (`outils/kit-bd-v2.html`) ;
 *     seul `{{MESURE_ID}}` est remplacé, et seulement par un identifiant de forme `G-…` ;
 *   - sans identifiant de mesure : ni kit, ni bandeau, ni « Gérer mes cookies » (un bandeau qui demande un accord
 *     pour rien serait une information fausse), et la politique de confidentialité le dit ;
 *   - aperçu : `noindex` en balise et en en-tête `X-Robots-Tag`, `robots.txt` en `Disallow: /`.
 * Le script est idempotent : le relancer avec la même configuration ne change rien.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RACINE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const lire = (f) => fs.readFileSync(path.join(RACINE, f), 'utf8');
const ecrire = (f, contenu) => { fs.mkdirSync(path.dirname(path.join(RACINE, f)), { recursive: true }); fs.writeFileSync(path.join(RACINE, f), contenu); };
const echec = (m) => { console.error('configuration.json : ' + m); process.exit(1); };

// ------------------------------------------------------------------ configuration, vérifiée avant tout
const C = JSON.parse(lire('configuration.json'));
if (!['apercu', 'production'].includes(C.mode)) echec('« mode » vaut "apercu" ou "production".');
if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/.test(C.domaine || '')) echec('« domaine » : https://nom-de-domaine, sans barre finale.');
if (!/^\/([a-z0-9-]+\/)*$/.test(C.baseApercu || '')) echec('« baseApercu » : chemin de l\'aperçu, ex. /qualiclim-sud-apercu/.');
if (C.mesureId && !/^G-[A-Z0-9]{6,12}$/.test(C.mesureId)) echec('« mesureId » : vide, ou un identifiant de la forme G-XXXXXXXXXX.');
if (C.searchConsole && !/^[A-Za-z0-9_-]{20,90}$/.test(C.searchConsole)) echec('« searchConsole » : vide, ou le contenu de la balise google-site-verification.');
if (C.formulaire && !/^https:\/\/[a-z0-9.-]+(\/[a-zA-Z0-9._~-]+)*$/.test(C.formulaire)) echec('« formulaire » : vide, ou l\'adresse https du relais (sans /f/<slug>).');
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(C.slug || '')) echec('« slug » : minuscules et tirets.');
if (!/^\d{4}-\d{2}-\d{2}$/.test(C.majContenus || '')) echec('« majContenus » : date AAAA-MM-JJ.');
const PROD = C.mode === 'production', MESURE = Boolean(C.mesureId), D = C.domaine;
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const [an, mo, jo] = C.majContenus.split('-').map(Number);
const MAJ = `${jo === 1 ? '1er' : jo} ${MOIS[mo - 1]} ${an}`;
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// ------------------------------------------------------------------ kit de mesure : copie exacte, jamais retouchée
const KIT_EMPREINTE = '5f8a267fd06227d858980ec8358afa95ff4de4f4c3d5d21eee02a805ba0d1a2c'; // = web-creator/packages/socle/src/mesure/kit-bd-v2.html
const kitBrut = lire('outils/kit-bd-v2.html');
if (crypto.createHash('sha256').update(kitBrut).digest('hex') !== KIT_EMPREINTE) echec('outils/kit-bd-v2.html a changé : une nouvelle version du kit se recopie depuis l\'Arrière-boutique, avec sa nouvelle empreinte.');
const kit = MESURE ? kitBrut.replace('{{MESURE_ID}}', C.mesureId).trim() : '';

// ------------------------------------------------------------------ morceaux communs
const RUBRIQUES = [['climatisation', 'Réversible'], ['simulateur', 'Simulateur'], ['zone', 'Secteur'], ['questions', 'Questions'], ['contact', 'Contact']];
const PAGES = [
  { dossier: 'mentions-legales', court: 'Mentions légales', h1: 'Mentions légales', titre: 'Mentions légales | Qualiclim Sud',
    description: 'Mentions légales du site Qualiclim Sud : éditeur QUALICLIM (SASU), immatriculation, hébergeur, assurances, médiateur de la consommation et crédits.',
    chapeau: 'Qui édite ce site, qui l\'héberge, et à qui vous adresser.' },
  { dossier: 'confidentialite', court: 'Confidentialité et cookies', h1: 'Confidentialité et cookies', titre: 'Confidentialité et cookies | Qualiclim Sud',
    description: 'Ce que Qualiclim Sud fait des informations envoyées par le formulaire et le simulateur, combien de temps elles sont gardées, vos droits et les cookies.',
    chapeau: 'Ce que nous faisons de vos informations, combien de temps nous les gardons, et comment exercer vos droits.' },
  { dossier: 'cgv', court: 'Conditions générales de vente', h1: 'Conditions générales de vente et de pose', titre: 'Conditions générales de vente et de pose | Qualiclim Sud',
    description: 'Conditions générales de vente et de pose de climatisation de QUALICLIM (Qualiclim Sud) : devis, prix, paiement, rétractation, garanties, médiation.',
    chapeau: 'Les règles qui s\'appliquent quand vous nous achetez un appareil ou nous confiez sa pose. Le devis signé les complète.' },
  { dossier: 'cgu', court: 'Conditions d\'utilisation', h1: 'Conditions d\'utilisation du site', titre: 'Conditions d\'utilisation du site | Qualiclim Sud',
    description: 'Conditions d\'utilisation du site Qualiclim Sud : simulateur de puissance, informations réglementaires, formulaire, propriété intellectuelle.',
    chapeau: 'Comment utiliser ce site, et ce que valent le simulateur et les informations qu\'il donne.' },
];

function tete({ r, chemin, index = false, page = null, introuvable = false }) {
  const l = [];
  l.push(introuvable || !PROD ? '<meta name="robots" content="noindex, nofollow">' : '<meta name="robots" content="index, follow, max-image-preview:large">');
  if (!PROD && !introuvable) l.push('<!-- Aperçu : la page n\'est pas indexée (configuration.json, "mode": "apercu"). -->');
  if (C.searchConsole && !introuvable) l.push(`<meta name="google-site-verification" content="${attr(C.searchConsole)}">`);
  if (!introuvable) l.push(`<link rel="canonical" href="${D}${chemin}">`, `<meta property="og:url" content="${D}${chemin}">`);
  l.push(`<meta property="og:image" content="${D}/img/partage.jpg">`, '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="Le logo Qualiclim Sud au-dessus du port de Fréjus">');
  l.push(`<meta name="qs-formulaire" content="${attr(C.formulaire)}" data-slug="${attr(C.slug)}">`);
  l.push(`<link rel="icon" href="${r}favicon.ico" sizes="any">`, `<link rel="icon" href="${r}img/icone-32.png" type="image/png" sizes="32x32">`, `<link rel="apple-touch-icon" href="${r}img/icone-180.png">`);
  l.push(`<link rel="preload" href="${r}polices/manrope-latin.woff2" as="font" type="font/woff2" crossorigin>`, `<link rel="preload" href="${r}polices/azeret-mono-500-latin.woff2" as="font" type="font/woff2" crossorigin>`);
  if (kit) l.push(kit);
  if (index) l.push(`<script type="application/ld+json">\n${JSON.stringify(grapheAccueil(), null, 2)}\n</script>`);
  if (page) l.push(`<script type="application/ld+json">\n${JSON.stringify(graphePage(page), null, 2)}\n</script>`);
  return '\n' + l.join('\n') + '\n';
}

function grapheAccueil() {
  return { '@context': 'https://schema.org', '@graph': [
    { '@type': 'HVACBusiness', '@id': `${D}/#entreprise`, name: 'Qualiclim Sud', legalName: 'QUALICLIM', url: `${D}/`, logo: `${D}/img/logo.webp`, image: `${D}/img/partage.jpg`,
      description: 'Vente et pose de climatisation réversible (pompe à chaleur air-air), principalement Mitsubishi Electric et Mundoclima, de Fréjus à Cannes.',
      telephone: '+33634493249', email: 'contact@qualiclimsud.fr',
      address: { '@type': 'PostalAddress', addressLocality: 'Fréjus', postalCode: '83600', addressRegion: 'Provence-Alpes-Côte d\'Azur', addressCountry: 'FR' },
      areaServed: ['Fréjus', 'Saint-Raphaël', 'Théoule-sur-Mer', 'Mandelieu-la-Napoule', 'Cannes'].map(name => ({ '@type': 'City', name })),
      brand: ['Mitsubishi Electric', 'Mundoclima'].map(name => ({ '@type': 'Brand', name })),
      knowsAbout: ['Climatisation réversible', 'Pompe à chaleur air-air'],
      identifier: { '@type': 'PropertyValue', propertyID: 'SIREN', value: '944335249' } },
    { '@type': 'WebSite', '@id': `${D}/#site`, url: `${D}/`, name: 'Qualiclim Sud', inLanguage: 'fr-FR', publisher: { '@id': `${D}/#entreprise` } },
    { '@type': 'WebPage', '@id': `${D}/#page`, url: `${D}/`, name: 'Climatisation réversible de Fréjus à Cannes | Qualiclim Sud', isPartOf: { '@id': `${D}/#site` }, about: { '@id': `${D}/#entreprise` }, inLanguage: 'fr-FR' },
  ] };
}
function graphePage(p) {
  const url = `${D}/${p.dossier}/`;
  return { '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebPage', '@id': `${url}#page`, url, name: p.titre, description: p.description, inLanguage: 'fr-FR', isPartOf: { '@id': `${D}/#site` }, dateModified: C.majContenus },
    { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Accueil', item: `${D}/` }, { '@type': 'ListItem', position: 2, name: p.court, item: url }] },
  ] };
}

function nav(r) {
  return `<header class="nav sur-clair" id="nav">
  <a class="signe" href="${r || './'}" aria-label="Qualiclim Sud, page d'accueil"><img class="signe__q" src="${r}img/q-petit.webp" alt="" width="112" height="108"><img class="signe__nom" src="${r}img/nom-petit.webp" alt="" width="480" height="72"></a>
  <nav class="nav__liens" aria-label="Rubriques">
    ${RUBRIQUES.map(([id, t]) => `<a href="${r}#${id}">${t}</a>`).join('\n    ')}
  </nav>
  <a class="pilule pilule--porcelaine" href="tel:+33634493249" aria-label="Appeler Qualiclim Sud au 06 34 49 32 49">Appeler<span class="appel__num">&nbsp;· 06&nbsp;34&nbsp;49&nbsp;32&nbsp;49</span></a>
</header>`;
}

function pied(r) {
  const bandeau = MESURE ? `
<div class="consentement" role="region" aria-label="Vos choix sur les cookies" data-bd-consentement hidden>
  <div class="consentement__interieur">
    <p class="consentement__texte">Nous mesurons la fréquentation de ce site et les erreurs rencontrées avec Google Analytics, uniquement si vous l'acceptez. Vous pouvez changer d'avis à tout moment avec le lien « Gérer mes cookies » en bas de page. <a href="${r}confidentialite/#cookies">En savoir plus</a></p>
    <div class="consentement__actions"><button type="button" class="consentement__bouton" data-choix="refuse">Refuser</button><button type="button" class="consentement__bouton" data-choix="accepte">Accepter</button></div>
  </div>
</div>` : '';
  return `
<footer class="pied">
  <div class="cadre">
    <div class="pied__haut">
      <img class="pied__logo" src="${r}img/logo.webp" alt="Qualiclim Sud" width="900" height="600" loading="lazy">
      <p class="pied__slogan">Le Sud, à la bonne température.</p>
    </div>
    <div class="pied__colonnes">
      <div><p class="pied__t">Qualiclim Sud</p><p>Vente et pose de climatisation réversible, principalement Mitsubishi Electric et Mundoclima, de Fréjus à Cannes.</p><p class="pied__entreprise">QUALICLIM, SASU au capital de 100&nbsp;€ · SIREN 944&nbsp;335&nbsp;249 · Dirigeant : Michaël Musto</p></div>
      <div><p class="pied__t">Contact</p><p><a href="tel:+33634493249">06 34 49 32 49</a></p><p><a href="mailto:contact@qualiclimsud.fr">contact@qualiclimsud.fr</a></p><p>Dépôt à Fréjus · <span class="a-confirmer">[À CONFIRMER — CLIENT : adresse du dépôt]</span></p></div>
      <nav aria-label="Rubriques du site"><p class="pied__t">Rubriques</p><ul>
        <li><a href="${r}#climatisation">La climatisation réversible</a></li>
        <li><a href="${r}#simulateur">Simulateur de puissance</a></li>
        <li><a href="${r}#deroulement">Les étapes d'une installation</a></li>
        <li><a href="${r}#demarches">Autorisations, TVA et aides</a></li>
        <li><a href="${r}#realisations">Réalisations</a></li>
        <li><a href="${r}#questions">Questions fréquentes</a></li>
      </ul></nav>
      <div><p class="pied__t">Secteur</p><p>Fréjus · Saint-Raphaël · Agay · Théoule-sur-Mer · Mandelieu-la-Napoule · Cannes</p><p><a href="${r}#zone">Voir notre secteur</a></p></div>
      <nav aria-label="Informations légales"><p class="pied__t">Informations</p><ul>
        ${PAGES.map(p => `<li><a href="${r}${p.dossier}/">${p.court}</a></li>`).join('\n        ')}${MESURE ? '\n        <li><button type="button" class="pied__cookies" data-bd-cookies>Gérer mes cookies</button></li>' : ''}
      </ul></nav>
    </div>
    <div class="pied__bas">
      <p class="signature">© <span data-annee>2026</span> Qualiclim Sud — Digital experience by <a href="https://belledevanture.fr" target="_blank" rel="noopener">Belle Devanture</a></p>
      <p class="legal">Vidéo du survol et photos de chantier : Qualiclim Sud (photos publiées avec l'accord des propriétaires). Photos aériennes et relief : IGN — BD ORTHO®, RGE ALTI® (Licence Ouverte Etalab 2.0). Fonds marins : EMODnet Bathymetry (CC BY 4.0). Rivage : © les contributeurs d'OpenStreetMap (ODbL).</p>
    </div>
  </div>
</footer>${bandeau}
`;
}

const remplacerBloc = (html, nom, contenu) => {
  const re = new RegExp(`<!-- commun:${nom} -->[\\s\\S]*?<!-- /commun:${nom} -->`);
  if (!re.test(html)) echec(`bloc <!-- commun:${nom} --> introuvable dans index.html.`);
  return html.replace(re, () => `<!-- commun:${nom} -->${contenu}<!-- /commun:${nom} -->`);
};
const conditionnels = (html) => html
  .replace(/<!--si:mesure-->([\s\S]*?)<!--\/si:mesure-->/g, (_, x) => MESURE ? x : '')
  .replace(/<!--si:sans-mesure-->([\s\S]*?)<!--\/si:sans-mesure-->/g, (_, x) => MESURE ? '' : x);

// ------------------------------------------------------------------ accueil : seuls les blocs communs changent
let accueil = lire('index.html');
accueil = remplacerBloc(accueil, 'tete', tete({ r: '', chemin: '/', index: true }));
accueil = remplacerBloc(accueil, 'pied', pied(''));
ecrire('index.html', accueil);

// ------------------------------------------------------------------ pages d'information
for (const p of PAGES) {
  const r = '../';
  let corps = conditionnels(lire(`contenus/${p.dossier}.html`)).replaceAll('{{racine}}', r).replaceAll('{{maj}}', MAJ).trim();
  const sommaire = [...corps.matchAll(/<section id="([a-z0-9-]+)"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>/g)].map(m => `<a href="#${m[1]}">${m[2].replace(/<[^>]+>/g, '')}</a>`);
  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${p.titre}</title>
<meta name="description" content="${attr(p.description)}">
<meta name="theme-color" content="#0e1d33">
<meta property="og:type" content="website">
<meta property="og:locale" content="fr_FR">
<meta property="og:site_name" content="Qualiclim Sud">
<meta property="og:title" content="${attr(p.titre)}">
<meta property="og:description" content="${attr(p.description)}">
<!-- commun:tete -->${tete({ r, chemin: `/${p.dossier}/`, page: p })}<!-- /commun:tete -->
<link rel="stylesheet" href="${r}css/site.css">
</head>
<body class="page-simple">
<a class="evitement" href="#contenu">Aller au contenu</a>
${nav(r)}
<main id="contenu">
  <header class="legal-entete">
    <div class="cadre">
      <p class="sur-titre sur-titre--clair"><span>§</span>Informations</p>
      <h1>${p.h1}</h1>
      <p class="chapeau">${p.chapeau}</p>
      <p class="maj">Dernière mise à jour : ${MAJ}</p>
    </div>
  </header>
  <div class="legal-corps">
    <div class="legal-grille">
      <nav class="sommaire" aria-label="Sommaire de la page"><p>Sommaire</p>${sommaire.join('')}</nav>
      <article class="prose">
${corps}
      </article>
    </div>
  </div>
</main>
<!-- commun:pied -->${pied(r)}<!-- /commun:pied -->
<script src="${r}js/commun.js"></script>
</body>
</html>
`;
  ecrire(`${p.dossier}/index.html`, html);
}

// ------------------------------------------------------------------ page introuvable (servie avec le statut 404 par l'hébergeur)
const base = PROD ? '/' : C.baseApercu;
ecrire('404.html', `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<base href="${base}">
<title>Page introuvable | Qualiclim Sud</title>
<meta name="description" content="Cette page n'existe pas ou a changé d'adresse. Retrouvez la climatisation réversible Qualiclim Sud, de Fréjus à Cannes.">
<meta name="theme-color" content="#0e1d33">
<!-- commun:tete -->${tete({ r: '', chemin: '/404', introuvable: true })}<!-- /commun:tete -->
<link rel="stylesheet" href="css/site.css">
</head>
<body class="page-simple" data-bd-404>
<a class="evitement" href="#contenu">Aller au contenu</a>
${nav('')}
<main id="contenu" class="introuvable">
  <div class="cadre">
    <p class="introuvable__code">Erreur 404</p>
    <h1>Cette page n'existe pas.</h1>
    <p>L'adresse a peut-être changé, ou elle contient une faute de frappe. Voici où aller.</p>
    <div class="introuvable__liens">
      <a class="pilule pilule--porcelaine" href="./">Page d'accueil</a>
      <a class="pilule pilule--onglet" href="#simulateur">Simulateur</a>
      <a class="pilule pilule--onglet" href="#contact">Nous écrire</a>
      <a class="pilule pilule--onglet" href="tel:+33634493249">Appeler · 06&nbsp;34&nbsp;49&nbsp;32&nbsp;49</a>
    </div>
  </div>
</main>
<!-- commun:pied -->${pied('')}<!-- /commun:pied -->
<script src="js/commun.js"></script>
</body>
</html>
`.replace(/href="#(simulateur|contact)"/g, 'href="./#$1"'));

// ------------------------------------------------------------------ référencement et en-têtes
const urls = ['/', ...PAGES.map(p => `/${p.dossier}/`)];
ecrire('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${D}${u}</loc><lastmod>${C.majContenus}</lastmod></url>`).join('\n')}
</urlset>
`);
ecrire('robots.txt', `${PROD ? 'User-agent: *\nAllow: /' : '# Aperçu : rien n\'est indexé.\nUser-agent: *\nDisallow: /'}

Sitemap: ${D}/sitemap.xml
`);
const origineFormulaire = C.formulaire ? new URL(C.formulaire).origin : '';
const csp = ["default-src 'self'", "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
  `connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com${origineFormulaire ? ' ' + origineFormulaire : ''}`,
  "img-src 'self' data: https://*.google-analytics.com https://www.googletagmanager.com", "media-src 'self' blob:", "style-src 'self' 'unsafe-inline'", "font-src 'self'",
  "frame-ancestors 'none'", "base-uri 'self'", `form-action 'self'${origineFormulaire ? ' ' + origineFormulaire : ''}`, "object-src 'none'", 'upgrade-insecure-requests'].join('; ');
ecrire('_headers', `# En-têtes de sécurité — modèle de REGLES/STANDARD-SITE.md §3 (Cloudflare Pages, Netlify).
# Ajouts propres à ce site : media-src blob: (la vidéo du survol est lue depuis la mémoire du navigateur).
# GitHub Pages ignore ce fichier : il ne sert qu'en production.
/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()${PROD ? '' : '\n  X-Robots-Tag: noindex, nofollow'}

/polices/*
  Cache-Control: public, max-age=31536000, immutable
/js/vendor/*
  Cache-Control: public, max-age=31536000, immutable
`);

console.log(`Fabriqué en mode ${PROD ? 'PRODUCTION' : 'aperçu'} — mesure ${MESURE ? C.mesureId : 'absente'}, Search Console ${C.searchConsole ? 'posée' : 'absente'}, formulaire ${C.formulaire ? origineFormulaire : 'non relié'}.`);
