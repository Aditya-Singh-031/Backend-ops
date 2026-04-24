const xlsx = require("xlsx");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");
const {
  safeParseFloat,
  toBoolean,
  parseDateOnly,
  sanitizeFilename,
  normalizeHeaderKey,
  hasValue,
} = require("../utils/helpers");
const {
  generateWordInvoice,
  generateTaxInvoiceWord,
} = require("../services/wordGenerator");
const { generateDocument } = require("../services/documentService");

const libre = require("libreoffice-convert");
const convertAsync = (buffer, format, filter) =>
  new Promise((resolve, reject) => {
    libre.convert(buffer, format, filter, (err, done) => {
      if (err) reject(err);
      else resolve(done);
    });
  });

exports.list = async (req, res) => {
  const db = await getDb();
  const query = {};

  if (req.query.dateFrom || req.query.dateTo) {
    query.invoice_date = {};
    if (req.query.dateFrom) query.invoice_date.$gte = parseDateOnly(req.query.dateFrom);
    if (req.query.dateTo) {
      const to = parseDateOnly(req.query.dateTo);
      to.setHours(23, 59, 59, 999);
      query.invoice_date.$lte = to;
    }
  }

  let sortObj = { created_at: -1 };
  const sortBy = req.query.sortBy;
  const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
  if (sortBy === "date" || sortBy === "invoice_date") sortObj = { invoice_date: sortOrder };
  else if (sortBy === "created_at") sortObj = { created_at: sortOrder };
  else if (sortBy === "invoice_number") sortObj = { invoice_number: sortOrder };

  let shipments = await db.collection("shipments").find(query).sort(sortObj).limit(100).toArray();

  const buyerIds = [...new Set(shipments.map((s) => s.buyer_id).filter(Boolean))];
  const buyerOids = buyerIds.map((id) => toObjectId(id)).filter(Boolean);
  const buyers = buyerOids.length > 0
    ? await db.collection("buyers").find({ _id: { $in: buyerOids } }).toArray()
    : [];
  const buyerMap = {};
  buyers.forEach((b) => (buyerMap[b._id.toString()] = { ...b, name: b.cust_name || b.name }));

  const shipmentIds = shipments.map((s) => s._id);
  const qtAgg = await db
    .collection("shipment_details")
    .aggregate([
      { $match: { shipment_id: { $in: shipmentIds } } },
      { $group: { _id: "$shipment_id", totalQty: { $sum: "$quantity" } } },
    ])
    .toArray();
  const qtyLookup = {};
  qtAgg.forEach((q) => (qtyLookup[q._id.toString()] = q.totalQty));

  shipments.forEach((s) => {
    s.totalQuantity = qtyLookup[s._id.toString()] || s.package_count || 0;
    const bid = s.buyer_id?.toString();
    if (bid && buyerMap[bid]) s.buyer_id = { _id: buyerMap[bid]._id, name: buyerMap[bid].name };
  });

  if (sortBy === "quantity") shipments.sort((a, b) => (a.totalQuantity - b.totalQuantity) * sortOrder);
  if (req.query.quantityMin || req.query.quantityMax) {
    const min = parseFloat(req.query.quantityMin) || 0;
    const max = parseFloat(req.query.quantityMax) || Infinity;
    shipments = shipments.filter((s) => s.totalQuantity >= min && s.totalQuantity <= max);
  }

  return sendSuccess(res, shipments);
};

exports.getById = async (req, res) => {
  const db = await getDb();
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const shipment = await db.collection("shipments").findOne({ _id: oid });
  if (!shipment) return sendError(res, "Not Found", 404);

  if (shipment.buyer_id) {
    const buyer = await db.collection("buyers").findOne({ _id: toObjectId(shipment.buyer_id) });
    if (buyer) { buyer.name = buyer.cust_name || buyer.name; shipment.buyer_id = buyer; }
  }
  if (shipment.consignee_id) {
    const consignee = await db.collection("buyers").findOne({ _id: toObjectId(shipment.consignee_id) });
    if (consignee) { consignee.name = consignee.cust_name || consignee.name; shipment.consignee_id = consignee; }
  }

  const details = await db.collection("shipment_details").find({ shipment_id: oid }).toArray();
  return sendSuccess(res, { shipment, details });
};

