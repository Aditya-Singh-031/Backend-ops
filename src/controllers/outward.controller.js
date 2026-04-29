const { v4: uuidv4 } = require("uuid");
const ExcelJS = require("exceljs");
const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");
const aiService = require("../services/ai.service");

exports.list = async (_req, res) => {
  const db = await getDb();
  const outwards = await db.collection("outwards").find().sort({ created_at: -1 }).toArray();
  sendSuccess(res, outwards);
};

exports.getById = async (req, res) => {
  const db = await getDb();
  const outward = await db.collection("outwards").findOne({ outward_id: req.params.id });
  if (!outward) return sendError(res, "Outward not found", 404);
  sendSuccess(res, outward);
};

exports.availableBoxes = async (req, res) => {
  const { exclude_outward_id, include_used } = req.query;
  const db = await getDb();

  const allInwards = await db.collection("inwards").find({ packing_list: { $exists: true, $ne: null } }).toArray();
  const existingOutwards = await db.collection("outwards").find({}).toArray();

  // Map: boxId → outward_id (which outward uses this box)
  const usedBoxMap = {};
  existingOutwards.forEach((outward) => {
    if (exclude_outward_id && outward.outward_id === exclude_outward_id) return;
    (outward.boxes || []).forEach((box) => {
      usedBoxMap[box.box_id] = outward.outward_id;
    });
  });

  const resultBoxes = [];
  allInwards.forEach((inward) => {
    const boxes = inward.packing_list?.boxes || [];
    boxes.forEach((box, idx) => {
      const boxId = `${inward.inward_id}-BOX-${box.box_number || idx + 1}`;
      const usedBy = usedBoxMap[boxId];
      const isUsed = !!usedBy;

      // Skip used boxes unless include_used=true
      if (isUsed && include_used !== "true") return;

      resultBoxes.push({
        box_id: boxId,
        box_number: box.box_number || idx + 1,
        inward_id: inward.inward_id,
        items: box.items || [],
        sku_code: box.items?.map((i) => i.sku).join(", ") || "",
        qty_in_box: box.items?.reduce((sum, i) => sum + (i.qty || 0), 0) || 0,
        length: box.length || "",
        width: box.width || "",
        height: box.height || "",
        inward_status: inward.status,
        is_used: isUsed,
        used_by_outward: usedBy || null,
      });
    });
  });

  sendSuccess(res, resultBoxes);
};

exports.create = async (req, res) => {
  const { shipment_id, selected_box_ids, total_weight, notes, created_by } = req.body;
  const db = await getDb();

  const shipment = await db.collection("shipments").findOne({ _id: toObjectId(shipment_id) });
  if (!shipment) return sendError(res, "Shipment not found", 404);

  const allInwards = await db.collection("inwards").find({ packing_list: { $exists: true, $ne: null } }).toArray();

  const outwardBoxes = [];
  (selected_box_ids || []).forEach((boxId) => {
    if (req.body.custom_boxes && req.body.custom_boxes.some(cb => cb.box_id === boxId)) {
      return; // Handled below
    }
    for (const inward of allInwards) {
      const boxes = inward.packing_list?.boxes || [];
      for (let idx = 0; idx < boxes.length; idx++) {
        const box = boxes[idx];
        const generatedBoxId = `${inward.inward_id}-BOX-${box.box_number || idx + 1}`;
        if (generatedBoxId === boxId) {
          outwardBoxes.push({
            box_id: boxId, inward_id: inward.inward_id,
            box_number: box.box_number || idx + 1, items: box.items || [],
            sku_code: box.items?.map((i) => i.sku).join(", ") || "",
            qty_in_box: box.items?.reduce((sum, i) => sum + (i.qty || 0), 0) || 0,
            length: box.length || "", width: box.width || "", height: box.height || "",
            damaged_in_transit: false, transit_damage_img: "", comments: "",
          });
          return;
        }
      }
    }
  });

  if (req.body.custom_boxes && req.body.custom_boxes.length > 0) {
    req.body.custom_boxes.forEach(cb => {
      const sku_code = cb.items?.map((i) => i.sku).join(", ") || "";
      const qty_in_box = cb.items?.reduce((sum, i) => sum + (i.qty || 0), 0) || 0;
      
      outwardBoxes.push({
        box_id: cb.box_id,
        inward_id: cb.inward_id || "CUSTOM",
        box_number: cb.box_number || "CUST-1",
        items: cb.items || [],
        sku_code,
        qty_in_box,
        length: cb.length || "",
        width: cb.width || "",
        height: cb.height || "",
        damaged_in_transit: cb.damaged_in_transit || false,
        transit_damage_img: cb.transit_damage_img || "",
        comments: cb.comments || ""
      });
    });
  }

  const newOutward = {
    outward_id: `OUT-${uuidv4().slice(0, 8).toUpperCase()}`,
    shipment_id, created_by: created_by || "system",
    outward_date: new Date(), status: "Planned",
    boxes: outwardBoxes, total_boxes: outwardBoxes.length,
    total_weight: total_weight || "", notes: notes || "",
    created_at: new Date(), updated_at: new Date(),
  };

  await db.collection("outwards").insertOne(newOutward);

  if (shipment.status === "Draft") {
    await db.collection("shipments").updateOne({ _id: toObjectId(shipment_id) }, { $set: { status: "In Transit" } });
  }

  sendSuccess(res, newOutward, 201);
};

