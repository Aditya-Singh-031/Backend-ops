const xlsx = require("xlsx");
const ExcelJS = require("exceljs");
const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");
const { safeParseFloat, sanitizeFilename } = require("../utils/helpers");

// ── PO Number Generator ──────────────────────────────────────────────────────
async function generatePONumber(db) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `PO/${year}/${month}/`;

  const latest = await db
    .collection("purchase_orders")
    .find({ po_number: { $regex: `^PO/${year}/${month}/` } })
    .sort({ po_number: -1 })
    .limit(1)
    .toArray();

  let nextNum = 1;
  if (latest.length > 0) {
    const lastPart = latest[0].po_number.split("/").pop();
    const lastNum = parseInt(lastPart, 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }
  return `${prefix}${String(nextNum).padStart(3, "0")}`;
}

// ── List ─────────────────────────────────────────────────────────────────────
exports.list = async (req, res) => {
  const db = await getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const skip = (page - 1) * limit;

  const query = { is_deleted: { $ne: true } };
  if (req.query.status) query.status = req.query.status;
  if (req.query.supplier_id) query.supplier_id = toObjectId(req.query.supplier_id);

  const [purchase_orders, total] = await Promise.all([
    db.collection("purchase_orders").find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
    db.collection("purchase_orders").countDocuments(query),
  ]);

  return sendSuccess(res, {
    purchase_orders,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

// ── Get By ID ────────────────────────────────────────────────────────────────
exports.getById = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const po = await db.collection("purchase_orders").findOne({ _id: oid, is_deleted: { $ne: true } });
  if (!po) return sendError(res, "Purchase order not found", 404);

  // Enrich supplier info if available
  if (po.supplier_id) {
    const suppId = toObjectId(po.supplier_id);
    if (suppId) {
      const supplier = await db.collection("suppliers").findOne({ _id: suppId });
      if (supplier) po.supplier = supplier;
    }
  }

  // Return shape matches frontend: { po, line_items }
  const line_items = po.line_items || [];
  delete po.line_items;
  return sendSuccess(res, { po, line_items });
};

// ── Create ───────────────────────────────────────────────────────────────────
exports.create = async (req, res) => {
  const db = await getDb();
  const body = req.body;

  // Support both flat body and { po, line_items } shape
  const poData = body.po || body;
  const lineItems = body.line_items || body.items || [];

  // Validate required field
  if (!poData.supplier_id) {
    return sendError(res, "supplier_id: Required", 400);
  }

  const po_number = poData.po_number?.trim() || (await generatePONumber(db));

  const suppId = toObjectId(poData.supplier_id);

  // Auto-fetch supplier name if not provided
  let supplier_name = poData.supplier_name || "";
  if (!supplier_name && suppId) {
    const supplier = await db.collection("suppliers").findOne({ _id: suppId });
    supplier_name = supplier?.supp_name || supplier?.name || "";
  }

  const formattedLineItems = lineItems.map((item) => ({
    part_number: item.part_number || "",
    brand: item.brand || "",
    qty_ordered: parseFloat(item.qty_ordered) || 0,
    qty_received: 0,
    mrp: parseFloat(item.mrp) || 0,
    rate: parseFloat(item.rate) || 0,
    discount_percent: parseFloat(item.discount_percent) || 0,
    line_total: parseFloat(item.line_total) || 0,
  }));

  const finalAmount =
    poData.final_amount != null
      ? parseFloat(poData.final_amount)
      : formattedLineItems.reduce((s, i) => s + i.line_total, 0);

  const po = {
    po_number,
    supplier_id: suppId,
    supplier_name,
    po_date: poData.po_date ? new Date(poData.po_date) : new Date(),
    pricing_mode: poData.pricing_mode || "MRP",
    payment_terms: poData.payment_terms || "",
    final_amount: finalAmount,
    status: "open",
    line_items: formattedLineItems,
    proforma_invoice_ids: (poData.proforma_invoice_ids || [])
      .map((id) => toObjectId(id))
      .filter(Boolean),
    invoice_ids: [],
    is_deleted: false,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const result = await db.collection("purchase_orders").insertOne(po);
  po._id = result.insertedId;

  return sendSuccess(res, { purchase_order: po }, 201);
};

// ── Update ───────────────────────────────────────────────────────────────────
exports.update = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const body = req.body;
  const updateFields = {};

  const allowedFields = ["po_date", "pricing_mode", "payment_terms", "status", "supplier_name"];
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updateFields[field] = field === "po_date" ? new Date(body[field]) : body[field];
    }
  }

  if (body.supplier_id) {
    updateFields.supplier_id = toObjectId(body.supplier_id);
  }

  if (body.line_items || body.items) {
    const lineItems = body.line_items || body.items || [];
    updateFields.line_items = lineItems.map((item) => ({
      part_number: item.part_number || "",
      brand: item.brand || "",
      qty_ordered: parseFloat(item.qty_ordered) || 0,
      qty_received: parseFloat(item.qty_received) || 0,
      mrp: parseFloat(item.mrp) || 0,
      rate: parseFloat(item.rate) || 0,
      discount_percent: parseFloat(item.discount_percent) || 0,
      line_total: parseFloat(item.line_total) || 0,
    }));
    updateFields.final_amount = updateFields.line_items.reduce((s, i) => s + i.line_total, 0);
  }

  if (body.final_amount != null) updateFields.final_amount = parseFloat(body.final_amount);

  updateFields.updated_at = new Date();

  const result = await db.collection("purchase_orders").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $set: updateFields },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Purchase order not found", 404);

  return sendSuccess(res, { purchase_order: result });
};

