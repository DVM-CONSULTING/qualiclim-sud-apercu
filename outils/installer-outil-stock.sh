#!/usr/bin/env bash
# Qualiclim Stock (outil interne, app.qualiclimsud.fr) — installation sur le VPS, en une commande :
#
#   curl -fsSL https://raw.githubusercontent.com/DVM-CONSULTING/qualiclim-sud-apercu/main/outils/installer-outil-stock.sh | sudo bash
#
# Ce script public ne contient aucun secret. Il :
#   1. installe Docker et git s'il le faut ;
#   2. crée une clé de lecture pour ce serveur et demande de l'ajouter UNE fois sur GitHub (le code de l'outil est privé) ;
#   3. récupère l'outil dans /opt/qualiclim-stock ;
#   4. lance /opt/qualiclim-stock/deploy/installer-vps.sh (adresse, https, base, accès).
# On peut le relancer sans risque : il reprend où il en est et garde les données.
set -euo pipefail
DEPOT_SSH="git@github.com:DVM-CONSULTING/sites-clients.git"
PAGE_CLES="https://github.com/DVM-CONSULTING/sites-clients/settings/keys/new"
BRANCHE="${BRANCHE:-claude/qualiclim-stock-app}"
DOSSIER="/opt/qualiclim-stock"
CLE="/root/.ssh/qualiclim_stock"
TTY=/dev/tty; [ -r "$TTY" ] || TTY=/dev/stdin
etape() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
stop()  { printf '\n\033[31m✖ %s\033[0m\n' "$1" >&2; exit 1; }
ok()    { printf '  ✔ %s\n' "$1"; }

[ "$(id -u)" -eq 0 ] || stop "Lance la commande avec sudo."
command -v apt-get >/dev/null || stop "Ce script est prévu pour Debian ou Ubuntu. Envoie ce message à Claude."

etape "Préparation du serveur"
MANQUE=""
for c in curl git openssl ssh; do command -v "$c" >/dev/null || MANQUE="$MANQUE $c"; done
MANQUE=${MANQUE/ ssh/ openssh-client}
[ -z "$MANQUE" ] || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q $MANQUE; }
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
ok "Docker $(docker --version | awk '{print $3}' | tr -d ,) et git présents"

etape "Accès en lecture au code de l'outil (GitHub)"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f "$CLE" ] || ssh-keygen -q -t ed25519 -N "" -C "vps-qualiclim-stock" -f "$CLE"
export GIT_SSH_COMMAND="ssh -i $CLE -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
until git ls-remote --heads "$DEPOT_SSH" "$BRANCHE" 2>/dev/null | grep -q .; do
  printf '\n  Ce serveur doit être autorisé à LIRE le code (une seule fois) :\n'
  printf '  1. Ouvrez : %s\n' "$PAGE_CLES"
  printf '  2. Title : VPS Qualiclim Stock\n  3. Key : collez la ligne ci-dessous (en entier)\n\n%s\n\n' "$(cat "$CLE.pub")"
  printf '  4. Laissez « Allow write access » DÉCOCHÉ, puis « Add key ».\n'
  read -rp "  Appuyez sur Entrée une fois la clé ajoutée… " _ < "$TTY"
done
ok "accès autorisé (lecture seule)"

etape "Récupération de l'outil"
if [ -d "$DOSSIER/.git" ]; then
  git -C "$DOSSIER" fetch -q origin "$BRANCHE" && git -C "$DOSSIER" reset -q --hard "origin/$BRANCHE"
else
  git clone -q --depth 1 --branch "$BRANCHE" "$DEPOT_SSH" "$DOSSIER"
fi
git -C "$DOSSIER" config core.sshCommand "$GIT_SSH_COMMAND"   # pour les mises à jour
ok "outil dans $DOSSIER (version $(git -C "$DOSSIER" log -1 --format=%h))"

exec bash "$DOSSIER/deploy/installer-vps.sh"
