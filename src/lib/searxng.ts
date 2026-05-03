import { getSearxngURL } from './config/serverRegistry';

export interface SearxngSearchOptions {
  categories?: string[];
  engines?: string[];
  language?: string;
  pageno?: number;
}

interface SearxngSearchResult {
  title: string;
  url: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  content?: string;
  author?: string;
  iframe_src?: string;
}

// ─── Engine Language Map ────────────────────────────────────────────────────
// Maps SearxNG engine names to their preferred query language.
// Engines not listed here accept English queries natively.

export const ENGINE_LANGUAGE_MAP: Record<string, string> = {
  'baidu': 'zh-CN',
  'baidu kaifa': 'zh-CN',
  'naver': 'ko',
  'yandex': 'ru',
};

/**
 * Groups a list of engine names by language.
 * Returns { [languageCode]: string[] } — e.g. { 'en': ['bing','google'], 'zh-CN': ['baidu'] }
 */
export function groupEnginesByLanguage(engines: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const engine of engines) {
    const lang = ENGINE_LANGUAGE_MAP[engine.toLowerCase()] ?? 'en';
    if (!groups[lang]) groups[lang] = [];
    groups[lang].push(engine);
  }
  return groups;
}

// ─── Engine Health Tracker ──────────────────────────────────────────────────
// Tracks per-engine CAPTCHA/rate-limit failures.
// Engines in cooldown are excluded from future requests automatically.
// State is in-memory: resets on server restart (acceptable tradeoff).

interface EngineHealth {
  failCount: number;
  cooldownUntil: number;
}

const engineHealth = new Map<string, EngineHealth>();

// Error types from SearxNG's unresponsive_engines field that indicate CAPTCHA/rate-limiting
const CAPTCHA_ERROR_PATTERNS = [
  'CAPTCHA',
  'Too many requests',
  'HTTP error 429',
  'HTTP error 403',
  'Suspended',
  'rate limit',
];

const BASE_COOLDOWN_MS = 60_000;      // 1 minute base
const MAX_COOLDOWN_MS = 30 * 60_000; // 30 minutes max

function isCaptchaError(errorType: string): boolean {
  const lower = errorType.toLowerCase();
  return CAPTCHA_ERROR_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

function markEngineFailed(engine: string, errorType: string): void {
  const health = engineHealth.get(engine) ?? { failCount: 0, cooldownUntil: 0 };
  health.failCount++;
  // Exponential backoff: 1min, 2min, 4min, 8min … capped at 30min
  const cooldown = Math.min(
    BASE_COOLDOWN_MS * Math.pow(2, health.failCount - 1),
    MAX_COOLDOWN_MS,
  );
  health.cooldownUntil = Date.now() + cooldown;
  engineHealth.set(engine, health);
  console.warn(
    `[cercaTutto] Engine "${engine}" cooldown ${cooldown / 1000}s` +
    ` (${errorType}, fail #${health.failCount})`,
  );
}

function resetEngineIfExpired(engine: string): void {
  const health = engineHealth.get(engine);
  if (health && Date.now() > health.cooldownUntil) {
    engineHealth.delete(engine);
  }
}

/** Returns only engines not currently in CAPTCHA cooldown. */
export function filterHealthyEngines(engines: string[]): string[] {
  return engines.filter((engine) => {
    resetEngineIfExpired(engine);
    const health = engineHealth.get(engine);
    if (!health) return true;
    const remaining = Math.ceil((health.cooldownUntil - Date.now()) / 1000);
    if (remaining > 0) {
      console.debug(`[cercaTutto] Skipping "${engine}" (cooldown ${remaining}s)`);
      return false;
    }
    return true;
  });
}

/** Returns a snapshot of current engine cooldown status (for debugging/UI). */
export function getEngineHealthStatus(): Record<string, { failCount: number; cooldownRemainingS: number }> {
  const now = Date.now();
  const status: Record<string, { failCount: number; cooldownRemainingS: number }> = {};
  engineHealth.forEach((health, engine) => {
    const remaining = Math.max(0, Math.ceil((health.cooldownUntil - now) / 1000));
    if (remaining > 0) {
      status[engine] = { failCount: health.failCount, cooldownRemainingS: remaining };
    }
  });
  return status;
}

// ─── Search ─────────────────────────────────────────────────────────────────

/**
 * cercaTutto SearXNG wrapper with:
 * - Aggressive 3s timeout (prevents blocking)
 * - Up to 3 retry attempts with exponential backoff
 * - Automatic CAPTCHA detection via unresponsive_engines
 * - Per-engine cooldown with exponential backoff (1m → 30m max)
 * - Returns empty results instead of throwing on failure
 */
export const searchSearxng = async (
  query: string,
  opts?: SearxngSearchOptions,
): Promise<{ results: SearxngSearchResult[]; suggestions: string[] }> => {
  const searxngURL = getSearxngURL();
  const MAX_RETRIES = 2;
  const TIMEOUT_MS = 3000;
  const BACKOFF_MS = 500;

  // Filter out engines currently in CAPTCHA cooldown
  const requestedEngines = opts?.engines ?? [];
  const healthyEngines =
    requestedEngines.length > 0 ? filterHealthyEngines(requestedEngines) : [];

  // If all requested engines are in cooldown, fall back to SearxNG defaults
  if (requestedEngines.length > 0 && healthyEngines.length === 0) {
    console.warn(
      `[cercaTutto] All requested engines in cooldown for "${query}", using SearxNG defaults`,
    );
  }

  const effectiveOpts: SearxngSearchOptions = {
    ...opts,
    engines: healthyEngines.length > 0 ? healthyEngines : undefined,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const url = new URL(`${searxngURL}/search?format=json`);
      url.searchParams.append('q', query);

      if (effectiveOpts) {
        Object.keys(effectiveOpts).forEach((key) => {
          const value = effectiveOpts[key as keyof SearxngSearchOptions];
          if (value === undefined || value === null) return;
          if (Array.isArray(value)) {
            if (value.length > 0) url.searchParams.append(key, value.join(','));
            return;
          }
          url.searchParams.append(key, value as string);
        });
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const res = await fetch(url, { signal: controller.signal });

        if (!res.ok) {
          throw new Error(`SearXNG error: ${res.statusText}`);
        }

        const data = await res.json();

        // ── CAPTCHA detection ──────────────────────────────────────────────
        // SearxNG returns unresponsive_engines: Array<[engine, errorType, errorInfo]>
        const unresponsive: [string, string, string?][] =
          data.unresponsive_engines ?? [];

        unresponsive.forEach(([engine, errorType]) => {
          if (isCaptchaError(errorType)) {
            markEngineFailed(engine, errorType);
          }
        });

        if (unresponsive.length > 0) {
          console.debug(
            `[cercaTutto] Unresponsive engines for "${query}":`,
            unresponsive.map(([e, t]) => `${e}(${t})`).join(', '),
          );
        }
        // ──────────────────────────────────────────────────────────────────

        const results: SearxngSearchResult[] = data.results ?? [];
        const suggestions: string[] = data.suggestions ?? [];

        return { results, suggestions };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: any) {
      lastError = err;

      const isTimeout = err.name === 'AbortError' || err.message?.includes('timed out');
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[cercaTutto] SearXNG retry ${attempt + 1}/${MAX_RETRIES}` +
          ` for "${query}" — ${isTimeout ? 'timeout' : err.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * (attempt + 1)));
      }
    }
  }

  console.warn(
    `[cercaTutto] SearXNG failed after ${MAX_RETRIES + 1} attempts for "${query}":`,
    lastError?.message ?? 'Unknown error',
  );

  return { results: [], suggestions: [] };
};
