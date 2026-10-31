import type {
  Ticket,
  TicketStatus,
  CheckinRecord,
  OrderStatus,
  PaymentStatus,
  PaymentMethodType,
  ReserveOrderRpcArgs,
  ReserveOrderRpcPayload,
  CheckinRpcPayload,
  Profile,
  DbProfileRow,
  UserRole,
  AdminAccessEvaluation,
  EventStatus,
  DbEventRow,
  AdminEventFormInput,
  DbEventWritePayload,
} from '../types/domain';

export const CONVENIENCE_FEE_RATE = 0.06; // 6% convenience fee (e.g., R$ 80,00 -> R$ 4,80)

export interface OrderTotals {
  subtotal: number;
  convenienceFee: number;
  total: number;
}

/**
 * Calculates subtotal, 6% convenience fee, and final total in BRL.
 * Matches reference checkout math: 2 x R$ 40,00 = R$ 80,00 + R$ 4,80 = R$ 84,80.
 */
export function calculateOrderTotals(unitPrice: number, quantity: number): OrderTotals {
  const safeQty = Math.max(0, Math.floor(quantity));
  const safePrice = Math.max(0, unitPrice);
  const subtotal = Number((safePrice * safeQty).toFixed(2));
  const convenienceFee = Number((subtotal * CONVENIENCE_FEE_RATE).toFixed(2));
  const total = Number((subtotal + convenienceFee).toFixed(2));
  return { subtotal, convenienceFee, total };
}

/**
 * Formats a numeric value in Brazilian Real (BRL) currency format (e.g. R$ 40,00).
 */
