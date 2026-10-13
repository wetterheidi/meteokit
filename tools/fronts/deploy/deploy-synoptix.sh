#!/usr/bin/env bash
#
# Spielt synoptix.wetterheidi.de ein (Frontenanalyse, s. tools/fronts/README.md,
# „Webanwendung synoptix“):
#   src/, tools/fronts/{index.html,app.js,favicon.svg,debug.html,compare.js,run-analysis.mjs,fixtures,reference}
#                               → /apps/synoptix/app      (Web-Root, Job läuft von hier)
#   synoptix.wetterheidi.de     → /etc/nginx/sites-available/ (+ sites-enabled)
#   synoptix-analysis.{service,timer} → /etc/systemd/system/
# Das Archiv der laufenden Analyse liegt in /apps/synoptix/data und wird nie
# angefasst.
#
# Vorher wird der Stand nach /apps/synoptix/app.prev bzw. /opt/synoptix.prev
# gesichert. Scheitert nginx -t, wird der alte Vhost zurückgeschrieben und
# abgebrochen; nginx läuft dann unverändert weiter.
#
# Aufruf (im Repo-Root oder von überall):
#   tools/fronts/deploy/deploy-synoptix.sh            einspielen
#   tools/fronts/deploy/deploy-synoptix.sh rollback   vorherigen Stand (App und Vhost) zurück
#
# Ersteinrichtung (einmalig, vor dem ersten Deploy): Zertifikat holen mit
#   ssh root@178.104.206.136 certbot certonly --nginx -d synoptix.wetterheidi.de

set -euo pipefail

SERVER="root@178.104.206.136"
APP="/apps/synoptix/app"
DATA="/apps/synoptix/data"
VHOST="/etc/nginx/sites-available/synoptix.wetterheidi.de"
UNITS="/etc/systemd/system"
BACKUP_DIR="/opt/synoptix.prev"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEPLOY="$REPO/tools/fronts/deploy"

if [[ "${1:-}" == "rollback" ]]; then
    echo "==> Rollback auf den vorherigen Stand ..."
    ssh "$SERVER" bash -s -- "$APP" "$VHOST" "$BACKUP_DIR" <<'REMOTE'
set -euo pipefail
APP="$1"; VHOST="$2"; BACKUP_DIR="$3"
[[ -d "$APP.prev" ]] || { echo "Kein $APP.prev vorhanden." >&2; exit 1; }
rm -rf "$APP.failed"; mv "$APP" "$APP.failed"; mv "$APP.prev" "$APP"
if [[ -f "$BACKUP_DIR/vhost" ]]; then cp -p "$BACKUP_DIR/vhost" "$VHOST"; fi
nginx -t && systemctl reload nginx
echo "    App und Vhost zurückgesetzt (fehlerhafter Stand in $APP.failed)."
REMOTE
    exit 0
fi

# Nichts Halbfertiges ausliefern: Arbeitsbaum muss für die ausgelieferten Teile sauber sein.
if [[ -n "$(git -C "$REPO" status --porcelain -- src tools/fronts)" ]]; then
    echo "Ungespeicherte Änderungen in src/ oder tools/fronts/ -- erst committen." >&2
    exit 1
fi
COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"

echo "==> Zertifikat vorhanden? ..."
ssh "$SERVER" test -f /etc/letsencrypt/live/synoptix.wetterheidi.de/fullchain.pem \
    || { echo "Kein Zertifikat -- erst Ersteinrichtung (s. Kopf des Skripts)." >&2; exit 1; }

echo "==> Übertrage App ($COMMIT) nach $APP.new ..."
# Vom bisherigen Stand aus kopieren, dann überträgt rsync nur Änderungen
# (die Fixtures sind rund 50 MB).
ssh "$SERVER" "rm -rf $APP.new && if [[ -d $APP ]]; then cp -a $APP $APP.new; fi && mkdir -p $APP.new/tools/fronts $DATA"
# -t statt -a: Besitzer/Rechte nicht von macOS übernehmen, sondern unten setzen.
rsync -rtz --delete "$REPO/src" "$REPO/package.json" "$SERVER:$APP.new/"
rsync -rtz --delete \
    "$REPO/tools/fronts/index.html" "$REPO/tools/fronts/app.js" "$REPO/tools/fronts/favicon.svg" \
    "$REPO/tools/fronts/debug.html" "$REPO/tools/fronts/compare.js" "$REPO/tools/fronts/run-analysis.mjs" \
    "$REPO/tools/fronts/fixtures" "$REPO/tools/fronts/reference" \
    "$SERVER:$APP.new/tools/fronts/"
echo "$COMMIT" | ssh "$SERVER" "cat > $APP.new/VERSION"

echo "==> Übertrage Vhost und systemd-Units ..."
rsync -tz "$DEPLOY/synoptix.wetterheidi.de" "$SERVER:/tmp/synoptix.vhost"
rsync -tz "$DEPLOY/synoptix-analysis.service" "$DEPLOY/synoptix-analysis.timer" "$SERVER:/tmp/"

echo "==> Einspielen und prüfen ..."
ssh "$SERVER" bash -s -- "$APP" "$DATA" "$VHOST" "$UNITS" "$BACKUP_DIR" <<'REMOTE'
set -euo pipefail
APP="$1"; DATA="$2"; VHOST="$3"; UNITS="$4"; BACKUP_DIR="$5"
chown -R www-data:www-data "$APP.new" "$DATA"
chmod -R u=rwX,go=rX "$APP.new"

# Vhost: sichern, ersetzen, prüfen -- bei Fehler alten Stand zurück.
mkdir -p "$BACKUP_DIR"
rm -f "$BACKUP_DIR/vhost"
[[ -f "$VHOST" ]] && cp -p "$VHOST" "$BACKUP_DIR/vhost"
install -o root -g root -m 644 /tmp/synoptix.vhost "$VHOST"
ln -sf "$VHOST" /etc/nginx/sites-enabled/
if ! nginx -t; then
    echo "    nginx -t fehlgeschlagen, stelle alten Vhost wieder her." >&2
    if [[ -f "$BACKUP_DIR/vhost" ]]; then cp -p "$BACKUP_DIR/vhost" "$VHOST"; else rm -f "$VHOST" /etc/nginx/sites-enabled/synoptix.wetterheidi.de; fi
    rm -rf "$APP.new"
    exit 1
fi

# App tauschen (vorheriger Stand nach .prev).
rm -rf "$APP.prev"
[[ -d "$APP" ]] && mv "$APP" "$APP.prev"
mv "$APP.new" "$APP"

install -o root -g root -m 644 /tmp/synoptix-analysis.service /tmp/synoptix-analysis.timer "$UNITS/"
rm -f /tmp/synoptix.vhost /tmp/synoptix-analysis.service /tmp/synoptix-analysis.timer
systemctl daemon-reload
systemctl enable --now synoptix-analysis.timer
systemctl reload nginx
echo "    eingespielt: $(cat "$APP/VERSION"), nächster Lauf: $(systemctl show synoptix-analysis.timer -p NextElapseUSecRealtime --value)"
REMOTE

echo "==> Fertig. https://synoptix.wetterheidi.de  (zurück mit: $0 rollback)"
