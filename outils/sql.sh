#!/bin/bash
# Execute un fichier SQL sur la base RoadManager (API de gestion Supabase).
#   SUPABASE_ACCESS_TOKEN=sbp_... bash outils/sql.sh outils/reparer-doublons-2026-09-28.sql
# Le jeton est celui de https://supabase.com/dashboard/account/tokens (jamais dans un fichier versionne).
set -e
cd "$(dirname "$0")/.."
FICHIER="${1:?fichier SQL attendu}"
if [ -z "$SUPABASE_ACCESS_TOKEN" ] && [ -f "$HOME/.config/roadmanager/supabase-token" ]; then
  export SUPABASE_ACCESS_TOKEN="$(cat "$HOME/.config/roadmanager/supabase-token")"
fi
[ -n "$SUPABASE_ACCESS_TOKEN" ] || { echo "SUPABASE_ACCESS_TOKEN manquant"; exit 1; }
python3 - "$FICHIER" <<'EOF'
import json, sys, os, urllib.request
sql = open(sys.argv[1], encoding="utf-8").read()
req = urllib.request.Request(
    "https://api.supabase.com/v1/projects/valtmsgqhrkvwjsdqfdc/database/query",
    data=json.dumps({"query": sql}).encode(),
    headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"], "Content-Type": "application/json"})
try:
    print(urllib.request.urlopen(req).read().decode()[:1000])
except urllib.error.HTTPError as e:
    print("ERREUR", e.code, e.read().decode()[:1000]); sys.exit(1)
EOF
echo "Termine : $FICHIER"
