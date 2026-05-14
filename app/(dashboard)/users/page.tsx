"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface AppUser {
  id: number;
  email: string;
  role: string;
  allowed_client_tags: string[] | null;
  created_at: string;
  updated_at: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Create form
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("inbox_manager");
  const [newAllowedTags, setNewAllowedTags] = useState("");
  const [creating, setCreating] = useState(false);

  // Reset password
  const [resetId, setResetId] = useState<number | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  // Edit allowed client tags inline
  const [editTagsId, setEditTagsId] = useState<number | null>(null);
  const [editTagsValue, setEditTagsValue] = useState("");

  const loadUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/users");
      if (res.redirected || res.status === 401) { window.location.href = "/login"; return; }
      if (res.status === 403) { setFetchError("Admin access required"); return; }
      if (res.ok) { setUsers(await res.json()); setFetchError(null); }
      else setFetchError(`Failed (${res.status})`);
    } catch (e) { setFetchError((e as Error).message); }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newEmail || !newPassword) return;
    setCreating(true);
    try {
      const res = await fetch("/api/users/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          email: newEmail,
          password: newPassword,
          role: newRole,
          // Empty string → null on the server (= unrestricted).
          allowedClientTags: newAllowedTags.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "Failed"); setCreating(false); return; }
      toast.success(`User ${newEmail} created`);
      setNewEmail(""); setNewPassword(""); setNewRole("inbox_manager"); setNewAllowedTags("");
      loadUsers();
    } catch (err) { toast.error((err as Error).message); }
    setCreating(false);
  }

  async function handleSaveAllowedTags(id: number) {
    const res = await fetch("/api/users/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update-allowed-tags",
        id,
        allowedClientTags: editTagsValue.trim() || null,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      toast.success("Client scope updated");
      setEditTagsId(null);
      setEditTagsValue("");
      loadUsers();
    } else {
      toast.error(data.error || "Failed");
    }
  }

  async function handleUpdateRole(id: number, role: string) {
    const res = await fetch("/api/users/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update-role", id, role }),
    });
    const data = await res.json();
    if (res.ok) { toast.success("Role updated"); loadUsers(); }
    else toast.error(data.error);
  }

  async function handleResetPassword(id: number) {
    if (!resetPassword) return;
    const res = await fetch("/api/users/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset-password", id, password: resetPassword }),
    });
    const data = await res.json();
    if (res.ok) { toast.success("Password reset"); setResetId(null); setResetPassword(""); }
    else toast.error(data.error);
  }

  async function handleDelete(user: AppUser) {
    if (!confirm(`Delete user "${user.email}"? This cannot be undone.`)) return;
    const res = await fetch("/api/users/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id: user.id }),
    });
    const data = await res.json();
    if (res.ok) { toast.success(`User ${user.email} deleted`); loadUsers(); }
    else toast.error(data.error);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">User Management</h2>
        <p className="text-sm text-muted-foreground">Add and manage users with role-based access</p>
      </div>

      {fetchError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">{fetchError}</div>
      )}

      {/* Create user */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Add New User</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-[200px] space-y-1">
              <Label className="text-xs">Email</Label>
              <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="user@example.com" required />
            </div>
            <div className="w-44 space-y-1">
              <Label className="text-xs">Password</Label>
              <Input type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Password" required />
            </div>
            <div className="w-40 space-y-1">
              <Label className="text-xs">Role</Label>
              <Select value={newRole} onValueChange={setNewRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="inbox_manager">Inbox Manager</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-52 space-y-1">
              <Label className="text-xs">Client scope (optional)</Label>
              <Input
                type="text"
                value={newAllowedTags}
                onChange={(e) => setNewAllowedTags(e.target.value)}
                placeholder="e.g. ESJ or ESJ, ABM"
                className="font-mono text-xs"
              />
            </div>
            <Button type="submit" disabled={creating}>{creating ? "Adding..." : "Add User"}</Button>
          </form>
          <div className="mt-3 text-xs text-muted-foreground space-y-0.5">
            <p><strong>Admin</strong> — Full access to all sections (Dashboard, Clients, Sections, Untracked, Inbox, Qualification, Errors, Users)</p>
            <p><strong>Inbox Manager</strong> — Access to Inbox and Clients only</p>
            <p><strong>Client scope</strong> — Comma-separated tags (e.g. <code className="text-[10px] bg-muted px-1">ESJ</code> or <code className="text-[10px] bg-muted px-1">ESJ, ABM</code>). Leave blank for unrestricted. Restricts the inbox to those clients only — N/A and other clients are hidden.</p>
          </div>
        </CardContent>
      </Card>

      {/* Users list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Users ({users.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {users.map((user) => (
            <div key={user.id} className="flex items-center justify-between border rounded-md px-4 py-3 gap-3 flex-wrap">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-medium">{user.email}</span>
                <Badge variant={user.role === "admin" ? "default" : "secondary"} className="text-xs capitalize">
                  {user.role.replace("_", " ")}
                </Badge>
                {/* Show client scope inline. Empty = unrestricted. */}
                {editTagsId === user.id ? (
                  <div className="flex items-center gap-1">
                    <Input
                      type="text"
                      value={editTagsValue}
                      onChange={(e) => setEditTagsValue(e.target.value)}
                      placeholder="ESJ, ABM (blank = all)"
                      className="w-52 h-7 text-xs font-mono"
                      autoFocus
                    />
                    <Button size="sm" className="h-7 text-xs" onClick={() => handleSaveAllowedTags(user.id)}>Save</Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditTagsId(null); setEditTagsValue(""); }}>Cancel</Button>
                  </div>
                ) : user.allowed_client_tags && user.allowed_client_tags.length ? (
                  <button
                    type="button"
                    onClick={() => { setEditTagsId(user.id); setEditTagsValue(user.allowed_client_tags!.join(", ")); }}
                    className="text-[11px] font-mono font-bold bg-primary/10 text-primary px-2 py-0.5 rounded border border-primary/30 hover:bg-primary/20"
                    title="Click to edit client scope"
                  >
                    Scoped: {user.allowed_client_tags.join(", ")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setEditTagsId(user.id); setEditTagsValue(""); }}
                    className="text-[11px] text-muted-foreground hover:text-foreground underline"
                    title="Add a client-tag scope for this user"
                  >
                    All clients
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Role switcher */}
                <Select value={user.role} onValueChange={(v) => handleUpdateRole(user.id, v)}>
                  <SelectTrigger className="w-40 h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="inbox_manager">Inbox Manager</SelectItem>
                  </SelectContent>
                </Select>

                {/* Reset password */}
                {resetId === user.id ? (
                  <div className="flex items-center gap-1">
                    <Input
                      type="text" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)}
                      placeholder="New password" className="w-36 h-8 text-xs"
                    />
                    <Button size="sm" className="h-8 text-xs" onClick={() => handleResetPassword(user.id)} disabled={!resetPassword}>Set</Button>
                    <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => { setResetId(null); setResetPassword(""); }}>Cancel</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setResetId(user.id)}>Reset Password</Button>
                )}

                {/* Delete */}
                <Button size="sm" variant="ghost" className="h-8 text-xs text-destructive hover:text-destructive" onClick={() => handleDelete(user)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
          {users.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No users found</p>}
        </CardContent>
      </Card>
    </div>
  );
}
