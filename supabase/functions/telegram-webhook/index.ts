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
        if (chatId) await tg("sendMessage", { chat_id: chatId, text: "💳 Fin de mois ! Pense à nous donner tes tickets de carte bleue (tous les paiements du mois). Merci 🙏" });
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
      } else {
        await tg("sendMessage", {
          chat_id: chatId,
          text: "Bonjour ! Pour te lier à RoadManager, utilise le bouton « Lier mon Telegram » dans l'application.",
        });
      }
      return new Response("ok");
    }

    // 2) Boutons sous la notif (callback_query)
    const cq = update.callback_query;
    if (cq && typeof cq.data === "string") {
      const parts = cq.data.split(":");
      const action = parts[0];
      const isR = action === "r";
      const threePart = isR || action === "next";
      const dest = isR ? parts[1] : null;       // id de depot ou "home"
      const arg = action === "next" ? parts[1] : null; // id du chantier
      const empId = threePart ? parts[2] : parts[1];
      const name = empName(data, empId);
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
        await tg("sendMessage", { chat_id: link.chatId, text: "✅ Tu peux rentrer " + destLabel + ".\n\n" + nextDayPlan(data, empId) });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Envoyé à " + name + " ✅" });
      } else if (action === "next") {
        const job = (data.jobs || []).find((x: any) => x.id === arg);
        if (!job) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Chantier introuvable" }); return new Response("ok"); }
        let txt = "➡️ Tu peux aller sur le prochain chantier :\n• " + jobLineF(data, job);
        const coords = parseCoordsF(job.gps || job._geocodedGps);
        if (coords) txt += "\n🗺 https://www.google.com/maps?q=" + coords[0] + "," + coords[1];
        await tg("sendMessage", { chat_id: link.chatId, text: txt });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Envoyé à " + name + " ✅" });
      } else if (action === "rentrer") {
        await tg("sendMessage", { chat_id: link.chatId, text: "✅ Tu peux rentrer au dépôt.\n\n" + nextDayPlan(data, empId) });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Envoyé à " + name + " ✅" });
      } else if (action === "plan") {
        await tg("sendMessage", { chat_id: link.chatId, text: nextDayPlan(data, empId) });
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
