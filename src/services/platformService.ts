import type {
  EventCategory,
  EventItem,
  TicketLot,
  Ticket,
  Order,
  CheckinRecord,
  Profile,
  AuditLogEntry,
  DbEventRow,
  DbTicketBatchRow,
  DbTicketCategoryRow,
  DbOrderRow,
  PaymentMethodType,
  OrderStatus,
  PaymentStatus,
} from '../types/domain';
import {
  supabase,
  supabaseConfigState,
  verifySupabaseConnection,
  type SupabaseConnectionStatus,
} from '../lib/supabase';
import {
  CONVENIENCE_FEE_RATE,
  buildReserveOrderRpcArgs,
  normalizeReserveOrderRpcResponse,
  normalizeCheckinRpcResponse,
} from '../utils/ticketRules';

export {
  supabase,
  supabaseConfigState,
  verifySupabaseConnection,
  type SupabaseConnectionStatus,
};

/**
 * Official PX CUSTON Logo & Visual Assets
 * Preserves the original user-provided logo at /assets/aistudio/IMG-20261005-WA0172_fd0eb16e.jpg
 * and its trimmed transparent header counterpart.
 */
export const OFFICIAL_LOGO_ORIGINAL = '/assets/aistudio/IMG-20261005-WA0172_fd0eb16e.jpg';
export const OFFICIAL_LOGO_TRANSPARENT = '/assets/px-custon-logo.png';

export const INITIAL_CATEGORIES: EventCategory[] = [
  {
    id: 'cat-carros',
    slug: 'encontros-de-carros',
    name: 'Encontros de Carros',
    description: 'Carros rebaixados, projetos especiais, rodas e suspensão a ar.',
    imageUrl: '/assets/events/cat-carros.jpg',
    iconType: 'car',
    eventCount: 12,
  },
  {
    id: 'cat-motos',
    slug: 'encontros-de-motos',
    name: 'Encontros de Motos',
    description: 'Motos esportivas, alta cilindrada, customizadas e encontros noturnos.',
    imageUrl: '/assets/events/cat-motos.jpg',
    iconType: 'moto',
    eventCount: 8,
  },
  {
    id: 'cat-tuning',
    slug: 'tuning-e-customizacao',
    name: 'Tuning e Customização',
    description: 'Bodykits, estética automotiva, som, iluminação e projetos exclusivos.',
    imageUrl: '/assets/events/cat-tuning.jpg',
    iconType: 'tuning',
    eventCount: 9,
  },
  {
    id: 'cat-performance',
    slug: 'eventos-de-performance',
    name: 'Eventos de Performance',
    description: 'Track days, arrancada, drift, motores turbo e aspirados de pista.',
    imageUrl: '/assets/events/cat-performance.jpg',
    iconType: 'performance',
    eventCount: 6,
  },
  {
    id: 'cat-exposicoes',
    slug: 'exposicoes-automotivas',
    name: 'Exposições Automotivas',
    description: 'Salões, clássicos nacionais, importados raros e premiações oficiais.',
    imageUrl: '/assets/events/cat-exposicoes.jpg',
    iconType: 'trophy',
    eventCount: 7,
  },
];

