// Supabase Edge Function: recebe eventos do Slack, decide se é tarefa e salva na tabela `tasks`.
import Anthropic from "npm:@anthropic-ai/sdk@1.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { classifyWithRules, estimateEffort, suggestEiQuadrant, type Classification } from "./rules.ts";

// ---------- Configuração (secrets do Supabase) ----------
const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const SLACK_SIGNING_SECRET = env("SLACK_SIGNING_SECRET");
const SLACK_CLIENT_ID = env("SLACK_CLIENT_ID");
const SLACK_CLIENT_SECRET = env("SLACK_CLIENT_SECRET");
// Token e ID do usuário: vêm dos secrets OU do banco (preenchidos ao visitar /install)
let SLACK_USER_TOKEN = env("SLACK_USER_TOKEN"); // xoxp-...
let MY_SLACK_USER_ID = env("MY_SLACK_USER_ID"); // U0123...
const USER_SCOPES = "channels:history,groups:history,im:history,mpim:history,reactions:read,users:read";
const WATCH_DMS = env("WATCH_DMS", "true") === "true";
const WATCH_MENTIONS = env("WATCH_MENTIONS", "true") === "true";
const WATCH_CHANNEL_IDS = env("WATCH_CHANNEL_IDS").split(",").map((s) => s.trim()).filter(Boolean);
// reagir com 📌 ou 📍 força virar tarefa
const TRIGGER_EMOJIS = env("TRIGGER_EMOJI", "pushpin,round_pushpin").split(",").map((s) => s.trim()).filter(Boolean);
const VIP_USER_IDS = env("VIP_USER_IDS").split(",").map((s) => s.trim()).filter(Boolean); // pessoas-chave (chefe etc.)
const IMPORTANT_KEYWORDS = env("IMPORTANT_KEYWORDS").split(",").map((s) => s.trim()).filter(Boolean);
const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY"); // vazio = classificação por regras, sem IA
const CLAUDE_MODEL = env("CLAUDE_MODEL", "claude-haiku-5-5");
const USER_CONTEXT = env(
  "USER_CONTEXT",
  "Sou um profissional ocupado. Priorizo entregas para clientes, receita e compromissos com minha liderança.",
);

const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// ---------- Entrada HTTP ----------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname.endsWith("/install")) return startInstall(url);
  if (req.method === "GET" && url.pathname.endsWith("/oauth")) return finishInstall(url);
  if (req.method !== "POST") return new Response("ok");

  const body = await req.text();
  if (!(await verifySlackSignature(req, body))) {
    console.warn("[recusado] assinatura do Slack inválida — confira SLACK_SIGNING_SECRET");
    return new Response("invalid signature", { status: 401 });
  }

  const payload = JSON.parse(body);
  await loadSlackAuth();

  if (payload.type === "url_verification") {
    return new Response(payload.challenge, { headers: { "content-type": "text/plain" } });
  }

  // Retries do Slack: já processamos (ou estamos processando) o original — dedupe pelo slack_ts.
  if (req.headers.get("x-slack-retry-num")) return new Response("ok");

  if (payload.type === "event_callback") {
    // Responde em < 3s e processa em segundo plano
    // @ts-ignore EdgeRuntime existe no runtime do Supabase
    EdgeRuntime.waitUntil(handleEvent(payload).catch((e) => console.error("handleEvent failed", e)));
  }
  return new Response("ok");
});

// ---------- Instalação via OAuth (obtém o token sem copiar/colar) ----------
// Usa SUPABASE_URL (o host em req.url pode ser interno no runtime do Supabase)
const redirectUri = (_url: URL) => `${env("SUPABASE_URL")}/functions/v1/slack-events/oauth`;

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const html = (msg: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 16px;text-align:center">${msg}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

async function startInstall(url: URL) {
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) return html("Faltam os secrets SLACK_CLIENT_ID e SLACK_CLIENT_SECRET.", 500);
  const ts = String(Date.now());
  const state = `${ts}.${await hmacHex(SLACK_CLIENT_SECRET, ts)}`; // proteção CSRF
  const auth = new URL("https://slack.com/oauth/v2/authorize");
  auth.searchParams.set("client_id", SLACK_CLIENT_ID);
  auth.searchParams.set("user_scope", USER_SCOPES);
  auth.searchParams.set("redirect_uri", redirectUri(url));
  auth.searchParams.set("state", state);
  return Response.redirect(auth.toString(), 302);
}

