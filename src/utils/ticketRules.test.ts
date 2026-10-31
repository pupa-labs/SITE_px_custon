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
  mapDbProfileRowToProfile,
  buildSafeSignUpMetadata,
  evaluateAdminAccess,
  generateEventSlug,
  parseEventDateToIso,
  formatIsoDateToBr,
  mapUiEventStatusToDb,
  mapDbEventStatusToUi,
  validateAndBuildEventWritePayload,
  translateEventDatabaseError,
  translateBatchOrCategoryDatabaseError,
  issueTicketsWithCollisionRetry,
  evaluateReleaseExpiredReservationsAccess,
  evaluateBatchAllocationIntegrity,
  evaluateTicketCategoryMutationIntegrity,
  evaluateEventCapacityUpdateIntegrity,
  auditDatabaseCountersIntegrity,
  evaluateOrderMutationIntegrity,
  evaluateTicketMutationIntegrity,
  evaluateOrderCancellation,
  evaluateOrderRefund,
  evaluateLatePaymentConciliation,
  evaluateProfileUpdateIntegrity,
  RECOVERABLE_TICKET_UNIQUE_CONSTRAINTS,
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

  // 5. Global event capacity & canonical lock order (px_event_inventory -> events -> ticket_batches ORDER BY id ASC) without GREATEST masking
  assert.equal(sql.includes('GREATEST('), false);
  assert.ok(
    sql.includes("PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:'")
  );
  assert.ok(
    sql.includes('IF v_event.tickets_sold <> v_event_sold_quantity THEN')
  );
  assert.ok(
    sql.includes(
      'IF (v_event.tickets_sold + v_event_reserved_quantity + p_quantity) > v_event.capacity THEN'
    )
  );
  assert.ok(sql.includes('CREATE TRIGGER trg_events_enforce_capacity_vs_batches'));
  assert.ok(sql.includes('CREATE TRIGGER trg_ticket_batches_enforce_event_capacity'));

  // 6. Collision-resistant ticket code loop with bounded attempts and explicit whitelist ('tickets_code_key', 'tickets_qr_payload_key')
  assert.ok(sql.includes('FOR v_code_attempt IN 1..v_max_code_attempts LOOP'));
  assert.ok(
    sql.includes(
      "v_ticket_code := 'PX-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));"
    )
  );
  assert.ok(
    sql.includes(
      "IF COALESCE(v_constraint_name, '') NOT IN ('tickets_code_key', 'tickets_qr_payload_key') THEN"
    )
  );

  // 7. release_expired_reservations allows service_role, admin, and verified direct DB admin session
  assert.ok(
    sql.includes(
      "AND NOT (v_jwt_role = '' AND auth.uid() IS NULL AND session_user IN ('postgres', 'supabase_admin'))"
    )
  );
  assert.ok(sql.includes('ORDER BY event_id ASC, ticket_batch_id ASC, id ASC'));

  // 8. Table-level privileges revoke direct writes on events and ticket_batches (writes must use admin_* RPCs)
  assert.ok(sql.includes('REVOKE INSERT, UPDATE, DELETE ON public.events FROM PUBLIC, anon, authenticated;'));
  assert.ok(sql.includes('REVOKE INSERT, UPDATE, DELETE ON public.ticket_batches FROM PUBLIC, anon, authenticated;'));
  assert.ok(sql.includes('IF NEW.id IS DISTINCT FROM OLD.id THEN'));
  assert.ok(sql.includes('IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN'));
});

