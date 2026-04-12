const { v4: uuidv4 } = require("uuid");
const { getDb } = require("../config/db");

exports.list = async (req, res) => {
  try {
    const db = await getDb();
    const search = req.query.search || "";
    const inwardId = req.query.inward_id || "";

    const filter = {};
    if (inwardId) filter.inward_id = inwardId;
    if (search) {
      filter.$or = [
        { sku_code: { $regex: search, $options: "i" } },
        { brand: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { inventory_id: { $regex: search, $options: "i" } },
      ];
    }

    const inventory = await db.collection("wh_inventory").find(filter).sort({ last_updated_at: -1 }).limit(500).toArray();
    return res.json({ data: inventory, count: inventory.length });
  } catch (error) {
    console.error("Error fetching inventory:", error);
    return res.status(500).json({ error: error.message || "Failed to fetch inventory" });
  }
};

exports.update = async (req, res) => {
  try {
    const { inventoryId } = req.params;
    const body = req.body;
    const { userId = "warehouse_user" } = body;
    const db = await getDb();

    const item = await db.collection("wh_inventory").findOne({ inventory_id: inventoryId });
    if (!item) return res.status(404).json({ error: "Inventory item not found" });

    const now = new Date().toISOString();
    const update = {};
    if (Object.prototype.hasOwnProperty.call(body, "keep_aside_flag")) update.keep_aside_flag = !!body.keep_aside_flag;
    if (Object.prototype.hasOwnProperty.call(body, "damaged_flag")) update.damaged_flag = !!body.damaged_flag;
    if (Object.prototype.hasOwnProperty.call(body, "comments")) update.comments = body.comments || null;

    if (Object.keys(update).length === 0) return res.status(400).json({ error: "No editable fields provided" });

    update.last_updated_at = now;
    update.last_updated_by = userId;

    await db.collection("wh_inventory").updateOne({ inventory_id: inventoryId }, { $set: update });
    const updated = await db.collection("wh_inventory").findOne({ inventory_id: inventoryId });
    return res.json({ success: true, data: updated });
  } catch (error) {
    console.error("Error updating inventory item:", error);
    return res.status(500).json({ error: error.message, success: false });
  }
};

exports.directAdd = async (req, res) => {
  try {
    const body = req.body;
    const {
      sku_code, qty_per_box, no_of_boxes, label_img_url,
      brand = null, damaged_flag = false, damage_img_url = null,
      keep_aside_flag = false, comments = null, userId = "warehouse_user",
    } = body;

    if (!sku_code || !String(sku_code).trim()) return res.status(400).json({ error: "sku_code is required" });
    if (!qty_per_box || Number(qty_per_box) <= 0) return res.status(400).json({ error: "qty_per_box must be > 0" });
    if (!no_of_boxes || Number(no_of_boxes) <= 0) return res.status(400).json({ error: "no_of_boxes must be > 0" });
    if (!label_img_url) return res.status(400).json({ error: "label_img_url is required" });
    if (damaged_flag && !damage_img_url) return res.status(400).json({ error: "damage_img_url is required when damaged_flag is true" });
    if (comments && String(comments).length > 50) return res.status(400).json({ error: "comments must be 50 characters or fewer" });

    const db = await getDb();
    const now = new Date().toISOString();
    const inventoryDocs = [];
    for (let i = 0; i < Number(no_of_boxes); i++) {
      inventoryDocs.push({
        inventory_id: uuidv4(), box_id: uuidv4(), box_number: i + 1,
        inward_details_id: null, inward_id: null, source: "direct",
        brand: brand || null, sku_code: String(sku_code).trim(),
        qty_per_box: Number(qty_per_box), label_img_url,
        unknown_sku_flag: false, keep_aside_flag: !!keep_aside_flag || !!damaged_flag,
        damaged_flag: !!damaged_flag,
        damage_img_url: damaged_flag ? damage_img_url || null : null,
        comments: comments || null, last_updated_at: now, last_updated_by: userId,
      });
    }

    await db.collection("wh_inventory").insertMany(inventoryDocs);
    return res.status(201).json({
      success: true, message: `${inventoryDocs.length} inventory item(s) added directly.`,
      count: inventoryDocs.length, data: inventoryDocs,
    });
  } catch (error) {
    console.error("Error adding direct inventory:", error);
    return res.status(500).json({ error: error.message, success: false });
  }
};

exports.bulkBlock = (_req, res) => {
  return res.status(403).json({ error: "Direct inventory mutations are blocked. Use inward completion flow." });
};
