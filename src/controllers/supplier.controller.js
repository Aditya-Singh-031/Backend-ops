const { getDb } = require("../config/db");
const { sendSuccess } = require("../utils/response");

exports.getSuppliers = async (req, res) => {
  try {
    const db = await getDb();
    const suppliers = await db.collection("suppliers").find().sort({ name: 1 }).toArray();
    
    // Ensure frontend gets clean ID strings
    const formattedSuppliers = suppliers.map(s => ({ ...s, id: s._id.toString() }));
    sendSuccess(res, formattedSuppliers);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.createSupplier = async (req, res) => {
  try {
    const db = await getDb();
    const payload = req.body || {};

    // 💥 BULLETPROOFING: Check every possible key the frontend might be sending
    const rawName = 
      payload.name || 
      payload.supplierName || 
      payload.supplier_name || 
      payload.SupplierName || 
      payload.vendor || 
      payload.vendor_name || 
      payload.vendorName;

    // If we STILL can't find the name, return exactly what we received so you can debug it
    if (!rawName) {
      return res.status(400).json({ 
        success: false, 
        error: `Missing supplier name. Received data: ${JSON.stringify(payload)}` 
      });
    }

    const newSupplier = {
      ...payload,
      name: String(rawName).trim(), // Standardize the name key for the DB
      created_at: new Date()
    };

    const result = await db.collection("suppliers").insertOne(newSupplier);
    
    sendSuccess(res, { 
      ...newSupplier, 
      id: result.insertedId.toString(),
      _id: result.insertedId.toString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};