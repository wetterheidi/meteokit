#!/usr/bin/env bash
# Prüft, ob die monatlichen Cache-Läufe (fetch-airspaces.mjs, fetch-airports.mjs)
# auf dem Server sauber durchgelaufen sind -- von außen (öffentliche meta.json
# und Stichproben-Kacheln) und per SSH (Prozess, Log, Staging).
# Hintergrund und Schwellen: s. README.md, Abschnitte "Vorfall ...".
#
# Aufruf: ./check-airspace-cache.sh [user@host]
# Exit-Code: 0 = OK, 1 = Warnung (Lauf aktiv/Datenstand alt), 2 = Fehler.

set -u

HOST="${1:-root@178.104.206.136}"
BASE_URL="https://airspace.wetterheidi.de"
APP_DIR="/apps/airspace-cache"
# Monatlicher Cron: älter als ~40 Tage heißt, ein Lauf fehlt.
MAX_AGE_DAYS=40

# Lufträume -- Stand 2026-11-01 (erster Lauf ohne bbox): 10501 Zellen /
# 79156 Features / 34875 Lufträume; davor (bbox-Abfrage) 8466 / 62773.
# Deutlich darunter deutet auf falsch-leere Regionen hin.
AIRSPACE_MIN_CELLS=7500
AIRSPACE_MIN_FEATURES=55000
# Stichproben aus datendichten Regionen (Key = {latFloor}_{lonFloor}):
# Süddeutschland, Nordosten USA, Südostengland.
AIRSPACE_SAMPLES=("48_10" "40_-74" "50_0")

# Flugplätze -- Stand 2026-11-01: 3531 Zellen / 46831 Flugplätze.
AIRPORT_MIN_CELLS=3300
AIRPORT_MIN_FEATURES=44000
AIRPORT_SAMPLES=("48_10" "40_-74")

status=0
warn() { echo "  ⚠ $*"; [ "$status" -lt 1 ] && status=1; }
fail() { echo "  ✗ $*"; status=2; }
ok()   { echo "  ✓ $*"; }

