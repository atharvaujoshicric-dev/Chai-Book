// Edge Function: reset-customer-password
// Called by the logged-in OWNER. Generates a random temporary password for one
// customer of the owner's stall, sets it in Supabase Auth, and flags the profile
// so the customer must choose a new password at next login.
// (Owners reset their own password with the "Forgot password" email link.)

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

// Unambiguous characters only (no 0/O, 1/l/I) so it is easy to read out over the counter.
function tempPassword(length = 10): string {
  const letters = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = letters + digits;
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => all[b % all.length]);
  // guarantee at least one letter and one digit
  chars[0] = letters[bytes[0] % letters.length];
  chars[length - 1] = digits[bytes[length - 1] % digits.length];
  return chars.join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    // Preflight: echo back whatever headers the browser says it will send (see create-customer).
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Headers": req.headers.get("Access-Control-Request-Headers") ?? corsHeaders["Access-Control-Allow-Headers"],
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return json({ error: "Server is not configured." }, 500);

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Please sign in again." }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Your session has expired. Please sign in again." }, 401);

    const { data: caller } = await admin
      .from("profiles")
      .select("id, stall_id, role, is_active")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (!caller || caller.role !== "owner" || !caller.is_active) {
      return json({ error: "Only the stall owner can reset customer passwords." }, 403);
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
    const customerId = String(body.customer_id ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId)) {
      return json({ error: "Invalid customer." }, 400);
    }

    const { data: target } = await admin
      .from("profiles")
      .select("id, full_name, mobile, username, role, stall_id")
      .eq("id", customerId)
      .maybeSingle();
    if (!target || target.role !== "customer" || target.stall_id !== caller.stall_id) {
      return json({ error: "Customer not found." }, 404);
    }

    const password = tempPassword();
    const { error: updErr } = await admin.auth.admin.updateUserById(target.id, { password });
    if (updErr) {
      console.error("updateUserById failed:", updErr.message);
      return json({ error: "Could not reset the password. Please try again." }, 500);
    }

    const { error: flagErr } = await admin
      .from("profiles")
      .update({ must_change_password: true })
      .eq("id", target.id);
    if (flagErr) {
      console.error("flag update failed:", flagErr.message);
      return json({ error: "Password was reset but the change-on-login flag failed. Run the reset again." }, 500);
    }

    return json({
      customer_id: target.id,
      full_name: target.full_name,
      mobile: target.mobile,
      username: target.username,
      initial_password: password,
    });
  } catch (err) {
    console.error("reset-customer-password error:", err instanceof Error ? err.message : err);
    return json({ error: "Unexpected server error." }, 500);
  }
});
