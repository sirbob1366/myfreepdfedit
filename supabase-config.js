/* ===========================================================
   supabase-config.js — Account / auth configuration
   -----------------------------------------------------------
   Fill these in from your Supabase project:
     Supabase dashboard → Project Settings → API
       • Project URL   → url
       • anon public   → anonKey   (this key is public & safe to ship)

   Until both values are set, account features stay OFF and no auth
   code is loaded (the "Sign in" button does not appear). See
   SUPABASE_SETUP.md for the full setup checklist.
   =========================================================== */

window.SUPABASE_CONFIG = {
  url: '',       // e.g. "https://abcdefghijklm. supabase.co"  (no trailing slash)
  anonKey: ''    // e.g. "eyJhbGciOi..."  (the anon/public key, NOT the service_role key)
};

window.SUPABASE_CONFIGURED = !!(window.SUPABASE_CONFIG.url && window.SUPABASE_CONFIG.anonKey);
