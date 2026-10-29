import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateOrderTotals,
  formatBRL,
  validateBuyerData,
  verifyAndProcessCheckin,
  validateBatchStockAvailability,
  canTransitionOrderToPaid,
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

