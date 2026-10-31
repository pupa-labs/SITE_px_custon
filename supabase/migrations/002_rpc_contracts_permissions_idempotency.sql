-- =============================================================================
-- PX CUSTON — Plataforma de Ingressos, Eventos & Check-in Online
-- Migration: 002_rpc_contracts_permissions_idempotency.sql
-- Pré-requisito: 001_initial_schema.sql já aplicada no banco.
-- Descrição:
--   1. Backfill determinístico (sem lacunas) de `item_sequence` para ingressos
--      existentes, auditoria de integridade (órfãos, excesso por pedido,
--      intervalo 1..quantity e duplicidades) e criação de índice único total
--      `uq_tickets_order_item_sequence (order_id, item_sequence)`.
--   2. Proteção da capacidade global do evento (`events.capacity`):
--      - Triggers de integridade em `public.events` e `public.ticket_batches`
--        impedindo redução de capacidade abaixo de vendidos + reservados ou
--        lotes ativos que excedam a capacidade global.
--      - Alinhamento de `public.reserve_ticket_order` com serialização por evento
--        (ordem estrita de lock `events` -> `ticket_batches`), contabilizando
--        ingressos vendidos (`tickets_sold` / `SUM(sold_quantity)`) + todos os
--        ingressos reservados (`SUM(reserved_quantity)`) em todos os lotes do evento.
--      - Parâmetro `p_ticket_batch_id` compatível com `orders.ticket_batch_id` e TypeScript.
--      - Retorno `JSONB` completo (`order_id`, `order_code`, `unit_price`,
--        `subtotal`, `convenience_fee`, `total_amount`, `order_status`,
--        `payment_status`, `reservation_expires_at`).
--      - Remoção de `orders_insert_own_pending` para impedir criação direta de pedidos fora da RPC.
--   3. Endurecimento de `public.confirm_order_payment`:
--      - Sem parâmetros default enganosos: exige obrigatoriamente status oficial,
--        valor total verificado (`p_verified_amount NOT NULL`), moeda (`p_currency = 'BRL'`)
--        e vínculo com o pedido (`p_external_reference`) validados pelo backend na API
--        oficial do Mercado Pago antes da chamada SQL.
--      - Ordem consistente de locks (`pg_advisory_xact_lock` -> `orders` -> `events` -> `ticket_batches`)
--        alinhada com `reserve_ticket_order` e `release_expired_reservations` para evitar deadlocks.
--      - Geração de códigos de ingresso (`PX-XXXXXXXX`, 8 hex chars) resistente a colisões
--        com captura seletiva de `unique_violation` e limite controlado de tentativas.
--      - Remoção do uso incorreto de `current_user` em função `SECURITY DEFINER`;
--        autorização baseada estritamente na claim JWT `role = 'service_role'` e `GRANT` exclusivo.
--      - Idempotência rigorosa: reprocessar o mesmo pagamento aprovado não emite ingressos
--        duplicados nem incrementa novamente `sold_quantity` ou `tickets_sold`.
--   4. Alinhamento de `public.perform_ticket_checkin` e `public.release_expired_reservations`:
--      - Retorno JSONB contendo `result`, `ticket_code`, `holder_name`, `ticket_id`, `used_at` e `message`
--        (mantendo `status_reason` e `code` para compatibilidade).
--      - Autorização de `release_expired_reservations` para `service_role`, administrador autenticado
--        (`is_admin_or_super_admin()`) e contexto administrativo direto do banco (`session_user`
--        `postgres`/`supabase_admin` sem JWT PostgREST), com locks ordenados (`orders` -> `events` -> `ticket_batches`).
--   5. Revisão de permissões (`REVOKE` / `GRANT`) e `search_path = public, pg_temp`:
--      - Preserva execução de `is_admin_or_super_admin()` nos contextos exigidos pelas políticas RLS
--        de leitura pública (`events`, `ticket_categories`, `ticket_batches`).
--      - Revoga execução pública/anônima de todas as funções de escrita e operação.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. FUNÇÕES AUXILIARES DE AUTORIZAÇÃO E AUDITORIA (IN-PLACE, SEM QUEBRAR RLS)
-- =============================================================================
-- Nota: `is_admin_or_super_admin` e `is_checkin_staff` são referenciadas por
-- políticas RLS criadas na migration 001. Usamos CREATE OR REPLACE (nunca DROP)
-- para preservar todas as dependências existentes.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_admin_or_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN FALSE
    ELSE EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'SUPER_ADMIN')
    )
  END;
$$;

CREATE OR REPLACE FUNCTION public.is_checkin_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN FALSE
    ELSE EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE id = auth.uid()
        AND role IN ('checkin_operator', 'admin', 'SUPER_ADMIN')
    )
  END;
$$;

-- Atualiza trigger de prevenção de escalada de privilégio e proteção de campos imutáveis
CREATE OR REPLACE FUNCTION public.prevent_profile_privilege_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'Operação negada: o identificador do perfil (id) é imutável.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Operação negada: a data de criação do perfil (created_at) é imutável.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.role IS DISTINCT FROM OLD.role THEN
      -- Permite alteração por:
      -- 1. Backend confiável via service_role
      -- 2. Administrador autenticado (admin / SUPER_ADMIN)
      -- 3. Sessão administrativa direta no SQL Editor (sem JWT PostgREST e com session_user postgres/supabase_admin)
      IF v_jwt_role <> 'service_role'
         AND NOT public.is_admin_or_super_admin()
         AND NOT (v_jwt_role = '' AND auth.uid() IS NULL AND session_user IN ('postgres', 'supabase_admin'))
      THEN
        RAISE EXCEPTION 'Operação negada: alteração de papel administrativo não autorizada.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, cpf, phone, city, role)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(btrim(NEW.raw_user_meta_data->>'full_name'), ''), split_part(NEW.email, '@', 1)),
    NEW.email,
    NULLIF(regexp_replace(COALESCE(NEW.raw_user_meta_data->>'cpf', ''), '\D', '', 'g'), ''),
    NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'phone', '')), ''),
    NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'city', '')), ''),
    'customer'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- =============================================================================
-- 2. BACKFILL DETERMINÍSTICO E PROTEÇÃO DE INGRESSOS EXISTENTES E NOVOS
-- =============================================================================

-- 2.1 Adiciona a coluna item_sequence se ainda não existir
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS item_sequence INTEGER;

-- 2.2 Verifica ingressos órfãos (cujo order_id não exista em public.orders)
DO $$
DECLARE
  v_orphan RECORD;
BEGIN
  SELECT t.id AS ticket_id, t.code, t.order_id
  INTO v_orphan
  FROM public.tickets t
  LEFT JOIN public.orders o ON o.id = t.order_id
  WHERE o.id IS NULL
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Migração abortada por segurança: o ingresso % (código %) referencia um order_id inexistente (%).',
      v_orphan.ticket_id,
      v_orphan.code,
      v_orphan.order_id;
  END IF;
END;
$$;

-- 2.3 Verifica se algum pedido existente possui mais ingressos do que a quantidade contratada
DO $$
DECLARE
  v_problematic_order RECORD;
BEGIN
  SELECT
    o.id AS order_id,
    o.order_code,
    o.quantity AS expected_quantity,
    COUNT(t.id) AS actual_tickets
  INTO v_problematic_order
  FROM public.orders o
  JOIN public.tickets t ON t.order_id = o.id
  GROUP BY o.id, o.order_code, o.quantity
  HAVING COUNT(t.id) > o.quantity
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Migração abortada por segurança: o pedido % (%) possui % ingressos emitidos, acima da quantidade contratada (%). Audite os registros duplicados antes de prosseguir.',
      v_problematic_order.order_code,
      v_problematic_order.order_id,
      v_problematic_order.actual_tickets,
      v_problematic_order.expected_quantity;
  END IF;
END;
$$;

-- 2.4 Verifica se já existem valores fora de intervalo (1..orders.quantity) ou duplicados em item_sequence
DO $$
DECLARE
  v_invalid_seq RECORD;
  v_dup RECORD;
BEGIN
  SELECT
    t.id AS ticket_id,
    t.order_id,
    t.item_sequence,
    o.quantity AS max_allowed
  INTO v_invalid_seq
  FROM public.tickets t
  JOIN public.orders o ON o.id = t.order_id
  WHERE t.item_sequence IS NOT NULL
    AND (t.item_sequence < 1 OR t.item_sequence > o.quantity)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Migração abortada: o ingresso % do pedido % possui item_sequence=% fora do intervalo válido (1..%).',
      v_invalid_seq.ticket_id,
      v_invalid_seq.order_id,
      v_invalid_seq.item_sequence,
      v_invalid_seq.max_allowed;
  END IF;

  SELECT order_id, item_sequence, COUNT(*) AS dup_count
  INTO v_dup
  FROM public.tickets
  WHERE item_sequence IS NOT NULL
  GROUP BY order_id, item_sequence
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Migração abortada: o pedido % já possui item_sequence=% duplicado (% registros).',
      v_dup.order_id,
      v_dup.item_sequence,
      v_dup.dup_count;
  END IF;
END;
$$;

-- 2.5 Preenchimento determinístico e sem lacunas (1..orders.quantity) para ingressos com item_sequence IS NULL
WITH orders_with_null_tickets AS (
  SELECT DISTINCT o.id AS order_id, o.quantity
  FROM public.orders o
  JOIN public.tickets t ON t.order_id = o.id
  WHERE t.item_sequence IS NULL
),
available_slots AS (
  SELECT
    ow.order_id,
    gs.seq_num,
    ROW_NUMBER() OVER (PARTITION BY ow.order_id ORDER BY gs.seq_num ASC) AS slot_rank
  FROM orders_with_null_tickets ow
  CROSS JOIN LATERAL generate_series(1, ow.quantity) AS gs(seq_num)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.tickets t_used
    WHERE t_used.order_id = ow.order_id
      AND t_used.item_sequence = gs.seq_num
  )
),
ranked_null_tickets AS (
  SELECT
    t.id AS ticket_id,
    t.order_id,
    ROW_NUMBER() OVER (
      PARTITION BY t.order_id
      ORDER BY t.issued_at ASC, t.created_at ASC, t.code ASC, t.id ASC
    ) AS ticket_rank
  FROM public.tickets t
  WHERE t.item_sequence IS NULL
)
UPDATE public.tickets t
SET item_sequence = s.seq_num
FROM ranked_null_tickets r
JOIN available_slots s
  ON s.order_id = r.order_id
 AND s.slot_rank = r.ticket_rank
WHERE t.id = r.ticket_id
  AND t.item_sequence IS NULL;

-- 2.6 Verificação pós-backfill e criação de restrições NOT NULL + UNIQUE total
DO $$
DECLARE
  v_remaining_nulls INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_remaining_nulls
  FROM public.tickets
  WHERE item_sequence IS NULL;

  IF v_remaining_nulls > 0 THEN
    RAISE EXCEPTION
      'Migração abortada: restaram % ingressos com item_sequence nulo após o backfill.',
      v_remaining_nulls;
  END IF;
END;
$$;

ALTER TABLE public.tickets
  ALTER COLUMN item_sequence SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_tickets_item_sequence_positive'
      AND conrelid = 'public.tickets'::regclass
  ) THEN
    ALTER TABLE public.tickets
      ADD CONSTRAINT chk_tickets_item_sequence_positive
      CHECK (item_sequence >= 1);
  END IF;
END;
$$;

-- Remove eventual índice antigo e cria índice único TOTAL sobre (order_id, item_sequence)
DROP INDEX IF EXISTS public.uq_tickets_order_item_sequence;
CREATE UNIQUE INDEX uq_tickets_order_item_sequence
  ON public.tickets(order_id, item_sequence);

-- 2.7 Auditoria prévia de consistência dos pedidos existentes em `public.orders` e `public.tickets`
DO $$
DECLARE
  v_inconsistent_order RECORD;
  v_inconsistent_refunded RECORD;
  v_premature_ticket_order RECORD;
  v_mismatched_event_order RECORD;
BEGIN
  -- 2.7.a Verifica pedidos com order_status='paid' sem payment_status='approved' (ou vice-versa),
  --       ou cujo total de ingressos ativos ('paid'/'used') em `public.tickets` diverge de `orders.quantity`
  SELECT
    o.id AS order_id,
    o.order_code,
    o.order_status,
    o.payment_status,
    o.quantity AS expected_quantity,
    COUNT(t.id) AS actual_tickets,
    COUNT(t.id) FILTER (WHERE t.status IN ('paid', 'used')) AS active_tickets
  INTO v_inconsistent_order
  FROM public.orders o
  LEFT JOIN public.tickets t ON t.order_id = o.id
  WHERE (o.order_status = 'paid' AND o.payment_status <> 'approved')
     OR (o.payment_status = 'approved' AND o.order_status <> 'paid')
     OR (o.order_status = 'paid' AND o.payment_status = 'approved')
  GROUP BY o.id, o.order_code, o.order_status, o.payment_status, o.quantity
  HAVING (o.order_status = 'paid' AND o.payment_status <> 'approved')
      OR (o.payment_status = 'approved' AND o.order_status <> 'paid')
      OR (o.order_status = 'paid' AND COUNT(t.id) <> o.quantity)
      OR (o.order_status = 'paid' AND COUNT(t.id) FILTER (WHERE t.status IN ('paid', 'used')) <> o.quantity)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Migração abortada por divergência em public.orders (paid): pedido % (id=%, order_status=%, payment_status=%) possui % ingressos emitidos (% ativos paid/used) para quantity=%. Audite manualmente antes de aplicar a migration 002.',
      v_inconsistent_order.order_code,
      v_inconsistent_order.order_id,
      v_inconsistent_order.order_status,
      v_inconsistent_order.payment_status,
      v_inconsistent_order.actual_tickets,
      v_inconsistent_order.active_tickets,
      v_inconsistent_order.expected_quantity;
  END IF;

  -- 2.7.b Verifica pedidos reembolsados (`order_status = 'refunded'` ou `payment_status IN ('refunded', 'charged_back')`):
  --       exige que pedidos reembolsados tenham `order_status = 'refunded'`, `payment_status = 'refunded'`,
  --       `mp_payment_id IS NOT NULL`, `paid_at IS NOT NULL`, quantidade de ingressos igual a `orders.quantity`
  --       e todos os ingressos com `status = 'refunded'` (sem reembolso parcial nem exclusão de ingressos).
  SELECT
    o.id AS order_id,
    o.order_code,
    o.order_status,
    o.payment_status,
    o.mp_payment_id,
    o.paid_at,
    o.quantity AS expected_quantity,
    COUNT(t.id) AS actual_tickets,
    COUNT(t.id) FILTER (WHERE t.status = 'refunded') AS refunded_tickets
  INTO v_inconsistent_refunded
  FROM public.orders o
  LEFT JOIN public.tickets t ON t.order_id = o.id
  WHERE o.order_status = 'refunded'
     OR o.payment_status IN ('refunded', 'charged_back')
  GROUP BY o.id, o.order_code, o.order_status, o.payment_status, o.mp_payment_id, o.paid_at, o.quantity
  HAVING o.order_status <> 'refunded'
      OR o.payment_status <> 'refunded'
      OR o.mp_payment_id IS NULL
      OR o.paid_at IS NULL
      OR COUNT(t.id) <> o.quantity
      OR COUNT(t.id) FILTER (WHERE t.status = 'refunded') <> o.quantity
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Migração abortada por divergência em pedido reembolsado: pedido % (id=%, order_status=%, payment_status=%, mp_payment_id=%) possui % ingressos totais e % com status=refunded para quantity=%. Audite manualmente antes de aplicar a migration 002.',
      v_inconsistent_refunded.order_code,
      v_inconsistent_refunded.order_id,
      v_inconsistent_refunded.order_status,
      v_inconsistent_refunded.payment_status,
      COALESCE(v_inconsistent_refunded.mp_payment_id, 'NULL'),
      v_inconsistent_refunded.actual_tickets,
      v_inconsistent_refunded.refunded_tickets,
      v_inconsistent_refunded.expected_quantity;
  END IF;

  -- 2.7.c Verifica se existem ingressos emitidos para pedidos ainda não pagos ou cancelados/expirados
  --       (`order_status NOT IN ('paid', 'refunded')`)
  SELECT
    o.id AS order_id,
    o.order_code,
    o.order_status,
    o.payment_status,
    COUNT(t.id) AS ticket_count
  INTO v_premature_ticket_order
  FROM public.orders o
  JOIN public.tickets t ON t.order_id = o.id
  WHERE o.order_status NOT IN ('paid', 'refunded')
  GROUP BY o.id, o.order_code, o.order_status, o.payment_status
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Migração abortada por segurança: o pedido % (id=%, status=%/%) não está em estado elegível para ingressos (paid/refunded), mas possui % ingresso(s) vinculado(s) em public.tickets.',
      v_premature_ticket_order.order_code,
      v_premature_ticket_order.order_id,
      v_premature_ticket_order.order_status,
      v_premature_ticket_order.payment_status,
      v_premature_ticket_order.ticket_count;
  END IF;

  -- 2.7.d Verifica se algum pedido aponta para um lote de outro evento (orders.event_id <> ticket_batches.event_id)
  SELECT
    o.id AS order_id,
    o.order_code,
    o.event_id AS order_event_id,
    o.ticket_batch_id,
    tb.event_id AS batch_event_id
  INTO v_mismatched_event_order
  FROM public.orders o
  JOIN public.ticket_batches tb ON tb.id = o.ticket_batch_id
  WHERE o.event_id <> tb.event_id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Migração abortada por divergência referencial: o pedido % (id=%) referencia event_id=%, mas seu lote (%) pertence ao event_id=%.',
      v_mismatched_event_order.order_code,
      v_mismatched_event_order.order_id,
      v_mismatched_event_order.order_event_id,
      v_mismatched_event_order.ticket_batch_id,
      v_mismatched_event_order.batch_event_id;
  END IF;
END;
$$;

-- 2.7.e Verifica se algum lote aponta para uma categoria de outro evento (ticket_batches.event_id <> ticket_categories.event_id)
--       ou se algum ingresso aponta para categoria divergente do seu lote/evento, e cria a constraint composta estrutural.
DO $$
DECLARE
  v_mismatched_batch RECORD;
  v_mismatched_ticket RECORD;
BEGIN
  SELECT
    tb.id AS batch_id,
    tb.name AS batch_name,
    tb.event_id AS batch_event_id,
    tb.category_id,
    tc.event_id AS category_event_id
  INTO v_mismatched_batch
  FROM public.ticket_batches tb
  JOIN public.ticket_categories tc ON tc.id = tb.category_id
  WHERE tb.event_id <> tc.event_id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Migração abortada por divergência referencial em public.ticket_batches: o lote "%" (id=%) pertence ao event_id=%, mas referencia category_id=% pertencente ao event_id=%.',
      v_mismatched_batch.batch_name,
      v_mismatched_batch.batch_id,
      v_mismatched_batch.batch_event_id,
      v_mismatched_batch.category_id,
      v_mismatched_batch.category_event_id;
  END IF;

  SELECT
    t.id AS ticket_id,
    t.code AS ticket_code,
    t.event_id AS ticket_event_id,
    t.category_id AS ticket_category_id,
    tb.category_id AS batch_category_id,
    tc.event_id AS category_event_id
  INTO v_mismatched_ticket
  FROM public.tickets t
  JOIN public.ticket_batches tb ON tb.id = t.batch_id
  JOIN public.ticket_categories tc ON tc.id = t.category_id
  WHERE t.category_id <> tb.category_id
     OR t.event_id <> tc.event_id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Migração abortada por divergência referencial em public.tickets: o ingresso % (%) possui (event_id=%, category_id=%), incompatível com seu lote/categoria (batch_category_id=%, category_event_id=%).',
      v_mismatched_ticket.ticket_id,
      v_mismatched_ticket.ticket_code,
      v_mismatched_ticket.ticket_event_id,
      v_mismatched_ticket.ticket_category_id,
      v_mismatched_ticket.batch_category_id,
      v_mismatched_ticket.category_event_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_ticket_categories_id_event'
      AND conrelid = 'public.ticket_categories'::regclass
  ) THEN
    ALTER TABLE public.ticket_categories
      ADD CONSTRAINT uq_ticket_categories_id_event UNIQUE (id, event_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_ticket_batches_category_same_event'
      AND conrelid = 'public.ticket_batches'::regclass
  ) THEN
    ALTER TABLE public.ticket_batches
      ADD CONSTRAINT fk_ticket_batches_category_same_event
      FOREIGN KEY (category_id, event_id)
      REFERENCES public.ticket_categories(id, event_id)
      ON DELETE CASCADE;
  END IF;
