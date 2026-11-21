import jwt from 'jsonwebtoken';
import { config } from './config.js';

/** Checks a token against the current secret, then against the previous one (during a secret rotation, so nobody is signed out). */
export function verifyToken(token) {
  try { return jwt.verify(token, config.jwtSecret); } catch (e) {
    if (!config.jwtSecretPrevious) throw e;
    return jwt.verify(token, config.jwtSecretPrevious);
  }
}
