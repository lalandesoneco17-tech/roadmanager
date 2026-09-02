// ============================================================================
// RoadManager — Webhook Telegram (Supabase Edge Function)
// ----------------------------------------------------------------------------
// Recoit les "updates" Telegram :
//   1) /start emp_<id>  -> lie le Telegram d'un salarie (stocke dans le blob app_data)
//   2) /start admin     -> lie le Telegram de l'admin
//   3) callback_query "rentrer:<empId>" / "plan:<empId>" -> envoie un message au salarie
//      (+ son planning du lendemain) quand l'admin appuie sur un bouton sous la notif.
//
// Aucune cle secrete a configurer : le token du bot est lu depuis app_data
// (data.telegramBotToken), et SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sont
// fournis automatiquement par Supabase.
//
// IMPORTANT au deploiement : desactiver "Verify JWT" (sinon Telegram recoit 401).
// ============================================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function loadData(): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/app_data?id=eq.main&select=data`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const rows = await r.json();
  return (rows && rows[0] && rows[0].data) || {};
}

async function saveData(data: any): Promise<void> {
  data._lastSaver = "telegram-bot";
  data._lastSaveAt = Date.now();
  await fetch(`${SB_URL}/rest/v1/app_data?id=eq.main`, {
    method: "PATCH",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
  });
}

function isoTomorrow(): string {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
}

function adminChatList(data: any): string[] {
  const s = new Set<string>();
  if (data.telegramAdminChatId) s.add(String(data.telegramAdminChatId));
  (data.telegramAdminChats || []).forEach((a: any) => { const c = a && (a.chatId || a); if (c) s.add(String(c)); });
  return [...s];
}

function parseCoordsF(s: any): number[] | null {
  if (!s) return null;
  const p = String(s).split(",").map(Number);
  return p.length === 2 && !isNaN(p[0]) && !isNaN(p[1]) ? p : null;
}

function jobLineF(data: any, job: any): string {
  const c = (data.clients || []).find((x: any) => x.id === job.clientId);
  const m = (data.machines || []).find((x: any) => x.id === job.machineId);
  return (job.billingStart || "") + " " + (job.location || (c ? c.name : "chantier")) +
    (c && job.location ? " (" + c.name + ")" : "") + (m ? " [" + m.name + "]" : "");
}

function stripAccents(s: string): string { return s.normalize("NFD").replace(/[̀-ͯ]/g, ""); }
function isoParis(dt: Date): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(dt); }
function labelParis(dt: Date): string { return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "2-digit", month: "2-digit" }).format(dt); }
function planningForISO(data: any, iso: string, label: string): string {
  const jobs = (data.jobs || []).filter((j: any) => j.date === iso).sort((a: any, b: any) => String(a.billingStart || "").localeCompare(String(b.billingStart || "")));
  if (!jobs.length) return "📅 " + label + "\nAucun chantier prévu.";
  const lines = ["📅 " + label + " — " + jobs.length + " chantier(s) :"];
  for (const j of jobs) {
    const e = (data.employees || []).find((x: any) => x.id === j.employeeId);
    const who = e ? e.name : "—";
    if (j.type === "depot") { lines.push("• " + who + " : 🏭 dépôt" + (j.depotActivity ? " (" + j.depotActivity + ")" : "")); continue; }
    if (j.type === "repos") { lines.push("• " + who + " : 😴 repos"); continue; }
    const c = (data.clients || []).find((x: any) => x.id === j.clientId);
    const m = (data.machines || []).find((x: any) => x.id === j.machineId);
    lines.push("• " + (j.billingStart || "") + " " + who + " → " + (j.location || (c ? c.name : "chantier")) + (c && j.location ? " (" + c.name + ")" : "") + (m ? " [" + m.name + "]" : ""));
  }
  return lines.join("\n");
}
function helpText(): string { return "ℹ️ Demande-moi le planning :\n• « aujourd'hui »\n• « demain »\n• « lundi » (ou un autre jour)\n• « 28/06 » (une date)\n• « semaine »"; }
const MENU_KB = { inline_keyboard: [[{ text: "📅 Aujourd'hui", callback_data: "q:auj" }, { text: "Demain", callback_data: "q:demain" }], [{ text: "📆 Cette semaine", callback_data: "q:semaine" }]] };
function handleAdminQuery(data: any, raw: string): string | null {
  const t = stripAccents(String(raw).toLowerCase().trim()).replace(/^\//, "");
  const now = new Date();
  const add = (n: number) => new Date(now.getTime() + n * 86400000);
  if (t === "aujourdhui" || t === "auj" || t === "jour" || t === "today") return planningForISO(data, isoParis(now), "Aujourd'hui (" + labelParis(now) + ")");
  if (t === "demain") { const d = add(1); return planningForISO(data, isoParis(d), "Demain (" + labelParis(d) + ")"); }
  if (t === "apres-demain" || t === "apres demain" || t === "surlendemain") { const d = add(2); return planningForISO(data, isoParis(d), labelParis(d)); }
  const dayNames = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  if (dayNames.includes(t)) {
    for (let k = 0; k <= 7; k++) { const d = add(k); const name = stripAccents(new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "long" }).format(d).toLowerCase()); if (name === t) return planningForISO(data, isoParis(d), labelParis(d)); }
  }
  const md = t.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
  if (md) {
    const dd = md[1].padStart(2, "0"); const mm = md[2].padStart(2, "0");
    let yyyy = md[3] || isoParis(now).slice(0, 4); if (yyyy.length === 2) yyyy = "20" + yyyy;
    return planningForISO(data, yyyy + "-" + mm + "-" + dd, "Le " + dd + "/" + mm);
  }
  if (t === "semaine" || t === "sem" || t === "cette semaine") {
    const parts: string[] = [];
    for (let k = 0; k < 7; k++) { const d = add(k); parts.push(planningForISO(data, isoParis(d), labelParis(d))); }
    return parts.join("\n\n");
  }
  if (t === "aide" || t === "menu" || t === "help" || t === "?" || t === "commandes") return helpText();
  return null;
}

// ===== Hybride IA : repond aux questions libres des admins via Claude (seulement si une commande gratuite ne matche pas) =====
function buildAIContext(data: any): string {
  const tz = "Europe/Paris";
  const isoP = (dt: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(dt);
  const hhmmP = (iso: string) => { try { return new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)); } catch (_e) { return ""; } };
  const dur = (mn: any) => (mn != null ? Math.floor(mn / 60) + "h" + String(mn % 60).padStart(2, "0") : "");
  const today = isoP(new Date());
  const lo = isoP(new Date(Date.now() - 7 * 86400000));
  const hi = isoP(new Date(Date.now() + 31 * 86400000));
  const teLo = isoP(new Date(Date.now() - 14 * 86400000));
  const empById = (id: string) => (data.employees || []).find((x: any) => x.id === id);
  const emps = (data.employees || []).map((e: any) => e.name).filter(Boolean);
  const machines = (data.machines || []).map((m: any) => m.name + (m.type ? " (" + m.type + ")" : "")).filter(Boolean);
  const depots = (data.depots || []).map((d: any) => d.name).filter(Boolean);
  const clients = (data.clients || []).map((c: any) => c.name).filter(Boolean);
  const jobs = (data.jobs || []).filter((j: any) => j.date >= lo && j.date <= hi)
    .sort((a: any, b: any) => (a.date + (a.billingStart || "")).localeCompare(b.date + (b.billingStart || "")));
  const jobLines = jobs.map((j: any) => {
    const e = empById(j.employeeId);
    const c = (data.clients || []).find((x: any) => x.id === j.clientId);
    const m = (data.machines || []).find((x: any) => x.id === j.machineId);
    const p = [j.date, (j.billingStart || "--"), (e ? e.name : "?"), (j.location || (c ? c.name : "chantier"))];
    if (c && j.location) p.push("client " + c.name);
    if (m) p.push(m.name);
    if (j.forfaitType) p.push("forfait " + j.forfaitType);
    if (j.priceForfait) p.push(j.priceForfait + "€");
    if (j.type === "depot") p.push("DEPOT");
    if (j.type === "repos") p.push("REPOS");
    if (j.signature) {
      if (j.signature.durationMin != null) p.push("temps passé " + dur(j.signature.durationMin));
      if (j.signature.signedAt) p.push("fin chantier " + hhmmP(j.signature.signedAt));
      p.push("signé");
    }
    p.push("job_id=" + j.id);
    return "- " + p.join(" | ");
  });
  const tes = (data.timeEntries || []).filter((t: any) => t.date >= teLo && t.date <= today)
    .sort((a: any, b: any) => (a.date).localeCompare(b.date));
  const teLines = tes.map((t: any) => {
    const e = empById(t.empId);
    return "- " + t.date + " | " + (e ? e.name : "?") + " | embauche " + (t.startTime || "--") + " | débauche " + (t.endTime || "--") + (t.pauseMin ? " | pause " + t.pauseMin + "min" : "") + (t.absenceType ? " | ABSENCE " + t.absenceType : "");
  });
  const stock = (data.stationProducts || []).map((pr: any) => {
    const s = (data.stations || []).find((x: any) => x.id === pr.stationId);
    return "- " + (s ? s.name : "?") + " | " + pr.name + " : " + (pr.quantity != null ? pr.quantity : "?") + (pr.unit ? " " + pr.unit : "") + (pr.minStock ? " (mini " + pr.minStock + ")" : "");
  });
  const dayLabel = (dt: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: tz, weekday: "long", day: "2-digit", month: "2-digit" }).format(dt);
  const drivers = (data.employees || []).filter((e: any) => e.role !== "mechanic");
  const availLines: string[] = [];
  for (let k = 0; k <= 10; k++) {
    const dd = new Date(Date.now() + k * 86400000);
    const iso = isoP(dd);
    const ids = new Set((data.jobs || []).filter((j: any) => j.date === iso && j.type !== "repos" && j.type !== "depot").map((j: any) => j.employeeId));
    const avec = drivers.filter((e: any) => ids.has(e.id)).map((e: any) => e.name);
    const sans = drivers.filter((e: any) => !ids.has(e.id)).map((e: any) => e.name);
    availLines.push(dayLabel(dd) + " → avec chantier : " + (avec.join(", ") || "personne") + " | SANS chantier : " + (sans.join(", ") || "personne"));
  }
  return [
    "AUJOURD'HUI (Europe/Paris) : " + today,
    "Note : 'temps passé' = durée travaillée sur le chantier (calculée à la signature/fin de chantier). 'fin chantier' = heure de fin du chantier. 'débauche' (section POINTAGES) = heure de fin de journée du chauffeur.",
    "SALARIÉS : " + emps.join(", "),
    "MACHINES : " + machines.join(", "),
    "DÉPÔTS : " + depots.join(", "),
    "CLIENTS : " + clients.join(", "),
    "",
    "CHANTIERS (date | heure | chauffeur | lieu | client | machine | forfait | prix | [temps passé | fin chantier | signé]) du " + lo + " au " + hi + " :",
    jobLines.length ? jobLines.join("\n") : "(aucun)",
    "",
    "DISPONIBILITÉ PAR JOUR — pour toute question du type « qui travaille / qui est libre / qui n'a pas de chantier tel jour », utilise EXACTEMENT cette liste (déjà calculée), ne déduis pas toi-même :",
    availLines.join("\n"),
    "",
    "POINTAGES (date | chauffeur | embauche | débauche | pause) des 14 derniers jours :",
    teLines.length ? teLines.join("\n") : "(aucun)",
    "",
    "STOCK STATIONS (station | produit : quantité (mini)) :",
    stock.length ? stock.join("\n") : "(aucun)",
  ].join("\n");
}

async function askAI(data: any, question: string): Promise<string | null> {
  const key = data.anthropicApiKey;
  if (!key) return null;
  const system = "Tu es l'assistant de gestion de SONECO. Tu réponds en français aux questions de l'admin en t'appuyant UNIQUEMENT sur les données ci-dessous.\n\nRÈGLE ABSOLUE : réponds UNIQUEMENT à ce qui est demandé, rien de plus. La réponse la plus courte et directe possible. INTERDIT : préambule, phrase d'introduction, récapitulatif, conclusion, détail non demandé, titre, mise en forme Markdown (#, *, _). \nExemple : question « combien de temps a passé Franck sur son dernier chantier ? » -> réponse attendue : « ST SULPICE DE ROYAN (Volvo) : 6h34 ». Rien d'autre.\nSi l'information n'est pas dans les données, dis-le en une seule phrase courte.\n\n=== DONNÉES ===\n" + buildAIContext(data);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: data.aiModel || "claude-haiku-4-5",
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: question }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return null;
    const txt = ((j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")).trim();
    return txt || null;
  } catch (_e) {
    return null;
  }
}

function empName(data: any, empId: string): string {
  const e = (data.employees || []).find((x: any) => x.id === empId);
  return e ? e.name : "le salarié";
}

function nextDayPlan(data: any, empId: string): string {
  // Cherche le PROCHAIN jour qui a un chantier (ex: le vendredi -> lundi si rien le week-end)
  const tz = "Europe/Paris";
  const isoOf = (dt: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(dt);
  const now = new Date();
  for (let k = 1; k <= 10; k++) {
    const dd = new Date(now.getTime() + k * 86400000);
    const iso = isoOf(dd);
    const jobs = (data.jobs || []).filter((j: any) => j.employeeId === empId && j.date === iso);
    if (jobs.length) {
      const dl = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, weekday: "long", day: "2-digit", month: "2-digit" }).format(dd);
      const lines = ["📅 Prochain jour de travail — " + dl + " :"];
      for (const j of jobs) lines.push("• " + jobLineF(data, j));
      lines.push("", "⚠️ Ce planning n'est pas encore définitif — une confirmation te sera envoyée en fin de journée.");
      return lines.join("\n");
    }
  }
  return "📅 Rien de prévu pour toi dans les prochains jours.";
}

// Variantes de formulation : on en tire une au hasard pour que les messages changent a chaque fois
function pick(arr: string[]): string { return arr[Math.floor(Math.random() * arr.length)]; }
const HELLOS = ["👋 Salut", "👋 Hello", "👋 Coucou", "Salut", "👋 Hey"];
const THANKS = [
  "Bonne route, et merci pour ton travail aujourd'hui 🙏",
  "Merci pour aujourd'hui, fais bonne route ! 🚗",
  "Beau boulot aujourd'hui, rentre bien ! 💪",
  "Merci pour ton taf, bonne route à toi 🙏",
  "Bonne route et repose-toi bien ! 😊",
  "Super journée, merci à toi et rentre bien ! 🙌",
];
const NEXT_INTRO = [
  "Quand tu peux, tu peux filer sur le prochain chantier 🚗 :",
  "Direction le prochain chantier dès que tu es prêt 🚗 :",
  "Tu peux enchaîner sur le prochain chantier 🚗 :",
  "Prochaine étape, le chantier suivant 🚗 :",
];
const PLAN_INTRO = ["Voici ton planning 📅", "Ton planning à venir 📅", "Voilà ce qui t'attend 📅", "Ton prochain rendez-vous de travail 📅"];
const WEEKEND = [
  "🌞 Et passe un très bon week-end !",
  "🌞 Profite bien de ton week-end !",
  "🎉 Bon week-end à toi, tu l'as bien mérité !",
  "😎 Repose-toi bien ce week-end !",
  "🌴 Excellent week-end !",
  "🍻 Bon week-end, à lundi !",
];
function hi(name: string): string { return pick(HELLOS) + " " + name + " !"; }