async function finishInstall(url: URL) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  if (url.searchParams.get("error")) return html(`Instalação cancelada: ${url.searchParams.get("error")}`, 400);
  const [ts, sig] = state.split(".");
  if (!code || !ts || sig !== (await hmacHex(SLACK_CLIENT_SECRET, ts)) || Date.now() - Number(ts) > 10 * 60_000) {
    return html("Link expirado ou inválido. Abra o endereço /install de novo.", 400);
  }

  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: SLACK_CLIENT_ID, client_secret: SLACK_CLIENT_SECRET, code, redirect_uri: redirectUri(url) }),
  });
  const data = await res.json();
  const token = data.authed_user?.access_token;
  const userId = data.authed_user?.id;
  if (!data.ok || !token || !userId) {
    console.error("oauth.v2.access failed", data.error);
    return html(`O Slack recusou: <b>${data.error ?? "sem token de usuário"}</b>`, 400);
  }

  // Só o dono pode (re)instalar: evita que outra pessoa troque o token pelo dela
  await loadSlackAuth();
  if (MY_SLACK_USER_ID && MY_SLACK_USER_ID !== userId) {
    return html("Este app já está vinculado a outro usuário do Slack.", 403);
  }

  const { error } = await supabase.from("slack_auth").upsert({
    id: 1, user_id: userId, team_id: data.team?.id ?? null, access_token: token, scopes: data.authed_user?.scope ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("save slack_auth failed", error);
    return html("Não consegui salvar o token no banco. Veja os logs da função.", 500);
  }
  SLACK_USER_TOKEN = token;
  MY_SLACK_USER_ID = userId;
  return html(`✅ <b>Pronto!</b><br>Slack conectado (usuário ${userId}).<br>Pode fechar esta aba.`);
}

let authLoaded = false;
async function loadSlackAuth() {
  if (authLoaded || (SLACK_USER_TOKEN && MY_SLACK_USER_ID)) return;
  const { data } = await supabase.from("slack_auth").select("user_id, access_token").eq("id", 1).maybeSingle();
  if (data) {
    SLACK_USER_TOKEN ||= data.access_token;
    MY_SLACK_USER_ID ||= data.user_id;
    authLoaded = true;
  }
}

// ---------- Assinatura do Slack ----------
async function verifySlackSignature(req: Request, body: string): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");
  if (!ts || !sig || !SLACK_SIGNING_SECRET) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  const expected = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, sig);
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- Roteamento de eventos ----------
type SlackMsg = { channel: string; ts: string; user?: string; text: string; team?: string };

async function handleEvent(payload: any) {
  const ev = payload.event;
  if (!ev) return;
  console.log("[evento]", ev.type, ev.channel_type ?? "", ev.subtype ?? "", "user:", ev.user, "me:", MY_SLACK_USER_ID || "(não carregado)", "token:", SLACK_USER_TOKEN ? "ok" : "FALTANDO");

  // 1) Reação com o emoji gatilho → vira tarefa sem perguntar à IA se é tarefa
  if (ev.type === "reaction_added") {
    if (ev.user !== MY_SLACK_USER_ID || ev.item?.type !== "message") return;
    if (!TRIGGER_EMOJIS.includes(ev.reaction)) {
      return console.log(`[ignorado] reação :${ev.reaction}: não é gatilho (use :${TRIGGER_EMOJIS.join(": ou :")}:)`);
    }
    const msg = await fetchMessage(ev.item.channel, ev.item.ts);
    if (!msg) return console.warn("[erro] não consegui ler a mensagem reagida");
    await processMessage({ ...msg, team: payload.team_id }, true);
    return;
  }

  if (ev.type !== "message") return;
  if (ev.subtype || ev.bot_id) return; // ignora edições, bots, joins etc.
  if (ev.user === MY_SLACK_USER_ID) return; // ignora suas próprias mensagens
  const text: string = ev.text ?? "";

  const isDm = ev.channel_type === "im" || ev.channel_type === "mpim";
  const isMention = !!MY_SLACK_USER_ID && text.includes(`<@${MY_SLACK_USER_ID}>`);
  const isWatched = WATCH_CHANNEL_IDS.includes(ev.channel);

  const relevant = (WATCH_DMS && isDm) || (WATCH_MENTIONS && isMention) || isWatched;
  if (!relevant) return console.log("[ignorado] não é DM/menção/canal monitorado");

  await processMessage({ channel: ev.channel, ts: ev.ts, user: ev.user, text, team: payload.team_id }, false);
}

