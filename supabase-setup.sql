-- =====================================================================
-- CHAI KHATA — Supabase database setup
-- Run this whole file once in: Supabase Dashboard → SQL Editor → New query
-- It is written to be safely re-runnable (uses IF NOT EXISTS / OR REPLACE).
--
-- Security model
--   * Every table has Row Level Security (RLS) enabled.
--   * Browsers (anon / authenticated roles) can only READ ledger tables.
--   * All money movements go through SECURITY DEFINER functions (RPCs) that
--     check the caller is the stall owner, validate input, snapshot prices
--     server-side, and are idempotent via a client request id.
--   * Financial rows are append-only (triggers block UPDATE/DELETE/TRUNCATE).
--     Mistakes are fixed with reversal rows, never by deleting.
--   * The service-role key is only ever used inside Edge Functions.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CORE TABLES
-- ---------------------------------------------------------------------

create table if not exists public.stalls (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(trim(name)) between 2 and 80),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id                   uuid primary key references auth.users(id) on delete restrict,
  stall_id             uuid not null references public.stalls(id) on delete restrict,
  role                 text not null check (role in ('owner', 'customer')),
  full_name            text not null check (char_length(trim(full_name)) between 2 and 80),
  mobile               text check (mobile ~ '^[6-9][0-9]{9}$'),
  username             text check (username ~ '^[a-z][a-z0-9._]{2,29}$'),
  login_email          text not null,             -- internal Supabase Auth email (customers never see it)
  must_change_password boolean not null default false,
  is_active            boolean not null default true,
  notes                text check (char_length(notes) <= 300),
  created_by           uuid references public.profiles(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint customer_has_mobile check (role <> 'customer' or mobile is not null)
);
create unique index if not exists profiles_login_email_key on public.profiles (lower(login_email));
create unique index if not exists profiles_mobile_key      on public.profiles (mobile)   where mobile is not null;
create unique index if not exists profiles_username_key    on public.profiles (username) where username is not null;
create index        if not exists profiles_stall_role_idx  on public.profiles (stall_id, role);

-- Customer notification bell: everything newer than this moment is "unread".
-- (existing rows default to now(), so old history is not shown as new)
alter table public.profiles add column if not exists notifications_seen_at timestamptz not null default now();

-- ---------------------------------------------------------------------
-- 2. HELPER FUNCTIONS used by RLS policies (SECURITY DEFINER avoids
--    recursive policy evaluation on profiles)
-- ---------------------------------------------------------------------

create or replace function public.app_stall_id()
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  return (select p.stall_id from public.profiles p where p.id = auth.uid() and p.is_active);
end $$;

create or replace function public.app_is_owner()
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  return exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role = 'owner' and p.is_active);
end $$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 3. PRODUCTS, TRANSACTIONS, ITEMS, AUDIT LOG
-- ---------------------------------------------------------------------

create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  stall_id    uuid not null default public.app_stall_id() references public.stalls(id) on delete restrict,
  name        text not null check (char_length(trim(name)) between 1 and 60),
  price       numeric(10,2) not null check (price >= 0 and price <= 100000),
  unit        text not null default 'piece' check (char_length(trim(unit)) between 1 and 20),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists products_stall_name_key on public.products (stall_id, lower(name));
create index        if not exists products_stall_active_idx on public.products (stall_id, is_active);

