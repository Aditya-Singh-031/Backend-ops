const { v4: uuidv4 } = require("uuid");
const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");

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
  const { exclude_outward_id } = req.query;
  const db = await getDb();

  const allInwards = await db.collection("inwards").find({ packing_list: { $exists: true, $ne: null } }).toArray();
  const existingOutwards = await db.collection("outwards").find({}).toArray();
  const usedBoxIds = new Set();
  existingOutwards.forEach((outward) => {
    if (exclude_outward_id && outward.outward_id === exclude_outward_id) return;
    (outward.boxes || []).forEach((box) => usedBoxIds.add(box.box_id));
  });

  const availableBoxes = [];
  allInwards.forEach((inward) => {
    const boxes = inward.packing_list?.boxes || [];
    boxes.forEach((box, idx) => {
      const boxId = `${inward.inward_id}-BOX-${box.box_number || idx + 1}`;
      if (usedBoxIds.has(boxId)) return;
      availableBoxes.push({
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
      });
    });
  });

  sendSuccess(res, availableBoxes);
};

exports.create = async (req, res) => {
  const { shipment_id, selected_box_ids, total_weight, notes, created_by } = req.body;
  const db = await getDb();

  const shipment = await db.collection("shipments").findOne({ _id: toObjectId(shipment_id) });
  if (!shipment) return sendError(res, "Shipment not found", 404);

  const allInwards = await db.collection("inwards").find({ packing_list: { $exists: true, $ne: null } }).toArray();

  const outwardBoxes = [];
  (selected_box_ids || []).forEach((boxId) => {
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
