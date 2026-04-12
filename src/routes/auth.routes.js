const router = require("express").Router();
const ctrl = require("../controllers/auth.controller");
const { validate } = require("../middleware/validate");
const { authMiddleware } = require("../middleware/auth");
const { loginSchema } = require("../validators/auth.validator");
const { asyncHandler } = require("../utils/helpers");

router.post("/login", validate(loginSchema), asyncHandler(ctrl.login));
router.get("/me", authMiddleware, asyncHandler(ctrl.me));
router.post("/logout", asyncHandler(ctrl.logout));

module.exports = router;
