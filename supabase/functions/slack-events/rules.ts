// Classificação SEM IA: regras por palavras-chave, prazos e pessoas importantes.
// Arquivo puro (sem dependências), para poder testar localmente com Node.

export type Quadrant = "q1" | "q2" | "q3" | "q4";

export type Classification = {
  is_task: boolean;
  title: string;
  summary: string;
  urgency: number;
  importance: number;
  suggested_quadrant: Quadrant;
  reason: string;
  due_date: string; // AAAA-MM-DD ou ""
};

export type RuleOptions = {
  forced?: boolean; // marcado com 📌
  authorIsVip?: boolean; // autor está em VIP_USER_IDS
  extraImportantKeywords?: string[]; // IMPORTANT_KEYWORDS
  today?: Date; // para testes
  timeZone?: string;
};

// Remove acentos e padroniza para facilitar as buscas
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// ---------- Sinais de pedido ----------
const REQUEST_PATTERNS: [RegExp, string][] = [
  [/\b(voce|vc|tu)\s+(pode|poderia|consegue|conseguiria)\b/, "pedido direto"],
  [/\b(pode|poderia|consegue|conseguiria|consegues)\s+(?!ser\b|acontecer\b|dar errado\b)(me\s+|nos\s+)?\w+/, "pedido direto"],
  [/\b(tem como|teria como|seria possivel|daria pra)\b/, "pedido direto"],
  [/\b(preciso|precisamos|precisaria|precisariamos|necessito|necessitamos)\b/, "necessidade"],
  [/\b(por favor|por gentileza|pfv|pf|pls|please|favor)\b/, "por favor"],
  [/\b(me|nos)\s+(envia|manda|passa|ajuda|avisa|confirma|retorna|responde|explica|mostra|liga)\b/, "pedido direto"],
  [/\b(revisar|revisa|revise|aprovar|aprova|aprove|validar|valida|valide|verificar|verifica|verifique|checar|checa|cheque|analisar|analisa|analise|enviar|envie|mandar|mande|preencher|preenche|preencha|assinar|assina|assine|atualizar|atualiza|atualize|corrigir|corrige|corrija|responder|responda|agendar|agenda|marcar|marca|fazer|faca|organizar|preparar|prepara|prepare)\b/, "verbo de ação"],
  [/\b(da|de|dar) uma (olhada|olhadinha|conferida|revisada|checada)\b/, "pedido direto"],
  [/\b(fica com voce|fica contigo|com voce|sua responsabilidade|voce assume|contamos com voce)\b/, "atribuição"],
  [/\b(quando puder|assim que puder|quando der|o quanto antes|asap)\b/, "pedido direto"],
  [/\b(alguma novidade|algum retorno|como esta|como ta|status d[oa]|conseguiu)\b.*\?/, "cobrança"],
];

const NOT_TASK_PATTERNS = [
  /^(fyi|para conhecimento|so (pra|para) (avisar|informar)|apenas informando|informativo)/,
  /\b(nao precisa (fazer nada|responder|se preocupar)|nao precisa de nada|ja resolvi|ja resolvido|ja foi resolvido|deixa pra la|esquece)\b/,
];

// ---------- Urgência ----------
const URGENT_5 = /\b(urgente|urgencia|emergencia|asap|imediato|imediatamente|agora|o quanto antes|o mais rapido|mais rapido possivel|hoje|ainda hoje|ate o fim do dia|fim do dia|eod|critico|parado|fora do ar|caiu|travado|bloqueado|bloqueando)\b/;
const URGENT_4 = /\b(amanha|primeira hora|logo cedo|essa manha|esta manha|essa tarde|esta tarde|prazo|deadline|vence|vencendo|atrasad[oa]|cobrando)\b/;
const URGENT_3 = /\b(essa semana|esta semana|ate (segunda|terca|quarta|quinta|sexta)|nessa semana|nesta semana|proximos dias|breve)\b/;
const NOT_URGENT = /\b(sem pressa|quando puder|quando der|quando tiver (um )?tempo|sem urgencia|nao e urgente|nada urgente|com calma|proximo mes|mes que vem|futuramente|algum dia)\b/;

