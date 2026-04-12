const router = require("express").Router();
const ctrl = require("../controllers/outward.controller");
const { validate } = require("../middleware/validate");
const { createOutwardSchema, updateOutwardSchema } = require("../validators/outward.validator");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/buyers", asyncHandler(ctrl.buyersList));
router.get("/available-boxes", asyncHandler(ctrl.availableBoxes));
router.get("/", asyncHandler(ctrl.list));
router.get("/:id", asyncHandler(ctrl.getById));
router.post("/", validate(createOutwardSchema), asyncHandler(ctrl.create));
router.patch("/:id", validate(updateOutwardSchema), asyncHandler(ctrl.update));
router.patch("/:id/boxes/:boxId", asyncHandler(ctrl.updateBox));
router.patch("/:id/status", asyncHandler(ctrl.updateStatus));
router.delete("/:id/boxes/:boxId", asyncHandler(ctrl.removeBox));

module.exports = router;