exports.quickCreate = async (req, res) => {
  const db = await getDb();
  const body = req.body;

  const doc = {
    buyer_id: body.buyer_id ? toObjectId(body.buyer_id) : null,
    consignee_id: body.consignee_id ? toObjectId(body.consignee_id) : (body.buyer_id ? toObjectId(body.buyer_id) : null),
    cha_details: body.cha_details || "",
    invoice_number: body.invoice_number,
    invoice_date: parseDateOnly(body.invoice_date) || new Date(),
    dispatch_location: body.dispatch_location || "MUMBAI",
    pre_carriage: body.pre_carriage || "By Road",
    receipt_place: body.receipt_place || "Nhava Sheva Mumbai",
    loading_port: body.loading_port || "Nhava Sheva, India",
    discharge_port: body.discharge_port || "",
    delivery_terms: body.delivery_terms || "FOB",
    payment_terms: body.payment_terms || "",
    package_count: safeParseFloat(body.package_count) || 0,
    net_weight_kg: safeParseFloat(body.net_weight_kg) || 0,
    gross_weight_kg: safeParseFloat(body.gross_weight_kg) || 0,
    currency: body.currency || "USD",
    exchange_rate: safeParseFloat(body.exchange_rate) || 1,
    freight_cost: safeParseFloat(body.freight_cost) || 0,
    insurance_cost: safeParseFloat(body.insurance_cost) || 0,
    is_freight_in_split: body.is_freight_in_split || false,
    status: "Draft",
    created_at: new Date(),
    updated_at: new Date(),
  };

  const result = await db.collection("shipments").insertOne(doc);
  doc._id = result.insertedId;

  if (doc.buyer_id) {
    const buyer = await db.collection("buyers").findOne({ _id: doc.buyer_id });
    if (buyer) doc.buyer_name = buyer.name || buyer.cust_name || "";
  }
  return sendSuccess(res, doc, 201);
};

exports.save = async (req, res) => {
  const db = await getDb();
  const body = req.body;
  const shipmentId = body._id ? toObjectId(body._id) : null;
  const rawInvoiceDate = parseDateOnly(body.invoiceDate);
  const deliveryTerms = body.termsOfDelivery || "FOB";

  const shipmentData = {
    invoice_number: body.invoiceNumber,
    invoice_date: rawInvoiceDate,
    buyer_id: body.buyer?._id ? toObjectId(body.buyer._id) : toObjectId(body.buyer),
    consignee_id: body.consignee?._id ? toObjectId(body.consignee._id) : toObjectId(body.consignee),
    cha_details: body.chaAgent || "",
    replacement_to: body.replacementTo || "",
    dispatch_location: body.dispatchLocation,
    pre_carriage: body.preCarriageBy,
    receipt_place: body.placeOfReceipt,
    loading_port: body.portOfLoading,
    discharge_port: body.portOfDischarge,
    delivery_terms: deliveryTerms,
    payment_terms: body.termsOfPayment,
    package_count: safeParseFloat(body.numberOfPackages),
    net_weight_kg: safeParseFloat(body.totalNetWeight),
    gross_weight_kg: safeParseFloat(body.totalGrossWeight),
    freight_cost: safeParseFloat(body.freightCharges),
    insurance_cost: safeParseFloat(body.insuranceCharges),
    fob_value: safeParseFloat(body.fobValue || body.freightCharges),
    is_freight_in_split: toBoolean(body.splitFobFreight),
    exchange_rate: safeParseFloat(body.exchangeRate) || 86.5,
    currency: body.currencyLabel || "USD",
    status: body.status || "Draft",
    updated_at: new Date(),
  };

  let savedId;
  if (shipmentId) {
    await db.collection("shipments").updateOne({ _id: shipmentId }, { $set: shipmentData });
    await db.collection("shipment_details").deleteMany({ shipment_id: shipmentId });
    savedId = shipmentId;
  } else {
    shipmentData.created_at = new Date();
    const result = await db.collection("shipments").insertOne(shipmentData);
    savedId = result.insertedId;
  }

  if (body.lineItems?.length > 0) {
    const lineItemDocs = body.lineItems.map((item) => ({
      shipment_id: savedId,
      reference_number: item.refNo || "",
      part_number: item.partNo || "",
      description: item.description || "",
      hsn_code: item.hsn || "",
      quantity: safeParseFloat(item.qty),
      unit_price: safeParseFloat(item.rate),
      unit: item.unit || "NOS",
      igst_rate: item.igst || "18",
      created_at: new Date(),
    }));
    await db.collection("shipment_details").insertMany(lineItemDocs);
  }

  return sendSuccess(res, { shipmentId: savedId });
};