// ── Delete (soft) ────────────────────────────────────────────────────────────
exports.remove = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const po = await db.collection("purchase_orders").findOne({ _id: oid });
  if (!po) return sendError(res, "Purchase order not found", 404);

  // Prevent deletion if it has linked invoices
  if (po.invoice_ids && po.invoice_ids.length > 0) {
    return sendError(res, "Cannot delete: PO has linked invoices", 400);
  }

  await db.collection("purchase_orders").deleteOne({ _id: oid });
  return sendSuccess(res, { message: "Purchase order deleted successfully" });
};

// ── Link Invoices ─────────────────────────────────────────────────────────────
exports.linkInvoices = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const { invoice_ids } = req.body;
  const invoiceOids = (invoice_ids || []).map((id) => toObjectId(id)).filter(Boolean);

  const result = await db.collection("purchase_orders").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $addToSet: { invoice_ids: { $each: invoiceOids } }, $set: { updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Purchase order not found", 404);

  return sendSuccess(res, { purchase_order: result });
};

// ── Get Linked Invoices ───────────────────────────────────────────────────────
exports.getInvoices = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const po = await db.collection("purchase_orders").findOne({ _id: oid, is_deleted: { $ne: true } });
  if (!po) return sendError(res, "Purchase order not found", 404);

  const invoiceOids = (po.invoice_ids || []).map((id) => toObjectId(id)).filter(Boolean);
  const invoices = invoiceOids.length > 0
    ? await db.collection("invoices").find({ _id: { $in: invoiceOids } }).toArray()
    : [];

  return sendSuccess(res, invoices);
};

// ── Unlink Invoices ───────────────────────────────────────────────────────────
exports.unlinkInvoices = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const { invoice_ids } = req.body;
  const invoiceOids = (invoice_ids || []).map((id) => toObjectId(id)).filter(Boolean);

  const result = await db.collection("purchase_orders").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $pull: { invoice_ids: { $in: invoiceOids } }, $set: { updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Purchase order not found", 404);

  return sendSuccess(res, { purchase_order: result });
};

// ── Update Proforma Invoice Associations ──────────────────────────────────────
exports.updateProformaInvoices = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const { proforma_invoice_ids } = req.body;
  const piOids = (proforma_invoice_ids || []).map((id) => toObjectId(id)).filter(Boolean);

  const result = await db.collection("purchase_orders").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $set: { proforma_invoice_ids: piOids, updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Purchase order not found", 404);

  return sendSuccess(res, { purchase_order: result });
};