// Filtro barato antes de gastar com o LLM
const TRIVIAL = /^(ok|okay|blz|beleza|valeu|vlw|obrigad[oa]|obg|show|top|bom dia|boa tarde|boa noite|oi|olá|ola|kkk+|haha+|👍|🙏|✅)[!. ]*$/i;
function isTrivial(text: string) {
  const t = text.replace(/<@[A-Z0-9]+>/g, "").trim();
  return t.length < 8 || TRIVIAL.test(t);
}

async function processMessage(msg: SlackMsg, forced: boolean) {
  if (!forced && isTrivial(msg.text)) return console.log("[ignorado] mensagem trivial");

  // Já existe? (retry do Slack, ou reação numa mensagem já importada)
  const { data: existing } = await supabase
    .from("tasks").select("id").eq("slack_channel_id", msg.channel).eq("slack_ts", msg.ts).maybeSingle();
  if (existing) return;

  const [authorName, permalink, corrections] = await Promise.all([
    msg.user ? getUserName(msg.user) : Promise.resolve(null),
    getPermalink(msg.channel, msg.ts),
    anthropic ? getRecentCorrections() : Promise.resolve(""),
  ]);

  const text = await resolveMentions(msg.text);
  const ruleOpts = {
    forced,
    authorIsVip: !!msg.user && VIP_USER_IDS.includes(msg.user),
    extraImportantKeywords: IMPORTANT_KEYWORDS,
  };
  // Com chave da Anthropic usa o Claude; sem chave (ou se a IA falhar) usa as regras
  const result = (anthropic && (await classify(text, authorName, forced, corrections))) || classifyWithRules(text, ruleOpts);
  if (!result.is_task && !forced) return console.log("[ignorado] regras/IA acharam que não é tarefa:", result.title);

  const effort = estimateEffort(text);
  const { error } = await supabase.from("tasks").insert({
    source: "slack",
    effort,
    suggested_ei_quadrant: suggestEiQuadrant(clamp(result.importance), effort),
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
    importance: clamp(result.importance),
    suggested_quadrant: result.suggested_quadrant,
    ai_reason: result.reason,
  });
  if (error && error.code !== "23505") console.error("insert failed", error); // 23505 = duplicata
  else console.log("[salvo]", result.suggested_quadrant, result.title);
}

const clamp = (n: number) => Math.min(5, Math.max(1, Math.round(n || 3)));

// ---------- IA (opcional) ----------
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_task", "title", "summary", "urgency", "importance", "suggested_quadrant", "reason", "due_date"],
  properties: {
    is_task: { type: "boolean", description: "A mensagem pede (explícita ou implicitamente) que EU faça, responda, revise, decida ou entregue algo?" },
    title: { type: "string", description: "Título curto e acionável, começando com verbo (máx. ~70 caracteres)." },
    summary: { type: "string", description: "1-2 frases com o contexto necessário para executar." },
    urgency: { type: "integer", description: "1 (sem pressa) a 5 (precisa ser hoje)." },
    importance: { type: "integer", description: "1 (irrelevante para meus objetivos) a 5 (crítico)." },
    suggested_quadrant: {
      type: "string",
      enum: ["q1", "q2", "q3", "q4"],
      description: "q1=urgente+importante (Fazer), q2=importante não urgente (Agendar), q3=urgente não importante (Delegar), q4=nem um nem outro (Eliminar).",
    },
    reason: { type: "string", description: "Justificativa curta (1 frase) para o quadrante sugerido." },
    due_date: { type: "string", description: "Prazo no formato AAAA-MM-DD se houver um prazo claro; senão string vazia." },
  },
} as const;

