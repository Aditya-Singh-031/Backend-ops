const router = require("express").Router();
const ctrl = require("../controllers/price.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Ensure the brand uploads directory exists
const uploadDir = path.join(__dirname, "../../uploads/brands");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer to save images securely
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `brand-${req.params.id}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage: storage });

router.use(authMiddleware);

router.get("/brands", asyncHandler(ctrl.getBrands));
router.post("/brands", asyncHandler(ctrl.createBrand));
router.put("/brands/:id", asyncHandler(ctrl.updateBrand));

// 💥 NEW: Route specifically for uploading the logo
router.post("/brands/:id/logo", upload.single("logo"), asyncHandler(ctrl.uploadLogo));

module.exports = router;