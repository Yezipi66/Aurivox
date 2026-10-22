// Multer upload configuration: voice and custom-ref disk storage, file filters, limits.

const multer = require("multer");
const path = require("path");

const ALLOWED_EXT = new Set([".wav", ".mp3", ".flac", ".m4a", ".ogg", ".webm"]);

function createStorage(VOICES_DIR) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, VOICES_DIR),
    filename: (req, file, cb) => {
      const id = req.params.id;
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${id}${ext}`);
    },
  });
}

function createUpload(VOICES_DIR) {
  const storage = createStorage(VOICES_DIR);
  return multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ALLOWED_EXT.has(ext)) return cb(null, true);
      cb(new Error(`Unsupported file type: ${ext}`));
    },
  });
}

function createCustomRefStorage(CUSTOM_REF_DIR) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, CUSTOM_REF_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const base = path.basename(file.originalname, path.extname(file.originalname))
        .replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "ref";
      cb(null, `${Date.now()}_${base}${ext}`);
    },
  });
}

function createCustomRefUpload(CUSTOM_REF_DIR) {
  const customRefStorage = createCustomRefStorage(CUSTOM_REF_DIR);
  return multer({
    storage: customRefStorage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ALLOWED_EXT.has(ext)) return cb(null, true);
      cb(new Error(`Unsupported file type: ${ext}`));
    },
  });
}

module.exports = { ALLOWED_EXT, createUpload, createCustomRefUpload };
