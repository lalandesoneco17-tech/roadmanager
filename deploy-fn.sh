#!/bin/bash
# Deploiement d'une Edge Function Supabase : bash deploy-fn.sh <nom>   (ex. assistant-vocal)
# Memes regles que deploy-bot.sh : --no-verify-jwt et --use-api obligatoires, jamais --prune.
set -e
cd "$(dirname "$0")"
FN="${1:?nom de la fonction attendu (ex. assistant-vocal)}"
if [ -z "$SUPABASE_ACCESS_TOKEN" ] && [ -f "$HOME/.config/roadmanager/supabase-token" ]; then
  export SUPABASE_ACCESS_TOKEN="$(cat "$HOME/.config/roadmanager/supabase-token")"
fi
npx --yes supabase@latest functions deploy "$FN" --project-ref valtmsgqhrkvwjsdqfdc --no-verify-jwt --use-api
echo "Deploye : $FN"
