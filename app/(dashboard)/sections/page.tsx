"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";

interface SectionData {
  id: number;
  name: string;
  airtable_base_id: string;
  airtable_table_id: string;
  clay_webhook_url_tracked: string | null;
  tags: string[];
}

export default function SectionsPage() {
  const [sections, setSections] = useState<SectionData[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [newTag, setNewTag] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSection, setEditingSection] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ airtable_base_id: "", clay_webhook_url_tracked: "" });

  // New section form
  const [newSection, setNewSection] = useState({
    name: "",
    airtable_base_id: "",
    airtable_table_id: "tbl1BnpnsUBrBGeuy",
    clay_webhook_url_tracked: "",
  });

  const loadSections = useCallback(async () => {
    const res = await fetch("/api/config/sections");
    if (res.ok) setSections(await res.json());
  }, []);

  useEffect(() => {
    loadSections();
  }, [loadSections]);

  async function addSection() {
    if (!newSection.name || !newSection.airtable_base_id) {
      toast.error("Name and Airtable Base ID are required");
      return;
    }
    const res = await fetch("/api/config/sections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newSection),
    });
    if (res.ok) {
      toast.success("Section created");
      setNewSection({ name: "", airtable_base_id: "", airtable_table_id: "tbl1BnpnsUBrBGeuy", clay_webhook_url_tracked: "" });
      setDialogOpen(false);
      loadSections();
    } else {
      toast.error("Failed to create section");
    }
  }

  async function deleteSection(id: number) {
    if (!confirm("Delete this section? All its tags will become unroutable.")) return;
    const res = await fetch("/api/config/sections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      toast.success("Section deleted");
      loadSections();
    }
  }

  async function updateSection(id: number) {
    const res = await fetch("/api/config/sections", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...editForm }),
    });
    if (res.ok) {
      toast.success("Section updated");
      setEditingSection(null);
      loadSections();
    }
  }

  async function addTag(sectionId: number) {
    if (!newTag.trim()) return;
    const res = await fetch("/api/config/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [newTag.trim().toUpperCase()], section_id: sectionId }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.failed?.length) {
        toast.error(`Tag "${data.failed[0]}" already exists`);
      } else {
        toast.success(`Tag "${newTag.trim().toUpperCase()}" added`);
      }
      setNewTag("");
      loadSections();
    }
  }

  async function removeTag(tag: string) {
    const res = await fetch("/api/config/tags", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag }),
    });
    if (res.ok) {
      toast.success(`Tag "${tag}" removed`);
      loadSections();
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Sections & Tags</h2>
          <p className="text-sm text-muted-foreground">
            Each section routes client tags to an Airtable base
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>Add New Airtable Base</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Section</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Section Name</Label>
                <Input
                  placeholder="e.g. Section 8"
                  value={newSection.name}
                  onChange={(e) => setNewSection({ ...newSection, name: e.target.value })}
                />
              </div>
              <div>
                <Label>Airtable Base ID</Label>
                <Input
                  placeholder="e.g. appXXXXXXXXXXXXX"
                  value={newSection.airtable_base_id}
                  onChange={(e) => setNewSection({ ...newSection, airtable_base_id: e.target.value })}
                />
              </div>
              <div>
                <Label>Airtable Table ID</Label>
                <Input
                  placeholder="tbl1BnpnsUBrBGeuy"
                  value={newSection.airtable_table_id}
                  onChange={(e) => setNewSection({ ...newSection, airtable_table_id: e.target.value })}
                />
              </div>
              <div>
                <Label>Clay Webhook URL (Tracked)</Label>
                <Input
                  placeholder="https://api.clay.com/v3/sources/webhook/..."
                  value={newSection.clay_webhook_url_tracked}
                  onChange={(e) => setNewSection({ ...newSection, clay_webhook_url_tracked: e.target.value })}
                />
              </div>
              <Button onClick={addSection} className="w-full">Create Section</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-4">
        {sections.map((section) => (
          <Card key={section.id}>
            <CardHeader
              className="cursor-pointer"
              onClick={() => setExpandedId(expandedId === section.id ? null : section.id)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-base">{section.name}</CardTitle>
                  <Badge variant="secondary">{section.tags.length} tags</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-muted-foreground">
                    {section.airtable_base_id}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (editingSection === section.id) {
                        setEditingSection(null);
                      } else {
                        setEditingSection(section.id);
                        setEditForm({
                          airtable_base_id: section.airtable_base_id,
                          clay_webhook_url_tracked: section.clay_webhook_url_tracked || "",
                        });
                      }
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); deleteSection(section.id); }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </CardHeader>

            {/* Edit form */}
            {editingSection === section.id && (
              <CardContent className="border-t pt-4 space-y-3">
                <div>
                  <Label className="text-xs">Airtable Base ID</Label>
                  <Input
                    value={editForm.airtable_base_id}
                    onChange={(e) => setEditForm({ ...editForm, airtable_base_id: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Clay Webhook URL (Tracked)</Label>
                  <Input
                    value={editForm.clay_webhook_url_tracked}
                    onChange={(e) => setEditForm({ ...editForm, clay_webhook_url_tracked: e.target.value })}
                  />
                </div>
                <Button size="sm" onClick={() => updateSection(section.id)}>
                  Save Changes
                </Button>
              </CardContent>
            )}

            {/* Tags section */}
            {expandedId === section.id && (
              <CardContent className="border-t pt-4">
                <div className="flex flex-wrap gap-2 mb-4">
                  {section.tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="outline"
                      className="gap-1 pr-1"
                    >
                      {tag}
                      <button
                        onClick={() => removeTag(tag)}
                        className="ml-1 hover:text-destructive text-muted-foreground"
                      >
                        x
                      </button>
                    </Badge>
                  ))}
                  {section.tags.length === 0 && (
                    <p className="text-sm text-muted-foreground">No tags assigned</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="Add tag (e.g. NEWTAG)"
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addTag(section.id)}
                    className="max-w-xs"
                  />
                  <Button size="sm" variant="secondary" onClick={() => addTag(section.id)}>
                    Add Tag
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
