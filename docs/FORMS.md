# Forms, Ground Work and the admin console

Everything here runs inside the existing `accounts` service and its SQLite database. No third-party form service is involved.

## Where things live

| Address | What it is |
|---|---|
| `/` | Home: a short introduction (Vidura and the Geeta), then two paths, VN Reader and Ground Work |
| `/f/<form>` | A public form. Ground Work is `/f/groundwork` |
| `/go/<code>` | A custom share link (tracks where responses come from, can prefill answers) |
| `/admin` | The admin console. Separate from the reader; liquid glass by default |

The reader's logo now returns to the home page, including for signed-in readers.

## First run

1. Set `VN_ADMIN_EMAILS` to the owner's email (comma-separate several). Owners have every permission.
2. Deploy as usual: `docker compose up -d --build`.
3. Open `/admin` and sign in with that reader account.

The Ground Work form is created automatically on first start, rebuilt from the original SurveyHeart form: the same questions, split into four pages, with state and district added so responses can be viewed state by state. The group link is a setting of the form (Edit form → After submitting), never sent to a browser until that person's response is approved.

## Admin console

- **Responses**: search, filter by status, state, source link, any answer and date; choose columns; approve or reject one or many; notes; CSV and JSON export.
- **Statistics**: smart insights, responses over time, a state and district map, funnel from opening to approval, share-link performance, devices, time of day, and a chart per question.
- **Edit form**: question types (short and long text, number, email, phone, link, single and multiple choice, dropdown, yes/no, Indian state, rating, scale, date, time, consent, statement), pages, show-if conditions, skip-to-page rules, answer piping (`{{question}}`), validation, accent colour, fonts including an uploaded font, surface, backdrop and corner radius, schedule, response limit, one response per device or account.
- **Share**: custom links with prefilled answers and per-link statistics, QR codes (PNG and SVG).
- **Team and access**: owners add admins by email with any mix of permissions (view forms, edit forms, manage links, view, review, export and delete responses, view statistics, view reader activity, change settings, manage admins), optionally limited to specific forms. Every change is in the audit log.
- **Reader activity**: the previous in-reader admin dashboard (registrations, sign-ins, email allowance, media storage).
- **Backups and Telegram**: bot token, backup channel or group (and topic), switches for notifications.

### Sample data

New admins and reviewers can see a populated console before real responses arrive. Turn on **Sample data** in the sidebar, or choose **Explore sample data** on the Forms page or an empty Responses tab.

- About 40 made-up responses are drawn from each form's own questions, rules and options: names, ages, states and districts, contact details, choices, written answers, share links, devices, times of day and review statuses. They pass the form's own validation.
- Every view uses them through the same code as real data: Responses and filters, each response's answers, Statistics (overview, Places map, reach and timing, answers), the form counts on the Forms page and the review badges in the sidebar.
- A violet **Demo data** label and a banner stay on screen while it is on. **Back to real data** switches back at once. Sample mode lasts for the current tab only, so a new visit always opens on real data.
- Approving, rejecting, notes and deleting work on the sample, so people can practise, but only inside the preview. **Reset** starts the sample again.
- Each admin has a separate sample, kept in memory on the server for a few hours. Sample responses are never written to the database, R2 or the Telegram backup channel, never counted in real statistics, and never sent as notifications or emails. Exports and backups refuse to run in sample mode, and contact links (WhatsApp, Telegram, social profiles) are not linked, so nothing points at real people. Contacts use reserved example numbers and `example.com` addresses.
- Permissions are unchanged: sample mode shows only the forms and actions a person's role already allows. A reviewer can approve sample responses but cannot delete them.

The server side lives in `server/formsSample.mjs`; the console asks for it with the `X-VN-Sample: 1` header.

### Temporary reviewers

For a demo or a short outside review, create a reader account with exactly the **Reviewer** role (view forms, view and review responses, view statistics), limited to named forms, that stops working at a set time:

```bash
docker compose exec accounts node server/tempReviewer.mjs create --email demo.reviewer@example.com --form groundwork --hours 72
docker compose exec accounts node server/tempReviewer.mjs list
docker compose exec accounts node server/tempReviewer.mjs revoke --email demo.reviewer@example.com
docker compose exec accounts node server/tempReviewer.mjs sweep
```