END;
$$;

-- 2.8 Auditoria prévia dos contadores de `public.ticket_batches` (`reserved_quantity` e `sold_quantity`) vs `public.orders`
DO $$
DECLARE
  v_divergent_batch RECORD;
BEGIN
  SELECT
    tb.id AS batch_id,
    tb.name AS batch_name,
    tb.event_id,
    tb.total_quantity,
    tb.reserved_quantity AS batch_reserved,
    tb.sold_quantity AS batch_sold,
    COALESCE(SUM(o.quantity) FILTER (WHERE o.order_status IN ('reserved', 'pending_payment') AND o.payment_status IN ('pending', 'in_process')), 0) AS orders_reserved,
    COALESCE(SUM(o.quantity) FILTER (WHERE o.order_status = 'paid' AND o.payment_status = 'approved'), 0) AS orders_sold
  INTO v_divergent_batch
  FROM public.ticket_batches tb
  LEFT JOIN public.orders o ON o.ticket_batch_id = tb.id
  GROUP BY tb.id, tb.name, tb.event_id, tb.total_quantity, tb.reserved_quantity, tb.sold_quantity
  HAVING tb.reserved_quantity <> COALESCE(SUM(o.quantity) FILTER (WHERE o.order_status IN ('reserved', 'pending_payment') AND o.payment_status IN ('pending', 'in_process')), 0)
      OR tb.sold_quantity <> COALESCE(SUM(o.quantity) FILTER (WHERE o.order_status = 'paid' AND o.payment_status = 'approved'), 0)
      OR (tb.reserved_quantity + tb.sold_quantity) > tb.total_quantity
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Migração abortada por divergência nos contadores de public.ticket_batches: lote "%" (id=%, event_id=%, total=%) possui reserved_quantity=% (esperado em public.orders: %) e sold_quantity=% (esperado em public.orders: %). Audite os dados manualmente antes de ativar as restrições.',
      v_divergent_batch.batch_name,
      v_divergent_batch.batch_id,
      v_divergent_batch.event_id,
      v_divergent_batch.total_quantity,
      v_divergent_batch.batch_reserved,
      v_divergent_batch.orders_reserved,
      v_divergent_batch.batch_sold,
      v_divergent_batch.orders_sold;
  END IF;
END;
$$;

-- 2.9 Auditoria prévia dos contadores de `public.events` (`tickets_sold` e `capacity`) vs `public.ticket_batches`
DO $$
DECLARE
  v_divergent_event RECORD;
BEGIN
  SELECT
    e.id AS event_id,
    e.slug,
    e.title,
    e.capacity,
    e.tickets_sold AS event_tickets_sold,
    COALESCE(SUM(tb.sold_quantity), 0) AS batches_sold,
    COALESCE(SUM(tb.reserved_quantity), 0) AS batches_reserved
  INTO v_divergent_event
  FROM public.events e
  LEFT JOIN public.ticket_batches tb ON tb.event_id = e.id
  GROUP BY e.id, e.slug, e.title, e.capacity, e.tickets_sold
  HAVING e.tickets_sold <> COALESCE(SUM(tb.sold_quantity), 0)
      OR (COALESCE(SUM(tb.sold_quantity), 0) + COALESCE(SUM(tb.reserved_quantity), 0)) > e.capacity
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Migração abortada por divergência nos contadores de public.events: evento "%" (id=%, slug=%, capacity=%) possui tickets_sold=% (soma de sold_quantity nos lotes: %, soma de reserved_quantity nos lotes: %). Audite os registros manualmente antes de prosseguir.',
      v_divergent_event.title,
      v_divergent_event.event_id,
      v_divergent_event.slug,
      v_divergent_event.capacity,
      v_divergent_event.event_tickets_sold,
      v_divergent_event.batches_sold,
      v_divergent_event.batches_reserved;
  END IF;
END;
$$;

-- 2.10 Trigger de integridade e máquina de estados de ingressos (`public.tickets` vs `public.orders`)
CREATE OR REPLACE FUNCTION public.enforce_ticket_order_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Não é permitido excluir registros de public.tickets (ingresso % / código % / status=%). Ingressos emitidos ou reembolsados devem ser preservados para auditoria.',
      OLD.id,
      OLD.code,
      OLD.status
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.code IS DISTINCT FROM OLD.code
       OR NEW.qr_payload IS DISTINCT FROM OLD.qr_payload
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.item_sequence IS DISTINCT FROM OLD.item_sequence
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.event_id IS DISTINCT FROM OLD.event_id
       OR NEW.category_id IS DISTINCT FROM OLD.category_id
       OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
       OR NEW.holder_name IS DISTINCT FROM OLD.holder_name
       OR NEW.holder_cpf IS DISTINCT FROM OLD.holder_cpf
       OR NEW.price_paid IS DISTINCT FROM OLD.price_paid
       OR NEW.mp_payment_id IS DISTINCT FROM OLD.mp_payment_id
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION
        'Operação negada: os atributos estruturais, nominais e financeiros do ingresso (% / %) são imutáveis após a emissão.',
        OLD.id,
        OLD.code
        USING ERRCODE = '23514';
    END IF;

    -- Máquina de estados explícita para `public.tickets.status`:
    -- 1. Ingresso já utilizado (`used`) é terminal: não pode voltar para `paid` nem ser reembolsado.
    IF OLD.status = 'used' THEN
      IF NEW.status IS DISTINCT FROM 'used'
         OR NEW.used_at IS DISTINCT FROM OLD.used_at
         OR NEW.used_by_operator_id IS DISTINCT FROM OLD.used_by_operator_id
         OR NEW.checkin_device_id IS DISTINCT FROM OLD.checkin_device_id
      THEN
        RAISE EXCEPTION
          'Operação negada no ingresso %: ingresso já utilizado no check-in (status=used) possui estado terminal e não pode ser revertido ou reembolsado.',
          OLD.code
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    -- 2. Ingressos em estados terminais (`refunded`, `cancelled`, `expired`) não podem mudar de status.
    IF OLD.status IN ('refunded', 'cancelled', 'expired') THEN
      IF NEW.status IS DISTINCT FROM OLD.status
         OR NEW.used_at IS DISTINCT FROM OLD.used_at
         OR NEW.used_by_operator_id IS DISTINCT FROM OLD.used_by_operator_id
         OR NEW.checkin_device_id IS DISTINCT FROM OLD.checkin_device_id
      THEN
        RAISE EXCEPTION
          'Operação negada no ingresso %: ingresso em estado terminal (%) não pode mudar para (%).',
          OLD.code,
          OLD.status,
          NEW.status
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    -- 3. Transições permitidas a partir de `paid`:
    SELECT * INTO v_order
    FROM public.orders
    WHERE id = NEW.order_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pedido (%) referenciado pelo ingresso não existe em public.orders.', NEW.order_id
        USING ERRCODE = '23503';
    END IF;

    IF OLD.status = 'paid' AND NEW.status = 'used' THEN
      IF v_order.order_status <> 'paid' OR v_order.payment_status <> 'approved' THEN
        RAISE EXCEPTION
          'Check-in negado para o ingresso %: o pedido associado (%) não está pago e aprovado (status=%/%).',
          OLD.code,
          v_order.order_code,
          v_order.order_status,
          v_order.payment_status
          USING ERRCODE = '23514';
      END IF;

      IF NEW.used_at IS NULL OR NEW.used_by_operator_id IS NULL THEN
        RAISE EXCEPTION
          'Transição inválida para used no ingresso %: exige used_at e used_by_operator_id preenchidos.',
          OLD.code
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    ELSIF OLD.status = 'paid' AND NEW.status = 'refunded' THEN
      IF v_order.order_status <> 'refunded' OR v_order.payment_status <> 'refunded' THEN
        RAISE EXCEPTION
          'Transição inválida para refunded no ingresso %: exige que o pedido associado (%) esteja em order_status=refunded e payment_status=refunded.',
          OLD.code,
          v_order.order_code
          USING ERRCODE = '23514';
      END IF;

      IF OLD.used_at IS NOT NULL OR NEW.used_at IS NOT NULL OR NEW.used_by_operator_id IS NOT NULL THEN
        RAISE EXCEPTION
          'Operação negada no ingresso %: ingresso com registro de uso não pode ser reembolsado.',
          OLD.code
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    ELSIF OLD.status = 'paid' AND NEW.status = 'paid' THEN
      IF NEW.used_at IS NOT NULL OR NEW.used_by_operator_id IS NOT NULL THEN
        RAISE EXCEPTION
          'Inconsistência no ingresso %: status=paid não pode possuir used_at ou used_by_operator_id.',
          OLD.code
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    ELSE
      RAISE EXCEPTION
        'Transição de status inválida no ingresso %: (%) -> (%).',
        OLD.code,
        OLD.status,
        NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- TG_OP = 'INSERT'
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = NEW.order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido (%) referenciado pelo ingresso não existe em public.orders.', NEW.order_id
      USING ERRCODE = '23503';
  END IF;

  IF v_order.order_status <> 'paid' OR v_order.payment_status <> 'approved' THEN
    RAISE EXCEPTION
      'Proibido emitir ingresso para pedido não aprovado (pedido %, order_status=%, payment_status=%).',
      v_order.order_code,
      v_order.order_status,
      v_order.payment_status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status <> 'paid'
     OR NEW.used_at IS NOT NULL
     OR NEW.used_by_operator_id IS NOT NULL
     OR NEW.checkin_device_id IS NOT NULL
     OR NEW.mp_payment_id IS DISTINCT FROM v_order.mp_payment_id
  THEN
    RAISE EXCEPTION
      'Novos ingressos em public.tickets devem ser emitidos com status=paid, sem registro prévio de uso e com o mesmo mp_payment_id do pedido (%).',
      v_order.order_code
      USING ERRCODE = '23514';
  END IF;

  IF NEW.item_sequence IS NULL OR NEW.item_sequence < 1 OR NEW.item_sequence > v_order.quantity THEN
    RAISE EXCEPTION
      'item_sequence inválido (%) para o pedido % (intervalo permitido: 1..%).',
      NEW.item_sequence,
      v_order.order_code,
      v_order.quantity
      USING ERRCODE = '23514';
  END IF;

  IF NEW.user_id <> v_order.user_id
     OR NEW.event_id <> v_order.event_id
     OR NEW.batch_id <> v_order.ticket_batch_id
     OR NEW.price_paid <> v_order.unit_price
     OR NOT EXISTS (
       SELECT 1
       FROM public.ticket_batches tb
       WHERE tb.id = NEW.batch_id
         AND tb.event_id = NEW.event_id
         AND tb.category_id = NEW.category_id
     )
  THEN
    RAISE EXCEPTION
      'Divergência entre os dados do ingresso e o pedido/lote % (user_id, event_id, batch_id, category_id ou price_paid incompatíveis).',
      v_order.order_code
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tickets_enforce_order_integrity ON public.tickets;
CREATE TRIGGER trg_tickets_enforce_order_integrity
  BEFORE INSERT OR UPDATE OR DELETE ON public.tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_ticket_order_integrity();

-- 2.11 Índices de performance (reconciliação de pedidos e busca indexada case-insensitive no check-in)
--      e tabela persistente de auditoria/conciliação com reconciliação estrutural idempotente
CREATE INDEX IF NOT EXISTS idx_orders_ticket_batch_id
  ON public.orders(ticket_batch_id);

CREATE INDEX IF NOT EXISTS idx_tickets_upper_code
  ON public.tickets (upper(code));

CREATE INDEX IF NOT EXISTS idx_tickets_upper_qr_payload
  ON public.tickets (upper(qr_payload));

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_role TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL CHECK (char_length(btrim(action)) >= 3),
  entity_type TEXT NOT NULL CHECK (char_length(btrim(entity_type)) >= 2),
  entity_id TEXT NOT NULL CHECK (char_length(btrim(entity_id)) >= 1),
  event_id UUID REFERENCES public.events(id) ON DELETE SET NULL,
  order_id UUID REFERENCES public.orders(id) ON DELETE RESTRICT,
  mp_payment_id TEXT,
  idempotency_key TEXT UNIQUE,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reconciliação defensiva caso um ambiente de desenvolvimento/homologação já tenha aplicado
-- um rascunho anterior de `public.audit_logs` (onde `CREATE TABLE IF NOT EXISTS` seria no-op)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'target_entity'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'entity_type'
  ) THEN
    ALTER TABLE public.audit_logs RENAME COLUMN target_entity TO entity_type;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'metadata'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'details'
  ) THEN
    ALTER TABLE public.audit_logs RENAME COLUMN metadata TO details;
  END IF;

  ALTER TABLE public.audit_logs
    ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'order',
    ADD COLUMN IF NOT EXISTS entity_id TEXT NOT NULL DEFAULT 'legacy',
    ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES public.events(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.orders(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS mp_payment_id TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_idempotency_key_unique
  ON public.audit_logs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_order_id ON public.audit_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_id ON public.audit_logs(event_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created ON public.audit_logs(action, created_at DESC);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_admin_select ON public.audit_logs;
DROP POLICY IF EXISTS audit_logs_select_admin ON public.audit_logs;
CREATE POLICY audit_logs_select_admin
  ON public.audit_logs
  FOR SELECT
  TO authenticated
  USING (public.is_admin_or_super_admin());

REVOKE INSERT, UPDATE, DELETE ON public.audit_logs FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 3. POLÍTICA DE PEDIDOS, EVENTOS, CATEGORIAS E LOTES, ORDEM CANÔNICA DE LOCKS E INTEGRIDADE DE ESTOQUE
-- =============================================================================
-- 3.1 Remoção de policies de escrita direta em `orders`, `events`, `ticket_categories`, `ticket_batches` e `tickets`:
-- Na migration 001 existiam:
--   - `orders_insert_own_pending` e `orders_admin_update` em `public.orders`
--   - `events_admin_insert`, `events_admin_update` e `events_admin_delete` em `public.events`
--   - `ticket_categories_admin_write` (FOR ALL) em `public.ticket_categories`
--   - `ticket_batches_admin_write` (FOR ALL) em `public.ticket_batches`
--   - `tickets_admin_manage` (FOR ALL) em `public.tickets`
-- Removemos as policies de escrita direta sobre essas tabelas (preservando intactas
-- todas as policies de leitura `SELECT`: `orders_select_own_or_admin`,
-- `events_select_published_or_admin`, `ticket_categories_select_public_or_admin`,
-- `ticket_batches_select_public_or_admin` e `tickets_select_own_or_staff`) para garantir
-- que TODA escrita operacional ou administrativa passe obrigatoriamente pelas RPCs
-- transacionais com ordem canônica de bloqueios:
--   `px_event_inventory` -> `events` -> `ticket_categories` -> `ticket_batches` -> `orders` -> `tickets`
DROP POLICY IF EXISTS orders_insert_own_pending ON public.orders;
DROP POLICY IF EXISTS orders_admin_update ON public.orders;
DROP POLICY IF EXISTS events_admin_insert ON public.events;
DROP POLICY IF EXISTS events_admin_update ON public.events;
DROP POLICY IF EXISTS events_admin_delete ON public.events;
DROP POLICY IF EXISTS ticket_categories_admin_write ON public.ticket_categories;
DROP POLICY IF EXISTS ticket_batches_admin_write ON public.ticket_batches;
DROP POLICY IF EXISTS tickets_admin_manage ON public.tickets;

-- 3.2 Proteção de capacidade e estoque comprometido em `public.events`:
-- Garante:
--   a) Ordem global canônica de locks (`px_event_inventory` -> `events` -> `ticket_categories ORDER BY id ASC` -> `ticket_batches ORDER BY id ASC`);
--   b) Imutabilidade de `id` e `created_at`;
--   c) Igualdade estrita `events.tickets_sold = SUM(ticket_batches.sold_quantity)`;
--   d) Capacidade física (`events.capacity >= SUM(sold_quantity + reserved_quantity)`) SEMPRE exigida;
--   e) Ao criar/reduzir a capacidade do evento, exige `events.capacity >= SUM(total_quantity) FILTER (WHERE active) + SUM(sold_quantity + reserved_quantity) FILTER (WHERE NOT active)`.
CREATE OR REPLACE FUNCTION public.enforce_event_capacity_vs_batches()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_event public.events%ROWTYPE;
  v_total_reserved INTEGER := 0;
  v_total_sold INTEGER := 0;
  v_active_offered INTEGER := 0;
  v_inactive_committed INTEGER := 0;
  v_total_allocated INTEGER := 0;
  v_committed INTEGER := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.capacity IS NULL OR NEW.capacity <= 0 THEN
      RAISE EXCEPTION 'A capacidade do evento deve ser maior que zero (recebido: %).', NEW.capacity
        USING ERRCODE = '23514';
    END IF;

    IF NEW.tickets_sold <> 0 THEN
      RAISE EXCEPTION
        'Novos eventos devem ser criados com tickets_sold = 0 (recebido: %).',
        NEW.tickets_sold
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- 1. Lock transacional canônico do inventário do evento ANTES do ON DELETE CASCADE
    PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || OLD.id::text));

    -- 2. Lock na linha do evento pai
    PERFORM 1
    FROM public.events
    WHERE id = OLD.id
    FOR UPDATE;

    -- 3. Lock determinístico (id ASC) em todas as categorias e lotes do evento antes da propagação do cascade
    PERFORM 1
    FROM public.ticket_categories
    WHERE event_id = OLD.id
    ORDER BY id ASC
    FOR UPDATE;

    PERFORM 1
    FROM public.ticket_batches
    WHERE event_id = OLD.id
    ORDER BY id ASC
    FOR UPDATE;

    SELECT
      COALESCE(SUM(reserved_quantity), 0),
      COALESCE(SUM(sold_quantity), 0)
    INTO v_total_reserved, v_total_sold
    FROM public.ticket_batches
    WHERE event_id = OLD.id;

    IF OLD.tickets_sold > 0 OR v_total_sold > 0 OR v_total_reserved > 0
       OR EXISTS (SELECT 1 FROM public.orders WHERE event_id = OLD.id)
    THEN
      RAISE EXCEPTION
        'Não é permitido excluir o evento "%" (%) porque existem pedidos ou ingressos vendidos (%) / reservados (%). Altere o status para Rascunho ou Encerrado para preservar o histórico.',
        OLD.title,
        OLD.id,
        v_total_sold,
        v_total_reserved
        USING ERRCODE = '23514';
    END IF;

    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Operação negada: o identificador do evento (id) é imutável.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Operação negada: a data de criação do evento (created_at) é imutável.'
      USING ERRCODE = '42501';
  END IF;

  -- 1. Lock transacional canônico do inventário do evento
  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || OLD.id::text));

  -- 2. Lock exclusivo na linha do evento (e leitura da versão mais recente pós-lock em READ COMMITTED)
  SELECT * INTO v_current_event
  FROM public.events
  WHERE id = OLD.id
  FOR UPDATE;

  -- Se o comando UPDATE não alterou explicitamente `tickets_sold` (ex.: edição administrativa de
  -- capacidade, título ou status concorrente com `confirm_order_payment`), sincroniza `NEW.tickets_sold`
  -- com o valor comitado atual (`v_current_event.tickets_sold`) para evitar falso erro de snapshot pré-lock.
  IF NEW.tickets_sold = OLD.tickets_sold AND v_current_event.id IS NOT NULL THEN
    NEW.tickets_sold := v_current_event.tickets_sold;
  END IF;

  -- 3. Lock determinístico (id ASC) de todas as categorias e lotes pertencentes ao evento
  PERFORM 1
  FROM public.ticket_categories
  WHERE event_id = NEW.id
  ORDER BY id ASC
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = NEW.id
  ORDER BY id ASC
  FOR UPDATE;

  -- 4. Calcula separadamente:
  --    - reservas ativas (`v_total_reserved`)
  --    - ingressos vendidos ativos (`v_total_sold`)
  --    - oferta total dos lotes ativos (`v_active_offered`)
  --    - compromissos retidos em lotes inativos (`v_inactive_committed`)
  SELECT
    COALESCE(SUM(reserved_quantity), 0),
    COALESCE(SUM(sold_quantity), 0),
    COALESCE(SUM(total_quantity) FILTER (WHERE active), 0),
    COALESCE(SUM(sold_quantity + reserved_quantity) FILTER (WHERE NOT active), 0)
  INTO
    v_total_reserved,
    v_total_sold,
    v_active_offered,
    v_inactive_committed
  FROM public.ticket_batches
  WHERE event_id = NEW.id;

  v_total_allocated := v_active_offered + v_inactive_committed;

  -- 5. Invariante estrita de igualdade de ingressos vendidos
  IF NEW.tickets_sold <> v_total_sold THEN
    RAISE EXCEPTION
      'Inconsistência de integridade de estoque no evento (%): events.tickets_sold (%) diverge da soma de sold_quantity dos lotes (%).',
      NEW.id,
      NEW.tickets_sold,
      v_total_sold
      USING ERRCODE = '23514';
  END IF;

  v_committed := v_total_sold + v_total_reserved;

  -- 6. Capacidade física (SEMPRE exigida): nunca pode ser menor que o estoque já comprometido (vendidos + reservados)
  IF NEW.capacity < v_committed THEN
    RAISE EXCEPTION
      'A capacidade física do evento (%) não pode ser menor que o total de ingressos já vendidos e reservados (%).',
      NEW.capacity,
      v_committed
      USING ERRCODE = '23514';
  END IF;

  -- 7. Regra de oferta alocada:
  --    Impede reduzir ou definir `events.capacity` abaixo da oferta dos lotes ativos + compromissos dos inativos.
  --    Não bloqueia `confirm_order_payment` nem `refund_ticket_order` (onde `NEW.capacity = v_current_event.capacity`
  --    e apenas `tickets_sold` varia) nem alterações de status do evento caso exista uma oferta histórica aguardando ajuste.
  IF NEW.capacity < v_total_allocated
     AND (
       NEW.capacity IS DISTINCT FROM OLD.capacity
       OR (v_current_event.id IS NOT NULL AND NEW.capacity < v_current_event.capacity)
     )
  THEN
    RAISE EXCEPTION
      'A capacidade do evento (%) não pode ser menor que a soma da oferta dos lotes ativos (%) mais o estoque comprometido nos lotes inativos (%), totalizando %. Ajuste os lotes antes de reduzir a capacidade do evento.',
      NEW.capacity,
      v_active_offered,
      v_inactive_committed,
      v_total_allocated
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_events_enforce_capacity_vs_batches ON public.events;
CREATE TRIGGER trg_events_enforce_capacity_vs_batches
  BEFORE INSERT OR UPDATE OR DELETE ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_event_capacity_vs_batches();

