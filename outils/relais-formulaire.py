#!/usr/bin/env python3
"""
Qualiclim Sud — relais du formulaire de contact, sur le VPS, derrière Caddy ou nginx (127.0.0.1:8787).

Même contrat que le Worker « formulaire » de l'usine web-creator, pour pouvoir basculer de l'un à l'autre
en changeant seulement `formulaire` dans configuration.json :
    POST /f/<slug>   JSON ou formulaire : nom, telephone, email, message, _slug, _ts, site_web (champ piège)
    réponse { "ok": true } quand la demande est enregistrée ; { "ok": false, "erreurs": [...] } sinon
    GET  /sante      { "ok": true, "en_attente": n }

Règles tenues (comme le Worker) :
  - la demande est ÉCRITE SUR LE DISQUE avant toute autre chose : une panne de Brevo ne la perd jamais ;
  - l'e-mail part ensuite par l'API transactionnelle Brevo ; en cas d'échec, la demande reste dans la file
    et `relais-formulaire.py --relancer` (minuteur systemd, toutes les 5 minutes) la renvoie ;
  - champ piège rempli ou envoi en moins de 3 s : on répond « merci » sans rien envoyer (on ne renseigne
    jamais un robot) ; 5 demandes au plus par appareil et par 10 minutes ;
  - le message d'un visiteur n'est jamais interprété : texte brut, HTML échappé ;
  - filtre anti-spam à points (voir evaluer) : une demande douteuse reçoit la même réponse « merci » (un robot
    ne doit rien apprendre) mais n'est PAS envoyée à l'entreprise : elle est mise de côté dans « suspects »,
    résumée une fois par jour par e-mail, et peut être débloquée (--suspects, --liberer <id>) ;
  - deux e-mails : l'alerte à l'entreprise (bouton d'appel, détails, message), puis, si le visiteur a laissé son
    e-mail, un accusé de réception qui ne recopie jamais son texte (pas de relais de spam vers un tiers).

Configuration par variables d'environnement (fichier /etc/qualiclim-relais.env, lisible par root seulement) :
  BREVO_API_KEY (obligatoire), DESTINATAIRE, EXPEDITEUR, NOM_EXPEDITEUR, COPIE (facultatif), SLUG,
  ENTREPRISE, ORIGINES (séparées par des espaces), PORT, SITE_URL, TEL_ENTREPRISE, MENTION_SOCIETE,
  ACCUSE (0 pour ne pas envoyer d'accusé de réception au visiteur). Aucune dépendance : bibliothèque standard de Python 3.
"""
import html
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import unicodedata
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

CLE = os.environ.get('BREVO_API_KEY', '').strip()
URL_BREVO = os.environ.get('BREVO_URL', 'https://api.brevo.com/v3/smtp/email')
DESTINATAIRE = os.environ.get('DESTINATAIRE', 'contact@qualiclimsud.fr').strip()
EXPEDITEUR = os.environ.get('EXPEDITEUR', 'formulaire@qualiclimsud.fr').strip()
NOM_EXPEDITEUR = os.environ.get('NOM_EXPEDITEUR', 'Site Qualiclim Sud').strip()
COPIE = os.environ.get('COPIE', '').strip()
SLUG = os.environ.get('SLUG', 'qualiclim-sud').strip()
ENTREPRISE = os.environ.get('ENTREPRISE', 'Qualiclim Sud').strip()
SITE_URL = os.environ.get('SITE_URL', 'https://qualiclimsud.fr').strip().rstrip('/')
TEL_ENTREPRISE = os.environ.get('TEL_ENTREPRISE', '06 34 49 32 49').strip()
MENTION_SOCIETE = os.environ.get('MENTION_SOCIETE', 'QUALICLIM, entrepreneur individuel · SIRET\u00a0797\u00a0445\u00a0715\u00a000015 · TVA non applicable, art.\u00a0293\u00a0B du CGI').strip()
ACCUSE = os.environ.get('ACCUSE', '1').strip() != '0'  # accusé de réception au visiteur qui a laissé son e-mail
ORIGINES = set(os.environ.get('ORIGINES', 'https://qualiclimsud.fr https://www.qualiclimsud.fr').split())
PORT = int(os.environ.get('PORT', '8787'))
DOSSIER = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/qualiclim-relais'))
FILE, ENVOYEES, SUSPECTS = DOSSIER / 'a-envoyer', DOSSIER / 'envoyees', DOSSIER / 'suspects'
TAILLE_MAX = 64 * 1024
DELAI_MINIMAL_S, LIMITE, FENETRE_S = 4, 3, 600   # 4 s avant l'envoi, 3 envois par appareil et par 10 minutes
PLAFOND_HEURE = 20        # demandes normales par heure, tous appareils confondus : au-delà, mises de côté
SEUIL_SUSPECT = 3         # points à partir desquels une demande est mise de côté
CONSERVATION_SUSPECTS_JOURS = 30
CONSERVATION_JOURS = 90  # copie de sécurité ; la demande vit ensuite dans la messagerie du client
PARIS = ZoneInfo('Europe/Paris')

