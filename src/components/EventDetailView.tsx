import React, { useState, useEffect } from 'react';
import {
  MapPin,
  Clock,
  Users,
  Utensils,
  Car,
  Award,
  Share2,
  Ticket as TicketIcon,
  ChevronRight,
  Check,
  X,
} from 'lucide-react';
import type { EventItem, TicketLot } from '../types/domain';
import { formatBRL } from '../utils/ticketRules';
import { ResilientImage } from './BrandLogo';

interface EventDetailViewProps {
  event: EventItem;
  onBackToHome: () => void;
  onBackToEvents: () => void;
  onBuyLot: (event: EventItem, lot: TicketLot, quantity: number) => void;
}

export const EventDetailView: React.FC<EventDetailViewProps> = ({
  event,
  onBackToHome,
  onBackToEvents,
  onBuyLot,
}) => {
  const [activePhoto, setActivePhoto] = useState<string>(event.bannerUrl);
  const [lightboxPhoto, setLightboxPhoto] = useState<string | null>(null);
  const [copiedShare, setCopiedShare] = useState(false);
  const [lotQuantities, setLotQuantities] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    event.lots.forEach((l, idx) => {
      initial[l.id] = idx === 0 ? 2 : 1;
    });
    return initial;
  });

  useEffect(() => {
    setActivePhoto(event.bannerUrl);
    const nextQuantities: Record<string, number> = {};
    event.lots.forEach((l, idx) => {
      nextQuantities[l.id] = idx === 0 ? 2 : 1;
    });
    setLotQuantities(nextQuantities);
  }, [event.id, event.bannerUrl, event.lots]);

  const handleShare = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(window.location.href).catch(() => {});
    }
    setCopiedShare(true);
    setTimeout(() => setCopiedShare(false), 2500);
  };

  const highlightIcons = [
    <Users key="u" className="w-4 h-4 text-[#E50914] shrink-0" />,
    <Award key="a" className="w-4 h-4 text-[#E50914] shrink-0" />,
    <Utensils key="f" className="w-4 h-4 text-[#E50914] shrink-0" />,
    <Car key="c" className="w-4 h-4 text-[#E50914] shrink-0" />,
  ];

  const isEventPublished = event.status === 'Publicado';
  const canPurchaseLots = isEventPublished && event.lots.length > 0;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-8 pb-20">
      {/* Breadcrumb (Início > Eventos > Encontro Nacional de Carros Rebaixados) */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-neutral-400">
        <button
          type="button"
          onClick={onBackToHome}
          className="hover:text-white transition-colors cursor-pointer"
        >
          Início
        </button>
        <span aria-hidden="true">&gt;</span>
        <button
          type="button"
          onClick={onBackToEvents}
          className="hover:text-white transition-colors cursor-pointer"
        >
          Eventos
        </button>
        <span aria-hidden="true">&gt;</span>
        <span className="text-neutral-200 font-medium truncate">{event.title}</span>
      </nav>

      {/* Main Event Hero Card (Matches Top-Right Reference Panel) */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-stretch">
        {/* Left: Main Automotive Photograph */}
        <div className="lg:col-span-6 rounded-2xl overflow-hidden border border-[#232736] bg-[#0D0E13] min-h-[280px] sm:min-h-[360px] relative">
          <ResilientImage
            src={activePhoto}
            alt={event.title}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#070709]/60 via-transparent to-transparent" />
        </div>

        {/* Right: Event Details, Date Box, Highlights & Primary Buy CTA */}
        <div className="lg:col-span-6 rounded-2xl bg-[#11131A] border border-[#232736] p-6 sm:p-7 flex flex-col justify-between space-y-6">
          <div className="space-y-5">
            {/* Date Badge + Title + Location & Time */}
            <div className="flex items-start gap-4">
              <div className="px-3.5 py-2.5 rounded-xl bg-[#181B24] border border-[#2C3142] text-center shrink-0 min-w-[68px]">
                <span className="block text-2xl font-extrabold font-mono-tabular text-white leading-none">
                  {event.dayNumber}
                </span>
                <span className="block text-xs font-bold uppercase text-neutral-300 mt-1">
                  {event.monthShort}
                </span>
                <span className="block text-[11px] font-mono-tabular text-neutral-400 mt-0.5">
                  {event.year}
                </span>
              </div>

              <div className="space-y-2 min-w-0">
                <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-white leading-tight">
                  {event.title}
                </h1>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm text-neutral-300">
                  <span className="flex items-center gap-1.5">
                    <MapPin className="w-4 h-4 text-[#E50914] shrink-0" />
                    {event.city}
                  </span>
                  <span aria-hidden="true" className="text-neutral-600">
                    |
                  </span>
                  <span className="flex items-center gap-1.5 font-mono-tabular">
                    <Clock className="w-4 h-4 text-[#E50914] shrink-0" />
                    {event.timeRange}
                  </span>
                </div>
                <p className="text-xs font-semibold text-[#E50914]">{event.categoryName}</p>
              </div>
            </div>

            {/* Event Description */}
            <p className="text-sm text-neutral-300 leading-relaxed">{event.description}</p>

            <p className="text-xs text-neutral-400">
              <strong className="text-neutral-200">Local oficial:</strong> {event.venueName}
            </p>

            {/* 4 Key Event Highlights (2x2 Grid) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              {event.highlights.map((item, idx) => (
                <div
                  key={item}
                  className="flex items-center gap-2.5 text-xs sm:text-sm text-neutral-200 bg-[#161922] border border-[#242836] rounded-lg px-3.5 py-2.5"
                >
                  {highlightIcons[idx % highlightIcons.length]}
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Action Buttons: COMPRAR INGRESSOS + Compartilhar */}
          <div className="pt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!canPurchaseLots}
              onClick={() => {
                if (!canPurchaseLots) return;
                const firstLot = event.lots[0];
                if (firstLot) {
                  onBuyLot(event, firstLot, lotQuantities[firstLot.id] || 1);
                }
              }}
              className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs sm:text-sm uppercase tracking-wider transition-all shadow-[0_0_24px_rgba(229,9,20,0.4)] whitespace-nowrap cursor-pointer"
            >
              <TicketIcon className="w-4 h-4" />
              <span>
                {!isEventPublished
                  ? `EVENTO EM ${event.status.toUpperCase()}`
                  : event.lots.length > 0
                  ? 'COMPRAR INGRESSOS'
                  : 'LOTES EM BREVE'}
              </span>
              <ChevronRight className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={handleShare}
              className="inline-flex items-center justify-center gap-2 px-4 py-3.5 rounded-lg bg-[#171A24] hover:bg-[#202432] border border-[#2A2E3F] text-xs sm:text-sm font-medium text-neutral-200 hover:text-white transition-colors whitespace-nowrap cursor-pointer"
            >
              {copiedShare ? (
                <>
                  <Check className="w-4 h-4 text-emerald-400" />
                  <span>Link copiado</span>
                </>
              ) : (
                <>
                  <Share2 className="w-4 h-4" />
                  <span>Compartilhar</span>
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* Gallery Strip (5 Automotive Photos with Preview & Lightbox) */}
      <section className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {event.galleryUrls.map((url, idx) => {
            const isSelected = activePhoto === url;
            return (
              <button
                key={`${url}-${idx}`}
                type="button"
                onClick={() => {
                  setActivePhoto(url);
                  setLightboxPhoto(url);
                }}
                aria-label={`Visualizar foto ${idx + 1} da galeria do evento`}
                className={`group relative h-24 sm:h-28 rounded-xl overflow-hidden border transition-all cursor-pointer ${
                  isSelected
                    ? 'border-[#E50914] ring-2 ring-[#E50914]/40'
                    : 'border-[#232736] hover:border-[#E50914]/60'
                }`}
              >
                <ResilientImage
                  src={url}
                  alt={`${event.title} — Foto ${idx + 1}`}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
              </button>
            );
          })}
        </div>
      </section>

      {/* Ingressos disponíveis (Lots, Categories, Prices & Comprar Buttons) */}
      <section id="ingressos-disponiveis" className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-xl sm:text-2xl font-bold text-white tracking-wide">
            Ingressos disponíveis
          </h2>
          <span className="text-xs font-medium text-[#E50914]">
            {event.lots.length} categorias de lotes ativos
          </span>
        </div>

        {event.lots.length === 0 ? (
          <div className="rounded-xl bg-[#11131A] border border-[#232736] p-6 text-xs sm:text-sm text-neutral-300">
            Nenhum lote de ingressos ativo disponível para este evento no momento.
          </div>
        ) : (
          <div className="space-y-3">
            {event.lots.map((lot) => {
              const qty = lotQuantities[lot.id] || 1;
              return (
                <div
                  key={lot.id}
                  className="rounded-xl bg-[#11131A] border border-[#232736] hover:border-[#32374B] p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-colors"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-16 h-12 rounded-lg overflow-hidden border border-[#2A2E3D] shrink-0 bg-[#0B0C10]">
                      <ResilientImage
                        src={lot.thumbnailUrl}
                        alt={lot.name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="min-w-0 space-y-0.5">
                      <h3 className="text-sm sm:text-base font-bold text-white truncate">
                        {lot.name}
                      </h3>
                      <p className="text-xs text-neutral-400">{lot.description}</p>
                      <p className="text-[11px] text-neutral-500 font-mono-tabular">
                        Categoria: {lot.categoryLabel} · {lot.batchNumber}º Lote ({lot.availableQuantity}{' '}
                        disponíveis)
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-4 sm:gap-6 pt-2 sm:pt-0 border-t sm:border-t-0 border-[#1E212D]">
                    {/* Quantity Selector */}
                    <div className="flex items-center gap-2 bg-[#171A24] border border-[#282C3C] rounded-lg px-2 py-1">
                      <button
                        type="button"
                        onClick={() =>
                          setLotQuantities((prev) => ({
                            ...prev,
                            [lot.id]: Math.max(1, (prev[lot.id] || 1) - 1),
                          }))
                        }
                        aria-label={`Diminuir quantidade de ${lot.name}`}
                        className="w-6 h-6 rounded text-neutral-300 hover:text-white hover:bg-[#222636] flex items-center justify-center font-bold"
                      >
                        -
                      </button>
                      <span className="w-5 text-center text-xs font-bold font-mono-tabular text-white">
                        {qty}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setLotQuantities((prev) => ({
                            ...prev,
                            [lot.id]: Math.min(lot.maxPerOrder ?? 10, (prev[lot.id] || 1) + 1),
                          }))
                        }
                        aria-label={`Aumentar quantidade de ${lot.name}`}
                        className="w-6 h-6 rounded text-neutral-300 hover:text-white hover:bg-[#222636] flex items-center justify-center font-bold"
                      >
                        +
                      </button>
                    </div>

                    {/* Lot Price */}
                    <div className="text-right min-w-[88px]">
                      <span className="text-base sm:text-lg font-extrabold text-white font-mono-tabular">
                        {formatBRL(lot.price)}
                      </span>
                    </div>

                    {/* Comprar Button */}
                    <button
                      type="button"
                      disabled={!isEventPublished}
                      onClick={() => {
                        if (!isEventPublished) return;
                        onBuyLot(event, lot, qty);
                      }}
                      className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs sm:text-sm font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-[0_0_16px_rgba(229,9,20,0.3)]"
                    >
                      {isEventPublished ? 'Comprar' : event.status}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Lightbox Modal for Gallery */}
      {lightboxPhoto && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Visualização ampliada da galeria"
        >
          <div className="relative max-w-3xl w-full rounded-2xl overflow-hidden bg-[#11131A] border border-[#2C3144]">
            <button
              type="button"
              onClick={() => setLightboxPhoto(null)}
              aria-label="Fechar imagem ampliada"
              className="absolute top-3 right-3 z-10 w-9 h-9 rounded-full bg-black/75 text-white flex items-center justify-center hover:bg-[#E50914] transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
            <ResilientImage
              src={lightboxPhoto}
              alt={event.title}
              className="w-full max-h-[75vh] object-contain bg-black"
            />
          </div>
        </div>
      )}
    </div>
  );
};
