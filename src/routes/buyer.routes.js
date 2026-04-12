const router = require("express").Router();
const ctrl = require("../controllers/buyer.controller");
const { validate } = require("../middleware/validate");
const { createBuyerSchema, updateBuyerSchema } = require("../validators/buyer.validator");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/", asyncHandler(ctrl.list));
router.post("/", validate(createBuyerSchema), asyncHandler(ctrl.create));
router.get("/:id", asyncHandler(ctrl.getById));
router.put("/:id", validate(updateBuyerSchema), asyncHandler(ctrl.update));
router.delete("/:id", asyncHandler(ctrl.remove));

module.exports = router;
