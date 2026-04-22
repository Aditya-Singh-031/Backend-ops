const { getDb } = require("../config/db");
const { sendSuccess } = require("../utils/response");
const { ObjectId } = require("mongodb");
const xlsx = require("xlsx");
const fs = require("fs");

exports.getBrandParts = async (req, res) => {
  const db = await getDb();
  const { id } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = 50; 
  const skip = (page - 1) * limit;

  const parts = await db.collection("parts")
    .find({ brand_id: new ObjectId(id) })
    .sort({ part_number_clean: 1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const total = await db.collection("parts").countDocuments({ brand_id: new ObjectId(id) });
  sendSuccess(res, { parts, total, page, totalPages: Math.ceil(total / limit) });
};

exports.uploadPriceList = async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No Excel file uploaded" });
  
  try {
    const brand_id = req.body.brand_id;
    if (!brand_id) throw new Error("Brand ID is required");

    const db = await getDb();
    
    // Strip out heavy styles to protect RAM
    const workbook = xlsx.readFile(req.file.path, { cellDates: true, cellFormula: false, cellHTML: false, cellStyles: false });
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });

    let bulkOps = [];
    let validRows = 0;

    for (const row of data) {
      const partRaw = row["Part Number"] || row["Part No"] || row["Part #"] || row["part_number"] || row["Part No."];
      const mrpRaw = row["MRP"] || row["RTLP"] || row["Price"] || row["Base MRP"];
      const descRaw = row["Description"] || row["Desc"] || row["Part Name"] || "";

      if (!partRaw || mrpRaw === undefined || mrpRaw === "") continue;

      const cleanPart = String(partRaw).replace(/\s+/g, "").toUpperCase();
      const mrp = parseFloat(String(mrpRaw).replace(/,/g, ""));
      if (isNaN(mrp)) continue;

      bulkOps.push({
        updateOne: {
          filter: { brand_id: new ObjectId(brand_id), part_number_clean: cleanPart },
          update: { $set: { part_number_original: String(partRaw), description: String(descRaw), mrp: mrp, updated_at: new Date() } },
          upsert: true
        }
      });
      validRows++;

      // Safely chunk the database inserts
      if (bulkOps.length >= 500) {
        await db.collection("parts").bulkWrite(bulkOps, { ordered: false });
        bulkOps = []; 
      }
    }

    if (bulkOps.length > 0) {
      await db.collection("parts").bulkWrite(bulkOps, { ordered: false });
    }

    const totalParts = await db.collection("parts").countDocuments({ brand_id: new ObjectId(brand_id) });
    await db.collection("brands").updateOne({ _id: new ObjectId(brand_id) }, { $set: { total_parts: totalParts } });
    const finalBrand = await db.collection("brands").findOne({ _id: new ObjectId(brand_id) });

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    sendSuccess(res, { message: `Mapped ${validRows} parts!`, brand: { ...finalBrand, id: finalBrand._id.toString() } });

  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.downloadPriceList = async (req, res) => {
  try {
    const { brand_id, buyer_name, discount_percent, currency, exchange_rate } = req.body;
    const db = await getDb();

    const brand = await db.collection("brands").findOne({ _id: new ObjectId(brand_id) });
    if (!brand) throw new Error("Brand not found");

    const parts = await db.collection("parts").find({ brand_id: new ObjectId(brand_id) }).toArray();
    const discount = parseFloat(discount_percent) || 0;
    const rate = parseFloat(exchange_rate) || 1;

    const exportData = parts.map(p => {
      const baseNoGst = p.mrp / 1.18;
      const discounted = baseNoGst * (1 - (discount / 100));
      const finalPrice = discounted / rate;

      return {
        "Brand": brand.name,
        "Part Number": p.part_number_original,
        "Description": p.description,
        "Base MRP (INR)": p.mrp,
        [`Net Price (${currency})`]: parseFloat(finalPrice.toFixed(2))
      };
    });

    const ws = xlsx.utils.json_to_sheet(exportData);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Buyer Prices");
    const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Disposition", `attachment; filename="Morsebiz_${buyer_name}_Prices.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};