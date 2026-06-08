# Enabling accounts (Supabase) — setup checklist

Accounts are **off** until you complete the steps below. The code is already
wired up: when `supabase-config.js` has a URL + anon key, a "Sign in" button
appears in the nav on every page and the `/account/` page activates.

Files are **never uploaded** — accounts only carry the user's sign-in profile.

---

## 1. Create the Supabase project

1. Go to <https://supabase.com> → **New project**.
2. Once created, open **Project Settings → API** and copy:
   - **Project URL** (e.g. `https://abcd1234.supabase.co`)
   - **anon public** key (the long `eyJ...` string — *not* `service_role`)
3. Paste both into **`supabase-config.js`**:
   ```js
   window.SUPABASE_CONFIG = {
     url: 'https://abcd1234.supabase.co',
     anonKey: 'eyJhbGciOi...'
   };
   ```
   The anon key is a public client key and is safe to commit/ship.

## 2. Set the redirect URLs

Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL:** `https://myfreepdfedit.com`
- **Redirect URLs** (add all you use):
  - `https://myfreepdfedit.com/**`
  - `http://localhost:8000/**` (or whatever port you use locally for testing)

The app sends users back to the page they signed in from, so the wildcard
`/**` entries cover every page.

## 3. Enable the social providers

Supabase dashboard → **Authentication → Providers**. For each, toggle it on and
paste the Client ID + Secret you get from that provider. In **every** provider's
developer console, set the OAuth **callback / redirect URL** to:

```
https://<your-project-ref>.supabase.co/auth/v1/callback
```

(Find the exact value at the top of each provider's settings panel in Supabase.)

### Google
1. <https://console.cloud.google.com/> → create a project (or reuse one).
2. **APIs & Services → OAuth consent screen** → configure (External), add your
   domain and an authorized domain.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
4. Add the Supabase callback URL above to **Authorized redirect URIs**.
5. Copy the Client ID + Client Secret into Supabase → Google provider.

### Discord
1. <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2** → copy **Client ID** and **Client Secret**.
3. **OAuth2 → Redirects** → add the Supabase callback URL.
4. Paste ID + Secret into Supabase → Discord provider.

### Facebook
1. <https://developers.facebook.com/apps/> → **Create app** (type: Consumer).
2. Add the **Facebook Login** product.
3. **Facebook Login → Settings → Valid OAuth Redirect URIs** → add the Supabase
   callback URL.
4. **App settings → Basic** → copy **App ID** + **App Secret** into Supabase →
   Facebook provider.
5. Switch the app to **Live** mode when ready for real users.

## 4. Test

1. Serve the site over http(s) (the File System Access + OAuth flows need a
   secure context; `localhost` counts).
2. Load any page → a **Sign in** button should appear in the nav.
3. Click it → choose a provider → complete the provider login → you should
   return signed in, with your name/avatar in the nav.
4. Visit **/account/** to see your profile and sign out.

## Notes
- Only `supabase-config.js` needs editing to go live; `auth.js` and the account
  page are generic.
- To store user preferences/history later, create tables in Supabase and add
  Row Level Security policies keyed to `auth.uid()`. (Not built yet.)
