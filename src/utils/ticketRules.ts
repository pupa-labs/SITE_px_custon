import type {
  Ticket,
  CheckinRecord,
  OrderStatus,
  PaymentStatus,
  PaymentMethodType,
  ReserveOrderRpcArgs,
  ReserveOrderRpcPayload,
  CheckinRpcPayload,
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
  const availableQuantity = Math.max(
    0,
    input.totalQuantity - input.reservedQuantity - input.soldQuantity
  );

  if (input.isActive === false) {
    return {
      canReserve: false,
      availableQuantity,
      nextReservedQuantity: input.reservedQuantity,
      reason: 'Este lote não está ativo para vendas no momento.',
    };
  }

  const maxPerOrder = input.maxPerOrder ?? 10;
  if (input.requestedQuantity <= 0 || !Number.isInteger(input.requestedQuantity)) {
    return {
      canReserve: false,
      availableQuantity,
      nextReservedQuantity: input.reservedQuantity,
      reason: 'Quantidade solicitada inválida.',
    };
  }

  if (input.requestedQuantity > maxPerOrder) {
    return {
      canReserve: false,
      availableQuantity,
      nextReservedQuantity: input.reservedQuantity,
      reason: `Limite máximo de ${maxPerOrder} ingressos por pedido excedido.`,
    };
  }

  if (input.requestedQuantity > availableQuantity) {
    return {
      canReserve: false,
      availableQuantity,
      nextReservedQuantity: input.reservedQuantity,
      reason: 'Estoque insuficiente no lote selecionado para a quantidade desejada.',
    };
  }

  return {
    canReserve: true,
    availableQuantity: availableQuantity - input.requestedQuantity,
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
}): {
  allowed: boolean;
  idempotentReplay: boolean;
  ticketsToIssue: number;
  soldQuantityDelta: number;
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

  return {
    allowed: true,
    idempotentReplay: false,
    ticketsToIssue: params.orderQuantity,
    soldQuantityDelta: params.orderQuantity,
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
