import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.resolve(__dirname, 'dist');
const indexHtmlPath = path.join(distDir, 'index.html');

const NO_CACHE_FILES = new Set([
  '/index.html',
  '/sw.js',
  '/registerSW.js',
  '/manifest.webmanifest',
]);

const CONVENIENCE_FEE_RATE = 0.06;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlaceholderValue(val) {
  const clean = String(val || '').trim();
  if (!clean) return true;
  const lower = clean.toLowerCase();
  return (
    lower.includes('your-project-id') ||
    lower.includes('your-supabase-') ||
    lower.includes('your-mercado-pago-') ||
    lower === 'my_app_url'
  );
}

/**
 * Verifies the definitive 6% service fee rule on a database order row:
 * subtotal = round(unit_price * quantity, 2)
 * convenience_fee = round(subtotal * 0.06, 2)
 * total_amount = round(subtotal + convenience_fee, 2)
 */
export function verifyOrderMath6Percent(order) {
  const unitPrice = Number(order?.unit_price);
  const quantity = Number(order?.quantity);
  const subtotal = Number(order?.subtotal);
  const convenienceFee = Number(order?.convenience_fee);
  const totalAmount = Number(order?.total_amount);

  if (
    !Number.isFinite(unitPrice) ||
    unitPrice <= 0 ||
    !Number.isInteger(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(subtotal) ||
    !Number.isFinite(convenienceFee) ||
    !Number.isFinite(totalAmount) ||
    totalAmount <= 0
  ) {
    return {
      ok: false,
      errorMessage: 'Valores financeiros do pedido inválidos ou não positivos.',
    };
  }

  const expectedSubtotal = Number((unitPrice * quantity).toFixed(2));
  const expectedFee = Number((expectedSubtotal * CONVENIENCE_FEE_RATE).toFixed(2));
  const expectedTotal = Number((expectedSubtotal + expectedFee).toFixed(2));

  if (
    Math.round(subtotal * 100) !== Math.round(expectedSubtotal * 100) ||
    Math.round(convenienceFee * 100) !== Math.round(expectedFee * 100) ||
    Math.round(totalAmount * 100) !== Math.round(expectedTotal * 100)
  ) {
    return {
      ok: false,
      errorMessage: `Inconsistência na regra financeira de 6%: esperado subtotal=${expectedSubtotal.toFixed(
        2
      )}, taxa=${expectedFee.toFixed(2)}, total=${expectedTotal.toFixed(
        2
      )}, encontrado subtotal=${subtotal.toFixed(2)}, taxa=${convenienceFee.toFixed(
        2
      )}, total=${totalAmount.toFixed(2)}.`,
    };
  }

  return {
    ok: true,
    unitPrice,
    quantity,
    subtotal: expectedSubtotal,
    convenienceFee: expectedFee,
    totalAmount: expectedTotal,
  };
}

/**
 * Verifies the Mercado Pago webhook HMAC-SHA256 signature (`x-signature` and `x-request-id`)
 * using constant-time comparison (`crypto.timingSafeEqual`).
 */
export function verifyWebhookSignatureHmac({
  xSignatureHeader,
  xRequestIdHeader,
  dataId,
  webhookSecret,
}) {
  const secret = String(webhookSecret || '').trim();
  if (!secret || isPlaceholderValue(secret)) {
    return {
      ok: false,
      errorMessage: 'MP_WEBHOOK_SECRET não configurado no servidor.',
    };
  }

  const rawSig = String(xSignatureHeader || '').trim();
  if (!rawSig) {
    return {
      ok: false,
      errorMessage: 'Cabeçalho x-signature ausente na requisição de webhook.',
    };
  }

  let ts = '';
  let v1 = '';
  for (const part of rawSig.split(',')) {
    const [k, ...rest] = part.split('=');
    if (!k || rest.length === 0) continue;
    const key = k.trim().toLowerCase();
    const val = rest.join('=').trim();
    if (key === 'ts') ts = val;
    if (key === 'v1') v1 = val.toLowerCase();
  }

  if (!ts || !/^\d+$/.test(ts) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) {
    return {
      ok: false,
      errorMessage: 'Formato inválido no cabeçalho x-signature.',
    };
  }

  const cleanId = String(dataId || '').trim().toLowerCase();
  const cleanReqId = String(xRequestIdHeader || '').trim();

  let manifest = '';
  if (cleanId) manifest += `id:${cleanId};`;
  if (cleanReqId) manifest += `request-id:${cleanReqId};`;
  manifest += `ts:${ts};`;

  const computedHex = crypto
    .createHmac('sha256', secret)
    .update(manifest)
    .digest('hex')
    .toLowerCase();

  const expectedBuf = Buffer.from(computedHex, 'hex');
  const receivedBuf = Buffer.from(v1, 'hex');

  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    return {
      ok: false,
      errorMessage: 'Assinatura HMAC do webhook Mercado Pago inválida.',
    };
  }

  return { ok: true, ts, v1, manifest };
}

