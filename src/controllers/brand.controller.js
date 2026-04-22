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
  const db = await getDb(); 
  const { id } = req.params;
  const { name, vendor_notes } = req.body;
  await db.collection("brands").updateOne(
    { _id: new ObjectId(id) },
    { $set: { name: name.trim(), vendor_notes: vendor_notes ? vendor_notes.trim() : null, updated_at: new Date() } }
  );
  sendSuccess(res, { id, name, vendor_notes });
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