// Souhaite un bon week-end si on est vendredi/samedi ET que le salarie n'a pas de chantier le week-end
function weekendWish(data: any, empId: string): string {
  const tz = "Europe/Paris";
  const wdName = (dt: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(dt);
  const now = new Date();
  const todayWd = wdName(now);
  if (todayWd !== "Friday" && todayWd !== "Saturday") return "";
  let weekendWork = false;
  for (let k = 1; k <= 2; k++) {
    const d = new Date(now.getTime() + k * 86400000);
    const w = wdName(d);
    if (w === "Saturday" || w === "Sunday") {
      const iso = isoParis(d);
      if ((data.jobs || []).some((j: any) => j.employeeId === empId && j.date === iso)) weekendWork = true;
    }
  }
  return weekendWork ? "" : "\n\n" + pick(WEEKEND);
}

// ===== Coordination multi-admins (Option 1) =====
// Une notif a boutons est envoyee a TOUS les admins : chaque copie est enregistree dans data.tgGroups
// ({id, text, msgs:[{c:chatId, m:messageId}], doneBy, doneAt}). Au 1er clic, on execute l'action UNE fois,
// on marque doneBy=<prenom> et on edite TOUTES les copies (boutons retires + "✅ Traité par X").
function tgFindGroup(data: any, chatId: any, messageId: any): any {
  for (const g of (data.tgGroups || [])) {
    if ((g.msgs || []).some((m: any) => String(m.c) === String(chatId) && Number(m.m) === Number(messageId))) return g;
  }
  return null;
}
function tgPresser(data: any, chatId: any): string {
  const a = (data.telegramAdminChats || []).find((x: any) => String(x.chatId) === String(chatId));
  return (a && a.name) ? a.name : "un admin";
}
async function tgFinalizeGroup(tg: any, group: any, presser: string, resultLine: string): Promise<void> {
  group.doneBy = presser;
  group.doneAt = Date.now();
  if (resultLine) group.result = resultLine;
  const base = group.text ? group.text + "\n\n" : "";
  const txt = base + "✅ Traité par " + presser + (resultLine ? " — " + resultLine : "");
  for (const m of (group.msgs || [])) {
    try { await tg("editMessageText", { chat_id: m.c, message_id: m.m, text: txt, disable_web_page_preview: true }); } catch (_e) { /* ignore */ }
  }
}

// ============================================================================
// ===== AGENT IA : lecture ET ECRITURE dans RoadManager ======================
// ----------------------------------------------------------------------------
// L'admin ecrit en langage naturel ("mardi 1er sept, Jerome, la 210, nuit,
// Ferroviaire, giratoire route de Chevres, 19h"). L'agent :
//   1. retrouve le chauffeur / la machine / le client dans les donnees,
//   2. RELIT ce qu'il a compris et attend un clic "Valider",
//   3. ecrit seulement apres validation.
// Rien n'est jamais ecrit sans validation explicite de l'admin.
// ============================================================================

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// Sauvegarde sure : on RELIT juste avant d'ecrire, pour ne pas ecraser les
// modifs faites depuis l'app (PC/Mac/tel) pendant qu'on reflechissait.
async function mutate(fn: (d: any) => void): Promise<any> {
  const fresh = await loadData();
  fn(fresh);
  await saveData(fresh);
  return fresh;
}

function normTxt(s: any): string {
  return stripAccents(String(s == null ? "" : s).toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim();
}

// ---- Moteur de forfaits (copie fidele de app.v6.jsx lignes 158-169) ----
function getMachineWidth(m: any): string {
  const s = String((m && m.width) || "") || String((m && m.name) || "");
  const d = s.match(/\d+/);
  return d ? d[0] : "";
}
function getForfaitKey(data: any, cid: string, machine: any): string | null {
  if (!machine) return null;
  const c = (data.clients || []).find((x: any) => x.id === cid);
  const p = (c && c.forfaitType === "specific") ? cid : "standard";
  if (machine.type === "Raboteuse") return p + "_rab_" + getMachineWidth(machine);
  if (machine.type === "Balayeuse") return p + "_bal";
  if (machine.type === "Citerne") return p + "_cit";
  return null;
}
function getForfaitPrice(data: any, cid: string, machine: any, ft: string, citOpt: string | null, isNight: boolean): number {
  if (!ft) return 0;
  let key = getForfaitKey(data, cid, machine);
  if (!key) return 0;
  if (machine.type === "Citerne") key += "_" + (citOpt || "Avec chauffeur");
  let g = (data.forfaits || {})[key];
  if (!g && key.indexOf("standard") !== 0) {
    // client "specific" sans grille propre -> on retombe sur la grille standard
    g = (data.forfaits || {})[key.replace(/^[^_]+_/, "standard_")];
  }
  let pr = Number((g || {})[ft] || 0);
  if (isNight) pr *= 1 + (Number(data.nightPct || 30) / 100);
  return Math.round(pr * 100) / 100;
}

// ---- Resolution des noms dictes -> vrais enregistrements -------------------
// On ne devine JAMAIS : en cas de doute on renvoie une erreur que l'agent
// transforme en question a l'admin.
function resolveEmployee(data: any, q: string): any {
  const n = normTxt(q);
  const list = (data.employees || []).filter((e: any) => e && e.name);
  if (!n) return { error: "Chauffeur non precise." };
  const first = (e: any) => normTxt(e.name).split(" ")[0];
  let hits = list.filter((e: any) => normTxt(e.name) === n);
  if (!hits.length) hits = list.filter((e: any) => first(e) === n);
  if (!hits.length) hits = list.filter((e: any) => normTxt(e.name).split(" ").indexOf(n) >= 0);
  if (!hits.length) hits = list.filter((e: any) => normTxt(e.name).indexOf(n) === 0);
  if (!hits.length) hits = list.filter((e: any) => normTxt(e.name).indexOf(n) >= 0);
  if (!hits.length) return { error: 'Aucun chauffeur ne correspond a "' + q + '". Chauffeurs existants : ' + list.map((e: any) => e.name).join(", ") };
  if (hits.length > 1) return { error: 'Plusieurs chauffeurs correspondent a "' + q + '" : ' + hits.map((e: any) => e.name).join(", ") + ". Demande a l'admin lequel." };
  return { emp: hits[0] };
}

function resolveMachine(data: any, q: string, emp?: any): any {
  const raw = String(q == null ? "" : q).trim();
  const n = normTxt(raw);
  const dg = (raw.match(/\d+/) || [])[0] || "";
  const list = (data.machines || []).filter((m: any) => m && m.name);
  if (!n) return { error: "Machine non precisee." };
  const numOf = (m: any) => (String(m.name).match(/\d+/) || [])[0] || "";
  // Le pere ecrit "100 cfi", RoadManager stocke "100cfi" : on compare sans les espaces.
  const squash = (x: any) => normTxt(x).replace(/ /g, "");
  const sq = squash(raw);
  const exact = list.filter((m: any) => squash(m.name) === sq);
  if (exact.length === 1) return { machine: exact[0] };
  // La MACHINE ATTRIBUEE au chauffeur tranche l'ambiguite : le planning du pere ecrit
  // "210", et RoadManager a 210fi (Jerome) et 210i (Jeremy). Le chauffeur suffit a choisir.
  if (emp && emp.machineId) {
    const own = list.find((m: any) => m.id === emp.machineId);
    if (own && (squash(own.name) === sq || normTxt(own.name) === n || (dg && (numOf(own) === dg || getMachineWidth(own) === dg)) || (!dg && n && normTxt(own.name).indexOf(n) >= 0))) {
      return { machine: own };
    }
  }
  let hits = list.filter((m: any) => normTxt(m.name) === n);
  if (!hits.length && dg) hits = list.filter((m: any) => numOf(m) === dg);
  if (!hits.length && dg) hits = list.filter((m: any) => getMachineWidth(m) === dg);
  if (!hits.length) hits = list.filter((m: any) => normTxt(m.name).indexOf(n) >= 0);
  if (!hits.length) return { error: 'Aucune machine ne correspond a "' + q + '". Machines existantes : ' + list.map((m: any) => m.name).join(", ") };
  if (hits.length > 1) return { error: 'Plusieurs machines correspondent a "' + q + '" : ' + hits.map((m: any) => m.name).join(", ") + ". Demande a l'admin laquelle." };
  return { machine: hits[0] };
}

// Le client peut ne pas exister encore -> on le signale, il sera cree a la validation.
function resolveClient(data: any, q: string): any {
  const raw = String(q == null ? "" : q).trim();
  if (!raw) return { client: null };
  const n = normTxt(raw);
  const list = (data.clients || []).filter((c: any) => c && c.name);
  let hits = list.filter((c: any) => normTxt(c.name) === n);
  if (!hits.length) hits = list.filter((c: any) => normTxt(c.name).indexOf(n) === 0);
  if (!hits.length) hits = list.filter((c: any) => normTxt(c.name).indexOf(n) >= 0 || n.indexOf(normTxt(c.name)) >= 0);
  if (hits.length === 1) return { client: hits[0] };
  if (hits.length > 1) return { error: 'Plusieurs clients correspondent a "' + raw + '" : ' + hits.map((c: any) => c.name).join(", ") + ". Demande a l'admin lequel." };
  return { client: null, isNew: true, newName: raw };
}

// ---- Recherche d'un chef de chantier dans les fiches contact ----------------
// Les noms sont saisis a la main et varient ("cristof" / "crystof" / "Christophe"),
// donc on cherche de facon tolerante et on FAIT CONFIRMER, on ne choisit jamais seul.
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1); for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
// Carnet de contacts importe du PDF, range dans une table a part : il n'est lu QUE
// sur une recherche de chef, jamais avec le reste des donnees.
let _carnet: any[] | null = null;
async function carnetContacts(): Promise<any[]> {
  if (_carnet) return _carnet;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_extra?id=eq.contacts&select=data`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!r.ok) { _carnet = []; return _carnet; }
    const rows = await r.json();
    _carnet = (rows && rows[0] && rows[0].data) || [];
  } catch (_e) { _carnet = []; }
  return _carnet;
}

function chercherContact(data: any, nom: string, clientNom?: string): any[] {
  const n = normTxt(nom);
  if (!n) return [];
  const out: any[] = [];
  for (const c of (data.clients || [])) {
    for (const s of (c.siteManagers || [])) {
      const sn = normTxt(s && s.name);
      if (!sn) continue;
      let score = 0;
      const mini = Math.min(sn.length, n.length);
      if (sn === n) score = 100;
      // Longueur minimale : sans elle, une fiche nommee "i" ou "f" correspond a tout.
      else if (mini >= 4 && (sn.indexOf(n) === 0 || n.indexOf(sn) === 0)) score = 85;
      else if (mini >= 4 && (sn.indexOf(n) >= 0 || n.indexOf(sn) >= 0)) score = 75;
      else {
        const d = levenshtein(sn, n);
        if (d <= 2 && Math.max(sn.length, n.length) >= 5) score = 72 - d * 6;
      }
      // Un nom de famille en commun vaut mieux qu'une ressemblance vague ("alin seche" -> "alain seche").
      const ta = sn.split(" ").filter((x: string) => x.length >= 3);
      const tb = n.split(" ").filter((x: string) => x.length >= 3);
      const communs = ta.filter((x: string) => tb.indexOf(x) >= 0).length;
      if (communs) score = Math.max(score, 80 + communs * 5);
      if (!score) continue;
      if (clientNom && normTxt(c.name) === normTxt(clientNom)) score += 12;  // meme client : plus probable
      out.push({ score, nom: s.name, tel: (s.phone || "").trim(), client: c.name });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 6);
}
// Recherche unifiee : fiches clients de RoadManager d'abord, puis carnet importe.
async function chercherContactTout(data: any, nom: string, clientNom?: string): Promise<any[]> {
  const res = chercherContact(data, nom, clientNom);
  const vus = new Set(res.map((x: any) => normTxt(x.nom)));
  const n0 = normTxt(nom);
  for (const c of await carnetContacts()) {
    const cn = normTxt(c.n);
    if (!cn || vus.has(cn)) continue;
    let sc = 0;
    if (cn === n0) sc = 100;
    else if (cn.split(" ").indexOf(n0) >= 0) sc = 88;
    else if (n0.length >= 4 && cn.indexOf(n0) >= 0) sc = 76;
    else if (Math.min(cn.length, n0.length) >= 5 && levenshtein(cn, n0) <= 2) sc = 66;
    if (sc) res.push({ score: sc, nom: c.n, tel: (c.t || []).join(" / "), client: "carnet" });
  }
  res.sort((x: any, y: any) => y.score - x.score);
  return res.slice(0, 8);
}

function rendreContacts(res: any[], nom: string): string {
  if (!res.length) return "Aucun contact ne ressemble a \"" + nom + "\" dans les fiches clients.";
  const L = ["Contacts trouves pour \"" + nom + "\" (a FAIRE CONFIRMER par l'admin, ne choisis pas seul).", "Source « carnet » = repertoire telephonique importe ; les autres viennent des fiches clients :"];
  for (const r of res) {
    L.push("- " + r.nom + (r.tel ? " " + r.tel : " (aucun numero enregistre)") + " | client " + r.client
      + (r.score >= 100 ? " | nom identique" : r.score >= 85 ? " | nom tres proche" : " | orthographe differente"));
  }
  return L.join("\n");
}
// Lieu trop vague pour envoyer un chauffeur : ni numero de rue, ni route/rd, ni GPS.
function lieuImprecis(lieu: string): boolean {
  const t = normTxt(lieu);
  if (!t) return true;
  if (/\d/.test(t)) return false;                                    // un numero ou une RD
  if (/\b(rue|route|rte|avenue|av|bd|boulevard|chemin|impasse|place|zone|za|zi|giratoire|rond point|parking|carrefour)\b/.test(t)) return false;
  return t.split(" ").length <= 3;                                   // juste un nom de commune
}

// ---- Rendu d'un chantier pour la relecture ---------------------------------
function fmtDateFR(iso: string): string {
  try {
    const [y, m, d] = String(iso).split("-").map(Number);
    return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "2-digit", month: "2-digit" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  } catch (_e) { return String(iso); }
}

function jobRecap(data: any, j: any, extra: any): string[] {
  const emp = (data.employees || []).find((x: any) => x.id === j.employeeId);
  const mac = (data.machines || []).find((x: any) => x.id === j.machineId);
  const cli = (data.clients || []).find((x: any) => x.id === j.clientId);
  const cliName = (extra && extra.newClientName) || (cli ? cli.name : "");
  const L: string[] = [];
  L.push(fmtDateFR(j.date) + (j.isNight ? "  \u{1F319} NUIT" : ""));
  // Le type de machine change tout pour le chauffeur : raboteuse, balayeuse ou citerne.
  const ICONE: any = { Raboteuse: "\u{1F69C}", Balayeuse: "\u{1F9F9}", Citerne: "\u{1F4A7}" };
  const typ = mac && mac.type ? mac.type : "";
  L.push("\u{1F464} " + (emp ? emp.name : "?") + "   " + (ICONE[typ] || "\u{1F69C}") + " " + (mac ? mac.name : "?") + (typ ? " (" + typ.toLowerCase() + ")" : ""));
  const lieuLine = [j.location || "", cliName ? "(" + cliName + (extra && extra.newClientName ? " — NOUVEAU CLIENT" : "") + ")" : ""].filter(Boolean).join(" ");
  if (lieuLine) L.push("\u{1F4CD} " + lieuLine);
  const money: string[] = [];
  if (j.billingStart) money.push(j.billingStart);
  if (j.forfaitType) money.push("forfait " + j.forfaitType);
  if (j.priceForfait) money.push(j.priceForfait + " €");
  if (j.hasTransfer) money.push("+ transfert " + (j.transferPrice || 0) + " €");
  if (money.length) L.push("\u{1F551} " + money.join("  ·  "));
  if (j.siteManager || j.siteManagerPhone) L.push("\u{1F477} Chef : " + (j.siteManager || "?") + (j.siteManagerPhone ? "  " + j.siteManagerPhone : ""));
  const lienJ = lienMaps(j);
  if (lienJ) L.push("\u{1F5FA} " + lienJ);
  return L;
}

// ---- Contexte transmis a l'agent ------------------------------------------
function agentContext(data: any, chatId?: string): string {
  const now = new Date();
  const cal: string[] = [];
  for (let k = -1; k <= 14; k++) {
    const d = new Date(now.getTime() + k * 86400000);
    cal.push(labelParis(d) + " = " + isoParis(d));
  }
  const emps = (data.employees || []).filter((e: any) => e.role !== "mechanic").map((e: any) => e.name).filter(Boolean);
  const macs = (data.machines || []).map((m: any) => m.name + " (" + (m.type || "?") + (m.width ? ", " + m.width : "") + ")").filter(Boolean);
  const clis = (data.clients || []).map((c: any) => c.name).filter(Boolean);
  return [
    "AUJOURD'HUI (Europe/Paris) : " + isoParis(now) + " (" + labelParis(now) + ")",
    "",
    "CALENDRIER (pour convertir une date dite a l'oral en date ISO) :",
    cal.join("\n"),
    "",
    "CHAUFFEURS : " + (emps.join(", ") || "(aucun)"),
    "MACHINES : " + (macs.join(", ") || "(aucune)"),
    "CLIENTS : " + (clis.join(", ") || "(aucun)"),
    "",
    ficheEnAttente(data, chatId),
    "FORFAITS possibles : 2h, 4h, 6h, 8h, 10h (raboteuse/balayeuse) — Demi-journee, Journee (citerne).",
    "Majoration de nuit : +" + (data.nightPct || 30) + "%.",
  ].join("\n");
}

// Fiches deja envoyees mais pas encore validees : l'admin veut souvent les completer
// (ajouter le chef de chantier, un point GPS) AVANT de valider.
function ficheEnAttente(data: any, chatId?: string): string {
  const ps = (data.tgProposals || []).filter((p: any) => !chatId || String(p.chatId) === String(chatId));
  if (!ps.length) return "";
  const L = ["", "FICHES ENVOYEES, EN ATTENTE DE VALIDATION (completables avec completer_fiche) :"];
  for (const p of ps) {
    const j = p.job || {};
    const e = (data.employees || []).find((x: any) => x.id === j.employeeId);
    const m = (data.machines || []).find((x: any) => x.id === j.machineId);
    const c = (data.clients || []).find((x: any) => x.id === j.clientId);
    const d = [j.date || "?", e ? e.name : "?", m ? m.name : "?", c ? c.name : (p.newClientName || ""), j.location || "", j.billingStart || ""].filter(Boolean);
    L.push("- fiche_id=" + p.id + " | " + d.join(" | ") + (j.siteManager ? " | chef " + j.siteManager : " | SANS CHEF") + ((j.gps || j._geocodedGps) ? " | avec point GPS" : " | SANS POINT GPS"));
  }
  return L.join("\n");
}

const AGENT_SYSTEM = [
  "Tu es l'assistant de gestion de SONECO (rabotage de chaussees). Ton interlocuteur est le patron.",
  "Tu peux LIRE le planning et PROPOSER des ecritures dedans. Tu reponds en francais.",
  "",
  "TON DE REPONSE : une phrase, deux au maximum. Jamais de preambule, jamais de formule de politesse,",
  "jamais de recapitulatif de ce que tu viens de faire, jamais de Markdown (#, *, _).",
  "Tu dis 'la 210', pas 'la machine numero 210'. Tu dis 'le chantier', 'le chauffeur', 'le chef', 'le depot'.",
  "",
  "REGLES ABSOLUES :",
  "1. Tu ne devines JAMAIS un chauffeur, une machine, un client, un lieu, un chef ou une heure.",
  "   Si l'info manque ou est ambigue, tu poses UNE question courte et tu t'arretes.",
  "2. Le numero de machine identifie le chantier ; le prenom sert seulement a verifier.",
  "   Si le prenom donne ne correspond pas a celui du planning, tu le signales avant de proposer.",
  "3. Tu n'inventes jamais un client, un lieu, un chef ou une heure que tu n'as pas lus ou qu'on ne t'a pas dictes.",
  "4. DEUX SOURCES. PAR DEFAUT, C'EST LE GOOGLE SHEETS DU PERE.",
  "   - GOOGLE SHEETS = le planning du PERE. C'est LA REFERENCE et LA SOURCE PAR DEFAUT :",
  "     c'est la que le planning est decide, et RoadManager n'est presque plus alimente.",
  "     Outils : bilan_planning_pere (comptage sur une periode), lire_planning_pere (un jour),",
  "     comparer_planning (les deux sources cote a cote).",
  "   - ROADMANAGER = ce que les chauffeurs voient dans l'application. C'est la DESTINATION.",
  "     Il est fourni ci-dessous (section CHANTIERS) avec les job_id.",
  "   REGLE : sans precision de l'admin, reponds a partir du GOOGLE SHEETS.",
  "   Ne prends RoadManager que s'il le demande explicitement (« dans RoadManager »,",
  "   « dans l'app », « ce que voit le chauffeur », « ce qui est deja recopie »),",
  "   ou pour preparer une ecriture (recuperer un job_id, verifier un doublon).",
  "   Pour « qu'est-ce qu'il reste a recopier », utilise comparer_planning.",
  "   Pour un COMPTAGE sur une periode, utilise bilan_planning_pere ; ne boucle jamais",
  "   jour par jour.",
  "   DIS TOUJOURS de quelle source vient ce que tu annonces : « chez papa » / « dans RoadManager ».",
  "   Si les deux sources divergent, dis-le au lieu de choisir.",
  "5. Pour modifier ou supprimer, prends le job_id dans la section CHANTIERS (RoadManager).",
  "6. Les outils d'ecriture n'ecrivent RIEN : ils preparent une proposition que l'admin valide par un bouton.",
  "   Ne dis donc jamais 'c'est enregistre' apres un appel d'outil d'ecriture.",
  "7. Les dates sont au format ISO AAAA-MM-JJ, les heures au format HH:MM. Utilise le calendrier fourni.",
  "",
  "8. VERIFICATION CROISEE : avant de proposer la creation d'un chantier, appelle",
  "   comparer_planning pour ce jour. Si le planning du pere dit autre chose que l'admin",
  "   (client, lieu, heure, chauffeur, machine), SIGNALE l'ecart en une phrase avant de proposer.",
  "   Exemple : « Le planning dit eurovia ang, pas Ferroviaire. Je prends lequel ? »",
  "   Si le planning du pere contient une incoherence (case NUIT cochee sur un chantier de jour),",
  "   demande-lui de trancher, n'invente pas.",
  "8bis. CONTACT ou POINT GPS recu : si le chantier vise figure dans FICHES ENVOYEES,",
  "   utilise completer_fiche avec son fiche_id. N'utilise modifier_chantier que pour un",
  "   chantier deja ecrit dans RoadManager (section CHANTIERS, avec un job_id).",
  "9. CHEF DE CHANTIER : si un nom de chef est donne sans numero et que la fiche figure",
  "   dans FICHES ENVOYEES, appelle proposer_contacts : l'admin choisira par bouton.",
  "   Si l'outil dit qu'AUCUN contact n'a ete trouve, dis-le lui franchement et demande le numero.",
  "   Sinon (hors fiche en attente), appelle chercher_contact.",
  "   Un seul resultat au nom identique -> mets-le dans la fiche et precise d'ou il vient.",
  "   Plusieurs resultats, ou une orthographe differente -> DEMANDE confirmation avant :",
  "   « Pour Scotpa j'ai Crystof 06 12 34 56 78. C'est lui ? »  Ne choisis jamais seul.",
  "10. POINT GPS : si le lieu est trop vague pour y envoyer un chauffeur et qu'il n'y a pas",
  "   de point GPS, demande a l'admin de t'envoyer le point GPS (il peut le transferer",
  "   directement dans Telegram).",
  "11. SERIE : si l'admin demande de recopier TOUTE une journee (« recopie tout mardi »),",
  "   appelle comparer_planning puis cree TOUS les chantiers manquants en UNE fois",
  "   (un appel creer_chantier par chantier, dans le meme tour). Ne t'arrete pas au premier.",
  "   N'inclus pas les repos, absences, depots et preparations : ce ne sont pas des chantiers.",
  "12. Si l'admin corrige une proposition que tu viens d'envoyer (\'non, plutot 20h\', \'c'est Franck\'),",
  "   rappelle l'outil d'ecriture avec la proposition COMPLETE corrigee, pas seulement le champ change.",
  "",
  "BOUTONS : des que l'admin doit choisir entre des possibilites que tu connais",
  "(quel chantier, quelle machine, quel client, quel jour, oui/non), n'ecris pas la",
  "question en texte : appelle demander_choix. Il repond d'un clic.",
  "",
  "Si une reponse ne demande aucun outil, reponds directement, en une phrase.",
].join("\n");

const AGENT_TOOLS = [
  {
    name: "lire_planning",
    description: "Lit les chantiers du planning sur une periode. A utiliser avant toute creation/modification, et pour repondre aux questions de consultation. Renvoie le job_id de chaque chantier.",
    input_schema: {
      type: "object",
      properties: {
        date_debut: { type: "string", description: "Date ISO AAAA-MM-JJ" },
        date_fin: { type: "string", description: "Date ISO AAAA-MM-JJ (identique a date_debut pour un seul jour)" },
        chauffeur: { type: "string", description: "Optionnel : filtre sur un prenom de chauffeur" },
        machine: { type: "string", description: "Optionnel : filtre sur un numero de machine, ex 210" },
      },
      required: ["date_debut", "date_fin"],
    },
  },
  {
    name: "lire_planning_pere",
    description: "Lit le planning que le PERE tient dans Google Sheets pour un jour donne. A utiliser pour VERIFIER ce que l'admin dicte (client, lieu, heure, chauffeur, machine, forfait) avant de proposer une ecriture, et pour relever les forfaits.",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "Date ISO AAAA-MM-JJ" } },
      required: ["date"],
    },
  },
  {
    name: "bilan_planning_pere",
    description: "Compte les chantiers du planning du PERE sur une periode (semaine, mois...), par chauffeur. A utiliser pour toute question de comptage ou de bilan (« combien X a fait de chantiers en septembre »). Ne pas boucler sur comparer_planning jour par jour.",
    input_schema: {
      type: "object",
      properties: {
        date_debut: { type: "string", description: "Date ISO AAAA-MM-JJ" },
        date_fin: { type: "string", description: "Date ISO AAAA-MM-JJ" },
        chauffeur: { type: "string", description: "Optionnel : limiter a un chauffeur, avec le detail de ses chantiers" },
      },
      required: ["date_debut", "date_fin"],
    },
  },
  {
    name: "comparer_planning",
    description: "Compare le planning du PERE (Google Sheets) et celui de RoadManager pour un jour, chauffeur par chauffeur, et dit ce qui reste A RECOPIER. C'est l'outil a utiliser pour toute question sur le planning d'un jour.",
    input_schema: { type: "object", properties: { date: { type: "string", description: "Date ISO AAAA-MM-JJ" } }, required: ["date"] },
  },
  {
    name: "chercher_contact",
    description: "Cherche un chef de chantier dans les fiches contact (recherche tolerante aux fautes d'orthographe). A utiliser des qu'un nom de chef est donne SANS numero de telephone. Les resultats doivent TOUJOURS etre confirmes par l'admin.",
    input_schema: {
      type: "object",
      properties: {
        nom: { type: "string", description: "Nom du chef de chantier, meme mal orthographie" },
        client: { type: "string", description: "Optionnel : nom du client, pour privilegier ses contacts" },
      },
      required: ["nom"],
    },
  },
  {
    name: "creer_chantier",
    description: "Prepare la creation d'un chantier. N'ECRIT RIEN : renvoie une proposition que l'admin devra valider par un bouton.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date ISO AAAA-MM-JJ" },
        chauffeur: { type: "string", description: "Prenom ou nom du chauffeur" },
        machine: { type: "string", description: "Numero de machine, ex 210" },
        client: { type: "string", description: "Nom du client" },
        lieu: { type: "string", description: "Lieu / adresse du chantier" },
        heure: { type: "string", description: "Heure de debut HH:MM" },
        nuit: { type: "boolean", description: "true si chantier de nuit" },
        forfait: { type: "string", description: "2h, 4h, 6h, 8h, 10h, Demi-journee ou Journee" },
        chef: { type: "string", description: "Nom du chef de chantier" },
        telephone_chef: { type: "string", description: "Telephone du chef de chantier" },
        gps: { type: "string", description: "Coordonnees 'lat,lon' OU lien Google Maps colle par l'admin (a recopier tel quel)" },
        transfert: { type: "boolean", description: "true si un transfert est facture en plus" },
      },
      required: ["date", "chauffeur", "machine"],
    },
  },
  {
    name: "demander_choix",
    description: "Pose une question a l'admin avec des BOUTONS au lieu d'attendre qu'il tape. A utiliser CHAQUE FOIS qu'il doit choisir entre des possibilites que tu connais : quel chantier, quelle machine, quel client, quel jour, oui/non. Sa reponse te reviendra comme s'il l'avait ecrite.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "La question, courte" },
        options: { type: "array", items: { type: "string" }, description: "2 a 6 reponses possibles, courtes et distinctes" },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "proposer_contacts",
    description: "Cherche un chef de chantier et propose les resultats a l'admin SOUS FORME DE BOUTONS, rattaches a une fiche en attente. A utiliser des qu'un chef est cite sans numero. Si aucun contact n'est trouve, l'outil le dit : previens alors l'admin et demande-lui le numero.",
    input_schema: {
      type: "object",
      properties: {
        fiche_id: { type: "string", description: "Identifiant de la fiche, pris dans FICHES ENVOYEES" },
        nom: { type: "string", description: "Nom du chef, meme mal orthographie" },
        client: { type: "string", description: "Optionnel : nom du client" },
      },
      required: ["fiche_id", "nom"],
    },
  },
  {
    name: "completer_fiche",
    description: "Complete une fiche DEJA ENVOYEE et pas encore validee (ajouter le chef de chantier, son telephone, un point GPS, une heure...). A utiliser des que l'admin rattache un contact ou un point GPS a un chantier qui figure dans FICHES ENVOYEES. Renvoie la fiche corrigee, qui remplace la precedente.",
    input_schema: {
      type: "object",
      properties: {
        fiche_id: { type: "string", description: "Identifiant de la fiche, pris dans FICHES ENVOYEES" },
        chef: { type: "string" }, telephone_chef: { type: "string" },
        gps: { type: "string", description: "Coordonnees 'lat,lon' OU lien Google Maps, a recopier tel quel" },
        heure: { type: "string" }, lieu: { type: "string" }, client: { type: "string" },
        forfait: { type: "string" }, nuit: { type: "boolean" },
      },
      required: ["fiche_id"],
    },
  },
  {
    name: "modifier_chantier",
    description: "Prepare la modification d'un chantier existant (y compris pour poser un point GPS ou le contact du chef). N'ECRIT RIEN : renvoie une proposition a valider. Ne renseigne que les champs a changer.",
    input_schema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Identifiant du chantier, obtenu via lire_planning" },
        date: { type: "string" }, chauffeur: { type: "string" }, machine: { type: "string" },
        client: { type: "string" }, lieu: { type: "string" }, heure: { type: "string" },
        nuit: { type: "boolean" }, forfait: { type: "string" },
        chef: { type: "string" }, telephone_chef: { type: "string" },
        gps: { type: "string" }, transfert: { type: "boolean" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "supprimer_chantier",
    description: "Prepare la suppression d'un chantier. N'ECRIT RIEN : renvoie une proposition a valider.",
    input_schema: {
      type: "object",
      properties: { job_id: { type: "string", description: "Identifiant du chantier, obtenu via lire_planning" } },
      required: ["job_id"],
    },
  },
];

// ---- Execution des outils --------------------------------------------------
function toolLirePlanning(data: any, a: any): string {
  const d1 = String(a.date_debut || ""), d2 = String(a.date_fin || a.date_debut || "");
  let jobs = (data.jobs || []).filter((j: any) => j.date >= d1 && j.date <= d2);
  if (a.chauffeur) {
    const r = resolveEmployee(data, a.chauffeur);
    if (r.error) return r.error;
    jobs = jobs.filter((j: any) => j.employeeId === r.emp.id);
  }
  if (a.machine) {
    const r = resolveMachine(data, a.machine, a.chauffeur ? (resolveEmployee(data, a.chauffeur).emp || null) : null);
    if (r.error) return r.error;
    jobs = jobs.filter((j: any) => j.machineId === r.machine.id);
  }
  jobs = jobs.sort((x: any, y: any) => (x.date + (x.billingStart || "")).localeCompare(y.date + (y.billingStart || "")));
  if (!jobs.length) return "Aucun chantier sur cette periode avec ces criteres.";
  return jobs.map((j: any) => {
    const e = (data.employees || []).find((x: any) => x.id === j.employeeId);
    const m = (data.machines || []).find((x: any) => x.id === j.machineId);
    const c = (data.clients || []).find((x: any) => x.id === j.clientId);
    const p = ["job_id=" + j.id, j.date, j.billingStart || "--", e ? e.name : "sans chauffeur", m ? m.name : "sans machine"];
    if (c) p.push("client " + c.name);
    if (j.location) p.push("lieu " + j.location);
    if (j.type === "depot") p.push(j.rest ? "REPOS" : "DEPOT");
    if (j.isNight) p.push("NUIT");
    if (j.forfaitType) p.push("forfait " + j.forfaitType);
    if (j.priceForfait) p.push(j.priceForfait + "EUR");
    if (j.siteManager) p.push("chef " + j.siteManager + (j.siteManagerPhone ? " " + j.siteManagerPhone : ""));
    if (j.gps || j._geocodedGps) p.push("gps " + (j.gps || j._geocodedGps));
    if (j.ack) p.push("lu par le chauffeur");
    else if (j.sent) p.push("envoye, pas encore lu");
    return "- " + p.join(" | ");
  }).join("\n");
}

// Construit le chantier propose (creation ou modification) a partir des champs dictes.
function buildProposal(data: any, a: any, kind: string, baseJob?: any): any {
  const warn: string[] = [];
  let base: any = null;
  if (kind === "update" || kind === "delete") {
    // baseJob : fiche en attente de validation, pas encore ecrite dans RoadManager.
    base = baseJob || (data.jobs || []).find((x: any) => x.id === a.job_id);
    if (!base) return { error: "Chantier introuvable (job_id " + a.job_id + "). Relis le planning pour recuperer le bon identifiant." };
  }
  if (kind === "delete") {
    return { kind: "delete", jobId: base.id, lines: ["\u{1F5D1} SUPPRESSION"].concat(jobRecap(data, base, null)), warn };
  }

  const j: any = kind === "create"
    ? { id: uid(), date: "", employeeId: "", machineId: "", clientId: "", agencyName: "", siteManager: "", siteManagerPhone: "", location: "", gps: "", forfaitType: "", priceForfait: 0, isNight: false, hasTransfer: false, transferPrice: 0, billingStart: "08:00", startFrom: "home", endAt: "home", machineFuelL: 0, machineFuelDepot: "", kmAller: 0, kmRetour: 0, travelMinAller: 0, travelMinRetour: 0, distanceKm: 0, travelMin: 0, sent: false, ack: false }
    : JSON.parse(JSON.stringify(base));

  let newClientName = "";
  if (a.date) j.date = String(a.date);
  let empObj: any = null;
  if (a.chauffeur) { const r = resolveEmployee(data, a.chauffeur); if (r.error) return { error: r.error }; j.employeeId = r.emp.id; empObj = r.emp; }
  if (!empObj && j.employeeId) empObj = (data.employees || []).find((x: any) => x.id === j.employeeId) || null;
  if (a.machine) { const r = resolveMachine(data, a.machine, empObj); if (r.error) return { error: r.error }; j.machineId = r.machine.id; }
  if (a.client) {
    const r = resolveClient(data, a.client);
    if (r.error) return { error: r.error };
    if (r.client) j.clientId = r.client.id;
    else { newClientName = r.newName; j.clientId = ""; }
  }
  if (a.lieu) { j.location = String(a.lieu); j._geocodedGps = ""; }
  if (a.heure) j.billingStart = String(a.heure);
  if (typeof a.nuit === "boolean") j.isNight = a.nuit;
  if (a.forfait) j.forfaitType = String(a.forfait);
  if (a.chef) j.siteManager = String(a.chef);
  if (a.telephone_chef) j.siteManagerPhone = String(a.telephone_chef);
  if (a.gps) j.gps = String(a.gps).replace(/\s+/g, "");
  if (typeof a.transfert === "boolean") j.hasTransfer = a.transfert;

  if (!j.date) return { error: "Date manquante." };
  if (!j.employeeId) return { error: "Chauffeur manquant." };
  if (!j.machineId) return { error: "Machine manquante." };

  // Prix : calcule avec la meme grille que l'app (client existant uniquement).
  const mac = (data.machines || []).find((x: any) => x.id === j.machineId);
  if (j.forfaitType && j.clientId && mac) {
    j.priceForfait = getForfaitPrice(data, j.clientId, mac, j.forfaitType, j.citOption || null, !!j.isNight);
    if (j.hasTransfer) j.transferPrice = getForfaitPrice(data, j.clientId, mac, "Transfert", j.citOption || null, !!j.isNight);
    if (!j.priceForfait) warn.push("Pas de tarif trouve pour ce forfait : prix a 0, a completer dans l'app.");
  } else if (j.forfaitType && newClientName) {
    warn.push("Client nouveau : pas de tarif, prix a 0.");
  }

  const nomDe = (id: string) => { const e = (data.employees || []).find((x: any) => x.id === id); return e ? e.name : "?"; };
  // Verification croisee : ce chauffeur a-t-il deja quelque chose ce jour-la ?
  const clash = (data.jobs || []).filter((x: any) => x.employeeId === j.employeeId && x.date === j.date && x.id !== j.id);
  for (const cj of clash) {
    const cm = (data.machines || []).find((x: any) => x.id === cj.machineId);
    const dej = cj.ack ? " — DEJA LU par le chauffeur" : cj.sent ? " — DEJA ENVOYE au chauffeur" : "";
    warn.push("Deja au planning ce jour : " + (cj.billingStart || "--") + " " + (cj.location || "chantier") + (cm ? " [" + cm.name + "]" : "") + dej);
  }
  // REAFFECTATION : le meme chantier (meme jour, meme lieu) etait prevu pour QUELQU'UN D'AUTRE.
  // C'est le cas dangereux : l'ancien chauffeur a pu recevoir le message hier soir.
  if (j.location) {
    const repris = (data.jobs || []).filter((x: any) => x.date === j.date && x.id !== j.id
      && x.employeeId && x.employeeId !== j.employeeId
      && normTxt(x.location || "") === normTxt(j.location));
    for (const rj of repris) {
      const qui = nomDe(rj.employeeId);
      j.remplaceJobId = rj.id;
      warn.push(rj.sent || rj.ack
        ? "\u{21A9} REMPLACE le chantier de " + qui + ", qu'il a DEJA RECU sur Telegram. Il faut le prevenir que ce n'est plus pour lui."
        : "\u{21A9} Remplace le chantier qui etait prevu pour " + qui + ".");
    }
  }
  // La machine est-elle deja prise ce jour-la par quelqu'un d'autre ?
  const mclash = (data.jobs || []).filter((x: any) => x.machineId === j.machineId && x.date === j.date && x.id !== j.id && x.employeeId !== j.employeeId);
  for (const cj of mclash) {
    const ce = (data.employees || []).find((x: any) => x.id === cj.employeeId);
    warn.push("Cette machine est deja prise ce jour par " + (ce ? ce.name : "quelqu'un") + ".");
  }
  if (!j.location && !newClientName && !j.clientId) warn.push("Ni lieu ni client : le chauffeur verra un chantier vide.");
  if (!j.gps && lieuImprecis(j.location)) warn.push("Lieu imprecis et aucun point GPS : demander a l'admin d'envoyer le point GPS.");
  if (j.siteManager && !j.siteManagerPhone) warn.push("Chef sans numero : chercher le contact et le faire confirmer.");

  const head = kind === "create" ? "\u{1F195} NOUVEAU CHANTIER" : "✏️ MODIFICATION";
  return { kind, job: j, newClientName, lines: [head].concat(jobRecap(data, j, { newClientName })), warn };
}

// ---- Stockage des propositions en attente ---------------------------------
function pruneProposals(data: any): void {
  data.tgProposals = (data.tgProposals || []).filter((p: any) => Date.now() - (p.ts || 0) < 2 * 3600 * 1000);
}

// Envoie la fiche sur Telegram. N'ECRIT RIEN en base : l'ecriture est groupee avec
// la sauvegarde du fil dans commitTurn(), pour ne relire le blob qu'UNE fois par message.
async function sendProposalMessage(tg: any, chatId: string, prop: any): Promise<any> {
  const pid = uid();
  const txt = prop.lines.join("\n") + (prop.warn && prop.warn.length ? "\n\n⚠️ " + prop.warn.join("\n⚠️ ") : "") + "\n\nC'est bien ca ?";
  let msgId: any = null;
  try {
    const r = await tg("sendMessage", {
      chat_id: chatId,
      text: txt,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "✅ Valider", callback_data: "pok:" + pid }, { text: "✏️ Corriger", callback_data: "pfix:" + pid }]] },
    });
    const jr = await r.json();
    msgId = jr && jr.result && jr.result.message_id;
  } catch (_e) { /* ignore */ }
  return { id: pid, chatId, msgId, kind: prop.kind, job: prop.job || null, jobId: prop.jobId || (prop.job && prop.job.id) || null, newClientName: prop.newClientName || "", text: txt, ts: Date.now() };
}

// UNE seule relecture + ecriture du blob par message recu, meme pour une serie de fiches.
// Renvoie les propositions devenues caduques (remplacees par une version corrigee).
// Cle de remplacement : jour + chauffeur + machine + lieu. Deux fiches differentes
// (deux chauffeurs, ou deux chantiers du meme chauffeur) coexistent donc sans s'ecraser.
function propKey(p: any): string {
  // Une suppression n'a pas d'objet chantier : sans cle propre, toutes les suppressions
  // auraient la meme et se seraient ecrasees entre elles.
  if (p.kind === "delete") return "del|" + (p.jobId || "");
  const j = p.job || {};
  return [j.date || "", j.employeeId || "", j.machineId || "", normTxt(j.location || "")].join("|");
}
let _cout: any = null;                    // consommation du tour en cours, enregistree avec le reste
async function commitTurn(chatId: string, pendings: any[], convMessages: any[] | null, replaceId?: string): Promise<any[]> {
  if ((!pendings || !pendings.length) && !convMessages && !_cout) return [];
  let olds: any[] = [];
  await mutate((d: any) => {
    if (pendings && pendings.length) {
      pruneProposals(d);
      d.tgProposals = d.tgProposals || [];
      const keys = new Set(pendings.map(propKey));
      // replaceId : l'admin a appuye sur "Corriger" sur CETTE fiche -> c'est elle qu'on remplace,
      // meme s'il a change le lieu ou la machine (la cle ne correspondrait plus).
      const remplaces = new Set(pendings.map((p: any) => p.remplace).filter(Boolean));
      olds = d.tgProposals.filter((x: any) => String(x.chatId) === String(chatId) && (keys.has(propKey(x)) || (replaceId && x.id === replaceId) || remplaces.has(x.id)));
      const oldIds = new Set(olds.map((o: any) => o.id));
      d.tgProposals = d.tgProposals.filter((x: any) => !oldIds.has(x.id));
      for (const p of pendings) d.tgProposals.push(p);
    }
    if (_cout) { d.tgDernierCout = _cout; _cout = null; }
    if (convMessages) {
      d.tgConv = d.tgConv || {};
      d.tgConv[chatId] = { m: trimConv(convMessages), ts: Date.now() };
      for (const k of Object.keys(d.tgConv)) if (Date.now() - (d.tgConv[k].ts || 0) > 2 * 3600 * 1000) delete d.tgConv[k];
    }
  });
  return olds;
}

async function editReplacedProposals(tg: any, chatId: string, olds: any[]): Promise<void> {
  for (const o of olds) {
    if (!o.msgId) continue;
    try { await tg("editMessageText", { chat_id: chatId, message_id: o.msgId, text: String(o.text || "").replace(/\n\nC'est bien ca \?$/, "") + "\n\n↩️ Remplace par une version corrigee.", disable_web_page_preview: true }); } catch (_e) { /* ignore */ }
  }
}

// ---- Application d'une proposition validee --------------------------------
// Applique la proposition sur l'objet donnees (fonction pure : aucune I/O).
function applyProposalTo(d: any, prop: any): string {
  d.jobs = d.jobs || [];
  if (prop.kind === "delete") {
    d._tombstones = d._tombstones || {};
    d._tombstones.jobs = d._tombstones.jobs || {};
    d._tombstones.jobs[prop.jobId] = Date.now();
    d.jobs = d.jobs.filter((j: any) => j.id !== prop.jobId);
    return "Chantier supprime.";
  }
  const j = JSON.parse(JSON.stringify(prop.job));
  // Client cree a la volee, comme le fait l'app quand on tape un nouveau nom.
  if (prop.newClientName) {
    const ex = (d.clients || []).find((c: any) => normTxt(c.name) === normTxt(prop.newClientName));
    if (ex) j.clientId = ex.id;
    else {
      const nc = { id: uid(), name: prop.newClientName, forfaitType: "standard", agencies: [], siteManagers: [] };
      d.clients = (d.clients || []).concat([nc]);
      j.clientId = nc.id;
    }
  }
  // On memorise le chef de chantier sur la fiche client, comme l'app.
  if (j.siteManager && j.clientId) {
    const c = (d.clients || []).find((x: any) => x.id === j.clientId);
    if (c) {
      c.siteManagers = c.siteManagers || [];
      if (!c.siteManagers.some((s: any) => normTxt(s.name) === normTxt(j.siteManager))) {
        c.siteManagers.push({ name: j.siteManager, phone: j.siteManagerPhone || "" });
      }
    }
  }
  j._updatedAt = Date.now();
  const i = d.jobs.findIndex((x: any) => x.id === j.id);
  if (i >= 0) { d.jobs[i] = j; return "Chantier modifie."; }
  d.jobs.push(j);
  return "Chantier ajoute au planning.";
}

// Valider ou annuler : une SEULE relecture+ecriture du blob (chantier + purge du
// fil + retrait de la proposition sont faits dans la meme passe).
async function resolveProposal(prop: any, chatId: string, accept: boolean, sent?: boolean): Promise<string> {
  let msg = "Annule.";
  await mutate((d: any) => {
    d.tgProposals = (d.tgProposals || []).filter((x: any) => x.id !== prop.id);
    if (d.tgConv) delete d.tgConv[chatId];
    if (accept) {
      if (sent && prop.job) { prop.job.sent = true; prop.job.ack = false; }
      msg = applyProposalTo(d, prop);
    }
  });
  return msg;
}

// ============================================================================
// ===== LECTURE DU PLANNING GOOGLE SHEETS DU PERE ============================
// ----------------------------------------------------------------------------
// Le pere saisit le planning dans un classeur Google par mois, une feuille par
// semaine ("SEMAINE 36"...). Le classeur est partage en lecture : aucune cle API.
// Sert de SOURCE DE VERIFICATION avant d'ecrire dans RoadManager.
// ============================================================================

const GS_LEFT = { chk: 1, nom: 2, mach: 3, paye: 4, cli: 5, chef: 6, lieu: 7, ff: 8, bon: 9 };
const GS_RIGHT = { chk: 11, nom: 12, mach: 13, paye: 14, cli: 15, chef: 16, lieu: 17, ff: 18, bon: 19 };
// Bloc droite : 14 emplacements, les 3 DERNIERS sont les citernes, les 11 premiers les balayeuses.
const GS_SLOTS = 14, GS_CITERNE_FROM = 11;
const GS_MARQUES: any = { R: "Renault", V: "Volvo", M: "Mercedes", MA: "Man", VB: "Volvo gros balai", RB: "Renault gros balai", S: "semi" };

function gsParseCsv(txt: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) {
      if (c === '"') { if (txt[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const gsCell = (rows: any, r: number, c: number) => (rows[r] && rows[r][c] != null ? String(rows[r][c]).trim() : "");
const gsTrue = (v: any) => String(v).trim().toUpperCase() === "TRUE";
const gsNorm = (s: any) => stripAccents(String(s || "")).toLowerCase().replace(/\s+/g, " ").trim();

function gsIsoWeek(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil(((dt.getTime() - y0.getTime()) / 86400000 + 1) / 7);
}
function gsDayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
}
// ATTENTION : si le nom de feuille demande n'existe pas, Google renvoie SILENCIEUSEMENT
// la premiere feuille. On verifie donc toujours que la date demandee est bien la ; -1 sinon.
function gsFindDay(rows: any, iso: string): number {
  const want = gsNorm(gsDayLabel(iso));
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < (rows[r] || []).length; c++) {
      const v = gsNorm(gsCell(rows, r, c)).replace(/^(\d+)er\b/, "$1");
      if (v && v === want) return r;
    }
  }
  return -1;
}
function gsHeure(lieu: string): string {
  const m = String(lieu || "").toLowerCase().match(/(\d{1,2})\s*h\s*(\d{2})?/);
  if (!m) return "";
  return String(Math.min(23, parseInt(m[1], 10))).padStart(2, "0") + ":" + (m[2] || "00");
}
function gsDayJobs(rows: any, start: number, data?: any): any[] {
  const out: any[] = [];
  // Bloc droite : on affecte les 14 codes du jour aux machines de RoadManager en une passe.
  let resolues: any[] = [];
  if (data) {
    const codes: string[] = [];
    for (let s = 0; s < GS_SLOTS; s++) {
      const k = start + 2 + s * 2;
      codes.push(gsCell(rows, k, GS_RIGHT.mach) || gsCell(rows, k + 1, GS_RIGHT.mach));
    }
    const bal = assignerMachines(data, codes.slice(0, GS_CITERNE_FROM), "Balayeuse");
    const cit = assignerMachines(data, codes.slice(GS_CITERNE_FROM), "Citerne");
    resolues = bal.concat(cit);
  }
  for (const b of [{ cols: GS_LEFT, type: "raboteuse" }, { cols: GS_RIGHT, type: "" }]) {
    const C: any = b.cols;
    for (let s = 0; s < GS_SLOTS; s++) {
      const k = start + 2 + s * 2;
      const machRaw = gsCell(rows, k, C.mach) || gsCell(rows, k + 1, C.mach);
      const nom = gsCell(rows, k, C.nom) || gsCell(rows, k + 1, C.nom);
      const informe = gsTrue(gsCell(rows, k, C.chk));
      const nuit = gsTrue(gsCell(rows, k + 1, C.chk));
      const paye = gsTrue(gsCell(rows, k, C.paye)) || gsTrue(gsCell(rows, k + 1, C.paye));
      const bon = gsTrue(gsCell(rows, k, C.bon)) || gsTrue(gsCell(rows, k + 1, C.bon));
      let categorie = b.type, machine = machRaw, machineRM = machRaw;
      if (!categorie) {
        categorie = s >= GS_CITERNE_FROM ? "citerne" : "balayeuse";
        // Affichage et cle inchanges (sinon toutes les lignes deja vues repartiraient),
        // mais on transporte le vrai nom RoadManager a cote.
        machine = (GS_MARQUES[machRaw.toUpperCase()] || machRaw) + (machRaw ? " (" + machRaw + ")" : "");
        machineRM = (resolues[s] && resolues[s].name) || "";
      }
      for (const rr of [k, k + 1]) {
        const cli = gsCell(rows, rr, C.cli), lieu = gsCell(rows, rr, C.lieu), ff = gsCell(rows, rr, C.ff);
        if (!cli && !lieu && !ff) continue;
        out.push({
          categorie, machine, machineRM, chauffeur: nom, client: cli, chef: gsCell(rows, rr, C.chef),
          lieu, heure: gsHeure(lieu), forfait: ff ? ff + "h" : "",
          nuit, informe, paye, bonEnvoye: bon, ligne: rr + 1,
        });
      }
    }
  }
  return out;
}

function gsBooks(data: any): any[] {
  return (data.gsheetBooks || []).slice().sort((a: any, b: any) => (b.at || 0) - (a.at || 0));
}
async function gsFetchSheet(bookId: string, sheetName: string): Promise<string | null> {
  const u = "https://docs.google.com/spreadsheets/d/" + bookId + "/gviz/tq?tqx=out:csv&sheet=" + encodeURIComponent(sheetName);
  try { const r = await fetch(u); if (!r.ok) return null; return await r.text(); } catch (_e) { return null; }
}

// Cherche une date dans les classeurs enregistres. Ne renvoie un resultat que si la
// date est REELLEMENT presente dans la feuille recuperee.
async function gsLookupDay(data: any, iso: string): Promise<any> {
  const books = gsBooks(data);
  if (!books.length) return { error: "Aucun classeur Google Sheets enregistre. L'admin doit envoyer le lien du classeur du mois." };
  const w = gsIsoWeek(iso);
  for (const b of books) {
    for (const name of ["SEMAINE " + w, " SEMAINE " + w]) {
      const csv = await gsFetchSheet(b.id, name);
      if (!csv) continue;
      const rows = gsParseCsv(csv);
      const start = gsFindDay(rows, iso);
      if (start < 0) continue;   // mauvaise feuille renvoyee par Google : on ignore
      return { jobs: gsDayJobs(rows, start, data), semaine: w, book: b };
    }
  }
  return { error: "Le " + gsDayLabel(iso) + " (semaine " + w + ") n'a pas ete trouve dans les classeurs enregistres." };
}

function gsRender(iso: string, res: any): string {
  if (res.error) return res.error;
  const L: string[] = ["Planning du pere — " + gsDayLabel(iso) + " (semaine " + res.semaine + ") :"];
  if (!res.jobs.length) return L[0] + "\n(aucune ligne remplie)";
  for (const j of res.jobs) {
    const p = [j.categorie, j.machine || "?", j.chauffeur || "sans chauffeur"];
    if (j.client) p.push("client " + j.client);
    if (j.chef) p.push("chef " + j.chef);
    if (j.lieu) p.push("lieu " + j.lieu);
    if (j.heure) p.push("heure " + j.heure);
    if (j.forfait) p.push("forfait " + j.forfait);
    if (j.nuit) p.push("NUIT");
    if (j.informe) p.push("chauffeur prevenu");
    if (j.paye) p.push("client a paye");
    if (j.bonEnvoye) p.push("bon envoye");
    // Le pere se trompe parfois de case : on signale l'incoherence au lieu de deviner.
    if (j.nuit && j.heure && parseInt(j.heure, 10) < 17) p.push("!! case NUIT cochee mais heure " + j.heure + " : a faire confirmer par l'admin");
    L.push("- " + p.join(" | "));
  }
  return L.join("\n");
}

// Enregistre un classeur a partir d'un lien colle dans Telegram.
function gsExtractId(txt: string): string { const m = String(txt || "").match(/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/); return m ? m[1] : ""; }

// Compare le planning du PERE (Google Sheets) et celui de ROADMANAGER pour un jour.
// C'est ce qui permet de repondre a « qu'est-ce qui reste a recopier ? ».
// repos / absence / depot : ce sont des etats, pas des chantiers a recopier.
function gsEstNonChantier(g: any): boolean {
  const t = normTxt((g.lieu || "") + " " + (g.client || ""));
  return !t || /^(repos|absent|absent le matin|absente|conge|conges|depot|prepa|effacage)\b/.test(t) || t === "depot";
}

async function toolComparerPlanning(data: any, iso: string): Promise<string> {
  const gs = await gsLookupDay(data, iso);
  const rmJobs = (data.jobs || []).filter((j: any) => j.date === iso);
  const nomOf = (id: string) => { const e = (data.employees || []).find((x: any) => x.id === id); return e ? e.name : ""; };
  const macOf = (id: string) => { const m = (data.machines || []).find((x: any) => x.id === id); return m ? m.name : ""; };

  const rmByDrv: any = {};
  for (const j of rmJobs) {
    const k = normTxt(nomOf(j.employeeId)) || "(sans chauffeur)";
    (rmByDrv[k] = rmByDrv[k] || []).push(j);
  }
  const gsByDrv: any = {};
  for (const g of (gs.jobs || [])) {
    if (!g.client && !g.lieu) continue;          // ligne vide ou simple note
    const k = normTxt(g.chauffeur) || "(sans chauffeur)";
    (gsByDrv[k] = gsByDrv[k] || []).push(g);
  }

  const L: string[] = [];
  L.push("COMPARAISON " + gsDayLabel(iso) + " — planning du PERE (Google Sheets) vs ROADMANAGER");
  if (gs.error) L.push("Google Sheets : " + gs.error);
  L.push("");

  const drivers = [...new Set([...Object.keys(gsByDrv), ...Object.keys(rmByDrv)])].sort();
  if (!drivers.length) return L.join("\n") + "Les deux plannings sont vides ce jour-la.";

  const aCopier: string[] = [];
  for (const d of drivers) {
    const G = gsByDrv[d] || [], R = rmByDrv[d] || [];
    const label = (G[0] && G[0].chauffeur) || nomOf((R[0] || {}).employeeId) || d;
    L.push("* " + label.toUpperCase());
    for (const g of G) {
      const p = [g.machine || "?"];
      if (g.client) p.push(g.client);
      if (g.lieu) p.push(g.lieu);
      if (g.heure) p.push(g.heure);
      if (g.forfait) p.push("forfait " + g.forfait);
      if (g.nuit) p.push("NUIT");
      L.push("   PERE : " + p.join(" | "));
    }
    if (!G.length) L.push("   PERE : (rien)");
    for (const j of R) {
      const c = (data.clients || []).find((x: any) => x.id === j.clientId);
      const p = [macOf(j.machineId) || "?"];
      if (c) p.push(c.name);
      if (j.location) p.push(j.location);
      if (j.billingStart) p.push(j.billingStart);
      if (j.forfaitType) p.push("forfait " + j.forfaitType);
      if (j.isNight) p.push("NUIT");
      p.push("job_id=" + j.id);
      L.push("   ROADMANAGER : " + p.join(" | "));
    }
    if (!R.length) {
      const vrais = G.filter((g: any) => !gsEstNonChantier(g));
      L.push("   ROADMANAGER : (rien)" + (vrais.length ? " -> A RECOPIER" : ""));
      for (const g of vrais) aCopier.push(label + " " + (g.machine || "") + " " + (g.client || g.lieu || ""));
    }
    L.push("");
  }
  L.push(aCopier.length
    ? "A RECOPIER dans RoadManager (" + aCopier.length + ") : " + aCopier.join(" ; ")
    : "Rien a recopier : tous les chauffeurs du planning du pere ont deja un chantier dans RoadManager.");
  return L.join("\n");
}

// ============================================================================
// ===== SURVEILLANCE DU PLANNING DU PERE =====================================
// Quand le pere coche « chauffeur au courant » dans Google Sheets, la fiche part
// sur Telegram pour validation. Rien n'est ecrit sans l'accord de l'admin.
// ============================================================================

// Lecture partielle : 208 octets au lieu de 950 Ko. On ne relit le bloc entier
// que s'il y a reellement une nouvelle case cochee.
async function loadLight(fields: string[]): Promise<any> {
  const sel = fields.map((f) => "data->" + f).join(",");
  const r = await fetch(`${SB_URL}/rest/v1/app_data?id=eq.main&select=${encodeURIComponent(sel)}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const rows = await r.json();
  return (rows && rows[0]) || {};
}

// Le planning du pere donne une CATEGORIE (balayeuse/citerne) et une MARQUE (R, VB, MA...).
// Les noms de machines de RoadManager sont saisis a la main ("reanult 2", "volova ba"),
// donc on cherche par type puis par marque, en tolerant les fautes de frappe.
// Les codes du classeur sont les INITIALES des noms de machines de RoadManager :
// "R"=renault, "R 2"=renault 2, "RB"=renault ba, "MA"=man, "M"=mercedes...
// On genere les abreviations possibles de chaque machine, puis on affecte les codes du
// jour en commencant par les plus precis : "MA" prend man, donc "M" revient a mercedes.
function codesMachine(nom: string): string[] {
  const n = normTxt(nom);
  const t = n.split(" ").filter(Boolean);
  if (!t.length) return [];
  const out = new Set<string>();
  out.add(n.replace(/ /g, ""));
  out.add(t.map((x: string) => x[0]).join(""));
  for (let k = 1; k <= 3 && k <= t[0].length; k++) out.add(t[0].slice(0, k) + t.slice(1).map((x: string) => x[0]).join(""));
  out.add(t[0]);
  return [...out];
}
function assignerMachines(data: any, codes: string[], type: string): any[] {
  const dispo = (data.machines || []).filter((m: any) => m && m.name && m.type === type)
    .map((m: any) => ({ m, cs: new Set(codesMachine(m.name)) }));
  const pris = new Set<string>();
  const res: any[] = codes.map(() => null);
  const ordre = codes.map((c, i) => ({ c: normTxt(c).replace(/ /g, ""), i })).filter((x) => x.c)
    .sort((a, b) => b.c.length - a.c.length);
  for (const o of ordre) {
    const hit = dispo.find((x: any) => !pris.has(x.m.id) && x.cs.has(o.c));
    if (hit) { pris.add(hit.m.id); res[o.i] = hit.m; }
  }
  return res;
}
const GS_MOTS: any = { R: ["renault"], V: ["volvo"], M: ["mercedes"], MA: ["man"], VB: ["volvo", "ba"], RB: ["renault", "ba"], S: ["semi"] };
function resolveMachineSheet(data: any, categorie: string, lettre: string, emp: any): any {
  const type = categorie === "citerne" ? "Citerne" : "Balayeuse";
  const cands = (data.machines || []).filter((m: any) => m && m.name && m.type === type);
  if (!cands.length) return { error: "Aucune machine de type " + type + " dans RoadManager." };
  const mots = GS_MOTS[String(lettre || "").toUpperCase()] || [normTxt(lettre)];
  const score = (m: any) => {
    const toks = normTxt(m.name).split(" ").filter(Boolean);
    let n = 0;
    // Tolerance aux fautes seulement sur des mots assez longs : sinon "2" ressemble a "ba".
    for (const w of mots) if (toks.some((t: string) => t === w || (t.length >= 4 && w.length >= 4 && levenshtein(t, w) <= 2))) n++;
    return n;
  };
  let best = 0; for (const m of cands) best = Math.max(best, score(m));
  if (!best) return { error: 'Aucune ' + type.toLowerCase() + ' ne correspond a "' + lettre + '".' };
  const top = cands.filter((m: any) => score(m) === best);
  if (top.length === 1) return { machine: top[0] };
  // Plusieurs machines de la meme marque : celle attribuee au chauffeur tranche.
  const own = emp && emp.machineId ? top.find((m: any) => m.id === emp.machineId) : null;
  if (own) return { machine: own };
  return { error: 'Plusieurs ' + type.toLowerCase() + 's correspondent a "' + lettre + '" : ' + top.map((m: any) => m.name).join(", ") + ". Demande a l'admin laquelle." };
}

// Bilan du planning du pere sur une periode (une semaine, un mois...).
// Le detail par jour existe deja ; ici on compte, pour repondre a
// « combien Charles a fait de chantiers en septembre ».
async function gsBilan(data: any, d1: string, d2: string, chauffeur?: string): Promise<string> {
  const books = gsBooks(data);
  if (!books.length) return "Aucun classeur Google Sheets enregistre.";
  const cible = chauffeur ? normTxt(chauffeur) : "";
  const semaines: any = {};
  const parChauffeur: any = {};
  const lignes: string[] = [];
  let jours = 0, absents = 0;
  const start = new Date(d1 + "T12:00:00Z"), end = new Date(d2 + "T12:00:00Z");
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return "Periode invalide.";
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const w = gsIsoWeek(iso);
    if (!(w in semaines)) {
      semaines[w] = null;
      for (const b of books) {
        for (const nm of ["SEMAINE " + w, " SEMAINE " + w]) {
          const csv = await gsFetchSheet(b.id, nm);
          if (!csv) continue;
          const rows = gsParseCsv(csv);
          if (gsFindDay(rows, iso) >= 0) { semaines[w] = rows; break; }
        }
        if (semaines[w]) break;
      }
    }
    const rows = semaines[w];
    if (!rows) { absents++; continue; }
    const st = gsFindDay(rows, iso);
    if (st < 0) { absents++; continue; }
    jours++;
    for (const g of gsDayJobs(rows, st)) {
      if (gsEstNonChantier(g)) continue;
      const nom = normTxt(g.chauffeur);
      if (!nom) continue;
      if (cible && nom.indexOf(cible) < 0 && cible.indexOf(nom) < 0) continue;
      parChauffeur[g.chauffeur] = (parChauffeur[g.chauffeur] || 0) + 1;
      if (cible) lignes.push("- " + iso + " | " + (g.machine || "?") + " | " + (g.client || "-") + " | " + (g.lieu || "-") + (g.nuit ? " | NUIT" : ""));
    }
  }
  const L = ["Planning du pere, du " + d1 + " au " + d2 + " (" + jours + " jour(s) lus" + (absents ? ", " + absents + " jour(s) absents du classeur" : "") + ") :"];
  const noms = Object.keys(parChauffeur).sort((a, b) => parChauffeur[b] - parChauffeur[a]);
  if (!noms.length) return L[0] + "\nAucun chantier trouve.";
  for (const n of noms) L.push("- " + n + " : " + parChauffeur[n] + " chantier(s)");
  if (lignes.length) { L.push(""); L.push("Detail :"); for (const x of lignes) L.push(x); }
  return L.join("\n");
}

