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

export type EventStatus = 'Publicado' | 'Rascunho' | 'Encerrado';

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
  featured: boolean;
  ticketsSold: number;
  capacity: number;
  lots: TicketLot[];
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
 * PostgreSQL Row Types (matching supabase/migrations/001_initial_schema.sql)
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
  is_active: boolean;
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
  description: string;
  highlights: string[];
  venue_name: string;
  city: string;
  state_uf: string;
  starts_at: string;
  ends_at: string | null;
  time_range_label: string;
  banner_url: string;
  card_image_url: string;
  gallery_urls: string[];
  starting_price: number | string;
  capacity: number;
  tickets_sold: number;
  status: 'draft' | 'published' | 'ended' | 'cancelled';
  featured: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbTicketCategoryRow {
  id: string;
  event_id: string;
  slug: string;
  name: string;
  description: string | null;
  benefits: string[];
  display_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbTicketBatchRow {
  id: string;
  event_id: string;
  ticket_category_id: string;
  batch_number: number;
  name: string;
  description: string | null;
  price: number | string;
  service_fee_rate: number | string;
  total_quantity: number;
  reserved_quantity: number;
  sold_quantity: number;
  max_per_order: number;
  sales_starts_at: string | null;
  sales_ends_at: string | null;
  thumbnail_url: string | null;
  is_active: boolean;
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
  unit_price: number | string;
  subtotal: number | string;
  convenience_fee: number | string;
  total_amount: number | string;
  buyer_name: string;
  buyer_cpf: string;
  buyer_email: string;
  buyer_phone: string;
  payment_method: PaymentMethodType;
  order_status: OrderStatus;
  payment_status: PaymentStatus;
  reservation_expires_at: string;
  mp_preference_id: string | null;
  mp_payment_id: string | null;
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
  user_id: string;
  event_id: string;
  ticket_category_id: string;
  ticket_batch_id: string;
  holder_name: string;
  holder_cpf: string;
  price_paid: number | string;
  status: TicketStatus;
  issued_at: string;
  used_at: string | null;
  used_by_operator_id: string | null;
  used_by_operator_name: string | null;
  checkin_device_id: string | null;
  created_at: string;
  updated_at: string;
}

