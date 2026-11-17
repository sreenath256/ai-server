-- Chitown Lifestyles booking schema.
-- Run this ONCE in your Supabase project's SQL Editor (Project -> SQL Editor -> New query -> paste -> Run).
--
-- gen_random_uuid() below needs the pgcrypto extension, which Supabase enables by default
-- on every new project, so no CREATE EXTENSION step is required here.

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  property_id text not null,
  check_in date not null,
  check_out date not null,                 -- exclusive: the last booked night is check_out - 1 day
  guest_name text not null,
  guest_email text not null,
  guest_phone text,
  guests_count int not null default 1,
  nights int not null,
  price_per_night numeric(10,2) not null,  -- server-computed snapshot at reservation time
  total_amount numeric(10,2) not null,     -- server-computed snapshot at reservation time
  currency text not null default 'USD',
  status text not null default 'pending_payment'
    check (status in ('pending_payment','confirmed','payment_failed','cancelled','expired')),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint check_out_after_check_in check (check_out > check_in)
);

create index bookings_property_idx on public.bookings (property_id);
create index bookings_status_idx on public.bookings (status);

-- One row per booked night. The UNIQUE constraint below is what actually prevents
-- two guests from ever booking the same night for the same property.
create table public.booked_dates (
  id bigint generated always as identity primary key,
  property_id text not null,
  stay_date date not null,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (property_id, stay_date)
);

create index booked_dates_property_idx on public.booked_dates (property_id, stay_date);

-- One booking can have multiple payment attempts (e.g. a declined card, then a retry).
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  provider text not null check (provider in ('stripe','paypal','godaddy')),
  provider_ref text,
  status text not null check (status in ('pending','succeeded','failed','refunded')),
  amount numeric(10,2) not null,
  currency text not null default 'USD',
  raw_response jsonb,
  created_at timestamptz not null default now(),
  constraint payments_provider_ref_key unique (provider, provider_ref)
);

create index payments_booking_idx on public.payments (booking_id);

-- Reserves a date range atomically: inserts the booking row, then one booked_dates
-- row per night in a single statement. If any night is already taken, the unique
-- constraint aborts the whole statement (and thus the whole function, since a
-- plpgsql function body runs as one transaction) -- nothing is left half-committed.
create or replace function public.reserve_booking(
  p_property_id text,
  p_check_in date,
  p_check_out date,
  p_guest_name text,
  p_guest_email text,
  p_guest_phone text,
  p_guests_count int,
  p_price_per_night numeric,
  p_total_amount numeric,
  p_currency text
) returns uuid
language plpgsql
as $$
declare
  v_booking_id uuid;
begin
  insert into public.bookings (
    property_id, check_in, check_out, guest_name, guest_email, guest_phone,
    guests_count, nights, price_per_night, total_amount, currency, status
  ) values (
    p_property_id, p_check_in, p_check_out, p_guest_name, p_guest_email, p_guest_phone,
    p_guests_count, (p_check_out - p_check_in), p_price_per_night, p_total_amount, p_currency,
    'pending_payment'
  ) returning id into v_booking_id;

  insert into public.booked_dates (property_id, stay_date, booking_id)
  select p_property_id, d::date, v_booking_id
  from generate_series(p_check_in, p_check_out - interval '1 day', interval '1 day') as d;

  return v_booking_id;
end;
$$;

-- Frees a booking's dates back up. Used when a payment fails or a reservation expires.
create or replace function public.release_booking(p_booking_id uuid)
returns void
language plpgsql
as $$
begin
  delete from public.booked_dates where booking_id = p_booking_id;
  update public.bookings set status = 'payment_failed', updated_at = now()
    where id = p_booking_id;
end;
$$;

-- Marks a booking confirmed after a successful payment capture.
create or replace function public.confirm_booking(p_booking_id uuid)
returns void
language plpgsql
as $$
begin
  update public.bookings set status = 'confirmed', updated_at = now()
    where id = p_booking_id;
end;
$$;

-- Sweeps reservations a guest abandoned without paying, so their dates don't stay
-- locked forever. Called lazily at the top of the booked-dates and quote endpoints
-- rather than via a cron job.
create or replace function public.release_expired_bookings()
returns void
language plpgsql
as $$
begin
  delete from public.booked_dates where booking_id in (
    select id from public.bookings where status = 'pending_payment' and expires_at < now()
  );
  update public.bookings set status = 'expired', updated_at = now()
    where status = 'pending_payment' and expires_at < now();
end;
$$;

-- The backend only ever talks to these tables using the service_role key, which
-- bypasses RLS entirely. Enabling RLS with zero policies here is defense-in-depth
-- in case an anon/public key is ever accidentally exposed.
alter table public.bookings enable row level security;
alter table public.booked_dates enable row level security;
alter table public.payments enable row level security;
