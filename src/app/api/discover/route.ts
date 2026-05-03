import { searchSearxng } from '@/lib/searxng';

const websitesForTopic = {
  tech: {
    query: ['technology news', 'latest tech', 'AI', 'science and innovation'],
    links: ['techcrunch.com', 'wired.com', 'theverge.com'],
  },
  finance: {
    query: ['finance news', 'economy', 'stock market', 'investing'],
    links: ['bloomberg.com', 'cnbc.com', 'marketwatch.com'],
  },
  art: {
    query: ['art news', 'culture', 'modern art', 'cultural events'],
    links: ['artnews.com', 'hyperallergic.com', 'theartnewspaper.com'],
  },
  sports: {
    query: ['sports news', 'latest sports', 'cricket football tennis'],
    links: ['espn.com', 'bbc.com/sport', 'skysports.com'],
  },
  entertainment: {
    query: ['entertainment news', 'movies', 'TV shows', 'celebrities'],
    links: ['hollywoodreporter.com', 'variety.com', 'deadline.com'],
  },
};

type Topic = keyof typeof websitesForTopic;

// Query su TUTTI i motori disponibili (including forums, reddit, ecc)
// Se uno fallisce (CAPTCHA, timeout), gli altri continuano
const ALL_SEARCH_ENGINES = [
  'bing', 'bing news', 'duckduckgo', 'google', 'github', 'reddit',
  'stackoverflow', 'hackernews', 'yandex', 'searx', 'qwant', 'mojeek',
  'baidu', 'baidu kaifa', 'naver'
];

/**
 * cercaTutto discover endpoint - Robust search across ALL engines
 * Uses Promise.allSettled to continue even if some engines fail (CAPTCHA, timeout)
 */
export const GET = async (req: Request) => {
  try {
    const params = new URL(req.url).searchParams;

    const mode: 'normal' | 'preview' =
      (params.get('mode') as 'normal' | 'preview') || 'normal';
    const topic: Topic = (params.get('topic') as Topic) || 'tech';

    const selectedTopic = websitesForTopic[topic];

    // Set a global timeout to prevent hanging requests
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Discover timeout')), 8000)
    );

    let data = [];

    if (mode === 'normal') {
      const seenUrls = new Set<string>();

      // Promise.allSettled ignores failures - continues even if engines fail
      const searchPromises = selectedTopic.links.flatMap((link) =>
        selectedTopic.query.map(async (query) => {
          try {
            const results = await Promise.race([
              searchSearxng(`site:${link} ${query}`, {
                pageno: 1,
                language: 'en',
                // Empty engines array = use ALL available (including forums, Reddit, Yandex, etc)
              }),
              timeoutPromise,
            ]);
            return results.results || [];
          } catch (err) {
            // Engine failed (CAPTCHA, timeout, etc) - log and continue
            console.warn(
              `[cercaTutto] Search failed for "${query}" on ${link}:`,
              err instanceof Error ? err.message : String(err)
            );
            return [];
          }
        })
      );

      // Use allSettled - if one search fails, others continue
      const results = await Promise.allSettled(searchPromises);

      // Extract successful results
      const allResults = results
        .filter((r) => r.status === 'fulfilled')
        .flatMap((r) => (r as PromiseFulfilledResult<any>).value);

      // Deduplicate by URL
      data = allResults
        .filter((item) => {
          const url = item.url?.toLowerCase().trim();
          if (!url || seenUrls.has(url)) return false;
          seenUrls.add(url);
          return true;
        })
        .sort(() => Math.random() - 0.5)
        .slice(0, 50); // Limit to 50 results for performance
    } else {
      // Preview mode - single random query, all engines, with fallback
      try {
        const randomLink =
          selectedTopic.links[Math.floor(Math.random() * selectedTopic.links.length)];
        const randomQuery =
          selectedTopic.query[Math.floor(Math.random() * selectedTopic.query.length)];

        const results = await Promise.race([
          searchSearxng(`site:${randomLink} ${randomQuery}`, {
            pageno: 1,
            language: 'en',
          }),
          timeoutPromise,
        ]);

        data = results.results || [];
      } catch (err) {
        console.warn(
          '[cercaTutto] Preview mode search failed:',
          err instanceof Error ? err.message : String(err)
        );
        data = [];
      }
    }

    return Response.json(
      {
        blogs: data,
        count: data.length,
        generated_at: new Date().toISOString(),
      },
      {
        status: 200,
      }
    );
  } catch (err) {
    console.error(
      `[cercaTutto] Discover error:`,
      err instanceof Error ? err.message : String(err)
    );
    // Return empty results instead of error - don't block the UI
    return Response.json(
      {
        blogs: [],
        count: 0,
        error: 'Partial results or timeout',
        generated_at: new Date().toISOString(),
      },
      {
        status: 200, // Return 200 even on partial failure
      }
    );
  }
};
