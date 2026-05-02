const { getDb } = require("../config/db");
const { sendSuccess } = require("../utils/response");
const { ObjectId } = require("mongodb");

exports.getBrands = async (req, res) => {
  const db = await getDb(); 
  const brands = await db.collection("brands").find().sort({ name: 1 }).toArray();
  const formattedBrands = brands.map(b => ({ ...b, id: b._id.toString() }));
  sendSuccess(res, formattedBrands);
};

exports.createBrand = async (req, res) => {
  const db = await getDb(); 
  const { name, vendor_notes, discounts } = req.body;
  const newBrand = {
    name: name.trim(),
    vendor_notes: vendor_notes ? vendor_notes.trim() : null,
    discounts: Array.isArray(discounts) ? discounts : [], // 💥 NEW: Store discounts
    total_parts: 0,
    created_at: new Date()
  };
  const result = await db.collection("brands").insertOne(newBrand);
  sendSuccess(res, { ...newBrand, id: result.insertedId.toString() });
};

exports.updateBrand = async (req, res) => {
  const db = await getDb(); 
  const { id } = req.params;
  const { name, vendor_notes, discounts } = req.body;
  
  const updateData = { updated_at: new Date() };
  if (name) updateData.name = name.trim();
  if (vendor_notes !== undefined) updateData.vendor_notes = vendor_notes ? vendor_notes.trim() : null;
  if (discounts !== undefined) updateData.discounts = Array.isArray(discounts) ? discounts : []; // 💥 NEW: Update discounts

  await db.collection("brands").updateOne(
    { _id: new ObjectId(id) },
    { $set: updateData }
  );
  sendSuccess(res, { id, name, vendor_notes, discounts: updateData.discounts });
};

exports.uploadLogo = async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No image file uploaded" });
  const db = await getDb();
  const { id } = req.params;
  const logo_url = `/api/uploads/brands/${req.file.filename}`;
  await db.collection("brands").updateOne(
    { _id: new ObjectId(id) },
    { $set: { logo_url: logo_url, updated_at: new Date() } }
  );
  sendSuccess(res, { id, logo_url });
};