_compteurs: dict = {}
_recentes: list = []      # heures des demandes normales (plafond horaire)
_messages: dict = {}      # empreinte du message -> (heure, identité de l'expéditeur)
_verrou = threading.Lock()


def journal(evenement: str, **infos) -> None:
    print(json.dumps({'evenement': evenement, **infos}, ensure_ascii=False), flush=True)


# ---------------------------------------------------------------- validation (mêmes règles que le Worker)
def nettoyer(v) -> str:
    v = v if isinstance(v, str) else ('' if v is None else str(v))
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', v).strip()


def email_valide(v: str) -> bool:
    return 0 < len(v) <= 120 and re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', v) is not None


def telephone_valide(v: str) -> bool:
    chiffres = re.sub(r'\D', '', v)
    return 0 < len(v) <= 30 and re.fullmatch(r'[+0-9 ().\-]+', v) is not None and 9 <= len(chiffres) <= 15


def valider(champs: dict) -> tuple:
    nom, tel = nettoyer(champs.get('nom'))[:200], nettoyer(champs.get('telephone'))[:60]
    mail, msg = nettoyer(champs.get('email')).lower()[:200], nettoyer(champs.get('message'))[:4000]
    erreurs = []
    if len(nom) < 2:
        erreurs.append('Merci d’indiquer votre nom.')
    elif len(nom) > 80:
        erreurs.append('Le nom ne doit pas dépasser 80 caractères.')
    if not tel and not mail:
        erreurs.append('Merci d’indiquer un téléphone ou un email, sinon nous ne pourrons pas vous répondre.')
    if tel and not telephone_valide(tel):
        erreurs.append('Le numéro de téléphone semble incorrect.')
    if mail and not email_valide(mail):
        erreurs.append('L’adresse email semble incorrecte (ex. prenom@exemple.fr).')
    if len(msg) < 5:
        erreurs.append('Merci de décrire votre demande en quelques mots.')
    elif len(msg) > 2000:
        erreurs.append(f'Votre message est trop long ({len(msg)} caractères, maximum 2000). Merci de le raccourcir.')
    return erreurs, {'nom': nom, 'telephone': tel or None, 'email': mail or None, 'message': msg, **complements(champs)}


def complements(champs: dict) -> dict:
    """Champs facultatifs envoyés par le site pour un e-mail plus lisible ; le message complet reste la référence."""
    formulaire = nettoyer(champs.get('formulaire'))
    rappel = champs.get('rappel')
    details = champs.get('details')
    sortie = {'formulaire': formulaire if formulaire in ('contact', 'simulateur') else None,
              'rappel': rappel is True or nettoyer(rappel).lower() in ('oui', 'true', '1')}
    if isinstance(details, list):
        sortie['details'] = [[nettoyer(p[0])[:40], nettoyer(p[1])[:200]] for p in details[:12]
                             if isinstance(p, list) and len(p) == 2 and nettoyer(p[0]) and nettoyer(p[1])]
        sortie['note'] = nettoyer(champs.get('note'))[:2000]
    return sortie


# ---------------------------------------------------------------- filtre anti-spam à points
# Un robot remplit tout et se moque d'un « merci » : on ne lui dit jamais qu'il est repéré. Chaque signal ajoute des
# points ; à SEUIL_SUSPECT la demande est mise de côté, pas supprimée (un vrai client mal classé se rattrape).
TLD_RISQUES = ('.ru', '.cn', '.my.id', '.co.id', '.web.id', '.biz.id', '.xyz', '.top', '.click', '.buzz', '.icu', '.cfd',
               '.sbs', '.monster', '.rest', '.ws', '.su', '.work', '.loan', '.win')
JETABLES = {'mailinator.com', 'yopmail.com', 'yopmail.fr', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
            'temp-mail.org', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc',
            'throwaway.email', 'fakeinbox.com', 'mohmal.com', 'tempail.com'}
LIEN = re.compile(r'(https?://|www\.|\b[a-z0-9-]{2,}\.(?:com|net|org|ru|cn|xyz|top|biz|info|shop|site|online|click|link|club)\b)', re.I)
PUB = re.compile(r"\b(seo|backlinks?|bitcoin|crypto\w*|casino|viagra|cialis|forex|escort\w*|porn\w*|"
                 r"gagner de l.argent|premi[eè]re page (?:de )?google|augmenter (?:votre |le )?trafic|"
                 r"agence (?:web|seo|marketing)|refonte (?:de )?(?:votre )?site|cr[eé]ation de site|"
                 r"offre (?:sp[eé]ciale )?commerciale|collaboration|partenariat commercial)\b", re.I)


def part_non_latine(texte: str) -> float:
    lettres = [c for c in texte if c.isalpha()]
    if not lettres:
        return 0.0
    return sum(1 for c in lettres if 'LATIN' not in unicodedata.name(c, 'LATIN')) / len(lettres)


