-- =============================================================================
-- PX CUSTON — Plataforma de Ingressos, Eventos & Check-in Online
-- Migration: 001_initial_schema.sql
-- Descrição: Estrutura inicial de produção para PostgreSQL / Supabase
-- Domínios: profiles, events, ticket_categories, ticket_batches, orders, tickets
-- Segurança: Row Level Security (RLS) restritivo, controle transacional de
--            estoque (FOR UPDATE) e proteção contra aprovação de pagamento no cliente.
-- =============================================================================

BEGIN;

-- Extensão para geração de UUIDs criptograficamente seguros
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. FUNÇÃO UTILITÁRIA DE AUDITORIA (updated_at)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- =============================================================================
-- 2. TABELA: public.profiles
-- Vinculada 1:1 com auth.users. Armazena dados do cliente e papel (role)
-- protegido no servidor.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL CHECK (char_length(btrim(full_name)) >= 3),
  cpf TEXT UNIQUE CHECK (cpf IS NULL OR char_length(regexp_replace(cpf, '\D', '', 'g')) = 11),
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  city TEXT,
  role TEXT NOT NULL DEFAULT 'customer'
    CHECK (role IN ('customer', 'checkin_operator', 'admin', 'SUPER_ADMIN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_cpf ON public.profiles(cpf);

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Funções de verificação de autorização no servidor (nunca confiam em dados vindos do navegador)
CREATE OR REPLACE FUNCTION public.is_admin_or_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('admin', 'SUPER_ADMIN')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_checkin_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('checkin_operator', 'admin', 'SUPER_ADMIN')
  );
$$;

-- Trigger que impede elevação de privilégio (usuário comum alterar o próprio role ou CPF validado)
CREATE OR REPLACE FUNCTION public.prevent_profile_privilege_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF v_jwt_role <> 'service_role' AND NOT public.is_admin_or_super_admin() THEN
      RAISE EXCEPTION 'Operação negada: alteração de papel administrativo não autorizada.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_prevent_escalation ON public.profiles;
CREATE TRIGGER trg_profiles_prevent_escalation
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_profile_privilege_escalation();

-- Trigger automático para criar profile sempre que um usuário se cadastrar no Supabase Auth
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- =============================================================================
-- 3. TABELA: public.events
-- Eventos oficiais organizados exclusivamente pela equipe PX CUSTON.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (char_length(btrim(slug)) >= 3),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) >= 3),
  subtitle TEXT,
  category_slug TEXT NOT NULL,
  category_name TEXT NOT NULL,
  event_date DATE NOT NULL,
  time_range TEXT NOT NULL,
  city TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  starting_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (starting_price >= 0),
  banner_url TEXT NOT NULL,
  card_image_url TEXT NOT NULL,
  gallery_urls TEXT[] NOT NULL DEFAULT '{}',
  description TEXT NOT NULL,
  highlights TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'ended', 'cancelled')),
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  tickets_sold INTEGER NOT NULL DEFAULT 0 CHECK (tickets_sold >= 0 AND tickets_sold <= capacity),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_status_date ON public.events(status, event_date);
CREATE INDEX IF NOT EXISTS idx_events_category_slug ON public.events(category_slug);
CREATE INDEX IF NOT EXISTS idx_events_featured ON public.events(featured) WHERE status = 'published';

DROP TRIGGER IF EXISTS trg_events_updated_at ON public.events;
CREATE TRIGGER trg_events_updated_at
  BEFORE UPDATE ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 4. TABELA: public.ticket_categories
-- Categorias de ingresso de um evento (ex.: Pista, VIP, Exposição de Veículos).
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.ticket_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) >= 2),
  slug TEXT NOT NULL CHECK (char_length(btrim(slug)) >= 2),
  description TEXT,
  max_per_order INTEGER NOT NULL DEFAULT 10 CHECK (max_per_order > 0 AND max_per_order <= 50),
  sort_order INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ticket_categories_event_slug UNIQUE (event_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_ticket_categories_event_id ON public.ticket_categories(event_id);

DROP TRIGGER IF EXISTS trg_ticket_categories_updated_at ON public.ticket_categories;
CREATE TRIGGER trg_ticket_categories_updated_at
  BEFORE UPDATE ON public.ticket_categories
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 5. TABELA: public.ticket_batches
-- Lotes de ingressos (1º Lote Promocional, 2º Lote, etc.) com trava de estoque
-- no banco: reserved_quantity + sold_quantity <= total_quantity.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.ticket_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.ticket_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) >= 2),
  batch_number INTEGER NOT NULL CHECK (batch_number >= 1),
  description TEXT,
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  total_quantity INTEGER NOT NULL CHECK (total_quantity > 0),
  reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  sold_quantity INTEGER NOT NULL DEFAULT 0 CHECK (sold_quantity >= 0),
  thumbnail_url TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_batch_inventory_bounds
    CHECK (reserved_quantity + sold_quantity <= total_quantity),
  CONSTRAINT chk_batch_sales_window
    CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_ticket_batches_event_id ON public.ticket_batches(event_id);