-- A transaction is one ledger line. balance_effect is signed:
--   +amount  => customer owes more   (purchase, debit adjustment, reversal of a payment)
--   -amount  => customer owes less   (payment, credit adjustment, reversal of a purchase)
-- Balance = SUM(balance_effect)  =  purchases + debit adj - payments - credit adj
create table if not exists public.transactions (
  id                uuid primary key default gen_random_uuid(),
  stall_id          uuid not null references public.stalls(id) on delete restrict,
  customer_id       uuid not null,
  kind              text not null check (kind in ('purchase','payment','debit_adjustment','credit_adjustment','reversal')),
  amount            numeric(12,2) not null check (amount > 0 and amount <= 1000000),
  payment_method    text check (payment_method in ('Cash','UPI','Other')),
  note              text check (char_length(note) <= 300),
  reversed_of       uuid references public.transactions(id) on delete restrict,
  is_reversed       boolean not null default false,
  balance_effect    numeric(12,2) not null default 0,   -- set by trigger
  ledger_side       text check (ledger_side in ('debit','credit')),  -- set by trigger
  ledger_kind       text check (ledger_kind in ('purchase','payment','debit_adjustment','credit_adjustment')), -- set by trigger
  txn_date          date not null,                       -- Asia/Kolkata calendar date, set by trigger
  client_request_id uuid not null,                       -- idempotency key (prevents duplicate submissions)
  created_by        uuid not null,
  created_at        timestamptz not null default now(),
  constraint transactions_customer_id_fkey foreign key (customer_id) references public.profiles(id) on delete restrict,
  constraint transactions_created_by_fkey  foreign key (created_by)  references public.profiles(id) on delete restrict,
  constraint transactions_request_key unique (stall_id, client_request_id),
  constraint payment_needs_method check (kind <> 'payment' or payment_method is not null),
  constraint reversal_links_original check ((kind = 'reversal') = (reversed_of is not null))
);
create unique index if not exists transactions_one_reversal_key on public.transactions (reversed_of) where reversed_of is not null;
create index if not exists transactions_customer_time_idx on public.transactions (customer_id, created_at desc);
create index if not exists transactions_stall_time_idx    on public.transactions (stall_id, created_at desc);
create index if not exists transactions_stall_date_idx    on public.transactions (stall_id, txn_date);

create table if not exists public.transaction_items (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid not null references public.transactions(id) on delete restrict,
  stall_id        uuid not null references public.stalls(id) on delete restrict,
  customer_id     uuid not null references public.profiles(id) on delete restrict,
  product_id      uuid references public.products(id) on delete restrict,
  product_name    text not null,                              -- name snapshot
  quantity        numeric(8,2) not null check (quantity > 0 and quantity <= 1000),
  unit_price      numeric(10,2) not null check (unit_price >= 0),  -- price snapshot: history never changes
  line_total      numeric(12,2) generated always as (round(quantity * unit_price, 2)) stored,
  created_at      timestamptz not null default now()
);
create index if not exists transaction_items_tx_idx       on public.transaction_items (transaction_id);
create index if not exists transaction_items_customer_idx on public.transaction_items (customer_id);

create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  stall_id    uuid references public.stalls(id) on delete restrict,
  table_name  text not null,
  record_id   uuid,
  action      text not null,
  old_data    jsonb,
  new_data    jsonb,
  actor_id    uuid,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_stall_time_idx on public.audit_log (stall_id, created_at desc);
create index if not exists audit_log_record_idx     on public.audit_log (table_name, record_id);

-- ---------------------------------------------------------------------
-- 4. TRIGGERS
-- ---------------------------------------------------------------------

-- 4a. updated_at maintenance
drop trigger if exists trg_stalls_touch on public.stalls;
create trigger trg_stalls_touch before update on public.stalls for each row execute function public.touch_updated_at();
drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists trg_products_touch on public.products;
create trigger trg_products_touch before update on public.products for each row execute function public.touch_updated_at();

-- 4b. Compute ledger fields on insert (so the client can never choose them)
create or replace function public.tx_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  o public.transactions%rowtype;
  c public.profiles%rowtype;
begin
  select * into c from public.profiles where id = new.customer_id;
  if not found or c.role <> 'customer' or c.stall_id <> new.stall_id then
    raise exception 'Invalid customer for this stall.';
  end if;

  new.note       := nullif(trim(coalesce(new.note, '')), '');
  new.created_at := coalesce(new.created_at, now());
  new.txn_date   := (new.created_at at time zone 'Asia/Kolkata')::date;

  if new.kind = 'reversal' then
    select * into o from public.transactions where id = new.reversed_of;
    if not found or o.stall_id <> new.stall_id or o.customer_id <> new.customer_id or o.kind = 'reversal' then
      raise exception 'Invalid transaction to reverse.';
    end if;
    new.amount         := o.amount;
    new.payment_method := o.payment_method;
    new.balance_effect := -o.balance_effect;
    new.ledger_side    := o.ledger_side;
    new.ledger_kind    := o.ledger_kind;
  elsif new.kind = 'purchase' then
    new.balance_effect := new.amount;  new.ledger_side := 'debit';  new.ledger_kind := 'purchase';
  elsif new.kind = 'debit_adjustment' then
    new.balance_effect := new.amount;  new.ledger_side := 'debit';  new.ledger_kind := 'debit_adjustment';
  elsif new.kind = 'payment' then
    new.balance_effect := -new.amount; new.ledger_side := 'credit'; new.ledger_kind := 'payment';
  elsif new.kind = 'credit_adjustment' then
    new.balance_effect := -new.amount; new.ledger_side := 'credit'; new.ledger_kind := 'credit_adjustment';
  end if;
  return new;
