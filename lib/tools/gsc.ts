import "server-only";

import { z } from "zod";
import { tool } from "ai";

export const gscDimension = z.enum([
  "query",
  "page",
  "country",
  "device",
  "date",
  "searchAppearance",
]);

export const gscInputSchema = z.object({
  siteUrl: z
    .string()
    .min(1)
    .describe(
      "Verified Search Console property. URL-prefix property uses the trailing slash form ('https://example.com/'); domain property uses 'sc-domain:example.com'.",
    ),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Start date YYYY-MM-DD; defaults to 28 days ago (UTC)"),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("End date YYYY-MM-DD; defaults to today (UTC)"),
  query: z
    .string()
    .optional()
    .describe("Optional exact-match filter on the query string"),
  page: z
    .string()
    .optional()
    .describe("Optional exact-match filter on the page URL"),
  dimensions: z
    .array(gscDimension)
    .default(["query", "page"])
    .describe("Dimensions to group by"),
  rowLimit: z
    .number()
    .int()
    .min(1)
    .max(25_000)
    .default(50)
    .describe("Max rows to return (1-25000)"),
});

export type GscInput = z.infer<typeof gscInputSchema>;

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscOutput {
  siteUrl: string;
  startDate: string;
  endDate: string;
  rowCount: number;
  rows: GscRow[];
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/**
 * Resolve a Search Console access token. Two supported flows:
 *
 *   1. `GSC_ACCESS_TOKEN` — pre-minted token (useful for local dev).
 *   2. `GSC_REFRESH_TOKEN` + `GSC_CLIENT_ID` + `GSC_CLIENT_SECRET` — OAuth
 *      refresh-token flow; we cache the access token until it expires.
 *
 * For an MVP we deliberately avoid the `googleapis` SDK to keep the
 * dependency footprint small.
 */
async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const direct = process.env.GSC_ACCESS_TOKEN;
  if (direct) {
    // Treat externally-supplied tokens as short-lived (50 minutes).
    cachedToken = {
      accessToken: direct,
      expiresAt: Date.now() + 50 * 60 * 1000,
    };
    return direct;
  }

  const refreshToken = process.env.GSC_REFRESH_TOKEN;
  const clientId = process.env.GSC_CLIENT_ID;
  const clientSecret = process.env.GSC_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error(
      "GSC credentials missing. Set GSC_ACCESS_TOKEN, or GSC_REFRESH_TOKEN + GSC_CLIENT_ID + GSC_CLIENT_SECRET in .env.local.",
    );
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Google OAuth refresh failed: ${res.status} ${await res.text()}`,
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return json.access_token;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface SearchAnalyticsResponse {
  rows?: GscRow[];
}

/**
 * Standalone Google Search Console `searchAnalytics.query` caller.
 * Returns rows of `{keys, clicks, impressions, ctr, position}` aggregated
 * by the requested dimensions. Used by both the agent (during research) and
 * the weekly cron (re-evaluating published articles).
 */
export async function queryGsc(input: GscInput): Promise<GscOutput> {
  const parsed = gscInputSchema.parse(input);
  const startDate = parsed.startDate ?? isoDaysAgo(28);
  const endDate = parsed.endDate ?? isoDaysAgo(0);

  const filters: Array<{
    dimension: string;
    operator: string;
    expression: string;
  }> = [];
  if (parsed.query) {
    filters.push({
      dimension: "query",
      operator: "equals",
      expression: parsed.query,
    });
  }
  if (parsed.page) {
    filters.push({
      dimension: "page",
      operator: "equals",
      expression: parsed.page,
    });
  }

  const body = {
    startDate,
    endDate,
    dimensions: parsed.dimensions,
    rowLimit: parsed.rowLimit,
    ...(filters.length ? { dimensionFilterGroups: [{ filters }] } : {}),
  };

  const token = await getAccessToken();
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    parsed.siteUrl,
  )}/searchAnalytics/query`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    // Drop the cached token on auth errors so the next call refreshes.
    if (res.status === 401) cachedToken = null;
    throw new Error(`GSC query failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as SearchAnalyticsResponse;
  const rows = json.rows ?? [];
  return {
    siteUrl: parsed.siteUrl,
    startDate,
    endDate,
    rowCount: rows.length,
    rows,
  };
}

/**
 * Vercel AI SDK tool descriptor. Pass into `tools: { gsc_query }` for the
 * evaluator subagent.
 */
export const gscTool = tool({
  description:
    "Query Google Search Console searchAnalytics for a verified property. Returns clicks, impressions, CTR, and average position grouped by the requested dimensions. Use to evaluate how published articles are performing.",
  inputSchema: gscInputSchema,
  execute: queryGsc,
});
