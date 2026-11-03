import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  supabase,
  FUNCTIONS_URL,
  DEFAULT_SETTINGS,
  type SlackConnection,
  type Task,
  type UserSettings,
} from "./supabase";
import { MATRICES, QUADRANT_LABEL, type MatrixDef, type MatrixId, type QuadrantDef, type QuadrantId } from "./matrices";
import { Icon } from "./Icons";

const INBOX = "inbox";

// ======================================================================
// App / Login
// ======================================================================
export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  // Modo demonstração (só em desenvolvimento): http://localhost:5173/?demo
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("demo")) {
    return <Board email="demo" demo={DEMO_TASKS} />;
  }
  if (!ready) return null;
  return session ? <Board email={session.user.email ?? ""} /> : <Login />;
}

const siteUrl = () => window.location.origin + window.location.pathname;

// Erros que o Supabase devolve na URL depois do login (ex.: domínio bloqueado)
function authErrorFromUrl(): string {
  const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
  const desc = params.get("error_description");
  if (!desc) return "";
  if (/database error|acesso restrito/i.test(desc)) return "Acesso restrito a contas @hashtagtreinamentos.com.";
  return desc.replace(/\+/g, " ");
}

function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [error, setError] = useState(authErrorFromUrl);

  async function slackLogin() {
    setError("");
    const { error } = await supabase.auth.signInWithOAuth({ provider: "slack_oidc", options: { redirectTo: siteUrl() } });
    if (error) setError(error.message);
  }

  async function emailLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: siteUrl(), shouldCreateUser: false },
    });
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <main className="login">
      <h1>Prioridades</h1>
      <p className="muted">Transforme pedidos do Slack em tarefas priorizadas.</p>

      <button className="btn slack-btn" onClick={slackLogin}>
        <Icon name="slack" size={18} /> Entrar com Slack
      </button>
      <p className="login-note">Use sua conta da Hashtag Treinamentos.</p>

      {error && <p className="error">{error}</p>}

      {!showEmail ? (
        <button className="link login-alt" onClick={() => setShowEmail(true)}>Entrar com e-mail</button>
      ) : sent ? (
        <p>Enviamos um link de acesso para <b>{email}</b>.</p>
      ) : (
        <form onSubmit={emailLogin}>
          <input type="email" required placeholder="seu@hashtagtreinamentos.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit" className="btn">Enviar link de acesso</button>
        </form>
      )}
    </main>
  );
}

// ======================================================================
// Board
// ======================================================================
type NewTaskDraft = { quadrant?: QuadrantId | null };
type Toast = { id: number; text: string; undo?: () => void; error?: boolean };

const SLACK_RESULT: Record<string, { text: string; error?: boolean }> = {
  ok: { text: "Slack conectado! Novos pedidos vão aparecer em Novas." },
  cancelado: { text: "Conexão com o Slack cancelada.", error: true },
  expirado: { text: "O link expirou. Tente conectar de novo.", error: true },
  "em-uso": { text: "Esse usuário do Slack já está ligado a outra conta.", error: true },
  erro: { text: "Não foi possível conectar o Slack. Tente de novo.", error: true },
};
type QuickInput = { title: string; summary: string; due_date: string };
const TOAST_MS = 10_000;

