const router = require("express").Router();
const ctrl = require("../controllers/supplier.controller");
const { authMiddleware } = require("../middleware/auth");

// Secure the routes
router.use(authMiddleware);

// Map the GET and POST requests to the controller functions
router.get("/", ctrl.getSuppliers);
router.post("/", ctrl.createSupplier);

module.exports = router;