import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TZ = "Asia/Jerusalem";
const ALLOWED_ORIGINS = new Set([
  "https://vitalia-beauty.com",
  "https://www.vitalia-beauty.com",
  "https://vitaliataieb.github.io",
]);
const MAX_BODY_SIZE = 4096;

function headers(origin: string | null): HeadersInit {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}
function respond(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: headers(origin) });
}
function minutes(t: string | null): number | null {
  if (typeof t !== "string") return null;
  const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(t);
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] ?? 0) !== 0) return null;
  return +m[1] * 60 + +m[2];
}
function localParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`,
    minute: Number(get("hour")) * 60 + Number(get("minute")) };
}
function parseStart(input: unknown): Date | null {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) return null;
  const d = new Date(input);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= Date.now()) return null;
  // Reject an invalid offset/local date, including offset changes on DST dates.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):00/.exec(input);
  const local = localParts(d);
  if (!m || local.date !== m[1] || local.minute !== +m[2] * 60 + +m[3]) return null;
  return d;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (req.method !== "POST") return respond({ error: "METHOD_NOT_ALLOWED" }, 405, origin);
  // Browser origin check is not authentication, but prevents unapproved sites
  // from using this browser-accessible endpoint. Server-side abuse protection
  // (rate limiting / CAPTCHA) must be added before broad public launch.
  if (origin && !ALLOWED_ORIGINS.has(origin)) return respond({ error: "ORIGIN_NOT_ALLOWED" }, 403, origin);
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_SIZE) return respond({ error: "PAYLOAD_TOO_LARGE" }, 413, origin);
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return respond({ error: "INVALID_REQUEST" }, 400, origin);
    const salon = data.salon_id;
    const serviceId = data.service_id;
    const clientName = typeof data.client_name === "string" ? data.client_name.trim() : "";
    const clientPhone = typeof data.client_phone === "string" ? data.client_phone.trim() : "";
    const start = parseStart(data.starts_at);
    if (![1, 2].includes(salon) || !Number.isSafeInteger(serviceId) || serviceId <= 0 ||
      clientName.length < 1 || clientName.length > 120 ||
      !/^[+0-9().\s-]{7,25}$/.test(clientPhone) ||
      clientPhone.replace(/\D/g, "").length < 7 || clientPhone.replace(/\D/g, "").length > 15 || !start) {
      return respond({ error: "INVALID_BOOKING_DATA" }, 400, origin);
    }
    const dbUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!dbUrl || !serviceKey) return respond({ error: "SERVER_NOT_CONFIGURED" }, 500, origin);
    const db = createClient(dbUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: service, error: serviceError } = await db.from("services").select("id,duration_minutes,\"salon_id.\"").eq("id", serviceId).maybeSingle();
    if (serviceError) {
      console.error("service", serviceError);
      return respond({ error: "SERVER_ERROR" }, 500, origin);
    }
    if (!service || Number(service["salon_id."]) !== salon) return respond({ error: "SERVICE_NOT_FOUND" }, 404, origin);
    const duration = Number(service.duration_minutes);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 1440) return respond({ error: "INVALID_DURATION" }, 409, origin);
    const end = new Date(start.getTime() + duration * 60000);
    const localStart = localParts(start);
    const localEnd = localParts(end);
    if (localEnd.date !== localStart.date || localEnd.minute <= localStart.minute) return respond({ error: "CROSS_DAY_BOOKING_NOT_SUPPORTED" }, 409, origin);
    const [{ data: slots, error: slotError }, { data: overrides, error: overrideError }] = await Promise.all([
      db.from("available_slots").select("start_time,end_time").eq("salon_id", salon).eq("work_date", localStart.date),
      db.from("schedule_overrides").select("is_closed,start_time,end_time").eq("salon_id", salon).eq("override_date", localStart.date),
    ]);
    if (slotError || overrideError) {
      console.error("availability", slotError ?? overrideError);
      return respond({ error: "SERVER_ERROR" }, 500, origin);
    }
    if ((overrides ?? []).some((x) => x.is_closed === true)) return respond({ error: "SALON_CLOSED" }, 409, origin);
    const permitted = (slots ?? []).some((x) => {
      const a = minutes(x.start_time); const b = minutes(x.end_time);
      return a !== null && b !== null && localStart.minute >= a && localEnd.minute <= b;
    });
    if (!permitted) return respond({ error: "SLOT_UNAVAILABLE" }, 409, origin);
    const timed = (overrides ?? []).filter((x) => x.is_closed === false && (x.start_time !== null || x.end_time !== null));
    if (timed.length && !timed.some((x) => {
      const a = minutes(x.start_time); const b = minutes(x.end_time);
      return a !== null && b !== null && localStart.minute >= a && localEnd.minute <= b;
    })) return respond({ error: "OUTSIDE_OVERRIDE" }, 409, origin);
    const { data: existing, error: overlapError } = await db.from("appointments").select("id")
      .eq("status", "confirmed").lt("starts_at", end.toISOString()).gt("ends_at", start.toISOString()).limit(1);
    if (overlapError) {
      console.error("overlap", overlapError);
      return respond({ error: "SERVER_ERROR" }, 500, origin);
    }
    if (existing?.length) return respond({ error: "BOOKING_OVERLAP" }, 409, origin);
    // Database exclusion constraint appointment_no_overlap protects against racing POSTs.
    const { data: booking, error: insertError } = await db.from("appointments")
      .insert({ salon_id: salon, service_id: serviceId, client_name: clientName,
        client_phone: clientPhone, starts_at: start.toISOString(), ends_at: end.toISOString(), status: "confirmed" })
      .select("id,salon_id,service_id,starts_at,ends_at,status").single();
    if (insertError) {
      if (insertError.code === "23P01") return respond({ error: "BOOKING_OVERLAP" }, 409, origin);
      console.error("insert", insertError);
      return respond({ error: "BOOKING_CREATE_FAILED" }, 500, origin);
    }
    return respond({ booking }, 201, origin);
  } catch (err) {
    console.error("request", err);
    return respond({ error: "INVALID_REQUEST" }, 400, origin);
  }
});
