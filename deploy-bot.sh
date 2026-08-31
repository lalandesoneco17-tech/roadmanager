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
npx --yes supabase@latest functions deploy telegram-webhook \
  --project-ref valtmsgqhrkvwjsdqfdc \
  --no-verify-jwt \
  --use-api
echo
echo "Deploye. Verification :"
echo "  local   : $(wc -c < supabase/functions/telegram-webhook/index.ts | tr -d ' ') octets"
