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

const TURNSTILE_HOSTNAMES = new Set(["vitalia-beauty.com", "www.vitalia-beauty.com"]);
async function verifyTurnstile(token: unknown, secret: string, ip: string | null): Promise<boolean> {
  if (typeof token !== "string" || token.length < 10 || token.length > 2048) return false;
  const params = new URLSearchParams({ secret, response: token });
  if (ip) params.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("TURNSTILE_HTTP_ERROR");
  const outcome = await res.json();
  return outcome.success === true && TURNSTILE_HOSTNAMES.has(outcome.hostname);
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
    const dbUrl = Deno.env.get("SUPABASE_URL");
    const legacyServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const secretDictionary = Deno.env.get("SUPABASE_SECRET_KEYS");
    let modernServiceKey: string | undefined;
    if (secretDictionary) {
      try {
        const keys = JSON.parse(secretDictionary);
        if (typeof keys.default === "string") modernServiceKey = keys.default;
      } catch {
        console.error("config", "SUPABASE_SECRET_KEYS is malformed JSON");
      }
    }
    const serviceKey = legacyServiceKey || modernServiceKey;
    const turnstileSecret = Deno.env.get("TURNSTILE_SECRET_KEY");
    if (!dbUrl || !serviceKey) {
      console.error("config", { missingUrl: !dbUrl, missingDbKey: !serviceKey, missingTurnstile: !turnstileSecret });
      return respond({ error: "SERVER_NOT_CONFIGURED" }, 503, origin);
    }
    // For sb_secret keys, only apikey is sent; the token is not a JWT.
    const keyIsModern = serviceKey.startsWith("sb_secret_");
    const db = createClient(dbUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(keyIsModern ? { global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        if (h.get("authorization")?.startsWith("Bearer sb_secret_")) h.delete("authorization");
        return fetch(input, { ...init, headers: h });
      } } } : {}),
    });

    if(data.action==='availability'){
      if(![1,2].includes(data.salon_id)||typeof data.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(data.date))return respond({error:'INVALID_REQUEST'},400,origin);
      const [overrides,holidays,busy]=await Promise.all([
        db.from('schedule_overrides').select('is_closed,start_time,end_time').eq('salon_id',data.salon_id).eq('override_date',data.date),
        db.from('booking_holidays').select('name_he').eq('holiday_date',data.date),
        db.from('appointments').select('starts_at,ends_at').eq('status','confirmed').gte('starts_at',data.date+'T00:00:00+03:00').lt('starts_at',data.date+'T23:59:59+02:00')
      ]);
      if(overrides.error||holidays.error||busy.error)return respond({error:'SERVER_ERROR'},500,origin);
      return respond({overrides:overrides.data,holiday:holidays.data?.[0]?.name_he||null,busy:busy.data},200,origin);
    }
    if(data.action==='my_booking'){
      if(typeof data.token!=='string'||! /^[a-f0-9]{64}$/.test(data.token))return respond({error:'NOT_FOUND'},404,origin);
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data.token)))).map(x=>x.toString(16).padStart(2,'0')).join('');
      const {data:booking,error}=await db.from('appointments').select('id,salon_id,service_id,starts_at,treatment_ends_at,status').eq('client_token_hash',hash).maybeSingle();
      if(error)return respond({error:'SERVER_ERROR'},500,origin);
      if(!booking)return respond({error:'NOT_FOUND'},404,origin);
      const [svc,salon]=await Promise.all([db.from('services').select('name,price').eq('id',booking.service_id).single(),db.from('salons').select('name,address').eq('id',booking.salon_id).single()]);
      if(svc.error||salon.error)return respond({error:'SERVER_ERROR'},500,origin);
      return respond({booking,service:svc.data,salon:salon.data},200,origin);
    }
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
    const { data: service, error: serviceError } = await db.from("services").select("*").eq("id", serviceId).maybeSingle();
    if (serviceError) {
      console.error("service", serviceError);
      return respond({ error: "SERVER_ERROR" }, 500, origin);
    }
    if (!service || service.import_only === true || Number(service["salon_id."]) !== salon) return respond({ error: "SERVICE_NOT_FOUND" }, 404, origin);
    const duration = Number(service.duration_minutes);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 1440) return respond({ error: "INVALID_DURATION" }, 409, origin);
    const afterMinutes = Number(service.break_after_minutes ?? 0);
    if (!Number.isInteger(afterMinutes) || afterMinutes < 0 || afterMinutes > 1440) return respond({ error: "INVALID_BREAK" }, 409, origin);
    // The reserved interval includes the selected service's post-treatment break.
    // Keeping ends_at as the reserved end also enforces the buffer via appointment_no_overlap.
    const end = new Date(start.getTime() + (duration + afterMinutes) * 60000);
    const localStart = localParts(start);
    const localEnd = localParts(end);
    if (localEnd.date !== localStart.date || localEnd.minute <= localStart.minute) return respond({ error: "CROSS_DAY_BOOKING_NOT_SUPPORTED" }, 409, origin);
    const [{ data: slots, error: slotError }, { data: overrides, error: overrideError }, { data: breaks, error: breakError }] = await Promise.all([
      db.from("available_slots").select("start_time,end_time").eq("salon_id", salon).eq("work_date", localStart.date),
      db.from("schedule_overrides").select("is_closed,start_time,end_time").eq("salon_id", salon).eq("override_date", localStart.date),
      db.from("schedule_breaks").select("start_time,end_time").eq("salon_id", salon).eq("work_date", localStart.date),
    ]);
    if (slotError || overrideError || breakError) {
      console.error("availability", slotError ?? overrideError ?? breakError);
      return respond({ error: "SERVER_ERROR" }, 500, origin);
    }
    if ((overrides ?? []).some((x) => x.is_closed === true)) return respond({ error: "SALON_CLOSED" }, 409, origin);
    const permitted = (slots ?? []).some((x) => {
      const a = minutes(x.start_time); const b = minutes(x.end_time);
      return a !== null && b !== null && localStart.minute >= a && localEnd.minute <= b;
    });
    if (!permitted) return respond({ error: "SLOT_UNAVAILABLE" }, 409, origin);
    if ((breaks ?? []).some((x) => {
      const a = minutes(x.start_time); const b = minutes(x.end_time);
      return a !== null && b !== null && localStart.minute < b && localEnd.minute > a;
    })) return respond({ error: "DURING_BREAK" }, 409, origin);
    const timed = (overrides ?? []).filter((x) => x.is_closed === false && (x.start_time !== null || x.end_time !== null));
    if (timed.length && !timed.some((x) => {
      const a = minutes(x.start_time); const b = minutes(x.end_time);
      return a !== null && b !== null && localStart.minute >= a && localEnd.minute <= b;
    })) return respond({ error: "OUTSIDE_OVERRIDE" }, 409, origin);
    const {data:holiday,error:holidayError}=await db.from('booking_holidays').select('name_he').eq('holiday_date',localStart.date).maybeSingle();
    if(holidayError)return respond({error:'SERVER_ERROR'},500,origin);
    if(holiday&&!(overrides??[]).some(x=>x.is_closed===false))return respond({error:'SALON_CLOSED'},409,origin);
    if(!turnstileSecret)return respond({error:'SERVER_NOT_CONFIGURED'},503,origin);
    // Never create a confirmed booking without a successful, single-use Turnstile challenge.
    let challengeValid = false;
    try {
      challengeValid = await verifyTurnstile(
        data.turnstile_token, turnstileSecret,
        req.headers.get("cf-connecting-ip") ?? null,
      );
    } catch (error) {
      console.error("turnstile", error);
      return respond({ error: "CHALLENGE_UNAVAILABLE" }, 503, origin);
    }
    if (!challengeValid) return respond({ error: "CHALLENGE_FAILED" }, 403, origin);
    const { data: existing, error: overlapError } = await db.from("appointments").select("id")
      .eq("status", "confirmed").lt("starts_at", end.toISOString()).gt("ends_at", start.toISOString()).limit(1);
    if (overlapError) {
      console.error("overlap", overlapError);
      return respond({ error: "SERVER_ERROR" }, 500, origin);
    }
    if (existing?.length) return respond({ error: "BOOKING_OVERLAP" }, 409, origin);
    const clientToken=Array.from(crypto.getRandomValues(new Uint8Array(32))).map(x=>x.toString(16).padStart(2,'0')).join('');
    const tokenHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(clientToken)))).map(x=>x.toString(16).padStart(2,'0')).join('');
    // Database exclusion constraint appointment_no_overlap protects against racing POSTs.
    const { data: booking, error: insertError } = await db.from("appointments")
      .insert({ whatsapp_opt_in:data.whatsapp_opt_in===true,client_token_hash:tokenHash,salon_id: salon, service_id: serviceId, client_name: clientName,
        client_phone: clientPhone, starts_at: start.toISOString(), ends_at: end.toISOString(), status: "confirmed" })
      .select("id,salon_id,service_id,starts_at,ends_at,status").single();
    if (insertError) {
      if (insertError.code === "23P01") return respond({ error: "BOOKING_OVERLAP" }, 409, origin);
      if(/SALON_CLOSED|SLOT_UNAVAILABLE|DURING_BREAK|OUTSIDE_OVERRIDE/.test(insertError.message))return respond({error:insertError.message},409,origin);
      console.error("insert", insertError);
      return respond({ error: "BOOKING_CREATE_FAILED" }, 500, origin);
    }
    return respond({ booking,client_token:clientToken }, 201, origin);
  } catch (err) {
    console.error("request", err);
    return respond({ error: "INVALID_REQUEST" }, 400, origin);
  }
});
