const router = require("express").Router();
const ctrl = require("../controllers/invoice.controller");
const { authMiddleware } = require("../middleware/auth");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// 💥 THE FIX: We added "/pdfs" to the end of this path!
// Now Multer will save new uploads directly into the folder that server.js is serving.
const uploadsDir = path.join(__dirname, "../../storage/uploads/pdfs");
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
router.get("/:invoice_id/parsed-data",  ctrl.getParsedData);   
router.patch("/:id/link-po",            ctrl.linkToPO);         

// Self-healing routes
router.get("/:invoice_id/find-pdf",     ctrl.findMissingPdf);
router.patch("/:invoice_id/update-pdf", ctrl.updatePdfUrl);

module.exports = router;