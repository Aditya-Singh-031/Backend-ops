const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");
const { escapeRegex } = require("../utils/helpers");
const { ObjectId } = require("mongodb");

exports.create = async (req, res) => {
  const db = await getDb();
  const buyer = {
    ...req.body,
    is_deleted: false,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const result = await db.collection("buyers").insertOne(buyer);
  buyer._id = result.insertedId;
  return sendSuccess(res, { buyer }, 201);
};

exports.list = async (req, res) => {
  const db = await getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const search = req.query.search;

  const query = { is_deleted: { $ne: true } };
  if (search) {
    const escaped = escapeRegex(search);
    query.$or = [
      { cust_name: { $regex: escaped, $options: "i" } },
      { cust_id: { $regex: escaped, $options: "i" } },
    ];
  }

  const skip = (page - 1) * limit;
  const [buyers, total] = await Promise.all([
    db.collection("buyers").find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
    db.collection("buyers").countDocuments(query),
  ]);

  return sendSuccess(res, {
    buyers,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

exports.getById = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const buyer = await db.collection("buyers").findOne({ _id: oid, is_deleted: { $ne: true } });
  if (!buyer) return sendError(res, "Buyer not found", 404);
  return sendSuccess(res, { buyer });
};

exports.update = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const value = { ...req.body, updated_at: new Date() };
  const result = await db.collection("buyers").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $set: value },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Buyer not found", 404);
  return sendSuccess(res, { buyer: result });
};

exports.remove = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const result = await db.collection("buyers").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $set: { is_deleted: true, updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Buyer not found", 404);
  return sendSuccess(res, { message: "Buyer deleted successfully" });
};

/**
 * GET /buyers/:id/orders
 * Ek buyer ke saare orders fetch karo with:
 *   - order_details items (part numbers, qty, rate)
 *   - shipment invoice number (from outwards → shipments)
 *   - join_order_id (from outward_order_joins) per order
 */
exports.getOrdersForBuyer = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid buyer ID", 400);

  const db = await getDb();

  // 1. Buyer info
  const buyer = await db.collection("buyers").findOne({ _id: oid, is_deleted: { $ne: true } });
  if (!buyer) return sendError(res, "Buyer not found", 404);

  // 2. Buyer ke saare orders (not deleted)
  const orders = await db
    .collection("orders")
    .find({ buyer_id: oid, is_deleted: { $ne: true }, status: "CONFIRMED" })
    .sort({ created_at: -1 })
    .toArray();

  if (orders.length === 0) {
    return sendSuccess(res, { buyer, orders: [] });
  }

  const orderIds = orders.map((o) => o._id);

  // 3. Parallel fetch: order_details + outward_order_joins + outwards (for shipment_id)
  const [allOrderDetails, allJoins] = await Promise.all([
    db
      .collection("order_details")
      .find({ order_id: { $in: orderIds }, is_deleted: { $ne: true } })
      .toArray(),
    db
      .collection("outward_order_joins")
      .find({ order_id: { $in: orderIds } })
      .toArray(),
  ]);

  // 4. Outward IDs from joins → fetch outwards → get shipment_ids
  const joinedOutwardIds = allJoins.map((j) => j.outward_id).filter(Boolean);
  const allOutwards =
    joinedOutwardIds.length > 0
      ? await db
          .collection("outwards")
          .find({ outward_id: { $in: joinedOutwardIds } })
          .project({ outward_id: 1, shipment_id: 1, status: 1 })
          .toArray()
      : [];

  // 5. Shipment IDs → fetch shipments (invoice_number, invoice_date)
  const shipmentIds = [...new Set(allOutwards.map((o) => o.shipment_id).filter(Boolean))];
  const allShipments =
    shipmentIds.length > 0
      ? await db
          .collection("shipments")
          .find({
            _id: {
              $in: shipmentIds
                .map((id) => (typeof id === "string" ? toObjectId(id) : id))
                .filter(Boolean),
            },
          })
          .project({ _id: 1, invoice_number: 1, invoice_date: 1, status: 1, discharge_port: 1 })
          .toArray()
      : [];

  // Build lookup maps
  const detailsByOrder = {};
  allOrderDetails.forEach((d) => {
    detailsByOrder[d.order_id.toString()] = d;
  });

  const joinsByOrder = {};
  allJoins.forEach((j) => {
    const key = j.order_id.toString();
    if (!joinsByOrder[key]) joinsByOrder[key] = [];
    joinsByOrder[key].push(j);
  });

  const outwardByOutwardId = {};
  allOutwards.forEach((o) => {
    outwardByOutwardId[o.outward_id] = o;
  });

  const shipmentById = {};
  allShipments.forEach((s) => {
    shipmentById[s._id.toString()] = s;
  });

  // 6. Compose final orders array
  const enrichedOrders = orders.map((order) => {
    const orderKey = order._id.toString();
    const detail = detailsByOrder[orderKey] || null;
    const joins = joinsByOrder[orderKey] || [];

    // Each join brings: join_order_id, outward_id → outward.shipment_id → invoice
    const joinRefs = joins.map((j) => {
      const outward = outwardByOutwardId[j.outward_id] || null;
      const shipmentIdStr = outward?.shipment_id?.toString();
      const shipment = shipmentIdStr ? shipmentById[shipmentIdStr] || null : null;
      return {
        join_order_id: j.join_order_id || null,
        outward_id: j.outward_id || null,
        outward_status: outward?.status || null,
        invoice_number: shipment?.invoice_number || null,
        invoice_date: shipment?.invoice_date || null,
        discharge_port: shipment?.discharge_port || null,
        fulfilled_items: j.fulfilled_items || [],
      };
    });

    // Enrich order items with which join_order_id maps this part_number
    const items = (detail?.items || []).map((item) => {
      // Find if any join has this part_number fulfilled
      const matchingJoinRefs = joinRefs
        .filter((jr) =>
          jr.fulfilled_items.some((fi) => fi.part_number === item.part_number)
        )
        .map((jr) => ({
          join_order_id: jr.join_order_id,
          outward_id: jr.outward_id,
          invoice_number: jr.invoice_number,
          invoice_date: jr.invoice_date,
          qty_fulfilled:
            jr.fulfilled_items.find((fi) => fi.part_number === item.part_number)
              ?.qty_fulfilled || 0,
        }));

      return {
        ...item,
        join_refs: matchingJoinRefs, // which joins map this part
      };
    });

    return {
      ...order,
      items, // enriched items with join_refs per part
      join_refs: joinRefs, // all joins for this order (invoice level)
    };
  });

  return sendSuccess(res, { buyer, orders: enrichedOrders });
};
