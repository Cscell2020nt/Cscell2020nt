-- Modelo FUTURO para PostgreSQL/Supabase. O MVP usa SQLite e não executa este arquivo.
-- Aplicar somente em projeto Supabase de desenvolvimento e validar antes de produção.
begin;

create extension if not exists pgcrypto with schema extensions;

create table public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.sellers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  initials text not null default '',
  color text not null default '#3b82f6',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_id, id)
);

-- Supabase Auth é a fonte de contas: não há senhas ou papéis vindos de user_metadata.
-- Um usuário pertence a uma loja; vínculos de outras lojas nunca são aceitos.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  role text not null check (role in ('admin', 'seller')),
  seller_id uuid,
  created_at timestamptz not null default now(),
  unique (store_id, id),
  foreign key (store_id, seller_id) references public.sellers(store_id, id),
  check ((role = 'admin' and seller_id is null) or (role = 'seller' and seller_id is not null))
);
create unique index profiles_one_login_per_seller on public.profiles(store_id, seller_id) where seller_id is not null;

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  seller_id uuid,
  competence date not null check (extract(day from competence) = 1),
  revenue_cents bigint not null default 0 check (revenue_cents >= 0),
  ticket_cents bigint not null default 0 check (ticket_cents >= 0),
  created_at timestamptz not null default now(),
  foreign key (store_id, seller_id) references public.sellers(store_id, id)
);
create unique index goals_store_competence on public.goals(store_id, competence) where seller_id is null;
create unique index goals_seller_competence on public.goals(store_id, seller_id, competence) where seller_id is not null;

create table public.financiers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  active boolean not null default true,
  unique (store_id, id)
);
create unique index financiers_store_name on public.financiers(store_id, lower(name));

create table public.settings (
  store_id uuid primary key references public.stores(id) on delete cascade,
  working_days integer[] not null default array[1,2,3,4,5,6]
    check (working_days <@ array[0,1,2,3,4,5,6]),
  holidays date[] not null default '{}',
  special_open_dates date[] not null default '{}',
  reminder_time time not null default '08:30',
  timezone text not null default 'America/Sao_Paulo',
  alert_threshold numeric(5,4) not null default 0.8 check (alert_threshold between 0 and 1),
  updated_at timestamptz not null default now()
);

