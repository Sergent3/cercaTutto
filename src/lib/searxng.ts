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

/**
 * cercaTutto SearXNG wrapper with aggressive timeouts and retry logic
 * - Timeout: 3 seconds (aggressive, prevents blocking)
 * - Retry: Up to 3 attempts with exponential backoff
 * - Error handling: Returns empty results instead of throwing on timeout
 */
export const searchSearxng = async (
  query: string,
  opts?: SearxngSearchOptions,
): Promise<{ results: SearxngSearchResult[]; suggestions: string[] }> => {
  const searxngURL = getSearxngURL();
  const MAX_RETRIES = 2;
  const TIMEOUT_MS = 3000; // Aggressive 3s timeout instead of 10s
  const BACKOFF_MS = 500;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const url = new URL(`${searxngURL}/search?format=json`);
      url.searchParams.append('q', query);

      if (opts) {
        Object.keys(opts).forEach((key) => {
          const value = opts[key as keyof SearxngSearchOptions];
          if (Array.isArray(value)) {
            url.searchParams.append(key, value.join(','));
            return;
          }
          url.searchParams.append(key, value as string);
        });
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`SearXNG error: ${res.statusText}`);
        }

        const data = await res.json();

        const results: SearxngSearchResult[] = data.results || [];
        const suggestions: string[] = data.suggestions || [];

        return { results, suggestions };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: any) {
      lastError = err;

      // Log retry attempt
      const isTimeout = err.name === 'AbortError' || err.message?.includes('timed out');
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[cercaTutto] SearXNG retry ${attempt + 1}/${MAX_RETRIES} for "${query}" - ${isTimeout ? 'timeout' : err.message}`
        );

        // Exponential backoff before retry
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * (attempt + 1)));
      }
    }
  }

  // After all retries exhausted, return empty results instead of throwing
  console.warn(
    `[cercaTutto] SearXNG failed after ${MAX_RETRIES + 1} attempts for "${query}":`,
    lastError?.message || 'Unknown error'
  );

  return { results: [], suggestions: [] };
};
