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
} from '../types/domain';
import {
  formatBRL,
  verifyAndProcessCheckin,
  generateEventSlug,
  validateAndBuildEventWritePayload,
} from '../utils/ticketRules';
import {
  supabaseConfigState,
  verifySupabaseConnection,
  type SupabaseConnectionStatus,
} from '../lib/supabase';
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

export const AdminPanelView: React.FC<AdminPanelViewProps> = ({
  events,
  categories,
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

  // Check-in Scanner State (PX CONTROL)
  const [checkinInput, setCheckinInput] = useState('PX-784592');
  const [lastCheckinResult, setLastCheckinResult] = useState<{
    authorized: boolean;
    statusReason: string;
    record: CheckinRecord;
  }>({
    authorized: true,
    statusReason: 'authorized',
    record: checkins[0] || {
      id: 'CHK-INIT',
      ticketId: 'tkt-01',
      ticketCode: 'PX-784592',
      eventTitle: 'Encontro Nacional de Carros Rebaixados',
      holderName: 'João da Silva',
      categoryName: 'Pista (1º Lote)',
      checkedInAt: '25/04/2025 14:32',
      operatorName: 'Carlos Souza',
      deviceId: 'PORTARIA-01',
      result: 'authorized',
      message: 'Entrada autorizada!',
    },
  });
  const [showCheckinHistory, setShowCheckinHistory] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

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

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const handleToggleCamera = async () => {
    if (cameraActive) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setCameraActive(false);
      return;
    }

    setCameraError(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        'Câmera indisponível neste navegador/ambiente. Utilize a validação manual por código abaixo.'
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      setCameraActive(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch {
      setCameraError(
        'Permissão de câmera não concedida ou dispositivo sem câmera ativa. Utilize a busca rápida por código.'
      );
      setCameraActive(false);
    }
  };

  const handleVerifyCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkinInput.trim()) return;
    const nowStr = new Date().toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const verification = verifyAndProcessCheckin(
      checkinInput,
      tickets,
      'Carlos Souza',
      nowStr
    );
    setLastCheckinResult({
      authorized: verification.authorized,
      statusReason: verification.statusReason,
      record: verification.checkinRecord,
    });
    onProcessCheckin(verification.updatedTicket, verification.checkinRecord);
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

  const allLots = events.flatMap((ev) =>
    ev.lots.map((lot) => ({ ...lot, eventTitle: ev.title, eventDate: ev.dateFormatted }))
  );

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
        {/* Left Sidebar Menu (Matches Reference Dashboard & Gestão de Eventos Sidebar) */}
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
          {/* Top Admin Context Header */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1E2230] pb-4">
            <div>
              <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-white tracking-wide">
                {sidebarItems.find((i) => i.id === activeModule)?.label || 'Dashboard'}
              </h1>
              <p className="text-xs text-neutral-400">
                PX CONTROL — Gestão exclusiva de eventos, lotes, pagamentos Mercado Pago e portaria QR
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveModule('checkin')}
                className="px-3.5 py-2 rounded-lg bg-[#171A24] hover:bg-[#222634] border border-[#2C3144] text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
              >
                <QrCode className="w-3.5 h-3.5 text-[#E50914]" />
                <span>Leitor Check-in</span>
              </button>
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
            </div>
          </div>

          {/* MODULE 1: DASHBOARD (Matches Middle-Right Reference Panel) */}
          {activeModule === 'dashboard' && (
            <div className="space-y-6">
              {/* Filter Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex items-center gap-1 bg-[#141720] border border-[#25293A] p-1 rounded-lg text-xs">
                  {[
                    { id: '7d', label: 'Últimos 7 dias' },
                    { id: '30d', label: 'Últimos 30 dias' },
                    { id: 'all', label: '01/04/2025 - 30/06/2025' },
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

              {/* 4 Financial & Operational KPIs (Exact Reference Values) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-4 space-y-2">
                  <span className="text-xs text-neutral-400">Vendas Totais</span>
                  <div className="text-xl sm:text-2xl font-extrabold text-white font-mono-tabular">
                    R$ 48.750,00
                  </div>
                  <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1 font-mono-tabular">
                    <TrendingUp className="w-3.5 h-3.5" />
                    <span>+12% no período</span>
                  </div>
                </div>

                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-4 space-y-2">
                  <span className="text-xs text-neutral-400">Pagamentos Aprovados</span>
                  <div className="text-xl sm:text-2xl font-extrabold text-white font-mono-tabular">
                    456
                  </div>
                  <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1 font-mono-tabular">
                    <TrendingUp className="w-3.5 h-3.5" />
                    <span>+8% via Pix e Cartão</span>
                  </div>
                </div>

                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-4 space-y-2">
                  <span className="text-xs text-neutral-400">Ingressos Emitidos</span>
                  <div className="text-xl sm:text-2xl font-extrabold text-white font-mono-tabular">
                    1.024
                  </div>
                  <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1 font-mono-tabular">
                    <TrendingUp className="w-3.5 h-3.5" />
                    <span>+15% lotes ativos</span>
                  </div>
                </div>

                <div className="rounded-xl bg-[#131620] border border-[#25293A] p-4 space-y-2">
                  <span className="text-xs text-neutral-400">Check-ins Realizados</span>
                  <div className="text-xl sm:text-2xl font-extrabold text-white font-mono-tabular">
                    892
                  </div>
                  <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1 font-mono-tabular">
                    <TrendingUp className="w-3.5 h-3.5" />
                    <span>+10% taxa de presença</span>
                  </div>
                </div>
              </div>

              {/* Vendas por dia Chart + Eventos em destaque */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Vendas por dia Area SVG Chart */}
                <div className="lg:col-span-7 rounded-xl bg-[#131620] border border-[#25293A] p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-bold text-white">Vendas por dia</h2>
                    <span className="text-xs text-neutral-400 font-mono-tabular">
                      Receita confirmada via Webhook MP
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
                        40k
                      </text>
                      <text x="4" y="74" fill="#737994" fontSize="10">
                        30k
                      </text>
                      <text x="4" y="114" fill="#737994" fontSize="10">
                        20k
                      </text>
                      <text x="4" y="154" fill="#737994" fontSize="10">
                        10k
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

                {/* Eventos em destaque List */}
                <div className="lg:col-span-5 rounded-xl bg-[#131620] border border-[#25293A] p-5 space-y-4">
                  <h2 className="text-sm font-bold text-white">Eventos em destaque</h2>

                  <div className="space-y-3">
                    {events.map((ev) => (
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
                              {ev.ticketsSold.toLocaleString('pt-BR')} ingressos
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
                </div>
              </div>
            </div>
          )}

          {/* MODULE 2: GESTÃO DE EVENTOS (Matches Bottom-Left Reference Panel) */}
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
                    {events.length} eventos no banco
                  </span>
                  {onRefreshAdminEvents && (
                    <button
                      type="button"
                      onClick={() => onRefreshAdminEvents()}
                      disabled={isLoadingAdminEvents}
                      className="px-3 py-1.5 rounded-lg bg-[#171A24] hover:bg-[#222634] border border-[#2C3144] text-xs font-semibold text-neutral-200 hover:text-white inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${
                          isLoadingAdminEvents ? 'animate-spin text-[#E50914]' : ''
                        }`}
                      />
                      <span>Atualizar</span>
                    </button>
                  )}
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

          {/* MODULE 3: CHECK-IN DE INGRESSOS (Matches Bottom-Center Reference Panel) */}
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
                  className="px-4 py-2 rounded-lg bg-[#171A24] hover:bg-[#212534] border border-[#2D3244] text-xs font-semibold text-white flex items-center gap-2 cursor-pointer"
                >
                  {cameraActive ? (
                    <>
                      <CameraOff className="w-4 h-4 text-[#E50914]" />
                      <span>Desativar Câmera</span>
                    </>
                  ) : (
                    <>
                      <Camera className="w-4 h-4 text-[#E50914]" />
                      <span>Ativar Câmera QR</span>
                    </>
                  )}
                </button>
              </div>

              {cameraError && (
                <div className="rounded-xl bg-[#18151B] border border-[#E50914]/40 p-3 text-xs text-neutral-200">
                  {cameraError}
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
                {/* Left: Escaneie o QR Code do ingresso Viewfinder */}
                <div className="lg:col-span-5 rounded-2xl bg-[#11131C] border border-[#232736] p-6 flex flex-col items-center justify-center space-y-4">
                  <p className="text-xs font-semibold text-neutral-300">
                    Escaneie o QR Code do ingresso
                  </p>

                  {/* Red-cornered QR Scanner Frame */}
                  <div className="relative w-52 h-52 flex items-center justify-center bg-[#090A0E] rounded-xl p-4">
                    {/* 4 Red Corner Brackets */}
                    <span className="absolute top-2 left-2 w-7 h-7 border-t-4 border-l-4 border-[#E50914] rounded-tl-md" />
                    <span className="absolute top-2 right-2 w-7 h-7 border-t-4 border-r-4 border-[#E50914] rounded-tr-md" />
                    <span className="absolute bottom-2 left-2 w-7 h-7 border-b-4 border-l-4 border-[#E50914] rounded-bl-md" />
                    <span className="absolute bottom-2 right-2 w-7 h-7 border-b-4 border-r-4 border-[#E50914] rounded-br-md" />

                    {cameraActive ? (
                      <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full object-cover rounded-lg"
                      />
                    ) : (
                      <QRCodeVisual value={checkinInput || 'PX-784592'} size={140} />
                    )}

                    {/* Horizontal laser scan line */}
                    <div className="absolute left-3 right-3 top-1/2 h-0.5 bg-[#E50914] shadow-[0_0_12px_#E50914]" />
                  </div>

                  {/* Quick Test Ticket Pills */}
                  <div className="w-full pt-2 space-y-1.5">
                    <span className="block text-[11px] text-neutral-400 text-center">
                      Códigos rápidos para testar validação na portaria:
                    </span>
                    <div className="flex flex-wrap justify-center gap-1.5">
                      {tickets.map((t) => (
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
                </div>

                {/* Right: Resultado da Verificação + Busca por código + Histórico */}
                <div className="lg:col-span-7 rounded-2xl bg-[#11131C] border border-[#232736] p-6 space-y-5">
                  {/* Verification Status Banner */}
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
                        {lastCheckinResult.authorized ? 'Entrada autorizada!' : 'Entrada bloqueada!'}
                      </h3>
                      <p className="text-xs text-neutral-300 mt-0.5">
                        {lastCheckinResult.record.message}
                      </p>
                    </div>
                  </div>

                  {/* Attendee & Ticket Metadata Table */}
                  <div className="space-y-2.5 text-xs border-t border-b border-[#1E2230] py-4">
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

                  {/* Buscar por código & Histórico Controls */}
                  <form onSubmit={handleVerifyCode} className="flex flex-wrap items-center gap-2.5">
                    <div className="relative flex-1 min-w-[200px]">
                      <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={checkinInput}
                        onChange={(e) => setCheckinInput(e.target.value)}
                        placeholder="Buscar por código (ex: PX-784592)"
                        aria-label="Buscar ingresso por código"
                        className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-[#171A24] border border-[#2C3144] text-xs font-mono-tabular text-white focus:outline-none focus:border-[#E50914]"
                      />
                    </div>
                    <button
                      type="submit"
                      className="px-4 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold cursor-pointer"
                    >
                      Validar Código
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

          {/* MODULE 4: CATEGORIAS */}
          {activeModule === 'categories' && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-white">Categorias de Eventos Automotivos</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {categories.map((cat) => (
                  <div
                    key={cat.id}
                    className="rounded-xl bg-[#131620] border border-[#25293A] p-4 flex items-center gap-4"
                  >
                    <div className="w-16 h-14 rounded-lg overflow-hidden shrink-0 border border-[#2E3346]">
                      <ResilientImage
                        src={cat.imageUrl}
                        alt={cat.name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-bold text-white truncate">{cat.name}</h3>
                      <p className="text-xs text-neutral-400 line-clamp-2">{cat.description}</p>
                      <span className="text-[11px] font-mono-tabular text-[#E50914] font-semibold">
                        {cat.eventCount} eventos vinculados
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* MODULE 5: LOTES */}
          {activeModule === 'lots' && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-white">Gestão de Lotes e Viradas</h2>
              <div className="overflow-x-auto rounded-xl border border-[#242838] bg-[#12151E]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#222636] text-[11px] text-neutral-400 uppercase">
                      <th className="py-3 px-4">Evento</th>
                      <th className="py-3 px-4">Lote / Categoria</th>
                      <th className="py-3 px-4">Preço</th>
                      <th className="py-3 px-4">Disponibilidade</th>
                      <th className="py-3 px-4">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D2130]">
                    {allLots.map((lot) => (
                      <tr key={lot.id}>
                        <td className="py-3 px-4 font-semibold text-white">{lot.eventTitle}</td>
                        <td className="py-3 px-4 text-neutral-200">{lot.name}</td>
                        <td className="py-3 px-4 font-mono-tabular font-bold text-white">
                          {formatBRL(lot.price)}
                        </td>
                        <td className="py-3 px-4 font-mono-tabular text-neutral-300">
                          {lot.availableQuantity} / {lot.totalQuantity}
                        </td>
                        <td className="py-3 px-4 text-emerald-400 font-semibold">Ativo</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* MODULE 6: INGRESSOS, PEDIDOS E PAGAMENTOS */}
          {(activeModule === 'tickets' ||
            activeModule === 'orders' ||
            activeModule === 'payments') && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-white">
                {activeModule === 'tickets'
                  ? 'Ingressos Emitidos'
                  : activeModule === 'orders'
                  ? 'Pedidos Registrados'
                  : 'Conciliação de Pagamentos (Mercado Pago)'}
              </h2>

              <div className="overflow-x-auto rounded-xl border border-[#242838] bg-[#12151E]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#222636] text-[11px] text-neutral-400 uppercase">
                      <th className="py-3 px-4">Código / ID</th>
                      <th className="py-3 px-4">Cliente</th>
                      <th className="py-3 px-4">Evento</th>
                      <th className="py-3 px-4">Valor</th>
                      <th className="py-3 px-4">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D2130]">
                    {orders.map((o) => (
                      <tr key={o.id}>
                        <td className="py-3 px-4 font-mono-tabular font-bold text-[#E50914]">
                          {o.orderCode} ({o.mpPaymentId || 'PENDENTE'})
                        </td>
                        <td className="py-3 px-4 text-white">
                          {o.buyerName} · <span className="text-neutral-400">{o.buyerCpf}</span>
                        </td>
                        <td className="py-3 px-4 text-neutral-300">{o.eventTitle}</td>
                        <td className="py-3 px-4 font-mono-tabular font-bold text-white">
                          {formatBRL(o.totalAmount)}
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`font-semibold ${
                              o.status === 'paid' ? 'text-emerald-400' : 'text-amber-400'
                            }`}
                          >
                            {o.status === 'paid' ? 'Aprovado (Webhook MP)' : 'Aguardando Pagamento'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* MODULE 7: CLIENTES & OPERADORES */}
          {(activeModule === 'customers' || activeModule === 'operators') && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-white">
                {activeModule === 'customers'
                  ? 'Base de Clientes (public.profiles)'
                  : 'Operadores de Check-in e Administradores'}
              </h2>
              <div className="overflow-x-auto rounded-xl border border-[#242838] bg-[#12151E]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#222636] text-[11px] text-neutral-400 uppercase">
                      <th className="py-3 px-4">Nome</th>
                      <th className="py-3 px-4">CPF</th>
                      <th className="py-3 px-4">E-mail</th>
                      <th className="py-3 px-4">Cidade</th>
                      <th className="py-3 px-4">Permissão RLS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D2130]">
                    {customers.map((c) => (
                      <tr key={c.id}>
                        <td className="py-3 px-4 font-bold text-white">{c.fullName}</td>
                        <td className="py-3 px-4 font-mono-tabular text-neutral-300">{c.cpf}</td>
                        <td className="py-3 px-4 text-neutral-300">{c.email}</td>
                        <td className="py-3 px-4 text-neutral-300">{c.city}</td>
                        <td className="py-3 px-4 font-mono-tabular text-[#E50914] font-semibold">
                          {c.role}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* MODULE 8: RELATÓRIOS & CONFIGURAÇÕES (Incluindo Verificação Segura do Supabase) */}
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
                  Relatórios Financeiros & Logs de Auditoria (`audit_logs`)
                </h2>
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
              </div>
            </div>
          )}
        </div>
      </div>

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

