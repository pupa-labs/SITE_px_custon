import React, { useState, useRef, useEffect } from 'react';
import {
  LayoutDashboard,
  Calendar,
  Tags,
  Layers,
  Ticket as TicketIcon,
  ShoppingBag,
  CreditCard,
  Users,
  UserCheck,
  BarChart3,
  QrCode,
  Settings,
  Plus,
  Edit3,
  Trash2,
  CheckCircle2,
  XCircle,
  Search,
  History,
  Camera,
  CameraOff,
  TrendingUp,
  Eye,
  X,
  ShieldAlert,
  Lock,
  LogIn,
  LogOut,
  RefreshCw,
} from 'lucide-react';
import type {
  EventItem,
  EventCategory,
  Ticket,
  Order,
  CheckinRecord,
  Profile,
  AuditLogEntry,
  EventStatus,
  AdminAccessEvaluation,
  AdminEventFormInput,
  DbTicketCategoryRow,
  DbTicketBatchRow,
  AdminSaveTicketCategoryInput,
  AdminSaveTicketBatchInput,
  CancelTicketOrderRpcPayload,
  RefundTicketOrderRpcPayload,
} from '../types/domain';
import {
  formatBRL,
  generateEventSlug,
  validateAndBuildEventWritePayload,
  isKnownDemoTicketCode,
  maskCpfForPrivacy,
  formatCpfDisplay,
  resolveAdminHeaderAction,
  validateAdminCategoryFormInput,
  validateAdminBatchFormInput,
  calculateOrderTotals,
  buildCameraConstraintCandidates,
  shouldAbortCameraFallbackOnError,
  classifyCameraError,
} from '../utils/ticketRules';
import {
  supabaseConfigState,
  verifySupabaseConnection,
  type SupabaseConnectionStatus,
} from '../lib/supabase';
import { performCheckinInSupabase } from '../services/platformService';
import { BrandLogo, QRCodeVisual, ResilientImage } from './BrandLogo';

export type AdminModule =
  | 'dashboard'
  | 'events'
  | 'categories'
  | 'lots'
  | 'tickets'
  | 'orders'
  | 'payments'
  | 'customers'
  | 'operators'
  | 'reports'
  | 'checkin'
  | 'settings';

interface AdminPanelViewProps {
  events: EventItem[];
  categories: EventCategory[];
  ticketCategories?: DbTicketCategoryRow[];
  ticketBatches?: DbTicketBatchRow[];
  tickets: Ticket[];
  orders: Order[];
  checkins: CheckinRecord[];
  customers: Profile[];
  auditLogs: AuditLogEntry[];
  adminAccess: AdminAccessEvaluation;
  currentUserProfile?: Profile | null;
  authenticatedEmail?: string | null;
  isAuthLoading?: boolean;
  isLoadingAdminEvents?: boolean;
  adminEventsError?: string | null;
  onRefreshAdminEvents?: () => Promise<void> | void;
  onGoToLogin?: () => void;
  onGoToHome?: () => void;
  onSignOut?: () => void;
  onRefreshProfile?: () => void;
  onCreateEvent: (input: AdminEventFormInput) => Promise<{
    ok: boolean;
    event?: EventItem;
    errorMessage?: string;
    fieldErrors?: Record<string, string>;
  }>;
  onUpdateEvent: (
    eventId: string,
    input: AdminEventFormInput
  ) => Promise<{
    ok: boolean;
    event?: EventItem;
    errorMessage?: string;
    fieldErrors?: Record<string, string>;
  }>;
  onToggleEventStatus: (
    eventId: string,
    nextStatus: EventStatus
  ) => Promise<{
    ok: boolean;
    event?: EventItem;
    errorMessage?: string;
  }>;
  onDeleteEvent: (eventId: string) => Promise<{
    ok: boolean;
    errorMessage?: string;
  }>;
  onSaveTicketCategory?: (input: AdminSaveTicketCategoryInput) => Promise<{
    ok: boolean;
    category?: DbTicketCategoryRow;
    errorMessage?: string;
  }>;
  onDeleteTicketCategory?: (categoryId: string) => Promise<{
    ok: boolean;
    errorMessage?: string;
  }>;
  onSaveTicketBatch?: (input: AdminSaveTicketBatchInput) => Promise<{
    ok: boolean;
    batch?: DbTicketBatchRow;
    errorMessage?: string;
  }>;
  onDeleteTicketBatch?: (batchId: string) => Promise<{
    ok: boolean;
    errorMessage?: string;
  }>;
  onCancelOrder?: (params: { orderId: string; reason?: string }) => Promise<{
    ok: boolean;
    payload?: CancelTicketOrderRpcPayload;
    errorMessage?: string;
  }>;
  onRefundOrder?: (params: {
    orderId: string;
    mpPaymentId: string;
    reason?: string;
  }) => Promise<{
    ok: boolean;
    payload?: RefundTicketOrderRpcPayload;
    errorMessage?: string;
  }>;
  onProcessCheckin: (updatedTicket: Ticket | undefined, record: CheckinRecord) => void;
  onSelectEventPublic: (ev: EventItem) => void;
}

interface EventModalFormState {
  title: string;
  subtitle: string;
  slug: string;
  categoryId: string;
  dateInput: string;
  timeRange: string;
  city: string;
  venueName: string;
  startingPrice: string;
  capacity: string;
  ticketsSold: number;
  bannerUrl: string;
  cardImageUrl: string;
  galleryUrls: string[];
  description: string;
  highlightsText: string;
  status: EventStatus;
  featured: boolean;
}

interface CategoryModalFormState {
  id: string | null;
  eventId: string;
  name: string;
  slug: string;
  description: string;
  maxPerOrder: string;
  sortOrder: string;
  active: boolean;
}

interface BatchModalFormState {
  id: string | null;
  eventId: string;
  categoryId: string;
  name: string;
  batchNumber: string;
  description: string;
  price: string;
  totalQuantity: string;
  startsAt: string;
  endsAt: string;
  active: boolean;
}

const EMPTY_EVENT_FORM: EventModalFormState = {
  title: '',
  subtitle: '',
  slug: '',
  categoryId: 'cat-carros',
  dateInput: '',
  timeRange: '10:00 às 22:00',
  city: '',
  venueName: '',
  startingPrice: '',
  capacity: '',
  ticketsSold: 0,
  bannerUrl: '/assets/events/hero-banner-full.jpg',
  cardImageUrl: '/assets/events/ev-rebaixados.jpg',
  galleryUrls: [],
  description: '',
  highlightsText: '',
  status: 'Rascunho',
  featured: false,
};

