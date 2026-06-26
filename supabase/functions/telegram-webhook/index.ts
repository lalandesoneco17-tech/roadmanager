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
      return lines.join("\n");
    }
  }
  return "📅 Rien de prévu pour toi dans les prochains jours.";
}

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
  return weekendWork ? "" : "\n\n🌞 Et passe un très bon week-end !";
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

    // 1bis) Commandes texte (planning) — reservees aux admins
    if (msg && typeof msg.text === "string") {
      const chatId = String(msg.chat.id);
      if (adminChatList(data).includes(chatId)) {
        const reply = handleAdminQuery(data, msg.text);
        if (reply) { await tg("sendMessage", { chat_id: chatId, text: reply, disable_web_page_preview: true }); return new Response("ok"); }
        // Hybride : question libre -> IA Claude (seulement si une cle API est configuree)
        if (data.anthropicApiKey) {
          await tg("sendChatAction", { chat_id: chatId, action: "typing" });
          const ai = await askAI(data, msg.text);
          if (ai) { await tg("sendMessage", { chat_id: chatId, text: ai, disable_web_page_preview: true }); return new Response("ok"); }
        }
        await tg("sendMessage", { chat_id: chatId, text: (data.anthropicApiKey ? "Je n'ai pas pu répondre. " : "Je n'ai pas compris. ") + helpText(), reply_markup: MENU_KB });
        return new Response("ok");
      }
    }

    // 2) Boutons sous la notif (callback_query)
    const cq = update.callback_query;
    if (cq && typeof cq.data === "string") {
      const parts = cq.data.split(":");
      const action = parts[0];
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
      // Boutons forfait apres fin de chantier : ecrit le forfait + prix sur le chantier (remplit le planning)
      if (action === "ff") {
        const chatId = String((cq.message && cq.message.chat && cq.message.chat.id) || "");
        if (!adminChatList(data).includes(chatId)) { await tg("answerCallbackQuery", { callback_query_id: cq.id }); return new Response("ok"); }
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
        await saveData(data);
        const c = (data.clients || []).find((x: any) => x.id === job.clientId);
        const loc = job.location || (c ? c.name : "chantier");
        const label = ft === "Transfert" ? "transfert" : ("forfait " + ft);
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "✅ " + label + " (" + price + "€)" });
        await tg("sendMessage", { chat_id: chatId, text: "✅ Planning mis à jour : " + loc + " → " + label + " (" + price + "€)" });
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
      if (isR) {
        let destLabel = "à la maison";
        if (dest !== "home") {
          const dp = (data.depots || []).find((x: any) => x.id === dest);
          destLabel = "au " + (dp ? dp.name : "dépôt");
        }
        await tg("sendMessage", { chat_id: link.chatId, text: "👋 Salut " + name + " ! Tu peux rentrer " + destLabel + ". Bonne route, et merci pour ton travail aujourd'hui 🙏\n\n" + nextDayPlan(data, empId) + weekendWish(data, empId) });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Envoyé à " + name + " ✅" });
      } else if (action === "next") {
        const job = (data.jobs || []).find((x: any) => x.id === arg);
        if (!job) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Chantier introuvable" }); return new Response("ok"); }
        let txt = "👋 Salut " + name + " ! Quand tu peux, tu peux filer sur le prochain chantier 🚗 :\n• " + jobLineF(data, job);
        const coords = parseCoordsF(job.gps || job._geocodedGps);
        if (coords) txt += "\n🗺 https://www.google.com/maps?q=" + coords[0] + "," + coords[1];
        await tg("sendMessage", { chat_id: link.chatId, text: txt });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Envoyé à " + name + " ✅" });
      } else if (action === "rentrer") {
        await tg("sendMessage", { chat_id: link.chatId, text: "👋 Salut " + name + " ! Tu peux rentrer au dépôt. Bonne route, et merci pour ton travail aujourd'hui 🙏\n\n" + nextDayPlan(data, empId) + weekendWish(data, empId) });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Envoyé à " + name + " ✅" });
      } else if (action === "plan") {
        await tg("sendMessage", { chat_id: link.chatId, text: "👋 Salut " + name + " ! Voici ton planning 📅\n\n" + nextDayPlan(data, empId) });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Planning envoyé à " + name + " 📅" });
      } else {
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Action inconnue" });
      }
      return new Response("ok");
    }

    return new Response("ok");
  } catch (_e) {
    // Toujours repondre 200 a Telegram pour eviter les renvois en boucle.
    return new Response("ok");
  }
});
