import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  CreditCard,
  QrCode,
  ShieldCheck,
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  Lock,
  RefreshCw,
  ExternalLink,
  LogIn,
} from 'lucide-react';
import type {
  EventItem,
  TicketLot,
  PaymentMethodType,
  Order,
  Profile,
  MercadoPagoCreatePaymentResponse,
} from '../types/domain';
import {
  calculateOrderTotals,
  formatBRL,
  validateBuyerData,
  type BuyerInput,
} from '../utils/ticketRules';
import {
  reserveOrderInSupabase,
  createMercadoPagoPaymentSession,
  checkOrderPaymentStatusInBackend,
} from '../services/platformService';
import { QRCodeVisual, ResilientImage } from './BrandLogo';

interface CheckoutViewProps {
  event: EventItem;
  selectedLot: TicketLot;
  quantity: number;
  isAuthenticated?: boolean;
  currentUserProfile?: Profile | null;
  authenticatedEmail?: string | null;
  onQuantityChange: (qty: number) => void;
  onSelectLot: (lot: TicketLot) => void;
  onCancelOrder: () => void;
  onRegisterPendingOrder: (order: Order) => void;
  onGoToClientOrders: () => void;
  onGoToClientTickets?: () => void;
  onGoToLogin?: () => void;
  onRefreshUserData?: () => Promise<void> | void;
}

