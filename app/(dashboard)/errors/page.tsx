"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ErrorEntry {
  id: number;
  timestamp: string;
  workflow: string;
  stage: string;
  message: string;
  payload: string | null;
}

export default function ErrorsPage() {
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [retryResult, setRetryResult] = useState<{ id: number; success: boolean; message: string } | null>(null);

  const loadErrors = useCallback(async () => {
    let url = "/api/errors?limit=200";
    if (filter) url += `&workflow=${filter}`;
    const res = await fetch(url);
    if (res.ok) setErrors(await res.json());
  }, [filter]);

  useEffect(() => {
    loadErrors();
    const interval = setInterval(loadErrors, 3000);
    return () => clearInterval(interval);
  }, [loadErrors]);

  async function deleteError(id: number) {
    await fetch("/api/errors", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    loadErrors();
  }

  async function clearAll() {
    if (!confirm("Clear all errors?")) return;
    await fetch("/api/errors", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    loadErrors();
  }

  async function retryError(id: number) {
    setRetrying(id);
    setRetryResult(null);
    try {
      const res = await fetch("/api/errors/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (res.ok) {
        setRetryResult({ id, success: true, message: "Retry successful!" });
        loadErrors();
      } else {
        setRetryResult({ id, success: false, message: data.error || "Retry failed" });
      }
    } catch {
      setRetryResult({ id, success: false, message: "Network error" });
    } finally {
      setRetrying(null);
      setTimeout(() => setRetryResult(null), 5000);
    }
  }

  function hasRetryPayload(entry: ErrorEntry): boolean {
    if (!entry.payload) return false;
    try {
      const parsed = JSON.parse(entry.payload);
      return !!parsed._webhook_payload || !!parsed._clay_retry_data;
    } catch {
      return false;
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Error Log</h2>
          <p className="text-sm text-muted-foreground">
            Auto-refreshes every 3 seconds
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={filter === null ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(null)}
          >
            All
          </Button>
          <Button
            variant={filter === "tracked" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter("tracked")}
          >
            Tracked
          </Button>
          <Button
            variant={filter === "untracked" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter("untracked")}
          >
            Untracked
          </Button>
          {errors.length > 0 && (
            <Button variant="destructive" size="sm" onClick={clearAll}>
              Clear All
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Errors</CardTitle>
            <Badge variant={errors.length > 0 ? "destructive" : "secondary"}>
              {errors.length}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {errors.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No errors
            </p>
          ) : (
            <div className="space-y-2">
              {errors.map((entry) => {
                const canRetry = (entry.stage === "webhook" || entry.stage === "clay") && hasRetryPayload(entry);
                return (
                  <div
                    key={entry.id}
                    className="border rounded-md overflow-hidden"
                  >
                    <div
                      className="flex items-center gap-3 py-2 px-3 cursor-pointer hover:bg-muted/50 text-sm"
                      onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                    >
                      <Badge variant="outline">{entry.workflow}</Badge>
                      <span className="text-xs font-mono text-muted-foreground">
                        {entry.stage}
                      </span>
                      <span className="truncate flex-1 text-destructive">
                        {entry.message}
                      </span>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(entry.timestamp).toLocaleString()}
                      </span>
                      {canRetry && (
                        <button
                          onClick={(e) => { e.stopPropagation(); retryError(entry.id); }}
                          disabled={retrying === entry.id}
                          className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 px-2 py-0.5 rounded border border-blue-200 bg-blue-50 hover:bg-blue-100"
                        >
                          {retrying === entry.id ? "Retrying..." : "Retry"}
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteError(entry.id); }}
                        className="text-xs text-muted-foreground hover:text-destructive"
                      >
                        Dismiss
                      </button>
                    </div>
                    {retryResult?.id === entry.id && (
                      <div className={`px-3 py-1.5 text-xs border-t ${retryResult.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                        {retryResult.message}
                      </div>
                    )}
                    {expanded === entry.id && entry.payload && (
                      <pre className="bg-muted/30 p-3 text-xs overflow-x-auto border-t">
                        {(() => {
                          try {
                            const parsed = JSON.parse(entry.payload!);
                            if (parsed._webhook_payload) {
                              const { _webhook_payload, ...context } = parsed;
                              const leadEmail = _webhook_payload?.data?.lead?.email
                                || _webhook_payload?.data?.reply?.from_email_address
                                || "stored";
                              return JSON.stringify(
                                { ...context, _webhook_payload: `[payload for ${leadEmail} — click Retry to reprocess]` },
                                null, 2
                              );
                            }
                            return JSON.stringify(parsed, null, 2);
                          } catch {
                            return entry.payload;
                          }
                        })()}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
