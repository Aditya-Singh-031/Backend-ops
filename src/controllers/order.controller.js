const xlsx = require("xlsx");
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

async function generateOrderNumber(db) {
  const year = new Date().getFullYear();
  const prefix = `ORD-${year}-`;
  const latest = await db
    .collection("orders")
    .find({ order_number: { $regex: `^${prefix}` } })
    .sort({ order_number: -1 })
    .limit(1)
    .toArray();

  let nextNum = 1;
  if (latest.length > 0) {
    const lastNum = parseInt(latest[0].order_number.replace(prefix, ""), 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, "0")}`;
}

function generatePIExcel(order, orderDetail) {
  const wb = xlsx.utils.book_new();
  const items = (orderDetail?.items || []).map((item, idx) => ({
    "Sr No": idx + 1,
    Brand: item.brand || "",
    "Part Number": item.part_number || "",
    Description: item.description || "",
    Quantity: item.quantity || 0,
    Rate: item.rate || 0,
    Amount: (item.quantity || 0) * (item.rate || 0),
  }));

  const ws = xlsx.utils.json_to_sheet(items);
  ws["!cols"] = [{ wch: 6 }, { wch: 12 }, { wch: 18 }, { wch: 30 }, { wch: 10 }, { wch: 10 }, { wch: 12 }];
  xlsx.utils.book_append_sheet(wb, ws, "Items");

  const headerInfo = [
    { Field: "Order Number", Value: order.order_number || "" },
    { Field: "PI Number", Value: order.pi_number || "" },
    { Field: "PI Date", Value: order.pi_date ? new Date(order.pi_date).toISOString().split("T")[0] : "" },
    { Field: "Status", Value: order.status || "" },
    { Field: "Currency", Value: order.currency || "" },
    { Field: "Subtotal", Value: order.subtotal || 0 },
    { Field: "Grand Total", Value: order.grand_total || 0 },
    { Field: "Payment Terms", Value: order.payment_terms || "" },
    { Field: "Delivery Terms", Value: order.delivery_terms || "" },
  ];
  const ws2 = xlsx.utils.json_to_sheet(headerInfo);
  xlsx.utils.book_append_sheet(wb, ws2, "Order Info");
  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
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

exports.create = async (req, res) => {
  const db = await getDb();
  const body = req.body;
  const order_number = await generateOrderNumber(db);

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
    pi_number: body.pi_number || "",
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
  const now = new Date();
  await db.collection("orders").updateOne({ _id: oid }, { $set: { is_deleted: true, updated_at: now } });
  await db.collection("order_details").updateMany({ order_id: oid }, { $set: { is_deleted: true, updated_at: now } });
  return sendSuccess(res, { message: "Order deleted" });
};

exports.downloadExcel = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const order = await db.collection("orders").findOne({ _id: oid });
  if (!order) return sendError(res, "Order not found", 404);

  const orderDetail = await db.collection("order_details").findOne({ order_id: oid, is_deleted: { $ne: true } });
  const buffer = generatePIExcel(order, orderDetail);

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
