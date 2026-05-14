import Groq from "groq-sdk";
import Exa from "exa-js";
import { createClient } from "@supabase/supabase-js";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { isAllowedByRobots } from "@/app/lib/robots";
import { isDeadlineExpired, isStartYearPassed } from "@/app/lib/deadline";

// ── types ─────────────────────────────────────────────────────────────────────

export interface RawItem {
  title: string;
  link: string;
  description: string;
}

export interface GroqJob {
  title: string;
  institution: string;
  location: string | null;
  subfield: string;
  specialization: string | null;
  position_type: string;
  deadline: string | null;
  start_date: string | null;
  url: string;
  sharingRestricted: boolean;
  isJobPosting: boolean;
}

export interface NormalizedJob extends Omit<GroqJob, "isJobPosting"> {
  source: string;
}

export interface Source {
  id: string;
  name: string;
  urls: string[];
  parse: (html: string) => RawItem[];
  skipPageFetch?: boolean; // use feed description as-is, skip individual page fetches
}

// ── utilities ─────────────────────────────────────────────────────────────────

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const isPdfUrl = (url: string) =>
  url.split("?")[0].toLowerCase().endsWith(".pdf");

export async function extractPdfText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; anthro-jobs-aggregator/1.0)",
      },
    });
    if (!res.ok) return "";
    const buffer = Buffer.from(await res.arrayBuffer());
    // Dynamic import avoids Next.js bundler issues with pdf-parse
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfParse = ((await import("pdf-parse")) as any).default;
    const { text } = (await pdfParse(buffer)) as { text: string };
    return text.replace(/\s+/g, " ").trim().slice(0, 3000);
  } catch {
    return "";
  }
}

// Single list covering all reasons to discard a page: gone, expired, or paywalled
const SKIP_PHRASES = [
  "page not found",
  "position not found",
  "vacancy not found",
  "this position has been filled",
  "position has been filled",
  "no longer available",
  "this posting is not available",
  "hiring in process/finished",
  "not possible to apply",
  "this vacancy has now expired",
  "job has expired",
  "deadline has passed",
  "sorry we could not find",
  "404",
  "you must log in",
  "sign in to view",
  "login required",
  "members only",
  "create an account to view",
  "please log in",
  "register to view",
];

// Kept for any external callers
export const UNAVAILABLE_PHRASES = SKIP_PHRASES;

// Returns null if the page is definitively gone/removed or paywalled; "" on transient failure.
export async function fetchJobPage(url: string): Promise<string | null> {
  if (isPdfUrl(url)) {
    return (await extractPdfText(url)) || "";
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; anthro-jobs-aggregator/1.0)",
        Accept: "text/html",
      },
    });
  } catch {
    return "";
  }

  if (res.status === 404 || res.status === 410) return null;
  if (res.status === 401 || res.status === 403) {
    console.log(`[scrape] Skipping paywalled page (HTTP ${res.status}): ${url}`);
    return null;
  }
  if (!res.ok) return "";

  const html = await res.text();
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const content = (mainMatch ? mainMatch[1] : html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);

  const lower = content.toLowerCase();
  if (SKIP_PHRASES.some((phrase) => lower.includes(phrase))) {
    console.log(`[scrape] Skipping unavailable/paywalled page (content): ${url}`);
    return null;
  }

  return content;
}

export async function fetchHtml(
  url: string,
  opts?: { truncate?: boolean },
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; anthro-jobs-aggregator/1.0)",
        Accept: "text/html",
      },
    });
  } catch {
    return "";
  }
  if (!res.ok) return "";
  const html = await res.text();

  if (!opts?.truncate) return html;

  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const content = mainMatch ? mainMatch[1] : html;
  return content
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
}

// ── parsers ───────────────────────────────────────────────────────────────────

export function parseHNet(html: string): RawItem[] {
  const items: RawItem[] = [];
  const articleRegex =
    /<article class="node node--type-job[^"]*">([\s\S]*?)<\/article>/g;
  let match;
  while ((match = articleRegex.exec(html)) !== null) {
    const articleHtml = match[1];
    const linkMatch = articleHtml.match(
      /<h3>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
    );
    const dateMatch = articleHtml.match(
      /<div class="posting-date">Posted on:\s*([\s\S]*?)\s*<\/div>/,
    );
    if (!linkMatch) continue;
    const link = linkMatch[1].trim();
    const title = linkMatch[2]
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    const postedDate = dateMatch?.[1]?.replace(/<[^>]*>/g, "").trim() ?? "";
    if (title && link)
      items.push({
        title,
        link,
        description: postedDate ? `Posted: ${postedDate}` : "",
      });
  }
  return items;
}

