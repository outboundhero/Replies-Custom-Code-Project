import { createClient } from "@libsql/client";
import { config } from "dotenv";
config({ path: ".env.local" });

const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

async function main() {
  const r = await db.execute("SELECT code, pattern, priority FROM company_codes WHERE code = 'AFS'");
  console.log("AFS in DB:", JSON.stringify(r.rows));

  const senderDomain = "elitecustodialcare.co";
  const redirectLink = "https://absolutefsinc.com/";
  const textBody = "";
  const blob = `${senderDomain} ${redirectLink} ${textBody}`.toLowerCase();
  console.log("Blob:", blob);

  const all = await db.execute("SELECT code, pattern, priority FROM company_codes ORDER BY priority DESC");
  let matched = "N/A";
  for (const row of all.rows) {
    try {
      if (new RegExp(row.pattern as string).test(blob)) {
        matched = row.code as string;
        console.log("MATCHED:", row.code, "pattern:", row.pattern);
        break;
      }
    } catch(e) { console.log("Bad regex:", row.pattern, e); }
  }
  console.log("Final result:", matched);
}

main().catch(console.error);
