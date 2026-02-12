"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

interface UntrackedConfig {
  airtable_base_id: string;
  airtable_table_id: string;
  clay_webhook_url: string | null;
}

interface CompanyCodeRow {
  id: number;
  code: string;
  pattern: string;
  priority: number;
}

interface BounceFilterRow {
  id: number;
  field: string;
  value: string;
  match_type: string;
}

export default function UntrackedPage() {
  const [config, setConfig] = useState<UntrackedConfig | null>(null);
  const [codes, setCodes] = useState<CompanyCodeRow[]>([]);
  const [filters, setFilters] = useState<BounceFilterRow[]>([]);

  // Config form
  const [configForm, setConfigForm] = useState({
    airtable_base_id: "",
    clay_webhook_url: "",
  });

  // New company code form
  const [newCode, setNewCode] = useState({ code: "", pattern: "", priority: "0" });

  // New bounce filter form
  const [newFilter, setNewFilter] = useState({ field: "text_body", value: "", match_type: "notContains" });

  const loadData = useCallback(async () => {
    const [cfgRes, codesRes, filtersRes] = await Promise.all([
      fetch("/api/config/untracked"),
      fetch("/api/config/company-codes"),
      fetch("/api/config/bounce-filters"),
    ]);
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      setConfig(cfg);
      if (cfg) setConfigForm({ airtable_base_id: cfg.airtable_base_id, clay_webhook_url: cfg.clay_webhook_url || "" });
    }
    if (codesRes.ok) setCodes(await codesRes.json());
    if (filtersRes.ok) setFilters(await filtersRes.json());
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  async function saveConfig() {
    const res = await fetch("/api/config/untracked", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(configForm),
    });
    if (res.ok) toast.success("Config saved");
    else toast.error("Failed to save config");
  }

  async function addCompanyCode() {
    if (!newCode.code || !newCode.pattern) { toast.error("Code and pattern required"); return; }
    const res = await fetch("/api/config/company-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...newCode, priority: Number(newCode.priority) }),
    });
    if (res.ok) { toast.success("Company code added"); setNewCode({ code: "", pattern: "", priority: "0" }); loadData(); }
  }

  async function deleteCompanyCode(id: number) {
    const res = await fetch("/api/config/company-codes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) { toast.success("Deleted"); loadData(); }
  }

  async function addBounceFilter() {
    if (!newFilter.value) { toast.error("Value required"); return; }
    const res = await fetch("/api/config/bounce-filters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newFilter),
    });
    if (res.ok) { toast.success("Filter added"); setNewFilter({ field: "text_body", value: "", match_type: "notContains" }); loadData(); }
  }

  async function deleteBounceFilter(id: number) {
    const res = await fetch("/api/config/bounce-filters", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) { toast.success("Deleted"); loadData(); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Untracked Config</h2>
        <p className="text-sm text-muted-foreground">
          All untracked replies route to a single Airtable base
        </p>
      </div>

      {/* Airtable + Clay Config */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Airtable & Clay Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Airtable Base ID</Label>
            <Input
              value={configForm.airtable_base_id}
              onChange={(e) => setConfigForm({ ...configForm, airtable_base_id: e.target.value })}
              placeholder="appXXXXXXXXXXXXX"
            />
          </div>
          <div>
            <Label>Clay Webhook URL</Label>
            <Input
              value={configForm.clay_webhook_url}
              onChange={(e) => setConfigForm({ ...configForm, clay_webhook_url: e.target.value })}
              placeholder="https://api.clay.com/v3/sources/webhook/..."
            />
          </div>
          <Button onClick={saveConfig}>Save Config</Button>
        </CardContent>
      </Card>

      {/* Company Codes */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Company Codes</CardTitle>
            <Badge variant="secondary">{codes.length} rules</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 mb-4">
            <Input
              placeholder="Code (e.g. AC)"
              value={newCode.code}
              onChange={(e) => setNewCode({ ...newCode, code: e.target.value })}
              className="w-24"
            />
            <Input
              placeholder="Regex pattern (e.g. analyzecorp\.com)"
              value={newCode.pattern}
              onChange={(e) => setNewCode({ ...newCode, pattern: e.target.value })}
              className="flex-1"
            />
            <Input
              placeholder="Priority"
              type="number"
              value={newCode.priority}
              onChange={(e) => setNewCode({ ...newCode, priority: e.target.value })}
              className="w-20"
            />
            <Button variant="secondary" onClick={addCompanyCode}>Add</Button>
          </div>
          <div className="border rounded-md max-h-[400px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="text-left p-2 font-medium">Code</th>
                  <th className="text-left p-2 font-medium">Pattern</th>
                  <th className="text-left p-2 font-medium">Priority</th>
                  <th className="p-2 w-16"></th>
                </tr>
              </thead>
              <tbody>
                {codes.map((code) => (
                  <tr key={code.id} className="border-t">
                    <td className="p-2 font-mono">{code.code}</td>
                    <td className="p-2 font-mono text-xs text-muted-foreground">{code.pattern}</td>
                    <td className="p-2">{code.priority}</td>
                    <td className="p-2">
                      <button
                        onClick={() => deleteCompanyCode(code.id)}
                        className="text-xs text-destructive hover:underline"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Bounce Filters */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Bounce Filters</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Replies matching any filter are silently dropped
              </p>
            </div>
            <Badge variant="secondary">{filters.length} filters</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 mb-4">
            <Select
              value={newFilter.field}
              onValueChange={(v) => setNewFilter({ ...newFilter, field: v })}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="from_name">from_name</SelectItem>
                <SelectItem value="from_email">from_email</SelectItem>
                <SelectItem value="text_body">text_body</SelectItem>
                <SelectItem value="subject">subject</SelectItem>
                <SelectItem value="to_address">to_address</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={newFilter.match_type}
              onValueChange={(v) => setNewFilter({ ...newFilter, match_type: v })}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="notContains">notContains</SelectItem>
                <SelectItem value="notEquals">notEquals</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Value to filter"
              value={newFilter.value}
              onChange={(e) => setNewFilter({ ...newFilter, value: e.target.value })}
              className="flex-1"
            />
            <Button variant="secondary" onClick={addBounceFilter}>Add</Button>
          </div>
          <div className="border rounded-md max-h-[400px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="text-left p-2 font-medium">Field</th>
                  <th className="text-left p-2 font-medium">Match Type</th>
                  <th className="text-left p-2 font-medium">Value</th>
                  <th className="p-2 w-16"></th>
                </tr>
              </thead>
              <tbody>
                {filters.map((filter) => (
                  <tr key={filter.id} className="border-t">
                    <td className="p-2 font-mono text-xs">{filter.field}</td>
                    <td className="p-2 text-xs">{filter.match_type}</td>
                    <td className="p-2 text-xs">{filter.value}</td>
                    <td className="p-2">
                      <button
                        onClick={() => deleteBounceFilter(filter.id)}
                        className="text-xs text-destructive hover:underline"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