// Geocodage du lieu, comme le fait l'application, pour que le chauffeur recoive un
// lien Google Maps. Biaise autour des depots SONECO : « mazerolles » tout seul existe
// dans plusieurs departements.
function distKm(a: number[], b: number[]): number {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
// Le lieu est ecrit a la main ("giratoire rte de cherves rd 48") : on tente la chaine
// complete, puis des versions allegees, jusqu'a obtenir un point PLAUSIBLE.
function geoCandidats(lieu: string): string[] {
  const HEURE = /\ba?\s*\d{1,2}\s*h\s*\d{0,2}\b/g;
  const CODES = /\b(rd|rn|d|n)\s*\d+\b/g;
  const BRUIT = /\b(giratoire|rond ?point|carrefour|inter|intersection|rte|route|rue|avenue|av|bd|boulevard|chemin|impasse|allee|allees|place|zone|za|zi|parking|devant|pres|vers|chez)\b/g;
  const base = String(lieu || "").toLowerCase().replace(HEURE, " ").replace(/\s+/g, " ").trim();
  const allege = base.replace(CODES, " ").replace(BRUIT, " ").replace(/\s+/g, " ").trim();
  const mots = allege.split(" ").filter(Boolean);
  const out = [base, allege, mots.slice(0, 2).join(" ")];
  return [...new Set(out.filter((x) => x && x.length > 2))].slice(0, 3);
}

// Geocodage du lieu, comme le fait l'application, pour que le chauffeur recoive un
// lien Google Maps. Biaise autour des depots SONECO, et REJETTE tout point trop loin :
// sans ce garde-fou, "rn 141" renvoie un point pres de Rennes, a 280 km.
async function geocodeLieu(data: any, lieu: string): Promise<any> {
  const pts = (data.depots || []).map((d: any) => d._coords).filter((c: any) => Array.isArray(c) && c.length === 2);
  const ancres = pts.length ? pts : [[45.6, -0.9]];
  const lats = ancres.map((c: any) => c[0]), lons = ancres.map((c: any) => c[1]);
  const vb = (Math.min(...lons) - 1.2) + "," + (Math.max(...lats) + 1.2) + "," + (Math.max(...lons) + 1.2) + "," + (Math.min(...lats) - 1.2);
  const cands = geoCandidats(lieu);
  for (let i = 0; i < cands.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, 900));   // Nominatim : ~1 requete/seconde
    const url = "https://nominatim.openstreetmap.org/search?format=json&countrycodes=fr&limit=1"
      + "&viewbox=" + encodeURIComponent(vb) + "&q=" + encodeURIComponent(cands[i]);
    try {
      const r = await fetch(url, { headers: { "User-Agent": "RoadManager-SONECO/1.0 (planning)" } });
      if (!r.ok) continue;
      const j = await r.json();
      if (!j || !j[0] || j[0].lat == null) continue;
      const p = [Number(j[0].lat), Number(j[0].lon)];
      const d = Math.min(...ancres.map((a: any) => distKm(a, p)));
      if (d > 200) continue;                                // hors zone : on n'y croit pas
      // On renvoie AUSSI le nom trouve : un lieu ecrit a la main peut tomber sur un
      // homonyme (Cherves en Vienne au lieu de Cherves-Richemont). L'admin verifie.
      const nom = String(j[0].display_name || "").split(",").slice(0, 3).map((x: string) => x.trim()).join(", ");
      return { gps: p[0].toFixed(6) + "," + p[1].toFixed(6), nom, km: Math.round(d) };
    } catch (_e) { /* candidat suivant */ }
  }
  return null;
}

