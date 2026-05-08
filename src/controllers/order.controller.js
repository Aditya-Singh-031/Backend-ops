const xlsx = require("xlsx");
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");
const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");
const { escapeRegex, safeParseFloat, sanitizeFilename } = require("../utils/helpers");
const { generatePIWord } = require("../services/wordGenerator");

const libre = require("libreoffice-convert");
const convertAsync = (buffer, format, filter) =>
  new Promise((resolve, reject) => {
    libre.convert(buffer, format, filter, (err, done) => {
      if (err) reject(err);
      else resolve(done);
    });
  });

const BANK_ACCOUNTS = {
  HDFC: {
    key: "HDFC",
    bank_name: "HDFC Bank",
    account_name: "Morsebiz Technology Services Pvt Ltd",
    account_number: "50200090272949",
    ifsc_code: "HDFC0001774",
    swift_code: "HDFCINBBXXX",
  },
  SBERBANK: {
    key: "SBERBANK",
    bank_name: "Sberbank",
    account_name: "Morsebiz Technology Services Pvt Ltd",
    account_number: "40702840338000009077",
    ifsc_code: "",
    swift_code: "SABRRUMM",
  },
};

function getFiscalYear(date = new Date()) {
  const month = date.getMonth() + 1; // 1-indexed
  const year = date.getFullYear();
  // Indian fiscal year: April (4) to March (3)
  const fyStart = month >= 4 ? year : year - 1;
  const fyEnd = fyStart + 1;
  return `${String(fyStart).slice(-2)}-${String(fyEnd).slice(-2)}`;
}