# check_public LABEL URL_PREFIX MIN_CELLS MIN_FEATURES SAMPLE...
check_public() {
  local label="$1" prefix="$2" min_cells="$3" min_features="$4"
  shift 4
  echo "== Öffentlich, $label: $BASE_URL$prefix/ =="
  local meta
  meta="$(curl -sf --compressed --max-time 15 "$BASE_URL$prefix/meta.json")"
  if [ -z "$meta" ]; then
    fail "meta.json nicht abrufbar"
  else
    local generatedAt cellCount totalFeatures ageDays
    read -r generatedAt cellCount totalFeatures ageDays < <(node -e '
      const m = JSON.parse(process.argv[1]);
      const age = ((Date.now() - Date.parse(m.generatedAt)) / 864e5).toFixed(1);
      console.log(m.generatedAt, m.cellCount, m.totalFeatures, age);
    ' "$meta")
    echo "  generatedAt=$generatedAt  cellCount=$cellCount  totalFeatures=$totalFeatures  (Alter ${ageDays} Tage)"
    if [ "$cellCount" -lt "$min_cells" ] || [ "$totalFeatures" -lt "$min_features" ]; then
      fail "Zu wenige Zellen/Features (Minimum $min_cells / $min_features) -- falsch-leere Regionen?"
    else
      ok "Umfang plausibel"
    fi
    if awk "BEGIN { exit !($ageDays > $MAX_AGE_DAYS) }"; then
      warn "Datenstand älter als $MAX_AGE_DAYS Tage"
    else
      ok "Datenstand aktuell genug"
    fi
  fi

  local key code
  for key in "$@"; do
    code="$(curl -s -o /dev/null --compressed -w '%{http_code} %{size_download}' --max-time 30 "$BASE_URL$prefix/tiles/$key.geojson")"
    if [ "${code%% *}" = "200" ]; then
      ok "Kachel $key: HTTP 200, ${code#* } Bytes (gzip)"
    else
      fail "Kachel $key: HTTP ${code%% *} (dichte Region sollte Daten haben)"
    fi
  done
  echo
}

# check_server LABEL SCRIPT OUT_DIR LOG CRON_HOUR_UTC
check_server() {
  local label="$1" script="$2" out="$3" log="$4" cron_hour="$5"
  echo "== Server, $label: $HOST =="
  local remote
  remote="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" bash -s <<EOF
echo "PROC=\$(pgrep -f $script | grep -v \$\$ | head -1)"
echo "STAGING=\$([ -d $out.staging ] && echo 1 || echo 0)"
# Letzter planmäßiger Cron-Start (1. des Monats) vs. letzte Log-Änderung
echo "CRONSTART=\$(date -d "\$(date +%Y-%m-01) $cron_hour:00" +%s)"
echo "CRONLABEL=\$(date -d "\$(date +%Y-%m-01) $cron_hour:00" '+%d.%m. %H:%M %Z')"
echo "NOW=\$(date +%s)"
echo "LOGMTIME=\$(stat -c %Y $log 2>/dev/null || echo 0)"
echo "PROGRESS=\$(grep -o '^Seite [0-9]*/[0-9]*' $log 2>/dev/null | tail -1)"
echo "LOGEND<<"
tail -n 3 $log 2>/dev/null
EOF
)"
  if [ $? -ne 0 ] || [ -z "$remote" ]; then
    fail "SSH auf $HOST fehlgeschlagen"
    echo
    return
  fi
  local proc staging progress cronstart cronlabel now logmtime logend
  proc="$(sed -n 's/^PROC=//p' <<<"$remote")"
  staging="$(sed -n 's/^STAGING=//p' <<<"$remote")"
  progress="$(sed -n 's/^PROGRESS=//p' <<<"$remote")"
  cronstart="$(sed -n 's/^CRONSTART=//p' <<<"$remote")"
  cronlabel="$(sed -n 's/^CRONLABEL=//p' <<<"$remote")"
  now="$(sed -n 's/^NOW=//p' <<<"$remote")"
  logmtime="$(sed -n 's/^LOGMTIME=//p' <<<"$remote")"
  logend="$(sed -n '/^LOGEND<</,$p' <<<"$remote" | tail -n +2)"

  # Ein Lauf schreibt sofort ins Log; ist das Log 10 min nach dem Cron-Termin
  # noch älter, ist der Lauf gar nicht erst gestartet (so geschehen am
  # 2026-10-01: `. .env` scheiterte unter dash, ohne dass etwas im Log landete).
  if [ "$now" -gt $((cronstart + 600)) ] && [ "$logmtime" -lt "$cronstart" ]; then
    fail "Lauf vom $cronlabel hat nichts ins Log geschrieben -- nicht gestartet? (crontab und syslog prüfen)"
  fi

  if [ -n "$proc" ]; then
    warn "Lauf aktiv (PID $proc), Fortschritt ${progress:-unbekannt} -- Ergebnis steht noch aus"
  elif [ "$staging" = "1" ]; then
    fail "Kein Prozess, aber $(basename "$out").staging existiert -- Lauf abgestürzt (Reboot?)"
  else
    ok "Kein Lauf aktiv, kein Staging-Rest"
  fi

  if [ -z "$proc" ]; then
    if grep -qE "^(Abgebrochen|Abbruch)" <<<"$logend"; then
      fail "Letzter Lauf abgebrochen -- alter Stand weiter live. Neu starten mit:"
      echo "      cd $APP_DIR && set -a && . ./.env && set +a && node $script --out $out >> $log 2>&1"
    elif grep -q "^Fertig:" <<<"$logend"; then
      ok "Letzter protokollierter Lauf mit 'Fertig' beendet"
    else
      warn "Log-Ende ohne erkennbare Abschlusszeile"
    fi
  fi
  echo "  Log-Ende:"
  sed 's/^/    | /' <<<"$logend"
  echo
}

check_public "Lufträume" "" "$AIRSPACE_MIN_CELLS" "$AIRSPACE_MIN_FEATURES" "${AIRSPACE_SAMPLES[@]}"
check_public "Flugplätze" "/airports" "$AIRPORT_MIN_CELLS" "$AIRPORT_MIN_FEATURES" "${AIRPORT_SAMPLES[@]}"
check_server "Lufträume" fetch-airspaces.mjs "$APP_DIR/data" /var/log/airspace-cache.log 03
check_server "Flugplätze" fetch-airports.mjs "$APP_DIR/airports" /var/log/airports-cache.log 01

case $status in
  0) echo "Ergebnis: OK" ;;
  1) echo "Ergebnis: WARNUNG" ;;
  2) echo "Ergebnis: FEHLER" ;;
esac
exit $status