end $$;

drop trigger if exists trg_tx_before_insert on public.transactions;
create trigger trg_tx_before_insert before insert on public.transactions
  for each row execute function public.tx_before_insert();

-- 4c. A purchase's amount must equal the sum of its items (checked at commit)
create or replace function public.check_purchase_total()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_sum numeric(12,2); v_cnt int;
begin
  select coalesce(sum(line_total), 0), count(*) into v_sum, v_cnt
  from public.transaction_items where transaction_id = new.id;
  if v_cnt = 0 or v_sum <> new.amount then
    raise exception 'Purchase total does not match its items.';
  end if;
  return null;
end $$;

drop trigger if exists trg_purchase_total on public.transactions;
create constraint trigger trg_purchase_total after insert on public.transactions
  deferrable initially deferred for each row when (new.kind = 'purchase')
  execute function public.check_purchase_total();

-- 4d. Append-only guard for financial tables
--     The only permitted change is flagging a transaction as reversed,
--     and only from inside reverse_transaction().
create or replace function public.block_mutation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and tg_table_name = 'transactions' then
    if current_setting('app.allow_reverse_flag', true) = 'on'
       and old.is_reversed = false and new.is_reversed = true
       and (to_jsonb(new) - 'is_reversed') = (to_jsonb(old) - 'is_reversed') then
      return new;
    end if;
  end if;
  raise exception 'Financial records are append-only. Use a reversal to correct a mistake.' using errcode = '42501';
end $$;

drop trigger if exists trg_tx_immutable on public.transactions;
create trigger trg_tx_immutable before update or delete on public.transactions
  for each row execute function public.block_mutation();
drop trigger if exists trg_tx_no_truncate on public.transactions;
create trigger trg_tx_no_truncate before truncate on public.transactions
  for each statement execute function public.block_mutation();

drop trigger if exists trg_items_immutable on public.transaction_items;
create trigger trg_items_immutable before update or delete on public.transaction_items
  for each row execute function public.block_mutation();
drop trigger if exists trg_items_no_truncate on public.transaction_items;
create trigger trg_items_no_truncate before truncate on public.transaction_items
  for each statement execute function public.block_mutation();

drop trigger if exists trg_audit_immutable on public.audit_log;
create trigger trg_audit_immutable before update or delete on public.audit_log
  for each row execute function public.block_mutation();
drop trigger if exists trg_audit_no_truncate on public.audit_log;
create trigger trg_audit_no_truncate before truncate on public.audit_log
  for each statement execute function public.block_mutation();

-- 4e. Audit history
create or replace function public.log_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb; v_new jsonb; v_id uuid; v_stall uuid;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old); v_new := null;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old); v_new := to_jsonb(new);
    -- viewing notifications only moves a timestamp; don't flood the audit log with it
    if tg_table_name = 'profiles'
       and (v_new - 'notifications_seen_at' - 'updated_at') = (v_old - 'notifications_seen_at' - 'updated_at') then
      return null;
    end if;
  else
    v_old := null; v_new := to_jsonb(new);
  end if;
  v_id := coalesce(v_new ->> 'id', v_old ->> 'id')::uuid;
  if tg_table_name = 'stalls' then
    v_stall := v_id;
  else
    v_stall := coalesce(v_new ->> 'stall_id', v_old ->> 'stall_id')::uuid;
  end if;
  insert into public.audit_log (stall_id, table_name, record_id, action, old_data, new_data, actor_id)
  values (v_stall, tg_table_name, v_id, tg_op, v_old, v_new, auth.uid());
  return null;