-- 3.2.B Proteção de integridade e ordem canônica de bloqueios em `public.ticket_categories`:
-- Garante:
--   a) Ordem global canônica de locks (`px_event_inventory` -> `events` -> `ticket_categories ORDER BY id ASC` -> `ticket_batches ORDER BY id ASC`);
--   b) Imutabilidade de `id`, `event_id` e `created_at` em categorias existentes (`UPDATE`);
--   c) Proibição de desativar categoria que possua lotes ativos vinculados;
--   d) Proibição de excluir (`DELETE`) categoria que possua lotes com vendas/reservas, pedidos ou ingressos emitidos.
CREATE OR REPLACE FUNCTION public.enforce_ticket_category_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target_event_id UUID := COALESCE(OLD.event_id, NEW.event_id);
BEGIN
  IF v_target_event_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

    PERFORM 1
    FROM public.events
    WHERE id = v_target_event_id
    FOR UPDATE;

    PERFORM 1
    FROM public.ticket_categories
    WHERE event_id = v_target_event_id
    ORDER BY id ASC
    FOR UPDATE;

    PERFORM 1
    FROM public.ticket_batches
    WHERE event_id = v_target_event_id
    ORDER BY id ASC
    FOR UPDATE;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM public.ticket_batches tb
      WHERE tb.category_id = OLD.id
        AND (
          tb.sold_quantity > 0
          OR tb.reserved_quantity > 0
          OR EXISTS (SELECT 1 FROM public.orders o WHERE o.ticket_batch_id = tb.id)
        )
    ) OR EXISTS (
      SELECT 1 FROM public.tickets t WHERE t.category_id = OLD.id
    ) THEN
      RAISE EXCEPTION
        'Não é permitido excluir a categoria "%" (%) porque existem lotes com vendas, reservas, pedidos ou ingressos vinculados. Desative os lotes e a categoria (active = false) para preservar o histórico.',
        OLD.name,
        OLD.id
        USING ERRCODE = '23514';
    END IF;

    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.events WHERE id = NEW.event_id) THEN
      RAISE EXCEPTION 'Evento (%) associado à categoria não encontrado.', NEW.event_id
        USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Operação negada: o identificador da categoria (id) é imutável.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Operação negada: a data de criação da categoria (created_at) é imutável.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.event_id IS DISTINCT FROM OLD.event_id THEN
    RAISE EXCEPTION
      'Não é permitido alterar o event_id de uma categoria existente (% -> %).',
      OLD.event_id,
      NEW.event_id
      USING ERRCODE = '23514';
  END IF;

  IF OLD.active = TRUE AND NEW.active = FALSE THEN
    IF EXISTS (
      SELECT 1
      FROM public.ticket_batches tb
      WHERE tb.category_id = NEW.id
        AND tb.active = TRUE
    ) THEN
      RAISE EXCEPTION
        'Não é permitido desativar a categoria "%" (%) enquanto houver lotes ativos vinculados a ela. Desative os lotes primeiro.',
        NEW.name,
        NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_categories_enforce_integrity ON public.ticket_categories;
CREATE TRIGGER trg_ticket_categories_enforce_integrity
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.ticket_categories
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_ticket_category_integrity();

-- 3.3 Proteção de integridade em `public.ticket_batches`:
-- Garante:
--   a) Ordem global canônica de locks (`px_event_inventory` -> `events` -> `ticket_categories ORDER BY id ASC` -> `ticket_batches ORDER BY id ASC`);
--   b) Imutabilidade de `id`, `event_id` e `created_at` em lotes existentes (`UPDATE`);
--   c) Validação estrita do vínculo `category_id` -> `public.ticket_categories`: a categoria deve existir,
--      pertencer ao mesmo `event_id` do lote e estar ativa quando o lote estiver ativo (permitindo criar/editar lotes em eventos `draft` ou `published`);
--   d) Proibição de excluir (`DELETE`) lote que possua ingressos vendidos, reservados ou histórico de pedidos;
--   e) Proibição de criar (`INSERT`) lote com `reserved_quantity <> 0` ou `sold_quantity <> 0`;
--   f) Reconciliação estrita de `reserved_quantity` e `sold_quantity` contra `public.orders` quando alterados;
--   g) Capacidade física (`v_total_committed <= events.capacity`) sempre validada;
--   h) Confirmação de pagamentos, liberação de reservas, cancelamentos e reembolsos permitidos quando a
--      capacidade física e os contadores são consistentes, bloqueando qualquer criação, ativação ou ampliação de oferta inválida.
CREATE OR REPLACE FUNCTION public.enforce_batch_within_event_capacity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target_event_id UUID;
  v_event public.events%ROWTYPE;
  v_category public.ticket_categories%ROWTYPE;
  v_current_batch public.ticket_batches%ROWTYPE;
  v_other_reserved INTEGER := 0;
  v_other_sold INTEGER := 0;
  v_other_active_offered INTEGER := 0;
  v_other_inactive_committed INTEGER := 0;
  v_other_allocated INTEGER := 0;
  v_this_allocated INTEGER := 0;
  v_total_sold INTEGER := 0;
  v_total_reserved INTEGER := 0;
  v_total_committed INTEGER := 0;
  v_total_allocated INTEGER := 0;
  v_orders_reserved INTEGER := 0;
  v_orders_sold INTEGER := 0;
  v_is_counter_transition BOOLEAN := FALSE;
  v_is_remediation_reduction BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- 1. Lock transacional canônico do inventário do evento
    PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || OLD.event_id::text));

    -- 2. Lock na linha do evento pai (usa PERFORM para ser compatível com deleção em cascata de `public.events`)
    PERFORM 1
    FROM public.events
    WHERE id = OLD.event_id
    FOR UPDATE;

    -- 3. Lock determinístico (id ASC) nas categorias e lotes do evento
    PERFORM 1
    FROM public.ticket_categories
    WHERE event_id = OLD.event_id
    ORDER BY id ASC
    FOR UPDATE;

    PERFORM 1
    FROM public.ticket_batches
    WHERE event_id = OLD.event_id
    ORDER BY id ASC
    FOR UPDATE;

    IF OLD.sold_quantity > 0 OR OLD.reserved_quantity > 0
       OR EXISTS (SELECT 1 FROM public.orders WHERE ticket_batch_id = OLD.id)
    THEN
      RAISE EXCEPTION
        'Não é permitido excluir um lote que possui pedidos vinculados ou ingressos vendidos (%) / reservados (%). Desative o lote (active = false) para preservar a integridade do estoque e do histórico.',
        OLD.sold_quantity,
        OLD.reserved_quantity
        USING ERRCODE = '23514';
    END IF;

    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'Operação negada: o identificador do lote (id) é imutável.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Operação negada: a data de criação do lote (created_at) é imutável.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.event_id IS DISTINCT FROM OLD.event_id THEN
      RAISE EXCEPTION
        'Não é permitido alterar o event_id de um lote existente (% -> %).',
        OLD.event_id,
        NEW.event_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND (NEW.reserved_quantity <> 0 OR NEW.sold_quantity <> 0) THEN
    RAISE EXCEPTION
      'Novos lotes devem ser criados com reserved_quantity = 0 e sold_quantity = 0 (recebido: reserved=%, sold=%).',
      NEW.reserved_quantity,
      NEW.sold_quantity
      USING ERRCODE = '23514';
  END IF;

  v_target_event_id := NEW.event_id;

  -- 1. Lock transacional canônico do inventário do evento ANTES de bloquear linhas
  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

  -- 2. Lock exclusivo na linha do evento pai
  SELECT * INTO v_event
  FROM public.events
  WHERE id = v_target_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento associado ao lote (%) não encontrado.', v_target_event_id
      USING ERRCODE = '23503';
  END IF;

  -- 3. Lock determinístico (id ASC) nas categorias e lotes do evento
  PERFORM 1
  FROM public.ticket_categories
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  -- 3.B Valida pertencimento e status da categoria vinculada ao lote
  SELECT * INTO v_category
  FROM public.ticket_categories
  WHERE id = NEW.category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Categoria de ingresso (%) associada ao lote não encontrada.', NEW.category_id
      USING ERRCODE = '23503';
  END IF;

  IF v_category.event_id <> v_target_event_id THEN
    RAISE EXCEPTION
      'Inconsistência referencial: a categoria "%" (%) pertence ao evento (%) e não pode ser vinculada a um lote do evento (%).',
      v_category.name,
      v_category.id,
      v_category.event_id,
      v_target_event_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.active AND NOT v_category.active AND (
    TG_OP = 'INSERT'
    OR NEW.active IS DISTINCT FROM OLD.active
    OR NEW.category_id IS DISTINCT FROM OLD.category_id
  ) THEN
    RAISE EXCEPTION
      'Não é permitido criar ou ativar um lote vinculado a uma categoria inativa ("%" / %).',
      v_category.name,
      v_category.id
      USING ERRCODE = '23514';
  END IF;

  -- Em caso de UPDATE concorrente sob READ COMMITTED, lê a versão mais recente já bloqueada do lote
  -- e sincroniza contadores que não foram alvo do comando UPDATE (evitando falso erro de snapshot pré-lock).
  IF TG_OP = 'UPDATE' THEN
    SELECT * INTO v_current_batch
    FROM public.ticket_batches
    WHERE id = NEW.id
    FOR UPDATE;

    IF v_current_batch.id IS NOT NULL THEN
      IF NEW.reserved_quantity = OLD.reserved_quantity THEN
        NEW.reserved_quantity := v_current_batch.reserved_quantity;
      END IF;
      IF NEW.sold_quantity = OLD.sold_quantity THEN
        NEW.sold_quantity := v_current_batch.sold_quantity;
      END IF;
    END IF;
  END IF;

  IF NEW.total_quantity <= 0 OR NEW.reserved_quantity < 0 OR NEW.sold_quantity < 0 THEN
    RAISE EXCEPTION
      'Quantidades do lote inválidas (total=%, reserved=%, sold=%).',
      NEW.total_quantity,
      NEW.reserved_quantity,
      NEW.sold_quantity
      USING ERRCODE = '23514';
  END IF;

  IF (NEW.reserved_quantity + NEW.sold_quantity) > NEW.total_quantity THEN
    RAISE EXCEPTION
      'A quantidade total do lote (%) não pode ser menor que a soma de ingressos já vendidos (%) e reservados (%) neste lote.',
      NEW.total_quantity,
      NEW.sold_quantity,
      NEW.reserved_quantity
      USING ERRCODE = '23514';
  END IF;

  -- 4. Se os contadores de estoque (reserved_quantity ou sold_quantity) estão sendo alterados,
  --    exige reconciliação exata com os pedidos ativos (`reserved`/`pending_payment` com `pending`/`in_process`)
  --    e pagos ativos (`paid` com `approved`) em `public.orders`.
  --    Pedidos em `cancelled`, `expired` ou `refunded` não compõem `reserved_quantity` nem `sold_quantity`.
  IF TG_OP = 'UPDATE' AND (
    NEW.reserved_quantity IS DISTINCT FROM v_current_batch.reserved_quantity
    OR NEW.sold_quantity IS DISTINCT FROM v_current_batch.sold_quantity
  ) THEN
    SELECT
      COALESCE(SUM(quantity) FILTER (WHERE order_status IN ('reserved', 'pending_payment') AND payment_status IN ('pending', 'in_process')), 0),
      COALESCE(SUM(quantity) FILTER (WHERE order_status = 'paid' AND payment_status = 'approved'), 0)
    INTO v_orders_reserved, v_orders_sold
    FROM public.orders
    WHERE ticket_batch_id = NEW.id;

    IF NEW.reserved_quantity <> v_orders_reserved OR NEW.sold_quantity <> v_orders_sold THEN
      RAISE EXCEPTION
        'Violação de integridade dos contadores do lote (%): reserved_quantity (%) / sold_quantity (%) divergem dos pedidos registrados em public.orders (reserved=%, sold=%). Contadores de estoque só podem ser modificados pelas RPCs transacionais.',
        NEW.id,
        NEW.reserved_quantity,
        NEW.sold_quantity,
        v_orders_reserved,
        v_orders_sold
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- 5. Agrega separadamente os demais lotes do mesmo evento (sem contar nenhum ingresso duas vezes)
  SELECT
    COALESCE(SUM(reserved_quantity), 0),
    COALESCE(SUM(sold_quantity), 0),
    COALESCE(SUM(total_quantity) FILTER (WHERE active), 0),
    COALESCE(SUM(sold_quantity + reserved_quantity) FILTER (WHERE NOT active), 0)
  INTO
    v_other_reserved,
    v_other_sold,
    v_other_active_offered,
    v_other_inactive_committed
  FROM public.ticket_batches
  WHERE event_id = v_target_event_id
    AND (TG_OP = 'INSERT' OR id <> NEW.id);

  v_other_allocated := v_other_active_offered + v_other_inactive_committed;
  v_total_sold := v_other_sold + NEW.sold_quantity;
  v_total_reserved := v_other_reserved + NEW.reserved_quantity;
  v_total_committed := v_total_sold + v_total_reserved;

  -- Quando `sold_quantity` não está em transição (ex.: criação/edição administrativa de lote ou reserva),
  -- exige que `events.tickets_sold` esteja estritamente igual à soma de `sold_quantity` dos lotes.
  -- (Quando `sold_quantity` está em transição dentro de `confirm_order_payment` ou `refund_ticket_order`,
  -- o trigger deferred `trg_batches_reconcile_counters_deferred` garante que `events.tickets_sold`
  -- seja atualizado na mesma transação).
  IF (TG_OP = 'INSERT' OR NEW.sold_quantity = v_current_batch.sold_quantity)
     AND v_event.tickets_sold <> v_total_sold
  THEN
    RAISE EXCEPTION
      'Inconsistência de integridade de estoque no evento (%): events.tickets_sold (%) diverge da soma de sold_quantity dos lotes (%).',
      v_event.id,
      v_event.tickets_sold,
      v_total_sold
      USING ERRCODE = '23514';
  END IF;

  -- Capacidade física global do evento (SEMPRE exigida em qualquer operação)
  IF v_total_committed > v_event.capacity THEN
    RAISE EXCEPTION
      'Capacidade total do evento (%) excedida pela soma de ingressos vendidos e reservados nos lotes (%).',
      v_event.capacity,
      v_total_committed
      USING ERRCODE = '23514';
  END IF;

  v_this_allocated := CASE
    WHEN NEW.active THEN NEW.total_quantity
    ELSE NEW.sold_quantity + NEW.reserved_quantity
  END;
  v_total_allocated := v_other_allocated + v_this_allocated;

  -- 6. Diferenciação entre transição de contadores (reserva/confirmação/expiração/cancelamento/reembolso),
  --    redução corretiva de oferta e criação/ativação/ampliação de oferta em lote ativo:
  v_is_counter_transition := (
    TG_OP = 'UPDATE'
    AND (
      NEW.reserved_quantity IS DISTINCT FROM v_current_batch.reserved_quantity
      OR NEW.sold_quantity IS DISTINCT FROM v_current_batch.sold_quantity
    )
    AND NEW.total_quantity = v_current_batch.total_quantity
    AND NEW.active = v_current_batch.active
  );

  v_is_remediation_reduction := (
    TG_OP = 'UPDATE'
    AND v_current_batch.active = TRUE
    AND NEW.active = TRUE
    AND NEW.total_quantity < v_current_batch.total_quantity
    AND NEW.reserved_quantity = v_current_batch.reserved_quantity
    AND NEW.sold_quantity = v_current_batch.sold_quantity
  );

  IF NEW.active
     AND v_total_allocated > v_event.capacity
     AND NOT v_is_counter_transition
     AND NOT v_is_remediation_reduction
  THEN
    RAISE EXCEPTION
      'A soma da quantidade ofertada nos lotes ativos mais o estoque comprometido em lotes inativos (%) não pode exceder a capacidade global do evento (%).',
      v_total_allocated,
      v_event.capacity
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_batches_enforce_event_capacity ON public.ticket_batches;
CREATE TRIGGER trg_ticket_batches_enforce_event_capacity
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.ticket_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_batch_within_event_capacity();

