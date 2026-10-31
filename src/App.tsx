/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  supabase,
  INITIAL_CATEGORIES,
  INITIAL_TICKETS,
  INITIAL_ORDERS,
  INITIAL_CHECKINS,
  INITIAL_CUSTOMERS,
  INITIAL_AUDIT_LOGS,
  fetchPublishedEventsFromSupabase,
  fetchAdminEventsFromSupabase,
  createEventInSupabase,
  updateEventInSupabase,
  updateEventStatusInSupabase,
  deleteEventInSupabase,
  computeCategoriesWithEventCounts,
  fetchAuthenticatedUserProfileFromSupabase,
  signOutFromSupabase,
} from './services/platformService';
import type {
  EventItem,
  TicketLot,
  Ticket,
  Order,
  CheckinRecord,
  Profile,
  AuthStatus,
  EventStatus,
  AdminEventFormInput,
} from './types/domain';
import { Navbar, type AppView, type ClientSubTab } from './components/Navbar';
import { HomeView } from './components/HomeView';
import { EventDetailView } from './components/EventDetailView';
import { CheckoutView } from './components/CheckoutView';
import { ClientAreaView } from './components/ClientAreaView';
import { AdminPanelView } from './components/AdminPanelView';
import { Footer } from './components/Footer';
import { BrandLogo, ResilientImage } from './components/BrandLogo';
import { useOnlineStatus } from './hooks/usePWAInstall';
import { MapPin, ShieldCheck, Mail, Phone, WifiOff, RefreshCw, AlertCircle } from 'lucide-react';
import { formatBRL, evaluateAdminAccess } from './utils/ticketRules';

