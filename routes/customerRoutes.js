const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { rateLimit } = require("express-rate-limit");

function safeIpKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}
const Customer = require("../models/Customer");
const Otp = require("../models/Otp");

const router = express.Router();

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 60 * 1000;
const SESSION_DAYS = 30;

const requestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  keyGenerator: (req) => `cust-req:${(req.body?.email || "").toLowerCase().trim()}:${safeIpKey(req)}`,
  message: { error: "طلبات كثيرة، حاول بعد دقيقة" },
  standardHeaders: true,
  legacyHeaders: false,
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `cust-verify:${(req.body?.email || "").toLowerCase().trim()}:${safeIpKey(req)}`,
  message: { error: "طلبات كثيرة، حاول لاحقًا" },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `cust-login:${(req.body?.email || "").toLowerCase().trim()}:${safeIpKey(req)}`,
  message: { error: "محاولات كثيرة، حاول بعد 15 دقيقة" },
  standardHeaders: true,
  legacyHeaders: false,
});

function hashOtp(otp) {
  const secret = process.env.OTP_HASH_SECRET;
  if (!secret) throw new Error("OTP_HASH_SECRET is not set");
  return crypto.createHmac("sha256", secret).update(otp).digest("hex");
}

function hashPassword(password) {
  const secret = process.env.OTP_HASH_SECRET || "fallback";
  return crypto.createHmac("sha256", secret).update(password).digest("hex");
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function normalizeEmail(email) {
  return (email || "").toLowerCase().trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function signSession(customerId) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return jwt.sign({ sub: customerId, type: "customer" }, secret, {
    expiresIn: `${SESSION_DAYS}d`,
  });
}

function verifySession(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  const payload = jwt.verify(token, secret);
  if (payload.type !== "customer") throw new Error("invalid token type");
  return payload;
}

function setSessionCookie(res, token) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("customer_token", token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

function clearSessionCookie(res) {
  const isProd = process.env.NODE_ENV === "production";
  res.clearCookie("customer_token", {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
  });
}

function requireCustomer(req, res, next) {
  const token = req.cookies?.customer_token;
  if (!token) return res.status(401).json({ error: "غير مصرح" });
  try {
    const payload = verifySession(token);
    req.customerId = payload.sub;
    next();
  } catch {
    clearSessionCookie(res);
    res.status(401).json({ error: "غير مصرح" });
  }
}

// ─── CHECK EMAIL (live validation) ───────────────────────────────────────────
// GET /api/customers/auth/check-email?email=xxx
router.get("/auth/check-email", async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);
    if (!email || !isValidEmail(email))
      return res.json({ exists: false });

    const existing = await Customer.findOne({ email }).select("_id").lean();
    return res.json({ exists: !!existing });
  } catch (err) {
    console.error("[check-email]", err.message);
    return res.json({ exists: false });
  }
});