async function generateOrderNumber(db) {
  const now = new Date();
  const fy = getFiscalYear(now);
  const prefix = `MUM/${fy}/ORD-`;
  const latest = await db
    .collection("orders")
    .find({ order_number: { $regex: `^MUM/${fy}/ORD-` } })
    .sort({ order_number: -1 })
    .limit(1)
    .toArray();

  let nextNum = 1;
  if (latest.length > 0) {
    const lastPart = latest[0].order_number.split("-").pop();
    const lastNum = parseInt(lastPart, 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }
  return `${prefix}${String(nextNum).padStart(3, "0")}`;
}

async function generatePINumber(db) {
  const now = new Date();
  const fy = getFiscalYear(now);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `MUM/${fy}/${month}/`;
  const latest = await db
    .collection("orders")
    .find({ pi_number: { $regex: `^MUM/${fy}/${month}/` } })
    .sort({ pi_number: -1 })
    .limit(1)
    .toArray();

  let nextNum = 1;
  if (latest.length > 0) {
    const lastPart = latest[0].pi_number.split("/").pop();
    const lastNum = parseInt(lastPart, 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }
  return `${prefix}${String(nextNum).padStart(3, "0")}`;
}

async function generatePIExcel(order, orderDetail, buyer) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Morsebiz";
  const ws = wb.addWorksheet("Proforma Invoice");

  const COLS = 7;
  const COL_WIDTHS = [6, 14, 20, 36, 8, 14, 14];
  COL_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const fmt = (amount, curr) => {
    const n = Number(amount) || 0;
    const sym = { INR: "\u20B9", USD: "$", EUR: "\u20AC", GBP: "\u00A3" }[curr] || "";
    return `${sym}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-";

  const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A3A8F" } };
  const SUBHEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF8" } };
  const TABLE_HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD0D8F0" } };
  const TOTAL_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F4FF" } };
  const BORDER_THIN = { style: "thin", color: { argb: "FFB0BBD0" } };
  const BOX_BORDER = { top: BORDER_THIN, left: BORDER_THIN, bottom: BORDER_THIN, right: BORDER_THIN };
  const WHITE_TEXT = { argb: "FFFFFFFF" };
  const DARK_TEXT = { argb: "FF1A1A2E" };

  let r = 1;

  // ── Row 1: Company name header ──────────────────────────────────────────
  ws.mergeCells(r, 1, r, COLS);
  const titleCell = ws.getCell(r, 1);
  titleCell.value = "Morsebiz Technology Services Pvt Ltd";
  titleCell.font = { bold: true, size: 14, color: WHITE_TEXT, name: "Calibri" };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  titleCell.fill = HEADER_FILL;
  ws.getRow(r).height = 28;
  r++;

  // ── Row 2: Sub-header (address) ──────────────────────────────────────────
  ws.mergeCells(r, 1, r, COLS);
  const addrCell = ws.getCell(r, 1);
  addrCell.value = "20th Floor, CTS No 95 4 B 3&4, 590 Oberoi Garden City, Goregaon East, Mumbai 400063 | GST: 27AAPCM5559A1Z9";
  addrCell.font = { size: 9, color: { argb: "FF334499" }, italic: true };
  addrCell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  addrCell.fill = SUBHEADER_FILL;
  ws.getRow(r).height = 20;
  r++;

  // ── Row 3: Document title ────────────────────────────────────────────────
  ws.mergeCells(r, 1, r, COLS);
  const docTitle = ws.getCell(r, 1);
  docTitle.value = "PROFORMA INVOICE";
  docTitle.font = { bold: true, size: 13, color: { argb: "FF1A3A8F" }, underline: true };
  docTitle.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(r).height = 22;
  r++;

  r++; // blank spacer

  // ── PI Details block (2 col) ────────────────────────────────────────────
  const details = [
    ["PI Number", order.pi_number || "-", "PI Date", fmtDate(order.pi_date || order.order_date)],
    ["Order Number", order.order_number || "-", "Currency", order.currency || "INR"],
    ["Payment Terms", order.payment_terms || "-", "Delivery Terms", order.delivery_terms || "-"],
    ["Buyer", buyer?.cust_name || buyer?.name || "-", "Status", order.status || "-"],
  ];

  details.forEach(([l1, v1, l2, v2]) => {
    const lc1 = ws.getCell(r, 1); lc1.value = l1;
    lc1.font = { bold: true, size: 10, color: DARK_TEXT }; lc1.fill = SUBHEADER_FILL;
    ws.mergeCells(r, 2, r, 4);
    const vc1 = ws.getCell(r, 2); vc1.value = v1;
    vc1.font = { size: 10, color: DARK_TEXT };
    const lc2 = ws.getCell(r, 5); lc2.value = l2;
    lc2.font = { bold: true, size: 10, color: DARK_TEXT }; lc2.fill = SUBHEADER_FILL;
    ws.mergeCells(r, 6, r, 7);
    const vc2 = ws.getCell(r, 6); vc2.value = v2;
    vc2.font = { size: 10, color: DARK_TEXT };
    [lc1, vc1, lc2, vc2].forEach(c => { c.border = BOX_BORDER; c.alignment = { vertical: "middle", wrapText: false }; });
    ws.getRow(r).height = 18;
    r++;
  });

  r++; // spacer

  // ── Items table header ───────────────────────────────────────────────────
  const colHeaders = ["Sr", "Brand", "Part Number", "Description", "Qty", "Rate", "Amount"];
  colHeaders.forEach((h, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = h;
    c.font = { bold: true, size: 10, color: WHITE_TEXT };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2146C7" } };
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.border = BOX_BORDER;
  });
  ws.getRow(r).height = 20;
  r++;

  // ── Items rows ───────────────────────────────────────────────────────────
  const items = orderDetail?.items || [];
  let subtotal = 0;
  items.forEach((item, idx) => {
    const qty = Number(item.quantity) || 0;
    const rate = Number(item.rate) || 0;
    const amount = qty * rate;
    subtotal += amount;
    const rowShade = idx % 2 === 1 ? "FFF7F8FF" : "FFFFFFFF";
    const rowData = [idx + 1, item.brand || "-", item.part_number || "-", item.description || "-", qty, rate, amount];
    rowData.forEach((val, i) => {
      const c = ws.getCell(r, i + 1);
      c.value = val;
      c.font = { size: 10, color: DARK_TEXT };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowShade } };
      c.border = BOX_BORDER;
      if (i === 0 || i === 4) c.alignment = { horizontal: "center", vertical: "middle" };
      else if (i === 3) c.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
      else if (i >= 5) { c.alignment = { horizontal: "right", vertical: "middle" }; c.numFmt = "#,##0.00"; }
    });
    ws.getRow(r).height = 16;
    r++;
  });

  // ── Subtotal row ──────────────────────────────────────────────────────────
  ws.mergeCells(r, 1, r, 5);
  const stLabel = ws.getCell(r, 1); stLabel.value = "Subtotal";
  stLabel.font = { bold: true, size: 10, color: DARK_TEXT };
  stLabel.alignment = { horizontal: "right", vertical: "middle" };
  stLabel.fill = TOTAL_FILL; stLabel.border = BOX_BORDER;
  ws.mergeCells(r, 6, r, 7);
  const stVal = ws.getCell(r, 6); stVal.value = subtotal;
  stVal.font = { size: 10, color: DARK_TEXT };
  stVal.numFmt = "#,##0.00"; stVal.alignment = { horizontal: "right", vertical: "middle" };
  stVal.fill = TOTAL_FILL; stVal.border = BOX_BORDER;
  ws.getRow(r).height = 18; r++;

  // ── Grand Total row ───────────────────────────────────────────────────────
  ws.mergeCells(r, 1, r, 5);
  const gtLabel = ws.getCell(r, 1); gtLabel.value = "GRAND TOTAL";
  gtLabel.font = { bold: true, size: 11, color: WHITE_TEXT };
  gtLabel.alignment = { horizontal: "right", vertical: "middle" };
  gtLabel.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2146C7" } };
  gtLabel.border = BOX_BORDER;
  ws.mergeCells(r, 6, r, 7);
  const gtVal = ws.getCell(r, 6); gtVal.value = subtotal;
  gtVal.font = { bold: true, size: 11, color: WHITE_TEXT };
  gtVal.numFmt = "#,##0.00"; gtVal.alignment = { horizontal: "right", vertical: "middle" };
  gtVal.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2146C7" } };
  gtVal.border = BOX_BORDER;
  ws.getRow(r).height = 20; r++;

  // ── Bank Details ───────────────────────────────────────────────────────────
  const bank = order.bank_account_info;
  if (bank?.bank_name) {
    r++;
    ws.mergeCells(r, 1, r, COLS);
    const bankTitle = ws.getCell(r, 1); bankTitle.value = "Bank Account Details";
    bankTitle.font = { bold: true, size: 11, color: WHITE_TEXT };
    bankTitle.fill = HEADER_FILL; bankTitle.border = BOX_BORDER;
    bankTitle.alignment = { horizontal: "left", vertical: "middle" };
    ws.getRow(r).height = 18; r++;

    const bankRows = [
      ["Bank Name", bank.bank_name],
      ["Account Name", bank.account_name],
      ["Account Number", bank.account_number],
      ["IFSC Code", bank.ifsc_code],
      ...(bank.swift_code ? [["SWIFT Code", bank.swift_code]] : []),
    ];
    bankRows.forEach(([label, value]) => {
      ws.mergeCells(r, 2, r, COLS);
      const lc = ws.getCell(r, 1); lc.value = label;
      lc.font = { bold: true, size: 10, color: DARK_TEXT }; lc.fill = SUBHEADER_FILL; lc.border = BOX_BORDER;
      const vc = ws.getCell(r, 2); vc.value = value || "-";
      vc.font = { size: 10, color: DARK_TEXT }; vc.border = BOX_BORDER;
      ws.getRow(r).height = 16; r++;
    });
  }

  // ── Footer row ────────────────────────────────────────────────────────────
  r++;
  ws.mergeCells(r, 1, r, COLS);
  const footerCell = ws.getCell(r, 1);
  footerCell.value = "Morsebiz Technology Services Pvt Ltd | Regd. Office: 20th Floor, CTS No 95 4 B 3&4, 590 Oberoi Garden City, Goregaon East, Mumbai 400063 | CIN: U72900MH2021PTC362935";
  footerCell.font = { size: 8, italic: true, color: { argb: "FF666688" } };
  footerCell.alignment = { horizontal: "center", wrapText: true };
  footerCell.fill = SUBHEADER_FILL;
  ws.getRow(r).height = 24;

  return await wb.xlsx.writeBuffer();
}

async function syncProductMaster(db, items) {
  for (const item of items) {
    if (!item.part_number) continue;
    await db.collection("product_master").updateOne(
      { part_number: item.part_number },
      {
        $set: {
          brand: item.brand || undefined,
          description: item.description || undefined,
          updated_at: new Date(),
        },
        $setOnInsert: {
          part_number: item.part_number,
          igst_rate: 18,
          rate: item.rate || 0,
          is_deleted: false,
          created_at: new Date(),
        },
      },
      { upsert: true }
    );
  }
}

exports.getBankAccounts = async (_req, res) => {
  return sendSuccess(res, { accounts: Object.values(BANK_ACCOUNTS) });
};

exports.getNextPINumber = async (_req, res) => {
  const db = await getDb();
  const piNumber = await generatePINumber(db);
  return sendSuccess(res, { pi_number: piNumber });
};

exports.create = async (req, res) => {
  const db = await getDb();
  const body = req.body;
  const order_number = await generateOrderNumber(db);
  const pi_number = body.pi_number?.trim() || await generatePINumber(db);

  let bank_account_info = null;
  if (body.bank_account_key && BANK_ACCOUNTS[body.bank_account_key]) {
    bank_account_info = BANK_ACCOUNTS[body.bank_account_key];
  }

  const items = (body.items || []).map((item) => ({
    product_id: item.product_id ? toObjectId(item.product_id) : null,
    brand: item.brand || "",
    part_number: item.part_number || "",
    description: item.description || "",
    quantity: Number(item.quantity) || 0,
    quantity_filled: Number(item.quantity_filled) || 0,
    quantity_pending: Number(item.quantity_pending) || 0,
    quantity_cancelled: Number(item.quantity_cancelled) || 0,
    rate: Number(item.rate) || 0,
    taxable_value: (Number(item.quantity) || 0) * (Number(item.rate) || 0),
    total_amount: (Number(item.quantity) || 0) * (Number(item.rate) || 0),
  }));

  const subtotal = items.reduce((acc, i) => acc + i.total_amount, 0);

  const order = {
    buyer_id: toObjectId(body.buyer_id),
    consignee_id: body.consignee_id ? toObjectId(body.consignee_id) : null,
    order_number,
    order_date: body.order_date ? new Date(body.order_date) : new Date(),
    currency: body.currency || "INR",
    status: body.status || "INQUIRY",
    pi_number: pi_number,
    pi_date: body.pi_date ? new Date(body.pi_date) : null,
    payment_terms: body.payment_terms || "",
    delivery_terms: body.delivery_terms || "FOB",
    bank_account_key: body.bank_account_key || null,
    bank_account_info,
    subtotal,
    grand_total: subtotal,
    is_deleted: false,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const orderResult = await db.collection("orders").insertOne(order);
  order._id = orderResult.insertedId;

  const orderDetail = {
    order_id: order._id,
    items,
    po_ids: [],
    supplier_invoice_ids: [],
    packing_list_ids: [],
    shipment_ids: [],
    is_deleted: false,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const detailResult = await db.collection("order_details").insertOne(orderDetail);
  await db.collection("orders").updateOne(
    { _id: order._id },
    { $set: { order_details_id: detailResult.insertedId } }
  );
  order.order_details_id = detailResult.insertedId;

  if (order.status === "CONFIRMED") await syncProductMaster(db, items);

  return sendSuccess(res, { order }, 201);
};

exports.list = async (req, res) => {
  const db = await getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

  const query = { is_deleted: { $ne: true } };
  if (req.query.status) query.status = { $in: req.query.status.split(",").map((s) => s.trim()) };
  if (req.query.buyer_id) query.buyer_id = toObjectId(req.query.buyer_id);
  if (req.query.dateFrom || req.query.dateTo) {
    query.order_date = {};
    if (req.query.dateFrom) query.order_date.$gte = new Date(req.query.dateFrom);
    if (req.query.dateTo) {
      const to = new Date(req.query.dateTo);
      to.setHours(23, 59, 59, 999);
      query.order_date.$lte = to;
    }
  }
  if (req.query.search) {
    const escaped = escapeRegex(req.query.search);
    query.$or = [
      { order_number: { $regex: escaped, $options: "i" } },
      { pi_number: { $regex: escaped, $options: "i" } },
    ];
  }

  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    db.collection("orders").find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
    db.collection("orders").countDocuments(query),
  ]);

  const buyerIds = [...new Set(orders.map((o) => o.buyer_id?.toString()).filter(Boolean))];
  const buyerOids = buyerIds.map((id) => toObjectId(id)).filter(Boolean);
  const buyers = buyerOids.length > 0
    ? await db.collection("buyers").find({ _id: { $in: buyerOids } }).toArray()
    : [];
  const buyerMap = {};
  buyers.forEach((b) => (buyerMap[b._id.toString()] = b));
  orders.forEach((o) => {
    const bid = o.buyer_id?.toString();
    if (bid && buyerMap[bid]) o.buyer_id = { _id: buyerMap[bid]._id, cust_name: buyerMap[bid].cust_name };
  });

  return sendSuccess(res, {
    orders,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

exports.getById = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const order = await db.collection("orders").findOne({ _id: oid, is_deleted: { $ne: true } });
  if (!order) return sendError(res, "Order not found", 404);

  if (order.buyer_id) {
    const buyer = await db.collection("buyers").findOne({ _id: toObjectId(order.buyer_id) });
    if (buyer) order.buyer_id = buyer;
  }
  if (order.consignee_id) {
    const consignee = await db.collection("buyers").findOne({ _id: toObjectId(order.consignee_id) });
    if (consignee) order.consignee_id = consignee;
  }
  const orderDetail = await db.collection("order_details").findOne({ order_id: order._id, is_deleted: { $ne: true } });
  if (orderDetail) {
    const productIds = (orderDetail.items || []).map((i) => i.product_id).filter(Boolean).map((id) => toObjectId(id)).filter(Boolean);
    if (productIds.length > 0) {
      const products = await db.collection("product_master").find({ _id: { $in: productIds } }).toArray();
      const productMap = {};
      products.forEach((p) => (productMap[p._id.toString()] = p));
      orderDetail.items = orderDetail.items.map((item) => {
        const pid = item.product_id?.toString();
        if (pid && productMap[pid]) item.product_id = productMap[pid];
        return item;
      });
    }
  }
  order.order_details = orderDetail;
  return sendSuccess(res, { order });
};

exports.update = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const body = req.body;
  const updateFields = {};
  const allowedFields = [
    "buyer_id", "consignee_id", "order_date", "currency", "status",
    "pi_number", "pi_date", "payment_terms", "delivery_terms", "bank_account_key",
  ];
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      if (field === "buyer_id" || field === "consignee_id") updateFields[field] = toObjectId(body[field]);
      else if (field === "order_date" || field === "pi_date") updateFields[field] = body[field] ? new Date(body[field]) : null;
      else updateFields[field] = body[field];
    }
  }
  if (body.bank_account_key && BANK_ACCOUNTS[body.bank_account_key]) {
    updateFields.bank_account_info = BANK_ACCOUNTS[body.bank_account_key];
  }
  if (body.items) {
    const items = body.items.map((item) => ({
      product_id: item.product_id ? toObjectId(item.product_id) : null,
      brand: item.brand || "", part_number: item.part_number || "",
      description: item.description || "",
      quantity: Number(item.quantity) || 0,
      quantity_filled: Number(item.quantity_filled) || 0,
      quantity_pending: Number(item.quantity_pending) || 0,
      quantity_cancelled: Number(item.quantity_cancelled) || 0,
      rate: Number(item.rate) || 0,
      taxable_value: (Number(item.quantity) || 0) * (Number(item.rate) || 0),
      total_amount: (Number(item.quantity) || 0) * (Number(item.rate) || 0),
    }));
    const subtotal = items.reduce((acc, i) => acc + i.total_amount, 0);
    updateFields.subtotal = subtotal;
    updateFields.grand_total = subtotal;
    await db.collection("order_details").updateOne(
      { order_id: oid, is_deleted: { $ne: true } },
      { $set: { items, updated_at: new Date() } }
    );
  }
  updateFields.updated_at = new Date();
  const result = await db.collection("orders").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $set: updateFields },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Order not found", 404);
  return sendSuccess(res, { order: result });
};

exports.updateStatus = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const { status } = req.body;
  const result = await db.collection("orders").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $set: { status, updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Order not found", 404);

  if (status === "CONFIRMED") {
    const orderDetail = await db.collection("order_details").findOne({ order_id: oid, is_deleted: { $ne: true } });
    if (orderDetail?.items) await syncProductMaster(db, orderDetail.items);
  }
  return sendSuccess(res, { order: result });
};

exports.remove = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  await db.collection("orders").deleteOne({ _id: oid });
  await db.collection("order_details").deleteMany({ order_id: oid });
  return sendSuccess(res, { message: "Order deleted successfully" });
};

exports.downloadExcel = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const order = await db.collection("orders").findOne({ _id: oid });
  if (!order) return sendError(res, "Order not found", 404);

  let buyer = null;
  if (order.buyer_id) {
    buyer = await db.collection("buyers").findOne({ _id: toObjectId(order.buyer_id) });
  }

  const orderDetail = await db.collection("order_details").findOne({ order_id: oid, is_deleted: { $ne: true } });
  const buffer = await generatePIExcel(order, orderDetail, buyer);

  const filename = sanitizeFilename(order.pi_number || order.order_number);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="PI_${filename}.xlsx"`);
  return res.send(buffer);
};

exports.downloadPdf = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const order = await db.collection("orders").findOne({ _id: oid });
  if (!order) return sendError(res, "Order not found", 404);

  if (order.buyer_id) {
    const buyer = await db.collection("buyers").findOne({ _id: toObjectId(order.buyer_id) });
    if (buyer) order.buyer_id = buyer;
  }
  if (order.consignee_id) {
    const consignee = await db.collection("buyers").findOne({ _id: toObjectId(order.consignee_id) });
    if (consignee) order.consignee_id = consignee;
  }
  const orderDetail = await db.collection("order_details").findOne({ order_id: oid, is_deleted: { $ne: true } });

  const piData = {
    exporter: {
      name: "Morsebiz Technology Services Pvt Ltd",
      address: "20th Floor, Building No/Flat No – CTS No 95 4 B 3&4, 590 Oberoi Garden City, Goregaon East, Mumbai, Mumbai Suburban, Maharashtra 400063",
      gstNo: "27AAPCM5559A1Z9",
    },
    buyer: order.buyer_id || {},
    consignee: order.consignee_id || order.buyer_id || {},
    piNumber: order.pi_number || order.order_number,
    piDate: order.pi_date || order.order_date,
    termsOfPayment: order.payment_terms,
    termsOfDelivery: order.delivery_terms,
    bank_account_info: order.bank_account_info,
  };

  const buffer = await generatePIWord(piData, orderDetail?.items || [], order.currency || "INR");
  const filename = sanitizeFilename(order.pi_number || order.order_number);

  try {
    const pdfBuffer = await convertAsync(buffer, ".pdf", undefined);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="PI_${filename}.pdf"`);
    return res.send(pdfBuffer);
  } catch {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="PI_${filename}.docx"`);
    res.setHeader("X-Output-Format", "docx");
    return res.send(buffer);
  }
};

