# Online fee payment

Students and parents can pay fees from the portal ("Fee information" > "Pay online"). Finance sees every attempt under "Online payments".
A paid attempt produces the **normal receipt** (mode "Online"), so reports, defaulters and receipts need no changes.

## How it works (same for the test gateway and Razorpay)

1. The server works out the amount from the student's open dues (the browser never sends an amount) and asks the gateway for an *order*.
2. The student pays in the gateway's window.
3. The browser hands back a **signed** result. The server checks the signature, then settles.
4. The gateway also sends a **signed webhook** (`POST /api/payments/webhook`) in case the browser was closed. Settling happens once, whichever arrives first.
5. If the dues changed meanwhile (for example the office took cash), the money is flagged **Needs your attention** for finance instead of being lost or double-counted.

## Trying it with no Razorpay account

`PAYMENT_PROVIDER=mock` (the default when not in production). The fee page shows a "Test mode" note and a pretend bank window with three buttons:
pay successfully, payment fails, and "pay, then the browser closes" (which exercises the webhook path). The same signing rules as Razorpay are used.
The test gateway refuses to start in production.

## Going live with Razorpay (checklist)

1. Create the Razorpay account and complete KYC. Start with **test keys** (`rzp_test_...`) on a staging copy of the app.
2. Set `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` on the server (never in the frontend).
3. In the Razorpay dashboard add a webhook to `https://<your-api>/api/payments/webhook` with the events `payment.captured`, `order.paid` and `payment.failed`, and the same secret as `RAZORPAY_WEBHOOK_SECRET`.
4. Run a few test-mode payments end to end (card, UPI, a failed one, and close the window after paying).
5. Only then switch to live keys.

`src/services/gateway/razorpay.js` is written from Razorpay's public documentation and has **not** been run against a live account yet.

## Decisions still open

- **Whose Razorpay account receives the money?** Today there is one account for the whole app. In a multi-school product each school normally needs its own account (or Razorpay Route to split payouts); money going to the platform account first has legal and tax consequences. Decide before going live.
- Refunds are done in the Razorpay dashboard; the app does not issue them yet.
- A per-school on/off switch (`settings.finance.onlinePayments`) is honoured but has no screen yet.
- The one-time "pay the whole year in advance" offer is still the finance desk only.
