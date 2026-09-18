const express = require("express");
const rateLimit = require("express-rate-limit");
const Product = require("../../models/Product");
const MainCategory = require("../../models/MainCategory");
const SubCategory = require("../../models/SubCategory");
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

const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// ─── Main Categories ──────────────────────────────────────────────────────────

// GET /api/admin/main-categories/extra
router.get("/main-categories/extra", authMiddleware, async (req, res) => {
  try {
    const [productAgg, manualCats] = await Promise.all([
      Product.aggregate([
        { $match: { subCategory: { $ne: null, $exists: true } } },
        { $group: { _id: "$subCategory", count: { $sum: 1 } } },
      ]),
      MainCategory.find(),
    ]);
    const productMap = new Map(productAgg.map((r) => [r._id, r.count]));
    const allNames = new Set([...productMap.keys(), ...manualCats.map((c) => c.name)]);
    res.json([...allNames].sort().map((name) => ({ name, count: productMap.get(name) || 0 })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/main-categories
router.get("/main-categories", authMiddleware, async (req, res) => {
  try {
    const result = await Product.aggregate([
      { $match: { subCategory: { $ne: null, $exists: true } } },
      { $group: { _id: "$subCategory", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    res.json(result.map((r) => ({ name: r._id, count: r.count })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/main-categories
router.post("/main-categories", authMiddleware, writeLimiter, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "اسم التصنيف مطلوب" });
    const exists = await Product.findOne({ category: name.trim() });
    if (exists) return res.status(400).json({ error: "التصنيف موجود بالفعل" });
    const existsMC = await MainCategory.findOne({ name: name.trim() });
    if (existsMC) return res.status(400).json({ error: "التصنيف موجود بالفعل" });
    const cat = await MainCategory.create({ name: name.trim() });
    res.status(201).json({ name: cat.name, count: 0 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/main-categories/rename
router.put("/main-categories/rename", authMiddleware, writeLimiter, async (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: "الاسم القديم والجديد مطلوبان" });
    const exists = await Product.findOne({ subCategory: newName.trim() });
    if (exists && newName.trim() !== oldName.trim()) return res.status(400).json({ error: "التصنيف موجود بالفعل" });
    await Product.updateMany({ subCategory: oldName }, { $set: { subCategory: newName.trim() } });
    await MainCategory.updateOne({ name: oldName }, { $set: { name: newName.trim() } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/main-categories/remove
router.delete("/main-categories/remove", authMiddleware, writeLimiter, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "اسم التصنيف مطلوب" });
    await Product.updateMany({ subCategory: name }, { $unset: { subCategory: "" } });
    await MainCategory.deleteOne({ name });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ─── Categories (product.category) ───────────────────────────────────────────

// GET /api/admin/categories
router.get("/categories", authMiddleware, async (req, res) => {
  try {
    const cats = await Product.distinct("category");
    res.json(cats.filter(Boolean).sort());
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ─── Sub-Categories ───────────────────────────────────────────────────────────

// GET /api/admin/sub-categories/all
router.get("/sub-categories/all", authMiddleware, async (req, res) => {
  try {
    const cats = await MainCategory.find().sort({ name: 1 });
    res.json(cats.map((c) => ({ _id: c._id, name: c.name })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/extra
router.get("/sub-categories/extra", authMiddleware, async (req, res) => {
  try {
    const productSubCats = await Product.distinct("subCategory");
    const extra = await SubCategory.find({ name: { $nin: productSubCats.filter(Boolean) } });
    res.json(extra.map((s) => ({ name: s.name, count: 0, _id: s._id })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/settings
router.get("/sub-categories/settings", authMiddleware, async (req, res) => {
  try {
    const [settings, maxDoc] = await Promise.all([
      SubCategorySettings.find({ category: { $nin: ["__config__", "__brand__", "__brand_config__"] } }),
      SubCategorySettings.findOne({ category: "__config__", subCategory: "__max__" }),
    ]);
    res.json({ settings, max: maxDoc ? maxDoc.order : 4 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/public
router.get("/sub-categories/public", async (req, res) => {
  try {
    const [result, customImages] = await Promise.all([
      Product.aggregate([
        { $match: { category: { $ne: null, $exists: true }, image: { $ne: "", $exists: true } } },
        { $group: { _id: "$category", count: { $sum: 1 }, image: { $first: "$image" } } },
        { $sort: { _id: 1 } },
      ]),
      SubCategorySettings.find({ image: { $ne: "" }, subCategory: { $ne: "__max__" } }, { category: 1, image: 1 }),
    ]);
    const imageMap = {};
    for (const s of customImages) if (s.image) imageMap[s.category] = s.image;
    res.json(result.map((r) => ({ name: r._id, count: r.count, image: imageMap[r._id] || r.image })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/home-settings
router.get("/sub-categories/home-settings", async (req, res) => {
  try {
    const settings = await SubCategorySettings.find({ category: { $ne: "__config__" } }).sort({ order: 1 });
    res.json(settings);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories/max
router.get("/sub-categories/max", async (req, res) => {
  try {
    const doc = await SubCategorySettings.findOne({ category: "__config__", subCategory: "__max__" });
    res.json({ max: doc ? doc.order : 4 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/sub-categories (base — must come AFTER specific routes)
router.get("/sub-categories", authMiddleware, async (req, res) => {
  try {
    const result = await Product.aggregate([
      { $match: { category: { $ne: null, $exists: true } } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    res.json(result.map((r) => ({ category: r._id, name: r._id, count: r.count })));
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/sub-categories
router.post("/sub-categories", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "اسم التصنيف الفرعي مطلوب" });
    const existsInProducts = await Product.findOne({ subCategory: name.trim() });
    if (existsInProducts) return res.status(400).json({ error: "التصنيف الفرعي موجود بالفعل" });
    const existsSC = await SubCategory.findOne({ name: name.trim() });
    if (existsSC) return res.status(400).json({ error: "التصنيف الفرعي موجود بالفعل" });
    const sc = await SubCategory.create({ name: name.trim() });
    res.status(201).json({ name: sc.name, count: 0 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/sub-categories/rename
router.put("/sub-categories/rename", authMiddleware, async (req, res) => {
  try {
    const { oldName, oldCategory, newName, newCategory } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: "الاسم القديم والجديد مطلوبان" });
    await Product.updateMany(
      { subCategory: oldName, category: oldCategory },
      { $set: { subCategory: newName.trim(), category: (newCategory || oldCategory).trim() } }
    );
    await SubCategory.updateOne({ name: oldName }, { $set: { name: newName.trim() } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/sub-categories/remove
router.delete("/sub-categories/remove", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "الاسم مطلوب" });
    await Product.updateMany({ category: name }, { $unset: { category: "" } });
    await SubCategorySettings.deleteMany({ category: name });
    await SubCategory.deleteOne({ name });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/sub-categories/settings/toggle
router.patch("/sub-categories/settings/toggle", authMiddleware, async (req, res) => {
  try {
    const { category, subCategory } = req.body;
    if (!category || !subCategory) return res.status(400).json({ error: "البيانات مطلوبة" });
    const existing = await SubCategorySettings.findOne({ category, subCategory });
    const newValue = existing ? !existing.showInHome : true;
    const doc = await SubCategorySettings.findOneAndUpdate(
      { category, subCategory },
      { $set: { showInHome: newValue } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ showInHome: doc.showInHome });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/sub-categories/settings/order
router.patch("/sub-categories/settings/order", authMiddleware, async (req, res) => {
  try {
    const { category, subCategory, order } = req.body;
    if (!category || !subCategory) return res.status(400).json({ error: "البيانات مطلوبة" });
    await SubCategorySettings.findOneAndUpdate(
      { category, subCategory },
      { $set: { order: Number(order) || 0 } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PATCH /api/admin/sub-categories/max
router.patch("/sub-categories/max", authMiddleware, async (req, res) => {
  try {
    const { max } = req.body;
    const val = parseInt(max);
    if (!val || val < 1) return res.status(400).json({ error: "قيمة غير صحيحة" });
    await SubCategorySettings.findOneAndUpdate(
      { category: "__config__", subCategory: "__max__" },
      { $set: { order: val, showInHome: false } },
      { upsert: true }
    );
    res.json({ max: val });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/sub-categories/image/:category
router.post("/sub-categories/image/:category", authMiddleware, imageUpload.single("image"), async (req, res) => {
  try {
    const { category } = req.params;
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    if (!ALLOWED_IMAGE_MIMES.includes(req.file.mimetype))
      return res.status(400).json({ error: "نوع الملف غير مسموح، يُقبل فقط: JPEG, PNG, WebP, GIF" });

    let result;
    try {
      result = await uploadToCloudinary(req.file.buffer, "sub-categories");
    } catch (uploadErr) {
      console.error("Cloudinary upload failed:", uploadErr.message);
      return res.status(500).json({ error: "فشل رفع الصورة إلى Cloudinary" });
    }
    const newUrl = result.secure_url;

    const existingDoc = await SubCategorySettings.findOne({ category, subCategory: { $ne: "__max__" } });
    const oldUrl = existingDoc?.image || null;

    await SubCategorySettings.findOneAndUpdate(
      { category, subCategory: category },
      { $set: { image: newUrl } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await SubCategorySettings.updateMany(
      { category, subCategory: { $nin: ["__max__", category] } },
      { $set: { image: newUrl } }
    );

    if (oldUrl && oldUrl !== newUrl) {
      deleteFromCloudinary(oldUrl).catch((e) => console.error("Old image delete failed:", e.message));
    }

    res.json({ url: newUrl });
  } catch (err) {
    console.error("sub-categories/image error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

module.exports = router;