export const INITIAL_EVENTS: EventItem[] = [
  {
    id: 'evt-rebaixados',
    slug: 'encontro-nacional-de-carros-rebaixados',
    title: 'Encontro Nacional de Carros Rebaixados',
    subtitle: 'Edição Oficial PX CUSTON — Projetos Rebaixados & Cultura Automotiva',
    categoryId: 'cat-carros',
    categoryName: 'Evento Automotivo',
    dateFormatted: '25/04/2025',
    dayNumber: '25',
    monthShort: 'ABR',
    year: '2025',
    timeRange: '10:00 às 22:00',
    city: 'São Paulo - SP',
    venueName: 'Arena Anhembi — Setor Automotivo Sul, São Paulo - SP',
    startingPrice: 40,
    bannerUrl: '/assets/events/event-gol-quadrado.jpg',
    cardImageUrl: '/assets/events/ev-rebaixados.jpg',
    galleryUrls: [
      '/assets/events/gallery-1.jpg',
      '/assets/events/gallery-2.jpg',
      '/assets/events/gallery-3.jpg',
      '/assets/events/gallery-4.jpg',
      '/assets/events/gallery-5.jpg',
    ],
    description:
      'O maior encontro de carros rebaixados do Brasil, reunindo projetos incríveis, experiências únicas e muita cultura automotiva.',
    highlights: [
      '+5.000 visitantes esperados',
      'Expositores e marcas',
      'Área de alimentação',
      'Estacionamento no local',
    ],
    status: 'Publicado',
    featured: true,
    ticketsSold: 1524,
    capacity: 2500,
    lots: [
      {
        id: 'lot-pista-1',
        eventId: 'evt-rebaixados',
        name: 'Pista (1º Lote Promocional)',
        categoryLabel: 'Pista',
        batchNumber: 1,
        description: 'Acesso geral ao evento',
        price: 40,
        totalQuantity: 1500,
        availableQuantity: 412,
        thumbnailUrl: '/assets/events/gallery-1.jpg',
        active: true,
      },
      {
        id: 'lot-vip-1',
        eventId: 'evt-rebaixados',
        name: 'VIP (1º Lote)',
        categoryLabel: 'VIP',
        batchNumber: 1,
        description: 'Área exclusiva + benefícios',
        price: 80,
        totalQuantity: 500,
        availableQuantity: 128,
        thumbnailUrl: '/assets/events/gallery-2.jpg',
        active: true,
      },
      {
        id: 'lot-expo-1',
        eventId: 'evt-rebaixados',
        name: 'Exposição de Veículos',
        categoryLabel: 'Expositor',
        batchNumber: 1,
        description: 'Para expositores e participantes (inclui 1 veículo + motorista)',
        price: 120,
        totalQuantity: 500,
        availableQuantity: 64,
        thumbnailUrl: '/assets/events/gallery-3.jpg',
        active: true,
      },
    ],
  },
  {
    id: 'evt-motofest',
    slug: 'moto-fest-brasil',
    title: 'Moto Fest Brasil',
    subtitle: 'Encontro Nacional de Motos Esportivas & Customizadas',
    categoryId: 'cat-motos',
    categoryName: 'Encontros de Motos',
    dateFormatted: '17/05/2025',
    dayNumber: '17',
    monthShort: 'MAI',
    year: '2025',
    timeRange: '11:00 às 23:00',
    city: 'Campinas - SP',
    venueName: 'Parque de Eventos Expo Dom Pedro, Campinas - SP',
    startingPrice: 30,
    bannerUrl: '/assets/events/pwa-moto.jpg',
    cardImageUrl: '/assets/events/ev-motofest.jpg',
    galleryUrls: [
      '/assets/events/ev-motofest.jpg',
      '/assets/events/pwa-moto.jpg',
      '/assets/events/gallery-3.jpg',
      '/assets/events/gallery-1.jpg',
      '/assets/events/gallery-4.jpg',
    ],
    description:
      'O ponto de encontro oficial para apaixonados por duas rodas. Exposição de superbikes, dinamômetro ao vivo, estandes de marcas e gastronomia.',
    highlights: [
      '+3.500 motociclistas esperados',
      'Bolsão exclusivo para motos',
      'Área de alimentação e shows',
      'Segurança monitorada no local',
    ],
    status: 'Publicado',
    featured: true,
    ticketsSold: 856,
    capacity: 1800,
    lots: [
      {
        id: 'lot-moto-pista',
        eventId: 'evt-motofest',
        name: 'Pista (1º Lote Promocional)',
        categoryLabel: 'Pista',
        batchNumber: 1,
        description: 'Acesso geral ao evento para pedestre',
        price: 30,
        totalQuantity: 1000,
        availableQuantity: 390,
        thumbnailUrl: '/assets/events/ev-motofest.jpg',
        active: true,
      },
      {
        id: 'lot-moto-vip',
        eventId: 'evt-motofest',
        name: 'Passaporte Piloto + Moto no Paddock',
        categoryLabel: 'VIP',
        batchNumber: 1,
        description: 'Acesso com moto ao setor interno + credencial exclusiva',
        price: 70,
        totalQuantity: 500,
        availableQuantity: 145,
        thumbnailUrl: '/assets/events/pwa-moto.jpg',
        active: true,
      },
    ],
  },
  {
    id: 'evt-tuningshow',
    slug: 'tuning-show',
    title: 'Tuning Show',
    subtitle: 'Mostra Brasileira de Customização, Som e Estética Automotiva',
    categoryId: 'cat-tuning',
    categoryName: 'Tuning e Customização',
    dateFormatted: '08/06/2025',
    dayNumber: '08',
    monthShort: 'JUN',
    year: '2025',
    timeRange: '10:00 às 22:00',
    city: 'Curitiba - PR',
    venueName: 'Centro de Eventos Positivo, Curitiba - PR',
    startingPrice: 50,
    bannerUrl: '/assets/events/ev-tuningshow.jpg',
    cardImageUrl: '/assets/events/ev-tuningshow.jpg',
    galleryUrls: [
      '/assets/events/ev-tuningshow.jpg',
      '/assets/events/gallery-2.jpg',
      '/assets/events/gallery-3.jpg',
      '/assets/events/gallery-4.jpg',
      '/assets/events/gallery-5.jpg',
    ],
    description:
      'Projetos de alto nível reunidos em Curitiba. Competição oficial de estética, iluminação full LED, envelopamento premium e rodas forjadas.',
    highlights: [
      '+180 carros selecionados no pavilhão',
      'Campeonato de customização',
      'Marcas de performance e estética',
      'Estacionamento pavimentado',
    ],
    status: 'Rascunho',
    featured: false,
    ticketsSold: 642,
    capacity: 1500,
    lots: [
      {
        id: 'lot-tuning-pista',
        eventId: 'evt-tuningshow',
        name: 'Pista (1º Lote)',
        categoryLabel: 'Pista',
        batchNumber: 1,
        description: 'Acesso completo ao pavilhão de exposição',
        price: 50,
        totalQuantity: 1000,
        availableQuantity: 510,
        thumbnailUrl: '/assets/events/ev-tuningshow.jpg',
        active: true,
      },
      {
        id: 'lot-tuning-vip',
        eventId: 'evt-tuningshow',
        name: 'VIP Lounge PX CUSTON',
        categoryLabel: 'VIP',
        batchNumber: 1,
        description: 'Vista privilegiada da arena + kit oficial',
        price: 110,
        totalQuantity: 300,
        availableQuantity: 98,
        thumbnailUrl: '/assets/events/gallery-2.jpg',
        active: true,
      },
    ],
  },
  {
    id: 'evt-speeddrift',
    slug: 'speed-e-drift',
    title: 'Speed & Drift',
    subtitle: 'Festival de Drift, Arrancada e Performance de Pista',
    categoryId: 'cat-performance',
    categoryName: 'Eventos de Performance',
    dateFormatted: '29/06/2025',
    dayNumber: '29',
    monthShort: 'JUN',
    year: '2025',
    timeRange: '09:00 às 20:00',
    city: 'Interlagos - SP',
    venueName: 'Autódromo de Interlagos — Setor Kartódromo & Box, São Paulo - SP',
    startingPrice: 70,
    bannerUrl: '/assets/events/ev-speeddrift.jpg',
    cardImageUrl: '/assets/events/ev-speeddrift.jpg',
    galleryUrls: [
      '/assets/events/ev-speeddrift.jpg',
      '/assets/events/gallery-4.jpg',
      '/assets/events/gallery-5.jpg',
      '/assets/events/gallery-1.jpg',
      '/assets/events/gallery-3.jpg',
    ],
    description:
      'Adrenalina máxima na pista! Baterias de drift com pilotos profissionais, exposição de carros preparados e visitação aos boxes.',
    highlights: [
      'Baterias oficiais de Drift',
      'Acesso opcional aos Boxes',
      'Simuladores e área gourmet',
      'Arquibancada coberta',
    ],
    status: 'Publicado',
    featured: true,
    ticketsSold: 487,
    capacity: 2000,
    lots: [
      {
        id: 'lot-drift-arquibancada',
        eventId: 'evt-speeddrift',
        name: 'Arquibancada (1º Lote)',
        categoryLabel: 'Pista',
        batchNumber: 1,
        description: 'Acesso às arquibancadas e feira automotiva',
        price: 70,
        totalQuantity: 1200,
        availableQuantity: 820,
        thumbnailUrl: '/assets/events/ev-speeddrift.jpg',
        active: true,
      },
      {
        id: 'lot-drift-paddock',
        eventId: 'evt-speeddrift',
        name: 'Paddock & Visitação de Box',
        categoryLabel: 'VIP',
        batchNumber: 1,
        description: 'Acesso direto aos boxes dos carros de Drift + arquibancada',
        price: 150,
        totalQuantity: 400,
        availableQuantity: 193,
        thumbnailUrl: '/assets/events/gallery-4.jpg',
        active: true,
      },
    ],
  },
];

