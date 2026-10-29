// =====================================================================================
//  MIROIR DES POINTAGES ROADMANAGER DANS GOOGLE SHEETS  (Apps Script)
//
//  Toutes les 5 minutes, ce script lit dans Supabase les pointages qui ont change depuis
//  la fois precedente et les recopie dans ce classeur :
//   - onglet « Pointages » : une ligne par pointage, retrouvee par son identifiant et mise a jour
//     (c'est la photo actuelle, supprimes compris, colonne « Supprime »).
//   - onglet « Journal »   : une ligne AJOUTEE a chaque changement vu, jamais modifiee ensuite
//     (c'est l'historique : on y retrouve toutes les versions d'un pointage).
//  En plus, Google garde l'historique des versions du classeur (Fichier > Historique des versions).
//
//  Installation (10 minutes, une seule fois) : voir outils/MIROIR-GOOGLE-SHEETS.md
// =====================================================================================

var SUPABASE_URL = 'https://valtmsgqhrkvwjsdqfdc.supabase.co';
var SUPABASE_ANON_KEY = 'COLLER_ICI_LA_CLE_ANON';   // la meme que dans index.html de RoadManager (ligne window.SUPABASE_ANON_KEY)

var TABLES = ['time_entries', 'time_entries_validated'];
var ENTETE_POINTAGES = ['Identifiant', 'Table', 'Salarie', 'Date', 'Type', 'Embauche', 'Debut pause', 'Fin pause', 'Pauses (min)', 'Repas', 'Absence', 'Debauche', 'Heures travaillees', 'Nuit (h)', 'Supprime', 'Cree le', 'Modifie le'];
var ENTETE_JOURNAL = ['Vu le', 'Table', 'Identifiant', 'Salarie', 'Date', 'Embauche', 'Debauche', 'Pauses (min)', 'Absence', 'Supprime', 'Modifie le'];

// A lancer une fois a la main : cree les onglets, fait une premiere copie complete, pose le declencheur 5 min.
function installer() {
  onglet_('Pointages', ENTETE_POINTAGES);
  onglet_('Journal', ENTETE_JOURNAL);
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'synchroniser') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('synchroniser').timeBased().everyMinutes(5).create();
  PropertiesService.getScriptProperties().deleteAllProperties();
  synchroniser();
  SpreadsheetApp.getActive().toast('Miroir installe : synchronisation toutes les 5 minutes.', 'RoadManager');
}

// Appele toutes les 5 minutes.
function synchroniser() {
  var props = PropertiesService.getScriptProperties();
  var noms = nomsSalaries_();
  var feuilleP = onglet_('Pointages', ENTETE_POINTAGES);
  var feuilleJ = onglet_('Journal', ENTETE_JOURNAL);
  var vuLe = new Date();
  TABLES.forEach(function (table) {
    var depuis = props.getProperty('depuis_' + table) || '1970-01-01T00:00:00Z';
    var lignes = lireDepuis_(table, depuis);
    if (!lignes.length) return;
    ecrirePointages_(feuilleP, table, lignes, noms);
    ecrireJournal_(feuilleJ, table, lignes, noms, vuLe);
    var max = depuis;
    lignes.forEach(function (r) { if (r.updated_at && r.updated_at > max) max = r.updated_at; });
    props.setProperty('depuis_' + table, max);
  });
}

// ---- lecture Supabase (API REST, cle anon : lecture seule ici) ----
function lireDepuis_(table, depuis) {
  var tout = [], page = 1000, offset = 0;
  while (true) {
    var url = SUPABASE_URL + '/rest/v1/' + table + '?select=*&updated_at=gt.' + encodeURIComponent(depuis) +
              '&order=updated_at.asc,id.asc&limit=' + page + '&offset=' + offset;
    var rep = UrlFetchApp.fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY }, muteHttpExceptions: true });
    if (rep.getResponseCode() !== 200) throw new Error('Supabase ' + table + ' : ' + rep.getResponseCode() + ' ' + rep.getContentText().slice(0, 200));
    var lot = JSON.parse(rep.getContentText());
    tout = tout.concat(lot);
    if (lot.length < page) break;
    offset += page;
  }
  return tout;
}

function nomsSalaries_() {
  var noms = {};
  try {
    var url = SUPABASE_URL + '/rest/v1/app_data?select=data->employees&id=eq.main';
    var rep = UrlFetchApp.fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY }, muteHttpExceptions: true });
    if (rep.getResponseCode() === 200) {
      var l = JSON.parse(rep.getContentText());
      ((l[0] && l[0].employees) || []).forEach(function (e) { noms[e.id] = e.name; });
    }
  } catch (e) { }
  return noms;
}

// ---- ecriture dans le classeur ----
function onglet_(nom, entete) {
  var classeur = SpreadsheetApp.getActive();
  var f = classeur.getSheetByName(nom);
  if (!f) { f = classeur.insertSheet(nom); }
  if (f.getLastRow() === 0) {
    f.getRange(1, 1, 1, entete.length).setValues([entete]).setFontWeight('bold');
    f.setFrozenRows(1);
  }
  return f;
}

function ligneP_(table, r, noms) {
  return [r.id, table, noms[r.emp_id] || r.emp_id, r.date, r.type || '', r.start_time || '', r.break_start || '', r.break_end || '',
          r.pause_min || 0, r.meal_type || '', r.absence_type || '', r.end_time || '', heures_(r), r.night_hours || 0,
          r.deleted ? 'OUI' : '', r.created_at ? new Date(r.created_at) : '', r.updated_at ? new Date(r.updated_at) : ''];
}

function ecrirePointages_(feuille, table, lignes, noms) {
  var nb = feuille.getLastRow();
  var index = {};
  if (nb > 1) {
    var ids = feuille.getRange(2, 1, nb - 1, 2).getValues();
    ids.forEach(function (v, i) { index[v[1] + ':' + v[0]] = i + 2; });
  }
  var nouvelles = [];
  lignes.forEach(function (r) {
    var l = ligneP_(table, r, noms);
    var pos = index[table + ':' + r.id];
    if (pos) feuille.getRange(pos, 1, 1, l.length).setValues([l]);
    else nouvelles.push(l);
  });
  if (nouvelles.length) feuille.getRange(feuille.getLastRow() + 1, 1, nouvelles.length, nouvelles[0].length).setValues(nouvelles);
}

function ecrireJournal_(feuille, table, lignes, noms, vuLe) {
  var l = lignes.map(function (r) {
    return [vuLe, table, r.id, noms[r.emp_id] || r.emp_id, r.date, r.start_time || '', r.end_time || '', r.pause_min || 0,
            r.absence_type || '', r.deleted ? 'OUI' : '', r.updated_at ? new Date(r.updated_at) : ''];
  });
  feuille.getRange(feuille.getLastRow() + 1, 1, l.length, l[0].length).setValues(l);
}

// Heures travaillees = debauche - embauche - pauses (passage minuit gere), en decimal
function heures_(r) {
  if (!r.start_time || !r.end_time) return '';
  var s = r.start_time.split(':'), e = r.end_time.split(':');
  var min = (Number(e[0]) * 60 + Number(e[1])) - (Number(s[0]) * 60 + Number(s[1]));
  if (min < 0) min += 24 * 60;
  min -= Number(r.pause_min || 0);
  return Math.round(Math.max(0, min) / 60 * 100) / 100;
}
