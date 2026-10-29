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

## 2. Como Aplicar as Migrações pelo SQL Editor do Supabase

As migrações devem ser executadas em ordem numérica no **SQL Editor** do Supabase:

1. Acesse o painel do seu projeto em [https://supabase.com/dashboard](https://supabase.com/dashboard).
2. No menu lateral esquerdo, clique em **SQL Editor** → **New query**.
3. **Passo 1 (caso ainda não tenha aplicado a 001)**:
   - Copie todo o conteúdo de **`supabase/migrations/001_initial_schema.sql`**, cole no editor e clique em **Run**.
4. **Passo 2 (aplicar a correção de contratos, permissões e idempotência)**:
   - Crie uma nova query, copie todo o conteúdo de **`supabase/migrations/002_rpc_contracts_permissions_idempotency.sql`**, cole no editor e clique em **Run**.
   - Aguarde a confirmação **`Success. No rows returned`**.

### O que a migração `002_rpc_contracts_permissions_idempotency.sql` corrige e adiciona:
- **`public.reserve_ticket_order`**:
  - Alinha o nome do parâmetro `p_ticket_batch_id` com o código TypeScript e com a coluna `orders.ticket_batch_id`.
  - Retorna `JSONB` completo (`order_id`, `order_code`, `unit_price`, `subtotal`, `convenience_fee`, `total_amount`, `order_status`, `payment_status`, `reservation_expires_at`) calculado exclusivamente pelo PostgreSQL a partir do preço oficial do lote.
  - Remove a política de `INSERT` direto na tabela `orders`, garantindo que nenhum pedido seja criado fora da função transacional autenticada.
- **`public.perform_ticket_checkin`**:
  - Retorna simultaneamente `result` e `ticket_code` (além de `status_reason` e `code` para retrocompatibilidade), alinhado ao serviço TypeScript.
  - Exige sessão autenticada (`auth.uid() IS NOT NULL`) e perfil autorizado (`checkin_operator`, `admin` ou `SUPER_ADMIN`).
- **Permissões SQL (`REVOKE` / `GRANT`)**:
  - Revoga explicitamente `EXECUTE` de `PUBLIC` e `anon` nas 4 funções privilegiadas (`reserve_ticket_order`, `confirm_order_payment`, `release_expired_reservations`, `perform_ticket_checkin`) e nas funções auxiliares (`is_admin_or_super_admin`, `is_checkin_staff`).
  - Mantém `confirm_order_payment` exclusiva para `service_role` (backend confiável).
- **Idempotência de Pagamento (`public.confirm_order_payment`)**:
  - Se o pedido já estiver `paid`, verifica se `p_mp_payment_id` é idêntico ao `mp_payment_id` salvo no pedido; se for diferente, lança erro de conflito.
  - Impede que um mesmo `mp_payment_id` seja usado em pedidos diferentes.
  - Exige `p_mp_payment_status = 'approved'` e valida o valor pago quando informado.
  - Adiciona coluna `item_sequence` e índice único `uq_tickets_order_item_sequence (order_id, item_sequence)` em `public.tickets`, garantindo que chamadas repetidas nunca emitam ingressos duplicados.

---

## 3. Como Verificar se as Tabelas, Constraints, Políticas RLS e Permissões Foram Criadas

Após executar as migrações `001` e `002`, execute as consultas abaixo no **SQL Editor**:

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
*Resultado esperado*: Listagem das políticas restritivas (`profiles_select_own_or_admin`, `events_select_published_or_admin`, `orders_select_own_or_admin`, `tickets_select_own_or_staff`, etc.), sem permissão de inserção direta irrestrita em `orders`.

### 3.3. Verificar Assinaturas e Permissões (`EXECUTE`) das Funções Privilegiadas

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
    'reserve_ticket_order',
    'confirm_order_payment',
    'release_expired_reservations',
    'perform_ticket_checkin'
  )
ORDER BY p.proname;
```
*Resultado esperado*:
- `anon_can_execute = false` em **todas** as 4 funções.
- `confirm_order_payment`: `authenticated_can_execute = false` e `service_role_can_execute = true`.
- `reserve_ticket_order`, `perform_ticket_checkin` e `release_expired_reservations`: `authenticated_can_execute = true` (com validação interna de `auth.uid()` e papel administrativo/operador).

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

