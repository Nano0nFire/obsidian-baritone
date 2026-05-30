# Server integration tests

These tests are env-gated and are skipped by the normal `vitest run` unless explicitly enabled.

```bash
docker compose -f deploy/docker-compose.test.yml up -d
RUN_INTEGRATION=1 \
DATABASE_URL=postgres://obsidian_test:obsidian_test_pw@127.0.0.1:15432/obsidian_sync_test \
S3_ENDPOINT=http://127.0.0.1:19000 \
S3_BUCKET=obsidian-sync-test \
S3_ACCESS_KEY=minio_test \
S3_SECRET_KEY=minio_test_pw \
S3_REGION=us-east-1 \
npx vitest run packages/server/src/__tests__/integration

docker compose -f deploy/docker-compose.test.yml down -v
```

Each test resets the throwaway Postgres `public` schema before running migrations. Do not point `DATABASE_URL` at a persistent database.