// ── Import Preview (parse Excel to preview line items) ────────────────────────
exports.importPreview = async (req, res) => {
  if (!req.file) return sendError(res, "No file uploaded", 400);
  const fs = require("fs");
  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    const warnings = [];
    const line_items = rows.map((row, idx) => {
      const nr = {};
      Object.keys(row).forEach((k) => { nr[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = row[k]; });
      const gv = (...keys) => {
        for (const key of keys) {
          const nk = key.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (nr[nk] !== undefined && nr[nk] !== "") return nr[nk];
        }
        return "";
      };

      const brand = String(gv("Brand", "brand") || "").trim();
      const part_number = String(gv("CODE", "code", "Part Number", "Part No", "PartNo") || "").trim();
      const description = String(gv("Description", "Desc") || "").trim();
      const qty_ordered = safeParseFloat(gv("Quantity", "Qty", "qty"));
      const mrp = safeParseFloat(gv("RATE/MRP", "MRP", "mrp", "Rate", "rate", "Price"));
      const discount_percent = safeParseFloat(gv("Discount%", "Discount", "discount"));

      if (!part_number && !description) {
        warnings.push(`Row ${idx + 2}: missing part number/code — skipped`);
        return null;
      }

      const line_total = mrp * qty_ordered * (1 - discount_percent / 100);
      return { brand, part_number, description, qty_ordered, mrp, discount_percent, line_total, quantity: qty_ordered, rate: mrp };
    }).filter(Boolean);

    const mrp_total = line_items.reduce((s, i) => s + i.mrp * i.qty_ordered, 0);
    const final_amount = line_items.reduce((s, i) => s + i.line_total, 0);
    const discount_percent = mrp_total > 0 ? Math.round(((mrp_total - final_amount) / mrp_total) * 10000) / 100 : 0;

    return sendSuccess(res, {
      item_count: line_items.length,
      line_items,
      items: line_items.map((i) => ({ brand: i.brand, part_number: i.part_number, description: i.description, quantity: i.qty_ordered, rate: i.mrp })),
      summary: { mrp_total, final_amount, discount_percent },
      warnings,
    });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
};

// ── Discrepancy Report (stub — returns placeholder) ───────────────────────────
exports.discrepancyReport = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const po = await db.collection("purchase_orders").findOne({ _id: oid, is_deleted: { $ne: true } });
  if (!po) return sendError(res, "Purchase order not found", 404);

  return sendError(res, "Discrepancy report generation not yet implemented for purchase orders", 501);
};