// ---------- Importância ----------
const IMPORTANT_DEFAULT = [
  "cliente", "clientes", "proposta", "contrato", "venda", "vendas", "receita", "faturamento", "pagamento",
  "nota fiscal", "orcamento", "diretoria", "diretor", "ceo", "socio", "socios", "board", "investidor",
  "apresentacao", "reuniao", "entrega", "lancamento", "producao", "bug", "erro", "incidente", "problema",
  "juridico", "contrato", "auditoria", "meta", "metas", "okr", "resultado", "relatorio", "estrategia",
  "planejamento", "contratacao", "feedback", "avaliacao", "aluno", "alunos", "turma", "curso",
];
// Incidentes: algo quebrado afetando pessoas é importante, não só urgente
const INCIDENT = /\b(caiu|fora do ar|parado|parou|travado|quebrado|quebrou|nao funciona|nao esta funcionando|bloqueado|bloqueando|critico|emergencia|incidente)\b/;
const LOW_IMPORTANCE =/\b(se tiver tempo|se der|se puder|curiosidade|opcional|nao e prioridade|baixa prioridade|irrelevante|so uma ideia|ideia solta|sugestao boba|happy hour|almoco|cafe|aniversario|bolao)\b/;

// ---------- Prazos ----------
const WEEKDAYS = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];

function ymdInTz(d: Date, timeZone: string) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return p; // AAAA-MM-DD
}
function addDays(ymd: string, n: number) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string) {
  return Math.round((new Date(b + "T12:00:00Z").getTime() - new Date(a + "T12:00:00Z").getTime()) / 86400000);
}

export function findDueDate(t: string, todayYmd: string): string {
  if (/\b(hoje|ainda hoje|fim do dia|eod)\b/.test(t)) return todayYmd;
  if (/\bdepois de amanha\b/.test(t)) return addDays(todayYmd, 2);
  if (/\bamanha\b/.test(t)) return addDays(todayYmd, 1);

  // dd/mm ou dd/mm/aaaa
  const m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const day = +m[1], month = +m[2];
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = m[3] ? +m[3] : +todayYmd.slice(0, 4);
      if (year < 100) year += 2000;
      let ymd = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (!m[3] && ymd < todayYmd) ymd = `${year + 1}${ymd.slice(4)}`; // data já passou → ano que vem
      return ymd;
    }
  }

  // "até sexta", "na segunda", "segunda-feira"
  const wd = t.match(/\b(ate|na|no|nessa|nesta|essa|esta|proxima|proximo|pra|para)?\s*(domingo|segunda|terca|quarta|quinta|sexta|sabado)(-feira)?\b/);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2]);
    const todayDow = new Date(todayYmd + "T12:00:00Z").getUTCDay();
    let diff = (target - todayDow + 7) % 7;
    if (diff === 0) diff = 7;
    return addDays(todayYmd, diff);
  }

  if (/\b(fim|final) da semana\b/.test(t)) {
    const todayDow = new Date(todayYmd + "T12:00:00Z").getUTCDay();
    return addDays(todayYmd, (5 - todayDow + 7) % 7);
  }
  return "";
}

// ---------- Título ----------
function makeTitle(raw: string) {
  let t = raw
    .replace(/<@[A-Z0-9]+>|@\S+/g, "") // menções
    .replace(/<(https?:[^|>]+)(\|[^>]+)?>/g, "") // links
    .replace(/:[a-z0-9_+-]+:/g, "") // emojis :x:
    .replace(/\s+/g, " ")
    .trim();
  // tira saudações do começo
  t = t.replace(/^(oi|ola|olá|opa|e ai|e aí|bom dia|boa tarde|boa noite|fala|hey|hello|hi)[,!.\s]+(\p{L}+[,!.]\s*)?/iu, "").trim();
  const first = t.split(/(?<=[.!?])\s+|\n/)[0] || t;
  const title = first.length > 90 ? first.slice(0, 87).trimEnd() + "…" : first;
  return title.charAt(0).toUpperCase() + title.slice(1) || "Tarefa do Slack";
}

// ---------- Esforço x Impacto ----------
export type EiQuadrant = "ei1" | "ei2" | "ei3" | "ei4";

const HIGH_EFFORT = /\b(projeto|estrutura|estruturar|reestrutur\w*|implementa\w*|implantar|implantacao|migrar|migracao|automacao|automatizar|integracao|integrar|documentacao|documentar|processo|processos|pesquisa|estudo|planejamento|planejar|estrategia|lancamento|campanha|curso completo|treinamento|novo site|nova pagina|sistema|ferramenta|dashboard|refazer|redesenh\w*|do zero)\b/;
const MID_EFFORT = /\b(copy|e-?mail|relatorio|apresentacao|pagina|planilha|reuniao|analise|analisar|levantamento|revisar|revisao|proposta|roteiro|aula|aulas)\b/;
const LOW_EFFORT = /\b(rapido|rapidinho|rapidinha|simples|so|apenas|pequeno|pequena|ajuste|ajustar|confirmar|confirma|responder|responde|enviar|envia|mandar|manda|passar|passa|aprovar|aprova|validar|valida|checar|checa|conferir|olhada|link|trocar|troca|duvida|pergunta|ok\??)\b/;

