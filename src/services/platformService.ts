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
  DbProfileRow,
  PaymentMethodType,
  OrderStatus,
  PaymentStatus,
  EventStatus,
  AdminEventFormInput,
  AdminSaveTicketBatchInput,
  AdminSaveTicketCategoryInput,
  CancelTicketOrderRpcPayload,
  RefundTicketOrderRpcPayload,
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
  mapDbProfileRowToProfile,
  buildSafeSignUpMetadata,
  evaluateAdminAccess,
  validateAndBuildEventWritePayload,
  mapUiEventStatusToDb,
  translateEventDatabaseError,
  translateBatchOrCategoryDatabaseError,
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

  const sortedCategories = [...categories]
    .filter((cat) => cat.active !== false)
    .sort((a, b) => (a.sort_order ?? 1) - (b.sort_order ?? 1));

  const categoryById = new Map<string, DbTicketCategoryRow>();
  for (const cat of sortedCategories) {
    categoryById.set(cat.id, cat);
  }

  const sortedBatches = [...batches]
    .filter((batch) => batch.active !== false)
    .sort((a, b) => {
      if (a.batch_number !== b.batch_number) {
        return a.batch_number - b.batch_number;
      }
      return Number(a.price) - Number(b.price);
    });

  const mappedLots: TicketLot[] = sortedBatches.map((batch) => {
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
    cancelled: 'Cancelado',
  };

  const matchedUiCategory = INITIAL_CATEGORIES.find(
    (cat) => cat.id === row.category_slug || cat.slug === row.category_slug
  );

  const rawStartingPrice = Number(row.starting_price);
  const resolvedStartingPrice =
    Number.isFinite(rawStartingPrice) && rawStartingPrice > 0
      ? rawStartingPrice
      : mappedLots.length > 0
      ? Math.min(...mappedLots.map((lot) => lot.price))
      : 0;

  const rawGallery = Array.isArray(row.gallery_urls) ? row.gallery_urls.filter(Boolean) : [];
  const resolvedGallery =
    rawGallery.length > 0
      ? rawGallery
      : [row.banner_url, row.card_image_url].filter((url): url is string => Boolean(url));

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle ?? '',
    categoryId: matchedUiCategory ? matchedUiCategory.id : row.category_slug,
    categoryName: row.category_name || matchedUiCategory?.name || 'Evento Automotivo',
    dateFormatted: `${dayNumber}/${monthNumeric}/${year}`,
    eventDateIso: row.event_date,
    dayNumber,
    monthShort: PT_BR_MONTH_SHORT[monthIndex] ?? 'JAN',
    year,
    timeRange: row.time_range,
    city: row.city,
    venueName: row.venue_name,
    startingPrice: resolvedStartingPrice,
    bannerUrl: row.banner_url,
    cardImageUrl: row.card_image_url,
    galleryUrls: resolvedGallery,
    description: row.description,
    highlights: Array.isArray(row.highlights) ? row.highlights : [],
    status: statusMap[row.status] ?? 'Rascunho',
    dbStatus: row.status,
    featured: Boolean(row.featured),
    ticketsSold: Number(row.tickets_sold ?? 0),
    capacity: Math.max(1, Number(row.capacity ?? 1)),
    lots: mappedLots,
  };
}

/**
 * Pure function that assembles the public catalog strictly from published `DbEventRow` records
 * and their active `DbTicketCategoryRow` and `DbTicketBatchRow` children.
 */
export function assemblePublishedEventsCatalog(
  eventRows: DbEventRow[],
  categoryRows: DbTicketCategoryRow[] = [],
  batchRows: DbTicketBatchRow[] = []
): EventItem[] {
  const publishedRows = eventRows
    .filter((row) => row.status === 'published')
    .sort((a, b) => a.event_date.localeCompare(b.event_date));

  const categoriesByEventId = new Map<string, DbTicketCategoryRow[]>();
  for (const cat of categoryRows) {
    if (cat.active === false) continue;
    const list = categoriesByEventId.get(cat.event_id) ?? [];
    list.push(cat);
    categoriesByEventId.set(cat.event_id, list);
  }

  const batchesByEventId = new Map<string, DbTicketBatchRow[]>();
  for (const batch of batchRows) {
    if (batch.active === false) continue;
    const list = batchesByEventId.get(batch.event_id) ?? [];
    list.push(batch);
    batchesByEventId.set(batch.event_id, list);
  }

  return publishedRows.map((eventRow) =>
    mapDbEventToEventItem(
      eventRow,
      categoriesByEventId.get(eventRow.id) ?? [],
      batchesByEventId.get(eventRow.id) ?? []
    )
  );
}

/**
 * Pure function that assembles the administrative catalog for PX CONTROL,
 * including all statuses (`draft`, `published`, `ended`, `cancelled`) sorted by `event_date` ASC.
 */
