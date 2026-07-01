import { createClient } from "@supabase/supabase-js";

// Public client values. The anon key is safe to ship to the browser; the real
// lock is the RLS policy (only your authenticated email can touch the jobs table).
// Override via .env (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) if you prefer.
const url =
  import.meta.env.VITE_SUPABASE_URL ||
  "https://empfvnriylzmbhkjrhgb.supabase.co";

const anon =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtcGZ2bnJpeWx6bWJoa2pyaGdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NDc0NjAsImV4cCI6MjA5ODQyMzQ2MH0.XrgBumBvXsJFng0SsTSJaEm6UtTFoTt144S6i4klu1Q";

export const LOGIN_EMAIL =
  import.meta.env.VITE_LOGIN_EMAIL || "connordore36@gmail.com";

export const supabase = createClient(url, anon, {
  auth: { persistSession: true, autoRefreshToken: true },
});
