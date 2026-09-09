# 🚀 NAYE CUSTOMER ONBOARDING CHECKLIST — BizzAuto CRM

> Ye checklist naye customer ke live setup ke liye hai. Har step 5 min se kam hai.
> Seales person: customer ko demo dete waqt ye list screen pe share karo.

---

## STEP 0 — Account Create (2 min) 🔑

| # | Kaam | Kahan |
|---|------|-------|
| 0.1 | Customer ko invite bhejo (ya khud signup karo) | `https://bizzautoai.com/register` |
| 0.2 | Business name + email + password set | Signup form |
| 0.3 | Onboarding wizard complete karo (business type select) | Auto-shuru hota hai |
| 0.4 | Plan activate karo (Razorpay link bhejo) | Billing page |

✅ **Check:** Dashboard khul gaya + business name sahi dikhta hai

---

## STEP 1 — WhatsApp Connect (5 min) 💬

Customer ke paas kaunsa hai, pehle poochho:

### Option A: Meta Official (WhatsApp Business API)
| # | Kaam | Kahan |
|---|------|-------|
| A1 | Meta Business Account banao (agar nahi hai) | business.facebook.com |
| A2 | Phone number verify + Business verification | Meta Business Settings |
| A3 | CRM → WhatsApp → Connect → **Meta** tab → credentials | `bizzautoai.com/whatsapp` |
| A4 | Webhook URL Meta dashboard me daalo (screen pe dikhta hai) | Meta App → WhatsApp → Configuration |

### Option B: Evolution API (QR wala — turant chalu, unofficial)
| # | Kaam | Kahan |
|---|------|-------|
| B1 | Evolution server credentials ready rakho (tum denge) | — |
| B2 | CRM → WhatsApp → **Evolution** tab → Base URL + API Key + Instance | `bizzautoai.com/whatsapp` |
| B3 | QR scan karo customer ke phone se | Screen pe QR |

⚠️ **Note:** Evolution = risk of number ban (WhatsApp policy). Meta Official = safe but verification lags. Naye customers ko Meta recommend karo.

✅ **Check:** WhatsApp → Chats tab → test message bhejo

---

## STEP 2 — Email BYOK: Apna Brevo Connect (5 min) 📧

> **Iske bina customer ke emails TUMHARE platform account se jayenge (quota burn). Ye step MUST hai.**

| # | Kaam | Kahan |
|---|------|-------|
| 2.1 | Customer **khud** brevo.com pe free account banaye (uske email se) | brevo.com |
| 2.2 | Brevo dashboard → **SMTP & API** → **API Key** generate karo | app.brevo.com/settings/keys/api |
| 2.3 | Brevo me **sender email verify** karo (customer ka domain/email) | app.brevo.com/settings/senders |
| 2.4 | CRM → Settings → **Brevo Email Settings** → API key paste → Connect | `bizzautoai.com` → Settings |
| 2.5 | Senders me address add: `defaultFromEmail` (Brevo verify hone ke baad hi) | Same page |

✅ **Check:** Status page pe "Connected" + customer ka Brevo email dikhe
📧 **Quota:** Ab 300 emails/day **customer ke apne account se** (tumhara cost ₹0)
💰 **Upsell:** Customer ko bolo Brevo free plan se Lite/Advanced pe jaye (unlimited-ish) — wo khud pay karega

---

## STEP 3 — BizzBills (Invoice) — SIRF BUNDLE CUSTOMERS (2 min) 🧾

> Agar customer ne **CRM + BizzBills bundle** liya hai:

| # | Kaam | Kahan |
|---|------|-------|
| 3.1 | CRM me login rakho → Sidebar → **BillInvoice** click | `bizzautoai.com/whatsapp` → Tools |
| 3.2 | **One-click login** hoga — BizzBills dashboard khul jayega (bina password) | Auto-bridge |
| 3.3 | BizzBills me Organization details bharo (GSTIN, address, logo) | invoice.bizzautoai.com/settings |
| 3.4 | Invoice template + UPI ID set karo | BizzBills Settings |

⚠️ **CRM-only customer hai?** Ye section SKIP karo — BillInvoice sidebar me dikhega hi nahi.

✅ **Check:** BillInvoice → Dashboard me org name dikhta hai

---

## STEP 4 — PhonePe Payments (5 min, jab PhonePe account ho) 💰

| # | Kaam | Kahan |
|---|------|-------|
| 4.1 | Customer apna **PhonePe Business** merchant onboarding kare | business.phonepe.com |
| 4.2 | MID + Salt Key copy karo | PhonePe Dashboard → Settings |
| 4.3 | Coolify → CRM App → Environment me customer-level vars (agar per-tenant support chahiye to batao, platform default abhi env-based hai) | — |
| 4.4 | Test payment lo (₹1) | Store checkout se |

✅ **Check:** Store checkout pe PhonePe option dikhe + ₹1 payment success

---

## STEP 5 — Contacts & Pehli Campaign (10 min) 👥

| # | Kaam | Kahan |
|---|------|-------|
| 5.1 | Contacts import (CSV) ya WhatsApp se sync | CRM → Contacts → Import |
| 5.2 | 1 test contact + 1 test deal banao | CRM |
| 5.3 | Pehli broadcast bhejo (10 contacts pe, apne team numbers pe) | WhatsApp → Broadcast |
| 5.4 | Email test bhejo khud ko (Brevo se hi jayega — verify) | Email Marketing → Test |

✅ **Check:** WhatsApp delivered + Email inbox me aaya (SPAM me nahi)

---

## STEP 6 — Training (20 min, screen share) 🎓

Customer ko ye 5 cheezein dikhao:
1. **Dashboard** — kya metrics kahan
2. **CRM pipeline** — lead add → deal move → close
3. **WhatsApp** — chat reply, template send, broadcast
4. **Campaigns** — banana + schedule
5. **Reports** — daily check kya kare

Bonus: keyboard shortcuts (`Ctrl+C` CRM, `Ctrl+W` WhatsApp, `Ctrl+D` Dashboard)

---

## ⚡ QUICK TROUBLESHOOTING

| Problem | Fix |
|---------|-----|
| WhatsApp connect nahi ho raha | Evolution instance status check karo (Coolify) ya Meta app review status |
| Email spam me ja raha | Brevo sender verify + SPF/DKIM DNS records add karvao customer ke domain pe |
| Email 300 limit khatam | Brevo Lite plan le unse, ya agli bhejne se pehle wait |
| BillInvoice me login maang raha | CRM se fresh BillInvoice click karo (bridge token 60s ka hota hai) |
| PhonePe fail | MID + Salt Key + ENV=UAT/PROD match karo, callback URL whitelist check |

---

## 📋 SALES PERSON CHECKLIST (customer go-live se pehle)

- [ ] Account created + plan active
- [ ] WhatsApp connected (Meta preferred)
- [ ] **Brevo BYOK connected (customer ka apna account)** ← critical, warna tumhara quota burn
- [ ] Test WhatsApp + Email bheja, dono received
- [ ] BizzBills bundle? → bridge test kiya
- [ ] First campaign demo diya
- [ ] Training session complete
- [ ] Customer ko ye file PDF bhej di
