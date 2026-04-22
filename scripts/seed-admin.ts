/**
 * Seed the first admin user into the app_users table.
 *
 * PREREQUISITE: Create the app_users table in Supabase SQL Editor first:
 *
 * CREATE TABLE app_users (
 *   id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
 *   email TEXT UNIQUE NOT NULL,
 *   password_hash TEXT NOT NULL,
 *   role TEXT NOT NULL CHECK (role IN ('admin', 'inbox_manager')),
 *   created_at TIMESTAMPTZ DEFAULT NOW(),
 *   updated_at TIMESTAMPTZ DEFAULT NOW()
 * );
 *
 * Then run: npx tsx scripts/seed-admin.ts
 */

import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  const email = "spencer@outboundhero.co";
  const password = "#OutboundHero2025";
  const role = "admin";

  const hash = await bcrypt.hash(password, 12);

  const { data, error } = await supabase
    .from("app_users")
    .upsert({ email, password_hash: hash, role, updated_at: new Date().toISOString() }, { onConflict: "email" })
    .select();

  if (error) {
    console.error("Failed to seed admin:", error.message);
    process.exit(1);
  }

  console.log("Admin user seeded:", data);
}

main();
