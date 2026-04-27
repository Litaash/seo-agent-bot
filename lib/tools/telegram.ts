import "server-only";

import { z } from "zod";
import { tool } from "ai";
import { Api } from "grammy";

const TELEGRAM_HARD_LIMIT = 4096;

export const telegramInputSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "Message body to publish. Already-formatted markup matching `parseMode`. Long bodies (>4096 chars) are split into multiple messages preserving paragraph boundaries.",
    ),
  chatId: z
    .string()
    .optional()
    .describe(
      "Override TELEGRAM_CHANNEL_ID for ad-hoc destinations (e.g. '@my_channel' or numeric '-1001234567890').",
    ),
  parseMode: z
    .enum(["MarkdownV2", "HTML", "Markdown"])
    .default("MarkdownV2")
    .describe("Telegram parse_mode. MarkdownV2 is preferred for new code."),
  disableLinkPreview: z
    .boolean()
    .default(false)
    .describe("Disable the automatic link preview card."),
});

export type TelegramInput = z.infer<typeof telegramInputSchema>;

export interface TelegramOutput {
  chatId: string;
  messageIds: number[];
}

let cachedApi: Api | null = null;

function getApi(): Api {
  if (cachedApi) return cachedApi;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set; cannot publish to Telegram.",
    );
  }
  cachedApi = new Api(token);
  return cachedApi;
}

/**
 * Escape user-supplied content for Telegram MarkdownV2.
 *
 * Reserved characters per Bot API docs:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * Exported for callers who construct messages from untrusted strings.
 * `publishToTelegram` itself sends `text` verbatim — the agent owns the
 * formatting decision.
 */
export function escapeMarkdownV2(input: string): string {
  return input.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Split text into Telegram-sized chunks. Prefers paragraph boundaries
 * (`\n\n`), then line breaks, then word boundaries — falling back to a
 * hard cut if nothing better is available.
 *
 * Splits are constrained to land at line/word boundaries because both
 * MarkdownV2 and our HTML formatter emit balanced entities per line:
 * cutting between lines preserves entity pairing, while cutting in the
 * middle of `*bold*` or `<a href="…">` would produce a parse error and
 * Telegram rejects the whole message.
 */
export function chunkForTelegram(
  text: string,
  limit: number = TELEGRAM_HARD_LIMIT,
): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    // Probe from `limit - 1` so a `\n\n` whose first byte sits at the
    // very last allowed position is still considered (the second `\n`
    // would land outside the slice — both are stripped by trimStart).
    const probeFrom = limit - 1;
    let cut = remaining.lastIndexOf("\n\n", probeFrom);
    if (cut < limit / 2) cut = remaining.lastIndexOf("\n", probeFrom);
    if (cut < limit / 2) cut = remaining.lastIndexOf(" ", probeFrom);
    if (cut < 1) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Publish `text` to a Telegram channel. Long bodies are split into a
 * series of messages so we honour the 4096-char limit. Returns the array
 * of created message IDs (callers persist the first one as
 * `articles.telegram_message_id`).
 *
 * For multi-part series, parts 2..N reply to part 1 (`reply_to_message_id`)
 * so Telegram visually threads them together — readers see "↳ replying
 * to <article title>" on each follow-up. Link previews are only enabled
 * on part 1 to avoid duplicate cards across the series.
 */
export async function publishToTelegram(
  input: TelegramInput,
): Promise<TelegramOutput> {
  const parsed = telegramInputSchema.parse(input);
  const chatId = parsed.chatId ?? process.env.TELEGRAM_CHANNEL_ID;
  if (!chatId) {
    throw new Error(
      "TELEGRAM_CHANNEL_ID is not set and no chatId override was provided.",
    );
  }

  const api = getApi();
  const chunks = chunkForTelegram(parsed.text);
  const messageIds: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const msg = await api.sendMessage(chatId, chunks[i], {
      parse_mode: parsed.parseMode,
      link_preview_options: {
        is_disabled: parsed.disableLinkPreview || !isFirst,
      },
      reply_parameters: isFirst
        ? undefined
        : { message_id: messageIds[0], allow_sending_without_reply: true },
    });
    messageIds.push(msg.message_id);
  }

  return { chatId, messageIds };
}

/**
 * Vercel AI SDK tool descriptor. Pass into `tools: { telegram_publish }`
 * on `generateText` / `streamText` calls. Note: the orchestrator's MVP
 * keeps publishing behind a human-approval gate (HITL), so the agent
 * normally calls `save_draft` instead of this tool directly.
 */
export const telegramTool = tool({
  description:
    "Publish a message to a Telegram channel. The message is sent verbatim with the requested parse_mode; bodies longer than 4096 chars are split across multiple messages. Returns the IDs of created messages.",
  inputSchema: telegramInputSchema,
  execute: publishToTelegram,
});
