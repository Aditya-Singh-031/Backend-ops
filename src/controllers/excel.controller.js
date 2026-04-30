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

  // Added search capability for Step 3 later!
  const searchQuery = req.query.search || "";
  let query = { brand_id: new ObjectId(id) };
  
  if (searchQuery) {
    query.$or = [
      { part_number_clean: { $regex: searchQuery.replace(/\s+/g, "").toUpperCase() } },
      { part_number_original: { $regex: searchQuery, $options: "i" } },
      { description: { $regex: searchQuery, $options: "i" } }
    ];
  }

  const parts = await db.collection("parts")
    .find(query)
    .sort({ part_number_clean: 1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const total = await db.collection("parts").countDocuments(query);
  sendSuccess(res, { parts, total, page, totalPages: Math.ceil(total / limit) });
};

// 💥 UPGRADED: Streaming Upload with Price History, Vendor, and GST Logic
exports.uploadPriceListStream = async (req, res) => {
  try {
    const { brand_id, partsChunk, isFinal, vendor_name, gst_rate } = req.body;
    
    if (!brand_id || !Array.isArray(partsChunk)) {
      return res.status(400).json({ success: false, error: "Invalid payload stream" });
    }

    // GST Validation Logic
    let parsedGst = 0.18; // Default 18%
    if (gst_rate !== undefined && gst_rate !== "") {
      parsedGst = parseFloat(gst_rate);
      if (parsedGst >= 1 || parsedGst < 0) {
         return res.status(400).json({ success: false, error: "GST must be a decimal less than 1 (e.g., 0.18 for 18%)" });
      }
    }

    const db = await getDb();
    let bulkOps = [];
    let validRows = 0;

    // Fast lookup of existing parts in this chunk to track price history
    const cleanPartsList = partsChunk.map(r => {
      const p = r["Part Number"] || r["Part No"] || r["Part #"] || r["part_number"] || r["Part No."];
      return p ? String(p).replace(/\s+/g, "").toUpperCase() : null;
    }).filter(Boolean);

    const existingParts = await db.collection("parts").find({
      brand_id: new ObjectId(brand_id),
      part_number_clean: { $in: cleanPartsList }
    }).toArray();

    const existingMap = {};
    existingParts.forEach(p => existingMap[p.part_number_clean] = p);

    for (const row of partsChunk) {
      const partRaw = row["Part Number"] || row["Part No"] || row["Part #"] || row["part_number"] || row["Part No."];
      const mrpRaw = row["MRP"] || row["RTLP"] || row["Price"] || row["Base MRP"];
      const descRaw = row["Description"] || row["Desc"] || row["Part Name"] || "";
      
      // 💥 Look for GST in the Excel row. Fallback to the global parsedGst
      const rawRowGst = row["GST (%)"] ?? row["GST %"] ?? row["GST"];
      const finalGst = (rawRowGst !== undefined && rawRowGst !== "") 
        ? parseFloat(rawRowGst) / 100 
        : parsedGst;

      if (!partRaw || mrpRaw === undefined || mrpRaw === "") continue;

      const cleanPart = String(partRaw).replace(/\s+/g, "").toUpperCase();
      const mrp = parseFloat(String(mrpRaw).replace(/,/g, ""));
      if (isNaN(mrp)) continue;

      const existingPart = existingMap[cleanPart];
      let history = existingPart?.price_history || [];

      if (existingPart && existingPart.mrp !== mrp) {
        history.push({
          mrp: existingPart.mrp,
          vendor: existingPart.vendor_name || "Unknown",
          date: existingPart.updated_at || new Date()
        });
      }

      bulkOps.push({
        updateOne: {
          filter: { brand_id: new ObjectId(brand_id), part_number_clean: cleanPart },
          update: { 
            $set: { 
              part_number_original: String(partRaw), 
              description: String(descRaw), 
              mrp: mrp, 
              gst_rate: finalGst, // 💥 Assign the dynamically checked GST
              vendor_name: vendor_name || "Unknown Vendor",
              updated_at: new Date(),
              price_history: history
            } 
          },
          upsert: true
        }
      });
      validRows++;
    }

    if (bulkOps.length > 0) {
      await db.collection("parts").bulkWrite(bulkOps, { ordered: false });
    }

    let finalBrand = null;
    if (isFinal) {
       const totalParts = await db.collection("parts").countDocuments({ brand_id: new ObjectId(brand_id) });
       await db.collection("brands").updateOne({ _id: new ObjectId(brand_id) }, { $set: { total_parts: totalParts } });
       finalBrand = await db.collection("brands").findOne({ _id: new ObjectId(brand_id) });
    }

    sendSuccess(res, { mapped: validRows, brand: finalBrand ? { ...finalBrand, id: finalBrand._id.toString() } : null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// 💥 UPGRADED: Apply Dynamic GST, Remove MRP, and Log History
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
      const partGst = p.gst_rate !== undefined ? p.gst_rate : 0.18; // Use dynamic GST
      const baseNoGst = p.mrp / (1 + partGst); // Formula updated for variable GST
      const discounted = baseNoGst * (1 - (discount / 100));
      const finalPrice = discounted / rate;

      return {
        "Brand": brand.name,
        "Part Number": p.part_number_original,
        "Description": p.description,
        // Notice: "Base MRP" has been removed!
        [`Net Price (${currency})`]: parseFloat(finalPrice.toFixed(2))
      };
    });

    // 💥 Log this action to download history
    await db.collection("download_history").insertOne({
      brand_id: new ObjectId(brand_id),
      brand_name: brand.name,
      buyer_name: buyer_name,
      discount_percent: discount,
      currency: currency,
      exchange_rate: rate,
      total_items: parts.length,
      downloaded_at: new Date()
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

// 💥 NEW: Fetch Download History
exports.getDownloadHistory = async (req, res) => {
  try {
    const db = await getDb();
    const history = await db.collection("download_history").find().sort({ downloaded_at: -1 }).limit(50).toArray();
    sendSuccess(res, history);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};