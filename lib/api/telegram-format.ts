import "server-only";

/**
 * Convert the Markdown body produced by the content-generator subagent
 * into a Telegram-safe HTML payload.
 *
 * Why HTML and not MarkdownV2: Telegram's MarkdownV2 requires every
 * occurrence of `_*[]()~`>#+-=|{}.!\` outside markup to be escaped.
 * That's brittle when the source is auto-generated prose. HTML mode
 * accepts a small whitelist of tags (`b`, `i`, `u`, `s`, `code`, `pre`,
 * `a`, `blockquote`, `tg-spoiler`) and only requires `<`, `>`, `&` to
 * be entity-encoded — much easier to keep correct.
 *
 * Conversions handled:
 *   - `# H1` / `## H2` / `### H3`        → `<b>...</b>` on its own line
 *   - `**bold**`                         → `<b>bold</b>`
 *   - `*italic*` / `_italic_`            → `<i>italic</i>`
 *   - `\`code\``                         → `<code>code</code>`
 *   - `[label](url)`                     → `<a href="url">label</a>`
 *   - `- item` / `* item` / `1. item`    → `• item`
 *   - Everything else                    → entity-escaped plain text
 *
 * Anything fancier (tables, footnotes, images, fenced code blocks with
 * language hints) degrades gracefully — fenced blocks become `<pre>`,
 * tables become plain text rows, images become their alt text.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];

  let inFence = false;
  let fenceBuffer: string[] = [];

  for (const raw of lines) {
    // ---- fenced code blocks ------------------------------------------
    if (raw.startsWith("```")) {
      if (inFence) {
        // Close fence: emit accumulated lines as a single <pre> block.
        out.push(`<pre>${escapeHtml(fenceBuffer.join("\n"))}</pre>`);
        fenceBuffer = [];
        inFence = false;
      } else {
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fenceBuffer.push(raw);
      continue;
    }

    // ---- headings (H1 / H2 / H3 collapse to bold) --------------------
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(`<b>${transformInline(heading[1])}</b>`);
      continue;
    }

    // ---- bullet / numbered lists -------------------------------------
    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      out.push(`• ${transformInline(bullet[1])}`);
      continue;
    }
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(raw);
    if (numbered) {
      out.push(`• ${transformInline(numbered[1])}`);
      continue;
    }

    // ---- horizontal rule ---------------------------------------------
    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) {
      out.push("—");
      continue;
    }

    // ---- regular paragraph / blank line ------------------------------
    if (raw.trim() === "") {
      out.push("");
    } else {
      out.push(transformInline(raw));
    }
  }

  // Close an unterminated code fence defensively.
  if (inFence && fenceBuffer.length > 0) {
    out.push(`<pre>${escapeHtml(fenceBuffer.join("\n"))}</pre>`);
  }

  // Collapse 3+ blank lines that pile up around headings.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * HTML-entity-encode the three characters Telegram reserves for tag
 * parsing. We do NOT escape `'` or `"` — Telegram's HTML parser is
 * lenient and any quote inside text content is fine.
 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return ch;
    }
  });
}

/**
 * Apply inline markdown→HTML transforms in a single line of body text.
 *
 * Order matters:
 *   1. Escape HTML entities first so user-supplied `<script>` is inert.
 *   2. Inline code (`backticks`) — done before italic/bold so a code
 *      span like `*not_italic*` stays literal.
 *   3. Bold (`**`) before italic (`*`/`_`) — `**foo**` would otherwise
 *      be parsed as italic-italic.
 *   4. Markdown links `[text](url)` — only http(s) URLs are passed
 *      through; anything else is rendered as plain text to block
 *      `javascript:` injection through the bot.
 */
function transformInline(line: string): string {
  let s = escapeHtml(line);

  // Inline code first; replace runs of backticks. Use a placeholder so
  // later passes don't touch its contents.
  const codePlaceholders: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, body) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(`<code>${body}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  // Bold (**...** or __...__).
  s = s.replace(/\*\*([^\n*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^\n_]+)__/g, "<b>$1</b>");

  // Italic (*...* or _..._). Avoid grabbing across asterisks already
  // consumed by the bold pass (the negated character class handles it).
  s = s.replace(/(^|[\s(])\*([^\n*]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/(^|[\s(])_([^\n_]+)_/g, "$1<i>$2</i>");

  // Links — accept http(s) only.
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
  );
  // Strip any other link forms (e.g. `javascript:`) down to the label.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Restore code placeholders.
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, n) => {
    const idx = Number(n);
    return codePlaceholders[idx] ?? "";
  });

  return s;
}

/**
 * Build the final Telegram body for an approved article.
 *
 * The article's H1 is already inside `content_md` per the
 * content-generator's contract, so we don't prepend the title again.
 * `keywords` are appended as a single italic line at the bottom so the
 * Telegram audience can see what the article is targeting; this mirrors
 * the "tags" line common to publishing platforms.
 */
export function formatArticleForTelegram(
  contentMd: string,
  keywords: readonly string[],
): string {
  const body = markdownToTelegramHtml(contentMd);
  const tags = keywords
    .filter((k) => k.trim().length > 0)
    .map((k) => `#${k.replace(/\s+/g, "_")}`)
    .join(" ");

  if (!tags) return body;
  return `${body}\n\n<i>${escapeHtml(tags)}</i>`;
}