// L'admin peut envoyer un point Telegram ("lat,lon") OU coller un lien Google Maps.
function estCoords(t: string): boolean {
  const p = String(t || "").split(",");
  return p.length === 2 && !isNaN(Number(p[0])) && !isNaN(Number(p[1])) && String(t).indexOf("http") < 0;
}
function extraireCoords(u: string): string {
  for (const re of [/@(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/]) {
    const m = String(u || "").match(re);
    if (m) return Number(m[1]).toFixed(6) + "," + Number(m[2]).toFixed(6);
  }
  return "";
}
// Suit la redirection d'un lien court, puis cherche des coordonnees ; a defaut,
// geocode le nom de lieu contenu dans le lien lui-meme (pas le texte du chantier).
async function coordsDepuisLien(data: any, url: string): Promise<string> {
  let fin = url;
  try { const r = await fetch(url, { redirect: "follow" }); fin = r.url || url; } catch (_e) { /* on garde l'original */ }
  const c = extraireCoords(fin) || extraireCoords(url);
  if (c) return c;
  const m = String(fin).match(/[?&]q=([^&]+)/);
  if (m) {
    const lieu = decodeURIComponent(m[1].replace(/\+/g, " ")).trim();
    if (lieu && !estCoords(lieu)) {
      const g = await geocodeLieu(data, lieu);
      if (g && g.gps) return g.gps;
    }
  }
  return "";
}
// Le lien a mettre dans le message du chauffeur : lien colle tel quel, ou coordonnees.
function lienMaps(j: any): string {
  if (j.gps && String(j.gps).indexOf("http") === 0) return String(j.gps);
  const c = j.gps && estCoords(j.gps) ? j.gps : (j._geocodedGps || "");
  return c ? "https://www.google.com/maps?q=" + c : "";
}

// Complete la fiche a partir d'un LIEN Google Maps colle par l'admin : le lien reste
// cliquable pour le chauffeur, et on en tire des coordonnees pour la carte de l'app.
// On ne deduit JAMAIS de point a partir du texte du lieu : un point approximatif ou
// homonyme enverrait un chauffeur au mauvais endroit.
async function completerGps(data: any, prop: any): Promise<void> {
  const j = prop && prop.job;
  if (!j || !j.gps || String(j.gps).indexOf("http") !== 0 || j._geocodedGps) return;
  const c = await coordsDepuisLien(data, j.gps);
  if (c) j._geocodedGps = c;
  else (prop.warn = prop.warn || []).push("Lien Maps non convertible en coordonnees : la carte de l'app restera vide (le lien, lui, marche).");
}

function gsRowKey(iso: string, g: any): string {
  return [iso, normTxt(g.chauffeur), normTxt(g.machine), normTxt(g.lieu)].join("|");
}

// Envoie son chantier au chauffeur, au meme format que le bouton de l'application.
async function envoyerAuChauffeur(tg: any, data: any, job: any): Promise<boolean> {
  const link = (data.telegramEmpChats || {})[job.employeeId];
  if (!link || !link.chatId) return false;
  const drv = (data.employees || []).find((e: any) => e.id === job.employeeId);
  const prenom = drv && drv.name ? drv.name.split(" ")[0] : "";
  const cl = (data.clients || []).find((c: any) => c.id === job.clientId);
  const m = (data.machines || []).find((x: any) => x.id === job.machineId);
  const L = ["\u{1F44B} Salut " + prenom + " !", "\u{1F4CB} Ton chantier — " + fmtDateFR(job.date) + " :"];
  L.push("• " + (job.billingStart || "") + " " + (job.location || (cl ? cl.name : "chantier"))
    + (cl && job.location ? " (" + cl.name + ")" : "") + (m ? " [" + m.name + "]" : ""));
  if (job.siteManager) L.push("\u{1F477} Chef : " + job.siteManager + (job.siteManagerPhone ? " (" + job.siteManagerPhone + ")" : ""));
  const lien = lienMaps(job);
  if (lien) L.push("\u{1F5FA} " + lien);
  L.push("", "\u{1F447} Merci de confirmer que tu as bien lu.");
  try {
    const r = await tg("sendMessage", {
      chat_id: link.chatId, text: L.join("\n"), disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "✅ J'ai bien lu", callback_data: "ack:" + job.id }]] },
    });
    const j = await r.json();
    return !!(j && j.ok);
  } catch (_e) { return false; }
}

