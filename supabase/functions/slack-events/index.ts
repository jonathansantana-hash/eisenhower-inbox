// Supabase Edge Function (multiusuário)
//  POST /slack-events            ← eventos do Slack (assinados)
//  POST /slack-events/connect    ← site pede o link para "Conectar Slack" (com JWT do usuário)
//  GET  /slack-events/oauth      ← volta do Slack com o código de autorização
import Anthropic from "npm:@anthropic-ai/sdk@1.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { classifyWithRules, estimateEffort, suggestEiQuadrant, type Classification } from "./rules.ts";

// ---------- Configuração ----------
const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const SUPABASE_URL = env("SUPABASE_URL");
const SLACK_SIGNING_SECRET = env("SLACK_SIGNING_SECRET");
const SLACK_CLIENT_ID = env("SLACK_CLIENT_ID");
const SLACK_CLIENT_SECRET = env("SLACK_CLIENT_SECRET");
const SITE_URL = env("SITE_URL", "https://jonathansantana-hash.github.io/eisenhower-inbox/");
const ALLOWED_DOMAIN = env("ALLOWED_EMAIL_DOMAIN", "hashtagtreinamentos.com");
const USER_SCOPES = "channels:history,groups:history,im:history,mpim:history,reactions:read,users:read";
const TRIGGER_EMOJIS = env("TRIGGER_EMOJI", "pushpin,round_pushpin").split(",").map((s) => s.trim()).filter(Boolean);

const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY"); // vazio = classificação por regras
const CLAUDE_MODEL = env("CLAUDE_MODEL", "claude-haiku-5-5");
const USER_CONTEXT = env("USER_CONTEXT", "Profissional da Hashtag Treinamentos (empresa de educação online).");

const supabase = createClient(SUPABASE_URL, env("SUPABASE_SERVICE_ROLE_KEY"));
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

// ---------- Roteamento HTTP ----------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (url.pathname.endsWith("/connect")) return startConnect(req);
  if (req.method === "GET" && url.pathname.endsWith("/oauth")) return finishConnect(url);
  if (req.method === "GET" && url.pathname.endsWith("/install")) return Response.redirect(SITE_URL, 302); // link antigo
  if (req.method !== "POST") return new Response("ok");

  const body = await req.text();
  if (!(await verifySlackSignature(req, body))) {
    console.warn("[recusado] assinatura do Slack inválida — confira SLACK_SIGNING_SECRET");
    return new Response("invalid signature", { status: 401 });
  }
  const payload = JSON.parse(body);

  if (payload.type === "url_verification") {
    return new Response(payload.challenge, { headers: { "content-type": "text/plain" } });
  }
  if (req.headers.get("x-slack-retry-num")) return new Response("ok"); // dedupe por (dono, canal, ts)

  if (payload.type === "event_callback") {
    // @ts-ignore EdgeRuntime existe no runtime do Supabase
    EdgeRuntime.waitUntil(handleEvent(payload).catch((e) => console.error("handleEvent failed", e)));
  }
  return new Response("ok");
});

// =====================================================================
// Conectar o Slack de uma pessoa (OAuth com token de usuário)
// =====================================================================
const redirectUri = () => `${SUPABASE_URL}/functions/v1/slack-events/oauth`;

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "content-type": "application/json" } });

const backToSite = (params: Record<string, string>) => {
  const u = new URL(SITE_URL);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return Response.redirect(u.toString(), 302);
};

