const router = require("express").Router();
const ctrl = require("../controllers/operation.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/list", asyncHandler(ctrl.getList));

module.exports = router;