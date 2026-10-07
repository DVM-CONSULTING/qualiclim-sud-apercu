#!/usr/bin/env bash
# Qualiclim Sud — installation du site sur un serveur VPS (Debian ou Ubuntu), en une commande :
#
#   curl -fsSL https://raw.githubusercontent.com/DVM-CONSULTING/qualiclim-sud-apercu/main/outils/installer-vps.sh | sudo bash
#
# Ce que fait ce script (on peut le relancer sans risque, il reprend où il en est) :
#   1. vérifie que le domaine pointe bien vers ce serveur (sinon il s'arrête et dit quoi corriger chez OVH) ;
#   2. si Caddy sert déjà d'autres sites : ajoute celui-ci à côté (HTTPS automatique) ; sinon installe nginx et certbot ;
#      ne touche jamais aux autres sites, et remet l'ancienne configuration si la nouvelle est refusée ;
#   3. récupère le site depuis GitHub dans /var/www/qualiclimsud ;
#   4. obtient le certificat HTTPS gratuit (Let's Encrypt), renouvelé automatiquement ;
#   5. pose la configuration fabriquée avec le site (en-têtes de sécurité, page 404, www → sans www) ;
#   6. en mode aperçu : protège le site par un mot de passe, affiché une seule fois à la fin ;
#   7. installe le relais du formulaire (envoi par Brevo) : la clé API est demandée ici, sur le serveur, et n'est
#      gardée que dans /etc/qualiclim-relais.env (lisible par root seulement) ;
#   8. met le site à jour tout seul toutes les 5 minutes depuis GitHub (les fichiers du site, jamais la configuration).
set -euo pipefail

DOMAINE="qualiclimsud.fr"
DEPOT="https://github.com/DVM-CONSULTING/qualiclim-sud-apercu.git"
BRANCHE="main"
RACINE="/var/www/qualiclimsud"
ACME="/var/www/acme-qualiclimsud"
CONF="/etc/nginx/sites-available/${DOMAINE}"
MDP="/etc/nginx/qualiclimsud.htpasswd"
CONTACT="contact@${DOMAINE}"
# serveur sans IPv6 : nginx refuserait les lignes « listen [::] », on les retire
sans_ipv6() { if [ ! -s /proc/net/if_inet6 ]; then sed -i '/listen \[::\]/d' "$1"; fi; }

etape() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
stop()  { printf '\n\033[31m✖ %s\033[0m\n' "$1" >&2; exit 1; }
ok()    { printf '  ✔ %s\n' "$1"; }

[ "$(id -u)" -eq 0 ] || stop "Lance la commande avec sudo."
command -v apt-get >/dev/null || stop "Ce script est prévu pour Debian ou Ubuntu. Envoie ce message à Claude."

