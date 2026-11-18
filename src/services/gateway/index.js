import { config } from '../../core/config.js';
import { mockGateway } from './mock.js';
import { razorpayGateway } from './razorpay.js';

/** The payment gateway in use, or null when online payment is switched off. Read each time so a test can change it. */
export function gateway() {
  switch (config.payments.provider) {
    case 'mock': return mockGateway;
    case 'razorpay': return razorpayGateway;
    default: return null;
  }
}
export { mockGateway };