// Coeur de la surveillance. Renvoie le nombre de fiches envoyees.
async function gsWatch(tg: any, data: any): Promise<number> {
  const books = gsBooks(data);
  if (!books.length) return 0;
  const seen = data.gsheetSeen || {};
  const now = new Date();
  const semaines: any = {};        // cache : une seule requete par feuille
  const nouveaux: any[] = [];
  const oublier: string[] = [];    // cases decochees : on oublie, pour qu'un recochage renvoie la fiche
  const presentes = new Set<string>();   // lignes encore renseignees dans le classeur
  const joursLus = new Set<string>();

  for (let k = 0; k <= 14 && nouveaux.length < 25; k++) {
    const iso = isoParis(new Date(now.getTime() + k * 86400000));
    const w = gsIsoWeek(iso);
    if (!(w in semaines)) {
      semaines[w] = null;
      for (const b of books) {
        for (const nm of ["SEMAINE " + w, " SEMAINE " + w]) {
          const csv = await gsFetchSheet(b.id, nm);
          if (!csv) continue;
          const rows = gsParseCsv(csv);
          if (gsFindDay(rows, iso) >= 0) { semaines[w] = rows; break; }
        }
        if (semaines[w]) break;
      }
    }
    const rows = semaines[w];
    if (!rows) continue;
    const start = gsFindDay(rows, iso);
    if (start < 0) continue;
    joursLus.add(iso);
    for (const g of gsDayJobs(rows, start, data)) {
      if (gsEstNonChantier(g)) continue;        // repos / absence / depot
      const key = gsRowKey(iso, g);
      presentes.add(key);                        // la ligne existe encore, cochee ou non
      if (!g.informe) {
        // Case decochee : on efface la trace pour qu'un recochage renvoie la fiche.
        if (seen[key]) oublier.push(key);
        continue;
      }
      if (seen[key]) continue;
      nouveaux.push({ key, iso, g });
      if (nouveaux.length >= 25) break;
    }
  }
  // Ligne effacee du classeur (et non simplement decochee) : le chantier n'existe plus.
  const disparues: string[] = [];
  for (const k of Object.keys(seen)) {
    const iso0 = String(k).split("|")[0];
    if (!joursLus.has(iso0) || presentes.has(k)) continue;
    disparues.push(k);
  }
  if (!nouveaux.length && !disparues.length) {
    if (oublier.length) await mutate((d: any) => { if (d.gsheetSeen) for (const k of oublier) delete d.gsheetSeen[k]; });
    return 0;
  }

  // A partir d'ici seulement, on a besoin du bloc complet.
  const full = await loadData();
  const chats = adminChatList(full);
  let envoyees = 0;
  const pendings: any[] = [];
  const echecs: string[] = [];

  for (const n of nouveaux) {
    let machArg = n.g.machine.replace(/\s*\(.*\)$/, "");
    if (n.g.categorie !== "raboteuse") {
      if (!n.g.machineRM) {
        const code = (String(n.g.machine).match(/\(([^)]+)\)\s*$/) || [])[1] || n.g.machine;
        echecs.push((n.g.chauffeur || "?") + " " + n.iso + " : aucune " + n.g.categorie + " de RoadManager ne correspond au code « " + code + " ».");
        continue;
      }
      machArg = n.g.machineRM;
    }
    // DEPLACEMENT : le meme chantier (meme jour, meme lieu) est deja attribue a
    // quelqu'un d'autre -> on DEPLACE la ligne existante au lieu d'en creer une seconde.
    let baseDeplacee: any = null;
    if (n.g.lieu) {
      const e1 = resolveEmployee(full, n.g.chauffeur).emp;
      baseDeplacee = (full.jobs || []).find((x: any) => x.date === n.iso && x.employeeId && (!e1 || x.employeeId !== e1.id)
        && normTxt(x.location || "") === normTxt(n.g.lieu)) || null;
    }
    const prop = baseDeplacee ? buildProposal(full, {
      job_id: baseDeplacee.id, chauffeur: n.g.chauffeur, machine: machArg,
      client: n.g.client, lieu: n.g.lieu, heure: n.g.heure || undefined,
      nuit: !!n.g.nuit, forfait: n.g.forfait || undefined, chef: n.g.chef || undefined,
    }, "update", baseDeplacee) : buildProposal(full, {
      date: n.iso, chauffeur: n.g.chauffeur, machine: machArg,
      client: n.g.client, lieu: n.g.lieu, heure: n.g.heure || undefined,
      nuit: !!n.g.nuit, forfait: n.g.forfait || undefined, chef: n.g.chef || undefined,
    }, "create");
    if (prop.error) { echecs.push((n.g.chauffeur || "?") + " " + n.iso + " : " + prop.error); continue; }
    prop.lines[0] = baseDeplacee ? "\u{1F504} CHANTIER DEPLACE — a valider" : "\u{1F4E5} DU PLANNING DE PAPA — a valider";
    await completerGps(full, prop);
    for (const cid of chats) {
      const p = await sendProposalMessage(tg, cid, prop);
      p.job = prop.job;                          // meme chantier pour tous : pas de doublon si deux admins valident
      pendings.push(p);
    }
    envoyees++;
  }
  // Suppressions : une ligne effacee du classeur dont le chantier existe encore.
  for (const k of disparues) {
    const [iso0, ch0, , lieu0] = String(k).split("|");
    const e0 = resolveEmployee(full, ch0).emp;
    if (!e0) continue;
    const j0 = (full.jobs || []).find((x: any) => x.date === iso0 && x.employeeId === e0.id
      && (!lieu0 || normTxt(x.location || "") === lieu0));
    if (!j0) continue;
    // Decocher puis recocher declenche deux verifications coup sur coup : on evite
    // d'envoyer deux fois la meme demande de suppression.
    if ((full.tgProposals || []).some((x: any) => x.kind === "delete" && x.jobId === j0.id)) continue;
    if (pendings.some((x: any) => x.kind === "delete" && x.jobId === j0.id)) continue;
    const prop = buildProposal(full, { job_id: j0.id }, "delete");
    if (prop.error) continue;
    prop.lines[0] = "\u{1F5D1} EFFACE DU PLANNING DE PAPA — supprimer ce chantier ?";
    if (j0.sent || j0.ack) (prop.warn = prop.warn || []).push("Le chauffeur a DEJA RECU ce chantier : previens-le apres suppression.");
    for (const cid of chats) {
      const pp = await sendProposalMessage(tg, cid, prop);
      pp.job = prop.job || null; pp.jobId = j0.id;
      pendings.push(pp);
    }
    envoyees++;
  }
  for (const e of echecs) {
    for (const cid of chats) { try { await tg("sendMessage", { chat_id: cid, text: "⚠️ Ligne du planning de papa non recopiee — " + e }); } catch (_e2) { /* ignore */ } }
  }

  await mutate((d: any) => {
    d.gsheetSeen = d.gsheetSeen || {};
    for (const k of oublier) delete d.gsheetSeen[k];
    for (const k of disparues) delete d.gsheetSeen[k];
    for (const n of nouveaux) d.gsheetSeen[n.key] = Date.now();
    // purge au-dela de 60 jours pour ne pas laisser grossir le bloc
    for (const k of Object.keys(d.gsheetSeen)) if (Date.now() - d.gsheetSeen[k] > 60 * 86400000) delete d.gsheetSeen[k];
    if (pendings.length) {
      pruneProposals(d);
      d.tgProposals = (d.tgProposals || []).concat(pendings);
    }
  });
  return envoyees;
}