CREATE INDEX IF NOT EXISTS idx_ticket_batches_category_id ON public.ticket_batches(category_id);
CREATE INDEX IF NOT EXISTS idx_ticket_batches_active ON public.ticket_batches(event_id, active);

DROP TRIGGER IF EXISTS trg_ticket_batches_updated_at ON public.ticket_batches;
CREATE TRIGGER trg_ticket_batches_updated_at
  BEFORE UPDATE ON public.ticket_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 6. TABELA: public.orders
-- Pedidos de compra. Nenhum pedido pode ter order_status = 'paid' sem
-- payment_status = 'approved', mp_payment_id preenchido e paid_at registrado.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  ticket_batch_id UUID NOT NULL REFERENCES public.ticket_batches(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 20),
  buyer_name TEXT NOT NULL CHECK (char_length(btrim(buyer_name)) >= 5),
  buyer_cpf TEXT NOT NULL CHECK (char_length(regexp_replace(buyer_cpf, '\D', '', 'g')) = 11),
  buyer_email TEXT NOT NULL,
  buyer_phone TEXT NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0),
  convenience_fee NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (convenience_fee >= 0),
  total_amount NUMERIC(12, 2) NOT NULL CHECK (total_amount >= 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('pix', 'credit_card')),
  order_status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (order_status IN ('pending_payment', 'reserved', 'paid', 'cancelled', 'expired', 'refunded')),
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'in_process', 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back')),
  mp_preference_id TEXT,
  mp_payment_id TEXT UNIQUE,
  reservation_expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_order_math_consistency
    CHECK (subtotal = round(unit_price * quantity, 2) AND total_amount = subtotal + convenience_fee),
  CONSTRAINT chk_order_paid_requires_approved_payment
    CHECK (
      order_status <> 'paid'
      OR (payment_status = 'approved' AND mp_payment_id IS NOT NULL AND paid_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_event_id ON public.orders(event_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(order_status, payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_reservation_expiry
  ON public.orders(reservation_expires_at)
  WHERE order_status IN ('pending_payment', 'reserved');

DROP TRIGGER IF EXISTS trg_orders_updated_at ON public.orders;
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 7. TABELA: public.tickets
-- Ingressos individuais com QR Code único emitidos exclusivamente após
-- confirmação oficial do pagamento.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  qr_payload TEXT NOT NULL UNIQUE,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  category_id UUID NOT NULL REFERENCES public.ticket_categories(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES public.ticket_batches(id) ON DELETE RESTRICT,
  holder_name TEXT NOT NULL,
  holder_cpf TEXT NOT NULL CHECK (char_length(regexp_replace(holder_cpf, '\D', '', 'g')) = 11),
  price_paid NUMERIC(12, 2) NOT NULL CHECK (price_paid >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded', 'used', 'expired')),
  mp_payment_id TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  used_by_operator_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  checkin_device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ticket_used_requires_timestamp
    CHECK (status <> 'used' OR used_at IS NOT NULL),
  CONSTRAINT chk_ticket_paid_or_used_requires_payment
    CHECK (status NOT IN ('paid', 'used') OR mp_payment_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON public.tickets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_order_id ON public.tickets(order_id);
CREATE INDEX IF NOT EXISTS idx_tickets_event_status ON public.tickets(event_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_code ON public.tickets(code);

DROP TRIGGER IF EXISTS trg_tickets_updated_at ON public.tickets;
CREATE TRIGGER trg_tickets_updated_at
  BEFORE UPDATE ON public.tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 8. CONTROLE TRANSACIONAL DE ESTOQUE, RESERVA E CONFIRMAÇÃO (RPCs)
-- =============================================================================

-- 8.1 Reserva transacional de lote (bloqueia linha com FOR UPDATE para evitar overselling)
CREATE OR REPLACE FUNCTION public.reserve_ticket_order(
  p_batch_id UUID,
  p_quantity INTEGER,
  p_payment_method TEXT,
  p_buyer_name TEXT,
  p_buyer_cpf TEXT,
  p_buyer_email TEXT,
  p_buyer_phone TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_batch public.ticket_batches%ROWTYPE;
  v_event public.events%ROWTYPE;
  v_category public.ticket_categories%ROWTYPE;
  v_subtotal NUMERIC(12, 2);
  v_fee NUMERIC(12, 2);
  v_total NUMERIC(12, 2);
  v_order_id UUID;
  v_order_code TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória para reservar ingressos.';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantidade inválida.';
  END IF;

  -- Lock exclusivo no lote para impedir que compras simultâneas ultrapassem o estoque
  SELECT * INTO v_batch
  FROM public.ticket_batches
  WHERE id = p_batch_id
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

  -- Recalcula valores no servidor a partir do preço oficial do lote (nunca confia no frontend)
  v_subtotal := round(v_batch.price * p_quantity, 2);
  v_fee := round(v_subtotal * 0.06, 2);
  v_total := v_subtotal + v_fee;
  v_order_code := '#PX-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  -- Incrementa estoque reservado
  UPDATE public.ticket_batches
  SET reserved_quantity = reserved_quantity + p_quantity
  WHERE id = v_batch.id;

  -- Cria pedido com status 'reserved' e payment_status 'pending' (expira em 30 min se não pago)
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
    btrim(p_buyer_name),
    regexp_replace(p_buyer_cpf, '\D', '', 'g'),
    btrim(p_buyer_email),
    btrim(p_buyer_phone),
    v_batch.price,
    v_subtotal,
    v_fee,
    v_total,
    p_payment_method,
    'reserved',
    'pending',
    NOW() + INTERVAL '30 minutes'
  )
  RETURNING id INTO v_order_id;

  RETURN v_order_id;
END;
$$;

-- 8.2 Confirmação transacional do pagamento e emissão dos ingressos (exclusivo service_role / Webhook)
CREATE OR REPLACE FUNCTION public.confirm_order_payment(
  p_order_id UUID,
  p_mp_payment_id TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_order public.orders%ROWTYPE;
  v_batch public.ticket_batches%ROWTYPE;
  v_ticket_code TEXT;
  v_qr_payload TEXT;
  v_i INTEGER;
BEGIN
  -- Somente backend com service_role (ou superuser no SQL Editor) pode aprovar pagamentos
  IF v_jwt_role <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Operação restrita ao webhook/servidor oficial de pagamentos.';
  END IF;

  IF p_mp_payment_id IS NULL OR btrim(p_mp_payment_id) = '' THEN
    RAISE EXCEPTION 'Identificador oficial de pagamento do Mercado Pago é obrigatório.';
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado.';
  END IF;

  -- Idempotência: se já estiver pago com o mesmo pagamento, retorna quantidade já emitida
  IF v_order.order_status = 'paid' THEN
    RETURN v_order.quantity;
  END IF;

  IF v_order.order_status NOT IN ('pending_payment', 'reserved') THEN
    RAISE EXCEPTION 'Pedido em estado inválido para confirmação (%).', v_order.order_status;
  END IF;

  SELECT * INTO v_batch
  FROM public.ticket_batches
  WHERE id = v_order.ticket_batch_id
  FOR UPDATE;

  -- Converte estoque reservado em vendido
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
    mp_payment_id = btrim(p_mp_payment_id),
    paid_at = NOW()
  WHERE id = v_order.id;

  -- Emite os ingressos nominais vinculados ao pedido e pagamento
  FOR v_i IN 1..v_order.quantity LOOP
    v_ticket_code := 'PX-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    v_qr_payload := 'PXCUSTON|' || v_ticket_code || '|' || v_order.event_id::text || '|' || v_i::text;

    INSERT INTO public.tickets (
      code,
      qr_payload,
      order_id,
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
      v_order.user_id,
      v_order.event_id,
      v_batch.category_id,
      v_batch.id,
      v_order.buyer_name,
      v_order.buyer_cpf,
      v_order.unit_price,
      'paid',
      btrim(p_mp_payment_id),
      NOW()
    );
  END LOOP;

  RETURN v_order.quantity;
END;
$$;

-- 8.3 Liberação transacional de reservas expiradas (devolve estoque ao lote)
CREATE OR REPLACE FUNCTION public.release_expired_reservations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_rec RECORD;
  v_released_count INTEGER := 0;
BEGIN
  IF v_jwt_role <> 'service_role' AND NOT public.is_admin_or_super_admin() AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Operação não autorizada.';
  END IF;

  FOR v_rec IN
    SELECT id, ticket_batch_id, quantity
    FROM public.orders
    WHERE order_status IN ('pending_payment', 'reserved')
      AND reservation_expires_at IS NOT NULL
      AND reservation_expires_at < NOW()
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.ticket_batches
    SET reserved_quantity = GREATEST(0, reserved_quantity - v_rec.quantity)
    WHERE id = v_rec.ticket_batch_id;

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

-- 8.4 Check-in transacional anti-reutilização na portaria (PX CONTROL)
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
  v_ticket public.tickets%ROWTYPE;
  v_normalized TEXT := upper(btrim(COALESCE(p_code_or_payload, '')));
BEGIN
  IF NOT public.is_checkin_staff() THEN
    RAISE EXCEPTION 'Acesso negado: apenas operadores de check-in ou administradores podem validar ingressos.';
  END IF;

  SELECT * INTO v_ticket
  FROM public.tickets
  WHERE upper(code) = v_normalized
     OR upper(qr_payload) = v_normalized
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'status_reason', 'invalid',
      'message', 'Ingresso não localizado na base oficial PX CUSTON.'
    );
  END IF;

  IF v_ticket.status = 'used' THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'status_reason', 'already_used',
      'ticket_id', v_ticket.id,
      'code', v_ticket.code,
      'used_at', v_ticket.used_at,
      'message', 'Ingresso já utilizado anteriormente. Reutilização bloqueada.'
    );
  END IF;

  IF v_ticket.status <> 'paid' THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'status_reason', 'unpaid',
      'ticket_id', v_ticket.id,
      'code', v_ticket.code,
      'status', v_ticket.status,
      'message', 'Entrada negada: ingresso sem pagamento confirmado.'
    );
  END IF;

  UPDATE public.tickets
  SET
    status = 'used',
    used_at = NOW(),
    used_by_operator_id = auth.uid(),
    checkin_device_id = p_device_id
  WHERE id = v_ticket.id;

  RETURN jsonb_build_object(
    'authorized', true,
    'status_reason', 'authorized',
    'ticket_id', v_ticket.id,
    'code', v_ticket.code,
    'holder_name', v_ticket.holder_name,
    'used_at', NOW(),
    'message', 'Entrada autorizada!'
  );
END;
$$;

-- =============================================================================
-- 9. ROW LEVEL SECURITY (RLS) E POLÍTICAS DE ACESSO RESTRITIVAS
-- =============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events FORCE ROW LEVEL SECURITY;

ALTER TABLE public.ticket_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_categories FORCE ROW LEVEL SECURITY;

ALTER TABLE public.ticket_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_batches FORCE ROW LEVEL SECURITY;

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;

ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets FORCE ROW LEVEL SECURITY;

-- 9.1 Políticas para public.profiles (Dados pessoais protegidos: cada usuário vê apenas o próprio perfil)
DROP POLICY IF EXISTS profiles_select_own_or_admin ON public.profiles;
CREATE POLICY profiles_select_own_or_admin
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id OR public.is_admin_or_super_admin());

DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own
  ON public.profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id AND role = 'customer');

DROP POLICY IF EXISTS profiles_update_own_or_admin ON public.profiles;
CREATE POLICY profiles_update_own_or_admin
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id OR public.is_admin_or_super_admin())
  WITH CHECK (auth.uid() = id OR public.is_admin_or_super_admin());

-- 9.2 Políticas para public.events (Público consulta apenas publicados; escrita exclusiva para admins)
DROP POLICY IF EXISTS events_select_published_or_admin ON public.events;
CREATE POLICY events_select_published_or_admin
  ON public.events
  FOR SELECT
  TO anon, authenticated
  USING (status = 'published' OR public.is_admin_or_super_admin());

DROP POLICY IF EXISTS events_admin_insert ON public.events;
CREATE POLICY events_admin_insert
  ON public.events
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin_or_super_admin());

DROP POLICY IF EXISTS events_admin_update ON public.events;
CREATE POLICY events_admin_update
  ON public.events
  FOR UPDATE
  TO authenticated
  USING (public.is_admin_or_super_admin())
  WITH CHECK (public.is_admin_or_super_admin());

DROP POLICY IF EXISTS events_admin_delete ON public.events;
CREATE POLICY events_admin_delete
  ON public.events
  FOR DELETE
  TO authenticated
  USING (public.is_admin_or_super_admin());

-- 9.3 Políticas para public.ticket_categories
DROP POLICY IF EXISTS ticket_categories_select_public_or_admin ON public.ticket_categories;
CREATE POLICY ticket_categories_select_public_or_admin
  ON public.ticket_categories
  FOR SELECT
  TO anon, authenticated
  USING (
    (
      active = TRUE
      AND EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = ticket_categories.event_id AND e.status = 'published'
      )
    )
    OR public.is_admin_or_super_admin()
  );

DROP POLICY IF EXISTS ticket_categories_admin_write ON public.ticket_categories;
CREATE POLICY ticket_categories_admin_write
  ON public.ticket_categories
  FOR ALL
  TO authenticated
  USING (public.is_admin_or_super_admin())
  WITH CHECK (public.is_admin_or_super_admin());

-- 9.4 Políticas para public.ticket_batches
DROP POLICY IF EXISTS ticket_batches_select_public_or_admin ON public.ticket_batches;
CREATE POLICY ticket_batches_select_public_or_admin
  ON public.ticket_batches
  FOR SELECT
  TO anon, authenticated
  USING (
    (
      active = TRUE
      AND EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = ticket_batches.event_id AND e.status = 'published'
      )
    )
    OR public.is_admin_or_super_admin()
  );

