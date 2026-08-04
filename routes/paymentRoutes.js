const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Payment = require('../models/Payment');
const Game = require('../models/Game');
const { requireAuth, requireGameOwnership } = require('../middleware/auth');

// ===== הגדרות תשלום - שלב 5 =====
// לפי סיכום עם המשתמש: 15 ש"ח פותחים 50 שעות (זמן קלנדרי מרגע התשלום, לא
// שעות שימוש בפועל) של גישה מורחבת בלי מגבלת 3 המשתתפים - per-game (על
// המשחק הספציפי הזה בלבד, לא על כל המשחקים של המשתמש).
const PAYMENT_AMOUNT_ILS = 15;
const EXTENDED_ACCESS_HOURS = 50;

const NEDARIM_MOSAD = process.env.NEDARIM_MOSAD;
const NEDARIM_API_VALID = process.env.NEDARIM_API_VALID;
// אופציונלי - מייל להתראה אם ה-CallBack שלנו נכשל מהצד שלהם. חובה כשעובדים
// מול מוסד הבדיקות (Mosad=0) של נדרים פלוס.
const NEDARIM_CALLBACK_ERROR_EMAIL = process.env.NEDARIM_CALLBACK_ERROR_EMAIL;
// כתובות ה-IP הרשמיות שמהן נדרים פלוס שולחים CallBack - לפי התיעוד הרשמי.
// חובה ש-server.js יגדיר app.set('trust proxy', ...) אחרת req.ip לא ישקף
// את הכתובת האמיתית מאחורי ה-proxy של Render.
const NEDARIM_CALLBACK_IPS = ['18.196.146.117', '18.194.219.73'];

// ===== שלב 1: יצירת עסקה בצד השרת (הזרימה המומלצת בתיעוד נדרים פלוס - =====
// הסכום נקבע כאן בשרת ולא ניתן לשינוי בצד הלקוח, בניגוד לזרימת FinishTransaction2)
// gameId חובה בגוף הבקשה - התשלום פותח גישה מלאה למשחק הזה בלבד. requireGameOwnership
// מוודא שהמשחק אכן שייך למי ששולח את הבקשה (או שהוא מנהל-על, אבל מנהל-על ממילא
// לא צריך לשלם - ראו הבדיקה למטה).
router.post('/:gameId/create', requireAuth, requireGameOwnership, async (req, res) => {
  if (req.auth.role !== 'user') {
    return res.status(400).json({ error: 'רק משתמש רגיל יכול לרכוש גישה מורחבת - למנהל-על יש גישה מלאה בלי תשלום' });
  }
  if (!NEDARIM_MOSAD || !NEDARIM_API_VALID) {
    console.error('❌ חסרים משתני סביבה NEDARIM_MOSAD / NEDARIM_API_VALID');
    return res.status(500).json({ error: 'תשלומים אינם זמינים כרגע - חסרה הגדרת שרת, פנה למנהל המערכת' });
  }

  const paramId = crypto.randomUUID();
  const payment = await Payment.create({
    user: req.auth.userId,
    game: req.game._id,
    paramId,
    amount: PAYMENT_AMOUNT_ILS,
    status: 'pending'
  });

  const callbackUrl = `${req.protocol}://${req.get('host')}/payments/nedarim-callback`;

  try {
    const form = new URLSearchParams({
      Mosad: NEDARIM_MOSAD,
      ApiValid: NEDARIM_API_VALID,
      PaymentType: 'Ragil',
      Amount: String(PAYMENT_AMOUNT_ILS),
      Currency: '1',
      Tashlumim: '1',
      Comment: `קעמפ-קליק - גישה מלאה 50 שעות (${req.game.name})`,
      Param1: paramId,
      CallBack: callbackUrl,
      ...(NEDARIM_CALLBACK_ERROR_EMAIL ? { CallBackMailError: NEDARIM_CALLBACK_ERROR_EMAIL } : {}),
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
    console.warn(`⚠️ שרשרת מלאה (x-forwarded-for): "${req.headers['x-forwarded-for'] || '(חסר)'}"`);
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
    // הערה: לפי תיעוד נדרים פלוס, שדה Amount אינו מובטח ב-JSON של ה-CallBack
    // (המסמך מציין רק Status/Message/ID/Confirmation/LastNum כמובטחים).
    // לכן בודקים התאמה רק אם השדה בכלל הגיע - כדי לא לחסום אישור תשלום אמיתי
    // בגלל שדה חסר. ה-Param1 הייחודי + כתובת ה-IP המאומתת הם האימות המרכזי.
    if (Amount !== undefined && Number(Amount) !== payment.amount) {
      console.warn(`⚠️ אי-התאמת סכום ב-callback עבור paramId=${Param1}: צפוי ${payment.amount}, התקבל ${Amount}`);
      return res.status(200).send('ignored: amount mismatch');
    }

    payment.status = 'approved';
    payment.approvedAt = new Date();
    await payment.save();

    // שלב 5 (עדכון): הגישה המורחבת נפתחת על המשחק הספציפי (payment.game),
    // לא על כל המשחקים של המשתמש.
    const game = await Game.findById(payment.game);
    if (game) {
      const base = (game.paidUntil && game.paidUntil > new Date()) ? game.paidUntil : new Date();
      game.paidUntil = new Date(base.getTime() + EXTENDED_ACCESS_HOURS * 60 * 60 * 1000);
      await game.save();
      console.log(`✅ תשלום אושר: game="${game.name}" (${game._id}) paidUntil=${game.paidUntil.toISOString()}`);
    } else {
      console.warn(`⚠️ callback אושר אבל המשחק המקושר (${payment.game}) לא נמצא - יתכן שנמחק`);
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

module.exports = router;
