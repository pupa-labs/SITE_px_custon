-- =============================================================================
-- PX CUSTON — Plataforma de Ingressos, Eventos & Check-in Online
-- Migration: 002_rpc_contracts_permissions_idempotency.sql
-- Pré-requisito: 001_initial_schema.sql já aplicada no banco.
-- Descrição:
--   1. Backfill determinístico (sem lacunas) de `item_sequence` para ingressos
--      existentes, auditoria de integridade (órfãos, excesso por pedido,
--      intervalo 1..quantity e duplicidades) e criação de índice único total
--      `uq_tickets_order_item_sequence (order_id, item_sequence)`.
--   2. Alinhamento de `public.reserve_ticket_order`:
--      - Parâmetro `p_ticket_batch_id` compatível com `orders.ticket_batch_id` e TypeScript.
--      - Cálculo de preços/taxas exclusivamente no banco com bloqueio `FOR UPDATE`.
--      - Retorno `JSONB` completo (`order_id`, `order_code`, `unit_price`,
--        `subtotal`, `convenience_fee`, `total_amount`, `order_status`,
--        `payment_status`, `reservation_expires_at`).
--      - Remoção de `orders_insert_own_pending` para impedir criação direta de pedidos fora da RPC.
--   3. Endurecimento de `public.confirm_order_payment`:
--      - Sem parâmetros default enganosos: exige obrigatoriamente status oficial,
--        valor total verificado (`p_verified_amount NOT NULL`), moeda (`p_currency = 'BRL'`)
--        e vínculo com o pedido (`p_external_reference`) validados pelo backend na API
--        oficial do Mercado Pago antes da chamada SQL.
--      - Lock transacional (`pg_advisory_xact_lock`) por `mp_payment_id` + `FOR UPDATE` no pedido e lote
--        para serializar chamadas concorrentes com o mesmo identificador de pagamento.
--      - Remoção do uso incorreto de `current_user` em função `SECURITY DEFINER`;
--        autorização baseada estritamente na claim JWT `role = 'service_role'` e `GRANT` exclusivo.
--      - Idempotência rigorosa: reprocessar o mesmo pagamento aprovado não emite ingressos
--        duplicados nem incrementa novamente `sold_quantity` ou `tickets_sold`.
--   4. Alinhamento de `public.perform_ticket_checkin` e `public.release_expired_reservations`:
--      - Retorno JSONB contendo `result`, `ticket_code`, `holder_name`, `ticket_id`, `used_at` e `message`
--        (mantendo `status_reason` e `code` para compatibilidade).
--      - Remoção do uso de `current_user` em `release_expired_reservations` e lock explícito no lote.
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

-- Atualiza trigger de prevenção de escalada de privilégio com extração robusta da role JWT
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
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    -- Permite alteração por:
    -- 1. Backend confiável via service_role
    -- 2. Administrador autenticado (admin / SUPER_ADMIN)
    -- 3. Sessão administrativa direta no SQL Editor (sem JWT PostgREST e com session_user postgres/supabase_admin)
    IF v_jwt_role <> 'service_role'
       AND NOT public.is_admin_or_super_admin()
       AND NOT (v_jwt_role = '' AND auth.uid() IS NULL AND session_user IN ('postgres', 'supabase_admin'))
    THEN
      RAISE EXCEPTION 'Operação negada: alteração de papel administrativo não autorizada.';
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
WHERE t.id = r.ticket_id;

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

