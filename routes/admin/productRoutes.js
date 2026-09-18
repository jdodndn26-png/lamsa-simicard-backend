const express = require("express");
const Product = require("../../models/Product");
const { makeImageUpload, uploadToCloudinary, deleteFromCloudinary } = require("../../config/cloudinary");
const { invalidateCache } = require("../../controllers/productController");
const authMiddleware = require("../../middleware/auth");

const router = express.Router();

const imageUpload = makeImageUpload();

// POST /api/admin/products/upload-image
router.post("/upload-image", authMiddleware, imageUpload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const result = await uploadToCloudinary(req.file.buffer, "products");
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error("upload-image error:", err);
    res.status(500).json({ error: "فشل رفع الصورة" });
  }
});

// GET /api/admin/products
router.get("/", authMiddleware, async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 }).select("name category originalPrice salePrice");
    res.json(products);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/products
router.post("/", authMiddleware, imageUpload.fields([{ name: "image", maxCount: 1 }, { name: "galleryFiles", maxCount: 20 }]), async (req, res) => {
  try {
    const body = req.body;
    const productData = {};

    const fields = ["name", "category", "subCategory", "brand", "color", "storage", "network", "screenSize", "description", "deliveryTime", "overviewImage"];
    fields.forEach((f) => { if (body[f]) productData[f] = body[f]; });

    const numFields = ["originalPrice", "salePrice", "warrantyYears"];
    numFields.forEach((f) => { if (body[f] !== undefined && body[f] !== "") productData[f] = Number(body[f]); });

    const boolFields = ["freeDelivery", "taxIncluded", "inStock"];
    boolFields.forEach((f) => { if (body[f] !== undefined) productData[f] = body[f] === "true" || body[f] === true; });

    if (body["installment.available"] !== undefined) {
      productData.installment = {
        available: body["installment.available"] === "true",
        downPayment: body["installment.downPayment"] ? Number(body["installment.downPayment"]) : undefined,
        months: body["installment.months"] ? Number(body["installment.months"]) : undefined,
        note: body["installment.note"] || "",
      };
    }

    const specFields = ["screen", "processor", "ram", "storage", "rearCamera", "frontCamera", "battery", "batteryLife", "charging", "os", "extras"];
    const specs = {};
    specFields.forEach((f) => { if (body[`specs.${f}`]) specs[f] = body[`specs.${f}`]; });
    if (Object.keys(specs).length) productData.specs = specs;

    if (body.colors) {
      try { productData.colors = JSON.parse(body.colors); } catch { /* ignore */ }
    }

    if (req.files?.image?.[0]) {
      const result = await uploadToCloudinary(req.files.image[0].buffer, "products");
      productData.image = result.secure_url;
    } else if (body.imageUrl) {
      productData.image = body.imageUrl;
    }

    const galleryUrls = [];
    if (body.galleryUrls) {
      try { galleryUrls.push(...JSON.parse(body.galleryUrls)); } catch { /* ignore */ }
    }
    if (req.files?.galleryFiles) {
      for (const file of req.files.galleryFiles) {
        const result = await uploadToCloudinary(file.buffer, "products");
        galleryUrls.push(result.secure_url);
      }
    }
    if (galleryUrls.length) productData.images = galleryUrls;

    const product = await Product.create(productData);
    invalidateCache();
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/products/:id
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    res.json(product);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/products/:id
router.put("/:id", authMiddleware, imageUpload.fields([{ name: "image", maxCount: 1 }, { name: "galleryFiles", maxCount: 20 }]), async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });

    const body = req.body;
    const fields = ["name", "category", "subCategory", "brand", "color", "storage", "network", "screenSize", "description", "deliveryTime", "overviewImage"];
    fields.forEach((f) => { if (body[f] !== undefined) product[f] = body[f]; });

    const numFields = ["originalPrice", "salePrice", "warrantyYears"];
    numFields.forEach((f) => { if (body[f] !== undefined) product[f] = body[f] === "" ? undefined : Number(body[f]); });

    const boolFields = ["freeDelivery", "taxIncluded", "inStock"];
    boolFields.forEach((f) => { if (body[f] !== undefined) product[f] = body[f] === "true" || body[f] === true; });

    if (body["installment.available"] !== undefined) {
      product.installment = product.installment || {};
      product.installment.available = body["installment.available"] === "true" || body["installment.available"] === true;
      product.installment.downPayment = body["installment.downPayment"] ? Number(body["installment.downPayment"]) : product.installment.downPayment;
      product.installment.months = body["installment.months"] ? Number(body["installment.months"]) : product.installment.months;
      product.installment.note = body["installment.note"] ?? product.installment.note;
    }

    const specFields = ["screen", "processor", "ram", "storage", "rearCamera", "frontCamera", "battery", "batteryLife", "charging", "os", "extras"];
    const hasSpecs = specFields.some((f) => body[`specs.${f}`] !== undefined);
    if (hasSpecs) {
      product.specs = product.specs || {};
      specFields.forEach((f) => { if (body[`specs.${f}`] !== undefined) product.specs[f] = body[`specs.${f}`]; });
    }

    if (body.colors !== undefined) {
      try { product.colors = JSON.parse(body.colors); } catch { /* ignore */ }
    }

    if (req.files?.image?.[0]) {
      await deleteFromCloudinary(product.image);
      const result = await uploadToCloudinary(req.files.image[0].buffer, "products");
      product.image = result.secure_url;
    } else if (body.imageUrl !== undefined) {
      product.image = body.imageUrl;
    }

    const galleryUrls = [];
    if (body.galleryUrls) {
      try { galleryUrls.push(...JSON.parse(body.galleryUrls)); } catch { /* ignore */ }
    }
    if (req.files?.galleryFiles) {
      for (const file of req.files.galleryFiles) {
        const result = await uploadToCloudinary(file.buffer, "products");
        galleryUrls.push(result.secure_url);
      }
    }
    if (body.galleryUrls !== undefined || req.files?.galleryFiles) {
      product.images = galleryUrls;
    }

    if (body.images !== undefined && !req.files?.galleryFiles && body.galleryUrls === undefined) {
      try {
        product.images = Array.isArray(body.images) ? body.images : JSON.parse(body.images);
      } catch { /* ignore */ }
    }

    if (body.gallery !== undefined) {
      try {
        product.gallery = Array.isArray(body.gallery) ? body.gallery : JSON.parse(body.gallery);
      } catch { /* ignore */ }
    }

    await product.save();
    invalidateCache();
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/products/:id
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
    await deleteFromCloudinary(product.image);
    invalidateCache();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

module.exports = router;
