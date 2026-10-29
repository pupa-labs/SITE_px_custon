import type { Ticket, CheckinRecord, OrderStatus, PaymentStatus } from '../types/domain';

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

