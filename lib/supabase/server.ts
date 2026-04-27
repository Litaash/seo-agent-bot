import "server-only";

import { cookies } from "next/headers";
import {
  createServerClient,
  type CookieOptions,
} from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}. Add it to .env.local.`,
    );
  }
  return value;
}

/**
 * Server-side Supabase client bound to the current request's cookies.
 *
 * Use in Server Components, Route Handlers, and Server Actions where the
 * caller is the dashboard user. Reads/writes go through the anon key and
 * are subject to RLS.
 *
 * Note: in Server Components Next.js does not allow mutating cookies, so
 * `setAll` may throw — we swallow that case. Session refreshes still work
 * because middleware (or Route Handlers / Server Actions) will refresh
 * cookies on the next mutation point.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options as CookieOptions);
            }
          } catch {
            // Called from a Server Component — safe to ignore if a
            // middleware refreshes the session.
          }
        },
      },
    },
  );
}

/**
 * Server-only admin client using the service_role key. Bypasses RLS.
 *
 * Use ONLY in trusted server contexts: agent orchestrator, cron handlers,
 * Telegram webhook handlers. NEVER expose this to the browser.
 */
export function createAdminClient() {
  return createSupabaseClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
