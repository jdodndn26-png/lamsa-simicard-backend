const express = require("express");
const rateLimit = require("express-rate-limit");
const Company = require("../../models/Company");
const { makeImageUpload, makeFileUpload, uploadToCloudinary, deleteFromCloudinary } = require("../../config/cloudinary");
const authMiddleware = require("../../middleware/auth");

const router = express.Router();

const imageUpload = makeImageUpload();
const docUpload = makeFileUpload();

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "طلبات كثيرة، حاول لاحقًا" },
  standardHeaders: true,
  legacyHeaders: false,
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "طلبات كثيرة، حاول لاحقًا" },
  standardHeaders: true,
  legacyHeaders: false,
});

const COMPANY_TEXT_FIELDS = [
  "nameAr", "nameEn", "addressAr", "addressEn",
  "phone", "whatsapp", "website", "email",
  "currencyAr", "currencyEn", "taxNumber",
  "shippingCompany", "paymentMethod", "details",
  "qrLink", "qrLinkType", "qrFile",
  "link1", "link1Type", "file1",
  "link2", "link2Type", "file2",
];

const ALLOWED_PAYMENT_METHODS = ["حوالات بنكية فقط", "بطاقة بنكية فقط"];
const ALLOWED_LINK_TYPES = ["link", "file"];
const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ALLOWED_DOC_MIMES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

function validateCompanyBody(body) {
  const errors = [];
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))
    errors.push("البريد الإلكتروني غير صحيح");
  if (body.website && body.website.length > 0 && !/^https?:\/\/.+/.test(body.website))
    errors.push("رابط الموقع يجب أن يبدأ بـ http أو https");
  if (body.phone && !/^[\d\s\+\-\(\)]{5,20}$/.test(body.phone))
    errors.push("رقم الهاتف غير صحيح");
  if (body.whatsapp && !/^[\d\s\+\-\(\)]{5,20}$/.test(body.whatsapp))
    errors.push("رقم الواتساب غير صحيح");
  if (body.paymentMethod && !ALLOWED_PAYMENT_METHODS.includes(body.paymentMethod))
    errors.push("طريقة الدفع غير مسموحة");
  if (body.link1Type && !ALLOWED_LINK_TYPES.includes(body.link1Type))
    errors.push("نوع الرابط 1 غير مسموح");
  if (body.link2Type && !ALLOWED_LINK_TYPES.includes(body.link2Type))
    errors.push("نوع الرابط 2 غير مسموح");
  if (body.qrLinkType && !ALLOWED_LINK_TYPES.includes(body.qrLinkType))
    errors.push("نوع رابط QR غير مسموح");
  const maxLen = { nameAr: 200, nameEn: 200, addressAr: 500, addressEn: 500, details: 2000, taxNumber: 50 };
  for (const [field, max] of Object.entries(maxLen)) {
    if (body[field] && typeof body[field] === "string" && body[field].length > max)
      errors.push(`${field} يتجاوز الحد المسموح (${max} حرف)`);
  }
  return errors;
}