export default function App() {
  const [activeView, setActiveView] = useState<AppView>('home');
  const [clientSubTab, setClientSubTab] = useState<ClientSubTab>('tickets');
  const [events, setEvents] = useState<EventItem[]>([]);
  const [eventsLoading, setEventsLoading] = useState<boolean>(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [adminEvents, setAdminEvents] = useState<EventItem[]>([]);
  const [adminEventsLoading, setAdminEventsLoading] = useState<boolean>(false);
  const [adminEventsError, setAdminEventsError] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Supabase Auth & Profile state
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');
  const [authenticatedUserId, setAuthenticatedUserId] = useState<string | null>(null);
  const [authenticatedEmail, setAuthenticatedEmail] = useState<string | null>(null);
  const [currentUserProfile, setCurrentUserProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [serverAdminConfirmed, setServerAdminConfirmed] = useState<boolean | null>(null);

  // Selected Event & Checkout state
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const [selectedLotId, setSelectedLotId] = useState<string>('');
  const [checkoutQty, setCheckoutQty] = useState<number>(2);

  // Client & Admin records state
  const [tickets, setTickets] = useState<Ticket[]>(INITIAL_TICKETS);
  const [orders, setOrders] = useState<Order[]>(INITIAL_ORDERS);
  const [checkins, setCheckins] = useState<CheckinRecord[]>(INITIAL_CHECKINS);
  const [contactSent, setContactSent] = useState(false);

  const isOnline = useOnlineStatus();

  const syncAuthenticatedUserProfile = useCallback(async (expectedUid?: string) => {
    const check = await fetchAuthenticatedUserProfileFromSupabase(expectedUid);
    if (!check.authenticatedUserId) {
      setAuthStatus('unauthenticated');
      setAuthenticatedUserId(null);
      setAuthenticatedEmail(null);
      setCurrentUserProfile(null);
      setProfileError(null);
      setServerAdminConfirmed(null);
      return;
    }

    setAuthStatus('authenticated');
    setAuthenticatedUserId(check.authenticatedUserId);
    setAuthenticatedEmail(check.email);
    setCurrentUserProfile(check.profile);
    setProfileError(check.errorMessage);
    setServerAdminConfirmed(check.serverAdminConfirmed);
  }, []);

  useEffect(() => {
    if (!supabase) {
      setAuthStatus('unauthenticated');
      return;
    }

    let isMounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!isMounted) return;
      const sessionUser = data?.session?.user;
      if (!sessionUser) {
        setAuthStatus('unauthenticated');
        setAuthenticatedUserId(null);
        setAuthenticatedEmail(null);
        setCurrentUserProfile(null);
        setProfileError(null);
        setServerAdminConfirmed(null);
        return;
      }
      syncAuthenticatedUserProfile(sessionUser.id);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isMounted) return;
      const sessionUser = session?.user;
      if (!sessionUser) {
        setAuthStatus('unauthenticated');
        setAuthenticatedUserId(null);
        setAuthenticatedEmail(null);
        setCurrentUserProfile(null);
        setProfileError(null);
        setServerAdminConfirmed(null);
        return;
      }
      syncAuthenticatedUserProfile(sessionUser.id);
    });

    return () => {
      isMounted = false;
      authListener.subscription.unsubscribe();
    };
  }, [syncAuthenticatedUserProfile]);

  const adminAccess = useMemo(
    () =>
      evaluateAdminAccess({
        authenticatedUserId,
        profile: currentUserProfile,
        profileError,
        serverAdminConfirmed,
      }),
    [authenticatedUserId, currentUserProfile, profileError, serverAdminConfirmed]
  );

  const handleSignOut = useCallback(async () => {
    await signOutFromSupabase();
    setAuthStatus('unauthenticated');
    setAuthenticatedUserId(null);
    setAuthenticatedEmail(null);
    setCurrentUserProfile(null);
    setProfileError(null);
    setServerAdminConfirmed(null);
    if (activeView === 'admin') {
      setActiveView('client-area');
      setClientSubTab('login');
    }
  }, [activeView]);

  const loadPublishedEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsError(null);
    try {
      const result = await fetchPublishedEventsFromSupabase();
      if (!result.ok) {
        setEvents([]);
        setEventsError(
          result.errorMessage ?? 'Não foi possível carregar os eventos publicados do Supabase.'
        );
        return;
      }

      setEvents(result.events);
      if (result.events.length > 0) {
        setSelectedEventId((prevId) => {
          const stillExists = result.events.some((ev) => ev.id === prevId);
          return stillExists ? prevId : result.events[0].id;
        });
        const firstEventWithLots = result.events[0];
        if (firstEventWithLots?.lots[0]) {
          setSelectedLotId((prevLotId) => prevLotId || firstEventWithLots.lots[0].id);
        }
      } else {
        setSelectedLotId('');
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Erro inesperado ao consultar os eventos publicados no Supabase.';
      setEvents([]);
      setEventsError(msg);
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPublishedEvents();
  }, [loadPublishedEvents]);

  const loadAdminEvents = useCallback(async () => {
    if (!adminAccess.allowed) {
      setAdminEvents([]);
      setAdminEventsError(null);
      return;
    }

    setAdminEventsLoading(true);
    setAdminEventsError(null);
    try {
      const result = await fetchAdminEventsFromSupabase();
      if (!result.ok) {
        setAdminEventsError(
          result.errorMessage ?? 'Não foi possível carregar os eventos administrativos do Supabase.'
        );
        return;
      }
      setAdminEvents(result.events);
    } catch (err) {
      setAdminEventsError(
        err instanceof Error
          ? err.message
          : 'Erro inesperado ao consultar eventos administrativos no Supabase.'
      );
    } finally {
      setAdminEventsLoading(false);
    }
  }, [adminAccess.allowed]);

  useEffect(() => {
    if (adminAccess.allowed) {
      loadAdminEvents();
    } else {
      setAdminEvents([]);
      setAdminEventsError(null);
    }
  }, [adminAccess.allowed, loadAdminEvents]);

  const categoriesWithCounts = useMemo(
    () => computeCategoriesWithEventCounts(INITIAL_CATEGORIES, events),
    [events]
  );

  const currentEvent: EventItem | null =
    events.find((e) => e.id === selectedEventId) ??
    (adminAccess.allowed ? adminEvents.find((e) => e.id === selectedEventId) : undefined) ??
    events[0] ??
    null;
  const currentLot: TicketLot | null =
    currentEvent?.lots.find((l) => l.id === selectedLotId) ?? currentEvent?.lots[0] ?? null;

  const handleNavigate = (view: AppView, subTab?: ClientSubTab) => {
    setActiveView(view);
    if (subTab) {
      setClientSubTab(subTab);
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleOpenEvent = (event: EventItem) => {
    setSelectedEventId(event.id);
    setSelectedLotId(event.lots[0]?.id ?? '');
    setActiveView('event-detail');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleBuyLot = (event: EventItem, lot: TicketLot, quantity: number) => {
    if (event.status !== 'Publicado') {
      return;
    }
    setSelectedEventId(event.id);
    setSelectedLotId(lot.id);
    setCheckoutQty(quantity);
    setActiveView('checkout');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleCreateEvent = useCallback(
    async (input: AdminEventFormInput) => {
      const existingRefs = adminEvents.map((ev) => ({ id: ev.id, slug: ev.slug }));
      const result = await createEventInSupabase(input, existingRefs);
      if (result.ok) {
        await Promise.all([loadAdminEvents(), loadPublishedEvents()]);
      }
      return result;
    },
    [adminEvents, loadAdminEvents, loadPublishedEvents]
  );

  const handleUpdateEvent = useCallback(
    async (eventId: string, input: AdminEventFormInput) => {
      const existingRefs = adminEvents.map((ev) => ({ id: ev.id, slug: ev.slug }));
      const result = await updateEventInSupabase(eventId, input, existingRefs);
      if (result.ok) {
        await Promise.all([loadAdminEvents(), loadPublishedEvents()]);
      }
      return result;
    },
    [adminEvents, loadAdminEvents, loadPublishedEvents]
  );

  const handleToggleEventStatus = useCallback(
    async (eventId: string, nextStatus: EventStatus) => {
      const result = await updateEventStatusInSupabase(eventId, nextStatus);
      if (result.ok) {
        await Promise.all([loadAdminEvents(), loadPublishedEvents()]);
      }
      return result;
    },
    [loadAdminEvents, loadPublishedEvents]
  );

  const handleDeleteEvent = useCallback(
    async (eventId: string) => {
      const result = await deleteEventInSupabase(eventId);
      if (result.ok) {
        await Promise.all([loadAdminEvents(), loadPublishedEvents()]);
      }
      return result;
    },
    [loadAdminEvents, loadPublishedEvents]
  );

  const handleProcessCheckin = (updatedTicket: Ticket | undefined, record: CheckinRecord) => {
    if (updatedTicket) {
      setTickets((prev) => prev.map((t) => (t.id === updatedTicket.id ? updatedTicket : t)));
    }
    setCheckins((prev) => [record, ...prev]);
  };

  const searchedEvents = searchQuery.trim()
    ? events.filter(
        (ev) =>
          ev.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          ev.city.toLowerCase().includes(searchQuery.toLowerCase()) ||
          ev.categoryName.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : events;

  const selectedCategoryObj = selectedCategoryId
    ? categoriesWithCounts.find((c) => c.id === selectedCategoryId) ?? null
    : null;

  const filteredCalendarEvents = searchedEvents.filter(
    (ev) =>
      !selectedCategoryId ||
      ev.categoryId === selectedCategoryId ||
      (selectedCategoryObj && ev.categoryId === selectedCategoryObj.slug)
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#070709] text-white">
      {!isOnline && (
        <div className="bg-amber-500/95 text-black px-4 py-2 text-xs font-bold flex items-center justify-center gap-2">
          <WifiOff className="w-4 h-4" />
          <span>Modo Offline — Exibindo ingressos e dados salvos em cache no dispositivo.</span>
        </div>
      )}

      <Navbar
        activeView={activeView}
        onNavigate={handleNavigate}
        cartCount={checkoutQty}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        isAuthenticated={authStatus === 'authenticated'}
        authenticatedEmail={authenticatedEmail}
        currentUserProfile={currentUserProfile}
        isAdminAuthorized={adminAccess.allowed}
        onSignOut={handleSignOut}
      />

      <main className="flex-1">
        {activeView === 'home' && (
          <HomeView
            categories={categoriesWithCounts}
            events={searchedEvents}
            selectedCategoryId={selectedCategoryId}
            onSelectCategory={setSelectedCategoryId}
            onOpenEvent={handleOpenEvent}
            onExploreAllEvents={() => handleNavigate('events')}
            isLoadingEvents={eventsLoading}
            eventsError={eventsError}
            onRetryEvents={loadPublishedEvents}
          />
        )}

        {activeView === 'events' && (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6 pb-20">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1E2230] pb-4">
              <div>
                <h1 className="font-display text-3xl font-extrabold text-white uppercase">
                  Calendário Oficial de Eventos
                </h1>
                <p className="text-xs sm:text-sm text-neutral-400">
                  Eventos exclusivos organizados e administrados pela equipe oficial PX CUSTON.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 self-start sm:self-auto">
                {selectedCategoryId && (
                  <button
                    type="button"
                    onClick={() => setSelectedCategoryId(null)}
                    className="text-xs font-semibold text-[#E50914] hover:underline cursor-pointer"
                  >
                    Mostrar todas as categorias
                  </button>
                )}
                <button
                  type="button"
                  onClick={loadPublishedEvents}
                  disabled={eventsLoading}
                  className="px-3.5 py-2 rounded-lg bg-[#181B24] hover:bg-[#222634] border border-[#2A2E3D] text-xs font-semibold text-neutral-200 hover:text-white inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${eventsLoading ? 'animate-spin text-[#E50914]' : ''}`} />
                  <span>Atualizar catálogo</span>
                </button>
              </div>
            </div>

            {eventsLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                {[1, 2, 3, 4].map((skeletonId) => (
                  <div
                    key={skeletonId}
                    className="rounded-xl overflow-hidden bg-[#11131A] border border-[#222532] p-4 space-y-4 animate-pulse"
                  >
                    <div className="h-36 rounded-lg bg-[#1A1D28]" />
                    <div className="h-4 bg-[#1A1D28] rounded w-3/4" />
                    <div className="h-3 bg-[#1A1D28] rounded w-1/2" />
                    <div className="h-8 bg-[#181B24] rounded-md" />
                  </div>
                ))}
              </div>
            ) : eventsError ? (
              <div className="rounded-2xl bg-[#11131A] border border-[#E50914]/40 p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-start gap-3.5">
                  <AlertCircle className="w-6 h-6 text-[#E50914] shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <h2 className="text-sm sm:text-base font-bold text-white">
                      Erro ao consultar eventos publicados no Supabase
                    </h2>
                    <p className="text-xs text-neutral-300">{eventsError}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={loadPublishedEvents}
                  className="px-4 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold uppercase tracking-wider inline-flex items-center gap-2 shrink-0 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Tentar novamente</span>
                </button>
              </div>
            ) : filteredCalendarEvents.length === 0 ? (
              <div className="rounded-2xl bg-[#11131A] border border-[#222532] p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <h2 className="text-sm sm:text-base font-bold text-white">
                    Nenhum evento publicado encontrado
                  </h2>
                  <p className="text-xs text-neutral-400">
                    {selectedCategoryId || searchQuery.trim()
                      ? 'Nenhum evento publicado corresponde aos filtros selecionados.'
                      : 'Não há eventos com status "published" cadastrados na tabela public.events do Supabase no momento.'}
                  </p>
                </div>
                {(selectedCategoryId || searchQuery.trim()) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedCategoryId(null);
                      setSearchQuery('');
                    }}
                    className="px-4 py-2 rounded-lg bg-[#181B24] hover:bg-[#222634] border border-[#2A2E3D] text-xs font-semibold text-white shrink-0 cursor-pointer"
                  >
                    Limpar filtros
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                {filteredCalendarEvents.map((ev) => (
                  <article
                    key={ev.id}
                    className="rounded-xl overflow-hidden bg-[#11131A] border border-[#222532] hover:border-[#E50914]/60 transition-all flex flex-col justify-between"
                  >
                    <div>
                      <div className="relative h-40 bg-[#0B0C10]">
                        <ResilientImage
                          src={ev.cardImageUrl}
                          alt={ev.title}
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="p-4 flex items-start gap-3">
                        <div className="px-2.5 py-1.5 rounded-lg bg-[#181B24] border border-[#2A2E3D] text-center shrink-0">
                          <span className="block text-base font-extrabold font-mono-tabular text-white leading-none">
                            {ev.dayNumber}
                          </span>
                          <span className="block text-[10px] font-bold uppercase text-[#E50914] mt-0.5">
                            {ev.monthShort}
                          </span>
                        </div>
                        <div className="min-w-0 space-y-1">
                          <h2 className="text-sm font-bold text-white line-clamp-2">{ev.title}</h2>
                          <p className="text-xs text-neutral-400 flex items-center gap-1">
                            <MapPin className="w-3.5 h-3.5 text-[#E50914] shrink-0" />
                            <span className="truncate">{ev.city}</span>
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="px-4 pb-4 space-y-2">
                      <div className="w-full py-1.5 px-3 rounded-md bg-[#E50914] text-white text-center text-xs font-bold font-mono-tabular">
                        A partir de {formatBRL(ev.startingPrice)}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleOpenEvent(ev)}
                        className="w-full py-2 px-3 rounded-md bg-[#181B24] hover:bg-[#222634] border border-[#2A2E3D] text-xs font-semibold text-neutral-200 hover:text-white transition-colors cursor-pointer"
                      >
                        Ver detalhes
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}

        {activeView === 'event-detail' &&
          (currentEvent ? (
            <EventDetailView
              event={currentEvent}
              onBackToHome={() => handleNavigate('home')}
              onBackToEvents={() => handleNavigate('events')}
              onBuyLot={handleBuyLot}
            />
          ) : (
            <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
              <div className="rounded-2xl bg-[#11131A] border border-[#232736] p-6 sm:p-8 space-y-4">
                <h1 className="font-display text-2xl font-bold text-white">
                  Evento não encontrado ou indisponível
                </h1>
                <p className="text-xs sm:text-sm text-neutral-400">
                  Selecione um evento publicado no calendário oficial da PX CUSTON.
                </p>
                <button
                  type="button"
                  onClick={() => handleNavigate('events')}
                  className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold uppercase tracking-wider cursor-pointer"
                >
                  Voltar para Eventos
                </button>
              </div>
            </div>
          ))}

        {activeView === 'checkout' &&
          (currentEvent && currentEvent.status === 'Publicado' && currentLot ? (
            <CheckoutView
              event={currentEvent}
              selectedLot={currentLot}
              quantity={checkoutQty}
              onQuantityChange={setCheckoutQty}
              onSelectLot={(lot) => setSelectedLotId(lot.id)}
              onCancelOrder={() => handleNavigate('event-detail')}
              onRegisterPendingOrder={(ord) => setOrders((prev) => [ord, ...prev])}
              onGoToClientOrders={() => handleNavigate('client-area', 'orders')}
            />
          ) : (
            <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
              <div className="rounded-2xl bg-[#11131A] border border-[#232736] p-6 sm:p-8 space-y-4">
                <h1 className="font-display text-2xl font-bold text-white">
                  Nenhum lote selecionado para checkout
                </h1>
                <p className="text-xs sm:text-sm text-neutral-400">
                  Escolha um evento publicado e um lote ativo antes de iniciar a compra.
                </p>
                <button
                  type="button"
                  onClick={() => handleNavigate('events')}
                  className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold uppercase tracking-wider cursor-pointer"
                >
                  Explorar Eventos Publicados
                </button>
              </div>
            </div>
          ))}

        {activeView === 'client-area' && (
          <ClientAreaView
            activeSubTab={clientSubTab}
            onChangeSubTab={setClientSubTab}
            tickets={tickets}
            orders={orders}
            isAuthenticated={authStatus === 'authenticated'}
            authenticatedEmail={authenticatedEmail}
            currentUserProfile={currentUserProfile}
            profileError={profileError}
            onSignOut={handleSignOut}
            onAuthSessionUpdated={() => syncAuthenticatedUserProfile()}
          />
        )}

        {activeView === 'admin' && (
          <AdminPanelView
            events={adminAccess.allowed ? adminEvents : events}
            categories={categoriesWithCounts}
            tickets={tickets}
            orders={orders}
            checkins={checkins}
            customers={INITIAL_CUSTOMERS}
            auditLogs={INITIAL_AUDIT_LOGS}
            adminAccess={adminAccess}
            currentUserProfile={currentUserProfile}
            authenticatedEmail={authenticatedEmail}
            isAuthLoading={authStatus === 'loading'}
            isLoadingAdminEvents={adminEventsLoading}
            adminEventsError={adminEventsError}
            onRefreshAdminEvents={loadAdminEvents}
            onGoToLogin={() => handleNavigate('client-area', 'login')}
            onGoToHome={() => handleNavigate('home')}
            onSignOut={handleSignOut}
            onRefreshProfile={() => syncAuthenticatedUserProfile(authenticatedUserId ?? undefined)}
            onCreateEvent={handleCreateEvent}
            onUpdateEvent={handleUpdateEvent}
            onToggleEventStatus={handleToggleEventStatus}
            onDeleteEvent={handleDeleteEvent}
            onProcessCheckin={handleProcessCheckin}
            onSelectEventPublic={handleOpenEvent}
          />
        )}

        {activeView === 'about' && (
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-6 pb-20">
            <div className="rounded-2xl bg-[#11131A] border border-[#232736] p-6 sm:p-10 space-y-6">
              <BrandLogo size="lg" />
              <h1 className="font-display text-3xl font-extrabold text-white uppercase">
                Sobre a PX CUSTON
              </h1>
              <p className="text-sm text-neutral-300 leading-relaxed">
                A PX CUSTON é a plataforma oficial de ingressos, eventos automotivos e check-in
                online dedicada à cultura automotiva brasileira. Nossos encontros reúnem carros
                rebaixados, veículos customizados, motos esportivas e projetos de pista com
                organização própria, segurança e controle digital de acesso via QR Code.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
                <div className="rounded-xl bg-[#161924] border border-[#262B3C] p-4 space-y-1">
                  <ShieldCheck className="w-5 h-5 text-[#E50914]" />
                  <h2 className="text-sm font-bold text-white">Eventos Oficiais</h2>
                  <p className="text-xs text-neutral-400">
                    Curadoria e administração exclusiva pela equipe autorizada PX CUSTON.
                  </p>
                </div>
                <div className="rounded-xl bg-[#161924] border border-[#262B3C] p-4 space-y-1">
                  <ShieldCheck className="w-5 h-5 text-[#E50914]" />
                  <h2 className="text-sm font-bold text-white">QR Code Único</h2>
                  <p className="text-xs text-neutral-400">
                    Ingressos nominais vinculados ao CPF com leitura rápida pelo PX CONTROL.
                  </p>
                </div>
                <div className="rounded-xl bg-[#161924] border border-[#262B3C] p-4 space-y-1">
                  <ShieldCheck className="w-5 h-5 text-[#E50914]" />
                  <h2 className="text-sm font-bold text-white">Mercado Pago & Supabase</h2>
                  <p className="text-xs text-neutral-400">
                    Arquitetura estruturada para confirmação via Webhook e banco PostgreSQL com RLS.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeView === 'contact' && (
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 pb-20">
            <div className="rounded-2xl bg-[#11131A] border border-[#232736] p-6 sm:p-10 space-y-6">
              <h1 className="font-display text-3xl font-extrabold text-white uppercase">
                Contato & Credenciamento de Expositores
              </h1>
              <p className="text-xs sm:text-sm text-neutral-400">
                Fale diretamente com a equipe organizadora da PX CUSTON sobre ingressos, lotes de
                exposição de veículos ou patrocinadores oficiais.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="rounded-xl bg-[#161924] border border-[#262B3C] p-4 flex items-center gap-3">
                  <Mail className="w-5 h-5 text-[#E50914]" />
                  <div>
                    <span className="block text-neutral-400">Atendimento Oficial</span>
                    <span className="font-semibold text-white">contato@pxcuston.com.br</span>
                  </div>
                </div>
                <div className="rounded-xl bg-[#161924] border border-[#262B3C] p-4 flex items-center gap-3">
                  <Phone className="w-5 h-5 text-[#E50914]" />
                  <div>
                    <span className="block text-neutral-400">Suporte Portaria & Eventos</span>
                    <span className="font-semibold text-white font-mono-tabular">
                      (11) 98765-4321
                    </span>
                  </div>
                </div>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setContactSent(true);
                }}
                className="space-y-4 pt-2"
              >
                <div>
                  <label htmlFor="contact-name" className="block text-xs text-neutral-300 mb-1">
                    Seu nome
                  </label>
                  <input
                    id="contact-name"
                    type="text"
                    required
                    placeholder="Nome completo"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white"
                  />
                </div>
                <div>
                  <label htmlFor="contact-msg" className="block text-xs text-neutral-300 mb-1">
                    Mensagem
                  </label>
                  <textarea
                    id="contact-msg"
                    rows={3}
                    required
                    placeholder="Informe sua dúvida sobre eventos, ingressos ou exposição..."
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white"
                  />
                </div>
                {contactSent && (
                  <p className="text-xs text-emerald-400 font-semibold">
                    Mensagem registrada! Nossa equipe retornará pelo e-mail informado.
                  </p>
                )}
                <button
                  type="submit"
                  className="px-6 py-3 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white font-bold text-xs uppercase tracking-wider cursor-pointer"
                >
                  Enviar Mensagem
                </button>
              </form>
            </div>
          </div>
        )}
      </main>

      <Footer onNavigate={handleNavigate} />
    </div>
  );
}