test('assemblePublishedEventsCatalog filters only published events, sorts by event_date ASC, maps active categories/batches, and normalizes category_slug', async () => {
  const {
    assemblePublishedEventsCatalog,
    computeCategoriesWithEventCounts,
    INITIAL_CATEGORIES,
  } = await import('../services/platformService');

  const catalog = assemblePublishedEventsCatalog(
    [
      {
        id: 'evt-draft-1',
        slug: 'evento-rascunho',
        title: 'Evento em Rascunho',
        subtitle: null,
        category_slug: 'encontros-de-carros',
        category_name: 'Encontros de Carros',
        event_date: '2026-04-10',
        time_range: '10:00 às 20:00',
        city: 'Curitiba - PR',
        venue_name: 'Autódromo',
        starting_price: '60.00',
        banner_url: '/assets/events/ev-tuningshow.jpg',
        card_image_url: '/assets/events/ev-tuningshow.jpg',
        gallery_urls: [],
        description: 'Não deve aparecer no catálogo público.',
        highlights: [],
        status: 'draft',
        featured: false,
        capacity: 1000,
        tickets_sold: 0,
        created_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'evt-pub-later',
        slug: 'speed-drift-interlagos',
        title: 'Speed & Drift Interlagos',
        subtitle: 'Edição Oficial',
        category_slug: 'eventos-de-performance',
        category_name: 'Eventos de Performance',
        event_date: '2026-06-29',
        time_range: '09:00 às 20:00',
        city: 'São Paulo - SP',
        venue_name: 'Autódromo de Interlagos',
        starting_price: '0.00',
        banner_url: '/assets/events/ev-speeddrift.jpg',
        card_image_url: '/assets/events/ev-speeddrift.jpg',
        gallery_urls: [],
        description: 'Baterias oficiais de Drift.',
        highlights: ['Drift Oficial'],
        status: 'published',
        featured: true,
        capacity: 2000,
        tickets_sold: 450,
        created_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'evt-pub-sooner',
        slug: 'encontro-nacional-rebaixados',
        title: 'Encontro Nacional de Carros Rebaixados',
        subtitle: 'Edição Oficial PX CUSTON',
        category_slug: 'encontros-de-carros',
        category_name: 'Encontros de Carros',
        event_date: '2026-04-25',
        time_range: '10:00 às 22:00',
        city: 'São Paulo - SP',
        venue_name: 'Arena Anhembi',
        starting_price: '40.00',
        banner_url: '/assets/events/event-gol-quadrado.jpg',
        card_image_url: '/assets/events/ev-rebaixados.jpg',
        gallery_urls: ['/assets/events/gallery-1.jpg'],
        description: 'O maior encontro de carros rebaixados.',
        highlights: ['+5.000 visitantes'],
        status: 'published',
        featured: true,
        capacity: 2500,
        tickets_sold: 1200,
        created_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
    [
      {
        id: 'cat-pista',
        event_id: 'evt-pub-sooner',
        name: 'Pista',
        slug: 'pista',
        description: 'Acesso geral',
        max_per_order: 6,
        sort_order: 1,
        active: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'cat-drift',
        event_id: 'evt-pub-later',
        name: 'Arquibancada',
        slug: 'arquibancada',
        description: 'Acesso arquibancada',
        max_per_order: 8,
        sort_order: 1,
        active: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
    [
      {
        id: 'batch-pista-1',
        event_id: 'evt-pub-sooner',
        category_id: 'cat-pista',
        name: 'Pista (1º Lote)',
        batch_number: 1,
        description: 'Acesso geral ao evento',
        price: '40.00',
        total_quantity: 1000,
        reserved_quantity: 50,
        sold_quantity: 200,
        thumbnail_url: null,
        starts_at: null,
        ends_at: null,
        active: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'batch-drift-inactive',
        event_id: 'evt-pub-later',
        category_id: 'cat-drift',
        name: 'Lote Encerrado',
        batch_number: 1,
        description: 'Inativo',
        price: '50.00',
        total_quantity: 500,
        reserved_quantity: 0,
        sold_quantity: 500,
        thumbnail_url: null,
        starts_at: null,
        ends_at: null,
        active: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'batch-drift-active',
        event_id: 'evt-pub-later',
        category_id: 'cat-drift',
        name: 'Arquibancada (2º Lote)',
        batch_number: 2,
        description: 'Ativo',
        price: '75.00',
        total_quantity: 800,
        reserved_quantity: 10,
        sold_quantity: 90,
        thumbnail_url: null,
        starts_at: null,
        ends_at: null,
        active: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]
  );

  // Only the 2 published events are included, ordered by event_date ascending
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].id, 'evt-pub-sooner');
  assert.equal(catalog[0].categoryId, 'cat-carros');
  assert.equal(catalog[0].dateFormatted, '25/04/2026');
  assert.equal(catalog[0].lots.length, 1);
  assert.equal(catalog[0].lots[0].availableQuantity, 750);
  assert.equal(catalog[0].lots[0].maxPerOrder, 6);

  // Second event derives startingPrice from its active batch (75.00) when starting_price is 0.00
  assert.equal(catalog[1].id, 'evt-pub-later');
  assert.equal(catalog[1].categoryId, 'cat-performance');
  assert.equal(catalog[1].lots.length, 1);
  assert.equal(catalog[1].startingPrice, 75);
  assert.equal(catalog[1].galleryUrls.length, 2);

  // Category event counts reflect the real published events
  const updatedCategories = computeCategoriesWithEventCounts(INITIAL_CATEGORIES, catalog);
  const carrosCat = updatedCategories.find((c) => c.id === 'cat-carros');
  const perfCat = updatedCategories.find((c) => c.id === 'cat-performance');
  const motosCat = updatedCategories.find((c) => c.id === 'cat-motos');
  assert.equal(carrosCat?.eventCount, 1);
  assert.equal(perfCat?.eventCount, 1);
  assert.equal(motosCat?.eventCount, 0);
});

test('buildSafeSignUpMetadata validates customer signup data and never exposes or allows role escalation in user_metadata', () => {
  const validSignup = buildSafeSignUpMetadata({
    fullName: 'Lucas Almeida',
    cpf: '123.456.789-01',
    email: 'Lucas.Almeida@Email.com ',
    phone: '(11) 99876-5432',
    city: 'São Paulo - SP',
    password: 'strongPassword123',
  });

  assert.equal(validSignup.ok, true);
  if (validSignup.ok) {
    assert.equal(validSignup.sanitizedEmail, 'lucas.almeida@email.com');
    assert.deepEqual(validSignup.metadata, {
      full_name: 'Lucas Almeida',
      cpf: '12345678901',
      phone: '(11) 99876-5432',
      city: 'São Paulo - SP',
    });
    // Ensure role is never present in public signup metadata
    assert.equal('role' in validSignup.metadata, false);
  }

  const weakPassword = buildSafeSignUpMetadata({
    fullName: 'Lucas Almeida',
    cpf: '123.456.789-01',
    email: 'lucas@email.com',
    phone: '(11) 99876-5432',
    password: '123',
  });
  assert.equal(weakPassword.ok, false);
});

test('evaluateAdminAccess enforces strict authorization for disconnected user, common customer, missing profile, and authorized admin/SUPER_ADMIN', () => {
  // 1. Disconnected user (visitor) -> denied
  const disconnected = evaluateAdminAccess({
    authenticatedUserId: null,
    profile: null,
  });
  assert.equal(disconnected.allowed, false);
  assert.equal(disconnected.reasonCode, 'unauthenticated');
  assert.equal(disconnected.userRole, 'visitor');

  // 2. Authenticated user whose profile in public.profiles could not be loaded (error) -> denied
  const profileErr = evaluateAdminAccess({
    authenticatedUserId: 'usr-100',
    profile: null,
    profileError: 'Erro de permissão RLS na tabela profiles',
  });
  assert.equal(profileErr.allowed, false);
  assert.equal(profileErr.reasonCode, 'profile_error');

  // 3. Authenticated user without row in public.profiles -> denied
  const missingProfile = evaluateAdminAccess({
    authenticatedUserId: 'usr-100',
    profile: null,
  });
  assert.equal(missingProfile.allowed, false);
  assert.equal(missingProfile.reasonCode, 'profile_missing');

  // 4. Common customer user (role = 'customer') -> denied
  const customerProfile = mapDbProfileRowToProfile({
    id: 'usr-customer-1',
    full_name: 'Cliente Comum',
    cpf: '123.456.789-00',
    email: 'cliente@pxcuston.com.br',
    phone: '(11) 98888-7777',
    city: 'Campinas - SP',
    role: 'customer',
    created_at: '2026-04-01T10:00:00Z',
    updated_at: '2026-04-01T10:00:00Z',
  });
  const customerAccess = evaluateAdminAccess({
    authenticatedUserId: 'usr-customer-1',
    profile: customerProfile,
  });
  assert.equal(customerAccess.allowed, false);
  assert.equal(customerAccess.reasonCode, 'insufficient_role');
  assert.equal(customerAccess.userRole, 'customer');

  // 5. Check-in operator (role = 'checkin_operator') -> denied full admin panel
  const operatorProfile = mapDbProfileRowToProfile({
    id: 'usr-op-1',
    full_name: 'Operador Portaria',
    cpf: '222.333.444-55',
    email: 'portaria@pxcuston.com.br',
    phone: '(11) 97777-6666',
    city: 'São Paulo - SP',
    role: 'checkin_operator',
    created_at: '2026-04-01T10:00:00Z',
    updated_at: '2026-04-01T10:00:00Z',
  });
  const operatorAccess = evaluateAdminAccess({
    authenticatedUserId: 'usr-op-1',
    profile: operatorProfile,
  });
  assert.equal(operatorAccess.allowed, false);
  assert.equal(operatorAccess.reasonCode, 'insufficient_role');
  assert.equal(operatorAccess.userRole, 'checkin_operator');

  // 6. Mismatched profile ID vs authenticated session ID -> denied
  const adminProfile = mapDbProfileRowToProfile({
    id: 'usr-admin-1',
    full_name: 'Admin PX',
    cpf: '333.444.555-66',
    email: 'admin@pxcuston.com.br',
    phone: '(11) 96666-5555',
    city: 'São Paulo - SP',
    role: 'admin',
    created_at: '2026-04-01T10:00:00Z',
    updated_at: '2026-04-01T10:00:00Z',
  });
  const mismatchAccess = evaluateAdminAccess({
    authenticatedUserId: 'usr-different-id',
    profile: adminProfile,
  });
  assert.equal(mismatchAccess.allowed, false);
  assert.equal(mismatchAccess.reasonCode, 'profile_id_mismatch');

  // 7. Server RPC explicitly rejects admin role (serverAdminConfirmed = false) -> denied even if client object has 'admin'
  const rpcRejected = evaluateAdminAccess({
    authenticatedUserId: 'usr-admin-1',
    profile: adminProfile,
    serverAdminConfirmed: false,
  });
  assert.equal(rpcRejected.allowed, false);
  assert.equal(rpcRejected.reasonCode, 'insufficient_role');

  // 8. Authorized administrator ('admin' and 'SUPER_ADMIN') with matching session and server confirmation -> allowed
  const validAdmin = evaluateAdminAccess({
    authenticatedUserId: 'usr-admin-1',
    profile: adminProfile,
    serverAdminConfirmed: true,
  });
  assert.equal(validAdmin.allowed, true);
  assert.equal(validAdmin.reasonCode, 'authorized_admin');
  assert.equal(validAdmin.userRole, 'admin');

  const superAdminProfile = mapDbProfileRowToProfile({
    id: 'usr-super-1',
    full_name: 'Super Admin PX',
    cpf: '444.555.666-77',
    email: 'super@pxcuston.com.br',
    phone: '(11) 95555-4444',
    city: 'São Paulo - SP',
    role: 'SUPER_ADMIN',
    created_at: '2026-04-01T10:00:00Z',
    updated_at: '2026-04-01T10:00:00Z',
  });
  const validSuperAdmin = evaluateAdminAccess({
    authenticatedUserId: 'usr-super-1',
    profile: superAdminProfile,
    serverAdminConfirmed: true,
  });
  assert.equal(validSuperAdmin.allowed, true);
  assert.equal(validSuperAdmin.reasonCode, 'authorized_admin');
  assert.equal(validSuperAdmin.userRole, 'SUPER_ADMIN');
});

test('generateEventSlug normalizes accents, enforces lowercase kebab-case, and deduplicates against existing slugs', () => {
  assert.equal(
    generateEventSlug('Encontro Nacional de Carros Rebaixados — Edição São Paulo!'),
    'encontro-nacional-de-carros-rebaixados-edicao-sao-paulo'
  );

  // Deduplicates when slug already exists
  assert.equal(
    generateEventSlug('Moto Fest Brasil', ['moto-fest-brasil']),
    'moto-fest-brasil-2'
  );
  assert.equal(
    generateEventSlug('Moto Fest Brasil', ['moto-fest-brasil', 'moto-fest-brasil-2']),
    'moto-fest-brasil-3'
  );
});

test('parseEventDateToIso converts DD/MM/YYYY and YYYY-MM-DD to valid PostgreSQL DATE and rejects impossible dates', () => {
  const validBr = parseEventDateToIso('25/04/2026');
  assert.equal(validBr.ok, true);
  if (validBr.ok) {
    assert.equal(validBr.isoDate, '2026-04-25');
    assert.equal(validBr.dateFormatted, '25/04/2026');
  }

  const validIso = parseEventDateToIso('2026-06-29');
  assert.equal(validIso.ok, true);
  if (validIso.ok) {
    assert.equal(validIso.isoDate, '2026-06-29');
    assert.equal(validIso.dateFormatted, '29/06/2026');
  }

  assert.equal(formatIsoDateToBr('2026-04-25'), '25/04/2026');

  // Leap year 2028 is valid, non-leap 2026 is rejected
  assert.equal(parseEventDateToIso('29/02/2028').ok, true);
  assert.equal(parseEventDateToIso('29/02/2026').ok, false);
  assert.equal(parseEventDateToIso('31/04/2026').ok, false);
  assert.equal(parseEventDateToIso('2026/04/25').ok, false);
});

test('validateAndBuildEventWritePayload validates required fields, maps status and category, and enforces capacity >= ticketsSold', async () => {
  const { INITIAL_CATEGORIES } = await import('../services/platformService');

  const validDraft = validateAndBuildEventWritePayload(
    {
      title: 'Encontro Noturno PX CUSTON',
      subtitle: 'Edição Interlagos',
      slug: '',
      categoryId: 'cat-carros',
      dateInput: '15/08/2026',
      timeRange: '18:00 às 23:59',
      city: 'São Paulo - SP',
      venueName: 'Autódromo de Interlagos',
      startingPrice: '55.50',
      capacity: '1800',
      bannerUrl: '/assets/events/hero-banner-full.jpg',
      cardImageUrl: '/assets/events/ev-rebaixados.jpg',
      description: 'Encontro oficial noturno com exposição de projetos selecionados e área VIP.',
      highlights: 'Expositores oficiais\nPraça de alimentação, Estacionamento seguro',
      status: 'Rascunho',
      featured: true,
    },
    {
      existingEvents: [{ id: 'evt-other', slug: 'encontro-noturno-px-custon' }],
      categories: INITIAL_CATEGORIES,
    }
  );

  assert.equal(validDraft.ok, true);
  if (validDraft.ok) {
    assert.equal(validDraft.payload.slug, 'encontro-noturno-px-custon-2');
    assert.equal(validDraft.payload.category_slug, 'encontros-de-carros');
    assert.equal(validDraft.payload.category_name, 'Encontros de Carros');
    assert.equal(validDraft.payload.event_date, '2026-08-15');
    assert.equal(validDraft.payload.starting_price, 55.5);
    assert.equal(validDraft.payload.capacity, 1800);
    assert.equal(validDraft.payload.status, 'draft');
    assert.equal(validDraft.payload.featured, true);
    assert.deepEqual(validDraft.payload.highlights, [
      'Expositores oficiais',
      'Praça de alimentação',
      'Estacionamento seguro',
    ]);
  }

  // Editing an existing event preserves its own slug and checks capacity >= ticketsSold
  const invalidCapacityUpdate = validateAndBuildEventWritePayload(
    {
      id: 'evt-existing',
      title: 'Encontro Noturno PX CUSTON',
      slug: 'encontro-noturno-px-custon',
      categoryId: 'cat-carros',
      dateInput: '15/08/2026',
      timeRange: '18:00 às 23:59',
      city: 'São Paulo - SP',
      venueName: 'Autódromo de Interlagos',
      startingPrice: 50,
      capacity: 100,
      ticketsSold: 250,
      bannerUrl: '/assets/events/hero-banner-full.jpg',
      cardImageUrl: '/assets/events/ev-rebaixados.jpg',
      description: 'Encontro oficial noturno com exposição de projetos selecionados.',
      status: 'Publicado',
    },
    {
      existingEvents: [{ id: 'evt-existing', slug: 'encontro-noturno-px-custon' }],
      categories: INITIAL_CATEGORIES,
    }
  );
  assert.equal(invalidCapacityUpdate.ok, false);
  if (!invalidCapacityUpdate.ok) {
    assert.ok(invalidCapacityUpdate.fieldErrors.capacity);
  }

  // Status mapping helpers (all 4 PostgreSQL CHECK values: draft, published, ended, cancelled)
  assert.equal(mapUiEventStatusToDb('Publicado'), 'published');
  assert.equal(mapUiEventStatusToDb('Rascunho'), 'draft');
  assert.equal(mapUiEventStatusToDb('Encerrado'), 'ended');
  assert.equal(mapUiEventStatusToDb('Cancelado'), 'cancelled');
  assert.equal(mapDbEventStatusToUi('published'), 'Publicado');
  assert.equal(mapDbEventStatusToUi('draft'), 'Rascunho');
  assert.equal(mapDbEventStatusToUi('ended'), 'Encerrado');
  assert.equal(mapDbEventStatusToUi('cancelled'), 'Cancelado');

  // Editing an event with existing galleryUrls preserves the full gallery_urls array
  const preservedGalleryUpdate = validateAndBuildEventWritePayload(
    {
      id: 'evt-existing',
      title: 'Encontro Noturno PX CUSTON',
      slug: 'encontro-noturno-px-custon',
      categoryId: 'cat-carros',
      dateInput: '15/08/2026',
      timeRange: '18:00 às 23:59',
      city: 'São Paulo - SP',
      venueName: 'Autódromo de Interlagos',
      startingPrice: 50,
      capacity: 1500,
      ticketsSold: 250,
      bannerUrl: '/assets/events/hero-banner-full.jpg',
      cardImageUrl: '/assets/events/ev-rebaixados.jpg',
      galleryUrls: [
        '/assets/events/gallery-1.jpg',
        '/assets/events/gallery-2.jpg',
        '/assets/events/gallery-3.jpg',
      ],
      description: 'Encontro oficial noturno com exposição de projetos selecionados.',
      status: 'Cancelado',
    },
    {
      existingEvents: [{ id: 'evt-existing', slug: 'encontro-noturno-px-custon' }],
      categories: INITIAL_CATEGORIES,
    }
  );
  assert.equal(preservedGalleryUpdate.ok, true);
  if (preservedGalleryUpdate.ok) {
    assert.deepEqual(preservedGalleryUpdate.payload.gallery_urls, [
      '/assets/events/gallery-1.jpg',
      '/assets/events/gallery-2.jpg',
      '/assets/events/gallery-3.jpg',
    ]);
    assert.equal(preservedGalleryUpdate.payload.status, 'cancelled');
  }
});

test('assembleAdminEventsCatalog includes draft and published events with empty lots when no batches exist, and translateEventDatabaseError explains constraints clearly', async () => {
  const { assembleAdminEventsCatalog, assemblePublishedEventsCatalog } = await import(
    '../services/platformService'
  );

  const sampleRows = [
    {
      id: 'evt-draft-new',
      slug: 'novo-evento-rascunho',
      title: 'Novo Evento em Rascunho',
      subtitle: null,
      category_slug: 'encontros-de-carros',
      category_name: 'Encontros de Carros',
      event_date: '2026-09-12',
      time_range: '10:00 às 22:00',
      city: 'Campinas - SP',
      venue_name: 'Parque de Exposições',
      starting_price: '45.00',
      banner_url: '/assets/events/hero-banner-full.jpg',
      card_image_url: '/assets/events/ev-rebaixados.jpg',
      gallery_urls: [],
      description: 'Evento em preparação.',
      highlights: [],
      status: 'draft' as const,
      featured: false,
      capacity: 1200,
      tickets_sold: 0,
      created_by: 'usr-admin-1',
      created_at: '2026-04-01T10:00:00Z',
      updated_at: '2026-04-01T10:00:00Z',
    },
    {
      id: 'evt-published-1',
      slug: 'evento-publicado',
      title: 'Evento Publicado Oficial',
      subtitle: 'Edição 2026',
      category_slug: 'encontros-de-motos',
      category_name: 'Encontros de Motos',
      event_date: '2026-05-17',
      time_range: '09:00 às 21:00',
      city: 'São Paulo - SP',
      venue_name: 'Arena Anhembi',
      starting_price: '35.00',
      banner_url: '/assets/events/ev-motofest.jpg',
      card_image_url: '/assets/events/ev-motofest.jpg',
      gallery_urls: [],
      description: 'Encontro oficial de motos.',
      highlights: [],
      status: 'published' as const,
      featured: true,
      capacity: 3000,
      tickets_sold: 0,
      created_by: 'usr-admin-1',
      created_at: '2026-04-01T10:00:00Z',
      updated_at: '2026-04-01T10:00:00Z',
    },
  ];

  const adminCatalog = assembleAdminEventsCatalog(sampleRows, [], []);
  const publicCatalog = assemblePublishedEventsCatalog(sampleRows, [], []);

  assert.equal(adminCatalog.length, 2);
  assert.equal(publicCatalog.length, 1);
  assert.equal(adminCatalog[0].id, 'evt-published-1');
  assert.equal(adminCatalog[1].id, 'evt-draft-new');
  assert.equal(adminCatalog[1].status, 'Rascunho');
  assert.deepEqual(adminCatalog[1].lots, []);

  // Error translation for foreign key restriction on delete (23503) and RLS denial (42501)
  const fkDeleteMsg = translateEventDatabaseError(
    { code: '23503', message: 'update or delete on table "events" violates foreign key constraint "orders_event_id_fkey"' },
    'delete'
  );
  assert.ok(fkDeleteMsg.includes('pedidos ou ingressos vinculados'));

  const rlsMsg = translateEventDatabaseError(
    { code: '42501', message: 'new row violates row-level security policy for table "events"' },
    'create'
  );
  assert.ok(rlsMsg.includes('política RLS'));
});

test('admin event service functions reject unauthenticated callers before executing database mutations', async () => {
  const {
    fetchAdminEventsFromSupabase,
    createEventInSupabase,
    updateEventInSupabase,
    updateEventStatusInSupabase,
    deleteEventInSupabase,
  } = await import('../services/platformService');

  const fetchRes = await fetchAdminEventsFromSupabase();
  assert.equal(fetchRes.ok, false);

  const createRes = await createEventInSupabase({
    title: 'Evento Teste Não Autorizado',
    categoryId: 'cat-carros',
    dateInput: '25/10/2026',
    timeRange: '10:00 às 20:00',
    city: 'São Paulo - SP',
    venueName: 'Arena Anhembi',
    startingPrice: 40,
    capacity: 1000,
    bannerUrl: '/assets/events/hero-banner-full.jpg',
    cardImageUrl: '/assets/events/ev-rebaixados.jpg',
    description: 'Tentativa sem sessão autenticada.',
    status: 'Rascunho',
  });
  assert.equal(createRes.ok, false);

  const updateRes = await updateEventInSupabase('00000000-0000-0000-0000-000000000000', {
    title: 'Evento Teste Não Autorizado',
    categoryId: 'cat-carros',
    dateInput: '25/10/2026',
    timeRange: '10:00 às 20:00',
    city: 'São Paulo - SP',
    venueName: 'Arena Anhembi',
    startingPrice: 40,
    capacity: 1000,
    bannerUrl: '/assets/events/hero-banner-full.jpg',
    cardImageUrl: '/assets/events/ev-rebaixados.jpg',
    description: 'Tentativa sem sessão autenticada.',
    status: 'Rascunho',
  });
  assert.equal(updateRes.ok, false);

  const statusRes = await updateEventStatusInSupabase(
    '00000000-0000-0000-0000-000000000000',
    'Publicado'
  );
  assert.equal(statusRes.ok, false);

  const deleteRes = await deleteEventInSupabase('00000000-0000-0000-0000-000000000000');
  assert.equal(deleteRes.ok, false);
});

test('validateBatchStockAvailability enforces global event capacity across multiple batches (sold + reserved across all batches)', () => {
  // Event has capacity = 100, ticketsSold = 40, Batch A has 50 reserved, Batch B has 5 reserved (total reserved = 55, remaining global = 5)
  // Even though Batch B individually has 75 available (total 80, sold 0, reserved 5), global capacity only allows 5 more tickets!
  const allowedWithinGlobal = validateBatchStockAvailability({
    totalQuantity: 80,
    reservedQuantity: 5,
    soldQuantity: 0,
    requestedQuantity: 5,
    maxPerOrder: 10,
    isActive: true,
    eventCapacity: 100,
    eventTicketsSold: 40,
    eventTotalReservedAcrossBatches: 55,
    eventTotalSoldAcrossBatches: 40,
  });
  assert.equal(allowedWithinGlobal.canReserve, true);
  assert.equal(allowedWithinGlobal.availableQuantity, 0);

  const rejectedByGlobalCapacity = validateBatchStockAvailability({
    totalQuantity: 80,
    reservedQuantity: 5,
    soldQuantity: 0,
    requestedQuantity: 6,
    maxPerOrder: 10,
    isActive: true,
    eventCapacity: 100,
    eventTicketsSold: 40,
    eventTotalReservedAcrossBatches: 55,
    eventTotalSoldAcrossBatches: 40,
  });
  assert.equal(rejectedByGlobalCapacity.canReserve, false);
  assert.ok(rejectedByGlobalCapacity.reason?.includes('Capacidade total do evento insuficiente'));

  // Rejects explicitly when eventTicketsSold diverges from eventTotalSoldAcrossBatches (never masks with GREATEST)
  const divergentCounters = validateBatchStockAvailability({
    totalQuantity: 80,
    reservedQuantity: 5,
    soldQuantity: 0,
    requestedQuantity: 2,
    maxPerOrder: 10,
    isActive: true,
    eventCapacity: 100,
    eventTicketsSold: 38,
    eventTotalReservedAcrossBatches: 55,
    eventTotalSoldAcrossBatches: 40,
  });
  assert.equal(divergentCounters.canReserve, false);
  assert.ok(divergentCounters.reason?.includes('Inconsistência de integridade de estoque'));
});

test('issueTicketsWithCollisionRetry retries ONLY on whitelisted constraints (tickets_code_key, tickets_qr_payload_key) and aborts immediately on any other unique violation', () => {
  assert.deepEqual(Array.from(RECOVERABLE_TICKET_UNIQUE_CONSTRAINTS).sort(), [
    'tickets_code_key',
    'tickets_qr_payload_key',
  ]);

  const existingCodes = new Set(['PX-COLLIDE1', 'PX-COLLIDE2']);

  // 1. Succeeds when first 2 attempts for item 1 collide with existingCodes and 3rd attempt is unique
  const recoveredCollision = issueTicketsWithCollisionRetry({
    orderId: 'ord-100',
    orderCode: '#PX-100',
    eventId: 'evt-1',
    quantity: 2,
    existingTicketCodes: existingCodes,
    codeGenerator: (itemSeq, attempt) => {
      if (itemSeq === 1 && attempt === 1) return 'PX-COLLIDE1';
      if (itemSeq === 1 && attempt === 2) return 'PX-COLLIDE2';
      return `PX-UNIQUE0${itemSeq}`;
    },
  });
  assert.equal(recoveredCollision.ok, true);
  if (recoveredCollision.ok) {
    assert.equal(recoveredCollision.tickets.length, 2);
    assert.equal(recoveredCollision.tickets[0].code, 'PX-UNIQUE01');
    assert.equal(recoveredCollision.tickets[1].code, 'PX-UNIQUE02');
    assert.equal(recoveredCollision.totalAttemptsUsed, 4);
  }

  // 2. Retries when collision occurs on tickets_qr_payload_key
  const recoveredPayloadCollision = issueTicketsWithCollisionRetry({
    orderId: 'ord-100',
    orderCode: '#PX-100',
    eventId: 'evt-1',
    quantity: 1,
    existingTicketCodes: new Set(),
    existingQrPayloads: new Set(['PXCUSTON|PX-QRCOLLID|EVT-1|1']),
    codeGenerator: (_itemSeq, attempt) => (attempt === 1 ? 'PX-QRCOLLID' : 'PX-QROK0001'),
  });
  assert.equal(recoveredPayloadCollision.ok, true);
  if (recoveredPayloadCollision.ok) {
    assert.equal(recoveredPayloadCollision.totalAttemptsUsed, 2);
    assert.equal(recoveredPayloadCollision.tickets[0].code, 'PX-QROK0001');
  }

  // 3. Immediately aborts without retrying if (order_id, item_sequence) already exists
  let attemptsOnSequenceViolation = 0;
  const sequenceViolation = issueTicketsWithCollisionRetry({
    orderId: 'ord-100',
    orderCode: '#PX-100',
    eventId: 'evt-1',
    quantity: 2,
    existingTicketCodes: new Set(),
    existingOrderSequences: new Set(['ord-100:1']),
    codeGenerator: (itemSeq, attempt) => {
      attemptsOnSequenceViolation += 1;
      return `PX-SEQ${itemSeq}${attempt}`;
    },
  });
  assert.equal(sequenceViolation.ok, false);
  assert.equal(attemptsOnSequenceViolation, 1);
  if (!sequenceViolation.ok) {
    assert.equal(sequenceViolation.constraintFailure, 'uq_tickets_order_item_sequence');
  }

  // 4. Immediately aborts on any other non-whitelisted unique constraint (e.g. tickets_pkey) without retrying
  let attemptsOnPkeyViolation = 0;
  const pkeyViolation = issueTicketsWithCollisionRetry({
    orderId: 'ord-100',
    orderCode: '#PX-100',
    eventId: 'evt-1',
    quantity: 2,
    existingTicketCodes: new Set(),
    simulatedOtherUniqueViolationConstraint: 'tickets_pkey',
    codeGenerator: () => {
      attemptsOnPkeyViolation += 1;
      return 'PX-ANYCODE1';
    },
  });
  assert.equal(pkeyViolation.ok, false);
  assert.equal(attemptsOnPkeyViolation, 1);
  if (!pkeyViolation.ok) {
    assert.equal(pkeyViolation.constraintFailure, 'unrecoverable_unique_violation');
    assert.equal(pkeyViolation.violatedConstraintName, 'tickets_pkey');
  }

  // 5. Aborts cleanly with controlled error if all maxCodeAttempts collide
  const exhausted = issueTicketsWithCollisionRetry({
    orderId: 'ord-200',
    orderCode: '#PX-200',
    eventId: 'evt-1',
    quantity: 2,
    existingTicketCodes: new Set(['PX-ALWAYS-SAME']),
    maxCodeAttempts: 5,
    codeGenerator: () => 'PX-ALWAYS-SAME',
  });
  assert.equal(exhausted.ok, false);
  if (!exhausted.ok) {
    assert.equal(exhausted.constraintFailure, 'tickets_code_key_exhausted');
    assert.ok(exhausted.errorMessage.includes('após 5 tentativas'));
  }
});

test('evaluateReleaseExpiredReservationsAccess allows service_role, authenticated admin, and direct DB admin session while rejecting anon and common users', () => {
  // 1. Backend service_role -> allowed
  const serviceRole = evaluateReleaseExpiredReservationsAccess({
    jwtRole: 'service_role',
    authUid: null,
    isAdminOrSuperAdmin: false,
    sessionUser: 'authenticator',
  });
  assert.equal(serviceRole.allowed, true);
  assert.equal(serviceRole.authorizedBy, 'service_role');

  // 2. Authenticated admin -> allowed
  const authAdmin = evaluateReleaseExpiredReservationsAccess({
    jwtRole: 'authenticated',
    authUid: 'admin-uuid-1',
    isAdminOrSuperAdmin: true,
    sessionUser: 'authenticator',
  });
  assert.equal(authAdmin.allowed, true);
  assert.equal(authAdmin.authorizedBy, 'authenticated_admin');

  // 3. Direct DB admin session in SQL Editor (jwtRole = '', authUid = null, sessionUser = 'postgres' or 'supabase_admin') -> allowed
  const sqlEditorPostgres = evaluateReleaseExpiredReservationsAccess({
    jwtRole: '',
    authUid: null,
    isAdminOrSuperAdmin: false,
    sessionUser: 'postgres',
  });
  assert.equal(sqlEditorPostgres.allowed, true);
  assert.equal(sqlEditorPostgres.authorizedBy, 'direct_db_admin');

  const sqlEditorSupabaseAdmin = evaluateReleaseExpiredReservationsAccess({
    jwtRole: null,
    authUid: null,
    isAdminOrSuperAdmin: false,
    sessionUser: 'supabase_admin',
  });
  assert.equal(sqlEditorSupabaseAdmin.allowed, true);
  assert.equal(sqlEditorSupabaseAdmin.authorizedBy, 'direct_db_admin');

  // 4. Anonymous caller -> denied
  const anonCaller = evaluateReleaseExpiredReservationsAccess({
    jwtRole: 'anon',
    authUid: null,
    isAdminOrSuperAdmin: false,
    sessionUser: 'authenticator',
  });
  assert.equal(anonCaller.allowed, false);

  // 5. Common authenticated customer -> denied
  const customerCaller = evaluateReleaseExpiredReservationsAccess({
    jwtRole: 'authenticated',
    authUid: 'customer-uuid-1',
    isAdminOrSuperAdmin: false,
    sessionUser: 'authenticator',
  });
  assert.equal(customerCaller.allowed, false);

  // 6. PostgREST request with non-empty jwtRole or authUid even if sessionUser were postgres -> denied unless admin
  const spoofedPostgrest = evaluateReleaseExpiredReservationsAccess({
    jwtRole: 'authenticated',
    authUid: 'customer-uuid-1',
    isAdminOrSuperAdmin: false,
    sessionUser: 'postgres',
  });
  assert.equal(spoofedPostgrest.allowed, false);
});

test('evaluateBatchAllocationIntegrity enforces immutable event_id, active + inactive batch allocation bounds, order counter reconciliation, and safe deactivation', () => {
  // 1. Blocks changing event_id on UPDATE
  const changedEventId = evaluateBatchAllocationIntegrity({
    operation: 'UPDATE',
    eventCapacity: 500,
    eventTicketsSold: 0,
    oldBatch: {
      id: 'b-1',
      eventId: 'evt-1',
      totalQuantity: 100,
      reservedQuantity: 0,
      soldQuantity: 0,
      active: true,
    },
    newBatch: {
      id: 'b-1',
      eventId: 'evt-2',
      totalQuantity: 100,
      reservedQuantity: 0,
      soldQuantity: 0,
      active: true,
    },
    otherBatchesOfEvent: [],
  });
  assert.equal(changedEventId.allowed, false);
  assert.ok(changedEventId.errorMessage?.includes('event_id'));

  // 2. Blocks sum of active batches + committed in inactive batches from exceeding eventCapacity
  // Event capacity = 500; Inactive batch has 100 sold + 20 reserved (= 120 committed); Active batch 1 has totalQuantity = 250.
  // Creating Active batch 2 with totalQuantity = 150 -> totalAllocated = 120 + 250 + 150 = 520 > 500 -> rejected!
  const exceedsAllocated = evaluateBatchAllocationIntegrity({
    operation: 'INSERT',
    eventCapacity: 500,
    eventTicketsSold: 100,
    newBatch: {
      id: 'b-new',
      eventId: 'evt-1',
      totalQuantity: 150,
      reservedQuantity: 0,
      soldQuantity: 0,
      active: true,
    },
    otherBatchesOfEvent: [
      { id: 'b-inactive', totalQuantity: 300, reservedQuantity: 20, soldQuantity: 100, active: false },
      { id: 'b-active-1', totalQuantity: 250, reservedQuantity: 0, soldQuantity: 0, active: true },
    ],
  });
  assert.equal(exceedsAllocated.allowed, false);
  assert.ok(exceedsAllocated.errorMessage?.includes('soma da quantidade ofertada nos lotes ativos'));

  // 3. Allows creating Active batch 2 with totalQuantity = 130 (120 + 250 + 130 = 500 <= 500)
  const validAllocated = evaluateBatchAllocationIntegrity({
    operation: 'INSERT',
    eventCapacity: 500,
    eventTicketsSold: 100,
    newBatch: {
      id: 'b-new',
      eventId: 'evt-1',
      totalQuantity: 130,
      reservedQuantity: 0,
      soldQuantity: 0,
      active: true,
    },
    otherBatchesOfEvent: [
      { id: 'b-inactive', totalQuantity: 300, reservedQuantity: 20, soldQuantity: 100, active: false },
      { id: 'b-active-1', totalQuantity: 250, reservedQuantity: 0, soldQuantity: 0, active: true },
    ],
  });
  assert.equal(validAllocated.allowed, true);
  assert.equal(validAllocated.totalAllocated, 500);

  // 4. Rejects direct tampering of sold_quantity or reserved_quantity when not reconciled with public.orders
  const tamperedCounters = evaluateBatchAllocationIntegrity({
    operation: 'UPDATE',
    eventCapacity: 500,
    eventTicketsSold: 100,
    oldBatch: {
      id: 'b-active-1',
      eventId: 'evt-1',
      totalQuantity: 250,
      reservedQuantity: 0,
      soldQuantity: 0,
      active: true,
    },
    newBatch: {
      id: 'b-active-1',
      eventId: 'evt-1',
      totalQuantity: 250,
      reservedQuantity: 0,
      soldQuantity: 50,
      active: true,
    },
    otherBatchesOfEvent: [],
    ordersReservedForBatch: 0,
    ordersSoldForBatch: 0,
  });
  assert.equal(tamperedCounters.allowed, false);
  assert.ok(tamperedCounters.errorMessage?.includes('divergem dos pedidos registrados em public.orders'));

  // 5. Blocks deleting a batch that already has sold or reserved tickets
  const deleteWithSold = evaluateBatchAllocationIntegrity({
    operation: 'DELETE',
    eventCapacity: 500,
    eventTicketsSold: 10,
    oldBatch: {
      id: 'b-1',
      eventId: 'evt-1',
      totalQuantity: 100,
      reservedQuantity: 0,
      soldQuantity: 10,
      active: false,
    },
    otherBatchesOfEvent: [],
  });
  assert.equal(deleteWithSold.allowed, false);
  assert.ok(deleteWithSold.errorMessage?.includes('Não é permitido excluir um lote'));
});

test('evaluateProfileUpdateIntegrity protects immutable id and created_at fields and blocks unauthorized role escalation', () => {
  const baseOld = {
    id: 'usr-1',
    createdAt: '2026-01-01T00:00:00Z',
    role: 'customer' as const,
  };

  // 1. Blocks changing profile id even for service_role
  assert.equal(
    evaluateProfileUpdateIntegrity({
      oldProfile: baseOld,
      newProfile: { ...baseOld, id: 'usr-2' },
      jwtRole: 'service_role',
      authUid: null,
      isAdminOrSuperAdmin: true,
      sessionUser: 'postgres',
    }).allowed,
    false
  );

  // 2. Blocks changing created_at
  assert.equal(
    evaluateProfileUpdateIntegrity({
      oldProfile: baseOld,
      newProfile: { ...baseOld, createdAt: '2026-05-01T00:00:00Z' },
      jwtRole: 'service_role',
      authUid: null,
      isAdminOrSuperAdmin: true,
      sessionUser: 'postgres',
    }).allowed,
    false
  );

  // 3. Blocks customer from escalating own role to admin
  assert.equal(
    evaluateProfileUpdateIntegrity({
      oldProfile: baseOld,
      newProfile: { ...baseOld, role: 'admin' },
      jwtRole: 'authenticated',
      authUid: 'usr-1',
      isAdminOrSuperAdmin: false,
      sessionUser: 'authenticator',
    }).allowed,
    false
  );

  // 4. Allows authenticated admin to promote a profile role when id and created_at are unchanged
  assert.equal(
    evaluateProfileUpdateIntegrity({
      oldProfile: baseOld,
      newProfile: { ...baseOld, role: 'admin' },
      jwtRole: 'authenticated',
      authUid: 'admin-1',
      isAdminOrSuperAdmin: true,
      sessionUser: 'authenticator',
    }).allowed,
    true
  );
});

test('evaluateBatchAllocationIntegrity and evaluateEventCapacityUpdateIntegrity allow payment confirmation, expiration, and admin remediation under historical over-offer while blocking new or expanded invalid offers', () => {
  // Scenario: Event capacity = 500, but 2 active batches historically had totalQuantity = 300 each (totalAllocated = 600 > 500).
  // Physical committed stock is 100 sold + 10 reserved = 110 <= 500.
  const otherBatch = [
    { id: 'b-2', totalQuantity: 300, reservedQuantity: 0, soldQuantity: 100, active: true },
  ];

  // 1. Payment confirmation converts 10 reserved -> 10 sold on b-1 (totalCommitted stays 110 <= 500) -> MUST succeed
  const confirmUnderHistoricalOverOffer = evaluateBatchAllocationIntegrity({
    operation: 'UPDATE',
    eventCapacity: 500,
    eventTicketsSold: 100,
    oldBatch: {
      id: 'b-1',
      eventId: 'evt-1',
      totalQuantity: 300,
      reservedQuantity: 10,
      soldQuantity: 0,
      active: true,
    },
    newBatch: {
      id: 'b-1',
      eventId: 'evt-1',
      totalQuantity: 300,
      reservedQuantity: 0,
      soldQuantity: 10,
      active: true,
    },
    otherBatchesOfEvent: otherBatch,
    ordersReservedForBatch: 0,
    ordersSoldForBatch: 10,
  });
  assert.equal(confirmUnderHistoricalOverOffer.allowed, true);

  // 2. Expiring reservation reduces reservedQuantity 10 -> 0 on b-1 -> MUST succeed
  const expireUnderHistoricalOverOffer = evaluateBatchAllocationIntegrity({
    operation: 'UPDATE',
    eventCapacity: 500,
    eventTicketsSold: 100,
    oldBatch: {
      id: 'b-1',
      eventId: 'evt-1',
      totalQuantity: 300,
      reservedQuantity: 10,
      soldQuantity: 0,
      active: true,
    },
    newBatch: {
      id: 'b-1',
      eventId: 'evt-1',
      totalQuantity: 300,
      reservedQuantity: 0,
      soldQuantity: 0,
      active: true,
    },
    otherBatchesOfEvent: otherBatch,
    ordersReservedForBatch: 0,
    ordersSoldForBatch: 0,
  });
  assert.equal(expireUnderHistoricalOverOffer.allowed, true);

  // 3. Admin reducing totalQuantity on b-1 (e.g. 300 -> 250) to remediate over-offer -> MUST succeed
  const adminRemediationReduction = evaluateBatchAllocationIntegrity({
    operation: 'UPDATE',
    eventCapacity: 500,
    eventTicketsSold: 100,
    oldBatch: {
      id: 'b-1',
      eventId: 'evt-1',
      totalQuantity: 300,
      reservedQuantity: 10,
      soldQuantity: 0,
      active: true,
    },
    newBatch: {
      id: 'b-1',
      eventId: 'evt-1',
      totalQuantity: 250,
      reservedQuantity: 10,
      soldQuantity: 0,
      active: true,
    },
    otherBatchesOfEvent: otherBatch,
    ordersReservedForBatch: 10,
    ordersSoldForBatch: 0,
  });
  assert.equal(adminRemediationReduction.allowed, true);

  // 4. Admin increasing totalQuantity or editing price without fixing over-offer while totalAllocated > 500 -> BLOCKED
  const adminInvalidExpansion = evaluateBatchAllocationIntegrity({
    operation: 'UPDATE',
    eventCapacity: 500,
    eventTicketsSold: 100,
    oldBatch: {
      id: 'b-1',
      eventId: 'evt-1',
      totalQuantity: 300,
      reservedQuantity: 10,
      soldQuantity: 0,
      active: true,
    },
    newBatch: {
      id: 'b-1',
      eventId: 'evt-1',
      totalQuantity: 320,
      reservedQuantity: 10,
      soldQuantity: 0,
      active: true,
    },
    otherBatchesOfEvent: otherBatch,
    ordersReservedForBatch: 10,
    ordersSoldForBatch: 0,
  });
  assert.equal(adminInvalidExpansion.allowed, false);

  // 5. Event status/metadata update when capacity is unchanged (500 -> 500) and physical committed (110) <= 500 -> ALLOWED
  const eventStatusUpdate = evaluateEventCapacityUpdateIntegrity({
    operation: 'UPDATE',
    oldEvent: { capacity: 500, ticketsSold: 100 },
    newEvent: { capacity: 500, ticketsSold: 100 },
    batchesOfEvent: [
      { id: 'b-1', totalQuantity: 300, reservedQuantity: 10, soldQuantity: 0, active: true },
      { id: 'b-2', totalQuantity: 300, reservedQuantity: 0, soldQuantity: 100, active: true },
    ],
  });
  assert.equal(eventStatusUpdate.allowed, true);

  // 6. Reducing event capacity (500 -> 450) when totalAllocated (480) > 450 -> BLOCKED
  const invalidCapacityReduction = evaluateEventCapacityUpdateIntegrity({
    operation: 'UPDATE',
    oldEvent: { capacity: 500, ticketsSold: 100 },
    newEvent: { capacity: 450, ticketsSold: 100 },
    batchesOfEvent: [
      { id: 'b-1', totalQuantity: 240, reservedQuantity: 10, soldQuantity: 0, active: true },
      { id: 'b-2', totalQuantity: 240, reservedQuantity: 0, soldQuantity: 100, active: true },
    ],
  });
  assert.equal(invalidCapacityReduction.allowed, false);
  assert.ok(invalidCapacityReduction.errorMessage?.includes('oferta total configurada'));
});

test('auditDatabaseCountersIntegrity and evaluateOrderMutationIntegrity detect counter divergences and block direct order tampering', () => {
  // 1. Consistent database state passes pre-flight audit
  const validAudit = auditDatabaseCountersIntegrity({
    events: [{ id: 'evt-1', capacity: 500, ticketsSold: 2 }],
    batches: [
      { id: 'b-1', eventId: 'evt-1', totalQuantity: 100, reservedQuantity: 1, soldQuantity: 2 },
    ],
    orders: [
      {
        id: 'ord-paid',
        eventId: 'evt-1',
        ticketBatchId: 'b-1',
        quantity: 2,
        orderStatus: 'paid',
        paymentStatus: 'approved',
        mpPaymentId: 'mp-12345',
        ticketCount: 2,
      },
      {
        id: 'ord-res',
        eventId: 'evt-1',
        ticketBatchId: 'b-1',
        quantity: 1,
        orderStatus: 'pending_payment',
        paymentStatus: 'pending',
        mpPaymentId: null,
        ticketCount: 0,
      },
    ],
  });
  assert.equal(validAudit.valid, true);
  assert.equal(validAudit.divergences.length, 0);

  // 2. Divergent batch/event counters are reported with exact IDs and never auto-corrected
  const divergentAudit = auditDatabaseCountersIntegrity({
    events: [{ id: 'evt-1', capacity: 500, ticketsSold: 5 }],
    batches: [
      { id: 'b-1', eventId: 'evt-1', totalQuantity: 100, reservedQuantity: 0, soldQuantity: 2 },
    ],
    orders: [
      {
        id: 'ord-paid',
        eventId: 'evt-1',
        ticketBatchId: 'b-1',
        quantity: 2,
        orderStatus: 'paid',
        paymentStatus: 'approved',
        mpPaymentId: 'mp-12345',
        ticketCount: 2,
      },
    ],
  });
  assert.equal(divergentAudit.valid, false);
  assert.ok(divergentAudit.divergences.some((d) => d.includes('event_id=evt-1')));

  // 3. evaluateOrderMutationIntegrity blocks modifying quantity/eventId or reverting a paid order to cancelled
  const baseOrder = {
    id: 'ord-1',
    orderCode: '#PX-111111',
    userId: 'usr-1',
    eventId: 'evt-1',
    ticketBatchId: 'b-1',
    quantity: 2,
    unitPrice: 50,
    totalAmount: 100,
    orderStatus: 'paid',
    paymentStatus: 'approved',
    mpPaymentId: 'mp-999',
    createdAt: '2026-01-01T00:00:00Z',
  };

  assert.equal(
    evaluateOrderMutationIntegrity({
      operation: 'UPDATE',
      oldOrder: baseOrder,
      newOrder: { ...baseOrder, quantity: 1, totalAmount: 50 },
    }).allowed,
    false
  );

  assert.equal(
    evaluateOrderMutationIntegrity({
      operation: 'UPDATE',
      oldOrder: baseOrder,
      newOrder: { ...baseOrder, orderStatus: 'cancelled', paymentStatus: 'cancelled' },
    }).allowed,
    false
  );

  assert.equal(
    evaluateOrderMutationIntegrity({
      operation: 'DELETE',
      oldOrder: baseOrder,
      existingTicketCountForOrder: 2,
    }).allowed,
    false
  );
});

test('migration 002 SQL enforces unified lock hierarchy, pre-flight counter audits, deferred reconciliation triggers, and zero custom GUC variables', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/002_rpc_contracts_permissions_idempotency.sql'
  );
  const sql = fs.readFileSync(migrationPath, 'utf8');

  // 1. Zero custom GUC session variables (no app.px_* or set_config)
  assert.equal(sql.includes('set_config('), false);
  assert.equal(sql.includes('app.px_'), false);

  // 2. Drops orders_admin_update and revokes direct writes on orders and tickets
  assert.ok(sql.includes('DROP POLICY IF EXISTS orders_admin_update ON public.orders;'));
  assert.ok(
    sql.includes('REVOKE INSERT, UPDATE, DELETE ON public.orders FROM PUBLIC, anon, authenticated;')
  );
  assert.ok(
    sql.includes('REVOKE INSERT, UPDATE, DELETE ON public.tickets FROM PUBLIC, anon, authenticated;')
  );

  // 3. Event trigger covers BEFORE INSERT OR UPDATE OR DELETE ON public.events (protecting status updates & cascade deletes)
  assert.ok(
    sql.includes('BEFORE INSERT OR UPDATE OR DELETE ON public.events')
  );

  // 4. Deferred constraint triggers on public.orders and public.ticket_batches
  assert.ok(
    sql.includes('CREATE CONSTRAINT TRIGGER trg_orders_reconcile_counters_deferred')
  );
  assert.ok(
    sql.includes('CREATE CONSTRAINT TRIGGER trg_batches_reconcile_counters_deferred')
  );
  assert.ok(sql.includes('DEFERRABLE INITIALLY DEFERRED'));

  // 5. In confirm_order_payment, px_event_inventory lock is acquired BEFORE SELECT * INTO v_order ... FOR UPDATE
  const confirmStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.confirm_order_payment(');
  const confirmEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.release_expired_reservations()');
  const confirmBody = sql.slice(confirmStart, confirmEnd);
  const confirmAdvisoryIdx = confirmBody.indexOf("hashtext('px_event_inventory:'");
  const confirmOrderForUpdateIdx = confirmBody.indexOf('SELECT * INTO v_order\n  FROM public.orders\n  WHERE id = p_order_id\n  FOR UPDATE;');
  assert.ok(confirmAdvisoryIdx > 0 && confirmOrderForUpdateIdx > confirmAdvisoryIdx);

  // 6. In release_expired_reservations, px_event_inventory lock is acquired BEFORE SELECT * INTO v_locked_order ... FOR UPDATE SKIP LOCKED
  const releaseBody = sql.slice(
    confirmEnd,
    sql.indexOf('CREATE OR REPLACE FUNCTION public.cancel_ticket_order(')
  );
  const releaseAdvisoryIdx = releaseBody.indexOf("hashtext('px_event_inventory:'");
  const releaseOrderLockIdx = releaseBody.indexOf('SELECT * INTO v_locked_order\n    FROM public.orders\n    WHERE id = v_rec.id\n    FOR UPDATE SKIP LOCKED;');
  assert.ok(releaseAdvisoryIdx > 0 && releaseOrderLockIdx > releaseAdvisoryIdx);

  // 7. Section 2.5 backfill updates ONLY rows where t.item_sequence IS NULL
  assert.ok(sql.includes('WHERE t.id = r.ticket_id\n  AND t.item_sequence IS NULL;'));

  // 8. Index on public.orders(ticket_batch_id) exists
  assert.ok(
    sql.includes('CREATE INDEX IF NOT EXISTS idx_orders_ticket_batch_id\n  ON public.orders(ticket_batch_id);')
  );

  // 9. Deferred constraint trigger on public.tickets AND explicit SET CONSTRAINTS ... DEFERRED inside RPCs
  assert.ok(sql.includes('CREATE CONSTRAINT TRIGGER trg_tickets_reconcile_counters_deferred'));
  assert.ok(
    sql.includes(
      'SET CONSTRAINTS\n    public.trg_orders_reconcile_counters_deferred,\n    public.trg_batches_reconcile_counters_deferred,\n    public.trg_tickets_reconcile_counters_deferred\n  DEFERRED;'
    )
  );

  // 10. Transactional admin RPCs and order lifecycle RPCs exist and acquire px_event_inventory lock before ModifyTable
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.cancel_ticket_order('));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.refund_ticket_order('));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.record_late_payment_incident('));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.admin_update_event('));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.admin_update_event_status('));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.admin_delete_event('));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.admin_save_ticket_batch('));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.admin_delete_ticket_batch('));
});