export function assembleAdminEventsCatalog(
  eventRows: DbEventRow[],
  categoryRows: DbTicketCategoryRow[] = [],
  batchRows: DbTicketBatchRow[] = []
): EventItem[] {
  const sortedRows = [...eventRows].sort((a, b) => {
    const dateCompare = a.event_date.localeCompare(b.event_date);
    if (dateCompare !== 0) return dateCompare;
    return (b.created_at ?? '').localeCompare(a.created_at ?? '');
  });

  const categoriesByEventId = new Map<string, DbTicketCategoryRow[]>();
  for (const cat of categoryRows) {
    if (cat.active === false) continue;
    const list = categoriesByEventId.get(cat.event_id) ?? [];
    list.push(cat);
    categoriesByEventId.set(cat.event_id, list);
  }

  const batchesByEventId = new Map<string, DbTicketBatchRow[]>();
  for (const batch of batchRows) {
    if (batch.active === false) continue;
    const list = batchesByEventId.get(batch.event_id) ?? [];
    list.push(batch);
    batchesByEventId.set(batch.event_id, list);
  }

  return sortedRows.map((eventRow) =>
    mapDbEventToEventItem(
      eventRow,
      categoriesByEventId.get(eventRow.id) ?? [],
      batchesByEventId.get(eventRow.id) ?? []
    )
  );
}

/**
 * Computes real event counts per category based on the loaded published events.
 */
export function computeCategoriesWithEventCounts(
  baseCategories: EventCategory[],
  publishedEvents: EventItem[]
): EventCategory[] {
  return baseCategories.map((cat) => {
    const count = publishedEvents.filter(
      (ev) => ev.categoryId === cat.id || ev.categoryId === cat.slug
    ).length;
    return {
      ...cat,
      eventCount: count,
    };
  });
}

/**
 * Queries published events (`status = 'published'`), active ticket categories, and active ticket
 * batches directly from Supabase.
 * Never falls back to mock data or masks database errors.
 */
export async function fetchPublishedEventsFromSupabase(): Promise<{
  ok: boolean;
  events: EventItem[];
  errorMessage?: string;
}> {
  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      ok: false,
      events: [],
      errorMessage: supabaseConfigState.reason,
    };
  }

  const { data: eventRows, error: eventsError } = await supabase
    .from('events')
    .select('*')
    .eq('status', 'published')
    .order('event_date', { ascending: true });

  if (eventsError) {
    return {
      ok: false,
      events: [],
      errorMessage: `Não foi possível carregar os eventos publicados do Supabase: ${eventsError.message}`,
    };
  }

  const typedEvents = (eventRows as DbEventRow[]) ?? [];
  if (typedEvents.length === 0) {
    return {
      ok: true,
      events: [],
    };
  }

  const eventIds = typedEvents.map((ev) => ev.id);

  const [categoriesResult, batchesResult] = await Promise.all([
    supabase
      .from('ticket_categories')
      .select('*')
      .in('event_id', eventIds)
      .eq('active', true)
      .order('sort_order', { ascending: true }),
    supabase
      .from('ticket_batches')
      .select('*')
      .in('event_id', eventIds)
      .eq('active', true)
      .order('batch_number', { ascending: true }),
  ]);

  if (categoriesResult.error) {
    return {
      ok: false,
      events: [],
      errorMessage: `Erro ao carregar categorias de ingressos do Supabase: ${categoriesResult.error.message}`,
    };
  }

  if (batchesResult.error) {
    return {
      ok: false,
      events: [],
      errorMessage: `Erro ao carregar lotes de ingressos do Supabase: ${batchesResult.error.message}`,
    };
  }

  const assembled = assemblePublishedEventsCatalog(
    typedEvents,
    (categoriesResult.data as DbTicketCategoryRow[]) ?? [],
    (batchesResult.data as DbTicketBatchRow[]) ?? []
  );

  return {
    ok: true,
    events: assembled,
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

/**
 * Fetches the authenticated user's profile from `public.profiles` and verifies
 * administrative authorization via `public.is_admin_or_super_admin()`.
 * Never trusts client-provided userId or role without verifying the active Supabase Auth session.
 */
export async function fetchAuthenticatedUserProfileFromSupabase(expectedUserId?: string): Promise<{
  ok: boolean;
  authenticatedUserId: string | null;
  email: string | null;
  profile: Profile | null;
  serverAdminConfirmed: boolean | null;
  errorMessage: string | null;
}> {
  if (!supabase) {
    return {
      ok: false,
      authenticatedUserId: null,
      email: null,
      profile: null,
      serverAdminConfirmed: null,
      errorMessage: 'Cliente Supabase não configurado no ambiente atual.',
    };
  }

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData?.user?.id) {
    return {
      ok: false,
      authenticatedUserId: null,
      email: null,
      profile: null,
      serverAdminConfirmed: null,
      errorMessage: authError?.message ?? null,
    };
  }

  const user = authData.user;
  if (expectedUserId && expectedUserId.trim() !== user.id) {
    return {
      ok: false,
      authenticatedUserId: user.id,
      email: user.email ?? null,
      profile: null,
      serverAdminConfirmed: false,
      errorMessage: 'Inconsistência de sessão detectada ao verificar o usuário autenticado.',
    };
  }

  const [profileQuery, adminRpc] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, full_name, cpf, email, phone, city, role, created_at, updated_at')
      .eq('id', user.id)
      .maybeSingle(),
    supabase.rpc('is_admin_or_super_admin'),
  ]);

  const serverAdminConfirmed =
    !adminRpc.error && typeof adminRpc.data === 'boolean' ? adminRpc.data : null;

  if (profileQuery.error) {
    return {
      ok: false,
      authenticatedUserId: user.id,
      email: user.email ?? null,
      profile: null,
      serverAdminConfirmed,
      errorMessage: `Não foi possível consultar o perfil em public.profiles: ${profileQuery.error.message}`,
    };
  }

  if (!profileQuery.data) {
    return {
      ok: false,
      authenticatedUserId: user.id,
      email: user.email ?? null,
      profile: null,
      serverAdminConfirmed,
      errorMessage:
        'Sua conta está autenticada, mas o registro correspondente em public.profiles não foi encontrado.',
    };
  }

  const mappedProfile = mapDbProfileRowToProfile(profileQuery.data as DbProfileRow);
  return {
    ok: true,
    authenticatedUserId: user.id,
    email: user.email ?? mappedProfile.email,
    profile: mappedProfile,
    serverAdminConfirmed,
    errorMessage: null,
  };
}

