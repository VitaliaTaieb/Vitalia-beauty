import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGINS = new Set(["https://vitalia-beauty.com", "https://www.vitalia-beauty.com", "https://vitaliataieb.github.io"]);
function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ORIGINS.has(origin) ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function reply(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), { status, headers: cors(origin) });
}
function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + "T12:00:00Z")) &&
    new Date(value + "T12:00:00Z").toISOString().slice(0,10) === value;
}
function clock(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function dbClient(url: string, secret: string) {
  return createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false },
    ...(secret.startsWith("sb_secret_") ? { global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get("authorization")?.startsWith("Bearer sb_secret_")) headers.delete("authorization");
      return fetch(input, { ...init, headers });
    } } } : {}) });
}
Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return reply({ error: "METHOD" }, 405, origin);
  if (origin && !ORIGINS.has(origin)) return reply({ error: "ORIGIN" }, 403, origin);
  const url = Deno.env.get("SUPABASE_URL");
  const publishable = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || (() => {
    try { return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default; } catch { return null; }
  })();
  if (!url || !publishable || !secret) {
    console.error("Admin configuration incomplete");
    return reply({ error: "SERVER_CONFIG" }, 503, origin);
  }
  const bearer = req.headers.get("authorization") || "";
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(bearer)) return reply({ error: "LOGIN_REQUIRED" }, 401, origin);
  const auth = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: authError } = await auth.auth.getUser(bearer.slice(7));
  if (authError || !user || user.app_metadata?.role !== "vitalia_admin") {
    return reply({ error: "ADMIN_ACCESS_REQUIRED" }, 403, origin);
  }
  let input: any;
  try {
    const raw = await req.text();
    if (raw.length > 4096) return reply({ error: "TOO_LARGE" }, 413, origin);
    input = JSON.parse(raw);
  } catch { return reply({ error: "INVALID_JSON" }, 400, origin); }
  const salon = input?.salon_id;
  if (!Number.isInteger(salon) || ![1, 2].includes(salon)) return reply({ error: "SALON" }, 400, origin);
  const db = dbClient(url, secret);
  try {
    if (input.action === 'save_service') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 200 || typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price < 0 || input.price > 100000 ||
          !Number.isInteger(input.duration_minutes) || input.duration_minutes < 5 || input.duration_minutes > 720 ||
          !Number.isInteger(input.break_after_minutes) || input.break_after_minutes < 0 || input.break_after_minutes > 240 ||
          (input.id !== null && (!Number.isSafeInteger(input.id) || input.id < 1))) return reply({error:'INVALID_SERVICE'},400,origin);
      const values = {name,price:input.price,duration_minutes:input.duration_minutes,break_after_minutes:input.break_after_minutes};
      if(input.id!==null){
        const {data:existing,error:readError}=await db.from('services').select('*').eq('id',input.id).maybeSingle();
        if(readError)throw readError;
        if(!existing||Number(existing['salon_id.'])!==salon)return reply({error:'SERVICE_NOT_FOUND'},404,origin);
      }
      // Never move a procedure between salons or alter existing appointment times.
      const operation = input.id === null
        ? db.from('services').insert({...values,'salon_id.':salon})
        : db.from('services').update(values).eq('id',input.id);
      const {data,error} = await operation.select('id').maybeSingle();
      if(error)throw error;
      if(!data)return reply({error:'SERVICE_NOT_FOUND'},404,origin);
      return reply({saved:true,id:data.id},input.id===null?201:200,origin);
    }
    if(input.action==='calendar'){
      if(typeof input.month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)||![0,1,2].includes(input.filter))return reply({error:'INVALID_MONTH'},400,origin);
      const [y,m]=input.month.split('-').map(Number),start=input.month+'-01',next=new Date(Date.UTC(y,m,1)).toISOString().slice(0,10);
      let b=db.from('appointments').select('id,salon_id,service_id,client_name,client_phone,starts_at,ends_at,treatment_ends_at,status').gte('starts_at',start+'T00:00:00+03:00').lt('starts_at',next+'T00:00:00+03:00').order('starts_at').limit(3000);
      let sl=db.from('available_slots').select('salon_id,work_date,start_time,end_time').gte('work_date',start).lt('work_date',next).limit(3000);
      if(input.filter){b=b.eq('salon_id',input.filter);sl=sl.eq('salon_id',input.filter);}
      const [bookings,slots,holidays,services]=await Promise.all([b,sl,db.from('booking_holidays').select('*').gte('holiday_date',start).lt('holiday_date',next),db.from('services').select('id,name')]);
      if(bookings.error||slots.error||holidays.error||services.error)throw bookings.error||slots.error||holidays.error||services.error;
      return reply({bookings:(bookings.data||[]).map(x=>({...x,service_name:services.data?.find(s=>s.id===x.service_id)?.name})),slots:slots.data,holidays:holidays.data},200,origin);
    }
    if(input.action==='cancel_booking'){
      if(!Number.isSafeInteger(input.id)||input.id<1)return reply({error:'INVALID_ID'},400,origin);
      const {data,error}=await db.from('appointments').update({status:'cancelled'}).eq('id',input.id).select('id').maybeSingle();
      if(error)throw error;if(!data)return reply({error:'NOT_FOUND'},404,origin);return reply({saved:true},200,origin);
    }
    if (input.action === "list") {
      const [slots, bookings, overrides, breaks, services] = await Promise.all([
        db.from("available_slots").select("id,salon_id,work_date,start_time,end_time").eq("salon_id", salon).order("work_date", { ascending: true }).limit(500),
        db.from("appointments").select("id,client_name,client_phone,service_id,starts_at,ends_at,status").eq("salon_id", salon).gte("starts_at", new Date(Date.now()-86400000).toISOString()).order("starts_at", { ascending: true }).limit(500),
        db.from("schedule_overrides").select("id,override_date,is_closed,note").eq("salon_id", salon).order("override_date", { ascending: true }).limit(500),
        db.from("schedule_breaks").select("id,work_date,start_time,end_time").eq("salon_id", salon).order("work_date", { ascending: true }).limit(500),
        db.from("services").select("*").order("name", { ascending: true }).limit(500),
      ]);
      if (slots.error || bookings.error || overrides.error || breaks.error || services.error) throw slots.error || bookings.error || overrides.error || breaks.error || services.error;
      return reply({ slots: slots.data, bookings: bookings.data, overrides: overrides.data, breaks: breaks.data, services: (services.data || []).filter((s) => Number(s["salon_id."]) === salon) }, 200, origin);
    }
    if (input.action === "add_slot") {
      if (!validDate(input.date) || !clock(input.start) || !clock(input.end) || input.end <= input.start) {
        return reply({ error: "INVALID_SLOT" }, 400, origin);
      }
      const { data, error } = await db.from("available_slots").insert({
        salon_id: salon, work_date: input.date, start_time: input.start, end_time: input.end,
      }).select("id").single();
      if (error) throw error;
      return reply({ saved: true, id: data.id }, 201, origin);
    }
    if (input.action === "delete_slot") {
      if (!Number.isSafeInteger(input.id) || input.id < 1) return reply({ error: "INVALID_ID" }, 400, origin);
      const { error } = await db.from("available_slots").delete().eq("salon_id", salon).eq("id", input.id);
      if (error) throw error;
      return reply({ saved: true }, 200, origin);
    }

    if (input.action === "add_break") {
      if (!validDate(input.date) || !clock(input.start) || !clock(input.end) || input.end <= input.start) {
        return reply({ error: "INVALID_BREAK" }, 400, origin);
      }
      // A new break must not silently invalidate an already confirmed appointment.
      const from = input.date + "T00:00:00+02:00";
      const to = new Date(new Date(input.date + "T00:00:00+02:00").getTime() + 27*60*60*1000).toISOString();
      const { data: booked, error: bookingError } = await db.from("appointments")
        .select("starts_at,ends_at").eq("salon_id", salon).eq("status", "confirmed")
        .lt("starts_at", to).gt("ends_at", from);
      if (bookingError) throw bookingError;
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      });
      const part = (iso: string) => {
        const values = formatter.formatToParts(new Date(iso));
        const get = (name: string) => values.find((x) => x.type === name)?.value || "";
        return { date: get("year") + "-" + get("month") + "-" + get("day"),
          time: get("hour") + ":" + get("minute") };
      };
      if ((booked || []).some((x) => {
        const start = part(x.starts_at), end = part(x.ends_at);
        return start.date === input.date && start.time < input.end &&
          (end.date > input.date || end.time > input.start);
      })) return reply({ error: "BREAK_OVERLAPS_BOOKING" }, 409, origin);
      const { data, error } = await db.from("schedule_breaks").insert({
        salon_id: salon, work_date: input.date, start_time: input.start, end_time: input.end
      }).select("id").single();
      if (error) throw error;
      return reply({ saved: true, id: data.id }, 201, origin);
    }
    if (input.action === "delete_break") {
      if (!Number.isSafeInteger(input.id) || input.id < 1) return reply({ error: "INVALID_ID" }, 400, origin);
      const { error } = await db.from("schedule_breaks").delete().eq("salon_id", salon).eq("id", input.id);
      if (error) throw error;
      return reply({ saved: true }, 200, origin);
    }
    if (input.action === "set_service_break") {
      if (!Number.isSafeInteger(input.service_id) || input.service_id < 1 ||
          !Number.isInteger(input.minutes) || input.minutes < 0 || input.minutes > 240) {
        return reply({ error: "INVALID_SERVICE_BREAK" }, 400, origin);
      }
      const { data: existingService, error: readError } = await db.from("services").select("*").eq("id", input.service_id).maybeSingle();
      if (readError) throw readError;
      if (!existingService || Number(existingService["salon_id."]) !== salon) return reply({ error: "SERVICE_NOT_FOUND" }, 404, origin);
      const { data, error } = await db.from("services").update({
        break_after_minutes: input.minutes
      }).eq("id", input.service_id).select("id").maybeSingle();
      if (error) throw error;
      if (!data) return reply({ error: "SERVICE_NOT_FOUND" }, 404, origin);
      return reply({ saved: true }, 200, origin);
    }
    if (input.action === "close_date") {
      if (!validDate(input.date) || typeof input.closed !== "boolean") return reply({ error: "INVALID_DATE" }, 400, origin);
      const { error } = await db.from("schedule_overrides").upsert({
        salon_id: salon, override_date: input.date, is_closed: input.closed, start_time:input.closed?null:"00:00",end_time:input.closed?null:"23:59", note: input.closed ? "Manual closure" : "Manual opening",
      },{onConflict:'salon_id,override_date'});
      if (error) throw error;
      return reply({ saved: true }, 200, origin);
    }
    return reply({ error: "UNKNOWN_ACTION" }, 400, origin);
  } catch (e) {
    console.error("admin-data-operation", e);
    return reply({ error: "SERVER_ERROR" }, 500, origin);
  }
});