test('evaluateOrderCancellation and evaluateOrderRefund enforce full-order state machine, counter adjustments, and block partial or post-checkin refunds', () => {
  // 1. Customer can cancel their own unpaid reservation, releasing reserved_quantity
  const cancelRes = evaluateOrderCancellation({
    callerUserId: 'usr-customer-1',
    jwtRole: 'authenticated',
    isAdminOrSuperAdmin: false,
    order: {
      id: 'ord-res-1',
      orderCode: '#PX-RES001',
      userId: 'usr-customer-1',
      quantity: 3,
      orderStatus: 'reserved',
      paymentStatus: 'pending',
    },
    batchReservedQuantity: 5,
    existingTicketCount: 0,
  });
  assert.equal(cancelRes.allowed, true);
  assert.equal(cancelRes.idempotentReplay, false);
  assert.equal(cancelRes.nextOrderStatus, 'cancelled');
  assert.equal(cancelRes.releasedQuantity, 3);
  assert.equal(cancelRes.reservedQuantityDelta, -3);

  // 2. Idempotent replay on already cancelled order does not decrement reserved_quantity again
  const cancelReplay = evaluateOrderCancellation({
    callerUserId: 'usr-customer-1',
    jwtRole: 'authenticated',
    isAdminOrSuperAdmin: false,
    order: {
      id: 'ord-res-1',
      orderCode: '#PX-RES001',
      userId: 'usr-customer-1',
      quantity: 3,
      orderStatus: 'cancelled',
      paymentStatus: 'cancelled',
    },
    batchReservedQuantity: 2,
    existingTicketCount: 0,
  });
  assert.equal(cancelReplay.allowed, true);
  assert.equal(cancelReplay.idempotentReplay, true);
  assert.equal(cancelReplay.reservedQuantityDelta, 0);

  // 3. Cannot cancel a paid order via cancel_ticket_order (must use refund_ticket_order)
  const cancelPaidBlocked = evaluateOrderCancellation({
    callerUserId: 'usr-customer-1',
    jwtRole: 'authenticated',
    isAdminOrSuperAdmin: true,
    order: {
      id: 'ord-paid-1',
      orderCode: '#PX-PAID001',
      userId: 'usr-customer-1',
      quantity: 2,
      orderStatus: 'paid',
      paymentStatus: 'approved',
    },
    batchReservedQuantity: 0,
    existingTicketCount: 2,
  });
  assert.equal(cancelPaidBlocked.allowed, false);
  assert.ok(cancelPaidBlocked.errorMessage?.includes('refund_ticket_order'));

  // 4. Normal customer cannot execute refund_ticket_order
  const customerRefundBlocked = evaluateOrderRefund({
    callerUserId: 'usr-customer-1',
    jwtRole: 'authenticated',
    isAdminOrSuperAdmin: false,
    mpPaymentId: 'mp-pay-777',
    order: {
      id: 'ord-paid-1',
      orderCode: '#PX-PAID001',
      quantity: 2,
      orderStatus: 'paid',
      paymentStatus: 'approved',
      mpPaymentId: 'mp-pay-777',
    },
    ticketsOfOrder: [
      { id: 't-1', code: 'PX-AAA11111', status: 'paid' },
      { id: 't-2', code: 'PX-AAA22222', status: 'paid' },
    ],
    batchSoldQuantity: 10,
    eventTicketsSold: 10,
  });
  assert.equal(customerRefundBlocked.allowed, false);

  // 5. Authorized admin or service_role can refund a paid order with all tickets in status=paid
  const validRefund = evaluateOrderRefund({
    callerUserId: 'usr-admin-1',
    jwtRole: 'authenticated',
    isAdminOrSuperAdmin: true,
    mpPaymentId: 'mp-pay-777',
    order: {
      id: 'ord-paid-1',
      orderCode: '#PX-PAID001',
      quantity: 2,
      orderStatus: 'paid',
      paymentStatus: 'approved',
      mpPaymentId: 'mp-pay-777',
    },
    ticketsOfOrder: [
      { id: 't-1', code: 'PX-AAA11111', status: 'paid' },
      { id: 't-2', code: 'PX-AAA22222', status: 'paid' },
    ],
    batchSoldQuantity: 10,
    eventTicketsSold: 10,
  });
  assert.equal(validRefund.allowed, true);
  assert.equal(validRefund.idempotentReplay, false);
  assert.equal(validRefund.nextOrderStatus, 'refunded');
  assert.equal(validRefund.nextPaymentStatus, 'refunded');
  assert.equal(validRefund.ticketsRefunded, 2);
  assert.equal(validRefund.soldQuantityDelta, -2);
  assert.equal(validRefund.eventTicketsSoldDelta, -2);

  // 6. Blocks refund if ANY ticket of the order has already been used at check-in (status=used)
  const usedTicketRefundBlocked = evaluateOrderRefund({
    callerUserId: null,
    jwtRole: 'service_role',
    isAdminOrSuperAdmin: false,
    mpPaymentId: 'mp-pay-777',
    order: {
      id: 'ord-paid-1',
      orderCode: '#PX-PAID001',
      quantity: 2,
      orderStatus: 'paid',
      paymentStatus: 'approved',
      mpPaymentId: 'mp-pay-777',
    },
    ticketsOfOrder: [
      { id: 't-1', code: 'PX-AAA11111', status: 'used' },
      { id: 't-2', code: 'PX-AAA22222', status: 'paid' },
    ],
    batchSoldQuantity: 10,
    eventTicketsSold: 10,
  });
  assert.equal(usedTicketRefundBlocked.allowed, false);
  assert.ok(usedTicketRefundBlocked.errorMessage?.includes('já tiveram check-in realizado'));
});

