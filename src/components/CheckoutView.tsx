import React, { useState } from 'react';
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
} from 'lucide-react';
import type { EventItem, TicketLot, PaymentMethodType, Order } from '../types/domain';
import {
  calculateOrderTotals,
  formatBRL,
  validateBuyerData,
  type BuyerInput,
} from '../utils/ticketRules';
import { QRCodeVisual, ResilientImage } from './BrandLogo';

interface CheckoutViewProps {
  event: EventItem;
  selectedLot: TicketLot;
  quantity: number;
  onQuantityChange: (qty: number) => void;
  onSelectLot: (lot: TicketLot) => void;
  onCancelOrder: () => void;
  onRegisterPendingOrder: (order: Order) => void;
  onGoToClientOrders: () => void;
}

export const CheckoutView: React.FC<CheckoutViewProps> = ({
  event,
  selectedLot,
  quantity,
  onQuantityChange,
  onSelectLot,
  onCancelOrder,
  onRegisterPendingOrder,
  onGoToClientOrders,
}) => {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(2);
  const [buyer, setBuyer] = useState<BuyerInput>({
    fullName: 'João da Silva',
    cpf: '123.456.789-00',
    email: 'joao@email.com',
    phone: '(11) 98765-4321',
  });
  const [errors, setErrors] = useState<Partial<Record<keyof BuyerInput, string>>>({});
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('pix');
  const [copiedPix, setCopiedPix] = useState(false);
  const [createdOrder, setCreatedOrder] = useState<Order | null>(null);

  const totals = calculateOrderTotals(selectedLot.price, quantity);

  const pixCopyPasteCode =
    '00020101021226820014br.gov.bcb.pix2560pxcuston.mercadopago.com/qr/v2/px-custon-checkout-pending5204000053039865802BR';

  const handleContinueStep = () => {
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

    // Create order in pending_payment state (never fake payment approval on frontend)
    const pendingOrder: Order = {
      id: `ORD-${Date.now()}`,
      orderCode: `#PX-${Math.floor(10000 + Math.random() * 89999)}`,
      userId: 'usr-joao',
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
          id: `ITM-${Date.now()}`,
          lotId: selectedLot.id,
          lotName: selectedLot.name,
          unitPrice: selectedLot.price,
          quantity,
          subtotal: totals.subtotal,
        },
      ],
      subtotal: totals.subtotal,
      convenienceFee: totals.convenienceFee,
      totalAmount: totals.total,
      paymentMethod,
      status: 'pending_payment',
      mpPreferenceId: 'AGUARDANDO_BACKEND_MP_PREFERENCE',
      createdAt: new Date().toLocaleString('pt-BR'),
    };

    setCreatedOrder(pendingOrder);
    onRegisterPendingOrder(pendingOrder);
    setStep(4);
  };

  const handleCopyPix = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(pixCopyPasteCode).catch(() => {});
    }
    setCopiedPix(true);
    setTimeout(() => setCopiedPix(false), 2500);
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
                    if (item.num <= 3) setStep(item.num as 1 | 2 | 3);
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

      {/* Main Checkout Layout (Matches Bottom-Left & Bottom-Center Reference Panels) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
        {/* Left Column: Checkout Order Summary & Dados do Comprador */}
        <div className="lg:col-span-7 rounded-2xl bg-[#11131A] border border-[#232736] p-5 sm:p-7 space-y-6">
          <div className="flex items-center justify-between border-b border-[#1E2230] pb-4">
            <h1 className="font-display text-2xl font-bold text-white">Checkout</h1>
            <span className="text-xs text-neutral-400 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-[#E50914]" />
              Ambiente preparado para Mercado Pago
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
                      25 de Abril de 2025 - {event.city}
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
                    onChange={(e) => {
                      const found = event.lots.find((l) => l.id === e.target.value);
                      if (found) onSelectLot(found);
                    }}
                    className="w-full rounded-lg bg-[#151822] border border-[#292E40] px-3 py-2 text-xs font-semibold text-white focus:outline-none focus:border-[#E50914]"
                  >
                    {event.lots.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} — {formatBRL(l.price)}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Selected Lot & Quantity Stepper (- 2 +) */}
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
                        onClick={() => onQuantityChange(Math.max(1, quantity - 1))}
                        aria-label="Diminuir quantidade de ingressos"
                        className="w-6 h-6 text-neutral-300 hover:text-white font-bold"
                      >
                        -
                      </button>
                      <span className="w-5 text-center text-xs font-bold font-mono-tabular text-white">
                        {quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => onQuantityChange(Math.min(10, quantity + 1))}
                        aria-label="Aumentar quantidade de ingressos"
                        className="w-6 h-6 text-neutral-300 hover:text-white font-bold"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                {/* Subtotal, Taxa de conveniência & Total */}
                <div className="space-y-2 pt-2 border-t border-[#1F2330] text-xs">
                  <div className="flex items-center justify-between text-neutral-300">
                    <span>Subtotal</span>
                    <span className="font-mono-tabular font-semibold">
                      {formatBRL(totals.subtotal)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-neutral-400">
                    <span>Taxa de conveniência</span>
                    <span className="font-mono-tabular">{formatBRL(totals.convenienceFee)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm font-bold text-white pt-2 border-t border-[#1F2330]">
                    <span>Total</span>
                    <span className="text-base font-extrabold font-mono-tabular">
                      {formatBRL(totals.total)}
                    </span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={handleContinueStep}
                className="w-full py-3 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white font-bold text-xs sm:text-sm uppercase tracking-wider transition-all shadow-[0_0_20px_rgba(229,9,20,0.35)] cursor-pointer"
              >
                Continuar
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
                    value={buyer.fullName}
                    onChange={(e) => setBuyer({ ...buyer, fullName: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914]"
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
                    value={buyer.cpf}
                    onChange={(e) => setBuyer({ ...buyer, cpf: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914]"
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
                    value={buyer.email}
                    onChange={(e) => setBuyer({ ...buyer, email: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white focus:outline-none focus:border-[#E50914]"
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
                    value={buyer.phone}
                    onChange={(e) => setBuyer({ ...buyer, phone: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#161924] border border-[#2B3042] text-sm text-white font-mono-tabular focus:outline-none focus:border-[#E50914]"
                  />
                  {errors.phone && (
                    <p className="text-[11px] text-[#E50914] mt-1">{errors.phone}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Pagamento (Matches Bottom-Center Reference Panel) */}
        <div className="lg:col-span-5 rounded-2xl bg-[#11131A] border border-[#232736] p-5 sm:p-7 space-y-5">
          <div>
            <h2 className="font-display text-xl font-bold text-white">Pagamento</h2>
            <p className="text-xs text-neutral-400 mt-0.5">Escolha a forma de pagamento</p>
          </div>

          {/* Payment Options: Pix & Cartão de Crédito */}
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setPaymentMethod('pix')}
              className={`w-full text-left p-4 rounded-xl border transition-all flex items-center justify-between gap-3 cursor-pointer ${
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
                    Pague com Pix e tenha a confirmação mais rápida.
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
              onClick={() => setPaymentMethod('credit_card')}
              className={`w-full text-left p-4 rounded-xl border transition-all flex items-center justify-between gap-3 cursor-pointer ${
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
                    Pague em até 12x, com segurança e praticidade.
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

          {/* Payment Method Detail Area */}
          {paymentMethod === 'pix' ? (
            <div className="rounded-xl bg-[#0D0F15] border border-[#242838] p-4 space-y-4">
              <div className="flex flex-col sm:flex-row items-center gap-4">
                <QRCodeVisual value={pixCopyPasteCode} size={112} className="shrink-0" />
                <div className="space-y-2 w-full min-w-0">
                  <h3 className="text-sm font-bold text-white">Pague com Pix</h3>
                  <p className="text-xs text-neutral-400">
                    Escaneie o QR Code ou copie o código Pix Copia e Cola gerado pelo Mercado Pago.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={pixCopyPasteCode}
                      aria-label="Código Pix Copia e Cola"
                      className="w-full px-3 py-2 rounded-lg bg-[#161924] border border-[#2B3042] text-xs text-neutral-300 font-mono-tabular truncate"
                    />
                    <button
                      type="button"
                      onClick={handleCopyPix}
                      className="px-3.5 py-2 rounded-lg bg-[#E50914] hover:bg-[#c80710] text-white text-xs font-bold whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
                    >
                      {copiedPix ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedPix ? 'Copiado' : 'Copiar código'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-[#0D0F15] border border-[#242838] p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <ShieldCheck className="w-4 h-4 text-[#E50914]" />
                <span>Tokenização Segura Mercado Pago (`VITE_MP_PUBLIC_KEY`)</span>
              </div>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Os dados sensíveis do cartão são criptografados diretamente pelo SDK oficial do
                Mercado Pago e validados no backend (`/api/payments/mercadopago`) sem armazenamento
                local.
              </p>
            </div>
          )}

          {/* Architectural Integrity Notice: Never fake completed payments on frontend */}
          <div className="rounded-xl bg-[#161822] border border-[#2A2F42] p-3.5 flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-[11px] text-neutral-300 leading-relaxed space-y-1">
              <p className="font-semibold text-white">
                Fluxo Oficial de Validação (Webhook Mercado Pago + Supabase)
              </p>
              <p>
                A liberação definitiva do ingresso e do QR Code ocorre exclusivamente após a
                confirmação oficial do pagamento pelo webhook validado do Mercado Pago no servidor.
              </p>
            </div>
          </div>

          {step === 4 && createdOrder && (
            <div className="rounded-xl bg-[#141E19] border border-emerald-500/40 p-4 space-y-2">
              <p className="text-xs font-bold text-emerald-400">
                Pedido {createdOrder.orderCode} registrado com status: Aguardando Confirmação Oficial
              </p>
              <p className="text-xs text-neutral-300">
                Assim que o webhook do Mercado Pago confirmar a transação, seus ingressos passarão
                automaticamente de <code className="text-amber-300">pending</code> para{' '}
                <code className="text-emerald-300">paid</code>.
              </p>
              <button
                type="button"
                onClick={onGoToClientOrders}
                className="mt-1 inline-flex items-center gap-1.5 text-xs font-bold text-white hover:text-[#E50914] transition-colors cursor-pointer"
              >
                <span>Acompanhar em Meus Pedidos</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="pt-1 flex items-center justify-between">
            <button
              type="button"
              onClick={onCancelOrder}
              className="inline-flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Cancelar pedido</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
