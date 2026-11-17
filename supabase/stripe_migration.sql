-- Run ONCE in your Supabase project's SQL Editor (existing project that already ran schema.sql).
-- Lets the payments table record Stripe payments and stops the same payment being stored twice.

do $$
declare
  existing_check text;
begin
  select conname into existing_check
  from pg_constraint
  where conrelid = 'public.payments'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%provider%';

  if existing_check is not null then
    execute format('alter table public.payments drop constraint %I', existing_check);
  end if;

  alter table public.payments
    add constraint payments_provider_check check (provider in ('stripe', 'paypal', 'godaddy'));

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payments'::regclass and conname = 'payments_provider_ref_key'
  ) then
    alter table public.payments
      add constraint payments_provider_ref_key unique (provider, provider_ref);
  end if;
end $$;
