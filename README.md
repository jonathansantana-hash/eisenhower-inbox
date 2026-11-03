# Eisenhower Inbox: do Slack para a matriz de Eisenhower

Quando chega uma mensagem no Slack, a IA decide se é um pedido de tarefa para você. Se for, a tarefa aparece no seu site na coluna **Novas**, com a sugestão de quadrante e o motivo. A IA **não atribui** a tarefa a nenhum quadrante. Quem decide é você, arrastando o card (ou clicando em "Aceitar").

```
Slack ──► Supabase Edge Function ──► Claude (é tarefa? qual quadrante?)
                    │
                    ▼
          Tabela tasks (quadrant = NULL → "Novas")
                    │ Realtime
                    ▼
     Site no GitHub Pages: Novas | Fazer | Agendar | Delegar | Eliminar
```

## O que o assistente lê
Tudo é configurável nos secrets da função:

| Fonte | Secret | Padrão |
|---|---|---|
| DMs que você recebe | `WATCH_DMS` | `true` |
| Mensagens que mencionam você (`@você`) | `WATCH_MENTIONS` | `true` |
| Todas as mensagens de canais específicos | `WATCH_CHANNEL_IDS` (ex.: `C0123,C0456`) | vazio |
| Mensagem em que **você** reage com 📌 (vira tarefa sempre) | `TRIGGER_EMOJI` | `pushpin` |

Mensagens triviais ("ok", "valeu", "bom dia"), mensagens de bots e as suas próprias são ignoradas antes de chegar à IA.

**Aprendizado:** quando você coloca uma tarefa num quadrante diferente do sugerido, essa correção entra como exemplo nas próximas classificações. Com o tempo, a IA se ajusta ao seu jeito de priorizar.

---

## Passo a passo do deploy (≈ 30 min)

Pré-requisitos: Node 20 ou mais recente. A CLI do Supabase roda via `npx supabase`, então não precisa instalar.

### 1. Supabase: projeto e banco
1. Crie um projeto em https://supabase.com/dashboard.
2. No terminal, dentro desta pasta:
   ```bash
   npx supabase login
   npx supabase link --project-ref SEU_PROJECT_REF
   npx supabase db push
   ```
   Se preferir, cole o conteúdo de `supabase/migrations/*.sql` no **SQL Editor** do painel.
3. Libere o seu e-mail para acessar o quadro (SQL Editor):
   ```sql
   insert into public.allowed_users (email) values ('seu@email.com');
   ```
4. **Authentication → Users → Add user → Send invite** com o mesmo e-mail. O login no site é por link mágico e não aceita cadastro novo.
5. **Authentication → Sign In / Providers**: desative "Allow new users to sign up".

### 2. Slack: criar o app
1. Acesse https://api.slack.com/apps → **Create New App → From a manifest**, escolha o workspace e cole o conteúdo de `slack-manifest.yml`.
2. Em **Basic Information**, copie o **Signing Secret**.
3. Em **OAuth & Permissions → Install to Workspace**, copie o **User OAuth Token** (`xoxp-...`).
4. Descubra o seu ID de usuário: no Slack, abra seu perfil → ⋮ → **Copiar ID do membro** (`U0...`).

### 3. Publicar a função
1. Crie uma chave de API da Anthropic em https://console.anthropic.com.
2. Configure os secrets e publique a função:
   ```bash
   npx supabase secrets set \
     SLACK_SIGNING_SECRET=xxx \
     SLACK_USER_TOKEN=xoxp-xxx \
     MY_SLACK_USER_ID=U0XXXX \
     ANTHROPIC_API_KEY=sk-ant-xxx \
     USER_CONTEXT="Sou gerente de X na empresa Y. Meus objetivos do trimestre: ... Pessoas-chave: ..."

   npx supabase functions deploy slack-events --no-verify-jwt
   ```
   > ⭐ O `USER_CONTEXT` é o que mais melhora a qualidade das sugestões. Descreva seu cargo, seus objetivos atuais e quem são as pessoas importantes, como seu chefe e seus clientes principais.

### 4. Slack: ligar os eventos
No app do Slack, abra **Event Subscriptions** e ative a opção.
- **Request URL:** `https://SEU_PROJECT_REF.supabase.co/functions/v1/slack-events`. Deve aparecer "Verified ✓".
- Em **Subscribe to events on behalf of users**, adicione: `message.im`, `message.mpim`, `message.channels`, `message.groups`, `reaction_added`.
- Clique em **Save Changes** e, se o Slack pedir, reinstale o app.

### 5. Site no GitHub Pages
1. Crie um repositório no GitHub e envie esta pasta (`git init`, `git add .`, `git commit`, `git push`).
2. Vá em **Settings → Secrets and variables → Actions** e adicione os secrets abaixo. Os valores ficam em Supabase → Project Settings → API.
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY` (a chave *anon/publishable*; é segura no navegador porque o RLS protege os dados)
3. Em **Settings → Pages → Source**, escolha **GitHub Actions**.
4. Cada push na `main` publica o site em `https://SEU_USUARIO.github.io/SEU_REPO/`.
5. No Supabase, em **Authentication → URL Configuration**, coloque essa URL em **Site URL** e em **Redirect URLs**.

### Rodar o site localmente
```bash
cd web
cp .env.example .env.local   # preencha
npm install
npm run dev
```
Adicione `http://localhost:5173` em Redirect URLs para o login funcionar no ambiente local.

---

## Testar
Peça para alguém mandar uma DM do tipo *"Consegue revisar a proposta do cliente X até amanhã?"*. Em poucos segundos o card aparece em **Novas**. Os logs ficam no painel: **Edge Functions → slack-events → Logs**.

## Com ou sem IA
- **Sem `ANTHROPIC_API_KEY`:** a classificação é feita por regras (`supabase/functions/slack-events/rules.ts`), com base em verbos de pedido, prazos ("amanhã", "até sexta", "10/11"), urgência e palavras importantes. É grátis.
  - `VIP_USER_IDS=U0AAA,U0BBB`: pedidos dessas pessoas (chefe, clientes) contam como importantes.
  - `IMPORTANT_KEYWORDS=lançamento,black friday,…`: palavras extras que indicam importância.
- **Com `ANTHROPIC_API_KEY`:** usa o Claude. Se a IA falhar, a função volta para as regras.

## Custos
- Supabase, GitHub Pages: plano grátis atende.
- Claude (opcional): um pedido por mensagem que passa no filtro. O padrão é o `claude-haiku-5-5`, que custa poucos reais por mês. Dá para trocar com `CLAUDE_MODEL`.

## Estrutura
```
supabase/migrations/…_tasks.sql     tabela, RLS, realtime
supabase/functions/slack-events/    recebe o Slack, filtra, classifica com Claude, grava
web/                                site React + dnd-kit (Kanban)
slack-manifest.yml                  configuração do app do Slack
.github/workflows/deploy-web.yml    deploy automático do site
```
