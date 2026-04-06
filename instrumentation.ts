export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // DB calls from register() hang in Next.js 16 — use a timeout to prevent
    // blocking server startup. Tables already exist in production, so this is
    // only needed for fresh deployments.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("DB init timed out (10s)")), 10000)
    );

    try {
      const { initializeDatabase } = await import("./lib/db");
      await Promise.race([initializeDatabase(), timeout]);
      console.log("[instrumentation] Database initialized successfully");
    } catch (error) {
      console.error("[instrumentation] Database init skipped:", (error as Error).message);
    }
  }
}
