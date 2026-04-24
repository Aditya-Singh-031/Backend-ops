const { ZodError } = require("zod");
const { sendError } = require("../utils/response");

/**
 * Zod validation middleware factory.
 * @param {import("zod").ZodSchema} schema
 * @param {"body"|"query"|"params"} source - which part of req to validate
 */
function validate(schema, source = "body") {
  return (req, res, next) => {
    try {
      req[source] = schema.parse(req[source]);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const messages = err.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
        return sendError(res, messages.join(", "), 400);
      }
      next(err);
    }
  };
}


module.exports = { validate };
