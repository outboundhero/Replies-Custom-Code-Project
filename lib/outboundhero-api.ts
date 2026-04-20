/**
 * OutboundHero API helpers for sending replies, forwarding, and one-off emails.
 */

const API_BASE = "https://app.outboundhero.co/api";
const API_TOKEN = "60|QACwd4xuHycuYxLh8knGlKvKEuRkVSUw2obSpCNSd2ba2ebd";

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_TOKEN}`,
};

interface EmailRecipient {
  name: string;
  email_address: string;
}

export async function sendReply(params: {
  replyId: number;
  senderEmailId: number;
  message: string;
  toEmail: string;
  toName: string;
  ccEmails?: EmailRecipient[];
  bccEmails?: EmailRecipient[];
}): Promise<{ ok: boolean; error?: string }> {
  const payload: Record<string, unknown> = {
    inject_previous_email_body: true,
    message: params.message,
    sender_email_id: params.senderEmailId,
    content_type: "html",
    to_emails: [{ name: params.toName || "", email_address: params.toEmail }],
  };

  if (params.ccEmails?.length) payload.cc_emails = params.ccEmails;
  if (params.bccEmails?.length) payload.bcc_emails = params.bccEmails;

  const res = await fetch(`${API_BASE}/replies/${params.replyId}/reply`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, error: `${res.status}: ${body}` };
}

export async function forwardReply(params: {
  replyId: number;
  senderEmailId: number;
  message: string;
  forwardTo: string;
  leadName: string;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/replies/${params.replyId}/forward?plain_text=true`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      inject_previous_email_body: true,
      message: params.message,
      sender_email_id: params.senderEmailId,
      content_type: "html",
      to_emails: [{ name: params.leadName || "", email_address: params.forwardTo }],
    }),
  });

  if (res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, error: `${res.status}: ${body}` };
}

export async function sendOneOffReply(params: {
  senderEmailId: number;
  subject: string;
  message: string;
  toEmail: string;
  toName: string;
  ccEmails?: EmailRecipient[];
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/replies/new`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      subject: params.subject,
      message: params.message,
      sender_email_id: params.senderEmailId,
      content_type: "html",
      to_emails: [{ name: params.toName || "", email_address: params.toEmail }],
      cc_emails: params.ccEmails?.length ? params.ccEmails : null,
      bcc_emails: null,
      attachments: null,
    }),
  });

  if (res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, error: `${res.status}: ${body}` };
}
