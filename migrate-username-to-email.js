/**
 * migrate-username-to-email.js
 *
 * מיגרציה חד-פעמית: ממיר משתמשים קיימים משדה `username` לשדה `email`.
 *
 * למה זה לא אוטומטי לגמרי:
 * ה-username הישן לא היה בהכרח כתובת מייל, אז אין מאיפה "להמציא" מייל אמיתי
 * למשתמש שה-username שלו לא נראה כמו מייל. הסקריפט הזה:
 *   1. עובר על כל משתמש בקולקציית users (גישה ישירה ל-DB, לא דרך מודל Mongoose,
 *      כדי לא להתנגש עם הסכימה החדשה שדורשת email).
 *   2. אם ה-username כבר נראה כמו מייל תקין -> ממיר אוטומטית (email = username).
 *   3. אם יש לו כבר מיפוי ידני ב-MANUAL_MAP למטה -> משתמש בו.
 *   4. אחרת -> לא נוגע במשתמש הזה בכלל, ומדפיס אותו ברשימת "טעון טיפול ידני".
 *
 * ברירת מחדל: DRY RUN (רק מדפיס מה היה קורה, לא נוגע ב-DB).
 * להרצה אמיתית: node scripts/migrate-username-to-email.js --apply
 *
 * דרישות: .env עם MONGO_URI מוגדר (אותו קובץ שהשרת עצמו משתמש בו).
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/clicker-db';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APPLY = process.argv.includes('--apply');

// ===== מיפוי ידני: מלא כאן usernames שאינם בפורמט מייל, לפני הרצה עם --apply =====
// לדוגמה: 'yossi123': 'yossi@example.com'
const MANUAL_MAP = {
    // 'username_ישן': 'email@אמיתי.co.il',

    'רחלי': 'r0556766587@gmail.com',
    'רחלי טורצין':'r0556766587@gmail.com'
};

async function main() {
    console.log(APPLY ? '=== מצב אמיתי (--apply) - ישנה את ה-DB ===' : '=== DRY RUN - לא נוגע ב-DB, רק מדפיס ===');

    await mongoose.connect(MONGO_URI);
    const users = mongoose.connection.collection('users');

    const all = await users.find({}).toArray();
    console.log(`נמצאו ${all.length} משתמשים בקולקציה.\n`);

    let alreadyMigrated = 0;
    let autoConverted = 0;
    let manuallyMapped = 0;
    const unresolved = [];

    for (const doc of all) {
        if (doc.email) {
            alreadyMigrated++;
            continue;
        }

        const oldUsername = doc.username;
        if (!oldUsername) {
            unresolved.push({ _id: doc._id, reason: 'אין גם username וגם email - מקרה חריג, לבדוק ידנית' });
            continue;
        }

        let newEmail = null;
        if (EMAIL_RE.test(oldUsername)) {
            newEmail = oldUsername.toLowerCase();
        } else if (MANUAL_MAP[oldUsername]) {
            newEmail = MANUAL_MAP[oldUsername].toLowerCase();
            if (!EMAIL_RE.test(newEmail)) {
                unresolved.push({ _id: doc._id, username: oldUsername, reason: `המיפוי הידני "${newEmail}" עצמו לא נראה כמו מייל תקין` });
                continue;
            }
        } else {
            unresolved.push({ _id: doc._id, username: oldUsername, reason: 'לא בפורמט מייל, ואין מיפוי ידני ב-MANUAL_MAP' });
            continue;
        }

        // בדיקת התנגשות: אולי יש כבר משתמש אחר עם אותו email (אחרי לואוורקייס)
        const clash = all.find((u) => u._id.toString() !== doc._id.toString() && (u.email === newEmail));
        if (clash) {
            unresolved.push({ _id: doc._id, username: oldUsername, reason: `ה-email "${newEmail}" כבר שייך למשתמש אחר (${clash._id}) - התנגשות, לטפל ידנית` });
            continue;
        }

        const wasManual = !!MANUAL_MAP[oldUsername];
        console.log(`${wasManual ? '[מיפוי ידני]' : '[אוטומטי]'} ${oldUsername}  ->  ${newEmail}`);

        if (APPLY) {
            await users.updateOne(
                { _id: doc._id },
                { $set: { email: newEmail }, $unset: { username: '' } }
            );
        }

        if (wasManual) manuallyMapped++; else autoConverted++;
    }

    console.log('\n--- סיכום ---');
    console.log(`כבר היה email מוגדר (לא נגענו): ${alreadyMigrated}`);
    console.log(`הומרו אוטומטית (username כבר נראה כמו מייל): ${autoConverted}`);
    console.log(`הומרו לפי מיפוי ידני (MANUAL_MAP): ${manuallyMapped}`);
    console.log(`טעונים טיפול ידני (לא נגענו): ${unresolved.length}`);

    if (unresolved.length) {
        console.log('\n--- רשימת המשתמשים שטעונים טיפול ידני ---');
        unresolved.forEach((u) => console.log(`  _id=${u._id}  username=${u.username || '(אין)'}  סיבה: ${u.reason}`));
        console.log('\nכדי לטפל בהם: הוסף שורה מתאימה ל-MANUAL_MAP למעלה (username -> email אמיתי) והרץ שוב.');
    }

    if (!APPLY) {
        console.log('\nזה היה DRY RUN בלבד. שום דבר לא השתנה ב-DB.');
        console.log('כשתהיה מרוצה מהתוצאה: node scripts/migrate-username-to-email.js --apply');
    } else {
        console.log('\nהמיגרציה בוצעה בפועל.');
    }

    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('שגיאה בהרצת המיגרציה:', err);
    process.exit(1);
});