etape "1/8 — Le domaine pointe-t-il vers ce serveur ?"
command -v curl >/dev/null || { apt-get update -q && apt-get install -y -q curl; }
IP4=$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)
IP6=$(curl -6 -fsS --max-time 10 https://api64.ipify.org || true)
A_DOM=$(getent ahostsv4 "$DOMAINE" | awk 'NR==1{print $1}' || true)
A_WWW=$(getent ahostsv4 "www.$DOMAINE" | awk 'NR==1{print $1}' || true)
AAAA_DOM=$(getent ahostsv6 "$DOMAINE" | awk '$1 ~ /:/ && $1 !~ /^::ffff:/ {print $1; exit}' || true)
echo "  Adresse de ce serveur : ${IP4:-inconnue}${IP6:+ / $IP6}"
echo "  ${DOMAINE} → ${A_DOM:-rien} ${AAAA_DOM:+/ $AAAA_DOM} ; www.${DOMAINE} → ${A_WWW:-rien}"
PB=""
if [ -n "$IP4" ] && [ "$A_DOM" != "$IP4" ]; then PB+=$'\n'"  - chez OVH, zone DNS : enregistrement A de ${DOMAINE} → ${IP4}"; fi
if [ -n "$IP4" ] && [ "$A_WWW" != "$IP4" ]; then PB+=$'\n'"  - chez OVH, zone DNS : www.${DOMAINE} → ${IP4} (enregistrement A, ou CNAME vers ${DOMAINE}.)"; fi
if [ -n "$AAAA_DOM" ] && [ "$AAAA_DOM" != "$IP6" ]; then PB+=$'\n'"  - chez OVH, zone DNS : supprimer l'enregistrement AAAA de ${DOMAINE} (${AAAA_DOM}) et celui de www s'il existe"; fi
if [ -z "$IP4" ]; then stop "Impossible de connaître l'adresse de ce serveur (accès internet ?). Envoie ce message à Claude."; fi
if [ -n "$PB" ]; then stop "Le domaine ne pointe pas encore vers ce serveur. À faire :${PB}"$'\n'"  Puis attendre 15 à 60 minutes et relancer la même commande."; fi
ok "le domaine pointe bien ici"

etape "2/8 — Logiciels nécessaires"
for s in apache2 httpd; do
  if systemctl is-active --quiet "$s" 2>/dev/null; then stop "$s fonctionne déjà sur ce serveur : je ne l'installe pas par-dessus. Envoie ce message à Claude."; fi
done
SERVEUR="nginx"
if systemctl is-active --quiet caddy 2>/dev/null; then
  # Caddy sert déjà d'autres sites : on ajoute celui-ci à côté, sans toucher aux autres
  [ -f /etc/caddy/Caddyfile ] || stop "Caddy fonctionne mais sans /etc/caddy/Caddyfile. Envoie ce message à Claude."
  SERVEUR="caddy"
elif ss -ltnp 2>/dev/null | grep -E ':(80|443) ' | grep -vq nginx; then
  stop "Un autre programme occupe déjà le port 80 ou 443. Envoie ce message à Claude : $(ss -ltnp 2>/dev/null | grep -E ':(80|443) ' | tr '\n' ' ')"
fi
MANQUE=""
command -v git >/dev/null || MANQUE="$MANQUE git"
command -v openssl >/dev/null || MANQUE="$MANQUE openssl"
if [ "$SERVEUR" = "nginx" ]; then
  command -v nginx >/dev/null || MANQUE="$MANQUE nginx"
  command -v certbot >/dev/null || MANQUE="$MANQUE certbot"
fi
if [ -n "$MANQUE" ]; then apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q $MANQUE; fi
if [ "$SERVEUR" = "nginx" ]; then systemctl enable --now nginx >/dev/null 2>&1 || true; fi
ok "serveur web : $SERVEUR ; git présent"

etape "3/8 — Récupération du site"
if [ -d "$RACINE/.git" ]; then
  git -C "$RACINE" fetch -q origin "$BRANCHE" && git -C "$RACINE" reset -q --hard "origin/$BRANCHE"
else
  rm -rf "$RACINE"; git clone -q --depth 1 --branch "$BRANCHE" "$DEPOT" "$RACINE"
fi
chmod -R a+rX "$RACINE"
[ -f "$RACINE/index.html" ] && [ -f "$RACINE/outils/nginx-qualiclimsud.conf" ] && [ -f "$RACINE/outils/caddy-qualiclimsud.caddy" ] || stop "Le site récupéré est incomplet. Envoie ce message à Claude."
ok "site dans $RACINE (version $(git -C "$RACINE" log -1 --format=%h))"

NOUVEAU_MDP=""
nouveau_mdp() { openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16; }

if [ "$SERVEUR" = "caddy" ]; then
  etape "4/8 — Certificat HTTPS"
  ok "Caddy obtient et renouvelle le certificat tout seul"

  etape "5/8 — Configuration du site (Caddy)"
  CCONF="/etc/caddy/qualiclimsud.caddy"
  ANCIEN_HASH=""
  if [ -f "$CCONF" ]; then ANCIEN_HASH=$(awk '$1=="qualiclim"{print $2; exit}' "$CCONF" || true); fi
  SAUVE_F=$(mktemp); cp /etc/caddy/Caddyfile "$SAUVE_F"
  SAUVE_C=$(mktemp); if [ -f "$CCONF" ]; then cp "$CCONF" "$SAUVE_C"; else : > "$SAUVE_C"; fi
  cp "$RACINE/outils/caddy-qualiclimsud.caddy" "$CCONF"

  etape "6/8 — Mot de passe de l'aperçu"
  if grep -q "__EMPREINTE_MOT_DE_PASSE__" "$CCONF"; then
    HASH="$ANCIEN_HASH"
    if [ -z "$HASH" ]; then NOUVEAU_MDP=$(nouveau_mdp); HASH=$(caddy hash-password --plaintext "$NOUVEAU_MDP"); fi
    sed -i "s|__EMPREINTE_MOT_DE_PASSE__|${HASH}|" "$CCONF"
    ok "aperçu protégé (identifiant : qualiclim)"
  else
    ok "site public (mode production) : pas de mot de passe"
  fi
  grep -q "^import $CCONF" /etc/caddy/Caddyfile || printf '\n# Site Qualiclim Sud (outils/installer-vps.sh)\nimport %s\n' "$CCONF" >> /etc/caddy/Caddyfile
  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    cp "$SAUVE_F" /etc/caddy/Caddyfile
    if [ -s "$SAUVE_C" ]; then cp "$SAUVE_C" "$CCONF"; else rm -f "$CCONF"; fi
    stop "Caddy refuse la configuration : l'ancienne a été remise, les autres sites ne sont pas touchés. Envoie ce message à Claude."
  fi
  systemctl reload caddy
  ok "Caddy rechargé (les autres sites continuent de fonctionner)"
else
  etape "4/8 — Certificat HTTPS"
  mkdir -p "$ACME"
  if [ ! -f "/etc/letsencrypt/live/${DOMAINE}/fullchain.pem" ]; then
    # configuration provisoire : seulement de quoi prouver à Let's Encrypt que le domaine est ici
    printf 'server {\n    listen 80;\n    listen [::]:80;\n    server_name %s www.%s;\n    location ^~ /.well-known/acme-challenge/ { root %s; default_type text/plain; }\n    location / { return 503; }\n}\n' "$DOMAINE" "$DOMAINE" "$ACME" > "$CONF"
    sans_ipv6 "$CONF"
    ln -sf "$CONF" "/etc/nginx/sites-enabled/${DOMAINE}"
    nginx -t -q || { rm -f "/etc/nginx/sites-enabled/${DOMAINE}"; stop "nginx refuse la configuration provisoire (rien n'a été changé pour les autres sites). Envoie ce message à Claude."; }
    systemctl reload nginx
    certbot certonly --webroot -w "$ACME" -d "$DOMAINE" -d "www.$DOMAINE" --non-interactive --agree-tos -m "$CONTACT" --deploy-hook "systemctl reload nginx" \
      || stop "Let's Encrypt n'a pas pu délivrer le certificat (souvent : DNS pas encore à jour). Attends 30 minutes et relance la même commande."
  fi
  ok "certificat valable (renouvelé automatiquement par certbot)"

  etape "5/8 — Configuration du site (nginx)"
  SAUVE=""
  if [ -f "$CONF" ]; then SAUVE=$(mktemp); cp "$CONF" "$SAUVE"; fi
  cp "$RACINE/outils/nginx-qualiclimsud.conf" "$CONF"
  sans_ipv6 "$CONF"
  ln -sf "$CONF" "/etc/nginx/sites-enabled/${DOMAINE}"

  etape "6/8 — Mot de passe de l'aperçu"
  if grep -q "auth_basic_user_file" "$CONF"; then
    if [ ! -s "$MDP" ]; then
      NOUVEAU_MDP=$(nouveau_mdp)
      printf 'qualiclim:%s\n' "$(openssl passwd -apr1 "$NOUVEAU_MDP")" > "$MDP"
      chown root:www-data "$MDP" 2>/dev/null || true; chmod 640 "$MDP"
    fi
    ok "aperçu protégé (identifiant : qualiclim)"
  else
    ok "site public (mode production) : pas de mot de passe"
  fi
  if ! nginx -t -q; then
    if [ -n "$SAUVE" ]; then cp "$SAUVE" "$CONF"; else rm -f "/etc/nginx/sites-enabled/${DOMAINE}"; fi
    stop "nginx refuse la configuration du site : l'ancienne a été remise, les autres sites ne sont pas touchés. Envoie ce message à Claude."
  fi
  systemctl reload nginx
  ok "nginx rechargé"
fi

etape "7/8 — Relais du formulaire (envoi par Brevo)"
RENV="/etc/qualiclim-relais.env"
install -d -m 755 /usr/local/lib/qualiclim
install -m 755 "$RACINE/outils/relais-formulaire.py" /usr/local/lib/qualiclim/relais-formulaire.py
if [ ! -s "$RENV" ]; then
  CLE_BREVO=""; DEST="contact@${DOMAINE}"; COPIE_A=""
  if { : < /dev/tty; } 2>/dev/null; then
    printf '  Clé API Brevo (Brevo › SMTP & API › Clés API). Elle ne s’affiche pas pendant la saisie ; Entrée seule pour passer : ' > /dev/tty
    read -r -s CLE_BREVO < /dev/tty || true; echo > /dev/tty
    printf '  Adresse qui reçoit les demandes [%s] : ' "$DEST" > /dev/tty
    read -r REPONSE < /dev/tty || true
    if [ -n "${REPONSE:-}" ]; then DEST="$REPONSE"; fi
    printf '  Copie cachée à l’agence (facultatif, Entrée pour aucune) : ' > /dev/tty
    read -r COPIE_A < /dev/tty || true
  fi
  case "$DEST" in *@*.*) ;; *) stop "Adresse de réception invalide : $DEST" ;; esac
  if [ -n "$CLE_BREVO" ]; then
    ( umask 077
      printf 'BREVO_API_KEY=%s\nDESTINATAIRE=%s\nEXPEDITEUR=formulaire@%s\nNOM_EXPEDITEUR=Site Qualiclim Sud\nCOPIE=%s\nSLUG=qualiclim-sud\nENTREPRISE=Qualiclim Sud\nORIGINES=https://%s https://www.%s\n' \
        "$CLE_BREVO" "$DEST" "$DOMAINE" "$COPIE_A" "$DOMAINE" "$DOMAINE" > "$RENV" )
    chmod 600 "$RENV"
  fi
