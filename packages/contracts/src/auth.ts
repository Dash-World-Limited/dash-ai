import { z } from "zod";
import { Id, IsoDateTime, LIMITS } from "./common.js";

export const Email = z.email().max(254);

export const Password = z.string().min(LIMITS.minPasswordChars).max(LIMITS.maxPasswordChars);

export const RegisterRequest = z.object({
  email: Email,
  password: Password,
  displayName: z.string().trim().min(1).max(LIMITS.maxDisplayNameChars),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1).max(LIMITS.maxPasswordChars),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const User = z.object({
  id: Id,
  email: Email,
  displayName: z.string(),
  createdAt: IsoDateTime,
});
export type User = z.infer<typeof User>;

export const AuthResponse = z.object({
  token: z.string().min(20),
  expiresAt: IsoDateTime,
  user: User,
});
export type AuthResponse = z.infer<typeof AuthResponse>;