DROP POLICY IF EXISTS ticket_batches_admin_write ON public.ticket_batches;
CREATE POLICY ticket_batches_admin_write
  ON public.ticket_batches
  FOR ALL
  TO authenticated
  USING (public.is_admin_or_super_admin())
  WITH CHECK (public.is_admin_or_super_admin());

-- 9.5 Políticas para public.orders (Clientes só consultam os próprios pedidos; nunca aprovam pagamentos direto)
DROP POLICY IF EXISTS orders_select_own_or_admin ON public.orders;
CREATE POLICY orders_select_own_or_admin
  ON public.orders
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.is_admin_or_super_admin());

-- Inserção direta exige status inicial pendente (recomenda-se usar RPC public.reserve_ticket_order)
DROP POLICY IF EXISTS orders_insert_own_pending ON public.orders;
CREATE POLICY orders_insert_own_pending
  ON public.orders
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND order_status IN ('pending_payment', 'reserved')
    AND payment_status = 'pending'
    AND mp_payment_id IS NULL
    AND paid_at IS NULL
  );

DROP POLICY IF EXISTS orders_admin_update ON public.orders;
CREATE POLICY orders_admin_update
  ON public.orders
  FOR UPDATE
  TO authenticated
  USING (public.is_admin_or_super_admin())
  WITH CHECK (public.is_admin_or_super_admin());

-- 9.6 Políticas para public.tickets (Clientes só consultam seus ingressos; equipe de check-in e admins consultam na portaria)
DROP POLICY IF EXISTS tickets_select_own_or_staff ON public.tickets;
CREATE POLICY tickets_select_own_or_staff
  ON public.tickets
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.is_checkin_staff());

DROP POLICY IF EXISTS tickets_admin_manage ON public.tickets;
CREATE POLICY tickets_admin_manage
  ON public.tickets
  FOR ALL
  TO authenticated
  USING (public.is_admin_or_super_admin())
  WITH CHECK (public.is_admin_or_super_admin());

-- Permissões explícitas de execução das funções RPC
REVOKE ALL ON FUNCTION public.confirm_order_payment(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ticket_order(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.perform_ticket_checkin(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_expired_reservations() TO authenticated;

COMMIT;
