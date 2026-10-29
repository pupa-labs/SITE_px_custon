# PX CUSTON — Guia de Aplicação e Verificação do Banco de Dados (Supabase)

Este documento descreve como aplicar a migração inicial de produção (`supabase/migrations/001_initial_schema.sql`) no seu projeto Supabase e como validar que todas as tabelas, restrições de estoque, funções transacionais e políticas de **Row Level Security (RLS)** foram criadas corretamente.

> **Importante**: A criação do arquivo `.sql` no repositório não executa alterações automaticamente no banco remoto. Siga os passos abaixo no painel do Supabase para aplicar a estrutura.

---

## 1. Estrutura Criada pela Migração `001_initial_schema.sql`

A migração cria **6 tabelas principais** no schema `public` com chaves primárias `UUID`, valores monetários estritamente em `NUMERIC(12, 2)` (nunca `FLOAT`), chaves estrangeiras, índices de performance e auditoria automática (`created_at` e `updated_at`):

1. **`public.profiles`**
   - Vinculada `1:1` com `auth.users(id)`.
   - Possui trigger automático (`on_auth_user_created`) que cria o perfil com `role = 'customer'` assim que o usuário se cadastra no Supabase Auth.
   - Possui trigger de segurança (`trg_profiles_prevent_escalation`) que impede que um usuário comum altere seu próprio `role` pelo navegador.
2. **`public.events`**
   - Eventos oficiais da PX CUSTON (`status` em `'draft' | 'published' | 'ended' | 'cancelled'`).
   - Controle de capacidade (`capacity`) e ingressos confirmados (`tickets_sold`).
3. **`public.ticket_categories`**
   - Categorias de ingresso vinculadas a um evento (ex.: *Pista*, *VIP*, *Exposição de Veículos*), com limite por pedido (`max_per_order`).
4. **`public.ticket_batches`**
   - Lotes vinculados ao evento e à categoria (`1º Lote Promocional`, `2º Lote`, etc.).
   - Controle estrito de estoque no motor do PostgreSQL através da constraint:
     `CHECK (reserved_quantity + sold_quantity <= total_quantity)`
     impedindo que compras simultâneas ultrapassem a quantidade total do lote.
5. **`public.orders`**
   - Pedidos vinculados ao comprador (`user_id`), evento (`event_id`) e lote (`ticket_batch_id`).
   - Separa `order_status` (`'pending_payment' | 'reserved' | 'paid' | 'cancelled' | 'expired' | 'refunded'`) de `payment_status` (`'pending' | 'in_process' | 'approved' | 'rejected' | 'cancelled' | 'refunded' | 'charged_back'`).
   - Possui a constraint `chk_order_paid_requires_approved_payment`: **nenhum pedido pode assumir `order_status = 'paid'` sem que `payment_status = 'approved'`, `mp_payment_id` e `paid_at` estejam preenchidos**.
6. **`public.tickets`**
   - Ingressos individuais com `code` único e `qr_payload` único, emitidos exclusivamente após a confirmação oficial do pagamento.
   - Controle de status (`'pending' | 'paid' | 'cancelled' | 'refunded' | 'used' | 'expired'`) e registro de check-in (`used_at`, `used_by_operator_id`, `checkin_device_id`).

---

## 2. Como Aplicar a Migração pelo SQL Editor do Supabase

1. Acesse o painel do seu projeto em [https://supabase.com/dashboard](https://supabase.com/dashboard).
2. No menu lateral esquerdo, clique em **SQL Editor**.
3. Clique em **New query**.
4. Copie todo o conteúdo do arquivo **`supabase/migrations/001_initial_schema.sql`** deste projeto e cole no editor.
5. Clique em **Run** (ou pressione `Ctrl + Enter` / `Cmd + Enter`).
6. Aguarde a mensagem **`Success. No rows returned`**, que confirma que a transação `BEGIN ... COMMIT` foi executada sem erros.

---

## 3. Como Verificar se as Tabelas, Constraints e Políticas RLS Foram Criadas

Após executar a migração, cole e execute as consultas abaixo em uma nova aba do **SQL Editor** para auditar a instalação:

### 3.1. Verificar as 6 tabelas e confirmação de RLS ativo (`rowsecurity = true`)

```sql
SELECT
  schemaname,
  tablename,
  rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'profiles',
    'events',
    'ticket_categories',
    'ticket_batches',
    'orders',
    'tickets'
  )
ORDER BY tablename;
```
*Resultado esperado*: 6 linhas retornadas, todas com `rls_enabled = true`.

### 3.2. Verificar todas as Políticas de Acesso (RLS Policies)

```sql
SELECT
  tablename,
  policyname,
  permissive,
  roles,
  cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
```
*Resultado esperado*: Listagem das políticas restritivas (`profiles_select_own_or_admin`, `events_select_published_or_admin`, `orders_select_own_or_admin`, `tickets_select_own_or_staff`, etc.).

### 3.3. Verificar as Funções Transacionais (RPCs de Estoque, Pagamento e Check-in)

```sql
SELECT
  routine_name,
  security_type,
  data_type AS return_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'is_admin_or_super_admin',
    'is_checkin_staff',
    'reserve_ticket_order',
    'confirm_order_payment',
    'release_expired_reservations',
    'perform_ticket_checkin'
  )
ORDER BY routine_name;
```
*Resultado esperado*: 6 funções listadas com `security_type = 'DEFINER'`.

---

## 4. Como Promover o Primeiro Usuário Administrador (`SUPER_ADMIN`)

Por segurança, todo usuário criado via cadastro recebe automaticamente `role = 'customer'`, e o banco bloqueia alterações de `role` vindas do navegador. Para definir sua conta administrativa oficial da **PX CUSTON**, execute no **SQL Editor** do Supabase:

```sql
UPDATE public.profiles
SET role = 'SUPER_ADMIN'
WHERE email = 'seu-email-administrador@dominio.com';
```

---

## 5. Verificação pelo Painel `PX CONTROL` na Aplicação

Depois de aplicar o SQL no Supabase:
1. Abra a aplicação **PX CUSTON**.
2. Acesse **PX CONTROL → Configurações**.
3. No card **"Diagnóstico Seguro de Conexão — Supabase"**, clique em **"Testar Conexão Supabase"**.
4. O indicador **"Estrutura SQL (001_initial_schema)"** exibirá se as 6 tabelas já foram detectadas no banco ou se a aplicação manual da migração ainda está pendente.