export const INITIAL_TICKETS: Ticket[] = [
  {
    id: 'tkt-01',
    code: 'PX-784592',
    qrPayload: 'PXCUSTON|PX-784592|EVT-REBAIXADOS|PISTA',
    orderId: 'ORD-2025-001',
    paymentId: 'MP-884920192',
    userId: 'usr-joao',
    holderName: 'João da Silva',
    holderCpf: '123.456.789-00',
    eventId: 'evt-rebaixados',
    eventTitle: 'Encontro Nacional de Carros Rebaixados',
    eventDate: '25/04/2025',
    eventLocation: 'São Paulo - SP',
    eventImageUrl: '/assets/events/ev-rebaixados.jpg',
    ticketTypeId: 'lot-pista-1',
    ticketTypeName: 'Pista (1º Lote Promocional)',
    pricePaid: 40,
    status: 'paid',
    issuedAt: '10/04/2025 14:15',
  },
  {
    id: 'tkt-02',
    code: 'PX-784593',
    qrPayload: 'PXCUSTON|PX-784593|EVT-REBAIXADOS|VIP',
    orderId: 'ORD-2025-001',
    paymentId: 'MP-884920192',
    userId: 'usr-joao',
    holderName: 'João da Silva',
    holderCpf: '123.456.789-00',
    eventId: 'evt-rebaixados',
    eventTitle: 'Encontro Nacional de Carros Rebaixados',
    eventDate: '25/04/2025',
    eventLocation: 'São Paulo - SP',
    eventImageUrl: '/assets/events/ev-rebaixados.jpg',
    ticketTypeId: 'lot-vip-1',
    ticketTypeName: 'VIP (1º Lote)',
    pricePaid: 80,
    status: 'paid',
    issuedAt: '10/04/2025 14:15',
  },
  {
    id: 'tkt-03',
    code: 'PX-619204',
    qrPayload: 'PXCUSTON|PX-619204|EVT-MOTOFEST|PISTA',
    orderId: 'ORD-2025-002',
    paymentId: 'MP-773819200',
    userId: 'usr-joao',
    holderName: 'João da Silva',
    holderCpf: '123.456.789-00',
    eventId: 'evt-motofest',
    eventTitle: 'Moto Fest Brasil',
    eventDate: '17/05/2025',
    eventLocation: 'Campinas - SP',
    eventImageUrl: '/assets/events/ev-motofest.jpg',
    ticketTypeId: 'lot-moto-pista',
    ticketTypeName: 'Pista (1º Lote Promocional)',
    pricePaid: 30,
    status: 'used',
    usedAt: '17/05/2025 12:18',
    usedByOperator: 'Carlos Souza',
    issuedAt: '02/05/2025 09:40',
  },
];

