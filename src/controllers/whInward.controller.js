const { v4: uuidv4 } = require("uuid");
const XLSX = require("xlsx");
const { getDb, getClient } = require("../config/db");

exports.list = async (_req, res) => {
  try {
    const db = await getDb();
    const inwards = await db.collection("wh_inwards").find().sort({ inward_date: -1 }).toArray();
    return res.json({ success: true, data: inwards });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    const body = req.body;
    const { vendor_name = null, invoice_set = [], po_references = [], created_by = "warehouse_user" } = body;
    const db = await getDb();

    const inward = {
      inward_id: uuidv4(), inward_date: new Date().toISOString(),
      vendor_name, invoice_set, po_references, allowed_skus: [],
      status: "In progress", is_locked: false, has_completed: false,
      comments: null, last_edited_at: new Date().toISOString(),
      last_edited_by: created_by, last_updated_at: new Date().toISOString(),
      last_updated_by: created_by,
    };

    await db.collection("wh_inwards").insertOne(inward);
    return res.status(201).json({ success: true, data: inward });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const db = await getDb();
    const inward = await db.collection("wh_inwards").findOne({ inward_id: req.params.inwardId });
    if (!inward) return res.status(404).json({ error: "Not found" });
    return res.json({ success: true, data: inward });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const body = req.body;
    const db = await getDb();
    const { inwardId } = req.params;

    const inward = await db.collection("wh_inwards").findOne({ inward_id: inwardId });
    if (!inward) return res.status(404).json({ error: "Not found" });

    const canEdit = (inward.status === "In progress" && !inward.has_completed) || inward.status === "Reopened";
    if (!canEdit || inward.is_locked || inward.status === "Completed") {
      return res.status(400).json({ error: "Inward is locked and cannot be edited" });
    }

    if (Object.prototype.hasOwnProperty.call(body, "status") || Object.prototype.hasOwnProperty.call(body, "is_locked")) {
      return res.status(400).json({ error: "Status/lock changes are not allowed here" });
    }

    const update = {
      ...body,
      last_edited_at: new Date().toISOString(),
      last_edited_by: body.last_edited_by || "warehouse_user",
      last_updated_at: new Date().toISOString(),
      last_updated_by: body.last_edited_by || "warehouse_user",
    };
    await db.collection("wh_inwards").updateOne({ inward_id: inwardId }, { $set: update });
    const updated = await db.collection("wh_inwards").findOne({ inward_id: inwardId });
    return res.json({ success: true, data: updated });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.complete = async (req, res) => {
  const { inwardId } = req.params;
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const db = await getDb();
    const client = await getClient();

    const inward = await db.collection("wh_inwards").findOne({ inward_id: inwardId });
    if (!inward) return res.status(404).json({ error: "Inward not found" });

    const isFirstComplete = inward.status === "In progress" && !inward.has_completed;
    const isRecomplete = inward.status === "Reopened" && inward.has_completed;
    if (!isFirstComplete && !isRecomplete) {
      return res.status(400).json({ error: "Inward must be 'In progress' (first completion) or 'Reopened' (re-complete)" });
    }

    const inwardDetails = await db.collection("wh_inward_details").find({ inward_id: inwardId }).toArray();

    const now = new Date().toISOString();
    const inventoryInserts = [];
    const inventoryUpdateOps = [];
    const inventoryDeleteIds = [];
    const bulkDetailsOps = [];

    for (const detail of inwardDetails) {
      const currentBoxes = detail.boxes || [];
      const oldSnapshot = detail.completed_snapshot || {};
      const oldBoxes = oldSnapshot.boxes || [];

      if (currentBoxes.length === 0 && oldBoxes.length === 0) {
        bulkDetailsOps.push({
          updateOne: {
            filter: { inward_details_id: detail.inward_details_id },
            update: {
              $set: {
                is_locked: true, inventory_ids: [],
                completed_snapshot: {
                  sku_code: detail.sku_code, qty_per_box: detail.qty_per_box,
                  label_img_url: detail.label_img_url || null,
                  unknown_sku_flag: detail.unknown_sku_flag || false,
                  keep_aside_flag: detail.keep_aside_flag || false,
                  brand: detail.brand || null, boxes: [],
                },
                last_updated_at: now, last_updated_by: userId,
              },
            },
          },
        });
        continue;
      }

      const updatedBoxes = [];

      if (isRecomplete && oldBoxes.length > 0) {
        for (const oldBox of oldBoxes) {
          if (oldBox.inventory_id && !currentBoxes.some((cb) => cb.box_id === oldBox.box_id)) {
            inventoryDeleteIds.push(oldBox.inventory_id);
          }
        }
      }

      if (isFirstComplete || oldBoxes.length === 0) {
        for (const box of currentBoxes) {
          const existingOldBox = oldBoxes.find((ob) => ob.box_id === box.box_id);
          let inventoryId;

          if (existingOldBox && existingOldBox.inventory_id) {
            inventoryId = existingOldBox.inventory_id;
            inventoryUpdateOps.push({
              updateOne: {
                filter: { inventory_id: inventoryId },
                update: {
                  $set: {
                    box_id: box.box_id, box_number: box.box_number,
                    sku_code: detail.sku_code, qty_per_box: detail.qty_per_box,
                    label_img_url: detail.label_img_url || null,
                    unknown_sku_flag: detail.unknown_sku_flag || false,
                    keep_aside_flag: detail.keep_aside_flag || false,
                    brand: detail.brand || null,
                    damaged_flag: box.damaged_flag || false,
                    damage_img_url: box.damage_img_url || null,
                    comments: box.comments || null,
                    last_updated_at: now, last_updated_by: userId,
                  },
                },
              },
            });
          } else {
            inventoryId = uuidv4();
            inventoryInserts.push({
              inventory_id: inventoryId, box_id: box.box_id, box_number: box.box_number,
              inward_details_id: detail.inward_details_id, inward_id: inwardId,
              brand: detail.brand || null, sku_code: detail.sku_code,
              qty_per_box: detail.qty_per_box, label_img_url: detail.label_img_url || null,
              unknown_sku_flag: detail.unknown_sku_flag || false,
              keep_aside_flag: detail.keep_aside_flag || false,
              damaged_flag: box.damaged_flag || false,
              damage_img_url: box.damage_img_url || null,
              comments: box.comments || null,
              last_updated_at: now, last_updated_by: userId,
            });
          }
          updatedBoxes.push({ ...box, inventory_id: inventoryId });
        }

        bulkDetailsOps.push({
          updateOne: {
            filter: { inward_details_id: detail.inward_details_id },
            update: {
              $set: {
                boxes: updatedBoxes,
                inventory_ids: updatedBoxes.map((b) => b.inventory_id),
                is_locked: true,
                completed_snapshot: {
                  sku_code: detail.sku_code, qty_per_box: detail.qty_per_box,
                  label_img_url: detail.label_img_url || null,
                  unknown_sku_flag: detail.unknown_sku_flag || false,
                  keep_aside_flag: detail.keep_aside_flag || false,
                  brand: detail.brand || null,
                  boxes: updatedBoxes.map((b) => ({
                    box_id: b.box_id, box_number: b.box_number,
                    damaged_flag: b.damaged_flag || false,
                    damage_img_url: b.damage_img_url || null,
                    comments: b.comments || "",
                    inventory_id: b.inventory_id,
                  })),
                },
                last_updated_at: now, last_updated_by: userId,
              },
            },
          },
        });
      } else if (isRecomplete) {
        const oldBoxMap = new Map(oldBoxes.map((b) => [b.box_id, b]));
        const currentBoxMap = new Map(currentBoxes.map((b) => [b.box_id, b]));

        for (const oldBox of oldBoxes) {
          if (!currentBoxMap.has(oldBox.box_id) && oldBox.inventory_id) {
            inventoryDeleteIds.push(oldBox.inventory_id);
          }
        }

        for (const box of currentBoxes) {
          const oldBox = oldBoxMap.get(box.box_id);

          if (oldBox && oldBox.inventory_id) {
            const inventoryId = oldBox.inventory_id;
            updatedBoxes.push({ ...box, inventory_id: inventoryId });

            const productChanged =
              oldSnapshot.sku_code !== detail.sku_code ||
              oldSnapshot.qty_per_box !== detail.qty_per_box ||
              oldSnapshot.label_img_url !== (detail.label_img_url || null) ||
              oldSnapshot.unknown_sku_flag !== (detail.unknown_sku_flag || false) ||
              oldSnapshot.keep_aside_flag !== (detail.keep_aside_flag || false) ||
              oldSnapshot.brand !== (detail.brand || null);

            const boxChanged =
              oldBox.damaged_flag !== (box.damaged_flag || false) ||
              oldBox.damage_img_url !== (box.damage_img_url || null) ||
              oldBox.comments !== (box.comments || "") ||
              oldBox.box_number !== box.box_number;

            if (productChanged || boxChanged) {
              inventoryUpdateOps.push({
                updateOne: {
                  filter: { inventory_id: inventoryId },
                  update: {
                    $set: {
                      box_id: box.box_id, box_number: box.box_number,
                      sku_code: detail.sku_code, qty_per_box: detail.qty_per_box,
                      label_img_url: detail.label_img_url || null,
                      unknown_sku_flag: detail.unknown_sku_flag || false,
                      keep_aside_flag: detail.keep_aside_flag || false,
                      brand: detail.brand || null,
                      damaged_flag: box.damaged_flag || false,
                      damage_img_url: box.damage_img_url || null,
                      comments: box.comments || null,
                      last_updated_at: now, last_updated_by: userId,
                    },
                  },
                },
              });
            }
          } else {
            const inventoryId = uuidv4();
            updatedBoxes.push({ ...box, inventory_id: inventoryId });
            inventoryInserts.push({
              inventory_id: inventoryId, box_id: box.box_id, box_number: box.box_number,
              inward_details_id: detail.inward_details_id, inward_id: inwardId,
              brand: detail.brand || null, sku_code: detail.sku_code,
              qty_per_box: detail.qty_per_box, label_img_url: detail.label_img_url || null,
              unknown_sku_flag: detail.unknown_sku_flag || false,
              keep_aside_flag: detail.keep_aside_flag || false,
              damaged_flag: box.damaged_flag || false,
              damage_img_url: box.damage_img_url || null,
              comments: box.comments || null,
              last_updated_at: now, last_updated_by: userId,
            });
          }
        }

        if (currentBoxes.length === 0 && oldBoxes.length > 0) {
          for (const oldBox of oldBoxes) {
            if (oldBox.inventory_id) inventoryDeleteIds.push(oldBox.inventory_id);
          }
        }

        bulkDetailsOps.push({
          updateOne: {
            filter: { inward_details_id: detail.inward_details_id },
            update: {
              $set: {
                boxes: updatedBoxes,
                inventory_ids: updatedBoxes.filter((b) => b.inventory_id).map((b) => b.inventory_id),
                is_locked: true,
                completed_snapshot: {
                  sku_code: detail.sku_code, qty_per_box: detail.qty_per_box,
                  label_img_url: detail.label_img_url || null,
                  unknown_sku_flag: detail.unknown_sku_flag || false,
                  keep_aside_flag: detail.keep_aside_flag || false,
                  brand: detail.brand || null,
                  boxes: updatedBoxes.map((b) => ({
                    box_id: b.box_id, box_number: b.box_number,
                    damaged_flag: b.damaged_flag || false,
                    damage_img_url: b.damage_img_url || null,
                    comments: b.comments || "",
                    inventory_id: b.inventory_id,
                  })),
                },
                last_updated_at: now, last_updated_by: userId,
              },
            },
          },
        });
      }
    }

    // Execute writes (transaction with fallback)
    let session;
    let insertedCount = 0;

    const performWrites = async (opts = {}) => {
      if (inventoryInserts.length > 0) {
        const r = await db.collection("wh_inventory").insertMany(inventoryInserts, opts);
        insertedCount += r.insertedCount || inventoryInserts.length;
      }
      if (inventoryUpdateOps.length > 0) {
        await db.collection("wh_inventory").bulkWrite(inventoryUpdateOps, opts);
      }
      if (inventoryDeleteIds.length > 0) {
        await db.collection("wh_inventory").deleteMany({ inventory_id: { $in: inventoryDeleteIds } }, opts);
      }
      if (bulkDetailsOps.length > 0) {
        await db.collection("wh_inward_details").bulkWrite(bulkDetailsOps, opts);
      }
      await db.collection("wh_inwards").updateOne(
        { inward_id: inwardId },
        {
          $set: {
            status: "Completed", is_locked: true, has_completed: true,
            last_edited_at: now, last_edited_by: userId,
            last_updated_at: now, last_updated_by: userId,
          },
        },
        opts
      );
    };

    try {
      session = client.startSession();
      try {
        await session.withTransaction(async () => { await performWrites({ session }); });
      } catch (err) {
        const msg = String(err && err.message).toLowerCase();
        const illegalOp = err && (err.codeName === "IllegalOperation" || msg.includes("transaction numbers are only allowed"));
        if (illegalOp) {
          console.warn("Transactions not supported. Falling back to non-transactional writes.");
          await performWrites();
        } else {
          throw err;
        }
      }
    } finally {
      if (session) await session.endSession();
    }

    return res.json({
      success: true, message: "Inward completed. Inventory synchronized.",
      inwardId, inventoryInserted: insertedCount,
      inventoryUpdated: inventoryUpdateOps.length,
      inventoryDeleted: inventoryDeleteIds.length, completedAt: now,
    });
  } catch (error) {
    console.error("Error completing inward:", error);
    return res.status(500).json({ error: error.message, success: false });
  }
};

exports.reopen = async (req, res) => {
  try {
    const { inwardId } = req.params;
    const { userId = "warehouse_user" } = req.body;
    const db = await getDb();

    const inward = await db.collection("wh_inwards").findOne({ inward_id: inwardId });
    if (!inward) return res.status(404).json({ error: "Inward not found" });

    if (inward.status !== "Completed" || !inward.has_completed) {
      return res.status(400).json({ error: "Only completed inwards can be reopened" });
    }

    const now = new Date().toISOString();
    await db.collection("wh_inwards").updateOne(
      { inward_id: inwardId },
      { $set: { status: "Reopened", is_locked: false, last_edited_at: now, last_edited_by: userId, last_updated_at: now, last_updated_by: userId } }
    );
    await db.collection("wh_inward_details").updateMany(
      { inward_id: inwardId },
      { $set: { is_locked: false, last_updated_at: now, last_updated_by: userId } }
    );

    const updated = await db.collection("wh_inwards").findOne({ inward_id: inwardId });
    return res.json({ success: true, data: updated });
  } catch (error) {
    console.error("Error reopening inward:", error);
    return res.status(500).json({ error: error.message, success: false });
  }
};

exports.uploadInvoices = async (req, res) => {
  try {
    const { inwardId } = req.params;
    const db = await getDb();

    const inward = await db.collection("wh_inwards").findOne({ inward_id: inwardId });
    if (!inward) return res.status(404).json({ error: "Inward not found" });

    const files = req.files;
    if (!files || files.length === 0) return res.status(400).json({ error: "No files provided" });

    const allSkus = new Set();
    const processedFiles = [];

    for (const file of files) {
      const workbook = XLSX.read(file.buffer, { type: "buffer" });
      let fileSkuCount = 0;
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet);
        for (const row of rows) {
          const descKey = Object.keys(row).find((k) => k.toLowerCase().trim() === "description");
          const description = descKey ? row[descKey] : null;
          if (description && typeof description === "string") {
            const tokens = description.trim().split(/\s+/);
            if (tokens.length >= 2) { allSkus.add(tokens[1].toUpperCase()); fileSkuCount++; }
          }
        }
      }
      processedFiles.push({ name: file.originalname || "unknown", size: file.size || 0, skusFound: fileSkuCount });
    }

    if (allSkus.size === 0) {
      return res.status(400).json({ error: "No SKUs could be extracted. Ensure files have a 'description' column with format: BRAND SKU_CODE FREE_TEXT" });
    }

    const allowed_skus = [...allSkus].sort();
    await db.collection("wh_inwards").updateOne(
      { inward_id: inwardId },
      { $set: { allowed_skus, last_updated_at: new Date().toISOString() } }
    );

    return res.json({ success: true, allowed_skus, count: allowed_skus.length, processedFiles });
  } catch (error) {
    console.error("Error processing invoices:", error);
    return res.status(500).json({ error: error.message, success: false });
  }
};