exports.update = async (req, res) => {
  const { id } = req.params;
  const { selected_box_ids, shipment_id, notes, status } = req.body;
  const db = await getDb();

  const outward = await db.collection("outwards").findOne({ outward_id: id });
  if (!outward) return sendError(res, "Outward not found", 404);

  const update = { updated_at: new Date() };

  if (shipment_id && shipment_id !== outward.shipment_id) {
    const shipment = await db.collection("shipments").findOne({ _id: toObjectId(shipment_id) });
    if (!shipment) return sendError(res, "Shipment not found", 404);
    update.shipment_id = shipment_id;
  }

  if (selected_box_ids && Array.isArray(selected_box_ids)) {
    const allInwards = await db.collection("inwards").find({ packing_list: { $exists: true, $ne: null } }).toArray();
    const newBoxes = [];
    selected_box_ids.forEach((boxId) => {
      if (req.body.custom_boxes && req.body.custom_boxes.some(cb => cb.box_id === boxId)) {
        return; // Handled below
      }

      const existing = (outward.boxes || []).find((b) => b.box_id === boxId);
      if (existing) { newBoxes.push(existing); return; }
      for (const inward of allInwards) {
        const boxes = inward.packing_list?.boxes || [];
        for (let idx = 0; idx < boxes.length; idx++) {
          const box = boxes[idx];
          const generatedBoxId = `${inward.inward_id}-BOX-${box.box_number || idx + 1}`;
          if (generatedBoxId === boxId) {
            newBoxes.push({
              box_id: boxId, inward_id: inward.inward_id,
              box_number: box.box_number || idx + 1, items: box.items || [],
              sku_code: box.items?.map((i) => i.sku).join(", ") || "",
              qty_in_box: box.items?.reduce((sum, i) => sum + (i.qty || 0), 0) || 0,
              length: box.length || "", width: box.width || "", height: box.height || "",
              damaged_in_transit: false, transit_damage_img: "", comments: "",
            });
            return;
          }
        }
      }
    });

    if (req.body.custom_boxes && req.body.custom_boxes.length > 0) {
      req.body.custom_boxes.forEach(cb => {
        const sku_code = cb.items?.map((i) => i.sku).join(", ") || "";
        const qty_in_box = cb.items?.reduce((sum, i) => sum + (i.qty || 0), 0) || 0;
        
        newBoxes.push({
          box_id: cb.box_id,
          inward_id: cb.inward_id || "CUSTOM",
          box_number: cb.box_number || "CUST-1",
          items: cb.items || [],
          sku_code,
          qty_in_box,
          length: cb.length || "",
          width: cb.width || "",
          height: cb.height || "",
          damaged_in_transit: cb.damaged_in_transit || false,
          transit_damage_img: cb.transit_damage_img || "",
          comments: cb.comments || ""
        });
      });
    }

    update.boxes = newBoxes;
    update.total_boxes = newBoxes.length;
  }

  if (notes !== undefined) update.notes = notes;
  if (status) update.status = status;

  // Support linked_order_id — accepts null to unlink
  if (Object.prototype.hasOwnProperty.call(req.body, "linked_order_id")) {
    update.linked_order_id = req.body.linked_order_id
      ? toObjectId(req.body.linked_order_id)
      : null;
  }

  await db.collection("outwards").updateOne({ outward_id: id }, { $set: update });
  const updated = await db.collection("outwards").findOne({ outward_id: id });
  sendSuccess(res, updated);
};

exports.updateBox = async (req, res) => {
  const { id, boxId } = req.params;
  const { damaged_in_transit, transit_damage_img, comments } = req.body;
  const db = await getDb();

  const outward = await db.collection("outwards").findOne({ outward_id: id });
  if (!outward) return sendError(res, "Outward not found", 404);

  const boxes = outward.boxes || [];
  const boxIndex = boxes.findIndex((b) => b.box_id === boxId);
  if (boxIndex === -1) return sendError(res, "Box not found in outward", 404);

  if (damaged_in_transit !== undefined) boxes[boxIndex].damaged_in_transit = damaged_in_transit;
  if (transit_damage_img !== undefined) boxes[boxIndex].transit_damage_img = transit_damage_img;
  if (comments !== undefined) boxes[boxIndex].comments = comments;

  await db.collection("outwards").updateOne({ outward_id: id }, { $set: { boxes, updated_at: new Date() } });
  const updated = await db.collection("outwards").findOne({ outward_id: id });
  sendSuccess(res, updated);
};

