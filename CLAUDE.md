# RoadManager — SONECO
App React mono-fichier pour gérer les chantiers de raboteuses, balayeuses et citernes de SONECO (Lalande, Charente-Maritime 17). Utilisée par l'admin pour planifier les missions, suivre les chauffeurs, importer les rapports télématiques Wirtgen et John Deere, calculer le CA et les coûts.
## Stack technique
- React 18 + Babel @standalone (compilation in-browser, pas de build)
- Fichier principal : app.v6.jsx (chargé par index.html, ~3850 lignes)
- Backup : app.jsx (à garder synchronisé avec app.v6.jsx au cas où on rebascule)
- Persistence : Supabase (table app_data avec champ JSON) + fallback localStorage
- Pointages : tables Supabase dédiées time_entries / time_entries_validated (anti-race-condition)
- Carte : Leaflet 1.9.4 + OpenStreetMap (tuiles gratuites)
- Géocodage : Nominatim (OpenStreetMap, gratuit, sans clé, 1 req/sec)
- Déploiement : Vercel auto-deploy sur push main (repo lalandesoneco17-tech/roadmanager)
## Règles d'or
1. JAMAIS modifier le chatbot Claude embarqué sans validation explicite de l'admin. Le chatbot propose, l'admin valide.
2. TOUJOURS commit + push après chaque modification. Vercel redéploie automatiquement (~30 s).
3. Avant de commencer une session, faire git pull pour récupérer les dernières modifs (l'admin travaille depuis 2 PC : bureau Windows + Mac perso).
4. Ne JAMAIS toucher aux clés Supabase ni au mot de passe admin sans demander.
## Fonctionnalités récentes (mai 2026)
- Géocodage automatique du champ Lieu : autocomplete live (debounce 400ms) avec biais viewbox sur les dépôts SONECO, tri par distance, badge département. Stockage en _geocodedGps (champ caché).
- Carte planning : bouton "🗺 Carte planning" en haut de page. Affiche tous les chantiers du jour sur Leaflet avec couleur par largeur de tambour (200=vert, 150=jaune, 130=rouge, 100=bleu, <100=noir), pastilles avec nom machine, prénom chauffeur, heure de début, numérotation 1/2/3 si chauffeur multi-chantiers, décalage automatique pour markers superposés.
- Boutons Veille (J-1) et Surlendemain (J+1) sur la carte planning pour visualiser les jours adjacents avec bordures dashed/dotted.
- Badge nuit : bordure rouge épaisse 3px + emoji lune 🌙 sur les chantiers de nuit (j.isNight = true).
- Marqueur de version v2026.05.11-7 dans le titre du modal carte planning (utile pour vérifier que la dernière version est bien chargée côté navigateur, sinon Ctrl+F5).
## Algorithme Wirtgen (parseWirtgenZip)
Détecte automatiquement 8 événements par chantier depuis les 3 CSV (Location.csv, HoursOfOperation.csv, Measurements.csv) :
1. Dép. Dépôt → 2. Arr. Chantier → 3. Début Fraisage → 4. Fin Fraisage → 5. Dép. Chantier → 6. Arr. Dépôt
Gère les chantiers de nuit qui traversent minuit, et les multi-chantiers (jour + nuit).
Constantes clés : ZONE_KM=1.0, STATIONARY_KM=0.2, CLUSTER_KM=5.0, MIN_OP_H=0.05, MARGE_ARRIVEE_CHANTIER=15min.
## Cache Vercel
vercel.json : app.jsx et app.v6.jsx en no-cache (avant c'était immutable 1 an, causait des soucis de cache navigateur). Toujours bumper le numéro de version v2026.MM.JJ-N à chaque change visuel important pour pouvoir vérifier.
## Workflow type
1. git pull
2. modif demandée par l'admin
3. test si possible
4. git add + commit avec message clair en français
5. git push
6. attendre ~30s pour Vercel
7. dire à l'admin de Ctrl+F5