const SYSTEM_PROMPT = `Você é meu assistente de triagem. Recebe mensagens que chegaram para mim no Slack e decide se cada uma é um pedido de tarefa para mim. Se for, extrai a tarefa e sugere em qual quadrante da matriz de Eisenhower ela deveria ficar.

Quem eu sou e o que é importante para mim:
${USER_CONTEXT}

Critérios:
- É tarefa quando alguém espera uma ação minha: fazer, revisar, aprovar, responder com informação, decidir, comparecer, enviar algo. Perguntas que exigem pesquisa ou trabalho também contam.
- Não é tarefa: avisos puramente informativos, agradecimentos, conversa social, mensagens já resolvidas na própria frase.
- Urgência depende de prazo e de consequência de atraso. Importância depende do alinhamento com meus objetivos e do impacto.
- Seja calibrado: a maioria das coisas NÃO é Q1. Use o histórico de correções (quando houver) para entender como eu priorizo.
- Escreva título, resumo e justificativa em português.`;

async function classify(
  text: string,
  author: string | null,
  forced: boolean,
  corrections: string,
): Promise<Classification | null> {
  const today = new Date().toISOString().slice(0, 10);
  const userMsg = [
    corrections && `Exemplos recentes de como eu reclassifiquei sugestões suas:\n${corrections}`,
    `Data de hoje: ${today}`,
    forced ? "Eu marquei esta mensagem manualmente como tarefa; considere is_task = true." : "",
    `Autor: ${author ?? "desconhecido"}`,
    `Mensagem:\n"""\n${text}\n"""`,
  ].filter(Boolean).join("\n\n");

  if (!anthropic) return null;
  try {
    // Fallback no servidor só existe para Opus/Sonnet/Fable; o Haiku não tem
    const supportsFallback = !CLAUDE_MODEL.startsWith("claude-haiku");
    const response = await anthropic.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      ...(supportsFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      console.warn("classify stopped:", response.stop_reason);
      return null;
    }
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? (JSON.parse(block.text) as Classification) : null;
  } catch (e) {
    if (e instanceof Anthropic.APIError) console.error("Claude API error", e.status, e.message);
    else console.error("classify failed", e);
    return null;
  }
}

// Correções suas (quadrante final ≠ sugerido) viram exemplos para a IA aprender seu jeito
async function getRecentCorrections(): Promise<string> {
  const { data } = await supabase
    .from("tasks")
    .select("title, suggested_quadrant, quadrant")
    .not("quadrant", "is", null)
    .order("moved_at", { ascending: false })
    .limit(30);
  return (data ?? [])
    .filter((t) => t.quadrant !== t.suggested_quadrant)
    .slice(0, 10)
    .map((t) => `- "${t.title}": você sugeriu ${t.suggested_quadrant}, eu coloquei em ${t.quadrant}`)
    .join("\n");
}

// ---------- Slack Web API ----------
async function slack(method: string, params: Record<string, string>) {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${SLACK_USER_TOKEN}` },
  });
  const json = await res.json();
  if (!json.ok) console.warn(`slack ${method} failed:`, json.error);
  return json;
}

const userCache = new Map<string, string>();
async function getUserName(userId: string): Promise<string | null> {
  if (userCache.has(userId)) return userCache.get(userId)!;
  const r = await slack("users.info", { user: userId });
  const name = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || null;
  if (name) userCache.set(userId, name);
  return name;
}

async function getPermalink(channel: string, ts: string): Promise<string | null> {
  const r = await slack("chat.getPermalink", { channel, message_ts: ts });
  return r.permalink ?? null;
}

async function fetchMessage(channel: string, ts: string): Promise<SlackMsg | null> {
  // conversations.replies funciona tanto para mensagens normais quanto para respostas em thread
  const r = await slack("conversations.replies", { channel, ts, limit: "1", inclusive: "true" });
  const m = r.messages?.find((x: any) => x.ts === ts);
  return m ? { channel, ts, user: m.user, text: m.text ?? "" } : null;
}

async function resolveMentions(text: string): Promise<string> {
  const ids = [...new Set([...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]))];
  for (const id of ids) {
    const name = id === MY_SLACK_USER_ID ? "eu" : await getUserName(id);
    if (name) text = text.replaceAll(`<@${id}>`, `@${name}`);
  }
  return text;
}