exports.updateStatus = async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;
  const db = await getDb();

  const updateData = { status, updated_at: new Date() };
  if (notes) updateData.notes = notes;

  await db.collection("outwards").updateOne({ outward_id: id }, { $set: updateData });
  const updated = await db.collection("outwards").findOne({ outward_id: id });
  sendSuccess(res, updated);
};

exports.remove = async (req, res) => {
  const { id } = req.params;
  const db = await getDb();
  
  const outward = await db.collection("outwards").findOne({ outward_id: id });
  if (!outward) return sendError(res, "Outward not found", 404);

  // If there's an associated join, delete it and recalculate orders
  const join = await db.collection("outward_order_joins").findOne({ outward_id: id });
  if (join) {
    const cleanFulfilled = join.fulfilled_items || [];
    const distinctOrderIds = [...new Set(
      cleanFulfilled.map((f) => f.order_id).filter(Boolean)
    )];
    
    await db.collection("outward_order_joins").deleteOne({ _id: join._id });
    
    // Recalculate fulfillment for every distinct order touched by this join
    const { recalculateOrderFulfillment } = require("./outwardJoin.controller");
    for (const oidStr of distinctOrderIds) {
      const orderOid = toObjectId(oidStr);
      if (!orderOid) continue;
      const orderDetail = await db.collection("order_details").findOne({
        order_id: orderOid, is_deleted: { $ne: true }
      });
      if (orderDetail) {
        await recalculateOrderFulfillment(db, orderOid, orderDetail);
      }
    }
  }

  // Finally delete the outward completely
  await db.collection("outwards").deleteOne({ outward_id: id });
  return sendSuccess(res, { message: "Outward deleted successfully" });
};

exports.removeBox = async (req, res) => {
  const { id, boxId } = req.params;
  const db = await getDb();

  const outward = await db.collection("outwards").findOne({ outward_id: id });
  if (!outward) return sendError(res, "Outward not found", 404);

  const filtered = (outward.boxes || []).filter((b) => b.box_id !== boxId);
  await db.collection("outwards").updateOne(
    { outward_id: id },
    { $set: { boxes: filtered, total_boxes: filtered.length, updated_at: new Date() } }
  );

  const updated = await db.collection("outwards").findOne({ outward_id: id });
  sendSuccess(res, updated);
};