def evaluer(d: dict, maintenant: float) -> tuple:
    """Renvoie (points, raisons). Les raisons sont écrites pour l'entreprise : elles servent au résumé quotidien."""
    pts, raisons = 0, []
    def signal(n: int, texte: str) -> None:
        nonlocal pts
        pts += n
        raisons.append(texte)
    nom, msg, mail = d['nom'], d['message'], d['email'] or ''
    domaine = mail.rsplit('@', 1)[-1].lower() if '@' in mail else ''
    if domaine in JETABLES:
        signal(3, 'adresse e-mail jetable (' + domaine + ')')
    elif domaine.endswith(TLD_RISQUES):
        signal(3, 'adresse e-mail d\'un pays ou d\'un domaine très utilisé par les robots (' + domaine + ')')
    if LIEN.search(re.sub(r'\S+@\S+', ' ', msg)) or LIEN.search(nom):   # une adresse e-mail écrite dans le message n'est pas un lien
        signal(3, 'lien internet dans le message ou dans le nom')
    if part_non_latine(msg) > 0.3 or part_non_latine(nom) > 0.3:
        signal(3, 'écriture non latine')
    if PUB.search(msg):
        signal(3, 'mots de démarchage ou de publicité')
    if re.search(r'\d', nom):
        signal(1, 'chiffres dans le nom')
    if re.search(r'(?i)[bcdfghjklmnpqrstvwxz]{5,}', nom):
        signal(1, 'nom sans voyelles')
    if len(msg) < 12:
        signal(1, 'message très court')
    if re.search(r'(.)\1{5,}', msg):
        signal(1, 'caractères répétés')
    lettres = [c for c in msg if c.isalpha()]
    if len(lettres) > 20 and sum(1 for c in lettres if c.isupper()) / len(lettres) > 0.6:
        signal(1, 'message écrit en majuscules')
    # même texte, expéditeur différent : un robot qui rejoue son message
    if len(msg) >= 25:
        empreinte = hashlib.sha1(re.sub(r'[^a-z0-9]', '', msg.lower()).encode()).hexdigest()
        identite = (nom.lower(), d['telephone'] or '', mail)
        with _verrou:
            for k in [k for k, v in _messages.items() if maintenant - v[0] > 86400]:
                del _messages[k]
            avant = _messages.get(empreinte)
            if avant and avant[1] != identite:
                signal(3, 'même message déjà reçu d\'une autre personne')
            _messages.setdefault(empreinte, (maintenant, identite))
    # trop de demandes normales en peu de temps, tous appareils confondus
    with _verrou:
        du_moment = [t for t in _recentes if maintenant - t < 3600]
        if len(du_moment) >= PLAFOND_HEURE:
            signal(3, 'trop de demandes en une heure')
    return pts, raisons


# ---------------------------------------------------------------- e-mails (HTML en tableaux : Gmail, Outlook, Apple Mail, téléphones)
# Couleurs du site (css/site.css) : nuit cobalt, porcelaine, cobalt réservé aux chiffres et aux repères.
NUIT, PORCELAINE, COBALT, GLACIER, FILET, DOUX = '#0e1d33', '#f4f2ee', '#2a5fae', '#e4e9f0', '#d4d1cb', '#5b6472'
POLICE = "font-family:'Manrope',Helvetica,Arial,sans-serif;"
JOURS = ('lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche')
MOIS = ('janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre')
ORIGINES_DEMANDE = {'contact': 'Demande de contact', 'simulateur': 'Estimation du simulateur'}
e = html.escape


def date_longue(iso: str) -> str:
    t = datetime.fromisoformat(iso).astimezone(PARIS)
    return f"{JOURS[t.weekday()]} {t.day}{'er' if t.day == 1 else ''} {MOIS[t.month - 1]} {t.year} à {t:%H:%M}"


def tel_lien(numero: str) -> str:
    chiffres = re.sub(r'[^\d+]', '', numero)
    return '+33' + chiffres[1:] if chiffres.startswith('0') and len(chiffres) == 10 else chiffres


def bouton(lien: str, texte: str, detail: str = '', plein: bool = True) -> str:
    fond, encre, bord = (NUIT, '#ffffff', NUIT) if plein else ('#ffffff', NUIT, NUIT)
    sous = (f'<br><span style="font-weight:500;font-size:16px;letter-spacing:.02em;">{detail}</span>') if detail else ''
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;">'
            f'<tr><td align="center" bgcolor="{fond}" style="border:2px solid {bord};border-radius:12px;">'
            f'<a href="{lien}" style="display:block;padding:15px 18px;{POLICE}font-size:17px;font-weight:700;line-height:1.35;'
            f'color:{encre};text-decoration:none;border-radius:12px;">{texte}{sous}</a></td></tr></table>')


def pastille(texte: str, fond: str, encre: str) -> str:
    return (f'<span style="display:inline-block;margin:0 6px 6px 0;padding:5px 11px;border-radius:999px;background:{fond};'
            f'color:{encre};{POLICE}font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;">{texte}</span>')


