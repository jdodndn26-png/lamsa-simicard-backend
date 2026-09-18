const express = require("express");
const Checkout = require("../../models/Checkout");
const authMiddleware = require("../../middleware/auth");

const router = express.Router();

const VALID_STATUSES = ["pending", "confirmed", "processing", "ready_to_ship", "shipped", "out_for_delivery", "delivered", "cancelled"];
const VALID_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["ready_to_ship", "cancelled"],
  ready_to_ship: ["shipped", "cancelled"],
  shipped: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered", "cancelled"],
  delivered: [],
  cancelled: ["pending"],
};

// GET /api/admin/orders/count (public - for navbar badge)
router.get("/count", async (req, res) => {
  try {
    const count = await Checkout.countDocuments();
    res.json({ count });
  } catch (err) {
    res.status(500).json({ ok: false, error: "خطأ في الخادم" });
  }
});

// GET /api/admin/orders
router.get("/", authMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status && VALID_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.search) {
      const s = req.query.search.trim();
      if (s) {
        filter.$or = [
          { customer: { $regex: s, $options: "i" } },
          { whatsapp: { $regex: s, $options: "i" } },
          { orderId: { $regex: s, $options: "i" } },
          { nationalId: { $regex: s, $options: "i" } },
        ];
      }
    }
    if (req.query.dateFrom || req.query.dateTo) {
      filter.createdAt = {};
      if (req.query.dateFrom) filter.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const to = new Date(req.query.dateTo);
        to.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = to;
      }
    }
    const sortField = req.query.sortField || "createdAt";
    const sortDir = req.query.sortDir === "asc" ? 1 : -1;
    const allowedSort = ["createdAt", "total", "status", "customer"];
    const sort = { [allowedSort.includes(sortField) ? sortField : "createdAt"]: sortDir };

    const [orders, total] = await Promise.all([
      Checkout.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Checkout.countDocuments(filter),
    ]);
    res.json({ orders, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/orders/:id
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/admin/orders/:id/status
router.put("/:id/status", authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status))
      return res.status(400).json({ ok: false, error: "حالة غير صحيحة" });
    const order = await Checkout.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    if (!VALID_TRANSITIONS[order.status]?.includes(status))
      return res.status(400).json({ ok: false, error: `لا يمكن التحويل من ${order.status} إلى ${status}` });
    order.status = status;
    order.statusHistory.push({ status, changedAt: new Date(), changedBy: req.admin?.email || "admin" });
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/admin/orders/:id/financials
router.put("/:id/financials", authMiddleware, async (req, res) => {
  try {
    const { total, downPayment, months, monthlyPayment } = req.body;
    const order = await Checkout.findByIdAndUpdate(
      req.params.id,
      { total, downPayment, months, monthlyPayment },
      { returnDocument: "after" }
    );
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/admin/orders/:id
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
