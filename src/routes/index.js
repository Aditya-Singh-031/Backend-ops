const router = require("express").Router();

router.use("/auth", require("./auth.routes"));
router.use("/users", require("./user.routes"));
router.use("/companies", require("./company.routes"));
router.use("/upload", require("./upload.routes"));
router.use("/shipments", require("./shipment.routes"));
router.use("/buyers", require("./buyer.routes"));
router.use("/products", require("./product.routes"));
router.use("/orders", require("./order.routes"));
router.use("/order-details", require("./orderDetail.routes"));
router.use("/inwards", require("./inward.routes"));
router.use("/outwards", require("./outward.routes"));
router.use("/warehouse/inwards", require("./whInward.routes"));
router.use("/warehouse/inventory", require("./whInventory.routes"));
router.use("/warehouse/files", require("./whFile.routes"));
router.use("/warehouse/skus", require("./whSku.routes"));

module.exports = router;
