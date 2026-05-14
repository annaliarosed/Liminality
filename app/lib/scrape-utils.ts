import Groq from "groq-sdk";
import Exa from "exa-js";
import { createClient } from "@supabase/supabase-js";
import { load } from "cheerio";
import { isAllowedByRobots } from "@/app/lib/robots";
import { isDeadlineExpired } from "@/app/lib/deadline";

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
}

// ── utilities ─────────────────────────────────────────────────────────────────

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const isPdfUrl = (url: string) =>
  url.split("?")[0].toLowerCase().endsWith(".pdf");

export async function extractPdfText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; anthro-jobs-aggregator/1.0)" },
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

export const UNAVAILABLE_PHRASES = [
  "position not found",
  "vacancy not found",
  "page not found",
  "this position has been filled",
  "no longer available",
];

// Returns null if the page is definitively gone/removed; "" on transient failure.
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
  if (UNAVAILABLE_PHRASES.some((phrase) => lower.includes(phrase))) return null;

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

// Parses a standard WordPress RSS feed (handles both plain text and CDATA)
export function parseRSS(xml: string): RawItem[] {
  const items: RawItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title =
      (
        block.match(
          /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/,
        ) ?? []
      )[1]
        ?.replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim() ?? "";
    const link =
      (block.match(/<link[^>]*>\s*(https?:[^\s<]+)\s*<\/link>/) ?? [])[1]?.trim() ?? "";
    const desc =
      (
        block.match(
          /<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/,
        ) ?? []
      )[1]
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

export const SOURCES: Source[] = [
  {
    id: "h-net",
    name: "H-Net",
    urls: [
      "https://networks.h-net.org/jobs/browse?field_job_category_target_id=250142",
      "https://networks.h-net.org/jobs/browse",
    ],
    parse: parseHNet,
  },
  {
    id: "easa",
    name: "EASA",
    urls: ["https://easaonline.org/jobs-and-calls/feed/"],
    parse: parseRSS,
  },
  {
    id: "napa",
    name: "NAPA",
    urls: ["https://www.practicinganthropology.org/mentoring-career/position-listings/"],
    parse: parseNAPA,
  },
  {
    id: "sfaa",
    name: "SfAA",
    urls: ["https://www.appliedanthro.org/resources-projects/job-postings/"],
    parse: parseSfAA,
  },
];

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
- isJobPosting: boolean (true ONLY if this page is an actual job or position posting — a specific vacancy that candidates can apply for. Set to false for: faculty/staff profile pages, people or department directories, news articles, blog posts, event listings, pages describing a program or research group, AND any page whose primary purpose is explaining how to post, purchase, or submit a job advertisement — e.g. "Post a Job", "Advertise with us", "Job ad packages", "Submit a listing", pricing pages, or similar. When in doubt about whether a page is a real vacancy vs. an admin/commercial page, default to false.)

Use an empty string for unknown non-nullable string fields. Prefer a reasonable inference over null or empty string whenever the text gives any basis for one.`,
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
      console.warn("[groq] No JSON array found in response:", text.slice(0, 200));
      return [];
    }
    let parsed = JSON.parse(text.slice(start, end + 1));
    if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
      parsed = parsed.flat(1);
    }
    return (parsed as unknown[]).filter(
      (item): item is GroqJob =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    );
  } catch (err) {
    if (err instanceof Groq.APIError && err.status === 429) {
      if (retries > 0) {
        const suggested = parseInt(err.headers.get("retry-after") ?? "30", 10) + 1;
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
      console.warn(`[groq] Single item still too large — skipping: "${items[0]?.title}"`);
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
    console.warn(`[scrape] ${source.name}: skipping — disallowed by robots.txt`);
    return [];
  }

  let rawItems: RawItem[] = [];
  const seen = new Set<string>();

  for (const url of source.urls) {
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(`[scrape] ${source.name}: failed to fetch ${url} — ${err}`);
      continue;
    }
    console.log(`[scrape] ${source.name}: HTML preview (${url}):\n${html.slice(0, 500)}`);
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
  "anthropology faculty position hiring 2026",
  "anthropology faculty position hiring 2027",
  "social anthropology postdoc fellowship 2026",
  "social anthropology postdoc fellowship 2027",
  "cultural anthropology lecturer job posting 2026",
  "visual anthropology job position 2026",
  "audio anthropology researcher position 2026",
  "ethnography faculty job posting 2026",
  "ethnographic research position hiring 2026",
  "sociocultural anthropology assistant professor 2026",
  "urban anthropology lecturer position 2026",
  "media anthropology job 2026",
  "anthropology faculty position Japan 2026",
  "anthropology faculty position Korea 2026",
  "social anthropology job Tokyo 2026",
  "cultural anthropology researcher Japan 2027",
  "ethnography position Korea university 2026",
  "人類学 faculty position English 2026",
];

const EXA_EXCLUDED_URL =
  /\/(people|person|faculty|staff|about|news|events|blog|publications|research|guide|profile|member|directory)(\/|$)/i;

export async function scrapeExa(groqClient: Groq): Promise<NormalizedJob[]> {
  const exa = new Exa(process.env.EXA_API_KEY!);
  const seen = new Set<string>();
  const rawItems: RawItem[] = [];

  const CHUNK_SIZE = 3;
  for (let i = 0; i < EXA_QUERIES.length; i += CHUNK_SIZE) {
    const chunk = EXA_QUERIES.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.all(
      chunk.map((query) =>
        exa.searchAndContents(query, {
          type: "neural",
          text: true,
          numResults: 5,
        }),
      ),
    );

    for (const { results } of chunkResults) {
      for (const item of results) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        let description: string;
        if (isPdfUrl(item.url)) {
          description = await extractPdfText(item.url);
        } else {
          description = (item.text ?? "").slice(0, 3000);
          const lower = description.toLowerCase();
          if (UNAVAILABLE_PHRASES.some((phrase) => lower.includes(phrase))) {
            console.log(`[exa] Skipping unavailable page: ${item.url}`);
            continue;
          }
        }
        rawItems.push({ title: item.title ?? "", link: item.url, description });
      }
    }
  }

  const preFiltered = rawItems.filter((item) => !EXA_EXCLUDED_URL.test(item.link));
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
        console.log(`[exa] Skipping non-job-posting: "${job.title}" (${job.url})`);
        continue;
      }
      const { isJobPosting: _, ...jobData } = job;
      normalized.push({ ...jobData, source: job.url });
    }
  }

  return normalized;
}

// ── shared save helper ────────────────────────────────────────────────────────

export async function saveJobs(allJobs: NormalizedJob[]): Promise<Response> {
  for (const job of allJobs.filter((j) => j.sharingRestricted)) {
    console.warn(
      `[scrape] Sharing-restricted job (saving with flag): "${job.title}" @ ${job.institution}`,
    );
  }

  const expired = allJobs.filter((j) =>
    isDeadlineExpired(j.deadline, { log: console.log, url: j.url }),
  );
  const liveJobs = allJobs.filter((j) => !isDeadlineExpired(j.deadline));

  if (liveJobs.length === 0) {
    return Response.json({ added: 0, skipped: 0, total: 0, expired: expired.length });
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

  console.log("[scrape] First row to insert:", JSON.stringify(dbRows[0], null, 2));

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
