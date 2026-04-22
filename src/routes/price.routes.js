const router = require("express").Router();
const brandCtrl = require("../controllers/brand.controller");
const excelCtrl = require("../controllers/excel.controller");
const { asyncHandler } = require("../utils/helpers");
const { authMiddleware } = require("../middleware/auth");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// --- LOGO UPLOADS ---
const logoDir = path.join(__dirname, "../../storage/uploads/brands");
if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, logoDir),
  filename: (req, file, cb) => cb(null, `brand-${req.params.id}-${Date.now()}${path.extname(file.originalname)}`)
});
const uploadLogo = multer({ storage: logoStorage });

// --- EXCEL UPLOADS ---
const excelDir = path.join(__dirname, "../../storage/uploads/excels");
if (!fs.existsSync(excelDir)) fs.mkdirSync(excelDir, { recursive: true });

const excelStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, excelDir),
  filename: (req, file, cb) => cb(null, `prices-${Date.now()}${path.extname(file.originalname)}`)
});
const uploadExcel = multer({ storage: excelStorage });

// --- ROUTES ---
router.use(authMiddleware);

// Brand Architecture
router.get("/brands", asyncHandler(brandCtrl.getBrands));
router.post("/brands", asyncHandler(brandCtrl.createBrand));
router.put("/brands/:id", asyncHandler(brandCtrl.updateBrand));
router.post("/brands/:id/logo", uploadLogo.single("logo"), asyncHandler(brandCtrl.uploadLogo));

// Excel & Price List Architecture
router.get("/brands/:id/parts", asyncHandler(excelCtrl.getBrandParts));
router.post("/price-list/upload", uploadExcel.single("file"), asyncHandler(excelCtrl.uploadPriceList));
router.post("/price-list/download", asyncHandler(excelCtrl.downloadPriceList));
// 💥 NEW: Pure JSON streaming route
router.post("/price-list/stream", asyncHandler(excelCtrl.uploadPriceListStream));
module.exports = router;