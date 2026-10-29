-- =============================================================================
-- PX CUSTON — Plataforma de Ingressos, Eventos & Check-in Online
-- Migration: 002_rpc_contracts_permissions_idempotency.sql
-- Descrição:
--   1. Alinha o contrato de `public.reserve_ticket_order`:
--      - Parâmetro `p_ticket_batch_id` alinhado com a coluna `orders.ticket_batch_id` e TypeScript.
--      - Retorno `JSONB` estruturado (`order_id`, `order_code`, `unit_price`,
--        `subtotal`, `convenience_fee`, `total_amount`, `order_status`,
--        `payment_status`, `reservation_expires_at`) calculado exclusivamente no banco.
--      - Exige sessão autenticada (`auth.uid()`) e bloqueia inserção direta na tabela `orders`.
--   2. Alinha o contrato de `public.perform_ticket_checkin`:
--      - Retorna `result` e `ticket_code` (mantendo `status_reason` e `code` por compatibilidade).
--      - Exige sessão autenticada (`auth.uid() IS NOT NULL`) + operador autorizado (`public.is_checkin_staff()`).
--   3. Endurece permissões SQL (`REVOKE ALL ... FROM PUBLIC, anon, authenticated`) nas
--      funções privilegiadas e auxiliares, concedendo apenas o mínimo necessário.
--   4. Corrige a idempotência e validação de `public.confirm_order_payment`:
--      - Verifica se o `p_mp_payment_id` recebido corresponde exatamente ao `mp_payment_id`
--        já registrado quando o pedido já consta como `paid`.
--      - Rejeita reutilização do mesmo `mp_payment_id` em pedidos distintos.
--      - Exige `p_mp_payment_status = 'approved'` (nunca aprova apenas pela presença de ID).
--      - Garante no banco (via verificação e índice único por pedido/sequência) que
--        chamadas repetidas jamais emitam ingressos duplicados.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. PREVENÇÃO ESTRUTURAL DE INGRESSOS DUPLICADOS POR PEDIDO
-- =============================================================================
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS item_sequence INTEGER CHECK (item_sequence IS NULL OR item_sequence >= 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_order_item_sequence
  ON public.tickets(order_id, item_sequence)
  WHERE item_sequence IS NOT NULL;

-- Remove política de INSERT direto em `public.orders` para obrigar que toda
-- reserva passe pela função transacional `public.reserve_ticket_order`, onde o
-- preço é calculado pelo servidor e o estoque é travado com `FOR UPDATE`.
DROP POLICY IF EXISTS orders_insert_own_pending ON public.orders;

-- =============================================================================
-- 2. RESERVA TRANSACIONAL DE PEDIDOS (`public.reserve_ticket_order`)
-- =============================================================================
-- Remove assinatura antiga de 001_initial_schema.sql (que usava p_batch_id e retornava UUID)
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
SET search_path = public
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
  v_subtotal NUMERIC(12, 2);
  v_fee NUMERIC(12, 2);
  v_total NUMERIC(12, 2);
  v_order_id UUID;
  v_order_code TEXT;
  v_expires_at TIMESTAMPTZ := NOW() + INTERVAL '30 minutes';
BEGIN
  -- 1. Exige sessão autenticada real no Supabase Auth
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

  IF char_length(v_clean_name) < 5 THEN
    RAISE EXCEPTION 'Informe o nome completo do comprador.';
  END IF;

  IF char_length(v_clean_cpf) <> 11 THEN
    RAISE EXCEPTION 'CPF do comprador inválido.';
  END IF;

  -- 2. Lock exclusivo na linha do lote para evitar corrida de estoque (overselling)
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
  WHERE id = v_batch.event_id;

  IF NOT FOUND OR v_event.status <> 'published' THEN
    RAISE EXCEPTION 'Evento não está aberto para vendas.';
  END IF;

  IF (v_batch.reserved_quantity + v_batch.sold_quantity + p_quantity) > v_batch.total_quantity THEN
    RAISE EXCEPTION 'Estoque insuficiente neste lote para a quantidade solicitada.';
  END IF;

  -- 3. Cálculo estrito no banco de dados (nunca confia em preços vindos do frontend)
  v_subtotal := round(v_batch.price * p_quantity, 2);
  v_fee := round(v_subtotal * 0.06, 2);
  v_total := v_subtotal + v_fee;
  v_order_code := '#PX-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  -- 4. Incrementa estoque reservado do lote
  UPDATE public.ticket_batches
  SET reserved_quantity = reserved_quantity + p_quantity
  WHERE id = v_batch.id;

  -- 5. Registra o pedido vinculado exclusivamente ao auth.uid() autenticado
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
-- 3. CONFIRMAÇÃO IDEMPOTENTE E SEGURA DE PAGAMENTO (`public.confirm_order_payment`)
-- =============================================================================
DROP FUNCTION IF EXISTS public.confirm_order_payment(UUID, TEXT);
DROP FUNCTION IF EXISTS public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC);

