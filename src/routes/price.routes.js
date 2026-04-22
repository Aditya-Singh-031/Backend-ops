const router = require("express").Router();
const ctrl = require("../controllers/price.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// --- LOGO UPLOADS CONFIG ---
const logoDir = path.join(__dirname, "../../storage/uploads/brands");
if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, logoDir),
  filename: (req, file, cb) => cb(null, `brand-${req.params.id}-${Date.now()}${path.extname(file.originalname)}`)
});
const uploadLogo = multer({ storage: logoStorage });

// --- EXCEL UPLOADS CONFIG ---
const excelDir = path.join(__dirname, "../../storage/uploads/excels");
if (!fs.existsSync(excelDir)) fs.mkdirSync(excelDir, { recursive: true });

const excelStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, excelDir),
  filename: (req, file, cb) => cb(null, `prices-${Date.now()}${path.extname(file.originalname)}`)
});
const uploadExcel = multer({ storage: excelStorage });


// --- ROUTES ---
router.use(authMiddleware);

router.get("/brands", asyncHandler(ctrl.getBrands));
router.post("/brands", asyncHandler(ctrl.createBrand));
router.put("/brands/:id", asyncHandler(ctrl.updateBrand));
router.post("/brands/:id/logo", uploadLogo.single("logo"), asyncHandler(ctrl.uploadLogo));

// 💥 NEW: Route to fetch parts for the frontend popup table
router.get("/brands/:id/parts", asyncHandler(ctrl.getBrandParts));

router.post("/price-list/upload", uploadExcel.single("file"), asyncHandler(ctrl.uploadPriceList));
router.post("/price-list/download", asyncHandler(ctrl.downloadPriceList));

module.exports = router;