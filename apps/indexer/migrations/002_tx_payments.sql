-- What the chain said about each transaction hash a review names as its job_ref: the payments it
-- made (payer, payee, asset, amount). Final transactions are kept for good; a hash the chain did
-- not know is kept with found = false and asked again after a while.
create table if not exists tx_payments (
  tx_hash text primary key,
  found boolean not null,
  final boolean not null,
  payments jsonb not null default '[]',
  checked_at bigint not null
);
