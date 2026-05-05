const path = require("path");
const { app } = require("electron");

async function main() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  app.setPath("userData", path.join(appData, "secure-exam-desktop"));
  await app.whenReady();

  const logger = require(path.join(__dirname, "../dist/electron/supabase-logger.js"));
  logger.initSupabaseLogger();

  try {
    const result = await logger.drainSupabaseQueues();
    console.log("[DrainQueue] Completed", result);
  } finally {
    logger.shutdownSupabaseLogger();
    app.quit();
  }
}

main().catch((error) => {
  console.error("[DrainQueue] Failed", error);
  app.quit();
  process.exitCode = 1;
});