exports.getDetails = async (req, res) => {
  try {
    const db = await getDb();
    const details = await db.collection("wh_inward_details").find({ inward_id: req.params.inwardId }).toArray();
    return res.json({ success: true, data: details });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

exports.addDetail = async (req, res) => {
  try {
    const { inwardId } = req.params;
    const body = req.body;
    const { userId = "warehouse_user" } = body;
    const db = await getDb();

    const inward = await db.collection("wh_inwards").findOne({ inward_id: inwardId });
    if (!inward) return res.status(404).json({ error: "Inward not found" });

    const canEdit = (inward.status === "In progress" && !inward.has_completed) || inward.status === "Reopened";
    if (!canEdit || inward.is_locked) {
      return res.status(400).json({ error: "Cannot add details to a completed/locked inward" });
    }

    // New format: single detail with boxes array
    if (body.detail) {
      const d = body.detail;
      if (!d.sku_code) return res.status(400).json({ error: "sku_code is required" });
      if (!d.qty_per_box || Number(d.qty_per_box) <= 0) return res.status(400).json({ error: "qty_per_box must be > 0" });

      const existing = await db.collection("wh_inward_details").findOne({
        inward_id: inwardId,
        sku_code: { $regex: new RegExp(`^${d.sku_code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
        qty_per_box: Number(d.qty_per_box),
      });

      if (existing) {
        return res.status(409).json({ error: "SKU × qty combination already exists. Use PATCH to add boxes.", existingDetailId: existing.inward_details_id });
      }

      if (!d.label_img_url) {
        return res.status(400).json({ error: "label_img_url is required for new SKU × qty combination" });
      }

      const boxes = (d.boxes || []).map((b, i) => ({
        box_id: b.box_id || uuidv4(), box_number: i + 1,
        damaged_flag: !!b.damaged_flag, damage_img_url: b.damage_img_url || null,
        comments: b.comments || "",
      }));

      const newDetail = {
        inward_details_id: uuidv4(), inward_id: inwardId,
        brand: d.brand || null, sku_code: d.sku_code,
        qty_per_box: Number(d.qty_per_box), no_of_boxes: boxes.length,
        label_img_url: d.label_img_url || null,
        unknown_sku_flag: !!d.unknown_sku_flag,
        keep_aside_flag: !!d.keep_aside_flag, boxes,
        inventory_ids: [], is_locked: false,
        last_updated_at: new Date().toISOString(), last_updated_by: userId,
      };

      await db.collection("wh_inward_details").insertOne(newDetail);
      return res.status(201).json({ success: true, data: newDetail });
    }

    // Legacy format: array of detail rows
    if (body.details && Array.isArray(body.details)) {
      const existing = await db.collection("wh_inward_details").find({ inward_id: inwardId }).toArray();
      const toInsert = body.details.map((d) => {
        const comboExists = existing.some(
          (e) => String(e.sku_code).toLowerCase() === String(d.sku_code).toLowerCase() && Number(e.qty_per_box) === Number(d.qty_per_box)
        );
        if (!comboExists && !d.label_img_url) {
          throw new Error("label_img_url required for new sku_code + qty_per_box combination");
        }
        return {
          inward_details_id: d.inward_details_id || uuidv4(), inward_id: inwardId,
          brand: d.brand || null, sku_code: d.sku_code,
          qty_per_box: d.qty_per_box, no_of_boxes: d.no_of_boxes || 1,
          label_img_url: d.label_img_url || null,
          unknown_sku_flag: !!d.unknown_sku_flag,
          keep_aside_flag: !!d.keep_aside_flag,
          damaged_flag: !!d.damaged_flag,
          damage_img_url: d.damage_img_url || null,
          boxes: d.boxes || [], inventory_ids: d.inventory_ids || [],
          comments: d.comments || null, is_locked: false,
          last_updated_at: new Date().toISOString(), last_updated_by: userId,
        };
      });

      const r = await db.collection("wh_inward_details").insertMany(toInsert);
      return res.json({ success: true, insertedCount: r.insertedCount });
    }

    return res.status(400).json({ error: "detail or details is required" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

exports.bulkDetailBlock = (_req, res) => {
  return res.status(403).json({ error: "Bulk inward_details mutations are blocked. Use completion flow." });
};

exports.updateDetail = async (req, res) => {
  try {
    const { inwardId, detailId } = req.params;
    const body = req.body;
    const { userId = "warehouse_user" } = body;
    const db = await getDb();

    const inward = await db.collection("wh_inwards").findOne({ inward_id: inwardId });
    if (!inward) return res.status(404).json({ error: "Inward not found" });

    const canEdit = (inward.status === "In progress" && !inward.has_completed) || inward.status === "Reopened";
    if (!canEdit || inward.is_locked) {
      return res.status(400).json({ error: "Inward is locked and cannot be edited" });
    }

    const detail = await db.collection("wh_inward_details").findOne({ inward_details_id: detailId, inward_id: inwardId });
    if (!detail) return res.status(404).json({ error: "Inward detail not found" });
    if (detail.is_locked) return res.status(400).json({ error: "Inward detail is locked and cannot be edited" });

    const now = new Date().toISOString();

    // Operation: Add boxes
    if (body.add_boxes && Array.isArray(body.add_boxes)) {
      const existingBoxes = detail.boxes || [];
      const startNumber = existingBoxes.length + 1;
      const newBoxes = body.add_boxes.map((b, i) => ({
        box_id: b.box_id || uuidv4(), box_number: startNumber + i,
        damaged_flag: !!b.damaged_flag, damage_img_url: b.damage_img_url || null,
        comments: b.comments || "",
      }));

      await db.collection("wh_inward_details").updateOne(
        { inward_details_id: detailId },
        { $push: { boxes: { $each: newBoxes } }, $inc: { no_of_boxes: newBoxes.length }, $set: { last_updated_at: now, last_updated_by: userId } }
      );

      const updated = await db.collection("wh_inward_details").findOne({ inward_details_id: detailId });
      return res.json({ success: true, data: updated });
    }

    // Operation: Update a specific box
    if (body.update_box) {
      const { box_id, ...boxFields } = body.update_box;
      if (!box_id) return res.status(400).json({ error: "box_id is required" });

      const setObj = {};
      if (boxFields.damaged_flag !== undefined) setObj["boxes.$[box].damaged_flag"] = !!boxFields.damaged_flag;
      if (boxFields.damage_img_url !== undefined) setObj["boxes.$[box].damage_img_url"] = boxFields.damage_img_url;
      if (boxFields.comments !== undefined) setObj["boxes.$[box].comments"] = boxFields.comments;
      setObj.last_updated_at = now;
      setObj.last_updated_by = userId;

      await db.collection("wh_inward_details").updateOne(
        { inward_details_id: detailId },
        { $set: setObj },
        { arrayFilters: [{ "box.box_id": box_id }] }
      );

      const afterUpdate = await db.collection("wh_inward_details").findOne({ inward_details_id: detailId });
      const anyDamaged = (afterUpdate.boxes || []).some((b) => b.damaged_flag);
      if (anyDamaged || afterUpdate.unknown_sku_flag) {
        await db.collection("wh_inward_details").updateOne({ inward_details_id: detailId }, { $set: { keep_aside_flag: true } });
      }

      const updated = await db.collection("wh_inward_details").findOne({ inward_details_id: detailId });
      return res.json({ success: true, data: updated });
    }

    // Operation: Remove a specific box
    if (body.remove_box) {
      const box_id = body.remove_box;
      await db.collection("wh_inward_details").updateOne(
        { inward_details_id: detailId },
        { $pull: { boxes: { box_id } }, $inc: { no_of_boxes: -1 }, $set: { last_updated_at: now, last_updated_by: userId } }
      );

      const afterRemove = await db.collection("wh_inward_details").findOne({ inward_details_id: detailId });
      if (afterRemove?.boxes) {
        const renumbered = afterRemove.boxes.map((b, i) => ({ ...b, box_number: i + 1 }));
        await db.collection("wh_inward_details").updateOne(
          { inward_details_id: detailId },
          { $set: { boxes: renumbered, no_of_boxes: renumbered.length } }
        );
      }

      const updated = await db.collection("wh_inward_details").findOne({ inward_details_id: detailId });
      return res.json({ success: true, data: updated });
    }

    // Product-level field updates
    const allowedFields = ["sku_code", "unknown_sku_flag", "qty_per_box", "label_img_url", "brand", "keep_aside_flag"];
    const update = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(body, key)) update[key] = body[key];
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "No editable fields or operation provided" });
    }

    update.last_updated_at = now;
    update.last_updated_by = userId;

    await db.collection("wh_inward_details").updateOne({ inward_details_id: detailId, inward_id: inwardId }, { $set: update });
    const updated = await db.collection("wh_inward_details").findOne({ inward_details_id: detailId, inward_id: inwardId });
    return res.json({ success: true, data: updated });
  } catch (error) {
    console.error("Error updating inward detail:", error);
    return res.status(500).json({ error: error.message, success: false });
  }
};
