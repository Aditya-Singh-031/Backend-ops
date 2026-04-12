const router = require("express").Router();
const ctrl = require("../controllers/user.controller");
const { validate } = require("../middleware/validate");
const { createUserSchema, updateUserSchema } = require("../validators/user.validator");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/", asyncHandler(ctrl.list));
router.post("/", validate(createUserSchema), asyncHandler(ctrl.create));
router.put("/:id", validate(updateUserSchema), asyncHandler(ctrl.update));
router.delete("/:id", asyncHandler(ctrl.remove));

module.exports = router;