export function formatBRL(value: number): string {
  const fixed = value.toFixed(2).replace('.', ',');
  const parts = fixed.split(',');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${parts.join(',')}`;
}

/**
 * Validates buyer checkout inputs before proceeding to payment preference creation.
 */
export interface BuyerInput {
  fullName: string;
  cpf: string;
  email: string;
  phone: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: Partial<Record<keyof BuyerInput, string>>;
}

export function validateBuyerData(input: BuyerInput): ValidationResult {
  const errors: Partial<Record<keyof BuyerInput, string>> = {};

  const trimmedName = input.fullName.trim();
  if (trimmedName.length < 5 || !trimmedName.includes(' ')) {
    errors.fullName = 'Informe o nome e sobrenome completos.';
  }

  const digitsCpf = input.cpf.replace(/\D/g, '');
  if (digitsCpf.length !== 11 || /^(\d)\1{10}$/.test(digitsCpf)) {
    errors.cpf = 'Informe um CPF válido com 11 dígitos.';
  }

  const trimmedEmail = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    errors.email = 'Informe um endereço de e-mail válido.';
  }

  const digitsPhone = input.phone.replace(/\D/g, '');
  if (digitsPhone.length < 10 || digitsPhone.length > 11) {
    errors.phone = 'Informe um telefone com DDD (10 ou 11 dígitos).';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Validates stock availability and reservation constraints for a ticket batch.
 * Mirrors PostgreSQL constraint: reserved_quantity + sold_quantity + requested <= total_quantity.
 */
export interface BatchStockCheckInput {
  totalQuantity: number;
  reservedQuantity: number;
  soldQuantity: number;
  requestedQuantity: number;
  maxPerOrder?: number;
  isActive?: boolean;
  eventCapacity?: number;
  eventTicketsSold?: number;
  eventTotalReservedAcrossBatches?: number;
  eventTotalSoldAcrossBatches?: number;
}

export interface BatchStockCheckResult {
  canReserve: boolean;
  availableQuantity: number;
  nextReservedQuantity: number;
  reason?: string;
}

export function validateBatchStockAvailability(
  input: BatchStockCheckInput
): BatchStockCheckResult {
  const batchAvailable = Math.max(
    0,
    input.totalQuantity - input.reservedQuantity - input.soldQuantity
  );

  // Never use GREATEST/Math.max to mask divergence between events.tickets_sold and SUM(ticket_batches.sold_quantity)
  if (
    typeof input.eventTicketsSold === 'number' &&
    typeof input.eventTotalSoldAcrossBatches === 'number' &&
    input.eventTicketsSold !== input.eventTotalSoldAcrossBatches
  ) {
    return {
      canReserve: false,
      availableQuantity: 0,
      nextReservedQuantity: input.reservedQuantity,
      reason: `Inconsistência de integridade de estoque: events.tickets_sold (${input.eventTicketsSold}) diverge da soma de sold_quantity dos lotes (${input.eventTotalSoldAcrossBatches}).`,
    };
  }

  let effectiveAvailable = batchAvailable;
  if (typeof input.eventCapacity === 'number' && Number.isFinite(input.eventCapacity)) {
    const globalSold =
      input.eventTicketsSold ?? input.eventTotalSoldAcrossBatches ?? input.soldQuantity;
    const globalReserved = input.eventTotalReservedAcrossBatches ?? input.reservedQuantity;
    const globalRemaining = Math.max(0, input.eventCapacity - globalSold - globalReserved);
    effectiveAvailable = Math.min(batchAvailable, globalRemaining);
  }

  if (input.isActive === false) {
    return {
      canReserve: false,
      availableQuantity: effectiveAvailable,
      nextReservedQuantity: input.reservedQuantity,
      reason: 'Este lote não está ativo para vendas no momento.',
    };
  }

  const maxPerOrder = input.maxPerOrder ?? 10;
  if (input.requestedQuantity <= 0 || !Number.isInteger(input.requestedQuantity)) {
    return {
      canReserve: false,
      availableQuantity: effectiveAvailable,
      nextReservedQuantity: input.reservedQuantity,
      reason: 'Quantidade solicitada inválida.',
    };
  }

  if (input.requestedQuantity > maxPerOrder) {
    return {
      canReserve: false,
      availableQuantity: effectiveAvailable,
      nextReservedQuantity: input.reservedQuantity,
      reason: `Limite máximo de ${maxPerOrder} ingressos por pedido excedido.`,
    };
  }

  if (typeof input.eventCapacity === 'number' && Number.isFinite(input.eventCapacity)) {
    const globalSold =
      input.eventTicketsSold ?? input.eventTotalSoldAcrossBatches ?? input.soldQuantity;
    const globalReserved = input.eventTotalReservedAcrossBatches ?? input.reservedQuantity;
    if (globalSold + globalReserved + input.requestedQuantity > input.eventCapacity) {
      return {
        canReserve: false,
        availableQuantity: effectiveAvailable,
        nextReservedQuantity: input.reservedQuantity,
        reason: 'Capacidade total do evento insuficiente para a quantidade solicitada.',
      };
    }
  }

  if (input.requestedQuantity > batchAvailable) {
    return {
      canReserve: false,
      availableQuantity: effectiveAvailable,
      nextReservedQuantity: input.reservedQuantity,
      reason: 'Estoque insuficiente no lote selecionado para a quantidade desejada.',
    };
  }

  return {
    canReserve: true,
    availableQuantity: effectiveAvailable - input.requestedQuantity,
    nextReservedQuantity: input.reservedQuantity + input.requestedQuantity,
  };
}

/**
 * Ensures an order cannot be marked as 'paid' without an official 'approved' payment status
 * and a valid gateway reference ID (mirrors chk_order_paid_requires_approved_payment).
 */
export function canTransitionOrderToPaid(params: {
  currentOrderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  mpPaymentId?: string | null;
}): { allowed: boolean; reason?: string } {
  if (
    params.currentOrderStatus === 'cancelled' ||
    params.currentOrderStatus === 'expired' ||
    params.currentOrderStatus === 'refunded'
  ) {
    return {
      allowed: false,
      reason: `Pedido em estado "${params.currentOrderStatus}" não pode ser marcado como pago.`,
    };
  }

  if (params.paymentStatus !== 'approved') {
    return {
      allowed: false,
      reason: 'O pedido só pode ser confirmado após aprovação oficial do pagamento (payment_status = approved).',
    };
  }

  if (!params.mpPaymentId || params.mpPaymentId.trim().length === 0) {
    return {
      allowed: false,
      reason: 'Identificador oficial da transação (mp_payment_id) é obrigatório para confirmar o pagamento.',
    };
  }

  return { allowed: true };
}

/**
 * Builds the exact parameter object for `public.reserve_ticket_order` (migration 002).
 * Enforces an authenticated user session and strips any client-side price fields so
 * prices and totals are calculated strictly in PostgreSQL.
 */
export function buildReserveOrderRpcArgs(params: {
  authenticatedUserId?: string | null;
  ticketBatchId: string;
  quantity: number;
  buyerName: string;
  buyerCpf: string;
  buyerEmail: string;
  buyerPhone: string;
  paymentMethod: PaymentMethodType;
}): { ok: true; args: ReserveOrderRpcArgs } | { ok: false; errorMessage: string } {
  if (!params.authenticatedUserId || params.authenticatedUserId.trim().length === 0) {
    return {
      ok: false,
      errorMessage: 'Autenticação obrigatória para reservar ingressos.',
    };
  }

  const batchId = params.ticketBatchId.trim();
  if (!batchId) {
    return {
      ok: false,
      errorMessage: 'Lote de ingresso (p_ticket_batch_id) é obrigatório.',
    };
  }

  if (!Number.isInteger(params.quantity) || params.quantity <= 0) {
    return {
      ok: false,
      errorMessage: 'Quantidade solicitada inválida.',
    };
  }

  const buyerValidation = validateBuyerData({
    fullName: params.buyerName,
    cpf: params.buyerCpf,
    email: params.buyerEmail,
    phone: params.buyerPhone,
  });

  if (!buyerValidation.valid) {
    const firstError =
      buyerValidation.errors.fullName ||
      buyerValidation.errors.cpf ||
      buyerValidation.errors.email ||
      buyerValidation.errors.phone ||
      'Dados do comprador inválidos.';
    return {
      ok: false,
      errorMessage: firstError,
    };
  }

  return {
    ok: true,
    args: {
      p_ticket_batch_id: batchId,
      p_quantity: params.quantity,
      p_payment_method: params.paymentMethod,
      p_buyer_name: params.buyerName.trim(),
      p_buyer_cpf: params.buyerCpf.replace(/\D/g, ''),
      p_buyer_email: params.buyerEmail.trim(),
      p_buyer_phone: params.buyerPhone.trim(),
    },
  };
}

/**
 * Validates and normalizes the JSONB response returned by `public.reserve_ticket_order`.
 */
export function normalizeReserveOrderRpcResponse(raw: unknown): {
  ok: boolean;
  orderId?: string;
  orderCode?: string;
  unitPrice?: number;
  subtotal?: number;
  convenienceFee?: number;
  totalAmount?: number;
  orderStatus?: OrderStatus;
  paymentStatus?: PaymentStatus;
  reservationExpiresAt?: string;
  errorMessage?: string;
} {
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      errorMessage: 'Formato de resposta inválido ao reservar pedido no banco.',
    };
  }

  const payload = raw as Partial<ReserveOrderRpcPayload>;
  if (
    typeof payload.order_id !== 'string' ||
    !payload.order_id ||
    typeof payload.order_code !== 'string' ||
    !payload.order_code ||
    typeof payload.reservation_expires_at !== 'string' ||
    !payload.reservation_expires_at
  ) {
    return {
      ok: false,
      errorMessage: 'Resposta incompleta de reserve_ticket_order.',
    };
  }

  const unitPrice = Number(payload.unit_price ?? 0);
  const subtotal = Number(payload.subtotal ?? 0);
  const convenienceFee = Number(payload.convenience_fee ?? 0);
  const totalAmount = Number(payload.total_amount);

  if (Number.isNaN(totalAmount) || totalAmount < 0) {
    return {
      ok: false,
      errorMessage: 'Valor total retornado pelo banco é inválido.',
    };
  }

  return {
    ok: true,
    orderId: payload.order_id,
    orderCode: payload.order_code,
    unitPrice,
    subtotal,
    convenienceFee,
    totalAmount,
    orderStatus: payload.order_status ?? 'reserved',
    paymentStatus: payload.payment_status ?? 'pending',
    reservationExpiresAt: payload.reservation_expires_at,
  };
}

/**
 * Normalizes the JSONB response from `public.perform_ticket_checkin`.
 * Supports both `result`/`ticket_code` (migration 002) and `status_reason`/`code` (migration 001).
 */
export function normalizeCheckinRpcResponse(raw: unknown): {
  ok: boolean;
  authorized: boolean;
  result: 'authorized' | 'already_used' | 'invalid' | 'unpaid';
  message: string;
  ticketId?: string;
  ticketCode?: string;
  holderName?: string;
  usedAt?: string;
} {
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      authorized: false,
      result: 'invalid',
      message: 'Retorno vazio ou inválido da função de check-in.',
    };
  }

  const payload = raw as Partial<CheckinRpcPayload>;
  const resolvedResult = payload.result ?? payload.status_reason ?? 'invalid';
  const validResults = new Set(['authorized', 'already_used', 'invalid', 'unpaid']);
  const safeResult = validResults.has(resolvedResult)
    ? (resolvedResult as 'authorized' | 'already_used' | 'invalid' | 'unpaid')
    : 'invalid';

  const resolvedTicketCode = payload.ticket_code ?? payload.code;

  return {
    ok: true,
    authorized: Boolean(payload.authorized && safeResult === 'authorized'),
    result: safeResult,
    message:
      typeof payload.message === 'string' && payload.message.trim().length > 0
        ? payload.message
        : 'Retorno de check-in processado.',
    ticketId: payload.ticket_id,
    ticketCode: resolvedTicketCode,
    holderName: payload.holder_name,
    usedAt: payload.used_at,
  };
}

/**
 * Evaluates idempotency and security rules for `confirm_order_payment` (mirrors migration 002).
 * - Requires backend `service_role` caller.
 * - Requires prior official Mercado Pago API verification (`paymentVerifiedFromOfficialMpApi === true`).
 * - Requires official gateway status `'approved'`, non-null `verifiedGatewayAmount` matching `orderTotalAmount`,
 *   `verifiedCurrency === 'BRL'`, and `externalReference` matching `orderId` or `orderCode`.
 * - Rejects reuse of an `mp_payment_id` already bound to another order.
 * - If order is already `'paid'`, only succeeds as an idempotent replay (0 new tickets emitted, 0 stock increment)
 *   when `incomingMpPaymentId` matches `existingMpPaymentId` and `existingTicketsCount === orderQuantity`.
 */
export function evaluatePaymentConfirmationIdempotency(params: {
  callerRole: 'service_role' | 'authenticated' | 'anon';
  paymentVerifiedFromOfficialMpApi: boolean;
  orderId: string;
  orderCode: string;
  orderQuantity: number;
  orderTotalAmount: number;
  currentOrderStatus: OrderStatus;
  currentPaymentStatus: PaymentStatus;
  existingMpPaymentId: string | null;
  existingTicketsCount: number;
  incomingMpPaymentId: string;
  incomingMpPaymentStatus: PaymentStatus;
  verifiedGatewayAmount: number | null | undefined;
  verifiedCurrency: string | null | undefined;
  externalReference: string | null | undefined;
  paymentIdUsedByOtherOrder?: boolean;
  eventCapacity?: number;
  eventTicketsSold?: number;
  eventTotalSoldAcrossBatches?: number;
  eventTotalReservedAcrossBatches?: number;
  batchReservedQuantity?: number;
  batchSoldQuantity?: number;
  batchTotalQuantity?: number;
}): {
  allowed: boolean;
  idempotentReplay: boolean;
  ticketsToIssue: number;
  soldQuantityDelta: number;
  reservedQuantityDelta?: number;
  errorMessage?: string;
} {
  if (params.callerRole !== 'service_role') {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage: 'Operação restrita exclusivamente ao backend oficial de pagamentos (service_role).',
    };
  }

  if (!params.paymentVerifiedFromOfficialMpApi) {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage:
        'Proibido confirmar pagamento sem consulta e validação prévia na API oficial do Mercado Pago.',
    };
  }

  const cleanPaymentId = params.incomingMpPaymentId.trim();
  if (!cleanPaymentId) {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage: 'Identificador oficial de pagamento do Mercado Pago é obrigatório.',
    };
  }

  if (params.incomingMpPaymentStatus !== 'approved') {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage: `Pagamento não aprovado na validação oficial do Mercado Pago (status recebido: "${params.incomingMpPaymentStatus}").`,
    };
  }

  if (
    params.verifiedGatewayAmount === null ||
    params.verifiedGatewayAmount === undefined ||
    Number.isNaN(params.verifiedGatewayAmount) ||
    params.verifiedGatewayAmount <= 0
  ) {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage:
        'Valor verificado na API do Mercado Pago (p_verified_amount) é obrigatório e não pode ser nulo.',
    };
  }

  const cleanCurrency = (params.verifiedCurrency ?? '').trim().toUpperCase();
  if (cleanCurrency !== 'BRL') {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage: `Moeda do pagamento inválida ("${cleanCurrency}"). Esperado "BRL".`,
    };
  }

  const cleanExtRef = (params.externalReference ?? '').trim();
  if (!cleanExtRef || (cleanExtRef !== params.orderId && cleanExtRef !== params.orderCode)) {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage:
        'Divergência de titularidade do pagamento: external_reference não corresponde ao pedido.',
    };
  }

  if (params.paymentIdUsedByOtherOrder) {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage: `Conflito de pagamento: o identificador "${cleanPaymentId}" já pertence a outro pedido.`,
    };
  }

  if (
    Number(params.verifiedGatewayAmount.toFixed(2)) !== Number(params.orderTotalAmount.toFixed(2))
  ) {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage: 'Valor pago no Mercado Pago diverge do valor total oficial do pedido.',
    };
  }

  if (params.currentOrderStatus === 'paid') {
    if (params.existingMpPaymentId !== cleanPaymentId) {
      return {
        allowed: false,
        idempotentReplay: false,
        ticketsToIssue: 0,
        soldQuantityDelta: 0,
        errorMessage: `Conflito de idempotência: este pedido já foi pago com outro mp_payment_id (${params.existingMpPaymentId ?? 'NULL'}).`,
      };
    }

    if (params.currentPaymentStatus !== 'approved') {
      return {
        allowed: false,
        idempotentReplay: false,
        ticketsToIssue: 0,
        soldQuantityDelta: 0,
        errorMessage: 'Estado inconsistente do pedido: order_status=paid sem payment_status=approved.',
      };
    }

    if (params.existingTicketsCount !== params.orderQuantity) {
      return {
        allowed: false,
        idempotentReplay: false,
        ticketsToIssue: 0,
        soldQuantityDelta: 0,
        errorMessage: 'Inconsistência de integridade: quantidade de ingressos emitidos diverge do pedido.',
      };
    }

    return {
      allowed: true,
      idempotentReplay: true,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      reservedQuantityDelta: 0,
    };
  }

  if (
    params.currentOrderStatus !== 'reserved' &&
    params.currentOrderStatus !== 'pending_payment'
  ) {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage: `Pedido em estado inválido para confirmação (${params.currentOrderStatus}).`,
    };
  }

  if (params.existingTicketsCount > 0) {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage:
        'Inconsistência detectada: já existem ingressos vinculados a um pedido ainda não pago.',
    };
  }

  if (
    typeof params.eventTicketsSold === 'number' &&
    typeof params.eventTotalSoldAcrossBatches === 'number' &&
    params.eventTicketsSold !== params.eventTotalSoldAcrossBatches
  ) {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage: `Inconsistência de integridade de estoque: events.tickets_sold (${params.eventTicketsSold}) diverge da soma de sold_quantity dos lotes (${params.eventTotalSoldAcrossBatches}).`,
    };
  }

  if (
    typeof params.batchReservedQuantity === 'number' &&
    params.batchReservedQuantity < params.orderQuantity
  ) {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage: `Estoque reservado insuficiente no lote (${params.batchReservedQuantity}) para confirmar ${params.orderQuantity} ingressos.`,
    };
  }

  if (
    typeof params.batchReservedQuantity === 'number' &&
    typeof params.batchSoldQuantity === 'number' &&
    typeof params.batchTotalQuantity === 'number' &&
    params.batchReservedQuantity + params.batchSoldQuantity > params.batchTotalQuantity
  ) {
    return {
      allowed: false,
      idempotentReplay: false,
      ticketsToIssue: 0,
      soldQuantityDelta: 0,
      errorMessage: `Inconsistência de estoque no lote: soma de reservados e vendidos (${
        params.batchReservedQuantity + params.batchSoldQuantity
      }) excede total_quantity (${params.batchTotalQuantity}).`,
    };
  }

  if (typeof params.eventCapacity === 'number' && Number.isFinite(params.eventCapacity)) {
    const currentEventSold =
      params.eventTicketsSold ?? params.eventTotalSoldAcrossBatches ?? 0;
    const totalReserved = params.eventTotalReservedAcrossBatches ?? params.orderQuantity;
    if (totalReserved < params.orderQuantity) {
      return {
        allowed: false,
        idempotentReplay: false,
        ticketsToIssue: 0,
        soldQuantityDelta: 0,
        errorMessage: `Estoque reservado global insuficiente (${totalReserved}) para confirmar ${params.orderQuantity} ingressos.`,
      };
    }
    const otherActiveReserved = totalReserved - params.orderQuantity;
    if (currentEventSold + params.orderQuantity + otherActiveReserved > params.eventCapacity) {
      return {
        allowed: false,
        idempotentReplay: false,
        ticketsToIssue: 0,
        soldQuantityDelta: 0,
        errorMessage: `Capacidade total do evento (${params.eventCapacity}) excedida ao confirmar o pedido (vendidos após confirmação: ${
          currentEventSold + params.orderQuantity
        }, reservas ativas de outros pedidos: ${otherActiveReserved}).`,
      };
    }
  }

  return {
    allowed: true,
    idempotentReplay: false,
    ticketsToIssue: params.orderQuantity,
    soldQuantityDelta: params.orderQuantity,
    reservedQuantityDelta: -params.orderQuantity,
  };
}

/**
 * Deterministic backfill & pre-index validation for existing tickets (mirrors section 2 of migration 002).
 * Ensures every ticket gets a unique `itemSequence` within `1..orderQuantity` for its `orderId`,
 * and aborts if any ticket is orphaned, exceeds `orderQuantity`, or has conflicting sequences.
 */
export function backfillTicketItemSequences(
  orders: Array<{ id: string; orderCode: string; quantity: number }>,
  tickets: Array<{
    id: string;
    orderId: string;
    code: string;
    issuedAt: string;
    createdAt: string;
    itemSequence: number | null;
  }>
): {
  ok: boolean;
  backfilledTickets?: Array<{ id: string; orderId: string; itemSequence: number }>;
  errorMessage?: string;
} {
  const orderMap = new Map(orders.map((o) => [o.id, o]));
  const ticketsByOrder = new Map<string, typeof tickets>();

  for (const t of tickets) {
    if (!orderMap.has(t.orderId)) {
      return {
        ok: false,
        errorMessage: `Migração abortada por segurança: o ingresso ${t.id} (código ${t.code}) referencia um order_id inexistente (${t.orderId}).`,
      };
    }
    const list = ticketsByOrder.get(t.orderId) ?? [];
    list.push(t);
    ticketsByOrder.set(t.orderId, list);
  }

  const result: Array<{ id: string; orderId: string; itemSequence: number }> = [];

  for (const [orderId, orderTickets] of ticketsByOrder.entries()) {
    const order = orderMap.get(orderId)!;

    if (orderTickets.length > order.quantity) {
      return {
        ok: false,
        errorMessage: `Migração abortada por segurança: o pedido ${order.orderCode} (${order.id}) possui ${orderTickets.length} ingressos emitidos, acima da quantidade contratada (${order.quantity}).`,
      };
    }

    const seenSequences = new Set<number>();
    for (const t of orderTickets) {
      if (t.itemSequence !== null) {
        if (t.itemSequence < 1 || t.itemSequence > order.quantity) {
          return {
            ok: false,
            errorMessage: `Migração abortada: o ingresso ${t.id} do pedido ${orderId} possui item_sequence=${t.itemSequence} fora do intervalo válido (1..${order.quantity}).`,
          };
        }
        if (seenSequences.has(t.itemSequence)) {
          return {
            ok: false,
            errorMessage: `Migração abortada: o pedido ${orderId} já possui item_sequence=${t.itemSequence} duplicado.`,
          };
        }
        seenSequences.add(t.itemSequence);
      }
    }

    const availableSlots: number[] = [];
    for (let seq = 1; seq <= order.quantity; seq++) {
      if (!seenSequences.has(seq)) {
        availableSlots.push(seq);
      }
    }

    const nullTickets = orderTickets
      .filter((t) => t.itemSequence === null)
      .sort((a, b) => {
        if (a.issuedAt !== b.issuedAt) return a.issuedAt.localeCompare(b.issuedAt);
        if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
        if (a.code !== b.code) return a.code.localeCompare(b.code);
        return a.id.localeCompare(b.id);
      });

    for (const t of orderTickets) {
      if (t.itemSequence !== null) {
        result.push({ id: t.id, orderId: t.orderId, itemSequence: t.itemSequence });
      }
    }

    nullTickets.forEach((t, idx) => {
      const assignedSeq = availableSlots[idx];
      result.push({ id: t.id, orderId: t.orderId, itemSequence: assignedSeq });
    });
  }

  return {
    ok: true,
    backfilledTickets: result.sort((a, b) => a.itemSequence - b.itemSequence),
  };
}

/**
 * Transactional Check-in Verification Rules (PX CONTROL)
 * Ensures tickets are authentic, paid, belong to the active event, and cannot be reused.
 */
export interface CheckinVerificationResult {
  authorized: boolean;
  statusReason: 'authorized' | 'already_used' | 'invalid' | 'unpaid';
  message: string;
  updatedTicket?: Ticket;
  checkinRecord: CheckinRecord;
}

export function verifyAndProcessCheckin(
  codeOrPayload: string,
  tickets: Ticket[],
  operatorName: string,
  timestampFormatted: string
): CheckinVerificationResult {
  const normalized = codeOrPayload.trim().toUpperCase();
  const matched = tickets.find(
    (t) =>
      t.code.toUpperCase() === normalized ||
      t.qrPayload.toUpperCase() === normalized ||
      normalized.includes(t.code.toUpperCase())
  );

  if (!matched) {
    return {
      authorized: false,
      statusReason: 'invalid',
      message: 'Ingresso não localizado na base oficial PX CUSTON.',
      checkinRecord: {
        id: `CHK-${Date.now()}`,
        ticketId: 'N/A',
        ticketCode: normalized || 'DESCONHECIDO',
        eventTitle: 'Não identificado',
        holderName: 'Não identificado',
        categoryName: '-',
        checkedInAt: timestampFormatted,
        operatorName,
        deviceId: 'PX-CAM-01',
        result: 'invalid',
        message: 'Código QR inválido ou inexistente.',
      },
    };
  }

  if (matched.status === 'used') {
    return {
      authorized: false,
      statusReason: 'already_used',
      message: `Ingresso já utilizado anteriormente em ${matched.usedAt || 'registro anterior'}. Reutilização bloqueada.`,
      checkinRecord: {
        id: `CHK-${Date.now()}`,
        ticketId: matched.id,
        ticketCode: matched.code,
        eventTitle: matched.eventTitle,
        holderName: matched.holderName,
        categoryName: matched.ticketTypeName,
        checkedInAt: timestampFormatted,
        operatorName,
        deviceId: 'PX-CAM-01',
        result: 'already_used',
        message: `Bloqueado: utilizado em ${matched.usedAt || 'horário anterior'}`,
      },
    };
  }

  if (
    matched.status === 'refunded' ||
    matched.status === 'cancelled' ||
    matched.status === 'expired'
  ) {
    return {
      authorized: false,
      statusReason: 'invalid',
      message: `Entrada negada: ingresso cancelado, expirado ou reembolsado (status="${matched.status}").`,
      checkinRecord: {
        id: `CHK-${Date.now()}`,
        ticketId: matched.id,
        ticketCode: matched.code,
        eventTitle: matched.eventTitle,
        holderName: matched.holderName,
        categoryName: matched.ticketTypeName,
        checkedInAt: timestampFormatted,
        operatorName,
        deviceId: 'PX-CAM-01',
        result: 'invalid',
        message: `Ingresso inválido (${matched.status})`,
      },
    };
  }

  if (matched.status !== 'paid') {
    return {
      authorized: false,
      statusReason: 'unpaid',
      message: `Entrada negada: status atual do ingresso é "${matched.status}". Aguardando confirmação do webhook Mercado Pago.`,
      checkinRecord: {
        id: `CHK-${Date.now()}`,
        ticketId: matched.id,
        ticketCode: matched.code,
        eventTitle: matched.eventTitle,
        holderName: matched.holderName,
        categoryName: matched.ticketTypeName,
        checkedInAt: timestampFormatted,
        operatorName,
        deviceId: 'PX-CAM-01',
        result: 'unpaid',
        message: `Status inválido para acesso: ${matched.status}`,
      },
    };
  }

  const updatedTicket: Ticket = {
    ...matched,
    status: 'used',
    usedAt: timestampFormatted,
    usedByOperator: operatorName,
  };

  return {
    authorized: true,
    statusReason: 'authorized',
    message: 'Entrada autorizada! Ingresso autêntico e validado com sucesso.',
    updatedTicket,
    checkinRecord: {
      id: `CHK-${Date.now()}`,
      ticketId: matched.id,
      ticketCode: matched.code,
      eventTitle: matched.eventTitle,
      holderName: matched.holderName,
      categoryName: matched.ticketTypeName,
      checkedInAt: timestampFormatted,
      operatorName,
      deviceId: 'PX-CAM-01',
      result: 'authorized',
      message: 'Entrada autorizada!',
    },
  };
}

const VALID_DB_ROLES = new Set<UserRole>(['customer', 'checkin_operator', 'admin', 'SUPER_ADMIN']);

/**
 * Safely maps a database row from `public.profiles` into a domain `Profile`.
 * Never trusts unknown role strings and never escalates privileges if role is unexpected.
 */
export function mapDbProfileRowToProfile(row: DbProfileRow): Profile {
  const safeRole: UserRole = VALID_DB_ROLES.has(row.role as UserRole)
    ? (row.role as UserRole)
    : 'customer';

  const createdDate = new Date(row.created_at);
  const createdAtFormatted = !Number.isNaN(createdDate.getTime())
    ? createdDate.toLocaleDateString('pt-BR')
    : row.created_at;

  return {
    id: row.id,
    fullName: row.full_name,
    cpf: row.cpf ?? '',
    email: row.email,
    phone: row.phone ?? '',
    city: row.city ?? '',
    role: safeRole,
    createdAt: createdAtFormatted,
  };
}

/**
 * Validates public registration data and builds safe `options.data` metadata for `supabase.auth.signUp()`.
 * Strictly strips any `role` or administrative flags so public signups can never self-assign admin permissions.
 */
export function buildSafeSignUpMetadata(input: {
  fullName: string;
  cpf: string;
  email: string;
  phone: string;
  city?: string;
  password: string;
}):
  | {
      ok: true;
      sanitizedEmail: string;
      metadata: {
        full_name: string;
        cpf: string;
        phone: string;
        city: string | null;
      };
    }
  | { ok: false; errorMessage: string } {
  const buyerCheck = validateBuyerData({
    fullName: input.fullName,
    cpf: input.cpf,
    email: input.email,
    phone: input.phone,
  });

  if (!buyerCheck.valid) {
    const firstError =
      buyerCheck.errors.fullName ||
      buyerCheck.errors.cpf ||
      buyerCheck.errors.email ||
      buyerCheck.errors.phone ||
      'Preencha os dados cadastrais corretamente.';
    return {
      ok: false,
      errorMessage: firstError,
    };
  }

  if (!input.password || input.password.length < 6) {
    return {
      ok: false,
      errorMessage: 'A senha deve possuir no mínimo 6 caracteres.',
    };
  }

  return {
    ok: true,
    sanitizedEmail: input.email.trim().toLowerCase(),
    metadata: {
      full_name: input.fullName.trim(),
      cpf: input.cpf.replace(/\D/g, ''),
      phone: input.phone.trim(),
      city: input.city?.trim() ? input.city.trim() : null,
    },
  };
}

/**
 * Evaluates administrative access to PX CONTROL based strictly on the verified Supabase Auth session
 * and the user's record fetched from `public.profiles` (plus optional server RPC confirmation).
 * - Never trusts client-provided roles without a matching authenticated session and profile ID.
 * - Denies access if disconnected, if `public.profiles` record is missing or failed to load,
 *   or if the profile role is not `'admin'` or `'SUPER_ADMIN'`.
 */
export function evaluateAdminAccess(params: {
  authenticatedUserId: string | null | undefined;
  profile: Profile | null | undefined;
  profileError?: string | null;
  serverAdminConfirmed?: boolean | null;
}): AdminAccessEvaluation {
  const cleanUserId = params.authenticatedUserId?.trim() ?? '';
  if (!cleanUserId) {
    return {
      allowed: false,
      reasonCode: 'unauthenticated',
      userRole: 'visitor',
      message:
        'Sessão não autenticada. Faça login com uma conta administrativa autorizada para acessar o PX CONTROL.',
    };
  }

  if (params.profileError && params.profileError.trim().length > 0) {
    return {
      allowed: false,
      reasonCode: 'profile_error',
      userRole: 'visitor',
      message: `Não foi possível verificar suas permissões em public.profiles (${params.profileError}). Acesso administrativo negado por segurança.`,
    };
  }

  if (!params.profile) {
    return {
      allowed: false,
      reasonCode: 'profile_missing',
      userRole: 'visitor',
      message:
        'Perfil não encontrado em public.profiles para o usuário autenticado. Acesso ao PX CONTROL bloqueado por segurança.',
    };
  }

  if (params.profile.id !== cleanUserId) {
    return {
      allowed: false,
      reasonCode: 'profile_id_mismatch',
      userRole: 'visitor',
      message:
        'Divergência de identificação entre a sessão autenticada e o perfil consultado. Acesso bloqueado.',
    };
  }

  if (params.serverAdminConfirmed === false) {
    return {
      allowed: false,
      reasonCode: 'insufficient_role',
      userRole: params.profile.role,
      message: `Acesso restrito: a conta "${params.profile.email}" possui o papel "${params.profile.role}" e não tem permissão administrativa para acessar o PX CONTROL.`,
    };
  }

  if (params.profile.role !== 'admin' && params.profile.role !== 'SUPER_ADMIN') {
    return {
      allowed: false,
      reasonCode: 'insufficient_role',
      userRole: params.profile.role,
      message: `Acesso restrito: sua conta possui o papel "${params.profile.role}". O painel PX CONTROL exige permissão administrativa (admin ou SUPER_ADMIN).`,
    };
  }

  return {
    allowed: true,
    reasonCode: 'authorized_admin',
    userRole: params.profile.role,
    message: `Acesso administrativo autorizado (${params.profile.role}).`,
  };
}

/**
 * Generates a normalized, URL-safe, lowercase kebab-case slug from a title or custom slug string,
 * and deduplicates against `existingSlugs` if a collision exists.
 */
export function generateEventSlug(rawText: string, existingSlugs: string[] = []): string {
  const base = (rawText ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (base.length < 3) {
    return base;
  }

  const normalizedExisting = new Set(
    existingSlugs.map((s) => s.trim().toLowerCase()).filter(Boolean)
  );

  if (!normalizedExisting.has(base)) {
    return base;
  }

  let suffix = 2;
  while (normalizedExisting.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

/**
 * Converts an ISO date string (`YYYY-MM-DD`) into Brazilian format (`DD/MM/YYYY`).
 */
export function formatIsoDateToBr(isoDate: string): string {
  const trimmed = (isoDate ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (!match) {
    return trimmed;
  }
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/**
 * Validates and converts an event date input in either `DD/MM/YYYY` (Brazilian format)
 * or `YYYY-MM-DD` (PostgreSQL ISO format) into a verified PostgreSQL `DATE` string (`YYYY-MM-DD`).
 * Rejects impossible calendar dates (e.g. `31/02/2026` or `32/01/2026`).
 */
export function parseEventDateToIso(dateInput: string):
  | {
      ok: true;
      isoDate: string;
      dateFormatted: string;
    }
  | {
      ok: false;
      errorMessage: string;
    } {
  const raw = (dateInput ?? '').trim();
  if (!raw) {
    return {
      ok: false,
      errorMessage: 'Informe a data do evento (DD/MM/AAAA ou AAAA-MM-DD).',
    };
  }

  let day: number;
  let month: number;
  let year: number;

  const brMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);

  if (brMatch) {
    day = Number(brMatch[1]);
    month = Number(brMatch[2]);
    year = Number(brMatch[3]);
  } else if (isoMatch) {
    year = Number(isoMatch[1]);
    month = Number(isoMatch[2]);
    day = Number(isoMatch[3]);
  } else {
    return {
      ok: false,
      errorMessage:
        'Data do evento em formato inválido. Utilize DD/MM/AAAA (ex: 25/04/2026) ou AAAA-MM-DD.',
    };
  }

  if (year < 2020 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return {
      ok: false,
      errorMessage: 'Data do evento fora do intervalo calendário válido.',
    };
  }

  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(candidate.getTime()) ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return {
      ok: false,
      errorMessage: `A data informada (${raw}) não existe no calendário.`,
    };
  }

  const dd = String(day).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  const yyyy = String(year);

  return {
    ok: true,
    isoDate: `${yyyy}-${mm}-${dd}`,
    dateFormatted: `${dd}/${mm}/${yyyy}`,
  };
}

/**
 * Maps UI `EventStatus` or DB status string into the exact `public.events.status` constraint value
 * (`'draft' | 'published' | 'ended' | 'cancelled'`).
 */
export function mapUiEventStatusToDb(
  status: EventStatus | DbEventRow['status']
): DbEventRow['status'] {
  switch (status) {
    case 'Publicado':
    case 'published':
      return 'published';
    case 'Rascunho':
    case 'draft':
      return 'draft';
    case 'Encerrado':
    case 'ended':
      return 'ended';
    case 'Cancelado':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'draft';
  }
}

/**
 * Maps `public.events.status` into the UI `EventStatus` label.
 */
export function mapDbEventStatusToUi(status: DbEventRow['status']): EventStatus {
  switch (status) {
    case 'published':
      return 'Publicado';
    case 'draft':
      return 'Rascunho';
    case 'ended':
      return 'Encerrado';
    case 'cancelled':
      return 'Cancelado';
    default:
      return 'Rascunho';
  }
}

/**
 * Validates all required fields and PostgreSQL constraints for creating or updating a record
 * in `public.events` (matching `supabase/migrations/001_initial_schema.sql`).
 * Never invents missing capacity, venue, city, or date values.
 */
export function validateAndBuildEventWritePayload(
  input: AdminEventFormInput,
  options?: {
    existingEvents?: Array<{ id: string; slug: string }>;
    categories?: Array<{ id: string; slug: string; name: string }>;
  }
):
  | {
      ok: true;
      payload: DbEventWritePayload;
    }
  | {
      ok: false;
      errorMessage: string;
      fieldErrors: Record<string, string>;
    } {
  const fieldErrors: Record<string, string> = {};

  const cleanTitle = (input.title ?? '').trim();
  if (cleanTitle.length < 3) {
    fieldErrors.title = 'O nome do evento deve ter pelo menos 3 caracteres.';
  }

  const otherSlugs = (options?.existingEvents ?? [])
    .filter((ev) => !input.id || ev.id !== input.id)
    .map((ev) => ev.slug);

  const rawSlugSource = input.slug?.trim() ? input.slug.trim() : cleanTitle;
  const generatedSlug = generateEventSlug(rawSlugSource, otherSlugs);
  if (generatedSlug.length < 3) {
    fieldErrors.slug = 'O slug do evento deve ter pelo menos 3 caracteres alfanuméricos.';
  }

  const dateCheck = parseEventDateToIso(input.dateInput);
  if (!dateCheck.ok) {
    fieldErrors.dateInput = dateCheck.errorMessage;
  }

  const cleanTimeRange = (input.timeRange ?? '').trim();
  if (!cleanTimeRange) {
    fieldErrors.timeRange = 'Informe o horário do evento (ex: 10:00 às 22:00).';
  }

  const cleanCity = (input.city ?? '').trim();
  if (!cleanCity) {
    fieldErrors.city = 'Informe a cidade / UF do evento.';
  }

  const cleanVenue = (input.venueName ?? '').trim();
  if (!cleanVenue) {
    fieldErrors.venueName = 'Informe o nome do local / arena do evento.';
  }

  const rawPriceStr = String(input.startingPrice ?? '').trim().replace(',', '.');
  const parsedPrice = rawPriceStr === '' ? Number.NaN : Number(rawPriceStr);
  if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
    fieldErrors.startingPrice = 'Informe um preço inicial válido (maior ou igual a R$ 0,00).';
  }

  const rawCapacityStr = String(input.capacity ?? '').trim();
  const parsedCapacity = rawCapacityStr === '' ? Number.NaN : Number(rawCapacityStr);
  if (!Number.isInteger(parsedCapacity) || parsedCapacity <= 0) {
    fieldErrors.capacity = 'A capacidade total deve ser um número inteiro maior que zero.';
  } else if (typeof input.ticketsSold === 'number' && parsedCapacity < input.ticketsSold) {
    fieldErrors.capacity = `A capacidade (${parsedCapacity}) não pode ser menor que os ingressos já vendidos (${input.ticketsSold}).`;
  }

  const cleanBannerUrl = (input.bannerUrl ?? '').trim();
  if (!cleanBannerUrl) {
    fieldErrors.bannerUrl = 'Informe a URL ou caminho da imagem de banner do evento.';
  }

  const cleanCardImageUrl = (input.cardImageUrl ?? '').trim();
  if (!cleanCardImageUrl) {
    fieldErrors.cardImageUrl = 'Informe a URL ou caminho da imagem do card do evento.';
  }

  const cleanDescription = (input.description ?? '').trim();
  if (cleanDescription.length < 10) {
    fieldErrors.description = 'A descrição do evento deve possuir pelo menos 10 caracteres.';
  }

  const rawCategoryId = (input.categoryId ?? '').trim();
  const matchedCat = (options?.categories ?? []).find(
    (c) => c.id === rawCategoryId || c.slug === rawCategoryId
  );
  const resolvedCategorySlug = matchedCat?.slug || rawCategoryId;
  const resolvedCategoryName =
    matchedCat?.name || (input.categoryName ?? '').trim() || resolvedCategorySlug;

  if (!resolvedCategorySlug || !resolvedCategoryName) {
    fieldErrors.categoryId = 'Selecione uma categoria válida para o evento.';
  }

  const errorKeys = Object.keys(fieldErrors);
  if (errorKeys.length > 0 || !dateCheck.ok) {
    const firstMessage =
      fieldErrors[errorKeys[0]] || 'Verifique os campos obrigatórios do formulário de evento.';
    return {
      ok: false,
      errorMessage: firstMessage,
      fieldErrors,
    };
  }

  const parsedHighlights = Array.isArray(input.highlights)
    ? input.highlights.map((h) => h.trim()).filter(Boolean)
    : typeof input.highlights === 'string'
    ? input.highlights
        .split(/\r?\n|,/)
        .map((h) => h.trim())
        .filter(Boolean)
    : [];

  const parsedGallery = Array.isArray(input.galleryUrls)
    ? input.galleryUrls.map((g) => g.trim()).filter(Boolean)
    : [];
  const finalGallery =
    parsedGallery.length > 0
      ? parsedGallery
      : Array.from(new Set([cleanBannerUrl, cleanCardImageUrl]));

  const cleanSubtitle = input.subtitle?.trim() ? input.subtitle.trim() : null;

  return {
    ok: true,
    payload: {
      slug: generatedSlug,
      title: cleanTitle,
      subtitle: cleanSubtitle,
      category_slug: resolvedCategorySlug,
      category_name: resolvedCategoryName,
      event_date: dateCheck.isoDate,
      time_range: cleanTimeRange,
      city: cleanCity,
      venue_name: cleanVenue,
      starting_price: Number(parsedPrice.toFixed(2)),
      banner_url: cleanBannerUrl,
      card_image_url: cleanCardImageUrl,
      gallery_urls: finalGallery,
      description: cleanDescription,
      highlights: parsedHighlights,
      status: mapUiEventStatusToDb(input.status),
      featured: Boolean(input.featured),
      capacity: parsedCapacity,
    },
  };
}

/**
 * Translates PostgreSQL / PostgREST errors on `public.events` into clear, actionable Portuguese
 * messages without hiding the real technical cause.
 */
export function translateEventDatabaseError(
  error: { code?: string; message?: string; details?: string } | null | undefined,
  operation: 'fetch' | 'create' | 'update' | 'status' | 'delete'
): string {
  const code = error?.code ?? '';
  const msg = error?.message ?? 'Erro desconhecido retornado pelo Supabase.';

  if (code === 'PGRST202' || code === '42883') {
    return `A função transacional administrativa (RPC) exigida para esta operação ainda não está disponível ou compatível no banco de dados (${code}). Aplique a migration 002 antes de executar escritas administrativas. Detalhe: ${msg}`;
  }

  if (code === '22007' || code === '22008' || code === '42804') {
    return `Formato de data inválido ou incompatibilidade de tipo para event_date (esperado YYYY-MM-DD válido). (${msg})`;
  }

  if (code === '23505') {
    return `Já existe um evento cadastrado com este identificador (slug duplicado no banco). Detalhe: ${msg}`;
  }

  if (code === '23503' && operation === 'delete') {
    return 'Não é possível excluir este evento porque existem pedidos ou ingressos vinculados a ele no banco de dados. Para retirá-lo do catálogo público sem perder o histórico financeiro, altere seu status para Rascunho ou Encerrado.';
  }

  if (code === '42501' || msg.toLowerCase().includes('row-level security')) {
    return `Permissão negada pela política RLS / RPC do banco (public.events): apenas contas com role 'admin' ou 'SUPER_ADMIN' em public.profiles podem executar esta operação via RPC. (${msg})`;
  }

  if (code === '23514') {
    return `Os dados do evento violam uma restrição de integridade da tabela public.events (verifique capacidade, preço ou formato do título/slug). (${msg})`;
  }

  const opLabel: Record<typeof operation, string> = {
    fetch: 'consultar os eventos',
    create: 'criar o evento',
    update: 'atualizar o evento',
    status: 'alterar o status do evento',
    delete: 'excluir o evento',
  };

  return `Falha ao ${opLabel[operation]} no Supabase: ${msg}`;
}

/**
 * Translates PostgreSQL / PostgREST errors on `public.ticket_batches` and `public.ticket_categories`
 * into clear, actionable Portuguese messages while preserving error codes and technical details.
 */
export function translateBatchOrCategoryDatabaseError(
  error: { code?: string; message?: string; details?: string } | null | undefined,
  entity: 'batch' | 'category',
  operation: 'save' | 'delete'
): string {
  const code = error?.code ?? '';
  const msg = error?.message ?? 'Erro desconhecido retornado pelo Supabase.';
  const detailsSuffix = error?.details ? ` [${error.details}]` : '';
  const entityLabel = entity === 'batch' ? 'lote de ingressos' : 'categoria de ingressos';
  const tableName = entity === 'batch' ? 'public.ticket_batches' : 'public.ticket_categories';

  if (code === 'PGRST202' || code === '42883') {
    return `A função transacional administrativa (RPC) exigida para esta operação em ${tableName} ainda não está disponível ou compatível no banco de dados (${code}). Aplique a migration 002 antes de executar escritas administrativas. Detalhe: ${msg}${detailsSuffix}`;
  }

  if (code === '23505') {
    return `Já existe um registro de ${entityLabel} com este identificador/slug neste evento (${code}). Detalhe: ${msg}${detailsSuffix}`;
  }

  if (code === '23503') {
    if (operation === 'delete') {
      return `Não é possível excluir este registro de ${entityLabel} porque existem vínculos ativos no banco de dados (${code}). Desative-o (active = false) para preservar o histórico. Detalhe: ${msg}${detailsSuffix}`;
    }
    return `Referência inválida ao salvar ${entityLabel}: verifique se o evento e a categoria existem e pertencem ao mesmo evento (${code}). Detalhe: ${msg}${detailsSuffix}`;
  }

  if (code === '42501' || msg.toLowerCase().includes('row-level security')) {
    return `Permissão negada pela política RLS / RPC do banco (${tableName}): apenas contas com role 'admin' ou 'SUPER_ADMIN' em public.profiles podem executar esta operação via RPC (${code || '42501'}). (${msg}${detailsSuffix})`;
  }

  if (code === '23514') {
    return `Os dados de ${entityLabel} violam uma regra de integridade de ${tableName} (${code}): ${msg}${detailsSuffix}`;
  }

  const actionVerb = operation === 'delete' ? 'excluir' : 'salvar';
  return `Falha ao ${actionVerb} ${entityLabel} no Supabase${code ? ` (${code})` : ''}: ${msg}${detailsSuffix}`;
}

export const RECOVERABLE_TICKET_UNIQUE_CONSTRAINTS = new Set<string>([
  'tickets_code_key',
  'tickets_qr_payload_key',
]);

/**
 * Mirrors the collision-resistant ticket issuance loop in `public.confirm_order_payment` (migration 002):
 * - Generates `PX-XXXXXXXX` codes (8 uppercase hex chars).
 * - Uses an explicit whitelist (`RECOVERABLE_TICKET_UNIQUE_CONSTRAINTS`: `'tickets_code_key'` and `'tickets_qr_payload_key'`)
 *   for retries up to `maxCodeAttempts` (default 15).
 * - Immediately aborts without retrying if a unique violation occurs on any non-whitelisted constraint
 *   (e.g. `uq_tickets_order_item_sequence`, `tickets_pkey`, or any other constraint).
 * - Aborts atomically (returning 0 committed tickets) if any ticket item exhausts `maxCodeAttempts`.
 */
export function issueTicketsWithCollisionRetry(params: {
  orderId: string;
  orderCode: string;
  eventId: string;
  quantity: number;
  existingTicketCodes: Set<string>;
  existingQrPayloads?: Set<string>;
  existingOrderSequences?: Set<string>; // format: `${orderId}:${itemSequence}`
  simulatedOtherUniqueViolationConstraint?: string;
  codeGenerator: (itemSequence: number, attempt: number) => string;
  maxCodeAttempts?: number;
}):
  | {
      ok: true;
      tickets: Array<{
        code: string;
        qrPayload: string;
        orderId: string;
        itemSequence: number;
      }>;
      totalAttemptsUsed: number;
    }
  | {
      ok: false;
      constraintFailure?:
        | 'uq_tickets_order_item_sequence'
        | 'tickets_code_key_exhausted'
        | 'unrecoverable_unique_violation';
      violatedConstraintName?: string;
      errorMessage: string;
    } {
  const maxAttempts = params.maxCodeAttempts ?? 15;
  const committedCodes = new Set(
    Array.from(params.existingTicketCodes).map((c) => c.trim().toUpperCase())
  );
  const committedPayloads = new Set(
    Array.from(params.existingQrPayloads ?? []).map((p) => p.trim().toUpperCase())
  );
  const committedSequences = new Set(params.existingOrderSequences ?? []);
  const stagedTickets: Array<{
    code: string;
    qrPayload: string;
    orderId: string;
    itemSequence: number;
  }> = [];
  let totalAttemptsUsed = 0;

  for (let i = 1; i <= params.quantity; i += 1) {
    const seqKey = `${params.orderId}:${i}`;
    let inserted = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      totalAttemptsUsed += 1;
      const rawCandidate = params.codeGenerator(i, attempt).trim().toUpperCase();
      const qrPayload = `PXCUSTON|${rawCandidate}|${params.eventId}|${i}`;

      // Check (order_id, item_sequence) or any simulated non-whitelisted constraint first:
      let violatedConstraint: string | null = null;
      if (params.simulatedOtherUniqueViolationConstraint) {
        violatedConstraint = params.simulatedOtherUniqueViolationConstraint;
      } else if (committedSequences.has(seqKey)) {
        violatedConstraint = 'uq_tickets_order_item_sequence';
      } else if (committedCodes.has(rawCandidate)) {
        violatedConstraint = 'tickets_code_key';
      } else if (committedPayloads.has(qrPayload.toUpperCase())) {
        violatedConstraint = 'tickets_qr_payload_key';
      }

      if (violatedConstraint !== null) {
        if (!RECOVERABLE_TICKET_UNIQUE_CONSTRAINTS.has(violatedConstraint)) {
          return {
            ok: false,
            constraintFailure:
              violatedConstraint === 'uq_tickets_order_item_sequence'
                ? 'uq_tickets_order_item_sequence'
                : 'unrecoverable_unique_violation',
            violatedConstraintName: violatedConstraint,
            errorMessage: `Violação de unicidade não recuperável na constraint "${violatedConstraint}" para (${params.orderId}, ${i}).`,
          };
        }
        // Whitelisted collision (`tickets_code_key` or `tickets_qr_payload_key`): retry up to maxAttempts
        continue;
      }

      committedCodes.add(rawCandidate);
      committedPayloads.add(qrPayload.toUpperCase());
      committedSequences.add(seqKey);
      stagedTickets.push({
        code: rawCandidate,
        qrPayload,
        orderId: params.orderId,
        itemSequence: i,
      });
      inserted = true;
      break;
    }

    if (!inserted) {
      return {
        ok: false,
        constraintFailure: 'tickets_code_key_exhausted',
        errorMessage: `Não foi possível gerar um código único para o ingresso ${i} de ${params.quantity} do pedido ${params.orderCode} após ${maxAttempts} tentativas. Transação revertida com segurança.`,
      };
    }
  }

  return {
    ok: true,
    tickets: stagedTickets,
    totalAttemptsUsed,
  };
}

/**
 * Mirrors the batch and event capacity integrity rules from `enforce_batch_within_event_capacity()`
 * and `enforce_event_capacity_vs_batches()` in migration 002:
 * - Blocks changing `event_id` on an existing batch.
 * - Blocks deleting a batch with `sold_quantity > 0` or `reserved_quantity > 0`.
 * - Requires new batches to start with `reserved_quantity = 0` and `sold_quantity = 0`.
 * - Reconciles `reserved_quantity` and `sold_quantity` against `public.orders` whenever counters change.
 * - Enforces strict equality `eventTicketsSold === totalSoldAcrossBatches` (no GREATEST masking).
 * - Enforces `totalCommitted <= eventCapacity`.
 * - Enforces `totalAllocated (active total_quantity + inactive sold+reserved) <= eventCapacity` when batch is active.
 */
export function evaluateBatchAllocationIntegrity(params: {
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  eventCapacity: number;
  eventTicketsSold: number;
  oldBatch?: {
    id: string;
    eventId: string;
    categoryId?: string;
    totalQuantity: number;
    reservedQuantity: number;
    soldQuantity: number;
    active: boolean;
  };
  newBatch?: {
    id: string;
    eventId: string;
    categoryId?: string;
    totalQuantity: number;
    reservedQuantity: number;
    soldQuantity: number;
    active: boolean;
  };
  category?: {
    id: string;
    eventId: string;
    name?: string;
    active: boolean;
  } | null;
  otherBatchesOfEvent: Array<{
    id: string;
    totalQuantity: number;
    reservedQuantity: number;
    soldQuantity: number;
    active: boolean;
  }>;
  ordersReservedForBatch?: number;
  ordersSoldForBatch?: number;
}): {
  allowed: boolean;
  totalCommitted?: number;
  totalAllocated?: number;
  errorMessage?: string;
} {
  if (params.operation === 'DELETE') {
    const oldB = params.oldBatch;
    if (!oldB) {
      return { allowed: false, errorMessage: 'Registro original do lote ausente para exclusão.' };
    }
    if (oldB.soldQuantity > 0 || oldB.reservedQuantity > 0) {
      return {
        allowed: false,
        errorMessage: `Não é permitido excluir um lote que possui ingressos vendidos (${oldB.soldQuantity}) ou reservados (${oldB.reservedQuantity}). Desative o lote (active = false).`,
      };
    }
    return { allowed: true };
  }

  const newB = params.newBatch;
  if (!newB) {
    return { allowed: false, errorMessage: 'Dados do lote ausentes.' };
  }

  if (params.operation === 'UPDATE') {
    const oldB = params.oldBatch;
    if (!oldB) {
      return { allowed: false, errorMessage: 'Registro anterior do lote ausente para atualização.' };
    }
    if (newB.eventId !== oldB.eventId) {
      return {
        allowed: false,
        errorMessage: `Não é permitido alterar o event_id de um lote existente (${oldB.eventId} -> ${newB.eventId}).`,
      };
    }
  }

  if (params.category !== undefined) {
    if (params.category === null) {
      return {
        allowed: false,
        errorMessage: `Categoria de ingresso (${newB.categoryId ?? 'NULL'}) associada ao lote não encontrada.`,
      };
    }

    if (params.category.eventId !== newB.eventId) {
      return {
        allowed: false,
        errorMessage: `Inconsistência referencial: a categoria "${params.category.name ?? params.category.id}" (${params.category.id}) pertence ao evento (${params.category.eventId}) e não pode ser vinculada a um lote do evento (${newB.eventId}).`,
      };
    }

    const isActivatingOrAssigningCategory =
      params.operation === 'INSERT' ||
      !params.oldBatch?.active ||
      (newB.categoryId !== undefined && newB.categoryId !== params.oldBatch?.categoryId);

    if (newB.active && !params.category.active && isActivatingOrAssigningCategory) {
      return {
        allowed: false,
        errorMessage: `Não é permitido criar ou ativar um lote vinculado a uma categoria inativa ("${params.category.name ?? params.category.id}" / ${params.category.id}).`,
      };
    }
  }

  if (
    params.operation === 'INSERT' &&
    (newB.reservedQuantity !== 0 || newB.soldQuantity !== 0)
  ) {
    return {
      allowed: false,
      errorMessage: `Novos lotes devem ser criados com reserved_quantity = 0 e sold_quantity = 0 (recebido: reserved=${newB.reservedQuantity}, sold=${newB.soldQuantity}).`,
    };
  }

  if (newB.totalQuantity <= 0 || newB.reservedQuantity < 0 || newB.soldQuantity < 0) {
    return {
      allowed: false,
      errorMessage: 'Quantidades do lote inválidas.',
    };
  }

  if (newB.reservedQuantity + newB.soldQuantity > newB.totalQuantity) {
    return {
      allowed: false,
      errorMessage: `A quantidade total do lote (${newB.totalQuantity}) não pode ser menor que a soma de ingressos já vendidos (${newB.soldQuantity}) e reservados (${newB.reservedQuantity}) neste lote.`,
    };
  }

  if (
    params.operation === 'UPDATE' &&
    params.oldBatch &&
    (newB.reservedQuantity !== params.oldBatch.reservedQuantity ||
      newB.soldQuantity !== params.oldBatch.soldQuantity)
  ) {
    if (
      typeof params.ordersReservedForBatch !== 'number' ||
      typeof params.ordersSoldForBatch !== 'number' ||
      newB.reservedQuantity !== params.ordersReservedForBatch ||
      newB.soldQuantity !== params.ordersSoldForBatch
    ) {
      return {
        allowed: false,
        errorMessage: `Violação de integridade dos contadores do lote (${newB.id}): reserved_quantity (${newB.reservedQuantity}) / sold_quantity (${newB.soldQuantity}) divergem dos pedidos registrados em public.orders (reserved=${params.ordersReservedForBatch ?? 'N/A'}, sold=${params.ordersSoldForBatch ?? 'N/A'}).`,
      };
    }
  }

  let otherReserved = 0;
  let otherSold = 0;
  let otherAllocated = 0;

  for (const b of params.otherBatchesOfEvent) {
    if (params.operation === 'UPDATE' && b.id === newB.id) continue;
    otherReserved += b.reservedQuantity;
    otherSold += b.soldQuantity;
    otherAllocated += b.active ? b.totalQuantity : b.soldQuantity + b.reservedQuantity;
  }

  const totalSold = otherSold + newB.soldQuantity;
  const totalReserved = otherReserved + newB.reservedQuantity;
  const totalCommitted = totalSold + totalReserved;

  const isSoldCounterUnchanged =
    params.operation === 'INSERT' ||
    (params.oldBatch !== undefined && newB.soldQuantity === params.oldBatch.soldQuantity);

  if (isSoldCounterUnchanged && params.eventTicketsSold !== totalSold) {
    return {
      allowed: false,
      totalCommitted,
      errorMessage: `Inconsistência de integridade de estoque: events.tickets_sold (${params.eventTicketsSold}) diverge da soma de sold_quantity dos lotes (${totalSold}).`,
    };
  }

  if (totalCommitted > params.eventCapacity) {
    return {
      allowed: false,
      totalCommitted,
      errorMessage: `Capacidade total do evento (${params.eventCapacity}) excedida pela soma de ingressos vendidos e reservados nos lotes (${totalCommitted}).`,
    };
  }

  const thisAllocated = newB.active
    ? newB.totalQuantity
    : newB.soldQuantity + newB.reservedQuantity;
  const totalAllocated = otherAllocated + thisAllocated;

  const isCounterTransition =
    params.operation === 'UPDATE' &&
    params.oldBatch !== undefined &&
    newB.totalQuantity === params.oldBatch.totalQuantity &&
    newB.active === params.oldBatch.active &&
    (newB.reservedQuantity !== params.oldBatch.reservedQuantity ||
      newB.soldQuantity !== params.oldBatch.soldQuantity);

  const isRemediationReduction =
    params.operation === 'UPDATE' &&
    params.oldBatch !== undefined &&
    newB.active &&
    params.oldBatch.active &&
    newB.totalQuantity < params.oldBatch.totalQuantity;

  if (
    newB.active &&
    totalAllocated > params.eventCapacity &&
    !isCounterTransition &&
    !isRemediationReduction
  ) {
    return {
      allowed: false,
      totalCommitted,
      totalAllocated,
      errorMessage: `A soma da quantidade ofertada nos lotes ativos mais o estoque comprometido em lotes inativos (${totalAllocated}) não pode exceder a capacidade global do evento (${params.eventCapacity}).`,
    };
  }

  return {
    allowed: true,
    totalCommitted,
    totalAllocated,
  };
}

/**
 * Mirrors `public.enforce_event_capacity_vs_batches()` in migration 002:
 * - Always enforces `event.ticketsSold === sum(batches.soldQuantity)`.
 * - Always enforces physical capacity (`totalCommitted <= newEventCapacity`).
 * - Blocks reducing `event.capacity` below `totalAllocated` (sum of active batch offers + inactive batch commitments),
 *   while allowing administrative status/metadata updates when physical capacity holds even if a historical active offer exceeds capacity.
 */
export function evaluateEventCapacityUpdateIntegrity(params: {
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  oldEvent?: { capacity: number; ticketsSold: number };
  newEvent?: { capacity: number; ticketsSold: number };
  batchesOfEvent: Array<{
    id: string;
    totalQuantity: number;
    reservedQuantity: number;
    soldQuantity: number;
    active: boolean;
  }>;
}): {
  allowed: boolean;
  totalSold: number;
  totalReserved: number;
  totalCommitted: number;
  totalAllocated: number;
  errorMessage?: string;
} {
  let totalSold = 0;
  let totalReserved = 0;
  let activeOffered = 0;
  let inactiveCommitted = 0;

  for (const b of params.batchesOfEvent) {
    totalSold += b.soldQuantity;
    totalReserved += b.reservedQuantity;
    if (b.active) {
      activeOffered += b.totalQuantity;
    } else {
      inactiveCommitted += b.soldQuantity + b.reservedQuantity;
    }
  }

  const totalCommitted = totalSold + totalReserved;
  const totalAllocated = activeOffered + inactiveCommitted;

  if (params.operation === 'DELETE') {
    return {
      allowed: true,
      totalSold,
      totalReserved,
      totalCommitted,
      totalAllocated,
    };
  }

  const newEv = params.newEvent;
  if (!newEv) {
    return {
      allowed: false,
      totalSold,
      totalReserved,
      totalCommitted,
      totalAllocated,
      errorMessage: 'Dados do evento ausentes para validação de capacidade.',
    };
  }

  if (newEv.ticketsSold !== totalSold) {
    return {
      allowed: false,
      totalSold,
      totalReserved,
      totalCommitted,
      totalAllocated,
      errorMessage: `Inconsistência de integridade de estoque: events.tickets_sold (${newEv.ticketsSold}) diverge da soma de sold_quantity dos lotes (${totalSold}).`,
    };
  }

  if (newEv.capacity < totalCommitted) {
    return {
      allowed: false,
      totalSold,
      totalReserved,
      totalCommitted,
      totalAllocated,
      errorMessage: `A capacidade do evento (${newEv.capacity}) não pode ser menor que o total de ingressos já comprometidos nos lotes (${totalCommitted}, sendo ${totalSold} vendidos e ${totalReserved} reservados).`,
    };
  }

  const isCapacityReduced =
    params.operation === 'INSERT' ||
    (params.oldEvent !== undefined && newEv.capacity < params.oldEvent.capacity);

  if (isCapacityReduced && newEv.capacity < totalAllocated) {
    return {
      allowed: false,
      totalSold,
      totalReserved,
      totalCommitted,
      totalAllocated,
      errorMessage: `A capacidade do evento (${newEv.capacity}) não pode ser reduzida abaixo da oferta total configurada nos lotes ativos mais o estoque comprometido em lotes inativos (${totalAllocated}). Reduza ou desative lotes antes de diminuir a capacidade do evento.`,
    };
  }

  return {
    allowed: true,
    totalSold,
    totalReserved,
    totalCommitted,
    totalAllocated,
  };
}

/**
 * Mirrors Sections 2.7, 2.8, and 2.9 of migration 002 (pre-flight counter audit):
 * Detects any divergence between `public.orders`, `public.ticket_batches`, `public.events`, and `public.tickets`
 * without inventing or mutating data.
 */
export function auditDatabaseCountersIntegrity(params: {
  events: Array<{ id: string; capacity: number; ticketsSold: number }>;
  batches: Array<{
    id: string;
    eventId: string;
    totalQuantity: number;
    reservedQuantity: number;
    soldQuantity: number;
  }>;
  orders: Array<{
    id: string;
    eventId: string;
    ticketBatchId: string;
    quantity: number;
    orderStatus: string;
    paymentStatus: string;
    mpPaymentId: string | null;
    ticketCount: number;
    activeTicketCount?: number;
    refundedTicketCount?: number;
  }>;
}): {
  valid: boolean;
  divergences: string[];
} {
  const divergences: string[] = [];
  const batchById = new Map(params.batches.map((b) => [b.id, b]));

  for (const o of params.orders) {
    const batch = batchById.get(o.ticketBatchId);
    if (!batch || batch.eventId !== o.eventId) {
      divergences.push(
        `order_id=${o.id} (event_id=${o.eventId}, ticket_batch_id=${o.ticketBatchId}, batch_event_id=${batch?.eventId ?? 'NULL'})`
      );
    }

    const activeTicketsOk =
      o.activeTicketCount === undefined || o.activeTicketCount === o.quantity;
    const refundedTicketsZeroOk =
      o.refundedTicketCount === undefined || o.refundedTicketCount === 0;
    const refundedTicketsFullOk =
      o.refundedTicketCount === undefined || o.refundedTicketCount === o.quantity;
    const activeTicketsZeroOk =
      o.activeTicketCount === undefined || o.activeTicketCount === 0;

    const validStateCombo =
      ((o.orderStatus === 'pending_payment' || o.orderStatus === 'reserved') &&
        (o.paymentStatus === 'pending' || o.paymentStatus === 'in_process') &&
        o.ticketCount === 0) ||
      (o.orderStatus === 'paid' &&
        o.paymentStatus === 'approved' &&
        Boolean(o.mpPaymentId && o.mpPaymentId.trim() !== '') &&
        o.ticketCount === o.quantity &&
        activeTicketsOk &&
        refundedTicketsZeroOk) ||
      ((o.orderStatus === 'cancelled' || o.orderStatus === 'expired') &&
        (o.paymentStatus === 'cancelled' || o.paymentStatus === 'rejected') &&
        o.ticketCount === 0) ||
      (o.orderStatus === 'refunded' &&
        o.paymentStatus === 'refunded' &&
        Boolean(o.mpPaymentId && o.mpPaymentId.trim() !== '') &&
        o.ticketCount === o.quantity &&
        refundedTicketsFullOk &&
        activeTicketsZeroOk);

    if (!validStateCombo) {
      divergences.push(
        `order_id=${o.id} (order_status=${o.orderStatus}, payment_status=${o.paymentStatus}, quantity=${o.quantity}, tickets=${o.ticketCount}, active_tickets=${o.activeTicketCount ?? 'N/A'}, refunded_tickets=${o.refundedTicketCount ?? 'N/A'})`
      );
    }
  }

  for (const b of params.batches) {
    let ordersReserved = 0;
    let ordersSold = 0;
    for (const o of params.orders) {
      if (o.ticketBatchId !== b.id) continue;
      if (
        (o.orderStatus === 'pending_payment' || o.orderStatus === 'reserved') &&
        (o.paymentStatus === 'pending' || o.paymentStatus === 'in_process')
      ) {
        ordersReserved += o.quantity;
      } else if (o.orderStatus === 'paid' && o.paymentStatus === 'approved') {
        ordersSold += o.quantity;
      }
    }

    if (
      b.reservedQuantity !== ordersReserved ||
      b.soldQuantity !== ordersSold ||
      b.reservedQuantity + b.soldQuantity > b.totalQuantity
    ) {
      divergences.push(
        `batch_id=${b.id} (event_id=${b.eventId}, batch_reserved=${b.reservedQuantity}, orders_reserved=${ordersReserved}, batch_sold=${b.soldQuantity}, orders_sold=${ordersSold}, total_quantity=${b.totalQuantity})`
      );
    }
  }

  for (const ev of params.events) {
    let batchesSold = 0;
    let batchesReserved = 0;
    for (const b of params.batches) {
      if (b.eventId !== ev.id) continue;
      batchesSold += b.soldQuantity;
      batchesReserved += b.reservedQuantity;
    }

    let ordersSold = 0;
    let ordersReserved = 0;
    for (const o of params.orders) {
      if (o.eventId !== ev.id) continue;
      if (
        (o.orderStatus === 'pending_payment' || o.orderStatus === 'reserved') &&
        (o.paymentStatus === 'pending' || o.paymentStatus === 'in_process')
      ) {
        ordersReserved += o.quantity;
      } else if (o.orderStatus === 'paid' && o.paymentStatus === 'approved') {
        ordersSold += o.quantity;
      }
    }

    if (
      ev.ticketsSold !== batchesSold ||
      ev.ticketsSold !== ordersSold ||
      batchesSold + batchesReserved > ev.capacity ||
      ordersSold + ordersReserved > ev.capacity
    ) {
      divergences.push(
        `event_id=${ev.id} (tickets_sold=${ev.ticketsSold}, batches_sold=${batchesSold}, orders_sold=${ordersSold}, batches_reserved=${batchesReserved}, orders_reserved=${ordersReserved}, capacity=${ev.capacity})`
      );
    }
  }

  return {
    valid: divergences.length === 0,
    divergences,
  };
}

/**
 * Mirrors `public.enforce_orders_integrity()` in migration 002:
 * Enforces immutability of core order attributes on UPDATE, validates the explicit state machine
 * for `order_status` x `payment_status`, and unconditionally forbids deleting rows from `public.orders`.
 */
export function evaluateOrderMutationIntegrity(params: {
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  oldOrder?: {
    id: string;
    orderCode: string;
    userId: string;
    eventId: string;
    ticketBatchId: string;
    quantity: number;
    unitPrice: number;
    subtotal?: number;
    convenienceFee?: number;
    totalAmount: number;
    orderStatus: string;
    paymentStatus: string;
    mpPaymentId: string | null;
    createdAt: string;
  };
  newOrder?: {
    id: string;
    orderCode: string;
    userId: string;
    eventId: string;
    ticketBatchId: string;
    quantity: number;
    unitPrice: number;
    subtotal?: number;
    convenienceFee?: number;
    totalAmount: number;
    orderStatus: string;
    paymentStatus: string;
    mpPaymentId: string | null;
    createdAt: string;
  };
  batchEventId?: string;
  existingTicketCountForOrder?: number;
}): {
  allowed: boolean;
  errorMessage?: string;
} {
  if (params.operation === 'DELETE') {
    return {
      allowed: false,
      errorMessage: `Não é permitido excluir registros de public.orders (pedido ${params.oldOrder?.id ?? 'N/A'} / ${params.oldOrder?.orderCode ?? 'N/A'}). Utilize os fluxos transacionais para preservar o histórico e os contadores de estoque.`,
    };
  }

  const newO = params.newOrder;
  if (!newO) {
    return { allowed: false, errorMessage: 'Dados do pedido ausentes.' };
  }

  if (params.batchEventId !== undefined && params.batchEventId !== newO.eventId) {
    return {
      allowed: false,
      errorMessage: `Inconsistência de integridade em orders: o lote (${newO.ticketBatchId}) não pertence ao evento (${newO.eventId}) informado no pedido (${newO.id}).`,
    };
  }

  const expectedSubtotalCents = Math.round(newO.unitPrice * newO.quantity * 100);
  const actualSubtotalCents =
    newO.subtotal !== undefined ? Math.round(newO.subtotal * 100) : expectedSubtotalCents;
  const actualFeeCents =
    newO.convenienceFee !== undefined ? Math.round(newO.convenienceFee * 100) : 0;
  const actualTotalCents = Math.round(newO.totalAmount * 100);

  if (
    actualSubtotalCents !== expectedSubtotalCents ||
    actualFeeCents < 0 ||
    actualTotalCents !== actualSubtotalCents + actualFeeCents
  ) {
    return {
      allowed: false,
      errorMessage: `Inconsistência financeira no pedido (${newO.id}): total_amount (${newO.totalAmount}) diverge de subtotal (${actualSubtotalCents / 100}) + convenience_fee (${actualFeeCents / 100}) para unit_price (${newO.unitPrice}) * quantity (${newO.quantity}).`,
    };
  }

  if (params.operation === 'INSERT') {
    const validInsertState =
      (newO.orderStatus === 'pending_payment' || newO.orderStatus === 'reserved') &&
      newO.paymentStatus === 'pending' &&
      newO.mpPaymentId === null;
    if (!validInsertState) {
      return {
        allowed: false,
        errorMessage: `Operação negada: novos pedidos devem iniciar obrigatoriamente como reserva pendente de pagamento sem mp_payment_id (recebido order_status=${newO.orderStatus}, payment_status=${newO.paymentStatus}).`,
      };
    }
    return { allowed: true };
  }

  const oldO = params.oldOrder;
  if (!oldO) {
    return { allowed: false, errorMessage: 'Estado anterior do pedido ausente para UPDATE.' };
  }

  if (
    newO.id !== oldO.id ||
    newO.orderCode !== oldO.orderCode ||
    newO.userId !== oldO.userId ||
    newO.eventId !== oldO.eventId ||
    newO.ticketBatchId !== oldO.ticketBatchId ||
    newO.quantity !== oldO.quantity ||
    newO.unitPrice !== oldO.unitPrice ||
    newO.totalAmount !== oldO.totalAmount ||
    newO.createdAt !== oldO.createdAt
  ) {
    return {
      allowed: false,
      errorMessage: `Operação negada: os atributos estruturais do pedido (${oldO.id}) (id, order_code, user_id, event_id, ticket_batch_id, quantity, unit_price, total_amount, created_at) são imutáveis após a criação.`,
    };
  }

  if (
    oldO.orderStatus === 'cancelled' ||
    oldO.orderStatus === 'expired' ||
    oldO.orderStatus === 'refunded'
  ) {
    if (
      newO.orderStatus !== oldO.orderStatus ||
      newO.paymentStatus !== oldO.paymentStatus ||
      newO.mpPaymentId !== oldO.mpPaymentId
    ) {
      return {
        allowed: false,
        errorMessage: `Transição de estado inválida para o pedido (${oldO.id}): um pedido em estado final (${oldO.orderStatus}) não pode sofrer alterações de status ou vínculo financeiro.`,
      };
    }
    return { allowed: true };
  }

  if (oldO.orderStatus === 'paid') {
    if (newO.orderStatus === 'paid') {
      if (newO.paymentStatus !== 'approved' || newO.mpPaymentId !== oldO.mpPaymentId) {
        return {
          allowed: false,
          errorMessage: `Operação negada no pedido (${oldO.id}): pedidos pagos ativos devem manter payment_status=approved e mp_payment_id inalterado.`,
        };
      }
      return { allowed: true };
    }
    if (newO.orderStatus === 'refunded') {
      if (
        oldO.paymentStatus !== 'approved' ||
        newO.paymentStatus !== 'refunded' ||
        !oldO.mpPaymentId ||
        oldO.mpPaymentId.trim() === '' ||
        newO.mpPaymentId !== oldO.mpPaymentId
      ) {
        return {
          allowed: false,
          errorMessage: `Transição inválida para refunded no pedido (${oldO.id}): exige pedido previamente paid/approved, preservação de mp_payment_id e payment_status=refunded.`,
        };
      }
      return { allowed: true };
    }
    return {
      allowed: false,
      errorMessage: `Transição de estado inválida para o pedido (${oldO.id}): um pedido já pago não pode mudar para "${newO.orderStatus}".`,
    };
  }

  if (oldO.orderStatus === 'reserved' || oldO.orderStatus === 'pending_payment') {
    if (newO.orderStatus === 'reserved' || newO.orderStatus === 'pending_payment') {
      if (
        (newO.paymentStatus !== 'pending' && newO.paymentStatus !== 'in_process') ||
        newO.mpPaymentId !== null
      ) {
        return {
          allowed: false,
          errorMessage: `Estado inválido para reserva ativa no pedido (${oldO.id}): exige payment_status IN (pending, in_process) e mp_payment_id nulo.`,
        };
      }
      return { allowed: true };
    }
    if (newO.orderStatus === 'paid') {
      if (
        newO.paymentStatus !== 'approved' ||
        !newO.mpPaymentId ||
        newO.mpPaymentId.trim() === ''
      ) {
        return {
          allowed: false,
          errorMessage: `Transição inválida para paid no pedido (${oldO.id}): exige payment_status=approved e mp_payment_id preenchido.`,
        };
      }
      return { allowed: true };
    }
    if (newO.orderStatus === 'expired') {
      if (newO.paymentStatus !== 'cancelled' || newO.mpPaymentId !== null) {
        return {
          allowed: false,
          errorMessage: `Transição inválida para expired no pedido (${oldO.id}): exige payment_status=cancelled e ausência de mp_payment_id.`,
        };
      }
      return { allowed: true };
    }
    if (newO.orderStatus === 'cancelled') {
      if (
        (newO.paymentStatus !== 'cancelled' && newO.paymentStatus !== 'rejected') ||
        newO.mpPaymentId !== null
      ) {
        return {
          allowed: false,
          errorMessage: `Transição inválida para cancelled no pedido (${oldO.id}): exige payment_status IN (cancelled, rejected) e ausência de mp_payment_id.`,
        };
      }
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    errorMessage: `Combinação inválida de transição (${oldO.orderStatus} -> ${newO.orderStatus}) no pedido (${newO.id}).`,
  };
}

/**
 * Mirrors `public.enforce_ticket_order_integrity()` in migration 002:
 * - Unconditionally blocks DELETE on `public.tickets`.
 * - Enforces that INSERT creates tickets with `status = 'paid'` linked to a `'paid'`/`'approved'` order.
 * - On UPDATE, enforces immutability of structural/identity fields and allows ONLY:
 *   - `'paid' -> 'used'` (when parent order is `'paid'`/`'approved'` and `usedAt` is present)
 *   - `'paid' -> 'refunded'` (when parent order is `'refunded'`/`'refunded'` and `usedAt` is null)
 * - Blocks reverting `'used' -> 'paid'` or `'used' -> 'refunded'`.
 */
export function evaluateTicketMutationIntegrity(params: {
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  parentOrder: {
    id: string;
    orderCode: string;
    userId: string;
    eventId: string;
    ticketBatchId: string;
    quantity: number;
    orderStatus: OrderStatus;
    paymentStatus: PaymentStatus;
    mpPaymentId: string | null;
  };
  batchCategoryId: string;
  oldTicket?: {
    id: string;
    code: string;
    qrPayload: string;
    orderId: string;
    itemSequence: number;
    userId: string;
    eventId: string;
    categoryId: string;
    batchId: string;
    status: TicketStatus;
    mpPaymentId: string | null;
    usedAt: string | null;
  };
  newTicket?: {
    id: string;
    code: string;
    qrPayload: string;
    orderId: string;
    itemSequence: number;
    userId: string;
    eventId: string;
    categoryId: string;
    batchId: string;
    status: TicketStatus;
    mpPaymentId: string | null;
    usedAt: string | null;
  };
}): {
  allowed: boolean;
  errorMessage?: string;
} {
  if (params.operation === 'DELETE') {
    return {
      allowed: false,
      errorMessage: `Operação negada: não é permitido excluir registros de public.tickets (ingresso ${params.oldTicket?.code ?? 'N/A'}).`,
    };
  }

  const newT = params.newTicket;
  if (!newT) {
    return { allowed: false, errorMessage: 'Dados do ingresso ausentes.' };
  }

  const ord = params.parentOrder;
  if (
    newT.orderId !== ord.id ||
    newT.userId !== ord.userId ||
    newT.eventId !== ord.eventId ||
    newT.batchId !== ord.ticketBatchId ||
    newT.categoryId !== params.batchCategoryId
  ) {
    return {
      allowed: false,
      errorMessage: `Inconsistência relacional no ingresso (${newT.code}): dados divergem do pedido (${ord.orderCode}) ou lote.`,
    };
  }

  if (newT.itemSequence < 1 || newT.itemSequence > ord.quantity) {
    return {
      allowed: false,
      errorMessage: `Sequência de item inválida (${newT.itemSequence}) para o pedido ${ord.orderCode} (1..${ord.quantity}).`,
    };
  }

  if (params.operation === 'INSERT') {
    if (ord.orderStatus !== 'paid' || ord.paymentStatus !== 'approved') {
      return {
        allowed: false,
        errorMessage: `Não é permitido emitir ingresso para pedido não pago (${ord.orderStatus} / ${ord.paymentStatus}).`,
      };
    }
    if (
      newT.status !== 'paid' ||
      !newT.mpPaymentId ||
      newT.mpPaymentId !== ord.mpPaymentId ||
      newT.usedAt !== null
    ) {
      return {
        allowed: false,
        errorMessage:
          'Novos ingressos devem ser emitidos exclusivamente com status="paid", used_at=NULL e mp_payment_id idêntico ao pedido.',
      };
    }
    return { allowed: true };
  }

  const oldT = params.oldTicket;
  if (!oldT) {
    return { allowed: false, errorMessage: 'Estado anterior do ingresso ausente para UPDATE.' };
  }

  if (
    newT.id !== oldT.id ||
    newT.code !== oldT.code ||
    newT.qrPayload !== oldT.qrPayload ||
    newT.orderId !== oldT.orderId ||
    newT.itemSequence !== oldT.itemSequence ||
    newT.userId !== oldT.userId ||
    newT.eventId !== oldT.eventId ||
    newT.categoryId !== oldT.categoryId ||
    newT.batchId !== oldT.batchId ||
    newT.mpPaymentId !== oldT.mpPaymentId
  ) {
    return {
      allowed: false,
      errorMessage: `Operação negada: os atributos de identidade do ingresso (${oldT.code}) são imutáveis.`,
    };
  }

  if (oldT.status === 'used') {
    if (newT.status !== 'used' || newT.usedAt !== oldT.usedAt) {
      return {
        allowed: false,
        errorMessage: `Transição de estado inválida no ingresso (${oldT.code}): um ingresso já utilizado no check-in (status=used) é terminal e não pode voltar para "${newT.status}".`,
      };
    }
    return { allowed: true };
  }

  if (oldT.status === 'refunded' || oldT.status === 'cancelled' || oldT.status === 'expired') {
    if (newT.status !== oldT.status) {
      return {
        allowed: false,
        errorMessage: `Transição de estado inválida no ingresso (${oldT.code}): status terminal "${oldT.status}" não pode mudar para "${newT.status}".`,
      };
    }
    return { allowed: true };
  }

  if (oldT.status === 'paid') {
    if (newT.status === 'paid') {
      return { allowed: true };
    }
    if (newT.status === 'used') {
      if (ord.orderStatus !== 'paid' || ord.paymentStatus !== 'approved' || !newT.usedAt) {
        return {
          allowed: false,
          errorMessage: `Check-in inválido no ingresso (${oldT.code}): exige pedido paid/approved e used_at preenchido.`,
        };
      }
      return { allowed: true };
    }
    if (newT.status === 'refunded') {
      if (
        ord.orderStatus !== 'refunded' ||
        ord.paymentStatus !== 'refunded' ||
        newT.usedAt !== null
      ) {
        return {
          allowed: false,
          errorMessage: `Transição para refunded negada no ingresso (${oldT.code}): exige pedido pai em status refunded e ausência de check-in.`,
        };
      }
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    errorMessage: `Transição de status inválida no ingresso (${oldT.code}): ${oldT.status} -> ${newT.status}.`,
  };
}

/**
 * Mirrors `public.cancel_ticket_order(p_order_id, p_reason)` in migration 002:
 * Cancels an unpaid reservation (`reserved` or `pending_payment`), decrements `reserved_quantity`
 * on the batch, and never deletes the order row.
 */
export function evaluateOrderCancellation(params: {
  callerUserId: string | null | undefined;
  jwtRole: string | null | undefined;
  isAdminOrSuperAdmin: boolean;
  sessionUser?: string | null;
  order: {
    id: string;
    orderCode: string;
    userId: string;
    quantity: number;
    orderStatus: OrderStatus;
    paymentStatus: PaymentStatus;
  };
  batchReservedQuantity: number;
  existingTicketCount: number;
}): {
  allowed: boolean;
  idempotentReplay: boolean;
  nextOrderStatus?: 'cancelled';
  nextPaymentStatus?: 'cancelled';
  releasedQuantity?: number;
  reservedQuantityDelta?: number;
  errorMessage?: string;
} {
  const cleanJwtRole = (params.jwtRole ?? '').trim();
  const cleanCallerId = (params.callerUserId ?? '').trim() || null;
  const cleanSessionUser = (params.sessionUser ?? '').trim();

  const isDirectDbAdmin =
    cleanJwtRole === '' &&
    cleanCallerId === null &&
    (cleanSessionUser === 'postgres' || cleanSessionUser === 'supabase_admin');

  const isAuthorized =
    cleanJwtRole === 'service_role' ||
    isDirectDbAdmin ||
    (cleanCallerId !== null && params.isAdminOrSuperAdmin) ||
    (cleanCallerId !== null && cleanCallerId === params.order.userId);

  if (!isAuthorized) {
    return {
      allowed: false,
      idempotentReplay: false,
      errorMessage:
        'Acesso negado: apenas o titular do pedido, um administrador ou o backend oficial podem cancelar esta reserva.',
    };
  }

  if (params.order.orderStatus === 'cancelled') {
    return {
      allowed: true,
      idempotentReplay: true,
      nextOrderStatus: 'cancelled',
      nextPaymentStatus: 'cancelled',
      releasedQuantity: params.order.quantity,
      reservedQuantityDelta: 0,
    };
  }

  if (params.order.orderStatus === 'paid') {
    return {
      allowed: false,
      idempotentReplay: false,
      errorMessage: `Não é possível cancelar diretamente um pedido já pago (${params.order.orderCode}). Utilize o fluxo transacional de reembolso (refund_ticket_order).`,
    };
  }

  if (
    params.order.orderStatus !== 'reserved' &&
    params.order.orderStatus !== 'pending_payment'
  ) {
    return {
      allowed: false,
      idempotentReplay: false,
      errorMessage: `Pedido (${params.order.orderCode}) em estado "${params.order.orderStatus}" não pode ser cancelado.`,
    };
  }

  if (params.existingTicketCount > 0) {
    return {
      allowed: false,
      idempotentReplay: false,
      errorMessage: `Inconsistência de integridade: reserva não paga (${params.order.orderCode}) possui ${params.existingTicketCount} ingressos vinculados.`,
    };
  }

  if (params.batchReservedQuantity < params.order.quantity) {
    return {
      allowed: false,
      idempotentReplay: false,
      errorMessage: `Inconsistência de estoque ao cancelar pedido (${params.order.orderCode}): reserved_quantity do lote (${params.batchReservedQuantity}) é menor que a quantidade do pedido (${params.order.quantity}).`,
    };
  }

  return {
    allowed: true,
    idempotentReplay: false,
    nextOrderStatus: 'cancelled',
    nextPaymentStatus: 'cancelled',
    releasedQuantity: params.order.quantity,
    reservedQuantityDelta: -params.order.quantity,
  };
}

/**
 * Mirrors `public.refund_ticket_order(p_order_id, p_mp_payment_id, p_reason)` in migration 002:
 * Enforces full-order atomic refund (`paid -> refunded`), blocks partial refunds or refunding
 * an order with any `'used'` ticket, preserves all issued ticket rows with `status = 'refunded'`,
 * and decrements `sold_quantity` and `events.tickets_sold`.
 */
export function evaluateOrderRefund(params: {
  callerUserId: string | null | undefined;
  jwtRole: string | null | undefined;
  isAdminOrSuperAdmin: boolean;
  sessionUser?: string | null;
  mpPaymentId: string;
  order: {
    id: string;
    orderCode: string;
    quantity: number;
    orderStatus: OrderStatus;
    paymentStatus: PaymentStatus;
    mpPaymentId: string | null;
  };
  ticketsOfOrder: Array<{ id: string; code: string; status: TicketStatus }>;
  batchSoldQuantity: number;
  eventTicketsSold: number;
}): {
  allowed: boolean;
  idempotentReplay: boolean;
  nextOrderStatus?: 'refunded';
  nextPaymentStatus?: 'refunded';
  ticketsRefunded?: number;
  soldQuantityDelta?: number;
  eventTicketsSoldDelta?: number;
  errorMessage?: string;
} {
  const cleanJwtRole = (params.jwtRole ?? '').trim();
  const cleanCallerId = (params.callerUserId ?? '').trim() || null;
  const cleanSessionUser = (params.sessionUser ?? '').trim();
  const cleanMpPaymentId = (params.mpPaymentId ?? '').trim();

  const isDirectDbAdmin =
    cleanJwtRole === '' &&
    cleanCallerId === null &&
    (cleanSessionUser === 'postgres' || cleanSessionUser === 'supabase_admin');

  const isAuthorized =
    cleanJwtRole === 'service_role' ||
    isDirectDbAdmin ||
    (cleanCallerId !== null && params.isAdminOrSuperAdmin);

  if (!isAuthorized) {
    return {
      allowed: false,
      idempotentReplay: false,
      errorMessage:
        'Operação não autorizada: apenas o backend de pagamentos (service_role) ou administradores autorizados podem registrar reembolso de pedidos.',
    };
  }

  if (!cleanMpPaymentId) {
    return {
      allowed: false,
      idempotentReplay: false,
      errorMessage:
        'Identificador oficial do pagamento no Mercado Pago (p_mp_payment_id) é obrigatório para validar o reembolso.',
    };
  }

  const totalTickets = params.ticketsOfOrder.length;
  const paidTickets = params.ticketsOfOrder.filter((t) => t.status === 'paid').length;
  const usedTickets = params.ticketsOfOrder.filter((t) => t.status === 'used').length;
  const refundedTickets = params.ticketsOfOrder.filter((t) => t.status === 'refunded').length;

  if (params.order.orderStatus === 'refunded') {
    if (params.order.mpPaymentId !== cleanMpPaymentId) {
      return {
        allowed: false,
        idempotentReplay: false,
        errorMessage: `Conflito no reembolso: o mp_payment_id informado ("${cleanMpPaymentId}") diverge do pagamento vinculado ao pedido ("${params.order.mpPaymentId ?? 'NULL'}").`,
      };
    }
    if (
      params.order.paymentStatus !== 'refunded' ||
      totalTickets !== params.order.quantity ||
      refundedTickets !== params.order.quantity
    ) {
      return {
        allowed: false,
        idempotentReplay: false,
        errorMessage: `Inconsistência de integridade em pedido já reembolsado (${params.order.orderCode}): esperado ${params.order.quantity} ingressos com status=refunded.`,
      };
    }
    return {
      allowed: true,
      idempotentReplay: true,
      nextOrderStatus: 'refunded',
      nextPaymentStatus: 'refunded',
      ticketsRefunded: refundedTickets,
      soldQuantityDelta: 0,
      eventTicketsSoldDelta: 0,
    };
  }

  if (params.order.orderStatus !== 'paid' || params.order.paymentStatus !== 'approved') {
    return {
      allowed: false,
      idempotentReplay: false,
      errorMessage: `Apenas pedidos com pagamento confirmado (order_status=paid, payment_status=approved) podem ser reembolsados (estado atual: ${params.order.orderStatus} / ${params.order.paymentStatus}).`,
    };
  }

  if (params.order.mpPaymentId !== cleanMpPaymentId) {
    return {
      allowed: false,
      idempotentReplay: false,
      errorMessage: `Divergência de pagamento: o mp_payment_id informado ("${cleanMpPaymentId}") não corresponde ao pagamento oficial do pedido ("${params.order.mpPaymentId ?? 'NULL'}").`,
    };
  }

  if (usedTickets > 0) {
    return {
      allowed: false,
      idempotentReplay: false,
      errorMessage: `Reembolso bloqueado no pedido ${params.order.orderCode}: ${usedTickets} de ${params.order.quantity} ingresso(s) já tiveram check-in realizado na portaria (status=used).`,
    };
  }

  if (totalTickets !== params.order.quantity || paidTickets !== params.order.quantity) {
    return {
      allowed: false,
      idempotentReplay: false,
      errorMessage: `Inconsistência de integridade no pedido ${params.order.orderCode}: esperado ${params.order.quantity} ingressos com status=paid para reembolso integral, encontrado total=${totalTickets} e paid=${paidTickets}.`,
    };
  }

  if (
    params.batchSoldQuantity < params.order.quantity ||
    params.eventTicketsSold < params.order.quantity
  ) {
    return {
      allowed: false,
      idempotentReplay: false,
      errorMessage: `Inconsistência de estoque ao reembolsar pedido (${params.order.orderCode}): sold_quantity do lote (${params.batchSoldQuantity}) ou tickets_sold do evento (${params.eventTicketsSold}) é menor que a quantidade do pedido (${params.order.quantity}).`,
    };
  }

  return {
    allowed: true,
    idempotentReplay: false,
    nextOrderStatus: 'refunded',
    nextPaymentStatus: 'refunded',
    ticketsRefunded: params.order.quantity,
    soldQuantityDelta: -params.order.quantity,
    eventTicketsSoldDelta: -params.order.quantity,
  };
}

/**
 * Mirrors the late payment conciliation contract between `confirm_order_payment` and
 * `record_late_payment_incident` in migration 002:
 * When Mercado Pago approves a payment for an order that has already transitioned to
 * `'expired'` or `'cancelled'`, the system NEVER issues tickets and NEVER reopens the
 * expired reservation; instead, it records an idempotent audit incident (`requiresRefund: true`)
 * in `public.audit_logs` for automatic refund / financial conciliation.
 */
export function evaluateLatePaymentConciliation(params: {
  jwtRole: string | null | undefined;
  order: {
    id: string;
    orderCode: string;
    totalAmount: number;
    orderStatus: OrderStatus;
    paymentStatus: PaymentStatus;
  };
  mpPaymentId: string;
  mpPaymentStatus: PaymentStatus;
  verifiedAmount: number;
  currency: string;
  externalReference: string;
  existingTicketCount: number;
  existingIncidentKeys?: Set<string>;
}): {
  action: 'confirm_payment' | 'record_late_payment_incident' | 'reject';
  incidentRecorded: boolean;
  requiresRefund: boolean;
  ticketsIssued: 0;
  idempotencyKey?: string;
  idempotentReplay?: boolean;
  errorMessage?: string;
} {
  const cleanJwtRole = (params.jwtRole ?? '').trim();
  if (cleanJwtRole !== 'service_role') {
    return {
      action: 'reject',
      incidentRecorded: false,
      requiresRefund: false,
      ticketsIssued: 0,
      errorMessage:
        'Operação restrita exclusivamente ao backend oficial de pagamentos (service_role).',
    };
  }

  const cleanPaymentId = (params.mpPaymentId ?? '').trim();
  const cleanExtRef = (params.externalReference ?? '').trim();
  const cleanCurrency = (params.currency ?? '').trim().toUpperCase();

  if (!cleanPaymentId || params.mpPaymentStatus !== 'approved') {
    return {
      action: 'reject',
      incidentRecorded: false,
      requiresRefund: false,
      ticketsIssued: 0,
      errorMessage: 'Apenas pagamentos aprovados com mp_payment_id válido podem ser conciliados.',
    };
  }

  if (
    !Number.isFinite(params.verifiedAmount) ||
    params.verifiedAmount <= 0 ||
    cleanCurrency !== 'BRL'
  ) {
    return {
      action: 'reject',
      incidentRecorded: false,
      requiresRefund: false,
      ticketsIssued: 0,
      errorMessage: 'Valor verificado e moeda BRL são obrigatórios.',
    };
  }

  if (cleanExtRef !== params.order.id && cleanExtRef !== params.order.orderCode) {
    return {
      action: 'reject',
      incidentRecorded: false,
      requiresRefund: false,
      ticketsIssued: 0,
      errorMessage: `Divergência de titularidade: external_reference ("${cleanExtRef}") não corresponde ao pedido (${params.order.id} / ${params.order.orderCode}).`,
    };
  }

  if (params.order.orderStatus === 'reserved' || params.order.orderStatus === 'pending_payment') {
    return {
      action: 'confirm_payment',
      incidentRecorded: false,
      requiresRefund: false,
      ticketsIssued: 0,
    };
  }

  if (params.order.orderStatus !== 'expired' && params.order.orderStatus !== 'cancelled') {
    return {
      action: 'reject',
      incidentRecorded: false,
      requiresRefund: false,
      ticketsIssued: 0,
      errorMessage: `Pedido (${params.order.orderCode}) em estado "${params.order.orderStatus}" não caracteriza pagamento tardio pós-expiração.`,
    };
  }

  if (params.existingTicketCount !== 0) {
    return {
      action: 'reject',
      incidentRecorded: false,
      requiresRefund: false,
      ticketsIssued: 0,
      errorMessage: `Inconsistência grave: pedido ${params.order.orderCode} em estado ${params.order.orderStatus} possui ${params.existingTicketCount} ingressos emitidos.`,
    };
  }

  const idempotencyKey = `late_payment:${params.order.id}:${cleanPaymentId}`;
  const isReplay = params.existingIncidentKeys?.has(idempotencyKey) ?? false;

  return {
    action: 'record_late_payment_incident',
    incidentRecorded: true,
    requiresRefund: true,
    ticketsIssued: 0,
    idempotencyKey,
    idempotentReplay: isReplay,
  };
}

/**
 * Mirrors `public.prevent_profile_privilege_escalation()` in migration 002:
 * - Blocks any attempt to modify `id` or `created_at` on `UPDATE`.
 * - Blocks modifying `role` unless caller is `service_role`, an authenticated admin,
 *   or a direct DB admin session (`postgres` / `supabase_admin` with no JWT).
 */
export function evaluateProfileUpdateIntegrity(params: {
  oldProfile: { id: string; createdAt: string; role: UserRole };
  newProfile: { id: string; createdAt: string; role: UserRole };
  jwtRole: string | null | undefined;
  authUid: string | null | undefined;
  isAdminOrSuperAdmin: boolean;
  sessionUser: string | null | undefined;
}): {
  allowed: boolean;
  errorMessage?: string;
} {
  if (params.newProfile.id !== params.oldProfile.id) {
    return {
      allowed: false,
      errorMessage: 'Operação negada: o identificador do perfil (id) é imutável.',
    };
  }

  if (params.newProfile.createdAt !== params.oldProfile.createdAt) {
    return {
      allowed: false,
      errorMessage: 'Operação negada: a data de criação do perfil (created_at) é imutável.',
    };
  }

  if (params.newProfile.role !== params.oldProfile.role) {
    const cleanJwtRole = (params.jwtRole ?? '').trim();
    const cleanAuthUid = (params.authUid ?? '').trim() || null;
    const cleanSessionUser = (params.sessionUser ?? '').trim();

    const isAuthorized =
      cleanJwtRole === 'service_role' ||
      (cleanAuthUid !== null && params.isAdminOrSuperAdmin) ||
      (cleanJwtRole === '' &&
        cleanAuthUid === null &&
        (cleanSessionUser === 'postgres' || cleanSessionUser === 'supabase_admin'));

    if (!isAuthorized) {
      return {
        allowed: false,
        errorMessage: 'Operação negada: alteração de papel administrativo não autorizada.',
      };
    }
  }

  return { allowed: true };
}

/**
 * Mirrors the authorization logic of `public.release_expired_reservations()` in migration 002:
 * Allows execution ONLY when:
 * 1. `jwtRole === 'service_role'`, OR
 * 2. The caller is an authenticated admin (`authUid` present and `isAdminOrSuperAdmin === true`), OR
 * 3. Direct database administrative session (`jwtRole === ''`, `authUid === null`, and `sessionUser` in `['postgres', 'supabase_admin']`).
 * Never trusts `current_user`.
 */
export function evaluateReleaseExpiredReservationsAccess(params: {
  jwtRole: string | null | undefined;
  authUid: string | null | undefined;
  isAdminOrSuperAdmin: boolean;
  sessionUser: string | null | undefined;
}): {
  allowed: boolean;
  authorizedBy?: 'service_role' | 'authenticated_admin' | 'direct_db_admin';
  errorMessage?: string;
} {
  const cleanJwtRole = (params.jwtRole ?? '').trim();
  const cleanAuthUid = (params.authUid ?? '').trim() || null;
  const cleanSessionUser = (params.sessionUser ?? '').trim();

  if (cleanJwtRole === 'service_role') {
    return {
      allowed: true,
      authorizedBy: 'service_role',
    };
  }

  if (cleanAuthUid !== null && params.isAdminOrSuperAdmin) {
    return {
      allowed: true,
      authorizedBy: 'authenticated_admin',
    };
  }

  if (
    cleanJwtRole === '' &&
    cleanAuthUid === null &&
    (cleanSessionUser === 'postgres' || cleanSessionUser === 'supabase_admin')
  ) {
    return {
      allowed: true,
      authorizedBy: 'direct_db_admin',
    };
  }

  return {
    allowed: false,
    errorMessage:
      'Operação não autorizada: apenas o backend (service_role), administradores autenticados ou sessão administrativa direta do banco podem liberar reservas expiradas.',
  };
}

/**
 * Mirrors `public.enforce_ticket_category_integrity()` in migration 002:
 * - Blocks deleting a category that has batches with sold/reserved tickets, orders, or issued tickets.
 * - Blocks modifying `id`, `event_id`, or `created_at` on `UPDATE`.
 * - Blocks deactivating a category (`active: true -> false`) while any linked batch is active.
 */
export function evaluateTicketCategoryMutationIntegrity(params: {
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  eventExists?: boolean;
  oldCategory?: {
    id: string;
    eventId: string;
    name: string;
    active: boolean;
    createdAt: string;
  };
  newCategory?: {
    id: string;
    eventId: string;
    name: string;
    active: boolean;
    createdAt: string;
  };
  batchesOfCategory?: Array<{
    id: string;
    active: boolean;
    soldQuantity: number;
    reservedQuantity: number;
    hasOrders?: boolean;
  }>;
  ticketsCountForCategory?: number;
}): {
  allowed: boolean;
  errorMessage?: string;
} {
  const batches = params.batchesOfCategory ?? [];
  const ticketsCount = params.ticketsCountForCategory ?? 0;

  if (params.operation === 'DELETE') {
    const oldC = params.oldCategory;
    if (!oldC) {
      return { allowed: false, errorMessage: 'Categoria original ausente para exclusão.' };
    }
    const hasCommittedBatch = batches.some(
      (b) => b.soldQuantity > 0 || b.reservedQuantity > 0 || Boolean(b.hasOrders)
    );
    if (hasCommittedBatch || ticketsCount > 0) {
      return {
        allowed: false,
        errorMessage: `Não é permitido excluir a categoria "${oldC.name}" (${oldC.id}) porque existem lotes com vendas, reservas, pedidos ou ingressos vinculados. Desative os lotes e a categoria (active = false) para preservar o histórico.`,
      };
    }
    return { allowed: true };
  }

  const newC = params.newCategory;
  if (!newC) {
    return { allowed: false, errorMessage: 'Dados da categoria ausentes.' };
  }

  if (params.operation === 'INSERT') {
    if (params.eventExists === false) {
      return {
        allowed: false,
        errorMessage: `Evento (${newC.eventId}) associado à categoria não encontrado.`,
      };
    }
    return { allowed: true };
  }

  const oldC = params.oldCategory;
  if (!oldC) {
    return { allowed: false, errorMessage: 'Registro anterior da categoria ausente para UPDATE.' };
  }

  if (newC.id !== oldC.id) {
    return {
      allowed: false,
      errorMessage: 'Operação negada: o identificador da categoria (id) é imutável.',
    };
  }

  if (newC.createdAt !== oldC.createdAt) {
    return {
      allowed: false,
      errorMessage: 'Operação negada: a data de criação da categoria (created_at) é imutável.',
    };
  }

  if (newC.eventId !== oldC.eventId) {
    return {
      allowed: false,
      errorMessage: `Não é permitido alterar o event_id de uma categoria existente (${oldC.eventId} -> ${newC.eventId}).`,
    };
  }

  if (oldC.active && !newC.active) {
    const hasActiveBatch = batches.some((b) => b.active);
    if (hasActiveBatch) {
      return {
        allowed: false,
        errorMessage: `Não é permitido desativar a categoria "${newC.name}" (${newC.id}) enquanto houver lotes ativos vinculados a ela. Desative os lotes primeiro.`,
      };
    }
  }

  return { allowed: true };
}

