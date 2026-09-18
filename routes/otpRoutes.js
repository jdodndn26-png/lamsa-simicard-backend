const express = require("express");
const crypto = require("crypto");
const { rateLimit } = require("express-rate-limit");

function safeIpKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}
const Otp = require("../models/Otp");

const router = express.Router();

const VALID_PURPOSES = ["checkout", "login", "register", "forgot"];
const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 60 * 1000;

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  keyGenerator: (req) => {
    const email = (req.body?.email || "").toLowerCase().trim();
    return `send:${email}:${safeIpKey(req)}`;
  },
  message: { error: "طلبات كثيرة، حاول بعد دقيقة" },
  standardHeaders: true,
  legacyHeaders: false,
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => {
    const email = (req.body?.email || "").toLowerCase().trim();
    return `verify:${email}:${safeIpKey(req)}`;
  },
  message: { error: "طلبات كثيرة، حاول لاحقًا" },
  standardHeaders: true,
  legacyHeaders: false,
});

function hashOtp(otp) {
  const secret = process.env.OTP_HASH_SECRET;
  if (!secret) throw new Error("OTP_HASH_SECRET is not set");
  return crypto.createHmac("sha256", secret).update(otp).digest("hex");
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

// POST /api/otp/send
router.post("/send", sendLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { purpose } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "بريد إلكتروني غير صحيح" });
    }
    if (!VALID_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: "غرض غير صحيح" });
    }

    // cooldown: منع إرسال أكثر من OTP خلال دقيقة لنفس email+purpose
    const recent = await Otp.findOne({
      email,
      purpose,
      used: false,
      expiresAt: { $gt: new Date() },
      createdAt: { $gt: new Date(Date.now() - COOLDOWN_MS) },
    }).select("createdAt").lean();

    if (recent) {
      return res.status(429).json({
        error: "تم إرسال رمز مؤخرًا، انتظر دقيقة قبل إعادة الإرسال",
        cooldown: true,
      });
    }

    // إلغاء أي OTP قديم غير مستخدم لنفس email+purpose
    await Otp.updateMany(
      { email, purpose, used: false },
      { $set: { used: true } }
    );

    const otp = generateOtp();
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await Otp.create({ email, otpHash, purpose, expiresAt });

    // إرسال OTP عبر Next.js frontend (Gmail API)
    // نعيد OTP للـ frontend route ليرسله عبر Gmail
    // لكن لا نعيده للعميل مباشرة
    return res.json({ ok: true, _otp: otp });
  } catch (err) {
    console.error("[otp/send error]", err.message);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/otp/verify
router.post("/verify", verifyLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { otp, purpose } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "بريد إلكتروني غير صحيح" });
    }
    if (!otp || !/^\d{6}$/.test(String(otp))) {
      return res.status(400).json({ error: "رمز التحقق يجب أن يكون 6 أرقام" });
    }
    if (!VALID_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: "غرض غير صحيح" });
    }

    const record = await Otp.findOne({
      email,
      purpose,
      used: false,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!record) {
      return res.status(400).json({ error: "رمز التحقق منتهي أو غير موجود", code: "EXPIRED" });
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      record.used = true;
      await record.save();
      return res.status(400).json({ error: "تجاوزت الحد المسموح من المحاولات", code: "MAX_ATTEMPTS" });
    }

    const inputHash = hashOtp(String(otp));
    let match = false;
    try {
      match = crypto.timingSafeEqual(
        Buffer.from(inputHash, "hex"),
        Buffer.from(record.otpHash, "hex")
      );
    } catch {
      match = false;
    }

    if (!match) {
      record.attempts += 1;
      await record.save();
      const remaining = MAX_ATTEMPTS - record.attempts;
      return res.status(400).json({
        error: "رمز التحقق غير صحيح",
        code: "INVALID",
        attemptsLeft: remaining > 0 ? remaining : 0,
      });
    }

    record.used = true;
    await record.save();

    return res.json({ ok: true });
  } catch (err) {
    console.error("[otp/verify error]", err.message);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

module.exports = router;
