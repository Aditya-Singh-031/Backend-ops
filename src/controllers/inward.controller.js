const { v4: uuidv4 } = require("uuid");
const ExcelJS = require("exceljs");
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

exports.deleteInward = async (req, res) => {
  const inwardId = req.params.id;
  const db = await getDb();

  const inward = await db.collection("inwards").findOne({ inward_id: inwardId });
  if (!inward) {
    return sendError(res, "Inward not found", 404);
  }

  await db.collection("inwards").deleteOne({ inward_id: inwardId });
  await db.collection("inwarddetails").deleteMany({ inward_id: inwardId });

  sendSuccess(res, { message: "Inward deleted successfully" });
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
    .sort({ created_at: -1 })
    .toArray();

  const formattedInvoices = invoices.map(inv => ({
    _id: inv._id,
    invoice_number: inv.invoice_metadata?.invoice_number || inv.invoice_number || inv.invoice_id,
    vendor_name: inv.seller?.name || inv.vendor_name || "Unknown",
    date: inv.invoice_metadata?.invoice_date || inv.invoice_date || inv.date,
    total_amount: inv.totals?.total_parts_amount || 0,
    total_with_gst: inv.totals?.invoice_amount || inv.total_amount || 0,
    created_at: inv.created_at || inv.createdAt
  }));

  sendSuccess(res, formattedInvoices);
};

