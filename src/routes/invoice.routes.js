const router = require("express").Router();
const ctrl = require("../controllers/invoice.controller");
const { authMiddleware } = require("../middleware/auth");
const multer = require("multer");
const path = require("path");

const fs = require("fs");

// Save PDFs to storage/uploads/ with original .pdf extension preserved
// This folder is already served as static at /api/uploads by the Express server
const uploadsDir = path.join(__dirname, "../../storage/uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const ext = path.extname(file.originalname) || ".pdf";
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({ storage });


router.use(authMiddleware);

router.post("/upload",                  upload.array("files", 20), ctrl.uploadInvoices);
router.get("/status/:job_id",           ctrl.getJobStatus);
router.get("/status-json/:job_id",      ctrl.getJobStatusJson);
router.get("/download/:job_id",         ctrl.downloadExcel);
router.get("/:invoice_id/parsed-data",  ctrl.getParsedData);   // ← view parsed invoice + line items
router.patch("/:id/link-po",            ctrl.linkToPO);         // ← link/unlink invoice to a PO

module.exports = router;