// Parses the H-Net Mastodon RSS feed — extracts the external job URL from each post's description HTML
function parseHNetMastodon(xml: string): RawItem[] {
  console.log(
    `[hnet/mastodon] raw response (first 1000 chars):\n${xml.slice(0, 1000)}`,
  );
  const parser = new XMLParser({
    ignoreAttributes: false,
    cdataPropName: "__cdata",
  });
  let feed: unknown;
  try {
    feed = parser.parse(xml);
  } catch (err) {
    console.error(`[hnet/mastodon] XML parse error: ${err}`);
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channel = (feed as any)?.rss?.channel;
  if (!channel) {
    console.error(`[hnet/mastodon] unexpected feed structure — no rss.channel`);
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawItems: any[] = Array.isArray(channel.item)
    ? channel.item
    : channel.item
      ? [channel.item]
      : [];
  console.log(`[hnet/mastodon] ${rawItems.length} raw items in feed`);

  const items: RawItem[] = [];
  for (const item of rawItems) {
    const titleRaw = (item.title?.__cdata ?? item.title ?? "")
      .toString()
      .trim();
    const descHtml = (
      item.description?.__cdata ??
      item.description ??
      ""
    ).toString();

    // Find the first external link in the post — that's the actual job URL
    const hrefs = [...descHtml.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(
      (m) => m[1],
    );
    const jobUrl = hrefs.find(
      (u) => !u.includes("h-net.social") && !u.includes("mastodon"),
    );
    if (!jobUrl) continue;

    const description = descHtml
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    items.push({
      title: titleRaw || description.slice(0, 120),
      link: jobUrl,
      description,
    });
  }
  console.log(`[hnet/mastodon] ${items.length} items with job URLs extracted`);
  return items;
}

// Fetches H-Net job posts from the Bluesky public API, extracting link facets
async function fetchHNetBluesky(): Promise<RawItem[]> {
  console.log("[hnet/bluesky] fetching author feed");
  let res: Response;
  try {
    res = await fetch(
      "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=h-net-job-guide.bsky.social&limit=50",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; anthro-jobs-aggregator/1.0)",
        },
      },
    );
  } catch (err) {
    console.error(`[hnet/bluesky] fetch error: ${err}`);
    return [];
  }
  if (!res.ok) {
    console.error(`[hnet/bluesky] HTTP ${res.status}`);
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await res.json()) as { feed?: any[] };
  const feed = data.feed ?? [];
  console.log(`[hnet/bluesky] ${feed.length} posts in feed`);

  const items: RawItem[] = [];
  for (const entry of feed) {
    const post = entry.post;
    const text: string = post?.record?.text ?? "";

    // Extract URL from richtext link facets
    let url = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const facet of (post?.record?.facets ?? []) as any[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const feature of (facet.features ?? []) as any[]) {
        if (feature.$type === "app.bsky.richtext.facet#link" && feature.uri) {
          url = feature.uri;
          break;
        }
      }
      if (url) break;
    }
    // Fallback: embedded external card
    if (!url) {
      url =
        post?.embed?.external?.uri ?? post?.record?.embed?.external?.uri ?? "";
    }

    if (text && url)
      items.push({
        title: text.slice(0, 200).trim(),
        link: url,
        description: text,
      });
  }
  console.log(`[hnet/bluesky] ${items.length} items with URLs extracted`);
  return items;
}