// ---- Boucle agent (tool use) ----------------------------------------------
async function anthropic(key: string, body: any): Promise<any> {
  const call = (extraHeaders: any, extraBody: any) => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, extraHeaders),
    body: JSON.stringify(Object.assign({}, body, extraBody)),
  });
  // Les replis serveur evitent qu'un refus de classifieur coupe net le bot.
  let r = await call({ "anthropic-beta": "server-side-fallback-2026-07-01" }, { fallbacks: "default" });
  if (r.status === 400) r = await call({}, {});  // si le beta n'est pas dispo, on reessaie sans
  return r;
}

// Couper le fil a 12 messages peut trancher au milieu d'un appel d'outil : il reste
// alors une reponse d'outil sans la question correspondante, et l'API refuse (erreur 400).
// On rogne donc jusqu'a retomber sur un vrai debut de conversation.
function trimConv(msgs: any[]): any[] {
  let out = (msgs || []).slice(-12);
  while (out.length) {
    const f = out[0];
    const orphelin = f.role === "user" && Array.isArray(f.content) && f.content.some((b: any) => b && b.type === "tool_result");
    if (orphelin || f.role !== "user") { out = out.slice(1); continue; }
    break;
  }
  return out;
}

// /diag : teste les parametres de la requete un par un pour localiser une erreur 400.
async function diagnostic(data: any): Promise<string> {
  const key = data.anthropicApiKey;
  if (!key) return "Aucune cle API enregistree dans les Reglages.";
  const model = data.aiAgentModel || "claude-opus-5";
  const base: any = { model, max_tokens: 64, messages: [{ role: "user", content: "dis OK" }] };
  const essais: any[] = [
    ["1. appel minimal", {}],
    ["2. + thinking adaptive", { thinking: { type: "adaptive" } }],
    ["3. + effort low", { output_config: { effort: "low" } }],
    ["4. + systeme en cache", { system: [{ type: "text", text: "Tu es un assistant. ".repeat(60), cache_control: { type: "ephemeral" } }] }],
    ["5. + un outil", { tools: [{ name: "t", description: "test", input_schema: { type: "object", properties: {}, } }] }],
    ["6. + fallbacks", { __beta: "server-side-fallback-2026-07-01", fallbacks: "default" }],
  ];
  const L: string[] = ["Diagnostic API — modele " + model];
  for (const [nom, extra] of essais) {
    const hdr: any = { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
    const body: any = Object.assign({}, base, extra);
    if (body.__beta) { hdr["anthropic-beta"] = body.__beta; delete body.__beta; }
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: hdr, body: JSON.stringify(body) });
      if (r.ok) { L.push(nom + " : OK"); continue; }
      let d = "";
      try { const j = await r.json(); d = (j && j.error && j.error.message) ? String(j.error.message) : ""; } catch (_e) { /* ignore */ }
      L.push(nom + " : ECHEC " + r.status + (d ? " — " + d.slice(0, 160) : ""));
    } catch (e) { L.push(nom + " : ECHEC reseau"); }
  }
  return L.join("\n");
}

