import React, { useState } from 'react';
import {
  Ticket as TicketIcon,
  ChevronRight,
  ChevronLeft,
  MapPin,
  Car,
  Bike,
  Wrench,
  Gauge,
  Trophy,
  Download,
  Zap,
  ShieldCheck,
  Smartphone,
  Flame,
  Calendar,
  Users,
} from 'lucide-react';
import type { EventCategory, EventItem } from '../types/domain';
import { formatBRL } from '../utils/ticketRules';
import { BrandLogo, ResilientImage } from './BrandLogo';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface HomeViewProps {
  categories: EventCategory[];
  events: EventItem[];
  selectedCategoryId: string | null;
  onSelectCategory: (categoryId: string | null) => void;
  onOpenEvent: (event: EventItem) => void;
  onExploreAllEvents: () => void;
}

const HERO_SLIDES = [
  {
    id: 'slide-1',
    kicker: 'EVENTOS AUTOMOTIVOS',
    line1: 'SUA PAIXÃO.',
    line2: 'SEU EVENTO.',
    line3: 'SUA EXPERIÊNCIA.',
    subtitle: 'Ingressos para os melhores encontros automotivos do Brasil.',
    image: '/assets/events/hero-jetta.jpg',
    targetEventSlug: 'encontro-nacional-de-carros-rebaixados',
  },
  {
    id: 'slide-2',
    kicker: 'CULTURA DE PISTA & DRIFT',
    line1: 'ADRENALINA.',
    line2: 'ALTA ROTAÇÃO.',
    line3: 'NO AUTÓDROMO.',
    subtitle: 'Baterias oficiais de Drift, carros preparados e acesso exclusivo aos boxes.',
    image: '/assets/events/ev-speeddrift.jpg',
    targetEventSlug: 'speed-e-drift',
  },
  {
    id: 'slide-3',
    kicker: 'DUAS RODAS & CUSTOMIZAÇÃO',
    line1: 'LIBERDADE.',
    line2: 'ESTILO PRÓPRIO.',
    line3: 'CULTURA PX CUSTON.',
    subtitle: 'Superbikes, encontros noturnos e exposições oficiais pelo Brasil.',
    image: '/assets/events/pwa-moto.jpg',
    targetEventSlug: 'moto-fest-brasil',
  },
];