exports.uploadExcel = async (req, res) => {
  if (!req.file) return sendError(res, "No file", 400);
  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rowsAsArrays = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    const headerKeywords = [
      "HSN", "HSN CODE", "DESCRIPTION", "DESCRIPTION OF GOODS", "DESC",
      "QTY", "QUANTITY", "RATE", "PRICE", "WITH FOB RATE",
      "PART NO", "PART NUMBER", "REF NO", "REFERENCE",
    ];
    const normalize = (v) => String(v || "").trim().toUpperCase();
    let headerRowIdx = -1;
    let bestScore = 0;
    rowsAsArrays.forEach((row, idx) => {
      const cells = row.map(normalize);
      if (cells.length === 0) return;
      let score = 0;
      headerKeywords.forEach((k) => {
        if (cells.some((c) => c === k || c.includes(k))) score += 1;
      });
      if (score > bestScore) { bestScore = score; headerRowIdx = idx; }
    });
    if (headerRowIdx < 0 || bestScore < 2) headerRowIdx = 0;

    const rawRows = xlsx.utils.sheet_to_json(sheet, { defval: "", range: headerRowIdx });
    let currencyLabel = "USD";
    const headers = Object.keys(rawRows[0] || {});
    const headerText = headers.join(" ").toUpperCase();
    if (headerText.includes("INR") || headerText.includes("₹") || headerText.includes("RS") || headerText.includes("RUPEE")) {
      currencyLabel = "INR";
    }

    if (currencyLabel === "USD") {
      const sampleRows = rawRows.slice(0, 20);
      for (const row of sampleRows) {
        const normalizedRow = {};
        Object.keys(row || {}).forEach((k) => { normalizedRow[normalizeHeaderKey(k)] = row[k]; });
        const currencyValue = normalizedRow.currency || normalizedRow.curr || "";
        const combinedValues = Object.values(row || {}).join(" ").toUpperCase();
        const currencySource = String(currencyValue || combinedValues);
        if (currencySource.includes("INR") || currencySource.includes("₹")) { currencyLabel = "INR"; break; }
        if (currencySource.includes("USD") || currencySource.includes("$")) { currencyLabel = "USD"; break; }
      }
    }

    const items = rawRows
      .map((row) => {
        const normalizedRow = {};
        Object.keys(row || {}).forEach((k) => { normalizedRow[normalizeHeaderKey(k)] = row[k]; });
        const getValue = (...keys) => {
          for (const key of keys) {
            const val = normalizedRow[normalizeHeaderKey(key)];
            if (hasValue(val)) return val;
          }
          return "";
        };
        const desc = getValue("Description", "Description of Goods", "DESC");
        const qty = safeParseFloat(getValue("Qty", "Quantity", "QTY"));
        const rate = safeParseFloat(getValue("WITH FOB RATE", "Rate", "Price", "RATE"));
        return {
          description: desc,
          hsn: getValue("HSN", "HSN Code"),
          qty,
          rate,
          amount: safeParseFloat(getValue("TOTAL", "Amount", "Total Amount")) || qty * rate,
          partNo: getValue("Part number", "Part No"),
          refNo: getValue("Order reference number", "Ref No", "Reference", "Reference No"),
          unit: getValue("Unit", "UOM", "Unit of Measure") || "NOS",
          igst: getValue("IGST Rate", "IGST%", "IGST", "GST Rate", "Tax Rate") || "0",
        };
      })
      .filter((i) => i.description || i.qty > 0);

    return sendSuccess(res, { items, currencyLabel });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
};

exports.downloadSample = (_req, res) => {
  const locations = [
    path.join(__dirname, "../../assets/Sample.xlsx"),
    path.join(__dirname, "../../../Shipment_invoice_generaotr/Sample.xlsx"),
  ];
  for (const loc of locations) {
    if (fs.existsSync(loc)) return res.download(loc, "Import_Template.xlsx");
  }
  return sendError(res, "No sample file", 404);
};

