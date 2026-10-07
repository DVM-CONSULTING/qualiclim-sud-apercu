# Qualiclim Sud — site vitrine sur mesure

Site statique (HTML, CSS, JavaScript), sans aucune requête vers un serveur extérieur : polices et bibliothèques
d'animation sont hébergées sur le site (`polices/`, `js/vendor/`, copies vérifiées par empreinte SHA-384).

## Les trois valeurs de la mise en ligne

Tout se règle dans `configuration.json`, puis `node outils/fabriquer.mjs` :

| Clé | Rôle |
|---|---|
| `mode` | `apercu` (noindex, `robots.txt` en `Disallow: /`, en-tête `X-Robots-Tag`) ou `production` |
| `domaine` | adresse publique (canonique, partage, plan du site) |
| `mesureId` | identifiant `G-…` : pose le kit de mesure Belle Devanture v2 (copie exacte, `outils/kit-bd-v2.html`), le bandeau de consentement et « Gérer mes cookies » |
| `searchConsole` | contenu de la balise `google-site-verification` |
| `formulaire` | adresse du relais de formulaire (contrat du Worker « formulaire » de l'usine : `POST <adresse>/f/<slug>`) |

Le script réécrit uniquement les blocs `<!-- commun:tete -->` et `<!-- commun:pied -->` de `index.html`, et fabrique
`mentions-legales/`, `confidentialite/`, `cgv/`, `cgu/` (textes dans `contenus/`), `404.html`, `sitemap.xml`,
`robots.txt` et `_headers` (en-têtes de sécurité du modèle STANDARD-SITE §3). Il est idempotent.

## Hébergement

GitHub Pages : aperçu de travail seulement (il ignore `_headers`). Production : un hébergeur qui pose les en-têtes
(Cloudflare Pages, Netlify…) et sert `404.html` avec le statut 404.

## Mentions orange

Tout ce que le client doit encore fournir est écrit `[À CONFIRMER — CLIENT : …]` dans une `span.a-confirmer`,
surlignée en orange. Le site ne part pas en ligne tant qu'il en reste.

## Crédits

Photos aériennes et relief : IGN — BD ORTHO®, RGE ALTI® (Licence Ouverte Etalab 2.0). Fonds marins : EMODnet
Bathymetry (CC BY 4.0). Rivage : © les contributeurs d'OpenStreetMap (ODbL). Polices Manrope et Azeret Mono :
SIL Open Font License 1.1. GSAP (licence standard GSAP), Lenis (MIT), three.js (MIT).
Fabriqué par DVM Consulting — Digital experience by Belle Devanture.

## Serveur VPS (production choisie par David)

Sur le serveur (Debian ou Ubuntu), une commande : 

    curl -fsSL https://raw.githubusercontent.com/DVM-CONSULTING/qualiclim-sud-apercu/main/outils/installer-vps.sh | sudo bash

Le script vérifie le DNS ; si Caddy sert déjà d'autres sites, il ajoute celui-ci à côté (`outils/caddy-qualiclimsud.caddy`), sinon il installe nginx, git et certbot (refuse Apache ou
Caddy), récupère le site dans `/var/www/qualiclimsud`, obtient le certificat Let's Encrypt (webroot), pose
`outils/nginx-qualiclimsud.conf` (fabriqué par `fabriquer.mjs` : en-têtes du §3, 404, www → sans www, coulisses du
dépôt jamais servies), protège l'aperçu par mot de passe (affiché une fois) et met les fichiers à jour toutes les 5 min.
La configuration nginx ne change que quand on relance le script (passage en production : relancer après le push).
