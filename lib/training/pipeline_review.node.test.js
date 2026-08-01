// Unit tests for the GIGO gate-1 vocal-extraction review surface added to the
// training pipeline (node --test, no jest). We DON'T run the pipeline (needs
// GPU/Python); instead we construct a task and exercise the review-preview
// contract directly: option plumbing, file listing, and the audio path safety
// checks that back the /api/train/review/:id/audio stream.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pipeline = require("./pipeline");

function newTask(stepOptions) {
  const t = pipeline.createPipeline({
    voiceId: "rvtest_" + Math.random().toString(36).slice(2, 8),
    language: "ja",
    stepOptions: stepOptions || {},
  });
  const workDir = path.join(pipeline.STAGING_ROOT, t.getStatus().id);
  return { t, workDir };
}

function seedDenoise(workDir, names) {
  const dir = path.join(workDir, "denoise");
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), "x");
  return dir;
}

test("pauseAfterDenoise flows from stepOptions into status; reviewKind starts null", () => {
  const { t } = newTask({ pauseAfterDenoise: true });
  const st = t.getStatus();
  assert.equal(st.pauseAfterDenoise, true);
  assert.equal(st.reviewKind, null);
  assert.equal(st.awaitingReview, false);
});

test("pauseAfterDenoise defaults to false when not requested", () => {
  const { t } = newTask({});
  assert.equal(t.getStatus().pauseAfterDenoise, false);
});

test("getDenoisePreview lists workDir/denoise audio as rel paths, sorted, non-audio ignored", () => {
  const { t, workDir } = newTask({ pauseAfterDenoise: true });
  try {
    seedDenoise(workDir, ["b.wav", "a.wav", "notes.txt", "c.flac"]);
    const out = t.getDenoisePreview();
    assert.deepEqual(out.files.map((f) => f.name), ["a.wav", "b.wav", "c.flac"]);
    assert.deepEqual(out.files.map((f) => f.rel), ["denoise/a.wav", "denoise/b.wav", "denoise/c.flac"]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("getDenoisePreview returns empty list when nothing produced", () => {
  const { t } = newTask({ pauseAfterDenoise: true });
  assert.deepEqual(t.getDenoisePreview().files, []);
});

test("resolveReviewAudioPath resolves denoise files and blocks traversal / bad ext", () => {
  const { t, workDir } = newTask({ pauseAfterDenoise: true });
  try {
    seedDenoise(workDir, ["a.wav"]);
    const ok = t.resolveReviewAudioPath("denoise/a.wav");
    assert.ok(ok && ok.endsWith(path.join("denoise", "a.wav")));
    // Traversal + absolute escapes must be rejected.
    assert.equal(t.resolveReviewAudioPath("../../etc/passwd"), null);
    assert.equal(t.resolveReviewAudioPath("/etc/passwd"), null);
    // Disallowed extension rejected even if inside workDir.
    fs.writeFileSync(path.join(workDir, "denoise", "x.txt"), "x");
    assert.equal(t.resolveReviewAudioPath("denoise/x.txt"), null);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("resume() on an idle (non-awaiting) task returns false", () => {
  const { t } = newTask({ pauseAfterDenoise: true });
  assert.equal(t.resume(), false);
});
