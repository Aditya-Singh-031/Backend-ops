const { z } = require("zod");

const loginSchema = z.object({
  email: z.string().min(1, "Email is required"),
  password: z.string().min(1, "Password is required"),
});

module.exports = { loginSchema };