test('evaluateTicketMutationIntegrity and verifyAndProcessCheckin enforce ticket immutability, block used -> paid/refunded reversal, and block check-in of refunded tickets', () => {
  const paidParentOrder = {
    id: 'ord-1',
    orderCode: '#PX-ORD1',
    userId: 'usr-1',
    eventId: 'evt-1',
    ticketBatchId: 'batch-1',
    quantity: 2,
    orderStatus: 'paid' as const,
    paymentStatus: 'approved' as const,
    mpPaymentId: 'mp-123',
  };

  const baseTicket = {
    id: 't-1',
    code: 'PX-11112222',
    qrPayload: 'PXCUSTON|PX-11112222|evt-1|1',
    orderId: 'ord-1',
    itemSequence: 1,
    userId: 'usr-1',
    eventId: 'evt-1',
    categoryId: 'cat-1',
    batchId: 'batch-1',
    status: 'paid' as const,
    mpPaymentId: 'mp-123',
    usedAt: null,
  };

  // 1. DELETE on tickets is unconditionally forbidden
  assert.equal(
    evaluateTicketMutationIntegrity({
      operation: 'DELETE',
      parentOrder: paidParentOrder,
      batchCategoryId: 'cat-1',
      oldTicket: baseTicket,
    }).allowed,
    false
  );

  // 2. paid -> used is allowed when parentOrder is paid/approved and usedAt is set
  assert.equal(
    evaluateTicketMutationIntegrity({
      operation: 'UPDATE',
      parentOrder: paidParentOrder,
      batchCategoryId: 'cat-1',
      oldTicket: baseTicket,
      newTicket: { ...baseTicket, status: 'used', usedAt: '2026-04-25T20:00:00Z' },
    }).allowed,
    true
  );

  // 3. used -> paid and used -> refunded are strictly blocked
  const usedTicket = { ...baseTicket, status: 'used' as const, usedAt: '2026-04-25T20:00:00Z' };
  assert.equal(
    evaluateTicketMutationIntegrity({
      operation: 'UPDATE',
      parentOrder: paidParentOrder,
      batchCategoryId: 'cat-1',
      oldTicket: usedTicket,
      newTicket: { ...usedTicket, status: 'paid', usedAt: null },
    }).allowed,
    false
  );
  assert.equal(
    evaluateTicketMutationIntegrity({
      operation: 'UPDATE',
      parentOrder: { ...paidParentOrder, orderStatus: 'refunded', paymentStatus: 'refunded' },
      batchCategoryId: 'cat-1',
      oldTicket: usedTicket,
      newTicket: { ...usedTicket, status: 'refunded' },
    }).allowed,
    false
  );

  // 4. paid -> refunded is allowed ONLY when parentOrder is refunded/refunded
  assert.equal(
    evaluateTicketMutationIntegrity({
      operation: 'UPDATE',
      parentOrder: paidParentOrder,
      batchCategoryId: 'cat-1',
      oldTicket: baseTicket,
      newTicket: { ...baseTicket, status: 'refunded' },
    }).allowed,
    false
  );
  assert.equal(
    evaluateTicketMutationIntegrity({
      operation: 'UPDATE',
      parentOrder: { ...paidParentOrder, orderStatus: 'refunded', paymentStatus: 'refunded' },
      batchCategoryId: 'cat-1',
      oldTicket: baseTicket,
      newTicket: { ...baseTicket, status: 'refunded' },
    }).allowed,
    true
  );

  // 5. Check-in of a refunded ticket is blocked with statusReason = 'invalid'
  const refundedDomainTicket: Ticket = {
    id: 't-ref-1',
    code: 'PX-REFUND01',
    qrPayload: 'PXCUSTON|PX-REFUND01|evt-1|1',
    orderId: 'ord-1',
    paymentId: 'mp-123',
    userId: 'usr-1',
    holderName: 'Carlos Mendes',
    holderCpf: '12345678900',
    eventId: 'evt-1',
    eventTitle: 'PX CUSTON Night Meet',
    eventDate: '25/04/2026',
    eventLocation: 'Interlagos',
    eventImageUrl: '/assets/events/ev-rebaixados.jpg',
    ticketTypeId: 'batch-1',
    ticketTypeName: 'Pista 1º Lote',
    pricePaid: 50,
    status: 'refunded',
    issuedAt: '2026-04-01T10:00:00Z',
  };
  const checkinRefunded = verifyAndProcessCheckin(
    'PX-REFUND01',
    [refundedDomainTicket],
    'Operador 01',
    '25/04/2026 20:10'
  );
  assert.equal(checkinRefunded.authorized, false);
  assert.equal(checkinRefunded.statusReason, 'invalid');
  assert.ok(checkinRefunded.message.includes('reembolsado'));
});

