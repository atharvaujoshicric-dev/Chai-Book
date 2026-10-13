// Edge Function: create-customer
// Called by the logged-in OWNER from the browser. It uses the service-role key,
// which exists only here on the server (Supabase injects it as an env variable).
//
// Creates: (1) a Supabase Auth user with a generated initial password
//          (2) a `profiles` row with must_change_password = true
// Initial password = first 3 letters of the first name (lowercase a-z)
//                    + first 4 digits of the mobile number.
// Names with fewer than 3 Latin letters are padded with "x" (e.g. "Om" -> "omx").

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeMobile(raw: string): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9][0-9]{9}$/.test(d) ? d : null;
}

function initialPassword(fullName: string, mobile: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? "";
  const letters = first.toLowerCase().replace(/[^a-z]/g, "");
  return (letters + "xxx").slice(0, 3) + mobile.slice(0, 4);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return json({ error: "Server is not configured." }, 500);
    const loginDomain = Deno.env.get("LOGIN_EMAIL_DOMAIN") ?? "chaikhata.example";

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // 1. Authenticate the caller from their JWT
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Please sign in again." }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Your session has expired. Please sign in again." }, 401);

    // 2. Authorize: caller must be an active owner
    const { data: caller } = await admin
      .from("profiles")
      .select("id, stall_id, role, is_active")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (!caller || caller.role !== "owner" || !caller.is_active) {
      return json({ error: "Only the stall owner can add customers." }, 403);
    }

    // 3. Validate input
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

    const fullName = String(body.full_name ?? "").trim().replace(/\s+/g, " ");
    const mobile = normalizeMobile(String(body.mobile ?? ""));
    const usernameRaw = String(body.username ?? "").trim().toLowerCase();
    const username = usernameRaw === "" ? null : usernameRaw;
    const notes = String(body.notes ?? "").trim() || null;

    if (fullName.length < 2 || fullName.length > 80) return json({ error: "Enter the customer's full name (2–80 characters)." }, 400);
    if (!mobile) return json({ error: "Enter a valid 10-digit Indian mobile number." }, 400);
    if (username !== null && !/^[a-z][a-z0-9._]{2,29}$/.test(username)) {
      return json({ error: "Username must be 3–30 characters: letters, digits, dot or underscore, starting with a letter." }, 400);
    }
    if (notes && notes.length > 300) return json({ error: "Notes are too long (max 300 characters)." }, 400);

    // 4. Duplicate checks
    const { data: dupMobile } = await admin.from("profiles").select("id").eq("mobile", mobile).maybeSingle();
    if (dupMobile) return json({ error: "A customer with this mobile number already exists." }, 409);
    if (username) {
      const { data: dupUser } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
      if (dupUser) return json({ error: "This username is already taken." }, 409);
    }

    // 5. Create the auth user with the generated initial password
    const password = initialPassword(fullName, mobile);
    const loginEmail = `${mobile}@${loginDomain}`;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: loginEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role: "customer" },
    });
    if (createErr || !created?.user) {
      console.error("createUser failed:", createErr?.message);
      return json({ error: "Could not create the account. If this keeps happening, see the README troubleshooting section." }, 400);
    }

    // 6. Create the profile; roll back the auth user if that fails
    const { error: profileErr } = await admin.from("profiles").insert({
      id: created.user.id,
      stall_id: caller.stall_id,
      role: "customer",
      full_name: fullName,
      mobile,
      username,
      login_email: loginEmail,
      must_change_password: true,
      notes,
      created_by: caller.id,
    });
    if (profileErr) {
      console.error("profile insert failed:", profileErr.message);
      await admin.auth.admin.deleteUser(created.user.id);
      return json({ error: "Could not save the customer. Please try again." }, 500);
    }

    return json({
      customer_id: created.user.id,
      full_name: fullName,
      mobile,
      username,
      initial_password: password,
    });
  } catch (err) {
    console.error("create-customer error:", err instanceof Error ? err.message : err);
    return json({ error: "Unexpected server error." }, 500);
  }
});
