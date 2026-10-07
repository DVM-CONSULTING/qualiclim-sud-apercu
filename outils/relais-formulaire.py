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
  - le message d'un visiteur n'est jamais interprété : texte brut, HTML échappé.

Configuration par variables d'environnement (fichier /etc/qualiclim-relais.env, lisible par root seulement) :
  BREVO_API_KEY (obligatoire), DESTINATAIRE, EXPEDITEUR, NOM_EXPEDITEUR, COPIE (facultatif), SLUG,
  ENTREPRISE, ORIGINES (séparées par des espaces), PORT. Aucune dépendance : bibliothèque standard de Python 3.
"""
import html
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
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
ORIGINES = set(os.environ.get('ORIGINES', 'https://qualiclimsud.fr https://www.qualiclimsud.fr').split())
PORT = int(os.environ.get('PORT', '8787'))
DOSSIER = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/qualiclim-relais'))
FILE, ENVOYEES = DOSSIER / 'a-envoyer', DOSSIER / 'envoyees'
TAILLE_MAX = 64 * 1024
DELAI_MINIMAL_S, LIMITE, FENETRE_S = 3, 5, 600
CONSERVATION_JOURS = 90  # copie de sécurité ; la demande vit ensuite dans la messagerie du client
PARIS = ZoneInfo('Europe/Paris')

_compteurs: dict = {}
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
    return erreurs, {'nom': nom, 'telephone': tel or None, 'email': mail or None, 'message': msg}


# ---------------------------------------------------------------- e-mail Brevo
def gabarit(d: dict) -> tuple:
    contact = d['telephone'] or d['email'] or ''
    sujet = f"Nouvelle demande — {d['nom']}" + (f" — {contact}" if contact else '')
    recu = datetime.fromisoformat(d['recu_le']).astimezone(PARIS).strftime('%d/%m/%Y à %H:%M')
    lignes = [f"Nom : {d['nom']}", f"Téléphone : {d['telephone'] or 'non communiqué'}",
              f"Email : {d['email'] or 'non communiqué'}", f"Reçu le : {recu}", '', 'Message :', d['message']]
    texte = '\n'.join(['Vous avez reçu une nouvelle demande depuis votre site internet.', '', *lignes, '',
                       'Pour répondre, utilisez simplement le bouton « Répondre » de votre messagerie :',
                       'votre réponse partira directement au client.'])
    e = html.escape
    bouton_tel = (f'<p style="margin:18px 0;"><a href="tel:{e(d["telephone"].replace(" ", ""))}" style="display:inline-block;'
                  f'background:#0e1d33;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:8px;font-weight:700;'
                  f'font-size:18px;">Appeler {e(d["nom"])} — {e(d["telephone"])}</a></p>') if d['telephone'] else ''
    bouton_mail = (f'<p style="margin:12px 0;"><a href="mailto:{e(d["email"])}" style="color:#2a5fae;font-weight:600;">'
                   f'Écrire à {e(d["email"])}</a></p>') if d['email'] else ''
    ligne = lambda t, v, g=True: (f'<tr><td style="padding:6px 0;color:#52525b;width:110px;">{t}</td>'
                                  f'<td style="padding:6px 0;{"font-weight:600;" if g else ""}">{e(v)}</td></tr>')
    corps_html = (f'<!doctype html><html lang="fr"><body style="margin:0;padding:24px;background:#f4f2ee;font-family:Arial,sans-serif;color:#0e1d33;">'
                  f'<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px;">'
                  f'<p style="margin:0 0 4px;font-size:15px;color:#52525b;">{e(ENTREPRISE)}</p>'
                  f'<h1 style="margin:0 0 16px;font-size:22px;">Nouvelle demande depuis votre site</h1>'
                  f'<table style="width:100%;border-collapse:collapse;font-size:17px;">'
                  f'{ligne("Nom", d["nom"])}{ligne("Téléphone", d["telephone"] or "non communiqué")}'
                  f'{ligne("Email", d["email"] or "non communiqué")}{ligne("Reçu le", recu, False)}</table>'
                  f'{bouton_tel}{bouton_mail}<p style="margin:18px 0 6px;color:#52525b;font-size:15px;">Message</p>'
                  f'<div style="padding:14px;background:#f4f4f5;border-radius:8px;white-space:pre-wrap;">{e(d["message"])}</div>'
                  f'<p style="margin:20px 0 0;font-size:14px;color:#71717a;">Vous pouvez répondre directement à cet email : '
                  f'votre réponse arrivera au client.</p></div></body></html>')
    return sujet, texte, corps_html


def envoyer_brevo(d: dict) -> tuple:
    if not CLE:
        return False, 'BREVO_API_KEY absente'
    sujet, texte, corps_html = gabarit(d)
    message = {'sender': {'email': EXPEDITEUR, 'name': NOM_EXPEDITEUR}, 'to': [{'email': DESTINATAIRE}],
               'subject': sujet, 'textContent': texte, 'htmlContent': corps_html, 'tags': [f'formulaire-{SLUG}']}
    if COPIE:
        message['bcc'] = [{'email': COPIE}]
    if d['email']:
        message['replyTo'] = {'email': d['email'], 'name': d['nom']}
    erreur = 'erreur inconnue'
    for _ in range(2):
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


def traiter_fichier(f: Path) -> bool:
    d = json.loads(f.read_text(encoding='utf-8'))
    ok, info = envoyer_brevo(d)
    if ok:
        ENVOYEES.mkdir(parents=True, exist_ok=True)
        f.replace(ENVOYEES / f.name)
        journal('envoyee', id=d['id'], brevo=info)
    else:
        journal('envoi-en-echec', id=d['id'], erreur=info, recu_le=d['recu_le'])
    return ok


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
            return self.repondre(200, {'ok': True, 'en_attente': len(list(FILE.glob('*.json')))})
        self.repondre(404, {'ok': False, 'erreurs': ['Ressource inconnue.']})

    def do_POST(self):
        m = re.fullmatch(r'/f/([a-z0-9]+(?:-[a-z0-9]+)*)/?', self.path.split('?')[0])
        if not m or m.group(1) != SLUG:
            return self.repondre(404, {'ok': False, 'erreurs': ['Identifiant de site invalide.']})
        origine = self.headers.get('origin')
        if origine and origine not in ORIGINES:
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
        FILE.mkdir(parents=True, exist_ok=True)
        tmp = FILE / f".{d['id']}.tmp"
        tmp.write_text(json.dumps(d, ensure_ascii=False), encoding='utf-8')
        os.chmod(tmp, 0o600)
        f = tmp.replace(FILE / f"{d['recu_le'][:19].replace(':', '')}-{d['id']}.json")
        journal('demande', id=d['id'])
        # La demande est enregistrée : elle ne peut plus être perdue. L'e-mail part dans la foulée ;
        # s'il échoue, le minuteur le renverra.
        threading.Thread(target=traiter_fichier, args=(f,), daemon=True).start()
        self.repondre(200, {'ok': True})


if __name__ == '__main__':
    os.umask(0o077)
    if '--relancer' in sys.argv:
        sys.exit(relancer())
    if not CLE:
        journal('attention', message='BREVO_API_KEY absente : les demandes sont enregistrées mais aucun e-mail ne part')
    serveur = ThreadingHTTPServer(('127.0.0.1', PORT), Gestionnaire)
    journal('demarrage', port=PORT, slug=SLUG, destinataire=DESTINATAIRE)
    serveur.serve_forever()