fi
if [ -s "$RENV" ]; then
  id qualiclim-relais >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin qualiclim-relais
  cat > /etc/systemd/system/qualiclim-relais.service <<'UNITE'
[Unit]
Description=Relais du formulaire Qualiclim Sud (envoi par Brevo)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 -I /usr/local/lib/qualiclim/relais-formulaire.py
EnvironmentFile=/etc/qualiclim-relais.env
User=qualiclim-relais
StateDirectory=qualiclim-relais
StateDirectoryMode=0700
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
UNITE
  cat > /etc/systemd/system/qualiclim-relais-relance.service <<'UNITE'
[Unit]
Description=Relais Qualiclim Sud : renvoi des demandes en attente

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -I /usr/local/lib/qualiclim/relais-formulaire.py --relancer
EnvironmentFile=/etc/qualiclim-relais.env
User=qualiclim-relais
StateDirectory=qualiclim-relais
StateDirectoryMode=0700
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
UNITE
  cat > /etc/systemd/system/qualiclim-relais-relance.timer <<'UNITE'
[Unit]
Description=Relais Qualiclim Sud : renvoi toutes les 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNITE
  systemctl daemon-reload
  systemctl enable -q --now qualiclim-relais.service qualiclim-relais-relance.timer
  systemctl restart qualiclim-relais.service
  SANTE=""
  for _ in 1 2 3 4 5; do SANTE=$(curl -s --max-time 3 http://127.0.0.1:8787/sante || true); [ -n "$SANTE" ] && break; sleep 1; done
  case "$SANTE" in *'"ok": true'*) ok "relais en service ($(grep '^DESTINATAIRE=' "$RENV" | cut -d= -f2) recevra les demandes)" ;;
    *) stop "Le relais ne démarre pas. Envoie à Claude le résultat de : sudo journalctl -u qualiclim-relais -n 30 --no-pager" ;; esac