-- 3.4 Proteção de integridade e máquina de estados explícita de `public.orders`:
-- Impede exclusão de pedidos, alterações de quantidade/lote/evento/valores após criação,
-- transições inválidas de estado e garante a ordem canônica de bloqueios (`px_event_inventory` -> `events` -> `ticket_batches`).
-- Máquina de estados permitida para `order_status` x `payment_status`:
--   - `('reserved', 'pending_payment')` com `payment_status IN ('pending', 'in_process')`
--       -> `'paid'` com `payment_status = 'approved'`, `mp_payment_id` não vazio e `paid_at IS NOT NULL`
--       -> `'expired'` com `payment_status = 'cancelled'`, `cancelled_at IS NOT NULL`, `mp_payment_id IS NULL`, `paid_at IS NULL`
--       -> `'cancelled'` com `payment_status IN ('cancelled', 'rejected')`, `cancelled_at IS NOT NULL`, `mp_payment_id IS NULL`, `paid_at IS NULL`
--   - `'paid'` com `payment_status = 'approved'`
--       -> `'refunded'` com `payment_status = 'refunded'`, preservando `mp_payment_id` e `paid_at` originais e preenchendo `cancelled_at IS NOT NULL`
--   - Estados terminais (`'expired'`, `'cancelled'`, `'refunded'`): imutáveis.
CREATE OR REPLACE FUNCTION public.enforce_orders_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target_event_id UUID := COALESCE(OLD.event_id, NEW.event_id);
  v_batch_event_id UUID;
BEGIN
  -- 1. Lock transacional canônico do inventário do evento ANTES de bloquear linhas
  IF v_target_event_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

    PERFORM 1
    FROM public.events
    WHERE id = v_target_event_id
    FOR UPDATE;

    PERFORM 1
    FROM public.ticket_batches
    WHERE event_id = v_target_event_id
    ORDER BY id ASC
    FOR UPDATE;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Não é permitido excluir registros de public.orders (pedido % / %). Utilize os fluxos transacionais para preservar o histórico e os contadores de estoque.',
      OLD.id,
      OLD.order_code
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.order_status NOT IN ('reserved', 'pending_payment')
       OR NEW.payment_status <> 'pending'
       OR NEW.mp_payment_id IS NOT NULL
       OR NEW.paid_at IS NOT NULL
       OR NEW.cancelled_at IS NOT NULL
    THEN
      RAISE EXCEPTION
        'Novos pedidos em public.orders devem iniciar com order_status IN (reserved, pending_payment), payment_status=pending e sem confirmação ou cancelamento prévio.'
        USING ERRCODE = '23514';
    END IF;

    SELECT event_id INTO v_batch_event_id
    FROM public.ticket_batches
    WHERE id = NEW.ticket_batch_id;

    IF NOT FOUND OR v_batch_event_id <> NEW.event_id THEN
      RAISE EXCEPTION
        'O lote (%) informado no pedido não pertence ao evento (%).',
        NEW.ticket_batch_id,
        NEW.event_id
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE': Imutabilidade de atributos estruturais e financeiros do pedido
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_code IS DISTINCT FROM OLD.order_code
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.ticket_batch_id IS DISTINCT FROM OLD.ticket_batch_id
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.unit_price IS DISTINCT FROM OLD.unit_price
     OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
     OR NEW.convenience_fee IS DISTINCT FROM OLD.convenience_fee
     OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Operação negada: os atributos estruturais, quantitativos e financeiros do pedido (% / %) são imutáveis.',
      OLD.id,
      OLD.order_code
      USING ERRCODE = '23514';
  END IF;

  -- Estados terminais ('expired', 'cancelled', 'refunded') são estritamente imutáveis
  IF OLD.order_status IN ('expired', 'cancelled', 'refunded') THEN
    IF NEW.order_status IS DISTINCT FROM OLD.order_status
       OR NEW.payment_status IS DISTINCT FROM OLD.payment_status
       OR NEW.mp_payment_id IS DISTINCT FROM OLD.mp_payment_id
       OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
    THEN
      RAISE EXCEPTION
        'Transição de estado inválida no pedido %: pedido em estado terminal (% / %) não pode sofrer alterações de status ou vínculo financeiro.',
        OLD.order_code,
        OLD.order_status,
        OLD.payment_status
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  -- Origem: pedido pago ('paid')
  IF OLD.order_status = 'paid' THEN
    IF NEW.order_status = 'paid' THEN
      IF NEW.payment_status IS DISTINCT FROM 'approved'
         OR NEW.mp_payment_id IS DISTINCT FROM OLD.mp_payment_id
         OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
         OR NEW.cancelled_at IS NOT NULL
      THEN
        RAISE EXCEPTION
          'Operação negada no pedido %: pedidos pagos ativos devem manter payment_status=approved, mp_payment_id e paid_at inalterados.',
          OLD.order_code
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.order_status = 'refunded' THEN
      IF OLD.payment_status <> 'approved'
         OR NEW.payment_status <> 'refunded'
         OR OLD.mp_payment_id IS NULL
         OR btrim(OLD.mp_payment_id) = ''
         OR NEW.mp_payment_id IS DISTINCT FROM OLD.mp_payment_id
         OR OLD.paid_at IS NULL
         OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
         OR NEW.cancelled_at IS NULL
      THEN
        RAISE EXCEPTION
          'Transição inválida para refunded no pedido %: exige pedido previamente paid/approved, preservação de mp_payment_id e paid_at, payment_status=refunded e cancelled_at preenchido via refund_ticket_order.',
          OLD.order_code
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION
        'Transição inválida no pedido %: um pedido pago (paid) só pode transicionar para refunded via refund_ticket_order (tentativa: % -> %).',
        OLD.order_code,
        OLD.order_status,
        NEW.order_status
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  -- Origem: reserva em aberto ('reserved' ou 'pending_payment')
  IF OLD.order_status IN ('reserved', 'pending_payment') THEN
    IF NEW.order_status IN ('reserved', 'pending_payment') THEN
      IF NEW.payment_status NOT IN ('pending', 'in_process')
         OR NEW.mp_payment_id IS NOT NULL
         OR NEW.paid_at IS NOT NULL
         OR NEW.cancelled_at IS NOT NULL
      THEN
        RAISE EXCEPTION
          'Estado inválido para reserva ativa no pedido %: exige payment_status IN (pending, in_process) e ausência de mp_payment_id, paid_at e cancelled_at.',
          OLD.order_code
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.order_status = 'paid' THEN
      IF NEW.payment_status <> 'approved'
         OR NEW.mp_payment_id IS NULL
         OR btrim(NEW.mp_payment_id) = ''
         OR NEW.paid_at IS NULL
         OR NEW.cancelled_at IS NOT NULL
      THEN
        RAISE EXCEPTION
          'Transição inválida para paid no pedido %: exige origem reserved/pending_payment, payment_status=approved, mp_payment_id e paid_at preenchidos.',
          OLD.order_code
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.order_status = 'expired' THEN
      IF NEW.payment_status <> 'cancelled'
         OR NEW.cancelled_at IS NULL
         OR NEW.mp_payment_id IS NOT NULL
         OR NEW.paid_at IS NOT NULL
      THEN
        RAISE EXCEPTION
          'Transição inválida para expired no pedido %: exige origem reserved/pending_payment, payment_status=cancelled, cancelled_at preenchido e ausência de pagamento confirmado.',
          OLD.order_code
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.order_status = 'cancelled' THEN
      IF NEW.payment_status NOT IN ('cancelled', 'rejected')
         OR NEW.cancelled_at IS NULL
         OR NEW.mp_payment_id IS NOT NULL
         OR NEW.paid_at IS NOT NULL
      THEN
        RAISE EXCEPTION
          'Transição inválida para cancelled no pedido %: exige origem reserved/pending_payment não paga, payment_status IN (cancelled, rejected) e cancelled_at preenchido via cancel_ticket_order.',
          OLD.order_code
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION
        'Transição inválida no pedido %: uma reserva não paga (%) não pode transicionar diretamente para "%".',
        OLD.order_code,
        OLD.order_status,
        NEW.order_status
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Estado de pedido desconhecido ou não suportado no pedido % (% -> %).',
    OLD.order_code,
    OLD.order_status,
    NEW.order_status
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_enforce_integrity ON public.orders;
CREATE TRIGGER trg_orders_enforce_integrity
  BEFORE INSERT OR UPDATE OR DELETE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_orders_integrity();

-- 3.5 Reconciliação transacional ao final da transação (`DEFERRABLE INITIALLY DEFERRED`):
-- Disparada por alterações em `public.orders`, `public.ticket_batches` E `public.tickets`.
-- Garante que NENHUMA transação possa fazer commit deixando:
--   - `ticket_batches.reserved_quantity` divergente da soma de pedidos `reserved`/`pending_payment` ativos;
--   - `ticket_batches.sold_quantity` divergente da soma de pedidos `paid`/`approved` (ingressos `paid` ou `used`);
--   - `events.tickets_sold` divergente da soma de `ticket_batches.sold_quantity`;
--   - um pedido `paid` sem a quantidade exata de ingressos ativos (`paid` ou `used`) em `public.tickets`;
--   - um pedido `refunded` sem a quantidade exata de ingressos preservados com `status = 'refunded'`;
--   - um pedido não pago (`reserved`, `pending_payment`, `expired`, `cancelled`) com ingressos emitidos.
CREATE OR REPLACE FUNCTION public.enforce_event_inventory_reconciliation_deferred()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_id UUID;
  v_batch_id UUID;
  v_order_id UUID;
  v_batch public.ticket_batches%ROWTYPE;
  v_event public.events%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_orders_reserved INTEGER := 0;
  v_orders_sold INTEGER := 0;
  v_batches_sold INTEGER := 0;
  v_batches_reserved INTEGER := 0;
  v_ticket_total INTEGER := 0;
  v_ticket_active INTEGER := 0;
  v_ticket_refunded INTEGER := 0;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    v_event_id := COALESCE(NEW.event_id, OLD.event_id);
    v_batch_id := COALESCE(NEW.ticket_batch_id, OLD.ticket_batch_id);
    v_order_id := COALESCE(NEW.id, OLD.id);
  ELSIF TG_TABLE_NAME = 'ticket_batches' THEN
    v_event_id := COALESCE(NEW.event_id, OLD.event_id);
    v_batch_id := COALESCE(NEW.id, OLD.id);
  ELSIF TG_TABLE_NAME = 'tickets' THEN
    v_event_id := COALESCE(NEW.event_id, OLD.event_id);
    v_batch_id := COALESCE(NEW.batch_id, OLD.batch_id);
    v_order_id := COALESCE(NEW.order_id, OLD.order_id);
  ELSE
    RETURN NULL;
  END IF;

  -- 1. Verifica o lote afetado (se ainda existir no fim da transação)
  IF v_batch_id IS NOT NULL THEN
    SELECT * INTO v_batch
    FROM public.ticket_batches
    WHERE id = v_batch_id;

    IF FOUND THEN
      SELECT
        COALESCE(SUM(quantity) FILTER (WHERE order_status IN ('reserved', 'pending_payment') AND payment_status IN ('pending', 'in_process')), 0),
        COALESCE(SUM(quantity) FILTER (WHERE order_status = 'paid' AND payment_status = 'approved'), 0)
      INTO v_orders_reserved, v_orders_sold
      FROM public.orders
      WHERE ticket_batch_id = v_batch.id;

      IF v_batch.reserved_quantity <> v_orders_reserved OR v_batch.sold_quantity <> v_orders_sold THEN
        RAISE EXCEPTION
          'Violação transacional de integridade no lote (%): ao finalizar a transação, reserved_quantity (%) / sold_quantity (%) divergem de public.orders (reserved=%, sold=%).',
          v_batch.id,
          v_batch.reserved_quantity,
          v_batch.sold_quantity,
          v_orders_reserved,
          v_orders_sold
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  -- 2. Verifica o evento afetado (se ainda existir no fim da transação)
  IF v_event_id IS NOT NULL THEN
    SELECT * INTO v_event
    FROM public.events
    WHERE id = v_event_id;

    IF FOUND THEN
      SELECT
        COALESCE(SUM(sold_quantity), 0),
        COALESCE(SUM(reserved_quantity), 0)
      INTO v_batches_sold, v_batches_reserved
      FROM public.ticket_batches
      WHERE event_id = v_event.id;

      IF v_event.tickets_sold <> v_batches_sold THEN
        RAISE EXCEPTION
          'Violação transacional de integridade no evento (%): ao finalizar a transação, events.tickets_sold (%) diverge da soma de sold_quantity dos lotes (%).',
          v_event.id,
          v_event.tickets_sold,
          v_batches_sold
          USING ERRCODE = '23514';
      END IF;

      IF (v_batches_sold + v_batches_reserved) > v_event.capacity THEN
        RAISE EXCEPTION
          'Violação transacional de capacidade no evento (%): vendidos + reservados (%) excedem events.capacity (%).',
          v_event.id,
          (v_batches_sold + v_batches_reserved),
          v_event.capacity
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  -- 3. Verifica a coerência entre o pedido afetado e seus ingressos em `public.tickets`
  IF v_order_id IS NOT NULL THEN
    SELECT * INTO v_order
    FROM public.orders
    WHERE id = v_order_id;

    IF FOUND THEN
      SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE status IN ('paid', 'used')),
        COUNT(*) FILTER (WHERE status = 'refunded')
      INTO
        v_ticket_total,
        v_ticket_active,
        v_ticket_refunded
      FROM public.tickets
      WHERE order_id = v_order.id;

      IF v_order.order_status = 'paid' THEN
        IF v_order.payment_status <> 'approved'
           OR v_ticket_total <> v_order.quantity
           OR v_ticket_active <> v_order.quantity
           OR v_ticket_refunded <> 0
        THEN
          RAISE EXCEPTION
            'Violação transacional no pedido % (%): pedido paid/approved exige exatamente % ingressos ativos (paid/used), mas possui total=%, ativos=%, refunded=%.',
            v_order.order_code,
            v_order.id,
            v_order.quantity,
            v_ticket_total,
            v_ticket_active,
            v_ticket_refunded
            USING ERRCODE = '23514';
        END IF;
      ELSIF v_order.order_status = 'refunded' THEN
        IF v_order.payment_status <> 'refunded'
           OR v_ticket_total <> v_order.quantity
           OR v_ticket_refunded <> v_order.quantity
           OR v_ticket_active <> 0
        THEN
          RAISE EXCEPTION
            'Violação transacional no pedido % (%): pedido refunded exige exatamente % ingressos preservados com status=refunded (reembolso parcial é proibido), mas possui total=%, refunded=%, ativos=%.',
            v_order.order_code,
            v_order.id,
            v_order.quantity,
            v_ticket_total,
            v_ticket_refunded,
            v_ticket_active
            USING ERRCODE = '23514';
        END IF;
      ELSE
        IF v_ticket_total <> 0 THEN
          RAISE EXCEPTION
            'Violação transacional no pedido % (%): pedido em estado "%" não pode possuir ingressos emitidos (encontrados: %).',
            v_order.order_code,
            v_order.id,
            v_order.order_status,
            v_ticket_total
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_reconcile_counters_deferred ON public.orders;
CREATE CONSTRAINT TRIGGER trg_orders_reconcile_counters_deferred
  AFTER INSERT OR UPDATE OR DELETE ON public.orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_event_inventory_reconciliation_deferred();

DROP TRIGGER IF EXISTS trg_batches_reconcile_counters_deferred ON public.ticket_batches;
CREATE CONSTRAINT TRIGGER trg_batches_reconcile_counters_deferred
  AFTER INSERT OR UPDATE OR DELETE ON public.ticket_batches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_event_inventory_reconciliation_deferred();

DROP TRIGGER IF EXISTS trg_tickets_reconcile_counters_deferred ON public.tickets;
CREATE CONSTRAINT TRIGGER trg_tickets_reconcile_counters_deferred
  AFTER INSERT OR UPDATE OR DELETE ON public.tickets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_event_inventory_reconciliation_deferred();

