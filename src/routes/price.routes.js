const router = require("express").Router();
const ctrl = require("../controllers/price.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/brands", asyncHandler(ctrl.getBrands));
router.post("/brands", asyncHandler(ctrl.createBrand));

module.exports = router;