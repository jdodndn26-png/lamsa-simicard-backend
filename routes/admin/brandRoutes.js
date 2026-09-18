const express = require("express");
const rateLimit = require("express-rate-limit");
const Product = require("../../models/Product");
const SubCategorySettings = require("../../models/SubCategorySettings");
const { makeImageUpload, uploadToCloudinary, deleteFromCloudinary } = require("../../config/cloudinary");
const authMiddleware = require("../../middleware/auth");

const router = express.Router();

const imageUpload = makeImageUpload();

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "طلبات كثيرة، حاول لاحقًا" },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/admin/brands/home-settings (public)
router.get("/home-settings", writeLimiter, async (req, res) => {
  try {
    const settings = await SubCategorySettings.find({ category: "__brand__" }).sort({ order: 1 });
    res.json(settings.map((s) => ({ brand: s.subCategory, showInHome: s.showInHome, order: s.order, bannerImages: s.bannerImages || [] })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/brands/settings
router.get("/settings", authMiddleware, async (req, res) => {
  try {
    const settings = await SubCategorySettings.find({ category: "__brand__" });
    res.json(settings.map((s) => ({ brand: s.subCategory, showInHome: s.showInHome, order: s.order, bannerImages: s.bannerImages || [] })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/brands/max (public)
router.get("/max", writeLimiter, async (req, res) => {
  try {
    const doc = await SubCategorySettings.findOne({ category: "__brand_config__", subCategory: "__max__" });
    res.json({ max: doc ? doc.order : 4 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/brands
router.get("/", authMiddleware, async (req, res) => {
  try {
    const result = await Product.aggregate([
      { $match: { brand: { $exists: true, $nin: [null, ""] } } },
      { $group: { _id: "$brand", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    res.json(result.map((r) => ({ name: r._id, count: r.count })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/brands/settings/toggle
router.patch("/settings/toggle", authMiddleware, async (req, res) => {
  try {
    const { brand } = req.body;
    if (!brand) return res.status(400).json({ error: "اسم البراند مطلوب" });
    const existing = await SubCategorySettings.findOne({ category: "__brand__", subCategory: brand });
    const newValue = existing ? !existing.showInHome : true;
    const doc = await SubCategorySettings.findOneAndUpdate(
      { category: "__brand__", subCategory: brand },
      { $set: { showInHome: newValue } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ showInHome: doc.showInHome });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/brands/settings/order
router.patch("/settings/order", authMiddleware, async (req, res) => {
  try {
    const { brand, order } = req.body;
    if (!brand) return res.status(400).json({ error: "اسم البراند مطلوب" });
    await SubCategorySettings.findOneAndUpdate(
      { category: "__brand__", subCategory: brand },
      { $set: { order: Number(order) || 0 } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/brands/max
router.patch("/max", authMiddleware, async (req, res) => {
  try {
    const { max } = req.body;
    const val = parseInt(max);
    if (!val || val < 1) return res.status(400).json({ error: "قيمة غير صحيحة" });
    await SubCategorySettings.findOneAndUpdate(
      { category: "__brand_config__", subCategory: "__max__" },
      { $set: { order: val, showInHome: false } },
      { upsert: true }
    );
    res.json({ max: val });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/brands/banner/:brand
router.post("/banner/:brand", authMiddleware, imageUpload.single("image"), async (req, res) => {
  try {
    const { brand } = req.params;
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const exists = await Product.findOne({ brand });
    if (!exists) return res.status(404).json({ error: "البراند غير موجود" });
    const result = await uploadToCloudinary(req.file.buffer, "banners");
    const doc = await SubCategorySettings.findOneAndUpdate(
      { category: "__brand__", subCategory: brand },
      { $push: { bannerImages: result.secure_url } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ url: result.secure_url, bannerImages: doc.bannerImages });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/brands/banner/:brand
router.delete("/banner/:brand", authMiddleware, async (req, res) => {
  try {
    const { brand } = req.params;
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "الرابط مطلوب" });
    const exists = await Product.findOne({ brand });
    if (!exists) return res.status(404).json({ error: "البراند غير موجود" });
    await deleteFromCloudinary(url);
    await SubCategorySettings.updateOne(
      { category: "__brand__", subCategory: brand },
      { $pull: { bannerImages: url } }
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

module.exports = router;
