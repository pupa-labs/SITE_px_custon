/**
 * PX CUSTON — Domain Model & Supabase PostgreSQL Schema Types
 * Prepared for production integration with Supabase (PostgreSQL + Auth + RLS) and Mercado Pago.
 */

export type TicketStatus = 'pending' | 'paid' | 'cancelled' | 'refunded' | 'used' | 'expired';

export type OrderStatus =
  | 'reserved'
  | 'pending_payment'
  | 'paid'
  | 'cancelled'
  | 'expired'
  | 'refunded';

export type PaymentStatus =
  | 'pending'
  | 'in_process'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'refunded'
  | 'charged_back';

export type PaymentMethodType = 'pix' | 'credit_card';

export type UserRole = 'visitor' | 'customer' | 'checkin_operator' | 'admin' | 'SUPER_ADMIN';

export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

export type EventStatus = 'Publicado' | 'Rascunho' | 'Encerrado' | 'Cancelado';

export interface Profile {
  id: string;
  fullName: string;
  cpf: string;
  email: string;
  phone: string;
  city: string;
  role: UserRole;
  createdAt: string;
}

export interface AdminAccessEvaluation {
  allowed: boolean;
  reasonCode:
    | 'authorized_admin'
    | 'unauthenticated'
    | 'profile_missing'
    | 'profile_error'
    | 'profile_id_mismatch'
    | 'insufficient_role';
  userRole: UserRole;
  message: string;
}

export interface EventCategory {
  id: string;
  slug: string;
  name: string;
  description: string;
  imageUrl: string;
  iconType: 'car' | 'moto' | 'tuning' | 'performance' | 'trophy';
  eventCount: number;
}

export interface TicketLot {
  id: string;
  eventId: string;
  ticketCategoryId?: string;
  name: string;
  categoryLabel: string;
  batchNumber: number;
  description: string;
  price: number;
  serviceFeeRate?: number;
  totalQuantity: number;
  reservedQuantity?: number;
  soldQuantity?: number;
  availableQuantity: number;
  maxPerOrder?: number;
  thumbnailUrl: string;
  active: boolean;
}

export interface EventItem {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  categoryId: string;
  categoryName: string;
  dateFormatted: string;
  eventDateIso?: string;
  dayNumber: string;
  monthShort: string;
  year: string;
  timeRange: string;
  city: string;
  venueName: string;
  startingPrice: number;
  bannerUrl: string;
  cardImageUrl: string;
  galleryUrls: string[];
  description: string;
  highlights: string[];
  status: EventStatus;
  dbStatus?: 'draft' | 'published' | 'ended' | 'cancelled';
  featured: boolean;
  ticketsSold: number;
  capacity: number;
  lots: TicketLot[];
}

export interface AdminEventFormInput {
  id?: string;
  title: string;
  subtitle?: string;
  slug?: string;
  categoryId: string;
  categoryName?: string;
  dateInput: string;
  timeRange: string;
  city: string;
  venueName: string;
  startingPrice: number | string;
  capacity: number | string;
  ticketsSold?: number;
  bannerUrl: string;
  cardImageUrl: string;
  galleryUrls?: string[];
  description: string;
  highlights?: string[] | string;
  status: EventStatus | 'draft' | 'published' | 'ended' | 'cancelled';
  featured?: boolean;
}

export interface DbEventWritePayload {
  slug: string;
  title: string;
  subtitle: string | null;
  category_slug: string;
  category_name: string;
  event_date: string;
  time_range: string;
  city: string;
  venue_name: string;
  starting_price: number;
  banner_url: string;
  card_image_url: string;
  gallery_urls: string[];
  description: string;
  highlights: string[];
  status: 'draft' | 'published' | 'ended' | 'cancelled';
  featured: boolean;
  capacity: number;
}

export interface Ticket {
  id: string;
  code: string;
  qrPayload: string;
  orderId: string;
  paymentId: string;
  userId: string;
  holderName: string;
  holderCpf: string;
  eventId: string;
  eventTitle: string;
  eventDate: string;
  eventLocation: string;
  eventImageUrl: string;
  ticketTypeId: string;
  ticketCategoryId?: string;
  ticketTypeName: string;
  pricePaid: number;
  status: TicketStatus;
  usedAt?: string;
  usedByOperator?: string;
  issuedAt: string;
}

export interface OrderItem {
  id: string;
  lotId: string;
  lotName: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
}