export async function scrapeHNet(groqClient: Groq): Promise<NormalizedJob[]> {
  const seen = new Set<string>();
  const rawItems: RawItem[] = [];

  // Try Mastodon RSS
  console.log(
    "[hnet] fetching Mastodon RSS: https://h-net.social/@HNetJobGuide.rss",
  );
  const mastodonXml = await fetchHtml("https://h-net.social/@HNetJobGuide.rss");
  if (mastodonXml) {
    for (const item of parseHNetMastodon(mastodonXml)) {
      if (item.link && !seen.has(item.link)) {
        seen.add(item.link);
        rawItems.push(item);
      }
    }
  } else {
    console.warn("[hnet] Mastodon RSS returned empty");
  }

  // Try Bluesky (as supplement / backup)
  for (const item of await fetchHNetBluesky()) {
    if (item.link && !seen.has(item.link)) {
      seen.add(item.link);
      rawItems.push(item);
    }
  }

  console.log(
    `[hnet] ${rawItems.length} total unique items before normalization`,
  );
  if (rawItems.length === 0) return [];

  const BATCH_SIZE = 5;
  const normalized: NormalizedJob[] = [];
  for (let i = 0; i < rawItems.length; i += BATCH_SIZE) {
    const results = await normalizeBatch(
      groqClient,
      rawItems.slice(i, i + BATCH_SIZE),
    );
    for (const job of results) {
      if (job.isJobPosting === false) continue;
      const { isJobPosting: _, ...jobData } = job;
      normalized.push({ ...jobData, source: "h-net" });
    }
  }
  return normalized;
}

// Parses a standard WordPress RSS feed (handles both plain text and CDATA)
export function parseRSS(xml: string): RawItem[] {
  const items: RawItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title =
      (block.match(
        /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/,
      ) ?? [])[1]
        ?.replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim() ?? "";
    const link =
      (block.match(/<link[^>]*>\s*(https?:[^\s<]+)\s*<\/link>/) ??
        [])[1]?.trim() ?? "";
    const desc =
      (block.match(
        /<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/,
      ) ?? [])[1]
        ?.replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500) ?? "";
    if (title && link) items.push({ title, link, description: desc });
  }
  return items;
}

const SCRAPER_EXCLUDED =
  /\/(purchase|advertise|post-a-job|submit|add-job|buy|pricing|packages|about|contact|resources|membership|events|news|donate|login|register|faq|policy|privacy|sitemap|guide|profile|member|directory|people|person)/i;

export function parseNAPA(html: string): RawItem[] {
  const $ = load(html);
  const items: RawItem[] = [];
  const seen = new Set<string>();
  const BASE = "https://www.practicinganthropology.org";

  const selectors = [
    "main a[href]",
    ".field-item a[href]",
    ".view-content a[href]",
    ".entry-content a[href]",
    "article a[href]",
    "#content a[href]",
  ];
  for (const sel of selectors) {
    console.log(`[NAPA] selector "${sel}": ${$(sel).length} matches`);
  }

  $(
    "main a[href], .field-item a[href], .view-content a[href], .entry-content a[href], article a[href], #content a[href]",
  ).each((_, el) => {
    const $a = $(el);
    const href = ($a.attr("href") ?? "").trim();
    const title = $a.text().trim();
    if (!href || !title || title.length < 10) return;
    if (
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    )
      return;
    const link = href.startsWith("http") ? href : `${BASE}${href}`;
    if (SCRAPER_EXCLUDED.test(link)) return;
    if (!seen.has(link)) {
      seen.add(link);
      items.push({ title, link, description: "" });
    }
  });

  return items;
}

export function parseSfAA(html: string): RawItem[] {
  const $ = load(html);
  const items: RawItem[] = [];
  const seen = new Set<string>();
  const BASE = "https://www.appliedanthro.org";

  const selectors = [
    "main a[href]",
    ".field-item a[href]",
    ".view-content a[href]",
    ".entry-content a[href]",
    "article a[href]",
    "#content a[href]",
  ];
  for (const sel of selectors) {
    console.log(`[SfAA] selector "${sel}": ${$(sel).length} matches`);
  }

  $(
    "main a[href], .field-item a[href], .view-content a[href], .entry-content a[href], article a[href], #content a[href]",
  ).each((_, el) => {
    const $a = $(el);
    const href = ($a.attr("href") ?? "").trim();
    const title = $a.text().trim();
    if (!href || !title || title.length < 10) return;
    if (
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    )
      return;
    const link = href.startsWith("http") ? href : `${BASE}${href}`;
    if (SCRAPER_EXCLUDED.test(link)) return;
    if (!seen.has(link)) {
      seen.add(link);
      items.push({ title, link, description: "" });
    }
  });

  return items;
}

// ── sources ───────────────────────────────────────────────────────────────────

