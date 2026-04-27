import "server-only";

import { z } from "zod";
import { tool } from "ai";
import * as cheerio from "cheerio";

export const serpInputSchema = z.object({
  query: z.string().min(2).describe("Search query to look up"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(10)
    .describe("Number of organic results to return (1-10)"),
  hl: z
    .string()
    .default("us-en")
    .describe(
      "DuckDuckGo locale tag, e.g. 'us-en', 'uk-ua'. Format is '<region>-<language>'.",
    ),
});

export type SerpInput = z.infer<typeof serpInputSchema>;

export interface SerpResult {
  position: number;
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface SerpOutput {
  query: string;
  source: "duckduckgo";
  results: SerpResult[];
}

// Realistic desktop UA — DuckDuckGo's html endpoint blocks obvious bots.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";

/**
 * DuckDuckGo wraps outbound result links as `//duckduckgo.com/l/?uddg=ENC&...`.
 * Decode them so the agent gets the real destination URL.
 */
function decodeDdgRedirect(href: string): string {
  if (!href) return "";
  let normalized = href;
  if (normalized.startsWith("//")) normalized = `https:${normalized}`;
  try {
    const u = new URL(normalized, "https://duckduckgo.com");
    if (u.pathname === "/l/" && u.searchParams.has("uddg")) {
      return decodeURIComponent(u.searchParams.get("uddg")!);
    }
    return u.toString();
  } catch {
    return href;
  }
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Fetch the top organic search results for `query` from DuckDuckGo's HTML
 * endpoint and parse them with Cheerio. We use DDG (not Google) because
 * Google blocks bot traffic from Vercel-class IPs without a paid SERP API,
 * while DDG returns scrape-friendly HTML for free.
 */
export async function analyzeSerp(input: SerpInput): Promise<SerpOutput> {
  const { query, limit, hl } = serpInputSchema.parse(input);

  const body = new URLSearchParams({ q: query, kl: hl });
  const res = await fetch(DDG_HTML_ENDPOINT, {
    method: "POST",
    headers: {
      "user-agent": USER_AGENT,
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(
      `SERP fetch failed: ${res.status} ${res.statusText} (DuckDuckGo HTML endpoint)`,
    );
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const results: SerpResult[] = [];
  $(".result").each((_, el) => {
    if (results.length >= limit) return false;
    const node = $(el);
    const anchor = node.find("a.result__a").first();
    const title = anchor.text().trim();
    const url = decodeDdgRedirect(anchor.attr("href") ?? "");
    if (!title || !url) return;
    const snippet = node.find(".result__snippet").text().trim();
    results.push({
      position: results.length + 1,
      title,
      url,
      snippet,
      domain: safeDomain(url),
    });
    return;
  });

  return { query, source: "duckduckgo", results };
}

/**
 * Vercel AI SDK tool descriptor. Pass into `tools: { serp_analysis }`
 * on `generateText` / `streamText` calls.
 */
export const serpTool = tool({
  description:
    "Fetch and parse top organic search results for a query. Returns position, title, URL, snippet, and domain for up to 10 results. Use to ground article writing in current SERP reality.",
  inputSchema: serpInputSchema,
  execute: analyzeSerp,
});
