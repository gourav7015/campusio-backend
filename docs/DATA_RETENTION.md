# Data retention schedule

What Campusio keeps, for how long, and what removes it. This is the technical schedule; the legal periods a school must follow (accounts, education records) are the school's to confirm with its own adviser.

| Data | Kept | Removed by |
|---|---|---|
| Student, guardian, teacher and staff records | While the person is with the school and afterwards, until the school erases a former student | School Admin: **Privacy → Erase a former student** (needs the admission number typed to confirm) |
| Fee charges, payments, receipts and payroll | Always (the school's accounts) | Never by the system. Erasure of a student keeps them, without the name |
| Attendance and marks | Always (the student's academic record) | Kept without personal details after erasure |
| Guardian consent record | While the student is active | Cleared on erasure, or by the School Admin |
| Uploaded files (photos, documents) | Until the owner or the school removes them | Deleted with the student on erasure |
| In-app notifications | Read: 180 days. Unread: 365 days | Daily job (`services/retention.js`) |
| Outgoing email records | 14 days after sending or failing | Daily job, and the outbox's own expiry |
| Ended sessions (device and address of a sign-in) | 30 days after they end | Daily job |
| Password-reset links | 30 minutes to use, removed after 24 hours | Database expiry |
| Error log (server and browser crashes) | 30 days | Database expiry |
| Idempotency records | 24 hours | Database expiry |
| Audit log | Kept (it is the record of who did what) | Not removed automatically |
| Backups | The school's copies are the Platform Admin's to rotate. Suggested: daily for 14 days, weekly for 3 months | By whoever holds the backup folder. A backup still holds erased people until it is rotated out |

A request from a family to see or delete their child's data goes to the School Admin, who can download everything held about the student (**Privacy → Download data**) and, for a former student, erase their personal details. Backups are not rewritten; they expire on the schedule above.
