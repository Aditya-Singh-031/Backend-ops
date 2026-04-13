const router = require("express").Router();
const ctrl = require("../controllers/inward.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/invoices", asyncHandler(ctrl.listInvoices));
router.get("/", asyncHandler(ctrl.list));
router.post("/", asyncHandler(ctrl.create));
router.post("/:id/select-invoices", asyncHandler(ctrl.selectInvoices));
router.post("/:id/receive", asyncHandler(ctrl.receive));
router.post("/:id/exceptions", asyncHandler(ctrl.exceptions));
router.post("/:id/verify", asyncHandler(ctrl.verify));
router.post("/:id/pack", asyncHandler(ctrl.pack));
router.post("/:id/complete", asyncHandler(ctrl.complete));
router.post("/:id/details", asyncHandler(ctrl.addDetail));
router.patch("/:id/details/:detailId", asyncHandler(ctrl.updateDetail));
router.get("/:id/export-excel", asyncHandler(ctrl.exportExcel));

module.exports = router;
