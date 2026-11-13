# Known limitations (honest list)

**Not built**
* No online payment gateway: Finance records cash/UPI/cheque/bank/card payments by hand (receipts are numbered PDFs). No advance payments or credit balances (a payment cannot exceed what is owed).
* Online homework submission and grading (the spec defers it) — students see homework, files and deadlines only.
* No parent/guardian portal (guardian details live on the student). No online-exam module.
* Library: no reservations/holds, no barcode scanner integration (the accession number is typed or scanned into a text box), no per-book acquisition records.
* Finance: no refunds to the family beyond reversing a receipt, no tax/GST invoices, no bank reconciliation, no multi-currency.
* Teacher assignments are not copied automatically to a new academic year (reassign after promotion); fee structures must exist per year.
* School logo, report-card/document templates, language translation (preference stored only).

**Engineering gaps**
* No MongoDB transactions. Multi-step writes (admission, promotion, import, payment) validate first and clean up or use conditional updates; a crash mid-promotion could leave a partial run (re-running skips processed students).
* Notifications are in-app only and created inline — no email/SMS, no queue/retry worker. Duplicates are prevented by dedupe keys.
* Files are on local disk; no object-storage adapter, virus scan or content sniffing beyond the declared MIME type.
* One login = one school. Tokens are kept in `sessionStorage` (cookie sessions would be stronger).
* One school-wide time zone; calendar days are `YYYY-MM-DD` strings.
* Some analytics are computed per request in application code — fine for a school, not tuned for huge tenants.
* Dockerfiles, deployment manifests, backups/restore and the GitHub Actions workflow have **not been executed**.
* Accessibility considered (labels tied to controls, roles, Escape) but not formally audited; layout is responsive but only visually checked at desktop width.

**Product decision to be aware of:** students can see all classmates' marks and ranks for tests of their class (requested explicitly); the original spec warned against exposing other students' performance. It is one function (`classExamDetail`) if this ever needs to be restricted.

* **Attendance times:** staff can check in/out themselves (optionally only inside a school location fence), the desk can type times, and a machine export can be imported as CSV. There is **no live connection to a biometric/fingerprint/face device** — the device's exported file is imported. The location fence uses the browser's GPS, which a determined person can fake; it is a deterrent, not proof.
* **Payroll output, not payment:** the system makes a bank-transfer file (NEFT-style CSV) and PF ECR / ESI / Professional Tax files and reports. It does **not** pay money, and does **not** file with EPFO or ESIC — the school uploads the files on those portals, which may reject a layout that changed. Files should be test-uploaded once before relying on them.
* **No income-tax (TDS) calculation or Form 16.** PF/ESI/PT rates and ceilings are editable in school settings and must be checked against current law by the school's accountant; Professional Tax slabs differ by state. Late arrivals are only a suggestion at the desk, not an automatic deduction; absences and half days are deducted.
* Staff leave balances are per school setting; there is no carry-forward or encashment at year end.
* The advance-payment discount applies to tuition only (not transport or other fees). Part-paid students, or students with a concession on an open month, do not qualify.
* A transport fare change does not alter months that are already billed.
