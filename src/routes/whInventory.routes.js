const router = require("express").Router();
const ctrl = require("../controllers/whInventory.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/", asyncHandler(ctrl.list));
router.patch("/:inventoryId", asyncHandler(ctrl.update));
router.post("/direct", asyncHandler(ctrl.directAdd));
router.post("/bulk", ctrl.bulkBlock);

module.exports = router;
