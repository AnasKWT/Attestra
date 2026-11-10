# @attestra/indexer

Reads Attestra's NEP-297 events from the FastNEAR transactions API into Postgres and serves them as a REST API on port 5100.

## Database

The service needs `DATABASE_URL`; the tests use `TEST_DATABASE_URL`, default `postgres://localhost:5432/attestra_test`.
Without a database at the default URL the database tests are skipped with a note; a set `TEST_DATABASE_URL` must be reachable.

A throwaway Postgres for both:

```bash
docker run -d --name attestra-pg -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine
docker exec attestra-pg createdb -U postgres attestra_test
docker exec attestra-pg createdb -U postgres attestra
TEST_DATABASE_URL=postgres://postgres@localhost:5432/attestra_test pnpm --filter @attestra/indexer test
```

Migrations in `migrations/` run on start.
