import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseConfigValidation {
  isConfigured: boolean;
  hasValidUrlFormat: boolean;
  hasAnonKey: boolean;
  isSafePublicKey: boolean;
  reason: string;
}

export interface SupabaseConnectionStatus {
  configured: boolean;
  reachable: boolean;
  authStatus: 'ok' | 'unconfigured' | 'error';
  databaseStatus: 'ready' | 'schema_pending' | 'unconfigured' | 'error';
  latencyMs: number | null;
  checkedAt: string;
  summary: string;
}

const PLACEHOLDER_URLS = new Set([
  '',
  'https://your-project-id.supabase.co',
  'MY_SUPABASE_URL',
  'YOUR_SUPABASE_URL',
]);

const PLACEHOLDER_KEYS = new Set([
  '',
  'your-supabase-anon-key',
  'MY_SUPABASE_ANON_KEY',
  'YOUR_SUPABASE_ANON_KEY',
]);

/**
 * Pure validation helper for Supabase environment variables.
 * Never exposes or returns the raw URL or key values.
 */
export function validateSupabaseConfig(
  rawUrl?: string,
  rawAnonKey?: string
): SupabaseConfigValidation {
  const url = (rawUrl ?? '').trim();
  const key = (rawAnonKey ?? '').trim();

  if (!url || PLACEHOLDER_URLS.has(url)) {
    return {
      isConfigured: false,
      hasValidUrlFormat: false,
      hasAnonKey: Boolean(key && !PLACEHOLDER_KEYS.has(key)),
      isSafePublicKey: true,
      reason: 'Variável VITE_SUPABASE_URL ausente ou com valor de exemplo.',
    };
  }

  let hasValidUrlFormat = false;
  try {
    const parsed = new URL(url);
    hasValidUrlFormat = parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    hasValidUrlFormat = false;
  }

  if (!hasValidUrlFormat) {
    return {
      isConfigured: false,
      hasValidUrlFormat: false,
      hasAnonKey: Boolean(key && !PLACEHOLDER_KEYS.has(key)),
      isSafePublicKey: true,
      reason: 'Formato de VITE_SUPABASE_URL inválido.',
    };
  }

  if (!key || PLACEHOLDER_KEYS.has(key)) {
    return {
      isConfigured: false,
      hasValidUrlFormat: true,
      hasAnonKey: false,
      isSafePublicKey: true,
      reason: 'Variável VITE_SUPABASE_ANON_KEY ausente ou com valor de exemplo.',
    };
  }

  // Security guard: ensure a secret/service_role key was not accidentally placed in the frontend env var
  const lowerKey = key.toLowerCase();
  if (lowerKey.startsWith('sb_secret_') || lowerKey.includes('service_role')) {
    return {
      isConfigured: false,
      hasValidUrlFormat: true,
      hasAnonKey: true,
      isSafePublicKey: false,
      reason:
        'Bloqueado por segurança: a chave detectada parece ser privada (service_role/secret). Use apenas a chave pública (anon/publishable) no frontend.',
    };
  }

  return {
    isConfigured: true,
    hasValidUrlFormat: true,
    hasAnonKey: true,
    isSafePublicKey: true,
    reason: 'Variáveis públicas VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY configuradas.',
  };
}

function getEnvVar(name: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY'): string {
  try {
    const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    if (metaEnv && typeof metaEnv[name] === 'string') {
      return metaEnv[name] || '';
    }
  } catch {
    // Fallback for Node test runner environment
  }
  if (typeof process !== 'undefined' && process.env && typeof process.env[name] === 'string') {
    return process.env[name] || '';
  }
  return '';
}

const supabaseUrl = getEnvVar('VITE_SUPABASE_URL');
const supabaseAnonKey = getEnvVar('VITE_SUPABASE_ANON_KEY');

export const supabaseConfigState: SupabaseConfigValidation = validateSupabaseConfig(
  supabaseUrl,
  supabaseAnonKey
);

/**
 * Official Supabase Client singleton for PX CUSTON.
 * Initialized strictly with public credentials when valid.
 */