export const INITIAL_ORDERS: Order[] = [
  {
    id: 'ORD-2025-001',
    orderCode: '#PX-90421',
    userId: 'usr-joao',
    buyerName: 'João da Silva',
    buyerCpf: '123.456.789-00',
    buyerEmail: 'joao@email.com',
    buyerPhone: '(11) 98765-4321',
    eventId: 'evt-rebaixados',
    eventTitle: 'Encontro Nacional de Carros Rebaixados',
    eventDate: '25/04/2025',
    eventLocation: 'São Paulo - SP',
    items: [
      {
        id: 'item-1',
        lotId: 'lot-pista-1',
        lotName: 'Pista (1º Lote Promocional)',
        unitPrice: 40,
        quantity: 2,
        subtotal: 80,
      },
    ],
    subtotal: 80,
    convenienceFee: 4.8,
    totalAmount: 84.8,
    paymentMethod: 'pix',
    status: 'paid',
    mpPreferenceId: 'MP-PREF-2025-001',
    mpPaymentId: 'MP-884920192',
    createdAt: '10/04/2025 14:12',
  },
  {
    id: 'ORD-2025-002',
    orderCode: '#PX-88310',
    userId: 'usr-joao',
    buyerName: 'João da Silva',
    buyerCpf: '123.456.789-00',
    buyerEmail: 'joao@email.com',
    buyerPhone: '(11) 98765-4321',
    eventId: 'evt-motofest',
    eventTitle: 'Moto Fest Brasil',
    eventDate: '17/05/2025',
    eventLocation: 'Campinas - SP',
    items: [
      {
        id: 'item-2',
        lotId: 'lot-moto-pista',
        lotName: 'Pista (1º Lote Promocional)',
        unitPrice: 30,
        quantity: 1,
        subtotal: 30,
      },
    ],
    subtotal: 30,
    convenienceFee: 1.8,
    totalAmount: 31.8,
    paymentMethod: 'credit_card',
    status: 'paid',
    mpPreferenceId: 'MP-PREF-2025-002',
    mpPaymentId: 'MP-773819200',
    createdAt: '02/05/2025 09:38',
  },
];

