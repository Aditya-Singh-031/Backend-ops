const router = require("express").Router();
const ctrl = require("../controllers/operation.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/list", asyncHandler(ctrl.getList));
router.delete("/delete-selected", asyncHandler(ctrl.deleteSelected));
router.post("/export-selected", asyncHandler(ctrl.exportSelected));

module.exports = router;