const router = require("express").Router();
const ctrl = require("../controllers/upload.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");
const multer = require("multer");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authMiddleware);

router.post("/", upload.single("file"), asyncHandler(ctrl.upload));

module.exports = router;
