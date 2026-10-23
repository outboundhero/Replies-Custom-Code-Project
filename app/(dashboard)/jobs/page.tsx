/**
 * Jobs page — see _view.tsx. The tab in the URL (?tab=resets …) is read here so the right tab renders first.
 */
import JobsView from "./_view";
import { TABS, type Tab } from "./tabs";

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const t = (await searchParams).tab as Tab | undefined;
  return <JobsView initialTab={t && TABS.includes(t) ? t : "moves"} />;
}
