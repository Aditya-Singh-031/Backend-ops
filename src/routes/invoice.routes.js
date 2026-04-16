const router = require("express").Router();
const ctrl = require("../controllers/invoice.controller");
const { authMiddleware } = require("../middleware/auth");
const multer = require("multer");
const path = require("path");

// Use multer to save PDFs into the uploads folder
const upload = multer({ dest: path.join(__dirname, "../../uploads/") });

router.use(authMiddleware);

router.post("/upload", upload.array("files", 20), ctrl.uploadInvoices);
router.get("/status/:job_id", ctrl.getJobStatus);
router.get("/download/:job_id", ctrl.downloadExcel);

module.exports = router;