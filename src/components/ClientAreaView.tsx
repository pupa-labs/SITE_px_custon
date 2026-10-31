import React, { useState } from 'react';
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
} from 'lucide-react';
import type { Ticket, Order, Profile } from '../types/domain';
import type { ClientSubTab } from './Navbar';
import { formatBRL } from '../utils/ticketRules';
import {
  signInWithSupabasePassword,
  signUpWithSupabase,
  requestPasswordResetInSupabase,
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
      onChangeSubTab('tickets');
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
        onChangeSubTab('tickets');
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

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10 space-y-8 pb-20">
      {/* Sub-navigation Tabs for Customer Area */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1E2230] pb-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-white uppercase tracking-wide">
            Área do Cliente PX CUSTON
          </h1>
          <p className="text-xs sm:text-sm text-neutral-400">
            Gerencie seus ingressos digitais QR Code, histórico de pedidos e dados de acesso.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 bg-[#11131A] border border-[#232736] p-1.5 rounded-xl">
          {[
            { id: 'tickets', label: 'Meus Ingressos', icon: TicketIcon },
            { id: 'orders', label: 'Meus Pedidos', icon: ShoppingBag },
            { id: 'login', label: isAuthenticated ? 'Minha Sessão' : 'Login', icon: LogIn },
            { id: 'register', label: 'Cadastro', icon: UserPlus },
            { id: 'recover', label: 'Recuperar Senha', icon: KeyRound },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeSubTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setAuthFeedback(null);
                  onChangeSubTab(tab.id as ClientSubTab);
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
                  Role: {currentUserProfile?.role ?? 'não verificado'}
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

          {onSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              className="px-4 py-2 rounded-lg bg-[#181B24] hover:bg-[#E50914]/20 border border-[#2A2E3D] hover:border-[#E50914]/50 text-xs font-bold text-white inline-flex items-center gap-1.5 self-start sm:self-auto cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5 text-[#E50914]" />
              <span>Encerrar Sessão</span>
            </button>
          )}
        </div>
      )}

      {/* 1. MEUS INGRESSOS (Matches Mobile Screen in Visual Reference) */}
      {activeSubTab === 'tickets' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <h2 className="font-display text-2xl font-bold text-white">Meus Ingressos</h2>

            {/* Segmented Filter: Ativos | Todos */}
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
          </div>

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
                              Utilizado {ticket.usedAt ? `em ${ticket.usedAt}` : ''}
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
        </div>
      )}

      {/* 2. MEUS PEDIDOS */}
      {activeSubTab === 'orders' && (
        <div className="space-y-4">
          <h2 className="font-display text-2xl font-bold text-white">Meus Pedidos</h2>

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
                    {ord.items.map((i) => `${i.quantity}x ${i.lotName}`).join(', ')} · Pagamento via{' '}
                    {ord.paymentMethod === 'pix' ? 'Pix' : 'Cartão de Crédito'}
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
                    ) : (
                      <span className="text-amber-400 flex items-center gap-1.5">
                        <Clock className="w-4 h-4" />
                        Aguardando Webhook MP
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. LOGIN */}
      {activeSubTab === 'login' && (
        <div className="max-w-md mx-auto rounded-2xl bg-[#11131A] border border-[#232736] p-6 sm:p-8 space-y-6">
          <div className="flex flex-col items-center text-center space-y-2">
            <BrandLogo size="md" />
            <h2 className="font-display text-2xl font-bold text-white">Acessar Minha Conta</h2>
            <p className="text-xs text-neutral-400">
              Autenticação integrada ao Supabase Auth com verificação de perfil em public.profiles.
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

          <p className="text-center text-xs text-neutral-400">
            Ainda não possui conta?{' '}
            <button
              type="button"
              onClick={() => {
                setAuthFeedback(null);
                onChangeSubTab('register');
              }}
              className="text-[#E50914] font-semibold hover:underline"
            >
              Criar cadastro
            </button>
          </p>
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
                placeholder="Ex: João da Silva"
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
                  {selectedTicketModal.orderId} ({selectedTicketModal.paymentId})
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
