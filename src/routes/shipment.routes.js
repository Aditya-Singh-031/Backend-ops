const router = require("express").Router();
const ctrl = require("../controllers/shipment.controller");
const { validate } = require("../middleware/validate");
const { saveShipmentSchema, quickCreateShipmentSchema, generateInvoiceSchema } = require("../validators/shipment.validator");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");
const multer = require("multer");
const path = require("path");

const upload = multer({ dest: path.join(__dirname, "../../uploads/") });

router.use(authMiddleware);

router.get("/", asyncHandler(ctrl.list));
router.get("/download-sample", ctrl.downloadSample);
router.get("/:id", asyncHandler(ctrl.getById));
router.post("/", validate(quickCreateShipmentSchema), asyncHandler(ctrl.quickCreate));
router.post("/save", validate(saveShipmentSchema), asyncHandler(ctrl.save));
router.post("/upload-excel", upload.single("excelFile"), asyncHandler(ctrl.uploadExcel));
router.post("/upload-image", upload.single("imageFile"), asyncHandler(ctrl.uploadImage));
router.post("/generate/invoice", validate(generateInvoiceSchema), asyncHandler(ctrl.generateInvoice));
router.post("/generate/working-excel", asyncHandler(ctrl.generateWorkingExcel));
router.post("/generate/all-letters", asyncHandler(ctrl.generateAllLetters));

module.exports = router;