// ─── REGISTER: Step 1 - Send OTP ─────────────────────────────────────────────
// POST /api/customers/auth/register/request
router.post("/auth/register/request", requestLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { firstName, lastName, phone, password } = req.body;

    if (!email || !isValidEmail(email))
      return res.status(400).json({ error: "أدخل بريدًا إلكترونيًا صحيحًا" });
    if (!firstName || String(firstName).trim().length < 2)
      return res.status(400).json({ error: "أدخل الاسم الأول" });
    if (!lastName || String(lastName).trim().length < 2)
      return res.status(400).json({ error: "أدخل اسم العائلة" });
    if (!phone || !/^[\d\s\+\-\(\)]{7,20}$/.test(String(phone).trim()))
      return res.status(400).json({ error: "أدخل رقم هاتف صحيح" });
    if (!password || String(password).length < 6)
      return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });

    // Check if email already registered
    const existing = await Customer.findOne({ email }).select("_id").lean();
    if (existing)
      return res.status(409).json({ error: "هذا البريد الإلكتروني مسجل مسبقًا" });

    // Cooldown check
    const recent = await Otp.findOne({
      email,
      purpose: "register",
      used: false,
      expiresAt: { $gt: new Date() },
      createdAt: { $gt: new Date(Date.now() - COOLDOWN_MS) },
    }).select("createdAt").lean();

    if (recent)
      return res.status(429).json({ error: "تم إرسال رمز مؤخرًا، انتظر دقيقة", cooldown: true });

    await Otp.updateMany({ email, purpose: "register", used: false }, { $set: { used: true } });

    const otp = generateOtp();
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await Otp.create({ email, otpHash, purpose: "register", expiresAt });

    return res.json({ ok: true, _otp: otp });
  } catch (err) {
    console.error("[register/request]", err.message);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ─── REGISTER: Step 2 - Verify OTP & Create Account ─────────────────────────
// POST /api/customers/auth/register/verify
router.post("/auth/register/verify", verifyLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();
    const { firstName, lastName, phone, password } = req.body;

    if (!email || !isValidEmail(email))
      return res.status(400).json({ error: "بريد إلكتروني غير صحيح" });
    if (!/^\d{6}$/.test(otp))
      return res.status(400).json({ error: "رمز التحقق يجب أن يكون 6 أرقام" });
    if (!firstName || !lastName || !phone || !password)
      return res.status(400).json({ error: "بيانات ناقصة" });

    // Check again not registered
    const existing = await Customer.findOne({ email }).select("_id").lean();
    if (existing)
      return res.status(409).json({ error: "هذا البريد الإلكتروني مسجل مسبقًا" });

    const record = await Otp.findOne({
      email,
      purpose: "register",
      used: false,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!record)
      return res.status(400).json({ error: "انتهت صلاحية الرمز أو غير موجود", code: "EXPIRED" });

    if (record.attempts >= MAX_ATTEMPTS) {
      record.used = true;
      await record.save();
      return res.status(400).json({ error: "تجاوزت الحد المسموح من المحاولات", code: "MAX_ATTEMPTS" });
    }

    const inputHash = hashOtp(otp);
    let match = false;
    try {
      match = crypto.timingSafeEqual(
        Buffer.from(inputHash, "hex"),
        Buffer.from(record.otpHash, "hex")
      );
    } catch { match = false; }

    if (!match) {
      record.attempts += 1;
      await record.save();
      const remaining = MAX_ATTEMPTS - record.attempts;
      return res.status(400).json({ error: "رمز التحقق غير صحيح", code: "INVALID", attemptsLeft: remaining > 0 ? remaining : 0 });
    }

    record.used = true;
    await record.save();

    const customer = await Customer.create({
      email,
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      phone: String(phone).trim(),
      passwordHash: hashPassword(String(password)),
      emailVerified: true,
      lastLoginAt: new Date(),
    });

    const token = signSession(customer._id.toString());
    setSessionCookie(res, token);

    return res.json({
      ok: true,
      user: {
        id: customer._id,
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
      },
    });
  } catch (err) {
    console.error("[register/verify]", err.message);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ─── LOGIN: Email + Password ──────────────────────────────────────────────────
// POST /api/customers/auth/login
router.post("/auth/login", loginLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "").trim();

    if (!email || !isValidEmail(email))
      return res.status(400).json({ error: "أدخل بريدًا إلكترونيًا صحيحًا" });
    if (!password)
      return res.status(400).json({ error: "أدخل كلمة المرور" });

    const customer = await Customer.findOne({ email }).select("_id email firstName lastName phone passwordHash emailVerified");

    if (!customer || !customer.passwordHash)
      return res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });

    const inputHash = hashPassword(password);
    let match = false;
    try {
      match = crypto.timingSafeEqual(
        Buffer.from(inputHash, "hex"),
        Buffer.from(customer.passwordHash, "hex")
      );
    } catch { match = false; }

    if (!match)
      return res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });

    customer.lastLoginAt = new Date();
    await customer.save();

    const token = signSession(customer._id.toString());
    setSessionCookie(res, token);

    return res.json({
      ok: true,
      user: {
        id: customer._id,
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
      },
    });
  } catch (err) {
    console.error("[auth/login]", err.message);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ─── FORGOT PASSWORD: Send OTP ────────────────────────────────────────────────
// POST /api/customers/auth/forgot/request
router.post("/auth/forgot/request", requestLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email || !isValidEmail(email))
      return res.status(400).json({ error: "أدخل بريدًا إلكترونيًا صحيحًا" });

    const customer = await Customer.findOne({ email }).select("_id").lean();
    // Always return ok to not leak existence
    if (!customer)
      return res.json({ ok: true, _otp: null, notFound: true });

    const recent = await Otp.findOne({
      email,
      purpose: "forgot",
      used: false,
      expiresAt: { $gt: new Date() },
      createdAt: { $gt: new Date(Date.now() - COOLDOWN_MS) },
    }).select("createdAt").lean();

    if (recent)
      return res.status(429).json({ error: "تم إرسال رمز مؤخرًا، انتظر دقيقة", cooldown: true });

    await Otp.updateMany({ email, purpose: "forgot", used: false }, { $set: { used: true } });

    const otp = generateOtp();
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await Otp.create({ email, otpHash, purpose: "forgot", expiresAt });

    return res.json({ ok: true, _otp: otp });
  } catch (err) {
    console.error("[forgot/request]", err.message);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ─── FORGOT PASSWORD: Verify OTP + Reset ─────────────────────────────────────
// POST /api/customers/auth/forgot/verify
router.post("/auth/forgot/verify", verifyLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();
    const newPassword = String(req.body.newPassword || "").trim();

    if (!email || !isValidEmail(email))
      return res.status(400).json({ error: "بريد إلكتروني غير صحيح" });
    if (!/^\d{6}$/.test(otp))
      return res.status(400).json({ error: "رمز التحقق يجب أن يكون 6 أرقام" });
    if (!newPassword || newPassword.length < 6)
      return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });

    const record = await Otp.findOne({
      email,
      purpose: "forgot",
      used: false,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!record)
      return res.status(400).json({ error: "انتهت صلاحية الرمز أو غير موجود", code: "EXPIRED" });

    if (record.attempts >= MAX_ATTEMPTS) {
      record.used = true;
      await record.save();
      return res.status(400).json({ error: "تجاوزت الحد المسموح من المحاولات", code: "MAX_ATTEMPTS" });
    }

    const inputHash = hashOtp(otp);
    let match = false;
    try {
      match = crypto.timingSafeEqual(
        Buffer.from(inputHash, "hex"),
        Buffer.from(record.otpHash, "hex")
      );
    } catch { match = false; }

    if (!match) {
      record.attempts += 1;
      await record.save();
      const remaining = MAX_ATTEMPTS - record.attempts;
      return res.status(400).json({ error: "رمز التحقق غير صحيح", code: "INVALID", attemptsLeft: remaining > 0 ? remaining : 0 });
    }

    record.used = true;
    await record.save();

    await Customer.findOneAndUpdate(
      { email },
      { $set: { passwordHash: hashPassword(newPassword) } }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("[forgot/verify]", err.message);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ─── ME ───────────────────────────────────────────────────────────────────────
router.get("/auth/me", requireCustomer, async (req, res) => {
  try {
    const customer = await Customer.findById(req.customerId)
      .select("email firstName lastName phone emailVerified")
      .lean();

    if (!customer) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "غير مصرح" });
    }

    return res.json({
      authenticated: true,
      user: {
        id: customer._id,
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
        emailVerified: customer.emailVerified,
      },
    });
  } catch (err) {
    console.error("[auth/me]", err.message);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
router.post("/auth/logout", (req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
});

// ─── PROFILE UPDATE ───────────────────────────────────────────────────────────
router.patch("/profile", requireCustomer, async (req, res) => {
  try {
    const ALLOWED = ["firstName", "lastName", "phone"];
    const update = {};

    for (const field of ALLOWED) {
      if (req.body[field] !== undefined) {
        const val = String(req.body[field]).trim();
        if (field === "phone" && val && !/^[\d\s\+\-\(\)]{5,20}$/.test(val))
          return res.status(400).json({ error: "رقم الهاتف غير صحيح" });
        if ((field === "firstName" || field === "lastName") && val.length > 50)
          return res.status(400).json({ error: "الاسم طويل جدًا" });
        update[field] = val;
      }
    }

    if (!Object.keys(update).length)
      return res.status(400).json({ error: "لا توجد بيانات للتحديث" });

    const customer = await Customer.findByIdAndUpdate(
      req.customerId,
      { $set: update },
      { new: true, select: "email firstName lastName phone" }
    ).lean();

    if (!customer) return res.status(404).json({ error: "المستخدم غير موجود" });

    return res.json({
      ok: true,
      user: { id: customer._id, email: customer.email, firstName: customer.firstName, lastName: customer.lastName, phone: customer.phone },
    });
  } catch (err) {
    console.error("[profile]", err.message);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ─── MY ORDERS ───────────────────────────────────────────────────────────────
const Checkout = require("../models/Checkout");

router.get("/orders", requireCustomer, async (req, res) => {
  try {
    const customer = await Customer.findById(req.customerId).select("email phone").lean();
    if (!customer) return res.status(401).json({ error: "غير مصرح" });

    const orders = await Checkout.find({
      $or: [
        { whatsapp: customer.phone },
        { customer: { $regex: customer.email, $options: "i" } },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .select("orderId items total status createdAt shipping")
      .lean();

    return res.json({ ok: true, orders });
  } catch (err) {
    console.error("[orders]", err.message);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

module.exports = router;
module.exports.requireCustomer = requireCustomer;