create table public.imported_files (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  uploaded_by uuid not null,
  filename text not null,
  storage_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, sha256),
  foreign key (store_id, uploaded_by) references public.profiles(store_id, id),
  check (split_part(storage_path, '/', 1) = store_id::text)
);

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  file_id uuid not null,
  created_by uuid not null,
  mode text not null check (mode in ('daily', 'cumulative', 'summary')),
  status text not null default 'preview' check (status in ('preview', 'confirmed', 'reverted', 'failed')),
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  column_mapping jsonb not null default '{}',
  seller_aliases jsonb not null default '{}',
  added_count integer not null default 0 check (added_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  ignored_count integer not null default 0 check (ignored_count >= 0),
  revenue_cents bigint not null default 0 check (revenue_cents >= 0),
  sales_count integer not null default 0 check (sales_count >= 0),
  before_snapshot jsonb,
  after_snapshot jsonb,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  reverted_at timestamptz,
  unique (store_id, id),
  foreign key (store_id, file_id) references public.imported_files(store_id, id),
  foreign key (store_id, created_by) references public.profiles(store_id, id)
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  seller_id uuid not null,
  batch_id uuid,
  external_id text check (external_id is null or length(btrim(external_id)) > 0),
  fingerprint text not null check (length(fingerprint) > 0),
  sale_date date not null,
  sale_time time,
  status text not null default 'valid' check (status in ('valid', 'cancelled', 'returned')),
  currency text not null default 'BRL' check (currency = 'BRL'),
  gross_cents bigint not null check (gross_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  net_cents bigint not null check (net_cents >= 0),
  trade_in_cents bigint not null default 0 check (trade_in_cents >= 0),
  financed_cents bigint not null default 0 check (financed_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  foreign key (store_id, seller_id) references public.sellers(store_id, id),
  foreign key (store_id, batch_id) references public.import_batches(store_id, id),
  check (discount_cents <= gross_cents),
  -- O líquido explícito do relatório é autoritativo. Diferenças em relação a
  -- bruto - desconto geram aviso na importação, sem apagar o valor de origem.
  check (trade_in_cents <= net_cents and financed_cents <= net_cents)
);
-- Identificadores externos são únicos por loja; nunca globalmente entre lojas.
create unique index sales_external_id on public.sales(store_id, external_id) where external_id is not null;
create unique index sales_fallback_fingerprint on public.sales(store_id, fingerprint) where external_id is null;
create index sales_store_date on public.sales(store_id, sale_date, status);
create index sales_seller_date on public.sales(store_id, seller_id, sale_date);
create index sales_batch on public.sales(store_id, batch_id);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  sale_id uuid not null,
  line_number integer not null check (line_number > 0),
  product text not null,
  category text not null default '',
  quantity integer not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  gross_cents bigint not null check (gross_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  net_cents bigint not null check (net_cents >= 0),
  unique (store_id, sale_id, line_number),
  foreign key (store_id, sale_id) references public.sales(store_id, id) on delete cascade,
  check (discount_cents <= gross_cents)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  sale_id uuid not null,
  financier_id uuid,
  method text not null check (length(btrim(method)) > 0),
  amount_cents bigint not null check (amount_cents > 0),
  installments integer not null default 1 check (installments > 0),
  foreign key (store_id, sale_id) references public.sales(store_id, id) on delete cascade,
  foreign key (store_id, financier_id) references public.financiers(store_id, id)
);
create index payments_sale on public.payments(store_id, sale_id);
create index payments_financier on public.payments(store_id, financier_id);

create table public.import_lines (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  batch_id uuid not null,
  line_number integer not null check (line_number > 0),
  raw_data jsonb not null,
  normalized_data jsonb,
  issues jsonb not null default '[]',
  status text not null default 'pending' check (status in ('pending', 'valid', 'error', 'duplicate', 'added', 'updated', 'ignored')),
  sale_id uuid,
  unique (store_id, batch_id, line_number),
  foreign key (store_id, batch_id) references public.import_batches(store_id, id) on delete cascade,
  foreign key (store_id, sale_id) references public.sales(store_id, id)
);

create table public.consolidated_summaries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  seller_id uuid not null,
  batch_id uuid not null,
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  revenue_cents bigint not null check (revenue_cents >= 0),
  sales_count integer not null check (sales_count >= 0),
  unique (store_id, seller_id, period_start, period_end),
  foreign key (store_id, seller_id) references public.sellers(store_id, id),
  foreign key (store_id, batch_id) references public.import_batches(store_id, id)
);
create index summaries_store_period on public.consolidated_summaries(store_id, period_start, period_end);

create table public.audit_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  actor_id uuid,
  action text not null,
  entity_type text,
  entity_id uuid,
  details jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (store_id, actor_id) references public.profiles(store_id, id)
);
create index audit_store_created on public.audit_entries(store_id, created_at desc);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  seller_id uuid,
  alert_date date not null,
  type text not null,
  message text not null,
  deduplication_key text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, deduplication_key),
  foreign key (store_id, seller_id) references public.sellers(store_id, id)
);
create index alerts_store_date on public.alerts(store_id, alert_date desc);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  recipient_id uuid not null,
  alert_id uuid,
  title text not null,
  message text not null,
  channel text not null default 'in_app' check (channel in ('in_app', 'web_push')),
  read_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (store_id, recipient_id) references public.profiles(store_id, id) on delete cascade,
  foreign key (store_id, alert_id) references public.alerts(store_id, id)
);
create index notifications_recipient on public.notifications(store_id, recipient_id, created_at desc);

-- Helpers leem a associação protegida; não confiam em claims de papel editáveis.
-- search_path vazio e nomes qualificados evitam captura por objetos do chamador.
create function public.current_store_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select p.store_id from public.profiles p where p.id = auth.uid() $$;

create function public.current_seller_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select p.seller_id from public.profiles p where p.id = auth.uid() $$;