export const CheckoutView: React.FC<CheckoutViewProps> = ({
  event,
  selectedLot,
  quantity,
  isAuthenticated = false,
  currentUserProfile = null,
  authenticatedEmail = null,
  onQuantityChange,
  onSelectLot,
  onCancelOrder,
  onRegisterPendingOrder,
  onGoToClientOrders,
  onGoToClientTickets,
  onGoToLogin,
  onRefreshUserData,
}) => {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(2);
  const [buyer, setBuyer] = useState<BuyerInput>({
    fullName: currentUserProfile?.fullName ?? '',
    cpf: currentUserProfile?.cpf ?? '',
    email: currentUserProfile?.email || authenticatedEmail || '',
    phone: currentUserProfile?.phone ?? '',
  });
  const [errors, setErrors] = useState<Partial<Record<keyof BuyerInput, string>>>({});
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('pix');
  const [copiedPix, setCopiedPix] = useState(false);
  const [createdOrder, setCreatedOrder] = useState<Order | null>(null);
  const [mpSession, setMpSession] = useState<MercadoPagoCreatePaymentResponse | null>(null);
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [statusFeedback, setStatusFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (currentUserProfile || authenticatedEmail) {
      setBuyer((prev) => ({
        fullName: prev.fullName || currentUserProfile?.fullName || '',
        cpf: prev.cpf || currentUserProfile?.cpf || '',
        email: prev.email || currentUserProfile?.email || authenticatedEmail || '',
        phone: prev.phone || currentUserProfile?.phone || '',
      }));
    }
  }, [currentUserProfile, authenticatedEmail]);

  const computedTotals = calculateOrderTotals(selectedLot.price, quantity);
  const displaySubtotal = createdOrder ? createdOrder.subtotal : computedTotals.subtotal;
  const displayConvenienceFee = createdOrder
    ? createdOrder.convenienceFee
    : computedTotals.convenienceFee;
  const displayTotal = createdOrder ? createdOrder.totalAmount : computedTotals.total;

  const handleContinueStep = async () => {
    setCheckoutError(null);
    const validation = validateBuyerData(buyer);
    if (!validation.valid) {
      setErrors(validation.errors);
      setStep(2);
      return;
    }
    setErrors({});
    if (step < 3) {
      setStep(3);
      return;
    }

    if (!isAuthenticated && !currentUserProfile?.id) {
      setCheckoutError(
        'Faça login ou crie sua conta para reservar seus ingressos e gerar o pagamento oficial no Mercado Pago.'
      );
      return;
    }

    setIsSubmittingOrder(true);
    try {
      let activeOrder = createdOrder;

      if (!activeOrder || activeOrder.paymentMethod !== paymentMethod) {
        const reservation = await reserveOrderInSupabase({
          ticketBatchId: selectedLot.id,
          quantity,
          buyerName: buyer.fullName.trim(),
          buyerCpf: buyer.cpf.trim(),
          buyerEmail: buyer.email.trim(),
          buyerPhone: buyer.phone.trim(),
          paymentMethod,
        });

        if (!reservation.ok || !reservation.orderId || !reservation.orderCode) {
          setCheckoutError(
            reservation.errorMessage ??
              'Não foi possível reservar os ingressos no banco de dados. Tente novamente.'
          );
          setIsSubmittingOrder(false);
          return;
        }

        const authoritativeSubtotal = Number(reservation.subtotal ?? computedTotals.subtotal);
        const authoritativeFee = Number(
          reservation.convenienceFee ?? computedTotals.convenienceFee
        );
        const authoritativeTotal = Number(reservation.totalAmount ?? computedTotals.total);

        activeOrder = {
          id: reservation.orderId,
          orderCode: reservation.orderCode,
          userId: currentUserProfile?.id ?? '',
          buyerName: buyer.fullName.trim(),
          buyerCpf: buyer.cpf.trim(),
          buyerEmail: buyer.email.trim(),
          buyerPhone: buyer.phone.trim(),
          eventId: event.id,
          eventTitle: event.title,
          eventDate: event.dateFormatted,
          eventLocation: event.city,
          items: [
            {
              id: `${reservation.orderId}-item-1`,
              lotId: selectedLot.id,
              lotName: selectedLot.name,
              unitPrice: Number(reservation.unitPrice ?? selectedLot.price),
              quantity,
              subtotal: authoritativeSubtotal,
            },
          ],
          subtotal: authoritativeSubtotal,
          convenienceFee: authoritativeFee,
          totalAmount: authoritativeTotal,
          paymentMethod,
          status: reservation.orderStatus ?? 'pending_payment',
          paymentStatus: reservation.paymentStatus ?? 'pending',
          reservationExpiresAt: reservation.reservationExpiresAt,
          createdAt: new Date().toLocaleString('pt-BR'),
        };

        setCreatedOrder(activeOrder);
        onRegisterPendingOrder(activeOrder);
      }

      const paymentRes = await createMercadoPagoPaymentSession({
        orderId: activeOrder.id,
        paymentMethod,
      });

      if (!paymentRes.ok) {
        setMpSession(null);
        setStep(4);
        setCheckoutError(
          paymentRes.errorMessage ??
            'A reserva do pedido foi registrada, mas não foi possível gerar a cobrança no Mercado Pago neste momento.'
        );
        setIsSubmittingOrder(false);
        return;
      }

      const updatedOrder: Order = {
        ...activeOrder,
        subtotal: Number(paymentRes.subtotal || activeOrder.subtotal),
        convenienceFee: Number(paymentRes.convenienceFee || activeOrder.convenienceFee),
        totalAmount: Number(paymentRes.totalAmount || activeOrder.totalAmount),
        mpPreferenceId: paymentRes.preferenceId ?? activeOrder.mpPreferenceId,
        mpPaymentId: paymentRes.mpPaymentId ?? activeOrder.mpPaymentId,
        status: 'pending_payment',
        paymentStatus: 'pending',
      };

      setCreatedOrder(updatedOrder);
      setMpSession(paymentRes);
      setStep(4);
      if (onRefreshUserData) {
        await onRefreshUserData();
      }
    } catch (err) {
      setCheckoutError(
        err instanceof Error
          ? err.message
          : 'Erro inesperado ao processar reserva e pagamento.'
      );
    } finally {
      setIsSubmittingOrder(false);
    }
  };

  const handleCopyPix = () => {
    const codeToCopy = mpSession?.pixQrCode?.trim();
    if (!codeToCopy) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(codeToCopy).catch(() => {});
    }
    setCopiedPix(true);
    setTimeout(() => setCopiedPix(false), 2500);
  };

  const handleCheckPaymentStatus = async () => {
    if (!createdOrder?.id) return;
    setIsCheckingStatus(true);
    setStatusFeedback(null);
    try {
      const statusRes = await checkOrderPaymentStatusInBackend(createdOrder.id);
      if (!statusRes.ok) {
        setStatusFeedback(
          statusRes.errorMessage ?? 'Não foi possível consultar o status do pagamento agora.'
        );
        return;
      }

      setCreatedOrder((prev) =>
        prev
          ? {
              ...prev,
              status: statusRes.orderStatus ?? prev.status,
              paymentStatus: statusRes.paymentStatus ?? prev.paymentStatus,
              mpPreferenceId: statusRes.mpPreferenceId ?? prev.mpPreferenceId,
              mpPaymentId: statusRes.mpPaymentId ?? prev.mpPaymentId,
            }
          : prev
      );

      if (onRefreshUserData) {
        await onRefreshUserData();
      }

      if (statusRes.orderStatus === 'paid' && statusRes.paymentStatus === 'approved') {
        setStatusFeedback(
          'Pagamento aprovado e confirmado pelo Mercado Pago! Seus ingressos oficiais já foram emitidos.'
        );
      } else {
        setStatusFeedback(
          `Status atual do pedido ${statusRes.orderCode ?? createdOrder.orderCode}: aguardando confirmação oficial do pagamento pelo webhook do Mercado Pago.`
        );
      }
    } finally {
      setIsCheckingStatus(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10 space-y-8 pb-20">
      {/* Stepper Header: 1 Ingressos — 2 Dados — 3 Pagamento — 4 Confirmação */}
      <div className="rounded-xl bg-[#11131A] border border-[#222532] px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2 max-w-3xl mx-auto">
          {[
            { num: 1, label: 'Ingressos' },
            { num: 2, label: 'Dados' },
            { num: 3, label: 'Pagamento' },
            { num: 4, label: 'Confirmação' },
          ].map((item, idx) => {
            const isCompleted = step > item.num;
            const isCurrent = step === item.num;
            return (
              <React.Fragment key={item.num}>
                <button
                  type="button"
                  onClick={() => {
                    if (item.num <= 3 && !createdOrder) setStep(item.num as 1 | 2 | 3);
                  }}
                  className="flex items-center gap-2 text-xs sm:text-sm font-medium cursor-pointer"
                >
                  <span
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold font-mono-tabular ${
                      isCompleted || isCurrent
                        ? 'bg-[#E50914] text-white shadow-[0_0_12px_rgba(229,9,20,0.5)]'
                        : 'bg-[#1D202C] text-neutral-400 border border-[#2D3244]'
                    }`}
                  >
                    {isCompleted ? <Check className="w-3.5 h-3.5" /> : item.num}
                  </span>
                  <span
                    className={
                      isCurrent
                        ? 'text-white font-semibold'
                        : isCompleted
                        ? 'text-neutral-200'
                        : 'text-neutral-500'
                    }
                  >
                    {item.label}
                  </span>
                </button>
                {idx < 3 && (
                  <div
                    className={`hidden sm:block flex-1 h-px mx-2 ${
                      step > item.num ? 'bg-[#E50914]' : 'bg-[#252938]'
                    }`}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Main Checkout Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
        {/* Left Column: Checkout Order Summary & Dados do Comprador */}
        <div className="lg:col-span-7 rounded-2xl bg-[#11131A] border border-[#232736] p-5 sm:p-7 space-y-6">
          <div className="flex items-center justify-between border-b border-[#1E2230] pb-4">
            <h1 className="font-display text-2xl font-bold text-white">Checkout</h1>
            <span className="text-xs text-neutral-400 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-[#E50914]" />
              Integração Oficial Mercado Pago (PIX & Cartão de Crédito)
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
            {/* Ticket Summary Card */}
            <div className="md:col-span-6 rounded-xl bg-[#0D0F15] border border-[#242838] p-4 flex flex-col justify-between space-y-4">
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-16 h-12 rounded-lg overflow-hidden border border-[#2B3042] shrink-0">
                    <ResilientImage
                      src={event.cardImageUrl}
                      alt={event.title}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-sm font-bold text-white leading-snug line-clamp-2">
                      {event.title}
                    </h2>
                    <p className="text-[11px] text-neutral-400 mt-0.5">
                      {event.dateFormatted} - {event.city}
                    </p>
                  </div>
                </div>

                {/* Lot Selector Dropdown */}
                <div className="space-y-1">
                  <label
                    htmlFor="checkout-lot-select"
                    className="block text-[11px] text-neutral-400"
                  >
                    Lote / Categoria selecionada
                  </label>
                  <select
                    id="checkout-lot-select"
                    value={selectedLot.id}
                    disabled={Boolean(createdOrder)}
                    onChange={(e) => {
                      const found = event.lots.find((l) => l.id === e.target.value);
                      if (found) onSelectLot(found);
                    }}
                    className="w-full rounded-lg bg-[#151822] border border-[#292E40] px-3 py-2 text-xs font-semibold text-white focus:outline-none focus:border-[#E50914] disabled:opacity-60"
                  >
                    {event.lots.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} — {formatBRL(l.price)}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Selected Lot & Quantity Stepper */}
                <div className="rounded-lg bg-[#151822] border border-[#252A3A] p-3 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-white">{selectedLot.name}</span>
                    <span className="text-xs font-bold font-mono-tabular text-white">
                      {formatBRL(selectedLot.price)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[11px] text-neutral-400">Quantidade</span>
                    <div className="flex items-center gap-2 bg-[#0D0F15] border border-[#2B3042] rounded-md px-2 py-0.5">
                      <button
                        type="button"
                        disabled={Boolean(createdOrder)}
                        onClick={() => onQuantityChange(Math.max(1, quantity - 1))}
                        aria-label="Diminuir quantidade de ingressos"
                        className="w-6 h-6 text-neutral-300 hover:text-white font-bold disabled:opacity-40"
                      >
                        -
                      </button>
                      <span className="w-5 text-center text-xs font-bold font-mono-tabular text-white">
                        {quantity}
                      </span>
                      <button
                        type="button"
                        disabled={Boolean(createdOrder)}
                        onClick={() => onQuantityChange(Math.min(10, quantity + 1))}
                        aria-label="Aumentar quantidade de ingressos"
                        className="w-6 h-6 text-neutral-300 hover:text-white font-bold disabled:opacity-40"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                {/* Explicit Breakdown: Subtotal, Taxa de serviço (6%) & Total */}
                <div className="space-y-2 pt-2 border-t border-[#1F2330] text-xs">
                  <div className="flex items-center justify-between text-neutral-300">
                    <span>Subtotal</span>
                    <span className="font-mono-tabular font-semibold" data-testid="checkout-subtotal">
                      {formatBRL(displaySubtotal)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-neutral-400">
                    <span>Taxa de serviço (6%)</span>
                    <span className="font-mono-tabular" data-testid="checkout-service-fee">
                      {formatBRL(displayConvenienceFee)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm font-bold text-white pt-2 border-t border-[#1F2330]">
                    <span>Total</span>
                    <span
                      className="text-base font-extrabold font-mono-tabular"
                      data-testid="checkout-total"
                    >
                      {formatBRL(displayTotal)}
                    </span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                disabled={isSubmittingOrder || createdOrder?.status === 'paid'}
                onClick={handleContinueStep}
                className="w-full py-3 rounded-lg bg-[#E50914] hover:bg-[#c80710] disabled:opacity-60 text-white font-bold text-xs sm:text-sm uppercase tracking-wider transition-all shadow-[0_0_20px_rgba(229,9,20,0.35)] cursor-pointer flex items-center justify-center gap-2"
              >
                {isSubmittingOrder ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Processando...</span>
                  </>
                ) : step < 3 ? (
                  <span>Continuar para Pagamento</span>
                ) : paymentMethod === 'pix' ? (
                  <span>Gerar PIX Oficial ({formatBRL(displayTotal)})</span>
                ) : (
                  <span>Pagar com Cartão de Crédito ({formatBRL(displayTotal)})</span>
                )}
              </button>
            </div>

            {/* Dados do comprador Form */}
            <div className="md:col-span-6 space-y-3.5">
              <div>
                <h2 className="text-sm font-bold text-white">Dados do comprador</h2>
                <p className="text-[11px] text-neutral-400 mt-0.5">
                  Seus dados serão usados para a emissão nominal dos ingressos.
                </p>
              </div>

              <div className="space-y-3">
                <div>
                  <label htmlFor="buyer-name" className="block text-xs text-neutral-300 mb-1">
                    Nome completo
                  </label>
                  <input
                    id="buyer-name"
                    type="text"
                    disabled={Boolean(createdOrder)}
                    value={buyer.fullName}
                    onChange={(e) => setBuyer({ ...buyer, fullName: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914] disabled:opacity-60"
                  />
                  {errors.fullName && (
                    <p className="text-[11px] text-[#E50914] mt-1">{errors.fullName}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="buyer-cpf" className="block text-xs text-neutral-300 mb-1">
                    CPF
                  </label>
                  <input
                    id="buyer-cpf"
                    type="text"
                    disabled={Boolean(createdOrder)}
                    value={buyer.cpf}
                    onChange={(e) => setBuyer({ ...buyer, cpf: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914] disabled:opacity-60"
                  />
                  {errors.cpf && <p className="text-[11px] text-[#E50914] mt-1">{errors.cpf}</p>}
                </div>

                <div>
                  <label htmlFor="buyer-email" className="block text-xs text-neutral-300 mb-1">
                    E-mail
                  </label>
                  <input
                    id="buyer-email"
                    type="email"
                    disabled={Boolean(createdOrder)}
                    value={buyer.email}
                    onChange={(e) => setBuyer({ ...buyer, email: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914] disabled:opacity-60"
                  />
                  {errors.email && (
                    <p className="text-[11px] text-[#E50914] mt-1">{errors.email}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="buyer-phone" className="block text-xs text-neutral-300 mb-1">
                    Telefone
                  </label>
                  <input
                    id="buyer-phone"
                    type="tel"
                    disabled={Boolean(createdOrder)}
                    value={buyer.phone}
                    onChange={(e) => setBuyer({ ...buyer, phone: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914] disabled:opacity-60"
                  />
                  {errors.phone && (
                    <p className="text-[11px] text-[#E50914] mt-1">{errors.phone}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Pagamento (Exclusivamente PIX e Cartão de Crédito) */}
        <div className="lg:col-span-5 rounded-2xl bg-[#11131A] border border-[#232736] p-5 sm:p-7 space-y-5">
          <div>
            <h2 className="font-display text-xl font-bold text-white">Pagamento</h2>
            <p className="text-xs text-neutral-400 mt-0.5">
              Escolha a forma de pagamento (taxa única de serviço de 6% já incluída no total)
            </p>
          </div>

          {/* Payment Options: Exclusively Pix & Cartão de Crédito */}
          <div className="space-y-3">
            <button
              type="button"
              disabled={Boolean(createdOrder && mpSession)}
              onClick={() => setPaymentMethod('pix')}
              className={`w-full text-left p-4 rounded-xl border transition-all flex items-center justify-between gap-3 cursor-pointer disabled:opacity-70 ${
                paymentMethod === 'pix'
                  ? 'bg-[#161924] border-[#E50914] shadow-[0_0_20px_rgba(229,9,20,0.18)]'
                  : 'bg-[#0E1017] border-[#25293A] hover:border-[#373C52]'
              }`}
            >
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
                  <QrCode className="w-5 h-5" />
                </div>
                <div>
                  <span className="block text-sm font-bold text-white">Pix</span>
                  <span className="block text-xs text-neutral-400">
                    Pague com Pix e tenha a confirmação mais rápida via Mercado Pago.
                  </span>
                </div>
              </div>
              <span
                className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                  paymentMethod === 'pix' ? 'border-[#E50914]' : 'border-neutral-600'
                }`}
              >
                {paymentMethod === 'pix' && (
                  <span className="w-2 h-2 rounded-full bg-[#E50914]" />
                )}
              </span>
            </button>

            <button
              type="button"
              disabled={Boolean(createdOrder && mpSession)}
              onClick={() => setPaymentMethod('credit_card')}
              className={`w-full text-left p-4 rounded-xl border transition-all flex items-center justify-between gap-3 cursor-pointer disabled:opacity-70 ${
                paymentMethod === 'credit_card'
                  ? 'bg-[#161924] border-[#E50914] shadow-[0_0_20px_rgba(229,9,20,0.18)]'
                  : 'bg-[#0E1017] border-[#25293A] hover:border-[#373C52]'
              }`}
            >
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-lg bg-[#1F2330] border border-[#2E3446] flex items-center justify-center text-neutral-200 shrink-0">
                  <CreditCard className="w-5 h-5" />
                </div>
                <div>
                  <span className="block text-sm font-bold text-white">Cartão de Crédito</span>
                  <span className="block text-xs text-neutral-400">
                    Pague com cartão de crédito pelo Checkout Seguro do Mercado Pago.
                  </span>
                </div>
              </div>
              <span
                className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                  paymentMethod === 'credit_card' ? 'border-[#E50914]' : 'border-neutral-600'
                }`}
              >
                {paymentMethod === 'credit_card' && (
                  <span className="w-2 h-2 rounded-full bg-[#E50914]" />
                )}
              </span>
            </button>
          </div>

          {!isAuthenticated && !currentUserProfile?.id && (
            <div className="rounded-xl bg-[#18141B] border border-[#E50914]/40 p-4 space-y-3">
              <p className="text-xs font-semibold text-white">
                Autenticação obrigatória para reservar ingressos e pagar
              </p>
              <p className="text-xs text-neutral-300 leading-relaxed">
                Para garantir que seus ingressos nominais e QR Codes fiquem vinculados com segurança
                ao seu CPF em <code className="text-neutral-200">public.orders</code>, entre na sua
                conta antes de finalizar.
              </p>
              {onGoToLogin && (
                <button
                  type="button"
                  onClick={onGoToLogin}
                  className="px-4 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span>Entrar ou Criar Conta</span>
                </button>
              )}
            </div>
          )}

          {checkoutError && (
            <div className="rounded-xl bg-[#1F1216] border border-[#E50914]/50 p-4 flex items-start gap-3">
              <AlertCircle className="w-4 h-4 text-[#E50914] shrink-0 mt-0.5" />
              <div className="text-xs text-neutral-200 space-y-1">
                <p className="font-bold text-white">Não foi possível concluir a etapa</p>
                <p>{checkoutError}</p>
              </div>
            </div>
          )}

          {/* Payment Method Detail Area */}
          {paymentMethod === 'pix' ? (
            <div className="rounded-xl bg-[#0D0F15] border border-[#242838] p-4 space-y-4">
              {mpSession?.pixQrCode ? (
                <div className="flex flex-col sm:flex-row items-center gap-4">
                  {mpSession.pixQrCodeBase64 ? (
                    <img
                      src={`data:image/png;base64,${mpSession.pixQrCodeBase64}`}
                      alt="QR Code PIX Oficial Mercado Pago"
                      className="w-28 h-28 rounded-lg bg-white p-1.5 shrink-0"
                    />
                  ) : (
                    <QRCodeVisual value={mpSession.pixQrCode} size={112} className="shrink-0" />
                  )}
                  <div className="space-y-2 w-full min-w-0">
                    <h3 className="text-sm font-bold text-white">
                      PIX Oficial Gerado ({formatBRL(displayTotal)})
                    </h3>
                    <p className="text-xs text-neutral-400">
                      Escaneie o QR Code ou copie o código Pix Copia e Cola gerado na API oficial do
                      Mercado Pago para o pedido{' '}
                      <span className="text-white font-semibold">{createdOrder?.orderCode}</span>.
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={mpSession.pixQrCode}
                        aria-label="Código Pix Copia e Cola"
                        className="w-full px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-neutral-300 font-mono-tabular truncate"
                      />
                      <button
                        type="button"
                        onClick={handleCopyPix}
                        className="px-3.5 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
                      >
                        {copiedPix ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>{copiedPix ? 'Copiado' : 'Copiar código'}</span>
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <h3 className="text-sm font-bold text-white">Pagamento Instantâneo via PIX</h3>
                  <p className="text-xs text-neutral-400 leading-relaxed">
                    Ao confirmar os dados e clicar em{' '}
                    <strong className="text-white">Gerar PIX Oficial</strong>, o sistema reservará
                    seu lote em <code className="text-neutral-300">public.orders</code> pelo valor
                    exato de <strong className="text-white">{formatBRL(displayTotal)}</strong>{' '}
                    (Subtotal {formatBRL(displaySubtotal)} + Taxa de serviço 6% de{' '}
                    {formatBRL(displayConvenienceFee)}) e gerará o QR Code PIX dinâmico na API
                    oficial do Mercado Pago.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl bg-[#0D0F15] border border-[#242838] p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <ShieldCheck className="w-4 h-4 text-[#E50914]" />
                <span>Checkout Oficial Mercado Pago — Cartão de Crédito</span>
              </div>
              {mpSession?.initPoint ? (
                <div className="space-y-3">
                  <p className="text-xs text-neutral-300 leading-relaxed">
                    Preferência oficial gerada para o pedido{' '}
                    <strong className="text-white">{createdOrder?.orderCode}</strong> no valor
                    definitivo de <strong className="text-white">{formatBRL(displayTotal)}</strong>.
                    Prossiga para o ambiente seguro do Mercado Pago para concluir o pagamento com
                    cartão de crédito:
                  </p>
                  <a
                    href={mpSession.initPoint}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full py-2.5 px-4 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold uppercase tracking-wider inline-flex items-center justify-center gap-2 transition-colors"
                  >
                    <span>Abrir Checkout Cartão de Crédito no Mercado Pago</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              ) : (
                <p className="text-xs text-neutral-400 leading-relaxed">
                  Ao confirmar os dados e clicar em{' '}
                  <strong className="text-white">Pagar com Cartão de Crédito</strong>, o servidor
                  criará a preferência oficial no Mercado Pago pelo valor exato de{' '}
                  <strong className="text-white">{formatBRL(displayTotal)}</strong> (com a taxa de
                  serviço de 6% incluída uma única vez, sem habilitar débito ou boleto).
                </p>
              )}
            </div>
          )}

          {/* Architectural Integrity Notice */}
          <div className="rounded-xl bg-[#161822] border border-[#2A2F42] p-3.5 flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-[11px] text-neutral-300 leading-relaxed space-y-1">
              <p className="font-semibold text-white">
                Fluxo Oficial de Validação (Webhook Mercado Pago + Supabase)
              </p>
              <p>
                A emissão definitiva do ingresso e do QR Code ocorre exclusivamente após a
                confirmação oficial do pagamento pelo webhook validado do Mercado Pago no servidor.
              </p>
            </div>
          </div>

          {step === 4 && createdOrder && (
            <div
              className={`rounded-xl border p-4 space-y-3 ${
                createdOrder.status === 'paid'
                  ? 'bg-[#102219] border-emerald-500/60'
                  : 'bg-[#141E19] border-emerald-500/40'
              }`}
            >
              <p className="text-xs font-bold text-emerald-400">
                {createdOrder.status === 'paid'
                  ? `Pedido ${createdOrder.orderCode} PAGO — Ingressos Emitidos!`
                  : `Pedido ${createdOrder.orderCode} registrado: Aguardando Confirmação Oficial`}
              </p>
              <p className="text-xs text-neutral-300">
                {createdOrder.status === 'paid'
                  ? 'Seu pagamento foi confirmado pelo Mercado Pago e seus ingressos já estão disponíveis com QR Code oficial.'
                  : 'Assim que o webhook do Mercado Pago confirmar a transação em public.orders, seus ingressos serão emitidos automaticamente.'}
              </p>

              {statusFeedback && (
                <p className="text-xs text-amber-300 font-medium">{statusFeedback}</p>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-1">
                {createdOrder.status !== 'paid' && (
                  <button
                    type="button"
                    disabled={isCheckingStatus}
                    onClick={handleCheckPaymentStatus}
                    className="px-3.5 py-2 rounded-lg bg-[#1A2420] hover:bg-[#22302A] border border-emerald-500/40 text-xs font-bold text-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${isCheckingStatus ? 'animate-spin' : ''}`}
                    />
                    <span>Verificar status do pagamento</span>
                  </button>
                )}

                {createdOrder.status === 'paid' && onGoToClientTickets ? (
                  <button
                    type="button"
                    onClick={onGoToClientTickets}
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer"
                  >
                    <span>Abrir Meus Ingressos</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onGoToClientOrders}
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-white hover:text-[#E50914] transition-colors cursor-pointer"
                  >
                    <span>Acompanhar em Meus Pedidos</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="pt-1 flex items-center justify-between">
            <button
              type="button"
              onClick={onCancelOrder}
              className="inline-flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Voltar ao evento</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

