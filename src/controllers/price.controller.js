const { getDb } = require("../config/db");
const { sendSuccess } = require("../utils/response");
const { ObjectId } = require("mongodb");

exports.getBrands = async (req, res) => {
  // 💥 THE FIX: Added 'await' here
  const db = await getDb(); 
  
  // Fetch all brands, sorted alphabetically
  const brands = await db.collection("brands").find().sort({ name: 1 }).toArray();
  
  // Map _id to id for the frontend
  const formattedBrands = brands.map(b => ({ ...b, id: b._id.toString() }));
  sendSuccess(res, formattedBrands);
};

exports.createBrand = async (req, res) => {
  // 💥 THE FIX: Added 'await' here
  const db = await getDb(); 
  const { name, vendor_notes } = req.body;
  
  const newBrand = {
    name: name.trim(),
    vendor_notes: vendor_notes ? vendor_notes.trim() : null,
    total_parts: 0,
    created_at: new Date()
  };

  const result = await db.collection("brands").insertOne(newBrand);
  sendSuccess(res, { ...newBrand, id: result.insertedId.toString() });
};

exports.updateBrand = async (req, res) => {
  // 💥 THE FIX: Added 'await' here
  const db = await getDb(); 
  const { id } = req.params;
  const { name, vendor_notes } = req.body;

  await db.collection("brands").updateOne(
    { _id: new ObjectId(id) },
    { $set: { 
        name: name.trim(), 
        vendor_notes: vendor_notes ? vendor_notes.trim() : null,
        updated_at: new Date() 
      } 
    }
  );

  sendSuccess(res, { id, name, vendor_notes });
};
exports.uploadLogo = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: "No image file uploaded" });
  }
  
  const db = await getDb();
  const { id } = req.params;
  
  // 💥 THE FIX: Add /api to the front of the URL saved in the database
  const logo_url = `/api/uploads/brands/${req.file.filename}`;

  await db.collection("brands").updateOne(
    { _id: new ObjectId(id) },
    { $set: { logo_url: logo_url, updated_at: new Date() } }
  );

  sendSuccess(res, { id, logo_url });
};
// ... (Keep your getBrands, createBrand, updateBrand, and uploadLogo at the top)

const xlsx = require("xlsx");
const fs = require("fs");

// 💥 NEW: Fetch Parts for the Catalog Viewer Popup
exports.getBrandParts = async (req, res) => {
  const db = await getDb();
  const { id } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = 50; // Show 50 parts per page
  const skip = (page - 1) * limit;

  const parts = await db.collection("parts")
    .find({ brand_id: new ObjectId(id) })
    .sort({ part_number_clean: 1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const total = await db.collection("parts").countDocuments({ brand_id: new ObjectId(id) });

  sendSuccess(res, { 
    parts, 
    total, 
    page, 
    totalPages: Math.ceil(total / limit) 
  });
};

// 💥 OPTIMIZED: Parse Uploaded Excel (Chunks to prevent 502 Crash)
exports.uploadPriceList = async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No Excel file uploaded" });
  
  try {
    const brand_id = req.body.brand_id;
    if (!brand_id) throw new Error("Brand ID is required");

    const db = await getDb();
    
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    let bulkOps = [];
    let validRows = 0;

    for (const row of data) {
      const partRaw = row["Part Number"] || row["Part No"] || row["Part #"] || row["part_number"];
      const mrpRaw = row["MRP"] || row["RTLP"] || row["Price"];
      const descRaw = row["Description"] || row["Desc"] || "";

      if (!partRaw || mrpRaw === undefined) continue;

      const cleanPart = String(partRaw).replace(/\s+/g, "").toUpperCase();
      const mrp = parseFloat(mrpRaw);

      if (isNaN(mrp)) continue;

      bulkOps.push({
        updateOne: {
          filter: { brand_id: new ObjectId(brand_id), part_number_clean: cleanPart },
          update: {
            $set: {
              part_number_original: String(partRaw),
              description: String(descRaw),
              mrp: mrp,
              updated_at: new Date()
            }
          },
          upsert: true
        }
      });
      validRows++;

      // 💥 THE FIX: If we hit 1,000 operations, execute them and clear the array.
      // This prevents memory spikes and 502 Gateway Timeouts.
      if (bulkOps.length >= 1000) {
        await db.collection("parts").bulkWrite(bulkOps, { ordered: false });
        bulkOps = []; 
      }
    }

    // Process any remaining operations
    if (bulkOps.length > 0) {
      await db.collection("parts").bulkWrite(bulkOps, { ordered: false });
    }

    const totalParts = await db.collection("parts").countDocuments({ brand_id: new ObjectId(brand_id) });
    const updatedBrand = await db.collection("brands").findOneAndUpdate(
      { _id: new ObjectId(brand_id) },
      { $set: { total_parts: totalParts } },
      { returnDocument: "after" }
    );

    fs.unlinkSync(req.file.path);

    sendSuccess(res, { 
      message: `Successfully mapped ${validRows} parts!`,
      brand: { ...updatedBrand, id: updatedBrand._id.toString() }
    });

  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ... (Keep your downloadPriceList function exactly as it is)

// 💥 NEW: Apply Formula and Generate Excel for Download
exports.downloadPriceList = async (req, res) => {
  try {
    const { brand_id, buyer_name, discount_percent, currency, exchange_rate } = req.body;
    const db = await getDb();

    const brand = await db.collection("brands").findOne({ _id: new ObjectId(brand_id) });
    if (!brand) throw new Error("Brand not found");

    const parts = await db.collection("parts").find({ brand_id: new ObjectId(brand_id) }).toArray();

    const discount = parseFloat(discount_percent) || 0;
    const rate = parseFloat(exchange_rate) || 1;

    // Construct the data array for the new Excel file
    const exportData = parts.map(p => {
      // SENIOR'S FORMULA: MRP / 1.18 * (1 - discount) / exchange_rate
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

    // Create a new Excel Workbook
    const ws = xlsx.utils.json_to_sheet(exportData);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Buyer Prices");

    // Write to buffer
    const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

    // Send the file to the frontend browser
    res.setHeader("Content-Disposition", `attachment; filename="Morsebiz_${buyer_name}_Prices.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buffer);

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};