end $$;

drop trigger if exists trg_stalls_audit on public.stalls;
create trigger trg_stalls_audit after insert or update on public.stalls for each row execute function public.log_audit();
drop trigger if exists trg_profiles_audit on public.profiles;
create trigger trg_profiles_audit after insert or update on public.profiles for each row execute function public.log_audit();
drop trigger if exists trg_products_audit on public.products;
create trigger trg_products_audit after insert or update on public.products for each row execute function public.log_audit();
drop trigger if exists trg_transactions_audit on public.transactions;
create trigger trg_transactions_audit after insert or update on public.transactions for each row execute function public.log_audit();

-- ---------------------------------------------------------------------
-- 5. VIEW: customer balances (security_invoker => RLS of the caller applies)
-- ---------------------------------------------------------------------
create or replace view public.customer_balances
with (security_invoker = true) as
select
  p.id                    as customer_id,
  p.stall_id,
  p.full_name,
  p.mobile,
  p.username,
  p.is_active,
  p.notes,
  p.must_change_password,
  p.created_at,
  coalesce(sum(t.balance_effect) filter (where t.ledger_side = 'debit'), 0)::numeric(12,2)   as total_purchases,
  coalesce(-sum(t.balance_effect) filter (where t.ledger_side = 'credit'), 0)::numeric(12,2) as total_payments,
  coalesce(sum(t.balance_effect), 0)::numeric(12,2)                                          as balance,
  max(t.created_at)                                                                          as last_activity
from public.profiles p
left join public.transactions t on t.customer_id = p.id
where p.role = 'customer'
group by p.id;

-- ---------------------------------------------------------------------
-- 6. RPC FUNCTIONS (the only way the browser can write ledger data)
-- ---------------------------------------------------------------------

