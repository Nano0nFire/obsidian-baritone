import bcrypt from 'bcryptjs';

const COST = 12;

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  return bcrypt.hash(password, COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof hash !== 'string' || hash.length === 0) return false;
  return bcrypt.compare(password, hash);
}

export function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Password must be at least 12 characters');
  if (password.length > 1024) throw new Error('Password is too long');
}
