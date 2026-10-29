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
  backfillTicketItemSequences,
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

test('evaluatePaymentConfirmationIdempotency enforces official MP API check, non-null amount, BRL currency, external_reference binding, and idempotent replay', () => {
  const baseValid = {
    callerRole: 'service_role' as const,
    paymentVerifiedFromOfficialMpApi: true,
    orderId: 'ord-1111',
    orderCode: '#PX-90421',
    orderQuantity: 2,
    orderTotalAmount: 84.8,
    currentOrderStatus: 'reserved' as const,
    currentPaymentStatus: 'pending' as const,
    existingMpPaymentId: null,
    existingTicketsCount: 0,
    incomingMpPaymentId: 'MP-1001',
    incomingMpPaymentStatus: 'approved' as const,
    verifiedGatewayAmount: 84.8,
    verifiedCurrency: 'BRL',
    externalReference: 'ord-1111',
  };

  // 1. Rejects non-service_role callers
  assert.equal(
    evaluatePaymentConfirmationIdempotency({ ...baseValid, callerRole: 'authenticated' }).allowed,
    false
  );

  // 2. Rejects confirmation if official Mercado Pago API was not queried beforehand
  assert.equal(
    evaluatePaymentConfirmationIdempotency({
      ...baseValid,
      paymentVerifiedFromOfficialMpApi: false,
    }).allowed,
    false
  );

  // 3. Rejects when verifiedGatewayAmount is null (cannot bypass amount check)
  const nullAmount = evaluatePaymentConfirmationIdempotency({
    ...baseValid,
    verifiedGatewayAmount: null,
  });
  assert.equal(nullAmount.allowed, false);
  assert.ok(nullAmount.errorMessage?.includes('p_verified_amount'));

  // 4. Rejects wrong currency or wrong external_reference (order mismatch)
  assert.equal(
    evaluatePaymentConfirmationIdempotency({ ...baseValid, verifiedCurrency: 'USD' }).allowed,
    false
  );
  assert.equal(
    evaluatePaymentConfirmationIdempotency({
      ...baseValid,
      externalReference: 'ord-OTHER-9999',
    }).allowed,
    false
  );

  // 5. First valid confirmation issues exact order quantity and increments sold quantity once
  const firstConfirmation = evaluatePaymentConfirmationIdempotency(baseValid);
  assert.equal(firstConfirmation.allowed, true);
  assert.equal(firstConfirmation.idempotentReplay, false);
  assert.equal(firstConfirmation.ticketsToIssue, 2);
  assert.equal(firstConfirmation.soldQuantityDelta, 2);

  // 6. Replay with the SAME mp_payment_id on an already-paid order is idempotent (0 new tickets, 0 soldQuantityDelta)
  const samePaymentReplay = evaluatePaymentConfirmationIdempotency({
    ...baseValid,
    currentOrderStatus: 'paid',
    currentPaymentStatus: 'approved',
    existingMpPaymentId: 'MP-1001',
    existingTicketsCount: 2,
  });
  assert.equal(samePaymentReplay.allowed, true);
  assert.equal(samePaymentReplay.idempotentReplay, true);
  assert.equal(samePaymentReplay.ticketsToIssue, 0);
  assert.equal(samePaymentReplay.soldQuantityDelta, 0);

  // 7. Replay on an already-paid order with a DIFFERENT mp_payment_id is rejected
  const conflictingPaymentIdOnPaidOrder = evaluatePaymentConfirmationIdempotency({
    ...baseValid,
    currentOrderStatus: 'paid',
    currentPaymentStatus: 'approved',
    existingMpPaymentId: 'MP-1001',
    existingTicketsCount: 2,
    incomingMpPaymentId: 'MP-9999-DIFFERENT',
  });
  assert.equal(conflictingPaymentIdOnPaidOrder.allowed, false);
  assert.ok(conflictingPaymentIdOnPaidOrder.errorMessage?.includes('Conflito de idempotência'));
});

