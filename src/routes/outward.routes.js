const router = require("express").Router();
const ctrl = require("../controllers/outward.controller");
const { validate } = require("../middleware/validate");
const { createOutwardSchema, updateOutwardSchema } = require("../validators/outward.validator");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

const joinCtrl = require("../controllers/outwardJoin.controller");

router.get("/buyers", asyncHandler(ctrl.buyersList));
router.get("/available-boxes", asyncHandler(ctrl.availableBoxes));
router.get("/joins", asyncHandler(joinCtrl.listJoins));
router.get("/", asyncHandler(ctrl.list));
router.get("/:id/buyer-orders", asyncHandler(ctrl.getOutwardBuyerOrders));
router.get("/:id/join", asyncHandler(joinCtrl.getJoin));
router.get("/:id/export-packing-list", asyncHandler(ctrl.exportPackingList));
router.get("/:id/export-join", asyncHandler(ctrl.exportJoin));
router.post("/:id/join", asyncHandler(joinCtrl.saveJoin));
router.post("/:id/trigger-ai", asyncHandler(joinCtrl.triggerAiProcessing));
router.get("/:id", asyncHandler(ctrl.getById));
router.post("/", validate(createOutwardSchema), asyncHandler(ctrl.create));
router.patch("/:id", validate(updateOutwardSchema), asyncHandler(ctrl.update));
router.patch("/:id/boxes/:boxId", asyncHandler(ctrl.updateBox));
router.patch("/:id/status", asyncHandler(ctrl.updateStatus));
router.delete("/joins/:joinId", asyncHandler(joinCtrl.removeJoin));
router.delete("/:id/boxes/:boxId", asyncHandler(ctrl.removeBox));
router.delete("/:id", asyncHandler(ctrl.remove));

module.exports = router;
