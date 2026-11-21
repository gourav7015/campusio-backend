# If personal data may have been exposed

A short plan to follow, not a legal opinion. Under India's Digital Personal Data Protection Act the school (the data fiduciary) and AtKaksha (its processor) have duties after a breach; confirm the exact notice and timing rules with a lawyer before relying on this.

## First hour: stop it
1. **Contain.** Disable the affected account (Platform → school → administrator, or School admin → user). Sign everyone out: change `JWT_SECRET` (set the old one as `JWT_SECRET_PREVIOUS` only if you do *not* want to force sign-out; leave it out to end every session).
2. **If a secret leaked** (database password, `JWT_SECRET`, `DATA_KEY`, Razorpay or Resend key): rotate it now (see OPERATIONS.md, "Rotating secrets") and the database password in Atlas.
3. **Keep the evidence.** Do not delete logs. Note the time you found out, what you saw, and who saw it. Copy the relevant rows of the audit log (Platform → Audit) and the error list (Platform → Errors).

## Same day: understand it
4. Which school or schools, which people (students, parents, teachers, staff), which details (names, dates of birth, phone numbers, addresses, fee records, documents).
5. How it happened and whether it is still possible. The audit log shows each sign-in and each Platform Administrator action inside a school.
6. Fix the cause before telling people it is fixed.

## Then: tell the right people
7. The School Admin of every affected school, in writing, with what is known and not known.
8. The schools decide, with their adviser, whether the Data Protection Board and the families must be told, and how fast. Give them the facts from step 4 to help them.
9. Families: a plain message saying what happened, what details were involved, what they should do (for example change a reused password), and who to contact.

## After
10. Write down what happened, what was done and what changes (a new test, a new alert, a changed procedure). Add it to `AUDIT_REPORT.md`.
11. Check backups: a restore of an older copy brings back older data, including people who were erased since.

Contacts to fill in before they are needed: school grievance officer, AtKaksha support address, the person holding the Atlas, Render and Cloudflare accounts.
