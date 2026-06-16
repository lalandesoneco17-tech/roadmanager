# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# RoadManager — SONECO
App React mono-fichier pour gérer les chantiers de raboteuses, balayeuses et citernes de SONECO (Lalande, Charente-Maritime 17). Utilisée par l'admin pour planifier les missions, suivre les chauffeurs, importer les rapports télématiques Wirtgen et John Deere, calculer le CA et les coûts.

## Stack & build
- React 18 + Babel @standalone : **compilation in-browser, AUCUN build, AUCUN npm install, AUCUN test runner.** Toutes les libs (React, Supabase, Leaflet, XLSX/SheetJS, JSZip) sont chargées par CDN dans `index.html`.
- Pas de commande `build`/`lint`/`test`. Pour "lancer" : ouvrir `index.html` via un serveur statique (ex. `python3 -m http.server`) puis ouvrir dans le navigateur. La vraie vérif se fait en prod après push (Vercel ~30 s).
- Déploiement : Vercel auto-deploy sur push `main` (repo lalandesoneco17-tech/roadmanager).

## Fichiers
- `app.v6.jsx` (~4640 lignes) : **tout le code** est ici. Chargé par `index.html` via `<script type="text/babel" src="app.v6.jsx?t=...">`.
- `app.jsx` : backup **identique** à `app.v6.jsx` (à garder synchronisé au cas où on rebascule). Toute modif de `app.v6.jsx` doit être recopiée à l'identique dans `app.jsx`.
- `index.html` : init Supabase (URL + clé anon en clair), fallback `localStorage`, imports CDN.
- `SETUP.md` : SQL de création de la table Supabase `app_data` + activation realtime.
- `vercel.json` : `index.html`, `app.jsx`, `app.v6.jsx` en `no-cache` (évite les soucis de cache navigateur).

## Architecture (lecture transversale nécessaire)
Le fichier est organisé en couches du haut vers le bas :
1. **Constantes & data model** (haut du fichier) : `defaultData()` est le schéma complet de l'état (depots, employees, machines, trucks, cars, clients, jobs, forfaits, timeEntries, parts, interventions, stations, réglages de paie/coûts…). Tout l'état applicatif est UN gros objet JSON.
2. **Couche persistence + sync** : `loadData`/`saveData` lisent/écrivent la ligne unique `app_data` (id=`'main'`) dans Supabase, avec fallback `localStorage` (clé `roadmanager-v5`). Le cœur du multi-poste est le **merge avec tombstones** : `mergeFullData`, `mergeArraysById`, `mergeByUpdatedAt`, `tombstone()`/`filterTombstones`. Une suppression écrit un tombstone (`d._tombstones[type][id]=Date.now()`) pour empêcher qu'un élément supprimé sur un PC réapparaisse via le merge de l'autre PC. `subscribeToChanges` écoute le realtime Supabase et re-merge en live.
3. **Pointages (time entries)** : stockés à part dans des tables Supabase dédiées `time_entries` / `time_entries_validated` (préfixe `te*` : `teToRow`/`teFromRow`/`teSyncChanges`/`teMigrateFromBlob`/`teSubscribe`). Raison : éviter les race conditions quand plusieurs chauffeurs pointent en même temps. Une file d'attente offline (`teQueue*` dans localStorage) rejoue les opérations quand Supabase redevient joignable.
4. **Helpers métier** : dates FR, `calcWorkedMin`/`calcNightHours` (paie + heures de nuit), jours fériés français (`easterDate`/`getFrenchHoliday`), géo (`haversine`, `osmRoute` via OSRM, `searchAddress` via Nominatim), et tout le **moteur de forfaits/tarification** (`getForfaitKey`/`getForfaitPrice`/`getTransferPrice`) qui calcule le CA selon client × type de machine × largeur de tambour × option citerne × nuit.
5. **Composants UI** : modals carte Leaflet (`MapModal*`), `MissionForm`/`MissionDetail`, et une **page par onglet** (`PlanningPage`, `DashboardPage`, `DepotsPage`, `MachinesPage`, `EmployeesPage`, `ClientsPage`, `ForfaitsPage`, `SettingsPage`, `StockPage`, `InterventionsPage`, `StatsPage`, `HeuresPage`, `SearchDataPage`, `StationsPage`…).
6. **Vues par rôle** : `LoginScreen` authentifie 4 types d'utilisateurs et route vers la vue correspondante : **admin** (toutes les pages), **employee** (`EmployeeView` — chauffeur qui pointe), **mechanic** (`MechanicView`), **station** (`StationUserView`). `App` (bas du fichier) tient l'état global, choisit la vue selon le rôle, et `ReactDOM.createRoot(...).render(App)` monte le tout.
7. **Chatbot IA** (`AdminChatbot`, bas du fichier) : appelle l'API Anthropic (clé `data.anthropicApiKey` saisie dans Réglages). Le bot **propose** des modifs de données (`parseProposal`), l'admin **valide**.

