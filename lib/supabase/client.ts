"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client. Uses the public anon key and is safe to
 * call from Client Components.
 *
 * RLS protects the `public` tables — without auth in MVP the anon role
 * has no policies, so reads/writes from the browser are blocked. The
 * dashboard reads data through Server Components / Route Handlers that
 * use the service_role key on the server.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Add them to .env.local.",
    );
  }

  return createBrowserClient(url, key);
}
