import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const webSearchInputSchema = z.object({
  query: z.string().min(2).describe('The search query to run'),
  searchType: z
    .enum(['web', 'news'])
    .optional()
    .default('web')
    .describe('Use news for recent reporting and web for broader research'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(5)
    .describe('Maximum number of search results to return'),
});

const searchResultSchema = z.object({
  kind: z.enum(['web', 'news']),
  title: z.string(),
  url: z.string().url(),
  snippet: z.string(),
  source: z.string().optional(),
  publishedAt: z.string().optional(),
});

const webSearchOutputSchema = z.object({
  query: z.string(),
  searchType: z.enum(['web', 'news']),
  fetchedAt: z.string(),
  results: z.array(searchResultSchema),
});

type SearchResult = z.infer<typeof searchResultSchema>;

const decodeHtmlEntities = (value: string) =>
  value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const stripHtml = (value: string) =>
  decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const extractTag = (input: string, tagName: string) => {
  const match = input.match(
    new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'i'),
  );

  return match?.[1] ? stripHtml(match[1]) : undefined;
};

const normalizeUrl = (value: string) => {
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
};

const decodeDuckDuckGoRedirect = (href: string) => {
  const normalizedHref = decodeHtmlEntities(href);

  try {
    const candidate = normalizedHref.startsWith('//')
      ? `https:${normalizedHref}`
      : normalizedHref;
    const url = new URL(candidate);
    const redirected = url.searchParams.get('uddg');

    return normalizeUrl(redirected ? decodeURIComponent(redirected) : candidate);
  } catch {
    return normalizeUrl(normalizedHref);
  }
};

const parseDuckDuckGoResults = (html: string, maxResults: number): SearchResult[] => {
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();
  const anchorRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    if (results.length >= maxResults) {
      break;
    }

    const [, href, titleHtml] = match;
    const resultUrl = decodeDuckDuckGoRedirect(href);

    if (!resultUrl || seenUrls.has(resultUrl)) {
      continue;
    }

    const block = html.slice(match.index ?? 0, (match.index ?? 0) + 2500);
    const snippetMatch =
      block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) ??
      block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    const sourceMatch =
      block.match(/class="result__extras__url"[^>]*>([\s\S]*?)<\/a>/i) ??
      block.match(/class="result__url"[^>]*>([\s\S]*?)<\/a>/i);

    results.push({
      kind: 'web',
      title: stripHtml(titleHtml),
      url: resultUrl,
      snippet: snippetMatch ? stripHtml(snippetMatch[1]) : '',
      source: sourceMatch ? stripHtml(sourceMatch[1]) : undefined,
    });
    seenUrls.add(resultUrl);
  }

  return results;
};

const searchWeb = async (
  query: string,
  maxResults: number,
  abortSignal?: AbortSignal,
) => {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  url.searchParams.set('kl', 'us-en');

  const response = await fetch(url, {
    signal: abortSignal,
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'Mozilla/5.0 (compatible; RockoBot/1.0)',
    },
  });

  if (!response.ok) {
    throw new Error(`Web search failed with status ${response.status}`);
  }

  const html = await response.text();
  return parseDuckDuckGoResults(html, maxResults);
};

const searchNews = async (
  query: string,
  maxResults: number,
  abortSignal?: AbortSignal,
) => {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', 'US');
  url.searchParams.set('ceid', 'US:en');

  const response = await fetch(url, {
    signal: abortSignal,
    headers: {
      accept: 'application/rss+xml,application/xml,text/xml',
      'user-agent': 'Mozilla/5.0 (compatible; RockoBot/1.0)',
    },
  });

  if (!response.ok) {
    throw new Error(`News search failed with status ${response.status}`);
  }

  const xml = await response.text();
  const results: SearchResult[] = [];

  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    if (results.length >= maxResults) {
      break;
    }

    const item = match[1];
    const title = extractTag(item, 'title');
    const urlValue = extractTag(item, 'link');
    const source = extractTag(item, 'source');
    const publishedAt = extractTag(item, 'pubDate');
    const snippet = extractTag(item, 'description') ?? '';
    const normalizedUrl = urlValue ? normalizeUrl(urlValue) : undefined;

    if (!title || !normalizedUrl) {
      continue;
    }

    results.push({
      kind: 'news',
      title,
      url: normalizedUrl,
      snippet,
      source,
      publishedAt,
    });
  }

  return results;
};

export const webSearchTool = createTool({
  id: 'web-search',
  description:
    'Search the live web or current news for up-to-date information, headlines, sources, and links.',
  inputSchema: webSearchInputSchema,
  outputSchema: webSearchOutputSchema,
  mcp: {
    annotations: {
      title: 'Web Search',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    _meta: {
      category: 'research',
    },
  },
  execute: async ({ query, searchType = 'web', maxResults = 5 }, context) => {
    const results =
      searchType === 'news'
        ? await searchNews(query, maxResults, context.abortSignal)
        : await searchWeb(query, maxResults, context.abortSignal);

    return {
      query,
      searchType,
      fetchedAt: new Date().toISOString(),
      results,
    };
  },
});