function emailAllowed(email?: string | null) {
  return !!email && email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`);
}

async function startConnect(req: Request) {
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) return json({ error: "Faltam SLACK_CLIENT_ID/SLACK_CLIENT_SECRET" }, 500);
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Faça login primeiro" }, 401);
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) return json({ error: "Sessão inválida, entre de novo" }, 401);

  // Checa domínio (ou exceção cadastrada em allowed_users)
  if (!emailAllowed(data.user.email)) {
    const { data: ok } = await supabase.rpc("email_is_allowed", { p_email: data.user.email });
    if (!ok) return json({ error: "Acesso restrito" }, 403);
  }

  const ts = String(Date.now());
  const payload = `${data.user.id}.${ts}`;
  const state = `${payload}.${await hmacHex(SLACK_CLIENT_SECRET, payload)}`;
  const auth = new URL("https://slack.com/oauth/v2/authorize");
  auth.searchParams.set("client_id", SLACK_CLIENT_ID);
  auth.searchParams.set("user_scope", USER_SCOPES);
  auth.searchParams.set("redirect_uri", redirectUri());
  auth.searchParams.set("state", state);
  return json({ url: auth.toString() });
}

async function finishConnect(url: URL) {
  if (url.searchParams.get("error")) return backToSite({ slack: "cancelado" });
  const code = url.searchParams.get("code");
  const [userId, ts, sig] = (url.searchParams.get("state") ?? "").split(".");
  if (!code || !userId || !ts || sig !== (await hmacHex(SLACK_CLIENT_SECRET, `${userId}.${ts}`)) || Date.now() - Number(ts) > 15 * 60_000) {
    return backToSite({ slack: "expirado" });
  }

  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: SLACK_CLIENT_ID, client_secret: SLACK_CLIENT_SECRET, code, redirect_uri: redirectUri() }),
  });
  const data = await res.json();
  const token = data.authed_user?.access_token;
  const slackUserId = data.authed_user?.id;
  if (!data.ok || !token || !slackUserId) {
    console.error("oauth.v2.access failed", data.error);
    return backToSite({ slack: "erro" });
  }

  // Um mesmo usuário do Slack não pode estar ligado a duas contas
  const { data: other } = await supabase
    .from("slack_connections").select("user_id").eq("slack_user_id", slackUserId).neq("user_id", userId).maybeSingle();
  if (other) return backToSite({ slack: "em-uso" });

  const { error } = await supabase.from("slack_connections").upsert({
    user_id: userId,
    slack_user_id: slackUserId,
    team_id: data.team?.id ?? null,
    access_token: token,
    scopes: data.authed_user?.scope ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("save slack_connections failed", error);
    return backToSite({ slack: "erro" });
  }
  invalidateConnections();
  console.log("[conectado]", userId, slackUserId);
  return backToSite({ slack: "ok" });
}

// =====================================================================
// Pessoas conectadas + preferências (cache de 60s por instância)
// =====================================================================
type Settings = {
  watch_dms: boolean;
  watch_mentions: boolean;
  watch_channel_ids: string[];
  vip_user_ids: string[];
  important_keywords: string[];
};
type Person = { userId: string; slackUserId: string; token: string; settings: Settings };

const DEFAULT_SETTINGS: Settings = { watch_dms: true, watch_mentions: true, watch_channel_ids: [], vip_user_ids: [], important_keywords: [] };
let peopleCache: { at: number; bySlack: Map<string, Person> } | null = null;
const invalidateConnections = () => (peopleCache = null);

async function people(): Promise<Map<string, Person>> {
  if (peopleCache && Date.now() - peopleCache.at < 60_000) return peopleCache.bySlack;
  const [{ data: conns }, { data: settings }] = await Promise.all([
    supabase.from("slack_connections").select("user_id, slack_user_id, access_token"),
    supabase.from("user_settings").select("*"),
  ]);
  const sMap = new Map((settings ?? []).map((s) => [s.user_id as string, s as Settings]));
  const bySlack = new Map<string, Person>();
  for (const c of conns ?? []) {
    bySlack.set(c.slack_user_id, {
      userId: c.user_id,
      slackUserId: c.slack_user_id,
      token: c.access_token,
      settings: { ...DEFAULT_SETTINGS, ...(sMap.get(c.user_id) ?? {}) },
    });
  }
  peopleCache = { at: Date.now(), bySlack };
  return bySlack;
}

// =====================================================================
// Eventos do Slack
// =====================================================================
type SlackMsg = { channel: string; ts: string; user?: string; text: string; team?: string };

async function handleEvent(payload: any) {
  const ev = payload.event;
  if (!ev) return;
  const map = await people();
  const viaSlackId = payload.authorizations?.[0]?.user_id as string | undefined;
  const via = viaSlackId ? map.get(viaSlackId) : undefined; // token de quem "viu" o evento
  console.log("[evento]", ev.type, ev.channel_type ?? "", ev.subtype ?? "", "de:", ev.user, "via:", viaSlackId, "conectados:", map.size);

  // 1) Reação 📌: vira tarefa para quem reagiu
  if (ev.type === "reaction_added") {
    const reactor = map.get(ev.user);
    if (!reactor || ev.item?.type !== "message") return;
    if (!TRIGGER_EMOJIS.includes(ev.reaction)) return console.log(`[ignorado] reação :${ev.reaction}: não é gatilho`);
    const msg = await fetchMessage(reactor.token, ev.item.channel, ev.item.ts);
    if (!msg) return console.warn("[erro] não consegui ler a mensagem reagida");
    await processMessage({ ...msg, team: payload.team_id }, reactor, true);
    return;
  }

  if (ev.type !== "message" || ev.subtype || ev.bot_id) return;
  const text: string = ev.text ?? "";
  const sender: string | undefined = ev.user;
  const recipients = new Map<string, Person>();

  // 2) DM / DM em grupo: destinatários = membros da conversa, menos quem enviou
  if (ev.channel_type === "im" || ev.channel_type === "mpim") {
    const tokenForLookup = via?.token ?? [...map.values()][0]?.token;
    const members = tokenForLookup ? await channelMembers(tokenForLookup, ev.channel) : [];
    for (const m of members) {
      const p = map.get(m);
      if (p && m !== sender && p.settings.watch_dms) recipients.set(p.userId, p);
    }
  } else {
    // 3) Menções em canais
    for (const [, id] of text.matchAll(/<@([A-Z0-9]+)>/g)) {
      const p = map.get(id);
      if (p && id !== sender && p.settings.watch_mentions) recipients.set(p.userId, p);
    }
    // 4) Canais monitorados por alguém
    for (const p of map.values()) {
      if (p.slackUserId !== sender && p.settings.watch_channel_ids.includes(ev.channel)) recipients.set(p.userId, p);
    }
  }

  if (recipients.size === 0) return console.log("[ignorado] ninguém conectado é destinatário");
  const msg: SlackMsg = { channel: ev.channel, ts: ev.ts, user: sender, text, team: payload.team_id };
  await Promise.all([...recipients.values()].map((p) => processMessage(msg, p, false)));
}

// Filtro barato antes de classificar
const TRIVIAL = /^(ok|okay|blz|beleza|valeu|vlw|obrigad[oa]|obg|show|top|bom dia|boa tarde|boa noite|oi|olá|ola|kkk+|haha+|👍|🙏|✅)[!. ]*$/i;
function isTrivial(text: string) {
  const t = text.replace(/<@[A-Z0-9]+>/g, "").trim();
  return t.length < 8 || TRIVIAL.test(t);
}

async function processMessage(msg: SlackMsg, owner: Person, forced: boolean) {
  const tag = `[${owner.slackUserId}]`;
  if (!forced && isTrivial(msg.text)) return console.log(tag, "[ignorado] mensagem trivial");

  const { data: existing } = await supabase
    .from("tasks").select("id")
    .eq("owner_id", owner.userId).eq("slack_channel_id", msg.channel).eq("slack_ts", msg.ts)
    .maybeSingle();
  if (existing) return;

  const [authorName, permalink] = await Promise.all([
    msg.user ? getUserName(owner.token, msg.user) : Promise.resolve(null),
    getPermalink(owner.token, msg.channel, msg.ts),
  ]);
  const text = await resolveMentions(owner, msg.text);

  const result =
    (anthropic && (await classifyWithClaude(text, authorName, forced))) ||
    classifyWithRules(text, {
      forced,
      authorIsVip: !!msg.user && owner.settings.vip_user_ids.includes(msg.user),
      extraImportantKeywords: owner.settings.important_keywords,
    });
  if (!result.is_task && !forced) return console.log(tag, "[ignorado] não parece tarefa:", result.title);

  const importance = clamp(result.importance);
  const effort = estimateEffort(text);
  const { error } = await supabase.from("tasks").insert({
    owner_id: owner.userId,
    source: "slack",
    slack_team_id: msg.team ?? null,
    slack_channel_id: msg.channel,
    slack_ts: msg.ts,
    slack_user_id: msg.user ?? null,
    slack_user_name: authorName,
    permalink,
    raw_text: text,
    title: result.title,
    summary: result.summary || null,
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(result.due_date) ? result.due_date : null,
    urgency: clamp(result.urgency),
    importance,
    effort,
    suggested_quadrant: result.suggested_quadrant,
    suggested_ei_quadrant: suggestEiQuadrant(importance, effort),
    ai_reason: result.reason,
  });
  if (error && error.code !== "23505") console.error(tag, "insert failed", error);
  else console.log(tag, "[salvo]", result.suggested_quadrant, result.title);
}

const clamp = (n: number) => Math.min(5, Math.max(1, Math.round(n || 3)));

// =====================================================================
// IA (opcional — só com ANTHROPIC_API_KEY)
// =====================================================================
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_task", "title", "summary", "urgency", "importance", "suggested_quadrant", "reason", "due_date"],
  properties: {
    is_task: { type: "boolean", description: "A mensagem pede (explícita ou implicitamente) que EU faça, responda, revise, decida ou entregue algo?" },
    title: { type: "string", description: "Título curto e acionável, começando com verbo (máx. ~70 caracteres)." },
    summary: { type: "string", description: "1-2 frases com o contexto necessário para executar." },
    urgency: { type: "integer", description: "1 (sem pressa) a 5 (precisa ser hoje)." },
    importance: { type: "integer", description: "1 (irrelevante) a 5 (crítico)." },
    suggested_quadrant: {
      type: "string",
      enum: ["q1", "q2", "q3", "q4"],
      description: "q1=urgente+importante, q2=importante não urgente, q3=urgente não importante, q4=nem um nem outro.",
    },
    reason: { type: "string", description: "Justificativa curta (1 frase) para o quadrante sugerido." },
    due_date: { type: "string", description: "Prazo AAAA-MM-DD se houver um prazo claro; senão string vazia." },
  },
} as const;

const SYSTEM_PROMPT = `Você é um assistente de triagem. Recebe mensagens do Slack enviadas para uma pessoa e decide se cada uma é um pedido de tarefa para ela. Se for, extrai a tarefa e sugere o quadrante da matriz de Eisenhower.

Contexto: ${USER_CONTEXT}

- É tarefa quando alguém espera uma ação: fazer, revisar, aprovar, responder com informação, decidir, comparecer, enviar.
- Não é tarefa: avisos informativos, agradecimentos, conversa social.
- Seja calibrado: a maioria das coisas NÃO é q1.
- Escreva título, resumo e justificativa em português.`;

async function classifyWithClaude(text: string, author: string | null, forced: boolean): Promise<Classification | null> {
  if (!anthropic) return null;
  try {
    const supportsFallback = !CLAUDE_MODEL.startsWith("claude-haiku");
    const response = await anthropic.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      ...(supportsFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          `Data de hoje: ${new Date().toISOString().slice(0, 10)}`,
          forced ? "A pessoa marcou esta mensagem como tarefa; considere is_task = true." : "",
          `Autor: ${author ?? "desconhecido"}`,
          `Mensagem:\n"""\n${text}\n"""`,
        ].filter(Boolean).join("\n\n"),
      }],
    });
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null;
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? (JSON.parse(block.text) as Classification) : null;
  } catch (e) {
    if (e instanceof Anthropic.APIError) console.error("Claude API error", e.status, e.message);
    else console.error("classify failed", e);
    return null;
  }
}

// =====================================================================
// Slack Web API (sempre com o token da pessoa)
// =====================================================================
async function slack(token: string, method: string, params: Record<string, string>) {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await res.json();
  if (!j.ok) console.warn(`slack ${method} failed:`, j.error);
  return j;
}

const nameCache = new Map<string, string>();
async function getUserName(token: string, userId: string): Promise<string | null> {
  if (nameCache.has(userId)) return nameCache.get(userId)!;
  const r = await slack(token, "users.info", { user: userId });
  const name = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || null;
  if (name) nameCache.set(userId, name);
  return name;
}

async function getPermalink(token: string, channel: string, ts: string): Promise<string | null> {
  const r = await slack(token, "chat.getPermalink", { channel, message_ts: ts });
  return r.permalink ?? null;
}

const membersCache = new Map<string, string[]>(); // membros de DM não mudam
async function channelMembers(token: string, channel: string): Promise<string[]> {
  if (membersCache.has(channel)) return membersCache.get(channel)!;
  const r = await slack(token, "conversations.members", { channel, limit: "50" });
  const members: string[] = r.members ?? [];
  if (members.length) membersCache.set(channel, members);
  return members;
}

async function fetchMessage(token: string, channel: string, ts: string): Promise<SlackMsg | null> {
  const r = await slack(token, "conversations.replies", { channel, ts, limit: "1", inclusive: "true" });
  const m = r.messages?.find((x: any) => x.ts === ts);
  return m ? { channel, ts, user: m.user, text: m.text ?? "" } : null;
}

async function resolveMentions(owner: Person, text: string): Promise<string> {
  const ids = [...new Set([...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]))];
  for (const id of ids) {
    const name = id === owner.slackUserId ? "eu" : await getUserName(owner.token, id);
    if (name) text = text.replaceAll(`<@${id}>`, `@${name}`);
  }
  return text;
}

// =====================================================================
// Assinatura do Slack
// =====================================================================
async function verifySlackSignature(req: Request, body: string): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");
  if (!ts || !sig || !SLACK_SIGNING_SECRET) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;
  const expected = "v0=" + (await hmacHex(SLACK_SIGNING_SECRET, `v0:${ts}:${body}`));
  return timingSafeEqual(expected, sig);
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