-- =============================================================================
-- 4. RESERVA TRANSACIONAL DE INGRESSOS (`public.reserve_ticket_order`)
-- =============================================================================
-- A migration 001 criou `public.reserve_ticket_order(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT)`
-- com primeiro parâmetro `p_batch_id` e retorno `UUID`. Nenhuma view, trigger ou policy depende
-- dela. Removemos a assinatura antiga para recriá-la com `p_ticket_batch_id` e retorno `JSONB`.
DROP FUNCTION IF EXISTS public.reserve_ticket_order(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.reserve_ticket_order(
  p_ticket_batch_id UUID,
  p_quantity INTEGER,
  p_payment_method TEXT,
  p_buyer_name TEXT,
  p_buyer_cpf TEXT,
  p_buyer_email TEXT,
  p_buyer_phone TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_target_event_id UUID;
  v_event public.events%ROWTYPE;
  v_batch public.ticket_batches%ROWTYPE;
  v_category public.ticket_categories%ROWTYPE;
  v_event_reserved_quantity INTEGER := 0;
  v_event_sold_quantity INTEGER := 0;
  v_clean_cpf TEXT := regexp_replace(COALESCE(p_buyer_cpf, ''), '\D', '', 'g');
  v_clean_name TEXT := btrim(COALESCE(p_buyer_name, ''));
  v_clean_email TEXT := btrim(COALESCE(p_buyer_email, ''));
  v_clean_phone TEXT := btrim(COALESCE(p_buyer_phone, ''));
  v_phone_digits TEXT := regexp_replace(COALESCE(p_buyer_phone, ''), '\D', '', 'g');
  v_subtotal NUMERIC(12, 2);
  v_fee NUMERIC(12, 2);
  v_total NUMERIC(12, 2);
  v_order_id UUID;
  v_order_code TEXT;
  v_expires_at TIMESTAMPTZ := NOW() + INTERVAL '30 minutes';
BEGIN
  -- Garante que os constraint triggers de reconciliação executem apenas ao final da transação,
  -- mesmo que a sessão chamadora tenha executado `SET CONSTRAINTS ALL IMMEDIATE`.
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  -- 1. Exige usuário autenticado (clientes nunca podem reservar como anon)
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória para reservar ingressos.';
  END IF;

  IF p_ticket_batch_id IS NULL THEN
    RAISE EXCEPTION 'Lote de ingresso (p_ticket_batch_id) é obrigatório.';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantidade inválida.';
  END IF;

  IF p_payment_method IS NULL OR p_payment_method NOT IN ('pix', 'credit_card') THEN
    RAISE EXCEPTION 'Método de pagamento inválido.';
  END IF;

  IF char_length(v_clean_name) < 5 OR position(' ' in v_clean_name) = 0 THEN
    RAISE EXCEPTION 'Informe o nome e sobrenome completos do comprador.';
  END IF;

  IF char_length(v_clean_cpf) <> 11 OR v_clean_cpf ~ '^(\d)\1{10}$' THEN
    RAISE EXCEPTION 'CPF do comprador inválido.';
  END IF;

  IF v_clean_email = '' OR v_clean_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'E-mail do comprador inválido.';
  END IF;

  IF char_length(v_phone_digits) < 10 OR char_length(v_phone_digits) > 11 THEN
    RAISE EXCEPTION 'Telefone do comprador inválido.';
  END IF;

  -- 2. Localiza o event_id do lote para adquirir os locks na hierarquia global canônica:
  --    pg_advisory_xact_lock(event) -> public.events (FOR UPDATE) -> public.ticket_batches (ORDER BY id ASC FOR UPDATE)
  SELECT event_id INTO v_target_event_id
  FROM public.ticket_batches
  WHERE id = p_ticket_batch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lote de ingressos indisponível ou inativo.';
  END IF;

  -- 3. Lock transacional canônico do inventário do evento + lock da linha de `public.events`
  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

  SELECT * INTO v_event
  FROM public.events
  WHERE id = v_target_event_id
  FOR UPDATE;

  IF NOT FOUND OR v_event.status <> 'published' THEN
    RAISE EXCEPTION 'Evento não está aberto para vendas.';
  END IF;

  -- 4. Lock determinístico em todos os lotes do evento (id ASC) e leitura do lote selecionado
  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = v_event.id
  ORDER BY id ASC
  FOR UPDATE;

  SELECT * INTO v_batch
  FROM public.ticket_batches
  WHERE id = p_ticket_batch_id
    AND event_id = v_event.id
  FOR UPDATE;

  IF NOT FOUND OR NOT v_batch.active THEN
    RAISE EXCEPTION 'Lote de ingressos indisponível ou inativo.';
  END IF;

  IF v_batch.starts_at IS NOT NULL AND NOW() < v_batch.starts_at THEN
    RAISE EXCEPTION 'As vendas deste lote ainda não iniciaram.';
  END IF;

  IF v_batch.ends_at IS NOT NULL AND NOW() > v_batch.ends_at THEN
    RAISE EXCEPTION 'O período de vendas deste lote já encerrou.';
  END IF;

  SELECT * INTO v_category
  FROM public.ticket_categories
  WHERE id = v_batch.category_id;

  IF NOT FOUND OR NOT v_category.active THEN
    RAISE EXCEPTION 'Categoria de ingresso inativa.';
  END IF;

  IF p_quantity > v_category.max_per_order THEN
    RAISE EXCEPTION 'Quantidade solicitada excede o limite máximo permitido por pedido (%).', v_category.max_per_order;
  END IF;

  -- 5. Verifica a integridade estrita dos contadores e a capacidade global do evento
  SELECT
    COALESCE(SUM(reserved_quantity), 0),
    COALESCE(SUM(sold_quantity), 0)
  INTO
    v_event_reserved_quantity,
    v_event_sold_quantity
  FROM public.ticket_batches
  WHERE event_id = v_event.id;

  IF v_event.tickets_sold <> v_event_sold_quantity THEN
    RAISE EXCEPTION
      'Inconsistência de integridade de estoque no evento (%): events.tickets_sold (%) diverge da soma de sold_quantity dos lotes (%).',
      v_event.id,
      v_event.tickets_sold,
      v_event_sold_quantity
      USING ERRCODE = '23514';
  END IF;

  IF (v_event.tickets_sold + v_event_reserved_quantity + p_quantity) > v_event.capacity THEN
    RAISE EXCEPTION 'Capacidade total do evento insuficiente para a quantidade solicitada.';
  END IF;

  -- 6. Verifica a disponibilidade individual do lote selecionado
  IF (v_batch.reserved_quantity + v_batch.sold_quantity + p_quantity) > v_batch.total_quantity THEN
    RAISE EXCEPTION 'Estoque insuficiente neste lote para a quantidade solicitada.';
  END IF;

  -- 7. Cálculo no servidor usando exclusivamente o preço oficial de `public.ticket_batches`
  v_subtotal := round(v_batch.price * p_quantity, 2);
  v_fee := round(v_subtotal * 0.06, 2);
  v_total := v_subtotal + v_fee;
  v_order_code := '#PX-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  -- 8. Registra o pedido vinculado a `auth.uid()` com status `reserved` e `payment_status = 'pending'`
  --    ANTES de atualizar `ticket_batches`, garantindo que o trigger de reconciliação enxergue a reserva.
  INSERT INTO public.orders (
    order_code,
    user_id,
    event_id,
    ticket_batch_id,
    quantity,
    buyer_name,
    buyer_cpf,
    buyer_email,
    buyer_phone,
    unit_price,
    subtotal,
    convenience_fee,
    total_amount,
    payment_method,
    order_status,
    payment_status,
    reservation_expires_at
  ) VALUES (
    v_order_code,
    v_user_id,
    v_event.id,
    v_batch.id,
    p_quantity,
    v_clean_name,
    v_clean_cpf,
    v_clean_email,
    v_clean_phone,
    v_batch.price,
    v_subtotal,
    v_fee,
    v_total,
    p_payment_method,
    'reserved',
    'pending',
    v_expires_at
  )
  RETURNING id INTO v_order_id;

  -- 9. Atualiza o estoque reservado no lote
  UPDATE public.ticket_batches
  SET reserved_quantity = reserved_quantity + p_quantity
  WHERE id = v_batch.id;

  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'order_code', v_order_code,
    'unit_price', v_batch.price,
    'subtotal', v_subtotal,
    'convenience_fee', v_fee,
    'total_amount', v_total,
    'order_status', 'reserved',
    'payment_status', 'pending',
    'reservation_expires_at', v_expires_at
  );
END;
$$;

-- =============================================================================
-- 5. CONFIRMAÇÃO DE PAGAMENTO E EMISSÃO DE INGRESSOS (`public.confirm_order_payment`)
-- =============================================================================
-- IMPORTANTE:
-- Esta função SQL NÃO realiza chamadas HTTP externas e NÃO é uma prova independente
-- de que um pagamento existe no Mercado Pago.
-- O backend/Edge Function confiável (usando `service_role` e `MP_ACCESS_TOKEN`) DEVE
-- obrigatoriamente consultar `GET /v1/payments/{id}` na API oficial do Mercado Pago,
-- validar a resposta autêntica do gateway e então repassar os dados verificados para
-- esta função realizar a transição transacional e emissão idempotente dos ingressos.
-- Caso o pagamento tenha sido aprovado no Mercado Pago APÓS a reserva ter expirado
-- ou sido cancelada (`order_status IN ('expired', 'cancelled')`), esta função rejeita
-- a emissão de ingressos com erro explícito e o backend/webhook DEVE invocar
-- `public.record_late_payment_incident(...)` para registrar o incidente financeiro
-- em `public.audit_logs` para estorno/conciliação operacional.

-- Remove a assinatura de 2 argumentos da migration 001 (e eventuais rascunhos intermediários)
DROP FUNCTION IF EXISTS public.confirm_order_payment(UUID, TEXT);
DROP FUNCTION IF EXISTS public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.confirm_order_payment(
  p_order_id UUID,
  p_mp_payment_id TEXT,
  p_mp_payment_status TEXT,
  p_verified_amount NUMERIC(12, 2),
  p_currency TEXT,
  p_external_reference TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_clean_payment_id TEXT := btrim(COALESCE(p_mp_payment_id, ''));
  v_clean_payment_status TEXT := lower(btrim(COALESCE(p_mp_payment_status, '')));
  v_clean_currency TEXT := upper(btrim(COALESCE(p_currency, '')));
  v_clean_ext_ref TEXT := btrim(COALESCE(p_external_reference, ''));
  v_target_event_id UUID;
  v_order public.orders%ROWTYPE;
  v_event public.events%ROWTYPE;
  v_batch public.ticket_batches%ROWTYPE;
  v_event_reserved_quantity INTEGER := 0;
  v_event_sold_quantity INTEGER := 0;
  v_other_active_reserved INTEGER := 0;
  v_conflicting_order_id UUID;
  v_existing_ticket_count INTEGER := 0;
  v_ticket_code TEXT;
  v_qr_payload TEXT;
  v_i INTEGER;
  v_code_attempt INTEGER;
  v_max_code_attempts CONSTANT INTEGER := 15;
  v_ticket_inserted BOOLEAN;
  v_constraint_name TEXT;
BEGIN
  -- Garante que os constraint triggers de reconciliação executem apenas ao final da transação
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  -- 1. Exclusivo para o backend confiável autenticado com a chave `service_role`.
  -- Não usa `current_user` pois em funções SECURITY DEFINER `current_user` é o owner da função.
  IF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Operação restrita exclusivamente ao backend oficial de pagamentos (service_role).';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Identificador do pedido (p_order_id) é obrigatório.';
  END IF;

  IF v_clean_payment_id = '' THEN
    RAISE EXCEPTION 'Identificador oficial de pagamento do Mercado Pago (p_mp_payment_id) é obrigatório.';
  END IF;

  IF v_clean_payment_status <> 'approved' THEN
    RAISE EXCEPTION 'Pagamento não aprovado na validação oficial do Mercado Pago (status recebido: "%").',
      v_clean_payment_status;
  END IF;

  -- p_verified_amount jamais pode ser NULL
  IF p_verified_amount IS NULL OR p_verified_amount <= 0 THEN
    RAISE EXCEPTION 'Valor verificado na API do Mercado Pago (p_verified_amount) é obrigatório e não pode ser nulo.';
  END IF;

  IF v_clean_currency <> 'BRL' THEN
    RAISE EXCEPTION 'Moeda do pagamento inválida ("%"). Esperado "BRL".', v_clean_currency;
  END IF;

  IF v_clean_ext_ref = '' THEN
    RAISE EXCEPTION 'Referência externa do pedido no Mercado Pago (p_external_reference) é obrigatória.';
  END IF;

  -- 2. Lock transacional por mp_payment_id para serializar chamadas concorrentes com o mesmo pagamento
  PERFORM pg_advisory_xact_lock(hashtext('px_mp_payment:' || v_clean_payment_id));

  -- 3. Leitura preliminar de `event_id` (sem lock de linha em `orders`) para adquirir
  --    os locks exatamente na hierarquia global canônica:
  --    `px_event_inventory` -> `events FOR UPDATE` -> `ticket_batches (id ASC) FOR UPDATE` -> `orders FOR UPDATE`
  SELECT event_id INTO v_target_event_id
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

  SELECT * INTO v_event
  FROM public.events
  WHERE id = v_target_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento associado ao pedido não encontrado.';
  END IF;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = v_event.id
  ORDER BY id ASC
  FOR UPDATE;

  -- 4. Lock exclusivo na linha do pedido (após `px_event_inventory`, `events` e `ticket_batches`)
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado.';
  END IF;

  IF v_order.event_id <> v_event.id THEN
    RAISE EXCEPTION 'Inconsistência de vínculo entre o pedido (%) e o evento (%).',
      v_order.id, v_event.id;
  END IF;

  -- 5. Impede que o mesmo mp_payment_id seja usado em outro pedido (protegido também pela constraint UNIQUE de orders.mp_payment_id)
  SELECT id INTO v_conflicting_order_id
  FROM public.orders
  WHERE mp_payment_id = v_clean_payment_id
    AND id <> p_order_id
  LIMIT 1;

  IF v_conflicting_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'Conflito de pagamento: o identificador "%" já pertence a outro pedido.',
      v_clean_payment_id;
  END IF;

  -- 6. Confere se o pagamento validado na API do Mercado Pago pertence a este pedido específico
  IF v_clean_ext_ref <> v_order.id::text AND v_clean_ext_ref <> v_order.order_code THEN
    RAISE EXCEPTION 'Divergência de titularidade do pagamento: external_reference ("%") não corresponde ao pedido (% / %).',
      v_clean_ext_ref, v_order.id, v_order.order_code;
  END IF;

  -- 7. Confere se o valor total pago no Mercado Pago corresponde exatamente ao total oficial do pedido
  IF round(p_verified_amount, 2) <> v_order.total_amount THEN
    RAISE EXCEPTION 'Valor pago no Mercado Pago (%) diverge do valor total oficial do pedido (%).',
      round(p_verified_amount, 2), v_order.total_amount;
  END IF;

  SELECT COUNT(*) INTO v_existing_ticket_count
  FROM public.tickets
  WHERE order_id = v_order.id;

  -- 8. Tratamento rigoroso de idempotência
  IF v_order.order_status = 'paid' THEN
    IF v_order.mp_payment_id IS DISTINCT FROM v_clean_payment_id THEN
      RAISE EXCEPTION 'Conflito de idempotência: este pedido já foi pago com outro mp_payment_id (%).',
        COALESCE(v_order.mp_payment_id, 'NULL');
    END IF;

    IF v_order.payment_status <> 'approved' THEN
      RAISE EXCEPTION 'Estado inconsistente do pedido: order_status=paid mas payment_status=%.',
        v_order.payment_status;
    END IF;

    IF v_existing_ticket_count <> v_order.quantity THEN
      RAISE EXCEPTION 'Inconsistência de integridade: pedido pago possui % ingressos, esperado %.',
        v_existing_ticket_count, v_order.quantity;
    END IF;

    -- Replay idempotente legítimo: não emite novos ingressos e não altera sold_quantity ou tickets_sold
    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'order_code', v_order.order_code,
      'mp_payment_id', v_order.mp_payment_id,
      'tickets_issued', v_existing_ticket_count,
      'idempotent_replay', true
    );
  END IF;

  IF v_order.order_status IN ('expired', 'cancelled') THEN
    RAISE EXCEPTION
      'Pagamento tardio recebido para pedido já encerrado (% / status=%). Nenhum ingresso foi emitido; registre o incidente via public.record_late_payment_incident para estorno/conciliação.',
      v_order.order_code,
      v_order.order_status
      USING ERRCODE = 'P0002';
  END IF;

  IF v_order.order_status NOT IN ('pending_payment', 'reserved') THEN
    RAISE EXCEPTION 'Pedido em estado inválido para confirmação (%).', v_order.order_status;
  END IF;

  IF v_existing_ticket_count > 0 THEN
    RAISE EXCEPTION 'Inconsistência detectada: já existem % ingressos vinculados a um pedido ainda não pago.',
      v_existing_ticket_count;
  END IF;

  SELECT * INTO v_batch
  FROM public.ticket_batches
  WHERE id = v_order.ticket_batch_id
    AND event_id = v_event.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lote associado ao pedido não encontrado.';
  END IF;

  -- 9. Valida as invariantes de estoque antes de converter a reserva em venda
  SELECT
    COALESCE(SUM(reserved_quantity), 0),
    COALESCE(SUM(sold_quantity), 0)
  INTO
    v_event_reserved_quantity,
    v_event_sold_quantity
  FROM public.ticket_batches
  WHERE event_id = v_event.id;

  IF v_event.tickets_sold <> v_event_sold_quantity THEN
    RAISE EXCEPTION
      'Inconsistência de integridade de estoque no evento (%): events.tickets_sold (%) diverge da soma de sold_quantity dos lotes (%).',
      v_event.id,
      v_event.tickets_sold,
      v_event_sold_quantity
      USING ERRCODE = '23514';
  END IF;

  IF v_batch.reserved_quantity < v_order.quantity OR v_event_reserved_quantity < v_order.quantity THEN
    RAISE EXCEPTION 'Estoque reservado insuficiente no lote (%) para confirmar % ingressos.',
      v_batch.reserved_quantity, v_order.quantity;
  END IF;

  IF (v_batch.reserved_quantity + v_batch.sold_quantity) > v_batch.total_quantity THEN
    RAISE EXCEPTION 'Inconsistência de estoque no lote: soma de reservados e vendidos (%) excede total_quantity (%).',
      (v_batch.reserved_quantity + v_batch.sold_quantity), v_batch.total_quantity;
  END IF;

  v_other_active_reserved := v_event_reserved_quantity - v_order.quantity;

  IF (v_event.tickets_sold + v_order.quantity + v_other_active_reserved) > v_event.capacity THEN
    RAISE EXCEPTION
      'Capacidade total do evento (%) excedida ao confirmar o pedido (vendidos após confirmação: %, reservas ativas de outros pedidos: %).',
      v_event.capacity,
      (v_event.tickets_sold + v_order.quantity),
      v_other_active_reserved;
  END IF;

  -- 10. Transição atômica:
  --     1º Atualiza `public.orders` para `paid`/`approved`
  --     2º Converte `reserved_quantity` em `sold_quantity` em `public.ticket_batches`
  --     3º Incrementa `tickets_sold` em `public.events`
  UPDATE public.orders
  SET
    order_status = 'paid',
    payment_status = 'approved',
    mp_payment_id = v_clean_payment_id,
    paid_at = NOW()
  WHERE id = v_order.id;

  UPDATE public.ticket_batches
  SET
    reserved_quantity = reserved_quantity - v_order.quantity,
    sold_quantity = sold_quantity + v_order.quantity
  WHERE id = v_batch.id;

  UPDATE public.events
  SET tickets_sold = tickets_sold + v_order.quantity
  WHERE id = v_order.event_id;

  -- 11. Emite exatamente `v_order.quantity` ingressos protegidos por `uq_tickets_order_item_sequence`
  --     e com retentativa controlada APENAS para as constraints em whitelist (`tickets_code_key`, `tickets_qr_payload_key`).
  FOR v_i IN 1..v_order.quantity LOOP
    v_ticket_inserted := FALSE;

    FOR v_code_attempt IN 1..v_max_code_attempts LOOP
      -- 8 caracteres hexadecimais (16^8 = 4.294.967.296 combinações possíveis)
      v_ticket_code := 'PX-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      v_qr_payload := 'PXCUSTON|' || v_ticket_code || '|' || v_order.event_id::text || '|' || v_i::text;

      BEGIN
        INSERT INTO public.tickets (
          code,
          qr_payload,
          order_id,
          item_sequence,
          user_id,
          event_id,
          category_id,
          batch_id,
          holder_name,
          holder_cpf,
          price_paid,
          status,
          mp_payment_id,
          issued_at
        ) VALUES (
          v_ticket_code,
          v_qr_payload,
          v_order.id,
          v_i,
          v_order.user_id,
          v_order.event_id,
          v_batch.category_id,
          v_batch.id,
          v_order.buyer_name,
          v_order.buyer_cpf,
          v_order.unit_price,
          'paid',
          v_clean_payment_id,
          NOW()
        );

        v_ticket_inserted := TRUE;
        EXIT;
      EXCEPTION
        WHEN unique_violation THEN
          GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
          -- Lista explícita de permissão (whitelist): apenas colisões de código ou QR Code
          -- (`tickets_code_key`, `tickets_qr_payload_key`) são tratadas como recuperáveis.
          -- Qualquer outra constraint única (como `uq_tickets_order_item_sequence` ou `tickets_pkey`)
          -- é propagada imediatamente sem mascaramento.
          IF COALESCE(v_constraint_name, '') NOT IN ('tickets_code_key', 'tickets_qr_payload_key') THEN
            RAISE;
          END IF;
      END;
    END LOOP;

    IF NOT v_ticket_inserted THEN
      RAISE EXCEPTION
        'Não foi possível gerar um código único para o ingresso % de % do pedido % após % tentativas. Transação revertida com segurança.',
        v_i,
        v_order.quantity,
        v_order.order_code,
        v_max_code_attempts
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'order_id', v_order.id,
    'order_code', v_order.order_code,
    'mp_payment_id', v_clean_payment_id,
    'tickets_issued', v_order.quantity,
    'idempotent_replay', false
  );
END;
$$;

-- =============================================================================
-- 6. LIBERAÇÃO DE RESERVAS EXPIRADAS (`public.release_expired_reservations`)
-- =============================================================================
DROP FUNCTION IF EXISTS public.release_expired_reservations();

CREATE OR REPLACE FUNCTION public.release_expired_reservations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_rec RECORD;
  v_locked_order public.orders%ROWTYPE;
  v_event public.events%ROWTYPE;
  v_batch public.ticket_batches%ROWTYPE;
  v_released_count INTEGER := 0;
