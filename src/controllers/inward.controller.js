const { v4: uuidv4 } = require("uuid");
const xlsx = require("xlsx");
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

exports.exportExcel = async (req, res) => {
  const inwardId = req.params.id;
  const db = await getDb();

  // 1. Get the inward record
  const inward = await db.collection("inwards").findOne({ inward_id: inwardId });
  if (!inward) return sendError(res, "Inward not found", 404);

  // 2. Get linked invoices
  const objectIds = (inward.invoice_ids || []).map((id) => {
    try { return toObjectId(id); } catch { return null; }
  }).filter(Boolean);

  const invoices = objectIds.length > 0
    ? await db.collection("invoices").find({ _id: { $in: objectIds } }).toArray()
    : [];

  const invoiceMap = {};
  invoices.forEach((inv) => { invoiceMap[inv.invoice_id] = inv; });
  const actualInvoiceUUIDs = invoices.map((inv) => inv.invoice_id).filter(Boolean);

  // 3. Get invoice line items
  const lineItems = actualInvoiceUUIDs.length > 0
    ? await db.collection("invoice_line_items").find({ invoice_id: { $in: actualInvoiceUUIDs } }).toArray()
    : [];

  // 4. Build Excel rows from line items
  const rows = lineItems.map((item, idx) => {
    const qty = Number(item.quantity || item.qty || 0);
    const oldPrice = Number(item.unit_price || item.old_price || item.rate || 0);
    const oldTotal = qty * oldPrice;
    const newRate = Number(item.new_rate || item.new_price || oldPrice);
    const newTotal = qty * newRate;
    const igstRate = Number(item.igst_rate || item.igst || 18);
    const inrRate = Number(item.inr_rate || item.exchange_rate || 0);
    const inrTotal = newTotal * inrRate;
    const igstTotal = inrTotal * (igstRate / 100);
    const partNetWt = Number(item.part_net_wt || item.net_weight || item.unit_weight || 0);
    const totalNetWt = Number(item.total_net_wt || 0) || (qty * partNetWt);

    return {
      "SR NO": idx + 1,
      "PART NO": item.part_number || item.item_no || item.sku_code || "",
      "DESC": item.description || item.desc || "",
      "TOTAL Q": qty || "",
      "COO": item.coo || item.country_of_origin || "",
      "HSN CODE": item.hsn_code || item.hsn || "",
      "PART NET WT (KGS)": partNetWt || "",
      "TOTAL NET WT": totalNetWt || "",
      "BO REFERENCE": item.bo_reference || item.ref_no || item.order_ref || "",
      "BO Q": item.bo_qty || item.bo_q || "",
      "BRAND": item.brand || item.brand_name || "",
      "OLD PRICE": oldPrice || "",
      "OLD TOTAL": oldTotal || "",
      "NEW RATE": newRate || "",
      "NEW TOTAL": newTotal || "",
      "IGST RATE": igstRate || "",
      "NDIA DISTRC": item.ndia_distrc || item.district || "",
      "INR RATE": inrRate || "",
      "INR TOTAL": inrTotal ? inrTotal.toFixed(2) : "",
      "IGST TOTAL": igstTotal ? igstTotal.toFixed(2) : "",
    };
  });

  // If no line items, still create an Excel with inward summary
  if (rows.length === 0) {
    rows.push({
      "SR NO": "—",
      "PART NO": "No line items found",
      "DESC": "", "TOTAL Q": "", "COO": "", "HSN CODE": "",
      "PART NET WT (KGS)": "", "TOTAL NET WT": "", "BO REFERENCE": "",
      "BO Q": "", "BRAND": "", "OLD PRICE": "", "OLD TOTAL": "",
      "NEW RATE": "", "NEW TOTAL": "", "IGST RATE": "",
      "NDIA DISTRC": "", "INR RATE": "", "INR TOTAL": "", "IGST TOTAL": "",
    });
  }

  // 5. Build workbook
  const wb = xlsx.utils.book_new();

  // Sheet 1: Line Items
  const ws = xlsx.utils.json_to_sheet(rows);
  ws["!cols"] = [
    { wch: 6 },  // SR NO
    { wch: 16 }, // PART NO
    { wch: 30 }, // DESC
    { wch: 8 },  // TOTAL Q
    { wch: 10 }, // COO
    { wch: 10 }, // HSN CODE
    { wch: 16 }, // PART NET WT
    { wch: 14 }, // TOTAL NET WT
    { wch: 16 }, // BO REFERENCE
    { wch: 8 },  // BO Q
    { wch: 14 }, // BRAND
    { wch: 12 }, // OLD PRICE
    { wch: 12 }, // OLD TOTAL
    { wch: 12 }, // NEW RATE
    { wch: 12 }, // NEW TOTAL
    { wch: 10 }, // IGST RATE
    { wch: 14 }, // NDIA DISTRC
    { wch: 10 }, // INR RATE
    { wch: 14 }, // INR TOTAL
    { wch: 14 }, // IGST TOTAL
  ];
  xlsx.utils.book_append_sheet(wb, ws, "Inward Line Items");

  // Sheet 2: Inward Summary
  const summaryRows = [
    { "Field": "Inward ID", "Value": inward.inward_id },
    { "Field": "Status", "Value": inward.status },
    { "Field": "Date", "Value": inward.inward_date ? new Date(inward.inward_date).toLocaleDateString("en-IN") : "" },
    { "Field": "Created By", "Value": inward.created_by },
    { "Field": "Vendor Name", "Value": inward.vendor_name || "" },
    { "Field": "Linked Invoices", "Value": invoices.map(inv => inv.invoice_number || inv._id).join(", ") },
    { "Field": "Receive Boxes", "Value": inward.receive_boxes || "" },
    { "Field": "Total SKUs", "Value": (inward.allowed_skus || []).length },
    { "Field": "Exceptions", "Value": (inward.exceptions || []).length },
  ];
  const wsSummary = xlsx.utils.json_to_sheet(summaryRows);
  wsSummary["!cols"] = [{ wch: 20 }, { wch: 40 }];
  xlsx.utils.book_append_sheet(wb, wsSummary, "Inward Summary");

  // 6. Send file
  const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
  const safeId = inwardId.slice(0, 8);
  const dateStr = new Date().toISOString().slice(0, 10);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Inward_${safeId}_${dateStr}.xlsx"`);
  return res.send(buffer);
};