test('backfillTicketItemSequences deterministically assigns gap-free item_sequence and aborts on orphans, out-of-range, or excess duplicates', () => {
  // 1. Gap-free assignment when an order already has item_sequence=2 and one NULL ticket
  const gapFreeBackfill = backfillTicketItemSequences(
    [{ id: 'ord-1', orderCode: '#PX-001', quantity: 2 }],
    [
      {
        id: 'tkt-b',
        orderId: 'ord-1',
        code: 'PX-0002',
        issuedAt: '2026-10-01T12:00:05Z',
        createdAt: '2026-10-01T12:00:05Z',
        itemSequence: 2,
      },
      {
        id: 'tkt-a',
        orderId: 'ord-1',
        code: 'PX-0001',
        issuedAt: '2026-10-01T12:00:01Z',
        createdAt: '2026-10-01T12:00:01Z',
        itemSequence: null,
      },
    ]
  );
  assert.equal(gapFreeBackfill.ok, true);
  assert.deepEqual(gapFreeBackfill.backfilledTickets, [
    { id: 'tkt-a', orderId: 'ord-1', itemSequence: 1 },
    { id: 'tkt-b', orderId: 'ord-1', itemSequence: 2 },
  ]);

  // 2. Rejects orphan tickets whose order_id does not exist
  const orphanTicket = backfillTicketItemSequences(
    [{ id: 'ord-1', orderCode: '#PX-001', quantity: 2 }],
    [
      {
        id: 'tkt-orphan',
        orderId: 'ord-MISSING',
        code: 'PX-9999',
        issuedAt: '2026-10-01T12:00:01Z',
        createdAt: '2026-10-01T12:00:01Z',
        itemSequence: null,
      },
    ]
  );
  assert.equal(orphanTicket.ok, false);
  assert.ok(orphanTicket.errorMessage?.includes('order_id inexistente'));

  // 3. Rejects out-of-range item_sequence (> order.quantity)
  const outOfRange = backfillTicketItemSequences(
    [{ id: 'ord-1', orderCode: '#PX-001', quantity: 2 }],
    [
      {
        id: 'tkt-1',
        orderId: 'ord-1',
        code: 'PX-0001',
        issuedAt: '2026-10-01T12:00:01Z',
        createdAt: '2026-10-01T12:00:01Z',
        itemSequence: 5,
      },
    ]
  );
  assert.equal(outOfRange.ok, false);
  assert.ok(outOfRange.errorMessage?.includes('fora do intervalo válido'));

  // 4. Rejects excess tickets (> order.quantity)
  const excessTickets = backfillTicketItemSequences(
    [{ id: 'ord-1', orderCode: '#PX-001', quantity: 1 }],
    [
      {
        id: 'tkt-1',
        orderId: 'ord-1',
        code: 'PX-0001',
        issuedAt: '2026-10-01T12:00:01Z',
        createdAt: '2026-10-01T12:00:01Z',
        itemSequence: null,
      },
      {
        id: 'tkt-2',
        orderId: 'ord-1',
        code: 'PX-0002',
        issuedAt: '2026-10-01T12:00:02Z',
        createdAt: '2026-10-01T12:00:02Z',
        itemSequence: null,
      },
    ]
  );
  assert.equal(excessTickets.ok, false);
  assert.ok(excessTickets.errorMessage?.includes('acima da quantidade contratada'));
});

test('migration 002 SQL file enforces strict Mercado Pago verification, no current_user misuse, deterministic backfill, and RLS-compatible permissions', () => {
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

  // 2. confirm_order_payment has NO default values for status or amount, uses pg_advisory_xact_lock, checks currency & external_reference, and never uses current_user
  assert.equal(sql.includes("DEFAULT 'approved'"), false);
  assert.equal(sql.includes('p_verified_amount NUMERIC(12, 2) DEFAULT NULL'), false);
  assert.equal(sql.includes("current_user NOT IN ('postgres', 'supabase_admin')"), false);
  assert.ok(sql.includes("PERFORM pg_advisory_xact_lock(hashtext('px_mp_payment:' || v_clean_payment_id));"));
  assert.ok(sql.includes('IF p_verified_amount IS NULL OR p_verified_amount <= 0 THEN'));
  assert.ok(sql.includes("IF v_clean_currency <> 'BRL' THEN"));
  assert.ok(
    sql.includes('IF v_clean_ext_ref <> v_order.id::text AND v_clean_ext_ref <> v_order.order_code THEN')
  );

  // 3. Deterministic gap-free backfill of item_sequence + full non-partial unique index
  assert.ok(sql.includes('CROSS JOIN LATERAL generate_series(1, ow.quantity)'));
  assert.ok(sql.includes('ALTER TABLE public.tickets\n  ALTER COLUMN item_sequence SET NOT NULL;'));
  assert.ok(
    sql.includes('CREATE UNIQUE INDEX uq_tickets_order_item_sequence\n  ON public.tickets(order_id, item_sequence);')
  );

  // 4. Helper function permissions preserve RLS execution for anon/authenticated where required while locking down privileged RPCs
  assert.ok(
    sql.includes(
      'GRANT EXECUTE ON FUNCTION public.is_admin_or_super_admin() TO anon, authenticated, service_role;'
    )
  );
  assert.ok(
    sql.includes(
      'REVOKE ALL ON FUNCTION public.is_checkin_staff() FROM PUBLIC, anon, authenticated;'
    )
  );
  assert.ok(
    sql.includes(
      'REVOKE ALL ON FUNCTION public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;'
    )
  );
  assert.ok(
    sql.includes(
      'GRANT EXECUTE ON FUNCTION public.confirm_order_payment(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO service_role;'
    )
  );
});