exports.generateWorkingExcel = async (req, res) => {
  const body = req.body;
  const lineItems = body.lineItems || [];
  const splitFobFreight = toBoolean(body.splitFobFreight);
  const freightVal = safeParseFloat(body.freightCharges);
  const insuranceVal = safeParseFloat(body.insuranceCharges);
  let baseTotal = 0;
  lineItems.forEach((item) => { baseTotal += safeParseFloat(item.qty) * safeParseFloat(item.rate); });
  const splitExtraVal = freightVal + insuranceVal;

  const excelRows = lineItems.map((item, idx) => {
    const qty = safeParseFloat(item.qty);
    const rate = safeParseFloat(item.rate);
    const amount = qty * rate;
    let splitRate = rate;
    let splitAmount = amount;
    if (splitFobFreight && baseTotal > 0 && splitExtraVal > 0) {
      const freightShare = (amount / baseTotal) * splitExtraVal;
      splitAmount = amount + freightShare;
      if (qty > 0) splitRate = splitAmount / qty;
    }
    return {
      "Sr No": idx + 1, "Ref No": item.refNo, "Part No": item.partNo,
      Description: item.description, HSN: item.hsn, Qty: qty,
      "Base Rate": rate, "Base Amount": amount,
      "Split Rate": splitRate.toFixed(2), "Split Total": splitAmount.toFixed(2),
    };
  });

  const grandTotal = baseTotal + freightVal + insuranceVal;
  excelRows.push(
    {},
    { Description: "SUBTOTAL", "Split Total": baseTotal.toFixed(2) },
    { Description: "FREIGHT", "Split Total": freightVal.toFixed(2) },
    { Description: "INSURANCE", "Split Total": insuranceVal.toFixed(2) },
    { Description: "GRAND TOTAL", "Split Total": grandTotal.toFixed(2) }
  );

  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(excelRows);
  ws["!cols"] = [{ wch: 5 }, { wch: 15 }, { wch: 15 }, { wch: 30 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
  xlsx.utils.book_append_sheet(wb, ws, "Working File");

  const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Working_File_${sanitizeFilename(body.invoiceNumber)}.xlsx"`);
  return res.send(buffer);
};

exports.generateInvoice = async (req, res) => {
  const body = req.body;
  const downloadVariant = body.downloadVariant || "commercial_invoice";
  const safeInvoiceNo = sanitizeFilename(body.invoiceNumber);
  const CONSTANT_EXPORTER = {
    name: "Morsebiz Technology Services Pvt Ltd",
    address: "20th Floor, Building No/Flat No – CTS No 95 4 B 3&4, 590 Oberoi Garden City, Goregaon East, Mumbai, Mumbai Suburban, Maharashtra 400063",
    gstNo: "27AAPCM5559A1Z9",
    panNo: "",
    iecCode: "",
  };
  const rawInvoiceDate = parseDateOnly(body.invoiceDate);
  const calculatedExpiryDate = new Date(rawInvoiceDate);
  calculatedExpiryDate.setDate(rawInvoiceDate.getDate() + 90);

  let buffer;
  let filename;

  if (downloadVariant === "tax_invoice") {
    const exchangeRate = body.exchangeRate || 86.5;
    const processedItems = body.lineItems.map((item) => ({
      ...item,
      qty: safeParseFloat(item.qty),
      rate: safeParseFloat(item.rate),
    }));
    buffer = await generateTaxInvoiceWord(
      {
        exporter: CONSTANT_EXPORTER, buyer: body.buyer,
        consignee: body.consigneeSameAsBuyer ? body.buyer : body.consignee,
        invoiceNumber: body.invoiceNumber, invoiceDate: rawInvoiceDate,
        invoiceExpiryDate: calculatedExpiryDate,
        termsOfPayment: body.termsOfPayment,
        dispatchLocation: body.dispatchLocation, preCarriageBy: body.preCarriageBy,
        placeOfReceipt: body.placeOfReceipt, portOfLoading: body.portOfLoading,
        portOfDischarge: body.portOfDischarge, termsOfDelivery: body.termsOfDelivery,
        numberOfPackages: body.numberOfPackages,
        totalNetWeight: body.totalNetWeight, totalGrossWeight: body.totalGrossWeight,
        freightCharges: safeParseFloat(body.freightCharges),
        insuranceCharges: safeParseFloat(body.insuranceCharges),
        currency: body.currencyLabel || "USD",
      },
      processedItems,
      exchangeRate
    );
    filename = `Tax_Invoice_${safeInvoiceNo}.pdf`;
  } else if (["cha_letter", "evd_letter", "non_vintage_letter", "scomet_letter"].includes(downloadVariant)) {
    const chaName = body.chaAgent || "";
    const formattedDate = rawInvoiceDate.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const context = {
      CHA_NAME: chaName, INVOICE_NO: body.invoiceNumber, DATE: formattedDate, INVOICE_DATE: formattedDate,
      cha_name: chaName, invoice_no: body.invoiceNumber, date: formattedDate, invoice_date: formattedDate,
    };
    const templateMap = {
      cha_letter: "CHA letter.docx", evd_letter: "EVD_letter.docx",
      non_vintage_letter: "non_vintage.docx", scomet_letter: "scomet_declaration.docx",
    };
    buffer = await generateDocument(templateMap[downloadVariant], context, "pdf");
    filename = `${downloadVariant}_${safeInvoiceNo}.pdf`;
  } else {
    const processedItems = body.lineItems.map((item, idx) => ({
      description: item.description, hsn: item.hsn,
      qty: safeParseFloat(item.qty), rate: safeParseFloat(item.rate),
      amount: safeParseFloat(item.amount), partNo: item.partNo, refNo: item.refNo, idx,
    }));
    const splitFobFreight = toBoolean(body.splitFobFreight) || body.downloadVariant === "split";
    const invoiceData = {
      exporter: CONSTANT_EXPORTER, buyer: body.buyer,
      consignee: body.consigneeSameAsBuyer ? body.buyer : body.consignee,
      chaAgent: { name: body.chaAgent || "" },
      invoiceNumber: body.invoiceNumber, invoiceDate: rawInvoiceDate,
      invoiceExpiryDate: calculatedExpiryDate,
      termsOfPayment: body.termsOfPayment,
      dispatchLocation: body.dispatchLocation, preCarriageBy: body.preCarriageBy,
      placeOfReceipt: body.placeOfReceipt, portOfLoading: body.portOfLoading,
      portOfDischarge: body.portOfDischarge, termsOfDelivery: body.termsOfDelivery,
      numberOfPackages: body.numberOfPackages,
      totalNetWeight: body.totalNetWeight, totalGrossWeight: body.totalGrossWeight,
      freightCharges: safeParseFloat(body.freightCharges),
      insuranceCharges: safeParseFloat(body.insuranceCharges),
      replacementTo: body.replacementTo || "",
      splitFobFreight,
    };
    buffer = await generateWordInvoice(invoiceData, processedItems, body.currencyLabel || "USD");
    const typeLabel = invoiceData.splitFobFreight ? "Split" : "Commercial";
    filename = `${typeLabel}_Invoice_${safeInvoiceNo}.pdf`;
  }

  const outputFormat = body.outputFormat || "pdf";
  if (outputFormat === "docx") {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(".pdf", ".docx")}"`);
    return res.send(buffer);
  }

  try {
    const pdfBuffer = await convertAsync(buffer, ".pdf", undefined);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(".pdf", ".docx")}"`);
    res.setHeader("X-Output-Format", "docx");
    return res.send(buffer);
  }
};

