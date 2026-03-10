import { sendToClayWebhook } from "./clay";

const ESJ_CLAY_WEBHOOK_URL =
  "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-edee1072-e18b-4f2e-8d83-69a6e11002ab";

export const ESJ_CLIENT_TAGS = ["ESJ", "JPSD", "JPWPB"];

export async function sendEsjWebhook(data: Record<string, unknown>): Promise<void> {
  await sendToClayWebhook(ESJ_CLAY_WEBHOOK_URL, data);
}
