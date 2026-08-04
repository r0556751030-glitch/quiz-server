const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

// ===== הגדרות תשלום - שלב 5 =====
// לפי סיכום עם המשתמש: 15 ש"ח פותחים 50 שעות (זמן קלנדרי מרגע התשלום, לא
// שעות שימוש בפועל) של גישה מורחבת בלי מגבלת 3 המשתתפים - ברמת המשתמש/חשבון,
// לכל המשחקים שלו (לא per-game).
const PAYMENT_AMOUNT_ILS = 15;
const EXTENDED_ACCESS_HOURS = 50;

const NEDARIM_MOSAD = process.env.NEDARIM_MOSAD;
const NEDARIM_API_VALID = process.env.NEDARIM_API_VALID;
// כתובות ה-IP הרשמיות שמהן נדרים פלוס שולחים CallBack - לפי התיעוד הרשמי.
// חובה ש-server.js יגדיר app.set('trust proxy', ...) אחרת req.ip לא ישקף
// את הכתובת האמיתית מאחורי ה-proxy של Render.
const NEDARIM_CALLBACK_IPS = ['18.196.146.117', '18.194.219.73'];

// ===== שלב 1: יצירת עסקה בצד השרת (הזרימה המומלצת בתיעוד נדרים פלוס - =====
// הסכום נקבע כאן בשרת ולא ניתן לשינוי בצד הלקוח, בניגוד לזרימת FinishTransaction2)
router.post('/create', requireAuth, async (req, res) => {
  if (req.auth.role !== 'user') {
    return res.status(400).json({ error: 'רק משתמש רגיל יכול לרכוש גישה מורחבת' });
  }
  if (!NEDARIM_MOSAD || !NEDARIM_API_VALID) {
    console.error('❌ חסרים משתני סביבה NEDARIM_MOSAD / NEDARIM_API_VALID');
    return res.status(500).json({ error: 'תשלומים אינם זמינים כרגע - חסרה הגדרת שרת, פנה למנהל המערכת' });
  }

  const paramId = crypto.randomUUID();
  const payment = await Payment.create({ user: req.auth.userId, paramId, amount: PAYMENT_AMOUNT_ILS, status: 'pending' });

  const callbackUrl = `${req.protocol}://${req.get('host')}/payments/nedarim-callback`;

  try {
    const form = new URLSearchParams({
      Mosad: NEDARIM_MOSAD,
      ApiValid: NEDARIM_API_VALID,
      PaymentType: 'Ragil',
      Amount: String(PAYMENT_AMOUNT_ILS),
      Currency: '1',
      Tashlumim: '1',
      Comment: 'קעמפ-קליק - גישה מורחבת 50 שעות',
      Param1: paramId,
      CallBack: callbackUrl,
      AjaxId: String(Date.now()) // מומלץ ע"י נדרים - מונע חיוב כפול על תקלת תקשורת
    });

    const nedarimRes = await fetch(
      'https://matara.pro/nedarimplus/V6/Files/WebServices/DebitIframe.aspx?Action=CreateTransaction',
      { method: 'POST', body: form }
    );
    const data = await nedarimRes.json();

    if (data.Status !== 'OK') {
      payment.status = 'error';
      await payment.save();
      return res.status(502).json({ error: data.Message || 'שגיאה ביצירת עסקה מול נדרים פלוס' });
    }

    payment.nedarimTransactionId = data.ID;
    await payment.save();

    res.json({ success: true, transactionId: data.ID, paramId, mosad: NEDARIM_MOSAD });
  } catch (err) {
    console.error('❌ שגיאה ביצירת עסקת נדרים פלוס:', err.message);
    payment.status = 'error';
    await payment.save();
    res.status(500).json({ error: 'שגיאה ביצירת עסקה - נסה שוב' });
  }
});

// ===== שלב 3: קליטת עדכון אמיתי מנדרים פלוס - המקור האמין היחיד לאישור =====
// תשלום. לעולם לא סומכים על TransactionResponse שמגיע לדפדפן (ניתן לזיוף).
// חשוב: תמיד עונים 200 (גם על כשל אימות) - נדרים שולחים את זה פעם אחת בלבד,
// אין טעם ב-retry מצידם על תגובת שגיאה, וזה רק יבלבל את הלוגים שלהם.
router.post('/nedarim-callback', async (req, res) => {
  const sourceIp = req.ip;
  if (!NEDARIM_CALLBACK_IPS.includes(sourceIp)) {
    console.warn(`⚠️ callback מנדרים פלוס מכתובת IP לא מוכרת: "${sourceIp}" - נבדוק trust proxy אם זה קורה תמיד`);
    return res.status(200).send('ignored: unrecognized source ip');
  }

  const { Status, Param1, Amount } = req.body || {};
  if (Status !== 'OK' || !Param1) {
    return res.status(200).send('ignored: not a successful transaction');
  }

  try {
    const payment = await Payment.findOne({ paramId: Param1 });
    if (!payment) {
      console.warn(`⚠️ callback עם Param1 לא מוכר אצלנו: ${Param1}`);
      return res.status(200).send('ignored: unknown payment');
    }
    if (payment.status === 'approved') {
      return res.status(200).send('already processed'); // אידמפוטנטי
    }
    if (Number(Amount) !== payment.amount) {
      console.warn(`⚠️ אי-התאמת סכום ב-callback עבור paramId=${Param1}: צפוי ${payment.amount}, התקבל ${Amount}`);
      return res.status(200).send('ignored: amount mismatch');
    }

    payment.status = 'approved';
    payment.approvedAt = new Date();
    await payment.save();

    const user = await User.findById(payment.user);
    if (user) {
      const base = (user.paidUntil && user.paidUntil > new Date()) ? user.paidUntil : new Date();
      user.paidUntil = new Date(base.getTime() + EXTENDED_ACCESS_HOURS * 60 * 60 * 1000);
      await user.save();
      console.log(`✅ תשלום אושר: user=${user.email} paidUntil=${user.paidUntil.toISOString()}`);
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('❌ שגיאה בטיפול ב-callback של נדרים פלוס:', err.message);
    res.status(200).send('internal error, logged');
  }
});

// ===== ה-frontend סוקר את זה אחרי TransactionResponse=OK, עד שה-callback =====
// האמיתי מגיע ומעדכן את הסטטוס בפועל (יכול לקחת כמה שניות)
router.get('/status/:paramId', requireAuth, async (req, res) => {
  const payment = await Payment.findOne({ paramId: req.params.paramId, user: req.auth.userId });
  if (!payment) return res.status(404).json({ error: 'לא נמצא' });
  res.json({ status: payment.status });
});

// ===== סטטוס הגישה הנוכחי של המשתמש המחובר - להצגה ב-games.html =====
router.get('/my-access', requireAuth, async (req, res) => {
  if (req.auth.role !== 'user') return res.json({ paidUntil: null });
  const user = await User.findById(req.auth.userId).select('paidUntil');
  res.json({ paidUntil: user ? user.paidUntil : null });
});

module.exports = router;
