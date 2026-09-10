# Règles métier de RoadManager et du bot Telegram

Une ligne par règle, en français simple, avec la date où elle a été fixée.
Ce fichier est la référence : si le bot ou l'app fait autre chose, c'est un bug.
Pour ajouter ou corriger une règle, il suffit de le dire à Claude, qui met à jour
ce fichier ET le code en même temps.

## Le planning de papa (Google Sheets)

- **Case cochée en colonne B ou L** = le chauffeur est au courant de son chantier. C'est ce
  qui déclenche l'envoi d'une fiche au(x) admin(s), à valider avant écriture. (01/09/2026)
- Le bot lit **tout le classeur** (tous les jours à venir), pas seulement le lendemain.
  Ça ne consomme aucun token. (08/09/2026)
- **Une ligne = une fiche, une seule fois.** Deux cases cochées coup sur coup ne renvoient
  pas les mêmes fiches. (08/09/2026)
- Si papa **retouche une ligne déjà cochée** (lieu, heure, client, chef, forfait, nuit), l'admin
  reçoit une fiche « CHANTIER CORRIGÉ » qui remplace la précédente. Pas un nouveau chantier.
  (08/09/2026)
- **Plusieurs chauffeurs au même endroit, chacun avec sa machine, c'est fréquent** : chacun a
  son chantier. Un « chantier déplacé » n'est proposé que si l'ancien chauffeur n'a plus aucune
  ligne ce jour-là, et la fiche dit à qui le chantier est pris. (08/09/2026)
- **Pas d'heure inventée, nulle part** : si papa n'écrit pas d'horaire dans le lieu, la fiche n'a
  pas d'heure, et l'app n'affiche pas de 08:00 à sa place. Un chantier créé dans le planning peut
  rester sans heure ; la case heure se vide si on l'efface. (08 et 09/09/2026)
- **L'heure est dans le champ LIEU** (« giratoire … à 19h »). (30/08/2026)
- **« dépôt »** dans le lieu ou le client = entrée Dépôt dans le planning, écrite directement
  sans fiche. Le dépôt n'est précisé que si papa l'écrit (« dépôt 17 »). « réparation »,
  « rangement » remplissent l'activité, sinon elle reste vide. (09/09/2026)
- **« repos »** = entrée Repos dans le planning, écrite directement. Ça veut dire que le chauffeur
  a fait la nuit la veille et n'a rien de prévu. (09/09/2026)
- « bricodépôt », « RN 141 devant le dépôt » sont des **chantiers**, pas des dépôts. (09/09/2026)
- Ligne **effacée** du classeur alors que le chantier existe dans RoadManager : fiche de
  suppression à valider. Case simplement **décochée** : rien n'est supprimé, un recochage renvoie
  la fiche. (01/09/2026)
- Bloc de droite : les **3 derniers emplacements sont les citernes**, les 11 premiers les
  balayeuses. La lettre est la première lettre de la marque (R, V, MA, M, VB, RB, S). (30/08/2026)
- **Case de la 2e ligne** d'un chauffeur = chantier de **nuit**. (30/08/2026)

## Le planning (vue tableau, 10/09/2026)

- Le planning de RoadManager est **à l'image de la feuille de papa** : raboteuses à gauche,
  balayeuses puis citernes à droite, une carte par machine dans l'ordre de la feuille
  (raboteuses par largeur décroissante), **deux lignes de chantier** par carte au minimum.
- Le **prénom du chauffeur est à gauche** de la carte, la machine à sa droite. Un petit bouton
  seul prévient le chauffeur (envoi sur son téléphone) et met son carré en **vert**. Quand il a lu,
  seule la **ligne passe en vert pâle** ; le contour garde la couleur de la machine.
- Un deuxième chauffeur sur la même machine (ex. la 35 : Jérémy le jour, Cédric la nuit) va dans
  le carré de gauche, **au-dessus, séparé par un trait**, en face de sa ligne. Le petit + dans le
  coin du carré sert à l'ajouter.
- Les cases de papa sont là : **nuit** (ligne rouge), **payé** (client rose), **bon envoyé**
  (forfait jaune). Les cases client, chef, lieu, forfait restent **blanches, sans texte** dedans.
- **L'heure se tape dans le lieu** (« … à 21h ») et devient l'heure du chantier. Aucune heure
  pointée n'est affichée sur le planning : les heures sont dans la page Heures.
- Le **chiffre d'affaires** du jour est en haut, par raboteuses, balayeuses, citernes et total.
- La journée entière **tient sur l'écran** : la vue se réduit automatiquement à la taille de
  l'écran, sans défiler. Le bouton « Vue classique » redonne l'ancien planning.

## Le bot Telegram

- Le bot **propose, l'admin valide**. Aucune écriture dans le planning sans bouton Valider,
  sauf les états dépôt/repos. (30/08/2026)
- Un chef de chantier cité **sans numéro** : le bot cherche dans les fiches clients et fait
  confirmer, il ne choisit jamais seul. (02/09/2026)
- La mémoire du bot vit dans la base et **l'app ne la touche jamais**. (08/09/2026)

## L'espace chauffeur

- Un **chantier de nuit de la veille** non terminé reste le chantier en cours **jusqu'à midi** :
  « Fin de chantier » le clôture, lui, pas le chantier du jour. (08/09/2026)
- La fin de chantier demande d'abord l'heure de début retenue ; un chantier qui déborde
  repousse le suivant, les pauses sont déduites. (04/09/2026)
- Un pointage ne se supprime que par une **suppression explicite** : jamais déduit d'une
  absence. (juillet 2026)

## Les pointages

- Chaque pointage est une ligne à part dans Supabase. Une **colonne manquante** côté Supabase
  ne bloque plus l'envoi : le champ est ignoré et le pointage part quand même. (08/09/2026)
- Les pointages qui n'ont pas pu partir sont **rejoués automatiquement** toutes les 30 secondes,
  et une embauche en double (re-clic pendant une panne) est ignorée. (08/09/2026)
