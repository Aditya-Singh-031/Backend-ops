const router = require("express").Router();
const ctrl = require("../controllers/whInward.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");
const multer = require("multer");

const upload = multer({ storage: multer.memoryStorage() });

router.use(authMiddleware);

router.get("/", asyncHandler(ctrl.list));
router.post("/", asyncHandler(ctrl.create));
router.get("/:inwardId", asyncHandler(ctrl.getById));
router.patch("/:inwardId", asyncHandler(ctrl.update));
router.post("/:inwardId/complete", asyncHandler(ctrl.complete));
router.patch("/:inwardId/reopen", asyncHandler(ctrl.reopen));
router.post("/:inwardId/upload-invoices", upload.array("files"), asyncHandler(ctrl.uploadInvoices));
router.get("/:inwardId/details", asyncHandler(ctrl.getDetails));
router.post("/:inwardId/details", asyncHandler(ctrl.addDetail));
router.patch("/:inwardId/details/bulk", ctrl.bulkDetailBlock);
router.patch("/:inwardId/details/:detailId", asyncHandler(ctrl.updateDetail));

module.exports = router;