export const INITIAL_CHECKINS: CheckinRecord[] = [
  {
    id: 'CHK-1001',
    ticketId: 'tkt-01',
    ticketCode: 'PX-784592',
    eventTitle: 'Encontro Nacional de Carros Rebaixados',
    holderName: 'João da Silva',
    categoryName: 'Pista (1º Lote)',
    checkedInAt: '25/04/2025 14:32',
    operatorName: 'Carlos Souza',
    deviceId: 'PORTARIA-01-ANDROID',
    result: 'authorized',
    message: 'Entrada autorizada!',
  },
  {
    id: 'CHK-1000',
    ticketId: 'tkt-99',
    ticketCode: 'PX-551029',
    eventTitle: 'Encontro Nacional de Carros Rebaixados',
    holderName: 'Rafael Oliveira',
    categoryName: 'Exposição de Veículos',
    checkedInAt: '25/04/2025 14:28',
    operatorName: 'Carlos Souza',
    deviceId: 'PORTARIA-01-ANDROID',
    result: 'authorized',
    message: 'Entrada autorizada!',
  },
];

export const INITIAL_CUSTOMERS: Profile[] = [
  {
    id: 'usr-joao',
    fullName: 'João da Silva',
    cpf: '123.456.789-00',
    email: 'joao@email.com',
    phone: '(11) 98765-4321',
    city: 'São Paulo - SP',
    role: 'customer',
    createdAt: '12/01/2025',
  },
  {
    id: 'usr-rafael',
    fullName: 'Rafael Oliveira',
    cpf: '298.441.098-12',
    email: 'rafael.turbo@email.com',
    phone: '(19) 99214-8810',
    city: 'Campinas - SP',
    role: 'customer',
    createdAt: '04/02/2025',
  },
  {
    id: 'usr-carlos',
    fullName: 'Carlos Souza',
    cpf: '341.882.190-44',
    email: 'carlos.checkin@pxcuston.com.br',
    phone: '(11) 97112-3309',
    city: 'São Paulo - SP',
    role: 'checkin_operator',
    createdAt: '10/01/2025',
  },
  {
    id: 'usr-admin',
    fullName: 'Diretoria PX CUSTON',
    cpf: '019.283.746-55',
    email: 'admin@pxcuston.com.br',
    phone: '(11) 99999-0001',
    city: 'São Paulo - SP',
    role: 'SUPER_ADMIN',
    createdAt: '01/01/2025',
  },
];

