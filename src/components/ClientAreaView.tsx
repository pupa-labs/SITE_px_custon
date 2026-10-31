import React, { useState, useEffect } from 'react';
import {
  Ticket as TicketIcon,
  ShoppingBag,
  LogIn,
  UserPlus,
  KeyRound,
  CheckCircle2,
  Clock,
  X,
  MapPin,
  Calendar,
  ShieldCheck,
  LogOut,
  AlertCircle,
  UserCheck,
  User,
  RefreshCw,
  Save,
} from 'lucide-react';
import type { Ticket, Order, Profile } from '../types/domain';
import type { ClientSubTab } from './Navbar';
import { formatBRL } from '../utils/ticketRules';
import {
  signInWithSupabasePassword,
  signUpWithSupabase,
  requestPasswordResetInSupabase,
  updateOwnProfileInSupabase,
} from '../services/platformService';
import { BrandLogo, QRCodeVisual, ResilientImage } from './BrandLogo';

interface ClientAreaViewProps {
  activeSubTab: ClientSubTab;
  onChangeSubTab: (tab: ClientSubTab) => void;
  tickets: Ticket[];
  orders: Order[];
  isAuthenticated?: boolean;
  authenticatedEmail?: string | null;
  currentUserProfile?: Profile | null;
  profileError?: string | null;
  isLoadingUserData?: boolean;
  userDataError?: string | null;
  onRefreshUserData?: () => Promise<void> | void;
  onGoToEvents?: () => void;
  onSignOut?: () => void;
  onAuthSessionUpdated?: () => Promise<void> | void;
}