export interface Order {
  id: string;
  orderCode: string;
  userId: string;
  buyerName: string;
  buyerCpf: string;
  buyerEmail: string;
  buyerPhone: string;
  eventId: string;
  eventTitle: string;
  eventDate: string;
  eventLocation: string;
  items: OrderItem[];
  subtotal: number;
  convenienceFee: number;
  totalAmount: number;
  paymentMethod: PaymentMethodType;
  status: OrderStatus;
  paymentStatus?: PaymentStatus;
  reservationExpiresAt?: string;
  mpPreferenceId?: string;
  mpPaymentId?: string;
  createdAt: string;
}

export interface CheckinRecord {
  id: string;
  ticketId: string;
  ticketCode: string;
  eventTitle: string;
  holderName: string;
  categoryName: string;
  checkedInAt: string;
  operatorName: string;
  deviceId: string;
  result: 'authorized' | 'already_used' | 'invalid' | 'unpaid';
  message: string;
}

export interface AuditLogEntry {
  id: string;
  actorName: string;
  actorRole: UserRole;
  action: string;
  targetEntity: string;
  timestamp: string;
}

/**
 * PostgreSQL Row Types (matching supabase/migrations/001_initial_schema.sql & 002)
 * Monetary columns are NUMERIC(12, 2) in PostgreSQL (returned as number or numeric string by PostgREST).
 */
export interface DbProfileRow {
  id: string;
  full_name: string;
  cpf: string | null;
  email: string;
  phone: string | null;
  city: string | null;
  role: 'customer' | 'checkin_operator' | 'admin' | 'SUPER_ADMIN';
  created_at: string;
  updated_at: string;
}

