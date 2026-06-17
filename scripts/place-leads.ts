/**
 * Place nurture-ready leads into their CORRECT Bison instance per the group sheet.
 *
 * For each active client, pulls its READY + ESP-RESOLVED leads (eligible = past
 * the 45-day cooldown, safe, esp confirmed) from nurture_sequence_finished +
 * replies, computes each lead's target instance by lane (business email → the
 * client's group B2B workspace, personal email → its B2C), and CREATES the lead
 * there. Leads already in their target instance are skipped (no-op). Idempotent:
 * existing emails come back notReturned (Bison dedupes) — no duplicates.
 *
 * Modes:
 *   --verify        Only test whether personal domains are enabled on the B2C
 *                   instances (creates + deletes one gmail + one biz test lead
 *                   in cleaningoutbound & outboundclean). Run this FIRST.
 *   --dry-run       Count what WOULD be created per (client, instance) — no writes.
 *   --client TAG    Limit to one client.
 *   --concurrency N Per-instance create batches run sequentially; N controls the
 *                   findLeadByEmail fallback concurrency (default 5). (unused for create)
 *
 * Run: npx tsx scripts/place-leads.ts --verify
 *      npx tsx scripts/place-leads.ts --dry-run
 *      npx tsx scripts/place-leads.ts            (real run)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { appendFileSync } from "fs";
import supabase from "../lib/supabase";
import { isPersonalDomain } from "../lib/processing/personal-domains";

const RESULTS = "/tmp/place-leads.txt";
const args = process.argv.slice(2);
const VERIFY = args.includes("--verify");
const DRY = args.includes("--dry-run");
const ONLY = (() => { const i = args.indexOf("--client"); return i >= 0 ? args[i + 1]?.toUpperCase() : null; })();
const NURTURE_DAYS = 45;
const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 864e5).toISOString();

function log(s: string) { const l = `${new Date().toISOString().slice(11, 19)} ${s}`; console.log(l); appendFileSync(RESULTS, l + "\n"); }

const EXCLUDED_AI = [
  "Interested", "Meeting Request", "Meeting Set", "Do Not Contact", "Wrong Person",
  "Wrong Person (Change of Target)", "Not Interested", "Mailbox No Longer Active",
  "Automated Error Message", "Automated Catch-All Message", "Referral Given", "Internally Forwarded",
];

async function verify() {
  const { createLeadsInInstance, getInstanceConfig } = await import("../lib/outboundhero-api").then(async (m) => ({
    createLeadsInInstance: m.createLeadsInInstance,
    getInstanceConfig: (await import("../lib/bison-instances")).getInstanceConfig,
  }));
  for (const inst of ["cleaningoutbound", "outboundclean"]) {
    const stamp = "zzverify-" + Math.floor(Math.random() * 1e6);
    const leads = [
      { email: `${stamp}-biz@examplecleaningco.com`, first_name: "Verify", company: "X" },
      { email: `${stamp}.personal@gmail.com`, first_name: "Verify" },
    ];
    try {
      const r = await createLeadsInInstance(inst, leads, { ensureVars: false });
      const gmailCreated = r.created.find((c) => c.email.includes("@gmail.com"));
      log(`[verify ${inst}] biz=${r.created.some((c) => c.email.includes("examplecleaningco")) ? "OK" : "skipped"} gmail=${gmailCreated ? "ACCEPTED (personal domains enabled)" : "SKIPPED (personal domains NOT enabled!)"} errors=${JSON.stringify(r.errors)}`);
      // cleanup
      const { baseUrl, token } = getInstanceConfig(inst);
      for (const c of r.created) {
        await fetch(`${baseUrl}/api/leads/${c.ob_lead_id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      }
    } catch (e) { log(`[verify ${inst}] ERROR: ${(e as Error).message}`); }
  }
}

async function activeClients(): Promise<string[]> {
  const { fetchClientTracker } = await import("../lib/google-sheets");
  const { default: db } = await import("../lib/db");
  const rows = await fetchClientTracker();
  const split = (s: string) => s.split(/\s+&\s+|\s+and\s+/i).map((x) => x.trim().toUpperCase()).filter(Boolean);
  const active = new Set<string>();
  for (const r of rows) if (!/churn/i.test(r.status)) for (const t of split(r.clientAbbreviation)) active.add(t);
  const dbTags = (await db.execute("SELECT tag FROM client_tags")).rows.map((r: any) => String(r.tag));
  return dbTags.filter((t) => active.has(t.toUpperCase())).sort();
}

type CV = Array<{ name: string; value: string }>;
interface Lead { email: string; first_name: string | null; last_name: string | null; company: string | null; sourceInstance: string | null; custom_variables: CV }

const normCV = (v: unknown): CV => Array.isArray(v) ? (v as CV).filter((x) => x && x.name && x.value != null) : [];

async function pullReady(tag: string): Promise<Lead[]> {
  const out: Lead[] = [];
  // sequence-finished: eligible + esp-resolved (carries its custom_variables)
  let start = 0;
  for (;;) {
    const { data, error } = await supabase.from("nurture_sequence_finished")
      .select("email, first_name, last_name, company, custom_variables, bison_instance")
      .eq("client_tag", tag).not("esp", "is", null).not("skipped", "is", true)
      .lte("sequence_finished_at", cutoffIso)
      .order("sequence_finished_at", { ascending: true }).range(start, start + 999);
    if (error) { log(`  ${tag} seq err: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const r of data) if (r.email) out.push({ email: r.email as string, first_name: (r.first_name as string) ?? null, last_name: (r.last_name as string) ?? null, company: (r.company as string) ?? null, sourceInstance: (r.bison_instance as string) ?? null, custom_variables: normCV(r.custom_variables) });
    if (data.length < 1000) break; start += 1000;
  }
  // replies: safe + esp-resolved + eligible
  start = 0;
  for (;;) {
    const { data, error } = await supabase.from("replies")
      .select("lead_email, first_name, last_name, company_name, bison_instance")
      .eq("client_tag", tag).eq("nurture_safety", "safe").not("esp", "is", null).not("nurture_skipped", "is", true)
      .not("reply_we_got", "is", null).neq("reply_we_got", "").not("reply_time", "is", null).lte("reply_time", cutoffIso)
      .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI.map((c) => `"${c}"`).join(",")})`)
      .order("reply_time", { ascending: true }).range(start, start + 999);
    if (error) { log(`  ${tag} reply err: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const r of data) if (r.lead_email) out.push({ email: r.lead_email as string, first_name: (r.first_name as string) ?? null, last_name: (r.last_name as string) ?? null, company: (r.company_name as string) ?? null, sourceInstance: (r.bison_instance as string) ?? null, custom_variables: [] });
    if (data.length < 1000) break; start += 1000;
  }
  return out;
}

async function main() {
  log(`PLACE-LEADS start ${VERIFY ? "(VERIFY)" : DRY ? "(DRY-RUN)" : "(LIVE)"}${ONLY ? " client=" + ONLY : ""}`);
  if (VERIFY) { await verify(); log("VERIFY done"); return; }

  const { getClientInstances } = await import("../lib/nurture/group-routing");
  const { createLeadsInInstance, findLeadByEmail, updateLeadCustomVars } = await import("../lib/outboundhero-api");
  const { default: db } = await import("../lib/db");

  let clients = await activeClients();
  if (ONLY) clients = clients.filter((t) => t.toUpperCase() === ONLY);
  log(`clients: ${clients.length}`);

  // Save instance-specific lead ids so the route engine can attach directly.
  async function saveIds(instance: string, tag: string, rows: Array<{ email: string; id: number }>) {
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      await db.batch(chunk.map((r) => ({
        sql: "INSERT INTO nurture_instance_lead (bison_instance, email, lead_id, client_tag, updated_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(bison_instance, email) DO UPDATE SET lead_id=excluded.lead_id, client_tag=excluded.client_tag, updated_at=datetime('now')",
        args: [instance, r.email.toLowerCase(), r.id, tag],
      })), "write");
    }
  }

  const grand = { created: 0, skipped_same: 0, patched: 0, saved: 0, errors: 0 };
  const perInstance: Record<string, number> = {};

  for (const tag of clients) {
    const inst = await getClientInstances(tag);
    if (!inst) { log(`SKIP ${tag}: no group mapping`); continue; }
    const leads = await pullReady(tag);
    if (leads.length === 0) { continue; }

    // group cross-instance leads by target instance (dedupe email per target)
    const byTarget = new Map<string, Map<string, Lead>>();
    let sameInstance = 0;
    for (const l of leads) {
      const lane = isPersonalDomain(l.email) ? "b2c" : "b2b";
      const target = inst[lane];
      if (l.sourceInstance && l.sourceInstance === target) { sameInstance++; continue; }
      if (!byTarget.has(target)) byTarget.set(target, new Map());
      byTarget.get(target)!.set(l.email.toLowerCase(), l);
    }
    grand.skipped_same += sameInstance;

    const parts: string[] = [`same=${sameInstance}`];
    for (const [target, m] of byTarget) {
      const items = [...m.values()];
      if (DRY) { parts.push(`${target}:would_create=${items.length}`); perInstance[target] = (perInstance[target] || 0) + items.length; continue; }
      const cvByEmail = new Map(items.map((l) => [l.email.toLowerCase(), l.custom_variables]));
      const payloads = items.map((l) => ({ email: l.email, first_name: l.first_name, last_name: l.last_name, company: l.company, custom_variables: l.custom_variables }));

      const r = await createLeadsInInstance(target, payloads); // ensureVars on by default
      grand.created += r.created.length; grand.errors += r.errors.length;
      perInstance[target] = (perInstance[target] || 0) + r.created.length;

      const idRows: Array<{ email: string; id: number }> = r.created.map((c) => ({ email: c.email, id: c.ob_lead_id }));

      // Existing leads (notReturned): resolve id, PATCH custom vars, save id too.
      let patched = 0;
      if (r.notReturned.length > 0) {
        const CONC = 6; let idx = 0;
        const found: Array<{ email: string; id: number }> = [];
        await Promise.all(Array.from({ length: Math.min(CONC, r.notReturned.length) }, async () => {
          while (idx < r.notReturned.length) {
            const em = r.notReturned[idx++];
            try {
              const lead = await findLeadByEmail(target, em);
              if (lead?.id) {
                found.push({ email: em, id: lead.id });
                const cv = cvByEmail.get(em.toLowerCase()) || [];
                if (cv.length) { const ok = await updateLeadCustomVars(target, lead.id, cv); if (ok) patched++; }
              }
            } catch { /* skip */ }
          }
        }));
        idRows.push(...found);
      }
      grand.patched += patched;

      await saveIds(target, tag, idRows);
      grand.saved += idRows.length;
      parts.push(`${target}:created=${r.created.length} patched=${patched} saved=${idRows.length} errs=${r.errors.length}`);
    }
    log(`${tag} (G${inst.group}): ${parts.join(" | ")}`);
  }

  log(`=== PLACE-LEADS DONE ${DRY ? "(DRY)" : ""} ===`);
  if (DRY) log(`totals: would_create=${Object.values(perInstance).reduce((a, b) => a + b, 0)} same_instance_skipped=${grand.skipped_same}`);
  else log(`totals: created=${grand.created} patched_existing=${grand.patched} ids_saved=${grand.saved} same_instance_skipped=${grand.skipped_same} batch_errors=${grand.errors}`);
  log(`per instance: ${JSON.stringify(perInstance)}`);
}
main().then(() => process.exit(0)).catch((e) => { log(`FATAL: ${e.message}`); process.exit(1); });
