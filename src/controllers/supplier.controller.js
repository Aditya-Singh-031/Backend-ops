const { getDb } = require("../config/db");
const { sendSuccess } = require("../utils/response");

exports.getSuppliers = async (req, res) => {
  try {
    const db = await getDb();
    // Fetch all suppliers and sort alphabetically by name
    const suppliers = await db.collection("suppliers").find().sort({ name: 1 }).toArray();
    
    // Ensure frontend gets a clean 'id' string along with the Mongo '_id'
    const formattedSuppliers = suppliers.map(s => ({ ...s, id: s._id.toString() }));
    
    sendSuccess(res, formattedSuppliers);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.createSupplier = async (req, res) => {
  try {
    const db = await getDb();
    const payload = req.body;

    // Handle different casing the frontend might send
    const supplierName = payload.name || payload.supplier_name || payload.supplierName;

    if (!supplierName) {
      return res.status(400).json({ success: false, error: "Supplier name is required" });
    }

    const newSupplier = {
      ...payload,
      name: supplierName.trim(), // Standardize the name field
      created_at: new Date()
    };

    const result = await db.collection("suppliers").insertOne(newSupplier);
    
    sendSuccess(res, { 
      ...newSupplier, 
      id: result.insertedId.toString(),
      _id: result.insertedId
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};