`create` prints a generated password once (or writes it to `--password-file`, readable only by you). The tool refuses owner addresses, existing admins and existing reader accounts, so it never changes anyone's real access. Access ends at the expiry time on its own: Team and access shows **Until …** and then **Expired**, and the console refuses that account. `revoke` (any time) and `sweep` (everything expired; safe to run from cron) remove the access and the reader account the tool made, with an entry in the audit log.

### Places map

Statistics → Places uses the state and district reported in each response. Switch between heatmap, proportional bubbles and spikes. The map and sortable table can use the same time window and units or be compared side by side with independent settings. Use the review-status shortcuts or metric picker to change the map, and select a region to open filtered responses. Auto fits the scale to the current map. A fixed or custom maximum keeps the same scale when comparing regions. Per-capita rates use the October 2021 COVID19India population snapshot; places without an estimate are left blank in rate views. Districts without a boundary, and older answers whose district could not be identified, remain visible in the table.

- Interaction reference: [COVID19India map and table](https://github.com/covid19india/covid19india.github.io).
- Population: [COVID19India v4 data](https://github.com/covid19india/data), October 31, 2021 snapshot. Only population estimates are included in the map asset.
- Geometry: [LGD district layer via bharatlas](https://bharatlas.com/view/lgd_districts), projected and simplified for display. The asset uses the current district names from the form's November 2026 LGD snapshot. Older polygons can differ from today's district boundaries.

## Sharing a form

Every form link (`/f/<form>` and custom `/go/<code>` links) carries its own title, description and picture when pasted into Telegram, WhatsApp, X or search. The picture is drawn automatically from the form's title and description and redraws when you save the form. Upload your own in Share → Link preview (any image; it's cropped to 1200 × 630). The home page uses `public/og/vidurneeti.png`. Apps cache previews, so a link shared before a change may keep its old card for a while.

Requires the updated `deploy/Caddyfile`, which sends `/f/*`, `/go/*` and `/sitemap.xml` to the accounts service.

Ground Work and other public forms save answers and the active page or question on this device. Returning applicants resume that step. If the path has changed, or an earlier applicable step needs an answer, the form reopens at the first incomplete step. Start over clears the draft.

## Several responses from one device

The confirmation page always offers "Submit another response" (unless the form is limited to one per reader account). Every response sent from a browser is remembered there, and a switcher at the top of the status page moves between them.

## How applicants hear back

After submitting, the confirmation page offers three ways, all optional:

- **Telegram**: “Get updates” opens the bot with a one-time code. Pressing Start binds that response to that Telegram account. The bot then messages them on approval (with the group link as a button), and `/status` shows a person only the responses bound to their own account. Filling the form from inside the bot's web app binds automatically.
- **Email**: one email when the response is reviewed, sent through the existing SMTP setup and counted in `VN_EMAIL_DAILY_LIMIT`.
- **Private link**: a status link that works on any device. The secret part sits after `#`, which browsers do not send to servers.

The bot replies come from the archive service's existing Telegram bot (`TELEGRAM_BOT_TOKEN`), which asks the accounts service over the private Docker network (`VN_ACCOUNTS_URL`, default `http://accounts:3005`). Use the same bot token in the console so the web app button, backups and direct messages all come from one bot.

## Storage and backups

- **Primary**: SQLite, in the `account-data` volume.
- **R2**: every response is mirrored as JSON to a private bucket: `R2_FORMS_BUCKET`, under `R2_FORMS_PREFIX` (default `forms/`). Create it in the **same Cloudflare account** as the media bucket: R2 → Create bucket, name it e.g. `vn-forms-private`, and leave Public access and Custom domains off. A private bucket needs no domain. The free tier (10 GB) is shared by all buckets in the account; a response is a few KB, so 10,000 responses use roughly 50 MB. If your R2 API token is limited to the media bucket, edit it to include the new bucket, or create a separate token and set the `R2_FORMS_*` keys. The server refuses to use the public media bucket, because everything in it is reachable through `media.vidurneeti.xyz`.
- **Telegram**: each new response, each decision, and on-demand full backups (JSON and CSV) go to the backup channel set in the console. The bot must be an admin of that channel.

Responses contain addresses and phone numbers. Keep the backup channel private and limit who has the export permission.

## Telegram web app

In Backups and Telegram, “Set web app button” makes the bot's menu button open `https://<your domain>/`, so the whole site, including forms, works inside Telegram.