create function public.is_store_admin(target_store uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (
  select 1 from public.profiles p
  where p.id = auth.uid() and p.store_id = target_store and p.role = 'admin'
) $$;

revoke all on function public.current_store_id(), public.current_seller_id(), public.is_store_admin(uuid) from public, anon;
grant execute on function public.current_store_id(), public.current_seller_id(), public.is_store_admin(uuid) to authenticated;

-- Nenhum cliente recebe INSERT/UPDATE/DELETE em profiles. Somente esta RPC pode
-- atribuir papéis, e exige administrador existente; o próprio papel é imutável.
create function public.admin_set_profile(target_user uuid, display_name text, assigned_role text, assigned_seller uuid default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare target_store uuid := public.current_store_id();
begin
  if target_store is null or not public.is_store_admin(target_store) then
    raise exception 'Administrador da loja necessário' using errcode = '42501';
  end if;
  if target_user = auth.uid() then
    raise exception 'Não é permitido alterar o próprio perfil por esta função' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = target_user and store_id <> target_store) then
    raise exception 'Usuário vinculado a outra loja' using errcode = '42501';
  end if;
  if assigned_role not in ('admin', 'seller') or assigned_role is null then
    raise exception 'Papel inválido';
  end if;
  if (assigned_role = 'admin' and assigned_seller is not null)
    or (assigned_role = 'seller' and assigned_seller is null) then
    raise exception 'Vínculo de vendedor incompatível com o papel';
  end if;
  insert into public.profiles(id, store_id, name, role, seller_id)
  values (target_user, target_store, display_name, assigned_role, assigned_seller)
  on conflict (id) do update
    set name = excluded.name, role = excluded.role, seller_id = excluded.seller_id
    where public.profiles.store_id = target_store;
  if not found then
    raise exception 'Vínculo de loja alterado concorrentemente' using errcode = '42501';
  end if;
  insert into public.audit_entries(store_id, actor_id, action, entity_type, entity_id)
  values (target_store, auth.uid(), 'profile.assigned', 'profiles', target_user);
end;
$$;
revoke all on function public.admin_set_profile(uuid, text, text, uuid) from public, anon;
grant execute on function public.admin_set_profile(uuid, text, text, uuid) to authenticated;

alter table public.stores enable row level security;
alter table public.sellers enable row level security;
alter table public.profiles enable row level security;
alter table public.goals enable row level security;
alter table public.financiers enable row level security;
alter table public.settings enable row level security;
alter table public.imported_files enable row level security;
alter table public.import_batches enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.payments enable row level security;
alter table public.import_lines enable row level security;
alter table public.consolidated_summaries enable row level security;
alter table public.audit_entries enable row level security;
alter table public.alerts enable row level security;
alter table public.notifications enable row level security;

revoke all on public.stores, public.sellers, public.profiles, public.goals,
  public.financiers, public.settings, public.imported_files, public.import_batches,
  public.sales, public.sale_items, public.payments, public.import_lines,
  public.consolidated_summaries, public.audit_entries, public.alerts,
  public.notifications from public, anon, authenticated;
grant select on public.stores, public.sellers, public.profiles, public.goals,
  public.financiers, public.settings, public.imported_files, public.import_batches,
  public.sales, public.sale_items, public.payments, public.import_lines,
  public.consolidated_summaries, public.audit_entries, public.alerts,
  public.notifications to authenticated;
grant insert, update, delete on public.sellers, public.goals, public.financiers,
  public.settings, public.imported_files, public.import_batches, public.sales,
  public.sale_items, public.payments, public.import_lines,
  public.consolidated_summaries, public.alerts to authenticated;
grant update (name) on public.stores to authenticated;
grant insert, delete on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

create policy stores_read on public.stores for select to authenticated
  using (id = public.current_store_id());
create policy stores_admin_update on public.stores for update to authenticated
  using (public.is_store_admin(id)) with check (public.is_store_admin(id));
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_store_admin(store_id));

create policy sellers_admin on public.sellers for all to authenticated
  using (public.is_store_admin(store_id)) with check (public.is_store_admin(store_id));
create policy sellers_own_read on public.sellers for select to authenticated
  using (store_id = public.current_store_id() and id = public.current_seller_id());

create policy goals_admin on public.goals for all to authenticated
  using (public.is_store_admin(store_id)) with check (public.is_store_admin(store_id));
create policy goals_seller_read on public.goals for select to authenticated
  using (store_id = public.current_store_id() and (seller_id is null or seller_id = public.current_seller_id()));

create policy financiers_admin on public.financiers for all to authenticated
  using (public.is_store_admin(store_id)) with check (public.is_store_admin(store_id));
create policy financiers_read on public.financiers for select to authenticated
  using (store_id = public.current_store_id());
