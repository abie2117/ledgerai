-- ============================================================
-- HARDEN ACCOUNTING SETUP WRITE PERMISSIONS
--
-- Replaces the original broad FOR ALL policies on accounts/categories.
-- All firm members retain read access. Only owner/admin/bookkeeper roles
-- may write accounting setup data through ordinary authenticated RLS.
--
-- Server-side Plaid ingestion uses the service role and is unaffected.
-- ============================================================

drop policy if exists "firm members can access accounts for their clients"
  on accounts;

drop policy if exists "firm members can access categories"
  on categories;

-- ------------------------------------------------------------
-- ACCOUNTS
-- ------------------------------------------------------------

create policy "firm members can view accounts for their clients"
on accounts
for select
using (
  plaid_item_id in (
    select pi.id
    from plaid_items pi
    join clients c on c.id = pi.client_id
    where c.firm_id in (select firm_id from my_firms)
  )
);

create policy "accounting roles can insert accounts for their clients"
on accounts
for insert
with check (
  exists (
    select 1
    from plaid_items pi
    join clients c on c.id = pi.client_id
    join firm_users fu on fu.firm_id = c.firm_id
    where pi.id = accounts.plaid_item_id
      and fu.user_id = auth.uid()
      and fu.role in ('owner', 'admin', 'bookkeeper')
  )
);

create policy "accounting roles can update accounts for their clients"
on accounts
for update
using (
  exists (
    select 1
    from plaid_items pi
    join clients c on c.id = pi.client_id
    join firm_users fu on fu.firm_id = c.firm_id
    where pi.id = accounts.plaid_item_id
      and fu.user_id = auth.uid()
      and fu.role in ('owner', 'admin', 'bookkeeper')
  )
)
with check (
  exists (
    select 1
    from plaid_items pi
    join clients c on c.id = pi.client_id
    join firm_users fu on fu.firm_id = c.firm_id
    where pi.id = accounts.plaid_item_id
      and fu.user_id = auth.uid()
      and fu.role in ('owner', 'admin', 'bookkeeper')
  )
);

create policy "accounting roles can delete accounts for their clients"
on accounts
for delete
using (
  exists (
    select 1
    from plaid_items pi
    join clients c on c.id = pi.client_id
    join firm_users fu on fu.firm_id = c.firm_id
    where pi.id = accounts.plaid_item_id
      and fu.user_id = auth.uid()
      and fu.role in ('owner', 'admin', 'bookkeeper')
  )
);

-- ------------------------------------------------------------
-- CATEGORIES / CHART OF ACCOUNTS
-- A category can be firm-level (firm_id) or client-specific (client_id).
-- Writes require an accounting role in the owning firm.
-- ------------------------------------------------------------

create policy "firm members can view categories"
on categories
for select
using (
  firm_id in (select firm_id from my_firms)
  or client_id in (
    select id
    from clients
    where firm_id in (select firm_id from my_firms)
  )
);

create policy "accounting roles can insert categories"
on categories
for insert
with check (
  (
    firm_id is not null
    and exists (
      select 1
      from firm_users fu
      where fu.firm_id = categories.firm_id
        and fu.user_id = auth.uid()
        and fu.role in ('owner', 'admin', 'bookkeeper')
    )
  )
  or
  (
    client_id is not null
    and exists (
      select 1
      from clients c
      join firm_users fu on fu.firm_id = c.firm_id
      where c.id = categories.client_id
        and fu.user_id = auth.uid()
        and fu.role in ('owner', 'admin', 'bookkeeper')
    )
  )
);

create policy "accounting roles can update categories"
on categories
for update
using (
  (
    firm_id is not null
    and exists (
      select 1
      from firm_users fu
      where fu.firm_id = categories.firm_id
        and fu.user_id = auth.uid()
        and fu.role in ('owner', 'admin', 'bookkeeper')
    )
  )
  or
  (
    client_id is not null
    and exists (
      select 1
      from clients c
      join firm_users fu on fu.firm_id = c.firm_id
      where c.id = categories.client_id
        and fu.user_id = auth.uid()
        and fu.role in ('owner', 'admin', 'bookkeeper')
    )
  )
)
with check (
  (
    firm_id is not null
    and exists (
      select 1
      from firm_users fu
      where fu.firm_id = categories.firm_id
        and fu.user_id = auth.uid()
        and fu.role in ('owner', 'admin', 'bookkeeper')
    )
  )
  or
  (
    client_id is not null
    and exists (
      select 1
      from clients c
      join firm_users fu on fu.firm_id = c.firm_id
      where c.id = categories.client_id
        and fu.user_id = auth.uid()
        and fu.role in ('owner', 'admin', 'bookkeeper')
    )
  )
);

create policy "accounting roles can delete categories"
on categories
for delete
using (
  (
    firm_id is not null
    and exists (
      select 1
      from firm_users fu
      where fu.firm_id = categories.firm_id
        and fu.user_id = auth.uid()
        and fu.role in ('owner', 'admin', 'bookkeeper')
    )
  )
  or
  (
    client_id is not null
    and exists (
      select 1
      from clients c
      join firm_users fu on fu.firm_id = c.firm_id
      where c.id = categories.client_id
        and fu.user_id = auth.uid()
        and fu.role in ('owner', 'admin', 'bookkeeper')
    )
  )
);

comment on column accounts.coa_category_id is
  'Client-specific posting account mapped to this connected financial account. Ordinary authenticated writes require an owner, admin, or bookkeeper role.';