export const SOURCES: Source[] = [];

// ── normalization ─────────────────────────────────────────────────────────────

export async function normalizeBatch(
  client: Groq,
  items: RawItem[],
  retries = 3,
): Promise<GroqJob[]> {
  const itemsText = items
    .map(
      (item, i) =>
        `Item ${i + 1}:\nTitle: ${item.title}\nURL: ${item.link}\nFull posting:\n${item.description}`,
    )
    .join("\n\n---\n\n");

  try {
    const response = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      max_tokens: 1024,
      messages: [
        {
          role: "system",
          content: `You are a data normalizer for academic anthropology job listings. Extract structured information and return ONLY a valid JSON array with no prose, markdown fences, or explanation.

Each object must have exactly these fields:
- title: string (the job title only — strip the institution name if it appears before a dash or comma)
- institution: string (university or organization name)
- location: string | null (city and state/country. Scan all text for location signals. If the institution name implies a location — e.g. "University of Texas at Austin" → "Austin, TX" — make that inference. Return null only if there is genuinely no basis for any location guess.)
- subfield: string (the disciplinary home of the department or program — best-fit from: archaeology, cultural, biological, linguistic, applied, historical, or other. This reflects the department type, not the specific hire's research focus. A cultural anthropology department hiring a medical anthropologist should still have subfield "cultural".)
- specialization: string | null (the specific research area the position is targeting, distinct from the department type. Examples: medical, visual, urban, media, environmental, political, economic, digital, multispecies, affect, kinship, religion, migration, forensic, cognitive, or any specific named focus from the posting. Return null if the posting does not indicate a particular specialization beyond the general subfield.)
- position_type: string (best-fit from: tenure-track, postdoc, VAP, lecturer, visiting, adjunct, or other)
- deadline: string | null (scan all text for explicit application deadline phrases: "applications due", "apply by", "review begins", "closing date", "deadline", "consideration begins". Return the date as a plain human-readable string like "January 15, 2026". IMPORTANT: only extract dates that are framed as application deadlines — do NOT extract the posting date, hire year, start date, or any year that appears incidentally in the text such as "2025–2026 position" or "hired for Fall 2026". Return null if no genuine application deadline is stated.)
- start_date: string | null (the expected start date or term, e.g. "Fall 2026", "September 1, 2026", "Spring 2027". Look for phrases like "position begins", "start date", "appointment begins", "effective", "to begin", or a semester/term name near a year. Return null if not mentioned.)
- url: string (the job listing URL)
- sharingRestricted: boolean (true if the posting contains any language indicating it should not be shared publicly: "do not share", "not for distribution", "do not forward", "for internal use only", "confidential", "not for public posting", "please do not forward", or similar phrasing. false otherwise.)
- isJobPosting: boolean (true ONLY if this page is an actual job or position posting — a specific vacancy that candidates can apply for, with a clear application process (e.g. a link to apply, an email to send materials, or explicit instructions for submitting). Set to false for: personal portfolio websites, personal academic homepages (a researcher's own site listing their CV, projects, or contact info), faculty/staff profile pages, department or people directories, news articles, blog posts, event listings, pages describing a program or research group, conference announcements, AND any page whose primary purpose is explaining how to post, purchase, or submit a job advertisement. If the page has no clear way for a candidate to apply — no apply button, no email, no submission instructions — set to false. FIELD RELEVANCE: also set to false if the position is primarily in sociology, political science, economics, psychology, communications, education, public health, or any other discipline with no anthropology component — meaning the posting makes no mention of anthropological methods, ethnography, fieldwork, anthropological theory, or an anthropology department. A job in "social sciences" or "qualitative research" that is clearly housed in a non-anthropology department should be false. When in doubt, default to false.)

Use an empty string for unknown non-nullable string fields. Prefer a reasonable inference over null or empty string whenever the text gives any basis for one.

IMPORTANT — JSON safety: your output must be valid JSON. Escape all special characters inside string values: use \\" for double quotes, \\' or \\u2019 for apostrophes/smart quotes, \\\\ for backslashes, and \\n for newlines. Never leave a raw unescaped double quote inside a JSON string value. If a title or description contains characters that would break JSON, escape them or simplify the text.`,
        },
        {
          role: "user",
          content: `Normalize these ${items.length} anthropology job listing(s) into a JSON array:\n\n${itemsText}`,
        },
      ],
    });

    const text = response.choices[0].message.content ?? "[]";
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1) {
      console.warn(
        "[groq] No JSON array found in response:",
        text.slice(0, 500),
      );
      return [];
    }
    const jsonSlice = text.slice(start, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonSlice);
    } catch (parseErr) {
      console.warn(
        `[groq] JSON.parse failed: ${parseErr}\nRaw response (first 1000 chars):\n${text.slice(0, 1000)}`,
      );
      return [];
    }
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      Array.isArray(parsed[0])
    ) {
      parsed = (parsed as unknown[]).flat(1);
    }
    return (parsed as unknown[]).filter(
      (item): item is GroqJob =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    );
  } catch (err) {
    if (err instanceof Groq.APIError && err.status === 429) {
      if (retries > 0) {
        const suggested =
          parseInt(err.headers.get("retry-after") ?? "30", 10) + 1;
        const waitSecs = Math.min(suggested, 30);
        console.warn(
          `[groq] Rate limited — waiting ${waitSecs}s then retrying (${retries} left)`,
        );
        await sleep(waitSecs * 1000);
        return normalizeBatch(client, items, retries - 1);
      }
      console.warn(
        `[groq] Rate limit retries exhausted — skipping batch of ${items.length} items: ${items.map((i) => i.title).join(", ")}`,
      );
      return [];
    }
    if (err instanceof Groq.APIError && err.status === 413) {
      if (items.length > 1) {
        console.warn(
          `[groq] Request too large (${items.length} items) — splitting in half`,
        );
        const mid = Math.ceil(items.length / 2);
        const [a, b] = await Promise.all([
          normalizeBatch(client, items.slice(0, mid), retries),
          normalizeBatch(client, items.slice(mid), retries),
        ]);
        return [...a, ...b];
      }
      console.warn(
        `[groq] Single item still too large — skipping: "${items[0]?.title}"`,
      );
      return [];
    }
    throw err;
  }
}