BEGIN
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  -- Autorização sem uso de `current_user`:
  -- 1. Backend confiável via `service_role`
  -- 2. Administrador autenticado (`admin` / `SUPER_ADMIN` via `public.is_admin_or_super_admin()`)
  -- 3. Contexto administrativo direto do banco (ex.: Supabase SQL Editor com `session_user`
  --    em `postgres`/`supabase_admin`, sem JWT PostgREST e com `auth.uid() IS NULL`)
  IF v_jwt_role <> 'service_role'
     AND NOT public.is_admin_or_super_admin()
     AND NOT (v_jwt_role = '' AND auth.uid() IS NULL AND session_user IN ('postgres', 'supabase_admin'))
  THEN
    RAISE EXCEPTION 'Operação não autorizada: apenas o backend (service_role), administradores autenticados ou sessão administrativa direta do banco podem liberar reservas expiradas.';
  END IF;

  -- Seleciona candidatos expirados ordenados por (event_id ASC, ticket_batch_id ASC, id ASC)
  -- SEM bloquear `orders` antes de `px_event_inventory`. Dentro do laço, adquire os locks
  -- estritamente na hierarquia global canônica:
  -- `px_event_inventory` -> `events FOR UPDATE` -> `ticket_batches (id ASC) FOR UPDATE` -> `orders FOR UPDATE SKIP LOCKED`
  FOR v_rec IN
    SELECT id, event_id, ticket_batch_id
    FROM public.orders
    WHERE order_status IN ('pending_payment', 'reserved')
      AND payment_status IN ('pending', 'in_process')
      AND reservation_expires_at IS NOT NULL
      AND reservation_expires_at < NOW()
    ORDER BY event_id ASC, ticket_batch_id ASC, id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_rec.event_id::text));

    SELECT * INTO v_event
    FROM public.events
    WHERE id = v_rec.event_id
    FOR UPDATE;

    PERFORM 1
    FROM public.ticket_batches
    WHERE event_id = v_rec.event_id
    ORDER BY id ASC
    FOR UPDATE;

    v_locked_order := NULL;

    SELECT * INTO v_locked_order
    FROM public.orders
    WHERE id = v_rec.id
    FOR UPDATE SKIP LOCKED;

    -- Revalida o estado e a expiração após adquirir os locks na ordem canônica
    IF v_locked_order.id IS NOT NULL
       AND v_locked_order.order_status IN ('pending_payment', 'reserved')
       AND v_locked_order.payment_status IN ('pending', 'in_process')
       AND v_locked_order.reservation_expires_at IS NOT NULL
       AND v_locked_order.reservation_expires_at < NOW()
    THEN
      SELECT * INTO v_batch
      FROM public.ticket_batches
      WHERE id = v_locked_order.ticket_batch_id
        AND event_id = v_locked_order.event_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'Lote (%) associado à reserva expirada (%) não encontrado.',
          v_locked_order.ticket_batch_id,
          v_locked_order.id
          USING ERRCODE = '23503';
      END IF;

      IF v_batch.reserved_quantity < v_locked_order.quantity THEN
        RAISE EXCEPTION
          'Inconsistência de integridade ao expirar reserva (%): reserved_quantity do lote (%) é %, menor que a quantidade do pedido (%).',
          v_locked_order.id,
          v_batch.id,
          v_batch.reserved_quantity,
          v_locked_order.quantity
          USING ERRCODE = '23514';
      END IF;

      -- 1º Atualiza o pedido para `expired`/`cancelled` antes de decrementar o lote
      UPDATE public.orders
      SET
        order_status = 'expired',
        payment_status = 'cancelled',
        cancelled_at = NOW()
      WHERE id = v_locked_order.id;

      -- 2º Decrementa exatamente `v_locked_order.quantity` (já validado que `reserved_quantity >= v_locked_order.quantity`)
      UPDATE public.ticket_batches
      SET reserved_quantity = reserved_quantity - v_locked_order.quantity
      WHERE id = v_batch.id;

      v_released_count := v_released_count + 1;
    END IF;
  END LOOP;

  RETURN v_released_count;
END;
$$;

-- =============================================================================
-- 6.B CANCELAMENTO DE RESERVA NÃO PAGA (`public.cancel_ticket_order`)
--     E REEMBOLSO INTEGRAL DE PEDIDO PAGO (`public.refund_ticket_order`)
--     E REGISTRO DE PAGAMENTO TARDIO (`public.record_late_payment_incident`)
-- =============================================================================