// ── Download (Excel) ──────────────────────────────────────────────────────────
exports.download = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const po = await db.collection("purchase_orders").findOne({ _id: oid, is_deleted: { $ne: true } });
  if (!po) return sendError(res, "Purchase order not found", 404);

  // Enrich supplier
  let supplier = null;
  if (po.supplier_id) {
    const suppId = toObjectId(po.supplier_id);
    if (suppId) supplier = await db.collection("suppliers").findOne({ _id: suppId });
  }

  const lineItems = po.line_items || [];

  // ── Build workbook ────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = "Morsebiz";
  const ws = wb.addWorksheet("Purchase Order");

  const COLS = 7;
  const COL_WIDTHS = [6, 18, 22, 10, 12, 12, 14];
  COL_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-";
  const fmtNum  = (n) => Number(n) || 0;

  const BLUE_FILL   = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A3A8F" } };
  const LIGHT_FILL  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF8" } };
  const THEAD_FILL  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2146C7" } };
  const TOTAL_FILL  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F4FF" } };
  const BORDER      = { style: "thin", color: { argb: "FFB0BBD0" } };
  const BOX         = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
  const WHITE       = { argb: "FFFFFFFF" };
  const DARK        = { argb: "FF1A1A2E" };

  let r = 1;

  // Row 1 – Company banner
  ws.mergeCells(r, 1, r, COLS);
  const banner = ws.getCell(r, 1);
  banner.value = "Morsebiz Technology Services Pvt Ltd";
  banner.font  = { bold: true, size: 14, color: WHITE, name: "Calibri" };
  banner.alignment = { horizontal: "center", vertical: "middle" };
  banner.fill  = BLUE_FILL;
  ws.getRow(r).height = 28; r++;

  // Row 2 – Address
  ws.mergeCells(r, 1, r, COLS);
  const addr = ws.getCell(r, 1);
  addr.value = "20th Floor, CTS No 95 4 B 3&4, 590 Oberoi Garden City, Goregaon East, Mumbai 400063 | GST: 27AAPCM5559A1Z9";
  addr.font  = { size: 9, color: { argb: "FF334499" }, italic: true };
  addr.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  addr.fill  = LIGHT_FILL;
  ws.getRow(r).height = 20; r++;

  // Row 3 – Document title
  ws.mergeCells(r, 1, r, COLS);
  const title = ws.getCell(r, 1);
  title.value = "PURCHASE ORDER";
  title.font  = { bold: true, size: 13, color: { argb: "FF1A3A8F" }, underline: true };
  title.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(r).height = 22; r++;
  r++; // spacer

  // Details block
  const details = [
    ["PO Number",   po.po_number  || "-",  "PO Date",      fmtDate(po.po_date)],
    ["Supplier",    po.supplier_name || "-", "Pricing Mode", po.pricing_mode || "MRP"],
    ["Payment Terms", po.payment_terms || "-", "Status",     (po.status || "open").toUpperCase()],
  ];
  details.forEach(([l1, v1, l2, v2]) => {
    const lc1 = ws.getCell(r, 1); lc1.value = l1; lc1.font = { bold: true, size: 10, color: DARK }; lc1.fill = LIGHT_FILL;
    ws.mergeCells(r, 2, r, 4);
    const vc1 = ws.getCell(r, 2); vc1.value = v1; vc1.font = { size: 10, color: DARK };
    const lc2 = ws.getCell(r, 5); lc2.value = l2; lc2.font = { bold: true, size: 10, color: DARK }; lc2.fill = LIGHT_FILL;
    ws.mergeCells(r, 6, r, 7);
    const vc2 = ws.getCell(r, 6); vc2.value = v2; vc2.font = { size: 10, color: DARK };
    [lc1, vc1, lc2, vc2].forEach(c => { c.border = BOX; c.alignment = { vertical: "middle" }; });
    ws.getRow(r).height = 18; r++;
  });
  r++; // spacer

  // Table header
  const headers = ["Sr", "Part Number", "Brand", "Qty", "MRP", "Rate", "Line Total"];
  headers.forEach((h, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = h; c.font = { bold: true, size: 10, color: WHITE };
    c.fill = THEAD_FILL; c.border = BOX;
    c.alignment = { horizontal: "center", vertical: "middle" };
  });
  ws.getRow(r).height = 20; r++;

  // Line items
  let grandTotal = 0;
  lineItems.forEach((item, idx) => {
    const qty   = fmtNum(item.qty_ordered);
    const mrp   = fmtNum(item.mrp);
    const rate  = fmtNum(item.rate) || mrp;
    const total = fmtNum(item.line_total) || qty * rate;
    grandTotal += total;

    const shade = idx % 2 === 1 ? "FFF7F8FF" : "FFFFFFFF";
    const rowData = [idx + 1, item.part_number || "-", item.brand || "-", qty, mrp, rate, total];
    rowData.forEach((val, i) => {
      const c = ws.getCell(r, i + 1);
      c.value = val;
      c.font  = { size: 10, color: DARK };
      c.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: shade } };
      c.border = BOX;
      if (i === 0 || i === 3) c.alignment = { horizontal: "center", vertical: "middle" };
      else if (i >= 4) { c.alignment = { horizontal: "right", vertical: "middle" }; c.numFmt = "#,##0.00"; }
      else c.alignment = { horizontal: "left", vertical: "middle" };
    });
    ws.getRow(r).height = 16; r++;
  });

  // Grand total row
  ws.mergeCells(r, 1, r, 6);
  const gtLabel = ws.getCell(r, 1);
  gtLabel.value = "GRAND TOTAL";
  gtLabel.font  = { bold: true, size: 11, color: WHITE };
  gtLabel.alignment = { horizontal: "right", vertical: "middle" };
  gtLabel.fill  = THEAD_FILL; gtLabel.border = BOX;
  const gtVal = ws.getCell(r, 7);
  gtVal.value   = fmtNum(po.final_amount) || grandTotal;
  gtVal.font    = { bold: true, size: 11, color: WHITE };
  gtVal.numFmt  = "#,##0.00";
  gtVal.alignment = { horizontal: "right", vertical: "middle" };
  gtVal.fill    = THEAD_FILL; gtVal.border = BOX;
  ws.getRow(r).height = 22; r++;

  // Footer
  r++;
  ws.mergeCells(r, 1, r, COLS);
  const footer = ws.getCell(r, 1);
  footer.value = "Morsebiz Technology Services Pvt Ltd | Regd. Office: 20th Floor, CTS No 95 4 B 3&4, 590 Oberoi Garden City, Goregaon East, Mumbai 400063 | CIN: U72900MH2021PTC362935";
  footer.font  = { size: 8, italic: true, color: { argb: "FF666688" } };
  footer.alignment = { horizontal: "center", wrapText: true };
  footer.fill  = LIGHT_FILL;
  ws.getRow(r).height = 24;

  const buffer   = await wb.xlsx.writeBuffer();
  const filename = sanitizeFilename(po.po_number || po._id.toString());
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="PO_${filename}.xlsx"`);
  return res.send(buffer);
};