/**
 * Authenticates a user with email & password via `supabase.auth.signInWithPassword`
 * and loads their authoritative `public.profiles` row.
 */
export async function signInWithSupabasePassword(
  email: string,
  password: string
): Promise<{
  ok: boolean;
  authenticatedUserId: string | null;
  email: string | null;
  profile: Profile | null;
  serverAdminConfirmed: boolean | null;
  errorMessage?: string;
}> {
  if (!supabase) {
    return {
      ok: false,
      authenticatedUserId: null,
      email: null,
      profile: null,
      serverAdminConfirmed: null,
      errorMessage: 'Cliente Supabase não configurado no ambiente atual.',
    };
  }

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail.includes('@') || !password) {
    return {
      ok: false,
      authenticatedUserId: null,
      email: null,
      profile: null,
      serverAdminConfirmed: null,
      errorMessage: 'Informe um e-mail válido e sua senha para autenticar.',
    };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: cleanEmail,
    password,
  });

  if (error || !data?.user) {
    return {
      ok: false,
      authenticatedUserId: null,
      email: null,
      profile: null,
      serverAdminConfirmed: null,
      errorMessage:
        error?.message === 'Invalid login credentials'
          ? 'Credenciais inválidas. Verifique seu e-mail e senha.'
          : error?.message ?? 'Não foi possível autenticar no Supabase Auth.',
    };
  }

  const profileCheck = await fetchAuthenticatedUserProfileFromSupabase(data.user.id);
  return {
    ok: true,
    authenticatedUserId: data.user.id,
    email: data.user.email ?? cleanEmail,
    profile: profileCheck.profile,
    serverAdminConfirmed: profileCheck.serverAdminConfirmed,
    errorMessage: profileCheck.errorMessage ?? undefined,
  };
}

/**
 * Registers a new customer account via `supabase.auth.signUp()`.
 * - Uses `buildSafeSignUpMetadata` so public registration never sends `role` or privileges.
 * - Respects Supabase email confirmation settings: detects whether an active session was
 *   returned immediately (`requiresEmailConfirmation: false`) or if email confirmation is
 *   pending (`requiresEmailConfirmation: true`).
 */
