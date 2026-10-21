// Background copy/move migration job runner. Extracted from server.js (P0 refactor).

const path = require("path");
const fsp = require("fs").promises;

async function runMigrationJob(job, entries, { ASSETS_DIR, firstMismatch, writeConfig, localError }) {
  const sameName = (n) => n;
  try {
    // Step 1: copy
    for (const e of entries) {
      job.currentName = sameName(e.name);
      await fsp.cp(path.join(ASSETS_DIR, e.name), path.join(job.target, e.name), { recursive: true, force: true });
      job.current += 1;
    }
    job.steps.copy = "done";

    if (job.migration === "move") {
      // Step 2: verify integrity before deleting anything
      job.phase = "verifying"; job.steps.verify = "running"; job.current = 0; job.currentName = "";
      for (const e of entries) {
        job.currentName = e.name;
        const bad = await firstMismatch(path.join(ASSETS_DIR, e.name), path.join(job.target, e.name));
        if (bad) throw new Error(`integrity check failed for "${bad}" — source left intact, nothing deleted`);
        job.current += 1;
      }
      job.steps.verify = "done";

      // Step 3: delete sources (only now that the copy is verified complete)
      job.phase = "deleting"; job.steps.delete = "running"; job.current = 0; job.currentName = "";
      for (const e of entries) {
        job.currentName = e.name;
        await fsp.rm(path.join(ASSETS_DIR, e.name), { recursive: true, force: true });
        job.current += 1;
      }
      job.steps.delete = "done";
    }

    writeConfig({ assetsRoot: job.target });
    job.phase = "done"; job.done = true; job.note = job.doneNote; job.finishedAt = Date.now();
  } catch (err) {
    job.phase = "error"; job.done = true; job.error = localError(err); job.finishedAt = Date.now();
    if (job.steps.copy === "running") job.steps.copy = "failed";
    else if (job.steps.verify === "running") job.steps.verify = "failed";
    else if (job.steps.delete === "running") job.steps.delete = "failed";
  }
}

module.exports = { runMigrationJob };
