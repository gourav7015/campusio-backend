# Review against India's Digital Personal Data Protection Act, 2023

**This is an engineering review, not legal advice, and it does not say the product is compliant.** Several points below need a qualified Indian data-protection lawyer. The Act's rules and commencement dates should be confirmed with the lawyer at the time of launch; they were not looked up for this review.

## What personal data the product holds (from the data model)

| Group | Data | Sensitivity note |
|---|---|---|
| Students (children) | name, date of birth, gender, admission no., class/section, guardians (name, relation, phone), address, photo, uploaded documents, attendance, marks, remarks, fees and payments, library loans, bus stop | Children. Treat everything as sensitive |
| Teachers and staff | name, employee id, phone, email, qualifications, attendance, leave, check-in/out times, check-in location (only if the school enables the location fence), salary, bank account, PAN, UAN, ESI number | Financial and identity numbers |
| All users | login id, password hash, role, last sign-in, per-session IP address and device description, audit trail of actions | Security logs |

## Roles

The school decides the purpose of processing, so it is the **Data Fiduciary**; the platform operator acts as a **Data Processor** for the school. The privacy policy draft says this, with a placeholder asking the lawyer to confirm, including anything the operator decides for itself (sign-in security logs). A written processing agreement between the operator and each school is needed and does not exist yet.

## Findings

| # | Area | What the product does today | Gap / action | Level |
|---|---|---|---|---|
| 1 | Notice | Privacy policy drafted from what the software really does | Needs company details, lawyer review, publication, and a way for schools to show it to parents | HIGH |
| 2 | Consent for children | No parental-consent record in the product | The Act requires verifiable consent of a parent/guardian for a child's data (with limited exceptions). Decide how each school records it; consider a consent log per student | HIGH |
| 3 | Children: tracking and ads | None: no analytics, ads, profiling or third-party scripts (checked in the build) | Keep it so; the student "achievements" are computed from the student's own records and are not shared or compared | OK / watch |
| 4 | Purpose limitation and minimisation | Data fields are those a school needs; optional fields exist (address, photo) | Each school should switch off fields it does not need; consider making address/photo optional per school setting | MEDIUM |
| 5 | Access, correction, erasure | Admin can correct records. Students/parents cannot self-serve. Full erasure of a student is not automated (withdrawal keeps the record) | Define the request procedure and build an export and an erasure workflow once retention rules are decided | HIGH |
| 6 | Retention | No retention periods or automatic deletion | Lawyer and schools to set periods (academic records, payroll, audit logs, sessions). Sessions expire; audit logs are kept indefinitely | HIGH |
| 7 | Security safeguards | Tenant isolation tested; hashing; sessions; headers (see `SECURITY.md`) | Open items there: backups, MFA, key management, file storage | HIGH |
| 8 | Breach handling | None written. Logs have request ids, user and school ids | Write an incident procedure: who is told (the school, the Board, affected people), within what time; test it | HIGH |
| 9 | Processors and transfers | MongoDB Atlas (database), a hosting provider (not chosen). No payment gateway, SMS or email service | Name them and their regions in the policy; sign data-processing terms; confirm any cross-border position | HIGH |
| 10 | Grievance and officer | None | Name a grievance officer and publish contact details (placeholders in the policy). Check whether the company needs a Data Protection Officer (depends on being a Significant Data Fiduciary) | HIGH |
| 11 | Cookies and storage | No cookies. Browser storage: sign-in token (session), theme, menu state, student wallpaper | No banner is shown on the basis that all of it is strictly necessary or a user-chosen preference; the lawyer must confirm. If analytics is added, add consent first | MEDIUM |
| 12 | Location | Staff check-in may record latitude/longitude, only when a school enables the fence, only at the moment of check-in | Tell staff (the policy says so); schools must have a lawful basis for it | MEDIUM |
| 13 | Platform operator access | Platform Admin can act inside a school; writes are audited, **reads are not** | Add read auditing or a time-boxed "support access" approval | MEDIUM |

## Not done (needs decisions or approval)

* No consent register, data-export, or erasure feature (items 2, 5).
* No retention or deletion schedule (item 6).
* No breach procedure (item 8).
* The policy pages are drafts with placeholders; none may be published as they stand.