export const ClientAreaView: React.FC<ClientAreaViewProps> = ({
  activeSubTab,
  onChangeSubTab,
  tickets,
  orders,
  isAuthenticated = false,
  authenticatedEmail = null,
  currentUserProfile = null,
  profileError = null,
  isLoadingUserData = false,
  userDataError = null,
  onRefreshUserData,
  onGoToEvents,
  onSignOut,
  onAuthSessionUpdated,
}) => {
  const [ticketFilter, setTicketFilter] = useState<'active' | 'all'>('active');
  const [selectedTicketModal, setSelectedTicketModal] = useState<Ticket | null>(null);

  // Real Supabase Auth form states
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [registerData, setRegisterData] = useState({
    fullName: '',
    cpf: '',
    email: '',
    phone: '',
    city: '',
    password: '',
  });
  const [recoverEmail, setRecoverEmail] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authFeedback, setAuthFeedback] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  // Profile self-update form state (for authenticated user)
  const [profileForm, setProfileForm] = useState({
    fullName: currentUserProfile?.fullName ?? '',
    phone: currentUserProfile?.phone ?? '',
    city: currentUserProfile?.city ?? '',
  });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    setProfileForm({
      fullName: currentUserProfile?.fullName ?? '',
      phone: currentUserProfile?.phone ?? '',
      city: currentUserProfile?.city ?? '',
    });
  }, [
    currentUserProfile?.id,
    currentUserProfile?.fullName,
    currentUserProfile?.phone,
    currentUserProfile?.city,
  ]);

  const visibleTickets =
    ticketFilter === 'active'
      ? tickets.filter((t) => t.status === 'paid')
      : tickets;

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthFeedback(null);

    if (!loginEmail.trim().includes('@') || !loginPassword) {
      setAuthFeedback({
        type: 'error',
        text: 'Preencha seu e-mail e senha para autenticar via Supabase Auth.',
      });
      return;
    }

    setAuthSubmitting(true);
    try {
      const result = await signInWithSupabasePassword(loginEmail, loginPassword);
      if (!result.ok) {
        setAuthFeedback({
          type: 'error',
          text: result.errorMessage ?? 'Falha ao autenticar no Supabase Auth.',
        });
        return;
      }

      setLoginPassword('');
      if (onAuthSessionUpdated) {
        await onAuthSessionUpdated();
      }

      const roleLabel = result.profile?.role ?? 'customer';
      setAuthFeedback({
        type: 'success',
        text: result.profile
          ? `Sessão autenticada para ${result.profile.fullName} (perfil verificado em public.profiles com papel "${roleLabel}").`
          : result.errorMessage ??
            'Sessão autenticada no Supabase Auth, porém o registro em public.profiles ainda não foi encontrado.',
      });
      onChangeSubTab('profile');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthFeedback(null);

    setAuthSubmitting(true);
    try {
      const result = await signUpWithSupabase({
        fullName: registerData.fullName,
        cpf: registerData.cpf,
        email: registerData.email,
        phone: registerData.phone,
        city: registerData.city,
        password: registerData.password,
      });

      if (!result.ok) {
        setAuthFeedback({
          type: 'error',
          text: result.message,
        });
        return;
      }

      setRegisterData((prev) => ({ ...prev, password: '' }));
      if (onAuthSessionUpdated) {
        await onAuthSessionUpdated();
      }

      setAuthFeedback({
        type: result.requiresEmailConfirmation ? 'info' : 'success',
        text: result.message,
      });

      if (!result.requiresEmailConfirmation) {
        onChangeSubTab('profile');
      }
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleRecoverSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthFeedback(null);

    if (!recoverEmail.trim().includes('@')) {
      setAuthFeedback({
        type: 'error',
        text: 'Informe o e-mail cadastrado para receber o link de redefinição.',
      });
      return;
    }

    setAuthSubmitting(true);
    try {
      const result = await requestPasswordResetInSupabase(recoverEmail);
      setAuthFeedback({
        type: result.ok ? 'success' : 'error',
        text: result.message,
      });
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleSaveProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileFeedback(null);
    setProfileSaving(true);
    try {
      const result = await updateOwnProfileInSupabase({
        fullName: profileForm.fullName,
        phone: profileForm.phone,
        city: profileForm.city,
      });
      if (!result.ok) {
        setProfileFeedback({
          type: 'error',
          text: result.message,
        });
        return;
      }
      if (onAuthSessionUpdated) {
        await onAuthSessionUpdated();
      }
      setProfileFeedback({
        type: 'success',
        text: result.message,
      });
    } catch {
      setProfileFeedback({
        type: 'error',
        text: 'Erro de comunicação ao salvar os dados do perfil no Supabase.',
      });
    } finally {
      setProfileSaving(false);
    }
  };

  const subTabs: { id: ClientSubTab; label: string; icon: React.ElementType }[] = isAuthenticated
    ? [
        { id: 'tickets', label: 'Meus Ingressos', icon: TicketIcon },
        { id: 'orders', label: 'Meus Pedidos', icon: ShoppingBag },
        { id: 'profile', label: 'Meu Perfil', icon: User },
      ]
    : [
        { id: 'tickets', label: 'Meus Ingressos', icon: TicketIcon },
        { id: 'orders', label: 'Meus Pedidos', icon: ShoppingBag },
        { id: 'login', label: 'Perfil / Login', icon: LogIn },
        { id: 'register', label: 'Cadastro', icon: UserPlus },
        { id: 'recover', label: 'Recuperar Senha', icon: KeyRound },
      ];

  const isProfileViewOpen =
    activeSubTab === 'profile' || (isAuthenticated && activeSubTab === 'login');
  const isVisitorLoginViewOpen =
    !isAuthenticated && (activeSubTab === 'login' || activeSubTab === 'profile');

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10 space-y-8 pb-20">
      {/* Sub-navigation Tabs for Customer Area */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1E2230] pb-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-white uppercase tracking-wide">
            Área do Cliente PX CUSTON
          </h1>
          <p className="text-xs sm:text-sm text-neutral-400">
            Gerencie seu perfil oficial, ingressos digitais QR Code e histórico de pedidos.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 bg-[#11131A] border border-[#232736] p-1.5 rounded-xl">
          {subTabs.map((tab) => {
            const Icon = tab.icon;
            const active =
              activeSubTab === tab.id ||
              (tab.id === 'profile' && isProfileViewOpen) ||
              (tab.id === 'login' && isVisitorLoginViewOpen);
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setAuthFeedback(null);
                  setProfileFeedback(null);
                  onChangeSubTab(tab.id);
                }}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-[#E50914] text-white shadow-[0_0_16px_rgba(229,9,20,0.35)]'
                    : 'text-neutral-400 hover:text-white hover:bg-[#191C26]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Authenticated Session Status Banner */}
      {isAuthenticated && (
        <div className="rounded-xl bg-[#11131A] border border-[#242838] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <UserCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-white">
                  {currentUserProfile?.fullName || authenticatedEmail || 'Usuário Autenticado'}
                </span>
                <span className="px-2 py-0.5 rounded bg-[#181B26] border border-[#2C3144] text-[10px] font-mono-tabular font-bold uppercase text-neutral-300">
                  Role: {currentUserProfile?.role ?? 'customer'}
                </span>
              </div>
              <p className="text-xs text-neutral-400">
                E-mail da sessão: <span className="text-neutral-200">{authenticatedEmail}</span>
              </p>
              {profileError && (
                <p className="text-xs text-amber-400 flex items-center gap-1.5 pt-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{profileError}</span>
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
            {!isProfileViewOpen && (
              <button
                type="button"
                onClick={() => onChangeSubTab('profile')}
                className="px-3.5 py-2 rounded-lg bg-[#171A24] hover:bg-[#222634] border border-[#2C3144] text-xs font-semibold text-white inline-flex items-center gap-1.5 cursor-pointer"
              >
                <User className="w-3.5 h-3.5 text-[#E50914]" />
                <span>Meu Perfil</span>
              </button>
            )}
            {onSignOut && (
              <button
                type="button"
                onClick={onSignOut}
                className="px-4 py-2 rounded-lg bg-[#181B24] hover:bg-[#E50914]/20 border border-[#2A2E3D] hover:border-[#E50914]/50 text-xs font-bold text-white inline-flex items-center gap-1.5 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5 text-[#E50914]" />
                <span>Encerrar Sessão</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 1. MEUS INGRESSOS */}
      {activeSubTab === 'tickets' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <h2 className="font-display text-2xl font-bold text-white">Meus Ingressos</h2>

            {isAuthenticated && (
              <div className="flex items-center gap-2">
                <div className="inline-flex items-center p-1 rounded-xl bg-[#11131A] border border-[#242838] w-full sm:w-72">
                  <button
                    type="button"
                    onClick={() => setTicketFilter('active')}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                      ticketFilter === 'active'
                        ? 'bg-[#E50914] text-white shadow'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Ativos ({tickets.filter((t) => t.status === 'paid').length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setTicketFilter('all')}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                      ticketFilter === 'all'
                        ? 'bg-[#E50914] text-white shadow'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Todos ({tickets.length})
                  </button>
                </div>

                {onRefreshUserData && (
                  <button
                    type="button"
                    onClick={() => onRefreshUserData()}
                    disabled={isLoadingUserData}
                    title="Atualizar ingressos do Supabase"
                    className="p-2.5 rounded-xl bg-[#11131A] hover:bg-[#191C26] border border-[#242838] text-neutral-300 hover:text-white disabled:opacity-50 cursor-pointer"
                  >
                    <RefreshCw
                      className={`w-4 h-4 ${isLoadingUserData ? 'animate-spin text-[#E50914]' : ''}`}
                    />
                  </button>
                )}
              </div>
            )}
          </div>

          {!isAuthenticated ? (
            <div className="rounded-2xl bg-[#11131A] border border-[#232736] p-8 sm:p-10 text-center space-y-4 max-w-2xl mx-auto">
              <div className="w-12 h-12 rounded-full bg-[#E50914]/15 border border-[#E50914]/30 flex items-center justify-center mx-auto text-[#E50914]">
                <TicketIcon className="w-6 h-6" />
              </div>
              <div className="space-y-1.5">
                <h3 className="font-display text-xl font-bold text-white">
                  Acesse sua conta para visualizar seus ingressos
                </h3>
                <p className="text-xs sm:text-sm text-neutral-400 max-w-md mx-auto leading-relaxed">
                  Seus ingressos nominais e códigos QR oficiais ficam protegidos e vinculados
                  exclusivamente ao seu perfil autenticado no Supabase.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => onChangeSubTab('login')}
                  className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold uppercase tracking-wider inline-flex items-center gap-2 cursor-pointer shadow-[0_0_20px_rgba(229,9,20,0.3)]"
                >
                  <LogIn className="w-4 h-4" />
                  <span>Entrar na Minha Conta</span>
                </button>
                <button
                  type="button"
                  onClick={() => onChangeSubTab('register')}
                  className="px-5 py-2.5 rounded-lg bg-[#171A24] hover:bg-[#222634] border border-[#2C3144] text-neutral-200 hover:text-white text-xs font-bold uppercase tracking-wider inline-flex items-center gap-2 cursor-pointer"
                >
                  <UserPlus className="w-4 h-4 text-[#E50914]" />
                  <span>Criar Cadastro</span>
                </button>
                {onGoToEvents && (
                  <button
                    type="button"
                    onClick={onGoToEvents}
                    className="px-4 py-2.5 rounded-lg bg-[#13151D] hover:bg-[#1B1E2A] border border-[#242838] text-neutral-300 hover:text-white text-xs font-semibold cursor-pointer"
                  >
                    Ver Eventos
                  </button>
                )}
              </div>
            </div>
          ) : isLoadingUserData && tickets.length === 0 ? (
            <div className="rounded-2xl bg-[#11131A] border border-[#232736] p-8 text-center space-y-3">
              <RefreshCw className="w-6 h-6 text-[#E50914] animate-spin mx-auto" />
              <p className="text-sm font-semibold text-white">
                Consultando seus ingressos em public.tickets...
              </p>
            </div>
          ) : userDataError ? (
            <div className="rounded-xl bg-[#18151B] border border-[#E50914]/40 p-4 flex items-center justify-between gap-3 text-xs text-neutral-200">
              <span>{userDataError}</span>
              {onRefreshUserData && (
                <button
                  type="button"
                  onClick={() => onRefreshUserData()}
                  className="px-3 py-1.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white font-bold shrink-0 cursor-pointer"
                >
                  Tentar novamente
                </button>
              )}
            </div>
          ) : visibleTickets.length === 0 ? (
            <div className="rounded-2xl bg-[#11131A] border border-[#232736] p-8 sm:p-10 text-center space-y-4 max-w-2xl mx-auto">
              <div className="w-12 h-12 rounded-full bg-[#171A24] border border-[#2C3144] flex items-center justify-center mx-auto text-neutral-400">
                <TicketIcon className="w-6 h-6" />
              </div>
              <div className="space-y-1.5">
                <h3 className="font-display text-xl font-bold text-white">
                  Você ainda não possui ingressos emitidos
                </h3>
                <p className="text-xs sm:text-sm text-neutral-400 max-w-md mx-auto leading-relaxed">
                  Assim que uma compra for confirmada pelo Mercado Pago, seus ingressos digitais com
                  QR Code aparecerão automaticamente aqui.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                {onGoToEvents && (
                  <button
                    type="button"
                    onClick={onGoToEvents}
                    className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold uppercase tracking-wider cursor-pointer shadow-[0_0_20px_rgba(229,9,20,0.3)]"
                  >
                    Explorar Eventos
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onChangeSubTab('orders')}
                  className="px-4 py-2.5 rounded-lg bg-[#171A24] hover:bg-[#222634] border border-[#2C3144] text-neutral-200 hover:text-white text-xs font-semibold cursor-pointer"
                >
                  Consultar Meus Pedidos
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {visibleTickets.map((ticket) => {
                const isValid = ticket.status === 'paid';
                return (
                  <article
                    key={ticket.id}
                    className="rounded-2xl overflow-hidden bg-[#11131A] border border-[#242838] hover:border-[#E50914]/60 transition-all flex flex-col justify-between"
                  >
                    <div>
                      <div className="relative h-40 bg-[#0B0C10]">
                        <ResilientImage
                          src={ticket.eventImageUrl}
                          alt={ticket.eventTitle}
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-[#11131A] via-transparent to-transparent" />
                      </div>

                      <div className="p-5 space-y-3">
                        <h3 className="text-lg font-bold text-white leading-snug">
                          {ticket.eventTitle}
                        </h3>
                        <p className="text-xs text-neutral-400 font-mono-tabular">
                          {ticket.eventDate} - {ticket.eventLocation}
                        </p>
                        <p className="text-xs font-semibold text-neutral-200">
                          {ticket.ticketTypeName}
                        </p>
                        <p className="text-xs text-neutral-400 font-mono-tabular">
                          Código: <strong className="text-white">{ticket.code}</strong>
                        </p>

                        <div className="pt-1">
                          {isValid ? (
                            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-400">
                              <CheckCircle2 className="w-4 h-4" />
                              <span>Válido</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-neutral-400">
                              <Clock className="w-4 h-4" />
                              <span>
                                {ticket.status === 'used'
                                  ? `Utilizado ${ticket.usedAt ? `em ${ticket.usedAt}` : ''}`
                                  : `Status: ${ticket.status}`}
                              </span>
                            </span>
                          )}
                        </div>

                        <div className="py-3 flex justify-center">
                          <QRCodeVisual value={ticket.qrPayload} size={132} />
                        </div>
                      </div>
                    </div>

                    <div className="px-5 pb-5">
                      <button
                        type="button"
                        onClick={() => setSelectedTicketModal(ticket)}
                        className="w-full py-2.5 rounded-lg bg-[#171A24] hover:bg-[#222634] border border-[#E50914]/40 text-xs font-bold text-white transition-colors cursor-pointer"
                      >
                        Ver detalhes
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 2. MEUS PEDIDOS */}
      {activeSubTab === 'orders' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-display text-2xl font-bold text-white">Meus Pedidos</h2>
            {isAuthenticated && onRefreshUserData && (
              <button
                type="button"
                onClick={() => onRefreshUserData()}
                disabled={isLoadingUserData}
                className="px-3 py-1.5 rounded-lg bg-[#11131A] hover:bg-[#191C26] border border-[#242838] text-xs font-semibold text-neutral-300 hover:text-white inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${isLoadingUserData ? 'animate-spin text-[#E50914]' : ''}`}
                />
                <span>Atualizar</span>
              </button>
            )}
          </div>

          {!isAuthenticated ? (
            <div className="rounded-2xl bg-[#11131A] border border-[#232736] p-8 sm:p-10 text-center space-y-4 max-w-2xl mx-auto">
              <div className="w-12 h-12 rounded-full bg-[#E50914]/15 border border-[#E50914]/30 flex items-center justify-center mx-auto text-[#E50914]">
                <ShoppingBag className="w-6 h-6" />
              </div>
              <div className="space-y-1.5">
                <h3 className="font-display text-xl font-bold text-white">
                  Faça login para consultar seus pedidos
                </h3>
                <p className="text-xs sm:text-sm text-neutral-400 max-w-md mx-auto leading-relaxed">
                  O histórico de pedidos, reservas e confirmações de pagamento via Mercado Pago é
                  exibido exclusivamente para o titular autenticado.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => onChangeSubTab('login')}
                  className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold uppercase tracking-wider inline-flex items-center gap-2 cursor-pointer shadow-[0_0_20px_rgba(229,9,20,0.3)]"
                >
                  <LogIn className="w-4 h-4" />
                  <span>Entrar na Minha Conta</span>
                </button>
                <button
                  type="button"
                  onClick={() => onChangeSubTab('register')}
                  className="px-5 py-2.5 rounded-lg bg-[#171A24] hover:bg-[#222634] border border-[#2C3144] text-neutral-200 hover:text-white text-xs font-bold uppercase tracking-wider inline-flex items-center gap-2 cursor-pointer"
                >
                  <UserPlus className="w-4 h-4 text-[#E50914]" />
                  <span>Criar Cadastro</span>
                </button>
              </div>
            </div>
          ) : isLoadingUserData && orders.length === 0 ? (
            <div className="rounded-2xl bg-[#11131A] border border-[#232736] p-8 text-center space-y-3">
              <RefreshCw className="w-6 h-6 text-[#E50914] animate-spin mx-auto" />
              <p className="text-sm font-semibold text-white">
                Consultando seus pedidos em public.orders...
              </p>
            </div>
          ) : orders.length === 0 ? (
            <div className="rounded-2xl bg-[#11131A] border border-[#232736] p-8 sm:p-10 text-center space-y-4 max-w-2xl mx-auto">
              <div className="w-12 h-12 rounded-full bg-[#171A24] border border-[#2C3144] flex items-center justify-center mx-auto text-neutral-400">
                <ShoppingBag className="w-6 h-6" />
              </div>
              <div className="space-y-1.5">
                <h3 className="font-display text-xl font-bold text-white">
                  Você ainda não possui pedidos registrados
                </h3>
                <p className="text-xs sm:text-sm text-neutral-400 max-w-md mx-auto leading-relaxed">
                  Quando você realizar uma reserva ou compra de ingresso em um evento publicado, o
                  status do pedido e do pagamento aparecerá aqui.
                </p>
              </div>
              {onGoToEvents && (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={onGoToEvents}
                    className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold uppercase tracking-wider cursor-pointer shadow-[0_0_20px_rgba(229,9,20,0.3)]"
                  >
                    Ver Eventos Publicados
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {orders.map((ord) => (
                <div
                  key={ord.id}
                  className="rounded-xl bg-[#11131A] border border-[#232736] p-5 flex flex-col md:flex-row md:items-center justify-between gap-4"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-extrabold font-mono-tabular text-[#E50914]">
                        {ord.orderCode}
                      </span>
                      <span className="text-xs text-neutral-400 font-mono-tabular">
                        Realizado em {ord.createdAt}
                      </span>
                    </div>
                    <h3 className="text-base font-bold text-white">{ord.eventTitle}</h3>
                    <p className="text-xs text-neutral-400">
                      {ord.items.map((i) => `${i.quantity}x ${i.lotName}`).join(', ')} · Pagamento
                      via {ord.paymentMethod === 'pix' ? 'Pix' : 'Cartão de Crédito'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-between md:justify-end gap-4 pt-3 md:pt-0 border-t md:border-t-0 border-[#1E2230]">
                    <div className="text-left md:text-right">
                      <span className="block text-[11px] text-neutral-400">Valor Total</span>
                      <span className="text-base font-extrabold font-mono-tabular text-white">
                        {formatBRL(ord.totalAmount)}
                      </span>
                    </div>

                    <div className="text-xs font-bold">
                      {ord.status === 'paid' ? (
                        <span className="text-emerald-400 flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4" />
                          Pago e Confirmado
                        </span>
                      ) : ord.status === 'cancelled' || ord.status === 'expired' ? (
                        <span className="text-neutral-400 flex items-center gap-1.5">
                          <Clock className="w-4 h-4" />
                          {ord.status === 'cancelled' ? 'Cancelado' : 'Expirado'}
                        </span>
                      ) : ord.status === 'refunded' ? (
                        <span className="text-amber-300 flex items-center gap-1.5">
                          <Clock className="w-4 h-4" />
                          Reembolsado
                        </span>
                      ) : (
                        <span className="text-amber-400 flex items-center gap-1.5">
                          <Clock className="w-4 h-4" />
                          Aguardando Confirmação MP
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 3A. MEU PERFIL (Authenticated User View) */}
      {isProfileViewOpen && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Account Details & Security Summary */}
          <div className="lg:col-span-5 rounded-2xl bg-[#11131A] border border-[#232736] p-6 space-y-5">
            <div className="flex items-center gap-3.5 border-b border-[#1E2230] pb-4">
              <div className="w-12 h-12 rounded-xl bg-[#E50914]/15 border border-[#E50914]/30 flex items-center justify-center text-[#E50914] shrink-0">
                <User className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <h2 className="font-display text-xl font-bold text-white truncate">
                  {currentUserProfile?.fullName || 'Meu Perfil'}
                </h2>
                <p className="text-xs text-neutral-400 truncate">
                  {authenticatedEmail || currentUserProfile?.email}
                </p>
              </div>
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between py-1.5 border-b border-[#1A1D28]">
                <span className="text-neutral-400">E-mail Autenticado</span>
                <span className="font-semibold text-white">
                  {authenticatedEmail || currentUserProfile?.email || '—'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-[#1A1D28]">
                <span className="text-neutral-400">CPF Vinculado</span>
                <span className="font-mono-tabular text-neutral-200">
                  {currentUserProfile?.cpf || 'Não informado'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-[#1A1D28]">
                <span className="text-neutral-400">Telefone</span>
                <span className="font-mono-tabular text-neutral-200">
                  {currentUserProfile?.phone || 'Não informado'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-[#1A1D28]">
                <span className="text-neutral-400">Cidade / UF</span>
                <span className="text-neutral-200">
                  {currentUserProfile?.city || 'Não informada'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-[#1A1D28]">
                <span className="text-neutral-400">Nível de Acesso (RLS)</span>
                <span className="font-mono-tabular font-bold text-[#E50914] uppercase">
                  {currentUserProfile?.role || 'customer'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-neutral-400">Cadastro desde</span>
                <span className="font-mono-tabular text-neutral-300">
                  {currentUserProfile?.createdAt || '—'}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => onChangeSubTab('tickets')}
                className="flex-1 py-2.5 px-3 rounded-lg bg-[#171A24] hover:bg-[#222634] border border-[#2C3144] text-xs font-semibold text-white text-center cursor-pointer"
              >
                Meus Ingressos ({tickets.length})
              </button>
              <button
                type="button"
                onClick={() => onChangeSubTab('orders')}
                className="flex-1 py-2.5 px-3 rounded-lg bg-[#171A24] hover:bg-[#222634] border border-[#2C3144] text-xs font-semibold text-white text-center cursor-pointer"
              >
                Meus Pedidos ({orders.length})
              </button>
            </div>
          </div>

          {/* Right Column: Editable Profile Fields in public.profiles */}
          <div className="lg:col-span-7 rounded-2xl bg-[#11131A] border border-[#232736] p-6 space-y-5">
            <div>
              <h3 className="font-display text-xl font-bold text-white">
                Editar Dados do Perfil
              </h3>
              <p className="text-xs text-neutral-400 mt-0.5">
                Atualize seus dados de contato registrados em{' '}
                <span className="font-mono-tabular text-neutral-300">public.profiles</span>.
              </p>
            </div>

            <form onSubmit={handleSaveProfileSubmit} className="space-y-4">
              <div>
                <label htmlFor="profile-fullname" className="block text-xs text-neutral-300 mb-1">
                  Nome completo
                </label>
                <input
                  id="profile-fullname"
                  type="text"
                  value={profileForm.fullName}
                  onChange={(e) => setProfileForm({ ...profileForm, fullName: e.target.value })}
                  placeholder="Seu nome completo"
                  required
                  disabled={profileSaving}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914] disabled:opacity-60"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="profile-phone" className="block text-xs text-neutral-300 mb-1">
                    Telefone / WhatsApp
                  </label>
                  <input
                    id="profile-phone"
                    type="tel"
                    value={profileForm.phone}
                    onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })}
                    placeholder="(11) 98765-4321"
                    disabled={profileSaving}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914] disabled:opacity-60"
                  />
                </div>

                <div>
                  <label htmlFor="profile-city" className="block text-xs text-neutral-300 mb-1">
                    Cidade / UF
                  </label>
                  <input
                    id="profile-city"
                    type="text"
                    value={profileForm.city}
                    onChange={(e) => setProfileForm({ ...profileForm, city: e.target.value })}
                    placeholder="Ex: São Paulo - SP"
                    disabled={profileSaving}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914] disabled:opacity-60"
                  />
                </div>
              </div>

              {profileFeedback && (
                <div
                  className={`text-xs rounded-lg p-3 border ${
                    profileFeedback.type === 'error'
                      ? 'bg-[#E50914]/10 border-[#E50914]/40 text-red-200'
                      : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200'
                  }`}
                >
                  {profileFeedback.text}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <button
                  type="submit"
                  disabled={profileSaving}
                  className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-60 text-white text-xs font-bold uppercase tracking-wider inline-flex items-center gap-2 cursor-pointer shadow-[0_0_20px_rgba(229,9,20,0.3)]"
                >
                  <Save className="w-4 h-4" />
                  <span>{profileSaving ? 'Salvando...' : 'Salvar Alterações'}</span>
                </button>

                {onSignOut && (
                  <button
                    type="button"
                    onClick={onSignOut}
                    className="px-4 py-2.5 rounded-lg bg-[#181B24] hover:bg-[#E50914]/20 border border-[#2A2E3D] hover:border-[#E50914]/50 text-xs font-bold text-neutral-200 hover:text-white inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <LogOut className="w-3.5 h-3.5 text-[#E50914]" />
                    <span>Sair da Conta</span>
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 3B. LOGIN / PERFIL (Visitor Unauthenticated View) */}
      {isVisitorLoginViewOpen && (
        <div className="max-w-md mx-auto rounded-2xl bg-[#11131A] border border-[#232736] p-6 sm:p-8 space-y-6">
          <div className="flex flex-col items-center text-center space-y-2">
            <BrandLogo size="md" />
            <h2 className="font-display text-2xl font-bold text-white">Acessar Minha Conta</h2>
            <p className="text-xs text-neutral-400">
              Entre com sua conta ou crie seu cadastro oficial para acessar seu perfil, pedidos e
              ingressos QR Code.
            </p>
          </div>

          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="block text-xs text-neutral-300 mb-1">
                E-mail
              </label>
              <input
                id="login-email"
                type="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                placeholder="seu@email.com"
                required
                disabled={authSubmitting}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914] disabled:opacity-60"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="login-password" className="block text-xs text-neutral-300">
                  Senha
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setAuthFeedback(null);
                    onChangeSubTab('recover');
                  }}
                  className="text-xs text-[#E50914] hover:underline"
                >
                  Esqueceu a senha?
                </button>
              </div>
              <input
                id="login-password"
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={authSubmitting}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914] disabled:opacity-60"
              />
            </div>

            {authFeedback && (
              <div
                className={`text-xs rounded-lg p-3 border ${
                  authFeedback.type === 'error'
                    ? 'bg-[#E50914]/10 border-[#E50914]/40 text-red-200'
                    : authFeedback.type === 'success'
                    ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200'
                    : 'bg-[#181B26] border-[#2E3446] text-neutral-200'
                }`}
              >
                {authFeedback.text}
              </div>
            )}

            <button
              type="submit"
              disabled={authSubmitting}
              className="w-full py-3 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-60 text-white font-bold text-sm uppercase tracking-wider transition-colors cursor-pointer"
            >
              {authSubmitting ? 'Autenticando...' : 'Entrar na Plataforma'}
            </button>
          </form>

          <div className="pt-2 border-t border-[#1E2230] flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-neutral-400">
            <span>Ainda não possui conta?</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setAuthFeedback(null);
                  onChangeSubTab('register');
                }}
                className="text-[#E50914] font-semibold hover:underline cursor-pointer"
              >
                Criar cadastro
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() => {
                  setAuthFeedback(null);
                  onChangeSubTab('recover');
                }}
                className="text-neutral-300 hover:text-white hover:underline cursor-pointer"
              >
                Recuperar senha
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. CADASTRO */}
      {activeSubTab === 'register' && (
        <div className="max-w-lg mx-auto rounded-2xl bg-[#11131A] border border-[#232736] p-6 sm:p-8 space-y-6">
          <div className="flex flex-col items-center text-center space-y-2">
            <BrandLogo size="md" />
            <h2 className="font-display text-2xl font-bold text-white">Criar Conta PX CUSTON</h2>
            <p className="text-xs text-neutral-400">
              Seus dados são vinculados diretamente ao perfil oficial para emissão de QR Codes.
            </p>
          </div>

          <form onSubmit={handleRegisterSubmit} className="space-y-3.5">
            <div>
              <label htmlFor="reg-name" className="block text-xs text-neutral-300 mb-1">
                Nome completo
              </label>
              <input
                id="reg-name"
                type="text"
                value={registerData.fullName}
                onChange={(e) => setRegisterData({ ...registerData, fullName: e.target.value })}
                placeholder="Informe seu nome completo"
                required
                disabled={authSubmitting}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914] disabled:opacity-60"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="reg-cpf" className="block text-xs text-neutral-300 mb-1">
                  CPF
                </label>
                <input
                  id="reg-cpf"
                  type="text"
                  value={registerData.cpf}
                  onChange={(e) => setRegisterData({ ...registerData, cpf: e.target.value })}
                  placeholder="000.000.000-00"
                  required
                  disabled={authSubmitting}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914] disabled:opacity-60"
                />
              </div>
              <div>
                <label htmlFor="reg-phone" className="block text-xs text-neutral-300 mb-1">
                  Telefone / WhatsApp
                </label>
                <input
                  id="reg-phone"
                  type="tel"
                  value={registerData.phone}
                  onChange={(e) => setRegisterData({ ...registerData, phone: e.target.value })}
                  placeholder="(11) 98765-4321"
                  required
                  disabled={authSubmitting}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914] disabled:opacity-60"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="reg-email" className="block text-xs text-neutral-300 mb-1">
                  E-mail
                </label>
                <input
                  id="reg-email"
                  type="email"
                  value={registerData.email}
                  onChange={(e) => setRegisterData({ ...registerData, email: e.target.value })}
                  placeholder="seu@email.com"
                  required
                  disabled={authSubmitting}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914] disabled:opacity-60"
                />
              </div>
              <div>
                <label htmlFor="reg-city" className="block text-xs text-neutral-300 mb-1">
                  Cidade / UF (opcional)
                </label>
                <input
                  id="reg-city"
                  type="text"
                  value={registerData.city}
                  onChange={(e) => setRegisterData({ ...registerData, city: e.target.value })}
                  placeholder="Ex: São Paulo - SP"
                  disabled={authSubmitting}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914] disabled:opacity-60"
                />
              </div>
            </div>

            <div>
              <label htmlFor="reg-password" className="block text-xs text-neutral-300 mb-1">
                Senha (mínimo 6 caracteres)
              </label>
              <input
                id="reg-password"
                type="password"
                value={registerData.password}
                onChange={(e) => setRegisterData({ ...registerData, password: e.target.value })}
                placeholder="••••••••"
                required
                disabled={authSubmitting}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914] disabled:opacity-60"
              />
            </div>

            {authFeedback && (
              <div
                className={`text-xs rounded-lg p-3 border ${
                  authFeedback.type === 'error'
                    ? 'bg-[#E50914]/10 border-[#E50914]/40 text-red-200'
                    : authFeedback.type === 'success'
                    ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200'
                    : 'bg-[#181B26] border-[#2E3446] text-neutral-200'
                }`}
              >
                {authFeedback.text}
              </div>
            )}

            <button
              type="submit"
              disabled={authSubmitting}
              className="w-full py-3 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-60 text-white font-bold text-sm uppercase tracking-wider transition-colors cursor-pointer"
            >
              {authSubmitting ? 'Cadastrando...' : 'Concluir Cadastro'}
            </button>
          </form>
        </div>
      )}

      {/* 5. RECUPERAÇÃO DE SENHA */}
      {activeSubTab === 'recover' && (
        <div className="max-w-md mx-auto rounded-2xl bg-[#11131A] border border-[#232736] p-6 sm:p-8 space-y-6">
          <div className="flex flex-col items-center text-center space-y-2">
            <BrandLogo size="md" />
            <h2 className="font-display text-2xl font-bold text-white">Recuperar Senha</h2>
            <p className="text-xs text-neutral-400">
              Informe seu e-mail para receber o link seguro de redefinição de senha.
            </p>
          </div>

          <form onSubmit={handleRecoverSubmit} className="space-y-4">
            <div>
              <label htmlFor="recover-email" className="block text-xs text-neutral-300 mb-1">
                E-mail cadastrado
              </label>
              <input
                id="recover-email"
                type="email"
                value={recoverEmail}
                onChange={(e) => setRecoverEmail(e.target.value)}
                placeholder="seu@email.com"
                required
                disabled={authSubmitting}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914] disabled:opacity-60"
              />
            </div>

            {authFeedback && (
              <div
                className={`text-xs rounded-lg p-3 border ${
                  authFeedback.type === 'error'
                    ? 'bg-[#E50914]/10 border-[#E50914]/40 text-red-200'
                    : authFeedback.type === 'success'
                    ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200'
                    : 'bg-[#181B26] border-[#2E3446] text-neutral-200'
                }`}
              >
                {authFeedback.text}
              </div>
            )}

            <button
              type="submit"
              disabled={authSubmitting}
              className="w-full py-3 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-60 text-white font-bold text-sm uppercase tracking-wider transition-colors cursor-pointer"
            >
              {authSubmitting ? 'Enviando...' : 'Enviar Link de Recuperação'}
            </button>
          </form>
        </div>
      )}

      {/* Ticket Detail Modal */}
      {selectedTicketModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Detalhes do Ingresso"
        >
          <div className="w-full max-w-md rounded-2xl bg-[#11131A] border border-[#2C3144] p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-[#1E2230] pb-3">
              <BrandLogo size="sm" />
              <button
                type="button"
                onClick={() => setSelectedTicketModal(null)}
                aria-label="Fechar detalhes do ingresso"
                className="text-neutral-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2 text-center">
              <h3 className="text-lg font-bold text-white">{selectedTicketModal.eventTitle}</h3>
              <p className="text-xs text-neutral-400 flex items-center justify-center gap-3">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-[#E50914]" />
                  {selectedTicketModal.eventDate}
                </span>
                <span className="flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-[#E50914]" />
                  {selectedTicketModal.eventLocation}
                </span>
              </p>
            </div>

            <div className="flex justify-center py-2">
              <QRCodeVisual value={selectedTicketModal.qrPayload} size={176} />
            </div>

            <div className="rounded-xl bg-[#0D0F15] border border-[#232736] p-3.5 space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-neutral-400">Código Único:</span>
                <span className="font-mono-tabular font-bold text-white">
                  {selectedTicketModal.code}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Titular:</span>
                <span className="font-semibold text-white">{selectedTicketModal.holderName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">CPF:</span>
                <span className="font-mono-tabular text-neutral-200">
                  {selectedTicketModal.holderCpf}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Lote / Categoria:</span>
                <span className="text-neutral-200">{selectedTicketModal.ticketTypeName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Pedido / Pagamento:</span>
                <span className="font-mono-tabular text-neutral-300">
                  {selectedTicketModal.orderId} ({selectedTicketModal.paymentId || 'PENDENTE'})
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 text-[11px] text-neutral-400 justify-center">
              <ShieldCheck className="w-4 h-4 text-[#E50914]" />
              <span>Apresente este QR Code na portaria para validação no PX CONTROL.</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