export const INITIAL_AUDIT_LOGS: AuditLogEntry[] = [
  {
    id: 'LOG-01',
    actorName: 'Carlos Souza',
    actorRole: 'checkin_operator',
    action: 'Validação de QR Code na Portaria Principal (PX-784592)',
    targetEntity: 'checkins',
    timestamp: '25/04/2025 14:32',
  },
  {
    id: 'LOG-02',
    actorName: 'Diretoria PX CUSTON',
    actorRole: 'SUPER_ADMIN',
    action: 'Atualização de lote promocional: Encontro Nacional de Carros Rebaixados',
    targetEntity: 'ticket_types',
    timestamp: '24/04/2025 19:10',
  },
  {
    id: 'LOG-03',
    actorName: 'Webhook Mercado Pago',
    actorRole: 'admin',
    action: 'Confirmação oficial de pagamento Pix (MP-884920192) -> Emissão de ingresso',
    targetEntity: 'payments / tickets',
    timestamp: '10/04/2025 14:15',
  },
];

const PT_BR_MONTH_SHORT = [
  'JAN',
  'FEV',
  'MAR',
  'ABR',
  'MAI',
  'JUN',
  'JUL',
  'AGO',
  'SET',
  'OUT',
  'NOV',
  'DEZ',
];

/**
 * Maps a PostgreSQL event row + its categories and batches (from 001_initial_schema.sql)
 * into the UI EventItem structure without breaking existing components.
 */
export function mapDbEventToEventItem(
  row: DbEventRow,
  categories: DbTicketCategoryRow[] = [],
  batches: DbTicketBatchRow[] = []
): EventItem {
  const startDate = new Date(row.event_date);
  const isValidDate = !Number.isNaN(startDate.getTime());

  const dayNumber = isValidDate ? String(startDate.getUTCDate()).padStart(2, '0') : '01';
  const monthIndex = isValidDate ? startDate.getUTCMonth() : 0;
  const year = isValidDate ? String(startDate.getUTCFullYear()) : '2025';
  const monthNumeric = String(monthIndex + 1).padStart(2, '0');

  const categoryById = new Map<string, DbTicketCategoryRow>();
  for (const cat of categories) {
    categoryById.set(cat.id, cat);
  }

  const mappedLots: TicketLot[] = batches.map((batch) => {
    const parentCategory = categoryById.get(batch.category_id);
    const available = Math.max(
      0,
      batch.total_quantity - batch.reserved_quantity - batch.sold_quantity
    );
    return {
      id: batch.id,
      eventId: batch.event_id,
      ticketCategoryId: batch.category_id,
      name: batch.name,
      categoryLabel: parentCategory?.name ?? 'Ingresso',
      batchNumber: batch.batch_number,
      description: batch.description ?? parentCategory?.description ?? '',
      price: Number(batch.price),
      serviceFeeRate: CONVENIENCE_FEE_RATE,
      totalQuantity: batch.total_quantity,
      reservedQuantity: batch.reserved_quantity,
      soldQuantity: batch.sold_quantity,
      availableQuantity: available,
      maxPerOrder: parentCategory?.max_per_order ?? 10,
      thumbnailUrl: batch.thumbnail_url || row.card_image_url,
      active: batch.active,
    };
  });

  const statusMap: Record<DbEventRow['status'], EventItem['status']> = {
    published: 'Publicado',
    draft: 'Rascunho',
    ended: 'Encerrado',
    cancelled: 'Encerrado',
  };

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle ?? '',
    categoryId: row.category_slug,
    categoryName: row.category_name,
    dateFormatted: `${dayNumber}/${monthNumeric}/${year}`,
    dayNumber,
    monthShort: PT_BR_MONTH_SHORT[monthIndex] ?? 'JAN',
    year,
    timeRange: row.time_range,
    city: row.city,
    venueName: row.venue_name,
    startingPrice: Number(row.starting_price),
    bannerUrl: row.banner_url,
    cardImageUrl: row.card_image_url,
    galleryUrls: Array.isArray(row.gallery_urls) ? row.gallery_urls : [],
    description: row.description,
    highlights: Array.isArray(row.highlights) ? row.highlights : [],
    status: statusMap[row.status] ?? 'Rascunho',
    featured: row.featured,
    ticketsSold: row.tickets_sold,
    capacity: row.capacity,
    lots: mappedLots,
  };
}

