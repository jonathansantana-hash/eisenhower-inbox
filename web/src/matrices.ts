import type { IconName } from "./Icons";

export type MatrixId = "eisenhower" | "effort";
export type QuadrantId = "q1" | "q2" | "q3" | "q4" | "ei1" | "ei2" | "ei3" | "ei4";

export type QuadrantDef = {
  id: QuadrantId;
  title: string;
  subtitle: string;
  hint: string;
  icon: IconName;
  theme: string; // classe CSS de cor
};

export type MatrixDef = {
  id: MatrixId;
  tab: string;
  title: string;
  subtitle: string;
  quote: string;
  quoteAuthor?: string;
  slogan: string[];
  field: "quadrant" | "ei_quadrant";
  suggestedField: "suggested_quadrant" | "suggested_ei_quadrant";
  movedField: "moved_at" | "ei_moved_at";
  // ordem visual: [topo-esq, topo-dir, baixo-esq, baixo-dir]
  grid: [QuadrantDef, QuadrantDef, QuadrantDef, QuadrantDef];
  // ordem no celular (prioridade)
  mobileOrder: QuadrantId[];
  yAxis: { label: string; high: string; highHint: string; low: string; lowHint: string };
  xAxis: { label: string; low: string; lowHint: string; high: string; highHint: string };
  tips: { icon: IconName; text: string }[];
  closing: string;
};

export const MATRICES: Record<MatrixId, MatrixDef> = {
  eisenhower: {
    id: "eisenhower",
    tab: "Matriz de Eisenhower",
    title: "Matriz de Eisenhower",
    subtitle: "Organize suas tarefas. Priorize o que realmente importa.",
    quote: "“O que é importante raramente é urgente, e o que é urgente raramente é importante.”",
    quoteAuthor: "Dwight D. Eisenhower",
    slogan: ["Mais foco.", "Melhores decisões.", "Maiores resultados."],
    field: "quadrant",
    suggestedField: "suggested_quadrant",
    movedField: "moved_at",
    grid: [
      { id: "q3", title: "Delegar", subtitle: "Não Importante e Urgente", hint: "Distribua tarefas e libere seu tempo.", icon: "users", theme: "t-orange" },
      { id: "q1", title: "Fazer agora", subtitle: "Importante e Urgente", hint: "Alta prioridade. Faça imediatamente.", icon: "bolt", theme: "t-red" },
      { id: "q4", title: "Eliminar / Adiar", subtitle: "Não Importante e Não Urgente", hint: "Evite distrações. Elimine ou deixe para depois.", icon: "trash", theme: "t-slate" },
      { id: "q2", title: "Planejar", subtitle: "Importante e Não Urgente", hint: "Gera crescimento. Programe no seu cronograma.", icon: "calendar", theme: "t-green" },
    ],
    mobileOrder: ["q1", "q2", "q3", "q4"],
    yAxis: { label: "Urgência", high: "Alta", highHint: "(precisa ser feito agora)", low: "Baixa", lowHint: "(pode esperar)" },
    xAxis: { label: "Importância", low: "Baixa", lowHint: "(menos impacto)", high: "Alta", highHint: "(maior impacto)" },
    tips: [
      { icon: "list", text: "Liste todas as suas tarefas." },
      { icon: "search", text: "Analise a urgência e a importância de cada uma." },
      { icon: "target", text: "Faça primeiro o que é importante e urgente." },
      { icon: "users", text: "Delegue o que for possível." },
      { icon: "calendar", text: "Programe um tempo para as tarefas importantes e não urgentes." },
      { icon: "trash", text: "Elimine o que não gera valor." },
    ],
    closing: "Disciplina hoje, resultados amanhã!",
  },
  effort: {
    id: "effort",
    tab: "Esforço x Impacto",
    title: "Matriz Esforço x Impacto",
    subtitle: "Priorize seu tempo nas atividades que geram mais resultado.",
    quote: "Nem tudo que demanda tempo traz resultado. O foco é investir energia no que realmente importa.",
    slogan: ["Mais foco.", "Mais resultados."],
    field: "ei_quadrant",
    suggestedField: "suggested_ei_quadrant",
    movedField: "ei_moved_at",
    grid: [
      { id: "ei1", title: "Ganhos rápidos", subtitle: "Alto impacto, baixo esforço", hint: "Faça primeiro. Resultado relevante com agilidade.", icon: "trophy", theme: "t-green" },
      { id: "ei2", title: "Grandes projetos", subtitle: "Alto impacto, alto esforço", hint: "Planeje e estruture. Importantes para o futuro.", icon: "chart", theme: "t-blue" },
      { id: "ei3", title: "Tarefas menores", subtitle: "Baixo impacto, baixo esforço", hint: "Faça quando sobrar tempo.", icon: "doc", theme: "t-amber" },
      { id: "ei4", title: "Evitar agora", subtitle: "Baixo impacto, alto esforço", hint: "Não priorize. Muito esforço, pouco retorno.", icon: "ban", theme: "t-red" },
    ],
    mobileOrder: ["ei1", "ei2", "ei3", "ei4"],
    yAxis: { label: "Impacto / Resultado", high: "Alto", highHint: "(maior resultado)", low: "Baixo", lowHint: "(menor resultado)" },
    xAxis: { label: "Esforço", low: "Baixo", lowHint: "(menos tempo e recursos)", high: "Alto", highHint: "(mais tempo e recursos)" },
    tips: [
      { icon: "target", text: "Priorize o que gera resultado." },
      { icon: "search", text: "Questione o esforço de cada atividade." },
      { icon: "trophy", text: "Comece pelos ganhos rápidos." },
      { icon: "chart", text: "Quebre grandes projetos em etapas." },
      { icon: "ban", text: "Adie ou elimine o que não é essencial." },
    ],
    closing: "Onde devo investir minha energia agora?",
  },
};

export const QUADRANT_LABEL: Record<QuadrantId, string> = {
  q1: "Fazer agora", q2: "Planejar", q3: "Delegar", q4: "Eliminar / Adiar",
  ei1: "Ganhos rápidos", ei2: "Grandes projetos", ei3: "Tarefas menores", ei4: "Evitar agora",
};
