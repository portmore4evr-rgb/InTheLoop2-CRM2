# InTheLoop: restyle + landing page update

These are drop-in files for the **InTheLoop2-CRM2** repo. Everything keeps the same HTML/Tailwind setup, element IDs and features. Only the look changed, plus a new landing page.

## Copy these into your repo (replace the existing files)
- `server.js` (adds `/welcome` and the booking form endpoint `/api/public/book`)
- `public/index.html` (CRM)
- `public/checkin.html`
- `public/redeem.html`
- `public/welcome.html` (NEW landing page)
- `public/js/app.js`
- `public/js/checkin.js` (unchanged, but must be in `public/js/`)
- `public/js/redeem.js`
- `public/js/welcome.js` (NEW)

Note: your repo's live `public/` folder is older than `intheloop-reward-ids-update/public/`. These files are based on the newer reward-ID version, so copy all of them into `public/`.

## Add the video
1. Open **InTheLoop VSL.dc.html** → Share → Export → Video (captions are on).
2. Save it as `public/media/intheloop-vsl.mp4`.
3. Optional: add a poster image at `public/media/intheloop-vsl-poster.jpg`.

Until the MP4 is uploaded, the landing page shows a placeholder.

## What happens when someone books
The booking form on `/welcome` creates a **New Lead** in your Pipeline. It saves the restaurant name, phone, email and preferred meeting time (in Notes).

## Commit
```bash
git add .
git commit -m "Warm Organic restyle + /welcome landing page with VSL and booking"
git push
```
Railway redeploys automatically.