async function runAgent(tg: any, data: any, chatId: string, userText: string, fixingId?: string): Promise<boolean> {
  const key = data.anthropicApiKey;
  if (!key) return false;
  const model = data.aiAgentModel || "claude-opus-5";
  const conv = (data.tgConv || {})[chatId];
  const history = trimConv((conv && Date.now() - (conv.ts || 0) < 60 * 60 * 1000 && Array.isArray(conv.m)) ? conv.m : []);
  const messages: any[] = history.slice();
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && Array.isArray(last.content)) {
    last.content = last.content.concat([{ type: "text", text: userText }]);
  } else {
    messages.push({ role: "user", content: userText });
  }
  // Deux blocs mis en cache separement, car ils ne changent pas au meme rythme :
  //  1. les consignes (jamais) + la definition des outils, qui les precede dans le cache ;
  //  2. les donnees (a chaque modification du planning), mais STABLES pendant toute la
  //     boucle d'outils d'un meme message.
  // Une conversation declenche 3 a 7 appels : sans cela, tout etait renvoye plein tarif
  // a chaque tour. Aucune perte de capacite, le contenu envoye est identique.
  const system = [
    { type: "text", text: AGENT_SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: "=== DONNEES ===\n" + agentContext(data, chatId) + "\n\n" + buildAIContext(data), cache_control: { type: "ephemeral" } },
  ];
  let entree = 0, cache = 0, sortie = 0;

  for (let step = 0; step < 7; step++) {
    const r = await anthropic(key, {
      model,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: data.aiAgentEffort || "low" },
      system,
      tools: AGENT_TOOLS,
      messages,
    });
    if (!r.ok) {
      let detail = "";
      try { const e = await r.json(); detail = (e && e.error && e.error.message) ? String(e.error.message) : ""; } catch (_e) { /* ignore */ }
      // On repart d'un fil propre : une conversation abimee reproduirait l'erreur a l'infini.
      await mutate((d: any) => { if (d.tgConv) delete d.tgConv[chatId]; });
      await tg("sendMessage", { chat_id: chatId, text: "⚠️ L'assistant a bute (erreur " + r.status + (detail ? " : " + detail.slice(0, 200) : "") + "). J'ai remis le fil a zero, redis-moi ta demande." });
      return true;
    }
    const j = await r.json();
    const u = j.usage || {};
    entree += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    cache += (u.cache_read_input_tokens || 0);
    sortie += (u.output_tokens || 0);
    const content = j.content || [];
    messages.push({ role: "assistant", content });

    const toolUses = content.filter((b: any) => b.type === "tool_use");
    const txt = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();

    if (!toolUses.length) {
      _cout = { appels: step + 1, entree, cache, sortie, gain: Math.round((cache / Math.max(1, entree + cache)) * 100) };
      if (txt) await tg("sendMessage", { chat_id: chatId, text: txt, disable_web_page_preview: true });
      // On ne garde le fil que si l'agent attend une reponse. Une simple consultation
      // ("qui travaille demain ?") n'ecrit alors RIEN du tout en base.
      await commitTurn(chatId, txt.indexOf("?") >= 0 ? [] : [], txt.indexOf("?") >= 0 ? messages : null);
      return true;
    }

    // On repond a TOUS les tool_use du tour (sinon la conversation devient invalide au tour suivant).
    const results: any[] = [];
    const pendings: any[] = [];
    let attenteChoix = false;
    for (const tu of toolUses) {
      const a = tu.input || {};
      if (tu.name === "lire_planning") {
        results.push({ type: "tool_result", tool_use_id: tu.id, content: toolLirePlanning(data, a) });
        continue;
      }
      if (tu.name === "bilan_planning_pere") {
        results.push({ type: "tool_result", tool_use_id: tu.id, content: await gsBilan(data, String(a.date_debut || ""), String(a.date_fin || ""), a.chauffeur) });
        continue;
      }
      if (tu.name === "comparer_planning") {
        results.push({ type: "tool_result", tool_use_id: tu.id, content: await toolComparerPlanning(data, String(a.date || "")) });
        continue;
      }
      if (tu.name === "chercher_contact") {
        const nom = String(a.nom || "");
        results.push({ type: "tool_result", tool_use_id: tu.id, content: rendreContacts(await chercherContactTout(data, nom, a.client), nom) });
        continue;
      }
      if (tu.name === "demander_choix") {
        const opts = (Array.isArray(a.options) ? a.options : []).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 6);
        if (opts.length < 2) { results.push({ type: "tool_result", tool_use_id: tu.id, content: "Il faut au moins 2 options.", is_error: true }); continue; }
        await mutate((d: any) => { d.tgChoix = d.tgChoix || {}; d.tgChoix[chatId] = { opts, ts: Date.now() }; });
        await tg("sendMessage", {
          chat_id: chatId, text: String(a.question || "Lequel ?"),
          reply_markup: { inline_keyboard: opts.map((o: string, i2: number) => [{ text: o.slice(0, 60), callback_data: "ch:" + i2 }]) },
        });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: "Question posee avec boutons. Attends la reponse de l'admin, n'ajoute rien." });
        attenteChoix = true;
        continue;
      }
      // Propose les contacts trouves SOUS FORME DE BOUTONS, rattaches a une fiche.
      if (tu.name === "proposer_contacts") {
        const nom = String(a.nom || "");
        const p0 = (data.tgProposals || []).find((x: any) => x.id === a.fiche_id && String(x.chatId) === String(chatId));
        if (!p0) { results.push({ type: "tool_result", tool_use_id: tu.id, content: "Fiche introuvable. Verifie fiche_id dans FICHES ENVOYEES.", is_error: true }); continue; }
        const trouves = (await chercherContactTout(data, nom, a.client)).filter((c: any) => c.tel);
        if (!trouves.length) {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "AUCUN contact trouve pour \"" + nom + "\". Dis-le clairement a l'admin et demande-lui le numero." });
          continue;
        }
        const liste = trouves.slice(0, 5).map((c: any) => ({ nom: c.nom, tel: c.tel, src: c.client }));
        const kb: any[] = liste.map((c: any, i2: number) => [{ text: c.nom + " — " + c.tel, callback_data: "ct:" + i2 }]);
        kb.push([{ text: "❌ Aucun de ceux-la", callback_data: "ct:x" }]);
        await mutate((d: any) => { d.tgContactChoix = d.tgContactChoix || {}; d.tgContactChoix[chatId] = { ficheId: p0.id, liste, ts: Date.now() }; });
        await tg("sendMessage", { chat_id: chatId, text: "\u{1F477} Contacts trouves pour « " + nom + " » — lequel ?", reply_markup: { inline_keyboard: kb } });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: liste.length + " contact(s) proposes sous forme de boutons. N'ajoute rien, attends le choix de l'admin." });
        continue;
      }
      if (tu.name === "lire_planning_pere") {
        const iso = String(a.date || "");
        const res = await gsLookupDay(data, iso);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: gsRender(iso, res) });
        continue;
      }
      const kind = tu.name === "creer_chantier" ? "create" : (tu.name === "modifier_chantier" || tu.name === "completer_fiche") ? "update" : tu.name === "supprimer_chantier" ? "delete" : "";
      if (!kind) { results.push({ type: "tool_result", tool_use_id: tu.id, content: "Outil inconnu.", is_error: true }); continue; }
      // completer_fiche : on repart de la fiche en attente, pas d'un chantier de RoadManager.
      let base0: any = null, remplace = "";
      if (tu.name === "completer_fiche") {
        const p0 = (data.tgProposals || []).find((x: any) => x.id === a.fiche_id && String(x.chatId) === String(chatId));
        if (!p0 || !p0.job) { results.push({ type: "tool_result", tool_use_id: tu.id, content: "Fiche introuvable ou expiree. Verifie fiche_id dans FICHES ENVOYEES.", is_error: true }); continue; }
        base0 = p0.job; remplace = p0.id;
      }
      const prop = buildProposal(data, a, kind, base0);
      if (prop.error) { results.push({ type: "tool_result", tool_use_id: tu.id, content: prop.error, is_error: true }); continue; }
      if (txt) await tg("sendMessage", { chat_id: chatId, text: txt, disable_web_page_preview: true });
      if (kind === "create" || kind === "update") await completerGps(data, prop);
      const pend = await sendProposalMessage(tg, chatId, prop);
      if (remplace) pend.remplace = remplace;
      pendings.push(pend);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: "Fiche envoyee a l'admin, en attente de sa validation :\n" + pend.text });
    }
    messages.push({ role: "user", content: results });

    // Question a boutons posee : on suspend le tour et on garde le fil pour la reprise.
    if (attenteChoix && !pendings.length) { await commitTurn(chatId, [], messages); return true; }

    // Fiche envoyee : on s'arrete la, MAIS on garde le fil pour que l'admin puisse corriger.
    // Proposition + fil sont ecrits ensemble : une seule relecture du blob.
    if (pendings.length) {
      _cout = { appels: step + 1, entree, cache, sortie, gain: Math.round((cache / Math.max(1, entree + cache)) * 100) };
      const olds = await commitTurn(chatId, pendings, messages, fixingId);
      await editReplacedProposals(tg, chatId, olds);
      if (pendings.length > 1) {
        await tg("sendMessage", { chat_id: chatId, text: "\u2b06\ufe0f " + pendings.length + " fiches a valider ci-dessus, une par une." });
      }
      return true;
    }
  }
  // Boucle epuisee : on le dit clairement plutot que de retomber sur le menu generique.
  await tg("sendMessage", { chat_id: chatId, text: "Je n'ai pas abouti. Reformule en precisant le jour et le chauffeur." });
  return true;
}