exports.getOutwardBuyerOrders = async (req, res) => {
  const { id } = req.params;
  const db = await getDb();

  // Step 1: Fetch the outward record
  const outward = await db.collection("outwards").findOne({ outward_id: id });
  if (!outward) return sendError(res, "Outward not found", 404);

  // Step 2: Fetch the linked shipment to resolve buyer_id
  if (!outward.shipment_id) return sendError(res, "Outward has no linked shipment", 400);
  const shipment = await db.collection("shipments").findOne({ _id: toObjectId(outward.shipment_id) });
  if (!shipment) return sendError(res, "Linked shipment not found", 404);

  // Step 3: Fetch the buyer from the shipment
  const buyerId = shipment.buyer_id;
  if (!buyerId) return sendError(res, "Shipment has no buyer linked", 400);
  const buyer = await db.collection("buyers").findOne({ _id: toObjectId(buyerId) });

  // Step 4: Fetch ALL CONFIRMED orders belonging to this buyer
  const orders = await db
    .collection("orders")
    .find({
      buyer_id: toObjectId(buyerId),
      status: "CONFIRMED",
      is_deleted: { $ne: true },
    })
    .sort({ created_at: -1 })
    .toArray();

  // Step 5: Fetch order_details for all orders
  const orderIds = orders.map((o) => o._id);
  const allDetails = orderIds.length > 0
    ? await db.collection("order_details")
        .find({ order_id: { $in: orderIds }, is_deleted: { $ne: true } })
        .toArray()
    : [];

  const detailsByOrder = {};
  allDetails.forEach((d) => { detailsByOrder[d.order_id.toString()] = d; });

  // Step 6: LIVE fulfillment — per order+part aggregation across ALL joins for this buyer
  // Key: "orderId::partNumber" → total qty fulfilled (excluding current outward)
  const allJoins = await db
    .collection("outward_order_joins")
    .find({ buyer_id: toObjectId(buyerId) })
    .toArray();

  const liveFilledMap = {};  // others (not self)
  const selfFilledMap  = {}; // this outward's existing join

  allJoins.forEach((join) => {
    const isSelf = join.outward_id === id;
    (join.fulfilled_items || []).forEach((fi) => {
      const pn  = (fi.part_number || "").trim();
      const oid = (fi.order_id   || "").toString().trim();
      if (!pn) return;
      const key = oid ? `${oid}::${pn}` : `__no_order__::${pn}`;
      if (isSelf) {
        selfFilledMap[key]  = (selfFilledMap[key]  || 0) + (Number(fi.qty_fulfilled) || 0);
      } else {
        liveFilledMap[key]  = (liveFilledMap[key]  || 0) + (Number(fi.qty_fulfilled) || 0);
      }
    });
  });

  // Step 7: Enrich each order's items with live fill data
  const enrichedOrders = orders.map((o) => {
    const detail = detailsByOrder[o._id.toString()] || null;
    const enrichedItems = (detail?.items || []).map((item) => {
      const pn  = (item.part_number || "").trim();
      const key = `${o._id.toString()}::${pn}`;
      const othersFilled = liveFilledMap[key]  || 0;
      const selfFilled   = selfFilledMap[key]  || 0;
      const totalFilled  = othersFilled + selfFilled;
      const pending      = Math.max(0, (item.quantity || 0) - totalFilled);
      return {
        ...item,
        quantity_filled:  totalFilled,
        others_filled:    othersFilled,  // filled by other outwards for THIS order
        self_filled:      selfFilled,    // this outward's contribution to THIS order
        quantity_pending: pending,
      };
    });
    return {
      ...o,
      order_details: detail ? { ...detail, items: enrichedItems } : null,
    };
  });


  sendSuccess(res, {
    outward,
    shipment: {
      _id: shipment._id,
      invoice_number: shipment.invoice_number,
      buyer_id: buyerId,
    },
    buyer: buyer
      ? {
          _id: buyer._id,
          cust_name: buyer.cust_name || buyer.name || "Unknown",
          currency: buyer.currency || "",
        }
      : null,
    orders: enrichedOrders,
  });
};


exports.buyersList = async (_req, res) => {
  const db = await getDb();
  const buyers = await db.collection("buyers").find({ is_deleted: { $ne: true } }).sort({ cust_name: 1 }).toArray();

  const normalized = buyers.map((b) => ({
    _id: b._id,
    name: b.name || b.cust_name || "Unknown",
    address: typeof b.address === "string" ? b.address
      : b.address?.address_lines ? `${b.address.address_lines}${b.address.country ? ", " + b.address.country : ""}` : "",
    gst_number: b.gst_number || "",
    currency: b.currency || "",
  }));
  sendSuccess(res, normalized);
};