-- =============================================================================
-- 3. POLÍTICA DE PEDIDOS: BLOQUEIO DE INSERÇÃO DIRETA PELO CLIENTE
-- =============================================================================
-- Na migration 001 existia a policy `orders_insert_own_pending`. Removemos essa
-- policy para garantir que pedidos só possam ser criados via `public.reserve_ticket_order`,
-- onde o preço é calculado no banco e o estoque sofre lock transacional.
DROP POLICY IF EXISTS orders_insert_own_pending ON public.orders;

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
  v_batch public.ticket_batches%ROWTYPE;
  v_event public.events%ROWTYPE;
  v_category public.ticket_categories%ROWTYPE;
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

  -- 2. Bloqueio transacional da linha do lote para impedir overselling em compras simultâneas
  SELECT * INTO v_batch
  FROM public.ticket_batches
  WHERE id = p_ticket_batch_id
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

  SELECT * INTO v_event
  FROM public.events
  WHERE id = v_batch.event_id
  FOR UPDATE;

  IF NOT FOUND OR v_event.status <> 'published' THEN
    RAISE EXCEPTION 'Evento não está aberto para vendas.';
  END IF;

  IF (v_event.tickets_sold + p_quantity) > v_event.capacity THEN
    RAISE EXCEPTION 'Capacidade total do evento insuficiente para a quantidade solicitada.';
  END IF;

  IF (v_batch.reserved_quantity + v_batch.sold_quantity + p_quantity) > v_batch.total_quantity THEN
    RAISE EXCEPTION 'Estoque insuficiente neste lote para a quantidade solicitada.';
  END IF;

  -- 3. Cálculo no servidor usando exclusivamente o preço oficial de `public.ticket_batches`
  v_subtotal := round(v_batch.price * p_quantity, 2);
  v_fee := round(v_subtotal * 0.06, 2);
  v_total := v_subtotal + v_fee;
  v_order_code := '#PX-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  -- 4. Reserva o estoque no lote
  UPDATE public.ticket_batches
  SET reserved_quantity = reserved_quantity + p_quantity
  WHERE id = v_batch.id;

  -- 5. Cria o pedido vinculado a `auth.uid()` com status `reserved` e `payment_status = 'pending'`
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
  v_order public.orders%ROWTYPE;
  v_batch public.ticket_batches%ROWTYPE;
  v_event public.events%ROWTYPE;
  v_conflicting_order_id UUID;
  v_existing_ticket_count INTEGER := 0;
  v_ticket_code TEXT;
  v_qr_payload TEXT;
  v_i INTEGER;
BEGIN
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

  -- 3. Lock exclusivo na linha do pedido
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado.';
  END IF;

  -- 4. Impede que o mesmo mp_payment_id seja usado em outro pedido (protegido também pela constraint UNIQUE de orders.mp_payment_id)
  SELECT id INTO v_conflicting_order_id
  FROM public.orders
  WHERE mp_payment_id = v_clean_payment_id
    AND id <> p_order_id
  LIMIT 1;

  IF v_conflicting_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'Conflito de pagamento: o identificador "%" já pertence a outro pedido.',
      v_clean_payment_id;
  END IF;

  -- 5. Confere se o pagamento validado na API do Mercado Pago pertence a este pedido específico
  IF v_clean_ext_ref <> v_order.id::text AND v_clean_ext_ref <> v_order.order_code THEN
    RAISE EXCEPTION 'Divergência de titularidade do pagamento: external_reference ("%") não corresponde ao pedido (% / %).',
      v_clean_ext_ref, v_order.id, v_order.order_code;
  END IF;

  -- 6. Confere se o valor total pago no Mercado Pago corresponde exatamente ao total oficial do pedido
  IF round(p_verified_amount, 2) <> v_order.total_amount THEN
    RAISE EXCEPTION 'Valor pago no Mercado Pago (%) diverge do valor total oficial do pedido (%).',
      round(p_verified_amount, 2), v_order.total_amount;
  END IF;

  SELECT COUNT(*) INTO v_existing_ticket_count
  FROM public.tickets
  WHERE order_id = v_order.id;

  -- 7. Tratamento rigoroso de idempotência
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

  IF v_order.order_status NOT IN ('pending_payment', 'reserved') THEN
    RAISE EXCEPTION 'Pedido em estado inválido para confirmação (%).', v_order.order_status;
  END IF;

  IF v_existing_ticket_count > 0 THEN
    RAISE EXCEPTION 'Inconsistência detectada: já existem % ingressos vinculados a um pedido ainda não pago.',
      v_existing_ticket_count;
  END IF;

  -- 8. Lock exclusivo no lote e evento e conversão estrita do estoque reservado em vendido
  SELECT * INTO v_batch
  FROM public.ticket_batches
  WHERE id = v_order.ticket_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lote associado ao pedido não encontrado.';
  END IF;

  IF v_batch.reserved_quantity < v_order.quantity THEN
    RAISE EXCEPTION 'Estoque reservado insuficiente no lote (%) para confirmar % ingressos.',
      v_batch.reserved_quantity, v_order.quantity;
  END IF;

  SELECT * INTO v_event
  FROM public.events
  WHERE id = v_order.event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento associado ao pedido não encontrado.';
  END IF;

  IF (v_event.tickets_sold + v_order.quantity) > v_event.capacity THEN
    RAISE EXCEPTION 'Capacidade total do evento excedida ao confirmar o pedido.';
  END IF;

  UPDATE public.ticket_batches
  SET
    reserved_quantity = reserved_quantity - v_order.quantity,
    sold_quantity = sold_quantity + v_order.quantity
  WHERE id = v_batch.id;

  UPDATE public.events
  SET tickets_sold = tickets_sold + v_order.quantity
  WHERE id = v_order.event_id;

  UPDATE public.orders
  SET
    order_status = 'paid',
    payment_status = 'approved',
    mp_payment_id = v_clean_payment_id,
    paid_at = NOW()
  WHERE id = v_order.id;

  -- 9. Emite exatamente `v_order.quantity` ingressos protegidos por `uq_tickets_order_item_sequence`
  FOR v_i IN 1..v_order.quantity LOOP
    v_ticket_code := 'PX-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    v_qr_payload := 'PXCUSTON|' || v_ticket_code || '|' || v_order.event_id::text || '|' || v_i::text;

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
  v_batch public.ticket_batches%ROWTYPE;
  v_released_count INTEGER := 0;
