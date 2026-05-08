const router = require("express").Router();
const ctrl = require("../controllers/purchaseOrder.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");
const multer = require("multer");
const path = require("path");

const upload = multer({ dest: path.join(__dirname, "../../uploads/") });

router.use(authMiddleware);

// Collection routes
router.get("/", asyncHandler(ctrl.list));
router.post("/", asyncHandler(ctrl.create));
router.post("/import/preview", upload.single("file"), asyncHandler(ctrl.importPreview));

// Single PO routes
router.get("/:id", asyncHandler(ctrl.getById));
router.put("/:id", asyncHandler(ctrl.update));
router.delete("/:id", asyncHandler(ctrl.remove));
router.get("/:id/download", asyncHandler(ctrl.download));

// Invoice linkage
router.get("/:id/invoices", asyncHandler(ctrl.getInvoices));
router.post("/:id/link-invoices", asyncHandler(ctrl.linkInvoices));
router.delete("/:id/unlink-invoices", asyncHandler(ctrl.unlinkInvoices));

// Proforma invoice associations
router.patch("/:id/proforma-invoices", asyncHandler(ctrl.updateProformaInvoices));

// Reports
router.post("/:id/discrepancy-report", asyncHandler(ctrl.discrepancyReport));

module.exports = router;