// ─────────────────────────────────────────────────────────────────────────────
//  EXPORT PACKING LIST  ─  Outward packing list with sequential Sr No (1..N)
// ─────────────────────────────────────────────────────────────────────────────
exports.exportPackingList = async (req, res) => {
  const outwardId = req.params.id;
  const db = await getDb();

  const outward = await db.collection("outwards").findOne({ outward_id: outwardId });
  if (!outward) return sendError(res, "Outward not found", 404);

  const boxes = outward.boxes || [];

  // Fetch shipment for invoice number
  let shipment = null;
  if (outward.shipment_id) {
    try { shipment = await db.collection("shipments").findOne({ _id: toObjectId(outward.shipment_id) }); } catch {}
  }

  // Fetch SKU descriptions from invoice_line_items + product_master
  const skuSet = new Set();
  boxes.forEach(box => (box.items || []).forEach(i => { if (i.sku) skuSet.add(i.sku); }));
  const partNumbers = [...skuSet];
  let skuInfoMap = {};
  if (partNumbers.length > 0) {
    // invoice_line_items first
    const lineItems = await db.collection("invoice_line_items")
      .find({ part_number: { $in: partNumbers } })
      .project({ part_number: 1, description: 1, net_weight: 1, part_net_wt: 1, unit_weight: 1, country_of_origin: 1, _id: 0 })
      .toArray();
    lineItems.forEach(li => {
      if (li.part_number && !skuInfoMap[li.part_number]) {
        skuInfoMap[li.part_number] = {
          description: li.description || "",
          part_net_wt: Number(li.part_net_wt || li.net_weight || li.unit_weight || 0),
          country_of_origin: li.country_of_origin || "",
        };
      }
    });
    // product_master fallback for missing net_wt / COO
    const missingWt = partNumbers.filter(pn => !skuInfoMap[pn]?.part_net_wt || !skuInfoMap[pn]?.country_of_origin);
    if (missingWt.length > 0) {
      const pmItems = await db.collection("product_master")
        .find({ part_number: { $in: missingWt }, is_deleted: { $ne: true } })
        .project({ part_number: 1, part_net_wt: 1, country_of_origin: 1, _id: 0 })
        .toArray();
      pmItems.forEach(pm => {
        if (pm.part_number) {
          if (!skuInfoMap[pm.part_number]) skuInfoMap[pm.part_number] = { description: "", part_net_wt: 0, country_of_origin: "" };
          if (!skuInfoMap[pm.part_number].part_net_wt) skuInfoMap[pm.part_number].part_net_wt = Number(pm.part_net_wt || 0);
          if (!skuInfoMap[pm.part_number].country_of_origin) skuInfoMap[pm.part_number].country_of_origin = pm.country_of_origin || "";
        }
      });
    }

    // AI fallback for remaining missing weights / COO
    const stillMissingWt = partNumbers.filter(pn => !skuInfoMap[pn]?.part_net_wt || !skuInfoMap[pn]?.country_of_origin);
    if (stillMissingWt.length > 0) {
      const aiResults = await aiService.fetchPartsInfoAI(stillMissingWt);
      for (const res of aiResults) {
        const pn = res.part_number;
        if (!pn) continue;
        if (!skuInfoMap[pn]) skuInfoMap[pn] = { description: "", part_net_wt: 0, country_of_origin: "" };
        if (!skuInfoMap[pn].part_net_wt && res.part_net_wt) skuInfoMap[pn].part_net_wt = Number(res.part_net_wt);
        if (!skuInfoMap[pn].country_of_origin && res.country_of_origin) skuInfoMap[pn].country_of_origin = res.country_of_origin;

        // Persist AI findings into product_master
        const updateSet = { updated_at: new Date() };
        if (res.part_net_wt) updateSet.part_net_wt = Number(res.part_net_wt);
        if (res.country_of_origin) updateSet.country_of_origin = res.country_of_origin;
        if (Object.keys(updateSet).length > 1) {
          await db.collection("product_master").updateOne(
            { part_number: pn },
            { $set: updateSet, $setOnInsert: { part_number: pn, is_deleted: false, created_at: new Date() } },
            { upsert: true }
          );
        }
      }
    }
  }

  // ── Build workbook ───────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Packing List");

  // Column widths (A–M = 13 cols)
  ws.columns = [
    { width: 10 }, // A  Sr No
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

  const THIN = { style: "thin" };
  const BD   = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  const GRAY = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
  const centerMid = { horizontal: "center", vertical: "middle", wrapText: true };
  const leftMid   = { horizontal: "left",   vertical: "middle", wrapText: true };

  const sc = (row, col, opts = {}) => {
    const c = ws.getCell(row, col);
    if (opts.v !== undefined) c.value = opts.v;
    c.border    = BD;
    c.alignment = opts.left ? leftMid : centerMid;
    if (opts.bold) c.font = { bold: true, size: opts.size || 10 };
    if (opts.gray) c.fill = GRAY;
    if (opts.titleSize) c.font = { bold: true, size: opts.titleSize };
    return c;
  };
  const ms = (r1, c1, r2, c2, opts = {}) => { ws.mergeCells(r1, c1, r2, c2); return sc(r1, c1, opts); };

  const invoiceNumber = shipment?.invoice_number || outwardId;
  const invoiceDate = (() => {
    const d = new Date(outward.outward_date || outward.created_at);
    return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
  })();

  const SHIPPER_NAME  = "MORSEBIZ TECHNOLOGY SERVICES PRIVATE LIMITED";
  const SHIPPER_GST   = "GST NO: 27AAPCM5559A1Z9";
  const SHIPPER_ADDR  = "20th Floor, Building No/Flat No – CTS No 95 4 B 3&4, 590 Oberoi Garden City, Goregaon East, Mumbai, Mumbai Suburban, Maharashtra 400063";
  const DISPATCH_FROM = "A/21/1, MIDC Chincholi, Solapur, Maharashtra - 413255";

  // ROW 1: title
  ms(1, 1, 1, 13, { v: "Packing list", titleSize: 13 }); ws.getRow(1).height = 22;
  // ROW 2
  ms(2, 1, 2, 2,  { v: "Shipper :", bold: true });
  ms(2, 3, 2, 4,  { v: "Buyer :",   bold: true });
  ms(2, 5, 2, 8,  { v: "Ship To :", bold: true });
  sc(2, 9,        { v: "Invoice Number:", bold: true });
  ms(2, 10, 2, 13,{ v: invoiceNumber }); ws.getRow(2).height = 18;
  // ROW 3
  ms(3, 1, 3, 2,  { v: SHIPPER_NAME, bold: true });
  ms(3, 3, 3, 4,  { v: "TO ORDER" });
  ms(3, 5, 3, 8,  { v: "TO ORDER" });
  sc(3, 9,        { v: "Invoice Date:", bold: true });
  ms(3, 10, 3, 13,{ v: invoiceDate }); ws.getRow(3).height = 30;
  // ROW 4
  ms(4, 1, 4, 2,  { v: SHIPPER_GST, bold: true }); ms(4, 3, 4, 4, {}); ms(4, 5, 4, 8, {}); ms(4, 9, 4, 13, {}); ws.getRow(4).height = 16;
  // ROW 5
  ms(5, 1, 5, 2,  { v: SHIPPER_ADDR, left: true }); ms(5, 3, 5, 4, {}); ms(5, 5, 5, 8, {}); ms(5, 9, 5, 13, {}); ws.getRow(5).height = 55;
  // ROW 6
  ms(6, 1, 6, 2,  { v: "Dispatch From:", bold: true }); ms(6, 3, 6, 4, {}); ms(6, 5, 6, 8, {}); ms(6, 9, 6, 13, {}); ws.getRow(6).height = 16;
  // ROW 7
  ms(7, 1, 7, 2,  { v: DISPATCH_FROM }); ms(7, 3, 7, 4, {}); ms(7, 5, 7, 8, {}); ms(7, 9, 7, 13, {}); ws.getRow(7).height = 22;
  // ROW 8 spacer
  ws.getRow(8).height = 5;

  // ROWS 9-10: column headers
  const doubleHeaders = [
    [1, "Sr No"],
    [2, "PART NO."],
    [3, "PART DESCRIPTION"],
    [4, "Qty per box"],
    [5, "No of boxes"],
    [6, "PART NET WT\n(KGS)"],
    [7, "Pallet/Box\nweight"],
    [8, "TOTAL NET WT\n(KGS)"],
    [9, "TOTAL GROSS\nWEIGHT (KGS)"],
    [13, "CBM"],
  ];
  doubleHeaders.forEach(([col, text]) => ms(9, col, 10, col, { v: text, bold: true, gray: true }));
  ms(9, 10, 9, 12, { v: "Dimensions (CM)", bold: true, gray: true });
  [["L", 10], ["W", 11], ["H", 12]].forEach(([label, col]) => sc(10, col, { v: label, bold: true, gray: true }));
  ws.getRow(9).height = 22;
  ws.getRow(10).height = 22;

  // DATA ROWS — sequential Sr No 1..N
  let nextRow = 11;
  let grandQty = 0, grandNetWt = 0, grandGrossWt = 0, grandCBM = 0;
  let srNo = 0; // sequential counter for all boxes

  boxes.forEach((box) => {
    srNo++;
    const l = Number(box.length || 0);
    const w = Number(box.width  || 0);
    const h = Number(box.height || 0);
    const cbm = (l && w && h) ? parseFloat((l * w * h / 1_000_000).toFixed(4)) : 0;
    const items = box.items || [];

    let boxNetWt = 0;
    items.forEach(item => { boxNetWt += Number(item.qty || 0) * Number(skuInfoMap[item.sku]?.part_net_wt || 0); });
    boxNetWt = parseFloat(boxNetWt.toFixed(3));
    const boxGrossWt = parseFloat((boxNetWt * 1.1).toFixed(3));

    grandQty     += items.reduce((s, i) => s + Number(i.qty || 0), 0);
    grandNetWt   += boxNetWt;
    grandGrossWt += boxGrossWt;
    grandCBM     += cbm;

    const firstRow = nextRow;

    if (items.length === 0) {
      // Box with no items — write a single blank row
      const rn = nextRow;
      const cell = (col, val, opts = {}) => {
        const c = ws.getCell(rn, col);
        c.value = val; c.border = BD;
        c.alignment = opts.left ? { horizontal: "left", vertical: "middle" } : { horizontal: "center", vertical: "middle" };
        if (opts.bold) c.font = { bold: true };
      };
      cell(1, srNo); cell(2, ""); cell(3, ""); cell(4, ""); cell(5, 1);
      cell(6, ""); cell(7, 0); cell(8, boxNetWt || ""); cell(9, boxGrossWt || "");
      cell(10, l || ""); cell(11, w || ""); cell(12, h || ""); cell(13, cbm || "");
      ws.getRow(rn).height = 16;
      nextRow++;
    } else {
      items.forEach((item, idx) => {
        const info   = skuInfoMap[item.sku] || {};
        const qty    = Number(item.qty || 0);
        const partWt = Number(info.part_net_wt || 0);
        const rn     = nextRow;

        const cell = (col, val, opts = {}) => {
          const c = ws.getCell(rn, col);
          c.value = val; c.border = BD;
          c.alignment = opts.left ? { horizontal: "left", vertical: "middle" } : { horizontal: "center", vertical: "middle" };
          if (opts.bold) c.font = { bold: true };
        };

        if (idx === 0) cell(1, srNo);
        else ws.getCell(rn, 1).border = BD;

        cell(2, item.sku || "");
        cell(3, info.description || "", { left: true });
        cell(4, qty || "");
        cell(5, 1);
        cell(6, partWt || "");

        if (idx === 0) {
          cell(7, 0); cell(8, boxNetWt || ""); cell(9, boxGrossWt || "");
          cell(10, l || ""); cell(11, w || ""); cell(12, h || ""); cell(13, cbm || "");
        } else {
          [7, 8, 9, 10, 11, 12, 13].forEach(c => { ws.getCell(rn, c).border = BD; });
        }

        ws.getRow(rn).height = 16;
        nextRow++;
      });

      // Merge box-level columns for multi-item boxes
      if (items.length > 1) {
        const lastRow = nextRow - 1;
        [1, 7, 8, 9, 10, 11, 12, 13].forEach(col => {
          ws.mergeCells(firstRow, col, lastRow, col);
          const c = ws.getCell(firstRow, col);
          c.alignment = { horizontal: "center", vertical: "middle" };
          c.border = BD;
        });
      }
    }
  });

  // TOTALS ROW
  const TR = nextRow;
  const finalNetWt   = parseFloat(grandNetWt.toFixed(3));
  const finalGrossWt = parseFloat((finalNetWt * 1.1).toFixed(3));
  const totals = {
    1: boxes.length,
    4: grandQty,
    8: finalNetWt,
    9: finalGrossWt,
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

  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="PackingList_${outwardId}_${dateStr}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
};

// ─────────────────────────────────────────────────────────────────────────────
//  EXPORT JOIN ORDER  ─  Enriched Excel dump with PI number, HSN code,
//  part net weight, country of origin, and auto-filled description
// ─────────────────────────────────────────────────────────────────────────────
exports.exportJoin = async (req, res) => {
  const outwardId = req.params.id;
  const db = await getDb();

  const outward = await db.collection("outwards").findOne({ outward_id: outwardId });
  if (!outward) return sendError(res, "Outward not found", 404);

  const join = await db.collection("outward_order_joins").findOne({ outward_id: outwardId });
  if (!join) return sendError(res, "No join order found for this outward", 404);

  const fulfilled = join.fulfilled_items || [];

  // ── 1. Gather part numbers for enrichment lookups ──────────────────────────
  const partNumbers = [...new Set(fulfilled.map(fi => (fi.part_number || "").trim()).filter(Boolean))];

  // ── 2. HSN code, description, net_wt, COO from invoice_line_items ─────────
  const lineItemMap = {}; // part_number → { hsn_code, description, part_net_wt, country_of_origin }
  if (partNumbers.length > 0) {
    const lineItems = await db.collection("invoice_line_items")
      .find({ part_number: { $in: partNumbers } })
      .project({ part_number: 1, description: 1, hsn_code: 1, net_weight: 1, part_net_wt: 1, unit_weight: 1, country_of_origin: 1, _id: 0 })
      .toArray();
    lineItems.forEach(li => {
      if (li.part_number && !lineItemMap[li.part_number]) {
        lineItemMap[li.part_number] = {
          hsn_code: li.hsn_code || "",
          description: li.description || "",
          part_net_wt: Number(li.part_net_wt || li.net_weight || li.unit_weight || 0),
          country_of_origin: li.country_of_origin || "",
        };
      }
    });
  }

  // ── 3. product_master fallback for net_wt / COO / description ─────────────
  const missingFromInvoice = partNumbers.filter(pn => !lineItemMap[pn]?.part_net_wt || !lineItemMap[pn]?.country_of_origin);
  if (missingFromInvoice.length > 0) {
    const pmItems = await db.collection("product_master")
      .find({ part_number: { $in: missingFromInvoice }, is_deleted: { $ne: true } })
      .project({ part_number: 1, part_net_wt: 1, country_of_origin: 1, description: 1, _id: 0 })
      .toArray();
    pmItems.forEach(pm => {
      if (!pm.part_number) return;
      if (!lineItemMap[pm.part_number]) lineItemMap[pm.part_number] = { hsn_code: "", description: "", part_net_wt: 0, country_of_origin: "" };
      if (!lineItemMap[pm.part_number].part_net_wt) lineItemMap[pm.part_number].part_net_wt = Number(pm.part_net_wt || 0);
      if (!lineItemMap[pm.part_number].country_of_origin) lineItemMap[pm.part_number].country_of_origin = pm.country_of_origin || "";
      if (!lineItemMap[pm.part_number].description) lineItemMap[pm.part_number].description = pm.description || "";
    });
  }

  // ── 3.5. AI fallback for remaining missing weights / COO ───────────────
  const stillMissing = partNumbers.filter(pn => !lineItemMap[pn]?.part_net_wt || !lineItemMap[pn]?.country_of_origin);
  if (stillMissing.length > 0) {
    const aiResults = await aiService.fetchPartsInfoAI(stillMissing);
    aiResults.forEach(res => {
      const pn = res.part_number;
      if (!pn) return;
      if (!lineItemMap[pn]) lineItemMap[pn] = { hsn_code: "", description: "", part_net_wt: 0, country_of_origin: "" };
      if (!lineItemMap[pn].part_net_wt && res.part_net_wt) lineItemMap[pn].part_net_wt = Number(res.part_net_wt);
      if (!lineItemMap[pn].country_of_origin && res.country_of_origin) lineItemMap[pn].country_of_origin = res.country_of_origin;
    });
  }

  // ── 4. Persist part_net_wt + country_of_origin into product_master ────────
  for (const pn of partNumbers) {
    const info = lineItemMap[pn];
    if (!info) continue;
    const updateSet = { updated_at: new Date() };
    if (info.part_net_wt) updateSet.part_net_wt = info.part_net_wt;
    if (info.country_of_origin) updateSet.country_of_origin = info.country_of_origin;
    if (Object.keys(updateSet).length > 1) {
      await db.collection("product_master").updateOne(
        { part_number: pn },
        { $set: updateSet, $setOnInsert: { part_number: pn, is_deleted: false, created_at: new Date() } },
        { upsert: true }
      );
    }
  }

  // ── 5. PI numbers per order ────────────────────────────────────────────────
  const orderIdStrs = [...new Set(fulfilled.map(fi => fi.order_id).filter(Boolean))];
  const piMap = {}; // order_id (string) → pi_number
  if (orderIdStrs.length > 0) {
    const orderOids = orderIdStrs.map(id => toObjectId(id)).filter(Boolean);
    const orders = await db.collection("orders")
      .find({ _id: { $in: orderOids } })
      .project({ _id: 1, pi_number: 1, order_number: 1, _id: 1 })
      .toArray();
    orders.forEach(o => { piMap[o._id.toString()] = o.pi_number || o.order_number || ""; });
  }

  // ── 6. Build workbook ─────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Join Order");

  ws.columns = [
    { header: "Join Order ID",        key: "join_order_id",      width: 20 },
    { header: "Outward ID",           key: "outward_id",          width: 20 },
    { header: "Order Number",         key: "order_number",        width: 18 },
    { header: "PI Number",            key: "pi_number",           width: 18 },
    { header: "Part Number",          key: "part_number",         width: 20 },
    { header: "Description",          key: "description",         width: 35 },
    { header: "HSN Code",             key: "hsn_code",            width: 14 },
    { header: "Brand",                key: "brand",               width: 16 },
    { header: "Qty Fulfilled",        key: "qty_fulfilled",       width: 14 },
    { header: "Part Net Wt (kg)",     key: "part_net_wt",         width: 16 },
    { header: "Total Net Wt (kg)",    key: "total_net_wt",        width: 18 },
    { header: "Country of Origin",    key: "country_of_origin",   width: 18 },
    { header: "Rate",                 key: "rate",                width: 12 },
    { header: "Currency",             key: "currency",            width: 10 },
    { header: "Created At",           key: "created_at",          width: 20 },
  ];

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };

  const addRows = fulfilled.length === 0 ? [{ part_number: "(no items)" }] : fulfilled;

  addRows.forEach(fi => {
    const pn = (fi.part_number || "").trim();
    const info = lineItemMap[pn] || {};
    const partNetWt = info.part_net_wt || 0;
    const qtyFulfilled = Number(fi.qty_fulfilled) || 0;
    const piNum = fi.order_id ? (piMap[fi.order_id] || "") : "";
    const desc = fi.description || info.description || "Auto Parts";
    ws.addRow({
      join_order_id:    join.join_order_id || "",
      outward_id:       outwardId,
      order_number:     fi.order_number || "",
      pi_number:        piNum,
      part_number:      pn,
      description:      desc,
      hsn_code:         info.hsn_code || "",
      brand:            fi.brand || "",
      qty_fulfilled:    qtyFulfilled,
      part_net_wt:      partNetWt || "",
      total_net_wt:     partNetWt && qtyFulfilled ? parseFloat((partNetWt * qtyFulfilled).toFixed(3)) : "",
      country_of_origin: info.country_of_origin || "",
      rate:             Number(fi.rate) || "",
      currency:         fi.currency || "",
      created_at:       join.created_at ? new Date(join.created_at).toISOString() : "",
    });
  });

  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="JoinOrder_${outwardId}_${dateStr}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
};