export interface DbEventRow {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  category_slug: string;
  category_name: string;
  event_date: string;
  time_range: string;
  city: string;
  venue_name: string;
  starting_price: number | string;
  banner_url: string;
  card_image_url: string;
  gallery_urls: string[];
  description: string;
  highlights: string[];
  status: 'draft' | 'published' | 'ended' | 'cancelled';
  featured: boolean;
  capacity: number;
  tickets_sold: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbTicketCategoryRow {
  id: string;
  event_id: string;
  name: string;
  slug: string;
  description: string | null;
  max_per_order: number;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbTicketBatchRow {
  id: string;
  event_id: string;
  category_id: string;
  name: string;
  batch_number: number;
  description: string | null;
  price: number | string;
  total_quantity: number;
  reserved_quantity: number;
  sold_quantity: number;
  thumbnail_url: string | null;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbOrderRow {
  id: string;
  order_code: string;
  user_id: string;
  event_id: string;
  ticket_batch_id: string;
  quantity: number;
  buyer_name: string;
  buyer_cpf: string;
  buyer_email: string;
  buyer_phone: string;
  unit_price: number | string;
  subtotal: number | string;
  convenience_fee: number | string;
  total_amount: number | string;
  payment_method: PaymentMethodType;
  order_status: OrderStatus;
  payment_status: PaymentStatus;
  mp_preference_id: string | null;
  mp_payment_id: string | null;
  reservation_expires_at: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbTicketRow {
  id: string;
  code: string;
  qr_payload: string;
  order_id: string;
  item_sequence: number;
  user_id: string;
  event_id: string;
  category_id: string;
  batch_id: string;
  holder_name: string;
  holder_cpf: string;
  price_paid: number | string;
  status: TicketStatus;
  mp_payment_id: string | null;
  issued_at: string;
  used_at: string | null;
  used_by_operator_id: string | null;
  checkin_device_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbAuditLogRow {
  id: string;
  actor_id: string | null;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: string;
  event_id: string | null;
  order_id: string | null;
  mp_payment_id: string | null;
  idempotency_key: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

/**
 * RPC Contracts (matching supabase/migrations/002_rpc_contracts_permissions_idempotency.sql)
 */
export interface ReserveOrderRpcArgs {
  p_ticket_batch_id: string;
  p_quantity: number;
  p_payment_method: PaymentMethodType;
  p_buyer_name: string;
  p_buyer_cpf: string;
  p_buyer_email: string;
  p_buyer_phone: string;
}

export interface ReserveOrderRpcPayload {
  order_id: string;
  order_code: string;
  unit_price: number | string;
  subtotal: number | string;
  convenience_fee: number | string;
  total_amount: number | string;
  order_status: OrderStatus;
  payment_status: PaymentStatus;
  reservation_expires_at: string;
}

export interface ConfirmOrderPaymentRpcArgs {
  p_order_id: string;
  p_mp_payment_id: string;
  p_mp_payment_status: PaymentStatus;
  p_verified_amount: number;
  p_currency: 'BRL';
  p_external_reference: string;
}

export interface ConfirmOrderPaymentRpcPayload {
  order_id: string;
  order_code: string;
  mp_payment_id: string;
  tickets_issued: number;
  idempotent_replay: boolean;
}

export interface CancelTicketOrderRpcArgs {
  p_order_id: string;
  p_reason?: string | null;
}

export interface CancelTicketOrderRpcPayload {
  order_id: string;
  order_code: string;
  order_status: 'cancelled';
  payment_status: 'cancelled' | 'rejected';
  released_quantity: number;
  idempotent_replay: boolean;
}

export interface RefundTicketOrderRpcArgs {
  p_order_id: string;
  p_mp_payment_id: string;
  p_reason?: string | null;
}

export interface RefundTicketOrderRpcPayload {
  order_id: string;
  order_code: string;
  mp_payment_id: string;
  order_status: 'refunded';
  payment_status: 'refunded';
  tickets_refunded: number;
  idempotent_replay: boolean;
}

export interface RecordLatePaymentIncidentRpcArgs {
  p_order_id: string;
  p_mp_payment_id: string;
  p_mp_payment_status: PaymentStatus;
  p_verified_amount: number;
  p_currency: 'BRL';
  p_external_reference: string;
  p_reason?: string | null;
}

export interface RecordLatePaymentIncidentRpcPayload {
  incident_recorded: boolean;
  audit_log_id: string;
  order_id: string;
  order_code: string;
  order_status: 'expired' | 'cancelled';
  mp_payment_id: string;
  verified_amount: number;
  tickets_issued: 0;
  requires_refund: true;
  idempotent_replay: boolean;
}

export interface AdminCreateEventRpcArgs {
  p_slug: string;
  p_title: string;
  p_subtitle: string | null;
  p_category_slug: string;
  p_category_name: string;
  p_event_date: string;
  p_time_range: string;
  p_city: string;
  p_venue_name: string;
  p_starting_price: number;
  p_banner_url: string;
  p_card_image_url: string;
  p_gallery_urls: string[];
  p_description: string;
  p_highlights: string[];
  p_status: DbEventRow['status'];
  p_featured: boolean;
  p_capacity: number;
}

export interface AdminUpdateEventRpcArgs extends AdminCreateEventRpcArgs {
  p_event_id: string;
}

export interface AdminUpdateEventStatusRpcArgs {
  p_event_id: string;
  p_status: DbEventRow['status'];
}

export interface AdminDeleteEventRpcArgs {
  p_event_id: string;
}

export interface AdminSaveTicketBatchRpcArgs {
  p_batch_id: string | null;
  p_event_id: string;
  p_category_id: string;
  p_name: string;
  p_batch_number: number;
  p_description: string;
  p_price: number;
  p_total_quantity: number;
  p_thumbnail_url?: string | null;
  p_starts_at?: string | null;
  p_ends_at?: string | null;
  p_active?: boolean;
}

export interface AdminDeleteTicketBatchRpcArgs {
  p_batch_id: string;
}

export interface AdminSaveTicketBatchInput {
  id?: string | null;
  eventId: string;
  categoryId: string;
  name: string;
  batchNumber: number;
  description?: string;
  price: number;
  totalQuantity: number;
  thumbnailUrl?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  active?: boolean;
}

export interface AdminSaveTicketCategoryRpcArgs {
  p_category_id: string | null;
  p_event_id: string;
  p_slug: string;
  p_name: string;
  p_description?: string | null;
  p_max_per_order?: number;
  p_sort_order?: number;
  p_active?: boolean;
}

export interface AdminDeleteTicketCategoryRpcArgs {
  p_category_id: string;
}

export interface AdminSaveTicketCategoryInput {
  id?: string | null;
  eventId: string;
  slug: string;
  name: string;
  description?: string | null;
  maxPerOrder?: number;
  sortOrder?: number;
  active?: boolean;
}

export interface CheckinRpcArgs {
  p_code_or_payload: string;
  p_device_id?: string;
}

export interface CheckinRpcPayload {
  authorized: boolean;
  result?: 'authorized' | 'already_used' | 'invalid' | 'unpaid';
  status_reason?: 'authorized' | 'already_used' | 'invalid' | 'unpaid';
  ticket_id?: string;
  ticket_code?: string;
  code?: string;
  holder_name?: string;
  used_at?: string;
  status?: TicketStatus | OrderStatus | 'unknown';
  message: string;
}

