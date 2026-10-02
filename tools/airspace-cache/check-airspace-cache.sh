#!/usr/bin/env bash
# Prüft, ob der monatliche Luftraum-Cache-Lauf (fetch-airspaces.mjs) auf dem
# Server sauber durchgelaufen ist -- von außen (öffentliche meta.json und
# Stichproben-Kacheln) und per SSH (Prozess, Log, failed-cells, Staging).
# Hintergrund und Schwellen: s. README.md, Abschnitt "Vorfall 2026-09-13..17".
#
# Aufruf: ./check-airspace-cache.sh [user@host]
# Exit-Code: 0 = OK, 1 = Warnung (Lauf aktiv/Lücken), 2 = Fehler.

set -u

HOST="${1:-root@178.104.206.136}"
BASE_URL="https://airspace.wetterheidi.de"
APP_DIR="/apps/airspace-cache"
LOG="/var/log/airspace-cache.log"
# Stand nach dem Nachholen am 2026-09-21: 8115 Zellen / 61828 Features.
# Deutlich darunter deutet auf falsch-leere Regionen hin.
MIN_CELLS=7500
MIN_FEATURES=55000
# Monatlicher Cron + mehrtägiger Lauf: älter als ~40 Tage heißt, ein Lauf fehlt.
MAX_AGE_DAYS=40
# Stichproben aus datendichten Regionen (Key = {latFloor}_{lonFloor}):
# Süddeutschland, Nordosten USA, Südostengland.
SAMPLE_TILES=("48_10" "40_-74" "50_0")

status=0
warn() { echo "  ⚠ $*"; [ "$status" -lt 1 ] && status=1; }
fail() { echo "  ✗ $*"; status=2; }
ok()   { echo "  ✓ $*"; }

echo "== Öffentlich: $BASE_URL =="
meta="$(curl -sf --max-time 15 "$BASE_URL/meta.json")"
if [ -z "$meta" ]; then
  fail "meta.json nicht abrufbar"
else
  read -r generatedAt cellCount totalFeatures ageDays < <(node -e '
    const m = JSON.parse(process.argv[1]);
    const age = ((Date.now() - Date.parse(m.generatedAt)) / 864e5).toFixed(1);
    console.log(m.generatedAt, m.cellCount, m.totalFeatures, age);
  ' "$meta")
  echo "  generatedAt=$generatedAt  cellCount=$cellCount  totalFeatures=$totalFeatures  (Alter ${ageDays} Tage)"
  if [ "$cellCount" -lt "$MIN_CELLS" ] || [ "$totalFeatures" -lt "$MIN_FEATURES" ]; then
    fail "Zu wenige Zellen/Features (Minimum $MIN_CELLS / $MIN_FEATURES) -- falsch-leere Regionen?"
  else
    ok "Umfang plausibel"
  fi
  if awk "BEGIN { exit !($ageDays > $MAX_AGE_DAYS) }"; then
    warn "Datenstand älter als $MAX_AGE_DAYS Tage"
  else
    ok "Datenstand aktuell genug"
  fi
fi

for key in "${SAMPLE_TILES[@]}"; do
  code="$(curl -s -o /dev/null -w '%{http_code} %{size_download}' --max-time 30 "$BASE_URL/tiles/$key.geojson")"
  if [ "${code%% *}" = "200" ]; then
    ok "Kachel $key: HTTP 200, ${code#* } Bytes"
  else
    fail "Kachel $key: HTTP ${code%% *} (dichte Region sollte Daten haben)"
  fi
done

echo
echo "== Server: $HOST =="
remote="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" bash -s <<EOF
echo "PROC=\$(pgrep -f fetch-airspaces.mjs | grep -v \$\$ | head -1)"
echo "STAGING=\$([ -d $APP_DIR/data.staging ] && echo 1 || echo 0)"
echo "FAILED=\$([ -f $APP_DIR/data.failed-cells.txt ] && wc -l < $APP_DIR/data.failed-cells.txt || echo 0)"
# Letzter planmäßiger Cron-Start (1. des Monats, 03:00) vs. letzte Log-Änderung
echo "CRONSTART=\$(date -d "\$(date +%Y-%m-01) 03:00" +%s)"
echo "CRONLABEL=\$(date -d "\$(date +%Y-%m-01) 03:00" '+%d.%m. %H:%M %Z')"
echo "NOW=\$(date +%s)"
echo "LOGMTIME=\$(stat -c %Y $LOG 2>/dev/null || echo 0)"
echo "PROGRESS=\$(grep -o '^\[[0-9]*/[0-9]*\]' $LOG 2>/dev/null | tail -1)"
echo "LOGEND<<"
tail -n 3 $LOG 2>/dev/null
EOF
)"
if [ $? -ne 0 ] || [ -z "$remote" ]; then
  fail "SSH auf $HOST fehlgeschlagen"
else
  proc="$(sed -n 's/^PROC=//p' <<<"$remote")"
  staging="$(sed -n 's/^STAGING=//p' <<<"$remote")"
  failed="$(sed -n 's/^FAILED=//p' <<<"$remote" | tr -d ' ')"
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
    fail "Kein Prozess, aber data.staging existiert -- Lauf abgestürzt (Reboot?)"
  else
    ok "Kein Lauf aktiv, kein Staging-Rest"
  fi

  if [ "${failed:-0}" -gt 0 ]; then
    warn "$failed Zelle(n) in data.failed-cells.txt -- nachholen mit:"
    echo "      cd $APP_DIR && set -a && . ./.env && set +a && node fetch-airspaces.mjs --cells-file $APP_DIR/data.failed-cells.txt --out $APP_DIR/data"
  else
    ok "Keine fehlgeschlagenen Zellen"
  fi

  if [ -z "$proc" ]; then
    if grep -q "^Abgebrochen" <<<"$logend"; then
      fail "Letzter Lauf abgebrochen -- alter Stand weiter live"
    elif grep -qE "^(Fertig|Merge fertig):" <<<"$logend"; then
      ok "Letzter protokollierter Lauf mit 'Fertig' beendet"
    else
      warn "Log-Ende ohne erkennbare Abschlusszeile"
    fi
  fi
  echo "  Log-Ende:"
  sed 's/^/    | /' <<<"$logend"
fi

echo
case $status in
  0) echo "Ergebnis: OK" ;;
  1) echo "Ergebnis: WARNUNG" ;;
  2) echo "Ergebnis: FEHLER" ;;
esac
exit $status
