const router = require("express").Router();
const ctrl = require("../controllers/order.controller");
const { validate } = require("../middleware/validate");
const { createOrderSchema, updateOrderSchema, updateStatusSchema } = require("../validators/order.validator");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");
const multer = require("multer");
const path = require("path");

const upload = multer({ dest: path.join(__dirname, "../../uploads/") });

router.use(authMiddleware);

router.get("/bank-accounts", asyncHandler(ctrl.getBankAccounts));
router.get("/next-pi-number", asyncHandler(ctrl.getNextPINumber));
router.get("/", asyncHandler(ctrl.list));
router.post("/", validate(createOrderSchema), asyncHandler(ctrl.create));
router.get("/download-template", asyncHandler(ctrl.downloadTemplate));
router.post("/import/preview", upload.single("file"), asyncHandler(ctrl.importPreview));
router.post("/upload-excel", upload.single("file"), asyncHandler(ctrl.uploadExcel));
router.get("/:id", asyncHandler(ctrl.getById));
router.put("/:id", validate(updateOrderSchema), asyncHandler(ctrl.update));
router.patch("/:id/status", validate(updateStatusSchema), asyncHandler(ctrl.updateStatus));
router.delete("/:id", asyncHandler(ctrl.remove));
router.get("/:id/download-excel", asyncHandler(ctrl.downloadExcel));
router.get("/:id/download-pdf", asyncHandler(ctrl.downloadPdf));

module.exports = router;
