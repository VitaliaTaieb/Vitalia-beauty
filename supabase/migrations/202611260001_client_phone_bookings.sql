begin;

-- Normalize Israeli local numbers and explicit international numbers for exact matching.
create or replace function public.vitalia_normalize_booking_phone(value text)
returns text language sql immutable strict set search_path = '' as $$
  with normalized as (
    select regexp_replace(trim(value), '[[:space:]().-]', '', 'g') as number
  )
  select case
    when number ~ '^0[23489][0-9]{7}$' or number ~ '^0[57][0-9]{8}$' then '+972' || substr(number, 2)
    when number ~ '^(\+|00)?9720?([23489][0-9]{7}|[57][0-9]{8})
    when number ~ '^\+972' or number ~ '^00972' then null
    when number ~ '^\+[1-9][0-9]{7,14}$' then number
    when number ~ '^00[1-9][0-9]{7,14}$' then '+' || substr(number, 3)
  end from normalized;
$$;
revoke all on function public.vitalia_normalize_booking_phone(text) from public, anon, authenticated;

create or replace function public.vitalia_my_phone_bookings()
returns table (
  starts_at timestamptz, treatment_ends_at timestamptz, status text,
  service_name text, salon_name text, salon_address text
)
language plpgsql stable security definer set search_path = '' as $$
declare verified_phone text;
begin
  -- Read the authoritative phone from Auth, never from caller input or editable metadata.
  select public.vitalia_normalize_booking_phone('+' || ltrim(u.phone, '+'))
  into verified_phone
  from auth.users u
  where u.id = auth.uid() and u.phone_confirmed_at is not null
    and exists (
      select 1
      from jsonb_array_elements(coalesce(auth.jwt()->'amr', '[]'::jsonb)) as a
      where a->>'method' = 'otp'
    );

  if verified_phone is null then
    raise exception using errcode = '42501', message = 'PHONE_VERIFICATION_REQUIRED';
  end if;

  return query
  select a.starts_at, a.treatment_ends_at, a.status, s.name, l.name, l.address
  from public.appointments a
  join public.services s on s.id = a.service_id
  join public.salons l on l.id = a.salon_id
  where public.vitalia_normalize_booking_phone(a.client_phone) = verified_phone
  order by (a.starts_at >= now()) desc,
    case when a.starts_at >= now() then a.starts_at end,
    a.starts_at desc;
end;
$$;
revoke all on function public.vitalia_my_phone_bookings() from public, anon, authenticated;
grant execute on function public.vitalia_my_phone_bookings() to authenticated;

commit;
 then
      '+972' || regexp_replace(number, '^(\+|00)?9720?', '')
    when number ~ '^\+972' or number ~ '^00972' then null
    when number ~ '^\+[1-9][0-9]{7,14}$' then number
    when number ~ '^00[1-9][0-9]{7,14}$' then '+' || substr(number, 3)
  end from normalized;
$$;
revoke all on function public.vitalia_normalize_booking_phone(text) from public, anon, authenticated;

create or replace function public.vitalia_my_phone_bookings()
returns table (
  starts_at timestamptz, treatment_ends_at timestamptz, status text,
  service_name text, salon_name text, salon_address text
)
language plpgsql stable security definer set search_path = '' as $$
declare verified_phone text;
begin
  -- Read the authoritative phone from Auth, never from caller input or editable metadata.
  select public.vitalia_normalize_booking_phone('+' || ltrim(u.phone, '+'))
  into verified_phone
  from auth.users u
  where u.id = auth.uid() and u.phone_confirmed_at is not null
    and exists (
      select 1
      from jsonb_array_elements(coalesce(auth.jwt()->'amr', '[]'::jsonb)) as a
      where a->>'method' = 'otp'
    );

  if verified_phone is null then
    raise exception using errcode = '42501', message = 'PHONE_VERIFICATION_REQUIRED';
  end if;

  return query
  select a.starts_at, a.treatment_ends_at, a.status, s.name, l.name, l.address
  from public.appointments a
  join public.services s on s.id = a.service_id
  join public.salons l on l.id = a.salon_id
  where public.vitalia_normalize_booking_phone(a.client_phone) = verified_phone
  order by (a.starts_at >= now()) desc,
    case when a.starts_at >= now() then a.starts_at end,
    a.starts_at desc;
end;
$$;
revoke all on function public.vitalia_my_phone_bookings() from public, anon, authenticated;
grant execute on function public.vitalia_my_phone_bookings() to authenticated;

commit;
