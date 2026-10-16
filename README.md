# ☕ Chai Khata — digital ledger for a tea stall

A static web app (HTML + CSS + vanilla JS) that runs on **GitHub Pages**, with **Supabase** (Postgres, Auth, Row Level Security, Edge Functions) as the backend. No Node.js, npm or build step.

```
index.html                              app entry point
style.css                               styling
app.js                                  application logic
supabase.js                             Supabase URL + publishable key (placeholders)
supabase-setup.sql                      schema, triggers, RLS, RPC functions, seed helpers
functions/create-customer/index.ts      Edge Function: create customer + initial password
functions/reset-customer-password/index.ts   Edge Function: owner resets a customer's password
README.md
```

## How it works (short version)

* **Owner** signs in with email + password. **Customers** sign in with mobile number (or a username) + password.
* Customers are real Supabase Auth users. Because customers have no email, the Edge Function creates each one with an internal address derived from the **owner's real email** using plus-addressing, e.g. `ramesh+ck9876543210@gmail.com` (Supabase rejects made-up domains that have no mail server). The login box converts mobile/username to that address through a small database function (`resolve_login`). Customers never see it.
* **Notifications:** whenever the owner records a purchase, payment, adjustment or reversal, the customer's dashboard shows a 🔔 bell with an unread count, a "new updates" banner, and a feed with the **date and time** of each update. If Supabase Realtime is on (the SQL script enables it for the `transactions` table) they also get an instant pop-up while the app is open; otherwise the app checks every minute.
* **Initial password** = first 3 letters of the first name (lowercase) + first 4 digits of the mobile. Example: *Ramesh*, `9876543210` → `ram9876`. Names with fewer than 3 Latin letters are padded with `x` (*Om* → `omx9876`). The customer is forced to choose a new password at first login.
* Every money action goes through a database function that checks the caller is the owner, validates input, **reads the product price on the server** (price snapshot stored with each purchase), and is **idempotent** (double-taps and retries can't create duplicates).
* Ledger rows are **append-only**: update/delete/truncate are blocked by triggers. Fix mistakes with **Reverse**, which adds a mirror entry and keeps the original.
* **Balance** = purchases + debit adjustments − payments − credit adjustments (reversals net out their original).
* All times are stored as UTC timestamps and displayed in **Asia/Kolkata**; each row also stores its IST calendar date for daily reports.

---

## Setup steps

### 1. Create a Supabase project
1. Go to <https://supabase.com> → **New project** (free tier is fine). Pick the Mumbai region for speed in India.
2. Wait until it finishes provisioning.

### 2. Run the database script
1. Supabase dashboard → **SQL Editor → New query**.
2. Paste the entire contents of `supabase-setup.sql` and click **Run**. It is safe to run again.

### 3. Create the owner account
1. Dashboard → **Authentication → Users → Add user → Create new user**. Enter your email and a strong password and tick **Auto Confirm User**.
2. Back in the SQL Editor run (use your own email and names):
   ```sql
   select public.bootstrap_owner('owner@example.com', 'Sharma Chai Stall', 'Ramesh Sharma');
   ```
3. Optional — add typical products (tea, coffee, biscuits, cigarettes, snacks):
   ```sql
   select public.seed_demo_data((select id from public.stalls limit 1));
   ```
   Run it again **after** you've added a few test customers to also generate a week of sample purchases and a payment for each (only for customers that have no transactions yet). Skip this on your real data.

### 4. Auth settings
Dashboard → **Authentication**:
* **Sign In / Providers → Email**: keep *Email* enabled. **Disable "Allow new users to sign up"** so strangers can't create accounts (customers are created only by the Edge Function).
* **URL Configuration**: set **Site URL** to your GitHub Pages address (step 7) and add the same URL to **Redirect URLs**. This is needed for the owner's *Forgot password* email link.
* Password policy: set a minimum length of at least 8 if you like (the app also enforces 8 characters with letters + numbers when changing passwords; the generated initial passwords are 7 characters, so keep the minimum at **6 or 7** or the Edge Function will fail).

### 5. Deploy the Edge Functions
The functions hold the only code that uses the service-role key; Supabase injects it automatically, so you never paste it anywhere.

**Option A — Supabase CLI (recommended)**
```bash
npm i -g supabase            # or use any install method from the Supabase docs
supabase login
supabase init                # in an empty folder
mkdir -p supabase/functions
# copy the two folders from this repo's functions/ into supabase/functions/
supabase link --project-ref YOUR-PROJECT-REF
supabase functions deploy create-customer --no-verify-jwt
supabase functions deploy reset-customer-password --no-verify-jwt
```
(`--no-verify-jwt` is safe here: both functions check the caller's login token themselves and only allow the stall owner. It avoids the "Invalid JWT" rejection that newer Supabase projects can hit at the gateway.)
(The repo keeps them under `functions/` as requested; the CLI expects `supabase/functions/`.)

**Option B — Dashboard only (no CLI)**
Dashboard → **Edge Functions → Deploy a new function → Via Editor**. Create `create-customer`, paste the contents of `functions/create-customer/index.ts`, deploy. Repeat for `reset-customer-password`. Turn **Verify JWT** **off** for both (the code verifies the owner's login itself).

Optional secrets (Edge Functions → Secrets):
* `ALLOWED_ORIGIN` — e.g. `https://username.github.io` to restrict browser callers (default `*`; the functions still require the owner's login).
* `LOGIN_EMAIL_DOMAIN` — optional. Leave it unset: internal customer emails are derived from the owner's email. Only set it if you own a real domain and prefer `9876543210@yourdomain.com`.

### 6. Add your project keys to the frontend
Dashboard → **Project Settings → API** (or **API Keys**). Open `supabase.js` and replace:
```js
SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
SUPABASE_PUBLISHABLE_KEY: 'YOUR-PUBLISHABLE-OR-ANON-KEY'
```
Use the **publishable** key (or the legacy **anon** key). These two values are meant to be public. **Never** put the `service_role` / secret key in any file in this repo.

### 7. Publish on GitHub Pages
1. Create a repository (e.g. `chai-khata`). On GitHub: **Add file → Upload files**, drag in `index.html`, `style.css`, `app.js`, `supabase.js`, `qrcode.js`, `README.md`, `supabase-setup.sql` and the `functions` folder (Chrome/Edge can drag whole folders). Commit.
2. **Settings → Pages → Build and deployment**: Source *Deploy from a branch*, Branch `main`, folder `/ (root)`. Save.
3. After a minute your app is live at `https://USERNAME.github.io/chai-khata/`.
4. Put that URL into Supabase **Authentication → URL Configuration** (step 4).

All asset paths are relative (`style.css`, `app.js`, `supabase.js`, `qrcode.js`), so it works on a project URL like `/chai-khata/`. Navigation uses `#/…` hashes, so no server rewrites are needed.

### 8. First run
1. Open the site and sign in with the owner email and password.
2. **Products** → add or review prices.
2b. **More → Settings** → enter your **UPI ID** (e.g. `yourstall@okhdfc`) so reminders and the customer "Pay your dues" card can show a payment QR.
3. **Customers → + Add customer** → enter name + mobile. You'll see the initial password once, with **Copy** and **Send on WhatsApp** buttons.
4. **New Entry** (the orange ＋ button) → type a name/mobile or tap a recent customer → tap products → **Record purchase** → **Next customer**. Use the **Payment** tab for Cash/UPI/Other.
5. Sign in as that customer (mobile + initial password in another browser/private window) to verify they're forced to change the password and only see their own ledger.

---

## Feature guide

| Area | What you get |
|---|---|
| Owner dashboard | Today's sales/collections, outstanding total, top dues, recent activity |
| New entry | Always-visible customer search, recent-customer chips, no "change customer" step, popular products first, sticky record bar, quick payment amounts, "Next customer" after saving; entry buttons on every customer row |
| Dues & reminders | Dues list, 💬 **Remind** per customer or a one-by-one reminder round: WhatsApp message with amount due + UPI QR (**Share QR image**, or download) |
| Customers | Add/edit/search, active/inactive, per-customer ledger with date filter, reset password, CSV export |
| Products | Add, edit price (past bills unaffected), hide/show |
| Transactions | All entries by date/type/customer, **Reverse** with a mandatory reason, itemised CSV |
| Reports | Daily sales + collections split by Cash/UPI/Other, outstanding-balances CSV |
| Customer app | 🔔 Notifications (unread bell + feed with date/time), balance hero, itemised ledger (product, qty, unit price, total, date, time, notes), date filter, profile, change password |

## Security model

* **RLS everywhere.** Customers can read only their own profile/transactions/items. Only the owner of a stall can read its products and all customers' data. Cross-stall access is blocked.
* **No direct writes** to ledger tables from the browser: there are no INSERT/UPDATE/DELETE policies on `transactions` / `transaction_items`, and table privileges are revoked. Writes happen only via `record_purchase`, `record_payment`, `record_adjustment`, `reverse_transaction` (SECURITY DEFINER, owner-checked).
* **Owner can edit customers only in whitelisted columns** (`full_name`, `username`, `notes`, `is_active`) — role, stall, mobile and the password-change flag cannot be changed from the browser.
* **Service-role key** exists only inside the Edge Functions' environment.
* **Audit log** table records inserts/updates to stalls, profiles, products and transactions (read-only, append-only).
* Deleting an Auth user that owns ledger rows is blocked (`ON DELETE RESTRICT`). Deactivate customers instead.
* `resolve_login` returns a dummy address for unknown logins, so it doesn't reveal which mobiles are registered.

### Password reset
* **Customers:** owner opens *Customers → Edit → Reset password*. A random temporary password is generated server-side and shown once; the customer must change it at next login.
* **Owner:** *Forgot password?* on the login screen emails a reset link (uses Supabase's built-in email; configure custom SMTP in Supabase for production volume).

## Limitations & notes
* Purchases need an active customer; payments, adjustments and reversals work for inactive customers too.
* Reversals are dated on the day they are made, so daily reports show the correction on that day.
* Existing sessions of a customer are not revoked when the owner resets their password; they simply have to use the new one next time. Deactivating a customer blocks the app on their next load.
* Supabase's free-tier project pauses after a week of inactivity; open the dashboard to resume it.

## Troubleshooting
| Symptom | Fix |
|---|---|
| "Chai Khata needs setup" screen | `supabase.js` still has the placeholders |
| "Incorrect login or password" for the owner | Make sure you ran `bootstrap_owner` with the same email, and the user is confirmed |
| Signed in but "account is not set up" | Owner profile missing — run step 3 |
| "…function is not deployed in this Supabase project (404)" | Deploy both functions (step 5), named exactly `create-customer` and `reset-customer-password` |
| "Request failed" / "function failed (HTTP …)" when adding a customer | The message now includes the HTTP status. Open **Dashboard → Edge Functions → create-customer → Logs**. Most common fixes: deploy with Verify JWT off, check the function name, redeploy after replacing the file |
| Create customer shows "Could not create the login: …" | The message after the colon is Supabase's real reason. Typical: password policy (minimum length must be ≤ 7, and turn off "leaked password protection" or it may reject `ram9876`-style passwords) or "email invalid". Redeploy `create-customer` after any update and check **Edge Functions → Logs** |
| Customers don't get the bell / live alerts | Re-run `supabase-setup.sql` (adds the unread tracking + Realtime) and make sure Realtime isn't disabled for the project. The bell still works without Realtime; alerts then arrive within a minute |
| Reset-password email link lands on the login page | Add your GitHub Pages URL to **Redirect URLs** (step 4) |
| Blank page on GitHub Pages | Pages enabled? Files uploaded to the repository root (not inside a sub-folder)? |


---

## Updating an existing install (v2)
1. Re-run `supabase-setup.sql` in the SQL Editor (safe to repeat; adds the `upi_id` column).
2. Upload the new `index.html`, `style.css`, `app.js` **and the new `qrcode.js`**.
3. Add your UPI ID in Settings.

**WhatsApp note:** a WhatsApp link can only carry text, not an image. The reminder opens the chat with the message (amount + UPI ID + pay link); to attach the QR, tap **Share QR image + message** (phones) or download the QR and attach it. Customers can also open **Pay your dues** in their own app.