// ── per-source scraper ────────────────────────────────────────────────────────

export async function scrapeSource(
  source: Source,
  groqClient: Groq,
): Promise<NormalizedJob[]> {
  const allowed = await isAllowedByRobots(source.urls[0]);
  if (!allowed) {
    console.warn(
      `[scrape] ${source.name}: skipping — disallowed by robots.txt`,
    );
    return [];
  }

  let rawItems: RawItem[] = [];
  const seen = new Set<string>();

  for (const url of source.urls) {
    console.log(`[scrape] ${source.name}: fetching ${url}`);
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.error(`[scrape] ${source.name}: fetch threw for ${url} — ${err}`);
      continue;
    }
    if (!html) {
      console.error(
        `[scrape] ${source.name}: empty response from ${url} (non-2xx or network error)`,
      );
      continue;
    }
    console.log(
      `[scrape] ${source.name}: HTML preview (${url}):\n${html.slice(0, 500)}`,
    );
    const parsed = source.parse(html);
    console.log(
      `[scrape] ${source.name}: parser returned ${parsed.length} items from ${url}`,
    );
    for (const item of parsed) {
      if (!seen.has(item.link)) {
        seen.add(item.link);
        rawItems.push(item);
      }
    }
  }

  if (rawItems.length === 0) {
    console.warn(`[scrape] ${source.name}: no listings parsed`);
    return [];
  }

  if (!source.skipPageFetch) {
    // Fetch each job's full page, 1 s apart; drop pages that are gone/unavailable
    const fetchedItems: RawItem[] = [];
    for (let i = 0; i < rawItems.length; i++) {
      if (i > 0) await sleep(1000);
      const content = await fetchJobPage(rawItems[i].link);
      if (content === null) {
        console.log(
          `[scrape] ${source.name}: skipping unavailable page: ${rawItems[i].link}`,
        );
        continue;
      }
      fetchedItems.push({ ...rawItems[i], description: content });
    }
    rawItems = fetchedItems;
  }

  const BATCH_SIZE = 5;
  const normalized: NormalizedJob[] = [];
  for (let i = 0; i < rawItems.length; i += BATCH_SIZE) {
    const results = await normalizeBatch(
      groqClient,
      rawItems.slice(i, i + BATCH_SIZE),
    );
    for (const job of results) {
      if (job.isJobPosting === false) continue;
      const { isJobPosting: _, ...jobData } = job;
      normalized.push({ ...jobData, source: source.id });
    }
  }

  return normalized;
}