-- 6.B.1 `public.cancel_ticket_order`:
-- Cancela transacionalmente um pedido ainda não pago (`reserved` ou `pending_payment`),
-- liberando `reserved_quantity` no lote correspondente e preservando o pedido no histórico.
DROP FUNCTION IF EXISTS public.cancel_ticket_order(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.cancel_ticket_order(
  p_order_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_is_direct_db_admin BOOLEAN := (
    v_jwt_role = '' AND v_caller_id IS NULL AND session_user IN ('postgres', 'supabase_admin')
  );
  v_target_event_id UUID;
  v_event public.events%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_batch public.ticket_batches%ROWTYPE;
  v_ticket_count INTEGER := 0;
  v_clean_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Identificador do pedido (p_order_id) é obrigatório.';
  END IF;

  SELECT event_id INTO v_target_event_id
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado.';
  END IF;

  -- Ordem global canônica de bloqueios:
  -- 1º `px_event_inventory` -> 2º `events FOR UPDATE` -> 3º `ticket_batches (id ASC) FOR UPDATE` -> 4º `orders FOR UPDATE`
  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

  SELECT * INTO v_event
  FROM public.events
  WHERE id = v_target_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento associado ao pedido não encontrado.';
  END IF;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = v_event.id
  ORDER BY id ASC
  FOR UPDATE;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado.';
  END IF;

  -- Autorização: comprador titular do pedido, administrador autenticado, `service_role` ou sessão administrativa direta do banco
  IF v_jwt_role <> 'service_role'
     AND NOT v_is_direct_db_admin
     AND NOT public.is_admin_or_super_admin()
     AND (v_caller_id IS NULL OR v_caller_id <> v_order.user_id)
  THEN
    RAISE EXCEPTION 'Acesso negado: apenas o titular do pedido, um administrador ou o backend oficial podem cancelar esta reserva.';
  END IF;

  -- Replay idempotente se o pedido já estiver cancelado
  IF v_order.order_status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'order_code', v_order.order_code,
      'order_status', v_order.order_status,
      'payment_status', v_order.payment_status,
      'released_quantity', v_order.quantity,
      'idempotent_replay', true
    );
  END IF;

  IF v_order.order_status = 'paid' THEN
    RAISE EXCEPTION 'Não é possível cancelar diretamente um pedido já pago (%). Utilize o fluxo transacional de reembolso (public.refund_ticket_order).',
      v_order.order_code;
  END IF;

  IF v_order.order_status NOT IN ('reserved', 'pending_payment') THEN
    RAISE EXCEPTION 'Pedido (%) em estado "%" não pode ser cancelado.',
      v_order.order_code, v_order.order_status;
  END IF;

  SELECT COUNT(*) INTO v_ticket_count
  FROM public.tickets
  WHERE order_id = v_order.id;

  IF v_ticket_count > 0 THEN
    RAISE EXCEPTION 'Inconsistência de integridade: reserva não paga (%) possui % ingressos vinculados.',
      v_order.order_code, v_ticket_count
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_batch
  FROM public.ticket_batches
  WHERE id = v_order.ticket_batch_id
    AND event_id = v_event.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lote associado ao pedido não encontrado.';
  END IF;

  IF v_batch.reserved_quantity < v_order.quantity THEN
    RAISE EXCEPTION
      'Inconsistência de estoque ao cancelar pedido (%): reserved_quantity do lote (%) é %, menor que a quantidade do pedido (%).',
      v_order.order_code, v_batch.id, v_batch.reserved_quantity, v_order.quantity
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.orders
  SET
    order_status = 'cancelled',
    payment_status = 'cancelled',
    cancelled_at = NOW()
  WHERE id = v_order.id;

  UPDATE public.ticket_batches
  SET reserved_quantity = reserved_quantity - v_order.quantity
  WHERE id = v_batch.id;

  INSERT INTO public.audit_logs (
    actor_id,
    actor_role,
    action,
    entity_type,
    entity_id,
    event_id,
    order_id,
    idempotency_key,
    details
  ) VALUES (
    v_caller_id,
    CASE
      WHEN v_jwt_role = 'service_role' THEN 'service_role'
      WHEN v_is_direct_db_admin THEN session_user
      WHEN public.is_admin_or_super_admin() THEN 'admin'
      ELSE 'customer'
    END,
    'order_cancelled',
    'order',
    v_order.id::text,
    v_order.event_id,
    v_order.id,
    'order_cancelled:' || v_order.id::text,
    jsonb_build_object(
      'order_code', v_order.order_code,
      'ticket_batch_id', v_order.ticket_batch_id,
      'released_quantity', v_order.quantity,
      'reason', v_clean_reason
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'order_id', v_order.id,
    'order_code', v_order.order_code,
    'order_status', 'cancelled',
    'payment_status', 'cancelled',
    'released_quantity', v_order.quantity,
    'idempotent_replay', false
  );
END;
$$;

-- 6.B.2 `public.refund_ticket_order`:
-- Realiza o reembolso integral e atômico de um pedido pago (`order_status = 'paid'`),
-- bloqueando reembolso parcial ou reembolso de pedidos com ingresso já utilizado (`status = 'used'`),
-- transicionando todos os ingressos do pedido de `paid` para `refunded` (sem jamais deletá-los)
-- e decrementando `ticket_batches.sold_quantity` e `events.tickets_sold`.
DROP FUNCTION IF EXISTS public.refund_ticket_order(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.refund_ticket_order(
  p_order_id UUID,
  p_mp_payment_id TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_is_direct_db_admin BOOLEAN := (
    v_jwt_role = '' AND v_caller_id IS NULL AND session_user IN ('postgres', 'supabase_admin')
  );
  v_clean_payment_id TEXT := btrim(COALESCE(p_mp_payment_id, ''));
  v_clean_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_target_event_id UUID;
  v_event public.events%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_batch public.ticket_batches%ROWTYPE;
  v_total_tickets INTEGER := 0;
  v_paid_tickets INTEGER := 0;
  v_used_tickets INTEGER := 0;
  v_refunded_tickets INTEGER := 0;
BEGIN
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  -- Autorização: exclusivo para `service_role`, administrador autenticado (`admin`/`SUPER_ADMIN`)
  -- ou sessão administrativa direta do banco. Clientes comuns jamais podem acionar estorno.
  IF v_jwt_role <> 'service_role'
     AND NOT public.is_admin_or_super_admin()
     AND NOT v_is_direct_db_admin
  THEN
    RAISE EXCEPTION 'Operação não autorizada: apenas o backend de pagamentos (service_role) ou administradores autorizados podem registrar reembolso de pedidos.';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Identificador do pedido (p_order_id) é obrigatório.';
  END IF;

  IF v_clean_payment_id = '' THEN
    RAISE EXCEPTION 'Identificador oficial do pagamento no Mercado Pago (p_mp_payment_id) é obrigatório para validar o reembolso.';
  END IF;

  -- Serializa operações concorrentes sobre o mesmo pagamento
  PERFORM pg_advisory_xact_lock(hashtext('px_mp_payment:' || v_clean_payment_id));

  SELECT event_id INTO v_target_event_id
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado.';
  END IF;

  -- Ordem global canônica de bloqueios:
  -- 1º `px_event_inventory` -> 2º `events FOR UPDATE` -> 3º `ticket_batches (id ASC) FOR UPDATE`
  -- -> 4º `orders FOR UPDATE` -> 5º `tickets (item_sequence ASC) FOR UPDATE`
  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

  SELECT * INTO v_event
  FROM public.events
  WHERE id = v_target_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento associado ao pedido não encontrado.';
  END IF;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = v_event.id
  ORDER BY id ASC
  FOR UPDATE;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado.';
  END IF;

  PERFORM 1
  FROM public.tickets
  WHERE order_id = v_order.id
  ORDER BY item_sequence ASC
  FOR UPDATE;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'paid'),
    COUNT(*) FILTER (WHERE status = 'used'),
    COUNT(*) FILTER (WHERE status = 'refunded')
  INTO
    v_total_tickets,
    v_paid_tickets,
    v_used_tickets,
    v_refunded_tickets
  FROM public.tickets
  WHERE order_id = v_order.id;

  -- Replay idempotente se o pedido já estiver reembolsado com o mesmo mp_payment_id
  IF v_order.order_status = 'refunded' THEN
    IF v_order.mp_payment_id IS DISTINCT FROM v_clean_payment_id THEN
      RAISE EXCEPTION 'Conflito no reembolso: o mp_payment_id informado ("%") diverge do pagamento vinculado ao pedido ("%").',
        v_clean_payment_id, COALESCE(v_order.mp_payment_id, 'NULL');
    END IF;

    IF v_order.payment_status <> 'refunded'
       OR v_total_tickets <> v_order.quantity
       OR v_refunded_tickets <> v_order.quantity
    THEN
      RAISE EXCEPTION 'Inconsistência de integridade em pedido já reembolsado (%): total_tickets=%, refunded_tickets=%, esperado=%.',
        v_order.order_code, v_total_tickets, v_refunded_tickets, v_order.quantity
        USING ERRCODE = '23514';
    END IF;

    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'order_code', v_order.order_code,
      'mp_payment_id', v_order.mp_payment_id,
      'order_status', 'refunded',
      'payment_status', 'refunded',
      'tickets_refunded', v_refunded_tickets,
      'idempotent_replay', true
    );
  END IF;

  IF v_order.order_status <> 'paid' OR v_order.payment_status <> 'approved' THEN
    RAISE EXCEPTION 'Apenas pedidos com pagamento confirmado (order_status=paid, payment_status=approved) podem ser reembolsados (estado atual: % / %).',
      v_order.order_status, v_order.payment_status;
  END IF;

  IF v_order.mp_payment_id IS DISTINCT FROM v_clean_payment_id THEN
    RAISE EXCEPTION 'Divergência de pagamento: o mp_payment_id informado ("%") não corresponde ao pagamento oficial do pedido ("%").',
      v_clean_payment_id, COALESCE(v_order.mp_payment_id, 'NULL');
  END IF;

  IF v_used_tickets > 0 THEN
    RAISE EXCEPTION 'Reembolso bloqueado no pedido %: % de % ingresso(s) já tiveram check-in realizado na portaria (status=used).',
      v_order.order_code, v_used_tickets, v_order.quantity
      USING ERRCODE = '23514';
  END IF;

  IF v_total_tickets <> v_order.quantity OR v_paid_tickets <> v_order.quantity THEN
    RAISE EXCEPTION 'Inconsistência de integridade no pedido %: esperado % ingressos com status=paid para reembolso integral, encontrado total=% e paid=%.',
      v_order.order_code, v_order.quantity, v_total_tickets, v_paid_tickets
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_batch
  FROM public.ticket_batches
  WHERE id = v_order.ticket_batch_id
    AND event_id = v_event.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lote associado ao pedido não encontrado.';
  END IF;

  IF v_batch.sold_quantity < v_order.quantity OR v_event.tickets_sold < v_order.quantity THEN
    RAISE EXCEPTION
      'Inconsistência de estoque ao reembolsar pedido (%): sold_quantity do lote (%) ou tickets_sold do evento (%) é menor que a quantidade do pedido (%).',
      v_order.order_code, v_batch.sold_quantity, v_event.tickets_sold, v_order.quantity
      USING ERRCODE = '23514';
  END IF;

  -- Transição atômica:
  -- 1º Atualiza `public.orders` para `refunded`/`refunded`
  -- 2º Atualiza todos os `v_order.quantity` ingressos para `status = 'refunded'` (preservando os registros)
  -- 3º Decrementa `sold_quantity` em `public.ticket_batches`
  -- 4º Decrementa `tickets_sold` em `public.events`
  UPDATE public.orders
  SET
    order_status = 'refunded',
    payment_status = 'refunded',
    cancelled_at = NOW()
  WHERE id = v_order.id;

  UPDATE public.tickets
  SET status = 'refunded'
  WHERE order_id = v_order.id;

  UPDATE public.ticket_batches
  SET sold_quantity = sold_quantity - v_order.quantity
  WHERE id = v_batch.id;

  UPDATE public.events
  SET tickets_sold = tickets_sold - v_order.quantity
  WHERE id = v_event.id;

  INSERT INTO public.audit_logs (
    actor_id,
    actor_role,
    action,
    entity_type,
    entity_id,
    event_id,
    order_id,
    mp_payment_id,
    idempotency_key,
    details
  ) VALUES (
    v_caller_id,
    CASE
      WHEN v_jwt_role = 'service_role' THEN 'service_role'
      WHEN v_is_direct_db_admin THEN session_user
      ELSE 'admin'
    END,
    'order_refunded',
    'order',
    v_order.id::text,
    v_order.event_id,
    v_order.id,
    v_clean_payment_id,
    'order_refunded:' || v_order.id::text || ':' || v_clean_payment_id,
    jsonb_build_object(
      'order_code', v_order.order_code,
      'ticket_batch_id', v_order.ticket_batch_id,
      'tickets_refunded', v_order.quantity,
      'refunded_amount', v_order.total_amount,
      'reason', v_clean_reason
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'order_id', v_order.id,
    'order_code', v_order.order_code,
    'mp_payment_id', v_clean_payment_id,
    'order_status', 'refunded',
    'payment_status', 'refunded',
    'tickets_refunded', v_order.quantity,
    'idempotent_replay', false
  );
END;
$$;

-- 6.B.3 `public.record_late_payment_incident`:
-- Registra de forma idempotente e auditável um incidente financeiro quando o Mercado Pago
-- aprova um pagamento cujo pedido local já expirou ou foi cancelado (`expired` / `cancelled`).
-- NUNCA emite ingressos e NUNCA reabre reservas sem estoque, preservando o rastro completo
-- em `public.audit_logs` para estorno automático ou conciliação operacional.
DROP FUNCTION IF EXISTS public.record_late_payment_incident(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.record_late_payment_incident(
  p_order_id UUID,
  p_mp_payment_id TEXT,
  p_mp_payment_status TEXT,
  p_verified_amount NUMERIC(12, 2),
  p_currency TEXT,
  p_external_reference TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_clean_payment_id TEXT := btrim(COALESCE(p_mp_payment_id, ''));
  v_clean_payment_status TEXT := lower(btrim(COALESCE(p_mp_payment_status, '')));
  v_clean_currency TEXT := upper(btrim(COALESCE(p_currency, '')));
  v_clean_ext_ref TEXT := btrim(COALESCE(p_external_reference, ''));
  v_clean_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_target_event_id UUID;
  v_order public.orders%ROWTYPE;
  v_existing_ticket_count INTEGER := 0;
  v_idempotency_key TEXT;
  v_audit_id UUID;
  v_idempotent_replay BOOLEAN := FALSE;
BEGIN
  IF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Operação restrita exclusivamente ao backend oficial de pagamentos (service_role).';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Identificador do pedido (p_order_id) é obrigatório.';
  END IF;

  IF v_clean_payment_id = '' THEN
    RAISE EXCEPTION 'Identificador oficial de pagamento do Mercado Pago (p_mp_payment_id) é obrigatório.';
  END IF;

  IF v_clean_payment_status <> 'approved' THEN
    RAISE EXCEPTION 'Apenas pagamentos com status "approved" no Mercado Pago devem ser registrados como incidente de pagamento tardio (recebido: "%").',
      v_clean_payment_status;
  END IF;

  IF p_verified_amount IS NULL OR p_verified_amount <= 0 THEN
    RAISE EXCEPTION 'Valor verificado na API do Mercado Pago (p_verified_amount) é obrigatório e deve ser positivo.';
  END IF;

  IF v_clean_currency <> 'BRL' THEN
    RAISE EXCEPTION 'Moeda do pagamento inválida ("%"). Esperado "BRL".', v_clean_currency;
  END IF;

  IF v_clean_ext_ref = '' THEN
    RAISE EXCEPTION 'Referência externa do pedido no Mercado Pago (p_external_reference) é obrigatória.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('px_mp_payment:' || v_clean_payment_id));

  SELECT event_id INTO v_target_event_id
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

  PERFORM 1
  FROM public.events
  WHERE id = v_target_event_id
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_clean_ext_ref <> v_order.id::text AND v_clean_ext_ref <> v_order.order_code THEN
    RAISE EXCEPTION 'Divergência de titularidade do pagamento: external_reference ("%") não corresponde ao pedido (% / %).',
      v_clean_ext_ref, v_order.id, v_order.order_code;
  END IF;

  IF v_order.order_status IN ('reserved', 'pending_payment') THEN
    RAISE EXCEPTION 'O pedido (%) ainda está com reserva ativa (%). Utilize public.confirm_order_payment para confirmar o pagamento.',
      v_order.order_code, v_order.order_status;
  END IF;

  IF v_order.order_status NOT IN ('expired', 'cancelled') THEN
    RAISE EXCEPTION 'O pedido (%) está em estado "%" e não caracteriza incidente de pagamento após expiração/cancelamento.',
      v_order.order_code, v_order.order_status;
  END IF;

  SELECT COUNT(*) INTO v_existing_ticket_count
  FROM public.tickets
  WHERE order_id = v_order.id;

  IF v_existing_ticket_count <> 0 THEN
    RAISE EXCEPTION 'Inconsistência grave: pedido % em estado % possui % ingressos emitidos.',
      v_order.order_code, v_order.order_status, v_existing_ticket_count
      USING ERRCODE = '23514';
  END IF;

  v_idempotency_key := 'late_payment:' || v_order.id::text || ':' || v_clean_payment_id;

  INSERT INTO public.audit_logs (
    actor_id,
    actor_role,
    action,
    entity_type,
    entity_id,
    event_id,
    order_id,
    mp_payment_id,
    idempotency_key,
    details
  ) VALUES (
    NULL,
    'service_role',
    'late_payment_after_expiration',
    'order',
    v_order.id::text,
    v_order.event_id,
    v_order.id,
    v_clean_payment_id,
    v_idempotency_key,
    jsonb_build_object(
      'order_code', v_order.order_code,
      'order_status_at_webhook', v_order.order_status,
      'payment_status_at_webhook', v_order.payment_status,
      'mp_payment_id', v_clean_payment_id,
      'mp_payment_status', v_clean_payment_status,
      'verified_amount', round(p_verified_amount, 2),
      'order_total_amount', v_order.total_amount,
      'currency', v_clean_currency,
      'external_reference', v_clean_ext_ref,
      'tickets_issued', 0,
      'requires_refund', true,
      'reason', COALESCE(v_clean_reason, 'Pagamento aprovado no Mercado Pago após expiração/cancelamento da reserva.')
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_audit_id;

  IF v_audit_id IS NULL THEN
    SELECT id INTO v_audit_id
    FROM public.audit_logs
    WHERE idempotency_key = v_idempotency_key;
    v_idempotent_replay := TRUE;
  END IF;

  RETURN jsonb_build_object(
    'incident_recorded', true,
    'audit_log_id', v_audit_id,
    'order_id', v_order.id,
    'order_code', v_order.order_code,
    'order_status', v_order.order_status,
    'mp_payment_id', v_clean_payment_id,
    'verified_amount', round(p_verified_amount, 2),
    'tickets_issued', 0,
    'requires_refund', true,
    'idempotent_replay', v_idempotent_replay
  );
END;
$$;

-- =============================================================================
-- 6.C OPERAÇÕES ADMINISTRATIVAS TRANSACIONAIS COM ORDEM CANÔNICA DE LOCKS
--     (Eliminação estrutural do deadlock de ModifyTable em `events`, `ticket_categories` e `ticket_batches`)
-- =============================================================================

-- 6.C.0 `public.admin_create_event`:
-- Cria transacionalmente um novo evento em `public.events` validando autorização
-- administrativa (`admin` / `SUPER_ADMIN` / `service_role`), formato e validade
-- real de `p_event_date` (`YYYY-MM-DD` -> `DATE`) e adquirindo o advisory lock
-- `px_event_inventory` antes do `INSERT`.
DROP FUNCTION IF EXISTS public.admin_create_event(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT[], TEXT, TEXT[], TEXT, BOOLEAN, INTEGER);

CREATE OR REPLACE FUNCTION public.admin_create_event(
  p_slug TEXT,
  p_title TEXT,
  p_subtitle TEXT,
  p_category_slug TEXT,
  p_category_name TEXT,
  p_event_date TEXT,
  p_time_range TEXT,
  p_city TEXT,
  p_venue_name TEXT,
  p_starting_price NUMERIC(12, 2),
  p_banner_url TEXT,
  p_card_image_url TEXT,
  p_gallery_urls TEXT[],
  p_description TEXT,
  p_highlights TEXT[],
  p_status TEXT,
  p_featured BOOLEAN,
  p_capacity INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_is_direct_db_admin BOOLEAN := (
    v_jwt_role = '' AND v_caller_id IS NULL AND session_user IN ('postgres', 'supabase_admin')
  );
  v_clean_date TEXT := btrim(COALESCE(p_event_date, ''));
  v_parsed_event_date DATE;
  v_new_event_id UUID := gen_random_uuid();
  v_created public.events%ROWTYPE;
BEGIN
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  IF v_jwt_role <> 'service_role'
     AND NOT public.is_admin_or_super_admin()
     AND NOT v_is_direct_db_admin
  THEN
    RAISE EXCEPTION 'Acesso negado: apenas administradores autorizados podem criar eventos.'
      USING ERRCODE = '42501';
  END IF;

  IF v_clean_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'Data do evento inválida ("%"). Utilize o formato ISO YYYY-MM-DD.', COALESCE(p_event_date, 'NULL')
      USING ERRCODE = '22007';
  END IF;

  BEGIN
    v_parsed_event_date := v_clean_date::DATE;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'Data do evento inválida ("%"). Informe uma data real no formato YYYY-MM-DD.', COALESCE(p_event_date, 'NULL')
        USING ERRCODE = '22007';
  END;

  IF to_char(v_parsed_event_date, 'YYYY-MM-DD') <> v_clean_date THEN
    RAISE EXCEPTION 'Data de calendário inexistente ("%").', v_clean_date
      USING ERRCODE = '22008';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_new_event_id::text));

  INSERT INTO public.events (
    id,
    slug,
    title,
    subtitle,
    category_slug,
    category_name,
    event_date,
    time_range,
    city,
    venue_name,
    starting_price,
    banner_url,
    card_image_url,
    gallery_urls,
    description,
    highlights,
    status,
    featured,
    capacity,
    tickets_sold,
    created_by
  ) VALUES (
    v_new_event_id,
    btrim(COALESCE(p_slug, '')),
    btrim(COALESCE(p_title, '')),
    NULLIF(btrim(COALESCE(p_subtitle, '')), ''),
    btrim(COALESCE(p_category_slug, '')),
    btrim(COALESCE(p_category_name, '')),
    v_parsed_event_date,
    btrim(COALESCE(p_time_range, '')),
    btrim(COALESCE(p_city, '')),
    btrim(COALESCE(p_venue_name, '')),
    p_starting_price,
    btrim(COALESCE(p_banner_url, '')),
    btrim(COALESCE(p_card_image_url, '')),
    COALESCE(p_gallery_urls, '{}'::TEXT[]),
    btrim(COALESCE(p_description, '')),
    COALESCE(p_highlights, '{}'::TEXT[]),
    btrim(COALESCE(p_status, 'draft')),
    COALESCE(p_featured, false),
    p_capacity,
    0,
    v_caller_id
  )
  RETURNING * INTO v_created;

  RETURN to_jsonb(v_created);
END;
$$;

-- 6.C.1 `public.admin_update_event`:
-- Valida `p_event_date` (`TEXT` no formato `YYYY-MM-DD` -> `DATE` para a coluna `public.events.event_date`)
-- ANTES de qualquer mutação, e adquire `px_event_inventory` -> `events FOR UPDATE` -> `ticket_categories (id ASC) FOR UPDATE`
-- -> `ticket_batches (id ASC) FOR UPDATE` ANTES de executar o `UPDATE` em `public.events`.
DROP FUNCTION IF EXISTS public.admin_update_event(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT[], TEXT, TEXT[], TEXT, BOOLEAN, INTEGER);

CREATE OR REPLACE FUNCTION public.admin_update_event(
  p_event_id UUID,
  p_slug TEXT,
  p_title TEXT,
  p_subtitle TEXT,
  p_category_slug TEXT,
  p_category_name TEXT,
  p_event_date TEXT,
  p_time_range TEXT,
  p_city TEXT,
  p_venue_name TEXT,
  p_starting_price NUMERIC(12, 2),
  p_banner_url TEXT,
  p_card_image_url TEXT,
  p_gallery_urls TEXT[],
  p_description TEXT,
  p_highlights TEXT[],
  p_status TEXT,
  p_featured BOOLEAN,
  p_capacity INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_is_direct_db_admin BOOLEAN := (
    v_jwt_role = '' AND auth.uid() IS NULL AND session_user IN ('postgres', 'supabase_admin')
  );
  v_clean_date TEXT := btrim(COALESCE(p_event_date, ''));
  v_parsed_event_date DATE;
  v_updated public.events%ROWTYPE;
BEGIN
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  IF v_jwt_role <> 'service_role'
     AND NOT public.is_admin_or_super_admin()
     AND NOT v_is_direct_db_admin
  THEN
    RAISE EXCEPTION 'Acesso negado: apenas administradores autorizados podem editar eventos.'
      USING ERRCODE = '42501';
  END IF;

  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Identificador do evento (p_event_id) é obrigatório.';
  END IF;

  -- Valida formato e existência da data no calendário ANTES de adquirir locks de escrita ou executar UPDATE
  IF v_clean_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'Data do evento inválida ("%"). Utilize o formato ISO YYYY-MM-DD.', COALESCE(p_event_date, 'NULL')
      USING ERRCODE = '22007';
  END IF;

  BEGIN
    v_parsed_event_date := v_clean_date::DATE;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'Data do evento inválida ("%"). Informe uma data real no formato YYYY-MM-DD.', COALESCE(p_event_date, 'NULL')
        USING ERRCODE = '22007';
  END;

  IF to_char(v_parsed_event_date, 'YYYY-MM-DD') <> v_clean_date THEN
    RAISE EXCEPTION 'Data de calendário inexistente ("%").', v_clean_date
      USING ERRCODE = '22008';
  END IF;

  -- Ordem canônica ANTES do ModifyTable
  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || p_event_id::text));

  PERFORM 1
  FROM public.events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento (%) não encontrado.', p_event_id;
  END IF;

  PERFORM 1
  FROM public.ticket_categories
  WHERE event_id = p_event_id
  ORDER BY id ASC
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = p_event_id
  ORDER BY id ASC
  FOR UPDATE;

  UPDATE public.events
  SET
    slug = btrim(COALESCE(p_slug, '')),
    title = btrim(COALESCE(p_title, '')),
    subtitle = NULLIF(btrim(COALESCE(p_subtitle, '')), ''),
    category_slug = btrim(COALESCE(p_category_slug, '')),
    category_name = btrim(COALESCE(p_category_name, '')),
    event_date = v_parsed_event_date,
    time_range = btrim(COALESCE(p_time_range, '')),
    city = btrim(COALESCE(p_city, '')),
    venue_name = btrim(COALESCE(p_venue_name, '')),
    starting_price = p_starting_price,
    banner_url = btrim(COALESCE(p_banner_url, '')),
    card_image_url = btrim(COALESCE(p_card_image_url, '')),
    gallery_urls = COALESCE(p_gallery_urls, '{}'::TEXT[]),
    description = btrim(COALESCE(p_description, '')),
    highlights = COALESCE(p_highlights, '{}'::TEXT[]),
    status = btrim(COALESCE(p_status, 'draft')),
    featured = COALESCE(p_featured, false),
    capacity = p_capacity
  WHERE id = p_event_id
  RETURNING * INTO v_updated;

  RETURN to_jsonb(v_updated);
END;
$$;

-- 6.C.2 `public.admin_update_event_status`:
DROP FUNCTION IF EXISTS public.admin_update_event_status(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.admin_update_event_status(
  p_event_id UUID,
  p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_is_direct_db_admin BOOLEAN := (
    v_jwt_role = '' AND auth.uid() IS NULL AND session_user IN ('postgres', 'supabase_admin')
  );
  v_updated public.events%ROWTYPE;
BEGIN
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  IF v_jwt_role <> 'service_role'
     AND NOT public.is_admin_or_super_admin()
     AND NOT v_is_direct_db_admin
  THEN
    RAISE EXCEPTION 'Acesso negado: apenas administradores autorizados podem alterar o status de eventos.';
  END IF;

  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Identificador do evento (p_event_id) é obrigatório.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || p_event_id::text));

  PERFORM 1
  FROM public.events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento (%) não encontrado.', p_event_id;
  END IF;

  PERFORM 1
  FROM public.ticket_categories
  WHERE event_id = p_event_id
  ORDER BY id ASC
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = p_event_id
  ORDER BY id ASC
  FOR UPDATE;

  UPDATE public.events
  SET status = p_status
  WHERE id = p_event_id
  RETURNING * INTO v_updated;

  RETURN to_jsonb(v_updated);
END;
$$;

-- 6.C.3 `public.admin_delete_event`:
DROP FUNCTION IF EXISTS public.admin_delete_event(UUID);

CREATE OR REPLACE FUNCTION public.admin_delete_event(
  p_event_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_is_direct_db_admin BOOLEAN := (
    v_jwt_role = '' AND auth.uid() IS NULL AND session_user IN ('postgres', 'supabase_admin')
  );
BEGIN
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  IF v_jwt_role <> 'service_role'
     AND NOT public.is_admin_or_super_admin()
     AND NOT v_is_direct_db_admin
  THEN
    RAISE EXCEPTION 'Acesso negado: apenas administradores autorizados podem excluir eventos.';
  END IF;

  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Identificador do evento (p_event_id) é obrigatório.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || p_event_id::text));

  PERFORM 1
  FROM public.events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento (%) não encontrado.', p_event_id;
  END IF;

  PERFORM 1
  FROM public.ticket_categories
  WHERE event_id = p_event_id
  ORDER BY id ASC
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = p_event_id
  ORDER BY id ASC
  FOR UPDATE;

  DELETE FROM public.events
  WHERE id = p_event_id;

  RETURN jsonb_build_object(
    'deleted', true,
    'event_id', p_event_id
  );
END;
$$;

-- 6.C.4 `public.admin_save_ticket_batch`:
-- Cria ou atualiza um lote de ingressos adquirindo `px_event_inventory` -> `events FOR UPDATE`
-- -> `ticket_categories (id ASC) FOR UPDATE` -> `ticket_batches (id ASC) FOR UPDATE` ANTES de executar
-- o `INSERT` ou `UPDATE` em `public.ticket_batches`, e validando no servidor a existência,
-- pertencimento ao mesmo `event_id` e status ativo de `p_category_id`.
DROP FUNCTION IF EXISTS public.admin_save_ticket_batch(UUID, UUID, UUID, TEXT, INTEGER, TEXT, NUMERIC, INTEGER, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN);

CREATE OR REPLACE FUNCTION public.admin_save_ticket_batch(
  p_batch_id UUID,
  p_event_id UUID,
  p_category_id UUID,
  p_name TEXT,
  p_batch_number INTEGER,
  p_description TEXT,
  p_price NUMERIC(12, 2),
  p_total_quantity INTEGER,
  p_thumbnail_url TEXT DEFAULT NULL,
  p_starts_at TIMESTAMPTZ DEFAULT NULL,
  p_ends_at TIMESTAMPTZ DEFAULT NULL,
  p_active BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_is_direct_db_admin BOOLEAN := (
    v_jwt_role = '' AND auth.uid() IS NULL AND session_user IN ('postgres', 'supabase_admin')
  );
  v_target_event_id UUID := p_event_id;
  v_category public.ticket_categories%ROWTYPE;
  v_existing_batch public.ticket_batches%ROWTYPE;
  v_effective_active BOOLEAN := COALESCE(p_active, TRUE);
  v_saved public.ticket_batches%ROWTYPE;
BEGIN
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  IF v_jwt_role <> 'service_role'
     AND NOT public.is_admin_or_super_admin()
     AND NOT v_is_direct_db_admin
  THEN
    RAISE EXCEPTION 'Acesso negado: apenas administradores autorizados podem criar ou editar lotes de ingressos.';
  END IF;

  IF p_batch_id IS NOT NULL AND v_target_event_id IS NULL THEN
    SELECT event_id INTO v_target_event_id
    FROM public.ticket_batches
    WHERE id = p_batch_id;
  END IF;

  IF v_target_event_id IS NULL THEN
    RAISE EXCEPTION 'Identificador do evento (p_event_id) é obrigatório.';
  END IF;

  IF p_category_id IS NULL THEN
    RAISE EXCEPTION 'Identificador da categoria de ingresso (p_category_id) é obrigatório.';
  END IF;

  -- Ordem global canônica ANTES de `INSERT`/`UPDATE` em `public.ticket_batches`
  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

  PERFORM 1
  FROM public.events
  WHERE id = v_target_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento (%) não encontrado.', v_target_event_id;
  END IF;

  PERFORM 1
  FROM public.ticket_categories
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  -- Validação explícita no servidor antes de qualquer mutação:
  -- 1. Categoria deve existir;
  -- 2. Categoria deve pertencer ao mesmo `event_id` do lote;
  -- 3. Quando o lote está sendo criado ativo, ativado ou reatribuído para a categoria enquanto ativo,
  --    a categoria deve estar ativa (`v_category.active = TRUE`).
  SELECT * INTO v_category
  FROM public.ticket_categories
  WHERE id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Categoria de ingresso (%) associada ao lote não encontrada.', p_category_id
      USING ERRCODE = '23503';
  END IF;

  IF v_category.event_id <> v_target_event_id THEN
    RAISE EXCEPTION
      'Inconsistência referencial: a categoria "%" (%) pertence ao evento (%) e não pode ser vinculada a um lote do evento (%).',
      v_category.name,
      v_category.id,
      v_category.event_id,
      v_target_event_id
      USING ERRCODE = '23514';
  END IF;

  IF p_batch_id IS NOT NULL THEN
    SELECT * INTO v_existing_batch
    FROM public.ticket_batches
    WHERE id = p_batch_id
      AND event_id = v_target_event_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Lote (%) não encontrado no evento (%).', p_batch_id, v_target_event_id;
    END IF;
  END IF;

  IF v_effective_active AND NOT v_category.active AND (
    p_batch_id IS NULL
    OR NOT v_existing_batch.active
    OR v_existing_batch.category_id IS DISTINCT FROM p_category_id
  ) THEN
    RAISE EXCEPTION
      'Não é permitido criar ou ativar um lote vinculado a uma categoria inativa ("%" / %).',
      v_category.name,
      v_category.id
      USING ERRCODE = '23514';
  END IF;

  IF p_batch_id IS NULL THEN
    INSERT INTO public.ticket_batches (
      event_id,
      category_id,
      name,
      batch_number,
      description,
      price,
      total_quantity,
      thumbnail_url,
      starts_at,
      ends_at,
      active
    ) VALUES (
      v_target_event_id,
      p_category_id,
      p_name,
      p_batch_number,
      COALESCE(p_description, ''),
      p_price,
      p_total_quantity,
      p_thumbnail_url,
      p_starts_at,
      p_ends_at,
      v_effective_active
    )
    RETURNING * INTO v_saved;
  ELSE
    UPDATE public.ticket_batches
    SET
      category_id = p_category_id,
      name = p_name,
      batch_number = p_batch_number,
      description = COALESCE(p_description, ''),
      price = p_price,
      total_quantity = p_total_quantity,
      thumbnail_url = p_thumbnail_url,
      starts_at = p_starts_at,
      ends_at = p_ends_at,
      active = v_effective_active
    WHERE id = p_batch_id
      AND event_id = v_target_event_id
    RETURNING * INTO v_saved;
  END IF;

  RETURN to_jsonb(v_saved);
END;
$$;

-- 6.C.5 `public.admin_delete_ticket_batch`:
DROP FUNCTION IF EXISTS public.admin_delete_ticket_batch(UUID);

CREATE OR REPLACE FUNCTION public.admin_delete_ticket_batch(
  p_batch_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_is_direct_db_admin BOOLEAN := (
    v_jwt_role = '' AND auth.uid() IS NULL AND session_user IN ('postgres', 'supabase_admin')
  );
  v_target_event_id UUID;
BEGIN
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  IF v_jwt_role <> 'service_role'
     AND NOT public.is_admin_or_super_admin()
     AND NOT v_is_direct_db_admin
  THEN
    RAISE EXCEPTION 'Acesso negado: apenas administradores autorizados podem excluir lotes de ingressos.';
  END IF;

  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'Identificador do lote (p_batch_id) é obrigatório.';
  END IF;

  SELECT event_id INTO v_target_event_id
  FROM public.ticket_batches
  WHERE id = p_batch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lote (%) não encontrado.', p_batch_id;
  END IF;

  -- Ordem global canônica ANTES do `DELETE` em `public.ticket_batches`
  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

  PERFORM 1
  FROM public.events
  WHERE id = v_target_event_id
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_categories
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  DELETE FROM public.ticket_batches
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'deleted', true,
    'batch_id', p_batch_id,
    'event_id', v_target_event_id
  );
END;
$$;

-- 6.C.6 `public.admin_save_ticket_category`:
-- Cria ou atualiza transacionalmente uma categoria de ingressos em `public.ticket_categories`
-- adquirindo os bloqueios na ordem global canônica (`px_event_inventory` -> `events FOR UPDATE`
-- -> `ticket_categories (id ASC) FOR UPDATE` -> `ticket_batches (id ASC) FOR UPDATE`) ANTES
-- do `INSERT` ou `UPDATE`.
DROP FUNCTION IF EXISTS public.admin_save_ticket_category(UUID, UUID, TEXT, TEXT, TEXT, TEXT[], INTEGER, BOOLEAN);
DROP FUNCTION IF EXISTS public.admin_save_ticket_category(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN);

CREATE OR REPLACE FUNCTION public.admin_save_ticket_category(
  p_category_id UUID,
  p_event_id UUID,
  p_slug TEXT,
  p_name TEXT,
  p_description TEXT DEFAULT NULL,
  p_max_per_order INTEGER DEFAULT 10,
  p_sort_order INTEGER DEFAULT 1,
  p_active BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_is_direct_db_admin BOOLEAN := (
    v_jwt_role = '' AND auth.uid() IS NULL AND session_user IN ('postgres', 'supabase_admin')
  );
  v_target_event_id UUID := p_event_id;
  v_saved public.ticket_categories%ROWTYPE;
BEGIN
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  IF v_jwt_role <> 'service_role'
     AND NOT public.is_admin_or_super_admin()
     AND NOT v_is_direct_db_admin
  THEN
    RAISE EXCEPTION 'Acesso negado: apenas administradores autorizados podem criar ou editar categorias de ingressos.'
      USING ERRCODE = '42501';
  END IF;

  IF p_category_id IS NOT NULL AND v_target_event_id IS NULL THEN
    SELECT event_id INTO v_target_event_id
    FROM public.ticket_categories
    WHERE id = p_category_id;
  END IF;

  IF v_target_event_id IS NULL THEN
    RAISE EXCEPTION 'Identificador do evento (p_event_id) é obrigatório.';
  END IF;

  -- Ordem global canônica ANTES de `INSERT`/`UPDATE` em `public.ticket_categories`
  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

  PERFORM 1
  FROM public.events
  WHERE id = v_target_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento (%) não encontrado.', v_target_event_id;
  END IF;

  PERFORM 1
  FROM public.ticket_categories
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  IF p_category_id IS NULL THEN
    INSERT INTO public.ticket_categories (
      event_id,
      slug,
      name,
      description,
      max_per_order,
      sort_order,
      active
    ) VALUES (
      v_target_event_id,
      btrim(COALESCE(p_slug, '')),
      btrim(COALESCE(p_name, '')),
      NULLIF(btrim(COALESCE(p_description, '')), ''),
      COALESCE(p_max_per_order, 10),
      COALESCE(p_sort_order, 1),
      COALESCE(p_active, TRUE)
    )
    RETURNING * INTO v_saved;
  ELSE
    UPDATE public.ticket_categories
    SET
      slug = btrim(COALESCE(p_slug, '')),
      name = btrim(COALESCE(p_name, '')),
      description = NULLIF(btrim(COALESCE(p_description, '')), ''),
      max_per_order = COALESCE(p_max_per_order, 10),
      sort_order = COALESCE(p_sort_order, 1),
      active = COALESCE(p_active, TRUE)
    WHERE id = p_category_id
      AND event_id = v_target_event_id
    RETURNING * INTO v_saved;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Categoria (%) não encontrada no evento (%).', p_category_id, v_target_event_id;
    END IF;
  END IF;

  RETURN to_jsonb(v_saved);
END;
$$;

-- 6.C.7 `public.admin_delete_ticket_category`:
-- Exclui transacionalmente uma categoria de ingressos sem vendas/reservas/pedidos/ingressos,
-- adquirindo os bloqueios na ordem global canônica ANTES do `DELETE` (evitando que o
-- `ON DELETE CASCADE` para `public.ticket_batches` inverta a ordem de bloqueio).
DROP FUNCTION IF EXISTS public.admin_delete_ticket_category(UUID);

CREATE OR REPLACE FUNCTION public.admin_delete_ticket_category(
  p_category_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_is_direct_db_admin BOOLEAN := (
    v_jwt_role = '' AND auth.uid() IS NULL AND session_user IN ('postgres', 'supabase_admin')
  );
  v_target_event_id UUID;
BEGIN
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  IF v_jwt_role <> 'service_role'
     AND NOT public.is_admin_or_super_admin()
     AND NOT v_is_direct_db_admin
  THEN
    RAISE EXCEPTION 'Acesso negado: apenas administradores autorizados podem excluir categorias de ingressos.'
      USING ERRCODE = '42501';
  END IF;

  IF p_category_id IS NULL THEN
    RAISE EXCEPTION 'Identificador da categoria (p_category_id) é obrigatório.';
  END IF;

  SELECT event_id INTO v_target_event_id
  FROM public.ticket_categories
  WHERE id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Categoria (%) não encontrada.', p_category_id;
  END IF;

  -- Ordem global canônica ANTES do `DELETE` em `public.ticket_categories`
  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

  PERFORM 1
  FROM public.events
  WHERE id = v_target_event_id
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_categories
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  DELETE FROM public.ticket_categories
  WHERE id = p_category_id;

  RETURN jsonb_build_object(
    'deleted', true,
    'category_id', p_category_id,
    'event_id', v_target_event_id
  );
END;
$$;

-- =============================================================================
-- 7. CHECK-IN TRANSACIONAL NA PORTARIA (`public.perform_ticket_checkin`)
-- =============================================================================
DROP FUNCTION IF EXISTS public.perform_ticket_checkin(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.perform_ticket_checkin(
  p_code_or_payload TEXT,
  p_device_id TEXT DEFAULT 'PX-CONTROL-WEB'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operator_id UUID := auth.uid();
  v_target_ticket_id UUID;
  v_target_event_id UUID;
  v_target_order_id UUID;
  v_ticket public.tickets%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_normalized TEXT := upper(btrim(COALESCE(p_code_or_payload, '')));
  v_used_at TIMESTAMPTZ;
BEGIN
  SET CONSTRAINTS
    public.trg_orders_reconcile_counters_deferred,
    public.trg_batches_reconcile_counters_deferred,
    public.trg_tickets_reconcile_counters_deferred
  DEFERRED;

  -- 1. Exige operador de check-in ou administrador autenticado
  IF v_operator_id IS NULL OR NOT public.is_checkin_staff() THEN
    RAISE EXCEPTION 'Acesso negado: apenas operadores de check-in ou administradores autenticados podem validar ingressos.';
  END IF;

  IF v_normalized = '' THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'result', 'invalid',
      'status_reason', 'invalid',
      'message', 'Código do ingresso não informado.'
    );
  END IF;

  -- 2. Localização rápida indexada SEM lock de linha prévio em `public.tickets`
  --    (utiliza `idx_tickets_upper_code` e `idx_tickets_upper_qr_payload`, evitando
  --    varredura sequencial com `FOR UPDATE` e garantindo que os locks sejam adquiridos
  --    estritamente na ordem global canônica: `px_event_inventory` -> `events` -> `ticket_batches` -> `orders` -> `tickets`).
  SELECT id, event_id, order_id
  INTO v_target_ticket_id, v_target_event_id, v_target_order_id
  FROM public.tickets
  WHERE upper(code) = v_normalized
     OR upper(qr_payload) = v_normalized
  LIMIT 1;

  IF NOT FOUND OR v_target_ticket_id IS NULL THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'result', 'invalid',
      'status_reason', 'invalid',
      'message', 'Ingresso não localizado na base oficial PX CUSTON.'
    );
  END IF;

  -- 3. Aquisição de locks na ordem global canônica antes de bloquear o pedido e o ingresso
  PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));

  PERFORM 1
  FROM public.events
  WHERE id = v_target_event_id
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_categories
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  PERFORM 1
  FROM public.ticket_batches
  WHERE event_id = v_target_event_id
  ORDER BY id ASC
  FOR UPDATE;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = v_target_order_id
  FOR UPDATE;

  SELECT * INTO v_ticket
  FROM public.tickets
  WHERE id = v_target_ticket_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'result', 'invalid',
      'status_reason', 'invalid',
      'message', 'Ingresso não localizado na base oficial PX CUSTON.'
    );
  END IF;

  IF v_ticket.status = 'used' THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'result', 'already_used',
      'status_reason', 'already_used',
      'ticket_id', v_ticket.id,
      'ticket_code', v_ticket.code,
      'code', v_ticket.code,
      'holder_name', v_ticket.holder_name,
      'used_at', v_ticket.used_at,
      'message', 'Ingresso já utilizado anteriormente. Reutilização bloqueada.'
    );
  END IF;

  IF v_ticket.status IN ('refunded', 'cancelled', 'expired') THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'result', 'invalid',
      'status_reason', 'invalid',
      'ticket_id', v_ticket.id,
      'ticket_code', v_ticket.code,
      'code', v_ticket.code,
      'holder_name', v_ticket.holder_name,
      'status', v_ticket.status,
      'message', 'Entrada negada: ingresso cancelado, expirado ou reembolsado.'
    );
  END IF;

  IF v_ticket.status <> 'paid' THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'result', 'unpaid',
      'status_reason', 'unpaid',
      'ticket_id', v_ticket.id,
      'ticket_code', v_ticket.code,
      'code', v_ticket.code,
      'holder_name', v_ticket.holder_name,
      'status', v_ticket.status,
      'message', 'Entrada negada: ingresso sem pagamento confirmado.'
    );
  END IF;

  -- 4. Confere o estado atual do pedido pai (`public.orders`) já bloqueado
  IF v_order.id IS NULL OR v_order.order_status <> 'paid' OR v_order.payment_status <> 'approved' THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'result', 'invalid',
      'status_reason', 'invalid',
      'ticket_id', v_ticket.id,
      'ticket_code', v_ticket.code,
      'code', v_ticket.code,
      'holder_name', v_ticket.holder_name,
      'status', COALESCE(v_order.order_status, 'unknown'),
      'message', 'Entrada negada: o pedido vinculado a este ingresso não está ativo/pago.'
    );
  END IF;

  v_used_at := NOW();

  UPDATE public.tickets
  SET
    status = 'used',
    used_at = v_used_at,
    used_by_operator_id = v_operator_id,
    checkin_device_id = COALESCE(NULLIF(btrim(p_device_id), ''), 'PX-CONTROL-WEB')
  WHERE id = v_ticket.id;

  RETURN jsonb_build_object(
    'authorized', true,
    'result', 'authorized',
    'status_reason', 'authorized',
    'ticket_id', v_ticket.id,
    'ticket_code', v_ticket.code,
    'code', v_ticket.code,
    'holder_name', v_ticket.holder_name,
    'used_at', v_used_at,
    'message', 'Entrada autorizada!'
  );