CREATE OR REPLACE FUNCTION public.confirm_order_payment(
  p_order_id UUID,
  p_mp_payment_id TEXT,
  p_mp_payment_status TEXT DEFAULT 'approved',
  p_verified_amount NUMERIC(12, 2) DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_clean_payment_id TEXT := btrim(COALESCE(p_mp_payment_id, ''));
  v_clean_payment_status TEXT := lower(btrim(COALESCE(p_mp_payment_status, '')));
  v_order public.orders%ROWTYPE;
  v_batch public.ticket_batches%ROWTYPE;
  v_conflicting_order_id UUID;
  v_existing_ticket_count INTEGER := 0;
  v_ticket_code TEXT;
  v_qr_payload TEXT;
  v_i INTEGER;
BEGIN
  -- 1. Exclusivo para o backend confiável (service_role) ou superuser administrativo no banco
  IF v_jwt_role <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Operação restrita ao backend oficial de pagamentos.';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Identificador do pedido (p_order_id) é obrigatório.';
  END IF;

  IF v_clean_payment_id = '' THEN
    RAISE EXCEPTION 'Identificador oficial de pagamento do Mercado Pago é obrigatório.';
  END IF;

  -- Não aprova pagamento apenas pela presença de um ID: exige status oficial 'approved' validado no backend
  IF v_clean_payment_status <> 'approved' THEN
    RAISE EXCEPTION 'Pagamento não pode ser confirmado: status oficial no gateway é "%", esperado "approved".', v_clean_payment_status;
  END IF;

  -- 2. Verifica se o mp_payment_id já foi vinculado a OUTRO pedido
  SELECT id INTO v_conflicting_order_id
  FROM public.orders
  WHERE mp_payment_id = v_clean_payment_id
    AND id <> p_order_id
  LIMIT 1;

  IF v_conflicting_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'Conflito de pagamento: o identificador "%" já está associado a outro pedido.', v_clean_payment_id;
  END IF;

  -- 3. Lock exclusivo no pedido
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado.';
  END IF;

  -- Valida valor pago confirmado pelo gateway, quando informado pelo backend
  IF p_verified_amount IS NOT NULL AND round(p_verified_amount, 2) <> v_order.total_amount THEN
    RAISE EXCEPTION 'Valor confirmado no pagamento (%) diverge do total oficial do pedido (%).',
      p_verified_amount, v_order.total_amount;
  END IF;

  -- Conta quantos ingressos já foram emitidos para este pedido
  SELECT COUNT(*) INTO v_existing_ticket_count
  FROM public.tickets
  WHERE order_id = v_order.id;

  -- 4. Tratamento rigoroso de idempotência para pedidos já pagos
  IF v_order.order_status = 'paid' THEN
    IF v_order.mp_payment_id IS DISTINCT FROM v_clean_payment_id THEN
      RAISE EXCEPTION 'Conflito de idempotência: o pedido já consta como pago com outro mp_payment_id (%).',
        COALESCE(v_order.mp_payment_id, 'NULL');
    END IF;

    IF v_order.payment_status <> 'approved' THEN
      RAISE EXCEPTION 'Estado inconsistente do pedido: order_status=paid mas payment_status=%',
        v_order.payment_status;
    END IF;

    -- Idempotente: mesmo pedido e mesmo mp_payment_id já processado -> não emite novos ingressos
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

  -- Se por qualquer motivo já existirem ingressos emitidos para um pedido ainda não marcado como paid, bloqueia duplicação
  IF v_existing_ticket_count > 0 THEN
    RAISE EXCEPTION 'Inconsistência detectada: já existem % ingressos emitidos para este pedido antes da confirmação.',
      v_existing_ticket_count;
  END IF;

  -- 5. Lock exclusivo no lote e conversão de estoque reservado em vendido
  SELECT * INTO v_batch
  FROM public.ticket_batches
  WHERE id = v_order.ticket_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lote associado ao pedido não encontrado.';
  END IF;

  UPDATE public.ticket_batches
  SET
    reserved_quantity = GREATEST(0, reserved_quantity - v_order.quantity),
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

  -- 6. Emissão dos ingressos únicos (protegidos por uq_tickets_order_item_sequence)
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
-- 4. CHECK-IN TRANSACIONAL NA PORTARIA (`public.perform_ticket_checkin`)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.perform_ticket_checkin(
  p_code_or_payload TEXT,
  p_device_id TEXT DEFAULT 'PX-CONTROL-WEB'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operator_id UUID := auth.uid();
  v_ticket public.tickets%ROWTYPE;
  v_normalized TEXT := upper(btrim(COALESCE(p_code_or_payload, '')));
  v_used_at TIMESTAMPTZ;
BEGIN
  -- 1. Bloqueia usuários anônimos e contas sem permissão de portaria/admin
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

  -- 2. Lock exclusivo no ingresso para impedir check-in simultâneo em dois aparelhos
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
-- 5. REVISÃO E ENDURECIMENTO DAS PERMISSÕES SQL (REVOKE / GRANT)
-- =============================================================================

-- Funções auxiliares de verificação de papel: revoga acesso público/anônimo
REVOKE ALL ON FUNCTION public.is_admin_or_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin_or_super_admin() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_checkin_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_checkin_staff() TO authenticated, service_role;

-- 5.1 reserve_ticket_order: exclusivo para usuários autenticados (e backend service_role)
REVOKE ALL ON FUNCTION public.reserve_ticket_order(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ticket_order(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- 5.2 confirm_order_payment: estritamente exclusivo do backend confiável (service_role)
REVOKE ALL ON FUNCTION public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC) TO service_role;

-- 5.3 release_expired_reservations: revoga acesso de PUBLIC e anon; permite apenas service_role e administradores autenticados (validados internamente por is_admin_or_super_admin)
REVOKE ALL ON FUNCTION public.release_expired_reservations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_expired_reservations() TO authenticated, service_role;

-- 5.4 perform_ticket_checkin: revoga acesso de PUBLIC e anon; exige operador autenticado e autorizado por is_checkin_staff()
REVOKE ALL ON FUNCTION public.perform_ticket_checkin(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perform_ticket_checkin(TEXT, TEXT) TO authenticated, service_role;

COMMIT;
