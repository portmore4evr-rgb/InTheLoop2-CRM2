# InTheLoop CRM

Internal CRM for managing restaurant leads through your pipeline, viewing restaurant
profiles, and tracking high-level performance across your book of business.

## Features
- **Pipeline** — 5-stage lead pipeline (New Lead → Discovery Call → Offer Designed →
  Onboarding → Live Client), with one-click stage advancement per card.
- **Restaurants** — a table view of every restaurant you've talked to, with their
  slowest night, current offer, and stage.
- **Analytics** — total leads, live clients, conversion rate, deals closed in the last
  30 days, a pipeline funnel chart, and recent activity.

No leads are pre-loaded — add your first one with the "+ Add Lead" button.

## Reward IDs (Tap to Regular)
- Every guest who opts in on `/checkin/<restaurantId>` (phone required, email optional, SMS consent box required)
  gets a unique Reward ID like `MAMA-0007-K3`: restaurant code + running count + 2 random characters.
- Same phone or email at the same restaurant = same guest: they get their existing ID back, never a second one.
- Staff redeem on `/redeem/<restaurantId>` with the Reward ID + the restaurant's 4-digit staff PIN (shown in the CRM).
  Rewards are for the NEXT visit: not on sign-up day, max once per guest per day. Every attempt is logged.
- Phones are stored as +1XXXXXXXXXX so Twilio STOP replies match correctly.

## Security + data
- Set `ADMIN_PASSWORD` in Railway Variables to password-protect the CRM (guest and staff pages stay public).
- Attach a Railway Volume mounted at `/app/data` and set `DATA_DIR=/app/data` so data survives redeploys.
- Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` to send real texts (otherwise simulated).

## Tech stack
- Node.js + Express (single server, serves both the API and the front end)
- Data is stored in `data/db.json` — a flat JSON file, no external database required
- Vanilla HTML/CSS/JS front end (Tailwind via CDN) — no build step

## Run locally
```bash
npm install
npm start
```
Then open http://localhost:3000

## Deploy to Railway
Railway builds Node apps automatically from a GitHub repo — no Dockerfile needed.

1. Push this folder to a new GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "InTheLoop CRM"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/intheloop-crm.git
   git push -u origin main
   ```
2. In Railway: **New Project → Deploy from GitHub repo** → select `intheloop-crm`.
3. Railway detects `package.json` automatically, runs `npm install` then `npm start`.
4. Once deployed, go to the service's **Settings → Networking** and click
   **Generate Domain** to get your live `*.up.railway.app` link.

## A note on data persistence
`data/db.json` lives on the container's local disk. Railway containers are ephemeral —
a redeploy will reset it back to empty. For real production use once you're adding
real leads, attach a Railway **Volume** mounted at `/app/data` (Settings → Volumes) so
the file survives redeploys, or migrate to Railway's Postgres plugin later if the
pipeline grows past what a flat file comfortably handles.
