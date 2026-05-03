import { getEngineHealthStatus, filterHealthyEngines } from '@/lib/searxng';
import configManager from '@/lib/config';

/**
 * GET /api/engines
 * Returns current engine list with health status (cooldowns, fail counts).
 * Useful for debugging CAPTCHA issues.
 */
export const GET = async () => {
  const raw: string = configManager.getConfig('search.enabledEngines', '') as string;
  const configuredEngines =
    raw && raw.trim()
      ? raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
      : ConfigManager_ALL_ENGINES();

  const healthyEngines = filterHealthyEngines(configuredEngines);
  const cooldownStatus = getEngineHealthStatus();

  const engines = configuredEngines.map((engine) => ({
    name: engine,
    status: cooldownStatus[engine] ? 'cooldown' : 'healthy',
    ...(cooldownStatus[engine] ?? {}),
  }));

  return Response.json({
    total: configuredEngines.length,
    healthy: healthyEngines.length,
    in_cooldown: Object.keys(cooldownStatus).length,
    engines,
  });
};

// Inline helper to avoid circular import with config's static field
function ConfigManager_ALL_ENGINES(): string[] {
  return [
    'duckduckgo', 'brave', 'startpage', 'qwant', 'mojeek',
    'metager', 'presearch', 'swisscows', 'gibiru', 'ecosia',
    'bing', 'google', 'yahoo', 'yandex', 'baidu', 'naver',
    'bing news', 'google news', 'brave news', 'yahoo news', 'wikinews',
    'github', 'gitlab', 'stackoverflow', 'hackernews', 'npm', 'pypi', 'crates.io',
    'reddit', 'lemmy',
    'google scholar', 'semantic scholar', 'arxiv', 'pubmed',
    'youtube', 'vimeo', 'dailymotion',
    'wikipedia', 'wikidata',
    'amazon', 'ebay', 'archive.org',
  ];
}
