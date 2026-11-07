-- Attestra indexer schema. Events are the append-only source; the other tables are refreshed
-- from contract views whenever an event touches a record, so reapplying anything is harmless.

create table if not exists cursors (
  account text primary key,
  height bigint not null
);

create table if not exists events (
  id bigserial primary key,
  receipt_id text not null,
  log_index int not null,
  tx_hash text not null,
  signer_id text not null,
  contract text not null,
  standard text not null,
  event text not null,
  data jsonb not null,
  uid text,
  accounts text[] not null default '{}',
  block_height bigint not null,
  block_timestamp bigint not null,
  unique (receipt_id, log_index)
);
create index if not exists events_event on events (event);
create index if not exists events_uid on events (uid);
create index if not exists events_accounts on events using gin (accounts);
create index if not exists events_height on events (block_height desc, id desc);

create table if not exists schemas (
  uid text primary key,
  definition text not null,
  authority text not null,
  resolver text,
  revocable boolean not null,
  created_at bigint not null,
  status text not null,
  blob_hash text,
  tx_hash text,
  block_height bigint
);
create index if not exists schemas_authority on schemas (authority);

create table if not exists attestations (
  uid text primary key,
  schema_uid text not null,
  attester text not null,
  subject text not null,
  data text not null,
  created_at bigint not null,
  expiration_time bigint not null,
  revoked boolean not null,
  revocation_time bigint not null,
  revoke_at bigint not null,
  nonce bigint not null,
  ref_uid text,
  state text not null,
  tx_hash text,
  block_height bigint,
  revoke_tx_hash text
);
create index if not exists attestations_schema on attestations (schema_uid);
create index if not exists attestations_attester on attestations (attester);
create index if not exists attestations_subject on attestations (subject);
create index if not exists attestations_created on attestations (created_at desc);

create table if not exists authorities (
  account_id text primary key,
  metadata text not null,
  kind text not null,
  verified boolean not null,
  registered_at bigint not null,
  verified_at bigint not null,
  tier text,
  staked text not null default '0',
  delegate_count int not null default 0,
  tx_hash text
);

create table if not exists delegates (
  authority text not null,
  delegate text not null,
  record jsonb not null,
  primary key (authority, delegate)
);
create index if not exists delegates_delegate on delegates (delegate);

create table if not exists meta (
  key text primary key,
  value text not null
);
