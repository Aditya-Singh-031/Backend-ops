const router = require("express").Router();
const ctrl = require("../controllers/whFile.controller");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.post("/upload", ctrl.uploadMiddleware, ctrl.upload);

module.exports = router;
