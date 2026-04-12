const { v4: uuidv4 } = require("uuid");
const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");

exports.list = async (_req, res) => {
  const db = await getDb();
  const inwards = await db.collection("inwards").find().sort({ createdAt: -1 }).toArray();
  sendSuccess(res, inwards);
};

exports.create = async (req, res) => {
  const db = await getDb();
  const inward = {
    inward_id: uuidv4(),
    created_by: req.body.created_by || "system",
    inward_date: new Date(),
    status: "In progress",
    is_locked: false,
    has_completed: false,
    vendor_name: req.body.vendor_name || null,
    invoice_ids: [],
    allowed_skus: [],
    expected_skus: [],
    last_edited_at: new Date(),
    last_edited_by: req.body.created_by || "system",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.collection("inwards").insertOne(inward);
  sendSuccess(res, inward, 201);
};

exports.selectInvoices = async (req, res) => {
  const { invoice_ids } = req.body;
  const inwardId = req.params.id;
  const db = await getDb();

  const objectIds = invoice_ids.map((id) => {
    try { return toObjectId(id); } catch { return id; }
  });
  const invoices = await db.collection("invoices").find({ _id: { $in: objectIds } }).toArray();
  const actualInvoiceUUIDs = invoices.map((inv) => inv.invoice_id).filter(Boolean);

  const lineItems = await db.collection("invoice_line_items").find({ invoice_id: { $in: actualInvoiceUUIDs } }).toArray();

  const skuMap = {};
  lineItems.forEach((item) => {
    const sku = item.part_number || item.item_no || item.sku_code;
    if (sku) {
      const qty = Number(item.quantity) || 1;
      skuMap[sku] = (skuMap[sku] || 0) + qty;
    }
  });

  const expected_skus = Object.keys(skuMap).map((sku) => ({ sku, expected_qty: skuMap[sku] }));
  const allowed_skus = Object.keys(skuMap);

  await db.collection("inwards").updateOne(
    { inward_id: inwardId },
    { $set: { invoice_ids, allowed_skus, expected_skus, last_edited_at: new Date(), updatedAt: new Date() } }
  );

  const updatedInward = await db.collection("inwards").findOne({ inward_id: inwardId });
  sendSuccess(res, { allowed_skus: updatedInward.allowed_skus, expected_skus: updatedInward.expected_skus, data: updatedInward });
};

exports.receive = async (req, res) => {
  const inwardId = req.params.id;
  const { receive_boxes, receive_images } = req.body;
  const db = await getDb();

  await db.collection("inwards").updateOne(
    { inward_id: inwardId },
    { $set: { status: "Received", receive_boxes, receive_images, last_edited_at: new Date(), updatedAt: new Date() } }
  );

  const updated = await db.collection("inwards").findOne({ inward_id: inwardId });
  sendSuccess(res, updated);
};

exports.exceptions = async (req, res) => {
  const inwardId = req.params.id;
  const { exceptions } = req.body;
  const db = await getDb();

  await db.collection("inwards").updateOne(
    { inward_id: inwardId },
    { $set: { exceptions, last_edited_at: new Date(), updatedAt: new Date() } }
  );

  const updated = await db.collection("inwards").findOne({ inward_id: inwardId });
  sendSuccess(res, updated);
};

exports.verify = async (req, res) => {
  const inwardId = req.params.id;
  const db = await getDb();

  await db.collection("inwards").updateOne(
    { inward_id: inwardId },
    { $set: { status: "Verified", last_edited_at: new Date(), updatedAt: new Date() } }
  );

  const updated = await db.collection("inwards").findOne({ inward_id: inwardId });
  sendSuccess(res, updated);
};

exports.pack = async (req, res) => {
  const inwardId = req.params.id;
  const { packing_list } = req.body;
  const db = await getDb();

  await db.collection("inwards").updateOne(
    { inward_id: inwardId },
    { $set: { packing_list, status: "Packed", last_edited_at: new Date(), updatedAt: new Date() } }
  );

  const updated = await db.collection("inwards").findOne({ inward_id: inwardId });
  sendSuccess(res, updated);
};

exports.complete = async (req, res) => {
  const inwardId = req.params.id;
  const db = await getDb();

  await db.collection("inwards").updateOne(
    { inward_id: inwardId },
    { $set: { status: "Completed", is_locked: true, has_completed: true, last_edited_at: new Date(), updatedAt: new Date() } }
  );

  const updated = await db.collection("inwards").findOne({ inward_id: inwardId });
  sendSuccess(res, updated);
};

exports.addDetail = async (req, res) => {
  const { detail } = req.body;
  const inwardId = req.params.id;
  const db = await getDb();

  const newDetail = {
    ...detail,
    inward_id: inwardId,
    inward_details_id: uuidv4(),
    boxes: detail.boxes || [],
    no_of_boxes: (detail.boxes || []).length,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.collection("inwarddetails").insertOne(newDetail);
  await db.collection("inwards").updateOne(
    { inward_id: inwardId },
    { $set: { last_edited_at: new Date(), updatedAt: new Date() } }
  );

  sendSuccess(res, newDetail, 201);
};

exports.updateDetail = async (req, res) => {
  const { id, detailId } = req.params;
  const body = req.body;
  const db = await getDb();

  const detail = await db.collection("inwarddetails").findOne({ inward_details_id: detailId, inward_id: id });
  if (!detail) return sendError(res, "Inward detail not found", 404);

  const update = {};

  if (body.add_boxes) {
    const currentBoxes = detail.boxes || [];
    const allBoxes = [...currentBoxes, ...body.add_boxes];
    update.boxes = allBoxes;
    update.no_of_boxes = allBoxes.length;
  } else if (body.remove_box) {
    const filtered = (detail.boxes || []).filter((box) => box.box_id !== body.remove_box);
    update.boxes = filtered;
    update.no_of_boxes = filtered.length;
  } else if (body.update_box) {
    const boxes = (detail.boxes || []).map((b) => {
      if (b.box_id === body.update_box.box_id) return { ...b, ...body.update_box };
      return b;
    });
    update.boxes = boxes;
  } else if (body.keep_aside_flag !== undefined) {
    update.keep_aside_flag = body.keep_aside_flag;
  } else {
    if (body.sku_code) update.sku_code = body.sku_code;
    if (body.brand !== undefined) update.brand = body.brand;
    if (body.qty_per_box) update.qty_per_box = body.qty_per_box;
    if (body.label_img_url !== undefined) update.label_img_url = body.label_img_url;
    if (body.unknown_sku_flag !== undefined) update.unknown_sku_flag = body.unknown_sku_flag;
  }

  update.updatedAt = new Date();

  await db.collection("inwarddetails").updateOne({ inward_details_id: detailId, inward_id: id }, { $set: update });
  await db.collection("inwards").updateOne({ inward_id: id }, { $set: { last_edited_at: new Date(), updatedAt: new Date() } });

  const updated = await db.collection("inwarddetails").findOne({ inward_details_id: detailId, inward_id: id });
  sendSuccess(res, updated);
};

exports.listInvoices = async (_req, res) => {
  const db = await getDb();
  const invoices = await db
    .collection("invoices")
    .find()
    .project({ _id: 1, invoice_number: 1, vendor_name: 1, date: 1 })
    .limit(50)
    .toArray();
  sendSuccess(res, invoices);
};
