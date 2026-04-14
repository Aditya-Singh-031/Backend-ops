const router = require("express").Router();
const ctrl = require("../controllers/dashboard.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/stats", asyncHandler(ctrl.getStats));
router.get("/suppliers", asyncHandler(ctrl.getSuppliers));

module.exports = router;