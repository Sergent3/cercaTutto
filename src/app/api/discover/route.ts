import { searchSearxng, groupEnginesByLanguage, ENGINE_LANGUAGE_MAP } from '@/lib/searxng';
import configManager from '@/lib/config';

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

/**
 * Reads enabled engines from config.
 * Returns an array of engine names, or [] (all engines) if config is empty/default.
 */
const getEnabledEngines = (): string[] => {
  const raw: string = configManager.getConfig('search.enabledEngines', '') as string;
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
};

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
      const engines = getEnabledEngines();

      // Group engines by language to send translated queries where needed
      const engineGroups = engines.length > 0 ? groupEnginesByLanguage(engines) : { en: [] };

      // Pre-translated queries for non-English engines (static map for discover topics)
      const DISCOVER_QUERY_TRANSLATIONS: Record<string, Record<string, string>> = {
        'zh-CN': {
          'technology news': '科技新闻',
          'latest tech': '最新科技',
          'AI': '人工智能',
          'science and innovation': '科学与创新',
          'finance news': '财经新闻',
          'economy': '经济',
          'stock market': '股市',
          'investing': '投资',
          'art news': '艺术新闻',
          'culture': '文化',
          'modern art': '现代艺术',
          'cultural events': '文化活动',
          'sports news': '体育新闻',
          'latest sports': '最新体育',
          'cricket football tennis': '板球 足球 网球',
          'entertainment news': '娱乐新闻',
          'movies': '电影',
          'TV shows': '电视节目',
          'celebrities': '明星',
        },
        'ko': {
          'technology news': '기술 뉴스',
          'latest tech': '최신 기술',
          'AI': '인공지능',
          'science and innovation': '과학과 혁신',
          'finance news': '금융 뉴스',
          'economy': '경제',
          'stock market': '주식시장',
          'investing': '투자',
          'sports news': '스포츠 뉴스',
          'entertainment news': '연예 뉴스',
          'movies': '영화',
        },
      };

      const getTranslatedQuery = (query: string, lang: string): string =>
        DISCOVER_QUERY_TRANSLATIONS[lang]?.[query] ?? query;

      // Promise.allSettled ignores failures - continues even if engines fail
      const searchPromises: Promise<any[]>[] = [];

      for (const link of selectedTopic.links) {
        for (const query of selectedTopic.query) {
          for (const [lang, langEngines] of Object.entries(engineGroups)) {
            const translatedQuery = lang !== 'en' ? getTranslatedQuery(query, lang) : query;
            searchPromises.push(
              (async () => {
                try {
                  const results = await Promise.race([
                    searchSearxng(`site:${link} ${translatedQuery}`, {
                      pageno: 1,
                      language: lang !== 'en' ? lang : 'en',
                      ...(langEngines.length > 0 ? { engines: langEngines } : engines.length > 0 ? { engines } : {}),
                    }),
                    timeoutPromise,
                  ]);
                  return results.results || [];
                } catch (err) {
                  console.warn(
                    `[cercaTutto] Search failed for "${translatedQuery}" on ${link}:`,
                    err instanceof Error ? err.message : String(err),
                  );
                  return [];
                }
              })(),
            );
          }
        }
      }

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
        const engines = getEnabledEngines();

        const results = await Promise.race([
          searchSearxng(`site:${randomLink} ${randomQuery}`, {
            pageno: 1,
            language: 'en',
            ...(engines.length > 0 ? { engines } : {}),
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