Deno.serve(async (req) => {
  try {
    const update = await req.json();
    const data = await loadData();
    const TG = data.telegramBotToken;
    if (!TG) return new Response("ok");

    const tg = (method: string, body: unknown) =>
      fetch(`https://api.telegram.org/bot${TG}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // 0pre) Surveillance du planning du pere (source dediee, lecture legere).
    if (update && update.source === "cron-gsheet") {
      // "machines" est necessaire pour resoudre les codes du classeur (R, RB, MA...).
      // ~4 Ko : la verification periodique reste tres legere.
      const light = await loadLight(["telegramBotToken", "gsheetBooks", "gsheetSeen", "telegramAdminChatId", "telegramAdminChats", "machines"]);
      if (!light.telegramBotToken || !(light.gsheetBooks || []).length) return new Response("ok");
      const tgL = (method: string, body: unknown) =>
        fetch(`https://api.telegram.org/bot${light.telegramBotToken}/${method}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
      await gsWatch(tgL, light);
      return new Response("ok");
    }

    // 0) Cron quotidien : presence des employes de station (declenche par pg_cron, vers 8h Paris)
    if (update && update.source === "cron-presence") {
      const hourParis = parseInt(new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }).format(new Date()), 10);
      if (hourParis !== 8) return new Response("ok"); // ne tire qu'a 8h heure de Paris
      if (data.tgNotifyPresence === false) return new Response("ok");
      const todayISO = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const dLabel = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "2-digit", month: "2-digit" }).format(new Date());
      const users = data.stationUsers || [];
      const absent = users.filter((u: any) => { const a = (u.availability || {})[todayISO]; return !a || (!a.am && !a.pm); });
      if (absent.length) {
        const chats = adminChatList(data);
        const lines = ["🌅 Présence stations — " + dLabel, "⚠️ Pas de présence indiquée aujourd'hui :", ...absent.map((u: any) => "• " + (u.name || u.login || "?"))];
        for (const cid of chats) await tg("sendMessage", { chat_id: cid, text: lines.join("\n") });
      }
      return new Response("ok");
    }

    // 0bis) Cron fin de mois : rappel "tickets carte bleue" aux salaries (vers 18h Paris, dernier jour du mois)
    if (update && update.source === "cron-cb-tickets") {
      const hourParis = parseInt(new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }).format(new Date()), 10);
      if (hourParis !== 18) return new Response("ok");
      if (data.tgNotifyCbTickets === false) return new Response("ok");
      const fmtP = (dt: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(dt);
      const todayP = fmtP(new Date());
      const tomorrowP = fmtP(new Date(Date.now() + 24 * 3600 * 1000));
      if (todayP.slice(0, 7) === tomorrowP.slice(0, 7)) return new Response("ok"); // pas le dernier jour du mois
      const ec = data.telegramEmpChats || {};
      for (const empId of Object.keys(ec)) {
        const chatId = ec[empId] && ec[empId].chatId;
        if (chatId) await tg("sendMessage", { chat_id: chatId, text: "👋 Bonjour ! C'est la fin du mois : pense à nous transmettre tes tickets de carte bleue (tous tes paiements du mois). Merci beaucoup et bonne journée ! 🙏" });
      }
      return new Response("ok");
    }

    // 1) Liaison via /start
    const msg = update.message;
    if (msg && typeof msg.text === "string" && msg.text.indexOf("/start") === 0) {
      const param = (msg.text.split(" ")[1] || "").trim();
      const chatId = String(msg.chat.id);
      if (param === "admin") {
        data.telegramAdminChats = data.telegramAdminChats || [];
        // migre l'admin "historique" (champ unique) dans la liste
        if (data.telegramAdminChatId && !data.telegramAdminChats.some((a: any) => String(a.chatId) === String(data.telegramAdminChatId))) {
          data.telegramAdminChats.push({ chatId: String(data.telegramAdminChatId), name: "admin", at: Date.now() });
        }
        if (!data.telegramAdminChats.some((a: any) => String(a.chatId) === String(chatId))) {
          data.telegramAdminChats.push({ chatId, name: msg.chat.first_name || "", at: Date.now() });
        }
        if (!data.telegramAdminChatId) data.telegramAdminChatId = chatId;
        await saveData(data);
        await tg("sendMessage", { chat_id: chatId, text: "✅ Tu es admin RoadManager. Tu recevras les mêmes alertes (pointages, signatures...)." });
      } else if (param.indexOf("emp_") === 0) {
        const empId = param.slice(4);
        data.telegramEmpChats = data.telegramEmpChats || {};
        data.telegramEmpChats[empId] = { chatId, name: msg.chat.first_name || "", at: Date.now() };
        await saveData(data);
        await tg("sendMessage", {
          chat_id: chatId,
          text: "✅ Ton Telegram est lié à RoadManager, " + empName(data, empId) + ".\nTu recevras ici les messages de l'admin.",
        });
      } else if (adminChatList(data).includes(chatId)) {
        await tg("sendMessage", { chat_id: chatId, text: "👋 Salut ! " + helpText(), reply_markup: MENU_KB });
      } else {
        await tg("sendMessage", {
          chat_id: chatId,
          text: "Bonjour ! Pour te lier à RoadManager, utilise le bouton « Lier mon Telegram » dans l'application.",
        });
      }
      return new Response("ok");
    }

    // 1ter) Medias envoyes par un admin : point GPS d'un chef de chantier, fiche contact, vocal.
    //       On memorise l'element recu, puis le message suivant dit a quel chantier il se rapporte.
    if (msg && adminChatList(data).includes(String(msg.chat.id))) {
      const chatId = String(msg.chat.id);
      const loc = msg.location || (msg.venue && msg.venue.location);
      if (loc && loc.latitude != null) {
        const gps = Number(loc.latitude).toFixed(6) + "," + Number(loc.longitude).toFixed(6);
        await mutate((d: any) => { d.tgPendingItem = d.tgPendingItem || {}; d.tgPendingItem[chatId] = { type: "gps", gps, ts: Date.now() }; });
        await tg("sendMessage", { chat_id: chatId, text: "\u{1F4CD} Point recu. C'est pour quel chantier ? (chauffeur + jour)" });
        return new Response("ok");
      }
      if (msg.contact && (msg.contact.phone_number || msg.contact.first_name)) {
        const nom = [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(" ");
        await mutate((d: any) => { d.tgPendingItem = d.tgPendingItem || {}; d.tgPendingItem[chatId] = { type: "contact", nom, tel: msg.contact.phone_number || "", ts: Date.now() }; });
        await tg("sendMessage", { chat_id: chatId, text: "\u{1F477} Contact recu (" + (nom || "?") + "). C'est le chef de quel chantier ? (chauffeur + jour)" });
        return new Response("ok");
      }
      // Lien Google Maps partage depuis l'application Maps : c'est un point GPS,
      // exactement comme une position Telegram epinglee.
      const lienGps = String(msg.text || "").match(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)\/?\S*/i);
      if (lienGps && !gsExtractId(msg.text || "")) {
        const url = lienGps[0];
        const reste = String(msg.text).replace(url, " ").replace(/\s+/g, " ").trim();
        if (reste.length < 4) {
          // Message contenant seulement le lien : on le met de cote et on demande pour qui.
          const coords = await coordsDepuisLien(data, url);
          await mutate((d: any) => { d.tgPendingItem = d.tgPendingItem || {}; d.tgPendingItem[chatId] = { type: "gps", gps: url, coords, ts: Date.now() }; });
          await tg("sendMessage", {
            chat_id: chatId,
            text: "\u{1F4CD} Point recu" + (coords ? "" : " (coordonnees non lisibles, le lien restera cliquable)") + ".\nC'est pour quel chantier ? (chauffeur + jour)",
            disable_web_page_preview: true,
          });
          return new Response("ok");
        }
      }
      const gsId = gsExtractId(msg.text || "");
      if (gsId) {
        const csv = await gsFetchSheet(gsId, "");
        if (!csv) {
          await tg("sendMessage", { chat_id: chatId, text: "Je n'arrive pas a lire ce classeur. Verifie qu'il est partage en lecture (« Tout utilisateur disposant du lien »)." });
          return new Response("ok");
        }
        const rows = gsParseCsv(csv);
        let premier = "";
        for (let r = 0; r < rows.length && !premier; r++) {
          for (let c = 0; c < (rows[r] || []).length; c++) {
            const v = gsCell(rows, r, c);
            if (/^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+\d/i.test(v)) { premier = v; break; }
          }
        }
        await mutate((d: any) => {
          d.gsheetBooks = (d.gsheetBooks || []).filter((b: any) => b.id !== gsId);
          d.gsheetBooks.push({ id: gsId, at: Date.now(), first: premier });
          d.gsheetBooks = d.gsheetBooks.slice(-6);
        });
        await tg("sendMessage", { chat_id: chatId, text: "Classeur enregistre" + (premier ? " (commence le " + premier + ")" : "") + "." });
        return new Response("ok");
      }
      if (msg.voice || msg.audio) {
        await tg("sendMessage", { chat_id: chatId, text: "\u{1F3A4} Je ne sais pas encore ecouter les vocaux. Ecris-moi le chantier pour l'instant." });
        return new Response("ok");
      }
    }

    // 1bis) Commandes texte (planning) — reservees aux admins
    if (msg && typeof msg.text === "string") {
      const chatId = String(msg.chat.id);
      if (adminChatList(data).includes(chatId)) {
        if (/^\/?cout\b/i.test(msg.text.trim())) {
          const c = data.tgDernierCout || null;
          await tg("sendMessage", { chat_id: chatId, text: c
            ? ("Dernier echange : " + c.appels + " appel(s)\n"
              + "- factures plein tarif : " + c.entree + " tokens\n"
              + "- relus depuis le cache : " + c.cache + " tokens (10x moins chers)\n"
              + "- reponse : " + c.sortie + " tokens\n"
              + "- economie du cache : " + c.gain + " %")
            : "Aucun echange mesure pour l'instant. Pose-moi une question puis refais /cout." });
          return new Response("ok");
        }
        if (/^\/?diag\b/i.test(msg.text.trim())) {
          await tg("sendChatAction", { chat_id: chatId, action: "typing" });
          await tg("sendMessage", { chat_id: chatId, text: await diagnostic(data) });
          return new Response("ok");
        }
        const reply = handleAdminQuery(data, msg.text);
        if (reply) { await tg("sendMessage", { chat_id: chatId, text: reply, disable_web_page_preview: true }); return new Response("ok"); }
        // Question ou ordre libre -> AGENT Claude (lecture + proposition d'ecriture)
        if (data.anthropicApiKey) {
          await tg("sendChatAction", { chat_id: chatId, action: "typing" });
          // Si un point GPS / un contact vient d'etre envoye, on le joint a la demande.
          let ask = msg.text;
          const pend = (data.tgPendingItem || {})[chatId];
          if (pend && Date.now() - (pend.ts || 0) < 30 * 60 * 1000) {
            if (pend.type === "gps") ask += "\n[Point GPS recu a l'instant, a poser tel quel dans le champ gps du chantier concerne : " + pend.gps + "]";
            if (pend.type === "contact") ask += "\n[Fiche contact recue a l'instant, c'est le chef de chantier : " + pend.nom + " " + pend.tel + "]";
            await mutate((d: any) => { if (d.tgPendingItem) delete d.tgPendingItem[chatId]; });
          }
          // Si l'admin vient d'appuyer sur "Corriger", on rattache sa reponse a CETTE fiche.
          let fixingId: string | undefined = undefined;
          const fx = (data.tgFixing || {})[chatId];
          if (fx && Date.now() - (fx.ts || 0) < 30 * 60 * 1000) {
            const prop = (data.tgProposals || []).find((x: any) => x.id === fx.propId);
            if (prop) {
              fixingId = prop.id;
              ask = "L'admin corrige la fiche en attente ci-dessous. Renvoie-la COMPLETE et corrigee via l'outil d'ecriture (pas seulement le champ change).\n--- FICHE ---\n" + prop.text + "\n--- CORRECTION DEMANDEE ---\n" + ask;
            }
            await mutate((d: any) => { if (d.tgFixing) delete d.tgFixing[chatId]; });
          }
          if (await runAgent(tg, data, chatId, ask, fixingId)) return new Response("ok");
          const ai = await askAI(data, msg.text);
          if (ai) { await tg("sendMessage", { chat_id: chatId, text: ai, disable_web_page_preview: true }); return new Response("ok"); }
        }
        await tg("sendMessage", { chat_id: chatId, text: (data.anthropicApiKey ? "Je n'ai pas pu répondre. " : "Je n'ai pas compris. ") + helpText(), reply_markup: MENU_KB });
        return new Response("ok");
      }
      // Salaries : on NE LIT PAS les messages ecrits, uniquement les boutons. On le leur rappelle gentiment.
      const isEmp = Object.values(data.telegramEmpChats || {}).some((l: any) => l && String(l.chatId) === chatId);
      if (isEmp) {
        await tg("sendMessage", { chat_id: chatId, text: "👋 Je ne lis pas les messages écrits ici 🙂.\nUtilise les boutons sous les messages (par ex. « ✅ J'ai bien lu »).\nPour joindre le bureau, appelle ou envoie un SMS directement." });
      }
      return new Response("ok");
    }

    // 2) Boutons sous la notif (callback_query)
    const cq = update.callback_query;
    if (cq && typeof cq.data === "string") {
      const parts = cq.data.split(":");
      const action = parts[0];
      // Prevenir un chauffeur qu'un chantier ne lui appartient plus.
      if (action === "annul") {
        const chatId = String((cq.message && cq.message.chat && cq.message.chat.id) || "");
        const mid = cq.message && cq.message.message_id;
        if (!adminChatList(data).includes(chatId)) { await tg("answerCallbackQuery", { callback_query_id: cq.id }); return new Response("ok"); }
        const anc = (data.jobs || []).find((x: any) => x.id === parts[1]);
        if (!anc) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Chantier introuvable", show_alert: true }); return new Response("ok"); }
        const lien = (data.telegramEmpChats || {})[anc.employeeId];
        const e0 = (data.employees || []).find((x: any) => x.id === anc.employeeId);
        const nm0 = e0 && e0.name ? e0.name.split(" ")[0] : "";
        if (!lien || !lien.chatId) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: nm0 + " n'a pas de Telegram lie", show_alert: true }); return new Response("ok"); }
        const cl = (data.clients || []).find((c: any) => c.id === anc.clientId);
        const ou = anc.location || (cl ? cl.name : "chantier");
        await tg("sendMessage", { chat_id: lien.chatId, text: "\u{26A0}\u{FE0F} Changement " + nm0 + " : le chantier de " + fmtDateFR(anc.date) + " (" + ou + ") n'est plus pour toi, il a ete confie a quelqu'un d'autre.\nNe t'y rends pas. Si tu as un doute, appelle le bureau." });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: nm0 + " est prevenu \u2705" });
        if (mid) { try { await tg("editMessageText", { chat_id: chatId, message_id: mid, text: "\u{2705} " + nm0 + " a ete prevenu que le chantier n'est plus pour lui." }); } catch (_e) { /* ignore */ } }
        return new Response("ok");
      }
      // Reponse a une question a boutons : on relance l'agent comme si l'admin l'avait ecrite.
      if (action === "ch") {
        const chatId = String((cq.message && cq.message.chat && cq.message.chat.id) || "");
        const mid = cq.message && cq.message.message_id;
        if (!adminChatList(data).includes(chatId)) { await tg("answerCallbackQuery", { callback_query_id: cq.id }); return new Response("ok"); }
        const ctx = (data.tgChoix || {})[chatId];
        const rep = ctx && (ctx.opts || [])[Number(parts[1])];
        if (!rep || Date.now() - (ctx.ts || 0) > 3600 * 1000) {
          await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Question expiree", show_alert: true });
          return new Response("ok");
        }
        await mutate((d: any) => { if (d.tgChoix) delete d.tgChoix[chatId]; });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: rep.slice(0, 190) });
        const base = (cq.message && cq.message.text) || "";
        if (mid) { try { await tg("editMessageText", { chat_id: chatId, message_id: mid, text: base + "\n\n\u{2705} " + rep }); } catch (_e) { /* ignore */ } }
        await tg("sendChatAction", { chat_id: chatId, action: "typing" });
        await runAgent(tg, data, chatId, rep);
        return new Response("ok");
      }
      // Choix d'un contact par bouton : on l'applique a la fiche et on la renvoie completee.
      if (action === "ct") {
        const chatId = String((cq.message && cq.message.chat && cq.message.chat.id) || "");
        const mid = cq.message && cq.message.message_id;
        if (!adminChatList(data).includes(chatId)) { await tg("answerCallbackQuery", { callback_query_id: cq.id }); return new Response("ok"); }
        const ctx = (data.tgContactChoix || {})[chatId];
        if (!ctx || Date.now() - (ctx.ts || 0) > 3600 * 1000) {
          await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Choix expire", show_alert: true });
          return new Response("ok");
        }
        await mutate((d: any) => { if (d.tgContactChoix) delete d.tgContactChoix[chatId]; });
        if (parts[1] === "x") {
          await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Compris" });
          if (mid) { try { await tg("editMessageText", { chat_id: chatId, message_id: mid, text: "\u{1F477} Aucun de ces contacts. Envoie-moi le bon numero." }); } catch (_e) { /* ignore */ } }
          return new Response("ok");
        }
        const c = (ctx.liste || [])[Number(parts[1])];
        const p0 = (data.tgProposals || []).find((x: any) => x.id === ctx.ficheId);
        if (!c || !p0 || !p0.job) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Fiche expiree", show_alert: true }); return new Response("ok"); }
        const prop = buildProposal(data, { chef: c.nom, telephone_chef: String(c.tel).split(" / ")[0] }, "update", p0.job);
        if (prop.error) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: prop.error.slice(0, 190), show_alert: true }); return new Response("ok"); }
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "✅ " + c.nom });
        if (mid) { try { await tg("editMessageText", { chat_id: chatId, message_id: mid, text: "\u{1F477} Chef retenu : " + c.nom + " — " + c.tel }); } catch (_e) { /* ignore */ } }
        const pend = await sendProposalMessage(tg, chatId, prop);
        pend.remplace = p0.id;
        const olds = await commitTurn(chatId, [pend], null);
        await editReplacedProposals(tg, chatId, olds);
        return new Response("ok");
      }
      // Bouton "Corriger" : on retient la fiche visee, la reponse suivante de l'admin la modifiera.
      if (action === "pfix") {
        const chatId = String((cq.message && cq.message.chat && cq.message.chat.id) || "");
        if (!adminChatList(data).includes(chatId)) { await tg("answerCallbackQuery", { callback_query_id: cq.id }); return new Response("ok"); }
        const prop = (data.tgProposals || []).find((x: any) => x.id === parts[1]);
        if (!prop) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Fiche expiree", show_alert: true }); return new Response("ok"); }
        await mutate((d: any) => { d.tgFixing = d.tgFixing || {}; d.tgFixing[chatId] = { propId: prop.id, ts: Date.now() }; });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Dis-moi ce qu'il faut corriger" });
        await tg("sendMessage", { chat_id: chatId, text: "✏️ Qu'est-ce qu'il faut corriger ?", reply_markup: { force_reply: true } });
        return new Response("ok");
      }
      // Validation / annulation d'une proposition d'ecriture de l'agent
      if (action === "pok" || action === "pno") {
        const chatId = String((cq.message && cq.message.chat && cq.message.chat.id) || "");
        const mid = cq.message && cq.message.message_id;
        if (!adminChatList(data).includes(chatId)) { await tg("answerCallbackQuery", { callback_query_id: cq.id }); return new Response("ok"); }
        const prop = (data.tgProposals || []).find((x: any) => x.id === parts[1]);
        if (!prop) {
          await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Proposition expiree", show_alert: true });
          return new Response("ok");
        }
        // On previent le chauffeur AVANT d'ecrire : on sait ainsi si sent=true est exact.
        let prevenu = false;
        if (action === "pok" && prop.kind !== "delete" && prop.job && prop.job.employeeId) {
          prevenu = await envoyerAuChauffeur(tg, data, prop.job);
        }
        const res = await resolveProposal(prop, chatId, action === "pok", prevenu);
        let tail = (action === "pok" ? "✅ " : "❌ ") + res;
        if (action === "pok" && prop.kind !== "delete") {
          const drv = (data.employees || []).find((e: any) => e.id === (prop.job || {}).employeeId);
          const nm = drv && drv.name ? drv.name.split(" ")[0] : "le chauffeur";
          tail += prevenu ? " " + nm + " a recu son chantier." : " (" + nm + " n'a pas de Telegram lie : previens-le autrement.)";
        }
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: tail });
        if (mid) { try { await tg("editMessageText", { chat_id: chatId, message_id: mid, text: (prop.text || "").replace(/\n\nC'est bien ca \?$/, "") + "\n\n" + tail, disable_web_page_preview: true }); } catch (_e) { /* ignore */ } }
        // Chantier repris a un autre chauffeur qui l'avait deja recu : on propose de le
        // prevenir. Jamais automatique : c'est un message qui part chez un salarie.
        if (action === "pok" && prop.job && prop.job.remplaceJobId) {
          const anc = (data.jobs || []).find((x: any) => x.id === prop.job.remplaceJobId);
          if (anc && (anc.sent || anc.ack)) {
            const e0 = (data.employees || []).find((x: any) => x.id === anc.employeeId);
            const nm0 = e0 && e0.name ? e0.name.split(" ")[0] : "le chauffeur";
            await tg("sendMessage", {
              chat_id: chatId,
              text: "\u{26A0}\u{FE0F} " + nm0 + " avait deja recu ce chantier sur Telegram. Il ne sait pas qu'il ne l'a plus.",
              reply_markup: { inline_keyboard: [[{ text: "\u{1F4E8} Prevenir " + nm0, callback_data: "annul:" + anc.id }]] },
            });
          }
        }
        return new Response("ok");
      }
      if (action === "q") {
        const chatId = String((cq.message && cq.message.chat && cq.message.chat.id) || "");
        if (adminChatList(data).includes(chatId)) {
          const map: any = { auj: "aujourdhui", demain: "demain", semaine: "semaine" };
          const reply = handleAdminQuery(data, map[parts[1]] || parts[1]) || helpText();
          await tg("sendMessage", { chat_id: chatId, text: reply, disable_web_page_preview: true });
        }
        await tg("answerCallbackQuery", { callback_query_id: cq.id });
        return new Response("ok");
      }
      // Bouton "J'ai bien lu" cote chauffeur : marque le chantier confirme (ack) -> la carte passe au vert cote admin
      if (action === "ack") {
        const jobId = parts[1];
        const job = (data.jobs || []).find((x: any) => x.id === jobId);
        if (job) { job.ack = true; job.ackDate = new Date().toISOString(); job._updatedAt = Date.now(); await saveData(data); }
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Merci, c'est noté ✅" });
        const aChat = cq.message && cq.message.chat && cq.message.chat.id;
        const aMid = cq.message && cq.message.message_id;
        const aOld = (cq.message && cq.message.text) || "";
        if (aChat && aMid) { try { await tg("editMessageText", { chat_id: aChat, message_id: aMid, text: aOld + "\n\n✅ Bien reçu, merci !", disable_web_page_preview: true }); } catch (_e) { /* ignore */ } }
        const drv = (data.employees || []).find((e: any) => e.id === (job && job.employeeId));
        const drvNm = drv ? drv.name : "Le chauffeur";
        for (const cid of adminChatList(data)) { try { await tg("sendMessage", { chat_id: cid, text: "👍 " + drvNm + " a bien reçu son chantier" + (job && job.location ? " (" + job.location + ")" : "") + "." }); } catch (_e) { /* ignore */ } }
        return new Response("ok");
      }
      // --- Coordination multi-admins (Option 1) : un seul admin traite, les boutons disparaissent chez tous ---
      const cqChat = String((cq.message && cq.message.chat && cq.message.chat.id) || "");
      const cqMsgId = cq.message && cq.message.message_id;
      const group = tgFindGroup(data, cqChat, cqMsgId);
      if (group && group.doneBy) {
        // Deja traite par un autre admin : on ne refait pas l'action, on s'assure juste que cette copie est finalisee.
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Déjà traité par " + group.doneBy });
        const base0 = group.text ? group.text + "\n\n" : "";
        try { await tg("editMessageText", { chat_id: cqChat, message_id: cqMsgId, text: base0 + "✅ Traité par " + group.doneBy + (group.result ? " — " + group.result : ""), disable_web_page_preview: true }); } catch (_e) { /* ignore */ }
        return new Response("ok");
      }
      // Nom affiche = prenom Telegram de celui qui clique (cq.from), sinon le prenom saisi dans Reglages, sinon "un admin".
      const presser = (cq.from && cq.from.first_name) ? cq.from.first_name : ((cq.from && cq.from.username) ? "@" + cq.from.username : tgPresser(data, cqChat));

      // Boutons forfait apres fin de chantier : ecrit le forfait + prix sur le chantier (remplit le planning)
      if (action === "ff") {
        if (!adminChatList(data).includes(cqChat)) { await tg("answerCallbackQuery", { callback_query_id: cq.id }); return new Response("ok"); }
        const jobId = parts[1], ft = parts[2], price = Number(parts[3] || 0);
        const job = (data.jobs || []).find((x: any) => x.id === jobId);
        if (!job) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Chantier introuvable", show_alert: true }); return new Response("ok"); }
        if (ft === "Transfert") {
          // Le transfert n'est pas un forfait : c'est l'add-on hasTransfer + transferPrice (bouton +T du planning)
          job.hasTransfer = true;
          job.transferPrice = price;
        } else {
          job.forfaitType = ft;
          job.priceForfait = price;
        }
        job._updatedAt = Date.now();
        const c = (data.clients || []).find((x: any) => x.id === job.clientId);
        const loc = job.location || (c ? c.name : "chantier");
        const label = ft === "Transfert" ? "transfert" : ("forfait " + ft);
        const resultLine = label + " (" + price + "€)";
        if (group) { await tgFinalizeGroup(tg, group, presser, resultLine); data.tgGroups = (data.tgGroups || []).filter((g: any) => Date.now() - (g.ts || 0) < 86400000); }
        await saveData(data);
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "✅ " + resultLine });
        if (!group) await tg("sendMessage", { chat_id: cqChat, text: "✅ Planning mis à jour : " + loc + " → " + resultLine });
        return new Response("ok");
      }
      const isR = action === "r";
      const threePart = isR || action === "next";
      const dest = isR ? parts[1] : null;       // id de depot ou "home"
      const arg = action === "next" ? parts[1] : null; // id du chantier
      const empId = threePart ? parts[2] : parts[1];
      const _nm = empName(data, empId);
      const name = _nm ? _nm.charAt(0).toUpperCase() + _nm.slice(1) : _nm;
      const link = (data.telegramEmpChats || {})[empId];
      if (!link || !link.chatId) {
        await tg("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: name + " n'a pas encore lié son Telegram.",
          show_alert: true,
        });
        return new Response("ok");
      }
      let resultLine = "";
      if (isR) {
        let destLabel = "à la maison";
        if (dest !== "home") {
          const dp = (data.depots || []).find((x: any) => x.id === dest);
          destLabel = "au " + (dp ? dp.name : "dépôt");
        }
        await tg("sendMessage", { chat_id: link.chatId, text: hi(name) + " Tu peux rentrer " + destLabel + ". " + pick(THANKS) + "\n\n" + nextDayPlan(data, empId) + weekendWish(data, empId) });
        resultLine = name + " rentre " + destLabel;
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Envoyé à " + name + " ✅" });
      } else if (action === "next") {
        const job = (data.jobs || []).find((x: any) => x.id === arg);
        if (!job) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Chantier introuvable" }); return new Response("ok"); }
        let txt = hi(name) + " " + pick(NEXT_INTRO) + "\n• " + jobLineF(data, job);
        const coords = parseCoordsF(job.gps || job._geocodedGps);
        if (coords) txt += "\n🗺 https://www.google.com/maps?q=" + coords[0] + "," + coords[1];
        await tg("sendMessage", { chat_id: link.chatId, text: txt });
        resultLine = name + " → prochain chantier";
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Envoyé à " + name + " ✅" });
      } else if (action === "rentrer") {
        await tg("sendMessage", { chat_id: link.chatId, text: hi(name) + " Tu peux rentrer au dépôt. " + pick(THANKS) + "\n\n" + nextDayPlan(data, empId) + weekendWish(data, empId) });
        resultLine = name + " rentre au dépôt";
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Envoyé à " + name + " ✅" });
      } else if (action === "plan") {
        await tg("sendMessage", { chat_id: link.chatId, text: hi(name) + " " + pick(PLAN_INTRO) + "\n\n" + nextDayPlan(data, empId) });
        resultLine = "planning envoyé à " + name;
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Planning envoyé à " + name + " 📅" });
      } else {
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Action inconnue" });
        return new Response("ok");
      }
      if (group) { await tgFinalizeGroup(tg, group, presser, resultLine); data.tgGroups = (data.tgGroups || []).filter((g: any) => Date.now() - (g.ts || 0) < 86400000); await saveData(data); }
      return new Response("ok");
    }

    return new Response("ok");
  } catch (_e) {
    // Toujours repondre 200 a Telegram pour eviter les renvois en boucle.
    return new Response("ok");
  }
});