// ── Exa neural search ─────────────────────────────────────────────────────────

export const EXA_QUERIES = [
  // General academic
  "cultural anthropology faculty position 2027",
  "social anthropology lecturer job posting 2027",
  "sociocultural anthropology assistant professor 2027",
  "ethnography faculty job posting 2027",
  "ethnographic research position hiring 2027",
  "anthropology postdoctoral fellowship 2027",
  "anthropology VAP visiting assistant professor 2027",

  // Specializations
  "visual anthropology job position 2027",
  "multimodal ethnography researcher position 2027",
  "sound studies anthropology job 2027",
  "sensory ethnography position 2027",
  "media anthropology job posting 2027",
  "digital anthropology position 2027",
  "urban anthropology position 2027",
  "environmental anthropology job 2027",

  // Non-academic with anthropology degree
  "anthropology degree required researcher position 2026",
  "UX researcher anthropology background 2026",
  "qualitative researcher anthropology 2026",
  "applied anthropologist position 2026",
  "ethnographer researcher NGO position 2026",
  "cultural consultant anthropology 2026",

  // Broader humanities and social sciences
  "humanities social sciences faculty position 2027",
  "social sciences lecturer job 2027",
  "qualitative social research position 2027",

  // Regional
  "social anthropology position Europe university 2027",
  "anthropology lecturer UK 2027",
  "anthropology faculty position Japan 2027",
  "anthropology faculty position Korea 2027",
];

const EXA_EXCLUDED_URL =
  /\/(people|person|faculty|staff|about|news|events|blog|publications|research|guide|profile|member|directory|login|signin|sign-in|user\/login)(\/|$)/i;

// Excludes bare root-domain URLs (e.g. https://johnsmith.com/) on commercial TLDs —
// these are almost always personal sites, not job postings.
function isRootDomainUrl(url: string): boolean {
  try {
    const { pathname, hostname } = new URL(url);
    if (pathname !== "/" && pathname !== "") return false;
    return /\.(com|net)$/.test(hostname) && !/\.(edu|org|gov|ac\.\w+)$/.test(hostname);
  } catch {
    return false;
  }
}

const BLACKLISTED_DOMAINS = new Set([
  "ngojobsinafrica.com",
  "scholarshipdb.net",
  "hiswai.com",
  "nrmjobs.com.au",
  "jobsdb.com",
  "jobs.auburnpub.com",
  "jobs.kearneyhub.com",
]);

function isBlacklistedDomain(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return [...BLACKLISTED_DOMAINS].some(
      (d) => hostname === d || hostname.endsWith(`.${d}`),
    );
  } catch {
    return false;
  }
}

const NON_ENGLISH_STOPWORDS = [
  "och", "att", "det", "som", "är",          // Swedish
  "und", "die", "der", "das", "ist", "für",  // German
  "les", "des", "une", "pour", "dans",       // French
];

function isProbablyNonEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/\b\w+\b/g) ?? [];
  const hits = words.filter((w) => NON_ENGLISH_STOPWORDS.includes(w)).length;
  return hits > 10;
}

function urlAuthority(url: string): number {
  try {
    const { hostname } = new URL(url);
    if (hostname.endsWith(".edu")) return 3;
    if (/university|college|institute|school/.test(hostname)) return 2;
    return 1;
  } catch {
    return 0;
  }
}