END;
$$;

-- =============================================================================
-- 8. PERMISSÕES DE TABELAS, COLUNAS E EXECUÇÃO (`REVOKE` / `GRANT`)
-- =============================================================================

-- 8.1 Proteção em nível de tabela para eventos, categorias, lotes, pedidos, ingressos e logs de auditoria:
-- Revoga `INSERT, UPDATE, DELETE` diretos de `PUBLIC, anon, authenticated` sobre `public.events`,
-- `public.ticket_categories`, `public.ticket_batches`, `public.orders`, `public.tickets` e `public.audit_logs`.
-- Leitura (`SELECT`) permanece regida pelas políticas RLS (`events_select_published_or_admin`,
-- `ticket_categories_select_public_or_admin`, `ticket_batches_select_public_or_admin`,
-- `orders_select_own_or_admin`, `tickets_select_own_or_staff`, `audit_logs_select_admin`).
-- Todas as mutações nessas tabelas ocorrem exclusivamente pelas RPCs transacionais com ordem
-- canônica de bloqueios (`admin_*`, `reserve_ticket_order`, `confirm_order_payment`,
-- `release_expired_reservations`, `cancel_ticket_order`, `refund_ticket_order`,
-- `record_late_payment_incident`, `perform_ticket_checkin`).
REVOKE INSERT, UPDATE, DELETE ON public.events FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.ticket_categories FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.ticket_batches FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.orders FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.tickets FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.audit_logs FROM PUBLIC, anon, authenticated;

-- 8.2 `is_admin_or_super_admin`:
-- Referenciada pelas políticas RLS de SELECT em `events`, `ticket_categories` e
-- `ticket_batches` (que se aplicam a `anon, authenticated`). Por isso revogamos
-- `PUBLIC` e concedemos `EXECUTE` a `anon, authenticated, service_role`.
-- A função retorna `FALSE` imediatamente quando `auth.uid() IS NULL`.
REVOKE ALL ON FUNCTION public.is_admin_or_super_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_or_super_admin() TO anon, authenticated, service_role;

-- 8.3 `is_checkin_staff`:
-- Referenciada apenas pela policy `tickets_select_own_or_staff` (`TO authenticated`)
-- e pela RPC `perform_ticket_checkin`. Não precisa nem deve estar disponível para `anon`.
REVOKE ALL ON FUNCTION public.is_checkin_staff() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_checkin_staff() TO authenticated, service_role;

-- 8.4 `reserve_ticket_order`: exclusivo para usuários autenticados (e `service_role`)
REVOKE ALL ON FUNCTION public.reserve_ticket_order(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ticket_order(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- 8.5 `confirm_order_payment`: estritamente exclusivo do backend confiável (`service_role`)
REVOKE ALL ON FUNCTION public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO service_role;

-- 8.6 `release_expired_reservations`: revogado de `PUBLIC` e `anon`; exige internamente `service_role`, admin ou sessão direta do banco
REVOKE ALL ON FUNCTION public.release_expired_reservations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_expired_reservations() TO authenticated, service_role;

-- 8.7 `cancel_ticket_order`: disponível para comprador autenticado, admin e `service_role`
REVOKE ALL ON FUNCTION public.cancel_ticket_order(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_ticket_order(UUID, TEXT) TO authenticated, service_role;

-- 8.8 `refund_ticket_order`: revogado de `PUBLIC` e `anon`; exige internamente `service_role`, admin ou sessão direta do banco
REVOKE ALL ON FUNCTION public.refund_ticket_order(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_ticket_order(UUID, TEXT, TEXT) TO authenticated, service_role;

-- 8.9 `record_late_payment_incident`: estritamente exclusivo do backend confiável (`service_role`)
REVOKE ALL ON FUNCTION public.record_late_payment_incident(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_late_payment_incident(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO service_role;

-- 8.10 RPCs administrativas transacionais (`admin_*`): revogadas de `PUBLIC` e `anon`; exigem internamente admin autenticado ou `service_role`
REVOKE ALL ON FUNCTION public.admin_create_event(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT[], TEXT, TEXT[], TEXT, BOOLEAN, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_event(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT[], TEXT, TEXT[], TEXT, BOOLEAN, INTEGER) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_update_event(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT[], TEXT, TEXT[], TEXT, BOOLEAN, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_event(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT[], TEXT, TEXT[], TEXT, BOOLEAN, INTEGER) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_update_event_status(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_event_status(UUID, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_delete_event(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_event(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_save_ticket_batch(UUID, UUID, UUID, TEXT, INTEGER, TEXT, NUMERIC, INTEGER, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_ticket_batch(UUID, UUID, UUID, TEXT, INTEGER, TEXT, NUMERIC, INTEGER, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_delete_ticket_batch(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_ticket_batch(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_save_ticket_category(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_ticket_category(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_delete_ticket_category(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_ticket_category(UUID) TO authenticated, service_role;

-- 8.11 `perform_ticket_checkin`: revogado de `PUBLIC` e `anon`; exige internamente operador/admin autenticado
REVOKE ALL ON FUNCTION public.perform_ticket_checkin(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perform_ticket_checkin(TEXT, TEXT) TO authenticated, service_role;

-- 8.12 Funções de trigger: revogadas de `PUBLIC`, `anon` e `authenticated` para evitar invocação direta via RPC
REVOKE ALL ON FUNCTION public.enforce_ticket_order_integrity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_event_capacity_vs_batches() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_ticket_category_integrity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_batch_within_event_capacity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_orders_integrity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_event_inventory_reconciliation_deferred() FROM PUBLIC, anon, authenticated;

COMMIT;

-- =============================================================================
-- 9. NOTAS DE ROLLBACK OPERACIONAL (NÃO EXECUTADO AUTOMATICAMENTE)
-- =============================================================================
-- Para ensaiar esta migration sem persistir alterações (dry-run), substitua o
-- `COMMIT;` acima por `ROLLBACK;`.
-- Caso seja necessário reverter os triggers de capacidade e reconciliação adicionados
-- nesta migration preservando os dados de `public.tickets`:
--   DROP TRIGGER IF EXISTS trg_tickets_reconcile_counters_deferred ON public.tickets;
--   DROP TRIGGER IF EXISTS trg_orders_reconcile_counters_deferred ON public.orders;
--   DROP TRIGGER IF EXISTS trg_batches_reconcile_counters_deferred ON public.ticket_batches;
--   DROP FUNCTION IF EXISTS public.enforce_event_inventory_reconciliation_deferred();
--   DROP TRIGGER IF EXISTS trg_orders_enforce_integrity ON public.orders;
--   DROP FUNCTION IF EXISTS public.enforce_orders_integrity();
--   DROP TRIGGER IF EXISTS trg_tickets_enforce_order_integrity ON public.tickets;
--   DROP FUNCTION IF EXISTS public.enforce_ticket_order_integrity();
--   DROP TRIGGER IF EXISTS trg_ticket_batches_enforce_event_capacity ON public.ticket_batches;
--   DROP FUNCTION IF EXISTS public.enforce_batch_within_event_capacity();
--   DROP TRIGGER IF EXISTS trg_events_enforce_capacity_vs_batches ON public.events;
--   DROP FUNCTION IF EXISTS public.enforce_event_capacity_vs_batches();
-- =============================================================================

