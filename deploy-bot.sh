#!/bin/bash
# Deploiement du bot Telegram (Edge Function Supabase).
#
# Prealable, UNE SEULE FOIS :   npx supabase login
#
# Les deux options ci-dessous sont OBLIGATOIRES, ne pas les retirer :
#   --no-verify-jwt : sans elle, Supabase exige un JWT et Telegram recoit 401 -> le bot meurt.
#   --use-api       : bundling cote serveur, evite d'avoir a installer Docker.
# Ne JAMAIS ajouter --prune : cela supprimerait les fonctions absentes du dossier local.
set -e
cd "$(dirname "$0")"
# Jeton d'acces Supabase : variable d'environnement, sinon fichier local HORS du depot
# (~/.config/roadmanager/supabase-token, revocable sur https://supabase.com/dashboard/account/tokens).
# Ne JAMAIS le mettre dans un fichier versionne.
if [ -z "$SUPABASE_ACCESS_TOKEN" ] && [ -f "$HOME/.config/roadmanager/supabase-token" ]; then
  export SUPABASE_ACCESS_TOKEN="$(cat "$HOME/.config/roadmanager/supabase-token")"
fi
npx --yes supabase@latest functions deploy telegram-webhook \
  --project-ref valtmsgqhrkvwjsdqfdc \
  --no-verify-jwt \
  --use-api
echo
echo "Deploye. Verification :"
echo "  local   : $(wc -c < supabase/functions/telegram-webhook/index.ts | tr -d ' ') octets"