function Board({ email, demo }: { email: string; demo?: Task[] }) {
  const [tasks, setTasks] = useState<Task[]>(demo ?? []);
  const [matrixId, setMatrixId] = useState<MatrixId>(() => {
    const fromUrl = new URLSearchParams(location.search).get("m");
    if (fromUrl === "effort" || fromUrl === "eisenhower") return fromUrl;
    try {
      return (localStorage.getItem("matrix") as MatrixId) || "eisenhower";
    } catch {
      return "eisenhower";
    }
  });
  const [showDone, setShowDone] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<NewTaskDraft | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [error, setError] = useState("");
  const [slackConn, setSlackConn] = useState<SlackConnection | null | undefined>(demo ? null : undefined);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // Conexão com o Slack + preferências
  useEffect(() => {
    if (demo) return;
    supabase.rpc("my_slack_connection").then(({ data }) => setSlackConn((data as SlackConnection[] | null)?.[0] ?? null));
    supabase
      .from("user_settings")
      .select("watch_dms, watch_mentions, watch_channel_ids, vip_user_ids, important_keywords")
      .maybeSingle()
      .then(({ data }) => data && setSettings(data as UserSettings));

    // Volta do Slack: ?slack=ok|erro|…
    const params = new URLSearchParams(location.search);
    const r = params.get("slack");
    if (r) {
      const msg = SLACK_RESULT[r] ?? SLACK_RESULT.erro;
      pushToast(msg);
      params.delete("slack");
      const qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  async function connectSlack() {
    setConnecting(true);
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetch(`${FUNCTIONS_URL}/connect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` },
      });
      const body = await res.json();
      if (!res.ok || !body.url) throw new Error(body.error || "Falha ao iniciar a conexão");
      window.location.href = body.url;
    } catch (e) {
      setConnecting(false);
      pushToast({ text: (e as Error).message, error: true });
    }
  }

  async function disconnectSlack() {
    if (!confirm("Desconectar o Slack? Novas mensagens deixarão de virar tarefas.")) return;
    const { error } = await supabase.rpc("disconnect_slack");
    if (error) return setError(error.message);
    setSlackConn(null);
  }

  async function saveSettings(s: UserSettings) {
    setSettings(s);
    if (demo) return true;
    const { error } = await supabase.from("user_settings").upsert({ ...s, updated_at: new Date().toISOString() });
    if (error) {
      setError(error.message);
      return false;
    }
    pushToast({ text: "Configurações salvas" });
    return true;
  }

  const matrix = MATRICES[matrixId];

  useEffect(() => {
    try {
      localStorage.setItem("matrix", matrixId);
    } catch {
      /* ignore */
    }
  }, [matrixId]);

  function pushToast(t: Omit<Toast, "id">) {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { ...t, id }]); // no máximo 3 na tela
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), TOAST_MS);
  }
  const closeToast = (id: number) => setToasts((prev) => prev.filter((x) => x.id !== id));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  // Carrega + realtime
  useEffect(() => {
    if (demo) return;
    supabase
      .from("tasks")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1000)
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setTasks(data as Task[]);
      });

    const channel = supabase
      .channel("tasks-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, (p) => {
        setTasks((prev) => {
          if (p.eventType === "DELETE") return prev.filter((t) => t.id !== (p.old as Task).id);
          return upsert(prev, p.new as Task);
        });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [demo]);

  const visible = useMemo(() => tasks.filter((t) => showDone || !t.done), [tasks, showDone]);
  const doneCount = tasks.filter((t) => t.done).length;
  const inbox = visible.filter((t) => !t[matrix.field]);
  const byQuadrant = (q: QuadrantId) =>
    visible
      .filter((t) => t[matrix.field] === q)
      .sort((a, b) => Number(a.done) - Number(b.done) || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));

  const active = tasks.find((t) => t.id === activeId) ?? null;
  const opened = tasks.find((t) => t.id === openId) ?? null;

  // ---------- Ações ----------
  async function patch(id: string, changes: Partial<Task>) {
    const before = tasks;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...changes } : t)));
    if (demo) return;
    const { error } = await supabase.from("tasks").update(changes).eq("id", id);
    if (error) {
      setTasks(before);
      setError(error.message);
    }
  }

  function toggleDone(t: Task) {
    const done = !t.done;
    patch(t.id, { done });
    if (done) pushToast({ text: `Concluída: ${t.title}`, undo: () => patch(t.id, { done: false }) });
  }

  async function remove(t: Task) {
    if (!confirm(`Descartar “${short(t.title)}”?`)) return;
    setOpenId(null);
    setTasks((prev) => prev.filter((x) => x.id !== t.id));
    if (demo) return;
    const { error } = await supabase.from("tasks").delete().eq("id", t.id);
    if (error) setError(error.message);
  }

  function move(id: string, m: MatrixDef, to: QuadrantId | typeof INBOX) {
    const value = to === INBOX ? null : to;
    const task = tasks.find((t) => t.id === id);
    if (!task || task[m.field] === value) return;
    patch(id, { [m.field]: value, [m.movedField]: new Date().toISOString() } as Partial<Task>);
  }

  async function create(input: { title: string; summary: string; due_date: string; quadrant: string; ei_quadrant: string }) {
    const now = new Date().toISOString();
    const row = {
      source: "manual" as const,
      title: input.title.trim(),
      summary: input.summary.trim() || null,
      due_date: input.due_date || null,
      quadrant: input.quadrant || null,
      ei_quadrant: input.ei_quadrant || null,
      moved_at: input.quadrant ? now : null,
      ei_moved_at: input.ei_quadrant ? now : null,
    };
    if (demo) {
      setTasks((prev) => upsert(prev, { ...EMPTY_TASK, ...row, id: crypto.randomUUID(), created_at: now } as Task));
      return true;
    }
    const { data, error } = await supabase.from("tasks").insert(row).select().single();
    if (error) {
      setError(error.message);
      return false;
    }
    setTasks((prev) => upsert(prev, data as Task));
    return true;
  }

  function quickAdd(input: QuickInput, q: QuadrantId | null) {
    return create({
      ...input,
      quadrant: q && matrix.field === "quadrant" ? q : "",
      ei_quadrant: q && matrix.field === "ei_quadrant" ? q : "",
    });
  }

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }
  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    if (e.over) move(String(e.active.id), matrix, e.over.id as QuadrantId);
  }

  return (
    <div className="page">
      {/* ---------- Cabeçalho ---------- */}
      <header className="top">
        <div className="brand">
          <h1>{matrix.title}</h1>
          <p>{matrix.subtitle}</p>
        </div>
        <div className="top-actions">
          <div className="tabs" role="tablist">
            {Object.values(MATRICES).map((m) => (
              <button
                key={m.id}
                role="tab"
                aria-selected={m.id === matrixId}
                className={`tab ${m.id === matrixId ? "on" : ""}`}
                onClick={() => setMatrixId(m.id)}
              >
                {m.tab}
              </button>
            ))}
          </div>
          <button className="btn primary" onClick={() => setCreating({})}>
            <Icon name="plus" size={16} /> Nova tarefa
          </button>
          <button className="icon-btn" title="Configurações" aria-label="Configurações" onClick={() => setSettingsOpen(true)}>
            <Icon name="gear" size={16} />
          </button>
          <button className="icon-btn" title={`Sair (${email})`} aria-label="Sair" onClick={() => supabase.auth.signOut()}>
            <Icon name="logout" size={16} />
          </button>
        </div>
      </header>

      {error && (
        <p className="error" onClick={() => setError("")}>
          {error} <small>(clique para fechar)</small>
        </p>
      )}

      {/* ---------- Matriz ---------- */}
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
        <div className="layout">
          <div className="y-axis" aria-hidden="true">
            <small>{matrix.yAxis.high}</small>
            <span>{matrix.yAxis.label} ↑</span>
            <small>{matrix.yAxis.low}</small>
          </div>

          <div className="matrix">
            {matrix.grid.map((q) => (
              <Quadrant
                key={q.id}
                def={q}
                order={matrix.mobileOrder.indexOf(q.id)}
                tasks={byQuadrant(q.id)}
                onOpen={setOpenId}
                onToggleDone={toggleDone}
                onQuickAdd={quickAdd}
              />
            ))}
          </div>

          <div className="x-axis" aria-hidden="true">
            <small>{matrix.xAxis.low}</small>
            <span>{matrix.xAxis.label} →</span>
            <small>{matrix.xAxis.high}</small>
          </div>

          <aside className="side">
            {slackConn === null && !demo && (
              <section className="connect-card">
                <Icon name="slack" size={20} />
                <div>
                  <b>Conecte seu Slack</b>
                  <p>Pedidos que chegarem por DM ou menção viram tarefas aqui automaticamente.</p>
                  <button className="btn primary sm" onClick={connectSlack} disabled={connecting}>
                    {connecting ? "Abrindo o Slack…" : "Conectar Slack"}
                  </button>
                </div>
              </section>
            )}
            <Inbox
              tasks={inbox}
              matrix={matrix}
              onOpen={setOpenId}
              onAccept={(t) => {
                const s = t[matrix.suggestedField];
                if (s) move(t.id, matrix, s);
              }}
              onToggleDone={toggleDone}
              onQuickAdd={quickAdd}
            />

            <label className="toggle">
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
              Mostrar concluídas {doneCount > 0 && <span className="muted">({doneCount})</span>}
            </label>

            <details className="tips">
              <summary>Dicas para aplicar a matriz</summary>
              <ul>
                {matrix.tips.map((tip) => (
                  <li key={tip.text}>
                    <Icon name={tip.icon} size={16} />
                    <span>{tip.text}</span>
                  </li>
                ))}
              </ul>
              {matrix.quote && (
                <p className="tips-quote">
                  {matrix.quote}
                  {matrix.quoteAuthor && <> — {matrix.quoteAuthor}</>}
                </p>
              )}
            </details>
          </aside>
        </div>

        <DragOverlay>{active && <TaskRow task={active} overlay />}</DragOverlay>
      </DndContext>

      {opened && (
        <TaskModal
          task={opened}
          onClose={() => setOpenId(null)}
          onPatch={(c) => patch(opened.id, c)}
          onMove={(m, q) => move(opened.id, m, q)}
          onToggleDone={() => {
            toggleDone(opened);
            setOpenId(null);
          }}
          onRemove={() => remove(opened)}
        />
      )}
      {creating && (
        <NewTaskModal
          defaultQuadrant={creating.quadrant ?? null}
          matrix={matrix}
          onClose={() => setCreating(null)}
          onCreate={async (v) => {
            if (await create(v)) setCreating(null);
          }}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          email={email}
          settings={settings}
          slackConn={slackConn}
          connecting={connecting}
          onConnect={connectSlack}
          onDisconnect={disconnectSlack}
          onSave={async (s) => {
            if (await saveSettings(s)) setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? "err" : ""}`} style={{ "--ms": `${TOAST_MS}ms` } as React.CSSProperties}>
            <Icon name={t.error ? "x" : "check"} size={14} className="toast-icon" />
            <span>{t.text}</span>
            {t.undo && (
              <button
                onClick={() => {
                  t.undo!();
                  closeToast(t.id);
                }}
              >
                Desfazer
              </button>
            )}
            <button className="toast-x" aria-label="Fechar" onClick={() => closeToast(t.id)}>
              <Icon name="x" size={12} />
            </button>
            <span className="toast-bar" />
          </div>
        ))}
      </div>
    </div>
  );
}

function upsert(list: Task[], row: Task) {
  const rest = list.filter((t) => t.id !== row.id);
  return [row, ...rest].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ======================================================================
// Quadrante
// ======================================================================
function Quadrant({
  def,
  order,
  tasks,
  onOpen,
  onToggleDone,
  onQuickAdd,
}: {
  def: QuadrantDef;
  order: number;
  tasks: Task[];
  onOpen: (id: string) => void;
  onToggleDone: (t: Task) => void;
  onQuickAdd: (input: QuickInput, q: QuadrantId | null) => Promise<boolean>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: def.id });
  const [adding, setAdding] = useState(false);

  return (
    <section
      ref={setNodeRef}
      className={`quadrant ${def.theme} ${isOver ? "over" : ""}`}
      style={{ "--order": order } as React.CSSProperties}
    >
      <header className="q-head" title={def.hint}>
        <span className="q-icon">
          <Icon name={def.icon} size={18} />
        </span>
        <div className="q-titles">
          <h2>{def.title}</h2>
          <p>{def.subtitle}</p>
        </div>
        {tasks.length > 0 && <span className="q-count">{tasks.length}</span>}
      </header>

      <ul className="q-list">
        {tasks.map((t) => (
          <DraggableRow key={t.id} task={t} onOpen={onOpen} onToggleDone={onToggleDone} />
        ))}
      </ul>
      {tasks.length === 0 && !adding && <p className="q-empty">{def.hint}</p>}

      <QuickAdd open={adding} setOpen={setAdding} onSubmit={(v) => onQuickAdd(v, def.id)} />
    </section>
  );
}

// Campo de adicionar rápido: título + descrição discreta + Hoje/calendário
function QuickAdd({
  open,
  setOpen,
  onSubmit,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  onSubmit: (v: QuickInput) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  function reset() {
    setTitle("");
    setSummary("");
    setDue("");
  }
  function cancel() {
    reset();
    setOpen(false);
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    const ok = await onSubmit({ title, summary, due_date: due });
    setSaving(false);
    if (ok) {
      reset();
      titleRef.current?.focus(); // continua aberto para a próxima
    }
  }

  function openPicker() {
    const el = dateRef.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
      el.click();
    }
  }

  if (!open) {
    return (
      <button className="add-link" onClick={() => setOpen(true)}>
        <Icon name="plus" size={14} /> Adicionar
      </button>
    );
  }

  const today = todayYmd();
  return (
    <form
      className="quick-add"
      onSubmit={submit}
      onKeyDown={(e) => e.key === "Escape" && cancel()}
      onBlur={(e) => {
        // fecha só se o foco saiu do formulário inteiro e está vazio
        if (!e.currentTarget.contains(e.relatedTarget as Node) && !title.trim() && !summary.trim()) cancel();
      }}
    >
      <div className="qa-main">
        <input
          ref={titleRef}
          className="qa-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Nova tarefa"
          aria-label="Nome da tarefa"
        />
        <div className="qa-date">
          {due ? (
            <span className={`due ${dueInfo(due).cls}`}>
              {dueInfo(due).label}
              <button type="button" aria-label="Remover data" onClick={() => setDue("")}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ) : (
            <button type="button" className="chip" onClick={() => setDue(today)}>Hoje</button>
          )}
          <button type="button" className="chip icon" title="Escolher data" aria-label="Escolher data" onClick={openPicker}>
            <Icon name="calendar" size={14} />
          </button>
          <input
            ref={dateRef}
            type="date"
            className="qa-picker"
            tabIndex={-1}
            aria-hidden="true"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>
      </div>
      <input
        className="qa-desc"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="Descrição"
        aria-label="Descrição"
      />
      <div className="qa-actions">
        <small>Enter para salvar · Esc para cancelar</small>
        <button type="submit" className="btn primary sm" disabled={!title.trim() || saving}>
          Salvar
        </button>
      </div>
    </form>
  );
}

function DraggableRow({ task, onOpen, onToggleDone }: { task: Task; onOpen: (id: string) => void; onToggleDone: (t: Task) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <li ref={setNodeRef} {...listeners} {...attributes} style={{ opacity: isDragging ? 0.3 : 1 }} onClick={() => onOpen(task.id)}>
      <TaskRow task={task} onToggleDone={onToggleDone} />
    </li>
  );
}

function CheckCircle({ task, onToggle }: { task: Task; onToggle?: (t: Task) => void }) {
  return (
    <button
      type="button"
      className={`check ${task.done ? "on" : ""}`}
      aria-label={task.done ? "Reabrir tarefa" : "Marcar como concluída"}
      title={task.done ? "Reabrir" : "Concluir"}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.(task);
      }}
    >
      <Icon name="check" size={11} />
    </button>
  );
}

function TaskRow({ task, overlay, onToggleDone }: { task: Task; overlay?: boolean; onToggleDone?: (t: Task) => void }) {
  const due = task.due_date ? dueInfo(task.due_date) : null;
  return (
    <div className={`row ${task.done ? "done" : ""} ${overlay ? "overlay" : ""}`}>
      <CheckCircle task={task} onToggle={onToggleDone} />
      <div className="row-text">
        <span className="row-title">{task.title}</span>
        {(task.slack_user_name || task.summary) && (
          <small>{[task.slack_user_name, task.summary].filter(Boolean).join(" · ")}</small>
        )}
      </div>
      {due && <span className={`due ${due.cls}`}>{due.label}</span>}
      {task.source === "slack" && <Icon name="slack" size={12} className="src" />}
    </div>
  );
}

// ======================================================================
// Caixa de entrada (Novas)
// ======================================================================
function Inbox({
  tasks,
  matrix,
  onOpen,
  onAccept,
  onToggleDone,
  onQuickAdd,
}: {
  tasks: Task[];
  matrix: MatrixDef;
  onOpen: (id: string) => void;
  onAccept: (t: Task) => void;
  onToggleDone: (t: Task) => void;
  onQuickAdd: (input: QuickInput, q: QuadrantId | null) => Promise<boolean>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: INBOX });
  const [adding, setAdding] = useState(false);
  return (
    <section ref={setNodeRef} className={`inbox ${isOver ? "over" : ""}`}>
      <header>
        <h3>Novas</h3>
        {tasks.length > 0 && <span className="badge">{tasks.length}</span>}
      </header>
      {tasks.length === 0 && !adding ? (
        <p className="inbox-empty">Nada para triar.</p>
      ) : (
        <ul>
          {tasks.map((t) => (
            <InboxCard key={t.id} task={t} matrix={matrix} onOpen={onOpen} onAccept={onAccept} onToggleDone={onToggleDone} />
          ))}
        </ul>
      )}
      <QuickAdd open={adding} setOpen={setAdding} onSubmit={(v) => onQuickAdd(v, null)} />
    </section>
  );
}

function InboxCard({
  task,
  matrix,
  onOpen,
  onAccept,
  onToggleDone,
}: {
  task: Task;
  matrix: MatrixDef;
  onOpen: (id: string) => void;
  onAccept: (t: Task) => void;
  onToggleDone: (t: Task) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  const s = task[matrix.suggestedField];
  const theme = s ? matrix.grid.find((q) => q.id === s)?.theme : "";
  return (
    <li ref={setNodeRef} {...listeners} {...attributes} className="inbox-card" style={{ opacity: isDragging ? 0.3 : 1 }} onClick={() => onOpen(task.id)}>
      <div className="inbox-top">
        <CheckCircle task={task} onToggle={onToggleDone} />
        <div className="row-text">
          <span className="row-title">{task.title}</span>
          <small>
            {task.source === "slack" ? task.slack_user_name ?? "Slack" : "Manual"} · {timeAgo(task.created_at)}
            {task.due_date && ` · ${dueInfo(task.due_date).label}`}
          </small>
        </div>
      </div>
      {s && (
        <div className={`suggest ${theme}`} onPointerDown={(e) => e.stopPropagation()}>
          <span>
            <span className="dot" /> {QUADRANT_LABEL[s]}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAccept(task);
            }}
          >
            Aceitar
          </button>
        </div>
      )}
    </li>
  );
}

// ======================================================================
// Modais
// ======================================================================
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h3>{title}</h3>
          <button className="icon-btn ghost" onClick={onClose} aria-label="Fechar">
            <Icon name="x" size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function QuadrantSelect({ matrix, value, onChange, emptyLabel }: { matrix: MatrixDef; value: string; onChange: (v: string) => void; emptyLabel: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {matrix.mobileOrder.map((q) => (
        <option key={q} value={q}>{QUADRANT_LABEL[q]}</option>
      ))}
    </select>
  );
}

function NewTaskModal({
  defaultQuadrant,
  matrix,
  onClose,
  onCreate,
}: {
  defaultQuadrant: QuadrantId | null;
  matrix: MatrixDef;
  onClose: () => void;
  onCreate: (v: { title: string; summary: string; due_date: string; quadrant: string; ei_quadrant: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [due, setDue] = useState("");
  const [q, setQ] = useState(matrix.field === "quadrant" ? defaultQuadrant ?? "" : "");
  const [ei, setEi] = useState(matrix.field === "ei_quadrant" ? defaultQuadrant ?? "" : "");
  const [saving, setSaving] = useState(false);

  return (
    <Modal title="Nova tarefa" onClose={onClose}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          setSaving(true);
          await onCreate({ title, summary, due_date: due, quadrant: q, ei_quadrant: ei });
          setSaving(false);
        }}
      >
        <label>
          Tarefa
          <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Revisar proposta do cliente X" />
        </label>
        <label>
          Detalhes <span className="opt">opcional</span>
          <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Contexto, links, quem pediu…" />
        </label>
        <label>
          Prazo <span className="opt">opcional</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <div className="form-row">
          <label>
            Eisenhower
            <QuadrantSelect matrix={MATRICES.eisenhower} value={q} onChange={setQ} emptyLabel="Deixar em Novas" />
          </label>
          <label>
            Esforço x Impacto
            <QuadrantSelect matrix={MATRICES.effort} value={ei} onChange={setEi} emptyLabel="Deixar em Novas" />
          </label>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn primary" disabled={saving}>{saving ? "Salvando…" : "Adicionar tarefa"}</button>
        </div>
      </form>
    </Modal>
  );
}

function TaskModal({
  task,
  onClose,
  onPatch,
  onMove,
  onToggleDone,
  onRemove,
}: {
  task: Task;
  onClose: () => void;
  onPatch: (c: Partial<Task>) => void;
  onMove: (m: MatrixDef, q: QuadrantId | typeof INBOX) => void;
  onToggleDone: () => void;
  onRemove: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [summary, setSummary] = useState(task.summary ?? "");
  const [due, setDue] = useState(task.due_date ?? "");

  function save() {
    const c: Partial<Task> = {};
    if (title.trim() && title.trim() !== task.title) c.title = title.trim();
    if ((summary.trim() || null) !== task.summary) c.summary = summary.trim() || null;
    if ((due || null) !== task.due_date) c.due_date = due || null;
    if (Object.keys(c).length) onPatch(c);
  }

  return (
    <Modal
      title={task.source === "slack" ? "Tarefa do Slack" : "Tarefa"}
      onClose={() => {
        save();
        onClose();
      }}
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
          onClose();
        }}
      >
        {task.done && <p className="done-banner"><Icon name="check" size={14} /> Esta tarefa está concluída.</p>}
        <label>
          Tarefa
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Detalhes <span className="opt">opcional</span>
          <textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </label>
        <label>
          Prazo <span className="opt">opcional</span>
          <div className="date-row">
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            {due && (
              <button type="button" className="link" onClick={() => setDue("")}>Remover prazo</button>
            )}
          </div>
        </label>

        <div className="form-row">
          <label>
            Eisenhower
            <QuadrantSelect matrix={MATRICES.eisenhower} value={task.quadrant ?? ""} onChange={(v) => onMove(MATRICES.eisenhower, (v || INBOX) as QuadrantId)} emptyLabel="Novas (não triada)" />
            {task.suggested_quadrant && <small className="hint">Sugestão: {QUADRANT_LABEL[task.suggested_quadrant]}</small>}
          </label>
          <label>
            Esforço x Impacto
            <QuadrantSelect matrix={MATRICES.effort} value={task.ei_quadrant ?? ""} onChange={(v) => onMove(MATRICES.effort, (v || INBOX) as QuadrantId)} emptyLabel="Novas (não triada)" />
            {task.suggested_ei_quadrant && <small className="hint">Sugestão: {QUADRANT_LABEL[task.suggested_ei_quadrant]}</small>}
          </label>
        </div>

        {(task.ai_reason || task.raw_text) && (
          <details className="origin">
            <summary>
              {task.source === "slack" ? `Mensagem original${task.slack_user_name ? ` de ${task.slack_user_name}` : ""}` : "Origem"}
            </summary>
            {task.raw_text && <blockquote className="raw">{task.raw_text}</blockquote>}
            {task.ai_reason && <p className="hint">{task.ai_reason}</p>}
            {task.permalink && (
              <a href={task.permalink} target="_blank" rel="noreferrer" className="link">
                <Icon name="slack" size={12} /> Abrir no Slack
              </a>
            )}
          </details>
        )}

        <div className="form-actions spread">
          <div className="left">
            <button type="button" className="btn" onClick={onToggleDone}>
              <Icon name="check" size={14} /> {task.done ? "Reabrir" : "Marcar como concluída"}
            </button>
            <button type="button" className="link danger" onClick={onRemove}>Descartar</button>
          </div>
          <button type="submit" className="btn primary">Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

// ======================================================================
// Configurações
// ======================================================================
const toList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

function SettingsModal({
  email,
  settings,
  slackConn,
  connecting,
  onConnect,
  onDisconnect,
  onSave,
  onClose,
}: {
  email: string;
  settings: UserSettings;
  slackConn: SlackConnection | null | undefined;
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSave: (s: UserSettings) => void;
  onClose: () => void;
}) {
  const [dms, setDms] = useState(settings.watch_dms);
  const [mentions, setMentions] = useState(settings.watch_mentions);
  const [vips, setVips] = useState(settings.vip_user_ids.join(", "));
  const [keywords, setKeywords] = useState(settings.important_keywords.join(", "));
  const [channels, setChannels] = useState(settings.watch_channel_ids.join(", "));

  return (
    <Modal title="Configurações" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            watch_dms: dms,
            watch_mentions: mentions,
            vip_user_ids: toList(vips),
            important_keywords: toList(keywords),
            watch_channel_ids: toList(channels),
          });
        }}
      >
        <div className="settings-block">
          <div className="settings-row">
            <div>
              <b>Slack</b>
              <small>
                {slackConn === undefined
                  ? "Verificando…"
                  : slackConn
                    ? `Conectado como ${slackConn.slack_user_id}`
                    : "Não conectado"}
              </small>
            </div>
            {slackConn ? (
              <div className="settings-actions">
                <button type="button" className="link" onClick={onConnect} disabled={connecting}>Reconectar</button>
                <button type="button" className="link danger" onClick={onDisconnect}>Desconectar</button>
              </div>
            ) : (
              <button type="button" className="btn primary sm" onClick={onConnect} disabled={connecting || slackConn === undefined}>
                {connecting ? "Abrindo…" : "Conectar Slack"}
              </button>
            )}
          </div>
          <small className="hint">Logado como {email}</small>
        </div>

        <fieldset className="settings-block">
          <legend>O que vira tarefa</legend>
          <label className="check-label">
            <input type="checkbox" checked={dms} onChange={(e) => setDms(e.target.checked)} />
            Mensagens diretas (DMs) que eu receber
          </label>
          <label className="check-label">
            <input type="checkbox" checked={mentions} onChange={(e) => setMentions(e.target.checked)} />
            Mensagens em canais que me mencionarem
          </label>
          <p className="hint">Reagir com 📌 a qualquer mensagem sempre cria uma tarefa.</p>
        </fieldset>

        <label>
          Pessoas-chave <span className="opt">IDs do Slack, separados por vírgula</span>
          <input value={vips} onChange={(e) => setVips(e.target.value)} placeholder="U012ABC, U034DEF" />
          <small className="hint">Pedidos delas sempre contam como importantes. Para pegar o ID: perfil da pessoa → ⋮ → Copiar ID do membro.</small>
        </label>
        <label>
          Palavras importantes <span className="opt">separadas por vírgula</span>
          <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="lançamento, black friday, pós" />
        </label>
        <label>
          Canais monitorados <span className="opt">opcional · IDs de canal</span>
          <input value={channels} onChange={(e) => setChannels(e.target.value)} placeholder="C012ABC" />
          <small className="hint">Toda mensagem nesses canais passa pela triagem, mesmo sem menção a você.</small>
        </label>

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn primary">Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

// ======================================================================
// Dados de demonstração
// ======================================================================
const EMPTY_TASK: Task = {
  id: "", source: "manual", slack_channel_id: null, slack_ts: null, slack_user_name: null, permalink: null,
  raw_text: null, title: "", summary: null, due_date: null, urgency: null, importance: null, effort: null,
  suggested_quadrant: null, suggested_ei_quadrant: null, ai_reason: null, quadrant: null, ei_quadrant: null,
  done: false, moved_at: null, ei_moved_at: null, created_at: new Date().toISOString(),
};
const mkDemo = (t: Partial<Task>, i: number): Task => ({
  ...EMPTY_TASK, id: `demo-${i}`, created_at: new Date(Date.now() - i * 3_600_000).toISOString(), ...t,
});
const DEMO_TASKS: Task[] = [
  { title: "Enviar copy do e-mail da live LIACAP03", source: "slack", slack_user_name: "Maria Olivia", due_date: todayPlus(0), quadrant: "q1", ei_quadrant: "ei1", suggested_quadrant: "q1", suggested_ei_quadrant: "ei1", raw_text: "Poderia te passar a copy? Poderia ser 14h BRT?" },
  { title: "Validar eventos do dia", quadrant: "q1", ei_quadrant: "ei1" },
  { title: "Corrigir erros críticos", due_date: todayPlus(1), quadrant: "q1", ei_quadrant: "ei1" },
  { title: "Melhorias no Active Campaign", quadrant: "q2", ei_quadrant: "ei2", due_date: todayPlus(9) },
  { title: "Criar checklists pra Giveaway", quadrant: "q2", ei_quadrant: "ei2" },
  { title: "Dúvidas simples", quadrant: "q3", ei_quadrant: "ei3" },
  { title: "Solicitações internas de baixo impacto", quadrant: "q3", ei_quadrant: "ei3" },
  { title: "Ajustes estéticos", quadrant: "q4", ei_quadrant: "ei4", due_date: todayPlus(-2) },
  { title: "Checar encaminhamentos do Suporte BR", source: "slack", slack_user_name: "Renan Palmieri", suggested_quadrant: "q1", suggested_ei_quadrant: "ei1" },
  { title: "Trocar link do grupo de alunos nos e-mails", source: "slack", slack_user_name: "Heitor Catunda", due_date: todayPlus(2), suggested_quadrant: "q2", suggested_ei_quadrant: "ei1" },
].map((t, i) => mkDemo(t as Partial<Task>, i));

// ======================================================================
// Utils
// ======================================================================
function todayYmd() {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function todayPlus(n: number) {
  const d = new Date(todayYmd() + "T12:00:00");
  d.setDate(d.getDate() + n);
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function dueInfo(ymd: string): { label: string; cls: string } {
  const diff = Math.round((new Date(ymd + "T12:00:00").getTime() - new Date(todayYmd() + "T12:00:00").getTime()) / 86_400_000);
  if (diff < 0) return { label: diff === -1 ? "Ontem" : `${formatDate(ymd)}`, cls: "late" };
  if (diff === 0) return { label: "Hoje", cls: "today" };
  if (diff === 1) return { label: "Amanhã", cls: "soon" };
  if (diff < 7) return { label: new Date(ymd + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", ""), cls: "soon" };
  return { label: formatDate(ymd), cls: "" };
}

function timeAgo(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "agora";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

function formatDate(d: string) {
  const [, m, day] = d.split("-");
  return `${day}/${m}`;
}

function short(s: string) {
  return s.length > 40 ? s.slice(0, 38) + "…" : s;
}