def cadre(titre: str, annonce: str, bandeau: str, contenu: str, pied: str) -> str:
    """Coquille commune : bandeau nuit avec le logo, carte blanche, pied discret. 600 px, une colonne."""
    vide = '&#847;&zwnj;&nbsp;' * 40  # empêche la messagerie d'afficher la suite du texte après l'annonce
    return f'''<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>{e(titre)}</title>
<style>
@media (max-width:620px){{ .carte{{width:100%!important}} .marge{{padding-left:22px!important;padding-right:22px!important}} .titre{{font-size:25px!important}} }}
a[x-apple-data-detectors]{{color:inherit!important;text-decoration:none!important}}
</style></head>
<body style="margin:0;padding:0;background:{PORCELAINE};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">{e(annonce)}{vide}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{PORCELAINE}" style="background:{PORCELAINE};">
<tr><td align="center" style="padding:28px 12px 36px;">
<table role="presentation" class="carte" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
<tr><td align="center" bgcolor="{NUIT}" style="background:{NUIT};border-radius:16px 16px 0 0;padding:30px 24px 24px;">
<a href="{SITE_URL}/" style="text-decoration:none;"><img src="{SITE_URL}/courriel/logo.png" width="168" height="112" alt="Qualiclim Sud"
 style="display:block;width:168px;height:auto;border:0;outline:none;color:{PORCELAINE};{POLICE}font-size:24px;font-weight:700;"></a>
<p style="margin:16px 0 0;{POLICE}font-size:12px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#aab6c8;">{bandeau}</p>
</td></tr>
<tr><td height="4" bgcolor="{COBALT}" style="background:{COBALT};font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td class="marge" bgcolor="#ffffff" style="background:#ffffff;border-radius:0 0 16px 16px;padding:34px 40px 36px;{POLICE}color:{NUIT};font-size:16px;line-height:1.55;">
{contenu}
</td></tr>
<tr><td class="marge" align="center" style="padding:22px 40px 0;{POLICE}font-size:12px;line-height:1.6;color:{DOUX};">{pied}</td></tr>
</table></td></tr></table></body></html>'''


def ligne_detail(libelle: str, valeur: str) -> str:
    return (f'<tr><td valign="top" style="padding:11px 12px 11px 0;border-top:1px solid {GLACIER};{POLICE}font-size:14px;color:{DOUX};width:38%;">{e(libelle)}</td>'
            f'<td valign="top" style="padding:11px 0;border-top:1px solid {GLACIER};{POLICE}font-size:15px;font-weight:600;color:{NUIT};">{e(valeur)}</td></tr>')


def gabarit(d: dict) -> tuple:
    """L'e-mail reçu par l'entreprise : qui, comment le joindre, ce qu'il demande. Le bouton d'appel d'abord."""
    origine = ORIGINES_DEMANDE.get(d.get('formulaire') or '', 'Demande depuis le site')
    rappel = d.get('rappel') is True
    contact = d['telephone'] or d['email'] or ''
    sujet = ('À rappeler — ' if rappel else '') + f"{origine} — {d['nom']}" + (f" — {contact}" if contact else '')
    recu = date_longue(d['recu_le'])
    details = [(l, v) for l, v in d.get('details') or []]
    note = d.get('note') if d.get('details') is not None else d['message']

    # version texte (messageries qui n'affichent pas le HTML)
    texte = '\n'.join([f'{origine} reçue le {recu}.', *(['Le client souhaite être rappelé.'] if rappel else []), '',
                       f"Nom : {d['nom']}", f"Téléphone : {d['telephone'] or 'non communiqué'}", f"E-mail : {d['email'] or 'non communiqué'}",
                       *[f'{l} : {v}' for l, v in details], '', 'Message :', note or '(pas de message)', '',
                       'Pour répondre par e-mail, utilisez le bouton « Répondre » : votre réponse part directement au client.' if d['email']
                       else 'Le client n’a pas laissé d’e-mail : rappelez-le au numéro indiqué.'])

    pastilles = pastille(e(origine), GLACIER, NUIT) + (pastille('À rappeler', COBALT, '#ffffff') if rappel else '')
    boutons = (bouton(f"tel:{e(tel_lien(d['telephone']))}", f"Appeler {e(d['nom'])}", e(d['telephone'])) if d['telephone'] else '') + \
              (bouton(f"mailto:{e(d['email'])}", 'Répondre par e-mail', e(d['email']), plein=not d['telephone']) if d['email'] else '')
    lignes = ''.join(ligne_detail(l, v) for l, v in [('Téléphone', d['telephone'] or 'non communiqué'),
                                                       ('E-mail', d['email'] or 'non communiqué'), *details])
    bloc_message = (f'<p style="margin:26px 0 8px;{POLICE}font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:{DOUX};">Son message</p>'
                    f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
                    f'<td bgcolor="{PORCELAINE}" style="background:{PORCELAINE};border-left:4px solid {COBALT};border-radius:4px 10px 10px 4px;'
                    f'padding:16px 18px;{POLICE}font-size:16px;line-height:1.6;color:{NUIT};white-space:pre-wrap;">{e(note)}</td></tr></table>') if note else ''
    conseil = ('Répondez simplement à cet e-mail : votre réponse part directement chez le client.' if d['email']
               else 'Ce client n’a pas laissé d’e-mail : rappelez-le au numéro ci-dessus.')
    contenu = (f'<div style="margin:0 0 14px;">{pastilles}</div>'
               f'<h1 class="titre" style="margin:0 0 6px;{POLICE}font-size:29px;line-height:1.2;font-weight:800;color:{NUIT};">{e(d["nom"])}</h1>'
               f'<p style="margin:0 0 24px;{POLICE}font-size:14px;color:{DOUX};">Reçue le {e(recu)}</p>'
               f'{boutons}'
               f'<p style="margin:26px 0 4px;{POLICE}font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:{DOUX};">Sa demande</p>'
               f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{lignes}</table>'
               f'{bloc_message}'
               f'<p style="margin:26px 0 0;padding-top:18px;border-top:1px solid {GLACIER};{POLICE}font-size:14px;color:{DOUX};">{conseil}</p>')
    pied = (f'Demande n° {e(d["id"])} · envoyée depuis le formulaire de <a href="{SITE_URL}/" style="color:{DOUX};">{e(SITE_URL.split("//")[-1])}</a>.<br>'
            f'Une copie de sécurité est gardée {CONSERVATION_JOURS} jours sur le serveur, puis effacée.')
    annonce = ' · '.join(x for x in [d['telephone'], ('à rappeler' if rappel else ''), (note or '')[:90]] if x)
    return sujet, texte, cadre(sujet, annonce, 'Nouvelle demande depuis le site', contenu, pied)


