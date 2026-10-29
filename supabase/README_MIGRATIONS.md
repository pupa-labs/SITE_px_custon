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

## 2. Como Validar com Segurança e Aplicar a Migração `002` no Supabase

Como a **`001_initial_schema.sql`** já foi aplicada no banco remoto, siga o procedimento abaixo para validar e aplicar a **`002_rpc_contracts_permissions_idempotency.sql`** com segurança:

### 2.1. Pré-verificação de integridade antes de rodar a `002` (Somente Leitura)
Execute no **SQL Editor** do Supabase para confirmar que nenhum pedido existente possui mais ingressos emitidos do que sua `quantity`:

```sql
SELECT
  o.id AS order_id,
  o.order_code,
  o.quantity AS expected_quantity,
  COUNT(t.id) AS existing_tickets
FROM public.orders o
LEFT JOIN public.tickets t ON t.order_id = o.id
GROUP BY o.id, o.order_code, o.quantity
HAVING COUNT(t.id) > o.quantity;
```
*Resultado esperado*: `0 rows` (nenhuma inconsistência pré-existente).

### 2.2. Ensaio Seguro (Dry-Run com `ROLLBACK`)
Para testar toda a execução da migration `002` sem persistir alterações:
1. Copie o conteúdo de `supabase/migrations/002_rpc_contracts_permissions_idempotency.sql` para uma aba do **SQL Editor**.
2. Substitua temporariamente a última linha `COMMIT;` por `ROLLBACK;`.
3. Clique em **Run**. Se retornar `Success`, todas as validações, backfill determinístico de `item_sequence`, índices, políticas e assinaturas de funções são 100% compatíveis com os dados atuais.

### 2.3. Aplicação Definitiva (`COMMIT`)
1. Restaure a última linha para `COMMIT;` (exatamente como está no arquivo `supabase/migrations/002_rpc_contracts_permissions_idempotency.sql`).
2. Clique em **Run** e aguarde **`Success. No rows returned`**.

### O que a migração `002_rpc_contracts_permissions_idempotency.sql` corrige e adiciona:
- **Backfill determinístico e proteção de ingressos existentes (`public.tickets`)**:
  - Preenche `item_sequence` (`1..N`) de forma determinística (`ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY issued_at, created_at, code, id)`) para quaisquer ingressos já existentes, abortando caso algum pedido tenha excedido `orders.quantity`.
  - Define `item_sequence NOT NULL CHECK (item_sequence >= 1)` e cria o índice único total `uq_tickets_order_item_sequence (order_id, item_sequence)`.
- **`public.reserve_ticket_order`**:
  - Alinha o nome do parâmetro `p_ticket_batch_id` com o código TypeScript e com a coluna `orders.ticket_batch_id`.
  - Retorna `JSONB` completo (`order_id`, `order_code`, `unit_price`, `subtotal`, `convenience_fee`, `total_amount`, `order_status`, `payment_status`, `reservation_expires_at`) calculado exclusivamente pelo PostgreSQL a partir do preço oficial do lote com lock `FOR UPDATE`.
  - Remove a política `orders_insert_own_pending` para impedir criação direta de pedidos fora da função transacional autenticada.
- **`public.confirm_order_payment`**:
  - Sem valores default enganosos: exige obrigatoriamente `(p_order_id, p_mp_payment_id, p_mp_payment_status, p_verified_amount, p_currency, p_external_reference)` obtidos pelo backend após consultar a API oficial do Mercado Pago (`GET /v1/payments/{id}`).
  - Rejeita `p_verified_amount IS NULL`, exige `p_mp_payment_status = 'approved'`, `p_currency = 'BRL'`, `p_verified_amount = orders.total_amount` e confere que `p_external_reference` pertence ao pedido (`orders.id` ou `orders.order_code`).
  - Remove qualquer uso de `current_user` dentro de `SECURITY DEFINER`, validando exclusivamente a claim JWT `role = 'service_role'` e concedendo `GRANT EXECUTE` apenas para `service_role`.
  - Idempotência estrita: se o pedido já estiver `paid` com o mesmo `mp_payment_id`, retorna `idempotent_replay = true` sem emitir ingressos duplicados e sem incrementar `sold_quantity` ou `tickets_sold` novamente.
- **`public.perform_ticket_checkin` e Permissões SQL (`REVOKE` / `GRANT`)**:
  - Retorna `result` e `ticket_code` (mantendo `status_reason` e `code`), exigindo sessão autenticada e operador autorizado (`public.is_checkin_staff()`).
  - Preserva `EXECUTE` em `public.is_admin_or_super_admin()` para `anon, authenticated, service_role` (necessário para avaliação das políticas RLS de leitura em `events`, `ticket_categories` e `ticket_batches`), enquanto revoga `PUBLIC` e `anon` de `is_checkin_staff` e de todas as 4 funções transacionais (`reserve_ticket_order`, `confirm_order_payment`, `release_expired_reservations`, `perform_ticket_checkin`).

---

## 3. Como Verificar se as Tabelas, Constraints, Políticas RLS e Permissões Foram Criadas

Após executar a migração `002`, execute as consultas abaixo no **SQL Editor**:

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
*Resultado esperado*: Listagem das políticas restritivas (`profiles_select_own_or_admin`, `events_select_published_or_admin`, `orders_select_own_or_admin`, `tickets_select_own_or_staff`, etc.), sem a policy `orders_insert_own_pending`.

### 3.3. Verificar Assinaturas e Permissões (`EXECUTE`) das Funções

```sql
SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS return_type,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'is_admin_or_super_admin',
    'is_checkin_staff',
    'reserve_ticket_order',
    'confirm_order_payment',
    'release_expired_reservations',
    'perform_ticket_checkin'
  )
ORDER BY p.proname;
```
*Resultado esperado*:
- `reserve_ticket_order`, `confirm_order_payment`, `release_expired_reservations`, `perform_ticket_checkin` e `is_checkin_staff`: `anon_can_execute = false`.
- `confirm_order_payment`: `authenticated_can_execute = false` e `service_role_can_execute = true`.
- `is_admin_or_super_admin`: `anon_can_execute = true` e `authenticated_can_execute = true` (retorna `FALSE` quando `auth.uid() IS NULL`, permitindo que as policies de `SELECT` em `events`, `ticket_categories` e `ticket_batches` funcionem sem erro de permissão).

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

