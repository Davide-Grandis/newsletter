---
description: Deploy the newsletter pipeline (workers + SPA) to the Cloudflare zone eneanewsletter.it
---

Full runbook is in `docs/deploy.md`. This workflow drives the steps that can
be automated; the dashboard / DNS / Email Routing parts still need a human.

## 1. Authenticate to the right account

```bash
npx wrangler whoami
```

If not logged in or wrong account:

```bash
npx wrangler login
```

## 2. Install dependencies (one-time)

// turbo
```bash
npm install
```

// turbo
```bash
cd web && npm install && cd ..
```

## 3. Provision Cloudflare resources (one-time)

NOT turbo — these create paid resources and print IDs the user needs.

```bash
npx wrangler d1 create newsletter_db
npx wrangler queues create newsletter-queue
npx wrangler queues create newsletter-dlq
npx wrangler r2 bucket create newsletter-archive
```

Capture the `database_id` printed by the first command.

## 4. Patch database_id into all six wrangler.toml files

Ask the user for the database_id, then:

```bash
DB_ID="<paste-here>"
for f in workers/{ingest,consumer,tracker,bounce,cleanup,admin}/wrangler.toml; do
  sed -i.bak "s/REPLACE_WITH_D1_ID/$DB_ID/" "$f" && rm "$f.bak"
done
grep database_id workers/*/wrangler.toml
```

## 5. Apply schema and seed the first author

```bash
npx wrangler d1 execute newsletter_db --remote --file=db/schema.sql
```

Authors are managed in D1 (replaces the old `ALLOWED_AUTHORS` env var).
Seed at least one row so the ingest worker accepts the first inbound mail:

```bash
npx wrangler d1 execute newsletter_db --remote \
  --command "INSERT INTO authors (email, name) VALUES ('davideg@cloudflare.com', 'Davide Grandis');"
```

## 6. Set secrets

NOT turbo — interactive prompts.

```bash
(cd workers/tracker  && npx wrangler secret put LINK_SIGNING_KEY)
(cd workers/tracker  && npx wrangler secret put ATTACHMENT_SIGNING_KEY)
(cd workers/consumer && npx wrangler secret put LINK_SIGNING_KEY)
(cd workers/consumer && npx wrangler secret put ATTACHMENT_SIGNING_KEY)
(cd workers/admin    && npx wrangler secret put ADMIN_TOKEN)
```

The two signing keys must be identical between consumer and tracker.
Generate values with `openssl rand -base64 48` (signing) and
`openssl rand -hex 32` (admin token).

## 7. Configure Email Routing + Email Sending in the dashboard

This step is manual. Direct the user to:

- Dashboard → eneanewsletter.it → Email → enable Email Routing
- Same panel → Email Sending → enable, add the DKIM TXT record
- Add a proxied DNS record `track.eneanewsletter.it`
- (Defer the Email Routing rules to step 9, after workers exist.)

## 8. Build SPA and deploy all workers

// turbo
```bash
npm run deploy:all
```

Capture the printed admin and tracker `*.workers.dev` URLs.

## 9. Add Email Routing rules

Manual. In the dashboard:

- `newsletter@eneanewsletter.it` → Send to Worker `newsletter-ingest`
- catch-all → Send to Worker `newsletter-bounce` (the worker filters
  `bounce+*` itself)

## 10. Bind tracker to custom hostname

Edit `workers/tracker/wrangler.toml` to uncomment:

```toml
routes = [{ pattern = "track.eneanewsletter.it/*", custom_domain = true }]
```

Then redeploy:

```bash
(cd workers/tracker && npx wrangler deploy)
```

## 11. Smoke test

```bash
npx wrangler tail newsletter-ingest
```

In another terminal, send a test mail to `newsletter@eneanewsletter.it`
from `davideg@cloudflare.com` and confirm the chain runs end-to-end.