def prenom_sur(nom: str) -> str:
    """Le nom vient du visiteur : dans l'accusé de réception, on n'en garde qu'un mot sans adresse ni lien."""
    mot = (nom.split() or [''])[0][:30]
    return mot if re.fullmatch(r"[A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,30}", mot) else ''


def gabarit_accuse(d: dict) -> tuple:
    """L'accusé de réception envoyé au visiteur. Il ne recopie JAMAIS ce que le visiteur a écrit (seulement un prénom
    vérifié) : quelqu'un qui saisirait l'adresse d'un tiers ne peut pas se servir du site pour lui faire passer un texte."""
    prenom, rappel, simulateur = prenom_sur(d['nom']), d.get('rappel') is True, d.get('formulaire') == 'simulateur'
    sujet = f'Votre demande est bien arrivée — {ENTREPRISE}'
    salut = f'Bonjour {prenom},' if prenom else 'Bonjour,'
    quoi = 'votre estimation du simulateur' if simulateur else 'votre demande'
    retour = 'Nous vous rappelons, comme vous l’avez demandé.' if rappel else 'Nous vous répondons par téléphone ou par e-mail.'
    etapes = [('Nous étudions ' + quoi + '.', 'La puissance exacte et la pose se vérifient ensuite sur place.' if simulateur
               else 'Nous la lisons avec attention avant de vous répondre.'),
              (retour, 'Pensez à regarder vos courriers indésirables si vous attendez notre réponse par e-mail.'),
              ('Nous convenons ensemble de la suite.', 'Visite, devis, questions : nous voyons avec vous ce qu’il faut pour avancer.')]
    texte = '\n'.join([salut, '', f'{quoi[0].upper() + quoi[1:]} est bien arrivée chez {ENTREPRISE}. Merci de votre confiance.', '',
                       *[f'{i}. {t} {s}' for i, (t, s) in enumerate(etapes, 1)], '',
                       f'Une question d’ici là ? Appelez-nous au {TEL_ENTREPRISE}, ou répondez simplement à cet e-mail.', '',
                       f'{ENTREPRISE} — {SITE_URL}', MENTION_SOCIETE, '',
                       f'Vous recevez cet e-mail parce qu’une demande a été envoyée avec cette adresse sur {SITE_URL.split("//")[-1]}. '
                       'Si ce n’est pas vous, ignorez-le : vous ne recevrez rien d’autre.'])
    puces = ''.join(
        f'<tr><td valign="top" width="44" style="padding:0 14px 18px 0;"><div style="width:32px;height:32px;border-radius:999px;background:{GLACIER};'
        f'color:{COBALT};{POLICE}font-size:15px;font-weight:800;line-height:32px;text-align:center;">{i}</div></td>'
        f'<td valign="top" style="padding:4px 0 18px;{POLICE}"><p style="margin:0;font-size:16px;font-weight:700;color:{NUIT};">{e(t)}</p>'
        f'<p style="margin:3px 0 0;font-size:14px;line-height:1.55;color:{DOUX};">{e(s)}</p></td></tr>' for i, (t, s) in enumerate(etapes, 1))
    contenu = (f'<h1 class="titre" style="margin:0 0 14px;{POLICE}font-size:29px;line-height:1.2;font-weight:800;color:{NUIT};">{e(salut)}</h1>'
               f'<p style="margin:0 0 28px;font-size:17px;line-height:1.6;">{e(quoi[0].upper() + quoi[1:])} est bien arrivée chez {e(ENTREPRISE)}. '
               f'Merci de votre confiance.</p>'
               f'<p style="margin:0 0 14px;{POLICE}font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:{DOUX};">Et maintenant</p>'
               f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{puces}</table>'
               f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 0;"><tr>'
               f'<td bgcolor="{PORCELAINE}" style="background:{PORCELAINE};border-radius:12px;padding:22px 22px 12px;">'
               f'<p style="margin:0 0 14px;{POLICE}font-size:16px;font-weight:700;color:{NUIT};">Une question d’ici là ?</p>'
               f'{bouton("tel:" + tel_lien(TEL_ENTREPRISE), "Appeler " + e(ENTREPRISE), e(TEL_ENTREPRISE))}'
               f'<p style="margin:0 0 8px;{POLICE}font-size:14px;color:{DOUX};">Ou répondez simplement à cet e-mail.</p></td></tr></table>')
    pied = (f'<a href="{SITE_URL}/" style="color:{NUIT};font-weight:700;text-decoration:none;">{e(ENTREPRISE)}</a> · '
            f'<a href="{SITE_URL}/#simulateur" style="color:{DOUX};">Simulateur</a> · '
            f'<a href="{SITE_URL}/confidentialite/" style="color:{DOUX};">Vos données</a><br>{e(MENTION_SOCIETE)}<br><br>'
            f'Vous recevez cet e-mail parce qu’une demande a été envoyée avec cette adresse sur {e(SITE_URL.split("//")[-1])}. '
            f'Si ce n’est pas vous, ignorez-le : vous ne recevrez rien d’autre.')
    return sujet, texte, cadre(sujet, 'Nous avons bien reçu votre demande. ' + retour, 'Demande reçue', contenu, pied)


