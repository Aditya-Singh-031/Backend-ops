const router = require("express").Router();
const ctrl = require("../controllers/orderDetail.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/order/:orderId", asyncHandler(ctrl.getByOrder));
router.get("/:id", asyncHandler(ctrl.getById));
router.put("/:id", asyncHandler(ctrl.update));
router.delete("/:id", asyncHandler(ctrl.remove));

module.exports = router;
