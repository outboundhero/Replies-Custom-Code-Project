export async function register() {
  // Only run on the server, not during Next.js edge runtime
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeDatabase } = await import("./lib/db");
    await initializeDatabase();
  }
}
