const router = require("express").Router();
const ctrl = require("../controllers/whSku.controller");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

router.get("/", ctrl.list);

module.exports = router;