def appel_brevo(message: dict, essais: int = 2) -> tuple:
    if not CLE:
        return False, 'BREVO_API_KEY absente'
    erreur = 'erreur inconnue'
    for _ in range(essais):
        try:
            requete = urllib.request.Request(URL_BREVO, data=json.dumps(message).encode(), method='POST', headers={
                'api-key': CLE, 'content-type': 'application/json', 'accept': 'application/json'})
            with urllib.request.urlopen(requete, timeout=10) as r:
                if 200 <= r.status < 300:
                    return True, json.loads(r.read() or b'{}').get('messageId', '')
                erreur = f'HTTP {r.status}'
        except urllib.error.HTTPError as ex:
            erreur = f'HTTP {ex.code} {ex.read()[:200].decode("utf-8", "replace")}'
            if ex.code < 500:
                break  # clé refusée, expéditeur non validé… : réessayer ne changera rien
        except Exception as ex:  # réseau, délai dépassé
            erreur = f'{type(ex).__name__}: {ex}'
        time.sleep(1)
    return False, erreur


def envoyer_brevo(d: dict) -> tuple:
    sujet, texte, corps_html = gabarit(d)
    message = {'sender': {'email': EXPEDITEUR, 'name': NOM_EXPEDITEUR}, 'to': [{'email': DESTINATAIRE}],
               'subject': sujet, 'textContent': texte, 'htmlContent': corps_html, 'tags': [f'formulaire-{SLUG}']}
    if COPIE:
        message['bcc'] = [{'email': COPIE}]
    if d['email']:
        message['replyTo'] = {'email': d['email'], 'name': d['nom']}
    return appel_brevo(message)


_accuses: dict = {}


def envoyer_accuse(d: dict) -> tuple:
    """Une seule tentative (jamais de doublon chez le visiteur), 2 accusés au plus par adresse et par 24 h."""
    if not ACCUSE or not d['email']:
        return False, 'sans objet'
    maintenant = time.time()
    with _verrou:
        recents = [t for t in _accuses.get(d['email'], []) if maintenant - t < 86400]
        if len(recents) >= 2:
            return False, 'limite par adresse'
        _accuses[d['email']] = recents + [maintenant]
    sujet, texte, corps_html = gabarit_accuse(d)
    return appel_brevo({'sender': {'email': EXPEDITEUR, 'name': ENTREPRISE}, 'to': [{'email': d['email']}],
                        'replyTo': {'email': DESTINATAIRE, 'name': ENTREPRISE}, 'subject': sujet, 'textContent': texte,
                        'htmlContent': corps_html, 'tags': [f'accuse-{SLUG}']}, essais=1)


def traiter_fichier(f: Path) -> bool:
    d = json.loads(f.read_text(encoding='utf-8'))
    ok, info = envoyer_brevo(d)
    if ok:
        journal('envoyee', id=d['id'], brevo=info)
        if 'accuse' not in d:  # l'accusé ne part qu'une fois, et seulement quand l'entreprise a bien reçu la demande
            ok_a, info_a = envoyer_accuse(d)
            d['accuse'] = 'envoye' if ok_a else info_a
            if ok_a or info_a not in ('sans objet',):
                journal('accuse', id=d['id'], resultat=d['accuse'])
            f.write_text(json.dumps(d, ensure_ascii=False), encoding='utf-8')
        ENVOYEES.mkdir(parents=True, exist_ok=True)
        f.replace(ENVOYEES / f.name)
    else:
        journal('envoi-en-echec', id=d['id'], erreur=info, recu_le=d['recu_le'])
    return ok


def lister_suspects() -> list:
    sortie = []
    for f in sorted(SUSPECTS.glob('*.json')) if SUSPECTS.exists() else []:
        try:
            sortie.append((f, json.loads(f.read_text(encoding='utf-8'))))
        except Exception:
            continue
    return sortie