export async function signUpWithSupabase(input: {
  fullName: string;
  cpf: string;
  email: string;
  phone: string;
  city?: string;
  password: string;
}): Promise<{
  ok: boolean;
  requiresEmailConfirmation: boolean;
  authenticatedUserId: string | null;
  email: string | null;
  profile: Profile | null;
  message: string;
}> {
  if (!supabase) {
    return {
      ok: false,
      requiresEmailConfirmation: false,
      authenticatedUserId: null,
      email: null,
      profile: null,
      message: 'Cliente Supabase não configurado no ambiente atual.',
    };
  }

  const built = buildSafeSignUpMetadata(input);
  if (!built.ok) {
    return {
      ok: false,
      requiresEmailConfirmation: false,
      authenticatedUserId: null,
      email: null,
      profile: null,
      message: built.errorMessage,
    };
  }

  const { data, error } = await supabase.auth.signUp({
    email: built.sanitizedEmail,
    password: input.password,
    options: {
      data: built.metadata,
    },
  });

  if (error || !data?.user) {
    return {
      ok: false,
      requiresEmailConfirmation: false,
      authenticatedUserId: null,
      email: null,
      profile: null,
      message: error?.message ?? 'Não foi possível concluir o cadastro no Supabase Auth.',
    };
  }

  const requiresEmailConfirmation = Boolean(data.user && !data.session);

  if (requiresEmailConfirmation) {
    return {
      ok: true,
      requiresEmailConfirmation: true,
      authenticatedUserId: data.user.id,
      email: data.user.email ?? built.sanitizedEmail,
      profile: null,
      message:
        'Cadastro realizado com sucesso! Verifique sua caixa de entrada e confirme seu e-mail para ativar o acesso à sua conta.',
    };
  }

  const profileCheck = await fetchAuthenticatedUserProfileFromSupabase(data.user.id);
  return {
    ok: true,
    requiresEmailConfirmation: false,
    authenticatedUserId: data.user.id,
    email: data.user.email ?? built.sanitizedEmail,
    profile: profileCheck.profile,
    message: 'Cadastro concluído e sessão autenticada com sucesso!',
  };
}

/**
 * Sends a password reset email via `supabase.auth.resetPasswordForEmail()`.
 */
export async function requestPasswordResetInSupabase(email: string): Promise<{
  ok: boolean;
  message: string;
}> {
  if (!supabase) {
    return {
      ok: false,
      message: 'Cliente Supabase não configurado no ambiente atual.',
    };
  }

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail.includes('@')) {
    return {
      ok: false,
      message: 'Informe um e-mail válido para receber as instruções de recuperação.',
    };
  }

  const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail);
  if (error) {
    return {
      ok: false,
      message: `Não foi possível enviar o e-mail de recuperação: ${error.message}`,
    };
  }

  return {
    ok: true,
    message: `Se houver uma conta associada a ${cleanEmail}, você receberá um link seguro para redefinir sua senha.`,
  };
}

/**
 * Signs out the current user session via `supabase.auth.signOut()`.
 */
export async function signOutFromSupabase(): Promise<{
  ok: boolean;
  errorMessage?: string;
}> {
  if (!supabase) {
    return {
      ok: false,
      errorMessage: 'Cliente Supabase não configurado.',
    };
  }

  const { error } = await supabase.auth.signOut();
  if (error) {
    return {
      ok: false,
      errorMessage: error.message,
    };
  }

  return { ok: true };
}

/**
 * Internal helper that verifies the active Supabase Auth session and `public.profiles` role
 * (`admin` or `SUPER_ADMIN`) before executing any administrative query or mutation on `public.events`.
 */
async function verifyAuthorizedAdminSession(): Promise<
  | {
      ok: true;
      authenticatedUserId: string;
      profile: Profile;
    }
  | {
      ok: false;
      errorMessage: string;
    }
> {
  const sessionCheck = await fetchAuthenticatedUserProfileFromSupabase();
  const access = evaluateAdminAccess({
    authenticatedUserId: sessionCheck.authenticatedUserId,
    profile: sessionCheck.profile,
    profileError: sessionCheck.errorMessage,
    serverAdminConfirmed: sessionCheck.serverAdminConfirmed,
  });

  if (!access.allowed || !sessionCheck.authenticatedUserId || !sessionCheck.profile) {
    return {
      ok: false,
      errorMessage: access.message,
    };
  }

  return {
    ok: true,
    authenticatedUserId: sessionCheck.authenticatedUserId,
    profile: sessionCheck.profile,
  };
}

/**
 * Fetches all administrative events (including `draft`, `published`, `ended`, `cancelled`)
 * from `public.events` in Supabase for PX CONTROL.
 * Requires an authenticated administrator session (`admin` or `SUPER_ADMIN`) and respects RLS.
 */