BEGIN
  -- Sem uso de `current_user`: exige `service_role` ou administrador autenticado (`admin` / `SUPER_ADMIN`)
  IF v_jwt_role <> 'service_role' AND NOT public.is_admin_or_super_admin() THEN
    RAISE EXCEPTION 'Operação não autorizada: apenas o backend ou administradores podem liberar reservas expiradas.';
  END IF;

  FOR v_rec IN
    SELECT id, ticket_batch_id, quantity
    FROM public.orders
    WHERE order_status IN ('pending_payment', 'reserved')
      AND reservation_expires_at IS NOT NULL
      AND reservation_expires_at < NOW()
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT * INTO v_batch
    FROM public.ticket_batches
    WHERE id = v_rec.ticket_batch_id
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.ticket_batches
      SET reserved_quantity = GREATEST(0, reserved_quantity - v_rec.quantity)
      WHERE id = v_batch.id;
    END IF;

    UPDATE public.orders
    SET
      order_status = 'expired',
      payment_status = 'cancelled',
      cancelled_at = NOW()
    WHERE id = v_rec.id;

    v_released_count := v_released_count + 1;
  END LOOP;

  RETURN v_released_count;
END;
$$;

-- =============================================================================
-- 7. CHECK-IN TRANSACIONAL NA PORTARIA (`public.perform_ticket_checkin`)
-- =============================================================================
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
  v_ticket public.tickets%ROWTYPE;
  v_normalized TEXT := upper(btrim(COALESCE(p_code_or_payload, '')));
  v_used_at TIMESTAMPTZ;
BEGIN
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

  -- 2. Lock exclusivo no ingresso
  SELECT * INTO v_ticket
  FROM public.tickets
  WHERE upper(code) = v_normalized
     OR upper(qr_payload) = v_normalized
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
-- 8. PERMISSÕES DE EXECUÇÃO (`REVOKE` / `GRANT`)
-- =============================================================================

-- 8.1 `is_admin_or_super_admin`:
-- Referenciada pelas políticas RLS de SELECT em `events`, `ticket_categories` e
-- `ticket_batches` (que se aplicam a `anon, authenticated`). Por isso revogamos
-- `PUBLIC` e concedemos `EXECUTE` a `anon, authenticated, service_role`.
-- A função retorna `FALSE` imediatamente quando `auth.uid() IS NULL`.
REVOKE ALL ON FUNCTION public.is_admin_or_super_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_or_super_admin() TO anon, authenticated, service_role;

-- 8.2 `is_checkin_staff`:
-- Referenciada apenas pela policy `tickets_select_own_or_staff` (`TO authenticated`)
-- e pela RPC `perform_ticket_checkin`. Não precisa nem deve estar disponível para `anon`.
REVOKE ALL ON FUNCTION public.is_checkin_staff() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_checkin_staff() TO authenticated, service_role;

-- 8.3 `reserve_ticket_order`: exclusivo para usuários autenticados (e `service_role`)
REVOKE ALL ON FUNCTION public.reserve_ticket_order(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ticket_order(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- 8.4 `confirm_order_payment`: estritamente exclusivo do backend confiável (`service_role`)
REVOKE ALL ON FUNCTION public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO service_role;

-- 8.5 `release_expired_reservations`: revogado de `PUBLIC` e `anon`; exige internamente `service_role` ou admin
REVOKE ALL ON FUNCTION public.release_expired_reservations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_expired_reservations() TO authenticated, service_role;

-- 8.6 `perform_ticket_checkin`: revogado de `PUBLIC` e `anon`; exige internamente operador/admin autenticado
REVOKE ALL ON FUNCTION public.perform_ticket_checkin(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perform_ticket_checkin(TEXT, TEXT) TO authenticated, service_role;

COMMIT;