/** Esforço estimado 1-5 (texto curto e verbos simples = baixo; projetos = alto). */
export function estimateEffort(rawText: string): number {
  const t = norm(rawText);
  let effort = 3;
  if (HIGH_EFFORT.test(t)) effort = 4;
  else if (MID_EFFORT.test(t)) effort = 3;
  else if (LOW_EFFORT.test(t)) effort = 2;
  if (t.length > 600) effort += 1;
  return Math.max(1, Math.min(5, effort));
}

/** Impacto = importância. Alto impacto >= 3; alto esforço >= 4. */
export function suggestEiQuadrant(importance: number, effort: number): EiQuadrant {
  const highImpact = importance >= 3;
  const highEffort = effort >= 4;
  return highImpact ? (highEffort ? "ei2" : "ei1") : (highEffort ? "ei4" : "ei3");
}

// ---------- Principal ----------
export function classifyWithRules(rawText: string, opts: RuleOptions = {}): Classification {
  const t = norm(rawText);
  const timeZone = opts.timeZone ?? "America/Sao_Paulo";
  const todayYmd = ymdInTz(opts.today ?? new Date(), timeZone);
  const reasons: string[] = [];

  // É tarefa?
  const requestHits = REQUEST_PATTERNS.filter(([re]) => re.test(t)).map(([, why]) => why);
  const isQuestion = /\?/.test(t) && t.replace(/[^a-z]/g, "").length > 15;
  const explicitlyNot = NOT_TASK_PATTERNS.some((re) => re.test(t));
  const is_task = !!opts.forced || (!explicitlyNot && (requestHits.length > 0 || isQuestion));

  // Prazo
  const due_date = findDueDate(t, todayYmd);

  // Urgência (1-5)
  let urgency = 2;
  if (URGENT_5.test(t)) urgency = 5;
  else if (URGENT_4.test(t)) urgency = 4;
  else if (URGENT_3.test(t)) urgency = 3;
  if (due_date) {
    const d = daysBetween(todayYmd, due_date);
    const byDate = d <= 0 ? 5 : d === 1 ? 4 : d <= 3 ? 3 : 2;
    urgency = Math.max(urgency, byDate);
    reasons.push(d <= 0 ? "prazo hoje" : d === 1 ? "prazo amanhã" : `prazo em ${d} dias`);
  }
  if (NOT_URGENT.test(t)) {
    urgency = Math.min(urgency, 2);
    reasons.push("sem pressa");
  } else if (urgency === 5 && !due_date) reasons.push("marcado como urgente");

  // Importância (1-5)
  let importance = 2;
  const keywords = [...IMPORTANT_DEFAULT, ...(opts.extraImportantKeywords ?? []).map(norm)];
  const hits = [...new Set(keywords.filter((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)))];
  if (hits.length) {
    importance += Math.min(2, hits.length);
    reasons.push(`menciona ${hits.slice(0, 3).map((h) => `"${h}"`).join(", ")}`);
  }
  if (INCIDENT.test(t)) {
    importance += 2;
    reasons.push("algo quebrado/bloqueado");
  }
  if (opts.authorIsVip) {
    importance += 2;
    reasons.push("pedido de pessoa-chave");
  }
  if (LOW_IMPORTANCE.test(t)) {
    importance -= 1;
    reasons.push("parece opcional");
  }
  importance = Math.max(1, Math.min(5, importance));
  urgency = Math.max(1, Math.min(5, urgency));

  // Quadrante
  const urgent = urgency >= 4;
  const important = importance >= 3;
  const suggested_quadrant: Quadrant = urgent && important ? "q1" : important ? "q2" : urgent ? "q3" : "q4";

  const qName = { q1: "Fazer", q2: "Agendar", q3: "Delegar", q4: "Eliminar" }[suggested_quadrant];
  const reason = `${qName}: ${urgent ? "urgente" : "não urgente"} e ${important ? "importante" : "pouco importante"}` +
    (reasons.length ? ` (${reasons.join(" · ")})` : " (nenhum sinal forte encontrado)") + ". Sugestão por regras, sem IA.";

  return {
    is_task,
    title: makeTitle(rawText),
    summary: "",
    urgency,
    importance,
    suggested_quadrant,
    reason,
    due_date,
  };
}
