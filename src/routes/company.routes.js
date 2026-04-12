const router = require("express").Router();
const ctrl = require("../controllers/company.controller");
const { validate } = require("../middleware/validate");
const { createCompanySchema } = require("../validators/company.validator");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/", asyncHandler(ctrl.list));
router.post("/", validate(createCompanySchema), asyncHandler(ctrl.create));

module.exports = router;