exports.generateAllLetters = async (req, res) => {
  const body = req.body;
  const safeInvoiceNo = sanitizeFilename(body.invoiceNumber);
  const rawInvoiceDate = parseDateOnly(body.invoiceDate);
  const formattedDate = rawInvoiceDate.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const context = {
    CHA_NAME: body.chaAgent || "", INVOICE_NO: body.invoiceNumber, DATE: formattedDate, INVOICE_DATE: formattedDate,
    cha_name: body.chaAgent || "", invoice_no: body.invoiceNumber, date: formattedDate, invoice_date: formattedDate,
  };

  const letterTypes = [
    { key: "cha_letter", template: "CHA letter.docx", filename: "CHA_Letter" },
    { key: "evd_letter", template: "EVD_letter.docx", filename: "EVD_Letter" },
    { key: "non_vintage_letter", template: "non_vintage.docx", filename: "Non_Vintage" },
    { key: "scomet_letter", template: "scomet_declaration.docx", filename: "SCOMET_Declaration" },
  ];

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="All_Letters_${safeInvoiceNo}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(res);

  for (const letter of letterTypes) {
    try {
      const buf = await generateDocument(letter.template, context, "pdf");
      try {
        const pdfBuffer = await convertAsync(buf, ".pdf", undefined);
        archive.append(pdfBuffer, { name: `${letter.filename}_${safeInvoiceNo}.pdf` });
      } catch {
        archive.append(buf, { name: `${letter.filename}_${safeInvoiceNo}.docx` });
      }
    } catch (err) {
      console.error(`Error generating ${letter.key}:`, err.message);
    }
  }
  archive.finalize();
};

exports.uploadImage = async (req, res) => {
  if (!req.file) return sendError(res, "No image uploaded", 400);
  const { uploadFilePathToAzure } = require("../config/azure");
  try {
    const azureUrl = await uploadFilePathToAzure(req.file.path, req.file.originalname, req.file.mimetype);
    return sendSuccess(res, { url: azureUrl });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
};