/**
 * Calls the transactional PostgreSQL function `public.reserve_ticket_order`
 * defined in `supabase/migrations/002_rpc_contracts_permissions_idempotency.sql`.
 * - Requires an active authenticated user session (`supabase.auth.getUser()`).
 * - Never sends client-side prices; all prices and totals are calculated in PostgreSQL.
 * - Parses the returned JSONB (`order_id`, `order_code`, `unit_price`, `subtotal`,
 *   `convenience_fee`, `total_amount`, `reservation_expires_at`).
 */
export async function reserveOrderInSupabase(params: {
  ticketBatchId: string;
  quantity: number;
  buyerName: string;
  buyerCpf: string;
  buyerEmail: string;
  buyerPhone: string;
  paymentMethod: PaymentMethodType;
}): Promise<{
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
}> {
  if (!supabase) {
    return {
      ok: false,
      errorMessage: 'Cliente Supabase não configurado no ambiente atual.',
    };
  }

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData?.user?.id) {
    return {
      ok: false,
      errorMessage: 'Autenticação obrigatória para reservar ingressos.',
    };
  }

  const built = buildReserveOrderRpcArgs({
    authenticatedUserId: authData.user.id,
    ticketBatchId: params.ticketBatchId,
    quantity: params.quantity,
    buyerName: params.buyerName,
    buyerCpf: params.buyerCpf,
    buyerEmail: params.buyerEmail,
    buyerPhone: params.buyerPhone,
    paymentMethod: params.paymentMethod,
  });

  if (!built.ok) {
    return {
      ok: false,
      errorMessage: built.errorMessage,
    };
  }

  const { data, error } = await supabase.rpc('reserve_ticket_order', built.args);

  if (error) {
    return {
      ok: false,
      errorMessage: error.message,
    };
  }

  return normalizeReserveOrderRpcResponse(data);
}

/**
 * Fetches orders belonging exclusively to the currently authenticated user.
 * Enforces both client-side `.eq('user_id', user.id)` and PostgreSQL RLS (`auth.uid() = user_id`).
 */
export async function fetchOwnOrdersFromSupabase(): Promise<{
  ok: boolean;
  orders: DbOrderRow[];
  errorMessage?: string;
}> {
  if (!supabase) {
    return {
      ok: false,
      orders: [],
      errorMessage: 'Cliente Supabase não configurado.',
    };
  }

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData?.user?.id) {
    return {
      ok: false,
      orders: [],
      errorMessage: 'Sessão autenticada obrigatória para consultar pedidos.',
    };
  }

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return {
      ok: false,
      orders: [],
      errorMessage: error.message,
    };
  }

  return {
    ok: true,
    orders: (data as DbOrderRow[]) ?? [],
  };
}

/**
 * Calls the transactional PostgreSQL function `public.perform_ticket_checkin`
 * defined in `supabase/migrations/002_rpc_contracts_permissions_idempotency.sql`.
 * - Rejects anonymous callers before hitting the network (`supabase.auth.getUser()`).
 * - Normalizes both `result`/`status_reason` and `ticket_code`/`code`.
 */
export async function performCheckinInSupabase(params: {
  codeOrPayload: string;
  deviceId?: string;
}): Promise<{
  ok: boolean;
  authorized: boolean;
  result: 'authorized' | 'already_used' | 'invalid' | 'unpaid';
  message: string;
  ticketId?: string;
  ticketCode?: string;
  holderName?: string;
  usedAt?: string;
}> {
  if (!supabase) {
    return {
      ok: false,
      authorized: false,
      result: 'invalid',
      message: 'Cliente Supabase não configurado.',
    };
  }

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData?.user?.id) {
    return {
      ok: false,
      authorized: false,
      result: 'invalid',
      message: 'Acesso negado: autenticação de operador obrigatória para realizar check-in.',
    };
  }

  const { data, error } = await supabase.rpc('perform_ticket_checkin', {
    p_code_or_payload: params.codeOrPayload,
    p_device_id: params.deviceId ?? 'PX-CONTROL-WEB',
  });

  if (error) {
    return {
      ok: false,
      authorized: false,
      result: 'invalid',
      message: error.message,
    };
  }

  return normalizeCheckinRpcResponse(data);
}
