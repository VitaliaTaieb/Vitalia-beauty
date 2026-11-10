import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TIME_ZONE = "Asia/Jerusalem";
const ALLOWED_ORIGINS = new Set([
  "https://vitalia-beauty.com",
  "https://www.vitalia-beauty.com",
  "https://vitaliataieb.github.io",
]);
const ALLOWED_HOSTNAMES = new Set([
  "vitalia-beauty.com",
  "www.vitalia-beauty.com",
]);
const MAX_BODY_SIZE = 4096;

function headers(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function reply(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: headers(origin) });
}

function minuteOfDay(value: string | null): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(value);
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] ?? 0) !== 0) return null;
  return +m[1] * 60 + +m[2];
}

function israelParts(instant: Date): { date: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function parseStart(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):00(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= Date.now()) return null;
  const local = israelParts(d);
  if (local.date !== match[1] || local.minute !== Number(match[2]) * 60 + Number(match[3])) return null;
  return d;
}

async function validateTurnstile(token: unknown, secret: string, ip: string | null): Promise<boolean> {
  if (typeof token !== "string" || token.length < 10 || token.length > 2048) return false;
  const params = new URLSearchParams({ secret, response: token });
  if (ip) params.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Turnstile validation HTTP failure");
  const result = await response.json();
  return result?.success === true && ALLOWED_HOSTNAMES.has(result.hostname);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (req.method !== "POST") return reply({ error: "METHOD_NOT_ALLOWED" }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) return reply({ error: "ORIGIN_NOT_ALLOWED" }, 403, origin);

  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_SIZE) return reply({ error: "PAYLOAD_TOO_LARGE" }, 413, origin);
    const input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) return reply({ error: "INVALID_REQUEST" }, 400, origin);

    const salonId = input.salon_id;
    const serviceId = input.service_id;
    const clientName = typeof input.client_name === "string" ? input.client_name.trim() : "";
    const clientPhone = typeof input.client_phone === "string" ? input.client_phone.trim() : "";
    const start = parseStart(input.starts_at);
    const digits = clientPhone.replace(/\D/g, "");

    if (![1, 2].includes(salonId) || !Number.isSafeInteger(serviceId) || serviceId <= 0 ||
      clientName.length < 1 || clientName.length > 120 ||
      !/^[+0-9().\s-]{7,25}$/.test(clientPhone) || digits.length < 7 || digits.length > 15 || !start) {
      return reply({ error: "INVALID_BOOKING_DATA" }, 400, origin);
    }

    const dbUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const turnstileSecret = Deno.env.get("TURNSTILE_SECRET_KEY");
    if (!dbUrl || !serviceKey || !turnstileSecret) return reply({ error: "SERVER_NOT_CONFIGURED" }, 503, origin);

    const db = createClient(dbUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: service, error: serviceError } = await db.from("services")
      .select("*").eq("id", serviceId).maybeSingle();
    if (serviceError) {
      console.error("service", serviceError);
      return reply({ error: "SERVER_ERROR" }, 500, origin);
    }
    if (!service || Number(service["salon_id."]) !== salonId) return reply({ error: "SERVICE_NOT_FOUND" }, 404, origin);
    const duration = Number(service.duration_minutes);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 1440) return reply({ error: "INVALID_DURATION" }, 409, origin);

    const end = new Date(start.getTime() + duration * 60_000);
    const startLocal = israelParts(start);
    const endLocal = israelParts(end);
    if (endLocal.date !== startLocal.date || endLocal.minute <= startLocal.minute) {
      return reply({ error: "CROSS_DAY_BOOKING_NOT_SUPPORTED" }, 409, origin);
    }

    const [{ data: slots, error: slotsError }, { data: overrides, error: overrideError }] = await Promise.all([
      db.from("available_slots").select("start_time,end_time").eq("salon_id", salonId).eq("work_date", startLocal.date),
      db.from("schedule_overrides").select("is_closed,start_time,end_time").eq("salon_id", salonId).eq("override_date", startLocal.date),
    ]);
    if (slotsError || overrideError) {
      console.error("availability", slotsError ?? overrideError);
      return reply({ error: "SERVER_ERROR" }, 500, origin);
    }
    if ((overrides ?? []).some((entry) => entry.is_closed === true)) return reply({ error: "SALON_CLOSED" }, 409, origin);

    const inSlot = (slots ?? []).some((slot) => {
      const a = minuteOfDay(slot.start_time);
      const b = minuteOfDay(slot.end_time);
      return a !== null && b !== null && startLocal.minute >= a && endLocal.minute <= b;
    });
    if (!inSlot) return reply({ error: "SLOT_UNAVAILABLE" }, 409, origin);

    const timedOverrides = (overrides ?? []).filter((entry) =>
      entry.is_closed === false && (entry.start_time !== null || entry.end_time !== null));
    if (timedOverrides.length && !timedOverrides.some((entry) => {
      const a = minuteOfDay(entry.start_time);
      const b = minuteOfDay(entry.end_time);
      return a !== null && b !== null && startLocal.minute >= a && endLocal.minute <= b;
    })) return reply({ error: "OUTSIDE_OVERRIDE" }, 409, origin);

    // Turnstile verification is mandatory; invalid, expired or reused tokens are rejected.
    // Verify after all cheap checks to avoid consuming a single-use token unnecessarily.
    let verified = false;
    try {
      verified = await validateTurnstile(input.turnstile_token, turnstileSecret,
        req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null);
    } catch (error) {
      console.error("turnstile", error);
      return reply({ error: "CHALLENGE_UNAVAILABLE" }, 503, origin);
    }
    if (!verified) return reply({ error: "CHALLENGE_FAILED" }, 403, origin);

    const { data: existing, error: overlapError } = await db.from("appointments").select("id")
      .eq("status", "confirmed").lt("starts_at", end.toISOString())
      .gt("ends_at", start.toISOString()).limit(1);
    if (overlapError) {
      console.error("overlap", overlapError);
      return reply({ error: "SERVER_ERROR" }, 500, origin);
    }
    if (existing?.length) return reply({ error: "BOOKING_OVERLAP" }, 409, origin);

    // Existing database exclusion constraint appointment_no_overlap also handles races.
    const { data: booking, error: insertError } = await db.from("appointments")
      .insert({ salon_id: salonId, service_id: serviceId,
        client_name: clientName, client_phone: clientPhone,
        starts_at: start.toISOString(), ends_at: end.toISOString(), status: "confirmed" })
      .select("id,salon_id,service_id,starts_at,ends_at,status").single();
    if (insertError) {
      if (insertError.code === "23P01") return reply({ error: "BOOKING_OVERLAP" }, 409, origin);
      console.error("insert", insertError);
      return reply({ error: "BOOKING_CREATE_FAILED" }, 500, origin);
    }
    return reply({ booking }, 201, origin);
  } catch (error) {
    console.error("request", error);
    return reply({ error: "INVALID_REQUEST" }, 400, origin);
  }
});
