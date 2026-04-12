const { z } = require("zod");

const createUserSchema = z.object({
  name: z.string().optional().default(""),
  email: z.string().email("Invalid email"),
  username: z.string().optional(),
  role: z.enum(["admin", "user", "viewer"]).optional().default("user"),
  status: z.enum(["active", "inactive"]).optional().default("active"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

const updateUserSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  username: z.string().optional(),
  role: z.enum(["admin", "user", "viewer"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  password: z.string().min(6).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

module.exports = { createUserSchema, updateUserSchema };
