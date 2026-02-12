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
              {errors.map((entry) => (
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
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteError(entry.id); }}
                      className="text-xs text-muted-foreground hover:text-destructive"
                    >
                      Dismiss
                    </button>
                  </div>
                  {expanded === entry.id && entry.payload && (
                    <pre className="bg-muted/30 p-3 text-xs overflow-x-auto border-t">
                      {JSON.stringify(JSON.parse(entry.payload), null, 2)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
