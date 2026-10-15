/**
 * GET /api/clients/[tag]/profile — everything about one client in one answer,
 * for the client page (/clients/[tag]):
 *   Reply Router: section, CC / BCC, reply template, Bison instance
 *   the sheets:   company, plan, dates, website, office, type, group, status
 *   rules:        the qualification rules synced from the Onboarding Form
 *   admins also:  onboarding (group, time zone, checklist progress) and email copy
 *
 * Same access as the Clients page: admins and (unscoped) inbox managers.
 * Read-only; the page saves through the existing endpoints.
 */
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { getSession } from "@/lib/auth";
import { withCache } from "@/lib/server-cache";
import { fetchNewClientInfo, fetchOnboardingFormDetails, fetchGoLiveDates, fetchNotYetLiveTags, fetchClientGroupRecords } from "@/lib/google-sheets";
import { getClient, listTasks } from "@/lib/onboarding/store";
import { readClientCopies, readLibrary } from "@/lib/onboarding/copy-store";
import { normClientTag } from "@/lib/onboarding/copy-model";

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function GET(_req: NextRequest, { params }: { params: Promise<{ tag: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.allowedClientTags && session.allowedClientTags.length) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (session.role !== "admin" && session.role !== "inbox_manager") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const admin = session.role === "admin";
  const raw = (await params).tag;
  let tag: string | null;
  try { tag = normClientTag(decodeURIComponent(raw)); } catch { tag = null; }
  if (!tag) return NextResponse.json({ error: "Bad client tag" }, { status: 400 });

  try {
    const readErrors: string[] = [];
    const sheet = async <T,>(label: string, key: string, fn: () => Promise<T>): Promise<T | null> => {
      try { return await withCache(key, 60_000, fn); } catch (e) { readErrors.push(`${label}: ${(e as Error).message}`); return null; }
    };
    const [tagRow, sectionRows, cfgRow, instRow, groupRow, info, form, goLive, notLive, groups, qual] = await Promise.all([
      db.execute({ sql: "SELECT t.tag, t.section_id, sec.name FROM client_tags t LEFT JOIN sections sec ON sec.id = t.section_id WHERE UPPER(t.tag) = ?", args: [tag] }),
      db.execute("SELECT id, name FROM sections ORDER BY id"),
      db.execute({ sql: "SELECT * FROM client_config WHERE UPPER(client_tag) = ?", args: [tag] }),
      db.execute({ sql: "SELECT instance_key FROM client_instances WHERE UPPER(client_tag) = ?", args: [tag] }).catch(() => ({ rows: [] })),
      db.execute({ sql: "SELECT group_num FROM client_groups WHERE UPPER(client_tag) = ?", args: [tag] }).catch(() => ({ rows: [] })),
      sheet("New Client Information", "onboarding:new-client-info", fetchNewClientInfo),
      sheet("Onboarding Form", "onboarding:form-details", fetchOnboardingFormDetails),
      sheet("Client Tracker (go-live dates)", "profile:go-live", fetchGoLiveDates),
      // The same go-live test the campaign activation gate uses.
      sheet("Client Tracker (go-live dates)", "profile:not-live", () => fetchNotYetLiveTags(0)),
      sheet("Groups tab", "profile:groups", fetchClientGroupRecords),
      supabase.from("client_qualifications").select("inclusion_locations, exclusion_industries, hq_anchor").eq("client_abbreviation", tag).maybeSingle(),
    ]);
    const t = tagRow.rows[0] as Record<string, unknown> | undefined;
    const c = (cfgRow.rows[0] ?? {}) as Record<string, unknown>;
    const nci = info ? [...info].reverse().find((r) => r.tags.includes(tag)) : undefined;
    const fd = form?.get(tag);
    const gr = groups?.find((g) => g.tag === tag);

    // Its onboarding basics (name, plan, start, group, time zone) for everyone who can see the
    // page; checklist progress and email copy for admins only (onboarding is admin-only).
    let onboarding = null, copy = null;
    const oc = await getClient(tag);
    if (oc) {
      onboarding = {
        tag: oc.client_tag, name: oc.client_name ?? null, start: oc.start_date, plan: oc.plan_type, group: oc.group_num, timezone: oc.campaign_timezone ?? null,
        status: oc.status, done: 0, total: 0, next: null as string | null,
      };
      if (admin) {
        const tasks = await listTasks({ tag: oc.client_tag });
        const ordered = tasks.filter((x) => x.no_due).sort((a, b) => a.order_index - b.order_index);
        const next = ordered.find((x) => x.status !== "completed") ?? tasks.find((x) => x.status !== "completed");
        Object.assign(onboarding, { done: tasks.filter((x) => x.status === "completed").length, total: tasks.length, next: next?.title ?? null });
      }
    }
    if (admin) {
      const [own, lib] = await Promise.all([readClientCopies(tag), readLibrary()]);
      const latest = own[0]?.latest ?? null;
      copy = {
        own: latest ? { version: latest.version, mode: latest.mode, clientType: latest.clientType, basedOn: latest.basedOn } : null,
        shared: Object.fromEntries(lib.map((e) => [e.type, e.current?.version ?? null])),
      };
    }

    return NextResponse.json({
      ok: true, tag, admin,
      exists: !!t,
      // The tag exactly as Reply Router stores it — the save endpoints match it as-is.
      storedTag: t ? String(t.tag) : null,
      section: t ? { id: Number(t.section_id), name: String(t.name ?? `Section ${t.section_id}`) } : null,
      sections: sectionRows.rows.map((r) => ({ id: Number(r.id), name: String(r.name) })),
      config: {
        cc: Array.from({ length: 6 }, (_, i) => ({ name: s(c[`cc_name_${i + 1}`]) ?? "", email: s(c[`cc_email_${i + 1}`]) ?? "" })),
        bcc: Array.from({ length: 2 }, (_, i) => ({ name: s(c[`bcc_name_${i + 1}`]) ?? "", email: s(c[`bcc_email_${i + 1}`]) ?? "" })),
        reply_template: s(c.reply_template) ?? "",
        updated_at: s(c.updated_at),
      },
      instance: s((instRow.rows[0] as Record<string, unknown> | undefined)?.instance_key),
      details: {
        company: nci?.companyName || fd?.companyName || null,
        plan: nci?.plan || null,
        startDate: nci?.startDate || null,
        goLive: goLive?.get(tag) ?? null,
        notLiveYet: notLive?.has(tag) ?? false,
        status: gr?.status || null,
        churnDate: gr?.churnDate || null,
        clientType: fd?.clientType || nci?.clientType || null,
        website: fd?.website || null,
        office: nci?.office || null,
        address: fd?.address || null,
        area: nci?.area || null,
        phones: fd?.phones || null,
        formEmail: fd?.email || null,
        contacts: nci?.contactEmails?.length ? nci.contactEmails : null,
      },
      group: { sheet: gr?.group ?? null, app: groupRow.rows[0] ? Number((groupRow.rows[0] as Record<string, unknown>).group_num) : null },
      onboarding, copy,
      qualification: qual.data ? { inclusion: s(qual.data.inclusion_locations), exclusion: s(qual.data.exclusion_industries), hq: s(qual.data.hq_anchor) } : null,
      readErrors,
    });
  } catch (e) {
    console.error("[api/clients/profile]", e);
    return NextResponse.json({ error: "Couldn't load this client." }, { status: 500 });
  }
}
