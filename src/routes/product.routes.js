const router = require("express").Router();
const ctrl = require("../controllers/product.controller");
const { validate } = require("../middleware/validate");
const { createProductSchema, updateProductSchema } = require("../validators/product.validator");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/", asyncHandler(ctrl.list));
router.post("/", validate(createProductSchema), asyncHandler(ctrl.create));
router.get("/part/:partNumber", asyncHandler(ctrl.getByPartNumber));
router.get("/:id", asyncHandler(ctrl.getById));
router.put("/:id", validate(updateProductSchema), asyncHandler(ctrl.update));
router.delete("/:id", asyncHandler(ctrl.remove));

module.exports = router;