export const HomeView: React.FC<HomeViewProps> = ({
  categories,
  events,
  selectedCategoryId,
  onSelectCategory,
  onOpenEvent,
  onExploreAllEvents,
}) => {
  const [slideIndex, setSlideIndex] = useState(0);
  const [pwaNotice, setPwaNotice] = useState<string | null>(null);
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();

  const currentSlide = HERO_SLIDES[slideIndex];

  const filteredEvents = selectedCategoryId
    ? events.filter((ev) => ev.categoryId === selectedCategoryId)
    : events;

  const featuredEvents = events.filter((ev) => ev.featured);

  const renderCategoryIcon = (type: EventCategory['iconType']) => {
    const iconProps = { className: 'w-5 h-5 text-[#E50914]' };
    switch (type) {
      case 'car':
        return <Car {...iconProps} />;
      case 'moto':
        return <Bike {...iconProps} />;
      case 'tuning':
        return <Wrench {...iconProps} />;
      case 'performance':
        return <Gauge {...iconProps} />;
      case 'trophy':
        return <Trophy {...iconProps} />;
    }
  };

  const handleInstallClick = async () => {
    if (isInstallable) {
      await install();
    } else if (isIOS) {
      setPwaNotice(
        'No iPhone/iPad: toque no botão Compartilhar do Safari e selecione "Adicionar à Tela de Início".'
      );
    } else {
      setPwaNotice(
        'Aplicativo PWA pronto! Utilize a opção "Instalar aplicativo" ou "Adicionar à tela inicial" do seu navegador.'
      );
    }
  };

  return (
    <div className="space-y-10 pb-16">
      {/* 1. HERO BANNER (Matches Top-Left Reference Panel) */}
      <section className="relative overflow-hidden border-b border-[#1D1F29] bg-[#070709]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-7">
          <div className="relative rounded-2xl overflow-hidden border border-[#222532] bg-[#0B0C10] min-h-[340px] sm:min-h-[390px] flex items-center">
            {/* Background Automotive Photography with Measured Scrim */}
            <div className="absolute inset-0">
              <ResilientImage
                src={currentSlide.image}
                alt={currentSlide.line1}
                className="w-full h-full object-cover object-right sm:object-center opacity-95"
              />
              <div className="absolute inset-0 bg-gradient-to-r from-[#070709] via-[#070709]/60 to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-t from-[#070709]/90 via-transparent to-[#070709]/30" />
            </div>

            {/* Hero Content */}
            <div className="relative z-10 w-full max-w-xl p-6 sm:p-10 lg:p-12 space-y-5">
              <p className="text-xs sm:text-sm font-bold tracking-[0.2em] text-[#E50914] uppercase italic">
                {currentSlide.kicker}
              </p>

              <h1 className="font-display italic font-extrabold uppercase leading-[0.94] tracking-tight text-4xl sm:text-5xl lg:text-6xl">
                <span className="block text-white drop-shadow">{currentSlide.line1}</span>
                <span className="block text-white drop-shadow">{currentSlide.line2}</span>
                <span className="block text-[#E50914] drop-shadow-[0_2px_18px_rgba(229,9,20,0.45)]">
                  {currentSlide.line3}
                </span>
              </h1>

              <p className="text-sm sm:text-base text-neutral-300 max-w-md leading-relaxed">
                {currentSlide.subtitle}
              </p>

              <div className="pt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={onExploreAllEvents}
                  className="inline-flex items-center gap-2.5 px-6 py-3.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white font-bold text-xs sm:text-sm tracking-wider uppercase transition-all shadow-[0_0_25px_rgba(229,9,20,0.45)] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <TicketIcon className="w-4 h-4" />
                  <span>EXPLORAR EVENTOS</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Bottom-right Slide Counter & Controls (01 / 03 < >) */}
            <div className="absolute bottom-4 right-5 z-10 flex items-center gap-3 bg-[#0B0C10]/85 backdrop-blur-sm px-3.5 py-1.5 rounded-full border border-[#252836]">
              <span className="text-xs font-mono-tabular font-bold text-[#E50914]">
                0{slideIndex + 1}
              </span>
              <span className="text-xs text-neutral-500">/</span>
              <span className="text-xs font-mono-tabular text-neutral-400">
                0{HERO_SLIDES.length}
              </span>
              <div className="flex items-center gap-1 ml-1">
                <button
                  type="button"
                  onClick={() =>
                    setSlideIndex((prev) => (prev - 1 + HERO_SLIDES.length) % HERO_SLIDES.length)
                  }
                  aria-label="Slide anterior"
                  className="p-1 text-neutral-400 hover:text-white transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setSlideIndex((prev) => (prev + 1) % HERO_SLIDES.length)}
                  aria-label="Próximo slide"
                  className="p-1 text-neutral-400 hover:text-white transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2. CATEGORIAS DE EVENTOS */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#E50914]" />
            <h2 className="font-display text-xl sm:text-2xl font-bold tracking-wide uppercase text-white">
              CATEGORIAS DE EVENTOS
            </h2>
          </div>
          {selectedCategoryId && (
            <button
              type="button"
              onClick={() => onSelectCategory(null)}
              className="text-xs font-semibold text-[#E50914] hover:underline whitespace-nowrap"
            >
              Limpar filtro ({categories.find((c) => c.id === selectedCategoryId)?.name})
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {categories.map((cat) => {
            const isSelected = selectedCategoryId === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => onSelectCategory(isSelected ? null : cat.id)}
                className={`group relative rounded-xl overflow-hidden text-left border transition-all h-40 flex flex-col justify-end p-4 cursor-pointer ${
                  isSelected
                    ? 'border-[#E50914] ring-2 ring-[#E50914]/40 bg-[#161822]'
                    : 'border-[#232634] hover:border-[#E50914]/70 bg-[#11131A]'
                }`}
              >
                <div className="absolute inset-0">
                  <ResilientImage
                    src={cat.imageUrl}
                    alt={cat.name}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 opacity-75"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#08090C] via-[#08090C]/65 to-transparent" />
                </div>

                <div className="relative z-10 space-y-1.5">
                  <div className="w-8 h-8 rounded-lg bg-[#0D0E14]/90 border border-[#2A2E3D] flex items-center justify-center">
                    {renderCategoryIcon(cat.iconType)}
                  </div>
                  <h3 className="text-sm font-bold text-white group-hover:text-[#E50914] transition-colors">
                    {cat.name}
                  </h3>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* 3. PRÓXIMOS EVENTOS (Matches Reference 4-Column Event Cards) */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#E50914]" />
            <h2 className="font-display text-xl sm:text-2xl font-bold tracking-wide uppercase text-white">
              PRÓXIMOS EVENTOS
            </h2>
          </div>
          <button
            type="button"
            onClick={onExploreAllEvents}
            className="text-xs sm:text-sm font-medium text-[#E50914] hover:underline whitespace-nowrap"
          >
            Ver todos
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {filteredEvents.map((ev) => (
            <article
              key={ev.id}
              className="group rounded-xl overflow-hidden bg-[#11131A] border border-[#222532] hover:border-[#E50914]/60 transition-all flex flex-col justify-between"
            >
              <div>
                {/* Event Card Image */}
                <div className="relative h-36 overflow-hidden bg-[#0B0C10]">
                  <ResilientImage
                    src={ev.cardImageUrl}
                    alt={ev.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#11131A] via-transparent to-transparent" />
                </div>

                {/* Date Box + Event Title + City */}
                <div className="p-4 flex items-start gap-3">
                  <div className="px-2.5 py-1.5 rounded-lg bg-[#181B24] border border-[#2A2E3D] text-center shrink-0 min-w-[46px]">
                    <span className="block text-base font-extrabold font-mono-tabular text-white leading-none">
                      {ev.dayNumber}
                    </span>
                    <span className="block text-[10px] font-bold uppercase text-[#E50914] mt-0.5">
                      {ev.monthShort}
                    </span>
                  </div>

                  <div className="min-w-0 space-y-1">
                    <h3 className="text-sm font-bold text-white leading-snug line-clamp-2 group-hover:text-[#E50914] transition-colors">
                      {ev.title}
                    </h3>
                    <p className="text-xs text-neutral-400 flex items-center gap-1 truncate">
                      <MapPin className="w-3.5 h-3.5 text-[#E50914] shrink-0" />
                      <span className="truncate">{ev.city}</span>
                    </p>
                  </div>
                </div>
              </div>

              {/* Price CTA & Ver Detalhes Button */}
              <div className="px-4 pb-4 pt-1 space-y-2">
                <div className="w-full py-1.5 px-3 rounded-md bg-[#E50914] text-white text-center text-xs font-bold font-mono-tabular">
                  A partir de {formatBRL(ev.startingPrice)}
                </div>
                <button
                  type="button"
                  onClick={() => onOpenEvent(ev)}
                  className="w-full py-2 px-3 rounded-md bg-[#181B24] hover:bg-[#222634] border border-[#2A2E3D] text-xs font-semibold text-neutral-200 hover:text-white transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <span>Ver detalhes</span>
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* 4. EVENTOS EM DESTAQUE (Featured Experiences Section) */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Flame className="w-5 h-5 text-[#E50914]" />
            <h2 className="font-display text-xl sm:text-2xl font-bold tracking-wide uppercase text-white">
              EVENTOS EM DESTAQUE
            </h2>
          </div>
          <span className="text-xs text-neutral-400 hidden sm:inline">
            Curadoria oficial PX CUSTON · Lotes com emissão imediata de QR Code após confirmação
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {featuredEvents.slice(0, 2).map((ev) => {
            const occupancyPct = Math.min(100, Math.round((ev.ticketsSold / ev.capacity) * 100));
            return (
              <div
                key={ev.id}
                className="rounded-2xl overflow-hidden bg-[#11131A] border border-[#242836] hover:border-[#E50914]/60 transition-all grid grid-cols-1 sm:grid-cols-12"
              >
                <div className="sm:col-span-5 relative min-h-[200px] bg-[#0B0C10]">
                  <ResilientImage
                    src={ev.bannerUrl}
                    alt={ev.title}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#11131A] sm:bg-gradient-to-r sm:from-transparent sm:to-[#11131A]" />
                </div>

                <div className="sm:col-span-7 p-5 sm:p-6 flex flex-col justify-between space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-[#E50914] font-semibold">
                      <span>{ev.categoryName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono-tabular">{ev.dateFormatted}</span>
                    </div>
                    <h3 className="text-lg sm:text-xl font-bold text-white leading-snug">
                      {ev.title}
                    </h3>
                    <p className="text-xs text-neutral-300 line-clamp-2">{ev.description}</p>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-xs text-neutral-400">
                      <span className="flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-[#E50914]" />
                        {ev.timeRange}
                      </span>
                      <span className="flex items-center gap-1.5 font-mono-tabular">
                        <Users className="w-3.5 h-3.5 text-[#E50914]" />
                        {ev.ticketsSold} confirmados ({occupancyPct}%)
                      </span>
                    </div>

                    <div className="w-full h-1.5 rounded-full bg-[#1C1F2B] overflow-hidden">
                      <div
                        className="h-full bg-[#E50914] rounded-full"
                        style={{ width: `${occupancyPct}%` }}
                      />
                    </div>

                    <div className="pt-1 flex items-center justify-between gap-3">
                      <div>
                        <span className="block text-[11px] text-neutral-400">Ingressos desde</span>
                        <span className="text-base font-extrabold text-white font-mono-tabular">
                          {formatBRL(ev.startingPrice)}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => onOpenEvent(ev)}
                        className="px-4 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold uppercase tracking-wide transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        <span>Comprar Ingresso</span>
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 5. BANNER PWA — INSTALAR NO DISPOSITIVO (Matches Bottom-Right Reference Panel) */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="relative rounded-2xl overflow-hidden border border-[#272A38] bg-[#0D0E13]">
          <div className="grid grid-cols-1 lg:grid-cols-12 items-center">
            <div className="lg:col-span-6 relative h-56 sm:h-72 lg:h-full min-h-[240px]">
              <ResilientImage
                src="/assets/events/pwa-moto.jpg"
                alt="Cultura Automotiva PX CUSTON"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t lg:bg-gradient-to-r from-transparent via-[#0D0E13]/60 to-[#0D0E13]" />
            </div>

            <div className="lg:col-span-6 p-6 sm:p-8 lg:p-10 text-center lg:text-right flex flex-col items-center lg:items-end justify-center space-y-4">
              <BrandLogo size="lg" />
              <div className="space-y-1">
                <p className="text-xs sm:text-sm font-bold tracking-[0.2em] text-[#E50914] uppercase">
                  EVENTOS AUTOMOTIVOS
                </p>
                <p className="text-sm sm:text-base text-neutral-200 font-medium">
                  Mais que eventos, é a nossa cultura.
                </p>
              </div>

              {!isInstalled ? (
                <button
                  type="button"
                  onClick={handleInstallClick}
                  className="inline-flex items-center gap-2.5 px-6 py-3 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white font-bold text-sm transition-all shadow-[0_0_25px_rgba(229,9,20,0.4)] cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Instalar no dispositivo</span>
                </button>
              ) : (
                <p className="text-xs font-semibold text-emerald-400">
                  Aplicativo PX CUSTON instalado no dispositivo
                </p>
              )}

              {pwaNotice && (
                <p className="text-xs text-neutral-300 bg-[#171923] border border-[#2B2F40] rounded-lg px-3.5 py-2 max-w-md">
                  {pwaNotice}
                </p>
              )}

              <div className="pt-4 w-full max-w-md grid grid-cols-4 gap-2 border-t border-[#1F222E]">
                <div className="flex flex-col items-center gap-1">
                  <Zap className="w-4 h-4 text-[#E50914]" />
                  <span className="text-[11px] text-neutral-300 font-medium">Rápido</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <ShieldCheck className="w-4 h-4 text-[#E50914]" />
                  <span className="text-[11px] text-neutral-300 font-medium">Seguro</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <Smartphone className="w-4 h-4 text-[#E50914]" />
                  <span className="text-[11px] text-neutral-300 font-medium">Responsivo</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <TicketIcon className="w-4 h-4 text-[#E50914]" />
                  <span className="text-[11px] text-neutral-300 font-medium">PWA</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
