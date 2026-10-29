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
} from '../types/domain';
import { formatBRL, verifyAndProcessCheckin } from '../utils/ticketRules';
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
  onAddEvent: (ev: EventItem) => void;
  onToggleEventStatus: (eventId: string) => void;
  onDeleteEvent: (eventId: string) => void;
  onProcessCheckin: (updatedTicket: Ticket | undefined, record: CheckinRecord) => void;
  onSelectEventPublic: (ev: EventItem) => void;
}

export const AdminPanelView: React.FC<AdminPanelViewProps> = ({
  events,
  categories,
  tickets,
  orders,
  checkins,
  customers,
  auditLogs,
  onAddEvent,
  onToggleEventStatus,
  onDeleteEvent,
  onProcessCheckin,
  onSelectEventPublic,
}) => {
  const [activeModule, setActiveModule] = useState<AdminModule>('dashboard');
  const [periodFilter, setPeriodFilter] = useState<'7d' | '30d' | 'all'>('30d');

  // New Event Modal State
  const [showNewEventModal, setShowNewEventModal] = useState(false);
  const [newEventForm, setNewEventForm] = useState({
    title: '',
    city: 'São Paulo - SP',
    dateFormatted: '15/08/2025',
    startingPrice: '50',
    categoryId: 'cat-carros',
    status: 'Publicado' as EventStatus,
  });

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

  const handleCreateEvent = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEventForm.title.trim()) return;
    const parts = newEventForm.dateFormatted.split('/');
    const day = parts[0] || '15';
    const monthMap: Record<string, string> = {
      '01': 'JAN',
      '02': 'FEV',
      '03': 'MAR',
      '04': 'ABR',
      '05': 'MAI',
      '06': 'JUN',
      '07': 'JUL',
      '08': 'AGO',
      '09': 'SET',
      '10': 'OUT',
      '11': 'NOV',
      '12': 'DEZ',
    };
    const monthShort = monthMap[parts[1] || '08'] || 'AGO';
    const year = parts[2] || '2025';
    const price = Number(newEventForm.startingPrice) || 50;

    const newEv: EventItem = {
      id: `evt-${Date.now()}`,
      slug: newEventForm.title.toLowerCase().replace(/\s+/g, '-'),
      title: newEventForm.title.trim(),
      subtitle: 'Evento Oficial PX CUSTON',
      categoryId: newEventForm.categoryId,
      categoryName:
        categories.find((c) => c.id === newEventForm.categoryId)?.name || 'Evento Automotivo',
      dateFormatted: newEventForm.dateFormatted,
      dayNumber: day,
      monthShort,
      year,
      timeRange: '10:00 às 22:00',
      city: newEventForm.city,
      venueName: `Arena Automotiva — ${newEventForm.city}`,
      startingPrice: price,
      bannerUrl: '/assets/events/hero-jetta.jpg',
      cardImageUrl: '/assets/events/ev-rebaixados.jpg',
      galleryUrls: [
        '/assets/events/gallery-1.jpg',
        '/assets/events/gallery-2.jpg',
        '/assets/events/gallery-3.jpg',
      ],
      description:
        'Evento oficial administrado pela equipe PX CUSTON com venda de ingressos QR Code e controle de portaria.',
      highlights: [
        '+2.000 visitantes esperados',
        'Expositores oficiais',
        'Praça de alimentação',
        'Segurança e estacionamento',
      ],
      status: newEventForm.status,
      featured: false,
      ticketsSold: 0,
      capacity: 1500,
      lots: [
        {
          id: `lot-${Date.now()}`,
          eventId: `evt-${Date.now()}`,
          name: 'Pista (1º Lote Promocional)',
          categoryLabel: 'Pista',
          batchNumber: 1,
          description: 'Acesso geral ao evento',
          price,
          totalQuantity: 1000,
          availableQuantity: 1000,
          thumbnailUrl: '/assets/events/gallery-1.jpg',
          active: true,
        },
      ],
    };

    onAddEvent(newEv);
    setShowNewEventModal(false);
    setNewEventForm({
      title: '',
      city: 'São Paulo - SP',
      dateFormatted: '15/08/2025',
      startingPrice: '50',
      categoryId: 'cat-carros',
      status: 'Publicado',
    });
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
            <p className="font-semibold text-white">Administrador</p>
            <p className="font-mono-tabular text-[10px] text-neutral-500">Role: SUPER_ADMIN</p>
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
                  setShowNewEventModal(true);
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
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-lg font-bold text-white">Gestão de Eventos</h2>
                <span className="text-xs text-neutral-400 font-mono-tabular">
                  {events.length} eventos cadastrados
                </span>
              </div>

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
                    {events.map((ev) => (
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
                          <p className="text-[11px] text-neutral-400">{ev.categoryName}</p>
                        </td>
                        <td className="py-3 px-4 font-mono-tabular text-neutral-300">
                          {ev.dateFormatted}
                        </td>
                        <td className="py-3 px-4 text-neutral-300">{ev.city}</td>
                        <td className="py-3 px-4">
                          <button
                            type="button"
                            onClick={() => onToggleEventStatus(ev.id)}
                            title="Clique para alternar status Publicado / Rascunho"
                            className={`px-2.5 py-1 rounded text-[11px] font-bold cursor-pointer ${
                              ev.status === 'Publicado'
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                : 'bg-[#E50914]/20 text-red-300 border border-[#E50914]/30'
                            }`}
                          >
                            {ev.status}
                          </button>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => onSelectEventPublic(ev)}
                              aria-label={`Visualizar página de ${ev.title}`}
                              className="p-1.5 rounded bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-300 hover:text-white"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onToggleEventStatus(ev.id)}
                              aria-label={`Alternar publicação de ${ev.title}`}
                              className="p-1.5 rounded bg-[#1B1F2C] hover:bg-[#252A3C] text-neutral-300 hover:text-white"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteEvent(ev.id)}
                              aria-label={`Remover evento ${ev.title}`}
                              className="p-1.5 rounded bg-[#1B1F2C] hover:bg-[#E50914] text-neutral-300 hover:text-white transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
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

      {/* Modal: + Novo Evento */}
      {showNewEventModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Cadastrar Novo Evento"
        >
          <div className="w-full max-w-md rounded-2xl bg-[#11131A] border border-[#2C3144] p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-[#1E2230] pb-3">
              <h3 className="font-display text-xl font-bold text-white">Cadastrar Novo Evento</h3>
              <button
                type="button"
                onClick={() => setShowNewEventModal(false)}
                aria-label="Fechar modal"
                className="text-neutral-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateEvent} className="space-y-3.5 text-xs">
              <div>
                <label htmlFor="ev-title" className="block text-neutral-300 mb-1">
                  Nome do Evento
                </label>
                <input
                  id="ev-title"
                  type="text"
                  value={newEventForm.title}
                  onChange={(e) => setNewEventForm({ ...newEventForm, title: e.target.value })}
                  placeholder="Ex: Encontro Noturno PX CUSTON"
                  required
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="ev-date" className="block text-neutral-300 mb-1">
                    Data (DD/MM/AAAA)
                  </label>
                  <input
                    id="ev-date"
                    type="text"
                    value={newEventForm.dateFormatted}
                    onChange={(e) =>
                      setNewEventForm({ ...newEventForm, dateFormatted: e.target.value })
                    }
                    required
                    className="w-full px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular"
                  />
                </div>
                <div>
                  <label htmlFor="ev-price" className="block text-neutral-300 mb-1">
                    1º Lote (R$)
                  </label>
                  <input
                    id="ev-price"
                    type="number"
                    value={newEventForm.startingPrice}
                    onChange={(e) =>
                      setNewEventForm({ ...newEventForm, startingPrice: e.target.value })
                    }
                    required
                    className="w-full px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="ev-city" className="block text-neutral-300 mb-1">
                  Cidade / UF
                </label>
                <input
                  id="ev-city"
                  type="text"
                  value={newEventForm.city}
                  onChange={(e) => setNewEventForm({ ...newEventForm, city: e.target.value })}
                  required
                  className="w-full px-3.5 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white"
                />
              </div>

              <button
                type="submit"
                className="w-full py-3 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white font-bold text-xs uppercase tracking-wider cursor-pointer"
              >
                Salvar Evento no PX CONTROL
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