def resume_suspects() -> bool:
    """Un seul e-mail par jour, sobre : de quoi retrouver un vrai client mal classé, sans bouton ni lien."""
    a_dire = [(f, d) for f, d in lister_suspects() if not d.get('resume_envoye')]
    marque = DOSSIER / 'dernier-resume'
    if not a_dire or (marque.exists() and time.time() - marque.stat().st_mtime < 86400):
        return True
    lignes = []
    for _, d in a_dire:
        lignes.append(f"- {date_longue(d['recu_le'])} · {d['nom']} · {d['telephone'] or 'sans téléphone'} · {d['email'] or 'sans e-mail'}"
                      f"\n  Pourquoi : {' ; '.join(d['raisons'])}\n  Message : {d['message'][:220]}{'…' if len(d['message']) > 220 else ''}\n  Numéro : {d['id']}")
    texte = (f"{len(a_dire)} demande(s) envoyée(s) depuis le site ont été mises de côté, car elles ressemblent à du courrier indésirable. "
             "Aucune n'a été transmise.\n\n" + '\n\n'.join(lignes) +
             "\n\nSi l'une est une vraie demande, demandez à votre prestataire de la libérer (numéro ci-dessus). "
             "Les demandes mises de côté sont effacées au bout de " + str(CONSERVATION_SUSPECTS_JOURS) + " jours.")
    corps_html = '<pre style="font:14px/1.5 Arial,sans-serif;white-space:pre-wrap;">' + e(texte) + '</pre>'
    ok, info = appel_brevo({'sender': {'email': EXPEDITEUR, 'name': NOM_EXPEDITEUR}, 'to': [{'email': DESTINATAIRE}],
                            'subject': f'{len(a_dire)} demande(s) douteuse(s) mise(s) de côté', 'textContent': texte,
                            'htmlContent': corps_html, 'tags': [f'suspects-{SLUG}']}, essais=1)
    if not ok:
        journal('resume-suspects-echec', erreur=info)
        return False
    for f, d in a_dire:
        d['resume_envoye'] = True
        f.write_text(json.dumps(d, ensure_ascii=False), encoding='utf-8')
    marque.write_text(datetime.now(timezone.utc).isoformat(), encoding='utf-8')
    journal('resume-suspects', nombre=len(a_dire))
    return True


def liberer(identifiant: str) -> int:
    for f, d in lister_suspects():
        if d['id'] == identifiant:
            for k in ('score', 'raisons', 'resume_envoye'):
                d.pop(k, None)
            FILE.mkdir(parents=True, exist_ok=True)
            cible = FILE / f.name
            cible.write_text(json.dumps(d, ensure_ascii=False), encoding='utf-8')
            os.chmod(cible, 0o600)
            f.unlink()
            ok = traiter_fichier(cible)
            print('envoyée' if ok else 'enregistrée, l\'envoi réessaiera dans 5 minutes')
            return 0
    print('numéro inconnu : voir --suspects')
    return 1


def relancer() -> int:
    """Minuteur : renvoie la file, purge les copies anciennes. Code de sortie 1 si une demande attend depuis plus d'1 h."""
    vieille = False
    for f in sorted(FILE.glob('*.json')):
        if time.time() - f.stat().st_mtime < 60:
            continue
        if not traiter_fichier(f) and time.time() - f.stat().st_mtime > 3600:
            vieille = True
    for f in ENVOYEES.glob('*.json') if ENVOYEES.exists() else []:
        if time.time() - f.stat().st_mtime > CONSERVATION_JOURS * 86400:
            f.unlink()
    for f in SUSPECTS.glob('*.json') if SUSPECTS.exists() else []:
        if time.time() - f.stat().st_mtime > CONSERVATION_SUSPECTS_JOURS * 86400:
            f.unlink()
    resume_suspects()
    return 1 if vieille else 0