test('evaluateLatePaymentConciliation records late payment incidents on expired/cancelled orders without ever issuing tickets', () => {
  const existingKeys = new Set<string>();

  // 1. Late payment on an expired order -> records incident, requiresRefund=true, ticketsIssued=0
  const lateOnExpired = evaluateLatePaymentConciliation({
    jwtRole: 'service_role',
    order: {
      id: 'ord-exp-1',
      orderCode: '#PX-EXP001',
      totalAmount: 106,
      orderStatus: 'expired',
      paymentStatus: 'cancelled',
    },
    mpPaymentId: 'mp-late-999',
    mpPaymentStatus: 'approved',
    verifiedAmount: 106,
    currency: 'BRL',
    externalReference: '#PX-EXP001',
    existingTicketCount: 0,
    existingIncidentKeys: existingKeys,
  });
  assert.equal(lateOnExpired.action, 'record_late_payment_incident');
  assert.equal(lateOnExpired.incidentRecorded, true);
  assert.equal(lateOnExpired.requiresRefund, true);
  assert.equal(lateOnExpired.ticketsIssued, 0);
  assert.equal(lateOnExpired.idempotentReplay, false);
  assert.equal(lateOnExpired.idempotencyKey, 'late_payment:ord-exp-1:mp-late-999');

  // 2. Replay of the same webhook is idempotent
  existingKeys.add(lateOnExpired.idempotencyKey!);
  const replayLate = evaluateLatePaymentConciliation({
    jwtRole: 'service_role',
    order: {
      id: 'ord-exp-1',
      orderCode: '#PX-EXP001',
      totalAmount: 106,
      orderStatus: 'expired',
      paymentStatus: 'cancelled',
    },
    mpPaymentId: 'mp-late-999',
    mpPaymentStatus: 'approved',
    verifiedAmount: 106,
    currency: 'BRL',
    externalReference: 'ord-exp-1',
    existingTicketCount: 0,
    existingIncidentKeys: existingKeys,
  });
  assert.equal(replayLate.action, 'record_late_payment_incident');
  assert.equal(replayLate.idempotentReplay, true);
  assert.equal(replayLate.ticketsIssued, 0);

  // 3. Active reservation routes to normal confirm_payment
  const activeOrder = evaluateLatePaymentConciliation({
    jwtRole: 'service_role',
    order: {
      id: 'ord-res-2',
      orderCode: '#PX-RES002',
      totalAmount: 106,
      orderStatus: 'reserved',
      paymentStatus: 'pending',
    },
    mpPaymentId: 'mp-ok-111',
    mpPaymentStatus: 'approved',
    verifiedAmount: 106,
    currency: 'BRL',
    externalReference: 'ord-res-2',
    existingTicketCount: 0,
  });
  assert.equal(activeOrder.action, 'confirm_payment');
});