export const supabase: SupabaseClient | null = supabaseConfigState.isConfigured
  ? createClient(supabaseUrl.trim(), supabaseAnonKey.trim(), {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

/**
 * Performs a real, credential-safe connectivity check against Supabase Auth and PostgREST.
 * Never logs or returns URLs, tokens, or secret values.
 */
export async function verifySupabaseConnection(): Promise<SupabaseConnectionStatus> {
  const checkedAt = new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  if (!supabaseConfigState.isConfigured || !supabase) {
    return {
      configured: false,
      reachable: false,
      authStatus: 'unconfigured',
      databaseStatus: 'unconfigured',
      latencyMs: null,
      checkedAt,
      summary: supabaseConfigState.reason,
    };
  }

  const startTime = performance.now();

  try {
    // 1. Verify Supabase Auth client initialization & session handler
    const { error: authError } = await supabase.auth.getSession();
    if (authError) {
      const latencyMs = Math.round(performance.now() - startTime);
      return {
        configured: true,
        reachable: false,
        authStatus: 'error',
        databaseStatus: 'error',
        latencyMs,
        checkedAt,
        summary: 'Falha ao validar sessão no Supabase Auth. Verifique as credenciais públicas.',
      };
    }

    // 2. Validate project reachability and public key acceptance via Supabase API Gateway (returns 200 OK without triggering 404 console errors)
    const cleanUrl = supabaseUrl.trim().replace(/\/+$/, '');
    const gatewayResponse = await fetch(`${cleanUrl}/auth/v1/settings`, {
      method: 'GET',
      headers: {
        apikey: supabaseAnonKey.trim(),
      },
    });

    const latencyMs = Math.round(performance.now() - startTime);

    if (gatewayResponse.status === 401 || gatewayResponse.status === 403) {
      return {
        configured: true,
        reachable: false,
        authStatus: 'error',
        databaseStatus: 'error',
        latencyMs,
        checkedAt,
        summary:
          'Servidor Supabase alcançado, porém a chave pública (VITE_SUPABASE_ANON_KEY) foi recusada.',
      };
    }

    if (!gatewayResponse.ok) {
      return {
        configured: true,
        reachable: false,
        authStatus: 'error',
        databaseStatus: 'error',
        latencyMs,
        checkedAt,
        summary: 'O endpoint do projeto respondeu com status inesperado.',
      };
    }

    // 3. Verify PostgREST access to public.events (RLS published events query)
    const { count, error: dbError } = await supabase
      .from('events')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'published');

    const totalLatencyMs = Math.round(performance.now() - startTime);

    if (dbError) {
      const isSchemaPending =
        dbError.code === '42P01' ||
        dbError.code === 'PGRST205' ||
        dbError.message.toLowerCase().includes('relation') ||
        dbError.message.toLowerCase().includes('does not exist');

      return {
        configured: true,
        reachable: true,
        authStatus: 'ok',
        databaseStatus: isSchemaPending ? 'schema_pending' : 'error',
        latencyMs: totalLatencyMs,
        checkedAt,
        summary: isSchemaPending
          ? 'Conexão autenticada, porém a tabela public.events ainda não foi localizada no banco.'
          : `Conexão autenticada, mas houve erro ao consultar public.events: ${dbError.message}`,
      };
    }

    return {
      configured: true,
      reachable: true,
      authStatus: 'ok',
      databaseStatus: 'ready',
      latencyMs: totalLatencyMs,
      checkedAt,
      summary: `Conexão com o Supabase operacional! Tabela public.events acessível (${count ?? 0} evento(s) publicado(s) no catálogo).`,
    };
  } catch {
    const latencyMs = Math.round(performance.now() - startTime);
    return {
      configured: true,
      reachable: false,
      authStatus: 'error',
      databaseStatus: 'error',
      latencyMs,
      checkedAt,
      summary:
        'Não foi possível alcançar o endpoint do Supabase. Verifique se a URL do projeto está correta.',
    };
  }
}