# ---------------------------------------------------------------- serveur HTTP
class Gestionnaire(BaseHTTPRequestHandler):
    server_version = 'relais'
    sys_version = ''

    def log_message(self, *args):  # pas de journal d'accès : aucune IP conservée
        pass

    def repondre(self, statut: int, donnees: dict, **entetes) -> None:
        corps = json.dumps(donnees, ensure_ascii=False).encode()
        self.send_response(statut)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('cache-control', 'no-store')
        for k, v in entetes.items():
            self.send_header(k.replace('_', '-'), v)
        self.send_header('content-length', str(len(corps)))
        self.end_headers()
        self.wfile.write(corps)

    def do_GET(self):
        if self.path.split('?')[0] == '/sante':
            return self.repondre(200, {'ok': True, 'en_attente': len(list(FILE.glob('*.json'))), 'suspects': len(list(SUSPECTS.glob('*.json'))) if SUSPECTS.exists() else 0})
        self.repondre(404, {'ok': False, 'erreurs': ['Ressource inconnue.']})

    def do_POST(self):
        m = re.fullmatch(r'/f/([a-z0-9]+(?:-[a-z0-9]+)*)/?', self.path.split('?')[0])
        if not m or m.group(1) != SLUG:
            return self.repondre(404, {'ok': False, 'erreurs': ['Identifiant de site invalide.']})
        # Un navigateur envoie toujours l'origine (ou au moins la page d'où part le formulaire) ; un robot qui poste
        # directement n'a aucune raison de le faire.
        origine = self.headers.get('origin')
        if not origine and self.headers.get('referer'):
            r = urllib.parse.urlsplit(self.headers.get('referer'))
            origine = f'{r.scheme}://{r.netloc}' if r.scheme and r.netloc else None
        if not origine or origine not in ORIGINES:
            journal('rejet', motif='origine-refusee')
            return self.repondre(403, {'ok': False, 'erreurs': ['Origine non autorisée.']})
        longueur = int(self.headers.get('content-length') or 0)
        if longueur <= 0 or longueur > TAILLE_MAX:
            return self.repondre(400, {'ok': False, 'erreurs': ['Votre demande n’a pas pu être lue. Merci de réessayer.']})
        brut = self.rfile.read(longueur)
        try:
            if 'application/json' in (self.headers.get('content-type') or ''):
                champs = json.loads(brut.decode('utf-8'))
                if not isinstance(champs, dict):
                    raise ValueError
            else:
                champs = {k: v[0] for k, v in urllib.parse.parse_qs(brut.decode('utf-8')).items()}
        except Exception:
            return self.repondre(400, {'ok': False, 'erreurs': ['Votre demande n’a pas pu être lue. Merci de réessayer.']})
        if nettoyer(champs.get('site_web')):
            journal('rejet', motif='champ-piege')
            return self.repondre(200, {'ok': True})
        try:
            rendu_ms = int(nettoyer(champs.get('_ts')))
            if 0 <= time.time() * 1000 - rendu_ms < DELAI_MINIMAL_S * 1000:
                journal('rejet', motif='trop-rapide')
                return self.repondre(200, {'ok': True})
        except ValueError:
            pass
        ip = (self.headers.get('x-forwarded-for') or self.client_address[0]).split(',')[0].strip()
        maintenant = time.time()
        with _verrou:
            recents = [t for t in _compteurs.get(ip, []) if maintenant - t < FENETRE_S]
            if len(recents) >= LIMITE:
                journal('rejet', motif='limite-debit')
                attente = int(FENETRE_S - (maintenant - recents[0])) + 1
                return self.repondre(429, {'ok': False, 'erreurs': ['Trop de demandes envoyées depuis cet appareil. Merci de réessayer dans quelques minutes, ou d’appeler directement l’entreprise.']}, retry_after=str(attente))
            _compteurs[ip] = recents + [maintenant]
        erreurs, d = valider(champs)
        if erreurs:
            return self.repondre(422, {'ok': False, 'erreurs': erreurs})
        d.update(id=uuid.uuid4().hex[:16], recu_le=datetime.now(timezone.utc).isoformat(timespec='seconds'), slug=SLUG)
        points, raisons = evaluer(d, maintenant)
        suspect = points >= SEUIL_SUSPECT
        dossier = SUSPECTS if suspect else FILE
        if suspect:
            d.update(score=points, raisons=raisons)
        else:
            with _verrou:
                _recentes.append(maintenant)
        dossier.mkdir(parents=True, exist_ok=True)
        tmp = dossier / f".{d['id']}.tmp"
        tmp.write_text(json.dumps(d, ensure_ascii=False), encoding='utf-8')
        os.chmod(tmp, 0o600)
        f = tmp.replace(dossier / f"{d['recu_le'][:19].replace(':', '')}-{d['id']}.json")
        if suspect:
            journal('suspecte', id=d['id'], points=points, nombre_de_raisons=len(raisons))
            return self.repondre(200, {'ok': True})   # même réponse qu'une vraie demande : un robot ne doit rien apprendre
        journal('demande', id=d['id'])
        # La demande est enregistrée : elle ne peut plus être perdue. L'e-mail part dans la foulée ;
        # s'il échoue, le minuteur le renverra.
        threading.Thread(target=traiter_fichier, args=(f,), daemon=True).start()
        self.repondre(200, {'ok': True})


if __name__ == '__main__':
    os.umask(0o077)
    if '--relancer' in sys.argv:
        sys.exit(relancer())
    if '--suspects' in sys.argv:
        for _, d in lister_suspects():
            print(f"{d['id']}  {d['recu_le']}  {d['nom']}  {d['telephone'] or '-'}  {d['email'] or '-'}  [{d['score']} pts : {' ; '.join(d['raisons'])}]")
        sys.exit(0)
    if '--liberer' in sys.argv:
        sys.exit(liberer(sys.argv[sys.argv.index('--liberer') + 1] if len(sys.argv) > sys.argv.index('--liberer') + 1 else ''))
    if not CLE:
        journal('attention', message='BREVO_API_KEY absente : les demandes sont enregistrées mais aucun e-mail ne part')
    serveur = ThreadingHTTPServer(('127.0.0.1', PORT), Gestionnaire)
    journal('demarrage', port=PORT, slug=SLUG, destinataire=DESTINATAIRE)
    serveur.serve_forever()