export function createApp(customDeps = {}) {
  const env = customDeps.env || process.env;
  const mpFetch = customDeps.mpFetch || globalThis.fetch;

  const supabaseUrl = String(env.VITE_SUPABASE_URL || env.SUPABASE_URL || '').trim();
  const supabaseAnonKey = String(env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || '').trim();
  const supabaseServiceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const mpAccessToken = String(env.MP_ACCESS_TOKEN || '').trim();
  const mpWebhookSecret = String(env.MP_WEBHOOK_SECRET || '').trim();
  const appUrl = String(env.APP_URL || '').trim().replace(/\/+$/, '');

  const supabaseAdmin =
    customDeps.supabaseAdmin !== undefined
      ? customDeps.supabaseAdmin
      : !isPlaceholderValue(supabaseUrl) && !isPlaceholderValue(supabaseServiceKey)
      ? createClient(supabaseUrl, supabaseServiceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  const supabaseAuthClient =
    customDeps.supabaseAuthClient !== undefined
      ? customDeps.supabaseAuthClient
      : !isPlaceholderValue(supabaseUrl) && !isPlaceholderValue(supabaseAnonKey)
      ? createClient(supabaseUrl, supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : supabaseAdmin;

  // In-flight concurrency guard per paymentId to prevent simultaneous duplicate processing
  const inFlightPaymentIds = new Set();

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', express.json({ limit: '256kb' }));

  async function authenticateBearerUser(req) {
    const authHeader = String(req.headers.authorization || '').trim();
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return { ok: false, statusCode: 401, errorMessage: 'Token de autenticação Bearer ausente.' };
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      return { ok: false, statusCode: 401, errorMessage: 'Token Bearer vazio.' };
    }
    if (!supabaseAuthClient) {
      return {
        ok: false,
        statusCode: 503,
        errorMessage: 'Servidor Supabase não configurado para validar sessão autenticada.',
      };
    }
    const { data, error } = await supabaseAuthClient.auth.getUser(token);
    if (error || !data?.user?.id) {
      return {
        ok: false,
        statusCode: 401,
        errorMessage: 'Sessão inválida ou expirada. Faça login novamente.',
      };
    }
    return { ok: true, user: data.user, token };
  }

  // ===========================================================================
  // 1. POST /api/payments/mercadopago/create
  //    Creates an official PIX payment or Credit Card preference on Mercado Pago
  //    using strictly `orders.total_amount` (which includes the single 6% fee).
  // ===========================================================================
  app.post('/api/payments/mercadopago/create', async (req, res) => {
    try {
      const authCheck = await authenticateBearerUser(req);
      if (!authCheck.ok) {
        res.status(authCheck.statusCode).json({ ok: false, errorMessage: authCheck.errorMessage });
        return;
      }

      if (!supabaseAdmin) {
        res.status(503).json({
          ok: false,
          errorMessage:
            'SUPABASE_SERVICE_ROLE_KEY não configurada no servidor para consultar pedidos com segurança.',
        });
        return;
      }

      if (isPlaceholderValue(mpAccessToken)) {
        res.status(503).json({
          ok: false,
          errorMessage:
            'Credencial MP_ACCESS_TOKEN não configurada no servidor. Configure a variável de ambiente no backend para emitir cobranças reais no Mercado Pago.',
        });
        return;
      }

      const orderId = String(req.body?.orderId || '').trim();
      const requestedMethod = String(req.body?.paymentMethod || '').trim();

      if (!orderId || !UUID_REGEX.test(orderId)) {
        res.status(400).json({ ok: false, errorMessage: 'Identificador do pedido (orderId) inválido.' });
        return;
      }

      if (requestedMethod !== 'pix' && requestedMethod !== 'credit_card') {
        res.status(422).json({
          ok: false,
          errorMessage: `Meio de pagamento "${requestedMethod}" não permitido. O PX CUSTON aceita exclusivamente PIX ("pix") e Cartão de Crédito ("credit_card").`,
        });
        return;
      }

      const { data: order, error: orderError } = await supabaseAdmin
        .from('orders')
        .select('*')
        .eq('id', orderId)
        .maybeSingle();

      if (orderError || !order) {
        res.status(404).json({
          ok: false,
          errorMessage: 'Pedido não encontrado na tabela public.orders do Supabase.',
        });
        return;
      }

      if (order.user_id !== authCheck.user.id) {
        res.status(403).json({
          ok: false,
          errorMessage: 'Acesso negado: este pedido pertence a outro usuário.',
        });
        return;
      }

      if (order.order_status !== 'reserved' && order.order_status !== 'pending_payment') {
        res.status(409).json({
          ok: false,
          errorMessage: `O pedido ${order.order_code} não está aguardando pagamento (status atual: ${order.order_status}).`,
        });
        return;
      }

      if (order.reservation_expires_at && new Date(order.reservation_expires_at).getTime() < Date.now()) {
        res.status(409).json({
          ok: false,
          errorMessage: `A reserva do pedido ${order.order_code} expirou. Inicie uma nova reserva de ingressos.`,
        });
        return;
      }

      if (order.payment_method !== 'pix' && order.payment_method !== 'credit_card') {
        res.status(422).json({
          ok: false,
          errorMessage: `Meio de pagamento registrado no pedido ("${order.payment_method}") não é suportado. Apenas PIX e Cartão de Crédito são permitidos.`,
        });
        return;
      }

      const activeMethod = order.payment_method;
      if (requestedMethod && requestedMethod !== activeMethod) {
        res.status(422).json({
          ok: false,
          errorMessage: `O pedido ${order.order_code} foi reservado para "${activeMethod}" e não pode ser processado como "${requestedMethod}".`,
        });
        return;
      }

      const mathCheck = verifyOrderMath6Percent(order);
      if (!mathCheck.ok) {
        res.status(422).json({ ok: false, errorMessage: mathCheck.errorMessage });
        return;
      }

      let eventTitle = 'Evento PX CUSTON';
      if (order.event_id) {
        const { data: evRow } = await supabaseAdmin
          .from('events')
          .select('title')
          .eq('id', order.event_id)
          .maybeSingle();
        if (evRow?.title) {
          eventTitle = evRow.title;
        }
      }

      const cleanName = String(order.buyer_name || '').trim();
      const nameParts = cleanName.split(/\s+/).filter(Boolean);
      const firstName = nameParts[0] || 'Cliente';
      const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : 'PX CUSTON';
      const cpfDigits = String(order.buyer_cpf || '').replace(/\D/g, '');
      const cleanEmail = String(order.buyer_email || '').trim();

      const notificationUrl =
        appUrl && appUrl.startsWith('https://')
          ? `${appUrl}/api/webhooks/mercadopago`
          : undefined;

      const description = `PX CUSTON - Pedido ${order.order_code} (${mathCheck.quantity}x ingresso - Subtotal R$ ${mathCheck.subtotal.toFixed(
        2
      )} + Taxa 6% R$ ${mathCheck.convenienceFee.toFixed(2)})`;

      if (activeMethod === 'pix') {
        const pixPayload = {
          transaction_amount: mathCheck.totalAmount,
          description,
          payment_method_id: 'pix',
          external_reference: order.id,
          payer: {
            email: cleanEmail,
            first_name: firstName,
            last_name: lastName,
            identification: {
              type: 'CPF',
              number: cpfDigits,
            },
          },
          ...(notificationUrl ? { notification_url: notificationUrl } : {}),
        };

        const mpResponse = await mpFetch('https://api.mercadopago.com/v1/payments', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${mpAccessToken}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': `px-pix-${order.id}`,
          },
          body: JSON.stringify(pixPayload),
        });

        const mpData = await mpResponse.json().catch(() => ({}));
        if (!mpResponse.ok) {
          res.status(502).json({
            ok: false,
            errorMessage:
              mpData?.message ||
              'Não foi possível gerar o QR Code Pix na API oficial do Mercado Pago.',
          });
          return;
        }

        const txData = mpData?.point_of_interaction?.transaction_data || {};
        const pixQrCode = String(txData.qr_code || '').trim();
        const pixQrCodeBase64 = String(txData.qr_code_base64 || '').trim();
        const ticketUrl = String(txData.ticket_url || '').trim();

        if (!pixQrCode) {
          res.status(502).json({
            ok: false,
            errorMessage:
              'A API do Mercado Pago não retornou um código Pix Copia e Cola válido para esta transação.',
          });
          return;
        }

        res.status(200).json({
          ok: true,
          orderId: order.id,
          orderCode: order.order_code,
          paymentMethod: 'pix',
          subtotal: mathCheck.subtotal,
          convenienceFee: mathCheck.convenienceFee,
          totalAmount: mathCheck.totalAmount,
          mpPaymentId: mpData?.id ? String(mpData.id) : undefined,
          pixQrCode,
          pixQrCodeBase64: pixQrCodeBase64 || undefined,
          ticketUrl: ticketUrl || undefined,
          expiresAt: order.reservation_expires_at || undefined,
        });
        return;
      }

      // Credit Card flow: Checkout Preference restricted strictly to credit_card (excludes debit_card)
      const preferencePayload = {
        items: [
          {
            id: order.id,
            title: `${eventTitle} — Pedido ${order.order_code}`,
            description,
            quantity: 1,
            currency_id: 'BRL',
            unit_price: mathCheck.totalAmount,
          },
        ],
        payer: {
          name: firstName,
          surname: lastName,
          email: cleanEmail,
          identification: {
            type: 'CPF',
            number: cpfDigits,
          },
        },
        payment_methods: {
          excluded_payment_types: [
            { id: 'debit_card' },
            { id: 'ticket' },
            { id: 'atm' },
            { id: 'bank_transfer' },
            { id: 'prepaid_card' },
          ],
          installments: 12,
        },
        binary_mode: true,
        external_reference: order.id,
        statement_descriptor: 'PXCUSTON',
        ...(notificationUrl ? { notification_url: notificationUrl } : {}),
        ...(appUrl && appUrl.startsWith('http')
          ? {
              back_urls: {
                success: appUrl,
                pending: appUrl,
                failure: appUrl,
              },
              ...(appUrl.startsWith('https://') ? { auto_return: 'approved' } : {}),
            }
          : {}),
      };

      const prefResponse = await mpFetch('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mpAccessToken}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': `px-pref-${order.id}`,
        },
        body: JSON.stringify(preferencePayload),
      });

      const prefData = await prefResponse.json().catch(() => ({}));
      if (!prefResponse.ok || !prefData?.id || !prefData?.init_point) {
        res.status(502).json({
          ok: false,
          errorMessage:
            prefData?.message ||
            'Não foi possível criar a preferência de pagamento com Cartão de Crédito no Mercado Pago.',
        });
        return;
      }

      // Best-effort storage of mp_preference_id when allowed by DB triggers
      await supabaseAdmin
        .from('orders')
        .update({ mp_preference_id: String(prefData.id) })
        .eq('id', order.id);

      res.status(200).json({
        ok: true,
        orderId: order.id,
        orderCode: order.order_code,
        paymentMethod: 'credit_card',
        subtotal: mathCheck.subtotal,
        convenienceFee: mathCheck.convenienceFee,
        totalAmount: mathCheck.totalAmount,
        preferenceId: String(prefData.id),
        mpPreferenceId: String(prefData.id),
        initPoint: String(prefData.init_point),
        sandboxInitPoint: prefData.sandbox_init_point
          ? String(prefData.sandbox_init_point)
          : undefined,
        expiresAt: order.reservation_expires_at || undefined,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        errorMessage:
          err instanceof Error
            ? err.message
            : 'Erro interno ao processar criação de pagamento no servidor.',
      });
    }
  });

  // ===========================================================================
  // 2. GET /api/payments/mercadopago/status/:orderId
  //    Allows the authenticated buyer to check the authoritative database status
  //    of their order (updated only by the verified webhook).
  // ===========================================================================
  app.get('/api/payments/mercadopago/status/:orderId', async (req, res) => {
    try {
      const authCheck = await authenticateBearerUser(req);
      if (!authCheck.ok) {
        res.status(authCheck.statusCode).json({ ok: false, errorMessage: authCheck.errorMessage });
        return;
      }

      if (!supabaseAdmin) {
        res.status(503).json({
          ok: false,
          errorMessage: 'SUPABASE_SERVICE_ROLE_KEY não configurada no servidor.',
        });
        return;
      }

      const orderId = String(req.params.orderId || '').trim();
      if (!orderId || !UUID_REGEX.test(orderId)) {
        res.status(400).json({ ok: false, errorMessage: 'ID do pedido inválido.' });
        return;
      }

      const { data: order, error } = await supabaseAdmin
        .from('orders')
        .select(
          'id, order_code, user_id, order_status, payment_status, payment_method, subtotal, convenience_fee, total_amount, mp_payment_id, paid_at, reservation_expires_at'
        )
        .eq('id', orderId)
        .maybeSingle();

      if (error || !order) {
        res.status(404).json({ ok: false, errorMessage: 'Pedido não encontrado.' });
        return;
      }

      if (order.user_id !== authCheck.user.id) {
        res.status(403).json({ ok: false, errorMessage: 'Acesso negado a este pedido.' });
        return;
      }

      res.status(200).json({
        ok: true,
        orderId: order.id,
        orderCode: order.order_code,
        orderStatus: order.order_status,
        paymentStatus: order.payment_status,
        paymentMethod: order.payment_method,
        subtotal: Number(order.subtotal),
        convenienceFee: Number(order.convenience_fee),
        totalAmount: Number(order.total_amount),
        mpPaymentId: order.mp_payment_id || null,
        paidAt: order.paid_at || null,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        errorMessage:
          err instanceof Error ? err.message : 'Erro interno ao consultar status do pedido.',
      });
    }
  });

  // ===========================================================================
  // 3. POST /api/webhooks/mercadopago
  //    Validates HMAC-SHA256 signature, queries GET /v1/payments/{id} on the
  //    official Mercado Pago API, verifies status='approved', BRL, exact
  //    orders.total_amount, external_reference, and calls confirm_order_payment.
  // ===========================================================================
  app.post('/api/webhooks/mercadopago', async (req, res) => {
    const queryDataId = req.query?.['data.id'] || req.query?.id;
    const bodyDataId = req.body?.data?.id || req.body?.id;
    const rawPaymentId = String(queryDataId || bodyDataId || '').trim();
    const topic = String(req.query?.type || req.query?.topic || req.body?.type || req.body?.action || 'payment')
      .trim()
      .toLowerCase();

    const sigCheck = verifyWebhookSignatureHmac({
      xSignatureHeader: req.headers['x-signature'],
      xRequestIdHeader: req.headers['x-request-id'],
      dataId: rawPaymentId,
      webhookSecret: mpWebhookSecret,
    });

    if (!sigCheck.ok) {
      res.status(401).json({ ok: false, errorMessage: sigCheck.errorMessage });
      return;
    }

    if (!rawPaymentId || (topic && !topic.includes('payment'))) {
      res.status(200).json({ ok: true, action: 'ignored_non_payment_topic' });
      return;
    }

    if (!supabaseAdmin || isPlaceholderValue(mpAccessToken)) {
      res.status(503).json({
        ok: false,
        errorMessage: 'Credenciais de backend (Supabase service_role ou MP_ACCESS_TOKEN) ausentes.',
      });
      return;
    }

    // Concurrency protection: reject simultaneous duplicate in-flight notifications for the same paymentId
    if (inFlightPaymentIds.has(rawPaymentId)) {
      res.status(202).json({
        ok: true,
        action: 'processing_in_flight',
        mpPaymentId: rawPaymentId,
      });
      return;
    }

    inFlightPaymentIds.add(rawPaymentId);

    try {
      // 1. Query official Mercado Pago API directly — never trust webhook body
      const mpResponse = await mpFetch(
        `https://api.mercadopago.com/v1/payments/${encodeURIComponent(rawPaymentId)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${mpAccessToken}`,
            Accept: 'application/json',
          },
        }
      );

      if (!mpResponse.ok) {
        res.status(502).json({
          ok: false,
          errorMessage: `Falha ao consultar pagamento ${rawPaymentId} na API oficial do Mercado Pago (HTTP ${mpResponse.status}).`,
        });
        return;
      }

      const mpPayment = await mpResponse.json();
      const verifiedPaymentId = String(mpPayment?.id ?? '').trim();
      const verifiedStatus = String(mpPayment?.status ?? '').trim().toLowerCase();
      const verifiedCurrency = String(mpPayment?.currency_id ?? '').trim().toUpperCase();
      const verifiedAmount = Number(mpPayment?.transaction_amount);
      const externalRef = String(mpPayment?.external_reference ?? '').trim();
      const paymentTypeId = String(mpPayment?.payment_type_id ?? '').trim().toLowerCase();
      const paymentMethodId = String(mpPayment?.payment_method_id ?? '').trim().toLowerCase();

      if (!verifiedPaymentId || verifiedPaymentId !== rawPaymentId) {
        res.status(422).json({
          ok: false,
          errorMessage: 'Divergência entre o ID da notificação e o ID retornado pela API do Mercado Pago.',
        });
        return;
      }

      // Strictly allow only PIX and Credit Card (reject debit_card)
      if (
        paymentTypeId === 'debit_card' ||
        paymentMethodId.startsWith('deb') ||
        (paymentTypeId !== '' &&
          paymentTypeId !== 'bank_transfer' &&
          paymentTypeId !== 'credit_card' &&
          paymentMethodId !== 'pix')
      ) {
        res.status(422).json({
          ok: false,
          errorMessage: `Meio de pagamento "${
            paymentTypeId || paymentMethodId
          }" bloqueado. Apenas PIX e Cartão de Crédito são permitidos.`,
        });
        return;
      }

      if (!externalRef) {
        res.status(422).json({
          ok: false,
          errorMessage: 'Pagamento no Mercado Pago não possui external_reference associada a um pedido.',
        });
        return;
      }

      // 2. Locate the authoritative order in public.orders
      const lookupColumn = UUID_REGEX.test(externalRef) ? 'id' : 'order_code';
      const { data: order, error: orderError } = await supabaseAdmin
        .from('orders')
        .select('*')
        .eq(lookupColumn, externalRef)
        .maybeSingle();

      if (orderError || !order) {
        res.status(404).json({
          ok: false,
          errorMessage: `Pedido associado à external_reference "${externalRef}" não encontrado em public.orders.`,
        });
        return;
      }

      // 3. Check if this mp_payment_id is already bound to a DIFFERENT order
      const { data: conflictingOrder } = await supabaseAdmin
        .from('orders')
        .select('id')
        .eq('mp_payment_id', verifiedPaymentId)
        .neq('id', order.id)
        .maybeSingle();

      if (conflictingOrder?.id) {
        res.status(409).json({
          ok: false,
          errorMessage: `Conflito de unicidade: o pagamento "${verifiedPaymentId}" já pertence a outro pedido.`,
        });
        return;
      }

      // 4. Verify currency, 6% order math consistency, and exact total_amount match
      if (verifiedCurrency !== 'BRL') {
        res.status(422).json({
          ok: false,
          errorMessage: `Moeda inválida ("${verifiedCurrency}"). Esperado "BRL".`,
        });
        return;
      }

      const mathCheck = verifyOrderMath6Percent(order);
      if (!mathCheck.ok) {
        res.status(422).json({ ok: false, errorMessage: mathCheck.errorMessage });
        return;
      }

      if (
        !Number.isFinite(verifiedAmount) ||
        verifiedAmount <= 0 ||
        Math.round(verifiedAmount * 100) !== Math.round(mathCheck.totalAmount * 100)
      ) {
        res.status(422).json({
          ok: false,
          errorMessage: `Valor pago no Mercado Pago (${verifiedAmount.toFixed(
            2
          )}) diverge do orders.total_amount oficial (${mathCheck.totalAmount.toFixed(2)}).`,
        });
        return;
      }

      // 5. Only 'approved' payments can issue tickets
      if (verifiedStatus !== 'approved') {
        res.status(200).json({
          ok: true,
          action: 'ignored_unapproved',
          orderId: order.id,
          paymentStatus: verifiedStatus,
          ticketsIssued: 0,
        });
        return;
      }

      // 6. Strict idempotency check when order is already 'paid':
      //    Compares incoming verifiedPaymentId against stored order.mp_payment_id
      //    (protects even if the database is still running Migration 001's 2-argument function)
      if (order.order_status === 'paid') {
        const storedPaymentId = String(order.mp_payment_id || '').trim();
        if (!storedPaymentId || storedPaymentId !== verifiedPaymentId) {
          res.status(409).json({
            ok: false,
            errorMessage: `Conflito de idempotência: o pedido ${order.order_code} já está pago com outro mp_payment_id ("${
              storedPaymentId || 'NULL'
            }" vs "${verifiedPaymentId}").`,
          });
          return;
        }

        res.status(200).json({
          ok: true,
          action: 'idempotent_replay',
          idempotentReplay: true,
          orderId: order.id,
          orderCode: order.order_code,
          mpPaymentId: verifiedPaymentId,
          ticketsIssued: 0,
        });
        return;
      }

      // 7. Handle late payment on an already expired or cancelled order
      if (order.order_status === 'expired' || order.order_status === 'cancelled') {
        await supabaseAdmin.rpc('record_late_payment_incident', {
          p_order_id: order.id,
          p_mp_payment_id: verifiedPaymentId,
          p_mp_payment_status: 'approved',
          p_verified_amount: mathCheck.totalAmount,
          p_currency: 'BRL',
          p_external_reference: externalRef,
          p_reason: 'Pagamento aprovado recebido via webhook após expiração/cancelamento da reserva.',
        });

        res.status(409).json({
          ok: false,
          action: 'late_payment_recorded',
          errorMessage: `Pagamento aprovado recebido para pedido já encerrado (${order.order_code} / status=${order.order_status}). Nenhum ingresso foi emitido.`,
        });
        return;
      }

      // 8. Invoke confirm_order_payment via service_role (supports Migration 002 6-arg signature,
      //    with safe fallback to Migration 001 2-arg signature only on PGRST202 after full backend validation)
      let rpcResult = await supabaseAdmin.rpc('confirm_order_payment', {
        p_order_id: order.id,
        p_mp_payment_id: verifiedPaymentId,
        p_mp_payment_status: 'approved',
        p_verified_amount: mathCheck.totalAmount,
        p_currency: 'BRL',
        p_external_reference: externalRef,
      });

      if (
        rpcResult.error &&
        (rpcResult.error.code === 'PGRST202' ||
          String(rpcResult.error.message || '').includes('confirm_order_payment'))
      ) {
        rpcResult = await supabaseAdmin.rpc('confirm_order_payment', {
          p_order_id: order.id,
          p_mp_payment_id: verifiedPaymentId,
        });
      }

      if (rpcResult.error) {
        res.status(500).json({
          ok: false,
          errorMessage: `Erro ao confirmar pagamento no banco: ${rpcResult.error.message}`,
        });
        return;
      }

      const rpcData = rpcResult.data;
      const isReplay =
        typeof rpcData === 'object' && rpcData !== null
          ? Boolean(rpcData.idempotent_replay)
          : false;
      const ticketsIssued =
        typeof rpcData === 'number'
          ? rpcData
          : typeof rpcData === 'object' && rpcData !== null
          ? Number(rpcData.tickets_issued ?? order.quantity)
          : order.quantity;

      res.status(200).json({
        ok: true,
        action: isReplay ? 'idempotent_replay' : 'confirmed',
        idempotentReplay: isReplay,
        orderId: order.id,
        orderCode: order.order_code,
        mpPaymentId: verifiedPaymentId,
        ticketsIssued,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        errorMessage:
          err instanceof Error
            ? err.message
            : 'Erro interno durante processamento do webhook Mercado Pago.',
      });
    } finally {
      inFlightPaymentIds.delete(rawPaymentId);
    }
  });

  app.use(
    express.static(distDir, {
      index: false,
      fallthrough: true,
      setHeaders(res, filePath) {
        const relativePath = '/' + path.relative(distDir, filePath).split(path.sep).join('/');
        if (relativePath.startsWith('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (NO_CACHE_FILES.has(relativePath) || relativePath.startsWith('/workbox-')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    })
  );

  app.use((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(404).type('text/plain; charset=utf-8').send('Not Found');
      return;
    }

    const requestPath = req.path || '/';
    const segments = requestPath.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1] || '';
    const hasDotfileSegment = segments.some((segment) => segment.startsWith('.'));
    const hasFileExtension = path.posix.extname(lastSegment) !== '';

    if (
      requestPath.startsWith('/assets/') ||
      requestPath.startsWith('/api/') ||
      hasDotfileSegment ||
      hasFileExtension
    ) {
      res.status(404).type('text/plain; charset=utf-8').send('Not Found');
      return;
    }

    const acceptHeader = String(req.headers.accept || '');
    const acceptsHtml =
      acceptHeader === '' ||
      acceptHeader.includes('text/html') ||
      acceptHeader.includes('application/xhtml+xml') ||
      acceptHeader.includes('*/*');

    if (!acceptsHtml) {
      res.status(404).type('text/plain; charset=utf-8').send('Not Found');
      return;
    }

    if (!fs.existsSync(indexHtmlPath)) {
      res
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('Build output not found. Run "npm run build" before starting the server.');
      return;
    }

    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).sendFile(indexHtmlPath);
  });

  return app;
}

export function shouldAutoStartServer(runtime = process) {
  const env = runtime?.env || {};
  if (
    env.NODE_ENV === 'test' ||
    Boolean(env.NODE_TEST_CONTEXT) ||
    env.PX_SKIP_AUTO_LISTEN === '1' ||
    env.PX_SKIP_AUTO_LISTEN === 'true'
  ) {
    return false;
  }

  const execArgv = Array.isArray(runtime?.execArgv) ? runtime.execArgv : [];
  const argv = Array.isArray(runtime?.argv) ? runtime.argv : [];
  const allArgs = [...execArgv, ...argv];

  if (
    allArgs.includes('--test') ||
    allArgs.some((arg) => /\.test\.[cm]?[jt]sx?$/i.test(String(arg)))
  ) {
    return false;
  }

  return true;
}

if (shouldAutoStartServer(process)) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const app = createApp();

  const server = app.listen(port, host, () => {
    console.log(`PX CUSTON server listening on http://${host}:${port}`);
  });

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