function toDatetimeLocalValue(isoOrEmpty?: string | null): string {
  if (!isoOrEmpty) return '';
  const dt = new Date(isoOrEmpty);
  if (Number.isNaN(dt.getTime())) return '';
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

export const AdminPanelView: React.FC<AdminPanelViewProps> = ({
  events,
  categories,
  ticketCategories = [],
  ticketBatches = [],
  tickets,
  orders,
  checkins,
  customers,
  auditLogs,
  adminAccess,
  currentUserProfile = null,
  authenticatedEmail = null,
  isAuthLoading = false,
  isLoadingAdminEvents = false,
  adminEventsError = null,
  onRefreshAdminEvents,
  onGoToLogin,
  onGoToHome,
  onSignOut,
  onRefreshProfile,
  onCreateEvent,
  onUpdateEvent,
  onToggleEventStatus,
  onDeleteEvent,
  onSaveTicketCategory,
  onDeleteTicketCategory,
  onSaveTicketBatch,
  onDeleteTicketBatch,
  onCancelOrder,
  onProcessCheckin,
  onSelectEventPublic,
}) => {
  const [activeModule, setActiveModule] = useState<AdminModule>('dashboard');
  const [periodFilter, setPeriodFilter] = useState<'7d' | '30d' | 'all'>('30d');

  // Create / Edit Event Modal & Persistence State
  const [showEventModal, setShowEventModal] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [eventForm, setEventForm] = useState<EventModalFormState>(EMPTY_EVENT_FORM);
  const [isSavingEvent, setIsSavingEvent] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalFieldErrors, setModalFieldErrors] = useState<Record<string, string>>({});

  // Table Row Action Feedback & Confirmation State
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [confirmDeleteEvent, setConfirmDeleteEvent] = useState<EventItem | null>(null);
  const [eventsFeedback, setEventsFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // MODULE 4 — CATEGORIAS (`public.ticket_categories`) State
  const [categoryEventFilter, setCategoryEventFilter] = useState<string>('all');
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [categorySlugManuallyEdited, setCategorySlugManuallyEdited] = useState(false);
  const [categoryForm, setCategoryForm] = useState<CategoryModalFormState>({
    id: null,
    eventId: '',
    name: '',
    slug: '',
    description: '',
    maxPerOrder: '10',
    sortOrder: '1',
    active: true,
  });
  const [isSavingCategory, setIsSavingCategory] = useState(false);
  const [categoryModalError, setCategoryModalError] = useState<string | null>(null);
  const [categoryFieldErrors, setCategoryFieldErrors] = useState<Record<string, string>>({});
  const [busyCategoryId, setBusyCategoryId] = useState<string | null>(null);
  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState<DbTicketCategoryRow | null>(null);
  const [categoriesFeedback, setCategoriesFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // MODULE 5 — LOTES (`public.ticket_batches`) State
  const [batchEventFilter, setBatchEventFilter] = useState<string>('all');
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [batchForm, setBatchForm] = useState<BatchModalFormState>({
    id: null,
    eventId: '',
    categoryId: '',
    name: '',
    batchNumber: '1',
    description: '',
    price: '',
    totalQuantity: '',
    startsAt: '',
    endsAt: '',
    active: true,
  });
  const [isSavingBatch, setIsSavingBatch] = useState(false);
  const [batchModalError, setBatchModalError] = useState<string | null>(null);
  const [batchFieldErrors, setBatchFieldErrors] = useState<Record<string, string>>({});
  const [busyBatchId, setBusyBatchId] = useState<string | null>(null);
  const [confirmDeleteBatch, setConfirmDeleteBatch] = useState<DbTicketBatchRow | null>(null);
  const [batchesFeedback, setBatchesFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // MODULE 6 — INGRESSOS (`public.tickets`) State
  const [ticketSearch, setTicketSearch] = useState('');
  const [ticketStatusFilter, setTicketStatusFilter] = useState<string>('all');
  const [inspectingTicket, setInspectingTicket] = useState<Ticket | null>(null);

  // MODULE 7 — PEDIDOS (`public.orders`) State
  const [orderSearch, setOrderSearch] = useState('');
  const [orderStatusFilter, setOrderStatusFilter] = useState<string>('all');
  const [inspectingOrder, setInspectingOrder] = useState<Order | null>(null);
  const [isProcessingOrderAction, setIsProcessingOrderAction] = useState(false);
  const [ordersFeedback, setOrdersFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // MODULE 8 — PAGAMENTOS (`public.orders` financial conciliation) State
  const [paymentMethodFilter, setPaymentMethodFilter] = useState<'all' | 'pix' | 'credit_card'>('all');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<string>('all');
  const [paymentSearch, setPaymentSearch] = useState('');

  // MODULE 9 — CLIENTES (`public.profiles`) State
  const [customerSearch, setCustomerSearch] = useState('');
  const [inspectingCustomer, setInspectingCustomer] = useState<Profile | null>(null);
  const [revealCustomerCpf, setRevealCustomerCpf] = useState(false);

  // Check-in Scanner State (PX CONTROL) — No fictitious initial ticket or result
  const [checkinInput, setCheckinInput] = useState('');
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [lastCheckinResult, setLastCheckinResult] = useState<{
    authorized: boolean;
    statusReason: string;
    record: CheckinRecord;
  } | null>(null);
  const [showCheckinHistory, setShowCheckinHistory] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [barcodeDetectorSupported, setBarcodeDetectorSupported] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanIntervalRef = useRef<number | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const activeModuleRef = useRef<AdminModule>(activeModule);
  const cameraSessionIdRef = useRef<number>(0);
  const isCheckingInRef = useRef<boolean>(false);
  const lastScannedRef = useRef<{ code: string; timestamp: number }>({
    code: '',
    timestamp: 0,
  });

  activeModuleRef.current = activeModule;

  // Safe Supabase Connection Diagnostic State (Never stores or displays credentials)
  const [supabaseStatus, setSupabaseStatus] = useState<SupabaseConnectionStatus | null>(null);
  const [checkingSupabase, setCheckingSupabase] = useState(false);

  const handleRunSupabaseCheck = async () => {
    setCheckingSupabase(true);
    try {
      const status = await verifySupabaseConnection();
      setSupabaseStatus(status);
    } finally {
      setCheckingSupabase(false);
    }
  };

  useEffect(() => {
    if (activeModule === 'settings' && !supabaseStatus && !checkingSupabase) {
      handleRunSupabaseCheck();
    }
  }, [activeModule]);

  const releaseMediaStreamTracks = (stream: MediaStream | null) => {
    if (!stream) return;
    stream.getTracks().forEach((track) => {
      try {
        track.onended = null;
        track.stop();
      } catch {
        // Ignore errors when stopping tracks
      }
    });
  };

  const stopCameraStream = () => {
    cameraSessionIdRef.current += 1;
    if (scanIntervalRef.current !== null) {
      window.clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (streamRef.current) {
      releaseMediaStreamTracks(streamRef.current);
      streamRef.current = null;
    }
    if (videoRef.current) {
      try {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
      } catch {
        // Ignore cleanup errors on video element
      }
    }
    if (isMountedRef.current) {
      setCameraActive(false);
      setIsStartingCamera(false);
      setBarcodeDetectorSupported(true);
    }
  };

  useEffect(() => {
    activeModuleRef.current = activeModule;
    if (activeModule !== 'checkin') {
      stopCameraStream();
    }
  }, [activeModule]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopCameraStream();
    };
  }, []);

  const attachStreamAndPlayVideo = async (
    stream: MediaStream,
    videoEl: HTMLVideoElement
  ): Promise<void> => {
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.autoplay = true;
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('webkit-playsinline', 'true');
    videoEl.setAttribute('muted', 'true');
    videoEl.srcObject = stream;

    if (videoEl.readyState < 1) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          videoEl.removeEventListener('loadedmetadata', finish);
          videoEl.removeEventListener('canplay', finish);
          window.clearTimeout(timer);
          resolve();
        };
        const timer = window.setTimeout(finish, 2500);
        videoEl.addEventListener('loadedmetadata', finish, { once: true });
        videoEl.addEventListener('canplay', finish, { once: true });
      });
    }

    await videoEl.play();
  };

  useEffect(() => {
    if (!cameraActive || !streamRef.current || !videoRef.current) {
      return;
    }
    const videoEl = videoRef.current;
    if (videoEl.srcObject !== streamRef.current) {
      attachStreamAndPlayVideo(streamRef.current, videoEl).catch((err) => {
        stopCameraStream();
        if (isMountedRef.current && activeModuleRef.current === 'checkin') {
          setCameraError(classifyCameraError(err));
        }
      });
    } else if (videoEl.paused) {
      videoEl.play().catch(() => {
        // Handled by primary activation flow
      });
    }
  }, [cameraActive]);

  const executeCheckinCode = async (rawCodeInput: string) => {
    const rawCode = rawCodeInput.trim();
    if (!rawCode || isCheckingInRef.current || isCheckingIn) return;

    const nowStr = new Date().toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const operatorLabel =
      currentUserProfile?.fullName || authenticatedEmail || 'Operador PX CONTROL';

    if (isKnownDemoTicketCode(rawCode)) {
      const blockedRecord: CheckinRecord = {
        id: `CHK-DEMO-BLOCK-${Date.now()}`,
        ticketId: 'N/A',
        ticketCode: rawCode.toUpperCase(),
        eventTitle: 'Código Fictício / Demonstração',
        holderName: 'Não autorizado',
        categoryName: 'N/A',
        checkedInAt: nowStr,
        operatorName: operatorLabel,
        deviceId: 'PX-CONTROL-WEB',
        result: 'invalid',
        message:
          'Código de demonstração bloqueado: ingressos fictícios de desenvolvimento não são aceitos no check-in.',
      };
      setLastCheckinResult({
        authorized: false,
        statusReason: 'invalid',
        record: blockedRecord,
      });
      onProcessCheckin(undefined, blockedRecord);
      return;
    }

    isCheckingInRef.current = true;
    setIsCheckingIn(true);
    try {
      const rpcRes = await performCheckinInSupabase({
        codeOrPayload: rawCode,
        deviceId: 'PX-CONTROL-WEB',
      });

      const matchedTicket = tickets.find(
        (t) =>
          t.id === rpcRes.ticketId ||
          t.code.toUpperCase() === (rpcRes.ticketCode ?? rawCode).toUpperCase()
      );

      const checkinRecord: CheckinRecord = {
        id: `CHK-${Date.now()}`,
        ticketId: rpcRes.ticketId ?? matchedTicket?.id ?? 'N/A',
        ticketCode: rpcRes.ticketCode ?? rawCode.toUpperCase(),
        eventTitle: matchedTicket?.eventTitle ?? 'Verificado via Supabase RPC',
        holderName: rpcRes.holderName ?? matchedTicket?.holderName ?? '—',
        categoryName: matchedTicket?.ticketTypeName ?? '—',
        checkedInAt: rpcRes.usedAt
          ? new Date(rpcRes.usedAt).toLocaleString('pt-BR')
          : nowStr,
        operatorName: operatorLabel,
        deviceId: 'PX-CONTROL-WEB',
        result: rpcRes.result,
        message: rpcRes.message,
      };

      const updatedTicket: Ticket | undefined =
        rpcRes.authorized && matchedTicket
          ? {
              ...matchedTicket,
              status: 'used',
              usedAt: checkinRecord.checkedInAt,
              usedByOperator: operatorLabel,
            }
          : undefined;

      if (isMountedRef.current) {
        setLastCheckinResult({
          authorized: rpcRes.authorized,
          statusReason: rpcRes.result,
          record: checkinRecord,
        });
      }
      onProcessCheckin(updatedTicket, checkinRecord);
    } finally {
      isCheckingInRef.current = false;
      if (isMountedRef.current) {
        setIsCheckingIn(false);
      }
    }
  };

  const executeCheckinCodeRef = useRef(executeCheckinCode);
  executeCheckinCodeRef.current = executeCheckinCode;

  useEffect(() => {
    if (!cameraActive) {
      if (scanIntervalRef.current !== null) {
        window.clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
      return;
    }

    type BarcodeDetectorLike = {
      detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
    };
    const BarcodeDetectorCtor = (
      window as unknown as {
        BarcodeDetector?: new (options?: { formats?: string[] }) => BarcodeDetectorLike;
      }
    ).BarcodeDetector;

    if (!BarcodeDetectorCtor) {
      setBarcodeDetectorSupported(false);
      return;
    }

    let detector: BarcodeDetectorLike | null = null;
    try {
      detector = new BarcodeDetectorCtor({ formats: ['qr_code'] });
      setBarcodeDetectorSupported(true);
    } catch {
      setBarcodeDetectorSupported(false);
      return;
    }

    let scanningFrame = false;
    scanIntervalRef.current = window.setInterval(async () => {
      if (scanningFrame || isCheckingInRef.current) return;
      const videoEl = videoRef.current;
      if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return;

      scanningFrame = true;
      try {
        const codes = await detector!.detect(videoEl);
        const firstValue = codes?.[0]?.rawValue?.trim();
        if (firstValue && !isCheckingInRef.current) {
          const now = Date.now();
          if (
            lastScannedRef.current.code !== firstValue ||
            now - lastScannedRef.current.timestamp > 3500
          ) {
            lastScannedRef.current = { code: firstValue, timestamp: now };
            if (isMountedRef.current) {
              setCheckinInput(firstValue);
            }
            await executeCheckinCodeRef.current(firstValue);
          }
        }
      } catch {
        // Ignore transient frame detection errors
      } finally {
        scanningFrame = false;
      }
    }, 250);

    return () => {
      if (scanIntervalRef.current !== null) {
        window.clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
    };
  }, [cameraActive]);

  const handleToggleCamera = async () => {
    if (isStartingCamera) return;

    if (cameraActive) {
      stopCameraStream();
      return;
    }

    setCameraError(null);

    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setCameraError(
        'O acesso à câmera requer conexão segura (HTTPS). Utilize a validação manual por código abaixo.'
      );
      return;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      setCameraError(
        'Câmera indisponível neste navegador/ambiente. Utilize a validação manual por código abaixo.'
      );
      return;
    }

    const sessionId = ++cameraSessionIdRef.current;
    const isSessionStale = () =>
      !isMountedRef.current ||
      activeModuleRef.current !== 'checkin' ||
      cameraSessionIdRef.current !== sessionId;

    setIsStartingCamera(true);
    let acquiredStream: MediaStream | null = null;
    let lastError: unknown = null;

    try {
      const candidates = buildCameraConstraintCandidates();
      for (const constraints of candidates) {
        if (isSessionStale()) {
          break;
        }
        try {
          const candidateStream = await navigator.mediaDevices.getUserMedia(constraints);
          if (isSessionStale()) {
            releaseMediaStreamTracks(candidateStream);
            return;
          }
          const videoTracks = candidateStream.getVideoTracks();
          if (videoTracks.length > 0) {
            acquiredStream = candidateStream;
            break;
          }
          releaseMediaStreamTracks(candidateStream);
        } catch (err) {
          if (isSessionStale()) {
            return;
          }
          lastError = err;
          if (shouldAbortCameraFallbackOnError(err)) {
            break;
          }
        }
      }

      if (isSessionStale()) {
        releaseMediaStreamTracks(acquiredStream);
        return;
      }

      if (!acquiredStream) {
        throw lastError ?? new Error('Nenhuma câmera de vídeo disponível.');
      }

      const primaryVideoTrack = acquiredStream.getVideoTracks()[0];
      if (primaryVideoTrack) {
        primaryVideoTrack.onended = () => {
          stopCameraStream();
          if (isMountedRef.current && activeModuleRef.current === 'checkin') {
            setCameraError(
              'A transmissão da câmera foi interrompida pelo dispositivo. Clique em "Ativar Câmera QR" para reconectar.'
            );
          }
        };
      }

      streamRef.current = acquiredStream;

      if (!videoRef.current) {
        throw new Error('Elemento de vídeo não encontrado para exibir a câmera.');
      }

      await attachStreamAndPlayVideo(acquiredStream, videoRef.current);

      if (isSessionStale()) {
        releaseMediaStreamTracks(acquiredStream);
        stopCameraStream();
        return;
      }

      setCameraActive(true);
    } catch (err) {
      releaseMediaStreamTracks(acquiredStream);
      const stale = isSessionStale();
      stopCameraStream();
      if (!stale) {
        setCameraError(classifyCameraError(err));
      }
    } finally {
      if (isMountedRef.current && cameraSessionIdRef.current === sessionId) {
        setIsStartingCamera(false);
      }
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeCheckinCode(checkinInput);
  };

  const handleOpenCreateEventModal = () => {
    setEditingEventId(null);
    setSlugManuallyEdited(false);
    setModalError(null);
    setModalFieldErrors({});
    setEventForm({
      ...EMPTY_EVENT_FORM,
      categoryId: categories[0]?.id || 'cat-carros',
    });
    setShowEventModal(true);
  };

  const handleOpenEditEventModal = (ev: EventItem) => {
    setEditingEventId(ev.id);
    setSlugManuallyEdited(true);
    setModalError(null);
    setModalFieldErrors({});
    setEventForm({
      title: ev.title,
      subtitle: ev.subtitle || '',
      slug: ev.slug,
      categoryId: ev.categoryId,
      dateInput: ev.dateFormatted || ev.eventDateIso || '',
      timeRange: ev.timeRange,
      city: ev.city,
      venueName: ev.venueName,
      startingPrice: String(ev.startingPrice),
      capacity: String(ev.capacity),
      ticketsSold: ev.ticketsSold,
      bannerUrl: ev.bannerUrl,
      cardImageUrl: ev.cardImageUrl,
      galleryUrls: Array.isArray(ev.galleryUrls) ? ev.galleryUrls : [],
      description: ev.description,
      highlightsText: Array.isArray(ev.highlights) ? ev.highlights.join('\n') : '',
      status: ev.status,
      featured: Boolean(ev.featured),
    });
    setShowEventModal(true);
  };

  const handleTitleChange = (nextTitle: string) => {
    setEventForm((prev) => {
      const otherSlugs = events
        .filter((item) => !editingEventId || item.id !== editingEventId)
        .map((item) => item.slug);
      const nextSlug = slugManuallyEdited
        ? prev.slug
        : generateEventSlug(nextTitle, otherSlugs);
      return {
        ...prev,
        title: nextTitle,
        slug: nextSlug,
      };
    });
  };

  const handleSaveEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    setModalFieldErrors({});
    setEventsFeedback(null);

    const selectedCategory = categories.find(
      (c) => c.id === eventForm.categoryId || c.slug === eventForm.categoryId
    );

    const formInput: AdminEventFormInput = {
      id: editingEventId ?? undefined,
      title: eventForm.title,
      subtitle: eventForm.subtitle,
      slug: eventForm.slug,
      categoryId: eventForm.categoryId,
      categoryName: selectedCategory?.name,
      dateInput: eventForm.dateInput,
      timeRange: eventForm.timeRange,
      city: eventForm.city,
      venueName: eventForm.venueName,
      startingPrice: eventForm.startingPrice,
      capacity: eventForm.capacity,
      ticketsSold: editingEventId ? eventForm.ticketsSold : 0,
      bannerUrl: eventForm.bannerUrl,
      cardImageUrl: eventForm.cardImageUrl,
      galleryUrls: eventForm.galleryUrls,
      description: eventForm.description,
      highlights: eventForm.highlightsText,
      status: eventForm.status,
      featured: eventForm.featured,
    };

    const clientValidation = validateAndBuildEventWritePayload(formInput, {
      existingEvents: events.map((ev) => ({ id: ev.id, slug: ev.slug })),
      categories,
    });

    if (!clientValidation.ok) {
      setModalError(clientValidation.errorMessage);
      setModalFieldErrors(clientValidation.fieldErrors);
      return;
    }

    setIsSavingEvent(true);
    try {
      const result = editingEventId
        ? await onUpdateEvent(editingEventId, formInput)
        : await onCreateEvent(formInput);

      if (!result.ok) {
        setModalError(
          result.errorMessage ?? 'Não foi possível salvar o evento no Supabase.'
        );
        if (result.fieldErrors) {
          setModalFieldErrors(result.fieldErrors);
        }
        return;
      }

      setShowEventModal(false);
      setEditingEventId(null);
      setEventsFeedback({
        type: 'success',
        message: editingEventId
          ? `Evento "${result.event?.title ?? eventForm.title}" atualizado com sucesso em public.events.`
          : `Evento "${result.event?.title ?? eventForm.title}" criado com sucesso em public.events.`,
      });
    } catch (err) {
      setModalError(
        err instanceof Error
          ? err.message
          : 'Erro inesperado ao salvar o evento no Supabase.'
      );
    } finally {
      setIsSavingEvent(false);
    }
  };

  const handleTogglePublish = async (ev: EventItem) => {
    setEventsFeedback(null);
    setBusyEventId(ev.id);
    const nextStatus: EventStatus = ev.status === 'Publicado' ? 'Rascunho' : 'Publicado';
    try {
      const result = await onToggleEventStatus(ev.id, nextStatus);
      if (!result.ok) {
        setEventsFeedback({
          type: 'error',
          message:
            result.errorMessage ??
            `Não foi possível alterar o status do evento "${ev.title}".`,
        });
        return;
      }
      setEventsFeedback({
        type: 'success',
        message:
          nextStatus === 'Publicado'
            ? `Evento "${ev.title}" publicado com sucesso (status = 'published').`
            : `Evento "${ev.title}" movido para rascunho com sucesso (status = 'draft').`,
      });
    } finally {
      setBusyEventId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDeleteEvent) return;
    const target = confirmDeleteEvent;
    setEventsFeedback(null);
    setBusyEventId(target.id);
    try {
      const result = await onDeleteEvent(target.id);
      if (!result.ok) {
        setEventsFeedback({
          type: 'error',
          message:
            result.errorMessage ??
            `Não foi possível excluir o evento "${target.title}" do Supabase.`,
        });
        setConfirmDeleteEvent(null);
        return;
      }
      setConfirmDeleteEvent(null);
      setEventsFeedback({
        type: 'success',
        message: `Evento "${target.title}" excluído permanentemente de public.events.`,
      });
    } finally {
      setBusyEventId(null);
    }
  };

  // Category (`public.ticket_categories`) Handlers
  const handleOpenCreateCategoryModal = (preselectedEventId?: string) => {
    const defaultEvId =
      preselectedEventId && preselectedEventId !== 'all'
        ? preselectedEventId
        : categoryEventFilter !== 'all'
        ? categoryEventFilter
        : events[0]?.id ?? '';
    const existingForEv = ticketCategories.filter((c) => c.event_id === defaultEvId);
    const nextSort =
      existingForEv.length > 0
        ? Math.max(...existingForEv.map((c) => c.sort_order ?? 1)) + 1
        : 1;

    setCategorySlugManuallyEdited(false);
    setCategoryModalError(null);
    setCategoryFieldErrors({});
    setCategoryForm({
      id: null,
      eventId: defaultEvId,
      name: '',
      slug: '',
      description: '',
      maxPerOrder: '10',
      sortOrder: String(nextSort),
      active: true,
    });
    setShowCategoryModal(true);
  };

  const handleOpenEditCategoryModal = (cat: DbTicketCategoryRow) => {
    setCategorySlugManuallyEdited(true);
    setCategoryModalError(null);
    setCategoryFieldErrors({});
    setCategoryForm({
      id: cat.id,
      eventId: cat.event_id,
      name: cat.name,
      slug: cat.slug,
      description: cat.description ?? '',
      maxPerOrder: String(cat.max_per_order ?? 10),
      sortOrder: String(cat.sort_order ?? 1),
      active: cat.active !== false,
    });
    setShowCategoryModal(true);
  };

  const handleCategoryNameChange = (nextName: string) => {
    setCategoryForm((prev) => {
      const generated = nextName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      return {
        ...prev,
        name: nextName,
        slug: categorySlugManuallyEdited ? prev.slug : generated,
      };
    });
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setCategoryModalError(null);
    setCategoryFieldErrors({});
    setCategoriesFeedback(null);

    const validation = validateAdminCategoryFormInput({
      id: categoryForm.id,
      eventId: categoryForm.eventId,
      name: categoryForm.name,
      slug: categoryForm.slug,
      description: categoryForm.description,
      maxPerOrder: categoryForm.maxPerOrder,
      sortOrder: categoryForm.sortOrder,
      active: categoryForm.active,
    });

    if (!validation.ok) {
      setCategoryModalError(validation.errorMessage);
      setCategoryFieldErrors(validation.fieldErrors);
      return;
    }

    if (!onSaveTicketCategory) {
      setCategoryModalError('Função de persistência de categorias indisponível.');
      return;
    }

    setIsSavingCategory(true);
    try {
      const result = await onSaveTicketCategory(validation.payload);
      if (!result.ok) {
        setCategoryModalError(
          result.errorMessage ?? 'Não foi possível salvar a categoria em public.ticket_categories.'
        );
        return;
      }

      setShowCategoryModal(false);
      setCategoriesFeedback({
        type: 'success',
        message: categoryForm.id
          ? `Categoria "${validation.payload.name}" atualizada com sucesso via admin_save_ticket_category.`
          : `Categoria "${validation.payload.name}" criada com sucesso via admin_save_ticket_category.`,
      });
    } finally {
      setIsSavingCategory(false);
    }
  };

  const handleToggleCategoryActive = async (cat: DbTicketCategoryRow) => {
    if (!onSaveTicketCategory) return;
    setCategoriesFeedback(null);
    setBusyCategoryId(cat.id);
    const nextActive = !cat.active;
    try {
      const result = await onSaveTicketCategory({
        id: cat.id,
        eventId: cat.event_id,
        slug: cat.slug,
        name: cat.name,
        description: cat.description,
        maxPerOrder: cat.max_per_order,
        sortOrder: cat.sort_order,
        active: nextActive,
      });

      if (!result.ok) {
        setCategoriesFeedback({
          type: 'error',
          message:
            result.errorMessage ??
            `Não foi possível alterar o status da categoria "${cat.name}".`,
        });
        return;
      }

      setCategoriesFeedback({
        type: 'success',
        message: nextActive
          ? `Categoria "${cat.name}" ativada com sucesso.`
          : `Categoria "${cat.name}" desativada com sucesso.`,
      });
    } finally {
      setBusyCategoryId(null);
    }
  };

  const handleConfirmDeleteCategory = async () => {
    if (!confirmDeleteCategory || !onDeleteTicketCategory) return;
    const target = confirmDeleteCategory;
    setCategoriesFeedback(null);
    setBusyCategoryId(target.id);
    try {
      const result = await onDeleteTicketCategory(target.id);
      if (!result.ok) {
        setCategoriesFeedback({
          type: 'error',
          message:
            result.errorMessage ??
            `Não foi possível excluir a categoria "${target.name}".`,
        });
        setConfirmDeleteCategory(null);
        return;
      }
      setConfirmDeleteCategory(null);
      setCategoriesFeedback({
        type: 'success',
        message: `Categoria "${target.name}" excluída de public.ticket_categories.`,
      });
    } finally {
      setBusyCategoryId(null);
    }
  };

  // Batch (`public.ticket_batches`) Handlers
  const handleOpenCreateBatchModal = (preselectedEventId?: string) => {
    const defaultEvId =
      preselectedEventId && preselectedEventId !== 'all'
        ? preselectedEventId
        : batchEventFilter !== 'all'
        ? batchEventFilter
        : events[0]?.id ?? '';
    const categoriesForEvent = ticketCategories.filter(
      (c) => c.event_id === defaultEvId && c.active !== false
    );
    const defaultCatId =
      categoriesForEvent[0]?.id ??
      ticketCategories.find((c) => c.event_id === defaultEvId)?.id ??
      '';
    const existingBatchesForCat = ticketBatches.filter(
      (b) => b.event_id === defaultEvId && b.category_id === defaultCatId
    );
    const nextBatchNum =
      existingBatchesForCat.length > 0
        ? Math.max(...existingBatchesForCat.map((b) => b.batch_number ?? 1)) + 1
        : 1;

    setBatchModalError(null);
    setBatchFieldErrors({});
    setBatchForm({
      id: null,
      eventId: defaultEvId,
      categoryId: defaultCatId,
      name: `${nextBatchNum}º Lote`,
      batchNumber: String(nextBatchNum),
      description: '',
      price: '',
      totalQuantity: '',
      startsAt: '',
      endsAt: '',
      active: true,
    });
    setShowBatchModal(true);
  };

  const handleOpenEditBatchModal = (batch: DbTicketBatchRow) => {
    setBatchModalError(null);
    setBatchFieldErrors({});
    setBatchForm({
      id: batch.id,
      eventId: batch.event_id,
      categoryId: batch.category_id,
      name: batch.name,
      batchNumber: String(batch.batch_number ?? 1),
      description: batch.description ?? '',
      price: String(Number(batch.price)),
      totalQuantity: String(batch.total_quantity),
      startsAt: toDatetimeLocalValue(batch.starts_at),
      endsAt: toDatetimeLocalValue(batch.ends_at),
      active: batch.active !== false,
    });
    setShowBatchModal(true);
  };

  const handleBatchEventChange = (nextEventId: string) => {
    const catsForEvent = ticketCategories.filter((c) => c.event_id === nextEventId);
    const activeCat = catsForEvent.find((c) => c.active !== false) ?? catsForEvent[0];
    setBatchForm((prev) => ({
      ...prev,
      eventId: nextEventId,
      categoryId: activeCat?.id ?? '',
    }));
  };

  const handleSaveBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    setBatchModalError(null);
    setBatchFieldErrors({});
    setBatchesFeedback(null);

    const validation = validateAdminBatchFormInput({
      id: batchForm.id,
      eventId: batchForm.eventId,
      categoryId: batchForm.categoryId,
      name: batchForm.name,
      batchNumber: batchForm.batchNumber,
      description: batchForm.description,
      price: batchForm.price,
      totalQuantity: batchForm.totalQuantity,
      startsAt: batchForm.startsAt || null,
      endsAt: batchForm.endsAt || null,
      active: batchForm.active,
    });

    if (!validation.ok) {
      setBatchModalError(validation.errorMessage);
      setBatchFieldErrors(validation.fieldErrors);
      return;
    }

    if (!onSaveTicketBatch) {
      setBatchModalError('Função de persistência de lotes indisponível.');
      return;
    }

    setIsSavingBatch(true);
    try {
      const result = await onSaveTicketBatch(validation.payload);
      if (!result.ok) {
        setBatchModalError(
          result.errorMessage ?? 'Não foi possível salvar o lote em public.ticket_batches.'
        );
        return;
      }

      setShowBatchModal(false);
      setBatchesFeedback({
        type: 'success',
        message: batchForm.id
          ? `Lote "${validation.payload.name}" atualizado com sucesso via admin_save_ticket_batch.`
          : `Lote "${validation.payload.name}" criado com sucesso via admin_save_ticket_batch.`,
      });
    } finally {
      setIsSavingBatch(false);
    }
  };

  const handleToggleBatchActive = async (batch: DbTicketBatchRow) => {
    if (!onSaveTicketBatch) return;
    setBatchesFeedback(null);
    setBusyBatchId(batch.id);
    const nextActive = !batch.active;
    try {
      const result = await onSaveTicketBatch({
        id: batch.id,
        eventId: batch.event_id,
        categoryId: batch.category_id,
        name: batch.name,
        batchNumber: batch.batch_number,
        description: batch.description ?? '',
        price: Number(batch.price),
        totalQuantity: batch.total_quantity,
        thumbnailUrl: batch.thumbnail_url,
        startsAt: batch.starts_at,
        endsAt: batch.ends_at,
        active: nextActive,
      });

      if (!result.ok) {
        setBatchesFeedback({
          type: 'error',
          message:
            result.errorMessage ?? `Não foi possível alterar o status do lote "${batch.name}".`,
        });
        return;
      }

      setBatchesFeedback({
        type: 'success',
        message: nextActive
          ? `Lote "${batch.name}" ativado com sucesso.`
          : `Lote "${batch.name}" desativado com sucesso.`,
      });
    } finally {
      setBusyBatchId(null);
    }
  };

  const handleConfirmDeleteBatch = async () => {
    if (!confirmDeleteBatch || !onDeleteTicketBatch) return;
    const target = confirmDeleteBatch;
    setBatchesFeedback(null);
    setBusyBatchId(target.id);
    try {
      const result = await onDeleteTicketBatch(target.id);
      if (!result.ok) {
        setBatchesFeedback({
          type: 'error',
          message:
            result.errorMessage ?? `Não foi possível excluir o lote "${target.name}".`,
        });
        setConfirmDeleteBatch(null);
        return;
      }
      setConfirmDeleteBatch(null);
      setBatchesFeedback({
        type: 'success',
        message: `Lote "${target.name}" excluído de public.ticket_batches.`,
      });
    } finally {
      setBusyBatchId(null);
    }
  };

  // Order Unpaid Reservation Cancellation Handler (`cancel_ticket_order`)
  const handleCancelOrderReservation = async (order: Order) => {
    if (!onCancelOrder) return;
    setOrdersFeedback(null);
    setIsProcessingOrderAction(true);
    try {
      const result = await onCancelOrder({
        orderId: order.id,
        reason: 'Reserva não paga cancelada pelo administrador no PX CONTROL.',
      });
      if (!result.ok) {
        setOrdersFeedback({
          type: 'error',
          message:
            result.errorMessage ??
            `Não foi possível cancelar a reserva do pedido ${order.orderCode}.`,
        });
        return;
      }
      setInspectingOrder(null);
      setOrdersFeedback({
        type: 'success',
        message: `Reserva do pedido ${order.orderCode} cancelada com sucesso e estoque devolvido ao lote.`,
      });
    } finally {
      setIsProcessingOrderAction(false);
    }
  };

  const sidebarItems: { id: AdminModule; label: string; icon: React.ElementType }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'events', label: 'Eventos', icon: Calendar },
    { id: 'categories', label: 'Categorias', icon: Tags },
    { id: 'lots', label: 'Lotes', icon: Layers },
    { id: 'tickets', label: 'Ingressos', icon: TicketIcon },
    { id: 'orders', label: 'Pedidos', icon: ShoppingBag },
    { id: 'payments', label: 'Pagamentos', icon: CreditCard },
    { id: 'customers', label: 'Clientes', icon: Users },
    { id: 'operators', label: 'Operadores', icon: UserCheck },
    { id: 'checkin', label: 'Check-in QR', icon: QrCode },
    { id: 'reports', label: 'Relatórios', icon: BarChart3 },
    { id: 'settings', label: 'Configurações', icon: Settings },
  ];

  // Contextual Header Action Resolution (Guarantees "Novo Evento" never leaks into other sections)
  const headerAction = resolveAdminHeaderAction(activeModule);

  // Maps for fast relational lookup in tables
  const eventByIdMap = new Map<string, EventItem>(events.map((ev) => [ev.id, ev]));
  const categoryByIdMap = new Map<string, DbTicketCategoryRow>(
    ticketCategories.map((c) => [c.id, c])
  );

  // Real Dashboard & Financial KPIs computed strictly from real Supabase records
  const paidOrders = orders.filter(
    (o) => o.status === 'paid' && (o.paymentStatus === 'approved' || !o.paymentStatus)
  );
  const totalApprovedRevenue = paidOrders.reduce((acc, o) => acc + Number(o.totalAmount || 0), 0);
  const totalApprovedPixRevenue = paidOrders
    .filter((o) => o.paymentMethod === 'pix')
    .reduce((acc, o) => acc + Number(o.totalAmount || 0), 0);
  const totalApprovedCardRevenue = paidOrders
    .filter((o) => o.paymentMethod === 'credit_card')
    .reduce((acc, o) => acc + Number(o.totalAmount || 0), 0);
  const totalApprovedFee6Percent = paidOrders.reduce(
    (acc, o) => acc + Number(o.convenienceFee || 0),
    0
  );
  const validTicketsCount = tickets.filter(
    (t) => t.status === 'paid' || t.status === 'used'
  ).length;
  const usedTicketsCount =
    tickets.filter((t) => t.status === 'used').length ||
    checkins.filter((c) => c.result === 'authorized').length;

  // Filtered lists per module
  const filteredTicketCategories = ticketCategories.filter(
    (c) => categoryEventFilter === 'all' || c.event_id === categoryEventFilter
  );

  const filteredTicketBatches = ticketBatches.filter(
    (b) => batchEventFilter === 'all' || b.event_id === batchEventFilter
  );

  const filteredTickets = tickets.filter((t) => {
    if (ticketStatusFilter !== 'all' && t.status !== ticketStatusFilter) {
      return false;
    }
    if (!ticketSearch.trim()) return true;
    const q = ticketSearch.trim().toLowerCase();
    return (
      t.code.toLowerCase().includes(q) ||
      t.holderName.toLowerCase().includes(q) ||
      t.holderCpf.replace(/\D/g, '').includes(q.replace(/\D/g, '')) ||
      t.eventTitle.toLowerCase().includes(q) ||
      t.ticketTypeName.toLowerCase().includes(q)
    );
  });

  const filteredOrders = orders.filter((o) => {
    if (orderStatusFilter !== 'all') {
      if (orderStatusFilter === 'pending') {
        if (o.status !== 'reserved' && o.status !== 'pending_payment') return false;
      } else if (orderStatusFilter === 'cancelled_expired') {
        if (o.status !== 'cancelled' && o.status !== 'expired') return false;
      } else if (o.status !== orderStatusFilter) {
        return false;
      }
    }
    if (!orderSearch.trim()) return true;
    const q = orderSearch.trim().toLowerCase();
    return (
      o.orderCode.toLowerCase().includes(q) ||
      o.buyerName.toLowerCase().includes(q) ||
      o.buyerEmail.toLowerCase().includes(q) ||
      o.eventTitle.toLowerCase().includes(q) ||
      (o.mpPaymentId ?? '').toLowerCase().includes(q)
    );
  });

  const filteredPayments = orders.filter((o) => {
    if (paymentMethodFilter !== 'all' && o.paymentMethod !== paymentMethodFilter) {
      return false;
    }
    if (paymentStatusFilter !== 'all') {
      const pStatus = o.paymentStatus ?? (o.status === 'paid' ? 'approved' : 'pending');
      if (paymentStatusFilter === 'pending_in_process') {
        if (pStatus !== 'pending' && pStatus !== 'in_process') return false;
      } else if (paymentStatusFilter === 'cancelled_rejected') {
        if (pStatus !== 'cancelled' && pStatus !== 'rejected') return false;
      } else if (pStatus !== paymentStatusFilter) {
        return false;
      }
    }
    if (!paymentSearch.trim()) return true;
    const q = paymentSearch.trim().toLowerCase();
    return (
      o.orderCode.toLowerCase().includes(q) ||
      o.buyerName.toLowerCase().includes(q) ||
      (o.mpPaymentId ?? '').toLowerCase().includes(q) ||
      (o.mpPreferenceId ?? '').toLowerCase().includes(q)
    );
  });

  const filteredCustomers = customers.filter((c) => {
    if (activeModule === 'operators') {
      return c.role === 'checkin_operator' || c.role === 'admin' || c.role === 'SUPER_ADMIN';
    }
    if (!customerSearch.trim()) return true;
    const q = customerSearch.trim().toLowerCase();
    return (
      c.fullName.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.phone ?? '').toLowerCase().includes(q) ||
      (c.city ?? '').toLowerCase().includes(q)
    );
  });

  const batchModalPricePreview = calculateOrderTotals(Number(batchForm.price) || 0, 1);

  if (isAuthLoading) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-14 pb-20">
        <div className="rounded-2xl bg-[#11131A] border border-[#232736] p-8 text-center space-y-4">
          <RefreshCw className="w-8 h-8 text-[#E50914] animate-spin mx-auto" />
          <h1 className="font-display text-2xl font-extrabold text-white uppercase">
            Verificando Credenciais Administrativas
          </h1>
          <p className="text-xs sm:text-sm text-neutral-400">
            Consultando sessão ativa no Supabase Auth e permissões em public.profiles...
          </p>
        </div>
      </div>
    );
  }

  if (!adminAccess.allowed) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 pb-20">
        <div className="rounded-2xl bg-[#11131A] border border-[#E50914]/40 p-6 sm:p-10 space-y-6">
          <div className="flex items-center justify-between border-b border-[#1E2230] pb-4">
            <BrandLogo size="md" />
            <span className="px-3 py-1 rounded-full bg-[#E50914]/15 border border-[#E50914]/40 text-xs font-mono-tabular font-bold uppercase text-[#E50914] flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5" />
              <span>PX CONTROL — Acesso Restrito</span>
            </span>
          </div>

          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-6 h-6 text-[#E50914] shrink-0 mt-0.5" />
              <div className="space-y-1.5">
                <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-white uppercase">
                  Autorização Administrativa Necessária
                </h1>
                <p className="text-xs sm:text-sm text-neutral-300 leading-relaxed">
                  {adminAccess.message}
                </p>
              </div>
            </div>

            <div className="rounded-xl bg-[#0D0F15] border border-[#232736] p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div>
                <span className="block text-neutral-500">Status da Sessão</span>
                <span className="font-semibold text-white">
                  {adminAccess.reasonCode === 'unauthenticated'
                    ? 'Visitante desconectado'
                    : authenticatedEmail || currentUserProfile?.email || 'Autenticado'}
                </span>
              </div>
              <div>
                <span className="block text-neutral-500">Papel Verificado (public.profiles)</span>
                <span className="font-mono-tabular font-bold text-[#E50914]">
                  {adminAccess.userRole ?? 'Nenhum'}
                </span>
              </div>
              <div>
                <span className="block text-neutral-500">Papel Exigido</span>
                <span className="font-mono-tabular font-semibold text-neutral-200">
                  admin ou SUPER_ADMIN
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            {adminAccess.reasonCode === 'unauthenticated' ? (
              <button
                type="button"
                onClick={onGoToLogin}
                className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold uppercase tracking-wider inline-flex items-center gap-2 cursor-pointer shadow-[0_0_20px_rgba(229,9,20,0.3)]"
              >
                <LogIn className="w-4 h-4" />
                <span>Fazer Login Administrativo</span>
              </button>
            ) : (
              <>
                {onRefreshProfile && (
                  <button
                    type="button"
                    onClick={onRefreshProfile}
                    className="px-4 py-2.5 rounded-lg bg-[#181B24] hover:bg-[#222634] border border-[#2A2E3D] text-white text-xs font-bold uppercase tracking-wider inline-flex items-center gap-2 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-[#E50914]" />
                    <span>Verificar Permissão Novamente</span>
                  </button>
                )}
                {onSignOut && (
                  <button
                    type="button"
                    onClick={onSignOut}
                    className="px-4 py-2.5 rounded-lg bg-[#181B24] hover:bg-[#E50914]/20 border border-[#2A2E3D] hover:border-[#E50914]/50 text-neutral-200 text-xs font-bold uppercase tracking-wider inline-flex items-center gap-2 cursor-pointer"
                  >
                    <LogOut className="w-3.5 h-3.5 text-[#E50914]" />
                    <span>Trocar de Conta</span>
                  </button>
                )}
              </>
            )}

            {onGoToHome && (
              <button
                type="button"
                onClick={onGoToHome}
                className="px-4 py-2.5 rounded-lg bg-[#151822] hover:bg-[#1E2230] border border-[#262B3C] text-neutral-300 hover:text-white text-xs font-semibold cursor-pointer"
              >
                Voltar ao Início
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-20">
      <div className="rounded-2xl overflow-hidden bg-[#0D0E13] border border-[#232736] grid grid-cols-1 lg:grid-cols-12 min-h-[680px]">
        {/* Left Sidebar Menu */}
        <aside className="lg:col-span-3 xl:col-span-2 bg-[#0A0B0F] border-b lg:border-b-0 lg:border-r border-[#1F222E] p-4 flex flex-col justify-between">
          <div className="space-y-5">
            <div className="flex items-center justify-between px-2 pt-1">
              <BrandLogo size="sm" />
              <span className="text-[10px] font-mono-tabular font-bold uppercase tracking-wider text-[#E50914]">
                PX CONTROL
              </span>
            </div>

            <nav
              aria-label="Menu do Painel Administrativo"
              className="flex lg:flex-col gap-1 overflow-x-auto pb-2 lg:pb-0"
            >
              {sidebarItems.map((item) => {
                const Icon = item.icon;
                const active = activeModule === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveModule(item.id)}
                    className={`px-3 py-2.5 rounded-lg text-xs font-semibold flex items-center gap-2.5 transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                      active
                        ? 'bg-[#E50914] text-white shadow-[0_0_16px_rgba(229,9,20,0.35)]'
                        : 'text-neutral-400 hover:text-white hover:bg-[#151822]'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="hidden lg:block pt-6 border-t border-[#1D202C] px-2 text-[11px] text-neutral-400 space-y-1">
            <p className="font-semibold text-white truncate">
              {currentUserProfile?.fullName || 'Administrador'}
            </p>
            <p className="text-[10px] text-neutral-400 truncate">
              {currentUserProfile?.email || authenticatedEmail}
            </p>
            <p className="font-mono-tabular text-[10px] text-emerald-400 font-bold">
              Role: {currentUserProfile?.role}
            </p>
          </div>
        </aside>

        {/* Main Admin Viewport */}
        <div className="lg:col-span-9 xl:col-span-10 p-5 sm:p-7 space-y-6">
          {/* Top Admin Context Header — Contextual Actions per Module */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1E2230] pb-4">
            <div>
              <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-white tracking-wide">
                {sidebarItems.find((i) => i.id === activeModule)?.label || 'Dashboard'}
              </h1>
              <p className="text-xs text-neutral-400">
                PX CONTROL — Gestão exclusiva de eventos, categorias, lotes, pagamentos Mercado Pago e portaria QR
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {onRefreshAdminEvents && (
                <button
                  type="button"
                  onClick={() => onRefreshAdminEvents()}
                  disabled={isLoadingAdminEvents}
                  className="px-3 py-2 rounded-lg bg-[#171A24] hover:bg-[#222634] border border-[#2C3144] text-xs font-semibold text-neutral-200 hover:text-white inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${
                      isLoadingAdminEvents ? 'animate-spin text-[#E50914]' : ''
                    }`}
                  />
                  <span>Sincronizar</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setActiveModule('checkin')}
                className="px-3.5 py-2 rounded-lg bg-[#171A24] hover:bg-[#222634] border border-[#2C3144] text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
              >
                <QrCode className="w-3.5 h-3.5 text-[#E50914]" />
                <span>Leitor Check-in</span>
              </button>

              {headerAction.showNewEvent && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveModule('events');
                    handleOpenCreateEventModal();
                  }}
                  className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-[0_0_16px_rgba(229,9,20,0.35)]"
                >
                  <Plus className="w-4 h-4" />
                  <span>Novo Evento</span>
                </button>
              )}

              {headerAction.showNewCategory && (
                <button
                  type="button"
                  onClick={() => handleOpenCreateCategoryModal()}
                  className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-[0_0_16px_rgba(229,9,20,0.35)]"
                >
                  <Plus className="w-4 h-4" />
                  <span>Nova Categoria</span>
                </button>
              )}

              {headerAction.showNewBatch && (
                <button
                  type="button"
                  onClick={() => handleOpenCreateBatchModal()}
                  className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-[0_0_16px_rgba(229,9,20,0.35)]"
                >
                  <Plus className="w-4 h-4" />
                  <span>Novo Lote</span>
                </button>
              )}
            </div>
          </div>

          {/* MODULE 1: DASHBOARD */}
          {activeModule === 'dashboard' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex items-center gap-1 bg-[#141720] border border-[#25293A] p-1 rounded-lg text-xs">
                  {[
                    { id: '7d', label: 'Últimos 7 dias' },
                    { id: '30d', label: 'Últimos 30 dias' },
                    { id: 'all', label: 'Todo o período (Supabase)' },
                  ].map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPeriodFilter(p.id as '7d' | '30d' | 'all')}
                      className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
                        periodFilter === p.id
                          ? 'bg-[#E50914] text-white'
                          : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 4 Financial & Operational KPIs from Real Supabase Data */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-4 space-y-2">
                  <span className="text-xs text-neutral-400">Vendas Totais Aprovadas</span>
                  <div className="text-xl sm:text-2xl font-extrabold text-white font-mono-tabular">
                    {formatBRL(totalApprovedRevenue)}
                  </div>
                  <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1 font-mono-tabular">
                    <TrendingUp className="w-3.5 h-3.5" />
                    <span>Inclui taxa 6% ({formatBRL(totalApprovedFee6Percent)})</span>
                  </div>
                </div>

                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-4 space-y-2">
                  <span className="text-xs text-neutral-400">Pagamentos Aprovados</span>
                  <div className="text-xl sm:text-2xl font-extrabold text-white font-mono-tabular">
                    {paidOrders.length}
                  </div>
                  <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1 font-mono-tabular">
                    <TrendingUp className="w-3.5 h-3.5" />
                    <span>{orders.length} pedido(s) totais registrados</span>
                  </div>
                </div>

                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-4 space-y-2">
                  <span className="text-xs text-neutral-400">Ingressos Emitidos</span>
                  <div className="text-xl sm:text-2xl font-extrabold text-white font-mono-tabular">
                    {validTicketsCount}
                  </div>
                  <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1 font-mono-tabular">
                    <TrendingUp className="w-3.5 h-3.5" />
                    <span>{ticketBatches.filter((b) => b.active).length} lote(s) ativo(s)</span>
                  </div>
                </div>

                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-4 space-y-2">
                  <span className="text-xs text-neutral-400">Check-ins Realizados</span>
                  <div className="text-xl sm:text-2xl font-extrabold text-white font-mono-tabular">
                    {usedTicketsCount}
                  </div>
                  <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1 font-mono-tabular">
                    <TrendingUp className="w-3.5 h-3.5" />
                    <span>Portaria validada via QR Code</span>
                  </div>
                </div>
              </div>

              {/* Vendas por dia Chart + Eventos cadastrados */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-7 rounded-xl bg-[#131620] border border-[#25293A] p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-bold text-white">Receita Confirmada (PIX & Cartão)</h2>
                    <span className="text-xs text-neutral-400 font-mono-tabular">
                      PIX: {formatBRL(totalApprovedPixRevenue)} · Cartão: {formatBRL(totalApprovedCardRevenue)}
                    </span>
                  </div>

                  <div className="h-52 w-full pt-2">
                    <svg
                      viewBox="0 0 500 180"
                      className="w-full h-full overflow-visible"
                      role="img"
                      aria-label="Gráfico de vendas por dia"
                    >
                      <defs>
                        <linearGradient id="pxRedArea" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#E50914" stopOpacity="0.55" />
                          <stop offset="100%" stopColor="#E50914" stopOpacity="0.02" />
                        </linearGradient>
                      </defs>
                      {[30, 70, 110, 150].map((y) => (
                        <line
                          key={y}
                          x1="32"
                          y1={y}
                          x2="485"
                          y2={y}
                          stroke="#222636"
                          strokeDasharray="3 3"
                        />
                      ))}
                      <text x="4" y="34" fill="#737994" fontSize="10">
                        100%
                      </text>
                      <text x="4" y="74" fill="#737994" fontSize="10">
                        75%
                      </text>
                      <text x="4" y="114" fill="#737994" fontSize="10">
                        50%
                      </text>
                      <text x="4" y="154" fill="#737994" fontSize="10">
                        25%
                      </text>

                      <path
                        d="M 40 145 L 110 122 L 180 130 L 250 92 L 320 105 L 390 58 L 475 28 L 475 155 L 40 155 Z"
                        fill="url(#pxRedArea)"
                      />
                      <path
                        d="M 40 145 L 110 122 L 180 130 L 250 92 L 320 105 L 390 58 L 475 28"
                        fill="none"
                        stroke="#E50914"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      {[
                        { x: 40, y: 145, label: '01' },
                        { x: 110, y: 122, label: '05' },
                        { x: 180, y: 130, label: '10' },
                        { x: 250, y: 92, label: '15' },
                        { x: 320, y: 105, label: '20' },
                        { x: 390, y: 58, label: '25' },
                        { x: 475, y: 28, label: '30' },
                      ].map((pt) => (
                        <g key={pt.label}>
                          <circle cx={pt.x} cy={pt.y} r="4" fill="#E50914" stroke="#ffffff" strokeWidth="1.5" />
                          <text x={pt.x - 6} y="172" fill="#8A90A8" fontSize="10">
                            {pt.label}
                          </text>
                        </g>
                      ))}
                    </svg>
                  </div>
                </div>

                {/* Eventos Cadastrados List */}
                <div className="lg:col-span-5 rounded-xl bg-[#131620] border border-[#25293A] p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-bold text-white">Eventos Cadastrados ({events.length})</h2>
                    <button
                      type="button"
                      onClick={() => setActiveModule('events')}
                      className="text-xs font-semibold text-[#E50914] hover:underline cursor-pointer"
                    >
                      Gerenciar
                    </button>
                  </div>

                  {events.length === 0 ? (
                    <div className="rounded-lg bg-[#0E1017] border border-[#212534] p-4 text-xs text-neutral-400">
                      Nenhum evento cadastrado em <code className="text-neutral-300">public.events</code> no momento.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {events.slice(0, 5).map((ev) => (
                        <div
                          key={ev.id}
                          className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-[#0E1017] border border-[#212534]"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-12 h-9 rounded overflow-hidden shrink-0 border border-[#2B3042]">
                              <ResilientImage
                                src={ev.cardImageUrl}
                                alt={ev.title}
                                className="w-full h-full object-cover"
                              />
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-bold text-white truncate">{ev.title}</p>
                              <p className="text-[11px] text-neutral-400 font-mono-tabular">
                                {ev.ticketsSold.toLocaleString('pt-BR')} / {ev.capacity.toLocaleString('pt-BR')} ingressos · {ev.status}
                              </p>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => onSelectEventPublic(ev)}
                            className="text-[11px] font-semibold text-[#E50914] hover:underline shrink-0 cursor-pointer"
                          >
                            Abrir
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* MODULE 2: GESTÃO DE EVENTOS */}
          {activeModule === 'events' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-white">Gestão de Eventos</h2>
                  <p className="text-xs text-neutral-400">
                    Persistência direta em <span className="font-mono-tabular">public.events</span> (rascunhos e publicados).
                  </p>
                </div>
                <div className="flex items-center gap-2.5">
                  <span className="text-xs text-neutral-400 font-mono-tabular">
                    {events.length} evento(s) no banco
                  </span>
                  <button
                    type="button"
                    onClick={handleOpenCreateEventModal}
                    className="px-3.5 py-1.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Novo Evento</span>
                  </button>
                </div>
              </div>

              {eventsFeedback && (
                <div
                  className={`rounded-xl p-3.5 border flex items-start justify-between gap-3 text-xs ${
                    eventsFeedback.type === 'success'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-[#E50914]/10 border-[#E50914]/40 text-neutral-200'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    {eventsFeedback.type === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
                    )}
                    <span>{eventsFeedback.message}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEventsFeedback(null)}
                    aria-label="Fechar aviso"
                    className="text-neutral-400 hover:text-white shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {adminEventsError && (
                <div className="rounded-xl bg-[#18151B] border border-[#E50914]/40 p-4 flex items-center justify-between gap-3 text-xs text-neutral-200">
                  <span>{adminEventsError}</span>
                  {onRefreshAdminEvents && (
                    <button
                      type="button"
                      onClick={() => onRefreshAdminEvents()}
                      className="px-3 py-1.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white font-bold shrink-0 cursor-pointer"
                    >
                      Tentar novamente
                    </button>
                  )}
                </div>
              )}

              {confirmDeleteEvent && (
                <div className="rounded-xl bg-[#191318] border border-[#E50914]/50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <div className="space-y-0.5">
                    <p className="font-bold text-white">
                      Confirmar exclusão permanente de &ldquo;{confirmDeleteEvent.title}&rdquo;?
                    </p>
                    <p className="text-neutral-400">
                      Esta operação remove o registro de <span className="font-mono-tabular">public.events</span> caso não existam pedidos ou ingressos vinculados.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={handleConfirmDelete}
                      disabled={busyEventId === confirmDeleteEvent.id}
                      className="px-3.5 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-50 text-white font-bold cursor-pointer"
                    >
                      {busyEventId === confirmDeleteEvent.id
                        ? 'Excluindo...'
                        : 'Confirmar Exclusão'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteEvent(null)}
                      disabled={busyEventId === confirmDeleteEvent.id}
                      className="px-3 py-2 rounded-lg bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-300 hover:text-white font-semibold cursor-pointer"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto rounded-xl border border-[#242838] bg-[#12151E]">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[#222636] text-[11px] font-semibold text-neutral-400 uppercase">
                      <th className="py-3.5 px-4">Imagem</th>
                      <th className="py-3.5 px-4">Nome</th>
                      <th className="py-3.5 px-4">Data</th>
                      <th className="py-3.5 px-4">Local</th>
                      <th className="py-3.5 px-4">Status</th>
                      <th className="py-3.5 px-4 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D2130] text-xs">
                    {isLoadingAdminEvents && events.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 px-4 text-center text-neutral-400">
                          Carregando eventos administrativos de public.events...
                        </td>
                      </tr>
                    ) : events.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 px-4 text-center text-neutral-400">
                          Nenhum evento cadastrado em public.events. Clique em &ldquo;Novo Evento&rdquo; para criar o primeiro registro.
                        </td>
                      </tr>
                    ) : (
                      events.map((ev) => {
                        const isBusy = busyEventId === ev.id;
                        return (
                          <tr key={ev.id} className="hover:bg-[#171B26] transition-colors">
                            <td className="py-3 px-4">
                              <div className="w-16 h-10 rounded-md overflow-hidden border border-[#2D3246]">
                                <ResilientImage
                                  src={ev.cardImageUrl}
                                  alt={ev.title}
                                  className="w-full h-full object-cover"
                                />
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <p className="font-bold text-white">{ev.title}</p>
                              <p className="text-[11px] text-neutral-400">
                                {ev.categoryName} ·{' '}
                                <span className="font-mono-tabular text-neutral-500">
                                  /{ev.slug}
                                </span>
                              </p>
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-neutral-300">
                              {ev.dateFormatted}
                            </td>
                            <td className="py-3 px-4 text-neutral-300">
                              <span className="block">{ev.city}</span>
                              <span className="block text-[11px] text-neutral-500 truncate max-w-[180px]">
                                {ev.venueName}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleTogglePublish(ev)}
                                title={
                                  ev.status === 'Publicado'
                                    ? 'Clique para despublicar (mover para Rascunho)'
                                    : 'Clique para publicar este evento no catálogo'
                                }
                                className={`px-2.5 py-1 rounded text-[11px] font-bold disabled:opacity-50 cursor-pointer ${
                                  ev.status === 'Publicado'
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : ev.status === 'Rascunho'
                                    ? 'bg-[#E50914]/20 text-red-300 border border-[#E50914]/30'
                                    : 'bg-neutral-500/20 text-neutral-300 border border-neutral-500/30'
                                }`}
                              >
                                {isBusy ? 'Salvando...' : ev.status}
                              </button>
                            </td>
                            <td className="py-3 px-4 text-right">
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => onSelectEventPublic(ev)}
                                  aria-label={`Visualizar página de ${ev.title}`}
                                  title="Visualizar página do evento"
                                  className="p-1.5 rounded bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-300 hover:text-white cursor-pointer"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleOpenEditEventModal(ev)}
                                  aria-label={`Editar evento ${ev.title}`}
                                  title="Editar dados do evento"
                                  className="p-1.5 rounded bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-300 hover:text-white disabled:opacity-50 cursor-pointer"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => setConfirmDeleteEvent(ev)}
                                  aria-label={`Remover evento ${ev.title}`}
                                  title="Excluir evento do banco"
                                  className="p-1.5 rounded bg-[#1B1F2C] hover:bg-[#E50914] text-neutral-300 hover:text-white transition-colors disabled:opacity-50 cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* MODULE 3: CHECK-IN DE INGRESSOS */}
          {activeModule === 'checkin' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-white">Check-in de Ingressos</h2>
                  <p className="text-xs text-neutral-400">
                    Validação transacional anti-reutilização para portaria mobile e desktop.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleToggleCamera}
                  disabled={isStartingCamera}
                  className="px-4 py-2 rounded-lg bg-[#171A24] hover:bg-[#212534] disabled:opacity-60 border border-[#2D3244] text-xs font-semibold text-white flex items-center gap-2 cursor-pointer"
                >
                  {cameraActive ? (
                    <>
                      <CameraOff className="w-4 h-4 text-[#E50914]" />
                      <span>Desativar Câmera</span>
                    </>
                  ) : (
                    <>
                      <Camera className="w-4 h-4 text-[#E50914]" />
                      <span>{isStartingCamera ? 'Iniciando Câmera...' : 'Ativar Câmera QR'}</span>
                    </>
                  )}
                </button>
              </div>

              {cameraError && (
                <div className="rounded-xl bg-[#18151B] border border-[#E50914]/40 p-3 text-xs text-neutral-200">
                  {cameraError}
                </div>
              )}

              {cameraActive && !barcodeDetectorSupported && (
                <div className="rounded-xl bg-[#161924] border border-amber-500/40 p-3 text-xs text-amber-200">
                  Visualização da câmera ativa, porém este navegador não possui suporte nativo à leitura automática de QR Code (BarcodeDetector). Utilize o Google Chrome no Android ou informe o código manualmente no campo ao lado.
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
                <div className="lg:col-span-5 rounded-2xl bg-[#11131C] border border-[#232736] p-6 flex flex-col items-center justify-center space-y-4">
                  <p className="text-xs font-semibold text-neutral-300">
                    Escaneie o QR Code do ingresso
                  </p>

                  <div className="relative w-52 h-52 flex items-center justify-center bg-[#090A0E] rounded-xl p-4 overflow-hidden">
                    <span className="absolute top-2 left-2 z-20 w-7 h-7 border-t-4 border-l-4 border-[#E50914] rounded-tl-md pointer-events-none" />
                    <span className="absolute top-2 right-2 z-20 w-7 h-7 border-t-4 border-r-4 border-[#E50914] rounded-tr-md pointer-events-none" />
                    <span className="absolute bottom-2 left-2 z-20 w-7 h-7 border-b-4 border-l-4 border-[#E50914] rounded-bl-md pointer-events-none" />
                    <span className="absolute bottom-2 right-2 z-20 w-7 h-7 border-b-4 border-r-4 border-[#E50914] rounded-br-md pointer-events-none" />

                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      data-testid="checkin-camera-video"
                      className={`w-full h-full object-cover rounded-lg transition-opacity duration-150 ${
                        cameraActive
                          ? 'opacity-100 z-10'
                          : 'opacity-0 pointer-events-none absolute inset-4 w-[calc(100%-2rem)] h-[calc(100%-2rem)]'
                      }`}
                    />

                    {!cameraActive && (
                      <QRCodeVisual value={checkinInput || 'PX-CONTROL-SCANNER'} size={140} />
                    )}

                    <div className="absolute left-3 right-3 top-1/2 z-20 h-0.5 bg-[#E50914] shadow-[0_0_12px_#E50914] pointer-events-none" />
                  </div>

                  {tickets.length > 0 && (
                    <div className="w-full pt-2 space-y-1.5">
                      <span className="block text-[11px] text-neutral-400 text-center">
                        Ingressos emitidos no banco:
                      </span>
                      <div className="flex flex-wrap justify-center gap-1.5">
                        {tickets.slice(0, 5).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => setCheckinInput(t.code)}
                            className="px-2.5 py-1 rounded bg-[#181B26] hover:bg-[#232736] border border-[#2C3144] text-[11px] font-mono-tabular text-neutral-200 cursor-pointer"
                          >
                            {t.code} ({t.status === 'paid' ? 'Pago' : 'Usado'})
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="lg:col-span-7 rounded-2xl bg-[#11131C] border border-[#232736] p-6 space-y-5">
                  {lastCheckinResult ? (
                    <>
                      <div
                        className={`rounded-xl p-4 border flex items-start gap-3.5 ${
                          lastCheckinResult.authorized
                            ? 'bg-emerald-500/10 border-emerald-500/30'
                            : 'bg-[#E50914]/10 border-[#E50914]/40'
                        }`}
                      >
                        {lastCheckinResult.authorized ? (
                          <CheckCircle2 className="w-7 h-7 text-emerald-400 shrink-0" />
                        ) : (
                          <XCircle className="w-7 h-7 text-[#E50914] shrink-0" />
                        )}
                        <div>
                          <h3
                            className={`text-base font-bold ${
                              lastCheckinResult.authorized ? 'text-emerald-400' : 'text-[#E50914]'
                            }`}
                          >
                            {lastCheckinResult.authorized
                              ? 'Entrada autorizada!'
                              : 'Entrada bloqueada!'}
                          </h3>
                          <p className="text-xs text-neutral-300 mt-0.5">
                            {lastCheckinResult.record.message}
                          </p>
                        </div>
                      </div>

                      <div className="space-y-2.5 text-xs border-t border-b border-[#1E2230] py-4">
                        <div className="grid grid-cols-3 gap-2">
                          <span className="text-neutral-400">Código</span>
                          <span className="col-span-2 font-mono-tabular font-bold text-white">
                            {lastCheckinResult.record.ticketCode}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <span className="text-neutral-400">Evento</span>
                          <span className="col-span-2 font-semibold text-white">
                            {lastCheckinResult.record.eventTitle}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <span className="text-neutral-400">Nome</span>
                          <span className="col-span-2 font-semibold text-white">
                            {lastCheckinResult.record.holderName}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <span className="text-neutral-400">Categoria</span>
                          <span className="col-span-2 text-neutral-200">
                            {lastCheckinResult.record.categoryName}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <span className="text-neutral-400">Data e hora</span>
                          <span className="col-span-2 font-mono-tabular text-neutral-200">
                            {lastCheckinResult.record.checkedInAt}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <span className="text-neutral-400">Operador</span>
                          <span className="col-span-2 text-neutral-200">
                            {lastCheckinResult.record.operatorName}
                          </span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-xl bg-[#0D0F15] border border-[#232736] p-6 text-center space-y-2">
                      <QrCode className="w-8 h-8 text-[#E50914] mx-auto" />
                      <h3 className="text-sm font-bold text-white">
                        Pronto para Validação na Portaria
                      </h3>
                      <p className="text-xs text-neutral-400">
                        Escaneie o QR Code com a câmera ou digite o código do ingresso abaixo para
                        validar no Supabase via <code className="text-neutral-300">perform_ticket_checkin</code>.
                      </p>
                    </div>
                  )}

                  <form onSubmit={handleVerifyCode} className="flex flex-wrap items-center gap-2.5">
                    <div className="relative flex-1 min-w-[200px]">
                      <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={checkinInput}
                        onChange={(e) => setCheckinInput(e.target.value)}
                        placeholder="Digite o código ou payload QR do ingresso"
                        aria-label="Buscar ingresso por código"
                        className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-[#171A24] border border-[#2C3144] text-xs font-mono-tabular text-white focus:outline-none focus:border-[#E50914]"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isCheckingIn}
                      className="px-4 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-60 text-white text-xs font-bold cursor-pointer"
                    >
                      {isCheckingIn ? 'Validando...' : 'Validar Código'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCheckinHistory(!showCheckinHistory)}
                      className="px-3.5 py-2.5 rounded-lg bg-[#171A24] hover:bg-[#222636] border border-[#2C3144] text-xs font-semibold text-neutral-200 flex items-center gap-1.5 cursor-pointer"
                    >
                      <History className="w-3.5 h-3.5" />
                      <span>Histórico ({checkins.length})</span>
                    </button>
                  </form>

                  {showCheckinHistory && (
                    <div className="rounded-xl bg-[#0D0F15] border border-[#232736] p-3.5 space-y-2 max-h-44 overflow-y-auto">
                      {checkins.map((chk) => (
                        <div
                          key={chk.id}
                          className="flex items-center justify-between text-xs border-b border-[#1A1D29] pb-1.5 last:border-b-0"
                        >
                          <div>
                            <span className="font-mono-tabular font-bold text-white">
                              {chk.ticketCode}
                            </span>{' '}
                            · <span className="text-neutral-300">{chk.holderName}</span>
                          </div>
                          <span
                            className={`font-mono-tabular text-[11px] ${
                              chk.result === 'authorized' ? 'text-emerald-400' : 'text-[#E50914]'
                            }`}
                          >
                            {chk.checkedInAt}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* MODULE 4: CATEGORIAS (public.ticket_categories via admin_save_ticket_category) */}
          {activeModule === 'categories' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-white">
                    Categorias de Ingressos (<code className="text-sm text-neutral-300">public.ticket_categories</code>)
                  </h2>
                  <p className="text-xs text-neutral-400">
                    Gerencie setores e categorias de ingresso por evento (ex.: Pista, VIP, Expositor) via RPC{' '}
                    <code className="text-neutral-300">admin_save_ticket_category</code>.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <select
                    aria-label="Filtrar categorias por evento"
                    value={categoryEventFilter}
                    onChange={(e) => setCategoryEventFilter(e.target.value)}
                    className="px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white focus:outline-none focus:border-[#E50914]"
                  >
                    <option value="all">Todos os eventos ({events.length})</option>
                    {events.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.title}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() => handleOpenCreateCategoryModal()}
                    className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer shadow-[0_0_16px_rgba(229,9,20,0.35)]"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Nova Categoria</span>
                  </button>
                </div>
              </div>

              {categoriesFeedback && (
                <div
                  className={`rounded-xl p-3.5 border flex items-start justify-between gap-3 text-xs ${
                    categoriesFeedback.type === 'success'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-[#E50914]/10 border-[#E50914]/40 text-neutral-200'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    {categoriesFeedback.type === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
                    )}
                    <span>{categoriesFeedback.message}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCategoriesFeedback(null)}
                    className="text-neutral-400 hover:text-white shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {confirmDeleteCategory && (
                <div className="rounded-xl bg-[#191318] border border-[#E50914]/50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <div className="space-y-0.5">
                    <p className="font-bold text-white">
                      Confirmar exclusão da categoria &ldquo;{confirmDeleteCategory.name}&rdquo;?
                    </p>
                    <p className="text-neutral-400">
                      A exclusão só é permitida se não houver lotes com vendas, reservas, pedidos ou ingressos vinculados.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={handleConfirmDeleteCategory}
                      disabled={busyCategoryId === confirmDeleteCategory.id}
                      className="px-3.5 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-50 text-white font-bold cursor-pointer"
                    >
                      {busyCategoryId === confirmDeleteCategory.id
                        ? 'Excluindo...'
                        : 'Confirmar Exclusão'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteCategory(null)}
                      className="px-3 py-2 rounded-lg bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-300 hover:text-white font-semibold cursor-pointer"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto rounded-xl border border-[#242838] bg-[#12151E]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#222636] text-[11px] text-neutral-400 uppercase">
                      <th className="py-3.5 px-4">Evento</th>
                      <th className="py-3.5 px-4">Categoria / Slug</th>
                      <th className="py-3.5 px-4">Descrição</th>
                      <th className="py-3.5 px-4">Limite / Pedido</th>
                      <th className="py-3.5 px-4">Ordem</th>
                      <th className="py-3.5 px-4">Lotes</th>
                      <th className="py-3.5 px-4">Status</th>
                      <th className="py-3.5 px-4 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D2130]">
                    {filteredTicketCategories.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-8 px-4 text-center text-neutral-400">
                          Nenhuma categoria de ingresso cadastrada para o filtro selecionado. Clique em &ldquo;Nova Categoria&rdquo; para cadastrar.
                        </td>
                      </tr>
                    ) : (
                      filteredTicketCategories.map((cat) => {
                        const ev = eventByIdMap.get(cat.event_id);
                        const linkedBatchesCount = ticketBatches.filter(
                          (b) => b.category_id === cat.id
                        ).length;
                        const isBusy = busyCategoryId === cat.id;
                        return (
                          <tr key={cat.id} className="hover:bg-[#171B26] transition-colors">
                            <td className="py-3 px-4 font-semibold text-white">
                              {ev?.title ?? 'Evento não identificado'}
                            </td>
                            <td className="py-3 px-4">
                              <p className="font-bold text-white">{cat.name}</p>
                              <p className="text-[11px] font-mono-tabular text-neutral-500">
                                /{cat.slug}
                              </p>
                            </td>
                            <td className="py-3 px-4 text-neutral-300 max-w-[220px] truncate">
                              {cat.description || '—'}
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-neutral-200">
                              Máx. {cat.max_per_order} un.
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-neutral-300">
                              #{cat.sort_order}
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-neutral-300">
                              {linkedBatchesCount} lote(s)
                            </td>
                            <td className="py-3 px-4">
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleToggleCategoryActive(cat)}
                                title={
                                  cat.active
                                    ? 'Clique para desativar esta categoria'
                                    : 'Clique para ativar esta categoria'
                                }
                                className={`px-2.5 py-1 rounded text-[11px] font-bold disabled:opacity-50 cursor-pointer ${
                                  cat.active
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : 'bg-neutral-500/20 text-neutral-300 border border-neutral-500/30'
                                }`}
                              >
                                {isBusy ? 'Salvando...' : cat.active ? 'Ativa' : 'Inativa'}
                              </button>
                            </td>
                            <td className="py-3 px-4 text-right">
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleOpenEditCategoryModal(cat)}
                                  title="Editar categoria"
                                  className="p-1.5 rounded bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-300 hover:text-white disabled:opacity-50 cursor-pointer"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => setConfirmDeleteCategory(cat)}
                                  title="Excluir categoria"
                                  className="p-1.5 rounded bg-[#1B1F2C] hover:bg-[#E50914] text-neutral-300 hover:text-white transition-colors disabled:opacity-50 cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Preserved 5 Automotive Storefront Categories Reference Strip */}
              <div className="pt-2 space-y-3 border-t border-[#1E2230]">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                    Categorias Automotivas Oficiais da Vitrine PX CUSTON (Preservadas)
                  </h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  {categories.map((cat) => (
                    <div
                      key={cat.id}
                      className="rounded-xl bg-[#131620] border border-[#25293A] p-3 space-y-1"
                    >
                      <p className="text-xs font-bold text-white truncate">{cat.name}</p>
                      <p className="text-[11px] font-mono-tabular text-[#E50914] font-semibold">
                        {cat.eventCount} evento(s) publicado(s)
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* MODULE 5: LOTES (public.ticket_batches via admin_save_ticket_batch) */}
          {activeModule === 'lots' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-white">
                    Gestão de Lotes e Estoque (<code className="text-sm text-neutral-300">public.ticket_batches</code>)
                  </h2>
                  <p className="text-xs text-neutral-400">
                    Cadastre e edite lotes vinculados a eventos e categorias via RPC{' '}
                    <code className="text-neutral-300">admin_save_ticket_batch</code>.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <select
                    aria-label="Filtrar lotes por evento"
                    value={batchEventFilter}
                    onChange={(e) => setBatchEventFilter(e.target.value)}
                    className="px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white focus:outline-none focus:border-[#E50914]"
                  >
                    <option value="all">Todos os eventos ({events.length})</option>
                    {events.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.title}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() => handleOpenCreateBatchModal()}
                    className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer shadow-[0_0_16px_rgba(229,9,20,0.35)]"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Novo Lote</span>
                  </button>
                </div>
              </div>

              {batchesFeedback && (
                <div
                  className={`rounded-xl p-3.5 border flex items-start justify-between gap-3 text-xs ${
                    batchesFeedback.type === 'success'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-[#E50914]/10 border-[#E50914]/40 text-neutral-200'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    {batchesFeedback.type === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
                    )}
                    <span>{batchesFeedback.message}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setBatchesFeedback(null)}
                    className="text-neutral-400 hover:text-white shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {confirmDeleteBatch && (
                <div className="rounded-xl bg-[#191318] border border-[#E50914]/50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <div className="space-y-0.5">
                    <p className="font-bold text-white">
                      Confirmar exclusão do lote &ldquo;{confirmDeleteBatch.name}&rdquo;?
                    </p>
                    <p className="text-neutral-400">
                      A exclusão só é permitida se não houver ingressos vendidos, reservados ou pedidos vinculados.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={handleConfirmDeleteBatch}
                      disabled={busyBatchId === confirmDeleteBatch.id}
                      className="px-3.5 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-50 text-white font-bold cursor-pointer"
                    >
                      {busyBatchId === confirmDeleteBatch.id
                        ? 'Excluindo...'
                        : 'Confirmar Exclusão'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteBatch(null)}
                      className="px-3 py-2 rounded-lg bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-300 hover:text-white font-semibold cursor-pointer"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto rounded-xl border border-[#242838] bg-[#12151E]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#222636] text-[11px] text-neutral-400 uppercase">
                      <th className="py-3.5 px-4">Evento</th>
                      <th className="py-3.5 px-4">Categoria</th>
                      <th className="py-3.5 px-4">Lote</th>
                      <th className="py-3.5 px-4">Preço (+ 6% Taxa)</th>
                      <th className="py-3.5 px-4">Estoque (Vend. / Res. / Disp.)</th>
                      <th className="py-3.5 px-4">Período de Vendas</th>
                      <th className="py-3.5 px-4">Status</th>
                      <th className="py-3.5 px-4 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D2130]">
                    {filteredTicketBatches.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-8 px-4 text-center text-neutral-400">
                          Nenhum lote cadastrado para o filtro selecionado. Clique em &ldquo;Novo Lote&rdquo; para criar.
                        </td>
                      </tr>
                    ) : (
                      filteredTicketBatches.map((batch) => {
                        const ev = eventByIdMap.get(batch.event_id);
                        const cat = categoryByIdMap.get(batch.category_id);
                        const unitPrice = Number(batch.price);
                        const withFee = calculateOrderTotals(unitPrice, 1);
                        const available = Math.max(
                          0,
                          batch.total_quantity - batch.reserved_quantity - batch.sold_quantity
                        );
                        const isBusy = busyBatchId === batch.id;
                        const startsLabel = batch.starts_at
                          ? new Date(batch.starts_at).toLocaleDateString('pt-BR')
                          : 'Imediato';
                        const endsLabel = batch.ends_at
                          ? new Date(batch.ends_at).toLocaleDateString('pt-BR')
                          : 'Até o evento';

                        return (
                          <tr key={batch.id} className="hover:bg-[#171B26] transition-colors">
                            <td className="py-3 px-4 font-semibold text-white">
                              {ev?.title ?? 'Evento não identificado'}
                            </td>
                            <td className="py-3 px-4 text-neutral-200">
                              {cat?.name ?? 'Categoria'}
                            </td>
                            <td className="py-3 px-4">
                              <span className="font-bold text-white">{batch.name}</span>
                              <span className="block text-[11px] font-mono-tabular text-neutral-500">
                                Lote #{batch.batch_number}
                              </span>
                            </td>
                            <td className="py-3 px-4 font-mono-tabular">
                              <span className="font-bold text-white">{formatBRL(unitPrice)}</span>
                              <span className="block text-[11px] text-neutral-400">
                                Final c/ 6%: {formatBRL(withFee.total)}
                              </span>
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-neutral-200">
                              <span className="text-emerald-400 font-semibold">
                                {batch.sold_quantity} vend.
                              </span>{' '}
                              ·{' '}
                              <span className="text-amber-400">
                                {batch.reserved_quantity} res.
                              </span>{' '}
                              ·{' '}
                              <span>
                                {available}/{batch.total_quantity} disp.
                              </span>
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-[11px] text-neutral-300">
                              {startsLabel} → {endsLabel}
                            </td>
                            <td className="py-3 px-4">
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleToggleBatchActive(batch)}
                                title={
                                  batch.active
                                    ? 'Clique para pausar/desativar este lote'
                                    : 'Clique para ativar este lote'
                                }
                                className={`px-2.5 py-1 rounded text-[11px] font-bold disabled:opacity-50 cursor-pointer ${
                                  batch.active
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : 'bg-neutral-500/20 text-neutral-300 border border-neutral-500/30'
                                }`}
                              >
                                {isBusy ? 'Salvando...' : batch.active ? 'Ativo' : 'Inativo'}
                              </button>
                            </td>
                            <td className="py-3 px-4 text-right">
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleOpenEditBatchModal(batch)}
                                  title="Editar lote"
                                  className="p-1.5 rounded bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-300 hover:text-white disabled:opacity-50 cursor-pointer"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => setConfirmDeleteBatch(batch)}
                                  title="Excluir lote"
                                  className="p-1.5 rounded bg-[#1B1F2C] hover:bg-[#E50914] text-neutral-300 hover:text-white transition-colors disabled:opacity-50 cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* MODULE 6: INGRESSOS (public.tickets) */}
          {activeModule === 'tickets' && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-white">
                    Ingressos Emitidos (<code className="text-sm text-neutral-300">public.tickets</code>)
                  </h2>
                  <p className="text-xs text-neutral-400">
                    Os ingressos são gerados automaticamente pelo fluxo oficial de compra e confirmação de pagamento (<code className="text-neutral-300">confirm_order_payment</code>).
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setActiveModule('checkin')}
                  className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <QrCode className="w-4 h-4" />
                  <span>Abrir Leitor de QR Code</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={ticketSearch}
                    onChange={(e) => setTicketSearch(e.target.value)}
                    placeholder="Buscar por código (PX-...), titular, CPF ou evento..."
                    className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white focus:outline-none focus:border-[#E50914]"
                  />
                </div>

                <select
                  aria-label="Filtrar ingressos por status"
                  value={ticketStatusFilter}
                  onChange={(e) => setTicketStatusFilter(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white focus:outline-none focus:border-[#E50914]"
                >
                  <option value="all">Todos os status ({tickets.length})</option>
                  <option value="paid">Emitidos / Válidos (paid)</option>
                  <option value="used">Check-in Realizado (used)</option>
                  <option value="refunded">Reembolsados (refunded)</option>
                </select>
              </div>

              <div className="overflow-x-auto rounded-xl border border-[#242838] bg-[#12151E]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#222636] text-[11px] text-neutral-400 uppercase">
                      <th className="py-3.5 px-4">Código QR</th>
                      <th className="py-3.5 px-4">Cliente / Titular</th>
                      <th className="py-3.5 px-4">Evento & Lote</th>
                      <th className="py-3.5 px-4">Valor</th>
                      <th className="py-3.5 px-4">Status</th>
                      <th className="py-3.5 px-4">Emissão / Check-in</th>
                      <th className="py-3.5 px-4 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D2130]">
                    {filteredTickets.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 px-4 text-center text-neutral-400">
                          Nenhum ingresso emitido encontrado em <code className="text-neutral-300">public.tickets</code>. Os ingressos aparecerão automaticamente após a confirmação de pagamento pelo Mercado Pago.
                        </td>
                      </tr>
                    ) : (
                      filteredTickets.map((t) => (
                        <tr key={t.id} className="hover:bg-[#171B26] transition-colors">
                          <td className="py-3 px-4 font-mono-tabular">
                            <span className="font-bold text-[#E50914]">{t.code}</span>
                            {t.itemSequence && (
                              <span className="block text-[10px] text-neutral-500">
                                Item #{t.itemSequence}
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4">
                            <p className="font-bold text-white">{t.holderName}</p>
                            <p className="text-[11px] font-mono-tabular text-neutral-400">
                              CPF: {maskCpfForPrivacy(t.holderCpf)}
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            <p className="font-semibold text-white">{t.eventTitle}</p>
                            <p className="text-[11px] text-neutral-400">
                              {t.categoryName ? `${t.categoryName} · ` : ''}
                              {t.ticketTypeName}
                            </p>
                          </td>
                          <td className="py-3 px-4 font-mono-tabular font-bold text-white">
                            {formatBRL(t.pricePaid)}
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                                t.status === 'paid'
                                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                  : t.status === 'used'
                                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                                  : 'bg-neutral-500/20 text-neutral-300 border border-neutral-500/30'
                              }`}
                            >
                              {t.status === 'paid'
                                ? 'Pago / Válido'
                                : t.status === 'used'
                                ? 'Utilizado (Check-in)'
                                : t.status === 'refunded'
                                ? 'Reembolsado'
                                : t.status}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-mono-tabular text-[11px] text-neutral-300">
                            <span className="block">Emitido: {t.issuedAt}</span>
                            {t.usedAt && (
                              <span className="block text-sky-400">Check-in: {t.usedAt}</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setInspectingTicket(t)}
                                title="Visualizar QR Code e detalhes do ingresso"
                                className="px-2.5 py-1.5 rounded bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-200 hover:text-white text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                              >
                                <QrCode className="w-3.5 h-3.5 text-[#E50914]" />
                                <span>QR Code</span>
                              </button>
                              {t.status === 'paid' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCheckinInput(t.code);
                                    setActiveModule('checkin');
                                  }}
                                  title="Enviar código para o leitor de check-in"
                                  className="px-2.5 py-1.5 rounded bg-[#E50914]/20 hover:bg-[#E50914] text-white text-[11px] font-bold cursor-pointer"
                                >
                                  Validar
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* MODULE 7: PEDIDOS (public.orders) */}
          {activeModule === 'orders' && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-white">
                    Pedidos Registrados (<code className="text-sm text-neutral-300">public.orders</code>)
                  </h2>
                  <p className="text-xs text-neutral-400">
                    A confirmação de pagamento é realizada exclusivamente pelo backend oficial e webhook do Mercado Pago (sem aprovação manual).
                  </p>
                </div>
              </div>

              {ordersFeedback && (
                <div
                  className={`rounded-xl p-3.5 border flex items-start justify-between gap-3 text-xs ${
                    ordersFeedback.type === 'success'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-[#E50914]/10 border-[#E50914]/40 text-neutral-200'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    {ordersFeedback.type === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
                    )}
                    <span>{ordersFeedback.message}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOrdersFeedback(null)}
                    className="text-neutral-400 hover:text-white shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={orderSearch}
                    onChange={(e) => setOrderSearch(e.target.value)}
                    placeholder="Buscar por código do pedido (#PX-...), cliente, e-mail ou evento..."
                    className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white focus:outline-none focus:border-[#E50914]"
                  />
                </div>

                <select
                  aria-label="Filtrar pedidos por status"
                  value={orderStatusFilter}
                  onChange={(e) => setOrderStatusFilter(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white focus:outline-none focus:border-[#E50914]"
                >
                  <option value="all">Todos os pedidos ({orders.length})</option>
                  <option value="paid">Pagos (paid)</option>
                  <option value="pending">Reservados / Aguardando (reserved / pending_payment)</option>
                  <option value="cancelled_expired">Cancelados / Expirados</option>
                  <option value="refunded">Reembolsados (refunded)</option>
                </select>
              </div>

              <div className="overflow-x-auto rounded-xl border border-[#242838] bg-[#12151E]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#222636] text-[11px] text-neutral-400 uppercase">
                      <th className="py-3.5 px-4">Pedido</th>
                      <th className="py-3.5 px-4">Cliente</th>
                      <th className="py-3.5 px-4">Evento & Lote</th>
                      <th className="py-3.5 px-4">Qtd</th>
                      <th className="py-3.5 px-4">Subtotal + Taxa 6%</th>
                      <th className="py-3.5 px-4">Total Final</th>
                      <th className="py-3.5 px-4">Método</th>
                      <th className="py-3.5 px-4">Status</th>
                      <th className="py-3.5 px-4 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D2130]">
                    {filteredOrders.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-8 px-4 text-center text-neutral-400">
                          Nenhum pedido encontrado em <code className="text-neutral-300">public.orders</code>.
                        </td>
                      </tr>
                    ) : (
                      filteredOrders.map((o) => {
                        const qty = o.items[0]?.quantity ?? 1;
                        const lotName = o.items[0]?.lotName ?? 'Lote';
                        return (
                          <tr key={o.id} className="hover:bg-[#171B26] transition-colors">
                            <td className="py-3 px-4 font-mono-tabular">
                              <span className="font-bold text-[#E50914]">{o.orderCode}</span>
                              <span className="block text-[10px] text-neutral-400">
                                {o.createdAt}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              <p className="font-bold text-white">{o.buyerName}</p>
                              <p className="text-[11px] text-neutral-400">{o.buyerEmail}</p>
                            </td>
                            <td className="py-3 px-4">
                              <p className="font-semibold text-white">{o.eventTitle}</p>
                              <p className="text-[11px] text-neutral-400">{lotName}</p>
                            </td>
                            <td className="py-3 px-4 font-mono-tabular font-bold text-white">
                              {qty}x
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-[11px] text-neutral-300">
                              <span className="block">Sub: {formatBRL(o.subtotal)}</span>
                              <span className="block text-neutral-400">
                                Taxa 6%: {formatBRL(o.convenienceFee)}
                              </span>
                            </td>
                            <td className="py-3 px-4 font-mono-tabular font-bold text-white">
                              {formatBRL(o.totalAmount)}
                            </td>
                            <td className="py-3 px-4">
                              <span className="px-2 py-0.5 rounded bg-[#181B26] border border-[#2C3144] text-[11px] font-mono-tabular font-semibold text-neutral-200">
                                {o.paymentMethod === 'pix' ? 'PIX' : 'Cartão de Crédito'}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              <span
                                className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                                  o.status === 'paid'
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : o.status === 'reserved' || o.status === 'pending_payment'
                                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                    : 'bg-neutral-500/20 text-neutral-300 border border-neutral-500/30'
                                }`}
                              >
                                {o.status === 'paid'
                                  ? 'Pago (Aprovado)'
                                  : o.status === 'reserved' || o.status === 'pending_payment'
                                  ? 'Aguardando Pagamento'
                                  : o.status === 'cancelled'
                                  ? 'Cancelado'
                                  : o.status === 'expired'
                                  ? 'Expirado'
                                  : 'Reembolsado'}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => setInspectingOrder(o)}
                                className="px-2.5 py-1.5 rounded bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-200 hover:text-white text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5 text-[#E50914]" />
                                <span>Detalhes</span>
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* MODULE 8: PAGAMENTOS (Conciliação Mercado Pago — PIX & Cartão de Crédito com Taxa 6%) */}
          {activeModule === 'payments' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-bold text-white">
                  Conciliação de Pagamentos — Mercado Pago
                </h2>
                <p className="text-xs text-neutral-400">
                  Histórico financeiro oficial diferenciando PIX e Cartão de Crédito, preservando a taxa única de serviço de 6% e validação exclusiva via API/Webhook do Mercado Pago.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-3.5 space-y-1">
                  <span className="text-[11px] text-neutral-400">Total Aprovado (Geral)</span>
                  <p className="text-lg font-extrabold text-emerald-400 font-mono-tabular">
                    {formatBRL(totalApprovedRevenue)}
                  </p>
                </div>
                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-3.5 space-y-1">
                  <span className="text-[11px] text-neutral-400">Aprovado via PIX</span>
                  <p className="text-lg font-extrabold text-white font-mono-tabular">
                    {formatBRL(totalApprovedPixRevenue)}
                  </p>
                </div>
                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-3.5 space-y-1">
                  <span className="text-[11px] text-neutral-400">Aprovado via Cartão de Crédito</span>
                  <p className="text-lg font-extrabold text-white font-mono-tabular">
                    {formatBRL(totalApprovedCardRevenue)}
                  </p>
                </div>
                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-3.5 space-y-1">
                  <span className="text-[11px] text-neutral-400">Taxa de Serviço Retida (6%)</span>
                  <p className="text-lg font-extrabold text-[#E50914] font-mono-tabular">
                    {formatBRL(totalApprovedFee6Percent)}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={paymentSearch}
                    onChange={(e) => setPaymentSearch(e.target.value)}
                    placeholder="Buscar por ID Mercado Pago, pedido (#PX-...) ou comprador..."
                    className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white focus:outline-none focus:border-[#E50914]"
                  />
                </div>

                <select
                  aria-label="Filtrar pagamentos por método"
                  value={paymentMethodFilter}
                  onChange={(e) =>
                    setPaymentMethodFilter(e.target.value as 'all' | 'pix' | 'credit_card')
                  }
                  className="px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white focus:outline-none focus:border-[#E50914]"
                >
                  <option value="all">Todos os métodos (PIX + Cartão)</option>
                  <option value="pix">Somente PIX</option>
                  <option value="credit_card">Somente Cartão de Crédito</option>
                </select>

                <select
                  aria-label="Filtrar pagamentos por status"
                  value={paymentStatusFilter}
                  onChange={(e) => setPaymentStatusFilter(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white focus:outline-none focus:border-[#E50914]"
                >
                  <option value="all">Todos os status</option>
                  <option value="approved">Aprovados (approved)</option>
                  <option value="pending_in_process">Pendentes / Em Processo</option>
                  <option value="cancelled_rejected">Cancelados / Rejeitados</option>
                  <option value="refunded">Reembolsados (refunded)</option>
                </select>
              </div>

              <div className="overflow-x-auto rounded-xl border border-[#242838] bg-[#12151E]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#222636] text-[11px] text-neutral-400 uppercase">
                      <th className="py-3.5 px-4">ID Mercado Pago</th>
                      <th className="py-3.5 px-4">Pedido</th>
                      <th className="py-3.5 px-4">Comprador</th>
                      <th className="py-3.5 px-4">Método</th>
                      <th className="py-3.5 px-4">Subtotal</th>
                      <th className="py-3.5 px-4">Taxa (6%)</th>
                      <th className="py-3.5 px-4">Total Cobrado</th>
                      <th className="py-3.5 px-4">Status MP</th>
                      <th className="py-3.5 px-4 text-right">Detalhes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D2130]">
                    {filteredPayments.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-8 px-4 text-center text-neutral-400">
                          Nenhum registro de pagamento encontrado para os filtros selecionados.
                        </td>
                      </tr>
                    ) : (
                      filteredPayments.map((o) => {
                        const pStatus =
                          o.paymentStatus ?? (o.status === 'paid' ? 'approved' : 'pending');
                        return (
                          <tr key={o.id} className="hover:bg-[#171B26] transition-colors">
                            <td className="py-3 px-4 font-mono-tabular">
                              <span className="font-bold text-white">
                                {o.mpPaymentId || 'Aguardando geração'}
                              </span>
                              {o.mpPreferenceId && (
                                <span className="block text-[10px] text-neutral-500 truncate max-w-[160px]">
                                  Pref: {o.mpPreferenceId}
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 font-mono-tabular font-bold text-[#E50914]">
                              {o.orderCode}
                            </td>
                            <td className="py-3 px-4 text-white">{o.buyerName}</td>
                            <td className="py-3 px-4">
                              <span
                                className={`px-2 py-0.5 rounded text-[11px] font-mono-tabular font-bold ${
                                  o.paymentMethod === 'pix'
                                    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                    : 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                                }`}
                              >
                                {o.paymentMethod === 'pix' ? 'PIX' : 'Cartão de Crédito'}
                              </span>
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-neutral-300">
                              {formatBRL(o.subtotal)}
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-neutral-300">
                              {formatBRL(o.convenienceFee)}
                            </td>
                            <td className="py-3 px-4 font-mono-tabular font-bold text-white">
                              {formatBRL(o.totalAmount)}
                            </td>
                            <td className="py-3 px-4">
                              <span
                                className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                                  pStatus === 'approved'
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : pStatus === 'pending' || pStatus === 'in_process'
                                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                    : 'bg-neutral-500/20 text-neutral-300 border border-neutral-500/30'
                                }`}
                              >
                                {pStatus === 'approved'
                                  ? 'approved (Webhook)'
                                  : pStatus}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => setInspectingOrder(o)}
                                className="px-2.5 py-1.5 rounded bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-200 hover:text-white text-[11px] font-semibold cursor-pointer"
                              >
                                Ver Pedido
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* MODULE 9: CLIENTES & OPERADORES (public.profiles) */}
          {(activeModule === 'customers' || activeModule === 'operators') && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-white">
                    {activeModule === 'customers'
                      ? 'Clientes Cadastrados (public.profiles)'
                      : 'Operadores de Check-in e Administradores'}
                  </h2>
                  <p className="text-xs text-neutral-400">
                    {activeModule === 'customers'
                      ? 'Exibição com proteção de CPF e consulta direta ao histórico de pedidos e ingressos de cada cliente.'
                      : 'Contas autorizadas com permissão de portaria ou administração (nenhum usuário administrativo é criado automaticamente).'}
                  </p>
                </div>
              </div>

              {activeModule === 'customers' && (
                <div className="relative max-w-md">
                  <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    placeholder="Buscar cliente por nome, e-mail, telefone ou cidade..."
                    className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white focus:outline-none focus:border-[#E50914]"
                  />
                </div>
              )}

              <div className="overflow-x-auto rounded-xl border border-[#242838] bg-[#12151E]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#222636] text-[11px] text-neutral-400 uppercase">
                      <th className="py-3.5 px-4">Nome</th>
                      <th className="py-3.5 px-4">E-mail</th>
                      <th className="py-3.5 px-4">Telefone</th>
                      <th className="py-3.5 px-4">CPF (Protegido)</th>
                      <th className="py-3.5 px-4">Cidade</th>
                      <th className="py-3.5 px-4">Papel RLS</th>
                      <th className="py-3.5 px-4 text-right">Histórico</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D2130]">
                    {filteredCustomers.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 px-4 text-center text-neutral-400">
                          Nenhum registro encontrado em <code className="text-neutral-300">public.profiles</code>.
                        </td>
                      </tr>
                    ) : (
                      filteredCustomers.map((c) => {
                        const custOrdersCount = orders.filter((o) => o.userId === c.id).length;
                        const custTicketsCount = tickets.filter((t) => t.userId === c.id).length;
                        return (
                          <tr key={c.id} className="hover:bg-[#171B26] transition-colors">
                            <td className="py-3 px-4 font-bold text-white">{c.fullName}</td>
                            <td className="py-3 px-4 text-neutral-300">{c.email}</td>
                            <td className="py-3 px-4 font-mono-tabular text-neutral-300">
                              {c.phone || 'Não informado'}
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-neutral-300">
                              {maskCpfForPrivacy(c.cpf)}
                            </td>
                            <td className="py-3 px-4 text-neutral-300">{c.city || '—'}</td>
                            <td className="py-3 px-4 font-mono-tabular text-[#E50914] font-semibold">
                              {c.role}
                            </td>
                            <td className="py-3 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => {
                                  setRevealCustomerCpf(false);
                                  setInspectingCustomer(c);
                                }}
                                className="px-2.5 py-1.5 rounded bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-200 hover:text-white text-[11px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5 text-[#E50914]" />
                                <span>
                                  Pedidos ({custOrdersCount}) · Ingressos ({custTicketsCount})
                                </span>
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* MODULE 10: RELATÓRIOS & CONFIGURAÇÕES */}
          {(activeModule === 'reports' || activeModule === 'settings') && (
            <div className="space-y-6">
              {activeModule === 'settings' && (
                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-base font-bold text-white">
                        Diagnóstico Seguro de Conexão — Supabase
                      </h2>
                      <p className="text-xs text-neutral-400">
                        Verificação de conectividade em tempo real sem expor URLs, chaves ou tokens.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleRunSupabaseCheck}
                      disabled={checkingSupabase}
                      className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-60 text-white text-xs font-bold transition-colors cursor-pointer"
                    >
                      {checkingSupabase ? 'Verificando...' : 'Testar Conexão Supabase'}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                    <div className="rounded-lg bg-[#0E1017] border border-[#222636] p-3.5 space-y-1">
                      <span className="text-neutral-400 block">Variáveis Públicas</span>
                      <span
                        className={`font-bold flex items-center gap-1.5 ${
                          supabaseConfigState.isConfigured ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        {supabaseConfigState.isConfigured ? (
                          <>
                            <CheckCircle2 className="w-4 h-4 shrink-0" />
                            <span>Configuradas (Seguras)</span>
                          </>
                        ) : (
                          <>
                            <XCircle className="w-4 h-4 shrink-0" />
                            <span>Pendentes</span>
                          </>
                        )}
                      </span>
                    </div>

                    <div className="rounded-lg bg-[#0E1017] border border-[#222636] p-3.5 space-y-1">
                      <span className="text-neutral-400 block">Supabase Auth</span>
                      <span
                        className={`font-bold ${
                          supabaseStatus?.authStatus === 'ok'
                            ? 'text-emerald-400'
                            : supabaseStatus?.authStatus === 'error'
                            ? 'text-[#E50914]'
                            : 'text-neutral-300'
                        }`}
                      >
                        {supabaseStatus?.authStatus === 'ok'
                          ? 'Autenticado e Operacional'
                          : supabaseStatus?.authStatus === 'error'
                          ? 'Falha na Verificação'
                          : 'Aguardando teste'}
                      </span>
                    </div>

                    <div className="rounded-lg bg-[#0E1017] border border-[#222636] p-3.5 space-y-1">
                      <span className="text-neutral-400 block">Banco PostgreSQL / REST</span>
                      <span
                        className={`font-bold ${
                          supabaseStatus?.databaseStatus === 'ready' ||
                          supabaseStatus?.databaseStatus === 'schema_pending'
                            ? 'text-emerald-400'
                            : supabaseStatus?.databaseStatus === 'error'
                            ? 'text-[#E50914]'
                            : 'text-neutral-300'
                        }`}
                      >
                        {supabaseStatus?.databaseStatus === 'ready'
                          ? 'Conectado (Tabelas Ativas)'
                          : supabaseStatus?.databaseStatus === 'schema_pending'
                          ? 'Conectado (Schema Pendente)'
                          : supabaseStatus?.databaseStatus === 'error'
                          ? 'Indisponível'
                          : 'Aguardando teste'}
                      </span>
                    </div>

                    <div className="rounded-lg bg-[#0E1017] border border-[#222636] p-3.5 space-y-1">
                      <span className="text-neutral-400 block">Latência / Último Teste</span>
                      <span className="font-mono-tabular font-bold text-white block">
                        {supabaseStatus?.latencyMs != null
                          ? `${supabaseStatus.latencyMs} ms · ${supabaseStatus.checkedAt}`
                          : '—'}
                      </span>
                    </div>
                  </div>

                  {supabaseStatus && (
                    <div
                      className={`rounded-lg p-3 border text-xs ${
                        supabaseStatus.reachable
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                          : 'bg-[#E50914]/10 border-[#E50914]/30 text-neutral-200'
                      }`}
                    >
                      {supabaseStatus.summary}
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-4">
                <h2 className="text-lg font-bold text-white">
                  Relatórios Financeiros & Logs de Auditoria (<code className="text-sm text-neutral-300">public.audit_logs</code>)
                </h2>
                {auditLogs.length === 0 ? (
                  <div className="rounded-xl bg-[#131620] border border-[#25293A] p-6 text-xs text-neutral-400 text-center">
                    Nenhum registro em <code className="text-neutral-300">public.audit_logs</code> no momento.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {auditLogs.map((log) => (
                      <div
                        key={log.id}
                        className="rounded-xl bg-[#131620] border border-[#25293A] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                      >
                        <div>
                          <span className="font-bold text-white">{log.actorName}</span>{' '}
                          <span className="text-neutral-400">({log.actorRole})</span> —{' '}
                          <span className="text-neutral-200">{log.action}</span>
                        </div>
                        <span className="font-mono-tabular text-neutral-400">{log.timestamp}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modal: Cadastrar / Editar Categoria (public.ticket_categories via admin_save_ticket_category) */}
      {showCategoryModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label={categoryForm.id ? 'Editar Categoria' : 'Nova Categoria'}
        >
          <div className="w-full max-w-lg rounded-2xl bg-[#11131A] border border-[#2C3144] p-5 sm:p-6 space-y-4 my-8">
            <div className="flex items-center justify-between border-b border-[#1E2230] pb-3">
              <div>
                <h3 className="font-display text-xl font-bold text-white">
                  {categoryForm.id ? 'Editar Categoria de Ingresso' : 'Nova Categoria de Ingresso'}
                </h3>
                <p className="text-[11px] text-neutral-400">
                  Persistência transacional via <code className="text-neutral-300">admin_save_ticket_category</code>.
                </p>
              </div>
              <button
                type="button"
                onClick={() => !isSavingCategory && setShowCategoryModal(false)}
                className="text-neutral-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {categoryModalError && (
              <div className="rounded-xl bg-[#E50914]/15 border border-[#E50914]/40 p-3 text-xs text-neutral-100 flex items-start gap-2.5">
                <XCircle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
                <span>{categoryModalError}</span>
              </div>
            )}

            <form onSubmit={handleSaveCategory} noValidate className="space-y-3.5 text-xs">
              <div>
                <label htmlFor="cat-event" className="block text-neutral-300 mb-1">
                  Evento ao qual a categoria pertence *
                </label>
                <select
                  id="cat-event"
                  value={categoryForm.eventId}
                  disabled={Boolean(categoryForm.id)}
                  onChange={(e) => setCategoryForm({ ...categoryForm, eventId: e.target.value })}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white disabled:opacity-60 focus:outline-none focus:border-[#E50914]"
                >
                  <option value="">Selecione um evento...</option>
                  {events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.title} ({ev.dateFormatted})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="cat-name" className="block text-neutral-300 mb-1">
                    Nome da Categoria *
                  </label>
                  <input
                    id="cat-name"
                    type="text"
                    value={categoryForm.name}
                    onChange={(e) => handleCategoryNameChange(e.target.value)}
                    placeholder="Ex: Pista, VIP, Expositor"
                    required
                    className={`w-full px-3.5 py-2 rounded-lg bg-[#161924] border text-sm text-white focus:outline-none ${
                      categoryFieldErrors.name
                        ? 'border-[#E50914]'
                        : 'border-[#2B3042] focus:border-[#E50914]'
                    }`}
                  />
                </div>

                <div>
                  <label htmlFor="cat-slug" className="block text-neutral-300 mb-1">
                    Slug Identificador *
                  </label>
                  <input
                    id="cat-slug"
                    type="text"
                    value={categoryForm.slug}
                    onChange={(e) => {
                      setCategorySlugManuallyEdited(true);
                      setCategoryForm({ ...categoryForm, slug: e.target.value });
                    }}
                    placeholder="pista"
                    required
                    className="w-full px-3.5 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914]"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="cat-desc" className="block text-neutral-300 mb-1">
                  Descrição (opcional)
                </label>
                <input
                  id="cat-desc"
                  type="text"
                  value={categoryForm.description}
                  onChange={(e) =>
                    setCategoryForm({ ...categoryForm, description: e.target.value })
                  }
                  placeholder="Ex: Acesso geral ao evento ou credencial para veículo + motorista"
                  className="w-full px-3.5 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914]"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div>
                  <label htmlFor="cat-max" className="block text-neutral-300 mb-1">
                    Limite por Pedido (1–50) *
                  </label>
                  <input
                    id="cat-max"
                    type="number"
                    min="1"
                    max="50"
                    step="1"
                    value={categoryForm.maxPerOrder}
                    onChange={(e) =>
                      setCategoryForm({ ...categoryForm, maxPerOrder: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914]"
                  />
                </div>

                <div>
                  <label htmlFor="cat-sort" className="block text-neutral-300 mb-1">
                    Ordem de Exibição *
                  </label>
                  <input
                    id="cat-sort"
                    type="number"
                    min="1"
                    step="1"
                    value={categoryForm.sortOrder}
                    onChange={(e) =>
                      setCategoryForm({ ...categoryForm, sortOrder: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914]"
                  />
                </div>

                <label className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={categoryForm.active}
                    onChange={(e) =>
                      setCategoryForm({ ...categoryForm, active: e.target.checked })
                    }
                    className="accent-[#E50914]"
                  />
                  <span className="text-neutral-200 font-semibold">Categoria Ativa</span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-[#1E2230]">
                <button
                  type="button"
                  disabled={isSavingCategory}
                  onClick={() => setShowCategoryModal(false)}
                  className="px-4 py-2 rounded-lg bg-[#181B24] hover:bg-[#222634] border border-[#2A2E3D] text-neutral-300 hover:text-white font-semibold cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSavingCategory}
                  className="px-5 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-60 text-white font-bold uppercase tracking-wider cursor-pointer"
                >
                  {isSavingCategory
                    ? 'Salvando...'
                    : categoryForm.id
                    ? 'Salvar Categoria'
                    : 'Criar Categoria'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Cadastrar / Editar Lote (public.ticket_batches via admin_save_ticket_batch) */}
      {showBatchModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label={batchForm.id ? 'Editar Lote' : 'Novo Lote'}
        >
          <div className="w-full max-w-xl rounded-2xl bg-[#11131A] border border-[#2C3144] p-5 sm:p-6 space-y-4 my-8">
            <div className="flex items-center justify-between border-b border-[#1E2230] pb-3">
              <div>
                <h3 className="font-display text-xl font-bold text-white">
                  {batchForm.id ? 'Editar Lote de Ingressos' : 'Novo Lote de Ingressos'}
                </h3>
                <p className="text-[11px] text-neutral-400">
                  Persistência transacional via <code className="text-neutral-300">admin_save_ticket_batch</code>.
                </p>
              </div>
              <button
                type="button"
                onClick={() => !isSavingBatch && setShowBatchModal(false)}
                className="text-neutral-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {batchModalError && (
              <div className="rounded-xl bg-[#E50914]/15 border border-[#E50914]/40 p-3 text-xs text-neutral-100 flex items-start gap-2.5">
                <XCircle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
                <span>{batchModalError}</span>
              </div>
            )}

            <form onSubmit={handleSaveBatch} noValidate className="space-y-3.5 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="bt-event" className="block text-neutral-300 mb-1">
                    Evento *
                  </label>
                  <select
                    id="bt-event"
                    value={batchForm.eventId}
                    disabled={Boolean(batchForm.id)}
                    onChange={(e) => handleBatchEventChange(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white disabled:opacity-60 focus:outline-none focus:border-[#E50914]"
                  >
                    <option value="">Selecione um evento...</option>
                    {events.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.title} (Cap.: {ev.capacity})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="bt-category" className="block text-neutral-300 mb-1">
                    Categoria do Ingresso *
                  </label>
                  <select
                    id="bt-category"
                    value={batchForm.categoryId}
                    onChange={(e) => setBatchForm({ ...batchForm, categoryId: e.target.value })}
                    className="w-full px-3.5 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914]"
                  >
                    <option value="">Selecione uma categoria...</option>
                    {ticketCategories
                      .filter((c) => c.event_id === batchForm.eventId)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} {c.active ? '' : '(Inativa)'}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              {batchForm.eventId &&
                ticketCategories.filter((c) => c.event_id === batchForm.eventId).length === 0 && (
                  <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 flex items-center justify-between gap-3">
                    <span className="text-amber-300">
                      Este evento ainda não possui categorias de ingresso cadastradas.
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setShowBatchModal(false);
                        setActiveModule('categories');
                        handleOpenCreateCategoryModal(batchForm.eventId);
                      }}
                      className="px-3 py-1.5 rounded bg-[#E50914] text-white font-bold shrink-0 cursor-pointer"
                    >
                      Criar Categoria
                    </button>
                  </div>
                )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label htmlFor="bt-name" className="block text-neutral-300 mb-1">
                    Nome do Lote *
                  </label>
                  <input
                    id="bt-name"
                    type="text"
                    value={batchForm.name}
                    onChange={(e) => setBatchForm({ ...batchForm, name: e.target.value })}
                    placeholder="Ex: Pista (1º Lote Promocional)"
                    required
                    className="w-full px-3.5 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914]"
                  />
                </div>

                <div>
                  <label htmlFor="bt-number" className="block text-neutral-300 mb-1">
                    Número do Lote *
                  </label>
                  <input
                    id="bt-number"
                    type="number"
                    min="1"
                    step="1"
                    value={batchForm.batchNumber}
                    onChange={(e) => setBatchForm({ ...batchForm, batchNumber: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914]"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="bt-desc" className="block text-neutral-300 mb-1">
                  Descrição do Lote (opcional)
                </label>
                <input
                  id="bt-desc"
                  type="text"
                  value={batchForm.description}
                  onChange={(e) => setBatchForm({ ...batchForm, description: e.target.value })}
                  placeholder="Ex: Acesso geral ao evento"
                  className="w-full px-3.5 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914]"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div>
                  <label htmlFor="bt-price" className="block text-neutral-300 mb-1">
                    Preço Unitário (R$) *
                  </label>
                  <input
                    id="bt-price"
                    type="number"
                    min="0"
                    step="0.01"
                    value={batchForm.price}
                    onChange={(e) => setBatchForm({ ...batchForm, price: e.target.value })}
                    placeholder="40.00"
                    required
                    className="w-full px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914]"
                  />
                </div>

                <div>
                  <label htmlFor="bt-qty" className="block text-neutral-300 mb-1">
                    Quantidade Total *
                  </label>
                  <input
                    id="bt-qty"
                    type="number"
                    min="1"
                    step="1"
                    value={batchForm.totalQuantity}
                    onChange={(e) => setBatchForm({ ...batchForm, totalQuantity: e.target.value })}
                    placeholder="500"
                    required
                    className="w-full px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914]"
                  />
                </div>

                <label className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={batchForm.active}
                    onChange={(e) => setBatchForm({ ...batchForm, active: e.target.checked })}
                    className="accent-[#E50914]"
                  />
                  <span className="text-neutral-200 font-semibold">Lote Ativo</span>
                </label>
              </div>

              <div className="rounded-lg bg-[#161924] border border-[#25293A] p-3 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-tabular">
                <span className="text-neutral-400">
                  Simulação Financeira (Regra 6%): Subtotal {formatBRL(batchModalPricePreview.subtotal)} + Taxa 6% ({formatBRL(batchModalPricePreview.convenienceFee)})
                </span>
                <span className="font-bold text-emerald-400">
                  Total Final ao Cliente: {formatBRL(batchModalPricePreview.total)}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="bt-starts" className="block text-neutral-300 mb-1">
                    Início das Vendas (opcional)
                  </label>
                  <input
                    id="bt-starts"
                    type="datetime-local"
                    value={batchForm.startsAt}
                    onChange={(e) => setBatchForm({ ...batchForm, startsAt: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white font-mono-tabular focus:outline-none focus:border-[#E50914]"
                  />
                </div>

                <div>
                  <label htmlFor="bt-ends" className="block text-neutral-300 mb-1">
                    Fim das Vendas (opcional)
                  </label>
                  <input
                    id="bt-ends"
                    type="datetime-local"
                    value={batchForm.endsAt}
                    onChange={(e) => setBatchForm({ ...batchForm, endsAt: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white font-mono-tabular focus:outline-none focus:border-[#E50914]"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-[#1E2230]">
                <button
                  type="button"
                  disabled={isSavingBatch}
                  onClick={() => setShowBatchModal(false)}
                  className="px-4 py-2 rounded-lg bg-[#181B24] hover:bg-[#222634] border border-[#2A2E3D] text-neutral-300 hover:text-white font-semibold cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSavingBatch}
                  className="px-5 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-60 text-white font-bold uppercase tracking-wider cursor-pointer"
                >
                  {isSavingBatch
                    ? 'Salvando...'
                    : batchForm.id
                    ? 'Salvar Lote'
                    : 'Criar Lote'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Inspeção de Ingresso & QR Code */}
      {inspectingTicket && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Detalhes do Ingresso e QR Code"
        >
          <div className="w-full max-w-md rounded-2xl bg-[#11131A] border border-[#2C3144] p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[#1E2230] pb-3">
              <div>
                <h3 className="font-display text-xl font-bold text-white">
                  Ingresso {inspectingTicket.code}
                </h3>
                <p className="text-[11px] text-neutral-400">{inspectingTicket.eventTitle}</p>
              </div>
              <button
                type="button"
                onClick={() => setInspectingTicket(null)}
                className="text-neutral-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex flex-col items-center justify-center bg-[#090A0E] border border-[#232736] rounded-xl p-4 space-y-2">
              <QRCodeVisual value={inspectingTicket.qrPayload || inspectingTicket.code} size={160} />
              <span className="font-mono-tabular text-xs font-bold text-[#E50914]">
                {inspectingTicket.code}
              </span>
            </div>

            <div className="space-y-2 text-xs border-t border-b border-[#1E2230] py-3">
              <div className="flex justify-between">
                <span className="text-neutral-400">Titular</span>
                <span className="font-bold text-white">{inspectingTicket.holderName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">CPF</span>
                <span className="font-mono-tabular text-neutral-200">
                  {formatCpfDisplay(inspectingTicket.holderCpf)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Lote / Categoria</span>
                <span className="text-neutral-200">{inspectingTicket.ticketTypeName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Valor Pago</span>
                <span className="font-mono-tabular font-bold text-white">
                  {formatBRL(inspectingTicket.pricePaid)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Pagamento MP</span>
                <span className="font-mono-tabular text-neutral-300">
                  {inspectingTicket.paymentId || '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Status</span>
                <span className="font-mono-tabular font-bold text-emerald-400">
                  {inspectingTicket.status}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              {inspectingTicket.status === 'paid' && (
                <button
                  type="button"
                  onClick={() => {
                    const code = inspectingTicket.code;
                    setInspectingTicket(null);
                    setCheckinInput(code);
                    setActiveModule('checkin');
                  }}
                  className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold cursor-pointer"
                >
                  Validar no Leitor de Check-in
                </button>
              )}
              <button
                type="button"
                onClick={() => setInspectingTicket(null)}
                className="px-4 py-2 rounded-lg bg-[#181B24] hover:bg-[#222634] border border-[#2A2E3D] text-xs font-semibold text-neutral-200 cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Detalhes do Pedido & Cancelamento Seguro de Reserva */}
      {inspectingOrder && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label="Detalhes do Pedido"
        >
          <div className="w-full max-w-xl rounded-2xl bg-[#11131A] border border-[#2C3144] p-5 sm:p-6 space-y-4 my-8">
            <div className="flex items-center justify-between border-b border-[#1E2230] pb-3">
              <div>
                <h3 className="font-display text-xl font-bold text-white">
                  Pedido {inspectingOrder.orderCode}
                </h3>
                <p className="text-[11px] text-neutral-400">
                  Registrado em {inspectingOrder.createdAt}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectingOrder(null)}
                className="text-neutral-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="rounded-xl bg-[#151822] border border-[#25293A] p-3.5 space-y-1.5">
                <span className="text-[11px] font-bold uppercase text-neutral-400">
                  Dados do Comprador
                </span>
                <p className="font-bold text-white">{inspectingOrder.buyerName}</p>
                <p className="text-neutral-300">{inspectingOrder.buyerEmail}</p>
                <p className="font-mono-tabular text-neutral-300">
                  Tel: {inspectingOrder.buyerPhone}
                </p>
                <p className="font-mono-tabular text-neutral-300">
                  CPF: {formatCpfDisplay(inspectingOrder.buyerCpf)}
                </p>
              </div>

              <div className="rounded-xl bg-[#151822] border border-[#25293A] p-3.5 space-y-1.5">
                <span className="text-[11px] font-bold uppercase text-neutral-400">
                  Resumo Financeiro (Taxa 6%)
                </span>
                <div className="flex justify-between">
                  <span className="text-neutral-400">Subtotal:</span>
                  <span className="font-mono-tabular text-white">
                    {formatBRL(inspectingOrder.subtotal)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-400">Taxa de Serviço (6%):</span>
                  <span className="font-mono-tabular text-white">
                    {formatBRL(inspectingOrder.convenienceFee)}
                  </span>
                </div>
                <div className="flex justify-between border-t border-[#25293A] pt-1 font-bold">
                  <span className="text-white">Total Cobrado:</span>
                  <span className="font-mono-tabular text-emerald-400">
                    {formatBRL(inspectingOrder.totalAmount)}
                  </span>
                </div>
                <p className="text-[11px] font-mono-tabular text-neutral-400 pt-1">
                  Meio: {inspectingOrder.paymentMethod === 'pix' ? 'PIX' : 'Cartão de Crédito'} · MP ID:{' '}
                  {inspectingOrder.mpPaymentId || 'Pendente'}
                </p>
              </div>
            </div>

            <div className="space-y-2 text-xs">
              <span className="text-[11px] font-bold uppercase text-neutral-400">
                Ingressos Emitidos para este Pedido
              </span>
              {tickets.filter((t) => t.orderId === inspectingOrder.id).length === 0 ? (
                <div className="rounded-lg bg-[#0E1017] border border-[#222636] p-3 text-neutral-400">
                  Nenhum ingresso emitido ainda (ingressos só são emitidos após confirmação oficial do pagamento pelo Mercado Pago).
                </div>
              ) : (
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {tickets
                    .filter((t) => t.orderId === inspectingOrder.id)
                    .map((t) => (
                      <div
                        key={t.id}
                        className="rounded-lg bg-[#0E1017] border border-[#222636] p-2.5 flex items-center justify-between"
                      >
                        <span className="font-mono-tabular font-bold text-[#E50914]">
                          {t.code}
                        </span>
                        <span className="text-neutral-300">{t.ticketTypeName}</span>
                        <span className="font-mono-tabular text-emerald-400">{t.status}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#1E2230]">
              {(inspectingOrder.status === 'reserved' ||
                inspectingOrder.status === 'pending_payment') &&
              onCancelOrder ? (
                <button
                  type="button"
                  disabled={isProcessingOrderAction}
                  onClick={() => handleCancelOrderReservation(inspectingOrder)}
                  className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-50 text-white text-xs font-bold cursor-pointer"
                >
                  {isProcessingOrderAction
                    ? 'Cancelando Reserva...'
                    : 'Cancelar Reserva Não Paga'}
                </button>
              ) : (
                <span className="text-[11px] text-neutral-400">
                  Status do pedido: <strong className="text-white">{inspectingOrder.status}</strong>
                </span>
              )}

              <button
                type="button"
                onClick={() => setInspectingOrder(null)}
                className="px-4 py-2 rounded-lg bg-[#181B24] hover:bg-[#222634] border border-[#2A2E3D] text-xs font-semibold text-neutral-200 cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Histórico do Cliente (Pedidos e Ingressos vinculados) */}
      {inspectingCustomer && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label="Histórico do Cliente"
        >
          <div className="w-full max-w-2xl rounded-2xl bg-[#11131A] border border-[#2C3144] p-5 sm:p-6 space-y-4 my-8 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#1E2230] pb-3">
              <div>
                <h3 className="font-display text-xl font-bold text-white">
                  Cliente: {inspectingCustomer.fullName}
                </h3>
                <p className="text-[11px] text-neutral-400">
                  Cadastro em {inspectingCustomer.createdAt} · Papel: {inspectingCustomer.role}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectingCustomer(null)}
                className="text-neutral-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="rounded-xl bg-[#151822] border border-[#25293A] p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div>
                <span className="text-neutral-400 block">E-mail</span>
                <span className="font-semibold text-white">{inspectingCustomer.email}</span>
              </div>
              <div>
                <span className="text-neutral-400 block">Telefone / Cidade</span>
                <span className="font-semibold text-white">
                  {inspectingCustomer.phone || '—'} · {inspectingCustomer.city || '—'}
                </span>
              </div>
              <div>
                <span className="text-neutral-400 block">CPF</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono-tabular font-bold text-white">
                    {revealCustomerCpf
                      ? formatCpfDisplay(inspectingCustomer.cpf)
                      : maskCpfForPrivacy(inspectingCustomer.cpf)}
                  </span>
                  {inspectingCustomer.cpf && (
                    <button
                      type="button"
                      onClick={() => setRevealCustomerCpf(!revealCustomerCpf)}
                      className="text-[11px] text-[#E50914] hover:underline cursor-pointer"
                    >
                      {revealCustomerCpf ? 'Ocultar' : 'Mostrar'}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-2 text-xs">
              <h4 className="font-bold text-white uppercase tracking-wider">
                Pedidos do Cliente ({orders.filter((o) => o.userId === inspectingCustomer.id).length})
              </h4>
              {orders.filter((o) => o.userId === inspectingCustomer.id).length === 0 ? (
                <div className="rounded-lg bg-[#0E1017] border border-[#222636] p-3 text-neutral-400">
                  Nenhum pedido registrado para este cliente.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto">
                  {orders
                    .filter((o) => o.userId === inspectingCustomer.id)
                    .map((o) => (
                      <div
                        key={o.id}
                        className="rounded-lg bg-[#0E1017] border border-[#222636] p-3 flex flex-wrap items-center justify-between gap-2"
                      >
                        <div>
                          <span className="font-mono-tabular font-bold text-[#E50914]">
                            {o.orderCode}
                          </span>{' '}
                          · <span className="text-white font-semibold">{o.eventTitle}</span>
                        </div>
                        <div className="font-mono-tabular text-neutral-300">
                          {formatBRL(o.totalAmount)} ({o.paymentMethod === 'pix' ? 'PIX' : 'Cartão'}) ·{' '}
                          <span className="font-bold text-white">{o.status}</span>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>

            <div className="space-y-2 text-xs">
              <h4 className="font-bold text-white uppercase tracking-wider">
                Ingressos Emitidos ({tickets.filter((t) => t.userId === inspectingCustomer.id).length})
              </h4>
              {tickets.filter((t) => t.userId === inspectingCustomer.id).length === 0 ? (
                <div className="rounded-lg bg-[#0E1017] border border-[#222636] p-3 text-neutral-400">
                  Nenhum ingresso emitido para este cliente.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto">
                  {tickets
                    .filter((t) => t.userId === inspectingCustomer.id)
                    .map((t) => (
                      <div
                        key={t.id}
                        className="rounded-lg bg-[#0E1017] border border-[#222636] p-3 flex flex-wrap items-center justify-between gap-2"
                      >
                        <div>
                          <span className="font-mono-tabular font-bold text-[#E50914]">
                            {t.code}
                          </span>{' '}
                          · <span className="text-white">{t.eventTitle}</span> ({t.ticketTypeName})
                        </div>
                        <span className="font-mono-tabular font-bold text-emerald-400">
                          {t.status}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-[#1E2230]">
              <button
                type="button"
                onClick={() => setInspectingCustomer(null)}
                className="px-4 py-2 rounded-lg bg-[#181B24] hover:bg-[#222634] border border-[#2A2E3D] text-xs font-semibold text-neutral-200 cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Cadastrar / Editar Evento em public.events */}
      {showEventModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label={editingEventId ? 'Editar Evento' : 'Cadastrar Novo Evento'}
        >
          <div className="w-full max-w-2xl rounded-2xl bg-[#11131A] border border-[#2C3144] p-5 sm:p-6 space-y-4 my-8 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#1E2230] pb-3">
              <div>
                <h3 className="font-display text-xl font-bold text-white">
                  {editingEventId ? 'Editar Evento no PX CONTROL' : 'Cadastrar Novo Evento'}
                </h3>
                <p className="text-[11px] text-neutral-400">
                  Os dados serão validados e gravados diretamente na tabela{' '}
                  <span className="font-mono-tabular text-neutral-300">public.events</span> do Supabase.
                </p>
              </div>
              <button
                type="button"
                onClick={() => !isSavingEvent && setShowEventModal(false)}
                aria-label="Fechar modal"
                className="text-neutral-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="rounded-xl bg-[#E50914]/15 border border-[#E50914]/40 p-3 text-xs text-neutral-100 flex items-start gap-2.5">
                <XCircle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleSaveEvent} noValidate className="space-y-3.5 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="ev-title" className="block text-neutral-300 mb-1">
                    Nome do Evento *
                  </label>
                  <input
                    id="ev-title"
                    type="text"
                    value={eventForm.title}
                    onChange={(e) => handleTitleChange(e.target.value)}
                    placeholder="Ex: Encontro Noturno PX CUSTON"
                    required
                    className={`w-full px-3.5 py-2 rounded-lg bg-[#161924] border text-sm text-white focus:outline-none ${
                      modalFieldErrors.title
                        ? 'border-[#E50914]'
                        : 'border-[#2B3042] focus:border-[#E50914]'
                    }`}
                  />
                </div>

                <div>
                  <label htmlFor="ev-subtitle" className="block text-neutral-300 mb-1">
                    Subtítulo / Edição (opcional)
                  </label>
                  <input
                    id="ev-subtitle"
                    type="text"
                    value={eventForm.subtitle}
                    onChange={(e) => setEventForm({ ...eventForm, subtitle: e.target.value })}
                    placeholder="Ex: Edição Oficial Interlagos"
                    className="w-full px-3.5 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="ev-slug" className="block text-neutral-300 mb-1">
                    Slug Único (URL) *
                  </label>
                  <input
                    id="ev-slug"
                    type="text"
                    value={eventForm.slug}
                    onChange={(e) => {
                      setSlugManuallyEdited(true);
                      setEventForm({ ...eventForm, slug: e.target.value });
                    }}
                    placeholder="encontro-noturno-px-custon"
                    required
                    className={`w-full px-3.5 py-2 rounded-lg bg-[#161924] border text-sm text-white font-mono-tabular focus:outline-none ${
                      modalFieldErrors.slug
                        ? 'border-[#E50914]'
                        : 'border-[#2B3042] focus:border-[#E50914]'
                    }`}
                  />
                </div>

                <div>
                  <label htmlFor="ev-category" className="block text-neutral-300 mb-1">
                    Categoria Automotiva *
                  </label>
                  <select
                    id="ev-category"
                    value={eventForm.categoryId}
                    onChange={(e) => setEventForm({ ...eventForm, categoryId: e.target.value })}
                    className="w-full px-3.5 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914]"
                  >
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label htmlFor="ev-date" className="block text-neutral-300 mb-1">
                    Data (DD/MM/AAAA) *
                  </label>
                  <input
                    id="ev-date"
                    type="text"
                    value={eventForm.dateInput}
                    onChange={(e) => setEventForm({ ...eventForm, dateInput: e.target.value })}
                    placeholder="25/04/2026"
                    required
                    className={`w-full px-3 py-2 rounded-lg bg-[#161924] border text-sm text-white font-mono-tabular focus:outline-none ${
                      modalFieldErrors.dateInput
                        ? 'border-[#E50914]'
                        : 'border-[#2B3042] focus:border-[#E50914]'
                    }`}
                  />
                </div>

                <div>
                  <label htmlFor="ev-time" className="block text-neutral-300 mb-1">
                    Horário *
                  </label>
                  <input
                    id="ev-time"
                    type="text"
                    value={eventForm.timeRange}
                    onChange={(e) => setEventForm({ ...eventForm, timeRange: e.target.value })}
                    placeholder="10:00 às 22:00"
                    required
                    className={`w-full px-3 py-2 rounded-lg bg-[#161924] border text-sm text-white font-mono-tabular focus:outline-none ${
                      modalFieldErrors.timeRange
                        ? 'border-[#E50914]'
                        : 'border-[#2B3042] focus:border-[#E50914]'
                    }`}
                  />
                </div>

                <div>
                  <label htmlFor="ev-status" className="block text-neutral-300 mb-1">
                    Status no Banco *
                  </label>
                  <select
                    id="ev-status"
                    value={eventForm.status}
                    onChange={(e) =>
                      setEventForm({ ...eventForm, status: e.target.value as EventStatus })
                    }
                    className="w-full px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914]"
                  >
                    <option value="Rascunho">Rascunho (draft)</option>
                    <option value="Publicado">Publicado (published)</option>
                    <option value="Encerrado">Encerrado (ended)</option>
                    <option value="Cancelado">Cancelado (cancelled)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="ev-city" className="block text-neutral-300 mb-1">
                    Cidade / UF *
                  </label>
                  <input
                    id="ev-city"
                    type="text"
                    value={eventForm.city}
                    onChange={(e) => setEventForm({ ...eventForm, city: e.target.value })}
                    placeholder="Ex: São Paulo - SP"
                    required
                    className={`w-full px-3.5 py-2 rounded-lg bg-[#161924] border text-sm text-white focus:outline-none ${
                      modalFieldErrors.city
                        ? 'border-[#E50914]'
                        : 'border-[#2B3042] focus:border-[#E50914]'
                    }`}
                  />
                </div>

                <div>
                  <label htmlFor="ev-venue" className="block text-neutral-300 mb-1">
                    Local / Arena *
                  </label>
                  <input
                    id="ev-venue"
                    type="text"
                    value={eventForm.venueName}
                    onChange={(e) => setEventForm({ ...eventForm, venueName: e.target.value })}
                    placeholder="Ex: Autódromo de Interlagos"
                    required
                    className={`w-full px-3.5 py-2 rounded-lg bg-[#161924] border text-sm text-white focus:outline-none ${
                      modalFieldErrors.venueName
                        ? 'border-[#E50914]'
                        : 'border-[#2B3042] focus:border-[#E50914]'
                    }`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div>
                  <label htmlFor="ev-price" className="block text-neutral-300 mb-1">
                    Preço Inicial (R$) *
                  </label>
                  <input
                    id="ev-price"
                    type="number"
                    min="0"
                    step="0.01"
                    value={eventForm.startingPrice}
                    onChange={(e) =>
                      setEventForm({ ...eventForm, startingPrice: e.target.value })
                    }
                    placeholder="40.00"
                    required
                    className={`w-full px-3 py-2 rounded-lg bg-[#161924] border text-sm text-white font-mono-tabular focus:outline-none ${
                      modalFieldErrors.startingPrice
                        ? 'border-[#E50914]'
                        : 'border-[#2B3042] focus:border-[#E50914]'
                    }`}
                  />
                </div>

                <div>
                  <label htmlFor="ev-capacity" className="block text-neutral-300 mb-1">
                    Capacidade Total *
                  </label>
                  <input
                    id="ev-capacity"
                    type="number"
                    min="1"
                    step="1"
                    value={eventForm.capacity}
                    onChange={(e) => setEventForm({ ...eventForm, capacity: e.target.value })}
                    placeholder="1500"
                    required
                    className={`w-full px-3 py-2 rounded-lg bg-[#161924] border text-sm text-white font-mono-tabular focus:outline-none ${
                      modalFieldErrors.capacity
                        ? 'border-[#E50914]'
                        : 'border-[#2B3042] focus:border-[#E50914]'
                    }`}
                  />
                </div>

                <label className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={eventForm.featured}
                    onChange={(e) => setEventForm({ ...eventForm, featured: e.target.checked })}
                    className="accent-[#E50914]"
                  />
                  <span className="text-neutral-200 font-semibold">Evento em Destaque</span>
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="ev-banner" className="block text-neutral-300 mb-1">
                    Imagem do Banner (URL ou caminho) *
                  </label>
                  <input
                    id="ev-banner"
                    type="text"
                    value={eventForm.bannerUrl}
                    onChange={(e) => setEventForm({ ...eventForm, bannerUrl: e.target.value })}
                    placeholder="/assets/events/hero-banner-full.jpg"
                    required
                    className={`w-full px-3 py-2 rounded-lg bg-[#161924] border text-xs text-white font-mono-tabular focus:outline-none ${
                      modalFieldErrors.bannerUrl
                        ? 'border-[#E50914]'
                        : 'border-[#2B3042] focus:border-[#E50914]'
                    }`}
                  />
                </div>

                <div>
                  <label htmlFor="ev-card-img" className="block text-neutral-300 mb-1">
                    Imagem do Card (URL ou caminho) *
                  </label>
                  <input
                    id="ev-card-img"
                    type="text"
                    value={eventForm.cardImageUrl}
                    onChange={(e) => setEventForm({ ...eventForm, cardImageUrl: e.target.value })}
                    placeholder="/assets/events/ev-rebaixados.jpg"
                    required
                    className={`w-full px-3 py-2 rounded-lg bg-[#161924] border text-xs text-white font-mono-tabular focus:outline-none ${
                      modalFieldErrors.cardImageUrl
                        ? 'border-[#E50914]'
                        : 'border-[#2B3042] focus:border-[#E50914]'
                    }`}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="ev-description" className="block text-neutral-300 mb-1">
                  Descrição Oficial do Evento *
                </label>
                <textarea
                  id="ev-description"
                  rows={3}
                  value={eventForm.description}
                  onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })}
                  placeholder="Descreva a programação, regras de exposição de veículos, atrações e estrutura do evento..."
                  required
                  className={`w-full px-3.5 py-2 rounded-lg bg-[#161924] border text-sm text-white focus:outline-none ${
                    modalFieldErrors.description
                      ? 'border-[#E50914]'
                      : 'border-[#2B3042] focus:border-[#E50914]'
                  }`}
                />
              </div>

              <div>
                <label htmlFor="ev-highlights" className="block text-neutral-300 mb-1">
                  Destaques / Estrutura (um por linha ou separados por vírgula)
                </label>
                <textarea
                  id="ev-highlights"
                  rows={2}
                  value={eventForm.highlightsText}
                  onChange={(e) => setEventForm({ ...eventForm, highlightsText: e.target.value })}
                  placeholder="Ex: Expositores oficiais, Praça de alimentação, Estacionamento monitorado"
                  className="w-full px-3.5 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-white focus:outline-none focus:border-[#E50914]"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-[#1E2230]">
                <button
                  type="button"
                  disabled={isSavingEvent}
                  onClick={() => setShowEventModal(false)}
                  className="px-4 py-2.5 rounded-lg bg-[#181B24] hover:bg-[#222634] border border-[#2A2E3D] text-neutral-300 hover:text-white font-semibold cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSavingEvent}
                  className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-60 text-white font-bold text-xs uppercase tracking-wider cursor-pointer"
                >
                  {isSavingEvent
                    ? 'Salvando no Supabase...'
                    : editingEventId
                    ? 'Salvar Alterações no Supabase'
                    : 'Criar Evento no Supabase'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