test('migration 002 audit_logs schema, admin_create_event / admin_update_event DATE casting, and platformService exclusive RPC writes', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/002_rpc_contracts_permissions_idempotency.sql'
  );
  const sql = fs.readFileSync(migrationPath, 'utf8');

  // 1. Verify public.audit_logs table columns match every INSERT INTO public.audit_logs
  const createAuditMatch = sql.match(
    /CREATE TABLE IF NOT EXISTS public\.audit_logs\s*\(([\s\S]*?)\);/
  );
  assert.ok(createAuditMatch, 'public.audit_logs table definition must exist');
  const auditTableDef = createAuditMatch![1];
  const expectedAuditCols = [
    'id',
    'actor_id',
    'actor_role',
    'action',
    'entity_type',
    'entity_id',
    'event_id',
    'order_id',
    'mp_payment_id',
    'idempotency_key',
    'details',
    'created_at',
  ];
  for (const col of expectedAuditCols) {
    assert.ok(
      new RegExp(`\\b${col}\\b`).test(auditTableDef),
      `Column ${col} must be defined in public.audit_logs`
    );
  }
  assert.equal(auditTableDef.includes('target_entity'), false);
  assert.equal(auditTableDef.includes('metadata'), false);

  const insertMatches = [
    ...sql.matchAll(/INSERT INTO public\.audit_logs\s*\(([\s\S]*?)\)\s*VALUES/g),
  ];
  assert.equal(insertMatches.length, 3, 'Must have 3 INSERT INTO public.audit_logs statements');
  const definedSet = new Set(expectedAuditCols);
  for (const match of insertMatches) {
    const cols = match[1]
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    for (const col of cols) {
      assert.ok(
        definedSet.has(col),
        `INSERT INTO public.audit_logs uses column "${col}" which must exist in public.audit_logs`
      );
    }
  }

  // 2. Verify record_late_payment_incident uses ON CONFLICT (idempotency_key) DO NOTHING
  assert.ok(sql.includes('ON CONFLICT (idempotency_key) DO NOTHING'));

  // 3. Verify admin_create_event and admin_update_event validate and cast p_event_date to DATE (v_parsed_event_date)
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.admin_create_event('));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.admin_update_event('));
  assert.ok(sql.includes('v_parsed_event_date DATE;'));
  assert.ok(sql.includes('v_parsed_event_date := v_clean_date::DATE;'));
  assert.ok(sql.includes('event_date = v_parsed_event_date,'));
  assert.equal(sql.includes('event_date = p_event_date'), false);

  // 4. Verify direct write RLS policies on events and ticket_batches are dropped and privileges revoked
  assert.ok(sql.includes('DROP POLICY IF EXISTS events_admin_insert ON public.events;'));
  assert.ok(sql.includes('DROP POLICY IF EXISTS events_admin_update ON public.events;'));
  assert.ok(sql.includes('DROP POLICY IF EXISTS events_admin_delete ON public.events;'));
  assert.ok(
    sql.includes('DROP POLICY IF EXISTS ticket_batches_admin_write ON public.ticket_batches;')
  );
  assert.ok(
    sql.includes('REVOKE INSERT, UPDATE, DELETE ON public.events FROM PUBLIC, anon, authenticated;')
  );
  assert.ok(
    sql.includes(
      'REVOKE INSERT, UPDATE, DELETE ON public.ticket_batches FROM PUBLIC, anon, authenticated;'
    )
  );

  // 5. Verify platformService.ts performs zero direct writes (.insert/.update/.delete) on events or ticket_batches
  const servicePath = path.resolve(process.cwd(), 'src/services/platformService.ts');
  const serviceCode = fs.readFileSync(servicePath, 'utf8');
  assert.equal(serviceCode.includes(".from('events')\n    .insert"), false);
  assert.equal(serviceCode.includes(".from('events')\n    .update"), false);
  assert.equal(serviceCode.includes(".from('events')\n    .delete"), false);
  assert.equal(serviceCode.includes(".from('ticket_batches').insert"), false);
  assert.equal(serviceCode.includes(".from('ticket_batches').update"), false);
  assert.equal(serviceCode.includes(".from('ticket_batches').delete"), false);
  assert.ok(serviceCode.includes("supabase.rpc('admin_create_event'"));
  assert.ok(serviceCode.includes("supabase.rpc('admin_update_event'"));
  assert.ok(serviceCode.includes("supabase.rpc('admin_update_event_status'"));
  assert.ok(serviceCode.includes("supabase.rpc('admin_delete_event'"));
  assert.ok(serviceCode.includes("supabase.rpc('admin_save_ticket_batch'"));
  assert.ok(serviceCode.includes("supabase.rpc('admin_delete_ticket_batch'"));

  // 6. Verify translateEventDatabaseError surfaces missing RPC (PGRST202 / 42883) and invalid date (22007 / 22008)
  const missingRpcMsg = translateEventDatabaseError(
    { code: 'PGRST202', message: 'Could not find the function public.admin_update_event' },
    'update'
  );
  assert.ok(missingRpcMsg.includes('migration 002'));
  const badDateMsg = translateEventDatabaseError(
    { code: '22007', message: 'invalid input syntax for type date' },
    'update'
  );
  assert.ok(badDateMsg.includes('YYYY-MM-DD'));
});