export async function fetchAdminEventsFromSupabase(): Promise<{
  ok: boolean;
  events: EventItem[];
  errorMessage?: string;
}> {
  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      ok: false,
      events: [],
      errorMessage: supabaseConfigState.reason,
    };
  }

  const adminCheck = await verifyAuthorizedAdminSession();
  if (!adminCheck.ok) {
    return {
      ok: false,
      events: [],
      errorMessage: adminCheck.errorMessage,
    };
  }

  const { data: eventRows, error: eventsError } = await supabase
    .from('events')
    .select('*')
    .order('event_date', { ascending: true });

  if (eventsError) {
    return {
      ok: false,
      events: [],
      errorMessage: translateEventDatabaseError(eventsError, 'fetch'),
    };
  }

  const typedEvents = (eventRows as DbEventRow[]) ?? [];
  if (typedEvents.length === 0) {
    return {
      ok: true,
      events: [],
    };
  }

  const eventIds = typedEvents.map((ev) => ev.id);

  const [categoriesResult, batchesResult] = await Promise.all([
    supabase
      .from('ticket_categories')
      .select('*')
      .in('event_id', eventIds)
      .order('sort_order', { ascending: true }),
    supabase
      .from('ticket_batches')
      .select('*')
      .in('event_id', eventIds)
      .order('batch_number', { ascending: true }),
  ]);

  if (categoriesResult.error) {
    return {
      ok: false,
      events: [],
      errorMessage: `Erro ao consultar categorias de ingressos: ${categoriesResult.error.message}`,
    };
  }

  if (batchesResult.error) {
    return {
      ok: false,
      events: [],
      errorMessage: `Erro ao consultar lotes de ingressos: ${batchesResult.error.message}`,
    };
  }

  return {
    ok: true,
    events: assembleAdminEventsCatalog(
      typedEvents,
      (categoriesResult.data as DbTicketCategoryRow[]) ?? [],
      (batchesResult.data as DbTicketBatchRow[]) ?? []
    ),
  };
}

/**
 * Creates a new event in `public.events` on Supabase.
 * - Verifies active admin session (`admin` / `SUPER_ADMIN`).
 * - Validates all required fields, slug uniqueness, and ISO date format (`YYYY-MM-DD`).
 * - Never invents fake batches (`lots: []`).
 */
export async function createEventInSupabase(
  input: AdminEventFormInput,
  existingEvents: Array<{ id: string; slug: string }> = []
): Promise<{
  ok: boolean;
  event?: EventItem;
  errorMessage?: string;
  fieldErrors?: Record<string, string>;
}> {
  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      ok: false,
      errorMessage: supabaseConfigState.reason,
    };
  }

  const adminCheck = await verifyAuthorizedAdminSession();
  if (!adminCheck.ok) {
    return {
      ok: false,
      errorMessage: adminCheck.errorMessage,
    };
  }

  const validation = validateAndBuildEventWritePayload(input, {
    existingEvents,
    categories: INITIAL_CATEGORIES,
  });

  if (!validation.ok) {
    return {
      ok: false,
      errorMessage: validation.errorMessage,
      fieldErrors: validation.fieldErrors,
    };
  }

  const p = validation.payload;
  const rpcResult = await supabase.rpc('admin_create_event', {
    p_slug: p.slug,
    p_title: p.title,
    p_subtitle: p.subtitle,
    p_category_slug: p.category_slug,
    p_category_name: p.category_name,
    p_event_date: p.event_date,
    p_time_range: p.time_range,
    p_city: p.city,
    p_venue_name: p.venue_name,
    p_starting_price: p.starting_price,
    p_banner_url: p.banner_url,
    p_card_image_url: p.card_image_url,
    p_gallery_urls: p.gallery_urls,
    p_description: p.description,
    p_highlights: p.highlights,
    p_status: p.status,
    p_featured: p.featured,
    p_capacity: p.capacity,
  });

  if (rpcResult.error || !rpcResult.data) {
    return {
      ok: false,
      errorMessage: translateEventDatabaseError(
        rpcResult.error ?? {
          message:
            'Nenhum registro foi retornado por public.admin_create_event. Verifique se a migration 002 está aplicada e se sua conta possui permissão administrativa.',
        },
        'create'
      ),
    };
  }

  return {
    ok: true,
    event: mapDbEventToEventItem(rpcResult.data as DbEventRow, [], []),
  };
}

/**
 * Updates an existing event in `public.events` on Supabase exclusively via `public.admin_update_event`.
 * - Verifies active admin session (`admin` / `SUPER_ADMIN`).
 * - Validates all required fields, capacity >= tickets_sold + active_reservations, slug uniqueness, and ISO date format (`YYYY-MM-DD`).
 * - No fallback to direct `.from('events').update(...)`.
 */