exports.downloadTemplate = async (req, res) => {
  const filePath = path.join(__dirname, "../assets/PI_Upload_Sample.xlsx");
  if (!fs.existsSync(filePath)) {
    return sendError(res, "Template file not found", 404);
  }
  res.download(filePath, "PI_Upload_Sample.xlsx");
};

exports.uploadExcel = async (req, res) => {
  if (!req.file) return sendError(res, "No file uploaded", 400);
  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    const items = rows
      .map((row) => {
        const nr = {};
        Object.keys(row).forEach((k) => { nr[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = row[k]; });
        const gv = (...keys) => {
          for (const key of keys) {
            const nk = key.toLowerCase().replace(/[^a-z0-9]/g, "");
            if (nr[nk] !== undefined && nr[nk] !== "") return nr[nk];
          }
          return "";
        };
        return {
          brand: gv("Brand"),
          part_number: gv("Part Number", "Part No", "PartNo"),
          description: gv("Description", "Desc"),
          quantity: Number(gv("Quantity", "Qty")) || 0,
          rate: Number(gv("Rate", "Price")) || 0,
        };
      })
      .filter((i) => i.part_number || i.description || i.quantity > 0);

    return sendSuccess(res, { items });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
};

/**
 * POST /purchase-orders/import/preview
 * Parses an uploaded Excel/CSV PO file and returns a rich preview payload.
 * Expected columns: Brand, CODE (part number), Quantity, RATE/MRP, Discount%
 * Response shape (union — satisfies all 3 frontend components):
 *   { items, line_items, item_count, summary: { mrp_total, final_amount, discount_percent }, warnings }
 */
exports.importPreview = async (req, res) => {
  if (!req.file) return sendError(res, "No file uploaded", 400);
  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    const warnings = [];

    const line_items = rows
      .map((row, idx) => {
        // Normalise keys: lowercase, strip non-alphanumeric
        const nr = {};
        Object.keys(row).forEach((k) => { nr[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = row[k]; });
        const gv = (...keys) => {
          for (const key of keys) {
            const nk = key.toLowerCase().replace(/[^a-z0-9]/g, "");
            if (nr[nk] !== undefined && nr[nk] !== "") return nr[nk];
          }
          return "";
        };

        const brand       = String(gv("Brand", "brand") || "").trim();
        const part_number = String(gv("CODE", "code", "Part Number", "Part No", "PartNo", "partnumber") || "").trim();
        const description = String(gv("Description", "Desc", "desc") || "").trim();
        const qty_ordered = safeParseFloat(gv("Quantity", "Qty", "qty", "quantity"));
        const mrp         = safeParseFloat(gv("RATE/MRP", "MRP", "mrp", "Rate", "rate", "Price", "price"));
        const discount_percent = safeParseFloat(gv("Discount%", "Discount", "discount", "disc"));

        if (!part_number && !description) {
          warnings.push(`Row ${idx + 2}: missing part number/code — skipped`);
          return null;
        }
        if (qty_ordered <= 0) {
          warnings.push(`Row ${idx + 2} (${part_number || description}): quantity is 0 or missing`);
        }

        const discount_amount = mrp * (discount_percent / 100) * qty_ordered;
        const line_total = mrp * qty_ordered - discount_amount;

        return {
          brand,
          part_number,
          description,
          qty_ordered,
          mrp,
          discount_percent,
          discount_amount,
          line_total,
          // Legacy flat fields for ExcelImportBanner/uploadExcel compat
          quantity:    qty_ordered,
          rate:        mrp,
        };
      })
      .filter(Boolean);

    const mrp_total    = line_items.reduce((s, i) => s + i.mrp * i.qty_ordered, 0);
    const final_amount = line_items.reduce((s, i) => s + i.line_total, 0);
    const overall_discount_percent = mrp_total > 0
      ? Math.round(((mrp_total - final_amount) / mrp_total) * 10000) / 100
      : 0;

    // `items` key mirrors the old uploadExcel shape so ExcelImportBanner still works
    const items = line_items.map((i) => ({
      brand:       i.brand,
      part_number: i.part_number,
      description: i.description,
      quantity:    i.qty_ordered,
      rate:        i.mrp,
    }));

    return sendSuccess(res, {
      item_count: line_items.length,
      line_items,
      items,
      summary: {
        mrp_total,
        final_amount,
        discount_percent: overall_discount_percent,
      },
      warnings,
    });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
};
