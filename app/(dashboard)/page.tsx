"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface ActivityEntry {
  id: number;
  timestamp: string;
  workflow: string;
  client_tag: string | null;
  section_name: string | null;
  lead_email: string | null;
  action: string;
  details: string | null;
}

interface ErrorEntry {
  id: number;
  timestamp: string;
  workflow: string;
  stage: string;
  message: string;
}

export default function DashboardPage() {
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const lastActivityIdRef = useRef(0);
  const lastErrorIdRef = useRef(0);

  useEffect(() => {
    async function poll() {
      try {
        const sinceActivity = lastActivityIdRef.current;
        const sinceError = lastErrorIdRef.current;

        const [actRes, errRes] = await Promise.all([
          fetch(`/api/activity?limit=50${sinceActivity ? `&since=${sinceActivity}` : ""}`),
          fetch(`/api/errors?limit=20${sinceError ? `&since=${sinceError}` : ""}`),
        ]);

        if (actRes.ok) {
          const newActivity: ActivityEntry[] = await actRes.json();
          if (newActivity.length > 0) {
            lastActivityIdRef.current = Math.max(...newActivity.map((a) => a.id));
            setActivity((prev) => {
              const existingIds = new Set(prev.map((a) => a.id));
              const unique = newActivity.filter((a) => !existingIds.has(a.id));
              return [...unique, ...prev].slice(0, 100);
            });
          }
        }

        if (errRes.ok) {
          const newErrors: ErrorEntry[] = await errRes.json();
          if (newErrors.length > 0) {
            lastErrorIdRef.current = Math.max(...newErrors.map((e) => e.id));
            setErrors((prev) => {
              const existingIds = new Set(prev.map((e) => e.id));
              const unique = newErrors.filter((e) => !existingIds.has(e.id));
              return [...unique, ...prev].slice(0, 50);
            });
          }
        }
      } catch {
        // Silently retry on next poll
      }
    }

    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, []);

  const actionColor: Record<string, string> = {
    created: "bg-green-100 text-green-800",
    updated: "bg-blue-100 text-blue-800",
    filtered: "bg-gray-100 text-gray-600",
    unroutable: "bg-yellow-100 text-yellow-800",
    error: "bg-red-100 text-red-800",
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-sm text-muted-foreground">Live webhook activity and errors</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Activity Feed */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              {activity.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No activity yet. Waiting for webhooks...
                </p>
              ) : (
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {activity.map((entry) => {
                    const details = entry.details ? (() => { try { return JSON.parse(entry.details); } catch { return null; } })() : null;
                    const baseId = details?.airtable_base_id;
                    return (
                      <div
                        key={entry.id}
                        className="flex items-center gap-3 py-2 px-3 rounded-md border text-sm"
                      >
                        <Badge
                          variant="secondary"
                          className={actionColor[entry.action] || ""}
                        >
                          {entry.action}
                        </Badge>
                        <Badge variant="outline">{entry.workflow}</Badge>
                        {entry.client_tag && (
                          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                            {entry.client_tag}
                          </span>
                        )}
                        {entry.lead_email && (
                          <span className="text-muted-foreground truncate max-w-[200px]">
                            {entry.lead_email}
                          </span>
                        )}
                        {(entry.section_name || baseId) && (
                          <span className="font-mono text-xs text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">
                            {entry.section_name ? `${entry.section_name} (${baseId || "—"})` : baseId}
                          </span>
                        )}
                        <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Error Feed */}
        <div>
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Errors</CardTitle>
                {errors.length > 0 && (
                  <Badge variant="destructive">{errors.length}</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {errors.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No errors
                </p>
              ) : (
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {errors.map((entry) => (
                    <div
                      key={entry.id}
                      className="py-2 px-3 rounded-md border border-destructive/20 bg-destructive/5 text-sm"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-xs">
                          {entry.workflow}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {entry.stage}
                        </span>
                      </div>
                      <p className="text-xs text-destructive truncate">
                        {entry.message}
                      </p>
                      <span className="text-xs text-muted-foreground">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
