"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * "Start a new run" form. Renders the topic + a few optional knobs
 * (geo / hl / target language / editorial voice) and POSTs to
 * `/api/agent/run`.
 *
 * The route streams Server-Sent Events. We don't keep the stream open
 * for the entire run — as soon as we see the first `task_status` event
 * (which carries the new task id), we navigate to `/tasks/[id]`. The
 * task page re-attaches via `GET /api/tasks/[id]/stream` so the user
 * sees the live log without missing events.
 *
 * Why client-side fetch + manual SSE parsing instead of `EventSource`:
 *   - `EventSource` is GET-only; the run endpoint is POST.
 *   - `useFormStatus` from `react-dom` doesn't expose the response body
 *     mid-flight, which we need to read the first frame.
 */
const RUN_ENDPOINT = "/api/agent/run";

interface NewTaskFormProps {
  /** Optional CSS class so the form can fit different containers. */
  className?: string;
}

interface ParsedFrame {
  event: string;
  data: unknown;
}

export function NewTaskForm({ className }: NewTaskFormProps) {
  const router = useRouter();
  const [topic, setTopic] = React.useState("");
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [geo, setGeo] = React.useState("");
  const [hl, setHl] = React.useState("");
  const [language, setLanguage] = React.useState("");
  const [voice, setVoice] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const trimmed = topic.trim();
    if (trimmed.length < 2) {
      setError("Topic must be at least 2 characters.");
      return;
    }

    setError(null);
    setPending(true);
    const controller = new AbortController();

    try {
      const body: Record<string, string> = { topic: trimmed };
      if (geo.trim()) body.geo = geo.trim();
      if (hl.trim()) body.hl = hl.trim();
      if (language.trim()) body.language = language.trim();
      if (voice.trim()) body.voice = voice.trim();

      const res = await fetch(RUN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errBody = await res.text().catch(() => "");
        throw new Error(
          errBody || `Run endpoint failed with HTTP ${res.status}`,
        );
      }

      // Read SSE frames until we see a `task_status` carrying the new
      // taskId, then navigate. The orchestrator keeps running on the
      // server even after we cancel the fetch.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let navigated = false;

      while (!navigated) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separatorIdx = buffer.indexOf("\n\n");
        while (separatorIdx !== -1) {
          const rawFrame = buffer.slice(0, separatorIdx);
          buffer = buffer.slice(separatorIdx + 2);
          const frame = parseSseFrame(rawFrame);
          if (frame?.event === "task_status") {
            const id = (frame.data as { taskId?: string } | null)?.taskId;
            if (id) {
              navigated = true;
              controller.abort();
              router.push(`/tasks/${id}`);
              router.refresh();
              break;
            }
          }
          if (frame?.event === "error") {
            const msg =
              (frame.data as { message?: string } | null)?.message ??
              "Unknown error.";
            throw new Error(msg);
          }
          separatorIdx = buffer.indexOf("\n\n");
        }
      }

      if (!navigated) {
        throw new Error(
          "Stream closed before a task id arrived. Try again or check server logs.",
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className={cn(
        "flex flex-col gap-4 rounded-xl border bg-card p-4 ring-1 ring-foreground/5",
        className,
      )}
    >
      <div className="flex flex-col gap-2">
        <label
          htmlFor="topic"
          className="text-sm font-medium text-foreground"
        >
          New task
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="topic"
            name="topic"
            placeholder="e.g. Best running shoes for flat feet 2026"
            value={topic}
            onChange={(e) => setTopic(e.currentTarget.value)}
            disabled={pending}
            autoComplete="off"
            autoFocus
            className="sm:flex-1"
          />
          <Button type="submit" disabled={pending || topic.trim().length < 2}>
            {pending ? "Starting…" : "Run agent"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The agent runs research → generate → save_draft and stops at the
          human-approval gate. Costs about $0.03 per topic.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="self-start text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {advancedOpen ? "Hide advanced options" : "Show advanced options"}
        </button>
        {advancedOpen && (
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-dashed border-border/60 p-3 sm:grid-cols-2">
            <LabeledInput
              id="geo"
              label="Geo (Trends)"
              placeholder="US"
              value={geo}
              onChange={setGeo}
              disabled={pending}
              hint="ISO country code for Google Trends. Defaults to US."
            />
            <LabeledInput
              id="hl"
              label="UI language"
              placeholder="en-US"
              value={hl}
              onChange={setHl}
              disabled={pending}
              hint="hl= parameter for Trends. Defaults to en-US."
            />
            <LabeledInput
              id="language"
              label="Article language"
              placeholder="English"
              value={language}
              onChange={setLanguage}
              disabled={pending}
              hint="Generator writes in this language. Defaults to English."
            />
            <LabeledInput
              id="voice"
              label="Editorial voice"
              placeholder="Friendly, concise"
              value={voice}
              onChange={setVoice}
              disabled={pending}
              hint="Optional override for the content generator's tone."
            />
          </div>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </form>
  );
}

function LabeledInput({
  id,
  label,
  placeholder,
  value,
  onChange,
  disabled,
  hint,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </label>
      <Input
        id={id}
        name={id}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        disabled={disabled}
        autoComplete="off"
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Parse a single SSE frame (one or more lines, no trailing blank lines).
 * Tolerates `data:` over multiple lines and missing `event:` (defaults to
 * `message`).
 */
function parseSseFrame(raw: string): ParsedFrame | null {
  const lines = raw.split(/\r?\n/);
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join("\n");
  let data: unknown = dataStr;
  try {
    data = JSON.parse(dataStr);
  } catch {
    // Leave as raw string for non-JSON events.
  }
  return { event: eventName ?? "message", data };
}
