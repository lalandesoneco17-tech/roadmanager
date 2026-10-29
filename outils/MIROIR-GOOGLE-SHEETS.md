# Miroir des pointages dans Google Sheets

Une copie automatique de tous les pointages, en dehors de RoadManager et de Supabase, dans un
classeur Google que tu peux ouvrir, filtrer, imprimer. Toutes les 5 minutes, Google lui-meme va
chercher dans Supabase ce qui a change et l'ajoute au classeur. Rien n'est jamais retire du
classeur : l'onglet « Journal » garde toutes les versions, et Google garde en plus l'historique
des versions du fichier.

## Installation (une seule fois, environ 10 minutes)

1. Dans Google Drive : **Nouveau > Google Sheets**. Nomme-le par exemple « Pointages SONECO (miroir) ».
2. Menu **Extensions > Apps Script**. Un editeur s'ouvre avec un fichier `Code.gs` presque vide.
3. Efface son contenu et colle **tout** le contenu du fichier `outils/miroir-pointages-google-sheets.gs`
   (ouvre-le sur GitHub, bouton « Raw », Ctrl+A, Ctrl+C).
4. Ligne `SUPABASE_ANON_KEY = 'COLLER_ICI_LA_CLE_ANON'` : remplace par la cle qui se trouve dans
   `index.html` de RoadManager, ligne `window.SUPABASE_ANON_KEY='...'` (c'est une cle de lecture
   publique, deja visible dans l'app).
5. Enregistre (icone disquette). En haut, dans la liste des fonctions, choisis **installer** puis **Executer**.
6. Google demande l'autorisation : **Examiner les autorisations** > ton compte > « Parametres avances » >
   « Acceder a ... (non securise) » > Autoriser. C'est normal pour un script personnel.
7. Reviens sur le classeur : les onglets **Pointages** et **Journal** sont remplis. C'est fini.

Ensuite le script tourne tout seul toutes les 5 minutes (menu **Declencheurs** dans Apps Script pour le voir).

## Ce que tu y trouves

- **Pointages** : une ligne par pointage (declare ou valide), avec salarie, date, embauche, pauses,
  debauche, heures travaillees, nuit, et la colonne **Supprime** = OUI pour ce qui est dans la corbeille.
- **Journal** : une ligne par changement vu, dans l'ordre ou ils arrivent. Si une heure a ete modifiee,
  tu vois l'ancienne et la nouvelle, l'une sous l'autre.

## Si ca ne tourne plus

- Apps Script > **Executions** : la derniere ligne dit l'erreur.
- Relancer **installer** remet tout d'aplomb (ca refait une copie complete, sans doublons).