## Imports télématiques
- **Wirtgen** (`parseWirtgenZip`, raboteuses) : lit un ZIP de 3 CSV (Location.csv, HoursOfOperation.csv, Measurements.csv) et détecte automatiquement 6 événements par chantier : 1. Dép. Dépôt → 2. Arr. Chantier → 3. Début Fraisage → 4. Fin Fraisage → 5. Dép. Chantier → 6. Arr. Dépôt. Gère les chantiers de nuit qui traversent minuit et les multi-chantiers (jour + nuit). Constantes clés : `ZONE_KM=1.0`, `STATIONARY_KM=0.2`, `CLUSTER_KM=5.0`, `MIN_OP_H=0.05`, marge arrivée chantier 15 min.
- **John Deere** (`handleJdFile`, balayeuses/citernes) : lit un XLSX (SheetJS), matche le nom machine via `normJd`, en déduit heures travail/idle/transport et conso carburant.

## Géo & carte
- Géocodage du champ Lieu : autocomplete live (debounce 400 ms), biais viewbox sur les dépôts SONECO, tri par distance, badge département. GPS stocké dans le champ caché `_geocodedGps`. Nominatim (gratuit, 1 req/sec).
- Carte planning (bouton "🗺 Carte planning") : tous les chantiers du jour sur Leaflet, couleur par largeur de tambour (200=vert, 150=jaune, 130=rouge, 100=bleu, <100=noir), pastilles nom machine + prénom chauffeur + heure début, numérotation 1/2/3 si chauffeur multi-chantiers, décalage auto des markers superposés. Boutons Veille (J-1) / Surlendemain (J+1) avec bordures dashed/dotted. Badge nuit : bordure rouge 3px + 🌙 si `j.isNight`.

## Règles d'or
1. **JAMAIS modifier le chatbot Claude embarqué (`AdminChatbot`) sans validation explicite de l'admin.** Le chatbot propose, l'admin valide.
2. **TOUJOURS commit + push après chaque modification** (Vercel redéploie ~30 s), et **recopier la modif à l'identique dans `app.jsx`**.
3. **Avant chaque session : `git pull`** (l'admin travaille depuis 2 PC : bureau Windows + Mac perso).
4. **Ne JAMAIS toucher aux clés Supabase ni au mot de passe admin sans demander.**
5. À chaque change visuel important, **bumper le numéro de version** `v2026.MM.JJ-N` (ex. marqueur dans le titre du modal carte planning) pour vérifier côté navigateur qu'on a bien la dernière version (sinon Ctrl+F5).

## Workflow type
1. `git pull`
2. modif demandée par l'admin (dans `app.v6.jsx` **et** `app.jsx`)
3. test si possible
4. `git add` + commit avec message clair en français
5. `git push`
6. attendre ~30 s (Vercel)
7. dire à l'admin de faire Ctrl+F5
