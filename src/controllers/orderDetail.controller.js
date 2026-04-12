const { getDb, toObjectId } = require("../config/db");
const { sendSuccess, sendError } = require("../utils/response");

exports.getByOrder = async (req, res) => {
  const oid = toObjectId(req.params.orderId);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const detail = await db.collection("order_details").findOne({
    order_id: oid,
    is_deleted: { $ne: true },
  });
  if (!detail) return sendError(res, "Order details not found", 404);

  // Populate product_id in items
  const productIds = (detail.items || [])
    .map((i) => i.product_id)
    .filter(Boolean)
    .map((id) => toObjectId(id))
    .filter(Boolean);

  if (productIds.length > 0) {
    const products = await db.collection("product_master").find({ _id: { $in: productIds } }).toArray();
    const productMap = {};
    products.forEach((p) => (productMap[p._id.toString()] = p));
    detail.items = detail.items.map((item) => {
      const pid = item.product_id?.toString();
      if (pid && productMap[pid]) item.product_id = productMap[pid];
      return item;
    });
  }

  return sendSuccess(res, { orderDetail: detail });
};

exports.getById = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const detail = await db.collection("order_details").findOne({
    _id: oid,
    is_deleted: { $ne: true },
  });
  if (!detail) return sendError(res, "Order details not found", 404);
  return sendSuccess(res, { orderDetail: detail });
};

exports.update = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const update = { updated_at: new Date() };
  if (req.body.items) update.items = req.body.items;
  if (req.body.po_ids) update.po_ids = req.body.po_ids;
  if (req.body.supplier_invoice_ids) update.supplier_invoice_ids = req.body.supplier_invoice_ids;
  if (req.body.packing_list_ids) update.packing_list_ids = req.body.packing_list_ids;
  if (req.body.shipment_ids) update.shipment_ids = req.body.shipment_ids;

  const result = await db.collection("order_details").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $set: update },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Order details not found", 404);
  return sendSuccess(res, { orderDetail: result });
};

exports.remove = async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) return sendError(res, "Invalid ID", 400);

  const db = await getDb();
  const result = await db.collection("order_details").findOneAndUpdate(
    { _id: oid, is_deleted: { $ne: true } },
    { $set: { is_deleted: true, updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) return sendError(res, "Order details not found", 404);
  return sendSuccess(res, { message: "Order details deleted" });
};
