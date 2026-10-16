/* Chai Khata — Supabase client configuration
 *
 * 1. Open your Supabase project → Project Settings → API (or "API Keys").
 * 2. Paste the Project URL and the *publishable* (or legacy "anon") key below.
 *
 * It is SAFE for these two values to be public: access is controlled by Row Level
 * Security in the database. NEVER paste the service_role / secret key here.
 */
window.CHAI_CONFIG = {
  SUPABASE_URL: 'https://mcyazyruergktafcsrmi.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jeWF6eXJ1ZXJna3RhZmNzcm1pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxMzMwMTEsImV4cCI6MjEwNzcwOTAxMX0.rknFYnZBudE1viizAHiCgvwIkY7-NWIjH1DLqx1_2hU'
};

(function () {
  var cfg = window.CHAI_CONFIG;
  cfg.isConfigured =
    /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(cfg.SUPABASE_URL) &&
    cfg.SUPABASE_URL.indexOf('YOUR-PROJECT-REF') === -1 &&
    cfg.SUPABASE_PUBLISHABLE_KEY.indexOf('YOUR-PUBLISHABLE') === -1 &&
    cfg.SUPABASE_PUBLISHABLE_KEY.length > 20;

  window.sb = null;
  if (cfg.isConfigured && window.supabase && typeof window.supabase.createClient === 'function') {
    window.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  }
})();