// ─────────────────────────────────────────────────────────────────────────────
//  EXPORT EXCEL  ─  Styled Packing List (matches the reference image)
//
//  Sheet layout (13 columns  A–M):
//   A  Case No  |  B  PART NO.  |  C  PART DESCRIPTION  |  D  Qty per box
//   E  No of boxes  |  F  PART NET WT (KGS)  |  G  Pallet/Box weight
//   H  TOTAL NET WT (KGS)  |  I  TOTAL GROSS WEIGHT (KGS)
//   J  L  |  K  W  |  L  H  |  M  CBM
// ─────────────────────────────────────────────────────────────────────────────
exports.exportExcel = async (req, res) => {
  const inwardId = req.params.id;
  const db = await getDb();

  // ── 1. Fetch inward record ────────────────────────────────────────────────
  const inward = await db.collection("inwards").findOne({ inward_id: inwardId });
  if (!inward) return sendError(res, "Inward not found", 404);

  // ── 2. Linked invoices ────────────────────────────────────────────────────
  const objectIds = (inward.invoice_ids || []).map((id) => {
    try { return toObjectId(id); } catch { return null; }
  }).filter(Boolean);

  const invoices = objectIds.length > 0
    ? await db.collection("invoices").find({ _id: { $in: objectIds } }).toArray()
    : [];

  const actualInvoiceUUIDs = invoices.map((inv) => inv.invoice_id).filter(Boolean);

  // ── 3. Invoice line items  →  SKU description & part weight lookup ────────
  const lineItems = actualInvoiceUUIDs.length > 0
    ? await db.collection("invoice_line_items").find({ invoice_id: { $in: actualInvoiceUUIDs } }).toArray()
    : [];

  const skuInfoMap = {};
  lineItems.forEach((item) => {
    const sku = item.part_number || item.item_no || item.sku_code;
    if (sku && !skuInfoMap[sku]) {
      skuInfoMap[sku] = {
        description: item.description || item.desc || "",
        part_net_wt: Number(item.part_net_wt || item.net_weight || item.unit_weight || 0),
      };
    }
  });

  // ── 4. Packing list boxes ─────────────────────────────────────────────────
  const boxes = inward.packing_list?.boxes || [];

  // ── 5. Header constants ───────────────────────────────────────────────────
  const SHIPPER_NAME  = "MORSEBIZ TECHNOLOGY SERVICES PRIVATE LIMITED";
  const SHIPPER_GST   = "GST NO: 27AAPCM5559A1Z9";
  const SHIPPER_ADDR  = "20th Floor, Building No/Flat No \u2013 CTS No 95 4 B 3&4, 590 Oberoi Garden City, Goregaon East, Mumbai, Mumbai Suburban, Maharashtra 400063";
  const DISPATCH_FROM = "A/21/1, MIDC Chincholi, Solapur, Maharashtra - 413255";
  const BUYER         = inward.vendor_name || "TO ORDER";

  const invoiceNumber = invoices.map((inv) => inv.invoice_number).filter(Boolean).join(", ") || "";
  const invoiceDate   = (() => {
    const d = new Date(inward.inward_date || inward.createdAt);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  })();

  // ── 6. Build workbook ─────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Packing List");

  ws.columns = [
    { width: 10 }, // A  Case No
    { width: 18 }, // B  PART NO.
    { width: 22 }, // C  PART DESCRIPTION
    { width: 12 }, // D  Qty per box
    { width: 12 }, // E  No of boxes
    { width: 16 }, // F  PART NET WT (KGS)
    { width: 16 }, // G  Pallet/Box weight
    { width: 18 }, // H  TOTAL NET WT (KGS)
    { width: 22 }, // I  TOTAL GROSS WEIGHT (KGS)
    { width: 7  }, // J  L
    { width: 7  }, // K  W
    { width: 7  }, // L  H
    { width: 9  }, // M  CBM
  ];

  // ── Style helpers ────────────────────────────────────────────────────────
  const THIN = { style: "thin" };
  const BD   = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  const GRAY = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };

  const centerMid   = { horizontal: "center",  vertical: "middle", wrapText: true };
  const leftMid     = { horizontal: "left",     vertical: "middle", wrapText: true };

  // Style a cell in one call
  const sc = (row, col, opts = {}) => {
    const c = ws.getCell(row, col);
    if (opts.v !== undefined) c.value = opts.v;
    c.border    = BD;
    c.alignment = opts.left ? leftMid : centerMid;
    if (opts.bold)  c.font = { bold: true, size: opts.size || 10 };
    if (opts.gray)  c.fill = GRAY;
    if (opts.titleSize) { c.font = { bold: true, size: opts.titleSize }; }
    return c;
  };

  // Merge + style top-left cell
  const ms = (r1, c1, r2, c2, opts = {}) => {
    ws.mergeCells(r1, c1, r2, c2);
    return sc(r1, c1, opts);
  };

  // ── ROW 1: TITLE ─────────────────────────────────────────────────────────
  ms(1, 1, 1, 13, { v: "Packing list", titleSize: 13 });
  ws.getRow(1).height = 22;

  // ── ROW 2: SECTION LABELS  ────────────────────────────────────────────────
  ms(2, 1, 2, 2,  { v: "Shipper :",            bold: true });
  ms(2, 3, 2, 4,  { v: "Buyer :",              bold: true });
  ms(2, 5, 2, 8,  { v: "Ship To :",            bold: true });
  sc(2, 9,        { v: "Invoice Number:",       bold: true });
  ms(2, 10, 2, 13,{ v: invoiceNumber });
  ws.getRow(2).height = 18;

  // ── ROW 3: COMPANY / BUYER / SHIP-TO + DATES ──────────────────────────────
  ms(3, 1, 3, 2,  { v: SHIPPER_NAME,           bold: true });
  ms(3, 3, 3, 4,  { v: BUYER });
  ms(3, 5, 3, 8,  { v: "TO ORDER" });
  sc(3, 9,        { v: "Invoice Date:",         bold: true });
  ms(3, 10, 3, 13,{ v: invoiceDate });
  ws.getRow(3).height = 30;

  // ── ROW 4: GST ────────────────────────────────────────────────────────────
  ms(4, 1, 4, 2,  { v: SHIPPER_GST,            bold: true });
  ms(4, 3, 4, 4,  {});
  ms(4, 5, 4, 8,  {});
  ms(4, 9, 4, 13, {});
  ws.getRow(4).height = 16;

  // ── ROW 5: ADDRESSES ──────────────────────────────────────────────────────
  ms(5, 1, 5, 2,  { v: SHIPPER_ADDR,           left: true });
  ms(5, 3, 5, 4,  {});
  ms(5, 5, 5, 8,  {});
  ms(5, 9, 5, 13, {});
  ws.getRow(5).height = 55;

  // ── ROW 6: DISPATCH LABEL ─────────────────────────────────────────────────
  ms(6, 1, 6, 2,  { v: "Dispatch From:",       bold: true });
  ms(6, 3, 6, 4,  {});
  ms(6, 5, 6, 8,  {});
  ms(6, 9, 6, 13, {});
  ws.getRow(6).height = 16;

  // ── ROW 7: DISPATCH ADDRESS ───────────────────────────────────────────────
  ms(7, 1, 7, 2,  { v: DISPATCH_FROM });
  ms(7, 3, 7, 4,  {});
  ms(7, 5, 7, 8,  {});
  ms(7, 9, 7, 13, {});
  ws.getRow(7).height = 22;

  // ── ROW 8: BLANK SPACER ───────────────────────────────────────────────────
  ws.getRow(8).height = 5;

  // ── ROWS 9-10: DOUBLE-ROW COLUMN HEADERS ─────────────────────────────────
  //
  //  Row 9 : [Case No][PART NO.][PART DESCRIPTION]...[TOTAL GROSS WT] | Dimensions (CM) | [CBM]
  //  Row 10:   (merged vertically with row 9 for cols 1-9,13)         |  L  |  W  |  H  |
  //
  // Cols 1-9 and 13 span rows 9-10 (vertical merge).
  // Cols 10-12: row 9 = "Dimensions (CM)", row 10 = L / W / H.

  const doubleHeaders = [
    [1,  "Case No"],
    [2,  "PART NO."],
    [3,  "PART DESCRIPTION"],
    [4,  "Qty per box"],
    [5,  "No of boxes"],
    [6,  "PART NET WT\n(KGS)"],
    [7,  "Pallet/Box\nweight"],
    [8,  "TOTAL NET WT\n(KGS)"],
    [9,  "TOTAL GROSS\nWEIGHT (KGS)"],
    [13, "CBM"],
  ];

  doubleHeaders.forEach(([col, text]) => {
    ms(9, col, 10, col, { v: text, bold: true, gray: true });
  });

  // "Dimensions (CM)" super-header in row 9 cols 10-12
  ms(9, 10, 9, 12, { v: "Dimensions (CM)", bold: true, gray: true });

  // L / W / H in row 10
  [["L", 10], ["W", 11], ["H", 12]].forEach(([label, col]) => {
    sc(10, col, { v: label, bold: true, gray: true });
  });

  ws.getRow(9).height  = 22;
  ws.getRow(10).height = 22;

  // ── DATA ROWS ─────────────────────────────────────────────────────────────
  let nextRow      = 11;
  let grandQty     = 0;
  let grandNetWt   = 0;
  let grandGrossWt = 0;
  let grandCBM     = 0;

  boxes.forEach((box) => {
    const caseNo = box.box_number ?? box.box_name ?? "";
    const l = Number(box.length || 0);
    const w = Number(box.width  || 0);
    const h = Number(box.height || 0);
    const cbm = l && w && h
      ? parseFloat((l * w * h / 1_000_000).toFixed(4))
      : 0;

    const items = box.items || [];

    let boxNetWt = 0;
    items.forEach((item) => {
      boxNetWt += Number(item.qty || 0) * Number(skuInfoMap[item.sku]?.part_net_wt || 0);
    });
    boxNetWt = parseFloat(boxNetWt.toFixed(3));
    const palletWt   = 0;
    const boxGrossWt = parseFloat((boxNetWt + palletWt).toFixed(3));

    grandQty     += items.reduce((s, i) => s + Number(i.qty || 0), 0);
    grandNetWt   += boxNetWt;
    grandGrossWt += boxGrossWt;
    grandCBM     += cbm;

    const firstRow = nextRow;

    items.forEach((item, idx) => {
      const info   = skuInfoMap[item.sku] || {};
      const qty    = Number(item.qty || 0);
      const partWt = Number(info.part_net_wt || 0);
      const rn     = nextRow;

      // Helper: set value + border + alignment for this data row
      const cell = (col, val, opts = {}) => {
        const c = ws.getCell(rn, col);
        c.value  = val;
        c.border = BD;
        c.alignment = opts.left
          ? { horizontal: "left",   vertical: "middle" }
          : { horizontal: "center", vertical: "middle" };
        if (opts.bold) c.font = { bold: true };
      };

      // Col 1: Case No (set on first item only — merged later for multi-item boxes)
      if (idx === 0)  cell(1, caseNo);
      else            { ws.getCell(rn, 1).border = BD; }

      cell(2,  item.sku || "");
      cell(3,  info.description || "", { left: true });
      cell(4,  qty  || "");
      cell(5,  1);
      cell(6,  partWt || "");

      // Box-level columns — only set on first item row; merged later
      if (idx === 0) {
        cell(7,  palletWt);
        cell(8,  boxNetWt  || "");
        cell(9,  boxGrossWt || "");
        cell(10, l || "");
        cell(11, w || "");
        cell(12, h || "");
        cell(13, cbm || "");
      } else {
        [7, 8, 9, 10, 11, 12, 13].forEach((c) => { ws.getCell(rn, c).border = BD; });
      }

      ws.getRow(rn).height = 16;
      nextRow++;
    });

    // Vertically merge box-level columns across all item rows for this box
    if (items.length > 1) {
      const lastRow = nextRow - 1;
      [1, 7, 8, 9, 10, 11, 12, 13].forEach((col) => {
        ws.mergeCells(firstRow, col, lastRow, col);
        const c = ws.getCell(firstRow, col);
        c.alignment = { horizontal: "center", vertical: "middle" };
        c.border = BD;
      });
    }
  });

  // ── TOTALS ROW ────────────────────────────────────────────────────────────
  const TR = nextRow;
  const totals = {
    1:  boxes.length,
    4:  grandQty,
    8:  parseFloat(grandNetWt.toFixed(3)),
    9:  parseFloat(grandGrossWt.toFixed(3)),
    13: parseFloat(grandCBM.toFixed(4)),
  };
  for (let c = 1; c <= 13; c++) {
    const cell = ws.getCell(TR, c);
    cell.value     = totals[c] ?? "";
    cell.font      = { bold: true };
    cell.border    = BD;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  }
  ws.getRow(TR).height = 18;

  // ── SEND ──────────────────────────────────────────────────────────────────
  const safeId  = inwardId.slice(0, 8);
  const dateStr = new Date().toISOString().slice(0, 10);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="PackingList_${safeId}_${dateStr}.xlsx"`);

  await wb.xlsx.write(res);
  res.end();
};
