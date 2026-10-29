/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  INITIAL_CATEGORIES,
  INITIAL_EVENTS,
  INITIAL_TICKETS,
  INITIAL_ORDERS,
  INITIAL_CHECKINS,
  INITIAL_CUSTOMERS,
  INITIAL_AUDIT_LOGS,
} from './services/platformService';
import type { EventItem, TicketLot, Ticket, Order, CheckinRecord } from './types/domain';
import { Navbar, type AppView, type ClientSubTab } from './components/Navbar';
import { HomeView } from './components/HomeView';
import { EventDetailView } from './components/EventDetailView';
import { CheckoutView } from './components/CheckoutView';
import { ClientAreaView } from './components/ClientAreaView';
import { AdminPanelView } from './components/AdminPanelView';
import { Footer } from './components/Footer';
import { BrandLogo, ResilientImage } from './components/BrandLogo';
import { useOnlineStatus } from './hooks/usePWAInstall';
import { MapPin, ShieldCheck, Mail, Phone, WifiOff } from 'lucide-react';
import { formatBRL } from './utils/ticketRules';

export default function App() {
  const [activeView, setActiveView] = useState<AppView>('home');
  const [clientSubTab, setClientSubTab] = useState<ClientSubTab>('tickets');
  const [events, setEvents] = useState<EventItem[]>(INITIAL_EVENTS);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Selected Event & Checkout state
  const [selectedEventId, setSelectedEventId] = useState<string>(INITIAL_EVENTS[0].id);
  const [selectedLotId, setSelectedLotId] = useState<string>(INITIAL_EVENTS[0].lots[0].id);
  const [checkoutQty, setCheckoutQty] = useState<number>(2);

  // Client & Admin records state
  const [tickets, setTickets] = useState<Ticket[]>(INITIAL_TICKETS);
  const [orders, setOrders] = useState<Order[]>(INITIAL_ORDERS);
  const [checkins, setCheckins] = useState<CheckinRecord[]>(INITIAL_CHECKINS);
  const [contactSent, setContactSent] = useState(false);

  const isOnline = useOnlineStatus();

  const currentEvent = events.find((e) => e.id === selectedEventId) || events[0];
  const currentLot =
    currentEvent.lots.find((l) => l.id === selectedLotId) || currentEvent.lots[0];

  const handleNavigate = (view: AppView, subTab?: ClientSubTab) => {
    setActiveView(view);
    if (subTab) {
      setClientSubTab(subTab);
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleOpenEvent = (event: EventItem) => {
    setSelectedEventId(event.id);
    if (event.lots[0]) {
      setSelectedLotId(event.lots[0].id);
    }
    setActiveView('event-detail');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleBuyLot = (event: EventItem, lot: TicketLot, quantity: number) => {
    setSelectedEventId(event.id);
    setSelectedLotId(lot.id);
    setCheckoutQty(quantity);
    setActiveView('checkout');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleAddEvent = (newEv: EventItem) => {
    setEvents((prev) => [newEv, ...prev]);
  };

  const handleToggleEventStatus = (eventId: string) => {
    setEvents((prev) =>
      prev.map((ev) =>
        ev.id === eventId
          ? { ...ev, status: ev.status === 'Publicado' ? 'Rascunho' : 'Publicado' }
          : ev
      )
    );
  };

  const handleDeleteEvent = (eventId: string) => {
    setEvents((prev) => (prev.length > 1 ? prev.filter((e) => e.id !== eventId) : prev));
  };

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
      />

      <main className="flex-1">
        {activeView === 'home' && (
          <HomeView
            categories={INITIAL_CATEGORIES}
            events={searchedEvents}
            selectedCategoryId={selectedCategoryId}
            onSelectCategory={setSelectedCategoryId}
            onOpenEvent={handleOpenEvent}
            onExploreAllEvents={() => handleNavigate('events')}
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
              {selectedCategoryId && (
                <button
                  type="button"
                  onClick={() => setSelectedCategoryId(null)}
                  className="text-xs font-semibold text-[#E50914] hover:underline self-start sm:self-auto"
                >
                  Mostrar todas as categorias
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {searchedEvents
                .filter((ev) => !selectedCategoryId || ev.categoryId === selectedCategoryId)
                .map((ev) => (
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
          </div>
        )}

        {activeView === 'event-detail' && (
          <EventDetailView
            event={currentEvent}
            onBackToHome={() => handleNavigate('home')}
            onBackToEvents={() => handleNavigate('events')}
            onBuyLot={handleBuyLot}
          />
        )}

        {activeView === 'checkout' && (
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
        )}

        {activeView === 'client-area' && (
          <ClientAreaView
            activeSubTab={clientSubTab}
            onChangeSubTab={setClientSubTab}
            tickets={tickets}
            orders={orders}
          />
        )}

        {activeView === 'admin' && (
          <AdminPanelView
            events={events}
            categories={INITIAL_CATEGORIES}
            tickets={tickets}
            orders={orders}
            checkins={checkins}
            customers={INITIAL_CUSTOMERS}
            auditLogs={INITIAL_AUDIT_LOGS}
            onAddEvent={handleAddEvent}
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