export async function updateEventInSupabase(
  eventId: string,
  input: AdminEventFormInput,
  existingEvents: Array<{ id: string; slug: string }> = []
): Promise<{
  ok: boolean;
  event?: EventItem;
  errorMessage?: string;
  fieldErrors?: Record<string, string>;
}> {
  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      ok: false,
      errorMessage: supabaseConfigState.reason,
    };
  }

  const cleanEventId = (eventId ?? '').trim();
  if (!cleanEventId) {
    return {
      ok: false,
      errorMessage: 'ID do evento inválido para atualização.',
    };
  }

  const adminCheck = await verifyAuthorizedAdminSession();
  if (!adminCheck.ok) {
    return {
      ok: false,
      errorMessage: adminCheck.errorMessage,
    };
  }

  const validation = validateAndBuildEventWritePayload(
    { ...input, id: cleanEventId },
    {
      existingEvents,
      categories: INITIAL_CATEGORIES,
    }
  );

  if (!validation.ok) {
    return {
      ok: false,
      errorMessage: validation.errorMessage,
      fieldErrors: validation.fieldErrors,
    };
  }

  const p = validation.payload;
  const rpcResult = await supabase.rpc('admin_update_event', {
    p_event_id: cleanEventId,
    p_slug: p.slug,
    p_title: p.title,
    p_subtitle: p.subtitle,
    p_category_slug: p.category_slug,
    p_category_name: p.category_name,
    p_event_date: p.event_date,
    p_time_range: p.time_range,
    p_city: p.city,
    p_venue_name: p.venue_name,
    p_starting_price: p.starting_price,
    p_banner_url: p.banner_url,
    p_card_image_url: p.card_image_url,
    p_gallery_urls: p.gallery_urls,
    p_description: p.description,
    p_highlights: p.highlights,
    p_status: p.status,
    p_featured: p.featured,
    p_capacity: p.capacity,
  });

  if (rpcResult.error || !rpcResult.data) {
    return {
      ok: false,
      errorMessage: translateEventDatabaseError(
        rpcResult.error ?? {
          message:
            'Nenhum registro foi atualizado por public.admin_update_event. Verifique se o evento ainda existe, se a migration 002 está aplicada e se sua conta possui permissão administrativa.',
        },
        'update'
      ),
    };
  }

  return {
    ok: true,
    event: mapDbEventToEventItem(rpcResult.data as DbEventRow, [], []),
  };
}

/**
 * Publishes (`'published'`) or unpublishes (`'draft'`) an event in `public.events` on Supabase
 * exclusively via `public.admin_update_event_status` to guarantee canonical lock ordering (`px_event_inventory` -> `events FOR UPDATE`).
 */
export async function updateEventStatusInSupabase(
  eventId: string,
  nextStatus: EventStatus | DbEventRow['status']
): Promise<{
  ok: boolean;
  event?: EventItem;
  errorMessage?: string;
}> {
  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      ok: false,
      errorMessage: supabaseConfigState.reason,
    };
  }

  const cleanEventId = (eventId ?? '').trim();
  if (!cleanEventId) {
    return {
      ok: false,
      errorMessage: 'ID do evento inválido para alteração de status.',
    };
  }

  const adminCheck = await verifyAuthorizedAdminSession();
  if (!adminCheck.ok) {
    return {
      ok: false,
      errorMessage: adminCheck.errorMessage,
    };
  }

  const dbStatus = mapUiEventStatusToDb(nextStatus);

  const rpcResult = await supabase.rpc('admin_update_event_status', {
    p_event_id: cleanEventId,
    p_status: dbStatus,
  });

  if (rpcResult.error || !rpcResult.data) {
    return {
      ok: false,
      errorMessage: translateEventDatabaseError(
        rpcResult.error ?? {
          message:
            'Não foi possível alterar o status do evento via public.admin_update_event_status. Verifique se o evento existe, se a migration 002 está aplicada e se sua permissão administrativa está ativa.',
        },
        'status'
      ),
    };
  }

  return {
    ok: true,
    event: mapDbEventToEventItem(rpcResult.data as DbEventRow, [], []),
  };
}

/**
 * Deletes an event from `public.events` on Supabase exclusively via `public.admin_delete_event`
 * to guarantee canonical lock ordering (`px_event_inventory` -> `events FOR UPDATE` -> `ticket_batches (id ASC) FOR UPDATE`)
 * before `ON DELETE CASCADE` reaches `public.ticket_batches`.
 */
export async function deleteEventInSupabase(eventId: string): Promise<{
  ok: boolean;
  errorMessage?: string;
}> {
  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      ok: false,
      errorMessage: supabaseConfigState.reason,
    };
  }

  const cleanEventId = (eventId ?? '').trim();
  if (!cleanEventId) {
    return {
      ok: false,
      errorMessage: 'ID do evento inválido para exclusão.',
    };
  }

  const adminCheck = await verifyAuthorizedAdminSession();
  if (!adminCheck.ok) {
    return {
      ok: false,
      errorMessage: adminCheck.errorMessage,
    };
  }

  const rpcResult = await supabase.rpc('admin_delete_event', {
    p_event_id: cleanEventId,
  });

  if (rpcResult.error || !rpcResult.data) {
    return {
      ok: false,
      errorMessage: translateEventDatabaseError(
        rpcResult.error ?? {
          message:
            'O evento não pôde ser removido via public.admin_delete_event (registro não encontrado, RPC ausente ou exclusão bloqueada por permissão).',
        },
        'delete'
      ),
    };
  }

  return {
    ok: true,
  };
}

