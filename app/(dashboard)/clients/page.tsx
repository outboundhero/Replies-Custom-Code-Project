"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Client {
  id: number;
  tag: string;
  section_id: number;
  section_name: string;
  airtable_base_id: string;
  clay_webhook_url_tracked: string | null;
  config_id: number | null;
  cc_name_1: string | null; cc_email_1: string | null;
  cc_name_2: string | null; cc_email_2: string | null;
  cc_name_3: string | null; cc_email_3: string | null;
  cc_name_4: string | null; cc_email_4: string | null;
  bcc_name_1: string | null; bcc_email_1: string | null;
  bcc_name_2: string | null; bcc_email_2: string | null;
  reply_template: string | null;
  updated_at: string | null;
}

interface Section {
  id: number;
  name: string;
  airtable_base_id: string;
}

type ConfigForm = {
  cc_name_1: string; cc_email_1: string;
  cc_name_2: string; cc_email_2: string;
  cc_name_3: string; cc_email_3: string;
  cc_name_4: string; cc_email_4: string;
  bcc_name_1: string; bcc_email_1: string;
  bcc_name_2: string; bcc_email_2: string;
  reply_template: string;
};

const emptyForm = (): ConfigForm => ({
  cc_name_1: "", cc_email_1: "",
  cc_name_2: "", cc_email_2: "",
  cc_name_3: "", cc_email_3: "",
  cc_name_4: "", cc_email_4: "",
  bcc_name_1: "", bcc_email_1: "",
  bcc_name_2: "", bcc_email_2: "",
  reply_template: "",
});

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ConfigForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  // Onboard dialog
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [newSectionId, setNewSectionId] = useState("");
  const [onboarding, setOnboarding] = useState(false);

  const loadClients = useCallback(async () => {
    const res = await fetch("/api/config/clients");
    if (res.ok) setClients(await res.json());
  }, []);

  const loadSections = useCallback(async () => {
    const res = await fetch("/api/config/sections");
    if (res.ok) setSections(await res.json());
  }, []);

  useEffect(() => {
    loadClients();
    loadSections();
  }, [loadClients, loadSections]);

  function startEdit(client: Client) {
    setEditing(client.tag);
    setEditForm({
      cc_name_1: client.cc_name_1 || "",
      cc_email_1: client.cc_email_1 || "",
      cc_name_2: client.cc_name_2 || "",
      cc_email_2: client.cc_email_2 || "",
      cc_name_3: client.cc_name_3 || "",
      cc_email_3: client.cc_email_3 || "",
      cc_name_4: client.cc_name_4 || "",
      cc_email_4: client.cc_email_4 || "",
      bcc_name_1: client.bcc_name_1 || "",
      bcc_email_1: client.bcc_email_1 || "",
      bcc_name_2: client.bcc_name_2 || "",
      bcc_email_2: client.bcc_email_2 || "",
      reply_template: client.reply_template || "",
    });
  }

  async function saveConfig(tag: string) {
    setSaving(true);
    await fetch("/api/config/clients", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag, ...editForm }),
    });
    setSaving(false);
    setEditing(null);
    loadClients();
  }

  async function onboardClient() {
    if (!newTag.trim() || !newSectionId) return;
    setOnboarding(true);
    await fetch("/api/config/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: newTag.trim(), section_id: Number(newSectionId) }),
    });
    setOnboarding(false);
    setOnboardOpen(false);
    setNewTag("");
    setNewSectionId("");
    loadClients();
  }

  async function removeClient(tag: string) {
    if (!confirm(`Remove client "${tag}"? This will delete the tag and its config.`)) return;
    await fetch("/api/config/clients", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag }),
    });
    loadClients();
  }

  const filtered = clients.filter((c) =>
    c.tag.toLowerCase().includes(search.toLowerCase()) ||
    c.section_name.toLowerCase().includes(search.toLowerCase())
  );

  // Group by section
  const bySection = filtered.reduce<Record<string, Client[]>>((acc, c) => {
    const key = c.section_name;
    if (!acc[key]) acc[key] = [];
    acc[key].push(c);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Clients</h2>
          <p className="text-sm text-muted-foreground">
            Manage client CC/BCC, reply templates, and onboard new clients
          </p>
        </div>
        <Button onClick={() => setOnboardOpen(true)}>Onboard New Client</Button>
      </div>

      <Input
        placeholder="Search by tag or section..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />

      {Object.entries(bySection).map(([sectionName, sectionClients]) => {
        const first = sectionClients[0];
        return (
          <Card key={sectionName}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <CardTitle className="text-base">{sectionName}</CardTitle>
                <span className="font-mono text-xs text-muted-foreground">{first.airtable_base_id}</span>
                {first.clay_webhook_url_tracked && (
                  <Badge variant="outline" className="text-xs font-mono">
                    Clay: {first.clay_webhook_url_tracked.split("/").pop()?.slice(0, 16)}…
                  </Badge>
                )}
                <Badge variant="secondary" className="ml-auto">{sectionClients.length} clients</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {sectionClients.map((client) => (
                <div key={client.tag} className="border rounded-md overflow-hidden">
                  {/* Client row */}
                  <div
                    className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/40 text-sm"
                    onClick={() => setExpanded(expanded === client.tag ? null : client.tag)}
                  >
                    <span className="font-mono font-medium w-24 shrink-0">{client.tag}</span>
                    <div className="flex gap-1.5 flex-wrap flex-1">
                      {client.reply_template && (
                        <Badge variant="secondary" className="text-xs">Reply Template ✓</Badge>
                      )}
                      {(client.cc_email_1 || client.cc_email_2 || client.cc_email_3 || client.cc_email_4) && (
                        <Badge variant="secondary" className="text-xs">
                          CC: {[client.cc_email_1, client.cc_email_2, client.cc_email_3, client.cc_email_4].filter(Boolean).length}
                        </Badge>
                      )}
                      {(client.bcc_email_1 || client.bcc_email_2) && (
                        <Badge variant="secondary" className="text-xs">
                          BCC: {[client.bcc_email_1, client.bcc_email_2].filter(Boolean).length}
                        </Badge>
                      )}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeClient(client.tag); }}
                      className="text-xs text-muted-foreground hover:text-destructive"
                    >
                      Remove
                    </button>
                    <span className="text-xs text-muted-foreground">
                      {expanded === client.tag ? "▲" : "▼"}
                    </span>
                  </div>

                  {/* Expanded config */}
                  {expanded === client.tag && (
                    <div className="border-t bg-muted/20 px-4 py-4 space-y-4">
                      {editing === client.tag ? (
                        <div className="space-y-4">
                          {/* CC fields */}
                          <div>
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">CC Recipients</p>
                            <div className="grid grid-cols-2 gap-3">
                              {([1, 2, 3, 4] as const).map((n) => (
                                <div key={n} className="flex gap-2">
                                  <Input
                                    placeholder={`CC Name ${n}`}
                                    value={editForm[`cc_name_${n}` as keyof ConfigForm]}
                                    onChange={(e) => setEditForm({ ...editForm, [`cc_name_${n}`]: e.target.value })}
                                    className="text-xs"
                                  />
                                  <Input
                                    placeholder={`CC Email ${n}`}
                                    value={editForm[`cc_email_${n}` as keyof ConfigForm]}
                                    onChange={(e) => setEditForm({ ...editForm, [`cc_email_${n}`]: e.target.value })}
                                    className="text-xs"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* BCC fields */}
                          <div>
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">BCC Recipients</p>
                            <div className="grid grid-cols-2 gap-3">
                              {([1, 2] as const).map((n) => (
                                <div key={n} className="flex gap-2">
                                  <Input
                                    placeholder={`BCC Name ${n}`}
                                    value={editForm[`bcc_name_${n}` as keyof ConfigForm]}
                                    onChange={(e) => setEditForm({ ...editForm, [`bcc_name_${n}`]: e.target.value })}
                                    className="text-xs"
                                  />
                                  <Input
                                    placeholder={`BCC Email ${n}`}
                                    value={editForm[`bcc_email_${n}` as keyof ConfigForm]}
                                    onChange={(e) => setEditForm({ ...editForm, [`bcc_email_${n}`]: e.target.value })}
                                    className="text-xs"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Reply Template */}
                          <div>
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Reply Template → "Our Reply" in Airtable</p>
                            <Textarea
                              placeholder="Enter the reply template that will be stored under 'Our Reply' in Airtable..."
                              value={editForm.reply_template}
                              onChange={(e) => setEditForm({ ...editForm, reply_template: e.target.value })}
                              rows={4}
                              className="text-xs"
                            />
                          </div>

                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => saveConfig(client.tag)} disabled={saving}>
                              {saving ? "Saving..." : "Save"}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {/* Read-only view */}
                          {[1, 2, 3, 4].some((n) => client[`cc_email_${n}` as keyof Client]) && (
                            <div>
                              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">CC Recipients</p>
                              <div className="space-y-1">
                                {([1, 2, 3, 4] as const).map((n) => client[`cc_email_${n}` as keyof Client] && (
                                  <p key={n} className="text-xs">
                                    <span className="text-muted-foreground">CC {n}:</span>{" "}
                                    {client[`cc_name_${n}` as keyof Client] as string} &lt;{client[`cc_email_${n}` as keyof Client] as string}&gt;
                                  </p>
                                ))}
                              </div>
                            </div>
                          )}
                          {[1, 2].some((n) => client[`bcc_email_${n}` as keyof Client]) && (
                            <div>
                              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">BCC Recipients</p>
                              <div className="space-y-1">
                                {([1, 2] as const).map((n) => client[`bcc_email_${n}` as keyof Client] && (
                                  <p key={n} className="text-xs">
                                    <span className="text-muted-foreground">BCC {n}:</span>{" "}
                                    {client[`bcc_name_${n}` as keyof Client] as string} &lt;{client[`bcc_email_${n}` as keyof Client] as string}&gt;
                                  </p>
                                ))}
                              </div>
                            </div>
                          )}
                          {client.reply_template && (
                            <div>
                              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Reply Template</p>
                              <p className="text-xs bg-white border rounded p-2 whitespace-pre-wrap">{client.reply_template}</p>
                            </div>
                          )}
                          {!client.reply_template && ![1, 2, 3, 4].some((n) => client[`cc_email_${n}` as keyof Client]) && (
                            <p className="text-xs text-muted-foreground">No config set yet.</p>
                          )}
                          <Button size="sm" variant="outline" onClick={() => startEdit(client)}>
                            Edit Config
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}

      {filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-12">No clients found.</p>
      )}

      {/* Onboard dialog */}
      <Dialog open={onboardOpen} onOpenChange={setOnboardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Onboard New Client</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label>Client Tag</Label>
              <Input
                placeholder="e.g. ACME, GJEC, MPD"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value.toUpperCase())}
              />
              <p className="text-xs text-muted-foreground">Must match the prefix before the colon in campaign names.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Section</Label>
              <Select value={newSectionId} onValueChange={setNewSectionId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a section..." />
                </SelectTrigger>
                <SelectContent>
                  {sections.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name} — {s.airtable_base_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 pt-2">
              <Button onClick={onboardClient} disabled={!newTag.trim() || !newSectionId || onboarding}>
                {onboarding ? "Onboarding..." : "Onboard Client"}
              </Button>
              <Button variant="outline" onClick={() => setOnboardOpen(false)}>Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
