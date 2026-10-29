import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  calculateOrderTotals,
  formatBRL,
  validateBuyerData,
  verifyAndProcessCheckin,
  validateBatchStockAvailability,
  canTransitionOrderToPaid,
  buildReserveOrderRpcArgs,
  normalizeReserveOrderRpcResponse,
  normalizeCheckinRpcResponse,
  evaluatePaymentConfirmationIdempotency,
} from './ticketRules';
import type { Ticket } from '../types/domain';

test('calculateOrderTotals matches reference checkout math (2 x R$ 40,00 = R$ 80,00 + R$ 4,80 = R$ 84,80)', () => {
  const totals = calculateOrderTotals(40, 2);
  assert.equal(totals.subtotal, 80);
  assert.equal(totals.convenienceFee, 4.8);
  assert.equal(totals.total, 84.8);
});

test('formatBRL formats currency in Brazilian format', () => {
  assert.equal(formatBRL(40), 'R$ 40,00');
  assert.equal(formatBRL(84.8), 'R$ 84,80');
  assert.equal(formatBRL(48750), 'R$ 48.750,00');
});

test('validateBuyerData enforces full name, CPF, email, and phone', () => {
  const valid = validateBuyerData({
    fullName: 'João da Silva',
    cpf: '123.456.789-00',
    email: 'joao@email.com',
    phone: '(11) 98765-4321',
  });
  assert.equal(valid.valid, true);

  const invalid = validateBuyerData({
    fullName: 'João',
    cpf: '111.111.111-11',
    email: 'invalido',
    phone: '123',
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.fullName);
  assert.ok(invalid.errors.cpf);
  assert.ok(invalid.errors.email);
  assert.ok(invalid.errors.phone);
});

test('verifyAndProcessCheckin authorizes valid paid ticket once and blocks reuse', () => {
  const sampleTicket: Ticket = {
    id: 't-1',
    code: 'PX-784592',
    qrPayload: 'PXCUSTON|PX-784592|EVT-01',
    orderId: 'ORD-9001',
    paymentId: 'MP-991203',
    userId: 'usr-1',
    holderName: 'João da Silva',
    holderCpf: '123.456.789-00',
    eventId: 'evt-rebaixados',
    eventTitle: 'Encontro Nacional de Carros Rebaixados',
    eventDate: '25/04/2025',
    eventLocation: 'São Paulo - SP',
    eventImageUrl: '/assets/events/ev-rebaixados.jpg',
    ticketTypeId: 'lot-pista',
    ticketTypeName: 'Pista (1º Lote Promocional)',
    pricePaid: 40,
    status: 'paid',
    issuedAt: '10/04/2025 14:20',
  };

  // First scan: authorized
  const firstCheckin = verifyAndProcessCheckin(
    'PX-784592',
    [sampleTicket],
    'Carlos Souza',
    '25/04/2025 14:32'
  );
  assert.equal(firstCheckin.authorized, true);
  assert.equal(firstCheckin.statusReason, 'authorized');
  assert.equal(firstCheckin.updatedTicket?.status, 'used');

  // Second scan with updated ticket: blocked
  const secondCheckin = verifyAndProcessCheckin(
    'PX-784592',
    [firstCheckin.updatedTicket!],
    'Carlos Souza',
    '25/04/2025 14:35'
  );
  assert.equal(secondCheckin.authorized, false);
  assert.equal(secondCheckin.statusReason, 'already_used');
});

test('validateBatchStockAvailability prevents overselling when reserved + sold + requested exceeds total', () => {
  const allowed = validateBatchStockAvailability({
    totalQuantity: 100,
    reservedQuantity: 15,
    soldQuantity: 80,
    requestedQuantity: 5,
    maxPerOrder: 6,
    isActive: true,
  });
  assert.equal(allowed.canReserve, true);
  assert.equal(allowed.availableQuantity, 0);
  assert.equal(allowed.nextReservedQuantity, 20);

  const oversold = validateBatchStockAvailability({
    totalQuantity: 100,
    reservedQuantity: 15,
    soldQuantity: 80,
    requestedQuantity: 6,
    maxPerOrder: 10,
    isActive: true,
  });
  assert.equal(oversold.canReserve, false);
  assert.ok(oversold.reason?.includes('Estoque insuficiente'));

  const exceedsMaxPerOrder = validateBatchStockAvailability({
    totalQuantity: 500,
    reservedQuantity: 10,
    soldQuantity: 50,
    requestedQuantity: 8,
    maxPerOrder: 5,
    isActive: true,
  });
  assert.equal(exceedsMaxPerOrder.canReserve, false);
  assert.ok(exceedsMaxPerOrder.reason?.includes('Limite máximo'));
});

test('canTransitionOrderToPaid blocks marking order as paid before official payment approval', () => {
  const blockedPending = canTransitionOrderToPaid({
    currentOrderStatus: 'reserved',
    paymentStatus: 'pending',
    mpPaymentId: 'MP-12345',
  });
  assert.equal(blockedPending.allowed, false);

  const blockedNoGatewayId = canTransitionOrderToPaid({
    currentOrderStatus: 'pending_payment',
    paymentStatus: 'approved',
    mpPaymentId: '',
  });
  assert.equal(blockedNoGatewayId.allowed, false);

  const blockedExpiredOrder = canTransitionOrderToPaid({
    currentOrderStatus: 'expired',
    paymentStatus: 'approved',
    mpPaymentId: 'MP-99999',
  });
  assert.equal(blockedExpiredOrder.allowed, false);

  const approvedValid = canTransitionOrderToPaid({
    currentOrderStatus: 'pending_payment',
    paymentStatus: 'approved',
    mpPaymentId: 'MP-884920192',
  });
  assert.equal(approvedValid.allowed, true);
});

test('buildReserveOrderRpcArgs aligns p_ticket_batch_id parameter, requires authenticated user, and never sends client prices', () => {
  const unauthenticated = buildReserveOrderRpcArgs({
    authenticatedUserId: null,
    ticketBatchId: '11111111-2222-3333-4444-555555555555',
    quantity: 2,
    buyerName: 'João da Silva',
    buyerCpf: '123.456.789-00',
    buyerEmail: 'joao@email.com',
    buyerPhone: '(11) 98765-4321',
    paymentMethod: 'pix',
  });
  assert.equal(unauthenticated.ok, false);

  const authenticated = buildReserveOrderRpcArgs({
    authenticatedUserId: 'aaaa1111-bbbb-2222-cccc-333333333333',
    ticketBatchId: '11111111-2222-3333-4444-555555555555',
    quantity: 2,
    buyerName: 'João da Silva',
    buyerCpf: '123.456.789-00',
    buyerEmail: 'joao@email.com',
    buyerPhone: '(11) 98765-4321',
    paymentMethod: 'pix',
  });
  assert.equal(authenticated.ok, true);
  if (authenticated.ok) {
    assert.deepEqual(Object.keys(authenticated.args).sort(), [
      'p_buyer_cpf',
      'p_buyer_email',
      'p_buyer_name',
      'p_buyer_phone',
      'p_payment_method',
      'p_quantity',
      'p_ticket_batch_id',
    ]);
    assert.equal(authenticated.args.p_ticket_batch_id, '11111111-2222-3333-4444-555555555555');
    assert.equal(authenticated.args.p_buyer_cpf, '12345678900');
    assert.equal('price' in authenticated.args, false);
    assert.equal('total_amount' in authenticated.args, false);
  }
});

test('normalizeReserveOrderRpcResponse validates JSONB payload from reserve_ticket_order and rejects raw UUID', () => {
  const legacyRawUuid = normalizeReserveOrderRpcResponse('99999999-8888-7777-6666-555555555555');
  assert.equal(legacyRawUuid.ok, false);

  const validJsonb = normalizeReserveOrderRpcResponse({
    order_id: '99999999-8888-7777-6666-555555555555',
    order_code: '#PX-1A2B3C4D',
    unit_price: '40.00',
    subtotal: '80.00',
    convenience_fee: '4.80',
    total_amount: '84.80',
    order_status: 'reserved',
    payment_status: 'pending',
    reservation_expires_at: '2026-10-29T10:30:00Z',
  });
  assert.equal(validJsonb.ok, true);
  assert.equal(validJsonb.orderId, '99999999-8888-7777-6666-555555555555');
  assert.equal(validJsonb.orderCode, '#PX-1A2B3C4D');
  assert.equal(validJsonb.unitPrice, 40);
  assert.equal(validJsonb.subtotal, 80);
  assert.equal(validJsonb.convenienceFee, 4.8);
  assert.equal(validJsonb.totalAmount, 84.8);
  assert.equal(validJsonb.orderStatus, 'reserved');
  assert.equal(validJsonb.paymentStatus, 'pending');
  assert.equal(validJsonb.reservationExpiresAt, '2026-10-29T10:30:00Z');
});

test('normalizeCheckinRpcResponse aligns result/status_reason and ticket_code/code fields', () => {
  const migration002Response = normalizeCheckinRpcResponse({
    authorized: true,
    result: 'authorized',
    status_reason: 'authorized',
    ticket_id: 'tkt-uuid-1',
    ticket_code: 'PX-784592',
    code: 'PX-784592',
    holder_name: 'João da Silva',
    message: 'Entrada autorizada!',
  });
  assert.equal(migration002Response.ok, true);
  assert.equal(migration002Response.authorized, true);
  assert.equal(migration002Response.result, 'authorized');
  assert.equal(migration002Response.ticketCode, 'PX-784592');
  assert.equal(migration002Response.holderName, 'João da Silva');

  const legacy001Response = normalizeCheckinRpcResponse({
    authorized: false,
    status_reason: 'already_used',
    code: 'PX-784592',
    message: 'Ingresso já utilizado anteriormente. Reutilização bloqueada.',
  });
  assert.equal(legacy001Response.ok, true);
  assert.equal(legacy001Response.authorized, false);
  assert.equal(legacy001Response.result, 'already_used');
  assert.equal(legacy001Response.ticketCode, 'PX-784592');
});

test('evaluatePaymentConfirmationIdempotency enforces service_role, verified payment ID match, and prevents duplicate tickets', () => {
  // 1. Rejects non-service_role callers
  const fromClient = evaluatePaymentConfirmationIdempotency({
    callerRole: 'authenticated',
    orderId: 'ord-1',
    orderQuantity: 2,
    orderTotalAmount: 84.8,
    currentOrderStatus: 'reserved',
    currentPaymentStatus: 'pending',
    existingMpPaymentId: null,
    existingTicketsCount: 0,
    incomingMpPaymentId: 'MP-1001',
    incomingMpPaymentStatus: 'approved',
  });
  assert.equal(fromClient.allowed, false);

  // 2. Rejects payment ID when gateway status is not 'approved'
  const unapprovedGateway = evaluatePaymentConfirmationIdempotency({
    callerRole: 'service_role',
    orderId: 'ord-1',
    orderQuantity: 2,
    orderTotalAmount: 84.8,
    currentOrderStatus: 'reserved',
    currentPaymentStatus: 'pending',
    existingMpPaymentId: null,
    existingTicketsCount: 0,
    incomingMpPaymentId: 'MP-1001',
    incomingMpPaymentStatus: 'in_process',
  });
  assert.equal(unapprovedGateway.allowed, false);

  // 3. First valid confirmation issues exact order quantity
  const firstConfirmation = evaluatePaymentConfirmationIdempotency({
    callerRole: 'service_role',
    orderId: 'ord-1',
    orderQuantity: 2,
    orderTotalAmount: 84.8,
    currentOrderStatus: 'reserved',
    currentPaymentStatus: 'pending',
    existingMpPaymentId: null,
    existingTicketsCount: 0,
    incomingMpPaymentId: 'MP-1001',
    incomingMpPaymentStatus: 'approved',
    verifiedGatewayAmount: 84.8,
  });
  assert.equal(firstConfirmation.allowed, true);
  assert.equal(firstConfirmation.idempotentReplay, false);
  assert.equal(firstConfirmation.ticketsToIssue, 2);

  // 4. Replay with the SAME mp_payment_id on an already-paid order is idempotent and issues 0 new tickets
  const samePaymentReplay = evaluatePaymentConfirmationIdempotency({
    callerRole: 'service_role',
    orderId: 'ord-1',
    orderQuantity: 2,
    orderTotalAmount: 84.8,
    currentOrderStatus: 'paid',
    currentPaymentStatus: 'approved',
    existingMpPaymentId: 'MP-1001',
    existingTicketsCount: 2,
    incomingMpPaymentId: 'MP-1001',
    incomingMpPaymentStatus: 'approved',
    verifiedGatewayAmount: 84.8,
  });
  assert.equal(samePaymentReplay.allowed, true);
  assert.equal(samePaymentReplay.idempotentReplay, true);
  assert.equal(samePaymentReplay.ticketsToIssue, 0);

  // 5. Replay on an already-paid order with a DIFFERENT mp_payment_id is rejected
  const conflictingPaymentIdOnPaidOrder = evaluatePaymentConfirmationIdempotency({
    callerRole: 'service_role',
    orderId: 'ord-1',
    orderQuantity: 2,
    orderTotalAmount: 84.8,
    currentOrderStatus: 'paid',
    currentPaymentStatus: 'approved',
    existingMpPaymentId: 'MP-1001',
    existingTicketsCount: 2,
    incomingMpPaymentId: 'MP-9999-DIFFERENT',
    incomingMpPaymentStatus: 'approved',
  });
  assert.equal(conflictingPaymentIdOnPaidOrder.allowed, false);
  assert.ok(conflictingPaymentIdOnPaidOrder.errorMessage?.includes('Conflito de idempotência'));
});

test('migration 002 SQL file enforces RPC parameter names, JSONB returns, REVOKE permissions, and idempotency checks', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/002_rpc_contracts_permissions_idempotency.sql'
  );
  const sql = fs.readFileSync(migrationPath, 'utf8');

  // 1. reserve_ticket_order uses p_ticket_batch_id and returns JSONB with required fields
  assert.ok(sql.includes('p_ticket_batch_id UUID'));
  assert.ok(sql.includes("'order_id', v_order_id"));
  assert.ok(sql.includes("'order_code', v_order_code"));
  assert.ok(sql.includes("'total_amount', v_total"));
  assert.ok(sql.includes("'reservation_expires_at', v_expires_at"));

  // 2. perform_ticket_checkin includes 'result' and 'ticket_code'
  assert.ok(sql.includes("'result', 'authorized'"));
  assert.ok(sql.includes("'ticket_code', v_ticket.code"));

  // 3. Explicit REVOKE ALL FROM PUBLIC, anon, authenticated on all 4 privileged functions
  assert.ok(
    sql.includes(
      'REVOKE ALL ON FUNCTION public.reserve_ticket_order(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;'
    )
  );
  assert.ok(
    sql.includes(
      'REVOKE ALL ON FUNCTION public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;'
    )
  );
  assert.ok(
    sql.includes(
      'GRANT EXECUTE ON FUNCTION public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC) TO service_role;'
    )
  );
  assert.ok(
    sql.includes(
      'REVOKE ALL ON FUNCTION public.release_expired_reservations() FROM PUBLIC, anon, authenticated;'
    )
  );
  assert.ok(
    sql.includes(
      'REVOKE ALL ON FUNCTION public.perform_ticket_checkin(TEXT, TEXT) FROM PUBLIC, anon, authenticated;'
    )
  );

  // 4. Idempotency payment ID verification and duplicate ticket prevention
  assert.ok(sql.includes('IF v_order.mp_payment_id IS DISTINCT FROM v_clean_payment_id THEN'));
  assert.ok(sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_order_item_sequence'));
});
