// ============================================================================
// RoadManager — Assistant vocal (Supabase Edge Function)
// ----------------------------------------------------------------------------
// Le navigateur de l'admin demande ici un "client secret" ephemere OpenAI Realtime
// (valable 10 minutes) pour ouvrir une conversation vocale en WebRTC.
// La cle OpenAI reste ici, dans le secret OPENAI_API_KEY : elle ne va jamais
// dans le navigateur ni dans le bloc app_data.
//
// Entree (POST JSON) : { user, pass, instructions, tools, voice? }
//   user/pass  : identifiants admin de RoadManager (verifies dans app_data)
//   instructions / tools : la consigne et les outils que l'app veut donner au modele
// Sortie : { value, expires_at, model }
//
// Deploiement : bash deploy-fn.sh assistant-vocal  (avec --no-verify-jwt)
// ============================================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = "gpt-realtime-2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function adminOk(user: string, pass: string): Promise<boolean> {
  // On ne lit que les deux champs, pas le bloc entier (1 Mo).
  const r = await fetch(`${SB_URL}/rest/v1/app_data?id=eq.main&select=u:data->>adminUser,p:data->>adminPass`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const rows = await r.json();
  const row = rows && rows[0];
  if (!row) return false;
  return (row.u || "admin") === user && (row.p || "admin") === pass;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST attendu" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch (_) { return json({ error: "JSON invalide" }, 400); }
  if (!(await adminOk(String(body.user || ""), String(body.pass || "")))) return json({ error: "Identifiants admin refuses" }, 401);
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return json({ error: "Cle OpenAI absente : ajouter le secret OPENAI_API_KEY dans Supabase (Edge Functions > Secrets)." }, 500);

  const session: any = {
    type: "realtime",
    model: MODEL,
    instructions: String(body.instructions || "Tu es l'assistant de SONECO. Reponds en francais, brievement."),
    audio: {
      input: { transcription: { model: "gpt-4o-mini-transcribe", language: "fr" }, turn_detection: { type: "semantic_vad", eagerness: "medium" } },
      output: { voice: String(body.voice || "marin") },
    },
  };
  if (Array.isArray(body.tools) && body.tools.length) session.tools = body.tools;

  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 600 }, session }),
  });
  const out = await r.json();
  if (!r.ok || !out.value) return json({ error: (out.error && out.error.message) || "OpenAI a refuse la demande", detail: out }, 502);
  return json({ value: out.value, expires_at: out.expires_at, model: MODEL });
});