create policy settings_admin on public.settings for all to authenticated
  using (public.is_store_admin(store_id)) with check (public.is_store_admin(store_id));
create policy settings_read on public.settings for select to authenticated
  using (store_id = public.current_store_id());

create policy files_admin on public.imported_files for all to authenticated
  using (public.is_store_admin(store_id)) with check (public.is_store_admin(store_id));
create policy batches_admin on public.import_batches for all to authenticated
  using (public.is_store_admin(store_id)) with check (public.is_store_admin(store_id));
create policy lines_admin on public.import_lines for all to authenticated
  using (public.is_store_admin(store_id)) with check (public.is_store_admin(store_id));

create policy sales_admin on public.sales for all to authenticated
  using (public.is_store_admin(store_id)) with check (public.is_store_admin(store_id));
create policy sales_seller_read on public.sales for select to authenticated
  using (store_id = public.current_store_id() and seller_id = public.current_seller_id());
create policy items_admin on public.sale_items for all to authenticated
  using (public.is_store_admin(store_id)) with check (public.is_store_admin(store_id));
create policy items_seller_read on public.sale_items for select to authenticated
  using (store_id = public.current_store_id() and exists (
    select 1 from public.sales s where s.id = sale_id and s.store_id = sale_items.store_id and s.seller_id = public.current_seller_id()
  ));
create policy payments_admin on public.payments for all to authenticated
  using (public.is_store_admin(store_id)) with check (public.is_store_admin(store_id));
create policy payments_seller_read on public.payments for select to authenticated
  using (store_id = public.current_store_id() and exists (
    select 1 from public.sales s where s.id = sale_id and s.store_id = payments.store_id and s.seller_id = public.current_seller_id()
  ));
create policy summaries_admin on public.consolidated_summaries for all to authenticated
  using (public.is_store_admin(store_id)) with check (public.is_store_admin(store_id));
create policy summaries_seller_read on public.consolidated_summaries for select to authenticated
  using (store_id = public.current_store_id() and seller_id = public.current_seller_id());

-- Auditoria é somente leitura no cliente; escritas ficam na RPC ou backend confiável.
create policy audit_admin_read on public.audit_entries for select to authenticated
  using (public.is_store_admin(store_id));
create policy alerts_admin on public.alerts for all to authenticated
  using (public.is_store_admin(store_id)) with check (public.is_store_admin(store_id));
create policy alerts_seller_read on public.alerts for select to authenticated
  using (store_id = public.current_store_id() and seller_id = public.current_seller_id());
create policy notifications_read on public.notifications for select to authenticated
  using (public.is_store_admin(store_id) or (store_id = public.current_store_id() and recipient_id = auth.uid()));
create policy notifications_admin_insert on public.notifications for insert to authenticated
  with check (public.is_store_admin(store_id));
create policy notifications_admin_delete on public.notifications for delete to authenticated
  using (public.is_store_admin(store_id));
create policy notifications_mark_read on public.notifications for update to authenticated
  using (store_id = public.current_store_id() and recipient_id = auth.uid())
  with check (store_id = public.current_store_id() and recipient_id = auth.uid());

-- O Supabase Storage já mantém RLS em storage.objects. Bucket sempre privado.
-- Somente administradores, com caminho <store_id>/<uuid>/<arquivo>, podem acessá-lo.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('imports', 'imports', false, 20971520, array[
  'text/csv', 'text/plain', 'application/csv', 'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy imports_storage_select on storage.objects for select to authenticated
  using (bucket_id = 'imports' and (storage.foldername(name))[1] = public.current_store_id()::text and public.is_store_admin(public.current_store_id()));
create policy imports_storage_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'imports' and (storage.foldername(name))[1] = public.current_store_id()::text and public.is_store_admin(public.current_store_id()));
create policy imports_storage_update on storage.objects for update to authenticated
  using (bucket_id = 'imports' and (storage.foldername(name))[1] = public.current_store_id()::text and public.is_store_admin(public.current_store_id()))
  with check (bucket_id = 'imports' and (storage.foldername(name))[1] = public.current_store_id()::text and public.is_store_admin(public.current_store_id()));
create policy imports_storage_delete on storage.objects for delete to authenticated
  using (bucket_id = 'imports' and (storage.foldername(name))[1] = public.current_store_id()::text and public.is_store_admin(public.current_store_id()));

commit;
