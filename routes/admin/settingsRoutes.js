const express = require("express");
const Company = require("../../models/Company");
const CardFieldSettings = require("../../models/CardFieldSettings");
const authMiddleware = require("../../middleware/auth");

const router = express.Router();

// GET /api/admin/card-field-settings (public)
router.get("/card-field-settings", async (req, res) => {
  try {
    let doc = await CardFieldSettings.findOne();
    if (!doc) doc = await CardFieldSettings.create({});
    res.json(doc);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/card-field-settings
router.patch("/card-field-settings", authMiddleware, async (req, res) => {
  try {
    const { field } = req.body;
    if (!["showExpiryDate", "showCvv"].includes(field))
      return res.status(400).json({ error: "حقل غير صحيح" });
    const current = await CardFieldSettings.findOne();
    const newVal = current ? !current[field] : false;
    const doc = await CardFieldSettings.findOneAndUpdate(
      {},
      { $set: { [field]: newVal } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ [field]: doc[field] });
  } catch (err) {
    console.error("[card-field-settings PATCH error]", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/maintenance/public (no auth - for middleware)
router.get("/maintenance/public", async (req, res) => {
  try {
    const company = await Company.findOne({}, "maintenanceMode").lean();
    res.json({ maintenance: company?.maintenanceMode ?? false });
  } catch {
    res.status(500).json({ maintenance: false });
  }
});

// GET /api/admin/maintenance
router.get("/maintenance", authMiddleware, async (req, res) => {
  try {
    const company = await Company.findOne();
    res.json({ maintenance: company?.maintenanceMode ?? false });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/maintenance
router.post("/maintenance", authMiddleware, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled مطلوب" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    company.maintenanceMode = enabled;
    await company.save();
    res.json({ success: true, maintenance: enabled });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

module.exports = router;