test('Correções 1-5: ticket_categories protection, category-batch-event validation, check-in indexes/canonical locks, and TypeScript/SQL RPC contracts', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/002_rpc_contracts_permissions_idempotency.sql'
  );
  const sql = fs.readFileSync(migrationPath, 'utf8');

  // 1. CORREÇÃO 1: Integridade de ticket_categories (RLS, REVOKE, trigger, RPCs)
  assert.ok(
    sql.includes('DROP POLICY IF EXISTS ticket_categories_admin_write ON public.ticket_categories;')
  );
  assert.ok(
    sql.includes(
      'REVOKE INSERT, UPDATE, DELETE ON public.ticket_categories FROM PUBLIC, anon, authenticated;'
    )
  );
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.enforce_ticket_category_integrity()'));
  assert.ok(sql.includes('CREATE TRIGGER trg_ticket_categories_enforce_integrity'));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.admin_save_ticket_category('));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.admin_delete_ticket_category('));

  // Verify evaluateTicketCategoryMutationIntegrity pure logic
  const catBase = {
    id: 'cat-1',
    eventId: 'evt-1',
    name: 'Pista',
    slug: 'pista',
    maxPerOrder: 6,
    sortOrder: 1,
    active: true,
    createdAt: '2026-04-01T10:00:00Z',
  };
  assert.equal(
    evaluateTicketCategoryMutationIntegrity({
      operation: 'UPDATE',
      oldCategory: catBase,
      newCategory: { ...catBase, eventId: 'evt-OTHER' },
    }).allowed,
    false
  );
  assert.equal(
    evaluateTicketCategoryMutationIntegrity({
      operation: 'UPDATE',
      oldCategory: catBase,
      newCategory: { ...catBase, active: false },
      batchesOfCategory: [
        { id: 'b-1', active: true, soldQuantity: 0, reservedQuantity: 0 },
      ],
    }).allowed,
    false
  );
  assert.equal(
    evaluateTicketCategoryMutationIntegrity({
      operation: 'DELETE',
      oldCategory: catBase,
      batchesOfCategory: [],
      ticketsCountForCategory: 1,
    }).allowed,
    false
  );
  assert.equal(
    evaluateTicketCategoryMutationIntegrity({
      operation: 'UPDATE',
      oldCategory: catBase,
      newCategory: { ...catBase, name: 'Pista Premium' },
      batchesOfCategory: [
        { id: 'b-1', active: true, soldQuantity: 0, reservedQuantity: 0 },
      ],
    }).allowed,
    true
  );

  // 2. CORREÇÃO 2: Validação entre ticket_categories, ticket_batches e events
  assert.ok(sql.includes('ADD CONSTRAINT uq_ticket_categories_id_event UNIQUE (id, event_id)'));
  assert.ok(
    sql.includes(
      'ADD CONSTRAINT fk_ticket_batches_category_same_event\n      FOREIGN KEY (category_id, event_id)\n      REFERENCES public.ticket_categories(id, event_id)\n      ON DELETE CASCADE;'
    )
  );
  assert.ok(
    sql.includes(
      "IF v_category.event_id <> v_target_event_id THEN\n    RAISE EXCEPTION\n      'Inconsistência referencial: a categoria \"%\" (%) pertence ao evento (%) e não pode ser vinculada a um lote do evento (%).'"
    )
  );

  // Pure function validation of category-batch-event relationship
  const crossEventBatch = evaluateBatchAllocationIntegrity({
    operation: 'INSERT',
    eventCapacity: 500,
    eventTicketsSold: 0,
    category: { id: 'cat-other', eventId: 'evt-2', active: true },
    newBatch: {
      id: 'b-1',
      eventId: 'evt-1',
      categoryId: 'cat-other',
      totalQuantity: 100,
      reservedQuantity: 0,
      soldQuantity: 0,
      active: true,
    },
    otherBatchesOfEvent: [],
  });
  assert.equal(crossEventBatch.allowed, false);
  assert.ok(crossEventBatch.errorMessage?.includes('pertence ao evento'));

  const inactiveCategoryActiveBatch = evaluateBatchAllocationIntegrity({
    operation: 'INSERT',
    eventCapacity: 500,
    eventTicketsSold: 0,
    category: { id: 'cat-1', eventId: 'evt-1', active: false },
    newBatch: {
      id: 'b-1',
      eventId: 'evt-1',
      categoryId: 'cat-1',
      totalQuantity: 100,
      reservedQuantity: 0,
      soldQuantity: 0,
      active: true,
    },
    otherBatchesOfEvent: [],
  });
  assert.equal(inactiveCategoryActiveBatch.allowed, false);
  assert.ok(inactiveCategoryActiveBatch.errorMessage?.includes('categoria inativa'));

  // 3. CORREÇÃO 3: Check-in functional indexes & canonical lock order
  assert.ok(
    sql.includes('CREATE INDEX IF NOT EXISTS idx_tickets_upper_code\n  ON public.tickets (upper(code));')
  );
  assert.ok(
    sql.includes(
      'CREATE INDEX IF NOT EXISTS idx_tickets_upper_qr_payload\n  ON public.tickets (upper(qr_payload));'
    )
  );
  const checkinStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.perform_ticket_checkin(');
  const checkinEnd = sql.indexOf('-- 8. PERMISSÕES DE TABELAS, COLUNAS E EXECUÇÃO');
  const checkinBody = sql.slice(checkinStart, checkinEnd);
  const idxPointLookup = checkinBody.indexOf('SELECT id, event_id, order_id\n  INTO v_target_ticket_id, v_target_event_id, v_target_order_id');
  const idxAdvisoryLock = checkinBody.indexOf("PERFORM pg_advisory_xact_lock(hashtext('px_event_inventory:' || v_target_event_id::text));");
  const idxEventLock = checkinBody.indexOf('PERFORM 1\n  FROM public.events\n  WHERE id = v_target_event_id\n  FOR UPDATE;');
  const idxCatLock = checkinBody.indexOf('PERFORM 1\n  FROM public.ticket_categories\n  WHERE event_id = v_target_event_id\n  ORDER BY id ASC\n  FOR UPDATE;');
  const idxBatchLock = checkinBody.indexOf('PERFORM 1\n  FROM public.ticket_batches\n  WHERE event_id = v_target_event_id\n  ORDER BY id ASC\n  FOR UPDATE;');
  const idxOrderLock = checkinBody.indexOf('SELECT * INTO v_order\n  FROM public.orders\n  WHERE id = v_target_order_id\n  FOR UPDATE;');
  const idxTicketLock = checkinBody.indexOf('SELECT * INTO v_ticket\n  FROM public.tickets\n  WHERE id = v_target_ticket_id\n  FOR UPDATE;');

  assert.ok(idxPointLookup > 0);
  assert.ok(idxAdvisoryLock > idxPointLookup);
  assert.ok(idxEventLock > idxAdvisoryLock);
  assert.ok(idxCatLock > idxEventLock);
  assert.ok(idxBatchLock > idxCatLock);
  assert.ok(idxOrderLock > idxBatchLock);
  assert.ok(idxTicketLock > idxOrderLock);

  // 4. CORREÇÃO 4 & 5: Idempotent re-execution & error translation
  assert.ok(sql.includes('DROP FUNCTION IF EXISTS public.release_expired_reservations();'));
  assert.ok(sql.includes('DROP FUNCTION IF EXISTS public.cancel_ticket_order(UUID, TEXT);'));
  assert.ok(sql.includes('DROP FUNCTION IF EXISTS public.refund_ticket_order(UUID, TEXT, TEXT);'));
  assert.ok(sql.includes('DROP FUNCTION IF EXISTS public.admin_save_ticket_batch('));
  assert.ok(sql.includes('DROP FUNCTION IF EXISTS public.admin_save_ticket_category('));

  const batchErrMsg = translateBatchOrCategoryDatabaseError(
    { code: 'PGRST202', message: 'Could not find the function public.admin_save_ticket_batch' },
    'batch',
    'save'
  );
  assert.ok(batchErrMsg.includes('migration 002'));
});