/**
 * Creates or updates a ticket batch in `public.ticket_batches` via the transactional RPC
 * `public.admin_save_ticket_batch`, which acquires `px_event_inventory` -> `events FOR UPDATE`
 * -> `ticket_batches (id ASC) FOR UPDATE` prior to `INSERT`/`UPDATE`.
 */
export async function saveTicketBatchInSupabase(
  input: AdminSaveTicketBatchInput
): Promise<{
  ok: boolean;
  batch?: DbTicketBatchRow;
  errorMessage?: string;
}> {
  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      ok: false,
      errorMessage: supabaseConfigState.reason,
    };
  }

  const adminCheck = await verifyAuthorizedAdminSession();
  if (!adminCheck.ok) {
    return {
      ok: false,
      errorMessage: adminCheck.errorMessage,
    };
  }

  const { data, error } = await supabase.rpc('admin_save_ticket_batch', {
    p_batch_id: input.id?.trim() ? input.id.trim() : null,
    p_event_id: input.eventId.trim(),
    p_category_id: input.categoryId.trim(),
    p_name: input.name.trim(),
    p_batch_number: input.batchNumber,
    p_description: input.description?.trim() ?? '',
    p_price: input.price,
    p_total_quantity: input.totalQuantity,
    p_thumbnail_url: input.thumbnailUrl ?? null,
    p_starts_at: input.startsAt ?? null,
    p_ends_at: input.endsAt ?? null,
    p_active: input.active ?? true,
  });

  if (error || !data) {
    return {
      ok: false,
      errorMessage: translateBatchOrCategoryDatabaseError(
        error ?? {
          message:
            'Nenhum registro foi retornado por public.admin_save_ticket_batch. Verifique se a migration 002 está aplicada e se sua conta possui permissão administrativa.',
        },
        'batch',
        'save'
      ),
    };
  }

  return {
    ok: true,
    batch: data as DbTicketBatchRow,
  };
}

/**
 * Deletes a ticket batch in `public.ticket_batches` via the transactional RPC
 * `public.admin_delete_ticket_batch` (which blocks deletion if any orders/tickets exist).
 */
export async function deleteTicketBatchInSupabase(batchId: string): Promise<{
  ok: boolean;
  errorMessage?: string;
}> {
  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      ok: false,
      errorMessage: supabaseConfigState.reason,
    };
  }

  const cleanBatchId = (batchId ?? '').trim();
  if (!cleanBatchId) {
    return {
      ok: false,
      errorMessage: 'ID do lote inválido para exclusão.',
    };
  }

  const adminCheck = await verifyAuthorizedAdminSession();
  if (!adminCheck.ok) {
    return {
      ok: false,
      errorMessage: adminCheck.errorMessage,
    };
  }

  const { data, error } = await supabase.rpc('admin_delete_ticket_batch', {
    p_batch_id: cleanBatchId,
  });

  if (error || !data) {
    return {
      ok: false,
      errorMessage: translateBatchOrCategoryDatabaseError(
        error ?? {
          message:
            'O lote não pôde ser removido via public.admin_delete_ticket_batch (registro não encontrado, RPC ausente ou exclusão bloqueada por permissão).',
        },
        'batch',
        'delete'
      ),
    };
  }

  return { ok: true };
}

/**
 * Creates or updates a ticket category in `public.ticket_categories` via the transactional RPC
 * `public.admin_save_ticket_category`, which acquires `px_event_inventory` -> `events FOR UPDATE`
 * -> `ticket_categories (id ASC) FOR UPDATE` -> `ticket_batches (id ASC) FOR UPDATE` prior to `INSERT`/`UPDATE`.
 */
export async function saveTicketCategoryInSupabase(
  input: AdminSaveTicketCategoryInput
): Promise<{
  ok: boolean;
  category?: DbTicketCategoryRow;
  errorMessage?: string;
}> {
  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      ok: false,
      errorMessage: supabaseConfigState.reason,
    };
  }

  const adminCheck = await verifyAuthorizedAdminSession();
  if (!adminCheck.ok) {
    return {
      ok: false,
      errorMessage: adminCheck.errorMessage,
    };
  }

  const { data, error } = await supabase.rpc('admin_save_ticket_category', {
    p_category_id: input.id?.trim() ? input.id.trim() : null,
    p_event_id: input.eventId.trim(),
    p_slug: input.slug.trim(),
    p_name: input.name.trim(),
    p_description: input.description?.trim() ? input.description.trim() : null,
    p_max_per_order: input.maxPerOrder ?? 10,
    p_sort_order: input.sortOrder ?? 1,
    p_active: input.active ?? true,
  });

  if (error || !data) {
    return {
      ok: false,
      errorMessage: translateBatchOrCategoryDatabaseError(
        error ?? {
          message:
            'Nenhum registro foi retornado por public.admin_save_ticket_category. Verifique se a migration 002 está aplicada e se sua conta possui permissão administrativa.',
        },
        'category',
        'save'
      ),
    };
  }

  return {
    ok: true,
    category: data as DbTicketCategoryRow,
  };
}