-- 6a. Record a purchase with multiple products. Prices are read server-side.
create or replace function public.record_purchase(
  p_customer   uuid,
  p_items      jsonb,
  p_note       text default null,
  p_request_id uuid default gen_random_uuid()
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_stall    uuid := public.app_stall_id();
  v_existing uuid;
  v_total    numeric(12,2) := 0;
  v_tx       uuid;
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
  e          jsonb;
  v_pid      uuid;
  v_qty      numeric;
  v_price    numeric(10,2);
  v_name     text;
begin
  if not public.app_is_owner() then
    raise exception 'Only the stall owner can record purchases.' using errcode = '42501';
  end if;

  select id into v_existing from public.transactions
   where stall_id = v_stall and client_request_id = p_request_id;
  if found then return v_existing; end if;   -- duplicate submission: return the original

  if not exists (select 1 from public.profiles
                  where id = p_customer and stall_id = v_stall and role = 'customer' and is_active) then
    raise exception 'Customer not found or inactive.';
  end if;
  if v_note is not null and char_length(v_note) > 300 then
    raise exception 'Note is too long (max 300 characters).';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 50 then
    raise exception 'Add between 1 and 50 products.';
  end if;

  -- pass 1: validate and total (locks product rows so the price cannot change mid-way)
  for e in select value from jsonb_array_elements(p_items) loop
    begin
      v_pid := (e ->> 'product_id')::uuid;
      v_qty := (e ->> 'quantity')::numeric;
    exception when others then
      raise exception 'Invalid item in purchase.';
    end;
    if v_qty is null or v_qty <= 0 or v_qty > 1000 or v_qty <> round(v_qty, 2) then
      raise exception 'Quantity must be between 0.01 and 1000.';
    end if;
    select price into v_price from public.products
     where id = v_pid and stall_id = v_stall and is_active for share;
    if not found then
      raise exception 'A selected product is unavailable.';
    end if;
    v_total := v_total + round(v_qty * v_price, 2);
  end loop;

  if v_total <= 0 then
    raise exception 'Purchase total must be greater than zero.';
  end if;

  insert into public.transactions (stall_id, customer_id, kind, amount, note, client_request_id, created_by)
  values (v_stall, p_customer, 'purchase', v_total, v_note, p_request_id, auth.uid())
  returning id into v_tx;

  -- pass 2: write items with the price snapshot
  for e in select value from jsonb_array_elements(p_items) loop
    v_pid := (e ->> 'product_id')::uuid;
    v_qty := (e ->> 'quantity')::numeric;
    select name, price into v_name, v_price from public.products where id = v_pid;
    insert into public.transaction_items (transaction_id, stall_id, customer_id, product_id, product_name, quantity, unit_price)
    values (v_tx, v_stall, p_customer, v_pid, v_name, v_qty, v_price);
  end loop;

  return v_tx;
exception when unique_violation then
  select id into v_existing from public.transactions
   where stall_id = v_stall and client_request_id = p_request_id;
  if found then return v_existing; end if;
  raise;
end $$;

-- 6b. Record a payment (Cash / UPI / Other)
create or replace function public.record_payment(
  p_customer   uuid,
  p_amount     numeric,
  p_method     text,
  p_note       text default null,
  p_request_id uuid default gen_random_uuid()
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_stall    uuid := public.app_stall_id();
  v_existing uuid;
  v_tx       uuid;
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.app_is_owner() then
    raise exception 'Only the stall owner can record payments.' using errcode = '42501';
  end if;
  select id into v_existing from public.transactions
   where stall_id = v_stall and client_request_id = p_request_id;
  if found then return v_existing; end if;

  if not exists (select 1 from public.profiles where id = p_customer and stall_id = v_stall and role = 'customer') then
    raise exception 'Customer not found.';
  end if;
  if p_amount is null or p_amount < 0.01 or p_amount > 1000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter a valid amount (up to 2 decimals, max 10,00,000).';
  end if;
  if p_method is null or p_method not in ('Cash', 'UPI', 'Other') then
    raise exception 'Payment method must be Cash, UPI or Other.';
  end if;
  if v_note is not null and char_length(v_note) > 300 then
    raise exception 'Note is too long (max 300 characters).';
  end if;

  insert into public.transactions (stall_id, customer_id, kind, amount, payment_method, note, client_request_id, created_by)
  values (v_stall, p_customer, 'payment', p_amount, p_method, v_note, p_request_id, auth.uid())
  returning id into v_tx;
  return v_tx;
exception when unique_violation then
  select id into v_existing from public.transactions
   where stall_id = v_stall and client_request_id = p_request_id;
  if found then return v_existing; end if;
  raise;
end $$;

-- 6c. Manual adjustment: 'debit' adds to what the customer owes, 'credit' reduces it
create or replace function public.record_adjustment(
  p_customer   uuid,
  p_direction  text,
  p_amount     numeric,
  p_note       text,
  p_request_id uuid default gen_random_uuid()
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_stall    uuid := public.app_stall_id();
  v_existing uuid;
  v_tx       uuid;
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.app_is_owner() then
    raise exception 'Only the stall owner can record adjustments.' using errcode = '42501';
  end if;
  select id into v_existing from public.transactions
   where stall_id = v_stall and client_request_id = p_request_id;
  if found then return v_existing; end if;

  if not exists (select 1 from public.profiles where id = p_customer and stall_id = v_stall and role = 'customer') then
    raise exception 'Customer not found.';
  end if;
  if p_direction is null or p_direction not in ('debit', 'credit') then
    raise exception 'Adjustment must be debit or credit.';
  end if;
  if p_amount is null or p_amount < 0.01 or p_amount > 1000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter a valid amount (up to 2 decimals, max 10,00,000).';
  end if;
  if v_note is null or char_length(v_note) < 3 or char_length(v_note) > 300 then
    raise exception 'A reason (3 to 300 characters) is required for adjustments.';
  end if;

  insert into public.transactions (stall_id, customer_id, kind, amount, note, client_request_id, created_by)
  values (v_stall, p_customer,
          case p_direction when 'debit' then 'debit_adjustment' else 'credit_adjustment' end,
          p_amount, v_note, p_request_id, auth.uid())
  returning id into v_tx;
  return v_tx;
exception when unique_violation then
  select id into v_existing from public.transactions
   where stall_id = v_stall and client_request_id = p_request_id;
  if found then return v_existing; end if;
  raise;
end $$;

-- 6d. Reverse a transaction (the original row is kept; a mirror row is added)
create or replace function public.reverse_transaction(
  p_tx         uuid,
  p_reason     text,
  p_request_id uuid default gen_random_uuid()
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_stall    uuid := public.app_stall_id();
  v_existing uuid;
  v_orig     public.transactions%rowtype;
  v_new      uuid;
  v_reason   text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.app_is_owner() then
    raise exception 'Only the stall owner can reverse transactions.' using errcode = '42501';
  end if;
  select id into v_existing from public.transactions
   where stall_id = v_stall and client_request_id = p_request_id;
  if found then return v_existing; end if;

  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'A reason (3 to 300 characters) is required to reverse a transaction.';
  end if;

  select * into v_orig from public.transactions where id = p_tx and stall_id = v_stall for update;
  if not found then raise exception 'Transaction not found.'; end if;
  if v_orig.kind = 'reversal' then raise exception 'A reversal cannot be reversed.'; end if;
  if v_orig.is_reversed then raise exception 'This transaction was already reversed.'; end if;

  insert into public.transactions (stall_id, customer_id, kind, amount, note, reversed_of, client_request_id, created_by)
  values (v_stall, v_orig.customer_id, 'reversal', v_orig.amount, v_reason, p_tx, p_request_id, auth.uid())
  returning id into v_new;

  perform set_config('app.allow_reverse_flag', 'on', true);
  update public.transactions set is_reversed = true where id = p_tx;
  perform set_config('app.allow_reverse_flag', 'off', true);

  return v_new;
exception when unique_violation then
  select id into v_existing from public.transactions
   where stall_id = v_stall and client_request_id = p_request_id;
  if found then return v_existing; end if;
  raise;
end $$;

-- 6e. Customer clears their own "must change password" flag after changing it
create or replace function public.mark_password_changed()
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set must_change_password = false where id = auth.uid();
end $$;

-- 6e-2. Customer opens the notification bell: everything up to now counts as read.
--       Returns the server timestamp so the app and database agree.
create or replace function public.mark_notifications_seen()
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_now timestamptz := now();
begin
  update public.profiles set notifications_seen_at = v_now where id = auth.uid();
  return v_now;
end $$;

-- 6f. Login helper: turns a mobile number / username / owner email into the
--     internal auth email. Returns a dummy address for unknown users so the
--     response does not reveal whether an account exists.
create or replace function public.resolve_login(p_identifier text)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v text := lower(trim(coalesce(p_identifier, '')));
  d text;
  r text;
begin
  if v like '%@%' then return v; end if;
  d := regexp_replace(v, '\D', '', 'g');
  if length(d) = 12 and d like '91%' then d := substr(d, 3);
  elsif length(d) = 11 and d like '0%' then d := substr(d, 2);
  end if;
  select login_email into r from public.profiles
   where (d ~ '^[6-9][0-9]{9}$' and mobile = d) or (username is not null and username = v)
   limit 1;
  return coalesce(r, 'no-such-user@chaikhata.example');
end $$;

-- 6g. Daily sales / collections report (SECURITY INVOKER: RLS applies)
--     Reversals are counted on the day they are made, netting the original out.
create or replace function public.report_daily(p_from date, p_to date)
returns table (
  day         date,
  bills       integer,
  sales       numeric,
  collections numeric,
  cash_amt    numeric,
  upi_amt     numeric,
  other_amt   numeric
)
language sql stable security invoker set search_path = public as $$
  select
    t.txn_date,
    (count(*) filter (where t.kind = 'purchase' and not t.is_reversed))::integer,
    coalesce(sum(t.balance_effect) filter (where t.ledger_kind = 'purchase'), 0),
    coalesce(-sum(t.balance_effect) filter (where t.ledger_kind = 'payment'), 0),
    coalesce(-sum(t.balance_effect) filter (where t.ledger_kind = 'payment' and t.payment_method = 'Cash'), 0),
    coalesce(-sum(t.balance_effect) filter (where t.ledger_kind = 'payment' and t.payment_method = 'UPI'), 0),
    coalesce(-sum(t.balance_effect) filter (where t.ledger_kind = 'payment' and t.payment_method = 'Other'), 0)
  from public.transactions t
  where public.app_is_owner()
    and t.stall_id = public.app_stall_id()
    and t.txn_date between p_from and p_to
  group by t.txn_date
  order by t.txn_date desc;
$$;

-- ---------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.stalls            enable row level security;
alter table public.profiles          enable row level security;
alter table public.products          enable row level security;
alter table public.transactions      enable row level security;
alter table public.transaction_items enable row level security;
alter table public.audit_log         enable row level security;

-- stalls
drop policy if exists stalls_select on public.stalls;
create policy stalls_select on public.stalls for select to authenticated
  using (id = public.app_stall_id());
drop policy if exists stalls_update_owner on public.stalls;
create policy stalls_update_owner on public.stalls for update to authenticated
  using (public.app_is_owner() and id = public.app_stall_id())
  with check (public.app_is_owner() and id = public.app_stall_id());

-- profiles: a user sees their own row; the owner sees every row of their stall
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or (public.app_is_owner() and stall_id = public.app_stall_id()));
-- only the owner edits customers, and only the whitelisted columns (see GRANTs below)
drop policy if exists profiles_update_owner on public.profiles;
create policy profiles_update_owner on public.profiles for update to authenticated
  using (public.app_is_owner() and stall_id = public.app_stall_id() and role = 'customer')
  with check (public.app_is_owner() and stall_id = public.app_stall_id() and role = 'customer');

-- products: owner only
drop policy if exists products_select_owner on public.products;
create policy products_select_owner on public.products for select to authenticated
  using (public.app_is_owner() and stall_id = public.app_stall_id());
drop policy if exists products_insert_owner on public.products;
create policy products_insert_owner on public.products for insert to authenticated
  with check (public.app_is_owner() and stall_id = public.app_stall_id());
drop policy if exists products_update_owner on public.products;
create policy products_update_owner on public.products for update to authenticated
  using (public.app_is_owner() and stall_id = public.app_stall_id())
  with check (public.app_is_owner() and stall_id = public.app_stall_id());

-- transactions + items: owner sees the stall, a customer sees only their own. No write policies at all.
drop policy if exists transactions_select on public.transactions;
create policy transactions_select on public.transactions for select to authenticated
  using (stall_id = public.app_stall_id() and (public.app_is_owner() or customer_id = auth.uid()));
drop policy if exists items_select on public.transaction_items;
create policy items_select on public.transaction_items for select to authenticated
  using (stall_id = public.app_stall_id() and (public.app_is_owner() or customer_id = auth.uid()));

-- audit log: owner read-only
drop policy if exists audit_select_owner on public.audit_log;
create policy audit_select_owner on public.audit_log for select to authenticated
  using (public.app_is_owner() and stall_id = public.app_stall_id());

-- ---------------------------------------------------------------------
-- 8. PRIVILEGES (defence in depth on top of RLS)
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;

grant select on public.stalls, public.profiles, public.products,
                public.transactions, public.transaction_items,
                public.audit_log, public.customer_balances to authenticated;

grant update (name)                                   on public.stalls   to authenticated;
grant update (full_name, username, notes, is_active)  on public.profiles to authenticated;
grant insert (name, price, unit, is_active)           on public.products to authenticated;
grant update (name, price, unit, is_active)           on public.products to authenticated;

-- lock every function in public, then open only what the app needs
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

grant execute on function public.app_stall_id()                                   to authenticated;
grant execute on function public.app_is_owner()                                   to authenticated;
grant execute on function public.record_purchase(uuid, jsonb, text, uuid)         to authenticated;
grant execute on function public.record_payment(uuid, numeric, text, text, uuid)  to authenticated;
grant execute on function public.record_adjustment(uuid, text, numeric, text, uuid) to authenticated;
grant execute on function public.reverse_transaction(uuid, text, uuid)            to authenticated;
grant execute on function public.mark_password_changed()                          to authenticated;
grant execute on function public.mark_notifications_seen()                        to authenticated;
grant execute on function public.report_daily(date, date)                         to authenticated;
grant execute on function public.resolve_login(text)                              to anon, authenticated;

-- Live notifications: let Supabase Realtime broadcast new ledger rows.
-- RLS still applies, so a customer only ever receives events for their own rows.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'transactions') then
    alter publication supabase_realtime add table public.transactions;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 9. ONE-TIME OWNER BOOTSTRAP + OPTIONAL DEMO DATA (run manually, see README)
--    These functions are NOT callable from the browser.
-- ---------------------------------------------------------------------

-- Step A: create the owner in Dashboard → Authentication → Users → Add user
--         (email + password, tick "Auto Confirm User").
-- Step B: run:  select public.bootstrap_owner('owner@example.com', 'Sharma Chai Stall', 'Ramesh Sharma');
create or replace function public.bootstrap_owner(p_email text, p_stall_name text, p_owner_name text)
returns text language plpgsql security definer set search_path = public, auth as $$
declare v_uid uuid; v_stall uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is null then
    raise exception 'No auth user with email %. Create it under Authentication → Users first.', p_email;
  end if;
  if exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'This user already has a profile.';
  end if;
  insert into public.stalls (name) values (trim(p_stall_name)) returning id into v_stall;
  insert into public.profiles (id, stall_id, role, full_name, login_email)
  values (v_uid, v_stall, 'owner', trim(p_owner_name), lower(trim(p_email)));
  return 'Owner created for stall ' || v_stall;
end $$;

-- Demo seed: adds typical tea-stall products, and (once per customer) a week of sample
-- purchases and a payment for customers that already exist and have no transactions yet.
-- Usage:  select public.seed_demo_data((select id from public.stalls limit 1));
create or replace function public.seed_demo_data(p_stall uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid; c record; p record; v_tx uuid; v_qty int; v_ts timestamptz; d int;
  v_customers int := 0; v_tx_count int := 0; v_sum numeric(12,2);
begin
  select id into v_owner from public.profiles where stall_id = p_stall and role = 'owner' limit 1;
  if v_owner is null then raise exception 'Stall has no owner. Run bootstrap_owner first.'; end if;

  insert into public.products (stall_id, name, price, unit) values
    (p_stall, 'Cutting Chai',   10, 'cup'),
    (p_stall, 'Special Chai',   15, 'cup'),
    (p_stall, 'Coffee',         20, 'cup'),
    (p_stall, 'Cigarette',      18, 'piece'),
    (p_stall, 'Parle-G Biscuit', 5, 'packet'),
    (p_stall, 'Bun Maska',      25, 'plate'),
    (p_stall, 'Samosa',         15, 'piece'),
    (p_stall, 'Vada Pav',       20, 'piece')
  on conflict do nothing;

  for c in
    select id from public.profiles
     where stall_id = p_stall and role = 'customer'
       and not exists (select 1 from public.transactions t where t.customer_id = profiles.id)
  loop
    v_customers := v_customers + 1;
    v_sum := 0;
    for d in reverse 6..0 loop
      select * into p from public.products where stall_id = p_stall and is_active order by random() limit 1;
      v_qty := 1 + (d % 3);
      v_ts  := now() - make_interval(days => d) - interval '90 minutes';
      insert into public.transactions (stall_id, customer_id, kind, amount, note, client_request_id, created_by, created_at)
      values (p_stall, c.id, 'purchase', round(p.price * v_qty, 2), 'Demo entry', gen_random_uuid(), v_owner, v_ts)
      returning id into v_tx;
      insert into public.transaction_items (transaction_id, stall_id, customer_id, product_id, product_name, quantity, unit_price, created_at)
      values (v_tx, p_stall, c.id, p.id, p.name, v_qty, p.price, v_ts);
      v_sum := v_sum + round(p.price * v_qty, 2);
      v_tx_count := v_tx_count + 1;
    end loop;
    if v_sum > 40 then
      insert into public.transactions (stall_id, customer_id, kind, amount, payment_method, note, client_request_id, created_by, created_at)
      values (p_stall, c.id, 'payment', round(v_sum / 2, 0), 'UPI', 'Demo payment', gen_random_uuid(), v_owner, now() - interval '2 days');
      v_tx_count := v_tx_count + 1;
    end if;
  end loop;

  return format('Seeded products and %s transactions for %s customers.', v_tx_count, v_customers);
end $$;

revoke all on function public.bootstrap_owner(text, text, text) from public, anon, authenticated;
revoke all on function public.seed_demo_data(uuid)              from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Done. Next: create the owner (see README step 3).
-- ---------------------------------------------------------------------