function deduplicateByInstitutionTitle(jobs: NormalizedJob[]): NormalizedJob[] {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();

  const groups = new Map<string, NormalizedJob[]>();
  for (const job of jobs) {
    const key = `${norm(job.institution)}|${norm(job.title).slice(0, 40)}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(job);
    groups.set(key, bucket);
  }

  const out: NormalizedJob[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      out.push(bucket[0]);
    } else {
      const best = bucket.reduce((a, b) =>
        urlAuthority(a.url) >= urlAuthority(b.url) ? a : b,
      );
      console.log(
        `[exa] Deduped ${bucket.length} listings for "${best.institution}" — "${best.title}", kept ${best.url}`,
      );
      out.push(best);
    }
  }
  return out;
}

export async function scrapeExa(groqClient: Groq): Promise<NormalizedJob[]> {
  const exa = new Exa(process.env.EXA_API_KEY!);
  const seen = new Set<string>();
  const rawItems: RawItem[] = [];

  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

  for (let i = 0; i < EXA_QUERIES.length; i++) {
    if (i > 0) await sleep(200);
    const { results } = await exa.searchAndContents(EXA_QUERIES[i], {
      type: "neural",
      text: true,
      numResults: 5,
      startPublishedDate: sixMonthsAgo,
    });

    for (const item of results) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      let description: string;
      if (isPdfUrl(item.url)) {
        description = await extractPdfText(item.url);
      } else {
        description = (item.text ?? "").slice(0, 3000);
        const lower = description.toLowerCase();
        if (SKIP_PHRASES.some((phrase) => lower.includes(phrase))) {
          console.log(`[exa] Skipping unavailable/paywalled page: ${item.url}`);
          continue;
        }
        if (isProbablyNonEnglish(description)) {
          console.log(`[exa] Skipping non-English page: ${item.url}`);
          continue;
        }
      }
      rawItems.push({ title: item.title ?? "", link: item.url, description });
    }
  }

  const preFiltered = rawItems.filter((item) => {
    if (EXA_EXCLUDED_URL.test(item.link)) return false;
    if (isRootDomainUrl(item.link)) {
      console.log(`[exa] Skipping root-domain personal site: ${item.link}`);
      return false;
    }
    if (isBlacklistedDomain(item.link)) {
      console.log(`[exa] Skipping blacklisted domain: ${item.link}`);
      return false;
    }
    return true;
  });
  console.log(
    `[exa] ${rawItems.length} unique results → ${preFiltered.length} after URL filter`,
  );

  if (preFiltered.length === 0) return [];

  const BATCH_SIZE = 5;
  const normalized: NormalizedJob[] = [];
  for (let i = 0; i < preFiltered.length; i += BATCH_SIZE) {
    const batch = preFiltered.slice(i, i + BATCH_SIZE);
    const results = await normalizeBatch(groqClient, batch);
    for (const job of results) {
      if (job.isJobPosting === false) {
        console.log(
          `[exa] Skipping non-job-posting: "${job.title}" (${job.url})`,
        );
        continue;
      }
      const { isJobPosting: _, ...jobData } = job;
      normalized.push({ ...jobData, source: job.url });
    }
  }

  return deduplicateByInstitutionTitle(normalized);
}

// ── shared save helper ────────────────────────────────────────────────────────

export async function saveJobs(allJobs: NormalizedJob[]): Promise<Response> {
  for (const job of allJobs.filter((j) => j.sharingRestricted)) {
    console.warn(
      `[scrape] Sharing-restricted job (saving with flag): "${job.title}" @ ${job.institution}`,
    );
  }

  const isExpired = (j: NormalizedJob) =>
    isDeadlineExpired(j.deadline, { log: console.log, url: j.url }) ||
    isStartYearPassed(j.start_date, { log: console.log, url: j.url });

  const expired = allJobs.filter(isExpired);
  const liveJobs = allJobs.filter((j) => !isExpired(j));

  if (liveJobs.length === 0) {
    return Response.json({
      added: 0,
      skipped: 0,
      total: 0,
      expired: expired.length,
    });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
  );

  const dbRows = liveJobs
    .map(({ sharingRestricted, ...rest }) => ({
      ...rest,
      sharing_restricted: sharingRestricted ?? false,
    }))
    .filter((row) => row && typeof row.url === "string" && row.url.length > 0);

  console.log(
    "[scrape] First row to insert:",
    JSON.stringify(dbRows[0], null, 2),
  );

  const { data: inserted, error: dbError } = await supabase
    .from("jobs")
    .upsert(dbRows, { onConflict: "url", ignoreDuplicates: true })
    .select("url");

  if (dbError) throw new Error(`Supabase error: ${dbError.message}`);

  const added = inserted?.length ?? 0;
  const skipped = allJobs.length - added;

  return Response.json({
    added,
    skipped,
    total: liveJobs.length,
    expired: expired.length,
    sharingRestricted: liveJobs.filter((j) => j.sharingRestricted).length,
  });
}