else
  ok "relais non installé (pas de clé Brevo) : relance la même commande quand tu l'auras, le reste du site fonctionne"
fi

etape "8/8 — Mise à jour automatique"
cat > /usr/local/bin/qualiclim-maj <<EOF
#!/usr/bin/env bash
# Met à jour les fichiers du site Qualiclim Sud depuis GitHub (jamais la configuration du serveur web).
set -e
cd "$RACINE"
git fetch -q origin "$BRANCHE"
if [ "\$(git rev-parse HEAD)" != "\$(git rev-parse origin/$BRANCHE)" ]; then git reset -q --hard "origin/$BRANCHE"; chmod -R a+rX "$RACINE"; fi
EOF
chmod 755 /usr/local/bin/qualiclim-maj
echo "*/5 * * * * root /usr/local/bin/qualiclim-maj >/dev/null 2>&1" > /etc/cron.d/qualiclim-maj
ok "le site se met à jour tout seul toutes les 5 minutes"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://${DOMAINE}/" || true)
printf '\n\033[32m✔ Terminé.\033[0m https://%s répond (%s : 401 = protégé par mot de passe, 200 = public).\n' "$DOMAINE" "$CODE"
if [ -n "$NOUVEAU_MDP" ]; then
  printf '\n  Accès à l’aperçu — identifiant : qualiclim — mot de passe : \033[1m%s\033[0m\n' "$NOUVEAU_MDP"
  printf '  Note-le maintenant (il ne sera plus affiché) et enregistre-le dans l’Arrière-boutique :\n  Connexions › Aperçu protégé par mot de passe. Ne l’envoie jamais dans une conversation ni dans GitHub.\n'
fi
