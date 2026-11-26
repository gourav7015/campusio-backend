import { User, StaffMember, School } from '../models/index.js';
import { config } from '../core/config.js';
import { sendNotificationEmail } from './email.js';
import { maskEmail } from './contact.js';

const DESK = { finance: 'Finance desk', library: 'Library desk', transport: 'Transport desk', staff: 'Office desk' };

/**
 * Email the person who holds a desk (or a Staff portal login) its login id and temporary password, whenever that password is made or changed.
 * It goes to the address on the employee's own record. The password is only a starting one (the person must choose their own at first sign-in).
 * Returns what to tell the School Admin: `{ emailedTo }` (masked) when it was queued, or `{ emailNote }` = 'no_address' (nobody to write to) or 'mail_off' (email is not set up on the server).
 */
export async function mailLoginDetails({ tenantId, loginId, temporaryPassword, why = 'created' }) {
  const user = await User.findOne({ tenantId, loginId }).select('name role').lean();
  if (!user) return { emailNote: 'no_address' };
  const person = await StaffMember.findOne({ tenantId, userId: user._id }).select('name email').lean();
  const to = person?.email;
  if (!to) return { emailNote: 'no_address' };
  const school = await School.findById(tenantId).select('name').lean();
  const desk = DESK[user.role] || 'sign-in';
  const url = `${config.appUrl}/${user.role}/login`;
  const sent = sendNotificationEmail(to, {
    subject: `${why === 'reset' ? 'New password for' : 'Your'} ${school?.name || 'school'} ${desk} login`,
    heading: why === 'reset' ? `Your ${desk} password was reset` : `Your ${desk} login is ready`,
    lines: [
      `Hello ${person.name || user.name},`,
      `${why === 'reset' ? 'The School Admin has reset' : 'The School Admin has set up'} the ${desk} sign-in for ${school?.name || 'your school'}, and you are the person it is assigned to.`,
      `Login id: ${loginId}\nTemporary password: ${temporaryPassword}`,
      'This is a starting password. You will be asked to choose your own when you first sign in. Keep this email private and delete it once you have signed in.',
    ],
    button: { label: 'Sign in', url },
    footer: 'If you were not expecting this, tell the school office. Nobody else needs this password.',
    urgent: true,
  });
  return sent ? { emailedTo: maskEmail(to) } : { emailNote: 'mail_off' };
}
