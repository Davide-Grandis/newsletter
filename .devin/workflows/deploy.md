---
description: Deploy the newsletter pipeline (workers + SPA) to the Cloudflare zone
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

## 5. Apply schema

One-shot bootstrap so the workers have tables to talk to. Authors,
subscribers, etc. are then managed through the admin GUI (step 12).

```bash
npx wrangler d1 execute newsletter_db --remote --file=db/schema.sql
```

## 6. Set secrets

NOT turbo — interactive prompts.

```bash
(cd workers/tracker  && npx wrangler secret put LINK_SIGNING_KEY)
(cd workers/tracker  && npx wrangler secret put ATTACHMENT_SIGNING_KEY)
(cd workers/consumer && npx wrangler secret put LINK_SIGNING_KEY)
(cd workers/consumer && npx wrangler secret put ATTACHMENT_SIGNING_KEY)
# Optional but recommended: lets the consumer read the account's daily sending
# quota for warmup, and the admin show it. Account → Email → Read.
(cd workers/consumer && npx wrangler secret put CF_READ_API_TOKEN)
# admin worker has no auth secret — protected by Cloudflare Access (step 11) —
# but takes the same CF_READ_API_TOKEN (Zone → Read + Account → Email → Read).
```

The two signing keys must be identical between consumer and tracker.
Generate values with `openssl rand -base64 48`.

## 7. Configure Email Routing + Email Sending in the dashboard

This step is manual. Direct the user to:

- Dashboard → your zone → Email → enable Email Routing
- Same panel → Email Sending → enable, add the DKIM TXT record
- Do NOT add a manual DNS record for the tracker hostname — the tracker's `custom_domain = true` route creates one on first deploy. Adding one manually causes "Hostname already has externally managed DNS records".
- (Defer the Email Routing rules to step 9, after workers exist.)

## 8. Build SPA and deploy all workers

// turbo
```bash
npm run deploy:all
```

Capture the printed admin and tracker `*.workers.dev` URLs.

## 9. Add Email Routing rules

Manual. In the dashboard:

- `newsletter@yourdomain.com` → Send to Worker `newsletter-ingest`
- catch-all → Send to Worker `newsletter-bounce` (the worker filters
  `bounce+*` itself)

## 10. Bind tracker to custom hostname

Edit `workers/tracker/wrangler.toml` to uncomment:

```toml
routes = [{ pattern = "track.yourdomain.com/*", custom_domain = true }]
```

Then redeploy:

```bash
(cd workers/tracker && npx wrangler deploy)
```

## 11. Put admin GUI behind Cloudflare Access (REQUIRED)

Manual. Zero Trust dashboard:

1. Access → Applications → Add → Self-hosted.
2. Application domain = the admin worker's `*.workers.dev` URL.
3. Identity provider: Google (or whatever the user prefers).
4. Policy: Allow `Emails: your@email.com` (or a Google group).

Without this, every `/api/*` call returns 401 — the admin worker has no
fallback authentication.

## 12. Bootstrap data via the admin GUI

Open the admin worker URL in a browser (Access prompts for SSO), then:

1. **Authors** page → add `your@email.com`. Inbound emails are
   rejected until at least one row exists in this table.
2. **Subscribers** page → add at least one test recipient.

## 13. Smoke test

```bash
npx wrangler tail newsletter-ingest
```

In another terminal, send a test mail to `newsletter@yourdomain.com`
from `your@email.com` and confirm the chain runs end-to-end.
