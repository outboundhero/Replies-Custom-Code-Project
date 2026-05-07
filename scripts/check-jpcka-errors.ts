import { createClient } from "@libsql/client";
import { config } from "dotenv";
config({ path: ".env.local" });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
const result = await db.execute({
  sql: `SELECT timestamp, workflow, stage, message, payload FROM error_log
        WHERE message LIKE '%JPCKA%'
        ORDER BY timestamp DESC LIMIT 10`,
  args: [],
});

console.log(`Found ${result.rows.length} JPCKA errors:\n`);
for (const row of result.rows) {
  const payload = JSON.parse(row.payload as string || "{}");
  console.log("---");
  console.log("Time:", row.timestamp);
  console.log("Workflow:", row.workflow, "| Stage:", row.stage);
  console.log("Lead email:", payload.lead_email || payload.company_code || "");
  if (payload.payload?.data?.campaign) {
    console.log("Campaign:", payload.payload.data.campaign.name);
  }
  if (payload.payload?.data?.sender_email) {
    console.log("Sender:", payload.payload.data.sender_email.email);
  }
}
}

main().catch(console.error);
