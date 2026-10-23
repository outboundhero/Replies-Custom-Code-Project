/** The Jobs page's tabs (shared by the server page, which reads ?tab=, and the client view). */
export type Tab = "moves" | "resets" | "removals" | "onboarding" | "refresh";
export const TABS: Tab[] = ["moves", "resets", "removals", "onboarding", "refresh"];
