import { z } from "zod";
import { Id, IsoDateTime, LIMITS } from "./common.js";

export const Email = z.email().max(254);

export const Password = z.string().min(LIMITS.minPasswordChars).max(LIMITS.maxPasswordChars);

export const RegisterRequest = z.object({
  email: Email,
  password: Password,
  // Control characters (NUL in particular, which PostgreSQL text cannot store) are rejected up front.
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(LIMITS.maxDisplayNameChars)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Name must not contain control characters"),
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