/**
 * Deletes a ticket category in `public.ticket_categories` via the transactional RPC
 * `public.admin_delete_ticket_category` (which blocks deletion if any batches have sales/reservations/orders or tickets).
 */
export async function deleteTicketCategoryInSupabase(categoryId: string): Promise<{
  ok: boolean;
  errorMessage?: string;
}> {
  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      ok: false,
      errorMessage: supabaseConfigState.reason,
    };
  }

  const cleanCategoryId = (categoryId ?? '').trim();
  if (!cleanCategoryId) {
    return {
      ok: false,
      errorMessage: 'ID da categoria inválido para exclusão.',
    };
  }

  const adminCheck = await verifyAuthorizedAdminSession();
  if (!adminCheck.ok) {
    return {
      ok: false,
      errorMessage: adminCheck.errorMessage,
    };
  }

  const { data, error } = await supabase.rpc('admin_delete_ticket_category', {
    p_category_id: cleanCategoryId,
  });

  if (error || !data) {
    return {
      ok: false,
      errorMessage: translateBatchOrCategoryDatabaseError(
        error ?? {
          message:
            'A categoria não pôde ser removida via public.admin_delete_ticket_category (registro não encontrado, RPC ausente ou exclusão bloqueada por permissão).',
        },
        'category',
        'delete'
      ),
    };
  }

  return { ok: true };
}

/**
 * Cancels an unpaid reservation (`reserved` or `pending_payment`) via `public.cancel_ticket_order`,
 * releasing `reserved_quantity` back to the batch while preserving the order record.
 */
export async function cancelOrderInSupabase(params: {
  orderId: string;
  reason?: string;
}): Promise<{
  ok: boolean;
  payload?: CancelTicketOrderRpcPayload;
  errorMessage?: string;
}> {
  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      ok: false,
      errorMessage: supabaseConfigState.reason,
    };
  }

  const cleanOrderId = (params.orderId ?? '').trim();
  if (!cleanOrderId) {
    return {
      ok: false,
      errorMessage: 'Identificador do pedido (orderId) é obrigatório para cancelamento.',
    };
  }

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData?.user?.id) {
    return {
      ok: false,
      errorMessage: 'Autenticação obrigatória para cancelar uma reserva.',
    };
  }

  const { data, error } = await supabase.rpc('cancel_ticket_order', {
    p_order_id: cleanOrderId,
    p_reason: params.reason?.trim() || null,
  });

  if (error || !data) {
    return {
      ok: false,
      errorMessage: error?.message ?? 'Não foi possível cancelar o pedido.',
    };
  }

  return {
    ok: true,
    payload: data as CancelTicketOrderRpcPayload,
  };
}

/**
 * Refunds a paid order in full (`paid -> refunded`) via `public.refund_ticket_order`.
 * Requires an authenticated administrator session (`admin` or `SUPER_ADMIN`), transitions all
 * issued tickets of the order to `status = 'refunded'` (blocking if any ticket is `'used'`),
 * and decrements `ticket_batches.sold_quantity` and `events.tickets_sold`.
 */
export async function refundOrderInSupabase(params: {
  orderId: string;
  mpPaymentId: string;
  reason?: string;
}): Promise<{
  ok: boolean;
  payload?: RefundTicketOrderRpcPayload;
  errorMessage?: string;
}> {
  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      ok: false,
      errorMessage: supabaseConfigState.reason,
    };
  }

  const cleanOrderId = (params.orderId ?? '').trim();
  const cleanMpPaymentId = (params.mpPaymentId ?? '').trim();
  if (!cleanOrderId || !cleanMpPaymentId) {
    return {
      ok: false,
      errorMessage:
        'Os identificadores do pedido (orderId) e do pagamento no Mercado Pago (mpPaymentId) são obrigatórios para o reembolso.',
    };
  }

  const adminCheck = await verifyAuthorizedAdminSession();
  if (!adminCheck.ok) {
    return {
      ok: false,
      errorMessage: adminCheck.errorMessage,
    };
  }

  const { data, error } = await supabase.rpc('refund_ticket_order', {
    p_order_id: cleanOrderId,
    p_mp_payment_id: cleanMpPaymentId,
    p_reason: params.reason?.trim() || null,
  });

  if (error || !data) {
    return {
      ok: false,
      errorMessage: error?.message ?? 'Não foi possível processar o reembolso do pedido.',
    };
  }

  return {
    ok: true,
    payload: data as RefundTicketOrderRpcPayload,
  };
}


