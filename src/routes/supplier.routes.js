const router = require("express").Router();
const ctrl = require("../controllers/supplier.controller");
const { authMiddleware } = require("../middleware/auth");

router.use(authMiddleware);

// 💥 NEW: Alias routes for storing merges globally
router.get("/aliases", ctrl.getAliases);
router.post("/aliases", ctrl.updateAliases);

router.get("/", ctrl.getSuppliers);
router.post("/", ctrl.createSupplier);

module.exports = router;