// GET /api/admin/company/public
router.get("/public", async (req, res) => {
  try {
    const company = await Company.findOne(
      {},
      "nameAr nameEn phone whatsapp email website details logo qrImage qrLink qrLinkType qrFile img1 link1 link1Type file1 img2 link2 link2Type file2 footerItems -_id"
    ).lean();
    res.json(company || {});
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// GET /api/admin/company
router.get("/", authMiddleware, async (req, res) => {
  try {
    let company = await Company.findOne().lean();
    if (!company) {
      company = (await Company.create({
        footerItems: [
          { image: "", linkType: "link", link: "", file: "" },
          { image: "", linkType: "link", link: "", file: "" },
          { image: "", linkType: "link", link: "", file: "" },
        ],
      })).toObject();
    } else if (!company.footerItems || company.footerItems.length === 0) {
      await Company.updateOne(
        { _id: company._id },
        { $set: { footerItems: [
          { image: "", linkType: "link", link: "", file: "" },
          { image: "", linkType: "link", link: "", file: "" },
          { image: "", linkType: "link", link: "", file: "" },
        ] } }
      );
      company.footerItems = [
        { image: "", linkType: "link", link: "", file: "" },
        { image: "", linkType: "link", link: "", file: "" },
        { image: "", linkType: "link", link: "", file: "" },
      ];
    }
    res.json(company);
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// PUT /api/admin/company
router.put("/", authMiddleware, writeLimiter, async (req, res) => {
  try {
    const rawBody = { ...req.body };
    // backward compat aliases
    if (rawBody.linkType1 !== undefined) { rawBody.link1Type = rawBody.linkType1; delete rawBody.linkType1; }
    if (rawBody.linkType2 !== undefined) { rawBody.link2Type = rawBody.linkType2; delete rawBody.linkType2; }

    const validationErrors = validateCompanyBody(rawBody);
    if (validationErrors.length > 0)
      return res.status(400).json({ error: validationErrors.join("، ") });

    const safeBody = {};
    for (const field of COMPANY_TEXT_FIELDS) {
      if (rawBody[field] !== undefined) {
        safeBody[field] = typeof rawBody[field] === "string" ? rawBody[field].trim() : rawBody[field];
      }
    }

    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    Object.assign(company, safeBody);
    await company.save();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/upload/:field
router.post("/upload/:field", authMiddleware, uploadLimiter, imageUpload.single("image"), async (req, res) => {
  try {
    const { field } = req.params;
    const allowed = ["logo", "header", "footer", "stamp", "cancelStamp"];
    if (!allowed.includes(field)) return res.status(400).json({ error: "حقل غير مسموح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"];
    if (!allowedMimes.includes(req.file.mimetype))
      return res.status(400).json({ error: "نوع الملف غير مسموح، يُقبل فقط: JPEG, PNG, WebP, GIF, SVG" });

    let result;
    try {
      result = await uploadToCloudinary(req.file.buffer, "company");
    } catch (uploadErr) {
      console.error("Cloudinary upload failed:", uploadErr.message);
      return res.status(500).json({ error: "فشل رفع الصورة إلى Cloudinary" });
    }
    const newUrl = result.secure_url;

    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    const oldUrl = company[field];
    company[field] = newUrl;
    try {
      await company.save();
    } catch (dbErr) {
      deleteFromCloudinary(newUrl).catch((e) => console.error("Orphan cleanup failed:", e.message));
      return res.status(500).json({ error: "فشل حفظ البيانات" });
    }

    if (oldUrl) {
      deleteFromCloudinary(oldUrl).catch((e) => console.error("Old image delete failed:", e.message));
    }

    res.json({ url: newUrl });
  } catch (err) {
    console.error("company upload error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/image/:field
router.delete("/image/:field", authMiddleware, writeLimiter, async (req, res) => {
  try {
    const { field } = req.params;
    const allowed = ["logo", "header", "footer", "stamp", "cancelStamp"];
    if (!allowed.includes(field)) return res.status(400).json({ error: "حقل غير مسموح" });
    const company = await Company.findOne();
    if (!company) return res.json({ success: true });
    const oldUrl = company[field];
    company[field] = "";
    await company.save();
    if (oldUrl) {
      deleteFromCloudinary(oldUrl).catch((e) => console.error("Cloudinary delete failed:", e.message));
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-image/:key
router.post("/footer-image/:key", authMiddleware, uploadLimiter, imageUpload.single("image"), async (req, res) => {
  try {
    const { key } = req.params;
    if (!["qrImage", "img1", "img2"].includes(key)) return res.status(400).json({ error: "حقل غير مسموح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    if (!ALLOWED_IMAGE_MIMES.includes(req.file.mimetype))
      return res.status(400).json({ error: "نوع الملف غير مسموح، يُقبل فقط: JPEG, PNG, WebP, GIF" });

    let result;
    try {
      result = await uploadToCloudinary(req.file.buffer, "company");
    } catch (uploadErr) {
      console.error("Cloudinary upload failed:", uploadErr.message);
      return res.status(500).json({ error: "فشل رفع الصورة إلى Cloudinary" });
    }
    const newUrl = result.secure_url;

    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    const oldUrl = company[key];
    company[key] = newUrl;
    try {
      await company.save();
    } catch (dbErr) {
      deleteFromCloudinary(newUrl).catch((e) => console.error("Orphan cleanup failed:", e.message));
      return res.status(500).json({ error: "فشل حفظ البيانات" });
    }

    if (oldUrl) {
      deleteFromCloudinary(oldUrl).catch((e) => console.error("Old image delete failed:", e.message));
    }

    res.json({ url: newUrl });
  } catch (err) {
    console.error("footer-image upload error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-file/:key
router.post("/footer-file/:key", authMiddleware, uploadLimiter, docUpload.single("file"), async (req, res) => {
  try {
    const { key } = req.params;
    if (!["qrFile", "file1", "file2"].includes(key)) return res.status(400).json({ error: "حقل غير مسموح" });
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع ملف" });
    if (!ALLOWED_DOC_MIMES.includes(req.file.mimetype))
      return res.status(400).json({ error: "نوع الملف غير مسموح، يُقبل فقط: PDF, Word, Excel" });

    let result;
    try {
      result = await uploadToCloudinary(req.file.buffer, "docs", { resource_type: "raw" });
    } catch (uploadErr) {
      console.error("Cloudinary upload failed:", uploadErr.message);
      return res.status(500).json({ error: "فشل رفع الملف إلى Cloudinary" });
    }
    const newUrl = result.secure_url;

    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    const oldUrl = company[key];
    company[key] = newUrl;
    try {
      await company.save();
    } catch (dbErr) {
      deleteFromCloudinary(newUrl, "raw").catch((e) => console.error("Orphan cleanup failed:", e.message));
      return res.status(500).json({ error: "فشل حفظ البيانات" });
    }

    if (oldUrl) {
      deleteFromCloudinary(oldUrl, "raw").catch((e) => console.error("Old file delete failed:", e.message));
    }

    res.json({ url: newUrl });
  } catch (err) {
    console.error("footer-file upload error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/footer-file-delete/:field
router.delete("/footer-file-delete/:field", authMiddleware, writeLimiter, async (req, res) => {
  try {
    const { field } = req.params;
    if (!["qrFile", "file1", "file2"].includes(field)) return res.status(400).json({ error: "حقل غير مسموح" });
    const company = await Company.findOne();
    if (!company) return res.json({ success: true });
    const oldUrl = company[field];
    company[field] = "";
    await company.save();
    if (oldUrl) {
      deleteFromCloudinary(oldUrl, "raw").catch((e) => console.error("Cloudinary delete failed:", e.message));
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-items/add
router.post("/footer-items/add", authMiddleware, async (req, res) => {
  try {
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    company.footerItems.push({ image: "", linkType: "link", link: "", file: "" });
    await company.save();
    res.json({ index: company.footerItems.length - 1 });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-items/image/:index
router.post("/footer-items/image/:index", authMiddleware, uploadLimiter, imageUpload.single("image"), async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع صورة" });
    if (!ALLOWED_IMAGE_MIMES.includes(req.file.mimetype))
      return res.status(400).json({ error: "نوع الملف غير مسموح، يُقبل فقط: JPEG, PNG, WebP, GIF" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    if (isNaN(index) || index < 0 || index >= company.footerItems.length)
      return res.status(400).json({ error: "رقم غير صحيح" });

    let result;
    try {
      result = await uploadToCloudinary(req.file.buffer, "company");
    } catch (uploadErr) {
      console.error("Cloudinary upload failed:", uploadErr.message);
      return res.status(500).json({ error: "فشل رفع الصورة إلى Cloudinary" });
    }
    const newUrl = result.secure_url;
    const oldUrl = company.footerItems[index]?.image;

    company.footerItems[index].image = newUrl;
    company.markModified("footerItems");
    try {
      await company.save();
    } catch (dbErr) {
      deleteFromCloudinary(newUrl).catch((e) => console.error("Orphan cleanup failed:", e.message));
      return res.status(500).json({ error: "فشل حفظ البيانات" });
    }

    if (oldUrl) {
      deleteFromCloudinary(oldUrl).catch((e) => console.error("Old image delete failed:", e.message));
    }

    res.json({ url: newUrl });
  } catch (err) {
    console.error("footer-items/image upload error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/admin/company/footer-items/file/:index
router.post("/footer-items/file/:index", authMiddleware, uploadLimiter, docUpload.single("file"), async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع ملف" });
    if (!ALLOWED_DOC_MIMES.includes(req.file.mimetype))
      return res.status(400).json({ error: "نوع الملف غير مسموح، يُقبل فقط: PDF, Word, Excel" });
    let company = await Company.findOne();
    if (!company) company = await Company.create({});
    if (isNaN(index) || index < 0 || index >= company.footerItems.length)
      return res.status(400).json({ error: "رقم غير صحيح" });

    let result;
    try {
      result = await uploadToCloudinary(req.file.buffer, "docs", { resource_type: "raw" });
    } catch (uploadErr) {
      console.error("Cloudinary upload failed:", uploadErr.message);
      return res.status(500).json({ error: "فشل رفع الملف إلى Cloudinary" });
    }
    const newUrl = result.secure_url;
    const oldUrl = company.footerItems[index]?.file;

    company.footerItems[index].file = newUrl;
    company.markModified("footerItems");
    try {
      await company.save();
    } catch (dbErr) {
      deleteFromCloudinary(newUrl, "raw").catch((e) => console.error("Orphan cleanup failed:", e.message));
      return res.status(500).json({ error: "فشل حفظ البيانات" });
    }

    if (oldUrl) {
      deleteFromCloudinary(oldUrl, "raw").catch((e) => console.error("Old file delete failed:", e.message));
    }

    res.json({ url: newUrl });
  } catch (err) {
    console.error("footer-items/file upload error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// DELETE /api/admin/company/footer-items/:index
router.delete("/footer-items/:index", authMiddleware, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    let company = await Company.findOne();
    if (!company) return res.json({ success: true });
    if (isNaN(index) || index < 0 || index >= company.footerItems.length)
      return res.status(400).json({ error: "رقم غير صحيح" });
    const item = company.footerItems[index];
    await deleteFromCloudinary(item.image);
    await deleteFromCloudinary(item.file);
    company.footerItems.splice(index, 1);
    company.markModified("footerItems");
    await company.save();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

module.exports = router;
